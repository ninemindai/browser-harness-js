# Security Proposal — browser-harness (JS)

> **Status:** Proposal. Nothing here is implemented yet. Reviewer: add comments, argue, or PR the pieces you agree with.
> **Scope:** the JavaScript port under `js/`. The Python harness has its own threat model; this document doesn't speak for it.

## 1. Context

This harness exists to give an LLM agent the thinnest possible path to a real browser. By design:

- The agent writes JS snippets that run with **full Node privileges** (`fs`, `child_process`, network, dynamic `import()`).
- The daemon holds a **CDP WebSocket** to a real Chrome — often the user's *actual* Chrome profile with all of their logged-in sessions.
- The agent is expected to **edit `helpers.js` mid-task** to add missing capabilities.

The design is the value: there is no framework, no sandbox, no rails. The cost is that every attack surface the agent touches — primarily page content — is one prompt injection away from executing attacker-chosen code with full user privileges.

This proposal is not about retrofitting a sandbox. It's about closing **the specific, easy wins** that buy meaningful risk reduction without fighting the thin-harness ethos.

## 2. Threat model

| Adversary | In scope | Out of scope |
|---|---|---|
| Hostile web page content (prompt injection) | ✅ Primary threat | |
| Compromised `domain-skills` contributor | ✅ | |
| Misconfigured `BU_CDP_WS` pointing at attacker | ✅ | |
| Local user race against `/tmp/bu-*.sock` | ✅ (owner-only, but TOCTOU) | |
| Other local users on a shared machine | ⚠ Partial | Cross-user isolation is assumed from the OS |
| Network attacker on localhost CDP | | CDP has no auth; this is a Chrome design choice, not ours to fix |
| Rogue agent operator | | If you run the harness, it runs as you. Full stop. |
| Supply-chain attack on `ws` dep | | Covered by npm audit / lockfile pinning, not this doc |

**Trust boundaries, in one sentence:** the user and the agent operator are trusted; everything a page or third-party skill contributes is untrusted.

## 3. Proposed changes

Grouped by tier. Each entry: **What → Why (threat) → Sketch → Cost → Tradeoff.**

### Tier 0 — cheap wins, do first

#### 3.1 Path allowlist for `upload_file` and `screenshot`

- **Why:** A hijacked agent can call `upload_file(sel, '/Users/me/.ssh/id_ed25519')` or `screenshot('/etc/passwd')`. These are the two helpers that accept arbitrary filesystem paths today.
- **What:** Reject absolute paths that don't sit under an allowlist. Default allowlist: `/tmp`, the current working directory, and any prefix in `BU_ALLOWED_PATHS` (colon-separated).
- **Sketch** (helpers.js):
  ```js
  const ALLOWED = (process.env.BU_ALLOWED_PATHS || `/tmp:${process.cwd()}`).split(':');
  function _check_path(p) {
    const abs = path.resolve(p);
    if (!ALLOWED.some((pre) => abs === pre || abs.startsWith(pre + path.sep))) {
      throw new Error(`path outside BU_ALLOWED_PATHS: ${abs}`);
    }
    return abs;
  }
  ```
  Call `_check_path` inside `upload_file` and `screenshot`.
- **Cost:** ~15 lines. Zero friction if paths are already under `/tmp` or `cwd` (which our own examples use).
- **Tradeoff:** legitimate uploads from `~/Downloads` need `BU_ALLOWED_PATHS=~/Downloads`. Acceptable — users opt in.

#### 3.2 Validate `BU_CDP_WS` scheme/host

- **Why:** Today `BU_CDP_WS` is trusted blindly. A misconfigured or stolen env file with `BU_CDP_WS=wss://attacker.example` would have the daemon stream CDP (== page content + cookies) to the attacker.
- **What:** Require one of: (a) `ws://127.0.0.1:*` / `ws://localhost:*`, (b) `wss://*.browser-use.com`, or (c) any host explicitly listed in `BU_CDP_WS_ALLOW_HOSTS`.
- **Sketch** (daemon.js, `get_ws_url`):
  ```js
  function _validate_cdp_ws(u) {
    const url = new URL(u);
    const extra = (process.env.BU_CDP_WS_ALLOW_HOSTS || '').split(',').filter(Boolean);
    const ok = (url.protocol === 'ws:' && ['127.0.0.1', 'localhost'].includes(url.hostname))
            || (url.protocol === 'wss:' && url.hostname.endsWith('.browser-use.com'))
            || extra.includes(url.hostname);
    if (!ok) throw new Error(`BU_CDP_WS host not allowed: ${url.hostname}`);
    return u;
  }
  ```
