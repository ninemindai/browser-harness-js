// CDP WS holder + Unix socket relay. One daemon per BU_NAME.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import WebSocket from 'ws';

const __dirname = import.meta.dirname;

// True when this module is the script Node was invoked with.
// Uses the native import.meta.main on Node 22.18+/24.2+; falls back to path
// comparison (handles both extensioned and extensionless argv[1]).
function is_main(meta) {
  if (meta.main !== undefined) return meta.main;
  const require = createRequire(meta.url);
  const scriptPath = require.resolve(process.argv[1]);
  const modulePath = fileURLToPath(meta.url);
  const ext = path.extname(scriptPath);
  return ext ? modulePath === scriptPath : modulePath.replace(/\.[^/.]+$/, '') === scriptPath;
}

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
const SOCK = `/tmp/bu-${NAME}.sock`;
const LOG = `/tmp/bu-${NAME}.log`;
const PID = `/tmp/bu-${NAME}.pid`;
const HELPERS_HASH_FILE = `/tmp/bu-${NAME}.helpers-sha256`;
const HELPERS_PATH = path.join(__dirname, 'helpers.js');
const BUF = 500;
const HOME = os.homedir();
const PROFILES = [
  path.join(HOME, 'Library/Application Support/Google/Chrome'),
  path.join(HOME, 'Library/Application Support/Microsoft Edge'),
  path.join(HOME, 'Library/Application Support/Microsoft Edge Beta'),
  path.join(HOME, 'Library/Application Support/Microsoft Edge Dev'),
  path.join(HOME, 'Library/Application Support/Microsoft Edge Canary'),
  path.join(HOME, '.config/google-chrome'),
  path.join(HOME, '.config/microsoft-edge'),
  path.join(HOME, '.config/microsoft-edge-beta'),
  path.join(HOME, '.config/microsoft-edge-dev'),
  path.join(HOME, 'AppData/Local/Google/Chrome/User Data'),
  path.join(HOME, 'AppData/Local/Microsoft/Edge/User Data'),
  path.join(HOME, 'AppData/Local/Microsoft/Edge Beta/User Data'),
  path.join(HOME, 'AppData/Local/Microsoft/Edge Dev/User Data'),
  path.join(HOME, 'AppData/Local/Microsoft/Edge SxS/User Data'),
];
const INTERNAL = ['chrome://', 'chrome-untrusted://', 'devtools://', 'chrome-extension://', 'about:'];
const BU_API = 'https://api.browser-use.com/api/v3';
const REMOTE_ID = process.env.BU_BROWSER_ID;
const API_KEY = process.env.BROWSER_USE_API_KEY;

function log(msg) {
  fs.appendFileSync(LOG, `${msg}\n`);
}

function _probe_tcp(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host, port });
    const done = (ok) => { try { s.destroy(); } catch {} resolve(ok); };
    s.setTimeout(timeoutMs);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

// Whitelist BU_CDP_WS destinations so a stolen/misconfigured env var can't
// redirect CDP traffic to an attacker (SECURITY.md §3.2).
function _validate_cdp_ws(u) {
  let url;
  try { url = new URL(u); } catch { throw new Error(`BU_CDP_WS is not a valid URL: ${u}`); }
  const extra = (process.env.BU_CDP_WS_ALLOW_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ok = (url.protocol === 'ws:' && ['127.0.0.1', '::1', 'localhost'].includes(url.hostname))
          || (url.protocol === 'wss:' && (url.hostname === 'browser-use.com' || url.hostname.endsWith('.browser-use.com')))
          || extra.includes(url.hostname);
  if (!ok) {
    throw new Error(
      `BU_CDP_WS host not allowed: ${url.hostname} (scheme=${url.protocol}) -- ` +
      `add it to BU_CDP_WS_ALLOW_HOSTS if you trust it`
    );
  }
  return u;
}

async function get_ws_url() {
  if (process.env.BU_CDP_WS) return _validate_cdp_ws(process.env.BU_CDP_WS);
  for (const base of PROFILES) {
    let content;
    try { content = fs.readFileSync(path.join(base, 'DevToolsActivePort'), 'utf8').trim(); }
    catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') continue;
      throw e;
    }
    const nl = content.indexOf('\n');
    const port = content.slice(0, nl).trim();
    const wsPath = content.slice(nl + 1).trim();
    const deadline = Date.now() + 30_000;
    while (true) {
      if (await _probe_tcp('127.0.0.1', parseInt(port, 10), 1000)) break;
      if (Date.now() >= deadline) {
        throw new Error(
          `Chrome's remote-debugging page is open, but DevTools is not live yet on 127.0.0.1:${port} -- if Chrome opened a profile picker, choose your normal profile first, then tick the checkbox and click Allow if shown`
        );
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    return `ws://127.0.0.1:${port}${wsPath}`;
  }
  throw new Error(`DevToolsActivePort not found in ${JSON.stringify(PROFILES)} -- enable chrome://inspect/#remote-debugging, or set BU_CDP_WS for a remote browser`);
}

async function stop_remote() {
  if (!REMOTE_ID || !API_KEY) return;
  try {
    await fetch(`${BU_API}/browsers/${REMOTE_ID}`, {
      method: 'PATCH',
      headers: { 'X-Browser-Use-API-Key': API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'stop' }),
      signal: AbortSignal.timeout(15_000),
    });
    log(`stopped remote browser ${REMOTE_ID}`);
  } catch (e) {
    log(`stop_remote failed (${REMOTE_ID}): ${e.message}`);
  }
}

const isRealPage = (t) => t.type === 'page' && !INTERNAL.some((p) => (t.url || '').startsWith(p));

class CDPClient extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.ws = null;
  }
  start() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
      this.ws.once('open', () => {
        this.ws.on('message', (data) => {
          let msg;
          try { msg = JSON.parse(data.toString()); } catch { return; }
          if (msg.id && this.pending.has(msg.id)) {
            const { resolve, reject } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            else resolve(msg.result || {});
          } else if (msg.method) {
            this.emit('event', msg.method, msg.params || {}, msg.sessionId || null);
          }
        });
        this.ws.on('close', () => {
          for (const { reject } of this.pending.values()) reject(new Error('CDP closed'));
          this.pending.clear();
        });
        resolve();
      });
      this.ws.once('error', reject);
    });
  }
  send_raw(method, params = {}, session_id = null) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (session_id) payload.sessionId = session_id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload), (err) => {
        if (err) { this.pending.delete(id); reject(err); }
      });
    });
  }
}

