# @earendil-works/pi-pm-arb

Polymarket US prediction-market arbitrage scanner and execution engine. Paper-first, sibling to
`packages/btc-arb`, built with the same discipline: exact-decimal money math, measurement before
opinion, a checking loopback fake that verifies what a real venue would verify, and a live gate
that cannot be opened by accident.

**Status: under construction.** The venue layer (Ed25519 auth, REST client) is done and tested;
the market-data WebSocket, detection core, paper engine and CLI are in progress.

## The venue, verified from primary sources

Polymarket US (QCX LLC) is the CFTC-regulated exchange - the only Polymarket a US person can
lawfully trade. Everything this package assumes about the API is taken from the official SDK
source (`Polymarket/polymarket-us-python`), not from blog posts:

- Public market data from `gateway.polymarket.us`, unauthenticated, 60 requests/minute.
- Trading on `api.polymarket.us`, authenticated with an Ed25519 signature over
  `${timestampMs}${METHOD}${path}` - bare path, no query, no body - in `X-PM-Access-Key`,
  `X-PM-Timestamp`, `X-PM-Signature` headers. Node's built-in crypto signs this natively:
  zero runtime dependencies, same as btc-arb.
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

## Credentials

Environment only, same policy as btc-arb: `POLYMARKET_KEY_ID` and `POLYMARKET_SECRET_KEY`. Keys
are generated at polymarket.us/developer after KYC in the iOS app. A config file carrying
credentials will be rejected. Never paste a key into a chat or commit one - a key that touches a
transcript is burned.
