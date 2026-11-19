// Zerodha funds ledger (Console → Funds → Statement → Ledger, CSV): parsing,
// categories, money in/out, account fees, and the "same money in an index fund"
// comparison. Shared by the browser and the tests.

const splitCsvLine = (line) => {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
};

/** Parse one ledger CSV. Opening/closing balance rows are skipped. */
export function parseLedger(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const head = splitCsvLine(lines[0] || '').map((h) => h.trim().toLowerCase());
  const col = (n) => head.indexOf(n);
  const c = { p: col('particulars'), d: col('posting_date'), cc: col('cost_center'), vt: col('voucher_type'), dr: col('debit'), cr: col('credit'), bal: col('net_balance') };
  if (c.p < 0 || c.d < 0 || c.dr < 0 || c.cr < 0) throw new Error("This doesn't look like a Zerodha ledger CSV (needs particulars, posting_date, debit, credit). Download it from Console → Funds → Statement → Ledger.");
  const rows = [];
  for (const line of lines.slice(1)) {
    const r = splitCsvLine(line);
    const date = (r[c.d] || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue; // opening / closing balance rows
    rows.push({
      date, particulars: (r[c.p] || '').trim(), costCenter: (r[c.cc] || '').trim(), voucher: (r[c.vt] || '').trim(),
      debit: Number(r[c.dr]) || 0, credit: Number(r[c.cr]) || 0, balance: c.bal >= 0 && r[c.bal] !== '' ? Number(r[c.bal]) : null,
    });
  }
  return rows;
}

/** Same entry in two downloads → same key (used to skip duplicates when files overlap). */
export const ledgerKey = (r) => [r.date, r.particulars, r.debit.toFixed(4), r.credit.toFixed(4), r.balance == null ? '' : r.balance.toFixed(4)].join('|');

export const CATEGORIES = {
  deposit: 'Money added', withdrawal: 'Money withdrawn', equity: 'Equity settlement', fno: 'F&O / commodity',
  mf: 'Mutual fund (Coin)', bonds: 'SGB / G-Sec', margin: 'Margin block/release', fee: 'Account fees',
};

export function categorise(r) {
  const p = r.particulars.toLowerCase();
  if (p.startsWith('funds added')) return 'deposit';
  if (/^(instant )?payout|funds transferred back|funds auto-settled|pay out done/.test(p)) return 'withdrawal';
  if (/margin (blocked|reversed)/.test(p)) return 'margin';
  if (/mf redemption|^investment in |^mf purchase/.test(p) || /^STARMF/.test(r.costCenter)) return 'mf';
  if (/funds blocked for (sgb|government)|government securities purchase price|^sgb/.test(p)) return 'bonds';
  if (p.startsWith('net settlement')) return 'equity';
  if (p.startsWith('net obligation')) return 'fno';
  return 'fee';
}

export const FEE_KINDS = { dp: 'DP charges (delivery sells)', amc: 'Demat AMC', gateway: 'Payment gateway', late: 'Late payment interest', squareoff: 'Auto square-off (call & trade)', subs: 'Subscriptions', pledge: 'Pledge / margin', other: 'Other' };
export function feeKind(r) {
  const p = r.particulars.toLowerCase();
  if (p.includes('dp charges') || p.startsWith('charges for sale')) return 'dp';
  if (p.includes('amc')) return 'amc';
  if (p.includes('payment gateway')) return 'gateway';
  if (p.includes('delayed payment')) return 'late';
  if (p.includes('call and trade') || p.includes('auto square')) return 'squareoff';
  if (/subscription|tickertape|stockreports|tijori|smallcase|sensibull|streak/.test(p)) return 'subs';
  if (/pledge|excess collateral|margin shortfall/.test(p)) return 'pledge';
  return 'other';
}

/** Indian financial year label for a YYYY-MM-DD date: 2025-04-01 → "FY25-26". */
export function fyOf(date) {
  const y = Number(date.slice(0, 4)); const m = Number(date.slice(5, 7));
  const s = m >= 4 ? y : y - 1;
  return `FY${String(s % 100).padStart(2, '0')}-${String((s + 1) % 100).padStart(2, '0')}`;
}

/** Ledger entries in posting order (date, then the order they appeared). */
export const sortLedger = (rows) => [...rows].sort((a, b) => a.date.localeCompare(b.date) || (a.seq ?? 0) - (b.seq ?? 0));

/** Per financial year: money in/out and account fees (by kind). */
export function ledgerByYear(rows) {
  const years = {};
  for (const r of rows) {
    const fy = fyOf(r.date);
    const y = (years[fy] ||= { fy, deposits: 0, withdrawals: 0, fees: 0, feeKinds: {} });
    const cat = categorise(r);
    if (cat === 'deposit') y.deposits += r.credit - r.debit;
    else if (cat === 'withdrawal') y.withdrawals += r.debit - r.credit;
    else if (cat === 'fee') { const amt = r.debit - r.credit; y.fees += amt; const k = feeKind(r); y.feeKinds[k] = (y.feeKinds[k] || 0) + amt; }
  }
  return Object.values(years).sort((a, b) => a.fy.localeCompare(b.fy));
}

/** Money you moved in (+) and out (−) of Zerodha, by date. */
export function cashFlows(rows) {
  const out = [];
  for (const r of rows) {
    const cat = categorise(r);
    if (cat === 'deposit') out.push({ date: r.date, amount: r.credit - r.debit });
    else if (cat === 'withdrawal') out.push({ date: r.date, amount: -(r.debit - r.credit) });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** Cash left in the account per the latest ledger entry. */
export function ledgerCash(rows) {
  const s = sortLedger(rows).filter((r) => r.balance != null);
  return s.length ? { amount: s.at(-1).balance, date: s.at(-1).date } : null;
}

/**
 * Put every deposit into an index fund on the same day (and take every withdrawal
 * out of it) — what would that be worth now?
 * nav: [[YYYY-MM-DD, nav], …] ascending. Returns weekly points for a chart.
 */
export function shadowPortfolio(flows, nav, today = new Date().toISOString().slice(0, 10)) {
  if (!flows.length || !nav.length) return null;
  const navOn = (d) => { // last NAV on or before d (or the first one after, before the data starts)
    let lo = 0; let hi = nav.length - 1; let best = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (nav[mid][0] <= d) { best = mid; lo = mid + 1; } else hi = mid - 1; }
    return nav[Math.max(best, 0)][1];
  };
  let units = 0; let invested = 0; let i = 0;
  const points = [];
  const start = new Date(flows[0].date + 'T00:00:00Z');
  const end = new Date(today + 'T00:00:00Z');
  for (let d = new Date(start); d <= end; d = new Date(d.getTime() + 7 * 86400000)) {
    const ds = d.toISOString().slice(0, 10);
    while (i < flows.length && flows[i].date <= ds) { units += flows[i].amount / navOn(flows[i].date); invested += flows[i].amount; i++; }
    points.push({ date: ds, invested, value: units * navOn(ds) });
  }
  while (i < flows.length) { units += flows[i].amount / navOn(flows[i].date); invested += flows[i].amount; i++; }
  const value = units * navOn(today);
  if (points.at(-1)?.date !== today) points.push({ date: today, invested, value });
  return { value, invested, points, navDate: nav.at(-1)[0] };
}
