import { exitsOf, tradeCharges } from './charges.js';
import { capitalEvents } from './capital.js';
// TradeQuest gamification engine.
// Everything is derived from the journal on every load, so editing or deleting a
// trade can never leave XP out of sync. XP rewards PROCESS, not profit.

export const dayKey = (d) => new Date(d).toLocaleDateString('en-CA'); // local YYYY-MM-DD
export const tradeKey = (t) => `${t.exchange}:${t.symbol}`;

// Trade types. Long-term holdings follow investing rules and stay out of trading stats.
export const HORIZONS = [['INTRADAY', 'Intraday'], ['SWING', 'Swing'], ['POSITIONAL', 'Positional'], ['LONGTERM', 'Long-term']];
export const HORIZON_LABEL = Object.fromEntries(HORIZONS);
export const isLT = (t) => t.horizon === 'LONGTERM';
export const isTrading = (t) => !isLT(t);
const DAY_MS = 86400000;
export const REVIEW_DAYS = 90;

/** When a long-term holding's next thesis review is due. */
export function reviewStatus(t, now = Date.now()) {
  // The clock starts when you began journaling the holding (not its old buy date),
  // so backfilled investments aren't instantly overdue.
  const started = [t.entryTime, t.createdAt].filter(Boolean).sort().at(-1);
  const last = (t.thesisReviews || []).map((r) => r.at).sort().at(-1) || started;
  const due = new Date(last).getTime() + REVIEW_DAYS * DAY_MS;
  return { last, due: new Date(due).toISOString(), overdue: now > due, daysLeft: Math.ceil((due - now) / DAY_MS) };
}

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
  // Exits (partial or full). Realised P&L is net of charges; a blank charges field means
  // "work them out from Zerodha's schedule".
  const exits = exitsOf(t);
  const exQty = exits.reduce((a, e) => a + (e.qty || 0), 0);
  const openQty = closed ? 0 : Math.max(0, qty - exQty);
  const realisedGross = exits.reduce((a, e) => a + (e.price - t.entryPrice) * dir * e.qty, 0);
  const chargesAuto = t.charges == null;
  const charges = exQty ? (chargesAuto ? tradeCharges(t).total : t.charges) : 0;
  const realised = exQty ? realisedGross - charges : 0;
  const unrealised = openQty ? (ltp != null && t.entryPrice != null ? (ltp - t.entryPrice) * dir * openQty : null) : 0;
  const px = closed ? t.exitPrice : ltp;
  const gross = closed ? realisedGross : unrealised == null ? (exQty ? realisedGross : null) : realisedGross + unrealised;
  const net = closed ? realised : unrealised == null ? (exQty ? realised : null) : realised + unrealised;
  const r = net != null && riskAmt > 0 ? net / riskAmt : null;
  const end = closed && t.exitTime ? new Date(t.exitTime) : new Date();
  const holdDays = t.entryTime ? Math.max(0, (end - new Date(t.entryTime)) / 86400000) : 0;
  const openRisk = !closed && t.stopLoss != null ? (t.entryPrice - t.stopLoss) * dir * openQty : null;
  return { dir, riskPerUnit, riskAmt, plannedRR, gross, net, r, value: (t.entryPrice || 0) * qty, holdDays, px, openRisk, closed, exits, exQty, openQty, realised, unrealised, charges, chargesAuto };
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

export const RULE_DEFAULTS = {
  capital: 100000, maxRiskPerTrade: 2000, maxTradesPerDay: 3, revengeWindowMins: 30,
  maxDailyLoss: 4000, maxPortfolioHeatPct: 6, maxPositionPct: 30, chaseTolerancePct: 1,
};

