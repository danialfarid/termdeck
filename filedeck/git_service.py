import re
import subprocess
from pathlib import Path


class FileDeckGitService:
    COMMIT_ID_PATTERN = re.compile(r"[0-9a-fA-F]{7,64}")

    def get_branch_state(self, repository_root: Path, limit: int = 100) -> dict[str, object]:
        base = repository_root.resolve()
        branch_result = self._run_git(base, ["branch", "--show-current"])
        status_result = self._run_git(base, ["status", "--porcelain=v1", "--branch", "--untracked-files=all"])
        branch = branch_result.stdout.decode("utf-8", errors="replace").strip() or "(detached HEAD)"
        status_lines = status_result.stdout.decode("utf-8", errors="replace").splitlines()
        upstream = self._upstream_from_status(status_lines[0] if status_lines else "")
        files = [self._parse_status_line(line) for line in status_lines[1:] if line and not line.startswith("##")]
        commits = self.get_history(base, "", limit)
        return {"branch": branch, "upstream": upstream, "files": files, "commits": commits}

    def get_history(self, repository_root: Path, relative_path: str, limit: int = 100) -> list[dict[str, str]]:
        base = repository_root.resolve()
        arguments = ["log", "--format=%H%x00%h%x00%an%x00%ad%x00%s", "--date=iso-strict", "-n",
                     str(max(1, min(limit, 200)))]
        if relative_path:
            arguments.extend(["--follow", "--", self._validated_relative_path(base, relative_path)])
        result = self._run_git(base, arguments)
        entries = []
        for line in result.stdout.decode("utf-8", errors="replace").splitlines():
            fields = line.split("\x00", 4)
            if len(fields) == 5:
                entries.append({"commit_id": fields[0], "short_id": fields[1], "author": fields[2],
                                "committed_at": fields[3], "message": fields[4]})
        return entries

    def get_blame(self, repository_root: Path, relative_path: str) -> list[dict[str, str | int]]:
        base = repository_root.resolve()
        path = self._validated_relative_path(base, relative_path)
        result = self._run_git(base, ["blame", "--line-porcelain", "--", path])
        records: list[dict[str, str | int]] = []
        current: dict[str, str | int] = {}
        for line in result.stdout.decode("utf-8", errors="replace").splitlines():
            header = re.match(r"^([0-9a-f]{7,64}) \d+ (\d+)(?: \d+)?$", line)
            if header:
                if "text" in current:
                    records.append(current)
                current = {"commit_id": header.group(1), "line": int(header.group(2))}
            elif line.startswith("author "):
                current["author"] = line[7:]
            elif line.startswith("author-time "):
                current["author_time"] = int(line[12:])
            elif line.startswith("summary "):
                current["summary"] = line[8:]
            elif line.startswith("\t"):
                current["text"] = line[1:]
        if "text" in current:
            records.append(current)
        return records

    def get_diff(self, repository_root: Path, relative_path: str, commit_id: str = "") -> dict[str, str]:
        base = repository_root.resolve()
        path = self._validated_relative_path(base, relative_path)
        if commit_id and not self.COMMIT_ID_PATTERN.fullmatch(commit_id):
            raise ValueError("invalid git commit id")
        target = base / path
        if not commit_id and target.exists() and not self._is_tracked(base, path):
            result = self._run_git(base, ["diff", "--no-ext-diff", "--no-index", "--unified=80", "/dev/null", str(target)], {0, 1})
            return {"path": path, "commit_id": commit_id, "diff": result.stdout.decode("utf-8", errors="replace")}
        arguments = ["diff", "--no-ext-diff", "--unified=80"]
        arguments.extend([f"{commit_id}^!" if commit_id else "HEAD", "--", path])
        result = self._run_git(base, arguments, allow_return_codes={0, 1})
        return {"path": path, "commit_id": commit_id, "diff": result.stdout.decode("utf-8", errors="replace")}

    @classmethod
    def _is_tracked(cls, repository_root: Path, relative_path: str) -> bool:
        result = cls._run_git(repository_root, ["ls-files", "--error-unmatch", "--", relative_path], {0, 1})
        return result.returncode == 0

    @staticmethod
    def _upstream_from_status(status_line: str) -> str:
        if "..." not in status_line:
            return ""
        upstream = status_line.split("...", 1)[1].split(" ", 1)[0]
        return upstream.split("[", 1)[0]

    @staticmethod
    def _parse_status_line(line: str) -> dict[str, str]:
        code = line[:2]
        path = line[3:] if len(line) > 3 else ""
        if " -> " in path:
            path = path.rsplit(" -> ", 1)[1]
        status = "?" if code == "??" else next((value for value in code if value != " "), "M")
        return {"path": path, "status": status, "index_status": code[:1], "worktree_status": code[1:2]}

    @staticmethod
    def _validated_relative_path(repository_root: Path, relative_path: str) -> str:
        target = (repository_root / relative_path).resolve()
        if not target.is_relative_to(repository_root):
            raise ValueError("file path is outside the repository")
        return str(target.relative_to(repository_root))

    @staticmethod
    def _run_git(repository_root: Path, arguments: list[str], allow_return_codes: set[int] | None = None) -> subprocess.CompletedProcess[bytes]:
        result = subprocess.run(["git", "-C", str(repository_root), *arguments], capture_output=True, timeout=10, check=False)
        allowed = allow_return_codes or {0}
        if result.returncode not in allowed:
            message = result.stderr.decode("utf-8", errors="replace").strip() or "git command failed"
            raise OSError(message)
        return result
