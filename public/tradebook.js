// Zerodha Console tradebook import: parse the CSV, pair fills into trades, and
// work out what to do with each one against the existing journal.

// ---------- CSV ----------
function splitCsvLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const norm = (h) => h.toLowerCase().replace(/^﻿/, '').trim().replace(/[\s.]+/g, '_');

/** Parse tradebook text into fills. Throws with a friendly message if the file isn't a tradebook. */
export function parseTradebook(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const hi = lines.findIndex((l) => { const h = splitCsvLine(l).map(norm); return h.includes('symbol') && h.includes('trade_type'); });
  if (hi < 0) throw new Error("This doesn't look like a Zerodha tradebook CSV (no 'symbol' / 'trade_type' columns). Download it from Console → Reports → Tradebook as CSV.");
  const head = splitCsvLine(lines[hi]).map(norm);
  const col = (...names) => names.map((n) => head.indexOf(n)).find((i) => i >= 0) ?? -1;
  const c = {
    symbol: col('symbol', 'tradingsymbol'), exchange: col('exchange'), segment: col('segment'), type: col('trade_type'),
    qty: col('quantity', 'qty'), price: col('price'), date: col('trade_date', 'date'), time: col('order_execution_time', 'execution_time'),
    id: col('trade_id'), order: col('order_id'), expiry: col('expiry_date'),
  };
  const fills = [];
  for (const line of lines.slice(hi + 1)) {
    const r = splitCsvLine(line);
    const symbol = (r[c.symbol] || '').toUpperCase().replace(/\s+/g, '');
    const side = (r[c.type] || '').toUpperCase();
    const qty = Math.abs(Number(r[c.qty]));
    const price = Number(r[c.price]);
    if (!symbol || !['BUY', 'SELL'].includes(side) || !(qty > 0) || !(price > 0)) continue;
    const seg = (r[c.segment] || '').toUpperCase();
    const exchange = exchangeOf((r[c.exchange] || '').toUpperCase(), seg, symbol);
    const expiry = /^\d{4}-\d{2}-\d{2}/.test(String(r[c.expiry] || '').trim()) ? String(r[c.expiry]).trim().slice(0, 10) : null;
    const time = parseTime(r[c.time], r[c.date]);
    if (!time) continue;
    fills.push({ id: r[c.id] || `${symbol}-${time}-${side}-${qty}-${price}`, orderId: r[c.order] || '', symbol, exchange, side, qty, price, time, expiry });
  }
  if (!fills.length) throw new Error('No trades found in this file.');
  return fills;
}

/** Console times are IST without an offset; dates may be yyyy-mm-dd or dd-mm-yyyy. */
function parseTime(execTime, date) {
  const fix = (d) => { const m = String(d || '').trim().match(/^(\d{2})[-/](\d{2})[-/](\d{4})(.*)$/); return m ? `${m[3]}-${m[2]}-${m[1]}${m[4]}` : String(d || '').trim(); };
  let s = fix(execTime);
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) { const d = fix(date); if (!/^\d{4}-\d{2}-\d{2}/.test(d)) return null; s = `${d.slice(0, 10)}T09:15:00`; }
  s = s.replace(' ', 'T');
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) s += '+05:30';
  const t = new Date(s);
  return isNaN(t) ? null : t.toISOString();
}

// ---------- helpers ----------
/** Futures (…26NOVFUT) and options (…26N1723400CE, …26NOV23400PE) by symbol shape. */
export const isDerivative = (symbol) => /\d{2}[A-Z]{3}FUT$/.test(symbol) || /\d(CE|PE)$/.test(symbol);

/**
 * Console lists F&O and commodity trades with exchange "NSE"/"BSE"/"MCX" plus a
 * segment column (EQ / FO / COM / CDS). Map to Kite's exchange codes.
 */
export function exchangeOf(exchange, seg, symbol) {
  if (seg === 'COM' || exchange === 'MCX') return 'MCX';
  if (seg === 'CDS' || exchange === 'CDS') return 'CDS';
  if (seg === 'FO' || exchange === 'NFO' || exchange === 'BFO' || isDerivative(symbol)) return exchange === 'BSE' || exchange === 'BFO' ? 'BFO' : 'NFO';
  return exchange === 'BSE' ? 'BSE' : 'NSE';
}

export const instKey = (exchange, symbol) => (exchange === 'NSE' || exchange === 'BSE' ? `EQ:${symbol}` : `${exchange}:${symbol}`);
export function segmentOf(exchange, symbol) {
  if (exchange === 'MCX') return /\d(CE|PE)$/.test(symbol) ? 'OPT' : 'COM';
  if (exchange === 'NFO' || exchange === 'BFO') return /\d(CE|PE)$/.test(symbol) ? 'OPT' : 'FUT';
  if (exchange === 'CDS') return 'CUR';
  return 'EQ';
}
const istDay = (iso) => new Date(new Date(iso).getTime() + 330 * 60000).toISOString().slice(0, 10);
const wavg = (fills) => fills.reduce((s, f) => s + f.qty * f.price, 0) / fills.reduce((s, f) => s + f.qty, 0);
const qsum = (fills) => fills.reduce((s, f) => s + f.qty, 0);

