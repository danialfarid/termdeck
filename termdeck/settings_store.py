import json
from pathlib import Path

from termdeck.state_backup import StateBackupManager


class UiSettingsStore:
    """Persists UI settings (panel widths, per-panel font sizes) as JSON on the server side, so they survive
    browser resets and apply across browsers."""

    TMP_SUFFIX = ".tmp"

    def __init__(self, settings_file: Path, backup_manager: StateBackupManager | None = None) -> None:
        self._settings_file = settings_file
        self._backup_manager = backup_manager
        self._cached: tuple[tuple[int, int], dict[str, object]] | None = None

    def load(self) -> dict[str, object]:
        if not self._settings_file.exists():
            return {}
        return json.loads(self._settings_file.read_text())

    def load_shared(self) -> dict[str, object]:
        """The settings for reading only, parsed again only when the file changes: the file holds every
        terminal's prompt history, and re-parsing it for each one-setting check took a tenth of the
        server's time. Callers must not modify the result."""
        try:
            stat = self._settings_file.stat()
        except FileNotFoundError:
            return {}
        signature = (stat.st_mtime_ns, stat.st_size)
        if self._cached is None or self._cached[0] != signature:
            self._cached = (signature, self.load())
        return self._cached[1]

    def save(self, payload: dict[str, object]) -> None:
        self._settings_file.parent.mkdir(parents=True, exist_ok=True)
        if self._backup_manager is not None:
            self._backup_manager.before_state_write(self._settings_file)
        tmp_file = self._settings_file.with_suffix(self.TMP_SUFFIX)
        tmp_file.write_text(json.dumps(payload, indent=2))
        tmp_file.replace(self._settings_file)
