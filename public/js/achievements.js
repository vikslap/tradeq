import { LEVELS } from '../game.js';
import { $, esc, nf0, fmtDate } from './util.js';
import { S } from './state.js';
import { xpFeed } from './dashboard.js';


// ---------- Achievements ----------
export function pageAchievements() {
  const g = S.game; const L = g.level;
  const rungs = LEVELS.map(([xp, title], i) => ({ n: i + 1, xp, title }));
  if (L.lvl > LEVELS.length) rungs.push({ n: L.lvl, xp: L.floor, title: L.title });
  const RULES = [
    ['Trade logged', '+10'], ['Stop-loss set before entry', '+15 / −10'], ['Risk within your limit', '+10 / −20'], ['Thesis (20+ chars)', '+10'],
    ['Target planned · setup tagged · plan ≥ 2R', '+5 each'], ['Entered at planned trigger / chased it', '+5 / −10'],
    ['Exit reason recorded', '+10'], ['Followed / broke the plan', '+15 / −10'], ['Lesson written', '+10'],
    ['Loss kept within 1R', '+15'], ['2R+ / 3R+ winner', '+15 / +25'], ['Clean trading day', '+20'], ['Weekly review', '+40'],
    ['Profit swept to long-term (Capital)', '+25'],
  ];
  const PENALTIES = [
    ['Impulse trade (no setup, no thesis)', '−10'], ['Too much capital in one stock', '−10'], ['Total open risk over limit', '−10'],
    ['Averaged down a loser', '−15'], ['Revenge entry (within window of a loss)', '−15'], ['Over daily trade limit', '−10'],
    ['Traded past daily loss limit', '−15'], ['Sized up after 2 losses (tilt)', '−15'], ['Widened the stop (each, max 3)', '−15'],
    ['Loss ran past 1.5R', '−20'], ['Winner turned into a loss (after +1R)', '−15'], ['Cut a winner short (<1R, discretionary)', '−10'],
    ['Closed without review', '−5'], ['Self-reported mistake (each)', '−5'], ['New trade with the kill switch hit (Capital)', '−15'],
    ['Mistake stack: 2+ errors on one trade', '−10 per extra (max −40)'], ['Repeat of a mistake from your last 5 trades', '−5 each'],
  ];

  return `<div class="page-h"><div><h1>Achievements</h1><p>${nf0.format(g.xp)} XP earned · Level ${L.lvl} ${esc(L.title)}</p></div></div>
  <section class="card" style="margin-bottom:16px"><header class="card-h"><h3>Level path</h3><span class="sub">${nf0.format(L.next - L.xp)} XP to next level</span></header>
    <div class="ladder">${rungs.map((r) => `<div class="rung ${r.n < L.lvl ? 'done' : r.n === L.lvl ? 'cur' : ''}"><div class="n">${r.n}</div><div class="t">${esc(r.title)}</div><div class="x">${nf0.format(r.xp)} XP</div></div>`).join('')}</div>
  </section>
  <section class="card" style="margin-bottom:16px"><header class="card-h"><h3>Badges</h3><span class="sub">${g.badges.filter((b) => b.earned).length} of ${g.badges.length} unlocked</span></header>
    <div class="badges">${g.badges.map((b) => `<div class="badge ${b.earned ? 'earned' : ''}"><div class="ic">${b.icon}</div><div class="nm">${esc(b.name)}</div><div class="ds">${esc(b.desc)}</div>
      ${b.earned ? `<div class="when">Unlocked ${fmtDate(b.earnedAt)}</div>` : `<div class="mini-bar"><span style="width:${(b.progress * 100).toFixed(0)}%"></span></div><div class="faint" style="font-size:11px;margin-top:5px">${b.current}/${b.goal}</div>`}</div>`).join('')}</div>
  </section>
  <div class="insights">
    <section class="card"><header class="card-h"><h3>How XP works</h3><span class="sub">process over profit</span></header>
      <div class="note" style="margin-bottom:12px">XP never rewards P&L directly. A disciplined loser earns more than a lucky, oversized winner — because that's what builds a durable edge. XP is recalculated from your journal every time, so edits can't game it.</div>
      <div class="label" style="margin-bottom:6px">Earn</div>
      <div class="rules">${RULES.map(([k, v]) => `<div><span class="muted">${k}</span><b class="mono ${v.startsWith('−') ? 'neg' : 'gold'}">${v}</b></div>`).join('')}</div>
      <div class="label" style="margin:16px 0 6px">Lose — the mistakes it catches</div>
      <div class="rules">${PENALTIES.map(([k, v]) => `<div><span class="muted">${k}</span><b class="mono neg">${v}</b></div>`).join('')}</div>
      <div class="label" style="margin:16px 0 6px">Long-term investments — their own rules</div>
      <div class="rules">${[['Investment logged', '+10'], ['Investment thesis / none', '+15 / −10'], ['Sell condition / none', '+10 / −5'], ['Thesis review (every 60+ days)', '+20'], ['Review overdue (30 days past due)', '−10'], ['Sold with a reason / without', '+10 / −10'], ['Sold per sell condition / against it', '+15 / −10'], ['Too much capital in one stock', '−10']].map(([k, v]) => `<div><span class="muted">${k}</span><b class="mono ${v.startsWith('−') ? 'neg' : 'gold'}">${v}</b></div>`).join('')}</div>
      <p class="faint" style="font-size:12px">No stops, R or trading limits apply to long-term holdings, and they don't count toward your discipline score, streak or trading stats.</p>
    </section>
    <section class="card"><header class="card-h"><h3>XP log</h3><span class="sub">${g.events.length} events</span></header>
      <div style="max-height:560px;overflow:auto">${xpFeed(g.events.slice(0, 200))}</div></section>
  </div>`;
}
