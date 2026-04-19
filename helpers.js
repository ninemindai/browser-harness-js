// Browser control via CDP. Read, edit, extend -- this file is yours.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';

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
const SOCK = `/tmp/bu-${NAME}.sock`;
const INTERNAL = ['chrome://', 'chrome-untrusted://', 'devtools://', 'chrome-extension://', 'about:'];

// Filesystem allowlist for upload_file / screenshot. Overridable via BU_ALLOWED_PATHS
// (colon-separated absolute prefixes). Guards a prompt-injected agent from
// reaching ~/.ssh, ~/.aws, etc. See SECURITY.md §3.1.
//
// Allowlist entries are realpath'd so /tmp (a symlink to /private/tmp on macOS)
// matches canonicalised paths.
function _realpath(p) {
  try { return fs.realpathSync(p); } catch { return p; }
}
const ALLOWED_PATHS = (process.env.BU_ALLOWED_PATHS || `/tmp:${process.cwd()}`)
  .split(':').filter(Boolean).map((p) => _realpath(path.resolve(p)));
// Resolve symlinks in `p` so a symlink under an allowed prefix pointing at, say,
// ~/.ssh/id_ed25519 does NOT sneak through. For not-yet-existent targets
// (e.g. screenshot destinations) realpath the closest existing ancestor.
function _check_path(p) {
  const abs = path.resolve(p);
  let real;
  try {
    real = fs.realpathSync(abs);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    let dir = path.dirname(abs);
    const tail = [path.basename(abs)];
    while (true) {
      try { real = path.join(fs.realpathSync(dir), ...tail); break; }
      catch (err) {
        if (err.code !== 'ENOENT') throw err;
        const parent = path.dirname(dir);
        if (parent === dir) throw err;
        tail.unshift(path.basename(dir));
        dir = parent;
      }
    }
  }
  for (const pre of ALLOWED_PATHS) {
    if (real === pre || real.startsWith(pre + path.sep)) return real;
  }
  throw new Error(`path outside BU_ALLOWED_PATHS (${ALLOWED_PATHS.join(':')}): ${real}`);
}

function _send(req) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(SOCK);
    let buf = '';
    let done = false;
    s.on('connect', () => s.write(JSON.stringify(req) + '\n'));
    s.on('data', (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl < 0 || done) return;
      done = true;
      s.destroy();
      try {
        const r = JSON.parse(buf.slice(0, nl));
        if ('error' in r) reject(new Error(r.error));
        else resolve(r);
      } catch (e) { reject(e); }
    });
    s.on('end', () => { if (!done) reject(new Error('empty response from daemon')); });
    s.on('error', (e) => { if (!done) reject(e); });
  });
}

// Raw CDP. cdp('Page.navigate', { url: '...' }), cdp('DOM.getDocument', { depth: -1 }).
async function cdp(method, params = {}) {
  const { session_id, ...rest } = params;
  const r = await _send({ method, params: rest, session_id });
  return r.result || {};
}

async function drain_events() {
  return (await _send({ meta: 'drain_events' })).events;
}

// --- navigation / page ---
function _rglob_md(dir) {
  const out = [];
  function walk(d) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.md')) out.push(e.name);
    }
  }
  walk(dir);
  return out.sort();
}

async function goto(url) {
  const r = await cdp('Page.navigate', { url });
  let host = '';
  try { host = new URL(url).hostname || ''; } catch {}
  const key = host.replace(/^www\./, '').split('.')[0];
  const base = path.resolve(__dirname, 'domain-skills');
  const d = path.resolve(base, key);
  // Ensure the resolved path stays under domain-skills/ (SECURITY.md §3.3).
  if (d !== base && !d.startsWith(base + path.sep)) return r;
  let isDir = false;
  try { isDir = fs.statSync(d).isDirectory(); } catch {}
  return isDir ? { ...r, domain_skills: _rglob_md(d).slice(0, 10) } : r;
}

// {url, title, w, h, sx, sy, pw, ph} -- viewport + scroll + page size.
//
// If a native dialog (alert/confirm/prompt/beforeunload) is open, returns
// {dialog: {type, message, ...}} instead -- the page's JS thread is frozen
// until the dialog is handled (see interaction-skills/dialogs.md).
async function page_info() {
  const dialog = (await _send({ meta: 'pending_dialog' })).dialog;
  if (dialog) return { dialog };
  const r = await cdp('Runtime.evaluate', {
    expression: "JSON.stringify({url:location.href,title:document.title,w:innerWidth,h:innerHeight,sx:scrollX,sy:scrollY,pw:document.documentElement.scrollWidth,ph:document.documentElement.scrollHeight})",
    returnByValue: true,
  });
  return JSON.parse(r.result.value);
}

