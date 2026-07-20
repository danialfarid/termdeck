import json
from pathlib import Path


class UiSettingsStore:
    """Persists UI settings (panel widths, per-panel font sizes) as JSON on the server side, so they survive
    browser resets and apply across browsers."""

    TMP_SUFFIX = ".tmp"

    def __init__(self, settings_file: Path) -> None:
        self._settings_file = settings_file

    def load(self) -> dict[str, object]:
        if not self._settings_file.exists():
            return {}
        return json.loads(self._settings_file.read_text())

    def save(self, payload: dict[str, object]) -> None:
        self._settings_file.parent.mkdir(parents=True, exist_ok=True)
        tmp_file = self._settings_file.with_suffix(self.TMP_SUFFIX)
        tmp_file.write_text(json.dumps(payload, indent=2))
        tmp_file.replace(self._settings_file)
