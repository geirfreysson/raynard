import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configureCredentials } from '@raynard/plugin-sdk';
import { expectToolResult, mockFetch } from '@raynard/plugin-sdk/testing';
import { tools } from './tools.ts';

const KEY = 'TEST_KEY';
configureCredentials({ FMP_API_KEY: KEY });

function readPath(data: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => {
    if (!value || typeof value !== 'object') return undefined;
    return (value as Record<string, unknown>)[key];
  }, data);
}

function assertCardData(tool: { card: { layout: unknown[] } }, data: Record<string, unknown>) {
  const visit = (block: unknown) => {
    if (!block || typeof block !== 'object') return;
    const record = block as Record<string, unknown>;
    if (record.component === 'MetricRow') {
      for (const item of record.items as Array<{ field: string }>) {
        assert.notEqual(readPath(data, item.field), undefined, `missing card field ${item.field}`);
      }
    }
    if (record.component === 'KeyValue') {
      for (const pair of record.pairs as Array<{ field: string }>) {
        assert.notEqual(readPath(data, pair.field), undefined, `missing card field ${pair.field}`);
      }
    }
    if (record.component === 'Table') {
      assert.ok(Array.isArray(readPath(data, String(record.rows))), `missing card rows ${String(record.rows)}`);
    }
    if (['Image', 'Badge', 'Json'].includes(String(record.component)) && record.field) {
      assert.notEqual(readPath(data, String(record.field)), undefined, `missing card field ${String(record.field)}`);
    }
    if (Array.isArray(record.layout)) record.layout.forEach(visit);
    if (Array.isArray(record.columns)) {
      for (const column of record.columns as Array<{ layout?: unknown[] }>) column.layout?.forEach(visit);
    }
  };
  tool.card.layout.forEach(visit);
}

test('fmp_market_activity returns bounded live-market rows and card data', async () => {
  const fetchMock = mockFetch((url) => {
    assert.equal(url, 'https://financialmodelingprep.com/stable/most-actives?apikey=TEST_KEY');
    return {
      body: [
        { symbol: 'AAPL', name: 'Apple Inc.', price: 250, change: 2.5, changesPercentage: 1.01, exchange: 'NASDAQ' },
        { symbol: 'MSFT', name: 'Microsoft Corporation', price: 500, change: -5, changesPercentage: -0.99, exchange: 'NASDAQ' }
      ]
    };
  });
  try {
    const result = await tools.fmp_market_activity.execute();
    expectToolResult(result);
    assert.match(result.text, /AAPL/);
    assert.match(result.text, /MSFT/);
    assert.equal(result.data.count, 2);
    assert.equal(result.references.length, 1);
    assertCardData(tools.fmp_market_activity, result.data);
  } finally {
    fetchMock.restore();
  }
});

test('fmp_company_overview combines valuation, quality, and score endpoints', async () => {
  const fetchMock = mockFetch((url) => {
    if (url.startsWith('https://financialmodelingprep.com/stable/profile?')) {
      return { body: [{ symbol: 'AAPL', companyName: 'Apple Inc.', currency: 'USD', marketCap: 3000000000000, sector: 'Technology', industry: 'Consumer Electronics', exchange: 'NASDAQ', website: 'https://apple.com' }] };
    }
    if (url.startsWith('https://financialmodelingprep.com/stable/quote?')) {
      return { body: [{ symbol: 'AAPL', name: 'Apple Inc.', price: 250, changePercentage: 1.25, marketCap: 3000000000000 }] };
    }
    if (url.startsWith('https://financialmodelingprep.com/stable/key-metrics-ttm?')) {
      return { body: [{ symbol: 'AAPL', evToEBITDATTM: 24, returnOnEquityTTM: 1.5, returnOnInvestedCapitalTTM: 0.55, freeCashFlowYieldTTM: 0.03, netDebtToEBITDATTM: 0.4 }] };
    }
    if (url.startsWith('https://financialmodelingprep.com/stable/ratios-ttm?')) {
      return { body: [{ symbol: 'AAPL', priceToEarningsRatioTTM: 32, priceToSalesRatioTTM: 8, priceToFreeCashFlowRatioTTM: 28, priceToBookRatioTTM: 45, priceToEarningsGrowthRatioTTM: 2.1, operatingProfitMarginTTM: 0.32, grossProfitMarginTTM: 0.47, netProfitMarginTTM: 0.26, currentRatioTTM: 1.1, debtToEquityRatioTTM: 1.4 }] };
    }
    if (url.startsWith('https://financialmodelingprep.com/stable/financial-scores?')) {
      return { body: [{ symbol: 'AAPL', piotroskiScore: 8, altmanZScore: 9.5 }] };
    }
    return undefined;
  });
  try {
    const result = await tools.fmp_company_overview.execute({ symbol: '$aapl' });
    expectToolResult(result);
    assert.match(result.text, /trailing P\/E 32/);
    assert.equal((result.data.metrics as Record<string, unknown>).trailingPe, 32);
    assert.equal(result.references.length, 5);
    assert.ok(fetchMock.calls.every((url) => url.includes('symbol=AAPL&apikey=TEST_KEY')));
    assertCardData(tools.fmp_company_overview, result.data);
  } finally {
    fetchMock.restore();
  }
});

