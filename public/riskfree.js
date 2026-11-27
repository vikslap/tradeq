// "Risk-free": if the stop is hit now, the trade still ends at break-even or better —
// booked profit + the move to the stop on what's left − all charges (entry and exits) ≥ 0.
import { metrics } from './game.js';
import { tradeCharges } from './charges.js';

export function riskFreeOf(t, stop = t.stopLoss) {
  if (t.status !== 'OPEN' || stop == null || t.entryPrice == null) return null;
  const m = metrics(t); if (!m.openQty) return null;
  const dir = m.dir;
  const bookedGross = m.exits.reduce((a, e) => a + (e.price - t.entryPrice) * dir * e.qty, 0);
  const atStop = (stop - t.entryPrice) * dir * m.openQty;
  const allExits = [...m.exits, { qty: m.openQty, price: stop, time: new Date().toISOString() }];
  const charges = t.charges != null
    ? t.charges + tradeCharges({ ...t, qty: m.openQty, exits: [{ qty: m.openQty, price: stop }], charges: null }).total // manual charges so far + (conservatively) full charges on what is left
    : tradeCharges({ ...t, exits: allExits }).total;
  const locked = bookedGross + atStop - charges;
  return { free: locked >= 0, locked, stopPastEntry: (stop - t.entryPrice) * dir >= 0 };
}
