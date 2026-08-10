#!/usr/bin/env node
import { createReadStream, realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { formatPrice, formatQty, maxCompliantQty, parseExchangeInfo, roundPriceDown } from "./binance/filters.js";
import { DEFAULT_LIMITS, RateLimiter } from "./binance/rate-limiter.js";
import { BinanceRestClient } from "./binance/rest-client.js";
import {
	type ArbConfig,
	ConfigError,
	DEFAULT_CONFIG,
	evaluateLiveGate,
	LIVE_CONFIRMATION_ENV,
	LIVE_CONFIRMATION_PHRASE,
	loadConfig,
} from "./config.js";
import { BookStore, makeBook } from "./core/book.js";
import { CycleIndex, enumerateCycles } from "./core/cycles.js";
import { Detector } from "./core/detector.js";
import { MarketGraph, pruneDeadEnds, selectUniverse } from "./core/graph.js";
import { makeFeeModel } from "./core/pricing.js";
import { Valuation } from "./core/valuation.js";
import { Dashboard } from "./obs/dashboard.js";
import { parseRecordedTick } from "./obs/recorder.js";
import { ArbBot } from "./run/bot.js";
import type { Cycle, MarketSymbol, SymbolRules } from "./types.js";
import {
	type Dec,
	decCeilToStep,
	decDivCeil,
	decFromNumber,
	decFromString,
	decIsPositive,
	decMul,
	decToNumber,
} from "./util/decimal.js";
import { Logger } from "./util/logger.js";

const USAGE = `pi-arb - Binance Spot triangular arbitrage scanner and execution engine

Usage:
  pi-arb <command> [options]

Commands:
  run          Detect and execute cycles. Paper trading unless --live is passed and the gate opens.
  scan         Detect and print opportunities. Never places an order, even with credentials present.
  symbols      Resolve the market universe and print the cycles that would be watched.
  doctor       Check connectivity, clock skew, credentials and filter handling. Places no orders.
  replay       Feed a recorded tick file through the detector and report what it would have done.
  config       Print the effective configuration, with secrets redacted.

Options:
  --config <path>     JSON config file. Keys not present fall back to the built-in defaults.
  --live              Required to place real orders. Also needs mode=live, credentials, and
                      ${LIVE_CONFIRMATION_ENV}=${LIVE_CONFIRMATION_PHRASE} in the environment.
  --testnet           Use the Binance Spot testnet hosts.
  --min-edge <bps>    Override detection.minNetEdgeBps.
  --max-notional <n>  Override execution.maxNotionalPerCycle, in the accounting asset.
  --duration <sec>    Stop after this many seconds. Default: run until interrupted.
  --file <path>       Tick recording to read (replay) or write (run/scan).
  --no-dashboard      Disable the live terminal view and log plainly instead.
  --log-level <lvl>   debug | info | warn | error
  -h, --help          Show this message.

Environment:
  BINANCE_API_KEY, BINANCE_API_SECRET   Credentials. Never put these in the config file.
  ${LIVE_CONFIRMATION_ENV}                     Must equal ${LIVE_CONFIRMATION_PHRASE} to trade live.

Create the API key without withdrawal permission and restrict it to your egress IP.
`;

interface ParsedArgs {
	readonly command: string;
	readonly configFile?: string;
	readonly live: boolean;
	readonly testnet: boolean;
	readonly minEdgeBps?: number;
	readonly maxNotional?: number;
	readonly durationSec?: number;
	readonly file?: string;
	readonly dashboard: boolean;
	readonly logLevel?: string;
	readonly help: boolean;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
	let command = "";
	let configFile: string | undefined;
	let live = false;
	let testnet = false;
	let minEdgeBps: number | undefined;
	let maxNotional: number | undefined;
	let durationSec: number | undefined;
	let file: string | undefined;
	let dashboard = true;
	let logLevel: string | undefined;
	let help = false;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = (): string => {
			const value = argv[++i];
			if (value === undefined) throw new ConfigError(`${arg} requires a value`);
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
			case "--live":
				live = true;
				break;
			case "--testnet":
				testnet = true;
				break;
			case "--min-edge":
				minEdgeBps = requireNumber(next(), "--min-edge");
				break;
			case "--max-notional":
				maxNotional = requireNumber(next(), "--max-notional");
				break;
			case "--duration":
				durationSec = requireNumber(next(), "--duration");
				break;
			case "--file":
				file = next();
				break;
			case "--no-dashboard":
				dashboard = false;
				break;
			case "--log-level":
				logLevel = next();
				break;
			default:
				if (arg.startsWith("-")) throw new ConfigError(`unknown option: ${arg}`);
				if (!command) command = arg;
				else throw new ConfigError(`unexpected argument: ${arg}`);
		}
	}

	return { command, configFile, live, testnet, minEdgeBps, maxNotional, durationSec, file, dashboard, logLevel, help };
}

