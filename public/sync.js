// Compare open journal trades with what Kite says you actually hold.

// Cash equity can be listed on NSE and BSE; match those by symbol alone.
const keyOf = (exchange, symbol) => (exchange === 'NSE' || exchange === 'BSE' ? `EQ:${symbol}` : `${exchange}:${symbol}`);

export function reconcile(trades, { holdings = [], positions = [] }, ignore = []) {
  const ignored = new Set(ignore);
  const broker = {};
  const add = (r, qty) => {
    const k = keyOf(r.exchange, r.symbol);
    const b = (broker[k] ||= { key: k, symbol: r.symbol, exchange: r.exchange, qty: 0, avgPrice: null, lastPrice: null, closedRows: [] });
    b.qty += qty || 0;
    if (qty) b.avgPrice = r.avgPrice ?? b.avgPrice;
    if (r.lastPrice) b.lastPrice = r.lastPrice;
    if (!qty && r.product !== 'CNC') b.closedRows.push(r);
  };
  holdings.forEach((h) => { if (h.qty) add(h, h.qty); });
  positions.forEach((p) => add(p, p.qty));

  const journal = {};
  for (const t of trades) {
    if (t.status !== 'OPEN') continue;
    const k = keyOf(t.exchange, t.symbol);
    const j = (journal[k] ||= { key: k, symbol: t.symbol, exchange: t.exchange, qty: 0, trades: [] });
    const left = t.qty - (t.exits || []).reduce((a, e) => a + (e.qty || 0), 0); // after partial exits
    j.qty += (t.side === 'SHORT' ? -1 : 1) * left;
    j.trades.push(t);
  }

  // Holdings you chose to ignore (e.g. old investments you don't journal) are skipped
  // unless the journal has an open trade for them.
  const keys = new Set([...Object.keys(broker).filter((k) => broker[k].qty !== 0 && !(ignored.has(k) && !journal[k])), ...Object.keys(journal)]);
  const rows = [...keys].map((k) => {
    const b = broker[k]; const j = journal[k];
    const bq = b?.qty || 0; const jq = j?.qty || 0;
    const status = bq === jq ? 'match' : jq === 0 ? 'unlogged' : bq === 0 ? 'closed' : 'qty';
    // Best guess at the exit price for a position closed at the broker today.
    let exitPrice = null;
    if (status === 'closed' && b?.closedRows.length) {
      const r = b.closedRows[0];
      exitPrice = jq > 0 ? r.sellPrice || r.lastPrice : r.buyPrice || r.lastPrice;
    }
    return {
      key: k, symbol: (j || b).symbol, exchange: (b || j).exchange, journalQty: jq, kiteQty: bq, status,
      avgPrice: b?.avgPrice ?? null, lastPrice: b?.lastPrice ?? null, exitPrice: exitPrice || null, trades: j?.trades || [],
    };
  });
  const order = { unlogged: 0, closed: 1, qty: 2, match: 3 };
  rows.sort((a, b) => order[a.status] - order[b.status] || a.symbol.localeCompare(b.symbol));
  const ignoredCount = Object.keys(broker).filter((k) => broker[k].qty !== 0 && ignored.has(k) && !journal[k]).length;
  return { rows, issues: rows.filter((r) => r.status !== 'match').length, ignored: ignoredCount, at: new Date().toISOString() };
}
