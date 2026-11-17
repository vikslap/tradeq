// TradeQuest gamification engine.
// Everything is derived from the journal on every load, so editing or deleting a
// trade can never leave XP out of sync. XP rewards PROCESS, not profit.

export const dayKey = (d) => new Date(d).toLocaleDateString('en-CA'); // local YYYY-MM-DD
export const tradeKey = (t) => `${t.exchange}:${t.symbol}`;

export function weekStart(d = new Date()) {
  const x = new Date(d); x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return dayKey(x);
}

export function metrics(t, ltp = null) {
  const dir = t.side === 'SHORT' ? -1 : 1;
  const qty = t.qty || 0;
  const riskPerUnit = t.initialStop != null && t.entryPrice != null ? Math.abs(t.entryPrice - t.initialStop) : null;
  const riskAmt = riskPerUnit != null ? riskPerUnit * qty : null;
  const rewardPerUnit = t.target != null && t.entryPrice != null ? Math.abs(t.target - t.entryPrice) : null;
  const plannedRR = riskPerUnit > 0 && rewardPerUnit != null ? rewardPerUnit / riskPerUnit : null;
  const closed = t.status === 'CLOSED';
  const px = closed ? t.exitPrice : ltp;
  const gross = px != null && t.entryPrice != null ? (px - t.entryPrice) * dir * qty : null;
  const net = gross != null ? gross - (closed ? t.charges || 0 : 0) : null;
  const r = net != null && riskAmt > 0 ? net / riskAmt : null;
  const end = closed && t.exitTime ? new Date(t.exitTime) : new Date();
  const holdDays = t.entryTime ? Math.max(0, (end - new Date(t.entryTime)) / 86400000) : 0;
  const openRisk = !closed && t.stopLoss != null ? (t.entryPrice - t.stopLoss) * dir * qty : null;
  return { dir, riskPerUnit, riskAmt, plannedRR, gross, net, r, value: (t.entryPrice || 0) * qty, holdDays, px, openRisk, closed };
}

// ---------------------------------------------------------------------------
// Rules. Each returns { id, ok, xp, label, disc } — disc marks discipline checks.
// ---------------------------------------------------------------------------
const rule = (id, ok, gain, loss, good, bad, disc = false) => ({ id, ok, xp: ok ? gain : loss, label: ok ? good : bad, disc });

export function isRevenge(t, trades, windowMins) {
  if (!t.entryTime) return false;
  const at = new Date(t.entryTime).getTime();
  const win = (windowMins || 0) * 60000;
  return trades.some((o) => {
    if (o.id === t.id || o.status !== 'CLOSED' || !o.exitTime) return false;
    const ex = new Date(o.exitTime).getTime();
    return ex <= at && at - ex <= win && metrics(o).net < 0;
  });
}

export function entryChecks(t, { settings, trades, dayIndex }) {
  const m = metrics(t);
  const maxRisk = settings.maxRiskPerTrade || Infinity;
  const hasStop = Boolean(t.stopSetAtEntry && t.initialStop != null);
  const out = [
    rule('logged', true, 10, 0, 'Trade logged', ''),
    rule('stop', hasStop, 15, -10, 'Stop-loss set before entry', 'No stop-loss at entry', true),
    rule('target', t.target != null, 5, 0, 'Target planned', 'No target planned'),
    rule('thesis', (t.thesis || '').trim().length >= 20, 10, 0, 'Wrote a trade thesis', 'Thesis under 20 characters'),
    rule('setup', Boolean((t.setup || '').trim()), 5, 0, 'Setup tagged', 'Setup not tagged'),
  ];
  if (m.riskAmt != null) {
    const ok = m.riskAmt <= maxRisk * 1.05;
    out.push(rule('risk', ok, 10, -20, `Risk within ₹${fmt(maxRisk)} limit`, `Oversized risk (₹${fmt(m.riskAmt)} > ₹${fmt(maxRisk)})`, true));
  } else {
    out.push({ id: 'risk', ok: false, xp: 0, label: 'Risk unknown (no stop)', disc: false });
  }
  out.push(rule('rr', m.plannedRR != null && m.plannedRR >= 2, 5, 0, 'Planned reward ≥ 2R', 'Planned reward below 2R'));
  const rev = isRevenge(t, trades, settings.revengeWindowMins);
  out.push(rule('revenge', !rev, 0, -15, 'No revenge entry', `Entered within ${settings.revengeWindowMins} min of a loss`, true));
  const lim = settings.maxTradesPerDay || Infinity;
  out.push(rule('overtrade', (dayIndex || 1) <= lim, 0, -10, 'Within daily trade limit', `Trade #${dayIndex} today (limit ${lim})`, true));
  return out;
}

