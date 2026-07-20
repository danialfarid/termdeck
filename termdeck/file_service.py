from pathlib import Path

from termdeck.config import TermdeckConfig
from termdeck.util import TimeUtil


class ProjectFileService:
    """Read-only file listing and reading for the UI file browser and terminal path links. Relative paths
    resolve against a session cwd; absolute and ~ paths resolve directly. Everything is confined to the
    user's home tree and capped in size."""

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
        children = sorted(directory.iterdir(), key=self._dirs_first_case_insensitive)
        entries: list[dict[str, object]] = []
        for child in children[:TermdeckConfig.FILE_LIST_MAX_ENTRIES]:
            try:
                mtime = int(child.stat().st_mtime)
            except (FileNotFoundError, OSError):
                mtime = 0
            entries.append({"name": child.name, "is_dir": child.is_dir(), "mtime": mtime})
        return entries

    def save_upload(self, filename: str, data: bytes) -> str:
        if len(data) > TermdeckConfig.UPLOAD_MAX_BYTES:
            raise ValueError(f"file too large: {len(data)} bytes")
        safe_name = Path(filename or TermdeckConfig.UPLOAD_FALLBACK_NAME).name
        safe_name = "".join(ch for ch in safe_name if ch.isalnum() or ch in "-_.") or TermdeckConfig.UPLOAD_FALLBACK_NAME
        TermdeckConfig.UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
        stamp = TimeUtil.now_est_naive().strftime("%Y%m%d-%H%M%S-%f")
        target = TermdeckConfig.UPLOADS_DIR / f"{stamp}-{safe_name}"
        target.write_bytes(data)
        return str(target)

    def write_file(self, root: str, rel: str, content: str) -> dict[str, int]:
        target = self.resolve_confined(root, rel)
        if not target.is_file():
            raise FileNotFoundError(str(target))
        encoded = content.encode()
        if len(encoded) > TermdeckConfig.FILE_READ_MAX_BYTES:
            raise ValueError(f"content too large: {len(encoded)} bytes")
        target.write_bytes(encoded)
        return {"size": len(encoded)}

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
