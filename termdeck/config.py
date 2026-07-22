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
    CLOSED_HISTORY_MAX = 20
    PROJECTS_FILE = DATA_DIR / "projects.json"
    SCROLLBACK_DIR = DATA_DIR / "scrollback"
    SCROLLBACK_SUFFIX = ".bin"
    UPLOADS_DIR = DATA_DIR / "uploads"
    API_UPLOAD_ROUTE = "/api/upload"
    UPLOAD_MAX_BYTES = 30_000_000
    UPLOAD_FALLBACK_NAME = "pasted"
    PROJECT_FALLBACK_SLUG = "project"
    API_PROJECTS_ROUTE = "/api/projects"
    PROJECT_PAGE_ROUTE = "/p/{project_name}"
    STATIC_DIR = Path(__file__).resolve().parent / "static"
    INDEX_FILE = "index.html"
    STATIC_ROUTE = "/static"
    STATIC_NAME = "static"
    API_SESSIONS_ROUTE = "/api/sessions"
    API_SESSION_ROUTE = "/api/sessions/{session_id}"
    API_SESSION_RESTART_ROUTE = "/api/sessions/{session_id}/restart"
    API_SESSION_FORK_ROUTE = "/api/sessions/{session_id}/fork"
    API_SESSION_RENAME_ROUTE = "/api/sessions/{session_id}/rename"
    API_SESSION_HISTORY_ROUTE = "/api/sessions/{session_id}/history"
    API_SETTINGS_ROUTE = "/api/settings"
    API_CLOSED_ROUTE = "/api/closed"
    API_CLOSED_ITEM_ROUTE = "/api/closed/{session_id}"
    API_CLOSED_REOPEN_ROUTE = "/api/closed/{session_id}/reopen"
    API_FILE_LIST_ROUTE = "/api/files/list"
    API_FILE_RECENT_ROUTE = "/api/files/recent"
    API_FILE_READ_ROUTE = "/api/files/read"
    API_FILE_SEARCH_ROUTE = "/api/files/search"
    API_FILE_FIND_ROUTE = "/api/files/find"
    API_FILE_WRITE_ROUTE = "/api/files/write"
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
    SCRUBBED_ENV_PREFIX = "CLAUDE"
    INITIAL_COLS = 120
    INITIAL_ROWS = 32
    SCROLLBACK_BYTES = 12_000_000
    SYNC_UPDATE_START = b"\x1b[?2026h"
    SYNC_UPDATE_END = b"\x1b[?2026l"
    PTY_READ_CHUNK = 65536
    KILL_GRACE_POLLS = 30
    KILL_GRACE_POLL_SECONDS = 0.1
    EXIT_CODE_SPAWN_FAILED = -1
    CLAUDE_PROJECTS_DIR = Path.home() / ".claude" / "projects"
    CODEX_SESSIONS_DIR = Path.home() / ".codex" / "sessions"
    JSONL_GLOB = "*.jsonl"
    CODEX_DAY_DIR_LOOKAROUND_DAYS = (-1, 0, 1)
    AGENT_DETECT_INITIAL_DELAY_SECONDS = 3.0
    AGENT_DETECT_INPUT_DEBOUNCE_SECONDS = 2.0
    AGENT_DIR_CLAIM_INPUT_WINDOW_SECONDS = 20.0
    PGREP_BIN = PlatformPaths.resolve_binary(PlatformPaths.ENV_PGREP_BIN, "pgrep")
    LSOF_BIN = PlatformPaths.resolve_binary(PlatformPaths.ENV_LSOF_BIN, "lsof")
    SUBPROCESS_TIMEOUT_SECONDS = 10.0
    CLAUDE_RESUME_FLAG = "--resume"
    CLAUDE_FORK_FLAG = "--fork-session"
    CODEX_RESUME_TEMPLATE = "codex resume {agent_session_id}"
    CODEX_FORK_TEMPLATE = "codex fork {agent_session_id}"
    CODEX_SESSION_INDEX_FILE = Path.home() / ".codex" / "session_index.jsonl"
    DRAFT_MAX_CHARS = 20000
    DRAFT_PERSIST_DEBOUNCE_SECONDS = 2.0
    DRAFT_REPLAY_DELAY_AGENT_SECONDS = 4.0
    DRAFT_REPLAY_DELAY_SHELL_SECONDS = 1.5
    PROMPT_SUBMIT_KEY_DELAY_SECONDS = 0.08
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
