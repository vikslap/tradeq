// 💰 Capital — the trading base, profit sweeps to long-term investing, the kill
// switch, a tax estimate, and the money comparisons that used to sit in Insights.
import { capitalState, cleanSweeps, STCG_RATE, DEFAULT_KILL_PCT } from '../capital.js';
import { isTrading } from '../game.js';
import { wealthSection, yearlySection } from './wealth.js';
import { vsSectionShell } from './vsindex.js';
import { unrealised } from './dashboard.js';
import { S, api, reload, ltpFor, yearSelect } from './state.js';
import { confirmBox, toast } from './ui.js';
import { $, esc, money, cls, fmtDate } from './util.js';

const rs0 = (v) => money(v, { dp: 0 });
const rsS = (v) => money(v, { sign: true, dp: 0 });
const today = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

function openPnl() {
  const open = S.state.trades.filter((t) => t.status === 'OPEN' && isTrading(t));
  if (!open.length) return 0;
  return open.some((t) => ltpFor(t) != null) ? unrealised() : null;
}

export const capital = () => capitalState({ trades: S.state.trades, settings: S.state.settings, today: today(), openPnl: openPnl() });

const kpi = (k, v, s = '', c = '') => `<div class="kpi"><div class="k">${k}</div><div class="v mono ${c}">${v}</div><div class="s">${s}</div></div>`;

function setupCard(s, c) {
  return `<section class="card" style="margin-bottom:16px" id="cap-setup">
    <header class="card-h"><h3>${c.ready ? '⚙️ Capital settings' : '💰 Set up your trading capital'}</h3></header>
    ${c.ready ? '' : `<p class="muted" style="margin-top:0">Pick a fixed amount to trade with. Booked profit above it gets swept out to long-term investing every quarter; if the account falls to the kill switch, you stop and review before trading again. Swing and positional trades count here, long-term holdings don't.</p>`}
    <form id="cap-form" class="row" style="gap:12px;flex-wrap:wrap;align-items:flex-end">
      <div class="field" style="margin:0"><label>Trading capital (₹)</label><input class="input num" name="capital" type="number" min="1" step="1000" value="${s.capital || ''}" style="max-width:160px" required></div>
      <div class="field" style="margin:0"><label>Count trades from</label><input class="input" name="capitalSince" type="date" value="${s.capitalSince || today()}" required></div>
      <div class="field" style="margin:0"><label>Kill switch (% of capital)</label><input class="input num" name="killSwitchPct" type="number" min="10" max="100" step="1" value="${s.killSwitchPct ?? DEFAULT_KILL_PCT}" style="max-width:110px"></div>
      <button class="btn primary" type="submit">${c.ready ? 'Save' : 'Start tracking'}</button>
    </form>
    <p class="faint" style="font-size:12px;margin:8px 0 0">The same capital figure is used by the position size calculator and the risk rules.</p>
  </section>`;
}

function banner(c) {
  if (c.breached) return `<div class="note" style="margin-bottom:16px;background:rgba(244,80,107,.14);border-color:rgba(244,80,107,.45)"><span>🛑 <b>Kill switch hit.</b> The account is at <b>${rs0(c.equity)}</b>, at or below ${rs0(c.floor)} (${c.killPct}% of ${rs0(c.base)}). Stop opening new trades and do a review first. Every new trade from here costs −15 XP.</span></div>`;
  if (c.belowBase) return `<div class="note warn" style="margin-bottom:16px"><span>Below your base by <b>${rs0(c.base - c.equity)}</b>. Nothing to sweep until you're back above ${rs0(c.base)}. Kill switch at ${rs0(c.floor)}.</span></div>`;
  return '';
}

function sweepCard(c) {
  const q = c.quarter;
  const due = c.sweepable >= 1;
  return `<section class="card" style="margin-bottom:16px">
    <header class="card-h"><h3>🧹 Sweep — ${esc(q.label)}</h3><span class="sub">${fmtDate(q.from)} – ${fmtDate(q.to)}</span></header>
    <div class="kpis k4" style="margin-bottom:12px">
      ${kpi('Ready to sweep', rs0(c.sweepable), due ? 'booked profit above the base, tax kept back' : 'nothing above the base yet', due ? 'pos' : '')}
      ${kpi('Swept this quarter', rs0(q.swept), q.swept ? 'nice — +25 XP each' : 'none yet')}
      ${kpi('Swept since start', rs0(c.swept), `${c.sweeps.length} sweep${c.sweeps.length === 1 ? '' : 's'}`)}
      ${kpi('Quarters above base', c.aboveStreak, 'in a row, finished quarters')}
    </div>
    <form id="sweep-form" class="row" style="gap:10px;flex-wrap:wrap;align-items:flex-end">
      <div class="field" style="margin:0"><label>Amount (₹)</label><input class="input num" name="amount" type="number" min="1" step="any" value="${due ? Math.floor(c.sweepable) : ''}" style="max-width:150px" required></div>
      <div class="field" style="margin:0"><label>Date</label><input class="input" name="date" type="date" value="${today()}" required></div>
      <div class="field" style="margin:0;flex:1 1 200px"><label>Note</label><input class="input" name="note" maxlength="120" placeholder="e.g. Nifty 50 index fund, lump sum"></div>
      <button class="btn primary" type="submit">Log sweep</button>
    </form>
    <p class="faint" style="font-size:12px;margin:8px 0 0">Log it once the money has actually gone into the fund. Sweeps are counted as money taken out, never as a loss, so your win rate and returns stay clean. When you next import the Zerodha ledger, the withdrawal shows up in the index-fund comparison below too.</p>
    ${c.sweeps.length ? `<div class="table-wrap" style="margin-top:12px"><table class="tbl"><thead><tr><th>Date</th><th class="r">Amount</th><th>Note</th><th></th></tr></thead><tbody>
      ${[...c.sweeps].reverse().map((s) => `<tr><td>${fmtDate(s.date)}</td><td class="r num">${rs0(s.amount)}</td><td class="muted">${esc(s.note)}</td><td class="r"><button class="btn ghost sm" data-action="sweep-delete" data-id="${esc(s.id)}" title="Delete">✕</button></td></tr>`).join('')}
    </tbody></table></div>` : ''}
  </section>`;
}

