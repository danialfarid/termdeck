// TermDeck Remote relay on Cloudflare: the Cloud Run relay (remote_service/application.py) ported to a Worker
// plus one Durable Object per Google account. The object holds that account's computer connection and the
// browser websockets multiplexed over it, using WebSocket hibernation: an open connection that is not
// carrying traffic costs nothing, so the computer stays connected instead of polling the relay for demand.
import { DurableObject } from "cloudflare:workers";
import { decode, encode } from "@msgpack/msgpack";
import idleHtml from "../../static/idle.html";
import loginHtml from "../../static/login.html";
import offlineHtml from "../../static/offline.html";
import { verifyGoogleCredential } from "./google.js";
import { CONNECTOR_SALT, LOGIN_CSRF_SALT, SESSION_SALT, dumps, loads, randomToken, sha256Hex, verifyIdentity }
  from "./signing.js";

const SESSION_COOKIE = "termdeck_remote_session";
const PREFIX = "/_remote";
const PROTOCOL_VERSION = 1;
const FORWARDED_HEADER_EXCLUSIONS = new Set(["connection", "host", "proxy-connection", "transfer-encoding", "upgrade"]);
const RESPONSE_HEADER_EXCLUSIONS = new Set(["connection", "content-length", "transfer-encoding"]);
const INTERNAL_HEADER_PREFIX = "x-relay-";
const RATE_WINDOW_MS = 3600 * 1000;

function relayConfig(env) {
  const number = (name, fallback) => Number(env[name] ?? fallback);
  const publicUrl = String(env.TERMDECK_REMOTE_PUBLIC_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");
  return {
    googleClientId: String(env.TERMDECK_REMOTE_GOOGLE_CLIENT_ID || ""),
    sessionSecret: String(env.TERMDECK_REMOTE_SESSION_SECRET || ""),
    publicUrl,
    publicOrigin: new URL(publicUrl).origin,
    cookieSecure: publicUrl.startsWith("https://"),
    sessionMaxAge: number("TERMDECK_REMOTE_SESSION_MAX_AGE", 43200),
    connectorMaxAge: number("TERMDECK_REMOTE_CONNECTOR_MAX_AGE", 2592000),
    pairingMaxAge: number("TERMDECK_REMOTE_PAIRING_MAX_AGE", 600),
    requestTimeoutMs: number("TERMDECK_REMOTE_REQUEST_TIMEOUT", 60) * 1000,
    maxBodyBytes: number("TERMDECK_REMOTE_MAX_BODY_BYTES", 25165824),
    browserIdleSeconds: number("TERMDECK_REMOTE_BROWSER_IDLE_SECONDS", 120),
    anonymousRequestsPerHour: number("TERMDECK_REMOTE_ANONYMOUS_REQUESTS_PER_HOUR", 30),
    connectorWaitMs: number("TERMDECK_REMOTE_CONNECTOR_WAIT_SECONDS", 15) * 1000,
    // Local end-to-end tests only: accepts "test:<sub>:<email>" as a Google credential. Ignored unless the
    // relay is also served from a loopback address, so a stray setting cannot open a deployed relay.
    insecureTestIdentity: env.TERMDECK_REMOTE_TEST_INSECURE_IDENTITY === "1" &&
      /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(publicUrl),
  };
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json", ...headers },
  });
}

function detail(status, message) {
  return json({ detail: message }, status);
}