test('fmp_key_metrics_ttm makes one focused non-historical request', async () => {
  const fetchMock = mockFetch((url) => {
    assert.equal(
      url,
      'https://financialmodelingprep.com/stable/key-metrics-ttm?symbol=CRM&apikey=TEST_KEY'
    );
    return {
      body: [{
        symbol: 'CRM',
        marketCap: 310000000000,
        enterpriseValueTTM: 315000000000,
        evToSalesTTM: 7.4,
        evToOperatingCashFlowTTM: 20.1,
        evToFreeCashFlowTTM: 23.2,
        evToEBITDATTM: 21.5,
        netDebtToEBITDATTM: -0.2,
        currentRatioTTM: 1.1,
        returnOnAssetsTTM: 0.08,
        returnOnEquityTTM: 0.14,
        returnOnInvestedCapitalTTM: 0.11,
        returnOnCapitalEmployedTTM: 0.13,
        earningsYieldTTM: 0.027,
        freeCashFlowYieldTTM: 0.043,
        workingCapital: 12000000000,
        investedCapitalTTM: 98000000000,
        freeCashFlowToEquityTTM: 13500000000,
        freeCashFlowToFirmTTM: 13600000000,
        tangibleAssetValueTTM: 52000000000
      }]
    };
  });
  try {
    const result = await tools.fmp_key_metrics_ttm.execute({ symbol: '$crm' });
    expectToolResult(result);
    assert.equal(fetchMock.calls.length, 1);
    assert.equal(result.data.symbol, 'CRM');
    assert.equal(result.data.evToEbitda, '21.5');
    assert.equal(result.data.freeCashFlowYield, '4.3%');
    assert.equal(result.references.length, 1);
    assertCardData(tools.fmp_key_metrics_ttm, result.data);
  } finally {
    fetchMock.restore();
  }
});

test('fmp_price_history returns a bounded chronological chart series and range metrics', async () => {
  const fetchMock = mockFetch((url) => {
    assert.equal(
      url,
      'https://financialmodelingprep.com/stable/historical-price-eod/full?symbol=CRM&apikey=TEST_KEY'
    );
    return {
      body: [
        { symbol: 'CRM', date: '2026-08-07', close: 107, volume: 1700, change: 1, changePercent: 0.94 },
        { symbol: 'CRM', date: '2026-08-06', close: 106, volume: 1600 },
        { symbol: 'CRM', date: '2026-08-05', close: 105, volume: 1500 },
        { symbol: 'CRM', date: '2026-08-04', close: 104, volume: 1400 },
        { symbol: 'CRM', date: '2026-08-03', close: 103, volume: 1300 },
        { symbol: 'CRM', date: '2026-08-02', close: 102, volume: 1200 },
        { symbol: 'CRM', date: '2026-08-01', close: 101, volume: 1100 }
      ]
    };
  });
  try {
    const result = await tools.fmp_price_history.execute({ symbol: '$crm', range: '5d' });
    expectToolResult(result);
    assert.equal(result.data.range, '5D');
    assert.equal(result.data.count, 5);
    assert.equal(result.data.startClose, '103');
    assert.equal(result.data.latestClose, '107');
    assert.equal(result.data.rangeChangePct, '+3.88%');
    assert.equal(result.data.ma20, '104');
    assert.deepEqual(
      (result.data.points as Array<Record<string, unknown>>).map((point) => point.date),
      ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07']
    );
    assert.match(result.text, /Chart-ready rows are in data\.points/);
    assert.equal(result.references.length, 1);
    assertCardData(tools.fmp_price_history, result.data);
  } finally {
    fetchMock.restore();
  }
});

