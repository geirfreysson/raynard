# Financial Modeling Prep

App-local Raynard extension for compact equity research with Financial Modeling Prep's current `/stable` API. The tool design follows the useful analyst workflow in Northfox: screen for candidates when no ticker is known yet, start with current valuation and quality, use explicit fiscal-year ranges for historical valuation, statements, and revenue mix, inspect forward estimates and price targets, then use peers only when the question needs them.

The extension deliberately avoids a single large company snapshot. Each focused tool fetches only the endpoint group needed for its question, returns bounded model-visible text, preserves structured data for cards, and includes citeable FMP endpoint references.

## Authentication

This extension requires `FMP_API_KEY`.

- Label: Financial Modeling Prep API key
- Obtain or copy the key from: https://site.financialmodelingprep.com/developer/docs/dashboard
- Endpoint availability, geographic coverage, historical depth, delay, and call limits depend on the user's FMP plan.
- Raynard stores the credential in the OS keychain and supplies it only while a tool executes. The extension does not read `.env` or persist the key.

## Implemented Tools

- `fmp_market_activity` — zero-argument health check and current most-active U.S. stocks; shows 15 of FMP's current 50-row response.
- `fmp_company_overview` — profile, quote, TTM valuation/profitability/liquidity ratios, returns on capital, and financial health scores.
- `fmp_key_metrics_ttm` — single-request current TTM metrics fallback for when `fmp_company_overview` is unavailable on the configured plan; no price or trailing P/E.
- `fmp_price_history` — end-of-day closes and volume over 1D/5D/1M/3M/6M/1Y, with range change, high/low closes, 20/50-session moving averages, and chart-ready `data.points`.
- `fmp_company_financials` — aligned annual or quarterly income statement, balance-sheet, and cash-flow trends; supports inclusive `start_year`/`end_year` ranges such as 2011 through latest, or 1–40 recent periods.
- `fmp_valuation_history` — annual or quarterly fiscal-period market cap, enterprise value, valuation multiples, FCF yield, ROE, and ROIC; supports inclusive `start_year`/`end_year` ranges or 1–40 recent periods.
- `fmp_analyst_outlook` — annual or quarterly analyst revenue/EPS estimates, current-price implied forward P/E, FMP rating, consensus price target/upside, target trend, and optional recent firm grade actions.
- `fmp_company_segments` — annual or quarterly product/business and geographic revenue mix; supports inclusive `start_year`/`end_year` ranges such as 2011 through latest, or 1–40 recent periods.
- `fmp_stock_peers` — FMP peer discovery with symbol, company, current price, and market cap, bounded to 1–15 peers.
- `fmp_company_screener` — candidate discovery across the whole equity universe by sector, industry, exchange, country, and inclusive market-cap, price, dividend, beta, and volume ranges plus ETF/fund/actively-trading flags; every filter is optional and results are bounded to 1–100 rows.

## Endpoint Inventory

