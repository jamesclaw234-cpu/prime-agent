import type { KeyObject } from "node:crypto";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import {
	type Dec,
	decFromString,
	decGte,
	decIsPositive,
	decMul,
	decSub,
	decToString,
	decTryFromString,
	ONE,
	ZERO,
} from "../src/util/decimal.js";
import { publicKeyFromRaw, verifyAuthMessage } from "../src/venue/auth.js";
import type { CreateOrderParams, EventDetail, MarketBook, OrderIntent } from "../src/venue/types.js";

/**
 * A Polymarket US server speaking the real wire protocol on a loopback port.
 *
 * Same philosophy as btc-arb's fake-binance, hardened by what that one taught us: a CHECKING fake,
 * never a permissive one. It verifies the Ed25519 signature over the exact bare path it received
 * (query excluded, as the venue's SDK specifies), enforces timestamp freshness, price ticks, the
 * (0,1) price range, integer quantities and the minimum order size, keeps a USD balance with the
 * placement-time funds check, and matches IOC orders against displayed depth. A test passing here
 * means the request would have been accepted by the venue - not merely that our client likes its
 * own output.
 *
 * Known gaps, chosen rather than accidental: no fee collection yet (fees arrive with the detection
 * core so they are modelled in ONE place), no rate-limit enforcement, whole unfragmented WS frames
 * only. Tests must not claim coverage of those.
 */

export interface FakeMarketSpec {
	readonly slug: string;
	readonly eventSlug: string;
	/** LONG-side book. */
	bid: string;
	bidQty: string;
	ask: string;
	askQty: string;
}

export interface FakeOptions {
	readonly markets: FakeMarketSpec[];
	/** Registered API keys: key id -> raw 32-byte Ed25519 public key. */
	readonly keys?: Record<string, Buffer>;
	readonly balanceUsd?: string;
	/** Max clock skew accepted on X-PM-Timestamp, ms. */
	readonly timestampSkewMs?: number;
	/** Minimum order quantity in shares. */
	readonly minQuantity?: number;
	readonly tick?: string;
}

export interface RecordedOrder {
	readonly marketSlug: string;
	readonly intent: OrderIntent;
	readonly price: string;
	readonly quantity: number;
	readonly tif: string;
	readonly state: string;
	readonly filledQuantity: number;
	readonly signatureValid: boolean;
}