function html(body, status = 200, headers = {}) {
  return new Response(body, {
    status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function embedConfig(page, placeholder, config) {
  return page.replace(placeholder, JSON.stringify(config).replaceAll("</", "<\\/"));
}

function safeReturnTo(returnTo) {
  return typeof returnTo === "string" && returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/";
}

function cookie(request, name) {
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim().replace(/^"|"$/g, "");
  }
  return "";
}

function bearerToken(request) {
  const authorization = request.headers.get("authorization") || "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
}

// A request the browser made to show a page, as opposed to one the deck's scripts made.
function isNavigation(request) {
  const mode = request.headers.get("sec-fetch-mode") || "";
  if (mode) return mode === "navigate";
  return (request.headers.get("accept") || "").includes("text/html");
}

function loginRedirect(returnTo) {
  return new Response(null, {
    status: 303,
    headers: { location: `${PREFIX}/login?return_to=${encodeURIComponent(returnTo)}`, "cache-control": "no-store" },
  });
}

function requestTarget(url) {
  return url.pathname + url.search;
}

// A close code a server may send. The computer passes on whatever its local socket ended with, which can be
// 1005 or 1006 -- codes that only describe a close and cannot be sent.
function sendableCloseCode(code) {
  return code === 1000 || code === 1001 || (code >= 1007 && code <= 1014) || code === 1003 ||
    (code >= 3000 && code <= 4999) ? code : 1000;
}

function closeQuietly(socket, code, reason = "") {
  try {
    socket.close(sendableCloseCode(code), reason.slice(0, 120));
  } catch {
    // Already closed.
  }
}

function sameDigest(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

const rateWindows = new Map();

// Per isolate, so best effort -- as the Cloud Run relay's in-memory limiter was per instance.
function allowAnonymous(request, operation, limit) {
  const key = `${operation}:${request.headers.get("cf-connecting-ip") || "unknown"}`;
  const now = Date.now();
  const recent = (rateWindows.get(key) || []).filter((stamp) => stamp > now - RATE_WINDOW_MS);
  if (recent.length >= limit) {
    rateWindows.set(key, recent);
    return false;
  }
  recent.push(now);
  rateWindows.set(key, recent);
  return true;
}

function userStub(env, userId) {
  return env.RELAY_USERS.get(env.RELAY_USERS.idFromName(userId));
}

function pairingStub(env, pairingId) {
  return env.RELAY_PAIRINGS.get(env.RELAY_PAIRINGS.idFromName(pairingId));
}

// Hands a request to the account's object with who it is, after the Worker has checked the credential.
// The x-relay-* headers are always rebuilt here, so a browser cannot supply its own.
function toUser(env, request, op, user, extra = {}) {
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (!name.toLowerCase().startsWith(INTERNAL_HEADER_PREFIX)) headers.append(name, value);
  }
  headers.set("x-relay-op", op);
  headers.set("x-relay-user", user.userId);
  headers.set("x-relay-email", user.email);
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return userStub(env, user.userId).fetch(new Request(request, { headers }));
}

async function connectorUser(config, token) {
  const user = await verifyIdentity(config.sessionSecret, CONNECTOR_SALT, token, config.connectorMaxAge);
  return user ? { user, digest: await sha256Hex(token) } : null;
}

async function browserUser(config, request) {
  return verifyIdentity(config.sessionSecret, SESSION_SALT, cookie(request, SESSION_COOKIE), config.sessionMaxAge);
}

async function verifyLogin(config, credential) {
  if (config.insecureTestIdentity && String(credential).startsWith("test:")) {
    const [, userId, email] = String(credential).split(":");
    return { userId, email };
  }
  return verifyGoogleCredential(credential, config.googleClientId);
}

async function handleRelay(request, env) {
  const config = relayConfig(env);
  const url = new URL(request.url);
  const path = url.pathname;
  const upgrade = (request.headers.get("upgrade") || "").toLowerCase() === "websocket";

  if (path === `${PREFIX}/health`) return json({ ok: true });

  if (path === `${PREFIX}/login` && request.method === "GET") {
    const csrfToken = await dumps(config.sessionSecret, LOGIN_CSRF_SALT, { nonce: randomToken(24) });
    return html(embedConfig(loginHtml, "__TERMDECK_REMOTE_LOGIN_CONFIG__", {
      googleClientId: config.googleClientId, csrfToken, pairingId: url.searchParams.get("pair") || "",
      returnTo: safeReturnTo(url.searchParams.get("return_to") || "/"),
    }));
  }

  if (path === `${PREFIX}/idle` && request.method === "GET") {
    // A page, so an expired session goes to the login page rather than a 401 a phone cannot get past.
    const returnTo = safeReturnTo(url.searchParams.get("return_to") || "/");
    if (!await browserUser(config, request)) return loginRedirect(returnTo);
    return html(embedConfig(idleHtml, "__TERMDECK_REMOTE_IDLE_CONFIG__", { returnTo }));
  }

  if (path === `${PREFIX}/auth/google` && request.method === "POST") {
    if (!allowAnonymous(request, "login", config.anonymousRequestsPerHour)) {
      return detail(429, "too many authentication requests");
    }
    const payload = await request.json().catch(() => null);
    if (!payload || typeof payload.credential !== "string" || typeof payload.csrf_token !== "string") {
      return detail(422, "credential and csrf_token are required");
    }
    const csrf = await loads(config.sessionSecret, LOGIN_CSRF_SALT, payload.csrf_token, config.pairingMaxAge);
    if (!csrf || typeof csrf.nonce !== "string" || !csrf.nonce) return detail(403, "login CSRF validation failed");
    if ((request.headers.get("origin") || "") !== config.publicOrigin) return detail(403, "login origin is not allowed");
    let user;
    try {
      user = await verifyLogin(config, payload.credential);
    } catch (identityError) {
      return detail(401, identityError.message);
    }
    const pairingId = typeof payload.pairing_id === "string" ? payload.pairing_id : "";
    if (pairingId) {
      const pairing = pairingStub(env, pairingId);
      const record = await (await pairing.fetch("https://pairing/live", { method: "POST" })).json();
      if (!record.live) return detail(410, "pairing request expired");
      const connectorToken = await dumps(config.sessionSecret, CONNECTOR_SALT,
        { sub: user.userId, email: user.email, nonce: randomToken(24) });
      await userStub(env, user.userId).fetch("https://user/save-token", {
        method: "POST", headers: { "x-relay-op": "save-token", "x-relay-user": user.userId, "x-relay-email": user.email,
          "x-relay-token-digest": await sha256Hex(connectorToken) },
      });
      await pairing.fetch("https://pairing/complete", {
        method: "POST", body: JSON.stringify({ connector_token: connectorToken, email: user.email }),
      });
    }
    const session = await dumps(config.sessionSecret, SESSION_SALT, { sub: user.userId, email: user.email });
    return json({ redirect: safeReturnTo(payload.return_to || "/") }, 200, {
      "set-cookie": `${SESSION_COOKIE}=${session}; HttpOnly; Max-Age=${config.sessionMaxAge}; Path=/; SameSite=lax` +
        (config.cookieSecure ? "; Secure" : ""),
    });
  }

  if (path === `${PREFIX}/logout` && request.method === "POST") {
    if ((request.headers.get("origin") || "") !== config.publicOrigin) return detail(403, "request origin is not allowed");
    return json({ ok: true }, 200, {
      "set-cookie": `${SESSION_COOKIE}=""; expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Path=/; SameSite=lax`,
    });
  }

  if (path === `${PREFIX}/status` && request.method === "GET") {
    const user = await browserUser(config, request);
    if (!user) return detail(401, "Google login required");
    return toUser(env, request, "status", user);
  }

  if (path === `${PREFIX}/api/pairings` && request.method === "POST") {
    if (!allowAnonymous(request, "pair", config.anonymousRequestsPerHour)) {
      return detail(429, "too many authentication requests");
    }
    const pairingId = randomToken(18);
    const pairingSecret = randomToken(32);
    await pairingStub(env, pairingId).fetch("https://pairing/create", {
      method: "POST", body: JSON.stringify({ secret_digest: await sha256Hex(pairingSecret), max_age: config.pairingMaxAge }),
    });
    return json({ pairing_id: pairingId, pairing_secret: pairingSecret,
      login_url: `${config.publicUrl}${PREFIX}/login?pair=${encodeURIComponent(pairingId)}` });
  }

  const pairingResult = /^\/_remote\/api\/pairings\/([A-Za-z0-9_-]{1,64})\/result$/.exec(path);
  if (pairingResult && request.method === "POST") {
    const payload = await request.json().catch(() => null);
    if (!payload || typeof payload.pairing_secret !== "string") return detail(422, "pairing_secret is required");
    return pairingStub(env, pairingResult[1]).fetch("https://pairing/result", {
      method: "POST", body: JSON.stringify({ secret_digest: await sha256Hex(payload.pairing_secret) }),
    });
  }

  if ((path === `${PREFIX}/api/connectors/revoke` || path === `${PREFIX}/api/connectors/demand`) &&
      request.method === "POST") {
    const connector = await connectorUser(config, bearerToken(request));
    if (!connector) return detail(401, "connector token is invalid");
    return toUser(env, request, path.endsWith("/revoke") ? "revoke" : "demand", connector.user,
      { "x-relay-token-digest": connector.digest });
  }

  if (path === `${PREFIX}/connector`) {
    if (!upgrade) return detail(426, "websocket required");
    const connector = await connectorUser(config, bearerToken(request));
    if (!connector) return rejectedConnector();
    return toUser(env, request, "connector", connector.user, { "x-relay-token-digest": connector.digest });
  }

  const user = await browserUser(config, request);
  if (upgrade) {
    if (!user || (request.headers.get("origin") || "") !== config.publicOrigin) return new Response(null, { status: 403 });
    return toUser(env, request, "ws", user);
  }
  if (!user) {
    // Only a navigation goes to the login page; the deck's own fetches get a 401 they can act on.
    if (!isNavigation(request)) return detail(401, "Google login required");
    return loginRedirect(requestTarget(url));
  }
  if (!["GET", "HEAD"].includes(request.method) && (request.headers.get("origin") || "") !== config.publicOrigin) {
    return detail(403, "request origin is not allowed");
  }
  if (Number(request.headers.get("content-length") || 0) > config.maxBodyBytes) {
    return detail(413, "remote request body is too large");
  }
  return toUser(env, request, "http", user);
}

// The connector reads the reason off the close, as it did from the Cloud Run relay.
function rejectedConnector() {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  server.send(encode({ type: "error", text: "connector authentication failed" }));
  server.close(4401, "connector authentication failed");
  return new Response(null, { status: 101, webSocket: client });
}

export default {
  async fetch(request, env) {
    return handleRelay(request, env);
  },
};

export class RelayUser extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.config = relayConfig(env);
    this.pendingHttp = new Map();
    this.pendingOpen = new Map();
  }

  async fetch(request) {
    const op = request.headers.get("x-relay-op");
    if (op === "save-token") {
      await this.ctx.storage.put({ token_digest: request.headers.get("x-relay-token-digest"),
        email: request.headers.get("x-relay-email") });
      return json({ saved: true });
    }
    if (op === "status") return this.status(request);
    if (op === "http") return this.proxyHttp(request);
    if (op === "ws") return this.proxyWebSocket(request);
    const digestMatches = sameDigest(await this.ctx.storage.get("token_digest"), request.headers.get("x-relay-token-digest"));
    if (op === "connector") return digestMatches ? this.acceptConnector() : rejectedConnector();
    if (!digestMatches) return detail(401, "connector token is invalid");
    if (op === "demand") {
      // Ask the computer to connect whenever it is not: an idle connection costs nothing here, and holding
      // one open is what lets a phone reach the computer without the computer polling.
      return json({ connect: this.connector() === null });
    }
    if (op === "revoke") {
      await this.ctx.storage.delete(["token_digest", "email"]);
      const connector = this.connector();
      if (connector) closeQuietly(connector, 4003, "remote access revoked");
      return json({ revoked: true });
    }
    return detail(404, "unknown relay operation");
  }

  connector() {
    return this.ctx.getWebSockets("connector").find((socket) => socket.deserializeAttachment()?.ready) || null;
  }

  status(request) {
    return json({ email: request.headers.get("x-relay-email"), connected: this.connector() !== null, idle_seconds: this.config.browserIdleSeconds });
  }

  acceptConnector() {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, ["connector"]);
    server.serializeAttachment({ role: "connector", ready: false });
    return new Response(null, { status: 101, webSocket: client });
  }

  // The computer, waiting up to connectorWaitMs for it to dial in: the first requests after a phone wakes
  // can arrive before it does, and holding them lets them succeed instead of failing and being retried.
  async waitForConnector() {
    const deadline = Date.now() + this.config.connectorWaitMs;
    for (;;) {
      const connector = this.connector();
      if (connector) return connector;
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  send(connector, message) {
    connector.send(encode(message, { ignoreUndefined: true }));
  }

  forwardedHeaders(request) {
    const headers = [];
    for (const [name, value] of request.headers) {
      const lower = name.toLowerCase();
      if (!FORWARDED_HEADER_EXCLUSIONS.has(lower) && !lower.startsWith(INTERNAL_HEADER_PREFIX)) headers.push([name, value]);
    }
    return headers;
  }

  async proxyHttp(request) {
    let connector = this.connector();
    if (!connector && !isNavigation(request)) connector = await this.waitForConnector();
    if (!connector) {
      return html(embedConfig(offlineHtml, "__TERMDECK_REMOTE_OFFLINE_CONFIG__",
        { email: request.headers.get("x-relay-email") }), 503, { "retry-after": "3" });
    }
    const body = new Uint8Array(await request.arrayBuffer());
    if (body.length > this.config.maxBodyBytes) return detail(413, "remote request body is too large");
    const url = new URL(request.url);
    const requestId = randomToken(16);
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), this.config.requestTimeoutMs);
      this.pendingHttp.set(requestId, { resolve, reject, timer });
    });
    try {
      this.send(connector, { type: "http_request", request_id: requestId, method: request.method, path: url.pathname,
        query: url.search.slice(1), headers: this.forwardedHeaders(request), body });
      const response = await reply;
      const headers = new Headers();
      for (const [name, value] of response.headers || []) {
        if (!RESPONSE_HEADER_EXCLUSIONS.has(String(name).toLowerCase())) headers.append(name, value);
      }
      const status = response.status || 502;
      const empty = request.method === "HEAD" || status === 204 || status === 304;
      return new Response(empty ? null : (response.body || new Uint8Array()), { status, headers });
    } catch (relayError) {
      return relayError.message === "timeout" ? detail(504, "local TermDeck request timed out")
        : detail(503, relayError.message);
    } finally {
      const pending = this.pendingHttp.get(requestId);
      if (pending) clearTimeout(pending.timer);
      this.pendingHttp.delete(requestId);
    }
  }

  async proxyWebSocket(request) {
    const connector = await this.waitForConnector();
    if (!connector) return new Response(null, { status: 503 });
    const url = new URL(request.url);
    const channelId = randomToken(16);
    // Anything the computer sends between saying the socket is open and the browser's end being accepted
    // waits here rather than being dropped.
    const early = [];
    const opening = new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ type: "error", text: "timeout" }), this.config.requestTimeoutMs);
      this.pendingOpen.set(channelId, { resolve: (message) => { clearTimeout(timer); resolve(message); }, early });
    });
    this.send(connector, { type: "ws_open", channel_id: channelId, path: url.pathname, query: url.search.slice(1),
      headers: this.forwardedHeaders(request) });
    const opened = await opening;
    this.pendingOpen.delete(channelId);
    if (opened.type !== "ws_opened") return new Response(null, { status: 502 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, ["browser", `ch:${channelId}`]);
    server.serializeAttachment({ role: "browser", channel: channelId });
    for (const message of early) this.deliverToBrowser(server, message);
    return new Response(null, { status: 101, webSocket: client });
  }

  deliverToBrowser(socket, message) {
    if (message.type === "ws_server_binary") socket.send(message.body || new Uint8Array());
    else if (message.type === "ws_server_text") socket.send(message.text || "");
    else if (message.type === "ws_close") closeQuietly(socket, message.code || 1000);
    else if (message.type === "error") closeQuietly(socket, 1011, message.text || "connector error");
  }

  async webSocketMessage(socket, payload) {
    const attachment = socket.deserializeAttachment() || {};
    if (attachment.role === "browser") {
      const connector = this.connector();
      if (!connector) {
        closeQuietly(socket, 1011, "local TermDeck connector disconnected");
        return;
      }
      this.send(connector, typeof payload === "string"
        ? { type: "ws_client_text", channel_id: attachment.channel, text: payload }
        : { type: "ws_client_binary", channel_id: attachment.channel, body: new Uint8Array(payload) });
      return;
    }
    if (typeof payload === "string") {
      closeQuietly(socket, 1003, "relay expects binary messages");
      return;
    }
    let message;
    try {
      message = decode(new Uint8Array(payload));
    } catch {
      closeQuietly(socket, 1003, "invalid remote message");
      return;
    }
    if (!attachment.ready) {
      if (message.type !== "hello" || message.protocol !== PROTOCOL_VERSION) {
        this.send(socket, { type: "error", text: "connector authentication failed" });
        closeQuietly(socket, 4401, "connector authentication failed");
        return;
      }
      for (const previous of this.ctx.getWebSockets("connector")) {
        if (previous !== socket) closeQuietly(previous, 4001, "another TermDeck computer connected for this account");
      }
      socket.serializeAttachment({ role: "connector", ready: true });
      this.send(socket, { type: "hello_accepted", protocol: PROTOCOL_VERSION });
      return;
    }
    this.fromConnector(message);
  }

  fromConnector(message) {
    if (message.type === "http_response") {
      this.pendingHttp.get(message.request_id)?.resolve(message);
      return;
    }
    const channelId = message.channel_id || "";
    const opening = this.pendingOpen.get(channelId);
    if (opening) {
      if (message.type === "ws_opened" || message.type === "error") opening.resolve(message);
      else opening.early.push(message);
      return;
    }
    const browser = this.ctx.getWebSockets(`ch:${channelId}`)[0];
    if (browser) this.deliverToBrowser(browser, message);
  }

  async webSocketClose(socket, code, reason) {
    this.socketEnded(socket, code, reason);
  }

  async webSocketError(socket) {
    this.socketEnded(socket, 1011, "websocket error");
  }

  socketEnded(socket, code, reason) {
    const attachment = socket.deserializeAttachment() || {};
    closeQuietly(socket, code, reason || "");
    if (attachment.role === "browser") {
      const connector = this.connector();
      if (connector) this.send(connector, { type: "ws_close", channel_id: attachment.channel, code: 1000 });
      return;
    }
    if (!attachment.ready || this.connector()) return;
    for (const pending of this.pendingHttp.values()) pending.reject(new Error("local TermDeck connector disconnected"));
    for (const pending of this.pendingOpen.values()) pending.resolve({ type: "error", text: "connector disconnected" });
    for (const browser of this.ctx.getWebSockets("browser")) {
      closeQuietly(browser, 1011, "local TermDeck connector disconnected");
    }
  }
}

