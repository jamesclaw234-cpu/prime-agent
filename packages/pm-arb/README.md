# @earendil-works/pi-pm-arb

Polymarket US prediction-market arbitrage scanner and execution engine. Paper-first, sibling to
`packages/btc-arb`, built with the same discipline: exact-decimal money math, measurement before
opinion, a checking loopback fake that verifies what a real venue would verify, and a live gate
that cannot be opened by accident.

**Status: scan-first, deliberately.** The venue layer (Ed25519 auth, REST client, signed
market-data WebSocket), detection core and CLI are done and tested; nothing in this package
places an order. Execution is gated on two venue properties that are currently marked
ASSUMPTIONS in the code and must be settled from real data first (see below).

## The venue, verified from primary sources

Polymarket US (QCX LLC) is the CFTC-regulated exchange - the only Polymarket a US person can
lawfully trade. Everything this package assumes about the API is taken from the official SDK
source (`Polymarket/polymarket-us-python`), not from blog posts:

- Public market data from `gateway.polymarket.us`, unauthenticated, 60 requests/minute.
- Trading on `api.polymarket.us`, authenticated with an Ed25519 signature over
  `${timestampMs}${METHOD}${path}` - bare path, no query, no body - in `X-PM-Access-Key`,
  `X-PM-Timestamp`, `X-PM-Signature` headers. Node's built-in crypto signs this natively:
  zero runtime dependencies, same as btc-arb.
- The market-data WebSocket (`wss://api.polymarket.us/v1/ws/markets`, at most 10 instruments per
  connection) is **authenticated too**: the SDK signs the upgrade request itself. Node's built-in
  WebSocket cannot attach those headers, which is why `src/venue/ws-client.ts` speaks RFC 6455
  directly - a client built on the browser API passes every local test and never connects live.
- Orders: LIMIT and MARKET, intents `BUY_LONG`/`SELL_LONG`/`BUY_SHORT`/`SELL_SHORT` (LONG is YES,
  SHORT is NO - one market, both sides), TIFs include IOC and FOK. `POST /v1/order/preview`
  validates without placing - this venue's free rehearsal rung.
- Orders report their own `commissionsBasisPoints`; fees are read from the exchange, never modelled
  from memory. That rule exists because assuming the fee once cost this project a 5x error.

## The arbitrage primitive

No triangles here. A LONG share and a SHORT share of the same market pay $1 at settlement between
them, so:

- **Complement arb**: LONG ask + SHORT ask < $1 minus both taker fees -> buy both, guaranteed value.
- **Multi-outcome arb**: an event's outcomes are separate markets; if all their asks sum below
  $1 minus fees, buy the set.

Fees follow `shares x feeRate x p x (1-p)` (worst at 50c, near-zero at the tails), with maker
rebates - resting orders earn. Whether dislocations big enough to clear that actually occur on a
young venue is precisely what the scanner measures before any money moves.

Two venue properties are marked ASSUMPTION in the code and gate any execution work:

1. **Is the book unified?** Does `BUY_SHORT` cross at 1 minus the LONG bid, or is SHORT quoted
   independently? The pair scan settles this empirically: on a unified book the pair-edge
   distribution is pinned below zero by exactly the spread.
2. **Do matched LONG+SHORT pairs net capital-free?** Placement locks `price x quantity`; whether
   a completed $1 set releases the locked dollar is unverified.

An event edge is additionally only real if the event's outcomes are exhaustive and mutually
exclusive - the API does not attest that, so anything that would ever trade one must require an
operator-verified allowlist.

## Running it

None of these place an order; only `doctor` and the streaming path need a key:

```bash
npx tsx src/cli.ts markets --config <cfg>   # REST snapshot: books, pair costs, event ask sums
npx tsx src/cli.ts scan    --config <cfg>   # stream + detect; edge histogram, not a pass/fail
npx tsx src/cli.ts doctor  --config <cfg>   # connectivity, signed auth, and the fee check
npx tsx src/cli.ts config  --config <cfg>   # effective config, credentials redacted
```

Without credentials, `scan` degrades honestly: it polls REST inside the public budget (one
request a second) instead of streaming, and says so. `doctor`'s fee check reconciles
`fees.takerRate` against the `commissionsBasisPoints` a real order preview reports - the
structural guard against the fee-assumption bug class.

`test/mock-venue.ts` runs the checking fake as a standalone server on loopback
(`npx tsx test/mock-venue.ts`, then `--config mock.config.json`), with a deterministic dev key,
animated books and a scheduled multi-outcome dislocation, so every command above can be rehearsed
end to end - signed WebSocket upgrade included - before a single request reaches the venue.

The summary's decision rule is the same one btc-arb earned the hard way: watch the **before
fees** line, because it stays valid even when the configured rates turn out wrong.

## Credentials

Environment only, same policy as btc-arb: `POLYMARKET_KEY_ID` and `POLYMARKET_SECRET_KEY`. Keys
are generated at polymarket.us/developer after KYC in the iOS app. A config file carrying
credentials will be rejected. Never paste a key into a chat or commit one - a key that touches a
transcript is burned.
