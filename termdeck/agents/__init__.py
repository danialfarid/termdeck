"""One class per agent CLI. Adding an agent = write the class, add it to AGENT_CLIS.

See docs/agent-cli-api.md for the full design and migration plan.
"""
import re
from pathlib import Path

from termdeck.agents.agy import AgyCli
from termdeck.agents.base import AgentCli, ShellCli
from termdeck.agents.claude import ClaudeCli
from termdeck.agents.codex import CodexCli

# Detection priority follows this order (shell is the fallback, never matched by token).
AGENT_CLIS: dict[str, AgentCli] = {agent.kind: agent
                                   for agent in (ShellCli(), ClaudeCli(), CodexCli(), AgyCli())}

_MODEL_ALIASES = {alias: agent.kind for agent in AGENT_CLIS.values() for alias in agent.model_aliases}
_COMMAND_SPLIT_RE = re.compile(r"[\s;|&()]+")


def agent_cli(kind: str) -> AgentCli:
    agent = AGENT_CLIS.get(kind)
    if agent is None:
        raise ValueError(f"unknown agent kind: {kind}")
    return agent


def resolve_model_alias(name: str) -> str:
    return _MODEL_ALIASES.get(name, name)


def detect_agent_cli(command: str) -> AgentCli:
    tokens = {Path(token).name for token in _COMMAND_SPLIT_RE.split(command) if token}
    for agent in AGENT_CLIS.values():
        if agent.is_agent and agent.executable in tokens:
            return agent
    return AGENT_CLIS[ShellCli.kind]


def agent_for_transcript_path(path: Path) -> AgentCli | None:
    for agent in AGENT_CLIS.values():
        if agent.is_agent and agent.owns_transcript_path(path):
            return agent
    return None