/** Every mistake the engine can detect, with a short name (used by Insights & the rulebook). */
export const MISTAKES = {
  stop: 'No stop-loss at entry', risk: 'Oversized risk per trade', impulse: 'Impulse trade (no setup, no thesis)',
  chase: 'Chased the entry past trigger', concentration: 'Too much capital in one stock', heat: 'Too much total open risk',
  averageDown: 'Averaged down a loser', revenge: 'Revenge entry after a loss', overtrade: 'Over daily trade limit',
  dailyLoss: 'Traded past daily loss limit', sizeUp: 'Sized up after losses (tilt)', plan: 'Broke the plan',
  widen: 'Widened the stop', honour: 'Loss ran past the stop', gaveBack: 'Let a winner turn into a loss',
  cutEarly: 'Cut a winner short', unreviewed: 'Closed without review',
  thesis: 'Investment without a thesis', sellCond: 'Investment without a sell condition',
  sellNoReason: 'Sold an investment without a reason', reviewOverdue: 'Thesis review overdue',
};

/** Mistakes only you can see — tag them honestly when closing a trade. */
export const MISTAKE_TAGS = {
  chased: 'Chased / entered late', noConfirm: 'Entered before confirmation', againstTrend: 'Traded against the trend',
  news: 'Ignored results/news risk', boredom: 'Traded out of boredom', tooBig: 'Size felt too big to sleep on',
  early: 'Exited too early out of fear', ignoredExit: 'Ignored my exit signal', movedTarget: 'Moved my target',
  noPlan: 'Had no exit plan',
};

const sum = (a) => a.reduce((x, y) => x + y, 0);

function concentrationCheck(t, m, s) {
  if (t.segment !== 'EQ' || !(s.capital > 0) || !(s.maxPositionPct > 0) || !m.value) return [];
  const p = m.value / s.capital;
  return [rule('concentration', p <= s.maxPositionPct / 100, 0, -10, 'Position size within limit', `${(p * 100).toFixed(0)}% of capital in one stock (limit ${s.maxPositionPct}%)`, true)];
}

/** Long-term investments: judged on thesis and exit plan, not stops and R. */
function investEntryChecks(t, s) {
  const m = metrics(t);
  return [
    rule('logged', true, 10, 0, 'Investment logged', ''),
    rule('thesis', (t.thesis || '').trim().length >= 20, 15, -10, 'Wrote an investment thesis', 'No investment thesis (20+ chars)', true),
    rule('sellCond', (t.sellCondition || '').trim().length >= 10, 10, -5, 'Wrote a sell condition', 'No sell condition — what would make you sell?', true),
    ...concentrationCheck(t, m, s),
  ];
}

function investExitChecks(t) {
  const out = [];
  if (t.exitReason) out.push({ id: 'exitReason', ok: true, xp: 10, label: 'Sell reason recorded', disc: false });
  else out.push({ id: 'sellNoReason', ok: false, xp: -10, label: 'Sold without a recorded reason', disc: true });
  if (t.followedPlan === true) out.push({ id: 'plan', ok: true, xp: 15, label: 'Sold per my sell condition', disc: true });
  else if (t.followedPlan === false) out.push({ id: 'plan', ok: false, xp: -10, label: 'Sold against my own plan', disc: true });
  out.push(rule('lesson', (t.lessons || '').trim().length >= 10, 10, 0, 'Wrote a lesson', 'No lesson written'));
  for (const tag of t.mistakes || []) out.push({ id: 'self:' + tag, ok: false, xp: -5, label: `Self-reported: ${MISTAKE_TAGS[tag] || tag}`, disc: true, self: true });
  return out;
}

