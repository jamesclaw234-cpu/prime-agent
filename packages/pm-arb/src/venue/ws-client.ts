import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";
import type { Socket } from "node:net";
import type { WsConnection, WsFactory, WsHandlers } from "./feed.js";

/**
 * Minimal RFC 6455 WebSocket client with custom-header support.
 *
 * This exists because the venue AUTHENTICATES the market-data WebSocket: the official SDK signs
 * the upgrade request itself with the same Ed25519 headers as REST (`create_auth_headers(...,
 * "GET", "/v1/ws/markets")` in its BaseWebSocket.connect). Node's built-in WebSocket follows the
 * browser API, which cannot attach custom headers, so a client built on it can pass every local
 * test and still never complete a handshake with the real venue. Hand-rolling the framing is the
 * smaller risk, and the loopback fake exercises this implementation over real sockets.
 */

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

export interface RawWsOptions {
	/** Called once per dial, so signed headers carry a fresh timestamp on every reconnect. */
	readonly headersProvider?: () => Record<string, string>;
	readonly connectTimeoutMs?: number;
}

/**
 * A WsFactory for the feed. Handler guarantees the feed relies on: `onClose` fires exactly once
 * per connection, and every failure path emits `onError` before it.
 */
export function rawWebSocketFactory(options: RawWsOptions = {}): WsFactory {
	return (url, handlers) => new RawWebSocket(url, handlers, options);
}

class RawWebSocket implements WsConnection {
	private socket?: Socket;
	private buffer: Buffer = Buffer.alloc(0);
	private fragments: Buffer[] = [];
	private closed = false;
	private closeFrameSent = false;
	private connectTimer?: ReturnType<typeof setTimeout>;

	constructor(
		url: string,
		private readonly handlers: WsHandlers,
		options: RawWsOptions,
	) {
		const target = new URL(url);
		const secure = target.protocol === "wss:" || target.protocol === "https:";
		if (!secure && target.protocol !== "ws:" && target.protocol !== "http:") {
			throw new Error(`unsupported WebSocket protocol: ${target.protocol}`);
		}
		const key = randomBytes(16).toString("base64");
		const expectAccept = createHash("sha1")
			.update(key + WS_GUID)
			.digest("base64");

		const headers: Record<string, string> = {
			...options.headersProvider?.(),
			connection: "Upgrade",
			upgrade: "websocket",
			"sec-websocket-version": "13",
			"sec-websocket-key": key,
		};

		const request = (secure ? https : http).request({
			host: target.hostname,
			port: target.port ? Number(target.port) : secure ? 443 : 80,
			path: `${target.pathname}${target.search}`,
			method: "GET",
			headers,
		});

		this.connectTimer = setTimeout(() => {
			request.destroy(new Error("WebSocket connect timeout"));
		}, options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
		this.connectTimer.unref?.();

		request.on("upgrade", (response, socket, head) => {
			this.clearConnectTimer();
			if (response.headers["sec-websocket-accept"] !== expectAccept) {
				this.failed(new Error("server returned a wrong Sec-WebSocket-Accept"));
				socket.destroy();
				return;
			}
			this.socket = socket;
			socket.on("data", (chunk: Buffer) => this.onData(chunk));
			socket.on("error", (error: Error) => this.failed(error));
			socket.on("close", () => this.emitClose(1006, "connection lost"));
			this.handlers.onOpen();
			if (head.length > 0) this.onData(head);
		});
		// A non-101 answer (401 on a bad signature, 404 on a wrong path) arrives here instead.
		request.on("response", (response) => {
			this.failed(new Error(`server refused upgrade: HTTP ${response.statusCode}`));
			response.destroy();
		});
		request.on("error", (error) => this.failed(error));
		request.end();
	}

	send(data: string): void {
		if (!this.socket || this.closed) return;
		this.socket.write(encodeClientFrame(0x1, Buffer.from(data, "utf8")));
	}

	close(): void {
		if (this.closed) return;
		if (this.socket) {
			this.sendClose(1000, "OK");
			this.socket.end();
		}
		this.emitClose(1000, "closed by client");
	}

	private clearConnectTimer(): void {
		if (this.connectTimer) clearTimeout(this.connectTimer);
		this.connectTimer = undefined;
	}

	private failed(error: Error): void {
		this.clearConnectTimer();
		if (this.closed) return;
		this.handlers.onError(error);
		this.emitClose(1006, error.message);
	}

	private emitClose(code: number, reason: string): void {
		this.clearConnectTimer();
		if (this.closed) return;
		this.closed = true;
		this.socket?.destroy();
		this.handlers.onClose(code, reason);
	}

	private sendClose(code: number, reason: string): void {
		if (this.closeFrameSent || !this.socket) return;
		this.closeFrameSent = true;
		const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
		payload.writeUInt16BE(code, 0);
		payload.write(reason, 2);
		try {
			this.socket.write(encodeClientFrame(0x8, payload));
		} catch {
			// The close frame is a courtesy; the socket teardown is what matters.
		}
	}

	private onData(chunk: Buffer): void {
		this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
		for (;;) {
			const frame = decodeServerFrame(this.buffer);
			if (!frame) return;
			this.buffer = this.buffer.subarray(frame.consumed);
			if (this.closed) return;

			switch (frame.opcode) {
				case 0x1:
				case 0x2:
				case 0x0: {
					// Data frames may be fragmented: opcode on the first fragment, 0x0 continuations,
					// FIN on the last. Control frames are never fragmented and may interleave.
					this.fragments.push(frame.payload);
					if (frame.fin) {
						const whole = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments);
						this.fragments = [];
						this.handlers.onMessage(whole.toString("utf8"));
					}
					break;
				}
				case 0x8: {
					const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005;
					const reason = frame.payload.length > 2 ? frame.payload.subarray(2).toString("utf8") : "";
					this.sendClose(code, "");
					this.emitClose(code, reason);
					return;
				}
				case 0x9:
					if (this.socket) this.socket.write(encodeClientFrame(0xa, frame.payload));
					break;
				default:
					// Pong (0xA) and anything unknown: nothing to do.
					break;
			}
		}
	}
}

