import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import {
	type Dec,
	decAdd,
	decDiv,
	decFromString,
	decGte,
	decIsPositive,
	decLt,
	decLte,
	decMin,
	decMul,
	decSub,
	decToFixed,
	decToString,
	ZERO,
} from "../src/util/decimal.js";

/**
 * A Binance Spot server that speaks the real wire protocol over a real socket.
 *
 * The rest of the suite stubs `fetch` and the WebSocket, which proves the logic but leaves the two
 * boundaries that actually face the exchange untested: query-string signing as bytes on the wire,
 * and RFC 6455 framing. Both are places where a bug is invisible until the first live order.
 *
 * So this is deliberately a *checking* fake, not a permissive one. It verifies the HMAC over the
 * exact bytes it received, enforces `recvWindow`, keeps real balances, and refuses anything the
 * exchange would refuse. A test passing against it means the request would have been accepted by
 * Binance - not merely that our own parser was happy with our own output.
 */

export interface FakeQuote {
	bid: string;
	bidQty: string;
	ask: string;
	askQty: string;
}

export interface RecordedOrder {
	readonly symbol: string;
	readonly side: string;
	readonly type: string;
	readonly timeInForce?: string;
	readonly price: string;
	readonly quantity: string;
	readonly clientOrderId: string;
	readonly status: string;
	readonly executedQty: string;
	/** True when the signature over the received bytes verified against the shared secret. */
	readonly signatureValid: boolean;
}

export interface OrderFailure {
	readonly status: number;
	readonly code: number;
	readonly msg: string;
	/**
	 * Match and fill the order anyway, then answer with the error.
	 *
	 * This is the genuinely dangerous shape of an ambiguous failure: the reply was lost, but the
	 * order is on the book. The caller can only find out by asking.
	 */
	readonly place?: boolean;
}

export interface FakeBinanceOptions {
	readonly apiKey?: string;
	readonly apiSecret?: string;
	readonly quotes?: Record<string, FakeQuote>;
	readonly balances?: Record<string, string>;
	/** Taker fee charged on every fill, in basis points. */
	readonly takerBps?: number;
}

interface SymbolSpec {
	readonly symbol: string;
	readonly base: string;
	readonly quote: string;
	readonly tick: string;
	readonly step: string;
	readonly minNotional: string;
}

const SYMBOLS: readonly SymbolSpec[] = [
	{ symbol: "BTCUSDT", base: "BTC", quote: "USDT", tick: "0.01", step: "0.00001", minNotional: "5" },
	{ symbol: "ETHBTC", base: "ETH", quote: "BTC", tick: "0.000001", step: "0.0001", minNotional: "0.0001" },
	{ symbol: "ETHUSDT", base: "ETH", quote: "USDT", tick: "0.01", step: "0.0001", minNotional: "5" },
	// No way out except reversing the same trade, so the universe builder must prune it.
	{ symbol: "XYZUSDT", base: "XYZ", quote: "USDT", tick: "0.01", step: "0.001", minNotional: "5" },
];

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

interface StoredOrder {
	readonly orderId: number;
	readonly clientOrderId: string;
	readonly symbol: string;
	readonly side: string;
	readonly price: string;
	readonly origQty: string;
	executedQty: string;
	cummulativeQuoteQty: string;
	status: string;
}

interface Shard {
	readonly socket: Duplex;
	readonly streams: Set<string>;
}

export class FakeBinance {
	private server?: Server;
	private readonly shards = new Set<Shard>();
	private readonly quotes = new Map<string, FakeQuote>();
	private readonly balances = new Map<string, Dec>();
	private readonly orders = new Map<string, StoredOrder>();
	private readonly takerFee: Dec;
	private nextOrderId = 1000;
	private updateId = 1;
	private usedWeight = 0;
	private pinnedWeight = false;
	/**
	 * Placement times, so the count headers can be windowed the way the exchange's are.
	 *
	 * Reporting a cumulative total instead is not a harmless simplification: the client adopts these
	 * counters as the authority on its remaining budget, so a number that only ever grows drives the
	 * limiter into a permanent block after a few dozen orders and every later cycle fails on a
	 * timeout that looks exactly like a bot bug.
	 */
	private readonly orderTimes: number[] = [];
	private pendingFailures: { remaining: number; failure: OrderFailure } | undefined;

