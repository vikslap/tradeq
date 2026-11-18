import { $, esc, num, pct, fmtDT } from './util.js';
import { S, api, reload } from './state.js';
import { confirmBox, toast } from './ui.js';


// ---------- Settings ----------
export function pageSettings() {
  const s = S.state.settings; const k = S.kite;
  const hosted = Boolean(k.hosted); // the Cloudflare version
  const redirectUrl = `${location.origin}/api/kite/callback`;
  let kiteBody;
  if (k.mock) {
    kiteBody = `<div class="note">Demo mode is on (<code>KITE_MOCK=1</code>). Prices are simulated random walks — great for trying the app, never for real decisions. Set <code>KITE_MOCK=0</code> in <code>.env</code> and restart to use your real Kite account.</div>`;
  } else if (!k.configured) {
    kiteBody = `<ol class="prose" style="padding-left:18px;margin:0">
      <li>Create an app at <a class="link" href="https://developers.kite.trade" target="_blank" rel="noopener">developers.kite.trade</a>. Live quotes need the paid <b>Kite Connect</b> plan.</li>
      <li>Set the app's <b>Redirect URL</b> to <code class="mono">${esc(redirectUrl)}</code></li>
      <li>${hosted ? 'Add <code>KITE_API_KEY</code> and <code>KITE_API_SECRET</code> as secrets: <code>npx wrangler secret put KITE_API_KEY</code> (see docs/CLOUDFLARE.md).' : 'Copy <code>.env.example</code> to <code>.env</code>, fill <code>KITE_API_KEY</code> and <code>KITE_API_SECRET</code>, then restart <code>npm start</code>.'}</li>
      <li>Come back here and press <b>Connect</b>. Kite logins expire every morning (~6 AM), so reconnect once a day.</li></ol>
      <div class="note" style="margin-top:12px">Until then everything works in manual mode — type your prices in.</div>`;
  } else if (!k.connected) {
    kiteBody = `<p class="muted" style="margin-top:0">API key found. Log in to Kite to start a session for today.</p><a class="btn primary" href="/api/kite/login">Connect to Kite</a>
      <p class="faint" style="font-size:12px">Redirect URL registered in your Kite app must be <code class="mono">${esc(redirectUrl)}</code></p>`;
  } else {
    kiteBody = `<div class="stat-line"><span class="muted">Logged in as</span><b>${esc(k.user?.name)} (${esc(k.user?.id)})</b></div>
      <div class="stat-line"><span class="muted">Session expires</span><b>${fmtDT(k.expiresAt)}</b></div>
      <div class="row" style="margin-top:10px"><button class="btn danger" data-action="kite-logout">Disconnect</button></div>`;
  }
  return `<div class="page-h"><div><h1>Settings</h1><p>Your rules are what the game holds you to.</p></div></div>
  <div class="insights">
    <form class="card stack" id="settings-form">
      <header class="card-h" style="margin:0"><h3>Profile & risk rules</h3></header>
      <div class="field"><label>Display name</label><input class="input" name="displayName" value="${esc(s.displayName)}"></div>
      <div class="grid-2">
        <div class="field"><label>Trading capital (₹)</label><input class="input num" type="number" name="capital" value="${s.capital}" min="0"></div>
        <div class="field"><label>Max risk per trade (₹)</label><input class="input num" type="number" name="maxRiskPerTrade" value="${s.maxRiskPerTrade}" min="0"><span class="hint">${s.capital ? pct(s.maxRiskPerTrade / s.capital, 2) + ' of capital' : ''}</span></div>
        <div class="field"><label>Max new trades per day</label><input class="input num" type="number" name="maxTradesPerDay" value="${s.maxTradesPerDay}" min="1"></div>
        <div class="field"><label>Revenge-trade window (minutes)</label><input class="input num" type="number" name="revengeWindowMins" value="${s.revengeWindowMins}" min="0"><span class="hint">New entry this soon after a loss = −15 XP</span></div>
        <div class="field"><label>Daily loss limit (₹)</label><input class="input num" type="number" name="maxDailyLoss" value="${s.maxDailyLoss}" min="0"><span class="hint">Entries after losing this much in a day = −15 XP</span></div>
        <div class="field"><label>Max total open risk (% of capital)</label><input class="input num" type="number" step="any" name="maxPortfolioHeatPct" value="${s.maxPortfolioHeatPct}" min="0"><span class="hint">Sum of all open trades' risk to stop</span></div>
        <div class="field"><label>Max capital in one stock (%)</label><input class="input num" type="number" step="any" name="maxPositionPct" value="${s.maxPositionPct}" min="0"><span class="hint">Cash equity only; 0 = off</span></div>
        <div class="field"><label>Chase tolerance (%)</label><input class="input num" type="number" step="any" name="chaseTolerancePct" value="${s.chaseTolerancePct}" min="0"><span class="hint">Entry this far past your planned trigger = chased</span></div>
      </div>
      <div class="row"><button class="btn primary" type="submit">Save settings</button><span class="muted" id="settings-msg"></span></div>
    </form>
    <section class="card"><header class="card-h"><h3>Zerodha Kite Connect</h3>${k.mock ? '<span class="pill gold">demo</span>' : k.connected ? '<span class="pill green">connected</span>' : '<span class="pill red">not connected</span>'}</header>${kiteBody}</section>
    ${(s.syncIgnore || []).length ? `<section class="card"><header class="card-h"><h3>Ignored in Kite sync</h3></header>
      <p class="muted" style="margin-top:0">These Kite holdings won't be flagged as missing from your journal.</p>
      ${s.syncIgnore.map((k) => `<div class="mistake"><span class="mono">${esc(k.replace(/^EQ:/, ''))}</span><button class="btn sm ghost" data-action="sync-unignore" data-key="${esc(k)}">Stop ignoring</button></div>`).join('')}</section>` : ''}
    <section class="card"><header class="card-h"><h3>Your data</h3></header>
      <p class="muted" style="margin-top:0">${hosted ? 'Your journal lives in your own Cloudflare D1 database (with 7–30 days of point-in-time recovery). Export now and then anyway.' : 'Everything lives in <code>data/journal.json</code> on this computer (a backup copy is made on every start). Export regularly.'}</p>
      <div class="row wrap"><a class="btn" href="/api/export" download>⬇ Export JSON</a><label class="btn">⬆ Import JSON<input type="file" accept="application/json" id="import-file" hidden></label><button class="btn" data-action="tradebook-import">⬆ Import Zerodha tradebook</button>${hosted ? '<button class="btn ghost" data-action="app-logout">Log out of TradeQuest</button>' : ''}</div>
      <p class="faint" style="font-size:12px">Import replaces the whole journal.</p>
    </section>
  </div>`;
}


export function bindSettings() {
  $('#import-file')?.addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    const ok = await confirmBox('Replace your journal?', `Importing <b>${esc(file.name)}</b> will replace all current trades and reviews. Export first if unsure.`, 'Replace journal');
    if (!ok) return;
    try { await api('/api/import', { method: 'POST', body: JSON.parse(await file.text()) }); toast('Journal imported'); await reload(); } catch (err) { toast(err.message, 'err'); }
  });
}
