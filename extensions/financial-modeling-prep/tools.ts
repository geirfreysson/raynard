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
  fetchCompanyScreener,
  fetchEnterpriseValues,
  fetchFinancialScores,
  fetchGeographicSegments,
  fetchHistoricalPrices,
  fetchIncomeStatement,
  fetchKeyMetrics,
  fetchKeyMetricsTtm,
  fetchMostActives,
  fetchPriceTargetConsensus,
  fetchPriceTargetSummary,
  fetchProductSegments,
  fetchProfile,
  fetchQuote,
  fetchRatingsSnapshot,
  fetchRatios,
  fetchRatiosTtm,
  fetchStockPeers,
  fmpSourceUrl,
  type FmpRecord,
  type HistoricalMetricRecord,
  type HistoricalPriceEod,
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

function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} must be a number.`);
  return number;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${label} must be true or false.`);
}

function optionalText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

/**
 * Screener filters, tool-facing snake_case to FMP camelCase.
 *
 * The rest of this extension names multi-word parameters in snake_case, so the
 * screener keeps that convention at the tool boundary and translates here
 * rather than leaking the provider's spelling into the tool schema.
 */
const SCREENER_NUMBER_FILTERS: Record<string, string> = {
  market_cap_more_than: 'marketCapMoreThan',
  market_cap_lower_than: 'marketCapLowerThan',
  price_more_than: 'priceMoreThan',
  price_lower_than: 'priceLowerThan',
  beta_more_than: 'betaMoreThan',
  beta_lower_than: 'betaLowerThan',
  dividend_more_than: 'dividendMoreThan',
  dividend_lower_than: 'dividendLowerThan',
  volume_more_than: 'volumeMoreThan',
  volume_lower_than: 'volumeLowerThan',
  avg_volume_more_than: 'avgVolumeMoreThan',
  avg_volume_lower_than: 'avgVolumeLowerThan'
};

const SCREENER_TEXT_FILTERS: Record<string, string> = {
  sector: 'sector',
  industry: 'industry',
  exchange: 'exchange',
  country: 'country'
};

const SCREENER_BOOLEAN_FILTERS: Record<string, string> = {
  is_etf: 'isEtf',
  is_fund: 'isFund',
  is_actively_trading: 'isActivelyTrading',
  include_all_share_classes: 'includeAllShareClasses'
};

/** Ranges whose bounds would exclude every company if given backwards. */
const SCREENER_RANGE_PAIRS: Array<[string, string]> = [
  ['market_cap_more_than', 'market_cap_lower_than'],
  ['price_more_than', 'price_lower_than'],
  ['beta_more_than', 'beta_lower_than'],
  ['dividend_more_than', 'dividend_lower_than'],
  ['volume_more_than', 'volume_lower_than'],
  ['avg_volume_more_than', 'avg_volume_lower_than']
];

function screenerFilters(args: Record<string, unknown>): Record<string, string | number> {
  const numbers = new Map<string, number>();
  for (const key of Object.keys(SCREENER_NUMBER_FILTERS)) {
    const value = optionalNumber(args[key], key);
    if (value !== undefined) numbers.set(key, value);
  }
  for (const [lowKey, highKey] of SCREENER_RANGE_PAIRS) {
    const low = numbers.get(lowKey);
    const high = numbers.get(highKey);
    if (low !== undefined && high !== undefined && low > high) {
      throw new Error(`${lowKey} must be less than or equal to ${highKey}.`);
    }
  }

  const filters: Record<string, string | number> = {};
  for (const [key, apiKey] of Object.entries(SCREENER_NUMBER_FILTERS)) {
    const value = numbers.get(key);
    if (value !== undefined) filters[apiKey] = value;
  }
  for (const [key, apiKey] of Object.entries(SCREENER_TEXT_FILTERS)) {
    const value = optionalText(args[key]);
    if (value !== undefined) filters[apiKey] = value;
  }
  for (const [key, apiKey] of Object.entries(SCREENER_BOOLEAN_FILTERS)) {
    const value = optionalBoolean(args[key], key);
    if (value !== undefined) filters[apiKey] = String(value);
  }
  return filters;
}

function normalizePeriod(value: unknown, fallback: 'annual' | 'quarter' = 'annual'): 'annual' | 'quarter' {
  const period = String(value ?? fallback).trim().toLowerCase();
  if (period !== 'annual' && period !== 'quarter') {
    throw new Error('period must be annual or quarter.');
  }
  return period;
}

type YearRange = {
  startYear: number | null;
  endYear: number | null;
};

function normalizeYearRange(startValue: unknown, endValue: unknown): YearRange {
  const normalize = (value: unknown, label: string): number | null => {
    if (value === undefined || value === null || value === '') return null;
    const year = Number(value);
    if (!Number.isInteger(year) || year < 1900 || year > 2100) {
      throw new Error(`${label} must be a four-digit year from 1900 through 2100.`);
    }
    return year;
  };
  let startYear = normalize(startValue, 'start_year');
  const endYear = normalize(endValue, 'end_year');
  if (startYear === null && endYear !== null) startYear = endYear;
  if (startYear !== null && endYear !== null && startYear > endYear) {
    throw new Error('start_year must be less than or equal to end_year.');
  }
  const low = startYear;
  const high = endYear ?? (startYear === null ? null : new Date().getUTCFullYear() + 1);
  if (low !== null && high !== null && high - low > 39) {
    throw new Error('The requested year range cannot exceed 40 years.');
  }
  return { startYear, endYear };
}

function recordYear(record: { fiscalYear?: string | number; date?: string }): number | null {
  const fiscalYear = Number(record.fiscalYear);
  if (Number.isInteger(fiscalYear)) return fiscalYear;
  const dateYear = Number(String(record.date ?? '').slice(0, 4));
  return Number.isInteger(dateYear) ? dateYear : null;
}

