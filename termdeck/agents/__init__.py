"""One class per agent CLI. Adding an agent = write the class, add it to AGENT_CLIS.

See docs/agent-cli-api.md for the full design and migration plan.
"""
import re
from pathlib import Path

from termdeck.agents.agy import AgyCli
from termdeck.agents.aider import AiderCli
from termdeck.agents.archived import ArchivedTranscriptCli
from termdeck.agents.base import AgentCli, ShellCli
from termdeck.agents.claude import ClaudeCli
from termdeck.agents.codex import CodexCli
from termdeck.agents.declarative import DeclarativeAgentCli
from termdeck.agents.opencode import OpencodeCli
from termdeck.agents.profile_schema import AgentProfileLoader
from termdeck.config import TermdeckConfig

# Detection priority follows this order (shell is the fallback, never matched by token).
_BUILTIN_AGENT_CLIS = (ShellCli(), ClaudeCli(), CodexCli(), AgyCli(), AiderCli(), OpencodeCli(),
                       ArchivedTranscriptCli())
_DECLARATIVE_AGENT_CLIS = tuple(DeclarativeAgentCli(profile)
                                for profile in AgentProfileLoader.load(TermdeckConfig.AGENT_PROFILES_FILE))
_builtin_kinds = {agent.kind for agent in _BUILTIN_AGENT_CLIS}
_builtin_executables = {agent.executable for agent in _BUILTIN_AGENT_CLIS if agent.executable}
_builtin_names = _builtin_kinds | {alias for agent in _BUILTIN_AGENT_CLIS for alias in agent.model_aliases}
if duplicate_kinds := _builtin_kinds & {agent.kind for agent in _DECLARATIVE_AGENT_CLIS}:
    raise ValueError(f"agent profiles duplicate built-in kinds: {', '.join(sorted(duplicate_kinds))}")
if duplicate_executables := _builtin_executables & {agent.executable for agent in _DECLARATIVE_AGENT_CLIS}:
    raise ValueError(f"agent profiles duplicate built-in executables: {', '.join(sorted(duplicate_executables))}")
_custom_names = [name for agent in _DECLARATIVE_AGENT_CLIS for name in (agent.kind, *agent.model_aliases)]
if reserved_names := _builtin_names & set(_custom_names):
    raise ValueError(f"agent profiles duplicate built-in names: {', '.join(sorted(reserved_names))}")
if len(_custom_names) != len(set(_custom_names)):
    raise ValueError("agent profile kinds and aliases must be unique")
_custom_executables = [agent.executable for agent in _DECLARATIVE_AGENT_CLIS]
if len(_custom_executables) != len(set(_custom_executables)):
    raise ValueError("agent profile executables must be unique")
AGENT_CLIS: dict[str, AgentCli] = {agent.kind: agent for agent in (*_BUILTIN_AGENT_CLIS,
                                                                  *_DECLARATIVE_AGENT_CLIS)}

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
