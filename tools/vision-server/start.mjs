// Makes this PC the SmartSort AI server while it is running:
//   1. starts the gatekeeper in front of Ollama (server.mjs)
//   2. opens a free Cloudflare quick tunnel to it (public HTTPS address)
//   3. publishes that address to the repo's `vision-endpoint` branch, where
//      the SmartSort website looks it up
// If the tunnel drops it is reopened and the new address published. When
// this stops (PC off, window closed) the website falls back to its built-in
// model and keeps checking, so it switches back when the PC returns.
//
// Usage:  node tools/vision-server/start.mjs
// Needs:  Ollama with the model pulled, and the GitHub CLI logged in (gh).
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import https from 'node:https';
import { Resolver } from 'node:dns';
import { server, PORT, MODEL } from './server.mjs';

const REPO = process.env.SMARTSORT_REPO || 'LuleArther/smartsort';
const BRANCH = 'vision-endpoint';
const FILE = 'endpoint.json';
const CLOUDFLARED = process.env.CLOUDFLARED || join(process.env.LOCALAPPDATA || '.', 'SmartSort', 'cloudflared.exe');
const CLOUDFLARED_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), '[start]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- GitHub: publish the current address ---------- */
const token = (() => {
  try { return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim(); } catch { return process.env.GITHUB_TOKEN || ''; }
})();

async function gh(method, path, body) {
  const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'smartsort-vision-server' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 404) throw new Error(`GitHub ${method} ${path}: ${res.status} ${json.message || ''}`);
  return res.ok ? json : null;
}

async function publish(info) {
  if (!token) { log('No GitHub token (run "gh auth login"); the website cannot find this PC.'); return; }
  const content = Buffer.from(JSON.stringify({ ...info, model: MODEL, updated: new Date().toISOString() }, null, 2)).toString('base64');
  const existing = await gh('GET', `/contents/${FILE}?ref=${BRANCH}`);
  if (existing) {
    await gh('PUT', `/contents/${FILE}`, { message: `AI computer ${info.online ? 'online' : 'offline'}`, content, sha: existing.sha, branch: BRANCH });
  } else {
    // First run: create the branch with just this file (no shared history).
    const tree = await gh('POST', '/git/trees', { tree: [{ path: FILE, mode: '100644', type: 'blob', content: Buffer.from(content, 'base64').toString('utf8') }] });
    const commit = await gh('POST', '/git/commits', { message: 'AI computer endpoint', tree: tree.sha, parents: [] });
    await gh('POST', '/git/refs', { ref: `refs/heads/${BRANCH}`, sha: commit.sha });
  }
  log(`published: ${info.online ? info.url : 'offline'}`);
}

/* ---------- Cloudflare quick tunnel ---------- */
async function ensureCloudflared() {
  if (existsSync(CLOUDFLARED)) return;
  log('downloading cloudflared (first run only)...');
  mkdirSync(join(CLOUDFLARED, '..'), { recursive: true });
  const res = await fetch(CLOUDFLARED_URL);
  if (!res.ok) throw new Error(`cloudflared download failed: ${res.status}`);
  writeFileSync(CLOUDFLARED, Buffer.from(await res.arrayBuffer()));
}

let tunnel = null;
let publicUrl = null;
let stopping = false;

function openTunnel() {
  return new Promise((resolve, reject) => {
    tunnel = spawn(CLOUDFLARED, ['tunnel', '--url', `http://127.0.0.1:${PORT}`, '--no-autoupdate'], { windowsHide: true });
    const onData = (buf) => {
      const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) resolve(m[0]);
    };
    tunnel.stdout.on('data', onData);
    tunnel.stderr.on('data', onData);
    tunnel.on('exit', (code) => { tunnel = null; reject(new Error(`cloudflared exited (${code})`)); if (!stopping) reconnect(); });
    setTimeout(() => reject(new Error('no tunnel address after 60 s')), 60000);
  });
}

/* Checks the public address using Cloudflare's DNS (1.1.1.1) rather than
   the local router: asking the router for a brand-new tunnel name before
   it exists makes many routers cache "does not exist" for a long time,
   which would break the address for every device on this network. */
const resolver = new Resolver();
resolver.setServers(['1.1.1.1', '1.0.0.1']);
const lookup = (host, opts, cb) => resolver.resolve4(host, (err, addrs) => {
  if (err) return cb(err);
  if (opts?.all) return cb(null, addrs.map((address) => ({ address, family: 4 })));
  cb(null, addrs[0], 4);
});

function healthOk(url) {
  return new Promise((resolve) => {
    const req = https.get(`${url}/health`, { lookup, timeout: 5000 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function reachable(url, tries = 30) {
  for (let i = 0; i < tries; i++) {
    if (await healthOk(url)) return true;
    await sleep(2000);
  }
  return false;
}

let reconnecting = false;
async function reconnect() {
  if (reconnecting || stopping) return;
  reconnecting = true;
  for (;;) {
    try {
      tunnel?.kill();
      publicUrl = await openTunnel();
      log(`tunnel: ${publicUrl}`);
      if (!(await reachable(publicUrl))) throw new Error('tunnel address not reachable');
      await publish({ online: true, url: publicUrl });
      break;
    } catch (e) {
      log(`tunnel problem: ${e.message}; retrying in 15 s`);
      await sleep(15000);
    }
  }
  reconnecting = false;
}

async function main() {
  try {
    const tags = await (await fetch('http://127.0.0.1:11434/api/tags')).json();
    if (!tags.models.some((m) => m.name === MODEL)) log(`WARNING: ${MODEL} is not installed. Run: ollama pull ${MODEL}`);
  } catch { log('WARNING: Ollama is not running yet. Requests will fail until it starts.'); }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', resolve);
  }).catch((e) => {
    if (e.code !== 'EADDRINUSE') throw e;
    log(`Port ${PORT} is in use: the SmartSort AI server is probably already running. Nothing to do.`);
    process.exit(0);
  });
  log(`gatekeeper on 127.0.0.1:${PORT} for ${MODEL}`);
  await ensureCloudflared();
  await reconnect();
  log('SmartSort AI server is online. Keep this window open; close it (or Ctrl+C) to go offline.');

  // Every minute, make sure the public address still works.
  setInterval(async () => {
    if (reconnecting || !publicUrl) return;
    if (!(await reachable(publicUrl, 3))) { log('public address stopped working; reconnecting'); reconnect(); }
  }, 60000);
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  log('going offline...');
  tunnel?.kill();
  try { await publish({ online: false, url: null }); } catch { /* best effort */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGBREAK', shutdown);
process.on('SIGHUP', shutdown); // closing the console window on Windows

main().catch((e) => { console.error(e); process.exit(1); });
