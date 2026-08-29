import json
import subprocess
from pathlib import Path
from typing import TypedDict

from termdeck.platform_paths import PlatformPaths


class GitHubPullRequest(TypedDict):
    number: int
    title: str
    author: str
    base_branch: str
    head_branch: str
    draft: bool
    updated_at: str
    url: str
    review_decision: str


class GitHubPullRequestFile(TypedDict):
    path: str
    additions: int
    deletions: int


class GitHubPullRequestDetail(GitHubPullRequest):
    body: str
    state: str
    mergeable: str
    files: list[GitHubPullRequestFile]


class GitHubPullRequestService:
    MAX_PULL_REQUESTS = 50
    MAX_PATCH_BYTES = 4 * 1024 * 1024

    def list_pull_requests(self, requested_root: Path, state: str = "open", limit: int = 30) -> list[GitHubPullRequest]:
        repository_root = self.repository_root(requested_root)
        normalized_state = state if state in {"open", "closed", "merged", "all"} else "open"
        result = self._run_gh(repository_root, ["pr", "list", "--state", normalized_state, "--limit",
                                                    str(max(1, min(limit, self.MAX_PULL_REQUESTS))), "--json",
                                                    "number,title,author,baseRefName,headRefName,isDraft,updatedAt,url,reviewDecision"])
        raw_pull_requests = json.loads(result.stdout.decode("utf-8", errors="replace"))
        return [self._pull_request_from_json(item) for item in raw_pull_requests]

    def pull_request_detail(self, requested_root: Path, number: int) -> GitHubPullRequestDetail:
        repository_root = self.repository_root(requested_root)
        pull_request_number = self.validated_pull_request_number(number)
        result = self._run_gh(repository_root, ["pr", "view", str(pull_request_number), "--json",
                                                "number,title,body,author,baseRefName,headRefName,isDraft,updatedAt,url,reviewDecision,state,mergeable,files"])
        item = json.loads(result.stdout.decode("utf-8", errors="replace"))
        base = self._pull_request_from_json(item)
        files = [{"path": str(file["path"]), "additions": int(file.get("additions", 0)),
                  "deletions": int(file.get("deletions", 0))} for file in item.get("files", [])]
        return {**base, "body": str(item.get("body") or ""), "state": str(item.get("state") or ""),
                "mergeable": str(item.get("mergeable") or ""), "files": files}

    def pull_request_patch(self, requested_root: Path, number: int) -> str:
        repository_root = self.repository_root(requested_root)
        result = self._run_gh(repository_root, ["pr", "diff", str(self.validated_pull_request_number(number)), "--patch"],
                              timeout=120)
        if len(result.stdout) > self.MAX_PATCH_BYTES:
            raise ValueError(f"pull-request patch exceeds the {self.MAX_PATCH_BYTES // (1024 * 1024)} MB review limit")
        return result.stdout.decode("utf-8", errors="replace")

    def submit_review(self, requested_root: Path, number: int, action: str, body: str) -> None:
        repository_root = self.repository_root(requested_root)
        action_flags = {"approve": "--approve", "request-changes": "--request-changes", "comment": "--comment"}
        if action not in action_flags:
            raise ValueError(f"unsupported pull-request review action: {action}")
        normalized_body = body.strip()
        if action in {"request-changes", "comment"} and not normalized_body:
            raise ValueError("a review message is required")
        arguments = ["pr", "review", str(self.validated_pull_request_number(number)), action_flags[action]]
        if normalized_body:
            arguments.extend(["--body", normalized_body])
        self._run_gh(repository_root, arguments, timeout=120)

    def repository_root(self, requested_root: Path) -> Path:
        requested = requested_root.expanduser().resolve()
        result = self._run_git(requested, ["rev-parse", "--show-toplevel"])
        repository_root = Path(result.stdout.decode("utf-8", errors="replace").strip()).resolve()
        if not repository_root.is_dir():
            raise FileNotFoundError(str(repository_root))
        return repository_root

    @staticmethod
    def validated_pull_request_number(number: int) -> int:
        normalized = int(number)
        if normalized < 1:
            raise ValueError("pull-request number must be positive")
        return normalized

    @staticmethod
    def _pull_request_from_json(item: dict[str, object]) -> GitHubPullRequest:
        author = item.get("author")
        author_name = str(author.get("login") or author.get("name") or "Unknown") if isinstance(author, dict) else "Unknown"
        return {"number": int(item["number"]), "title": str(item["title"]), "author": author_name,
                "base_branch": str(item.get("baseRefName") or ""), "head_branch": str(item.get("headRefName") or ""),
                "draft": bool(item.get("isDraft")), "updated_at": str(item.get("updatedAt") or ""),
                "url": str(item.get("url") or ""), "review_decision": str(item.get("reviewDecision") or "")}

    @staticmethod
    def _run_gh(repository_root: Path, arguments: list[str], timeout: int = 60) -> subprocess.CompletedProcess[bytes]:
        executable = PlatformPaths.resolve_binary(PlatformPaths.ENV_GH_BIN, "gh")
        if not Path(executable).is_file():
            raise FileNotFoundError("GitHub CLI is not installed; install gh and run gh auth login")
        result = subprocess.run([executable, *arguments], cwd=repository_root, capture_output=True, timeout=timeout, check=False)
        if result.returncode != 0:
            detail = result.stderr.decode("utf-8", errors="replace").strip()
            output = result.stdout.decode("utf-8", errors="replace").strip()
            raise OSError(detail or output or "GitHub CLI command failed")
        return result

    @staticmethod
    def _run_git(repository_root: Path, arguments: list[str]) -> subprocess.CompletedProcess[bytes]:
        result = subprocess.run(["git", "-C", str(repository_root), *arguments], capture_output=True,
                                timeout=30, check=False)
        if result.returncode != 0:
            detail = result.stderr.decode("utf-8", errors="replace").strip()
            output = result.stdout.decode("utf-8", errors="replace").strip()
            raise OSError(detail or output or "git command failed")
        return result
