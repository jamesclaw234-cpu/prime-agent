# @earendil-works/pi-btc-arb

Binance Spot triangular arbitrage scanner and execution engine. Streams live top-of-book for 50+
markets, re-prices every conversion cycle that touches an updated market on each tick, and executes
fee-adjusted, filter-compliant, depth-bounded cycles leg by leg.

Paper trading is the default. Live order placement requires four independent conditions to be met
at once, and even then runs behind a full set of risk limits and a file-based kill switch.

## Read this before running it with money

Fee-adjusted triangular arbitrage on a single venue is a **crowded, latency-dominated strategy**.
A three-leg cycle pays three taker fees — about 30bps round trip at the standard 10bps spot rate —
so a signal has to clear roughly 0.3% before it is worth anything at all. Cycles that clear that
bar are rare, last milliseconds, and are competed for by firms with servers in the same data centre
as the matching engine. From a home connection or a general-purpose cloud region, the quote you are
aiming at is very often already gone.

This package is built to measure that honestly rather than to hide it:

- Every decision is made from the side of the book a marketable order actually consumes. Never the mid.
- Order sizes are capped at the quantity displayed at the touch. Sizing past it means walking the
  book, and the second price level is exactly where a few-basis-point edge stops existing.
- Cycles are re-derived in exact decimal arithmetic after lot rounding, because a 12bps gross edge
  can round into a loss on a coarse lot grid.
- The paper engine models latency, partial fills, adverse selection and outright misses, and it
  still overstates live performance — it cannot model queue position or the fact that a quote is
  often pulled precisely because someone faster acted on the same signal.

Run it in paper mode against live data for long enough to see the real fill rate before deciding
whether live trading is worth it. The `replay` command counts detections, not fills.

## Install and run

The package has **no runtime dependencies** — it uses Node 22's built-in `fetch`, global
`WebSocket` and `node:crypto`.

```bash
# Scan only. Detects and prints opportunities, never places an order.
npx tsx src/cli.ts scan

# Paper trade against the live book.
npx tsx src/cli.ts run

# See the market universe and the cycles that would be watched.
npx tsx src/cli.ts symbols

# Preflight: connectivity, clock skew, credentials, filter handling. Places no orders.
npx tsx src/cli.ts doctor
```

### Commands

| Command   | What it does                                                                  |
| --------- | ----------------------------------------------------------------------------- |
| `run`     | Detect and execute. Paper unless the live gate opens.                          |
| `scan`    | Detect and log only. Never executes, even with credentials present.            |
| `symbols` | Resolve the universe and print the cycle table and per-tick fanout.            |
| `doctor`  | Read-only preflight checks. Reports whether the live gate would open.          |
| `replay`  | Feed a recorded tick file back through the detector.                           |
| `config`  | Print the effective configuration with secrets redacted.                       |

Useful flags: `--config <path>`, `--testnet`, `--min-edge <bps>`, `--max-notional <n>`,
`--duration <sec>`, `--file <path>`, `--no-dashboard`, `--log-level <lvl>`.

## Going live

Live trading is deliberately hard to enter by accident. **All four** must hold:

1. `mode: "live"` in the config file,
2. the `--live` flag on the command line,
3. `ARB_LIVE_CONFIRM=I_UNDERSTAND_THE_RISK` in the environment,
4. `BINANCE_API_KEY` and `BINANCE_API_SECRET` in the environment.

Any missing condition downgrades the run to paper and logs why, rather than aborting — a mis-set
variable costs a paper session, not capital.

```bash
export BINANCE_API_KEY=...
export BINANCE_API_SECRET=...
export ARB_LIVE_CONFIRM=I_UNDERSTAND_THE_RISK
npx tsx src/cli.ts run --config arb.config.json --live
```

**Create the API key with trading permission only. Never enable withdrawals, and restrict the key
to your egress IP.** `doctor` warns if the key can withdraw. Credentials are read from the
environment only — a config file containing `apiKey` or `apiSecret` is rejected outright.

Start on the Spot testnet (`--testnet`) to verify the whole path end to end without capital.

### Stopping it

```bash
touch ~/.prime/btc-arb/HALT     # halts within one poll interval, no restart needed
```