export function exitChecks(t, m = metrics(t)) {
  const out = [
    rule('exitReason', Boolean(t.exitReason), 10, 0, 'Exit reason recorded', 'No exit reason'),
  ];
  if (t.followedPlan === true) out.push({ id: 'plan', ok: true, xp: 15, label: 'Followed the plan', disc: true });
  else if (t.followedPlan === false) out.push({ id: 'plan', ok: false, xp: -10, label: 'Broke the plan', disc: true });
  else out.push({ id: 'plan', ok: false, xp: 0, label: 'Plan adherence not recorded', disc: false });
  out.push(rule('lesson', (t.lessons || '').trim().length >= 10, 10, 0, 'Wrote a lesson', 'No lesson written'));
  const w = t.stopWidenCount || 0;
  out.push(rule('widen', w === 0, 0, -15 * Math.min(w, 3), 'Never widened the stop', `Widened the stop ${w}×`, true));
  if (m.net != null && m.net < 0 && m.r != null) {
    if (m.r >= -1.1) out.push({ id: 'honour', ok: true, xp: 15, label: 'Loss kept within 1R', disc: true });
    else if (m.r < -1.5) out.push({ id: 'honour', ok: false, xp: -20, label: `Loss ran to ${m.r.toFixed(1)}R`, disc: true });
    else out.push({ id: 'honour', ok: false, xp: 0, label: `Loss slightly past stop (${m.r.toFixed(2)}R)`, disc: true });
  }
  if (m.net > 0 && m.r != null) {
    if (m.r >= 3) out.push({ id: 'runner', ok: true, xp: 25, label: `Let a winner run (${m.r.toFixed(1)}R)`, disc: false });
    else if (m.r >= 2) out.push({ id: 'runner', ok: true, xp: 15, label: `2R+ winner (${m.r.toFixed(1)}R)`, disc: false });
  }
  return out;
}

const fmt = (n) => Math.round(n).toLocaleString('en-IN');

// ---------------------------------------------------------------------------
// Levels & badges
// ---------------------------------------------------------------------------
export const LEVELS = [
  [0, 'Rookie'], [150, 'Chart Watcher'], [400, 'Tape Reader'], [800, 'Setup Hunter'], [1400, 'Risk Keeper'],
  [2200, 'Swing Scout'], [3300, 'Position Pro'], [4700, 'Edge Builder'], [6500, 'Market Monk'], [9000, 'Zen Trader'],
];

export function levelFor(xp) {
  let i = 0;
  while (i + 1 < LEVELS.length && xp >= LEVELS[i + 1][0]) i++;
  let lvl = i + 1; let floor = LEVELS[i][0]; let next = LEVELS[i + 1]?.[0]; let title = LEVELS[i][1];
  if (next == null) {
    const extra = Math.floor((xp - floor) / 3000);
    lvl += extra; floor += extra * 3000; next = floor + 3000;
    if (extra) title = `Legend ${extra}`;
  }
  return { lvl, title, floor, next, xp, progress: (xp - floor) / (next - floor) };
}

