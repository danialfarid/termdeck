import re
import subprocess
from collections.abc import Callable
from pathlib import Path
from typing import NotRequired, TypedDict

from filedeck.git_remote_service import GitRemote, GitRemoteService
from filedeck.git_service import FileDeckGitService


class GitWorkflowFile(TypedDict):
    path: str
    status: str
    index_status: str
    worktree_status: str
    staged: bool
    unstaged: bool
    untracked: bool
    conflicted: bool


class GitWorkflowBranch(TypedDict):
    name: str
    current: bool
    remote: bool


class GitWorkflowStash(TypedDict):
    reference: str
    index: int
    message: str
    created_at: str


class GitWorkflowWorktree(TypedDict):
    path: str
    head: str
    branch: str
    bare: bool
    detached: bool
    locked: bool
    prunable: bool


class GitWorkflowAgentSession(TypedDict):
    session_id: str
    title: str
    agent_kind: str
    processing: bool


class GitWorkflowAgent(TypedDict):
    worktree: str
    branch: str
    changed_files: int
    files: list[GitWorkflowFile]
    processing: bool
    sessions: list[GitWorkflowAgentSession]


class GitWorkflowState(TypedDict):
    repository_root: str
    branch: str
    upstream: str
    ahead: int
    behind: int
    files: list[GitWorkflowFile]
    branches: list[GitWorkflowBranch]
    stashes: list[GitWorkflowStash]
    worktrees: list[GitWorkflowWorktree]
    graph: list[str]
    agents: list[GitWorkflowAgent]
    remotes: list[GitRemote]


class GitReviewFile(TypedDict):
    path: str
    scope: str
    original: str
    modified: str
    original_label: str
    modified_label: str
    base: NotRequired[str]
    ours: NotRequired[str]
    theirs: NotRequired[str]


class GitCommitFile(TypedDict):
    path: str
    previous_path: str
    status: str


class GitCommitDetail(TypedDict):
    commit_id: str
    short_id: str
    parent_id: str
    author: str
    email: str
    committed_at: str
    message: str
    files: list[GitCommitFile]