function requireNumber(value: string, flag: string): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) throw new ConfigError(`${flag} expects a number, got ${JSON.stringify(value)}`);
	return parsed;
}

function buildConfig(args: ParsedArgs): ArbConfig {
	const overrides: Record<string, unknown> = {};
	if (args.testnet) overrides.binance = { testnet: true };
	if (args.minEdgeBps !== undefined) {
		overrides.detection = {
			minNetEdgeBps: args.minEdgeBps,
			// The screen must never sit above the threshold it screens for.
			screenMarginBps: Math.min(DEFAULT_CONFIG.detection.screenMarginBps, args.minEdgeBps),
		};
	}
	if (args.maxNotional !== undefined) overrides.execution = { maxNotionalPerCycle: args.maxNotional };
	if (args.file) overrides.observability = { recordFile: args.file };
	if (args.logLevel) {
		overrides.observability = { ...(overrides.observability as object), logLevel: args.logLevel };
	}
	if (!args.dashboard) {
		overrides.observability = { ...(overrides.observability as object), dashboard: false };
	}
	return loadConfig({ file: args.configFile, overrides });
}

function makeLogger(config: ArbConfig, useDashboard: boolean): Logger {
	return new Logger({
		level: config.observability.logLevel,
		file: config.observability.logFile,
		// The dashboard owns the screen; pretty console output would fight it for the cursor.
		pretty: !useDashboard,
	});
}

async function commandRun(args: ParsedArgs, scanOnly: boolean): Promise<number> {
	const config = buildConfig(args);
	const gate = evaluateLiveGate(config, process.env, args.live);
	const useDashboard = config.observability.dashboard && !scanOnly && process.stdout.isTTY === true;
	const logger = makeLogger(config, useDashboard);

	if (config.mode === "live" && !gate.allowed) {
		logger.warn("live mode requested but refused; running as paper instead", { reasons: gate.reasons });
	}
	if (gate.allowed && !scanOnly) {
		logger.warn("live trading enabled", {
			maxNotionalPerCycle: config.execution.maxNotionalPerCycle,
			maxDailyLoss: config.risk.maxDailyLoss,
			killSwitchFile: config.risk.killSwitchFile,
		});
	}

	const bot = new ArbBot({ config, liveAllowed: gate.allowed, logger, scanOnly });
	const dashboard = useDashboard ? new Dashboard() : undefined;

	let stopping = false;
	const shutdown = async (signal: string): Promise<void> => {
		if (stopping) return;
		stopping = true;
		logger.info("shutting down", { signal });
		await bot.stop();
		dashboard?.stop();
		printSummary(bot);
	};

	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));

	try {
		await bot.start();
	} catch (error) {
		logger.error("startup failed", { error: error instanceof Error ? error.message : String(error) });
		dashboard?.stop();
		return 1;
	}

	dashboard?.start();
	const renderTimer = dashboard ? setInterval(() => dashboard.render(bot.status()), 500) : undefined;
	renderTimer?.unref?.();

	const durationSec = args.durationSec;
	if (durationSec !== undefined) {
		await new Promise((resolve) => setTimeout(resolve, durationSec * 1000));
		if (renderTimer) clearInterval(renderTimer);
		await shutdown("duration elapsed");
		return 0;
	}

	// Idle forever; the signal handlers own the exit path.
	await new Promise<void>(() => {});
	return 0;
}

function printSummary(bot: ArbBot): void {
	const status = bot.status();
	const summary = status.ledger;
	const lines = [
		"",
		`mode              ${status.mode}`,
		`cycles attempted  ${summary.cycles}`,
		`cycles completed  ${summary.completed}`,
		`realised PnL      ${summary.realizedPnl.toFixed(8)}`,
		`slippage vs model ${summary.totalSlippage.toFixed(8)} (${summary.avgSlippageBps.toFixed(2)}bps avg)`,
		`opportunities     ${status.detector.planned} planned, ${status.detector.rejected} rejected`,
		`book updates      ${status.metrics.book_updates ?? 0}`,
		"",
	];
	process.stdout.write(`${lines.join("\n")}\n`);
}

