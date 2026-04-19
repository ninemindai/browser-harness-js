#!/usr/bin/env node
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import * as admin from './admin.js';
import * as helpers from './helpers.js';

const __dirname = import.meta.dirname;
const __filename = import.meta.filename;
const require = createRequire(import.meta.url);
const { ensure_daemon } = admin;

process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /USE_MAIN_CONTEXT_DEFAULT_LOADER/.test(w.message)) return;
  console.warn(w);
});

const HELP = `Browser Harness (JS)

Read SKILL.md for the default workflow and examples.

Typical usage:
  browser-harness <<'JS'
  await ensure_real_tab();
  console.log(await page_info());
  JS

Helpers are pre-injected into the script's scope. The daemon auto-starts and connects to the running browser.
Top-level await is supported -- the input is wrapped in an async function.
`;

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args[0] === '-h' || args[0] === '--help')) {
    process.stdout.write(HELP);
    return;
  }
  if (process.stdin.isTTY) {
    console.error(
      "browser-harness reads JS from stdin. Use:\n" +
      "  browser-harness <<'JS'\n" +
      "  console.log(await page_info());\n" +
      "  JS"
    );
    process.exit(1);
  }
  await ensure_daemon();
  const code = fs.readFileSync(0, 'utf8');
  const ctx = vm.createContext({
    ...helpers,
    ...admin,
    console, require, process, Buffer,
    setTimeout, clearTimeout, setInterval, clearInterval, setImmediate,
    fetch, URL, URLSearchParams, AbortSignal, AbortController,
    __dirname, __filename,
  });
  const wrapped = `(async () => {\n${code}\n})()`;
  const result = vm.runInContext(wrapped, ctx, {
    filename: '<stdin>',
    importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  });
  await result;
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : String(e));
  process.exit(1);
});