export const BADGES = [
  { id: 'first', icon: '🎯', name: 'First Entry', desc: 'Log your first trade', goal: 1, val: (c) => c.entries },
  { id: 'live', icon: '⚡', name: 'Live Wire', desc: 'Log 5 entries at a live Kite price', goal: 5, val: (c) => c.liveEntries },
  { id: 'planner', icon: '🗺️', name: 'The Planner', desc: '10 trades with stop, target and thesis', goal: 10, val: (c) => c.fullPlans },
  { id: 'stopper', icon: '🛑', name: 'Stop Respecter', desc: 'Take 5 losses that stayed within 1R', goal: 5, val: (c) => c.cleanLosses },
  { id: 'runner', icon: '🚀', name: 'Let It Run', desc: 'Close a trade at 3R or better', goal: 1, val: (c) => c.bigWinners },
  { id: 'guardian', icon: '🛡️', name: 'Risk Guardian', desc: '20 entries in a row within your risk limit', goal: 20, val: (c) => c.riskStreak, best: (c) => c.bestRiskStreak },
  { id: 'iron', icon: '⛓️', name: 'Iron Discipline', desc: '10 clean trades in a row', goal: 10, val: (c) => c.discStreak, best: (c) => c.bestDiscStreak },
  { id: 'cool', icon: '🧊', name: 'Cool Head', desc: '25 entries in a row with no revenge trade', goal: 25, val: (c) => c.noRevengeStreak, best: (c) => c.bestNoRevenge },
  { id: 'scribe', icon: '✍️', name: 'Scribe', desc: 'Write lessons on 25 trades', goal: 25, val: (c) => c.lessons },
  { id: 'mirror', icon: '🪞', name: 'Mirror Time', desc: 'Complete 4 weekly reviews', goal: 4, val: (c) => c.reviews },
  { id: 'cleanweek', icon: '🧹', name: 'Clean Sweep', desc: 'Earn 5 clean-day bonuses', goal: 5, val: (c) => c.cleanDays },
  { id: 'patience', icon: '🧘', name: 'Patience Pays', desc: 'Hold a winner for 20+ days', goal: 1, val: (c) => c.longWins },
  { id: 'multi', icon: '🧭', name: 'Multi-Asset', desc: 'Trade 3 different segments', goal: 3, val: (c) => c.segments.size },
  { id: 'fifty', icon: '🏅', name: 'Half Century', desc: 'Log 50 trades', goal: 50, val: (c) => c.entries },
  { id: 'century', icon: '💯', name: 'Century', desc: 'Log 100 trades', goal: 100, val: (c) => c.entries },
  { id: 'greenmonth', icon: '📗', name: 'Green Month', desc: 'A finished month, net positive, with 5+ closed trades', goal: 1, val: (c) => c.greenMonths },
];

