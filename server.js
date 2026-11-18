// TradeQuest — local server. Zero dependencies: `node server.js` (Node 18+).
// The API itself lives in lib/api.js and is shared with the Cloudflare Worker.
import http from 'node:http';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './lib/env.js';
import * as store from './lib/store.js';
import { init as initFileStore } from './lib/store-file.js';
import { createKite } from './lib/kite.js';
import { createApi } from './lib/api.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(ROOT, '.env'));

const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || 'data');
const MOCK = /^(1|true|yes)$/i.test(process.env.KITE_MOCK || '');

initFileStore(DATA_DIR);

// Small JSON files in data/ for the Kite login and the instrument list.
const fileStorage = {
  get: async (k) => { try { return JSON.parse(await readFile(path.join(DATA_DIR, `${k}.json`), 'utf8')); } catch { return null; } },
  put: (k, v) => writeFile(path.join(DATA_DIR, `${k}.json`), JSON.stringify(v)),
  del: (k) => unlink(path.join(DATA_DIR, `${k}.json`)).catch(() => {}),
};
// Candle cache: data/cache/<hash>.json
const CACHE = path.join(DATA_DIR, 'cache');
const cacheFile = (k) => path.join(CACHE, createHash('sha1').update(k).digest('hex').slice(0, 20) + '.json');
const cache = {
  get: async (k) => { try { return JSON.parse(await readFile(cacheFile(k), 'utf8')); } catch { return null; } },
  put: async (k, v) => { await mkdir(CACHE, { recursive: true }); await writeFile(cacheFile(k), JSON.stringify(v)); },
};

const kite = createKite({ apiKey: process.env.KITE_API_KEY, apiSecret: process.env.KITE_API_SECRET, storage: fileStorage, mock: MOCK, getTrades: () => store.getState().trades });
await kite.init();
const handle = createApi({ store, kite, cache });

// ---------- helpers ----------
const send = (res, status, data, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
};

async function readJson(req, limit = 50 * 1024 * 1024) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw new store.HttpError('Request too large', 413); chunks.push(c); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new store.HttpError('Invalid JSON'); }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : decodeURIComponent(pathname);
  const file = path.join(PUBLIC, path.normalize(rel));
  if (!file.startsWith(PUBLIC)) return send(res, 403, { error: 'Forbidden' });
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    send(res, 404, { error: 'Not found' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      const hit = await handle({ method: req.method, pathname: url.pathname, url, body: () => readJson(req) });
      if (!hit) return send(res, 404, { error: 'Unknown API route' });
      const out = hit.result;
      if (out?.redirect) { res.writeHead(302, { Location: out.redirect }); return res.end(); }
      if (out?.response) {
        res.writeHead(out.response.status, { 'Content-Type': out.response.headers.get('content-type') || 'text/plain' });
        return res.end(Buffer.from(await out.response.arrayBuffer()));
      }
      if (out?.json !== undefined && out.headers) return send(res, 200, out.json, out.headers);
      return send(res, 200, out);
    }
    if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
    await serveStatic(req, res, url.pathname);
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: e.message, code: e.code });
  }
});

server.listen(PORT, HOST, () => {
  const s = kite.status();
  console.log(`\n  TradeQuest running → http://${HOST}:${PORT}`);
  console.log(`  Data file: ${path.join(DATA_DIR, 'journal.json')}`);
  console.log(`  Kite: ${s.mock ? 'DEMO mode (simulated prices)' : s.configured ? (s.connected ? `connected as ${s.user.name}` : 'configured — connect from Settings') : 'not configured (manual prices only)'}\n`);
});