`SIGINT`/`SIGTERM` shut down gracefully, waiting for any in-flight cycle rather than abandoning it
half-executed.

## How it works

```
exchangeInfo ──► universe selection ──► asset graph ──► cycle enumeration ──► cycle index
                                                                                  │
  bookTicker WS shards ──► BookStore ──► float screen (per tick, O(cycles-for-symbol))
                                              │
                                              ▼
                            exact decimal sizing: depth cap, lot rounding,
                            filter checks, worst-case price, net edge
                                              │
                                              ▼
                                   risk limits ──► executor ──► ledger
```

**Two-tier pricing.** The screen that runs on every tick uses float64 — roughly an order of
magnitude faster than BigInt and carrying ~15 significant digits, far more than basis-point
resolution needs. It fires slightly *below* the acceptance threshold so it can never hide a real
candidate. Everything that fires is then re-derived in exact fixed-point arithmetic. Nothing sends
an order off a float.

**Incremental scanning.** Cycles are enumerated once at startup — the set only changes when the
exchange lists or delists a market — and indexed by market. A `bookTicker` frame costs work
proportional to that one market's cycle count, not to the whole table. `symbols` prints the worst
case fanout.

**Sharded streams.** Markets are split across several WebSocket connections. One socket carrying
every stream is a single point of failure whose reconnect blinds the whole bot. Each shard
reconnects independently with jittered backoff, has a data-staleness watchdog (Node's WebSocket
answers server pings transparently and exposes no pong event, so absence of data is the only
detectable signal), and is proactively recycled well before the exchange's 24-hour forced
disconnect.

**Leg-by-leg execution.** A three-leg cycle is not atomic. Every leg after the first is re-sized
from the quantity the previous leg *actually* produced, net of commission — a spot taker fee is
charged in the asset you receive, so a cycle sized off gross fills fails its last leg for
insufficient balance. Between legs the executor compares finishing the cycle against reversing out
of it and takes whichever is worth more at current prices. Residual inventory is flattened by
retracing the executed legs with extra aggression; if that fails, the amount is reported as
stranded and (by default) trading halts.

**Orders are marketable IOC limits, never market orders.** The limit bounds how far a fill can
slip; an unfilled IOC costs nothing but the opportunity. With
`execution.requireNonNegativeWorstCase` (on by default), a cycle is rejected unless it still breaks
even when *every* leg fills at its limit price.

## Configuration

`arb.config.example.json` is a fully populated starting point. Every key not present falls back to
the built-in default, and unknown keys are rejected rather than ignored.

The settings that matter most:

| Key                                     | Default | Why it matters                                                                  |
| --------------------------------------- | ------- | ------------------------------------------------------------------------------- |
| `detection.minNetEdgeBps`               | `8`     | Post-fee, post-rounding edge required to act. Below ~5 you are trading noise.    |
| `detection.maxBookAgeMs`                | `1500`  | Refuse decisions made off a stale frame.                                         |
| `execution.maxNotionalPerCycle`         | `200`   | Per-cycle size cap in the accounting asset.                                      |
| `execution.depthUtilization`            | `0.5`   | Share of displayed size to take. Above ~0.5 the fill rate collapses.             |
| `execution.aggressionTicks`             | `2`     | Ticks through the touch. Zero prices at the touch and often misses.              |
| `execution.requireNonNegativeWorstCase` | `true`  | Reject cycles that lose money at the limit price.                                |
| `risk.maxDailyLoss`                     | `50`    | Halts for the rest of the UTC day once breached.                                 |
| `risk.maxOrdersPerSecond`               | `8`     | Local cap, independent of the exchange's own unfilled-order limit.              |
| `risk.haltOnStranded`                   | `true`  | Stop everything when a cycle leaves inventory the unwind could not flatten.      |
| `fees.autoDetect`                       | `true`  | Reads the real, complete commission rate from the account instead of guessing.   |

## Risk controls

Each of these exists because of a specific way an automated trader loses money without a human
noticing: kill-switch file, max notional per cycle, max concurrent cycles, minimum interval between
cycles, daily loss limit, daily cycle cap, consecutive-failure halt, error-rate circuit breaker,
per-symbol cooldown after a failed cycle, clock-skew guard, stale-data guard, order-rate budget,
and a halt on stranded inventory. An ambiguous order failure — a timeout or 5xx where the order may
or may not have executed — halts trading for manual reconciliation rather than retrying.

