import re
import shutil
import subprocess
import uuid
from dataclasses import dataclass
from pathlib import Path

from termdeck.config import TermdeckConfig


@dataclass(frozen=True)
class WorktreeMetadata:
    path: str
    repository: str
    branch: str
    base_ref: str
    base_commit: str
    managed: bool = True
    worktree_id: str = ""

    def to_record(self) -> dict[str, str | bool]:
        return {"path": self.path, "repository": self.repository, "branch": self.branch,
                "base_ref": self.base_ref, "base_commit": self.base_commit, "managed": self.managed,
                "worktree_id": self.worktree_id}


class GitWorktreeService:
    BRANCH_COMPONENT_PATTERN = re.compile(r"[^A-Za-z0-9._-]+")
    MAX_DIFF_BYTES = 300_000
    MAX_LOCAL_BRANCH_NAMES = 300

    def __init__(self, worktree_directory: Path) -> None:
        self.worktree_directory = worktree_directory.expanduser().resolve()

    def create(self, repository_root: str, title: str, branch: str = "", base_ref: str = "") -> WorktreeMetadata:
        repository = self._repository_root(Path(repository_root).expanduser())
        path_parent = self.worktree_directory / repository.name
        return self._create_at(repository, path_parent, title, branch, base_ref)

    def create_project_worktree(self, repository_root: str, title: str, branch: str = "", base_ref: str = "") -> WorktreeMetadata:
        repository = self._repository_root(Path(repository_root).expanduser())
        path_parent = repository.parent / ".termdeck-worktrees" / repository.name
        return self._create_at(repository, path_parent, title, branch, base_ref)

    def _create_at(self, repository: Path, path_parent: Path, title: str, branch: str, base_ref: str) -> WorktreeMetadata:
        selected_base = base_ref.strip() or self._current_branch(repository) or "HEAD"
        base_commit = self._run_git(repository, "rev-parse", selected_base).strip()
        selected_branch = branch.strip() or self._default_branch(title, base_commit)
        self._validate_branch(selected_branch)
        path_parent.mkdir(parents=True, exist_ok=True)
        path = path_parent / f"{self._slug(title) or 'session'}-{uuid.uuid4().hex[:8]}"
        self._run_git(repository, "worktree", "add", "-b", selected_branch, str(path), selected_base)
        return WorktreeMetadata(str(path), str(repository), selected_branch, selected_base, base_commit)

    def repository_root(self, path: str | Path) -> Path:
        return self._repository_root(Path(path).expanduser())

    def list_worktrees(self, repository_root: str | Path) -> list[WorktreeMetadata]:
        repository = self._repository_root(Path(repository_root).expanduser())
        output = self._run_git(repository, "worktree", "list", "--porcelain")
        blocks = [block for block in output.split("\n\n") if block.strip()]
        result: list[WorktreeMetadata] = []
        for block in blocks:
            fields: dict[str, str] = {}
            for line in block.splitlines():
                key, separator, value = line.partition(" ")
                if separator:
                    fields[key] = value.strip()
            path = fields.get("worktree", "")
            head = fields.get("HEAD", "")
            branch = fields.get("branch", "").removeprefix("refs/heads/")
            if path and head:
                result.append(WorktreeMetadata(path, str(repository), branch, branch or "HEAD", head, False))
        return result

    def list_local_branch_names(self, repository_root: str | Path) -> tuple[str, list[str]]:
        repository = self._repository_root(Path(repository_root).expanduser())
        current_branch = self._current_branch(repository)
        output = self._run_git(repository, "for-each-ref", "--format=%(refname:short)", "refs/heads")
        branches = sorted({line.strip() for line in output.splitlines() if line.strip()}, key=str.casefold)
        return current_branch, branches[:self.MAX_LOCAL_BRANCH_NAMES]

    def delete_project_worktree(self, metadata: WorktreeMetadata, move_to_trash: bool) -> str | None:
        repository = self._repository_root(Path(metadata.repository))
        source = Path(metadata.path).expanduser().resolve()
        if source == repository:
            raise ValueError("the project root worktree cannot be deleted")
        if not source.is_dir():
            self._run_git(repository, "worktree", "prune")
            self._delete_branch(repository, metadata.branch)
            return None
        moved_to: str | None = None
        if move_to_trash:
            trash = TermdeckConfig.TRASH_DIR
            trash.mkdir(parents=True, exist_ok=True)
            target = trash / source.name
            if target.exists():
                target = trash / f"{source.name}-{uuid.uuid4().hex[:8]}"
            shutil.move(str(source), str(target))
            moved_to = str(target)
        else:
            control_file = source / ".git"
            if not control_file.is_file():
                raise ValueError(f"worktree control file is missing: {control_file}")
            control_file.unlink()
        self._run_git(repository, "worktree", "prune")
        self._delete_branch(repository, metadata.branch)
        return moved_to

    def review(self, metadata: WorktreeMetadata) -> dict[str, object]:
        worktree = self._validated_path(metadata.path)
        status_lines = self._status_lines(worktree)
        commits = self._run_git(worktree, "log", "--format=%h%x09%ad%x09%s", "--date=short",
                                f"{metadata.base_commit}..HEAD", "-n", "100").splitlines()
        diff = self._run_git(worktree, "diff", "--no-ext-diff", "--unified=40", metadata.base_commit, "--")
        return {"path": metadata.path, "repository": metadata.repository, "branch": metadata.branch,
                "base_ref": metadata.base_ref, "base_commit": metadata.base_commit,
                "current_commit": self._run_git(worktree, "rev-parse", "HEAD").strip(),
                "clean": not status_lines, "files": status_lines, "commits": commits,
                "diff": diff[:self.MAX_DIFF_BYTES], "diff_truncated": len(diff) > self.MAX_DIFF_BYTES,
                "managed": metadata.managed}

    def finish(self, metadata: WorktreeMetadata, action: str, target_branch: str = "") -> dict[str, object]:
        selected_action = action.strip().lower()
        if selected_action not in {"keep", "merge", "discard"}:
            raise ValueError(f"unknown worktree action: {action}")
        if selected_action == "keep":
            return {"action": "keep", "managed": False, "path": metadata.path, "branch": metadata.branch}
        review = self.review(metadata)
        if selected_action == "discard":
            self._remove_worktree(metadata, True)
            return {"action": "discard", "path": metadata.path, "branch": metadata.branch}
        if not bool(review["clean"]):
            raise ValueError("commit or discard worktree changes before merging")
        target = target_branch.strip() or metadata.base_ref
        if not target or target == "HEAD":
            raise ValueError("target_branch is required when the worktree was created from a detached HEAD")
        repository = self._repository_root(Path(metadata.repository))
        current_branch = self._current_branch(repository)
        if current_branch != target:
            raise ValueError(f"base repository is on {current_branch or 'detached HEAD'}, not {target}")
        if self._status_lines(repository):
            raise ValueError("base repository has uncommitted changes")
        self._run_git(repository, "merge", "--no-ff", metadata.branch, "-m", f"Merge {metadata.branch}")
        self._remove_worktree(metadata, False)
        return {"action": "merge", "path": metadata.path, "branch": metadata.branch, "target_branch": target}

    def _remove_worktree(self, metadata: WorktreeMetadata, force: bool) -> None:
        repository = self._repository_root(Path(metadata.repository))
        args = ["worktree", "remove"]
        if force:
            args.append("--force")
        args.append(metadata.path)
        self._run_git(repository, *args)
        self._run_git(repository, "branch", "-D" if force else "-d", metadata.branch)

    def _delete_branch(self, repository: Path, branch: str) -> None:
        if branch.strip():
            self._run_git(repository, "branch", "-D", branch)

    @staticmethod
    def _repository_root(path: Path) -> Path:
        if not path.is_dir():
            raise ValueError(f"repository is not a directory: {path}")
        result = GitWorktreeService._run_git(path, "rev-parse", "--show-toplevel").strip()
        return Path(result).resolve()

    def _validated_path(self, path: str) -> Path:
        candidate = Path(path).expanduser().resolve()
        if not candidate.is_dir():
            raise ValueError(f"worktree is not available: {candidate}")
        return candidate

    def _status_lines(self, path: Path) -> list[str]:
        lines = self._run_git(path, "status", "--porcelain=v1", "--untracked-files=all").splitlines()
        return [line for line in lines if line.strip()]

    @staticmethod
    def _current_branch(path: Path) -> str:
        return GitWorktreeService._run_git(path, "branch", "--show-current").strip()

    @classmethod
    def _default_branch(cls, title: str, base_commit: str) -> str:
        return f"termdeck/{cls._slug(title) or 'session'}-{base_commit[:8]}-{uuid.uuid4().hex[:6]}"

    @classmethod
    def _slug(cls, value: str) -> str:
        return cls.BRANCH_COMPONENT_PATTERN.sub("-", value.strip().lower()).strip("-._")[:48]

    @staticmethod
    def _validate_branch(branch: str) -> None:
        result = subprocess.run(["git", "check-ref-format", "--branch", branch], capture_output=True, text=True,
                                timeout=30, check=False)
        if result.returncode != 0:
            detail = result.stderr.strip() or result.stdout.strip() or "invalid branch name"
            raise ValueError(detail)

    @staticmethod
    def _run_git(path: Path, *arguments: str) -> str:
        result = subprocess.run(["git", "-C", str(path), *arguments], capture_output=True, text=True,
                                timeout=30, check=False, errors="replace")
        if result.returncode != 0:
            detail = result.stderr.strip() or result.stdout.strip() or "git command failed"
            raise OSError(detail)
        return result.stdout