	/** Every order placement attempt, including ones the fake refused. */
	readonly placements: RecordedOrder[] = [];
	/** Paths that reached the server, in order, for asserting the startup sequence. */
	readonly paths: string[] = [];
	/** Requests whose signature did not verify against the shared secret. */
	signatureFailures = 0;

	readonly apiKey: string;
	readonly apiSecret: string;

	constructor(options: FakeBinanceOptions = {}) {
		this.apiKey = options.apiKey ?? "test-api-key";
		this.apiSecret = options.apiSecret ?? "test-api-secret-0123456789";
		this.takerFee = decDiv(decFromString(String(options.takerBps ?? 10)), decFromString("10000"));
		for (const [symbol, quote] of Object.entries(options.quotes ?? {})) this.quotes.set(symbol, { ...quote });
		for (const [asset, amount] of Object.entries(options.balances ?? { USDT: "5000" })) {
			this.balances.set(asset, decFromString(amount));
		}
	}

	/** Binds to an ephemeral port by default; tests run concurrently and must not collide. */
	async start(port = 0): Promise<{ restBaseUrl: string; wsBaseUrl: string }> {
		const server = createServer((req, res) => this.handleHttp(req, res));
		server.on("upgrade", (req, socket) => this.handleUpgrade(req, socket as Duplex));
		this.server = server;
		await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
		const bound = (server.address() as AddressInfo).port;
		return { restBaseUrl: `http://127.0.0.1:${bound}`, wsBaseUrl: `ws://127.0.0.1:${bound}` };
	}

