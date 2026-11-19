// Insights → "Am I beating an index fund?" and "Profit and charges by year".
// Built from the Zerodha funds ledger (money in/out, account fees) and the journal.
import { parseLedger, cashFlows, ledgerByYear, ledgerCash, shadowPortfolio, fyOf, FEE_KINDS } from '../ledger.js';
import { exitsOf, tradeCharges } from '../charges.js';
import { xirr } from '../stats.js';
import { mountWealthChart } from '../tradechart.js';
import { S, api, reload } from './state.js';
import { toast } from './ui.js';
import { $, esc, money, pct, cls, fmtDate } from './util.js';

const DAY = 86400000;
const istDay = (iso) => new Date(new Date(iso).getTime() + 330 * 60000).toISOString().slice(0, 10);
const rs0 = (v) => money(v, { dp: 0 });

/** What everything in the account is worth now: Kite holdings + mutual funds + cash. */
export function accountValue() {
  const manual = S.state.settings.accountValue;
  const p = S.portfolio;
  if (p && !manual) {
    const stocks = (p.holdings || []).reduce((a, h) => a + (h.qty || 0) * (h.lastPrice || h.avgPrice || 0), 0);
    const mf = (p.mf || []).reduce((a, h) => a + (h.qty || 0) * (h.lastPrice || 0), 0);
    const cash = ledgerCash(S.state.ledger)?.amount || 0;
    // Mutual funds are left out: SIPs paid from the bank never show up in the ledger.
    return { value: stocks + cash, parts: { stocks, mf, cash }, source: 'kite', date: new Date().toISOString() };
  }
  if (manual) return { value: manual.value, source: 'manual', date: manual.date };
  return null;
}

/** Realised trading P&L, estimated trading charges and account fees, per financial year. */
export function yearlyProfit() {
  const years = {};
  const Y = (fy) => (years[fy] ||= { fy, gross: 0, tradeCharges: 0, fees: 0, feeKinds: {}, deposits: 0, withdrawals: 0, exits: 0 });
  for (const t of S.state.trades) {
    const ex = exitsOf(t); if (!ex.length) continue;
    const dir = t.side === 'SHORT' ? -1 : 1;
    const exQty = ex.reduce((a, e) => a + e.qty, 0);
    const total = t.charges == null ? tradeCharges(t).total : t.charges;
    for (const e of ex) {
      const y = Y(fyOf(istDay(e.time)));
      y.gross += (e.price - t.entryPrice) * dir * e.qty;
      y.tradeCharges += exQty ? total * (e.qty / exQty) : 0;
      y.exits++;
    }
  }
  for (const l of ledgerByYear(S.state.ledger)) Object.assign(Y(l.fy), { fees: l.fees, feeKinds: l.feeKinds, deposits: l.deposits, withdrawals: l.withdrawals });
  return Object.values(years).sort((a, b) => b.fy.localeCompare(a.fy));
}

