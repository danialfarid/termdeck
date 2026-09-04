import asyncio
from collections.abc import Coroutine
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx
from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import WebSocketException

from termdeck.remote_protocol import RemoteMessage, RemoteMessageCodec, RemoteMessageType


class RemoteConnector:
    REQUEST_HEADER_EXCLUSIONS = frozenset({
        "connection", "content-length", "cookie", "host", "proxy-connection", "transfer-encoding", "upgrade",
    })
    RESPONSE_HEADER_EXCLUSIONS = frozenset({
        "connection", "content-length", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
        "transfer-encoding", "upgrade",
    })
    WEBSOCKET_HEADER_PREFIX = "sec-websocket-"

    def __init__(self, relay_url: str, connector_token: str, local_url: str, reconnect_min_seconds: float,
                 reconnect_max_seconds: float, http_timeout_seconds: float, demand_poll_seconds: float = 5.0,
                 local_access_token: str = "") -> None:
        self.relay_url = relay_url.rstrip("/")
        self.connector_token = connector_token
        self.local_url = local_url.rstrip("/")
        self.reconnect_min_seconds = reconnect_min_seconds
        self.reconnect_max_seconds = reconnect_max_seconds
        self.http_timeout_seconds = http_timeout_seconds
        self.demand_poll_seconds = demand_poll_seconds
        self.local_access_token = local_access_token.strip()
        self.connected = False
        self.last_error = ""
        self._stop_event = asyncio.Event()
        self._connection: ClientConnection | None = None
        self._send_lock = asyncio.Lock()
        self._request_tasks: set[asyncio.Task[None]] = set()
        self._local_websockets: dict[str, ClientConnection] = {}
        self._local_websocket_tasks: dict[str, asyncio.Task[None]] = {}
        self._http_client = httpx.AsyncClient(timeout=http_timeout_seconds, follow_redirects=False)

    async def run(self) -> None:
        reconnect_delay = self.reconnect_min_seconds
        while not self._stop_event.is_set():
            try:
                if not await self._relay_requests_connection():
                    self.last_error = ""
                    await self._wait_before_demand_poll()
                    continue
                await self._connect_once()
                reconnect_delay = self.reconnect_min_seconds
            except (OSError, TimeoutError, ValueError, WebSocketException, httpx.HTTPError) as connection_error:
                self.last_error = str(connection_error)
            finally:
                self.connected = False
                self._connection = None
                await self._close_local_websockets()
            if self._stop_event.is_set():
                break
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=reconnect_delay)
            except TimeoutError:
                reconnect_delay = min(self.reconnect_max_seconds, reconnect_delay * 2)

    async def stop(self) -> None:
        self._stop_event.set()
        if self._connection is not None:
            await self._connection.close(code=1000, reason="local remote access stopped")
        await self._close_local_websockets()
        for task in tuple(self._request_tasks):
            task.cancel()
        if self._request_tasks:
            await asyncio.gather(*self._request_tasks, return_exceptions=True)
        await self._http_client.aclose()

    async def _connect_once(self) -> None:
        async with connect(self._connector_websocket_url(), max_size=None, ping_interval=20, ping_timeout=20,
                           open_timeout=15) as connection:
            self._connection = connection
            await self._send({"type": RemoteMessageType.HELLO, "token": self.connector_token,
                              "protocol": RemoteMessageCodec.PROTOCOL_VERSION})
            raw_acceptance = await connection.recv()
            if not isinstance(raw_acceptance, bytes):
                raise ValueError("relay returned a non-binary handshake")
            acceptance = RemoteMessageCodec.decode(raw_acceptance)
            if acceptance["type"] != RemoteMessageType.HELLO_ACCEPTED:
                raise ValueError(acceptance.get("text", "relay rejected connector"))
            self.connected = True
            self.last_error = ""
            await self._receive_loop(connection)

    async def _relay_requests_connection(self) -> bool:
        response = await self._http_client.post(
            f"{self.relay_url}/_remote/api/connectors/demand",
            headers={"Authorization": f"Bearer {self.connector_token}"})
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload.get("connect"), bool):
            raise ValueError("relay demand response is invalid")
        return payload["connect"]

    async def _wait_before_demand_poll(self) -> None:
        try:
            await asyncio.wait_for(self._stop_event.wait(), timeout=self.demand_poll_seconds)
        except TimeoutError:
            return

    async def _receive_loop(self, connection: ClientConnection) -> None:
        async for payload in connection:
            if not isinstance(payload, bytes):
                raise ValueError("relay returned a non-binary message")
            message = RemoteMessageCodec.decode(payload)
            await self._dispatch_message(message)

    async def _dispatch_message(self, message: RemoteMessage) -> None:
        message_type = message["type"]
        if message_type == RemoteMessageType.HTTP_REQUEST:
            self._start_request_task(self._proxy_http_request(message))
            return
        if message_type == RemoteMessageType.WS_OPEN:
            self._start_request_task(self._open_local_websocket(message))
            return
        if message_type == RemoteMessageType.WS_CLIENT_TEXT:
            await self._send_to_local_websocket(message, False)
            return
        if message_type == RemoteMessageType.WS_CLIENT_BINARY:
            await self._send_to_local_websocket(message, True)
            return
        if message_type == RemoteMessageType.WS_CLOSE:
            await self._close_local_websocket(message["channel_id"])
            return
        if message_type == RemoteMessageType.PING:
            await self._send({"type": RemoteMessageType.PONG})

    def _start_request_task(self, coroutine: Coroutine[Any, Any, None]) -> None:
        task = asyncio.create_task(coroutine)
        self._request_tasks.add(task)
        task.add_done_callback(self._discard_request_task)

    def _discard_request_task(self, task: asyncio.Task[None]) -> None:
        self._request_tasks.discard(task)

    async def _proxy_http_request(self, message: RemoteMessage) -> None:
        request_id = message["request_id"]
        try:
            response = await self._http_client.request(
                method=message["method"], url=self._local_http_url(message["path"], message.get("query", "")),
                headers=self._local_request_headers(message.get("headers", [])), content=message.get("body", b""))
            await self._send({"type": RemoteMessageType.HTTP_RESPONSE, "request_id": request_id,
                              "status": response.status_code, "headers": self._filtered_response_headers(response.headers),
                              "body": response.content})
        except httpx.HTTPError as proxy_error:
            await self._send({"type": RemoteMessageType.HTTP_RESPONSE, "request_id": request_id, "status": 502,
                              "headers": [("content-type", "text/plain; charset=utf-8")],
                              "body": f"local TermDeck request failed: {proxy_error}".encode()})

    async def _open_local_websocket(self, message: RemoteMessage) -> None:
        channel_id = message["channel_id"]
        try:
            local_websocket = await connect(self._local_websocket_url(message["path"], message.get("query", "")),
                                            additional_headers=self._local_websocket_headers(message.get("headers", [])),
                                            max_size=None, ping_interval=20, ping_timeout=20, open_timeout=15)
        except (OSError, TimeoutError, WebSocketException) as websocket_error:
            await self._send({"type": RemoteMessageType.ERROR, "channel_id": channel_id, "status": 502,
                              "text": f"local TermDeck websocket failed: {websocket_error}"})
            return
        self._local_websockets[channel_id] = local_websocket
        pump_task = asyncio.create_task(self._pump_local_websocket(channel_id, local_websocket))
        self._local_websocket_tasks[channel_id] = pump_task
        pump_task.add_done_callback(self._discard_local_websocket_task)
        await self._send({"type": RemoteMessageType.WS_OPENED, "channel_id": channel_id})

    async def _pump_local_websocket(self, channel_id: str, local_websocket: ClientConnection) -> None:
        try:
            async for payload in local_websocket:
                if isinstance(payload, bytes):
                    await self._send({"type": RemoteMessageType.WS_SERVER_BINARY, "channel_id": channel_id,
                                      "body": payload})
                else:
                    await self._send({"type": RemoteMessageType.WS_SERVER_TEXT, "channel_id": channel_id,
                                      "text": payload})
        except (OSError, WebSocketException):
            pass
        finally:
            self._local_websockets.pop(channel_id, None)
            await self._send_if_connected({"type": RemoteMessageType.WS_CLOSE, "channel_id": channel_id,
                                           "code": local_websocket.close_code or 1000})

    def _discard_local_websocket_task(self, task: asyncio.Task[None]) -> None:
        for channel_id, websocket_task in tuple(self._local_websocket_tasks.items()):
            if websocket_task is task:
                self._local_websocket_tasks.pop(channel_id, None)

    async def _send_to_local_websocket(self, message: RemoteMessage, binary: bool) -> None:
        local_websocket = self._local_websockets.get(message["channel_id"])
        if local_websocket is None:
            return
        await local_websocket.send(message.get("body", b"") if binary else message.get("text", ""))

    async def _close_local_websocket(self, channel_id: str) -> None:
        local_websocket = self._local_websockets.pop(channel_id, None)
        if local_websocket is not None:
            await local_websocket.close(code=1000)

    async def _close_local_websockets(self) -> None:
        local_websockets = tuple(self._local_websockets.values())
        self._local_websockets.clear()
        for local_websocket in local_websockets:
            await local_websocket.close(code=1001)
        local_tasks = tuple(self._local_websocket_tasks.values())
        self._local_websocket_tasks.clear()
        for task in local_tasks:
            task.cancel()
        if local_tasks:
            await asyncio.gather(*local_tasks, return_exceptions=True)

    async def _send(self, message: RemoteMessage) -> None:
        connection = self._connection
        if connection is None:
            raise ConnectionError("remote relay is disconnected")
        async with self._send_lock:
            await connection.send(RemoteMessageCodec.encode(message))

    async def _send_if_connected(self, message: RemoteMessage) -> None:
        if self._connection is None:
            return
        try:
            await self._send(message)
        except (ConnectionError, OSError, WebSocketException):
            return

    def _connector_websocket_url(self) -> str:
        parsed = urlsplit(self.relay_url)
        scheme = "wss" if parsed.scheme == "https" else "ws"
        return urlunsplit((scheme, parsed.netloc, "/_remote/connector", "", ""))

    def _local_http_url(self, path: str, query: str) -> str:
        suffix = f"?{query}" if query else ""
        return f"{self.local_url}{path}{suffix}"

    def _local_websocket_url(self, path: str, query: str) -> str:
        parsed = urlsplit(self.local_url)
        scheme = "wss" if parsed.scheme == "https" else "ws"
        return urlunsplit((scheme, parsed.netloc, path, query, "")) if query else urlunsplit((scheme, parsed.netloc, path, "", ""))

    def _filtered_request_headers(self, headers: list[tuple[str, str]]) -> list[tuple[str, str]]:
        return [(name, value) for name, value in headers if name.lower() not in self.REQUEST_HEADER_EXCLUSIONS]

    def _filtered_websocket_headers(self, headers: list[tuple[str, str]]) -> list[tuple[str, str]]:
        return [(name, value) for name, value in self._filtered_request_headers(headers)
                if not name.lower().startswith(self.WEBSOCKET_HEADER_PREFIX) and name.lower() != "origin"]

    def _local_request_headers(self, headers: list[tuple[str, str]]) -> list[tuple[str, str]]:
        filtered = self._filtered_request_headers(headers)
        if not self.local_access_token:
            return filtered
        return [(name, value) for name, value in filtered if name.lower() != "authorization"] + \
            [("Authorization", f"Bearer {self.local_access_token}")]

    def _local_websocket_headers(self, headers: list[tuple[str, str]]) -> list[tuple[str, str]]:
        return self._local_request_headers(self._filtered_websocket_headers(headers))

    def _filtered_response_headers(self, headers: httpx.Headers) -> list[tuple[str, str]]:
        return [(name, value) for name, value in headers.multi_items() if name.lower() not in self.RESPONSE_HEADER_EXCLUSIONS]