export function entryChecks(t, { settings = {}, trades = [], dayIndex }) {
  const s = { ...RULE_DEFAULTS, ...settings };
  if (isLT(t)) return investEntryChecks(t, s);
  trades = trades.filter(isTrading);
  const m = metrics(t);
  const dir = m.dir;
  const maxRisk = s.maxRiskPerTrade || Infinity;
  const hasStop = Boolean(t.stopSetAtEntry && t.initialStop != null);
  const at = new Date(t.entryTime).getTime();
  const others = trades.filter((o) => o.id !== t.id && o.entryTime);
  const out = [
    rule('logged', true, 10, 0, 'Trade logged', ''),
    rule('stop', hasStop, 15, -10, 'Stop-loss set before entry', 'No stop-loss at entry', true),
    rule('target', t.target != null, 5, 0, 'Target planned', 'No target planned'),
    rule('thesis', (t.thesis || '').trim().length >= 20, 10, 0, 'Wrote a trade thesis', 'Thesis under 20 characters'),
    rule('setup', Boolean((t.setup || '').trim()), 5, 0, 'Setup tagged', 'Setup not tagged'),
  ];
  const impulse = !(t.thesis || '').trim() && !(t.setup || '').trim();
  out.push(rule('impulse', !impulse, 0, -10, 'Had a reason to trade', 'Impulse trade — no setup, no thesis', true));
  if (m.riskAmt != null) {
    out.push(rule('risk', m.riskAmt <= maxRisk * 1.05, 10, -20, `Risk within ₹${fmt(maxRisk)} limit`, `Oversized risk (₹${fmt(m.riskAmt)} > ₹${fmt(maxRisk)})`, true));
  } else {
    out.push({ id: 'risk', ok: false, xp: 0, label: 'Risk unknown (no stop)', disc: false });
  }
  out.push(rule('rr', m.plannedRR != null && m.plannedRR >= 2, 5, 0, 'Planned reward ≥ 2R', 'Planned reward below 2R'));
  if (t.plannedEntry > 0 && t.entryPrice) {
    const slip = ((t.entryPrice - t.plannedEntry) * dir) / t.plannedEntry;
    out.push(rule('chase', slip <= s.chaseTolerancePct / 100, 5, -10, 'Entered at your planned trigger', `Chased entry ${(slip * 100).toFixed(1)}% past trigger`, true));
  }
  out.push(...concentrationCheck(t, m, s));
  // Positions still open at the moment of this entry.
  const openAt = others.filter((o) => new Date(o.entryTime).getTime() < at && (o.status !== 'CLOSED' || !o.exitTime || new Date(o.exitTime).getTime() > at));
  if (s.capital > 0 && s.maxPortfolioHeatPct > 0 && m.riskAmt != null) {
    const heat = m.riskAmt + sum(openAt.map((o) => metrics(o).riskAmt || 0));
    out.push(rule('heat', heat <= (s.capital * s.maxPortfolioHeatPct) / 100 * 1.02, 0, -10, 'Total open risk within limit', `Total open risk ₹${fmt(heat)} > ${s.maxPortfolioHeatPct}% of capital`, true));
  }
  const avgDown = openAt.find((o) => o.symbol === t.symbol && o.side === t.side && (t.entryPrice - o.entryPrice) * dir < 0);
  out.push(rule('averageDown', !avgDown, 0, -15, 'No averaging down', `Averaged down on a losing ${t.symbol} position`, true));
  const rev = isRevenge(t, trades, s.revengeWindowMins);
  out.push(rule('revenge', !rev, 0, -15, 'No revenge entry', `Entered within ${s.revengeWindowMins} min of a loss`, true));
  const lim = s.maxTradesPerDay || Infinity;
  out.push(rule('overtrade', (dayIndex || 1) <= lim, 0, -10, 'Within daily trade limit', `Trade #${dayIndex} today (limit ${lim})`, true));
  if (s.maxDailyLoss > 0 && t.entryTime) {
    const dk = dayKey(t.entryTime);
    const lost = sum(others.filter((o) => o.status === 'CLOSED' && o.exitTime && dayKey(o.exitTime) === dk && new Date(o.exitTime).getTime() <= at).map((o) => metrics(o).net));
    out.push(rule('dailyLoss', lost > -s.maxDailyLoss, 0, -15, 'Under daily loss limit', `Traded after losing ₹${fmt(-lost)} today (limit ₹${fmt(s.maxDailyLoss)})`, true));
  }
  const prior = others.filter((o) => o.status === 'CLOSED' && o.exitTime && new Date(o.exitTime).getTime() <= at).sort((a, b) => new Date(b.exitTime) - new Date(a.exitTime));
  const twoLosses = prior.length >= 2 && metrics(prior[0]).net < 0 && metrics(prior[1]).net < 0;
  const risks = prior.slice(0, 10).map((o) => metrics(o).riskAmt).filter((v) => v > 0).sort((a, b) => a - b);
  const median = risks.length ? risks[Math.floor(risks.length / 2)] : null;
  const sizedUp = twoLosses && median && m.riskAmt != null && m.riskAmt > median * 1.3;
  out.push(rule('sizeUp', !sizedUp, 0, -15, 'Normal size after losses', 'Sized up after back-to-back losses (tilt)', true));
  return out;
}

