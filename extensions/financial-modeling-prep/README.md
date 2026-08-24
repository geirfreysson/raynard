# Financial Modeling Prep

App-local Raynard extension for compact equity research with Financial Modeling Prep's current `/stable` API. The tool design follows the useful analyst workflow in Northfox: start with valuation and quality, use bounded multi-period statements for fundamentals, inspect forward estimates and price targets, then escalate to revenue mix or peers only when the question needs them.

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
- `fmp_company_financials` — aligned annual or quarterly income statement, balance-sheet, and cash-flow trends, bounded to 1–10 periods.
- `fmp_analyst_outlook` — annual or quarterly analyst revenue/EPS estimates, current-price implied forward P/E, FMP rating, consensus price target/upside, target trend, and optional recent firm grade actions.
- `fmp_company_segments` — annual or quarterly product/business and geographic revenue mix, bounded to 1–5 periods.
- `fmp_stock_peers` — FMP peer discovery with symbol, company, current price, and market cap, bounded to 1–15 peers.

## Endpoint Inventory

| Endpoint | Status | Parameters and observed response shape | Tool or future tool |
| --- | --- | --- | --- |
| `GET /stable/most-actives` | Implemented | No business parameters. Live response observed as 50 ordered rows with `symbol`, `name`, `price`, `change`, `changesPercentage`, and `exchange`; card/text retain 15. | `fmp_market_activity` |
| `GET /stable/profile` | Implemented | Required `symbol`. One-row company profile with price, market cap, exchange, sector, industry, country, website, description, currency, and security flags. | `fmp_company_overview` |
| `GET /stable/quote` | Implemented | Required `symbol`. One-row current quote with price, session change, volume, daily/year ranges, market cap, moving averages, and timestamp. | `fmp_company_overview`; `fmp_analyst_outlook` uses price for implied forward P/E and target upside. |
| `GET /stable/key-metrics-ttm` | Implemented | Required `symbol`. One-row TTM metrics including enterprise-value multiples, ROE, ROIC, FCF yield, liquidity, capital efficiency, and working-capital measures. | `fmp_company_overview` |
| `GET /stable/ratios-ttm` | Implemented | Required `symbol`. One-row TTM profitability, liquidity, leverage, efficiency, valuation, yield, and per-share ratios. | `fmp_company_overview` |
| `GET /stable/financial-scores` | Implemented | Required `symbol`. One-row Altman Z and Piotroski scores plus supporting balance-sheet/income fields. | `fmp_company_overview` |
| `GET /stable/income-statement` | Implemented | Required `symbol`; `period=annual|quarter`; `limit=1..10`. Rows contain revenue, gross/operating/net income, EPS, and filing metadata. | `fmp_company_financials` |
| `GET /stable/balance-sheet-statement` | Implemented | Required `symbol`; `period=annual|quarter`; `limit=1..10`. Rows contain cash, assets, liabilities, equity, short/long-term debt, total debt, and net debt. | `fmp_company_financials` |
| `GET /stable/cash-flow-statement` | Implemented | Required `symbol`; `period=annual|quarter`; `limit=1..10`. Rows contain operating cash flow, capex, free cash flow, financing/investing activity, dividends, and repurchases. | `fmp_company_financials` |
| `GET /stable/analyst-estimates` | Implemented | Required `symbol`; `period=annual|quarter`; `page=0`; extension requests `limit=10`, removes historical dates when upcoming rows exist, sorts upcoming dates nearest-first, and shows 1–8. Rows contain low/high/average revenue, EBITDA, net income, EPS, and analyst counts. | `fmp_analyst_outlook` |
| `GET /stable/ratings-snapshot` | Implemented | Required `symbol`. One row with letter rating, overall score, and DCF/ROE/ROA/debt-to-equity/P-E/P-B component scores. | `fmp_analyst_outlook` |
| `GET /stable/price-target-consensus` | Implemented | Required `symbol`. One row with high, low, consensus, and median price targets. | `fmp_analyst_outlook` |
| `GET /stable/price-target-summary` | Implemented | Required `symbol`. One row with target counts and averages over month, quarter, year, and all-time windows. | `fmp_analyst_outlook` |
| `GET /stable/grades` | Implemented, opt-in | Required `symbol`. Large reverse-chronological history with date, grading company, previous/new grade, and action. FMP returned 1,787 AAPL rows during live probing; the tool downloads this only with `include_recent_grades=true` and retains at most 25. | `fmp_analyst_outlook` |
| `GET /stable/revenue-product-segmentation` | Implemented | Required `symbol`; `period=annual|quarter`. Rows contain fiscal year, period, date, currency, and a dynamic segment-to-revenue object. | `fmp_company_segments` |
| `GET /stable/revenue-geographic-segmentation` | Implemented | Required `symbol`; `period=annual|quarter`. Same envelope as product segmentation with region-to-revenue data. | `fmp_company_segments` |
| `GET /stable/stock-peers` | Implemented | Required `symbol`. FMP-selected peer rows with symbol, company name, price, and market cap; extension retains 1–15. | `fmp_stock_peers` |
| `GET /stable/ratios` and `GET /stable/key-metrics` | Planned | Historical annual/quarterly ratio and key-metric rows. Useful for long-run multiple and return-on-capital trends beyond current TTM. | Future `fmp_ratio_history` if users need more than statement history. |
| `GET /stable/discounted-cash-flow` and advanced/custom DCF variants | Planned | Required symbol; advanced/custom variants add valuation assumptions. Responses contain FMP fair value and projection inputs/tables. | Future `fmp_dcf_valuation`, with assumptions explicit and bounded output. |
| Earnings transcript endpoints | Planned | Symbol/year/quarter transcript discovery and full text. Full transcripts can be tens of thousands of tokens and require a two-step date/search workflow plus strict excerpts. | Future transcript inventory and targeted transcript-search tools. |
| Insider-trading search/statistics endpoints | Planned | Symbol, paging, transaction type, and reporting-name filters; transaction rows and aggregate buy/sell statistics. | Future `fmp_insider_activity`. |
| Form 13F institutional ownership endpoints | Planned | Holder CIK or company symbol plus year/quarter; holdings, position changes, and holder analytics. | Future `fmp_institutional_ownership`. |
| Earnings/dividend/split/IPO calendars | Planned | Company symbol or date window depending on endpoint; bounded event rows. | Future `fmp_company_calendar` and `fmp_market_calendar`. |
| Stock news and press releases | Planned | Symbol list, date filters, paging, and limits; article metadata, snippets, and URLs. | Future `fmp_stock_news`. |
| Company screener | Planned | Sector, industry, exchange, country, market cap, price, volume, beta, security flags, and result limit. | Future `fmp_company_screener`. |
| SEC filings and full 10-K JSON | Planned escalation | Symbol/form/date or symbol/year/period. Payloads can be very large and should be discovered then fetched by selected sections. | Future targeted filing tools only if standard fundamentals cannot answer the question. |
| Trading, brokerage orders, portfolio custody, account management, and investment recommendations | Not applicable | FMP data access is read-only here. Raynard does not place trades or treat provider ratings as advice. | Not planned. |

## Source Documentation

- https://site.financialmodelingprep.com/developer/docs
- https://site.financialmodelingprep.com/developer/docs/formula
- https://site.financialmodelingprep.com/developer/docs/cycle-times-stable
- https://site.financialmodelingprep.com/developer/docs/dashboard

## Live Probing Notes

Before implementation, the stable endpoints used by all six tools were called with a configured FMP credential. The observed response fields are recorded in the inventory above and pinned by mocked URL tests. The credential value was never written into this extension. The live calls also confirmed that `most-actives` currently returns 50 rows, analyst estimates expose revenue/EPS ranges and analyst counts, segmentation uses a dynamic `data` object, and `grades` is a large history that should remain opt-in.
