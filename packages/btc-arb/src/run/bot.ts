import { parseExchangeInfo } from "../binance/filters.js";
import { DEFAULT_LIMITS, limitsFromExchangeInfo, RateLimiter } from "../binance/rate-limiter.js";
import { BinanceApiError, BinanceRestClient, type FetchLike } from "../binance/rest-client.js";
import { MarketDataFeed, type WsFactory } from "../binance/ws-market-data.js";
import type { ArbConfig } from "../config.js";
import { findNegativeCycles } from "../core/bellman-ford.js";
import { BookStore, makeBook } from "../core/book.js";
import { CycleIndex, enumerateCycles } from "../core/cycles.js";
import { Detector } from "../core/detector.js";
import { MarketGraph, pruneDeadEnds, selectUniverse } from "../core/graph.js";
import { type FeeModel, makeFeeModel } from "../core/pricing.js";
import { Valuation } from "../core/valuation.js";
import type { ExecutionEngine } from "../exec/engine.js";
import { CycleExecutor } from "../exec/executor.js";
import { LiveEngine } from "../exec/live-engine.js";
import { PaperEngine } from "../exec/paper-engine.js";
import { Ledger } from "../obs/ledger.js";
import { Metrics } from "../obs/metrics.js";
import { TickRecorder } from "../obs/recorder.js";
import { RiskManager } from "../risk/limits.js";
import type { Asset, Cycle, CycleResult, MarketSymbol, Opportunity, SymbolRules } from "../types.js";
import { type Dec, decFromNumber, decFromString, decIsPositive, decMin, decToNumber, ZERO } from "../util/decimal.js";
import type { Logger } from "../util/logger.js";

export interface BotOptions {
	readonly config: ArbConfig;
	/** True only when every condition of the live gate was satisfied. */
	readonly liveAllowed: boolean;
	readonly logger: Logger;
	readonly wsFactory?: WsFactory;
	/** Injected transport, so the whole pipeline can be exercised without a network. */
	readonly fetchImpl?: FetchLike;
	readonly now?: () => number;
	/** Detect and report without ever placing an order, even in paper mode. */
	readonly scanOnly?: boolean;
}

export interface BotStatus {
	readonly mode: "paper" | "live";
	readonly symbols: number;
	readonly cycles: number;
	readonly maxFanout: number;
	readonly feed: ReturnType<MarketDataFeed["stats"]>;
	readonly detector: ReturnType<Detector["stats"]>;
	readonly risk: ReturnType<RiskManager["snapshot"]>;
	readonly ledger: ReturnType<Ledger["summary"]>;
	readonly metrics: Record<string, number>;
	readonly bookSymbols: number;
	readonly takerBps: number;
	readonly clockSkewMs: number;
}

/**
 * The whole system, wired together and supervised.
 *
 * Startup order matters and is not arbitrary: rules before universe, universe before cycles,
 * cycles before subscriptions, a REST snapshot before the stream, and no execution at all until
 * the book is populated and the clock is verified against the exchange.
 */
export class ArbBot {
	private readonly config: ArbConfig;
	private readonly logger: Logger;
	private readonly now: () => number;

	private readonly limiter: RateLimiter;
	private readonly client: BinanceRestClient;
	private readonly store: BookStore;
	private readonly metrics = new Metrics();
	private readonly ledger: Ledger;
	private readonly risk: RiskManager;

	private fee: FeeModel;
	private rules = new Map<MarketSymbol, SymbolRules>();
	private graph?: MarketGraph;
	private index?: CycleIndex;
	private detector?: Detector;
	private feed?: MarketDataFeed;
	private engine?: ExecutionEngine;
	private executor?: CycleExecutor;
	private valuation?: Valuation;
	private recorder?: TickRecorder;

	private balances = new Map<Asset, Dec>();
	private balancesRefreshedAt = 0;
	private inFlight = 0;
	private readonly activeCycles = new Set<string>();
	private readonly timers: ReturnType<typeof setInterval>[] = [];
	private running = false;
	private stopping = false;

