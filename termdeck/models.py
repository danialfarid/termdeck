from dataclasses import asdict, dataclass
from enum import Enum

from termdeck.config import TermdeckConfig


class AgentKind(str, Enum):
    CLAUDE = "claude"
    CODEX = "codex"
    AGY = "agy"
    NONE = "none"


@dataclass
class SessionRecord:
    """Persisted description of one terminal: what command it runs, where, and which agent CLI session it owns.

    cols/rows carry the terminal's last known size so a reattached pty keeps it. Without that the pty is
    rebuilt at the INITIAL_* default and every full-screen TUI reflows twice on first open, once at a size
    that does not match the pane.

    cli_title is the agent's own title with any spinner marker already stripped, kept so the sidebar can
    name a terminal before anyone attaches to it — it is otherwise only recoverable from scrollback, which
    is empty for agents whose screen lives in stripped synchronized-update frames.

    These three are the only fields that may be absent from a record written before they existed, hence the
    defaults on read.
    """

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
    output_path: str | None = None
    last_activity_at: float = 0.0
    cols: int = TermdeckConfig.INITIAL_COLS
    rows: int = TermdeckConfig.INITIAL_ROWS
    cli_title: str | None = None
    worktree_path: str | None = None
    worktree_repository: str | None = None
    worktree_branch: str | None = None
    worktree_base_ref: str | None = None
    worktree_base_commit: str | None = None
    worktree_managed: bool = False
    worktree_id: str = "root"
    claude_interrupted: bool = False
    fork_parent_agent_session_id: str | None = None

    def to_dict(self) -> dict[str, str | bool | int | float | None]:
        return asdict(self)

    @staticmethod
    def from_dict(payload: dict[str, str | bool | int | float | None]) -> "SessionRecord":
        agent_session_id = payload["agent_session_id"]
        return SessionRecord(session_id=str(payload["session_id"]), title=str(payload["title"]),
                             title_user_set=bool(payload["title_user_set"]), command=str(payload["command"]),
                             cwd=str(payload["cwd"]), agent_kind=str(payload["agent_kind"]),
                             agent_session_id=str(agent_session_id) if agent_session_id is not None else None,
                             created_at_est=str(payload["created_at_est"]), draft=str(payload["draft"] or ""),
                             project=str(payload["project"]),
                             output_path=str(payload.get("output_path")) if payload.get("output_path") is not None else None,
                             last_activity_at=float(payload.get("last_activity_at") or 0.0),
                             cols=int(payload.get("cols") or TermdeckConfig.INITIAL_COLS),
                             rows=int(payload.get("rows") or TermdeckConfig.INITIAL_ROWS),
                             cli_title=str(payload["cli_title"]) if payload.get("cli_title") else None,
                             worktree_path=str(payload["worktree_path"]) if payload.get("worktree_path") else None,
                             worktree_repository=str(payload["worktree_repository"]) if payload.get("worktree_repository") else None,
                             worktree_branch=str(payload["worktree_branch"]) if payload.get("worktree_branch") else None,
                             worktree_base_ref=str(payload["worktree_base_ref"]) if payload.get("worktree_base_ref") else None,
                             worktree_base_commit=str(payload["worktree_base_commit"]) if payload.get("worktree_base_commit") else None,
                             worktree_managed=bool(payload.get("worktree_managed", False)),
                             worktree_id=str(payload.get("worktree_id") or "root"),
                             claude_interrupted=bool(payload.get("claude_interrupted", False)),
                             fork_parent_agent_session_id=str(payload["fork_parent_agent_session_id"])
                             if payload.get("fork_parent_agent_session_id") else None)


class WsMessageFields:
    """Websocket JSON protocol field names and message-type values, mirrored by static/app.js."""

    TYPE = "type"
    DATA = "data"
    TEXT = "text"
    COLS = "cols"
    ROWS = "rows"
    INPUT = "input"
    RESIZE = "resize"
    REPAINT = "repaint"
    EXIT = "exit"
    CODE = "code"
    AGENT_SESSION = "agent_session"
    AGENT_SESSION_ID = "agent_session_id"
    DORMANT = "dormant"
    DRAFT = "draft"
    DRAFT_SYNC = "draft_sync"
    SUBMIT = "submit"
    QUEUE_EDIT = "queue_edit"
    QUEUE_MUTATION = "queue_mutation"
    PROMPT_SUBMITTED = "prompt_submitted"
    PROCESSING = "processing"
    SESSION_STATUS = "session_status"
    SERVER_INSTANCE = "server_instance"
    INSTANCE_ID = "instance_id"
    SESSION_ID = "session_id"
    TITLE = "title"
    TITLE_USER_SET = "title_user_set"
    CLI_TITLE = "cli_title"
    RUNNING = "running"
    EXIT_CODE = "exit_code"
    DELETED = "deleted"
    INDEX = "index"
    QUEUE = "queue"
    REMOVE = "remove"
    OK = "ok"
    ERROR = "error"
    TRANSCRIPT_SNAPSHOT = "transcript_snapshot"
    TRANSCRIPT_SNAPSHOT_START = "transcript_snapshot_start"
    TRANSCRIPT_SNAPSHOT_CHUNK = "transcript_snapshot_chunk"
    TRANSCRIPT_SNAPSHOT_END = "transcript_snapshot_end"
    TRANSCRIPT_UPDATE = "transcript_update"
    REVISION = "revision"
    REPLACE_FROM = "replace_from"
    TURNS = "turns"
    TRANSCRIPT_SUBSCRIBE = "transcript_subscribe"
    TRANSCRIPT_READY = "transcript_ready"
    FILE_TREE_CHANGED = "file_tree_changed"
    FILE_TREE_PING = "file_tree_ping"
    CHANGES = "changes"
    PATH = "path"
    PARENT = "parent"
    OPERATION = "operation"
    IS_DIRECTORY = "is_directory"


class ApiFields:
    """JSON field names added to session summaries on top of SessionRecord fields."""

    RUNNING = "running"
    EXIT_CODE = "exit_code"
    DORMANT = "dormant"
    DETACHED = "detached"
    CLI_TITLE = "cli_title"
    NEEDS_ATTENTION = "needs_attention"
    DELETED = "deleted"
