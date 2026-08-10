/**
 * Runs the fake exchange as a standalone server, so the real CLI can be driven end to end.
 *
 *     npx tsx test/mock-exchange.ts
 *
 * This exists because the integration gap is otherwise unclosable from a restricted jurisdiction:
 * `doctor`, `scan` and a full `run --live` all need something on the other end of the socket that
 * checks signatures and fills orders. The server here does both, so the entire ladder can be
 * rehearsed - including live order placement - before a single request reaches Binance.
 *
 * It is not a market simulator. Prices walk from a fixed seed and a genuine arbitrage window is
 * opened on a schedule, because the point is to prove the machinery fires, not to model anything.
 */

import { decToString } from "../src/util/decimal.js";
import { FakeBinance, type FakeQuote } from "./fake-binance.js";

/** Matches the hosts in `mock.config.json`; pass a port to move it. */
const PORT = Number(process.argv[2] ?? 8080) || 8080;
const TICK_MS = 250;
/** Ticks between dislocations, and how many ticks each one lasts. */
const WINDOW_EVERY = 40;
const WINDOW_TICKS = 3;

const BTC_USDT = 100_000;
const ETH_BTC = 0.035;
/** The price ETHUSDT must trade at for the triangle to be flat: 100000 * 0.035. */
const ETH_USDT = BTC_USDT * ETH_BTC;
/**
 * How far ETHUSDT is pushed out of line during a window.
 *
 * Deliberately fatter than anything a real book offers. Three legs of taker fee is 30bps, crossing
 * three spreads is another few, and `aggressionTicks` costs more than it looks on a symbol whose
 * tick is coarse relative to its price - two ticks on ETHBTC at 0.035 is nearly 6bps by itself.
 * The job of this rig is to make the machinery fire, not to be realistic about the edge.
 */
const DISLOCATION = 1.012;

/** Seeded LCG: the same run twice produces the same books, which makes a bug reproducible. */
function makeRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1_664_525 + 1_013_904_223) >>> 0;
		return state / 0x1_0000_0000;
	};
}

function quote(mid: number, spreadBps: number, digits: number, qty: string): FakeQuote {
	const half = (mid * spreadBps) / 20_000;
	return {
		bid: (mid - half).toFixed(digits),
		bidQty: qty,
		ask: (mid + half).toFixed(digits),
		askQty: qty,
	};
}

async function main(): Promise<void> {
	const fake = new FakeBinance({
		balances: { USDT: "10000", BTC: "0.05", ETH: "1" },
		takerBps: 10,
		quotes: {
			BTCUSDT: quote(BTC_USDT, 2, 2, "5"),
			ETHBTC: quote(ETH_BTC, 2, 6, "200"),
			ETHUSDT: quote(ETH_USDT, 2, 2, "100"),
			XYZUSDT: quote(1, 20, 2, "1000"),
		},
	});

	const { restBaseUrl, wsBaseUrl } = await fake.start(PORT);

	process.stdout.write(
		[
			"",
			"  mock Binance Spot listening",
			`    REST  ${restBaseUrl}`,
			`    WS    ${wsBaseUrl}`,
			"",
			"  In another terminal, from packages/btc-arb:",
			"",
			`    export BINANCE_API_KEY=${fake.apiKey}`,
			`    export BINANCE_API_SECRET=${fake.apiSecret}`,
			"    npx tsx src/cli.ts doctor --config mock.config.json",
			"    npx tsx src/cli.ts scan   --config mock.config.json",
			"",
			"  To rehearse the live order path against this server (no real money can be reached -",
			"  the hosts are loopback):",
			"",
			"    export ARB_MODE=live",
			"    export ARB_LIVE_CONFIRM=I_UNDERSTAND_THE_RISK",
			"    npx tsx src/cli.ts run --live --config mock.config.json --duration 60",
			"",
			`  An arbitrage window opens every ${(WINDOW_EVERY * TICK_MS) / 1000}s and lasts ${(WINDOW_TICKS * TICK_MS) / 1000}s.`,
			"  Ctrl-C to stop.",
			"",
		].join("\n"),
	);

	const random = makeRandom(20_260_810);
	let tick = 0;
	let placed = 0;

	const timer = setInterval(() => {
		tick++;
		const drift = (value: number): number => value * (1 + (random() - 0.5) * 0.0004);
		const btc = drift(BTC_USDT);
		const ethBtc = drift(ETH_BTC);
		const inWindow = tick % WINDOW_EVERY < WINDOW_TICKS;
		const ethUsdt = btc * ethBtc * (inWindow ? DISLOCATION : 1);

		fake.publishAll({
			BTCUSDT: quote(btc, 2, 2, "5"),
			ETHBTC: quote(ethBtc, 2, 6, "200"),
			ETHUSDT: quote(ethUsdt, 2, 2, "100"),
		});

		if (fake.placements.length !== placed) {
			placed = fake.placements.length;
			const last = fake.placements[placed - 1];
			process.stdout.write(
				`  order ${String(placed).padStart(3)}  ${last.side.padEnd(4)} ${last.symbol.padEnd(8)} ` +
					`${last.quantity} @ ${last.price} -> ${last.status}\n`,
			);
		}
	}, TICK_MS);

	const shutdown = (): void => {
		clearInterval(timer);
		process.stdout.write(
			`\n  ${fake.placements.length} orders placed, ${fake.signatureFailures} signature failures\n` +
				`  final balances: USDT ${decToString(fake.balanceOf("USDT"))}` +
				` BTC ${decToString(fake.balanceOf("BTC"))}` +
				` ETH ${decToString(fake.balanceOf("ETH"))}\n`,
		);
		void fake.stop().then(() => process.exit(0));
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

void main();
