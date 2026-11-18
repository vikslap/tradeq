// Zerodha charges, per executed order — as listed on zerodha.com/pricing (checked Nov 2026,
// after the Budget 2026 STT changes). Statutory charges are "levied at actuals", so a
// contract note can differ by a few paise from rounding; update RATES if they change.

const PCT = 0.01;
export const RATES_AS_OF = 'Nov 2026';

// rate tables: brokerage (pct with ₹20 cap, or flat), STT/CTT (pct, side), exchange txn (pct by exchange), stamp (pct, buy side)
export const RATES = {
  EQ_DELIVERY: { brokerage: { flat: 0 }, stt: { pct: 0.1, side: 'BOTH' }, txn: { NSE: 0.00307, BSE: 0.00375 }, stamp: 0.015 },
  EQ_INTRADAY: { brokerage: { pct: 0.03, cap: 20 }, stt: { pct: 0.025, side: 'SELL' }, txn: { NSE: 0.00307, BSE: 0.00375 }, stamp: 0.003 },
  FUT: { brokerage: { pct: 0.03, cap: 20 }, stt: { pct: 0.05, side: 'SELL' }, txn: { NFO: 0.00183, BFO: 0 }, stamp: 0.002 },
  OPT: { brokerage: { flat: 20 }, stt: { pct: 0.15, side: 'SELL' }, txn: { NFO: 0.03553, BFO: 0.0325 }, stamp: 0.003 },
  COM_FUT: { brokerage: { pct: 0.03, cap: 20 }, stt: { pct: 0.01, side: 'SELL' }, txn: { MCX: 0.0021, NSE: 0.0001 }, stamp: 0.002 },
  COM_OPT: { brokerage: { flat: 20 }, stt: { pct: 0.05, side: 'SELL' }, txn: { MCX: 0.0418, NSE: 0.001 }, stamp: 0.003 },
  CUR_FUT: { brokerage: { pct: 0.03, cap: 20 }, stt: null, txn: { CDS: 0.00035, NSE: 0.00035, BSE: 0.00045 }, stamp: 0.0001 },
  CUR_OPT: { brokerage: { flat: 20 }, stt: null, txn: { CDS: 0.0311, NSE: 0.0311, BSE: 0.001 }, stamp: 0.0001 },
};
const SEBI = 10 / 1e7;           // ₹10 per crore
const IPFT = 0.01 / 1e7;         // ₹0.01 per crore (NSE), + GST
const GST = 0.18;                // on brokerage + exchange txn + SEBI (+ IPFT)
export const DP_CHARGE = 15.34;  // per scrip per day on delivery sells, incl. GST

const r2 = (v) => Math.round(v * 100) / 100;
const istDay = (iso) => new Date(new Date(iso).getTime() + 330 * 60000).toISOString().slice(0, 10);

/** Which rate table applies to a trade (and, for cash equity, whether this part is intraday). */
export function rateKey(t, intraday) {
  if (t.segment === 'OPT') return t.exchange === 'MCX' ? 'COM_OPT' : t.exchange === 'CDS' ? 'CUR_OPT' : 'OPT';
  if (t.segment === 'FUT') return 'FUT';
  if (t.segment === 'COM') return /\d(CE|PE)$/.test(t.symbol || '') ? 'COM_OPT' : 'COM_FUT';
  if (t.segment === 'CUR') return /\d(CE|PE)$/.test(t.symbol || '') ? 'CUR_OPT' : 'CUR_FUT';
  return intraday ? 'EQ_INTRADAY' : 'EQ_DELIVERY';
}

/** Charges for one executed order. side: 'BUY' | 'SELL'; value = qty × price. */
export function orderCharges(key, exchange, side, value) {
  const R = RATES[key];
  const brokerage = R.brokerage.flat != null ? R.brokerage.flat : Math.min(R.brokerage.cap, value * R.brokerage.pct * PCT);
  const stt = R.stt && (R.stt.side === 'BOTH' || R.stt.side === side) ? value * R.stt.pct * PCT : 0;
  const txnRate = R.txn[exchange] ?? Object.values(R.txn)[0];
  const txn = value * txnRate * PCT;
  const sebi = value * SEBI;
  const ipft = exchange === 'NSE' || exchange === 'NFO' ? value * IPFT : 0;
  const stamp = side === 'BUY' ? value * R.stamp * PCT : 0;
  const gst = (brokerage + txn + sebi + ipft) * GST;
  const parts = { brokerage: r2(brokerage), stt: r2(stt), txn: r2(txn), sebi: r2(sebi), ipft: r2(ipft), stamp: r2(stamp), gst: r2(gst) };
  return { ...parts, total: r2(Object.values(parts).reduce((a, b) => a + b, 0)) };
}

/** Exits of a trade (supports older single-exit trades). */
export function exitsOf(t) {
  if (Array.isArray(t.exits) && t.exits.length) return t.exits;
  if (t.status === 'CLOSED' && t.exitPrice != null) return [{ qty: t.qty, price: t.exitPrice, time: t.exitTime }];
  return [];
}

/**
 * Charges on the realised part of a trade: the entry order(s) for the exited quantity
 * plus every exit order. Cash equity sold the same day it was bought is intraday;
 * otherwise delivery (with DP charges on each sell day).
 */
export function tradeCharges(t) {
  const exits = exitsOf(t);
  const zero = { brokerage: 0, stt: 0, txn: 0, sebi: 0, ipft: 0, stamp: 0, gst: 0, dp: 0, total: 0 };
  if (!exits.length || !t.qty || !t.entryPrice) return zero;
  const entrySide = t.side === 'SHORT' ? 'SELL' : 'BUY';
  const exitSide = entrySide === 'BUY' ? 'SELL' : 'BUY';
  const orders = Math.max(1, t.entryOrders || 1);
  const sum = { ...zero };
  const add = (c, share = 1) => { for (const k of Object.keys(c)) if (k !== 'total') sum[k] += c[k] * share; };
  const sellDays = new Set();
  for (const e of exits) {
    const intraday = t.horizon === 'INTRADAY' || (e.time && t.entryTime && istDay(e.time) === istDay(t.entryTime));
    const key = rateKey(t, intraday);
    // Entry: split the entry order(s) in proportion to the quantity this exit closes.
    const entryPerOrder = orderCharges(key, t.exchange, entrySide, (t.entryPrice * t.qty) / orders);
    add(entryPerOrder, orders * (e.qty / t.qty));
    add(orderCharges(key, t.exchange, exitSide, e.price * e.qty));
    if (key === 'EQ_DELIVERY' && exitSide === 'SELL' && e.time) sellDays.add(istDay(e.time));
  }
  sum.dp = sellDays.size * DP_CHARGE;
  for (const k of Object.keys(sum)) sum[k] = r2(sum[k]);
  sum.total = r2(Object.entries(sum).filter(([k]) => k !== 'total').reduce((a, [, v]) => a + v, 0));
  return sum;
}

export const CHARGE_LABELS = { brokerage: 'Brokerage', stt: 'STT / CTT', txn: 'Exchange txn', sebi: 'SEBI', ipft: 'IPFT', stamp: 'Stamp duty', gst: 'GST', dp: 'DP charges' };
