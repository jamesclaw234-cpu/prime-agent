import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_CONFIG, KEY_ID_ENV, loadConfig, SECRET_KEY_ENV } from "../src/config.js";

const dir = mkdtempSync(join(tmpdir(), "pm-arb-config-"));
afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

function writeConfig(name: string, value: unknown): string {
	const path = join(dir, name);
	writeFileSync(path, JSON.stringify(value));
	return path;
}

/** An env where the credential variables are definitively absent, whatever the host has set. */
const NO_CREDS: NodeJS.ProcessEnv = {};

describe("loadConfig", () => {
	it("returns the defaults when no file is given, without credentials", () => {
		const config = loadConfig({ env: NO_CREDS });
		expect(config.universe.maxEvents).toBe(DEFAULT_CONFIG.universe.maxEvents);
		expect(config.fees.takerRate).toBe("0.05");
		expect(config.venue.keyId).toBeUndefined();
		expect(config.venue.secretKey).toBeUndefined();
	});

	it("merges a partial file over the defaults", () => {
		const path = writeConfig("partial.json", {
			universe: { maxEvents: 3 },
			detection: { minNetPerSet: 0.01 },
		});
		const config = loadConfig({ file: path, env: NO_CREDS });
		expect(config.universe.maxEvents).toBe(3);
		expect(config.universe.maxMarkets).toBe(DEFAULT_CONFIG.universe.maxMarkets);
		expect(config.detection.minNetPerSet).toBe(0.01);
	});

	it("rejects an unknown key instead of silently defaulting a typo", () => {
		const path = writeConfig("typo.json", { detection: { minNetPerSets: 0.01 } });
		expect(() => loadConfig({ file: path, env: NO_CREDS })).toThrow(/unknown config key: detection.minNetPerSets/);
	});

	it("rejects credentials in the file: they are environment-only", () => {
		const path = writeConfig("creds.json", { venue: { keyId: "k", secretKey: "s" } });
		expect(() => loadConfig({ file: path, env: NO_CREDS })).toThrow(/contains API credentials/);
	});

	it("takes credentials from the environment", () => {
		const secret = Buffer.alloc(32, 3).toString("base64");
		const config = loadConfig({ env: { [KEY_ID_ENV]: "key-1", [SECRET_KEY_ENV]: secret } });
		expect(config.venue.keyId).toBe("key-1");
		expect(config.venue.secretKey).toBe(secret);
	});

	it("rejects plain http outside localhost, allows it on loopback", () => {
		const insecure = writeConfig("insecure.json", { venue: { gatewayBaseUrl: "http://gateway.polymarket.us" } });
		expect(() => loadConfig({ file: insecure, env: NO_CREDS })).toThrow(/https/);

		const loopback = writeConfig("loopback.json", {
			venue: { gatewayBaseUrl: "http://127.0.0.1:8091", apiBaseUrl: "http://127.0.0.1:8091" },
		});
		const config = loadConfig({ file: loopback, env: NO_CREDS });
		expect(config.venue.gatewayBaseUrl).toBe("http://127.0.0.1:8091");
	});

	it("rejects a fee rate outside [0, 1]", () => {
		const path = writeConfig("fees.json", { fees: { takerRate: "5" } });
		expect(() => loadConfig({ file: path, env: NO_CREDS })).toThrow(ConfigError);
	});

	it("rejects an unreadable file loudly rather than scanning with defaults", () => {
		expect(() => loadConfig({ file: join(dir, "does-not-exist.json"), env: NO_CREDS })).toThrow(/cannot read/);
	});
});