/** Resolves the universe and cycle table without opening a stream. */
async function commandSymbols(args: ParsedArgs): Promise<number> {
	const config = buildConfig(args);
	const logger = makeLogger(config, false);
	const client = makeClient(config, logger);

	const info = await client.exchangeInfo();
	const all = parseExchangeInfo(info);
	const { selected, rejected } = selectUniverse(all.values(), {
		quoteAssets: config.universe.quoteAssets,
		baseAssets: config.universe.baseAssets,
		excludeAssets: config.universe.excludeAssets,
		excludeSymbols: config.universe.excludeSymbols,
		maxSymbols: config.universe.maxSymbols,
	});
	const pruned = pruneDeadEnds(selected);
	const graph = new MarketGraph(pruned);
	const cycles = enumerateCycles(graph, {
		startAssets: config.execution.startAssets,
		maxLength: config.detection.maxCycleLength,
		requireAsset: config.universe.requireAsset,
	});
	const index = new CycleIndex(cycles);

	const out = process.stdout;
	out.write(`exchange symbols   ${all.size}\n`);
	out.write(`selected           ${selected.length} (rejected ${rejected.size})\n`);
	out.write(`after dead-end prune ${pruned.length}\n`);
	out.write(`assets             ${graph.assets.length}\n`);
	out.write(`cycles             ${cycles.length}\n`);
	out.write(`subscribed markets ${index.usedSymbols().length}\n`);
	out.write(`max fanout         ${index.maxFanout()} cycles re-priced per tick, worst case\n\n`);
	// Price the lot grid. Dust is a fixed cost per cycle, so the notional it needs to disappear
	// under is the single most useful number here - and it is knowable before funding anything.
	const store = new BookStore();
	try {
		const at = Date.now();
		for (const ticker of await client.bookTickers()) {
			if (!all.has(ticker.symbol)) continue;
			const bid = decFromString(ticker.bidPrice);
			const ask = decFromString(ticker.askPrice);
			if (!decIsPositive(bid) || !decIsPositive(ask) || bid >= ask) continue;
			store.apply(
				makeBook(ticker.symbol, bid, decFromString(ticker.bidQty), ask, decFromString(ticker.askQty), 0, at),
			);
		}
	} catch {
		// Prices are a nicety here; the cycle table is still worth printing without them.
	}
	const valuation = new Valuation(store, graph, config.risk.accountingAsset);
	const unit = config.risk.accountingAsset;
	const edge = config.detection.minNetEdgeBps;

	out.write(`  ${"cycle".padEnd(32)} ${"legs".padEnd(44)} ${"dust".padStart(9)}  ${"needs".padStart(10)}\n`);
	for (const cycle of cycles.slice(0, 40)) {
		const legs = cycle.legs.map((l) => `${l.side} ${l.symbol}`).join(" -> ");
		const dust = expectedDust(cycle, all, store, valuation);
		const needs = dust === undefined || edge <= 0 ? undefined : (dust * 10_000) / edge;
		out.write(
			`  ${cycle.id.padEnd(32)} ${legs.padEnd(44)} ${(dust === undefined ? "-" : dust.toFixed(4)).padStart(9)}  ${(needs === undefined ? "-" : Math.ceil(needs).toLocaleString()).padStart(10)}\n`,
		);
	}
	if (cycles.length > 40) out.write(`  ... and ${cycles.length - 40} more\n`);
	out.write(
		`\n  dust  = ${unit} left behind per cycle, on average, because each leg's output rounds down to the\n` +
			`          next symbol's lot step. It stays in the account but cannot be sold: it is below minQty.\n` +
			`  needs = notional per cycle at which that dust equals your ${edge}bps edge threshold. Below it,\n` +
			`          the lot grid costs more than the cycle is being asked to earn.\n`,
	);
	return 0;
}

/**
 * Average value left stranded in the intermediate assets of one cycle.
 *
 * Each leg's output is spent by the next leg, whose quantity rounds down to its own `stepSize`, so
 * the remainder is bounded by one step of the *consuming* symbol - measured in the asset being
 * spent, which is why a BUY leg's bound is scaled by its price. Half a step is the expected value.
 */