- **Cost:** ~10 lines.
- **Tradeoff:** third-party self-hosted CDP gateways need `BU_CDP_WS_ALLOW_HOSTS`. Fine.

#### 3.3 Close the `domain-skills` path-traversal foothold

- **Why:** `goto(url)` builds a filesystem path from `new URL(url).hostname`. A URL like `https://..%2F..%2Fetc/` could (depending on URL parsing quirks) produce a key that escapes `domain-skills/`.
- **What:** After computing the key, verify the resolved path is still under `domain-skills/`.
- **Sketch** (helpers.js, `goto`):
  ```js
  const base = path.resolve(__dirname, 'domain-skills');
  const d = path.resolve(base, key);
  if (!d.startsWith(base + path.sep)) return r; // reject, just return navigation result
  ```
- **Cost:** ~3 lines.
- **Tradeoff:** none.

#### 3.4 Socket TOCTOU hardening

- **Why:** `daemon.js` does `fs.unlinkSync(SOCK)` then `server.listen(SOCK)`. Between those calls, a local process could create a symlink at `/tmp/bu-{NAME}.sock` pointing elsewhere. `chmod 0600` after `listen` is applied to whatever the kernel actually ended up bound to.
- **What:**
  1. Use `fs.lstatSync` before unlink — if the path exists and is not a socket owned by us, bail instead of unlinking.
  2. After `listen`, `lstat` again and confirm owner == `process.getuid()`.
- **Sketch:** ~8 lines in the `serve` bootstrap.
- **Cost:** ~8 lines.
- **Tradeoff:** Loud failure on shared `/tmp` edge cases. Good — that's the signal.

### Tier 1 — larger, opt-in

#### 3.5 Recommend a dedicated Chrome profile

- **Why:** The biggest risk multiplier is that the daemon attaches to the user's real profile — with their banking, email, and work sessions. Prompt injection on *any* page then sees *every* session cookie.
- **What:** `install.md` currently tells users to enable remote debugging on their normal profile. Change the recommended path to:
  1. Create a dedicated "harness" Chrome profile (`chrome --user-data-dir=~/bu-profile`).
  2. Only that profile has remote-debugging enabled.
  3. Sign into sites the agent legitimately needs — nothing else.
- **Cost:** docs change only, plus maybe a `scripts/launch-harness-profile.sh` helper.
- **Tradeoff:** Users lose "agent as me, with all my logins". That's the entire point — they should opt into each identity they hand to the agent. For users who genuinely want agent-as-me, keep the old flow as an explicitly-acknowledged option.
- **This is the single biggest real-world risk reduction on the list.** Everything else is defense in depth.

#### 3.6 `helpers.js` edit audit trail

- **Why:** The self-healing loop is load-bearing for the product but invisible to the user. A prompt-injected agent can add an `exfil_cookies()` function that then runs every time the agent is invoked.
- **What:** On every daemon startup, log the sha256 of `helpers.js` and diff against the previous run. Write to `/tmp/bu-{NAME}.log` (already exists) and optionally to stderr the first time it changes in a session.
- **Sketch** (daemon.js, at startup):
  ```js
  const HASH_PATH = `/tmp/bu-${NAME}.helpers-sha256`;
  const cur = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'helpers.js'))).digest('hex');
  const prev = fs.existsSync(HASH_PATH) ? fs.readFileSync(HASH_PATH, 'utf8').trim() : null;
  if (prev && prev !== cur) log(`helpers.js changed: ${prev.slice(0, 12)} → ${cur.slice(0, 12)}`);
  fs.writeFileSync(HASH_PATH, cur);
  ```
- **Cost:** ~15 lines. Zero agent-facing friction.
- **Tradeoff:** only an audit trail — doesn't block. That's intentional; gating edits defeats the self-healing feature.

#### 3.7 Remote browser cleanup on ungraceful exit

