// Position sizing: how many shares/lots to buy so that, if the stop is hit, the loss —
// including slippage and every Zerodha charge — stays within your risk budget, while
// also respecting your max-position and total-open-risk rules.
import { tradeCharges } from './charges.js';

const DAY = 86400000;
const isOptionSym = (s) => /\d(CE|PE)$/.test(s || '');

/** Charges for opening at `entry` and closing everything at `exit`. */
export function roundTripCharges(p, qty, exit) {
  if (!qty) return 0;
  const t0 = new Date();
  const exitTime = new Date(t0.getTime() + (p.intraday ? 60000 : DAY)).toISOString();
  return tradeCharges({
    symbol: p.symbol, exchange: p.exchange, segment: p.segment, side: p.side, qty,
    entryPrice: p.entry, entryTime: t0.toISOString(), horizon: p.intraday ? 'INTRADAY' : 'SWING',
    status: 'CLOSED', exits: [{ qty, price: Math.max(0, exit), time: exitTime }],
  }).total;
}

/**
 * p: { symbol, exchange, segment, side, entry, stop, target, lotSize, intraday, slippagePct }
 * s: settings { capital, riskPctPerTrade, maxRiskPerTrade, maxPositionPct, maxPortfolioHeatPct }
 * openRisk: ₹ already at risk in open trades
 */
