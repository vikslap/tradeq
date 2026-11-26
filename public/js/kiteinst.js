// Instrument search and tokens in the browser. Used by the hosted (Cloudflare)
// version, where the server passes Kite's instrument CSVs through and the browser
// parses and searches them. Each CSV is cached in the browser for the day.
import { INSTRUMENT_EXCHANGES, parseExchange, searchInstruments } from '../instruments.js';

let enabled = false;
export const setClientSearch = (on) => { enabled = Boolean(on); };
export const clientSearch = () => enabled;

const lists = {};
const loading = {};
const istDay = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

async function fetchCsv(ex) {
  const url = `/api/kite/instruments/${ex}?d=${istDay()}`;
  let cache = null;
  try {
    cache = await caches.open('tq-instruments');
    for (const k of await cache.keys()) if (!k.url.includes(`d=${istDay()}`)) cache.delete(k); // yesterday's lists
    const hit = await cache.match(url);
    if (hit) return hit.text();
  } catch { cache = null; /* Cache API unavailable (http:// on a LAN address) */ }
  // Kite rate-limits these downloads: on "too many requests" (429) wait and try again.
  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(url);
    const busy = res.status === 429 || (res.status === 502 && /429/.test(await res.clone().text().catch(() => '')));
    if (!busy || attempt >= 2) break;
    await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
  }
  if (!res.ok) { const j = await res.json().catch(() => ({})); const e = new Error(/429/.test(j.error || '') ? 'Kite is busy (too many requests) — try the search again in a few seconds' : j.error || `Instrument list failed (HTTP ${res.status})`); e.code = j.code; throw e; }
  if (cache) { try { await cache.put(url, res.clone()); } catch { /* quota */ } }
  return res.text();
}

export function listFor(ex) {
  if (lists[ex]) return Promise.resolve(lists[ex]);
  return (loading[ex] ||= fetchCsv(ex).then((csv) => (lists[ex] = parseExchange(ex, csv))).finally(() => { delete loading[ex]; }));
}

// Load the exchange lists one after another (in parallel Kite answers 429).
let queue = Promise.resolve();
const failedAt = {};
const listQueued = (ex) => {
  if (lists[ex]) return Promise.resolve(lists[ex]);
  if (Date.now() - (failedAt[ex] || 0) < 60000) return Promise.reject(new Error(`${ex} list unavailable for now`)); // don't hammer Kite
  return (queue = queue.catch(() => {}).then(() => listFor(ex)).catch((e) => { failedAt[ex] = Date.now(); throw e; }));
};
// Search whichever lists loaded; only fail when none did. NSE first, so stocks work soonest.
export async function searchLocal(q) {
  const all = []; const failed = []; let lastErr = null;
  for (const ex of INSTRUMENT_EXCHANGES) {
    try { all.push(...await listQueued(ex)); } catch (e) { failed.push(ex); lastErr = e; }
  }
  if (!all.length && lastErr) throw lastErr;
  const hits = searchInstruments(all, q);
  hits.missing = failed; // the page can say "MCX list didn't load"
  return hits;
}

/** "&token=…" for candle requests when the browser does the instrument lookup, else "". */
export async function tokenParam(exchange, symbol) {
  if (!enabled || !INSTRUMENT_EXCHANGES.includes(exchange)) return '';
  const hit = (await listFor(exchange)).find((i) => i.s === symbol);
  return hit ? `&token=${hit.k}` : '';
}
