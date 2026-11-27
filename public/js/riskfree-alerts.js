// One-time alert when an open trade (real or paper) becomes risk-free; it can alert again
// if the trade later stops being risk-free and then becomes so once more.
import { S } from './state.js';
import { toast } from './ui.js';
import { esc, money } from './util.js';
import { riskFreeOf } from '../riskfree.js';

const KEY = 'tq-riskfree-seen';
const seen = () => { try { return new Set(JSON.parse(localStorage.getItem(KEY) || '[]')); } catch { return new Set(); } };
const save = (s) => { try { localStorage.setItem(KEY, JSON.stringify([...s].slice(-500))); } catch { /* private */ } };

/** items: [{ id, label, locked, free }] — toasts the ones that just turned risk-free. */
export function noteRiskFree(items, scope) {
  const s = seen(); let changed = false;
  for (const x of items) {
    const id = `${scope}:${x.id}`;
    if (x.free && !s.has(id)) { s.add(id); changed = true; toast(`🛡️ <b>${esc(x.label)}</b> is now risk-free${scope === 'paper' ? ' (paper)' : ''} — if the stop is hit it still makes ${money(x.locked, { sign: true })} after charges`, 'ok'); }
    if (!x.free && s.has(id)) { s.delete(id); changed = true; }
  }
  if (changed) save(s);
}

export function announceRiskFree() {
  const open = (S.state?.trades || []).filter((t) => t.status === 'OPEN');
  noteRiskFree(open.map((t) => { const rf = riskFreeOf(t); return { id: t.id, label: t.symbol, free: !!rf?.free, locked: rf?.locked ?? 0 }; }), 'real');
}