export function wealthSection() {
  const ledger = S.state.ledger || [];
  if (!ledger.length) {
    return `<section class="card" style="margin-bottom:16px"><header class="card-h"><h3>Am I beating an index fund?</h3></header>
      <p class="muted" style="margin-top:0">Import your Zerodha <b>funds ledger</b> (Console → Funds → Statement → Ledger → download CSV, one file per year is fine). TradeQuest then works out your real yearly return from the money you actually put in and took out, compares it with the same money in a Nifty 50 index fund, and adds every account fee to your yearly net profit.</p>
      <button class="btn primary" data-action="ledger-import">⬆ Import Zerodha ledger</button></section>`;
  }
  const flows = cashFlows(ledger);
  const putIn = flows.reduce((a, f) => a + f.amount, 0);
  const acct = accountValue();
  const today = istDay(new Date().toISOString());
  let you = null;
  if (acct) {
    const xf = [...flows.map((f) => ({ t: Date.parse(f.date), v: -f.amount })), { t: Date.parse(today), v: acct.value }];
    you = { value: acct.value, gain: acct.value - putIn, xirr: xirr(xf) };
  }
  const span = flows.length ? `${fmtDate(flows[0].date)} – today` : '';
  const valueBox = `<div class="field" style="margin:0"><label>Value today ${acct?.source === 'kite' ? '<span class="pill">from Kite</span>' : ''}</label>
    <form class="row" id="acct-value-form" style="gap:6px"><input class="input num" name="value" type="number" step="any" min="0" placeholder="Stocks + cash" value="${acct?.source === 'manual' ? acct.value : ''}" style="max-width:180px">
    <button class="btn sm" type="submit">${acct?.source === 'manual' ? 'Update' : 'Set'}</button>${acct?.source === 'manual' ? '<button class="btn sm ghost" type="button" data-action="acct-value-clear">Use Kite</button>' : ''}</form>
    <div class="hint">${acct?.source === 'kite' ? `Stocks, ETFs & SGBs ${rs0(acct.parts.stocks)} + cash ${rs0(acct.parts.cash)}.${acct.parts.mf ? ` Mutual funds (${rs0(acct.parts.mf)}) are left out — SIPs paid from your bank never pass through the ledger, so their cost isn't known here.` : ''} Type a figure to override.` : acct ? `Entered ${fmtDate(acct.date)}. Connect Kite to fill it automatically.` : 'Connect Kite, or type the value of your stock holdings + cash from Kite (leave mutual funds out).'}</div></div>`;
  return `<section class="card" style="margin-bottom:16px" id="wealth-card">
    <header class="card-h"><h3>Am I beating an index fund?</h3><span class="sub">${esc(span)} · ${ledger.length} ledger entries</span></header>
    <div class="kpis k4" style="margin-bottom:12px">
      <div class="kpi"><div class="k">Money put in (net)</div><div class="v mono">${rs0(putIn)}</div><div class="s">added − withdrawn − MF bought</div></div>
      <div class="kpi"><div class="k">Your gain</div><div class="v mono ${cls(you?.gain)}">${you ? money(you.gain, { sign: true, dp: 0 }) : '—'}</div><div class="s">${you?.xirr != null ? `<b class="${cls(you.xirr)}">${pct(you.xirr)}</b> a year (XIRR)` : 'needs value today'}</div></div>
      <div class="kpi" id="wealth-fund"><div class="k">Same money in Nifty 50 fund</div><div class="v mono">…</div><div class="s">loading prices</div></div>
      <div class="kpi" id="wealth-diff"><div class="k">You vs the fund</div><div class="v mono">—</div><div class="s"></div></div>
    </div>
    ${valueBox}
    <div id="wealth-chart" style="margin-top:12px"></div>
    <p class="faint" style="font-size:12px;margin:8px 0 0">The fund line buys units of a Nifty 50 index fund (direct plan, after its costs) with every rupee you added, on the same day, and sells units whenever you withdrew. This covers your stock account — stocks, ETFs, SGBs, F&O results and cash. Mutual funds are kept out on both sides (money spent on them through the ledger counts as taken out). Tax isn't included.</p>
  </section>`;
}

export function yearlySection() {
  const rows = yearlyProfit();
  if (!rows.length) return '';
  const hasLedger = (S.state.ledger || []).length > 0;
  const tot = rows.reduce((a, r) => ({ gross: a.gross + r.gross, tc: a.tc + r.tradeCharges, fees: a.fees + r.fees }), { gross: 0, tc: 0, fees: 0 });
  const line = (r) => {
    const net = r.gross - r.tradeCharges - r.fees;
    const kinds = Object.entries(r.feeKinds || {}).filter(([, v]) => Math.abs(v) >= 0.5).sort((a, b) => b[1] - a[1]);
    return `<tr><td><b>${r.fy}</b></td><td class="r num ${cls(r.gross)}">${money(r.gross, { sign: true, dp: 0 })}</td><td class="r num">${rs0(r.tradeCharges)}</td>
      <td class="r num">${hasLedger ? (kinds.length ? `<span title="${esc(kinds.map(([k, v]) => `${FEE_KINDS[k]}: ₹${Math.round(v)}`).join('\n'))}" style="text-decoration:underline dotted;cursor:help">${rs0(r.fees)}</span>` : rs0(0)) : '—'}</td>
      <td class="r num ${cls(net)}"><b>${money(net, { sign: true, dp: 0 })}</b></td></tr>`;
  };
  return `<section class="card" style="margin-bottom:16px"><header class="card-h"><h3>Profit and charges by year</h3><span class="sub">Indian financial year (Apr–Mar), by exit date</span></header>
    <div class="table-wrap"><table class="tbl"><thead><tr><th>Year</th><th class="r">Booked P&L (gross)</th><th class="r">Trading charges</th><th class="r">Account fees</th><th class="r">Net profit</th></tr></thead>
    <tbody>${rows.map(line).join('')}</tbody>
    <tfoot><tr><td><b>Total</b></td><td class="r num ${cls(tot.gross)}">${money(tot.gross, { sign: true, dp: 0 })}</td><td class="r num">${rs0(tot.tc)}</td><td class="r num">${hasLedger ? rs0(tot.fees) : '—'}</td><td class="r num ${cls(tot.gross - tot.tc - tot.fees)}"><b>${money(tot.gross - tot.tc - tot.fees, { sign: true, dp: 0 })}</b></td></tr></tfoot></table></div>
    <p class="faint" style="font-size:12px;margin:8px 0 0"><b>Trading charges</b> — brokerage, STT, exchange, SEBI, stamp duty, GST — come from each trade (Zerodha's schedule, or the figure you typed). <b>Account fees</b> come from the ledger: DP charges, demat AMC, payment-gateway fees, late-payment interest, auto square-off and subscriptions (hover for the split).${hasLedger ? '' : ' Import your ledger to include them.'} Before tax.</p></section>`;
}