| Endpoint | Status | Parameters and observed response shape | Tool or future tool |
| --- | --- | --- | --- |
| `GET /stable/most-actives` | Implemented | No business parameters. Live response observed as 50 ordered rows with `symbol`, `name`, `price`, `change`, `changesPercentage`, and `exchange`; card/text retain 15. | `fmp_market_activity` |
| `GET /stable/profile` | Implemented | Required `symbol`. One-row company profile with price, market cap, exchange, sector, industry, country, website, description, currency, and security flags. | `fmp_company_overview` |
| `GET /stable/quote` | Implemented | Required `symbol`. One-row current quote with price, session change, volume, daily/year ranges, market cap, moving averages, and timestamp. | `fmp_company_overview`; `fmp_analyst_outlook` uses price for implied forward P/E and target upside. |
| `GET /stable/key-metrics-ttm` | Implemented | Required `symbol`. One-row TTM metrics including enterprise-value multiples, ROE, ROIC, FCF yield, liquidity, capital efficiency, and working-capital measures. | `fmp_company_overview`; `fmp_key_metrics_ttm` calls it alone as a single-request fallback. |
| `GET /stable/historical-price-eod/full` | Implemented | Required `symbol`. Reverse-chronological daily rows with open, high, low, close, adjusted close, volume, change, change percent, and VWAP. The tool sorts ascending, keeps the latest 1/5/22/66/132/252 sessions for the requested range, and computes moving averages from the full downloaded history. | `fmp_price_history` |
| `GET /stable/ratios-ttm` | Implemented | Required `symbol`. One-row TTM profitability, liquidity, leverage, efficiency, valuation, yield, and per-share ratios. | `fmp_company_overview` |
| `GET /stable/financial-scores` | Implemented | Required `symbol`. One-row Altman Z and Piotroski scores plus supporting balance-sheet/income fields. | `fmp_company_overview` |
| `GET /stable/income-statement` | Implemented | Required `symbol`; `period=annual|quarter`; computed `limit`. The tool fetches enough recent rows to reach an optional inclusive fiscal-year range, then filters locally; without a range it retains 1–40 recent periods. Rows contain revenue, gross/operating/net income, EPS, and filing metadata. | `fmp_company_financials` |
| `GET /stable/balance-sheet-statement` | Implemented | Required `symbol`; `period=annual|quarter`; computed `limit` and the same local fiscal-year filtering as income statements. Rows contain cash, assets, liabilities, equity, short/long-term debt, total debt, and net debt. | `fmp_company_financials` |
| `GET /stable/cash-flow-statement` | Implemented | Required `symbol`; `period=annual|quarter`; computed `limit` and the same local fiscal-year filtering as income statements. Rows contain operating cash flow, capex, free cash flow, financing/investing activity, dividends, and repurchases. | `fmp_company_financials` |
| `GET /stable/key-metrics` | Implemented | Required `symbol`; `period=annual|quarter`; computed `limit`. Historical rows include market cap, enterprise value, EV multiples, returns on capital, earnings/FCF yields, liquidity, and operating-cycle metrics. | `fmp_valuation_history` |
| `GET /stable/ratios` | Implemented | Required `symbol`; `period=annual|quarter`; computed `limit`. Historical rows include P/E, P/S, P/B, P/FCF, margins, liquidity, leverage, coverage, turnover, per-share values, and dividend metrics. | `fmp_valuation_history` |
| `GET /stable/enterprise-values` | Implemented | Required `symbol`; `period=annual|quarter`; computed `limit`. Rows include fiscal-period stock price, shares, market capitalization, cash, debt, and enterprise value; merged by report date with key metrics and ratios. | `fmp_valuation_history` |
| `GET /stable/analyst-estimates` | Implemented | Required `symbol`; `period=annual|quarter`; `page=0`; extension requests `limit=10`, removes historical dates when upcoming rows exist, sorts upcoming dates nearest-first, and shows 1–8. Rows contain low/high/average revenue, EBITDA, net income, EPS, and analyst counts. | `fmp_analyst_outlook` |
| `GET /stable/ratings-snapshot` | Implemented | Required `symbol`. One row with letter rating, overall score, and DCF/ROE/ROA/debt-to-equity/P-E/P-B component scores. | `fmp_analyst_outlook` |
| `GET /stable/price-target-consensus` | Implemented | Required `symbol`. One row with high, low, consensus, and median price targets. | `fmp_analyst_outlook` |
| `GET /stable/price-target-summary` | Implemented | Required `symbol`. One row with target counts and averages over month, quarter, year, and all-time windows. | `fmp_analyst_outlook` |
| `GET /stable/grades` | Implemented, opt-in | Required `symbol`. Large reverse-chronological history with date, grading company, previous/new grade, and action. FMP returned 1,791 AAPL rows during the latest live probe; the tool downloads this only with `include_recent_grades=true` and retains at most 25. | `fmp_analyst_outlook` |
| `GET /stable/revenue-product-segmentation` | Implemented | Required `symbol`; `period=annual|quarter`. The endpoint returns its available series; the tool applies an inclusive `start_year`/`end_year` range locally or retains 1–40 recent periods. Rows contain fiscal year, period, date, currency, and a dynamic segment-to-revenue object. | `fmp_company_segments` |
| `GET /stable/revenue-geographic-segmentation` | Implemented | Required `symbol`; `period=annual|quarter`. Same envelope and local year selection as product segmentation, with region-to-revenue data. | `fmp_company_segments` |
| `GET /stable/stock-peers` | Implemented | Required `symbol`. FMP-selected peer rows with symbol, company name, price, and market cap; extension retains 1–15. | `fmp_stock_peers` |
| `GET /stable/company-screener` | Implemented | All parameters optional: `sector`, `industry`, `exchange`, `country`, `marketCapMoreThan`/`LowerThan`, `priceMoreThan`/`LowerThan`, `betaMoreThan`/`LowerThan`, `dividendMoreThan`/`LowerThan`, `volumeMoreThan`/`LowerThan`, `avgVolumeMoreThan`/`LowerThan`, `isEtf`, `isFund`, `isActivelyTrading`, `includeAllShareClasses`, and `limit`. The tool exposes these in snake_case, rejects inverted ranges before calling, and passes `limit` through so FMP returns only the retained rows rather than its 1000-row default. Rows contain symbol, company name, sector, industry, exchange, country, price, market cap, beta, volume, and last annual dividend. | `fmp_company_screener` |
| `GET /stable/historical-market-capitalization` | Live-probed, not called by a tool | Required `symbol`; `from`/`to` accept bounded dates. A 2011-01-01 through 2012-12-31 AAPL probe returned 502 daily rows. The tool uses the annual/quarterly market-cap values in `enterprise-values` instead, avoiding thousands of daily rows for fiscal-period questions. | Use `fmp_valuation_history` for annual/quarterly market cap. A future daily-price/cap tool should expose an explicit bounded date range. |
| `GET /stable/discounted-cash-flow` and advanced/custom DCF variants | Planned | Required symbol; advanced/custom variants add valuation assumptions. Responses contain FMP fair value and projection inputs/tables. | Future `fmp_dcf_valuation`, with assumptions explicit and bounded output. |
| Earnings transcript endpoints | Planned | Symbol/year/quarter transcript discovery and full text. Full transcripts can be tens of thousands of tokens and require a two-step date/search workflow plus strict excerpts. | Future transcript inventory and targeted transcript-search tools. |
| Insider-trading search/statistics endpoints | Planned | Symbol, paging, transaction type, and reporting-name filters; transaction rows and aggregate buy/sell statistics. | Future `fmp_insider_activity`. |
| Form 13F institutional ownership endpoints | Planned | Holder CIK or company symbol plus year/quarter; holdings, position changes, and holder analytics. | Future `fmp_institutional_ownership`. |
| Earnings/dividend/split/IPO calendars | Planned | Company symbol or date window depending on endpoint; bounded event rows. | Future `fmp_company_calendar` and `fmp_market_calendar`. |
| Stock news and press releases | Planned | Symbol list, date filters, paging, and limits; article metadata, snippets, and URLs. | Future `fmp_stock_news`. |
| SEC filings and full 10-K JSON | Planned escalation | Symbol/form/date or symbol/year/period. Payloads can be very large and should be discovered then fetched by selected sections. | Future targeted filing tools only if standard fundamentals cannot answer the question. |
| Trading, brokerage orders, portfolio custody, account management, and investment recommendations | Not applicable | FMP data access is read-only here. Raynard does not place trades or treat provider ratings as advice. | Not planned. |

## Source Documentation

- https://site.financialmodelingprep.com/developer/docs
- https://site.financialmodelingprep.com/developer/docs/formula
- https://site.financialmodelingprep.com/developer/docs/cycle-times-stable
- https://site.financialmodelingprep.com/developer/docs/dashboard

## Live Probing Notes

`GET /stable/company-screener` has not yet been live-probed; `fmp_company_screener` is covered by mocked tests only, and its response field names (notably `exchangeShortName` and `lastAnnualDividend`) should be confirmed against a live call on the configured plan.

On 2026-08-30, every stable endpoint used by the first seven tools was called with the configured FMP credential. The credential value was not written into this extension or printed in test output. For AAPL, annual income statements, balance sheets, cash flows, key metrics, ratios, and enterprise values each returned 20 requested rows spanning fiscal 2006–2025. Annual product and geographic segmentation each returned 16 rows spanning fiscal 2010–2025. A bounded dedicated historical-market-cap call returned 502 daily rows across 2011–2012. The probe also confirmed that `most-actives` returned 50 rows, analyst estimates exposed revenue/EPS ranges and analyst counts, segmentation used a dynamic `data` object, and `grades` returned 1,791 rows and should remain opt-in.
