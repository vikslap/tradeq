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
  const res = await fetch(url);
  if (!res.ok) { const j = await res.json().catch(() => ({})); const e = new Error(j.error || `Instrument list failed (HTTP ${res.status})`); e.code = j.code; throw e; }
  if (cache) { try { await cache.put(url, res.clone()); } catch { /* quota */ } }
  return res.text();
}

export function listFor(ex) {
  if (lists[ex]) return Promise.resolve(lists[ex]);
  return (loading[ex] ||= fetchCsv(ex).then((csv) => (lists[ex] = parseExchange(ex, csv))).finally(() => { delete loading[ex]; }));
}

export async function searchLocal(q) {
  const all = (await Promise.all(INSTRUMENT_EXCHANGES.map(listFor))).flat();
  return searchInstruments(all, q);
}

/** "&token=…" for candle requests when the browser does the instrument lookup, else "". */
export async function tokenParam(exchange, symbol) {
  if (!enabled || !INSTRUMENT_EXCHANGES.includes(exchange)) return '';
  const hit = (await listFor(exchange)).find((i) => i.s === symbol);
  return hit ? `&token=${hit.k}` : '';
}