/** Same-day intraday horizon guess; matches the server's migration rule. */
export function guessHorizon(entryTime, exitTime, now = Date.now()) {
  if (exitTime && istDay(entryTime) === istDay(exitTime)) return 'INTRADAY';
  const end = exitTime ? new Date(exitTime).getTime() : now;
  return (end - new Date(entryTime).getTime()) / 86400000 <= 20 ? 'SWING' : 'POSITIONAL';
}

// ---------- pairing ----------
/**
 * Pair fills into trades per instrument. Adds to a position = one trade (scale-in);
 * the trade closes when the position returns to flat. A cash-equity sell with no
 * position that isn't bought back the same day is a sale of shares bought before the
 * file's date range ("orphan").
 */
export function buildTrips(fills) {
  const groups = {};
  for (const f of fills) (groups[instKey(f.exchange, f.symbol)] ||= []).push(f);
  const trips = []; const orphans = [];
  for (const [key, list] of Object.entries(groups)) {
    list.sort((a, b) => a.time.localeCompare(b.time) || String(a.id).localeCompare(String(b.id)));
    const isEq = key.startsWith('EQ:');
    const queue = list.map((f) => ({ ...f }));
    let cur = null;
    const finish = (c, status) => {
      const entryQty = qsum(c.entry); const exitQty = qsum(c.exit);
      const base = { key, symbol: c.entry[0].symbol, exchange: c.entry[0].exchange, segment: segmentOf(c.entry[0].exchange, c.entry[0].symbol), side: c.dir > 0 ? 'LONG' : 'SHORT', entryPrice: round(wavg(c.entry)), entryTime: c.entry[0].time };
      const expiry = c.entry.find((f) => f.expiry)?.expiry || null;
      base.expiry = expiry;
      if (status === 'CLOSED') return [{ ...base, status, qty: entryQty, exitPrice: round(wavg(c.exit)), exitTime: c.exit.at(-1).time, fillIds: [...c.entry, ...c.exit].map((f) => f.id) }];
      // Still open at the end of the file: split off any part already exited.
      const out = [];
      if (exitQty > 0) out.push({ ...base, status: 'CLOSED', qty: exitQty, exitPrice: round(wavg(c.exit)), exitTime: c.exit.at(-1).time, fillIds: c.exit.map((f) => f.id), partial: true });
      out.push({ ...base, status: 'OPEN', qty: entryQty - exitQty, fillIds: c.entry.map((f) => f.id) });
      return out;
    };
    while (queue.length) {
      const f = queue.shift(); const sgn = f.side === 'BUY' ? 1 : -1;
      if (!cur) {
        if (isEq && sgn < 0) {
          const coverQty = qsum(queue.filter((x) => x.side === 'BUY' && istDay(x.time) === istDay(f.time)));
          if (coverQty < f.qty) { orphans.push(f); continue; }
        }
        cur = { dir: sgn, entry: [f], exit: [], pos: sgn * f.qty };
        continue;
      }
      if (sgn === cur.dir) { cur.entry.push(f); cur.pos += sgn * f.qty; continue; }
      const closeQty = Math.min(f.qty, Math.abs(cur.pos));
      cur.exit.push({ ...f, qty: closeQty }); cur.pos += sgn * closeQty;
      if (cur.pos === 0) {
        trips.push(...finish(cur, 'CLOSED')); cur = null;
        if (f.qty > closeQty) queue.unshift({ ...f, qty: f.qty - closeQty, id: `${f.id}#r` });
      }
    }
    if (cur) trips.push(...finish(cur, 'OPEN'));
  }
  return { trips, orphans };
}
const round = (v) => Math.round(v * 100) / 100;

// ---------- matching against the journal ----------
/**
 * Decide what to do with each trip:
 *  - dateFixes: open journal trades → set real entry date/price from an open trip
 *  - closes:    open journal trades the tradebook shows as sold (orphan sells)
 *  - newTrades: trips not in the journal yet (closed history, or open positions not logged)
 *  - dupes:     trips already in the journal
 */
