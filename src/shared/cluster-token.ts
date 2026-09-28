import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";


export function resolveClusterKey(): string {
  const explicit = (process.env.NOMSOD_CLUSTER_KEY || "").trim();
  if (explicit) return explicit;

  const pairingToken = (process.env.NOMSOD_PAIRING_TOKEN || "").trim();
  if (!pairingToken) return "";

  return createHash("sha256")
    .update("nomsod-cluster-v1\0")
    .update(pairingToken)
    .digest("base64url");
}
interface SignedEnvelope<T> {
  v: 1;
  iat: number;
  exp?: number;
  nonce: string;
  payload: T;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function signature(prefix: string, body: string, key: string): string {
  return createHmac("sha256", key)
    .update(prefix)
    .update(".")
    .update(body)
    .digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function signClusterToken<T>(
  prefix: string,
  payload: T,
  key: string,
  ttlSeconds?: number
): string {
  if (!key) throw new Error("NOMSOD_CLUSTER_KEY is required for cluster tokens.");

  const now = Math.floor(Date.now() / 1000);
  const envelope: SignedEnvelope<T> = {
    v: 1,
    iat: now,
    exp: ttlSeconds ? now + ttlSeconds : undefined,
    nonce: randomBytes(12).toString("base64url"),
    payload
  };

  const body = encode(envelope);
  return `${prefix}.${body}.${signature(prefix, body, key)}`;
}

export function verifyClusterToken<T>(
  token: string,
  prefix: string,
  key: string
): T | undefined {
  if (!key) return undefined;

  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== prefix) return undefined;

  const [, body, provided] = parts;
  const expected = signature(prefix, body, key);
  if (!safeEqual(provided, expected)) return undefined;

  try {
    const envelope = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8")
    ) as SignedEnvelope<T>;

    if (envelope.v !== 1 || !envelope.payload) return undefined;
    if (envelope.exp && envelope.exp <= Math.floor(Date.now() / 1000)) return undefined;

    return envelope.payload;
  } catch {
    return undefined;
  }
}