/** Client-to-server frames MUST be masked (RFC 6455 section 5.3). */
function encodeClientFrame(opcode: number, payload: Buffer): Buffer {
	const mask = randomBytes(4);
	const masked = Buffer.allocUnsafe(payload.length);
	for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];

	let header: Buffer;
	if (payload.length < 126) {
		header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
	} else if (payload.length < 65_536) {
		header = Buffer.alloc(4);
		header[0] = 0x80 | opcode;
		header[1] = 0x80 | 126;
		header.writeUInt16BE(payload.length, 2);
	} else {
		header = Buffer.alloc(10);
		header[0] = 0x80 | opcode;
		header[1] = 0x80 | 127;
		header.writeBigUInt64BE(BigInt(payload.length), 2);
	}
	return Buffer.concat([header, mask, masked]);
}

interface DecodedFrame {
	readonly fin: boolean;
	readonly opcode: number;
	readonly payload: Buffer;
	readonly consumed: number;
}

/** Server frames arrive unmasked, but a mask is tolerated since unmasking is cheap and local. */
function decodeServerFrame(buffer: Buffer): DecodedFrame | undefined {
	if (buffer.length < 2) return undefined;
	const fin = (buffer[0] & 0x80) !== 0;
	const opcode = buffer[0] & 0x0f;
	const maskBit = (buffer[1] & 0x80) !== 0;
	let length = buffer[1] & 0x7f;
	let offset = 2;
	if (length === 126) {
		if (buffer.length < 4) return undefined;
		length = buffer.readUInt16BE(2);
		offset = 4;
	} else if (length === 127) {
		if (buffer.length < 10) return undefined;
		const big = buffer.readBigUInt64BE(2);
		if (big > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
		length = Number(big);
		offset = 10;
	}
	const maskLength = maskBit ? 4 : 0;
	if (buffer.length < offset + maskLength + length) return undefined;
	let payload = buffer.subarray(offset + maskLength, offset + maskLength + length);
	if (maskBit) {
		const mask = buffer.subarray(offset, offset + 4);
		const unmasked = Buffer.allocUnsafe(length);
		for (let i = 0; i < length; i++) unmasked[i] = payload[i] ^ mask[i % 4];
		payload = unmasked;
	}
	return { fin, opcode, payload, consumed: offset + maskLength + length };
}
