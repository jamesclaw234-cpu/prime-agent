import { createHash, createPrivateKey, createPublicKey, type KeyObject, sign, verify } from "node:crypto";

/**
 * Request signing for the Polymarket US API.
 *
 * The scheme, taken from the official SDK source (polymarket-us-python/auth.py) rather than from
 * any secondhand description: an Ed25519 signature over the exact concatenation
 *
 *     `${timestampMs}${METHOD}${path}`
 *
 * where `path` is the BARE request path - no query string, no body. The signature travels in
 * `X-PM-Signature` (base64), alongside `X-PM-Access-Key` (the key id) and `X-PM-Timestamp`.
 *
 * The secret is issued as a base64 string decoding to either a 32-byte Ed25519 seed or a 64-byte
 * seed-plus-public-key pair; in the 64-byte form the first 32 bytes are the seed. Node's crypto
 * has no "from seed" constructor, so the seed is wrapped in the fixed PKCS8 DER prefix for
 * Ed25519 - sixteen constant bytes followed by the seed - which is byte-for-byte the standard
 * encoding and keeps this package at zero runtime dependencies.
 */

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
/** SPKI DER prefix for an Ed25519 public key: twelve constant bytes then the 32 raw key bytes. */
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export class AuthError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AuthError";
	}
}

/** Parses the base64 secret into a signing key, accepting both issued shapes. */
export function privateKeyFromSecret(secretBase64: string): KeyObject {
	let raw: Buffer;
	try {
		raw = Buffer.from(secretBase64, "base64");
	} catch {
		throw new AuthError("secret key is not valid base64");
	}
	if (raw.length !== 32 && raw.length !== 64) {
		throw new AuthError(`secret key must decode to 32 or 64 bytes, got ${raw.length}`);
	}
	const seed = raw.subarray(0, 32);
	return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
}

/** Builds a verification key from 32 raw public-key bytes; the checking fake uses this. */
export function publicKeyFromRaw(publicKeyBytes: Buffer): KeyObject {
	if (publicKeyBytes.length !== 32) {
		throw new AuthError(`public key must be 32 bytes, got ${publicKeyBytes.length}`);
	}
	return createPublicKey({
		key: Buffer.concat([SPKI_ED25519_PREFIX, publicKeyBytes]),
		format: "der",
		type: "spki",
	});
}

/** Raw 32 public-key bytes for a private key, for registering a key pair with the fake. */
export function rawPublicKey(privateKey: KeyObject): Buffer {
	const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
	return Buffer.from(spki.subarray(spki.length - 32));
}

// A type alias rather than an interface so it stays assignable to Record<string, string> - the
// shape header-carrying transports (the raw WebSocket client, http.request) expect.
export type AuthHeaders = {
	readonly "X-PM-Access-Key": string;
	readonly "X-PM-Timestamp": string;
	readonly "X-PM-Signature": string;
};

/**
 * Signs one request.
 *
 * `path` must be the bare path (`/v1/orders`), never including the query string - the SDK passes
 * query parameters outside the signed message, and signing them here would make every
 * parameterised request fail verification server-side.
 */
export function createAuthHeaders(
	keyId: string,
	privateKey: KeyObject,
	method: string,
	path: string,
	nowMs: number,
): AuthHeaders {
	if (path.includes("?")) {
		throw new AuthError("sign the bare path: the query string is not part of the signed message");
	}
	const timestamp = String(Math.trunc(nowMs));
	const message = Buffer.from(`${timestamp}${method.toUpperCase()}${path}`, "utf8");
	const signature = sign(null, message, privateKey);
	return {
		"X-PM-Access-Key": keyId,
		"X-PM-Timestamp": timestamp,
		"X-PM-Signature": signature.toString("base64"),
	};
}

/** Verifies a signature the way the server does. The checking fake is the caller. */
export function verifyAuthMessage(
	publicKey: KeyObject,
	timestamp: string,
	method: string,
	path: string,
	signatureBase64: string,
): boolean {
	const message = Buffer.from(`${timestamp}${method.toUpperCase()}${path}`, "utf8");
	let signature: Buffer;
	try {
		signature = Buffer.from(signatureBase64, "base64");
	} catch {
		return false;
	}
	if (signature.length !== 64) return false;
	return verify(null, message, publicKey, signature);
}

/** Stable fingerprint for logging a key WITHOUT ever logging the key. */
export function keyFingerprint(secretBase64: string): string {
	return createHash("sha256").update(secretBase64).digest("hex").slice(0, 8);
}