// ---------------------------------------------------------------------------
// Main computation
// ---------------------------------------------------------------------------
export function computeGame(state) {
  const { trades = [], reviews = [], settings = {} } = state;
  const events = [];
  const perTrade = {};

  // Entry order within each day (for the daily-limit rule).
  const dayIdx = {}; const dayCount = {};
  [...trades].sort((a, b) => new Date(a.entryTime) - new Date(b.entryTime)).forEach((t) => {
    const d = dayKey(t.entryTime); dayCount[d] = (dayCount[d] || 0) + 1; dayIdx[t.id] = dayCount[d];
  });

  const timeline = [];
  for (const t of trades) {
    timeline.push({ at: t.entryTime, type: 'entry', t });
    if (t.status === 'CLOSED' && t.exitTime) timeline.push({ at: t.exitTime, type: 'exit', t });
  }
  for (const rv of reviews) timeline.push({ at: rv.createdAt, type: 'review', rv });
  timeline.sort((a, b) => new Date(a.at) - new Date(b.at) || (a.type === 'entry' ? -1 : 1));

  const c = {
    entries: 0, liveEntries: 0, fullPlans: 0, cleanLosses: 0, bigWinners: 0, riskStreak: 0, bestRiskStreak: 0,
    discStreak: 0, bestDiscStreak: 0, noRevengeStreak: 0, bestNoRevenge: 0, lessons: 0, reviews: 0,
    segments: new Set(), longWins: 0, cleanDays: 0, greenMonths: 0,
  };
  const earned = {};
  const push = (at, items, ref) => {
    for (const it of items) {
      if (!it.xp) continue;
      events.push({ key: `${ref.key}:${it.id}`, at, xp: it.xp, label: it.label, tradeId: ref.tradeId || null, symbol: ref.symbol || '' });
    }
  };
  const checkBadges = (at) => { for (const b of BADGES) if (!earned[b.id] && b.val(c) >= b.goal) earned[b.id] = at; };

  for (const ev of timeline) {
    if (ev.type === 'entry') {
      const t = ev.t;
      const items = entryChecks(t, { settings, trades, dayIndex: dayIdx[t.id] });
      perTrade[t.id] = { entry: items, exit: [] };
      push(ev.at, items, { key: t.id + ':in', tradeId: t.id, symbol: t.symbol });
      const ok = (id) => items.find((i) => i.id === id)?.ok;
      c.entries++;
      if (t.entrySource && t.entrySource !== 'manual') c.liveEntries++;
      if (ok('stop') && ok('target') && ok('thesis')) c.fullPlans++;
      c.riskStreak = ok('risk') ? c.riskStreak + 1 : 0; c.bestRiskStreak = Math.max(c.bestRiskStreak, c.riskStreak);
      c.noRevengeStreak = ok('revenge') ? c.noRevengeStreak + 1 : 0; c.bestNoRevenge = Math.max(c.bestNoRevenge, c.noRevengeStreak);
      c.segments.add(t.segment);
    } else if (ev.type === 'exit') {
      const t = ev.t; const m = metrics(t);
      const items = exitChecks(t, m);
      perTrade[t.id].exit = items;
      push(ev.at, items, { key: t.id + ':out', tradeId: t.id, symbol: t.symbol });
      if ((t.lessons || '').trim().length >= 10) c.lessons++;
      if (m.net < 0 && m.r != null && m.r >= -1.1) c.cleanLosses++;
      if (m.r != null && m.r >= 3) c.bigWinners++;
      if (m.net > 0 && m.holdDays >= 20) c.longWins++;
      const clean = isClean(perTrade[t.id]);
      perTrade[t.id].clean = clean;
      c.discStreak = clean ? c.discStreak + 1 : 0; c.bestDiscStreak = Math.max(c.bestDiscStreak, c.discStreak);
    } else {
      push(ev.at, [{ id: 'review', xp: 40, label: `Weekly review (${ev.rv.weekStart})` }], { key: 'rv:' + ev.rv.weekStart });
      c.reviews++;
    }
    checkBadges(ev.at);
  }

  // Clean-day bonus: every entry that day had a stop, was within risk, not revenge, within limit.
  const byDay = {};
  for (const t of trades) (byDay[dayKey(t.entryTime)] ||= []).push(t);
  for (const [d, list] of Object.entries(byDay)) {
    const allOk = list.every((t) => (perTrade[t.id]?.entry || []).filter((i) => ['stop', 'risk', 'revenge', 'overtrade'].includes(i.id)).every((i) => i.ok));
    if (allOk) {
      const at = list.map((t) => t.entryTime).sort().at(-1);
      events.push({ key: 'day:' + d, at, xp: 20, label: `Clean trading day (${d})` });
      c.cleanDays++;
      if (!earned.cleanweek && c.cleanDays >= 5) earned.cleanweek = at;
    }
  }

  // Green month: finished months only.
  const months = {};
  for (const t of trades) if (t.status === 'CLOSED' && t.exitTime) {
    const k = t.exitTime.slice(0, 7); (months[k] ||= { n: 0, net: 0 }); months[k].n++; months[k].net += metrics(t).net;
  }
  const thisMonth = new Date().toISOString().slice(0, 7);
  for (const [k, v] of Object.entries(months).sort()) {
    if (k < thisMonth && v.n >= 5 && v.net > 0) { c.greenMonths++; if (!earned.greenmonth) earned.greenmonth = `${k}-28T12:00:00.000Z`; }
  }

  events.sort((a, b) => new Date(b.at) - new Date(a.at));
  const xp = Math.max(0, events.reduce((s, e) => s + e.xp, 0));
  const tradeXp = {};
  for (const e of events) if (e.tradeId) tradeXp[e.tradeId] = (tradeXp[e.tradeId] || 0) + e.xp;

  // Discipline score over the last 20 closed trades.
  const recent = trades.filter((t) => t.status === 'CLOSED' && t.exitTime).sort((a, b) => new Date(b.exitTime) - new Date(a.exitTime)).slice(0, 20);
  let pass = 0; let total = 0;
  for (const t of recent) for (const i of [...(perTrade[t.id]?.entry || []), ...(perTrade[t.id]?.exit || [])]) if (i.disc) { total++; if (i.ok) pass++; }

  const badges = BADGES.map((b) => {
    const cur = b.best ? b.best(c) : b.val(c);
    return { ...b, earned: Boolean(earned[b.id]), earnedAt: earned[b.id] || null, progress: Math.min(1, cur / b.goal), current: Math.min(cur, b.goal) };
  });

  return {
    xp, level: levelFor(xp), events, perTrade, tradeXp, badges, counters: c,
    discipline: total ? Math.round((pass / total) * 100) : null,
    disciplineSample: recent.length,
    streak: { current: c.discStreak, best: c.bestDiscStreak },
    quests: computeQuests(state),
  };
}