export function planImport(journal, fills, today = istDay(new Date().toISOString())) {
  const owner = new Map();
  for (const t of journal) for (const id of t.fillIds || []) owner.set(id, t);
  const fileIds = new Set(fills.map((f) => f.id));

  // Instruments that have new fills AND earlier *imported* trades built only from this
  // file's fills get re-paired from scratch: an earlier import may have paired them
  // wrongly (e.g. a short leg that was skipped), and patching around it can't fix that.
  const byKey = {};
  for (const f of fills) (byKey[instKey(f.exchange, f.symbol)] ||= []).push(f);
  const repairs = [];
  const repairKeys = new Set();
  for (const [key, list] of Object.entries(byKey)) {
    const fresh = list.filter((f) => !owner.has(f.id));
    const prior = [...new Set(list.filter((f) => owner.has(f.id)).map((f) => owner.get(f.id)))];
    if (!fresh.length || !prior.length) continue;
    // Also catch earlier imports stored under the cash-equity key before the F&O fix.
    const sameInst = journal.filter((t) => t.imported && t.symbol === list[0].symbol && (t.fillIds || []).some((id) => fileIds.has(id)));
    const olds = [...new Set([...prior, ...sameInst])];
    if (olds.every((t) => t.imported && (t.fillIds || []).every((id) => fileIds.has(id)))) {
      repairKeys.add(key);
      repairs.push({ key, symbol: list[0].symbol, replaces: olds, trips: [] });
    }
  }

  const known = new Set(owner.keys());
  const fresh = fills.filter((f) => repairKeys.has(instKey(f.exchange, f.symbol)) || !known.has(f.id));
  const alreadyImported = fills.length - fresh.length;
  const { trips: allTrips, orphans } = buildTrips(fresh);
  const replacedIds = new Set(repairs.flatMap((r) => r.replaces.map((t) => t.id)));
  journal = journal.filter((t) => !replacedIds.has(t.id));
  const trips = [];
  for (const trip of allTrips) {
    const r = repairs.find((x) => x.key === trip.key);
    if (!r) { trips.push(trip); continue; }
    if (trip.status === 'OPEN' && trip.expiry && trip.expiry < today) {
      const exitTime = new Date(`${trip.expiry}T15:30:00+05:30`).toISOString();
      r.trips.push({ ...trip, status: 'CLOSED', expired: true, exitPrice: trip.segment === 'OPT' ? 0 : null, exitTime, horizon: guessHorizon(trip.entryTime, exitTime) });
    } else r.trips.push({ ...trip, horizon: guessHorizon(trip.entryTime, trip.status === 'CLOSED' ? trip.exitTime : null) });
  }

  const openJ = journal.filter((t) => t.status === 'OPEN');
  const usedJ = new Set();
  const dateFixes = []; const newTrades = []; const dupes = [];

  for (const trip of trips) {
    if (trip.status === 'OPEN') {
      const j = openJ.find((t) => !usedJ.has(t.id) && instKey(t.exchange, t.symbol) === trip.key && t.side === trip.side);
      if (j) {
        usedJ.add(j.id);
        if (istDay(j.entryTime) !== istDay(trip.entryTime) || Math.abs(j.entryPrice - trip.entryPrice) > 0.01) {
          dateFixes.push({ trade: j, entryTime: trip.entryTime, entryPrice: trip.entryPrice, qty: trip.qty, qtyMatches: trip.qty === j.qty, fillIds: trip.fillIds });
        }
        continue;
      }
    } else {
      const dup = journal.find((t) => t.status === 'CLOSED' && instKey(t.exchange, t.symbol) === trip.key && t.side === trip.side && t.qty === trip.qty
        && istDay(t.entryTime) === istDay(trip.entryTime) && t.exitTime && istDay(t.exitTime) === istDay(trip.exitTime));
      if (dup) { dupes.push(trip); continue; }
    }
    // F&O contract still "open" in the file but already past expiry: it expired.
    // Options default to expiring worthless (editable); futures need the settlement price.
    if (trip.status === 'OPEN' && trip.expiry && trip.expiry < today) {
      const exitTime = new Date(`${trip.expiry}T15:30:00+05:30`).toISOString();
      newTrades.push({ ...trip, status: 'CLOSED', expired: true, exitPrice: trip.segment === 'OPT' ? 0 : null, exitTime, horizon: guessHorizon(trip.entryTime, exitTime) });
      continue;
    }
    newTrades.push({ ...trip, horizon: guessHorizon(trip.entryTime, trip.status === 'CLOSED' ? trip.exitTime : null) });
  }

  // Sells of shares bought before the file's range: close a matching open journal trade.
  const orphanKeys = {};
  for (const o of orphans) (orphanKeys[instKey(o.exchange, o.symbol)] ||= []).push(o);
  const closes = []; const unmatched = [];
  for (const [key, list] of Object.entries(orphanKeys)) {
    const qty = qsum(list);
    const j = openJ.find((t) => !usedJ.has(t.id) && instKey(t.exchange, t.symbol) === key && t.side === 'LONG');
    if (j && qty === j.qty) {
      usedJ.add(j.id);
      closes.push({ trade: j, exitPrice: round(wavg(list)), exitTime: list.at(-1).time, fillIds: list.map((f) => f.id) });
    } else unmatched.push({ key, symbol: list[0].symbol, qty, price: round(wavg(list)), last: list.at(-1).time, journalQty: j?.qty ?? null });
  }

  const times = fills.map((f) => f.time).sort();
  return { repairs, dateFixes, closes, newTrades, dupes, unmatched, alreadyImported, from: times[0], to: times.at(-1), fills: fills.length };
}
