import hashlib
import re
import subprocess
from pathlib import Path
from typing import TypedDict


class GitDiffHunk(TypedDict):
    hunk_id: str
    scope: str
    path: str
    old_start: int
    old_count: int
    new_start: int
    new_count: int
    kind: str
    heading: str


class GitFileHunks(TypedDict):
    path: str
    working: list[GitDiffHunk]
    staged: list[GitDiffHunk]


class GitHunkService:
    HUNK_HEADER_PATTERN = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$")
    MAX_PATCH_BYTES = 2 * 1024 * 1024

    def file_hunks(self, requested_root: Path, path: str) -> GitFileHunks:
        repository_root = self.repository_root(requested_root)
        selected_path = self.validated_path(repository_root, path)
        working_patch = self._run_git(repository_root, ["diff", "--no-ext-diff", "--binary", "--unified=3", "--", selected_path]).stdout
        staged_patch = self._run_git(repository_root, ["diff", "--cached", "--no-ext-diff", "--binary", "--unified=3",
                                                        "--", selected_path]).stdout
        return {"path": selected_path, "working": self._parse_patch(selected_path, "working", working_patch),
                "staged": self._parse_patch(selected_path, "staged", staged_patch)}

    def apply_hunk_action(self, requested_root: Path, path: str, scope: str, hunk_id: str, action: str) -> GitFileHunks:
        repository_root = self.repository_root(requested_root)
        selected_path = self.validated_path(repository_root, path)
        patch_bytes, hunk = self._current_hunk_patch(repository_root, selected_path, scope, hunk_id)
        if action == "stage" and scope == "working":
            self._apply_patch(repository_root, ["apply", "--cached", "--whitespace=nowarn", "-"], patch_bytes)
        elif action == "unstage" and scope == "staged":
            self._apply_patch(repository_root, ["apply", "--cached", "--reverse", "--whitespace=nowarn", "-"], patch_bytes)
        elif action == "revert" and scope == "working":
            self._apply_patch(repository_root, ["apply", "--reverse", "--whitespace=nowarn", "-"], patch_bytes)
        elif action == "revert" and scope == "staged":
            self._apply_patch(repository_root, ["apply", "--reverse", "--check", "-"], patch_bytes)
            self._apply_patch(repository_root, ["apply", "--cached", "--reverse", "--check", "-"], patch_bytes)
            self._apply_patch(repository_root, ["apply", "--reverse", "--whitespace=nowarn", "-"], patch_bytes)
            self._apply_patch(repository_root, ["apply", "--cached", "--reverse", "--whitespace=nowarn", "-"], patch_bytes)
        else:
            raise ValueError(f"unsupported {action} action for {scope} hunk {hunk['hunk_id']}")
        return self.file_hunks(repository_root, selected_path)

    def repository_root(self, requested_root: Path) -> Path:
        requested = requested_root.expanduser().resolve()
        result = self._run_git(requested, ["rev-parse", "--show-toplevel"])
        repository_root = Path(result.stdout.decode("utf-8", errors="replace").strip()).resolve()
        if not repository_root.is_dir():
            raise FileNotFoundError(str(repository_root))
        return repository_root

    @staticmethod
    def validated_path(repository_root: Path, path: str) -> str:
        if not path.strip() or any(character in path for character in "\x00\r\n"):
            raise ValueError(f"invalid Git path: {path}")
        target = (repository_root / path).resolve()
        if not target.is_relative_to(repository_root):
            raise ValueError(f"path outside repository: {path}")
        return str(target.relative_to(repository_root))

    def _current_hunk_patch(self, repository_root: Path, path: str, scope: str,
                            hunk_id: str) -> tuple[bytes, GitDiffHunk]:
        if scope not in {"working", "staged"}:
            raise ValueError(f"invalid Git hunk scope: {scope}")
        arguments = ["diff"]
        if scope == "staged":
            arguments.append("--cached")
        arguments.extend(["--no-ext-diff", "--binary", "--unified=3", "--", path])
        patch = self._run_git(repository_root, arguments).stdout
        for parsed_patch, hunk in self._parse_patch_with_content(path, scope, patch):
            if hunk["hunk_id"] == hunk_id:
                return parsed_patch, hunk
        raise ValueError("the selected Git hunk is stale; refresh the file and try again")

    def _parse_patch(self, path: str, scope: str, patch: bytes) -> list[GitDiffHunk]:
        return [hunk for _, hunk in self._parse_patch_with_content(path, scope, patch)]

    def _parse_patch_with_content(self, path: str, scope: str, patch: bytes) -> list[tuple[bytes, GitDiffHunk]]:
        if len(patch) > self.MAX_PATCH_BYTES:
            raise ValueError(f"Git diff exceeds the {self.MAX_PATCH_BYTES // (1024 * 1024)} MB hunk limit")
        lines = patch.decode("utf-8", errors="replace").splitlines(keepends=True)
        first_hunk_index = next((index for index, line in enumerate(lines) if line.startswith("@@ ")), -1)
        if first_hunk_index < 0:
            return []
        file_header = "".join(lines[:first_hunk_index])
        hunk_starts = [index for index, line in enumerate(lines) if line.startswith("@@ ")]
        parsed: list[tuple[bytes, GitDiffHunk]] = []
        for position, start_index in enumerate(hunk_starts):
            end_index = hunk_starts[position + 1] if position + 1 < len(hunk_starts) else len(lines)
            hunk_lines = lines[start_index:end_index]
            match = self.HUNK_HEADER_PATTERN.match(hunk_lines[0].rstrip("\r\n"))
            if not match:
                raise OSError(f"invalid Git hunk header: {hunk_lines[0].strip()}")
            old_start, old_count = int(match.group(1)), int(match.group(2) or "1")
            new_start, new_count = int(match.group(3)), int(match.group(4) or "1")
            patch_text = file_header + "".join(hunk_lines)
            hunk_id = hashlib.sha256(f"{scope}\x00{patch_text}".encode()).hexdigest()[:20]
            kind = "added" if old_count == 0 else "deleted" if new_count == 0 else "modified"
            heading = match.group(5).strip() or self._first_changed_line(hunk_lines[1:])
            parsed.append((patch_text.encode(), {"hunk_id": hunk_id, "scope": scope, "path": path,
                                                 "old_start": old_start, "old_count": old_count,
                                                 "new_start": new_start, "new_count": new_count,
                                                 "kind": kind, "heading": heading}))
        return parsed

    @staticmethod
    def _first_changed_line(lines: list[str]) -> str:
        for line in lines:
            if line.startswith(("+", "-")) and not line.startswith(("+++", "---")):
                return line[1:].strip()[:120]
        return "Changed lines"

    @staticmethod
    def _apply_patch(repository_root: Path, arguments: list[str], patch: bytes) -> None:
        result = subprocess.run(["git", "-C", str(repository_root), *arguments], input=patch, capture_output=True,
                                timeout=30, check=False)
        if result.returncode != 0:
            detail = result.stderr.decode("utf-8", errors="replace").strip()
            output = result.stdout.decode("utf-8", errors="replace").strip()
            raise OSError(detail or output or "Git hunk operation failed")

    @staticmethod
    def _run_git(repository_root: Path, arguments: list[str], timeout: int = 30) -> subprocess.CompletedProcess[bytes]:
        result = subprocess.run(["git", "-C", str(repository_root), *arguments], capture_output=True,
                                timeout=timeout, check=False)
        if result.returncode != 0:
            detail = result.stderr.decode("utf-8", errors="replace").strip()
            output = result.stdout.decode("utf-8", errors="replace").strip()
            raise OSError(detail or output or "git command failed")
        return result
