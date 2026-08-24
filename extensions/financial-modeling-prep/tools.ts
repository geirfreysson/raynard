import {
  createApiReference,
  defineCard,
  defineTools,
  requireCredential,
  requireNonEmpty,
  type ApiReference
} from '@raynard/plugin-sdk';
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
  fmpSourceUrl,
  type FmpRecord,
  type SegmentRecord,
  type StatementRow
} from './client.ts';

const credential = () => requireCredential('FMP_API_KEY', 'Financial Modeling Prep API key');

function normalizeSymbol(value: unknown): string {
  const symbol = requireNonEmpty(value, 'symbol').replace(/^\$/, '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9.-]{0,9}$/.test(symbol)) {
    throw new Error('symbol must be a ticker such as AAPL, BRK.B, or 0700.HK.');
  }
  return symbol;
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number, label: string): number {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return number;
}

function normalizePeriod(value: unknown, fallback: 'annual' | 'quarter' = 'annual'): 'annual' | 'quarter' {
  const period = String(value ?? fallback).trim().toLowerCase();
  if (period !== 'annual' && period !== 'quarter') {
    throw new Error('period must be annual or quarter.');
  }
  return period;
}

function first<T>(value: T[] | undefined): T | undefined {
  return Array.isArray(value) ? value[0] : undefined;
}

function numeric(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function readNumber(record: FmpRecord | undefined, ...keys: string[]): number | null {
  if (!record) return null;
  for (const key of keys) {
    const value = numeric(record[key]);
    if (value !== null) return value;
  }
  return null;
}

function compactNumber(value: unknown, digits = 2): string {
  const number = numeric(value);
  if (number === null) return '—';
  return number.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: digits });
}

function decimalNumber(value: unknown, digits = 2): string {
  const number = numeric(value);
  if (number === null) return '—';
  return number.toLocaleString('en-US', { maximumFractionDigits: digits });
}

function money(value: unknown, currency = 'USD', compact = false): string {
  const number = numeric(value);
  if (number === null) return '—';
  const safeCurrency = /^[A-Z]{3}$/.test(currency) ? currency : 'USD';
  return number.toLocaleString('en-US', {
    style: 'currency',
    currency: safeCurrency,
    notation: compact ? 'compact' : 'standard',
    maximumFractionDigits: compact ? 2 : 2
  });
}

function percentRatio(value: unknown, digits = 1): string {
  const number = numeric(value);
  return number === null ? '—' : `${(number * 100).toFixed(digits)}%`;
}

function percentPoints(value: unknown, digits = 2): string {
  const number = numeric(value);
  return number === null ? '—' : `${number >= 0 ? '+' : ''}${number.toFixed(digits)}%`;
}

function sourceReference(
  id: string,
  label: string,
  path: string,
  query: Record<string, string | number>,
  quote: string,
  payload: unknown
): ApiReference {
  return createApiReference({
    id,
    label,
    sourceUrl: fmpSourceUrl(path, query),
    quote,
    payload
  });
}

const marketCard = defineCard({
  name: { singular: 'active stock', plural: 'active stocks' },
  title: 'Most active U.S. stocks',
  layout: [
    {
      component: 'MetricRow',
      items: [
        { label: 'Shown', field: 'count' },
        { label: 'FMP returned', field: 'totalReturned' },
        { label: 'Fetched', field: 'fetchedAt', tone: 'muted' }
      ]
    },
    {
      component: 'Table',
      rows: 'stocks',
      columns: [
        { header: 'Symbol', field: 'symbol' },
        { header: 'Company', field: 'name' },
        { header: 'Price', field: 'price' },
        { header: 'Change', field: 'changePct' },
        { header: 'Exchange', field: 'exchange' }
      ]
    }
  ]
});

const overviewCard = defineCard({
  name: { singular: 'company snapshot', plural: 'company snapshots' },
  title: '{{symbol}} — {{companyName}}',
  layout: [
    {
      component: 'MetricRow',
      items: [
        { label: 'Price', field: 'price' },
        { label: 'Day', field: 'changePct', tone: 'delta' },
        { label: 'Market cap', field: 'marketCap' },
        { label: 'P/E (TTM)', field: 'trailingPe' }
      ]
    },
    {
      component: 'Grid',
      columns: 2,
      layout: [
        {
          component: 'Section',
          title: 'Valuation',
          layout: [
            {
              component: 'KeyValue',
              pairs: [
                { label: 'EV / EBITDA', field: 'evToEbitda' },
                { label: 'Price / sales', field: 'priceToSales' },
                { label: 'Price / FCF', field: 'priceToFcf' },
                { label: 'Price / book', field: 'priceToBook' },
                { label: 'PEG (historical)', field: 'peg' }
              ]
            }
          ]
        },
        {
          component: 'Section',
          title: 'Quality & balance sheet',
          layout: [
            {
              component: 'KeyValue',
              pairs: [
                { label: 'Operating margin', field: 'operatingMargin' },
                { label: 'ROE', field: 'roe' },
                { label: 'ROIC', field: 'roic' },
                { label: 'Debt / equity', field: 'debtToEquity' },
                { label: 'Piotroski', field: 'piotroski' }
              ]
            }
          ]
        }
      ]
    },
    {
      component: 'KeyValue',
      pairs: [
        { label: 'Sector / industry', field: 'sectorIndustry' },
        { label: 'Exchange', field: 'exchange' },
        { label: 'Currency', field: 'currency' },
        { label: 'Website', field: 'website' }
      ]
    }
  ]
});

