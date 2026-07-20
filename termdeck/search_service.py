import asyncio
import re

from termdeck.config import TermdeckConfig
from termdeck.file_service import ProjectFileService


class ProjectSearchService:
    """Project-wide text search via ripgrep (fixed-string, smart-case, gitignore-aware). `word` restricts to
    whole-word matches (used for find-usages). `glob` is a comma list of rg -g filters; `ignore` a comma list
    of directory names to exclude on top of gitignore."""

    _LINE_PARTS = 3

    def __init__(self, files: ProjectFileService) -> None:
        self._files = files

    async def search(self, root: str, query: str, glob: str, ignore: str, word: bool,
                     case_sensitive: bool, regex: bool) -> list[dict[str, str | int]]:
        base = self._files.resolve_confined(root, "")
        argv = [TermdeckConfig.RG_BIN, "--line-number", "--no-heading", "--color", "never",
                "--max-columns", "300", "--max-filesize", "2M", "--max-count", "50",
                "--case-sensitive" if case_sensitive else "--smart-case"]
        if not regex:
            argv.append("--fixed-strings")
        if word:
            argv.append("--word-regexp")
        for pattern in (token.strip() for token in glob.split(",") if token.strip()):
            argv.extend(("--glob", pattern))
        for directory in (token.strip() for token in ignore.split(",") if token.strip()):
            argv.extend(("--glob", f"!**/{directory}/**", "--glob", f"!{directory}/**"))
        argv.extend(("--", query, str(base)))
        proc = await asyncio.create_subprocess_exec(*argv, stdout=asyncio.subprocess.PIPE,
                                                    stderr=asyncio.subprocess.DEVNULL)
        try:
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=TermdeckConfig.SEARCH_TIMEOUT_SECONDS)
        except asyncio.TimeoutError:
            proc.kill()
            return []
        results: list[dict[str, str | int]] = []
        prefix = str(base) + "/"
        mtime_cache: dict[str, int] = {}
        for line in stdout.decode(errors="replace").splitlines():
            parts = line.split(":", self._LINE_PARTS - 1)
            if len(parts) < self._LINE_PARTS:
                continue
            path, line_no, text = parts
            rel = path[len(prefix):] if path.startswith(prefix) else path
            if rel not in mtime_cache:
                try:
                    mtime_cache[rel] = int((base / rel).stat().st_mtime)
                except (FileNotFoundError, OSError):
                    mtime_cache[rel] = 0
            results.append({"path": rel, "line": int(line_no), "text": text.strip()[:240], "mtime": mtime_cache[rel]})
            if len(results) >= TermdeckConfig.SEARCH_MAX_RESULTS:
                break
        return results

    async def replace_all(self, root: str, query: str, glob: str, ignore: str, word: bool, case_sensitive: bool,
                          regex: bool, replacement: str) -> dict[str, int]:
        base = self._files.resolve_confined(root, "")
        argv = [TermdeckConfig.RG_BIN, "--files-with-matches", "--color", "never", "--max-filesize", "2M",
                "--case-sensitive" if case_sensitive else "--smart-case"]
        if not regex:
            argv.append("--fixed-strings")
        if word:
            argv.append("--word-regexp")
        for pattern in (token.strip() for token in glob.split(",") if token.strip()):
            argv.extend(("--glob", pattern))
        for directory in (token.strip() for token in ignore.split(",") if token.strip()):
            argv.extend(("--glob", f"!**/{directory}/**", "--glob", f"!{directory}/**"))
        argv.extend(("--", query))
        proc = await asyncio.create_subprocess_exec(*argv, cwd=str(base), stdout=asyncio.subprocess.PIPE,
                                                    stderr=asyncio.subprocess.DEVNULL)
        try:
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=TermdeckConfig.SEARCH_TIMEOUT_SECONDS)
        except asyncio.TimeoutError:
            proc.kill()
            return {"files": 0, "replacements": 0}
        pattern_text = query if regex else re.escape(query)
        if word:
            pattern_text = r"\b(?:" + pattern_text + r")\b"
        flags = re.IGNORECASE if (not case_sensitive and query == query.lower()) else 0
        compiled = re.compile(pattern_text, flags)
        substitute = replacement if regex else replacement.replace("\\", r"\\")
        files_changed = 0
        total_replacements = 0
        for rel in stdout.decode(errors="replace").splitlines()[:TermdeckConfig.REPLACE_MAX_FILES]:
            path = base / rel
            try:
                text = path.read_text()
            except (UnicodeDecodeError, OSError):
                continue
            new_text, count = compiled.subn(substitute, text)
            if count:
                path.write_text(new_text)
                files_changed += 1
                total_replacements += count
        return {"files": files_changed, "replacements": total_replacements}

    async def find_files(self, root: str, query: str, ignore: str) -> list[dict[str, str]]:
        base = self._files.resolve_confined(root, "")
        argv = [TermdeckConfig.RG_BIN, "--files"]
        for directory in (token.strip() for token in ignore.split(",") if token.strip()):
            argv.extend(("--glob", f"!**/{directory}/**", "--glob", f"!{directory}/**"))
        proc = await asyncio.create_subprocess_exec(*argv, cwd=str(base), stdout=asyncio.subprocess.PIPE,
                                                    stderr=asyncio.subprocess.DEVNULL)
        try:
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=TermdeckConfig.SEARCH_TIMEOUT_SECONDS)
        except asyncio.TimeoutError:
            proc.kill()
            return []
        scored: list[tuple[int, int, int, str]] = []
        for rel in stdout.decode(errors="replace").splitlines():
            basename = rel.rsplit("/", 1)[-1]
            basename_score = self._fuzzy_span_score(query, basename)
            path_score = basename_score if basename_score is not None else self._fuzzy_span_score(query, rel)
            if path_score is None:
                continue
            scored.append((0 if basename_score is not None else 1, path_score, len(rel), rel))
        scored.sort()
        return [{"path": rel} for _, _, _, rel in scored[:TermdeckConfig.FIND_MAX_RESULTS]]

    @staticmethod
    def _fuzzy_span_score(query: str, candidate: str) -> int | None:
        lowered = candidate.lower()
        position = -1
        first = -1
        for ch in query.lower():
            position = lowered.find(ch, position + 1)
            if position == -1:
                return None
            if first == -1:
                first = position
        return (position - first + 1) - len(query)
