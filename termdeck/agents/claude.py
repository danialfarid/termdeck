import shlex

from termdeck.agents.base import AgentCli
from termdeck.config import TermdeckConfig


class ClaudeCli(AgentCli):
    kind = "claude"
    executable = "claude"
    label = "Claude"

    supports_resume = True
    supports_fork = True
    fork_tracks_parent = True
    canonical_resume_command = True
    records_raw_replay = True

    permission_flags = {
        "default": (),
        "accept-edits": ("--permission-mode", "acceptEdits"),
        "acceptedits": ("--permission-mode", "acceptEdits"),
        "auto": ("--permission-mode", "auto"),
        "full-access": ("--dangerously-skip-permissions",),
        "bypasspermissions": ("--dangerously-skip-permissions",),
        "manual": ("--permission-mode", "manual"),
        "dontask": ("--permission-mode", "dontAsk"),
        "dont-ask": ("--permission-mode", "dontAsk"),
        "plan": ("--permission-mode", "plan"),
    }
    ui_permissions = ("default", "accept-edits", "auto", "full-access")
    permission_switch_flags = ("--dangerously-skip-permissions",)
    permission_value_flags = ("--permission-mode",)

    prompt_marker = "❯"

    def new_session_resume_arguments(self, session_ref: str, tracker) -> tuple[str, ...]:
        return (TermdeckConfig.CLAUDE_RESUME_FLAG, session_ref)

    def resume_command(self, original_command: str, agent_session_id: str) -> str:
        cleaned = self.strip_flag_with_value(self.command_parts(original_command),
                                             TermdeckConfig.CLAUDE_RESUME_FLAG)
        if not cleaned:
            cleaned = [self.executable]
        return f"{shlex.join(cleaned)} {TermdeckConfig.CLAUDE_RESUME_FLAG} {agent_session_id}"

    def fork_command(self, original_command: str, agent_session_id: str, session_name: str = "") -> str:
        cleaned = self.strip_flag_with_value(self.command_parts(original_command),
                                             TermdeckConfig.CLAUDE_RESUME_FLAG)
        cleaned = self.strip_flag_with_value(cleaned, TermdeckConfig.CLAUDE_NAME_FLAG)
        if not cleaned:
            cleaned = [self.executable]
        cleaned.extend((TermdeckConfig.CLAUDE_RESUME_FLAG, agent_session_id, TermdeckConfig.CLAUDE_FORK_FLAG))
        if session_name.strip():
            cleaned.extend((TermdeckConfig.CLAUDE_NAME_FLAG, " ".join(session_name.splitlines()).strip()))
        return shlex.join(cleaned)
