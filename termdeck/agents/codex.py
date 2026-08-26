import shlex
from pathlib import Path

from termdeck.agents.base import AgentCli
from termdeck.config import TermdeckConfig


class CodexCli(AgentCli):
    kind = "codex"
    executable = "codex"
    label = "Codex"

    supports_resume = True
    supports_fork = True
    canonical_resume_command = True
    records_raw_replay = True
    has_prompt_queue = True

    base_flags = (TermdeckConfig.CODEX_NO_ALT_SCREEN_FLAG,)
    permission_flags = {
        "default": (),
        "read-only": ("--sandbox", "read-only"),
        "workspace-write": ("--sandbox", "workspace-write"),
        "full-access": ("--dangerously-bypass-approvals-and-sandbox",),
    }
    ui_permissions = ("default", "read-only", "workspace-write", "full-access")
    permission_switch_flags = ("--dangerously-bypass-approvals-and-sandbox",)
    permission_value_flags = ("--sandbox",)

    prompt_marker = "›"

    REASONING_EFFORTS = frozenset({"low", "medium", "high", "xhigh"})

    def model_arguments(self, model_name: str) -> tuple[str, ...]:
        # A trailing reasoning-effort word ("gpt-5.6-luna xhigh") becomes a -c override.
        parts = model_name.split()
        arguments: list[str] = []
        if len(parts) > 1 and parts[-1].lower() in self.REASONING_EFFORTS:
            arguments.extend(("-c", f'model_reasoning_effort="{parts[-1].lower()}"'))
            model_name = " ".join(parts[:-1])
        arguments.extend(("--model", model_name))
        return tuple(arguments)

    def new_session_resume_arguments(self, session_ref: str, tracker) -> tuple[str, ...]:
        resolved = tracker.codex_session_id_for_reference(session_ref)
        if resolved is None:
            raise ValueError(f"no saved Codex session found with ID or name: {session_ref}")
        return ("resume", resolved)

    def resume_command(self, original_command: str, agent_session_id: str) -> str:
        parts = self.command_parts(original_command)
        if not parts:
            return f"{self.executable} {TermdeckConfig.CODEX_NO_ALT_SCREEN_FLAG} resume {agent_session_id}"
        cleaned = self._ensure_searchable_scrollback(self.strip_session_arguments(parts))
        return f"{shlex.join(cleaned)} resume {agent_session_id}"

    def fork_command(self, original_command: str, agent_session_id: str, session_name: str = "") -> str:
        parts = self.command_parts(original_command)
        cleaned = self.strip_session_arguments(parts) if parts else [self.executable]
        cleaned = self._ensure_searchable_scrollback(cleaned)
        cleaned.extend(("fork", agent_session_id))
        return shlex.join(cleaned)

    def strip_session_arguments(self, parts: list[str]) -> list[str]:
        cleaned: list[str] = []
        command_seen = False
        skip_session_id = False
        for token in parts:
            if skip_session_id:
                skip_session_id = False
                continue
            if not command_seen:
                cleaned.append(token)
                command_seen = Path(token).name == self.executable
                continue
            if token in {"fork", "resume"}:
                skip_session_id = True
                continue
            cleaned.append(token)
        return cleaned

    def _ensure_searchable_scrollback(self, parts: list[str]) -> list[str]:
        # The alternate screen keeps output out of scrollback; TermDeck needs it searchable.
        if TermdeckConfig.CODEX_NO_ALT_SCREEN_FLAG in parts:
            return parts
        command_index = next((index for index, token in enumerate(parts)
                              if Path(token).name == self.executable), None)
        if command_index is None:
            return parts
        return [*parts[:command_index + 1], TermdeckConfig.CODEX_NO_ALT_SCREEN_FLAG, *parts[command_index + 1:]]