export function sizePosition(p, s, openRisk = 0) {
  const out = { qty: 0, lots: 0, errors: [], limits: [], warnings: [] };
  const lot = Math.max(1, Math.floor(Number(p.lotSize) || 1));
  const long = p.side !== 'SHORT';
  const dir = long ? 1 : -1;
  const capital = Number(s.capital) || 0;
  const entry = Number(p.entry);
  const stop = p.stop === '' || p.stop == null ? null : Number(p.stop);
  const target = p.target === '' || p.target == null ? null : Number(p.target);
  const premiumRisk = long && (p.segment === 'OPT' || (['COM', 'CUR'].includes(p.segment) && isOptionSym(p.symbol)));

  // Risk budget: % of capital, never above the fixed ₹ cap.
  const pctBudget = capital * (Number(s.riskPctPerTrade) || 0) / 100;
  const cap = Number(s.maxRiskPerTrade) || Infinity;
  out.budget = Math.min(pctBudget || cap, cap);
  out.budgetBy = pctBudget && pctBudget <= cap ? 'pct' : 'cap';
  if (!capital) out.errors.push('Set your capital in Settings first.');
  if (!(entry > 0)) out.errors.push('Enter an entry price.');
  if (!premiumRisk) {
    if (stop == null || !(stop >= 0)) out.errors.push('Enter a stop-loss — position size comes from the distance to it.');
    else if ((entry - stop) * dir <= 0) out.errors.push(long ? 'For a buy, the stop must be below the entry.' : 'For a short, the stop must be above the entry.');
  }
  if (p.side === 'SHORT' && p.segment === 'EQ' && !p.intraday) out.errors.push("Shares can only be shorted intraday in India — switch to Intraday, or use futures.");
  if (out.errors.length || !(out.budget > 0)) return out;

  // Loss per unit if the stop is hit (or the whole premium for a bought option).
  const move = premiumRisk ? entry : Math.abs(entry - stop);
  const slip = premiumRisk ? 0 : entry * (Number(p.slippagePct) || 0) / 100;
  const exitAtStop = premiumRisk ? 0 : stop - dir * slip;
  const lossAt = (q) => q * (move + slip) + roundTripCharges(p, q, exitAtStop);
  out.premiumRisk = premiumRisk;
  out.perUnit = { move, slip };

  // Largest whole lot count whose full loss fits a ₹ amount.
  const fit = (amount) => {
    if (!(amount > 0)) return 0;
    let lo = 0; let hi = Math.max(1, Math.ceil(amount / (move + slip) / lot)) + 1;
    while (lossAt(hi * lot) <= amount) hi *= 2;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lossAt(mid * lot) <= amount) lo = mid; else hi = mid - 1; }
    return lo * lot;
  };

  const byRisk = fit(out.budget);
  out.byRisk = byRisk;
  let qty = byRisk;
  if (!byRisk) out.errors.push(`Even 1 ${lot > 1 ? 'lot' : 'share'} would lose ${Math.round(lossAt(lot)).toLocaleString('en-IN')} at the stop — more than your ₹${Math.round(out.budget).toLocaleString('en-IN')} budget. Use a closer stop or skip this one.`);

  // Max position size (by value; for futures the exposure is the full contract value).
  if (s.maxPositionPct > 0 && entry > 0) {
    const byValue = Math.floor((capital * s.maxPositionPct / 100) / entry / lot) * lot;
    if (byValue < qty) { qty = byValue; out.limits.push({ rule: 'position', text: `Max position ${s.maxPositionPct}% of capital caps this at ${byValue.toLocaleString('en-IN')} (risk alone would allow ${byRisk.toLocaleString('en-IN')}).` }); }
  }
  // Total open risk across all positions.
  if (s.maxPortfolioHeatPct > 0) {
    const room = capital * s.maxPortfolioHeatPct / 100 - openRisk;
    out.heatRoom = room;
    if (room <= 0) { qty = 0; out.limits.push({ rule: 'heat', text: `Your open trades already risk ₹${Math.round(openRisk).toLocaleString('en-IN')} — the ${s.maxPortfolioHeatPct}% total-risk limit is used up. Tighten or close something first.` }); }
    else if (lossAt(qty) > room) { const q = fit(room); qty = Math.min(qty, q); out.limits.push({ rule: 'heat', text: `Only ₹${Math.round(room).toLocaleString('en-IN')} of your ${s.maxPortfolioHeatPct}% total-risk limit is left, so this is cut to ${q.toLocaleString('en-IN')}.` }); }
  }

  out.qty = qty; out.lots = qty / lot; out.lotSize = lot;
  out.value = qty * entry;
  out.pctCapital = capital ? out.value / capital : 0;
  const chargesAtStop = roundTripCharges(p, qty, exitAtStop);
  out.risk = { move: qty * move, slip: qty * slip, charges: chargesAtStop, total: qty * (move + slip) + chargesAtStop };
  out.riskPct = capital ? out.risk.total / capital : 0;
  const roundTripAtEntry = roundTripCharges(p, qty, entry);
  out.breakeven = qty ? entry + dir * roundTripAtEntry / qty : null;
  out.chargesRoundTrip = roundTripAtEntry;
  if (target != null && target > 0 && qty) {
    if ((target - entry) * dir <= 0) out.warnings.push('The target is on the wrong side of the entry.');
    else {
      const chargesAtTarget = roundTripCharges(p, qty, target);
      out.reward = { gross: qty * Math.abs(target - entry), charges: chargesAtTarget, net: qty * Math.abs(target - entry) - chargesAtTarget };
      out.rr = out.risk.total ? out.reward.net / out.risk.total : null;
      if (out.rr != null && out.rr < 1.5) out.warnings.push(`Reward is only ${out.rr.toFixed(2)}× the risk after charges — most setups need 1.5–2× or more to pay over time.`);
    }
  }
  if (!p.intraday && !premiumRisk && qty) {
    const gap = (stop ?? entry) * 0.05;
    const gapLoss = out.risk.total + qty * gap;
    out.warnings.push(`Held overnight, a stop can't protect you from a gap: if it opens 5% beyond your stop, you'd lose about ₹${Math.round(gapLoss).toLocaleString('en-IN')} (${(gapLoss / out.budget).toFixed(1)}× your planned risk).`);
  }
  if (premiumRisk && qty && stop != null && stop > 0 && stop < entry) out.warnings.push(`Sized so losing the whole premium stays in budget. If you do honour your ₹${stop} stop, you'd lose about ₹${Math.round(qty * (entry - stop) + roundTripCharges(p, qty, stop)).toLocaleString('en-IN')}.`);
  if (out.risk.charges > out.risk.total * 0.15 && qty) out.warnings.push(`Charges are ${Math.round(out.risk.charges / out.risk.total * 100)}% of the risk — the position is small for its costs.`);
  return out;
}
