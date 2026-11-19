import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLedger, categorise, feeKind, fyOf, ledgerByYear, cashFlows, ledgerCash, shadowPortfolio } from '../public/ledger.js';

const CSV = `particulars,posting_date,cost_center,voucher_type,debit,credit,net_balance
Opening Balance,,,,,,100.000000
Funds added using UPI from JA9373 with reference number 1,2025-04-23,NSE-EQ - Z,Bank Receipts,0.000000,5000.000000,5100.000000
Net settlement for Equity with settlement number: 2025076,2025-04-23,NSE-EQ - Z,Book Voucher,4346.17,0.000000,753.83
DP Charges for Sale of EMUDHRA on 28/04/2025,2025-04-28,NSE-EQ - Z,Journal Entry,15.340000,0.000000,738.49
AMC for Demat Account for 10-01-2025 to 10-04-2025,2025-05-27,NSE-EQ - Z,Journal Entry,88.500000,0.000000,649.99
Span margin blocked for NSE F&O,2025-05-28,NSE-F&O - Z,Delivery Voucher,500,0,149.99
Span margin reversed for NSE F&O,2025-05-29,NSE-F&O - Z,Delivery Voucher,0,500,649.99
"Instant Payout of 600.0/- to HDFC BANK LTD as per withdrawal request made on 2026-02-02",2026-02-02,NSE-EQ - Z,Bank Payments,600.000000,0.000000,49.99
Investment in DSP Tax Saver-DP with settlement no: 2223002,2026-03-04,STARMF - Z,Book Voucher,40,0,9.99
Closing Balance,,,,,,9.99`;

test('parses a Zerodha ledger and skips opening/closing rows', () => {
  const rows = parseLedger(CSV);
  assert.equal(rows.length, 8);
  assert.equal(rows[0].credit, 5000);
  assert.ok(rows[6].particulars.startsWith('Instant Payout'));
});

test('categories, fee kinds and financial years', () => {
  const rows = parseLedger(CSV);
  assert.deepEqual(rows.map(categorise), ['deposit', 'equity', 'fee', 'fee', 'margin', 'margin', 'withdrawal', 'mf']);
  assert.equal(feeKind(rows[2]), 'dp'); assert.equal(feeKind(rows[3]), 'amc');
  assert.equal(fyOf('2025-04-01'), 'FY25-26'); assert.equal(fyOf('2026-03-31'), 'FY25-26');
  const [y] = ledgerByYear(rows);
  assert.equal(y.fy, 'FY25-26'); assert.equal(y.deposits, 5000); assert.equal(y.withdrawals, 600);
  assert.ok(Math.abs(y.fees - 103.84) < 1e-9);
  assert.deepEqual(cashFlows(rows).map((f) => f.amount), [5000, -600, -40]);
  assert.deepEqual(ledgerCash(rows), { amount: 9.99, date: '2026-03-04' });
});

test('shadow index fund: buys on deposits, sells on withdrawals', () => {
  const nav = [['2025-01-01', 100], ['2025-06-01', 110], ['2026-01-01', 120]];
  const sh = shadowPortfolio([{ date: '2025-01-01', amount: 1000 }, { date: '2025-06-01', amount: -110 }], nav, '2026-01-01');
  // 10 units bought, 1 sold → 9 units × 120
  assert.ok(Math.abs(sh.value - 1080) < 1e-9);
  assert.equal(sh.invested, 890);
  assert.equal(sh.points.at(-1).date, '2026-01-01');
});

test('scopes: equity + F&O add up to combined', () => {
  const rows = parseLedger(`particulars,posting_date,cost_center,voucher_type,debit,credit,net_balance
Funds added using UPI,2025-04-01,NSE-EQ - Z,Bank Receipts,0,10000,10000
Net obligation for Equity F&O,2025-04-02,NSE-F&O - Z,Book Voucher,3000,0,7000
Net obligation for Equity F&O,2025-04-03,NSE-F&O - Z,Book Voucher,0,1000,8000
Payout of 5000,2025-05-01,NSE-EQ - Z,Bank Payments,5000,0,3000`);
  const sum = (s) => cashFlows(rows, s).reduce((a, f) => a + f.amount, 0);
  assert.equal(sum('combined'), 5000);
  assert.equal(sum('fno'), 2000);  // F&O took ₹2,000 net
  assert.equal(sum('equity'), 3000);
  assert.equal(sum('equity') + sum('fno'), sum('combined'));
});
