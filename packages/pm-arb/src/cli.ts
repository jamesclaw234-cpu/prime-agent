#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { KEY_ID_ENV, loadConfig, type PmArbConfig, SECRET_KEY_ENV } from "./config.js";
import { BookStore, bookFromWire, type MarketSlug } from "./core/book.js";
import { Detector, type EventGroup, type Opportunity } from "./core/detector.js";
import { makeFeeModel } from "./core/fees.js";
import { type Dec, decAdd, decSub, decToNumber, ONE, ZERO } from "./util/decimal.js";
import { Logger } from "./util/logger.js";
import { createAuthHeaders, keyFingerprint, privateKeyFromSecret } from "./venue/auth.js";
import { MarketDataFeed } from "./venue/feed.js";
import {
	MissingCredentialsError,
	PolymarketApiError,
	PolymarketRestClient,
	PUBLIC_REQUESTS_PER_MINUTE,
} from "./venue/rest-client.js";
import type { EventDetail } from "./venue/types.js";
import { rawWebSocketFactory } from "./venue/ws-client.js";

const USAGE = `pi-pm-arb - Polymarket US arbitrage scanner

Scan-first: this tool measures and never places an order. The trading endpoints it touches are
the free validation rungs only (signed reads, order preview).

Usage:
  pi-pm-arb <command> [options]

Commands:
  markets      Snapshot the universe over REST: books, pair costs, event ask sums. No key needed.
  scan         Stream books and run the detector. Uses the signed WebSocket when credentials are
               present, REST polling inside the public budget when they are not.
  doctor       Check connectivity, credentials, the signed endpoints and the fee configuration
               against a real order preview. Places no orders.
  config       Print the effective configuration with credentials redacted.

Options:
  --config <path>      JSON config file. Missing keys fall back to built-in defaults.
  --duration <sec>     scan: stop after this many seconds. Default: run until Ctrl-C.
  --min-net <dollars>  Override detection.minNetPerSet, in dollars per $1 set.
  --log-level <lvl>    debug | info | warn | error
  -h, --help           Show this message.

Environment:
  ${KEY_ID_ENV}, ${SECRET_KEY_ENV}   Credentials. Never put these in the config file.
`;

interface ParsedArgs {
	readonly command: string;
	readonly configFile?: string;
	readonly durationSec?: number;
	readonly minNet?: number;
	readonly logLevel?: string;
	readonly help: boolean;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
	let command = "";
	let configFile: string | undefined;
	let durationSec: number | undefined;
	let minNet: number | undefined;
	let logLevel: string | undefined;
	let help = false;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = (): string => {
			const value = argv[++i];
			if (value === undefined) throw new UsageError(`${arg} needs a value`);
			return value;
		};
		switch (arg) {
			case "-h":
			case "--help":
				help = true;
				break;
			case "--config":
				configFile = next();
				break;
			case "--duration":
				durationSec = Number(next());
				if (!Number.isFinite(durationSec) || durationSec <= 0) throw new UsageError("--duration must be positive");
				break;
			case "--min-net":
				minNet = Number(next());
				if (!Number.isFinite(minNet)) throw new UsageError("--min-net must be a number");
				break;
			case "--log-level":
				logLevel = next();
				break;
			default:
				if (arg.startsWith("-")) throw new UsageError(`unknown option: ${arg}`);
				if (command) throw new UsageError(`unexpected argument: ${arg}`);
				command = arg;
		}
	}
	return { command, configFile, durationSec, minNet, logLevel, help };
}

class UsageError extends Error {}

// --- universe ------------------------------------------------------------------------------------

interface Universe {
	readonly groups: readonly EventGroup[];
	readonly slugs: readonly MarketSlug[];
	/** Ranked events that did not fit universe.maxMarkets. Reported, never silently dropped. */
	readonly skippedEvents: readonly string[];
}

/**
 * Most liquid events first, whole events only: subscribing part of an event would leave its sum
 * permanently unevaluable while quietly consuming subscription budget - the same class of bug as
 * btc-arb's alphabetical universe cap, which deleted the bridge markets that made cycles exist.
 */
