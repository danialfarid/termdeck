import os
import fnmatch
import re
import asyncio
import time

from termdeck.config import TermdeckConfig
from termdeck.file_service import ProjectFileService


class ProjectSearchService:
    """Project-wide text search via ripgrep (fixed-string, smart-case, gitignore-aware). `word` restricts to
    whole-word matches (used for find-usages). `glob` is a comma list of rg -g filters; `ignore` a comma list
    of directory names to exclude on top of gitignore."""

    _LINE_PARTS = 3
    _HIDDEN_IGNORE_PATTERNS = frozenset({".*", "**/.*"})

    def __init__(self, files: ProjectFileService) -> None:
        self._files = files

    @staticmethod
    def _split_tokens(raw: str) -> tuple[list[str], list[str]]:
        exact = []
        wildcard = []
        for token in (value.strip() for value in raw.split(",") if value.strip()):
            if any(ch in token for ch in "*?[]"):
                wildcard.append(token)
            else:
                exact.append(token)
        return exact, wildcard

    @staticmethod
    def _split_glob_tokens(raw: str) -> tuple[list[str], list[str]]:
        include = []
        exclude = []
        for token in (value.strip() for value in raw.split(",") if value.strip()):
            if token.startswith("!"):
                pattern = token[1:].strip()
                if pattern:
                    exclude.append(pattern)
            else:
                include.append(token)
        return include, exclude

    @classmethod
    def _normalize_hidden_ignore(cls, raw: str, include_hidden: bool) -> str:
        tokens = [value.strip() for value in raw.split(",") if value.strip()]
        if include_hidden:
            tokens = [token for token in tokens if token not in cls._HIDDEN_IGNORE_PATTERNS]
        elif not any(token in cls._HIDDEN_IGNORE_PATTERNS for token in tokens):
            tokens.append(".*")
        return ",".join(tokens)

    @staticmethod
    def _path_matches_glob(path: str, patterns: list[str]) -> bool:
        if not patterns:
            return False
        normalized = path.replace("\\", "/")
        segments = normalized.split("/")
        return any(fnmatch.fnmatch(normalized, pattern) or segment == pattern for pattern in patterns for segment in segments)

    @staticmethod
    def _path_is_ignored(path: str, exact: list[str], wildcard: list[str]) -> bool:
        if not path or (not exact and not wildcard):
            return False
        normalized = path.replace("\\", "/")
        parts = set(normalized.split("/"))
        for part in parts:
            for pattern in exact:
                if part == pattern or (pattern.startswith(".") and part.startswith(pattern)):
                    return True
        return any(fnmatch.fnmatch(normalized, pattern) or
                   fnmatch.fnmatch(f"{normalized}/", pattern) or
                   any(fnmatch.fnmatch(part, pattern) for part in parts) for pattern in wildcard)

    @staticmethod
    def _path_contains_hidden_component(path: str) -> bool:
        return any(part.startswith(".") for part in path.replace("\\", "/").split("/") if part)

    def _attach_git_statuses(self, root: os.PathLike[str], results: list[dict[str, str | int]]) -> list[dict[str, str | int]]:
        paths = {str(result["path"]) for result in results}
        statuses = self._files.git_statuses_for_files(os.fspath(root), paths)
        for result in results:
            result["git_status"] = statuses.get(str(result["path"]), "")
        return results

    def _python_search(self, base: os.PathLike[str], query: str, glob: str, ignore: str, word: bool,
                       case_sensitive: bool, regex: bool) -> list[dict[str, str | int]]:
        query_lower = query.lower()
        pattern = query if regex else re.escape(query)
        if word:
            pattern = rf"\b(?:{pattern})\b"
        flags = re.IGNORECASE if (not case_sensitive and query == query_lower) else 0
        compiled = re.compile(pattern, flags)
        ignore_exact, ignore_wildcard = self._split_tokens(ignore)
        include_patterns, exclude_patterns = self._split_glob_tokens(glob)
        results: list[dict[str, str | int]] = []
        mtime_cache: dict[str, int] = {}
        base_path = os.fspath(base)
        deadline = time.monotonic() + TermdeckConfig.SEARCH_TIMEOUT_SECONDS
        for current, dirs, files in os.walk(base_path):
            if time.monotonic() > deadline:
                return results
            rel_dir = os.path.relpath(current, base_path)
            if rel_dir == ".":
                rel_dir = ""
            keep_dirs = []
            for directory in dirs:
                rel_directory = directory if not rel_dir else f"{rel_dir}/{directory}"
                if self._path_is_ignored(rel_directory, ignore_exact, ignore_wildcard):
                    continue
                keep_dirs.append(directory)
            dirs[:] = keep_dirs
            for name in files:
                rel_path = name if not rel_dir else f"{rel_dir}/{name}"
                if self._path_is_ignored(rel_path, ignore_exact, ignore_wildcard):
                    continue
                if exclude_patterns and self._path_matches_glob(rel_path, exclude_patterns):
                    continue
                if include_patterns and not self._path_matches_glob(rel_path, include_patterns):
                    continue
                if time.monotonic() > deadline:
                    return results
                path = os.path.join(base_path, rel_path)
                try:
                    stat = os.stat(path)
                    if stat.st_size > TermdeckConfig.FILE_READ_MAX_BYTES:
                        continue
                    with open(path, "rb") as handle:
                        text = handle.read(TermdeckConfig.FILE_READ_MAX_BYTES)
                    if b"\x00" in text[:8192]:
                        continue
                    lines = text.decode("utf-8", errors="replace").splitlines()
                except (FileNotFoundError, OSError, UnicodeDecodeError):
                    continue
                rel = rel_path
                mtime_cache.setdefault(rel, int(stat.st_mtime))
                for number, line in enumerate(lines, 1):
                    if not compiled.search(line):
                        continue
                    results.append({"path": rel, "line": number, "text": line.strip()[:240], "mtime": mtime_cache[rel]})
                    if len(results) >= TermdeckConfig.SEARCH_MAX_RESULTS:
                        return results
        return results

    async def search(self, root: str, query: str, glob: str, ignore: str, word: bool,
                     case_sensitive: bool, regex: bool, include_hidden: bool = False) -> list[dict[str, str | int]]:
        base = self._files.resolve_confined(root, "")
        normalized_ignore = self._normalize_hidden_ignore(ignore, include_hidden)
        argv = [TermdeckConfig.RG_BIN, "--line-number", "--no-heading", "--color", "never",
                "--max-columns", "300", "--max-filesize", "2M", "--max-count", "50",
                "--case-sensitive" if case_sensitive else "--smart-case"]
        if include_hidden:
            argv.append("--hidden")
        if not regex:
            argv.append("--fixed-strings")
        if word:
            argv.append("--word-regexp")
        for pattern in (token.strip() for token in glob.split(",") if token.strip()):
            argv.extend(("--glob", pattern))
        for directory in (token.strip() for token in normalized_ignore.split(",") if token.strip()):
            argv.extend(("--glob", f"!**/{directory}/**", "--glob", f"!{directory}/**"))
        argv.extend(("--", query, str(base)))
        try:
            proc = await asyncio.create_subprocess_exec(*argv, stdout=asyncio.subprocess.PIPE,
                                                        stderr=asyncio.subprocess.DEVNULL)
            try:
                stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=TermdeckConfig.SEARCH_TIMEOUT_SECONDS)
            except asyncio.TimeoutError:
                proc.kill()
                return []
            results = []
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
            if proc.returncode not in (None, 0):
                return self._attach_git_statuses(base, self._python_search(base, query, glob, normalized_ignore, word, case_sensitive, regex))
            return self._attach_git_statuses(base, results)
        except FileNotFoundError:
            return self._attach_git_statuses(base, self._python_search(base, query, glob, normalized_ignore, word, case_sensitive, regex))

    async def replace_all(self, root: str, query: str, glob: str, ignore: str, word: bool, case_sensitive: bool,
                          regex: bool, replacement: str, paths: list[str] | None = None,
                          include_hidden: bool = False) -> dict[str, int]:
        base = self._files.resolve_confined(root, "")
        normalized_ignore = self._normalize_hidden_ignore(ignore, include_hidden)
        if paths:
            relative_paths = [str(self._files.resolve_confined(root, path).relative_to(base))
                              for path in paths[:TermdeckConfig.REPLACE_MAX_FILES]]
            if not include_hidden:
                relative_paths = [path for path in relative_paths if not self._path_contains_hidden_component(path)]
        else:
            argv = [TermdeckConfig.RG_BIN, "--files-with-matches", "--color", "never", "--max-filesize", "2M",
                    "--case-sensitive" if case_sensitive else "--smart-case"]
            if include_hidden:
                argv.append("--hidden")
            if not regex:
                argv.append("--fixed-strings")
            if word:
                argv.append("--word-regexp")
            for pattern in (token.strip() for token in glob.split(",") if token.strip()):
                argv.extend(("--glob", pattern))
            for directory in (token.strip() for token in normalized_ignore.split(",") if token.strip()):
                argv.extend(("--glob", f"!**/{directory}/**", "--glob", f"!{directory}/**"))
            argv.extend(("--", query))
            proc = await asyncio.create_subprocess_exec(*argv, cwd=str(base), stdout=asyncio.subprocess.PIPE,
                                                        stderr=asyncio.subprocess.DEVNULL)
            try:
                stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=TermdeckConfig.SEARCH_TIMEOUT_SECONDS)
            except asyncio.TimeoutError:
                proc.kill()
                return {"files": 0, "replacements": 0}
            relative_paths = stdout.decode(errors="replace").splitlines()[:TermdeckConfig.REPLACE_MAX_FILES]
        pattern_text = query if regex else re.escape(query)
        if word:
            pattern_text = r"\b(?:" + pattern_text + r")\b"
        flags = re.IGNORECASE if (not case_sensitive and query == query.lower()) else 0
        compiled = re.compile(pattern_text, flags)
        substitute = replacement if regex else replacement.replace("\\", r"\\")
        files_changed = 0
        total_replacements = 0
        for rel in relative_paths:
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

    async def find_files(self, root: str, query: str, ignore: str, glob: str = "", case_sensitive: bool = False,
                         include_hidden: bool = False) -> list[dict[str, str | bool | int]]:
        base = self._files.resolve_confined(root, "")
        normalized_ignore = self._normalize_hidden_ignore(ignore, include_hidden)
        try:
            argv = [TermdeckConfig.RG_BIN, "--files"]
            if include_hidden:
                argv.append("--hidden")
            for pattern in (token.strip() for token in glob.split(",") if token.strip()):
                argv.extend(("--glob", pattern))
            for directory in (token.strip() for token in normalized_ignore.split(",") if token.strip()):
                argv.extend(("--glob", f"!**/{directory}/**", "--glob", f"!{directory}/**"))
            proc = await asyncio.create_subprocess_exec(*argv, cwd=str(base), stdout=asyncio.subprocess.PIPE,
                                                        stderr=asyncio.subprocess.DEVNULL)
            try:
                stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=TermdeckConfig.SEARCH_TIMEOUT_SECONDS)
            except asyncio.TimeoutError:
                proc.kill()
                return []
            lines = stdout.decode(errors="replace").splitlines()
            if proc.returncode not in (None, 0):
                return self._python_find_files(base, query, normalized_ignore, glob, case_sensitive)
            stdout_lines = lines
        except asyncio.TimeoutError:
            return []
        except FileNotFoundError:
            return self._python_find_files(base, query, normalized_ignore, glob, case_sensitive)
        # `rg --files` intentionally returns files only. Add the parent
        # directories of those files as candidates so a folder name is a real
        # filename-search result too while avoiding a second full filesystem walk.
        candidates: set[tuple[str, bool]] = set()
        for rel in stdout_lines:
            rel = rel.strip()
            if not rel:
                continue
            candidates.add((rel, False))
            parts = rel.split("/")
            candidates.update(("/".join(parts[:index]), True) for index in range(1, len(parts)))
        scored: list[tuple[int, int, int, int, str, bool]] = []
        for rel, is_dir in candidates:
            basename = rel.rsplit("/", 1)[-1]
            match_rank, basename_score = self._filename_match_score(query, basename, is_dir, case_sensitive)
            if basename_score is None:
                continue
            scored.append((match_rank,
                           basename_score, len(rel), int(is_dir), rel, is_dir))
        scored.sort()
        results = [self._file_find_result(base, rel, is_dir) for _, _, _, _, rel, is_dir in scored[:TermdeckConfig.FIND_MAX_RESULTS]]
        return self._attach_git_statuses(base, results)

    def _python_find_files(self, base: os.PathLike[str], query: str, ignore: str, glob: str, case_sensitive: bool) -> list[dict[str, str | bool | int]]:
        ignore_exact, ignore_wildcard = self._split_tokens(ignore)
        include_patterns, exclude_patterns = self._split_glob_tokens(glob)
        candidates: set[tuple[str, bool]] = set()
        base_path = os.fspath(base)
        deadline = time.monotonic() + TermdeckConfig.SEARCH_TIMEOUT_SECONDS
        for current, dirs, files in os.walk(base_path):
            if time.monotonic() > deadline:
                break
            rel_dir = os.path.relpath(current, base_path)
            if rel_dir == ".":
                rel_dir = ""
            keep_dirs = []
            for directory in dirs:
                rel_directory = directory if not rel_dir else f"{rel_dir}/{directory}"
                if self._path_is_ignored(rel_directory, ignore_exact, ignore_wildcard):
                    continue
                if any(self._path_matches_glob(rel_directory, [pattern]) for pattern in exclude_patterns):
                    continue
                candidates.add((rel_directory, True))
                keep_dirs.append(directory)
            dirs[:] = keep_dirs
            for name in files:
                rel_path = name if not rel_dir else f"{rel_dir}/{name}"
                if self._path_is_ignored(rel_path, ignore_exact, ignore_wildcard):
                    continue
                if exclude_patterns and self._path_matches_glob(rel_path, exclude_patterns):
                    continue
                if include_patterns and not self._path_matches_glob(rel_path, include_patterns):
                    continue
                candidates.add((rel_path, False))
        scored: list[tuple[int, int, int, int, str, bool]] = []
        for rel, is_dir in candidates:
            basename = rel.rsplit("/", 1)[-1]
            match_rank, basename_score = self._filename_match_score(query, basename, is_dir, case_sensitive)
            if basename_score is None:
                continue
            scored.append((match_rank,
                           basename_score, len(rel), int(is_dir), rel, is_dir))
        scored.sort()
        results = [self._file_find_result(base, rel, is_dir) for _, _, _, _, rel, is_dir in scored[:TermdeckConfig.FIND_MAX_RESULTS]]
        return self._attach_git_statuses(base, results)

    @staticmethod
    def _file_find_result(base: os.PathLike[str], relative_path: str, is_directory: bool) -> dict[str, str | bool | int]:
        try:
            modified_time = int(os.stat(os.path.join(os.fspath(base), relative_path)).st_mtime)
        except OSError:
            modified_time = 0
        return {"path": relative_path, "is_dir": is_directory, "mtime": modified_time}

    @staticmethod
    def _filename_fuzzy_score(query: str, candidate: str, case_sensitive: bool = False) -> int | None:
        normalized_candidate = candidate if case_sensitive else candidate.lower()
        normalized_query = query if case_sensitive else query.lower()
        cursor = 0
        first_position = None
        gap_score = 0
        for character in normalized_query:
            position = normalized_candidate.find(character, cursor)
            if position < 0:
                return None
            if first_position is None:
                first_position = position
            gap_score += position - cursor
            cursor = position + 1
        return (first_position or 0) * 4 + gap_score

    @classmethod
    def _filename_match_score(cls, query: str, basename: str, is_directory: bool, case_sensitive: bool) -> tuple[int, int | None]:
        normalized_query = query if case_sensitive else query.lower()
        normalized_name = basename if case_sensitive else basename.lower()
        if normalized_name == normalized_query:
            return 0, 0
        if not is_directory and normalized_name.rsplit(".", 1)[0] == normalized_query:
            return 1, 0
        if normalized_name.startswith(normalized_query):
            return 2, 0
        return 4, cls._filename_fuzzy_score(query, basename, case_sensitive)
