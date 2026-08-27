import hashlib
import json
from pathlib import Path
from typing import Iterable

from termdeck.agents.base import UUID_RE, AgentCli
from termdeck.transcript_turns import TurnBuilder


class GeminiCli(AgentCli):
    """Google's gemini-cli.

    Its on-disk model is unlike the jsonl agents: each session is ONE pretty-printed JSON
    document (rewritten on every save) under ~/.gemini/tmp/<sha256(cwd)>/chats/, and resume
    addresses sessions by per-project INDEX rather than id — too unstable to respawn onto,
    so supports_resume stays off and a dead terminal restarts fresh.
    """

    kind = "gemini"
    executable = "gemini"
    label = "Gemini"
    # The bare word "gemini" in the model field is claimed by AgyCli (antigravity) for
    # historical reasons; this adapter is selected there via these names instead.
    model_aliases = ("gemini-cli", "geminicli")

    sessions_root = Path.home() / ".gemini" / "tmp"
    # Whole-document JSON does not fit the jsonl history indexer.
    history_indexed = False

    permission_flags = {
        "default": (),
        "auto-edit": ("--approval-mode", "auto_edit"),
        "autoedit": ("--approval-mode", "auto_edit"),
        "plan": ("--approval-mode", "plan"),
        "full-access": ("--yolo",),
        "yolo": ("--yolo",),
    }
    ui_permission_options = (("default", "Default"), ("auto-edit", "Auto edit"),
                             ("plan", "Plan"), ("full-access", "Full access (YOLO)"))
    permission_switch_flags = ("--yolo",)
    permission_value_flags = ("--approval-mode",)

    TRANSCRIPT_MAX_BYTES = 16_000_000

    def project_chats_dir(self, cwd: Path) -> Path | None:
        hashed = self.sessions_root / hashlib.sha256(str(cwd).encode()).hexdigest() / "chats"
        if hashed.is_dir():
            return hashed
        # Older layouts recorded the project root in a marker file instead.
        try:
            for entry in self.sessions_root.iterdir():
                marker = entry / ".project_root"
                try:
                    if marker.is_file() and marker.read_text().strip() == str(cwd) and (entry / "chats").is_dir():
                        return entry / "chats"
                except OSError:
                    continue
        except OSError:
            return None
        return None

    def _session_document(self, path: Path) -> dict[str, object] | None:
        try:
            if path.stat().st_size > self.TRANSCRIPT_MAX_BYTES:
                return None
            document = json.loads(path.read_text(errors="replace"))
        except (OSError, json.JSONDecodeError):
            return None
        return document if isinstance(document, dict) else None

    def transcript_path(self, cwd: Path | None, agent_session_id: str) -> Path | None:
        if cwd is None:
            return None
        chats = self.project_chats_dir(cwd)
        if chats is None:
            return None
        # The filename carries a short id prefix; the full sessionId lives inside the document.
        short = agent_session_id.split("-")[0]
        candidates = sorted(chats.glob(f"session-*-{short}.json"), reverse=True) or \
            sorted(chats.glob("session-*.json"), reverse=True)
        for path in candidates:
            document = self._session_document(path)
            if document and document.get("sessionId") == agent_session_id:
                return path
        return None

    def candidate_session_files(self, cwd: Path) -> list[tuple[Path, str]]:
        chats = self.project_chats_dir(cwd)
        if chats is None:
            return []
        pairs: list[tuple[Path, str]] = []
        for path in chats.glob("session-*.json"):
            document = self._session_document(path)
            session_id = document.get("sessionId") if document else None
            if isinstance(session_id, str) and UUID_RE.fullmatch(session_id):
                pairs.append((path, session_id))
        return pairs

    def owns_transcript_path(self, path: Path) -> bool:
        root = self.sessions_root
        return path.is_relative_to(root) or path.is_relative_to(root.resolve())

    def session_id_from_path(self, path: Path) -> str | None:
        if not self.owns_transcript_path(path) or path.suffix != ".json":
            return None
        document = self._session_document(path)
        session_id = document.get("sessionId") if document else None
        return session_id if isinstance(session_id, str) and UUID_RE.fullmatch(session_id) else None

    # -- transcript parsing ------------------------------------------------
    # The transcript tail readers hand this LINES of the file; a session document only parses
    # as a whole, so joining them back is the per-format move. A partial window (mid-document)
    # parses as nothing, and the reload path keeps widening until the document is complete.

    def parse_transcript_lines(self, lines: Iterable[str]) -> list[dict[str, object]]:
        text = "\n".join(lines).strip()
        if not text.startswith("{"):
            return []
        try:
            document = json.loads(text)
        except json.JSONDecodeError:
            return []
        if not isinstance(document, dict):
            return []
        turns: list[dict[str, object]] = []
        for message in document.get("messages") or []:
            if not isinstance(message, dict):
                continue
            content = str(message.get("content") or "")
            message_type = message.get("type")
            model = str(message.get("model") or "") or None
            if message_type == "user":
                if content.strip():
                    turns.append(TurnBuilder.turn(TurnBuilder.ROLE_USER, content, model=model))
            elif message_type == "gemini":
                thoughts = message.get("thoughts")
                if isinstance(thoughts, list) and thoughts:
                    thought_text = "\n".join(
                        f"{item.get('subject', '')}: {item.get('description', '')}".strip(": ")
                        for item in thoughts if isinstance(item, dict))
                    if thought_text.strip():
                        turns.append(TurnBuilder.turn("event", thought_text, "thinking", "Thinking", model=model))
                if content.strip():
                    turns.append(TurnBuilder.turn(TurnBuilder.ROLE_ASSISTANT, content, model=model))
            elif content.strip():
                turns.append(TurnBuilder.turn("event", content, kind="result",
                                              title=str(message_type or "info").title(), model=model))
        return turns

    def latest_usage(self, cwd: Path | None, agent_session_id: str | None) -> dict[str, int | None] | None:
        if cwd is None or not agent_session_id:
            return None
        path = self.transcript_path(cwd, agent_session_id)
        document = self._session_document(path) if path else None
        if not document:
            return None
        for message in reversed(document.get("messages") or []):
            tokens = message.get("tokens") if isinstance(message, dict) else None
            if not isinstance(tokens, dict):
                continue
            def count(key: str, source: dict = tokens) -> int:
                value = source.get(key)
                return int(value) if isinstance(value, (int, float)) else 0
            return {"context_tokens": count("input") + count("cached"),
                    "output_tokens": count("output"),
                    "context_window": None,
                    "total_tokens": count("total") or None}
        return None