export function buildUniverse(events: readonly EventDetail[], maxEvents: number, maxMarkets: number): Universe {
	const ranked = events
		.filter((event) => event.slug && !event.closed)
		.map((event) => ({
			slug: event.slug ?? "",
			liquidity: event.liquidity ?? event.volume ?? 0,
			markets: (event.markets ?? [])
				.filter((market) => market.slug && !market.closed)
				.map((market) => market.slug ?? ""),
		}))
		.filter((event) => event.markets.length > 0)
		.sort((a, b) => b.liquidity - a.liquidity || a.slug.localeCompare(b.slug))
		.slice(0, maxEvents);

	const groups: EventGroup[] = [];
	const slugs: MarketSlug[] = [];
	const skipped: string[] = [];
	const seen = new Set<MarketSlug>();
	for (const event of ranked) {
		const fresh = event.markets.filter((slug) => !seen.has(slug));
		if (slugs.length + fresh.length > maxMarkets) {
			skipped.push(event.slug);
			continue;
		}
		for (const slug of fresh) {
			seen.add(slug);
			slugs.push(slug);
		}
		groups.push({ eventSlug: event.slug, marketSlugs: event.markets });
	}
	return { groups, slugs, skippedEvents: skipped };
}

// --- shared wiring -------------------------------------------------------------------------------

interface Wired {
	readonly config: PmArbConfig;
	readonly client: PolymarketRestClient;
	readonly logger: Logger;
}

function wire(args: ParsedArgs): Wired {
	const config = loadConfig({
		file: args.configFile,
		overrides: buildOverrides(args),
	});
	const logger = new Logger({
		level: config.observability.logLevel,
		pretty: process.stderr.isTTY ?? false,
	});
	const client = new PolymarketRestClient({
		gatewayBaseUrl: config.venue.gatewayBaseUrl,
		apiBaseUrl: config.venue.apiBaseUrl,
		keyId: config.venue.keyId,
		secretKey: config.venue.secretKey,
		timeoutMs: config.venue.requestTimeoutMs,
		logger,
	});
	return { config, client, logger };
}

function buildOverrides(args: ParsedArgs): unknown {
	const detection: Record<string, unknown> = {};
	const observability: Record<string, unknown> = {};
	if (args.minNet !== undefined) detection.minNetPerSet = args.minNet;
	if (args.logLevel !== undefined) observability.logLevel = args.logLevel;
	const overrides: Record<string, unknown> = {};
	if (Object.keys(detection).length > 0) overrides.detection = detection;
	if (Object.keys(observability).length > 0) overrides.observability = observability;
	return Object.keys(overrides).length > 0 ? overrides : undefined;
}

function out(line = ""): void {
	process.stdout.write(`${line}\n`);
}

function formatDollars(value: number, digits = 4): string {
	return (value >= 0 ? "+" : "") + value.toFixed(digits);
}

function formatTime(ms: number | undefined): string {
	if (!ms) return "-";
	return `${new Date(ms).toISOString().slice(11, 19)}Z`;
}

// --- markets -------------------------------------------------------------------------------------

async function commandMarkets(args: ParsedArgs): Promise<number> {
	const { config, client, logger } = wire(args);
	const events = await client.events({ active: true });
	const universe = buildUniverse(events, config.universe.maxEvents, config.universe.maxMarkets);
	if (universe.groups.length === 0) {
		out("no active events with open markets were returned by the venue");
		return 1;
	}
	const now = Date.now();
	let bestGrossEvent: { slug: string; edge: number } | undefined;

	for (const group of universe.groups) {
		out(`event ${group.eventSlug}`);
		out("  market                                    bid       ask    spread   pair cost");
		let askSum: Dec | undefined = ZERO;
		let priced = 0;
		for (const slug of group.marketSlugs) {
			let line = `  ${slug.padEnd(40)}`;
			try {
				const book = bookFromWire(await client.book(slug), now);
				if (!book) {
					line += "  (no two-sided book)";
					askSum = undefined;
				} else {
					const spread = decSub(book.ask, book.bid);
					// LONG ask plus the mirrored SHORT ask; below 1.0000 would be a definitional arb.
					const pairCost = decAdd(book.ask, decSub(ONE, book.bid));
					line +=
						`  ${decToNumber(book.bid).toFixed(2).padStart(6)}` +
						`  ${decToNumber(book.ask).toFixed(2).padStart(6)}` +
						`  ${decToNumber(spread).toFixed(2).padStart(6)}` +
						`  ${decToNumber(pairCost).toFixed(4).padStart(9)}`;
					if (askSum !== undefined) askSum = decAdd(askSum, book.ask);
					priced++;
				}
			} catch (error) {
				line += `  (book fetch failed: ${describe(error)})`;
				askSum = undefined;
			}
			out(line);
		}
		if (group.marketSlugs.length >= 2 && askSum !== undefined && priced === group.marketSlugs.length) {
			const edge = decToNumber(decSub(ONE, askSum));
			out(`  sum of asks ${decToNumber(askSum).toFixed(4)}  gross event edge ${formatDollars(edge)}`);
			if (!bestGrossEvent || edge > bestGrossEvent.edge) bestGrossEvent = { slug: group.eventSlug, edge };
		}
		out();
	}

	out(`${universe.groups.length} events, ${universe.slugs.length} markets`);
	if (universe.skippedEvents.length > 0) {
		out(`skipped (over universe.maxMarkets=${config.universe.maxMarkets}): ${universe.skippedEvents.join(", ")}`);
	}
	if (bestGrossEvent) {
		out(`best gross event edge in this snapshot: ${formatDollars(bestGrossEvent.edge)} on ${bestGrossEvent.slug}`);
		out(
			"an event edge is only real if the outcomes are exhaustive and mutually exclusive - verify before believing it",
		);
	}
	logger.debug("markets snapshot complete", { events: universe.groups.length, markets: universe.slugs.length });
	return 0;
}

