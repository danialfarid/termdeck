from pathlib import Path

from termdeck.platform_paths import PlatformPaths


class TermdeckConfig:
    """All static configuration for termdeck: server binding, storage paths, pty spawn settings, and the
    claude/codex session-file locations + resume-command shapes used for restart-and-resume.

    Machine-dependent values are read from TERMDECK_* environment variables at import time (see PlatformPaths)
    so `termdeck --port 9000` and a launchd/systemd unit's environment block land in exactly the same place.
    An override therefore has to be in the environment BEFORE this module is first imported."""

    HOST = PlatformPaths.env_text(PlatformPaths.ENV_HOST, "127.0.0.1")
    PORT = PlatformPaths.env_int(PlatformPaths.ENV_PORT, 8530)
    LAN_PORT = PlatformPaths.env_int(PlatformPaths.ENV_LAN_PORT, 8532)
    DATA_DIR = PlatformPaths.env_directory(PlatformPaths.ENV_DATA_DIR, PlatformPaths.default_data_dir())
    SESSIONS_FILE = DATA_DIR / "sessions.json"
    SETTINGS_FILE = DATA_DIR / "settings.json"
    REMOTE_CREDENTIALS_FILE = DATA_DIR / "remote-credentials.json"
    CLOSED_SESSIONS_FILE = DATA_DIR / "closed_sessions.json"
    CLOSED_HISTORY_MAX = 100
    PROJECTS_FILE = DATA_DIR / "projects.json"
    SCROLLBACK_DIR = DATA_DIR / "scrollback"
    SCROLLBACK_SUFFIX = ".bin"
    # Historical name on disk; the recording is generic (any agent with records_raw_replay).
    RAW_REPLAY_SUFFIX = ".claude-replay.bin"
    # How long after input or output a replay is written to disk. This is the ONLY thing that makes a
    # replay durable -- there is no periodic sweep and no shutdown hook behind it, because a server dies
    # by SIGKILL, crash-loop or power loss far more often than it is stopped politely, and a second
    # mechanism for the same job only hides the gaps in the first. Activity inside an already-scheduled
    # window joins that write rather than postponing it, so a streaming session costs at most one append
    # per window however much it writes, and each append carries only the bytes since the last one.
    REPLAY_CHECKPOINT_DEBOUNCE_SECONDS = 1.0
    RAW_REPLAY_SESSION_BYTES = 24_000_000
    RAW_REPLAY_TOTAL_BYTES = 100_000_000
    TERMINAL_HISTORY_RESET_SEQUENCE = b"\x1b[3J\x1b[2J\x1b[H"
    STATE_BACKUP_DIR = DATA_DIR / "backups"
    STATE_BACKUP_MAX_BYTES = 50_000_000
    STATE_BACKUP_INTERVAL_SECONDS = 3600.0
    STATE_BACKUP_PREWRITE_INTERVAL_SECONDS = 300.0
    # The service log is append-only for the life of the machine otherwise: uvicorn logs every websocket
    # accept, so an always-on deck adds megabytes a week and nobody reads past the last restart.
    SERVICE_LOG_MAX_BYTES = 5_000_000
    SERVICE_LOG_KEEP_BYTES = 2_000_000
    SERVICE_LOG_TRIM_INTERVAL_SECONDS = 900.0
    UPLOADS_DIR = DATA_DIR / "uploads"
    API_UPLOAD_ROUTE = "/api/upload"
    UPLOAD_MAX_BYTES = 30_000_000
    UPLOAD_TOTAL_MAX_BYTES = 200_000_000
    UPLOAD_FALLBACK_NAME = "pasted"
    PROJECT_FALLBACK_SLUG = "project"
    API_PROJECTS_ROUTE = "/api/projects"
    API_WORKTREES_ROUTE = "/api/worktrees"
    API_WORKTREE_BRANCHES_ROUTE = "/api/worktrees/branches"
    API_WORKTREE_ROUTE = "/api/worktrees/{worktree_id}"
    API_PROJECT_FOLDER_PICKER_ROUTE = "/api/projects/pick-folder"
    API_STATE_RECOVERY_ROUTE = "/api/state-recovery"
    API_STATE_RECOVERY_RESTORE_ROUTE = "/api/state-recovery/restore"
    PROJECT_PAGE_ROUTE = "/p/{project_name}"
    PROJECT_NAVIGATION_PAGE_ROUTE = "/p/{project_name}/{navigation_path:path}"
    FILEDECK_PAGE_ROUTE = "/f/{project_name}"
    FILEDECK_NAVIGATION_PAGE_ROUTE = "/f/{project_name}/{navigation_path:path}"
    GIT_PAGE_ROUTE = "/g/{project_name}"
    GIT_NAVIGATION_PAGE_ROUTE = "/g/{project_name}/{navigation_path:path}"
    STATIC_DIR = Path(__file__).resolve().parent / "static"
    FILEDECK_STATIC_DIR = Path(__file__).resolve().parent.parent / "filedeck" / "static"
    INDEX_FILE = "index.html"
    STATIC_ROUTE = "/static"
    STATIC_NAME = "static"
    FILEDECK_STATIC_ROUTE = "/filedeck/static"
    FILEDECK_STATIC_NAME = "filedeck-static"
    FILEBROWSER_STATIC_DIR = Path(__file__).resolve().parent.parent / "filebrowser" / "static"
    FILEBROWSER_STATIC_ROUTE = "/filebrowser/static"
    FILEBROWSER_STATIC_NAME = "filebrowser-static"
    API_AGENTS_ROUTE = "/api/agents"
    API_SESSIONS_ROUTE = "/api/sessions"
    API_TERMINAL_TASK_ROUTE = "/api/terminals/task"
    API_TERMINAL_TASK_PROMPT_ROUTE = "/api/terminals/task/{session_id}/prompt"
    API_TERMINALS_BATCH_ROUTE = "/api/terminals/batch"
    API_SESSION_ROUTE = "/api/sessions/{session_id}"
    API_SESSION_TASK_STATUS_ROUTE = "/api/sessions/{session_id}/task"
    API_SESSION_TASK_RESULT_ROUTE = "/api/sessions/{session_id}/task-result"
    API_SESSION_LAST_TURN_ROUTE = "/api/sessions/{session_id}/last_turn"
    API_SESSION_PROMPT_ROUTE = "/api/sessions/{session_id}/prompt"
    API_SESSION_STOP_ROUTE = "/api/sessions/{session_id}/stop"
    API_SESSION_RESTART_ROUTE = "/api/sessions/{session_id}/restart"
    API_SESSION_FORK_ROUTE = "/api/sessions/{session_id}/fork"
    API_SESSION_WORKTREE_REVIEW_ROUTE = "/api/sessions/{session_id}/worktree/review"
    API_SESSION_WORKTREE_FINISH_ROUTE = "/api/sessions/{session_id}/worktree/finish"
    API_SESSION_RENAME_ROUTE = "/api/sessions/{session_id}/rename"
    API_SESSION_PROJECT_ROUTE = "/api/sessions/{session_id}/project"
    API_SESSION_USAGE_ROUTE = "/api/sessions/{session_id}/usage"
    API_SESSION_HISTORY_ROUTE = "/api/sessions/{session_id}/history"
    API_SESSION_HISTORY_PAGE_ROUTE = "/api/sessions/{session_id}/history-page"
    API_KILL_ALL_TERMINALS_ROUTE = "/api/terminals/kill-all"
    API_KILL_STALE_TERMINALS_ROUTE = "/api/terminals/kill-stale"
    API_SERVER_RESTART_ROUTE = "/api/server/restart"
    API_TERMINAL_PROCESSES_ROUTE = "/api/terminals/processes"
    API_RECLAIM_ORPHAN_TERMINALS_ROUTE = "/api/terminals/reclaim-orphans"
    API_TERMINAL_LAYOUT_ROUTE = "/api/terminal-layout"
    API_TERMINAL_GROUPS_ROUTE = "/api/terminal-groups"
    API_TERMINAL_GROUP_ROUTE = "/api/terminal-groups/{group_id}"
    API_TERMINAL_GROUP_MERGE_ROUTE = "/api/terminal-groups/{group_id}/merge"
    API_SESSION_GROUP_ASSIGNMENTS_ROUTE = "/api/session-group-assignments"
    API_TERMINAL_LAYOUT_MOVE_ROUTE = "/api/terminal-layout/move"
    API_SESSION_ORDER_MOVE_ROUTE = "/api/session-order/move"
    API_SESSION_UNREAD_ROUTE = "/api/session-unread"
    API_RECENTLY_OPENED_TERMINAL_ROUTE = "/api/recently-opened-terminals/{session_id}"
    API_SESSION_VIEW_MODE_ROUTE = "/api/session-view-modes/{session_id}"
    API_PROJECT_STATE_FIELD_ROUTE = "/api/project-state/{field_name}"
    API_TERMINAL_SEARCH_ROUTE = "/api/terminal-search"
    # Claude Code hook callback. Claude posts its own hook payload here (see docs/configuration.md);
    # `state=attention` marks the tab as waiting on the user, `state=clear` releases it.
    API_AGENT_HOOK_ROUTE = "/api/agent-hook"
    AGENT_HOOK_ATTENTION_STATE = "attention"
    API_HISTORY_SEARCH_ROUTE = "/api/history-search"
    API_HISTORY_CONTEXT_ROUTE = "/api/history-context"
    API_SETTINGS_ROUTE = "/api/settings"
    API_DIAGNOSTICS_ROUTE = "/api/debug/diagnostics"
    DIAGNOSTICS_DIR_NAME = "diagnostics"
    DIAGNOSTICS_MAX_BYTES = 32 * 1024 * 1024
    API_SETTING_ROUTE = "/api/settings/{setting_name}"
    API_SETTING_ENTRY_ROUTE = "/api/settings/{setting_name}/{entry_key}"
    API_REMOTE_STATUS_ROUTE = "/api/remote/status"
    API_REMOTE_PAIR_ROUTE = "/api/remote/pair"
    API_REMOTE_DISCONNECT_ROUTE = "/api/remote/disconnect"
    API_LAN_STATUS_ROUTE = "/api/lan/status"
    API_LAN_ACCESS_ROUTE = "/api/lan/access"
    API_NOTEBOOK_TRASH_ROUTE = "/api/notebook/trash"
    API_CLOSED_ROUTE = "/api/closed"
    API_CLOSED_ITEM_ROUTE = "/api/closed/{session_id}"
    API_CLOSED_REOPEN_ROUTE = "/api/closed/{session_id}/reopen"
    API_FILE_LIST_ROUTE = "/api/files/list"
    API_FILE_RECENT_ROUTE = "/api/files/recent"
    API_FILE_READ_ROUTE = "/api/files/read"
    API_FILE_EXISTS_ROUTE = "/api/files/exists"
    API_FILE_OPEN_EXTERNAL_ROUTE = "/api/files/open-external"
    API_FILE_SEARCH_ROUTE = "/api/files/search"
    API_FILE_FIND_ROUTE = "/api/files/find"
    API_FILE_WRITE_ROUTE = "/api/files/write"
    API_FILE_CREATE_ROUTE = "/api/files/create"
    API_FILE_DUPLICATE_ROUTE = "/api/files/duplicate"
    API_FILE_HISTORY_ROUTE = "/api/files/history"
    API_FILE_HISTORY_VERSION_ROUTE = "/api/files/history/{version_id}"
    API_FILE_HISTORY_RESTORE_ROUTE = "/api/files/history/restore"
    API_FILE_GIT_HISTORY_ROUTE = "/api/files/git-history"
    API_FILE_GIT_HISTORY_VERSION_ROUTE = "/api/files/git-history/{commit_id}"
    API_FILE_GIT_STATUS_ROUTE = "/api/files/git-status"
    API_FILE_GIT_BRANCH_ROUTE = "/api/files/git-branch"
    API_FILE_GIT_BLAME_ROUTE = "/api/files/git-blame"
    API_FILE_GIT_DIFF_ROUTE = "/api/files/git-diff"
    API_GIT_WORKFLOW_STATE_ROUTE = "/api/git/state"
    API_GIT_STAGE_ROUTE = "/api/git/stage"
    API_GIT_UNSTAGE_ROUTE = "/api/git/unstage"
    API_GIT_REVERT_ROUTE = "/api/git/revert"
    API_GIT_REVIEW_ROUTE = "/api/git/review"
    API_GIT_GRAPH_ROUTE = "/api/git/graph"
    API_GIT_COMMIT_DETAIL_ROUTE = "/api/git/commit-detail"
    API_GIT_COMMIT_ROUTE = "/api/git/commit"
    API_GIT_BRANCH_ROUTE = "/api/git/branch"
    API_GIT_SWITCH_ROUTE = "/api/git/switch"
    API_GIT_STASH_ROUTE = "/api/git/stash"
    API_GIT_STASH_ACTION_ROUTE = "/api/git/stash/action"
    API_GIT_CONFLICT_ROUTE = "/api/git/conflict"
    API_GIT_WORKTREE_ROUTE = "/api/git/worktree"
    API_GIT_REMOTE_ROUTE = "/api/git/remote"
    API_GIT_CLONE_ROUTE = "/api/git/clone"
    API_GIT_REFS_ROUTE = "/api/git/refs"
    API_GIT_COMPARE_ROUTE = "/api/git/compare"
    API_GIT_COMPARE_REVIEW_ROUTE = "/api/git/compare/review"
    API_GIT_DIVERGENCE_ROUTE = "/api/git/divergence"
    API_GIT_HUNKS_ROUTE = "/api/git/hunks"
    API_GIT_HUNK_ACTION_ROUTE = "/api/git/hunks/action"
    API_GIT_COMMIT_ACTION_ROUTE = "/api/git/commit/action"
    API_GIT_REBASE_PLAN_ROUTE = "/api/git/rebase/plan"
    API_GIT_REBASE_ROUTE = "/api/git/rebase"
    API_GIT_OPERATION_ROUTE = "/api/git/operation"
    API_GIT_IGNORE_ROUTE = "/api/git/ignore"
    API_GITHUB_PULL_REQUESTS_ROUTE = "/api/git/github/pull-requests"
    API_GITHUB_PULL_REQUEST_ROUTE = "/api/git/github/pull-request"
    API_GITHUB_PULL_REQUEST_PATCH_ROUTE = "/api/git/github/pull-request/patch"
    API_GITHUB_PULL_REQUEST_REVIEW_ROUTE = "/api/git/github/pull-request/review"
    API_FILE_REPLACE_ROUTE = "/api/files/replace"
    REPLACE_MAX_FILES = 200
    FIND_MAX_RESULTS = 200
    API_FILE_RENAME_ROUTE = "/api/files/rename"
    API_FILE_MOVE_ROUTE = "/api/files/move"
    API_FILE_DELETE_ROUTE = "/api/files/delete"
    API_LSP_STATUS_ROUTE = "/api/lsp/status"
    API_LSP_CONFIG_ROUTE = "/api/lsp/config"
    API_LSP_ENABLED_ROUTE = "/api/lsp/enabled"
    API_LSP_APPLY_WORKSPACE_EDIT_ROUTE = "/api/lsp/apply-workspace-edit"
    LSP_WS_ROUTE = "/ws/lsp"
    TRASH_DIR = PlatformPaths.user_trash_dir()
    API_STATS_ROUTE = "/api/stats"
    RG_BIN = PlatformPaths.resolve_binary(PlatformPaths.ENV_RG_BIN, "rg")
    SEARCH_MAX_RESULTS = 400
    SEARCH_TIMEOUT_SECONDS = 15.0
    STALE_TERMINAL_AGE_SECONDS = 24 * 60 * 60
    TERMINAL_SEARCH_MAX_QUERY = 200
    TERMINAL_SEARCH_MAX_SNIPPETS = 6
    TERMINAL_SEARCH_SNIPPET_CHARS = 180
    HISTORY_INDEX_FILE = DATA_DIR / "history-index.sqlite3"
    FILE_HISTORY_DATABASE = DATA_DIR / "file-history.sqlite3"
    FILE_HISTORY_MAX_VERSIONS_PER_FILE = 100
    FILE_HISTORY_MAX_BYTES = 512 * 1024 * 1024
    FILE_HISTORY_COALESCE_SECONDS = 10
    WORKTREES_DIR = DATA_DIR / "worktrees"
    WORKTREE_REGISTRY_FILE = DATA_DIR / "worktrees.json"
    PS_BIN = PlatformPaths.resolve_binary(PlatformPaths.ENV_PS_BIN, "ps")
    FILE_ACCESS_ROOT = PlatformPaths.env_directory(PlatformPaths.ENV_FILE_ROOT, Path.home())
    FILE_READ_MAX_BYTES = 2_000_000
    FILE_LIST_MAX_ENTRIES = 2000
    RECENT_FILES_MAX_ENTRIES = 40
    RECENT_FILES_MAX_SCAN = 20000
    RECENT_FILES_IGNORED_DIRS = frozenset({
        ".git", ".hg", ".svn", ".venv", "venv", "node_modules", "__pycache__",
        ".mypy_cache", ".pytest_cache", ".ruff_cache", ".tox", "dist", "build",
    })
    RECENT_FILES_IGNORED_NAMES = frozenset({".DS_Store"})
    WS_ROUTE = "/ws/{session_id}"
    STATUS_WS_ROUTE = "/ws/status"
    FILE_TREE_WS_ROUTE = "/ws/files"
    FILE_TREE_WS_HEARTBEAT_SECONDS = 15.0
    TRANSCRIPT_WS_ROUTE = "/ws/transcript/{session_id}"
    WS_CODE_UNKNOWN_SESSION = 4404
    DEFAULT_CWD = PlatformPaths.env_directory(PlatformPaths.ENV_DEFAULT_CWD, Path.home())
    SHELL = PlatformPaths.login_shell()
    SHELL_INTERACTIVE_ARGS = ("-il",)
    SHELL_COMMAND_ARGS = ("-ilc",)
    DTACH_BIN = PlatformPaths.resolve_binary(PlatformPaths.ENV_DTACH_BIN, "dtach")
    DTACH_DIR = DATA_DIR / "dtach"
    DTACH_SOCKET_SUFFIX = ".sock"
    DTACH_ARGS = ("-E", "-z", "-r", "winch")
    TERM_ENV_KEY = "TERM"
    TERM_ENV_VALUE = "xterm-256color"
    COLORTERM_ENV_KEY = "COLORTERM"
    COLORTERM_ENV_VALUE = "truecolor"
    LANG_ENV_KEY = "LANG"
    LANG_ENV_VALUE = "en_US.UTF-8"
    SESSION_ID_ENV_KEY = "TERMDECK_SESSION_ID"
    SESSION_NAME_ENV_KEY = "TERMDECK_SESSION_NAME"
    SESSION_PROJECT_ENV_KEY = "TERMDECK_PROJECT"
    SESSION_CWD_ENV_KEY = "TERMDECK_CWD"
    SCRUBBED_ENV_PREFIX = "CLAUDE"
    INITIAL_COLS = 120
    # Tall-terminal-probe worktree only: real TermDeck uses 32. Every new claude/codex/zsh session in
    # THIS worktree spawns at this height from the very first byte (see the matching FitAddon override
    # near the top of app.js), so there is no window where the pty is briefly the normal fitted height
    # before something resizes it -- the CLI never sees anything but tall.
    # An agent whose renderer cannot survive a tall screen overrides this via AgentCli.max_terminal_rows.
    INITIAL_ROWS = 1000
    SCROLLBACK_BYTES = 12_000_000
    SYNC_UPDATE_START = b"\x1b[?2026h"
    SYNC_UPDATE_END = b"\x1b[?2026l"
    SCREEN_REPAINT_REATTACH_DELAY_SECONDS = 0.2
    SCREEN_REPAINT_CLIENT_ATTACH_DELAY_SECONDS = 0.35
    SCREEN_REPAINT_NUDGE_HOLD_SECONDS = 0.08
    SCREEN_REPAINT_ACTIVITY_SUPPRESSION_SECONDS = 1.5
    SCREEN_REPAINT_NUDGE_MIN_COLS = 20
    PTY_READ_CHUNK = 65536
    KILL_GRACE_POLLS = 30
    KILL_GRACE_POLL_SECONDS = 0.1
    EXIT_CODE_SPAWN_FAILED = -1
    AGENT_DETECT_INITIAL_DELAY_SECONDS = 3.0
    AGENT_DETECT_STARTUP_TIMEOUT_SECONDS = 60.0
    AGENT_DETECT_INPUT_DEBOUNCE_SECONDS = 2.0
    AGENT_TRANSCRIPT_ACTIVITY_DEBOUNCE_SECONDS = 0.75
    AGENT_DIR_CLAIM_INPUT_WINDOW_SECONDS = 20.0
    TASK_RESULT_MAX_WAIT_SECONDS = 300.0
    PGREP_BIN = PlatformPaths.resolve_binary(PlatformPaths.ENV_PGREP_BIN, "pgrep")
    LSOF_BIN = PlatformPaths.resolve_binary(PlatformPaths.ENV_LSOF_BIN, "lsof")
    SUBPROCESS_TIMEOUT_SECONDS = 10.0
    DRAFT_MAX_CHARS = 20000
    TERMINAL_BATCH_MAX_ITEMS = 32
    DRAFT_PERSIST_DEBOUNCE_SECONDS = 2.0
    DRAFT_REPLAY_DELAY_AGENT_SECONDS = 4.0
    DRAFT_REPLAY_DELAY_SHELL_SECONDS = 1.5
    PROMPT_SUBMIT_KEY_DELAY_SECONDS = 0.08
    PROMPT_AGENT_STARTUP_DELAY_SECONDS = 2.0
    PROMPT_AGENT_READY_TIMEOUT_SECONDS = 12.0
    FORK_RENAME_READY_DELAY_SECONDS = 1.5
    FORK_RENAME_SUBMIT_DELAY_SECONDS = 0.2
    BRACKETED_PASTE_START = b"\x1b[200~"
    BRACKETED_PASTE_END = b"\x1b[201~"
    OSC_COLOR_QUERY_RESPONSES: tuple[tuple[bytes, bytes], ...] = (
        (b"\x1b]10;?\x07", b"\x1b]10;rgb:d8d8/dede/e9e9\x07"),
        (b"\x1b]10;?\x1b\\", b"\x1b]10;rgb:d8d8/dede/e9e9\x1b\\"),
        (b"\x1b]11;?\x07", b"\x1b]11;rgb:0a0a/0c0c/1010\x07"),
        (b"\x1b]11;?\x1b\\", b"\x1b]11;rgb:0a0a/0c0c/1010\x1b\\"),
    )
    OSC_QUERY_CARRY_MAX = 8
    SPAWN_BANNER_TEMPLATE = "\x1b[2m[termdeck] spawn: {command}\x1b[0m\r\n"
    RESPAWN_DIVIDER = "\x1b[2m──────────── restarted ────────────\x1b[0m"
    REATTACH_DIVIDER = "\x1b[2m──────────── reconnected (kept running) ────────────\x1b[0m"
    SPAWN_ERROR_TEMPLATE = "\x1b[31m[termdeck] spawn failed: {error}\x1b[0m\r\n"
    UVICORN_LOG_LEVEL = PlatformPaths.env_text(PlatformPaths.ENV_LOG_LEVEL, "info")
    # Without a bound, uvicorn's graceful shutdown waits forever for connections that never end -- every
    # terminal stream is an open websocket, and _pump_queue_to_client awaits its queue in a `while True`.
    # The result is a server that answers SIGTERM by releasing its port and then living on indefinitely:
    # `kill <pid>` leaves an orphan holding its memory, and the state-recovery restart (which signals
    # itself with SIGTERM) never comes back up.
    UVICORN_GRACEFUL_SHUTDOWN_SECONDS = 5
    REMOTE_SERVICE_URL = PlatformPaths.env_text(
        PlatformPaths.ENV_REMOTE_URL, "https://termdeck-remote-298065490746.us-central1.run.app")
    REMOTE_PUBLIC_URL = PlatformPaths.env_text(
        PlatformPaths.ENV_REMOTE_PUBLIC_URL, "https://remote.termdeck.workers.dev")
    REMOTE_PAIR_POLL_SECONDS = 2.0
    REMOTE_PAIR_TIMEOUT_SECONDS = 600.0
    REMOTE_RECONNECT_MIN_SECONDS = 1.0
    REMOTE_RECONNECT_MAX_SECONDS = 20.0
    REMOTE_HTTP_TIMEOUT_SECONDS = 60.0
    REMOTE_DEMAND_POLL_SECONDS = 5.0
