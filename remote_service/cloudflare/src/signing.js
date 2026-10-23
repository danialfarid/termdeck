// itsdangerous-compatible signed tokens (URLSafeTimedSerializer: compact JSON, HMAC-SHA1, django-concat key
// derivation). Compatible so the Cloud Run relay's browser sessions keep working across the move, and so the
// Python tests can mint and read the same tokens.

const encoder = new TextEncoder();
const decoder = new TextDecoder();
// itsdangerous counts from the Unix epoch.
const EPOCH = 0;

export const SESSION_SALT = "termdeck-browser-session";
export const CONNECTOR_SALT = "termdeck-local-connector";
export const LOGIN_CSRF_SALT = "termdeck-login-csrf";

export function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function base64UrlDecode(text) {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function concat(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

async function derivedKey(secret, salt) {
  const material = await crypto.subtle.digest("SHA-1", concat(encoder.encode(salt), encoder.encode("signer"),
    encoder.encode(secret)));
  return crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-1" }, false, ["sign", "verify"]);
}

function timestampBytes(seconds) {
  const bytes = [];
  let value = Math.floor(seconds) - EPOCH;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value = Math.floor(value / 256);
  }
  return new Uint8Array(bytes);
}

function timestampValue(bytes) {
  return bytes.reduce((value, byte) => value * 256 + byte, 0) + EPOCH;
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function dumps(secret, salt, payload, nowSeconds = Date.now() / 1000) {
  const body = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const value = `${body}.${base64UrlEncode(timestampBytes(nowSeconds))}`;
  const key = await derivedKey(secret, salt);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
  return `${value}.${base64UrlEncode(signature)}`;
}

// The payload, or null when the signature is wrong, the token is malformed, or it is older than maxAgeSeconds.
export async function loads(secret, salt, token, maxAgeSeconds, nowSeconds = Date.now() / 1000) {
  if (typeof token !== "string" || !token) return null;
  const signatureAt = token.lastIndexOf(".");
  if (signatureAt <= 0) return null;
  const value = token.slice(0, signatureAt);
  try {
    const key = await derivedKey(secret, salt);
    const valid = await crypto.subtle.verify("HMAC", key, base64UrlDecode(token.slice(signatureAt + 1)),
      encoder.encode(value));
    if (!valid) return null;
    const timestampAt = value.lastIndexOf(".");
    if (timestampAt <= 0) return null;
    const age = nowSeconds - timestampValue(base64UrlDecode(value.slice(timestampAt + 1)));
    if (age > maxAgeSeconds || age < 0) return null;
    let body = value.slice(0, timestampAt);
    const compressed = body.startsWith(".");
    if (compressed) body = body.slice(1);
    let bytes = base64UrlDecode(body);
    if (compressed) bytes = await inflate(bytes);
    return JSON.parse(decoder.decode(bytes));
  } catch {
    return null;
  }
}

export async function sha256Hex(text) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomToken(byteCount) {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(byteCount)));
}

// An identity token (browser session or connector): {sub, email}, or null.
export async function verifyIdentity(secret, salt, token, maxAgeSeconds) {
  const payload = await loads(secret, salt, token, maxAgeSeconds);
  if (!payload || typeof payload.sub !== "string" || typeof payload.email !== "string") return null;
  return { userId: payload.sub, email: payload.email };
}