function taxCard(c) {
  const t = c.tax;
  return `<section class="card" style="margin-bottom:16px">
    <header class="card-h"><h3>🧾 Tax this year (estimate)</h3><span class="sub">${esc(c.fy.replace('FY', 'FY '))} · trading exits since ${fmtDate(c.since)}</span></header>
    <div class="kpis k4" style="margin-bottom:8px">
      ${kpi('Short-term gains (equity)', rsS(t.stcg), 'delivery, held up to 12 months', cls(t.stcg))}
      ${kpi(`Keep aside (${STCG_RATE * 100}%)`, rs0(c.taxReserve), 'taken out of the sweep amount')}
      ${kpi('Long-term gains', rsS(t.ltcg), 'held over 12 months · 12.5% above ₹1.25L', cls(t.ltcg))}
      ${kpi('Intraday + F&O', rsS(t.business), 'taxed at your slab · not estimated', cls(t.business))}
    </div>
    <p class="faint" style="font-size:12px;margin:0">A rough guide, not tax advice. It sets this year's short-term losses against gains but ignores losses carried forward, surcharge and cess. Check with your CA before filing.</p>
  </section>`;
}

/** Banner + headline tiles; repainted when live prices arrive. */
export function capitalLiveInner(c = capital()) {
  const eqNote = c.openPnl == null ? 'open trades at cost · no live prices yet' : c.openPnl ? `incl. open P&L ${rsS(c.openPnl)}` : 'no open trades';
  return `${banner(c)}
    <div class="kpis" style="margin-bottom:16px">
      ${kpi('Trading capital', rs0(c.base), `since ${fmtDate(c.since)}`)}
      ${kpi('Account now', rs0(c.equity), eqNote, c.equity >= c.base ? 'pos' : 'neg')}
      ${kpi('Above / below base', rsS(c.surplus), c.surplus >= 0 ? 'profit not yet swept' : 'to win back first', cls(c.surplus))}
      ${kpi('Booked since start', rsS(c.booked), 'after charges', cls(c.booked))}
      ${kpi('Swept out', rs0(c.swept), 'to long-term investing')}
      ${kpi('Kill switch', rs0(c.floor), `${c.killPct}% of capital · ${c.equity > c.floor ? `${rs0(c.equity - c.floor)} away` : 'hit'}`, c.breached ? 'neg' : '')}
    </div>`;
}

export function pageCapital() {
  const s = S.state.settings; const c = capital();
  const head = `<div class="page-h"><div><h1>💰 Capital</h1><p>Your trading base, profit sweeps to long-term investing, and whether trading beats an index fund.</p></div><div class="row" style="gap:8px;flex-wrap:wrap">${yearSelect()}</div></div>`;
  const money_ = vsSectionShell() + wealthSection() + yearlySection();
  if (!c.ready) return head + setupCard(s, c) + money_;
  return `${head}<div id="cap-live">${capitalLiveInner(c)}</div>
    ${sweepCard(c)}${taxCard(c)}${money_}${setupCard(s, c)}`;
}

async function saveSettings(body) {
  try { await api('/api/settings', { method: 'PUT', body }); await reload({ celebrate: true }); return true; } catch (err) { toast(esc(err.message), 'err'); return false; }
}

export function mountCapital() {
  const cf = $('#cap-form');
  if (cf && !cf.dataset.bound) {
    cf.dataset.bound = '1';
    cf.addEventListener('submit', (e) => {
      e.preventDefault();
      const capitalV = Number(cf.capital.value); const pct = Number(cf.killSwitchPct.value);
      if (!(capitalV > 0)) return toast('Enter your trading capital', 'err');
      if (!(pct >= 10 && pct <= 100)) return toast('Kill switch should be between 10% and 100%', 'err');
      saveSettings({ capital: capitalV, capitalSince: cf.capitalSince.value, killSwitchPct: pct });
    });
  }
  const sf = $('#sweep-form');
  if (sf && !sf.dataset.bound) {
    sf.dataset.bound = '1';
    sf.addEventListener('submit', (e) => {
      e.preventDefault();
      const amount = Number(sf.amount.value);
      if (!(amount > 0)) return toast('Enter the amount you moved', 'err');
      const sweeps = [...cleanSweeps(S.state.settings.sweeps), { id: crypto.randomUUID(), date: sf.date.value, amount, note: sf.note.value.trim() }];
      saveSettings({ sweeps }).then((ok) => ok && toast(`🧹 Sweep of ${rs0(amount)} logged · +25 XP`));
    });
  }
}

export const capitalActions = {
  'sweep-delete': async (el) => {
    if (!(await confirmBox('Delete this sweep?', 'Its +25 XP is removed and the amount counts as still in your trading account.', 'Delete'))) return;
    await saveSettings({ sweeps: cleanSweeps(S.state.settings.sweeps).filter((s) => s.id !== el.dataset.id) });
  },
};
