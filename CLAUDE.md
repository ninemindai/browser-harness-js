# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

Browser Harness (JS) — a deliberately tiny harness (~915 lines, one dep: `ws`) that gives an LLM agent direct CDP control of the user's real Chrome. It is an **unofficial JavaScript port** of [browser-use/browser-harness](https://github.com/browser-use/browser-harness) (Python). Changes here should stay line-for-line faithful to the upstream design; don't add features that exist only on the JS side.

**This repo is both a library and an agent runtime.** Humans edit the daemon/runtime (`daemon.js`, `admin.js`, `run.js`). Agents are expected to edit `helpers.js` mid-task to add missing browser primitives — that is a feature, not a bug.

## Commands

There is no test runner and no linter. Verification is behavioral — run the harness against Chrome.

```bash
npm install                   # install the single dep (ws)
npm install -g .              # symlink `browser-harness` onto $PATH (points at this checkout)

# Normal usage — stdin is wrapped in an async IIFE, helpers + admin exports are pre-injected as globals
browser-harness <<'JS'
await new_tab("https://example.com");
await wait_for_load();
console.log(await page_info());
JS

# Manual daemon (ensure_daemon() in run.js auto-spawns this; only run directly for debugging)
npm run daemon
node daemon.js                # same thing

# Restart a stuck daemon
browser-harness <<'JS'
await restart_daemon();
JS
```

Requires Node.js **>=20.11** (uses `import.meta.dirname`; `is_main()` in `daemon.js` falls back for runtimes without `import.meta.main`).

### Debugging

- Daemon logs: `/tmp/bu-<BU_NAME>.log` (tail this when `browser-harness` hangs or errors).
- Socket: `/tmp/bu-<BU_NAME>.sock` — if stale, `restart_daemon()` clears it.
- `BU_NAME` (default `default`) namespaces socket, pid, log, and helpers-hash files. Parallel agents must use distinct `BU_NAME`s.

## Architecture

```
Chrome / Browser Use cloud  ──CDP WebSocket──▶  daemon.js  ──/tmp/bu-<NAME>.sock──▶  run.js (stdin JS)
                                                  │
                                            helpers.js (pre-injected globals)
                                            admin.js   (pre-injected globals)
```

- **`run.js`** (~55 lines): reads JS from stdin, wraps it in `(async () => { ... })()`, and runs it in a `vm` context with every export from `helpers.js` + `admin.js` as globals, plus `console`, `process`, `Buffer`, `fetch`, `require`, timers. Calls `ensure_daemon()` before evaluating. No argparse, no subcommands — keep it tiny.
- **`helpers.js`** (~284 lines): browser primitives the agent calls (`goto`, `click`, `type_text`, `press_key`, `screenshot`, `new_tab`, `js`, `cdp`, `upload_file`, `http_get`, …). **Agents edit this file in place to add capabilities.** Every helper is `async` — callers must `await`.
- **`admin.js`**: daemon lifecycle (`ensure_daemon`, `restart_daemon`) and Browser Use cloud integration (`start_remote_daemon`, `list_cloud_profiles`, `list_local_profiles`, `sync_local_profile`).
- **`daemon.js`**: holds the CDP WebSocket, relays a one-JSON-line-each-way protocol over a Unix socket. One daemon per `BU_NAME`. Auto-reattaches to a fresh page when the default session goes stale. Logs `helpers.js` SHA256 changes as an audit trail.

### Wire protocol (daemon <-> run.js)

One JSON object per line on the Unix socket. Requests: `{method, params, session_id}` for raw CDP, or `{meta: 'drain_events'|'session'|'set_session'|'pending_dialog'|'shutdown'}` for daemon control. Responses: `{result}` / `{error}` / `{events}` / `{session_id}`. `cdp(method, params)` in `helpers.js` is the thin wrapper; `params.session_id` is stripped and sent as the top-level field.

### Env vars

