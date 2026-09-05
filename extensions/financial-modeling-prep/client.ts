import { apiGet, type QueryValue } from '@raynard/plugin-sdk';

export const FMP_BASE_URL = 'https://financialmodelingprep.com/stable';

export type FmpRecord = Record<string, unknown>;

export type MarketActivity = {
  symbol?: string;
  name?: string;
  price?: number;
  change?: number;
  changesPercentage?: number;
  exchange?: string;
};

export type CompanyProfile = FmpRecord & {
  symbol?: string;
  companyName?: string;
  price?: number;
  marketCap?: number;
  beta?: number;
  currency?: string;
  exchange?: string;
  exchangeFullName?: string;
  sector?: string;
  industry?: string;
  country?: string;
  website?: string;
  description?: string;
  fullTimeEmployees?: number;
  isEtf?: boolean;
  isFund?: boolean;
};

export type Quote = FmpRecord & {
  symbol?: string;
  name?: string;
  price?: number;
  change?: number;
  changePercentage?: number;
  volume?: number;
  dayLow?: number;
  dayHigh?: number;
  yearLow?: number;
  yearHigh?: number;
  marketCap?: number;
  priceAvg50?: number;
  priceAvg200?: number;
  timestamp?: number;
};

export type HistoricalPriceEod = FmpRecord & {
  symbol?: string;
  date?: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  adjClose?: number;
  volume?: number;
  change?: number;
  changePercent?: number;
  vwap?: number;
};

export type StatementRow = FmpRecord & {
  symbol?: string;
  date?: string;
  fiscalYear?: string | number;
  period?: string;
  reportedCurrency?: string;
  revenue?: number;
  grossProfit?: number;
  operatingIncome?: number;
  netIncome?: number;
  eps?: number;
  epsDiluted?: number;
  netCashProvidedByOperatingActivities?: number;
  operatingCashFlow?: number;
  capitalExpenditure?: number;
  investmentsInPropertyPlantAndEquipment?: number;
  freeCashFlow?: number;
  cashAndCashEquivalents?: number;
  cashAndShortTermInvestments?: number;
  totalCurrentAssets?: number;
  totalCurrentLiabilities?: number;
  totalDebt?: number;
  shortTermDebt?: number;
  longTermDebt?: number;
  netDebt?: number;
};

export type AnalystEstimate = FmpRecord & {
  symbol?: string;
  date?: string;
  revenueLow?: number;
  revenueHigh?: number;
  revenueAvg?: number;
  ebitdaLow?: number;
  ebitdaHigh?: number;
  ebitdaAvg?: number;
  netIncomeLow?: number;
  netIncomeHigh?: number;
  netIncomeAvg?: number;
  epsLow?: number;
  epsHigh?: number;
  epsAvg?: number;
  numAnalystsRevenue?: number;
  numAnalystsEps?: number;
};

export type RatingSnapshot = FmpRecord & {
  symbol?: string;
  rating?: string;
  overallScore?: number;
  discountedCashFlowScore?: number;
  returnOnEquityScore?: number;
  returnOnAssetsScore?: number;
  debtToEquityScore?: number;
  priceToEarningsScore?: number;
  priceToBookScore?: number;
};

export type PriceTargetConsensus = FmpRecord & {
  symbol?: string;
  targetHigh?: number;
  targetLow?: number;
  targetConsensus?: number;
  targetMedian?: number;
};

export type PriceTargetSummary = FmpRecord & {
  symbol?: string;
  lastMonthCount?: number;
  lastMonthAvgPriceTarget?: number;
  lastQuarterCount?: number;
  lastQuarterAvgPriceTarget?: number;
  lastYearCount?: number;
  lastYearAvgPriceTarget?: number;
  allTimeCount?: number;
  allTimeAvgPriceTarget?: number;
};

export type AnalystGrade = FmpRecord & {
  symbol?: string;
  date?: string;
  gradingCompany?: string;
  previousGrade?: string;
  newGrade?: string;
  action?: string;
};