function withTimeout(promise, ms, tag) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${tag} timeout ${ms}ms`)), ms)),
  ]);
}

class Daemon {
  constructor() {
    this.cdp = null;
    this.session = null;
    this.events = [];
    this.dialog = null;
    this.stopResolve = null;
    this.stopped = new Promise((r) => { this.stopResolve = r; });
  }

  async attach_first_page() {
    const { targetInfos } = await this.cdp.send_raw('Target.getTargets');
    let pages = targetInfos.filter(isRealPage);
    if (!pages.length) {
      const { targetId } = await this.cdp.send_raw('Target.createTarget', { url: 'about:blank' });
      log(`no real pages found, created about:blank (${targetId})`);
      pages = [{ targetId, url: 'about:blank', type: 'page' }];
    }
    const { sessionId } = await this.cdp.send_raw('Target.attachToTarget', { targetId: pages[0].targetId, flatten: true });
    this.session = sessionId;
    log(`attached ${pages[0].targetId} (${(pages[0].url || '').slice(0, 80)}) session=${this.session}`);
    for (const d of ['Page', 'DOM', 'Runtime', 'Network']) {
      try { await withTimeout(this.cdp.send_raw(`${d}.enable`, {}, this.session), 5000, `enable ${d}`); }
      catch (e) { log(`enable ${d}: ${e.message}`); }
    }
    return pages[0];
  }

  async start() {
    const url = await get_ws_url();
    log(`connecting to ${url}`);
    this.cdp = new CDPClient(url);
    try { await this.cdp.start(); }
    catch (e) { throw new Error(`CDP WS handshake failed: ${e.message} -- click Allow in Chrome if prompted, then retry`); }
    await this.attach_first_page();
    const markJs = "if(!document.title.startsWith('\u{1F7E2}'))document.title='\u{1F7E2} '+document.title";
    this.cdp.on('event', async (method, params, session_id) => {
      this.events.push({ method, params, session_id });
      if (this.events.length > BUF) this.events.splice(0, this.events.length - BUF);
      if (method === 'Page.javascriptDialogOpening') this.dialog = params;
      else if (method === 'Page.javascriptDialogClosed') this.dialog = null;
      else if (method === 'Page.loadEventFired' || method === 'Page.domContentEventFired') {
        try { await withTimeout(this.cdp.send_raw('Runtime.evaluate', { expression: markJs }, this.session), 2000, 'mark'); }
        catch {}
      }
    });
  }

  async handle(req) {
    const meta = req.meta;
    if (meta === 'drain_events') {
      const out = this.events; this.events = [];
      return { events: out };
    }
    if (meta === 'session') return { session_id: this.session };
    if (meta === 'set_session') {
      this.session = req.session_id;
      try {
        await withTimeout(this.cdp.send_raw('Page.enable', {}, this.session), 3000, 'Page.enable');
        await withTimeout(this.cdp.send_raw('Runtime.evaluate', {
          expression: "if(!document.title.startsWith('\u{1F7E2}'))document.title='\u{1F7E2} '+document.title",
        }, this.session), 2000, 'mark');
      } catch {}
      return { session_id: this.session };
    }
    if (meta === 'pending_dialog') return { dialog: this.dialog };
    if (meta === 'shutdown') { this.stopResolve(); return { ok: true }; }

    const method = req.method;
    const params = req.params || {};
    // Browser-level Target.* calls must not use a session (stale or otherwise).
    // For everything else, explicit session in req wins; else default.
    const sid = method.startsWith('Target.') ? null : (req.session_id || this.session);
    try {
      return { result: await this.cdp.send_raw(method, params, sid) };
    } catch (e) {
      const msg = e.message;
      if (msg.includes('Session with given id not found') && sid === this.session && sid) {
        log(`stale session ${sid}, re-attaching`);
        if (await this.attach_first_page()) {
          return { result: await this.cdp.send_raw(method, params, this.session) };
        }
      }
      return { error: msg };
    }
  }
}

// Only remove a pre-existing SOCK if it's an actual socket we own; refuse
// to unlink regular files, dirs, or symlinks planted by another user
// (SECURITY.md §3.4).
function _claim_sock_path() {
  let st;
  try { st = fs.lstatSync(SOCK); } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  if (!st.isSocket()) throw new Error(`${SOCK} exists and is not a socket -- refusing to unlink`);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new Error(`${SOCK} owned by uid ${st.uid}, not us -- refusing to unlink`);
  }
  fs.unlinkSync(SOCK);
}

async function serve(d) {
  _claim_sock_path();
  const server = net.createServer((socket) => {
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      (async () => {
        try {
          const resp = await d.handle(JSON.parse(line));
          socket.end(JSON.stringify(resp) + '\n');
        } catch (e) {
          log(`conn: ${e.message}`);
          try { socket.end(JSON.stringify({ error: e.message }) + '\n'); } catch {}
        }
      })();
    });
    socket.on('error', (e) => log(`socket: ${e.message}`));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(SOCK, () => { fs.chmodSync(SOCK, 0o600); resolve(); });
  });
  // Confirm the socket we're bound to is still ours after listen + chmod
  // (defense in depth against a race that slipped past _claim_sock_path).
  const st = fs.lstatSync(SOCK);
  if (!st.isSocket() || (typeof process.getuid === 'function' && st.uid !== process.getuid())) {
    throw new Error(`${SOCK} was swapped during bind -- aborting`);
  }
  log(`listening on ${SOCK} (name=${NAME}, remote=${REMOTE_ID || 'local'})`);
  await d.stopped;
  server.close();
}

// Log when helpers.js changes between daemon runs. Not a gate -- just an
// audit trail so injected helper functions surface in /tmp/bu-{NAME}.log
// (SECURITY.md §3.6).
function _audit_helpers() {
  let src;
  try { src = fs.readFileSync(HELPERS_PATH); } catch { return; }
  const cur = crypto.createHash('sha256').update(src).digest('hex');
  let prev = null;
  try { prev = fs.readFileSync(HELPERS_HASH_FILE, 'utf8').trim(); } catch {}
  if (prev && prev !== cur) log(`helpers.js changed: ${prev.slice(0, 12)} -> ${cur.slice(0, 12)} (${src.length} bytes)`);
  else if (!prev) log(`helpers.js sha256 ${cur.slice(0, 12)} (${src.length} bytes)`);
  try { fs.writeFileSync(HELPERS_HASH_FILE, cur); } catch {}
}

async function main() {
  _audit_helpers();
  const d = new Daemon();
  await d.start();
  await serve(d);
}

function already_running() {
  return new Promise((resolve) => {
    const s = net.createConnection(SOCK);
    s.setTimeout(1000);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    s.once('timeout', () => { s.destroy(); resolve(false); });
  });
}

if (is_main(import.meta)) {
  (async () => {
    if (await already_running()) {
      console.error(`daemon already running on ${SOCK}`);
      process.exit(0);
    }
    fs.writeFileSync(LOG, '');
    fs.writeFileSync(PID, String(process.pid));
    const cleanup = async () => {
      await stop_remote();
      try { fs.unlinkSync(PID); } catch {}
      try { fs.unlinkSync(`/tmp/bu-${NAME}.remote.json`); } catch {}
    };
    process.on('SIGINT', async () => { await cleanup(); process.exit(0); });
    process.on('SIGTERM', async () => { await cleanup(); process.exit(0); });
    try {
      await main();
      await cleanup();
    } catch (e) {
      log(`fatal: ${e.stack || e.message}`);
      await cleanup();
      process.exit(1);
    }
  })();
}

export { Daemon, CDPClient, SOCK, LOG, PID, NAME };
