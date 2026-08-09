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
    DATA_DIR = PlatformPaths.env_directory(PlatformPaths.ENV_DATA_DIR, PlatformPaths.default_data_dir())
    SESSIONS_FILE = DATA_DIR / "sessions.json"
    SETTINGS_FILE = DATA_DIR / "settings.json"
    CLOSED_SESSIONS_FILE = DATA_DIR / "closed_sessions.json"
    CLOSED_HISTORY_MAX = 100
    PROJECTS_FILE = DATA_DIR / "projects.json"
    SCROLLBACK_DIR = DATA_DIR / "scrollback"
    SCROLLBACK_SUFFIX = ".bin"
    UPLOADS_DIR = DATA_DIR / "uploads"
    API_UPLOAD_ROUTE = "/api/upload"
    UPLOAD_MAX_BYTES = 30_000_000
    UPLOAD_FALLBACK_NAME = "pasted"
    PROJECT_FALLBACK_SLUG = "project"
    API_PROJECTS_ROUTE = "/api/projects"
    API_PROJECT_FOLDER_PICKER_ROUTE = "/api/projects/pick-folder"
    PROJECT_PAGE_ROUTE = "/p/{project_name}"
    STATIC_DIR = Path(__file__).resolve().parent / "static"
    INDEX_FILE = "index.html"
    STATIC_ROUTE = "/static"
    STATIC_NAME = "static"
    API_SESSIONS_ROUTE = "/api/sessions"
    API_TERMINAL_TASK_ROUTE = "/api/terminals/task"
    API_TERMINAL_TASK_PROMPT_ROUTE = "/api/terminals/task/{session_id}/prompt"
    API_TERMINALS_BATCH_ROUTE = "/api/terminals/batch"
    API_SESSION_ROUTE = "/api/sessions/{session_id}"
    API_SESSION_TASK_STATUS_ROUTE = "/api/sessions/{session_id}/task"
    API_SESSION_TASK_RESULT_ROUTE = "/api/sessions/{session_id}/task-result"
    API_SESSION_LAST_TURN_ROUTE = "/api/sessions/{session_id}/last_turn"
    API_SESSION_PROMPT_ROUTE = "/api/sessions/{session_id}/prompt"
    API_SESSION_RESTART_ROUTE = "/api/sessions/{session_id}/restart"
    API_SESSION_FORK_ROUTE = "/api/sessions/{session_id}/fork"
    API_SESSION_RENAME_ROUTE = "/api/sessions/{session_id}/rename"
    API_SESSION_PROJECT_ROUTE = "/api/sessions/{session_id}/project"
    API_SESSION_HISTORY_ROUTE = "/api/sessions/{session_id}/history"
    API_SESSION_HISTORY_PAGE_ROUTE = "/api/sessions/{session_id}/history-page"
    API_KILL_ALL_TERMINALS_ROUTE = "/api/terminals/kill-all"
    API_TERMINAL_PROCESSES_ROUTE = "/api/terminals/processes"
    API_RECLAIM_ORPHAN_TERMINALS_ROUTE = "/api/terminals/reclaim-orphans"
    API_TERMINAL_LAYOUT_ROUTE = "/api/terminal-layout"
    API_TERMINAL_SEARCH_ROUTE = "/api/terminal-search"
    API_HISTORY_SEARCH_ROUTE = "/api/history-search"
    API_HISTORY_CONTEXT_ROUTE = "/api/history-context"
    API_SETTINGS_ROUTE = "/api/settings"
    API_NOTEBOOK_TRASH_ROUTE = "/api/notebook/trash"
    API_CLOSED_ROUTE = "/api/closed"
    API_CLOSED_ITEM_ROUTE = "/api/closed/{session_id}"
    API_CLOSED_REOPEN_ROUTE = "/api/closed/{session_id}/reopen"
    API_FILE_LIST_ROUTE = "/api/files/list"
    API_FILE_RECENT_ROUTE = "/api/files/recent"
    API_FILE_READ_ROUTE = "/api/files/read"
    API_FILE_SEARCH_ROUTE = "/api/files/search"
    API_FILE_FIND_ROUTE = "/api/files/find"
    API_FILE_WRITE_ROUTE = "/api/files/write"
    API_FILE_HISTORY_ROUTE = "/api/files/history"
    API_FILE_HISTORY_VERSION_ROUTE = "/api/files/history/{version_id}"
    API_FILE_HISTORY_RESTORE_ROUTE = "/api/files/history/restore"
    API_FILE_GIT_HISTORY_ROUTE = "/api/files/git-history"
    API_FILE_GIT_HISTORY_VERSION_ROUTE = "/api/files/git-history/{commit_id}"
    API_FILE_REPLACE_ROUTE = "/api/files/replace"
    REPLACE_MAX_FILES = 200
    FIND_MAX_RESULTS = 200
    API_FILE_RENAME_ROUTE = "/api/files/rename"
    API_FILE_MOVE_ROUTE = "/api/files/move"
    API_FILE_DELETE_ROUTE = "/api/files/delete"
    TRASH_DIR = PlatformPaths.user_trash_dir()
    API_STATS_ROUTE = "/api/stats"
    RG_BIN = PlatformPaths.resolve_binary(PlatformPaths.ENV_RG_BIN, "rg")
    SEARCH_MAX_RESULTS = 400
    SEARCH_TIMEOUT_SECONDS = 15.0
    TERMINAL_SEARCH_MAX_QUERY = 200
    TERMINAL_SEARCH_MAX_SNIPPETS = 6
    TERMINAL_SEARCH_SNIPPET_CHARS = 180
    HISTORY_INDEX_FILE = DATA_DIR / "history-index.sqlite3"
    FILE_HISTORY_DATABASE = DATA_DIR / "file-history.sqlite3"
    FILE_HISTORY_MAX_VERSIONS_PER_FILE = 100
    FILE_HISTORY_MAX_BYTES = 512 * 1024 * 1024
    FILE_HISTORY_COALESCE_SECONDS = 10
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
    INITIAL_ROWS = 32
    SCROLLBACK_BYTES = 12_000_000
    SYNC_UPDATE_START = b"\x1b[?2026h"
    SYNC_UPDATE_END = b"\x1b[?2026l"
    SCREEN_REPAINT_REATTACH_DELAY_SECONDS = 0.2
    SCREEN_REPAINT_CLIENT_ATTACH_DELAY_SECONDS = 0.35
    SCREEN_REPAINT_NUDGE_HOLD_SECONDS = 0.08
    SCREEN_REPAINT_NUDGE_MIN_COLS = 20
    PTY_READ_CHUNK = 65536
    KILL_GRACE_POLLS = 30
    KILL_GRACE_POLL_SECONDS = 0.1
    EXIT_CODE_SPAWN_FAILED = -1
    CLAUDE_PROJECTS_DIR = Path.home() / ".claude" / "projects"
    CODEX_SESSIONS_DIR = Path.home() / ".codex" / "sessions"
    AGY_SESSIONS_DIR = Path.home() / ".gemini" / "antigravity-cli" / "brain"
    JSONL_GLOB = "*.jsonl"
    CODEX_DAY_DIR_LOOKAROUND_DAYS = (-1, 0, 1)
    AGENT_DETECT_INITIAL_DELAY_SECONDS = 3.0
    AGENT_DETECT_INPUT_DEBOUNCE_SECONDS = 2.0
    AGENT_TRANSCRIPT_ACTIVITY_DEBOUNCE_SECONDS = 0.75
    AGENT_DIR_CLAIM_INPUT_WINDOW_SECONDS = 20.0
    AGY_ACTIVITY_KEEPALIVE_SECONDS = 20.0
    TASK_RESULT_MAX_WAIT_SECONDS = 300.0
    PGREP_BIN = PlatformPaths.resolve_binary(PlatformPaths.ENV_PGREP_BIN, "pgrep")
    LSOF_BIN = PlatformPaths.resolve_binary(PlatformPaths.ENV_LSOF_BIN, "lsof")
    SUBPROCESS_TIMEOUT_SECONDS = 10.0
    CLAUDE_RESUME_FLAG = "--resume"
    CLAUDE_FORK_FLAG = "--fork-session"
    CODEX_RESUME_TEMPLATE = "codex resume {agent_session_id}"
    CODEX_FORK_TEMPLATE = "codex fork {agent_session_id}"
    CODEX_SESSION_INDEX_FILE = Path.home() / ".codex" / "session_index.jsonl"
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
