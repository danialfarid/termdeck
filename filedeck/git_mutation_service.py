import os
import shlex
import stat
import subprocess
import tempfile
from pathlib import Path
from typing import Literal, TypedDict


class GitOperationState(TypedDict):
    in_progress: bool
    operation: str
    conflicts: list[str]


class GitMutationResult(TypedDict):
    completed: bool
    operation: GitOperationState
    output: str


class GitRebaseCommit(TypedDict):
    commit_id: str
    short_id: str
    subject: str
    author: str
    committed_at: int


class GitRebasePlan(TypedDict):
    base: str
    commits: list[GitRebaseCommit]


class GitRebaseEntry(TypedDict):
    commit_id: str
    action: Literal["pick", "squash", "fixup", "drop"]


class GitMutationService:
    COMMIT_ACTIONS = frozenset({"cherry-pick", "revert"})
    REBASE_ACTIONS = frozenset({"pick", "squash", "fixup", "drop"})
    MAX_REBASE_COMMITS = 50
    MAX_GITIGNORE_BYTES = 1024 * 1024

    def commit_action(self, requested_root: Path, commit_id: str, action: str) -> GitMutationResult:
        repository_root = self.repository_root(requested_root)
        if action not in self.COMMIT_ACTIONS:
            raise ValueError(f"unsupported Git commit action: {action}")
        revision = self.validated_revision(repository_root, commit_id)
        arguments = ["cherry-pick", revision] if action == "cherry-pick" else ["revert", "--no-edit", revision]
        environment = dict(os.environ)
        environment["GIT_EDITOR"] = "true"
        return self._run_mutation_with_operation_state(repository_root, arguments, 120, environment)

    def operation_action(self, requested_root: Path, action: str) -> GitMutationResult:
        repository_root = self.repository_root(requested_root)
        state = self.operation_state(repository_root)
        operation = state["operation"]
        if not state["in_progress"]:
            raise ValueError("no Git operation is in progress")
        if action not in {"continue", "abort", "skip"}:
            raise ValueError(f"unknown Git operation action: {action}")
        if operation == "rebase":
            arguments = ["rebase", f"--{action}"]
        elif operation == "cherry-pick":
            arguments = ["cherry-pick", f"--{action}"]
        elif operation == "revert":
            if action == "skip":
                raise ValueError("revert does not support skipping")
            arguments = ["revert", f"--{action}"]
        elif operation == "merge":
            if action == "continue":
                arguments = ["merge", "--continue"]
            elif action == "abort":
                arguments = ["merge", "--abort"]
            else:
                raise ValueError("merge does not support skipping")
        else:
            raise ValueError(f"unsupported Git operation: {operation}")
        environment = dict(os.environ)
        environment["GIT_EDITOR"] = "true"
        return self._run_mutation_with_operation_state(repository_root, arguments, 120, environment)

    def rebase_plan(self, requested_root: Path, limit: int = 12) -> GitRebasePlan:
        repository_root = self.repository_root(requested_root)
        commit_limit = max(2, min(limit, self.MAX_REBASE_COMMITS))
        result = self._run_git(repository_root, ["log", "--first-parent", f"--max-count={commit_limit}",
                                                 "--format=%H%x00%h%x00%s%x00%an%x00%ct%x00%P"])
        commits: list[GitRebaseCommit] = []
        base = ""
        for line in result.stdout.decode("utf-8", errors="replace").splitlines():
            fields = line.split("\x00", 5)
            parents = fields[5].split() if len(fields) == 6 else []
            if len(fields) != 6 or len(parents) != 1:
                break
            commits.append({"commit_id": fields[0], "short_id": fields[1], "subject": fields[2],
                            "author": fields[3], "committed_at": int(fields[4])})
            base = parents[0]
        commits.reverse()
        if not commits:
            return {"base": "", "commits": []}
        return {"base": base, "commits": commits}

    def interactive_rebase(self, requested_root: Path, base: str, entries: list[GitRebaseEntry]) -> GitMutationResult:
        repository_root = self.repository_root(requested_root)
        if self._run_git(repository_root, ["status", "--porcelain"]).stdout:
            raise ValueError("interactive rebase requires a clean working tree")
        base_id = self.validated_revision(repository_root, base)
        if self._run_git(repository_root, ["rev-list", "--merges", f"{base_id}..HEAD"]).stdout:
            raise ValueError("interactive rebase cannot cross a merge commit")
        expected_result = self._run_git(repository_root, ["rev-list", "--reverse", "--first-parent", f"{base_id}..HEAD"])
        expected_commits = expected_result.stdout.decode("utf-8", errors="replace").splitlines()
        requested_commits = [self.validated_revision(repository_root, entry["commit_id"]) for entry in entries]
        if len(entries) < 2 or len(entries) > self.MAX_REBASE_COMMITS or len(requested_commits) != len(expected_commits) or \
                set(requested_commits) != set(expected_commits):
            raise ValueError("the rebase plan is stale or does not contain every commit in the selected range")
        previous_commit_kept = False
        todo_lines: list[str] = []
        for entry, revision in zip(entries, requested_commits, strict=True):
            action = entry["action"]
            if action not in self.REBASE_ACTIONS:
                raise ValueError(f"invalid rebase action: {action}")
            if action in {"squash", "fixup"} and not previous_commit_kept:
                raise ValueError(f"{action} needs a preceding picked commit")
            subject = self._run_git(repository_root, ["show", "-s", "--format=%s", revision]).stdout.decode(
                "utf-8", errors="replace").strip()
            todo_lines.append(f"{action} {revision} {subject}")
            if action != "drop":
                previous_commit_kept = True
        todo_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile("w", encoding="utf-8", prefix="termdeck-rebase-", suffix=".todo",
                                             delete=False) as todo_file:
                todo_file.write("\n".join(todo_lines) + "\n")
                todo_path = Path(todo_file.name)
            environment = dict(os.environ)
            environment["GIT_SEQUENCE_EDITOR"] = f"cp {shlex.quote(str(todo_path))}"
            environment["GIT_EDITOR"] = "true"
            return self._run_mutation_with_operation_state(repository_root, ["rebase", "-i", base_id], 300, environment)
        finally:
            if todo_path is not None:
                todo_path.unlink(missing_ok=True)

    def operation_state(self, requested_root: Path) -> GitOperationState:
        repository_root = self.repository_root(requested_root)
        operation = ""
        if self._git_path(repository_root, "rebase-merge").exists() or self._git_path(repository_root, "rebase-apply").exists():
            operation = "rebase"
        elif self._git_path(repository_root, "CHERRY_PICK_HEAD").exists():
            operation = "cherry-pick"
        elif self._git_path(repository_root, "REVERT_HEAD").exists():
            operation = "revert"
        elif self._git_path(repository_root, "MERGE_HEAD").exists():
            operation = "merge"
        conflicts = self._run_git(repository_root, ["diff", "--name-only", "--diff-filter=U"]).stdout.decode(
            "utf-8", errors="replace").splitlines()
        return {"in_progress": bool(operation), "operation": operation, "conflicts": conflicts}

    def update_gitignore(self, requested_root: Path, path: str, mode: str, directory: bool) -> str:
        repository_root = self.repository_root(requested_root)
        selected_path = self.validated_path(repository_root, path)
        gitignore_path = repository_root / ".gitignore"
        existing = gitignore_path.read_text(encoding="utf-8") if gitignore_path.exists() else ""
        file_mode = stat.S_IMODE(gitignore_path.stat().st_mode) if gitignore_path.exists() else 0o644
        if len(existing.encode()) > self.MAX_GITIGNORE_BYTES:
            raise ValueError(".gitignore is too large to edit from TermDeck")
        exact_pattern = f"/{self._escaped_gitignore_path(selected_path)}{'/' if directory else ''}"
        name = Path(selected_path).name
        name_pattern = f"{self._escaped_gitignore_path(name)}{'/' if directory else ''}"
        lines = existing.splitlines()
        if mode == "exact":
            updated_lines = self._append_unique(lines, exact_pattern)
        elif mode == "name":
            updated_lines = self._append_unique(lines, name_pattern)
        elif mode == "unignore":
            removed_patterns = {exact_pattern, f"!{exact_pattern}"}
            updated_lines = [line for line in lines if line.strip() not in removed_patterns]
            for parent in reversed(Path(selected_path).parents):
                if str(parent) == ".":
                    continue
                updated_lines = self._append_unique(updated_lines, f"!/{self._escaped_gitignore_path(str(parent))}/")
            updated_lines = self._append_unique(updated_lines, f"!{exact_pattern}")
        else:
            raise ValueError(f"unknown Git ignore mode: {mode}")
        content = "\n".join(updated_lines).rstrip("\n") + "\n"
        temporary_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=repository_root, prefix=".termdeck-gitignore-",
                                             delete=False) as temporary_file:
                temporary_file.write(content)
                temporary_path = Path(temporary_file.name)
            temporary_path.chmod(file_mode)
            os.replace(temporary_path, gitignore_path)
            temporary_path = None
        finally:
            if temporary_path is not None:
                temporary_path.unlink(missing_ok=True)
        return exact_pattern if mode != "name" else name_pattern

    def repository_root(self, requested_root: Path) -> Path:
        requested = requested_root.expanduser().resolve()
        result = self._run_git(requested, ["rev-parse", "--show-toplevel"])
        repository_root = Path(result.stdout.decode("utf-8", errors="replace").strip()).resolve()
        if not repository_root.is_dir():
            raise FileNotFoundError(str(repository_root))
        return repository_root

    @classmethod
    def validated_revision(cls, repository_root: Path, revision: str) -> str:
        normalized = revision.strip()
        if not normalized or len(normalized) > 200 or normalized.startswith("-") or any(character in normalized for character in "\x00\r\n"):
            raise ValueError(f"invalid Git revision: {revision}")
        result = cls._run_git(repository_root, ["rev-parse", "--verify", f"{normalized}^{{commit}}"])
        return result.stdout.decode("utf-8", errors="replace").strip()

    @staticmethod
    def validated_path(repository_root: Path, path: str) -> str:
        if not path.strip() or any(character in path for character in "\x00\r\n"):
            raise ValueError(f"invalid Git path: {path}")
        target = (repository_root / path).resolve()
        if not target.is_relative_to(repository_root):
            raise ValueError(f"path outside repository: {path}")
        return str(target.relative_to(repository_root))

    def _run_mutation_with_operation_state(self, repository_root: Path, arguments: list[str], timeout: int,
                                           environment: dict[str, str] | None = None) -> GitMutationResult:
        result = subprocess.run(["git", "-C", str(repository_root), *arguments], capture_output=True, timeout=timeout,
                                check=False, env=environment)
        output = "\n".join(value for value in [result.stdout.decode("utf-8", errors="replace").strip(),
                                                  result.stderr.decode("utf-8", errors="replace").strip()] if value)
        operation = self.operation_state(repository_root)
        if result.returncode != 0 and not operation["in_progress"]:
            raise OSError(output or "Git operation failed")
        return {"completed": result.returncode == 0 and not operation["in_progress"], "operation": operation,
                "output": output}

    @classmethod
    def _git_path(cls, repository_root: Path, name: str) -> Path:
        result = cls._run_git(repository_root, ["rev-parse", "--git-path", name])
        path = Path(result.stdout.decode("utf-8", errors="replace").strip())
        return (path if path.is_absolute() else repository_root / path).resolve()

    @staticmethod
    def _escaped_gitignore_path(path: str) -> str:
        escaped = path.replace("\\", "\\\\")
        for character in [" ", "#", "!", "[", "]", "*", "?"]:
            escaped = escaped.replace(character, f"\\{character}")
        return escaped

    @staticmethod
    def _append_unique(lines: list[str], pattern: str) -> list[str]:
        return lines if pattern in (line.strip() for line in lines) else [*lines, pattern]

    @staticmethod
    def _run_git(repository_root: Path, arguments: list[str], allow_return_codes: set[int] | None = None,
                 timeout: int = 30) -> subprocess.CompletedProcess[bytes]:
        result = subprocess.run(["git", "-C", str(repository_root), *arguments], capture_output=True,
                                timeout=timeout, check=False)
        if result.returncode not in (allow_return_codes or {0}):
            detail = result.stderr.decode("utf-8", errors="replace").strip()
            output = result.stdout.decode("utf-8", errors="replace").strip()
            raise OSError(detail or output or "git command failed")
        return result
