// `npm run demo` — runs TradeQuest with simulated Kite prices and a sample journal
// in ./demo-data, so you can explore every screen without touching your real data.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'demo-data');
process.env.DATA_DIR = DIR;
process.env.KITE_MOCK = '1';

let seed = 42;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const round = (v, tick = 0.05) => Math.round(v / tick) * tick;

const UNIVERSE = [
  ['RELIANCE', 'NSE', 'EQ', 1420, 1], ['INFY', 'NSE', 'EQ', 1520, 1], ['ITC', 'NSE', 'EQ', 410, 1], ['SBIN', 'NSE', 'EQ', 870, 1],
  ['TATAMOTORS', 'NSE', 'EQ', 690, 1], ['TITAN', 'NSE', 'EQ', 3500, 1], ['LT', 'NSE', 'EQ', 3700, 1], ['TRENT', 'NSE', 'EQ', 4900, 1],
  ['SBIN26DECFUT', 'NFO', 'FUT', 873, 750], ['RELIANCE26DECFUT', 'NFO', 'FUT', 1425, 500], ['GOLDM26DECFUT', 'MCX', 'COM', 122000, 10],
];
const SETUPS = ['Breakout', 'Pullback', 'Range breakout', 'Trend continuation', 'Support bounce'];
const EMO = ['Calm', 'Confident', 'Calm', 'Confident', 'FOMO', 'Anxious'];
const THESES = [
  'Breaking out of a 3-month base on 2x average volume; sector flows positive. Invalid on a close back inside the range.',
  'Pullback to rising 20 EMA in a clean uptrend, higher lows intact. Invalid below the swing low.',
  'Range breakout after results; strong delivery %. Target = measured move of the range.',
  'Trend continuation after a tight flag; Nifty supportive. Stop under flag low.',
];
const LESSONS = [
  'Waited for the close above the level — patience paid. Repeat.',
  'Took the stop cleanly. Setup was fine, market was not.',
  'Entered late out of FOMO; should have skipped once price ran 2% past trigger.',
  'Trailed the stop under higher lows and let it run. More of this.',
  'Exited early on noise; the plan said hold until stop or target.',
];

const trades = [];
const now = Date.now();
for (let i = 0; i < 34; i++) {
  const [symbol, exchange, segment, base, lot] = pick(UNIVERSE);
  const daysAgo = 95 - i * 2.7 - rnd();
  const entryTime = new Date(now - daysAgo * 86400e3);
  while (entryTime.getDay() === 0 || entryTime.getDay() === 6) entryTime.setDate(entryTime.getDate() - 1);
  entryTime.setHours(10 + Math.floor(rnd() * 4), Math.floor(rnd() * 60), 0, 0);
  const side = rnd() < 0.8 ? 'LONG' : 'SHORT';
  const dir = side === 'LONG' ? 1 : -1;
  const entry = round(base * (0.9 + rnd() * 0.2));
  const sloppy = rnd() < 0.2; // a few rule-breakers
  // Equity: 5–8% stops. F&O/commodity: stop sized so one lot risks ~₹1,900 (2.5× that when sloppy).
  const stopDist = segment === 'EQ' ? entry * (0.05 + rnd() * 0.03) : ((sloppy ? 4800 : 1900) * (0.85 + rnd() * 0.15)) / lot;
  const stop = round(entry - dir * stopDist);
  const riskPU = Math.abs(entry - stop);
  let qty = Math.max(lot, Math.floor((sloppy ? 3200 : 1900) / riskPU / lot) * lot);
  const hasStop = !(sloppy && rnd() < 0.4);
  const target = round(entry + dir * riskPU * (2 + rnd() * 1.5));
  const open = i >= 31;
  const t = {
    id: randomUUID(), symbol, exchange, segment, side, qty, entryPrice: entry, lotSize: lot > 1 ? lot : null,
    stopLoss: hasStop ? stop : null, initialStop: hasStop ? stop : null, stopSetAtEntry: hasStop, target,
    setup: pick(SETUPS), thesis: rnd() < 0.85 ? pick(THESES) : 'Looks strong', emotionEntry: sloppy ? 'FOMO' : pick(EMO),
    confidence: 2 + Math.floor(rnd() * 4), entryTime: entryTime.toISOString(), entrySource: rnd() < 0.5 ? 'live' : 'manual',
    tags: [], stopWidenCount: 0, stopHistory: [], status: 'OPEN', createdAt: entryTime.toISOString(), updatedAt: entryTime.toISOString(),
  };
  if (!open) {
    const outcome = rnd();
    let r = outcome < 0.42 ? -(0.8 + rnd() * 0.3) : outcome < 0.55 ? 0.2 + rnd() * 0.8 : outcome < 0.85 ? 1.6 + rnd() * 1.2 : 3 + rnd() * 1.4;
    if (sloppy) r = outcome < 0.7 ? -(1.3 + rnd() * 0.9) : 0.3 + rnd() * 0.6; // rule-breakers mostly lose, and lose big
    const exitTime = new Date(entryTime.getTime() + (1 + rnd() * (segment === 'EQ' ? 25 : 4)) * 86400e3);
    Object.assign(t, {
      status: 'CLOSED', exitPrice: round(entry + dir * riskPU * r), exitTime: exitTime.toISOString(), charges: Math.round(20 + rnd() * 60),
      exitReason: r < -0.6 ? 'Stop hit' : r > 1.8 ? pick(['Target hit', 'Trailing stop']) : pick(['Discretionary', 'Thesis invalid', 'Time exit']),
      followedPlan: !sloppy && rnd() < 0.9, emotionExit: r > 0 ? pick(['Satisfied', 'Calm']) : pick(['Calm', 'Frustrated']),
      lessons: rnd() < 0.8 ? pick(LESSONS) : '', rating: sloppy ? 2 : 3 + Math.floor(rnd() * 3), exitSource: rnd() < 0.5 ? 'live' : 'manual',
    });
    if (sloppy && hasStop && rnd() < 0.6) {
      t.stopWidenCount = 1;
      t.stopLoss = round(stop - dir * riskPU * 0.5);
      t.stopHistory = [{ at: new Date(entryTime.getTime() + 86400e3).toISOString(), from: stop, to: t.stopLoss }];
    }
  }
  trades.push(t);
}

const ws = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x.toLocaleDateString('en-CA'); };
const reviews = [3, 2, 1].map((w) => {
  const d = new Date(now - w * 7 * 86400e3);
  return { id: randomUUID(), weekStart: ws(d), wentWell: 'Took every stop without hesitation; sized every trade to ₹2,000 risk.', improve: 'One FOMO entry after a big green candle — wait for the retest.', focus: 'Only A+ breakouts with volume', rating: 4, createdAt: new Date(ws(d) + 'T18:00:00').toISOString() };
});

if (!existsSync(path.join(DIR, 'journal.json'))) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(path.join(DIR, 'journal.json'), JSON.stringify({ version: 1, settings: { displayName: 'Demo Trader', capital: 100000, maxRiskPerTrade: 2000, maxTradesPerDay: 3, revengeWindowMins: 30 }, trades, reviews }, null, 2));
  console.log('  Seeded demo journal in ./demo-data');
}

await import('../server.js');
