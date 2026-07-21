from dataclasses import asdict, dataclass
from enum import Enum


class AgentKind(str, Enum):
    CLAUDE = "claude"
    CODEX = "codex"
    NONE = "none"


@dataclass
class SessionRecord:
    """Persisted description of one terminal: what command it runs, where, and which agent CLI session it owns."""

    session_id: str
    title: str
    title_user_set: bool
    command: str
    cwd: str
    agent_kind: str
    agent_session_id: str | None
    created_at_est: str
    draft: str
    project: str

    def to_dict(self) -> dict[str, str | bool | None]:
        return asdict(self)

    @staticmethod
    def from_dict(payload: dict[str, str | bool | None]) -> "SessionRecord":
        agent_session_id = payload["agent_session_id"]
        return SessionRecord(session_id=str(payload["session_id"]), title=str(payload["title"]),
                             title_user_set=bool(payload["title_user_set"]), command=str(payload["command"]),
                             cwd=str(payload["cwd"]), agent_kind=str(payload["agent_kind"]),
                             agent_session_id=str(agent_session_id) if agent_session_id is not None else None,
                             created_at_est=str(payload["created_at_est"]), draft=str(payload["draft"] or ""),
                             project=str(payload["project"]))


class WsMessageFields:
    """Websocket JSON protocol field names and message-type values, mirrored by static/app.js."""

    TYPE = "type"
    DATA = "data"
    COLS = "cols"
    ROWS = "rows"
    INPUT = "input"
    RESIZE = "resize"
    EXIT = "exit"
    CODE = "code"
    AGENT_SESSION = "agent_session"
    AGENT_SESSION_ID = "agent_session_id"
    DRAFT = "draft"
    PROCESSING = "processing"
    DELETED = "deleted"


class ApiFields:
    """JSON field names added to session summaries on top of SessionRecord fields."""

    RUNNING = "running"
    EXIT_CODE = "exit_code"
    CLI_TITLE = "cli_title"
    DELETED = "deleted"
