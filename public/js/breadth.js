// Market breadth: built once in the browser from every Nifty 500 member's daily candles
// (fetched through the server, paced to Kite's 3-requests-a-second limit), then stored
// on the server and reused by every practice replay.
import { NIFTY500, NIFTY500_AS_OF, NIFTY50 } from '../data/indices.js';
import { addStockToBreadth, finishBreadth, intradayBreadth } from '../market.js';
import { clientSearch, listFor } from './kiteinst.js';
import { S, api } from './state.js';

const DAY = 86400000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const members500 = () => { const l = S.state?.settings?.indexLists; return l?.nifty500?.length ? l.nifty500 : NIFTY500; };
export const members500AsOf = () => S.state?.settings?.indexLists?.nifty500AsOf || NIFTY500_AS_OF;
export const members50 = () => { const l = S.state?.settings?.indexLists; return l?.nifty50?.length ? l.nifty50 : NIFTY50; };

/** The stored breadth history (loaded once per page). */
export async function loadBreadth(force = false) {
  if (S.breadth && !force) return S.breadth;
  try { S.breadth = await api('/api/breadth'); } catch { S.breadth = { dates: [] }; }
  return S.breadth;
}

async function tokensFor(symbols) {
  if (clientSearch()) {
    const list = await listFor('NSE');
    const by = new Map(list.map((i) => [i.s, i.k]));
    return Object.fromEntries(symbols.map((s) => [s, by.get(s) ?? null]));
  }
  return (await api('/api/kite/tokens', { method: 'POST', body: { exchange: 'NSE', symbols } })).tokens;
}

/** Candles [[ms, o, h, l, c, v]] for one token, retrying politely when Kite says "slow down". */
export async function rawCandles(token, interval, from, to) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`/api/kite/raw-candles?token=${token}&interval=${interval}&from=${new Date(from).toISOString()}&to=${new Date(to).toISOString()}`);
    const j = await res.json().catch(() => ({}));
    if (res.status === 429 || /too many/i.test(j.message || j.error || '')) { await sleep(1200 * (attempt + 1)); continue; }
    if (!res.ok || j.status === 'error') { const e = new Error(j.message || j.error || `HTTP ${res.status}`); e.code = j.code || j.error_type; throw e; }
    return (j.data?.candles || []).map((c) => [Date.parse(String(c[0]).replace(/([+-]\d\d)(\d\d)$/, '$1:$2')), c[1], c[2], c[3], c[4], c[5]]);
  }
  throw new Error('Kite kept saying "too many requests"');
}

/** Build (or rebuild) Nifty 500 breadth. `spans` × ~5½ years of daily candles (one Kite request each per stock). */
export async function buildBreadth(spans, onProgress = () => {}) {
  if (S.breadthJob?.running) throw new Error('Already building');
  const job = (S.breadthJob = { running: true, done: 0, total: 0, failed: [], cancel: false });
  try {
    const syms = members500();
    const tokens = await tokensFor(syms);
    const to = Date.now();
    // Kite returns at most 2,000 days of daily candles per request; the first ~300 days only
    // warm up the 200-day average, so each span adds about 5½ years of usable breadth.
    const from = to - spans * 1995 * DAY;
    const chunks = []; for (let a = from; a < to; a += 1995 * DAY) chunks.push([a, Math.min(to, a + 1995 * DAY)]);
    const years = Math.round(((to - from) / DAY - 300) / 365);
    job.total = syms.length;
    const pace = S.kite.mock ? 0 : 360; // Kite allows ~3 historical requests a second
    const days = {};
    for (const s of syms) {
      if (job.cancel) throw new Error('Cancelled');
      const tok = tokens[s];
      if (!tok) { job.failed.push(s); job.done++; onProgress(job); continue; }
      try {
        const closes = [];
        for (const [a, b] of chunks) {
          const t0 = Date.now();
          for (const c of await rawCandles(tok, 'day', a, b)) { const d = new Date(c[0] + 330 * 60000).toISOString().slice(0, 10); if (!closes.length || closes.at(-1)[0] < d) closes.push([d, c[4]]); }
          const wait = pace - (Date.now() - t0); if (wait > 0) await sleep(wait);
        }
        if (closes.length) addStockToBreadth(days, closes); else job.failed.push(s);
      } catch (e) {
        if (e.code === 'TOKEN' || e.code === 'TokenException' || e.code === 'NOT_CONNECTED') throw e;
        job.failed.push(s);
      }
      job.done++; job.symbol = s; onProgress(job);
    }
    // Drop the warm-up days (before the 200-day average exists for most stocks).
    const all = finishBreadth(days);
    const cut = Math.max(0, all.dates.findIndex((d) => d >= new Date(from + 300 * DAY).toISOString().slice(0, 10)));
    const keep = (arr) => arr.slice(cut);
    const result = { index: 'NIFTY 500', membersAsOf: members500AsOf(), members: syms.length, missing: job.failed, built: new Date().toISOString(), years, spans,
      dates: keep(all.dates), adv: keep(all.adv), dec: keep(all.dec), unch: keep(all.unch), a50: keep(all.a50), n50: keep(all.n50), a200: keep(all.a200), n200: keep(all.n200) };
    await api('/api/breadth', { method: 'PUT', body: result });
    S.breadth = result;
    return result;
  } finally { job.running = false; }
}

/** Nifty 50 breadth bar by bar for an intraday replay (≈50 requests, ~20 s the first time). */
export async function nifty50Intraday(interval, times, onProgress = () => {}) {
  const key = `${interval}|${times[0]}|${times.at(-1)}`;
  S._n50 ||= {};
  if (S._n50[key]) return S._n50[key];
  const syms = members50();
  const tokens = await tokensFor(syms);
  const from = times[0] - 5 * DAY; const to = times.at(-1) + DAY;
  const pace = S.kite.mock ? 0 : 360;
  const stocks = {}; let done = 0;
  for (const s of syms) {
    const t0 = Date.now();
    if (tokens[s]) { try { stocks[s] = await rawCandles(tokens[s], interval, from, to); } catch (e) { if (e.code === 'TOKEN') throw e; } }
    onProgress(++done, syms.length);
    const wait = pace - (Date.now() - t0); if (wait > 0) await sleep(wait);
  }
  return (S._n50[key] = intradayBreadth(stocks, times));
}

/** Parse NSE's index-members CSV (has a "Symbol" column). */
export function parseMembersCsv(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const head = lines[0].split(',').map((h) => h.trim().replace(/"/g, '').toLowerCase());
  const k = head.indexOf('symbol');
  if (k < 0) throw new Error('No "Symbol" column — download the list from niftyindices.com (Index constituents → CSV).');
  return [...new Set(lines.slice(1).map((l) => (l.split(',')[k] || '').replace(/"/g, '').trim().toUpperCase()).filter(Boolean))];
}
