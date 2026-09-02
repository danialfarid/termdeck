import os
import fnmatch
import re
import asyncio
import time

from termdeck.config import TermdeckConfig
from termdeck.file_service import ProjectFileService


class FilenameMatcher:
    """Ranks file names against one filename-search query.

    Ranks, best first: the whole name, the name without its extension, a name starting with the
    query, a name containing the query, and last a name that needs a typo's worth of editing to fit
    it. Everything up to and including "contains" matched what was typed, letter for letter; only
    the last rank is a fuzzy match.

    Built once per search because the query's typo budget and pieces are the same for every
    candidate, and a repository hands this a lot of candidates.
    """

    CONTAINS_RANK = 3
    FUZZY_RANK = 4

    def __init__(self, query: str, case_sensitive: bool = False) -> None:
        self.case_sensitive = case_sensitive
        self.query = query if case_sensitive else query.lower()
        self.budget = self._edit_budget(len(self.query))
        # Pigeonhole: cut the query into 2 * budget + 1 pieces and a match within the budget has to
        # leave one of them untouched, since an edit spoils one piece and a swap of two neighbouring
        # letters at most two. A name holding none of the pieces cannot match, and skipping those
        # keeps the distance calculation away from most of a repository.
        count = 2 * self.budget + 1
        size = len(self.query) // count
        pieces = [self.query[index * size:(index + 1) * size] for index in range(count - 1)]
        pieces.append(self.query[(count - 1) * size:])
        self.pieces = [piece for piece in pieces if piece] if self.budget else []

    @staticmethod
    def _edit_budget(length: int) -> int:
        """How many typos a query of this length is allowed.

        Fuzzy matching is for what a slipped finger produces -- a wrong, missing, doubled or swapped
        letter -- so the budget stays small, and short queries get none at all: with even one edit
        allowed, a three-letter query would match half a repository.
        """
        if length < 4:
            return 0
        if length <= 7:
            return 1
        if length <= 12:
            return 2
        return 3

    def literal_score(self, basename: str, is_directory: bool) -> tuple[int, int | None]:
        """Rank and placing for a name that holds the query as typed, or None as the placing if it does not."""
        name = basename if self.case_sensitive else basename.lower()
        if name == self.query:
            return 0, 0
        if not is_directory and name.rsplit(".", 1)[0] == self.query:
            return 1, 0
        if name.startswith(self.query):
            return 2, 0
        position = name.find(self.query)
        return (self.CONTAINS_RANK, position) if position >= 0 else (self.CONTAINS_RANK, None)

    def fuzzy_distance(self, basename: str) -> int | None:
        """Typos between the query and the closest-matching stretch of the name, or None if too many."""
        name = basename if self.case_sensitive else basename.lower()
        if not self.pieces or not name:
            return None
        if not any(piece in name for piece in self.pieces):
            return None
        return self._closest_substring_distance(self.query, name, self.budget)

    @staticmethod
    def _closest_substring_distance(needle: str, haystack: str, budget: int) -> int | None:
        """Edit distance from the needle to the closest-matching stretch of the haystack.

        Free at both ends -- the match may start and stop anywhere in the name -- and a swap of two
        neighbouring letters costs one edit, which is what mistyping usually produces. Returns None
        as soon as the budget is exceeded: the best distance only grows with each further row, so a
        name that cannot match is abandoned after a few rows instead of being scored in full.
        """
        previous = [0] * (len(haystack) + 1)
        before_previous: list[int] = []
        for row, needle_character in enumerate(needle, 1):
            current = [row] + [0] * len(haystack)
            for column, haystack_character in enumerate(haystack, 1):
                cost = 0 if needle_character == haystack_character else 1
                current[column] = min(previous[column - 1] + cost, previous[column] + 1, current[column - 1] + 1)
                if (row > 1 and column > 1 and needle_character == haystack[column - 2]
                        and needle[row - 2] == haystack_character):
                    current[column] = min(current[column], before_previous[column - 2] + 1)
            if min(current) > budget:
                return None
            before_previous, previous = previous, current
        return min(previous)


class ProjectSearchService:
    """Project-wide text search via ripgrep (fixed-string, smart-case, gitignore-aware). `word` restricts to
    whole-word matches (used for find-usages). `glob` is a comma list of rg -g filters; `ignore` a comma list
    of directory names to exclude on top of gitignore."""

    _LINE_PARTS = 3
    _HIDDEN_IGNORE_PATTERNS = frozenset({".*", "**/.*"})
    FUZZY_FALLBACK_BELOW_RESULTS = 5

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
        return any(fnmatch.fnmatch(normalized, pattern) or any(fnmatch.fnmatch(segment, pattern) for segment in segments)
                   for pattern in patterns)

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
        # Ranking a whole repository's names is quick when the query matches literally and slow when
        # it has to measure typo distances, so it runs off the event loop either way: terminals share
        # this process, and their output should not wait behind a keystroke in the search box.
        ranked = await asyncio.to_thread(self._ranked_candidates, candidates, query, case_sensitive)
        results = [self._file_find_result(base, rel, is_dir) for _, _, _, _, rel, is_dir in ranked[:TermdeckConfig.FIND_MAX_RESULTS]]
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
        ranked = self._ranked_candidates(candidates, query, case_sensitive)
        results = [self._file_find_result(base, rel, is_dir) for _, _, _, _, rel, is_dir in ranked[:TermdeckConfig.FIND_MAX_RESULTS]]
        return self._attach_git_statuses(base, results)

    def _ranked_candidates(self, candidates: set[tuple[str, bool]], query: str,
                           case_sensitive: bool) -> list[tuple[int, int, int, int, str, bool]]:
        matcher = FilenameMatcher(query, case_sensitive)
        ranked: list[tuple[int, int, int, int, str, bool]] = []
        unmatched: list[tuple[str, bool]] = []
        for rel, is_dir in candidates:
            rank, placing = matcher.literal_score(rel.rsplit("/", 1)[-1], is_dir)
            if placing is None:
                unmatched.append((rel, is_dir))
                continue
            ranked.append((rank, placing, len(rel), int(is_dir), rel, is_dir))
        # Typos are worth chasing only when what was typed found next to nothing. With real matches
        # on screen the near-misses are noise, and measuring the distance to every other name in the
        # repository is the expensive part of the search.
        if len(ranked) < self.FUZZY_FALLBACK_BELOW_RESULTS:
            for rel, is_dir in unmatched:
                distance = matcher.fuzzy_distance(rel.rsplit("/", 1)[-1])
                if distance is None:
                    continue
                ranked.append((FilenameMatcher.FUZZY_RANK, distance, len(rel), int(is_dir), rel, is_dir))
        ranked.sort()
        return ranked

    @staticmethod
    def _file_find_result(base: os.PathLike[str], relative_path: str, is_directory: bool) -> dict[str, str | bool | int]:
        try:
            modified_time = int(os.stat(os.path.join(os.fspath(base), relative_path)).st_mtime)
        except OSError:
            modified_time = 0
        return {"path": relative_path, "is_dir": is_directory, "mtime": modified_time}

