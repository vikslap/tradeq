// TradeQuest on Cloudflare: a Worker serving the same API as server.js, with the
// journal in D1 and a password login. Static files (public/) are served by Workers
// static assets; only /api/* reaches this code. See docs/CLOUDFLARE.md.
import * as store from '../lib/store.js';
import { createKite } from '../lib/kite.js';
import { createApi } from '../lib/api.js';
import { paperCron } from '../lib/paper-api.js';

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS docs (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, body TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
];
const COOKIE = 'tq_auth';
const SESSION_DAYS = 60;

// ---------- journal <-> D1 rows ----------
// Each trade, review, group and practice session is its own row, so a change
// writes only the rows that changed. Everything else (settings…) is one "root" row.
const COLLECTIONS = {
  trades: { get: (s) => s.trades, set: (s, v) => { s.trades = v; } },
  reviews: { get: (s) => s.reviews, set: (s, v) => { s.reviews = v; } },
  groups: { get: (s) => s.groups, set: (s, v) => { s.groups = v; } },
  ledger: { get: (s) => s.ledger, set: (s, v) => { s.ledger = v; } },
  practice: { get: (s) => s.practice?.sessions, set: (s, v) => { s.practice = { ...(s.practice || {}), sessions: v }; } },
};

function explode(state, prev) {
  const out = new Map();
  const root = { ...state, trades: undefined, reviews: undefined, groups: undefined, ledger: undefined, practice: { ...(state.practice || {}), sessions: undefined } };
  out.set('root', { seq: 0, body: JSON.stringify(root) });
  for (const [name, c] of Object.entries(COLLECTIONS)) {
    const list = c.get(state) || [];
    const seqs = [...prev.entries()].filter(([id]) => id.startsWith(name + '/')).map(([, d]) => d.seq);
    let lo = seqs.length ? Math.min(...seqs) : 0; let hi = seqs.length ? Math.max(...seqs) : 0;
    list.forEach((item, i) => {
      const id = `${name}/${item.id}`;
      // Keep a row's position; new rows go at the end (or the front, for newest-first lists).
      const seq = prev.get(id)?.seq ?? (i === 0 && list.length > 1 ? --lo : ++hi);
      out.set(id, { seq, body: JSON.stringify(item) });
    });
  }
  return out;
}

function implode(rows) {
  const root = rows.find((r) => r.id === 'root');
  const state = root ? JSON.parse(root.body) : {};
  const lists = Object.fromEntries(Object.keys(COLLECTIONS).map((k) => [k, []]));
  for (const r of rows) {
    const slash = r.id.indexOf('/');
    if (slash > 0 && lists[r.id.slice(0, slash)]) lists[r.id.slice(0, slash)].push(r);
  }
  for (const [name, c] of Object.entries(COLLECTIONS)) c.set(state, lists[name].sort((a, b) => a.seq - b.seq).map((r) => JSON.parse(r.body)));
  return state;
}

// Write changed rows as a few JSON-array statements (D1 allows 100 bound
// parameters per query and 50 queries per request on the free plan).
function chunk(items, size = 1_500_000) {
  const out = []; let cur = []; let n = 0;
  for (const it of items) {
    const len = JSON.stringify(it).length;
    if (cur.length && n + len > size) { out.push(cur); cur = []; n = 0; }
    cur.push(it); n += len;
  }
  if (cur.length) out.push(cur);
  return out;
}

// ---------- per-isolate cache of the loaded journal ----------
let loaded = null; // { rev, snapshot: Map<id,{seq,body}> }
let ready = null;
let queue = Promise.resolve();
// One journal request at a time per isolate. A request that takes too long releases the
// queue after 30 s so one stuck call (e.g. a slow upstream) can't block everything else.
const serial = (fn) => {
  const p = queue.then(fn, fn);
  queue = Promise.race([p.catch(() => {}), new Promise((r) => setTimeout(r, 30000))]);
  return p;
};

async function setup(db) {
  ready ||= db.batch(SCHEMA.map((q) => db.prepare(q))).catch((e) => { ready = null; throw e; });
  return ready;
}

async function loadJournal(db, rev) {
  if (loaded && loaded.rev === rev) return; // nothing changed since this isolate last looked
  const { results } = await db.prepare('SELECT id, seq, body FROM docs').all();
  store.load(implode(results));
  const snapshot = new Map(results.map((r) => [r.id, { seq: r.seq, body: r.body }]));
  loaded = { rev, snapshot };
}