test('fmp_company_financials aligns statement rows and computes cash metrics', async () => {
  const common = { date: '2025-06-30', symbol: 'AAPL', fiscalYear: '2025', period: 'Q3', reportedCurrency: 'USD' };
  const fetchMock = mockFetch((url) => {
    assert.match(url, /symbol=AAPL&period=quarter&limit=3&apikey=TEST_KEY$/);
    if (url.includes('/income-statement?')) return { body: [{ ...common, revenue: 1000, operatingIncome: 300, netIncome: 220, epsDiluted: 2.2 }] };
    if (url.includes('/balance-sheet-statement?')) return { body: [{ ...common, cashAndShortTermInvestments: 400, totalCurrentAssets: 800, totalCurrentLiabilities: 400, totalDebt: 600 }] };
    if (url.includes('/cash-flow-statement?')) return { body: [{ ...common, operatingCashFlow: 280, capitalExpenditure: -80, freeCashFlow: 200 }] };
    return undefined;
  });
  try {
    const result = await tools.fmp_company_financials.execute({ symbol: 'AAPL', period: 'quarter', limit: 3 });
    expectToolResult(result);
    assert.match(result.text, /revenue \$1\.00K/);
    assert.equal((result.data.rawPeriods as Array<Record<string, unknown>>)[0].freeCashFlow, 200);
    assert.equal((result.data.rawPeriods as Array<Record<string, unknown>>)[0].currentRatio, 2);
    assert.equal(fetchMock.calls.length, 3);
    assertCardData(tools.fmp_company_financials, result.data);
  } finally {
    fetchMock.restore();
  }
});

test('fmp_company_financials can select annual history back to 2011', async () => {
  const rows = [
    { date: '2012-09-29', symbol: 'AAPL', fiscalYear: '2012', period: 'FY', reportedCurrency: 'USD' },
    { date: '2011-09-24', symbol: 'AAPL', fiscalYear: '2011', period: 'FY', reportedCurrency: 'USD' },
    { date: '2010-09-25', symbol: 'AAPL', fiscalYear: '2010', period: 'FY', reportedCurrency: 'USD' }
  ];
  const fetchMock = mockFetch((url) => {
    assert.match(url, /symbol=AAPL&period=annual&limit=\d+&apikey=TEST_KEY$/);
    if (url.includes('/income-statement?')) return { body: rows.map((row) => ({ ...row, revenue: Number(row.fiscalYear) })) };
    if (url.includes('/balance-sheet-statement?')) return { body: rows };
    if (url.includes('/cash-flow-statement?')) return { body: rows };
    return undefined;
  });
  try {
    const result = await tools.fmp_company_financials.execute({ symbol: 'AAPL', start_year: 2011, end_year: 2012 });
    expectToolResult(result);
    assert.deepEqual(
      (result.data.rawPeriods as Array<Record<string, unknown>>).map((row) => row.fiscalYear),
      ['2012', '2011']
    );
    assert.doesNotMatch(result.text, /2010 FY/);
  } finally {
    fetchMock.restore();
  }
});

