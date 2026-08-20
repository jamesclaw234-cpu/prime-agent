import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const LEVEL_COLOR: Record<LogLevel, string> = {
	debug: "\x1b[90m",
	info: "\x1b[36m",
	warn: "\x1b[33m",
	error: "\x1b[31m",
};

const RESET = "\x1b[0m";

export interface LoggerOptions {
	level: LogLevel;
	/** Absolute path for newline-delimited JSON records. Omit to log to the console only. */
	file?: string;
	/** Set false for non-TTY output or when the dashboard owns the screen. */
	pretty?: boolean;
	/** Injected for tests. */
	now?: () => number;
	sink?: (line: string) => void;
}

export type LogFields = Record<string, unknown>;

/**
 * Structured logger with a machine-readable file sink and a human-readable console sink.
 *
 * A trading bot's log is evidence: every rejected order, reconnect and skipped opportunity has to
 * be reconstructable after the fact, so the file sink is always JSONL with a stable field set.
 */
export class Logger {
	private readonly threshold: number;
	private readonly file?: string;
	private readonly pretty: boolean;
	private readonly now: () => number;
	private readonly sink: (line: string) => void;
	private fileBroken = false;

	constructor(
		private readonly options: LoggerOptions,
		private readonly context: LogFields = {},
	) {
		this.threshold = LEVEL_ORDER[options.level];
		this.file = options.file;
		this.pretty = options.pretty ?? true;
		this.now = options.now ?? Date.now;
		this.sink = options.sink ?? ((line: string) => process.stderr.write(`${line}\n`));
		if (this.file) {
			try {
				mkdirSync(dirname(this.file), { recursive: true });
			} catch {
				this.fileBroken = true;
			}
		}
	}

	/** Returns a logger that stamps every record with additional fields. */
	child(context: LogFields): Logger {
		return new Logger(this.options, { ...this.context, ...context });
	}

	debug(message: string, fields?: LogFields): void {
		this.log("debug", message, fields);
	}

	info(message: string, fields?: LogFields): void {
		this.log("info", message, fields);
	}

	warn(message: string, fields?: LogFields): void {
		this.log("warn", message, fields);
	}

	error(message: string, fields?: LogFields): void {
		this.log("error", message, fields);
	}

	log(level: LogLevel, message: string, fields?: LogFields): void {
		if (LEVEL_ORDER[level] < this.threshold) return;
		const timestamp = this.now();
		const record = { ts: new Date(timestamp).toISOString(), level, msg: message, ...this.context, ...fields };
		const serialized = JSON.stringify(record, jsonReplacer);

		if (this.file && !this.fileBroken) {
			try {
				appendFileSync(this.file, `${serialized}\n`);
			} catch {
				// A full or read-only disk must never take the bot down; drop to console only.
				this.fileBroken = true;
			}
		}

		if (this.pretty) {
			this.sink(formatPretty(timestamp, level, message, { ...this.context, ...fields }));
		} else {
			this.sink(serialized);
		}
	}
}

/** BigInt is not JSON-serialisable; render it as a decimal string rather than throwing. */
function jsonReplacer(_key: string, value: unknown): unknown {
	if (typeof value === "bigint") return value.toString();
	if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
	return value;
}

function formatPretty(timestamp: number, level: LogLevel, message: string, fields: LogFields): string {
	const time = new Date(timestamp).toISOString().slice(11, 23);
	const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
	const suffix =
		entries.length === 0 ? "" : ` ${entries.map(([key, value]) => `${key}=${formatValue(value)}`).join(" ")}`;
	return `${LEVEL_COLOR[level]}${time} ${level.padEnd(5)}${RESET} ${message}${suffix}`;
}

function formatValue(value: unknown): string {
	if (typeof value === "string") return value.includes(" ") ? JSON.stringify(value) : value;
	if (typeof value === "bigint") return value.toString();
	if (value instanceof Error) return JSON.stringify(value.message);
	if (typeof value === "object" && value !== null) return JSON.stringify(value, jsonReplacer);
	return String(value);
}

/** A logger that discards everything, for tests. */
export function silentLogger(): Logger {
	return new Logger({ level: "error", pretty: false, sink: () => {} });
}