// --- scan ----------------------------------------------------------------------------------------

async function commandScan(args: ParsedArgs): Promise<number> {
	const { config, client, logger } = wire(args);
	const startedAt = Date.now();

	const events = await client.events({ active: true });
	const universe = buildUniverse(events, config.universe.maxEvents, config.universe.maxMarkets);
	if (universe.slugs.length === 0) {
		out("nothing to scan: no active events with open markets");
		return 1;
	}
	logger.info("universe resolved", {
		events: universe.groups.length,
		markets: universe.slugs.length,
		skipped: universe.skippedEvents.length,
	});

	const store = new BookStore();
	const opportunities: Opportunity[] = [];
	let opportunityCount = 0;
	const detector = new Detector({
		store,
		events: universe.groups,
		fee: makeFeeModel(config.fees.takerRate, config.fees.makerRebateRate),
		minNetPerSet: config.detection.minNetPerSet,
		maxBookAgeMs: config.detection.maxBookAgeMs,
		maxBookAgeCeilingMs: config.detection.maxBookAgeCeilingMs,
		logger,
		onOpportunity: (opportunity) => {
			opportunityCount++;
			if (opportunities.length < 200) opportunities.push(opportunity);
		},
	});

	// Seed every book over REST before streaming, so event sums are evaluable from the start
	// instead of waiting for each leg's first push on markets that may not tick for minutes.
	for (const slug of universe.slugs) {
		try {
			const book = bookFromWire(await client.book(slug), Date.now());
			if (book) {
				store.apply(book);
				detector.onBookUpdate(slug);
			}
		} catch (error) {
			logger.warn("seed snapshot failed", { slug, error: describe(error) });
		}
	}
	logger.info("books seeded", { markets: store.size });

	const hasCredentials = client.hasCredentials;
	let running = true;
	let feed: MarketDataFeed | undefined;

	if (hasCredentials && config.venue.keyId && config.venue.secretKey) {
		const keyId = config.venue.keyId;
		const privateKey = privateKeyFromSecret(config.venue.secretKey);
		feed = new MarketDataFeed({
			wsBaseUrl: config.venue.apiBaseUrl.replace(/^http/, "ws"),
			slugs: universe.slugs,
			staleTimeoutMs: 60_000,
			recycleAfterMs: 0,
			logger,
			wsFactory: rawWebSocketFactory({
				// Signed per dial, exactly as the venue's SDK signs its own upgrade request.
				headersProvider: () => createAuthHeaders(keyId, privateKey, "GET", "/v1/ws/markets", Date.now()),
			}),
			onUpdate: (book) => {
				if (store.apply(book)) detector.onBookUpdate(book.slug);
			},
		});
		feed.start();
		logger.info("streaming over signed WebSocket", { shards: feed.shardCount });
	} else {
		logger.warn("credentials absent - polling REST inside the public budget instead of streaming", {
			hint: `set ${KEY_ID_ENV} and ${SECRET_KEY_ENV} for the signed WebSocket`,
			fullRefreshSeconds: universe.slugs.length,
		});
	}

	const metricsTimer = setInterval(() => {
		const stats = detector.stats();
		logger.info("scan metrics", {
			updates: store.updateCount,
			setsPriced: stats.setsPriced,
			staleSkips: stats.staleSkips,
			opportunities: stats.opportunities,
			bestNetPair: stats.bestNetPair,
			bestNetEvent: stats.bestNetEvent,
			...(feed ? { openShards: feed.stats().openShards, reconnects: feed.stats().reconnects } : {}),
		});
	}, config.observability.metricsIntervalMs);
	metricsTimer.unref?.();

	const stopped = new Promise<void>((resolve) => {
		const stop = (): void => {
			if (!running) return;
			running = false;
			resolve();
		};
		if (args.durationSec) {
			const timer = setTimeout(stop, args.durationSec * 1000);
			timer.unref?.();
		}
		process.on("SIGINT", stop);
		process.on("SIGTERM", stop);
	});

	if (feed) {
		await stopped;
	} else {
		// Round-robin refresh, paced EVENLY at the public budget rather than metered reactively:
		// a burst would spend the whole minute's budget at once and then stall inside the client's
		// meter for the rest of it - unstoppable mid-wait, and leaving every book stale between
		// bursts. One request a second keeps freshness flat and the stop prompt.
		const spacingMs = Math.ceil(60_000 / PUBLIC_REQUESTS_PER_MINUTE);
		while (running) {
			for (const slug of universe.slugs) {
				if (!running) break;
				try {
					const book = bookFromWire(await client.book(slug), Date.now());
					if (book && store.apply(book)) detector.onBookUpdate(slug);
				} catch (error) {
					logger.warn("poll failed", { slug, error: describe(error) });
				}
				await Promise.race([sleep(spacingMs), stopped]);
			}
		}
	}

	clearInterval(metricsTimer);
	feed?.stop();
	printScanSummary(startedAt, universe, store, detector, opportunities, opportunityCount);
	return 0;
}