## Observability

- **Structured log** (`arb.log.jsonl`) — every reconnect, rejected order and skipped opportunity.
- **Trade ledger** (`ledger.jsonl`) — one row per attempted cycle with full leg detail, written
  before anything is aggregated. Failed cycles use the same schema as successful ones.
- **Live dashboard** — feed health, detection funnel, PnL, slippage versus model, risk state.
- **Recording and replay** — `--file ticks.jsonl` records every accepted frame; `replay` feeds it
  back through the exact detection path.

The metric worth watching is **slippage versus model**: realised PnL minus what the signal
promised. It is the direct measure of how much of your detected edge survives execution.

## Testing

```bash
npx vitest --run
```

276 tests, all offline and deterministic — no network, no API keys, no paid calls. Coverage
includes the exact-decimal money math, filter parsing and rounding, fee arithmetic (float screen
checked against exact arithmetic), depth and lot-rounding rejections, cycle enumeration,
Bellman-Ford sweeps, WebSocket reconnect and staleness state machines, HMAC signing against
Binance's own documented worked example, rate-limit windows, every risk guard, and the executor's
partial-fill, unwind, stranded-inventory and deadline paths.

## The fee is the number that matters

A cycle only exists if it clears the fee, so the taker rate is the one input where being wrong low
turns a losing trade into an apparently profitable one. Binance charges **three** commission
components — standard, tax and special — and within each, the side rate (`buyer` on a buy,
`seller` on a sell) is *added* to the taker rate rather than replacing it. Reading only
`commissionRates.taker` understates the true cost.

With `fees.autoDetect`, the bot queries `GET /api/v3/account/commission` and sums all three
components, taking the worse of the two sides since a cycle trades in both directions. If your
account is charged anything beyond the standard component it logs a warning, because those rates
vary per symbol and only one symbol is sampled — pin `fees.takerBps` explicitly in that case.

The BNB discount is deliberately not modelled: it applies only to the standard component, and the
published examples disagree on whether the `discount` field is the multiplier or the reduction.
Ignoring it overstates the fee, which is the safe direction.

## Exchange rules not enforced client-side

These are verified against the published spec and deliberately left to the exchange, because each
one fails as a *definite* rejection or expiry — a clean zero-fill that the unwind path already
handles — rather than as an ambiguous or partial outcome:

- **`PRICE_RANGE` execution rule.** A newer rule, enforced at execution time rather than at order
  acceptance: a taker order that would execute outside a band around a continuously-moving
  reference price is expired with `EXECUTION_RULE_PRICE_RANGE_EXCEEDED`. Bands can be as tight as
  a few basis points. This bot does not subscribe to `<symbol>@referencePrice`, so it cannot
  predict the band — but it *records* the expiry reason, so a symbol that is systematically
  refusing your aggression level is visible in the ledger rather than looking like bad luck.
- **`PERCENT_PRICE_BY_SIDE`** is checked against the current touch instead of the exchange's
  average-price reference. That makes the check weaker than the real one, never stronger. The
  precise version would subscribe to `<symbol>@avgPrice`.
- **`MAX_POSITION`, `MAX_NUM_ORDERS`, `EXCHANGE_MAX_NUM_ORDERS`** depend on account-wide state.
  Since every order this bot sends is IOC and never rests, its open-order count is effectively
  zero, so these bind only in unusual configurations.

`expiryReason` is written to every ledger row, so the difference between "lost the race"
(`UNFILLED_IOC_QUANTITY_EXPIRED`), "nothing on the book" (`INSUFFICIENT_LIQUIDITY`) and "the
exchange refused this price" (`EXECUTION_RULE_PRICE_RANGE_EXCEEDED`) is recorded rather than
collapsed into a generic miss.

## Not implemented, on purpose

- **Cross-exchange arbitrage.** Requires pre-positioned inventory on every venue, because
  withdrawal latency is far longer than any edge survives. That turns the problem into inventory
  management with a continuous rebalancing drag, not arbitrage.
- **Resting orders.** By the time a maker order fills, the other legs have moved and the position
  is directional.
- **Margin, futures, or leverage.**
