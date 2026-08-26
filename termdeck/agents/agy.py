import shlex

from termdeck.agents.base import AgentCli
from termdeck.config import TermdeckConfig


class AgyCli(AgentCli):
    kind = "agy"
    executable = "agy"
    label = "AGY"
    model_aliases = ("agd", "agy-cli", "agycli", "gemini", "antigravity", "antigravity-cli", "antigravitycli")

    # Restarted terminals resume via --conversation; attaching to an EXISTING agy session from
    # the create dialog is unsupported (new_session_resume_arguments raises), as is forking.
    supports_resume = True

    permission_flags = {
        "default": (),
        "full-access": ("--dangerously-skip-permissions",),
    }
    ui_permissions = ("default", "full-access")
    permission_switch_flags = ("--dangerously-skip-permissions",)

    def resume_command(self, original_command: str, agent_session_id: str) -> str:
        cleaned = self.strip_session_arguments(self.command_parts(original_command))
        if not cleaned:
            cleaned = [self.executable]
        cleaned.extend((TermdeckConfig.AGY_CONVERSATION_FLAG, agent_session_id))
        return shlex.join(cleaned)

    def strip_session_arguments(self, parts: list[str]) -> list[str]:
        cleaned: list[str] = []
        skip_next = False
        for token in parts:
            if skip_next:
                skip_next = False
                continue
            if token == TermdeckConfig.AGY_CONVERSATION_FLAG:
                skip_next = True
                continue
            if token.startswith(f"{TermdeckConfig.AGY_CONVERSATION_FLAG}=") or token in {"-c", "--continue"}:
                continue
            cleaned.append(token)
        return cleaned
