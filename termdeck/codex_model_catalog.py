import asyncio
import json
import time

from termdeck.platform_paths import PlatformPaths


class CodexModelCatalog:
    CACHE_SECONDS = 300.0
    RESPONSE_TIMEOUT_SECONDS = 10.0

    def __init__(self) -> None:
        self._codex_binary = PlatformPaths.resolve_binary(PlatformPaths.ENV_CODEX_BIN, "codex")
        self._models: list[dict[str, object]] = []
        self._loaded_monotonic = 0.0
        self._lock = asyncio.Lock()

    async def list_models(self) -> list[dict[str, object]]:
        if self._models and time.monotonic() - self._loaded_monotonic < self.CACHE_SECONDS:
            return self._models
        async with self._lock:
            if self._models and time.monotonic() - self._loaded_monotonic < self.CACHE_SECONDS:
                return self._models
            self._models = await self._load_models()
            self._loaded_monotonic = time.monotonic()
            return self._models

    async def _load_models(self) -> list[dict[str, object]]:
        process = await asyncio.create_subprocess_exec(
            self._codex_binary, "app-server", "--listen", "stdio://", stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            await self._write_message(process, {
                "id": 1, "method": "initialize",
                "params": {"clientInfo": {"name": "termdeck-model-picker", "version": "1"}},
            })
            await self._read_response(process, 1)
            await self._write_message(process, {"method": "initialized", "params": {}})
            await self._write_message(process, {
                "id": 2, "method": "model/list", "params": {"limit": 50, "includeHidden": False},
            })
            response = await self._read_response(process, 2)
            result = response.get("result")
            raw_models = result.get("data") if isinstance(result, dict) else None
            if not isinstance(raw_models, list):
                raise RuntimeError("Codex returned an invalid model catalog")
            models = [self._normalize_model(item) for item in raw_models if isinstance(item, dict)]
            if not models:
                raise RuntimeError("Codex returned an empty model catalog")
            return models
        finally:
            if process.stdin is not None:
                process.stdin.close()
                try:
                    await process.stdin.wait_closed()
                except BrokenPipeError:
                    pass
            if process.returncode is None:
                process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), 1.0)
                except TimeoutError:
                    process.kill()
                    await process.wait()

    async def _write_message(self, process: asyncio.subprocess.Process, payload: dict[str, object]) -> None:
        if process.stdin is None:
            raise RuntimeError("Codex model catalog input is unavailable")
        process.stdin.write(json.dumps(payload, separators=(",", ":")).encode() + b"\n")
        await process.stdin.drain()

    async def _read_response(self, process: asyncio.subprocess.Process, response_id: int) -> dict[str, object]:
        if process.stdout is None:
            raise RuntimeError("Codex model catalog output is unavailable")
        while True:
            line = await asyncio.wait_for(process.stdout.readline(), self.RESPONSE_TIMEOUT_SECONDS)
            if not line:
                detail = ""
                if process.stderr is not None:
                    detail = (await process.stderr.read()).decode(errors="replace").strip()
                raise RuntimeError(detail or "Codex model catalog process exited early")
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(payload, dict) or payload.get("id") != response_id:
                continue
            if payload.get("error"):
                raise RuntimeError(f"Codex model catalog failed: {payload['error']}")
            return payload

    @staticmethod
    def _normalize_model(raw: dict[str, object]) -> dict[str, object]:
        efforts = raw.get("supportedReasoningEfforts")
        normalized_efforts = [{
            "value": str(item.get("reasoningEffort", "")),
            "description": str(item.get("description", "")),
        } for item in efforts if isinstance(item, dict) and item.get("reasoningEffort")] if isinstance(efforts, list) else []
        return {
            "id": str(raw.get("id") or raw.get("model") or ""),
            "label": str(raw.get("displayName") or raw.get("id") or raw.get("model") or ""),
            "description": str(raw.get("description") or ""),
            "is_default": bool(raw.get("isDefault")),
            "default_reasoning_effort": str(raw.get("defaultReasoningEffort") or ""),
            "reasoning_efforts": normalized_efforts,
        }
