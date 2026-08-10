# Changelog

All notable changes to this package are documented in this file.

## [Unreleased]

- Added `@earendil-works/pi-btc-arb`, a Binance Spot triangular arbitrage scanner and execution engine that paper trades by default and gates live order placement behind an explicit four-condition check.
- Added a sharded `bookTicker` WebSocket feed with per-shard jittered reconnect, a data-staleness watchdog, and proactive recycling ahead of the exchange's 24-hour disconnect.
- Added exact fixed-point decimal arithmetic for all money math, with a float screening pass on the hot path that is re-verified exactly before any order is sent.
- Added depth-bounded, lot-rounded, filter-checked cycle sizing that re-derives the net edge after rounding and rejects cycles that lose money at their limit price.
- Added a leg-by-leg executor that re-sizes each leg from the previous fill net of commission, chooses between finishing and reversing a cycle, and unwinds residual inventory.
- Added a paper execution engine that models latency, partial fills, adverse selection and outright misses, seeded for reproducible runs.
- Added risk controls: kill-switch file, notional and concurrency caps, daily loss and cycle limits, consecutive-failure halt, error-rate breaker, per-symbol cooldown, clock-skew and stale-data guards, and an order-rate budget.
- Added a weight-aware rate limiter that adopts the exchange's published limits at startup and honours `X-MBX-USED-WEIGHT` and `Retry-After`.
- Added a JSONL trade ledger, metrics with latency percentiles, a live terminal dashboard, and tick recording with offline replay.
- Added the `run`, `scan`, `symbols`, `doctor`, `replay` and `config` CLI commands.
- Added recovery from an ambiguous order failure: the order is looked up by client id, and only an unanswerable lookup halts for manual reconciliation.
- Added `expiryReason` to the trade ledger, separating an ordinary lost race from a price the exchange refused under its Price Range execution rule.
- Added handling for the `serverShutdown` stream event, reconnecting on the notice instead of waiting for the socket to drop.
- Changed rate-limit header parsing to match the published `(intervalNum)(intervalLetter)` format rather than a fixed suffix.
- Changed order placement to use its own timeout above the exchange's 10-second processing timeout, so a slow order reports its outcome instead of becoming an unknown.
- Fixed `-1006` not being treated as an ambiguous outcome despite the spec stating its execution status is unknown.
- Changed the unfilled-order budget to follow the exchange's own count in both directions, since a filled order decrements it and the previous floor-only behaviour throttled the bot exactly when its orders were trading.
- Added a `binance-us.config.json` profile for users geo-blocked from Binance.com global, with the API compatibility and the missing-testnet caveat documented.
- Fixed `paper.startingBalances` rejecting any asset not present in the defaults, which turned starting from a non-USDT balance into an "unknown config key" error.
- Fixed the taker fee understating the real cost: Binance charges standard, tax and special commission components, and adds the side rate to the taker rate within each. The bot now sums all three from `GET /api/v3/account/commission` and warns when non-standard components apply.
- Added a loopback integration suite that runs the bot against a Binance Spot server speaking the real wire protocol over a real socket, using Node's own `fetch` and `WebSocket`. The server verifies the HMAC over the exact bytes it receives, enforces `recvWindow`, keeps balances and matches IOC orders, so signing and RFC 6455 framing are covered rather than assumed.
- Added `test/mock-exchange.ts` and a `mock.config.json` profile, which run that server standalone so `doctor`, `scan` and a full `run --live` can be rehearsed end to end without reaching the exchange - the only way to exercise the live order path from a geo-blocked jurisdiction.
- Fixed an untradeable partial-fill remainder being retried three times and then logged at `error` as stranded inventory. Commission is deducted from the asset received, so a sliver below the next symbol's `minQty` is the normal end state of a healthy cycle; reporting it as a failure buried the log line that means a real position is unhedged. Such a remainder is now identified before the retries, recorded as dust on the cycle's log line, and left alone.
- Documented that lot-step dust, not the fee, is the dominant cost of a small cycle. Each intermediate asset's remainder is bounded by one `stepSize` of the *next* symbol, so a fixed amount is left behind per cycle: measured at ~42bps on a $100 cycle and ~0.4bps on a $10,000 one.
- Changed a rate-limit wait that exhausts a request's budget to name the window that ran out and its usage, rather than reporting only that the request was rate limited.
- Changed `test/mock-exchange.ts` to report a port collision clearly, since a leftover server from an earlier run otherwise keeps answering while the new one dies in the background.
- Added an order-validation check to `doctor`: a real leg-1 order is sent to `POST /api/v3/order/test`, so the signature and every exchange-side filter are proven against the live venue without placing anything. Previously the signed order path was first exercised by the first order that spent money.
- Added a dust estimate to `symbols`: per cycle, the value left behind by lot rounding and the notional at which it equals the configured edge threshold. It needs no credentials and no funds, so a venue's viability can be checked before an account is funded.