	constructor(private readonly options: BotOptions) {
		this.config = options.config;
		this.logger = options.logger;
		this.now = options.now ?? Date.now;

		this.limiter = new RateLimiter({ limits: [...DEFAULT_LIMITS], safetyFactor: 0.7, now: this.now });
		this.client = new BinanceRestClient({
			baseUrl: this.config.binance.restBaseUrl,
			apiKey: this.config.binance.apiKey,
			apiSecret: this.config.binance.apiSecret,
			recvWindowMs: this.config.binance.recvWindowMs,
			timeoutMs: this.config.binance.requestTimeoutMs,
			limiter: this.limiter,
			logger: this.logger,
			fetchImpl: options.fetchImpl,
			now: this.now,
		});
		this.store = new BookStore(this.now);
		this.fee = makeFeeModel(this.config.fees.takerBps);
		this.ledger = new Ledger({
			file: this.config.observability.ledgerFile,
			accountingAsset: this.config.risk.accountingAsset,
			logger: this.logger,
			now: this.now,
		});
		this.risk = new RiskManager({ config: this.config.risk, logger: this.logger, now: this.now });
		this.risk.setMaxConcurrentCycles(this.config.execution.maxConcurrentCycles);
	}

	get riskManager(): RiskManager {
		return this.risk;
	}

	get bookStore(): BookStore {
		return this.store;
	}

	get restClient(): BinanceRestClient {
		return this.client;
	}

	async start(): Promise<void> {
		if (this.running) return;
		this.running = true;

		await this.syncClock();
		await this.loadMarkets();
		await this.resolveFees();
		this.buildEngine();
		await this.refreshBalances(true);
		await this.seedBooks();
		this.buildDetector();
		this.startFeed();
		this.startTimers();

		this.logger.info("bot started", {
			mode: this.engine?.mode,
			scanOnly: Boolean(this.options.scanOnly),
			symbols: this.index?.usedSymbols().length ?? 0,
			cycles: this.index?.size ?? 0,
			takerBps: this.fee.takerBps,
			minNetEdgeBps: this.config.detection.minNetEdgeBps,
		});
	}

	async stop(): Promise<void> {
		if (!this.running || this.stopping) return;
		this.stopping = true;
		for (const timer of this.timers) clearInterval(timer);
		this.timers.length = 0;
		this.feed?.stop();
		this.recorder?.flush();

		// Let anything already sent finish rather than abandoning a half-executed cycle. The
		// iteration cap is what actually bounds this: `now` is injectable, and a frozen clock would
		// otherwise spin here forever.
		const deadline = this.now() + this.config.execution.cycleDeadlineMs * 2;
		const maxWaits = Math.ceil((this.config.execution.cycleDeadlineMs * 2) / 50) + 1;
		for (let waited = 0; waited < maxWaits && this.inFlight > 0 && this.now() < deadline; waited++) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		if (this.inFlight > 0) {
			this.logger.error("stopped with cycles still in flight", { inFlight: this.inFlight });
		}
		this.running = false;
		this.logger.info("bot stopped", this.ledger.summary() as unknown as Record<string, unknown>);
	}

	private async syncClock(): Promise<void> {
		const offset = await this.client.syncClock();
		this.risk.setClockSkew(offset);
		this.metrics.gauge("clock_skew_ms", offset);
		if (Math.abs(offset) > this.config.risk.maxClockSkewMs) {
			this.logger.warn("clock skew exceeds the trading limit", {
				offsetMs: offset,
				limitMs: this.config.risk.maxClockSkewMs,
			});
		}
	}

	private async loadMarkets(): Promise<void> {
		const info = await this.client.exchangeInfo();
		if (Array.isArray(info.rateLimits) && info.rateLimits.length > 0) {
			const limits = limitsFromExchangeInfo(info.rateLimits);
			this.limiter.replaceLimits(limits);
			this.logger.debug("rate limits adopted from exchangeInfo", { limits });
		}

		const all = parseExchangeInfo(info);
		const { selected, rejected } = selectUniverse(all.values(), {
			quoteAssets: this.config.universe.quoteAssets,
			baseAssets: this.config.universe.baseAssets,
			excludeAssets: this.config.universe.excludeAssets,
			excludeSymbols: this.config.universe.excludeSymbols,
			maxSymbols: this.config.universe.maxSymbols,
		});
		const pruned = pruneDeadEnds(selected);

		this.graph = new MarketGraph(pruned);
		const cycles = enumerateCycles(this.graph, {
			startAssets: this.config.execution.startAssets,
			maxLength: this.config.detection.maxCycleLength,
			requireAsset: this.config.universe.requireAsset,
		});
		this.index = new CycleIndex(cycles);

		// Only markets that appear in a cycle are worth a stream slot.
		const used = new Set(this.index.usedSymbols());
		this.rules = new Map([...all].filter(([symbol]) => used.has(symbol)));
		this.valuation = new Valuation(this.store, this.graph, this.config.risk.accountingAsset);

		this.logger.info("markets loaded", {
			exchangeSymbols: all.size,
			selected: selected.length,
			afterPrune: pruned.length,
			subscribed: this.rules.size,
			cycles: cycles.length,
			maxFanout: this.index.maxFanout(),
			rejected: rejected.size,
		});

		if (cycles.length === 0) {
			throw new Error(
				"no arbitrage cycles exist in the configured universe; widen universe.quoteAssets or execution.startAssets",
			);
		}
	}