export function expectedDust(
	cycle: Cycle,
	rules: ReadonlyMap<MarketSymbol, SymbolRules>,
	store: BookStore,
	valuation: Valuation,
): number | undefined {
	let total = 0;
	for (let index = 0; index + 1 < cycle.legs.length; index++) {
		const next = cycle.legs[index + 1];
		const rule = rules.get(next.symbol);
		const book = store.get(next.symbol);
		if (!rule || !book) return undefined;
		// A BUY spends the quote asset, so a step of base quantity is a step-times-price of it.
		const perStep = next.side === "BUY" ? decMul(rule.stepSize, book.ask) : rule.stepSize;
		const value = valuation.convert(perStep, cycle.legs[index].toAsset);
		if (value === undefined) return undefined;
		total += decToNumber(value) / 2;
	}
	return total;
}

/** Read-only preflight. Places no orders and needs no credentials for the public checks. */
async function commandDoctor(args: ParsedArgs): Promise<number> {
	const config = buildConfig(args);
	const logger = makeLogger(config, false);
	const client = makeClient(config, logger);
	const out = process.stdout;
	let failures = 0;

	const check = async (name: string, fn: () => Promise<string>): Promise<void> => {
		try {
			const detail = await fn();
			out.write(`  ok    ${name.padEnd(28)} ${detail}\n`);
		} catch (error) {
			failures++;
			out.write(`  FAIL  ${name.padEnd(28)} ${error instanceof Error ? error.message : String(error)}\n`);
		}
	};

	out.write(`endpoint ${config.binance.restBaseUrl}\n\n`);
	await check("connectivity", async () => {
		await client.ping();
		return "reachable";
	});
	await check("clock skew", async () => {
		const offset = await client.syncClock();
		const verdict = Math.abs(offset) > config.risk.maxClockSkewMs ? "OVER LIMIT" : "within limit";
		return `${offset}ms (${verdict}, round trip ${client.clock.roundTripMs}ms)`;
	});
	await check("exchange info", async () => {
		const info = await client.exchangeInfo();
		const rules = parseExchangeInfo(info);
		return `${rules.size} tradable spot markets`;
	});
	await check("filter handling", async () => {
		const info = await client.exchangeInfo(["BTCUSDT"]);
		const rules = parseExchangeInfo(info).get("BTCUSDT");
		if (!rules) throw new Error("BTCUSDT not present in exchangeInfo");
		return `BTCUSDT tick ${rules.pricePrecision}dp, lot ${rules.qtyPrecision}dp, minNotional ${decToNumber(rules.minNotional)}`;
	});

	if (client.hasCredentials) {
		await check("credentials", async () => {
			const account = await client.account();
			const taker = account.commissionRates?.taker ?? String(account.takerCommission / 10_000);
			const withdrawal = account.canWithdraw ? "ENABLED (reduce this key's permissions)" : "disabled";
			return `canTrade=${account.canTrade}, taker=${taker}, withdrawals ${withdrawal}`;
		});
		// The signed *order* path is the one that has never run until the first real order, and it
		// is the one that costs money to get wrong. `POST /api/v3/order/test` runs a real order
		// through every filter and the full signature check and places nothing, so it can be proven
		// for free - which matters most on a venue with no testnet.
		await check("order validation (places nothing)", async () => {
			const info = await client.exchangeInfo();
			const rules = parseExchangeInfo(info);
			const { selected } = selectUniverse(rules.values(), {
				quoteAssets: config.universe.quoteAssets,
				baseAssets: config.universe.baseAssets,
				excludeAssets: config.universe.excludeAssets,
				excludeSymbols: config.universe.excludeSymbols,
				maxSymbols: config.universe.maxSymbols,
			});
			const target = selected.find((rule) => config.execution.startAssets.includes(rule.quoteAsset));
			if (!target) throw new Error("no market in the universe is quoted in a configured start asset");

			const book = (await client.bookTickers()).find((ticker) => ticker.symbol === target.symbol);
			if (!book) throw new Error(`no book for ${target.symbol}`);

			// Deliberately far below the touch: a BUY that cannot cross is still validated against
			// every filter, and cannot fill even if something later placed it by mistake.
			const price = roundPriceDown(target, decMul(decFromString(book.bidPrice), decFromString("0.7")));
			// `minNotionalPerCycle` is money, not quantity: a real leg-1 order is the smallest the
			// bot would ever send, which is the interesting case for a minimum-notional filter.
			const notional = decFromNumber(config.execution.minNotionalPerCycle);
			// Round the lot *up*, so the probe is genuinely at or above the configured minimum rather
			// than a step below it - a NOTIONAL filter is exactly what this is meant to exercise.
			const wanted = decCeilToStep(decDivCeil(notional, price), target.stepSize);
			const quantity = maxCompliantQty(target, price, wanted);
			if (!decIsPositive(quantity)) {
				throw new Error(
					`execution.minNotionalPerCycle (${config.execution.minNotionalPerCycle}) is below ${target.symbol}'s own minimum of ${decToNumber(target.minNotional)}`,
				);
			}

			await client.testOrder({
				symbol: target.symbol,
				side: "BUY",
				type: "LIMIT",
				timeInForce: "IOC",
				quantity: formatQty(target, quantity),
				price: formatPrice(target, price),
			});
			return `${target.symbol} BUY ${formatQty(target, quantity)} @ ${formatPrice(target, price)} accepted by the exchange`;
		});
	} else {
		out.write(`  skip  ${"credentials".padEnd(28)} BINANCE_API_KEY / BINANCE_API_SECRET not set\n`);
		out.write(`  skip  ${"order validation".padEnd(28)} needs credentials; places nothing when it runs\n`);
	}

	const gate = evaluateLiveGate(config, process.env, args.live);
	out.write(`\nlive gate: ${gate.allowed ? "OPEN" : "closed"}\n`);
	for (const reason of gate.reasons) out.write(`  - ${reason}\n`);
	return failures === 0 ? 0 : 1;
}

