import subprocess
from pathlib import Path
from typing import TypedDict


class GitReference(TypedDict):
    name: str
    full_name: str
    kind: str
    commit_id: str
    current: bool


class GitComparisonFile(TypedDict):
    path: str
    previous_path: str
    status: str


class GitComparison(TypedDict):
    base: str
    target: str
    base_id: str
    target_id: str
    files: list[GitComparisonFile]


class GitDivergenceCommit(TypedDict):
    commit_id: str
    short_id: str
    subject: str
    author: str
    committed_at: int


class GitDivergence(TypedDict):
    upstream: str
    incoming: list[GitDivergenceCommit]
    outgoing: list[GitDivergenceCommit]


class GitComparisonReview(TypedDict):
    path: str
    scope: str
    original: str
    modified: str
    original_label: str
    modified_label: str


class GitHistoryService:
    MAX_REFS = 500
    MAX_COMMITS = 200
    MAX_REVIEW_BYTES = 2 * 1024 * 1024

    def list_references(self, requested_root: Path) -> list[GitReference]:
        repository_root = self.repository_root(requested_root)
        result = self._run_git(repository_root, ["for-each-ref", "--format=%(refname)%00%(refname:short)%00%(objectname)%00%(HEAD)%00%(*objectname)",
                                                    "refs/heads", "refs/remotes", "refs/tags"])
        references: list[GitReference] = []
        for line in result.stdout.decode("utf-8", errors="replace").splitlines()[:self.MAX_REFS]:
            fields = (line.split("\x00", 4) + ["", "", "", ""])[:5]
            if fields[1].endswith("/HEAD"):
                continue
            kind = "tag" if fields[0].startswith("refs/tags/") else "remote" if fields[0].startswith("refs/remotes/") else "branch"
            commit_id = fields[4] or fields[2]
            references.append({"name": fields[1], "full_name": fields[0], "kind": kind, "commit_id": commit_id,
                               "current": fields[3].strip() == "*"})
        return references

    def compare_revisions(self, requested_root: Path, base: str, target: str) -> GitComparison:
        repository_root = self.repository_root(requested_root)
        base_id = self.validated_revision(repository_root, base)
        target_id = self.validated_revision(repository_root, target)
        result = self._run_git(repository_root, ["diff", "--name-status", "-z", "--find-renames", base_id, target_id])
        return {"base": base.strip(), "target": target.strip(), "base_id": base_id, "target_id": target_id,
                "files": self._parse_name_status(result.stdout)}

    def review_comparison_file(self, requested_root: Path, path: str, previous_path: str, base: str,
                               target: str) -> GitComparisonReview:
        repository_root = self.repository_root(requested_root)
        base_id = self.validated_revision(repository_root, base)
        target_id = self.validated_revision(repository_root, target)
        selected_path = self.validated_path(repository_root, path)
        original_path = self.validated_path(repository_root, previous_path or path)
        original = self._revision_content(repository_root, base_id, original_path)
        modified = self._revision_content(repository_root, target_id, selected_path)
        return {"path": selected_path, "scope": "compare", "original": original, "modified": modified,
                "original_label": base.strip(), "modified_label": target.strip()}

    def incoming_outgoing(self, requested_root: Path, remote: str = "", branch: str = "") -> GitDivergence:
        repository_root = self.repository_root(requested_root)
        upstream = f"{self.validated_reference_component(remote)}/{self.validated_reference_component(branch)}" if remote and branch else "@{upstream}"
        upstream_result = self._run_git(repository_root, ["rev-parse", "--verify", f"{upstream}^{{commit}}"], {0, 128})
        if upstream_result.returncode != 0:
            if remote and branch:
                return {"upstream": upstream, "incoming": [], "outgoing": self._log_range(repository_root, "HEAD")}
            detail = upstream_result.stderr.decode("utf-8", errors="replace").strip()
            raise OSError(detail or "the current branch has no upstream")
        upstream_id = upstream_result.stdout.decode("utf-8", errors="replace").strip()
        incoming = self._log_range(repository_root, f"HEAD..{upstream_id}")
        outgoing = self._log_range(repository_root, f"{upstream_id}..HEAD")
        return {"upstream": upstream, "incoming": incoming, "outgoing": outgoing}

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
    def validated_reference_component(value: str) -> str:
        normalized = value.strip()
        if not normalized or len(normalized) > 200 or normalized.startswith("-") or ".." in normalized or any(
                character in normalized for character in "\x00\r\n ~^:?*[\\"):
            raise ValueError(f"invalid Git reference: {value}")
        return normalized

    @staticmethod
    def validated_path(repository_root: Path, path: str) -> str:
        if not path.strip() or any(character in path for character in "\x00\r\n"):
            raise ValueError(f"invalid Git path: {path}")
        target = (repository_root / path).resolve()
        if not target.is_relative_to(repository_root):
            raise ValueError(f"path outside repository: {path}")
        return str(target.relative_to(repository_root))

    @classmethod
    def _revision_content(cls, repository_root: Path, revision: str, path: str) -> str:
        result = cls._run_git(repository_root, ["show", f"{revision}:{path}"], {0, 128})
        if result.returncode != 0:
            return ""
        if len(result.stdout) > cls.MAX_REVIEW_BYTES:
            raise ValueError(f"file exceeds the {cls.MAX_REVIEW_BYTES // (1024 * 1024)} MB Git review limit")
        if b"\x00" in result.stdout:
            raise ValueError("binary files cannot be reviewed in the text diff editor")
        return result.stdout.decode("utf-8", errors="replace")

    @classmethod
    def _log_range(cls, repository_root: Path, revision_range: str) -> list[GitDivergenceCommit]:
        result = cls._run_git(repository_root, ["log", f"--max-count={cls.MAX_COMMITS}",
                                                "--format=%H%x00%h%x00%s%x00%an%x00%ct", revision_range])
        commits: list[GitDivergenceCommit] = []
        for line in result.stdout.decode("utf-8", errors="replace").splitlines():
            fields = line.split("\x00", 4)
            if len(fields) == 5:
                commits.append({"commit_id": fields[0], "short_id": fields[1], "subject": fields[2],
                                "author": fields[3], "committed_at": int(fields[4])})
        return commits

    @staticmethod
    def _parse_name_status(raw_files: bytes) -> list[GitComparisonFile]:
        tokens = [token.decode("utf-8", errors="replace") for token in raw_files.split(b"\x00") if token]
        files: list[GitComparisonFile] = []
        token_index = 0
        while token_index < len(tokens):
            status = tokens[token_index]
            token_index += 1
            if token_index >= len(tokens):
                raise OSError("invalid Git comparison file list")
            previous_path = ""
            path = tokens[token_index]
            token_index += 1
            if status.startswith(("R", "C")):
                if token_index >= len(tokens):
                    raise OSError("invalid Git comparison rename list")
                previous_path, path = path, tokens[token_index]
                token_index += 1
            files.append({"path": path, "previous_path": previous_path, "status": status[:1]})
        return files

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