export type SegmentRecord = FmpRecord & {
  symbol?: string;
  fiscalYear?: string | number;
  period?: string;
  reportedCurrency?: string;
  date?: string;
  data?: Record<string, number>;
};

export type PeerRecord = FmpRecord & {
  symbol?: string;
  companyName?: string;
  price?: number;
  mktCap?: number;
};

export type ScreenerRecord = FmpRecord & {
  symbol?: string;
  companyName?: string;
  marketCap?: number;
  sector?: string;
  industry?: string;
  beta?: number;
  price?: number;
  lastAnnualDividend?: number;
  volume?: number;
  exchange?: string;
  exchangeShortName?: string;
  country?: string;
  isEtf?: boolean;
  isFund?: boolean;
  isActivelyTrading?: boolean;
};

export type HistoricalMetricRecord = FmpRecord & {
  symbol?: string;
  date?: string;
  fiscalYear?: string | number;
  period?: string;
};

const endpoint = (path: string) => `${FMP_BASE_URL}/${path}`;
const authQuery = (apiKey: string, query: Record<string, QueryValue> = {}) => ({
  ...query,
  apikey: apiKey
});

export function fmpSourceUrl(path: string, query: Record<string, QueryValue> = {}): string {
  const url = new URL(endpoint(path));
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export const fetchMostActives = (apiKey: string) =>
  apiGet<MarketActivity[]>(endpoint('most-actives'), {
    query: authQuery(apiKey),
    label: 'FMP most active stocks'
  });

export const fetchProfile = (symbol: string, apiKey: string) =>
  apiGet<CompanyProfile[]>(endpoint('profile'), {
    query: authQuery(apiKey, { symbol }),
    label: 'FMP company profile'
  });

export const fetchQuote = (symbol: string, apiKey: string) =>
  apiGet<Quote[]>(endpoint('quote'), {
    query: authQuery(apiKey, { symbol }),
    label: 'FMP stock quote'
  });

export const fetchHistoricalPrices = (symbol: string, apiKey: string) =>
  apiGet<HistoricalPriceEod[]>(endpoint('historical-price-eod/full'), {
    query: authQuery(apiKey, { symbol }),
    label: 'FMP historical end-of-day prices'
  });

export const fetchKeyMetricsTtm = (symbol: string, apiKey: string) =>
  apiGet<FmpRecord[]>(endpoint('key-metrics-ttm'), {
    query: authQuery(apiKey, { symbol }),
    label: 'FMP TTM key metrics'
  });

export const fetchRatiosTtm = (symbol: string, apiKey: string) =>
  apiGet<FmpRecord[]>(endpoint('ratios-ttm'), {
    query: authQuery(apiKey, { symbol }),
    label: 'FMP TTM financial ratios'
  });

type HistoricalMetricArgs = {
  symbol: string;
  period: 'annual' | 'quarter';
  limit: number;
  apiKey: string;
};

export const fetchKeyMetrics = ({ symbol, period, limit, apiKey }: HistoricalMetricArgs) =>
  apiGet<HistoricalMetricRecord[]>(endpoint('key-metrics'), {
    query: authQuery(apiKey, { symbol, period, limit }),
    label: 'FMP historical key metrics'
  });

export const fetchRatios = ({ symbol, period, limit, apiKey }: HistoricalMetricArgs) =>
  apiGet<HistoricalMetricRecord[]>(endpoint('ratios'), {
    query: authQuery(apiKey, { symbol, period, limit }),
    label: 'FMP historical financial ratios'
  });

export const fetchEnterpriseValues = ({ symbol, period, limit, apiKey }: HistoricalMetricArgs) =>
  apiGet<HistoricalMetricRecord[]>(endpoint('enterprise-values'), {
    query: authQuery(apiKey, { symbol, period, limit }),
    label: 'FMP historical enterprise values'
  });

export const fetchFinancialScores = (symbol: string, apiKey: string) =>
  apiGet<FmpRecord[]>(endpoint('financial-scores'), {
    query: authQuery(apiKey, { symbol }),
    label: 'FMP financial health scores'
  });

type StatementArgs = { symbol: string; period: 'annual' | 'quarter'; limit: number; apiKey: string };

export const fetchIncomeStatement = ({ symbol, period, limit, apiKey }: StatementArgs) =>
  apiGet<StatementRow[]>(endpoint('income-statement'), {
    query: authQuery(apiKey, { symbol, period, limit }),
    label: 'FMP income statement'
  });

export const fetchBalanceSheet = ({ symbol, period, limit, apiKey }: StatementArgs) =>
  apiGet<StatementRow[]>(endpoint('balance-sheet-statement'), {
    query: authQuery(apiKey, { symbol, period, limit }),
    label: 'FMP balance sheet statement'
  });

export const fetchCashFlowStatement = ({ symbol, period, limit, apiKey }: StatementArgs) =>
  apiGet<StatementRow[]>(endpoint('cash-flow-statement'), {
    query: authQuery(apiKey, { symbol, period, limit }),
    label: 'FMP cash flow statement'
  });

export const fetchAnalystEstimates = (
  symbol: string,
  period: 'annual' | 'quarter',
  apiKey: string
) =>
  apiGet<AnalystEstimate[]>(endpoint('analyst-estimates'), {
    query: authQuery(apiKey, { symbol, period, page: 0, limit: 10 }),
    label: 'FMP analyst financial estimates'
  });

export const fetchRatingsSnapshot = (symbol: string, apiKey: string) =>
  apiGet<RatingSnapshot[]>(endpoint('ratings-snapshot'), {
    query: authQuery(apiKey, { symbol }),
    label: 'FMP ratings snapshot'
  });

export const fetchPriceTargetConsensus = (symbol: string, apiKey: string) =>
  apiGet<PriceTargetConsensus[]>(endpoint('price-target-consensus'), {
    query: authQuery(apiKey, { symbol }),
    label: 'FMP price target consensus'
  });

export const fetchPriceTargetSummary = (symbol: string, apiKey: string) =>
  apiGet<PriceTargetSummary[]>(endpoint('price-target-summary'), {
    query: authQuery(apiKey, { symbol }),
    label: 'FMP price target summary'
  });

export const fetchAnalystGrades = (symbol: string, apiKey: string) =>
  apiGet<AnalystGrade[]>(endpoint('grades'), {
    query: authQuery(apiKey, { symbol }),
    label: 'FMP analyst grades'
  });

type SegmentArgs = { symbol: string; period: 'annual' | 'quarter'; apiKey: string };

export const fetchProductSegments = ({ symbol, period, apiKey }: SegmentArgs) =>
  apiGet<SegmentRecord[]>(endpoint('revenue-product-segmentation'), {
    query: authQuery(apiKey, { symbol, period }),
    label: 'FMP product revenue segmentation'
  });

export const fetchGeographicSegments = ({ symbol, period, apiKey }: SegmentArgs) =>
  apiGet<SegmentRecord[]>(endpoint('revenue-geographic-segmentation'), {
    query: authQuery(apiKey, { symbol, period }),
    label: 'FMP geographic revenue segmentation'
  });

export const fetchStockPeers = (symbol: string, apiKey: string) =>
  apiGet<PeerRecord[]>(endpoint('stock-peers'), {
    query: authQuery(apiKey, { symbol }),
    label: 'FMP stock peers'
  });

// The screener takes a wide, sparse filter set, so the caller passes an already
// validated query rather than a fixed positional signature; empty values are
// dropped by buildQuery and never reach FMP.
export const fetchCompanyScreener = (query: Record<string, QueryValue>, apiKey: string) =>
  apiGet<ScreenerRecord[]>(endpoint('company-screener'), {
    query: authQuery(apiKey, query),
    label: 'FMP company screener'
  });
