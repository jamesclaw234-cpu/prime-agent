import { describe, expect, it } from "vitest";
import {
	AuthError,
	createAuthHeaders,
	keyFingerprint,
	privateKeyFromSecret,
	publicKeyFromRaw,
	rawPublicKey,
	verifyAuthMessage,
} from "../src/venue/auth.js";

/**
 * The signing scheme is pinned to the official SDK source (auth.py), not to a blog post:
 * Ed25519 over `${timestampMs}${METHOD}${path}`, bare path, base64 signature.
 */

// A fixed 32-byte seed so every value below is reproducible.
const SEED = Buffer.alloc(32, 7).toString("base64");
const NOW = 1_760_000_000_000;

describe("key handling", () => {
	it("accepts a 32-byte seed and a 64-byte seed+public pair identically", () => {
		const fromSeed = privateKeyFromSecret(SEED);
		const pair = Buffer.concat([Buffer.alloc(32, 7), rawPublicKey(fromSeed)]).toString("base64");
		const fromPair = privateKeyFromSecret(pair);
		// Same seed, same key: signatures over the same message must verify against one public key.
		const pub = publicKeyFromRaw(rawPublicKey(fromSeed));
		const headers = createAuthHeaders("k", fromPair, "GET", "/v1/markets", NOW);
		expect(verifyAuthMessage(pub, headers["X-PM-Timestamp"], "GET", "/v1/markets", headers["X-PM-Signature"])).toBe(
			true,
		);
	});

	it("rejects a secret of the wrong length rather than guessing", () => {
		expect(() => privateKeyFromSecret(Buffer.alloc(31).toString("base64"))).toThrow(AuthError);
		expect(() => privateKeyFromSecret(Buffer.alloc(33).toString("base64"))).toThrow(AuthError);
	});

	it("fingerprints a key without exposing it", () => {
		const print = keyFingerprint(SEED);
		expect(print).toHaveLength(8);
		expect(SEED).not.toContain(print);
	});
});

describe("request signing", () => {
	const priv = privateKeyFromSecret(SEED);
	const pub = publicKeyFromRaw(rawPublicKey(priv));

	it("round-trips: what the client signs, the server verifies", () => {
		const headers = createAuthHeaders("key-id", priv, "POST", "/v1/orders", NOW);
		expect(headers["X-PM-Access-Key"]).toBe("key-id");
		expect(headers["X-PM-Timestamp"]).toBe(String(NOW));
		expect(verifyAuthMessage(pub, String(NOW), "POST", "/v1/orders", headers["X-PM-Signature"])).toBe(true);
	});

	it("binds the signature to method, path and timestamp", () => {
		const headers = createAuthHeaders("key-id", priv, "POST", "/v1/orders", NOW);
		const sig = headers["X-PM-Signature"];
		expect(verifyAuthMessage(pub, String(NOW), "GET", "/v1/orders", sig)).toBe(false);
		expect(verifyAuthMessage(pub, String(NOW), "POST", "/v1/orders/open", sig)).toBe(false);
		expect(verifyAuthMessage(pub, String(NOW + 1), "POST", "/v1/orders", sig)).toBe(false);
	});

	it("refuses to sign a path carrying a query string", () => {
		// The SDK signs the bare path; signing `?limit=10` here would fail server-side verification
		// on every parameterised request, which is the kind of bug that only appears live.
		expect(() => createAuthHeaders("k", priv, "GET", "/v1/markets?limit=10", NOW)).toThrow(AuthError);
	});

	it("rejects a signature from a different key", () => {
		const other = privateKeyFromSecret(Buffer.alloc(32, 9).toString("base64"));
		const headers = createAuthHeaders("k", other, "GET", "/v1/markets", NOW);
		expect(verifyAuthMessage(pub, headers["X-PM-Timestamp"], "GET", "/v1/markets", headers["X-PM-Signature"])).toBe(
			false,
		);
	});
});
