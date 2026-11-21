# ⚔️ TradeQuest

A gamified stock-trading journal for Indian markets, with light and night modes. You can type prices in yourself, or pull **live prices from Zerodha Kite Connect**.

The game rewards **process, not profit**. You earn XP for setting a stop before entry, keeping risk inside your limit, following your plan, honouring stops and writing lessons. You lose XP for revenge trades, oversized positions, widened stops and broken plans. A disciplined loss earns more than a lucky, oversized win.

![Dashboard](docs/dashboard.png)

## Quick start

Requires **Node.js 18+**. There are no npm dependencies.

```bash
git clone https://github.com/vikslap/tradeq.git
cd tradeq

npm run demo     # try it: sample journal + simulated prices → http://127.0.0.1:5173
npm start        # your real journal (data/journal.json)
```

Demo mode keeps its data in `demo-data/` and never touches your real journal.

## Connecting Zerodha Kite (live prices)

1. Create an app at [developers.kite.trade](https://developers.kite.trade). Live quotes need the paid **Kite Connect** plan.
2. Set the app's **Redirect URL** to `http://127.0.0.1:5173/api/kite/callback`.
3. Copy `.env.example` to `.env` and fill in `KITE_API_KEY` and `KITE_API_SECRET`.
4. Run `npm start`, open **Settings → Connect to Kite** and log in.

Kite sessions expire around 6 AM every day, so connect once each morning. Your API secret stays on the server and is never sent to the browser. The server listens on `127.0.0.1` only.

**With Kite connected you get:**
- **⚡ Live** buttons that fill entry and exit prices with the current LTP. Entries made this way are tagged, and the *Live Wire* badge counts them.
- Symbol search across NSE, BSE, NFO and MCX, with lot sizes. The instrument list is cached daily.
- Live MTM, R-multiple and day change for open positions, refreshed every 5 seconds.
- **Today's Kite fills**: turn an executed order into a journal entry, or use it as the exit of a matching open trade.
- **Interactive trade charts**: every trade opens on a zoomable, scrollable candlestick chart, powered by TradingView's open-source [Lightweight Charts](https://github.com/tradingview/lightweight-charts) and bundled in `public/vendor`. It shows an OHLC readout under the crosshair, volume, and optional EMA 20/50/200. Entry, stop, target and exit are drawn as labelled lines. Your stop is plotted **as it moved over time** (a stepped line with a marker at each trail), and the time you were in the trade is shaded. You can switch candles (5m / 15m / 1h / 1D / 1W) or click **Expand** for a full-screen view. Open trades update live. Charts of closed trades are saved on your PC, so they load instantly and work offline.
- **Drawing tools** on every chart (trade charts, full screen, Practice and its review):
  - **╱ Trend**: two clicks. Points snap to the nearest candle open, high, low or close.
  - **─ Level**: a horizontal line in one click.
  - **📏 Ruler**: two clicks, or **Shift+click** anywhere. It shows the price change, %, bars and time between the points.
  - Click a drawing to select it, drag its ends to adjust, and press **Delete** to remove it. **Esc** cancels, and 🗑 clears the chart.
  - Drawings are anchored to time and price, so they stay put when you change candle size. They're saved per trade (and per practice session) in your browser.
- **Best / worst price from candles**: the chart also records the best and worst price each trade reached, even if the app wasn't open. That lets the *winner turned into a loss* check catch trades that went +1R and then closed red.
- **Sync with Kite**: compares your open journal trades with your Kite holdings and positions. It flags positions **not in the journal** (one-click *Log trade*), positions **closed at Kite** but still open in the journal (one-click *Close*, with the exit price filled in), and **quantity differences**. The dashboard shows *✓ Matches Kite* or *⚠ N out of sync*, and adds a *Books match Kite* quest.

Without Kite, everything works in manual mode.

## Features

- **Pre-trade check.** Shows position value, risk in ₹ and as a % of capital, and reward:risk. One click sizes the position to your ₹ risk limit, rounded to lot size. It also previews the XP the entry will earn *before* you log it.
- **Close-trade review.** Records exit reason, whether you followed the plan, emotion, lesson and an execution grade. It previews P&L, R and exit XP.
- **Stop tracking.** Trailing a stop is free. Widening one is recorded and penalised. A "typo fix" checkbox lets you correct the original stop without a penalty.
- **Dashboard.** Level, XP, discipline score, clean-trade streak, daily quests, KPIs, open positions, equity curve and XP feed.
- **Insights.** Clean vs rule-breaking trades, the P&L cost of each mistake, R distribution, and P&L by setup, emotion, weekday, exit reason, segment and side. Also a daily P&L heatmap.
- **Weekly review.** The week's stats, a reflection form and a history of past reviews (+40 XP each).
- **Achievements.** A level path, 16 badges with progress bars, the full XP rulebook and an XP log.
- **Data.** Everything lives in one JSON file. It is written atomically, backed up on every start, and can be exported or imported from Settings.

![Insights](docs/insights.png)

## Importing your Zerodha tradebook

Kite's live data has your holdings and today's trades, but not your history or buy dates. Those live in **Console**. To bring them in:

1. In [Console → Reports → Tradebook](https://console.zerodha.com/reports/tradebook), pick a segment and a date range (up to a year at a time) and download it as **CSV**.
2. In TradeQuest, go to **Journal → ⬆ Import tradebook** (or Settings) and drop in one or more files.
3. Review what it found, untick anything you don't want, and click **Import selected**.

The import pairs buys and sells into complete trades. Adding to a position counts as one trade, which closes when the position is flat again. A partial exit at the end of the file is split into a closed part and an open remainder. Same-day short trades in cash equity and futures position flips are both handled. Then it shows you:
- **Fix entry dates**: open journal trades (e.g. logged via Kite sync) get their real buy date and average price.
- **Close trades you've sold**: journal trades the tradebook shows were sold, closed at the actual sell price.
- **Trades not in your journal**: past trades you never logged, with a type picked from holding period that you can change.
- **Skipped**: trades already in the journal, fills imported before (safe to re-import), and sales of shares bought before the file's dates.

Imported trades count in your P&L, equity curve and Insights, but **don't earn or lose XP**. XP is for journaling as you trade.

## 🎮 Practice: chart replay

A separate section for paper trading on **real historical Kite candles**. Nothing in it touches your journal, stats or Zerodha account.

- **Start a replay**: type a stock or index (e.g. `RELIANCE`, `NIFTY 50`) or press **🎲 Surprise me** for a random liquid NSE stock on a random past date. Choose daily, hourly, 15-min or 5-min candles.
- **Blind mode** (on by default) hides the name and dates, so you trade the chart, not what you remember. Everything is revealed at the end.
- **🎲 New chart**: don't like the chart? Skip to a fresh surprise with the same settings. With no paper trades it's simply discarded; with trades, the session is saved to your history first.
- **Step through** bar by bar (**→** or Space), +10 bars, or auto-play at 1× / 2× / 5×.
- **Order types**: **Market** fills at the next bar's open. **Limit** buys at or below your price (shorts at or above), for pullback entries. **Stop (breakout)** buys when price rises to your trigger (shorts when it falls to it). Pending orders show as dotted lines, stay open until filled or cancelled, and can be modified. They fill at your price, or at the open if price gaps through it.
- **Orders fill realistically**: market orders fill at the next bar's open. Stops and targets fill intrabar, **at the open if price gaps past them** (so gap-downs hurt, just like real life). If one bar hits both, the stop is assumed first. On the bar a limit or stop order fills mid-bar, only the stop is checked, since the target may have been hit before you were in.
- Size to your ₹ risk in one click, trail the stop (free) or widen it (costs XP), and exit at the next open.
- **Practice XP** follows the journal's habits (stop before entry, risk within limit, losses held to 1R, letting winners run) and is kept separate from your real XP.
- **Review**: when the session ends you see the full chart, including what happened after you stopped, plus every paper trade with its R and XP. You can resume unfinished sessions any time.

Kite's historical data covers stocks and indices (daily for many years, intraday for recent years) and current futures. Expired option contracts aren't available. Past candles are cached on your PC.

## Linked positions (pairs, spreads, hedges)

In **Journal**, tick two or more trades and click **🔗 Link as one position**. It suggests a name such as *NIFTY 26N17 23400/23600 CE*, which you can change.

- In **stats** (win rate, best/worst trade, average R, expectancy, Insights, equity curve and drawdown), the legs count as **one trade**. Net P&L is the sum of the legs and R is measured against their combined initial risk. The result is booked on the day the **last** leg closes, and until every leg is closed the position stays out of closed-trade stats.
- Each leg keeps its own record, chart and XP.
- A trade's side panel shows the other legs and the combined P&L, with **Rename**, **Unlink this leg** and **Unlink all**.

## Trade types and long-term investments

Every entry has a **type**: Intraday, Swing, Positional or Long-term. Trades logged before types existed were tagged automatically: same-day trades as Intraday, up to 20 days as Swing, longer as Positional. You can change any of them.

- **Trading stats stay pure.** The dashboard KPIs, win rate, R, discipline score, clean streak, daily limits and open-risk checks only count Intraday, Swing and Positional trades.
- **The equity curve and Insights have a filter**: *Trading / Long-term / All*. Insights also shows **P&L by trade type**, so you can see which style actually works for you.
- **Long-term holdings follow investing rules.** There's no stop, target or R. Instead they're judged on an investment thesis and a **sell condition** ("what would make me sell?"). You do a **thesis review every 90 days** (+20 XP, rewarded at most every 60 days), and you lose XP if a review is 30+ days overdue or if you sell without a reason or against your own sell condition. The concentration limit still applies.
- **Holdings panel** on the dashboard: invested amount, value, P&L, return, **CAGR per holding** and **portfolio XIRR**, with when each review is due.
- **Kite sync** matches holdings across types: for example 140 ITC as a swing trade plus 60 as a long-term holding = 200 at Kite. You can **Ignore** old holdings you don't want to journal; manage them in Settings.

## How XP works

### Earn
| Rule | XP |
|---|---|
| Trade logged | +10 |
| Stop-loss set before entry | +15 |
| Risk within your ₹ limit | +10 |
| Thesis (20+ chars) · target · setup tag · planned ≥ 2R | +10 · +5 · +5 · +5 |
| Entered at your planned trigger | +5 |
| Exit reason · lesson written | +10 · +10 |
| Followed the plan | +15 |
| Loss kept within 1R | +15 |
| 2R+ / 3R+ winner (let it run) | +15 / +25 |
| Clean trading day | +20 |
| Weekly review | +40 |

### Lose: the mistakes it catches
| Mistake | How it's detected | XP |
|---|---|---|
| No stop-loss at entry | no stop when logged | −10 |
| Oversized risk | risk to stop > your ₹ limit | −20 |
| Impulse trade | no setup and no thesis | −10 |
| Chased the entry | entry beyond your planned trigger by more than the tolerance | −10 |
| Too much capital in one stock | cash-equity position > X% of capital | −10 |
| Too much total open risk | all open trades' risk to stop > X% of capital | −10 |
| Averaged down | added to an open position that was losing | −15 |
| Revenge entry | new entry within N minutes of a losing exit | −15 |
| Over daily trade limit | more than N entries in a day | −10 |
| Traded past daily loss limit | entry after the day's realised loss hit your limit | −15 |
| Sized up after losses (tilt) | after 2 straight losses, risk > 1.3× your usual size | −15 |
| Broke the plan | you answer "No" when closing | −10 |
| Widened the stop | stop moved further away (trailing is free) | −15 each, max 3 |
| Loss ran past the stop | loss worse than −1.5R | −20 |
| Winner turned into a loss | was +1R or better (tracked from live prices, or entered manually), closed red | −15 |
| Cut a winner short | discretionary exit under 1R with a target set | −10 |
| Closed without review | no exit reason and no plan answer | −5 |
| Self-reported mistakes | chased, ignored news, boredom, moved target… (you tick them) | −5 each |

**Mistakes compound.** Two or more mistakes on one trade add a **stack penalty** of −10 for each extra mistake (max −40). Repeating any mistake from your last 5 trades costs another **−5**. Self-reported mistakes cost less than detected ones, so being honest is always cheaper. The *Honest Mirror* badge rewards it.

XP is recalculated from the journal on every load. Editing or deleting a trade can't leave XP out of sync, and it can't be used to farm XP. You set every limit (risk, daily loss, open risk, position size, chase tolerance, trade count, revenge window) in **Settings**.

**Discipline score** is the share of rule checks passed over your last 20 closed trades. **Clean streak** counts consecutive closed trades where every rule was kept and the plan was followed.

![New trade](docs/new-trade.png)

## Project layout

```
server.js            HTTP server + JSON API (no dependencies)
lib/                 store (journal file), Kite client, chart helpers
public/
  game.js            gamification engine (XP rules, levels, badges, quests)
  stats.js           performance statistics
  sync.js            journal ⇄ Kite reconciliation
  tradebook.js       Console tradebook parsing and pairing
  tradechart.js      interactive charts (Lightweight Charts)
  drawing.js         trendline / level / ruler tools
  practice.js        🎮 chart replay game
  js/                the UI, one module per area:
    main.js          routing, render, actions, boot
    state.js         app state, API, Kite status, helpers on state
    util.js          formatting and small UI helpers
    ui.js            modals, toasts, confetti, level-up
    dashboard.js · journal.js · insights.js · review.js · achievements.js · settings.js
    forms.js         new/edit trade and close-trade forms
    drawer.js        trade side panel and its chart
    importers.js     Kite sync, fills, tradebook import, linking
    live.js          live quote polling
  vendor/            lightweight-charts (Apache-2.0)
scripts/demo.js      seeded demo with simulated prices
test/                node:test unit tests → npm test
```

## Ideas for later

- Partial exits / scaling in
- Zerodha charges calculator
- Chart screenshots stored locally
- Corporate announcements panel (Khabri Laal feed)

## Charges and partial exits

- **Charges are worked out for you** from Zerodha's published schedule (rates as of Nov 2026: brokerage, STT/CTT, exchange transaction charges, SEBI fee, IPFT, stamp duty, GST and the DP charge on delivery sells). Equity sold the same day it was bought is charged at intraday rates. Leave the Charges box blank for auto, or type a figure from your contract note to override it.
- **Partial exits**: in the close form, enter fewer shares than you hold to book a partial exit. The trade stays open with the remainder; the side panel lists each exit (removable) and the charges breakdown. Exit XP is scored once the whole position is closed.
- Tradebook imports keep each exit order separately, and count entry orders, so per-order brokerage matches the contract note. A position partly sold by the end of the file becomes one open trade with its exits.
- Kite sync compares your broker holdings with the quantity still open.

## On your phone

The layout adapts to phone screens: a bottom tab bar, a compact top bar, full-screen forms and trade panels, the journal as a card list, and touch-friendly chart drawing. To install it as an app on Android, open the hosted site in Chrome → ⋮ → **Install app**, or use the **📲 Install TradeQuest** button in Settings. It opens full-screen from your home screen, and long-pressing the icon gives *New trade* and *Insights* shortcuts. On iPhone: Safari → Share → **Add to Home Screen**. To reach it from your phone, use the hosted (Cloudflare) version, which has a password. The local server only listens on your own PC, because it has no login.

## Hosting on Cloudflare (phone access)

TradeQuest can also run on Cloudflare Workers, with your journal in a D1 database and a password login. The free plan is enough. Step-by-step guide: **[docs/CLOUDFLARE.md](docs/CLOUDFLARE.md)**. In short:

```powershell
npx wrangler login
npx wrangler d1 create tradequest        # paste the id into wrangler.toml
npx wrangler secret put APP_PASSWORD
npx wrangler deploy
```

Both versions share the same API code (`lib/api.js`). The local server (`server.js`) stores the journal in `data/journal.json`, and the Worker (`worker/index.js`) stores it in D1.

## Funds ledger: real returns, index-fund comparison, yearly charges

Import your Zerodha funds ledger: **Settings → ⬆ Import Zerodha ledger**, or the button in **Insights**. Download it from Console → Funds → Statement → Ledger as CSV. You can pick several years' files at once; overlapping entries are skipped.

In **Insights** you then get:

- **Am I beating an index fund?**
  - Your net money put in (added − withdrawn), your gain, and your yearly return (XIRR).
  - The same deposits and withdrawals, on the same dates, run through a Nifty 50 index fund (UTI Nifty 50 Index Fund, direct growth, using AMFI's daily prices). The gap is your real edge in rupees.
  - "Value today" comes from Kite (stocks + mutual funds + ledger cash). You can type a figure instead.
- **Profit and charges by year** (Indian financial year):
  - booked P&L
  - trading charges (brokerage, STT, exchange, SEBI, stamp, GST)
  - account fees from the ledger (DP charges, AMC, gateway fees, late-payment interest, auto square-off, subscriptions)
  - net profit

The dashboard equity curve is now spaced by calendar time, so quiet years no longer look as long as busy months.

## Trade types

The tradebook import types each trade by how long it was held: same day = Intraday, up to 20 days = Swing, over a year = Long-term, anything else = Positional. A one-time update applied this rule to trades imported before it existed; trades you typed yourself keep their type. To change several trades at once, tick them in the Journal and use **Set type…**.

## 🧮 Position size calculator

Find it in the sidebar, or tap the floating 🧮 button on a phone. Enter the entry and stop-loss, and optionally a target. You get:

- how many shares (or whole lots) to buy, so that a stop-out costs at most your risk budget **including slippage and every Zerodha charge**
- position value, loss at the stop, profit at the target after charges, reward:risk and the break-even price

How it decides:

- **Risk budget:** % of capital (Settings → *Risk per trade*, default 1%), never above your ₹ max risk per trade.
- **Your rules:** max position % and total open risk across all open trades are applied, and the result says when one of them cut the size.
- **F&O:** rounded down to whole lots. Bought options are sized on losing the whole premium.
- **Holding overnight:** shows what a 5% gap past your stop would cost.
- **Log this trade** opens the new-trade form already filled in.

## Market context in Practice: relative strength and breadth

Every replay shows two extra panes under the price, revealed bar by bar like the candles:

- **RS vs Nifty 50:** the stock divided by the Nifty 50, scaled to 100. A rising line means it's beating the index. Above the chart: the stock's % move vs the Nifty's over the last 20 bars, and whether RS is at a 50-bar high or low. Blind mode only ever shows the ratio, never the index level or dates.
- **Breadth:**
  - **Daily charts:** Nifty 500 advancers minus decliners for each day, plus the day's ↑/↓ count and the % of stocks above their 50- and 200-day averages.
  - **Intraday charts:** the *previous* day's Nifty 500 figures, so the replay day's closing breadth never gives the ending away. There's also an optional **Nifty 50 bar by bar** button (about 50 Kite requests, ~20 s the first time).

The Nifty 500 history is built once, in **Settings → Market breadth**:

- It needs Kite connected. Choose ~4½, ~10 or ~15 years; each takes about 3, 6 or 9 minutes.
- After that every replay uses it instantly. Rebuild monthly to add recent days.
- It uses **today's** index members, so older dates leave out stocks that have since left the index.
- You can upload NSE's latest Nifty 500 CSV (niftyindices.com) to refresh the list.