export function exitChecks(t, m = metrics(t)) {
  if (isLT(t)) return investExitChecks(t);
  const out = [
    rule('exitReason', Boolean(t.exitReason), 10, 0, 'Exit reason recorded', 'No exit reason'),
  ];
  if (t.followedPlan === true) out.push({ id: 'plan', ok: true, xp: 15, label: 'Followed the plan', disc: true });
  else if (t.followedPlan === false) out.push({ id: 'plan', ok: false, xp: -10, label: 'Broke the plan', disc: true });
  else out.push({ id: 'plan', ok: false, xp: 0, label: 'Plan adherence not recorded', disc: false });
  if (!t.exitReason && t.followedPlan == null) out.push({ id: 'unreviewed', ok: false, xp: -5, label: 'Closed without reviewing the trade', disc: false });
  out.push(rule('lesson', (t.lessons || '').trim().length >= 10, 10, 0, 'Wrote a lesson', 'No lesson written'));
  const w = t.stopWidenCount || 0;
  out.push(rule('widen', w === 0, 0, -15 * Math.min(w, 3), 'Never widened the stop', `Widened the stop ${w}×`, true));
  if (m.net != null && m.net < 0 && m.r != null) {
    if (m.r >= -1.1) out.push({ id: 'honour', ok: true, xp: 15, label: 'Loss kept within 1R', disc: true });
    else if (m.r < -1.5) out.push({ id: 'honour', ok: false, xp: -20, label: `Loss ran to ${m.r.toFixed(1)}R`, disc: true });
    else out.push({ id: 'honour', ok: false, xp: 0, label: `Loss slightly past stop (${m.r.toFixed(2)}R)`, disc: true });
  }
  if (t.mfePrice != null && m.riskPerUnit > 0 && m.net != null && m.net < 0) {
    const mfeR = ((t.mfePrice - t.entryPrice) * m.dir) / m.riskPerUnit;
    if (mfeR >= 1) out.push({ id: 'gaveBack', ok: false, xp: -15, label: `Let a +${mfeR.toFixed(1)}R winner turn into a loss`, disc: true });
  }
  if (m.net > 0 && m.r != null && m.r < 1 && t.target != null && (!t.exitReason || t.exitReason === 'Discretionary')) {
    out.push({ id: 'cutEarly', ok: false, xp: -10, label: `Cut a winner short at ${m.r.toFixed(2)}R (discretionary exit)`, disc: true });
  }
  if (m.net > 0 && m.r != null) {
    if (m.r >= 3) out.push({ id: 'runner', ok: true, xp: 25, label: `Let a winner run (${m.r.toFixed(1)}R)`, disc: false });
    else if (m.r >= 2) out.push({ id: 'runner', ok: true, xp: 15, label: `2R+ winner (${m.r.toFixed(1)}R)`, disc: false });
  }
  for (const tag of t.mistakes || []) {
    out.push({ id: 'self:' + tag, ok: false, xp: -5, label: `Self-reported: ${MISTAKE_TAGS[tag] || tag}`, disc: true, self: true });
  }
  return out;
}