test('fmp_valuation_history combines annual market cap and valuation ratios through 2011', async () => {
  const fetchMock = mockFetch((url) => {
    if (url.includes('/profile?')) return { body: [{ symbol: 'AAPL', currency: 'USD' }] };
    assert.match(url, /symbol=AAPL&period=annual&limit=\d+&apikey=TEST_KEY$/);
    if (url.includes('/key-metrics?')) return { body: [
      { symbol: 'AAPL', date: '2012-09-29', fiscalYear: '2012', period: 'FY', marketCap: 600, enterpriseValue: 620, evToEBITDA: 8, freeCashFlowYield: 0.08, returnOnEquity: 0.3, returnOnInvestedCapital: 0.25 },
      { symbol: 'AAPL', date: '2011-09-24', fiscalYear: '2011', period: 'FY', marketCap: 400, enterpriseValue: 420, evToEBITDA: 7, freeCashFlowYield: 0.09, returnOnEquity: 0.28, returnOnInvestedCapital: 0.22 }
    ] };
    if (url.includes('/ratios?')) return { body: [
      { symbol: 'AAPL', date: '2012-09-29', fiscalYear: '2012', period: 'FY', priceToEarningsRatio: 14, priceToSalesRatio: 3, priceToBookRatio: 5, priceToFreeCashFlowRatio: 12 },
      { symbol: 'AAPL', date: '2011-09-24', fiscalYear: '2011', period: 'FY', priceToEarningsRatio: 12, priceToSalesRatio: 2.5, priceToBookRatio: 4, priceToFreeCashFlowRatio: 10 }
    ] };
    if (url.includes('/enterprise-values?')) return { body: [
      { symbol: 'AAPL', date: '2012-09-29', marketCapitalization: 601, enterpriseValue: 621 },
      { symbol: 'AAPL', date: '2011-09-24', marketCapitalization: 401, enterpriseValue: 421 }
    ] };
    return undefined;
  });
  try {
    const result = await tools.fmp_valuation_history.execute({ symbol: 'AAPL', start_year: 2011, end_year: 2012 });
    expectToolResult(result);
    assert.equal(result.data.count, 2);
    assert.equal((result.data.rawPeriods as Array<Record<string, unknown>>)[0].marketCap, 601);
    assert.equal((result.data.periods as Array<Record<string, unknown>>)[1].priceToEarnings, '12');
    assert.match(result.text, /2011 FY: market cap/);
    assert.equal(result.references.length, 4);
    assertCardData(tools.fmp_valuation_history, result.data);
  } finally {
    fetchMock.restore();
  }
});

test('fmp_analyst_outlook sorts nearest estimates, computes forward P/E, and optionally retains grades', async () => {
  const fetchMock = mockFetch((url) => {
    if (url.includes('/profile?')) return { body: [{ symbol: 'AAPL', currency: 'USD' }] };
    if (url.includes('/quote?')) return { body: [{ symbol: 'AAPL', price: 100 }] };
    if (url.includes('/analyst-estimates?')) {
      assert.equal(url, 'https://financialmodelingprep.com/stable/analyst-estimates?symbol=AAPL&period=annual&page=0&limit=10&apikey=TEST_KEY');
      return { body: [
        { symbol: 'AAPL', date: '2028-09-30', revenueLow: 1400, revenueAvg: 1500, revenueHigh: 1600, epsLow: 5.5, epsAvg: 6, epsHigh: 6.5, numAnalystsEps: 20, numAnalystsRevenue: 18 },
        { symbol: 'AAPL', date: '2027-09-30', revenueLow: 1100, revenueAvg: 1200, revenueHigh: 1300, epsLow: 4.5, epsAvg: 5, epsHigh: 5.5, numAnalystsEps: 25, numAnalystsRevenue: 23 }
      ] };
    }
    if (url.includes('/ratings-snapshot?')) return { body: [{ symbol: 'AAPL', rating: 'B', overallScore: 3 }] };
    if (url.includes('/price-target-consensus?')) return { body: [{ symbol: 'AAPL', targetLow: 80, targetHigh: 180, targetConsensus: 150, targetMedian: 145 }] };
    if (url.includes('/price-target-summary?')) return { body: [{ symbol: 'AAPL', lastMonthCount: 4, lastMonthAvgPriceTarget: 148, lastQuarterCount: 12, lastQuarterAvgPriceTarget: 140, lastYearCount: 40, lastYearAvgPriceTarget: 130 }] };
    if (url.includes('/grades?')) return { body: [
      { symbol: 'AAPL', date: '2026-08-10', gradingCompany: 'Firm A', previousGrade: 'Hold', newGrade: 'Buy', action: 'upgrade' },
      { symbol: 'AAPL', date: '2026-08-01', gradingCompany: 'Firm B', previousGrade: 'Buy', newGrade: 'Hold', action: 'downgrade' }
    ] };
    return undefined;
  });
  try {
    const result = await tools.fmp_analyst_outlook.execute({ symbol: 'AAPL', limit: 2, include_recent_grades: true, grade_limit: 1 });
    expectToolResult(result);
    const estimates = result.data.estimates as Array<Record<string, unknown>>;
    assert.equal(estimates[0].date, '2027-09-30');
    assert.equal(estimates[0].forwardPe, '20');
    assert.equal(result.data.targetUpside, '+50.00%');
    assert.equal((result.data.recentGrades as unknown[]).length, 1);
    assert.match(result.text, /Firm A upgrade/);
    assert.equal(fetchMock.calls.length, 7);
    assertCardData(tools.fmp_analyst_outlook, result.data);
  } finally {
    fetchMock.restore();
  }
});

