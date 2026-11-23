// Settings → Market breadth card, and its actions.
import { S, api, reload } from './state.js';
import { render } from './main.js';
import { $, esc, fmtDate } from './util.js';
import { toast } from './ui.js';
import { buildBreadth, loadBreadth, members500, members500AsOf, parseMembersCsv, parseIndustries } from './breadth.js';

export function breadthCard() {
  const b = S.breadth;
  const job = S.breadthJob;
  const live = S.kite.connected;
  const have = b?.dates?.length;
  const status = have
    ? `Built ${fmtDate(b.built)} · ${fmtDate(b.dates[0])} → ${fmtDate(b.dates.at(-1))} · ${b.members - (b.missing?.length || 0)}/${b.members} stocks`
    : b ? 'Not built yet.' : 'Loading…';
  return `<section class="card" id="breadth-card"><header class="card-h"><h3>📊 Market breadth (Nifty 500)</h3></header>
    <p class="muted" style="margin-top:0">Used in Practice: how many Nifty 500 stocks rose vs fell each day, and how many are above their 50- and 200-day averages. Built once from Kite's daily candles for all 500 stocks; after that every replay uses it instantly.</p>
    <div class="stat-line"><span class="muted">Status</span><b style="font-weight:600">${esc(status)}</b></div>
    <div class="stat-line"><span class="muted">Stock list</span><span>Nifty 500 as of ${fmtDate(members500AsOf())} (${members500().length}) · <button class="btn sm ghost" data-action="breadth-list">Upload NSE list</button></span></div>
    ${job?.running
      ? `<div style="margin-top:10px"><div class="bar"><span id="breadth-bar" style="width:${job.total ? (job.done / job.total) * 100 : 0}%"></span></div><div class="row" style="justify-content:space-between;margin-top:6px"><span class="faint" id="breadth-progress">${job.done}/${job.total}${job.symbol ? ` · ${esc(job.symbol)}` : ''}</span><button class="btn sm ghost" data-action="breadth-cancel">Cancel</button></div></div>`
      : `<div class="row wrap" style="gap:8px;margin-top:10px"><select class="input sm-select" id="breadth-years">${[[1, '~4½ years · ~3 min'], [2, '~10 years · ~6 min'], [3, '~15 years · ~9 min']].map(([y, l]) => `<option value="${y}" ${(b?.spans || 2) === y ? 'selected' : ''}>${l}</option>`).join('')}</select>
         <button class="btn ${have ? '' : 'primary'}" data-action="breadth-build" ${live ? '' : 'disabled title="Connect Kite first"'}>${have ? '↻ Rebuild' : '⬇ Build breadth history'}</button></div>
         <div class="faint" style="font-size:12px;margin-top:6px">${live ? 'Keep this tab open while it runs. Rebuild now and then (monthly is plenty) to add recent days.' : 'Connect Kite first — it needs Kite\'s historical data.'} Uses today's index members, so stocks that left the index years ago aren't counted.</div>`}
  </section>`;
}

export const breadthActions = {
  'breadth-build': async () => {
    const spans = Number($('#breadth-years')?.value || 2);
    const paint = (j) => { const bar = $('#breadth-bar'); const p = $('#breadth-progress'); if (bar) bar.style.width = `${(j.done / j.total) * 100}%`; if (p) p.textContent = `${j.done}/${j.total}${j.symbol ? ` · ${j.symbol}` : ''}`; };
    const run = buildBreadth(spans, paint);
    render();
    try {
      const b = await run;
      toast(`<div class="t-h">📊 Breadth ready</div><div class="muted" style="font-size:12px;margin-top:4px">${b.dates.length} trading days · ${b.members - b.missing.length}/${b.members} stocks</div>`);
    } catch (e) { toast(esc(e.message), 'err'); }
    render();
  },
  'breadth-cancel': () => { if (S.breadthJob) S.breadthJob.cancel = true; },
  'breadth-list': () => {
    const input = document.createElement('input'); input.type = 'file'; input.accept = '.csv,text/csv';
    input.onchange = async () => {
      try {
        const text = await input.files[0].text();
        const syms = parseMembersCsv(text);
        if (syms.length < 100) throw new Error(`Only ${syms.length} symbols found — is this the Nifty 500 list?`);
        const ind = parseIndustries(text);
        await api('/api/settings', { method: 'PUT', body: { indexLists: { ...(S.state.settings.indexLists || {}), nifty500: syms, nifty500AsOf: new Date().toISOString(), industries: Object.keys(ind).length ? ind : (S.state.settings.indexLists?.industries || null) } } });
        await reload();
        toast(`Nifty 500 list updated · ${syms.length} stocks${Object.keys(ind).length ? `, ${new Set(Object.values(ind)).size} sectors` : ''}. Rebuild breadth to use it.`);
      } catch (e) { toast(esc(e.message), 'err'); }
    };
    input.click();
  },
};

export function mountBreadthCard() { if (!S.breadth) loadBreadth().then(() => { if ($('#breadth-card')) render(); }); }