export class RelayPairing extends DurableObject {
  async fetch(request) {
    const op = new URL(request.url).pathname.slice(1);
    const record = await this.ctx.storage.get("record");
    const live = record && Date.now() - record.created_ms <= record.max_age * 1000;
    if (op === "create") {
      const { secret_digest: secretDigest, max_age: maxAge } = await request.json();
      await this.ctx.storage.put("record", { secret_digest: secretDigest, max_age: maxAge, created_ms: Date.now() });
      await this.ctx.storage.setAlarm(Date.now() + (maxAge + 60) * 1000);
      return json({ created: true });
    }
    if (op === "live") return json({ live: Boolean(live) });
    if (op === "complete") {
      if (!live) return detail(410, "pairing request expired");
      const { connector_token: connectorToken, email } = await request.json();
      await this.ctx.storage.put("record", { ...record, connector_token: connectorToken, email });
      return json({ completed: true });
    }
    if (op === "result") {
      if (!live) return json({ state: "expired" });
      const { secret_digest: secretDigest } = await request.json();
      if (!sameDigest(record.secret_digest, secretDigest)) return detail(403, "pairing secret does not match");
      if (!record.connector_token) return json({ state: "pending" });
      return json({ state: "complete", connector_token: record.connector_token, email: record.email });
    }
    return detail(404, "unknown pairing operation");
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}
