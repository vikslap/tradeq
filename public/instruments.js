// Kite instrument master: CSV parsing and symbol search. Shared by the local
// server and the browser (the hosted version searches in the browser, because
// the full list is too big to parse inside a Cloudflare Worker on every request).

export const INSTRUMENT_EXCHANGES = ['NSE', 'BSE', 'NFO', 'BFO', 'MCX'];

export function segmentFor(exchange, type, symbol = '') {
  if (exchange === 'NSE' || exchange === 'BSE') return 'EQ';
  if (exchange === 'CDS') return 'CUR';
  const t = type || (/FUT$/.test(symbol) ? 'FUT' : /(CE|PE)$/.test(symbol) ? 'CE' : 'FUT');
  if (t === 'CE' || t === 'PE') return 'OPT';
  return exchange === 'MCX' ? 'COM' : 'FUT';
}

function splitCsvLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

export function parseInstruments(csv) {
  const lines = csv.split(/\r?\n/).filter(Boolean);
  const head = splitCsvLine(lines[0]);
  const ix = (k) => head.indexOf(k);
  const [K, S, N, E, T, L, X, TS] = ['instrument_token', 'tradingsymbol', 'name', 'exchange', 'instrument_type', 'lot_size', 'expiry', 'tick_size'].map(ix);
  return lines.slice(1).map((l) => {
    const c = splitCsvLine(l);
    return { k: Number(c[K]), s: c[S], n: c[N], e: c[E], t: c[T], l: Number(c[L]) || 1, x: c[X] || '', ts: TS >= 0 ? Number(c[TS]) || 0.05 : 0.05 };
  });
}

const EX_RANK = { NSE: 0, NFO: 1, MCX: 2, BSE: 3, BFO: 4 };
export function searchInstruments(list, q, limit = 15) {
  const Q = String(q || '').toUpperCase().trim();
  if (!Q) return [];
  const hits = [];
  for (const i of list) {
    const s = i.s; const n = (i.n || '').toUpperCase();
    let score;
    if (s === Q) score = 0;
    else if (s.startsWith(Q)) score = 1;
    else if (n.startsWith(Q)) score = 2;
    else if (s.includes(Q)) score = 3;
    else if (n.includes(Q)) score = 4;
    else continue;
    // Prefer cash & futures over the long tail of option strikes.
    if (i.t === 'CE' || i.t === 'PE') score += 2;
    hits.push({ i, score });
  }
  hits.sort((a, b) => a.score - b.score || (EX_RANK[a.i.e] ?? 9) - (EX_RANK[b.i.e] ?? 9) || (a.i.x || '').localeCompare(b.i.x || '') || a.i.s.length - b.i.s.length);
  return hits.slice(0, limit).map(({ i }) => ({
    symbol: i.s, exchange: i.e, name: i.n, type: i.t, lotSize: i.l, expiry: i.x || null, segment: segmentFor(i.e, i.t, i.s), token: i.k || null, tickSize: i.ts || 0.05,
  }));
}

/** Parse one exchange's CSV as the app keeps it (BSE: cash equity only). */
// BFO: index futures only (Sensex, Bankex) — the option strikes would be a huge download for nothing.
export const parseExchange = (ex, csv) => parseInstruments(String(csv)).filter((i) => !(ex === 'BSE' && i.t !== 'EQ') && !((ex === 'BFO' || ex === 'CDS') && i.t !== 'FUT'));

/** The contract to follow for a futures series: the nearest expiry, rolling to the next one 2 days before expiry. */
export function currentContract(list, name, today, rollDays = 2) {
  const roll = new Date(Date.parse(`${today}T00:00:00Z`) + rollDays * 86400000).toISOString().slice(0, 10);
  const fut = list.filter((i) => i.n === name && i.t === 'FUT' && i.x && i.x >= today).sort((a, b) => a.x.localeCompare(b.x));
  return fut.find((i) => i.x > roll) || fut[0] || null;
}