class GitWorkflowService:
    BRANCH_NAME_PATTERN = re.compile(r"[A-Za-z0-9._/-]+")
    STASH_REFERENCE_PATTERN = re.compile(r"stash@\{(\d+)}")
    COMMIT_ID_PATTERN = re.compile(r"[0-9a-fA-F]{4,64}")
    CONFLICT_CODES = frozenset({"DD", "AU", "UD", "UA", "DU", "AA", "UU"})
    MAX_PATHS = 500
    MAX_GRAPH_COMMITS = 200
    MAX_GRAPH_QUERY_LENGTH = 200
    MAX_REVIEW_BYTES = 2 * 1024 * 1024
    LOG_DATE_PATTERN = re.compile(r"\d{4}-\d{2}-\d{2}")

    def __init__(self, git_reader: FileDeckGitService, git_remote: GitRemoteService) -> None:
        self._git_reader = git_reader
        self._git_remote = git_remote

    def get_state(self, requested_root: Path, sessions: list[dict[str, object]], limit: int = 100) -> GitWorkflowState:
        repository_root = self.repository_root(requested_root)
        branch_state = self._git_reader.get_branch_state(repository_root, limit)
        branch = str(branch_state["branch"])
        upstream = str(branch_state["upstream"])
        files = self._status_files(repository_root)
        ahead, behind = self._ahead_behind(repository_root, upstream)
        return {"repository_root": str(repository_root), "branch": branch, "upstream": upstream, "ahead": ahead,
                "behind": behind, "files": files, "branches": self.list_branches(repository_root),
                "stashes": self.list_stashes(repository_root), "worktrees": self.list_worktrees(repository_root),
                "graph": self.commit_graph(repository_root, limit), "agents": self.agent_worktrees(repository_root, sessions),
                "remotes": self._git_remote.list_remotes(repository_root)}

    def repository_root(self, requested_root: Path) -> Path:
        requested = requested_root.expanduser().resolve()
        result = self._run_git(requested, ["rev-parse", "--show-toplevel"])
        repository_root = Path(result.stdout.decode("utf-8", errors="replace").strip()).resolve()
        if not repository_root.is_dir():
            raise FileNotFoundError(str(repository_root))
        return repository_root

    def stage(self, requested_root: Path, paths: list[str]) -> None:
        repository_root = self.repository_root(requested_root)
        selected_paths = self._validated_paths(repository_root, paths)
        self._run_git(repository_root, ["add", "--", *selected_paths])

    def unstage(self, requested_root: Path, paths: list[str]) -> None:
        repository_root = self.repository_root(requested_root)
        selected_paths = self._validated_paths(repository_root, paths)
        self._run_git(repository_root, ["restore", "--staged", "--", *selected_paths])

    def commit(self, requested_root: Path, message: str) -> str:
        repository_root = self.repository_root(requested_root)
        normalized_message = message.strip()
        if not normalized_message:
            raise ValueError("commit message is required")
        result = self._run_git(repository_root, ["commit", "-m", normalized_message])
        commit_id = self._run_git(repository_root, ["rev-parse", "HEAD"]).stdout.decode().strip()
        if not commit_id:
            raise OSError(result.stdout.decode("utf-8", errors="replace").strip() or "git commit created no commit")
        return commit_id

    def create_branch(self, requested_root: Path, name: str, start_point: str = "HEAD", switch: bool = True) -> str:
        repository_root = self.repository_root(requested_root)
        branch_name = self._validated_branch_name(name)
        normalized_start = start_point.strip() or "HEAD"
        arguments = ["switch", "-c", branch_name, normalized_start] if switch else ["branch", branch_name, normalized_start]
        self._run_git(repository_root, arguments)
        return branch_name

    def switch_branch(self, requested_root: Path, name: str) -> str:
        repository_root = self.repository_root(requested_root)
        branch_name = self._validated_branch_name(name)
        self._run_git(repository_root, ["switch", branch_name])
        return branch_name

    def create_stash(self, requested_root: Path, message: str, include_untracked: bool) -> str:
        repository_root = self.repository_root(requested_root)
        arguments = ["stash", "push"]
        if include_untracked:
            arguments.append("--include-untracked")
        if message.strip():
            arguments.extend(["-m", message.strip()])
        result = self._run_git(repository_root, arguments)
        return result.stdout.decode("utf-8", errors="replace").strip()

    def apply_stash(self, requested_root: Path, reference: str, pop: bool) -> None:
        repository_root = self.repository_root(requested_root)
        stash_reference = self._validated_stash_reference(reference)
        self._run_git(repository_root, ["stash", "pop" if pop else "apply", stash_reference])

    def drop_stash(self, requested_root: Path, reference: str) -> None:
        repository_root = self.repository_root(requested_root)
        self._run_git(repository_root, ["stash", "drop", self._validated_stash_reference(reference)])

    def resolve_conflict(self, requested_root: Path, path: str, resolution: str) -> None:
        repository_root = self.repository_root(requested_root)
        selected_path = self._validated_paths(repository_root, [path])[0]
        if resolution in {"ours", "theirs"}:
            self._run_git(repository_root, ["restore", f"--{resolution}", "--", selected_path])
        elif resolution != "resolved":
            raise ValueError(f"unknown conflict resolution: {resolution}")
        self._run_git(repository_root, ["add", "--", selected_path])

    def create_worktree(self, requested_root: Path, path: Path, branch: str, create_branch: bool,
                        start_point: str = "HEAD") -> GitWorkflowWorktree:
        repository_root = self.repository_root(requested_root)
        worktree_path = path.expanduser().resolve()
        if worktree_path.exists():
            raise FileExistsError(str(worktree_path))
        branch_name = self._validated_branch_name(branch)
        arguments = ["worktree", "add"]
        if create_branch:
            arguments.extend(["-b", branch_name, str(worktree_path), start_point.strip() or "HEAD"])
        else:
            arguments.extend([str(worktree_path), branch_name])
        self._run_git(repository_root, arguments, timeout=60)
        return next(item for item in self.list_worktrees(repository_root) if Path(item["path"]).resolve() == worktree_path)

    def remove_worktree(self, requested_root: Path, path: Path) -> None:
        repository_root = self.repository_root(requested_root)
        worktree_path = path.expanduser().resolve()
        if worktree_path == repository_root:
            raise ValueError("cannot remove the primary repository worktree")
        self._run_git(repository_root, ["worktree", "remove", str(worktree_path)], timeout=60)

    def prune_worktrees(self, requested_root: Path) -> None:
        self._run_git(self.repository_root(requested_root), ["worktree", "prune"])

    def list_branches(self, repository_root: Path) -> list[GitWorkflowBranch]:
        result = self._run_git(repository_root, ["for-each-ref", "--format=%(refname)%00%(refname:short)%00%(HEAD)",
                                                 "refs/heads", "refs/remotes"])
        branches: list[GitWorkflowBranch] = []
        for line in result.stdout.decode("utf-8", errors="replace").splitlines():
            reference, name, marker = (line.split("\x00", 2) + ["", ""])[:3]
            if name.endswith("/HEAD"):
                continue
            branches.append({"name": name, "current": marker.strip() == "*", "remote": reference.startswith("refs/remotes/")})
        return branches

    def list_stashes(self, repository_root: Path) -> list[GitWorkflowStash]:
        result = self._run_git(repository_root, ["stash", "list", "--format=%gd%x00%gs%x00%ci"])
        stashes: list[GitWorkflowStash] = []
        for line in result.stdout.decode("utf-8", errors="replace").splitlines():
            fields = line.split("\x00", 2)
            match = self.STASH_REFERENCE_PATTERN.fullmatch(fields[0]) if len(fields) == 3 else None
            if match:
                stashes.append({"reference": fields[0], "index": int(match.group(1)), "message": fields[1],
                                "created_at": fields[2]})
        return stashes

    def list_worktrees(self, repository_root: Path) -> list[GitWorkflowWorktree]:
        result = self._run_git(repository_root, ["worktree", "list", "--porcelain"])
        worktrees: list[GitWorkflowWorktree] = []
        current: GitWorkflowWorktree | None = None
        for line in [*result.stdout.decode("utf-8", errors="replace").splitlines(), ""]:
            if line.startswith("worktree "):
                if current is not None:
                    worktrees.append(current)
                current = {"path": line[9:], "head": "", "branch": "", "bare": False, "detached": False,
                           "locked": False, "prunable": False}
            elif current is not None and line.startswith("HEAD "):
                current["head"] = line[5:]
            elif current is not None and line.startswith("branch "):
                current["branch"] = line[7:].removeprefix("refs/heads/")
            elif current is not None and line in {"bare", "detached", "locked", "prunable"}:
                current[line] = True
            elif not line and current is not None:
                worktrees.append(current)
                current = None
        return worktrees

    def commit_graph(self, repository_root: Path, limit: int, paths: list[str] | None = None, query: str = "",
                     author: str = "", since: str = "", until: str = "", revision: str = "") -> list[str]:
        graph_limit = max(1, min(limit, self.MAX_GRAPH_COMMITS))
        normalized_query = query.strip()
        normalized_author = author.strip()
        if max(len(normalized_query), len(normalized_author)) > self.MAX_GRAPH_QUERY_LENGTH:
            raise ValueError(f"Git history filters must be at most {self.MAX_GRAPH_QUERY_LENGTH} characters")
        if any(character in normalized_query + normalized_author for character in "\x00\r\n"):
            raise ValueError("Git history filters cannot contain line breaks")
        normalized_since = self._validated_log_date(since)
        normalized_until = self._validated_log_date(until)
        selected_revision = self._validated_log_revision(repository_root, revision) if revision.strip() else ""
        arguments = ["log", "--graph", "--decorate", "--date-order", f"--max-count={graph_limit}",
                     "--pretty=format:%h%x00%s%x00%ct%x00%d"]
        if normalized_query or normalized_author:
            arguments.extend(["--regexp-ignore-case", "--fixed-strings"])
        if normalized_query:
            arguments.append(f"--grep={normalized_query}")
        if normalized_author:
            arguments.append(f"--author={normalized_author}")
        if normalized_since:
            arguments.append(f"--since={normalized_since}")
        if normalized_until:
            arguments.append(f"--until={normalized_until} 23:59:59")
        arguments.append(selected_revision or "--all")
        if paths:
            arguments.extend(["--", *self._validated_paths(repository_root, paths)])
        result = self._run_git(repository_root, arguments)
        return result.stdout.decode("utf-8", errors="replace").splitlines()

    def review_file(self, requested_root: Path, path: str, scope: str) -> GitReviewFile:
        repository_root = self.repository_root(requested_root)
        selected_path = self._validated_paths(repository_root, [path])[0]
        if scope == "staged":
            original = self._revision_content(repository_root, f"HEAD:{selected_path}")
            modified = self._revision_content(repository_root, f":{selected_path}")
            labels = ("HEAD", "staged")
        elif scope == "working":
            original = self._revision_content(repository_root, f":{selected_path}")
            modified = self._working_tree_content(repository_root, selected_path)
            labels = ("index", "working tree")
        elif scope == "untracked":
            original = ""
            modified = self._working_tree_content(repository_root, selected_path)
            labels = ("new file", "working tree")
        elif scope == "conflict":
            base = self._revision_content(repository_root, f":1:{selected_path}")
            ours = self._revision_content(repository_root, f":2:{selected_path}")
            theirs = self._revision_content(repository_root, f":3:{selected_path}")
            original = theirs
            modified = self._working_tree_content(repository_root, selected_path)
            labels = ("theirs", "merge result")
        else:
            raise ValueError(f"unknown Git review scope: {scope}")
        review: GitReviewFile = {"path": selected_path, "scope": scope, "original": original, "modified": modified,
                                 "original_label": labels[0], "modified_label": labels[1]}
        if scope == "conflict":
            review.update({"base": base, "ours": ours, "theirs": theirs})
        return review

    def commit_detail(self, requested_root: Path, commit_id: str) -> GitCommitDetail:
        repository_root = self.repository_root(requested_root)
        revision = self._validated_commit_id(repository_root, commit_id)
        metadata_result = self._run_git(repository_root,
                                        ["show", "-s", "--format=%H%x00%h%x00%P%x00%an%x00%ae%x00%aI%x00%B", revision])
        fields = metadata_result.stdout.decode("utf-8", errors="replace").split("\x00", 6)
        if len(fields) != 7:
            raise OSError(f"invalid Git commit metadata: {revision}")
        parent_id = fields[2].split()[0] if fields[2].split() else ""
        files_result = self._run_git(repository_root,
                                     ["diff-tree", "--root", "--no-commit-id", "--name-status", "-r", "-z",
                                      "--find-renames", revision])
        files = self._parse_commit_files(files_result.stdout)
        return {"commit_id": fields[0], "short_id": fields[1], "parent_id": parent_id, "author": fields[3],
                "email": fields[4], "committed_at": fields[5], "message": fields[6].strip(), "files": files}

    def review_commit_file(self, requested_root: Path, path: str, commit_id: str, previous_path: str = "") -> GitReviewFile:
        repository_root = self.repository_root(requested_root)
        revision = self._validated_commit_id(repository_root, commit_id)
        selected_path = self._validated_paths(repository_root, [path])[0]
        original_path = self._validated_paths(repository_root, [previous_path or path])[0]
        parent_result = self._run_git(repository_root, ["rev-list", "--parents", "-n", "1", revision])
        parent_fields = parent_result.stdout.decode("utf-8", errors="replace").strip().split()
        parent_id = parent_fields[1] if len(parent_fields) > 1 else ""
        original = self._revision_content(repository_root, f"{parent_id}:{original_path}") if parent_id else ""
        modified = self._revision_content(repository_root, f"{revision}:{selected_path}")
        original_label = parent_id[:7] if parent_id else "empty tree"
        return {"path": selected_path, "scope": "commit", "original": original, "modified": modified,
                "original_label": original_label, "modified_label": revision[:7]}

    def revert_paths_to_head(self, requested_root: Path, paths: list[str], move_to_trash: Callable[[str, str], str]) -> list[str]:
        repository_root = self.repository_root(requested_root)
        selected_paths = self._validated_paths(repository_root, paths)
        trashed_paths: list[str] = []
        for selected_path in selected_paths:
            current_path = repository_root / selected_path
            if current_path.exists():
                trashed_paths.append(str(move_to_trash(str(repository_root), selected_path)))
            if self._revision_exists(repository_root, f"HEAD:{selected_path}"):
                self._run_git(repository_root, ["restore", "--source=HEAD", "--staged", "--worktree", "--", selected_path])
            else:
                self._run_git(repository_root, ["rm", "--cached", "--ignore-unmatch", "--", selected_path])
        return trashed_paths

    @classmethod
    def _revision_content(cls, repository_root: Path, revision: str) -> str:
        result = cls._run_git(repository_root, ["show", revision], {0, 128})
        return cls._decoded_review_content(result.stdout) if result.returncode == 0 else ""

    @classmethod
    def _working_tree_content(cls, repository_root: Path, selected_path: str) -> str:
        target = repository_root / selected_path
        if not target.exists():
            return ""
        content = target.read_bytes()
        return cls._decoded_review_content(content)

    @classmethod
    def _decoded_review_content(cls, content: bytes) -> str:
        if len(content) > cls.MAX_REVIEW_BYTES:
            raise ValueError(f"file exceeds the {cls.MAX_REVIEW_BYTES // (1024 * 1024)} MB Git review limit")
        if b"\x00" in content:
            raise ValueError("binary files cannot be reviewed in the text diff editor")
        return content.decode("utf-8", errors="replace")

    @classmethod
    def _revision_exists(cls, repository_root: Path, revision: str) -> bool:
        return cls._run_git(repository_root, ["cat-file", "-e", revision], {0, 128}).returncode == 0

    @classmethod
    def _parse_commit_files(cls, raw_files: bytes) -> list[GitCommitFile]:
        tokens = [token.decode("utf-8", errors="replace") for token in raw_files.split(b"\x00") if token]
        files: list[GitCommitFile] = []
        token_index = 0
        while token_index < len(tokens):
            status = tokens[token_index]
            token_index += 1
            if token_index >= len(tokens):
                raise OSError("invalid Git commit file list")
            previous_path = ""
            path = tokens[token_index]
            token_index += 1
            if status.startswith(("R", "C")):
                if token_index >= len(tokens):
                    raise OSError("invalid Git rename file list")
                previous_path, path = path, tokens[token_index]
                token_index += 1
            files.append({"path": path, "previous_path": previous_path, "status": status[:1]})
        return files

    @classmethod
    def _validated_commit_id(cls, repository_root: Path, commit_id: str) -> str:
        normalized = commit_id.strip()
        if not cls.COMMIT_ID_PATTERN.fullmatch(normalized):
            raise ValueError(f"invalid commit id: {commit_id}")
        result = cls._run_git(repository_root, ["rev-parse", "--verify", f"{normalized}^{{commit}}"])
        return result.stdout.decode("utf-8", errors="replace").strip()

    def agent_worktrees(self, repository_root: Path, sessions: list[dict[str, object]]) -> list[GitWorkflowAgent]:
        worktrees = self.list_worktrees(repository_root)
        sessions_by_worktree: dict[str, list[GitWorkflowAgentSession]] = {}
        for session in sessions:
            if str(session["agent_kind"]) == "none":
                continue
            cwd_text = str(session["cwd"])
            if not cwd_text or cwd_text.startswith("ssh://"):
                continue
            cwd = Path(cwd_text).expanduser().resolve()
            worktree = next((item for item in worktrees if cwd == Path(item["path"]) or cwd.is_relative_to(Path(item["path"]))), None)
            if worktree is None:
                continue
            worktree_path = worktree["path"]
            sessions_by_worktree.setdefault(worktree_path, []).append({"session_id": str(session["session_id"]),
                                                                       "title": str(session["title"]),
                                                                       "agent_kind": str(session["agent_kind"]),
                                                                       "processing": bool(session["processing"])})
        agents: list[GitWorkflowAgent] = []
        for worktree_path, worktree_sessions in sessions_by_worktree.items():
            branch_state = self._git_reader.get_branch_state(Path(worktree_path), 1)
            files = self._status_files(Path(worktree_path))
            agents.append({"worktree": worktree_path, "branch": str(branch_state["branch"]),
                           "changed_files": len(files), "files": files,
                           "processing": any(session["processing"] for session in worktree_sessions),
                           "sessions": worktree_sessions})
        return agents

    @classmethod
    def _status_files(cls, repository_root: Path) -> list[GitWorkflowFile]:
        result = cls._run_git(repository_root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
        records = result.stdout.split(b"\x00")
        files: list[GitWorkflowFile] = []
        record_index = 0
        while record_index < len(records):
            record = records[record_index]
            record_index += 1
            if not record:
                continue
            decoded = record.decode("utf-8", errors="replace")
            if len(decoded) < 4:
                raise OSError("invalid Git status record")
            index_status, worktree_status, path = decoded[0], decoded[1], decoded[3:]
            if index_status in {"R", "C"} or worktree_status in {"R", "C"}:
                record_index += 1
            status = "?" if index_status == "?" and worktree_status == "?" else next(
                (value for value in (index_status, worktree_status) if value != " "), "M")
            files.append(cls._workflow_file({"path": path, "status": status, "index_status": index_status,
                                             "worktree_status": worktree_status}))
        return files

    @classmethod
    def _workflow_file(cls, item: object) -> GitWorkflowFile:
        source = dict(item)
        index_status = str(source["index_status"])
        worktree_status = str(source["worktree_status"])
        code = f"{index_status}{worktree_status}"
        return {"path": str(source["path"]), "status": str(source["status"]), "index_status": index_status,
                "worktree_status": worktree_status, "staged": index_status not in {" ", "?"},
                "unstaged": worktree_status != " " and code != "??", "untracked": code == "??",
                "conflicted": code in cls.CONFLICT_CODES}

    @staticmethod
    def _ahead_behind(repository_root: Path, upstream: str) -> tuple[int, int]:
        if not upstream:
            return 0, 0
        result = GitWorkflowService._run_git(repository_root, ["rev-list", "--left-right", "--count", f"HEAD...{upstream}"])
        fields = result.stdout.decode("utf-8", errors="replace").strip().split()
        return (int(fields[0]), int(fields[1])) if len(fields) == 2 else (0, 0)

    @classmethod
    def _validated_branch_name(cls, name: str) -> str:
        normalized = name.strip()
        if not normalized or not cls.BRANCH_NAME_PATTERN.fullmatch(normalized) or normalized.startswith("-") or ".." in normalized:
            raise ValueError(f"invalid branch name: {name}")
        return normalized

    @classmethod
    def _validated_stash_reference(cls, reference: str) -> str:
        normalized = reference.strip()
        if not cls.STASH_REFERENCE_PATTERN.fullmatch(normalized):
            raise ValueError(f"invalid stash reference: {reference}")
        return normalized

    @classmethod
    def _validated_log_date(cls, value: str) -> str:
        normalized = value.strip()
        if normalized and not cls.LOG_DATE_PATTERN.fullmatch(normalized):
            raise ValueError(f"invalid Git history date: {value}")
        return normalized

    @classmethod
    def _validated_log_revision(cls, repository_root: Path, revision: str) -> str:
        normalized = revision.strip()
        if not normalized or len(normalized) > 200 or normalized.startswith("-") or any(
                character in normalized for character in "\x00\r\n"):
            raise ValueError(f"invalid Git revision: {revision}")
        result = cls._run_git(repository_root, ["rev-parse", "--verify", f"{normalized}^{{commit}}"])
        return result.stdout.decode("utf-8", errors="replace").strip()

    @classmethod
    def _validated_paths(cls, repository_root: Path, paths: list[str]) -> list[str]:
        if not paths or len(paths) > cls.MAX_PATHS:
            raise ValueError(f"select between 1 and {cls.MAX_PATHS} paths")
        selected: list[str] = []
        for path in paths:
            if not path.strip() or any(character in path for character in "\x00\r\n"):
                raise ValueError(f"invalid Git path: {path}")
            target = (repository_root / path).resolve()
            if not target.is_relative_to(repository_root):
                raise ValueError(f"path outside repository: {path}")
            selected.append(str(target.relative_to(repository_root)))
        return selected

    @staticmethod
    def _run_git(repository_root: Path, arguments: list[str], allow_return_codes: set[int] | None = None,
                 timeout: int = 15) -> subprocess.CompletedProcess[bytes]:
        result = subprocess.run(["git", "-C", str(repository_root), *arguments], capture_output=True,
                                timeout=timeout, check=False)
        if result.returncode not in (allow_return_codes or {0}):
            detail = result.stderr.decode("utf-8", errors="replace").strip()
            output = result.stdout.decode("utf-8", errors="replace").strip()
            raise OSError(detail or output or "git command failed")
        return result