- **Why:** `stop_remote` runs in SIGINT/SIGTERM handlers only. SIGKILL, laptop sleep-to-death, or a Node crash leaks the cloud browser — it keeps running (and, on paid tiers, billing) until its server-side timeout.
- **What:** `start_remote_daemon` writes `{name, id, cdpUrl}` to `/tmp/bu-{NAME}.remote.json`. Every call to `start_remote_daemon` first scans stale files from dead daemons and best-effort PATCH-stops them.
- **Sketch:** ~25 lines in admin.js. Use `daemon_alive(name)` to tell "stale" from "live".
- **Cost:** modest.
- **Tradeoff:** best-effort — if the machine never runs the harness again, the browser still burns its timeout. That's a Browser Use server-side problem, not one we can solve locally.

### Tier 2 — advisory / doc-only

#### 3.8 `SKILL.md` security section

- **Why:** Right now the docs don't describe the trust model at all. Users should know what they're handing the agent.
- **What:** 10-line section titled "What the agent can do to your machine" covering:
  - VM is not a sandbox
  - Real profile = real cookies
  - `BROWSER_USE_API_KEY` in `.env` is plaintext
  - Recommend dedicated profile (links to §3.5)
- **Cost:** docs.

#### 3.9 Optional "lockdown" flag

- **Why:** Some tasks genuinely don't need `child_process` or filesystem writes. Giving users a way to drop those drops the blast radius if prompt injection hits.
- **What:** `BU_LOCKDOWN=1` → `run.js` strips `require`, `import`, `fs`, `child_process` from the vm context.
- **Cost:** ~10 lines in run.js; the harder cost is explaining when to use it.
- **Tradeoff:** Most domain skills assume those globals. Adoption likely low. Ship only if there's demand.

#### 3.10 Repo checkout is a trust boundary

- **Why:** Three modules (`helpers.js`, `admin.js`, `daemon.js`) each call their own `_load_env()` on import, reading `.env` from the module's directory with no integrity check. Anyone with write access to the repo therefore controls `BROWSER_USE_API_KEY`, `BU_CDP_WS_ALLOW_HOSTS`, `BU_ALLOWED_PATHS`, and `BU_HTTP_GET_DENY`. `helpers.js` itself also executes, so write access was already equivalent to code execution — but the env-var path is quieter and worth calling out.
- **What:** Doc-only. State in `install.md` and `SKILL.md` that the repo checkout must live in a location only the operator can write (not a shared `/opt/...`, not a world-writable `/tmp/...`). Recommend a per-user path like `~/Developer/browser-harness`.
- **Cost:** A paragraph.
- **Tradeoff:** None — we're just naming a pre-existing invariant so operators don't trip over it.

#### 3.11 CDP filesystem-write methods bypass `upload_file`'s gate

- **Why:** `_check_path` lives in `helpers.js`. An agent that rewrites `helpers.js` or calls `cdp('DOM.setFileInputFiles', …)` / `cdp('Browser.setDownloadBehavior', …)` directly sidesteps the guard. `DOM.setFileInputFiles` leaks any file your uid can read; `Browser.setDownloadBehavior` lets a downloaded response land in `~/.ssh/authorized_keys`.
- **What:** Mirror `_check_path` into `daemon.js` and intercept `DOM.setFileInputFiles`, `Browser.setDownloadBehavior`, `Page.setDownloadBehavior` in `Daemon.handle`. The daemon is the trusted layer; the helpers check is now advisory.
- **Cost:** ~25 lines. Duplication of the allowlist logic is deliberate — `helpers.js` is agent-editable by design, the daemon is not.
- **Tradeoff:** Daemon uses a strict `realpathSync` (file must exist); screenshots don't go through daemon paths, so they keep the lenient parent-realpath fallback in `helpers.js`.

#### 3.12 Symlink escape in `_check_path`

- **Why:** `path.resolve(p)` is a string operation — it doesn't follow symlinks. A symlink planted under an allowed prefix (e.g. `/tmp/link → ~/.ssh/id_ed25519`) passes the prefix check, and `upload_file` happily uploads the real target.
- **What:** `_check_path` now calls `fs.realpathSync` on the input *and* on each allowlist entry. For not-yet-existent destinations (screenshot output), realpath the closest existing ancestor and rejoin. As a side effect this also fixes a latent macOS bug where the literal `/tmp` prefix never matched canonicalised paths (`/tmp` is a symlink to `/private/tmp`).
- **Cost:** ~20 lines.
- **Tradeoff:** TOCTOU between check and write is not addressed. Acceptable for the stated threat (agent-initiated escape); a same-machine attacker racing file replacement is a separate threat.

#### 3.13 `/tmp/bu-*` sidecar files follow symlinks