const financialsCard = defineCard({
  name: { singular: 'financial period', plural: 'financial periods' },
  title: '{{symbol}} financials — {{periodLabel}}',
  layout: [
    {
      component: 'MetricRow',
      items: [
        { label: 'Periods', field: 'count' },
        { label: 'Latest revenue', field: 'latestRevenue' },
        { label: 'Latest net income', field: 'latestNetIncome' },
        { label: 'Latest FCF', field: 'latestFreeCashFlow' }
      ]
    },
    {
      component: 'Table',
      rows: 'periods',
      columns: [
        { header: 'Period', field: 'label' },
        { header: 'Revenue', field: 'revenue' },
        { header: 'Operating income', field: 'operatingIncome' },
        { header: 'Net income', field: 'netIncome' },
        { header: 'EPS diluted', field: 'epsDiluted' },
        { header: 'Operating cash flow', field: 'operatingCashFlow' },
        { header: 'Free cash flow', field: 'freeCashFlow' },
        { header: 'Cash', field: 'cash' },
        { header: 'Debt', field: 'debt' }
      ]
    }
  ]
});

const analystCard = defineCard({
  name: { singular: 'analyst estimate', plural: 'analyst estimates' },
  title: '{{symbol}} analyst outlook — {{periodLabel}}',
  layout: [
    {
      component: 'MetricRow',
      items: [
        { label: 'Price', field: 'currentPrice' },
        { label: 'Consensus target', field: 'targetConsensus' },
        { label: 'Target upside', field: 'targetUpside', tone: 'delta' },
        { label: 'FMP rating', field: 'rating' }
      ]
    },
    {
      component: 'Table',
      rows: 'estimates',
      columns: [
        { header: 'Estimate date', field: 'date' },
        { header: 'Revenue avg', field: 'revenueAvg' },
        { header: 'Revenue range', field: 'revenueRange' },
        { header: 'EPS avg', field: 'epsAvg' },
        { header: 'EPS range', field: 'epsRange' },
        { header: 'Forward P/E', field: 'forwardPe' },
        { header: 'EPS analysts', field: 'epsAnalysts' }
      ]
    },
    {
      component: 'KeyValue',
      pairs: [
        { label: 'Target high / low', field: 'targetRange' },
        { label: 'Last month average', field: 'lastMonthTarget' },
        { label: 'Last quarter average', field: 'lastQuarterTarget' },
        { label: 'Last year average', field: 'lastYearTarget' },
        { label: 'Rating score', field: 'ratingScore' }
      ]
    },
    {
      component: 'Section',
      title: 'Recent analyst actions (optional)',
      layout: [
        {
          component: 'Table',
          rows: 'recentGrades',
          columns: [
            { header: 'Date', field: 'date' },
            { header: 'Firm', field: 'firm' },
            { header: 'Action', field: 'action' },
            { header: 'From', field: 'previousGrade' },
            { header: 'To', field: 'newGrade' }
          ]
        }
      ]
    }
  ]
});

const segmentsCard = defineCard({
  name: { singular: 'revenue segment', plural: 'revenue segments' },
  title: '{{symbol}} revenue mix — {{periodLabel}}',
  layout: [
    {
      component: 'MetricRow',
      items: [
        { label: 'Periods', field: 'periodCount' },
        { label: 'Product rows', field: 'productCount' },
        { label: 'Geographic rows', field: 'geographicCount' }
      ]
    },
    {
      component: 'Section',
      title: 'Products and businesses',
      layout: [
        {
          component: 'Table',
          rows: 'productSegments',
          columns: [
            { header: 'Period', field: 'period' },
            { header: 'Segment', field: 'segment' },
            { header: 'Revenue', field: 'revenue' },
            { header: 'Share', field: 'share' }
          ]
        }
      ]
    },
    {
      component: 'Section',
      title: 'Geographies',
      layout: [
        {
          component: 'Table',
          rows: 'geographicSegments',
          columns: [
            { header: 'Period', field: 'period' },
            { header: 'Region', field: 'segment' },
            { header: 'Revenue', field: 'revenue' },
            { header: 'Share', field: 'share' }
          ]
        }
      ]
    }
  ]
});

const peersCard = defineCard({
  name: { singular: 'peer company', plural: 'peer companies' },
  title: 'FMP peers for {{symbol}}',
  layout: [
    { component: 'MetricRow', items: [{ label: 'Peers', field: 'count' }] },
    {
      component: 'Table',
      rows: 'peers',
      columns: [
        { header: 'Symbol', field: 'symbol' },
        { header: 'Company', field: 'companyName' },
        { header: 'Price', field: 'price' },
        { header: 'Market cap', field: 'marketCap' }
      ]
    }
  ]
});

function statementKey(row: StatementRow): string {
  return `${String(row.date ?? '')}|${String(row.period ?? '')}`;
}

