import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { TopOfBook } from "../types.js";
import { decToString } from "../util/decimal.js";

/**
 * Writes every accepted book frame to a JSONL file.
 *
 * A recording is the only way to answer "would this configuration have traded, and would it have
 * made money" without risking capital, and it is the only way to reproduce a detection bug that
 * depended on one specific sequence of frames.
 */
export class TickRecorder {
	private broken = false;
	private written = 0;
	private buffer: string[] = [];

	constructor(
		private readonly file: string,
		/** Frames are flushed in batches; a per-frame write would dominate the hot path. */
		private readonly batchSize = 256,
	) {
		try {
			mkdirSync(dirname(file), { recursive: true });
		} catch {
			this.broken = true;
		}
	}

	record(book: TopOfBook): void {
		if (this.broken) return;
		this.buffer.push(
			JSON.stringify({
				t: book.receivedAt,
				s: book.symbol,
				u: book.updateId,
				b: decToString(book.bid),
				B: decToString(book.bidQty),
				a: decToString(book.ask),
				A: decToString(book.askQty),
			}),
		);
		if (this.buffer.length >= this.batchSize) this.flush();
	}

	flush(): void {
		if (this.broken || this.buffer.length === 0) return;
		const payload = `${this.buffer.join("\n")}\n`;
		this.buffer = [];
		try {
			appendFileSync(this.file, payload);
			this.written += payload.length;
		} catch {
			this.broken = true;
		}
	}

	get bytesWritten(): number {
		return this.written;
	}
}

export interface RecordedTick {
	readonly t: number;
	readonly s: string;
	readonly u: number;
	readonly b: string;
	readonly B: string;
	readonly a: string;
	readonly A: string;
}

/** Parses one recorded line, returning `undefined` for anything malformed. */
export function parseRecordedTick(line: string): RecordedTick | undefined {
	const trimmed = line.trim();
	if (trimmed.length === 0) return undefined;
	try {
		const parsed = JSON.parse(trimmed) as Partial<RecordedTick>;
		if (
			typeof parsed.s !== "string" ||
			typeof parsed.b !== "string" ||
			typeof parsed.a !== "string" ||
			typeof parsed.B !== "string" ||
			typeof parsed.A !== "string"
		) {
			return undefined;
		}
		return {
			t: typeof parsed.t === "number" ? parsed.t : 0,
			s: parsed.s,
			u: typeof parsed.u === "number" ? parsed.u : 0,
			b: parsed.b,
			B: parsed.B,
			a: parsed.a,
			A: parsed.A,
		};
	} catch {
		return undefined;
	}
}
