import type { BotStatus } from "../run/bot.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

export interface DashboardOptions {
	readonly write?: (text: string) => void;
	readonly now?: () => number;
	readonly color?: boolean;
}

/**
 * Compact live status view.
 *
 * Renders to the alternate screen buffer so the scrollback keeps the structured log intact - the
 * dashboard is for watching, the log is for reading afterwards.
 */
export class Dashboard {
	private readonly write: (text: string) => void;
	private readonly now: () => number;
	private readonly color: boolean;
	private active = false;

	constructor(options: DashboardOptions = {}) {
		this.write = options.write ?? ((text) => process.stdout.write(text));
		this.now = options.now ?? Date.now;
		this.color = options.color ?? process.stdout.isTTY === true;
	}

	start(): void {
		if (this.active) return;
		this.active = true;
		this.write("\x1b[?1049h\x1b[?25l");
	}

	stop(): void {
		if (!this.active) return;
		this.active = false;
		this.write("\x1b[?25h\x1b[?1049l");
	}

	render(status: BotStatus): void {
		this.write(`\x1b[H\x1b[2J${this.compose(status)}`);
	}

	/** Exposed separately so tests can assert on the text without driving a terminal. */
	compose(status: BotStatus): string {
		const c = (code: string, text: string): string => (this.color ? `${code}${text}${RESET}` : text);
		const lines: string[] = [];
		const ledger = status.ledger;
		const detector = status.detector;
		const feed = status.feed;
		const risk = status.risk;

		const modeTag = status.mode === "live" ? c(`${BOLD}${RED}`, " LIVE ") : c(`${BOLD}${GREEN}`, " PAPER ");
		lines.push(`${c(BOLD, "btc-arb")} ${modeTag} ${c(DIM, new Date(this.now()).toISOString())}`);
		lines.push("");

		lines.push(c(CYAN, "market data"));
		lines.push(
			`  shards ${feed.openShards}/${feed.shards}   books ${status.bookSymbols}/${status.symbols}` +
				`   msgs ${feed.messages}   reconnects ${feed.reconnects}   oldest ${feed.oldestMessageAgeMs}ms`,
		);
		lines.push(
			`  cycles ${status.cycles}   max fanout ${status.maxFanout}   taker ${status.takerBps}bps` +
				`   clock skew ${status.clockSkewMs}ms`,
		);
		lines.push("");

		lines.push(c(CYAN, "detection"));
		lines.push(
			`  ticks ${detector.ticks}   screened ${detector.cyclesScreened}   passed screen ${detector.screenPasses}` +
				`   planned ${detector.planned}   rejected ${detector.rejected}`,
		);
		const topReasons = Object.entries(detector.rejectionsByReason)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 3);
		if (topReasons.length > 0) {
			lines.push(c(DIM, `  top rejections: ${topReasons.map(([r, n]) => `${r} (${n})`).join("  ")}`));
		}
		lines.push("");

		lines.push(c(CYAN, "execution"));
		const pnlColor = ledger.realizedPnl >= 0 ? GREEN : RED;
		lines.push(
			`  cycles ${ledger.cycles}   completed ${ledger.completed}   win rate ${(ledger.winRate * 100).toFixed(1)}%` +
				`   volume ${ledger.volume.toFixed(2)}`,
		);
		lines.push(
			`  realised PnL ${c(pnlColor, ledger.realizedPnl.toFixed(6))}` +
				`   slippage ${ledger.totalSlippage.toFixed(6)} (${ledger.avgSlippageBps.toFixed(2)}bps avg)`,
		);
		const outcomes = Object.entries(ledger.byOutcome);
		if (outcomes.length > 0) {
			lines.push(c(DIM, `  outcomes: ${outcomes.map(([k, v]) => `${k} ${v}`).join("  ")}`));
		}
		const stranded = Object.entries(ledger.strandedByAsset);
		if (stranded.length > 0) {
			lines.push(c(YELLOW, `  stranded: ${stranded.map(([a, v]) => `${v} ${a}`).join("  ")}`));
		}
		lines.push("");

		lines.push(c(CYAN, "risk"));
		lines.push(
			`  open ${risk.openCycles}   today ${risk.cyclesToday}   daily PnL ${risk.dailyPnl.toFixed(4)}` +
				`   consecutive failures ${risk.consecutiveFailures}   cooling ${risk.cooldownSymbols}`,
		);
		if (risk.halted) {
			lines.push(c(`${BOLD}${RED}`, `  HALTED: ${risk.haltReason ?? "unknown reason"}`));
		}

		const latency = status.metrics.order_latency_ms_p95;
		if (typeof latency === "number" && latency > 0) {
			lines.push("");
			lines.push(
				c(DIM, `  order latency p50/p95/p99 ${fmt(status.metrics.order_latency_ms_p50)}/`) +
					c(DIM, `${fmt(latency)}/${fmt(status.metrics.order_latency_ms_p99)} ms`),
			);
		}

		return `${lines.join("\n")}\n`;
	}
}

function fmt(value: number | undefined): string {
	return value === undefined ? "-" : value.toFixed(0);
}