- `BU_NAME` — daemon namespace (default `default`).
- `BU_CDP_WS` — override Chrome auto-discovery; **validated** against an allowlist (`ws://127.0.0.1`, `wss://*.browser-use.com`, or hosts in `BU_CDP_WS_ALLOW_HOSTS`). See `_validate_cdp_ws` in `daemon.js`.
- `BU_ALLOWED_PATHS` — colon-separated filesystem allowlist for `upload_file` and `screenshot` (default `/tmp:$cwd`). Enforced by `_check_path` in `helpers.js`.
- `BU_BROWSER_ID` + `BROWSER_USE_API_KEY` — the daemon `PATCH`es the cloud browser to `stop` on clean shutdown so profile state persists.
- `.env` files in the repo root are loaded by `helpers.js`, `admin.js`, and `daemon.js` (each has its own `_load_env()`); existing env vars win.

### Chrome discovery

`get_ws_url()` in `daemon.js` scans `PROFILES` (Chrome + Edge variants across macOS/Linux/Windows) for `DevToolsActivePort`, probes the port with a 30s TCP loop, then reads the websocket path from the file. If `BU_CDP_WS` is set, discovery is skipped entirely.

## Design constraints (do not violate)

These are deliberate and are what makes the harness useful. Review `SKILL.md` § "Design constraints" before structural changes.

- **Coordinate clicks via `Input.dispatchMouseEvent` are the default.** They pass through iframes/shadow/cross-origin at the compositor level. Prefer them over DOM-level workarounds.
- **Attach to the user's running Chrome. Never launch a browser.** Daemon is a consumer, not a process manager.
- **Raw `ws` only.** No typed CDP wrappers (`puppeteer-core`, `chrome-remote-interface`, etc.). Prefer raw `cdp('Domain.method', {...})` strings in helpers.
- **`run.js` stays minimal.** No argparse, no subcommands, no control layer.
- **Helpers are short and positional.** Python upstream uses keyword args; in JS the translation is an options object for what was keyword-only — keep positional args in the same order as Python (see `SKILL.md` § "Calling convention").
- **No manager layer.** No retry framework, session manager, daemon supervisor, config system, or logging framework. The single `_send` → `cdp` path is all there should be.
- **Keep parity with upstream Python.** This is a port. When upstream changes, port the change here; don't invent a divergent API.

## Security constraints (easy to break accidentally)

The harness is **not a sandbox**. Stdin runs with full Node privileges; the daemon has full CDP on whatever Chrome it attaches to (cookies, sessions, SSO). Full threat model in `SECURITY.md`.

- `upload_file` and `screenshot` **must** go through `_check_path` (`helpers.js`). New helpers that accept paths must also use it.
- `BU_CDP_WS` **must** go through `_validate_cdp_ws` (`daemon.js`). Don't add transport shortcuts that bypass it.
- The daemon hashes `helpers.js` on every start and logs diffs to `/tmp/bu-<NAME>.log`. Treat `helpers.js` edits as a trust boundary — agents should only add helpers they'd be comfortable running unattended on every future invocation.
- `_claim_sock_path` in `daemon.js` refuses to unlink non-socket files or sockets owned by another uid. Don't "simplify" that check away.

## Skills layout (agent knowledge base)

Two directories shipped alongside the code — updated by agents, not humans:

- **`interaction-skills/`** — reusable UI mechanics (`dialogs.md`, `dropdowns.md`, `iframes.md`, `shadow-dom.md`, `uploads.md`, `profile-sync.md`, `connection.md`, …). Covers patterns that recur across sites.
- **`domain-skills/<host>/`** — site-specific notes (GitHub, LinkedIn, Amazon, …). `goto(url)` in `helpers.js` auto-lists matching `.md` files for the host's domain key — this is wired directly into the return value of navigation, so the path resolution is security-sensitive (must stay under `domain-skills/`, see `_rglob_md` guard).

When shipping a site-specific learning, add it under `domain-skills/<host>/` — captures URL patterns, private APIs, stable selectors, framework quirks, waits, and traps. Do **not** write raw pixel coordinates, run narration, or secrets (see `SKILL.md` § "Always contribute back").

## Runtime docs for agents

The agent-facing docs live at the repo root and are the authoritative runtime contract:

- `SKILL.md` — day-to-day usage, calling conventions, remote browsers, gotchas, tool-call shape. Read this fully before writing agent-driven code against the harness.
- `install.md` — first-time install and Chrome bootstrap flow.
- `helpers.js` — always read this; it's the API surface and it's short.

When editing `helpers.js`, keep functions small, keep comments terse, and match the existing Python-parity shape (same names, same positional argument order).
