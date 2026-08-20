from __future__ import annotations

import asyncio
import json
import os
from collections import deque
from pathlib import Path
from typing import Any, Awaitable, Callable, TypeAlias

from termdeck import __version__


JsonObject: TypeAlias = dict[str, Any]

class LanguageServerProtocolError(RuntimeError):
    pass

class LanguageServerRequestError(LanguageServerProtocolError):
    def __init__(self, method: str, error: JsonObject) -> None:
        super().__init__(f"{method}: {error.get('message', 'language server request failed')}")
        self.method = method
        self.error = error

class LanguageServerConnection:
    MAX_MESSAGE_BYTES = 32 * 1024 * 1024
    REQUEST_TIMEOUT_SECONDS = 20.0
    SHUTDOWN_TIMEOUT_SECONDS = 3.0
    STDERR_TAIL_LINES = 40

    def __init__(self, root: Path, command: tuple[str, ...], server_name: str,
                 workspace_edit_handler: Callable[[Path, JsonObject], Awaitable[JsonObject]]) -> None:
        self.root = root
        self.command = command
        self.server_name = server_name
        self.workspace_edit_handler = workspace_edit_handler
        self.process: asyncio.subprocess.Process | None = None
        self.capabilities: JsonObject = {}
        self._request_sequence = 0
        self._pending_requests: dict[int, tuple[str, asyncio.Future[Any]]] = {}
        self._subscribers: set[asyncio.Queue[JsonObject]] = set()
        self._latest_diagnostics: dict[str, JsonObject] = {}
        self._documents: dict[str, tuple[str, str, int]] = {}
        self._write_lock = asyncio.Lock()
        self._reader_task: asyncio.Task[None] | None = None
        self._stderr_task: asyncio.Task[None] | None = None
        self._stderr_tail: deque[str] = deque(maxlen=self.STDERR_TAIL_LINES)
    async def start(self) -> None:
        self.process = await asyncio.create_subprocess_exec(*self.command, cwd=self.root,
                                                            stdin=asyncio.subprocess.PIPE,
                                                            stdout=asyncio.subprocess.PIPE,
                                                            stderr=asyncio.subprocess.PIPE)
        self._reader_task = asyncio.create_task(self._read_messages())
        self._stderr_task = asyncio.create_task(self._read_stderr())
        initialize_result = await self.request("initialize", self._initialize_params())
        if not isinstance(initialize_result, dict):
            raise LanguageServerProtocolError(f"{self.server_name} returned an invalid initialize response")
        capabilities = initialize_result.get("capabilities", {})
        if not isinstance(capabilities, dict):
            raise LanguageServerProtocolError(f"{self.server_name} returned invalid capabilities")
        self.capabilities = capabilities
        await self.notify("initialized", {})

    def _initialize_params(self) -> JsonObject:
        root_uri = self.root.as_uri()
        return {
            "processId": os.getpid(), "clientInfo": {"name": "TermDeck", "version": __version__},
            "rootUri": root_uri, "rootPath": str(self.root),
            "workspaceFolders": [{"uri": root_uri, "name": self.root.name}],
            "capabilities": {
                "general": {"positionEncodings": ["utf-16"]},
                "workspace": {"workspaceFolders": True, "symbol": {"dynamicRegistration": False},
                              "applyEdit": True, "configuration": True},
                "textDocument": {
                    "synchronization": {"dynamicRegistration": False, "didSave": True},
                    "definition": {"dynamicRegistration": False, "linkSupport": True},
                    "references": {"dynamicRegistration": False},
                    "hover": {"dynamicRegistration": False, "contentFormat": ["markdown", "plaintext"]},
                    "rename": {"dynamicRegistration": False, "prepareSupport": True},
                    "codeAction": {"dynamicRegistration": False, "codeActionLiteralSupport": {
                        "codeActionKind": {"valueSet": ["", "quickfix", "refactor", "source"]}}},
                    "publishDiagnostics": {"relatedInformation": True, "versionSupport": True},
                    "documentSymbol": {"dynamicRegistration": False, "hierarchicalDocumentSymbolSupport": True},
                },
                "window": {"workDoneProgress": True},
            },
            "initializationOptions": {}, "trace": "off",
        }

    def running(self) -> bool:
        return self.process is not None and self.process.returncode is None

    def subscribe(self) -> asyncio.Queue[JsonObject]:
        queue: asyncio.Queue[JsonObject] = asyncio.Queue(maxsize=256)
        self._subscribers.add(queue)
        for message in self._latest_diagnostics.values():
            queue.put_nowait(message)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[JsonObject]) -> None:
        self._subscribers.discard(queue)

    async def request(self, method: str, params: JsonObject, timeout: float | None = None) -> Any:
        if not self.running():
            raise LanguageServerProtocolError(f"{self.server_name} is not running")
        self._request_sequence += 1
        request_id = self._request_sequence
        future = asyncio.get_running_loop().create_future()
        self._pending_requests[request_id] = (method, future)
        await self._write_message({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        try:
            return await asyncio.wait_for(future, timeout or self.REQUEST_TIMEOUT_SECONDS)
        except asyncio.TimeoutError:
            self._pending_requests.pop(request_id, None)
            raise LanguageServerProtocolError(f"{self.server_name} timed out handling {method}") from None

    async def notify(self, method: str, params: JsonObject) -> None:
        if not self.running():
            raise LanguageServerProtocolError(f"{self.server_name} is not running")
        await self._write_message({"jsonrpc": "2.0", "method": method, "params": params})

    async def open_document(self, uri: str, language: str, text: str) -> None:
        current = self._documents.get(uri)
        if current is None:
            self._documents[uri] = (language, text, 1)
            await self.notify("textDocument/didOpen", {
                "textDocument": {"uri": uri, "languageId": language, "version": 1, "text": text}})
            return
        current_language, current_text, version = current
        if current_text == text and current_language == language:
            return
        next_version = version + 1
        self._documents[uri] = (language, text, next_version)
        await self.notify("textDocument/didChange", {
            "textDocument": {"uri": uri, "version": next_version}, "contentChanges": [{"text": text}]})

    async def save_document(self, uri: str, text: str) -> None:
        if uri not in self._documents:
            return
        await self.notify("textDocument/didSave", {"textDocument": {"uri": uri}, "text": text})

    async def close_document(self, uri: str) -> None:
        if self._documents.pop(uri, None) is None:
            return
        self._latest_diagnostics.pop(uri, None)
        await self.notify("textDocument/didClose", {"textDocument": {"uri": uri}})

    async def _write_message(self, message: JsonObject) -> None:
        process = self.process
        if process is None or process.stdin is None or process.returncode is not None:
            raise LanguageServerProtocolError(f"{self.server_name} is not writable")
        payload = json.dumps(message, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        if len(payload) > self.MAX_MESSAGE_BYTES:
            raise LanguageServerProtocolError("language server message exceeds the size limit")
        frame = f"Content-Length: {len(payload)}\r\n\r\n".encode("ascii") + payload
        async with self._write_lock:
            process.stdin.write(frame)
            await process.stdin.drain()

    async def _read_messages(self) -> None:
        process = self.process
        if process is None or process.stdout is None:
            return
        failure: LanguageServerProtocolError | None = None
        try:
            while True:
                message = await self._read_message(process.stdout)
                if message is None:
                    break
                await self._dispatch_message(message)
        except (asyncio.IncompleteReadError, UnicodeDecodeError, json.JSONDecodeError, ValueError, OSError) as error:
            failure = LanguageServerProtocolError(f"{self.server_name} protocol failed: {error}")
        if failure is None:
            failure = LanguageServerProtocolError(f"{self.server_name} exited")
        self._fail_pending_requests(failure)
        await self._broadcast({"type": "status", "available": False, "error": str(failure),
                               "stderr": list(self._stderr_tail)})

    async def _read_message(self, reader: asyncio.StreamReader) -> JsonObject | None:
        content_length: int | None = None
        while True:
            line = await reader.readline()
            if not line:
                return None
            if line in {b"\r\n", b"\n"}:
                break
            name, separator, value = line.decode("ascii").partition(":")
            if separator and name.lower() == "content-length":
                content_length = int(value.strip())
        if content_length is None or content_length < 0 or content_length > self.MAX_MESSAGE_BYTES:
            raise ValueError("invalid language server Content-Length")
        payload = await reader.readexactly(content_length)
        message = json.loads(payload.decode("utf-8"))
        if not isinstance(message, dict):
            raise ValueError("language server message is not an object")
        return message

    async def _dispatch_message(self, message: JsonObject) -> None:
        if "method" in message and "id" in message:
            await self._handle_server_request(message)
            return
        if "method" in message:
            notification = {"type": "notification", "method": message["method"], "params": message.get("params", {})}
            if message["method"] == "textDocument/publishDiagnostics" and isinstance(notification["params"], dict):
                diagnostic_uri = notification["params"].get("uri")
                if isinstance(diagnostic_uri, str):
                    self._latest_diagnostics[diagnostic_uri] = notification
            await self._broadcast(notification)
            return
        request_id = message.get("id")
        if not isinstance(request_id, int):
            return
        pending = self._pending_requests.pop(request_id, None)
        if pending is None:
            return
        method, future = pending
        error = message.get("error")
        if isinstance(error, dict):
            future.set_exception(LanguageServerRequestError(method, error))
        else:
            future.set_result(message.get("result"))

    async def _handle_server_request(self, message: JsonObject) -> None:
        request_id = message["id"]
        method = str(message["method"])
        params = message.get("params", {})
        if method == "workspace/configuration":
            items = params.get("items", []) if isinstance(params, dict) else []
            result: Any = [{} for _item in items]
        elif method == "workspace/workspaceFolders":
            result = [{"uri": self.root.as_uri(), "name": self.root.name}]
        elif method in {"client/registerCapability", "client/unregisterCapability", "window/workDoneProgress/create"}:
            result = None
        elif method == "workspace/applyEdit":
            outcome = await self.workspace_edit_handler(self.root, params.get("edit", {}))
            result = {"applied": outcome["applied"]}
            if outcome.get("failureReason"):
                result["failureReason"] = outcome["failureReason"]
            if outcome.get("changed"):
                await self._broadcast({"type": "workspaceEditApplied", "root": str(self.root),
                                       "changed": outcome["changed"]})
        elif method == "window/showMessageRequest":
            result = None
        else:
            await self._write_message({"jsonrpc": "2.0", "id": request_id,
                                       "error": {"code": -32601, "message": f"unsupported server request: {method}"}})
            return
        await self._write_message({"jsonrpc": "2.0", "id": request_id, "result": result})

    async def _broadcast(self, message: JsonObject) -> None:
        for queue in tuple(self._subscribers):
            if queue.full():
                queue.get_nowait()
            queue.put_nowait(message)

    async def _read_stderr(self) -> None:
        process = self.process
        if process is None or process.stderr is None:
            return
        while True:
            line = await process.stderr.readline()
            if not line:
                return
            self._stderr_tail.append(line.decode("utf-8", errors="replace").rstrip())

    def _fail_pending_requests(self, error: LanguageServerProtocolError) -> None:
        pending, self._pending_requests = self._pending_requests, {}
        for _method, future in pending.values():
            if not future.done():
                future.set_exception(error)

    async def stop(self) -> None:
        process = self.process
        if process is None:
            return
        if process.returncode is None:
            try:
                await self.request("shutdown", {}, self.SHUTDOWN_TIMEOUT_SECONDS)
                await self.notify("exit", {})
                await asyncio.wait_for(process.wait(), self.SHUTDOWN_TIMEOUT_SECONDS)
            except LanguageServerProtocolError:
                process.terminate()
            except asyncio.TimeoutError:
                process.terminate()
            if process.returncode is None:
                try:
                    await asyncio.wait_for(process.wait(), self.SHUTDOWN_TIMEOUT_SECONDS)
                except asyncio.TimeoutError:
                    process.kill()
                    await process.wait()
        for task in (self._reader_task, self._stderr_task):
            if task is None:
                continue
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        self.process = None
