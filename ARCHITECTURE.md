# Architecture

The harness is a thin bridge between an LLM agent's stdout and a real Chrome's CDP socket, with a small daemon holding the WebSocket so stdin can be cheap.

For the richly styled standalone view, open [`architecture.html`](architecture.html). This doc is the GitHub-viewable summary and is kept in sync with the code.

## The 30-second model

- An LLM agent emits JS on stdin.
- `run.js` wraps it in an async IIFE and runs it in a `vm` context with every export from `helpers.js` + `admin.js` pre-injected as globals.
- Helpers send one JSON-per-line over a Unix socket at `/tmp/bu-<BU_NAME>.sock` to a long-running `daemon.js`.
- The daemon holds a single CDP WebSocket — to the user's Chrome (auto-discovered via `DevToolsActivePort`) or, optionally, to a Browser Use cloud browser (`BU_CDP_WS` override, validated against an allowlist).
- Before forwarding, the daemon intercepts a small set of CDP methods and enforces a filesystem allowlist (`BU_ALLOWED_PATHS`).

## Components and data flow

```mermaid
flowchart LR
  Agent["LLM Agent<br/>(Claude Code / Codex)"]

  subgraph Runtime["Agent Runtime — run.js vm context"]
    direction TB
    Run["<b>run.js</b><br/>reads stdin → vm.createContext<br/>top-level await wrapper"]
    Helpers["<b>helpers.js</b><br/>cdp · goto · click · screenshot<br/>js · upload_file · http_get<br/><i>agent edits this file</i>"]
    Admin["<b>admin.js</b><br/>ensure_daemon · restart_daemon<br/>start_remote_daemon<br/>profile sync"]
  end

  subgraph DaemonBox["Daemon — one per BU_NAME"]
    direction TB
    Sock["Unix Socket Server<br/>/tmp/bu-NAME.sock · 0600<br/>JSON + newline framing"]
    Gate{{"Daemon.handle<br/><b>CDP method gate</b>"}}
    CDP["CDPClient · ws<br/>send_raw method params sid<br/>256MB payload · no deflate"]
    Events["Event Buffer<br/>last 500 events<br/>+ pending dialog state"]
    Sess["Session Manager<br/>attach first real page<br/>re-attach on stale"]
  end

  subgraph Sidecars["/tmp/bu-NAME.* · O_NOFOLLOW on every write"]
    direction LR
    Log[".log"]
    Pid[".pid"]
    Hash[".helpers-sha256"]
    RState[".remote.json"]
  end

  subgraph ChromeLocal["Local Chrome / Edge"]
    direction TB
    DTAP["DevToolsActivePort<br/>auto-discovery across<br/>Chrome · Canary · Edge Dev"]
    Tab["first non-internal page<br/>Page · DOM · Runtime · Network<br/>🟢 tab-title marker"]
  end

  Cloud["Browser Use cloud browser<br/>optional · BU_CDP_WS override<br/>wss cdpUrl · profile · proxy · liveUrl"]

  Agent -- "stdin JS" --> Run
  Run --> Helpers
  Run --> Admin
  Helpers -- "cdp · drain_events<br/>session control" --> Sock
  Admin -- "spawn detached<br/>PATCH /browsers/id" --> DaemonBox
  Sock --> Gate
  Gate --> CDP
  Gate --> Events
  Gate --> Sess
  CDP == "ws 127.0.0.1:port<br/>validated host" ==> ChromeLocal
  CDP -. "wss *.browser-use.com<br/>allowlisted" .-> Cloud
  DaemonBox --- Sidecars

  classDef agent stroke:#94a3b8,fill:#0f172a,color:#e2e8f0
  classDef green stroke:#34d399,fill:#064e3b,color:#d1fae5
  classDef cyan  stroke:#22d3ee,fill:#083344,color:#cffafe
  classDef rose  stroke:#fb7185,fill:#4c0519,color:#ffe4e6
  classDef violet stroke:#a78bfa,fill:#2e1065,color:#ede9fe
  classDef gray stroke:#475569,fill:#1e293b,color:#cbd5e1
  class Agent agent
  class Run,Helpers,Admin green
  class Sock,CDP cyan
  class Gate rose
  class Events,Sess violet
  class Log,Pid,Hash,RState,DTAP,Tab,Cloud gray
```

