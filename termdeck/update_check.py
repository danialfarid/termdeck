import asyncio
import json
import re
import time
from pathlib import Path

import httpx

from termdeck.util import TimeUtil


class UpdateCheckService:
    RELEASE_API_URL = "https://api.github.com/repos/danialfarid/termdeck/releases/latest"
    VERSION_PATTERN = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$")

    def __init__(self, cache_file: Path, cache_seconds: float, timeout_seconds: float = 5.0,
                 transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.cache_file = cache_file
        self.cache_seconds = cache_seconds
        self.timeout_seconds = timeout_seconds
        self.transport = transport
        self.lock = asyncio.Lock()

    async def status(self, current_version: str, force: bool = False) -> dict[str, object]:
        async with self.lock:
            cached = self._load_cache()
            if not force and self._cache_is_fresh(cached):
                return self._status_from_release(current_version, cached)
            try:
                release = await self._fetch_release()
                self._store_cache(release)
                return self._status_from_release(current_version, release)
            except (httpx.HTTPError, OSError, ValueError, json.JSONDecodeError) as error:
                status = self._status_from_release(current_version, cached)
                status["error"] = str(error)
                status["stale"] = bool(cached)
                return status

    async def _fetch_release(self) -> dict[str, object]:
        headers = {"Accept": "application/vnd.github+json", "User-Agent": "termdeck-update-check"}
        async with httpx.AsyncClient(timeout=self.timeout_seconds, follow_redirects=True,
                                     transport=self.transport) as client:
            response = await client.get(self.RELEASE_API_URL, headers=headers)
            response.raise_for_status()
            payload = response.json()
        if not isinstance(payload, dict):
            raise ValueError("GitHub release response is not an object")
        tag = str(payload.get("tag_name") or "")
        version = self._version_tuple(tag)
        release_url = str(payload.get("html_url") or "")
        if version is None or not release_url.startswith("https://github.com/danialfarid/termdeck/releases/"):
            raise ValueError("GitHub release response is missing a valid tag or URL")
        return {"checked_at": time.time(), "checked_at_est": TimeUtil.now_est_naive_iso(),
                "latest_version": ".".join(str(part) for part in version), "release_url": release_url,
                "published_at": str(payload.get("published_at") or "")}

    def _load_cache(self) -> dict[str, object]:
        try:
            payload = json.loads(self.cache_file.read_text())
        except (OSError, json.JSONDecodeError):
            return {}
        return payload if isinstance(payload, dict) else {}

    def _store_cache(self, payload: dict[str, object]) -> None:
        self.cache_file.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.cache_file.with_suffix(self.cache_file.suffix + ".tmp")
        temporary.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
        temporary.replace(self.cache_file)

    def _cache_is_fresh(self, payload: dict[str, object]) -> bool:
        try:
            return time.time() - float(payload.get("checked_at") or 0) < self.cache_seconds
        except (TypeError, ValueError):
            return False

    def _status_from_release(self, current_version: str, release: dict[str, object]) -> dict[str, object]:
        current = self._version_tuple(current_version)
        latest_text = str(release.get("latest_version") or "")
        latest = self._version_tuple(latest_text)
        return {"current_version": current_version, "latest_version": latest_text,
                "update_available": bool(current and latest and latest > current),
                "release_url": str(release.get("release_url") or ""),
                "published_at": str(release.get("published_at") or ""),
                "checked_at_est": str(release.get("checked_at_est") or ""), "error": "", "stale": False}

    @classmethod
    def _version_tuple(cls, version: str) -> tuple[int, int, int] | None:
        match = cls.VERSION_PATTERN.fullmatch(version.strip())
        return tuple(int(part) for part in match.groups()) if match else None