interface Shard {
	readonly socket: Duplex;
	readonly slugs: Set<string>;
}

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export class FakePolymarketUS {
	private server?: Server;
	private readonly shards = new Set<Shard>();
	private readonly markets = new Map<string, FakeMarketSpec>();
	private readonly keys = new Map<string, KeyObject>();
	private balance: Dec;
	private readonly timestampSkewMs: number;
	private readonly minQuantity: number;
	private readonly tick: Dec;
	private nextOrderId = 9000;

	readonly placements: RecordedOrder[] = [];
	readonly paths: string[] = [];
	signatureFailures = 0;

	constructor(options: FakeOptions) {
		for (const market of options.markets) this.markets.set(market.slug, { ...market });
		this.balance = decFromString(options.balanceUsd ?? "100");
		this.timestampSkewMs = options.timestampSkewMs ?? 30_000;
		this.minQuantity = options.minQuantity ?? 5;
		this.tick = decFromString(options.tick ?? "0.01");
		for (const [keyId, raw] of Object.entries(options.keys ?? {})) this.registerKey(keyId, raw);
	}

	registerKey(keyId: string, rawPublicKey: Buffer): void {
		this.keys.set(keyId, publicKeyFromRaw(rawPublicKey));
	}

	async start(): Promise<{ baseUrl: string }> {
		const server = createServer((req, res) => this.handleHttp(req, res));
		server.on("upgrade", (req, socket) => this.handleUpgrade(req, socket as Duplex));
		this.server = server;
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as AddressInfo).port;
		return { baseUrl: `http://127.0.0.1:${port}` };
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

	balanceOf(): Dec {
		return this.balance;
	}

	/** Updates a market's book and pushes MARKET_DATA to every subscribed shard. */
	publish(slug: string, book: { bid: string; bidQty: string; ask: string; askQty: string }): void {
		const market = this.markets.get(slug);
		if (!market) throw new Error(`no such market: ${slug}`);
		Object.assign(market, book);
		const frame = encodeTextFrame(
			JSON.stringify({
				requestId: "push",
				subscriptionType: "SUBSCRIPTION_TYPE_MARKET_DATA",
				marketData: this.wireBook(market),
			}),
		);
		for (const shard of this.shards) {
			if (shard.slugs.has(slug)) shard.socket.write(frame);
		}
	}

	sendHeartbeats(): void {
		const frame = encodeTextFrame(JSON.stringify({ heartbeat: {} }));
		for (const shard of this.shards) shard.socket.write(frame);
	}

	private wireBook(market: FakeMarketSpec): MarketBook {
		return {
			marketSlug: market.slug,
			bids: [{ px: { value: market.bid, currency: "USD" }, qty: market.bidQty }],
			offers: [{ px: { value: market.ask, currency: "USD" }, qty: market.askQty }],
			state: "MARKET_STATE_OPEN",
			transactTime: new Date().toISOString(),
		};
	}

	// --- WS --------------------------------------------------------------------------------------

	private handleUpgrade(req: IncomingMessage, socket: Duplex): void {
		const key = req.headers["sec-websocket-key"];
		const url = new URL(req.url ?? "/", "http://localhost");
		if (typeof key !== "string" || url.pathname !== "/v1/ws/markets") {
			socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
			return;
		}
		const accept = createHash("sha1")
			.update(key + WS_GUID)
			.digest("base64");
		socket.write(
			"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
				`Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
		);

		const shard: Shard = { socket, slugs: new Set() };
		this.shards.add(shard);

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
				if (frame.opcode === 0x9) {
					socket.write(encodeFrame(0xa, frame.payload));
					continue;
				}
				if (frame.opcode === 0x1) this.handleWsMessage(shard, frame.payload.toString("utf8"));
			}
		});
		const drop = (): void => {
			this.shards.delete(shard);
		};
		socket.on("close", drop);
		socket.on("error", drop);
	}

	private handleWsMessage(shard: Shard, text: string): void {
		let message: { subscribe?: { requestId?: string; subscriptionType?: string; marketSlugs?: string[] } };
		try {
			message = JSON.parse(text);
		} catch {
			return;
		}
		const subscribe = message.subscribe;
		if (!subscribe) return;
		const requestId = subscribe.requestId ?? "";
		if (subscribe.subscriptionType !== "SUBSCRIPTION_TYPE_MARKET_DATA") {
			shard.socket.write(encodeTextFrame(JSON.stringify({ requestId, error: "unsupported subscription type" })));
			return;
		}
		const unknown = (subscribe.marketSlugs ?? []).filter((slug) => !this.markets.has(slug));
		if (unknown.length > 0) {
			// The real venue refuses unknown slugs; a fake that silently accepted them would let a
			// slug-construction bug pass the suite and starve the live feed.
			shard.socket.write(encodeTextFrame(JSON.stringify({ requestId, error: `unknown market: ${unknown[0]}` })));
			return;
		}
		for (const slug of subscribe.marketSlugs ?? []) {
			shard.slugs.add(slug);
			const market = this.markets.get(slug);
			if (market) {
				shard.socket.write(
					encodeTextFrame(
						JSON.stringify({
							requestId,
							subscriptionType: "SUBSCRIPTION_TYPE_MARKET_DATA",
							marketData: this.wireBook(market),
						}),
					),
				);
			}
		}
	}

	// --- REST ------------------------------------------------------------------------------------

	private handleHttp(req: IncomingMessage, res: ServerResponse): void {
		const raw = req.url ?? "/";
		const url = new URL(raw, "http://localhost");
		const path = url.pathname;
		this.paths.push(path);

		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			try {
				this.route(req, res, path, body);
			} catch (error) {
				this.fail(res, 500, error instanceof Error ? error.message : String(error));
			}
		});
	}

	private route(req: IncomingMessage, res: ServerResponse, path: string, body: string): void {
		const method = req.method ?? "GET";
		if (method === "GET" && path === "/v1/events") {
			const events = new Map<string, EventDetail & { markets: unknown[] }>();
			for (const market of this.markets.values()) {
				const entry = events.get(market.eventSlug) ?? { slug: market.eventSlug, active: true, markets: [] };
				entry.markets.push({ slug: market.slug, eventSlug: market.eventSlug, active: true });
				events.set(market.eventSlug, entry);
			}
			this.ok(res, { events: [...events.values()] });
			return;
		}
		if (method === "GET" && path === "/v1/markets") {
			this.ok(res, {
				markets: [...this.markets.values()].map((market) => ({
					slug: market.slug,
					eventSlug: market.eventSlug,
					active: true,
				})),
			});
			return;
		}
		const bookMatch = path.match(/^\/v1\/markets\/([^/]+)\/book$/);
		if (method === "GET" && bookMatch) {
			const market = this.markets.get(decodeURIComponent(bookMatch[1]));
			if (!market) {
				this.fail(res, 404, "market not found");
				return;
			}
			this.ok(res, this.wireBook(market));
			return;
		}

		// Everything below is authenticated.
		if (!this.authorize(req, path, res)) return;

		if (method === "POST" && path === "/v1/orders") {
			this.placeOrder(res, body);
			return;
		}
		if (method === "GET" && path === "/v1/orders/open") {
			this.ok(res, { orders: [] });
			return;
		}
		if (method === "GET" && path === "/v1/portfolio/positions") {
			this.ok(res, { positions: [] });
			return;
		}
		this.fail(res, 404, "not found");
	}

	/**
	 * Verifies the request the way the venue does: signature over `${ts}${METHOD}${bare path}`.
	 *
	 * The bare path matters: a client that signed the query string too would verify against itself
	 * and fail only here (and live). This is the whole reason the fake verifies rather than trusts.
	 */
	private authorize(req: IncomingMessage, path: string, res: ServerResponse): boolean {
		const keyId = String(req.headers["x-pm-access-key"] ?? "");
		const timestamp = String(req.headers["x-pm-timestamp"] ?? "");
		const signature = String(req.headers["x-pm-signature"] ?? "");
		const publicKey = this.keys.get(keyId);
		if (!publicKey) {
			this.fail(res, 401, "unknown API key");
			return false;
		}
		const ts = Number(timestamp);
		if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > this.timestampSkewMs) {
			this.fail(res, 401, "timestamp outside allowed window");
			return false;
		}
		if (!verifyAuthMessage(publicKey, timestamp, req.method ?? "GET", path, signature)) {
			this.signatureFailures++;
			this.fail(res, 401, "invalid signature");
			return false;
		}
		return true;
	}

	private placeOrder(res: ServerResponse, body: string): void {
		let params: CreateOrderParams;
		try {
			params = JSON.parse(body) as CreateOrderParams;
		} catch {
			this.fail(res, 400, "body is not valid JSON");
			return;
		}
		const market = this.markets.get(params.marketSlug);
		const record = (state: string, filledQuantity: number, signatureValid = true): void => {
			this.placements.push({
				marketSlug: params.marketSlug ?? "",
				intent: params.intent,
				price: params.price?.value ?? "",
				quantity: params.quantity ?? 0,
				tif: params.tif ?? "",
				state,
				filledQuantity,
				signatureValid,
			});
		};

		if (!market) {
			record("ORDER_STATE_REJECTED", 0);
			this.fail(res, 404, "market not found");
			return;
		}
		if (!Number.isInteger(params.quantity) || params.quantity < this.minQuantity) {
			record("ORDER_STATE_REJECTED", 0);
			this.fail(res, 400, `quantity must be an integer >= ${this.minQuantity}`);
			return;
		}
		const price = params.price ? decTryFromString(params.price.value) : undefined;
		if (!price || !decIsPositive(price) || decGte(price, ONE)) {
			record("ORDER_STATE_REJECTED", 0);
			this.fail(res, 400, "price must be inside (0, 1)");
			return;
		}
		if (price % this.tick !== 0n) {
			record("ORDER_STATE_REJECTED", 0);
			this.fail(res, 400, "price is not a multiple of the tick");
			return;
		}

		// Funds are locked at placement: limit price x quantity for a BUY of either side.
		const quantity = decFromString(String(params.quantity));
		const cost = decMul(price, quantity);
		if (!decGte(this.balance, cost)) {
			record("ORDER_STATE_REJECTED", 0);
			this.fail(res, 400, "insufficient buying power");
			return;
		}

		// Unified-book IOC matching: BUY_LONG crosses the LONG ask; BUY_SHORT is a bet against, and
		// on a unified engine it crosses at 1 minus the LONG bid.
		let filled = 0;
		let fillPrice = ZERO;
		if (params.intent === "ORDER_INTENT_BUY_LONG") {
			const ask = decFromString(market.ask);
			if (decGte(price, ask)) {
				filled = Math.min(params.quantity, Number(market.askQty));
				fillPrice = ask;
			}
		} else if (params.intent === "ORDER_INTENT_BUY_SHORT") {
			const shortAsk = decSub(ONE, decFromString(market.bid));
			if (decGte(price, shortAsk)) {
				filled = Math.min(params.quantity, Number(market.bidQty));
				fillPrice = shortAsk;
			}
		} else {
			record("ORDER_STATE_REJECTED", 0);
			this.fail(res, 400, "sell intents need an existing position in this fake");
			return;
		}

		if (filled > 0) {
			this.balance = decSub(this.balance, decMul(fillPrice, decFromString(String(filled))));
		}
		const state =
			filled === params.quantity
				? "ORDER_STATE_FILLED"
				: filled > 0
					? "ORDER_STATE_PARTIALLY_FILLED"
					: "ORDER_STATE_EXPIRED";
		record(state, filled);
		this.ok(res, {
			order: {
				id: `ord-${this.nextOrderId++}`,
				marketSlug: params.marketSlug,
				intent: params.intent,
				price: { value: decToString(price), currency: "USD" },
				quantity: params.quantity,
				cumQuantity: filled,
				leavesQuantity: 0,
				state,
				avgPx: filled > 0 ? { value: decToString(fillPrice), currency: "USD" } : undefined,
			},
		});
	}

	private ok(res: ServerResponse, body: unknown): void {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	}

	private fail(res: ServerResponse, status: number, message: string): void {
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify({ message }));
	}
}

function encodeTextFrame(text: string): Buffer {
	return encodeFrame(0x1, Buffer.from(text, "utf8"));
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
	const first = 0x80 | opcode;
	if (payload.length < 126) return Buffer.concat([Buffer.from([first, payload.length]), payload]);
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
	if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
	return { opcode, payload, consumed: offset + length };
}
