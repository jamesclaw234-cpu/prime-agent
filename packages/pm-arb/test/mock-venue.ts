/**
 * Runs the fake Polymarket US as a standalone server, so the real CLI can be driven end to end.
 *
 *     npx tsx test/mock-venue.ts
 *
 * This closes the same integration gap the btc-arb mock exchange closes: `doctor` and `scan`
 * need something on the other end of the socket that verifies Ed25519 signatures - on REST calls
 * AND on the WebSocket upgrade - refuses malformed orders, and pushes books. Everything can be
 * rehearsed here before a single request reaches the venue.
 *
 * It is not a market simulator. Prices walk from a fixed seed, and a genuine multi-outcome
 * dislocation is opened on a schedule, because the point is to prove the machinery fires - the
 * detector, the fee math, the summary - not to model a prediction market.
 */

import { privateKeyFromSecret, rawPublicKey } from "../src/venue/auth.js";
import { FakePolymarketUS } from "./fake-polymarket-us.js";

/** Matches the hosts in `mock.config.json`; pass a port to move it. */
const PORT = Number(process.argv[2] ?? 8091) || 8091;
const TICK_MS = 250;
/** Ticks between dislocations, and how many ticks each one lasts. */
const WINDOW_EVERY = 40;
const WINDOW_TICKS = 3;
const HEARTBEAT_EVERY_TICKS = 20;

/** A deterministic loopback-only dev key. Not a credential: it exists so signatures VERIFY. */
const MOCK_SECRET = Buffer.alloc(32, 7).toString("base64");
const MOCK_KEY_ID = "mock-key-1";

/**
 * One three-outcome event plus a standalone market. The election asks sum to 1.05 at rest -
 * normal for a book with spreads - and get pushed to ~0.94 during a window, which clears the
 * taker-fee hurdle at these prices (about 1.3 cents per set at a 0.05 rate) with room to spare.
 */
const ELECTION = [
	{ slug: "mock-election-alice", mid: 0.4 },
	{ slug: "mock-election-bob", mid: 0.33 },
	{ slug: "mock-election-carol", mid: 0.26 },
];
const SPREAD = 0.04;
const DISLOCATION = 0.89;

/** Seeded LCG: the same run twice produces the same books, which makes a bug reproducible. */
function makeRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1_664_525 + 1_013_904_223) >>> 0;
		return state / 0x1_0000_0000;
	};
}

function quote(mid: number, qty: string): { bid: string; bidQty: string; ask: string; askQty: string } {
	const clamped = Math.min(0.97, Math.max(0.03, mid));
	return {
		bid: (clamped - SPREAD / 2).toFixed(2),
		bidQty: qty,
		ask: (clamped + SPREAD / 2).toFixed(2),
		askQty: qty,
	};
}

async function main(): Promise<void> {
	const fake = new FakePolymarketUS({
		markets: [
			...ELECTION.map((market) => ({
				slug: market.slug,
				eventSlug: "mock-election",
				...quote(market.mid, "100"),
			})),
			{ slug: "mock-btc-150k", eventSlug: "mock-btc-150k-event", ...quote(0.18, "250") },
		],
		keys: { [MOCK_KEY_ID]: rawPublicKey(privateKeyFromSecret(MOCK_SECRET)) },
		balanceUsd: "100",
	});

	let baseUrl: string;
	try {
		({ baseUrl } = await fake.start(PORT));
	} catch (error) {
		// A leftover server from an earlier session keeps answering on this port while this process
		// dies in the background - which reads as a bug in the CLI rather than a stray process.
		if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
			process.stderr.write(
				`\n  port ${PORT} is already in use - most likely a mock venue from an earlier run.\n` +
					`  Stop it first, or start this one on another port and adjust mock.config.json:\n\n` +
					`    npx tsx test/mock-venue.ts 8092\n\n`,
			);
			process.exit(1);
		}
		throw error;
	}

	process.stdout.write(
		[
			"",
			"  mock Polymarket US listening",
			`    REST + WS  ${baseUrl}`,
			"",
			"  In another terminal, from packages/pm-arb:",
			"",
			"    npx tsx src/cli.ts markets --config mock.config.json",
			"",
			"  The signed paths (WebSocket streaming, doctor's preview and fee check) need the",
			"  mock key - a deterministic loopback-only value, not a real credential:",
			"",
			`    export POLYMARKET_KEY_ID=${MOCK_KEY_ID}`,
			`    export POLYMARKET_SECRET_KEY=${MOCK_SECRET}`,
			"    npx tsx src/cli.ts doctor --config mock.config.json",
			"    npx tsx src/cli.ts scan   --config mock.config.json --duration 60",
			"",
			`  A multi-outcome dislocation opens every ${(WINDOW_EVERY * TICK_MS) / 1000}s and lasts ${(WINDOW_TICKS * TICK_MS) / 1000}s.`,
			"  Ctrl-C to stop.",
			"",
		].join("\n"),
	);

	const random = makeRandom(20_260_820);
	let tick = 0;
	let previews = 0;

	const timer = setInterval(() => {
		tick++;
		const inWindow = tick % WINDOW_EVERY < WINDOW_TICKS;
		for (const market of ELECTION) {
			const drifted = market.mid * (1 + (random() - 0.5) * 0.02);
			fake.publish(market.slug, quote(drifted * (inWindow ? DISLOCATION : 1), "100"));
		}
		fake.publish("mock-btc-150k", quote(0.18 * (1 + (random() - 0.5) * 0.05), "250"));
		if (tick % HEARTBEAT_EVERY_TICKS === 0) fake.sendHeartbeats();

		if (fake.previews !== previews) {
			previews = fake.previews;
			process.stdout.write(`  order preview ${previews} validated\n`);
		}
	}, TICK_MS);

	const shutdown = (): void => {
		clearInterval(timer);
		process.stdout.write(
			`\n  ${fake.previews} previews, ${fake.placements.length} orders, ` +
				`${fake.signatureFailures} signature failures, ${fake.wsUpgradesRejected} rejected upgrades\n`,
		);
		void fake.stop().then(() => process.exit(0));
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

void main();
