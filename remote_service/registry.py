import asyncio
import time
from dataclasses import dataclass, field

from fastapi import WebSocket
from starlette.websockets import WebSocketDisconnect

from remote_service.auth import AuthenticatedUser
from termdeck.remote_protocol import RemoteMessage, RemoteMessageCodec, RemoteMessageType


@dataclass
class ConnectorConnection:
    user: AuthenticatedUser
    websocket: WebSocket
    request_timeout_seconds: float
    idle_seconds: float
    send_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    pending_http: dict[str, asyncio.Future[RemoteMessage]] = field(default_factory=dict)
    channels: dict[str, asyncio.Queue[RemoteMessage]] = field(default_factory=dict)
    closed: bool = False

    async def receive_until_closed(self) -> None:
        try:
            while True:
                try:
                    payload = await asyncio.wait_for(self.websocket.receive_bytes(), timeout=self.idle_seconds)
                except TimeoutError:
                    if self.pending_http or self.channels:
                        continue
                    await self.close(4000, "no remote browsers are connected")
                    return
                await self._dispatch(RemoteMessageCodec.decode(payload))
        except WebSocketDisconnect:
            return
        finally:
            self.closed = True
            self._fail_waiters()

    async def send(self, message: RemoteMessage) -> None:
        if self.closed:
            raise ConnectionError("local TermDeck connector is offline")
        async with self.send_lock:
            await self.websocket.send_bytes(RemoteMessageCodec.encode(message))

    async def request_http(self, message: RemoteMessage) -> RemoteMessage:
        request_id = message["request_id"]
        future: asyncio.Future[RemoteMessage] = asyncio.get_running_loop().create_future()
        self.pending_http[request_id] = future
        try:
            await self.send(message)
            return await asyncio.wait_for(future, timeout=self.request_timeout_seconds)
        finally:
            self.pending_http.pop(request_id, None)

    def create_channel(self, channel_id: str) -> asyncio.Queue[RemoteMessage]:
        queue: asyncio.Queue[RemoteMessage] = asyncio.Queue(maxsize=256)
        self.channels[channel_id] = queue
        return queue

    def remove_channel(self, channel_id: str) -> None:
        self.channels.pop(channel_id, None)

    async def close(self, code: int, reason: str) -> None:
        if self.closed:
            return
        self.closed = True
        await self.websocket.close(code=code, reason=reason)
        self._fail_waiters()

    async def _dispatch(self, message: RemoteMessage) -> None:
        message_type = message["type"]
        if message_type == RemoteMessageType.HTTP_RESPONSE:
            future = self.pending_http.get(message["request_id"])
            if future is not None and not future.done():
                future.set_result(message)
            return
        channel_id = message.get("channel_id", "")
        queue = self.channels.get(channel_id)
        if queue is not None:
            await queue.put(message)

    def _fail_waiters(self) -> None:
        for future in self.pending_http.values():
            if not future.done():
                future.set_exception(ConnectionError("local TermDeck connector disconnected"))
        for queue in self.channels.values():
            if not queue.full():
                queue.put_nowait({"type": RemoteMessageType.ERROR, "status": 503,
                                  "text": "local TermDeck connector disconnected"})


class ConnectorRegistry:
    def __init__(self) -> None:
        self._connections: dict[str, ConnectorConnection] = {}
        self._demand_until: dict[str, float] = {}
        self._lock = asyncio.Lock()

    async def register(self, connection: ConnectorConnection) -> None:
        async with self._lock:
            previous = self._connections.get(connection.user.user_id)
            self._connections[connection.user.user_id] = connection
            self._demand_until.pop(connection.user.user_id, None)
        if previous is not None and previous is not connection:
            await previous.close(4001, "another TermDeck computer connected for this account")

    async def unregister(self, connection: ConnectorConnection) -> None:
        async with self._lock:
            if self._connections.get(connection.user.user_id) is connection:
                self._connections.pop(connection.user.user_id, None)

    def get(self, user_id: str) -> ConnectorConnection | None:
        connection = self._connections.get(user_id)
        return None if connection is None or connection.closed else connection

    def count(self) -> int:
        return sum(not connection.closed for connection in self._connections.values())

    def request_connection(self, user_id: str, demand_seconds: float = 90.0) -> None:
        self._demand_until[user_id] = max(self._demand_until.get(user_id, 0.0), time.monotonic() + demand_seconds)

    def connection_requested(self, user_id: str) -> bool:
        if self.get(user_id) is not None:
            return False
        demand_until = self._demand_until.get(user_id, 0.0)
        if demand_until <= time.monotonic():
            self._demand_until.pop(user_id, None)
            return False
        return True

    async def revoke(self, user_id: str) -> None:
        async with self._lock:
            connection = self._connections.pop(user_id, None)
            self._demand_until.pop(user_id, None)
        if connection is not None:
            await connection.close(4003, "remote access revoked")
