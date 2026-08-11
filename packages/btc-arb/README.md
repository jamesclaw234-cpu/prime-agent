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
- The lot grid itself is a cost, and at small notionals it is the dominant one — measured at
  ~42bps on a $100 cycle, several times any edge that exists. See
  [sizing for the lot grid](#size-the-cycle-for-the-lot-grid-not-for-your-risk-appetite); the fee
  is not the reason a small cycle loses money.
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
| `symbols` | Resolve the universe; print the cycle table, per-tick fanout and dust per cycle. |
| `doctor`  | Preflight checks. Validates a real order without placing it. Places no orders. |
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

### Where the key goes

Nowhere in the repo. Credentials are read from the environment only, and a config file containing
`apiKey` or `apiSecret` is rejected at load time. Copy the template, fill it in, and source it:

```bash
cp .env.example .env      # .env is gitignored; .env.example is not
$EDITOR .env              # fill in BINANCE_API_KEY and BINANCE_API_SECRET
set -a; source .env; set +a
npx tsx src/cli.ts run --config arb.config.json --live
```

The bot does not read `.env` itself. Sourcing it is a deliberate extra step: a stray file in the
working directory can never silently arm live trading.

For a real 24/7 deployment, prefer your service manager's secret handling over a file on disk —
with systemd that is `EnvironmentFile=` pointing somewhere `0600` and outside the repo, or a
`LoadCredential=` mount.

Verify what the process actually sees, without printing the secret:

```bash
npx tsx src/cli.ts config   # apiKey/apiSecret show as "<set>", never the value
npx tsx src/cli.ts doctor   # confirms the key works and warns if it can withdraw
```

**Create the API key with trading permission only. Never enable withdrawals, and restrict the key
to your egress IP.** `doctor` warns if the key can withdraw. Credentials are read from the
environment only — a config file containing `apiKey` or `apiSecret` is rejected outright.

`doctor` also runs a real leg-1 order through `POST /api/v3/order/test` — the exchange checks the
signature and every filter and places nothing. That proves the signed order path against the real
venue for free, which is the part you otherwise only find out about with money on the line.

Start on the Spot testnet (`--testnet`) to verify the whole path end to end without capital. On
Binance.US there is no testnet, so use the [mock exchange](#rehearsing-the-live-path-without-an-exchange)
for that step instead.

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

299 tests, all offline and deterministic — no network, no API keys, no paid calls. Coverage
includes the exact-decimal money math, filter parsing and rounding, fee arithmetic (float screen
checked against exact arithmetic), depth and lot-rounding rejections, cycle enumeration,
Bellman-Ford sweeps, WebSocket reconnect and staleness state machines, HMAC signing against
Binance's own documented worked example, rate-limit windows, every risk guard, and the executor's
partial-fill, unwind, stranded-inventory and deadline paths.

### Against a real socket

`test/loopback.test.ts` runs the whole bot against `test/fake-binance.ts`, a Binance Spot server
that speaks the real wire protocol on a loopback port. Nothing is stubbed there — Node's own
`fetch` and `WebSocket` are used, and the server verifies the HMAC over the exact bytes it
received, enforces `recvWindow`, keeps balances, matches IOC orders against displayed depth and
refuses what the exchange would refuse. That covers the two boundaries a mocked transport cannot:
query-string signing as it actually goes on the wire, and RFC 6455 framing produced by something
other than us.

### Rehearsing the live path without an exchange

The same server runs standalone, so the real CLI can be driven end to end — including live order
placement — before a single request reaches Binance. This is the only way to exercise the live
path from a jurisdiction that Binance geo-blocks.

```bash
npx tsx test/mock-exchange.ts          # terminal 1
```

```bash
# terminal 2, from packages/btc-arb
export BINANCE_API_KEY=test-api-key
export BINANCE_API_SECRET=test-api-secret-0123456789
npx tsx src/cli.ts doctor --config mock.config.json
npx tsx src/cli.ts scan   --config mock.config.json

# and the live order path, against loopback hosts that cannot reach real money
export ARB_MODE=live ARB_LIVE_CONFIRM=I_UNDERSTAND_THE_RISK
npx tsx src/cli.ts run --live --config mock.config.json --duration 60
```

The mock opens an arbitrage window on a schedule and its prices walk from a fixed seed, so a run
is reproducible. It is a rehearsal rig, not a market simulator: the edge it offers is far fatter
than any real book's.

## Size the cycle for the lot grid, not for your risk appetite

The most expensive thing about a small triangular cycle is not the fee — it is the lot step.

Commission is deducted from the asset you receive, so every intermediate leg's output lands off
the *next* symbol's `stepSize` grid. The quantity rounds down, and the remainder cannot be
forwarded or sold: it is below `minQty`. That dust stays in the account, so it is not lost, but it
is not working either, and the cycle's PnL is reported without it.

The remainder in each intermediate asset is bounded by **one `stepSize` of the next symbol**,
valued in that asset — so expect about half of that per intermediate asset, per cycle. On
`USDT→BTC→ETH→USDT` both intermediates are bounded by a `0.0001` ETH step: about $0.35 each at
$3,500 ETH, so roughly $0.35 of dust per cycle.

That is a *fixed* cost, so its cost in basis points is set entirely by the notional:

| notional per cycle | dust drag on a USDT→BTC→ETH→USDT cycle |
| ------------------ | -------------------------------------- |
| $100               | ~42 bps                                |
| $1,000             | ~4 bps                                 |
| $10,000            | ~0.4 bps                               |

Those are measured, not derived: 24 consecutive completed cycles against the mock exchange
averaged $0.419 of dust on a $99 cycle, against $0.441 of realised profit. **At the shipped
`maxNotionalPerCycle`, dust is the same order of magnitude as everything the strategy earns.**
The defaults are sized to make a mistake cheap while you are learning the system, not to make
money; raising the notional is what makes the arithmetic work, and that is a decision about risk,
not a tuning knob to turn casually.

Cycles are logged with their dust, so this stays measurable on your own book:

```
cycle finished cycle=USDT>BTC>ETH>USDT outcome=completed pnl=0.452 dust={"BTC":0.0000016,"ETH":0.0000715}
```

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

## Binance.US

Binance.com global geo-blocks some jurisdictions with `HTTP 451`, including its testnet. If
`doctor` reports "Service unavailable from a restricted location", that is a jurisdictional block
on your address, not a fault in the bot, and no configuration works around it.

Binance.US is a separate exchange that serves those users, and its API is compatible with what this
bot needs — verified against `binance-us/binance-us-api-docs`: identical `/api/v3/*` paths, the same
`X-MBX-APIKEY` header and HMAC signing, the same filter model including `PERCENT_PRICE_BY_SIDE` and
`NOTIONAL`, and the same `bookTicker` stream. `binance-us.config.json` is a ready profile.

```bash
npx tsx src/cli.ts scan --config binance-us.config.json    # read-only, no key needed
```

Two differences that matter, both verified from that spec:

- **There is no testnet.** Your first live order would otherwise be on the real exchange with real
  money. Use the [mock exchange](#rehearsing-the-live-path-without-an-exchange) as the rehearsal
  step instead — it is the same code path, including live order placement, against a server that
  checks your signatures.
- **`GET /api/v3/account/commission` is absent**, so the three-component fee breakdown cannot be
  read. The bot falls back to the account's `commissionRates` automatically, which is the standard
  component only. Confirm the rate `doctor` reports against your own fee schedule.

The profile ships `fees.takerBps: 2`, not the 10 used elsewhere. As of April 2026 Binance.US
charges 0% maker and 0.02% taker on all spot pairs with no volume tiers, and 0.01% on some — which
makes a three-leg cycle cost about **6bps rather than 30**. That is by a wide margin the cheapest
taker fee available to a US retail account, so it is worth confirming with `doctor` rather than
assuming the 10bps that is standard elsewhere: a fee assumption that is 5x too high makes every
cycle look 24bps worse than it is, which is enough to hide a real opportunity.

A third difference, found by running it: the Binance.US profile sets `detection.maxBookAgeMs` to
**6000** rather than the 1500 used elsewhere, and `maxBookAgeCeilingMs` to **30000**. `bookTicker` only pushes when the book *changes*, so
on a thin venue a quote can legitimately stand untouched for several seconds — a measured run saw
gaps of nearly 5s. A 1500ms window treats that as stale data and silently declines to price the
cycle at all, which on a quiet venue can reject most evaluations without reporting anything. `scan`
now prints how many evaluations were skipped for exactly this reason; if that share is large, the
window is too tight for the venue rather than the venue being unprofitable.

`maxBookAgeCeilingMs` is what fixes that properly. Above `maxBookAgeMs`, each symbol gets a window
that follows *its own* update cadence, capped at the ceiling — so a market that ticks twice a
minute is not judged by the standard of one that ticks ten times a second. A measured Binance.US
scan discarded 85% of its evaluations to a single global window. Set the ceiling to 0 to hold every
symbol to one window instead.

`detection.maxQuoteSkewMs` is the guard that widening makes necessary. A cycle whose legs are each
individually fresh can still be incoherent — a loop priced from a 10ms-old quote and a 4s-old one
describes a market that existed at no single instant, and the apparent edge is usually just the
newer leg having moved. Age cannot catch it, because any window wide enough to admit the older
quote admits the newer one too. Uniformly stale is fine; *unevenly* stale is not.

This is safe for the reason the problem exists: `bookTicker` pushes on *every* change, so a quote
that has not been re-sent has not moved, and a socket that dies silently is caught by the feed's own
staleness watchdog rather than by this. The executor still uses the strict `maxBookAgeMs` when it
prices an actual order.

And the economic caveat, which matters more than either: Binance.US lists far fewer pairs with much
thinner books. Triangular arbitrage needs dense cross-pairs to have cycles at all, and the ~30bps
fee hurdle is unchanged.

Check both before assuming there is anything there — neither command needs a key or any funds:

```bash
npx tsx src/cli.ts symbols --config binance-us.config.json   # what cycles exist, and what they cost
npx tsx src/cli.ts scan    --config binance-us.config.json   # whether any of them ever clear
```

It also flags when `universe.maxSymbols` is binding. That cap has to drop *something*, and what it
drops matters more than it looks: markets are ranked by the **less connected of their two assets**,
because sitting on a cycle requires being able to leave whatever you arrive at, and an asset that
appears in one market only is a dead end however liquid its counterpart is. Ranking by the sum
instead — or alphabetically — scores every leaf pair quoted in USD as highly as the USD bridge
itself, and on Binance.US that difference was 12 visible cycles against 60 real ones.

`symbols` also reports how many cycles exist at `maxCycleLength` 4, which is off by default. On a
venue with few crypto-crypto crosses that is often the difference between a handful of cycles and a
usable table — at the cost of a fourth fee and a third dust remainder, both of which the same
columns price for you.

`scan` prints the distribution of every edge it priced, not just the ones that cleared — the best
edge seen, a histogram by band, and the best each cycle ever reached. A run that finds nothing is
the normal outcome, and this is what separates "edges peaked at 5bps, so a better fee tier would
change the answer" from "edges peaked at -40bps, so nothing will".

`symbols` prints a `needs` column per cycle: the notional at which that cycle's lot-grid dust
equals your edge threshold. Thin books cap how much you can put through a cycle, and dust sets a
floor on how little is worth putting through it. If those two numbers cross the wrong way for
every cycle on the venue, no amount of tuning fixes it, and that is worth knowing before funding
an account rather than after.

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