function printScanSummary(
	startedAt: number,
	universe: Universe,
	store: BookStore,
	detector: Detector,
	opportunities: readonly Opportunity[],
	opportunityCount: number,
): void {
	const stats = detector.stats();
	out();
	out("scan summary");
	out(`  runtime          ${Math.round((Date.now() - startedAt) / 1000)}s`);
	out(
		`  events           ${universe.groups.length}${universe.skippedEvents.length > 0 ? ` (skipped ${universe.skippedEvents.length} over the market cap)` : ""}`,
	);
	out(`  markets          ${universe.slugs.length}`);
	out(`  book updates     ${store.updateCount}  (out-of-order rejects ${store.staleCount})`);
	out(`  sets priced      ${stats.setsPriced}  (stale skips ${stats.staleSkips})`);
	out(`  opportunities    ${stats.opportunities}`);
	out();
	out("                   net $/set   before fees   best net at");
	out(
		`  best pair        ${formatCell(stats.bestNetPair)}   ${formatCell(stats.bestGrossPair)}   ${formatTime(stats.bestNetPairAt)}`,
	);
	out(
		`  best event       ${formatCell(stats.bestNetEvent)}   ${formatCell(stats.bestGrossEvent)}   ${formatTime(stats.bestNetEventAt)}`,
	);
	out();
	const histogram = Object.entries(stats.histogram);
	if (histogram.length > 0) {
		out("  net edge per $1 set, all sets priced:");
		const widest = Math.max(...histogram.map(([, count]) => count));
		for (const [label, count] of histogram) {
			const bar = "#".repeat(Math.max(1, Math.round((count / widest) * 30)));
			out(`    ${label.padStart(14)}  ${String(count).padStart(8)}  ${bar}`);
		}
		out();
	}
	if (opportunityCount > 0) {
		const top = [...opportunities].sort((a, b) => decToNumber(b.netPerSet) - decToNumber(a.netPerSet)).slice(0, 10);
		out(`  top opportunities (of ${opportunityCount}):`);
		for (const opp of top) {
			out(
				`    ${formatTime(opp.observedAt)}  ${opp.kind.padEnd(5)} ${opp.key.padEnd(40)}` +
					` net ${formatDollars(decToNumber(opp.netPerSet))}` +
					` gross ${formatDollars(decToNumber(opp.grossPerSet))}  x${opp.maxSets} sets`,
			);
		}
		out();
	}
	out("  decision rule: watch BEFORE FEES. It is fee-independent, so it stays valid even if the");
	out("  configured rates are wrong. Negative means the venue is efficient; positive but under");
	out("  the fee hurdle means fees are the obstacle; above it, a real window existed at that");
	out("  timestamp. Event edges additionally require verified exhaustive, mutually exclusive");
	out("  outcomes - the API does not attest that.");
}

function formatCell(value: number | undefined): string {
	return value === undefined ? "        -" : formatDollars(value).padStart(9);
}

