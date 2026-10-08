import asyncio
import json


class TerminalClientQueue(asyncio.Queue):
    MAX_PENDING_BYTES = 4 * 1024 * 1024
    MAX_PENDING_ITEMS = 2048
    SEND_TIMEOUT_SECONDS = 10

    def __init__(self) -> None:
        super().__init__()
        self.pending_bytes = 0
        self.overflowed = False

    @staticmethod
    def item_size(item: bytes | dict[str, object] | None) -> int:
        return len(item) if isinstance(item, bytes) else len(json.dumps(item).encode())

    def put_nowait(self, item: bytes | dict[str, object] | None) -> None:
        if self.overflowed:
            return
        size = self.item_size(item)
        if self.pending_bytes + size > self.MAX_PENDING_BYTES or self.qsize() >= self.MAX_PENDING_ITEMS:
            self.overflowed = True
            while not self.empty():
                self.get_nowait()
            super().put_nowait(None)
            self.pending_bytes = self.item_size(None)
            return
        super().put_nowait(item)
        self.pending_bytes += size

    def get_nowait(self) -> bytes | dict[str, object] | None:
        item = super().get_nowait()
        self.pending_bytes -= self.item_size(item)
        return item