function mergeStatements(
  income: StatementRow[],
  balance: StatementRow[],
  cashFlow: StatementRow[],
  limit: number
) {
  const rows = new Map<string, { income?: StatementRow; balance?: StatementRow; cashFlow?: StatementRow }>();
  for (const row of income) rows.set(statementKey(row), { ...(rows.get(statementKey(row)) ?? {}), income: row });
  for (const row of balance) rows.set(statementKey(row), { ...(rows.get(statementKey(row)) ?? {}), balance: row });
  for (const row of cashFlow) rows.set(statementKey(row), { ...(rows.get(statementKey(row)) ?? {}), cashFlow: row });
  return [...rows.values()]
    .sort((left, right) => String(right.income?.date ?? right.balance?.date ?? '').localeCompare(String(left.income?.date ?? left.balance?.date ?? '')))
    .slice(0, limit);
}

function segmentRows(records: SegmentRecord[], limit: number) {
  const selected = [...records]
    .sort((left, right) => String(right.date ?? '').localeCompare(String(left.date ?? '')))
    .slice(0, limit);
  return selected.flatMap((record) => {
    const entries = Object.entries(record.data ?? {}).filter((entry): entry is [string, number] => numeric(entry[1]) !== null);
    const total = entries.reduce((sum, [, value]) => sum + Number(value), 0);
    const currency = String(record.reportedCurrency ?? 'USD');
    const label = `${String(record.fiscalYear ?? record.date ?? '—')} ${String(record.period ?? '')}`.trim();
    return entries
      .sort((left, right) => Number(right[1]) - Number(left[1]))
      .map(([segment, value]) => ({
        period: label,
        segment,
        revenue: money(value, currency, true),
        share: total ? `${((value / total) * 100).toFixed(1)}%` : '—',
        rawRevenue: value,
        currency
      }));
  });
}