function filterByYear<T extends { fiscalYear?: string | number; date?: string }>(records: T[], range: YearRange): T[] {
  if (range.startYear === null && range.endYear === null) return records;
  return records.filter((record) => {
    const year = recordYear(record);
    if (year === null) return false;
    if (range.startYear !== null && year < range.startYear) return false;
    if (range.endYear !== null && year > range.endYear) return false;
    return true;
  });
}

function historicalRequestLimit(period: 'annual' | 'quarter', range: YearRange, fallback: number): number {
  if (range.startYear === null && range.endYear === null) return fallback;
  const currentYear = new Date().getUTCFullYear() + 1;
  const oldestYear = range.startYear ?? range.endYear ?? currentYear;
  const annualPeriods = Math.max(1, currentYear - oldestYear + 1);
  return Math.min(160, period === 'quarter' ? annualPeriods * 4 + 8 : annualPeriods + 2);
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

const keyMetricsTtmCard = defineCard({
  name: { singular: 'TTM metrics snapshot', plural: 'TTM metrics snapshots' },
  title: '{{symbol}} — current TTM key metrics',
  layout: [
    {
      component: 'MetricRow',
      items: [
        { label: 'Market cap', field: 'marketCap' },
        { label: 'Enterprise value', field: 'enterpriseValue' },
        { label: 'EV / EBITDA', field: 'evToEbitda' },
        { label: 'FCF yield', field: 'freeCashFlowYield' }
      ]
    },
    {
      component: 'Grid',
      columns: 2,
      layout: [
        {
          component: 'Section',
          title: 'Valuation & cash flow',
          layout: [
            {
              component: 'KeyValue',
              pairs: [
                { label: 'EV / sales', field: 'evToSales' },
                { label: 'EV / operating cash flow', field: 'evToOperatingCashFlow' },
                { label: 'EV / free cash flow', field: 'evToFreeCashFlow' },
                { label: 'Earnings yield', field: 'earningsYield' },
                { label: 'FCF to firm', field: 'freeCashFlowToFirm' }
              ]
            }
          ]
        },
        {
          component: 'Section',
          title: 'Returns & balance sheet',
          layout: [
            {
              component: 'KeyValue',
              pairs: [
                { label: 'ROA', field: 'returnOnAssets' },
                { label: 'ROE', field: 'returnOnEquity' },
                { label: 'ROIC', field: 'returnOnInvestedCapital' },
                { label: 'Current ratio', field: 'currentRatio' },
                { label: 'Net debt / EBITDA', field: 'netDebtToEbitda' }
              ]
            }
          ]
        }
      ]
    },
    {
      component: 'KeyValue',
      pairs: [
        { label: 'Working capital', field: 'workingCapital' },
        { label: 'Invested capital', field: 'investedCapital' },
        { label: 'Tangible asset value', field: 'tangibleAssetValue' }
      ]
    }
  ]
});

const priceHistoryCard = defineCard({
  name: { singular: 'price point', plural: 'price points' },
  title: '{{symbol}} price history — {{range}}',
  layout: [
    {
      component: 'MetricRow',
      items: [
        { label: 'Latest close', field: 'latestClose' },
        { label: 'Range change', field: 'rangeChangePct', tone: 'delta' },
        { label: 'High close', field: 'rangeHigh' },
        { label: 'Low close', field: 'rangeLow' }
      ]
    },
    {
      component: 'KeyValue',
      pairs: [
        { label: 'Latest session', field: 'latestDate' },
        { label: 'Sessions', field: 'count' },
        { label: '20-session average', field: 'ma20' },
        { label: '50-session average', field: 'ma50' },
        { label: 'Average volume', field: 'averageVolume' }
      ]
    },
    {
      component: 'Table',
      rows: 'recentSessions',
      columns: [
        { header: 'Date', field: 'date' },
        { header: 'Close', field: 'close' },
        { header: 'Volume', field: 'volume' }
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

const valuationHistoryCard = defineCard({
  name: { singular: 'valuation period', plural: 'valuation periods' },
  title: '{{symbol}} valuation history — {{periodLabel}}',
  layout: [
    {
      component: 'MetricRow',
      items: [
        { label: 'Periods', field: 'count' },
        { label: 'Latest market cap', field: 'latestMarketCap' },
        { label: 'Latest P/E', field: 'latestPe' },
        { label: 'Latest EV / EBITDA', field: 'latestEvToEbitda' }
      ]
    },
    {
      component: 'Table',
      rows: 'periods',
      columns: [
        { header: 'Period', field: 'label' },
        { header: 'Market cap', field: 'marketCap' },
        { header: 'Enterprise value', field: 'enterpriseValue' },
        { header: 'P/E', field: 'priceToEarnings' },
        { header: 'P/S', field: 'priceToSales' },
        { header: 'P/B', field: 'priceToBook' },
        { header: 'P/FCF', field: 'priceToFcf' },
        { header: 'EV / EBITDA', field: 'evToEbitda' },
        { header: 'FCF yield', field: 'fcfYield' },
        { header: 'ROE', field: 'roe' },
        { header: 'ROIC', field: 'roic' }
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

const screenerCard = defineCard({
  name: { singular: 'screened company', plural: 'screened companies' },
  title: 'FMP company screener',
  layout: [
    {
      component: 'MetricRow',
      items: [
        { label: 'Matches', field: 'count' },
        { label: 'Filters', field: 'filterSummary', tone: 'muted' }
      ]
    },
    {
      component: 'Table',
      rows: 'rows',
      columns: [
        { header: 'Symbol', field: 'symbol' },
        { header: 'Company', field: 'companyName' },
        { header: 'Sector', field: 'sector' },
        { header: 'Industry', field: 'industry' },
        { header: 'Price', field: 'price' },
        { header: 'Market cap', field: 'marketCap' },
        { header: 'Beta', field: 'beta' },
        { header: 'Volume', field: 'volume' },
        { header: 'Exchange', field: 'exchange' }
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
) {
  const rows = new Map<string, { income?: StatementRow; balance?: StatementRow; cashFlow?: StatementRow }>();
  for (const row of income) rows.set(statementKey(row), { ...(rows.get(statementKey(row)) ?? {}), income: row });
  for (const row of balance) rows.set(statementKey(row), { ...(rows.get(statementKey(row)) ?? {}), balance: row });
  for (const row of cashFlow) rows.set(statementKey(row), { ...(rows.get(statementKey(row)) ?? {}), cashFlow: row });
  return [...rows.values()]
    .sort((left, right) => String(right.income?.date ?? right.balance?.date ?? '').localeCompare(String(left.income?.date ?? left.balance?.date ?? '')));
}

function sortByNewest<T extends { date?: string }>(records: T[]): T[] {
  return [...records].sort((left, right) => String(right.date ?? '').localeCompare(String(left.date ?? '')));
}

function selectHistoricalRecords<T extends { fiscalYear?: string | number; date?: string }>(
  records: T[],
  range: YearRange,
  limit: number
): T[] {
  const sorted = sortByNewest(records);
  const filtered = filterByYear(sorted, range);
  return range.startYear !== null || range.endYear !== null ? filtered : filtered.slice(0, limit);
}

function segmentRows(selected: SegmentRecord[]) {
  return selected.flatMap((record) => {
    const entries = Object.entries(record.data ?? {}).filter((entry): entry is [string, number] => numeric(entry[1]) !== null);
    const total = entries.reduce((sum, [, value]) => sum + Number(value), 0);
    const currency = String(record.reportedCurrency ?? 'USD');
    const label = `${String(record.fiscalYear ?? record.date ?? '—')} ${String(record.period ?? '')}`.trim();
    const fiscalYear = recordYear(record);
    return entries
      .sort((left, right) => Number(right[1]) - Number(left[1]))
      .map(([segment, value]) => ({
        period: label,
        fiscalYear,
        segment,
        segmentName: segment,
        revenue: money(value, currency, true),
        share: total ? `${((value / total) * 100).toFixed(1)}%` : '—',
        rawRevenue: value,
        pctOfTotal: total ? value / total : null,
        currency
      }));
  });
}

/**
 * Groups segment rows by period so a multi-year request summarises every period
 * it selected, not only the most recent one.
 */
function segmentSummaryLines(
  rows: Array<{ period: string; segment: string; revenue: string; share: string }>,
  segmentsPerPeriod = 4
) {
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) {
    const group = grouped.get(row.period) ?? [];
    group.push(row);
    grouped.set(row.period, group);
  }
  return [...grouped.entries()].map(([period, items]) => {
    const top = items.slice(0, segmentsPerPeriod);
    const tail = items.length > segmentsPerPeriod ? ` and ${items.length - segmentsPerPeriod} more` : '';
    return `${period}: ${top.map((r) => `${r.segment} ${r.revenue} (${r.share})`).join(', ')}${tail}`;
  });
}

function historicalMetricKey(row: HistoricalMetricRecord): string {
  if (row.date) return String(row.date);
  const year = recordYear(row);
  const period = String(row.period ?? '');
  return year === null ? `unknown|${period}` : `${year}|${period}`;
}

function mergeHistoricalMetrics(
  keyMetrics: HistoricalMetricRecord[],
  ratios: HistoricalMetricRecord[],
  enterpriseValues: HistoricalMetricRecord[]
) {
  const rows = new Map<string, {
    keyMetrics?: HistoricalMetricRecord;
    ratios?: HistoricalMetricRecord;
    enterpriseValues?: HistoricalMetricRecord;
  }>();
  for (const row of keyMetrics) {
    const key = historicalMetricKey(row);
    rows.set(key, { ...(rows.get(key) ?? {}), keyMetrics: row });
  }
  for (const row of ratios) {
    const key = historicalMetricKey(row);
    rows.set(key, { ...(rows.get(key) ?? {}), ratios: row });
  }
  for (const row of enterpriseValues) {
    const key = historicalMetricKey(row);
    rows.set(key, { ...(rows.get(key) ?? {}), enterpriseValues: row });
  }
  return [...rows.values()].sort((left, right) => {
    const leftRecord = left.keyMetrics ?? left.ratios ?? left.enterpriseValues ?? {};
    const rightRecord = right.keyMetrics ?? right.ratios ?? right.enterpriseValues ?? {};
    return String(rightRecord.date ?? rightRecord.fiscalYear ?? '').localeCompare(String(leftRecord.date ?? leftRecord.fiscalYear ?? ''));
  });
}

const PRICE_RANGE_LIMITS = {
  '1D': 1,
  '5D': 5,
  '1M': 22,
  '3M': 66,
  '6M': 132,
  '1Y': 252
} as const;

type PriceRange = keyof typeof PRICE_RANGE_LIMITS;

function normalizePriceRange(value: unknown): PriceRange {
  const range = String(value ?? '3M').trim().toUpperCase();
  if (!(range in PRICE_RANGE_LIMITS)) {
    throw new Error('range must be one of 1D, 5D, 1M, 3M, 6M, or 1Y.');
  }
  return range as PriceRange;
}

function historicalPricePoints(rows: HistoricalPriceEod[]) {
  return rows
    .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(String(row.date ?? '')) && numeric(row.close) !== null)
    .map((row) => ({
      date: String(row.date),
      close: Number(row.close),
      volume: numeric(row.volume),
      raw: row
    }))
    .sort((left, right) => left.date.localeCompare(right.date));
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
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
      'Get a compact current company and valuation snapshot from FMP for one exact ticker. It combines profile, quote, TTM key metrics, TTM ratios, and financial scores to answer price, market cap, trailing P/E, EV/EBITDA, P/S, P/FCF, P/B, margins, ROE, ROIC, leverage, liquidity, Altman Z, and Piotroski questions. TTM ratios update with filings while price-based fields may move with the market. For forward P/E and analyst expectations use fmp_analyst_outlook; for historical valuation multiples and market cap use fmp_valuation_history; for financial-statement trends use fmp_company_financials.',
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

  fmp_key_metrics_ttm: {
    description:
      'Get current trailing-twelve-month company statistics for one exact ticker from FMP’s non-historical key-metrics-ttm endpoint. This tool makes exactly one API request and does not fetch a quote, profile, ratios, financial scores, or price history. It returns market cap, enterprise-value multiples, earnings and free-cash-flow yields, returns on capital, liquidity, leverage, working capital, and cash-flow measures. Use this focused tool when the broader fmp_company_overview is unavailable under the configured FMP subscription; it does not provide the current share price or trailing P/E.',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Exact exchange ticker such as AAPL, CRM, BRK.B, or 0700.HK.' }
      },
      required: ['symbol'],
      additionalProperties: false
    },
    card: keyMetricsTtmCard,
    async execute(args) {
      const symbol = normalizeSymbol(args.symbol);
      const metrics = first(await fetchKeyMetricsTtm(symbol, credential()));
      if (!metrics) throw new Error(`FMP returned no current TTM key metrics for ${symbol}.`);

      const data = {
        symbol,
        marketCap: money(readNumber(metrics, 'marketCap'), 'USD', true),
        enterpriseValue: money(readNumber(metrics, 'enterpriseValueTTM'), 'USD', true),
        evToSales: decimalNumber(readNumber(metrics, 'evToSalesTTM')),
        evToOperatingCashFlow: decimalNumber(readNumber(metrics, 'evToOperatingCashFlowTTM')),
        evToFreeCashFlow: decimalNumber(readNumber(metrics, 'evToFreeCashFlowTTM')),
        evToEbitda: decimalNumber(readNumber(metrics, 'evToEBITDATTM')),
        netDebtToEbitda: decimalNumber(readNumber(metrics, 'netDebtToEBITDATTM')),
        currentRatio: decimalNumber(readNumber(metrics, 'currentRatioTTM')),
        returnOnAssets: percentRatio(readNumber(metrics, 'returnOnAssetsTTM')),
        returnOnEquity: percentRatio(readNumber(metrics, 'returnOnEquityTTM')),
        returnOnInvestedCapital: percentRatio(readNumber(metrics, 'returnOnInvestedCapitalTTM')),
        returnOnCapitalEmployed: percentRatio(readNumber(metrics, 'returnOnCapitalEmployedTTM')),
        earningsYield: percentRatio(readNumber(metrics, 'earningsYieldTTM')),
        freeCashFlowYield: percentRatio(readNumber(metrics, 'freeCashFlowYieldTTM')),
        workingCapital: money(readNumber(metrics, 'workingCapital'), 'USD', true),
        investedCapital: money(readNumber(metrics, 'investedCapitalTTM'), 'USD', true),
        freeCashFlowToEquity: money(readNumber(metrics, 'freeCashFlowToEquityTTM'), 'USD', true),
        freeCashFlowToFirm: money(readNumber(metrics, 'freeCashFlowToFirmTTM'), 'USD', true),
        tangibleAssetValue: money(readNumber(metrics, 'tangibleAssetValueTTM'), 'USD', true),
        raw: metrics
      };

      return {
        text:
          `${symbol} current FMP TTM key metrics: market cap ${data.marketCap}, enterprise value ${data.enterpriseValue}, ` +
          `EV/EBITDA ${data.evToEbitda}, EV/sales ${data.evToSales}, FCF yield ${data.freeCashFlowYield}, ` +
          `ROE ${data.returnOnEquity}, ROIC ${data.returnOnInvestedCapital}, current ratio ${data.currentRatio}, ` +
          `and net debt/EBITDA ${data.netDebtToEbitda}.`,
        data,
        references: [
          sourceReference(
            `fmp-${symbol}-key-metrics-ttm-focused`,
            `${symbol} FMP current TTM key metrics`,
            'key-metrics-ttm',
            { symbol },
            `${symbol} EV/EBITDA ${data.evToEbitda}; FCF yield ${data.freeCashFlowYield}; ROE ${data.returnOnEquity}; ROIC ${data.returnOnInvestedCapital}.`,
            metrics
          )
        ]
      };
    }
  },

  fmp_price_history: {
    description:
      'Get structured historical end-of-day closing prices and volume from FMP for one exact ticker. range defaults to 3M and supports 1D, 5D, 1M, 3M, 6M, or 1Y, mapped to the latest 1, 5, 22, 66, 132, or 252 trading sessions. Returns chronological chart-ready points plus range change, high/low closes, and 20/50-session moving averages computed from the full available history. Use this for recent stock movement and performance questions. If the user asks for a plot or chart, call present_chart after this tool using data.points with date on the x-axis and close on the y-axis.',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Exact exchange ticker such as CRM, AAPL, or BRK.B.' },
        range: {
          type: 'string',
          enum: ['1D', '5D', '1M', '3M', '6M', '1Y'],
          default: '3M',
          description: 'Price-history window: 1D, 5D, 1M, 3M, 6M, or 1Y. Defaults to 3M.'
        }
      },
      required: ['symbol'],
      additionalProperties: false
    },
    card: priceHistoryCard,
    async execute(args) {
      const symbol = normalizeSymbol(args.symbol);
      const range = normalizePriceRange(args.range);
      const rows = await fetchHistoricalPrices(symbol, credential());
      const allPointsWithRaw = historicalPricePoints(rows);
      const pointsWithRaw = allPointsWithRaw.slice(-PRICE_RANGE_LIMITS[range]);
      if (!pointsWithRaw.length) throw new Error(`FMP returned no historical price data for ${symbol}.`);

      const points = pointsWithRaw.map(({ date, close, volume }) => ({ date, close, volume }));
      const closes = points.map((point) => point.close);
      const firstPoint = points[0];
      const latestPoint = points[points.length - 1];
      const latestRaw = pointsWithRaw[pointsWithRaw.length - 1].raw;
      const absoluteChange = points.length > 1
        ? latestPoint.close - firstPoint.close
        : (numeric(latestRaw.change) ?? 0);
      const rangeChange = points.length > 1 && firstPoint.close !== 0
        ? (absoluteChange / firstPoint.close) * 100
        : numeric(latestRaw.changePercent);
      const high = Math.max(...closes);
      const low = Math.min(...closes);
      const allCloses = allPointsWithRaw.map((point) => point.close);
      const recent20 = allCloses.slice(-Math.min(allCloses.length, 20));
      const recent50 = allCloses.slice(-Math.min(allCloses.length, 50));
      const volumes = points.map((point) => point.volume).filter((value): value is number => value !== null);
      const averageVolumeRaw = volumes.length ? average(volumes) : null;
      const recentSessions = points.slice(-10).reverse().map((point) => ({
        date: point.date,
        close: decimalNumber(point.close),
        volume: compactNumber(point.volume)
      }));
      const data = {
        symbol,
        range,
        count: points.length,
        startDate: firstPoint.date,
        latestDate: latestPoint.date,
        startClose: decimalNumber(firstPoint.close),
        latestClose: decimalNumber(latestPoint.close),
        absoluteChange: decimalNumber(absoluteChange),
        rangeChangePct: rangeChange === null ? '—' : percentPoints(rangeChange),
        rangeHigh: decimalNumber(high),
        rangeLow: decimalNumber(low),
        ma20: decimalNumber(average(recent20)),
        ma50: decimalNumber(average(recent50)),
        averageVolume: compactNumber(averageVolumeRaw),
        annotations: {
          high: Number(high.toFixed(2)),
          low: Number(low.toFixed(2)),
          latestDate: latestPoint.date,
          latestClose: latestPoint.close
        },
        overlays: {
          ma20: Number(average(recent20).toFixed(2)),
          ma50: Number(average(recent50).toFixed(2))
        },
        points,
        recentSessions
      };

      return {
        text:
          `${symbol} ${range} price history (${data.startDate} to ${data.latestDate}; ${data.count} sessions): ` +
          `close ${data.startClose} to ${data.latestClose} (${data.rangeChangePct}); ` +
          `high close ${data.rangeHigh}, low close ${data.rangeLow}; MA20 ${data.ma20}, MA50 ${data.ma50}; ` +
          `average volume ${data.averageVolume}. Chart-ready rows are in data.points (date, close, volume).`,
        data,
        references: [
          sourceReference(
            `fmp-${symbol}-price-history-${range.toLowerCase()}`,
            `${symbol} FMP ${range} price history`,
            'historical-price-eod/full',
            { symbol },
            `${symbol} closed at ${data.latestClose} on ${data.latestDate}; ${range} change ${data.rangeChangePct}.`,
            {
              first: pointsWithRaw[0].raw,
              latest: latestRaw,
              annotations: data.annotations,
              overlays: data.overlays,
              points
            }
          )
        ]
      };
    }
  },

  fmp_company_financials: {
    description:
      'Get aligned historical FMP income statement, balance sheet, and cash-flow fundamentals for one ticker. Returns revenue, operating income, net income, diluted EPS, operating cash flow, capex/free cash flow, cash, debt, and current ratio. period defaults to annual; quarter returns sequential reported quarters. For a request such as “back to 2011,” set start_year=2011; optional end_year is inclusive. When no year range is given, limit defaults to the 5 most recent periods and supports up to 40. Use this for growth, margins, cash generation, debt, liquidity, and trend questions; use fmp_valuation_history for historical market cap and valuation multiples.',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Exact exchange ticker such as AAPL.' },
        period: { type: 'string', enum: ['annual', 'quarter'], default: 'annual', description: 'Statement cadence: annual (default) or quarter.' },
        limit: { type: 'integer', minimum: 1, maximum: 40, default: 5, description: 'Most recent aligned periods to return when no year range is supplied, from 1 through 40.' },
        start_year: { type: 'integer', minimum: 1900, maximum: 2100, description: 'Optional first fiscal year to return, inclusive; for “back to 2011,” use 2011.' },
        end_year: { type: 'integer', minimum: 1900, maximum: 2100, description: 'Optional last fiscal year to return, inclusive. Defaults through the latest available year.' }
      },
      required: ['symbol'],
      additionalProperties: false
    },
    card: financialsCard,
    async execute(args) {
      const symbol = normalizeSymbol(args.symbol);
      const period = normalizePeriod(args.period);
      const limit = boundedInteger(args.limit, 5, 1, 40, 'limit');
      const yearRange = normalizeYearRange(args.start_year, args.end_year);
      const requestLimit = historicalRequestLimit(period, yearRange, limit);
      const apiKey = credential();
      const [income, balanceSheet, cashFlow] = await Promise.all([
        fetchIncomeStatement({ symbol, period, limit: requestLimit, apiKey }),
        fetchBalanceSheet({ symbol, period, limit: requestLimit, apiKey }),
        fetchCashFlowStatement({ symbol, period, limit: requestLimit, apiKey })
      ]);
      const merged = mergeStatements(income, balanceSheet, cashFlow);
      const selected = selectHistoricalRecords(
        merged.map((row) => {
          const record = row.income ?? row.balance ?? row.cashFlow ?? {};
          return { ...row, fiscalYear: record.fiscalYear, date: record.date };
        }),
        yearRange,
        limit
      );
      if (!selected.length) {
        const rangeText = yearRange.startYear !== null || yearRange.endYear !== null
          ? ` in the requested ${yearRange.startYear ?? 'earliest'}–${yearRange.endYear ?? 'latest'} fiscal-year range`
          : '';
        throw new Error(`FMP returned no ${period} statements for ${symbol}${rangeText}.`);
      }
      const rawPeriods = selected.map(({ income: incomeRow = {}, balance: balanceRow = {}, cashFlow: cashRow = {} }) => {
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
          sourceReference(`fmp-${symbol}-income-${period}`, `${symbol} FMP income statements`, 'income-statement', { symbol, period, limit: requestLimit }, `${income.length} ${period} income statements returned; ${periods.length} selected.`, income),
          sourceReference(`fmp-${symbol}-balance-${period}`, `${symbol} FMP balance sheets`, 'balance-sheet-statement', { symbol, period, limit: requestLimit }, `${balanceSheet.length} ${period} balance sheets returned; ${periods.length} selected.`, balanceSheet),
          sourceReference(`fmp-${symbol}-cash-flow-${period}`, `${symbol} FMP cash flow statements`, 'cash-flow-statement', { symbol, period, limit: requestLimit }, `${cashFlow.length} ${period} cash-flow statements returned; ${periods.length} selected.`, cashFlow)
        ]
      };
    }
  },

  fmp_valuation_history: {
    description:
      'Get historical FMP valuation and capital-efficiency metrics for one ticker from the key-metrics, ratios, and enterprise-values series. Returns fiscal-period market cap, enterprise value, P/E, P/S, P/B, P/FCF, EV/EBITDA, free-cash-flow yield, ROE, and ROIC. period defaults to annual. For a request such as “from 2011” or “back to 2011,” set start_year=2011; optional end_year is inclusive. When no year range is given, limit defaults to 10 recent periods and supports up to 40. Use fmp_company_overview only for current TTM valuation.',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Exact exchange ticker such as AAPL.' },
        period: { type: 'string', enum: ['annual', 'quarter'], default: 'annual', description: 'Historical metric cadence: annual (default) or quarter.' },
        limit: { type: 'integer', minimum: 1, maximum: 40, default: 10, description: 'Most recent periods to return when no year range is supplied, from 1 through 40.' },
        start_year: { type: 'integer', minimum: 1900, maximum: 2100, description: 'Optional first fiscal year to return, inclusive; for “back to 2011,” use 2011.' },
        end_year: { type: 'integer', minimum: 1900, maximum: 2100, description: 'Optional last fiscal year to return, inclusive. Defaults through the latest available year.' }
      },
      required: ['symbol'],
      additionalProperties: false
    },
    card: valuationHistoryCard,
    async execute(args) {
      const symbol = normalizeSymbol(args.symbol);
      const period = normalizePeriod(args.period);
      const limit = boundedInteger(args.limit, 10, 1, 40, 'limit');
      const yearRange = normalizeYearRange(args.start_year, args.end_year);
      const requestLimit = historicalRequestLimit(period, yearRange, limit);
      const apiKey = credential();
      const [profiles, keyMetricRows, ratioRows, enterpriseValueRows] = await Promise.all([
        fetchProfile(symbol, apiKey),
        fetchKeyMetrics({ symbol, period, limit: requestLimit, apiKey }),
        fetchRatios({ symbol, period, limit: requestLimit, apiKey }),
        fetchEnterpriseValues({ symbol, period, limit: requestLimit, apiKey })
      ]);
      const profile = first(profiles);
      const currency = String(profile?.currency ?? 'USD');
      const merged = mergeHistoricalMetrics(keyMetricRows, ratioRows, enterpriseValueRows);
      const selected = selectHistoricalRecords(
        merged.map((row) => {
          const record = row.keyMetrics ?? row.ratios ?? row.enterpriseValues ?? {};
          return { ...row, fiscalYear: record.fiscalYear, date: record.date };
        }),
        yearRange,
        limit
      );
      if (!selected.length) {
        const rangeText = yearRange.startYear !== null || yearRange.endYear !== null
          ? ` in the requested ${yearRange.startYear ?? 'earliest'}–${yearRange.endYear ?? 'latest'} fiscal-year range`
          : '';
        throw new Error(`FMP returned no ${period} valuation history for ${symbol}${rangeText}.`);
      }
      const rawPeriods = selected.map(({ keyMetrics = {}, ratios = {}, enterpriseValues = {} }) => ({
        date: String(keyMetrics.date ?? ratios.date ?? enterpriseValues.date ?? ''),
        fiscalYear: String(keyMetrics.fiscalYear ?? ratios.fiscalYear ?? enterpriseValues.fiscalYear ?? ''),
        period: String(keyMetrics.period ?? ratios.period ?? enterpriseValues.period ?? ''),
        marketCap: readNumber(enterpriseValues, 'marketCapitalization', 'marketCap') ?? readNumber(keyMetrics, 'marketCap'),
        enterpriseValue: readNumber(enterpriseValues, 'enterpriseValue') ?? readNumber(keyMetrics, 'enterpriseValue'),
        priceToEarnings: readNumber(ratios, 'priceToEarningsRatio') ?? readNumber(keyMetrics, 'peRatio'),
        priceToSales: readNumber(ratios, 'priceToSalesRatio') ?? readNumber(keyMetrics, 'priceToSalesRatio'),
        priceToBook: readNumber(ratios, 'priceToBookRatio') ?? readNumber(keyMetrics, 'pbRatio'),
        priceToFcf: readNumber(ratios, 'priceToFreeCashFlowRatio') ?? readNumber(keyMetrics, 'pfcfRatio'),
        evToEbitda: readNumber(keyMetrics, 'evToEBITDA') ?? readNumber(ratios, 'enterpriseValueMultiple'),
        fcfYield: readNumber(keyMetrics, 'freeCashFlowYield'),
        roe: readNumber(keyMetrics, 'returnOnEquity') ?? readNumber(ratios, 'returnOnEquity'),
        roic: readNumber(keyMetrics, 'returnOnInvestedCapital'),
        raw: { keyMetrics, ratios, enterpriseValues }
      }));
      const periods = rawPeriods.map((row) => ({
        label: `${row.fiscalYear || row.date} ${row.period}`.trim(),
        marketCap: money(row.marketCap, currency, true),
        enterpriseValue: money(row.enterpriseValue, currency, true),
        priceToEarnings: decimalNumber(row.priceToEarnings),
        priceToSales: decimalNumber(row.priceToSales),
        priceToBook: decimalNumber(row.priceToBook),
        priceToFcf: decimalNumber(row.priceToFcf),
        evToEbitda: decimalNumber(row.evToEbitda),
        fcfYield: percentRatio(row.fcfYield),
        roe: percentRatio(row.roe),
        roic: percentRatio(row.roic)
      }));
      const latest = periods[0];
      const data = {
        symbol,
        period,
        periodLabel: period === 'annual' ? 'annual' : 'quarterly',
        count: periods.length,
        latestMarketCap: latest.marketCap,
        latestPe: latest.priceToEarnings,
        latestEvToEbitda: latest.evToEbitda,
        currency,
        periods,
        rawPeriods,
        raw: { profile, keyMetrics: keyMetricRows, ratios: ratioRows, enterpriseValues: enterpriseValueRows }
      };
      return {
        text: `${symbol} ${data.periodLabel} valuation history (${periods.length} periods):\n${periods
          .map((row) => `${row.label}: market cap ${row.marketCap}; P/E ${row.priceToEarnings}; P/S ${row.priceToSales}; P/B ${row.priceToBook}; P/FCF ${row.priceToFcf}; EV/EBITDA ${row.evToEbitda}; ROIC ${row.roic}.`)
          .join('\n')}`,
        data,
        references: [
          sourceReference(`fmp-${symbol}-profile-history`, `${symbol} FMP profile currency`, 'profile', { symbol }, `${symbol} historical valuation display currency ${currency}.`, profile),
          sourceReference(`fmp-${symbol}-key-metrics-${period}`, `${symbol} FMP historical key metrics`, 'key-metrics', { symbol, period, limit: requestLimit }, `${keyMetricRows.length} ${period} key-metric rows returned; ${periods.length} periods selected.`, keyMetricRows),
          sourceReference(`fmp-${symbol}-ratios-${period}`, `${symbol} FMP historical ratios`, 'ratios', { symbol, period, limit: requestLimit }, `${ratioRows.length} ${period} ratio rows returned; ${periods.length} periods selected.`, ratioRows),
          sourceReference(`fmp-${symbol}-enterprise-values-${period}`, `${symbol} FMP historical enterprise values`, 'enterprise-values', { symbol, period, limit: requestLimit }, `${enterpriseValueRows.length} ${period} enterprise-value rows returned; ${periods.length} periods selected.`, enterpriseValueRows)
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
      'Get historical FMP revenue mix by product/business and geography for one ticker. period defaults to annual; quarter requests quarterly segmentation where the company reports it. For a request such as “back to 2011,” set start_year=2011; optional end_year is inclusive. When no year range is given, period_limit defaults to the 2 most recent periods and supports up to 40. Within each period, segments are sorted largest first and include revenue plus share of that endpoint’s reported total. Use this for concentration, mix shift, regional exposure, and business-segment questions.',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Exact exchange ticker such as AAPL.' },
        period: { type: 'string', enum: ['annual', 'quarter'], default: 'annual', description: 'Segmentation cadence: annual (default) or quarter.' },
        period_limit: { type: 'integer', minimum: 1, maximum: 40, default: 2, description: 'Most recent reporting periods to retain when no year range is supplied, from 1 through 40.' },
        start_year: { type: 'integer', minimum: 1900, maximum: 2100, description: 'Optional first fiscal year to return, inclusive; for “back to 2011,” use 2011.' },
        end_year: { type: 'integer', minimum: 1900, maximum: 2100, description: 'Optional last fiscal year to return, inclusive. Defaults through the latest available year.' }
      },
      required: ['symbol'],
      additionalProperties: false
    },
    card: segmentsCard,
    async execute(args) {
      const symbol = normalizeSymbol(args.symbol);
      const period = normalizePeriod(args.period);
      const periodLimit = boundedInteger(args.period_limit, 2, 1, 40, 'period_limit');
      const yearRange = normalizeYearRange(args.start_year, args.end_year);
      const apiKey = credential();
      const [productRaw, geographicRaw] = await Promise.all([
        fetchProductSegments({ symbol, period, apiKey }),
        fetchGeographicSegments({ symbol, period, apiKey })
      ]);
      const selectedProduct = selectHistoricalRecords(productRaw, yearRange, periodLimit);
      const selectedGeographic = selectHistoricalRecords(geographicRaw, yearRange, periodLimit);
      const productSegments = segmentRows(selectedProduct);
      const geographicSegments = segmentRows(selectedGeographic);
      if (!productSegments.length && !geographicSegments.length) {
        const rangeText = yearRange.startYear !== null || yearRange.endYear !== null
          ? ` in the requested ${yearRange.startYear ?? 'earliest'}–${yearRange.endYear ?? 'latest'} fiscal-year range`
          : '';
        throw new Error(`FMP returned no ${period} revenue segmentation for ${symbol}${rangeText}.`);
      }
      const data = {
        symbol,
        period,
        periodLabel: period === 'annual' ? 'annual' : 'quarterly',
        periodCount: Math.max(selectedProduct.length, selectedGeographic.length),
        productCount: productSegments.length,
        geographicCount: geographicSegments.length,
        productSegments,
        geographicSegments,
        raw: { product: selectedProduct, geographic: selectedGeographic }
      };
      const productLines = segmentSummaryLines(productSegments);
      const geographicLines = segmentSummaryLines(geographicSegments);
      const parts: string[] = [];
      if (productLines.length) {
        parts.push(`${symbol} ${data.periodLabel} product/business mix (${selectedProduct.length} periods):\n${productLines.join('\n')}`);
      }
      if (geographicLines.length) {
        parts.push(`${symbol} ${data.periodLabel} geographic mix (${selectedGeographic.length} periods):\n${geographicLines.join('\n')}`);
      }
      return {
        text: parts.join('\n\n'),
        data,
        references: [
          sourceReference(`fmp-${symbol}-product-segments-${period}`, `${symbol} FMP product revenue segments`, 'revenue-product-segmentation', { symbol, period }, `${productRaw.length} ${period} product-segmentation periods returned; ${selectedProduct.length} selected.`, selectedProduct),
          sourceReference(`fmp-${symbol}-geographic-segments-${period}`, `${symbol} FMP geographic revenue segments`, 'revenue-geographic-segmentation', { symbol, period }, `${geographicRaw.length} ${period} geographic-segmentation periods returned; ${selectedGeographic.length} selected.`, selectedGeographic)
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
  },

  fmp_company_screener: {
    description:
      'Screen FMP’s equity universe for candidate tickers by sector, industry, exchange, country, and inclusive market-cap, price, dividend, beta, volume, and average-volume ranges, plus ETF, fund, and actively-trading flags. Every filter is optional and rows return in FMP’s own order rather than ranked by any single metric. limit defaults to 25 and caps at 100; the card holds every matched row while the model-visible text lists the first 20. Use this for discovery when no ticker is known yet, then call fmp_company_overview or fmp_company_financials on a selected symbol—matching a filter is not an investment recommendation.',
    parameters: {
      type: 'object',
      properties: {
        sector: { type: 'string', description: 'FMP sector name such as Technology, Healthcare, or Financial Services.' },
        industry: { type: 'string', description: 'FMP industry name such as Consumer Electronics or Biotechnology.' },
        exchange: { type: 'string', description: 'Exchange code such as NASDAQ, NYSE, or AMEX.' },
        country: { type: 'string', description: 'Two-letter country code such as US, GB, or JP.' },
        market_cap_more_than: { type: 'number', minimum: 0, description: 'Minimum market capitalization in USD, for example 10000000000 for $10B.' },
        market_cap_lower_than: { type: 'number', minimum: 0, description: 'Maximum market capitalization in USD.' },
        price_more_than: { type: 'number', minimum: 0, description: 'Minimum share price.' },
        price_lower_than: { type: 'number', minimum: 0, description: 'Maximum share price.' },
        beta_more_than: { type: 'number', description: 'Minimum beta.' },
        beta_lower_than: { type: 'number', description: 'Maximum beta.' },
        dividend_more_than: { type: 'number', minimum: 0, description: 'Minimum last annual dividend per share.' },
        dividend_lower_than: { type: 'number', minimum: 0, description: 'Maximum last annual dividend per share.' },
        volume_more_than: { type: 'number', minimum: 0, description: 'Minimum latest-session share volume.' },
        volume_lower_than: { type: 'number', minimum: 0, description: 'Maximum latest-session share volume.' },
        avg_volume_more_than: { type: 'number', minimum: 0, description: 'Minimum average share volume.' },
        avg_volume_lower_than: { type: 'number', minimum: 0, description: 'Maximum average share volume.' },
        is_etf: { type: 'boolean', description: 'Set false to exclude ETFs, true to return only ETFs.' },
        is_fund: { type: 'boolean', description: 'Set false to exclude mutual funds, true to return only funds.' },
        is_actively_trading: { type: 'boolean', description: 'Set true to restrict results to actively trading securities.' },
        include_all_share_classes: { type: 'boolean', description: 'Set true to keep every share class instead of one row per company.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 25, description: 'Maximum rows to return, from 1 through 100.' }
      },
      additionalProperties: false
    },
    card: screenerCard,
    async execute(args) {
      // Every filter is optional, so a no-argument call is a legitimate "screen
      // the whole universe" request and must not dereference undefined.
      const input = args ?? {};
      const limit = boundedInteger(input.limit, 25, 1, 100, 'limit');
      const filters = screenerFilters(input);
      const query = { ...filters, limit };
      const raw = await fetchCompanyScreener(query, credential());
      const rows = raw.slice(0, limit).map((row) => ({
        symbol: String(row.symbol ?? ''),
        companyName: String(row.companyName ?? '—'),
        sector: String(row.sector ?? '—'),
        industry: String(row.industry ?? '—'),
        exchange: String(row.exchangeShortName ?? row.exchange ?? '—'),
        country: String(row.country ?? '—'),
        price: money(row.price),
        marketCap: money(row.marketCap, 'USD', true),
        beta: decimalNumber(row.beta),
        volume: compactNumber(row.volume, 1),
        dividend: money(row.lastAnnualDividend),
        rawPrice: numeric(row.price),
        rawMarketCap: numeric(row.marketCap),
        rawBeta: numeric(row.beta),
        rawVolume: numeric(row.volume)
      }));
      if (!rows.length) {
        throw new Error('FMP returned no companies matching those screener filters. Widen or drop a filter and call again.');
      }
      const filterSummary = Object.entries(filters).map(([key, value]) => `${key}=${value}`).join(', ') || 'none';
      // The card renders every row; the summary stays short so a 100-row screen
      // does not crowd out the rest of the turn.
      const shown = rows.slice(0, 20);
      const overflow = rows.length - shown.length;
      const overflowNote = overflow > 0
        ? `\n… ${overflow} further matched row(s) appear in the card below. Narrow the filters to bring them into this summary, or call fmp_company_overview on a specific symbol.`
        : '';
      const slug = Object.entries(query)
        .map(([key, value]) => `${key}-${value}`)
        .join('_')
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '')
        .slice(0, 80);
      return {
        text: `FMP company screener matched ${rows.length} ${rows.length === 1 ? 'company' : 'companies'} (limit ${limit}; filters: ${filterSummary}):\n${shown
          .map((row, index) => `${index + 1}. ${row.symbol} — ${row.companyName}; ${row.sector}; price ${row.price}; market cap ${row.marketCap}; beta ${row.beta}.`)
          .join('\n')}${overflowNote}`,
        data: { count: rows.length, filterSummary, filters, limit, rows },
        references: [
          sourceReference(
            `fmp-screener-${slug || 'all'}`,
            'FMP company screener',
            'company-screener',
            query,
            `${raw.length} screener rows returned; ${rows.length} shown.`,
            rows
          )
        ]
      };
    }
  }
});
