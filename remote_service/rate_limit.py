import time
from collections import deque


class SlidingWindowRateLimiter:
    WINDOW_SECONDS = 3600.0

    def __init__(self, limit: int) -> None:
        self.limit = limit
        self._requests: dict[str, deque[float]] = {}

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        earliest = now - self.WINDOW_SECONDS
        requests = self._requests.setdefault(key, deque())
        while requests and requests[0] < earliest:
            requests.popleft()
        if len(requests) >= self.limit:
            return False
        requests.append(now)
        return True
