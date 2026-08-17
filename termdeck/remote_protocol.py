from enum import StrEnum
from typing import NotRequired, TypedDict, cast

import msgpack


class RemoteMessageType(StrEnum):
    HELLO = "hello"
    HELLO_ACCEPTED = "hello_accepted"
    ERROR = "error"
    HTTP_REQUEST = "http_request"
    HTTP_RESPONSE = "http_response"
    WS_OPEN = "ws_open"
    WS_OPENED = "ws_opened"
    WS_CLIENT_TEXT = "ws_client_text"
    WS_CLIENT_BINARY = "ws_client_binary"
    WS_SERVER_TEXT = "ws_server_text"
    WS_SERVER_BINARY = "ws_server_binary"
    WS_CLOSE = "ws_close"
    PING = "ping"
    PONG = "pong"


class RemoteMessage(TypedDict):
    type: str
    request_id: NotRequired[str]
    channel_id: NotRequired[str]
    token: NotRequired[str]
    protocol: NotRequired[int]
    method: NotRequired[str]
    path: NotRequired[str]
    query: NotRequired[str]
    headers: NotRequired[list[tuple[str, str]]]
    body: NotRequired[bytes]
    status: NotRequired[int]
    text: NotRequired[str]
    code: NotRequired[int]


class RemoteMessageCodec:
    PROTOCOL_VERSION = 1

    @staticmethod
    def encode(message: RemoteMessage) -> bytes:
        return msgpack.packb(message, use_bin_type=True)

    @staticmethod
    def decode(payload: bytes) -> RemoteMessage:
        message = msgpack.unpackb(payload, raw=False, strict_map_key=True)
        if not isinstance(message, dict) or not isinstance(message.get("type"), str):
            raise ValueError("invalid remote message")
        return cast(RemoteMessage, message)
