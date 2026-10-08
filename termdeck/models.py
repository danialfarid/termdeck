from dataclasses import asdict, dataclass

from termdeck.config import TermdeckConfig


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
    imported_transcript_id: str | None = None
    description: str = ""
    # The terminal that asked for this one, when an agent spawned it through the task API. Distinct from
    # fork_parent_agent_session_id, which is the AGENT's own session that a fork continues: this is
    # TermDeck's session that issued the request, and it is what lets the sidebar file a spawned agent
    # under the agent that spawned it.
    spawned_by_session_id: str | None = None
    # Bumped on every accepted draft change. A client sends back the revision its copy came from, and
    # a push from an older copy is refused rather than allowed to overwrite what it never saw -- the
    # same answer notes got for the same corruption.
    draft_revision: int = 0

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
                             if payload.get("fork_parent_agent_session_id") else None,
                             imported_transcript_id=str(payload["imported_transcript_id"])
                             if payload.get("imported_transcript_id") else None,
                             description=str(payload.get("description") or ""),
                             spawned_by_session_id=str(payload["spawned_by_session_id"])
                             if payload.get("spawned_by_session_id") else None,
                             draft_revision=int(payload.get("draft_revision") or 0))


class PromptOutcome:
    """What became of a prompt sent to a terminal, as the API reports it.

    CONFIRMED: the agent recorded it as submitted. FAILED: it did not go in -- a dialog on screen would
    have taken its keys as an answer, or the terminal exited before taking it -- so sending it again is
    safe. UNCONFIRMED: it went in and nothing has shown whether the agent took it; sending it again
    risks a duplicate, so what to watch for is the agent's response.
    """

    CONFIRMED = "confirmed"
    UNCONFIRMED = "unconfirmed"
    FAILED = "failed"


@dataclass(frozen=True)
class PromptDelivery:
    queued: bool
    outcome: str
    detail: str = ""

    @property
    def submitted(self) -> bool:
        return self.outcome != PromptOutcome.FAILED


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
    TERMINAL_RESET = "terminal_reset"
    EXIT = "exit"
    CODE = "code"
    AGENT_SESSION = "agent_session"
    AGENT_SESSION_ID = "agent_session_id"
    DORMANT = "dormant"
    DRAFT = "draft"
    DRAFT_SYNC = "draft_sync"
    DRAFT_REVISION = "draft_revision"
    BASE_REVISION = "base_revision"
    DRAFT_CONFLICT = "draft_conflict"
    SUBMIT = "submit"
    QUEUE_EDIT = "queue_edit"
    QUEUE_MUTATION = "queue_mutation"
    PROMPT_SUBMITTED = "prompt_submitted"
    PROCESSING = "processing"
    SESSION_STATUS = "session_status"
    PROJECT_STATE = "project_state"
    SERVER_INSTANCE = "server_instance"
    INSTANCE_ID = "instance_id"
    VERSION = "version"
    SESSION_ID = "session_id"
    PROJECT = "project"
    WORKTREE_ID = "worktree_id"
    STATE = "state"
    SESSIONS = "sessions"
    CLOSED_SESSIONS = "closed_sessions"
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
    ACTIVITY = "activity"
    DESCRIPTION = "description"
    TERMDECK_URL = "termdeck_url"
    TERMDECK_URL_PATH = "termdeck_url_path"
    DELETED = "deleted"
