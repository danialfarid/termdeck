import re
import subprocess
from pathlib import Path
from typing import TypedDict


class GitRemote(TypedDict):
    name: str
    fetch_url: str
    push_url: str


class GitRemoteService:
    REMOTE_NAME_PATTERN = re.compile(r"[A-Za-z0-9._-]+")
    REMOTE_URL_PATTERN = re.compile(r"(?:ssh|https?|git)://\S+|(?:[^\s/@:]+@)?[^\s/:]+:[^\s]+")

    def list_remotes(self, requested_root: Path) -> list[GitRemote]:
        repository_root = self.repository_root(requested_root)
        result = self._run_git(repository_root, ["remote"])
        remotes: list[GitRemote] = []
        for name in result.stdout.decode("utf-8", errors="replace").splitlines():
            remote_name = self.validated_remote_name(name)
            fetch_url = self._run_git(repository_root, ["remote", "get-url", remote_name]).stdout.decode().strip()
            push_url = self._run_git(repository_root, ["remote", "get-url", "--push", remote_name]).stdout.decode().strip()
            remotes.append({"name": remote_name, "fetch_url": fetch_url, "push_url": push_url})
        return remotes

    def add_remote(self, requested_root: Path, name: str, url: str) -> GitRemote:
        repository_root = self.repository_root(requested_root)
        remote_name = self.validated_remote_name(name)
        remote_url = self.validated_remote_url(url)
        self._run_git(repository_root, ["remote", "add", remote_name, remote_url])
        return next(remote for remote in self.list_remotes(repository_root) if remote["name"] == remote_name)

    def remove_remote(self, requested_root: Path, name: str) -> None:
        repository_root = self.repository_root(requested_root)
        self._run_git(repository_root, ["remote", "remove", self.validated_remote_name(name)])

    def fetch_remote(self, requested_root: Path, name: str) -> None:
        repository_root = self.repository_root(requested_root)
        self._run_git(repository_root, ["fetch", "--prune", self.validated_remote_name(name)], timeout=120)

    def pull_remote(self, requested_root: Path, name: str, branch: str) -> None:
        repository_root = self.repository_root(requested_root)
        self._run_git(repository_root, ["pull", "--ff-only", self.validated_remote_name(name),
                                        self.validated_branch_name(branch)], timeout=120)

    def push_remote(self, requested_root: Path, name: str, branch: str, set_upstream: bool) -> None:
        repository_root = self.repository_root(requested_root)
        arguments = ["push"]
        if set_upstream:
            arguments.append("--set-upstream")
        arguments.extend([self.validated_remote_name(name), self.validated_branch_name(branch)])
        self._run_git(repository_root, arguments, timeout=120)

    def clone_remote_project(self, url: str, path: Path, branch: str = "") -> Path:
        remote_url = self.validated_remote_url(url)
        destination = path.expanduser().resolve()
        if destination.exists():
            raise FileExistsError(str(destination))
        arguments = ["git", "clone"]
        if branch.strip():
            arguments.extend(["--branch", self.validated_branch_name(branch)])
        arguments.extend([remote_url, str(destination)])
        result = subprocess.run(arguments, capture_output=True, timeout=300, check=False)
        if result.returncode != 0:
            detail = result.stderr.decode("utf-8", errors="replace").strip()
            output = result.stdout.decode("utf-8", errors="replace").strip()
            raise OSError(detail or output or "git clone failed")
        return destination

    def repository_root(self, requested_root: Path) -> Path:
        requested = requested_root.expanduser().resolve()
        result = self._run_git(requested, ["rev-parse", "--show-toplevel"])
        repository_root = Path(result.stdout.decode("utf-8", errors="replace").strip()).resolve()
        if not repository_root.is_dir():
            raise FileNotFoundError(str(repository_root))
        return repository_root

    @classmethod
    def validated_remote_name(cls, name: str) -> str:
        normalized = name.strip()
        if not normalized or not cls.REMOTE_NAME_PATTERN.fullmatch(normalized) or normalized.startswith("-"):
            raise ValueError(f"invalid remote name: {name}")
        return normalized

    @classmethod
    def validated_remote_url(cls, url: str) -> str:
        normalized = url.strip()
        unsupported_scheme = "://" in normalized and not normalized.startswith(("ssh://", "git://", "http://", "https://"))
        if (not normalized or unsupported_scheme or not cls.REMOTE_URL_PATTERN.fullmatch(normalized)
                or normalized.startswith("-")):
            raise ValueError("remote URL must be an SSH, Git, HTTP, or HTTPS URL")
        return normalized

    @staticmethod
    def validated_branch_name(name: str) -> str:
        normalized = name.strip()
        if not normalized or normalized.startswith("-") or ".." in normalized or not re.fullmatch(r"[A-Za-z0-9._/-]+", normalized):
            raise ValueError(f"invalid branch name: {name}")
        return normalized

    @staticmethod
    def _run_git(repository_root: Path, arguments: list[str], timeout: int = 15) -> subprocess.CompletedProcess[bytes]:
        result = subprocess.run(["git", "-C", str(repository_root), *arguments], capture_output=True,
                                timeout=timeout, check=False)
        if result.returncode != 0:
            detail = result.stderr.decode("utf-8", errors="replace").strip()
            output = result.stdout.decode("utf-8", errors="replace").strip()
            raise OSError(detail or output or "git command failed")
        return result