/** Pick one or more ledger CSVs and import them (duplicates across files are skipped). */
export function importLedgerFiles() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.csv,text/csv'; input.multiple = true;
  input.onchange = async () => {
    try {
      const rows = [];
      for (const f of input.files) rows.push(...parseLedger(await f.text()));
      if (!rows.length) throw new Error('No ledger entries found in those files');
      const r = await api('/api/import/ledger', { method: 'POST', body: { rows } });
      await reload();
      toast(`<div class="t-h">⬆ Ledger imported</div><div class="muted" style="font-size:12px;margin-top:4px">${r.added} new entries · ${r.skipped} already there · ${r.total} in total</div>`);
    } catch (e) { toast(esc(e.message), 'err'); }
  };
  input.click();
}

function bindValueForm() {
  const form = $('#acct-value-form');
  if (!form || form.dataset.bound) return;
  form.dataset.bound = '1';
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = Number(form.value.value);
    if (!(v >= 0) || form.value.value === '') return toast('Enter the total value of your account today', 'err');
    try { await api('/api/settings', { method: 'PUT', body: { accountValue: { value: v, date: new Date().toISOString() } } }); await reload(); } catch (err) { toast(esc(err.message), 'err'); }
  });
}

/** After render: load index-fund prices and draw the comparison. */
export async function mountWealth() {
  bindValueForm();
  const host = $('#wealth-chart'); if (!host) return;
  const ledger = S.state.ledger || [];
  const scheme = S.state.settings.benchmarkScheme || '120716';
  const flows = cashFlows(ledger);
  const acct = accountValue();
  const sig = `${ledger.length}|${scheme}|${acct?.value ?? ''}|${document.documentElement.dataset.theme || ''}`;
  if (host.dataset.sig === sig && host.childElementCount) return;
  host.dataset.sig = sig;
  try {
    S._bench ||= {};
    const b = (S._bench[scheme] ||= await api(`/api/benchmark?scheme=${scheme}`));
    const today = istDay(new Date().toISOString());
    const sh = shadowPortfolio(flows, b.nav, today);
    if (!sh || !$('#wealth-chart')) return;
    const fundXirr = xirr([...flows.map((f) => ({ t: Date.parse(f.date), v: -f.amount })), { t: Date.parse(today), v: sh.value }]);
    $('#wealth-fund').innerHTML = `<div class="k">Same money in Nifty 50 fund</div><div class="v mono">${rs0(sh.value)}</div><div class="s">${fundXirr != null ? `<b>${pct(fundXirr)}</b> a year · ` : ''}prices to ${fmtDate(b.nav.at(-1)[0])}</div>`;
    if (acct) {
      const diff = acct.value - sh.value;
      $('#wealth-diff').innerHTML = `<div class="k">You vs the fund</div><div class="v mono ${cls(diff)}">${money(diff, { sign: true, dp: 0 })}</div><div class="s">${diff >= 0 ? 'ahead of simply holding the index' : 'behind simply holding the index'}</div>`;
    }
    host.dataset.sig = sig;
    S.wealthChart?.destroy?.();
    S.wealthChart = mountWealthChart(host, sh.points, { you: acct?.value ?? null, fundName: 'Nifty 50 fund', height: 260 });
  } catch (e) {
    host.dataset.sig = '';
    const f = $('#wealth-fund'); if (f) f.innerHTML = `<div class="k">Same money in Nifty 50 fund</div><div class="v mono">—</div><div class="s neg">${esc(e.message)}</div>`;
  }
}

export const _test = { DAY };
