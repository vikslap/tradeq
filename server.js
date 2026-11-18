// TradeQuest — local server. Zero dependencies: `node server.js` (Node 18+).
import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './lib/env.js';
import * as store from './lib/store.js';
import { createKite } from './lib/kite.js';
import { chartPlan, defaultInterval, excursionsFromCandles, toWeekly } from './lib/chart.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(ROOT, '.env'));

const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || 'data');
const MOCK = /^(1|true|yes)$/i.test(process.env.KITE_MOCK || '');

store.init(DATA_DIR);
const kite = createKite({ apiKey: process.env.KITE_API_KEY, apiSecret: process.env.KITE_API_SECRET, dataDir: DATA_DIR, mock: MOCK, getTrades: () => store.getState().trades });

// ---------- helpers ----------
const send = (res, status, data, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
};
const redirect = (res, to) => { res.writeHead(302, { Location: to }); res.end(); };

async function readJson(req, limit = 10 * 1024 * 1024) {
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

// ---------- routes ----------
const routes = [];
const on = (method, pattern, handler) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler });

on('GET', '/api/state', () => store.getState());
on('POST', '/api/trades', async (req) => store.createTrade(await readJson(req)));
on('PUT', '/api/trades/:id', async (req, p) => store.updateTrade(p.id, await readJson(req)));
on('DELETE', '/api/trades/:id', (req, p) => { store.deleteTrade(p.id); return { ok: true }; });
on('POST', '/api/trades/:id/thesis-reviews', async (req, p) => store.addThesisReview(p.id, await readJson(req)));
on('DELETE', '/api/trades/:id/thesis-reviews/:rid', (req, p) => store.deleteThesisReview(p.id, p.rid));
on('POST', '/api/groups', async (req) => store.createGroup(await readJson(req)));
on('PUT', '/api/groups/:id', async (req, p) => store.updateGroup(p.id, await readJson(req)));
on('DELETE', '/api/groups/:id', (req, p) => { store.deleteGroup(p.id); return { ok: true }; });
on('DELETE', '/api/trades/:id/group', (req, p) => { store.unlinkTrade(p.id); return { ok: true }; });
on('POST', '/api/reviews', async (req) => store.upsertReview(await readJson(req)));
on('DELETE', '/api/reviews/:id', (req, p) => { store.deleteReview(p.id); return { ok: true }; });
on('PUT', '/api/settings', async (req) => store.updateSettings(await readJson(req)));
on('POST', '/api/import/tradebook', async (req) => store.importTradebook(await readJson(req, 50 * 1024 * 1024)));
on('POST', '/api/import', async (req) => store.importState(await readJson(req, 50 * 1024 * 1024)));
on('GET', '/api/export', (req, p, res) => {
  const day = new Date().toISOString().slice(0, 10);
  send(res, 200, store.getState(), { 'Content-Disposition': `attachment; filename="tradequest-${day}.json"` });
});

on('GET', '/api/kite/status', () => kite.status());
on('GET', '/api/kite/login', (req, p, res) => redirect(res, kite.loginUrl()));
on('GET', '/api/kite/callback', async (req, p, res, url) => {
  const token = url.searchParams.get('request_token');
  if (url.searchParams.get('status') !== 'success' || !token) return redirect(res, '/#/settings?kite=error&msg=' + encodeURIComponent('Login was cancelled'));
  try {
    await kite.exchange(token);
    redirect(res, '/#/settings?kite=ok');
  } catch (e) {
    redirect(res, '/#/settings?kite=error&msg=' + encodeURIComponent(e.message));
  }
});
on('POST', '/api/kite/logout', async () => { await kite.logout(); return kite.status(); });
on('GET', '/api/kite/quote', async (req, p, res, url) => {
  const keys = [...new Set((url.searchParams.get('i') || '').split(',').map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z]+:[A-Z0-9&\-_.]+$/.test(s)))];
  if (!keys.length) throw new store.HttpError('Pass instruments as ?i=NSE:INFY,NFO:NIFTY25DECFUT');
  const quotes = await kite.quotes(keys);
  store.recordExcursions(quotes);
  return { quotes };
});
on('GET', '/api/kite/search', async (req, p, res, url) => ({ results: await kite.search(url.searchParams.get('q') || '') }));
// Candles for one trade. Closed trades are cached on disk (their chart never changes),
// and the candles also fill in the best/worst price reached while the trade was open.
on('GET', '/api/trades/:id/chart', async (req, p, res, url) => {
  const t = store.getState().trades.find((x) => x.id === p.id);
  if (!t) throw new store.HttpError('Trade not found', 404);
  const plan = chartPlan(t, Date.now(), url.searchParams.get('interval') || undefined);
  const fetchInterval = plan.interval === 'week' ? 'day' : plan.interval;
  const cacheKey = `${t.exchange}:${t.symbol}|${t.entryTime}|${t.exitTime}|${plan.interval}|${plan.from}`;
  const cacheFile = path.join(DATA_DIR, 'candles', `${t.id}-${plan.interval}.json`);
  let candles = null;
  if (t.status === 'CLOSED') {
    try { const c = JSON.parse(await readFile(cacheFile, 'utf8')); if (c.key === cacheKey) candles = c.candles; } catch { /* not cached */ }
  }
  if (!candles) {
    candles = await kite.candles({ exchange: t.exchange, symbol: t.symbol, interval: fetchInterval, from: plan.from, to: plan.to, trade: t, plan: { ...plan, interval: fetchInterval } });
    if (plan.interval === 'week') candles = toWeekly(candles);
    if (t.status === 'CLOSED' && candles.length) {
      await mkdir(path.dirname(cacheFile), { recursive: true });
      await writeFile(cacheFile, JSON.stringify({ key: cacheKey, candles }));
    }
  }
  const updated = store.mergeExcursions(t.id, excursionsFromCandles(t, candles, plan.interval));
  return { interval: plan.interval, defaultInterval: defaultInterval(t), candles, updated };
});
on('GET', '/api/kite/portfolio', async () => kite.portfolio());
on('GET', '/api/kite/fills', async () => ({ fills: await kite.fills() }));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.re);
        if (!m) continue;
        const out = await r.handler(req, m.groups || {}, res, url);
        if (!res.headersSent) send(res, 200, out);
        return;
      }
      return send(res, 404, { error: 'Unknown API route' });
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
