# pi-btc-arb — state of play

Notes for a session picking this up fresh. Everything here was measured against live Binance.US,
not assumed. Several of these numbers were got wrong once already by reasoning from defaults
instead of checking, so check before re-deriving.

## The operator's situation

- Venue is **Binance.US**. Binance.com global returns `HTTP 451` from their jurisdiction, and so
  does its testnet, so there is no rehearsal venue. Use `test/mock-exchange.ts` for that instead.
- Account balance is about **$19**. That is the binding constraint on everything below.
- Their real taker fee is **0.02% (2bps)**, confirmed from their own account screen. Binance.US
  charges 0% maker / 0.02% taker on all spot pairs with no volume tiers since April 2026.
  **Do not assume the 10bps that is standard elsewhere** — that error made every measured edge look
  24bps worse than reality and nearly ended the investigation on a false negative.

## What the measurements actually say

From a real scan, 472 cycles priced:

| quantity | value |
| --- | --- |
| best net edge seen | −8.44 bps |
| best edge **before fees** | −2.44 bps |
| fee hurdle (3 legs × 2bps) | 6 bps |
| lot-grid dust at $19/cycle | ~180 bps |
| lot-grid dust at $100/cycle | ~42 bps |

The spreads alone lose money at the best observation, so this is not a fee problem or a latency
problem — the venue is efficient to within ~2.4bps. And at their size **dust dominates everything**:
it is 30× the fee hurdle. Capital is the constraint, not the exchange, the fee tier, or the host.

A second, independently written system (`cryptarb`, Python, different author) scanning the same
venue reports the same conclusion, from a config requiring 29bps of gross dislocation.

## The decision rule, already agreed with the operator

Watch the `before fees` line in the `scan` summary. It is fee-independent, so it stays valid even
if the fee assumption is wrong again.

- stays negative → the venue is efficient; this is finished, and no tuning changes it.
- positive but under the fee hurdle → genuinely mispriced, fees are the obstacle; worth discussing
  venues and fee tiers, not worth funding at $19.
- above the hurdle at some timestamp → a real window existed; latency becomes the question, and the
  timestamp says what caused it.

Do not move this rule after the fact.

## Bugs found only by running against the live venue

Do not regress these; each was invisible against Binance.com and against mocks.

1. `GET /api/v3/account` must send **no optional parameters**. Binance.US answers `-1101 Too many
   parameters; expected '3' and received '4'` to `omitZeroBalances`. That endpoint is the only
   source of balances, so the failure left every cycle unfundable while the bot streamed happily
   and reported no fault. `test/fake-binance.ts` now refuses extras on that path to hold the line.
2. `universe.maxSymbols` used to truncate **alphabetically**, which deleted `USDCUSD`, `USDCUSDT`
   and `USDTUSD` — the bridge markets that make stablecoin cycles exist. A real scan saw 12 cycles
   where 60 existed. Selection now ranks by the *less connected* of a market's two assets.

## Running it without spending anything

None of these need funds, and only `doctor` needs a key:

```bash
npx tsx src/cli.ts symbols --config binance-us.config.json   # cycles ranked by the notional each needs
npx tsx src/cli.ts scan    --config binance-us.config.json   # edge distribution, not just a pass/fail
npx tsx src/cli.ts doctor  --config binance-us.config.json   # validates a real order, places nothing
```

`test/mock-exchange.ts` runs a Binance Spot server on loopback that checks HMACs and fills orders,
so `run --live` can be rehearsed end to end. It is the only rehearsal available on a venue with no
testnet.

## Open item

The operator was asked to run a 12-hour `scan` and report the `before fees` line. That result had
not arrived when this note was written. Nothing downstream should be decided without it.
