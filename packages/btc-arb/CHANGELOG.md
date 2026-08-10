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