// --- input ---
async function click(x, y, button = 'left', clicks = 1) {
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: clicks });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: clicks });
}

async function type_text(text) {
  await cdp('Input.insertText', { text });
}

const _KEYS = { // key -> [windowsVirtualKeyCode, code, text]
  Enter: [13, 'Enter', '\r'], Tab: [9, 'Tab', '\t'], Backspace: [8, 'Backspace', ''],
  Escape: [27, 'Escape', ''], Delete: [46, 'Delete', ''], ' ': [32, 'Space', ' '],
  ArrowLeft: [37, 'ArrowLeft', ''], ArrowUp: [38, 'ArrowUp', ''],
  ArrowRight: [39, 'ArrowRight', ''], ArrowDown: [40, 'ArrowDown', ''],
  Home: [36, 'Home', ''], End: [35, 'End', ''],
  PageUp: [33, 'PageUp', ''], PageDown: [34, 'PageDown', ''],
};

// Modifiers bitfield: 1=Alt, 2=Ctrl, 4=Meta(Cmd), 8=Shift.
// Special keys (Enter, Tab, Arrow*, Backspace, etc.) carry their virtual key codes
// so listeners checking e.keyCode / e.key all fire.
async function press_key(key, modifiers = 0) {
  const [vk, code, text] = _KEYS[key] || [
    key.length === 1 ? key.charCodeAt(0) : 0,
    key,
    key.length === 1 ? key : '',
  ];
  const base = { key, code, modifiers, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(text ? { text } : {}) });
  if (text && text.length === 1) {
    const { text: _t, ...rest } = { ...base };
    await cdp('Input.dispatchKeyEvent', { type: 'char', text, ...rest });
  }
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

async function scroll(x, y, dy = -300, dx = 0) {
  await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy });
}

// --- visual ---
async function screenshot(p = '/tmp/shot.png', full = false) {
  const abs = _check_path(p);
  const r = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full });
  fs.writeFileSync(abs, Buffer.from(r.data, 'base64'));
  return abs;
}

// --- tabs ---
async function list_tabs(include_chrome = true) {
  const out = [];
  for (const t of (await cdp('Target.getTargets')).targetInfos) {
    if (t.type !== 'page') continue;
    const url = t.url || '';
    if (!include_chrome && INTERNAL.some((p) => url.startsWith(p))) continue;
    out.push({ targetId: t.targetId, title: t.title || '', url });
  }
  return out;
}

async function current_tab() {
  const t = (await cdp('Target.getTargetInfo')).targetInfo || {};
  return { targetId: t.targetId, url: t.url || '', title: t.title || '' };
}

// Prepend green circle to tab title so the user can see which tab the agent controls.
async function _mark_tab() {
  try {
    await cdp('Runtime.evaluate', {
      expression: "if(!document.title.startsWith('\u{1F7E2}'))document.title='\u{1F7E2} '+document.title",
    });
  } catch {}
}

async function switch_tab(target_id) {
  try {
    await cdp('Runtime.evaluate', {
      expression: "if(document.title.startsWith('\u{1F7E2} '))document.title=document.title.slice(2)",
    });
  } catch {}
  await cdp('Target.activateTarget', { targetId: target_id });
  const { sessionId } = await cdp('Target.attachToTarget', { targetId: target_id, flatten: true });
  await _send({ meta: 'set_session', session_id: sessionId });
  await _mark_tab();
  return sessionId;
}

async function new_tab(url = 'about:blank') {
  // Always create blank, then goto: passing url to createTarget races with
  // attach, so the brief about:blank is "complete" by the time the caller
  // polls and wait_for_load() returns before navigation actually starts.
  const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' });
  await switch_tab(targetId);
  if (url !== 'about:blank') await goto(url);
  return targetId;
}

// Switch to a real user tab if current is chrome:// / internal / stale.
async function ensure_real_tab() {
  const tabs = await list_tabs(false);
  if (!tabs.length) return null;
  try {
    const cur = await current_tab();
    if (cur.url && !INTERNAL.some((p) => cur.url.startsWith(p))) return cur;
  } catch {}
  await switch_tab(tabs[0].targetId);
  return tabs[0];
}