// --- doctor --------------------------------------------------------------------------------------

async function commandDoctor(args: ParsedArgs): Promise<number> {
	const { config, client, logger } = wire(args);
	let failures = 0;
	const pass = (name: string, detail: string): void => out(`  PASS  ${name.padEnd(22)} ${detail}`);
	const warn = (name: string, detail: string): void => out(`  WARN  ${name.padEnd(22)} ${detail}`);
	const fail = (name: string, detail: string): void => {
		failures++;
		out(`  FAIL  ${name.padEnd(22)} ${detail}`);
	};

	out("pi-pm-arb doctor (places no orders)");
	pass("config", args.configFile ? `loaded ${args.configFile}` : "built-in defaults");

	let probeSlug: string | undefined;
	try {
		const events = await client.events({ active: true });
		const universe = buildUniverse(events, config.universe.maxEvents, config.universe.maxMarkets);
		probeSlug = universe.slugs[0];
		pass("gateway", `${config.venue.gatewayBaseUrl} - ${events.length} events, universe of ${universe.slugs.length}`);
	} catch (error) {
		fail("gateway", `${config.venue.gatewayBaseUrl} - ${describe(error)}`);
	}

	if (probeSlug) {
		try {
			const book = bookFromWire(await client.book(probeSlug), Date.now());
			if (book) {
				pass(
					"order book",
					`${probeSlug} two-sided at ${decToNumber(book.bid).toFixed(2)}/${decToNumber(book.ask).toFixed(2)}`,
				);
			} else {
				warn("order book", `${probeSlug} has no two-sided book right now`);
			}
		} catch (error) {
			fail("order book", `${probeSlug} - ${describe(error)}`);
		}
	}

	if (!config.venue.keyId || !config.venue.secretKey) {
		warn("credentials", `${KEY_ID_ENV}/${SECRET_KEY_ENV} not set - signed checks skipped`);
		out(failures === 0 ? "\npublic checks passed" : "\nsome checks FAILED");
		return failures === 0 ? 0 : 1;
	}

	let signedOk = false;
	try {
		privateKeyFromSecret(config.venue.secretKey);
		pass(
			"key material",
			`key id ${config.venue.keyId.slice(0, 6)}..., secret fingerprint ${keyFingerprint(config.venue.secretKey)}`,
		);
	} catch (error) {
		fail("key material", describe(error));
	}

	try {
		const orders = await client.openOrders();
		signedOk = true;
		// A 401 here would have caught a bad key or local clock; acceptance proves both.
		pass("signed request", `open orders readable (${orders.length} open) - signature and clock accepted`);
	} catch (error) {
		fail(
			"signed request",
			`${describe(error)}${isStatus(error, 401) ? " - key not registered with the venue, or local clock skew" : ""}`,
		);
	}

	if (signedOk) {
		try {
			const positions = await client.positions();
			pass("positions", `${positions.length} positions readable`);
		} catch (error) {
			fail("positions", describe(error));
		}

		if (probeSlug) {
			await doctorPreview(client, config, probeSlug, { pass, warn, fail });
			await doctorWebSocket(config, probeSlug, logger, { pass, fail });
		} else {
			warn("order preview", "skipped - no market available to probe");
		}
	}

	out(failures === 0 ? "\nall checks passed" : "\nsome checks FAILED");
	return failures === 0 ? 0 : 1;
}

interface DoctorReport {
	pass(name: string, detail: string): void;
	warn?(name: string, detail: string): void;
	fail(name: string, detail: string): void;
}

/**
 * The free rehearsal rung: a preview validates a real order without placing it, and its response
 * carries the commission rates the venue would actually charge - the reconciliation that catches
 * a wrong fee config BEFORE any net-edge number is trusted, instead of after real fills.
 */