function isClean(pt) {
  const all = [...pt.entry, ...pt.exit];
  return all.filter((i) => i.disc).every((i) => i.ok) && all.some((i) => i.id === 'plan' && i.ok);
}

function computeQuests({ trades = [], reviews = [], settings = {} }) {
  const today = dayKey(new Date());
  const entered = trades.filter((t) => dayKey(t.entryTime) === today);
  const closedToday = trades.filter((t) => t.status === 'CLOSED' && t.exitTime && dayKey(t.exitTime) === today);
  const open = trades.filter((t) => t.status === 'OPEN');
  const lim = settings.maxTradesPerDay || 3;
  const q = [
    { id: 'plan', icon: '🎯', title: 'Plan every entry', desc: 'Each trade today has a stop-loss before entry',
      progress: entered.filter((t) => t.stopSetAtEntry).length, total: entered.length,
      idle: 'No entries yet — sitting out is a position too' },
    { id: 'limit', icon: '🚦', title: `Max ${lim} trades today`, desc: 'Stay within your daily trade limit',
      progress: entered.length, total: lim, done: entered.length > 0 && entered.length <= lim, failed: entered.length > lim, counter: true },
    { id: 'loop', icon: '🔁', title: 'Close the loop', desc: 'Exit reason + plan adherence on trades closed today',
      progress: closedToday.filter((t) => t.exitReason && t.followedPlan != null).length, total: closedToday.length,
      idle: 'Nothing closed today' },
    { id: 'guard', icon: '🛡️', title: 'Guard open positions', desc: 'Every open position has a stop-loss',
      progress: open.filter((t) => t.stopLoss != null).length, total: open.length, idle: 'No open positions' },
    { id: 'review', icon: '🪞', title: 'Weekly review', desc: "Reflect on this week's trades (+40 XP)",
      progress: reviews.some((r) => r.weekStart === weekStart()) ? 1 : 0, total: 1, weekly: true },
  ];
  for (const x of q) {
    if (x.done === undefined) x.done = x.total > 0 && x.progress >= x.total;
    x.isIdle = !x.counter && x.total === 0;
  }
  return q;
}