test('fmp_company_segments flattens product and geographic mixes with shares', async () => {
  const fetchMock = mockFetch((url) => {
    assert.match(url, /symbol=AAPL&period=annual&apikey=TEST_KEY$/);
    if (url.includes('/revenue-product-segmentation?')) {
      return { body: [{ symbol: 'AAPL', fiscalYear: 2025, period: 'FY', date: '2025-09-27', reportedCurrency: 'USD', data: { iPhone: 700, Services: 300 } }] };
    }
    if (url.includes('/revenue-geographic-segmentation?')) {
      return { body: [{ symbol: 'AAPL', fiscalYear: 2025, period: 'FY', date: '2025-09-27', reportedCurrency: 'USD', data: { Americas: 600, Europe: 400 } }] };
    }
    return undefined;
  });
  try {
    const result = await tools.fmp_company_segments.execute({ symbol: 'AAPL', period_limit: 1 });
    expectToolResult(result);
    assert.equal((result.data.productSegments as Array<Record<string, unknown>>)[0].share, '70.0%');
    assert.match(result.text, /iPhone/);
    assert.match(result.text, /Americas/);
    assertCardData(tools.fmp_company_segments, result.data);
  } finally {
    fetchMock.restore();
  }
});

test('fmp_company_segments selects the requested annual year range', async () => {
  const segmentRows = [
    { symbol: 'AAPL', fiscalYear: 2012, period: 'FY', date: '2012-09-29', reportedCurrency: 'USD', data: { iPhone: 600 } },
    { symbol: 'AAPL', fiscalYear: 2011, period: 'FY', date: '2011-09-24', reportedCurrency: 'USD', data: { iPhone: 400 } },
    { symbol: 'AAPL', fiscalYear: 2010, period: 'FY', date: '2010-09-25', reportedCurrency: 'USD', data: { iPhone: 300 } }
  ];
  const fetchMock = mockFetch((url) => {
    assert.match(url, /symbol=AAPL&period=annual&apikey=TEST_KEY$/);
    return { body: segmentRows };
  });
  try {
    const result = await tools.fmp_company_segments.execute({ symbol: 'AAPL', start_year: 2011, end_year: 2012 });
    expectToolResult(result);
    assert.equal(result.data.periodCount, 2);
    assert.deepEqual(
      (result.data.productSegments as Array<Record<string, unknown>>).map((row) => row.period),
      ['2012 FY', '2011 FY']
    );
  } finally {
    fetchMock.restore();
  }
});

test('fmp_stock_peers returns bounded peer symbols with evidence', async () => {
  const fetchMock = mockFetch((url) => {
    assert.equal(url, 'https://financialmodelingprep.com/stable/stock-peers?symbol=AAPL&apikey=TEST_KEY');
    return { body: [
      { symbol: 'MSFT', companyName: 'Microsoft Corporation', price: 500, mktCap: 3500000000000 },
      { symbol: 'GOOGL', companyName: 'Alphabet Inc.', price: 300, mktCap: 3000000000000 }
    ] };
  });
  try {
    const result = await tools.fmp_stock_peers.execute({ symbol: 'AAPL', limit: 1 });
    expectToolResult(result);
    assert.equal(result.data.count, 1);
    assert.match(result.text, /MSFT/);
    assert.doesNotMatch(result.text, /GOOGL/);
    assertCardData(tools.fmp_stock_peers, result.data);
  } finally {
    fetchMock.restore();
  }
});