	async stop(): Promise<void> {
		for (const shard of this.shards) shard.socket.destroy();
		this.shards.clear();
		const server = this.server;
		if (!server) return;
		this.server = undefined;
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	get openConnections(): number {
		return this.shards.size;
	}

	balanceOf(asset: string): Dec {
		return this.balances.get(asset) ?? ZERO;
	}

	/**
	 * Reports this used weight from here on, regardless of what we asked for.
	 *
	 * Not artificial: the weight budget is per IP and per account, so anything else sharing the key
	 * - a second bot, a dashboard, a person clicking around - consumes it too. The header is the
	 * only authority on what is left, which is exactly why the client must follow it upward.
	 */
	reportUsedWeight(used: number): void {
		this.usedWeight = used;
		this.pinnedWeight = true;
	}

	/** Refuse the next `count` order placements with the given envelope, without placing them. */
	failNextOrders(count: number, failure: OrderFailure): void {
		this.pendingFailures = { remaining: count, failure };
	}

	/** Updates a book and pushes it to every connected shard subscribed to that stream. */
	publish(symbol: string, quote: FakeQuote): void {
		this.quotes.set(symbol, { ...quote });
		const stream = `${symbol.toLowerCase()}@bookTicker`;
		const frame = encodeTextFrame(
			JSON.stringify({
				stream,
				data: {
					u: this.updateId++,
					s: symbol,
					b: quote.bid,
					B: quote.bidQty,
					a: quote.ask,
					A: quote.askQty,
				},
			}),
		);
		for (const shard of this.shards) {
			if (shard.streams.has(stream)) shard.socket.write(frame);
		}
	}

	publishAll(quotes: Record<string, FakeQuote>): void {
		for (const [symbol, quote] of Object.entries(quotes)) this.publish(symbol, quote);
	}

	/** Announces a shutdown the way Binance does, so the reconnect path can be driven. */
	announceShutdown(): void {
		const frame = encodeTextFrame(JSON.stringify({ stream: "!serverShutdown", data: { e: "serverShutdown" } }));
		for (const shard of this.shards) shard.socket.write(frame);
	}

	// --- WebSocket -------------------------------------------------------------------------------

	private handleUpgrade(req: IncomingMessage, socket: Duplex): void {
		const key = req.headers["sec-websocket-key"];
		const url = new URL(req.url ?? "/", "http://localhost");
		if (typeof key !== "string" || url.pathname !== "/stream") {
			socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
			return;
		}

		const accept = createHash("sha1")
			.update(key + WS_GUID)
			.digest("base64");
		socket.write(
			"HTTP/1.1 101 Switching Protocols\r\n" +
				"Upgrade: websocket\r\n" +
				"Connection: Upgrade\r\n" +
				`Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
		);

		const streams = new Set((url.searchParams.get("streams") ?? "").split("/").filter(Boolean));
		const shard: Shard = { socket, streams };
		this.shards.add(shard);

		// Only enough of the client->server direction to answer pings and honour a close; the bot
		// never sends anything else, because subscriptions travel in the URL.
		let buffered = Buffer.alloc(0);
		socket.on("data", (chunk: Buffer) => {
			buffered = Buffer.concat([buffered, chunk]);
			for (;;) {
				const frame = decodeFrame(buffered);
				if (!frame) return;
				buffered = buffered.subarray(frame.consumed);
				if (frame.opcode === 0x8) {
					this.shards.delete(shard);
					socket.end();
					return;
				}
				if (frame.opcode === 0x9) socket.write(encodeFrame(0xa, frame.payload));
			}
		});
		const drop = (): void => {
			this.shards.delete(shard);
		};
		socket.on("close", drop);
		socket.on("error", drop);
	}

	// --- REST ------------------------------------------------------------------------------------

	private handleHttp(req: IncomingMessage, res: ServerResponse): void {
		const raw = req.url ?? "/";
		const questionMark = raw.indexOf("?");
		const path = questionMark === -1 ? raw : raw.slice(0, questionMark);
		const rawQuery = questionMark === -1 ? "" : raw.slice(questionMark + 1);
		this.paths.push(path);

		// Bodies are always empty: this client puts every parameter in the query string. Draining is
		// still required or the socket will not be reusable.
		req.resume();

		const params = new URLSearchParams(rawQuery);
		const method = req.method ?? "GET";

		try {
			switch (`${method} ${path}`) {
				case "GET /api/v3/ping": {
					this.ok(res, {});
					break;
				}
				case "GET /api/v3/time": {
					this.ok(res, { serverTime: Date.now() });
					break;
				}
				case "GET /api/v3/exchangeInfo": {
					this.ok(res, this.exchangeInfo());
					break;
				}
				case "GET /api/v3/ticker/bookTicker": {
					this.ok(res, this.bookTickers());
					break;
				}
				case "GET /api/v3/account": {
					if (!this.authorize(req, rawQuery, res)) break;
					// Binance.US rejects anything beyond timestamp, recvWindow and signature here, and
					// this endpoint is the only source of balances - so a parameter the other venue
					// happily ignores stops the bot funding any cycle at all. Strict on purpose.
					const extra = [...params.keys()].filter(
						(key) => key !== "timestamp" && key !== "recvWindow" && key !== "signature",
					);
					if (extra.length > 0) {
						this.fail(res, 400, -1101, `Too many parameters; expected '3' and received '${params.size}'.`);
						break;
					}
					this.ok(res, this.account());
					break;
				}
				case "GET /api/v3/account/commission": {
					if (this.authorize(req, rawQuery, res)) this.ok(res, this.commission(params.get("symbol") ?? ""));
					break;
				}
				case "POST /api/v3/order": {
					if (this.authorize(req, rawQuery, res)) this.placeOrder(params, res);
					break;
				}
				case "POST /api/v3/order/test": {
					if (!this.authorize(req, rawQuery, res)) break;
					// Real order/test runs every symbol filter; answering {} unconditionally would let
					// doctor's probe pass here while real Binance rejects it with -1013.
					const testSpec = SYMBOLS.find((sym) => sym.symbol === (params.get("symbol") ?? ""));
					if (!testSpec) {
						this.fail(res, 400, -1121, "Invalid symbol.");
						break;
					}
					const bad = this.violatedFilter(
						testSpec,
						decFromString(params.get("price") ?? "0"),
						decFromString(params.get("quantity") ?? "0"),
					);
					if (bad) this.fail(res, 400, -1013, `Filter failure: ${bad}`);
					else this.ok(res, {});
					break;
				}
				case "GET /api/v3/order": {
					if (this.authorize(req, rawQuery, res)) this.queryOrder(params, res);
					break;
				}
				case "DELETE /api/v3/order": {
					if (this.authorize(req, rawQuery, res)) this.cancelOrder(params, res);
					break;
				}
				default: {
					this.fail(res, 404, -1121, "Invalid symbol.");
					break;
				}
			}
		} catch (error) {
			this.fail(res, 500, -1000, error instanceof Error ? error.message : String(error));
		}
	}

	/**
	 * Verifies the request the way Binance does, over the bytes actually received.
	 *
	 * The signature covers the query string exactly as sent, so this recomputes it from the raw
	 * string rather than from a re-serialised `URLSearchParams` - a round trip through the parser
	 * would hide precisely the encoding bugs this is here to catch.
	 */
	private authorize(req: IncomingMessage, rawQuery: string, res: ServerResponse): boolean {
		if (req.headers["x-mbx-apikey"] !== this.apiKey) {
			this.fail(res, 401, -2015, "Invalid API-key, IP, or permissions for action.");
			return false;
		}

		const marker = "&signature=";
		const index = rawQuery.lastIndexOf(marker);
		if (index === -1) {
			this.fail(res, 400, -1102, "Mandatory parameter 'signature' was not sent.");
			return false;
		}
		const payload = rawQuery.slice(0, index);
		const provided = rawQuery.slice(index + marker.length);
		const expected = createHmac("sha256", this.apiSecret).update(payload).digest("hex");
		const left = Buffer.from(provided);
		const right = Buffer.from(expected);
		if (left.length !== right.length || !timingSafeEqual(left, right)) {
			this.signatureFailures++;
			this.fail(res, 401, -1022, "Signature for this request is not valid.");
			return false;
		}

		const params = new URLSearchParams(payload);
		const timestamp = Number(params.get("timestamp"));
		const recvWindow = Number(params.get("recvWindow") ?? 5000);
		if (recvWindow > 60_000) {
			this.fail(res, 400, -1131, "recvWindow must be less than 60000");
			return false;
		}
		const now = Date.now();
		if (!Number.isFinite(timestamp) || timestamp > now + 1000 || now - timestamp > recvWindow) {
			this.fail(res, 400, -1021, "Timestamp for this request is outside of the recvWindow.");
			return false;
		}
		return true;
	}

	/**
	 * The filters Binance enforces on every order, enforced here too.
	 *
	 * The fake advertised PRICE_FILTER/LOT_SIZE/NOTIONAL in exchangeInfo and then checked none of
	 * them, which broke its whole contract: the bot's own validateLimitOrder is exactly the code
	 * under test, so if the fake fills whatever that code emits, a rounding regression sails
	 * through the suite and first fails live as -1013 on leg 2 or 3 with inventory already held.
	 * Returns the failing filter's name, or undefined when the order is clean.
	 */
	private violatedFilter(spec: SymbolSpec, price: Dec, quantity: Dec): string | undefined {
		const tick = decFromString(spec.tick);
		const step = decFromString(spec.step);
		if (!decIsPositive(price) || price % tick !== 0n) return "PRICE_FILTER";
		if (!decIsPositive(quantity) || quantity % step !== 0n) return "LOT_SIZE";
		if (decLt(decMul(price, quantity), decFromString(spec.minNotional))) return "NOTIONAL";
		return undefined;
	}

	private placeOrder(params: URLSearchParams, res: ServerResponse): void {
		const symbol = params.get("symbol") ?? "";
		const side = params.get("side") ?? "";
		const clientOrderId = params.get("newClientOrderId") ?? `x-${this.nextOrderId}`;
		const price = params.get("price") ?? "0";
		const quantity = params.get("quantity") ?? "0";
		const spec = SYMBOLS.find((s) => s.symbol === symbol);

		const record = (status: string, executedQty: string): void => {
			this.placements.push({
				symbol,
				side,
				type: params.get("type") ?? "",
				timeInForce: params.get("timeInForce") ?? undefined,
				price,
				quantity,
				clientOrderId,
				status,
				executedQty,
				signatureValid: true,
			});
		};

		let failure: OrderFailure | undefined;
		const pending = this.pendingFailures;
		if (pending && pending.remaining > 0) {
			pending.remaining--;
			if (pending.remaining === 0) this.pendingFailures = undefined;
			failure = pending.failure;
			if (!failure.place) {
				record("NOT_PLACED", "0");
				this.fail(res, failure.status, failure.code, failure.msg);
				return;
			}
		}

		if (!spec) {
			record("REJECTED", "0");
			this.fail(res, 400, -1121, "Invalid symbol.");
			return;
		}
		if (this.orders.has(clientOrderId)) {
			record("REJECTED", "0");
			this.fail(res, 400, -2010, "Duplicate order sent.");
			return;
		}

		const limit = decFromString(price);
		const wanted = decFromString(quantity);

		const violated = this.violatedFilter(spec, limit, wanted);
		if (violated) {
			record("REJECTED", "0");
			this.fail(res, 400, -1013, `Filter failure: ${violated}`);
			return;
		}

		// Binance locks limit * origQty for a BUY (and origQty for a SELL) AT PLACEMENT, and answers
		// -2010 even when an IOC would not match at all. Checking fill-price * filled-qty instead -
		// as this fake originally did - is weaker on both axes and let an over-limit sizing bug fill
		// here while real Binance would refuse the whole order upfront.
		const required = side === "BUY" ? decMul(limit, wanted) : wanted;
		const requiredAsset = side === "BUY" ? spec.quote : spec.base;
		if (!decGte(this.balanceOf(requiredAsset), required)) {
			record("REJECTED", "0");
			this.fail(res, 400, -2010, "Account has insufficient balance for requested action.");
			return;
		}

		const quote = this.quotes.get(symbol);
		let filled = ZERO;
		let fillPrice = ZERO;
		if (quote) {
			if (side === "BUY" && decGte(limit, decFromString(quote.ask))) {
				fillPrice = decFromString(quote.ask);
				filled = decMin(wanted, decFromString(quote.askQty));
			} else if (side === "SELL" && decLte(limit, decFromString(quote.bid))) {
				fillPrice = decFromString(quote.bid);
				filled = decMin(wanted, decFromString(quote.bidQty));
			}
		}

		const quoteQty = decMul(filled, fillPrice);
		const spend = side === "BUY" ? quoteQty : filled;
		const spendAsset = side === "BUY" ? spec.quote : spec.base;

		const fills: { price: string; qty: string; commission: string; commissionAsset: string }[] = [];
		if (decIsPositive(filled)) {
			const received = side === "BUY" ? filled : quoteQty;
			const receivedAsset = side === "BUY" ? spec.base : spec.quote;
			const commission = decMul(received, this.takerFee);
			this.credit(spendAsset, decSub(ZERO as Dec, spend));
			this.credit(receivedAsset, decSub(received, commission));
			// Displayed depth is finite; consuming it stops the same quote filling forever.
			this.consumeDepth(symbol, side, filled);
			fills.push({
				price: decToString(fillPrice),
				qty: decToString(filled),
				commission: decToString(commission),
				commissionAsset: receivedAsset,
			});
		}

		const status = decIsPositive(filled) ? (filled === wanted ? "FILLED" : "EXPIRED") : "EXPIRED";
		const order: StoredOrder = {
			orderId: this.nextOrderId++,
			clientOrderId,
			symbol,
			side,
			price,
			origQty: quantity,
			executedQty: decToString(filled),
			cummulativeQuoteQty: decToString(quoteQty),
			status,
		};
		this.orders.set(clientOrderId, order);
		this.orderTimes.push(Date.now());
		record(status, order.executedQty);

		// The order is on the book; only the reply is lost. Reconciling by client id is the caller's
		// one safe move, and the stored order above is what makes that lookup answer truthfully.
		if (failure) {
			this.fail(res, failure.status, failure.code, failure.msg);
			return;
		}

		this.ok(res, {
			symbol,
			orderId: order.orderId,
			orderListId: -1,
			clientOrderId,
			transactTime: Date.now(),
			price,
			origQty: quantity,
			executedQty: order.executedQty,
			cummulativeQuoteQty: order.cummulativeQuoteQty,
			status,
			timeInForce: params.get("timeInForce") ?? "IOC",
			type: params.get("type") ?? "LIMIT",
			side,
			...(status === "EXPIRED" ? { expiryReason: "UNFILLED_IOC_QUANTITY_EXPIRED" } : {}),
			fills,
		});
	}

	/**
	 * Looks an order up the way Binance does: scoped to (symbol, id), with symbol mandatory.
	 *
	 * This endpoint is the sole basis for the halt/continue decision after an ambiguous order
	 * failure - the resolver treats "does not exist" as proof the order never reached the book. A
	 * fake that finds orders by client id alone would keep that test green even if the bot ever
	 * reconciled with the wrong symbol, while real Binance would answer -2013 and the bot would
	 * carry on trading past a filled, unaccounted order.
	 */
	private findOrder(params: URLSearchParams, res: ServerResponse): StoredOrder | undefined {
		const symbol = params.get("symbol");
		if (!symbol) {
			this.fail(res, 400, -1102, "Mandatory parameter 'symbol' was not sent.");
			return undefined;
		}
		const clientOrderId = params.get("origClientOrderId");
		const orderId = params.get("orderId");
		if (!clientOrderId && !orderId) {
			this.fail(res, 400, -1102, "Param 'origClientOrderId' or 'orderId' must be sent.");
			return undefined;
		}
		for (const order of this.orders.values()) {
			if (order.symbol !== symbol) continue;
			if (clientOrderId && order.clientOrderId === clientOrderId) return order;
			if (orderId && String(order.orderId) === orderId) return order;
		}
		return undefined;
	}

	private queryOrder(params: URLSearchParams, res: ServerResponse): void {
		const order = this.findOrder(params, res);
		if (res.writableEnded) return;
		if (!order) {
			this.fail(res, 400, -2013, "Order does not exist.");
			return;
		}
		this.ok(res, { ...order, type: "LIMIT", timeInForce: "IOC", time: Date.now(), updateTime: Date.now() });
	}

	private cancelOrder(params: URLSearchParams, res: ServerResponse): void {
		const order = this.findOrder(params, res);
		if (res.writableEnded) return;
		if (!order) {
			this.fail(res, 400, -2011, "Unknown order sent.");
			return;
		}
		order.status = "CANCELED";
		this.ok(res, { ...order, type: "LIMIT", timeInForce: "IOC" });
	}

	private credit(asset: string, delta: Dec): void {
		this.balances.set(asset, decAdd(this.balanceOf(asset), delta));
	}

	private consumeDepth(symbol: string, side: string, qty: Dec): void {
		const quote = this.quotes.get(symbol);
		if (!quote) return;
		if (side === "BUY") {
			const remaining = decSub(decFromString(quote.askQty), qty);
			quote.askQty = decToString(decIsPositive(remaining) ? remaining : ZERO);
		} else {
			const remaining = decSub(decFromString(quote.bidQty), qty);
			quote.bidQty = decToString(decIsPositive(remaining) ? remaining : ZERO);
		}
	}

	private account(): unknown {
		// Derived from the configured takerBps rather than hardcoded: a test that configures a 2bps
		// venue and reads back 10bps would silently price every cycle against the wrong fee.
		const rate = decToFixed(this.takerFee, 8);
		return {
			makerCommission: 10,
			takerCommission: 10,
			canTrade: true,
			canWithdraw: false,
			canDeposit: true,
			accountType: "SPOT",
			commissionRates: { maker: rate, taker: rate, buyer: "0.00000000", seller: "0.00000000" },
			permissions: ["SPOT"],
			updateTime: Date.now(),
			balances: [...this.balances].map(([asset, free]) => ({ asset, free: decToString(free), locked: "0" })),
		};
	}

	private commission(symbol: string): unknown {
		const rate = decToFixed(this.takerFee, 8);
		return {
			symbol,
			standardCommission: { maker: rate, taker: rate, buyer: "0.00000000", seller: "0.00000000" },
			taxCommission: { maker: "0.00000000", taker: "0.00000000", buyer: "0.00000000", seller: "0.00000000" },
			discount: { enabledForAccount: false, enabledForSymbol: false, discountAsset: "BNB", discount: "0.75000000" },
		};
	}

	private exchangeInfo(): unknown {
		return {
			timezone: "UTC",
			serverTime: Date.now(),
			rateLimits: [
				{ rateLimitType: "REQUEST_WEIGHT", interval: "MINUTE", intervalNum: 1, limit: 6000 },
				{ rateLimitType: "ORDERS", interval: "SECOND", intervalNum: 10, limit: 100 },
				{ rateLimitType: "ORDERS", interval: "DAY", intervalNum: 1, limit: 200_000 },
			],
			exchangeFilters: [],
			symbols: SYMBOLS.map((spec) => ({
				symbol: spec.symbol,
				status: "TRADING",
				baseAsset: spec.base,
				baseAssetPrecision: 8,
				quoteAsset: spec.quote,
				quoteAssetPrecision: 8,
				orderTypes: ["LIMIT", "LIMIT_MAKER", "MARKET"],
				isSpotTradingAllowed: true,
				permissionSets: [["SPOT"]],
				filters: [
					{ filterType: "PRICE_FILTER", minPrice: "0.000001", maxPrice: "1000000", tickSize: spec.tick },
					{ filterType: "LOT_SIZE", minQty: spec.step, maxQty: "900000", stepSize: spec.step },
					{
						filterType: "NOTIONAL",
						minNotional: spec.minNotional,
						applyMinToMarket: true,
						maxNotional: "9000000",
					},
				],
			})),
		};
	}

	private bookTickers(): unknown {
		return [...this.quotes].map(([symbol, quote]) => ({
			symbol,
			bidPrice: quote.bid,
			bidQty: quote.bidQty,
			askPrice: quote.ask,
			askQty: quote.askQty,
		}));
	}

	/** Orders placed in the trailing window, matching how the exchange reports its own counts. */
	private ordersWithin(windowMs: number): number {
		const cutoff = Date.now() - windowMs;
		let count = 0;
		for (let i = this.orderTimes.length - 1; i >= 0 && this.orderTimes[i] >= cutoff; i--) count++;
		return count;
	}

	private ok(res: ServerResponse, body: unknown): void {
		if (!this.pinnedWeight) this.usedWeight += 1;
		res.writeHead(200, {
			"content-type": "application/json;charset=UTF-8",
			"x-mbx-used-weight-1m": String(this.usedWeight),
			"x-mbx-order-count-10s": String(this.ordersWithin(10_000)),
			"x-mbx-order-count-1d": String(this.ordersWithin(86_400_000)),
		});
		res.end(JSON.stringify(body));
	}

	private fail(res: ServerResponse, status: number, code: number, msg: string): void {
		res.writeHead(status, {
			"content-type": "application/json;charset=UTF-8",
			"x-mbx-used-weight-1m": String(this.usedWeight),
		});
		res.end(JSON.stringify({ code, msg }));
	}
}

function encodeTextFrame(text: string): Buffer {
	return encodeFrame(0x1, Buffer.from(text, "utf8"));
}

/** A single unfragmented, unmasked server frame, as RFC 6455 requires of the server direction. */
function encodeFrame(opcode: number, payload: Buffer): Buffer {
	const first = 0x80 | opcode;
	if (payload.length < 126) {
		return Buffer.concat([Buffer.from([first, payload.length]), payload]);
	}
	if (payload.length < 65_536) {
		const header = Buffer.alloc(4);
		header[0] = first;
		header[1] = 126;
		header.writeUInt16BE(payload.length, 2);
		return Buffer.concat([header, payload]);
	}
	const header = Buffer.alloc(10);
	header[0] = first;
	header[1] = 127;
	header.writeBigUInt64BE(BigInt(payload.length), 2);
	return Buffer.concat([header, payload]);
}

interface DecodedFrame {
	readonly opcode: number;
	readonly payload: Buffer;
	readonly consumed: number;
}

/** Decodes one client frame if a whole one is buffered. Client frames are always masked. */
function decodeFrame(buffer: Buffer): DecodedFrame | undefined {
	if (buffer.length < 2) return undefined;
	const opcode = buffer[0] & 0x0f;
	const masked = (buffer[1] & 0x80) !== 0;
	let length = buffer[1] & 0x7f;
	let offset = 2;
	if (length === 126) {
		if (buffer.length < offset + 2) return undefined;
		length = buffer.readUInt16BE(offset);
		offset += 2;
	} else if (length === 127) {
		if (buffer.length < offset + 8) return undefined;
		length = Number(buffer.readBigUInt64BE(offset));
		offset += 8;
	}

	const maskLength = masked ? 4 : 0;
	if (buffer.length < offset + maskLength + length) return undefined;
	const mask = masked ? buffer.subarray(offset, offset + 4) : undefined;
	offset += maskLength;

	const payload = Buffer.from(buffer.subarray(offset, offset + length));
	if (mask) {
		for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
	}
	return { opcode, payload, consumed: offset + length };
}
