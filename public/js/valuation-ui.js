// Dashboard → Nifty 50 valuation card: today's P/E next to its median, with where
// today sits in the historical range. NSE publishes the P/E once a day after the
// close; during market hours we estimate today's figure from the live index move.
import { valuationSummary, zone, parsePeCsv, BASIS_CHANGE } from '../valuation.js';
import { S, api } from './state.js';
import { $, esc } from './util.js';

const WIN_KEY = 'tq-pe-window';
const getWin = () => { try { return localStorage.getItem(WIN_KEY) || '10y'; } catch { return '10y'; } };
const setWin = (v) => { try { localStorage.setItem(WIN_KEY, v); } catch { /* private mode */ } };
const istToday = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const f1 = (x) => (x == null ? '—' : x.toFixed(1));
const fmtD = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit', timeZone: 'UTC' });

export const valuationCardShell = () => `<section class="card o-val" id="mkt-val"><header class="card-h"><h3>🏷️ Nifty 50 valuation</h3><span class="row" style="gap:6px"><button class="btn sm ghost" data-action="pe-refresh" title="Check NSE for new days">↻</button><label class="btn sm ghost" title="Upload the P/E CSV from niftyindices.com">⬆<input type="file" accept=".csv,text/csv" id="pe-file" hidden></label></span></header><div id="mkt-val-body">${S.valHtml || '<div class="empty-sm">Loading…</div>'}</div></section>`;

// Live estimate: P/E moves with the index while earnings stay put for the day.
function livePe(sum, q) {
  if (!q?.last || !q.prevClose) return null;
  const today = istToday();
  if (sum.asOf >= today) return null; // NSE has already published today's figure
  if (daysBetween(sum.asOf, today) > 4) return null; // too far apart to trust prevClose = asOf close
  const d = new Date(Date.now() + 330 * 60000); const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (d.getUTCDay() % 6 === 0 || m < 9 * 60 + 15) return null;
  return sum.pe * (q.last / q.prevClose);
}

function rangeBar(pe, w) {
  const lo = Math.min(w.min, pe); const hi = Math.max(w.max, pe);
  const x = (v) => `${(((v - lo) / (hi - lo || 1)) * 100).toFixed(1)}%`;
  return `<div class="pe-range" title="Range ${f1(w.min)}–${f1(w.max)} · middle half ${f1(w.q1)}–${f1(w.q3)}">
    <div class="pe-iqr" style="left:${x(w.q1)};width:calc(${x(w.q3)} - ${x(w.q1)})"></div>
    <div class="pe-med" style="left:${x(w.median)}"></div>
    <div class="pe-now" style="left:${x(pe)}"></div>
  </div>
  <div class="pe-scale mono"><span>${f1(lo)}</span><span>cheap ← middle half ${f1(w.q1)}–${f1(w.q3)} → expensive</span><span>${f1(hi)}</span></div>`;
}

function html(series, q) {
  const sum = valuationSummary(series);
  if (!sum) return '<div class="empty-sm">No P/E data yet.</div>';
  const live = livePe(sum, q);
  const pe = live ?? sum.pe;
  const wins = sum.windows;
  const w = wins.find((x) => x.key === getWin()) || wins.find((x) => x.key === '10y') || wins[wins.length - 1];
  const below = w ? Math.round((w.percentile ?? 0)) : null;
  const pct = w ? Math.round(((pe - w.median) / w.median) * 100) : null;
  const [cls, label] = zone(pe, w);
  const tile = (k, v, s) => `<div class="kpi"><div class="k">${k}</div><div class="v mono">${v}</div><div class="s">${s}</div></div>`;
  const mixed = w && w.from < BASIS_CHANGE;
  return `<div class="kpis k2">
      ${tile(live != null ? 'P/E now (est.)' : 'Current P/E', f1(pe), live != null ? `NSE close ${fmtD(sum.asOf)}: ${f1(sum.pe)}` : `as of ${fmtD(sum.asOf)}`)}
      ${tile(`Median P/E`, w ? f1(w.median) : '—', w ? `<select class="sm-select" data-pe-window>${wins.map((x) => `<option value="${x.key}" ${x.key === w.key ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select>` : '')}
    </div>
    ${w ? `<div class="pe-verdict"><b class="${cls}">${pct >= 0 ? '+' : ''}${pct}% vs median</b> · ${label} · higher than ${below}% of days since ${fmtD(w.from)}</div>${rangeBar(pe, w)}` : ''}
    <div class="pe-extra sub">P/B ${f1(sum.pb)} · Div. yield ${sum.dy == null ? '—' : `${sum.dy.toFixed(2)}%`} · P/E a year ago ${f1(sum.peYearAgo)}</div>
    ${mixed ? `<div class="sub" style="margin-top:6px;font-size:11px">Before Apr 2021 NSE used standalone earnings, which gave higher P/Es, so this median runs a little high. "Since Apr 2021" compares like with like.</div>` : ''}
    ${series.error ? `<div class="note warn" style="margin-top:8px">Couldn't reach NSE for the latest days (${esc(series.error)}). Showing stored data.</div>` : ''}`;
}

let wired = false;
function wire() {
  if (wired) return; wired = true;
  document.addEventListener('change', async (e) => {
    if (e.target.matches?.('[data-pe-window]')) { setWin(e.target.value); paint(); }
    if (e.target.id === 'pe-file' && e.target.files?.[0]) {
      const rows = parsePeCsv(await e.target.files[0].text()); e.target.value = '';
      if (!rows.length) { alert('No P/E rows found. Use the CSV from niftyindices.com → Reports → Historical Data → P/E, P/B & Div. Yield (NIFTY 50).'); return; }
      try { await api('/api/valuation', { method: 'PUT', body: rows.length ? { rows } : {} }); S.valSeries = null; mountValuation(); } catch (err) { alert(err.message); }
    }
  });
  document.addEventListener('click', (e) => { if (e.target.closest?.('[data-action="pe-refresh"]')) { S.valSeries = null; mountValuation(true); } });
}

function paint() {
  const body = $('#mkt-val-body'); if (!body || !S.valSeries) return;
  S.valHtml = html(S.valSeries, S.valQuote);
  body.innerHTML = S.valHtml;
}

export async function mountValuation(refresh = false) {
  wire();
  const body = $('#mkt-val-body'); if (!body) return;
  try {
    if (!S.valSeries) S.valSeries = await api(`/api/valuation${refresh ? '?refresh=1' : ''}`);
  } catch (err) {
    body.innerHTML = `<div class="note warn">${esc(err.message)}</div><div class="sub" style="margin-top:6px">On niftyindices.com open Reports → Historical Data → P/E, P/B &amp; Div. Yield, pick NIFTY 50 and a long date range, download the CSV and upload it with ⬆ above.</div>`;
    return;
  }
  paint();
  try { S.valQuote = (await api(`/api/kite/quote?i=${encodeURIComponent('NSE:NIFTY 50')}`)).quotes?.['NSE:NIFTY 50'] || null; paint(); } catch { /* Kite not connected: show NSE's figure */ }
}
