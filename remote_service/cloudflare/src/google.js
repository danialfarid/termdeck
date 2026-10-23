import { base64UrlDecode } from "./signing.js";

const GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const CLOCK_SKEW_SECONDS = 60;
const decoder = new TextDecoder();

let cachedKeys = { keys: new Map(), expiresAtMs: 0 };

async function googleKeys() {
  if (cachedKeys.expiresAtMs > Date.now()) return cachedKeys.keys;
  const response = await fetch(GOOGLE_CERTS_URL);
  if (!response.ok) throw new Error(`Google certificates unavailable (${response.status})`);
  const maxAge = Number(/max-age=(\d+)/.exec(response.headers.get("cache-control") || "")?.[1] || 3600);
  const keys = new Map();
  for (const jwk of (await response.json()).keys || []) {
    keys.set(jwk.kid, await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false, ["verify"]));
  }
  cachedKeys = { keys, expiresAtMs: Date.now() + maxAge * 1000 };
  return keys;
}

// The Google account behind a Sign in with Google credential, as {userId, email}. Throws when it is not a
// valid, unexpired ID token issued for this client with a verified email.
export async function verifyGoogleCredential(credential, clientId) {
  const parts = String(credential || "").split(".");
  if (parts.length !== 3) throw new Error("Google identity verification failed");
  const header = JSON.parse(decoder.decode(base64UrlDecode(parts[0])));
  const payload = JSON.parse(decoder.decode(base64UrlDecode(parts[1])));
  if (header.alg !== "RS256") throw new Error("Google identity verification failed");
  const key = (await googleKeys()).get(header.kid);
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  if (!key || !await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64UrlDecode(parts[2]), signed)) {
    throw new Error("Google identity verification failed");
  }
  const now = Date.now() / 1000;
  if (payload.aud !== clientId || !GOOGLE_ISSUERS.has(payload.iss) || !(payload.exp + CLOCK_SKEW_SECONDS > now) ||
      (payload.iat && payload.iat - CLOCK_SKEW_SECONDS > now)) {
    throw new Error("Google identity verification failed");
  }
  if (payload.email_verified !== true) throw new Error("Google email is not verified");
  if (typeof payload.sub !== "string" || !payload.sub || typeof payload.email !== "string" || !payload.email) {
    throw new Error("Google identity is missing sub or email");
  }
  return { userId: payload.sub, email: payload.email };
}
