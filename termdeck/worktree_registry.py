import json
import uuid
from dataclasses import dataclass
from pathlib import Path

from termdeck.state_backup import StateBackupManager
from termdeck.util import TimeUtil
from termdeck.worktree_service import GitWorktreeService, WorktreeMetadata


@dataclass(frozen=True)
class ProjectWorktree:
    worktree_id: str
    project: str
    name: str
    path: str
    repository: str
    branch: str
    base_ref: str
    base_commit: str
    is_root: bool
    managed: bool
    available: bool
    created_at_est: str
    git_repository: bool = True

    def to_dict(self) -> dict[str, str | bool]:
        return {"id": self.worktree_id, "project": self.project, "name": self.name, "path": self.path,
                "repository": self.repository, "branch": self.branch, "base_ref": self.base_ref,
                "base_commit": self.base_commit, "is_root": self.is_root, "managed": self.managed,
                "available": self.available, "created_at_est": self.created_at_est,
                "git_repository": self.git_repository}

    def metadata(self) -> WorktreeMetadata:
        return WorktreeMetadata(self.path, self.repository, self.branch, self.base_ref, self.base_commit,
                                self.managed, self.worktree_id)


class WorktreeRegistry:
    TMP_SUFFIX = ".tmp"

    def __init__(self, registry_file: Path, backup_manager: StateBackupManager | None,
                 git_service: GitWorktreeService) -> None:
        self.registry_file = registry_file
        self.backup_manager = backup_manager
        self.git_service = git_service
        self.records = self._load()

    def _load(self) -> dict[str, ProjectWorktree]:
        if not self.registry_file.exists():
            return {}
        payload = json.loads(self.registry_file.read_text())
        return {str(item["id"]): ProjectWorktree(
            str(item["id"]), str(item["project"]), str(item.get("name") or Path(str(item["path"])).name),
            str(item["path"]), str(item["repository"]), str(item.get("branch") or ""),
            str(item.get("base_ref") or "HEAD"), str(item.get("base_commit") or ""), bool(item.get("is_root", False)),
            bool(item.get("managed", False)), bool(item.get("available", True)), str(item.get("created_at_est") or ""),
            bool(item.get("git_repository", True)))
                for item in payload}

    def _save(self) -> None:
        self.registry_file.parent.mkdir(parents=True, exist_ok=True)
        if self.backup_manager is not None:
            self.backup_manager.before_state_write(self.registry_file)
        temporary = self.registry_file.with_suffix(self.TMP_SUFFIX)
        temporary.write_text(json.dumps([record.to_dict() for record in self.records.values()], indent=2, sort_keys=True))
        temporary.replace(self.registry_file)

    def list_for_project(self, project: str, repository_root: str) -> list[ProjectWorktree]:
        try:
            repository = self.git_service.repository_root(repository_root)
            discovered = self.git_service.list_worktrees(repository)
        except (ValueError, OSError):
            path = str(Path(repository_root).expanduser().resolve())
            return [ProjectWorktree("root", project, Path(path).name, path, path, "", "", "", True, False,
                                    Path(path).is_dir(), "", False)]
        existing_by_path = {record.path: record for record in self.records.values()
                            if record.project == project and record.repository == str(repository)}
        result: list[ProjectWorktree] = []
        seen_paths: set[str] = set()
        changed = False
        for metadata in discovered:
            path = str(Path(metadata.path).expanduser().resolve())
            seen_paths.add(path)
            is_root = path == str(repository)
            previous = existing_by_path.get(path)
            worktree_id = "root" if is_root else previous.worktree_id if previous else f"wt-{uuid.uuid4().hex[:12]}"
            name = (previous.name if previous and previous.name else metadata.branch) or (repository.name if is_root else Path(path).name)
            record = ProjectWorktree(worktree_id, project, name, path, str(repository), metadata.branch,
                                     previous.base_ref if previous else metadata.base_ref,
                                     previous.base_commit if previous else metadata.base_commit, is_root,
                                     previous.managed if previous else False, Path(path).is_dir(),
                                     previous.created_at_est if previous else TimeUtil.now_est_naive_iso(), True)
            result.append(record)
            if self.records.get(worktree_id) != record:
                self.records[worktree_id] = record
                changed = True
        for previous in existing_by_path.values():
            if previous.path not in seen_paths and not previous.is_root:
                result.append(ProjectWorktree(previous.worktree_id, previous.project, previous.name, previous.path,
                                              previous.repository, previous.branch, previous.base_ref, previous.base_commit,
                                              False, previous.managed, False, previous.created_at_est, previous.git_repository))
        if changed:
            self._save()
        return sorted(result, key=lambda item: (not item.is_root, item.name.casefold(), item.path.casefold()))

    def create(self, project: str, repository_root: str, name: str, branch: str, base_ref: str,
               location: str = "") -> ProjectWorktree:
        metadata = self.git_service.create_project_worktree(repository_root, name, branch, base_ref, location)
        worktree_id = f"wt-{uuid.uuid4().hex[:12]}"
        record = ProjectWorktree(worktree_id, project, metadata.branch, metadata.path,
                                 metadata.repository, metadata.branch, metadata.base_ref, metadata.base_commit,
                                 False, True, True, TimeUtil.now_est_naive_iso(), True)
        self.records[worktree_id] = record
        self._save()
        return record

    def register_legacy(self, project: str, metadata: WorktreeMetadata, name: str = "") -> ProjectWorktree:
        worktree_id = metadata.worktree_id or f"wt-{uuid.uuid4().hex[:12]}"
        record = ProjectWorktree(worktree_id, project, name.strip() or metadata.branch, metadata.path,
                                 metadata.repository, metadata.branch, metadata.base_ref, metadata.base_commit,
                                 False, metadata.managed, Path(metadata.path).is_dir(), TimeUtil.now_est_naive_iso(), True)
        self.records[worktree_id] = record
        self._save()
        return record

    def get(self, project: str, repository_root: str, worktree_id: str) -> ProjectWorktree:
        requested = worktree_id.strip() or "root"
        record = next((item for item in self.list_for_project(project, repository_root) if item.worktree_id == requested), None)
        if record is None:
            raise ValueError(f"unknown worktree: {requested}")
        if not record.available:
            raise ValueError(f"worktree is not available: {record.path}")
        return record

    def delete(self, project: str, repository_root: str, worktree_id: str, move_to_trash: bool) -> dict[str, object]:
        record = self.get(project, repository_root, worktree_id)
        if record.is_root:
            raise ValueError("the project root worktree cannot be deleted")
        moved_to = self.git_service.delete_project_worktree(record.metadata(), move_to_trash)
        self.records.pop(record.worktree_id, None)
        self._save()
        return {"id": record.worktree_id, "name": record.name, "path": record.path,
                "branch": record.branch, "moved_to_trash": moved_to}