// First iframe target whose URL contains `url_substr`. Use with js(..., target_id).
async function iframe_target(url_substr) {
  for (const t of (await cdp('Target.getTargets')).targetInfos) {
    if (t.type === 'iframe' && (t.url || '').includes(url_substr)) return t.targetId;
  }
  return null;
}

// --- utility ---
function wait(seconds = 1.0) {
  return new Promise((r) => setTimeout(r, seconds * 1000));
}

// Poll document.readyState == 'complete' or timeout.
async function wait_for_load(timeout = 15.0) {
  const deadline = Date.now() + timeout * 1000;
  while (Date.now() < deadline) {
    if ((await js('document.readyState')) === 'complete') return true;
    await wait(0.3);
  }
  return false;
}

// Run JS in the attached tab (default) or inside an iframe target (via iframe_target()).
async function js(expression, target_id = null) {
  let sid;
  if (target_id) {
    sid = (await cdp('Target.attachToTarget', { targetId: target_id, flatten: true })).sessionId;
  }
  const r = await cdp('Runtime.evaluate', { session_id: sid, expression, returnByValue: true, awaitPromise: true });
  return (r.result || {}).value;
}

const _KC = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, ' ': 32, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 };

// Dispatch a DOM KeyboardEvent on the matched element.
//
// Use this when a site reacts to synthetic DOM key events on an element more reliably
// than to raw CDP input events.
async function dispatch_key(selector, key = 'Enter', event = 'keypress') {
  const kc = _KC[key] !== undefined ? _KC[key] : (key.length === 1 ? key.charCodeAt(0) : 0);
  const s = JSON.stringify(selector), k = JSON.stringify(key), ev = JSON.stringify(event);
  await js(
    `(()=>{const e=document.querySelector(${s});if(e){e.focus();e.dispatchEvent(new KeyboardEvent(${ev},{key:${k},code:${k},keyCode:${kc},which:${kc},bubbles:true}));}})()`
  );
}

// Set files on a file input via CDP DOM.setFileInputFiles. `p` is an absolute filepath.
// Paths are checked against BU_ALLOWED_PATHS (see SECURITY.md §3.1).
async function upload_file(selector, p) {
  const files = (Array.isArray(p) ? p : [p]).map(_check_path);
  const doc = await cdp('DOM.getDocument', { depth: -1 });
  const { nodeId } = await cdp('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
  if (!nodeId) throw new Error(`no element for ${selector}`);
  await cdp('DOM.setFileInputFiles', { files, nodeId });
}

// Block cloud-metadata endpoints by default. Hostname-only check -- DNS
// rebinding is out of scope, but the common SSRF targets (IMDS, GCP metadata)
// are blocked. Users override via BU_HTTP_GET_DENY (comma-separated, case-
// insensitive); set to empty string to disable.
const HTTP_DENY = (process.env.BU_HTTP_GET_DENY === undefined
  ? '169.254.169.254,metadata.google.internal,metadata'
  : process.env.BU_HTTP_GET_DENY
).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

function _check_http_host(url) {
  let u;
  try { u = new URL(url); } catch { return; }
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (HTTP_DENY.includes(host)) {
    throw new Error(`http_get: host "${host}" blocked -- override via BU_HTTP_GET_DENY`);
  }
  if (/^169\.254\./.test(host)) {
    throw new Error(`http_get: IPv4 link-local host "${host}" blocked -- override via BU_HTTP_GET_DENY`);
  }
}

// Pure HTTP -- no browser. Use for static pages / APIs.
async function http_get(url, headers = null, timeout = 20.0) {
  _check_http_host(url);
  const h = { 'User-Agent': 'Mozilla/5.0', 'Accept-Encoding': 'gzip' };
  if (headers) Object.assign(h, headers);
  const r = await fetch(url, { headers: h, signal: AbortSignal.timeout(timeout * 1000) });
  const buf = Buffer.from(await r.arrayBuffer());
  const data = r.headers.get('content-encoding') === 'gzip' ? zlib.gunzipSync(buf) : buf;
  return data.toString('utf8');
}

export {
  NAME, SOCK, INTERNAL,
  cdp, drain_events,
  goto, page_info,
  click, type_text, press_key, scroll,
  screenshot,
  list_tabs, current_tab, switch_tab, new_tab, ensure_real_tab, iframe_target,
  wait, wait_for_load, js, dispatch_key, upload_file, http_get,
};
