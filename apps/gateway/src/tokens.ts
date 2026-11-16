import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Browser-execution tokens.
 *
 * Before its first event the tracker asks for a challenge, does a small amount
 * of hashing work in JavaScript and trades the answer for a short-lived token.
 * Challenge and token are both stateless: an HMAC over their contents, bound to
 * one website and one origin.
 *
 * This raises the cost of a server-side loop and leaves a trace. It does not
 * prove a human is present: a script that runs the same computation passes.
 */

export interface ChallengePayload {
  /** Website id. */
  w: string;
  /** Origin the challenge was issued to. */
  o: string;
  /** Random nonce. */
  n: string;
  /** Expiry, epoch seconds. */
  exp: number;
  /** Required leading zero bits. */
  bits: number;
}

export interface TokenPayload {
  w: string;
  o: string;
  exp: number;
}

export type Verified<T> = { ok: true; payload: T } | { ok: false; reason: "malformed" | "bad-signature" | "expired" };

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(secret: string, kind: string, body: string): string {
  return createHmac("sha256", secret).update(`${kind}.${body}`).digest("base64url");
}

function seal(secret: string, kind: "c" | "t", payload: object): string {
  const body = b64url(JSON.stringify(payload));
  return `${kind}.${body}.${sign(secret, kind, body)}`;
}

function open<T extends { exp: number }>(secret: string, kind: "c" | "t", value: unknown, now: number): Verified<T> {
  if (typeof value !== "string" || value.length > 1024) return { ok: false, reason: "malformed" };
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== kind) return { ok: false, reason: "malformed" };
  const body = parts[1] as string;
  const given = Buffer.from(parts[2] as string, "base64url");
  const expected = Buffer.from(sign(secret, kind, body), "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: "bad-signature" };
  }
  let payload: T;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof payload.exp !== "number" || payload.exp < now) return { ok: false, reason: "expired" };
  return { ok: true, payload };
}

export function issueChallenge(
  secret: string,
  website: string,
  origin: string,
  now: number,
  bits: number,
  ttlSeconds = 120,
): string {
  const payload: ChallengePayload = { w: website, o: origin, n: randomBytes(12).toString("base64url"), exp: now + ttlSeconds, bits };
  return seal(secret, "c", payload);
}

export function verifyChallenge(secret: string, challenge: unknown, now: number): Verified<ChallengePayload> {
  return open<ChallengePayload>(secret, "c", challenge, now);
}

/** Counts the leading zero bits of a hash. */
export function leadingZeroBits(hash: Buffer): number {
  let bits = 0;
  for (const byte of hash) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

/** True when SHA-256(`challenge:counter`) has at least `bits` leading zero bits. */
export function checkWork(challenge: string, counter: number, bits: number): boolean {
  if (!Number.isSafeInteger(counter) || counter < 0) return false;
  const hash = createHash("sha256").update(`${challenge}:${counter}`).digest();
  return leadingZeroBits(hash) >= bits;
}

/** Solves a challenge. Used by tests and by the demo traffic script. */
export function solveWork(challenge: string, bits: number): number {
  for (let counter = 0; ; counter++) {
    if (checkWork(challenge, counter, bits)) return counter;
  }
}

export function issueToken(secret: string, website: string, origin: string, now: number, ttlSeconds = 1800): string {
  const payload: TokenPayload = { w: website, o: origin, exp: now + ttlSeconds };
  return seal(secret, "t", payload);
}

export function verifyToken(secret: string, token: unknown, now: number): Verified<TokenPayload> {
  return open<TokenPayload>(secret, "t", token, now);
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