	private async resolveFees(): Promise<void> {
		if (!this.config.fees.autoDetect || !this.client.hasCredentials) {
			this.logger.info("using configured taker fee", { takerBps: this.fee.takerBps });
			return;
		}
		try {
			const account = await this.client.account();
			const taker = account.commissionRates?.taker;
			if (taker) {
				const rate = decFromString(taker);
				this.fee = makeFeeModel(decToNumber(rate) * 10_000);
			} else if (Number.isFinite(account.takerCommission)) {
				// Legacy field is already in basis points.
				this.fee = makeFeeModel(account.takerCommission);
			}
			this.logger.info("taker fee resolved from account", { takerBps: this.fee.takerBps });
		} catch (error) {
			this.logger.warn("could not read commission rates, using configured fee", {
				takerBps: this.fee.takerBps,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private buildEngine(): void {
		if (this.options.liveAllowed && this.config.mode === "live") {
			this.engine = new LiveEngine({
				client: this.client,
				logger: this.logger,
				now: this.now,
				balanceCacheMs: 2000,
			});
			this.logger.warn("LIVE MODE: orders will be placed with real funds");
		} else {
			this.engine = new PaperEngine({
				store: this.store,
				fee: this.fee,
				startingBalances: this.config.paper.startingBalances,
				latencyMs: this.config.paper.latencyMs,
				fillProbability: this.config.paper.fillProbability,
				adverseSelectionBps: this.config.paper.adverseSelectionBps,
				depthConsumptionRatio: this.config.paper.depthConsumptionRatio,
				seed: this.config.paper.seed,
				now: this.now,
			});
		}

		this.executor = new CycleExecutor({
			engine: this.engine,
			store: this.store,
			rules: this.rules,
			fee: this.fee,
			cycleDeadlineMs: this.config.execution.cycleDeadlineMs,
			aggressionTicks: this.config.execution.aggressionTicks,
			unwind: this.config.execution.unwind,
			maxBookAgeMs: this.config.detection.maxBookAgeMs,
			logger: this.logger,
			now: this.now,
		});
	}

	private async refreshBalances(force = false): Promise<void> {
		if (!this.engine) return;
		if (!force && this.now() - this.balancesRefreshedAt < 2000) return;
		try {
			this.balances = new Map(await this.engine.balances());
			this.balancesRefreshedAt = this.now();
		} catch (error) {
			this.logger.warn("balance refresh failed", { error: error instanceof Error ? error.message : String(error) });
		}
	}

	/**
	 * Seeds the book from a REST snapshot before the stream is live.
	 *
	 * Without it the first minute of a run silently detects nothing on illiquid markets, because a
	 * `bookTicker` stream only pushes on change and a quiet market may not change for a while.
	 */
	private async seedBooks(): Promise<void> {
		try {
			const tickers = await this.client.bookTickers();
			const at = this.now();
			let seeded = 0;
			for (const ticker of tickers) {
				if (!this.rules.has(ticker.symbol)) continue;
				const bid = decFromString(ticker.bidPrice);
				const ask = decFromString(ticker.askPrice);
				const bidQty = decFromString(ticker.bidQty);
				const askQty = decFromString(ticker.askQty);
				if (!decIsPositive(bid) || !decIsPositive(ask) || bid >= ask) continue;
				// updateId 0 marks a snapshot, so the first streamed frame always supersedes it.
				this.store.apply(makeBook(ticker.symbol, bid, bidQty, ask, askQty, 0, at));
				seeded++;
			}
			this.logger.info("book seeded from REST snapshot", { seeded, subscribed: this.rules.size });
		} catch (error) {
			this.logger.warn("could not seed books, waiting for the stream", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private buildDetector(): void {
		if (!this.index) throw new Error("cycle index not built");
		this.detector = new Detector({
			store: this.store,
			index: this.index,
			rules: this.rules,
			fee: this.fee,
			valuation: this.valuation,
			logger: this.logger,
			now: this.now,
			minNetEdgeBps: this.config.detection.minNetEdgeBps,
			screenMarginBps: this.config.detection.screenMarginBps,
			maxBookAgeMs: this.config.detection.maxBookAgeMs,
			depthUtilization: this.config.execution.depthUtilization,
			aggressionTicks: this.config.execution.aggressionTicks,
			requireNonNegativeWorstCase: this.config.execution.requireNonNegativeWorstCase,
			logEdgeBps: this.config.detection.logEdgeBps,
			inputBudget: (asset) => this.inputBudget(asset),
			onOpportunity: (opportunity, worstCaseBps) => this.handleOpportunity(opportunity, worstCaseBps),
		});
	}

	/** Spend cap for leg 1, bounded by both the configured notional and the balance we actually hold. */
	private inputBudget(startAsset: Asset): { max: Dec; min: Dec } | undefined {
		const balance = this.balances.get(startAsset) ?? ZERO;
		if (!decIsPositive(balance)) return undefined;

		const maxAccounting = decFromNumber(this.config.execution.maxNotionalPerCycle);
		const minAccounting = decFromNumber(this.config.execution.minNotionalPerCycle);
		const maxInAsset = this.valuation?.convertFrom(maxAccounting, startAsset);
		const minInAsset = this.valuation?.convertFrom(minAccounting, startAsset);
		if (maxInAsset === undefined || minInAsset === undefined) return undefined;

		const max = decMin(balance, maxInAsset);
		if (!decIsPositive(max)) return undefined;
		return { max, min: minInAsset };
	}

	private startFeed(): void {
		const symbols = [...this.rules.keys()];
		if (this.config.observability.recordFile) {
			this.recorder = new TickRecorder(this.config.observability.recordFile);
		}
		this.feed = new MarketDataFeed({
			wsBaseUrl: this.config.binance.wsBaseUrl,
			symbols,
			streamsPerConnection: this.config.binance.streamsPerConnection,
			staleTimeoutMs: 30_000,
			recycleAfterMs: 20 * 3_600_000,
			logger: this.logger,
			wsFactory: this.options.wsFactory,
			now: this.now,
			onUpdate: (book) => {
				if (!this.store.apply(book)) return;
				this.recorder?.record(book);
				this.metrics.increment("book_updates");
				this.detector?.onBookUpdate(book.symbol);
			},
		});
		this.feed.start();
	}

	private startTimers(): void {
		const add = (fn: () => void, intervalMs: number): void => {
			const timer = setInterval(fn, intervalMs);
			timer.unref?.();
			this.timers.push(timer);
		};

		add(
			() => {
				this.risk.checkKillSwitch();
				const healthy = this.feed?.healthy ?? false;
				this.risk.setDataHealthy(healthy);
				this.metrics.gauge("feed_healthy", healthy ? 1 : 0);
			},
			Math.max(250, this.config.risk.killSwitchPollMs),
		);

		add(() => {
			void this.refreshBalances();
		}, 5000);

		add(() => {
			void this.syncClock().catch((error) => {
				this.logger.warn("clock resync failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			});
		}, 300_000);

		if (this.config.detection.bellmanFordIntervalMs > 0) {
			add(() => this.sweep(), this.config.detection.bellmanFordIntervalMs);
		}

		if (this.config.observability.metricsIntervalMs > 0) {
			add(() => {
				this.recorder?.flush();
				this.logger.info("status", this.status() as unknown as Record<string, unknown>);
			}, this.config.observability.metricsIntervalMs);
		}
	}

	/**
	 * Background sweep for cycles the precomputed table does not contain.
	 *
	 * Anything found is fed back through the same sizing and risk path as a table hit; discovery
	 * being different does not make execution different.
	 */
	private sweep(): void {
		if (!this.graph || !this.detector) return;
		const found = findNegativeCycles(this.graph, this.store, this.fee, {
			now: this.now(),
			maxBookAgeMs: this.config.detection.maxBookAgeMs,
			maxLength: this.config.detection.maxCycleLength + 1,
			maxResults: 4,
			minEdgeBps: this.config.detection.minNetEdgeBps,
		});
		this.metrics.increment("sweeps");
		for (const negative of found) {
			if (!this.config.execution.startAssets.includes(negative.startAsset)) continue;
			const cycle: Cycle = {
				id: `${negative.startAsset}>${negative.legs.map((leg) => leg.toAsset).join(">")}`,
				startAsset: negative.startAsset,
				legs: negative.legs,
			};
			this.metrics.increment("sweep_hits");
			this.detector.evaluateDirect(cycle);
		}
	}

	private handleOpportunity(opportunity: Opportunity, worstCaseBps: number): void {
		this.metrics.increment("opportunities");
		this.metrics.observe("edge_bps", opportunity.netEdgeBps);

		if (this.options.scanOnly || !this.config.execution.enabled) {
			this.logger.info("opportunity (not executing)", {
				cycle: opportunity.cycle.id,
				netBps: round2(opportunity.netEdgeBps),
				worstBps: round2(worstCaseBps),
				notional: decToNumber(opportunity.notionalInAccountingAsset),
			});
			return;
		}

		// One cycle id at a time: a repeated signal on the same loop is the same opportunity.
		if (this.activeCycles.has(opportunity.cycle.id)) return;
		if (this.inFlight >= this.config.execution.maxConcurrentCycles) {
			this.metrics.increment("skipped_concurrency");
			return;
		}

		const decision = this.risk.canStartCycle(opportunity);
		if (!decision.allowed) {
			this.metrics.increment("skipped_risk");
			this.logger.debug("risk denied cycle", { cycle: opportunity.cycle.id, reason: decision.reason });
			return;
		}

		this.inFlight++;
		this.activeCycles.add(opportunity.cycle.id);
		this.risk.onCycleStart(opportunity);
		void this.runCycle(opportunity);
	}

	private async runCycle(opportunity: Opportunity): Promise<void> {
		// The caller has already reserved a concurrency slot and a risk slot, so every exit from
		// here must release both. An early return before the `finally` would leak a slot
		// permanently and silently stop the bot from ever trading again.
		let result: CycleResult | undefined;
		try {
			const executor = this.executor;
			if (!executor) throw new Error("executor not built");
			result = await executor.execute(opportunity);
		} catch (error) {
			this.risk.onError(error instanceof Error ? error.message : String(error));
			this.metrics.increment("cycle_errors");
			this.logger.error("cycle threw", {
				cycle: opportunity.cycle.id,
				error: error instanceof Error ? error.message : String(error),
			});
			if (error instanceof BinanceApiError && error.ambiguous) {
				// The order may have executed; refusing to keep trading is the only safe response.
				this.risk.halt("ambiguous order failure: manual reconciliation required");
			}
		} finally {
			this.inFlight = Math.max(0, this.inFlight - 1);
			this.activeCycles.delete(opportunity.cycle.id);
		}

		if (!result) {
			this.risk.releaseSlot();
			return;
		}

		const pnlAccounting = this.valuation?.convert(result.realizedPnl, result.realizedPnlAsset) ?? result.realizedPnl;
		this.risk.onCycleResult(result, pnlAccounting);
		this.ledger.record(result, pnlAccounting, opportunity.notionalInAccountingAsset);
		this.metrics.increment(`cycle_${result.outcome}`);
		this.metrics.observe("cycle_duration_ms", result.finishedAt - result.startedAt);
		for (const fill of result.fills) this.metrics.observe("order_latency_ms", fill.latencyMs);
		await this.refreshBalances(true);
	}

	status(): BotStatus {
		return {
			mode: this.engine?.mode ?? "paper",
			symbols: this.rules.size,
			cycles: this.index?.size ?? 0,
			maxFanout: this.index?.maxFanout() ?? 0,
			feed: this.feed?.stats() ?? {
				shards: 0,
				openShards: 0,
				messages: 0,
				reconnects: 0,
				parseErrors: 0,
				oldestMessageAgeMs: 0,
			},
			detector: this.detector?.stats() ?? {
				ticks: 0,
				cyclesScreened: 0,
				screenPasses: 0,
				planned: 0,
				rejected: 0,
				lastScreenPassAt: 0,
				rejectionsByReason: {},
			},
			risk: this.risk.snapshot(),
			ledger: this.ledger.summary(),
			metrics: this.metrics.snapshot(),
			bookSymbols: this.store.size,
			takerBps: this.fee.takerBps,
			clockSkewMs: this.client.clock.offset,
		};
	}
}

function round2(value: number): number {
	return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}