async function doctorPreview(
	client: PolymarketRestClient,
	config: PmArbConfig,
	slug: string,
	report: DoctorReport,
): Promise<void> {
	try {
		const preview = await client.previewOrder({
			marketSlug: slug,
			intent: "ORDER_INTENT_BUY_LONG",
			type: "ORDER_TYPE_LIMIT",
			// The venue's price floor at the minimum quantity: nothing cheaper can be described.
			price: { value: "0.01", currency: "USD" },
			quantity: 5,
			tif: "TIME_IN_FORCE_IMMEDIATE_OR_CANCEL",
		});
		report.pass("order preview", `${slug} BUY_LONG 5 @ 0.01 validated without placing`);

		const venueBps = preview.commissionsBasisPoints;
		if (venueBps === undefined) {
			report.warn?.("fee check", "venue did not report commissionsBasisPoints in the preview");
		} else {
			const configuredBps = Math.round(Number(config.fees.takerRate) * 10_000);
			if (Number(venueBps) === configuredBps) {
				report.pass("fee check", `venue reports ${venueBps}bps, matching fees.takerRate=${config.fees.takerRate}`);
			} else {
				report.fail(
					"fee check",
					`venue reports ${venueBps}bps but fees.takerRate=${config.fees.takerRate} (${configuredBps}bps)` +
						" - fix the config before trusting any net number",
				);
			}
			if (preview.makerCommissionsBasisPoints !== undefined) {
				report.pass("maker rebate", `venue reports ${preview.makerCommissionsBasisPoints}bps (negative = rebate)`);
			}
		}
	} catch (error) {
		if (error instanceof MissingCredentialsError) {
			report.fail("order preview", error.message);
		} else if (error instanceof PolymarketApiError && error.httpStatus < 500 && error.httpStatus !== 401) {
			// The signature was accepted and the venue answered about the ORDER - that is a working
			// trading path even when this particular probe is refused (e.g. market state, funding).
			report.warn?.("order preview", `venue refused the probe: ${error.message}`);
		} else {
			report.fail("order preview", describe(error));
		}
	}
}

async function doctorWebSocket(config: PmArbConfig, slug: string, logger: Logger, report: DoctorReport): Promise<void> {
	const keyId = config.venue.keyId;
	const secretKey = config.venue.secretKey;
	if (!keyId || !secretKey) return;
	const privateKey = privateKeyFromSecret(secretKey);
	const feed = new MarketDataFeed({
		wsBaseUrl: config.venue.apiBaseUrl.replace(/^http/, "ws"),
		slugs: [slug],
		staleTimeoutMs: 30_000,
		recycleAfterMs: 0,
		logger: logger.child({ component: "doctor-ws" }),
		wsFactory: rawWebSocketFactory({
			headersProvider: () => createAuthHeaders(keyId, privateKey, "GET", "/v1/ws/markets", Date.now()),
		}),
		onUpdate: () => {},
	});
	feed.start();
	try {
		const deadline = Date.now() + 8000;
		while (Date.now() < deadline) {
			const stats = feed.stats();
			if (stats.serverErrors > 0) {
				report.fail("websocket", `subscription refused for ${slug}`);
				return;
			}
			if (stats.messages > 0) {
				report.pass("websocket", `signed upgrade accepted, receiving market data for ${slug}`);
				return;
			}
			await sleep(100);
		}
		report.fail("websocket", "no message within 8s - upgrade rejected or feed silent");
	} finally {
		feed.stop();
	}
}

// --- config --------------------------------------------------------------------------------------

function commandConfig(args: ParsedArgs): number {
	const { config } = wire(args);
	const redacted = {
		...config,
		venue: {
			...config.venue,
			keyId: config.venue.keyId ? "(set)" : "(unset)",
			secretKey: config.venue.secretKey ? "(set)" : "(unset)",
		},
	};
	out(JSON.stringify(redacted, null, 2));
	return 0;
}

// --- entry ---------------------------------------------------------------------------------------

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isStatus(error: unknown, status: number): boolean {
	return error instanceof PolymarketApiError && error.httpStatus === status;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

async function main(): Promise<void> {
	let args: ParsedArgs;
	try {
		args = parseArgs(process.argv.slice(2));
	} catch (error) {
		process.stderr.write(`${describe(error)}\n\n${USAGE}`);
		process.exit(2);
	}
	if (args.help || !args.command) {
		out(USAGE);
		process.exit(args.help ? 0 : 2);
	}

	try {
		switch (args.command) {
			case "markets":
				process.exit(await commandMarkets(args));
				break;
			case "scan":
				process.exit(await commandScan(args));
				break;
			case "doctor":
				process.exit(await commandDoctor(args));
				break;
			case "config":
				process.exit(commandConfig(args));
				break;
			default:
				process.stderr.write(`unknown command: ${args.command}\n\n${USAGE}`);
				process.exit(2);
		}
	} catch (error) {
		process.stderr.write(`${describe(error)}\n`);
		process.exit(1);
	}
}

function isEntryPoint(): boolean {
	const entry = process.argv[1];
	if (!entry) return false;
	try {
		return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}

if (isEntryPoint()) void main();