async function saveJournal(db) {
  const next = explode(store.getState(), loaded.snapshot);
  const upserts = []; const deletes = [];
  for (const [id, d] of next) { const p = loaded.snapshot.get(id); if (!p || p.body !== d.body || p.seq !== d.seq) upserts.push({ id, seq: d.seq, body: d.body }); }
  for (const id of loaded.snapshot.keys()) if (!next.has(id)) deletes.push(id);
  if (!upserts.length && !deletes.length) return;
  const rev = String(Date.now()) + Math.random().toString(36).slice(2, 6);
  const stmts = [
    ...chunk(upserts).map((c) => db.prepare("INSERT OR REPLACE INTO docs (id, seq, body) SELECT json_extract(value, '$.id'), json_extract(value, '$.seq'), json_extract(value, '$.body') FROM json_each(?)").bind(JSON.stringify(c))),
    ...chunk(deletes).map((c) => db.prepare('DELETE FROM docs WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(c))),
    db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('rev', ?)").bind(rev),
  ];
  await db.batch(stmts); // one transaction
  loaded = { rev, snapshot: next };
}

// ---------- password login (signed cookie) ----------
const enc = new TextEncoder();
async function hmac(secret, text) {
  const key = await crypto.subtle.importKey('raw', enc.encode('tradequest|' + secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const safeEqual = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
const getCookie = (req, name) => (req.headers.get('Cookie') || '').split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === name)?.[1];

async function isAuthed(req, env) {
  const v = getCookie(req, COOKIE); if (!v) return false;
  const [exp, sig] = v.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEqual(sig, await hmac(env.APP_PASSWORD, exp));
}
async function authCookie(env) {
  const exp = String(Date.now() + SESSION_DAYS * 86400000);
  return `${COOKIE}=${exp}.${await hmac(env.APP_PASSWORD, exp)}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`;
}

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });

async function readBody(req) {
  const len = Number(req.headers.get('Content-Length') || 0);
  if (len > 50 * 1024 * 1024) throw new store.HttpError('Request too large', 413);
  const text = await req.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new store.HttpError('Invalid JSON'); }
}

export default {
  // Every minute in market hours (see wrangler.toml): move paper orders along even when no page is open.
  async scheduled(event, env, ctx) {
    if (!env.DB) return;
    const db = env.DB; await setup(db);
    const row = await db.prepare("SELECT value FROM kv WHERE key = 'kite-session'").first();
    const storage = { get: async () => (row ? JSON.parse(row.value) : null), put: async () => {}, del: async () => {} };
    const kite = createKite({ apiKey: env.KITE_API_KEY, apiSecret: env.KITE_API_SECRET, storage, mock: /^(1|true|yes)$/i.test(env.KITE_MOCK || ''), clientSearch: true, getTrades: () => [] });
    await kite.init();
    if (!kite.status().connected) return;
    const cache = {
      get: async (k) => { const r = await db.prepare('SELECT value FROM kv WHERE key = ?').bind('cache|' + k).first(); return r ? JSON.parse(r.value) : null; },
      put: (k, v) => db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').bind('cache|' + k, JSON.stringify(v)).run(),
    };
    ctx.waitUntil(paperCron({ kite, cache }).catch((e) => console.error('paper cron', e)));
  },
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      if (!env.DB) return json({ error: 'D1 database binding "DB" is missing — see docs/CLOUDFLARE.md' }, 500);
      if (!env.APP_PASSWORD || env.APP_PASSWORD.length < 8) return json({ error: 'Set an APP_PASSWORD secret (8+ characters) — see docs/CLOUDFLARE.md', code: 'NO_PASSWORD' }, 500);

      // ---- login ----
      if (url.pathname === '/api/auth/status') return json({ required: true, authed: await isAuthed(req, env) });
      if (url.pathname === '/api/auth/login' && req.method === 'POST') {
        const { password } = await readBody(req);
        const ok = typeof password === 'string' && safeEqual(await hmac(env.APP_PASSWORD, 'pw|' + password), await hmac(env.APP_PASSWORD, 'pw|' + env.APP_PASSWORD));
        if (!ok) { await new Promise((r) => setTimeout(r, 800)); return json({ error: 'Wrong password' }, 401); }
        return json({ ok: true }, 200, { 'Set-Cookie': await authCookie(env) });
      }
      if (url.pathname === '/api/auth/logout' && req.method === 'POST') return json({ ok: true }, 200, { 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` });
      if (!(await isAuthed(req, env))) {
        // Zerodha's redirect after Kite login lands here; send them to log in first.
        if (url.pathname === '/api/kite/callback') return Response.redirect(url.origin + '/#/settings?kite=error&msg=' + encodeURIComponent('Log in to TradeQuest first, then connect Kite again'), 302);
        return json({ error: 'Please log in', code: 'AUTH' }, 401);
      }

      const db = env.DB;
      await setup(db);

      // Kite pass-through requests don't touch the journal: answer them straight away,
      // outside the journal queue (breadth building sends ~1,000 of these).
      // The Nifty P/E fetch (up to ~28 calls to NSE the first time) goes this way too.
      // Paper trading too: it keeps its own account in kv and polls every couple of seconds.
      // Instrument lists change once a day: keep each day's copy in Cloudflare's edge cache,
      // so Kite (which rate-limits these downloads) is asked about once a day per list.
      const edgeKey = url.pathname.startsWith('/api/kite/instruments/') ? new Request(`https://tq-edge-cache${url.pathname}?d=${new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10)}`) : null;
      if (edgeKey) { const hit = await caches.default.match(edgeKey).catch(() => null); if (hit) return hit; }
      if (['/api/kite/raw-candles', '/api/kite/tokens', '/api/valuation'].includes(url.pathname) || url.pathname.startsWith('/api/kite/instruments/') || url.pathname.startsWith('/api/paper')) {
        const row = await db.prepare("SELECT value FROM kv WHERE key = 'kite-session'").first();
        const storage = { get: async () => (row ? JSON.parse(row.value) : null), put: async () => {}, del: (k) => db.prepare('DELETE FROM kv WHERE key = ?').bind(k).run() };
        const kite = createKite({ apiKey: env.KITE_API_KEY, apiSecret: env.KITE_API_SECRET, storage, mock: /^(1|true|yes)$/i.test(env.KITE_MOCK || ''), clientSearch: true, getTrades: () => [] });
        await kite.init();
        const body0 = req.method === 'POST' || req.method === 'PUT' ? await readBody(req) : {};
        const kvCache = url.pathname === '/api/valuation' || url.pathname.startsWith('/api/paper') ? {
          get: async (k) => { const r = await db.prepare('SELECT value FROM kv WHERE key = ?').bind('cache|' + k).first(); return r ? JSON.parse(r.value) : null; },
          put: (k, v) => db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').bind('cache|' + k, JSON.stringify(v)).run(),
        } : { get: async () => null, put: async () => {} };
        const hit = await createApi({ store, kite, cache: kvCache, hosted: true })({ method: req.method, pathname: url.pathname, url, body: async () => body0 });
        const out = hit?.result;
        if (out?.response) {
          const resp = new Response(out.response.body, { status: out.response.status, headers: { 'Content-Type': out.response.headers.get('content-type') || 'text/plain; charset=utf-8', 'Cache-Control': 'private, max-age=3600' } });
          if (edgeKey && resp.ok) { const copy = new Response(resp.clone().body, { headers: { 'Content-Type': resp.headers.get('content-type'), 'Cache-Control': 'public, max-age=43200' } }); await caches.default.put(edgeKey, copy).catch(() => {}); }
          return resp;
        }
        return json(out ?? { error: 'Unknown API route' }, out ? 200 : 404);
      }

      const body = req.method === 'GET' || req.method === 'HEAD' ? null : await readBody(req);

      return await serial(async () => {
        const kvRows = (await db.prepare("SELECT key, value FROM kv WHERE key IN ('rev', 'kite-session')").all()).results;
        const kvMap = Object.fromEntries(kvRows.map((r) => [r.key, r.value]));
        await loadJournal(db, kvMap.rev || '0');

        const storage = {
          get: async (k) => (k === 'kite-session' ? (kvMap[k] ? JSON.parse(kvMap[k]) : null) : null),
          put: (k, v) => db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').bind(k, JSON.stringify(v)).run(),
          del: (k) => db.prepare('DELETE FROM kv WHERE key = ?').bind(k).run(),
        };
        const cache = {
          get: async (k) => { const r = await db.prepare('SELECT value FROM kv WHERE key = ?').bind('cache|' + k).first(); return r ? JSON.parse(r.value) : null; },
          put: (k, v) => db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').bind('cache|' + k, JSON.stringify(v)).run(),
        };
        const mock = /^(1|true|yes)$/i.test(env.KITE_MOCK || '');
        const kite = createKite({ apiKey: env.KITE_API_KEY, apiSecret: env.KITE_API_SECRET, storage, mock, clientSearch: true, getTrades: () => store.getState().trades });
        await kite.init();

        let dirty = false;
        store.setSaver(() => { dirty = true; });
        const handle = createApi({ store, kite, cache, hosted: true });
        let hit;
        try {
          hit = await handle({ method: req.method, pathname: url.pathname, url, body: async () => body || {} });
        } finally {
          if (dirty) await saveJournal(db);
        }
        if (!hit) return json({ error: 'Unknown API route' }, 404);
        const out = hit.result;
        if (out?.redirect) return Response.redirect(new URL(out.redirect, url.origin).toString(), 302);
        if (out?.response) return new Response(out.response.body, { status: out.response.status, headers: { 'Content-Type': out.response.headers.get('content-type') || 'text/plain; charset=utf-8', 'Cache-Control': 'private, max-age=3600' } });
        if (out?.json !== undefined && out.headers) return json(out.json, 200, out.headers);
        return json(out);
      });
    } catch (e) {
      // A failed change may have left the in-memory journal ahead of D1: reload next time.
      loaded = null;
      const status = e.status || 500;
      if (status >= 500) console.error(e);
      return json({ error: e.message, code: e.code }, status);
    }
  },
};

// Exported for tests.
export const _internal = { explode, implode, chunk };
