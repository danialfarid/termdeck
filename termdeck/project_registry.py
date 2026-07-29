import json
from pathlib import Path

from termdeck.config import TermdeckConfig


class ProjectRegistry:
    """Named base directories addressable in the UI url (/p/<name>). A project is auto-registered the first
    time a terminal is created inside its root; session records store the project slug for filtering."""

    TMP_SUFFIX = ".tmp"

    def __init__(self, projects_file: Path) -> None:
        self._projects_file = projects_file
        self._projects: dict[str, str] = self._load()

    def _load(self) -> dict[str, str]:
        if not self._projects_file.exists():
            return {}
        return json.loads(self._projects_file.read_text())

    def _save(self) -> None:
        self._projects_file.parent.mkdir(parents=True, exist_ok=True)
        tmp_file = self._projects_file.with_suffix(self.TMP_SUFFIX)
        tmp_file.write_text(json.dumps(self._projects, indent=2, sort_keys=True))
        tmp_file.replace(self._projects_file)

    def list_projects(self) -> list[dict[str, str]]:
        return [{"name": name, "root": root} for name, root in sorted(self._projects.items())]

    def root_for(self, name: str) -> str | None:
        return self._projects.get(name)

    def add_project(self, root: str | Path, name: str = "") -> dict[str, str]:
        """Register a directory explicitly and return its stable project entry."""
        root_path = Path(root).expanduser()
        if not root_path.is_dir():
            raise ValueError(f"project root is not a directory: {root_path}")
        root_path = root_path.resolve()
        root_str = str(root_path)
        for project_name, project_root in self._projects.items():
            if Path(project_root).expanduser().resolve() == root_path:
                return {"name": project_name, "root": project_root}
        project_name = self._unique_slug(name.strip() or root_path.name)
        self._projects[project_name] = root_str
        self._save()
        return {"name": project_name, "root": root_str}

    def ensure_project_for_cwd(self, cwd: Path) -> str:
        cwd_str = str(cwd)
        matches = [(len(root), name) for name, root in self._projects.items()
                   if cwd_str == root or cwd_str.startswith(root + "/")]
        if matches:
            return max(matches)[1]
        name = self._unique_slug(cwd.name or TermdeckConfig.PROJECT_FALLBACK_SLUG)
        self._projects[name] = cwd_str
        self._save()
        return name

    def _unique_slug(self, base: str) -> str:
        slug = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in base.lower()) or TermdeckConfig.PROJECT_FALLBACK_SLUG
        candidate, counter = slug, 2
        while candidate in self._projects:
            candidate, counter = f"{slug}-{counter}", counter + 1
        return candidate