/**
 * Replays a recorded tick file through the detector.
 *
 * Detection is exact here - the same code path a live run uses. Execution is not replayed, because
 * a recording contains no counterfactual: it cannot say whether the quote would still have been
 * there once an order arrived. Treat the output as an upper bound on opportunity count.
 */
async function commandReplay(args: ParsedArgs): Promise<number> {
	if (!args.file) throw new ConfigError("replay requires --file <recording.jsonl>");
	const config = buildConfig(args);
	const logger = makeLogger(config, false);
	const client = makeClient(config, logger);

	const info = await client.exchangeInfo();
	const all = parseExchangeInfo(info);
	const { selected } = selectUniverse(all.values(), {
		quoteAssets: config.universe.quoteAssets,
		baseAssets: config.universe.baseAssets,
		excludeAssets: config.universe.excludeAssets,
		excludeSymbols: config.universe.excludeSymbols,
		maxSymbols: config.universe.maxSymbols,
	});
	const graph = new MarketGraph(pruneDeadEnds(selected));
	const index = new CycleIndex(
		enumerateCycles(graph, {
			startAssets: config.execution.startAssets,
			maxLength: config.detection.maxCycleLength,
			requireAsset: config.universe.requireAsset,
		}),
	);

	// The recording carries its own timestamps; the detector's freshness checks follow them.
	let virtualNow = 0;
	const store = new BookStore(() => virtualNow);
	const budget: Dec = decFromNumber(config.execution.maxNotionalPerCycle);
	const minBudget: Dec = decFromNumber(config.execution.minNotionalPerCycle);

	let opportunities = 0;
	let totalEdge = 0;
	let bestEdge = 0;
	let bestCycle = "";

	const detector = new Detector({
		store,
		index,
		rules: all,
		fee: makeFeeModel(config.fees.takerBps),
		logger,
		now: () => virtualNow,
		minNetEdgeBps: config.detection.minNetEdgeBps,
		screenMarginBps: config.detection.screenMarginBps,
		maxBookAgeMs: config.detection.maxBookAgeMs,
		depthUtilization: config.execution.depthUtilization,
		aggressionTicks: config.execution.aggressionTicks,
		requireNonNegativeWorstCase: config.execution.requireNonNegativeWorstCase,
		logEdgeBps: config.detection.logEdgeBps,
		inputBudget: (asset) => (asset === config.risk.accountingAsset ? { max: budget, min: minBudget } : undefined),
		onOpportunity: (opportunity) => {
			opportunities++;
			totalEdge += opportunity.netEdgeBps;
			if (opportunity.netEdgeBps > bestEdge) {
				bestEdge = opportunity.netEdgeBps;
				bestCycle = opportunity.cycle.id;
			}
		},
	});

	let ticks = 0;
	let skipped = 0;
	const reader = createInterface({ input: createReadStream(args.file), crlfDelay: Number.POSITIVE_INFINITY });
	for await (const line of reader) {
		const tick = parseRecordedTick(line);
		if (!tick) {
			skipped++;
			continue;
		}
		const bid = decFromString(tick.b);
		const ask = decFromString(tick.a);
		if (!decIsPositive(bid) || !decIsPositive(ask) || bid >= ask) {
			skipped++;
			continue;
		}
		virtualNow = tick.t || virtualNow + 1;
		if (!store.apply(makeBook(tick.s, bid, decFromString(tick.B), ask, decFromString(tick.A), tick.u, virtualNow))) {
			continue;
		}
		ticks++;
		detector.onBookUpdate(tick.s);
	}

	const stats = detector.stats();
	const out = process.stdout;
	out.write(`\nreplayed          ${ticks} ticks (${skipped} skipped)\n`);
	out.write(`cycles watched    ${index.size}\n`);
	out.write(`screen passes     ${stats.screenPasses}\n`);
	out.write(`opportunities     ${opportunities}\n`);
	out.write(`rejected          ${stats.rejected}\n`);
	if (opportunities > 0) {
		out.write(`average edge      ${(totalEdge / opportunities).toFixed(2)}bps\n`);
		out.write(`best              ${bestEdge.toFixed(2)}bps on ${bestCycle}\n`);
	}
	const reasons = Object.entries(stats.rejectionsByReason).sort((a, b) => b[1] - a[1]);
	if (reasons.length > 0) {
		out.write("\nrejection reasons\n");
		for (const [reason, count] of reasons.slice(0, 10)) out.write(`  ${String(count).padStart(8)}  ${reason}\n`);
	}
	out.write("\nThis counts detections, not fills. A live run will fill far fewer.\n");
	return 0;
}

