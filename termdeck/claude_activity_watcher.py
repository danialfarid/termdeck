from collections.abc import Callable
from pathlib import Path

from watchdog.events import FileSystemEvent, FileSystemEventHandler
from watchdog.observers import Observer


class _ClaudeActivityHandler(FileSystemEventHandler):
    def __init__(self, callback: Callable[[Path], None]) -> None:
        super().__init__()
        self._callback = callback

    def _emit(self, path: str) -> None:
        candidate = Path(path)
        if candidate.suffix == ".jsonl":
            self._callback(candidate)

    def on_created(self, event: FileSystemEvent) -> None:
        if not event.is_directory:
            self._emit(event.src_path)

    def on_deleted(self, event: FileSystemEvent) -> None:
        if not event.is_directory:
            self._emit(event.src_path)

    def on_modified(self, event: FileSystemEvent) -> None:
        if not event.is_directory:
            self._emit(event.src_path)

    def on_moved(self, event: FileSystemEvent) -> None:
        if not event.is_directory:
            self._emit(event.src_path)
            self._emit(event.dest_path)


class ClaudeActivityWatcher:
    """Delivers Claude JSONL changes without periodically scanning transcript files."""

    def __init__(self, root: Path, callback: Callable[[Path], None]) -> None:
        self._root = root
        self._callback = callback
        self._observer: Observer | None = None

    def start(self) -> None:
        if self._observer is not None or not self._root.is_dir():
            return
        observer = Observer()
        observer.schedule(_ClaudeActivityHandler(self._callback), str(self._root), recursive=True)
        observer.start()
        self._observer = observer

    def stop(self) -> None:
        observer, self._observer = self._observer, None
        if observer is None:
            return
        observer.stop()
        observer.join(timeout=2)
