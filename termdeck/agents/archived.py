import json
import re
from pathlib import Path
from typing import Iterable

from termdeck.agents.base import AgentCli
from termdeck.config import TermdeckConfig


class ArchivedTranscriptCli(AgentCli):
    """Reads normalized conversation turns stored inside an imported TermDeck session archive."""

    kind = "termdeck-archive"
    label = "Imported transcript"
    is_agent = False
    launcher_visible = False
    launchable = False
    sessionless = True
    SESSION_ID_PATTERN = re.compile(r"^[0-9a-f]{12}$")

    def transcript_path(self, cwd: Path | None, agent_session_id: str) -> Path | None:
        if not self.SESSION_ID_PATTERN.fullmatch(agent_session_id):
            return None
        path = TermdeckConfig.IMPORTED_TRANSCRIPTS_DIR / f"{agent_session_id}.jsonl"
        return path if path.is_file() else None

    def parse_transcript_lines(self, lines: Iterable[str]) -> list[dict[str, object]]:
        turns: list[dict[str, object]] = []
        for line in lines:
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(payload, dict) or not isinstance(payload.get("role"), str) or \
                    not isinstance(payload.get("text"), str):
                continue
            turns.append(payload)
        return turns