test('fmp_company_screener maps snake_case filters onto FMP parameters', async () => {
  const fetchMock = mockFetch((url) => {
    assert.equal(
      url,
      'https://financialmodelingprep.com/stable/company-screener?marketCapMoreThan=10000000000&betaLowerThan=1.2&sector=Technology&country=US&isEtf=false&limit=2&apikey=TEST_KEY'
    );
    return {
      body: [
        { symbol: 'AAPL', companyName: 'Apple Inc.', sector: 'Technology', industry: 'Consumer Electronics', exchangeShortName: 'NASDAQ', country: 'US', price: 250, marketCap: 3000000000000, beta: 1.1, volume: 45000000, lastAnnualDividend: 1 },
        { symbol: 'MSFT', companyName: 'Microsoft Corporation', sector: 'Technology', industry: 'Software', exchangeShortName: 'NASDAQ', country: 'US', price: 500, marketCap: 3500000000000, beta: 0.9, volume: 20000000, lastAnnualDividend: 3 }
      ]
    };
  });
  try {
    const result = await tools.fmp_company_screener.execute({
      market_cap_more_than: 10000000000,
      beta_lower_than: 1.2,
      sector: 'Technology',
      country: 'US',
      is_etf: false,
      limit: 2
    });
    expectToolResult(result);
    assert.equal(result.data.count, 2);
    assert.match(result.text, /AAPL/);
    assert.match(result.text, /MSFT/);
    assert.equal((result.data.rows as Array<Record<string, unknown>>)[0].exchange, 'NASDAQ');
    assert.equal((result.data.rows as Array<Record<string, unknown>>)[0].rawMarketCap, 3000000000000);
    assert.equal(result.references.length, 1);
    assertCardData(tools.fmp_company_screener, result.data);
  } finally {
    fetchMock.restore();
  }
});

test('fmp_company_screener bounds the row limit and keeps the summary short', async () => {
  const body = Array.from({ length: 60 }, (unused, index) => ({
    symbol: `SYM${index}`,
    companyName: `Company ${index}`,
    sector: 'Technology',
    industry: 'Software',
    exchangeShortName: 'NASDAQ',
    country: 'US',
    price: 10 + index,
    marketCap: 1000000000 * (index + 1),
    beta: 1,
    volume: 100000
  }));
  const fetchMock = mockFetch((url) => {
    assert.match(url, /limit=30&apikey=TEST_KEY$/);
    return { body };
  });
  try {
    const result = await tools.fmp_company_screener.execute({ limit: 30 });
    expectToolResult(result);
    assert.equal(result.data.count, 30);
    assert.equal((result.data.rows as unknown[]).length, 30);
    // The card carries all 30 rows; the model-visible text stops at 20.
    assert.match(result.text, /SYM19/);
    assert.doesNotMatch(result.text, /SYM20/);
    assert.match(result.text, /10 further matched row/);
    assert.equal(result.data.filterSummary, 'none');
  } finally {
    fetchMock.restore();
  }
});

test('fmp_company_screener rejects inverted ranges and out-of-bounds limits', async () => {
  await assert.rejects(
    () => tools.fmp_company_screener.execute({ market_cap_more_than: 100, market_cap_lower_than: 10 }),
    /market_cap_more_than must be less than or equal to market_cap_lower_than/
  );
  await assert.rejects(() => tools.fmp_company_screener.execute({ limit: 101 }), /limit must be an integer from 1 through 100/);
  await assert.rejects(() => tools.fmp_company_screener.execute({ limit: 0 }), /limit must be an integer from 1 through 100/);
});

test('fmp_company_screener reports an empty match set as a widenable error', async () => {
  const fetchMock = mockFetch(() => ({ body: [] }));
  try {
    await assert.rejects(
      () => tools.fmp_company_screener.execute({ sector: 'Technology' }),
      /no companies matching those screener filters/
    );
  } finally {
    fetchMock.restore();
  }
});

test('tools request the declared credential at execution time', async () => {
  configureCredentials({});
  try {
    await assert.rejects(() => tools.fmp_market_activity.execute(), /Missing credential FMP_API_KEY/);
  } finally {
    configureCredentials({ FMP_API_KEY: KEY });
  }
});