export const tools = defineTools({
  fmp_market_activity: {
    description:
      'Get FMP’s current most-active U.S. stocks with symbol, company, exchange, price, and session percentage move. This zero-argument tool is the extension health check and a quick market-activity starting point; FMP currently returns 50 rows and the card/text show the first 15 in API order. Use company-specific tools next for fundamentals—high trading activity is not an investment recommendation.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    card: marketCard,
    async execute() {
      const rows = await fetchMostActives(credential());
      const stocks = rows.slice(0, 15).map((row) => ({
        symbol: String(row.symbol ?? ''),
        name: String(row.name ?? ''),
        price: money(row.price),
        rawPrice: numeric(row.price),
        change: numeric(row.change),
        changePct: percentPoints(row.changesPercentage),
        rawChangePercentage: numeric(row.changesPercentage),
        exchange: String(row.exchange ?? '')
      }));
      if (!stocks.length) throw new Error('FMP returned no most-active stocks.');
      const fetchedAt = new Date().toISOString();
      return {
        text: `FMP most-active stocks (${stocks.length} shown of ${rows.length}):\n${stocks
          .slice(0, 10)
          .map((row, index) => `${index + 1}. ${row.symbol} — ${row.name}: ${row.price} (${row.changePct})`)
          .join('\n')}`,
        data: { count: stocks.length, totalReturned: rows.length, fetchedAt, stocks },
        references: [
          sourceReference(
            'fmp-most-actives',
            'FMP most active stocks',
            'most-actives',
            {},
            `${rows.length} most-active stock rows returned; ${stocks.length} shown.`,
            stocks
          )
        ]
      };
    }
  },

  fmp_company_overview: {
    description:
      'Get a compact current company and valuation snapshot from FMP for one exact ticker. It combines profile, quote, TTM key metrics, TTM ratios, and financial scores to answer price, market cap, trailing P/E, EV/EBITDA, P/S, P/FCF, P/B, margins, ROE, ROIC, leverage, liquidity, Altman Z, and Piotroski questions. TTM ratios update with filings while price-based fields may move with the market. For forward P/E and analyst expectations use fmp_analyst_outlook; for trends use fmp_company_financials.',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Exact exchange ticker such as AAPL, BRK.B, or 0700.HK.' }
      },
      required: ['symbol'],
      additionalProperties: false
    },
    card: overviewCard,
    async execute(args) {
      const symbol = normalizeSymbol(args.symbol);
      const apiKey = credential();
      const [profiles, quotes, keyMetricsRows, ratioRows, scoreRows] = await Promise.all([
        fetchProfile(symbol, apiKey),
        fetchQuote(symbol, apiKey),
        fetchKeyMetricsTtm(symbol, apiKey),
        fetchRatiosTtm(symbol, apiKey),
        fetchFinancialScores(symbol, apiKey)
      ]);
      const profile = first(profiles);
      const quote = first(quotes);
      const keyMetrics = first(keyMetricsRows);
      const ratios = first(ratioRows);
      const scores = first(scoreRows);
      if (!profile && !quote) throw new Error(`FMP returned no profile or quote for ${symbol}.`);
      const companyName = String(profile?.companyName ?? quote?.name ?? symbol);
      const currency = String(profile?.currency ?? 'USD');
      const price = readNumber(quote, 'price') ?? readNumber(profile, 'price');
      const raw = {
        profile,
        quote,
        keyMetrics,
        ratios,
        scores
      };
      const metrics = {
        price,
        changePercentage: readNumber(quote, 'changePercentage') ?? readNumber(profile, 'changePercentage'),
        marketCap: readNumber(quote, 'marketCap') ?? readNumber(profile, 'marketCap'),
        trailingPe: readNumber(ratios, 'priceToEarningsRatioTTM'),
        evToEbitda: readNumber(keyMetrics, 'evToEBITDATTM') ?? readNumber(ratios, 'enterpriseValueMultipleTTM'),
        priceToSales: readNumber(ratios, 'priceToSalesRatioTTM'),
        priceToFcf: readNumber(ratios, 'priceToFreeCashFlowRatioTTM'),
        priceToBook: readNumber(ratios, 'priceToBookRatioTTM'),
        peg: readNumber(ratios, 'priceToEarningsGrowthRatioTTM'),
        grossMargin: readNumber(ratios, 'grossProfitMarginTTM'),
        operatingMargin: readNumber(ratios, 'operatingProfitMarginTTM'),
        netMargin: readNumber(ratios, 'netProfitMarginTTM'),
        roe: readNumber(keyMetrics, 'returnOnEquityTTM'),
        roic: readNumber(keyMetrics, 'returnOnInvestedCapitalTTM'),
        fcfYield: readNumber(keyMetrics, 'freeCashFlowYieldTTM'),
        currentRatio: readNumber(ratios, 'currentRatioTTM') ?? readNumber(keyMetrics, 'currentRatioTTM'),
        debtToEquity: readNumber(ratios, 'debtToEquityRatioTTM'),
        netDebtToEbitda: readNumber(keyMetrics, 'netDebtToEBITDATTM'),
        piotroski: readNumber(scores, 'piotroskiScore'),
        altman: readNumber(scores, 'altmanZScore')
      };
      const data = {
        symbol,
        companyName,
        price: money(metrics.price, currency),
        changePct: percentPoints(metrics.changePercentage),
        marketCap: money(metrics.marketCap, currency, true),
        trailingPe: decimalNumber(metrics.trailingPe),
        evToEbitda: decimalNumber(metrics.evToEbitda),
        priceToSales: decimalNumber(metrics.priceToSales),
        priceToFcf: decimalNumber(metrics.priceToFcf),
        priceToBook: decimalNumber(metrics.priceToBook),
        peg: decimalNumber(metrics.peg),
        grossMargin: percentRatio(metrics.grossMargin),
        operatingMargin: percentRatio(metrics.operatingMargin),
        netMargin: percentRatio(metrics.netMargin),
        roe: percentRatio(metrics.roe),
        roic: percentRatio(metrics.roic),
        fcfYield: percentRatio(metrics.fcfYield),
        currentRatio: decimalNumber(metrics.currentRatio),
        debtToEquity: decimalNumber(metrics.debtToEquity),
        netDebtToEbitda: decimalNumber(metrics.netDebtToEbitda),
        piotroski: decimalNumber(metrics.piotroski, 0),
        altman: decimalNumber(metrics.altman),
        sectorIndustry: [profile?.sector, profile?.industry].filter(Boolean).join(' / ') || '—',
        exchange: String(profile?.exchangeFullName ?? profile?.exchange ?? quote?.exchange ?? '—'),
        currency,
        website: String(profile?.website ?? '—'),
        metrics,
        raw
      };
      return {
        text:
          `${symbol} (${companyName}) is ${data.price}, market cap ${data.marketCap}, with trailing P/E ${data.trailingPe}, ` +
          `EV/EBITDA ${data.evToEbitda}, P/FCF ${data.priceToFcf}, operating margin ${data.operatingMargin}, ` +
          `ROE ${data.roe}, debt/equity ${data.debtToEquity}, Piotroski ${data.piotroski}, and Altman Z ${data.altman}.`,
        data,
        references: [
          sourceReference(`fmp-${symbol}-profile`, `${symbol} FMP profile`, 'profile', { symbol }, `${companyName}; ${data.sectorIndustry}; market cap ${data.marketCap}.`, profile),
          sourceReference(`fmp-${symbol}-quote`, `${symbol} FMP quote`, 'quote', { symbol }, `${symbol} price ${data.price}; session change ${data.changePct}.`, quote),
          sourceReference(`fmp-${symbol}-key-metrics-ttm`, `${symbol} FMP TTM key metrics`, 'key-metrics-ttm', { symbol }, `EV/EBITDA ${data.evToEbitda}; ROE ${data.roe}; ROIC ${data.roic}; FCF yield ${data.fcfYield}.`, keyMetrics),
          sourceReference(`fmp-${symbol}-ratios-ttm`, `${symbol} FMP TTM ratios`, 'ratios-ttm', { symbol }, `P/E ${data.trailingPe}; P/S ${data.priceToSales}; P/FCF ${data.priceToFcf}; operating margin ${data.operatingMargin}.`, ratios),
          sourceReference(`fmp-${symbol}-financial-scores`, `${symbol} FMP financial scores`, 'financial-scores', { symbol }, `Piotroski ${data.piotroski}; Altman Z ${data.altman}.`, scores)
        ]
      };
    }
  },

  fmp_company_financials: {
    description:
      'Get aligned multi-period FMP income statement, balance sheet, and cash-flow fundamentals for one ticker. Returns revenue, operating income, net income, diluted EPS, operating cash flow, capex/free cash flow, cash, debt, and current ratio. period defaults to annual; quarter returns sequential reported quarters. limit defaults to 5 and is capped at 10 to keep model context bounded. Use this for growth, margins, cash generation, debt, liquidity, and trend questions; use filings only for disclosure-level detail.',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Exact exchange ticker such as AAPL.' },
        period: { type: 'string', enum: ['annual', 'quarter'], default: 'annual', description: 'Statement cadence: annual (default) or quarter.' },
        limit: { type: 'integer', minimum: 1, maximum: 10, default: 5, description: 'Most recent aligned periods to return, from 1 through 10.' }
      },
      required: ['symbol'],
      additionalProperties: false
    },
    card: financialsCard,
    async execute(args) {
      const symbol = normalizeSymbol(args.symbol);
      const period = normalizePeriod(args.period);
      const limit = boundedInteger(args.limit, 5, 1, 10, 'limit');
      const apiKey = credential();
      const [income, balanceSheet, cashFlow] = await Promise.all([
        fetchIncomeStatement({ symbol, period, limit, apiKey }),
        fetchBalanceSheet({ symbol, period, limit, apiKey }),
        fetchCashFlowStatement({ symbol, period, limit, apiKey })
      ]);
      const merged = mergeStatements(income, balanceSheet, cashFlow, limit);
      if (!merged.length) throw new Error(`FMP returned no ${period} statements for ${symbol}.`);
      const rawPeriods = merged.map(({ income: incomeRow = {}, balance: balanceRow = {}, cashFlow: cashRow = {} }) => {
        const currency = String(incomeRow.reportedCurrency ?? balanceRow.reportedCurrency ?? cashRow.reportedCurrency ?? 'USD');
        const capex = readNumber(cashRow, 'capitalExpenditure', 'investmentsInPropertyPlantAndEquipment');
        const operatingCashFlow = readNumber(cashRow, 'operatingCashFlow', 'netCashProvidedByOperatingActivities');
        const freeCashFlow = readNumber(cashRow, 'freeCashFlow') ?? (operatingCashFlow !== null && capex !== null ? operatingCashFlow + capex : null);
        const currentAssets = readNumber(balanceRow, 'totalCurrentAssets');
        const currentLiabilities = readNumber(balanceRow, 'totalCurrentLiabilities');
        return {
          date: String(incomeRow.date ?? balanceRow.date ?? cashRow.date ?? ''),
          fiscalYear: String(incomeRow.fiscalYear ?? balanceRow.fiscalYear ?? cashRow.fiscalYear ?? ''),
          period: String(incomeRow.period ?? balanceRow.period ?? cashRow.period ?? ''),
          currency,
          revenue: readNumber(incomeRow, 'revenue'),
          grossProfit: readNumber(incomeRow, 'grossProfit'),
          operatingIncome: readNumber(incomeRow, 'operatingIncome'),
          netIncome: readNumber(incomeRow, 'netIncome'),
          epsDiluted: readNumber(incomeRow, 'epsDiluted'),
          operatingCashFlow,
          capex,
          freeCashFlow,
          cash: readNumber(balanceRow, 'cashAndShortTermInvestments', 'cashAndCashEquivalents'),
          debt: (() => {
            const totalDebt = readNumber(balanceRow, 'totalDebt');
            const shortTermDebt = readNumber(balanceRow, 'shortTermDebt');
            const longTermDebt = readNumber(balanceRow, 'longTermDebt');
            if (totalDebt !== null) return totalDebt;
            if (shortTermDebt === null && longTermDebt === null) return null;
            return (shortTermDebt ?? 0) + (longTermDebt ?? 0);
          })(),
          netDebt: readNumber(balanceRow, 'netDebt'),
          currentRatio: currentAssets !== null && currentLiabilities ? currentAssets / currentLiabilities : null
        };
      });
      const periods = rawPeriods.map((row) => ({
        label: `${row.fiscalYear || row.date} ${row.period}`.trim(),
        revenue: money(row.revenue, row.currency, true),
        grossProfit: money(row.grossProfit, row.currency, true),
        operatingIncome: money(row.operatingIncome, row.currency, true),
        netIncome: money(row.netIncome, row.currency, true),
        epsDiluted: money(row.epsDiluted, row.currency),
        operatingCashFlow: money(row.operatingCashFlow, row.currency, true),
        capex: money(row.capex, row.currency, true),
        freeCashFlow: money(row.freeCashFlow, row.currency, true),
        cash: money(row.cash, row.currency, true),
        debt: money(row.debt, row.currency, true),
        currentRatio: decimalNumber(row.currentRatio)
      }));
      const latest = periods[0];
      const data = {
        symbol,
        period,
        periodLabel: period === 'annual' ? 'annual' : 'quarterly',
        count: periods.length,
        latestRevenue: latest.revenue,
        latestNetIncome: latest.netIncome,
        latestFreeCashFlow: latest.freeCashFlow,
        periods,
        rawPeriods,
        statements: { income, balanceSheet, cashFlow }
      };
      return {
        text: `${symbol} ${data.periodLabel} financials (${periods.length} periods):\n${periods
          .map((row) => `${row.label}: revenue ${row.revenue}; operating income ${row.operatingIncome}; net income ${row.netIncome}; FCF ${row.freeCashFlow}; debt ${row.debt}.`)
          .join('\n')}`,
        data,
        references: [
          sourceReference(`fmp-${symbol}-income-${period}`, `${symbol} FMP income statements`, 'income-statement', { symbol, period, limit }, `${income.length} ${period} income statements returned.`, income),
          sourceReference(`fmp-${symbol}-balance-${period}`, `${symbol} FMP balance sheets`, 'balance-sheet-statement', { symbol, period, limit }, `${balanceSheet.length} ${period} balance sheets returned.`, balanceSheet),
          sourceReference(`fmp-${symbol}-cash-flow-${period}`, `${symbol} FMP cash flow statements`, 'cash-flow-statement', { symbol, period, limit }, `${cashFlow.length} ${period} cash-flow statements returned.`, cashFlow)
        ]
      };
    }
  },

  fmp_analyst_outlook: {
    description:
      'Get forward-looking FMP analyst context for one ticker: annual or quarterly revenue/EPS estimate ranges and analyst counts, implied forward P/E using the current quote, FMP ratings snapshot, consensus price-target range/upside, and recent price-target trend. Estimates are fetched with FMP limit=10, historical dates are removed when upcoming rows exist, upcoming dates are sorted nearest-first, and 1–8 are shown. Set include_recent_grades=true only for upgrade/downgrade questions; FMP’s grades endpoint returns a large history and this tool trims it after download.',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Exact exchange ticker such as AAPL.' },
        period: { type: 'string', enum: ['annual', 'quarter'], default: 'annual', description: 'Estimate cadence: annual (default) or quarter.' },
        limit: { type: 'integer', minimum: 1, maximum: 8, default: 5, description: 'Nearest estimate dates to show after FMP results are sorted ascending, from 1 through 8.' },
        include_recent_grades: { type: 'boolean', default: false, description: 'Fetch individual analyst-firm grade actions only when upgrades/downgrades are needed. Defaults false because FMP returns a large history.' },
        grade_limit: { type: 'integer', minimum: 1, maximum: 25, default: 10, description: 'Rows to retain when include_recent_grades=true; ignored otherwise.' }
      },
      required: ['symbol'],
      additionalProperties: false
    },
    card: analystCard,
    async execute(args) {
      const symbol = normalizeSymbol(args.symbol);
      const period = normalizePeriod(args.period);
      const limit = boundedInteger(args.limit, 5, 1, 8, 'limit');
      const includeRecentGrades = args.include_recent_grades === true;
      const gradeLimit = boundedInteger(args.grade_limit, 10, 1, 25, 'grade_limit');
      const apiKey = credential();
      const [profiles, quotes, estimateRows, ratingRows, consensusRows, summaryRows, gradeRows] = await Promise.all([
        fetchProfile(symbol, apiKey),
        fetchQuote(symbol, apiKey),
        fetchAnalystEstimates(symbol, period, apiKey),
        fetchRatingsSnapshot(symbol, apiKey),
        fetchPriceTargetConsensus(symbol, apiKey),
        fetchPriceTargetSummary(symbol, apiKey),
        includeRecentGrades ? fetchAnalystGrades(symbol, apiKey) : Promise.resolve([])
      ]);
      const profile = first(profiles);
      const quote = first(quotes);
      const ratingSnapshot = first(ratingRows);
      const consensus = first(consensusRows);
      const targetSummary = first(summaryRows);
      const price = readNumber(quote, 'price');
      const currency = String(profile?.currency ?? 'USD');
      const sortedEstimates = [...estimateRows]
        .filter((row) => row && row.date)
        .sort((left, right) => String(left.date).localeCompare(String(right.date)));
      const today = new Date().toISOString().slice(0, 10);
      const upcomingEstimates = sortedEstimates.filter((row) => String(row.date) >= today);
      const rawEstimates = (upcomingEstimates.length ? upcomingEstimates : [...sortedEstimates].reverse()).slice(0, limit);
      if (!rawEstimates.length && !ratingSnapshot && !consensus) {
        throw new Error(`FMP returned no analyst outlook for ${symbol}.`);
      }
      const estimates = rawEstimates.map((row) => {
        const epsAvg = numeric(row.epsAvg);
        const forwardPe = price !== null && epsAvg !== null && epsAvg > 0 ? price / epsAvg : null;
        return {
          date: String(row.date ?? ''),
          revenueAvg: money(row.revenueAvg, currency, true),
          revenueRange: `${money(row.revenueLow, currency, true)} – ${money(row.revenueHigh, currency, true)}`,
          epsAvg: money(row.epsAvg, currency),
          epsRange: `${money(row.epsLow, currency)} – ${money(row.epsHigh, currency)}`,
          forwardPe: decimalNumber(forwardPe),
          epsAnalysts: decimalNumber(row.numAnalystsEps, 0),
          revenueAnalysts: decimalNumber(row.numAnalystsRevenue, 0),
          raw: row
        };
      });
      const targetConsensusRaw = numeric(consensus?.targetConsensus);
      const targetUpsideRaw = price !== null && price !== 0 && targetConsensusRaw !== null
        ? ((targetConsensusRaw - price) / price) * 100
        : null;
      const recentGradeRows = gradeRows.slice(0, gradeLimit);
      const recentGrades = recentGradeRows.map((row) => ({
        date: String(row.date ?? ''),
        firm: String(row.gradingCompany ?? ''),
        action: String(row.action ?? ''),
        previousGrade: String(row.previousGrade ?? ''),
        newGrade: String(row.newGrade ?? '')
      }));
      const data = {
        symbol,
        period,
        periodLabel: period === 'annual' ? 'annual estimates' : 'quarterly estimates',
        currentPrice: money(price, currency),
        targetConsensus: money(targetConsensusRaw, currency),
        targetUpside: percentPoints(targetUpsideRaw),
        targetRange: `${money(consensus?.targetLow, currency)} – ${money(consensus?.targetHigh, currency)}`,
        targetMedian: money(consensus?.targetMedian, currency),
        lastMonthTarget: `${money(targetSummary?.lastMonthAvgPriceTarget, currency)} (${decimalNumber(targetSummary?.lastMonthCount, 0)} targets)`,
        lastQuarterTarget: `${money(targetSummary?.lastQuarterAvgPriceTarget, currency)} (${decimalNumber(targetSummary?.lastQuarterCount, 0)} targets)`,
        lastYearTarget: `${money(targetSummary?.lastYearAvgPriceTarget, currency)} (${decimalNumber(targetSummary?.lastYearCount, 0)} targets)`,
        rating: String(ratingSnapshot?.rating ?? '—'),
        ratingScore: `${decimalNumber(ratingSnapshot?.overallScore, 0)} / 5`,
        currency,
        estimates,
        recentGrades,
        includeRecentGrades,
        raw: {
          profile,
          quote,
          estimates: rawEstimates,
          ratingSnapshot,
          priceTargetConsensus: consensus,
          priceTargetSummary: targetSummary,
          recentGrades: recentGradeRows
        }
      };
      const estimateText = estimates
        .map((row) => `${row.date}: revenue ${row.revenueAvg}; EPS ${row.epsAvg}; implied forward P/E ${row.forwardPe} (${row.epsAnalysts} EPS analysts).`)
        .join('\n');
      const gradesText = recentGrades.length
        ? `\nRecent actions:\n${recentGrades.map((row) => `${row.date}: ${row.firm} ${row.action} ${row.previousGrade} → ${row.newGrade}.`).join('\n')}`
        : '';
      const references = [
        sourceReference(`fmp-${symbol}-profile-analyst`, `${symbol} FMP profile currency`, 'profile', { symbol }, `${symbol} forecast display currency ${currency}.`, profile),
        sourceReference(`fmp-${symbol}-quote-analyst`, `${symbol} FMP current quote`, 'quote', { symbol }, `${symbol} current price ${data.currentPrice}.`, quote),
        sourceReference(`fmp-${symbol}-analyst-estimates-${period}`, `${symbol} FMP analyst estimates`, 'analyst-estimates', { symbol, period, page: 0, limit: 10 }, `${estimateRows.length} ${period} estimate rows returned; ${estimates.length} nearest rows shown.`, rawEstimates),
        sourceReference(`fmp-${symbol}-rating`, `${symbol} FMP ratings snapshot`, 'ratings-snapshot', { symbol }, `FMP rating ${data.rating}; overall score ${data.ratingScore}.`, ratingSnapshot),
        sourceReference(`fmp-${symbol}-price-target`, `${symbol} FMP price target consensus`, 'price-target-consensus', { symbol }, `Consensus target ${data.targetConsensus}; range ${data.targetRange}; implied upside ${data.targetUpside}.`, consensus),
        sourceReference(`fmp-${symbol}-price-target-summary`, `${symbol} FMP price target trend`, 'price-target-summary', { symbol }, `Last-month average ${data.lastMonthTarget}; last-quarter average ${data.lastQuarterTarget}.`, targetSummary)
      ];
      if (includeRecentGrades) {
        references.push(sourceReference(`fmp-${symbol}-grades`, `${symbol} FMP analyst grades`, 'grades', { symbol }, `${gradeRows.length} grade rows returned; ${recentGrades.length} recent rows retained.`, recentGradeRows));
      }
      return {
        text:
          `${symbol} analyst outlook: price ${data.currentPrice}; consensus target ${data.targetConsensus} (${data.targetUpside}), ` +
          `range ${data.targetRange}; FMP rating ${data.rating} (${data.ratingScore}).\n${estimateText}${gradesText}`,
        data,
        references
      };
    }
  },

  fmp_company_segments: {
    description:
      'Get FMP revenue mix by product/business and geography for one ticker. period defaults to annual; quarter requests quarterly segmentation where the company reports it. period_limit defaults to 2 and caps at 5; within each period, segments are sorted largest first and include revenue plus share of that endpoint’s reported total. Use this for concentration, mix shift, regional exposure, and business-segment questions.',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Exact exchange ticker such as AAPL.' },
        period: { type: 'string', enum: ['annual', 'quarter'], default: 'annual', description: 'Segmentation cadence: annual (default) or quarter.' },
        period_limit: { type: 'integer', minimum: 1, maximum: 5, default: 2, description: 'Most recent reporting periods to retain from each segmentation endpoint.' }
      },
      required: ['symbol'],
      additionalProperties: false
    },
    card: segmentsCard,
    async execute(args) {
      const symbol = normalizeSymbol(args.symbol);
      const period = normalizePeriod(args.period);
      const periodLimit = boundedInteger(args.period_limit, 2, 1, 5, 'period_limit');
      const apiKey = credential();
      const [productRaw, geographicRaw] = await Promise.all([
        fetchProductSegments({ symbol, period, apiKey }),
        fetchGeographicSegments({ symbol, period, apiKey })
      ]);
      const productSegments = segmentRows(productRaw, periodLimit);
      const geographicSegments = segmentRows(geographicRaw, periodLimit);
      if (!productSegments.length && !geographicSegments.length) {
        throw new Error(`FMP returned no ${period} revenue segmentation for ${symbol}.`);
      }
      const data = {
        symbol,
        period,
        periodLabel: period === 'annual' ? 'annual' : 'quarterly',
        periodCount: Math.max(Math.min(productRaw.length, periodLimit), Math.min(geographicRaw.length, periodLimit)),
        productCount: productSegments.length,
        geographicCount: geographicSegments.length,
        productSegments,
        geographicSegments,
        raw: { product: productRaw.slice(0, periodLimit), geographic: geographicRaw.slice(0, periodLimit) }
      };
      const latestProducts = productSegments.filter((row) => row.period === productSegments[0]?.period).slice(0, 6);
      const latestGeographies = geographicSegments.filter((row) => row.period === geographicSegments[0]?.period).slice(0, 6);
      return {
        text:
          `${symbol} latest product/business mix:\n${latestProducts.map((row) => `${row.segment}: ${row.revenue} (${row.share})`).join('\n')}` +
          `\nLatest geographic mix:\n${latestGeographies.map((row) => `${row.segment}: ${row.revenue} (${row.share})`).join('\n')}`,
        data,
        references: [
          sourceReference(`fmp-${symbol}-product-segments-${period}`, `${symbol} FMP product revenue segments`, 'revenue-product-segmentation', { symbol, period }, `${productRaw.length} ${period} product-segmentation periods returned.`, productRaw.slice(0, periodLimit)),
          sourceReference(`fmp-${symbol}-geographic-segments-${period}`, `${symbol} FMP geographic revenue segments`, 'revenue-geographic-segmentation', { symbol, period }, `${geographicRaw.length} ${period} geographic-segmentation periods returned.`, geographicRaw.slice(0, periodLimit))
        ]
      };
    }
  },

  fmp_stock_peers: {
    description:
      'Get FMP’s peer-company list for one exact ticker, including peer symbols, names, current prices, and market caps when supplied. FMP chooses peers using sector, market-cap, and exchange similarity; this is a discovery list, not a valuation comparison. limit defaults to 8 and caps at 15. Follow with fmp_company_overview or fmp_company_financials on selected symbols for evidence-based comparison.',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Exact exchange ticker whose FMP peers should be returned.' },
        limit: { type: 'integer', minimum: 1, maximum: 15, default: 8, description: 'Maximum peer rows to retain, from 1 through 15.' }
      },
      required: ['symbol'],
      additionalProperties: false
    },
    card: peersCard,
    async execute(args) {
      const symbol = normalizeSymbol(args.symbol);
      const limit = boundedInteger(args.limit, 8, 1, 15, 'limit');
      const rows = await fetchStockPeers(symbol, credential());
      const peers = rows
        .filter((row) => String(row.symbol ?? '').toUpperCase() !== symbol)
        .slice(0, limit)
        .map((row) => ({
          symbol: String(row.symbol ?? ''),
          companyName: String(row.companyName ?? ''),
          price: money(row.price),
          marketCap: money(row.mktCap, 'USD', true),
          rawPrice: numeric(row.price),
          rawMarketCap: numeric(row.mktCap)
        }));
      if (!peers.length) throw new Error(`FMP returned no peer companies for ${symbol}.`);
      return {
        text: `FMP peers for ${symbol}:\n${peers.map((row) => `${row.symbol} — ${row.companyName}; price ${row.price}; market cap ${row.marketCap}.`).join('\n')}`,
        data: { symbol, count: peers.length, peers, raw: rows.slice(0, limit) },
        references: [
          sourceReference(`fmp-${symbol}-peers`, `${symbol} FMP stock peers`, 'stock-peers', { symbol }, `${rows.length} peer rows returned; ${peers.length} shown.`, rows.slice(0, limit))
        ]
      };
    }
  }
});
