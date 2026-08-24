import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockFetch } from '@raynard/plugin-sdk/testing';
import {
  fetchAnalystEstimates,
  fetchAnalystGrades,
  fetchBalanceSheet,
  fetchCashFlowStatement,
  fetchFinancialScores,
  fetchGeographicSegments,
  fetchIncomeStatement,
  fetchKeyMetricsTtm,
  fetchMostActives,
  fetchPriceTargetConsensus,
  fetchPriceTargetSummary,
  fetchProductSegments,
  fetchProfile,
  fetchQuote,
  fetchRatingsSnapshot,
  fetchRatiosTtm,
  fetchStockPeers,
  fmpSourceUrl
} from './client.ts';

const KEY = 'TEST_KEY';

test('every FMP client helper calls the literal stable host with exact parameters', async () => {
  const fetchMock = mockFetch(() => ({ body: [{ symbol: 'AAPL' }] }));
  try {
    await fetchMostActives(KEY);
    await fetchProfile('AAPL', KEY);
    await fetchQuote('AAPL', KEY);
    await fetchKeyMetricsTtm('AAPL', KEY);
    await fetchRatiosTtm('AAPL', KEY);
    await fetchFinancialScores('AAPL', KEY);
    await fetchIncomeStatement({ symbol: 'AAPL', period: 'annual', limit: 5, apiKey: KEY });
    await fetchBalanceSheet({ symbol: 'AAPL', period: 'annual', limit: 5, apiKey: KEY });
    await fetchCashFlowStatement({ symbol: 'AAPL', period: 'annual', limit: 5, apiKey: KEY });
    await fetchAnalystEstimates('AAPL', 'annual', KEY);
    await fetchRatingsSnapshot('AAPL', KEY);
    await fetchPriceTargetConsensus('AAPL', KEY);
    await fetchPriceTargetSummary('AAPL', KEY);
    await fetchAnalystGrades('AAPL', KEY);
    await fetchProductSegments({ symbol: 'AAPL', period: 'annual', apiKey: KEY });
    await fetchGeographicSegments({ symbol: 'AAPL', period: 'annual', apiKey: KEY });
    await fetchStockPeers('AAPL', KEY);

    assert.deepEqual(fetchMock.calls, [
      'https://financialmodelingprep.com/stable/most-actives?apikey=TEST_KEY',
      'https://financialmodelingprep.com/stable/profile?symbol=AAPL&apikey=TEST_KEY',
      'https://financialmodelingprep.com/stable/quote?symbol=AAPL&apikey=TEST_KEY',
      'https://financialmodelingprep.com/stable/key-metrics-ttm?symbol=AAPL&apikey=TEST_KEY',
      'https://financialmodelingprep.com/stable/ratios-ttm?symbol=AAPL&apikey=TEST_KEY',
      'https://financialmodelingprep.com/stable/financial-scores?symbol=AAPL&apikey=TEST_KEY',
      'https://financialmodelingprep.com/stable/income-statement?symbol=AAPL&period=annual&limit=5&apikey=TEST_KEY',
      'https://financialmodelingprep.com/stable/balance-sheet-statement?symbol=AAPL&period=annual&limit=5&apikey=TEST_KEY',
      'https://financialmodelingprep.com/stable/cash-flow-statement?symbol=AAPL&period=annual&limit=5&apikey=TEST_KEY',
      'https://financialmodelingprep.com/stable/analyst-estimates?symbol=AAPL&period=annual&page=0&limit=10&apikey=TEST_KEY',
      'https://financialmodelingprep.com/stable/ratings-snapshot?symbol=AAPL&apikey=TEST_KEY',
      'https://financialmodelingprep.com/stable/price-target-consensus?symbol=AAPL&apikey=TEST_KEY',
      'https://financialmodelingprep.com/stable/price-target-summary?symbol=AAPL&apikey=TEST_KEY',
      'https://financialmodelingprep.com/stable/grades?symbol=AAPL&apikey=TEST_KEY',
      'https://financialmodelingprep.com/stable/revenue-product-segmentation?symbol=AAPL&period=annual&apikey=TEST_KEY',
      'https://financialmodelingprep.com/stable/revenue-geographic-segmentation?symbol=AAPL&period=annual&apikey=TEST_KEY',
      'https://financialmodelingprep.com/stable/stock-peers?symbol=AAPL&apikey=TEST_KEY'
    ]);
  } finally {
    fetchMock.restore();
  }
});

test('public FMP source URLs never contain the credential', () => {
  assert.equal(
    fmpSourceUrl('analyst-estimates', { symbol: 'AAPL', period: 'annual', limit: 10 }),
    'https://financialmodelingprep.com/stable/analyst-estimates?symbol=AAPL&period=annual&limit=10'
  );
});
