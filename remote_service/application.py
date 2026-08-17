import asyncio
import json
import uuid
from pathlib import Path
from urllib.parse import quote, urlsplit

from fastapi import FastAPI, HTTPException, Request, Response, WebSocket
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from starlette.websockets import WebSocketDisconnect

from remote_service.auth import AuthenticatedUser, GoogleIdentityVerifier, SignedTokenService
from remote_service.config import RemoteServiceConfig
from remote_service.models import GoogleLoginRequest, PairingResultRequest
from remote_service.pairing import PairingService
from remote_service.rate_limit import SlidingWindowRateLimiter
from remote_service.registry import ConnectorConnection, ConnectorRegistry
from remote_service.token_store import ConnectorTokenStore, FirestoreConnectorTokenStore, MemoryConnectorTokenStore
from termdeck.remote_protocol import RemoteMessage, RemoteMessageCodec, RemoteMessageType


class RemoteRelayApplication:
    SESSION_COOKIE = "termdeck_remote_session"
    SPECIAL_PREFIX = "/_remote"
    STATIC_LOGIN_FILE = Path(__file__).resolve().parent / "static" / "login.html"
    STATIC_IDLE_FILE = Path(__file__).resolve().parent / "static" / "idle.html"
    STATIC_OFFLINE_FILE = Path(__file__).resolve().parent / "static" / "offline.html"
    FORWARDED_HEADER_EXCLUSIONS = frozenset({"connection", "host", "proxy-connection", "transfer-encoding", "upgrade"})
    RESPONSE_HEADER_EXCLUSIONS = frozenset({"connection", "content-length", "transfer-encoding"})

    def __init__(self, config: RemoteServiceConfig | None = None, token_store: ConnectorTokenStore | None = None,
                 identity_verifier: GoogleIdentityVerifier | None = None) -> None:
        self.config = config or RemoteServiceConfig.from_environment()
        self.token_store = token_store or self._build_token_store()
        self.identity_verifier = identity_verifier or GoogleIdentityVerifier(self.config.google_client_id)
        self.token_service = SignedTokenService(self.config.session_secret, self.config.session_max_age_seconds,
                                                self.config.connector_max_age_seconds,
                                                self.config.pairing_max_age_seconds)
        self.pairing_service = PairingService(self.token_service, self.token_store, self.config.pairing_max_age_seconds)
        self.registry = ConnectorRegistry()
        self.anonymous_rate_limiter = SlidingWindowRateLimiter(self.config.anonymous_requests_per_hour)
        self.public_origin = self._public_origin()
        self.app = self._build_app()

    def _build_token_store(self) -> ConnectorTokenStore:
        if self.config.firestore_project:
            return FirestoreConnectorTokenStore(self.config.firestore_project)
        return MemoryConnectorTokenStore()

    def _build_app(self) -> FastAPI:
        app = FastAPI(title="TermDeck Remote", docs_url=None, redoc_url=None)
        app.get(f"{self.SPECIAL_PREFIX}/health")(self.health)
        app.get(f"{self.SPECIAL_PREFIX}/login")(self.login_page)
        app.get(f"{self.SPECIAL_PREFIX}/idle")(self.idle_page)
        app.post(f"{self.SPECIAL_PREFIX}/auth/google")(self.google_login)
        app.post(f"{self.SPECIAL_PREFIX}/logout")(self.logout)
        app.get(f"{self.SPECIAL_PREFIX}/status")(self.remote_status)
        app.post(f"{self.SPECIAL_PREFIX}/api/pairings")(self.start_pairing)
        app.post(f"{self.SPECIAL_PREFIX}/api/pairings/{{pairing_id}}/result")(self.pairing_result)
        app.post(f"{self.SPECIAL_PREFIX}/api/connectors/revoke")(self.revoke_connector)
        app.post(f"{self.SPECIAL_PREFIX}/api/connectors/demand")(self.connector_demand)
        app.websocket(f"{self.SPECIAL_PREFIX}/connector")(self.connector_websocket)
        app.websocket("/{path:path}")(self.proxy_websocket)
        app.api_route("/{path:path}", methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"])(self.proxy_http)
        return app

    async def health(self) -> dict[str, object]:
        return {"ok": True, "connectors": self.registry.count()}

    async def login_page(self, request: Request, pair: str = "", return_to: str = "/") -> Response:
        safe_return_to = self._safe_return_to(return_to)
        login_config = {
            "googleClientId": self.config.google_client_id,
            "csrfToken": self.token_service.issue_login_csrf(),
            "pairingId": pair,
            "returnTo": safe_return_to,
        }
        html = self.STATIC_LOGIN_FILE.read_text().replace(
            "__TERMDECK_REMOTE_LOGIN_CONFIG__", json.dumps(login_config).replace("</", "<\\/"))
        return HTMLResponse(html, headers={"Cache-Control": "no-store"})

    async def idle_page(self, request: Request, return_to: str = "/") -> Response:
        self._require_browser_user(request)
        idle_config = {"returnTo": self._safe_return_to(return_to)}
        html = self.STATIC_IDLE_FILE.read_text().replace(
            "__TERMDECK_REMOTE_IDLE_CONFIG__", json.dumps(idle_config).replace("</", "<\\/"))
        return HTMLResponse(html, headers={"Cache-Control": "no-store"})

    async def google_login(self, request: Request, payload: GoogleLoginRequest) -> Response:
        self._require_anonymous_rate_limit(request, "login")
        if not self.token_service.verify_login_csrf(payload.csrf_token):
            raise HTTPException(status_code=403, detail="login CSRF validation failed")
        if request.headers.get("origin", "") != self.public_origin:
            raise HTTPException(status_code=403, detail="login origin is not allowed")
        try:
            user = await self.identity_verifier.verify(payload.credential)
        except ValueError as identity_error:
            raise HTTPException(status_code=401, detail=str(identity_error)) from identity_error
        if payload.pairing_id:
            try:
                await self.pairing_service.authorize(payload.pairing_id, user)
            except KeyError as missing_pairing:
                raise HTTPException(status_code=410, detail="pairing request expired") from missing_pairing
        redirect_target = self._safe_return_to(payload.return_to)
        response = JSONResponse({"redirect": redirect_target})
        response.set_cookie(self.SESSION_COOKIE, self.token_service.issue_session(user), secure=self.config.cookie_secure,
                            httponly=True, samesite="lax", max_age=self.config.session_max_age_seconds)
        return response

    async def logout(self, request: Request) -> Response:
        self._require_mutation_origin(request)
        response = JSONResponse({"ok": True})
        response.delete_cookie(self.SESSION_COOKIE)
        return response

    async def remote_status(self, request: Request) -> dict[str, object]:
        user = self._require_browser_user(request)
        connected = self.registry.get(user.user_id) is not None
        if not connected:
            self.registry.request_connection(user.user_id)
        return {"email": user.email, "connected": connected, "idle_seconds": self.config.browser_idle_seconds}

    async def start_pairing(self, request: Request) -> dict[str, str]:
        self._require_anonymous_rate_limit(request, "pair")
        try:
            pairing = await self.pairing_service.create()
        except RuntimeError as pairing_capacity_error:
            raise HTTPException(status_code=503, detail=str(pairing_capacity_error)) from pairing_capacity_error
        login_url = f"{self.config.public_url}{self.SPECIAL_PREFIX}/login?pair={quote(pairing['pairing_id'])}"
        return {**pairing, "login_url": login_url}

    async def pairing_result(self, pairing_id: str, payload: PairingResultRequest) -> dict[str, str]:
        try:
            return dict(await self.pairing_service.result(pairing_id, payload.pairing_secret))
        except PermissionError as pairing_error:
            raise HTTPException(status_code=403, detail=str(pairing_error)) from pairing_error

    async def revoke_connector(self, request: Request) -> dict[str, bool]:
        connector_token = self._bearer_token(request.headers.get("authorization", ""))
        user = self.token_service.verify_connector(connector_token)
        if user is None or not await self.token_store.matches(user.user_id, self.token_service.digest(connector_token)):
            raise HTTPException(status_code=401, detail="connector token is invalid")
        await self.token_store.revoke(user.user_id)
        await self.registry.revoke(user.user_id)
        return {"revoked": True}

    async def connector_demand(self, request: Request) -> dict[str, bool]:
        connector_token = self._bearer_token(request.headers.get("authorization", ""))
        user = self.token_service.verify_connector(connector_token)
        if user is None or not await self.token_store.matches(user.user_id, self.token_service.digest(connector_token)):
            raise HTTPException(status_code=401, detail="connector token is invalid")
        return {"connect": self.registry.connection_requested(user.user_id)}

    async def connector_websocket(self, websocket: WebSocket) -> None:
        await websocket.accept()
        try:
            payload = await asyncio.wait_for(websocket.receive_bytes(), timeout=15)
            hello = RemoteMessageCodec.decode(payload)
            connector_token = hello.get("token", "")
            user = self.token_service.verify_connector(connector_token)
            valid_token = user is not None and await self.token_store.matches(
                user.user_id, self.token_service.digest(connector_token))
            if hello["type"] != RemoteMessageType.HELLO or hello.get("protocol") != RemoteMessageCodec.PROTOCOL_VERSION or not valid_token:
                await websocket.send_bytes(RemoteMessageCodec.encode(
                    {"type": RemoteMessageType.ERROR, "text": "connector authentication failed"}))
                await websocket.close(code=4401)
                return
            connection = ConnectorConnection(user=user, websocket=websocket,
                                             request_timeout_seconds=self.config.relay_request_timeout_seconds,
                                             idle_seconds=self.config.connector_idle_seconds)
            await self.registry.register(connection)
            await connection.send({"type": RemoteMessageType.HELLO_ACCEPTED,
                                   "protocol": RemoteMessageCodec.PROTOCOL_VERSION})
            try:
                await connection.receive_until_closed()
            finally:
                await self.registry.unregister(connection)
        except (TimeoutError, ValueError, WebSocketDisconnect):
            await websocket.close(code=4401)

    async def proxy_http(self, request: Request, path: str = "") -> Response:
        user = self._browser_user(request.cookies.get(self.SESSION_COOKIE, ""))
        if user is None:
            return RedirectResponse(f"{self.SPECIAL_PREFIX}/login?return_to={quote(self._request_target(request))}", status_code=303)
        if request.method not in {"GET", "HEAD"}:
            self._require_mutation_origin(request)
        connector = self.registry.get(user.user_id)
        if connector is None:
            self.registry.request_connection(user.user_id)
            return HTMLResponse(self._offline_page(user), status_code=503, headers={"Retry-After": "3"})
        content_length = int(request.headers.get("content-length", "0") or "0")
        if content_length > self.config.max_body_bytes:
            raise HTTPException(status_code=413, detail="remote request body is too large")
        body = await request.body()
        if len(body) > self.config.max_body_bytes:
            raise HTTPException(status_code=413, detail="remote request body is too large")
        relay_request: RemoteMessage = {
            "type": RemoteMessageType.HTTP_REQUEST,
            "request_id": uuid.uuid4().hex,
            "method": request.method,
            "path": f"/{path}",
            "query": request.url.query,
            "headers": self._forwarded_headers(request.headers.items()),
            "body": body,
        }
        try:
            relay_response = await connector.request_http(relay_request)
        except TimeoutError as relay_timeout:
            raise HTTPException(status_code=504, detail="local TermDeck request timed out") from relay_timeout
        except ConnectionError as connector_error:
            raise HTTPException(status_code=503, detail=str(connector_error)) from connector_error
        return Response(content=relay_response.get("body", b""), status_code=relay_response.get("status", 502),
                        headers=dict(self._response_headers(relay_response.get("headers", []))))

    async def proxy_websocket(self, websocket: WebSocket, path: str) -> None:
        user = self._browser_user(websocket.cookies.get(self.SESSION_COOKIE, ""))
        if user is None or websocket.headers.get("origin", "") != self.public_origin:
            await websocket.close(code=4401)
            return
        connector = self.registry.get(user.user_id)
        if connector is None:
            self.registry.request_connection(user.user_id)
            await websocket.close(code=1013)
            return
        channel_id = uuid.uuid4().hex
        channel_queue = connector.create_channel(channel_id)
        try:
            await connector.send({"type": RemoteMessageType.WS_OPEN, "channel_id": channel_id, "path": f"/{path}",
                                  "query": websocket.url.query,
                                  "headers": self._forwarded_headers(websocket.headers.items())})
            opening = await asyncio.wait_for(channel_queue.get(), timeout=self.config.relay_request_timeout_seconds)
            if opening["type"] != RemoteMessageType.WS_OPENED:
                await websocket.close(code=1011)
                return
            await websocket.accept()
            browser_task = asyncio.create_task(self._pump_browser_to_connector(websocket, connector, channel_id))
            connector_task = asyncio.create_task(self._pump_connector_to_browser(websocket, channel_queue))
            done, pending = await asyncio.wait({browser_task, connector_task}, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
            for task in done:
                task.result()
        except (TimeoutError, ConnectionError, WebSocketDisconnect):
            return
        finally:
            connector.remove_channel(channel_id)
            try:
                await connector.send({"type": RemoteMessageType.WS_CLOSE, "channel_id": channel_id, "code": 1000})
            except ConnectionError:
                connector.closed = True

    async def _pump_browser_to_connector(self, websocket: WebSocket, connector: ConnectorConnection,
                                         channel_id: str) -> None:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                return
            if message.get("bytes") is not None:
                await connector.send({"type": RemoteMessageType.WS_CLIENT_BINARY, "channel_id": channel_id,
                                      "body": message["bytes"]})
            elif message.get("text") is not None:
                await connector.send({"type": RemoteMessageType.WS_CLIENT_TEXT, "channel_id": channel_id,
                                      "text": message["text"]})

    async def _pump_connector_to_browser(self, websocket: WebSocket,
                                         channel_queue: asyncio.Queue[RemoteMessage]) -> None:
        while True:
            message = await channel_queue.get()
            message_type = message["type"]
            if message_type == RemoteMessageType.WS_SERVER_BINARY:
                await websocket.send_bytes(message.get("body", b""))
            elif message_type == RemoteMessageType.WS_SERVER_TEXT:
                await websocket.send_text(message.get("text", ""))
            elif message_type == RemoteMessageType.WS_CLOSE:
                await websocket.close(code=message.get("code", 1000))
                return
            elif message_type == RemoteMessageType.ERROR:
                await websocket.close(code=1011, reason=message.get("text", "connector error"))
                return

    def _require_browser_user(self, request: Request) -> AuthenticatedUser:
        user = self._browser_user(request.cookies.get(self.SESSION_COOKIE, ""))
        if user is None:
            raise HTTPException(status_code=401, detail="Google login required")
        return user

    def _browser_user(self, session_token: str) -> AuthenticatedUser | None:
        return self.token_service.verify_session(session_token)

    def _require_mutation_origin(self, request: Request) -> None:
        if request.headers.get("origin", "") != self.public_origin:
            raise HTTPException(status_code=403, detail="request origin is not allowed")

    def _require_anonymous_rate_limit(self, request: Request, operation: str) -> None:
        forwarded_for = request.headers.get("x-forwarded-for", "").split(",", 1)[0].strip()
        client_host = forwarded_for or (request.client.host if request.client is not None else "unknown")
        if not self.anonymous_rate_limiter.allow(f"{operation}:{client_host}"):
            raise HTTPException(status_code=429, detail="too many authentication requests")

    def _public_origin(self) -> str:
        parsed = urlsplit(self.config.public_url)
        return f"{parsed.scheme}://{parsed.netloc}"

    def _request_target(self, request: Request) -> str:
        return request.url.path + (f"?{request.url.query}" if request.url.query else "")

    @staticmethod
    def _safe_return_to(return_to: str) -> str:
        return return_to if return_to.startswith("/") and not return_to.startswith("//") else "/"

    @staticmethod
    def _bearer_token(authorization: str) -> str:
        prefix = "Bearer "
        return authorization[len(prefix):].strip() if authorization.startswith(prefix) else ""

    def _forwarded_headers(self, headers: object) -> list[tuple[str, str]]:
        return [(str(name), str(value)) for name, value in headers
                if str(name).lower() not in self.FORWARDED_HEADER_EXCLUSIONS]

    def _response_headers(self, headers: list[tuple[str, str]]) -> list[tuple[str, str]]:
        return [(name, value) for name, value in headers if name.lower() not in self.RESPONSE_HEADER_EXCLUSIONS]

    def _offline_page(self, user: AuthenticatedUser) -> str:
        offline_config = {"email": user.email}
        return self.STATIC_OFFLINE_FILE.read_text().replace(
            "__TERMDECK_REMOTE_OFFLINE_CONFIG__", json.dumps(offline_config).replace("</", "<\\/"))
