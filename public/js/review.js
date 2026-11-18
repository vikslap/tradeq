import { metrics, dayKey, weekStart, isTrading } from '../game.js';
import { $, esc, num, sum, money, compact, price, pct, rfmt, cls, stars } from './util.js';
import { S } from './state.js';
import { render } from './main.js';


// ---------- Weekly review ----------
export function weekOptions() {
  const out = []; const d = new Date(weekStart());
  for (let i = 0; i < 8; i++) { out.push(dayKey(d)); d.setDate(d.getDate() - 7); }
  return out;
}


export function pageReview() {
  const ws = S.reviewWeek || weekStart();
  const start = new Date(ws); const end = new Date(start); end.setDate(end.getDate() + 7);
  const inWeek = (iso) => iso && new Date(iso) >= start && new Date(iso) < end;
  const closed = S.state.trades.filter((t) => isTrading(t) && t.status === 'CLOSED' && inWeek(t.exitTime)).map((t) => ({ t, m: metrics(t) }));
  const entered = S.state.trades.filter((t) => inWeek(t.entryTime));
  const net = sum(closed.map((x) => x.m.net)); const wins = closed.filter((x) => x.m.net > 0).length;
  const rs = closed.map((x) => x.m.r).filter((v) => v != null);
  const cleanN = closed.filter(({ t }) => S.game.perTrade[t.id]?.clean).length;
  const weekXp = sum(S.game.events.filter((e) => inWeek(e.at)).map((e) => e.xp));
  const existing = S.state.reviews.find((r) => r.weekStart === ws);
  const past = [...S.state.reviews].sort((a, b) => b.weekStart.localeCompare(a.weekStart));
  const label = `${start.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} – ${new Date(end - 86400000).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`;
  return `<div class="page-h"><div><h1>Weekly review</h1><p>Ten honest minutes a week compounds faster than any indicator. <span class="gold">+40 XP</span> per review.</p></div>
    <select class="input" style="width:auto" data-action-change="review-week">${weekOptions().map((w) => `<option value="${w}" ${w === ws ? 'selected' : ''}>Week of ${new Date(w).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</option>`).join('')}</select></div>
  <div class="kpis" style="margin-bottom:16px">
    ${[['Week', label, `${entered.length} entries`], ['Net realised', `<span class="${cls(net)}">${compact(net)}</span>`, `${closed.length} closed`], ['Win rate', closed.length ? pct(wins / closed.length, 0) : '—', `${wins}W · ${closed.length - wins}L`], ['Avg R', rfmt(rs.length ? sum(rs) / rs.length : null), 'closed this week'], ['Clean trades', `${cleanN}/${closed.length}`, 'every rule kept'], ['XP this week', `<span class="gold">${weekXp > 0 ? '+' : ''}${weekXp}</span>`, 'process points']]
    .map(([k, v, s]) => `<div class="kpi"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join('')}
  </div>
  <div class="insights">
    <form class="card stack" id="review-form">
      <header class="card-h" style="margin:0"><h3>${existing ? 'Update' : 'Write'} this review</h3>${existing ? '<span class="pill green">✓ done</span>' : '<span class="pill gold">+40 XP</span>'}</header>
      <div class="field"><label>What went well?</label><textarea class="input" name="wentWell" placeholder="Waited for my A+ setup on Tuesday; took the stop on ITC without hesitation.">${esc(existing?.wentWell)}</textarea></div>
      <div class="field"><label>What will you improve?</label><textarea class="input" name="improve" placeholder="Entered TRENT late out of FOMO — skip if price is >2% past the trigger.">${esc(existing?.improve)}</textarea></div>
      <div class="field"><label>One focus for next week</label><input class="input" name="focus" value="${esc(existing?.focus)}" placeholder="Only trade breakouts with volume confirmation"></div>
      <div class="field"><label>Rate your execution</label>${stars('rating', existing?.rating)}</div>
      <div class="err" id="review-err"></div>
      <div class="row"><button class="btn primary" type="submit">${existing ? 'Save review' : 'Complete review · +40 XP'}</button></div>
    </form>
    <section class="card"><header class="card-h"><h3>Closed this week</h3></header>
      ${closed.length ? `<div class="table-wrap"><table class="tbl"><tbody>${closed.map(({ t, m }) => `<tr class="click" data-action="open-drawer" data-id="${t.id}"><td><span class="sym">${esc(t.symbol)}</span></td><td><span class="side ${t.side}">${t.side}</span></td><td class="r num ${cls(m.net)}">${money(m.net, { sign: true })}</td><td class="r num ${cls(m.r)}">${rfmt(m.r)}</td><td>${S.game.perTrade[t.id]?.clean ? '<span class="pill green">clean</span>' : '<span class="pill red">rule broken</span>'}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-sm">No trades closed this week.</div>'}
    </section>
    <section class="card span-2"><header class="card-h"><h3>Past reviews</h3></header>
      ${past.length ? past.map((r) => `<div style="padding:12px 0;border-bottom:1px dashed var(--border)"><div class="row" style="justify-content:space-between"><b>Week of ${new Date(r.weekStart).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</b><span class="row">${r.rating ? '<span class="gold">' + '★'.repeat(r.rating) + '</span>' : ''}<button class="btn ghost sm" data-action="delete-review" data-id="${r.id}">Delete</button></span></div>
        ${r.wentWell ? `<div class="prose" style="margin-top:6px"><span class="pos">✓</span> ${esc(r.wentWell)}</div>` : ''}${r.improve ? `<div class="prose"><span class="gold">↑</span> ${esc(r.improve)}</div>` : ''}${r.focus ? `<div class="prose"><span class="muted">Focus:</span> ${esc(r.focus)}</div>` : ''}</div>`).join('') : '<div class="empty-sm">Your reviews will collect here.</div>'}
    </section>
  </div>`;
}


export function bindReview() {
  const sel = $('[data-action-change="review-week"]');
  sel?.addEventListener('change', () => { S.reviewWeek = sel.value; render(); });
}
