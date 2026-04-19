import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const __dirname = import.meta.dirname;

function _load_env() {
  const p = path.join(__dirname, '.env');
  if (!fs.existsSync(p)) return;
  for (let line of fs.readFileSync(p, 'utf8').split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
}
_load_env();

const NAME = process.env.BU_NAME || 'default';
const BU_API = 'https://api.browser-use.com/api/v3';

function _paths(name) {
  const n = name || NAME;
  return [`/tmp/bu-${n}.sock`, `/tmp/bu-${n}.pid`];
}

function _log_tail(name) {
  const p = `/tmp/bu-${name || NAME}.log`;
  try {
    const lines = fs.readFileSync(p, 'utf8').trim().split('\n');
    return lines[lines.length - 1] || null;
  } catch { return null; }
}

function daemon_alive(name) {
  return new Promise((resolve) => {
    const s = net.createConnection(_paths(name)[0]);
    s.setTimeout(1000);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    s.once('timeout', () => { s.destroy(); resolve(false); });
  });
}

// Idempotent. `env` is merged into the child process env.
async function ensure_daemon({ wait = 60.0, name, env } = {}) {
  if (await daemon_alive(name)) return;
  const e = { ...process.env, ...(name ? { BU_NAME: name } : {}), ...(env || {}) };
  const child = spawn(process.execPath, ['daemon.js'], {
    cwd: __dirname,
    env: e,
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
  const deadline = Date.now() + wait * 1000;
  while (Date.now() < deadline) {
    if (await daemon_alive(name)) return;
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const msg = _log_tail(name);
  throw new Error(msg || `daemon ${name || NAME} didn't come up -- check /tmp/bu-${name || NAME}.log`);
}

// Best-effort daemon restart for setup/debug flows.
async function restart_daemon(name) {
  const [sock, pidPath] = _paths(name);
  await new Promise((resolve) => {
    const s = net.createConnection(sock);
    s.setTimeout(5000);
    s.once('connect', () => { s.end('{"meta":"shutdown"}\n'); });
    s.on('data', () => {});
    s.on('end', resolve);
    s.on('error', () => resolve());
    s.on('timeout', () => { s.destroy(); resolve(); });
  });
  let pid = null;
  try { pid = parseInt(fs.readFileSync(pidPath, 'utf8'), 10); }
  catch {}
  if (pid) {
    let gone = false;
    for (let i = 0; i < 75; i++) {
      try { process.kill(pid, 0); }
      catch { gone = true; break; }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!gone) {
      try { process.kill(pid, 'SIGTERM'); } catch {}
    }
  }
  for (const f of [sock, pidPath]) {
    try { fs.unlinkSync(f); } catch {}
  }
}

async function _browser_use(p, method, body) {
  const key = process.env.BROWSER_USE_API_KEY;
  if (!key) throw new Error('BROWSER_USE_API_KEY missing -- see .env.example');
  const r = await fetch(BU_API + p, {
    method,
    headers: { 'X-Browser-Use-API-Key': key, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

async function _cdp_ws_from_url(cdp_url) {
  const r = await fetch(`${cdp_url}/json/version`, { signal: AbortSignal.timeout(15_000) });
  return (await r.json()).webSocketDebuggerUrl;
}

// True when this machine plausibly has a browser we can open. False on headless servers.
function _has_local_gui() {
  if (process.platform === 'darwin' || process.platform === 'win32') return true;
  if (process.platform === 'linux') return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  return false;
}

function _open_url(url) {
  if (process.platform === 'darwin') {
    spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
  } else if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
  } else {
    spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
  }
}

// Print liveUrl and auto-open it locally if there's a GUI.
function _show_live_url(url) {
  if (!url) return;
  console.log(url);
  if (!_has_local_gui()) {
    console.error('(no local GUI -- share the liveUrl with the user)');
    return;
  }
  try {
    _open_url(url);
    console.error('(opened liveUrl in your default browser)');
  } catch (e) {
    console.error(`(couldn't auto-open: ${e.message} -- share the liveUrl with the user)`);
  }
}

// List cloud profiles under the current API key.
//
// Returns [{id, name, userId, cookieDomains, lastUsedAt}, ...]. Paginates through
// all pages -- the API caps `pageSize` at 100.
async function list_cloud_profiles() {
  const out = [];
  let page = 1;
  while (true) {
    const listing = await _browser_use(`/profiles?pageSize=100&pageNumber=${page}`, 'GET');
    const items = listing && typeof listing === 'object' && 'items' in listing ? listing.items : listing;
    if (!items || !items.length) break;
    for (const p of items) {
      const detail = await _browser_use(`/profiles/${p.id}`, 'GET');
      out.push({
        id: detail.id,
        name: detail.name,
        userId: detail.userId,
        cookieDomains: detail.cookieDomains || [],
        lastUsedAt: detail.lastUsedAt,
      });
    }
    if (listing && typeof listing === 'object' && 'totalItems' in listing && out.length >= listing.totalItems) break;
    page += 1;
  }
  return out;
}

async function _resolve_profile_name(profileName) {
  const matches = (await list_cloud_profiles()).filter((p) => p.name === profileName);
  if (!matches.length) throw new Error(`no cloud profile named "${profileName}" -- call list_cloud_profiles() or sync_local_profile() first`);
  if (matches.length > 1) throw new Error(`${matches.length} cloud profiles named "${profileName}" -- pass profileId=<uuid> instead`);
  return matches[0].id;
}

// Persisted in /tmp so a crashed daemon's cloud browser can be reaped on the
// next start_remote_daemon call (SECURITY.md §3.7).
function _remote_state_path(name) {
  return `/tmp/bu-${name || NAME}.remote.json`;
}

async function _reap_stale_remotes() {
  let entries;
  try { entries = fs.readdirSync('/tmp'); } catch { return; }
  for (const f of entries) {
    const m = f.match(/^bu-(.+)\.remote\.json$/);
    if (!m) continue;
    const stateName = m[1];
    // If a daemon is still live for this name, let its shutdown hook handle cleanup.
    if (await daemon_alive(stateName)) continue;
    const p = `/tmp/${f}`;
    let state;
    try { state = JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch { try { fs.unlinkSync(p); } catch {} continue; }
    if (state && state.id) {
      try {
        await _browser_use(`/browsers/${state.id}`, 'PATCH', { action: 'stop' });
        console.error(`(reaped orphan remote browser ${state.id} from daemon "${stateName}")`);
      } catch (e) {
        console.error(`(reap ${state.id} failed: ${e.message})`);
      }
    }
    try { fs.unlinkSync(p); } catch {}
  }
}

// Provision a Browser Use cloud browser and start a daemon attached to it.
//
// opts forwarded to `POST /browsers` (camelCase):
//   profileId        -- cloud profile UUID; start already-logged-in. Default: none (clean browser).
//   profileName      -- cloud profile name; resolved client-side to profileId via list_cloud_profiles().
//   proxyCountryCode -- ISO2 country code (default "us"); pass null to disable the BU proxy.
//   timeout          -- minutes, 1..240.
//   customProxy      -- {host, port, username, password, ignoreCertErrors}.
//   browserScreenWidth / browserScreenHeight, allowResizing, enableRecording.
//
// Returns the full browser dict including `liveUrl`.
async function start_remote_daemon({ name = 'remote', profileName, ...createOpts } = {}) {
  await _reap_stale_remotes();
  if (await daemon_alive(name)) throw new Error(`daemon "${name}" already alive -- restart_daemon("${name}") first`);
  if (profileName) {
    if ('profileId' in createOpts) throw new Error('pass profileName OR profileId, not both');
    createOpts.profileId = await _resolve_profile_name(profileName);
  }
  const browser = await _browser_use('/browsers', 'POST', createOpts);
  try {
    fs.writeFileSync(
      _remote_state_path(name),
      JSON.stringify({ id: browser.id, name, createdAt: Date.now() }),
      { mode: 0o600 }
    );
  } catch {}
  await ensure_daemon({
    name,
    env: { BU_CDP_WS: await _cdp_ws_from_url(browser.cdpUrl), BU_BROWSER_ID: browser.id },
  });
  _show_live_url(browser.liveUrl);
  return browser;
}

// Detected local browser profiles on this machine. Shells out to `profile-use list --json`.
function list_local_profiles() {
  const r = spawnSync('profile-use', ['list', '--json'], { encoding: 'utf8' });
  if (r.error && r.error.code === 'ENOENT') {
    throw new Error('profile-use not installed -- curl -fsSL https://browser-use.com/profile.sh | sh');
  }
  if (r.status !== 0) throw new Error(`profile-use list failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

// Sync a local profile's cookies to a cloud profile. Returns the cloud UUID.
//
// Shells out to `profile-use sync` (v1.0.4+). Requires BROWSER_USE_API_KEY and the
// target local Chrome profile to be closed.
function sync_local_profile(profileName, { browser, cloudProfileId, includeDomains, excludeDomains } = {}) {
  if (!process.env.BROWSER_USE_API_KEY) throw new Error('BROWSER_USE_API_KEY missing');
  const cmd = ['sync', '--profile', profileName];
  if (browser) cmd.push('--browser', browser);
  if (cloudProfileId) cmd.push('--cloud-profile-id', cloudProfileId);
  for (const d of includeDomains || []) cmd.push('--domain', d);
  for (const d of excludeDomains || []) cmd.push('--exclude-domain', d);
  const r = spawnSync('profile-use', cmd, { encoding: 'utf8' });
  if (r.error && r.error.code === 'ENOENT') {
    throw new Error('profile-use not installed -- curl -fsSL https://browser-use.com/profile.sh | sh');
  }
  process.stdout.write(r.stdout || '');
  process.stderr.write(r.stderr || '');
  if (r.status !== 0) throw new Error(`profile-use sync failed (exit ${r.status})`);
  if (cloudProfileId) return cloudProfileId;
  const m = (r.stdout || '').match(/Profile created:\s+([0-9a-f-]{36})/);
  if (!m) throw new Error(`profile-use did not report a profile UUID (exit ${r.status})`);
  return m[1];
}

export {
  ensure_daemon,
  restart_daemon,
  daemon_alive,
  start_remote_daemon,
  list_cloud_profiles,
  list_local_profiles,
  sync_local_profile,
};