- **Why:** `_claim_sock_path` defends only the socket. `LOG`, `PID`, `HELPERS_HASH_FILE`, and `/tmp/bu-<NAME>.remote.json` all use `fs.writeFileSync` / `readFileSync`, which follow symlinks. On a shared host, another local user can pre-plant `/tmp/bu-default.log → ~/.bashrc` before the daemon starts and the daemon clobbers it; a pre-planted read target leaks its contents into `_log_tail`'s error surface.
- **What:** Open every `/tmp/bu-*` sidecar with `O_NOFOLLOW` via small `_read_nofollow` / `_write_nofollow` helpers in `daemon.js` and `admin.js`. `O_NOFOLLOW` is `0` on Windows, so the change is a no-op there (acceptable — the cross-tenant symlink threat is Unix-specific).
- **Cost:** ~40 lines, duplicated across the two trusted modules.
- **Tradeoff:** If an attacker plants a symlink before daemon start, the daemon now fails to start rather than silently clobbering the target. That's a DoS in exchange for integrity — worth it.

#### 3.14 `profile-use` argument smuggling

- **Why:** `spawnSync('profile-use', ['sync', '--profile', profileName, …])` passes user-controlled values positionally. `spawnSync` with an array blocks shell injection, but a `profileName` of `--some-other-flag` is passed through to `profile-use` and re-interpreted by its CLI parser.
- **What:** Reject any user-controlled value that starts with `-` before building the argv. Validates `profileName`, `browser`, `cloudProfileId`, and each entry in `includeDomains` / `excludeDomains`.
- **Cost:** ~10 lines.
- **Tradeoff:** Profile names containing leading hyphens are now rejected. No legitimate profile name starts with `-`.

#### 3.15 `http_get` SSRF default-deny for cloud metadata

- **Why:** `http_get` forwarded any URL to `fetch` unchecked. A prompt-injected agent could hit AWS IMDS (`169.254.169.254`), GCP metadata (`metadata.google.internal`), or any IPv4 link-local address to exfiltrate instance credentials.
- **What:** Block those hosts (and the entire `169.254.0.0/16` link-local range by hostname regex) by default. Override via `BU_HTTP_GET_DENY` (comma-separated host list; set empty to disable).
- **Cost:** ~15 lines.
- **Tradeoff:** Does not defend against DNS rebinding (`evil.example.com` → `169.254.169.254`) — hostname-only check. Also does not block loopback (`127.0.0.1`) or RFC1918 ranges; those have too many legitimate local-dev uses to block by default.

## 4. Non-goals (and why)

We deliberately do **not** propose:

- **Sandboxing the vm context.** Node's `vm` module is explicitly not a security boundary. Pretending otherwise creates a false sense of safety that's worse than the current honest posture.
- **Authentication on the Unix socket.** The socket is chmod 0600 — cross-user isolation is the OS's job. Adding a shared secret doesn't help against a same-user attacker (they can read the secret).
- **Adding auth to CDP.** Chrome doesn't support it. Out of our hands.
- **Blocking the agent from editing `helpers.js`.** That's the feature. Audit (§3.6), don't gate.
- **Wrapping everything in a permissions framework.** Too much ceremony for a 600-line project. Every helper would acquire a capability argument; that's a different project.

## 5. Rollout plan

1. **Tier 0** (§3.1–3.4): one PR. ~50 lines across `helpers.js` + `daemon.js`. Low-risk, mechanical.
2. **§3.5** (dedicated profile): docs PR + optional `scripts/launch-harness-profile.{sh,ps1}`.
3. **§3.6** (audit trail): one PR. Trivial.
4. **§3.7** (remote cleanup): one PR. Medium.
5. **§3.8** (docs) alongside §3.5.
6. **§3.9** (lockdown): only if a real user asks for it.

Tier 0 + §3.5 would close the big gaps with ~100 lines of code and one docs rewrite. That's the minimum viable bar.

## 6. Open questions

- **How aggressive should `_check_path` be?** Reject symlinks too, or just check the resolved absolute path? (Current proposal: check post-resolve.)
- **Is `.browser-use.com` the right default allowlist for `BU_CDP_WS`?** Should we pin to an explicit subdomain list?
- **Do we care about Windows paths** (drive letters, UNC)? The existing code is macOS/Linux-shaped; worth confirming before enforcing prefixes.
- **Should Tier 0 land as a single PR or four?** Single is easier to review as a coherent security pass; four is easier to revert if any one regresses behavior.
