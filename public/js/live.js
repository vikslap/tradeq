import { tradeKey } from '../game.js';
import { $, esc } from './util.js';
import { S, api, loadKite, ltpFor, findTrade } from './state.js';
import { toast } from './ui.js';
import { longTermInner, kpiTiles, liveNote, openPositionsInner } from './dashboard.js';
import { journalRows } from './journal.js';
import { renderDrawer } from './drawer.js';
import { renderTop } from './main.js';
import { capitalLiveInner } from './capital-page.js';
import { repaintReport } from './report-ui.js';


// =====================================================================
// Live quotes polling
// =====================================================================
export let polling = false;

export async function pollQuotes() {
  if (polling || !S.kite.connected || document.hidden || !S.state) return;
  const keys = [...new Set(S.state.trades.filter((t) => t.status === 'OPEN').map(tradeKey))];
  if (!keys.length) return;
  polling = true;
  try {
    const { quotes } = await api('/api/kite/quote?i=' + encodeURIComponent(keys.join(',')));
    S.flash = new Set(Object.keys(quotes).filter((k) => S.quotes[k]?.last !== quotes[k].last));
    Object.assign(S.quotes, quotes); S.quotesAt = new Date().toISOString();
    paintLive();
  } catch (e) {
    if (e.code === 'TOKEN') { await loadKite(); renderTop(); toast(esc(e.message), 'err'); }
  } finally { polling = false; }
}


export function paintLive() {
  const op = $('#open-positions'); if (op) op.innerHTML = openPositionsInner();
  const ltc = $('#lt-card'); if (ltc) ltc.innerHTML = longTermInner();
  const k = $('#kpis'); if (k) k.innerHTML = kpiTiles();
  const ln = $('#live-note'); if (ln) ln.innerHTML = liveNote();
  const jb = $('#journal-body'); if (jb) jb.innerHTML = journalRows();
  const cl = $('#cap-live'); if (cl) cl.innerHTML = capitalLiveInner();
  repaintReport();
  if (S.drawerId) { const t = S.state.trades.find((x) => x.id === S.drawerId); if (t?.status === 'OPEN') { renderDrawer(); if (S.cv?.inst && ltpFor(t)) S.cv.inst.setLive(ltpFor(t)); } }
  if (S.big?.inst) { const t = findTrade(S.big.tradeId); if (t?.status === 'OPEN' && ltpFor(t)) S.big.inst.setLive(ltpFor(t)); }
}