## Security gates (request trace)

The harness is **not** a sandbox — it runs with full Node privileges. What it *does* enforce is that three specific data paths (filesystem reads, filesystem writes, network egress) pass through a small number of gates before reaching the browser or the OS. The daemon is the trusted layer; `helpers.js` checks are defence-in-depth because the agent can rewrite `helpers.js`.

```mermaid
sequenceDiagram
  autonumber
  participant A as Agent stdin JS
  participant H as helpers.js (agent-editable)
  participant D as daemon.js (trusted)
  participant C as Chrome CDP

  Note over A,H: upload_file for a symlinked path
  A->>H: upload_file selector, path
  H->>H: _check_path · realpath + allowlist
  H->>D: DOM.setFileInputFiles with resolved path
  D->>D: _check_path · strict, survives helpers rewrite
  D->>C: CDP forward
  C-->>D: ok

  Note over A,D: raw cdp call that writes to disk
  A->>D: cdp Browser.setDownloadBehavior, downloadPath
  D->>D: gate downloadPath through _check_path
  alt path outside BU_ALLOWED_PATHS
    D-->>A: error · path outside allowlist
  else path allowed
    D->>C: CDP forward
  end

  Note over A,H: http_get for cloud metadata
  A->>H: http_get url
  H->>H: _check_http_host · IMDS, metadata, 169.254/16
  alt host in BU_HTTP_GET_DENY
    H-->>A: throws
  else allowed
    H->>H: fetch
  end
```

## Wire protocol

One JSON object per line on `/tmp/bu-<NAME>.sock`.

- **Requests** — `{method, params, session_id}` for raw CDP, or `{meta: 'drain_events' | 'session' | 'set_session' | 'pending_dialog' | 'shutdown'}` for daemon control.
- **Responses** — `{result}` / `{error}` / `{events}` / `{session_id}` / `{dialog}`.
- `params.session_id`, if present on the client side, is stripped by `cdp()` and sent as the top-level `session_id` field.
- `Target.*` calls bypass session routing and go to the browser context.

## BU_NAME namespacing

Every `/tmp/bu-*` file is keyed on `BU_NAME` (default `"default"`). Parallel agents MUST use distinct names to avoid fighting over the same daemon, socket, and Chrome attachment. `BU_NAME=work` and `BU_NAME=personal` yield two fully independent daemons with their own event buffers, sessions, logs, and — if configured — their own cloud browsers.

## Key environment variables

| Var | Default | Role |
|---|---|---|
| `BU_NAME` | `default` | Namespaces all sidecar files; picks which daemon to talk to |
| `BU_CDP_WS` | (auto-discover Chrome) | Override target WebSocket; validated against `ws://127.0.0.1`, `wss://*.browser-use.com`, or `BU_CDP_WS_ALLOW_HOSTS` |
| `BU_ALLOWED_PATHS` | `/tmp:$cwd` | Colon-separated filesystem allowlist for `upload_file`, `screenshot`, and daemon-gated CDP download paths. Pinned at daemon spawn time |
| `BU_HTTP_GET_DENY` | `169.254.169.254,metadata.google.internal,metadata` | Hostname deny list for `http_get`; also auto-blocks `169.254.0.0/16` |
| `BU_BROWSER_ID` + `BROWSER_USE_API_KEY` | (none) | Lets the daemon `PATCH` the cloud browser to `stop` on clean shutdown |

## What the diagram doesn't show

- **Self-healing.** When a helper is missing, the agent edits `helpers.js` mid-task and the next invocation picks it up via the global `npm install -g .` symlink — no reinstall. The daemon hashes `helpers.js` and logs SHA diffs to `/tmp/bu-<NAME>.log` as an audit trail (`_audit_helpers`).
- **Domain / interaction skills.** `goto(url)` auto-lists `.md` files under `domain-skills/<host-key>/` in its return value so the next agent on the same site reads the learnings before retrying.
- **Cold-start flow.** First attach may require a user to tick the remote-debugging checkbox in `chrome://inspect/#remote-debugging`; subsequent launches are automatic because the setting is per-profile-sticky. Full cold-start decision tree in [`install.md`](install.md).

For the deeper "why" behind each constraint — raw `ws` only, no manager layer, Python-parity preserved — see [`CLAUDE.md`](CLAUDE.md) § "Design constraints".
