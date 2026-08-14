import asyncio
import os
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Any

from watchdog.events import FileSystemEvent, FileSystemEventHandler
from watchdog.observers import Observer

from termdeck.config import TermdeckConfig
from termdeck.models import WsMessageFields
from termdeck.util import TimeUtil


class _RecentFilesEventHandler(FileSystemEventHandler):
    def __init__(self, owner: "ProjectFileService", root: Path) -> None:
        super().__init__()
        self._owner = owner
        self._root = root

    def on_any_event(self, event: FileSystemEvent) -> None:
        self._owner.notify_project_files_changed(self._root, event)


class _FileTreeEventHandler(FileSystemEventHandler):
    def __init__(self, owner: "ProjectFileService", root: Path) -> None:
        super().__init__()
        self._owner = owner
        self._root = root

    def on_any_event(self, event: FileSystemEvent) -> None:
        self._owner.notify_project_files_changed(self._root, event)


class ProjectFileService:
    """Read-only file listing and reading for the UI file browser and terminal path links. Relative paths
    resolve against a session cwd; absolute and ~ paths resolve directly. Everything is confined to the
    user's home tree and capped in size."""

    _RECENT_CACHE_MAX_AGE_SECONDS = 30.0
    _GIT_STATUS_CACHE_MAX_AGE_SECONDS = 5.0
    _RECENT_WATCH_MAX_ROOTS = 12
    _TREE_WATCH_MAX_ROOTS = 4
    _TREE_EVENT_DEBOUNCE_SECONDS = 0.15
    _TREE_CHANGE_EVENT_TYPES = frozenset({"created", "deleted", "modified", "moved"})

    def __init__(self) -> None:
        self._recent_lock = threading.RLock()
        self._recent_cache: dict[str, tuple[float, list[dict[str, object]]]] = {}
        self._recent_dirty: set[str] = set()
        self._recent_watches: dict[str, Any] = {}
        self._recent_observer: Observer | None = None
        self._git_status_cache: dict[str, tuple[float, dict[str, str]]] = {}
        self._tree_watches: dict[str, Any] = {}
        self._tree_subscribers: dict[str, set[asyncio.Queue[dict[str, object]]]] = {}
        self._tree_event_loop: asyncio.AbstractEventLoop | None = None
        self._tree_pending: dict[str, dict[str, dict[str, object]]] = {}
        self._tree_flush_tasks: dict[str, asyncio.Task[None]] = {}

    def close(self) -> None:
        with self._recent_lock:
            observer, self._recent_observer = self._recent_observer, None
            self._recent_watches.clear()
            self._tree_watches.clear()
            self._tree_subscribers.clear()
            self._tree_event_loop = None
            self._tree_pending.clear()
            tree_tasks = tuple(self._tree_flush_tasks.values())
            self._tree_flush_tasks.clear()
        for task in tree_tasks:
            task.cancel()
        if observer is not None:
            observer.stop()
            observer.join(timeout=2)

    def resolve_confined(self, root: str, rel_or_abs: str) -> Path:
        base = Path(root).expanduser()
        raw = Path(rel_or_abs).expanduser() if rel_or_abs else base
        target = raw if raw.is_absolute() else base / raw
        resolved = target.resolve()
        if not resolved.is_relative_to(TermdeckConfig.FILE_ACCESS_ROOT):
            raise ValueError(f"path outside allowed root: {resolved}")
        return resolved

    def list_dir(self, root: str, rel: str) -> list[dict[str, object]]:
        directory = self.resolve_confined(root, rel)
        if not directory.is_dir():
            raise FileNotFoundError(str(directory))
        git_statuses = self._git_statuses(root)
        children = sorted(directory.iterdir(), key=self._dirs_first_case_insensitive)
        entries: list[dict[str, object]] = []
        for child in children[:TermdeckConfig.FILE_LIST_MAX_ENTRIES]:
            try:
                mtime = int(child.stat().st_mtime)
            except (FileNotFoundError, OSError):
                mtime = 0
            relative = str(child.relative_to(Path(root).expanduser().resolve()))
            entries.append({"name": child.name, "is_dir": child.is_dir(), "mtime": mtime,
                            "git_status": self._git_status_for_path(git_statuses, relative, child.is_dir())})
        return entries

    def recent_files(self, root: str, rel: str, limit: int) -> list[dict[str, object]]:
        """Return the most recently modified files below a confined directory.

        This deliberately skips generated/dependency directories and bounds both the
        result and the amount of filesystem work so the sidebar can refresh safely.
        """
        base = self.resolve_confined(root, rel)
        if not base.is_dir():
            raise NotADirectoryError(str(base))
        result_limit = max(1, min(int(limit), TermdeckConfig.RECENT_FILES_MAX_ENTRIES))
        cache_key = str(base)
        now = time.monotonic()
        with self._recent_lock:
            self._ensure_recent_watch(base)
            cached = self._recent_cache.get(cache_key)
            if (cached is not None and cache_key not in self._recent_dirty and
                    now - cached[0] < self._RECENT_CACHE_MAX_AGE_SECONDS):
                return cached[1][:result_limit]

        git_statuses = self._git_statuses(root)
        candidates: list[tuple[float, str, Path]] = []
        scanned = 0
        for current, dirs, names in os.walk(base, topdown=True, followlinks=False):
            dirs[:] = [name for name in dirs if name not in TermdeckConfig.RECENT_FILES_IGNORED_DIRS]
            for name in names:
                if name in TermdeckConfig.RECENT_FILES_IGNORED_NAMES:
                    continue
                if scanned >= TermdeckConfig.RECENT_FILES_MAX_SCAN:
                    break
                scanned += 1
                path = Path(current) / name
                try:
                    stat = path.stat()
                    if not path.is_file():
                        continue
                    relative = str(path.relative_to(base))
                except (FileNotFoundError, OSError, ValueError):
                    continue
                candidates.append((stat.st_mtime, relative.lower(), path))
            if scanned >= TermdeckConfig.RECENT_FILES_MAX_SCAN:
                break
        candidates.sort(key=lambda item: (item[0], item[1]), reverse=True)
        entries: list[dict[str, object]] = []
        for mtime, _, path in candidates[:TermdeckConfig.RECENT_FILES_MAX_ENTRIES]:
            try:
                relative = str(path.relative_to(base))
            except (ValueError, OSError):
                continue
            entries.append({"name": path.name, "path": relative, "mtime": int(mtime), "is_dir": False,
                            "git_status": git_statuses.get(relative, "")})
        with self._recent_lock:
            self._recent_cache[cache_key] = (time.monotonic(), entries)
            self._recent_dirty.discard(cache_key)
        return entries[:result_limit]

    def _git_statuses(self, root: str) -> dict[str, str]:
        """Return a bounded, short-lived map of worktree status for one file-browser root."""
        base = self.resolve_confined(root, "")
        key = str(base)
        now = time.monotonic()
        with self._recent_lock:
            cached = self._git_status_cache.get(key)
            if cached is not None and now - cached[0] < self._GIT_STATUS_CACHE_MAX_AGE_SECONDS:
                return cached[1]
        statuses: dict[str, str] = {}
        try:
            result = subprocess.run(
                ["git", "-C", str(base), "status", "--short", "--untracked-files=all", "-z"],
                capture_output=True, timeout=2.0, check=False,
            )
            if result.returncode == 0:
                records = result.stdout.decode("utf-8", errors="replace").split("\0")
                index = 0
                while index < len(records):
                    record = records[index]
                    index += 1
                    if len(record) < 4:
                        continue
                    code = record[:2]
                    path = record[3:]
                    if code and code != "  ":
                        statuses[path] = "?" if code == "??" else next((char for char in code if char != " "), "M")
                    if "R" in code or "C" in code:
                        index += 1  # The old path follows the new path in -z output.
        except (OSError, subprocess.SubprocessError):
            statuses = {}
        with self._recent_lock:
            self._git_status_cache[key] = (time.monotonic(), statuses)
        return statuses

    def git_statuses_for_files(self, root: str, relative_paths: set[str]) -> dict[str, str]:
        statuses = self._git_statuses(root)
        return {relative_path: statuses.get(relative_path, "") for relative_path in relative_paths}

    def git_statuses(self, root: str) -> dict[str, str]:
        return dict(self._git_statuses(root))

    @staticmethod
    def _git_status_for_path(statuses: dict[str, str], relative: str, is_dir: bool) -> str:
        if not is_dir:
            return statuses.get(relative, "")
        prefix = relative.rstrip("/") + "/"
        values = {status for path, status in statuses.items() if path.startswith(prefix)}
        return next((status for status in ("?", "A", "D", "M", "R", "C") if status in values), "")

    def _ensure_recent_watch(self, root: Path) -> None:
        """Watch a project root lazily; file events invalidate the cached recent list."""
        key = str(root)
        if key in self._recent_watches:
            return
        tree_watch = self._tree_watches.pop(key, None)
        if tree_watch is not None:
            self._recent_watches[key] = tree_watch
            return
        if len(self._recent_watches) >= self._RECENT_WATCH_MAX_ROOTS:
            return
        # Watching the whole home directory would be noisy and defeats the
        # purpose of the cache. Such roots use the safety TTL instead.
        if root == TermdeckConfig.FILE_ACCESS_ROOT:
            return
        if any(root == Path(existing) or root.is_relative_to(Path(existing))
               for existing in self._recent_watches):
            return
        if self._recent_observer is None:
            self._recent_observer = Observer()
        observer = self._recent_observer
        handler = _RecentFilesEventHandler(self, root)
        self._recent_watches[key] = observer.schedule(handler, str(root), recursive=True)
        if not observer.is_alive():
            observer.start()

    def invalidate_recent_root(self, root: Path, changed: Path) -> None:
        try:
            relative = changed.relative_to(root)
        except ValueError:
            return
        if any(part in TermdeckConfig.RECENT_FILES_IGNORED_DIRS for part in relative.parts):
            return
        if relative.name in TermdeckConfig.RECENT_FILES_IGNORED_NAMES:
            return
        with self._recent_lock:
            self._recent_dirty.add(str(root))

    def notify_project_files_changed(self, root: Path, event: FileSystemEvent) -> None:
        if event.event_type not in self._TREE_CHANGE_EVENT_TYPES:
            return
        self.invalidate_recent_root(root, Path(event.src_path))
        destination = getattr(event, "dest_path", None)
        if destination:
            self.invalidate_recent_root(root, Path(destination))
        self.notify_file_tree_changed(root, event)

    def subscribe_file_tree(self, root: str, event_loop: asyncio.AbstractEventLoop) -> tuple[str, asyncio.Queue[dict[str, object]]]:
        base = self.resolve_confined(root, "")
        if not base.is_dir():
            raise NotADirectoryError(str(base))
        key = str(base)
        queue: asyncio.Queue[dict[str, object]] = asyncio.Queue()
        with self._recent_lock:
            self._tree_event_loop = event_loop
            self._tree_subscribers.setdefault(key, set()).add(queue)
            self._ensure_tree_watch(base)
        return key, queue

    def unsubscribe_file_tree(self, root: str, queue: asyncio.Queue[dict[str, object]]) -> None:
        with self._recent_lock:
            subscribers = self._tree_subscribers.get(root)
            if subscribers is None:
                return
            subscribers.discard(queue)
            if subscribers:
                return
            self._tree_subscribers.pop(root, None)
            watch = self._tree_watches.pop(root, None)
            observer = self._recent_observer
            if watch is not None and observer is not None:
                observer.unschedule(watch)

    def notify_file_tree_changed(self, root: Path, event: FileSystemEvent) -> None:
        changes = self._file_tree_event_changes(root, event)
        if not changes:
            return
        key = str(root)
        with self._recent_lock:
            self._git_status_cache.pop(key, None)
            self._recent_dirty.add(key)
            event_loop = self._tree_event_loop
            subscribed = bool(self._tree_subscribers.get(key))
        if event_loop is None or event_loop.is_closed() or not subscribed:
            return
        event_loop.call_soon_threadsafe(self._queue_file_tree_change, key, changes)

    def _queue_file_tree_change(self, root: str, changes: list[dict[str, object]]) -> None:
        pending = self._tree_pending.setdefault(root, {})
        for change in changes:
            pending[str(change[WsMessageFields.PATH])] = change
        if root not in self._tree_flush_tasks:
            self._tree_flush_tasks[root] = asyncio.create_task(self._flush_file_tree_changes(root))

    async def _flush_file_tree_changes(self, root: str) -> None:
        try:
            await asyncio.sleep(self._TREE_EVENT_DEBOUNCE_SECONDS)
            with self._recent_lock:
                changes = sorted(self._tree_pending.pop(root, {}).values(), key=lambda change: str(change[WsMessageFields.PATH]))
                subscribers = tuple(self._tree_subscribers.get(root, ()))
            if not changes:
                return
            message = {WsMessageFields.TYPE: WsMessageFields.FILE_TREE_CHANGED,
                       WsMessageFields.CHANGES: changes}
            for queue in subscribers:
                queue.put_nowait(message)
        finally:
            self._tree_flush_tasks.pop(root, None)
            if self._tree_pending.get(root):
                self._tree_flush_tasks[root] = asyncio.create_task(self._flush_file_tree_changes(root))

    def _ensure_tree_watch(self, root: Path) -> None:
        key = str(root)
        if key in self._recent_watches or key in self._tree_watches or len(self._tree_watches) >= self._TREE_WATCH_MAX_ROOTS:
            return
        if root == TermdeckConfig.FILE_ACCESS_ROOT:
            return
        if self._recent_observer is None:
            self._recent_observer = Observer()
        observer = self._recent_observer
        handler = _FileTreeEventHandler(self, root)
        self._tree_watches[key] = observer.schedule(handler, str(root), recursive=True)
        if not observer.is_alive():
            observer.start()

    def _file_tree_event_changes(self, root: Path, event: FileSystemEvent) -> list[dict[str, object]]:
        if event.event_type not in self._TREE_CHANGE_EVENT_TYPES:
            return []
        paths = [(Path(event.src_path), "deleted" if event.event_type == "moved" else event.event_type)]
        destination = getattr(event, "dest_path", None)
        if destination:
            paths.append((Path(destination), "created"))
        changes: list[dict[str, object]] = []
        for path, operation in paths:
            try:
                relative = path.relative_to(root)
            except ValueError:
                continue
            if any(part in TermdeckConfig.RECENT_FILES_IGNORED_DIRS for part in relative.parts):
                continue
            if relative.name in TermdeckConfig.RECENT_FILES_IGNORED_NAMES:
                continue
            if not relative.parts or (event.is_directory and operation == "modified"):
                continue
            relative_path = "/".join(relative.parts)
            parent = "/".join(relative.parent.parts)
            changes.append({WsMessageFields.PATH: relative_path, WsMessageFields.PARENT: parent,
                            WsMessageFields.OPERATION: operation, WsMessageFields.IS_DIRECTORY: event.is_directory})
        return changes

    def save_upload(self, filename: str, data: bytes) -> str:
        if len(data) > TermdeckConfig.UPLOAD_MAX_BYTES:
            raise ValueError(f"file too large: {len(data)} bytes")
        if len(data) > TermdeckConfig.UPLOAD_TOTAL_MAX_BYTES:
            raise ValueError(f"file too large for upload storage: {len(data)} bytes")
        safe_name = Path(filename or TermdeckConfig.UPLOAD_FALLBACK_NAME).name
        safe_name = "".join(ch for ch in safe_name if ch.isalnum() or ch in "-_.") or TermdeckConfig.UPLOAD_FALLBACK_NAME
        TermdeckConfig.UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
        self._evict_oldest_uploads_for_capacity(len(data))
        stamp = TimeUtil.now_est_naive().strftime("%Y%m%d-%H%M%S-%f")
        target = TermdeckConfig.UPLOADS_DIR / f"{stamp}-{safe_name}"
        target.write_bytes(data)
        return str(target)

    def _evict_oldest_uploads_for_capacity(self, incoming_size: int) -> None:
        upload_files = self._list_upload_files_oldest_first()
        total_size = sum(size for _, _, size in upload_files)
        for _, path, size in upload_files:
            if total_size + incoming_size <= TermdeckConfig.UPLOAD_TOTAL_MAX_BYTES:
                return
            path.unlink()
            total_size -= size

    @staticmethod
    def _list_upload_files_oldest_first() -> list[tuple[float, Path, int]]:
        upload_files = []
        for path in TermdeckConfig.UPLOADS_DIR.iterdir():
            if not path.is_file():
                continue
            stat = path.stat()
            upload_files.append((stat.st_mtime, path, stat.st_size))
        return sorted(upload_files, key=lambda entry: (entry[0], entry[1].name))

    def write_file(self, root: str, rel: str, content: str) -> dict[str, int]:
        target = self.resolve_confined(root, rel)
        if not target.is_file():
            raise FileNotFoundError(str(target))
        encoded = content.encode()
        if len(encoded) > TermdeckConfig.FILE_READ_MAX_BYTES:
            raise ValueError(f"content too large: {len(encoded)} bytes")
        target.write_bytes(encoded)
        return {"size": len(encoded)}

    def create_path(self, root: str, rel: str, directory: bool) -> dict[str, str | bool]:
        target = self.resolve_confined(root, rel)
        if target.exists():
            raise FileExistsError(str(target))
        if not target.parent.is_dir():
            raise FileNotFoundError(str(target.parent))
        if directory:
            target.mkdir()
        else:
            target.touch(exist_ok=False)
        base = self.resolve_confined(root, "")
        return {"rel": str(target.relative_to(base)), "directory": directory}

    def duplicate_path(self, root: str, rel: str, destination: str) -> str:
        source = self.resolve_confined(root, rel)
        if not source.exists():
            raise FileNotFoundError(str(source))
        target = self.resolve_confined(root, destination)
        if target.is_dir():
            target = target / source.name
        if target.exists():
            raise FileExistsError(str(target))
        if not target.parent.is_dir():
            raise FileNotFoundError(str(target.parent))
        if source.is_dir():
            shutil.copytree(source, target)
        else:
            shutil.copy2(source, target)
        base = self.resolve_confined(root, "")
        return str(target.relative_to(base))

    def rename_path(self, root: str, rel: str, new_name: str) -> str:
        if not new_name.strip() or "/" in new_name:
            raise ValueError(f"invalid name: {new_name}")
        source = self.resolve_confined(root, rel)
        if not source.exists():
            raise FileNotFoundError(str(source))
        target = source.parent / new_name
        if target.exists():
            raise ValueError(f"target already exists: {target}")
        source.rename(target)
        return new_name

    def move_path(self, root: str, rel: str, destination: str) -> str:
        source = self.resolve_confined(root, rel)
        if not source.exists():
            raise FileNotFoundError(str(source))
        target = self.resolve_confined(root, destination)
        if target.is_dir():
            target = target / source.name
        if target.exists():
            raise ValueError(f"target already exists: {target}")
        target.parent.mkdir(parents=True, exist_ok=True)
        source.rename(target)
        base = self.resolve_confined(root, "")
        return str(target.relative_to(base)) if target.is_relative_to(base) else str(target)

    def move_to_trash(self, root: str, rel: str) -> str:
        source = self.resolve_confined(root, rel)
        if not source.exists():
            raise FileNotFoundError(str(source))
        if source == TermdeckConfig.FILE_ACCESS_ROOT or not rel.strip():
            raise ValueError("refusing to trash the root")
        target = TermdeckConfig.TRASH_DIR / source.name
        if target.exists():
            stamp = TimeUtil.now_est_naive().strftime("%Y%m%d-%H%M%S")
            target = TermdeckConfig.TRASH_DIR / f"{source.name}-{stamp}"
        source.rename(target)
        return str(target)

    def move_notebook_note_to_trash(self, title: str, content: str) -> str:
        safe_title = re.sub(r"[^A-Za-z0-9._ -]+", "_", title).strip(" .")[:96] or "Untitled note"
        stamp = TimeUtil.now_est_naive().strftime("%Y%m%d-%H%M%S-%f")
        staging_dir = TermdeckConfig.DATA_DIR / "notebook-trash-staging"
        staging_dir.mkdir(parents=True, exist_ok=True)
        source = staging_dir / f"TermDeck note - {safe_title} {stamp}.md"
        source.write_text(content)
        TermdeckConfig.TRASH_DIR.mkdir(parents=True, exist_ok=True)
        target = TermdeckConfig.TRASH_DIR / source.name
        source.rename(target)
        return str(target)

    @staticmethod
    def _dirs_first_case_insensitive(path: Path) -> tuple[bool, str]:
        return (not path.is_dir(), path.name.lower())

    def read_file(self, root: str, rel: str) -> dict[str, object]:
        target = self.resolve_confined(root, rel)
        if not target.is_file():
            raise FileNotFoundError(str(target))
        size = target.stat().st_size
        with target.open("rb") as handle:
            raw = handle.read(TermdeckConfig.FILE_READ_MAX_BYTES)
        if b"\x00" in raw[:8192]:
            raise ValueError(f"binary file: {target.name}")
        return {"path": str(target), "size": size, "truncated": size > len(raw),
                "content": raw.decode("utf-8", errors="replace")}