/** Name for any mistake item (auto-detected or self-reported). */
export const mistakeName = (i) => (i.self ? `${i.label.replace('Self-reported: ', '')} (self-reported)` : MISTAKES[i.id] || i.label);
/** Items that count as a mistake: lost XP, or a failed discipline check. */
export const isMistake = (i) => i.xp < 0 || (i.disc && !i.ok);

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
  { id: 'honest', icon: '🔍', name: 'Honest Mirror', desc: 'Self-report 5 mistakes you made', goal: 5, val: (c) => c.selfReports },
  { id: 'thesisrev', icon: '📚', name: 'Thesis Keeper', desc: 'Complete 4 thesis reviews on long-term holdings', goal: 4, val: (c) => c.thesisReviews },
  { id: 'longgame', icon: '🌳', name: 'The Long Game', desc: 'Hold a long-term investment for a year', goal: 1, val: (c) => c.longHolds },
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
  const { reviews = [], settings = {} } = state;
  // Trades imported from a tradebook count in P&L and stats but never earn or lose XP.
  const all = state.trades || [];
  const trades = all.filter((t) => !t.imported);
  const events = [];
  const perTrade = {};
  for (const t of all) if (t.imported) perTrade[t.id] = { entry: [], exit: [], penalties: [], mistakes: [], imported: true };

  // Entry order within each day (for the daily-limit rule).
  const dayIdx = {}; const dayCount = {};
  [...trades].filter(isTrading).sort((a, b) => new Date(a.entryTime) - new Date(b.entryTime)).forEach((t) => {
    const d = dayKey(t.entryTime); dayCount[d] = (dayCount[d] || 0) + 1; dayIdx[t.id] = dayCount[d];
  });

  const timeline = [];
  for (const t of trades) {
    timeline.push({ at: t.entryTime, type: 'entry', t });
    if (t.status === 'CLOSED' && t.exitTime) timeline.push({ at: t.exitTime, type: 'exit', t });
  }
  for (const rv of reviews) timeline.push({ at: rv.createdAt, type: 'review', rv });
  for (const t of trades) for (const r of t.thesisReviews || []) timeline.push({ at: r.at, type: 'thesis', t, r });
  timeline.sort((a, b) => new Date(a.at) - new Date(b.at) || (a.type === 'entry' ? -1 : 1));

  const c = {
    entries: 0, liveEntries: 0, fullPlans: 0, cleanLosses: 0, bigWinners: 0, riskStreak: 0, bestRiskStreak: 0,
    discStreak: 0, bestDiscStreak: 0, noRevengeStreak: 0, bestNoRevenge: 0, lessons: 0, reviews: 0,
    segments: new Set(), longWins: 0, cleanDays: 0, greenMonths: 0, selfReports: 0, thesisReviews: 0, longHolds: 0,
  };
  const earned = {};
  const push = (at, items, ref) => {
    for (const it of items) {
      if (!it.xp) continue;
      events.push({ key: `${ref.key}:${it.id}`, at, xp: it.xp, label: it.label, tradeId: ref.tradeId || null, symbol: ref.symbol || '' });
    }
  };
  const lastThesisAward = {};
  const checkBadges = (at) => { for (const b of BADGES) if (!earned[b.id] && b.val(c) >= b.goal) earned[b.id] = at; };

  for (const ev of timeline) {
    if (ev.type === 'entry') {
      const t = ev.t;
      const items = entryChecks(t, { settings, trades, dayIndex: dayIdx[t.id] });
      perTrade[t.id] = { entry: items, exit: [] };
      push(ev.at, items, { key: t.id + ':in', tradeId: t.id, symbol: t.symbol });
      const ok = (id) => items.find((i) => i.id === id)?.ok;
      c.entries++;
      c.segments.add(t.segment);
      if (t.entrySource && t.entrySource !== 'manual') c.liveEntries++;
      if (isLT(t)) { checkBadges(ev.at); continue; }
      if (ok('stop') && ok('target') && ok('thesis')) c.fullPlans++;
      c.riskStreak = ok('risk') ? c.riskStreak + 1 : 0; c.bestRiskStreak = Math.max(c.bestRiskStreak, c.riskStreak);
      c.noRevengeStreak = ok('revenge') ? c.noRevengeStreak + 1 : 0; c.bestNoRevenge = Math.max(c.bestNoRevenge, c.noRevengeStreak);
    } else if (ev.type === 'exit') {
      const t = ev.t; const m = metrics(t);
      const items = exitChecks(t, m);
      perTrade[t.id].exit = items;
      push(ev.at, items, { key: t.id + ':out', tradeId: t.id, symbol: t.symbol });
      if ((t.lessons || '').trim().length >= 10) c.lessons++;
      c.selfReports += (t.mistakes || []).length;
      if (isLT(t)) { checkBadges(ev.at); continue; }
      if (m.net < 0 && m.r != null && m.r >= -1.1) c.cleanLosses++;
      if (m.r != null && m.r >= 3) c.bigWinners++;
      if (m.net > 0 && m.holdDays >= 20) c.longWins++;
      const clean = isClean(perTrade[t.id]);
      perTrade[t.id].clean = clean;
      c.discStreak = clean ? c.discStreak + 1 : 0; c.bestDiscStreak = Math.max(c.bestDiscStreak, c.discStreak);
    } else if (ev.type === 'thesis') {
      // One rewarded review per holding every 60 days (the first after 30 days in), so it can't be farmed.
      const t = ev.t; const at = new Date(ev.r.at).getTime();
      const lastAward = lastThesisAward[t.id] ?? new Date(t.entryTime).getTime() - 30 * DAY_MS;
      if (at - lastAward >= 60 * DAY_MS) {
        lastThesisAward[t.id] = at; c.thesisReviews++;
        push(ev.r.at, [{ id: 'thesis', xp: 20, label: `Thesis review${ev.r.thesisIntact === false ? ' (thesis broken)' : ''}` }], { key: `${t.id}:tr:${ev.r.id}`, tradeId: t.id, symbol: t.symbol });
      }
    } else {
      push(ev.at, [{ id: 'review', xp: 40, label: `Weekly review (${ev.rv.weekStart})` }], { key: 'rv:' + ev.rv.weekStart });
      c.reviews++;
    }
    checkBadges(ev.at);
  }

  // Compounding: several mistakes on one trade cost extra, and repeating a mistake
  // made in any of your previous 5 trades costs extra again.
  const history = [];
  const nowMs = Date.now();
  for (const t of trades.filter(isLT)) {
    const pt = perTrade[t.id]; if (!pt) continue;
    const extra = [];
    if (t.status === 'OPEN') {
      const rs = reviewStatus(t, nowMs);
      const late = new Date(rs.due).getTime() + 30 * DAY_MS;
      if (nowMs > late) extra.push({ id: 'reviewOverdue', xp: -10, label: 'Thesis review overdue', at: new Date(late).toISOString() });
    }
    const end = t.status === 'CLOSED' && t.exitTime ? new Date(t.exitTime).getTime() : nowMs;
    const yearAt = new Date(t.entryTime).getTime() + 365 * DAY_MS;
    if (end >= yearAt) { c.longHolds++; if (!earned.longgame) earned.longgame = new Date(yearAt).toISOString(); }
    pt.penalties = extra;
    pt.mistakes = [...pt.entry, ...pt.exit, ...extra].filter(isMistake);
    for (const e of extra) push(e.at, [e], { key: t.id + ':pen', tradeId: t.id, symbol: t.symbol });
  }
  for (const t of trades.filter(isTrading).sort((a, b) => new Date(a.entryTime) - new Date(b.entryTime))) {
    const pt = perTrade[t.id]; if (!pt) continue;
    const errs = [...pt.entry, ...pt.exit].filter((i) => i.xp < 0);
    const extra = [];
    if (errs.length >= 2) extra.push({ id: 'stack', xp: -Math.min(40, 10 * (errs.length - 1)), label: `Mistake stack: ${errs.length} errors on one trade` });
    const recent = new Set(history.slice(-5).flat());
    errs.filter((e) => recent.has(e.id)).slice(0, 3).forEach((e) => extra.push({ id: 'repeat:' + e.id, xp: -5, label: `Repeat mistake: ${mistakeName(e)}` }));
    history.push(errs.map((e) => e.id));
    pt.penalties = extra;
    pt.mistakes = [...pt.entry, ...pt.exit].filter(isMistake);
    push(t.status === 'CLOSED' && t.exitTime ? t.exitTime : t.entryTime, extra, { key: t.id + ':pen', tradeId: t.id, symbol: t.symbol });
  }

  // Clean-day bonus: every entry that day passed every entry discipline check.
  const byDay = {};
  for (const t of trades.filter(isTrading)) (byDay[dayKey(t.entryTime)] ||= []).push(t);
  for (const [d, list] of Object.entries(byDay)) {
    const allOk = list.every((t) => (perTrade[t.id]?.entry || []).filter((i) => i.disc).every((i) => i.ok));
    if (allOk) {
      const at = list.map((t) => t.entryTime).sort().at(-1);
      events.push({ key: 'day:' + d, at, xp: 20, label: `Clean trading day (${d})` });
      c.cleanDays++;
      if (!earned.cleanweek && c.cleanDays >= 5) earned.cleanweek = at;
    }
  }

  // Green month: finished months only.
  const months = {};
  for (const t of trades.filter(isTrading)) if (t.status === 'CLOSED' && t.exitTime) {
    const k = t.exitTime.slice(0, 7); (months[k] ||= { n: 0, net: 0 }); months[k].n++; months[k].net += metrics(t).net;
  }
  const thisMonth = new Date().toISOString().slice(0, 7);
  for (const [k, v] of Object.entries(months).sort()) {
    if (k < thisMonth && v.n >= 5 && v.net > 0) { c.greenMonths++; if (!earned.greenmonth) earned.greenmonth = `${k}-28T12:00:00.000Z`; }
  }

  // Capital rules: sweeping profit out, and not trading through the kill switch.
  events.push(...capitalEvents(state));

  for (const b of BADGES) if (!earned[b.id] && b.val(c) >= b.goal) earned[b.id] = new Date().toISOString();
  events.sort((a, b) => new Date(b.at) - new Date(a.at));
  const xp = Math.max(0, events.reduce((s, e) => s + e.xp, 0));
  const tradeXp = {};
  for (const e of events) if (e.tradeId) tradeXp[e.tradeId] = (tradeXp[e.tradeId] || 0) + e.xp;

  // Discipline score over the last 20 closed trades.
  const recent = trades.filter((t) => isTrading(t) && t.status === 'CLOSED' && t.exitTime).sort((a, b) => new Date(b.exitTime) - new Date(a.exitTime)).slice(0, 20);
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
    quests: computeQuests({ ...state, trades }),
  };
}

function isClean(pt) {
  const all = [...pt.entry, ...pt.exit];
  return all.filter((i) => i.disc).every((i) => i.ok) && all.some((i) => i.id === 'plan' && i.ok);
}

function computeQuests({ trades: all = [], reviews = [], settings = {} }) {
  const trades = all.filter(isTrading);
  const lt = all.filter((t) => isLT(t) && t.status === 'OPEN');
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
  if (lt.length) {
    const ok = lt.filter((t) => !reviewStatus(t).overdue).length;
    q.push({ id: 'thesis', icon: '📚', title: 'Thesis reviews up to date', desc: `Review each long-term holding every ${REVIEW_DAYS} days (+20 XP)`, progress: ok, total: lt.length });
  }
  for (const x of q) {
    if (x.done === undefined) x.done = x.total > 0 && x.progress >= x.total;
    x.isIdle = !x.counter && x.total === 0;
  }
  return q;
}