function commandConfig(args: ParsedArgs): number {
	const config = buildConfig(args);
	const redacted = {
		...config,
		binance: {
			...config.binance,
			apiKey: config.binance.apiKey ? "<set>" : undefined,
			apiSecret: config.binance.apiSecret ? "<set>" : undefined,
		},
	};
	process.stdout.write(`${JSON.stringify(redacted, null, 2)}\n`);
	return 0;
}

function makeClient(config: ArbConfig, logger: Logger): BinanceRestClient {
	return new BinanceRestClient({
		baseUrl: config.binance.restBaseUrl,
		apiKey: config.binance.apiKey,
		apiSecret: config.binance.apiSecret,
		recvWindowMs: config.binance.recvWindowMs,
		timeoutMs: config.binance.requestTimeoutMs,
		orderTimeoutMs: config.binance.orderTimeoutMs,
		limiter: new RateLimiter({ limits: [...DEFAULT_LIMITS], safetyFactor: 0.7 }),
		logger,
	});
}

export async function main(argv: readonly string[]): Promise<number> {
	let args: ParsedArgs;
	try {
		args = parseArgs(argv);
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
		return 2;
	}

	if (args.help || !args.command) {
		process.stdout.write(USAGE);
		return args.command ? 0 : 2;
	}

	try {
		switch (args.command) {
			case "run":
				return await commandRun(args, false);
			case "scan":
				return await commandRun(args, true);
			case "symbols":
				return await commandSymbols(args);
			case "doctor":
				return await commandDoctor(args);
			case "replay":
				return await commandReplay(args);
			case "config":
				return commandConfig(args);
			default:
				process.stderr.write(`unknown command: ${args.command}\n\n${USAGE}`);
				return 2;
		}
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}

/**
 * True only when this file is the process entry point.
 *
 * Compared by resolved real path rather than by name: a test runner's own entry point is often
 * also called `cli.js`, and a substring check would auto-run the whole bot inside the test suite.
 * Symlinks are resolved on both sides so a `node_modules/.bin` shim still matches.
 */
function isEntryPoint(): boolean {
	const entry = process.argv[1];
	if (!entry) return false;
	try {
		return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}

if (isEntryPoint()) {
	main(process.argv.slice(2))
		.then((code) => {
			if (code !== 0) process.exitCode = code;
		})
		.catch((error) => {
			process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
			process.exitCode = 1;
		});
}
