// Status/title/processing changes arrive through /ws/status. This slower
// fallback only reconciles session-list metadata such as created/closed tabs.
const SESSION_LIST_REFRESH_MS = 30000;
const TITLE_STATUS_RE = /^[\u2800-\u28ff○-◗⏳⚡✳](\s+)/;
// Same status glyphs as TITLE_STATUS_RE, plus the leading ellipsis codex shows while working. Used only
// when GENERATING a new fork's name, never for display: a fork is seeded from the parent's live title,
// so one surviving glyph per generation compounds into names like "✳ ✳ ◐ ✳ ✳ name fork 1 1 1". Display
// keeps using TITLE_STATUS_RE so a rendered name still matches the title the session is stored under.
const TITLE_STATUS_PREFIX_RE = /^(?:[⠀-⣿○-◗⏳⚡✳]|\.\.\.|…)\s*/;
const RECONNECT_MS = 1500;
const TERMINAL_ATTACH_ACTIVITY_SUPPRESSION_MS = 1800;
const DEFAULT_COMMAND = "codex";
const DEFAULT_CWD = "~";
const TERMINAL_ICON_AGENT_KINDS = ["codex", "claude", "agy", "none"];
const TERMINAL_ICON_AGENT_LABELS = { codex: "Codex", claude: "Claude", agy: "AGY", none: "Shell" };
const SETTINGS_DEFAULTS = { sidebar_width: 250, files_width: 380, sidebar_font_size: 18, project_font_size: 18, terminal_font_size: 18,
  ui_font_size: 11, files_tab_font_size: 11, code_font_size: 12, diff_font_size: 13, tree_font_size: 12, bottom_font_size: 14, active_session_id: "", open_files: [], project_state: {}, theme: "dark",
  ignored_dirs: [], hide_excluded: true, hide_dot_folders: true, file_tree_sort: "name", side_split: 0.55, side_full: false, side_split_user_set: false, show_stats: true,
  show_mtime: true, show_git_status: true, word_wrap: false, search_glob: "!*.json, !*.csv, !*.log", tree_file_glob: "", search_file_glob: "", excluded_file_glob: "!.*, !*.json, !*.csv, !*.log", keybindings: {},
  last_command: "codex", last_model: "codex", last_permissions: { codex: "default", claude: "default", agy: "default", none: "default" },
  show_terminal_icons: false, terminal_icon_agents: { codex: false, claude: false, agy: false, none: false }, terminal_icon_size: 14, history_mode: false, transcript_first_surface: "terminal", attach_repaint: true, inline_size_controls: false, notebook_open: false, notebook_left: -1, notebook_text: "", prompt_history: {}, md_prompt_queues: {}, selection_copy_history: [],
  notebook_notes: [], notebook_active_note_id: "", notebook_notes_initialized: false, md_prompt_drafts: {},
  files_pinned: false, show_terminal_age: true, sidebar_text_color: "#d5dbe5", vscode_keybindings: {},
  search_scope: "project", recent_closed_files: [], worktree_ui_state: {}, selected_worktrees: {},
  files_side_panel_last_tab: "project", file_search_history: [], files_panel_width_initialized: false,
  file_tab_max_visible: 20, file_tab_order: "opened", lsp_enabled: true, lsp_command_overrides: {} };
const MODEL_PERMISSIONS = {
  codex: [
    { value: "default", label: "Default (Codex config)" },
    { value: "read-only", label: "Read only" },
    { value: "workspace-write", label: "Workspace write" },
    { value: "full-access", label: "Full access" },
  ],
  claude: [
    { value: "default", label: "Default (Claude config)" },
    { value: "accept-edits", label: "Accept edits" },
    { value: "auto", label: "Auto" },
    { value: "full-access", label: "Full access" },
  ],
  agy: [
    { value: "default", label: "Default" },
    { value: "full-access", label: "Full access" },
  ],
  none: [{ value: "default", label: "Shell permissions" }],
};
const SEARCH_DEBOUNCE_MS = 500;
const TERMINAL_SEARCH_DEBOUNCE_MS = 700;
const TERMINAL_FIND_HIGHLIGHT_LIMIT = 2000;
const TERMINAL_FIND_DECORATIONS = Object.freeze({
  matchBackground: "#665000", matchBorder: "#d8ae00", matchOverviewRuler: "#d8ae00",
  activeMatchBackground: "#b85c00", activeMatchBorder: "#ffd166", activeMatchColorOverviewRuler: "#ff9f1c",
});
// Find reveals its hit with term.select(), so what the user actually sees is the ordinary SELECTION
// color -- theme selectionBackground, #3b4252, a dark slate barely a shade off the terminal background
// (confirmed by reading the painted .xterm-selection divs: rgb(59,66,82)). The decoration palette above
// never reaches the screen at all here, because nothing calls the search addon's own find methods
// (measured: zero .xterm-decoration elements while a match was highlighted). Borrowing the active-match
// orange from that palette for the selection keeps one consistent find color, and it is applied as a
// THEME override rather than CSS so it survives refreshTerminalAppearance and works under the WebGL
// renderer too (CSS could only ever style the DOM renderer's selection layer).
const TERMINAL_FIND_SELECTION_BACKGROUND = TERMINAL_FIND_DECORATIONS.activeMatchBackground;
const TERMINAL_FIND_SELECTION_FOREGROUND = "#ffffff";
// Tall-terminal row budget. WebGL backs the terminal with one drawing buffer sized to the FULL terminal
// in DEVICE pixels, so the real ceiling is MAX_TEXTURE_SIZE / (cellHeight * devicePixelRatio). That dpr
// term is why a row count measured safe on one machine is wrong on another: a retina display needs twice
// the pixels for the same rows. Measured under headless SwiftShader (MAX_TEXTURE_SIZE 8192, 21px cell,
// dpr 1) the ceiling is 390 rows; a real GPU usually reports 16384, which lands at ~390 again at dpr 2
// and ~780 at dpr 1. Querying both at runtime is the only way to claim the tallest terminal the machine
// in front of us can actually back, instead of hardcoding a guess -- and it degrades to DOM by itself on
// a GPU too small to matter.
const TALL_ROWS_DOM = 1000;
// Renderer choice for the tall terminal, deliberately a code flag rather than a setting: DOM is good
// enough today and the settings surface is already crowded. WebGL is not a straight upgrade here -- it
// backs the terminal with one drawing buffer sized to the FULL terminal in device pixels, so
// MAX_TEXTURE_SIZE caps it near 390 rows on this hardware, against 1000 for DOM, which has no such
// limit. Flip to true to explore that trade again; tallRowPlan then sizes the terminal to whatever the
// GPU can actually back.
const TALL_WEBGL_ENABLED = false;
const TALL_ROWS_MIN_FOR_WEBGL = 120;
// How close to the ceiling still counts as "at the bottom". Deliberately tiny: a row's worth of slack
// was enough to swallow a slow scroll whole -- nudging up a few pixels still measured as "at the bottom",
// so the settle handler turned following back on and pulled the view straight back down, and only a fast
// gesture (one that cleared the slack in a single step) could escape. Nothing needs the slack: every way
// of arriving at the bottom lands on the ceiling exactly, because the clamp puts it there.
const TALL_BOTTOM_TOLERANCE_PX = 2;
// How long after the last scroll event a gesture is still considered in progress, and how long of a
// quiet period settles it. Both cover a scrollbar drag pausing mid-gesture without ending it.
const TALL_SCROLL_ACTIVE_MS = 250;
const TALL_SCROLL_SETTLE_MS = 150;
// A scroll event caused by our own write lands within a frame or two of it.
const TALL_PROGRAMMATIC_ECHO_MS = 48;
// How far the view may sit below the ceiling before a write treats it as "the user moved this", without
// waiting for the scroll event to say so. Several rows: the browser's own focus scroll-into-view nudges
// by a pixel or two, which must NOT count, while any real gesture clears this immediately.
const TALL_FOLLOW_BREAK_PX = 60;
// Overshoot small enough to simply leave alone. The scrollable area is a fixed 1000 rows while the
// content usually ends short of that, so a drag can reach a little past the last line -- on a full canvas
// that is the couple of blank rows below it. Correcting such a small overshoot is worse than allowing it:
// the correction is what the user sees as the view jumping back a line or two after the drag lands.
// Larger overshoots (a sparse terminal, where the empty area is enormous) are still pulled back.
const TALL_OVERSHOOT_DEADZONE_PX = 72;
// How long a smaller content height must persist before the scrollable box actually shrinks. A composer
// redrawing itself reports one row fewer for a frame at a time, and reacting to each dip makes the box
// oscillate; growth is always applied immediately, so nothing is ever unreachable while this waits.
const TALL_SHRINK_SETTLE_MS = 400;
const TALL_ROWS_MAX = 1000;
const HISTORY_BACKGROUND_TARGET_TURNS = 320;
const HISTORY_BACKGROUND_PAGE_TURNS = 160;
const HISTORY_BACKGROUND_LOAD_DELAY_MS = 180;
const SEARCH_HISTORY_STORAGE_KEY = "termdeck.search_history";
const SEARCH_HISTORY_RECORD_DELAY_MS = 3000;
const PROMPT_DRAFT_SYNC_PASTE_DELAY_MS = 250;
const FILE_AUTOSAVE_DELAY_MS = 500;
const SESSION_GROUP_HOVER_DELAY_MS = 700;
const CLOSED_SESSIONS_INITIAL_DISPLAY = 50;
const CLOSED_SESSIONS_MAX_DISPLAY = 100;
const TERMINAL_AGE_REFRESH_MS = 30000;
// A snapshot is hard-wrapped at the width it was taken at, and cannot be rewrapped once written into the
// buffer. A container that has not been laid out yet fits to a handful of columns, and saving then
// poisons the record: the width is stored with it, so a later restore at that same bogus width passes the
// equality check and paints history as an unreadable narrow column beside a full-width screen.
const TERMINAL_AGE_DAY_MS = 24 * 60 * 60 * 1000;
const TERMINAL_AGE_WEEK_MS = 7 * TERMINAL_AGE_DAY_MS;
const TERMINAL_AGE_INTERMEDIATE_FADE = 0.48;
const TERMINAL_GROUP_AGE_BRIGHTNESS = [1, 0.9, 0.8];
const TERMINAL_TAIL_REPAIR_LINES = 16;
const TERMINAL_RENDER_CHECK_INTERVAL_MS = 3000;
const TERMINAL_RENDER_CONFIRM_DELAY_MS = 700;
const TERMINAL_RENDER_REPAIR_COOLDOWN_MS = 10000;
const TERMINAL_ACTIVATION_REFLOW_IDLE_MS = 1200;
const TERMINAL_VIEWPORT_RESTORE_IDLE_MS = 260;
const TERMINAL_VIEWPORT_RESTORE_TIMEOUT_MS = 3000;
const TERMINAL_VIEWPORT_ANCHOR_ROWS = 12;
const TERMINAL_VIEWPORT_ANCHOR_MAX_CHARS = 180;
const TERMINAL_VIEWPORT_ANCHOR_MIN_CHARS = 24;
const TERMINAL_MANUAL_REPAINT_CLICK_WINDOW_MS = 2000;
const OPEN_FILES_MAX_ENTRIES = 80;
const RECENTLY_OPENED_TERMINALS_MAX_ENTRIES = 80;
const TERMINAL_V2_FIT_RETRY_LIMIT = 32;
const TERMINAL_V2_FIT_RETRY_DELAY_MS = 140;
// Three checks, well spread out, not five packed inside the first 600ms: only a genuine geometry change
// sends a pty resize, so a tight burst cannot interrupt an agent CLI's multi-line composer redraw.
const TERMINAL_ACTIVE_SETTLE_DELAYS_MS = [150, 800, 2000];
const CODEX_REFLOW_FOLLOWUP_DELAYS_MS = [1500, 3500, 6000];
const CODEX_REFLOW_FOLLOWUP_BUSY_RETRY_MS = 500;
const CODEX_REFLOW_FOLLOWUP_BUSY_RETRIES = 8;
const TERMINAL_DEBUG_SNAPSHOT_LIMIT = 50;
const SELECTION_SEARCH_MAX_CHARS = 1000;
const SELECTION_ACTION_DELAY_MS = 500;
const IMAGE_ATTACHMENT_MIME_RE = /^image\//i;
const IMAGE_ATTACHMENT_EXTENSION_RE = /\.(?:avif|bmp|gif|heic|jpeg|jpg|png|svg|tif|tiff|webp)$/i;
const MAX_FORK_COUNT = 25;
const TERMINAL_CLAUDE_IDLE_RECONNECT_MS = 5 * 60 * 1000;
const CLAUDE_STATUS_ROW_REFRESH_INTERVAL_MS = 500;
const CODEX_PROMPT_REFLOW_GUARD_MS = 1800;
const AGENT_PASTE_RETRY_DELAY_MS = 250;
const AGENT_PASTE_TIMEOUT_MS = 15000;
const CLAUDE_AGENT_PASTE_DELAY_MS = 1500;
const DEFAULT_AGENT_PASTE_DELAY_MS = 250;
const TERMINAL_ATTENTION_ANIMATION_MS = 2600;
const TERMINAL_ATTENTION_TEXT_MARKERS = ["esc to cancel", "tab to amend"];
const KEYBOARD_SHORTCUT_SECTIONS = ["Terminal", "Files", "General"];
// Files viewer, file search, and terminal search share one files-section panel and one shortcut.
const FILEDECK_DEFAULT_SIDEBAR_WIDTH = 300;
const FILES_SIDE_PANEL_TABS = ["project", "search", "git"];
const CLOSED_SIDE_VIEW = "closed";
const ALL_WORKTREES_ID = "all";
const FILES_SIDE_PANEL_LAST_TAB_KEY = "termdeck.files_panel_last_tab";
const CLIENT_PLATFORM = String(globalThis.navigator?.userAgentData?.platform || globalThis.navigator?.platform || globalThis.navigator?.userAgent || "").toLowerCase();
const IS_MAC_KEYBOARD_PLATFORM = /mac|iphone|ipad|ipod/.test(CLIENT_PLATFORM);
const PRIMARY_MODIFIER_DISPLAY = IS_MAC_KEYBOARD_PLATFORM ? "⌘" : "Ctrl";
const DESKTOP_KEYBINDINGS = [
  { id: "new-terminal", label: "New terminal", def: "Meta+b", section: "Terminal" },
  { id: "new-project", label: "New project", def: "Alt+Shift+s", section: "General" },
  { id: "new-worktree", label: "New worktree", def: "Alt+Shift+w", section: "General" },
  { id: "close-item", label: "Close active terminal / file", def: "Meta+Shift+Backspace", section: "General" },
  { id: "fork-terminal", label: "Fork active terminal", def: "Meta+Shift+b", section: "Terminal" },
  { id: "restart-terminal", label: "Restart active terminal", def: "Meta+Alt+r", section: "Terminal" },
  { id: "restore-last-closed-terminal", label: "Restore last closed terminal", def: "Alt+Shift+t", section: "Terminal" },
  { id: "resync-terminal", label: "Resync active terminal content", def: "Alt+Shift+r", section: "Terminal" },
  { id: "rename-terminal", label: "Rename active terminal", def: "Alt+r", section: "Terminal" },
  { id: "copy-session-id", label: "Copy active session id", def: "Alt+i", section: "Terminal" },
  { id: "mark-terminal-unread", label: "Mark active terminal as unread", def: "Alt+u", section: "Terminal" },
  { id: "create-terminal-group-from-active", label: "Create group from active terminal", def: "Alt+Shift+g", section: "Terminal" },
  { id: "move-active-to-top", label: "Move active terminal / group to top", def: "Alt+t", section: "Terminal" },
  { id: "open-move-menu", label: "Open active terminal Move to menu", def: "Alt+m", section: "Terminal" },
  { id: "undo-terminal-edit", label: "Undo terminal composer edit", def: "Meta+z", section: "Terminal" },
  { id: "open-terminal-new-tab", label: "Open active terminal in a new browser tab", def: "Meta+Alt+o", section: "Terminal" },
  { id: "save-file", label: "Save open file", def: "Meta+s", section: "Files" },
  { id: "prev-terminal", label: "Previous terminal", def: "Meta+Alt+ArrowUp", section: "Terminal" },
  { id: "next-terminal", label: "Next terminal", def: "Meta+Alt+ArrowDown", section: "Terminal" },
  { id: "cycle-side-panel", label: "Files / Search / Git (4th press closes)", def: "Meta+Shift+e", section: "Files" },
  { id: "open-files-panel", label: "Open files panel", def: "Meta+Shift+d", section: "Files" },
  { id: "open-file-search", label: "Open file-content search", def: "Meta+Shift+f", section: "Files" },
  { id: "open-files-new-tab", label: "Open files in a new browser tab", def: "Meta+Alt+d", section: "Files" },
  { id: "open-search-new-tab", label: "Open file search in a new browser tab", def: "Meta+Alt+f", section: "Files" },
  { id: "open-terminal-search", label: "Search terminal names and output", def: "Meta+Shift+s", section: "Terminal" },
  { id: "view-terminals", label: "Terminals view", def: "Meta+Shift+t", section: "Terminal" },
  { id: "switch-project", label: "Switch project", def: "Alt+s", section: "General" },
  { id: "toggle-notebook", label: "Quick notebook", def: "Alt+n", section: "General" },
  { id: "selection-copy", label: "Copy selected terminal / Markdown text", def: "Meta+c", section: "General" },
  { id: "selection-note-new", label: "Create note from selected text", def: "Meta+Alt+n", section: "General" },
  { id: "selection-note-append", label: "Append selected text to note", def: "Meta+Alt+Shift+n", section: "General" },
  { id: "selection-copy-history", label: "Open copied text history", def: "Meta+Shift+v", section: "General" },
  { id: "toggle-history", label: "Switch terminal / Markdown transcript", def: "Alt+g", section: "General" },
  { id: "scroll-bottom", label: "Scroll terminal / transcript to bottom", def: "Meta+Shift+ArrowDown", section: "General" },
  { id: "focus-prompt", label: "Focus active terminal / editor / Markdown prompt", def: "Alt+f", section: "General" },
  { id: "select-active-input", label: "Select active terminal / editor / prompt text", def: "Alt+a", section: "General" },
  { id: "select-terminal-all", label: "Select all terminal text", def: "Meta+Shift+a", section: "Terminal" },
  { id: "recent-terminals", label: "Recently opened terminals", def: "Meta+e", section: "Terminal" },
  { id: "quick-open", label: "Quick Open", def: "Alt+p", section: "Files" },
  { id: "toggle-problems", label: "Problems panel", def: "Alt+Shift+p", section: "Files" },
  { id: "conversation-outline", label: "Conversation outline", def: "Alt+o", section: "General" },
];
const VSCODE_KEYBINDINGS = [
  { id: "new-terminal", label: "New terminal", def: "Ctrl+Alt+b", section: "Terminal" },
  { id: "close-item", label: "Close active terminal", def: "Ctrl+Alt+Backspace", section: "Terminal" },
  { id: "fork-terminal", label: "Fork active terminal", def: "Ctrl+Alt+Shift+b", section: "Terminal" },
  { id: "restart-terminal", label: "Restart active terminal", def: "Ctrl+Alt+Shift+r", section: "Terminal" },
  { id: "restore-last-closed-terminal", label: "Restore last closed terminal", def: "Ctrl+Alt+Shift+t", section: "Terminal" },
  { id: "resync-terminal", label: "Resync active terminal content", def: "Ctrl+Alt+r", section: "Terminal" },
  { id: "prev-terminal", label: "Previous terminal", def: "Ctrl+Alt+ArrowUp", section: "Terminal" },
  { id: "next-terminal", label: "Next terminal", def: "Ctrl+Alt+ArrowDown", section: "Terminal" },
  { id: "open-terminal-new-tab", label: "Open active terminal in a new browser tab", def: "Ctrl+Alt+o", section: "Terminal" },
  { id: "toggle-notebook", label: "Quick notebook", def: "Ctrl+Alt+n", section: "General" },
  { id: "open-files-new-tab", label: "Open files in a new browser tab", def: "Ctrl+Alt+d", section: "Files" },
  { id: "open-search-new-tab", label: "Open file search in a new browser tab", def: "Ctrl+Alt+f", section: "Files" },
  { id: "toggle-history", label: "Switch terminal / Markdown transcript", def: "Ctrl+Alt+m", section: "General" },
  { id: "select-terminal-all", label: "Select all terminal text", def: "Ctrl+Alt+Shift+a", section: "Terminal" },
  { id: "vscode-refresh", label: "Refresh TermDeck", def: "Ctrl+r", section: "General" },
  { id: "vscode-reload", label: "Reload TermDeck webview", def: "Ctrl+Shift+r", section: "General" },
];
const REFERENCE_KEYS = [
  { keys: `${PRIMARY_MODIFIER_DISPLAY}[ / ${PRIMARY_MODIFIER_DISPLAY}]`, label: "Browser back / forward (last-clicked navigation)", section: "General" },
  { keys: IS_MAC_KEYBOARD_PLATFORM ? "⌃⇧F" : "Ctrl+Shift+F", label: "Focus file-content search", section: "Files" },
  { keys: IS_MAC_KEYBOARD_PLATFORM ? "⌃⇧Space" : "Ctrl+Shift+Space", label: "Open file browser/search", section: "Files" },
  { keys: IS_MAC_KEYBOARD_PLATFORM ? "⌃R / ⌃M / ⌘⌫" : "Ctrl+R / Ctrl+M / Ctrl+Backspace", label: "Rename / move / delete selected tree file", section: "Files" },
];
const VSCODE_REFERENCE_KEYS = [
  { keys: IS_MAC_KEYBOARD_PLATFORM ? "⌘⇧P" : "Ctrl+Shift+P", label: "Open VS Code Command Palette", section: "General" },
  { keys: IS_MAC_KEYBOARD_PLATFORM ? "⌘⇧E" : "Ctrl+Shift+E", label: "Open VS Code Explorer", section: "Files" },
  { keys: IS_MAC_KEYBOARD_PLATFORM ? "⌘W" : "Ctrl+W", label: "Close editor tab", section: "General" },
];
function parseModeFlag(raw) {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw === 1;
  const value = String(raw || "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return false;
}
const ALWAYS_EXCLUDED = TermDeckFileBrowser.alwaysExcluded;
const STATS_POLL_MS = 5000;
const STAT_HISTORY_MAX = 48;
const FONT_MIN = 8, FONT_MAX = 32;
const INLINE_SIZE_SETTING_DEFINITIONS = [
  { key: "sidebar_font_size", label: "Terminal list" }, { key: "project_font_size", label: "Project title" },
  { key: "terminal_icon_size", label: "Terminal icons" }, { key: "terminal_font_size", label: "Terminal" },
  { key: "ui_font_size", label: "Status" }, { key: "files_tab_font_size", label: "Files / Search tabs" }, { key: "code_font_size", label: "Code" },
  { key: "bottom_font_size", label: "UI icons / spacing" }, { key: "diff_font_size", label: "Diff" },
  { key: "tree_font_size", label: "Tree / search" },
];
const RECENT_FILES_MIN_REFRESH_MS = 5000;
const RECENT_FILES_EVENT_DEBOUNCE_MS = 2000;
const FILE_TREE_WS_ROUTE = "/ws/files";
const FILE_TREE_CHANGED = "file_tree_changed";
const QUERY_RESPONSE_RE = /^\x1b\[[?>]?[\d;]*[Rc]$/;
const PATH_LINK_RE = /(?:~\/|\.{1,2}\/|\/)?[\w@%+=.-]+(?:\/[\w@%+=.-]+)*\.[A-Za-z][A-Za-z0-9]{0,7}(?::\d+){0,2}/g;
const KNOWN_EXTS = new Set(["py", "md", "json", "js", "ts", "tsx", "css", "html", "sh", "zsh", "txt", "yaml", "yml",
  "toml", "csv", "log", "plist", "sql", "xml", "ini", "cfg", "lock", "ipynb", "rs", "go", "c", "h", "cpp", "hpp", "java"]);
const MATERIAL_ICONS_BASE = "/static/vendor/material-icons/icons/";
const FOLDER_ICON_CLOSED = `${MATERIAL_ICONS_BASE}folder-project.svg`;
const FOLDER_ICON_OPEN = `${MATERIAL_ICONS_BASE}folder-project-open.svg`;
const MATERIAL_ICONS_MAP_URL = "/static/vendor/material-icons/dist/material-icons.json";
const HAS_VSCODE_WEBVIEW_API = typeof acquireVsCodeApi === "function";
const IS_VSCODE_EMBEDDED = window.parent !== window;
const HOST_HINT = String(location.host || "").toLowerCase();
const PATH_HINT = String(location.pathname || "").toLowerCase();
const LOCATION_HINT = String(location.href || "").toLowerCase();
const LOCATION_PARAMS = new URLSearchParams(location.search);
const WORKSPACE_ROOT_QUERY = LOCATION_PARAMS.get("workspace_root") || "";
const IS_PROJECT_NAVIGATION_PATH = /^\/p\/[^/]+\/[^/]+\/.+/.test(location.pathname);
if (location.hash && !IS_PROJECT_NAVIGATION_PATH) {
  const hash = location.hash.replace(/^#/, "");
  for (const [key, value] of new URLSearchParams(hash)) {
    LOCATION_PARAMS.set(key, value);
  }
}
const VS_CODE_PARAM = String(LOCATION_PARAMS.get("vscode") || "").toLowerCase();
const NATIVE_VSCODE_PARAM = String(LOCATION_PARAMS.get("native_terminal") || "").toLowerCase();
const VSCODE_EDITOR_PARAM = String(LOCATION_PARAMS.get("termdeck_editor") || "").toLowerCase();
const VSCODE_EDITOR_MODE = ["1", "true", "yes", "on"].includes(VSCODE_EDITOR_PARAM);
const REFERRER_HINT = String(document.referrer || "").toLowerCase();
const REFERRER_IS_VSCODE = /vscode-(webview|resource)|vscode-(?:assets|file)/.test(REFERRER_HINT) ||
  REFERRER_HINT.includes("vscode-webview://") || REFERRER_HINT.includes("vscode-resource:");
const URL_HINTS_VSCODE = LOCATION_HINT.includes("vscode-webview") ||
  LOCATION_HINT.includes("vscode-resource") || HOST_HINT.includes("vscode-webview") || PATH_HINT.includes("vscode-webview");
const VS_CODE_MODE = HAS_VSCODE_WEBVIEW_API || IS_VSCODE_EMBEDDED || URL_HINTS_VSCODE || (VS_CODE_PARAM &&
  ["1", "true", "yes", "on"].includes(VS_CODE_PARAM)) ||
  (NATIVE_VSCODE_PARAM && ["1", "true", "yes", "on"].includes(NATIVE_VSCODE_PARAM)) ||
  REFERRER_IS_VSCODE;
const NATIVE_VSCODE_MODE = VS_CODE_MODE &&
  (NATIVE_VSCODE_PARAM ? ["1", "true", "yes", "on"].includes(NATIVE_VSCODE_PARAM) : true);
const TERMINAL_TYPE_SVGS = {
  claude: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 1.25c.42 0 .76.34.76.76v4.08l3.53-2.04a.76.76 0 1 1 .76 1.31L9.52 7.4l3.53 2.04a.76.76 0 1 1-.76 1.31L8.76 8.72v4.08a.76.76 0 0 1-1.52 0V8.72l-3.53 2.04a.76.76 0 1 1-.76-1.31L6.48 7.4 2.95 5.36a.76.76 0 1 1 .76-1.31l3.53 2.04V2.01c0-.42.34-.76.76-.76Z"/></svg>',
  codex: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zM3.5988 18.304a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1412-1.6462zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5968 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zm-12.6413 4.1347-2.0201-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805-4.783 2.7582a.7948.7948 0 0 0-.3927.6813zM9.4041 10.4976l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997z"/></svg>',
};
const makeTerminalTheme = (background, foreground, cursor, selectionBackground, ansi) => {
  const [black, red, green, yellow, blue, magenta, cyan, white, brightBlack, brightRed, brightGreen,
    brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite] = ansi;
  return { background, foreground, cursor, selectionBackground,
    selectionInactiveBackground: selectionBackground,
    selectionForeground: foreground, black, red, green, yellow, blue, magenta, cyan, white,
    brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite };
};
const rgbaThemeColor = (color, alpha) => {
  const match = String(color || "").match(/^#([0-9a-f]{6})$/i);
  if (!match) return color;
  const value = Number.parseInt(match[1], 16);
  return `rgba(${value >> 16}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
};
const monacoThemeColor = (color) => {
  const value = String(color || "").trim();
  const hex = value.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i);
  if (hex) return `#${hex[1]}${hex[2] || "ff"}`;
  const rgba = value.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
  if (!rgba) return "#00000000";
  const alpha = Math.round((rgba[4] == null ? 1 : Number(rgba[4])) * 255).toString(16).padStart(2, "0");
  return `#${[rgba[1], rgba[2], rgba[3]].map((channel) => Number(channel).toString(16).padStart(2, "0")).join("")}${alpha}`;
};
const makeTheme = (id, label, kind, colors, ansi, monacoBase = kind === "light" ? "vs" : "vs-dark") => {
  const activeBackground = colors.activeBg || rgbaThemeColor(colors.accent, 0.14);
  const activeBorder = colors.activeBorder || rgbaThemeColor(colors.accent, 0.45);
  const treeSelectedBackground = colors.treeSelectedBg || rgbaThemeColor(colors.accent, 0.17);
  const treeSelectedBorder = colors.treeSelectedBorder || rgbaThemeColor(colors.accent, 0.48);
  const terminalBackground = colors.term || colors.bg;
  const terminalForeground = colors.terminalForeground || colors.text;
  return {
    id, label, kind, monacoBase,
    css: {
      "--bg": colors.bg, "--panel": colors.panel, "--panel2": colors.panel2, "--border": colors.border,
      "--text": colors.text, "--dim": colors.dim, "--accent": colors.accent, "--working-blue": colors.working || colors.accent,
      "--sidebar-text-color": colors.sidebar || colors.text, "--green": colors.green, "--red": colors.red,
      "--term-bg": colors.term || colors.bg, "--term-text": terminalForeground, "--term-blue": ansi[12],
      "--term-cyan": ansi[14], "--term-green": ansi[10], "--term-yellow": ansi[11], "--term-magenta": ansi[13],
      "--scroll-thumb": colors.scroll || colors.border,
      "--scroll-thumb-hover": colors.scrollHover || colors.accent, "--active-bg": activeBackground,
      "--active-border": activeBorder, "--active-text": colors.activeText || colors.text,
      "--tree-selected-bg": treeSelectedBackground, "--tree-selected-border": treeSelectedBorder,
    },
    terminal: makeTerminalTheme(terminalBackground, terminalForeground, colors.cursor || colors.accent,
      colors.selection || activeBorder, ansi),
    monacoColors: {
      "editor.background": monacoThemeColor(colors.monacoBg || terminalBackground), "editor.foreground": monacoThemeColor(colors.text),
      "editorGutter.background": monacoThemeColor(colors.monacoBg || terminalBackground), "editorLineNumber.foreground": monacoThemeColor(colors.dim),
      "editorLineNumber.activeForeground": monacoThemeColor(colors.accent), "editor.selectionBackground": monacoThemeColor(colors.selection || activeBorder),
      "editorCursor.foreground": monacoThemeColor(colors.cursor || colors.accent),
      "editor.lineHighlightBackground": monacoThemeColor(activeBackground), "editor.lineHighlightBorder": monacoThemeColor(activeBorder),
      "editorIndentGuide.background1": monacoThemeColor(colors.border), "editorIndentGuide.activeBackground1": monacoThemeColor(activeBorder),
    },
  };
};
const THEME_DEFINITIONS = [
  makeTheme("dark", "Nord dark", "dark",
    { bg: "#0b0e12", panel: "#12161c", panel2: "#1a2029", border: "#232a35", text: "#d5dbe5", terminalForeground: "#d8dee9", dim: "#7a8494", accent: "#5ccfe6", working: "#83e6ff", green: "#9fe8a2", red: "#f28779", term: "#0a0c10", monacoBg: "#101418", cursor: "#8fbcbb", selection: "#3b4252", scroll: "#2b3440", scrollHover: "#3d4856", activeBg: "rgba(92, 207, 230, 0.13)", activeBorder: "rgba(92, 207, 230, 0.4)", activeText: "#eaf6f9", treeSelectedBg: "rgba(4, 57, 94, 0.55)", treeSelectedBorder: "rgba(0, 122, 204, 0.45)" },
    ["#3b4252", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#88c0d0", "#e5e9f0", "#4c566a", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#8fbcbb", "#eceff4"]),
  makeTheme("nord-vivid", "Nord dark vivid", "dark",
    { bg: "#0b0e12", panel: "#12161c", panel2: "#1a2029", border: "#2c3441", text: "#e2e8f0", terminalForeground: "#e5e9f0", dim: "#929fb3", accent: "#67e8f9", working: "#8befff", green: "#7ee787", red: "#ff6b81", term: "#0a0c10", monacoBg: "#101418", cursor: "#8befff", selection: "#3b4961", scroll: "#344052", scrollHover: "#4b5b72", activeBg: "rgba(103, 232, 249, 0.15)", activeBorder: "rgba(103, 232, 249, 0.48)", activeText: "#f3fbff", treeSelectedBg: "rgba(71, 148, 255, 0.22)", treeSelectedBorder: "rgba(103, 232, 249, 0.52)" },
    ["#3b4252", "#ff6b81", "#7ee787", "#f6c85f", "#82aaff", "#c792ea", "#67e8f9", "#e5e9f0", "#6272a4", "#ff8296", "#9bf6a5", "#ffe08a", "#9bbcff", "#d8a8ff", "#8befff", "#ffffff"]),
  makeTheme("light", "GitHub light", "light",
    { bg: "#f2f4f7", panel: "#ffffff", panel2: "#e9edf2", border: "#d4dbe3", text: "#24292f", terminalForeground: "#1f2328", dim: "#6b7580", accent: "#0969da", green: "#1a7f37", red: "#cf222e", term: "#ffffff", cursor: "#0969da", selection: "#b6d7fb", scroll: "#c7cfd8", scrollHover: "#aab2c0", activeBg: "rgba(9, 105, 218, 0.1)", activeBorder: "rgba(9, 105, 218, 0.35)", activeText: "#0a3069", treeSelectedBg: "rgba(9, 105, 218, 0.12)", treeSelectedBorder: "rgba(9, 105, 218, 0.3)" },
    ["#24292f", "#cf222e", "#116329", "#4d2d00", "#0969da", "#8250df", "#1b7c83", "#6e7781", "#57606a", "#a40e26", "#1a7f37", "#633c01", "#218bff", "#a475f9", "#3192aa", "#8c959f"]),
  makeTheme("mac-terminal", "macOS terminal", "dark",
    { bg: "#202124", panel: "#292a2d", panel2: "#343539", border: "#484a50", text: "#f1f3f4", dim: "#a9adb5", accent: "#7dd3fc", working: "#86efac", green: "#8bd49c", red: "#ff8a80", term: "#1e1f22", cursor: "#f1f3f4", selection: "#4b5563" },
    ["#303238", "#ff8a80", "#8bd49c", "#ffe082", "#82b1ff", "#cf93d9", "#80cbc4", "#f1f3f4", "#6b7078", "#ff5252", "#69f0ae", "#ffd740", "#448aff", "#e040fb", "#64ffda", "#ffffff"]),
  makeTheme("github-dark", "GitHub dark", "dark",
    { bg: "#0d1117", panel: "#161b22", panel2: "#21262d", border: "#30363d", text: "#c9d1d9", dim: "#8b949e", accent: "#58a6ff", working: "#79c0ff", green: "#7ee787", red: "#ff7b72", term: "#0d1117", cursor: "#58a6ff", selection: "#264f78" },
    ["#484f58", "#ff7b72", "#7ee787", "#d29922", "#58a6ff", "#bc8cff", "#39c5cf", "#b1bac4", "#6e7681", "#ffa198", "#56d364", "#e3b341", "#79c0ff", "#d2a8ff", "#56d4dd", "#f0f6fc"]),
  makeTheme("one-dark", "One Dark", "dark",
    { bg: "#1e2127", panel: "#282c34", panel2: "#313640", border: "#3e4451", text: "#abb2bf", dim: "#7f848e", accent: "#61afef", working: "#56b6c2", green: "#98c379", red: "#e06c75", term: "#1e2127", cursor: "#61afef", selection: "#3e4451" },
    ["#545862", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#abb2bf", "#7f848e", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#ffffff"]),
  makeTheme("monokai", "Monokai", "dark",
    { bg: "#272822", panel: "#2d2e27", panel2: "#3e3d32", border: "#5a594f", text: "#f8f8f2", dim: "#a6a69c", accent: "#a6e22e", working: "#66d9ef", green: "#a6e22e", red: "#f92672", term: "#272822", cursor: "#f8f8f0", selection: "#49483e" },
    ["#272822", "#f92672", "#a6e22e", "#f4bf75", "#66d9ef", "#ae81ff", "#a1efe4", "#f8f8f2", "#75715e", "#f92672", "#a6e22e", "#f4bf75", "#66d9ef", "#ae81ff", "#a1efe4", "#f9f8f5"]),
  makeTheme("dracula", "Dracula", "dark",
    { bg: "#282a36", panel: "#303241", panel2: "#3a3c4e", border: "#4b4d60", text: "#f8f8f2", dim: "#a7a9be", accent: "#bd93f9", working: "#8be9fd", green: "#50fa7b", red: "#ff5555", term: "#282a36", cursor: "#f8f8f2", selection: "#44475a" },
    ["#21222c", "#ff5555", "#50fa7b", "#f1fa8c", "#8be9fd", "#bd93f9", "#8be9fd", "#f8f8f2", "#6272a4", "#ff6e6e", "#69ff94", "#ffffa5", "#a4ffff", "#d6acff", "#a4ffff", "#ffffff"]),
  makeTheme("solarized-dark", "Solarized dark", "dark",
    { bg: "#002b36", panel: "#073642", panel2: "#0b4654", border: "#1b5965", text: "#839496", dim: "#657b83", accent: "#2aa198", working: "#268bd2", green: "#859900", red: "#dc322f", term: "#002b36", cursor: "#2aa198", selection: "#174b55" },
    ["#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5", "#586e75", "#cb4b16", "#b4c342", "#c9a400", "#458bd2", "#d33682", "#2aa198", "#fdf6e3"]),
  makeTheme("solarized-light", "Solarized light", "light",
    { bg: "#fdf6e3", panel: "#eee8d5", panel2: "#e6dfcb", border: "#d8cfb9", text: "#586e75", dim: "#839496", accent: "#268bd2", green: "#859900", red: "#dc322f", term: "#fdf6e3", cursor: "#268bd2", selection: "#c9dff0" },
    ["#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5", "#586e75", "#cb4b16", "#b4c342", "#c9a400", "#458bd2", "#d33682", "#2aa198", "#fdf6e3"]),
  makeTheme("gruvbox-dark", "Gruvbox dark", "dark",
    { bg: "#282828", panel: "#32302f", panel2: "#3c3836", border: "#504945", text: "#ebdbb2", dim: "#a89984", accent: "#83a598", working: "#8ec07c", green: "#b8bb26", red: "#fb4934", term: "#282828", cursor: "#ebdbb2", selection: "#504945" },
    ["#3c3836", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#a89984", "#7c6f64", "#fb4934", "#b8bb26", "#fabd2f", "#83a598", "#d3869b", "#8ec07c", "#ebdbb2"]),
  makeTheme("gruvbox-light", "Gruvbox light", "light",
    { bg: "#fbf1c7", panel: "#f2e5bc", panel2: "#ebdbb2", border: "#d5c4a1", text: "#3c3836", dim: "#7c6f64", accent: "#076678", green: "#79740e", red: "#9d0006", term: "#fbf1c7", cursor: "#076678", selection: "#d5e5e8" },
    ["#3c3836", "#9d0006", "#79740e", "#b57614", "#076678", "#8f3f71", "#427b58", "#7c6f64", "#928374", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#ebdbb2"]),
  makeTheme("tokyo-night", "Tokyo Night", "dark",
    { bg: "#16161e", panel: "#1f2335", panel2: "#292e42", border: "#3b4261", text: "#c0caf5", dim: "#7982a9", accent: "#7aa2f7", working: "#7dcfff", green: "#9ece6a", red: "#f7768e", term: "#16161e", cursor: "#7aa2f7", selection: "#283457" },
    ["#15161e", "#f7768e", "#41a6b5", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#7982a9", "#414868", "#ff7a93", "#73daca", "#ff9e64", "#8db0ff", "#c7a0ff", "#a4daff", "#acb0d0"]),
  makeTheme("catppuccin-mocha", "Catppuccin mocha", "dark",
    { bg: "#11111b", panel: "#181825", panel2: "#313244", border: "#45475a", text: "#cdd6f4", dim: "#9399b2", accent: "#89b4fa", working: "#74c7ec", green: "#a6e3a1", red: "#f38ba8", term: "#11111b", cursor: "#f5e0e6", selection: "#45475a" },
    ["#45475a", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#bac2de", "#585b70", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#a6adc8"]),
  makeTheme("catppuccin-latte", "Catppuccin latte", "light",
    { bg: "#eff1f5", panel: "#e6e9ef", panel2: "#dce0e8", border: "#bcc0cc", text: "#4c4f69", dim: "#7c7f93", accent: "#1e66f5", green: "#40a02b", red: "#d20f39", term: "#eff1f5", cursor: "#1e66f5", selection: "#cbd7f5" },
    ["#5c5f77", "#d20f39", "#40a02b", "#df8e1d", "#1e66f5", "#8839ef", "#179299", "#acb0be", "#6c6f85", "#d20f39", "#40a02b", "#df8e1d", "#1e66f5", "#8839ef", "#179299", "#bcc0cc"]),
  makeTheme("rose-pine", "Rosé Pine", "dark",
    { bg: "#191724", panel: "#1f1d2e", panel2: "#26233a", border: "#403d52", text: "#e0def4", dim: "#908caa", accent: "#c4a7e7", working: "#9ccfd8", green: "#9ccfd8", red: "#eb6f92", term: "#191724", cursor: "#c4a7e7", selection: "#403d52" },
    ["#26233a", "#eb6f92", "#9ccfd8", "#f6c177", "#31748f", "#c4a7e7", "#ebbcba", "#e0def4", "#6e6a86", "#eb6f92", "#9ccfd8", "#f6c177", "#31748f", "#c4a7e7", "#ebbcba", "#e0def4"]),
  makeTheme("ayu-dark", "Ayu dark", "dark",
    { bg: "#0b0e14", panel: "#11151c", panel2: "#1b212b", border: "#303846", text: "#bfbdb6", dim: "#7d8799", accent: "#e6b450", working: "#59c2ff", green: "#aad94c", red: "#f07178", term: "#0b0e14", cursor: "#e6b450", selection: "#273747" },
    ["#0b0e14", "#f07178", "#aad94c", "#e6b450", "#59c2ff", "#d2a6ff", "#95e6cb", "#bfbdb6", "#565b66", "#ff8f8f", "#c2d94c", "#ffb454", "#73d0ff", "#dfbfff", "#a8e6cf", "#f8f8f2"]),
  makeTheme("ayu-light", "Ayu light", "light",
    { bg: "#fafafa", panel: "#f3f4f5", panel2: "#e7e9eb", border: "#cfd3d8", text: "#5c6166", dim: "#8a9199", accent: "#399ee6", green: "#86b300", red: "#ed9366", term: "#fafafa", cursor: "#399ee6", selection: "#cfe8f8" },
    ["#5c6166", "#f07171", "#86b300", "#f2ae49", "#399ee6", "#a37acc", "#4cbf99", "#fafafa", "#8a9199", "#f07171", "#86b300", "#f2ae49", "#399ee6", "#a37acc", "#4cbf99", "#ffffff"]),
  makeTheme("high-contrast", "High contrast", "dark",
    { bg: "#000000", panel: "#080808", panel2: "#171717", border: "#777777", text: "#ffffff", dim: "#c7c7c7", accent: "#00ffff", working: "#ffff00", green: "#00ff66", red: "#ff5555", term: "#000000", cursor: "#ffffff", selection: "#444444" },
    ["#000000", "#ff5555", "#00ff66", "#ffff00", "#55aaff", "#ff55ff", "#00ffff", "#ffffff", "#777777", "#ff7777", "#55ff88", "#ffff77", "#77bbff", "#ff77ff", "#77ffff", "#ffffff"], "hc-black"),
];
const THEME_BY_ID = Object.fromEntries(THEME_DEFINITIONS.map((theme) => [theme.id, theme]));

class TermdeckApp {
  constructor() {
    this.vscodeMode = VS_CODE_MODE;
    this.nativeVscodeMode = NATIVE_VSCODE_MODE;
    this.vscodeEditorMode = VSCODE_EDITOR_MODE;
    this.vscodeWorkspaceRoot = WORKSPACE_ROOT_QUERY || "";
    this.vscodeProjectName = "";
    document.body.classList.toggle("vscode-mode", this.vscodeMode);
    document.body.classList.toggle("vscode-native-mode", this.nativeVscodeMode);
    document.body.classList.toggle("vscode-editor-mode", this.vscodeEditorMode);
    this.hostStatePatched = false;
    this.handleHostMessageBound = this.handleHostMessage.bind(this);
    this.sessions = [];
    this.closedSessions = [];
    this.initialLoadComplete = false;
    this.views = new Map();
    this.openFiles = new Map();
    this.lspClient = null;
    this.openFilesPersistPromise = Promise.resolve();
    this.sidebarSelectedFileKeys = new Set();
    this.sidebarFileSelectionAnchorKey = null;
    this.activeId = null;
    this.activeFileKey = null;
    this.fileHistoryOpen = false;
    this.fileHistoryMode = "local";
    this.fileHistorySelections = [];
    this.fileHistoryVersions = [];
    this.fileHistoryItems = [];
    this.fileHistoryLoadGeneration = 0;
    this.fileHistoryComparisonTimer = 0;
    this.fileHistoryDiffEditor = null;
    this.fileHistoryCurrentEditor = null;
    this.fileHistoryTransientModels = new Set();
    this.fileHistoryActiveComparison = null;
    this.fileHistoryDiffBlocks = [];
    this.fileHistoryDiffBlockIndex = -1;
    this.historyOpen = false;
    this.historyRefreshTimer = 0;
    this.historyLoadBusy = false;
    this.historyWs = null;
    this.historyWsReconnectTimer = 0;
    this.historyStreamSessionId = null;
    this.historySnapshotBuffers = new Map();
    this.historyTurnsBySession = new Map();
    this.historyScrollBySession = new Map();
    this.historyLiveTurnsBySession = new Map();
    this.historyOlderTurnsBySession = new Map();
    this.historyBeforeBySession = new Map();
    this.historyHasMoreBySession = new Map();
    this.historyOlderLoadBusy = false;
    this.historyBackgroundLoadTimer = 0;
    this.historyBackgroundLoadSessionId = "";
    this.historyStreamFresh = false;
    this.historyRevisions = new Map();
    this.historyPendingPrompts = new Map();
    this.historyPendingPromptSequence = 0;
    this.historyFingerprint = "";
    this.historyTurns = [];
    this.historyLoaded = false;
    this.historyEditsCollapsed = false;
    this.closedExpanded = false;
    this.restoreLastClosedTerminalBusy = false;
    this.restoreLastClosedTerminalNeedsConfirmation = false;
    this.closedDisplayLimit = CLOSED_SESSIONS_INITIAL_DISPLAY;
    this.terminalSearchText = "";
    this.terminalSearchEditorOpen = false;
    this.terminalSearchFocusIndex = -1;
    this.sidebarAnimationVisibilityObserver = null;
    this.settings = { ...SETTINGS_DEFAULTS };
    this.persistedSettings = { ...SETTINGS_DEFAULTS };
    this.saveTimer = null;
    this.settingsSavePromise = Promise.resolve();
    this.projectStateSavePromise = Promise.resolve();
    this.treeRoot = null;
    this.treeDirs = new Map();
    this.treeReloadPromise = null;
    this.expandedDirs = new Set();
    this.treePollBusy = false;
    this.treeWs = null;
    this.treeWsRoot = "";
    this.treeWsReconnectTimer = 0;
    this.treeEventRefreshTimer = 0;
    this.treeChangedDirectories = new Set();
    this.treeChangedEntries = new Map();
    this.gitSideGeneration = 0;
    this.gitSideState = null;
    this.recentFiles = [];
    this.recentFilesRoot = null;
    this.recentFilesFingerprint = "";
    this.recentFilesBusy = false;
    this.recentFilesFetchedAt = 0;
    this.recentFilesExpanded = false;
    this.recentFilesWs = null;
    this.recentFilesWsRoot = "";
    this.recentFilesWsReconnectTimer = 0;
    this.recentFilesEventRefreshTimer = 0;
    this.sideView = "terminals";
    this.filesSidePanelCycleView = null;
    this.filesSidePanelCycleTransition = false;
    this.fileTypeFilterMenuMode = "name";
    this.filesPanelWidthInitialized = false;
    const savedFilesTab = localStorage.getItem(FILES_SIDE_PANEL_LAST_TAB_KEY);
    this.lastFilesSidePanelTab = FILES_SIDE_PANEL_TABS.includes(savedFilesTab) ? savedFilesTab : "project";
    this.searchWord = false;
    this.searchCase = false;
    this.searchRegex = false;
    this.nameSearchCase = false;
    this.searchGeneration = 0;
    this.searchHistory = [];
    this.searchHistorySelection = -1;
    this.searchHistoryBackIndex = null;
    this.pendingSearchHistoryState = null;
    this.searchHistoryRecordTimer = 0;
    this.searchSelection = { content: -1, name: -1 };
    this.contentSearchTree = null;
    this.nameSearchTree = null;
    this.treeSearchFilter = null;
    this.terminalSearchMatches = new Map();
    this.terminalSearchClosedMatches = new Map();
    this.terminalTitleSearchResults = [];
    this.historySearchResults = [];
    this.historySearchOperations = false;
    this.terminalSearchGroupSimilar = false;
    this.terminalSearchAbort = null;
    this.terminalSearchTimer = 0;
    this.terminalSearchGroupId = null;
    this.terminalSearchWorktreeId = null;
    this.terminalSearchHoverHideTimer = 0;
    this.pendingHistorySearchNavigation = null;
    this.historySearchNavigationBusy = false;
    this.terminalFindSessionId = "";
    this.terminalFindQuery = "";
    this.terminalFindFallbackMatches = [];
    this.terminalFindFallbackIndex = -1;
    this.nameSearchGeneration = 0;
    this.applyingHistory = false;
    this.lastNavJson = "";
    this.hideInactiveTerminals = false;
    this.sessionActivityAt = new Map();
    this.sessionTitleEls = new Map();
    this.sessionSpinnerEls = new Map();
    this.sessionStatusEls = new Map();
    this.sessionRowEls = new Map();
    this.terminalAgeRefreshTimer = 0;
    this.sessionListSignature = "";
    this.dragGroupTimer = 0;
    this.dragGroupTargetKey = null;
    this.dragGroupHoverKey = null;
    this.sidebarSelectedSessionIds = new Set();
    this.sidebarSelectionAnchorId = null;
    this.contextMenuTarget = null;
    this.modalGroupId = null;
    this.modalAfterSessionId = null;
    this.worktreeReviewSessionId = null;
    this.revealActiveSessionOnLoad = true;
    this.processingStates = new Map();
    this.processingSince = new Map();
    this.attentionSessions = new Set();
    this.attentionTimers = new Map();
    this.attentionServerStates = new Map();
    // A prompt can be accepted by the PTY before the agent reports
    // processing=true. Keep that hand-off visible in Markdown mode.
    this.historyPendingProcessing = new Map();
    this.processingTimer = 0;
    this.pageTitleFaviconState = "plain";
    this.pageFavicon = document.querySelector('link[rel~="icon"]');
    this.pageFaviconHref = this.pageFavicon?.getAttribute("href") || "/static/favicon.svg";
    this.pageFaviconType = this.pageFavicon?.getAttribute("type") || "image/svg+xml";
    this.viewedCompletedSessions = new Set();
    this.unreadSessions = new Set();
    this.statHistory = [];
    this.editor = null;
    this.secondaryEditor = null;
    this.secondaryDiffEditor = null;
    this.secondaryFileKey = null;
    this.fileInspectorMode = null;
    this.fileOutlineTimer = 0;
    this.problemsOpen = false;
    this.problemsRefreshTimer = 0;
    this.quickOpenResults = [];
    this.quickOpenSelection = 0;
    this.quickOpenMode = "all";
    this.quickOpenTimer = 0;
    this.quickOpenGeneration = 0;
    this.conversationOutlineOpen = false;
    this.conversationOutlineSessionId = null;
    this.conversationOutlineTurnsBySession = new Map();
    this.lastSearchFiles = [];
    this.notebookEditor = null;
    this.notebookEditorModels = new Map();
    this.notebookMounted = false;
    this.notebookCopiesOpen = false;
    this.notebookExpandedCopy = null;
    this.notebookSearchIndex = 0;
    this.notebookTitleTimer = 0;
    this.notebookResizePointerId = null;
    this.filesPanelResizePointerId = null;
    this.selectionActionState = null;
    this.selectionCopyHistoryIndex = 0;
    this.selectionActionUpdateFrame = 0;
    this.selectionActionUpdateTimer = 0;
    this.pendingNewAgentSelection = "";
    this.nativeSessionIds = new Set();
    this.sessionModelById = new Map();
    this.selectedTreeRow = null;
    this.iconMap = null;
    this.lastValidNavState = null;
    this.statusWs = null;
    this.statusWsReconnectTimer = 0;
    this.serverInstanceId = "";
    this.serverRestartReloading = false;
    this.remoteIdleTimeoutMs = 0;
    this.remoteIdleLastInteractionAt = 0;
    this.remoteIdleTimer = 0;
    this.remoteIdleTransitioning = false;
    this.remoteBrowserEmail = "";
    this.remoteIdleActivityHandler = () => this.recordRemoteBrowserActivity();
    this.remoteIdleVisibilityHandler = () => this.handleRemoteBrowserVisibilityChange();
    this.layoutFitSettleTimer = 0;
    this.sidebarResizeInProgress = false;
    this.sidebarResizeFinalFitFrame = 0;
    this.activeEditorFocusTimer = 0;
    this.projects = [];
    this.worktrees = [];
    this.worktreeId = "root";
    this.interactionWorktreeId = "root";
    this.renderWorktreeId = null;
    const projectMatch = location.pathname.match(/^\/p\/([^/]+)(?:\/([^/]+))?(?:\/(.*))?$/);
    this.projectSlug = projectMatch ? decodeURIComponent(projectMatch[1])
      : this.vscodeEditorMode ? (LOCATION_PARAMS.get("project") || null) : null;
    this.requestedWorktreeUrlSegment = projectMatch?.[2] ? decodeURIComponent(projectMatch[2]) : "";
    this.requestedNavigationPath = projectMatch?.[3]
      ? projectMatch[3].split("/").map((segment) => decodeURIComponent(segment)).join("/") : "";
    const urlParams = new URLSearchParams(location.search);
    this.worktreeId = String(urlParams.get("wt") || "root").trim() || "root";
    const requestedFileView = ["project", "search", "git"].includes(urlParams.get("view")) ? urlParams.get("view") : "project";
    if (urlParams.get("t")) this.initialNav = { kind: "term", id: urlParams.get("t") };
    else if (urlParams.get("f")) {
      this.initialNav = {
        kind: "open-file",
        key: urlParams.get("f"),
        view: requestedFileView,
        pinned: urlParams.get("pinned") === "1",
        return_to: String(urlParams.get("rt") || "").trim(),
      };
    } else if (["project", "search", "git"].includes(urlParams.get("view"))) {
      this.initialNav = { kind: "files", view: requestedFileView, q: urlParams.get("q") || "", pinned: urlParams.get("pinned") === "1" };
    }
    else if (urlParams.get("q")) {
      this.initialNav = { kind: "search", q: urlParams.get("q"), glob: urlParams.get("glob") || "",
                          word: urlParams.get("w") === "1", case_sensitive: urlParams.get("c") === "1",
                          regex: urlParams.get("re") === "1" };
    } else this.initialNav = this.requestedNavigationPath ? { kind: "path", selector: this.requestedNavigationPath } : null;
    this.$ = (id) => document.getElementById(id);
    this.ensureDesktopTerminalsHeader();
    this.applyVscodeModeLayout();
  }

  projectQuery() {
    if (!this.projectSlug) return "";
    const params = new URLSearchParams({ project: this.projectSlug });
    if (this.worktreeId !== ALL_WORKTREES_ID) params.set("worktree_id", this.worktreeId || "root");
    return `?${params}`;
  }

  worktreeForUrlSegment(segment) {
    const value = String(segment || "").trim();
    if (!value) return null;
    if (value === ALL_WORKTREES_ID) {
      return this.worktrees.filter((worktree) => worktree.available).length > 1
        ? { id: ALL_WORKTREES_ID, branch: ALL_WORKTREES_ID, name: ALL_WORKTREES_ID } : null;
    }
    const exactId = this.worktrees.find((worktree) => worktree.available && worktree.id === value);
    if (exactId) return exactId;
    const branchMatches = this.worktrees.filter((worktree) => worktree.available && String(worktree.branch || "") === value);
    if (branchMatches.length) return branchMatches.length === 1 ? branchMatches[0] : null;
    const nameMatches = this.worktrees.filter((worktree) => worktree.available && String(worktree.name || "") === value);
    return nameMatches.length === 1 ? nameMatches[0] : null;
  }

  worktreeUrlSegment(worktreeId = this.stateWorktreeId()) {
    if (worktreeId === ALL_WORKTREES_ID) return ALL_WORKTREES_ID;
    const worktree = this.worktrees.find((candidate) => candidate.id === (worktreeId || "root"));
    return String(worktree?.branch || worktree?.name || worktreeId || "root");
  }

  encodedProjectWorktreePath(project = this.projectSlug, worktreeId = this.stateWorktreeId()) {
    if (!project) return location.pathname;
    return `/p/${encodeURIComponent(project)}/${encodeURIComponent(this.worktreeUrlSegment(worktreeId))}`;
  }

  encodedRelativeFilePath(path) {
    return String(path || "").split("/").filter(Boolean).map((segment) => encodeURIComponent(segment)).join("/");
  }

  normalizedFileSystemPath(path) {
    const normalized = String(path || "").replaceAll("\\", "/").replace(/\/{2,}/g, "/");
    return normalized.length > 1 ? normalized.replace(/\/$/, "") : normalized;
  }

  relativeNavigationPathForFileKey(key) {
    const separator = String(key || "").indexOf("|");
    if (separator <= 0) return "";
    const worktreeRoot = this.normalizedFileSystemPath(this.worktreeRoot());
    const fileRoot = this.normalizedFileSystemPath(String(key).slice(0, separator));
    const filePath = this.normalizedFileSystemPath(String(key).slice(separator + 1));
    const absoluteFilePath = filePath.startsWith("/") ? filePath : this.normalizedFileSystemPath(`${fileRoot}/${filePath}`);
    if (!worktreeRoot || absoluteFilePath === worktreeRoot || !absoluteFilePath.startsWith(`${worktreeRoot}/`)) return "";
    return this.encodedRelativeFilePath(absoluteFilePath.slice(worktreeRoot.length + 1));
  }

  applyVscodeModeLayout() {
    document.body.classList.toggle("vscode-mode", this.vscodeMode);
    document.body.classList.toggle("vscode-native-mode", this.nativeVscodeMode);
    document.body.classList.toggle("vscode-editor-mode", this.vscodeEditorMode);
    if (!this.vscodeMode) return;
    const forceHidden = ["active-toggle", "view-project", "view-search", "view-git", "files-section", "side-split",
      "project-worktree-header", "project-select", "project-select-label"];
    for (const id of forceHidden) {
      const el = this.$(id);
      if (el) {
        el.style.display = "none";
        el.classList.add("hidden");
      }
    }
    this.setSideView("terminals", false);
  }

  applyHostModeState({ vscode, nativeTerminal }) {
    const nextVscodeMode = parseModeFlag(vscode);
    const nextNativeMode = typeof nativeTerminal === "undefined" ? this.nativeVscodeMode : parseModeFlag(nativeTerminal);
    const shouldRefreshNative = !this.hostStatePatched && nextVscodeMode && nextNativeMode &&
      (this.vscodeMode !== nextVscodeMode || this.nativeVscodeMode !== nextNativeMode);
    this.vscodeMode = nextVscodeMode;
    this.nativeVscodeMode = nextNativeMode;
    this.hostStatePatched = true;
    this.applyVscodeModeLayout();
    if (shouldRefreshNative) void this.refresh();
  }

  applyVscodeContextState(payload) {
    const nextWorkspaceRoot = typeof payload.workspaceRoot === "string" ? payload.workspaceRoot
      : typeof payload.workspace_root === "string" ? payload.workspace_root : "";
    const nextProjectName = typeof payload.projectName === "string" ? payload.projectName
      : typeof payload.project_name === "string" ? payload.project_name : null;
    if (nextWorkspaceRoot) this.vscodeWorkspaceRoot = nextWorkspaceRoot;
    this.vscodeProjectName = nextProjectName === null ? this.vscodeProjectName : nextProjectName;
    if (!this.vscodeProjectName) this.vscodeProjectName = "";
  }

  projectFallbackFromWorkspaceRoot() {
    if (!this.vscodeMode || !this.vscodeWorkspaceRoot || !this.projects.length) return "";
    const fallback = this.projects.find((candidate) => {
      const root = String(candidate.root || "").replace(/\\/g, "/").replace(/\/+$/, "");
      const source = this.vscodeWorkspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
      return root === source;
    });
    if (!fallback) return "";
    this.vscodeProjectName = fallback.name;
    return fallback.root;
  }

  applyVscodeDefaultProjectState() {
    if (!this.vscodeMode) {
      if (this.vscodeProjectName) {
        if (this.projectSlug !== this.vscodeProjectName) this.projectSlug = this.vscodeProjectName;
        const select = this.$("project-select");
        if (select && select.value !== this.projectSlug) select.value = this.projectSlug;
        return;
      }
      if (this.projectFallbackFromWorkspaceRoot()) {
        this.projectSlug = this.vscodeProjectName;
        return;
      }
      this.projectSlug = this.projectSlug || null;
      return;
    }
    if (!this.vscodeEditorMode) this.projectSlug = null;
    return;
  }

  resolveVscodeDefaultCwd() {
    const workspaceRoot = this.vscodeWorkspaceRoot || WORKSPACE_ROOT_QUERY;
    if (workspaceRoot) return workspaceRoot;
    if (this.vscodeMode) {
      const fallback = this.projectFallbackFromWorkspaceRoot();
      if (fallback) return fallback;
    }
    const activeSession = this.session(this.activeId);
    return activeSession?.cwd || this.projectRoot() || DEFAULT_CWD;
  }

  handleHostMessage(event) {
    if (!event?.data) return;
    if (event.data.type === "termdeck-action") {
      const action = String(event.data.action || "");
      const payload = event.data.payload || {};
      if (!action) return;
      if (action === "new-terminal" || action === "new-group" || action === "vscode-refresh" || action === "vscode-reload") {
        this.runAction(action);
        return;
      }
      if (action === "select-session") {
        const sessionId = String(payload.session_id || payload.sessionId || "");
        if (sessionId) {
          if (this.session(sessionId)) this.activate(sessionId, { reveal: false });
          else void this.refresh().then(() => {
            if (this.session(sessionId)) this.activate(sessionId, { reveal: false });
          });
        }
        return;
      }
      if (action === "toggle-history") {
        this.toggleHistory();
        return;
      }
      if (action === "set-history") {
        this.setHistoryMode(!!payload.enabled);
        return;
      }
      if (action === "refresh") {
        this.requestVscodeRefresh(!!payload.hard);
        return;
      }
      return;
    }
    if (event.data.type !== "termdeck-host-state") return;
    if (typeof event.data.vscode === "undefined") return;
    const previousProjectSlug = this.projectSlug;
    this.applyHostModeState({
      vscode: event.data.vscode,
      native_terminal: event.data.native_terminal,
    });
    this.applyVscodeContextState(event.data);
    this.applyVscodeDefaultProjectState();
    if (this.vscodeEditorMode && this.vscodeProjectName && this.projectSlug !== this.vscodeProjectName) {
      this.projectSlug = this.vscodeProjectName;
    }
    if (this.projectSlug && this.projectSlug !== previousProjectSlug) {
      void this.refresh();
    }
  }

  projectStateKeyFor(worktreeId) {
    const project = this.projectSlug || "__all__";
    return worktreeId && worktreeId !== "root" ? `${project}::worktree:${worktreeId}` : project;
  }

  stateWorktreeId() {
    if (this.renderWorktreeId) return this.renderWorktreeId;
    if (this.worktreeId === ALL_WORKTREES_ID) return this.interactionWorktreeId || "root";
    return this.worktreeId || "root";
  }

  projectStateKey() {
    return this.projectStateKeyFor(this.stateWorktreeId());
  }

  getProjectStateForWorktree(worktreeId) {
    const states = this.settings.project_state || {};
    const key = this.projectStateKeyFor(worktreeId || "root");
    const state = states[key] || {};
    return {
      active_session_id: "", open_files: [], open_files_collapsed: false, recent_files_collapsed: true,
      recent_file_exclude_glob: "!*.json, !*.log, !*.csv",
      recently_opened_terminal_ids: [], unread_sessions: [],
      terminal_groups: [], session_groups: {}, session_view_modes: {},
      ...state,
      recent_files_collapsed: state.recent_files_collapsed ?? true,
    };
  }

  getProjectState() {
    return this.getProjectStateForWorktree(this.stateWorktreeId());
  }

  worktreeSectionStorageKey(worktreeId, field) {
    return `termdeck.${this.projectSlug || "__all__"}.worktree.${worktreeId}.${field}`;
  }

  worktreeSectionCollapsed(worktreeId) {
    const saved = this.settings.worktree_ui_state?.[this.worktreeSectionStorageKey(worktreeId, "state")];
    if (saved && typeof saved.collapsed === "boolean") return saved.collapsed;
    try {
      return window.localStorage.getItem(this.worktreeSectionStorageKey(worktreeId, "collapsed")) === "1";
    } catch (error) {
      return false;
    }
  }

  setWorktreeSectionCollapsed(worktreeId, collapsed) {
    const key = this.worktreeSectionStorageKey(worktreeId, "state");
    const current = this.settings.worktree_ui_state?.[key] || {};
    this.settings.worktree_ui_state = { ...(this.settings.worktree_ui_state || {}),
      [key]: { ...current, collapsed: !!collapsed } };
    this.saveSettings();
    try {
      window.localStorage.setItem(this.worktreeSectionStorageKey(worktreeId, "collapsed"), collapsed ? "1" : "0");
    } catch (error) {
      return;
    }
  }

  worktreeClosedExpanded(worktreeId) {
    if (this.worktreeId !== ALL_WORKTREES_ID) return this.closedExpanded;
    const saved = this.settings.worktree_ui_state?.[this.worktreeSectionStorageKey(worktreeId, "state")];
    if (saved && typeof saved.closed_expanded === "boolean") return saved.closed_expanded;
    try {
      const stored = window.localStorage.getItem(this.worktreeSectionStorageKey(worktreeId, "closed-expanded"));
      return stored === null ? false : stored === "1";
    } catch (error) {
      return false;
    }
  }

  setWorktreeClosedExpanded(worktreeId, expanded) {
    if (this.worktreeId !== ALL_WORKTREES_ID) {
      this.closedExpanded = expanded;
    }
    const key = this.worktreeSectionStorageKey(worktreeId, "state");
    const current = this.settings.worktree_ui_state?.[key] || {};
    this.settings.worktree_ui_state = { ...(this.settings.worktree_ui_state || {}),
      [key]: { ...current, closed_expanded: !!expanded } };
    this.saveSettings();
    try {
      window.localStorage.setItem(this.worktreeSectionStorageKey(worktreeId, "closed-expanded"), expanded ? "1" : "0");
    } catch (error) {
      return;
    }
  }

  worktreeIdForSession(session) {
    return String(session?.worktree_id || "root").trim() || "root";
  }

  sessionsForWorktree(worktreeId, sessions = this.sessions) {
    return sessions.filter((session) => this.worktreeIdForSession(session) === worktreeId);
  }

  setInteractionWorktreeFromElement(element, fallbackSession = null) {
    if (this.worktreeId !== ALL_WORKTREES_ID) return;
    const worktreeId = String(element?.dataset?.worktreeId || this.worktreeIdForSession(fallbackSession)).trim();
    if (worktreeId && worktreeId !== ALL_WORKTREES_ID && this.interactionWorktreeId !== worktreeId) {
      this.interactionWorktreeId = worktreeId;
      this.updateRecentFilesWatch();
    }
  }

  availableWorktreeSections() {
    const sections = this.worktrees.filter((worktree) => worktree.available).map((worktree) => ({ ...worktree }));
    const knownIds = new Set(sections.map((worktree) => String(worktree.id)));
    const records = [...this.sessions, ...this.closedSessions];
    for (const record of records) {
      const id = this.worktreeIdForSession(record);
      if (knownIds.has(id)) continue;
      knownIds.add(id);
      sections.push({ id, name: id === "root" ? "Project root" : `Worktree ${id}`, branch: "", path: "", available: true });
    }
    if (!sections.length && this.projectSlug) {
      sections.push({ id: "root", name: this.projectSlug, branch: "", path: this.projectRoot() || "", available: true });
    }
    return sections;
  }

  unreadSessionIdsForCurrentWorktreeView() {
    if (this.worktreeId !== ALL_WORKTREES_ID) return new Set(this.getProjectState().unread_sessions || []);
    const project = this.projectSlug || "__all__";
    const prefix = `${project}::worktree:`;
    const ids = new Set();
    for (const [key, state] of Object.entries(this.settings.project_state || {})) {
      if (key !== project && !key.startsWith(prefix)) continue;
      for (const sessionId of state.unread_sessions || []) ids.add(sessionId);
    }
    return ids;
  }

  patchProjectState(patch) {
    const resourceFields = new Set(["terminal_groups", "session_groups", "terminal_layout", "session_order",
      "unread_sessions", "recently_opened_terminal_ids", "session_view_modes"]);
    const invalidFields = Object.keys(patch).filter((field) => resourceFields.has(field));
    if (invalidFields.length) throw new Error(`project resources require targeted APIs: ${invalidFields.join(", ")}`);
    const states = this.settings.project_state || {};
    const stateKey = this.projectStateKey();
    states[stateKey] = { ...this.getProjectState(), ...patch };
    this.settings.project_state = states;
    this.queueProjectStatePatch(stateKey, patch);
  }

  projectStateSearchParams(stateKey) {
    const params = new URLSearchParams();
    if (stateKey !== "__all__") {
      const [projectName, worktreeId] = stateKey.split("::worktree:");
      params.set("project", projectName);
      params.set("worktree_id", worktreeId || "root");
    }
    return params;
  }

  applyLocalProjectStatePatch(patch, stateKey = this.projectStateKey()) {
    const states = this.settings.project_state || {};
    const current = states[stateKey] || {};
    states[stateKey] = { ...current, ...patch };
    this.settings.project_state = states;
  }

  async refreshCurrentProjectState() {
    const stateKey = this.projectStateKey();
    await this.projectStateSavePromise;
    const params = this.projectStateSearchParams(stateKey);
    let response;
    try {
      response = await fetch(`/api/terminal-layout?${params}`);
    } catch (error) {
      return;
    }
    if (!response.ok || stateKey !== this.projectStateKey()) return;
    const payload = await response.json();
    const nextState = {};
    for (const field of ["active_session_id", "open_files", "open_files_collapsed", "recent_files_collapsed",
      "recent_file_exclude_glob", "recently_opened_terminal_ids", "session_order", "pinned_sessions", "pinned_groups",
      "unread_sessions", "terminal_groups", "session_groups", "terminal_layout", "session_view_modes"]) {
      if (Object.prototype.hasOwnProperty.call(payload, field)) nextState[field] = payload[field];
    }
    const previous = this.settings.project_state?.[stateKey] || {};
    if (JSON.stringify(previous) === JSON.stringify(nextState)) {
      this.reconcileActiveSessionViewMode();
      return;
    }
    this.applyLocalProjectStatePatch(nextState, stateKey);
    this.unreadSessions = this.unreadSessionIdsForCurrentWorktreeView();
    this.renderList();
    this.reconcileActiveSessionViewMode();
  }

  queueProjectResourceRequest(stateKey, path, method, body = null) {
    const params = this.projectStateSearchParams(stateKey);
    const separator = path.includes("?") ? "&" : "?";
    const query = params.toString();
    const url = query ? `${path}${separator}${query}` : path;
    const payload = body === null ? "" : JSON.stringify(this.copySettings(body));
    this.projectStateSavePromise = this.projectStateSavePromise.catch((error) => {
      console.error("TermDeck project resource save failed", error);
    }).then(async () => {
      let response;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          response = await fetch(url, { method, keepalive: payload.length < 60000,
            headers: payload ? { "Content-Type": "application/json" } : {}, body: payload || undefined });
          if (response.ok || response.status < 500) break;
        } catch (error) {
          if (attempt === 1) throw error;
        }
      }
      if (!response?.ok) throw new Error(`project resource save failed (${response?.status || "network"})`);
    }).catch((error) => {
      console.error("TermDeck project resource save failed", error);
      const status = this.$("stat-text");
      if (status) status.textContent = error.message;
      void this.refreshCurrentProjectState();
    });
  }

  queueProjectStatePatch(stateKey, patch) {
    for (const [field, value] of Object.entries(patch)) {
      this.queueProjectResourceRequest(stateKey, `/api/project-state/${encodeURIComponent(field)}`, "PUT", { value });
    }
  }

  queueTerminalGroupCreate(group, sessionIds = [], anchorToken = "", after = false, stateKey = this.projectStateKey()) {
    this.queueProjectResourceRequest(stateKey, "/api/terminal-groups", "POST", {
      group_id: group.id, name: group.name, collapsed: !!group.collapsed,
      session_ids: sessionIds, anchor_token: anchorToken, after,
    });
  }

  queueTerminalGroupUpdate(groupId, patch, stateKey = this.projectStateKey()) {
    this.queueProjectResourceRequest(stateKey, `/api/terminal-groups/${encodeURIComponent(groupId)}`, "PATCH", patch);
  }

  queueTerminalGroupDelete(groupId, stateKey = this.projectStateKey()) {
    this.queueProjectResourceRequest(stateKey, `/api/terminal-groups/${encodeURIComponent(groupId)}`, "DELETE");
  }

  queueTerminalGroupMerge(sourceGroupId, targetGroupId, stateKey = this.projectStateKey()) {
    this.queueProjectResourceRequest(stateKey, `/api/terminal-groups/${encodeURIComponent(sourceGroupId)}/merge`, "POST",
      { target_group_id: targetGroupId });
  }

  queueSessionGroupAssignments(assignments, targetSessionId = "", after = false, stateKey = this.projectStateKey()) {
    this.queueProjectResourceRequest(stateKey, "/api/session-group-assignments", "PUT",
      { assignments, target_session_id: targetSessionId || "", after });
  }

  queueTerminalLayoutMove(token, targetToken = "", after = false, toTop = false, stateKey = this.projectStateKey()) {
    this.queueProjectResourceRequest(stateKey, "/api/terminal-layout/move", "PATCH",
      { token, target_token: targetToken, after, to_top: toTop });
  }

  queueSessionOrderMove(sessionIds, targetSessionId = "", after = false, stateKey = this.projectStateKey()) {
    this.queueProjectResourceRequest(stateKey, "/api/session-order/move", "PATCH",
      { session_ids: sessionIds, target_session_id: targetSessionId, after });
  }

  persistUnreadSessionDelta(sessionIds, unread) {
    const idsByStateKey = new Map();
    const project = this.projectSlug || "__all__";
    const prefix = `${project}::worktree:`;
    for (const sessionId of [...new Set(sessionIds)].filter(Boolean)) {
      const session = this.session(sessionId);
      let stateKeys = session ? [this.projectStateKeyFor(this.worktreeIdForSession(session))] : [];
      if (!stateKeys.length) {
        stateKeys = Object.entries(this.settings.project_state || {})
          .filter(([key, state]) => (key === project || key.startsWith(prefix)) &&
            (state.unread_sessions || []).includes(sessionId))
          .map(([key]) => key);
      }
      if (!stateKeys.length) stateKeys = [this.projectStateKey()];
      for (const stateKey of stateKeys) {
        if (!idsByStateKey.has(stateKey)) idsByStateKey.set(stateKey, []);
        idsByStateKey.get(stateKey).push(sessionId);
      }
    }
    for (const [stateKey, ids] of idsByStateKey) {
      const current = this.settings.project_state?.[stateKey] || {};
      const unreadIds = new Set(current.unread_sessions || []);
      for (const sessionId of ids) {
        if (unread) unreadIds.add(sessionId);
        else unreadIds.delete(sessionId);
      }
      this.applyLocalProjectStatePatch({ unread_sessions: [...unreadIds] }, stateKey);
      this.queueProjectResourceRequest(stateKey, "/api/session-unread", "PUT", { session_ids: ids, unread });
    }
  }

  rememberRecentlyOpenedTerminal(sessionId) {
    if (!sessionId || !this.session(sessionId)) return;
    const current = this.getProjectState().recently_opened_terminal_ids || [];
    const next = [sessionId, ...current.filter((id) => id !== sessionId)].slice(0, RECENTLY_OPENED_TERMINALS_MAX_ENTRIES);
    if (next.length === current.length && next.every((id, index) => id === current[index])) return;
    this.applyLocalProjectStatePatch({ recently_opened_terminal_ids: next });
    this.queueProjectResourceRequest(this.projectStateKey(),
      `/api/recently-opened-terminals/${encodeURIComponent(sessionId)}`, "POST");
  }

  previouslyOpenedTerminalId(excludedSessionIds) {
    const excluded = excludedSessionIds instanceof Set ? excludedSessionIds : new Set(excludedSessionIds || []);
    for (const sessionId of this.getProjectState().recently_opened_terminal_ids || []) {
      if (!excluded.has(sessionId) && this.session(sessionId)) return sessionId;
    }
    return "";
  }

  sectionCollapsed(field) {
    return !!this.getProjectState()[field];
  }

  setSectionCollapsed(field, collapsed) {
    this.patchProjectState({ [field]: collapsed });
    try {
      window.localStorage.setItem(`termdeck.${this.projectStateKey()}.${field}`, collapsed ? "1" : "0");
    } catch (error) {
      // The server-backed project state is still updated.
    }
  }

  toggleSectionCollapsed(field) {
    const collapsed = !this.sectionCollapsed(field);
    this.setSectionCollapsed(field, collapsed);
    this.renderList();
    if (field !== "recent_files_collapsed") return;
    this.updateRecentFilesWatch();
    if (!collapsed) void this.refreshRecentFiles(true);
  }

  recentFilesVisibleRoot() {
    const activeRoot = this.session(this.activeId)?.cwd || this.worktreeRoot();
    const filesVisible = !this.$("files-section").classList.contains("hidden");
    return (filesVisible && this.treeRoot) || activeRoot || "";
  }

  updateRecentFilesWatch() {
    const root = this.recentFilesVisibleRoot();
    if (this.vscodeMode || document.hidden || this.sectionCollapsed("recent_files_collapsed") || !root) {
      this.disconnectRecentFilesWatch();
      return;
    }
    if (this.recentFilesWs && this.recentFilesWsRoot === root &&
        (this.recentFilesWs.readyState === WebSocket.CONNECTING || this.recentFilesWs.readyState === WebSocket.OPEN)) return;
    this.disconnectRecentFilesWatch();
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}${FILE_TREE_WS_ROUTE}?root=${encodeURIComponent(root)}`);
    this.recentFilesWs = socket;
    this.recentFilesWsRoot = root;
    socket.onmessage = (event) => {
      if (this.recentFilesWs !== socket) return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch (error) {
        if (error instanceof SyntaxError) return;
        throw error;
      }
      if (message.type === FILE_TREE_CHANGED) this.queueRecentFilesEventRefresh();
    };
    socket.onclose = () => {
      if (this.recentFilesWs !== socket) return;
      this.recentFilesWs = null;
      this.recentFilesWsRoot = "";
      if (document.hidden || this.sectionCollapsed("recent_files_collapsed")) return;
      clearTimeout(this.recentFilesWsReconnectTimer);
      this.recentFilesWsReconnectTimer = window.setTimeout(() => {
        this.recentFilesWsReconnectTimer = 0;
        this.updateRecentFilesWatch();
      }, 5000);
    };
  }

  disconnectRecentFilesWatch() {
    clearTimeout(this.recentFilesWsReconnectTimer);
    this.recentFilesWsReconnectTimer = 0;
    clearTimeout(this.recentFilesEventRefreshTimer);
    this.recentFilesEventRefreshTimer = 0;
    const socket = this.recentFilesWs;
    this.recentFilesWs = null;
    this.recentFilesWsRoot = "";
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
  }

  queueRecentFilesEventRefresh() {
    if (this.sectionCollapsed("recent_files_collapsed") || document.hidden) return;
    clearTimeout(this.recentFilesEventRefreshTimer);
    this.recentFilesEventRefreshTimer = window.setTimeout(() => {
      this.recentFilesEventRefreshTimer = 0;
      void this.refreshRecentFiles();
    }, RECENT_FILES_EVENT_DEBOUNCE_MS);
  }

  terminalGroups() {
    return this.terminalGroupsForWorktree();
  }

  terminalGroupsForWorktree(worktreeId = this.stateWorktreeId()) {
    return (this.getProjectStateForWorktree(worktreeId).terminal_groups || [])
      .filter((group) => group && group.id && String(group.name || "").trim())
      .map((group) => ({ id: String(group.id), name: String(group.name).trim(), collapsed: !!group.collapsed }));
  }

  terminalGroupNameForSession(sessionId, worktreeId = this.stateWorktreeId()) {
    const groupId = this.getProjectStateForWorktree(worktreeId).session_groups?.[sessionId];
    return this.terminalGroupsForWorktree(worktreeId).find((group) => group.id === groupId)?.name || "";
  }

  createTerminalGroup() {
    const name = prompt("Name for the terminal group", "New group");
    if (!name || !name.trim()) return;
    const groups = this.terminalGroups();
    const group = { id: `group-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: name.trim(), collapsed: false };
    this.applyLocalProjectStatePatch({ terminal_groups: [...groups, group] });
    this.queueTerminalGroupCreate(group);
    this.renderList();
  }

  renameTerminalGroup(groupId) {
    const group = this.terminalGroups().find((candidate) => candidate.id === groupId);
    if (!group) return;
    const name = prompt("Rename terminal group", group.name);
    if (!name || !name.trim() || name.trim() === group.name) return;
    const groups = this.terminalGroups().map((candidate) => candidate.id === groupId
      ? { ...candidate, name: name.trim() } : candidate);
    this.applyLocalProjectStatePatch({ terminal_groups: groups });
    this.queueTerminalGroupUpdate(groupId, { name: name.trim() });
    this.renderList();
  }

  deleteTerminalGroup(groupId) {
    const group = this.terminalGroups().find((candidate) => candidate.id === groupId);
    if (!group || !confirm(`Delete group "${group.name}"? Terminals will remain ungrouped.`)) return;
    this.applyLocalProjectStatePatch(this.terminalGroupDeletionPatch(groupId));
    this.queueTerminalGroupDelete(groupId);
    this.renderList();
  }

  terminalGroupDeletionPatch(groupId) {
    const state = this.getProjectState();
    const sessionGroups = { ...(state.session_groups || {}) };
    const availableIds = new Set(this.sessionsForWorktree(this.stateWorktreeId()).map((session) => session.session_id));
    const memberIds = (state.session_order || [])
      .filter((sessionId) => availableIds.has(sessionId) && sessionGroups[sessionId] === groupId);
    memberIds.push(...Object.entries(sessionGroups)
      .filter(([sessionId, assignedGroupId]) => assignedGroupId === groupId && availableIds.has(sessionId) &&
        !memberIds.includes(sessionId))
      .map(([sessionId]) => sessionId));
    for (const [sessionId, assignedGroupId] of Object.entries(sessionGroups)) {
      if (assignedGroupId === groupId) delete sessionGroups[sessionId];
    }
    const groupToken = `group:${groupId}`;
    const layout = this.terminalLayout();
    const groupIndex = layout.includes(groupToken) ? layout.indexOf(groupToken) : layout.length;
    const terminalLayout = layout.filter((entry) => entry !== groupToken);
    terminalLayout.splice(groupIndex, 0, ...memberIds.map((sessionId) => `session:${sessionId}`)
      .filter((entry) => !terminalLayout.includes(entry)));
    return {
      terminal_groups: this.terminalGroups().filter((candidate) => candidate.id !== groupId),
      session_groups: sessionGroups,
      terminal_layout: terminalLayout,
    };
  }

  toggleTerminalGroup(groupId) {
    const current = this.terminalGroups().find((group) => group.id === groupId);
    if (!current) return;
    const collapsed = !current.collapsed;
    const groups = this.terminalGroups().map((group) => group.id === groupId
      ? { ...group, collapsed } : group);
    this.applyLocalProjectStatePatch({ terminal_groups: groups });
    this.queueTerminalGroupUpdate(groupId, { collapsed });
    const groupBox = this.$("session-list").querySelector(`[data-group-id="${CSS.escape(groupId)}"]`);
    const members = groupBox?.querySelector(".terminal-group-members");
    if (!members) {
      this.renderList();
      return;
    }
    members.classList.toggle("collapsed", collapsed);
    const chevron = groupBox.querySelector(".terminal-group-label > .codicon");
    if (chevron) chevron.className = `codicon ${collapsed ? "codicon-chevron-right" : "codicon-chevron-down"}`;
  }

  groupSessionIds(groupId, sessionGroups = this.getProjectState().session_groups || {}) {
    const currentSessionIds = new Set(this.sessionsForWorktree(this.stateWorktreeId()).map((session) => session.session_id));
    return Object.entries(sessionGroups)
      .filter(([sessionId, assignedGroupId]) => assignedGroupId === groupId && currentSessionIds.has(sessionId))
      .map(([sessionId]) => sessionId);
  }

  assignSessionGroup(sessionId, groupId) {
    const state = this.getProjectState();
    const layout = this.terminalLayout();
    const sessionGroups = { ...(state.session_groups || {}) };
    const oldGroupId = sessionGroups[sessionId] || null;
    if (groupId) sessionGroups[sessionId] = groupId;
    else delete sessionGroups[sessionId];
    const patch = { session_groups: sessionGroups };
    if (groupId) {
      const token = `session:${sessionId}`;
      patch.terminal_layout = layout.filter((entry) => entry !== token);
    } else if (!layout.includes(`session:${sessionId}`)) {
      const groupIndex = oldGroupId ? layout.indexOf(`group:${oldGroupId}`) : -1;
      const insertAt = groupIndex < 0 ? layout.length : groupIndex + 1;
      layout.splice(insertAt, 0, `session:${sessionId}`);
      patch.terminal_layout = layout;
    }
    this.applyLocalProjectStatePatch(patch);
    this.queueSessionGroupAssignments({ [sessionId]: groupId || null });
    this.renderList();
  }

  sidebarSessionIdsInRenderOrder() {
    const rows = this.$("session-list")?.querySelectorAll(".session-item[data-session-id]") || [];
    const ids = [...rows].map((row) => row.dataset.sessionId).filter((id) => !!this.session(id));
    return ids.length ? ids : this.sessions.map((session) => session.session_id);
  }

  applySidebarSelectionStyles() {
    const rows = this.$("session-list")?.querySelectorAll(".session-item[data-session-id]") || [];
    for (const row of rows) row.classList.toggle("sidebar-selected", this.sidebarSelectedSessionIds.has(row.dataset.sessionId));
  }

  openFileKeysInRenderOrder() {
    const rows = this.$("session-list")?.querySelectorAll(".file-item[data-file-key]") || [];
    const keys = [...rows].map((row) => row.dataset.fileKey).filter((key) => this.openFiles.has(key));
    return keys.length ? keys : [...this.openFiles.keys()];
  }

  applySidebarFileSelectionStyles() {
    const rows = this.$("session-list")?.querySelectorAll(".file-item[data-file-key]") || [];
    for (const row of rows) row.classList.toggle("sidebar-selected", this.sidebarSelectedFileKeys.has(row.dataset.fileKey));
  }

  handleOpenFileRowSelection(event, key) {
    const orderedKeys = this.openFileKeysInRenderOrder();
    const multiSelect = event.metaKey || event.ctrlKey;
    if (event.shiftKey) {
      const anchorKey = this.sidebarFileSelectionAnchorKey && orderedKeys.includes(this.sidebarFileSelectionAnchorKey)
        ? this.sidebarFileSelectionAnchorKey : key;
      const anchorIndex = orderedKeys.indexOf(anchorKey);
      const targetIndex = orderedKeys.indexOf(key);
      const range = orderedKeys.slice(Math.min(anchorIndex, targetIndex), Math.max(anchorIndex, targetIndex) + 1);
      this.sidebarSelectedFileKeys = multiSelect
        ? new Set([...this.sidebarSelectedFileKeys, ...range]) : new Set(range);
      this.sidebarFileSelectionAnchorKey = anchorKey;
    } else if (multiSelect) {
      const next = new Set(this.sidebarSelectedFileKeys);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      this.sidebarSelectedFileKeys = next;
      this.sidebarFileSelectionAnchorKey = key;
    } else {
      this.sidebarSelectedFileKeys = new Set([key]);
      this.sidebarFileSelectionAnchorKey = key;
    }
    this.sidebarSelectedSessionIds.clear();
    this.applySidebarSelectionStyles();
    this.applySidebarFileSelectionStyles();
    void this.activateFile(key, null, { fromOpenFiles: true });
  }

  selectContextMenuFileKeys(key) {
    if (!this.sidebarSelectedFileKeys.has(key)) {
      this.sidebarSelectedFileKeys = new Set([key]);
      this.sidebarFileSelectionAnchorKey = key;
      this.sidebarSelectedSessionIds.clear();
      this.applySidebarSelectionStyles();
      this.applySidebarFileSelectionStyles();
    }
    const selected = this.sidebarSelectedFileKeys.has(key) ? [...this.sidebarSelectedFileKeys] : [key];
    const order = new Map(this.openFileKeysInRenderOrder().map((fileKey, index) => [fileKey, index]));
    return [...new Set(selected)].filter((fileKey) => this.openFiles.has(fileKey))
      .sort((left, right) => (order.get(left) ?? Number.MAX_SAFE_INTEGER) - (order.get(right) ?? Number.MAX_SAFE_INTEGER));
  }

  handleSessionRowSelection(event, sessionId) {
    this.setInteractionWorktreeFromElement(event.currentTarget, this.session(sessionId));
    const selectedWorktreeId = this.stateWorktreeId();
    const orderedIds = this.sidebarSessionIdsInRenderOrder()
      .filter((id) => this.worktreeIdForSession(this.session(id)) === selectedWorktreeId);
    const multiSelect = event.metaKey || event.ctrlKey;
    if (event.shiftKey) {
      const anchorId = this.sidebarSelectionAnchorId && orderedIds.includes(this.sidebarSelectionAnchorId)
        ? this.sidebarSelectionAnchorId : sessionId;
      const anchorIndex = orderedIds.indexOf(anchorId);
      const targetIndex = orderedIds.indexOf(sessionId);
      const start = Math.min(anchorIndex, targetIndex);
      const end = Math.max(anchorIndex, targetIndex);
      const range = orderedIds.slice(start, end + 1);
      this.sidebarSelectedSessionIds = multiSelect
        ? new Set([...this.sidebarSelectedSessionIds, ...range])
        : new Set(range);
      this.sidebarSelectionAnchorId = anchorId;
    } else if (multiSelect) {
      const next = new Set(this.sidebarSelectedSessionIds);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      this.sidebarSelectedSessionIds = next;
      this.sidebarSelectionAnchorId = sessionId;
    } else {
      this.sidebarSelectedSessionIds = new Set([sessionId]);
      this.sidebarSelectionAnchorId = sessionId;
    }
    this.sidebarSelectedFileKeys.clear();
    this.applySidebarSelectionStyles();
    this.applySidebarFileSelectionStyles();
    this.activate(sessionId);
  }

  selectedSessionIdsForDrag(sessionId) {
    const selectedWorktreeId = this.stateWorktreeId();
    const selected = this.sidebarSelectedSessionIds.has(sessionId)
      ? [...this.sidebarSelectedSessionIds]
      : [sessionId];
    const order = new Map(this.sidebarSessionIdsInRenderOrder().map((id, index) => [id, index]));
    return [...new Set(selected)]
      .filter((id) => !!this.session(id) && this.worktreeIdForSession(this.session(id)) === selectedWorktreeId)
      .sort((left, right) => (order.get(left) ?? Number.MAX_SAFE_INTEGER) - (order.get(right) ?? Number.MAX_SAFE_INTEGER));
  }

  selectContextMenuSessionIds(sessionId) {
    this.sidebarSelectedFileKeys.clear();
    this.applySidebarFileSelectionStyles();
    if (!this.sidebarSelectedSessionIds.has(sessionId)) {
      this.sidebarSelectedSessionIds = new Set([sessionId]);
      this.sidebarSelectionAnchorId = sessionId;
      this.applySidebarSelectionStyles();
    }
    return this.selectedSessionIdsForDrag(sessionId);
  }

  sessionIdsFromDragItem(dragItem) {
    if (dragItem?.kind !== "session") return [];
    const tokens = Array.isArray(dragItem.tokens) ? dragItem.tokens : [dragItem.token];
    return [...new Set(tokens
      .filter((token) => String(token).startsWith("session:"))
      .map((token) => String(token).slice("session:".length)))]
      .filter((id) => !!this.session(id));
  }

  sessionOrderWithSelectedIdsAroundTarget(selectedIds, targetId, after = false) {
    const selected = new Set(selectedIds);
    const order = this.sessionsForWorktree(this.stateWorktreeId()).map((session) => session.session_id)
      .filter((id) => !selected.has(id));
    const targetIndex = order.indexOf(targetId);
    if (targetIndex < 0) return order;
    order.splice(targetIndex + (after ? 1 : 0), 0, ...selectedIds);
    return order;
  }

  moveSelectedSessionsIntoGroup(sessionIds, groupId, targetId = null, after = false) {
    const selectedWorktreeId = this.stateWorktreeId();
    const ids = [...new Set(sessionIds)].filter((id) => !!this.session(id) &&
      this.worktreeIdForSession(this.session(id)) === selectedWorktreeId);
    if (!ids.length) return;
    const state = this.getProjectState();
    const sessionGroups = { ...(state.session_groups || {}) };
    const selectedTokens = new Set(ids.map((id) => `session:${id}`));
    const layout = this.terminalLayout().filter((entry) => !selectedTokens.has(entry));
    for (const id of ids) {
      if (groupId) sessionGroups[id] = groupId;
      else delete sessionGroups[id];
    }
    if (!groupId) layout.push(...ids.map((id) => `session:${id}`));
    const patch = { session_groups: sessionGroups, terminal_layout: layout };
    if (groupId && targetId) {
      patch.session_order = this.sessionOrderWithSelectedIdsAroundTarget(
        ids.filter((id) => id !== targetId), targetId, after);
    }
    this.applyLocalProjectStatePatch(patch);
    this.queueSessionGroupAssignments(Object.fromEntries(ids.map((id) => [id, groupId || null])), targetId || "", after);
    this.sessions = this.applySessionOrder(this.sessions);
    this.renderList();
  }

  async moveSelectedSessionsToProject(sessionIds, project) {
    const sessions = [...new Set(sessionIds)].map((id) => this.session(id))
      .filter((session) => !!session && session.project !== project);
    if (!project || !sessions.length) return;
    const responses = await Promise.all(sessions.map((session) => fetch(`/api/sessions/${session.session_id}/project`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project }),
    })));
    const failure = responses.find((response) => !response.ok);
    if (failure) {
      alert(`move ${sessions.length === 1 ? "terminal" : "terminals"} to project failed (${failure.status})`);
      await this.refresh();
      return;
    }
    if (this.projectSlug && this.projectSlug !== project) {
      location.href = `/p/${encodeURIComponent(project)}`;
      return;
    }
    await this.refresh();
  }

  repositionSelectedSessions(sessionIds, targetId, after = false) {
    const selectedWorktreeId = this.stateWorktreeId();
    const ids = [...new Set(sessionIds)].filter((id) => !!this.session(id) && id !== targetId &&
      this.worktreeIdForSession(this.session(id)) === selectedWorktreeId);
    const target = this.session(targetId);
    if (!ids.length || !target || this.worktreeIdForSession(target) !== selectedWorktreeId) return;
    const state = this.getProjectState();
    const targetGroupId = state.session_groups?.[targetId] || null;
    if (targetGroupId) {
      this.moveSelectedSessionsIntoGroup(ids, targetGroupId, targetId, after);
      return;
    }
    const selectedTokens = new Set(ids.map((id) => `session:${id}`));
    const sessionGroups = { ...(state.session_groups || {}) };
    for (const id of ids) delete sessionGroups[id];
    const layout = this.terminalLayout().filter((entry) => !selectedTokens.has(entry));
    const targetIndex = layout.indexOf(`session:${targetId}`);
    if (targetIndex < 0) return;
    layout.splice(targetIndex + (after ? 1 : 0), 0, ...ids.map((id) => `session:${id}`));
    this.applyLocalProjectStatePatch({
      session_groups: sessionGroups,
      terminal_layout: layout,
      session_order: this.sessionOrderWithSelectedIdsAroundTarget(ids, targetId, after),
    });
    this.queueSessionGroupAssignments(Object.fromEntries(ids.map((id) => [id, null])), targetId, after);
    this.sessions = this.applySessionOrder(this.sessions);
    this.renderList();
  }

  groupSelectedSessionsFromDrop(sessionIds, targetId, after = false) {
    const selectedWorktreeId = this.stateWorktreeId();
    const ids = [...new Set(sessionIds)].filter((id) => !!this.session(id) && id !== targetId &&
      this.worktreeIdForSession(this.session(id)) === selectedWorktreeId);
    const target = this.session(targetId);
    if (!ids.length || !target || this.worktreeIdForSession(target) !== selectedWorktreeId) return;
    const state = this.getProjectState();
    const sessionGroups = state.session_groups || {};
    const targetGroupId = sessionGroups[targetId] || null;
    if (targetGroupId) {
      this.moveSelectedSessionsIntoGroup(ids, targetGroupId, targetId, after);
      return;
    }
    const sourceGroupIds = [...new Set(ids.map((id) => sessionGroups[id]).filter(Boolean))];
    if (sourceGroupIds.length === 1) {
      this.moveSelectedSessionsIntoGroup([...ids, targetId], sourceGroupIds[0], targetId, after);
      return;
    }
    const name = prompt("Name for the new terminal group", `${this.effectiveTitle(target)} group`);
    if (!name || !name.trim()) return;
    const group = { id: `group-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: name.trim(), collapsed: false };
    const allIds = [...ids, targetId];
    const allTokens = new Set(allIds.map((id) => `session:${id}`));
    const currentLayout = this.terminalLayout();
    const targetIndex = currentLayout.indexOf(`session:${targetId}`);
    const layout = currentLayout.filter((entry) => !allTokens.has(entry));
    layout.splice(targetIndex < 0 ? layout.length : Math.min(targetIndex, layout.length), 0, `group:${group.id}`);
    const nextSessionGroups = { ...sessionGroups };
    for (const id of allIds) nextSessionGroups[id] = group.id;
    this.applyLocalProjectStatePatch({
      terminal_groups: [...this.terminalGroups(), group],
      session_groups: nextSessionGroups,
      terminal_layout: layout,
      session_order: this.sessionOrderWithSelectedIdsAroundTarget(ids, targetId, after),
    });
    this.queueTerminalGroupCreate(group, allIds, `session:${targetId}`, after);
    this.sessions = this.applySessionOrder(this.sessions);
    this.renderList();
  }

  moveSessionToGroup(sessionId, groupId, targetId = null, after = false) {
    const state = this.getProjectState();
    const currentGroupId = state.session_groups?.[sessionId] || null;
    if (currentGroupId === groupId && targetId) {
      this.reorderGroupedSessions(sessionId, targetId, after);
      return;
    }
    const sessionGroups = { ...(state.session_groups || {}) };
    if (groupId) sessionGroups[sessionId] = groupId;
    else delete sessionGroups[sessionId];
    const patch = { session_groups: sessionGroups };
    const layout = this.terminalLayout().filter((entry) => entry !== `session:${sessionId}`);
    if (groupId) {
      patch.terminal_layout = layout;
    } else {
      const targetIndex = targetId ? layout.indexOf(`session:${targetId}`) : -1;
      if (targetIndex >= 0) layout.splice(targetIndex + (after ? 1 : 0), 0, `session:${sessionId}`);
      else {
        const oldGroupIndex = currentGroupId ? layout.indexOf(`group:${currentGroupId}`) : -1;
        layout.splice(oldGroupIndex >= 0 ? oldGroupIndex + 1 : layout.length, 0, `session:${sessionId}`);
      }
      patch.terminal_layout = layout;
    }
    if (groupId && targetId) {
      const order = this.sessions.map((session) => session.session_id).filter((id) => id !== sessionId);
      const targetIndex = order.indexOf(targetId);
      if (targetIndex >= 0) order.splice(targetIndex + (after ? 1 : 0), 0, sessionId);
      patch.session_order = order;
    }
    this.applyLocalProjectStatePatch(patch);
    this.queueSessionGroupAssignments({ [sessionId]: groupId || null }, targetId || "", after);
    this.sessions = this.applySessionOrder(this.sessions);
    this.renderList();
  }

  terminalLayout(sessions = this.sessions) {
    const state = this.getProjectState();
    const scopedSessions = this.worktreeId === ALL_WORKTREES_ID && !this.renderWorktreeId
      ? this.sessionsForWorktree(this.stateWorktreeId(), sessions) : sessions;
    const groups = this.terminalGroups();
    const groupIds = new Set(groups.map((group) => group.id));
    const sessionIds = new Set(scopedSessions.map((session) => session.session_id));
    const sessionGroups = state.session_groups || {};
    const layout = [];
    const seen = new Set();
    const add = (entry) => {
      if (seen.has(entry)) return;
      const [kind, id] = String(entry).split(":", 2);
      if (kind === "group" && !groupIds.has(id)) return;
      if (kind === "session" && (!sessionIds.has(id) || sessionGroups[id])) return;
      if (kind !== "group" && kind !== "session") return;
      seen.add(entry);
      layout.push(entry);
    };
    if (Array.isArray(state.terminal_layout)) {
      state.terminal_layout.forEach(add);
    } else {
      // Migrate older group state by placing each group beside its earliest
      // member instead of losing the relationship at the end of the list.
      const orderedIds = state.session_order?.length
        ? state.session_order
        : scopedSessions.map((session) => session.session_id);
      const groupsAt = new Map();
      for (const group of groups) {
        const memberIndex = orderedIds.findIndex((id) => sessionGroups[id] === group.id);
        if (memberIndex >= 0) {
          if (!groupsAt.has(memberIndex)) groupsAt.set(memberIndex, []);
          groupsAt.get(memberIndex).push(group);
        }
      }
      for (let index = 0; index <= orderedIds.length; index += 1) {
        for (const group of groupsAt.get(index) || []) add(`group:${group.id}`);
        if (index < orderedIds.length) add(`session:${orderedIds[index]}`);
      }
    }
    for (const session of scopedSessions) add(`session:${session.session_id}`);
    for (const group of groups) add(`group:${group.id}`);
    return layout;
  }

  migrateLegacyPinnedLayout() {
    const state = this.getProjectState();
    const pinnedSessions = new Set(state.pinned_sessions || []);
    const pinnedGroups = new Set(state.pinned_groups || []);
    if (!pinnedSessions.size && !pinnedGroups.size) return;
    const sessionGroups = state.session_groups || {};
    for (const [sessionId, groupId] of Object.entries(sessionGroups)) {
      if (pinnedSessions.has(sessionId)) pinnedGroups.add(groupId);
    }
    const legacyTokens = new Set([
      ...[...pinnedGroups].map((id) => `group:${id}`),
      ...[...pinnedSessions]
        .filter((id) => !sessionGroups[id])
        .map((id) => `session:${id}`),
    ]);
    const layout = this.terminalLayout();
    const top = layout.filter((entry) => legacyTokens.has(entry));
    const nextLayout = [...top, ...layout.filter((entry) => !legacyTokens.has(entry))];
    this.applyLocalProjectStatePatch({ terminal_layout: nextLayout, pinned_sessions: [], pinned_groups: [] });
    for (const token of [...top].reverse()) this.queueTerminalLayoutMove(token, "", false, true);
    this.patchProjectState({ pinned_sessions: [], pinned_groups: [] });
  }

  moveTerminalLayoutToTop(token) {
    const current = this.terminalLayout();
    if (!current.includes(token)) return;
    const layout = current.filter((entry) => entry !== token);
    layout.unshift(token);
    this.applyLocalProjectStatePatch({ terminal_layout: layout });
    this.queueTerminalLayoutMove(token, "", false, true);
    this.renderList();
  }

  reorderTerminalLayout(draggedToken, targetToken, after = false) {
    const state = this.getProjectState();
    const layout = this.terminalLayout().filter((entry) => entry !== draggedToken);
    const targetIndex = layout.indexOf(targetToken);
    if (targetIndex < 0) return;
    layout.splice(targetIndex + (after ? 1 : 0), 0, draggedToken);
    const patch = { terminal_layout: layout };
    const [kind, id] = draggedToken.split(":", 2);
    if (kind === "session" && state.session_groups?.[id]) {
      const oldGroupId = state.session_groups[id];
      const sessionGroups = { ...(state.session_groups || {}) };
      delete sessionGroups[id];
      patch.session_groups = sessionGroups;
    }
    this.applyLocalProjectStatePatch(patch);
    if (kind === "session" && state.session_groups?.[id]) this.queueSessionGroupAssignments({ [id]: null });
    this.queueTerminalLayoutMove(draggedToken, targetToken, after);
    this.renderList();
  }

  reorderGroupedSessions(draggedId, targetId, after = false) {
    const ids = this.sessions.map((session) => session.session_id).filter((id) => id !== draggedId);
    const targetIndex = ids.indexOf(targetId);
    if (targetIndex < 0) return;
    ids.splice(targetIndex + (after ? 1 : 0), 0, draggedId);
    this.applyLocalProjectStatePatch({ session_order: ids });
    this.queueSessionOrderMove([draggedId], targetId, after);
    this.sessions = this.applySessionOrder(this.sessions);
    this.renderList();
  }

  mergeTerminalGroups(sourceId, targetId) {
    if (!sourceId || !targetId || sourceId === targetId) return;
    const groups = this.terminalGroups();
    if (!groups.some((group) => group.id === sourceId) || !groups.some((group) => group.id === targetId)) return;
    const state = this.getProjectState();
    const sessionGroups = { ...(state.session_groups || {}) };
    for (const [sessionId, groupId] of Object.entries(sessionGroups)) {
      if (groupId === sourceId) sessionGroups[sessionId] = targetId;
    }
    this.applyLocalProjectStatePatch({
      terminal_groups: groups.filter((group) => group.id !== sourceId),
      session_groups: sessionGroups,
      terminal_layout: this.terminalLayout().filter((entry) => entry !== `group:${sourceId}`),
    });
    this.queueTerminalGroupMerge(sourceId, targetId);
    this.renderList();
  }

  groupSessionsFromDrop(draggedId, targetId, after = false) {
    const state = this.getProjectState();
    const sessionGroups = { ...(state.session_groups || {}) };
    const draggedGroupId = sessionGroups[draggedId] || null;
    const targetGroupId = sessionGroups[targetId] || null;
    if (draggedGroupId && draggedGroupId === targetGroupId) {
      this.reorderGroupedSessions(draggedId, targetId, after);
      return;
    }
    if (targetGroupId) {
      this.assignSessionGroup(draggedId, targetGroupId);
      this.reorderGroupedSessions(draggedId, targetId, after);
      return;
    }
    if (draggedGroupId) {
      this.assignSessionGroup(targetId, draggedGroupId);
      // The dragged member remains the anchor: dropping after the target
      // means the target belongs immediately before the dragged member.
      this.reorderGroupedSessions(targetId, draggedId, !after);
      return;
    }
    const dragged = this.session(draggedId), target = this.session(targetId);
    if (!dragged || !target) return;
    const suggestion = `${this.effectiveTitle(target)} group`;
    const name = prompt("Name for the new terminal group", suggestion);
    if (!name || !name.trim()) return;
    const group = { id: `group-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: name.trim(), collapsed: false };
    const layout = this.terminalLayout().filter((entry) => entry !== `session:${draggedId}` && entry !== `session:${targetId}`);
    const targetIndex = this.terminalLayout().indexOf(`session:${targetId}`);
    layout.splice(targetIndex < 0 ? layout.length : Math.min(targetIndex, layout.length), 0, `group:${group.id}`);
    sessionGroups[draggedId] = group.id;
    sessionGroups[targetId] = group.id;
    this.applyLocalProjectStatePatch({ terminal_groups: [...this.terminalGroups(), group], session_groups: sessionGroups,
      terminal_layout: layout });
    this.queueTerminalGroupCreate(group, [draggedId, targetId], `session:${targetId}`, after);
    this.reorderGroupedSessions(draggedId, targetId, after);
  }

  createTerminalGroupFromSession(sessionId) {
    this.createTerminalGroupFromSessions([sessionId]);
  }

  createTerminalGroupFromSessions(sessionIds) {
    const ids = [...new Set(sessionIds)].filter((id) => !!this.session(id));
    if (!ids.length) return;
    const firstSession = this.session(ids[0]);
    const suggestion = ids.length === 1 ? `${this.effectiveTitle(firstSession)} group`
      : `${this.effectiveTitle(firstSession)} + ${ids.length - 1} group`;
    const name = prompt("Name for the new terminal group", suggestion);
    if (!name || !name.trim()) return;
    const state = this.getProjectState();
    const sessionGroups = { ...(state.session_groups || {}) };
    const group = { id: `group-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: name.trim(), collapsed: false };
    const layout = this.terminalLayout();
    const selectedTokens = new Set(ids.map((id) => `session:${id}`));
    const indexes = ids.map((id) => {
      const tokenIndex = layout.indexOf(`session:${id}`);
      if (tokenIndex >= 0) return tokenIndex;
      return sessionGroups[id] ? layout.indexOf(`group:${sessionGroups[id]}`) : -1;
    }).filter((index) => index >= 0);
    const index = indexes.length ? Math.min(...indexes) : -1;
    const nextLayout = layout.filter((entry) => !selectedTokens.has(entry));
    nextLayout.splice(index < 0 ? nextLayout.length : Math.min(index, nextLayout.length), 0, `group:${group.id}`);
    for (const id of ids) sessionGroups[id] = group.id;
    const anchorToken = index < 0 ? "" : layout[index];
    this.applyLocalProjectStatePatch({
      terminal_groups: [...this.terminalGroups(), group],
      session_groups: sessionGroups,
      terminal_layout: nextLayout,
    });
    this.queueTerminalGroupCreate(group, ids, anchorToken);
    this.renderList();
  }

  removeTerminalGroup(groupId) {
    const group = this.terminalGroups().find((candidate) => candidate.id === groupId);
    if (!group) return;
    this.applyLocalProjectStatePatch(this.terminalGroupDeletionPatch(groupId));
    this.queueTerminalGroupDelete(groupId);
    this.renderList();
  }

  async closeAllInTerminalGroup(groupId) {
    const sessionGroups = this.getProjectState().session_groups || {};
    const sessions = this.sessions.filter((session) => sessionGroups[session.session_id] === groupId);
    if (!sessions.length) return;
    const group = this.terminalGroups().find((candidate) => candidate.id === groupId);
    const label = group?.name || "this group";
    if (!confirm(`Close all ${sessions.length} terminals in "${label}"?`)) return;
    if (!confirm(`Confirm closing all terminals in "${label}". Running agents will be stopped.`)) return;
    const responses = await Promise.all(sessions.map((session) => fetch(`/api/sessions/${session.session_id}`, { method: "DELETE" })));
    if (responses.some((response) => response.ok)) this.restoreLastClosedTerminalNeedsConfirmation = false;
    this.refresh();
  }

  openTerminalGroupContextMenu(event, group) {
    event.preventDefault();
    event.stopPropagation();
    group = this.terminalGroups().find((candidate) => candidate.id === group.id) || group;
    const menu = this.$("context-menu");
    menu.textContent = "";
    this.contextMenuTarget = { type: "group", id: group.id };
    this.addContextItem(menu, this.shortcutLabel("Move group to top", "move-active-to-top"),
      () => this.moveTerminalLayoutToTop(`group:${group.id}`), "arrow-up");
    this.addContextItem(menu, group.collapsed ? "Expand group" : "Collapse group",
      () => this.toggleTerminalGroup(group.id), group.collapsed ? "chevron-down" : "chevron-up");
    this.addContextItem(menu, this.shortcutLabel("Rename group", "rename-terminal"),
      () => this.renameTerminalGroup(group.id), "edit");
    this.addContextItem(menu, this.shortcutLabel("Mark group as unread", "mark-terminal-unread"),
      () => this.markTerminalGroupUnread(group.id), "eye-closed");
    this.addContextItem(menu, this.shortcutLabel("Remove grouping", "create-terminal-group-from-active"),
      () => this.removeTerminalGroup(group.id), "ungroup-by-ref-type");
    this.addContextItem(menu, this.shortcutLabel("Close all", "close-item"),
      () => this.closeAllInTerminalGroup(group.id), "close-all");
    this.positionContextMenu(menu, event.clientX, event.clientY);
  }

  attachGroupDropTarget(element, groupId) {
    element.ondragover = (event) => {
      if (this.dragItem?.type !== "layout" || this.dragItem.kind !== "session") return;
      event.preventDefault();
      this.clearDragLandingIndicator();
      element.classList.add("drop-group");
    };
    element.ondragleave = () => {
      element.classList.remove("drop-group");
      this.clearDragGroupingTimer();
    };
    element.ondrop = (event) => {
      if (this.dragItem?.type !== "layout" || this.dragItem.kind !== "session") return;
      event.preventDefault();
      const sessionIds = this.sessionIdsFromDragItem(this.dragItem);
      this.clearDragLandingIndicator();
      this.moveSelectedSessionsIntoGroup(sessionIds, groupId);
      this.dragItem = null;
    };
  }

  async loadProjects() {
    if (this.vscodeMode) {
      this.projects = [];
      const select = this.$("project-select");
      select.textContent = "";
      select.onchange = null;
      select.disabled = true;
      select.style.display = "none";
      select.classList.add("hidden");
      if (!this.vscodeEditorMode) this.projectSlug = null;
      return;
    }
    try {
      const res = await fetch("/api/projects");
      this.projects = await res.json();
    } catch (err) {
      this.projects = [];
    }
    const select = this.$("project-select");
    select.textContent = "";
    const allOption = document.createElement("option");
    allOption.value = "";
    allOption.textContent = "All projects";
    select.appendChild(allOption);
    for (const p of this.projects) {
      const option = document.createElement("option");
      option.value = p.name;
      option.textContent = p.name;
      option.title = p.root;
      select.appendChild(option);
    }
    this.applyVscodeDefaultProjectState();
    if (this.vscodeMode) {
      select.onchange = null;
      select.disabled = true;
      select.style.display = "none";
      select.classList.add("hidden");
      return;
    }
    select.value = this.projectSlug || "";
    select.onchange = () => {
      location.href = select.value ? `/p/${encodeURIComponent(select.value)}` : "/";
    };
    await this.loadWorktrees();
  }

  async loadWorktrees() {
    const row = this.$("worktree-header-row");
    const select = this.$("worktree-select");
    if (!row || !select || !this.projectSlug || this.vscodeMode) {
      this.worktrees = [];
      row?.classList.add("hidden");
      this.updateHeaderAddMenu();
      return;
    }
    try {
      const response = await fetch(`/api/worktrees?project=${encodeURIComponent(this.projectSlug)}`);
      if (!response.ok) throw new Error("worktree list failed");
      this.worktrees = await response.json();
    } catch (error) {
      this.worktrees = [];
    }
    select.textContent = "";
    const availableWorktrees = this.worktrees.filter((worktree) => worktree.available);
    if (availableWorktrees.length > 1) {
      const allOption = document.createElement("option");
      allOption.value = ALL_WORKTREES_ID;
      allOption.textContent = "All worktrees";
      allOption.title = "Show terminals and closed sessions from every worktree";
      select.appendChild(allOption);
    }
    for (const worktree of this.worktrees) {
      const option = document.createElement("option");
      option.value = worktree.id;
      option.textContent = worktree.branch || worktree.name || worktree.path;
      option.title = `${worktree.branch || worktree.path}\n${worktree.path}`;
      if (!worktree.available) {
        option.textContent += " (missing)";
        option.disabled = true;
      }
      select.appendChild(option);
    }
    const requestedWorktreeUrlSegment = this.requestedWorktreeUrlSegment;
    const requestedWorktree = this.worktreeForUrlSegment(requestedWorktreeUrlSegment);
    if (requestedWorktreeUrlSegment && !requestedWorktree) {
      throw new Error(`unknown or ambiguous worktree URL segment: ${requestedWorktreeUrlSegment}`);
    }
    if (requestedWorktree) this.worktreeId = requestedWorktree.id;
    this.requestedWorktreeUrlSegment = "";
    if (!this.worktrees.length) {
      row.classList.add("hidden");
      this.updateHeaderAddMenu();
      return;
    }
    const saved = this.settings.selected_worktrees?.[this.projectSlug] ||
      localStorage.getItem(`termdeck.${this.projectSlug}.worktree_id`) || "";
    const availableIds = new Set(availableWorktrees.map((worktree) => worktree.id));
    if (availableWorktrees.length > 1) availableIds.add(ALL_WORKTREES_ID);
    if (!availableIds.has(this.worktreeId)) this.worktreeId = availableIds.has(saved) ? saved : "root";
    if (!availableIds.has(this.worktreeId)) this.worktreeId = "root";
    select.value = this.worktreeId;
    row.classList.remove("hidden");
    this.updateHeaderAddMenu();
    select.onchange = () => this.switchWorktree(select.value);
  }

  async switchWorktree(worktreeId) {
    if (worktreeId === ALL_WORKTREES_ID && this.worktrees.filter((worktree) => worktree.available).length > 1) {
      this.worktreeId = ALL_WORKTREES_ID;
    } else {
      const selected = this.worktrees.find((worktree) => worktree.id === worktreeId);
      if (!selected || !selected.available) return;
      this.worktreeId = selected.id;
    }
    this.interactionWorktreeId = this.worktreeId === ALL_WORKTREES_ID ? this.interactionWorktreeId : this.worktreeId;
    this.disconnectRecentFilesWatch();
    this.unreadSessions = this.unreadSessionIdsForCurrentWorktreeView();
    this.settings.selected_worktrees = { ...(this.settings.selected_worktrees || {}), [this.projectSlug]: this.worktreeId };
    this.saveSettings();
    localStorage.setItem(`termdeck.${this.projectSlug}.worktree_id`, this.worktreeId);
    history.pushState({ kind: "init" }, "", this.navUrl({ kind: "init" }));
    this.activeId = null;
    this.activeFileKey = null;
    this.openFiles.clear();
    this.treeRoot = null;
    await this.refresh();
    this.setSideView("terminals", false);
  }

  async addProjectFromHeader() {
    await this.chooseProjectFolder();
  }

  updateHeaderAddMenu() {
    const button = this.$("header-add-worktree");
    if (!button) return;
    const rootWorktree = this.worktrees.find((worktree) => worktree.is_root);
    const gitAvailable = !!this.projectSlug && !this.vscodeMode && !!rootWorktree && rootWorktree.git_repository !== false;
    button.disabled = !gitAvailable;
    button.title = gitAvailable ? "Create a worktree" : "Select a Git project to create a worktree";
    this.updateHeaderAddShortcutLabels();
  }

  updateHeaderAddShortcutLabels() {
    const actions = [["header-add-project", "new-project"], ["header-add-worktree", "new-worktree"],
      ["header-add-terminal", "new-terminal"]];
    for (const [id, actionId] of actions) {
      const shortcut = this.$(id)?.querySelector(".header-add-shortcut");
      if (shortcut) shortcut.textContent = this.bindingToDisplay(this.bindingFor(actionId));
    }
  }

  closeHeaderAddMenu() {
    this.$("header-add-menu")?.classList.add("hidden");
  }

  positionHeaderAddMenu() {
    const menu = this.$("header-add-menu");
    const button = this.$("project-add-btn");
    const header = this.$("sidebar-header");
    if (!menu || !button || !header) return;
    const buttonBounds = button.getBoundingClientRect();
    const headerBounds = header.getBoundingClientRect();
    menu.style.left = `${buttonBounds.left - headerBounds.left}px`;
    menu.style.top = `${buttonBounds.bottom - headerBounds.top + 4}px`;
  }

  toggleHeaderAddMenu() {
    const menu = this.$("header-add-menu");
    if (!menu) return;
    menu.classList.toggle("hidden");
    if (!menu.classList.contains("hidden")) {
      this.updateHeaderAddMenu();
      this.positionHeaderAddMenu();
    }
  }

  runHeaderAddAction(action) {
    this.closeHeaderAddMenu();
    if (action === "project") void this.addProjectFromHeader();
    else if (action === "worktree") this.openWorktreeModal();
    else if (action === "terminal") this.openModal();
  }

  openWorktreeModal() {
    this.closeHeaderAddMenu();
    if (!this.projectSlug || this.vscodeMode) return;
    const project = this.projects.find((candidate) => candidate.name === this.projectSlug);
    if (!project) return;
    const rootWorktree = this.worktrees.find((worktree) => worktree.is_root);
    if (rootWorktree && rootWorktree.git_repository === false) {
      alert(`Project "${project.name}" is not a Git repository. Select the repository folder containing .git first.`);
      return;
    }
    this.$("worktree-modal-project").textContent = `${project.name} · ${this.compactProjectPath(project.root)}`;
    this.$("worktree-base-ref").value = rootWorktree?.branch || "";
    this.$("worktree-branch").value = "";
    this.$("worktree-modal-backdrop").classList.remove("hidden");
    void this.loadWorktreeBranches();
    requestAnimationFrame(() => this.$("worktree-base-ref").focus());
  }

  async loadWorktreeBranches() {
    const options = this.$("worktree-base-ref-options");
    if (!options || !this.projectSlug) return;
    try {
      const response = await fetch(`/api/worktrees/branches?project=${encodeURIComponent(this.projectSlug)}`);
      if (!response.ok) return;
      const payload = await response.json();
      options.textContent = "";
      const branches = Array.isArray(payload.branches) ? payload.branches : [];
      for (const branch of branches.slice(0, 300)) {
        const option = document.createElement("option");
        option.value = branch;
        options.appendChild(option);
      }
      const baseRef = this.$("worktree-base-ref");
      if (!baseRef.value && payload.current) baseRef.value = payload.current;
    } catch (error) {
      return;
    }
  }

  closeWorktreeModal() {
    this.$("worktree-modal-backdrop").classList.add("hidden");
  }

  async createProjectWorktree() {
    const baseRef = this.$("worktree-base-ref").value.trim();
    const branch = this.$("worktree-branch").value.trim();
    const response = await fetch("/api/worktrees", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: this.projectSlug, branch, base_ref: baseRef }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      alert(payload.detail || "worktree creation failed");
      return;
    }
    this.closeWorktreeModal();
    await this.loadWorktrees();
    const worktreeSegment = payload.branch || payload.name || payload.id;
    const url = new URL(`/p/${encodeURIComponent(this.projectSlug)}/${encodeURIComponent(worktreeSegment)}`, location.href);
    this.$("worktree-result-title").textContent = "Worktree created";
    const link = this.$("worktree-result-link");
    this.$("worktree-result-name").textContent = `${payload.name || payload.branch} · ${payload.branch || "new branch"}`;
    link.href = url.href;
    link.textContent = url.href;
    link.title = url.href;
    this.$("worktree-result-hint").textContent = "Click to open here. Command/Ctrl-click or middle-click opens a new tab; right-click can open a new window.";
    this.$("worktree-result-path").textContent = payload.path || "";
    this.$("worktree-result-backdrop").classList.remove("hidden");
    requestAnimationFrame(() => this.$("worktree-result-link").focus());
  }

  closeWorktreeResult() {
    this.$("worktree-result-backdrop").classList.add("hidden");
  }

  async deleteSelectedWorktree() {
    const selected = this.worktrees.find((worktree) => worktree.id === this.worktreeId);
    if (!selected || selected.is_root) return;
    if (!window.confirm(`Remove worktree "${selected.name}"? Terminals in it must be closed first.`)) return;
    const moveToTrash = window.confirm("Move the worktree folder to the macOS Trash? Cancel keeps the files but detaches the worktree.");
    const response = await fetch(`/api/worktrees/${encodeURIComponent(selected.id)}`, {
      method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: this.projectSlug, move_to_trash: moveToTrash }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      alert(payload.detail || "worktree deletion failed");
      return;
    }
    this.worktreeId = "root";
    localStorage.setItem(`termdeck.${this.projectSlug}.worktree_id`, "root");
    await this.loadWorktrees();
    await this.switchWorktree("root");
  }

  projectRoot() {
    const p = this.projects.find((x) => x.name === this.projectSlug);
    return p ? p.root : null;
  }

  worktreeRoot() {
    const selectedId = this.worktreeId === ALL_WORKTREES_ID ? this.interactionWorktreeId : (this.worktreeId || "root");
    const selected = this.worktrees.find((worktree) => worktree.id === selectedId && worktree.available);
    return selected?.path || this.projectRoot();
  }

  fileDeckProjectForRoot(root) {
    const normalized = String(root || "").replace(/\\/g, "/").replace(/\/+$/, "");
    return this.projects
      .filter((project) => {
        const projectRoot = String(project.root || "").replace(/\\/g, "/").replace(/\/+$/, "");
        return normalized === projectRoot || normalized.startsWith(projectRoot + "/");
      })
      .sort((left, right) => String(right.root || "").length - String(left.root || "").length)[0] || null;
  }

  openFileDeckInNewTab(root, relativePath = "") {
    this.openFileDeckViewInNewTab(root, "tree", relativePath);
  }

  projectRelativeFilePath(project, root, relativePath) {
    const projectRoot = String(project.root || "").replace(/\\/g, "/").replace(/\/+$/, "");
    const currentRoot = String(root || "").replace(/\\/g, "/").replace(/\/+$/, "");
    const nestedRoot = currentRoot === projectRoot ? "" :
      currentRoot.startsWith(`${projectRoot}/`) ? currentRoot.slice(projectRoot.length + 1) : "";
    return [nestedRoot, String(relativePath || "").replace(/^\/+/, "")].filter(Boolean).join("/");
  }

  openFileDeckViewInNewTab(root, view, relativePath = "", searchQuery = "") {
    const project = this.fileDeckProjectForRoot(root) || this.projects.find((candidate) => candidate.name === this.projectSlug);
    if (!project) return;
    const params = new URLSearchParams();
    params.set("view", view === "tree" ? "project" : view);
    params.set("pinned", "1");
    const selectedWorktreeId = this.worktreeId && this.worktreeId !== ALL_WORKTREES_ID && root === this.worktreeRoot()
      ? this.worktreeId : "root";
    const basePath = project.name === this.projectSlug
      ? this.encodedProjectWorktreePath(project.name, selectedWorktreeId)
      : `/p/${encodeURIComponent(project.name)}/${encodeURIComponent(selectedWorktreeId)}`;
    let navigationPath = "";
    if (relativePath) {
      const fileRoot = this.worktreeId && this.worktreeId !== "root" && this.worktreeId !== ALL_WORKTREES_ID && root === this.worktreeRoot() ? root : project.root;
      const filePath = fileRoot === root ? relativePath : this.projectRelativeFilePath(project, root, relativePath);
      if (fileRoot === root) navigationPath = this.encodedRelativeFilePath(filePath);
      else params.set("f", `${fileRoot}|${filePath}`);
    }
    if (searchQuery) params.set("q", searchQuery);
    const query = params.toString() ? `?${params}` : "";
    window.open(`${basePath}${navigationPath ? `/${navigationPath}` : ""}${query}`, "_blank", "noopener,noreferrer");
  }

  openFileDeckView(view) {
    const project = this.fileDeckProjectForRoot(this.worktreeRoot() || this.sessions.find((session) => session.session_id === this.activeId)?.cwd) ||
      this.projects.find((candidate) => candidate.name === this.projectSlug);
    if (!project) return;
    this.setSideView(view === "tree" ? "project" : view, false);
  }

  openTerminalInNewTab(session) {
    const project = this.projects.find((candidate) => candidate.name === session.project) ||
      this.fileDeckProjectForRoot(session.cwd);
    if (!project) return;
    const worktreeSegment = project.name === this.projectSlug
      ? this.worktreeUrlSegment(session.worktree_id || "root")
      : String(session.worktree_branch || session.worktree_id || "root");
    const sessionName = this.titlePresentation(session).text.trim();
    const fragment = sessionName ? `#${encodeURIComponent(sessionName)}` : "";
    window.open(`/p/${encodeURIComponent(project.name)}/${encodeURIComponent(worktreeSegment)}/${encodeURIComponent(session.session_id)}${fragment}`,
      "_blank", "noopener,noreferrer");
  }

  handleFileDeckAuxClick(event, root, relativePath = "") {
    if (event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    this.openFileDeckInNewTab(root, relativePath);
  }

  handleNavigationAuxClick(event, view) {
    if (event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    if (view === "terminals") {
      const session = this.session(this.activeId);
      if (session) this.openTerminalInNewTab(session);
      return;
    }
    const entry = this.activeFileKey !== null ? this.openFiles.get(this.activeFileKey) : null;
    const root = entry?.root || this.treeRoot || this.projectRoot();
    if (!root) return;
    if (view === "project" && entry) this.openFileDeckViewInNewTab(root, "tree", entry.path);
    else this.openFileDeckViewInNewTab(root, view === "project" ? "tree" : view,
      "", view === "search" ? this.$("search-query").value.trim() : "");
  }

  compactProjectPath(root) {
    return String(root || "").replace(/^\/Users\/[^/]+/, "~");
  }

  projectForCwd(cwd) {
    const normalized = String(cwd || "").replace(/\\/g, "/").replace(/\/+$/, "");
    return this.projects
      .filter((project) => {
        const root = String(project.root || "").replace(/\\/g, "/").replace(/\/+$/, "");
        return normalized === root || normalized.startsWith(root + "/");
      })
      .sort((a, b) => String(b.root || "").length - String(a.root || "").length)[0] || null;
  }

  async chooseProjectFolder() {
    if (this.vscodeMode) return;
    const button = this.$("project-add-btn");
    if (button?.disabled) return;
    if (button) button.disabled = true;
    try {
      const res = await fetch("/api/projects/pick-folder", { method: "POST" });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(payload.detail || "failed to choose project folder");
        return;
      }
      if (payload.cancelled) return;
      const project = payload.project;
      if (!project?.name) {
        alert("native folder selection returned no project");
        return;
      }
      await this.loadProjects();
      const url = new URL(`/p/${encodeURIComponent(project.name)}`, location.href);
      this.$("worktree-result-title").textContent = "Project added";
      this.$("worktree-result-name").textContent = project.name;
      const link = this.$("worktree-result-link");
      link.href = url.href;
      link.textContent = url.href;
      link.title = url.href;
      this.$("worktree-result-hint").textContent = "Click to open here. Command/Ctrl-click or middle-click opens a new tab; right-click can open a new window.";
      this.$("worktree-result-path").textContent = project.root || "";
      this.$("worktree-result-backdrop").classList.remove("hidden");
      requestAnimationFrame(() => link.focus());
    } catch (error) {
      alert(error.message || "failed to choose project folder");
    } finally {
      if (button) button.disabled = false;
    }
  }

  async init() {
    this.initInlineSizeControls();
    window.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (!this.settings.inline_size_controls && !this.fontSizeEditorOpen) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (this.settings.inline_size_controls) this.exitInlineSizeControls();
      else {
        this.fontSizeEditorOpen = false;
        this.$("settings-popover").classList.add("hidden");
      }
    }, true);
    window.addEventListener("message", this.handleHostMessageBound, false);
    window.addEventListener("pagehide", () => {
      this.disconnectRecentFilesWatch();
      this.flushPendingSettingsSave();
      this.flushPendingFileSavesOnPageExit();
      this.flushPendingSearchHistoryRecord();
    });
    window.addEventListener("beforeunload", () => {
      this.flushPendingSettingsSave();
      this.flushPendingFileSavesOnPageExit();
      this.flushPendingSearchHistoryRecord();
    });
    document.body.classList.toggle("termdeck-page-hidden", document.hidden);
    document.addEventListener("visibilitychange", () => {
      document.body.classList.toggle("termdeck-page-hidden", document.hidden);
      if (document.visibilityState === "hidden") {
        this.disconnectRecentFilesWatch();
        this.flushPendingSettingsSave();
        this.flushPendingFileSavesOnPageExit();
        this.flushPendingSearchHistoryRecord();
        } else {
        this.updateRecentFilesWatch();
        void this.refreshCurrentProjectState();
        if (!this.sectionCollapsed("recent_files_collapsed")) void this.refreshRecentFiles(true);
      }
    });
    await this.loadSettings();
    this.loadSearchHistory();
    await this.loadProjects();
    this.applyVscodeModeLayout();
    if (!this.vscodeMode) {
      this.restoreOpenFiles();
      this.initMonaco();
      this.loadIconMap();
    }
    this.$("settings-gear").onclick = (e) => this.openSettingsPopover(e.currentTarget,
      [{ label: "Terminal font", key: "terminal_font_size" }, { label: "Terminal icon size", key: "terminal_icon_size", type: "scale" },
       { label: "Code font", key: "code_font_size" },
       { label: "Terminal list font", key: "sidebar_font_size" }, { label: "Project title font", key: "project_font_size" },
       { label: "Tree/search font", key: "tree_font_size" }, { label: "Files / Search tabs font", key: "files_tab_font_size" },
       { label: "Diff font", key: "diff_font_size" }, { label: "System / status font", key: "ui_font_size" },
       { label: "UI icons / spacing", key: "bottom_font_size", type: "scale" }]);
    // Null-safe: #file-view-close is not in index.html yet. This runs during setup, so the throw
    // aborted the rest of this initialisation rather than just failing one button.
    const fileViewClose = this.$("file-view-close");
    if (fileViewClose) fileViewClose.onclick = () => this.navigateBackFromActiveFile();
    this.$("file-history-toggle").onclick = () => this.toggleFileHistory();
    this.$("file-history-close").onclick = () => this.closeFileHistory();
    this.$("file-history-git-toggle").onclick = () => this.toggleFileHistoryMode();
    this.$("file-history-diff-previous").onclick = () => this.navigateFileHistoryDiff(-1);
    this.$("file-history-diff-next").onclick = () => this.navigateFileHistoryDiff(1);
    this.$("file-history-diff-undo-block").onclick = () => this.undoFileHistoryDiffBlock();
    this.$("file-history-diff-undo-line").onclick = () => this.undoFileHistoryDiffLine();
    this.initNotebook();
    this.initSelectionActions();
    this.initIdeFeatures();
    for (const view of ["terminals", "project", "search", "git"]) {
      this.$("view-" + view).onclick = () => {
        if (view === "terminals") {
          this.setSideView(view);
          return;
        }
        if (this.sideView === view) {
          this.openFilesSidePanelView(view);
          return;
        }
       if (view === "search") {
         this.openSearchSidePanelFromNavigation();
         return;
       }
       if (view === "project" && this.searchFileFromSelection()) {
         return;
       }
        this.openFilesSidePanelView(view);
      };
      this.$("view-" + view).onauxclick = (event) => this.handleNavigationAuxClick(event, view);
    }
    this.$("view-git").onclick = () => this.openFilesSidePanelView("git");
    this.$("view-git").onauxclick = (event) => this.handleNavigationAuxClick(event, "git");
    for (const [view, id] of [["project", "files-tab-project"], ["search", "files-tab-search"], ["git", "files-tab-git"]]) {
      const button = this.$(id);
      if (!button) continue;
      button.onclick = () => {
        if (this.sideView === view) {
          this.openFilesSidePanelView(view);
          return;
        }
        if (view === "search") {
          this.openSearchSidePanelFromNavigation();
          return;
        }
        if (view === "project" && this.searchFileFromSelection()) return;
        this.openFilesSidePanelView(view);
      };
      button.onauxclick = (event) => this.handleNavigationAuxClick(event, view);
    }
    const replaceToggle = this.$("replace-toggle");
    replaceToggle.onclick = () => {
      const bar = this.$("replace-bar");
      bar.classList.toggle("hidden");
      replaceToggle.classList.toggle("on", !bar.classList.contains("hidden"));
    };
    this.$("view-terminals").classList.add("on");
    this.$("vscode-refresh-btn").onclick = () => this.requestVscodeRefresh(false);
    this.$("project-add-btn").onclick = (event) => {
      event.stopPropagation();
      this.toggleHeaderAddMenu();
    };
    this.$("header-add-project").onclick = () => this.runHeaderAddAction("project");
    this.$("header-add-worktree").onclick = () => this.runHeaderAddAction("worktree");
    this.$("header-add-terminal").onclick = () => this.runHeaderAddAction("terminal");
    this.updateHeaderAddMenu();
    const queryInput = this.$("search-query");
    queryInput.autocomplete = "off";
    queryInput.autocapitalize = "off";
    queryInput.autocorrect = "off";
    queryInput.addEventListener("keydown", (e) => {
      if (this.handleFileSearchNavigation(e, "content")) return;
      if (e.key === "Enter") {
        e.preventDefault();
        clearTimeout(this.searchDebounce);
        if (!this.activateFileSearchSelection("content")) this.runSearch();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        if (!this.closeUnpinnedFilesPanelAndFocusEditor()) {
          queryInput.value = "";
          this.setExplorerMode("tree");
        }
      }
    });
    queryInput.addEventListener("input", () => this.debouncedSearch());
    this.syncFileGlobInputs();
    this.$("file-type-filter-button").onclick = (event) => this.toggleFileTypeFilterMenu(event.currentTarget);
    this.$("search-file-type-filter-button").onclick = (event) => this.toggleFileTypeFilterMenu(event.currentTarget);
    this.$("minimize-toggle").onclick = () => this.setSideView("terminals");
    const wordBtn = this.$("search-word-toggle"), caseBtn = this.$("search-case-toggle"), regexBtn = this.$("search-regex-toggle");
    wordBtn.onclick = () => { this.searchWord = !this.searchWord; wordBtn.classList.toggle("on", this.searchWord); };
    caseBtn.onclick = () => { this.searchCase = !this.searchCase; caseBtn.classList.toggle("on", this.searchCase); };
    regexBtn.onclick = () => { this.searchRegex = !this.searchRegex; regexBtn.classList.toggle("on", this.searchRegex); };
    const nameInput = this.$("search-name");
    nameInput.autocomplete = "off";
    nameInput.autocapitalize = "off";
    nameInput.autocorrect = "off";
    const nameCaseBtn = this.$("name-case-toggle");
    nameCaseBtn.onclick = () => {
      this.nameSearchCase = !this.nameSearchCase;
      nameCaseBtn.classList.toggle("on", this.nameSearchCase);
      if (nameInput.value.trim()) void this.runNameSearch();
    };
    nameInput.addEventListener("keydown", (e) => {
      if (this.handleFileSearchNavigation(e, "name")) return;
      if (e.key === "Enter") {
        e.preventDefault();
        if (!this.activateFileSearchSelection("name")) this.runNameSearch();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        if (!this.closeUnpinnedFilesPanelAndFocusEditor()) {
          nameInput.value = "";
          this.setExplorerMode("tree");
        }
      }
    });
    nameInput.addEventListener("input", () => this.debouncedNameSearch());
    this.$("search-history-btn").onclick = (event) => this.toggleSearchHistory(event.currentTarget);
    this.$("name-search-history-btn").onclick = (event) => this.toggleSearchHistory(event.currentTarget);
    this.$("replace-all-btn").onclick = () => this.replaceAll();
    this.$("search-back").onclick = () => this.prevSearch();
    const mtimeBtn = this.$("mtime-toggle");
    mtimeBtn.classList.toggle("on", !this.settings.show_mtime);
    mtimeBtn.title = this.settings.show_mtime ? "Hide last-modified times" : "Show last-modified times";
    mtimeBtn.setAttribute("aria-label", mtimeBtn.title);
    mtimeBtn.onclick = () => {
      this.settings.show_mtime = !this.settings.show_mtime;
      mtimeBtn.classList.toggle("on", !this.settings.show_mtime);
      mtimeBtn.title = this.settings.show_mtime ? "Hide last-modified times" : "Show last-modified times";
      mtimeBtn.setAttribute("aria-label", mtimeBtn.title);
      this.saveSettings();
      this.rerenderTree();
    };
    const treeSortBtn = this.$("tree-sort-toggle");
    treeSortBtn.onclick = () => {
      this.settings.file_tree_sort = this.settings.file_tree_sort === "mtime" ? "name" : "mtime";
      this.updateTreeSortButton();
      this.saveSettings();
      if (this.sideView === "project" && this.$("search-name").value.trim()) void this.runNameSearch();
      else if (this.sideView === "search" && this.$("search-query").value.trim()) void this.runSearch(null, true);
      else this.rerenderTree();
    };
    this.updateTreeSortButton();
    const hideBtn = this.$("hide-excluded-toggle");
    hideBtn.classList.toggle("on", !this.settings.hide_excluded);
    hideBtn.title = this.settings.hide_excluded ? "Show excluded folders" : "Hide excluded folders";
    hideBtn.setAttribute("aria-label", hideBtn.title);
    hideBtn.onclick = () => {
      this.settings.hide_excluded = !this.settings.hide_excluded;
      hideBtn.classList.toggle("on", !this.settings.hide_excluded);
      hideBtn.title = this.settings.hide_excluded ? "Show excluded folders" : "Hide excluded folders";
      hideBtn.setAttribute("aria-label", hideBtn.title);
      this.saveSettings();
      this.rerenderTree();
    };
    this.updateHideDotButton();
    this.$("files-pin-toggle").onclick = () => this.toggleFilesPinned();
    this.updateFilesPinButton();
    this.$("git-refresh").onclick = () => void this.loadGitSidePanel();
    this.$("files-tree").addEventListener("contextmenu", (e) => {
      const row = e.target.closest(".tree-row");
      if (row && row.dataset.rel) this.openTreeContextMenu(e, row);
    });
    this.$("main").addEventListener("pointerdown", (e) => {
      if (e.target.closest("#editor-area, #terminal-area, #history-area")) this.dismissUnpinnedFilesPanel();
    });
    this.initResizer("sidebar-resizer", "sidebar_width", false, 236, 520);
    const filesPanelResizer = this.$("files-section-resizer");
    if (filesPanelResizer) {
      filesPanelResizer.onpointerdown = this.startFilesPanelResize.bind(this);
      filesPanelResizer.onpointermove = this.resizeFilesPanelFromPointer.bind(this);
      filesPanelResizer.onpointerup = this.finishFilesPanelResize.bind(this);
      filesPanelResizer.onpointercancel = this.finishFilesPanelResize.bind(this);
    }
    this.initSideSplit();
    if (!this.vscodeMode) {
      this.updateRecentFilesWatch();
      this.terminalAgeRefreshTimer = window.setInterval(() => {
        this.updateSessionAgeStyles();
        this.updateActiveTerminalAge();
      }, TERMINAL_AGE_REFRESH_MS);
    }
    this.$("session-list").addEventListener("scroll", () => this.hideTerminalSearchHoverPopup(), { passive: true });
    setInterval(() => this.pollStats(), STATS_POLL_MS);
    this.pollStats();
    document.addEventListener("mousedown", (e) => {
      for (const id of ["settings-popover", "context-menu"]) {
        const pop = this.$(id);
        if (!pop.classList.contains("hidden") && !pop.contains(e.target)) {
          pop.classList.add("hidden");
          if (id === "settings-popover") this.fontSizeEditorOpen = false;
          if (id === "context-menu") this.contextMenuTarget = null;
        }
      }
      const headerAddMenu = this.$("header-add-menu");
      if (headerAddMenu && !headerAddMenu.classList.contains("hidden") && !headerAddMenu.contains(e.target) &&
          !this.$("project-add-btn")?.contains(e.target)) this.closeHeaderAddMenu();
      const promptHistory = this.$("history-prompt-history");
      const promptHistoryButton = this.$("history-prompt-history-btn");
      if (promptHistory && !promptHistory.classList.contains("hidden") &&
          !promptHistory.contains(e.target) && !promptHistoryButton?.contains(e.target)) this.closePromptHistory();
      const selectionActions = this.$("selection-actions");
      if (selectionActions && !selectionActions.classList.contains("hidden") && !selectionActions.contains(e.target)) {
        this.hideSelectionActions();
      }
      const searchHistoryMenu = this.$("search-history-menu");
      if (searchHistoryMenu && !searchHistoryMenu.classList.contains("hidden") &&
          !searchHistoryMenu.contains(e.target) && !e.target.closest("#search-history-btn, #name-search-history-btn")) {
        this.closeSearchHistory();
      }
      const fileTypeMenu = this.$("file-type-filter-menu");
      if (fileTypeMenu && !fileTypeMenu.classList.contains("hidden") && !fileTypeMenu.contains(e.target) &&
          !e.target.closest("#file-type-filter-button, #search-file-type-filter-button, #recent-file-type-filter-button")) {
        this.closeFileTypeFilterMenu();
      }
      const notebookPanel = this.$("notebook-panel");
      const notebookToggle = this.$("notebook-toggle");
      if (this.settings.notebook_open && notebookPanel && !notebookPanel.contains(e.target) &&
          !notebookToggle?.contains(e.target)) this.setNotebookOpen(false, { focus: false });
      const fileHistoryPanel = this.$("file-history-panel");
      const fileHistoryToggle = this.$("file-history-toggle");
      if (this.fileHistoryOpen && fileHistoryPanel && !fileHistoryPanel.contains(e.target) &&
          !fileHistoryToggle?.contains(e.target)) this.closeFileHistory();
    });
    this.$("history-search-close").onclick = () => this.closeHistorySearchContext();
    this.$("history-search-open").onclick = () => this.openHistorySearchSession();
    this.$("history-search-backdrop").onclick = (event) => {
      if (event.target === this.$("history-search-backdrop")) this.closeHistorySearchContext();
    };
    this.$("modal-cancel").onclick = () => this.closeModal();
    this.$("modal").addEventListener("submit", (event) => {
      event.preventDefault();
      void this.createSession();
    });
    this.$("modal-model").onchange = () => { this.clearModalError(); this.updateModalPermissions(); };
    this.$("worktree-modal-cancel").onclick = () => this.closeWorktreeModal();
    this.$("worktree-modal-create").onclick = () => void this.createProjectWorktree();
    this.$("worktree-modal-backdrop").addEventListener("mousedown", (event) => {
      if (event.target === this.$("worktree-modal-backdrop")) this.closeWorktreeModal();
    });
    this.$("worktree-result-close").onclick = () => this.closeWorktreeResult();
    this.$("worktree-result-backdrop").addEventListener("mousedown", (event) => {
      if (event.target === this.$("worktree-result-backdrop")) this.closeWorktreeResult();
    });
    for (const id of ["history-btn", "vscode-history-btn"]) {
      const button = this.$(id);
      if (button) {
        button.onmousedown = (event) => event.preventDefault();
        button.onclick = () => {
          void this.toggleHistory().finally(() => this.refocusActiveInputAfterToolbarAction());
        };
      }
    }
    this.updateShortcutTitles();
    this.$("history-edits-toggle").onclick = () => this.toggleHistoryEdits();
    this.$("history-scroll-bottom").onmousedown = (event) => event.preventDefault();
    this.$("history-scroll-bottom").onclick = () => {
      this.scrollHistoryToBottom();
      this.refocusActiveInputAfterToolbarAction();
    };
    this.$("history-body").addEventListener("scroll", () => {
      if (this.historyOpen && this.$("history-body").scrollTop < 80) this.loadOlderHistory();
    });
    this.$("history-body").addEventListener("click", (event) => this.handleHistoryFileLink(event));
    for (const id of ["terminal-resync-btn", "vscode-terminal-resync-btn"]) {
      const button = this.$(id);
      if (button) {
        button.onmousedown = (event) => event.preventDefault();
        button.onclick = () => {
          this.resyncActiveTerminal();
          this.refocusActiveInputAfterToolbarAction();
        };
      }
    }
    this.$("editor-wrap-toggle").onclick = () => {
      this.settings.editor_no_wrap = !this.settings.editor_no_wrap;
      this.applySettings({ fitTerminals: false });
      this.saveSettings();
    };
    this.$("terminal-find-input").addEventListener("input", () => this.updateTerminalFindMatches());
    this.$("terminal-find-input").addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.closeTerminalFind();
      } else if (event.key === "Enter") {
        event.preventDefault();
        this.moveTerminalFindMatch(event.shiftKey ? -1 : 1);
      }
    });
    this.$("terminal-find-previous").onclick = () => this.moveTerminalFindMatch(-1);
    this.$("terminal-find-next").onclick = () => this.moveTerminalFindMatch(1);
    this.$("terminal-find-close").onclick = () => this.closeTerminalFind();
    this.$("kill-stale-terminals-btn").onclick = () => void this.killStaleTerminals();
    this.$("history-send").onclick = () => this.sendHistoryPrompt();
    this.$("history-queue-btn").onclick = () => this.sendHistoryPrompt({ queue: true });
    this.$("history-prompt-history-btn").onclick = () => this.togglePromptHistory();
    this.$("history-prompt").addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        const view = this.views.get(this.activeId);
        if (view) {
          this.sendInput(view, "\x1b");
          this.historyPendingProcessing.delete(this.activeId);
          this.updateHistoryThinkingIndicator();
          view.keepBottom = true;
          view.pinBottomUntil = Date.now() + 3000;
        }
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        this.sendHistoryPrompt({ queue: true });
        return;
      }
      if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.metaKey && !e.ctrlKey && !e.altKey &&
          !this.$("history-prompt").value && this.views.get(this.activeId)?.promptQueue?.length) {
        e.preventDefault();
        e.stopPropagation();
        const view = this.views.get(this.activeId);
        const queueLength = view.promptQueue.length;
        const current = Number.isInteger(view.promptQueueEditIndex) ? view.promptQueueEditIndex :
          (e.key === "ArrowUp" ? queueLength - 1 : 0);
        view.promptQueueEditIndex = Math.max(0, Math.min(queueLength - 1,
          Number.isInteger(view.promptQueueEditIndex) ? current + (e.key === "ArrowUp" ? -1 : 1) : current));
        this.renderHistoryQueue(view);
        requestAnimationFrame(() => {
          const editor = this.$("history-queued-items")?.querySelector(
            `[data-queue-index="${view.promptQueueEditIndex}"] .history-queued-editor`);
          if (editor) {
            editor.focus();
            editor.select();
          }
        });
        return;
      }
      if (e.key !== "Enter" || e.isComposing) return;
      e.stopPropagation();
      if (!e.shiftKey) {
        e.preventDefault();
        this.sendHistoryPrompt({ queue: false });
      }
    }, true);
    const historyPrompt = this.$("history-prompt");
    historyPrompt.addEventListener("paste", (event) => {
      const files = this.historyImageFilesFromDataTransfer(event.clipboardData);
      if (!files.length) return;
      event.preventDefault();
      event.stopPropagation();
      void this.insertHistoryAttachmentFiles(this.views.get(this.activeId), files);
    });
    historyPrompt.addEventListener("dragover", (event) => {
      const files = this.historyImageFilesFromDataTransfer(event.dataTransfer);
      if (!files.length) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
      historyPrompt.classList.add("image-drop-target");
    });
    historyPrompt.addEventListener("dragleave", () => historyPrompt.classList.remove("image-drop-target"));
    historyPrompt.addEventListener("drop", (event) => {
      const files = this.historyImageFilesFromDataTransfer(event.dataTransfer);
      historyPrompt.classList.remove("image-drop-target");
      if (!files.length) return;
      event.preventDefault();
      event.stopPropagation();
      void this.insertHistoryAttachmentFiles(this.views.get(this.activeId), files);
    });
    historyPrompt.addEventListener("input", () => {
      const view = this.views.get(this.activeId);
      if (!view) return;
      this.persistMarkdownPromptDraft(view, this.$("history-prompt").value);
      this.resizeHistoryPrompt();
    });
    this.$("attach-btn").onclick = () => this.historyOpen ? this.attachToHistory() : this.attachToActive();
    this.$("reveal-session-btn").onclick = () => this.revealAndFocusActiveTerminalInSidebar();
    for (const id of ["scroll-bottom-btn", "vscode-scroll-bottom-btn"]) {
      const button = this.$(id);
      if (button) {
        button.onmousedown = (event) => event.preventDefault();
        button.onclick = () => {
          this.scrollActiveToBottom();
          this.refocusActiveInputAfterToolbarAction();
        };
      }
    }
    this.$("keys-btn").onclick = () => this.openKeybindings();
    this.$("keys-done").onclick = () => this.$("keys-backdrop").classList.add("hidden");
    this.$("keys-reset").onclick = () => this.resetKeybindings();
    this.$("keys-search").addEventListener("input", () => this.renderKeybindingsList());
    this.$("keys-backdrop").addEventListener("mousedown", (e) => { if (e.target.id === "keys-backdrop") this.$("keys-backdrop").classList.add("hidden"); });
    this.$("terminal-process-report-close").onclick = () => this.closeTerminalProcessReport();
    this.$("terminal-process-report-backdrop").addEventListener("mousedown", (e) => {
      if (e.target.id === "terminal-process-report-backdrop") this.closeTerminalProcessReport();
    });
    this.$("modal-backdrop").addEventListener("mousedown", (e) => {
      if (e.target.id === "modal-backdrop") this.closeModal();
    });
    document.addEventListener("keydown", (e) => {
      if (this.isDesktopTerminalSelectInputEvent(e)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        this.selectActiveTerminalInputText();
        return;
      }
      if (!this.isDesktopTerminalSelectAllEvent(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      this.selectActiveTerminalText();
    }, true);
    // Every per-element dragleave/drop/dragend only runs when the drag ends on that same element, so a
    // drag released anywhere else — empty sidebar, outside the window, Escape — strands its indicator.
    // Bubble phase, never capture: the drop handlers read .drop-after off the target to decide placement,
    // so this has to run after them.
    for (const endEvent of ["dragend", "drop"]) {
      document.addEventListener(endEvent, () => this.clearDragLandingIndicator(true));
    }
    // Cmd+B is a browser bookmark/sidebar shortcut on macOS. Capture the
    // configured TermDeck bindings before the browser gets a chance to act.
    window.addEventListener("keydown", (e) => {
      if (!e.metaKey || e.ctrlKey || e.altKey || e.key.toLowerCase() !== "b") return;
      if (!this.$("keys-backdrop").classList.contains("hidden") ||
          !this.$("modal-backdrop").classList.contains("hidden")) return;
      const actionId = this.bindingMap()[this.eventToBinding(e)];
      if (actionId !== "new-terminal" && actionId !== "fork-terminal") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      this.runAction(actionId);
    }, true);
    window.addEventListener("keydown", (e) => {
      if (!this.isRecentTerminalsShortcut(e) || !this.$("keys-backdrop").classList.contains("hidden") ||
          !this.$("modal-backdrop").classList.contains("hidden")) return;
      const actionId = this.bindingMap()[this.eventToBinding(e)];
      if (actionId !== "recent-terminals") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      this.runAction(actionId);
    }, true);
    window.addEventListener("keydown", (e) => {
      if (this.vscodeMode || !this.$("keys-backdrop").classList.contains("hidden") ||
          !this.$("modal-backdrop").classList.contains("hidden")) return;
      const actionId = this.bindingMap()[this.eventToBinding(e)];
      if (actionId !== "open-file-search") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      this.runAction(actionId);
    }, true);
    document.addEventListener("keydown", (e) => {
      if (!this.$("keys-backdrop").classList.contains("hidden")) {
        if (e.key === "Escape") this.$("keys-backdrop").classList.add("hidden");
        return;
      }
      // Null-safe because #worktree-review-backdrop is not in index.html yet: without this the throw
      // lands on EVERY keydown and kills every global shortcut below. Compared against false rather than
      // negated -- `!undefined` would be true and swallow all keys when the element is absent.
      if (this.$("worktree-review-backdrop")?.classList.contains("hidden") === false) {
        if (e.key === "Escape") {
          e.preventDefault();
          this.closeWorktreeReview();
        }
        return;
      }
      if (e.key === "Escape" && !this.$("header-add-menu").classList.contains("hidden")) {
        e.preventDefault();
        this.closeHeaderAddMenu();
        return;
      }
      const worktreeResultOpen = !this.$("worktree-result-backdrop").classList.contains("hidden");
      if (worktreeResultOpen) {
        if (e.key === "Escape") this.closeWorktreeResult();
        return;
      }
      const worktreeModalOpen = !this.$("worktree-modal-backdrop").classList.contains("hidden");
      if (worktreeModalOpen) {
        if (e.key === "Escape") this.closeWorktreeModal();
        if (e.key === "Enter") void this.createProjectWorktree();
        return;
      }
      const modalOpen = !this.$("modal-backdrop").classList.contains("hidden");
      if (modalOpen) {
        if (e.key === "Escape") this.closeModal();
        return;
      }
      if (e.key === "Escape" && !this.$("context-menu").classList.contains("hidden")) {
        e.preventDefault();
        e.stopPropagation();
        this.closeContextMenu();
        return;
      }
      if (e.key === "Escape" && this.exitInlineSizeControls()) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (!this.vscodeMode && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f" &&
          this.activeFileKey === null && !this.historyOpen && e.target.closest?.(".xterm")) {
        e.preventDefault();
        e.stopPropagation();
        this.openTerminalFind();
        return;
      }
      if (this.tryAppShortcut(e)) return;
      if (e.key === "Escape" && this.activeFileKey !== null && !e.target.closest?.("#notebook-panel")) {
        e.preventDefault();
        e.stopPropagation();
        this.navigateBackFromActiveFile();
        return;
      }
      if (e.key === "Escape" && this.closeUnpinnedFilesPanelAndFocusEditor()) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (this.isTypingTarget(e)) return;
      const treeVisible = !this.$("files-section").classList.contains("hidden") &&
        !this.$("files-tree").classList.contains("hidden");
      const selectedRel = this.selectedTreeRow?.dataset?.rel;
      if (treeVisible && ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Enter"].includes(e.key) &&
          !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        this.treeKeyNav(e.key);
        return;
      }
      if (treeVisible && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        const nameInput = this.$("search-name");
        nameInput.value += e.key;
        nameInput.focus();
        return;
      }
      if (!selectedRel) return;
      if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key === "Backspace") {
        e.preventDefault();
        this.deleteTreePath(selectedRel);
        return;
      }
      if (!e.ctrlKey || e.metaKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "r") { e.preventDefault(); this.renameTreePath(selectedRel); }
      else if (key === "m") { e.preventDefault(); this.moveTreePath(selectedRel); }
    });
    window.addEventListener("popstate", (e) => this.applyBrowserNavigationState(e.state));
    const startupNav = this.initialNav && this.initialNav.kind !== "file" ? this.initialNav : { kind: "init" };
    this.lastValidNavState = startupNav;
    this.lastNavJson = JSON.stringify(startupNav);
    history.replaceState(startupNav, "", this.navUrl(startupNav));
    const scheduleLayoutFit = () => {
      this.positionFloatingFilesPanel();
      this.scheduleTerminalLayoutFit();
    };
    new ResizeObserver(scheduleLayoutFit).observe(this.$("terminal-area"));
    new ResizeObserver(scheduleLayoutFit).observe(this.$("main"));
    window.addEventListener("resize", scheduleLayoutFit);
    // Every fit/repaint pass in this file runs off requestAnimationFrame or setTimeout, both of
    // which browsers throttle or fully suspend for a backgrounded tab or unfocused window. A
    // repair scheduled while hidden does not fail — it just never runs, or runs late against
    // stale state, until something un-suspends the page. visibilitychange/focus/pageshow fire
    // promptly even from a suspended state (unlike rAF/setTimeout), so they are the one place
    // that can reliably kick the active terminal back into a known-good state on return. This is
    // also the likely reason a manual resize "always" fixes a stuck terminal: resizing requires
    // focusing the window first, which is the trigger this file otherwise never listens for.
    const revalidateActiveTerminalOnReturn = () => {
      if (document.hidden) return;
      const view = this.views.get(this.activeId);
      if (!view || view.closed) return;
      view.forceResizeAfterFit = true;
      this.scheduleTerminalActivationRepair(view, { forceReflow: true });
      this.scheduleActiveTerminalSettleWatchdog(view);
    };
    document.addEventListener("visibilitychange", revalidateActiveTerminalOnReturn);
    window.addEventListener("focus", revalidateActiveTerminalOnReturn);
    window.addEventListener("pageshow", revalidateActiveTerminalOnReturn);
    this.installTerminalSizeDebugOverlay();
    void this.initializeRemoteIdleMode();
    this.refresh().finally(() => this.connectStatusStream());
    setInterval(() => this.refresh(), SESSION_LIST_REFRESH_MS);
  }

  navUrl(state) {
    const params = new URLSearchParams();
    const basePath = this.encodedProjectWorktreePath();
    let navigationPath = "";
    let fragment = "";
    if (state.kind === "term") {
      navigationPath = encodeURIComponent(state.id);
      const session = this.session(state.id);
      const sessionName = session ? this.titlePresentation(session).text.trim() : "";
      if (sessionName) fragment = `#${encodeURIComponent(sessionName)}`;
    } else if (state.kind === "file" || state.kind === "open-file") {
      navigationPath = this.relativeNavigationPathForFileKey(state.key);
      if (!navigationPath && state.key) params.set("f", state.key);
      if (state.kind === "open-file") {
        if (state.view) params.set("view", state.view);
        if (state.pinned) params.set("pinned", "1");
      }
    } else if (state.kind === "path") {
      navigationPath = this.encodedRelativeFilePath(state.selector);
    } else if (state.kind === "files") {
      if (state.view) params.set("view", state.view);
      if (state.pinned) params.set("pinned", "1");
      if (state.q) params.set("q", state.q);
    } else if (state.kind === "search") {
      params.set("q", state.q);
      if (state.glob) params.set("glob", state.glob);
      if (state.word) params.set("w", "1");
      if (state.case_sensitive) params.set("c", "1");
      if (state.regex) params.set("re", "1");
    }
    const qs = params.toString();
    return `${basePath}${navigationPath ? `/${navigationPath}` : ""}${qs ? `?${qs}` : ""}${fragment}`;
  }

  pushNav(state) {
    if (this.applyingHistory) return;
    const json = JSON.stringify(state);
    if (json === this.lastNavJson) return;
    this.lastNavJson = json;
    this.lastValidNavState = state;
    history.pushState(state, "", this.navUrl(state));
  }

  replaceNav(state) {
    const json = JSON.stringify(state);
    this.lastNavJson = json;
    this.lastValidNavState = state;
    history.replaceState(state, "", this.navUrl(state));
  }

  parseNavState(rawState) {
    if (!rawState) return null;
    if (typeof rawState === "object" && !Array.isArray(rawState)) return rawState;
    if (typeof rawState !== "string") return null;
    try {
      const parsed = JSON.parse(rawState);
      return typeof parsed === "object" && parsed && !Array.isArray(parsed) ? parsed : null;
    } catch (_error) {
      return null;
    }
  }

  applyBrowserNavigationState(state) {
    const projectMatch = location.pathname.match(/^\/p\/[^/]+\/([^/]+)/);
    const targetWorktreeUrlSegment = projectMatch?.[1] ? decodeURIComponent(projectMatch[1]) : "";
    const targetWorktree = this.worktreeForUrlSegment(targetWorktreeUrlSegment);
    if (targetWorktreeUrlSegment && !targetWorktree) throw new Error(`unknown or ambiguous worktree URL segment: ${targetWorktreeUrlSegment}`);
    if (targetWorktree && targetWorktree.id !== this.stateWorktreeId()) {
      location.reload();
      return;
    }
    this.applyNavState(state);
  }

  applyNavState(state) {
    if (!state || state.kind === "init") return;
    if (state.kind === "path") {
      const selector = String(state.selector || "");
      if (!selector) return;
      if (this.session(selector)) {
        this.replaceNav({ kind: "term", id: selector });
        this.activate(selector, { history: false });
      } else {
        const root = this.worktreeRoot();
        if (root) {
          this.replaceNav({ kind: "file", key: `${root}|${selector}` });
          void this.openFile(root, selector, null, null, { pinned: true, history: false });
        }
      }
      return;
    }
    if (state.kind === "open-file") {
      const separator = String(state.key || "").indexOf("|");
      if (separator <= 0) return;
      const root = String(state.key).slice(0, separator);
      const path = String(state.key).slice(separator + 1);
      if (state.pinned) this.setFilesPinned(true);
      this.setSideView(["project", "search", "git"].includes(state.view) ? state.view : "project", false);
      void this.openFile(root, path, null, null, { pinned: true, history: false });
      return;
    }
    if (state.kind === "files") {
      if (state.pinned) this.setFilesPinned(true);
      const view = ["project", "search", "git"].includes(state.view) ? state.view : "project";
      this.setSideView(view, false);
      if (view === "search" && state.q) {
        this.$("search-query").value = state.q;
        void this.runSearch(state.q, true);
      }
      return;
    }
    if (state.kind === "file" && !this.openFiles.has(state.key)) {
      const returnId = String(state.return_to || "");
      const fallback = returnId && this.session(returnId)
        ? { kind: "term", id: returnId }
        : (this.lastValidNavState && this.lastValidNavState.kind !== "init"
          ? this.lastValidNavState
          : (this.activeId ? { kind: "term", id: this.activeId } : { kind: "init" }));
      this.replaceNav(fallback);
      return;
    }
    this.applyingHistory = true;
    this.lastNavJson = JSON.stringify(state);
    this.lastValidNavState = state;
    try {
      if (state.kind === "term" && this.session(state.id)) {
        if (state.history_scroll && typeof state.history_scroll === "object") {
          this.historyScrollBySession.set(state.id, state.history_scroll);
        }
        this.activate(state.id, { history: false });
      } else if (state.kind === "file" && this.openFiles.has(state.key)) {
        this.activateFile(state.key, null, { history: false });
      } else if (state.kind === "search") {
        this.searchWord = !!state.word;
        this.searchCase = !!state.case_sensitive;
        this.searchRegex = !!state.regex;
        this.$("search-word-toggle").classList.toggle("on", this.searchWord);
        this.$("search-case-toggle").classList.toggle("on", this.searchCase);
        this.$("search-regex-toggle").classList.toggle("on", this.searchRegex);
        this.setFileGlobForMode("search", state.glob || "");
        if (this.sideView !== "search") {
          this.sideView = "terminals";
          this.setSideView("search");
        }
        this.runSearch(state.q, true);
      }
    } finally {
      this.applyingHistory = false;
    }
  }

  isTypingTarget(e) {
    const target = e.target;
    return target.tagName === "INPUT" || target.tagName === "TEXTAREA" ||
      (target.closest && (target.closest(".xterm") || target.closest("#monaco-host") || target.closest("#notebook-editor-host")));
  }

  async loadIconMap() {
    try {
      const res = await fetch(MATERIAL_ICONS_MAP_URL);
      this.iconMap = await res.json();
    } catch (err) {
      this.iconMap = null;
    }
  }

  fileIconUrl(fileName) {
    let icon = "file";
    if (this.iconMap) {
      const lower = fileName.toLowerCase();
      icon = this.iconMap.fileNames[lower] || null;
      if (!icon) {
        const parts = lower.split(".");
        for (let i = 1; i < parts.length && !icon; i++) icon = this.iconMap.fileExtensions[parts.slice(i).join(".")] || null;
      }
      icon = icon || this.iconMap.file || "file";
    }
    return `${MATERIAL_ICONS_BASE}${icon}.svg`;
  }

  fileTypeIconEl(fileName, cssClass) {
    const img = document.createElement("img");
    img.className = cssClass;
    img.src = this.fileIconUrl(fileName);
    img.onerror = () => { img.src = MATERIAL_ICONS_BASE + "file.svg"; img.onerror = null; };
    return img;
  }

  async refresh() {
    if (!this.initialLoadComplete) this.showInitialLoadingState();
    let sessions, closed;
    try {
      const [sessionsRes, closedRes] = await Promise.all(
        [fetch("/api/sessions" + this.projectQuery()), fetch("/api/closed" + this.projectQuery())]);
      sessions = await sessionsRes.json();
      closed = await closedRes.json();
    } catch (err) {
      if (!this.initialLoadComplete) this.showInitialLoadFailure();
      return;
    }
    this.finishInitialLoadingState();
    const previousSessionListSignature = this.sessionListSignature;
    this.sessions = this.worktreeId === ALL_WORKTREES_ID ? sessions : this.applySessionOrder(sessions);
    this.closedSessions = closed;
    const currentSessionIds = new Set(this.sessions.map((session) => session.session_id));
    const staleUnreadSessionIds = [...this.unreadSessions].filter((sessionId) => !currentSessionIds.has(sessionId));
    if (staleUnreadSessionIds.length) {
      for (const sessionId of staleUnreadSessionIds) this.unreadSessions.delete(sessionId);
      this.persistUnreadSessionDelta(staleUnreadSessionIds, false);
    }
    for (const s of this.sessions) {
      this.cacheSessionModel(s);
      const view = this.views.get(s.session_id);
      if (view && !view.promptEditing && !view.promptSubmitting && !view.promptDraftSyncPending &&
          view.pendingDraftSync === null && view.pendingTerminalDraft === null && view.promptDraft !== (s.draft || "")) {
        view.promptDraft = s.draft || "";
        if (s.session_id === this.activeId && this.historyOpen) this.showPromptDraft(view);
      }
      // The session list already carries the server's authoritative working
      // state. Do not infer it from the CLI title marker: that marker can be
      // restored only after a terminal websocket is opened, which made a
      // browser refresh appear idle until the user clicked that tab.
      const spinning = !s.dormant && s.processing === true;
      const serverNeedsAttention = s.needs_attention === true;
      const previousServerNeedsAttention = this.attentionServerStates.get(s.session_id);
      this.attentionServerStates.set(s.session_id, serverNeedsAttention);
      if (serverNeedsAttention && previousServerNeedsAttention !== true) this.triggerSessionAttention(s.session_id);
      const processingSince = Number(s.processing_since);
      if (processingSince > 0 && !this.processingStates.get(s.session_id) &&
          !this.historyPendingProcessing.has(s.session_id)) {
        this.processingSince.set(s.session_id, processingSince * 1000);
      }
      if (!this.processingStates.has(s.session_id)) {
        this.processingStates.set(s.session_id, spinning);
        if (spinning && !this.processingSince.has(s.session_id)) this.processingSince.set(s.session_id, Date.now());
      }
      else this.updateProcessingState(s.session_id, spinning);
    }
    for (const s of this.closedSessions) this.cacheSessionModel(s);
    const ids = new Set(sessions.map((s) => s.session_id));
    if (this.nativeVscodeMode) {
      for (const existingId of this.nativeSessionIds) {
        if (!ids.has(existingId)) this.postVscodeNativeClose(existingId);
      }
    }
    for (const [id, view] of [...this.views]) {
      if (!ids.has(id)) {
        this.postVscodeNativeClose(id);
        this.destroyView(id, view);
      }
    }
    if (this.activeId && !ids.has(this.activeId)) this.activeId = null;
    if (this.initialNav) {
      const nav = this.initialNav;
      this.initialNav = null;
      this.applyNavState(nav);
    }
    if (!this.activeId && sessions.length && this.activeFileKey === null) {
      const remembered = this.getProjectState().active_session_id;
      this.activate(ids.has(remembered) ? remembered : sessions[0].session_id);
    }
    if (previousSessionListSignature !== this.sessionListSignatureFor(this.sessions) || !this.sessionTitleEls.size) {
      this.renderList();
    } else {
      this.updateSessionRows();
    }
    // Recently modified files are a standalone-only sidebar section.
    if (!this.vscodeMode) this.updateRecentFilesWatch();
    if (this.revealActiveSessionOnLoad) {
      this.revealActiveSessionOnLoad = false;
      this.keepActiveSessionVisible();
    }
    this.renderTopbar();
    if (this.nativeVscodeMode) {
      for (const session of this.sessions) {
        const isActive = this.activeId === session.session_id;
        const visible = this.activeId ? (isActive && !this.historyOpen) : undefined;
        this.postVscodeNativeSession(session, visible);
      }
      this.nativeSessionIds = new Set(this.sessions.map((s) => s.session_id));
    }
    this.scheduleTerminalLayoutFit();
  }

  connectStatusStream() {
    if (this.statusWs && (this.statusWs.readyState === WebSocket.OPEN || this.statusWs.readyState === WebSocket.CONNECTING)) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws/status`);
    this.statusWs = ws;
    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      try {
        const message = JSON.parse(event.data);
        if (message.type === "server_instance") {
          const instanceId = String(message.instance_id || "");
          if (!instanceId) return;
          if (this.serverInstanceId && this.serverInstanceId !== instanceId && !this.serverRestartReloading) {
            this.serverRestartReloading = true;
            location.reload();
            return;
          }
          this.serverInstanceId = instanceId;
          return;
        }
        if (message.type === "session_status") this.applySessionStatus(message);
      } catch (error) {
        console.warn("invalid session status event", error);
      }
    };
    ws.onclose = () => {
      if (this.statusWs !== ws) return;
      this.statusWs = null;
      clearTimeout(this.statusWsReconnectTimer);
      this.statusWsReconnectTimer = setTimeout(() => this.connectStatusStream(), RECONNECT_MS);
    };
  }

  async initializeRemoteIdleMode() {
    if (this.vscodeMode || location.pathname.startsWith("/_remote/")) return;
    let payload;
    try {
      const response = await fetch("/_remote/status", { headers: { Accept: "application/json" } });
      if (!response.ok || !String(response.headers.get("content-type") || "").includes("application/json")) return;
      payload = await response.json();
    } catch (error) {
      return;
    }
    if (typeof payload?.email !== "string" || !payload.email) return;
    this.remoteBrowserEmail = payload.email;
    const remoteAccessRow = document.querySelector(".remote-access-settings-row");
    if (remoteAccessRow) void this.refreshRemoteAccessRow(remoteAccessRow);
    const idleSeconds = Number(payload?.idle_seconds || 0);
    if (!Number.isFinite(idleSeconds) || idleSeconds <= 0) return;
    this.remoteIdleTimeoutMs = Math.max(60000, idleSeconds * 1000);
    this.remoteIdleLastInteractionAt = Date.now();
    window.addEventListener("keydown", this.remoteIdleActivityHandler, { capture: true });
    window.addEventListener("pointerdown", this.remoteIdleActivityHandler, { capture: true });
    window.addEventListener("touchstart", this.remoteIdleActivityHandler, { capture: true, passive: true });
    window.addEventListener("wheel", this.remoteIdleActivityHandler, { capture: true, passive: true });
    document.addEventListener("visibilitychange", this.remoteIdleVisibilityHandler);
    this.scheduleRemoteBrowserIdleTransition();
  }

  async logoutRemoteBrowser(button) {
    button.disabled = true;
    try {
      const response = await fetch("/_remote/logout", { method: "POST" });
      if (!response.ok) throw new Error(`remote logout failed (${response.status})`);
      this.remoteIdleTransitioning = true;
      clearTimeout(this.remoteIdleTimer);
      const loginUrl = new URL("/_remote/login", location.origin);
      loginUrl.searchParams.set("return_to", `${location.pathname}${location.search}${location.hash}`);
      location.replace(loginUrl.href);
    } catch (error) {
      button.disabled = false;
      window.alert(error instanceof Error ? error.message : String(error));
    }
  }

  recordRemoteBrowserActivity() {
    if (!this.remoteIdleTimeoutMs || this.remoteIdleTransitioning) return;
    this.remoteIdleLastInteractionAt = Date.now();
    this.scheduleRemoteBrowserIdleTransition();
  }

  handleRemoteBrowserVisibilityChange() {
    if (!this.remoteIdleTimeoutMs || this.remoteIdleTransitioning) return;
    if (document.hidden) {
      this.scheduleRemoteBrowserIdleTransition();
      return;
    }
    if (Date.now() - this.remoteIdleLastInteractionAt >= this.remoteIdleTimeoutMs) {
      this.transitionRemoteBrowserToIdle();
      return;
    }
    this.recordRemoteBrowserActivity();
  }

  scheduleRemoteBrowserIdleTransition() {
    clearTimeout(this.remoteIdleTimer);
    if (!this.remoteIdleTimeoutMs || this.remoteIdleTransitioning) return;
    const elapsed = Date.now() - this.remoteIdleLastInteractionAt;
    this.remoteIdleTimer = window.setTimeout(() => this.transitionRemoteBrowserToIdle(),
      Math.max(0, this.remoteIdleTimeoutMs - elapsed));
  }

  transitionRemoteBrowserToIdle() {
    if (!this.remoteIdleTimeoutMs || this.remoteIdleTransitioning) return;
    this.remoteIdleTransitioning = true;
    clearTimeout(this.remoteIdleTimer);
    this.remoteIdleTimer = 0;
    const returnTo = `${location.pathname}${location.search}${location.hash}`;
    const idleUrl = new URL("/_remote/idle", location.origin);
    idleUrl.searchParams.set("return_to", returnTo);
    location.replace(idleUrl.href);
  }

  showInitialLoadingState() {
    const emptyState = this.$("empty-state");
    emptyState.classList.add("loading");
    emptyState.textContent = "loading TermDeck…";
    emptyState.style.display = "flex";
  }

  showInitialLoadFailure() {
    const emptyState = this.$("empty-state");
    emptyState.classList.remove("loading");
    emptyState.textContent = "unable to load TermDeck — retrying…";
    emptyState.style.display = "flex";
  }

  finishInitialLoadingState() {
    this.initialLoadComplete = true;
    const emptyState = this.$("empty-state");
    emptyState.classList.remove("loading");
    emptyState.textContent = "no terminals — press + to open one";
  }

  applySessionStatus(message) {
    const session = this.session(message.session_id);
    if (!session) return;
    const previousPresentation = this.titlePresentation(session);
    const previousAgentSessionId = session.agent_session_id;
    const previousAgentKind = session.agent_kind;
    const previousExitCode = session.exit_code;
    const previousRunning = !!session.running;
    const previousDormant = !!session.dormant;
    const previousModel = this.sessionModelById.get(session.session_id) || "";
    const previousNeedsAttention = this.attentionServerStates.has(session.session_id)
      ? this.attentionServerStates.get(session.session_id) === true : session.needs_attention === true;
    if (Object.prototype.hasOwnProperty.call(message, "title") && message.title) session.title = message.title;
    if (Object.prototype.hasOwnProperty.call(message, "title_user_set")) session.title_user_set = !!message.title_user_set;
    if (Object.prototype.hasOwnProperty.call(message, "cli_title") && message.cli_title) session.cli_title = message.cli_title;
    if (Object.prototype.hasOwnProperty.call(message, "agent_session_id")) session.agent_session_id = message.agent_session_id;
    if (Object.prototype.hasOwnProperty.call(message, "agent_kind")) session.agent_kind = message.agent_kind;
    if (Object.prototype.hasOwnProperty.call(message, "last_activity_at")) {
      session.last_activity_at = message.last_activity_at;
      const activity = Number(message.last_activity_at || 0);
      if (activity > 0) this.touchSessionActivity(session.session_id, activity > 1e12 ? activity : activity * 1000);
    }
    if (Object.prototype.hasOwnProperty.call(message, "processing")) session.processing = !!message.processing;
    if (Object.prototype.hasOwnProperty.call(message, "processing_since")) {
      session.processing_since = message.processing_since;
      const processingSince = Number(message.processing_since);
      if (processingSince > 0 && !this.processingStates.get(session.session_id) &&
          !this.historyPendingProcessing.has(session.session_id)) {
        this.processingSince.set(session.session_id, processingSince * 1000);
      }
      else if (!message.processing) this.processingSince.delete(session.session_id);
    }
    if (Object.prototype.hasOwnProperty.call(message, "running")) session.running = !!message.running;
    if (Object.prototype.hasOwnProperty.call(message, "exit_code")) session.exit_code = message.exit_code;
    if (Object.prototype.hasOwnProperty.call(message, "dormant")) session.dormant = !!message.dormant;
    if (Object.prototype.hasOwnProperty.call(message, "needs_attention")) {
      session.needs_attention = !!message.needs_attention;
      this.attentionServerStates.set(session.session_id, session.needs_attention);
      if (!session.needs_attention) {
        this.clearSessionAttention(session.session_id);
        if (previousNeedsAttention) {
          const view = this.views.get(session.session_id);
          if (view) view.attentionScreenDetectionSuppressed = true;
        }
      }
    }
    this.cacheSessionModel(session);
    const spinning = !session.dormant && session.processing === true;
    const presentation = this.titlePresentation(session);
    const processingChanged = this.processingStates.get(session.session_id) !== spinning;
    const displayedTitleChanged = previousPresentation.text !== presentation.text;
    const modelChanged = previousModel !== (this.sessionModelById.get(session.session_id) || "");
    const rowStateChanged = displayedTitleChanged || processingChanged || previousAgentKind !== session.agent_kind ||
      previousExitCode !== session.exit_code || previousRunning !== !!session.running || previousDormant !== !!session.dormant ||
      previousNeedsAttention !== !!session.needs_attention;
    if (displayedTitleChanged) {
      this.postVscodeNativeSession(session, session.session_id === this.activeId ? !this.historyOpen : undefined);
    }
    if (processingChanged || (spinning && this.historyPendingProcessing.has(session.session_id))) {
      this.updateProcessingState(session.session_id, spinning);
    }
    if (session.needs_attention && !previousNeedsAttention) {
      this.triggerSessionAttention(session.session_id);
    } else if (previousExitCode == null && session.exit_code != null && !session.dormant && session.exit_code !== 0) {
      this.triggerSessionAttention(session.session_id);
    }
    if (rowStateChanged) this.updateSessionRows(session.session_id);
    if (session.session_id === this.activeId) {
      if (this.historyOpen && previousAgentSessionId !== session.agent_session_id) {
        this.connectHistoryStream(session.session_id, { fresh: true });
      }
      if (rowStateChanged || modelChanged) this.renderTopbar();
    }
  }

  titlePresentation(s) {
    const title = this.effectiveTitle(s);
    const status = title.match(TITLE_STATUS_RE);
    const processing = s && this.processingStates.has(s.session_id)
      ? this.processingStates.get(s.session_id) === true
      : s?.processing === true;
    return { text: status ? title.slice(status[0].length) : title, spinning: processing };
  }

  updateSessionSpinner(id, spinning) {
    const spinner = this.sessionSpinnerEls.get(id);
    if (spinner) spinner.classList.toggle("on", spinning);
    this.updateSessionTextStatus(id, spinning);
  }

  updateSessionTextStatus(id, spinning = !!this.processingStates.get(id)) {
    const title = this.sessionTitleEls.get(id);
    if (!title) return;
    const textOnly = this.usesTextTerminalStatus(this.session(id)?.agent_kind);
    const working = textOnly && !!spinning;
    title.classList.toggle("session-title-working", working);
    title.classList.toggle("session-title-unread", !this.vscodeMode && !working && this.unreadSessions.has(id));
    const session = this.session(id);
    if (!this.vscodeMode && session && !working) title.style.color = this.terminalAgeColor(session);
    else title.style.removeProperty("color");
  }

  setSessionTitleText(title, text) {
    const value = String(text || "");
    const row = title.closest(".session-item");
    const base = document.createElement("span");
    base.className = "session-title-base";
    if (row?.classList.contains("terminal-search-match") && this.terminalSearchText.trim()) {
      this.appendTerminalSearchHighlightedText(base, value, this.terminalSearchText);
    } else {
      base.textContent = value;
    }
    const waveWindow = document.createElement("span");
    waveWindow.className = "session-title-wave-window";
    waveWindow.setAttribute("aria-hidden", "true");
    const waveText = document.createElement("span");
    waveText.className = "session-title-wave-text";
    waveText.dataset.waveText = value;
    waveWindow.appendChild(waveText);
    title.replaceChildren(base, waveWindow);
  }

  terminalIconAgentKind(agentKind) {
    const kind = String(agentKind || "none").toLowerCase();
    return TERMINAL_ICON_AGENT_KINDS.includes(kind) ? kind : "none";
  }

  terminalIconEnabledForAgent(agentKind) {
    const kind = this.terminalIconAgentKind(agentKind);
    const states = this.settings.terminal_icon_agents;
    if (states && typeof states === "object" && Object.prototype.hasOwnProperty.call(states, kind)) return !!states[kind];
    return !!this.settings.show_terminal_icons;
  }

  setTerminalIconEnabledForAgent(agentKind, enabled) {
    const kind = this.terminalIconAgentKind(agentKind);
    this.settings.terminal_icon_agents = { ...(this.settings.terminal_icon_agents || {}), [kind]: !!enabled };
  }

  usesTextTerminalStatus(agentKind) {
    return !this.vscodeMode && !this.terminalIconEnabledForAgent(agentKind);
  }

  updateUnreadIndicator(id) {
    const dot = this.sessionStatusEls.get(id);
    if (dot) {
      dot.classList.toggle("processing", !!this.processingStates.get(id));
      dot.classList.toggle("unread", this.unreadSessions.has(id) && !this.processingStates.get(id));
      dot.classList.toggle("attention", this.attentionSessions.has(id));
    }
    this.updateSessionTextStatus(id);
    this.updateTerminalGroupStatus(id);
    this.updateTerminalIconState(id);
  }

  updateTerminalGroupStatus(sessionId) {
    const groupId = this.getProjectState().session_groups?.[sessionId];
    if (!groupId) return;
    const label = this.$("session-list")?.querySelector(
      `[data-group-id="${CSS.escape(groupId)}"] > .terminal-group-label`);
    if (!label) return;
    const memberIds = this.groupSessionIds(groupId);
    const working = memberIds.some((id) => this.processingStates.get(id));
    const attentionCount = memberIds.filter((id) => this.processingStates.get(id) || this.unreadSessions.has(id)).length;
    label.classList.remove("group-working", "group-unread");
    const unreadDot = label.querySelector(".group-unread-dot");
    if (unreadDot) {
      const groupNeedsAttention = memberIds.some((id) => this.attentionSessions.has(id));
      unreadDot.classList.toggle("on", attentionCount > 0 || groupNeedsAttention);
      unreadDot.classList.remove("attention");
      unreadDot.title = attentionCount ? `${attentionCount} active or unread terminal${attentionCount === 1 ? "" : "s"}` : "";
    }
    const attentionNumber = label.querySelector(".group-unread-count");
    if (attentionNumber) attentionNumber.textContent = attentionCount ? String(attentionCount) : "";
    const name = label.querySelector(".terminal-group-name");
    if (name && !this.vscodeMode) {
      const members = memberIds.map((id) => this.session(id)).filter(Boolean);
      name.style.color = this.terminalGroupAgeColor(members);
    }
    const suffix = [working ? "working" : "", attentionCount ? `${attentionCount} active or unread` : ""]
      .filter(Boolean).join(" · ");
    label.title = `Click to collapse/expand · right-click for group actions · drop terminals here${suffix ? ` · ${suffix}` : ""}`;
  }

  setSessionUnread(id, unread) {
    this.setSessionsUnread([id], unread);
  }

  setSessionsUnread(sessionIds, unread) {
    const ids = [...new Set(sessionIds)].filter((id) => !!this.session(id));
    if (!ids.length) return;
    for (const id of ids) {
      if (unread) {
        this.unreadSessions.add(id);
        this.viewedCompletedSessions.delete(id);
      } else {
        this.unreadSessions.delete(id);
        if (!this.processingStates.get(id)) this.viewedCompletedSessions.add(id);
      }
      this.updateUnreadIndicator(id);
    }
    this.persistUnreadSessionDelta(ids, unread);
  }

  markTerminalGroupUnread(groupId) {
    const sessionGroups = this.getProjectState().session_groups || {};
    const ids = this.sessions
      .filter((session) => sessionGroups[session.session_id] === groupId)
      .map((session) => session.session_id);
    this.setSessionsUnread(ids, true);
  }

  updateTerminalIconState(id) {
    if (this.vscodeMode) return;
    const title = this.sessionTitleEls.get(id);
    const icon = title?.closest(".session-item")?.querySelector(".terminal-type-icon");
    const session = this.session(id);
    if (!icon || !session) return;
    const enabled = this.terminalIconEnabledForAgent(session.agent_kind);
    icon.classList.toggle("on", enabled);
    icon.closest(".session-item")?.classList.toggle("terminal-icons-hidden", !enabled);
    const active = enabled && (!!this.processingStates.get(id) || this.unreadSessions.has(id));
    const exited = enabled && !session.running && !session.dormant;
    icon.classList.toggle("terminal-status-active", active);
    icon.classList.toggle("terminal-status-exited", !active && exited);
  }

  triggerSessionAttention(id) {
    const session = this.session(id);
    if (!session) return;
    this.attentionSessions.add(id);
    clearTimeout(this.attentionTimers.get(id));
    this.attentionTimers.delete(id);
    if (!session.needs_attention) {
      this.attentionTimers.set(id, setTimeout(() => this.clearSessionAttention(id), TERMINAL_ATTENTION_ANIMATION_MS));
    }
    this.updateUnreadIndicator(id);
  }

  clearSessionAttention(id) {
    clearTimeout(this.attentionTimers.get(id));
    this.attentionTimers.delete(id);
    if (!this.attentionSessions.delete(id)) return;
    this.updateUnreadIndicator(id);
  }

  updateProcessingState(id, spinning) {
    const session = this.session(id);
    const dormant = !!session?.dormant;
    spinning = spinning && !dormant;
    const previous = this.processingStates.get(id);
    const pendingSince = this.historyPendingProcessing.get(id);
    if (spinning && previous !== true) {
      this.processingSince.set(id, pendingSince || this.processingSince.get(id) || Date.now());
    }
    if (spinning) this.historyPendingProcessing.delete(id);
    if (spinning) this.viewedCompletedSessions.delete(id);
    if (spinning && previous !== true && !this.processingSince.has(id)) this.processingSince.set(id, Date.now());
    if (!spinning) this.processingSince.delete(id);
    this.processingStates.set(id, spinning);
    this.updateSessionSpinner(id, spinning);
    this.updateUnreadIndicator(id);
    this.updateHistoryThinkingIndicator();
    this.renderHistoryMeta();
    const queuedPromptDispatched = !spinning && this.dispatchNextMarkdownPrompt(this.views.get(id));
    const completed = !dormant && previous === true && !spinning && !queuedPromptDispatched;
    const userIsViewingSession = id === this.activeId && !document.hidden && document.hasFocus();
    if (completed && !userIsViewingSession && !this.viewedCompletedSessions.has(id) && !this.unreadSessions.has(id)) {
      this.unreadSessions.add(id);
      this.persistUnreadSessionDelta([id], true);
    }
  }

  markdownPromptQueueForSession(sessionId) {
    const queues = this.settings.md_prompt_queues && typeof this.settings.md_prompt_queues === "object"
      ? this.settings.md_prompt_queues : {};
    const saved = Array.isArray(queues[sessionId]) ? queues[sessionId] : [];
    return saved.map((text) => ({ text: String(text || "") })).filter((item) => item.text.trim());
  }

  markdownPromptDraftForSession(sessionId) {
    const drafts = this.settings.md_prompt_drafts && typeof this.settings.md_prompt_drafts === "object"
      ? this.settings.md_prompt_drafts : {};
    return String(drafts[sessionId] || "");
  }

  persistMarkdownPromptDraft(view, text = view?.markdownPromptDraft || "") {
    if (!view) return;
    const drafts = this.settings.md_prompt_drafts && typeof this.settings.md_prompt_drafts === "object"
      ? this.settings.md_prompt_drafts : {};
    const nextDrafts = { ...drafts };
    const normalized = String(text || "").slice(0, 20000);
    if (normalized) nextDrafts[view.sessionId] = normalized;
    else delete nextDrafts[view.sessionId];
    this.settings.md_prompt_drafts = nextDrafts;
    view.markdownPromptDraft = normalized;
    this.saveSettings();
  }

  persistMarkdownPromptQueue(view) {
    if (!view) return;
    const queues = this.settings.md_prompt_queues && typeof this.settings.md_prompt_queues === "object"
      ? this.settings.md_prompt_queues : {};
    const nextQueues = { ...queues };
    const texts = (view.promptQueue || []).map((item) => String(item.draftText ?? item.text ?? "")).filter((text) => text.trim());
    if (texts.length) nextQueues[view.sessionId] = texts;
    else delete nextQueues[view.sessionId];
    this.settings.md_prompt_queues = nextQueues;
    this.saveSettings();
  }

  dispatchNextMarkdownPrompt(view) {
    if (!view || view.closed || view.promptQueueDispatching || !view.promptQueue.length ||
        this.processingStates.get(view.sessionId) || this.session(view.sessionId)?.processing === true ||
        this.historyPendingProcessing.has(view.sessionId) || !view.ws || view.ws.readyState !== WebSocket.OPEN) return false;
    const item = view.promptQueue.shift();
    const text = String(item?.draftText ?? item?.text ?? "");
    if (!text.trim()) {
      this.persistMarkdownPromptQueue(view);
      this.renderHistoryQueue(view);
      return this.dispatchNextMarkdownPrompt(view);
    }
    view.promptQueueDispatching = true;
    this.persistMarkdownPromptQueue(view);
    this.renderHistoryQueue(view);
    const sent = this.submitHistoryPromptText(view, text, { fromQueue: true });
    view.promptQueueDispatching = false;
    if (!sent) {
      view.promptQueue.unshift({ text });
      this.persistMarkdownPromptQueue(view);
      this.renderHistoryQueue(view);
      return false;
    }
    return true;
  }

  session(id) {
    return this.sessions.find((s) => s.session_id === id) || null;
  }

  sessionOrClosed(id) {
    return this.session(id) || this.closedSessions.find((s) => s.session_id === id) || null;
  }

  sessionListSignatureFor(sessions = this.sessions) {
    return sessions.map((s) => s.session_id).join("|");
  }

  // onlySessionId scopes the DOM writes below to a single row. A status-websocket message already knows
  // exactly which session changed (applySessionStatus targets that row directly for title/processing);
  // calling this unscoped on every message meant one processing session's spinner-frame update rewrote
  // all N rows' className/text/icon state on every frame, and that ran per status message -- with several
  // sessions processing simultaneously this measured as the dominant, sustained cost of the whole page,
  // independent of how many terminal views were open. The unscoped 30s full-refresh caller is unaffected.
  updateSessionRows(onlySessionId = null) {
    const targets = onlySessionId ? this.sessions.filter((s) => s.session_id === onlySessionId) : this.sessions;
    for (const s of targets) {
      const presentation = this.titlePresentation(s);
      const title = this.sessionTitleEls.get(s.session_id);
      if (title) this.setSessionTitleText(title, presentation.text,
        this.usesTextTerminalStatus(s.agent_kind) && presentation.spinning);
      const dot = this.sessionStatusEls.get(s.session_id);
      if (dot) {
        dot.className = "status-dot" + (s.running ? "" : s.dormant ? " dormant" : " exited") +
          (presentation.spinning ? " processing" : this.unreadSessions.has(s.session_id) ? " unread" : "") +
          (this.attentionSessions.has(s.session_id) ? " attention" : "");
      }
      const spinner = this.sessionSpinnerEls.get(s.session_id);
      if (spinner) spinner.classList.toggle("on", presentation.spinning);
      this.updateSessionTextStatus(s.session_id, presentation.spinning);
      if (title) {
        const item = title.closest(".session-item");
        if (item) {
          item.classList.toggle("active", s.session_id === this.activeId && this.activeFileKey === null);
          this.updateTerminalIconState(s.session_id);
        }
      }
    }
    this.updateWorktreeSectionSummaries();
  }

  updateWorktreeSectionSummaries() {
    if (this.worktreeId !== ALL_WORKTREES_ID) return;
    for (const worktree of this.availableWorktreeSections()) {
      const sessions = this.sessionsForWorktree(String(worktree.id));
      const closed = this.closedSessions.filter((session) => this.worktreeIdForSession(session) === String(worktree.id));
      const activeCount = sessions.filter((session) => this.processingStates.get(session.session_id) ||
        this.unreadSessions.has(session.session_id)).length;
      const count = this.$("session-list")?.querySelector(`[data-worktree-id="${CSS.escape(String(worktree.id))}"] .worktree-section-count`);
      if (!count) continue;
      count.textContent = `${sessions.length} terminal${sessions.length === 1 ? "" : "s"}${closed.length ? ` · ${closed.length} closed` : ""}`;
      if (activeCount) count.textContent += ` · ${activeCount} active/unread`;
    }
  }

  effectiveTitle(s) {
    if (!s.title_user_set) return s.cli_title || s.title;
    const spinner = s.cli_title && /^([⠀-⣿○-◗⠁-⣿⏳⚡✳]+\s*)/.exec(s.cli_title);
    return spinner ? spinner[1] + s.title : s.title;
  }

  applySessionOrder(sessions) {
    const state = this.getProjectState();
    const order = state.session_order || [];
    const rank = new Map(order.map((id, i) => [id, i]));
    return [...sessions].sort((a, b) =>
      (rank.has(a.session_id) ? rank.get(a.session_id) : 1e9) - (rank.has(b.session_id) ? rank.get(b.session_id) : 1e9));
  }

  makeDraggable(item, type, key, onReorder) {
    item.draggable = true;
    item.ondragstart = (e) => {
      this.dragItem = { type, key };
      this.clearDragGroupingTimer();
      item.classList.add("dragging-tab");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", key);
    };
    item.ondragover = (e) => {
      if (this.dragItem && this.dragItem.type === type && this.dragItem.key !== key) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const isSessionDrop = type === "session";
        if (isSessionDrop && this.dragGroupTargetKey === key) {
          item.classList.remove("drop-before", "drop-after");
          item.classList.add("group-drop-target");
          return;
        }
        const rect = item.getBoundingClientRect();
        if (!isSessionDrop) {
          this.clearDragLandingIndicator();
          item.classList.add(e.clientY >= rect.top + rect.height / 2 ? "drop-after" : "drop-before");
          return;
        }
        if (this.dragGroupHoverKey !== key) {
          this.clearDragLandingIndicator();
          item.classList.add(e.clientY >= rect.top + rect.height / 2 ? "drop-after" : "drop-before");
          this.dragGroupHoverKey = key;
          const draggedId = this.dragItem.key;
          this.dragGroupTimer = window.setTimeout(() => {
            if (this.dragItem?.type !== "session" || this.dragItem.key !== draggedId) return;
            this.dragGroupTargetKey = key;
            item.classList.remove("drop-before", "drop-after");
            const targetGroup = this.getProjectState().session_groups?.[key];
            const draggedGroup = this.getProjectState().session_groups?.[draggedId];
            const label = item.querySelector(".group-drop-indicator span:last-child");
            if (label) label.textContent = targetGroup || draggedGroup ? "group" : "new group";
            item.classList.add("group-drop-target");
          }, SESSION_GROUP_HOVER_DELAY_MS);
        } else {
          item.classList.remove("group-drop-target");
          item.classList.add(e.clientY >= rect.top + rect.height / 2 ? "drop-after" : "drop-before");
        }
      }
    };
    item.ondragleave = (e) => {
      if (!e.relatedTarget || !item.contains(e.relatedTarget)) this.clearDragLandingIndicator();
    };
    item.ondrop = (e) => {
      e.preventDefault();
      if (this.dragItem && this.dragItem.type === type && this.dragItem.key !== key) {
        const draggedId = this.dragItem.key;
        if (type === "session" && this.dragGroupTargetKey === key) this.groupSessionsFromDrop(draggedId, key);
        else onReorder(draggedId, key, item.classList.contains("drop-after"));
      }
      this.clearDragLandingIndicator();
      this.dragItem = null;
    };
    item.ondragend = () => {
      this.clearDragLandingIndicator(true);
      this.dragItem = null;
    };
  }

  setDragLandingMode(item, mode, label) {
    item.classList.remove("drop-before", "drop-after", "drop-group", "group-drop-pending", "group-drop-target");
    if (mode) item.classList.add(mode);
    const hint = item.querySelector(".group-drop-indicator span:last-child");
    if (hint && label) hint.textContent = label;
  }

  makeLayoutDraggable(item, token, kind) {
    item.draggable = true;
    item.ondragstart = (event) => {
      this.setInteractionWorktreeFromElement(item);
      const sessionId = kind === "session" ? token.slice("session:".length) : null;
      const sessionIds = sessionId ? this.selectedSessionIdsForDrag(sessionId) : [];
      const tokens = kind === "session" ? sessionIds.map((id) => `session:${id}`) : [token];
      if (sessionId) {
        this.sidebarSelectedSessionIds = new Set(sessionIds);
        this.sidebarSelectionAnchorId = sessionId;
        this.applySidebarSelectionStyles();
        for (const row of this.$("session-list").querySelectorAll(".session-item[data-session-id]")) {
          row.classList.toggle("dragging-tab", this.sidebarSelectedSessionIds.has(row.dataset.sessionId));
        }
      } else {
        item.classList.add("dragging-tab");
      }
      this.dragItem = { type: "layout", token, kind, tokens, worktreeId: this.stateWorktreeId() };
      this.clearDragGroupingTimer();
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", tokens.join("\n"));
    };
    item.ondragover = (event) => {
      this.setInteractionWorktreeFromElement(item);
      const source = this.dragItem;
      if (!source || source.type !== "layout" || source.token === token) return;
      if (source.worktreeId && source.worktreeId !== this.stateWorktreeId()) return;
      const sourceSessionIds = this.sessionIdsFromDragItem(source);
      const targetId = kind === "session" ? token.slice("session:".length) : null;
      if (targetId && sourceSessionIds.includes(targetId)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      if (source.kind === "session" && kind === "group") {
        this.clearDragLandingIndicator();
        this.setDragLandingMode(item, "drop-group", "add to group");
        return;
      }
      const sessionGroups = this.getProjectState().session_groups || {};
      const sourceGroupIds = [...new Set(sourceSessionIds.map((id) => sessionGroups[id]).filter(Boolean))];
      const targetGroup = targetId ? sessionGroups[targetId] : null;
      const rect = item.getBoundingClientRect();
      const holdToCreate = source.kind === "session" && kind === "session" &&
        !sourceGroupIds.length && !targetGroup;
      const centerDrop = holdToCreate && event.clientY >= rect.top + rect.height * 0.25 &&
        event.clientY <= rect.top + rect.height * 0.75;
      if (holdToCreate && !centerDrop) {
        this.clearDragLandingIndicator();
        const after = event.clientY >= rect.top + rect.height / 2;
        const moveLabel = source.kind === "group" ? "move group" : "move";
        this.setDragLandingMode(item, after ? "drop-after" : "drop-before", `${moveLabel} ${after ? "after" : "before"}`);
        return;
      }
      if (holdToCreate) {
        if (this.dragGroupTargetKey === token) {
          this.setDragLandingMode(item, "group-drop-target", "create group");
          return;
        }
        if (this.dragGroupHoverKey !== token) {
          this.clearDragLandingIndicator();
          this.setDragLandingMode(item, "group-drop-pending", "hold to create group");
          this.dragGroupHoverKey = token;
          const sourceToken = source.token;
          this.dragGroupTimer = window.setTimeout(() => {
            if (this.dragItem?.type !== "layout" || this.dragItem.token !== sourceToken) return;
            this.dragGroupTargetKey = token;
            this.setDragLandingMode(item, "group-drop-target", "create group");
          }, SESSION_GROUP_HOVER_DELAY_MS);
        }
        return;
      }
      this.clearDragLandingIndicator();
      const after = event.clientY >= rect.top + rect.height / 2;
      const moveLabel = source.kind === "group" ? "move group" : "move";
      this.setDragLandingMode(item, after ? "drop-after" : "drop-before", `${moveLabel} ${after ? "after" : "before"}`);
    };
    item.ondragleave = (event) => {
      if (!event.relatedTarget || !item.contains(event.relatedTarget)) this.clearDragLandingIndicator();
    };
    item.ondrop = (event) => {
      this.setInteractionWorktreeFromElement(item);
      event.preventDefault();
      const source = this.dragItem;
      if (source?.type === "layout" && source.token !== token &&
          (!source.worktreeId || source.worktreeId === this.stateWorktreeId())) {
        const sourceSessionIds = this.sessionIdsFromDragItem(source);
        const targetId = token.slice(token.indexOf(":") + 1);
        if (kind === "session" && sourceSessionIds.includes(targetId)) {
          this.clearDragLandingIndicator();
          this.dragItem = null;
          return;
        }
        const sessionGroups = this.getProjectState().session_groups || {};
        const targetGroup = kind === "session" ? sessionGroups[targetId] : null;
        const targetRect = kind === "session" ? item.getBoundingClientRect() : null;
        if (source.kind === "session" && kind === "group") this.moveSelectedSessionsIntoGroup(sourceSessionIds, targetId);
        else if (source.kind === "session" && kind === "session" && this.dragGroupTargetKey === token) {
          const rect = item.getBoundingClientRect();
          this.groupSelectedSessionsFromDrop(sourceSessionIds, targetId, event.clientY >= rect.top + rect.height / 2);
        } else {
          const after = item.classList.contains("drop-after") ||
            (targetRect && event.clientY >= targetRect.top + targetRect.height / 2);
          if (source.kind === "session" && kind === "session" && targetGroup) {
            this.moveSelectedSessionsIntoGroup(sourceSessionIds, targetGroup, targetId, after);
          } else if (source.kind === "session" && kind === "session") {
            this.repositionSelectedSessions(sourceSessionIds, targetId, after);
          } else {
            this.reorderTerminalLayout(source.token, token, after);
          }
        }
      }
      this.clearDragLandingIndicator();
      this.dragItem = null;
    };
    item.ondragend = () => {
      this.clearDragLandingIndicator(true);
      this.dragItem = null;
    };
  }

  clearDragLandingIndicator(clearSource = false) {
    this.clearDragGroupingTimer();
    // Scoped to the document, not the session list: group labels, the file tree and the terminal's
    // drop-to-attach overlay all raise indicators that outlive a drag ending outside their own element.
    const landingClasses = ["drop-before", "drop-after", "drop-group", "group-drop-pending", "group-drop-target", "drag-over"];
    document.querySelectorAll(landingClasses.map((name) => `.${name}`).join(", "))
      .forEach((row) => row.classList.remove(...landingClasses));
    if (clearSource) document.querySelectorAll(".dragging-tab")
      .forEach((row) => row.classList.remove("dragging-tab"));
  }

  clearDragGroupingTimer() {
    if (this.dragGroupTimer) window.clearTimeout(this.dragGroupTimer);
    this.dragGroupTimer = 0;
    this.dragGroupTargetKey = null;
    this.dragGroupHoverKey = null;
  }

  reorderSessions(draggedId, targetId, after = false) {
    const ids = this.sessionsForWorktree(this.stateWorktreeId()).map((s) => s.session_id).filter((id) => id !== draggedId);
    const targetIndex = ids.indexOf(targetId);
    if (targetIndex < 0) return;
    ids.splice(targetIndex + (after ? 1 : 0), 0, draggedId);
    this.applyLocalProjectStatePatch({ session_order: ids });
    this.queueSessionOrderMove([draggedId], targetId, after);
    this.sessions = this.applySessionOrder(this.sessions);
    this.renderList();
  }

  reorderFiles(draggedKey, targetKey, after = false) {
    const keys = [...this.openFiles.keys()].filter((k) => k !== draggedKey);
    const targetIndex = keys.indexOf(targetKey);
    if (targetIndex < 0) return;
    keys.splice(targetIndex + (after ? 1 : 0), 0, draggedKey);
    const reordered = new Map(keys.map((k) => [k, this.openFiles.get(k)]));
    this.openFiles = reordered;
    this.persistOpenFiles();
    this.renderList();
  }

  sectionLabel(text) {
    const label = document.createElement("div");
    label.className = "side-section-label";
    if (text !== "terminals") {
      label.textContent = text;
      return label;
    }
    label.classList.add("side-section-header");
    const name = document.createElement("span");
    name.textContent = text;
    label.append(name);
    if (!this.vscodeMode) {
      const controls = document.createElement("span");
      controls.className = "section-header-controls";
      const sort = document.createElement("button");
      sort.id = "active-toggle";
      sort.className = "section-toggle terminals-sort-toggle";
      sort.classList.toggle("on", this.hideInactiveTerminals);
      sort.innerHTML = `<span class="codicon ${this.hideInactiveTerminals ? "codicon-eye-closed" : "codicon-eye"}"></span>`;
      sort.setAttribute("aria-pressed", String(this.hideInactiveTerminals));
      sort.title = this.hideInactiveTerminals ? "Show all terminals" : "Show active and unread terminals";
      sort.setAttribute("aria-label", sort.title);
      sort.onclick = (event) => {
        event.stopPropagation();
        this.toggleHideInactiveTerminals();
      };
      const group = document.createElement("button");
      group.id = "new-group-btn";
      group.className = "section-toggle";
      group.innerHTML = '<span class="codicon codicon-folder-library"></span>';
      group.title = "New terminal group";
      group.setAttribute("aria-label", group.title);
      group.onclick = (event) => {
        event.stopPropagation();
        this.createTerminalGroup();
      };
      const search = document.createElement("button");
      search.id = "terminal-search-inline-toggle";
      search.className = "section-toggle";
      search.innerHTML = '<span class="codicon codicon-search"></span>';
      search.title = this.shortcutTitle("Search terminal names and output", "open-terminal-search");
      search.setAttribute("aria-label", search.title);
      const globalTerminalSearchOpen = this.terminalSearchEditorOpen && !this.terminalSearchGroupId;
      search.setAttribute("aria-pressed", String(globalTerminalSearchOpen));
      search.classList.toggle("on", globalTerminalSearchOpen);
      search.onclick = (event) => {
        event.stopPropagation();
        this.toggleTerminalSearchEditor();
      };
      const add = document.createElement("button");
      add.id = "new-session-btn";
      add.className = "section-toggle terminal-new-toggle";
      add.textContent = "+";
      add.title = this.shortcutTitle("New terminal", "new-terminal");
      add.setAttribute("aria-label", add.title);
      add.onclick = (event) => {
        event.stopPropagation();
        this.openModal();
      };
      controls.append(sort, group, search, add);
      label.appendChild(controls);
    }
    return label;
  }

  ensureDesktopTerminalsHeader(list = this.$("session-list"), terminalSearchEditor = null) {
    if (this.vscodeMode || !list || list.querySelector("#new-session-btn")) return;
    const header = this.sectionLabel("terminals");
    this.attachGroupDropTarget(header, null);
    list.prepend(header);
    if (this.terminalSearchEditorOpen && !this.terminalSearchGroupId) {
      header.after(terminalSearchEditor || this.createTerminalSearchEditor());
    }
  }

  terminalSearchGroupName() {
    if (!this.terminalSearchGroupId) return "";
    const worktreeId = this.terminalSearchWorktreeId || this.stateWorktreeId();
    return this.terminalGroupsForWorktree(worktreeId)
      .find((group) => group.id === this.terminalSearchGroupId)?.name || "";
  }

  terminalSearchPlaceholder() {
    const groupName = this.terminalSearchGroupName();
    return groupName ? `search ${groupName}` : "search terminal names and conversations";
  }

  updateTerminalSearchEditorScope() {
    const input = this.$("terminal-search-input");
    if (input) input.placeholder = this.terminalSearchPlaceholder();
    const summary = this.$("terminal-search-summary");
    if (summary && !this.terminalSearchText.trim()) summary.textContent = this.terminalSearchGroupName();
  }

  createTerminalSearchEditor() {
    const bar = document.createElement("div");
    bar.id = "terminal-search-inline";
    const icon = document.createElement("span");
    icon.className = "codicon codicon-search terminal-search-inline-icon";
    const input = document.createElement("input");
    input.id = "terminal-search-input";
    input.type = "text";
    input.placeholder = this.terminalSearchPlaceholder();
    input.value = this.terminalSearchText;
    input.autocomplete = "off";
    input.autocapitalize = "off";
    input.autocorrect = "off";
    input.spellcheck = false;
    const summary = document.createElement("span");
    summary.id = "terminal-search-summary";
    summary.setAttribute("aria-live", "polite");
    const close = document.createElement("button");
    close.id = "terminal-search-inline-close";
    close.className = "section-toggle";
    close.innerHTML = '<span class="codicon codicon-close"></span>';
    close.title = "Close terminal search";
    close.setAttribute("aria-label", close.title);
    input.oninput = () => {
      this.terminalSearchText = input.value;
      this.terminalSearchFocusIndex = -1;
      clearTimeout(this.terminalSearchTimer);
      this.terminalSearchTimer = window.setTimeout(() => this.runTerminalSearch(), TERMINAL_SEARCH_DEBOUNCE_MS);
    };
    input.onkeydown = (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        this.moveTerminalSearchRow(event.key === "ArrowDown" ? 1 : -1);
      } else if (event.key === "Enter") {
        event.preventDefault();
        clearTimeout(this.terminalSearchTimer);
        this.runTerminalSearch();
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.closeTerminalSearchEditor();
      }
    };
    input.onclick = (event) => event.stopPropagation();
    close.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.closeTerminalSearchEditor();
    };
    bar.append(icon, input, close, summary);
    return bar;
  }

  openTerminalSearchEditor(groupId = null) {
    const nextGroupId = groupId && this.terminalGroups().some((group) => group.id === groupId) ? groupId : null;
    const scopeChanged = nextGroupId !== this.terminalSearchGroupId;
    this.terminalSearchGroupId = nextGroupId;
    this.terminalSearchWorktreeId = nextGroupId ? this.stateWorktreeId() : null;
    if (nextGroupId) {
      const groups = this.terminalGroups();
      if (groups.some((group) => group.id === nextGroupId && group.collapsed)) {
        this.applyLocalProjectStatePatch({ terminal_groups: groups.map((group) => group.id === nextGroupId
          ? { ...group, collapsed: false } : group) });
        this.queueTerminalGroupUpdate(nextGroupId, { collapsed: false });
      }
    }
    this.terminalSearchEditorOpen = true;
    this.renderList();
    requestAnimationFrame(() => {
      const input = this.$("terminal-search-input");
      if (!input) return;
      input.focus();
      input.select();
      if (scopeChanged && this.terminalSearchText.trim()) void this.runTerminalSearch();
    });
  }

  toggleTerminalSearchEditor(groupId = null) {
    const nextGroupId = groupId && this.terminalGroups().some((group) => group.id === groupId) ? groupId : null;
    if (this.terminalSearchEditorOpen && this.terminalSearchGroupId === nextGroupId) this.closeTerminalSearchEditor();
    else this.openTerminalSearchEditor(nextGroupId);
  }

  closeTerminalSearchEditor() {
    clearTimeout(this.terminalSearchTimer);
    this.hideTerminalSearchHoverPopup();
    if (this.terminalSearchAbort) this.terminalSearchAbort.abort();
    this.terminalSearchAbort = null;
    this.terminalSearchText = "";
    this.terminalSearchEditorOpen = false;
    this.terminalSearchGroupId = null;
    this.terminalSearchWorktreeId = null;
    this.terminalSearchFocusIndex = -1;
    this.terminalSearchMatches.clear();
    this.terminalSearchClosedMatches.clear();
    this.terminalTitleSearchResults = [];
    this.historySearchResults = [];
    this.renderList();
    requestAnimationFrame(() => this.focusActiveEditor());
  }

  collapsibleSectionLabel(text, field, extra = null) {
    const collapsed = this.sectionCollapsed(field);
    const label = document.createElement("div");
    label.className = "side-section-label side-section-header collapsible-section-header";
    const name = document.createElement("span");
    name.textContent = text;
    const controls = document.createElement("span");
    controls.className = "section-header-controls";
    const toggle = document.createElement("button");
    toggle.className = "section-toggle section-collapse-toggle";
    toggle.innerHTML = `<span class="codicon codicon-chevron-${collapsed ? "right" : "down"}"></span>`;
    toggle.title = collapsed ? `Expand ${text}` : `Collapse ${text}`;
    toggle.setAttribute("aria-label", toggle.title);
    toggle.setAttribute("aria-expanded", String(!collapsed));
    label.title = toggle.title;
    label.onclick = () => this.toggleSectionCollapsed(field);
    toggle.onclick = (event) => {
      event.stopPropagation();
      this.toggleSectionCollapsed(field);
    };
    label.append(toggle, name);
    if (extra) {
      controls.appendChild(extra);
      label.appendChild(controls);
    }
    return label;
  }

  sessionActivityTime(session) {
    if (!session) return 0;
    const known = Number(this.sessionActivityAt.get(session.session_id) || 0);
    const serverActivity = Number(session.last_activity_at || 0);
    const serverActivityMs = serverActivity > 1e12 ? serverActivity : serverActivity * 1000;
    const processingSince = Number(session.processing_since || 0) * 1000;
    const created = Date.parse(String(session.created_at_est || "").replace(" ", "T")) || 0;
    return Math.max(known, serverActivityMs, processingSince, created);
  }

  formatTerminalAge(elapsedMs) {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 60000) return "just now";
    const minutes = Math.floor(elapsedMs / 60000);
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    const remainingMinutes = minutes % 60;
    if (days) return `${days}d${hours ? ` ${hours}h` : ""}`;
    if (hours) return `${hours}h${remainingMinutes ? ` ${remainingMinutes}m` : ""}`;
    return `${minutes}m`;
  }

  terminalAgeText(session) {
    const timestamp = this.sessionActivityTime(session);
    if (!timestamp) return "unknown";
    return this.formatTerminalAge(Math.max(0, Date.now() - timestamp));
  }

  terminalAgeAgoLabel(session) {
    const label = this.terminalAgeText(session);
    return label === "unknown" || label === "just now" ? label : `${label} ago`;
  }

  terminalAgeBucketForActivityTime(timestamp) {
    if (!this.settings.show_terminal_age) return 0;
    const latest = this.latestTerminalActivityTime();
    if (!timestamp || !latest) return 0;
    const elapsed = Math.max(0, latest - timestamp);
    if (elapsed >= TERMINAL_AGE_WEEK_MS) return 2;
    return elapsed >= TERMINAL_AGE_DAY_MS ? 1 : 0;
  }

  terminalAgeColorForActivityTime(timestamp) {
    const baseMatch = String(this.settings.sidebar_text_color || "").match(/^#([0-9a-f]{6})$/i);
    const dimValue = getComputedStyle(document.body).getPropertyValue("--dim").trim();
    const dimMatch = dimValue.match(/^#([0-9a-f]{6})$/i);
    if (!baseMatch || !dimMatch) return this.settings.sidebar_text_color;
    const bucket = this.terminalAgeBucketForActivityTime(timestamp);
    const fade = bucket === 1 ? TERMINAL_AGE_INTERMEDIATE_FADE : bucket === 2 ? 1 : 0;
    const base = [0, 1, 2].map((index) => parseInt(baseMatch[1].slice(index * 2, index * 2 + 2), 16));
    const dim = [0, 1, 2].map((index) => parseInt(dimMatch[1].slice(index * 2, index * 2 + 2), 16));
    const color = base.map((value, index) => Math.round(value + (dim[index] - value) * fade));
    return `rgb(${color.join(", ")})`;
  }

  terminalAgeColor(session) {
    return this.terminalAgeColorForActivityTime(this.sessionActivityTime(session));
  }

  terminalAgeExactTimestamp(session) {
    const timestamp = this.sessionActivityTime(session);
    return timestamp ? new Date(timestamp).toLocaleString() : "activity time unavailable";
  }

  latestTerminalActivityTime() {
    return this.sessions.reduce((latest, session) => Math.max(latest, this.sessionActivityTime(session)), 0);
  }

  terminalAgeBucket(session) {
    return this.terminalAgeBucketForActivityTime(this.sessionActivityTime(session));
  }

  terminalGroupActivityTime(members) {
    return members.reduce((latest, session) => Math.max(latest, this.sessionActivityTime(session)), 0);
  }

  terminalGroupAgeColor(members) {
    const accentValue = getComputedStyle(document.body).getPropertyValue("--accent").trim();
    const accentMatch = accentValue.match(/^#([0-9a-f]{6})$/i);
    if (!accentMatch) return "var(--accent)";
    const bucket = this.terminalAgeBucketForActivityTime(this.terminalGroupActivityTime(members));
    const brightness = TERMINAL_GROUP_AGE_BRIGHTNESS[bucket];
    const channels = [0, 1, 2].map((index) => Math.round(
      parseInt(accentMatch[1].slice(index * 2, index * 2 + 2), 16) * brightness));
    return `rgb(${channels.join(", ")})`;
  }

  updateTerminalGroupAgeStyles() {
    if (this.vscodeMode) return;
    for (const group of this.terminalGroups()) {
      const label = this.$("session-list")?.querySelector(`[data-group-id="${CSS.escape(group.id)}"] > .terminal-group-label`);
      const name = label?.querySelector(".terminal-group-name");
      if (!name) continue;
      const members = this.groupSessionIds(group.id).map((id) => this.session(id)).filter(Boolean);
      name.style.color = this.terminalGroupAgeColor(members);
    }
  }

  updateSessionAgeStyles() {
    if (this.vscodeMode) return;
    for (const session of this.sessions) {
      const row = this.sessionRowEls.get(session.session_id);
      if (!row) continue;
      row.style.setProperty("--session-age-color", this.terminalAgeColor(session));
      const title = this.sessionTitleEls.get(session.session_id);
      if (title) {
        if (title.classList.contains("session-title-working")) title.style.removeProperty("color");
        else title.style.color = this.terminalAgeColor(session);
      }
      const baseTitle = row.dataset.baseTitle || row.title;
      row.title = `${baseTitle}\nlast activity ${this.terminalAgeAgoLabel(session)}\n${this.terminalAgeExactTimestamp(session)}`;
    }
    this.updateTerminalGroupAgeStyles();
  }

  updateActiveTerminalAge() {
    const age = this.$("terminal-age");
    if (!age) return;
    const session = this.session(this.activeId);
    if (this.vscodeMode || this.activeFileKey !== null || !session) {
      age.classList.add("hidden");
      age.textContent = "";
      age.title = "";
      return;
    }
    age.classList.remove("hidden");
    age.textContent = `last activity ${this.terminalAgeAgoLabel(session)}`;
    age.title = `Last terminal activity: ${this.terminalAgeExactTimestamp(session)}`;
  }

  touchSessionActivity(sessionId, timestamp = Date.now()) {
    if (!sessionId) return;
    const previous = Number(this.sessionActivityAt.get(sessionId) || 0);
    if (timestamp <= previous) return;
    this.sessionActivityAt.set(sessionId, timestamp);
  }

  updateHideInactiveTerminalsButton() {
    const button = this.$("active-toggle");
    if (!button) return;
    button.classList.toggle("on", this.hideInactiveTerminals);
    button.innerHTML = `<span class="codicon ${this.hideInactiveTerminals ? "codicon-eye-closed" : "codicon-eye"}"></span>`;
    button.setAttribute("aria-pressed", String(this.hideInactiveTerminals));
    button.title = this.hideInactiveTerminals ? "Show all terminals" : "Show active and unread terminals";
    button.setAttribute("aria-label", button.title);
  }

  toggleHideInactiveTerminals() {
    this.hideInactiveTerminals = !this.hideInactiveTerminals;
    this.updateHideInactiveTerminalsButton();
    this.renderList();
  }

  isActiveTerminal(session) {
    return !!session && (this.processingStates.get(session.session_id) === true ||
      session.processing === true || session.needs_attention === true || this.unreadSessions.has(session.session_id));
  }

  updateTerminalSearchGroupButton() {
    const button = this.$("terminal-search-group-toggle");
    if (!button) return;
    button.classList.toggle("on", this.terminalSearchGroupSimilar);
    button.setAttribute("aria-pressed", String(this.terminalSearchGroupSimilar));
    button.title = this.terminalSearchGroupSimilar
      ? "Show search results by terminal"
      : "Group similar matched text";
  }

  appendTerminalSearchHighlightedText(element, text, query) {
    const value = String(text || "");
    const terms = [...new Set(String(query || "").split(/\s+/).filter(Boolean))];
    const ranges = terms.flatMap((term) => this.searchHighlightRanges(value, term, { caseSensitive: false }))
      .sort((left, right) => left[0] - right[0] || right[1] - left[1]);
    const merged = [];
    for (const [start, end] of ranges) {
      const previous = merged[merged.length - 1];
      if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
      else merged.push([start, end]);
    }
    element.textContent = "";
    let cursor = 0;
    for (const [start, end] of merged) {
      if (start > cursor) element.appendChild(document.createTextNode(value.slice(cursor, start)));
      const mark = document.createElement("mark");
      mark.className = "terminal-search-highlight";
      mark.textContent = value.slice(start, end);
      element.appendChild(mark);
      cursor = end;
    }
    if (cursor < value.length) element.appendChild(document.createTextNode(value.slice(cursor)));
  }

  terminalSearchSnippetMatchesQuery(snippet) {
    const text = this.searchMatchText(snippet?.text).toLocaleLowerCase();
    const terms = String(this.terminalSearchText || "").toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return terms.length > 0 && terms.some((term) => text.includes(term));
  }

  terminalSearchTimestampMillis(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
      if (value > 1e16) return value / 1e6;
      if (value > 1e12) return value;
      return value * 1000;
    }
    if (!value) return 0;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && String(value).trim() !== "") return this.terminalSearchTimestampMillis(numeric);
    return Date.parse(String(value)) || 0;
  }

  terminalSearchTimestampLabel(value) {
    const timestamp = this.terminalSearchTimestampMillis(value);
    if (!timestamp) return { relative: "", exact: "" };
    const age = this.formatTerminalAge(Math.max(0, Date.now() - timestamp));
    return { relative: age === "just now" ? age : `${age} ago`, exact: new Date(timestamp).toLocaleString() };
  }

  renderTerminalSearchSnippets(match) {
    const snippets = document.createElement("div");
    snippets.className = "terminal-search-snippets";
    const matchingSnippets = (match?.snippets || []).filter((snippet) => this.terminalSearchSnippetMatchesQuery(snippet));
    for (const snippet of matchingSnippets.slice(0, 8)) {
      const row = document.createElement("div");
      row.className = "terminal-search-snippet";
      const heading = document.createElement("div");
      heading.className = "terminal-search-snippet-heading";
      const kind = document.createElement("span");
      kind.className = "terminal-search-snippet-kind";
      kind.textContent = snippet.kind === "name" ? "terminal name" : "conversation";
      heading.appendChild(kind);
      const timestamp = this.terminalSearchTimestampLabel(snippet.timestamp);
      if (timestamp.relative) {
        const age = document.createElement("span");
        age.className = "terminal-search-snippet-age";
        age.textContent = timestamp.relative;
        age.title = timestamp.exact;
        heading.appendChild(age);
      }
      if (snippet.result && snippet.source_path) {
        const expand = document.createElement("button");
        expand.type = "button";
        expand.className = "terminal-search-snippet-expand";
        expand.innerHTML = '<span class="codicon codicon-chevron-down"></span>';
        expand.title = "Show surrounding context";
        expand.setAttribute("aria-label", expand.title);
        expand.onclick = (event) => {
          event.preventDefault();
          event.stopPropagation();
          void this.toggleTerminalSearchSnippetContext(row, snippet, expand);
        };
        heading.appendChild(expand);
      }
      const text = document.createElement(snippet.result ? "button" : "div");
      if (snippet.result) text.type = "button";
      text.className = "terminal-search-snippet-text";
      this.appendTerminalSearchHighlightedText(text, this.searchMatchText(snippet.text), this.terminalSearchText);
      if (snippet.result) {
        text.title = "Open this turn in the Markdown transcript";
        text.onclick = (event) => {
          event.preventDefault();
          event.stopPropagation();
          void this.openTerminalSearchTranscriptMatch(snippet);
        };
      }
      const context = document.createElement("div");
      context.className = "terminal-search-snippet-context hidden";
      row.append(heading, text, context);
      snippets.appendChild(row);
    }
    return snippets;
  }

  async toggleTerminalSearchSnippetContext(row, snippet, button) {
    const context = row.querySelector(".terminal-search-snippet-context");
    const expanded = button.getAttribute("aria-expanded") === "true";
    if (expanded) {
      context.classList.add("hidden");
      button.setAttribute("aria-expanded", "false");
      button.querySelector(".codicon").className = "codicon codicon-chevron-down";
      return;
    }
    context.classList.remove("hidden");
    button.setAttribute("aria-expanded", "true");
    button.querySelector(".codicon").className = "codicon codicon-chevron-up";
    if (context.dataset.loaded === "true") return;
    context.textContent = "loading context…";
    try {
      const params = new URLSearchParams({ source: snippet.source_path, line: String(snippet.line || 1), radius: "6",
        q: this.terminalSearchText, include_operations: String(this.historySearchOperations) });
      const response = await fetch(`/api/history-context?${params}`);
      if (!response.ok) throw new Error("history context unavailable");
      const payload = await response.json();
      context.textContent = "";
      context.dataset.loaded = "true";
      for (const line of payload.lines || []) {
        const contextLine = document.createElement("button");
        contextLine.type = "button";
        contextLine.className = "terminal-search-context-line" +
          (Number(line.line_no) === Number(payload.line_no) ? " target" : "");
        const contextTimestamp = this.terminalSearchTimestampLabel(line.timestamp);
        if (contextTimestamp.relative) {
          const age = document.createElement("span");
          age.className = "terminal-search-context-age";
          age.textContent = contextTimestamp.relative;
          age.title = contextTimestamp.exact;
          contextLine.appendChild(age);
        }
        const content = document.createElement("span");
        content.className = "terminal-search-context-text";
        this.appendTerminalSearchHighlightedText(content, this.searchMatchText(line.text), this.terminalSearchText);
        contextLine.appendChild(content);
        contextLine.title = "Open this turn in the Markdown transcript";
        contextLine.onclick = (event) => {
          event.preventDefault();
          event.stopPropagation();
          void this.openTerminalSearchTranscriptMatch({ ...snippet, line: line.line_no, text: line.text,
            timestamp: line.timestamp });
        };
        context.appendChild(contextLine);
      }
      if (!context.childElementCount) context.textContent = "no surrounding conversation available";
    } catch (error) {
      context.textContent = error.message || "history context unavailable";
    }
  }

  terminalSearchHoverPopup() {
    let popup = document.getElementById("terminal-search-hover-popup");
    if (popup) return popup;
    popup = document.createElement("div");
    popup.id = "terminal-search-hover-popup";
    popup.className = "hidden";
    popup.addEventListener("mouseenter", () => this.cancelTerminalSearchHoverHide());
    popup.addEventListener("mouseleave", () => this.scheduleTerminalSearchHoverHide());
    document.body.appendChild(popup);
    return popup;
  }

  showTerminalSearchHoverPopup(item, match) {
    if (!item?.isConnected || !match || !this.terminalSearchText.trim()) return;
    this.cancelTerminalSearchHoverHide();
    const snippets = this.renderTerminalSearchSnippets(match);
    if (!snippets.childElementCount) {
      this.hideTerminalSearchHoverPopup();
      return;
    }
    const popup = this.terminalSearchHoverPopup();
    popup.replaceChildren(snippets);
    popup.classList.remove("hidden");
    const bounds = item.getBoundingClientRect();
    const availableWidth = Math.max(320, window.innerWidth - bounds.right - 18);
    popup.style.width = `${Math.min(660, availableWidth)}px`;
    popup.style.left = `${Math.max(8, Math.min(window.innerWidth - popup.offsetWidth - 8, bounds.right + 7))}px`;
    popup.style.top = `${Math.max(8, Math.min(bounds.top, window.innerHeight - popup.offsetHeight - 8))}px`;
  }

  hideTerminalSearchHoverPopup() {
    this.cancelTerminalSearchHoverHide();
    document.getElementById("terminal-search-hover-popup")?.classList.add("hidden");
  }

  cancelTerminalSearchHoverHide() {
    clearTimeout(this.terminalSearchHoverHideTimer);
    this.terminalSearchHoverHideTimer = 0;
  }

  scheduleTerminalSearchHoverHide() {
    this.cancelTerminalSearchHoverHide();
    this.terminalSearchHoverHideTimer = window.setTimeout(() => this.hideTerminalSearchHoverPopup(), 320);
  }

  bindTerminalSearchHoverPopup(item, match) {
    if (!match) return;
    item.addEventListener("mouseenter", () => this.showTerminalSearchHoverPopup(item, match));
    item.addEventListener("mouseleave", () => this.scheduleTerminalSearchHoverHide());
    item.addEventListener("focus", () => this.showTerminalSearchHoverPopup(item, match));
    item.addEventListener("blur", () => this.scheduleTerminalSearchHoverHide());
  }

  terminalSearchRows() {
    return [...this.$("session-list").querySelectorAll(".session-item.terminal-search-match, .closed-item.terminal-search-match")];
  }

  moveTerminalSearchRow(direction) {
    const rows = this.terminalSearchRows();
    if (!rows.length) return;
    const current = rows.indexOf(document.activeElement);
    const start = current >= 0 ? current : this.terminalSearchFocusIndex;
    this.terminalSearchFocusIndex = (start + direction + rows.length) % rows.length;
    const row = rows[this.terminalSearchFocusIndex];
    row.focus({ preventScroll: true });
    row.scrollIntoView({ block: "nearest" });
  }

  openTerminalFind() {
    const view = this.views.get(this.activeId);
    if (!view || view.closed || this.activeFileKey !== null || this.historyOpen) return;
    const panel = this.$("terminal-find");
    const input = this.$("terminal-find-input");
    if (!panel || !input) return;
    panel.classList.remove("hidden");
    this.terminalFindSessionId = view.sessionId;
    input.focus();
    input.select();
    this.updateTerminalFindMatches();
  }

  closeTerminalFind() {
    this.$("terminal-find")?.classList.add("hidden");
    this.$("terminal-find-count").textContent = "";
    this.terminalFindQuery = "";
    this.terminalFindSessionId = "";
    this.terminalFindFallbackMatches = [];
    this.terminalFindFallbackIndex = -1;
    const view = this.views.get(this.activeId);
    if (view) {
      view.terminalFindAddon?.clearDecorations();
      // After the state above is cleared, so the override resolves to null and the normal selection
      // color comes back for ordinary selections.
      this.applyTerminalFindHighlight(view);
      view.term.focus();
    }
  }

  terminalFindOptions(incremental = false) {
    return { caseSensitive: false, incremental, decorations: TERMINAL_FIND_DECORATIONS };
  }

  // Only the session actually being searched gets the override, and only while a query is live, so an
  // ordinary mouse selection anywhere (including in this same terminal once find closes) keeps the normal,
  // deliberately unobtrusive selection color.
  terminalFindThemeOverride(view) {
    if (!view || view.sessionId !== this.terminalFindSessionId || !this.terminalFindQuery) return null;
    return { selectionBackground: TERMINAL_FIND_SELECTION_BACKGROUND,
             selectionInactiveBackground: TERMINAL_FIND_SELECTION_BACKGROUND,
             selectionForeground: TERMINAL_FIND_SELECTION_FOREGROUND };
  }

  applyTerminalFindHighlight(view) {
    if (!view || view.closed || !view.term) return;
    view.term.options.theme = { ...this.termTheme(), ...(this.terminalFindThemeOverride(view) || {}) };
  }

  prepareTerminalFindNavigation(view) {
    view.userScrollIntent = true;
    view.scrollMode = "preserve";
    this.cancelTerminalViewportRestore(view);
    this.clearActiveTerminalSettleWatchdog(view);
    clearTimeout(view.tailRepairTimer);
    clearTimeout(view.tailRepairConfirmTimer);
    view.tailRepairTimer = 0;
    view.tailRepairConfirmTimer = 0;
  }

  updateTerminalFindResultCount(view, result) {
    view.terminalFindResultIndex = Number(result.resultIndex);
    view.terminalFindResultCount = Number(result.resultCount);
    if (view.sessionId !== this.activeId || view.sessionId !== this.terminalFindSessionId ||
        this.$("terminal-find")?.classList.contains("hidden")) return;
    const count = this.$("terminal-find-count");
    if (!count) return;
    if (view.terminalFindResultCount <= 0) {
      count.textContent = "no matches";
    } else if (view.terminalFindResultIndex < 0) {
      count.textContent = `${view.terminalFindResultCount}${view.terminalFindResultCount >= TERMINAL_FIND_HIGHLIGHT_LIMIT ? "+" : ""} matches`;
    } else {
      count.textContent = `${view.terminalFindResultIndex + 1}/${view.terminalFindResultCount}`;
    }
  }

  terminalBufferFindMatches(view, query) {
    const matches = [];
    const needle = query.toLocaleLowerCase();
    const buffer = view.term.buffer.active;
    for (let row = 0; row < buffer.length; row += 1) {
      const line = buffer.getLine(row);
      const searchable = (line?.translateToString(true) || "").toLocaleLowerCase();
      let column = searchable.indexOf(needle);
      while (column >= 0) {
        matches.push({ row, column });
        column = searchable.indexOf(needle, column + Math.max(1, needle.length));
      }
    }
    return matches;
  }

  revealTerminalBufferFindMatch(view, query) {
    const count = this.$("terminal-find-count");
    const match = this.terminalFindFallbackMatches[this.terminalFindFallbackIndex];
    if (!match) {
      if (count) count.textContent = "no matches";
      return false;
    }
    view.v2Programmatic = true;
    const buffer = view.term.buffer.active;
    const viewportStart = Math.max(0, Number(buffer.viewportY || 0));
    const viewportRows = Math.max(1, Number(view.term.rows || 1));
    if (match.row < viewportStart || match.row >= viewportStart + viewportRows) {
      const centeredLine = match.row - Math.floor(viewportRows / 2);
      view.term.scrollToLine(Math.max(0, Math.min(centeredLine, Number(buffer.baseY || 0))));
    }
    view.term.select(match.column, match.row, query.length);
    this.scrollTallContainerToRow(view, match.row);
    requestAnimationFrame(() => { view.v2Programmatic = false; });
    if (count) count.textContent = `${this.terminalFindFallbackIndex + 1}/${this.terminalFindFallbackMatches.length}`;
    return true;
  }

  // Find highlights the match but cannot bring it into view on its own here. Both mechanisms above are
  // no-ops against the tall container: term.scrollToLine moves xterm's viewport, which is not the surface
  // being scrolled any more, and the guard that decides whether to call it compares against term.rows --
  // 1000 here -- so a match almost always looks "already visible" and it is never even called. The result
  // is a highlighted, selected match somewhere outside the ~37 rows actually on screen. Centering is
  // deliberate rather than a minimal scroll-into-view: a match found mid-search usually wants its
  // surrounding context readable, and centering also keeps repeat presses of the same direction moving a
  // predictable distance instead of pinning the match to whichever edge it entered from.
  scrollTallContainerToRow(view, absoluteRow) {
    if (!view || view.closed) return;
    const cellHeight = view.term._core?._renderService?.dimensions?.css?.cell?.height;
    if (!cellHeight || !view.container.clientHeight) return;
    // Read viewportY now, not before: the scrollToLine above may have just moved it to reach a match
    // that was sitting in real scrollback, and this row is in absolute buffer coordinates.
    const canvasRow = absoluteRow - Number(view.term.buffer.active.viewportY || 0);
    const centered = canvasRow * cellHeight - Math.max(0, (view.container.clientHeight - cellHeight) / 2);
    const nativeMax = Math.max(0, view.container.scrollHeight - view.container.clientHeight);
    // Honor the same content ceiling the scroll listener enforces, so centering a match near the end
    // cannot park the view in the blank rows past the content.
    const ceiling = view.tallMaxScrollTop == null ? nativeMax : Math.min(nativeMax, view.tallMaxScrollTop);
    this.tallSetScrollTop(view, Math.min(centered, ceiling));
    // Searching is the user asking to look at something specific, so stop following new output -- other-
    // wise the next write scrolls straight back to the prompt and the match they just navigated to is
    // gone. Typing resumes following (see the key handler in ensureView). Anchoring to the match's row
    // keeps it pinned even as new output pushes lines into scrollback underneath it.
    view.tallFollowing = false;
    this.tallCaptureAnchorRow(view);
  }

  useTerminalBufferFindFallback(view, query, direction = 0) {
    const reusable = this.terminalFindSessionId === view.sessionId && this.terminalFindQuery === query &&
      this.terminalFindFallbackMatches.length > 0;
    if (!reusable) {
      this.terminalFindFallbackMatches = this.terminalBufferFindMatches(view, query);
      this.terminalFindFallbackIndex = direction < 0 ? this.terminalFindFallbackMatches.length - 1 : 0;
    } else if (direction) {
      this.terminalFindFallbackIndex = (this.terminalFindFallbackIndex + direction + this.terminalFindFallbackMatches.length) %
        this.terminalFindFallbackMatches.length;
    }
    return this.revealTerminalBufferFindMatch(view, query);
  }

  updateTerminalFindMatches() {
    const input = this.$("terminal-find-input");
    const view = this.views.get(this.activeId);
    if (!input || !view || view.closed || this.activeFileKey !== null || this.historyOpen) return;
    const query = input.value;
    if (this.terminalFindSessionId && this.terminalFindSessionId !== view.sessionId) {
      this.views.get(this.terminalFindSessionId)?.terminalFindAddon?.clearDecorations();
    }
    view.terminalFindAddon?.clearDecorations();
    this.terminalFindSessionId = view.sessionId;
    this.terminalFindQuery = query;
    this.terminalFindFallbackMatches = [];
    this.terminalFindFallbackIndex = -1;
    this.applyTerminalFindHighlight(view);
    if (!query) {
      this.$("terminal-find-count").textContent = "";
      return;
    }
    this.prepareTerminalFindNavigation(view);
    this.terminalFindFallbackMatches = this.terminalBufferFindMatches(view, query);
    this.terminalFindFallbackIndex = 0;
    this.revealTerminalBufferFindMatch(view, query);
  }

  moveTerminalFindMatch(direction) {
    const input = this.$("terminal-find-input");
    const view = this.views.get(this.activeId);
    const query = input?.value || "";
    if (!view || !query) return;
    if (this.terminalFindSessionId !== view.sessionId || this.terminalFindQuery !== query ||
        !this.terminalFindFallbackMatches.length) {
      this.updateTerminalFindMatches();
      if (!this.terminalFindFallbackMatches.length) return;
      if (direction < 0) this.terminalFindFallbackIndex = this.terminalFindFallbackMatches.length - 1;
      this.revealTerminalBufferFindMatch(view, query);
      return;
    }
    this.prepareTerminalFindNavigation(view);
    this.terminalFindFallbackIndex = (this.terminalFindFallbackIndex + direction + this.terminalFindFallbackMatches.length) %
      this.terminalFindFallbackMatches.length;
    this.revealTerminalBufferFindMatch(view, query);
  }

  clearTerminalSearch() {
    const preserveInputFocus = document.activeElement?.id === "terminal-search-input";
    const input = this.$("terminal-search-input");
    clearTimeout(this.terminalSearchTimer);
    if (this.terminalSearchAbort) this.terminalSearchAbort.abort();
    this.terminalSearchAbort = null;
    this.terminalSearchText = "";
    if (input) input.value = "";
    this.terminalSearchFocusIndex = -1;
    this.terminalTitleSearchResults = [];
    this.historySearchResults = [];
    this.terminalSearchMatches.clear();
    this.terminalSearchClosedMatches.clear();
    this.renderList();
    if (preserveInputFocus) requestAnimationFrame(() => this.$("terminal-search-input")?.focus());
  }

  filterTerminalSearchMatchesToGroup() {
    if (!this.terminalSearchGroupId) return;
    const worktreeId = this.terminalSearchWorktreeId || this.stateWorktreeId();
    const state = this.getProjectStateForWorktree(worktreeId);
    for (const sessionId of this.terminalSearchMatches.keys()) {
      if (state.session_groups?.[sessionId] !== this.terminalSearchGroupId) this.terminalSearchMatches.delete(sessionId);
    }
    this.terminalSearchClosedMatches.clear();
  }

  expandGlobalTerminalSearchClosedSections() {
    if (this.terminalSearchGroupId) return;
    if (this.worktreeId !== ALL_WORKTREES_ID) {
      this.closedExpanded = true;
      return;
    }
    for (const worktree of this.availableWorktreeSections()) {
      const worktreeId = String(worktree.id);
      this.setWorktreeSectionCollapsed(worktreeId, false);
      this.setWorktreeClosedExpanded(worktreeId, true);
    }
  }

  mergeTerminalSearchMatch(target, sessionId, incoming) {
    if (!sessionId || !incoming) return;
    const previous = target.get(sessionId) || { count: 0, snippets: [] };
    const snippets = [...(previous.snippets || [])];
    const keys = new Set(snippets.map((snippet) => `${snippet.source_path || ""}:${snippet.line || ""}:${snippet.text || ""}`));
    for (const snippet of incoming.snippets || []) {
      const key = `${snippet.source_path || ""}:${snippet.line || ""}:${snippet.text || ""}`;
      if (keys.has(key)) continue;
      keys.add(key);
      snippets.push(snippet);
    }
    target.set(sessionId, { count: Number(previous.count || 0) + Number(incoming.count || 0), snippets });
  }

  historyTerminalSearchMatch(result) {
    return {
      count: result.count,
      snippets: (result.matches || []).map((match) => ({
        line: match.line_no,
        text: match.text,
        timestamp: match.timestamp,
        source_path: result.source_path,
        result,
      })),
    };
  }

  async runTerminalSearch() {
    const input = this.$("terminal-search-input");
    const query = String(input?.value ?? this.terminalSearchText).trim();
    const preserveInputFocus = document.activeElement?.id === "terminal-search-input";
    this.terminalSearchText = query;
    this.terminalSearchFocusIndex = -1;
    if (!query) {
      this.clearTerminalSearch();
      return;
    }
    if (this.terminalSearchAbort) this.terminalSearchAbort.abort();
    this.terminalSearchAbort = new AbortController();
    this.terminalTitleSearchResults = this.matchingTerminalTitleSearchResults(query);
    this.terminalSearchMatches = new Map(this.terminalTitleSearchResults.map((result) => [result.open_session_id, {
      count: 1, snippets: [{ line: "name", text: result.title, kind: "name" }],
    }]));
    this.terminalSearchClosedMatches = new Map(this.closedSessions
      .filter((session) => String(session.title || "").toLocaleLowerCase().includes(query.toLocaleLowerCase()))
      .map((session) => [session.session_id, { count: 1, snippets: [{ line: "name", text: session.title, kind: "name" }] }]));
    this.filterTerminalSearchMatchesToGroup();
    this.expandGlobalTerminalSearchClosedSections();
    this.renderList();
    const searchingSummary = this.$("terminal-search-summary");
    if (searchingSummary) searchingSummary.textContent = "searching…";
    if (preserveInputFocus) requestAnimationFrame(() => this.$("terminal-search-input")?.focus());
    try {
      const historyParams = new URLSearchParams({ q: query, include_operations: String(this.historySearchOperations) });
      const requests = [fetch(`/api/history-search?${historyParams}`, { signal: this.terminalSearchAbort.signal })];
      if (this.historySearchOperations) {
        const liveParams = new URLSearchParams({ q: query });
        requests.push(fetch(`/api/terminal-search?${liveParams}`, { signal: this.terminalSearchAbort.signal }));
      }
      const [historyResponse, liveResponse] = await Promise.all(requests);
      if (!historyResponse.ok) throw new Error(await historyResponse.text());
      if (liveResponse && !liveResponse.ok) throw new Error(await liveResponse.text());
      const liveResults = liveResponse ? await liveResponse.json() : [];
      const historyPayload = await historyResponse.json();
      this.historySearchResults = Array.isArray(historyPayload.results) ? historyPayload.results : [];
      if (this.terminalSearchText.trim() !== query) return;
      this.terminalSearchMatches = new Map(this.terminalTitleSearchResults.map((result) => [result.open_session_id, {
        count: 1, snippets: [{ line: "name", text: result.title, kind: "name" }],
      }]));
      this.terminalSearchClosedMatches = new Map(this.closedSessions
        .filter((session) => String(session.title || "").toLocaleLowerCase().includes(query.toLocaleLowerCase()))
        .map((session) => [session.session_id, { count: 1, snippets: [{ line: "name", text: session.title, kind: "name" }] }]));
      for (const result of liveResults) this.mergeTerminalSearchMatch(this.terminalSearchMatches, result.session_id, result);
      for (const result of this.historySearchResults) {
        const openSessionId = result.open_session_id || result.parent_open_session_id;
        const closedSessionId = result.closed_session_id || result.parent_closed_session_id;
        const match = this.historyTerminalSearchMatch(result);
        if (openSessionId) this.mergeTerminalSearchMatch(this.terminalSearchMatches, openSessionId, match);
        else if (closedSessionId) this.mergeTerminalSearchMatch(this.terminalSearchClosedMatches, closedSessionId, match);
      }
      this.filterTerminalSearchMatchesToGroup();
      const terminalCount = this.terminalSearchMatches.size + this.terminalSearchClosedMatches.size;
      const matchCount = [...this.terminalSearchMatches.values(), ...this.terminalSearchClosedMatches.values()]
        .reduce((sum, result) => sum + Number(result.count || 0), 0);
      const indexing = historyPayload.indexing ? " · indexing history" : "";
      const scope = this.historySearchOperations ? "all output" : "conversation";
      const groupScope = this.terminalSearchGroupName();
      const summaryPrefix = groupScope ? `${groupScope} · ` : "";
      this.renderList();
      const summary = this.$("terminal-search-summary");
      if (summary) summary.textContent = terminalCount
        ? `${summaryPrefix}${scope} · ${terminalCount} terminal${terminalCount === 1 ? "" : "s"} · ${matchCount} match${matchCount === 1 ? "" : "es"}${indexing}`
        : `${summaryPrefix}no ${scope} matches${indexing}`;
      if (preserveInputFocus) requestAnimationFrame(() => this.$("terminal-search-input")?.focus());
    } catch (error) {
      if (error.name === "AbortError") return;
      this.historySearchResults = [];
      this.renderList();
      const summary = this.$("terminal-search-summary");
      if (summary) summary.textContent = this.terminalSearchMatches.size
        ? `${this.terminalSearchMatches.size} terminal name match${this.terminalSearchMatches.size === 1 ? "" : "es"} · conversation search unavailable`
        : error.message || "search failed";
      if (preserveInputFocus) requestAnimationFrame(() => this.$("terminal-search-input")?.focus());
    }
  }

  matchingTerminalTitleSearchResults(query) {
    const terms = String(query || "").toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    return this.sessions.flatMap((session) => {
      const title = this.titlePresentation(session).text;
      const candidates = [title, session.title, session.cli_title, session.agent_session_id]
        .filter(Boolean).map((value) => String(value).toLocaleLowerCase());
      if (!terms.every((term) => candidates.some((value) => value.includes(term)))) return [];
      return [{ terminal_title_match: true, open_session_id: session.session_id, title, status: "open", count: 1 }];
    });
  }

  renderTerminalHistoryResults() {
    const container = this.$("terminal-search-results");
    container.textContent = "";
    this.renderTerminalTitleSearchResults(container);
    if (this.terminalSearchGroupSimilar) {
      this.renderSimilarTerminalHistoryResults(container);
      return;
    }
    const groups = new Map();
    for (const result of this.historySearchResults) {
      const sessionKey = this.searchResultSessionKey(result);
      if (!groups.has(sessionKey)) {
        groups.set(sessionKey, {
          title: this.searchResultTitle(result), count: 0, results: [],
        });
      }
      const group = groups.get(sessionKey);
      group.count += Number(result.count || 0);
      group.results.push(result);
    }
    for (const group of groups.values()) {
      const groupBox = document.createElement("div");
      groupBox.className = "terminal-history-group";
      const heading = document.createElement("div");
      heading.className = "terminal-history-group-title";
      const title = document.createElement("span");
      title.className = "terminal-history-group-name";
      title.textContent = group.title;
      const count = document.createElement("span");
      count.className = "terminal-history-result-count";
      count.textContent = String(group.count);
      heading.append(title, count, this.searchResultStatusIcon(group.results[0]));
      groupBox.appendChild(heading);
      for (const result of group.results) {
        for (const match of (result.matches || []).slice(0, 6)) {
          const item = document.createElement("div");
          item.className = "terminal-history-result-match";
          item.textContent = this.searchMatchText(match.text);
          item.title = `${result.is_subagent ? `${result.title} · ` : ""}Open ${group.title} at line ${match.line_no}`;
          item.onclick = () => this.openHistorySearchContext(result, match.line_no || 1);
          groupBox.appendChild(item);
        }
      }
      container.appendChild(groupBox);
    }
  }

  renderTerminalTitleSearchResults(container) {
    if (!this.terminalTitleSearchResults.length) return;
    const section = document.createElement("div");
    section.className = "terminal-history-title-matches";
    for (const result of this.terminalTitleSearchResults) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "terminal-history-title-match";
      const icon = document.createElement("span");
      icon.className = "codicon codicon-terminal";
      const title = document.createElement("span");
      title.className = "terminal-history-title-match-name";
      title.textContent = result.title;
      const label = document.createElement("span");
      label.className = "terminal-history-title-match-label";
      label.textContent = "name";
      row.append(icon, title, label);
      row.title = `Activate ${result.title}`;
      row.onclick = () => {
        this.activate(result.open_session_id, { reveal: true });
        if (!this.settings.files_pinned) this.setSideView("terminals", false);
      };
      section.appendChild(row);
    }
    container.appendChild(section);
  }

  searchResultSessionKey(result) {
    if (result.is_subagent && result.parent_agent_session_id) {
      return `parent:${result.agent_kind}:${result.parent_agent_session_id}`;
    }
    return result.open_session_id || result.closed_session_id ||
      (result.agent_session_id ? `${result.agent_kind}:${result.agent_session_id}` :
        result.title ? `title:${result.title}` : `source:${result.source_path}`);
  }

  searchResultTitle(result) {
    return result.is_subagent && result.parent_title
      ? result.parent_title
      : result.title || `${result.agent_kind} session`;
  }

  searchResultStatus(result) {
    return result.parent_status || result.status || "not_open";
  }

  searchResultStatusIcon(result) {
    const status = this.searchResultStatus(result);
    const wrapper = document.createElement("span");
    wrapper.className = `terminal-history-result-status ${status.replace(/_/g, "-")}`;
    const iconClass = status === "open" ? "codicon-circle-filled" :
      status === "closed" ? "codicon-history" : "codicon-circle-outline";
    const label = status === "open" ? "open terminal" : status === "closed" ? "closed terminal" : "not opened";
    const icon = document.createElement("span");
    icon.className = `codicon ${iconClass}`;
    icon.setAttribute("aria-hidden", "true");
    wrapper.appendChild(icon);
    wrapper.title = label;
    wrapper.setAttribute("aria-label", label);
    return wrapper;
  }

  searchMatchText(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  renderSimilarTerminalHistoryResults(container) {
    const groups = new Map();
    for (const result of this.historySearchResults) {
      for (const match of (result.matches || []).slice(0, 6)) {
        const text = this.searchMatchText(match.text);
        if (!text) continue;
        const key = text.toLocaleLowerCase();
        if (!groups.has(key)) groups.set(key, { text, entries: new Map() });
        const group = groups.get(key);
        const sessionKey = this.searchResultSessionKey(result);
        if (!group.entries.has(sessionKey)) group.entries.set(sessionKey, { result, match });
      }
    }
    for (const group of groups.values()) {
      const groupBox = document.createElement("div");
      groupBox.className = "terminal-history-group terminal-history-similar-group";
      const heading = document.createElement("div");
      heading.className = "terminal-history-group-title";
      const text = document.createElement("span");
      text.className = "terminal-history-group-name";
      text.textContent = group.text;
      text.title = group.text;
      const count = document.createElement("span");
      count.className = "terminal-history-result-count";
      count.textContent = String(group.entries.size);
      heading.append(text, count);
      groupBox.appendChild(heading);
      for (const { result, match } of group.entries.values()) {
        const row = document.createElement("div");
        row.className = "terminal-history-similar-terminal";
        const name = document.createElement("span");
        name.className = "terminal-history-similar-terminal-name";
        name.textContent = result.is_subagent && result.parent_title
          ? `${result.parent_title} · ${result.title || "subagent"}`
          : this.searchResultTitle(result);
        row.append(name, this.searchResultStatusIcon(result));
        row.title = `Open ${name.textContent} at line ${match.line_no}`;
        row.onclick = () => this.openHistorySearchContext(result, match.line_no || 1);
        groupBox.appendChild(row);
      }
      container.appendChild(groupBox);
    }
  }

  async openHistorySearchContext(result, lineNo) {
    this.historySearchContextResult = result;
    this.$("history-search-backdrop").classList.remove("hidden");
    const resultTitle = result.is_subagent && result.parent_title
      ? `${result.parent_title} · ${result.title || "subagent"}`
      : result.title || "History match";
    this.$("history-search-title").textContent = `${resultTitle} · line ${lineNo}`;
    const openButton = this.$("history-search-open");
    const status = this.searchResultStatus(result);
    openButton.textContent = status === "open" ? "Activate terminal" : status === "closed" ? "Reopen terminal" : "Open parent terminal";
    const context = this.$("history-search-context");
    context.textContent = "loading history context…";
    try {
      const params = new URLSearchParams({ source: result.source_path, line: String(lineNo), radius: "4",
        q: this.$("terminal-search-input").value, include_operations: String(this.historySearchOperations) });
      const response = await fetch(`/api/history-context?${params}`);
      if (!response.ok) throw new Error("history context unavailable");
      const payload = await response.json();
      context.textContent = "";
      for (const line of payload.lines || []) {
        const row = document.createElement("div");
        row.className = "history-search-context-line" + (Number(line.line_no) === Number(payload.line_no) ? " target" : "");
        const number = document.createElement("span");
        number.className = "history-search-context-number";
        number.textContent = line.line_no;
        const text = document.createElement("span");
        text.className = "history-search-context-text";
        text.textContent = line.text;
        row.append(number, text);
        context.appendChild(row);
      }
    } catch (error) {
      context.textContent = error.message || "history context unavailable";
    }
  }

  closeHistorySearchContext() {
    this.$("history-search-backdrop").classList.add("hidden");
    this.historySearchContextResult = null;
  }

  async ensureHistorySearchSession(result) {
    const isSubagent = !!result.is_subagent;
    let sessionId = isSubagent ? result.parent_open_session_id : result.open_session_id;
    const closedSessionId = isSubagent ? result.parent_closed_session_id : result.closed_session_id;
    const sessionReference = isSubagent ? result.parent_agent_session_id : result.agent_session_id;
    const sessionTitle = isSubagent ? (result.parent_title || result.title) : result.title;
    if (closedSessionId) {
      const response = await fetch(`/api/closed/${closedSessionId}/reopen`, { method: "POST" });
      if (!response.ok) return;
      sessionId = closedSessionId;
    } else if (!sessionId) {
      const response = await fetch("/api/sessions", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: result.agent_kind, permission: "default", session_ref: sessionReference,
          cwd: (isSubagent ? result.parent_cwd : result.cwd) || result.cwd || "~", title: sessionTitle || "" }),
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        alert(detail.detail || "unable to open saved session");
        return null;
      }
      sessionId = (await response.json()).session_id;
    }
    return sessionId;
  }

  async openHistorySearchSession() {
    const result = this.historySearchContextResult;
    if (!result) return;
    const sessionId = await this.ensureHistorySearchSession(result);
    if (!sessionId) return;
    this.closeHistorySearchContext();
    await this.refresh();
    this.activate(sessionId, { reveal: true });
  }

  async openTerminalSearchTranscriptMatch(snippet) {
    if (!snippet?.result) return;
    const query = this.terminalSearchText;
    const sessionId = await this.ensureHistorySearchSession(snippet.result);
    if (!sessionId) return;
    this.pendingHistorySearchNavigation = {
      sessionId,
      query,
      text: this.searchMatchText(snippet.text).replace(/^…+|…+$/g, "").trim(),
      sourcePath: snippet.source_path,
      line: Number(snippet.line || 0),
    };
    this.hideTerminalSearchHoverPopup();
    this.closeTerminalSearchEditor();
    await this.refresh();
    this.settings.history_mode = true;
    this.saveSettings();
    this.activate(sessionId, { reveal: true });
    if (!this.historyOpen) this.setHistoryMode(true);
    this.schedulePendingHistorySearchReveal();
  }

  normalizedHistorySearchText(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
  }

  pendingHistorySearchTurnIndex(target, allowQueryFallback = false) {
    const targetText = this.normalizedHistorySearchText(target.text);
    if (targetText.length >= 8) {
      const exactIndex = this.historyTurns.findIndex((turn) =>
        this.normalizedHistorySearchText(turn?.text).includes(targetText));
      if (exactIndex >= 0) return exactIndex;
    }
    if (!allowQueryFallback) return -1;
    const terms = this.normalizedHistorySearchText(target.query).split(/\s+/).filter(Boolean);
    if (!terms.length) return -1;
    return this.historyTurns.findIndex((turn) => {
      const text = this.normalizedHistorySearchText(turn?.text);
      return text && terms.every((term) => text.includes(term));
    });
  }

  schedulePendingHistorySearchReveal() {
    if (!this.pendingHistorySearchNavigation || this.historySearchNavigationBusy) return;
    requestAnimationFrame(() => { void this.revealPendingHistorySearchMatch(); });
  }

  async revealPendingHistorySearchMatch() {
    const target = this.pendingHistorySearchNavigation;
    if (!target || this.historySearchNavigationBusy || target.sessionId !== this.activeId || !this.historyOpen) return;
    this.historySearchNavigationBusy = true;
    let index = -1;
    try {
      for (let page = 0; page < 25; page += 1) {
        index = this.pendingHistorySearchTurnIndex(target, false);
        if (index >= 0 || !this.historyHasMoreBySession.get(target.sessionId)) break;
        const previousBefore = this.historyBeforeBySession.get(target.sessionId);
        const loaded = await this.loadOlderHistory();
        if (!loaded || previousBefore === this.historyBeforeBySession.get(target.sessionId)) break;
      }
      if (index < 0) index = this.pendingHistorySearchTurnIndex(target, true);
      if (index < 0) return;
      const body = this.$("history-body");
      const turn = body?.children[index];
      if (!turn) return;
      this.pendingHistorySearchNavigation = null;
      turn.classList.add("history-search-target-turn");
      turn.scrollIntoView({ block: "center", behavior: "smooth" });
      window.setTimeout(() => turn.classList.remove("history-search-target-turn"), 3200);
    } finally {
      this.historySearchNavigationBusy = false;
    }
  }

  terminalTypeIcon(s) {
    const icon = document.createElement("span");
    icon.className = "terminal-type-icon";
    icon.setAttribute("aria-hidden", "true");
    if (TERMINAL_TYPE_SVGS[s.agent_kind]) {
      icon.innerHTML = TERMINAL_TYPE_SVGS[s.agent_kind];
    } else {
      icon.innerHTML = '<span class="codicon codicon-terminal"></span>';
    }
    icon.title = s.agent_kind === "claude" ? "Claude" : s.agent_kind === "codex" ? "Codex" : s.agent_kind === "agy" ? "AGY" : "Shell terminal";
    icon.classList.toggle("claude-terminal-icon", s.agent_kind === "claude");
    icon.classList.toggle("codex-terminal-icon", s.agent_kind === "codex");
    icon.classList.toggle("agy-terminal-icon", s.agent_kind === "agy");
    icon.classList.toggle("on", this.terminalIconEnabledForAgent(s.agent_kind));
    return icon;
  }

  terminalGroupLabel(group, attentionCount = 0, working = false, members = []) {
    const label = document.createElement("div");
    label.className = "side-section-label terminal-group-label";
    label.dataset.worktreeId = this.stateWorktreeId();
    const chevron = document.createElement("span");
    chevron.className = "codicon " + (group.collapsed ? "codicon-chevron-right" : "codicon-chevron-down");
    const name = document.createElement("span");
    name.className = "terminal-group-name";
    name.textContent = group.name;
    if (!this.vscodeMode) name.style.color = this.terminalGroupAgeColor(members);
    const unreadDot = document.createElement("span");
    const groupNeedsAttention = members.some((session) => this.attentionSessions.has(session.session_id));
    unreadDot.className = "group-unread-dot" + (attentionCount || groupNeedsAttention ? " on" : "");
    unreadDot.title = attentionCount ? `${attentionCount} active or unread terminal${attentionCount === 1 ? "" : "s"}` : "";
    const attentionNumber = document.createElement("span");
    attentionNumber.className = "group-unread-count";
    attentionNumber.textContent = attentionCount ? String(attentionCount) : "";
    const attention = document.createElement("span");
    attention.className = "group-attention";
    attention.append(unreadDot, attentionNumber);
    const indicator = document.createElement("span");
    indicator.className = "group-drop-indicator";
    indicator.innerHTML = '<span class="codicon codicon-folder-library"></span><span>group</span>';
    label.title = "Click to collapse/expand · right-click for group actions · drop terminals here" +
      (working ? " · working" : "") + (attentionCount ? ` · ${attentionCount} active or unread` : "");
    label.append(chevron, name, attention, indicator);
    if (!this.vscodeMode) {
      const search = document.createElement("button");
      search.className = "terminal-group-search";
      search.type = "button";
      search.innerHTML = '<span class="codicon codicon-search"></span>';
      search.title = `Search terminals in ${group.name}`;
      search.setAttribute("aria-label", search.title);
      search.setAttribute("aria-pressed", String(this.terminalSearchEditorOpen && this.terminalSearchGroupId === group.id));
      search.classList.toggle("on", this.terminalSearchEditorOpen && this.terminalSearchGroupId === group.id);
      search.addEventListener("pointerdown", (event) => event.stopPropagation());
      search.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.setInteractionWorktreeFromElement(label);
        this.toggleTerminalSearchEditor(group.id);
      });
      const add = document.createElement("button");
      add.className = "terminal-group-add";
      add.type = "button";
      add.textContent = "+";
      add.title = `New terminal in ${group.name}`;
      add.setAttribute("aria-label", add.title);
      add.addEventListener("pointerdown", (event) => event.stopPropagation());
      add.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.setInteractionWorktreeFromElement(label);
        this.openModal(group.id);
      });
      label.insertBefore(search, attention);
      label.appendChild(add);
    }
    label.onclick = () => {
      this.setInteractionWorktreeFromElement(label);
      this.toggleTerminalGroup(group.id);
    };
    label.oncontextmenu = (event) => {
      this.setInteractionWorktreeFromElement(label);
      this.openTerminalGroupContextMenu(event, group);
    };
    this.makeLayoutDraggable(label, `group:${group.id}`, "group");
    return label;
  }

  renderTerminalItem(s, list) {
    const searchMatch = this.terminalSearchMatches.get(s.session_id);
    const item = document.createElement("div");
    item.className = "session-item" + (s.session_id === this.activeId && this.activeFileKey === null ? " active" : "") +
      (searchMatch ? " terminal-search-match" : "");
    if (searchMatch) item.tabIndex = 0;
    item.dataset.sessionId = s.session_id;
    item.dataset.worktreeId = this.worktreeIdForSession(s);
    item.classList.toggle("sidebar-selected", this.sidebarSelectedSessionIds.has(s.session_id));
    item.title = `${s.command || "zsh"}\n${s.cwd}` + (s.agent_session_id ? `\n${s.agent_kind}: ${s.agent_session_id}` : "") + "\nright-click for actions";
    if (searchMatch) {
      item.title += `\n${searchMatch.count} terminal match${searchMatch.count === 1 ? "" : "es"}`;
    }
    item.dataset.baseTitle = item.title;
    item.style.setProperty("--session-age-color", this.terminalAgeColor(s));
    this.sessionRowEls.set(s.session_id, item);
    const presentation = this.titlePresentation(s);
    const showDesktopBrandIndicator = !this.vscodeMode && this.terminalIconEnabledForAgent(s.agent_kind);
    const useTextStatusIndicator = !this.vscodeMode && !showDesktopBrandIndicator;
    if (useTextStatusIndicator) item.classList.add("terminal-icons-hidden");
    const dot = document.createElement("span");
    dot.className = "status-dot" + (s.running ? "" : s.dormant ? " dormant" : " exited") +
      (presentation.spinning ? " processing" : this.unreadSessions.has(s.session_id) ? " unread" : "") +
      (this.attentionSessions.has(s.session_id) ? " attention" : "");
    this.sessionStatusEls.set(s.session_id, dot);
    const title = document.createElement("span");
    title.className = "session-title";
    title.classList.toggle("session-title-working", useTextStatusIndicator && presentation.spinning);
    title.classList.toggle("session-title-unread",
      !this.vscodeMode && !presentation.spinning && this.unreadSessions.has(s.session_id));
    this.setSessionTitleText(title, presentation.text, useTextStatusIndicator && presentation.spinning);
    if (!this.vscodeMode && !presentation.spinning) title.style.color = this.terminalAgeColor(s);
    this.sessionTitleEls.set(s.session_id, title);
    const typeIcon = this.terminalTypeIcon(s);
    const iconStatusActive = showDesktopBrandIndicator &&
      (presentation.spinning || this.unreadSessions.has(s.session_id));
    const iconStatusExited = showDesktopBrandIndicator && !s.running && !s.dormant;
    typeIcon.classList.toggle("terminal-status-active", iconStatusActive);
    typeIcon.classList.toggle("terminal-status-exited", !iconStatusActive && iconStatusExited);
    const worktreeBadge = document.createElement("span");
    worktreeBadge.className = "worktree-badge";
    if (s.worktree_branch) {
      worktreeBadge.textContent = `⎇ ${s.worktree_branch.split("/").pop()}`;
      worktreeBadge.title = `Isolated worktree\n${s.worktree_path || ""}`;
    }
    const close = document.createElement("button");
    close.className = "item-close";
    close.textContent = "✕";
    close.title = this.shortcutTitle("Close terminal", "close-item");
    close.onclick = (event) => { event.stopPropagation(); this.closeSession(s.session_id); };
    const groupIndicator = document.createElement("span");
    groupIndicator.className = "group-drop-indicator";
    groupIndicator.innerHTML = '<span class="codicon codicon-folder-library"></span><span>group</span>';
    groupIndicator.title = "Release to group with this terminal";
    if (showDesktopBrandIndicator) item.append(dot, typeIcon, title, worktreeBadge, groupIndicator, close);
    else if (useTextStatusIndicator) item.append(dot, typeIcon, title, worktreeBadge, groupIndicator, close);
    else item.append(dot, typeIcon, title, worktreeBadge, groupIndicator, close);
    this.bindTerminalSearchHoverPopup(item, searchMatch);
    item.title = `${item.dataset.baseTitle}\nlast activity ${this.terminalAgeAgoLabel(s)}\n${this.terminalAgeExactTimestamp(s)}`;
    item.onclick = (event) => {
      this.setInteractionWorktreeFromElement(item, s);
      this.handleSessionRowSelection(event, s.session_id);
    };
    item.onfocus = () => {
      if (this.terminalSearchText.trim()) this.terminalSearchFocusIndex = this.terminalSearchRows().indexOf(item);
    };
    item.onkeydown = (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        this.moveTerminalSearchRow(event.key === "ArrowDown" ? 1 : -1);
      } else if (event.key === "Enter") {
        event.preventDefault();
        item.click();
      } else if (event.key === "Escape") {
        event.preventDefault();
        this.closeTerminalSearchEditor();
      }
    };
    item.onauxclick = (event) => {
      if (event.button !== 1) return;
      event.preventDefault();
      event.stopPropagation();
      this.openTerminalInNewTab(s);
    };
    item.oncontextmenu = (event) => {
      this.setInteractionWorktreeFromElement(item, s);
      this.openSessionContextMenu(event, s);
    };
    this.makeLayoutDraggable(item, `session:${s.session_id}`, "session");
    list.appendChild(item);
  }

  renderTerminalGroup(group, members, list) {
    const groupBox = document.createElement("div");
    groupBox.className = "terminal-group";
    groupBox.dataset.groupId = group.id;
    groupBox.dataset.worktreeId = this.stateWorktreeId();
    const attentionCount = members.filter((session) => this.processingStates.get(session.session_id) ||
      this.unreadSessions.has(session.session_id)).length;
    const working = members.some((session) => this.processingStates.get(session.session_id));
    groupBox.appendChild(this.terminalGroupLabel(group, attentionCount, working, members));
    const membersBox = document.createElement("div");
    membersBox.className = "terminal-group-members" + (group.collapsed ? " collapsed" : "");
    const membersInner = document.createElement("div");
    membersInner.className = "terminal-group-members-inner";
    for (const session of members) this.renderTerminalItem(session, membersInner);
    if (!members.length && this.terminalSearchText.trim() && this.terminalSearchGroupId === group.id) {
      const empty = document.createElement("div");
      empty.className = "terminal-search-empty";
      empty.textContent = "no terminals in this group match";
      membersInner.appendChild(empty);
    }
    membersBox.appendChild(membersInner);
    groupBox.appendChild(membersBox);
    list.appendChild(groupBox);
  }

  renderTerminalEntries(sessions, list, worktreeId) {
    const previousRenderWorktreeId = this.renderWorktreeId;
    this.renderWorktreeId = worktreeId;
    try {
      const state = this.getProjectState();
      const groups = this.terminalGroups();
      const groupsById = new Map(groups.map((group) => [group.id, group]));
      const sessionGroups = state.session_groups || {};
      const allVisibleSessions = this.hideInactiveTerminals
        ? sessions.filter((session) => this.isActiveTerminal(session))
        : sessions;
      const terminalSearchQuery = this.terminalSearchText.trim();
      const visibleSessions = terminalSearchQuery
        ? allVisibleSessions.filter((session) => this.terminalSearchMatches.has(session.session_id))
        : allVisibleSessions;
      const sessionsById = new Map(visibleSessions.map((session) => [session.session_id, session]));
      const grouped = new Map(groups.map((group) => [group.id, []]));
      for (const session of visibleSessions) {
        if (grouped.has(sessionGroups[session.session_id])) grouped.get(sessionGroups[session.session_id]).push(session);
      }
      const layout = this.terminalLayout(allVisibleSessions);
      for (const entry of layout) {
        const [kind, id] = entry.split(":", 2);
        if (kind === "group") {
          const group = groupsById.get(id);
          if (!group) continue;
          const members = grouped.get(id) || [];
          const scopedSearchGroup = this.terminalSearchEditorOpen && this.terminalSearchGroupId === id &&
            (this.terminalSearchWorktreeId || worktreeId) === worktreeId;
          if (!members.length && (terminalSearchQuery || this.hideInactiveTerminals) && !scopedSearchGroup) continue;
          this.renderTerminalGroup(group, members, list);
          continue;
        }
        const session = sessionsById.get(id);
        if (!session || sessionGroups[id]) continue;
        this.renderTerminalItem(session, list);
      }
      if ((terminalSearchQuery || this.hideInactiveTerminals) && !this.terminalSearchGroupId &&
          !visibleSessions.length && !this.terminalSearchClosedMatches.size) {
        const empty = document.createElement("div");
        empty.className = "terminal-search-empty";
        empty.textContent = terminalSearchQuery ? "no terminals match" : "no active terminals";
        list.appendChild(empty);
      }
    } finally {
      this.renderWorktreeId = previousRenderWorktreeId;
    }
  }

  renderAllWorktreesInto(list) {
    let renderedSection = false;
    for (const worktree of this.availableWorktreeSections()) {
      const worktreeId = String(worktree.id);
      const sessions = this.sessionsForWorktree(worktreeId);
      const closed = this.closedSessions.filter((session) => this.worktreeIdForSession(session) === worktreeId);
      const scopedSearchWorktree = this.terminalSearchEditorOpen && this.terminalSearchGroupId &&
        this.terminalSearchWorktreeId === worktreeId;
      if ((this.hideInactiveTerminals && !sessions.some((session) => this.isActiveTerminal(session))) ||
          (this.terminalSearchText.trim() && !sessions.some((session) => this.terminalSearchMatches.has(session.session_id)) &&
          !closed.some((session) => this.terminalSearchClosedMatches.has(session.session_id)) && !scopedSearchWorktree)) continue;
      renderedSection = true;
      const section = document.createElement("section");
      section.className = "worktree-section";
      section.dataset.worktreeId = worktreeId;
      const header = document.createElement("div");
      header.className = "worktree-section-header";
      header.dataset.worktreeId = worktreeId;
      const chevron = document.createElement("span");
      const collapsed = this.worktreeSectionCollapsed(worktreeId);
      chevron.className = `codicon ${collapsed ? "codicon-chevron-right" : "codicon-chevron-down"}`;
      const title = document.createElement("span");
      title.className = "worktree-section-title";
      title.textContent = worktree.branch || worktree.name || worktreeId;
      const branch = document.createElement("span");
      branch.className = "worktree-section-branch";
      branch.textContent = "";
      const activeCount = sessions.filter((session) => this.processingStates.get(session.session_id) ||
        this.unreadSessions.has(session.session_id)).length;
      const count = document.createElement("span");
      count.className = "worktree-section-count";
      count.textContent = `${sessions.length} terminal${sessions.length === 1 ? "" : "s"}${closed.length ? ` · ${closed.length} closed` : ""}`;
      if (activeCount) count.textContent += ` · ${activeCount} active/unread`;
      header.title = `${worktree.path || worktree.branch || worktreeId}\nclick to collapse or expand`;
      header.append(chevron, title, branch, count);
      header.onclick = () => {
        this.interactionWorktreeId = worktreeId;
        this.updateRecentFilesWatch();
        const nextCollapsed = !this.worktreeSectionCollapsed(worktreeId);
        this.setWorktreeSectionCollapsed(worktreeId, nextCollapsed);
        this.renderList();
      };
      section.appendChild(header);
      if (!collapsed) {
        const body = document.createElement("div");
        body.className = "worktree-section-body";
        this.renderTerminalEntries(sessions, body, worktreeId);
        if (!this.hideInactiveTerminals) this.renderClosedInto(body, closed, worktreeId);
        section.appendChild(body);
      }
      list.appendChild(section);
    }
    if (!renderedSection && (this.terminalSearchText.trim() || this.hideInactiveTerminals)) {
      const empty = document.createElement("div");
      empty.className = "terminal-search-empty";
      empty.textContent = this.terminalSearchText.trim() ? "no terminals match" : "no active terminals";
      list.appendChild(empty);
    }
  }

  renderList() {
    const list = this.$("session-list");
    this.hideTerminalSearchHoverPopup();
    const terminalSearchEditor = this.terminalSearchEditorOpen ? list.querySelector("#terminal-search-inline") : null;
    const terminalSearchInput = terminalSearchEditor?.querySelector("#terminal-search-input") || null;
    const terminalSearchHadFocus = document.activeElement === terminalSearchInput;
    const terminalSearchSelectionStart = terminalSearchInput?.selectionStart;
    const terminalSearchSelectionEnd = terminalSearchInput?.selectionEnd;
    if (terminalSearchEditor) terminalSearchEditor.remove();
    list.textContent = "";
    this.ensureDesktopTerminalsHeader(list, terminalSearchEditor);
    this.migrateLegacyPinnedLayout();
    const currentSessionIds = new Set(this.sessions.map((session) => session.session_id));
    this.sidebarSelectedSessionIds = new Set([...this.sidebarSelectedSessionIds]
      .filter((sessionId) => currentSessionIds.has(sessionId)));
    if (!this.sidebarSelectedSessionIds.has(this.sidebarSelectionAnchorId)) {
      this.sidebarSelectionAnchorId = [...this.sidebarSelectedSessionIds][0] || null;
    }
    this.sessionTitleEls.clear();
    this.sessionSpinnerEls.clear();
    this.sessionStatusEls.clear();
    this.sessionRowEls.clear();
    if (this.worktreeId === ALL_WORKTREES_ID) this.renderAllWorktreesInto(list);
    else this.renderTerminalEntries(this.sessions, list, this.worktreeId || "root");
    if (this.terminalSearchEditorOpen && this.terminalSearchGroupId) {
      const groupSelector = `.terminal-group[data-group-id="${CSS.escape(this.terminalSearchGroupId)}"]`;
      const matchingGroups = [...list.querySelectorAll(groupSelector)];
      const groupBox = matchingGroups.find((group) => !this.terminalSearchWorktreeId ||
        group.dataset.worktreeId === this.terminalSearchWorktreeId);
      const groupLabel = groupBox?.querySelector(":scope > .terminal-group-label");
      if (groupLabel) groupLabel.after(terminalSearchEditor || this.createTerminalSearchEditor());
    }
    this.updateTerminalSearchEditorScope();
    if (!this.vscodeMode && this.openFiles.size) {
      const collapsed = this.sectionCollapsed("open_files_collapsed");
      list.appendChild(this.collapsibleSectionLabel("open files", "open_files_collapsed"));
      if (!collapsed) {
        for (const [key, entry] of this.openFiles) {
          const item = document.createElement("div");
          item.className = "file-item" + (key === this.activeFileKey ? " active" : "");
          item.classList.toggle("sidebar-selected", this.sidebarSelectedFileKeys.has(key));
          item.dataset.fileKey = key;
          item.tabIndex = 0;
          item.title = entry.fullPath || `${entry.root}/${entry.path}`;
          const name = document.createElement("span");
          name.className = "file-item-name";
          name.textContent = entry.name;
          const close = document.createElement("button");
          close.className = "item-close";
          close.textContent = "✕";
          close.title = this.shortcutTitle("Close file", "close-item");
          close.onclick = (e) => { e.stopPropagation(); void this.closeFile(key); };
          item.append(this.fileTypeIconEl(entry.name, "file-type-icon"), name);
          item.appendChild(close);
          item.onclick = (event) => this.handleOpenFileRowSelection(event, key);
          item.onauxclick = (event) => this.handleFileDeckAuxClick(event, entry.root, entry.path);
          item.oncontextmenu = (event) => this.openFileContextMenu(event, key);
          this.makeDraggable(item, "file", key, (dragged, target, after) => this.reorderFiles(dragged, target, after));
          list.appendChild(item);
        }
      }
    }
    if (!this.vscodeMode) this.renderRecentFilesInto(list);
    if (this.worktreeId !== ALL_WORKTREES_ID && !this.hideInactiveTerminals) this.renderClosedInto(list);
    this.$("empty-state").style.display = this.sessions.length || this.closedSessions.length ||
      (!this.vscodeMode && this.openFiles.size) ? "none" : "flex";
    this.sessionListSignature = this.sessionListSignatureFor();
    this.updateSidebarAnimationVisibilityObserver();
    if (terminalSearchHadFocus && terminalSearchInput) requestAnimationFrame(() => {
      terminalSearchInput.focus({ preventScroll: true });
      if (Number.isInteger(terminalSearchSelectionStart) && Number.isInteger(terminalSearchSelectionEnd)) {
        terminalSearchInput.setSelectionRange(terminalSearchSelectionStart, terminalSearchSelectionEnd);
      }
    });
  }

  updateSidebarAnimationVisibilityObserver() {
    const list = this.$("session-list");
    if (!list || typeof IntersectionObserver !== "function") return;
    if (!this.sidebarAnimationVisibilityObserver) {
      this.sidebarAnimationVisibilityObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          entry.target.classList.toggle("termdeck-sidebar-offscreen", !entry.isIntersecting);
        }
      }, { root: list, threshold: 0.01 });
    }
    this.sidebarAnimationVisibilityObserver.disconnect();
    for (const element of list.querySelectorAll(".session-item, .terminal-group-label")) {
      this.sidebarAnimationVisibilityObserver.observe(element);
    }
  }

  keepActiveSessionVisible() {
    if (!this.activeId || this.activeFileKey !== null) return;
    const title = this.sessionTitleEls.get(this.activeId);
    const row = title && title.closest(".session-item");
    if (!row) return;
    requestAnimationFrame(() => row.scrollIntoView({ block: "nearest" }));
  }

  revealAndFocusActiveTerminalInSidebar() {
    if (!this.activeId || !this.session(this.activeId)) return;
    const sessionId = this.activeId;
    this.setSideView("terminals", false);
    const groupId = this.getProjectState().session_groups?.[sessionId] || "";
    const group = groupId ? this.terminalGroups().find((candidate) => candidate.id === groupId) : null;
    if (group?.collapsed) {
      this.applyLocalProjectStatePatch({ terminal_groups: this.terminalGroups().map((candidate) => candidate.id === groupId
        ? { ...candidate, collapsed: false } : candidate) });
      this.queueTerminalGroupUpdate(groupId, { collapsed: false });
    }
    this.sidebarSelectedFileKeys.clear();
    this.sidebarSelectedSessionIds = new Set([sessionId]);
    this.sidebarSelectionAnchorId = sessionId;
    this.renderList();
    requestAnimationFrame(() => {
      const row = this.$("session-list")?.querySelector(`[data-session-id="${CSS.escape(sessionId)}"]`);
      if (!row) return;
      row.scrollIntoView({ block: "nearest" });
      row.focus({ preventScroll: true });
    });
  }

  setSideView(view, allowToggle = true, allowFloating = true) {
    if (this.vscodeMode && view !== "terminals") return;
    if (!this.filesSidePanelCycleTransition) this.filesSidePanelCycleView = null;
    const nextView = allowToggle && this.sideView === view
      ? (view === "terminals" ? CLOSED_SIDE_VIEW : "terminals") : view;
    this.sideView = nextView;
    view = this.sideView;
    const filesVisible = FILES_SIDE_PANEL_TABS.includes(view);
    if (filesVisible) {
      this.lastFilesSidePanelTab = view;
      if (this.settings.files_side_panel_last_tab !== view) {
        this.settings.files_side_panel_last_tab = view;
        this.saveSettings();
      }
      localStorage.setItem(FILES_SIDE_PANEL_LAST_TAB_KEY, view);
    }
    if (!filesVisible || view === "git") this.closeFileTypeFilterMenu();
    const filesPinned = filesVisible && !!this.settings.files_pinned;
    this.settings.side_full = filesVisible;
    this.$("files-section").classList.toggle("hidden", !filesVisible);
    this.$("session-list").classList.toggle("hidden", view === CLOSED_SIDE_VIEW);
    this.$("files-section").classList.toggle("with-search", view === "search");
    this.$("files-section").classList.toggle("with-git", view === "git");
    this.$("files-section").classList.toggle("floating", filesVisible && !filesPinned);
    const gitView = view === "git";
    this.$("git-branch-label").classList.toggle("hidden", !gitView);
    this.$("git-refresh").classList.toggle("hidden", !gitView);
    for (const id of ["mtime-toggle", "tree-sort-toggle", "hide-excluded-toggle"]) {
      this.$(id).classList.toggle("hidden", gitView);
    }
    for (const [name, id] of [["terminals", "view-terminals"], ["project", "view-project"], ["search", "view-search"], ["git", "view-git"]]) {
      const button = this.$(id);
      if (button) button.classList.toggle("on", name === view);
    }
    for (const name of ["project", "search", "git"]) {
      const id = `files-tab-${name}`;
      const button = this.$(id);
      if (button) button.classList.toggle("on", name === view);
    }
    this.$("side-split").classList.toggle("hidden", view === "terminals" || view === CLOSED_SIDE_VIEW || filesVisible);
    this.applySettings({ fitTerminals: !filesVisible || filesPinned });
    this.applySideLayout();
    if (view === "project" || view === "search") {
      const session = this.session(this.activeId);
      const expectedRoot = session ? session.cwd : (this.worktreeRoot() || "~");
      if (this.treeRoot !== expectedRoot || !this.treeDirs.has("")) {
        this.treeReloadPromise = this.reloadTree(expectedRoot);
      } else {
        this.connectFileTreeWatch(expectedRoot);
        void this.refreshTreeDirectories();
      }
    } else {
      this.disconnectFileTreeWatch();
    }
    if (!filesVisible) {
      this.scheduleTerminalFitAfterSidebarChange();
      return;
    }
    if (view === "project") {
      this.setExplorerMode("tree");
    } else if (view === "search") {
      this.$("search-query").focus();
      if (this.$("search-query").value.trim()) this.runSearch(null, true);
      else this.setExplorerMode("content");
    } else if (view === "git") {
      this.setExplorerMode("git");
      void this.loadGitSidePanel();
    }
    this.scheduleTerminalFitAfterSidebarChange();
  }

  focusFileNameSearch() {
    if (this.vscodeMode) return;
    const selectedText = this.selectedTextForAutomaticSearch();
    if (this.sideView !== "project") this.setSideView("project");
    const input = this.$("search-name");
    this.hideSelectionActions();
    if (selectedText) {
      input.value = this.fileNameSearchQueryFromSelection(selectedText);
      void this.runNameSearch();
    } else if (input.value.trim()) {
      void this.runNameSearch();
    }
    setTimeout(() => { input.focus(); input.select(); }, 0);
  }

  focusFileContentSearch() {
    if (this.vscodeMode) return;
    const selectedText = this.selectedTextForAutomaticSearch();
    if (this.sideView !== "search") this.setSideView("search");
    const input = this.$("search-query");
    this.hideSelectionActions();
    if (selectedText) {
      input.value = selectedText;
      void this.runSearch(selectedText);
    }
    setTimeout(() => { input.focus(); input.select(); }, 0);
  }

  openSearchSidePanelFromNavigation() {
    if (this.sideView === "search") {
      this.openFilesSidePanelView("search");
      return;
    }
    const selectedText = this.selectedTextSearchQuery();
    const input = this.$("search-query");
    if (selectedText) {
      input.value = "";
      this.hideSelectionActions();
    }
    this.setSideView("search", false);
    if (selectedText) {
      input.value = selectedText;
      void this.runSearch(selectedText);
      setTimeout(() => { input.focus(); input.select(); }, 0);
    }
  }

  setExplorerMode(mode) {
    this.$("files-tree").classList.toggle("hidden", mode !== "tree");
    this.$("search-results").classList.toggle("hidden", mode !== "content");
    this.$("name-results").classList.toggle("hidden", mode !== "name");
    this.$("git-results").classList.toggle("hidden", mode !== "git");
    if (mode !== "git") {
      this.gitSideGeneration += 1;
      this.$("git-results").textContent = "";
      this.$("git-branch-label").textContent = "";
    }
  }

  async loadGitSidePanel() {
    if (this.sideView !== "git" || this.vscodeMode) return;
    const generation = ++this.gitSideGeneration;
    const root = this.session(this.activeId)?.cwd || this.treeRoot || this.worktreeRoot();
    const results = this.$("git-results");
    const branch = this.$("git-branch-label");
    if (!root || !results || !branch) return;
    results.textContent = "Loading Git status…";
    const response = await fetch(`/api/files/git-branch?${new URLSearchParams({ root, limit: "100" })}`);
    if (generation !== this.gitSideGeneration || this.sideView !== "git") return;
    if (!response.ok) {
      results.textContent = "Git status unavailable";
      branch.textContent = "Git unavailable";
      return;
    }
    const state = await response.json();
    this.gitSideState = state;
    branch.textContent = state.branch || "(detached HEAD)";
    branch.title = state.upstream ? `${state.branch} → ${state.upstream}` : state.branch || "Git";
    results.textContent = "";
    const files = state.files || [];
    const summary = document.createElement("div");
    summary.className = "git-summary";
    summary.textContent = files.length ? `${files.length} modified file${files.length === 1 ? "" : "s"} in ${state.branch}` : `Working tree clean · ${state.branch}`;
    results.appendChild(summary);
    this.renderGitSideGroupHeader(results, "working tree", "diff-modified");
    if (!files.length) {
      const empty = document.createElement("div");
      empty.className = "file-inspector-empty";
      empty.textContent = "No uncommitted changes on this branch.";
      results.appendChild(empty);
    }
    for (const file of files) this.renderGitSideFile(results, root, file);
    this.renderGitSideGroupHeader(results, "branch history", "history");
    for (const commit of (state.commits || []).slice(0, 30)) this.renderGitSideCommit(results, commit);
    this.$("status-name").textContent = `${files.length} modified file${files.length === 1 ? "" : "s"} · branch ${state.branch}`;
  }

  renderGitSideGroupHeader(container, label, icon) {
    const header = document.createElement("div");
    header.className = "git-group-header";
    const glyph = document.createElement("span");
    glyph.className = `codicon codicon-${icon}`;
    const text = document.createElement("span");
    text.textContent = label;
    header.append(glyph, text);
    container.appendChild(header);
  }

  renderGitSideFile(container, root, file) {
    const row = document.createElement("div");
    row.className = "tree-row file git-file-row";
    row.dataset.path = file.path;
    row.title = `${root}/${file.path}\nOpen file; middle-click opens in a new TermDeck tab`;
    row.append(this.fileTypeIconEl(file.path.split("/").pop(), "tree-type-icon"));
    const name = document.createElement("span");
    name.className = "tree-name";
    name.textContent = file.path;
    row.appendChild(name);
    this.appendGitStatus(row, { git_status: file.status });
    row.onclick = () => void this.openFile(root, file.path, null, row, { fromFilePanel: true, pinned: false });
    row.onauxclick = (event) => this.handleFileDeckAuxClick(event, root, file.path);
    row.oncontextmenu = (event) => this.openFileDeckRowContextMenu(event, root, file.path);
    container.appendChild(row);
  }

  renderGitSideCommit(container, commit) {
    const row = document.createElement("div");
    row.className = "git-commit";
    const id = document.createElement("span");
    id.className = "git-commit-id";
    id.textContent = commit.short_id;
    const message = document.createElement("span");
    message.className = "git-commit-message";
    message.textContent = commit.message;
    const date = document.createElement("span");
    date.className = "git-commit-date";
    date.textContent = this.gitDateLabel(commit.committed_at);
    row.append(id, message, date);
    row.title = `${commit.author} · ${commit.committed_at}`;
    row.onclick = () => this.openGitHistoryForActiveFile();
    container.appendChild(row);
  }

  gitDateLabel(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value || "") : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  openGitHistoryForActiveFile() {
    if (this.activeFileKey === null) {
      this.$("status-name").textContent = "Open a file to inspect its Git history";
      return;
    }
    this.fileHistoryMode = "git";
    if (!this.fileHistoryOpen) this.toggleFileHistory();
    else void this.loadFileHistory();
  }

  updateFilesPinButton() {
    const button = this.$("files-pin-toggle");
    if (!button) return;
    const pinned = !!this.settings.files_pinned;
    button.classList.toggle("on", pinned);
    button.title = pinned ? "Unpin panel (it will close after opening a file)" :
      "Keep this panel open after opening a file";
    button.setAttribute("aria-label", pinned ? "Unpin file panel" : "Pin file panel");
    button.setAttribute("aria-pressed", String(pinned));
    const icon = button.querySelector(".codicon");
    if (icon) icon.className = `codicon ${pinned ? "codicon-pinned" : "codicon-pin"}`;
  }

  setFilesPinned(pinned) {
    const nextPinned = !!pinned;
    if (this.settings.files_pinned === nextPinned) return;
    this.settings.files_pinned = nextPinned;
    localStorage.setItem("termdeck.files_pinned", nextPinned ? "1" : "0");
    if (nextPinned && !this.filesPanelWidthInitialized) {
      this.settings.files_width = FILEDECK_DEFAULT_SIDEBAR_WIDTH;
      this.filesPanelWidthInitialized = true;
      this.settings.files_panel_width_initialized = true;
      localStorage.setItem("termdeck.files_panel_width_v2", "1");
    }
    const filesVisible = FILES_SIDE_PANEL_TABS.includes(this.sideView);
    this.$("files-section").classList.toggle("floating", filesVisible && !nextPinned);
    this.updateFilesPinButton();
    this.applySideLayout();
    this.applySettings({ fitTerminals: !filesVisible || nextPinned });
    this.scheduleTerminalFitAfterSidebarChange();
    this.saveSettings();
  }

  toggleFilesPinned() {
    this.setFilesPinned(!this.settings.files_pinned);
  }

  dismissUnpinnedFilesPanel() {
    if (this.settings.files_pinned || !FILES_SIDE_PANEL_TABS.includes(this.sideView)) return;
    this.setSideView("terminals", false);
  }

  closeUnpinnedFilesPanelAndFocusEditor() {
    if (this.settings.files_pinned || !FILES_SIDE_PANEL_TABS.includes(this.sideView)) return false;
    this.setSideView("terminals", false);
    requestAnimationFrame(() => this.focusActiveEditor());
    return true;
  }

  scheduleTerminalFitAfterSidebarChange() {
    if (FILES_SIDE_PANEL_TABS.includes(this.sideView) && !this.settings.files_pinned) return;
    this.scheduleTerminalLayoutFit();
  }

  scheduleFinalTerminalFitAfterSidebarResize() {
    if (this.sidebarResizeFinalFitFrame) cancelAnimationFrame(this.sidebarResizeFinalFitFrame);
    this.sidebarResizeFinalFitFrame = requestAnimationFrame(() => {
      this.sidebarResizeFinalFitFrame = requestAnimationFrame(() => {
        this.sidebarResizeFinalFitFrame = 0;
        if (this.sidebarResizeInProgress) return;
        const view = this.views.get(this.activeId);
        if (view && this.isTerminalScrollV2()) view.forceResizeAfterFit = false;
        this.fitActive();
      });
    });
  }

  positionFloatingFilesPanel(fileWidth = null) {
    const section = this.$("files-section");
    if (!section || !section.classList.contains("floating") || section.classList.contains("hidden")) {
      if (section) {
        section.style.top = "";
        section.style.bottom = "";
        section.style.width = "";
      }
      return;
    }
    const sidebar = this.$("sidebar");
    const header = this.$("sidebar-header");
    const normalWidth = Number(this.settings.sidebar_width) || SETTINGS_DEFAULTS.sidebar_width;
    const requestedWidth = Number(fileWidth) || Math.max(Number(this.settings.files_width) || 0, normalWidth * 2);
    const availableWidth = Math.max(normalWidth, window.innerWidth - sidebar.getBoundingClientRect().left - 20);
    const filesPinned = !!this.settings.files_pinned;
    section.style.top = filesPinned ? `${header?.offsetHeight || 0}px` : "0px";
    section.style.bottom = "0px";
    section.style.width = `${Math.min(requestedWidth, availableWidth)}px`;
    document.documentElement.style.setProperty("--files-panel-width", `${Math.min(requestedWidth, availableWidth)}px`);
  }

  scheduleTerminalLayoutFit() {
    if (this.layoutFitFrame) cancelAnimationFrame(this.layoutFitFrame);
    clearTimeout(this.layoutFitTimer);
    clearTimeout(this.layoutFitSettleTimer);
    this.layoutFitFrame = requestAnimationFrame(() => {
      this.layoutFitFrame = requestAnimationFrame(() => {
        this.layoutFitFrame = 0;
        this.fitActive();
      });
    });
    // A webview/sidebar can finish its flex layout after the first two frames
    // (notably during startup or after a browser refresh). Refit once more
    // after that layout has settled, without changing terminal scroll mode.
    this.layoutFitTimer = setTimeout(() => {
      this.layoutFitTimer = 0;
      this.fitActive();
    }, 180);
    // A refresh can finish the sidebar/main flex pass after the first timer
    // (especially when several long session names change row widths). Give
    // the active xterm one final bounded fit/repaint after that pass. v2
    // preserves the xterm-owned scroll mode, so this does not reintroduce
    // the old browser-scroll repair race.
    this.layoutFitSettleTimer = setTimeout(() => {
      this.layoutFitSettleTimer = 0;
      this.fitActive();
    }, 420);
  }

  cycleView(view) {
    if (this.vscodeMode && view !== "terminals") return;
    this.setSideView(view);
    if (this.sideView !== view) return;
    if (view === "project") this.focusFileNameSearch();
    else if (view === "search") this.focusFileContentSearch();
  }

  cycleFilesSidePanel() {
    if (this.vscodeMode) return;
    const continuingCycle = this.filesSidePanelCycleView === this.sideView;
    const currentIndex = continuingCycle ? FILES_SIDE_PANEL_TABS.indexOf(this.sideView) : -1;
    const nextIndex = currentIndex + 1;
    const nextView = nextIndex >= FILES_SIDE_PANEL_TABS.length ? "terminals" : FILES_SIDE_PANEL_TABS[nextIndex];
    this.filesSidePanelCycleTransition = true;
    try {
      this.setSideView(nextView, false);
    } finally {
      this.filesSidePanelCycleTransition = false;
    }
    this.filesSidePanelCycleView = nextView === "terminals" ? null : nextView;
    if (nextView === "project") this.focusFileNameSearch();
    else if (nextView === "search") this.focusFileContentSearch();
    else if (nextView === "git") requestAnimationFrame(() => this.$("git-refresh")?.focus());
    else requestAnimationFrame(() => this.focusActiveEditor());
  }

  openFilesSidePanelView(view, pinned = false) {
    if (this.vscodeMode || !FILES_SIDE_PANEL_TABS.includes(view)) return;
    if (this.sideView === view) {
      this.setSideView("terminals", false);
      requestAnimationFrame(() => this.focusActiveEditor());
      return;
    }
    if (pinned) this.setFilesPinned(true);
    this.setSideView(view, false);
    if (view === "project") this.focusFileNameSearch();
    else if (view === "search") this.focusFileContentSearch();
  }

  applySideLayout() {
    const sectionId = FILES_SIDE_PANEL_TABS.includes(this.sideView) ? "files-section" : null;
    const full = !!this.settings.side_full && !!sectionId;
    this.$("session-list").classList.toggle("collapsed", full);
    if (!sectionId) return;
    const section = this.$(sectionId);
    if (section.classList.contains("floating")) {
      section.style.height = "auto";
      section.style.flex = "none";
      this.positionFloatingFilesPanel();
      return;
    }
    if (full) {
      section.style.height = "";
      section.style.flex = "1";
    } else {
      section.style.flex = "";
      section.style.height = Math.round((this.settings.side_split ?? 0.55) * 100) + "%";
    }
  }

  toggleSideFull() {
    this.settings.side_full = !this.settings.side_full;
    this.applySideLayout();
    this.saveSettings();
  }

  initSideSplit() {
    const split = this.$("side-split");
    split.title = "Drag to resize · double-click to toggle full";
    split.ondblclick = () => this.toggleSideFull();
    split.onmousedown = (e) => {
      e.preventDefault();
      document.body.classList.add("dragging-side");
      const rect = this.$("sidebar").getBoundingClientRect();
      const move = (ev) => {
        this.settings.side_full = false;
        this.settings.side_split_user_set = true;
        this.settings.side_split = Math.min(0.85, Math.max(0.15, (rect.bottom - ev.clientY) / rect.height));
        this.applySideLayout();
      };
      const up = () => {
        document.body.classList.remove("dragging-side");
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        this.saveSettings();
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    };
  }

  isExcludedName(name) {
    return ALWAYS_EXCLUDED.includes(name) || (this.settings.ignored_dirs || []).includes(name);
  }

  isDotFolderName(name) {
    return String(name || "").startsWith(".");
  }

  searchIgnoreTokens() {
    const tokens = [...ALWAYS_EXCLUDED, ...(this.settings.ignored_dirs || [])];
    if (this.settings.hide_dot_folders) tokens.push(".*");
    return [...new Set(tokens)].join(",");
  }

  includeHiddenFilesInSearch() {
    return this.settings.hide_dot_folders === false;
  }

  isExcludedPath(relPath) {
    return String(relPath || "").split("/").filter(Boolean).some((part) => this.isExcludedName(part));
  }

  updateTreeSortButton() {
    const button = this.$("tree-sort-toggle");
    if (!button) return;
    const recent = this.settings.file_tree_sort === "mtime";
    button.classList.toggle("on", recent);
    button.title = recent ? "Sort files alphabetically (folders first)" : "Sort files by recently modified";
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-pressed", String(recent));
  }

  updateHideDotButton() {
    const button = this.$("hide-dot-toggle");
    if (!button) return;
    const hidden = this.settings.hide_dot_folders !== false;
    button.classList.toggle("on", !hidden);
    button.title = hidden ? "Show dot folders" : "Hide dot folders";
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-pressed", String(hidden));
    const icon = button.querySelector(".codicon");
    if (icon) icon.className = `codicon ${hidden ? "codicon-eye-closed" : "codicon-eye"}`;
  }

  toggleHideDotFolders() {
    const nextHidden = !this.settings.hide_dot_folders;
    const tokens = this.fileTypeFilterTokens().filter((token) => token !== "!.*");
    if (nextHidden) tokens.unshift("!.*");
    this.updateFileTypeFilterTokens(tokens);
  }

  toggleExcludeDir(name) {
    const list = this.settings.ignored_dirs || [];
    this.settings.ignored_dirs = list.includes(name) ? list.filter((n) => n !== name) : [...list, name];
    this.saveSettings();
    this.rerenderTree();
  }

  rerenderTree() {
    const root = this.treeDirs.get("");
    if (root) this.renderDirInto(root.container, "", JSON.parse(root.cache));
  }

  captureTreeScrollPosition() {
    const tree = this.$("files-tree");
    const treeRect = tree.getBoundingClientRect();
    const anchor = [...tree.querySelectorAll(".tree-row")].find((row) => row.getBoundingClientRect().bottom > treeRect.top);
    return {
      top: tree.scrollTop,
      anchorRel: anchor?.dataset.rel || "",
      anchorOffset: anchor ? anchor.getBoundingClientRect().top - treeRect.top : 0,
    };
  }

  restoreTreeScrollPosition(snapshot) {
    if (!snapshot) return;
    const tree = this.$("files-tree");
    let target = snapshot.top;
    if (snapshot.anchorRel) {
      const anchor = tree.querySelector(`[data-rel="${CSS.escape(snapshot.anchorRel)}"]`);
      if (anchor) {
        const treeRect = tree.getBoundingClientRect();
        target = tree.scrollTop + anchor.getBoundingClientRect().top - treeRect.top - snapshot.anchorOffset;
      }
    }
    tree.scrollTop = Math.max(0, Math.min(target, Math.max(0, tree.scrollHeight - tree.clientHeight)));
  }

  addContextItem(menu, label, handler, icon = "") {
    const item = document.createElement("div");
    item.className = "context-item" + (handler ? "" : " disabled");
    if (icon) {
      const glyph = document.createElement("span");
      glyph.className = `codicon codicon-${icon}`;
      glyph.setAttribute("aria-hidden", "true");
      item.appendChild(glyph);
    }
    const text = document.createElement("span");
    text.textContent = label;
    item.appendChild(text);
    if (handler) {
      item.onclick = () => {
        const rootMenu = item.closest("#context-menu") || menu;
        rootMenu.classList.add("hidden");
        if (rootMenu.id === "context-menu") this.contextMenuTarget = null;
        handler();
      };
    }
    menu.appendChild(item);
  }

  addContextSubmenu(menu, label, entries, icon = "chevron-right", options = {}) {
    const wrapper = document.createElement("div");
    const enabledEntries = entries.filter((entry) => entry);
    wrapper.className = "context-submenu" + (enabledEntries.length ? "" : " disabled");
    wrapper.classList.toggle("open", !!options.open);
    const item = document.createElement("div");
    item.className = "context-item";
    if (icon) {
      const glyph = document.createElement("span");
      glyph.className = `codicon codicon-${icon}`;
      glyph.setAttribute("aria-hidden", "true");
      item.appendChild(glyph);
    }
    const text = document.createElement("span");
    text.textContent = label;
    item.appendChild(text);
    const arrow = document.createElement("span");
    arrow.className = "codicon codicon-chevron-right context-submenu-arrow";
    arrow.setAttribute("aria-hidden", "true");
    item.appendChild(arrow);
    wrapper.appendChild(item);
    const submenu = document.createElement("div");
    submenu.className = "context-submenu-menu";
    for (const entry of enabledEntries) {
      if (entry.kind === "label") {
        const labelItem = document.createElement("div");
        labelItem.className = "context-submenu-label";
        labelItem.textContent = entry.label;
        submenu.appendChild(labelItem);
        continue;
      }
      this.addContextItem(submenu, entry.label, entry.handler, entry.icon || "");
    }
    wrapper.appendChild(submenu);
    menu.appendChild(wrapper);
  }

  positionContextMenu(menu, x, y) {
    menu.classList.remove("hidden");
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 10)) + "px";
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 10)) + "px";
  }

  async copyTextToClipboard(text, label = "copied") {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
      }
      this.$("status-name").textContent = label;
    } catch (error) {
      this.$("status-name").textContent = "clipboard blocked";
    }
  }

  async copySelectionPayloadToClipboard(text, html, label = "copied") {
    if (html && navigator.clipboard?.write && window.ClipboardItem) {
      try {
        const item = new ClipboardItem({
          "text/plain": new Blob([text], { type: "text/plain" }),
          "text/html": new Blob([html], { type: "text/html" }),
        });
        await navigator.clipboard.write([item]);
        this.$("status-name").textContent = label;
        return;
      } catch (error) {
        await this.copyTextToClipboard(text, label);
        return;
      }
    }
    await this.copyTextToClipboard(text, label);
  }

  shortcutLabel(label, actionId) {
    const binding = this.bindingFor(actionId);
    return binding ? `${label}   ${this.bindingToDisplay(binding)}` : label;
  }

  shortcutTitle(label, actionId) {
    const binding = this.bindingToDisplay(this.bindingFor(actionId));
    return binding ? `${label} (${binding})` : label;
  }

  keybindingDefinitions() {
    return this.vscodeMode ? VSCODE_KEYBINDINGS : DESKTOP_KEYBINDINGS;
  }

  keybindingsStorageKey() {
    return this.vscodeMode ? "vscode_keybindings" : "keybindings";
  }

  updateShortcutTitles() {
    this.updateHeaderAddShortcutLabels();
    const action = this.bindingToDisplay(this.bindingFor("toggle-history"));
    for (const id of ["history-btn", "vscode-history-btn"]) {
      const historyButton = this.$(id);
      if (historyButton) historyButton.title = `Open Markdown transcript (${action})`;
    }
    const historyClose = this.$("history-close");
    if (historyClose) historyClose.title = `Switch to terminal (${action})`;
    const refreshButton = this.$("vscode-refresh-btn");
    if (refreshButton && this.vscodeMode) {
      refreshButton.title = `Refresh TermDeck (${this.bindingToDisplay(this.bindingFor("vscode-refresh"))})`;
    }
    const sidePanelAction = this.bindingToDisplay(this.bindingFor("cycle-side-panel"));
    const sidePanelTitles = [["view-project", "Files", "open-files-panel"],
      ["view-search", "Search & replace", "open-file-search"],
      ["terminal-search-inline-toggle", "Search terminal names and output", "open-terminal-search"],
      ["files-tab-project", "Files", "open-files-panel"],
      ["files-tab-search", "Search & replace", "open-file-search"]];
    for (const [id, label, actionId] of sidePanelTitles) {
      const button = this.$(id);
      const directAction = this.bindingToDisplay(this.bindingFor(actionId));
      if (button) button.title = `${label} (${directAction}; ${sidePanelAction} cycles tabs)`;
    }
    for (const id of ["view-project", "view-search", "view-git", "files-tab-project", "files-tab-search", "files-tab-git"]) {
      const button = this.$(id);
      if (button) button.title = id === "view-git" || id === "files-tab-git"
        ? `Git (click; ${sidePanelAction} cycles tabs) · middle-click opens in a new TermDeck tab`
        : `${button.title} · middle-click opens in a new TermDeck tab`;
    }
    const notebookToggle = this.$("notebook-toggle");
    if (notebookToggle) {
      notebookToggle.title = `Quick notebook (${this.bindingToDisplay(this.bindingFor("toggle-notebook"))})`;
    }
    const scrollBottomAction = this.bindingToDisplay(this.bindingFor("scroll-bottom"));
    for (const id of ["scroll-bottom-btn", "vscode-scroll-bottom-btn"]) {
      const scrollButton = this.$(id);
      if (scrollButton) scrollButton.title = `Scroll terminal to bottom (${scrollBottomAction})`;
    }
    const historyScrollButton = this.$("history-scroll-bottom");
    if (historyScrollButton) historyScrollButton.title = `Scroll transcript to bottom (${scrollBottomAction})`;
    const resyncAction = this.bindingToDisplay(this.bindingFor("resync-terminal"));
    for (const id of ["terminal-resync-btn", "vscode-terminal-resync-btn"]) {
      const resyncButton = this.$(id);
      if (resyncButton) {
        resyncButton.title = `Resync terminal content (${resyncAction})`;
        resyncButton.setAttribute("aria-label", resyncButton.title);
      }
    }
    const conversationOutlineButton = this.$("conversation-outline-toggle");
    if (conversationOutlineButton) {
      conversationOutlineButton.title = this.shortcutTitle("Conversation outline", "conversation-outline");
      conversationOutlineButton.setAttribute("aria-label", conversationOutlineButton.title);
    }
    const newSession = this.$("new-session-btn");
    if (newSession) {
      newSession.title = this.shortcutTitle("New terminal", "new-terminal");
      newSession.setAttribute("aria-label", newSession.title);
    }
    const emptyState = this.$("empty-state");
    if (emptyState && this.initialLoadComplete) emptyState.textContent = "no terminals — press + to open one";
    const selectionButtons = [["selection-copy", "Copy selection"], ["selection-note-new", "Add selection as a new note"],
      ["selection-note-append", "Append selection to note"]];
    for (const [id, label] of selectionButtons) {
      const button = this.$(id);
      if (button) button.title = `${label} (${this.bindingToDisplay(this.bindingFor(id))})`;
    }
    this.updateTerminalSearchGroupButton();
  }

  openSessionContextMenu(event, session, options = {}) {
    event.preventDefault();
    event.stopPropagation();
    const menu = this.$("context-menu");
    menu.textContent = "";
    const sessionIds = this.selectContextMenuSessionIds(session.session_id);
    const multiple = sessionIds.length > 1;
    this.contextMenuTarget = multiple ? { type: "sessions", ids: sessionIds } : { type: "session", id: session.session_id };
    const state = this.getProjectState();
    const assignedGroupId = state.session_groups?.[session.session_id] || "";
    if (!multiple) {
      this.addContextItem(menu, this.shortcutLabel("Fork", "fork-terminal"),
        () => this.forkSession(session), "repo-forked");
      this.addContextItem(menu, "New terminal after this",
        () => this.openModal(null, session.session_id), "add");
      this.addContextItem(menu, this.shortcutLabel("Restart", "restart-terminal"),
        () => this.restartSession(session.session_id), "refresh");
      const permissions = MODEL_PERMISSIONS[session.agent_kind || "none"] || MODEL_PERMISSIONS.none;
      if (permissions.length > 1) {
        this.addContextSubmenu(menu, "Restart with permission", permissions.map((entry) => ({
          label: entry.label,
          handler: () => this.restartSession(session.session_id, entry.value),
          icon: "refresh",
        })), "refresh");
      }
      this.addContextItem(menu, this.shortcutLabel("Rename", "rename-terminal"),
        () => this.renameSession(session), "edit");
      this.addContextItem(menu, "Copy session name",
        () => this.copyTextToClipboard(this.titlePresentation(session).text, "session name copied"), "copy");
      this.addContextItem(menu, this.shortcutLabel("Copy session id", "copy-session-id"),
        () => this.copyTextToClipboard(session.session_id, "session id copied"), "copy");
      if (session.worktree_branch) {
        this.addContextItem(menu, "Review isolated worktree", () => this.openWorktreeReview(session.session_id), "git-commit");
      }
    }
    const selectionLabel = multiple ? `${sessionIds.length} selected` : "";
    this.addContextItem(menu, multiple ? `Mark ${selectionLabel} as unread`
      : this.shortcutLabel("Mark as unread", "mark-terminal-unread"),
    () => this.setSessionsUnread(sessionIds, true), "eye-closed");
    this.addContextItem(menu, multiple ? `Create group from ${selectionLabel}`
      : this.shortcutLabel("Create group", "create-terminal-group-from-active"),
    () => this.createTerminalGroupFromSessions(sessionIds), "folder-library");
    const moveEntries = multiple ? [] : [{
      label: this.shortcutLabel(assignedGroupId ? "Top of group" : "Top", "move-active-to-top"),
      handler: () => this.moveTerminalLayoutToTop(
        assignedGroupId ? `group:${assignedGroupId}` : `session:${session.session_id}`),
      icon: "arrow-up",
    }];
    const groups = this.terminalGroups();
    if (groups.length) {
      moveEntries.push({ kind: "label", label: "Groups" });
      moveEntries.push({
        label: "Ungrouped",
        handler: sessionIds.some((id) => state.session_groups?.[id])
          ? () => this.moveSelectedSessionsIntoGroup(sessionIds, null) : null,
        icon: "folder",
      });
      for (const group of groups) {
        moveEntries.push({
          label: group.name,
          handler: sessionIds.every((id) => state.session_groups?.[id] === group.id)
            ? null : () => this.moveSelectedSessionsIntoGroup(sessionIds, group.id),
          icon: "folder-library",
        });
      }
    }
    if (!this.vscodeMode) {
      const otherProjects = this.projects.filter((project) => project.name &&
        sessionIds.some((id) => this.session(id)?.project !== project.name));
      moveEntries.push({ kind: "label", label: "Projects" });
      for (const project of otherProjects) {
        moveEntries.push({
          label: project.name,
          handler: () => this.moveSelectedSessionsToProject(sessionIds, project.name),
          icon: "folder",
        });
      }
      if (!otherProjects.length) moveEntries.push({ label: "No other registered projects", handler: null, icon: "info" });
    }
    this.addContextSubmenu(menu, this.shortcutLabel("Move to…", "open-move-menu"), moveEntries, "arrow-swap",
      { open: !!options.openMove });
    this.addContextItem(menu, multiple ? this.shortcutLabel(`Close ${selectionLabel}`, "close-item")
      : this.shortcutLabel("Close", "close-item"),
    () => multiple ? this.closeSelectedSessions(sessionIds) : this.closeSession(session.session_id),
    multiple ? "close-all" : "close");
    if (!multiple) {
      this.addContextItem(menu, this.shortcutLabel("Open in a new browser tab", "open-terminal-new-tab"),
        () => this.openTerminalInNewTab(session), "new-window");
    }
    this.positionContextMenu(menu, event.clientX, event.clientY);
  }

  async openWorktreeReview(sessionId) {
    this.worktreeReviewSessionId = sessionId;
    this.$("worktree-review-backdrop").classList.remove("hidden");
    await this.refreshWorktreeReview();
  }

  closeWorktreeReview() {
    this.worktreeReviewSessionId = null;
    this.$("worktree-review-backdrop").classList.add("hidden");
  }

  async refreshWorktreeReview() {
    const sessionId = this.worktreeReviewSessionId;
    if (!sessionId) return;
    const status = this.$("worktree-review-status");
    const text = this.$("worktree-review-text");
    status.className = "";
    status.textContent = "Loading worktree status…";
    text.textContent = "";
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/worktree/review`);
    const payload = await response.json().catch(() => ({}));
    if (sessionId !== this.worktreeReviewSessionId) return;
    if (!response.ok) {
      status.className = "warn";
      status.textContent = payload.detail || "Unable to inspect worktree";
      return;
    }
    const files = Array.isArray(payload.files) ? payload.files : [];
    const commits = Array.isArray(payload.commits) ? payload.commits : [];
    status.className = payload.clean ? "good" : "warn";
    status.textContent = payload.clean ? "Clean worktree: ready to merge or keep." : "Uncommitted changes: commit them in the worktree before merging.";
    this.$("worktree-review-subtitle").textContent = `${payload.branch || "branch"}  ·  ${payload.path || ""}`;
    const sections = [
      `Repository: ${payload.repository || ""}`,
      `Base: ${payload.base_ref || ""} (${payload.base_commit || ""})`,
      `Current: ${payload.current_commit || ""}`,
      "",
      `Changed files (${files.length})`,
      files.length ? files.join("\n") : "(none)",
      "",
      `Commits (${commits.length})`,
      commits.length ? commits.join("\n") : "(none)",
      "",
      "Diff",
      payload.diff || "(no tracked diff)",
    ];
    if (payload.diff_truncated) sections.push("", "[diff truncated]");
    text.textContent = sections.join("\n");
  }

  async finishWorktree(action) {
    const sessionId = this.worktreeReviewSessionId;
    if (!sessionId) return;
    if (action === "discard" && !window.confirm("Discard the worktree and its branch? Uncommitted changes will be lost.")) return;
    if (action === "merge" && !window.confirm("Merge the worktree branch into its base branch?")) return;
    const status = this.$("worktree-review-status");
    status.className = "";
    status.textContent = action === "keep" ? "Keeping worktree…" : `${action}ing worktree…`;
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/worktree/finish`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      status.className = "warn";
      status.textContent = payload.detail || `Unable to ${action} worktree`;
      return;
    }
    if (action === "keep") {
      status.className = "good";
      status.textContent = "Worktree kept and detached from automatic cleanup.";
      await this.refresh();
      return;
    }
    this.closeWorktreeReview();
    await this.refresh();
  }

  openFileContextMenu(event, key) {
    event.preventDefault();
    event.stopPropagation();
    const keys = this.selectContextMenuFileKeys(key);
    const menu = this.$("context-menu");
    menu.textContent = "";
    this.contextMenuTarget = { type: "files", keys };
    if (keys.length === 1) {
      const entry = this.openFiles.get(keys[0]);
      if (entry) this.addContextItem(menu, "Open this file in a new browser tab", () => this.openFileDeckInNewTab(entry.root, entry.path), "new-window");
    }
    const label = keys.length === 1 ? "Close file" : `Close ${keys.length} selected files`;
    this.addContextItem(menu, this.shortcutLabel(label, "close-item"), () => this.closeFiles(keys), "close-all");
    this.positionContextMenu(menu, event.clientX, event.clientY);
  }

  openFileDeckRowContextMenu(event, root, relativePath) {
    event.preventDefault();
    event.stopPropagation();
    const menu = this.$("context-menu");
    menu.textContent = "";
    this.contextMenuTarget = { type: "filedeck", root, path: relativePath };
    this.addContextItem(menu, "Open this file in a new browser tab", () => this.openFileDeckInNewTab(root, relativePath), "new-window");
    this.positionContextMenu(menu, event.clientX, event.clientY);
  }

  openActiveMoveMenu() {
    if (!this.activeId || this.activeFileKey !== null) return;
    const session = this.session(this.activeId);
    if (!session) return;
    this.setSideView("terminals", false);
    const title = this.sessionTitleEls.get(this.activeId);
    const row = title?.closest(".session-item");
    const rect = row?.getBoundingClientRect();
    const x = rect ? Math.min(rect.right - 4, window.innerWidth - 12) : 12;
    const y = rect ? rect.top + Math.min(24, Math.max(8, rect.height / 2)) : 80;
    this.openSessionContextMenu({
      preventDefault() {},
      stopPropagation() {},
      clientX: x,
      clientY: y,
    }, session, { openMove: true });
  }

  openTreeContextMenu(event, row) {
    event.preventDefault();
    event.stopPropagation();
    const rel = row.dataset.rel;
    const isDir = row.dataset.kind === "dir";
    const name = rel.split("/").pop();
    const menu = this.$("context-menu");
    menu.textContent = "";
    if (isDir) {
      if (ALWAYS_EXCLUDED.includes(name)) {
        this.addContextItem(menu, `"${name}" is always excluded from search`, null);
      } else {
        const excluded = (this.settings.ignored_dirs || []).includes(name);
        this.addContextItem(menu, excluded ? "Include in search" : "Exclude from search",
          () => this.toggleExcludeDir(name));
      }
    } else {
      this.addContextItem(menu, "Open this file in a new browser tab", () => this.openFileDeckInNewTab(this.treeRoot, rel), "new-window");
      this.addContextItem(menu, "Open", () => this.openFile(this.treeRoot, rel, null, row));
      this.markTreeSelection(row);
    }
    const parent = isDir ? rel : rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    this.addContextItem(menu, "New file…", () => this.createTreePath(parent, false), "new-file");
    this.addContextItem(menu, "New folder…", () => this.createTreePath(parent, true), "new-folder");
    this.addContextItem(menu, "Rename…", () => this.renameTreePath(rel));
    this.addContextItem(menu, "Duplicate…", () => this.duplicateTreePath(rel), "files");
    this.addContextItem(menu, "Move…", () => this.moveTreePath(rel));
    this.addContextItem(menu, "Delete (to Trash)", () => this.deleteTreePath(rel));
    this.addContextItem(menu, "Refresh", () => void this.refreshTreeDirectories(), "refresh");
    this.addContextItem(menu, "Copy relative path", () => this.copyTextToClipboard(rel, "relative path copied"), "copy");
    this.addContextItem(menu, "Copy absolute path", () => this.copyTextToClipboard(`${this.treeRoot}/${rel}`, "path copied"), "copy");
    menu.classList.remove("hidden");
    menu.style.left = Math.min(event.clientX, window.innerWidth - menu.offsetWidth - 10) + "px";
    menu.style.top = Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 10) + "px";
  }

  async fsOp(route, payload, failLabel) {
    const res = await fetch(route, { method: "POST", headers: { "Content-Type": "application/json" },
                                     body: JSON.stringify({ root: this.treeRoot, ...payload }) });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(err.detail || failLabel);
      return null;
    }
    return await res.json();
  }

  async renameTreePath(rel) {
    const base = rel.split("/").pop();
    const newName = prompt(`Rename "${base}" to`, base);
    if (!newName || newName === base) return;
    if (!await this.saveOpenFileBeforePathChange(rel)) return;
    const result = await this.fsOp("/api/files/rename", { path: rel, new_name: newName }, "rename failed");
    if (result === null) return;
    const parent = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    this.afterFsChange(rel, parent ? `${parent}/${result.new_name}` : result.new_name);
  }

  async createTreePath(parent, directory) {
    const suggested = parent ? `${parent}/` : "";
    const path = prompt(`${directory ? "Folder" : "File"} path relative to ${this.treeRoot}`, suggested);
    if (!path || path === suggested) return;
    const result = await this.fsOp("/api/files/create", { path, directory }, "create failed");
    if (result === null) return;
    this.selectedTreeRow = null;
    await this.refreshTreeDirectories();
    if (!result.directory) void this.openFile(this.treeRoot, result.rel, null, null, { pinned: true });
  }

  async duplicateTreePath(rel) {
    const dot = rel.lastIndexOf(".");
    const slash = rel.lastIndexOf("/");
    const suggested = dot > slash ? `${rel.slice(0, dot)} copy${rel.slice(dot)}` : `${rel} copy`;
    const destination = prompt(`Duplicate "${rel}" to`, suggested);
    if (!destination || destination === rel) return;
    const result = await this.fsOp("/api/files/duplicate", { path: rel, destination }, "duplicate failed");
    if (result === null) return;
    this.selectedTreeRow = null;
    await this.refreshTreeDirectories();
  }

  async moveTreePath(rel) {
    const destination = prompt(`Move "${rel}" to (path relative to ${this.treeRoot}; existing folder = move into it)`, rel);
    if (!destination || destination === rel) return;
    if (!await this.saveOpenFileBeforePathChange(rel)) return;
    const result = await this.fsOp("/api/files/move", { path: rel, destination }, "move failed");
    if (result === null) return;
    this.afterFsChange(rel, result.rel);
  }

  async saveOpenFileBeforePathChange(rel) {
    const entry = this.openFiles.get(`${this.treeRoot}|${rel}`);
    if (!entry || (!entry.dirty && !entry.savePromise)) return true;
    return await this.saveFileEntry(entry, true);
  }

  async deleteTreePath(rel) {
    if (!confirm(`Move "${rel}" to Trash?`)) return;
    const result = await this.fsOp("/api/files/delete", { path: rel }, "delete failed");
    if (result === null) return;
    this.afterFsChange(rel, null);
  }

  afterFsChange(oldRel, newRel) {
    const key = `${this.treeRoot}|${oldRel}`;
    const entry = this.openFiles.get(key);
    if (entry) {
      if (newRel) {
        this.openFiles.delete(key);
        entry.path = newRel;
        entry.name = newRel.split("/").pop();
        entry.fullPath = null;
        if (entry.model) {
          entry.model.dispose();
          entry.model = null;
        }
        const newKey = `${this.treeRoot}|${newRel}`;
        this.openFiles.set(newKey, entry);
        if (this.activeFileKey === key) {
          this.activeFileKey = newKey;
          this.activateFile(newKey, null);
        }
      } else {
        void this.closeFile(key, { discard: true });
      }
      this.persistOpenFiles();
    }
    this.selectedTreeRow = null;
    this.renderList();
    void this.refreshTreeDirectories();
  }

  async revealActiveFile() {
    const entry = this.activeFileKey !== null ? this.openFiles.get(this.activeFileKey) : null;
    if (!entry) return;
    if (this.sideView !== "project") {
      this.sideView = "terminals";
      this.setSideView("project");
    }
    if (this.treeRoot !== entry.root || !this.treeDirs.get("")) await this.reloadTree(entry.root);
    const parts = entry.path.split("/");
    let rel = "";
    for (const part of parts.slice(0, -1)) {
      rel = rel ? `${rel}/${part}` : part;
      if (!this.expandedDirs.has(rel)) {
        const dirRow = this.$("files-tree").querySelector(`[data-rel="${CSS.escape(rel)}"]`);
        if (!dirRow) return;
        await this.toggleDir(dirRow, rel);
      }
    }
    const fileRow = this.$("files-tree").querySelector(`[data-rel="${CSS.escape(entry.path)}"]`);
    if (fileRow) {
      this.markTreeSelection(fileRow);
      fileRow.scrollIntoView({ block: "center" });
    }
  }

  renderRecentFilesInto(list) {
    const openKeys = new Set(this.openFiles.keys());
    const toggle = document.createElement("button");
    toggle.className = "section-toggle";
    const collapsed = this.sectionCollapsed("recent_files_collapsed");
    const header = this.collapsibleSectionLabel("recently modified", "recent_files_collapsed", toggle);
    header.classList.add("recent-files-header");
    list.appendChild(header);
    if (collapsed) return;
    const controls = document.createElement("div");
    controls.className = "recent-files-controls";
    const filter = document.createElement("button");
    filter.id = "recent-file-type-filter-button";
    filter.type = "button";
    filter.className = "recent-files-filter";
    const recentExcludeTokens = this.recentFileExcludeTokens();
    filter.innerHTML = `<span class="codicon codicon-symbol-enum"></span><span>${recentExcludeTokens.length} exclusions</span>`;
    filter.title = recentExcludeTokens.length ? recentExcludeTokens.join(", ") : "No recently modified exclusions";
    filter.setAttribute("aria-label", "Recently modified file exclusions");
    filter.setAttribute("aria-expanded", "false");
    filter.onclick = (event) => this.toggleFileTypeFilterMenu(event.currentTarget);
    controls.appendChild(filter);
    list.appendChild(controls);
    const body = document.createElement("div");
    body.className = "recent-files-list";
    list.appendChild(body);

    const renderBody = () => {
      const recent = this.recentFiles.filter((entry) => entry.path &&
        !openKeys.has(`${this.recentFilesRoot}|${entry.path}`) && !this.recentFileExcluded(entry, this.getProjectState().recent_file_exclude_glob));
      const limit = this.recentFilesExpanded ? 30 : 8;
      body.textContent = "";
      for (const entry of recent.slice(0, limit)) {
        const item = document.createElement("div");
        item.className = "file-item recent-file-item";
        item.tabIndex = 0;
        item.title = `${this.recentFilesRoot}/${entry.path}\nmodified ${this.exactMtime(entry.mtime)}`;
        const name = document.createElement("span");
        name.className = "file-item-name";
        name.textContent = entry.name;
        const mtime = document.createElement("span");
        mtime.className = "recent-mtime";
        mtime.textContent = this.formatMtime(entry.mtime);
        mtime.title = `modified ${this.exactMtime(entry.mtime)}`;
        item.append(this.fileTypeIconEl(entry.name, "file-type-icon"), name, mtime);
        this.appendGitStatus(item, entry);
        item.onclick = () => void this.openRecentlyModifiedFile(this.recentFilesRoot, entry.path);
        item.onauxclick = (event) => this.handleFileDeckAuxClick(event, this.recentFilesRoot, entry.path);
        item.oncontextmenu = (event) => this.openFileDeckRowContextMenu(event, this.recentFilesRoot, entry.path);
        body.appendChild(item);
      }
      const hiddenCount = Math.max(0, recent.length - 8);
      toggle.textContent = this.recentFilesExpanded ? "8" : (hiddenCount ? `+${Math.min(22, hiddenCount)}` : "30");
      toggle.title = this.recentFilesExpanded ? "Show 8 recently modified files" : "Show up to 30 recently modified files";
      toggle.classList.toggle("on", this.recentFilesExpanded);
      toggle.disabled = recent.length <= 8;
      if (!recent.length) {
        const empty = document.createElement("div");
        empty.className = "recent-files-empty";
        empty.textContent = "No matching files";
        body.appendChild(empty);
      }
    };
    toggle.onclick = (event) => {
      event.stopPropagation();
      this.recentFilesExpanded = !this.recentFilesExpanded;
      renderBody();
    };
    renderBody();
  }

  recentFileExcluded(entry, rawPatterns) {
    const path = String(entry.path || "").toLowerCase();
    const name = String(entry.name || path.split("/").pop() || "").toLowerCase();
    const patterns = String(rawPatterns || "").split(",").map((value) => value.trim().replace(/^!/, "").toLowerCase()).filter(Boolean);
    return patterns.some((pattern) => {
      if (pattern.startsWith("*.")) return path.endsWith(pattern.slice(1));
      if (pattern.startsWith(".")) return path.endsWith(pattern);
      if (!pattern.includes("/") && !pattern.includes("*")) {
        return name === pattern || path.endsWith(`.${pattern}`);
      }
      const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      return new RegExp(`(?:^|/)${escaped}$`).test(path);
    });
  }

  async openRecentlyModifiedFile(root, path) {
    await this.openFile(root, path, null, null);
    if (this.vscodeMode || this.activeFileKey !== `${root}|${path}`) return;
    this.fileHistoryMode = "local";
    this.fileHistoryOpen = true;
    this.fileHistorySelections = [];
    this.$("file-history-panel").classList.remove("hidden");
    this.$("file-history-toggle").classList.add("on");
    this.$("file-history-toggle").setAttribute("aria-pressed", "true");
    this.renderTopbar();
    await this.loadFileHistory(true);
  }

  async refreshRecentFiles(force = false) {
    if (this.vscodeMode) return;
    if (this.sectionCollapsed("recent_files_collapsed")) {
      this.updateRecentFilesWatch();
      return;
    }
    if (this.recentFilesBusy) return;
    const activeRoot = this.session(this.activeId)?.cwd || this.worktreeRoot();
    const filesVisible = !this.$("files-section").classList.contains("hidden");
    const root = (filesVisible && this.treeRoot) || activeRoot;
    if (!root) return;
    if (!force && this.recentFilesRoot === root && Date.now() - this.recentFilesFetchedAt < RECENT_FILES_MIN_REFRESH_MS) return;
    this.recentFilesBusy = true;
    try {
      const res = await fetch(`/api/files/recent?root=${encodeURIComponent(root)}&limit=40`);
      // Recent files are also rendered below terminals while the Files view is
      // hidden, so treeRoot may intentionally be stale or null in that state.
      if (!res.ok || (filesVisible && this.treeRoot !== root)) return;
      const next = await res.json();
      const fingerprint = `${root}|${next.map((entry) => `${entry.path}:${entry.mtime}`).join("|")}`;
      this.recentFilesRoot = root;
      this.recentFilesFetchedAt = Date.now();
      if (fingerprint !== this.recentFilesFingerprint) {
        this.recentFiles = next;
        this.recentFilesFingerprint = fingerprint;
        this.renderList();
      }
    } catch (error) {
      console.warn("recent files refresh failed", error);
    } finally {
      this.recentFilesBusy = false;
    }
  }

  renderClosedInto(list, closedSessions = this.closedSessions, worktreeId = this.worktreeId || "root") {
    if (!closedSessions.length) return;
    const search = this.terminalSearchText.trim();
    const matchingClosed = search
      ? closedSessions.filter((session) => this.terminalSearchClosedMatches.has(session.session_id))
      : closedSessions;
    if (search && !matchingClosed.length) return;
    const header = document.createElement("div");
    header.className = "side-section-label closed-header";
    header.dataset.worktreeId = worktreeId;
    const chevron = document.createElement("span");
    const expanded = this.worktreeClosedExpanded(worktreeId);
    chevron.className = "codicon codicon-chevron-right closed-chevron" + (expanded ? " open" : "");
    const title = document.createElement("span");
    title.textContent = search
      ? `closed terminals (${matchingClosed.length}/${closedSessions.length})`
      : `closed terminals (${closedSessions.length})`;
    header.append(chevron, title);
    header.onclick = () => {
      this.setWorktreeClosedExpanded(worktreeId, !this.worktreeClosedExpanded(worktreeId));
      this.renderList();
    };
    list.appendChild(header);
    if (!expanded) return;
    const visibleClosedLimit = search && !this.terminalSearchGroupId
      ? CLOSED_SESSIONS_MAX_DISPLAY : Math.min(this.closedDisplayLimit, CLOSED_SESSIONS_MAX_DISPLAY);
    const visibleClosed = matchingClosed.slice(0, visibleClosedLimit);
    for (const c of visibleClosed) {
      const item = document.createElement("div");
      const searchMatch = search ? this.terminalSearchClosedMatches.get(c.session_id) : null;
      item.className = "closed-item" + (searchMatch ? " terminal-search-match" : "");
      item.dataset.worktreeId = worktreeId;
      if (searchMatch) item.tabIndex = 0;
      const groupName = c.group_name || this.terminalGroupNameForSession(c.session_id, worktreeId);
      item.title = `${c.title}\n${c.command || "zsh"}\n${c.cwd}\nclosed ${c.closed_at_est}` +
        (groupName ? `\ngroup ${groupName}` : "") +
        (c.worktree_branch ? `\nworktree ${c.worktree_branch}` : "") +
        (c.agent_session_id ? `\nreopens ${c.agent_kind} session ${c.agent_session_id}` : "") + "\nclick to reopen";
      const icon = document.createElement("span");
      icon.className = "codicon codicon-history";
      const name = document.createElement("span");
      name.className = "file-item-name";
      if (searchMatch) this.appendTerminalSearchHighlightedText(name, c.title, search);
      else name.textContent = c.title;
      const group = document.createElement("span");
      group.className = "closed-group";
      group.textContent = groupName;
      const worktree = document.createElement("span");
      worktree.className = "worktree-badge";
      worktree.textContent = c.worktree_branch ? `⎇ ${c.worktree_branch.split("/").pop()}` : "";
      worktree.title = c.worktree_path || "";
      const purge = document.createElement("button");
      purge.className = "item-close";
      purge.textContent = "✕";
      purge.title = "Remove from history";
      purge.onclick = (e) => { e.stopPropagation(); this.purgeClosed(c.session_id); };
      item.append(icon, name, worktree, group, purge);
      this.bindTerminalSearchHoverPopup(item, searchMatch);
      item.onclick = () => {
        this.setInteractionWorktreeFromElement(item, c);
        this.reopenClosed(c.session_id);
      };
      item.onfocus = () => {
        if (this.terminalSearchText.trim()) this.terminalSearchFocusIndex = this.terminalSearchRows().indexOf(item);
      };
      item.onkeydown = (event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          event.stopPropagation();
          this.moveTerminalSearchRow(event.key === "ArrowDown" ? 1 : -1);
        } else if (event.key === "Enter") {
          event.preventDefault();
          item.click();
        } else if (event.key === "Escape") {
          event.preventDefault();
          this.closeTerminalSearchEditor();
        }
      };
      list.appendChild(item);
    }
    if (matchingClosed.length > visibleClosed.length && visibleClosed.length < CLOSED_SESSIONS_MAX_DISPLAY) {
      const loadMore = document.createElement("button");
      loadMore.className = "closed-load-more";
      loadMore.textContent = `load more (${Math.min(
        CLOSED_SESSIONS_MAX_DISPLAY - visibleClosed.length,
        matchingClosed.length - visibleClosed.length)})`;
      loadMore.title = "Show more recently closed terminals";
      loadMore.onclick = (event) => {
        event.stopPropagation();
        this.closedDisplayLimit = Math.min(
          CLOSED_SESSIONS_MAX_DISPLAY, this.closedDisplayLimit + CLOSED_SESSIONS_INITIAL_DISPLAY);
        this.renderList();
      };
      list.appendChild(loadMore);
    }
  }

  async reopenClosed(sessionId) {
    const res = await fetch(`/api/closed/${sessionId}/reopen`, { method: "POST" });
    if (!res.ok) return false;
    const reopened = await res.json();
    const reopenedSessionId = reopened.session_id || sessionId;
    await this.refresh();
    if (!this.session(reopenedSessionId)) return false;
    this.activate(reopenedSessionId, { reveal: true });
    const view = this.views.get(reopenedSessionId);
    if (view) view.pinBottomUntil = Date.now() + 6000;
    requestAnimationFrame(() => {
      if (this.activeId !== reopenedSessionId || this.activeFileKey !== null) return;
      this.keepActiveSessionVisible();
      this.focusActiveEditor();
    });
    return true;
  }

  async restoreLastClosedTerminal() {
    if (this.restoreLastClosedTerminalBusy) return;
    const lastClosed = this.closedSessions[0];
    if (!lastClosed) {
      this.$("status-name").textContent = "no recently closed terminal";
      return;
    }
    if (this.restoreLastClosedTerminalNeedsConfirmation &&
        !window.confirm("You already restored the last closed terminal. Restore another older terminal?")) return;
    this.restoreLastClosedTerminalBusy = true;
    try {
      if (await this.reopenClosed(lastClosed.session_id)) this.restoreLastClosedTerminalNeedsConfirmation = true;
    } finally {
      this.restoreLastClosedTerminalBusy = false;
    }
  }

  async purgeClosed(sessionId) {
    await fetch(`/api/closed/${sessionId}`, { method: "DELETE" });
    this.refresh();
  }

  restorePageFavicon() {
    if (!this.pageFavicon) return;
    this.pageFavicon.type = this.pageFaviconType;
    this.pageFavicon.href = this.pageFaviconHref;
  }

  showPageTitleFaviconState(faviconState) {
    if (!this.pageFavicon) return;
    if (faviconState === "plain") {
      this.restorePageFavicon();
      return;
    }
    this.pageFavicon.type = "image/svg+xml";
    this.pageFavicon.href = faviconState === "processing"
      ? "/static/favicon-processing.svg"
      : "/static/favicon-unread.svg";
  }

  updateDocumentTitle(pageTitle, faviconState) {
    document.title = pageTitle;
    if (this.pageTitleFaviconState === faviconState) return;
    this.pageTitleFaviconState = faviconState;
    this.showPageTitleFaviconState(faviconState);
  }

  renderTopbar() {
    const s = this.session(this.activeId);
    const entry = this.activeFileKey !== null ? this.openFiles.get(this.activeFileKey) : null;
    const tabTitle = entry ? entry.name : (s ? this.titlePresentation(s).text : null);
    const pageTitle = this.vscodeMode ? "TermDeck" : (tabTitle ? `${tabTitle} — TermDeck` : "TermDeck");
    const processing = !entry && !!s && this.titlePresentation(s).spinning;
    const unread = !entry && !!s && !processing && this.unreadSessions.has(s.session_id);
    this.updateDocumentTitle(pageTitle, processing ? "processing" : unread ? "unread" : "plain");
    const statusEl = this.$("status-name");
    if (entry) {
      statusEl.textContent = this.vscodeMode ? entry.name : (entry.fullPath || `${entry.root}/${entry.path}`);
    } else {
      statusEl.textContent = this.vscodeMode ? (s ? this.titlePresentation(s).text : "") : (s ? `${this.titlePresentation(s).text}  ·  ${s.cwd}` : "");
    }
    statusEl.title = statusEl.textContent;
    this.updateActiveTerminalAge();
    const fileClose = this.$("file-view-close");
    if (fileClose) {
      fileClose.classList.toggle("hidden", !entry || this.vscodeMode);
      fileClose.title = "Return to terminal (Esc)";
      fileClose.setAttribute("aria-label", "Return to terminal");
    }
    const fileHistoryToggle = this.$("file-history-toggle");
    if (fileHistoryToggle) {
      fileHistoryToggle.classList.toggle("hidden", !entry || this.vscodeMode);
      fileHistoryToggle.classList.toggle("on", !!entry && this.fileHistoryOpen);
      fileHistoryToggle.title = entry ? `File history for ${entry.name}` : "File history";
      fileHistoryToggle.setAttribute("aria-pressed", String(!!entry && this.fileHistoryOpen));
    }
    const fileHistoryGitToggle = this.$("file-history-git-toggle");
    if (fileHistoryGitToggle) {
      fileHistoryGitToggle.title = this.fileHistoryMode === "git" ? "Show local history" : "Show Git history";
      fileHistoryGitToggle.setAttribute("aria-label", fileHistoryGitToggle.title);
      fileHistoryGitToggle.setAttribute("aria-pressed", String(this.fileHistoryMode === "git"));
    }
    const navigationState = this.parseNavState(this.lastNavJson);
    if (!entry && s && navigationState?.kind === "term" && navigationState.id === s.session_id) {
      history.replaceState(navigationState, "", this.navUrl(navigationState));
    }
    this.renderHistoryMeta();
    this.renderFileEditorChrome();
  }

  fileHistorySourceLabel(source) {
    return { opened: "Opened", external: "External change", manual: "Edited", restore: "Restored" }[source] || source;
  }

  fileHistoryTimestampLabel(value) {
    const text = String(value || "").replace("T", " ");
    return text.length >= 16 ? text.slice(0, 16) : text;
  }

  fileHistoryItemKey(item) {
    if (item.kind === "current") return "current";
    return `${item.kind}:${item.kind === "git" ? item.commit_id : item.version_id}`;
  }

  fileHistoryItemLabel(item) {
    if (item.kind === "current") return "Current file";
    if (item.kind === "git") return `${item.short_id} ${item.message}`;
    return this.fileHistorySourceLabel(item.source);
  }

  fileHistoryItemTimestampLabel(item) {
    if (item.kind === "current") return "Working copy";
    return this.fileHistoryTimestampLabel(item.kind === "git" ? item.committed_at : item.captured_at_est);
  }

  disposeFileHistoryEditors() {
    this.fileHistoryDiffEditor?.dispose();
    this.fileHistoryCurrentEditor?.dispose();
    this.fileHistoryDiffEditor = null;
    this.fileHistoryCurrentEditor = null;
    for (const model of this.fileHistoryTransientModels) model.dispose();
    this.fileHistoryTransientModels.clear();
    this.fileHistoryActiveComparison = null;
    this.fileHistoryDiffBlocks = [];
    this.fileHistoryDiffBlockIndex = -1;
  }

  updateFileHistoryDiffToolbar() {
    const toolbar = this.$("file-history-diff-toolbar");
    const comparison = this.fileHistoryActiveComparison;
    const hasChanges = this.fileHistoryDiffBlocks.length > 0;
    toolbar.classList.toggle("hidden", !comparison?.isDiff);
    const previous = this.$("file-history-diff-previous");
    const next = this.$("file-history-diff-next");
    const undoBlock = this.$("file-history-diff-undo-block");
    const undoLine = this.$("file-history-diff-undo-line");
    previous.disabled = !hasChanges;
    next.disabled = !hasChanges;
    undoBlock.disabled = !comparison?.modifiedEditable || !hasChanges;
    undoLine.disabled = !comparison?.modifiedEditable || !hasChanges;
    this.$("file-history-diff-position").textContent = hasChanges
      ? `${this.fileHistoryDiffBlockIndex + 1}/${this.fileHistoryDiffBlocks.length}` : "0/0";
  }

  refreshFileHistoryDiffNavigation() {
    const comparison = this.fileHistoryActiveComparison;
    if (!comparison?.isDiff || !comparison.modifiedEditable) return;
    const diff = this.computeFileHistoryLineDiff(comparison.originalModel.getValue(), comparison.modifiedModel.getValue());
    this.fileHistoryDiffBlocks = diff.tooLarge ? [] : this.fileHistoryDiffBlocksFromLines(diff.lines);
    this.fileHistoryDiffBlockIndex = this.fileHistoryDiffBlocks.length
      ? Math.min(Math.max(this.fileHistoryDiffBlockIndex, 0), this.fileHistoryDiffBlocks.length - 1) : -1;
    this.updateFileHistoryDiffToolbar();
  }

  toggleFileHistory() {
    if (this.fileHistoryOpen) {
      this.closeFileHistory();
      return;
    }
    if (this.vscodeMode || this.activeFileKey === null) return;
    this.fileHistoryOpen = true;
    this.fileHistorySelections = [];
    this.$("file-history-panel").classList.remove("hidden");
    this.$("file-history-toggle").classList.add("on");
    this.$("file-history-toggle").setAttribute("aria-pressed", "true");
    void this.loadFileHistory();
  }

  closeFileHistory() {
    this.fileHistoryOpen = false;
    clearTimeout(this.fileHistoryComparisonTimer);
    this.fileHistoryComparisonTimer = 0;
    this.disposeFileHistoryEditors();
    this.updateFileHistoryDiffToolbar();
    this.fileHistorySelections = [];
    this.fileHistoryVersions = [];
    this.fileHistoryItems = [];
    this.fileHistoryLoadGeneration += 1;
    this.$("file-history-panel")?.classList.add("hidden");
    this.$("file-history-toggle")?.classList.remove("on");
    this.$("file-history-toggle")?.setAttribute("aria-pressed", "false");
  }

  toggleFileHistoryMode() {
    if (!this.fileHistoryOpen) return;
    this.fileHistoryMode = this.fileHistoryMode === "local" ? "git" : "local";
    this.fileHistorySelections = [];
    const toggle = this.$("file-history-git-toggle");
    toggle.textContent = "";
    const icon = document.createElement("span");
    icon.className = "codicon codicon-git-branch";
    toggle.appendChild(icon);
    toggle.title = this.fileHistoryMode === "git" ? "Show local history" : "Show Git history";
    toggle.setAttribute("aria-label", toggle.title);
    toggle.setAttribute("aria-pressed", String(this.fileHistoryMode === "git"));
    void this.loadFileHistory();
  }

  async loadFileHistory(compareWithPreviousVersion = false) {
    const entry = this.activeFileKey !== null ? this.openFiles.get(this.activeFileKey) : null;
    if (!entry || this.vscodeMode) {
      this.closeFileHistory();
      return;
    }
    const generation = ++this.fileHistoryLoadGeneration;
    const path = `${entry.root}/${entry.path}`;
    this.$("file-history-path").textContent = path;
    this.$("file-history-path").title = path;
    this.$("file-history-list").textContent = "loading history…";
    this.$("file-history-preview-empty").textContent = this.fileHistoryMode === "git"
      ? "Select a Git commit, or select two commits to compare them."
      : "Select a version to compare it with the current file, or select two versions to compare them.";
    this.$("file-history-preview-empty").classList.remove("hidden");
    this.$("file-history-preview").classList.add("hidden");
    const historyUrl = this.fileHistoryMode === "git"
      ? `/api/files/git-history?root=${encodeURIComponent(entry.root)}&path=${encodeURIComponent(entry.path)}`
      : `/api/files/history?root=${encodeURIComponent(entry.root)}&path=${encodeURIComponent(entry.path)}`;
    const res = await fetch(historyUrl);
    if (generation !== this.fileHistoryLoadGeneration || !this.fileHistoryOpen) return;
    if (!res.ok) {
      this.$("file-history-list").textContent = "history unavailable";
      return;
    }
    const values = await res.json();
    this.fileHistoryVersions = this.fileHistoryMode === "local" ? values : [];
    const historicalItems = this.fileHistoryMode === "local"
      ? values.map((version) => ({ kind: "local", ...version }))
      : values.map((commit) => ({ kind: "git", ...commit }));
    this.fileHistoryItems = [{ kind: "current" }, ...historicalItems];
    if (generation !== this.fileHistoryLoadGeneration || !this.fileHistoryOpen) return;
    const availableKeys = new Set(this.fileHistoryItems.map((item) => this.fileHistoryItemKey(item)));
    this.fileHistorySelections = this.fileHistorySelections.filter((key) => availableKeys.has(key)).slice(-2);
    if (compareWithPreviousVersion && historicalItems.length > 1) {
      this.fileHistorySelections = ["current", this.fileHistoryItemKey(historicalItems[1])];
    } else if (!this.fileHistorySelections.length && this.fileHistoryItems.length) {
      this.fileHistorySelections = [this.fileHistoryItemKey(this.fileHistoryItems[0])];
    }
    this.renderFileHistoryRows();
    await this.renderFileHistoryComparison(generation);
  }

  renderFileHistoryRows() {
    const list = this.$("file-history-list");
    list.textContent = "";
    if (!this.fileHistoryItems.length) {
      list.textContent = this.fileHistoryMode === "git" ? "No Git history found for this file." : "No saved or externally changed versions yet.";
      return;
    }
    for (const item of this.fileHistoryItems) {
      const itemKey = this.fileHistoryItemKey(item);
      const row = document.createElement("div");
      row.className = "file-history-version" + (item.kind === "current" ? " current" : "") +
        (this.fileHistorySelections.includes(itemKey) ? " selected" : "");
      const select = document.createElement("button");
      select.className = "file-history-version-select";
      select.type = "button";
      select.title = item.kind === "current"
        ? "Open the current file for editing"
        : "Select one; hold Shift or ⌘/Ctrl to select another for comparison";
      const source = document.createElement("span");
      source.className = "file-history-version-source";
      source.textContent = this.fileHistoryItemLabel(item);
      const date = document.createElement("span");
      date.className = "file-history-version-date";
      const timestamp = this.fileHistoryItemTimestampLabel(item);
      date.textContent = item.kind === "git" ? `${item.author} · ${timestamp}` : timestamp;
      date.title = item.kind === "current"
        ? "The current editable working copy"
        : item.kind === "git" ? `${item.author} · ${item.committed_at}` : String(item.captured_at_est || "");
      const size = document.createElement("span");
      size.className = "file-history-version-size";
      size.textContent = item.kind === "current" ? "Editable" : item.kind === "git" ? "Git" : `${Math.ceil(Number(item.byte_size || 0) / 1024)} KB`;
      select.append(source, date, size);
      select.onclick = (event) => this.selectFileHistoryItem(item, event);
      row.appendChild(select);
      if (item.kind === "local") {
        const restore = document.createElement("button");
        restore.className = "file-history-restore";
        restore.type = "button";
        restore.title = "Restore this version";
        restore.textContent = "Restore";
        restore.onclick = () => this.restoreFileHistoryVersion(item.version_id);
        row.appendChild(restore);
      }
      list.appendChild(row);
    }
  }

  selectFileHistoryItem(item, event) {
    const key = this.fileHistoryItemKey(item);
    if (event.shiftKey) {
      const anchor = this.fileHistorySelections[0] || key;
      this.fileHistorySelections = anchor === key ? [key] : [anchor, key];
    } else if (event.metaKey || event.ctrlKey) {
      const selected = this.fileHistorySelections.filter((candidate) => candidate !== key);
      if (!this.fileHistorySelections.includes(key)) selected.push(key);
      this.fileHistorySelections = selected.slice(-2);
    } else {
      this.fileHistorySelections = [key];
    }
    this.renderFileHistoryRows();
    void this.renderFileHistoryComparison(this.fileHistoryLoadGeneration);
  }

  async loadFileHistoryItemContent(item, entry) {
    const url = item.kind === "git"
      ? `/api/files/git-history/${encodeURIComponent(item.commit_id)}?root=${encodeURIComponent(entry.root)}&path=${encodeURIComponent(entry.path)}`
      : `/api/files/history/${encodeURIComponent(item.version_id)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("history version unavailable");
    const payload = await res.json();
    return String(payload.content || "");
  }

  async currentFileHistoryContent(entry) {
    if (entry.model) return entry.model.getValue();
    const res = await fetch(`/api/files/read?root=${encodeURIComponent(entry.root)}&path=${encodeURIComponent(entry.path)}`);
    if (!res.ok) throw new Error("current file unavailable");
    const payload = await res.json();
    return String(payload.content || "");
  }

  computeFileHistoryLineDiff(originalContent, modifiedContent) {
    const original = String(originalContent).split("\n");
    const modified = String(modifiedContent).split("\n");
    if (original.length * modified.length > 1_000_000 || original.length + modified.length > 30_000) {
      return { tooLarge: true, removed: original.length, added: modified.length, lines: [] };
    }
    const table = Array.from({ length: original.length + 1 }, () => new Uint32Array(modified.length + 1));
    for (let originalIndex = original.length - 1; originalIndex >= 0; originalIndex -= 1) {
      for (let modifiedIndex = modified.length - 1; modifiedIndex >= 0; modifiedIndex -= 1) {
        table[originalIndex][modifiedIndex] = original[originalIndex] === modified[modifiedIndex]
          ? table[originalIndex + 1][modifiedIndex + 1] + 1
          : Math.max(table[originalIndex + 1][modifiedIndex], table[originalIndex][modifiedIndex + 1]);
      }
    }
    const lines = [];
    let originalIndex = 0;
    let modifiedIndex = 0;
    while (originalIndex < original.length || modifiedIndex < modified.length) {
      if (originalIndex < original.length && modifiedIndex < modified.length && original[originalIndex] === modified[modifiedIndex]) {
        lines.push({ kind: "context", text: original[originalIndex], oldLine: originalIndex + 1, newLine: modifiedIndex + 1 });
        originalIndex += 1;
        modifiedIndex += 1;
      } else if (modifiedIndex >= modified.length || (originalIndex < original.length && table[originalIndex + 1][modifiedIndex] >= table[originalIndex][modifiedIndex + 1])) {
        lines.push({ kind: "remove", text: original[originalIndex], oldLine: originalIndex + 1, newLine: "" });
        originalIndex += 1;
      } else {
        lines.push({ kind: "add", text: modified[modifiedIndex], oldLine: "", newLine: modifiedIndex + 1 });
        modifiedIndex += 1;
      }
    }
    return { tooLarge: false, removed: lines.filter((line) => line.kind === "remove").length,
      added: lines.filter((line) => line.kind === "add").length, lines };
  }

  renderFileHistoryDiff(originalContent, modifiedContent, originalLabel, modifiedLabel) {
    const preview = this.$("file-history-preview");
    preview.textContent = "";
    const diff = this.computeFileHistoryLineDiff(originalContent, modifiedContent);
    const header = document.createElement("div");
    header.className = "file-history-diff-summary";
    header.textContent = `${originalLabel} → ${modifiedLabel}   +${diff.added} −${diff.removed}`;
    preview.appendChild(header);
    if (diff.tooLarge) {
      const notice = document.createElement("div");
      notice.className = "file-history-diff-notice";
      notice.textContent = "Diff is too large to render line-by-line; version contents are still available from the history entries.";
      preview.appendChild(notice);
    } else if (!diff.lines.some((line) => line.kind !== "context")) {
      const notice = document.createElement("div");
      notice.className = "file-history-diff-notice";
      notice.textContent = "No differences.";
      preview.appendChild(notice);
    } else {
      const body = document.createElement("div");
      body.className = "file-history-diff-body";
      for (const line of diff.lines) {
        const row = document.createElement("div");
        row.className = `file-history-diff-line ${line.kind}`;
        const oldLine = document.createElement("span");
        oldLine.className = "file-history-diff-line-number";
        oldLine.textContent = line.oldLine;
        const newLine = document.createElement("span");
        newLine.className = "file-history-diff-line-number";
        newLine.textContent = line.newLine;
        const prefix = document.createElement("span");
        prefix.className = "file-history-diff-prefix";
        prefix.textContent = line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " ";
        const text = document.createElement("span");
        text.className = "file-history-diff-text";
        text.textContent = line.text;
        row.append(oldLine, newLine, prefix, text);
        body.appendChild(row);
      }
      preview.appendChild(body);
    }
    preview.classList.remove("hidden");
    this.$("file-history-preview-empty").classList.add("hidden");
  }

  fileHistoryDiffBlocksFromLines(lines) {
    const blocks = [];
    let block = null;
    let oldCursor = 1;
    let newCursor = 1;
    for (const line of lines) {
      if (line.kind === "context") {
        if (block) {
          block.oldEnd = oldCursor - 1;
          block.newEnd = newCursor - 1;
          blocks.push(block);
          block = null;
        }
        oldCursor = Number(line.oldLine) + 1;
        newCursor = Number(line.newLine) + 1;
        continue;
      }
      if (!block) block = { oldStart: oldCursor, oldEnd: oldCursor - 1, newStart: newCursor, newEnd: newCursor - 1,
        originalLines: [], modifiedLines: [], lines: [] };
      block.lines.push(line);
      if (line.kind === "remove") {
        block.originalLines.push(line.text);
        oldCursor += 1;
      } else {
        block.modifiedLines.push(line.text);
        newCursor += 1;
      }
    }
    if (block) {
      block.oldEnd = oldCursor - 1;
      block.newEnd = newCursor - 1;
      blocks.push(block);
    }
    return blocks;
  }

  createFileHistoryTransientModel(content, entry, item) {
    const language = entry.model?.getLanguageId();
    const model = monaco.editor.createModel(content, language, monaco.Uri.parse(
      `inmemory://termdeck-file-history/${encodeURIComponent(`${entry.root}/${entry.path}/${this.fileHistoryItemKey(item)}`)}`));
    this.fileHistoryTransientModels.add(model);
    return model;
  }

  fileHistoryEditorOptions() {
    return { automaticLayout: true, minimap: { enabled: false }, scrollBeyondLastLine: false,
      fontSize: this.settings.code_font_size, lineNumbersMinChars: 4, renderLineHighlight: "all", folding: true,
      wordWrap: this.settings.editor_no_wrap ? "off" : "on", fixedOverflowWidgets: true };
  }

  renderFileHistoryCurrentEditor(entry) {
    this.disposeFileHistoryEditors();
    const host = this.$("file-history-editor-host");
    host.classList.remove("hidden");
    const editor = monaco.editor.create(host, { ...this.fileHistoryEditorOptions(), readOnly: false, model: entry.model,
      theme: this.monacoThemeName() });
    this.fileHistoryCurrentEditor = editor;
    this.fileHistoryActiveComparison = { isDiff: false, modifiedEditable: false, entry, editor };
    this.$("file-history-preview-empty").classList.add("hidden");
    this.$("file-history-preview").classList.add("hidden");
    this.updateFileHistoryDiffToolbar();
    requestAnimationFrame(() => editor.layout());
  }

  renderFileHistorySplitEditor(entry, originalContent, modifiedContent, originalItem, modifiedItem, modifiedEditable) {
    this.disposeFileHistoryEditors();
    const host = this.$("file-history-editor-host");
    host.classList.remove("hidden");
    const originalModel = this.createFileHistoryTransientModel(originalContent, entry, originalItem);
    const modifiedModel = modifiedEditable ? entry.model : this.createFileHistoryTransientModel(modifiedContent, entry, modifiedItem);
    const editor = monaco.editor.createDiffEditor(host, { ...this.fileHistoryEditorOptions(), readOnly: !modifiedEditable,
      originalEditable: false, renderSideBySide: true, theme: this.monacoThemeName() });
    editor.setModel({ original: originalModel, modified: modifiedModel });
    this.fileHistoryDiffEditor = editor;
    this.fileHistoryActiveComparison = { isDiff: true, modifiedEditable, entry, editor,
      originalModel, modifiedModel, originalItem, modifiedItem };
    const diff = this.computeFileHistoryLineDiff(originalContent, modifiedContent);
    this.fileHistoryDiffBlocks = diff.tooLarge ? [] : this.fileHistoryDiffBlocksFromLines(diff.lines);
    this.fileHistoryDiffBlockIndex = this.fileHistoryDiffBlocks.length ? 0 : -1;
    this.$("file-history-preview-empty").classList.add("hidden");
    this.$("file-history-preview").classList.add("hidden");
    this.updateFileHistoryDiffToolbar();
    if (typeof editor.onDidUpdateDiff === "function") editor.onDidUpdateDiff(() => this.updateFileHistoryDiffToolbar());
    requestAnimationFrame(() => {
      editor.layout();
      if (modifiedEditable) editor.getModifiedEditor().focus();
      this.navigateFileHistoryDiff(0);
    });
  }

  navigateFileHistoryDiff(direction) {
    if (!this.fileHistoryDiffEditor || !this.fileHistoryDiffBlocks.length) return;
    if (direction) {
      const count = this.fileHistoryDiffBlocks.length;
      this.fileHistoryDiffBlockIndex = (this.fileHistoryDiffBlockIndex + direction + count) % count;
    }
    const block = this.fileHistoryDiffBlocks[this.fileHistoryDiffBlockIndex];
    if (!block) return;
    const originalEditor = this.fileHistoryDiffEditor.getOriginalEditor();
    const modifiedEditor = this.fileHistoryDiffEditor.getModifiedEditor();
    const originalLine = Math.max(1, Math.min(originalEditor.getModel().getLineCount(), block.oldStart));
    const modifiedLine = Math.max(1, Math.min(modifiedEditor.getModel().getLineCount(), block.newStart));
    originalEditor.revealLineInCenter(originalLine);
    modifiedEditor.revealLineInCenter(modifiedLine);
    if (this.fileHistoryActiveComparison?.modifiedEditable) modifiedEditor.setPosition({ lineNumber: modifiedLine, column: 1 });
    this.updateFileHistoryDiffToolbar();
  }

  replaceCurrentFileHistoryLines(startLine, endLine, replacementLines) {
    const comparison = this.fileHistoryActiveComparison;
    if (!comparison?.modifiedEditable || !comparison.entry.model) return;
    const model = comparison.entry.model;
    const lines = model.getLinesContent();
    const startIndex = Math.max(0, Math.min(lines.length, Number(startLine || 1) - 1));
    const endIndex = Math.max(startIndex, Math.min(lines.length, Number(endLine || 0)));
    lines.splice(startIndex, endIndex - startIndex, ...replacementLines);
    const lastLine = model.getLineCount();
    const range = new monaco.Range(1, 1, lastLine, model.getLineMaxColumn(lastLine));
    const editor = this.fileHistoryDiffEditor?.getModifiedEditor() || this.fileHistoryCurrentEditor;
    editor.executeEdits("termdeck-file-history-restore", [{ range, text: lines.join("\n") }]);
    editor.focus();
  }

  undoFileHistoryDiffBlock() {
    const block = this.fileHistoryDiffBlocks[this.fileHistoryDiffBlockIndex];
    if (!block) return;
    this.replaceCurrentFileHistoryLines(block.newStart, block.newEnd, block.originalLines);
  }

  undoFileHistoryDiffLine() {
    const block = this.fileHistoryDiffBlocks[this.fileHistoryDiffBlockIndex];
    if (!block) return;
    const position = this.fileHistoryDiffEditor?.getModifiedEditor().getPosition()?.lineNumber;
    const line = block.lines.find((candidate) => candidate.kind === "add" && candidate.newLine === position) || block.lines[0];
    if (line.kind === "add") this.replaceCurrentFileHistoryLines(line.newLine, line.newLine, []);
    else this.replaceCurrentFileHistoryLines(block.newStart, block.newStart - 1, [line.text]);
  }

  async renderFileHistoryComparison(generation) {
    const entry = this.activeFileKey !== null ? this.openFiles.get(this.activeFileKey) : null;
    if (!entry || !this.fileHistoryOpen || generation !== this.fileHistoryLoadGeneration || !this.fileHistorySelections.length) return;
    const selectionKeys = [...this.fileHistorySelections];
    const selectedItems = selectionKeys.map((key) => this.fileHistoryItems.find((item) => this.fileHistoryItemKey(item) === key)).filter(Boolean);
    if (!selectedItems.length) return;
    try {
      if (!entry.model) await this.refreshFileModelFromDisk(entry);
      if (generation !== this.fileHistoryLoadGeneration || !this.fileHistoryOpen || selectionKeys.join("\n") !== this.fileHistorySelections.join("\n")) return;
      const historyItems = selectedItems.filter((item) => item.kind !== "current");
      if (!historyItems.length) {
        this.renderFileHistoryCurrentEditor(entry);
        return;
      }
      if (historyItems.length === 1) {
        const originalContent = await this.loadFileHistoryItemContent(historyItems[0], entry);
        if (generation !== this.fileHistoryLoadGeneration || !this.fileHistoryOpen || selectionKeys.join("\n") !== this.fileHistorySelections.join("\n")) return;
        this.renderFileHistorySplitEditor(entry, originalContent, entry.model.getValue(), historyItems[0], { kind: "current" }, true);
        return;
      }
      const selectedContents = await Promise.all(historyItems.slice(0, 2).map((item) => this.loadFileHistoryItemContent(item, entry)));
      if (generation !== this.fileHistoryLoadGeneration || !this.fileHistoryOpen || selectionKeys.join("\n") !== this.fileHistorySelections.join("\n")) return;
      this.renderFileHistorySplitEditor(entry, selectedContents[0], selectedContents[1], historyItems[0], historyItems[1], false);
    } catch (error) {
      this.disposeFileHistoryEditors();
      this.updateFileHistoryDiffToolbar();
      this.$("file-history-preview-empty").textContent = error.message || "history comparison unavailable";
      this.$("file-history-preview-empty").classList.remove("hidden");
      this.$("file-history-editor-host").classList.add("hidden");
      this.$("file-history-preview").classList.add("hidden");
    }
  }

  async restoreFileHistoryVersion(versionId) {
    const entry = this.activeFileKey !== null ? this.openFiles.get(this.activeFileKey) : null;
    const version = this.fileHistoryVersions.find((candidate) => candidate.version_id === versionId);
    if (!entry || !version) return;
    if (entry.dirty && !confirm("Discard the current unsaved editor changes and restore this version?")) return;
    if (!confirm(`Restore ${entry.name} from ${version.captured_at_est}?`)) return;
    const res = await fetch("/api/files/history/restore", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root: entry.root, path: entry.path, version_id: versionId }),
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      alert(error.detail || "restore failed");
      return;
    }
    entry.dirty = false;
    await this.refreshFileModelFromDisk(entry);
    this.renderList();
    await this.loadFileHistory();
  }

  renderHistoryMeta() {
    const meta = this.$("history-meta");
    if (!meta) return;
    const visible = this.historyOpen && this.activeFileKey === null;
    meta.classList.toggle("hidden", !visible);
    if (!visible) {
      meta.textContent = "";
      meta.title = "";
      return;
    }
    const session = this.sessionOrClosed(this.activeId);
    const turns = this.historyTurnsBySession.get(this.activeId) || this.historyTurns;
    const plan = [...turns].reverse().find((turn) => turn.kind === "plan" && Array.isArray(turn.plan) && turn.plan.length);
    const parts = [];
    if (plan) {
      const completed = plan.plan.filter((item) => ["complete", "completed", "done"].includes(String(item.status || "").toLowerCase())).length;
      const active = plan.plan.find((item) => String(item.status || "").toLowerCase() === "in_progress");
      parts.push(`goal ${completed}/${plan.plan.length}`);
      if (active?.step) parts.push(String(active.step));
    }
    if (this.processingStates.get(this.activeId)) parts.push("working");
    meta.textContent = parts.join(" · ");
    meta.title = meta.textContent;
    meta.classList.toggle("hidden", parts.length === 0);
    this.renderHistoryModel(session, turns);
  }

  historyModel(session, turns = []) {
    const sessionId = session?.session_id || this.activeId;
    const cachedModel = sessionId ? this.sessionModelById.get(sessionId) || "" : "";
    if (cachedModel && !this.historyModelIsGeneric(cachedModel)) return cachedModel;
    const titleModel = this.historyModelFromText(session?.title);
    if (titleModel && !this.historyModelIsGeneric(titleModel)) return titleModel;
    const cliTitleModel = this.historyModelFromText(session?.cli_title);
    if (cliTitleModel && !this.historyModelIsGeneric(cliTitleModel)) return cliTitleModel;
    const titleCliModel = this.historyModelFromText(session?.title || session?.cli_title);
    if (titleCliModel && !this.historyModelIsGeneric(titleCliModel)) return titleCliModel;
    const fromCommand = this.historyModelFromCommand(session?.command || "");
    if (fromCommand && !this.historyModelIsGeneric(fromCommand)) return fromCommand;
    const fromTranscript = this.historyModelFromTranscript(turns);
    if (fromTranscript) return fromTranscript;
    const sessionTitle = String(session?.title || "").toLowerCase();
    if (sessionTitle.includes("codex")) return "codex";
    if (sessionTitle.includes("claude")) return "claude";
    if (sessionTitle.includes("agy")) return "agy";
    const sessionCliTitle = String(session?.cli_title || "").toLowerCase();
    if (sessionCliTitle.includes("codex")) return "codex";
    if (sessionCliTitle.includes("claude")) return "claude";
    if (sessionCliTitle.includes("agy")) return "agy";
    if (String(session?.command || "").toLowerCase().includes("zsh") ||
        String(session?.command || "").toLowerCase().includes("bash") ||
        String(session?.command || "").toLowerCase().includes("sh")) return "none";
    if (this.historyModelFromText(session?.agent_kind)) return this.historyModelFromText(session?.agent_kind);
    return "none";
  }

  historyModelFromCommand(command) {
    const text = this.normalizeModelText(command);
    if (!text) return "";
    const modelFromFlag = this.historyModelFromCommandFlags(text);
    if (modelFromFlag) return modelFromFlag;
    const commandModel = this.normalizeModelKind(text);
    return commandModel || this.historyModelFromValue(text);
  }

  historyModelFromCommandFlags(text) {
    const rawTokens = text.match(/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|[^\s]+/g);
    const tokens = rawTokens === null ? [] : rawTokens;
    for (let i = 0; i < tokens.length; i++) {
      const token = this.normalizeModelText(tokens[i]);
      const lower = token.toLowerCase();
      if (lower === "--model" || lower === "--model-name" || lower === "--model_name" || lower === "-m") {
        const candidate = this.historyModelFromValue(tokens[i + 1]);
        if (candidate) return candidate;
      }
      const assignmentMatch = /^(?:--model|--model-name|--model_name|-m)=(.+)$/i.exec(token);
      if (!assignmentMatch) continue;
      const candidate = this.historyModelFromValue(assignmentMatch[1]);
      if (candidate) return candidate;
    }
    return "";
  }

  historyModelFromValue(raw) {
    const value = this.normalizeModelText(raw).replace(/^["']|["']$/g, "");
    if (!value) return "";
    const modelPattern = /\b(gpt-[a-z0-9.+-]+(?:-[a-z0-9.+-]+)*(?:\s+(?:x)?(?:high|medium|low|standard|mini|turbo))?)\b/gi;
    const match = value.match(modelPattern);
    if (!match) return "";
    return match[0];
  }

  historyModelFromText(raw) {
    const value = this.historyModelFromValue(raw);
    if (value) return value;
    return this.normalizeModelKind(raw);
  }

  normalizeModelText(raw) {
    return typeof raw === "string" ? raw.trim() : "";
  }

  normalizeModelKind(raw) {
    const text = String(raw || "").toLowerCase();
    if (!text) return "";
    if (text.includes("codex")) return "codex";
    if (text.includes("claude")) return "claude";
    if (text.includes("agy")) return "agy";
    if (text.includes("none") || /\b(shell|zsh|bash)\b/.test(text)) return "none";
    return "";
  }

  cacheSessionModel(session) {
    if (!session || !session.session_id) return;
    const sessionId = session.session_id;
    const commandModel = this.historyModelFromCommand(session.command);
    const titleModel = this.historyModelFromText(session.title);
    const cliTitleModel = this.historyModelFromText(session.cli_title);
    const specific = [commandModel, titleModel, cliTitleModel].find((value) => value && !this.historyModelIsGeneric(value));
    if (specific) this.sessionModelById.set(sessionId, specific);
    else this.sessionModelById.delete(sessionId);
  }

  cacheSessionModelFromHistory(sessionId, turns = []) {
    if (!sessionId) return;
    const specific = this.historyModelFromTranscript(turns);
    if (specific) this.sessionModelById.set(sessionId, specific);
  }

  historyModelFromTranscript(turns = []) {
    if (!Array.isArray(turns)) return "";
    for (const turn of turns) {
      const candidates = [
        this.historyModelFromValue(this.normalizeModelText(turn?.model)),
        this.historyModelFromValue(this.normalizeModelText(turn?.model_name)),
        this.historyModelFromValue(this.normalizeModelText(turn?.model_slug)),
        this.historyModelFromValue(this.normalizeModelText(turn?.assistant_model)),
        this.historyModelFromValue(this.normalizeModelText(turn?.text)),
      ];
      const explicit = candidates.find((candidate) => candidate);
      if (explicit) return explicit;
    }
    return "";
  }

  historyModelDisplayFromTranscript(turns = []) {
    if (!Array.isArray(turns)) return "";
    return this.historyModelFromTranscript(turns);
  }

  historyModelIsGeneric(raw) {
    const text = this.normalizeModelText(raw).toLowerCase();
    return text === "codex" || text === "claude" || text === "none" || text === "shell"
      || text === "agy" || text === "bash" || text === "zsh" || text === "sh";
  }

  historyModelDisplay(session, turns = []) {
    const fromTranscript = this.historyModelDisplayFromTranscript(turns);
    if (fromTranscript) return fromTranscript;
    return this.historyModelLabel(session, turns);
  }

  historyModelLabel(session, turns = []) {
    const model = this.historyModel(session, turns);
    if (this.historyModelIsGeneric(model)) {
      const label = model === "codex" ? "Codex" : model === "claude" ? "Claude" : model === "agy" ? "AGY" : "Shell";
      return label;
    }
    const label = this.historyModelModelLabel(model);
    return label || "";
  }

  historyModelModelLabel(model) {
    return this.normalizeModelText(model);
  }

  terminalStatusModelFromLine(line) {
    const text = this.normalizeTerminalTailLine(line);
    if (!text || !/(?:context|tokens?|remaining|left|used|model|thinking|working|%)/i.test(text)) return "";
    const gptModel = this.historyModelFromValue(text);
    if (gptModel && !this.historyModelIsGeneric(gptModel)) return gptModel;
    const match = text.match(/\b((?:claude|gemini)(?:[-\s](?!(?:context|tokens?|remaining|left|used|model|thinking|working)\b)[a-z0-9.]+)*|(?:opus|sonnet|haiku)(?:[-\s](?!(?:context|tokens?|remaining|left|used|model|thinking|working)\b)[a-z0-9.]+)*)\b/i);
    const model = this.normalizeModelText(match?.[1] || "");
    return this.historyModelIsGeneric(model) ? "" : model;
  }

  terminalStatusModel(view) {
    const buffer = view?.term?.buffer?.active;
    if (!buffer || typeof buffer.getLine !== "function") return "";
    const rows = Math.max(1, Number(view.term.rows || 1));
    const end = Math.max(rows, Number(buffer.baseY || 0) + rows);
    const start = Math.max(0, end - Math.max(12, rows));
    for (let index = end - 1; index >= start; index--) {
      const line = buffer.getLine(index);
      const model = this.terminalStatusModelFromLine(line ? line.translateToString(true) : "");
      if (model) return model;
    }
    return "";
  }

  renderHistoryModel(session, turns = []) {
    const modelEl = this.$("history-model");
    if (!modelEl) return;
    if (!this.historyOpen || this.activeFileKey !== null) {
      modelEl.textContent = "";
      modelEl.classList.add("hidden");
      return;
    }
    const model = this.terminalStatusModel(this.views.get(session?.session_id || this.activeId)) ||
      this.historyModelDisplay(session, turns);
    if (!model) {
      modelEl.textContent = "";
      modelEl.classList.add("hidden");
      return;
    }
    modelEl.textContent = model;
    modelEl.classList.remove("hidden");
    modelEl.title = modelEl.textContent;
  }

  usesTranscriptFirstSession(session = this.session(this.activeId)) {
    return !!session && ["codex", "claude", "agy"].includes(session.agent_kind);
  }

  selectedHistoryMode(session = this.session(this.activeId)) {
    if (!session) return false;
    const savedMode = this.getProjectState().session_view_modes?.[session.session_id];
    if (savedMode === "markdown" || savedMode === "terminal") return savedMode === "markdown";
    if (this.usesTranscriptFirstSession(session)) return this.settings.transcript_first_surface === "markdown";
    return !!this.settings.history_mode;
  }

  reconcileActiveSessionViewMode() {
    if (!this.activeId || this.activeFileKey !== null || !this.session(this.activeId)) return;
    const enabled = this.selectedHistoryMode();
    if (this.historyOpen !== enabled) this.setHistoryMode(enabled, { persist: false });
  }

  applyMainLayout() {
    const fileMode = this.activeFileKey !== null;
    if (!fileMode && this.fileHistoryOpen) this.closeFileHistory();
    const historyMode = this.historyOpen && !fileMode;
    const transcriptFirstMode = historyMode && this.usesTranscriptFirstSession();
    this.$("editor-area").classList.toggle("hidden", !fileMode);
    this.$("history-area").classList.toggle("hidden", !historyMode);
    this.$("history-area").classList.toggle("transcript-first", transcriptFirstMode);
    this.$("terminal-area").classList.toggle("hidden", fileMode || historyMode);
    this.$("conversation-outline").classList.toggle("hidden", fileMode || !this.conversationOutlineOpen);
    this.$("conversation-outline-toggle").classList.toggle("on", !fileMode && this.conversationOutlineOpen);
    for (const id of ["history-btn", "vscode-history-btn"]) {
      const historyButton = this.$(id);
      if (!historyButton) continue;
      historyButton.classList.toggle("on", historyMode);
      const openTerminal = transcriptFirstMode && historyMode;
      const label = openTerminal ? "Open terminal" : "Open Markdown transcript";
      historyButton.title = label;
      historyButton.setAttribute("aria-label", label);
      const icon = historyButton.querySelector(".codicon");
      if (icon) icon.className = `codicon codicon-${openTerminal ? "terminal" : "markdown"}`;
    }
    for (const id of ["history-edits-toggle", "history-scroll-bottom"]) {
      const button = this.$(id);
      if (button) button.classList.toggle("hidden", !historyMode);
    }
    this.updateShortcutTitles();
    this.$("attach-btn").classList.toggle("hidden", fileMode);
    this.$("reveal-session-btn").classList.toggle("hidden", fileMode);
    const attachButton = this.$("attach-btn");
    if (attachButton) {
      const label = historyMode ? "Upload file/image into Markdown prompt" : "Attach file/image to terminal";
      attachButton.title = label;
      attachButton.setAttribute("aria-label", label);
    }
    for (const id of ["terminal-resync-btn"]) {
      const button = this.$(id);
      if (button) button.classList.toggle("hidden", fileMode);
    }
    const terminalScrollButton = this.$("scroll-bottom-btn");
    if (terminalScrollButton) {
      terminalScrollButton.classList.toggle("hidden", historyMode || fileMode);
    }
    this.$("history-btn").classList.toggle("hidden", fileMode);
    this.renderHistoryMeta();
    this.updateHistoryThinkingIndicator();
    this.renderHistoryQueue();
    this.fitActive();
    this.renderInlineSizeControls();
  }

  updateHistoryThinkingIndicator() {
    const indicator = this.$("history-thinking-banner");
    const processing = !!this.processingStates.get(this.activeId);
    const awaitingProcessing = this.historyPendingProcessing.has(this.activeId);
    const spinning = !!this.historyOpen && (processing || awaitingProcessing);
    if (indicator) indicator.classList.toggle("hidden", !spinning);
    const duration = this.$("history-thinking-duration");
    if (duration) {
      const session = this.session(this.activeId);
      const sessionSince = Number(session?.processing_since);
      const since = processing
        ? (this.processingSince.get(this.activeId) || (sessionSince > 0 ? sessionSince * 1000 : 0))
        : this.historyPendingProcessing.get(this.activeId);
      const seconds = since ? Math.max(0, Math.floor((Date.now() - since) / 1000)) : 0;
      duration.textContent = spinning ? this.formatElapsed(seconds) : "";
    }
    if (spinning && !this.processingTimer) {
      this.processingTimer = setInterval(() => this.updateHistoryThinkingIndicator(), 1000);
    } else if (!spinning && this.processingTimer) {
      clearInterval(this.processingTimer);
      this.processingTimer = 0;
    }
    this.updateActiveThinkingBlock();
  }

  updateActiveThinkingBlock() {
    const body = this.$("history-body");
    if (!body) return;
    body.querySelectorAll(".history-event.thinking.active").forEach((event) => event.classList.remove("active"));
    if (!this.historyOpen || !this.processingStates.get(this.activeId)) return;
    const last = body.lastElementChild;
    if (last?.classList.contains("history-event") && last.classList.contains("thinking")) {
      last.classList.add("active");
    }
  }

  formatElapsed(seconds) {
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }

  renderHistoryQueue(view = this.views.get(this.activeId)) {
    const container = this.$("history-queued");
    const items = this.$("history-queued-items");
    const count = this.$("history-queued-count");
    if (!container || !items || !count) return;
    const queued = view?.promptQueue || [];
    const queueButton = this.$("history-queue-btn");
    if (queueButton) {
      queueButton.classList.toggle("on", queued.length > 0);
      const queueLabel = queued.length ? `Queue prompt (${queued.length} pending)` : "Queue prompt after the current task";
      queueButton.title = queueLabel;
      queueButton.setAttribute("aria-label", queueLabel);
    }
    container.classList.toggle("hidden", !this.historyOpen || !queued.length);
    count.textContent = queued.length ? `${queued.length} message${queued.length === 1 ? "" : "s"}` : "";
    const activeEditor = document.activeElement?.classList?.contains("history-queued-editor") ? document.activeElement : null;
    if (activeEditor && items.contains(activeEditor) && activeEditor.dataset.sessionId === view?.sessionId &&
        !view?.promptQueueDispatching) return;
    items.textContent = "";
    queued.forEach((item, index) => {
      const row = document.createElement("div");
      row.className = "history-queued-item";
      row.dataset.queueIndex = `${index}`;
      const number = document.createElement("span");
      number.className = "history-queued-index";
      number.textContent = `${index + 1}.`;
      const editor = document.createElement("textarea");
      editor.className = "history-queued-editor";
      editor.dataset.sessionId = view?.sessionId || "";
      editor.value = item.draftText ?? item.text;
      editor.rows = 1;
      editor.spellcheck = false;
      editor.setAttribute("aria-label", `Queued prompt ${index + 1}`);
      const resize = () => {
        editor.style.height = "auto";
        editor.style.height = `${Math.min(editor.scrollHeight, 120)}px`;
      };
      editor.addEventListener("focus", () => { if (view) view.promptQueueEditIndex = index; });
      editor.addEventListener("input", () => {
        const current = view?.promptQueue?.[index];
        if (!current) return;
        current.draftText = editor.value;
        this.persistMarkdownPromptQueue(view);
        resize();
      });
      editor.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          const current = view?.promptQueue?.[index];
          if (current) {
            delete current.draftText;
            editor.value = current.text;
            resize();
          }
          return;
        }
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          editor.blur();
        }
      });
      editor.addEventListener("blur", () => {
        const current = view?.promptQueue?.[index];
        if (!current) return;
        const next = editor.value;
        current.draftText = next;
        this.commitHistoryQueueEdit(view, index, next);
      });
      resize();
      const remove = document.createElement("button");
      remove.className = "history-queued-remove";
      remove.type = "button";
      remove.title = "Remove queued prompt";
      remove.setAttribute("aria-label", `Remove queued prompt ${index + 1}`);
      remove.textContent = "×";
      remove.addEventListener("mousedown", (event) => event.preventDefault());
      remove.addEventListener("click", () => this.removeHistoryQueueItem(view, index));
      row.append(number, editor, remove);
      items.appendChild(row);
    });
  }

  commitHistoryQueueEdit(view, index, text) {
    const item = view?.promptQueue?.[index];
    if (!item) return;
    const next = String(text || "");
    if (!next.trim()) view.promptQueue.splice(index, 1);
    else item.text = next;
    delete item.draftText;
    view.promptQueueEditIndex = null;
    this.persistMarkdownPromptQueue(view);
    this.renderHistoryQueue(view);
  }

  removeHistoryQueueItem(view, index) {
    if (!view?.promptQueue?.[index]) return;
    view.promptQueue.splice(index, 1);
    view.promptQueueEditIndex = null;
    this.persistMarkdownPromptQueue(view);
    this.renderHistoryQueue(view);
  }

  focusActiveEditor() {
    const view = this.views.get(this.activeId);
    if (this.activeFileKey !== null) {
      this.editor?.focus();
      return;
    }
    if (!view) return;
    if (this.historyOpen) {
      if (this.nativeVscodeMode) this.postVscodeNativeSession(this.session(this.activeId), false);
      this.showPromptDraft(view);
      this.$("history-prompt").focus();
    } else {
      if (this.nativeVscodeMode) {
        this.postVscodeNativeSession(this.session(this.activeId), true);
        return;
      }
      view.term.focus();
    }
  }

  refocusActiveInputAfterToolbarAction() {
    requestAnimationFrame(() => requestAnimationFrame(() => this.focusActiveEditor()));
  }

  scheduleActiveEditorFocus(sessionId) {
    clearTimeout(this.activeEditorFocusTimer);
    if (this.historyOpen) return;
    this.activeEditorFocusTimer = window.setTimeout(this.runScheduledActiveEditorFocus.bind(this, sessionId), 80);
  }

  runScheduledActiveEditorFocus(sessionId) {
    this.activeEditorFocusTimer = 0;
    if (sessionId !== this.activeId || this.historyOpen) return;
    this.focusActiveEditor();
  }

  closeHistory() {
    this.setHistoryMode(false);
  }

  async toggleHistory() {
    if (this.activeFileKey !== null) return;
    this.setHistoryMode(!this.historyOpen);
  }

  setHistoryMode(enabled, options = {}) {
    if (!this.activeId) return;
    if (this.historyOpen && !enabled) this.rememberHistoryScrollPosition(this.activeId);
    this.closeTerminalFind();
    this.hideSelectionActions(true);
    if (!enabled) this.closePromptHistory();
    const mode = enabled ? "markdown" : "terminal";
    if (options.persist !== false) {
      const sessionViewModes = { ...(this.getProjectState().session_view_modes || {}), [this.activeId]: mode };
      this.applyLocalProjectStatePatch({ session_view_modes: sessionViewModes });
      this.queueProjectResourceRequest(this.projectStateKey(),
        `/api/session-view-modes/${encodeURIComponent(this.activeId)}`, "PUT", { mode });
    }
    this.stopHistoryRefresh();
    this.disconnectHistoryStream();
    this.historyFingerprint = "";
    this.historyTurns = [];
    this.historyLoaded = false;
    this.historyOpen = !!enabled && this.activeFileKey === null && !!this.activeId;
    this.postVscodeNativeSession(this.session(this.activeId), !this.historyOpen);
    this.applyMainLayout();
    this.scheduleTerminalLayoutFit();
    if (this.historyOpen) {
      const sessionId = this.activeId;
      this.showPromptDraft(this.views.get(sessionId));
      const cached = this.historyTurnsBySession.get(sessionId);
      if (cached) this.applyHistoryTurns(sessionId, cached, { preserveScroll: false });
      this.connectHistoryStream(sessionId, { fresh: true });
    } else {
      const view = this.views.get(this.activeId);
      if (view) {
        if (this.nativeVscodeMode) this.postVscodeNativeSession(this.session(this.activeId), true);
        else view.term.focus();
      }
    }
  }

  startHistoryRefresh() {
    // Transcript updates arrive from the file watcher over the transcript
    // websocket. Kept as a no-op for callers from older saved UI state.
    this.stopHistoryRefresh();
  }

  stopHistoryRefresh() {
    if (this.historyRefreshTimer) clearInterval(this.historyRefreshTimer);
    this.historyRefreshTimer = 0;
  }

  disconnectHistoryStream() {
    this.cancelHistoryBackgroundLoad();
    clearTimeout(this.historyWsReconnectTimer);
    this.historyWsReconnectTimer = 0;
    const ws = this.historyWs;
    const sessionId = this.historyStreamSessionId;
    this.historyWs = null;
    this.historyStreamSessionId = null;
    if (sessionId) this.historySnapshotBuffers.delete(sessionId);
    if (ws) ws.close();
  }

  connectHistoryStream(sessionId, options = {}) {
    if (!sessionId || !this.historyOpen || this.activeFileKey !== null) return;
    this.disconnectHistoryStream();
    const fresh = options.fresh === true;
    this.historyStreamFresh = fresh;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws/transcript/${encodeURIComponent(sessionId)}`);
    this.historyWs = ws;
    this.historyStreamSessionId = sessionId;
    ws.onopen = () => {
      // A tab switch can carry a cached revision from before a fork/resume
      // changed the underlying rollout. Request the authoritative snapshot in
      // that case instead of treating inherited history as current.
      const revision = fresh ? 0 : (this.historyRevisions.get(sessionId) || 0);
      ws.send(JSON.stringify({ type: "transcript_subscribe", revision, fresh }));
    };
    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      try {
        const message = JSON.parse(event.data);
        if (message.session_id === sessionId) this.applyHistoryStreamMessage(sessionId, message);
      } catch (error) {
        console.warn("invalid transcript event", error);
      }
    };
    ws.onerror = () => {
      // The close event owns reconnects. Reconnecting here as well can leave
      // two sockets racing to update the same Markdown view after a transient
      // browser/network error.
    };
    ws.onclose = () => {
      if (this.historyWs !== ws) return;
      this.historyWs = null;
      this.historyStreamSessionId = null;
      if (!this.historyOpen || sessionId !== this.activeId) return;
      clearTimeout(this.historyWsReconnectTimer);
      this.historyWsReconnectTimer = setTimeout(() => this.connectHistoryStream(sessionId), RECONNECT_MS);
    };
  }

  applyHistoryStreamMessage(sessionId, message) {
    if (sessionId !== this.activeId || !this.historyOpen) return;
    const type = message.type;
    if (type === "transcript_snapshot_start") {
      this.historySnapshotBuffers.set(sessionId, { revision: Number(message.revision || 0), turns: [],
        before: message.before == null ? null : Number(message.before), hasMore: !!message.has_more });
      return;
    }
    if (type === "transcript_snapshot_chunk") {
      const buffer = this.historySnapshotBuffers.get(sessionId);
      if (!buffer || !Array.isArray(message.turns)) return;
      buffer.turns.push(...message.turns);
      return;
    }
    if (type === "transcript_snapshot_end") {
      const buffer = this.historySnapshotBuffers.get(sessionId);
      if (!buffer) return;
      this.historySnapshotBuffers.delete(sessionId);
      const turns = this.mergePendingHistoryPrompts(sessionId, buffer.turns);
      this.historyRevisions.set(sessionId, Number(message.revision || buffer.revision || 0));
      this.applyHistoryWindow(sessionId, turns, { before: buffer.before, hasMore: buffer.hasMore },
        { resetOlder: this.historyStreamFresh, preserveScroll: this.historyLoaded && this.historyTurns.length > 0 });
      return;
    }
    if (type === "transcript_snapshot") {
      const turns = this.mergePendingHistoryPrompts(sessionId, Array.isArray(message.turns) ? message.turns : []);
      this.historyRevisions.set(sessionId, Number(message.revision || 0));
      this.applyHistoryWindow(sessionId, turns, { before: message.before, hasMore: !!message.has_more },
        { resetOlder: this.historyStreamFresh, preserveScroll: this.historyLoaded && this.historyTurns.length > 0 });
      return;
    }
    if (type === "transcript_ready") {
      this.historyRevisions.set(sessionId, Number(message.revision || 0));
      return;
    }
    if (type !== "transcript_update") return;
    const revision = Number(message.revision || 0);
    if (revision <= (this.historyRevisions.get(sessionId) || 0)) return;
    const previous = this.historyTurnsBySession.get(sessionId) || [];
    const previousLive = this.historyLiveTurnsBySession.get(sessionId) || previous;
    if (message.windowed) {
      const liveTurns = this.mergePendingHistoryPrompts(sessionId, Array.isArray(message.turns) ? message.turns : []);
      this.historyLiveTurnsBySession.set(sessionId, liveTurns);
      const turns = this.combineHistoryWindow(sessionId, liveTurns);
      this.historyRevisions.set(sessionId, revision);
      this.applyHistoryTurns(sessionId, turns, { preserveScroll: true });
      return;
    }
    const replaceFrom = Number(message.replace_from);
    if (!Number.isInteger(replaceFrom) || replaceFrom < 0 || replaceFrom > previousLive.length) {
      this.connectHistoryStream(sessionId, { fresh: true });
      return;
    }
    const turns = this.mergePendingHistoryPrompts(
      sessionId,
      previousLive.slice(0, replaceFrom).concat(Array.isArray(message.turns) ? message.turns : []),
    );
    this.historyLiveTurnsBySession.set(sessionId, turns);
    const combined = this.combineHistoryWindow(sessionId, turns);
    this.historyTurnsBySession.set(sessionId, combined);
    this.historyRevisions.set(sessionId, revision);
    this.applyHistoryTurns(sessionId, combined, { preserveScroll: true });
  }

  combineHistoryWindow(sessionId, liveTurns) {
    const older = this.historyOlderTurnsBySession.get(sessionId) || [];
    return older.concat(liveTurns);
  }

  cancelHistoryBackgroundLoad() {
    clearTimeout(this.historyBackgroundLoadTimer);
    this.historyBackgroundLoadTimer = 0;
    this.historyBackgroundLoadSessionId = "";
  }

  scheduleHistoryBackgroundLoad(sessionId, delay = HISTORY_BACKGROUND_LOAD_DELAY_MS) {
    this.cancelHistoryBackgroundLoad();
    if (!sessionId || sessionId !== this.activeId || !this.historyOpen || this.activeFileKey !== null ||
        !this.historyHasMoreBySession.get(sessionId)) return;
    const loadedTurns = this.historyTurnsBySession.get(sessionId) || [];
    if (loadedTurns.length >= HISTORY_BACKGROUND_TARGET_TURNS) return;
    this.historyBackgroundLoadSessionId = sessionId;
    this.historyBackgroundLoadTimer = window.setTimeout(() => void this.continueHistoryBackgroundLoad(sessionId), delay);
  }

  async continueHistoryBackgroundLoad(sessionId) {
    this.historyBackgroundLoadTimer = 0;
    if (sessionId !== this.historyBackgroundLoadSessionId || sessionId !== this.activeId || !this.historyOpen ||
        this.activeFileKey !== null) return;
    if (this.historyOlderLoadBusy) {
      this.scheduleHistoryBackgroundLoad(sessionId);
      return;
    }
    const advanced = await this.loadOlderHistory({ sessionId, limit: HISTORY_BACKGROUND_PAGE_TURNS });
    if (advanced) this.scheduleHistoryBackgroundLoad(sessionId);
  }

  applyHistoryWindow(sessionId, liveTurns, metadata = {}, options = {}) {
    if (options.resetOlder) {
      this.historyOlderTurnsBySession.set(sessionId, []);
    }
    const live = Array.isArray(liveTurns) ? liveTurns : [];
    this.historyLiveTurnsBySession.set(sessionId, live);
    this.historyBeforeBySession.set(sessionId, metadata.before == null ? null : Number(metadata.before));
    this.historyHasMoreBySession.set(sessionId, !!metadata.hasMore);
    const turns = this.combineHistoryWindow(sessionId, live);
    this.applyHistoryTurns(sessionId, turns, { preserveScroll: options.preserveScroll === true });
    this.scheduleHistoryBackgroundLoad(sessionId);
  }

  async loadOlderHistory(options = {}) {
    if (this.historyOlderLoadBusy || !this.historyOpen || !this.activeId || this.activeFileKey !== null) return false;
    const sessionId = String(options.sessionId || this.activeId);
    if (sessionId !== this.activeId) return false;
    if (!this.historyHasMoreBySession.get(sessionId)) return false;
    const before = this.historyBeforeBySession.get(sessionId);
    if (before == null) return false;
    this.historyOlderLoadBusy = true;
    const body = this.$("history-body");
    const previousHeight = body.scrollHeight;
    try {
      const requestedLimit = Math.max(20, Math.min(HISTORY_BACKGROUND_PAGE_TURNS, Number(options.limit) || HISTORY_BACKGROUND_PAGE_TURNS));
      const params = new URLSearchParams({ before: String(before), limit: String(requestedLimit) });
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/history-page?${params}`);
      if (!response.ok) throw new Error(`history page failed: ${response.status}`);
      const page = await response.json();
      if (sessionId !== this.activeId || !this.historyOpen || this.activeFileKey !== null) return false;
      if (page.reset) {
        this.historyOlderTurnsBySession.set(sessionId, []);
        this.historyBeforeBySession.set(sessionId, null);
        this.historyHasMoreBySession.set(sessionId, false);
        this.connectHistoryStream(sessionId, { fresh: true });
        return false;
      }
      const olderPage = Array.isArray(page.turns) ? page.turns : [];
      const existingOlder = this.historyOlderTurnsBySession.get(sessionId) || [];
      this.historyOlderTurnsBySession.set(sessionId, olderPage.concat(existingOlder));
      const nextBefore = page.before == null ? null : Number(page.before);
      this.historyBeforeBySession.set(sessionId, nextBefore);
      this.historyHasMoreBySession.set(sessionId, !!page.has_more);
      const live = this.historyLiveTurnsBySession.get(sessionId) || [];
      const combined = this.combineHistoryWindow(sessionId, live);
      this.historyTurnsBySession.set(sessionId, combined);
      this.historyTurns = combined;
      const empty = body.querySelector(".history-empty");
      if (empty) empty.remove();
      if (olderPage.length) {
        const scratch = document.createElement("div");
        this.renderHistoryTurns(olderPage, { target: scratch, preserveExpanded: true });
        while (scratch.firstChild) body.insertBefore(scratch.firstChild, body.firstChild);
        await new Promise((resolve) => requestAnimationFrame(() => {
          body.scrollTop += body.scrollHeight - previousHeight;
          resolve();
        }));
      }
      return olderPage.length > 0 || nextBefore !== before;
    } catch (error) {
      console.warn("unable to load older transcript history", error);
      return false;
    } finally {
      this.historyOlderLoadBusy = false;
    }
  }

  mergePendingHistoryPrompts(sessionId, turns) {
    const pending = this.historyPendingPrompts.get(sessionId) || [];
    if (!pending.length) return turns;
    const merged = turns.slice();
    const remaining = [];
    for (const item of pending) {
      const pendingId = item.pending_id || `${Date.now()}-${this.historyPendingPromptSequence++}`;
      item.pending_id = pendingId;
      const comparisonText = this.historyPromptComparisonText(item.text);
      const authoritativeCount = merged.filter((turn) => turn.role === "user" && !turn.pending_id &&
        this.historyPromptComparisonText(turn.text) === comparisonText).length;
      const optimisticIndex = merged.findIndex((turn) => turn.pending_id === pendingId);
      if (authoritativeCount > item.beforeCount) {
        if (optimisticIndex >= 0) merged.splice(optimisticIndex, 1);
        continue;
      }
      if (optimisticIndex < 0) merged.push({ role: "user", text: item.text, pending_id: pendingId });
      remaining.push(item);
    }
    if (remaining.length) this.historyPendingPrompts.set(sessionId, remaining);
    else this.historyPendingPrompts.delete(sessionId);
    return merged;
  }

  historyPromptComparisonText(text) {
    return String(text || "").replace(/\r\n?/g, "\n").trim();
  }

  sendHistoryPrompt(options = {}) {
    if (!this.historyOpen || this.activeFileKey !== null || !this.activeId) return;
    const prompt = this.$("history-prompt");
    const rawText = prompt.value;
    const text = rawText;
    if (!text.trim()) return;
    const view = this.views.get(this.activeId);
    if (!view) return;
    if (options.queue) {
      view.promptQueue.push({ text });
      this.persistMarkdownPromptQueue(view);
      this.renderHistoryQueue(view);
      this.recordPromptHistory(view.sessionId, text);
      this.persistMarkdownPromptDraft(view, "");
      this.showPromptDraft(view);
      prompt.focus();
      this.$("status-name").textContent = "prompt queued";
      this.dispatchNextMarkdownPrompt(view);
      return;
    }
    if (!view.ws || view.ws.readyState !== WebSocket.OPEN) {
      this.$("status-name").textContent = "terminal is still connecting…";
      return;
    }
    this.submitHistoryPromptText(view, text);
  }

  submitHistoryPromptText(view, text, options = {}) {
    if (!view || !view.ws || view.ws.readyState !== WebSocket.OPEN || !String(text || "").trim()) return false;
    const promptText = String(text);
    const prompt = this.$("history-prompt");
    view.promptSubmitting = true;
    view.promptSubmitEntered = false;
    view.promptEditing = false;
    view.promptSubmitVersion = view.promptEditVersion;
    const bracketed = !view.term.modes || view.term.modes.bracketedPasteMode !== false;
    const sessionId = view.sessionId;
    if (this.session(sessionId)?.agent_kind === "codex") this.deferTerminalReflowAfterPrompt(view);
    this.historyPendingProcessing.set(sessionId, Date.now());
    this.updateHistoryThinkingIndicator();
    if (this.historyOpen && this.activeId === sessionId) {
      const turns = this.historyTurnsBySession.get(sessionId) || this.historyTurns;
      const pending = this.historyPendingPrompts.get(sessionId) || [];
      const live = this.historyLiveTurnsBySession.get(sessionId) || turns;
      const comparisonText = this.historyPromptComparisonText(promptText);
      const authoritativeCount = live.filter((turn) => turn.role === "user" && !turn.pending_id &&
        this.historyPromptComparisonText(turn.text) === comparisonText).length;
      const beforeCount = authoritativeCount + pending.filter((item) =>
        this.historyPromptComparisonText(item.text) === comparisonText).length;
      const pendingId = `${Date.now()}-${this.historyPendingPromptSequence++}`;
      pending.push({ text: promptText, beforeCount, pending_id: pendingId });
      this.historyPendingPrompts.set(sessionId, pending);
      const optimisticLive = this.mergePendingHistoryPrompts(sessionId, live);
      this.historyLiveTurnsBySession.set(sessionId, optimisticLive);
      const optimisticTurns = this.combineHistoryWindow(sessionId, optimisticLive);
      this.applyHistoryTurns(sessionId, optimisticTurns, { preserveScroll: true });
    }
    // Submitting from TermDeck's own composer never touches the terminal's key handler (it goes straight
    // out over the websocket), so it needs to resume following on its own -- sending a prompt is an
    // unambiguous request to watch what comes back.
    view.tallFollowing = true;
    this.scrollTallContainerToCursor(view);
    try {
      view.ws.send(JSON.stringify({ type: "submit", text: promptText, bracketed, queue: false }));
    } catch (error) {
      this.historyPendingProcessing.delete(sessionId);
      this.updateHistoryThinkingIndicator();
      view.promptSubmitting = false;
      this.$("status-name").textContent = "unable to send prompt";
      console.warn("unable to send Markdown prompt", error);
      return false;
    }
    if (!options.fromQueue) this.recordPromptHistory(sessionId, promptText);
    if (!options.fromQueue) this.persistMarkdownPromptDraft(view, "");
    if (this.historyOpen && this.activeId === sessionId) {
      this.showPromptDraft(view);
      prompt.focus();
    }
    clearTimeout(view.promptSubmitTimer);
    view.promptSubmitTimer = setTimeout(() => {
      view.promptSubmitting = false;
      view.promptSubmitEntered = false;
    }, 1500);
    view.keepBottom = true;
    view.pinBottomUntil = Date.now() + 5000;
    this.$("status-name").textContent = options.fromQueue ? "queued prompt sent" : "prompt sent";
    return true;
  }

  recordPromptHistory(sessionId, text) {
    const prompt = String(text || "").trim();
    if (!prompt) return;
    const history = this.settings.prompt_history && typeof this.settings.prompt_history === "object"
      ? this.settings.prompt_history : {};
    const previous = Array.isArray(history[sessionId]) ? history[sessionId] : [];
    const next = [prompt, ...previous.filter((item) => item !== prompt)].slice(0, 50);
    this.settings.prompt_history = { ...history, [sessionId]: next };
    this.saveSettings();
    if (!this.$("history-prompt-history").classList.contains("hidden")) this.renderPromptHistory();
  }

  renderPromptHistory() {
    const items = this.$("history-prompt-history-items");
    if (!items) return;
    items.textContent = "";
    const entries = Array.isArray(this.settings.prompt_history?.[this.activeId])
      ? this.settings.prompt_history[this.activeId] : [];
    if (!entries.length) {
      const empty = document.createElement("div");
      empty.className = "history-prompt-history-empty";
      empty.textContent = "No prompts sent yet.";
      items.appendChild(empty);
      return;
    }
    for (const text of entries) {
      const entry = document.createElement("button");
      entry.type = "button";
      entry.className = "history-prompt-history-item";
      entry.textContent = text;
      entry.title = text;
      entry.onclick = () => this.restorePromptHistoryEntry(text);
      items.appendChild(entry);
    }
  }

  togglePromptHistory() {
    const panel = this.$("history-prompt-history");
    const button = this.$("history-prompt-history-btn");
    if (!panel || !button || !this.historyOpen || this.activeFileKey !== null) return;
    const opening = panel.classList.contains("hidden");
    if (opening) this.renderPromptHistory();
    panel.classList.toggle("hidden", !opening);
    button.classList.toggle("on", opening);
    button.setAttribute("aria-expanded", String(opening));
  }

  closePromptHistory() {
    const panel = this.$("history-prompt-history");
    const button = this.$("history-prompt-history-btn");
    if (!panel || !button) return;
    panel.classList.add("hidden");
    button.classList.remove("on");
    button.setAttribute("aria-expanded", "false");
  }

  restorePromptHistoryEntry(text) {
    const view = this.views.get(this.activeId);
    const prompt = this.$("history-prompt");
    if (!view || !prompt || !this.historyOpen || this.activeFileKey !== null) return;
    prompt.value = text;
    prompt.dispatchEvent(new Event("input", { bubbles: true }));
    this.closePromptHistory();
    prompt.focus();
    prompt.setSelectionRange(prompt.value.length, prompt.value.length);
  }

  resizeHistoryPrompt() {
    const prompt = this.$("history-prompt");
    if (!prompt) return;
    prompt.style.height = "auto";
    const height = Math.min(prompt.scrollHeight, 150);
    prompt.style.height = `${height}px`;
    prompt.style.overflowY = prompt.scrollHeight > height ? "auto" : "hidden";
  }

  showPromptDraft(view) {
    if (!this.historyOpen || view !== this.views.get(this.activeId)) return;
    const prompt = this.$("history-prompt");
    if (!prompt) return;
    prompt.value = view.markdownPromptDraft || "";
    this.resizeHistoryPrompt();
    requestAnimationFrame(() => {
      if (prompt.value !== (view.markdownPromptDraft || "")) return;
      this.resizeHistoryPrompt();
      requestAnimationFrame(() => {
        if (prompt.value === (view.markdownPromptDraft || "")) this.resizeHistoryPrompt();
      });
    });
  }

  syncPromptToTerminal(view, options = {}) {
    const text = view.promptDraft || "";
    const writeToTerminal = options.writeToTerminal !== false;
    if (!view.ws || view.ws.readyState !== WebSocket.OPEN) {
      if (writeToTerminal) view.pendingTerminalDraft = text;
      else view.pendingTerminalDraft = null;
      view.pendingDraftSync = text;
      return;
    }
    if (!writeToTerminal) view.pendingTerminalDraft = null;
    if (writeToTerminal) this.writePromptDraftToTerminal(view, text);
    this.sendPromptDraftSync(view, text);
  }

  writePromptDraftToTerminal(view, text) {
    this.sendInput(view, "\x15");
    if (text) this.sendInput(view, text.includes("\n") ? this.terminalPastePayload(view, text) : text);
  }

  sendPromptDraftSync(view, text) {
    clearTimeout(view.promptDraftSyncDebounceTimer);
    view.promptDraftSyncDebounceTimer = 0;
    if (!view.ws || view.ws.readyState !== WebSocket.OPEN) {
      view.pendingDraftSync = text;
      return;
    }
    view.pendingDraftSync = null;
    view.promptDraftSyncPending = true;
    clearTimeout(view.promptDraftSyncTimer);
    view.promptDraftSyncTimer = setTimeout(() => {
      view.promptDraftSyncPending = false;
      view.promptDraftSyncTimer = 0;
    }, 3000);
    view.ws.send(JSON.stringify({ type: "draft_sync", draft: text }));
  }

  schedulePromptDraftSync(view, text) {
    view.pendingDraftSync = text;
    clearTimeout(view.promptDraftSyncDebounceTimer);
    view.promptDraftSyncDebounceTimer = setTimeout(() => {
      view.promptDraftSyncDebounceTimer = 0;
      this.sendPromptDraftSync(view, view.promptDraft);
    }, PROMPT_DRAFT_SYNC_PASTE_DELAY_MS);
  }

  deferTerminalReflowAfterPrompt(view) {
    if (!view || this.session(view.sessionId)?.agent_kind !== "codex") return;
    view.promptSubmissionReflowGuardUntil = Date.now() + CODEX_PROMPT_REFLOW_GUARD_MS;
    clearTimeout(view.promptSubmissionReflowGuardTimer);
    view.promptSubmissionReflowGuardTimer = setTimeout(() => {
      view.promptSubmissionReflowGuardTimer = 0;
      if (!view.closed && view.container.classList.contains("visible") && this.activeId === view.sessionId) {
        this.scheduleTerminalTailRepair(view);
      }
    }, CODEX_PROMPT_REFLOW_GUARD_MS + 40);
  }

  shouldDeferPromptReflowFit(view) {
    if (!view) return false;
    return view.promptSubmissionReflowGuardUntil > Date.now();
  }

  isPastedTerminalInput(data) {
    const input = String(data || "");
    return input.includes("\x1b[200~") || input.includes("\x1b[201~") || input.length >= 128;
  }

  terminalPastePayload(view, text) {
    const agentKind = this.session(view.sessionId)?.agent_kind;
    const agentTerminal = agentKind === "codex" || agentKind === "claude" || agentKind === "agy";
    const bracketed = agentTerminal || !view.term.modes || view.term.modes.bracketedPasteMode !== false;
    return bracketed ? `\x1b[200~${text}\x1b[201~` : text;
  }

  flushPromptSync(view) {
    if (!view.ws || view.ws.readyState !== WebSocket.OPEN || view.promptSubmitting) return;
    if (view.pendingTerminalDraft !== null) {
      const text = view.pendingTerminalDraft;
      view.pendingTerminalDraft = null;
      this.writePromptDraftToTerminal(view, text);
    }
    if (view.pendingDraftSync !== null) this.sendPromptDraftSync(view, view.pendingDraftSync);
  }

  schedulePendingAgentPaste(view, delay = 0) {
    if (!view || view.closed || !view.pendingAgentPaste) return;
    if (!view.pendingAgentPasteStartedAt) view.pendingAgentPasteStartedAt = Date.now();
    clearTimeout(view.pendingAgentPasteTimer);
    const readyDelay = Math.max(0, (view.pendingAgentPasteReadyAt || 0) - Date.now());
    const wait = Math.max(Number(delay) || 0, readyDelay);
    view.pendingAgentPasteTimer = window.setTimeout(() => {
      view.pendingAgentPasteTimer = 0;
      if (view.closed || !view.pendingAgentPaste) return;
      if (Date.now() - view.pendingAgentPasteStartedAt >= AGENT_PASTE_TIMEOUT_MS) {
        view.pendingAgentPaste = "";
        view.pendingAgentPasteStartedAt = 0;
        view.pendingAgentPasteReadyAt = 0;
        this.$("status-name").textContent = "selected text could not be pasted into the agent";
        return;
      }
      if (view.awaitingSnapshot || view.replaying || !view.ws || view.ws.readyState !== WebSocket.OPEN ||
          Date.now() < (view.pendingAgentPasteReadyAt || 0)) {
        this.schedulePendingAgentPaste(view, AGENT_PASTE_RETRY_DELAY_MS);
        return;
      }
      this.flushPendingAgentPaste(view);
    }, wait);
  }

  queuePendingAgentPaste(view, text) {
    const value = this.normalizeSelectionText(text);
    if (!view || view.closed || !value) return false;
    view.pendingAgentPaste = value;
    view.pendingAgentPasteStartedAt = Date.now();
    view.pendingAgentPasteReadyAt = Date.now() + (this.session(view.sessionId)?.agent_kind === "claude"
      ? CLAUDE_AGENT_PASTE_DELAY_MS : DEFAULT_AGENT_PASTE_DELAY_MS);
    this.schedulePendingAgentPaste(view);
    return true;
  }

  flushPendingAgentPaste(view) {
    if (!view || view.closed || !view.pendingAgentPaste || view.awaitingSnapshot || view.replaying ||
        !view.ws || view.ws.readyState !== WebSocket.OPEN || Date.now() < (view.pendingAgentPasteReadyAt || 0)) return false;
    const text = view.pendingAgentPaste;
    view.pendingAgentPaste = "";
    view.pendingAgentPasteStartedAt = 0;
    view.pendingAgentPasteReadyAt = 0;
    if (this.activeId === view.sessionId && this.activeFileKey === null && !this.historyOpen) view.term.focus();
    this.sendTrackedInput(view, this.terminalPastePayload(view, text));
    this.$("status-name").textContent = "selected text pasted into " +
      (TERMINAL_ICON_AGENT_LABELS[this.session(view.sessionId)?.agent_kind] || "agent");
    return true;
  }

  sendTrackedInput(view, data) {
    const pastedInput = this.isPastedTerminalInput(data);
    const session = this.session(view.sessionId);
    const submittedText = (data === "\r" || data === "\n") && session && session.agent_kind !== "none"
      ? view.promptDraft.trim() : "";
    const queueText = data === "\t" && this.session(view.sessionId)?.agent_kind === "codex" && view.promptDraft.trim()
      ? view.promptDraft
      : "";
    view.promptSubmitEntered = false;
    view.promptSubmitting = false;
    clearTimeout(view.promptSubmitTimer);
    view.promptEditing = false;
    const previousDraft = view.promptDraft;
    this.updatePromptDraftFromTerminal(view, data);
    if (view.promptDraft !== previousDraft) view.promptEditVersion += 1;
    if (view.promptDraft !== previousDraft) {
      clearTimeout(view.promptDraftSyncTimer);
      if (pastedInput) this.schedulePromptDraftSync(view, view.promptDraft);
      else {
        view.promptDraftSyncPending = true;
        view.promptDraftSyncTimer = setTimeout(() => {
          view.promptDraftSyncPending = false;
          view.promptDraftSyncTimer = 0;
        }, 3000);
      }
    }
    if ((data === "\r" || data === "\n") && session?.agent_kind === "codex") {
      this.deferTerminalReflowAfterPrompt(view);
    }
    this.sendInput(view, data);
    if (submittedText && view.ws && view.ws.readyState === WebSocket.OPEN) this.recordPromptHistory(view.sessionId, submittedText);
    if (view.promptDraft !== previousDraft && !pastedInput) this.sendPromptDraftSync(view, view.promptDraft);
    if (queueText) {
      view.promptDraft = "";
      view.promptEditing = false;
      view.pendingTerminalDraft = null;
      view.pendingDraftSync = null;
      if (view.ws && view.ws.readyState === WebSocket.OPEN) this.recordPromptHistory(view.sessionId, queueText);
      this.sendPromptDraftSync(view, "");
      this.showPromptDraft(view);
    }
  }

  updatePromptDraftFromTerminal(view, data) {
    let stream = (view.promptEscape || "") + data;
    view.promptEscape = "";
    let i = 0;
    while (i < stream.length) {
      if (stream.startsWith("\x1b[200~", i)) { view.promptPaste = true; i += 6; continue; }
      if (stream.startsWith("\x1b[201~", i)) { view.promptPaste = false; i += 6; continue; }
      const ch = stream[i];
      if (ch === "\x1b") {
        if (i + 1 >= stream.length) { view.promptEscape = stream.slice(i); break; }
        if (stream[i + 1] === "\r") { view.promptDraft += "\n"; i += 2; continue; }
        if (stream[i + 1] === "\x7f") { view.promptDraft = view.promptDraft.replace(/\S+\s*$/, ""); i += 2; continue; }
        if (stream[i + 1] === "[") {
          let end = i + 2;
          while (end < stream.length && (stream.charCodeAt(end) < 0x40 || stream.charCodeAt(end) > 0x7e)) end += 1;
          if (end >= stream.length) { view.promptEscape = stream.slice(i); break; }
          i = end + 1;
          continue;
        }
        i += 2;
        continue;
      }
      if (ch === "\r" || ch === "\n") {
        if (view.promptPaste) view.promptDraft += "\n";
        else view.promptDraft = "";
      } else if (ch === "\x7f") {
        view.promptDraft = view.promptDraft.slice(0, -1);
      } else if (ch === "\x15") {
        view.promptDraft = view.promptDraft.replace(/[^\n]*$/, "");
      } else if (ch === "\x17") {
        view.promptDraft = view.promptDraft.replace(/\s+$/, "").replace(/\S+$/, "");
      } else if (ch >= " ") {
        // Append the whole run of plain characters at once, not one at a time: this used to be
        // promptDraft += ch per character, which is an O(n^2) blowup for a large pasted string (each
        // += copies the entire accumulated draft again) -- long enough to freeze the tab for several
        // seconds on a big multiline paste, reported as "hangs" and "not editable".
        let end = i + 1;
        while (end < stream.length) {
          const next = stream[end];
          if (next < " " || next === "\x7f") break;
          end += 1;
        }
        view.promptDraft += stream.slice(i, end);
        i = end;
        continue;
      }
      i += 1;
    }
    this.showPromptDraft(view);
  }

  historyTurnKey(turn) {
    return JSON.stringify([turn.role, turn.kind, turn.title, turn.text, turn.diff, turn.diff_files, turn.plan, turn.items]);
  }

  toggleHistoryEdits() {
    this.historyEditsCollapsed = !this.historyEditsCollapsed;
    for (const event of this.$("history-body").querySelectorAll(".history-event.edit")) {
      event.open = !this.historyEditsCollapsed;
    }
    this.updateHistoryEditToggle();
    if (body === this.$("history-body")) this.updateActiveThinkingBlock();
  }

  updateHistoryEditToggle() {
    const button = this.$("history-edits-toggle");
    if (!button) return;
    const hasEdits = !!this.$("history-body").querySelector(".history-event.edit");
    button.disabled = !hasEdits;
    button.classList.toggle("on", this.historyEditsCollapsed && hasEdits);
    const label = this.historyEditsCollapsed ? "Expand all code edits" : "Collapse all code edits";
    button.title = label;
    button.setAttribute("aria-label", label);
    const icon = button.querySelector(".codicon");
    if (icon) icon.className = `codicon codicon-${this.historyEditsCollapsed ? "expand-all" : "collapse-all"}`;
  }

  historyEditSummary(turn) {
    const files = [];
    const addFile = (value) => {
      const file = String(value || "").trim().replace(/^['"]|['"]$/g, "");
      if (file && !files.includes(file)) files.push(file);
    };
    if (Array.isArray(turn.diff_files)) {
      for (const file of turn.diff_files) addFile(file?.path);
    }
    if (!files.length) {
      const text = String(turn.text || "");
      for (const match of text.matchAll(/\*\*\* (?:Update|Add|Delete) File:\s*([^\\\r\n]+?)(?=(?:\\n|\r?\n)|$)/g)) addFile(match[1]);
      for (const match of text.matchAll(/(?:file_path|fileName|filename)\s*["']?\s*:\s*["']([^"']+)["']/gi)) addFile(match[1]);
    }
    const additions = Array.isArray(turn.diff) ? turn.diff.filter((line) => line.kind === "add").length : 0;
    const removals = Array.isArray(turn.diff) ? turn.diff.filter((line) => line.kind === "remove").length : 0;
    const fileSummary = files.length ? `${files.length} file${files.length === 1 ? "" : "s"}` : "file details unavailable";
    return `${fileSummary} · +${additions} / −${removals} lines`;
  }

  historyDiffPath(path) {
    const value = String(path || "Changes").replaceAll("\\", "/");
    const cwd = String(this.session(this.activeId)?.cwd || "").replace(/[\\/]$/, "");
    if (cwd && (value === cwd || value.startsWith(`${cwd}/`))) return value.slice(cwd.length + 1) || value;
    return value;
  }

  renderHistoryDiffLines(lines, target) {
    for (const line of lines || []) {
      const row = document.createElement("div");
      row.className = "diff-line " + (line.kind || "context");
      const prefix = document.createElement("span");
      prefix.className = "diff-line-prefix";
      prefix.textContent = line.prefix || " ";
      const content = document.createElement("span");
      content.className = "diff-line-text";
      content.textContent = line.text || "";
      row.append(prefix, content);
      target.appendChild(row);
    }
  }

  collapseHistoryThinkingEvent(event) {
    if (!event?.matches?.(".history-event.thinking")) return;
    event.open = false;
    const summary = event.querySelector("summary");
    requestAnimationFrame(() => {
      if (summary) summary.scrollIntoView({ block: "nearest" });
    });
  }

  renderHistoryTurns(turns, options = {}) {
    const body = options.target || this.$("history-body");
    const append = options.append === true;
    const preserveExpanded = options.preserveExpanded === true;
    const previousExpanded = preserveExpanded ? [...body.querySelectorAll("details")].map((item) => item.open) : [];
    let eventIndex = 0;
    for (const turn of turns) {
      if (turn.kind && turn.kind !== "message") {
        const event = document.createElement("details");
        event.className = "history-event " + turn.kind;
        event.open = turn.kind === "edit" ? !this.historyEditsCollapsed : turn.kind === "plan" ? true : turn.expanded === true;
        if (!this.historyEditsCollapsed && preserveExpanded && previousExpanded[eventIndex] !== undefined) event.open = previousExpanded[eventIndex];
        eventIndex += 1;
        const summary = document.createElement("summary");
        if (turn.kind === "thinking" && Array.isArray(turn.items)) {
          const thinkingTitle = document.createElement("span");
          thinkingTitle.className = "history-thinking-title";
          thinkingTitle.textContent = "Thinking";
          const thinkingCount = document.createElement("span");
          thinkingCount.className = "history-thinking-count";
          thinkingCount.textContent = ` · ${turn.items.length} operations`;
          summary.append(thinkingTitle, thinkingCount);
        } else {
          summary.textContent = turn.kind === "edit"
              ? this.historyEditSummary(turn)
              : turn.kind === "plan" && Array.isArray(turn.plan)
              ? `Plan · ${turn.plan.length} steps`
              : (turn.title || turn.kind);
        }
        if (turn.kind === "thinking" && Array.isArray(turn.items) && turn.items.length) {
          const results = document.createElement("div");
          results.className = "history-thinking";
          for (const item of turn.items) {
            const label = document.createElement("div");
            label.className = "history-thinking-label";
            label.textContent = item.kind === "result" ? "Result" : (item.title || "Tool");
            const result = document.createElement("pre");
            result.textContent = item.text || "";
            results.append(label, result);
          }
          const footer = document.createElement("div");
          footer.className = "history-thinking-footer";
          const collapse = document.createElement("button");
          collapse.type = "button";
          collapse.className = "history-thinking-collapse";
          collapse.title = "Collapse this thinking block";
          collapse.innerHTML = '<span class="codicon codicon-collapse-all"></span><span>Collapse thinking</span>';
          collapse.onclick = (eventClick) => {
            eventClick.preventDefault();
            eventClick.stopPropagation();
            this.collapseHistoryThinkingEvent(event);
          };
          footer.appendChild(collapse);
          results.appendChild(footer);
          event.append(summary, results);
        } else if (Array.isArray(turn.plan) && turn.plan.length) {
          const list = document.createElement("ul");
          list.className = "history-plan";
          for (const item of turn.plan) {
            const status = String(item.status || "pending").toLowerCase().replace(/[^a-z0-9_-]/g, "-");
            const step = document.createElement("li");
            step.className = "plan-step " + status;
            const marker = document.createElement("span");
            marker.className = "plan-marker";
            marker.textContent = status === "completed" || status === "complete" ? "✓" : status === "in_progress" ? "●" : "○";
            const label = document.createElement("span");
            label.textContent = item.step || item.content || "";
            step.append(marker, label);
            list.appendChild(step);
          }
          event.append(summary, list);
        } else if (Array.isArray(turn.diff) && turn.diff.length) {
          const diff = document.createElement("div");
          diff.className = "history-diff";
          const files = Array.isArray(turn.diff_files) && turn.diff_files.length
            ? turn.diff_files
            : [{ path: "Changes", diff: turn.diff }];
          for (const file of files) {
            const section = document.createElement("section");
            section.className = "history-diff-file";
            const heading = document.createElement("div");
            heading.className = "history-diff-file-heading";
            const additions = (file.diff || []).filter((line) => line.kind === "add").length;
            const removals = (file.diff || []).filter((line) => line.kind === "remove").length;
            heading.textContent = `${this.historyDiffPath(file.path)} · +${additions} / −${removals}`;
            const body = document.createElement("div");
            body.className = "history-diff-file-body";
            this.renderHistoryDiffLines(file.diff, body);
            section.append(heading, body);
            diff.appendChild(section);
          }
          event.append(summary, diff);
        } else {
          const content = document.createElement("pre");
          content.textContent = turn.text || "";
          event.append(summary, content);
        }
        body.appendChild(event);
        continue;
      }
      const block = document.createElement("div");
      block.className = "turn " + turn.role;
      block.dataset.outlineKey = this.conversationOutlineTurnKey(turn);
      const text = document.createElement("div");
      text.className = "turn-text markdown";
      text.innerHTML = this.renderMarkdown(turn.text);
      this.linkHistoryFileReferences(text);
      if (["user", "assistant"].includes(turn.role)) {
        const role = document.createElement("div");
        role.className = "turn-role";
        role.textContent = turn.role === "user" ? "You" : "Assistant";
        block.append(role);
      }
      block.append(text);
      body.appendChild(block);
    }
    this.updateHistoryEditToggle();
  }

  captureHistoryScroll(body, turns = this.historyTurns) {
    const snapshot = {
      top: body.scrollTop,
      atBottom: body.scrollHeight - body.clientHeight - body.scrollTop < 80,
      anchorIndex: -1,
      anchorKey: "",
      anchorOccurrence: 0,
      anchorOffset: 0,
    };
    const bodyTop = body.getBoundingClientRect().top;
    const children = [...body.children];
    for (let index = 0; index < children.length; index += 1) {
      if (children[index].getBoundingClientRect().bottom > bodyTop + 1) {
        snapshot.anchorIndex = index;
        snapshot.anchorOffset = children[index].getBoundingClientRect().top - bodyTop;
        break;
      }
    }
    if (snapshot.anchorIndex < 0 && children.length) {
      snapshot.anchorIndex = children.length - 1;
      snapshot.anchorOffset = children[snapshot.anchorIndex].getBoundingClientRect().top - bodyTop;
    }
    if (snapshot.anchorIndex >= 0 && turns[snapshot.anchorIndex]) {
      snapshot.anchorKey = this.historyTurnKey(turns[snapshot.anchorIndex]);
      snapshot.anchorOccurrence = turns.slice(0, snapshot.anchorIndex + 1)
        .filter((turn) => this.historyTurnKey(turn) === snapshot.anchorKey).length - 1;
    }
    return snapshot;
  }

  rememberHistoryScrollPosition(sessionId) {
    const body = this.$("history-body");
    if (!sessionId || !body || !this.historyOpen || !this.historyLoaded || this.activeFileKey !== null) return;
    this.historyScrollBySession.set(sessionId, this.captureHistoryScroll(body, this.historyTurns));
  }

  restoreHistoryScroll(body, snapshot, turns = this.historyTurns, settling = false) {
    if (!snapshot) {
      body.scrollTop = body.scrollHeight;
      return;
    }
    if (snapshot.atBottom) {
      body.scrollTop = body.scrollHeight;
      return;
    }
    let anchorIndex = snapshot.anchorIndex;
    if (snapshot.anchorKey && Array.isArray(turns)) {
      let occurrence = 0;
      anchorIndex = turns.findIndex((turn) => {
        if (this.historyTurnKey(turn) !== snapshot.anchorKey) return false;
        return occurrence++ === snapshot.anchorOccurrence;
      });
    }
    const anchor = anchorIndex >= 0 ? body.children[anchorIndex] : null;
    if (anchor) {
      const bodyTop = body.getBoundingClientRect().top;
      const currentOffset = anchor.getBoundingClientRect().top - bodyTop;
      body.scrollTop += currentOffset - snapshot.anchorOffset;
    } else {
      body.scrollTop = snapshot.top;
    }
    body.scrollTop = Math.min(body.scrollTop, Math.max(0, body.scrollHeight - body.clientHeight));
    // A live update can reflow Markdown one frame after the DOM replacement.
    // Reapply the same anchor after layout, without changing the user's
    // intentional position when they are reading above the newest output.
    if (!settling && !snapshot.atBottom) {
      requestAnimationFrame(() => {
        if (this.historyOpen && body === this.$("history-body")) {
          this.restoreHistoryScroll(body, snapshot, turns, true);
        }
      });
    }
  }

  async loadHistory(sessionId, options = {}) {
    const body = this.$("history-body");
    const preserveScroll = options.preserveScroll === true;
    if (this.historyLoadBusy) return;
    this.historyLoadBusy = true;
    if (!this.historyLoaded) {
      body.textContent = "";
      const loading = document.createElement("div");
      loading.className = "history-empty";
      loading.textContent = "loading transcript…";
      body.appendChild(loading);
    }
    let turns;
    try {
      const res = await fetch(`/api/sessions/${sessionId}/history`);
      if (!res.ok) throw new Error(`history request failed: ${res.status}`);
      turns = await res.json();
    } catch (err) {
      this.historyLoadBusy = false;
      if (!this.historyLoaded) {
        body.textContent = "";
        const error = document.createElement("div");
        error.className = "history-empty";
        error.textContent = "unable to load transcript";
        body.appendChild(error);
      }
      return;
    }
    this.historyLoadBusy = false;
    return this.applyHistoryTurns(sessionId, this.mergePendingHistoryPrompts(sessionId, turns), options);
  }

  applyHistoryTurns(sessionId, turns, options = {}) {
    const body = this.$("history-body");
    const preserveScroll = options.preserveScroll === true;
    if (sessionId !== this.activeId || !this.historyOpen) return;
    this.cacheSessionModelFromHistory(sessionId, turns);
    // Capture this after the request completes so scrolling while the refresh
    // is in flight is never overwritten by an older scroll position.
    const scrollSnapshot = preserveScroll
      ? this.captureHistoryScroll(body, this.historyTurns)
      : (this.historyScrollBySession.get(sessionId) || null);
    const fingerprint = `${turns.length}|${JSON.stringify(turns.slice(-3).map((turn) => [turn.role, turn.kind, turn.text, turn.diff?.length, turn.diff_files, turn.plan, turn.items]))}`;
    if (preserveScroll && fingerprint === this.historyFingerprint) return;
    let commonPrefix = 0;
    if (preserveScroll && this.historyLoaded) {
      while (commonPrefix < this.historyTurns.length && commonPrefix < turns.length &&
        this.historyTurnKey(this.historyTurns[commonPrefix]) === this.historyTurnKey(turns[commonPrefix])) commonPrefix += 1;
    }
    const canAppend = preserveScroll && this.historyLoaded && this.historyTurns.length > 0 &&
      commonPrefix === this.historyTurns.length && turns.length >= this.historyTurns.length;
    const canPatchTail = preserveScroll && this.historyLoaded && this.historyTurns.length > 0 &&
      commonPrefix === this.historyTurns.length - 1 && turns.length >= this.historyTurns.length;
    this.historyFingerprint = fingerprint;
    this.historyLoaded = true;
    const s = this.sessionOrClosed(sessionId);
    this.$("history-title").textContent = s ? this.effectiveTitle(s) : "";
    this.renderHistoryModel(s, turns);
    if (canPatchTail) {
      // Keep the unchanged transcript nodes in place so browser-find selection
      // and the user's reading position survive live output updates.
      const existing = body.children[this.historyTurns.length - 1];
      const scratch = document.createElement("div");
      this.renderHistoryTurns([turns[this.historyTurns.length - 1]], { target: scratch });
      const replacement = scratch.firstElementChild;
      if (existing && replacement) {
        const wasOpen = existing.matches("details") ? existing.open : false;
        if (existing.tagName === replacement.tagName && existing.className === replacement.className) {
          existing.replaceChildren(...replacement.childNodes);
          if (existing.matches("details")) existing.open = wasOpen;
        } else {
          if (replacement.matches("details")) replacement.open = wasOpen;
          existing.replaceWith(replacement);
        }
      }
      if (turns.length > this.historyTurns.length) {
        this.renderHistoryTurns(turns.slice(this.historyTurns.length), { target: body });
      }
    } else if (!canAppend) {
      body.textContent = "";
      if (!turns.length) {
        const empty = document.createElement("div");
        empty.className = "history-empty";
        empty.textContent = s && s.agent_kind !== "none"
          ? "no transcript found yet (send a message first, or the session id isn't resolved)"
          : "transcript history is only available for claude/codex/agy terminals";
        body.appendChild(empty);
      } else {
        this.renderHistoryTurns(turns, { preserveExpanded: preserveScroll });
      }
    } else {
      this.renderHistoryTurns(turns.slice(this.historyTurns.length), { append: true });
    }
    this.historyTurns = turns;
    this.historyTurnsBySession.set(sessionId, turns);
    this.renderHistoryMeta();
    this.updateHistoryEditToggle();
    this.updateActiveThinkingBlock();
    this.restoreHistoryScroll(body, scrollSnapshot, turns);
    this.schedulePendingHistorySearchReveal();
  }

  renderMarkdown(text) {
    if (window.marked) {
      return marked.parse(text, { breaks: true, gfm: true });
    }
    const escaped = document.createElement("div");
    escaped.textContent = text;
    return escaped.innerHTML;
  }

  linkHistoryFileReferences(container) {
    for (const anchor of container.querySelectorAll("a")) {
      const linkText = anchor.getAttribute("href") || "";
      if (this.parseVscodeFileLink(linkText)) {
        anchor.dataset.terminalFile = linkText;
        anchor.classList.add("history-file-link");
        anchor.title = `Open ${linkText}`;
        continue;
      }
      let url;
      try {
        url = new URL(linkText, location.href);
      } catch (_error) {
        continue;
      }
      if (!["http:", "https:", "mailto:"].includes(url.protocol)) continue;
      anchor.classList.add("history-external-link");
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.title = `Open ${linkText}`;
    }
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.parentElement?.closest("a")) textNodes.push(node);
    }
    for (const node of textNodes) {
      const source = node.nodeValue || "";
      const matches = [...source.matchAll(new RegExp(PATH_LINK_RE.source, "g"))].filter((match) => {
        const raw = match[0];
        const extension = raw.split(":")[0].split(".").pop().toLowerCase();
        return raw.includes("/") || KNOWN_EXTS.has(extension);
      });
      if (!matches.length) continue;
      const fragment = document.createDocumentFragment();
      let offset = 0;
      for (const match of matches) {
        fragment.appendChild(document.createTextNode(source.slice(offset, match.index)));
        const anchor = document.createElement("a");
        anchor.className = "history-file-link";
        anchor.href = match[0];
        anchor.dataset.terminalFile = match[0];
        anchor.title = `Open ${match[0]}`;
        anchor.textContent = match[0];
        fragment.appendChild(anchor);
        offset = match.index + match[0].length;
      }
      fragment.appendChild(document.createTextNode(source.slice(offset)));
      node.replaceWith(fragment);
    }
  }

  initNotebook() {
    const toggle = this.$("notebook-toggle");
    const panel = this.$("notebook-panel");
    const host = this.$("notebook-editor-host");
    if (!toggle || !panel || !host) return;
    this.normalizeNotebookNotes();
    toggle.onclick = () => this.toggleNotebook();
    this.$("notebook-new").onclick = () => { void this.createNotebookNote(); };
    this.$("notebook-find").onclick = () => this.openNotebookFind();
    this.$("notebook-find-close").onclick = () => this.closeNotebookFind(true);
    this.$("notebook-find-prev").onclick = () => this.stepNotebookSearch(-1);
    this.$("notebook-find-next").onclick = () => this.stepNotebookSearch(1);
    this.$("notebook-replace-toggle").onclick = () => this.toggleNotebookReplace();
    this.$("notebook-replace-one").onclick = () => { void this.replaceNotebookSearchMatch(false); };
    this.$("notebook-replace-all").onclick = () => { void this.replaceNotebookSearchMatch(true); };
    this.$("notebook-find-query").addEventListener("input", () => this.updateNotebookSearchState(true));
    this.$("notebook-find-query").addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); this.closeNotebookFind(true); return; }
      if (event.key === "Enter") { event.preventDefault(); this.stepNotebookSearch(event.shiftKey ? -1 : 1); }
    });
    this.$("notebook-replace-query").addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); this.closeNotebookFind(true); return; }
      if (event.key === "Enter") { event.preventDefault(); void this.replaceNotebookSearchMatch(event.metaKey); }
    });
    window.addEventListener("keydown", (event) => {
      if (!this.settings.notebook_open || !event.target.closest?.("#notebook-panel") ||
          !event.metaKey || event.ctrlKey || event.shiftKey || event.key.toLowerCase() !== "f") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.openNotebookFind(event.altKey);
    }, true);
    this.$("notebook-close").onclick = () => {
      this.setNotebookOpen(false);
    };
    const notebookResizer = this.$("notebook-resizer");
    notebookResizer.onpointerdown = this.startNotebookResize.bind(this);
    notebookResizer.onpointermove = this.resizeNotebookFromPointer.bind(this);
    notebookResizer.onpointerup = this.finishNotebookResize.bind(this);
    notebookResizer.onpointercancel = this.finishNotebookResize.bind(this);
    panel.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (!this.$("notebook-find-bar").classList.contains("hidden")) {
        this.closeNotebookFind(true);
        return;
      }
      this.setNotebookOpen(false);
    });
    if (!this.notebookEditor) {
      host.textContent = "";
      const fallback = document.createElement("textarea");
      fallback.className = "notes-area";
      fallback.placeholder = "Quick notes…";
      fallback.value = this.activeNotebookNote()?.text || "";
      fallback.addEventListener("input", () => this.setActiveNotebookText(fallback.value));
      host.appendChild(fallback);
    }
    this.renderNotebook();
    void this.mountNotebookEditor();
  }

  initSelectionActions() {
    const actions = this.$("selection-actions");
    if (!actions) return;
    this.$("selection-copy").onclick = () => this.copySelectionToClipboard();
    this.$("selection-note-new").onclick = () => { void this.createNotebookNoteFromSelection(); };
    this.$("selection-note-append").onclick = () => { void this.appendSelectionToNotebook(); };
    this.$("selection-search-content").onclick = () => this.searchContentFromSelection();
    this.$("selection-search-file").onclick = () => this.searchFileFromSelection();
    this.$("selection-copy-history-panel").addEventListener("keydown", (event) => {
      if (!actions.classList.contains("history-picker")) return;
      const items = [...this.$("selection-copy-history-panel").querySelectorAll(".selection-copy-history-item")];
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.closeSelectionCopyHistoryPicker();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        if (!items.length) return;
        actions.classList.add("keyboard-nav");
        const direction = event.key === "ArrowDown" ? 1 : -1;
        this.selectionCopyHistoryIndex = (this.selectionCopyHistoryIndex + direction + items.length) % items.length;
        this.focusSelectionCopyHistoryItem();
        return;
      }
      if (event.key === "Enter" && !event.isComposing) {
        const item = event.target.closest?.(".selection-copy-history-item");
        if (!item) return;
        event.preventDefault();
        event.stopPropagation();
        this.insertSelectionCopyHistory(item.dataset.copyText || "", true);
      }
    });
    this.$("selection-copy-history-panel").addEventListener("pointermove", (event) => {
      if (event.target.closest?.(".selection-copy-history-item")) actions.classList.remove("keyboard-nav");
    });
    actions.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    actions.addEventListener("click", (event) => event.stopPropagation());
    document.addEventListener("contextmenu", (event) => {
      const source = event.target.closest?.(".xterm, #history-body, #monaco-host, #notebook-editor-host");
      if (!source) return;
      const state = this.readSelectionActionState(event.target);
      event.preventDefault();
      event.stopPropagation();
      const contextKind = source.matches(".xterm") ? "terminal" : source.id === "history-body" ? "history"
        : source.id === "monaco-host" ? "file" : "notebook";
      this.openSelectionContextMenu(state, { x: event.clientX, y: event.clientY }, contextKind);
    });
    document.addEventListener("selectionchange", () => this.scheduleSelectionActions());
    document.addEventListener("mouseup", () => this.scheduleSelectionActions());
    document.addEventListener("copy", () => this.recordDocumentSelectionCopy());
    window.addEventListener("resize", () => this.scheduleSelectionActions());
    window.addEventListener("scroll", () => this.scheduleSelectionActions(), true);
  }

  initIdeFeatures() {
    if (this.vscodeMode) return;
    const quickBackdrop = this.$("quick-open-backdrop");
    const quickInput = this.$("quick-open-input");
    quickBackdrop.addEventListener("mousedown", (event) => {
      if (event.target === quickBackdrop) this.closeQuickOpen();
    });
    quickInput.addEventListener("input", () => {
      clearTimeout(this.quickOpenTimer);
      this.quickOpenTimer = setTimeout(() => void this.renderQuickOpen(quickInput.value), 140);
    });
    quickInput.addEventListener("keydown", (event) => this.handleQuickOpenKey(event));
    // Null-safe: #file-outline-toggle is not in index.html yet. This sits mid-way through
    // initIdeFeatures, so the throw skipped every listener wired after it, not just this one.
    const fileOutlineToggle = this.$("file-outline-toggle");
    if (fileOutlineToggle) fileOutlineToggle.onclick = () => this.toggleFileInspector("outline");
    this.$("file-inspector-close").onclick = () => this.closeFileInspector();
    this.$("file-inspector-refresh").onclick = () => this.refreshFileInspector();
    this.$("file-split-toggle").onclick = () => this.toggleSplitEditor();
    this.$("secondary-editor-close").onclick = () => this.closeSplitEditor();
    this.$("secondary-diff-toggle").onclick = () => this.toggleSecondaryDiff();
    this.$("secondary-file-select").onchange = (event) => {
      this.secondaryFileKey = event.target.value || null;
      void this.renderSecondaryEditor(true);
    };
    this.$("file-tabs-more").onclick = (event) => this.openFileTabsMenu(event.currentTarget);
    this.$("problems-toggle").onclick = () => this.toggleProblemsPanel();
    this.$("problems-close").onclick = () => this.setProblemsOpen(false);
    this.$("problems-refresh").onclick = () => this.refreshProblems();
    this.$("conversation-outline-toggle").onclick = () => this.toggleConversationOutline();
    this.$("conversation-outline-close").onclick = () => this.setConversationOutlineOpen(false);
    this.$("conversation-outline-refresh").onclick = () => void this.loadConversationOutline(true);
    document.addEventListener("pointerdown", (event) => {
      if (!this.conversationOutlineOpen) return;
      if (this.$("conversation-outline").contains(event.target) || this.$("conversation-outline-toggle").contains(event.target)) return;
      this.setConversationOutlineOpen(false);
    });
  }

  openQuickOpen(initialQuery = "") {
    if (this.vscodeMode) return;
    this.quickOpenMode = "all";
    this.showQuickOpen(initialQuery);
  }

  openRecentTerminalsQuickOpen() {
    if (this.vscodeMode) return;
    const backdrop = this.$("quick-open-backdrop");
    if (!backdrop.classList.contains("hidden") && this.quickOpenMode === "recent-terminals") {
      const recentIndexes = this.quickOpenResults.map((result, index) => result.kind === "Recently opened terminals" ? index : -1)
        .filter((index) => index >= 0);
      if (!recentIndexes.length) return;
      const currentIndex = recentIndexes.indexOf(this.quickOpenSelection);
      this.quickOpenSelection = recentIndexes[(currentIndex + 1 + recentIndexes.length) % recentIndexes.length];
      this.updateQuickOpenSelection();
      return;
    }
    this.quickOpenMode = "recent-terminals";
    this.showQuickOpen("");
  }

  showQuickOpen(initialQuery) {
    const backdrop = this.$("quick-open-backdrop");
    const input = this.$("quick-open-input");
    backdrop.classList.remove("hidden");
    input.value = initialQuery;
    this.quickOpenSelection = 0;
    void this.renderQuickOpen(initialQuery);
    requestAnimationFrame(() => { input.focus(); input.select(); });
  }

  closeQuickOpen() {
    clearTimeout(this.quickOpenTimer);
    this.$("quick-open-backdrop").classList.add("hidden");
    this.quickOpenMode = "all";
    requestAnimationFrame(() => this.focusActiveEditor());
  }

  handleQuickOpenKey(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.closeQuickOpen();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      if (!this.quickOpenResults.length) return;
      const direction = event.key === "ArrowDown" ? 1 : -1;
      this.quickOpenSelection = (this.quickOpenSelection + direction + this.quickOpenResults.length) % this.quickOpenResults.length;
      this.updateQuickOpenSelection();
      return;
    }
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      const result = this.quickOpenResults[this.quickOpenSelection];
      if (!result) return;
      this.closeQuickOpen();
      result.run();
    }
  }

  quickOpenTextMatches(query, ...values) {
    const terms = String(query || "").toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return true;
    const text = values.filter(Boolean).join(" ").toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  }

  quickOpenCommands() {
    return [
      { title: "New terminal", icon: "add", run: () => this.openModal() },
      { title: "Show Problems", icon: "warning", run: () => this.setProblemsOpen(true) },
      { title: "Show file Outline", icon: "symbol-class", run: () => this.toggleFileInspector("outline", true) },
      { title: "Split active editor", icon: "split-horizontal", run: () => this.toggleSplitEditor(true) },
      { title: "Reveal active file in tree", icon: "target", run: () => void this.revealActiveFile() },
      { title: "Open Markdown transcript", icon: "markdown", run: () => this.setHistoryMode(true) },
      { title: "Open Quick Notes", icon: "notebook", run: () => this.setNotebookOpen(true) },
    ];
  }

  recentlyOpenedTerminalSessions() {
    const sessionsById = new Map(this.sessions.map((session) => [session.session_id, session]));
    const ordered = [];
    const seen = new Set();
    for (const sessionId of this.getProjectState().recently_opened_terminal_ids || []) {
      const session = sessionsById.get(sessionId);
      if (!session || seen.has(session.session_id)) continue;
      seen.add(session.session_id);
      ordered.push(session);
    }
    for (const session of this.sessions) {
      if (seen.has(session.session_id)) continue;
      seen.add(session.session_id);
      ordered.push(session);
    }
    return ordered;
  }

  quickOpenTerminalResult(session, kind) {
    const title = this.titlePresentation(session).text;
    return { kind, title, detail: session.cwd, icon: "terminal",
      run: () => this.activate(session.session_id, { reveal: true }) };
  }

  async renderQuickOpen(rawQuery) {
    const generation = ++this.quickOpenGeneration;
    const query = String(rawQuery || "").trim();
    const commandOnly = query.startsWith(">");
    const symbolOnly = query.startsWith("@");
    const searchQuery = query.replace(/^[>@]/, "").trim();
    const results = [];
    const recentOnly = this.quickOpenMode === "recent-terminals";
    if (!symbolOnly && !recentOnly) {
      for (const command of this.quickOpenCommands()) {
        if (!this.quickOpenTextMatches(searchQuery, command.title)) continue;
        results.push({ kind: "Commands", title: command.title, detail: "command", icon: command.icon, run: command.run });
      }
    }
    if (!commandOnly && !symbolOnly) {
      const terminalSessions = this.recentlyOpenedTerminalSessions();
      const recentSessionIds = new Set(this.getProjectState().recently_opened_terminal_ids || []);
      for (const session of terminalSessions) {
        if (!this.quickOpenTextMatches(searchQuery, this.titlePresentation(session).text, session.cwd)) continue;
        const kind = recentSessionIds.has(session.session_id) ? "Recently opened terminals" : "Terminals";
        if (recentOnly && kind === "Terminals" && recentSessionIds.size) continue;
        results.push(this.quickOpenTerminalResult(session, kind));
      }
      for (const [key, entry] of this.openFiles) {
        if (!this.quickOpenTextMatches(searchQuery, entry.name, entry.path)) continue;
        results.push({ kind: "Open files", title: entry.name, detail: entry.path, icon: "file-code", run: () => void this.activateFile(key, null) });
      }
      for (const file of this.settings.recent_closed_files || []) {
        if (!file?.root || !file?.path || !this.quickOpenTextMatches(searchQuery, file.path)) continue;
        results.push({ kind: "Recently closed", title: file.path.split("/").pop(), detail: file.path, icon: "history",
          run: () => void this.openFile(file.root, file.path, null, null, { pinned: true }) });
      }
    }
    if (symbolOnly && this.activeFileKey !== null) {
      for (const symbol of this.activeFileOutlineSymbols()) {
        if (!this.quickOpenTextMatches(searchQuery, symbol.name, symbol.kind)) continue;
        results.push({ kind: "Symbols", title: symbol.name, detail: `${symbol.kind} · line ${symbol.line}`, icon: symbol.icon,
          run: () => this.revealEditorLine(symbol.line) });
      }
      if (searchQuery && this.lspClient?.transport.available) {
        try {
          const workspaceSymbols = await this.lspClient.workspaceSymbols(searchQuery);
          if (generation !== this.quickOpenGeneration) return;
          for (const symbol of workspaceSymbols) {
            results.push({ kind: "Workspace symbols", title: symbol.name,
              detail: symbol.containerName || monaco.Uri.parse(symbol.location.uri).path,
              icon: "symbol-method", run: () => void this.lspClient.openLocation(symbol.location) });
          }
        } catch (error) {
          this.$("stat-text").textContent = error.message || "workspace symbol search failed";
        }
      }
    }
    this.paintQuickOpenResults(results);
    if (!commandOnly && !symbolOnly && searchQuery) {
      const root = this.searchRoot();
      const params = new URLSearchParams({ root, q: searchQuery, glob: this.fileGlobForMode("search"),
        ignore: this.searchIgnoreTokens(), include_hidden: String(this.includeHiddenFilesInSearch()), case_sensitive: "false" });
      const response = await fetch(`/api/files/find?${params}`);
      if (generation !== this.quickOpenGeneration || !response.ok) return;
      const files = (await response.json()).filter((item) => !item.is_dir).slice(0, 80);
      const existing = new Set(results.filter((result) => result.kind === "Open files").map((result) => result.detail));
      for (const file of files) {
        if (existing.has(file.path)) continue;
        results.push({ kind: "Files", title: file.path.split("/").pop(), detail: file.path, icon: "file-code",
          run: () => void this.openFile(root, file.path, null, null, { pinned: true }) });
      }
      this.paintQuickOpenResults(results);
    }
  }

  paintQuickOpenResults(results) {
    this.quickOpenResults = results.slice(0, 120);
    this.quickOpenSelection = Math.min(this.quickOpenSelection, Math.max(0, this.quickOpenResults.length - 1));
    const container = this.$("quick-open-results");
    container.textContent = "";
    let lastKind = "";
    for (const [index, result] of this.quickOpenResults.entries()) {
      if (result.kind !== lastKind) {
        const group = document.createElement("div");
        group.className = "quick-open-group";
        group.textContent = result.kind;
        container.appendChild(group);
        lastKind = result.kind;
      }
      const row = document.createElement("button");
      row.type = "button";
      row.className = `quick-open-item${index === this.quickOpenSelection ? " selected" : ""}`;
      row.dataset.index = String(index);
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(index === this.quickOpenSelection));
      const icon = document.createElement("span");
      icon.className = `codicon codicon-${result.icon}`;
      const title = document.createElement("span");
      title.className = "quick-open-item-title";
      title.textContent = result.title;
      const detail = document.createElement("span");
      detail.className = "quick-open-item-detail";
      detail.textContent = result.detail || "";
      row.append(icon, title, detail);
      row.onmouseenter = () => { this.quickOpenSelection = index; this.updateQuickOpenSelection(false); };
      row.onclick = () => { this.closeQuickOpen(); result.run(); };
      container.appendChild(row);
    }
    if (!this.quickOpenResults.length) {
      const empty = document.createElement("div");
      empty.className = "file-inspector-empty";
      empty.textContent = "No matching files, terminals, symbols, or commands.";
      container.appendChild(empty);
    }
  }

  updateQuickOpenSelection(scroll = true) {
    for (const row of this.$("quick-open-results").querySelectorAll(".quick-open-item")) {
      const selected = Number(row.dataset.index) === this.quickOpenSelection;
      row.classList.toggle("selected", selected);
      row.setAttribute("aria-selected", String(selected));
      if (selected && scroll) row.scrollIntoView({ block: "nearest" });
    }
  }

  renderFileEditorChrome() {
    if (this.vscodeMode) return;
    this.renderFileTabs();
    this.renderFileBreadcrumbs();
    this.renderSecondaryFileSelect();
    if (this.fileInspectorMode === "outline") this.renderFileOutline();
    if (this.problemsOpen) this.scheduleProblemsRefresh();
  }

  renderFileTabs() {
    const container = this.$("file-tabs");
    if (!container) return;
    container.textContent = "";
    for (const [key, entry] of this.openFiles) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = `file-editor-tab${key === this.activeFileKey ? " active" : ""}${entry.preview ? " preview" : ""}`;
      tab.title = entry.fullPath || `${entry.root}/${entry.path}`;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(key === this.activeFileKey));
      const name = document.createElement("span");
      name.className = "file-editor-tab-name";
      name.textContent = entry.name;
      tab.appendChild(name);
      if (entry.dirty || entry.savePromise) {
        const dirty = document.createElement("span");
        dirty.className = "file-editor-tab-dirty";
        dirty.title = "Unsaved changes";
        tab.appendChild(dirty);
      }
      const pin = document.createElement("span");
      pin.className = `file-editor-tab-pin codicon codicon-${entry.preview ? "pin" : "pinned"}`;
      pin.title = entry.preview ? "Pin file" : "Unpin to preview";
      pin.onclick = (event) => { event.stopPropagation(); this.setFilePreview(key, !entry.preview); };
      const close = document.createElement("span");
      close.className = "file-editor-tab-close codicon codicon-close";
      close.title = "Close file";
      close.onclick = (event) => { event.stopPropagation(); void this.closeFile(key); };
      tab.append(pin, close);
      tab.onclick = () => void this.activateFile(key, null, { history: false });
      tab.ondblclick = () => this.setFilePreview(key, false);
      container.appendChild(tab);
    }
    requestAnimationFrame(() => container.querySelector(".file-editor-tab.active")?.scrollIntoView({ inline: "nearest" }));
  }

  setFilePreview(key, preview) {
    const entry = this.openFiles.get(key);
    if (!entry) return;
    entry.preview = !!preview && !entry.dirty;
    this.persistOpenFiles();
    this.renderFileEditorChrome();
  }

  openFileTabsMenu(anchor) {
    const menu = this.$("context-menu");
    menu.textContent = "";
    menu.classList.remove("hidden");
    if (this.activeFileKey !== null) {
      this.addContextItem(menu, "Close other files", () => void this.closeOtherFiles(this.activeFileKey), "close-all");
      this.addContextItem(menu, "Close all files", () => void this.closeFiles([...this.openFiles.keys()]), "close-all");
    }
    const recentlyClosed = (this.settings.recent_closed_files || [])[0];
    this.addContextItem(menu, recentlyClosed ? `Reopen ${recentlyClosed.path.split("/").pop()}` : "No recently closed files",
      recentlyClosed ? () => void this.openFile(recentlyClosed.root, recentlyClosed.path, null, null, { pinned: true }) : null,
      "history");
    const rect = anchor.getBoundingClientRect();
    this.positionContextMenu(menu, rect.right, rect.bottom + 4);
  }

  async closeOtherFiles(keepKey) {
    await this.closeFiles([...this.openFiles.keys()].filter((key) => key !== keepKey));
  }

  renderFileBreadcrumbs() {
    const container = this.$("file-breadcrumbs");
    if (!container) return;
    container.textContent = "";
    const entry = this.activeFileKey !== null ? this.openFiles.get(this.activeFileKey) : null;
    if (!entry) return;
    const project = this.projectForCwd(entry.root);
    const parts = entry.path.split("/").filter(Boolean);
    const labels = [project?.name || entry.root.split("/").filter(Boolean).pop() || entry.root, ...parts];
    for (const [index, label] of labels.entries()) {
      const crumb = document.createElement("button");
      crumb.type = "button";
      crumb.className = "file-breadcrumb";
      crumb.textContent = label;
      if (index < labels.length - 1) crumb.onclick = () => void this.revealActiveFile();
      container.appendChild(crumb);
    }
  }

  toggleFileInspector(mode, forceOpen = false) {
    if (this.activeFileKey === null) return;
    if (!forceOpen && this.fileInspectorMode === mode) {
      this.closeFileInspector();
      return;
    }
    this.fileInspectorMode = mode;
    this.$("file-inspector").classList.remove("hidden");
    this.$("file-outline-toggle").classList.toggle("on", mode === "outline");
    this.refreshFileInspector();
  }

  closeFileInspector() {
    this.fileInspectorMode = null;
    this.$("file-inspector").classList.add("hidden");
    this.$("file-outline-toggle").classList.remove("on");
    this.editor?.layout();
  }

  refreshFileInspector() {
    if (this.fileInspectorMode === "outline") this.renderFileOutline();
  }

  activeFileOutlineSymbols() {
    const model = this.editor?.getModel();
    if (!model) return [];
    const symbols = [];
    const extension = String(this.openFiles.get(this.activeFileKey)?.name || "").split(".").pop().toLocaleLowerCase();
    for (let line = 1; line <= model.getLineCount(); line += 1) {
      const text = model.getLineContent(line);
      let match = null;
      let kind = "symbol", icon = "symbol-variable";
      if (["py", "pyi"].includes(extension)) {
        match = /^\s*(?:async\s+)?(class|def)\s+([A-Za-z_]\w*)/.exec(text);
        if (match) { kind = match[1] === "class" ? "class" : "function"; icon = match[1] === "class" ? "symbol-class" : "symbol-method"; }
      } else if (["js", "jsx", "ts", "tsx", "mjs", "cjs", "java", "kt", "go", "rs"].includes(extension)) {
        match = /^\s*(?:export\s+)?(?:public\s+|private\s+|protected\s+)?(?:async\s+)?(class|interface|function|fn|func|const|let|var)\s+([A-Za-z_$]\w*)/.exec(text);
        if (match) { kind = match[1]; icon = ["class", "interface"].includes(kind) ? "symbol-class" : ["function", "fn", "func"].includes(kind) ? "symbol-method" : "symbol-variable"; }
      } else if (["md", "mdx"].includes(extension)) {
        match = /^(#{1,6})\s+(.+?)\s*$/.exec(text);
        if (match) { kind = `heading ${match[1].length}`; icon = "symbol-string"; }
      }
      if (!match) continue;
      symbols.push({ name: match[2], kind, icon, line });
    }
    return symbols;
  }

  renderFileOutline() {
    if (this.fileInspectorMode !== "outline") return;
    this.$("file-inspector-title").textContent = "Outline";
    const body = this.$("file-inspector-body");
    body.textContent = "";
    const symbols = this.activeFileOutlineSymbols();
    for (const symbol of symbols) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "file-inspector-row";
      const icon = document.createElement("span");
      icon.className = `codicon codicon-${symbol.icon}`;
      const name = document.createElement("span");
      name.className = "file-inspector-row-name";
      name.textContent = symbol.name;
      const meta = document.createElement("span");
      meta.className = "file-inspector-row-meta";
      meta.textContent = symbol.line;
      row.append(icon, name, meta);
      row.onclick = () => this.revealEditorLine(symbol.line);
      body.appendChild(row);
    }
    if (!symbols.length) {
      const empty = document.createElement("div");
      empty.className = "file-inspector-empty";
      empty.textContent = "No symbols found in the active file.";
      body.appendChild(empty);
    }
  }

  revealEditorLine(line, column = 1) {
    if (!this.editor) return;
    this.editor.setPosition({ lineNumber: line, column });
    this.editor.revealLineInCenter(line);
    this.editor.focus();
  }

  toggleSplitEditor(forceOpen = false) {
    if (this.activeFileKey === null || !this.editor) return;
    if (!forceOpen && !this.$("secondary-editor-pane").classList.contains("hidden")) {
      this.closeSplitEditor();
      return;
    }
    this.$("editor-area").classList.add("split-open");
    this.$("secondary-editor-pane").classList.remove("hidden");
    this.$("file-split-toggle").classList.add("on");
    if (!this.secondaryFileKey || !this.openFiles.has(this.secondaryFileKey)) {
      this.secondaryFileKey = [...this.openFiles.keys()].find((key) => key !== this.activeFileKey) || this.activeFileKey;
    }
    this.renderSecondaryFileSelect();
    void this.renderSecondaryEditor(true);
    this.editor.layout();
  }

  closeSplitEditor() {
    this.secondaryEditor?.dispose();
    this.secondaryDiffEditor?.dispose();
    this.secondaryEditor = null;
    this.secondaryDiffEditor = null;
    this.$("secondary-editor-host").textContent = "";
    this.$("secondary-editor-pane").classList.add("hidden");
    this.$("editor-area").classList.remove("split-open");
    this.$("file-split-toggle").classList.remove("on");
    this.$("secondary-diff-toggle").classList.remove("on");
    this.editor?.layout();
  }

  renderSecondaryFileSelect() {
    const select = this.$("secondary-file-select");
    if (!select) return;
    const previous = this.secondaryFileKey;
    select.textContent = "";
    for (const [key, entry] of this.openFiles) {
      const option = document.createElement("option");
      option.value = key;
      option.textContent = entry.path;
      select.appendChild(option);
    }
    if (previous && this.openFiles.has(previous)) select.value = previous;
  }

  toggleSecondaryDiff() {
    if (this.$("secondary-editor-pane").classList.contains("hidden")) return;
    this.$("secondary-diff-toggle").classList.toggle("on");
    void this.renderSecondaryEditor(true);
  }

  async renderSecondaryEditor(force = false) {
    if (!this.editor || this.$("secondary-editor-pane").classList.contains("hidden")) return;
    const secondaryEntry = this.secondaryFileKey ? this.openFiles.get(this.secondaryFileKey) : null;
    const activeEntry = this.activeFileKey !== null ? this.openFiles.get(this.activeFileKey) : null;
    if (!secondaryEntry || !activeEntry) return;
    if (!activeEntry.model) await this.refreshFileModelFromDisk(activeEntry);
    if (!secondaryEntry.model) await this.refreshFileModelFromDisk(secondaryEntry);
    if (!secondaryEntry.model || !activeEntry.model || this.$("secondary-editor-pane").classList.contains("hidden")) return;
    const diff = this.$("secondary-diff-toggle").classList.contains("on");
    const signature = `${this.activeFileKey}|${this.secondaryFileKey}|${diff}`;
    if (!force && this.secondaryEditorSignature === signature) return;
    this.secondaryEditorSignature = signature;
    this.secondaryEditor?.dispose();
    this.secondaryDiffEditor?.dispose();
    this.secondaryEditor = null;
    this.secondaryDiffEditor = null;
    const host = this.$("secondary-editor-host");
    host.textContent = "";
    const options = { automaticLayout: true, minimap: { enabled: false }, scrollBeyondLastLine: false,
      fontSize: this.settings.code_font_size, wordWrap: this.settings.editor_no_wrap ? "off" : "on", fixedOverflowWidgets: true };
    if (diff) {
      this.secondaryDiffEditor = monaco.editor.createDiffEditor(host, { ...options, readOnly: true, renderSideBySide: false });
      this.secondaryDiffEditor.setModel({ original: activeEntry.model, modified: secondaryEntry.model });
    } else {
      this.secondaryEditor = monaco.editor.create(host, { ...options, readOnly: false, model: secondaryEntry.model });
    }
  }

  toggleProblemsPanel() {
    this.setProblemsOpen(!this.problemsOpen);
  }

  setProblemsOpen(open) {
    this.problemsOpen = !!open;
    this.$("problems-panel").classList.toggle("hidden", !this.problemsOpen);
    this.$("problems-toggle").classList.toggle("on", this.problemsOpen);
    if (this.problemsOpen) this.refreshProblems();
    this.editor?.layout();
    this.secondaryEditor?.layout();
    this.secondaryDiffEditor?.layout();
    this.fitActive();
  }

  scheduleProblemsRefresh() {
    if (!this.problemsOpen) return;
    clearTimeout(this.problemsRefreshTimer);
    this.problemsRefreshTimer = setTimeout(() => this.refreshProblems(), 180);
  }

  refreshProblems() {
    if (!this.problemsOpen || typeof monaco === "undefined") return;
    const problems = [];
    for (const marker of monaco.editor.getModelMarkers({})) {
      const entry = [...this.openFiles.values()].find((candidate) => candidate.model?.uri.toString() === marker.resource.toString());
      if (!entry) continue;
      problems.push({ severity: marker.severity >= monaco.MarkerSeverity.Error ? "error" : "warning",
        message: marker.message, path: entry.path, root: entry.root, line: marker.startLineNumber, column: marker.startColumn });
    }
    const view = this.views.get(this.activeId);
    const session = this.session(this.activeId);
    if (view && session && this.activeFileKey === null) {
      const buffer = view.term.buffer.active;
      const first = Math.max(0, buffer.baseY + buffer.cursorY - 400);
      const last = Math.min(buffer.length - 1, buffer.baseY + buffer.cursorY);
      const seen = new Set();
      for (let index = first; index <= last; index += 1) {
        const text = buffer.getLine(index)?.translateToString(true) || "";
        const match = /(?:^|\s)((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]+):(\d+)(?::(\d+))?.*?\b(error|warning)\b/i.exec(text) ||
          /\b(error|warning)\b.*?((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]+):(\d+)(?::(\d+))?/i.exec(text);
        if (!match) continue;
        const pathFirst = match[1] && !/^(error|warning)$/i.test(match[1]);
        const path = pathFirst ? match[1] : match[2];
        const line = Number(pathFirst ? match[2] : match[3]);
        const column = Number(pathFirst ? match[3] : match[4]) || 1;
        const severity = String(pathFirst ? match[4] : match[1]).toLocaleLowerCase();
        const key = `${path}:${line}:${severity}`;
        if (seen.has(key)) continue;
        seen.add(key);
        problems.push({ severity, message: text.trim(), path, root: session.cwd, line, column });
      }
    }
    this.renderProblems(problems);
  }

  renderProblems(problems) {
    const list = this.$("problems-list");
    list.textContent = "";
    this.$("problems-count").textContent = problems.length ? String(problems.length) : "";
    for (const problem of problems) {
      const row = document.createElement("div");
      row.className = `problem-row ${problem.severity}`;
      const icon = document.createElement("span");
      icon.className = `codicon codicon-${problem.severity === "error" ? "error" : "warning"}`;
      const message = document.createElement("span");
      message.className = "problem-message";
      message.textContent = problem.message;
      const location = document.createElement("span");
      location.className = "problem-location";
      location.textContent = `${problem.path}:${problem.line}`;
      row.append(icon, message, location);
      row.onclick = () => void this.openFile(problem.root, problem.path, problem.line, null, { pinned: true });
      list.appendChild(row);
    }
    if (!problems.length) {
      const empty = document.createElement("div");
      empty.className = "file-inspector-empty";
      empty.textContent = "No Monaco diagnostics or recent terminal errors.";
      list.appendChild(empty);
    }
  }

  toggleConversationOutline() {
    this.setConversationOutlineOpen(!this.conversationOutlineOpen);
  }

  setConversationOutlineOpen(open) {
    this.conversationOutlineOpen = !!open && this.activeFileKey === null && !!this.activeId;
    this.$("conversation-outline").classList.toggle("hidden", !this.conversationOutlineOpen);
    this.$("conversation-outline-toggle").classList.toggle("on", this.conversationOutlineOpen);
    if (this.conversationOutlineOpen) void this.loadConversationOutline(true);
    else this.conversationOutlineSessionId = null;
    this.fitActive();
  }

  async loadConversationOutline(force = false) {
    const sessionId = this.activeId;
    if (!this.conversationOutlineOpen || !sessionId || this.activeFileKey !== null) return;
    const list = this.$("conversation-outline-list");
    let turns = !force ? this.conversationOutlineTurnsBySession.get(sessionId) : null;
    if (!turns?.length || force) {
      list.textContent = "";
      const loading = document.createElement("div");
      loading.className = "file-inspector-empty";
      loading.textContent = "Loading transcript outline…";
      list.appendChild(loading);
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/history-page?limit=160`);
      if (!response.ok || !this.conversationOutlineOpen || this.activeId !== sessionId) {
        loading.textContent = "Conversation transcript unavailable.";
        return;
      }
      const payload = await response.json();
      turns = Array.isArray(payload.turns) ? payload.turns : [];
      this.conversationOutlineTurnsBySession.set(sessionId, turns);
    }
    this.conversationOutlineSessionId = sessionId;
    this.renderConversationOutline(turns || []);
  }

  conversationOutlineTurnKey(turn) {
    return `${turn.role || ""}|${turn.kind || ""}|${String(turn.text || "").replace(/\s+/g, " ").trim().slice(0, 220)}`;
  }

  renderConversationOutline(turns) {
    const list = this.$("conversation-outline-list");
    list.textContent = "";
    const messages = turns.filter((turn) => ["user", "assistant"].includes(turn.role) && String(turn.text || "").trim());
    let latestPromptItem = null;
    for (const turn of messages) {
      const item = document.createElement("button");
      item.type = "button";
      const prompt = turn.role === "user";
      const question = !prompt && /[?？]\s*$/.test(String(turn.text || "").trim());
      const messageType = prompt ? "prompt" : question ? "question" : "response";
      item.className = `conversation-outline-item ${messageType}`;
      const role = document.createElement("span");
      role.className = `conversation-outline-role codicon codicon-${prompt ? "arrow-right" : question ? "question" : "sparkle"}`;
      const label = document.createElement("span");
      label.className = "conversation-outline-label";
      label.textContent = prompt ? "Prompt" : question ? "Question" : "LLM response";
      const text = document.createElement("span");
      text.className = "conversation-outline-text";
      text.textContent = String(turn.text || "").replace(/\s+/g, " ").trim();
      item.append(role, label, text);
      item.onclick = () => this.openConversationOutlineTurn(turn);
      list.appendChild(item);
      if (prompt) latestPromptItem = item;
    }
    if (!messages.length) {
      const empty = document.createElement("div");
      empty.className = "file-inspector-empty";
      empty.textContent = "No user prompts or assistant responses yet.";
      list.appendChild(empty);
    }
    if (latestPromptItem) {
      requestAnimationFrame(() => {
        if (!this.conversationOutlineOpen || !latestPromptItem.isConnected) return;
        list.scrollTop = Math.max(0, latestPromptItem.offsetTop - list.offsetTop - 6);
      });
    }
  }

  openConversationOutlineTurn(turn) {
    const key = this.conversationOutlineTurnKey(turn);
    if (!this.historyOpen) this.setHistoryMode(true);
    const reveal = (attempt = 0) => {
      if (!this.historyOpen || attempt > 12) return;
      const target = [...this.$("history-body").querySelectorAll(".turn")]
        .find((block) => block.dataset.outlineKey === key);
      if (target) {
        target.scrollIntoView({ block: "center", behavior: "smooth" });
        target.classList.add("outline-target");
        setTimeout(() => target.classList.remove("outline-target"), 1200);
        return;
      }
      setTimeout(() => reveal(attempt + 1), 100);
    };
    requestAnimationFrame(() => reveal());
  }

  scheduleSelectionActions() {
    clearTimeout(this.selectionActionUpdateTimer);
    this.selectionActionUpdateTimer = setTimeout(() => {
      this.selectionActionUpdateTimer = 0;
      if (this.selectionActionUpdateFrame) cancelAnimationFrame(this.selectionActionUpdateFrame);
      this.selectionActionUpdateFrame = requestAnimationFrame(() => {
        this.selectionActionUpdateFrame = 0;
        this.updateSelectionActions();
      });
    }, SELECTION_ACTION_DELAY_MS);
  }

  updateSelectionActions() {
    const actions = this.$("selection-actions");
    const historyPanel = this.$("selection-copy-history-panel");
    const historyPanelOpen = !!actions?.classList.contains("history-picker") && !!historyPanel && !historyPanel.classList.contains("hidden");
    const state = this.readSelectionActionState();
    if (!state) {
      if (historyPanelOpen) {
        this.positionSelectionCopyHistoryPanel(this.selectionActionAnchorRect());
        return;
      }
      if (this.contextMenuTarget?.type === "selection" && !this.$("context-menu").classList.contains("hidden")) return;
      this.hideSelectionActions();
      return;
    }
    this.selectionActionState = state;
    if (!actions) return;
    if (historyPanelOpen) {
      this.positionSelectionCopyHistoryPanel(state.rect);
      return;
    }
    actions.classList.add("hidden");
    if (this.contextMenuTarget?.type === "selection") this.openSelectionContextMenu(state);
  }

  positionSelectionActions(rect) {
    const actions = this.$("selection-actions");
    if (!actions) return;
    if (actions.classList.contains("history-picker")) {
      const width = Math.min(640, Math.max(280, window.innerWidth - 32));
      actions.style.width = `${width}px`;
      actions.style.left = `${Math.max(16, Math.round((window.innerWidth - width) / 2))}px`;
      actions.style.top = `${Math.max(16, Math.round((window.innerHeight - actions.offsetHeight) / 2))}px`;
      actions.style.transform = "none";
      return;
    }
    actions.style.width = "";
    actions.style.transform = "";
    const width = actions.offsetWidth || 150;
    const height = actions.offsetHeight || 30;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const leftOfSelection = rect.left - width - 8;
    const rightOfSelection = rect.right + 8;
    const left = leftOfSelection >= 8 ? leftOfSelection : rightOfSelection + width <= viewportWidth - 8
      ? rightOfSelection : Math.max(8, Math.min(viewportWidth - width - 8, rect.right - width));
    const selectionHeight = Math.max(0, rect.bottom - rect.top);
    const centeredTop = rect.top + (selectionHeight - height) / 2;
    const top = Math.max(8, Math.min(viewportHeight - height - 8, centeredTop));
    actions.style.left = `${left}px`;
    actions.style.top = `${top}px`;
    actions.classList.toggle("selection-submenus-right", left < 160);
  }

  readSelectionActionState(sourceElement = null) {
    if (this.activeFileKey !== null) {
      const editorHost = this.$("monaco-host");
      if (sourceElement && !editorHost?.contains(sourceElement)) return null;
      const editor = this.editor;
      const selection = editor?.getSelection();
      const model = editor?.getModel();
      if (!selection || selection.isEmpty || !model) return null;
      const text = this.normalizeSelectionText(model.getValueInRange(selection));
      const rect = this.monacoSelectionRect(editor, selection);
      return text && rect ? { kind: "file", fileKey: this.activeFileKey, text, rawText: text, rect } : null;
    }
    if (this.settings.notebook_open && this.notebookEditor && this.notebookMounted) {
      const editorHost = this.$("notebook-editor-host");
      const focusedInNotebook = editorHost?.contains(document.activeElement);
      if ((!sourceElement && focusedInNotebook) || (sourceElement && editorHost?.contains(sourceElement))) {
        const selection = this.notebookEditor.getSelection();
        const model = this.notebookEditor.getModel();
        if (selection && !selection.isEmpty && model) {
          const text = this.normalizeSelectionText(model.getValueInRange(selection));
          const rect = this.monacoSelectionRect(this.notebookEditor, selection);
          return text && rect ? { kind: "notebook", text, rawText: text, rect } : null;
        }
      }
    }
    if (this.historyOpen) {
      const selection = window.getSelection();
      const body = this.$("history-body");
      if (sourceElement && !body?.contains(sourceElement)) return null;
      if (!this.selectionWithinContainer(selection, body)) return null;
      const range = selection.getRangeAt(0).cloneRange();
      const rawText = this.normalizeSelectionText(selection.toString());
      const text = this.markdownSelectionText(range, body, rawText);
      const html = this.markdownSelectionHtml(range);
      const rect = this.selectionRangeRect(selection);
      return text && rect ? { kind: "history", text, rawText, html, rect } : null;
    }
    const view = this.views.get(this.activeId);
    if (sourceElement && !view?.container.contains(sourceElement)) return null;
    if (!view || !view.container.classList.contains("visible") || !view.term.hasSelection()) return null;
    const text = this.normalizeSelectionText(view.term.getSelection());
    const rect = this.terminalSelectionRect(view);
    return text && rect ? { kind: "terminal", sessionId: view.sessionId, text, rect } : null;
  }

  markdownSelectionText(range, body, rawText) {
    const selectedItems = [...body.querySelectorAll(".markdown li")].filter((item) => range.intersectsNode(item));
    const previousMarkers = selectedItems.map((item) => [item, item.getAttribute("data-termdeck-selection-marker")]);
    for (const item of selectedItems) {
      const marker = this.markdownListItemMarker(item);
      if (marker) item.setAttribute("data-termdeck-selection-marker", marker);
    }
    const fragment = range.cloneContents();
    for (const [item, marker] of previousMarkers) {
      if (marker === null) item.removeAttribute("data-termdeck-selection-marker");
      else item.setAttribute("data-termdeck-selection-marker", marker);
    }
    const output = [];
    this.serializeMarkdownSelectionNode(fragment, output);
    let text = output.join("").replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    const startItem = this.selectionAncestorElement(range.startContainer, "LI");
    const firstItem = startItem && selectedItems.includes(startItem) ? startItem : selectedItems[0];
    const firstMarker = firstItem ? this.markdownListItemMarker(firstItem) : "";
    const startsInListItem = !!startItem;
    if (startsInListItem && firstMarker && !text.startsWith(firstMarker.trim())) text = `${firstMarker}${text}`;
    return text || rawText;
  }

  markdownSelectionHtml(range) {
    const wrapper = document.createElement("div");
    wrapper.appendChild(range.cloneContents());
    return wrapper.innerHTML;
  }

  markdownListItemMarker(item) {
    const list = item.parentElement;
    if (!list || (list.tagName !== "OL" && list.tagName !== "UL")) return "";
    let depth = 0;
    let ancestor = list.parentElement;
    while (ancestor) {
      if (ancestor.tagName === "OL" || ancestor.tagName === "UL") depth += 1;
      ancestor = ancestor.parentElement;
    }
    const indentation = "  ".repeat(depth);
    if (list.tagName === "UL") return `${indentation}- `;
    const listItems = [...list.children].filter((child) => child.tagName === "LI");
    const index = listItems.indexOf(item);
    if (index < 0) return "";
    const explicitValue = Number.parseInt(item.getAttribute("value") || "", 10);
    const listStart = Number.parseInt(list.getAttribute("start") || "1", 10);
    const number = Number.isFinite(explicitValue) ? explicitValue : (Number.isFinite(listStart) ? listStart : 1) + index;
    return `${indentation}${number}. `;
  }

  selectionAncestorElement(node, tagName) {
    let current = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    while (current) {
      if (current.tagName === tagName) return current;
      current = current.parentElement;
    }
    return null;
  }

  serializeMarkdownSelectionNode(node, output) {
    if (node.nodeType === Node.TEXT_NODE) {
      output.push(node.nodeValue || "");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
    const tag = node.nodeType === Node.ELEMENT_NODE ? node.tagName : "";
    if (tag === "BR") {
      output.push("\n");
      return;
    }
    if (tag === "HR") {
      output.push("\n---\n");
      return;
    }
    if (tag === "PRE") {
      output.push("\n", node.textContent || "", "\n");
      return;
    }
    if (tag === "LI") {
      output.push("\n", node.getAttribute("data-termdeck-selection-marker") || "");
      for (const child of node.childNodes) this.serializeMarkdownSelectionNode(child, output);
      output.push("\n");
      return;
    }
    const blockTags = new Set(["ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DIV", "DL", "DT", "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "MAIN", "NAV", "OL", "P", "SECTION", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL"]);
    if (blockTags.has(tag)) output.push("\n");
    for (const child of node.childNodes) this.serializeMarkdownSelectionNode(child, output);
    if (blockTags.has(tag)) output.push("\n");
  }

  selectionWithinContainer(selection, container) {
    if (!selection || selection.isCollapsed || !selection.rangeCount || !container) return false;
    const anchor = selection.anchorNode?.nodeType === Node.ELEMENT_NODE ? selection.anchorNode : selection.anchorNode?.parentElement;
    const focus = selection.focusNode?.nodeType === Node.ELEMENT_NODE ? selection.focusNode : selection.focusNode?.parentElement;
    return !!anchor && !!focus && container.contains(anchor) && container.contains(focus);
  }

  normalizeSelectionText(text) {
    return String(text || "").replace(/\r/g, "").trim();
  }

  selectionRangeRect(selection) {
    if (!selection || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    const rects = [...range.getClientRects()].filter((rect) => rect.width || rect.height);
    return rects[rects.length - 1] || range.getBoundingClientRect();
  }

  terminalSelectionRect(view) {
    const rects = [...view.container.querySelectorAll(".xterm-selection, .xterm-selection > div")]
      .map((element) => element.getBoundingClientRect()).filter((rect) => rect.width || rect.height)
      .sort((left, right) => left.bottom - right.bottom);
    if (rects.length) return rects[rects.length - 1];
    const container = view.container.getBoundingClientRect();
    return { left: container.left + container.width / 2 - 1, right: container.left + container.width / 2 + 1,
      top: container.bottom - 28, bottom: container.bottom - 8 };
  }

  monacoSelectionRect(editor, selection) {
    const node = editor?.getDomNode();
    if (!node || !selection) return null;
    const start = editor.getScrolledVisiblePosition(selection.getStartPosition());
    const end = editor.getScrolledVisiblePosition(selection.getEndPosition());
    if (!start || !end) return null;
    const bounds = node.getBoundingClientRect();
    const left = bounds.left + Math.min(start.left, end.left);
    const right = bounds.left + Math.max(start.left + start.width, end.left + end.width);
    const top = bounds.top + Math.min(start.top, end.top);
    const bottom = bounds.top + Math.max(start.top + start.height, end.top + end.height);
    return { left, right, top, bottom };
  }

  openSelectionContextMenu(state, point = null, contextKind = "terminal") {
    const menu = this.$("context-menu");
    if (!menu) return;
    const hasSelection = !!state?.text;
    const selectionState = state || { kind: contextKind, text: "", rect: { left: point?.x || 0, right: point?.x || 0,
      top: point?.y || 0, bottom: point?.y || 0 } };
    this.selectionActionState = hasSelection ? state : null;
    const selectionKey = `${selectionState.kind}:${selectionState.text}`;
    const existingSelectionMenu = this.contextMenuTarget?.type === "selection" &&
      this.contextMenuTarget.key === selectionKey;
    if (!existingSelectionMenu) {
      menu.textContent = "";
      this.contextMenuTarget = { type: "selection", key: selectionKey, point };
      const selectionText = hasSelection ? state.text : "";
      this.addContextItem(menu, "Copy", hasSelection ? () => this.copySelectionToClipboard() : null, "copy");
      this.addContextItem(menu, "New note", hasSelection ? () => { void this.createNotebookNoteFromSelection(); } : null, "new-file");
      this.addContextItem(menu, "Append to note", hasSelection ? () => { void this.appendSelectionToNotebook(); } : null, "comment-add");
      this.addContextItem(menu, "File contents", hasSelection ? () => this.searchContentFromSelection() : null, "search");
      this.addContextItem(menu, "File name", hasSelection ? () => this.searchFileFromSelection() : null, "symbol-file");
      const agentEntries = [{
        label: "New agent…",
        handler: hasSelection ? () => this.openNewAgentFromSelection(selectionText) : () => this.openModal(),
        icon: "add",
      }, { kind: "label", label: "Existing agents" }];
      const existingAgents = this.recentAgentSessionsForContextMenu();
      if (existingAgents.length) {
        for (const session of existingAgents) {
          agentEntries.push({
            label: this.agentSessionContextLabel(session),
            handler: hasSelection ? () => this.pasteSelectionIntoAgent(session.session_id, selectionText) : null,
            icon: "terminal",
          });
        }
      } else {
        agentEntries.push({ kind: "label", label: "No existing agents" });
      }
      this.addContextSubmenu(menu, "Ask an agent", agentEntries, "terminal");
    } else if (point) {
      this.contextMenuTarget.point = point;
    }
    menu.classList.remove("hidden");
    const contextPoint = point || this.contextMenuTarget?.point;
    if (contextPoint) {
      this.positionContextMenu(menu, contextPoint.x + 4, contextPoint.y + 4);
      return;
    }
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const right = selectionState.rect.right + 8;
    const left = selectionState.rect.left - width - 8 >= 8 ? selectionState.rect.left - width - 8 : right;
    const top = selectionState.rect.top + Math.max(0, (selectionState.rect.bottom - selectionState.rect.top - height) / 2);
    this.positionContextMenu(menu, left, top);
  }

  closeSelectionContextMenu() {
    if (this.contextMenuTarget?.type !== "selection") return;
    this.closeContextMenu();
  }

  hideSelectionActions(clearSelection = false) {
    const state = this.selectionActionState;
    this.selectionActionState = null;
    this.closeSelectionContextMenu();
    this.selectionCopyHistoryIndex = 0;
    clearTimeout(this.selectionActionUpdateTimer);
    this.selectionActionUpdateTimer = 0;
    const actions = this.$("selection-actions");
    if (actions) actions.classList.add("hidden");
    if (actions) actions.classList.remove("history-picker");
    if (actions) actions.classList.remove("keyboard-nav");
    const historyPanel = this.$("selection-copy-history-panel");
    if (historyPanel) historyPanel.classList.add("hidden");
    if (!clearSelection) return;
    if (state?.kind === "terminal") this.views.get(state.sessionId)?.term.clearSelection();
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) selection.removeAllRanges();
  }

  closeSelectionCopyHistoryPicker() {
    this.hideSelectionActions();
    requestAnimationFrame(() => this.focusActiveEditor());
  }

  recordDocumentSelectionCopy() {
    const state = this.readSelectionActionState();
    if (state) this.recordSelectionCopyHistory(state.text);
  }

  recordSelectionCopyHistory(text) {
    const copied = this.normalizeSelectionText(text);
    if (!copied) return;
    const previous = Array.isArray(this.settings.selection_copy_history) ? this.settings.selection_copy_history : [];
    this.settings.selection_copy_history = [copied, ...previous.filter((item) => item !== copied)].slice(0, 50);
    this.saveSettings();
    const panel = this.$("selection-copy-history-panel");
    if (panel && !panel.classList.contains("hidden")) this.renderSelectionCopyHistory();
    if (this.settings.notebook_open) {
      this.renderNotebookRecentCopies();
      this.renderNotebookTabs();
    }
  }

  renderSelectionCopyHistory() {
    const panel = this.$("selection-copy-history-panel");
    if (!panel) return;
    panel.textContent = "";
    const history = Array.isArray(this.settings.selection_copy_history) ? this.settings.selection_copy_history : [];
    const head = document.createElement("div");
    head.className = "selection-copy-history-head";
    const title = document.createElement("span");
    title.textContent = "Recently copied";
    const count = document.createElement("span");
    count.className = "selection-copy-history-count";
    count.textContent = history.length ? `${history.length} items` : "";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "selection-copy-history-close codicon codicon-close";
    close.title = "Close copied text picker";
    close.setAttribute("aria-label", close.title);
    close.onclick = () => this.closeSelectionCopyHistoryPicker();
    head.append(title, count, close);
    panel.appendChild(head);
    const list = document.createElement("div");
    list.className = "selection-copy-history-items";
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "Recently copied text");
    if (!history.length) {
      const empty = document.createElement("div");
      empty.className = "selection-copy-history-empty";
      empty.textContent = "No copied selections yet.";
      list.appendChild(empty);
      panel.appendChild(list);
      return;
    }
    for (const [index, text] of history.entries()) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "selection-copy-history-item";
      item.dataset.copyText = text;
      item.dataset.copyIndex = String(index);
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(index === this.selectionCopyHistoryIndex));
      item.title = "Insert into the active prompt";
      item.textContent = text;
      item.onclick = () => this.insertSelectionCopyHistory(text, true);
      list.appendChild(item);
    }
    panel.appendChild(list);
    this.focusSelectionCopyHistoryItem(false);
  }

  toggleSelectionCopyHistory() {
    const panel = this.$("selection-copy-history-panel");
    if (!panel) return;
    const opening = panel.classList.contains("hidden");
    if (!opening) {
      this.closeSelectionCopyHistoryPicker();
      return;
    }
    this.showSelectionCopyHistoryPicker();
  }

  showSelectionCopyHistoryPicker() {
    const actions = this.$("selection-actions");
    const panel = this.$("selection-copy-history-panel");
    if (!actions || !panel) return;
    const state = this.selectionActionState || this.readSelectionActionState();
    if (state) this.selectionActionState = state;
    this.closeSelectionContextMenu();
    actions.classList.add("history-picker");
    actions.classList.remove("hidden");
    panel.classList.remove("hidden");
    this.selectionCopyHistoryIndex = 0;
    this.renderSelectionCopyHistory();
    this.positionSelectionActions(state?.rect || this.selectionActionAnchorRect());
    this.focusSelectionCopyHistoryItem();
  }

  focusSelectionCopyHistoryItem(updateIndex = true) {
    const items = [...this.$("selection-copy-history-panel")?.querySelectorAll(".selection-copy-history-item") || []];
    if (!items.length) return;
    this.selectionCopyHistoryIndex = Math.max(0, Math.min(this.selectionCopyHistoryIndex, items.length - 1));
    for (const [index, item] of items.entries()) {
      item.setAttribute("aria-selected", String(index === this.selectionCopyHistoryIndex));
    }
    const item = items[this.selectionCopyHistoryIndex];
    item.focus();
    item.scrollIntoView({ block: "nearest" });
    if (updateIndex) this.selectionCopyHistoryIndex = Number(item.dataset.copyIndex || this.selectionCopyHistoryIndex);
  }

  selectionActionAnchorRect() {
    if (this.selectionActionState?.rect) return this.selectionActionState.rect;
    const prompt = this.historyOpen ? this.$("history-prompt") : null;
    const view = this.views.get(this.activeId);
    const source = prompt || (view && view.container.classList.contains("visible") ? view.container : null);
    const sourceRect = source?.getBoundingClientRect();
    return sourceRect || { left: window.innerWidth / 2, right: window.innerWidth / 2, top: window.innerHeight / 2,
      bottom: window.innerHeight / 2 };
  }

  positionSelectionCopyHistoryPanel(rect) {
    if (this.$("selection-copy-history-panel")?.classList.contains("hidden")) return;
    this.positionSelectionActions(rect);
  }

  copySelectionToClipboard(keepSelectionActions = false) {
    const state = this.readSelectionActionState() || this.selectionActionState;
    if (!state) return;
    const text = state.text;
    this.recordSelectionCopyHistory(text);
    void this.copySelectionPayloadToClipboard(text, state.html || "", "selection copied");
    if (keepSelectionActions) {
      this.selectionActionState = state;
      this.scheduleSelectionActions();
    } else {
      this.hideSelectionActions();
    }
  }

  fileNameSearchQueryFromSelection(text) {
    const normalized = String(text || "").replace(/\r/g, "").replace(/\s*\/\s*/g, "/").trim();
    if (!normalized) return "";
    const candidates = normalized.match(/(?:[A-Za-z0-9_.~-]+\/)*[A-Za-z0-9_.~-]+(?:\.[A-Za-z0-9_-]+)?(?::\d+(?::\d+)?)?/g) || [];
    const fileCandidate = candidates.filter((candidate) => candidate.includes("/") || candidate.includes(".")).sort((left, right) => right.length - left.length)[0];
    const fallback = normalized.split(/\s+/).pop() || "";
    return (fileCandidate || fallback).replace(/:\d+(?::\d+)?$/, "").replace(/^[([{<]+|[)\]}>.,;]+$/g, "");
  }

  selectedTextSearchQuery() {
    const state = this.selectionActionState || this.readSelectionActionState();
    if (!state) return "";
    this.selectionActionState = state;
    const query = this.normalizeSelectionText(state.rawText || state.text);
    if (!query) return "";
    if (query.length > SELECTION_SEARCH_MAX_CHARS) {
      this.$("status-name").textContent = `selection is too long for search (${SELECTION_SEARCH_MAX_CHARS} characters maximum)`;
      return "";
    }
    return query;
  }

  selectedTextForAutomaticSearch() {
    const state = this.selectionActionState || this.readSelectionActionState();
    if (!state) return "";
    this.selectionActionState = state;
    const query = this.normalizeSelectionText(state.rawText || state.text);
    if (!query || query.includes("\n") || query.length > SELECTION_SEARCH_MAX_CHARS) return "";
    return query;
  }

  searchContentFromSelection() {
    const query = this.selectedTextSearchQuery();
    if (!query) return false;
    this.hideSelectionActions();
    const input = this.$("search-query");
    if (this.sideView !== "search") {
      input.value = "";
      this.setSideView("search", false);
    }
    input.value = query;
    void this.runSearch(query);
    return true;
  }

  searchFileFromSelection() {
    const selectedText = this.selectedTextSearchQuery();
    if (!selectedText) return false;
    const query = this.fileNameSearchQueryFromSelection(selectedText);
    if (!query) return false;
    this.hideSelectionActions();
    const input = this.$("search-name");
    if (this.sideView !== "project") {
      input.value = "";
      this.setSideView("project", false);
    }
    input.value = query;
    void this.runNameSearch();
    return true;
  }

  recentAgentSessionsForContextMenu() {
    return this.sessions.filter((session) => session.agent_kind && session.agent_kind !== "none" &&
      (session.running || session.dormant)).sort((left, right) => {
      const activityDifference = this.sessionActivityTime(right) - this.sessionActivityTime(left);
      if (activityDifference) return activityDifference;
      return this.agentSessionContextLabel(left).localeCompare(this.agentSessionContextLabel(right));
    });
  }

  agentSessionContextLabel(session) {
    const title = this.titlePresentation(session).text.trim();
    const cwd = String(session.cwd || "").replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop() || "";
    const name = title || cwd || session.session_id;
    return (TERMINAL_ICON_AGENT_LABELS[session.agent_kind] || session.agent_kind) + " · " + name;
  }

  pasteSelectionIntoAgent(sessionId, text = "") {
    const value = this.normalizeSelectionText(text || this.selectionActionState?.text);
    const session = this.session(sessionId);
    if (!value || !session || !session.agent_kind || session.agent_kind === "none" ||
        (!session.running && !session.dormant)) return false;
    this.hideSelectionActions(true);
    const view = this.ensureView(sessionId);
    if (!this.queuePendingAgentPaste(view, value)) return false;
    if (!view.ws) this.connect(sessionId, view);
    this.$("status-name").textContent = "selected text queued for " + this.agentSessionContextLabel(session);
    return true;
  }

  openNewAgentFromSelection(text = "") {
    const value = this.normalizeSelectionText(text || this.selectionActionState?.text);
    if (!value) return false;
    this.hideSelectionActions(true);
    this.openModal(null, null, value);
    return true;
  }

  appendTextToHistoryPrompt(text) {
    const value = this.normalizeSelectionText(text);
    if (!value) return;
    if (!this.historyOpen) this.setHistoryMode(true);
    const view = this.views.get(this.activeId);
    const prompt = this.$("history-prompt");
    if (!view || !prompt || !this.historyOpen) return;
    const current = String(prompt.value || view.markdownPromptDraft || "").trimEnd();
    this.persistMarkdownPromptDraft(view, current ? `${current}\n\n${value}\n\n` : `${value}\n\n`);
    this.showPromptDraft(view);
    prompt.focus();
    prompt.setSelectionRange(prompt.value.length, prompt.value.length);
  }

  pasteSelectionCopyHistory(text) {
    this.insertSelectionCopyHistory(text, false);
  }

  insertSelectionCopyHistory(text, closeNotebook) {
    const value = this.normalizeSelectionText(text);
    if (!value) return;
    if (closeNotebook && this.settings.notebook_open) this.setNotebookOpen(false, { focus: false });
    this.hideSelectionActions(true);
    if (this.activeFileKey !== null) {
      const editor = this.editor;
      const selection = editor?.getSelection();
      if (!editor || !selection) return;
      editor.executeEdits("termdeck-copy-history", [{ range: selection, text: value, forceMoveMarkers: true }]);
      editor.focus();
      this.$("status-name").textContent = "copied text inserted into file";
      return;
    }
    if (this.historyOpen) {
      this.appendTextToHistoryPrompt(value);
      this.$("status-name").textContent = "copied text inserted into prompt";
      return;
    }
    const view = this.views.get(this.activeId);
    if (!view) return;
    view.term.focus();
    this.sendTrackedInput(view, this.terminalPastePayload(view, value));
    this.$("status-name").textContent = "copied text pasted into terminal";
  }

  async prepareNotebookSelectionEdit() {
    await this.flushNotebook();
    this.notebookCopiesOpen = false;
    if (this.notebookEditor) this.notebookEditor.setModel(null);
    this.notebookMounted = false;
    this.normalizeNotebookNotes();
  }

  openNotebookAfterSelectionEdit(status) {
    const fallback = this.$("notebook-editor-host")?.querySelector(".notes-area");
    if (fallback) fallback.value = this.activeNotebookNote()?.text || "";
    this.settings.notebook_open = true;
    this.renderNotebook();
    this.saveSettings();
    void this.mountNotebookEditor().then(() => this.focusNotebookEditor());
    this.$("status-name").textContent = status;
  }

  async createNotebookNoteFromSelection() {
    const state = this.selectionActionState;
    if (!state) return;
    const text = state.text;
    this.hideSelectionActions(true);
    await this.prepareNotebookSelectionEdit();
    const note = { note_id: this.createNotebookNoteId(), text: `${text}\n` };
    this.settings.notebook_notes.push(note);
    this.settings.notebook_active_note_id = note.note_id;
    this.settings.notebook_notes_initialized = true;
    this.settings.notebook_text = note.text;
    this.openNotebookAfterSelectionEdit("selection added as new note");
  }

  async appendSelectionToNotebook() {
    const state = this.selectionActionState;
    if (!state) return;
    const text = state.text;
    this.hideSelectionActions(true);
    await this.prepareNotebookSelectionEdit();
    let note = this.activeNotebookNote();
    if (!note) {
      note = { note_id: this.createNotebookNoteId(), text: "" };
      this.settings.notebook_notes.push(note);
      this.settings.notebook_active_note_id = note.note_id;
      this.settings.notebook_notes_initialized = true;
    }
    const current = String(note.text || "").trimEnd();
    note.text = current ? `${current}\n\n${text}\n` : `${text}\n`;
    this.settings.notebook_text = note.text;
    const fallback = this.$("notebook-editor-host")?.querySelector(".notes-area");
    if (fallback) fallback.value = note.text;
    this.openNotebookAfterSelectionEdit("selection appended to note");
  }

  createNotebookNoteId() {
    return `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  normalizeNotebookNotes() {
    const sourcePresent = Array.isArray(this.settings.notebook_notes);
    const source = sourcePresent ? this.settings.notebook_notes : [];
    const seen = new Set();
    const notes = [];
    for (const raw of source) {
      const noteId = String(raw?.note_id || raw?.id || "").trim();
      if (!noteId || seen.has(noteId)) continue;
      seen.add(noteId);
      notes.push({ note_id: noteId, text: String(raw?.text || "") });
    }
    if (!notes.length && !this.settings.notebook_notes_initialized) {
      notes.push({ note_id: this.createNotebookNoteId(), text: String(this.settings.notebook_text || "") });
    }
    const activeNoteId = notes.some((note) => note.note_id === this.settings.notebook_active_note_id)
      ? this.settings.notebook_active_note_id : notes[0]?.note_id || "";
    const active = notes.find((note) => note.note_id === activeNoteId) || null;
    const changed = JSON.stringify(source) !== JSON.stringify(notes) || this.settings.notebook_active_note_id !== activeNoteId ||
      this.settings.notebook_text !== (active?.text || "") || !sourcePresent || !this.settings.notebook_notes_initialized;
    this.settings.notebook_notes = notes;
    this.settings.notebook_active_note_id = activeNoteId;
    this.settings.notebook_text = active?.text || "";
    this.settings.notebook_notes_initialized = true;
    return changed;
  }

  activeNotebookNote() {
    this.normalizeNotebookNotes();
    return this.settings.notebook_notes.find((note) => note.note_id === this.settings.notebook_active_note_id) || null;
  }

  notebookTabTitle(note) {
    const source = String(note?.text || "").replace(/!\[[^\]]*\]\([^)]*\)|\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[`*_~>#]/g, " ").replace(/\s+/g, " ").trim();
    const words = source.split(" ").filter(Boolean).slice(0, 6);
    return words.length ? words.join(" ") : "Untitled note";
  }

  renderNotebookTabs() {
    const tabs = this.$("notebook-tabs");
    if (!tabs) return;
    this.normalizeNotebookNotes();
    tabs.textContent = "";
    for (const note of this.settings.notebook_notes) {
      const tab = document.createElement("div");
      const active = !this.notebookCopiesOpen && note.note_id === this.settings.notebook_active_note_id;
      tab.className = "notebook-tab" + (active ? " active" : "");
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(active));
      const label = document.createElement("button");
      label.type = "button";
      label.className = "notebook-tab-label";
      label.title = this.notebookTabTitle(note);
      label.textContent = this.notebookTabTitle(note);
      label.onclick = () => { void this.selectNotebookNote(note.note_id); };
      const close = document.createElement("button");
      close.type = "button";
      close.className = "notebook-tab-close codicon codicon-close";
      close.title = `Move ${this.notebookTabTitle(note)} to Trash`;
      close.setAttribute("aria-label", close.title);
      close.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        void this.closeNotebookNote(note.note_id);
      };
      tab.append(label, close);
      tabs.appendChild(tab);
      if (note.note_id === this.settings.notebook_active_note_id) requestAnimationFrame(() => tab.scrollIntoView({ block: "nearest", inline: "nearest" }));
    }
    const copiedTab = document.createElement("button");
    copiedTab.type = "button";
    copiedTab.className = "notebook-tab notebook-copies-tab" + (this.notebookCopiesOpen ? " active" : "");
    copiedTab.setAttribute("role", "tab");
    copiedTab.setAttribute("aria-selected", String(this.notebookCopiesOpen));
    copiedTab.title = this.shortcutTitle("Recently copied text", "selection-copy-history");
    const copiedIcon = document.createElement("span");
    copiedIcon.className = "codicon codicon-copy notebook-copies-icon";
    const copiedLabel = document.createElement("span");
    copiedLabel.className = "notebook-tab-label notebook-copies-label";
    copiedLabel.textContent = "Copied";
    const copiedCount = document.createElement("span");
    copiedCount.className = "notebook-copies-count";
    const history = Array.isArray(this.settings.selection_copy_history) ? this.settings.selection_copy_history : [];
    copiedCount.textContent = history.length ? String(history.length) : "";
    copiedTab.append(copiedIcon, copiedLabel, copiedCount);
    copiedTab.onclick = () => this.selectNotebookCopies();
    tabs.appendChild(copiedTab);
  }

  renderNotebookRecentCopies() {
    const items = this.$("notebook-recent-copies-items");
    const count = this.$("notebook-recent-copies-count");
    if (!items || !count) return;
    const history = Array.isArray(this.settings.selection_copy_history) ? this.settings.selection_copy_history : [];
    count.textContent = history.length ? String(history.length) : "";
    items.textContent = "";
    if (!history.length) {
      const empty = document.createElement("div");
      empty.className = "notebook-recent-copies-empty";
      empty.textContent = "Nothing copied yet.";
      items.appendChild(empty);
      return;
    }
    for (const text of history) {
      const row = document.createElement("div");
      row.className = "notebook-recent-copy-row";
      const expanded = this.notebookExpandedCopy === text;
      row.classList.toggle("expanded", expanded);
      row.title = expanded ? "Collapse copied text" : "Expand copied text";
      const content = document.createElement("div");
      content.className = "notebook-recent-copy-text";
      content.textContent = text;
      content.title = expanded ? "Collapse copied text" : "Expand copied text";
      content.tabIndex = 0;
      content.setAttribute("role", "button");
      content.setAttribute("aria-expanded", String(expanded));
      const toggleExpanded = () => {
        this.notebookExpandedCopy = expanded ? null : text;
        this.renderNotebookRecentCopies();
      };
      row.onclick = (event) => {
        if (event.target.closest("button")) return;
        toggleExpanded();
      };
      content.onclick = (event) => {
        event.stopPropagation();
        toggleExpanded();
      };
      content.onkeydown = (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        toggleExpanded();
      };
      const actions = document.createElement("span");
      actions.className = "notebook-recent-copy-actions";
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "codicon codicon-copy";
      copy.title = "Copy again";
      copy.setAttribute("aria-label", copy.title);
      copy.onclick = () => { void this.copyTextToClipboard(text, "copied from history"); };
      const insert = document.createElement("button");
      insert.type = "button";
      insert.className = "codicon codicon-arrow-right";
      insert.title = "Insert into the active prompt";
      insert.setAttribute("aria-label", insert.title);
      insert.onclick = () => this.insertSelectionCopyHistory(text, true);
      actions.append(copy, insert);
      row.append(content, actions);
      items.appendChild(row);
    }
  }

  setActiveNotebookText(text, save = true, renderTitle = true) {
    const note = this.activeNotebookNote();
    if (!note) return;
    const normalizedText = String(text || "");
    const changed = note.text !== normalizedText;
    note.text = normalizedText;
    this.settings.notebook_text = normalizedText;
    if (changed && renderTitle) this.renderNotebookTabs();
    if (save) this.saveSettings();
  }

  selectNotebookCopies() {
    if (this.notebookCopiesOpen) {
      this.setNotebookOpen(false);
      return;
    }
    this.notebookCopiesOpen = true;
    this.closeNotebookFind(false);
    this.renderNotebook();
  }

  activeNotebookText() {
    const note = this.activeNotebookNote();
    if (!note) return "";
    const model = this.notebookEditor?.getModel();
    const notebookModel = this.notebookEditorModels.get(note.note_id);
    return model && model === notebookModel ? this.notebookEditor.getValue() : note.text;
  }

  notebookModelForNote(note) {
    let model = this.notebookEditorModels.get(note.note_id);
    if (!model) {
      const uri = monaco.Uri.parse(`inmemory://termdeck/notebook/${encodeURIComponent(note.note_id)}.txt`);
      model = monaco.editor.createModel(note.text, "plaintext", uri);
      this.notebookEditorModels.set(note.note_id, model);
    } else if (model.getValue() !== note.text) {
      model.setValue(note.text);
    }
    return model;
  }

  async mountNotebookEditor() {
    if (this.notebookMounted && this.notebookEditor) {
      this.notebookEditor.layout();
      return;
    }
    const host = this.$("notebook-editor-host");
    if (!host) return;
    if (!this.notebookEditor && this.monacoReady) await this.monacoReady;
    const note = this.activeNotebookNote();
    if (!note) return;
    if (!this.notebookEditor) return;
    this.notebookEditor.setModel(this.notebookModelForNote(note));
    this.notebookEditor.layout();
    this.notebookMounted = true;
  }

  flushNotebook() {
    if (!this.notebookEditor || !this.notebookMounted) return Promise.resolve();
    this.setActiveNotebookText(this.activeNotebookText());
    return Promise.resolve();
  }

  async selectNotebookNote(noteId) {
    this.normalizeNotebookNotes();
    this.notebookCopiesOpen = false;
    if (!this.settings.notebook_notes.some((note) => note.note_id === noteId) || noteId === this.settings.notebook_active_note_id) {
      this.renderNotebook();
      void this.mountNotebookEditor();
      this.focusNotebookEditor();
      return;
    }
    await this.flushNotebook();
    if (this.notebookEditor) this.notebookEditor.setModel(null);
    this.notebookMounted = false;
    this.settings.notebook_active_note_id = noteId;
    this.settings.notebook_text = this.activeNotebookNote()?.text || "";
    this.notebookSearchIndex = 0;
    this.renderNotebook();
    this.saveSettings();
    await this.mountNotebookEditor();
    this.focusNotebookEditor();
  }

  async closeNotebookNote(noteId) {
    this.normalizeNotebookNotes();
    const index = this.settings.notebook_notes.findIndex((note) => note.note_id === noteId);
    if (index < 0) return;
    const wasActive = noteId === this.settings.notebook_active_note_id;
    if (wasActive) await this.flushNotebook();
    const note = this.settings.notebook_notes[index];
    const title = this.notebookTabTitle(note);
    if (!confirm(`Move "${title}" to the macOS Trash?`)) return;
    const response = await fetch("/api/notebook/trash", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, content: note.text }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      alert(error.detail || "could not move note to Trash");
      return;
    }
    const notes = this.settings.notebook_notes.filter((note) => note.note_id !== noteId);
    const next = wasActive ? notes[Math.min(index, notes.length - 1)] || null : this.activeNotebookNote();
    if (wasActive) {
      if (this.notebookEditor) this.notebookEditor.setModel(null);
      this.notebookMounted = false;
    }
    const model = this.notebookEditorModels.get(noteId);
    if (model) model.dispose();
    this.notebookEditorModels.delete(noteId);
    this.settings.notebook_notes = notes;
    this.settings.notebook_active_note_id = next?.note_id || "";
    this.settings.notebook_text = next?.text || "";
    this.settings.notebook_notes_initialized = true;
    this.notebookSearchIndex = 0;
    this.renderNotebook();
    this.saveSettings();
    if (next && wasActive) {
      await this.mountNotebookEditor();
      this.focusNotebookEditor();
    }
  }

  async createNotebookNote() {
    await this.flushNotebook();
    const note = { note_id: this.createNotebookNoteId(), text: "" };
    this.settings.notebook_notes.push(note);
    this.notebookCopiesOpen = false;
    if (this.notebookEditor) this.notebookEditor.setModel(null);
    this.notebookMounted = false;
    this.settings.notebook_active_note_id = note.note_id;
    this.settings.notebook_text = note.text;
    this.notebookSearchIndex = 0;
    this.renderNotebook();
    this.saveSettings();
    await this.mountNotebookEditor();
    this.focusNotebookEditor();
  }

  notebookSearchMatches() {
    const query = this.$("notebook-find-query")?.value || "";
    const note = this.activeNotebookNote();
    if (!note) return [];
    const text = this.activeNotebookText();
    if (note.text !== text) note.text = text;
    if (!query) return [];
    const matches = [];
    const source = text.toLocaleLowerCase();
    const needle = query.toLocaleLowerCase();
    for (let start = source.indexOf(needle); start >= 0; start = source.indexOf(needle, start + needle.length)) {
      matches.push({ start, end: start + needle.length });
    }
    return matches;
  }

  updateNotebookSearchState(reset = false) {
    const matches = this.notebookSearchMatches();
    if (reset) this.notebookSearchIndex = 0;
    if (!matches.length) this.notebookSearchIndex = 0;
    else this.notebookSearchIndex = Math.max(0, Math.min(this.notebookSearchIndex, matches.length - 1));
    const count = this.$("notebook-find-count");
    if (count) count.textContent = matches.length ? `${this.notebookSearchIndex + 1} / ${matches.length}` :
      (this.$("notebook-find-query").value ? "0 / 0" : "");
    return matches;
  }

  openNotebookFind(showReplace = false) {
    if (this.notebookCopiesOpen) {
      this.notebookCopiesOpen = false;
      this.renderNotebook();
      void this.mountNotebookEditor();
    }
    const bar = this.$("notebook-find-bar");
    const replace = this.$("notebook-replace-row");
    const toggle = this.$("notebook-replace-toggle");
    bar.classList.remove("hidden");
    if (showReplace) replace.classList.remove("hidden");
    toggle.classList.toggle("on", !replace.classList.contains("hidden"));
    this.updateNotebookSearchState();
    const input = this.$("notebook-find-query");
    input.focus();
    input.select();
  }

  closeNotebookFind(focusEditor = false) {
    this.$("notebook-find-bar").classList.add("hidden");
    this.$("notebook-replace-row").classList.add("hidden");
    this.$("notebook-replace-toggle").classList.remove("on");
    if (focusEditor) this.focusNotebookEditor();
  }

  toggleNotebookReplace() {
    const bar = this.$("notebook-find-bar");
    const replace = this.$("notebook-replace-row");
    if (bar.classList.contains("hidden")) {
      this.openNotebookFind(true);
      return;
    }
    replace.classList.toggle("hidden");
    this.$("notebook-replace-toggle").classList.toggle("on", !replace.classList.contains("hidden"));
    if (!replace.classList.contains("hidden")) this.$("notebook-replace-query").focus();
  }

  stepNotebookSearch(direction) {
    const matches = this.updateNotebookSearchState();
    if (!matches.length) return;
    this.notebookSearchIndex = (this.notebookSearchIndex + direction + matches.length) % matches.length;
    this.updateNotebookSearchState();
  }

  async replaceNotebookSearchMatch(all) {
    const matches = this.updateNotebookSearchState();
    if (!matches.length) return;
    const note = this.activeNotebookNote();
    if (!note) return;
    const text = this.activeNotebookText();
    const replacement = this.$("notebook-replace-query").value;
    const selected = all ? matches : [matches[this.notebookSearchIndex]];
    let nextText = text;
    for (const match of [...selected].reverse()) {
      nextText = nextText.slice(0, match.start) + replacement + nextText.slice(match.end);
    }
    await this.flushNotebook();
    this.setActiveNotebookText(nextText);
    if (this.notebookEditor?.getModel() === this.notebookEditorModels.get(note.note_id)) this.notebookEditor.setValue(nextText);
    this.updateNotebookSearchState();
  }

  renderNotebook() {
    const panel = this.$("notebook-panel");
    const toggle = this.$("notebook-toggle");
    if (!panel || !toggle) return;
    this.renderNotebookTabs();
    this.renderNotebookRecentCopies();
    if (this.settings.notebook_open) {
      clearTimeout(this.notebookCloseTimer);
      this.notebookCloseTimer = null;
      panel.classList.remove("hidden", "notebook-closing");
    } else if (!panel.classList.contains("notebook-closing")) {
      panel.classList.add("hidden");
    }
    panel.classList.toggle("notebook-copies-open", this.notebookCopiesOpen);
    toggle.classList.toggle("on", !!this.settings.notebook_open);
    if (this.settings.notebook_open && this.activeNotebookNote() && !this.notebookMounted) {
      void this.mountNotebookEditor();
    }
  }

  finishNotebookClose() {
    this.notebookCloseTimer = null;
    if (this.settings.notebook_open) return;
    const panel = this.$("notebook-panel");
    if (!panel) return;
    panel.classList.add("hidden");
    panel.classList.remove("notebook-closing");
  }

  startNotebookResize(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    this.notebookResizePointerId = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add("dragging-notebook");
  }

  resizeNotebookFromPointer(event) {
    if (event.pointerId !== this.notebookResizePointerId) return;
    const minimumLeft = 0;
    const maximumLeft = Math.max(minimumLeft, window.innerWidth - 334);
    this.settings.notebook_left = Math.max(minimumLeft, Math.min(maximumLeft, Math.round(event.clientX)));
    document.documentElement.style.setProperty("--notebook-panel-left", `${this.settings.notebook_left}px`);
  }

  finishNotebookResize(event) {
    if (event.pointerId !== this.notebookResizePointerId) return;
    this.notebookResizePointerId = null;
    document.body.classList.remove("dragging-notebook");
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    this.saveSettings();
  }

  setNotebookOpen(open, options = {}) {
    const shouldOpen = !!open;
    if (!shouldOpen) {
      void this.flushNotebook();
      this.closeNotebookFind(false);
    }
    const panel = this.$("notebook-panel");
    const animateClose = !shouldOpen && panel && !panel.classList.contains("hidden") &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    clearTimeout(this.notebookCloseTimer);
    this.notebookCloseTimer = null;
    if (animateClose) panel.classList.add("notebook-closing");
    this.settings.notebook_open = shouldOpen;
    this.renderNotebook();
    if (animateClose) this.notebookCloseTimer = window.setTimeout(this.finishNotebookClose.bind(this), 180);
    this.saveSettings();
    if (!shouldOpen && options.focus !== false) requestAnimationFrame(() => this.focusActiveEditor());
    if (this.settings.notebook_open && options.focus !== false) {
      requestAnimationFrame(() => this.focusNotebookEditor());
    }
  }

  toggleNotebook() {
    this.setNotebookOpen(!this.settings.notebook_open, { focus: true });
  }

  focusNotebookEditor() {
    const host = this.$("notebook-editor-host");
    if (!host) return;
    if (this.notebookEditor && this.notebookMounted) {
      this.notebookEditor.focus();
      return;
    }
    const target = host.querySelector("textarea");
    if (target) {
      target.focus();
      return;
    }
    host.focus();
  }

  shouldReconnectIdleClaudeView(view, session, previousId) {
    if (!view || !session || session.agent_kind !== "claude" || previousId === session.session_id ||
        view.closed || view.replaying || view.scrollMode !== "follow" || !view.hiddenAt || !view.ws ||
        view.ws.readyState !== WebSocket.OPEN || view.hiddenOutputPending || !session.processing) return false;
    return Date.now() - view.hiddenAt >= TERMINAL_CLAUDE_IDLE_RECONNECT_MS;
  }

  reconnectIdleClaudeView(view) {
    if (!view?.ws || view.closed || view.reconnectAfterClose) return;
    view.reconnectAfterClose = true;
    view.suppressReconnect = true;
    view.ws.close(1000, "idle Claude terminal replay");
  }

  scheduleClaudeInitialReplayRecovery(id, view) {
    if (!this.attachRepaintEnabled()) return;
    if (!view || view.closed || view.claudeInitialReplayRecoveryAttempted || view.claudeInitialReplayCheckTimer) return;
    clearTimeout(view.claudeInitialReplayCheckTimer);
    view.claudeInitialReplayCheckTimer = setTimeout(this.recoverClaudeInitialReplay.bind(this, id, view), 900);
  }

  recoverClaudeInitialReplay(id, view) {
    view.claudeInitialReplayCheckTimer = 0;
    if (view.closed || view.claudeInitialReplayRecoveryAttempted || this.activeId !== id || this.historyOpen ||
        this.activeFileKey !== null || !view.container.classList.contains("visible") || view.replaying || !view.ws ||
        view.ws.readyState !== WebSocket.OPEN || this.session(id)?.agent_kind !== "claude") return;
    const buffer = view.term?.buffer?.active;
    if (!buffer || buffer.baseY > view.term.rows + 2) return;
    view.claudeInitialReplayRecoveryAttempted = true;
    this.reconnectIdleClaudeView(view);
  }

  activate(id, options = {}) {
    this.closePromptHistory();
    this.hideSelectionActions(true);
    const previousId = this.activeId;
    const selected = this.session(id);
    if (this.worktreeId === ALL_WORKTREES_ID && selected) {
      this.interactionWorktreeId = this.worktreeIdForSession(selected);
    }
    if (!selected?.needs_attention) this.clearSessionAttention(id);
    let unreadChanged = false;
    if (previousId && previousId !== id) {
      unreadChanged = this.unreadSessions.delete(previousId) || unreadChanged;
      this.updateUnreadIndicator(previousId);
    }
    if (previousId !== id) {
      unreadChanged = this.unreadSessions.delete(id) || unreadChanged;
      this.updateUnreadIndicator(id);
    }
    if (unreadChanged) {
      this.persistUnreadSessionDelta([previousId, id].filter(Boolean), false);
    }
    this.rememberRecentlyOpenedTerminal(id);
    if (selected && !this.titlePresentation(selected).spinning) this.viewedCompletedSessions.add(id);
    else this.viewedCompletedSessions.delete(id);
    if (selected) {
      const spinning = this.titlePresentation(selected).spinning;
      const processingSince = Number(selected.processing_since);
      if (processingSince > 0 && !this.processingSince.has(id)) this.processingSince.set(id, processingSince * 1000);
      this.processingStates.set(id, spinning);
      if (spinning && !this.processingSince.has(id)) this.processingSince.set(id, Date.now());
      if (!spinning) this.processingSince.delete(id);
    }
    if (this.historyOpen && previousId) this.rememberHistoryScrollPosition(previousId);
    this.saveActiveFileViewState();
    this.lspClient?.deactivate();
    this.activeFileKey = null;
    this.stopHistoryRefresh();
    this.disconnectHistoryStream();
    this.historyOpen = false;
    this.historyFingerprint = "";
    const cachedHistory = this.historyTurnsBySession.get(id) || [];
    this.historyTurns = cachedHistory;
    this.historyLoaded = cachedHistory.length > 0;
    const previousView = previousId ? this.views.get(previousId) : null;
    this.activeId = id;
    this.updateRecentFilesWatch();
    this.historyOpen = this.selectedHistoryMode(selected);
    if (options.history !== false) this.pushNav({ kind: "term", id });
    if (this.getProjectState().active_session_id !== id) {
      this.patchProjectState({ active_session_id: id });
    }
    const s = this.session(id);
    this.postVscodeNativeSession(s, !this.historyOpen);
    if (s && this.treeRoot !== null && this.treeRoot !== s.cwd && !this.$("files-section").classList.contains("hidden")) {
      this.reloadTree();
    }
    const view = this.ensureView(id);
    if (previousView && previousView !== view) previousView.term.clearSelection();
    if (previousView && previousView !== view) {
      if (this.isTerminalScrollV2()) {
        const previousAtBottom = this.xtermAtBottom(previousView);
        previousView.scrollMode = previousAtBottom || !previousView.userScrollIntent ? "follow" : "preserve";
        if (previousAtBottom || !previousView.userScrollIntent) previousView.userScrollIntent = false;
        // Captured as an OFFSET, not the absolute viewportY: if this tab's background websocket has
        // closed by the time we come back to it, reactivating it resets and replays the whole buffer
        // from scratch (see ws.onopen's view.term.reset()), making an absolute row index meaningless
        // against the freshly rebuilt buffer. "N rows above the latest line" survives that rebuild.
        previousView.preserveRowsFromBottom = previousView.scrollMode === "preserve"
          ? previousView.term.buffer.active.baseY - previousView.term.buffer.active.viewportY : 0;
      } else {
        // xterm's buffer viewport can still report the old bottom row while
        // the browser scrollbar has already moved. Carry the native position
        // across tab switches so returning to a manually scrolled tab does not
        // re-enable bottom-follow and jump by several pages.
        previousView.keepBottom = !previousView.manualScroll && this.terminalAtBottom(previousView);
        previousView.wasAtBottom = previousView.keepBottom;
        if (!previousView.keepBottom) previousView.pinBottomUntil = 0;
      }
    }
    const switchedViews = previousView !== view;
    if (switchedViews && previousView) this.clearActiveTerminalSettleWatchdog(previousView);
    const activatedAt = Date.now();
    for (const [viewId, v] of this.views) {
      const visible = viewId === id;
      const wasVisible = v.container.classList.contains("visible");
      v.container.classList.toggle("visible", visible);
      if (visible) {
        v.lastShownAt = activatedAt;
      } else if (wasVisible) {
        v.hiddenAt = activatedAt;
      }
    }
    this.applyMainLayout();
    this.scheduleTerminalLayoutFit();
    if (!this.$("terminal-find").classList.contains("hidden")) this.updateTerminalFindMatches();
    if (this.historyOpen) {
      const historyId = id;
      if (previousId !== id) {
        // Do not leave the previous tab's transcript rendered while a fork's
        // authoritative snapshot is being loaded.
        this.historyTurns = [];
        this.historyLoaded = false;
        const body = this.$("history-body");
        if (body) {
          body.textContent = "";
          const loading = document.createElement("div");
          loading.className = "history-empty";
          loading.textContent = "loading transcript…";
          body.appendChild(loading);
        }
      } else if (cachedHistory.length) {
        this.applyHistoryTurns(historyId, cachedHistory, { preserveScroll: false });
      }
      this.connectHistoryStream(historyId, { fresh: previousId !== id });
    }
    if (view) {
      this.prepareTerminalForFirstPaint(view);
      if (this.isTerminalScrollV2() && !view.userScrollIntent) view.scrollMode = "follow";
      this.refreshTerminalAppearance(view);
      if (this.shouldReconnectIdleClaudeView(view, s, previousId)) this.reconnectIdleClaudeView(view);
      else if (!view.ws) this.connect(id, view);
      if (this.isTerminalScrollV2()) {
        // Only a genuinely first-ever connection should default to follow mode. A background tab's
        // websocket can close on its own (ws.onclose only auto-reconnects the ACTIVE tab, by design,
        // to avoid reconnecting every backgrounded session) and then reconnect right here via
        // `!view.ws` above the moment it's reactivated -- that reconnect ALSO sets
        // awaitingSnapshot/replaying, so including them in this condition overwrote a correctly
        // recorded "preserve" (the user had scrolled up before leaving this tab) back to "follow" on
        // every such reconnect. everConnected alone distinguishes the two: it starts false only for a
        // view that has never connected at all, and stays true across every later reconnect. Ground-
        // truth confirmed: a reconnected view's buffer resets and replays from scratch (baseY drops
        // then regrows), and this forced "follow" combined with that replay is what made switching
        // back to an already-scrolled-up tab land near the top once the buffer regrew past wherever
        // the early, still-small-buffer scrollToBottom had landed.
        if (previousId !== id && !view.everConnected) {
          view.scrollMode = "follow";
        }
        // A tab the user explicitly scrolled up on (scrollMode "preserve") was, by definition, already
        // rendering correctly before they left it -- you cannot scroll up on a black/broken pane. Every
        // fit/reflow/repair call below exists to fix a FRESH connect or reconnect that might be showing
        // stale/incomplete content; none of that applies here, and ground-truth testing found that these
        // calls can themselves corrupt the scroll position on a tab that never needed fixing (the exact
        // "switching between half-scrolled tabs jumps to the top" bug, still unresolved after several
        // attempts at making each individual call scroll-position-safe). Skip the whole pipeline for this
        // case and let the CSS visibility toggle alone reveal whatever is already sitting in the DOM,
        // untouched -- the original "views stay alive" design intent before any of that machinery existed.
        // A genuine container-size change while backgrounded is still caught independently by
        // view.layoutObserver's own ResizeObserver, which runs regardless of activation.
        const needsFreshConnectHandling = previousId !== id && (!view.everConnected || view.awaitingSnapshot || view.replaying);
        if (view.scrollMode === "preserve" && !needsFreshConnectHandling) {
          // Nothing to do: no fit, no reflow, no repair, no watchdog.
        } else {
          const forceFit = previousId !== id || this.shouldForceTerminalActivationReflow(view, switchedViews);
          this.scheduleV2Fit(view, { force: forceFit });
          this.scheduleInitialV2Fit(view);
          if (view.scrollMode === "follow") this.scrollTerminalV2ToBottom(view);
          this.scheduleTerminalActivationRepair(view, {
            forceReflow: this.shouldForceTerminalActivationReflow(view, switchedViews),
          });
          this.scheduleActiveTerminalSettleWatchdog(view);
        }
      } else if (previousId !== id) {
        const needsInitialFollow = !view.everConnected || view.awaitingSnapshot || view.replaying;
        if (needsInitialFollow || view.keepBottom) {
          // A new/replaying terminal needs a few frames to settle. An
          // already-connected terminal is only settled when it was already at
          // the bottom; manually scrolled tabs must retain their position.
          view.keepBottom = true;
          const settleWindow = needsInitialFollow ? 5000 : 750;
          view.pinBottomUntil = Date.now() + settleWindow;
          this.scrollTerminalToBottom(view);
        } else {
          view.pinBottomUntil = 0;
        }
      } else if (view.keepBottom) {
        view.pinBottomUntil = Date.now() + 3000;
      }
      if (!this.isTerminalScrollV2()) {
        this.scheduleViewportSettle(view);
        if (view.needsViewportRepair && !view.outputQueue.length && !view.manualScroll && view.keepBottom) {
          view.needsViewportRepair = false;
          this.repairTerminalViewport(view);
        }
      }
    }
    this.renderList();
    this.renderTopbar();
    if (this.conversationOutlineOpen && previousId !== id) void this.loadConversationOutline(true);
    if (options.reveal) this.keepActiveSessionVisible();
    this.scheduleActiveEditorFocus(id);
  }

  ensureView(id) {
    if (this.views.has(id)) return this.views.get(id);
    const container = document.createElement("div");
    container.className = "term-container initializing";
    // Tall-terminal-probe worktree only: xterm.js has no concept of scrolling within an oversized
    // "current screen" -- its own viewport only becomes scrollable once content has genuinely scrolled
    // into real backscroll (baseY > 0). Confirmed directly: with rows forced to 1000, term.scrollToBottom()
    // and term.scrollLines(200) both left viewportY pinned at 0, and .xterm-viewport measured
    // maxScrollTop=0 even with the cursor 200+ rows below the visible fold. Real TermDeck never hits this
    // (sessions stay around 30-50 rows, matching the visible area exactly, so there's nothing to scroll).
    // The fix used here sidesteps xterm's scroll model entirely instead of fighting it: `inner` (not
    // `container`) is what gets passed to term.open() and is what FitAddon measures, and its height is set
    // to the real pixel height of FORCE_ROWS rows. xterm therefore just sees an ordinary, fully-fitting,
    // very tall terminal -- nothing about its rendering or internal scroll logic is unusual. `container`
    // stays the normal small visible area (unchanged everywhere else in this file: layout, visibility
    // checks, resize observers) but now has native CSS overflow-y scrolling, so the browser's own
    // scrollbar/wheel/trackpad handling -- not xterm's -- is what moves through the tall inner content.
    const inner = document.createElement("div");
    inner.className = "term-inner";
    container.appendChild(inner);
    this.$("terminal-area").appendChild(container);
    // "wheel" specifically, not "scroll": confirmed live that a generic "scroll" event cannot be trusted
    // to mean the user acted -- xterm repositions its hidden input textarea to track the cursor (for IME
    // candidate-window placement), and while that textarea stays focused, the browser's own "keep the
    // focused element in view" behavior fires ordinary "scroll" events on this container with no user
    // input and no code of TermDeck's involved. Traced live: that contamination created a feedback loop --
    // one write's post-check reads a scrollTop the browser had already nudged, concludes the user must be
    // following, and every write after that keeps genuinely following, silently overriding a deliberate
    // scroll-away. A wheel/trackpad gesture is a real user action the browser's own auto-scroll can never
    // synthesize, so it's the only signal trusted here.
    //
    // Debounced, not a single deferred frame: a single rAF was tried first and was still too early for a
    // large wheel delta, which Chrome answers with a multi-frame smooth-scroll animation -- confirmed
    // live, that one-frame check read scrollTop before the animation had gone anywhere, computed "still
    // near the cursor", and never re-checked once the animation actually finished moving it away.
    // Debouncing on "no further wheel events for 150ms" is correct regardless of whether a given browser
    // animates the scroll or applies it instantly.
    let tallWheelSettleTimer = 0;
    container.addEventListener("wheel", (event) => {
      const wheelView = this.views.get(id);
      if (wheelView) {
        // Stopping the follow has to be IMMEDIATE, and cannot wait for the debounce below. A streaming
        // agent delivers a write every ~20-50ms, and each write while following snaps back to the bottom
        // -- so a scroll-up was being undone within a frame or two, long before the 150ms settle fired,
        // and the settle then measured a position already dragged back to the bottom and concluded the
        // user still wanted to follow. Measured: scrolling up during active output left following=true
        // with scrollTop pinned to the ceiling across 12 consecutive samples, i.e. it was impossible to
        // read anything while the agent worked. Scrolling UP is unambiguous on its own, so it takes
        // effect on the spot; only the decision to RESUME following needs the settled position, which is
        // what the debounce below still handles.
        if (event.deltaY < 0) wheelView.tallFollowing = false;
        // Writes must not fight an in-progress gesture either: while the wheel is still moving, the
        // not-following branch of drainTerminalWrites would keep restoring an anchor captured before
        // this gesture started, which reads as the view refusing to scroll.
        wheelView.tallWheelActiveUntil = Date.now() + 250;
      }
      clearTimeout(tallWheelSettleTimer);
      tallWheelSettleTimer = setTimeout(() => {
        const view = this.views.get(id);
        if (!view) return;
        view.tallWheelActiveUntil = 0;
        view.tallFollowing = this.tallContainerNearCursor(view);
        // Captured once here, at the settled position, rather than re-sampled per write: each write used
        // to snapshot "wherever scrollTop happens to be right now" as its own restore target, so small
        // incremental drift between rapid keystroke-batches (the browser's scroll-into-view nudge,
        // individually too small to flip tallFollowing) could still accumulate write over write even while
        // tallFollowing correctly stayed false throughout -- confirmed live.
        if (!view.tallFollowing) this.tallCaptureAnchorRow(view);
      }, 150);
    }, { passive: true });
    // A hard ceiling, not an intent signal -- unlike the "wheel" listener above, this one never decides
    // anything about the user, it just enforces tallMaxScrollTop (see its own comment) whenever a scroll
    // lands past it, however that scroll happened: native or programmatic, deliberate or the browser's own
    // focus-driven auto-scroll.
    //
    // Deferred until scrolling stops, though, because clamping cannot win an argument with a scroll source
    // that is still running. Dragging the scrollbar thumb is one: the browser re-derives scrollTop from the
    // held pointer every frame, so an immediate clamp was overwritten and re-clamped frame after frame,
    // which reads as the text tearing between two positions at once. Waiting for a short quiet period
    // means the drag simply wins while it lasts and gets clamped once, cleanly, on release. Nothing is
    // lost by waiting: the wheel handler below already refuses to overshoot in the first place, so this
    // path only ever sees drags and programmatic jumps.
    let tallClampTimer = 0;
    const scheduleTallSettle = () => {
      const watching = this.views.get(id);
      if (!watching || watching.closed) return;
      // Remember where the settle was scheduled from, so the callback can tell whether the view is
      // actually still. Events alone are not enough to know that: our own writes are skipped as echoes
      // below, and the browser coalesces bursts, so a gesture can keep moving while this listener hears
      // nothing -- and a settle that fires mid-gesture is exactly the clamp that tears the view.
      watching.tallSettleWatchTop = container.scrollTop;
      clearTimeout(tallClampTimer);
      tallClampTimer = setTimeout(() => {
        const settled = this.views.get(id);
        if (!settled || settled.closed) return;
        // A held pointer is the one case a quiet period cannot detect: holding the thumb still IS quiet,
        // right up until a clamp perturbs it, and then the browser re-derives scrollTop from the pointer
        // that is still down and undoes the clamp -- which fires another settle, forever. Measured as a
        // steady ~150ms pulse while the thumb was held at the bottom. So while any pointer is down on
        // this terminal, nothing here moves the view; release re-runs this once.
        if (settled.tallPointerHeld) return;
        if (Math.abs(container.scrollTop - (settled.tallSettleWatchTop || 0)) > 2) {
          scheduleTallSettle();   // moved since scheduling: still in flight, wait for real quiet
          return;
        }
        settled.tallScrollActiveUntil = 0;
        if (settled.tallMaxScrollTop != null &&
            container.scrollTop > settled.tallMaxScrollTop + TALL_OVERSHOOT_DEADZONE_PX) {
          this.tallSetScrollTop(settled, settled.tallMaxScrollTop);
        }
        this.tallApplySettledScroll(settled);
      }, TALL_SCROLL_SETTLE_MS);
    };
    // Pointer-held tracking. Registered on the container in capture so a scrollbar interaction counts,
    // and released from the window because the pointerup can land anywhere once a drag is under way.
    const releaseTallPointer = () => {
      const view = this.views.get(id);
      window.removeEventListener("pointerup", releaseTallPointer, true);
      window.removeEventListener("pointercancel", releaseTallPointer, true);
      if (!view || view.closed) return;
      view.tallPointerHeld = false;
      scheduleTallSettle();       // now that it is released, let it settle exactly once
    };
    container.addEventListener("pointerdown", () => {
      const view = this.views.get(id);
      if (!view || view.closed) return;
      view.tallPointerHeld = true;
      window.addEventListener("pointerup", releaseTallPointer, true);
      window.addEventListener("pointercancel", releaseTallPointer, true);
    }, { capture: true, passive: true });
    container.addEventListener("scroll", () => {
      const view = this.views.get(id);
      if (!view || view.closed) return;
      // Our own scrolls must not read as the user scrolling, or following would flip on every write.
      // Matching on value ALONE is wrong: the user scrolling to the bottom lands on exactly the ceiling
      // we last set ourselves, so a real gesture was being discarded as an echo -- which is what left the
      // pinned viewport stale and the newest lines unreachable. The echo of our own write arrives within
      // a frame or two, so requiring it to be recent as well tells the two apart.
      const echoOfOurOwnWrite = container.scrollTop === view.tallLastProgrammaticTop &&
        performance.now() - (view.tallProgrammaticAt || 0) < TALL_PROGRAMMATIC_ECHO_MS;
      if (echoOfOurOwnWrite) return;
      // Marks a gesture as in progress. Writes check this and leave the view completely alone while it is
      // set: a scrollbar drag or an autoscroll keeps producing scroll events, and a write that re-asserts
      // the follow position in the middle of one is what tears the text between two positions.
      view.tallScrollActiveUntil = Date.now() + TALL_SCROLL_ACTIVE_MS;
      scheduleTallSettle();
    }, { passive: true });
    // The scrollback bridge for the CSS's overflow-y:hidden on .xterm-viewport (see style.css). That rule
    // takes xterm's own viewport out of the scroll chain so there's a single scroll surface, but the
    // scrollback it used to scroll through is still real content that has to stay reachable -- this hands
    // it whatever delta the container can't absorb, so one continuous gesture runs container-first and
    // then into scrollback, rather than the reverse order the browser's chaining used to impose.
    //
    // Deliberately edge-only, and non-passive only where it actually acts: while the container still has
    // room in the direction being scrolled, this returns without touching the event, leaving the browser's
    // native scrolling (and its trackpad momentum, which a manual scrollTop-per-event implementation
    // cannot reproduce) to handle the common case untouched.
    container.addEventListener("wheel", (event) => {
      const view = this.views.get(id);
      if (!view || view.closed || !event.deltaY) return;
      const buffer = view.term.buffer.active;
      const up = event.deltaY < 0;
      // Absorb downward overscroll rather than letting the browser take it and correcting afterwards.
      // .term-inner is a fixed FORCE_ROWS tall no matter how little content exists, so the browser's own
      // max scroll sits thousands of pixels below the last line, and a scroll past the end used to be
      // painted out there and then yanked back by the "scroll" listener's clamp -- the visible bounce at
      // the bottom. Worst on a nearly empty terminal, where the ceiling can be 0 and the overshoot is the
      // full canvas. Clamping the gesture here means the overshoot is never painted at all. Trackpad
      // momentum keeps firing wheel events, so this has to absorb those too, which it does by staying on
      // the clamp branch once scrollTop has reached the ceiling.
      if (!up && view.tallMaxScrollTop != null && container.scrollTop + event.deltaY > view.tallMaxScrollTop) {
        event.preventDefault();
        if (container.scrollTop !== view.tallMaxScrollTop) this.tallSetScrollTop(view, view.tallMaxScrollTop);
        return;
      }
      // The container is the outer surface in both directions: going up, it has to bottom out at 0 before
      // scrollback is in play; going down, any pending scrollback has to be spent BEFORE the container
      // moves again, or the two would run in the wrong order and the content would jump.
      if (up ? container.scrollTop > 0 : buffer.viewportY >= buffer.baseY) return;
      if (up && buffer.viewportY <= 0) return;
      const cellHeight = view.term._core?._renderService?.dimensions?.css?.cell?.height;
      if (!cellHeight) return;
      event.preventDefault();
      const lines = event.deltaY / cellHeight;
      view.term.scrollLines(lines < 0 ? Math.floor(lines) : Math.ceil(lines));
    }, { passive: false });
    const term = new Terminal({
      fontSize: this.settings.terminal_font_size, fontFamily: '"SF Mono", Menlo, monospace', letterSpacing: -0.2, theme: this.termTheme(),
      scrollback: 20000, cursorBlink: true, macOptionIsMeta: true, allowProposedApi: true,
    });
    const fit = new FitAddon.FitAddon();
    const terminalFindAddon = new SearchAddon.SearchAddon({ highlightLimit: TERMINAL_FIND_HIGHLIGHT_LIMIT });
    term.loadAddon(fit);
    if (terminalFindAddon) term.loadAddon(terminalFindAddon);
    // The other half of taking xterm out of the scroll chain (style.css's overflow-y:hidden on
    // .xterm-viewport is the first half, and on its own does nothing here). xterm does not rely on that
    // element's CSS overflow to scroll -- it registers its own non-passive "wheel" listener and drives the
    // buffer directly, so the CSS rule alone left the measured two-stage behavior completely unchanged.
    // Returning false from this hook is xterm's supported way to say "ignore this wheel event", which
    // leaves the browser to scroll the one remaining scrollable ancestor: .term-container.
    //
    // Unconditional, including on the alternate screen. In a normal terminal xterm translates wheel into
    // arrow keys there, which is right because the alt screen is exactly one screenful with nothing to
    // scroll over -- but that premise does not survive 1000 forced rows. A full-screen app here paints a
    // 1000-row UI of which .term-container shows ~37, so the wheel's first job is moving the viewport
    // over what the app already painted, which only the container can do. Measured: `seq 1 500 | less`
    // painted all 500 lines at once into rows 499-998; letting xterm keep the wheel would have left ~963
    // painted rows unreachable by mouse.
    //
    // Known tradeoff, not an oversight: for content that overflows even 1000 rows (`seq 1 5000 | less`),
    // the app does still have somewhere to scroll, and the wheel no longer tells it so -- paging past the
    // painted rows needs the keyboard. Bridging the container's bottom edge back into arrow keys the way
    // the normal screen bridges into scrollback would fix that, but it needs the app-cursor-keys mode off
    // xterm's private coreService to pick the right escape sequence, so it is left alone here.
    term.attachCustomWheelEventHandler(() => false);
    term.open(inner);
    // Real cell height is only known once xterm has measured the font, which happens synchronously inside
    // open(). The row count is an explicit pixel height rather than something derived from the container
    // (the FitAddon-based approach tried earlier) because it has to stay fixed across every later resize
    // -- if it tracked the container's height the way a normal terminal does, this collapses straight back
    // to the problem being solved.
    //
    // Height and renderer are chosen together by tallRowPlan (see it for the arithmetic). WebGL backs the
    // terminal with one drawing buffer sized to the FULL terminal, so an over-tall terminal does not fail
    // loudly -- it silently corrupts, which is what the solid-black screen at 1000 rows was. So the WebGL
    // mode takes the tallest height the GPU can back and the DOM mode, which has no texture limit at all,
    // is what buys the full 1000 rows.
    const cellHeight = term._core?._renderService?.dimensions?.css?.cell?.height || 17;
    const rowPlan = this.tallRowPlan(cellHeight);

    inner.style.height = `${Math.round(rowPlan.rows * cellHeight)}px`;
    if (rowPlan.webgl) this.enableWebglRenderer(term);
    term.registerLinkProvider({ provideLinks: (y, cb) => this.providePathLinks(term, id, y, cb) });
    const view = { sessionId: id, container, term, fit, terminalFindAddon, tallRows: rowPlan.rows,
                   terminalFindResultIndex: -1,
                   terminalFindResultCount: 0, terminalFindResultListener: null,
                   ws: null, closed: false, everConnected: false, awaitingSnapshot: true,
                   replaying: false, pasting: false, suppressReconnect: false, cliTitle: null, pinBottomUntil: 0,
                   programmaticScrollUntil: 0, programmaticScrollGeneration: 0, scrollSettleTimer: 0,
                   reconnectTimer: 0, settleFrame: 0, viewportRepairFrame: 0, needsViewportRepair: false,
                   resizeRepairTimer: 0, outputQueue: [], outputWriteInFlight: false, outputWriteGeneration: 0,
                   layoutObserver: null, scrollObserver: null, visibilityObserver: null,
                   layoutFitRetryTimer: 0, layoutFitRetryCount: 0,
                   keepBottom: true, manualScroll: false, manualScrollGeneration: 0, manualScrollReleaseTimer: 0,
                   wasAtBottom: true, scrollMode: "follow", v2Programmatic: false, v2FitFrame: 0,
                   userScrollIntent: false,
                   v2InitialFitPending: true, v2InitialFitFrame: 0, hiddenOutputPending: false, v2ViewportSyncFrame: 0,
                   forceResizeAfterFit: true, initialSnapshotPainted: false, v2ForcedReflowFrame: 0, v2ForcedReflowRestoreFrame: 0,
                   suppressResizeToServer: false, resyncResizeRepairPending: false,
                   hiddenAt: 0, lastShownAt: 0, lastActivationReflowAt: 0,
                   tailRepairFrame: 0, tailRepairTimer: 0, tailRepairConfirmTimer: 0,
                   activationRepairFrame: 0, tailRepairSignature: "", lastRenderRepairAt: 0,
                   renderedRows: [], renderedViewportY: null, renderedCols: 0, renderedTermRows: 0,
                   renderRepairArmed: true, renderObserver: null,
                   viewportAnchorRestore: null, viewportAnchorRestoreTimer: 0,
                   lastSentCols: null, lastSentRows: null, settleWatchdogTimers: [], codexReflowFollowupTimers: [],
                   preserveRowsFromBottom: 0, reconnectReset: false,
                   promptDraft: this.session(id)?.draft || "", markdownPromptDraft: this.markdownPromptDraftForSession(id),
                   promptPaste: false, promptEscape: "", promptEditing: false,
                   promptSubmitting: false, promptSubmitEntered: false, promptSubmitTimer: 0,
                   promptSubmissionReflowGuardUntil: 0, promptSubmissionReflowGuardTimer: 0,
                   manualRepaintClickCount: 0, manualRepaintClickTimer: 0, manualRepaintLastClickAt: 0,
                   attentionScreenDetectionSuppressed: false,
                   reconnectAfterClose: false, claudeInitialReplayCheckTimer: 0,
                   claudeInitialReplayRecoveryAttempted: false,
                   claudeStatusRowRefreshTimer: 0, historyModelRefreshTimer: 0, lastClaudeStatusRowRefreshAt: 0,
                   codexFocusRefreshFrame: 0,
                   promptQueue: this.markdownPromptQueueForSession(id), promptQueueEditIndex: null, promptQueueDispatching: false,
                   promptDraftSyncPending: false, promptDraftSyncTimer: 0, promptDraftSyncDebounceTimer: 0,
                   pendingDraftSync: null, pendingTerminalDraft: null, pendingAgentPaste: "", pendingAgentPasteTimer: 0,
                   pendingAgentPasteStartedAt: 0, pendingAgentPasteReadyAt: 0,
                   promptEditVersion: 0, promptSubmitVersion: -1 };
    view.terminalFindResultListener = terminalFindAddon?.onDidChangeResults((result) => this.updateTerminalFindResultCount(view, result)) || null;
    const releaseManualScrollWhenStable = () => {
      clearTimeout(view.manualScrollReleaseTimer);
      const generation = view.manualScrollGeneration;
      view.manualScrollReleaseTimer = setTimeout(() => {
        view.manualScrollReleaseTimer = 0;
        if (view.closed || !view.manualScroll || generation !== view.manualScrollGeneration) return;
        const atBottom = this.terminalAtBottom(view);
        if (!atBottom) {
          view.wasAtBottom = false;
          view.keepBottom = false;
          view.pinBottomUntil = 0;
          return;
        }
        // A wheel event can be delivered before xterm has updated its native
        // viewport. Only leave manual mode after the position remains at the
        // bottom long enough for that layout/reflow to settle.
        view.manualScroll = false;
        view.wasAtBottom = true;
        view.keepBottom = true;
      }, 180);
    };
    const markV2Preserve = () => {
      if (!this.isTerminalScrollV2()) return;
      this.cancelTerminalViewportRestore(view);
      // Wheel/scrollbar intent arrives before xterm publishes onScroll().
      // Preserve immediately so a live output callback in that gap cannot
      // pull the viewport back to the prompt.
      view.v2Programmatic = false;
      view.userScrollIntent = true;
      view.scrollMode = "preserve";
    };
    const markManualScroll = () => {
      if (this.isTerminalScrollV2()) {
        markV2Preserve();
        return;
      }
      // wheel fires before the browser moves the native xterm viewport, so
      // checking terminalAtBottom() here can still report the old bottom
      // position and leave auto-follow enabled.  Any wheel gesture is an
      // explicit request to browse, regardless of its current position.
      view.pinBottomUntil = 0;
      view.keepBottom = false;
      view.manualScroll = true;
      view.manualScrollGeneration += 1;
      view.wasAtBottom = false;
      releaseManualScrollWhenStable();
      if (view.settleFrame) {
        cancelAnimationFrame(view.settleFrame);
        view.settleFrame = 0;
      }
      if (view.viewportRepairFrame) {
        cancelAnimationFrame(view.viewportRepairFrame);
        view.viewportRepairFrame = 0;
      }
      view.needsViewportRepair = false;
      clearTimeout(view.scrollSettleTimer);
      view.scrollSettleTimer = 0;
    };
    view.renderObserver = term.onRender(({ start, end }) => this.recordTerminalRenderedRows(view, start, end));
    this.refreshTerminal(view);
    container.addEventListener("focusin", () => this.scheduleCodexFocusTailRefresh(view));
    container.addEventListener("click", (event) => this.handleManualCodexRepaintClick(event, view, id), true);
    // Capture before xterm's wheel handler so the first wheel after a tab
    // switch cannot be mistaken for an automatic bottom-follow scroll.
    container.addEventListener("wheel", markManualScroll, { passive: true, capture: true });
    container.addEventListener("paste", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const cd = e.clipboardData || window.clipboardData;
      const files = cd && cd.files && cd.files.length ? [...cd.files] : [];
      if (files.length) { this.uploadAndInsert(view, files); return; }
      const text = cd && (cd.getData("text/plain") || cd.getData("text"));
      if (!text || !view.ws || view.ws.readyState !== WebSocket.OPEN) return;
      // Pasting is real input, so it returns to the prompt the way typing does -- the Cmd+V chord itself
      // is ignored by the key handler above (it cannot tell paste from copy), so this is where it lands.
      view.tallFollowing = true;
      this.scrollTallContainerToCursor(view);
      this.sendTrackedInput(view, this.terminalPastePayload(view, text));
    }, true);
    container.addEventListener("dragover", (e) => { e.preventDefault(); container.classList.add("drag-over"); });
    container.addEventListener("dragleave", (e) => { if (e.target === container) container.classList.remove("drag-over"); });
    container.addEventListener("drop", (e) => {
      e.preventDefault();
      container.classList.remove("drag-over");
      const files = e.dataTransfer && e.dataTransfer.files ? [...e.dataTransfer.files] : [];
      if (files.length) this.uploadAndInsert(view, files);
    });
    term.onTitleChange((t) => {
      const title = t.trim();
      if (!title || title === view.cliTitle) return;
      view.cliTitle = title;
      const s = this.session(id);
      // The backend status stream is authoritative for processing. Do not
      // mark a session active merely because its xterm title was replayed
      // when the user selected the tab.
      if (s) s.cli_title = title;
      const titleEl = this.sessionTitleEls.get(id);
      if (titleEl && s) titleEl.textContent = this.titlePresentation(s).text;
      this.updateProcessingState(id, !!s && this.titlePresentation(s).spinning);
      if (id === this.activeId) this.renderTopbar();
    });
    term.attachCustomKeyEventHandler((e) => {
      // xterm's PageUp/Home family scrolls its viewport without a wheel or
      // scrollbar pointer event. Treat those as an explicit browse action so
      // a pending output/layout repair cannot pull the terminal back down.
      if (e.type === "keydown" && ["PageUp", "PageDown", "Home", "End"].includes(e.key)) {
        if (this.isTerminalScrollV2()) markV2Preserve();
        else markManualScroll();
      }
      // Typing means the user is done reading whatever they scrolled up to look at, so resume following
      // -- otherwise they type blind into a prompt that is somewhere off-screen. xterm's own
      // scrollOnUserInput cannot do this here: it scrolls xterm's viewport, which is not the surface
      // being scrolled any more (see the tall-container comments above).
      //
      // A real KeyboardEvent is the signal, NOT sendInput/onData. onData carries far more than typing:
      // xterm answers terminal queries (DSR/DA) through it, and with the modes an agent CLI enables it
      // also emits focus-in/out and mouse reports there. An agent working produces a steady stream of
      // those, so resuming follow from onData meant the view snapped to the bottom continuously while
      // output streamed, making it impossible to read anything scrolled back. This handler only ever
      // sees genuine key events. PageUp/Home above are deliberately excluded by ordering: they browse
      // rather than type, and the block above has already marked them as such.
      //
      // "Typing" excludes Cmd chords and bare modifier presses. Cmd+C is the case that matters: copying
      // means the user has scrolled back, selected something, and is reading it -- scrolling to the prompt
      // there throws away the very thing they are copying. Cmd never reaches the shell anyway, so a Cmd
      // chord is never terminal input. Ctrl and Alt deliberately still count: on this platform those DO
      // produce terminal input (Ctrl+C interrupts, Alt+B/F move by word), so they are real typing.
      // Pasting is real input too, but arrives on the paste listener rather than here.
      const tallTypingKey = e.type === "keydown" && !e.metaKey &&
        !["PageUp", "PageDown", "Home", "End"].includes(e.key) &&
        !["Shift", "Meta", "Control", "Alt", "CapsLock"].includes(e.key);
      if (tallTypingKey) {
        const tallView = this.views.get(id);
        if (tallView) {
          tallView.tallFollowing = true;
          this.scrollTallContainerToCursor(tallView);
        }
      }
      return this.handleTerminalEditingKeys(view, e);
    });
    term.onData((data) => this.sendTrackedInput(view, data));
    term.onResize(({ cols, rows }) => {
      if (!view.suppressResizeToServer) this.sendResize(view, cols, rows);
    });
    term.onScroll(() => {
      if (!view.container.classList.contains("visible")) return;
      if (this.isTerminalScrollV2()) {
        if (!view.v2Programmatic) {
          if (this.xtermAtBottom(view)) {
            view.scrollMode = "follow";
            view.userScrollIntent = false;
          } else if (view.userScrollIntent) {
            view.scrollMode = "preserve";
          }
          this.scheduleTerminalTailRepair(view);
        }
        return;
      }
      // xterm can emit its internal scroll event before the browser updates
      // .xterm-viewport.scrollTop. Keep the manual-scroll lock until the
      // delayed stability check sees the user's real position.
      if (view.manualScroll) {
        if (this.terminalAtBottom(view)) releaseManualScrollWhenStable();
        return;
      }
      // scrollToBottom() can emit before xterm has committed the matching DOM
      // scroll position. Do not let that stale event turn off following and
      // strand the live prompt one viewport above the bottom. Manual wheel,
      // scrollbar, and keyboard browsing increment the generation first, so
      // they still leave follow mode immediately.
      if (Date.now() < view.programmaticScrollUntil
          && view.programmaticScrollGeneration === view.manualScrollGeneration) {
        view.wasAtBottom = true;
        view.keepBottom = true;
        return;
      }
      const atBottom = this.terminalAtBottom(view);
      view.wasAtBottom = atBottom;
      view.keepBottom = atBottom;
      if (!view.keepBottom) view.pinBottomUntil = 0;
    });
    const viewport = container.querySelector(".xterm-viewport");
    if (viewport) {
      viewport.addEventListener("pointerdown", (event) => {
        const rect = viewport.getBoundingClientRect();
        const scrollbarEdge = Math.max(18, viewport.offsetWidth - viewport.clientWidth + 4);
        const onScrollbar = event.clientX >= rect.right - scrollbarEdge;
        const touchScroll = event.pointerType && event.pointerType !== "mouse";
        if (onScrollbar || touchScroll) {
          if (this.isTerminalScrollV2()) markV2Preserve();
          else markManualScroll();
        }
      }, { passive: true });
    }
    const scrollArea = container.querySelector(".xterm-scroll-area");
    if (scrollArea) {
      view.scrollObserver = new ResizeObserver(() => {
        if (!view.container.classList.contains("visible") || view.closed) return;
        if (this.isTerminalScrollV2()) return;
        if (view.keepBottom || Date.now() < view.pinBottomUntil) this.scheduleViewportSettle(view);
      });
      view.scrollObserver.observe(scrollArea);
    }
    view.layoutObserver = new ResizeObserver(() => {
      if (!view.container.classList.contains("visible") || view.closed || !this.terminalPageCanResize()) return;
      if (this.sidebarResizeInProgress) return;
      if (this.isTerminalScrollV2()) {
        this.scheduleV2Fit(view);
        return;
      }
      const rect = view.container.getBoundingClientRect();
      if (rect.width < 40 || rect.height < 40) return;
      this.tallFit(view);
      const { cols, rows } = view.term;
      if (cols >= 2 && rows >= 2) this.sendResize(view, cols, rows);
      if (view.keepBottom || Date.now() < view.pinBottomUntil) this.scheduleViewportSettle(view);
    });
    view.layoutObserver.observe(container);
    // xterm suspends its renderer while the container is display:none and resumes from its own
    // IntersectionObserver, so every refresh issued between activation and that resume is dropped.
    // Output written while hidden therefore sits in the buffer unpainted until some later redraw.
    // Repainting from a second observer on the same element covers it in either callback order:
    // after xterm resumes this paints directly, before it the refresh is folded into xterm's resume.
    view.visibilityObserver = new IntersectionObserver((entries) => {
      if (!entries[entries.length - 1].isIntersecting || view.closed) return;
      this.refreshTerminal(view);
    }, { threshold: 0 });
    view.visibilityObserver.observe(container);
    this.views.set(id, view);
    return view;
  }

  prepareTerminalForFirstPaint(view) {
    if (!view || view.closed || !view.container.classList.contains("visible") || !this.terminalPageCanResize()) return false;
    const rect = view.container.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) return false;
    this.tallFit(view);
    this.refreshTerminalAppearance(view);
    view.container.classList.remove("initializing");
    return true;
  }

  connect(id, view) {
    if (view.closed) return;
    if (this.isTerminalScrollV2() && !view.userScrollIntent) {
      view.scrollMode = "follow";
      view.preserveRowsFromBottom = 0;
    }
    // A reconnect that lands with less than a screen of scrollback gets one more chance to restore: the
    view.suppressReconnect = false;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const hasPopulatedBuffer = view.everConnected && !view.closed && view.term?.buffer?.active?.baseY > 0;
    // The server's SIGWINCH repaint is what rebuilds an agent's screen on reattach, so a client that
    // already holds a populated buffer asks it to skip; an empty one always wants the repaint.
    // screen_repaint=0 tells the server to skip its SIGWINCH nudge, which is the repaint that actually
    // makes an agent redraw. With the switch off we never ask for it.
    const screenRepaint = this.attachRepaintEnabled() ? (hasPopulatedBuffer ? 0 : 1) : 0;
    const haveBuffer = hasPopulatedBuffer ? 1 : 0;
    // repaint_preserved_buffer is deliberately not sent: it only ever meant "this client restored a
    // client-side snapshot, so make the agent repaint over it", and that snapshot path is gone. The
    // server defaults the flag to false when the parameter is absent.
    const ws = new WebSocket(`${proto}://${location.host}/ws/${id}?screen_repaint=${screenRepaint}&have_buffer=${haveBuffer}`);
    ws.binaryType = "arraybuffer";
    view.preserveBufferOnReconnect = haveBuffer === 1;
    view.awaitingSnapshot = true;
    view.replaying = false;
    view.needsViewportRepair = false;
    view.outputWriteGeneration += 1;
    view.outputQueue = [];
    view.lastSentCols = null;
    view.lastSentRows = null;
    ws.onopen = () => {
      view.reconnectReset = view.everConnected;
      view.attachActivitySuppressedUntil = Date.now() + TERMINAL_ATTACH_ACTIVITY_SUPPRESSION_MS;
      if (view.everConnected) {
        view.replaying = true;
        if (!this.isTerminalScrollV2()) {
          if (view.keepBottom && !view.manualScroll) view.pinBottomUntil = Date.now() + 8000;
          else view.pinBottomUntil = 0;
        }
      }
      view.everConnected = true;
      this.detectTerminalAttentionFromBuffer(view);
      if (this.isTerminalScrollV2()) {
        if (id === this.activeId) {
          this.scheduleV2Fit(view);
          if (view.scrollMode === "follow") this.scrollTerminalV2ToBottom(view);
        }
      } else if (id === this.activeId && view.keepBottom && !view.manualScroll) {
        this.fitActive();
        view.keepBottom = true;
        view.pinBottomUntil = Date.now() + 8000;
        this.scrollTerminalToBottom(view);
        this.scheduleViewportSettle(view);
      }
      // FitAddon may have run before the websocket opened, so xterm's
      // onResize callback could not send the resulting dimensions to the
      // PTY. Always send the currently fitted size once the socket is ready.
      if (view.term.cols >= 2 && view.term.rows >= 2) {
        this.sendResize(view, view.term.cols, view.term.rows);
      }
      this.flushPromptSync(view);
      this.dispatchNextMarkdownPrompt(view);
      if (view.pendingAgentPaste) this.schedulePendingAgentPaste(view, AGENT_PASTE_RETRY_DELAY_MS);
    };
    ws.onmessage = (e) => {
      if (typeof e.data === "string") { this.handleControl(id, view, JSON.parse(e.data)); return; }
      // xterm's buffer continues to process output while an inactive tab is
      // display:none, but its browser viewport has zero height. Remember that
      // state so activation can synchronize the now-visible scrollbar through
      // xterm's public scroll API, rather than a DOM scroll listener or PTY
      // resize/reflow.
      if (!view.container.classList.contains("visible")) view.hiddenOutputPending = true;
      if (!view.awaitingSnapshot && !view.replaying) view.attentionScreenDetectionSuppressed = false;
      if (!view.awaitingSnapshot && !view.replaying && Date.now() >= (view.attachActivitySuppressedUntil || 0)) {
        this.touchSessionActivity(id);
      }
      if (view.awaitingSnapshot) {
        if (view.reconnectReset && e.data.byteLength > 0 && !view.preserveBufferOnReconnect) {
          view.term.reset();
          this.tallResetScrollState(view);
        }
        const snapshotScrollGeneration = view.manualScrollGeneration;
        const v2 = this.isTerminalScrollV2();
        const followSnapshot = v2 ? view.scrollMode === "follow" : view.keepBottom && !view.manualScroll;
        view.awaitingSnapshot = false;
        view.replaying = true;
        if (!v2) {
          if (followSnapshot) view.pinBottomUntil = Date.now() + 8000;
          else view.pinBottomUntil = 0;
        }
        // The server sends the saved scrollback first, then starts streaming
        // the live PTY queue. Keep the first live frame out of xterm until
        // its asynchronous snapshot write has completed. Otherwise a busy
        // agent can change the scroll-area height mid-replay and leave the
        // final terminal rows outside the native scrollbar range.
        this.queueTerminalWrite(view, new Uint8Array(e.data), () => {
          this.refreshTerminal(view);
          view.replaying = false;
          // Replay finished, so the cursor finally describes the real screen: take the geometry and the
          // follow position from it once, rather than from every intermediate frame.
          this.tallUpdateMaxScrollTop(view);
          if (view.tallFollowing !== false) this.scrollTallContainerToCursor(view);
          this.schedulePendingAgentPaste(view);
          if (!view.reconnectReset && this.session(id)?.agent_kind === "claude") {
            this.scheduleClaudeInitialReplayRecovery(id, view);
          }
          if (v2 && view.container.classList.contains("visible")) {
            const firstSnapshot = !view.initialSnapshotPainted;
            view.initialSnapshotPainted = true;
            view.forceResizeAfterFit = !firstSnapshot;
            this.scheduleV2Fit(view);
          } else if (view.resyncResizeRepairPending && view.container.classList.contains("visible")) {
            // Legacy (non-V2) scroll mode has no equivalent post-snapshot repaint trigger above, so it
            // still needs resync's own scheduled repair. V2 mode does NOT reach here (the branch above
            // already re-triggers forceVisibleTerminalReflow at exactly this moment, the same path a
            // plain page refresh goes through) -- calling both raced them: the older, timer-based
            // scheduleTerminalResizeRepair could fire the codex nudge before this reconnect had actually
            // delivered any content, nudging an empty buffer and leaving a tab that was showing content
            // black. See resyncActiveTerminal.
            view.resyncResizeRepairPending = false;
            this.scheduleTerminalResizeRepair(view);
          }
          const canFollowSnapshot = v2
            ? followSnapshot && view.scrollMode === "follow"
            : followSnapshot && snapshotScrollGeneration === view.manualScrollGeneration && view.keepBottom && !view.manualScroll;
          if (canFollowSnapshot) {
            if (v2) {
              view.scrollMode = "follow";
              this.scheduleV2Fit(view);
              this.scrollTerminalV2ToBottom(view);
            } else {
              view.keepBottom = true;
              view.pinBottomUntil = Date.now() + 5000;
              // A terminal that changed while its saved scrollback was being
              // replayed can have a DOM scrollbar at its apparent maximum with
              // xterm's final row geometry still stale. Defer one bounded
              // refit until that initial stream has drained.
              view.needsViewportRepair = true;
              this.scheduleViewportSettle(view);
            }
          } else if (v2 && view.reconnectReset) {
            // A reconnect's replay rebuilt the buffer from scratch (view.term.reset() in ws.onopen),
            // so the pre-reset absolute viewportY this tab had is meaningless now -- restore using the
            // rows-from-bottom offset captured before that reset instead. Without this, xterm's own
            // write()-time auto-follow (a freshly reset buffer starts "at the bottom" trivially, so it
            // naturally tracks the incoming replay) lands the view at the bottom of the FULL replayed
            // content regardless of where the user actually was, which showed up as a scrolled-up tab
            // jumping toward the top once the buffer regrew past the small early size where an
            // earlier bug (now fixed) had frozen the viewport.
            this.scrollTerminalV2ToLine(view, Math.max(0, view.term.buffer.active.baseY - (view.preserveRowsFromBottom || 0)));
          } else if (!v2) {
            view.pinBottomUntil = 0;
          }
        });
        return;
      }
      const followOutput = this.isTerminalScrollV2() ? false : view.keepBottom || Date.now() < view.pinBottomUntil;
      const outputScrollGeneration = view.manualScrollGeneration;
      this.queueTerminalWrite(view, new Uint8Array(e.data), () => {
        if (this.isTerminalScrollV2()) {
          if (view.scrollMode === "follow") this.scrollTerminalV2ToBottom(view);
          return;
        }
        if (followOutput && outputScrollGeneration === view.manualScrollGeneration &&
            view.keepBottom && !view.manualScroll) {
          view.keepBottom = true;
          clearTimeout(view.scrollSettleTimer);
          view.scrollSettleTimer = setTimeout(() => {
            if (view.keepBottom || Date.now() < view.pinBottomUntil) this.scheduleViewportSettle(view);
          }, 250);
        }
      });
    };
    ws.onclose = () => {
      const reconnectAfterClose = view.reconnectAfterClose;
      view.reconnectAfterClose = false;
      view.ws = null;
      if (reconnectAfterClose) view.suppressReconnect = false;
      if (reconnectAfterClose && !view.closed && id === this.activeId && this.activeFileKey === null &&
          !this.session(id)?.dormant) {
        this.connect(id, view);
        return;
      }
      if (!view.closed && !view.suppressReconnect && id === this.activeId && this.activeFileKey === null &&
          !this.session(id)?.dormant) {
        clearTimeout(view.reconnectTimer);
        view.reconnectTimer = setTimeout(() => {
          view.reconnectTimer = 0;
          this.connect(id, view);
        }, RECONNECT_MS);
      }
    };
    view.ws = ws;
  }

  handleTerminalEditingKeys(view, e) {
    if (e.type !== "keydown") return true;
    if (this.isDesktopTerminalSelectInputEvent(e)) {
      e.preventDefault();
      this.selectActiveTerminalInputText();
      return false;
    }
    if (this.isDesktopTerminalSelectAllEvent(e)) {
      e.preventDefault();
      this.selectActiveTerminalText();
      return false;
    }
    if (this.tryAppShortcut(e)) return false;
    if (e.key === "Enter" && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      this.sendTrackedInput(view, "\x1b\r");
      return false;
    }
    if (e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "v") {
      e.preventDefault();
      navigator.clipboard.readText()
        .then((text) => { if (text) this.sendTrackedInput(view, this.terminalPastePayload(view, text)); })
        .catch(() => { this.$("status-name").textContent = "clipboard blocked — use ⌘V (allow clipboard in site settings for ⌃V)"; });
      return false;
    }
    if (e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "c" && view.term.hasSelection()) {
      e.preventDefault();
      const text = view.term.getSelection();
      this.recordSelectionCopyHistory(text);
      void this.copyTextToClipboard(text);
      return false;
    }
    if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      const key = e.key.toLowerCase();
      if (key === "c" && view.term.hasSelection()) {
        e.preventDefault();
        const text = view.term.getSelection();
        this.recordSelectionCopyHistory(text);
        void this.copyTextToClipboard(text);
        return false;
      }
      if (key === "v") return true;
      if (key === "backspace") { e.preventDefault(); this.sendTrackedInput(view, "\x15"); return false; }
      if (key === "arrowleft") { e.preventDefault(); this.sendTrackedInput(view, "\x01"); return false; }
      if (key === "arrowright") { e.preventDefault(); this.sendTrackedInput(view, "\x05"); return false; }
    }
    if (e.altKey && !e.metaKey && !e.ctrlKey) {
      if (e.key === "Backspace") { e.preventDefault(); this.sendTrackedInput(view, "\x1b\x7f"); return false; }
      if (e.key === "ArrowLeft") { e.preventDefault(); this.sendTrackedInput(view, "\x1bb"); return false; }
      if (e.key === "ArrowRight") { e.preventDefault(); this.sendTrackedInput(view, "\x1bf"); return false; }
    }
    return true;
  }

  handleControl(id, view, msg) {
    if (msg.type === "exit") {
      if (msg.dormant) {
        view.suppressReconnect = true;
        if (view.ws) view.ws.close();
      }
      view.term.write(`\r\n\x1b[2m[termdeck] process exited (${msg.code})\x1b[0m\r\n`);
      if (this.isTerminalScrollV2()) {
        if (view.scrollMode === "follow") this.scrollTerminalV2ToBottom(view);
      } else {
        view.pinBottomUntil = Date.now() + 5000;
      }
    } else if (msg.type === "draft") {
      const incomingDraft = String(msg.draft || "");
      if (view.promptDraftSyncPending && incomingDraft !== view.promptDraft) return;
      view.promptDraftSyncPending = false;
      clearTimeout(view.promptDraftSyncTimer);
      view.promptDraftSyncTimer = 0;
      if (view.promptSubmitting) {
        return;
      }
      if (!view.promptEditing) {
        view.promptDraft = incomingDraft;
        this.showPromptDraft(view);
      }
      return;
    } else if (msg.type === "prompt_submitted") {
      const submissionIsCurrent = view.promptSubmitVersion === view.promptEditVersion;
      if (submissionIsCurrent) {
        view.promptDraft = "";
        view.pendingDraftSync = null;
        view.pendingTerminalDraft = null;
        view.promptDraftSyncPending = false;
        clearTimeout(view.promptDraftSyncTimer);
        view.promptDraftSyncTimer = 0;
      }
      view.promptSubmitting = false;
      view.promptSubmitEntered = false;
      clearTimeout(view.promptSubmitTimer);
      if (submissionIsCurrent) {
        this.showPromptDraft(view);
        if (this.historyOpen && id === this.activeId) this.$("history-prompt").focus();
      }
      return;
    } else if (msg.type === "agent_session") {
      // Session discovery is asynchronous and can arrive while the user is
      // reading older output. It must not turn that event into an implicit
      // scroll-to-bottom.
      if (this.isTerminalScrollV2()) {
        if (view.scrollMode === "follow") this.scrollTerminalV2ToBottom(view);
      } else if (!view.manualScroll && view.keepBottom) {
        view.pinBottomUntil = Date.now() + 4000;
        this.scrollTerminalToBottom(view);
      }
    } else if (msg.type === "processing") {
      this.applySessionStatus({ session_id: id, processing: !!msg.processing });
      return;
    }
    this.refresh();
  }

  sendInput(view, data) {
    const session = this.session(view.sessionId);
    if (data) view.attentionScreenDetectionSuppressed = true;
    if (session?.needs_attention) {
      session.needs_attention = false;
      this.attentionServerStates.set(view.sessionId, false);
      this.clearSessionAttention(view.sessionId);
    }
    if (data) this.touchSessionActivity(view.sessionId);
    if (view.replaying && QUERY_RESPONSE_RE.test(data)) return;
    if (view.ws && view.ws.readyState === WebSocket.OPEN) {
      view.ws.send(JSON.stringify({ type: "input", data }));
    }
  }

  isImageAttachmentFile(file) {
    return !!file && (IMAGE_ATTACHMENT_MIME_RE.test(String(file.type || "")) ||
      IMAGE_ATTACHMENT_EXTENSION_RE.test(String(file.name || "")));
  }

  historyImageFilesFromDataTransfer(dataTransfer) {
    if (!dataTransfer) return [];
    const files = [];
    const seen = new Set();
    const addFile = (file) => {
      if (!this.isImageAttachmentFile(file) || seen.has(file)) return;
      seen.add(file);
      files.push(file);
    };
    for (const item of dataTransfer.items || []) {
      if (item.kind === "file") addFile(item.getAsFile());
    }
    for (const file of dataTransfer.files || []) addFile(file);
    return files;
  }

  insertHistoryAttachmentPaths(view, paths, selection = null, append = false) {
    if (!view || !this.historyOpen || this.activeFileKey !== null || !paths.length) return;
    const prompt = this.$("history-prompt");
    const value = prompt.value;
    const start = append ? value.length : Math.max(0, Math.min(value.length,
      Number(selection?.start ?? prompt.selectionStart ?? value.length)));
    const end = append ? value.length : Math.max(start, Math.min(value.length,
      Number(selection?.end ?? prompt.selectionEnd ?? start)));
    const text = paths.map((path) => (/\s/.test(path) ? `'${path}'` : path)).join(" ");
    const before = value.slice(0, start);
    const after = value.slice(end);
    const prefix = before && !/\s$/.test(before) ? " " : "";
    const suffix = after && /^\s/.test(after) ? "" : " ";
    this.persistMarkdownPromptDraft(view, `${before}${prefix}${text}${suffix}${after}`);
    this.showPromptDraft(view);
    prompt.focus();
    const cursor = before.length + prefix.length + text.length + suffix.length;
    prompt.setSelectionRange(cursor, cursor);
  }

  async insertHistoryAttachmentFiles(view, files) {
    if (!view || !this.historyOpen || this.activeFileKey !== null || !files.length) return;
    const prompt = this.$("history-prompt");
    const selection = { start: prompt.selectionStart, end: prompt.selectionEnd };
    const paths = await this.uploadFiles(files);
    if (!paths.length) {
      this.$("status-name").textContent = "image upload failed";
      return;
    }
    this.insertHistoryAttachmentPaths(view, paths, selection);
    this.$("status-name").textContent = `inserted ${paths.length} image${paths.length === 1 ? "" : "s"}`;
  }

  async uploadFiles(files) {
    this.$("status-name").textContent = `uploading ${files.length} file${files.length === 1 ? "" : "s"}…`;
    const paths = [];
    for (const file of files) {
      const form = new FormData();
      form.append("file", file, file.name || "pasted");
      try {
        const res = await fetch("/api/upload", { method: "POST", body: form });
        if (res.ok) paths.push((await res.json()).path);
      } catch (err) {
        // skip failed upload
      }
    }
    return paths;
  }

  async uploadAndInsert(view, files) {
    const paths = await this.uploadFiles(files);
    if (!paths.length) { this.$("status-name").textContent = "upload failed"; return; }
    const text = paths.map((p) => (/\s/.test(p) ? `'${p}'` : p)).join(" ") + " ";
    if (view.ws && view.ws.readyState === WebSocket.OPEN) {
      this.sendTrackedInput(view, this.terminalPastePayload(view, text));
    }
    this.$("status-name").textContent = `inserted ${paths.length} path${paths.length === 1 ? "" : "s"}`;
    view.term.focus();
  }

  async attachToHistory() {
    const view = this.views.get(this.activeId);
    if (!view || this.activeFileKey !== null || !this.historyOpen) return;
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.onchange = async () => {
      if (!input.files.length) return;
      const paths = await this.uploadFiles([...input.files]);
      if (!paths.length) { this.$("status-name").textContent = "upload failed"; return; }
      this.insertHistoryAttachmentPaths(view, paths, null, true);
      this.$("status-name").textContent = `inserted ${paths.length} path${paths.length === 1 ? "" : "s"}`;
    };
    input.click();
  }

  async attachToActive() {
    const view = this.views.get(this.activeId);
    if (!view || this.activeFileKey !== null) return;
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.onchange = () => { if (input.files.length) this.uploadAndInsert(view, [...input.files]); };
    input.click();
  }

  terminalPageCanResize() {
    return document.visibilityState === "visible" && document.hasFocus();
  }

  sendResize(view, cols, rows, force = false) {
    if (this.sidebarResizeInProgress || view.suppressResizeToServer || !this.terminalPageCanResize() ||
        view.closed || view.sessionId !== this.activeId || !view.container.classList.contains("visible") ||
        this.activeFileKey !== null || this.historyOpen) return;
    if (view.ws && view.ws.readyState === WebSocket.OPEN &&
        (force || view.lastSentCols !== cols || view.lastSentRows !== rows)) {
      view.lastSentCols = cols;
      view.lastSentRows = rows;
      view.ws.send(JSON.stringify({ type: "resize", cols, rows }));
    }
  }

  // Reusable diagnostic utility, not called from anywhere by default -- wire it into a new suspect code
  // path when needed. Keeps the last DEBUG_SNAPSHOT_LIMIT {trigger, ts, buf, dom} entries per view. buf
  // is xterm's own logical buffer tail (what SHOULD be on screen); dom is the actually-painted rows. If
  // they ever disagree, that is a termdeck repaint bug; if buf itself changes content across snapshots
  // with cols unchanged, the CLI genuinely redrew differently -- the two rule each other in or out.
  captureDebugSnapshot(view, trigger) {
    if (!view || view.closed) return;
    view.debugSnapshots = view.debugSnapshots || [];
    view.debugSnapshots.push({
      trigger, ts: Date.now(), cols: view.term.cols, rows: view.term.rows,
      buf: this.terminalBufferVisibleTailLines(view, 15),
      dom: this.terminalRenderedTailLines(view, 15),
    });
    if (view.debugSnapshots.length > TERMINAL_DEBUG_SNAPSHOT_LIMIT) view.debugSnapshots.shift();
  }

  // Small top-right corner panel, INVISIBLE by default: a header (collapse toggle) plus a collapsed,
  // empty body kept as reusable scaffolding for a future terminal-rendering investigation. Deliberately
  // NOT wired to any automatic capture/logging -- an earlier version accumulated visible blur/focus/
  // resize chatter once its original investigation was fixed (reported as noise, stripped back out),
  // and a later "guarded" A/B toggle here showed no observable difference from the shipped default in
  // practice (also removed, see forceVisibleTerminalReflow). The body (this.debugOverlay.stats/.diff)
  // stays empty until something explicitly writes into it. To reactivate for a NEW investigation: set
  // box.style.display = "block", write into this.debugOverlay.stats/.diff, and wire
  // this.captureDebugSnapshot(view, "label") into whatever new code path is under suspicion -- see this
  // file's git history around 2026-08-02 for a fuller buffer-vs-rendered-DOM differ and an A/B select
  // to copy the pattern from, not to revive verbatim.
  installTerminalSizeDebugOverlay() {
    const box = document.createElement("div");
    box.id = "td-debug-size-overlay";
    Object.assign(box.style, {
      position: "fixed", top: "4px", right: "4px", zIndex: 99999, display: "none", color: "#0f0",
      background: "rgba(0,0,0,0.9)", padding: "4px 8px", borderRadius: "4px", cursor: "text",
      userSelect: "text", WebkitUserSelect: "text", maxWidth: "44vw", maxHeight: "70vh", overflow: "auto",
    });
    const header = document.createElement("div");
    Object.assign(header.style, {
      font: "11px/1.4 ui-monospace, monospace", cursor: "pointer", userSelect: "none",
      WebkitUserSelect: "none", display: "flex", justifyContent: "space-between", gap: "8px",
    });
    const title = document.createElement("span");
    title.textContent = "td-debug";
    const toggle = document.createElement("span");
    let collapsed = true;
    const body = document.createElement("div");
    const applyCollapsed = () => {
      body.style.display = collapsed ? "none" : "";
      toggle.textContent = collapsed ? "▸ expand" : "▾ collapse";
    };
    toggle.addEventListener("click", () => { collapsed = !collapsed; applyCollapsed(); });
    header.append(title, toggle);
    header.addEventListener("click", (e) => { if (e.target === header || e.target === title) { collapsed = !collapsed; applyCollapsed(); } });
    const stats = document.createElement("div");
    Object.assign(stats.style, { font: "11px/1.4 ui-monospace, monospace", whiteSpace: "pre" });
    const diff = document.createElement("div");
    Object.assign(diff.style, { font: "9.5px/1.3 ui-monospace, monospace", whiteSpace: "pre", marginTop: "4px", color: "#8f8" });
    body.append(stats, diff);
    box.append(header, body);
    applyCollapsed();
    document.body.appendChild(box);
    this.debugOverlay = { box, stats, diff };
  }

  scrollActiveToBottom() {
    if (this.activeFileKey !== null) return;
    const view = this.views.get(this.activeId);
    if (!view) return;
    if (this.isTerminalScrollV2()) {
      view.scrollMode = "follow";
      this.scrollTerminalV2ToBottom(view);
      // Also drive the tall container: scrollTerminalV2ToBottom only moves xterm's own viewport, which is
      // no longer the surface being scrolled, so on its own this button did nothing at all here.
      view.tallFollowing = true;
      if (view.tallMaxScrollTop != null) this.scrollTallContainerToCursor(view);
      else this.tallSetScrollTop(view, view.container.scrollHeight);
      this.scheduleV2Fit(view);
      view.term.focus();
      return;
    }
    view.keepBottom = true;
    view.pinBottomUntil = Date.now() + 5000;
    this.scrollTerminalToBottom(view);
    this.scheduleViewportSettle(view);
    view.term.focus();
  }

  handleManualCodexRepaintClick(event, view, id) {
    if (event.button !== 0 || this.activeId !== id || this.activeFileKey !== null || this.historyOpen ||
        this.session(id)?.agent_kind !== "codex") return;
    const now = Date.now();
    if (now - view.manualRepaintLastClickAt > TERMINAL_MANUAL_REPAINT_CLICK_WINDOW_MS) view.manualRepaintClickCount = 0;
    view.manualRepaintLastClickAt = now;
    view.manualRepaintClickCount += 1;
    clearTimeout(view.manualRepaintClickTimer);
    view.manualRepaintClickTimer = setTimeout(() => {
      view.manualRepaintClickTimer = 0;
      view.manualRepaintClickCount = 0;
    }, TERMINAL_MANUAL_REPAINT_CLICK_WINDOW_MS);
    if (view.manualRepaintClickCount < 3 && event.detail < 3) return;
    view.manualRepaintClickCount = 0;
    clearTimeout(view.manualRepaintClickTimer);
    view.manualRepaintClickTimer = 0;
    if (this.terminalTailRenderMismatch(view)) {
      view.renderRepairArmed = true;
      if (this.repairTerminalRenderIfStale(view)) {
        this.$("status-name").textContent = "Codex display repainted";
        return;
      }
    }
    this.refreshTerminalAppearance(view, true);
    if (!view.ws || view.ws.readyState !== WebSocket.OPEN) return;
    const anchor = this.captureTerminalViewportAnchor(view, { preserveFollow: true, restoreAfterDeadline: true });
    this.beginTerminalViewportRestore(view, anchor);
    view.ws.send(JSON.stringify({ type: "repaint" }));
    this.$("status-name").textContent = "requesting Codex repaint…";
  }

  scrollHistoryToBottom() {
    if (!this.historyOpen || this.activeFileKey !== null) return;
    const body = this.$("history-body");
    if (!body) return;
    body.scrollTop = body.scrollHeight;
    this.$("history-prompt")?.focus();
  }

  scrollActiveSurfaceToBottom() {
    if (this.historyOpen) this.scrollHistoryToBottom();
    else this.scrollActiveToBottom();
  }

  scheduleTerminalResizeRepair(view) {
    if (!this.attachRepaintEnabled()) return;
    if (!view || view.closed || !view.container.classList.contains("visible")) return;
    view.forceResizeAfterFit = true;
    this.scheduleTerminalLayoutFit();
    clearTimeout(view.resizeRepairTimer);
    view.resizeRepairTimer = setTimeout(() => {
      view.resizeRepairTimer = 0;
      if (view.closed || !view.container.classList.contains("visible") || view.sessionId !== this.activeId) return;
      view.forceResizeAfterFit = true;
      this.scheduleTerminalLayoutFit();
    }, 420);
  }

  resyncActiveTerminal() {
    if (this.activeFileKey !== null || this.historyOpen || !this.activeId) return;
    const view = this.views.get(this.activeId);
    if (!view || view.closed) return;
    // Resync is also the manual escape hatch for terminals whose prompt or
    // wrapped output was painted against stale dimensions. Treat the button
    // like a sidebar resize so FitAddon remeasures the visible terminal,
    // repaints it, and sends the corrected PTY size.
    const v2 = this.isTerminalScrollV2();
    if (v2) view.scrollMode = "follow";
    else {
      view.keepBottom = true;
      view.pinBottomUntil = Date.now() + 8000;
    }
    view.term.reset();
    this.tallResetScrollState(view);
    // V2 mode gets its repaint trigger for free once the forced reconnect below actually delivers a
    // snapshot (connect()'s post-replay callback), the same path a plain page refresh goes through --
    // scheduling it again here, before that reconnect has even started, used to race it and could nudge
    // an empty buffer instead of the real one. Legacy mode has no equivalent hook, so it still needs
    // this scheduled directly.
    if (!v2) {
      view.resyncResizeRepairPending = true;
      this.scheduleTerminalResizeRepair(view);
    }
    this.applySettings();
    this.$("status-name").textContent = "resyncing terminal…";
    const ws = view.ws;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      ws.close();
    } else {
      clearTimeout(view.reconnectTimer);
      view.reconnectTimer = 0;
      this.connect(this.activeId, view);
    }
  }

  terminalAtBottom(view) {
    if (this.isTerminalScrollV2()) return this.xtermAtBottom(view);
    if (!view || !view.term) return false;
    const buffer = view.term.buffer.active;
    const viewport = view.container.querySelector(".xterm-viewport");
    if (!viewport) return buffer.viewportY >= buffer.baseY - 1;
    // The browser position is the authoritative position for the native
    // scrollbar. xterm's buffer viewport can lag it by a frame during a fit or
    // resize; requiring both made a real bottom position look non-bottom and
    // caused the follow-bottom state to fight the user's scrolling.
    const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const domAtBottom = maxScrollTop - viewport.scrollTop <= 2;
    return domAtBottom;
  }

  isTerminalScrollV2() {
    // Desktop terminals always use xterm's buffer-owned scrolling. The VS Code
    // integration remains separate and continues to use its native surface.
    return !this.vscodeMode;
  }

  xtermAtBottom(view) {
    if (!view?.term) return false;
    const buffer = view.term.buffer.active;
    return buffer.viewportY >= buffer.baseY;
  }

  scrollTerminalV2ToBottom(view) {
    if (!view || view.closed) return;
    view.userScrollIntent = false;
    view.scrollMode = "follow";
    view.v2Programmatic = true;
    view.term.scrollToBottom();
    queueMicrotask(() => {
      if (!view.closed) view.v2Programmatic = false;
    });
  }

  // Restoring a "preserve" position needs the same v2Programmatic guard scrollTerminalV2ToBottom
  // already uses: term.onScroll re-derives scrollMode from wherever the terminal ends up on every
  // scroll it sees, including one this function itself triggers -- without the guard, that immediate
  // self-triggered onScroll can flip scrollMode right back to "follow"/"preserve" based on the
  // now-current position, one write-callback race away from stomping the caller's intended value
  // before this function's own caller gets a chance to set it explicitly afterward.
  scrollTerminalV2ToLine(view, line) {
    if (!view || view.closed) return;
    view.v2Programmatic = true;
    view.term.scrollToLine(line);
    queueMicrotask(() => {
      if (!view.closed) view.v2Programmatic = false;
    });
  }

  normalizeTerminalViewportAnchorText(value) {
    return String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, "");
  }

  captureTerminalViewportAnchor(view, options = {}) {
    const preserveFollow = Boolean(options.preserveFollow);
    const restoreAfterDeadline = Boolean(options.restoreAfterDeadline);
    const atBottom = this.xtermAtBottom(view);
    if (!view || view.closed || this.session(view.sessionId)?.agent_kind !== "codex" ||
        (!preserveFollow && (view.scrollMode === "follow" || atBottom))) return null;
    const buffer = view.term.buffer.active;
    const viewportY = Math.max(0, Number(buffer.viewportY || 0));
    const visibleRows = Math.min(TERMINAL_VIEWPORT_ANCHOR_ROWS, Math.max(1, Number(view.term.rows || 1)));
    const normalizedRows = [];
    for (let offset = 0; offset < visibleRows; offset++) {
      const line = buffer.getLine(viewportY + offset);
      normalizedRows.push(this.normalizeTerminalViewportAnchorText(line ? line.translateToString(true) : ""));
    }
    const candidates = [];
    for (let start = 0; start < normalizedRows.length; start++) {
      let text = "";
      for (let offset = start; offset < normalizedRows.length && text.length < TERMINAL_VIEWPORT_ANCHOR_MAX_CHARS; offset++) {
        text += normalizedRows[offset];
      }
      text = text.slice(0, TERMINAL_VIEWPORT_ANCHOR_MAX_CHARS);
      const alphaNumericCount = (text.match(/[A-Za-z0-9]/g) || []).length;
      if (text.length >= TERMINAL_VIEWPORT_ANCHOR_MIN_CHARS && alphaNumericCount >= 12) {
        candidates.push({ text, rowOffset: start });
      }
    }
    if (!candidates.length && !(preserveFollow && atBottom)) return null;
    candidates.sort((left, right) => left.rowOffset - right.rowOffset || right.text.length - left.text.length);
    return {
      candidates: candidates.slice(0, 6),
      rowsFromBottom: Math.max(0, Number(buffer.baseY || 0) - viewportY),
      restoreAtBottom: preserveFollow && atBottom,
      restoreAfterDeadline,
      redrawSeen: false,
      escapeMatchLength: 0,
      deadline: 0,
    };
  }

  beginTerminalViewportRestore(view, anchor) {
    if (!anchor || !view || view.closed) return false;
    if (!view.viewportAnchorRestore) view.viewportAnchorRestore = anchor;
    view.viewportAnchorRestore.deadline = Date.now() + TERMINAL_VIEWPORT_RESTORE_TIMEOUT_MS;
    this.scheduleTerminalViewportRestore(view, TERMINAL_VIEWPORT_RESTORE_IDLE_MS);
    return true;
  }

  cancelTerminalViewportRestore(view) {
    if (!view) return;
    clearTimeout(view.viewportAnchorRestoreTimer);
    view.viewportAnchorRestoreTimer = 0;
    view.viewportAnchorRestore = null;
  }

  noteTerminalViewportRestoreOutput(view, data) {
    const anchor = view?.viewportAnchorRestore;
    if (!anchor || anchor.redrawSeen) return;
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const eraseScrollback = [0x1b, 0x5b, 0x33, 0x4a];
    let matched = anchor.escapeMatchLength || 0;
    for (const byte of bytes) {
      if (byte === eraseScrollback[matched]) matched += 1;
      else matched = byte === eraseScrollback[0] ? 1 : 0;
      if (matched !== eraseScrollback.length) continue;
      anchor.redrawSeen = true;
      matched = 0;
      break;
    }
    anchor.escapeMatchLength = matched;
  }

  terminalViewportAnchorTarget(view, anchor) {
    const buffer = view.term.buffer.active;
    let text = "";
    const rowStarts = [];
    for (let row = 0; row < buffer.length; row++) {
      const line = buffer.getLine(row);
      const normalized = this.normalizeTerminalViewportAnchorText(line ? line.translateToString(true) : "");
      if (!normalized) continue;
      rowStarts.push({ offset: text.length, row });
      text += normalized;
    }
    if (!text || !rowStarts.length) return null;
    let best = null;
    for (const candidate of anchor.candidates) {
      let offset = text.indexOf(candidate.text);
      let matches = 0;
      while (offset >= 0 && matches < 64) {
        const row = this.terminalViewportRowForTextOffset(rowStarts, offset);
        const expectedRowsFromBottom = Math.max(0, anchor.rowsFromBottom - candidate.rowOffset);
        const score = Math.abs((Number(buffer.baseY || 0) - row) - expectedRowsFromBottom);
        if (!best || score < best.score || (score === best.score && candidate.text.length > best.length)) {
          best = { line: Math.max(0, row - candidate.rowOffset), score, length: candidate.text.length };
        }
        matches += 1;
        offset = text.indexOf(candidate.text, offset + 1);
      }
    }
    return best?.line ?? null;
  }

  terminalViewportRowForTextOffset(rowStarts, offset) {
    let low = 0, high = rowStarts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (rowStarts[middle].offset <= offset) low = middle;
      else high = middle - 1;
    }
    return rowStarts[low].row;
  }

  scheduleTerminalViewportRestore(view, delay = TERMINAL_VIEWPORT_RESTORE_IDLE_MS) {
    const anchor = view?.viewportAnchorRestore;
    if (!anchor || view.closed) return;
    clearTimeout(view.viewportAnchorRestoreTimer);
    const remaining = Math.max(0, anchor.deadline - Date.now());
    view.viewportAnchorRestoreTimer = setTimeout(() => {
      view.viewportAnchorRestoreTimer = 0;
      this.restoreTerminalViewportAnchor(view);
    }, Math.min(delay, remaining));
  }

  restoreTerminalViewportAnchor(view) {
    const anchor = view?.viewportAnchorRestore;
    if (!anchor || view.closed) return;
    const expired = Date.now() >= anchor.deadline;
    if (!anchor.redrawSeen) {
      if (!expired || !anchor.restoreAfterDeadline) {
        if (expired) this.cancelTerminalViewportRestore(view);
        else this.scheduleTerminalViewportRestore(view);
        return;
      }
    }
    if (!expired && (view.outputWriteInFlight || view.outputQueue.length)) {
      this.scheduleTerminalViewportRestore(view);
      return;
    }
    if (anchor.restoreAtBottom) {
      view.scrollMode = "follow";
      this.scrollTerminalV2ToBottom(view);
      this.cancelTerminalViewportRestore(view);
      return;
    }
    const target = this.terminalViewportAnchorTarget(view, anchor);
    if (target !== null) {
      view.scrollMode = "preserve";
      this.scrollTerminalV2ToLine(view, target);
      this.cancelTerminalViewportRestore(view);
      return;
    }
    if (!expired) {
      this.scheduleTerminalViewportRestore(view);
      return;
    }
    view.scrollMode = "preserve";
    view.userScrollIntent = true;
    this.scrollTerminalV2ToLine(view, Math.max(0, view.term.buffer.active.baseY - anchor.rowsFromBottom));
    this.cancelTerminalViewportRestore(view);
  }

  scheduleV2Fit(view, options = {}) {
    const forceResize = !!options.force;
    if (!view || view.closed || !view.container.classList.contains("visible") || !this.terminalPageCanResize()) return;
    if (this.shouldDeferPromptReflowFit(view)) return;
    if (view.v2FitFrame && forceResize) {
      cancelAnimationFrame(view.v2FitFrame);
      view.v2FitFrame = 0;
    }
    if (view.v2FitFrame) return;
    view.v2FitFrame = requestAnimationFrame(() => {
      view.v2FitFrame = 0;
      if (view.closed || !view.container.classList.contains("visible") || this.sidebarResizeInProgress || !this.terminalPageCanResize()) return;
      if (this.shouldDeferPromptReflowFit(view)) return;
      const rect = view.container.getBoundingClientRect();
      if (rect.width < 40 || rect.height < 40) {
        const retryLimit = forceResize ? TERMINAL_V2_FIT_RETRY_LIMIT : 12;
        const retryDelay = forceResize ? TERMINAL_V2_FIT_RETRY_DELAY_MS : 60;
        if (!view.layoutFitRetryTimer && view.layoutFitRetryCount < retryLimit) {
          view.layoutFitRetryCount += 1;
          view.layoutFitRetryTimer = setTimeout(() => {
            view.layoutFitRetryTimer = 0;
            if (!view.closed && view.container.classList.contains("visible")) this.scheduleV2Fit(view, options);
          }, retryDelay);
        }
        return;
      }
      view.layoutFitRetryCount = 0;
      clearTimeout(view.layoutFitRetryTimer);
      view.layoutFitRetryTimer = 0;
      // Captured as an offset (not the absolute viewportY) and BEFORE fit() below, since this is the
      // earliest point in the whole activation chain where a cols/rows change (and therefore a full
      // buffer reflow) can happen -- every downstream repair function (repairTerminalRenderIfStale,
      // forceVisibleTerminalReflow*) captures ITS OWN restore point only after this has already run,
      // so if fit() corrupts the position here, they just faithfully preserve the already-corrupted
      // value instead of the user's actual intended position. Ground-truth testing (window.__td)
      // confirmed this is where "switching between half-scrolled tabs jumps to the top" traces back
      // to: FitAddon.fit() calling term.resize() with different cols does not preserve viewportY on
      // its own, it can land at 0.
      const beforeCols = view.term.cols, beforeRows = view.term.rows;
      const rowsFromBottom = view.term.buffer.active.baseY - view.term.buffer.active.viewportY;
      // FitAddon is the public xterm sizing mechanism. v2 never writes to
      // .xterm-viewport or .xterm-scroll-area; xterm owns its scrollbar.
      const viewportAnchor = this.captureTerminalViewportAnchor(view);
      this.tallFit(view);
      view.container.classList.remove("initializing");
      const terminalSizeChanged = view.term.cols !== beforeCols || view.term.rows !== beforeRows;
      if (terminalSizeChanged) this.beginTerminalViewportRestore(view, viewportAnchor);
      if (view.scrollMode !== "follow" && terminalSizeChanged) {
        this.scrollTerminalV2ToLine(view, Math.max(0, view.term.buffer.active.baseY - rowsFromBottom));
      }
      // A terminal may have been painted while its container was hidden or
      // at its pre-flex width. Refresh after the settled fit so the canvas
      // and text colors are repainted together with the final geometry.
      const hasPaintedInitialSnapshot = view.initialSnapshotPainted;
      const forceResizeThisFrame = hasPaintedInitialSnapshot && (forceResize || view.forceResizeAfterFit);
      if (!hasPaintedInitialSnapshot) view.forceResizeAfterFit = false;
      if (forceResizeThisFrame) {
        view.forceResizeAfterFit = false;
        if (this.forceVisibleTerminalReflow(view)) return;
      } else {
        view.forceResizeAfterFit = false;
      }
      this.refreshTerminalAppearance(view, forceResizeThisFrame);
      if (forceResizeThisFrame && view.term.cols >= 2 && view.term.rows >= 2) this.sendResize(view, view.term.cols, view.term.rows, true);
      if (view.scrollMode === "follow") this.scrollTerminalV2ToBottom(view);
    });
  }

  scheduleInitialV2Fit(view) {
    if (!view || view.closed || !view.v2InitialFitPending || view.v2InitialFitFrame ||
        !view.container.classList.contains("visible")) return;
    // A new xterm is opened while its container is display:none. Its first
    // activation can therefore fit against the pre-layout width; settle once
    // more after the browser has committed the newly-visible terminal area.
    view.v2InitialFitPending = false;
    view.v2InitialFitFrame = requestAnimationFrame(() => {
      view.v2InitialFitFrame = requestAnimationFrame(() => {
        view.v2InitialFitFrame = 0;
        if (view.closed || !view.container.classList.contains("visible")) return;
        this.scheduleV2Fit(view);
      });
    });
  }

  scheduleV2ViewportSync(view) {
    if (!view || view.closed || view.v2ViewportSyncFrame || !view.hiddenOutputPending ||
        !view.container.classList.contains("visible")) return;
    view.v2ViewportSyncFrame = requestAnimationFrame(() => {
      view.v2ViewportSyncFrame = 0;
      if (view.closed || !view.hiddenOutputPending || !view.container.classList.contains("visible")) return;
      view.hiddenOutputPending = false;
      if (view.scrollMode === "follow") {
        this.scrollTerminalV2ToBottom(view);
        return;
      }
      const buffer = view.term.buffer.active;
      const target = buffer.viewportY;
      if (buffer.baseY <= 0) return;
      // While the element was display:none, xterm advanced its logical
      // viewport but the DOM scrollbar retained its old geometry. Nudge one
      // logical line, then restore the exact line. Both calls are public
      // xterm APIs, preserve a reader's position, and avoid the old fake
      // resize/direct-scroll repair paths that caused tab-switch jumps.
      const nudge = target < buffer.baseY ? target + 1 : Math.max(0, target - 1);
      if (nudge === target) return;
      view.v2Programmatic = true;
      view.term.scrollToLine(nudge);
      view.term.scrollToLine(target);
      queueMicrotask(() => {
        if (!view.closed) view.v2Programmatic = false;
      });
    });
  }

  scrollTerminalToBottom(view) {
    if (this.isTerminalScrollV2()) {
      this.scrollTerminalV2ToBottom(view);
      return;
    }
    clearTimeout(view.manualScrollReleaseTimer);
    view.manualScrollReleaseTimer = 0;
    view.manualScroll = false;
    view.wasAtBottom = true;
    view.programmaticScrollUntil = Date.now() + 1000;
    view.programmaticScrollGeneration = view.manualScrollGeneration;
    view.term.scrollToBottom();
    const viewport = view.container.querySelector(".xterm-viewport");
    if (viewport) {
      // Assign the maximum scrollTop, rather than scrollHeight.  The latter
      // is clamped by the browser but can leave xterm one viewport short while
      // its row geometry is being updated.
      viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    }
  }

  refreshTerminal(view) {
    if (!view || view.term.rows < 1) return;
    view.term.refresh(0, view.term.rows - 1);
  }

  scheduleCodexFocusTailRefresh(view) {
    if (!view || view.closed || view.codexFocusRefreshFrame || this.session(view.sessionId)?.agent_kind !== "codex") return;
    view.codexFocusRefreshFrame = requestAnimationFrame(() => {
      view.codexFocusRefreshFrame = requestAnimationFrame(() => {
        view.codexFocusRefreshFrame = 0;
        if (view.closed || this.activeId !== view.sessionId || this.historyOpen || this.activeFileKey !== null ||
            !view.container.classList.contains("visible")) return;
        const lastRow = Math.max(0, view.term.rows - 1);
        view.term.refresh(Math.max(0, lastRow - 5), lastRow);
      });
    });
  }

  normalizeTerminalTailLine(line) {
    return String(line || "").replace(/\u00a0/g, " ").replace(/\s+$/g, "");
  }

  terminalBufferVisibleTailLines(view, count = TERMINAL_TAIL_REPAIR_LINES) {
    const buffer = view?.term?.buffer?.active;
    if (!buffer || typeof buffer.getLine !== "function") return [];
    const rows = Math.max(1, Number(view.term.rows || 1));
    const viewportY = Math.max(0, Number(buffer.viewportY || 0));
    const start = Math.max(0, viewportY + rows - count);
    const end = viewportY + rows;
    const lines = [];
    for (let index = start; index < end; index++) {
      const line = buffer.getLine(index);
      lines.push(this.normalizeTerminalTailLine(line ? line.translateToString(true) : ""));
    }
    return lines;
  }

  recordTerminalRenderedRows(view, start, end) {
    const buffer = view?.term?.buffer?.active;
    if (!buffer || typeof buffer.getLine !== "function") return;
    const viewportY = Math.max(0, Number(buffer.viewportY || 0));
    const rows = Math.max(1, Number(view.term.rows || 1));
    const cols = Math.max(1, Number(view.term.cols || 1));
    if (view.renderedViewportY !== viewportY || view.renderedCols !== cols || view.renderedTermRows !== rows) {
      view.renderedRows = new Array(rows).fill(null);
      view.renderedViewportY = viewportY;
      view.renderedCols = cols;
      view.renderedTermRows = rows;
    }
    const first = Math.max(0, Number(start || 0));
    const last = Math.min(rows - 1, Number.isFinite(Number(end)) ? Number(end) : first);
    for (let row = first; row <= last; row++) {
      const line = buffer.getLine(viewportY + row);
      view.renderedRows[row] = this.normalizeTerminalTailLine(line ? line.translateToString(true) : "");
    }
  }

  terminalRenderedTailLines(view, count = TERMINAL_TAIL_REPAIR_LINES) {
    const rows = [...(view?.container?.querySelectorAll(".xterm-rows > div") || [])];
    if (rows.length) return rows.slice(-count).map((row) => this.normalizeTerminalTailLine(row.textContent || ""));
    const buffer = view?.term?.buffer?.active;
    if (!buffer || view.renderedViewportY !== Math.max(0, Number(buffer.viewportY || 0)) ||
        view.renderedCols !== view.term.cols || view.renderedTermRows !== view.term.rows) return [];
    const rendered = view.renderedRows.slice(Math.max(0, view.term.rows - count));
    return rendered.some((line) => line === null) ? [] : rendered;
  }

  parseCssColor(value) {
    const color = String(value || "").trim().toLowerCase();
    let match = color.match(/^#([0-9a-f]{3})$/i);
    if (match) {
      return match[1].split("").map((part) => Number.parseInt(part + part, 16)).concat(1);
    }
    match = color.match(/^#([0-9a-f]{6})$/i);
    if (match) {
      return [
        Number.parseInt(match[1].slice(0, 2), 16),
        Number.parseInt(match[1].slice(2, 4), 16),
        Number.parseInt(match[1].slice(4, 6), 16),
        1,
      ];
    }
    match = color.match(/^rgba?\(([^)]+)\)$/i);
    if (!match) return null;
    const parts = match[1].split(",").map((part) => Number.parseFloat(part.trim()));
    if (parts.length < 3 || parts.slice(0, 3).some((part) => !Number.isFinite(part))) return null;
    return [parts[0], parts[1], parts[2], Number.isFinite(parts[3]) ? parts[3] : 1];
  }

  colorDistance(left, right) {
    if (!left || !right) return Number.POSITIVE_INFINITY;
    const dr = left[0] - right[0];
    const dg = left[1] - right[1];
    const db = left[2] - right[2];
    return Math.sqrt((dr * dr) + (dg * dg) + (db * db));
  }

  terminalRenderedTailLooksInvisible(view, expected, rendered) {
    const rows = [...(view?.container?.querySelectorAll(".xterm-rows > div") || [])].slice(-expected.length);
    if (!rows.length || !expected.some((line) => line.trim())) return false;
    const screen = view.container.querySelector(".xterm-screen") || view.container;
    const computedBackground = this.parseCssColor(window.getComputedStyle(screen).backgroundColor);
    const themeBackground = this.parseCssColor(this.termTheme().background);
    const background = computedBackground && computedBackground[3] > 0 ? computedBackground : themeBackground;
    let compared = 0;
    let invisible = 0;
    for (let index = 0; index < expected.length; index++) {
      if (!expected[index].trim()) continue;
      compared += 1;
      const row = rows[index];
      const renderedLine = rendered[index] || "";
      if (!row || !renderedLine.trim()) {
        invisible += 1;
        continue;
      }
      const spans = [...row.querySelectorAll("span")].filter((span) => String(span.textContent || "").trim());
      const samples = spans.length ? spans : [row];
      const rowVisible = samples.some((sample) => {
        const style = window.getComputedStyle(sample);
        const opacity = Number.parseFloat(style.opacity);
        if (style.visibility === "hidden" || style.display === "none" || opacity === 0) return false;
        const foreground = this.parseCssColor(style.color);
        if (!foreground || foreground[3] === 0) return false;
        const sampleBackground = this.parseCssColor(style.backgroundColor);
        const effectiveBackground = sampleBackground && sampleBackground[3] > 0 ? sampleBackground : background;
        return !effectiveBackground || this.colorDistance(foreground, effectiveBackground) >= 12;
      });
      if (!rowVisible) invisible += 1;
    }
    return compared > 0 && invisible > 0;
  }

  terminalTailRenderMismatch(view) {
    if (view.v2ForcedReflowFrame || view.v2ForcedReflowRestoreFrame) return false;
    const visibleRows = Math.max(1, Number(view.term.rows || 1));
    const expected = this.terminalBufferVisibleTailLines(view, visibleRows);
    const rendered = this.terminalRenderedTailLines(view, visibleRows);
    if (!expected.length || expected.length !== rendered.length) return false;
    let compared = 0;
    for (let index = 0; index < expected.length; index++) {
      const expectedLine = expected[index];
      if (!expectedLine.trim()) continue;
      compared += 1;
      if (expectedLine !== rendered[index]) return true;
    }
    view.tailRepairSignature = expected.join("\n");
    return (compared > 0 && !rendered.some((line) => line.trim())) ||
      this.terminalRenderedTailLooksInvisible(view, expected, rendered);
  }

  terminalRenderMismatchSnapshot(view) {
    if (!this.terminalTailRenderMismatch(view)) return null;
    const visibleRows = Math.max(1, Number(view.term.rows || 1));
    return {
      viewportY: Number(view.term.buffer.active.viewportY || 0), cols: view.term.cols, rows: view.term.rows,
      expected: this.terminalBufferVisibleTailLines(view, visibleRows).join("\n"),
      rendered: this.terminalRenderedTailLines(view, visibleRows).join("\n"),
    };
  }

  sameTerminalRenderMismatch(left, right) {
    return !!left && !!right && left.viewportY === right.viewportY && left.cols === right.cols && left.rows === right.rows &&
      left.expected === right.expected && left.rendered === right.rendered;
  }

  repairTerminalRenderIfStale(view) {
    if (!view || view.closed || !view.container.classList.contains("visible") || !this.terminalPageCanResize()) return false;
    if (this.shouldDeferPromptReflowFit(view)) return false;
    if (!this.terminalTailRenderMismatch(view)) {
      view.renderRepairArmed = true;
      return false;
    }
    if (!view.renderRepairArmed) return false;
    view.renderRepairArmed = false;
    const restoreLine = view.term.buffer.active.viewportY;
    // Captured as an OFFSET, not the absolute index above: a cols change reflows the whole buffer
    // (every wrapped line can re-wrap into a different number of rows), so restoreLine can point at
    // entirely different content once that happens. An earlier attempt just skipped restoring
    // anything in that case, assuming xterm's own resize()/reflow keeps the viewport sensibly
    // positioned on its own -- ground-truth testing (window.__td) showed that assumption was wrong,
    // reflow can leave viewportY at 0 outright. "N rows above the latest line" survives a reflow the
    // same way it survives a reconnect-driven buffer reset (see the leaving-view capture in
    // activate() and the reconnect restore in connect()'s ws.onmessage).
    const restoreRowsFromBottom = view.term.buffer.active.baseY - restoreLine;
    const follow = view.scrollMode === "follow";
    const renderService = view.term._core?._renderService;
    if (renderService?._isPaused && typeof renderService._handleIntersectionChange === "function") {
      renderService._handleIntersectionChange({ isIntersecting: true, intersectionRatio: 1 });
      this.refreshTerminal(view);
      if (follow) this.scrollTerminalV2ToBottom(view);
      else this.scrollTerminalV2ToLine(view, Math.min(restoreLine, view.term.buffer.active.baseY));
      return true;
    }
    // A stale-looking render is not always a paint problem: the terminal's own cols/rows can be wrong for
    // its actual container width (a sibling's DOM change, a still-settling flex pass) without ever having
    // gone through a resize event. fit() re-measures the container and calls term.resize() when that
    // differs, which repaints AND corrects wrapping in one pass. Re-check the mismatch afterward — a pure
    // paint glitch (fit is a no-op) still needs the appearance refresh below.
    const beforeCols = view.term.cols, beforeRows = view.term.rows;
    const viewportAnchor = this.captureTerminalViewportAnchor(view);
    this.tallFit(view);
    if (view.term.cols !== beforeCols || view.term.rows !== beforeRows) {
      this.beginTerminalViewportRestore(view, viewportAnchor);
      if (view.term.cols >= 2 && view.term.rows >= 2) this.sendResize(view, view.term.cols, view.term.rows, true);
      if (!this.terminalTailRenderMismatch(view)) {
        if (follow) this.scrollTerminalV2ToBottom(view);
        else this.scrollTerminalV2ToLine(view, Math.max(0, view.term.buffer.active.baseY - restoreRowsFromBottom));
        return true;
      }
    }
    if (this.session(view.sessionId)?.agent_kind === "codex") {
      this.refreshTerminalAppearance(view, true);
      if (follow) this.scrollTerminalV2ToBottom(view);
      else this.scrollTerminalV2ToLine(view, Math.min(restoreLine, view.term.buffer.active.baseY));
      if (view.tailRepairFrame) cancelAnimationFrame(view.tailRepairFrame);
      view.tailRepairFrame = requestAnimationFrame(() => {
        view.tailRepairFrame = requestAnimationFrame(() => {
          view.tailRepairFrame = 0;
          if (view.closed || !view.container.classList.contains("visible")) return;
          if (this.terminalTailRenderMismatch(view)) this.forceVisibleTerminalReflowViaResizeNudge(view, 1);
          else view.renderRepairArmed = true;
        });
      });
      return true;
    }
    this.refreshTerminalAppearance(view, true);
    if (follow) this.scrollTerminalV2ToBottom(view);
    else this.scrollTerminalV2ToLine(view, Math.min(restoreLine, view.term.buffer.active.baseY));
    return true;
  }

  shouldForceTerminalActivationReflow(view, switchedViews) {
    if (!view || view.closed || !this.isTerminalScrollV2() ||
        !view.container.classList.contains("visible")) return false;
    const now = Date.now();
    if (now - (view.lastActivationReflowAt || 0) < TERMINAL_ACTIVATION_REFLOW_IDLE_MS) return false;
    if (view.forceResizeAfterFit || !view.lastActivationReflowAt) return true;
    if (!switchedViews) return false;
    const hiddenFor = view.hiddenAt ? now - view.hiddenAt : Number.POSITIVE_INFINITY;
    return hiddenFor >= TERMINAL_ACTIVATION_REFLOW_IDLE_MS;
  }

  // Re-measures and force-resends a terminal's size at several points after it becomes active,
  // bypassing sendResize's own dedup each time. Layout can still be settling well past the existing
  // single-shot activation fit (fonts, a sidebar mid-resize, a flex pass waiting on another panel),
  // and there is otherwise no retry for a resize the server silently dropped or a program never fully
  // redrew for. This is the same "keep re-measuring and re-sending until it's right" behavior a manual
  // drag-resize gets for free from a live ResizeObserver stream — just scoped to the active terminal
  // and self-terminating instead of a standing timer.
  scheduleActiveTerminalSettleWatchdog(view) {
    this.clearActiveTerminalSettleWatchdog(view);
    if (!view || view.closed || !this.isTerminalScrollV2() || !this.terminalPageCanResize()) return;
    for (const delay of TERMINAL_ACTIVE_SETTLE_DELAYS_MS) {
      view.settleWatchdogTimers.push(setTimeout(() => {
        if (view.closed || this.activeId !== view.sessionId || !view.container.classList.contains("visible") ||
            this.sidebarResizeInProgress || !this.terminalPageCanResize()) return;
        if (this.shouldDeferPromptReflowFit(view)) return;
        const beforeCols = view.term.cols, beforeRows = view.term.rows;
        const viewportAnchor = this.captureTerminalViewportAnchor(view);
        this.tallFit(view);
        const colsChanged = view.term.cols !== beforeCols || view.term.rows !== beforeRows;
        if (colsChanged) this.beginTerminalViewportRestore(view, viewportAnchor);
        if (colsChanged && view.term.cols >= 2 && view.term.rows >= 2) this.sendResize(view, view.term.cols, view.term.rows);
        if (colsChanged || this.terminalTailRenderMismatch(view)) {
          this.repairTerminalRenderIfStale(view);
        }
      }, delay));
    }
  }

  clearActiveTerminalSettleWatchdog(view) {
    if (!view) return;
    for (const timer of view.settleWatchdogTimers) clearTimeout(timer);
    view.settleWatchdogTimers = [];
  }

  scheduleTerminalTailRepair(view) {
    if (!this.attachRepaintEnabled()) return;
    if (!view || view.closed || view.tailRepairTimer || view.tailRepairConfirmTimer ||
        !view.container.classList.contains("visible") || !this.isTerminalScrollV2() ||
        this.session(view.sessionId)?.agent_kind !== "codex" || !this.terminalPageCanResize()) return;
    view.tailRepairTimer = setTimeout(() => {
      view.tailRepairTimer = 0;
      if (view.closed || this.activeId !== view.sessionId || !view.container.classList.contains("visible") ||
          !this.terminalPageCanResize()) return;
      const candidate = this.terminalRenderMismatchSnapshot(view);
      if (!candidate) {
        view.renderRepairArmed = true;
        return;
      }
      view.tailRepairConfirmTimer = setTimeout(() => {
        view.tailRepairConfirmTimer = 0;
        if (view.closed || this.activeId !== view.sessionId || !view.container.classList.contains("visible") ||
            !this.terminalPageCanResize()) return;
        const confirmed = this.terminalRenderMismatchSnapshot(view);
        if (!this.sameTerminalRenderMismatch(candidate, confirmed)) {
          if (!confirmed) view.renderRepairArmed = true;
          else this.scheduleTerminalTailRepair(view);
          return;
        }
        if (Date.now() - view.lastRenderRepairAt < TERMINAL_RENDER_REPAIR_COOLDOWN_MS) return;
        view.renderRepairArmed = true;
        if (this.repairTerminalRenderIfStale(view)) view.lastRenderRepairAt = Date.now();
      }, TERMINAL_RENDER_CONFIRM_DELAY_MS);
    }, TERMINAL_RENDER_CHECK_INTERVAL_MS);
  }

  scheduleTerminalActivationRepair(view, options = {}) {
    if (!view || view.closed || view.activationRepairFrame || !view.container.classList.contains("visible") ||
        !this.terminalPageCanResize()) return;
    if (!this.isTerminalScrollV2()) return;
    const generation = view.outputWriteGeneration;
    const forceReflow = !!options.forceReflow;
    view.activationRepairFrame = requestAnimationFrame(() => {
      view.activationRepairFrame = requestAnimationFrame(() => {
        view.activationRepairFrame = 0;
        if (view.closed || !view.container.classList.contains("visible") || !this.terminalPageCanResize()) return;
        if (view.outputWriteInFlight && generation !== view.outputWriteGeneration) return;
        const repaired = this.repairTerminalRenderIfStale(view);
        if (repaired) {
          view.lastActivationReflowAt = Date.now();
          return;
        }
        if (forceReflow) {
          view.lastActivationReflowAt = Date.now();
          view.forceResizeAfterFit = true;
          this.scheduleV2Fit(view);
        }
      });
    });
  }

  // Neither underlying implementation alone satisfies both CLIs: the resize-free clear leaves codex's
  // stale paint stuck, any resize-nudge magnitude/direction tried corrupts Claude's composer wrap (root
  // cause: xterm's resize-driven buffer reflow can permanently mis-rewrap an already-wrapped row when
  // cols is nudged even briefly and client-side-only, confirmed live). They need opposite treatment, so
  // branch by the session's actual agent_kind instead of hunting for one universal value.
  //
  // localStorage["td-debug-reflow-mode"]="nudge" forces the pre-fix nudge-everyone behavior for every
  // session regardless of kind -- a manual escape hatch kept ONLY for a side-by-side comparison if this
  // regresses again later, not a real option (it reintroduces the Claude wrap on its own). No UI for it;
  // set/clear it from the browser console.
  forceVisibleTerminalReflow(view) {
    if (!this.attachRepaintEnabled()) return false;
    if (localStorage.getItem("td-debug-reflow-mode") === "nudge") return this.forceVisibleTerminalReflowViaResizeNudge(view, 2);
    const kind = this.session(view.sessionId)?.agent_kind;
    if (kind !== "codex") return this.forceVisibleTerminalReflowViaClear(view);
    const result = this.forceVisibleTerminalReflowViaResizeNudge(view, 2);
    this.scheduleCodexReflowFollowup(view);
    return result;
  }

  // Codex still sometimes shows only its last few scrollback lines after a fresh connect (~10-20% of
  // tries, reported, persisting across 2-3 hard refreshes in some cases) -- likely a timing race, not
  // necessarily missing data: this nudge fires as soon as the client's snapshot replay completes, which
  // can be BEFORE the SERVER's own repair (_force_screen_repaint in session_manager.py, ~0.28-0.43s
  // delayed) has actually finished getting codex to redraw its full screen -- now unconditional
  // server-side (see session_manager.py), but still not instant. Retries at several delays (matching
  // how scheduleActiveTerminalSettleWatchdog already retries elsewhere in this file) instead of just
  // once, to give that server-side window more chances to be caught.
  //
  // Every attempt is gated on terminalTailRenderMismatch(view) -- the rendered DOM actually disagreeing
  // with xterm's own buffer, i.e. something a repaint could fix. If they already agree, a resize-nudge
  // is powerless to improve things (its whole mechanism is "force xterm to fully repaint its EXISTING
  // buffer", not "fetch more data"): either both already show the full correct content (retrying would
  // just be a visible flicker for nothing) or the buffer genuinely still lacks the content (a
  // client-side repaint cannot manufacture data that hasn't arrived). Either way, skip that attempt.
  scheduleCodexReflowFollowup(view) {
    if (!view || view.closed) return;
    for (const timer of view.codexReflowFollowupTimers) clearTimeout(timer);
    view.codexReflowFollowupTimers = CODEX_REFLOW_FOLLOWUP_DELAYS_MS.map((delay) => setTimeout(
      () => this.runCodexReflowFollowup(view, CODEX_REFLOW_FOLLOWUP_BUSY_RETRIES), delay));
  }

  // Deferred while output is still arriving. terminalTailRenderMismatch compares xterm's buffer tail to
  // the painted DOM tail, and those legitimately differ for a frame or two mid-stream, so acting on that
  // difference nudges the terminal's width in the middle of a synchronized-update frame and leaves
  // exactly the half-painted screen this repair exists to remove -- a greyed status line with a couple of
  // stray glyphs, which then heals on the CLI's next full redraw. Retry once output settles instead.
  runCodexReflowFollowup(view, busyRetriesLeft) {
    if (view.closed || this.activeId !== view.sessionId || !view.container.classList.contains("visible")) return;
    if (view.outputWriteInFlight || view.outputQueue.length) {
      if (busyRetriesLeft <= 0) return;
      view.codexReflowFollowupTimers.push(setTimeout(
        () => this.runCodexReflowFollowup(view, busyRetriesLeft - 1), CODEX_REFLOW_FOLLOWUP_BUSY_RETRY_MS));
      return;
    }
    if (!this.terminalTailRenderMismatch(view)) return;
    this.forceVisibleTerminalReflowViaResizeNudge(view, 2);
  }

  forceVisibleTerminalReflowViaClear(view) {
    if (!view || view.closed || view.v2ForcedReflowFrame || !view.container.classList.contains("visible") ||
        !this.terminalPageCanResize()) return false;
    if (this.shouldDeferPromptReflowFit(view)) return false;
    const rect = view.container.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) return false;
    const restoreLine = view.term.buffer.active.viewportY;
    const follow = view.scrollMode === "follow";
    view.v2Programmatic = true;
    view.v2ForcedReflowFrame = requestAnimationFrame(() => {
      view.v2ForcedReflowFrame = 0;
      if (view.closed || !view.container.classList.contains("visible")) {
        view.v2Programmatic = false;
        return;
      }
      // A pure repaint, deliberately WITHOUT ever touching cols/rows. The alternative (see
      // ...ViaResizeNudge below) nudges the container's CSS width to force a real xterm resize down
      // and back up, suppressed from reaching the server so the CLI never saw it. But xterm's
      // resize-driven reflow can PERMANENTLY mis-rewrap already-wrapped rows (box-drawing characters
      // especially) even for a resize that only ever happens client-side -- confirmed via a live debug
      // capture showing a 104->102->104 xterm-only bounce (never sent to the server:
      // suppressResizeToServer was true throughout) leave a horizontal composer rule permanently split
      // across two rows afterward. refreshTerminalAppearance(view, true) already clears and re-runs the
      // render service against the CURRENT (unchanged) cols/rows -- a full glyph repaint with no call
      // into resize()/reflow(), so there is nothing for xterm to fail to perfectly undo.
      this.refreshTerminalAppearance(view, true);
      if (follow) this.scrollTerminalV2ToBottom(view);
      else view.term.scrollToLine(Math.min(restoreLine, view.term.buffer.active.baseY));
      queueMicrotask(() => {
        if (!view.closed) view.v2Programmatic = false;
      });
    });
    return true;
  }

  // Original implementation, kept only for the A/B toggle: nudges the container narrower by ~2 cols
  // via CSS then restores, forcing a real (client-only, never sent to the server) xterm resize cycle.
  // nudgeCols: how many columns narrower to go before restoring. The original value (2) is exactly
  // wide enough to catch a composer's horizontal rule right at its wrap boundary; testing whether 1
  // column is still enough to unstick a stale codex paint without landing on that boundary.
  //
  forceVisibleTerminalReflowViaResizeNudge(view, nudgeCols = 2) {
    if (!view || view.closed || view.v2ForcedReflowFrame || view.v2ForcedReflowRestoreFrame ||
        !view.container.classList.contains("visible") || !this.terminalPageCanResize()) return false;
    if (this.shouldDeferPromptReflowFit(view)) return false;
    const rect = view.container.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) return false;
    const computed = window.getComputedStyle(view.container);
    const originalRight = view.container.style.right;
    const right = Number.parseFloat(computed.right);
    const cellWidth = Number(view.term._core?._renderService?.dimensions?.css?.cell?.width) || 8;
    const nudgeRight = (Number.isFinite(right) ? right : 4) + Math.max(Math.ceil(cellWidth * nudgeCols), 7 * nudgeCols);
    const restoreLine = view.term.buffer.active.viewportY;
    const follow = view.scrollMode === "follow";
    view.suppressResizeToServer = true;
    view.v2Programmatic = true;
    view.v2ForcedReflowFrame = requestAnimationFrame(() => {
      view.v2ForcedReflowFrame = 0;
      if (view.closed || !view.container.classList.contains("visible")) {
        view.suppressResizeToServer = false;
        view.v2Programmatic = false;
        return;
      }
      view.container.style.right = `${nudgeRight}px`;
      this.tallFit(view);
      this.refreshTerminalAppearance(view, true);
      view.v2ForcedReflowRestoreFrame = requestAnimationFrame(() => {
        view.v2ForcedReflowRestoreFrame = 0;
        if (!view.closed) {
          view.container.style.right = originalRight;
          if (view.container.classList.contains("visible")) {
            this.tallFit(view);
            this.refreshTerminalAppearance(view, true);
            if (follow) this.scrollTerminalV2ToBottom(view);
            else view.term.scrollToLine(Math.min(restoreLine, view.term.buffer.active.baseY));
          }
        }
        view.suppressResizeToServer = false;
        if (!view.closed && view.container.classList.contains("visible") && view.term.cols >= 2 && view.term.rows >= 2) {
          this.sendResize(view, view.term.cols, view.term.rows);
        }
        queueMicrotask(() => {
          if (!view.closed) view.v2Programmatic = false;
        });
      });
    });
    return true;
  }

  queueTerminalWrite(view, data, afterWrite = null) {
    if (!view || view.closed) return;
    view.outputQueue.push({ data, afterWrite, generation: view.outputWriteGeneration });
    this.drainTerminalWrites(view);
  }

  detectTerminalAttentionFromBuffer(view) {
    if (!view || view.closed || this.session(view.sessionId)?.agent_kind !== "claude" || !view.term) return;
    if (view.attentionScreenDetectionSuppressed) return;
    const buffer = view.term.buffer.active;
    const firstRow = Math.max(0, Number(buffer.baseY || 0) - 2);
    const lastRow = Math.min(buffer.length, firstRow + view.term.rows + 4);
    const text = [];
    for (let row = firstRow; row < lastRow; row += 1) {
      const line = buffer.getLine(row);
      if (line) text.push(line.translateToString(true));
    }
    const normalized = text.join(" ").replace(/\s+/g, " ").trim().toLowerCase();
    if (!TERMINAL_ATTENTION_TEXT_MARKERS.every((marker) => normalized.includes(marker))) return;
    const session = this.session(view.sessionId);
    if (!session || session.needs_attention) return;
    session.needs_attention = true;
    this.attentionServerStates.set(view.sessionId, true);
    if (this.processingStates.get(view.sessionId)) this.updateProcessingState(view.sessionId, false);
    this.triggerSessionAttention(view.sessionId);
  }

  // Tall-terminal-probe worktree only: xterm's own "follow" scroll mode is driven by baseY (how much has
  // scrolled into real backscroll), which stays 0 here since nothing ever scrolls off a 1000-row screen in
  // normal use. Cursor row is the equivalent signal in this model. Mirrors the standard terminal UX every
  // other terminal already has: auto-follow new output, but stop the moment the user scrolls away to read
  // something earlier, and resume once they scroll back near the bottom themselves.
  //
  // Deliberately NOT a "scroll" event listener tracking a persistent follow flag: xterm repositions its
  // hidden input textarea to track the cursor (for IME candidate-window placement), and while focused that
  // can itself trigger the browser's own "keep the focused element in view" auto-scroll -- confirmed live,
  // that fired a real "scroll" event with no code of mine involved, which corrupted a flag-based follow
  // state (traced: it silently flipped follow back on after the user had deliberately scrolled away, so
  // the very next line of output yanked them back down). Comparing scroll position against the cursor
  // FRESH, at both ends of each write, is immune to that: it only reacts to what changed within the write.
  // The cursor itself sits inside the input box, but Claude/Codex both draw a closing border plus a
  // status line (model/cost, "shift+tab to cycle", token counts, ...) below it -- real content the
  // cursor's own row doesn't account for, so following cursorY alone clips those rows out of view.
  // Bounded to a fixed 12-row lookahead below the cursor rather than a full-buffer scan: real trailing
  // decoration is always a handful of rows, never hundreds, so this stays O(12) per write regardless of
  // how tall the forced buffer is -- no scan of the other ~988 rows that can't matter here.
  //
  // buffer.getLine(y) takes an ABSOLUTE row index (0 = the very first row ever written, scrollback
  // included), but cursorY is relative to the current viewport top (viewportY, which tracks baseY here --
  // see the earlier scroll note above term.open()). They only coincide while baseY is still 0. Confirmed
  // live on a long-running session: at baseY=1584, getLine(cursorY) landed on unrelated leftover content
  // ("  526") while getLine(baseY+cursorY) landed on the real prompt row ("❯ ") -- every getLine() call
  // here has to add baseY back in, or this silently reads the wrong rows the moment a session outlives
  // one screenful of real scrollback. The returned row stays viewport-relative (i.e. still in cursorY's
  // frame), because that's what the pixel math both callers do needs.
  tallEffectiveBottomRow(view) {
    const buffer = view.term.buffer.active;
    const baseY = buffer.baseY || 0;
    const cursorY = buffer.cursorY;
    let last = cursorY;
    const limit = Math.min(buffer.length - 1 - baseY, cursorY + 12);
    for (let row = cursorY + 1; row <= limit; row += 1) {
      if (buffer.getLine(baseY + row)?.translateToString(true).trim()) last = row;
    }
    return last;
  }

  tallContainerNearCursor(view) {
    const inner = view.container.querySelector(".term-inner");
    if (!inner) return true;
    const cellHeight = view.term._core?._renderService?.dimensions?.css?.cell?.height;
    if (!cellHeight) return true;
    const target = Math.max(0, (this.tallEffectiveBottomRow(view) + 1) * cellHeight - view.container.clientHeight);
    return Math.abs(view.container.scrollTop - target) <= 24;
  }

  scrollTallContainerToCursor(view) {
    if (!view || view.closed || view.tallMaxScrollTop == null) return;
    // Following means showing the newest output, so xterm's own viewport has to be back at the bottom.
    // While parked it is deliberately left short of baseY (see tallHoldAnchorRow) -- that is what stops
    // it auto-scrolling -- and leaving it there would pin the canvas to stale rows no matter where the
    // container scrolls. Clearing the pin matters just as much: it is the flag that says "parked".
    const buffer = view.term.buffer.active;
    if (Number(buffer.viewportY || 0) < Number(buffer.baseY || 0)) view.term.scrollToBottom();
    view.tallPinnedViewportY = null;
    view.tallAnchorRow = null;
    // Move down to the bottom when behind it, but do not drag the view back up out of a small overshoot
    // (see TALL_OVERSHOOT_DEADZONE_PX) -- that correction is itself the visible snap.
    const target = view.tallMaxScrollTop;
    const top = view.container.scrollTop;
    if (top < target || top > target + TALL_OVERSHOOT_DEADZONE_PX) this.tallSetScrollTop(view, target);
  }

  // Every piece of tall-scroll state is derived from buffer contents, so all of it is meaningless the
  // moment term.reset() throws that buffer away -- and none of it resets itself. tallMaxScrollTop is the
  // damaging one: a restarted session repaints maybe 30 rows, but the ceiling left over from the previous
  // (much longer) session still points hundreds of rows down, and since the follow logic drives straight
  // to that ceiling, the view opens parked in blank space far below the new content with the composer out
  // of sight. container.scrollTop needs clearing for the same reason -- a DOM scroll offset survives
  // term.reset() untouched -- and tallFollowing goes back to true because a rebuilt buffer has no "the
  // user scrolled away to read something" to preserve.
  tallResetScrollState(view) {
    if (!view) return;
    view.tallMaxScrollTop = null;
    view.tallAnchorRow = null;
    view.tallPinnedViewportY = null;
    view.tallFollowing = true;
    this.tallSetScrollTop(view, 0);
  }

  // Every scroll this code performs goes through here so the "scroll" listener can tell our own moves
  // from the user's. Timing cannot do it: scroll events are delivered asynchronously, so any time window
  // either misses our own move or swallows a real one landing in the same frame. Remembering the exact
  // value we asked for is precise.
  tallSetScrollTop(view, value) {
    if (!view || view.closed) return;
    const target = Math.max(0, Math.round(value));
    view.tallLastProgrammaticTop = target;
    view.tallProgrammaticAt = performance.now();
    // Skip a write that changes nothing: it only adds scroll-event noise for the listener to sort out.
    if (Math.abs(view.container.scrollTop - target) > 1) view.container.scrollTop = target;
  }

  // The single place that decides "parked, or following the output?" -- for a scroll from ANY source.
  // This used to be wheel-only, which silently excluded the two ways of scrolling that emit no wheel
  // events: dragging the scrollbar thumb, and middle-click autoscroll. Neither ever cleared
  // tallFollowing, so every write snapped the view back to the prompt underneath the gesture (the
  // tearing), and neither ever restored xterm's pinned viewport on the way back down, which left the
  // newest lines unreachable with the container already sitting at its ceiling.
  tallApplySettledScroll(view) {
    if (!view || view.closed) return;
    const atBottom = view.tallMaxScrollTop == null ||
      view.container.scrollTop >= view.tallMaxScrollTop - TALL_BOTTOM_TOLERANCE_PX;
    view.tallFollowing = atBottom;
    // Reaching the bottom has to undo the parked state completely, xterm's viewport included: while
    // parked it sits deliberately short of baseY, and a stale pin there is precisely what made the last
    // lines unreachable. scrollTallContainerToCursor restores it and clears the pin.
    if (atBottom) this.scrollTallContainerToCursor(view);
    else this.tallCaptureAnchorRow(view);
  }

  // What the user is reading is a LINE, not a pixel offset, and in this layout those are not the same
  // thing. Canvas row N renders buffer row viewportY + N, and xterm keeps viewportY pinned to baseY here
  // (its own viewport never moves, ours does), so every line that overflows the forced row count and
  // pushes into scrollback slides the entire canvas up underneath a fixed scrollTop. Measured while
  // parked mid-history with output streaming: scrollTop held at exactly 17212 the whole time while
  // viewportY went 401 -> 1603, so the line under the viewport drifted from "1222" to "3022" -- the view
  // never jumped, but 1200 lines scrolled past under it. Anchoring to an absolute buffer row and
  // recomputing scrollTop from it each write is what actually holds a line still.
  tallCaptureAnchorRow(view) {
    if (!view || view.closed) return;
    const cellHeight = view.term._core?._renderService?.dimensions?.css?.cell?.height;
    if (!cellHeight) { view.tallAnchorRow = null; view.tallPinnedViewportY = null; return; }
    const viewportY = Number(view.term.buffer.active.viewportY || 0);
    view.tallAnchorRow = viewportY + Math.round(view.container.scrollTop / cellHeight);
    view.tallPinnedViewportY = viewportY;
  }

  // Holds the anchored line by keeping xterm's viewport where it was, rather than letting it slide and
  // then correcting scrollTop to compensate. Correcting after the fact was accurate -- the anchored line
  // sat on the same pixel row in 871 of 872 sampled frames -- but ruinously expensive: xterm only leaves
  // its viewport alone while it believes it is scrolled up, and here it never was (our container did the
  // scrolling, so viewportY stayed glued to baseY). Every line of new output therefore advanced viewportY,
  // which remaps every rendered row to a different buffer row and forces the DOM renderer to rebuild all
  // 1000 of them, plus a compensating scrollTop write. Measured over 9s of line-by-line output while
  // parked: 107 viewport shifts and 221 scrollTop writes -- the source of the visible jitter.
  //
  // Putting the viewport back once is all it takes, because that leaves viewportY < baseY, which is
  // exactly xterm's own "the user has scrolled up" state -- from then on xterm declines to auto-scroll
  // and holds the position itself, for free, and the new output lands on rows outside the rendered window
  // so there is nothing to repaint at all. The steady state costs one integer comparison per write.
  tallHoldAnchorRow(view) {
    if (!view || view.closed || view.tallPinnedViewportY == null) return;
    const current = Number(view.term.buffer.active.viewportY || 0);
    if (current === view.tallPinnedViewportY) return;
    view.term.scrollLines(view.tallPinnedViewportY - current);
    const settled = Number(view.term.buffer.active.viewportY || 0);
    if (settled === view.tallPinnedViewportY) return;
    // xterm could not go back that far -- the anchored line has aged out of the scrollback entirely.
    // Absorb whatever it could not give us with the container and re-pin, so we stop asking for a row
    // that no longer exists.
    const cellHeight = view.term._core?._renderService?.dimensions?.css?.cell?.height;
    if (cellHeight) {
      this.tallSetScrollTop(view, view.container.scrollTop - (settled - view.tallPinnedViewportY) * cellHeight);
    }
    view.tallPinnedViewportY = settled;
    view.tallAnchorRow = settled + Math.round(view.container.scrollTop / (cellHeight || 21));
  }

  // `inner` (see term.open() below) is always a full FORCE_ROWS tall in CSS regardless of how much of it
  // actually has content -- that's what lets xterm treat it as an ordinary, fully-fitting terminal (see
  // that comment). But it means the browser's own native max-scroll lets the user wheel/trackpad straight
  // past the real content into however many hundred rows of permanently blank space remain below the
  // prompt, with nothing to stop them -- unlike a normal terminal, where there's simply nothing past the
  // prompt to scroll into. tallMaxScrollTop tracks where the real content currently ends (reusing
  // tallCursorRegionMostlyBlank's gate, so it never latches onto a mid-padding position either -- see that
  // comment) and the "scroll" listener below enforces it as a hard ceiling, independent of whether the
  // view is currently following. Updating it even while not following matters: content keeps growing while
  // the user has scrolled away to read history, and the ceiling has to grow with it, or scrolling back down
  // later would stop short of the actual new bottom.
  tallUpdateMaxScrollTop(view) {
    // A replay is not a stream of finished screens. Reattaching replays the saved buffer and the agent
    // repaints over it, so the cursor lands wherever each escape sequence leaves it -- and deriving the
    // content bottom from that cursor makes the bottom, and the view chasing it, lurch. Measured on a
    // real tab switch into a busy Codex session: the ceiling went 5386 -> 10804 -> 16831 -> 3769 -> 9901
    // -> 1669 -> 20212 within about 350ms, eight visible positions, two of them backwards. None of those
    // intermediate values described the screen the user was about to see; the replay's completion handler
    // settles it once from the finished screen, which is the only value that means anything.
    if (view.replaying) return;
    // Switching between the normal and alternate screens replaces the entire visible surface, so any
    // "the user scrolled away to read something" state from the old one is meaningless against the new
    // one -- without this reset, opening a pager after having scrolled up would inherit tallFollowing
    // false and strand the view. Note this deliberately does NOT special-case where to scroll on the
    // alternate screen: following the cursor turns out to be right there too, because a full-screen app
    // leaves its cursor where its content is. Measured live, `seq 1 500 | less` bottom-aligns -- it
    // paints lines 1-500 into rows 499-998 with "(END)" on row 999 and parks the cursor there, so rows
    // 0-498 are genuinely blank and following the cursor to the bottom is exactly right. (An earlier
    // pass here forced row 0 on entering the alternate screen, on the strength of a probe that read rows
    // 0-39 and saw blanks; the probe was reading a region the viewport was never showing.)
    const alternate = view.term.buffer.active.type === "alternate";
    if (alternate !== view.tallOnAlternateScreen) {
      view.tallOnAlternateScreen = alternate;
      view.tallFollowing = true;
    }
    if (this.tallCursorRegionMostlyBlank(view)) return;
    const cellHeight = view.term._core?._renderService?.dimensions?.css?.cell?.height;
    if (!cellHeight || !view.container.clientHeight) return;
    // tallEffectiveBottomRow, not raw cursorY: picks up the closing border + status line Claude/Codex
    // draw below the input box (see that function's comment), so the boundary lands past them instead of
    // clipping them out of view.
    const bottomPx = (this.tallEffectiveBottomRow(view) + 1) * cellHeight;
    const next = Math.max(0, bottomPx - view.container.clientHeight);
    const current = view.tallMaxScrollTop;
    // Growing is applied at once; shrinking has to hold first, for the same reason the scrollable height
    // does (see tallApplyGeometry). While following, the view is driven to this value, so a bottom that
    // dips for a frame during an agent's repaint drags the view backwards -- the residual upward jump
    // still visible on a tab switch after the replay guard above. Real shrinkage still lands, just after
    // it has proved itself rather than on the first frame that suggests it.
    if (current == null || next >= current) {
      view.tallMaxScrollTop = next;
      view.tallCeilingShrinkTarget = null;
    } else {
      if (view.tallCeilingShrinkTarget !== next) {
        view.tallCeilingShrinkTarget = next;
        view.tallCeilingShrinkSince = Date.now();
      }
      if (Date.now() - (view.tallCeilingShrinkSince || 0) >= TALL_SHRINK_SETTLE_MS) view.tallMaxScrollTop = next;
    }
    this.tallApplyGeometry(view);
  }

  // A snapshot/session-attach redraw pushes "rows" blank rows past the cursor before clearing and
  // repainting -- invisible on a normal ~40-row terminal. Forced to 1000 rows, that same trick walks the
  // cursor through up to 1000 blank rows before the redraw actually lands, and dtach/websocket framing
  // splits it across many writes, so a write's callback can fire with the cursor sitting wherever this
  // particular chunk's blank run happened to end, well before the matching clear+redraw chunk arrives.
  // Confirmed live (instrumented scrollTallContainerToCursor across a real reconnect): a mid-sequence
  // write landed at cursorY=995, and naively following it scrolled the container there for over a
  // second before the next write (real content, cursorY=161) corrected it -- a real, visible "scrolled
  // past the bottom, prompt pushed far up" glitch.
  //
  // Two things this can't be detected from: the escape sequence isn't consistent (confirmed live: one
  // reconnect used bare "\r\n" pairs, another used repeated "\x1b[2K\x1b[1B" erase-line+cursor-down --
  // whatever a given TUI's redraw path happens to use to advance a blank row), and the buffer row at the
  // cursor isn't reliably blank either -- it can carry a stray glyph ghosted there from an earlier,
  // differently-sized frame that a later redraw never revisited (confirmed live: row 995 held a lone
  // "❯ " left over from a prior render). What's reliable is the shape of the neighborhood: real settled
  // content is dense (a live conversation has text on most nearby rows); a cursor mid-blank-run sits in a
  // stretch that's almost entirely empty except for whatever stale ghosts happen to be scattered through
  // it. Requiring most of a screenful above the cursor to be blank catches this regardless of which
  // escape sequence produced it, and a false trigger costs nothing -- it just skips one write's follow,
  // and the very next write (arriving momentarily) reliably has a trustworthy cursor to follow instead.
  tallCursorRegionMostlyBlank(view) {
    const buffer = view.term.buffer.active;
    const baseY = buffer.baseY || 0;
    const row = buffer.cursorY;
    const start = Math.max(0, row - 20);
    let blank = 0;
    let total = 0;
    for (let r = start; r <= row; r += 1) {
      total += 1;
      // getLine() is absolute, cursorY is viewport-relative -- see tallEffectiveBottomRow's comment.
      if (!buffer.getLine(baseY + r)?.translateToString(true).trim()) blank += 1;
    }
    return total > 0 && blank / total >= 0.7;
  }

  drainTerminalWrites(view) {
    if (!view || view.closed || view.outputWriteInFlight) return;
    if (!view.outputQueue.length) return;
    // One write per batch, not per websocket frame. A streaming agent delivers ~50 frames/sec, and each
    // write schedules its own xterm refresh plus the follow-up chain below, so writing frame-by-frame paid
    // that cost ~50x/sec. Only consecutive same-generation items are merged: a reconnect bumps the
    // generation and its output must not be fused with the previous connection's.
    const generation = view.outputQueue[0].generation;
    const batch = [];
    while (view.outputQueue.length && view.outputQueue[0].generation === generation) {
      batch.push(view.outputQueue.shift());
    }
    view.outputWriteInFlight = true;
    // view.tallFollowing (default true; only ever changed by the "wheel" listener in ensureView) is the
    // sole source of truth for whether to follow -- NOT a fresh per-write scrollTop comparison, which was
    // tried first and had a real feedback-loop bug: the browser's own scroll-into-view drift (see that
    // listener's comment) could make one write's check read a contaminated position, which then locked
    // "following" on for every write after it.
    const following = view.tallFollowing !== false;
    let total = 0;
    for (const item of batch) {
      this.noteTerminalViewportRestoreOutput(view, item.data);
      total += item.data.length;
    }
    let payload;
    if (batch.length === 1) {
      payload = batch[0].data;
    } else {
      payload = new Uint8Array(total);
      let offset = 0;
      for (const item of batch) { payload.set(item.data, offset); offset += item.data.length; }
    }
    view.term.write(payload, () => {
      // Always release the writer. A reconnect invalidates the old callback's
      // UI work but must not strand the new connection's queued output.
      view.outputWriteInFlight = false;
      const live = !view.closed && generation === view.outputWriteGeneration;
      if (live) {
        for (const item of batch) {
          if (item.afterWrite) item.afterWrite();
        }
      }
      if (live) {
        // Kept up to date regardless of following (see tallUpdateMaxScrollTop's comment) -- it no-ops on
        // a mid-padding write (see tallCursorRegionMostlyBlank's comment), which also means
        // scrollTallContainerToCursor below correctly leaves scrollTop alone for that one cycle instead
        // of following a bogus position: the very next write (the real redraw) fires this callback again
        // with a trustworthy cursor.
        this.tallUpdateMaxScrollTop(view);
        // Any gesture in flight -- wheel, scrollbar drag, autoscroll -- owns the view until it settles.
        const userScrolling = view.tallPointerHeld ||
          Date.now() < Math.max(view.tallWheelActiveUntil || 0, view.tallScrollActiveUntil || 0);
        if (userScrolling) {
          // Deliberately nothing: the settle handler decides where this lands.
        } else if (following && view.tallLastProgrammaticTop != null &&
                   Math.abs(view.container.scrollTop - view.tallLastProgrammaticTop) > TALL_FOLLOW_BREAK_PX) {
          // Following, but the view is no longer where this code last put it: something moved it and the
          // scroll event saying so has not been delivered yet. Scroll events are asynchronous, so a
          // gesture's first frames land before any suppression is in place -- measured as a 3-frame burst
          // that yanked the view from the top back to the bottom the instant a drag began.
          //
          // Compared against our own last position, NOT against the ceiling: the ceiling moves down as
          // output arrives, so on a fresh terminal (container at 0, ceiling jumping to thousands) a
          // ceiling comparison reads ordinary growth as "the user scrolled away" and parks the terminal
          // at the top, never following again. Measured exactly that way. The distance from where we put
          // it only changes when something else moves it.
          view.tallFollowing = false;
          this.tallCaptureAnchorRow(view);
        } else if (following) {
          this.scrollTallContainerToCursor(view);
        } else {
          // Holds the anchored LINE still (see tallHoldAnchorRow), which also absorbs the browser's own
          // scroll-into-view drift -- the user should never see the view move while they have deliberately
          // scrolled away to read something. The anchor it defends is captured by the settle handler once
          // the gesture ends, which is why the branch above yields while one is still running.
          this.tallHoldAnchorRow(view);
        }
      }
      if (live) this.detectTerminalAttentionFromBuffer(view);
      if (live && view.needsViewportRepair && !view.outputQueue.length &&
          view.container.classList.contains("visible")) {
        view.needsViewportRepair = false;
        this.repairTerminalViewport(view);
      }
      if (live) this.scheduleHistoryTerminalModelRefresh(view);
      if (live) this.scheduleClaudeStatusRowRefresh(view);
      if (live) this.scheduleTerminalTailRepair(view);
      if (live) this.scheduleTerminalViewportRestore(view);
      this.drainTerminalWrites(view);
    });
  }

  scheduleClaudeStatusRowRefresh(view) {
    if (!view || view.closed || view.claudeStatusRowRefreshTimer || this.session(view.sessionId)?.agent_kind !== "claude" ||
        !view.container.classList.contains("visible") || view.scrollMode !== "follow" || !this.xtermAtBottom(view)) return;
    const elapsed = Date.now() - view.lastClaudeStatusRowRefreshAt;
    const delay = Math.max(0, CLAUDE_STATUS_ROW_REFRESH_INTERVAL_MS - elapsed);
    view.claudeStatusRowRefreshTimer = setTimeout(() => {
      view.claudeStatusRowRefreshTimer = 0;
      if (view.closed || this.session(view.sessionId)?.agent_kind !== "claude" ||
          !view.container.classList.contains("visible") || view.scrollMode !== "follow" || !this.xtermAtBottom(view)) return;
      view.lastClaudeStatusRowRefreshAt = Date.now();
      const lastRow = Math.max(0, view.term.rows - 1);
      view.term.refresh(Math.max(0, lastRow - 2), lastRow);
    }, delay);
  }

  scheduleHistoryTerminalModelRefresh(view) {
    if (!view || view.closed || view.historyModelRefreshTimer || !this.historyOpen ||
        view.sessionId !== this.activeId || this.activeFileKey !== null) return;
    view.historyModelRefreshTimer = setTimeout(() => {
      view.historyModelRefreshTimer = 0;
      if (view.closed || !this.historyOpen || view.sessionId !== this.activeId || this.activeFileKey !== null) return;
      this.renderHistoryModel(this.session(view.sessionId), this.historyTurnsBySession.get(view.sessionId) || this.historyTurns);
    }, 180);
  }

  repairTerminalViewport(view) {
    if (!this.attachRepaintEnabled()) return;
    // Do this only after an initial replay has drained and only while output
    // following is active. The older generic viewport scroll listener caused
    // this same repair to race a user's first wheel gesture after tab switch.
    if (!view || view.closed || view.manualScroll || !view.keepBottom || view.viewportRepairFrame ||
        !view.container.classList.contains("visible")) return;
    const generation = view.manualScrollGeneration;
    view.viewportRepairFrame = requestAnimationFrame(() => {
      view.viewportRepairFrame = requestAnimationFrame(() => {
        view.viewportRepairFrame = 0;
        if (view.closed || view.manualScroll || generation !== view.manualScrollGeneration ||
            !view.keepBottom || !view.container.classList.contains("visible") || !this.terminalAtBottom(view)) return;
        this.tallFit(view);
        this.refreshTerminal(view);
        const { cols, rows } = view.term;
        if (cols >= 2 && rows >= 2) this.sendResize(view, cols, rows);
        this.scrollTerminalToBottom(view);
      });
    });
  }

  refreshTerminalAppearance(view, forceResize = false) {
    if (!view || !view.term) return;
    view.term.options.theme = { ...this.termTheme(), ...(this.terminalFindThemeOverride(view) || {}) };
    if (typeof view.term.clearTextureAtlas === "function") view.term.clearTextureAtlas();
    const renderService = view.term._core?._renderService;
    const allowForcedRendererReset = forceResize;
    if (allowForcedRendererReset && renderService) {
      if (typeof renderService.clear === "function") renderService.clear();
      if (typeof renderService.handleResize === "function") renderService.handleResize(view.term.cols, view.term.rows);
      else if (view.term._core?.resize) view.term._core.resize(view.term.cols, view.term.rows);
    }
    this.refreshTerminal(view);
  }

  scheduleViewportSettle(view) {
    if (this.isTerminalScrollV2()) {
      if (view?.scrollMode === "follow") this.scrollTerminalV2ToBottom(view);
      return;
    }
    if (view.settleFrame) cancelAnimationFrame(view.settleFrame);
    view.settleFrame = requestAnimationFrame(() => {
      view.settleFrame = requestAnimationFrame(() => {
        view.settleFrame = 0;
        if (!view.manualScroll && (view.keepBottom || Date.now() < view.pinBottomUntil)) {
          view.keepBottom = true;
          this.scrollTerminalToBottom(view);
          const atBottom = this.terminalAtBottom(view);
          if (!atBottom || Date.now() < view.pinBottomUntil) {
            clearTimeout(view.scrollSettleTimer);
            view.scrollSettleTimer = setTimeout(() => {
              if (!view.manualScroll && (view.keepBottom || Date.now() < view.pinBottomUntil)) {
                this.scheduleViewportSettle(view);
              }
            }, 250);
          }
        }
      });
    });
  }

  fitActive() {
    if (this.nativeVscodeMode || this.sidebarResizeInProgress || !this.terminalPageCanResize()) return;
    if (this.$("terminal-area").classList.contains("hidden")) return;
    const view = this.views.get(this.activeId);
    if (!view || !view.container.classList.contains("visible")) return;
    if (this.isTerminalScrollV2()) {
      this.scheduleV2Fit(view);
      this.scheduleV2ViewportSync(view);
      return;
    }
    const rect = view.container.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) return;
    this.tallFit(view);
    view.container.classList.remove("initializing");
    this.refreshTerminal(view);
    const { cols, rows } = view.term;
    if (cols < 2 || rows < 2) return;
    this.sendResize(view, cols, rows);
    if (view.keepBottom || Date.now() < view.pinBottomUntil) this.scheduleViewportSettle(view);
  }

  destroyView(id, view) {
    view.closed = true;
    view.renderObserver?.dispose();
    this.clearActiveTerminalSettleWatchdog(view);
    clearTimeout(view.manualScrollReleaseTimer);
    clearTimeout(view.scrollSettleTimer);
    clearTimeout(view.resizeRepairTimer);
    clearTimeout(view.tailRepairTimer);
    clearTimeout(view.tailRepairConfirmTimer);
    clearTimeout(view.claudeInitialReplayCheckTimer);
    clearTimeout(view.claudeStatusRowRefreshTimer);
    clearTimeout(view.historyModelRefreshTimer);
    clearTimeout(view.promptSubmissionReflowGuardTimer);
    clearTimeout(view.promptDraftSyncTimer);
    clearTimeout(view.promptDraftSyncDebounceTimer);
    clearTimeout(view.manualRepaintClickTimer);
    clearTimeout(view.pendingAgentPasteTimer);
    this.cancelTerminalViewportRestore(view);
    for (const timer of view.codexReflowFollowupTimers) clearTimeout(timer);
    if (view.settleFrame) cancelAnimationFrame(view.settleFrame);
    if (view.viewportRepairFrame) cancelAnimationFrame(view.viewportRepairFrame);
    if (view.v2ViewportSyncFrame) cancelAnimationFrame(view.v2ViewportSyncFrame);
    if (view.v2FitFrame) cancelAnimationFrame(view.v2FitFrame);
    if (view.v2InitialFitFrame) cancelAnimationFrame(view.v2InitialFitFrame);
    if (view.v2ForcedReflowFrame) cancelAnimationFrame(view.v2ForcedReflowFrame);
    if (view.v2ForcedReflowRestoreFrame) cancelAnimationFrame(view.v2ForcedReflowRestoreFrame);
    if (view.tailRepairFrame) cancelAnimationFrame(view.tailRepairFrame);
    if (view.activationRepairFrame) cancelAnimationFrame(view.activationRepairFrame);
    if (view.codexFocusRefreshFrame) cancelAnimationFrame(view.codexFocusRefreshFrame);
    clearTimeout(view.layoutFitRetryTimer);
    if (view.layoutObserver) view.layoutObserver.disconnect();
    if (view.scrollObserver) view.scrollObserver.disconnect();
    if (view.visibilityObserver) view.visibilityObserver.disconnect();
    if (view.ws) view.ws.close();
    view.terminalFindResultListener?.dispose();
    view.term.dispose();
    view.container.remove();
    this.views.delete(id);
  }

  async loadSettings() {
    try {
      const res = await fetch("/api/settings");
      const incoming = await res.json();
      const legacyTerminalIconsEnabled = incoming.show_terminal_icons === true;
      const storedTerminalIconAgents = incoming.terminal_icon_agents && typeof incoming.terminal_icon_agents === "object"
        ? incoming.terminal_icon_agents : {};
      incoming.terminal_icon_agents = Object.fromEntries(TERMINAL_ICON_AGENT_KINDS.map((kind) => [kind,
        Object.prototype.hasOwnProperty.call(storedTerminalIconAgents, kind)
          ? !!storedTerminalIconAgents[kind] : legacyTerminalIconsEnabled]));
      if (incoming.code_font_size == null) incoming.code_font_size = incoming.viewer_font_size || SETTINGS_DEFAULTS.code_font_size;
      if (incoming.side_split != null && incoming.side_split !== SETTINGS_DEFAULTS.side_split) {
        incoming.side_split_user_set = true;
      }
      if (incoming.sidebar_text_color == null) {
        const legacyColor = incoming.sidebar_status_color || incoming.wave_color;
        if (/^#[0-9a-f]{6}$/i.test(String(legacyColor || ""))) incoming.sidebar_text_color = legacyColor;
      }
      const legacyGlobTokens = String(incoming.search_glob || "").split(",").map((token) => token.trim()).filter(Boolean);
      const legacyIncludeGlob = legacyGlobTokens.filter((token) => !token.startsWith("!")).join(", ");
      const legacyExcludeGlob = legacyGlobTokens.filter((token) => token.startsWith("!")).join(", ");
      const migratedFileGlobSettings = incoming.tree_file_glob === SETTINGS_DEFAULTS.tree_file_glob &&
        incoming.search_file_glob === SETTINGS_DEFAULTS.search_file_glob && legacyIncludeGlob;
      const migratedExcludeGlob = incoming.excluded_file_glob === SETTINGS_DEFAULTS.excluded_file_glob &&
        incoming.search_glob !== SETTINGS_DEFAULTS.search_glob && legacyExcludeGlob;
      if (migratedFileGlobSettings) {
        incoming.tree_file_glob = legacyIncludeGlob;
        incoming.search_file_glob = legacyIncludeGlob;
      }
      if (migratedExcludeGlob) incoming.excluded_file_glob = legacyExcludeGlob;
      this.settings = { ...SETTINGS_DEFAULTS, ...incoming };
      this.persistedSettings = this.copySettings(this.settings);
      this.filesPanelWidthInitialized = !!this.settings.files_panel_width_initialized;
      this.lastFilesSidePanelTab = FILES_SIDE_PANEL_TABS.includes(this.settings.files_side_panel_last_tab)
        ? this.settings.files_side_panel_last_tab : "project";
      if (!this.settings.md_prompt_queues || typeof this.settings.md_prompt_queues !== "object") this.settings.md_prompt_queues = {};
      if (!this.settings.md_prompt_drafts || typeof this.settings.md_prompt_drafts !== "object") this.settings.md_prompt_drafts = {};
      if (!THEME_BY_ID[this.settings.theme]) this.settings.theme = SETTINGS_DEFAULTS.theme;
      this.settings.show_git_status = true;
      const excludedTokens = this.fileTypeFilterTokens();
      if (this.settings.hide_dot_folders !== false && !excludedTokens.includes("!.*")) excludedTokens.unshift("!.*");
      if (!excludedTokens.includes("!*.log")) excludedTokens.push("!*.log");
      const normalizedExcludedGlob = [...new Set(excludedTokens)].join(", ");
      const excludedGlobChanged = this.settings.excluded_file_glob !== normalizedExcludedGlob;
      this.settings.excluded_file_glob = normalizedExcludedGlob;
      this.settings.hide_dot_folders = excludedTokens.includes("!.*");
      this.syncLegacySearchGlob();
      if (migratedFileGlobSettings || migratedExcludeGlob || excludedGlobChanged) this.saveSettings();
    } catch (err) {
      this.settings = { ...SETTINGS_DEFAULTS };
      this.persistedSettings = this.copySettings(this.settings);
    }
    if (!/^#[0-9a-f]{6}$/i.test(String(this.settings.sidebar_text_color || ""))) {
      this.settings.sidebar_text_color = SETTINGS_DEFAULTS.sidebar_text_color;
    }
    this.settings.show_terminal_age = true;
    if (!THEME_BY_ID[this.settings.theme]) this.settings.theme = SETTINGS_DEFAULTS.theme;
    if (this.normalizeNotebookNotes()) this.saveSettings();
    // V2 is now the only desktop terminal scroll controller. Remove the old
    // browser-only opt-in so a previous preference cannot revive V1.
    localStorage.removeItem("termdeck.terminal_scroll_v2");
    const states = this.settings.project_state || {};
    if (!Object.keys(states).length && (this.settings.active_session_id || (this.settings.open_files || []).length)) {
      states.__all__ = { active_session_id: this.settings.active_session_id, open_files: this.settings.open_files };
      this.settings.project_state = states;
    }
    this.unreadSessions = this.unreadSessionIdsForCurrentWorktreeView();
    this.applySettings();
  }

  restoreOpenFiles() {
    const states = this.settings.project_state || {};
    const lists = Object.values(states).map((state) => state.open_files || []);
    const scopedSavedFiles = this.projectSlug ? this.getProjectState().open_files || [] : [];
    const scopedSavedKeys = new Set(scopedSavedFiles.map((file) => `${file.root}|${file.path}`));
    const files = lists.flat().filter((file) => file && file.root && file.path &&
      (!this.projectSlug || this.owningProjectKey(file.root) === this.projectStateKey())).slice(-OPEN_FILES_MAX_ENTRIES);
    let recoveredMisownedFile = false;
    for (const f of files) {
      const key = `${f.root}|${f.path}`;
      this.openFiles.set(key,
        { root: f.root, path: f.path, name: f.path.split("/").pop(), model: null, fullPath: null, truncated: false });
      if (this.projectSlug && !scopedSavedKeys.has(key)) recoveredMisownedFile = true;
    }
    if (recoveredMisownedFile) this.persistOpenFiles();
  }

  closeOpenFileEntry(key, entry, recordRecent = true) {
    clearTimeout(entry.autosaveTimer);
    entry.autosaveTimer = 0;
    if (entry.model) {
      if (this.lspClient?.model === entry.model) this.lspClient.deactivate();
      entry.model.dispose();
      entry.model = null;
    }
    if (recordRecent) {
      const recent = Array.isArray(this.settings.recent_closed_files) ? this.settings.recent_closed_files : [];
      this.settings.recent_closed_files = [{ root: entry.root, path: entry.path },
        ...recent.filter((item) => item.root !== entry.root || item.path !== entry.path)].slice(0, 30);
    }
    this.openFiles.delete(key);
    this.sidebarSelectedFileKeys.delete(key);
    if (this.sidebarFileSelectionAnchorKey === key) this.sidebarFileSelectionAnchorKey = null;
    if (this.secondaryFileKey === key) this.secondaryFileKey = null;
  }

  enforceOpenFilesLimit() {
    let changed = false;
    for (const [key, entry] of this.openFiles) {
      if (this.openFiles.size <= OPEN_FILES_MAX_ENTRIES) break;
      if (key === this.activeFileKey || entry.dirty || entry.savePromise) continue;
      this.closeOpenFileEntry(key, entry, false);
      changed = true;
    }
    return changed;
  }

  owningProjectKey(root) {
    const normalized = String(root || "").replace(/\\/g, "/").replace(/\/+$/, "");
    const worktree = this.worktrees.find((candidate) => String(candidate.path || "").replace(/\\/g, "/").replace(/\/+$/, "") === normalized);
    if (worktree) return worktree.id === "root" ? worktree.project : `${worktree.project}::worktree:${worktree.id}`;
    return this.projectForCwd(root)?.name || "__all__";
  }

  themeDefinition() {
    return THEME_BY_ID[this.settings.theme] || THEME_BY_ID.dark;
  }

  themeLabel() {
    return this.themeDefinition().label;
  }

  isLight() {
    return this.themeDefinition().kind === "light";
  }

  monacoThemeName() {
    return "termdeck-theme";
  }

  termTheme() {
    return this.themeDefinition().terminal;
  }

  applyThemeVariables() {
    const theme = this.themeDefinition();
    for (const [name, value] of Object.entries(theme.css)) document.documentElement.style.setProperty(name, value);
    document.documentElement.dataset.theme = theme.id;
    document.body.classList.toggle("theme-light", theme.kind === "light");
    document.body.classList.toggle("theme-dark", theme.kind !== "light");
  }

  defineMonacoTheme(theme = this.themeDefinition()) {
    monaco.editor.defineTheme(this.monacoThemeName(), {
      base: theme.monacoBase, inherit: true, rules: [], colors: theme.monacoColors,
    });
    if (this.editor) monaco.editor.setTheme(this.monacoThemeName());
  }

  applySettings({ fitTerminals = true } = {}) {
    const s = this.settings;
    const sidebar = this.$("sidebar");
    const filesVisible = FILES_SIDE_PANEL_TABS.includes(this.sideView);
    const normalWidth = Number(s.sidebar_width) || SETTINGS_DEFAULTS.sidebar_width;
    if (filesVisible && s.files_pinned && !this.filesPanelWidthInitialized) {
      s.files_width = FILEDECK_DEFAULT_SIDEBAR_WIDTH;
      this.filesPanelWidthInitialized = true;
      s.files_panel_width_initialized = true;
      localStorage.setItem("termdeck.files_panel_width_v2", "1");
      this.saveSettings();
    }
    const pinnedFileWidth = Math.max(Number(s.files_width) || 0, FILEDECK_DEFAULT_SIDEBAR_WIDTH);
    const floatingFileWidth = Math.max(Number(s.files_width) || 0, normalWidth * 2);
    const activeSidebarWidth = filesVisible && s.files_pinned ? pinnedFileWidth : normalWidth;
    const sidebarLeft = sidebar.getBoundingClientRect().left || 0;
    const sidebarRight = sidebarLeft + activeSidebarWidth;
    const maximumNotebookLeft = Math.max(0, window.innerWidth - 334);
    const defaultNotebookLeft = Math.min(Math.round(sidebarRight + 32), maximumNotebookLeft);
    const configuredNotebookLeft = Number(s.notebook_left);
    const notebookLeft = configuredNotebookLeft >= 0
      ? Math.max(0, Math.min(maximumNotebookLeft, configuredNotebookLeft))
      : defaultNotebookLeft;
    sidebar.style.width = activeSidebarWidth + "px";
    sidebar.style.minWidth = activeSidebarWidth + "px";
    document.documentElement.style.setProperty("--history-sidebar-width", `${normalWidth}px`);
    document.documentElement.style.setProperty("--notebook-panel-left", `${notebookLeft}px`);
    this.positionFloatingFilesPanel(floatingFileWidth);
    document.documentElement.style.setProperty("--sidebar-font-size", s.sidebar_font_size + "px");
    document.documentElement.style.setProperty("--project-font-size", s.project_font_size + "px");
    document.documentElement.style.setProperty("--terminal-font-size", s.terminal_font_size + "px");
    document.documentElement.style.setProperty("--ui-font-size", s.ui_font_size + "px");
    document.documentElement.style.setProperty("--files-tab-font-size", s.files_tab_font_size + "px");
    document.documentElement.style.setProperty("--code-font-size", s.code_font_size + "px");
    document.documentElement.style.setProperty("--bottom-font-size", s.bottom_font_size + "px");
    document.documentElement.style.setProperty("--ui-scale", String(this.normalizeUiScale((Number(s.bottom_font_size) || SETTINGS_DEFAULTS.bottom_font_size) / SETTINGS_DEFAULTS.bottom_font_size)));
    document.documentElement.style.setProperty("--sidebar-text-color", s.sidebar_text_color);
    const terminalIconSize = Math.max(FONT_MIN, Math.min(FONT_MAX, Number(s.terminal_icon_size) || SETTINGS_DEFAULTS.terminal_icon_size));
    const terminalStatusDotSize = Math.max(5, Math.min(10, terminalIconSize * 0.43));
    const terminalStatusDotLeft = 2 + (terminalIconSize - terminalStatusDotSize) / 2;
    const terminalRowLeftPadding = Math.max(20, terminalIconSize + 7);
    document.documentElement.style.setProperty("--terminal-icon-size", `${terminalIconSize}px`);
    document.documentElement.style.setProperty("--terminal-status-dot-size", `${terminalStatusDotSize}px`);
    document.documentElement.style.setProperty("--terminal-status-dot-left", `${terminalStatusDotLeft}px`);
    document.documentElement.style.setProperty("--terminal-row-left-padding", `${terminalRowLeftPadding}px`);
    this.updateSessionAgeStyles();
    const codeFontSize = Number(s.code_font_size) || SETTINGS_DEFAULTS.code_font_size;
    const configuredDiffFontSize = Number(s.diff_font_size) || SETTINGS_DEFAULTS.diff_font_size;
    const relativeDiffFontSize = configuredDiffFontSize === SETTINGS_DEFAULTS.diff_font_size
      ? Math.max(8, codeFontSize - 1)
      : Math.min(configuredDiffFontSize, Math.max(8, codeFontSize - 1));
    document.documentElement.style.setProperty("--diff-font-size", relativeDiffFontSize + "px");
    document.documentElement.style.setProperty("--tree-font-size", s.tree_font_size + "px");
    this.applyThemeVariables();
    for (const view of this.views.values()) {
      if (view.term.options.fontSize !== s.terminal_font_size) view.term.options.fontSize = s.terminal_font_size;
      this.refreshTerminalAppearance(view);
    }
    if (this.editor) {
      this.editor.updateOptions({ fontSize: s.code_font_size, wordWrap: s.editor_no_wrap ? "off" : "on" });
      this.defineMonacoTheme();
    }
    if (this.notebookEditor) {
      this.notebookEditor.updateOptions({ fontSize: s.code_font_size, wordWrap: s.editor_no_wrap ? "off" : "on" });
      this.notebookEditor.layout();
    }
    if (this.fileHistoryCurrentEditor) {
      this.fileHistoryCurrentEditor.updateOptions({ fontSize: s.code_font_size, wordWrap: s.editor_no_wrap ? "off" : "on" });
      this.fileHistoryCurrentEditor.layout();
    }
    if (this.fileHistoryDiffEditor) {
      this.fileHistoryDiffEditor.updateOptions({ fontSize: s.code_font_size, wordWrap: s.editor_no_wrap ? "off" : "on" });
      this.fileHistoryDiffEditor.getOriginalEditor().updateOptions({ fontSize: s.code_font_size, wordWrap: s.editor_no_wrap ? "off" : "on" });
      this.fileHistoryDiffEditor.getModifiedEditor().updateOptions({ fontSize: s.code_font_size, wordWrap: s.editor_no_wrap ? "off" : "on" });
      this.fileHistoryDiffEditor.layout();
    }
    this.$("stat-text").classList.toggle("hidden", !s.show_stats);
    this.$("stat-spark").classList.toggle("hidden", !s.show_stats);
    const editorWrapToggle = this.$("editor-wrap-toggle");
    if (editorWrapToggle) {
      const editorNoWrapEnabled = !!s.editor_no_wrap;
      editorWrapToggle.classList.toggle("on", editorNoWrapEnabled);
      editorWrapToggle.setAttribute("aria-pressed", String(editorNoWrapEnabled));
      editorWrapToggle.title = `Editor no wrap: ${editorNoWrapEnabled ? "on" : "off"}`;
    }
    this.renderInlineSizeControls();
    if (fitTerminals) this.fitActive();
  }

  initMonaco() {
    this.monacoReady = new Promise((resolve) => {
      require.config({ paths: { vs: "/static/vendor/monaco/vs" } });
      require(["vs/editor/editor.main"], () => {
        this.defineMonacoTheme();
        this.editor = monaco.editor.create(this.$("monaco-host"), {
          readOnly: false, theme: this.monacoThemeName(),
          automaticLayout: true, minimap: { enabled: false },
          scrollBeyondLastLine: false, fontSize: this.settings.code_font_size, lineNumbersMinChars: 4,
          renderLineHighlight: "all", folding: true, wordWrap: this.settings.editor_no_wrap ? "off" : "on", fixedOverflowWidgets: true,
        });
        this.lspClient = new TermdeckLspClient(this);
        this.lspClient.registerProviders();
        monaco.editor.onDidChangeMarkers(() => this.scheduleProblemsRefresh());
        this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => this.saveActiveFile());
        this.editor.addAction({
          id: "termdeck-save", label: "Save (⌘S)", contextMenuGroupId: "1_modification", contextMenuOrder: 0.5,
          run: () => this.saveActiveFile(),
        });
        this.editor.addAction({
          id: "termdeck-find", label: "Find (⌘F)", contextMenuGroupId: "navigation", contextMenuOrder: 1.1,
          run: (ed) => ed.getAction("actions.find").run(),
        });
        this.editor.addAction({
          id: "termdeck-replace", label: "Replace in File (⌥⌘F)", contextMenuGroupId: "navigation", contextMenuOrder: 1.2,
          keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyF],
          run: (ed) => ed.getAction("editor.action.startFindReplaceAction").run(),
        });
        this.editor.addAction({
          id: "termdeck-find-usages", label: "Find Usages in Project", contextMenuGroupId: "navigation",
          contextMenuOrder: 1.5,
          run: () => this.showEditorUsages(),
        });
        const notebookHost = this.$("notebook-editor-host");
        if (notebookHost) {
          notebookHost.textContent = "";
          this.notebookEditor = monaco.editor.create(notebookHost, {
            readOnly: false, theme: this.monacoThemeName(),
            automaticLayout: true, minimap: { enabled: false }, scrollBeyondLastLine: false,
            fontSize: this.settings.code_font_size, lineNumbersMinChars: 2, lineDecorationsWidth: 8, glyphMargin: false,
            renderLineHighlight: "all", folding: true, wordWrap: this.settings.editor_no_wrap ? "off" : "on",
            fixedOverflowWidgets: true, padding: { top: 10, bottom: 10 },
          });
          this.notebookEditor.onDidChangeModelContent(() => {
            if (!this.notebookMounted) return;
            const note = this.activeNotebookNote();
            const model = note ? this.notebookEditorModels.get(note.note_id) : null;
            if (!note || model !== this.notebookEditor.getModel()) return;
            this.setActiveNotebookText(this.notebookEditor.getValue(), false, false);
            clearTimeout(this.notebookTitleTimer);
            this.notebookTitleTimer = setTimeout(() => {
              this.renderNotebookTabs();
              this.saveSettings();
            }, 160);
          });
          this.notebookEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { void this.flushNotebook(); });
        }
        this.editor.onMouseDown((mouseEvent) => {
          const event = mouseEvent.event;
          if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || !mouseEvent.target.position) return;
          event.preventDefault();
          event.stopPropagation();
          void this.openEditorSymbolAtPosition(mouseEvent.target.position);
        });
        resolve();
      });
    });
  }

  saveSettings() {
    if (/^#[0-9a-f]{6}$/i.test(String(this.settings.sidebar_text_color || ""))) {
      localStorage.setItem("termdeck.sidebar_text_color", this.settings.sidebar_text_color);
    }
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.queueSettingsPatch();
    }, 400);
  }

  flushPendingSettingsSave() {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const patch = this.changedSettingsPatch(this.copySettings(this.settings));
    if (!Object.keys(patch).length) return;
    for (const operation of this.settingWriteOperations(patch)) {
      const body = operation.method === "PUT" ? JSON.stringify({ value: operation.value }) : undefined;
      void fetch(operation.path, { method: operation.method, headers: body ? { "Content-Type": "application/json" } : {},
        body, keepalive: !body || body.length < 60000 }).catch((error) => console.error("TermDeck settings exit save failed", error));
    }
  }

  copySettings(settings) {
    return JSON.parse(JSON.stringify(settings));
  }

  changedSettingsPatch(settingsSnapshot) {
    const patch = {};
    for (const [key, value] of Object.entries(settingsSnapshot)) {
      if (key === "project_state") continue;
      if (JSON.stringify(value) !== JSON.stringify(this.persistedSettings[key])) patch[key] = value;
    }
    return patch;
  }

  settingWriteOperations(patch) {
    const operations = [];
    for (const [key, value] of Object.entries(patch)) {
      const previous = this.persistedSettings[key];
      const keyed = value && previous && typeof value === "object" && typeof previous === "object" &&
        !Array.isArray(value) && !Array.isArray(previous);
      if (!keyed) {
        operations.push({ key, method: "PUT", path: `/api/settings/${encodeURIComponent(key)}`, value });
        continue;
      }
      const entryKeys = new Set([...Object.keys(previous), ...Object.keys(value)]);
      for (const entryKey of entryKeys) {
        if (!Object.prototype.hasOwnProperty.call(value, entryKey)) {
          operations.push({ key, entryKey, method: "DELETE",
            path: `/api/settings/${encodeURIComponent(key)}/${encodeURIComponent(entryKey)}` });
        } else if (JSON.stringify(value[entryKey]) !== JSON.stringify(previous[entryKey])) {
          operations.push({ key, entryKey, method: "PUT",
            path: `/api/settings/${encodeURIComponent(key)}/${encodeURIComponent(entryKey)}`, value: value[entryKey] });
        }
      }
    }
    return operations;
  }

  applyPersistedSettingOperation(operation, value) {
    if (operation.entryKey === undefined) {
      this.persistedSettings[operation.key] = this.copySettings(value);
      return;
    }
    const current = this.persistedSettings[operation.key] && typeof this.persistedSettings[operation.key] === "object"
      ? this.copySettings(this.persistedSettings[operation.key]) : {};
    if (operation.method === "DELETE") delete current[operation.entryKey];
    else current[operation.entryKey] = this.copySettings(value);
    this.persistedSettings[operation.key] = current;
  }

  queueSettingsPatch() {
    this.settingsSavePromise = this.settingsSavePromise.catch((error) => {
      console.error("TermDeck settings save failed", error);
    }).then(async () => {
      const settingsSnapshot = this.copySettings(this.settings);
      const patch = this.changedSettingsPatch(settingsSnapshot);
      if (!Object.keys(patch).length) return;
      for (const operation of this.settingWriteOperations(patch)) {
        const body = operation.method === "PUT" ? JSON.stringify({ value: operation.value }) : undefined;
        const response = await fetch(operation.path, { method: operation.method,
          headers: body ? { "Content-Type": "application/json" } : {}, body });
        if (!response.ok) throw new Error(`setting save failed for ${operation.key} (${response.status})`);
        const persisted = await response.json();
        this.applyPersistedSettingOperation(operation, persisted.value);
      }
      if (Object.keys(this.changedSettingsPatch(this.settings)).length) this.saveSettings();
    });
  }

  initInlineSizeControls() {
    this.inlineSizeControlRoots = new Map();
    for (const definition of INLINE_SIZE_SETTING_DEFINITIONS) {
      const root = document.createElement("div");
      root.id = `inline-size-control-${definition.key}`;
      root.className = "inline-size-controls hidden";
      root.setAttribute("role", "toolbar");
      root.setAttribute("aria-label", `${definition.label} size`);
      root.title = `${definition.label} size`;
      const row = document.createElement("div");
      row.className = "inline-size-control-row";
      const label = document.createElement("span");
      label.className = "inline-size-control-label";
      label.textContent = definition.label;
      const minus = document.createElement("button");
      minus.type = "button";
      minus.className = "inline-size-control-step";
      minus.textContent = "−";
      minus.title = `Decrease ${definition.label.toLowerCase()} size`;
      minus.setAttribute("aria-label", minus.title);
      const range = document.createElement("input");
      range.type = "range";
      range.className = "inline-size-control-range";
      range.min = String(FONT_MIN);
      range.max = String(FONT_MAX);
      range.step = "1";
      range.title = `Adjust ${definition.label.toLowerCase()} size`;
      range.setAttribute("aria-label", range.title);
      const value = document.createElement("span");
      value.className = "inline-size-control-value";
      const plus = document.createElement("button");
      plus.type = "button";
      plus.className = "inline-size-control-step";
      plus.textContent = "+";
      plus.title = `Increase ${definition.label.toLowerCase()} size`;
      plus.setAttribute("aria-label", plus.title);
      const reset = document.createElement("button");
      reset.type = "button";
      reset.className = "inline-size-control-reset";
      reset.textContent = "↺";
      reset.title = `Reset ${definition.label.toLowerCase()} size to default`;
      reset.setAttribute("aria-label", reset.title);
      minus.onclick = () => this.setInlineSize(definition.key, Number(range.value) - 1);
      plus.onclick = () => this.setInlineSize(definition.key, Number(range.value) + 1);
      range.oninput = () => this.setInlineSize(definition.key, Number(range.value));
      reset.onclick = () => this.resetInlineSize(definition.key);
      row.append(label, minus, range, value, plus, reset);
      root.appendChild(row);
      root.addEventListener("pointerdown", (event) => {
        this.startInlineSizeControlDrag(event, this.inlineSizeControlRoots.get(definition.key));
        event.stopPropagation();
      });
      root.addEventListener("click", (event) => event.stopPropagation());
      document.body.appendChild(root);
      this.inlineSizeControlRoots.set(definition.key, { root, range, value, position: null });
    }
    document.addEventListener("pointerover", (event) => {
      if (!this.settings.inline_size_controls || !(event.target instanceof Element)) return;
      if ([...this.inlineSizeControlRoots.values()].some((controls) => !controls.root.classList.contains("hidden"))) return;
      if (this.inlineSizeTargetForElement(event.target)) this.renderInlineSizeControls();
    });
    document.addEventListener("pointerdown", (event) => {
      if (![...this.inlineSizeControlRoots.values()].some((controls) => controls.root.contains(event.target))) {
        this.hideInlineSizeControls();
      }
    }, true);
    document.addEventListener("pointermove", (event) => this.dragInlineSizeControl(event));
    document.addEventListener("pointerup", () => this.finishInlineSizeControlDrag());
    window.addEventListener("resize", () => this.renderInlineSizeControls());
  }

  startInlineSizeControlDrag(event, controls) {
    if (event.button !== 0 || event.target instanceof HTMLInputElement || event.target instanceof HTMLButtonElement || !controls) return;
    const rect = controls.root.getBoundingClientRect();
    controls.position = { left: rect.left, top: rect.top };
    this.inlineSizeDrag = { controls, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
    controls.root.classList.add("dragging");
    event.preventDefault();
  }

  dragInlineSizeControl(event) {
    if (!this.inlineSizeDrag) return;
    const { controls, offsetX, offsetY } = this.inlineSizeDrag;
    const width = controls.root.offsetWidth;
    const height = controls.root.offsetHeight;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, event.clientX - offsetX));
    const top = Math.max(8, Math.min(window.innerHeight - height - 8, event.clientY - offsetY));
    controls.position = { left, top };
    controls.root.style.left = `${left}px`;
    controls.root.style.top = `${top}px`;
  }

  finishInlineSizeControlDrag() {
    if (!this.inlineSizeDrag) return;
    this.inlineSizeDrag.controls.root.classList.remove("dragging");
    this.inlineSizeDrag = null;
  }

  inlineSizeTargetForElement(element) {
    if (element.closest(".inline-size-controls, #settings-popover, #keys-backdrop")) return null;
    const targets = [
      { selectors: "#project-select", key: "project_font_size" },
      { selectors: "#files-section-tabs, .files-section-tab", key: "files_tab_font_size" },
      { selectors: "#status-name, #terminal-age, #history-meta, #stat-text", key: "ui_font_size" },
      { selectors: "#bottombar, #sidebar-footer, #terminal-actions, #files-section-header", key: "bottom_font_size" },
      { selectors: ".history-event pre, .history-diff, .markdown pre code", key: "diff_font_size" },
      { selectors: "#terminal-area, .term-container, .xterm", key: "terminal_font_size" },
      { selectors: "#editor-area, #history-area, #notebook-panel, #file-history-editor-host, #file-history-preview", key: "code_font_size" },
      { selectors: ".terminal-type-icon", key: "terminal_icon_size" },
      { selectors: ".tree-row, .search-file, .search-hit, .git-commit, .terminal-history-title-match, #files-section, #terminal-search-inline", key: "tree_font_size" },
      { selectors: ".session-item, .terminal-group, .closed-item, #sidebar-header, #session-list, #closed-section", key: "sidebar_font_size" },
      { selectors: "#main", key: "ui_font_size" },
    ];
    for (const target of targets) {
      const matched = element.closest(target.selectors);
      if (matched) return { element: matched, key: target.key };
    }
    return null;
  }

  inlineSizeTargetForKey(key) {
    const selectors = {
      sidebar_font_size: "#session-list, #closed-section",
      project_font_size: "#project-select",
      terminal_icon_size: ".terminal-type-icon",
      terminal_font_size: "#terminal-area",
      ui_font_size: "#status-name, #terminal-age, #history-meta, #stat-text",
      files_tab_font_size: "#files-section-tabs",
      code_font_size: "#editor-area, #history-area, #notebook-panel, #file-history-panel",
      bottom_font_size: "#sidebar-footer",
      diff_font_size: ".history-diff, .history-event pre, #file-history-preview",
      tree_font_size: "#files-tree, #search-results, #name-results, #git-results, #terminal-search-inline",
    }[key];
    if (!selectors) return null;
    for (const element of document.querySelectorAll(selectors)) {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" &&
          rect.width > 1 && rect.height > 1 && rect.bottom > 0 && rect.right > 0 &&
          rect.top < window.innerHeight && rect.left < window.innerWidth) return element;
    }
    return null;
  }

  renderInlineSizeControls() {
    if (!this.inlineSizeControlRoots) return;
    if (!this.settings.inline_size_controls) {
      this.hideInlineSizeControls();
      return;
    }
    const visibleTargets = new Map();
    const placedControls = [];
    for (const definition of INLINE_SIZE_SETTING_DEFINITIONS) {
      const controls = this.inlineSizeControlRoots.get(definition.key);
      const target = this.inlineSizeTargetForKey(definition.key);
      if (!target) {
        controls.root.classList.add("hidden");
        continue;
      }
      controls.range.value = String(Math.round(Number(this.settings[definition.key]) || 0));
      controls.value.textContent = `${Math.round(Number(this.settings[definition.key]) || 0)}px`;
      controls.root.classList.remove("hidden");
      visibleTargets.set(definition.key, target);
      if (controls.position) {
        const width = controls.root.offsetWidth;
        const height = controls.root.offsetHeight;
        const left = Math.max(8, Math.min(window.innerWidth - width - 8, controls.position.left));
        const top = Math.max(8, Math.min(window.innerHeight - height - 8, controls.position.top));
        controls.position = { left, top };
        placedControls.push({ left, top, right: left + width, bottom: top + height });
      }
    }
    for (const definition of INLINE_SIZE_SETTING_DEFINITIONS) {
      const controls = this.inlineSizeControlRoots.get(definition.key);
      const target = visibleTargets.get(definition.key);
      if (!target || controls.position) continue;
      const rect = target.getBoundingClientRect();
      const width = controls.root.offsetWidth;
      const height = controls.root.offsetHeight;
      const maxLeft = Math.max(8, window.innerWidth - width - 8);
      const maxTop = Math.max(8, window.innerHeight - height - 8);
      const left = Math.min(Math.max(8, rect.right - width - 8), maxLeft);
      let top = Math.min(Math.max(8, rect.top + 8), maxTop);
      for (let attempt = 0; attempt <= placedControls.length; attempt += 1) {
        const overlap = placedControls.find((placed) => left < placed.right && left + width > placed.left &&
          top < placed.bottom && top + height > placed.top);
        if (!overlap) break;
        top = overlap.bottom + 8;
        if (top > maxTop) top = Math.max(8, overlap.top - height - 8);
      }
      controls.root.style.left = `${left}px`;
      controls.root.style.top = `${top}px`;
      controls.position = { left, top };
      placedControls.push({ left, top, right: left + width, bottom: top + height });
    }
  }

  hideInlineSizeControls() {
    if (!this.inlineSizeControlRoots) return;
    for (const controls of this.inlineSizeControlRoots.values()) controls.root.classList.add("hidden");
  }

  setInlineSize(key, value) {
    if (!this.inlineSizeControlRoots?.has(key)) return;
    this.settings[key] = Math.max(FONT_MIN, Math.min(FONT_MAX, Number(value) || FONT_MIN));
    this.applySettings({ fitTerminals: false });
    this.saveSettings();
    this.renderInlineSizeControls();
  }

  resetInlineSize(key) {
    if (!this.inlineSizeControlRoots?.has(key) || typeof SETTINGS_DEFAULTS[key] !== "number") return;
    this.setInlineSize(key, SETTINGS_DEFAULTS[key]);
  }

  resetAllFontSizes() {
    for (const definition of INLINE_SIZE_SETTING_DEFINITIONS) this.settings[definition.key] = SETTINGS_DEFAULTS[definition.key];
    this.applySettings({ fitTerminals: false });
    this.saveSettings();
    this.renderInlineSizeControls();
  }

  resetAllFontSizesWithConfirmation() {
    if (window.confirm("Reset all font sizes to their defaults?")) this.resetAllFontSizes();
  }

  openInlineSizeEditor() {
    this.settings.inline_size_controls = true;
    this.fontSizeEditorOpen = false;
    this.applySettings({ fitTerminals: false });
    this.saveSettings();
    this.$("settings-popover").classList.add("hidden");
    this.renderInlineSizeControls();
  }

  exitInlineSizeControls() {
    if (!this.settings.inline_size_controls) return false;
    this.settings.inline_size_controls = false;
    this.fontSizeEditorOpen = false;
    this.hideInlineSizeControls();
    this.saveSettings();
    this.$("settings-popover").classList.add("hidden");
    return true;
  }

  formatSettingValue(item) {
    return item.type === "scale" ? `${this.settings[item.key]}px` : this.settings[item.key];
  }

  openSettingsPopover(anchor, items, showFontSizeEditor = false) {
    const pop = this.$("settings-popover");
    this.fontSizeEditorOpen = showFontSizeEditor;
    pop.classList.remove("lsp-settings-expanded");
    pop.textContent = "";
    pop.onkeydown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      pop.classList.add("hidden");
      anchor.focus();
    };
    pop.appendChild(this.buildThemeSelectRow());
    pop.appendChild(this.buildRemoteAccessRow());
    pop.appendChild(this.buildTerminalIconSettingsRow());
    pop.appendChild(this.buildToggleRow("Stats", () => (this.settings.show_stats ? "shown" : "hidden"),
      () => { this.settings.show_stats = !this.settings.show_stats; }));
    // Experiment switch: see attachRepaintEnabled(). Off means a terminal is shown exactly as its buffer
    // already holds it, with nothing forced to redraw on attach.
    pop.appendChild(this.buildToggleRow("Repaint on attach (reload)",
      () => (this.attachRepaintEnabled() ? "on" : "off"),
      () => { this.settings.attach_repaint = !this.attachRepaintEnabled(); }));
    pop.appendChild(this.buildTallTerminalToggleRow());
    for (const item of items) {
      if (!showFontSizeEditor || (this.settings.inline_size_controls && item.type !== "color")) continue;
      const row = document.createElement("div");
      row.className = "settings-row";
      const label = document.createElement("span");
      label.className = "settings-label";
      label.textContent = item.label;
      if (item.type === "color") {
        const controls = document.createElement("span");
        controls.className = "settings-controls";
        const input = document.createElement("input");
        input.type = "color";
        input.value = /^#[0-9a-f]{6}$/i.test(String(this.settings[item.key] || ""))
          ? this.settings[item.key] : SETTINGS_DEFAULTS[item.key];
        input.title = "Choose the sidebar text color";
        input.setAttribute("aria-label", item.label);
        input.oninput = () => {
          this.settings[item.key] = input.value;
          localStorage.setItem(`termdeck.${item.key}`, input.value);
          this.applySettings();
          this.saveSettings();
        };
        const reset = document.createElement("button");
        reset.type = "button";
        reset.className = "settings-color-reset";
        reset.textContent = "↺";
        reset.title = "Reset to default sidebar text color";
        reset.setAttribute("aria-label", reset.title);
        reset.onclick = () => {
          const defaultColor = SETTINGS_DEFAULTS[item.key];
          this.settings[item.key] = defaultColor;
          input.value = defaultColor;
          localStorage.setItem(`termdeck.${item.key}`, defaultColor);
          localStorage.removeItem("termdeck.sidebar_status_color");
          localStorage.removeItem("termdeck.wave_color");
          this.applySettings();
          this.saveSettings();
        };
        controls.append(input, reset);
        row.append(label, controls);
        pop.appendChild(row);
        continue;
      }
      const controls = document.createElement("span");
      controls.className = "settings-controls";
      const minus = document.createElement("button");
      minus.textContent = "−";
      const value = document.createElement("span");
      value.className = "settings-value";
      value.textContent = this.formatSettingValue(item);
      const plus = document.createElement("button");
      plus.textContent = "+";
      minus.onclick = () => { this.bumpSetting(item.key, -1); value.textContent = this.formatSettingValue(item); };
      plus.onclick = () => { this.bumpSetting(item.key, 1); value.textContent = this.formatSettingValue(item); };
      controls.append(minus, value, plus);
      row.append(label, controls);
      pop.appendChild(row);
    }
    if (!showFontSizeEditor) {
      pop.appendChild(this.buildFontSizeEditRow(anchor, items));
      if (this.lspClient) pop.appendChild(this.lspClient.buildSettingsSection(anchor));
    }
    pop.appendChild(this.buildSettingsSubmenu("Maintenance", [
      { label: "Export settings", buttonText: "download", run: () => { pop.classList.add("hidden"); this.exportSettings(); } },
      { label: "Terminal process report", buttonText: "view", run: () => { pop.classList.add("hidden"); void this.showTerminalProcessReport(); } },
      { label: "Reclaim orphan terminals", buttonText: "clean", run: () => { pop.classList.add("hidden"); void this.reclaimOrphanTerminals(); } },
      { label: "Kill all running terminals", buttonText: "kill", run: () => { pop.classList.add("hidden"); void this.killAllRunningTerminals(); } },
    ], anchor));
    this.positionPopover(pop, anchor);
  }

  buildActionRow(labelText, buttonText, run) {
    const row = document.createElement("div");
    row.className = "settings-row";
    const label = document.createElement("span");
    label.className = "settings-label";
    label.textContent = labelText;
    const button = document.createElement("button");
    button.className = "theme-toggle";
    button.textContent = buttonText;
    button.onclick = run;
    row.append(label, button);
    return row;
  }

  buildSettingsSubmenu(labelText, entries, anchor = null) {
    const root = document.createElement("div");
    root.className = "settings-submenu";
    const header = document.createElement("div");
    header.className = "settings-row settings-submenu-header";
    const label = document.createElement("span");
    label.className = "settings-label";
    label.textContent = labelText;
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "theme-toggle settings-submenu-toggle";
    toggle.textContent = "open";
    toggle.setAttribute("aria-expanded", "false");
    const items = document.createElement("div");
    items.className = "settings-submenu-items";
    for (const entry of entries) items.appendChild(this.buildActionRow(entry.label, entry.buttonText, entry.run));
    toggle.onclick = () => {
      const expanded = root.classList.toggle("expanded");
      toggle.setAttribute("aria-expanded", String(expanded));
      if (anchor) requestAnimationFrame(() => this.positionPopover(this.$("settings-popover"), anchor));
    };
    header.append(label, toggle);
    root.append(header, items);
    return root;
  }

  buildFontSizeEditRow(anchor, items) {
    const row = document.createElement("div");
    row.className = "settings-row settings-font-size-mode-row";
    const label = document.createElement("span");
    label.className = "settings-label";
    label.textContent = "Font sizes";
    const controls = document.createElement("span");
    controls.className = "settings-font-size-mode-controls";
    const visualize = document.createElement("button");
    visualize.type = "button";
    visualize.className = "theme-toggle";
    visualize.textContent = "visualize";
    visualize.title = "Edit font sizes in place on their UI elements";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "theme-toggle";
    edit.textContent = "edit";
    edit.title = "Edit font sizes in Settings";
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "settings-font-size-reset";
    reset.innerHTML = '<span class="codicon codicon-refresh"></span>';
    reset.title = "Reset all font sizes to defaults";
    reset.setAttribute("aria-label", reset.title);
    visualize.onclick = () => this.openInlineSizeEditor();
    edit.onclick = () => {
      this.exitInlineSizeControls();
      this.openSettingsPopover(anchor, items, true);
    };
    reset.onclick = () => this.resetAllFontSizesWithConfirmation();
    controls.append(visualize, edit, reset);
    row.append(label, controls);
    return row;
  }

  buildThemeSelectRow() {
    const row = document.createElement("div");
    row.className = "settings-row settings-theme-row";
    const label = document.createElement("div");
    label.className = "settings-theme-heading";
    const title = document.createElement("span");
    title.className = "settings-label";
    title.textContent = "Theme";
    label.append(title);
    const controls = document.createElement("div");
    controls.className = "settings-theme-control";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "theme-toggle settings-theme-toggle";
    toggle.setAttribute("aria-haspopup", "listbox");
    toggle.setAttribute("aria-expanded", "false");
    const updateToggle = () => {
      const theme = this.themeDefinition();
      toggle.textContent = theme.label;
      toggle.title = `${theme.label} theme · Click to expand`;
    };
    const select = document.createElement("select");
    select.className = "settings-theme-list";
    select.setAttribute("aria-label", "Choose a TermDeck theme");
    select.setAttribute("size", String(Math.min(8, THEME_DEFINITIONS.length)));
    select.setAttribute("role", "listbox");
    for (const theme of THEME_DEFINITIONS) {
      const option = document.createElement("option");
      option.value = theme.id;
      option.textContent = theme.label;
      select.appendChild(option);
    }
    select.value = this.themeDefinition().id;
    const applySelection = () => {
      this.settings.theme = THEME_BY_ID[select.value] ? select.value : SETTINGS_DEFAULTS.theme;
      select.value = this.settings.theme;
      this.applySettings();
      this.saveSettings();
      updateToggle();
    };
    const moveSelection = (delta) => {
      const currentIndex = THEME_DEFINITIONS.findIndex((theme) => theme.id === this.settings.theme);
      const nextIndex = (Math.max(0, currentIndex) + delta + THEME_DEFINITIONS.length) % THEME_DEFINITIONS.length;
      select.value = THEME_DEFINITIONS[nextIndex].id;
      applySelection();
    };
    const setExpanded = (expanded) => {
      row.classList.toggle("expanded", expanded);
      select.classList.toggle("hidden", !expanded);
      toggle.setAttribute("aria-expanded", String(expanded));
      toggle.title = expanded ? "Collapse theme list" : `${this.themeDefinition().label} theme · Click to expand`;
      if (expanded) select.focus();
      else toggle.focus();
    };
    toggle.onclick = () => setExpanded(!row.classList.contains("expanded"));
    toggle.onkeydown = (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowRight") {
        event.preventDefault();
        moveSelection(1);
      } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
        event.preventDefault();
        moveSelection(-1);
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        setExpanded(!row.classList.contains("expanded"));
      } else if (event.key === "Escape" && row.classList.contains("expanded")) {
        event.preventDefault();
        setExpanded(false);
      }
    };
    select.oninput = applySelection;
    select.onchange = applySelection;
    updateToggle();
    select.classList.add("hidden");
    controls.append(toggle, select);
    row.append(label, controls);
    return row;
  }

  buildToggleRow(labelText, valueText, flip, afterFlip = null) {
    const row = document.createElement("div");
    row.className = "settings-row";
    const label = document.createElement("span");
    label.className = "settings-label";
    label.textContent = labelText;
    const button = document.createElement("button");
    button.className = "theme-toggle";
    button.textContent = valueText();
    button.onclick = () => {
      flip();
      button.textContent = valueText();
      this.applySettings();
      this.saveSettings();
      if (afterFlip) afterFlip();
    };
    row.append(label, button);
    return row;
  }

  // xterm's default DOM renderer rebuilds row spans on every refresh, which dominated CPU on a busy
  // terminal (measured: JS 92% idle while the tab burned ~30%, i.e. the cost is paint, not script). The
  // WebGL renderer draws to a canvas instead. Must be attached after term.open() so a context exists, and
  // must fall back to the DOM renderer on context loss, which browsers do trigger under memory pressure.
  // The largest terminal this machine's GPU can actually back, in rows. Returns 0 when WebGL is
  // unavailable, which callers read as "use DOM".
  maxWebglSafeRows(cellHeight) {
    if (!cellHeight) return 0;
    try {
      const probe = document.createElement("canvas");
      const gl = probe.getContext("webgl2") || probe.getContext("webgl");
      if (!gl) return 0;
      const limit = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 0;
      const deviceCellHeight = Math.max(1, cellHeight * (window.devicePixelRatio || 1));
      return Math.floor(limit / deviceCellHeight);
    } catch (webglProbeError) {
      return 0;
    }
  }

  // Decides the two things that have to agree: how tall to make the terminal, and which renderer can
  // survive that height. They cannot be chosen independently -- asking for more rows than the GPU can
  // back does not fail loudly, it silently corrupts (see the WebGL note in ensureView) -- so this is the
  // single place that picks both.
  // Fit for the tall layout. FitAddon derives BOTH dimensions from the element it renders into, which is
  // why .term-inner had to stay a full 1000 rows tall -- and that fixed height is the entire reason the
  // scrollable area extends past the last line. Taking the row count out of the measurement frees the
  // element's height to track the content instead. Columns still come from xterm's own math (it accounts
  // for padding and scrollbar width), only the rows are overridden.
  tallFit(view) {
    if (!view || view.closed || !view.term) return;
    if (this.nativeVscodeMode) { view.fit.fit(); return; }
    let dims = null;
    try { dims = view.fit.proposeDimensions(); } catch (fitError) { dims = null; }
    if (!dims || !Number.isFinite(dims.cols) || dims.cols < 2) return;
    const rows = view.tallRows || TALL_ROWS_DOM;
    if (view.term.cols !== dims.cols || view.term.rows !== rows) view.term.resize(dims.cols, rows);
    this.tallApplyGeometry(view);
  }

  // Keeps the two heights that must differ in sync: the terminal element stays its full forced height so
  // xterm renders every row, while the scrollable box is only as tall as the content. The container then
  // cannot scroll past the last line, because there is nothing past it -- no clamp, nothing to correct,
  // and the scrollbar thumb is sized to the real content.
  tallApplyGeometry(view) {
    if (!view || view.closed) return;
    const inner = view.container.querySelector(".term-inner");
    const cellHeight = view.term._core?._renderService?.dimensions?.css?.cell?.height;
    if (!inner || !cellHeight) return;
    const fullPx = Math.round((view.term.rows || TALL_ROWS_DOM) * cellHeight);
    if (view.term.element && view.term.element.style.height !== `${fullPx}px`) {
      view.term.element.style.height = `${fullPx}px`;
    }
    const contentPx = Math.round((this.tallEffectiveBottomRow(view) + 1) * cellHeight);
    // Never shorter than the viewport, never taller than the terminal itself.
    const desired = Math.max(view.container.clientHeight || 0, Math.min(fullPx, contentPx));
    const current = view.tallInnerHeight || 0;
    let height = desired;
    if (desired < current) {
      // Shrinking is the only direction that can move the view: the browser has to pull scrollTop back
      // inside the smaller box, and that pull is exactly the jump. Measured while a composer redrew
      // itself: the content height flickered by one row 19 times in a few seconds, and the view jumped
      // up to 63px with it. Two rules make that impossible -- ignore a dip until it has held for a
      // moment, and never shrink past what the current scroll position needs to stay valid. Following
      // moves the view down to the real bottom first, which then lets the box shrink on a later pass,
      // so this converges without ever yanking anything.
      if (view.tallShrinkTarget !== desired) {
        view.tallShrinkTarget = desired;
        view.tallShrinkSince = Date.now();
      }
      const settled = Date.now() - (view.tallShrinkSince || 0) >= TALL_SHRINK_SETTLE_MS;
      const keepScrollValid = Math.ceil(view.container.scrollTop + (view.container.clientHeight || 0));
      height = settled ? Math.max(desired, Math.min(current, keepScrollValid)) : current;
    } else {
      view.tallShrinkTarget = null;
    }
    if (view.tallInnerHeight !== height) {
      view.tallInnerHeight = height;
      inner.style.height = `${height}px`;
    }
  }

  // Whether attaching to a terminal forces it to repaint itself. Every one of these mechanisms exists
  // because a normal-height terminal cannot hold the agent's screen: reattaching replays scrollback that
  // cannot reconstruct a synchronized-update frame, so the screen had to be forced to redraw. A terminal
  // taller than the whole conversation keeps that screen in its buffer, so the redraw may now be
  // redundant -- and it is not free: the repaint is what flickers on the first visit to a tab and can
  // leave the view somewhere above the prompt once it settles.
  //
  // Kept as a switch rather than a deletion because the answer differs per agent and per state, and the
  // failure it originally fixed (a blank pane) is worse than the flicker it causes.
  attachRepaintEnabled() {
    return this.settings.attach_repaint !== false;
  }

  tallRowPlan(cellHeight) {
    if (!TALL_WEBGL_ENABLED) return { rows: TALL_ROWS_DOM, webgl: false };
    const safeRows = this.maxWebglSafeRows(cellHeight);
    if (safeRows < TALL_ROWS_MIN_FOR_WEBGL) return { rows: TALL_ROWS_DOM, webgl: false };
    return { rows: Math.min(TALL_ROWS_MAX, safeRows), webgl: true };
  }

  enableWebglRenderer(term) {
    const Addon = window.WebglAddon?.WebglAddon;
    if (!Addon) return false;
    try {
      const addon = new Addon();
      addon.onContextLoss(() => {
        try { addon.dispose(); } catch (disposeError) { /* already gone; DOM renderer takes over */ }
      });
      term.loadAddon(addon);
      return true;
    } catch (webglError) {
      return false;
    }
  }


  buildTerminalIconSettingsRow() {
    const rows = document.createDocumentFragment();
    const heading = document.createElement("div");
    heading.className = "settings-row terminal-icon-settings-row";
    const label = document.createElement("span");
    label.className = "settings-label";
    label.textContent = "Show terminal icons";
    heading.appendChild(label);
    rows.appendChild(heading);
    const row = document.createElement("div");
    row.className = "settings-row terminal-icon-agent-row";
    const controls = document.createElement("span");
    controls.className = "settings-controls terminal-icon-settings-controls";
    const buttons = new Map();
    const updateButtons = () => {
      for (const [kind, button] of buttons) {
        const enabled = this.terminalIconEnabledForAgent(kind);
        const labelText = TERMINAL_ICON_AGENT_LABELS[kind];
        button.textContent = labelText;
        button.classList.toggle("on", enabled);
        button.setAttribute("aria-pressed", String(enabled));
        button.title = `${labelText} terminal icons: ${enabled ? "on" : "off"}`;
        button.setAttribute("aria-label", button.title);
      }
    };
    for (const kind of TERMINAL_ICON_AGENT_KINDS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "theme-toggle terminal-icon-agent-toggle";
      button.title = `${TERMINAL_ICON_AGENT_LABELS[kind]} terminal icon`;
      button.setAttribute("aria-label", button.title);
      button.onclick = () => {
        this.setTerminalIconEnabledForAgent(kind, !this.terminalIconEnabledForAgent(kind));
        updateButtons();
        this.applySettings();
        this.saveSettings();
        this.renderList();
      };
      buttons.set(kind, button);
      controls.appendChild(button);
    }
    updateButtons();
    row.appendChild(controls);
    rows.appendChild(row);
    return rows;
  }

  normalizeUiScale(value) {
    return Math.max(0.8, Math.min(1.4, Math.round((Number(value) || 1) * 20) / 20));
  }

  bumpSetting(key, delta) {
    this.settings[key] = Math.max(FONT_MIN, Math.min(FONT_MAX, this.settings[key] + delta));
    this.applySettings();
    this.saveSettings();
  }

  initResizer(handleId, key, fromRight, minWidth, maxWidth) {
    this.$(handleId).onmousedown = (e) => {
      e.preventDefault();
      document.body.classList.add("dragging");
      if (handleId === "sidebar-resizer") {
        this.sidebarResizeInProgress = true;
        if (this.sidebarResizeFinalFitFrame) {
          cancelAnimationFrame(this.sidebarResizeFinalFitFrame);
          this.sidebarResizeFinalFitFrame = 0;
        }
      }
      const move = (ev) => {
        const width = fromRight ? window.innerWidth - ev.clientX : ev.clientX;
        const resizingFiles = handleId === "sidebar-resizer" && this.settings.files_pinned &&
          FILES_SIDE_PANEL_TABS.includes(this.sideView);
        const targetKey = resizingFiles ? "files_width" : key;
        const targetMin = resizingFiles ? Math.max(minWidth, FILEDECK_DEFAULT_SIDEBAR_WIDTH) : minWidth;
        const targetMax = resizingFiles ? Math.max(maxWidth, Math.floor(window.innerWidth * 0.75)) : maxWidth;
        this.settings[targetKey] = Math.max(targetMin, Math.min(targetMax, Math.round(width)));
        this.applySettings({ fitTerminals: false });
      };
      const up = () => {
        document.body.classList.remove("dragging");
        if (handleId === "sidebar-resizer") this.sidebarResizeInProgress = false;
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        this.applySettings({ fitTerminals: false });
        if (handleId === "sidebar-resizer") this.scheduleFinalTerminalFitAfterSidebarResize();
        this.saveSettings();
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    };
  }

  startFilesPanelResize(event) {
    if (event.button !== 0 || this.vscodeMode) return;
    const section = this.$("files-section");
    if (!section || section.classList.contains("hidden") || !section.classList.contains("floating")) return;
    event.preventDefault();
    this.filesPanelResizePointerId = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add("dragging-file-search-panel-resize");
  }

  resizeFilesPanelFromPointer(event) {
    if (event.pointerId !== this.filesPanelResizePointerId) return;
    const section = this.$("files-section");
    const sidebar = this.$("sidebar");
    if (!section || !sidebar || !section.classList.contains("floating")) return;
    const sidebarRect = sidebar.getBoundingClientRect();
    const leftOffset = sidebarRect?.left || 0;
    const normalWidth = Number(this.settings.sidebar_width) || SETTINGS_DEFAULTS.sidebar_width;
    const minWidth = Math.max(normalWidth * 2, 280);
    const maxWidth = Math.max(minWidth, Math.floor(window.innerWidth - leftOffset - 12));
    const nextWidth = Math.max(minWidth, Math.min(maxWidth, Math.round(event.clientX - leftOffset)));
    section.style.width = `${nextWidth}px`;
    this.settings.files_width = nextWidth;
    document.documentElement.style.setProperty("--files-panel-width", `${nextWidth}px`);
    this.scheduleTerminalFitAfterSidebarChange();
  }

  finishFilesPanelResize(event) {
    if (event.pointerId !== this.filesPanelResizePointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    this.filesPanelResizePointerId = null;
    document.body.classList.remove("dragging-file-search-panel-resize");
    this.applySettings({ fitTerminals: false });
    this.saveSettings();
  }

  async reloadTree(rootOverride) {
    const s = this.session(this.activeId);
    this.treeRoot = rootOverride || (s ? s.cwd : (this.worktreeRoot() || "~"));
    this.connectFileTreeWatch(this.treeRoot);
    const label = this.$("files-root-label");
    label.textContent = this.vscodeMode ? "files" : this.treeRoot.replace(/^\/Users\/[^/]+/, "~");
    label.title = this.treeRoot;
    this.treeDirs.clear();
    this.expandedDirs = new Set(this.treeSearchFilter?.expandedDirs || []);
    this.recentFiles = [];
    this.recentFilesRoot = null;
    this.recentFilesFingerprint = "";
    this.recentFilesFetchedAt = 0;
    this.recentFilesExpanded = false;
    const tree = this.$("files-tree");
    tree.textContent = "";
    await this.renderDirInto(tree, "");
    this.updateRecentFilesWatch();
    this.refreshRecentFiles(true);
  }

  async fetchDirEntries(relPath) {
    const res = await fetch(`/api/files/list?root=${encodeURIComponent(this.treeRoot)}&path=${encodeURIComponent(relPath)}`);
    return res.ok ? await res.json() : null;
  }

  sortTreeEntries(entries) {
    const sorted = [...entries];
    const recent = this.settings.file_tree_sort === "mtime";
    sorted.sort((left, right) => {
      if (recent) {
        const mtimeOrder = Number(right.mtime || 0) - Number(left.mtime || 0);
        if (mtimeOrder) return mtimeOrder;
      } else {
        const directoryOrder = Number(right.is_dir) - Number(left.is_dir);
        if (directoryOrder) return directoryOrder;
      }
      return String(left.name || "").localeCompare(String(right.name || ""), undefined,
        { numeric: true, sensitivity: "base" });
    });
    return sorted;
  }

  treeEntryCache(entries) {
    return JSON.stringify(this.sortTreeEntries(entries));
  }

  treeRowMetadataKey(entry) {
    return `${entry.mtime || 0}|${String(entry.git_status || "").toUpperCase()}`;
  }

  filePatternRegex(pattern) {
    const value = String(pattern || "").trim();
    if (!value) return null;
    const source = value.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    try {
      return new RegExp(`^${source}$`, "i");
    } catch (_error) {
      return null;
    }
  }

  filePathMatchesPattern(relativePath, pattern) {
    const normalizedPath = String(relativePath || "").replaceAll("\\", "/");
    const basename = normalizedPath.split("/").pop() || normalizedPath;
    let value = String(pattern || "").trim();
    if (!value) return false;
    if (value === ".*" || value === "**/.*") return normalizedPath.split("/").some((part) => part.startsWith("."));
    if (value.startsWith(".")) value = `*${value}`;
    const matcher = this.filePatternRegex(value);
    return !!matcher && (matcher.test(normalizedPath) || matcher.test(basename));
  }

  filePathMatchesExcludedPattern(relativePath) {
    return this.fileTypeFilterTokens().some((token) => this.filePathMatchesPattern(relativePath, token.replace(/^!/, "")));
  }

  filePathMatchesIncludedPattern(relativePath, mode) {
    const patterns = this.splitFileGlobTokens(this.fileIncludeGlob(mode));
    return !patterns.length || patterns.some((pattern) => this.filePathMatchesPattern(relativePath, pattern));
  }

  async renderDirInto(container, relPath, entries) {
    if (entries === undefined) entries = await this.fetchDirEntries(relPath);
    if (entries === null) return;
    entries = this.sortTreeEntries(entries);
    this.treeDirs.set(relPath, { container, cache: JSON.stringify(entries) });
    container.textContent = "";
    for (const entry of entries) {
      const excluded = entry.is_dir && this.isExcludedName(entry.name);
      const hiddenDotFolder = entry.is_dir && this.settings.hide_dot_folders !== false && this.isDotFolderName(entry.name);
      if (hiddenDotFolder || (excluded && this.settings.hide_excluded)) continue;
      const childRel = relPath ? `${relPath}/${entry.name}` : entry.name;
      if (!entry.is_dir && (this.filePathMatchesExcludedPattern(childRel) || !this.filePathMatchesIncludedPattern(childRel, "tree"))) continue;
      if (!this.treeFilterAllows(childRel, entry.is_dir)) continue;
      const row = TermDeckFileBrowser.createTreeEntryRow({ root: this.treeRoot, relativePath: relPath, entry, excluded,
        showMtime: this.settings.show_mtime, showGitStatus: this.settings.show_git_status !== false,
        fileIcon: (name) => this.fileTypeIconEl(name, "tree-type-icon"),
        onDirectory: (directoryRow, path) => void this.toggleDir(directoryRow, path),
        onFile: (event, fileRow, path) => void this.openFile(this.treeRoot, path, null, fileRow, { preview: true, fromFilePanel: true }),
        onDoubleClick: (fileRow, path) => void this.openFile(this.treeRoot, path, null, fileRow, { pinned: true, fromFilePanel: true }),
        onAuxClick: (event, fileRow, path) => this.handleFileDeckAuxClick(event, this.treeRoot, path),
        onContextMenu: (event, fileRow) => this.openTreeContextMenu(event, fileRow),
      });
      if (!entry.is_dir) row.title = `${row.title || childRel}\nMiddle-click opens in a new TermDeck tab`;
      row.dataset.metadata = this.treeRowMetadataKey(entry);
      container.appendChild(row);
      if (entry.is_dir && this.expandedDirs.has(childRel)) await this.expandDirRow(row, childRel);
    }
  }

  appendMtime(row, entry) {
    if (!this.settings.show_mtime || !entry.mtime) return;
    const mtimeEl = document.createElement("span");
    mtimeEl.className = "tree-mtime";
    mtimeEl.textContent = this.formatMtime(entry.mtime);
    mtimeEl.title = `modified ${this.exactMtime(entry.mtime)}`;
    row.appendChild(mtimeEl);
  }

  appendGitStatus(row, entry) {
    if (this.settings.show_git_status === false || !entry.git_status) return;
    const gitStatus = String(entry.git_status).trim().toUpperCase();
    const statusClass = gitStatus === "?" ? "untracked" : gitStatus.toLowerCase();
    const labels = { "?": "untracked", "M": "modified", "A": "added", "D": "deleted",
      "R": "renamed", "C": "copied", "U": "conflicted" };
    row.classList.add("git-row", `git-row-${statusClass}`);
    row.title = `${row.title ? `${row.title}\n` : ""}git: ${labels[gitStatus] || gitStatus}`;
  }

  formatMtime(epochSeconds) {
    return TermDeckFileBrowser.formatMtime(epochSeconds);
  }

  exactMtime(epochSeconds) {
    const date = new Date(epochSeconds * 1000);
    return `${date.toLocaleString()} (${date.toISOString()})`;
  }

  async expandDirRow(row, relPath) {
    row.classList.add("open");
      row.querySelector(".tree-folder-icon").src = FOLDER_ICON_OPEN;
    const wrap = document.createElement("div");
    wrap.className = "tree-children-wrap";
    row.after(wrap);
    await this.renderDirInto(wrap, relPath);
  }

  dropTreeDirsUnder(relPath) {
    for (const key of [...this.treeDirs.keys()]) {
      if (key === relPath || key.startsWith(relPath + "/")) this.treeDirs.delete(key);
    }
  }

  async toggleDir(row, relPath) {
    const next = row.nextSibling;
    if (next && next.classList && next.classList.contains("tree-children-wrap")) {
      next.remove();
      row.classList.remove("open");
      row.querySelector(".tree-folder-icon").src = FOLDER_ICON_CLOSED;
      this.expandedDirs.delete(relPath);
      this.dropTreeDirsUnder(relPath);
      return;
    }
    this.expandedDirs.add(relPath);
    await this.expandDirRow(row, relPath);
  }

  connectFileTreeWatch(root) {
    if (this.vscodeMode || !root) return;
    if (this.treeWs && this.treeWsRoot === root &&
        (this.treeWs.readyState === WebSocket.CONNECTING || this.treeWs.readyState === WebSocket.OPEN)) return;
    this.disconnectFileTreeWatch();
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}${FILE_TREE_WS_ROUTE}?root=${encodeURIComponent(root)}`);
    this.treeWs = socket;
    this.treeWsRoot = root;
    socket.onmessage = (event) => {
      if (this.treeWs !== socket) return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch (error) {
        if (error instanceof SyntaxError) return;
        throw error;
      }
      if (message.type === FILE_TREE_CHANGED) this.queueFileTreeRefresh(message.changes);
    };
    socket.onclose = () => {
      if (this.treeWs !== socket) return;
      this.treeWs = null;
      this.treeWsRoot = "";
      if (this.sideView !== "project" && this.sideView !== "search") return;
      clearTimeout(this.treeWsReconnectTimer);
      this.treeWsReconnectTimer = setTimeout(() => {
        this.treeWsReconnectTimer = 0;
        if (this.sideView === "project" || this.sideView === "search") this.connectFileTreeWatch(this.treeRoot);
      }, 5000);
    };
  }

  disconnectFileTreeWatch() {
    clearTimeout(this.treeWsReconnectTimer);
    this.treeWsReconnectTimer = 0;
    clearTimeout(this.treeEventRefreshTimer);
    this.treeEventRefreshTimer = 0;
    this.treeChangedDirectories.clear();
    this.treeChangedEntries.clear();
    const socket = this.treeWs;
    this.treeWs = null;
    this.treeWsRoot = "";
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
  }

  queueFileTreeRefresh(changes) {
    if (!Array.isArray(changes)) return;
    for (const change of changes) {
      if (!change || typeof change.path !== "string") continue;
      const operation = String(change.operation || "");
      const parent = typeof change.parent === "string" ? change.parent : "";
      if (this.isExcludedPath(parent) || (operation === "modified" && this.isExcludedPath(change.path))) continue;
      if (operation === "modified" && change.is_directory) continue;
      if (operation === "modified" && !change.is_directory) {
        this.treeChangedEntries.set(change.path, change);
        if (!this.treeRowForPath(change.path) && this.treeDirs.has(parent)) this.treeChangedDirectories.add(parent);
      } else {
        this.treeChangedDirectories.add(parent);
        if (change.is_directory && operation === "deleted") {
          this.expandedDirs.delete(change.path);
          this.dropTreeDirsUnder(change.path);
        }
      }
    }
    if (!this.treeChangedDirectories.size && !this.treeChangedEntries.size) return;
    clearTimeout(this.treeEventRefreshTimer);
    this.treeEventRefreshTimer = setTimeout(() => {
      this.treeEventRefreshTimer = 0;
      void this.refreshChangedFileTreeEvents();
    }, 120);
  }

  async refreshChangedFileTreeEvents() {
    if (this.treePollBusy) {
      clearTimeout(this.treeEventRefreshTimer);
      this.treeEventRefreshTimer = setTimeout(() => {
        this.treeEventRefreshTimer = 0;
        void this.refreshChangedFileTreeEvents();
      }, 120);
      return;
    }
    const directories = [...this.treeChangedDirectories];
    const entries = [...this.treeChangedEntries.values()];
    this.treeChangedDirectories.clear();
    this.treeChangedEntries.clear();
    const openDirectories = directories.filter((directory) => this.treeDirs.has(directory));
    if (openDirectories.length) await this.refreshTreeDirectories(openDirectories);
    const openEntryChanges = entries.filter((change) => !openDirectories.includes(change.parent) && this.treeRowForPath(change.path));
    if (openEntryChanges.length) await this.refreshChangedFileTreeEntries(openEntryChanges);
    await this.refreshOpenFilesFromDisk(entries);
    this.queueRecentFilesEventRefresh();
    if (this.shouldRefreshActiveFileSearch(entries)) await this.refreshActiveFileSearch();
  }

  async refreshOpenFilesFromDisk(changes) {
    if (!Array.isArray(changes) || !changes.length) return;
    const changedKeys = new Set(changes
      .filter((change) => change && ["modified", "created"].includes(change.operation) && !change.is_directory && typeof change.path === "string")
      .map((change) => `${this.treeRoot}|${change.path}`));
    if (!changedKeys.size) return;
    for (const [key, entry] of this.openFiles) {
      if (!changedKeys.has(key)) continue;
      if (!entry.model || entry.dirty) {
        await this.observeExternalFileHistory(entry);
        continue;
      }
      await this.refreshFileModelFromDisk(entry);
    }
  }

  async observeExternalFileHistory(entry) {
    const res = await fetch(`/api/files/read?root=${encodeURIComponent(entry.root)}&path=${encodeURIComponent(entry.path)}`);
    if (!res.ok) return;
    await res.json();
    if (this.fileHistoryOpen && this.activeFileKey !== null && this.openFiles.get(this.activeFileKey) === entry) {
      void this.loadFileHistory();
    }
  }

  shouldRefreshActiveFileSearch(changes) {
    if (!Array.isArray(changes) || !changes.length) return false;
    const structuralChange = changes.some((change) => String(change.operation || "") !== "modified");
    if (this.sideView === "search" && this.$("search-query").value.trim()) {
      if (structuralChange) return true;
      const displayedPaths = this.contentSearchTree?.paths;
      return changes.some((change) => displayedPaths?.has(change.path));
    }
    return this.sideView === "project" && this.$("search-name").value.trim() && structuralChange;
  }

  async refreshActiveFileSearch() {
    if (this.sideView === "search" && this.$("search-query").value.trim()) {
      await this.runSearch(null, true);
      return;
    }
    if (this.sideView === "project" && this.$("search-name").value.trim()) await this.runNameSearch();
  }

  treeRowForPath(relPath) {
    return [...this.$("files-tree").querySelectorAll(".tree-row")].find((row) => row.dataset.rel === relPath) || null;
  }

  async refreshChangedFileTreeEntries(changes) {
    if (this.settings.show_mtime === false && this.settings.show_git_status === false) return;
    const entriesByParent = new Map();
    for (const change of changes) {
      if (!entriesByParent.has(change.parent)) entriesByParent.set(change.parent, await this.fetchDirEntries(change.parent));
    }
    for (const change of changes) {
      const entries = entriesByParent.get(change.parent);
      if (!entries) continue;
      const name = change.path.slice(change.parent ? change.parent.length + 1 : 0);
      const entry = entries.find((candidate) => candidate.name === name);
      const row = this.treeRowForPath(change.path);
      if (!row) continue;
      if (!entry) {
        this.treeChangedDirectories.add(change.parent);
        continue;
      }
      this.updateTreeRowMetadata(row, entry);
    }
    const missingParents = [...this.treeChangedDirectories].filter((directory) => this.treeDirs.has(directory));
    this.treeChangedDirectories.clear();
    if (missingParents.length) await this.refreshTreeDirectories(missingParents);
  }

  updateTreeRowMetadata(row, entry) {
    const metadataKey = this.treeRowMetadataKey(entry);
    if (row.dataset.metadata === metadataKey) return;
    row.dataset.metadata = metadataKey;
    row.querySelector(".tree-mtime")?.remove();
    for (const className of [...row.classList]) {
      if (className === "git-row" || className.startsWith("git-row-")) row.classList.remove(className);
    }
    row.title = `${this.treeRoot}/${row.dataset.rel}`;
    this.appendMtime(row, entry);
    this.appendGitStatus(row, entry);
  }

  async refreshTreeDirectories(directoryPaths = null) {
    if (this.treePollBusy || this.treeRoot === null || this.$("files-section").classList.contains("hidden")) return;
    this.treePollBusy = true;
    const scrollPosition = this.captureTreeScrollPosition();
    const selectedPath = this.selectedTreeRow?.dataset?.rel || "";
    let changed = false;
    const paths = directoryPaths === null ? [...this.treeDirs.keys()] : [...new Set(directoryPaths)];
    try {
      for (const relPath of paths) {
        const info = this.treeDirs.get(relPath);
        if (!info || this.treeDirs.get(relPath) !== info) continue;
        const entries = await this.fetchDirEntries(relPath);
        if (entries === null || this.treeEntryCache(entries) === info.cache) continue;
        changed = true;
        await this.renderDirInto(info.container, relPath, entries);
      }
    } finally {
      this.treePollBusy = false;
      if (changed) {
        const selectedRow = selectedPath ? this.treeRowForPath(selectedPath) : null;
        this.markTreeSelection(selectedRow);
        this.restoreTreeScrollPosition(scrollPosition);
        requestAnimationFrame(() => this.restoreTreeScrollPosition(scrollPosition));
      }
    }
  }

  async treeKeyNav(key) {
    const rows = [...this.$("files-tree").querySelectorAll(".tree-row")];
    if (!rows.length) return;
    const idx = rows.indexOf(this.selectedTreeRow);
    const current = idx >= 0 ? rows[idx] : null;
    const selectRow = (row) => {
      if (!row) return;
      this.markTreeSelection(row);
      row.scrollIntoView({ block: "nearest" });
    };
    if (key === "ArrowDown") { selectRow(rows[Math.min(idx + 1, rows.length - 1)] || rows[0]); return; }
    if (key === "ArrowUp") { selectRow(rows[Math.max(idx - 1, 0)]); return; }
    if (!current) { selectRow(rows[0]); return; }
    const rel = current.dataset.rel;
    const isDir = current.dataset.kind === "dir";
    if (key === "Enter") {
      if (isDir) await this.toggleDir(current, rel);
      else this.openFile(this.treeRoot, rel, null, current, { preview: true, fromFilePanel: true });
      return;
    }
    if (key === "ArrowRight") {
      if (isDir && !current.classList.contains("open")) await this.toggleDir(current, rel);
      else selectRow(rows[Math.min(idx + 1, rows.length - 1)]);
      return;
    }
    if (key === "ArrowLeft") {
      if (isDir && current.classList.contains("open")) {
        await this.toggleDir(current, rel);
        return;
      }
      const parentRel = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : null;
      if (parentRel) selectRow(this.$("files-tree").querySelector(`[data-rel="${CSS.escape(parentRel)}"]`));
    }
  }

  markTreeSelection(row) {
    if (this.selectedTreeRow) this.selectedTreeRow.classList.remove("selected");
    this.selectedTreeRow = row || null;
    if (row) row.classList.add("selected");
  }

  persistOpenFiles() {
    const groups = {};
    for (const entry of this.openFiles.values()) {
      const key = this.owningProjectKey(entry.root);
      (groups[key] = groups[key] || []).push({ root: entry.root, path: entry.path });
    }
    const states = this.settings.project_state || {};
    if (this.projectSlug) {
      for (const [proj, files] of Object.entries(groups)) states[proj] = { ...(states[proj] || {}), open_files: files };
      const scopedKey = this.projectStateKey();
      if (!groups[scopedKey]) states[scopedKey] = { ...(states[scopedKey] || {}), open_files: [] };
    } else {
      for (const key of new Set([...Object.keys(states), ...Object.keys(groups)])) {
        states[key] = { ...(states[key] || {}), open_files: groups[key] || [] };
      }
    }
    this.settings.project_state = states;
    const projectKeys = this.projectSlug ? [this.projectStateKey()]
      : [...new Set([...Object.keys(states), ...Object.keys(groups)])];
    const updates = projectKeys.map((projectKey) => ({ projectKey, openFiles: [...(states[projectKey]?.open_files || [])] }));
    this.openFilesPersistPromise = this.openFilesPersistPromise.then(async () => {
      for (const update of updates) {
        const params = this.projectStateSearchParams(update.projectKey);
        const response = await fetch(`/api/project-state/open_files?${params}`, { method: "PUT", keepalive: true,
          headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: update.openFiles }) });
        if (!response.ok) throw new Error(`server returned ${response.status}`);
      }
    }).catch((error) => { this.$("stat-text").textContent = `Could not persist open files: ${error.message}`; });
  }

  async openFile(root, path, line, treeRow, options = {}) {
    const key = `${root}|${path}`;
    if (!this.openFiles.has(key)) {
      this.openFiles.set(key, { root, path, name: path.split("/").pop(), model: null, fullPath: null,
        truncated: false, preview: !!options.preview && !options.pinned });
    } else {
      const entry = this.openFiles.get(key);
      if (options.pinned) entry.preview = false;
      this.openFiles.delete(key);
      this.openFiles.set(key, entry);
    }
    this.enforceOpenFilesLimit();
    this.persistOpenFiles();
    this.markTreeSelection(treeRow || null);
    const entry = this.openFiles.get(key);
    const returnTo = typeof options.returnTo === "string" ? options.returnTo.trim() : "";
    await this.activateFile(key, line, { returnTo, history: options.history });
    const openedFromFilePanel = !!treeRow || !!options.fromFilePanel;
    if (openedFromFilePanel && !this.settings.files_pinned && entry.model && this.sideView !== "terminals") {
      this.setSideView("terminals", false);
    }
  }

  saveActiveFileViewState() {
    if (this.activeFileKey === null || !this.editor) return;
    const entry = this.openFiles.get(this.activeFileKey);
    if (!entry?.model || this.editor.getModel() !== entry.model) return;
    entry.viewState = this.editor.saveViewState();
  }

  positionPopover(pop, anchor) {
    const rect = anchor.getBoundingClientRect();
    pop.classList.remove("hidden");
    const below = rect.bottom + 6;
    const top = below + pop.offsetHeight > window.innerHeight - 8 ? rect.top - pop.offsetHeight - 6 : below;
    pop.style.top = Math.max(8, top) + "px";
    pop.style.left = Math.min(rect.left, window.innerWidth - pop.offsetWidth - 12) + "px";
  }

  buildRemoteAccessRow() {
    const row = document.createElement("div");
    row.className = "settings-row remote-access-settings-row";
    const heading = document.createElement("span");
    heading.className = "remote-access-heading";
    const label = document.createElement("span");
    label.className = "settings-label";
    label.textContent = "Remote access";
    const status = document.createElement("span");
    status.className = "remote-access-status";
    status.textContent = "checking…";
    heading.append(label, status);
    const controls = document.createElement("span");
    controls.className = "settings-controls";
    const open = document.createElement("button");
    open.type = "button";
    open.className = "remote-access-open hidden";
    open.textContent = "↗";
    open.title = "Open TermDeck Remote";
    const action = document.createElement("button");
    action.type = "button";
    action.className = "remote-access-action";
    action.textContent = "Sign in";
    controls.append(open, action);
    row.append(heading, controls);
    row.remoteAccessElements = { status, open, action };
    action.onclick = () => this.handleRemoteAccessAction(row);
    open.onclick = () => {
      const relayUrl = row.dataset.relayUrl;
      if (relayUrl) window.open(relayUrl, "_blank", "noopener");
    };
    void this.refreshRemoteAccessRow(row);
    return row;
  }

  async refreshRemoteAccessRow(row) {
    if (!row) return;
    const { status, open, action } = row.remoteAccessElements;
    try {
      const response = await fetch("/api/remote/status");
      if (!response.ok) throw new Error(`remote status failed (${response.status})`);
      const remote = await response.json();
      if (!row.isConnected) return;
      row.dataset.remoteState = remote.state;
      row.dataset.relayUrl = remote.public_url || remote.relay_url || "";
      row.dataset.loginUrl = remote.login_url || "";
      const labels = {
        disconnected: "off",
        pairing: "finish Google sign-in",
        ready: remote.email ? `${remote.email} · ready` : "ready",
        connected: remote.email ? `${remote.email} · connected` : "connected",
        error: remote.error || "connection failed",
      };
      status.textContent = labels[remote.state] || remote.state;
      status.title = remote.error || remote.relay_url || "";
      open.classList.toggle("hidden", !!this.remoteBrowserEmail || remote.state !== "connected");
      action.textContent = this.remoteBrowserEmail ? "Log out" :
        ["connected", "ready"].includes(remote.state) ? "Disconnect" :
          remote.state === "pairing" ? "Open login" : "Sign in";
      if (remote.state === "pairing") {
        clearTimeout(row.remoteStatusTimer);
        row.remoteStatusTimer = setTimeout(() => this.refreshRemoteAccessRow(row), 1800);
      }
    } catch (error) {
      status.textContent = "unavailable";
      status.title = error instanceof Error ? error.message : String(error);
      action.textContent = "Retry";
    }
  }

  async handleRemoteAccessAction(row) {
    if (this.remoteBrowserEmail) {
      await this.logoutRemoteBrowser(row.remoteAccessElements.action);
      return;
    }
    const state = row.dataset.remoteState || "disconnected";
    if (["connected", "ready"].includes(state)) {
      if (!window.confirm("Disconnect this computer from TermDeck Remote?")) return;
      const response = await fetch("/api/remote/disconnect", { method: "POST" });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        window.alert(payload.detail || `remote disconnect failed (${response.status})`);
      }
      await this.refreshRemoteAccessRow(row);
      return;
    }
    if (state === "pairing" && row.dataset.loginUrl) {
      window.open(row.dataset.loginUrl, "_blank", "noopener");
      return;
    }
    const loginWindow = window.open("about:blank", "termdeck-remote-login");
    try {
      const response = await fetch("/api/remote/pair", { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || `remote pairing failed (${response.status})`);
      if (payload.login_url && loginWindow) loginWindow.location.replace(payload.login_url);
      else if (payload.login_url) window.open(payload.login_url, "_blank", "noopener");
      await this.refreshRemoteAccessRow(row);
    } catch (error) {
      if (loginWindow) loginWindow.close();
      window.alert(error instanceof Error ? error.message : String(error));
      await this.refreshRemoteAccessRow(row);
    }
  }

  async activateFile(key, line, options = {}) {
    const entry = this.openFiles.get(key);
    if (!entry) return;
    this.closeTerminalFind();
    this.closePromptHistory();
    if (this.activeFileKey === null && this.historyOpen && this.activeId) {
      this.rememberHistoryScrollPosition(this.activeId);
    }
    if (this.activeFileKey !== key) this.saveActiveFileViewState();
    this.activeFileKey = key;
    if (options.history !== false && !this.vscodeMode) {
      const requestedReturnTo = typeof options.returnTo === "string" ? options.returnTo.trim() : "";
      const activeSessionId = String(this.activeId || requestedReturnTo || "");
      const current = this.parseNavState(this.lastNavJson);
      const fallback = activeSessionId || (current?.kind === "term" ? String(current.id || "") : "");
      const fallbackFromFile = current?.kind === "file" ? String(current.return_to || "") : "";
      const returnTo = (this.session(fallback) ? fallback : fallbackFromFile && this.session(fallbackFromFile) ? fallbackFromFile : "");
      const fromCurrentFile = current?.kind === "file" && String(current.return_to || "") === returnTo;
      if (returnTo && !fromCurrentFile) {
        const returnState = { kind: "term", id: returnTo };
        const historyScroll = this.historyScrollBySession.get(returnTo);
        if (historyScroll) returnState.history_scroll = historyScroll;
        if (current?.kind === "term" && String(current.id || "") === returnTo) this.replaceNav(returnState);
        else this.pushNav(returnState);
      }
      if (returnTo) {
        this.pushNav({ kind: "file", key, return_to: returnTo });
      } else {
        this.pushNav({ kind: "file", key });
      }
    }
    else if (options.history !== false) this.replaceNav({ kind: "file", key });
    if (options.fromOpenFiles && !this.vscodeMode) this.setSideView("terminals", false);
    this.applyMainLayout();
    this.renderList();
    this.renderTopbar();
    await this.monacoReady;
    if (!entry.model || !entry.dirty) {
      const loaded = await this.refreshFileModelFromDisk(entry);
      if (!loaded && !entry.model) return;
    }
    if (this.activeFileKey !== key) return;
    this.editor.setModel(entry.model);
    void this.lspClient?.activate(entry, entry.model);
    if (line) {
      this.editor.revealLineInCenter(line);
      this.editor.setPosition({ lineNumber: line, column: 1 });
    } else if (entry.viewState) this.editor.restoreViewState(entry.viewState);
    this.editor.focus();
    this.renderList();
    this.renderTopbar();
    void this.renderSecondaryEditor(true);
    if (options.fromOpenFiles) {
      requestAnimationFrame(() => this.$("session-list").querySelector(".file-item.active")?.scrollIntoView({ block: "nearest" }));
    }
    if (this.fileHistoryOpen && this.activeFileKey === key) void this.loadFileHistory();
  }

  navigateBackFromActiveFile() {
    if (this.activeFileKey === null) return false;
    const current = this.parseNavState(this.lastNavJson);
    if (current?.kind === "file" && current.return_to && this.session(current.return_to)) {
      history.back();
      return true;
    }
    const activeId = this.activeId;
    this.saveActiveFileViewState();
    this.lspClient?.deactivate();
    this.activeFileKey = null;
    this.applyMainLayout();
    this.renderList();
    this.renderTopbar();
    if (activeId && this.session(activeId)) {
      this.replaceNav({ kind: "term", id: activeId });
      requestAnimationFrame(() => this.focusActiveEditor());
    } else {
      this.replaceNav({ kind: "init" });
    }
    return true;
  }

  async refreshFileModelFromDisk(entry) {
    const res = await fetch(`/api/files/read?root=${encodeURIComponent(entry.root)}&path=${encodeURIComponent(entry.path)}`);
    if (!res.ok) {
      if (!entry.model) {
        const err = await res.json().catch(() => ({}));
        this.$("stat-text").textContent = err.detail || `${entry.path} — cannot open`;
      }
      return false;
    }
    const data = await res.json();
    entry.fullPath = data.path;
    entry.truncated = data.truncated;
    if (!entry.model) {
      const uri = monaco.Uri.file(data.path);
      const existing = monaco.editor.getModel(uri);
      if (existing) existing.dispose();
      entry.model = monaco.editor.createModel(data.content, undefined, uri);
      entry.model.onDidChangeContent(() => {
        if (entry.applyingDiskContent) return;
        const becameDirty = !entry.dirty;
        entry.dirty = true;
        entry.preview = false;
        this.scheduleFileAutosave(entry);
        if (becameDirty) this.renderFileEditorChrome();
        if (this.fileInspectorMode === "outline" && this.activeFileKey !== null && this.openFiles.get(this.activeFileKey) === entry) {
          clearTimeout(this.fileOutlineTimer);
          this.fileOutlineTimer = setTimeout(() => this.renderFileOutline(), 240);
        }
        this.scheduleProblemsRefresh();
        if (this.fileHistoryOpen && this.activeFileKey !== null && this.openFiles.get(this.activeFileKey) === entry) {
          clearTimeout(this.fileHistoryComparisonTimer);
          this.fileHistoryComparisonTimer = setTimeout(() => {
            this.fileHistoryComparisonTimer = 0;
            this.refreshFileHistoryDiffNavigation();
          }, 250);
        }
      });
      return true;
    }
    if (entry.dirty || entry.model.getValue() === data.content) return false;
    entry.applyingDiskContent = true;
    try {
      entry.model.setValue(data.content);
    } finally {
      entry.applyingDiskContent = false;
    }
    if (this.fileHistoryOpen && this.activeFileKey !== null && this.openFiles.get(this.activeFileKey) === entry) {
      void this.loadFileHistory();
    }
    return true;
  }

  scheduleFileAutosave(entry) {
    clearTimeout(entry.autosaveTimer);
    entry.autosaveTimer = setTimeout(() => {
      entry.autosaveTimer = 0;
      void this.saveFileEntry(entry, false);
    }, FILE_AUTOSAVE_DELAY_MS);
  }

  flushPendingFileSavesOnPageExit() {
    clearTimeout(this.exitFileSaveResetTimer);
    for (const entry of this.openFiles.values()) {
      if (!entry.model || (!entry.dirty && !entry.savePromise)) continue;
      const versionId = entry.model.getVersionId();
      if (entry.exitSaveVersionId === versionId) continue;
      entry.exitSaveVersionId = versionId;
      const body = JSON.stringify({ root: entry.root, path: entry.path, content: entry.model.getValue() });
      const queued = typeof navigator.sendBeacon === "function" &&
        navigator.sendBeacon("/api/files/write", new Blob([body], { type: "application/json" }));
      if (!queued) {
        void fetch("/api/files/write", { method: "POST", keepalive: true,
          headers: { "Content-Type": "application/json" }, body }).catch(() => {});
      }
    }
    this.exitFileSaveResetTimer = setTimeout(() => {
      for (const entry of this.openFiles.values()) delete entry.exitSaveVersionId;
    }, 2000);
  }

  async saveFileEntry(entry, showFailureAlert) {
    if (!entry?.model) return false;
    clearTimeout(entry.autosaveTimer);
    entry.autosaveTimer = 0;
    if (entry.savePromise) {
      const previousSaveSucceeded = await entry.savePromise;
      if (!entry.dirty || !previousSaveSucceeded) return previousSaveSucceeded;
    }
    const model = entry.model;
    const versionId = model.getVersionId();
    const content = model.getValue();
    const savePromise = (async () => {
      try {
        const response = await fetch("/api/files/write", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ root: entry.root, path: entry.path, content }),
        });
        if (!response.ok) {
          const error = await response.json().catch(() => ({}));
          const message = error.detail || "autosave failed";
          this.$("stat-text").textContent = message;
          if (showFailureAlert) alert(message);
          return false;
        }
        if (entry.model === model && model.getVersionId() === versionId) {
          entry.dirty = false;
          this.renderFileEditorChrome();
        } else if (entry.model && !entry.autosaveTimer) {
          this.scheduleFileAutosave(entry);
        }
        if (this.fileHistoryOpen && this.activeFileKey !== null && this.openFiles.get(this.activeFileKey) === entry) {
          void this.loadFileHistory();
        }
        if (this.enforceOpenFilesLimit()) this.persistOpenFiles();
        this.lspClient?.didSave(entry, model, content);
        return true;
      } catch (error) {
        const message = error.message || "autosave failed";
        this.$("stat-text").textContent = message;
        if (showFailureAlert) alert(message);
        return false;
      }
    })();
    entry.savePromise = savePromise;
    try {
      return await savePromise;
    } finally {
      if (entry.savePromise === savePromise) entry.savePromise = null;
    }
  }

  async saveActiveFile() {
    const entry = this.activeFileKey !== null ? this.openFiles.get(this.activeFileKey) : null;
    if (entry) await this.saveFileEntry(entry, true);
  }

  async saveOpenFilesForLsp(root) {
    for (const entry of this.openFiles.values()) {
      if (entry.root !== root) continue;
      if (!entry.dirty && !entry.savePromise) continue;
      if (!await this.saveFileEntry(entry, true)) return false;
    }
    return true;
  }

  async refreshFilesChangedByLsp(changedFiles, root) {
    const changedPaths = new Set(changedFiles.map((file) => String(file.path || "")));
    for (const entry of this.openFiles.values()) {
      if (entry.root !== root || !changedPaths.has(entry.path)) continue;
      entry.dirty = false;
      await this.refreshFileModelFromDisk(entry);
    }
    this.renderList();
    this.renderTopbar();
    this.scheduleProblemsRefresh();
    requestAnimationFrame(() => this.editor?.focus());
  }

  async closeFile(key, options = {}) {
    await this.closeFiles([key], options);
  }

  async closeFiles(keys, options = {}) {
    const entries = [...new Set(keys)].map((key) => [key, this.openFiles.get(key)]).filter(([, entry]) => !!entry);
    if (!entries.length) return;
    const closableKeys = [];
    for (const [key, entry] of entries) {
      if (!options.discard && (entry.dirty || entry.savePromise)) {
        const saved = await this.saveFileEntry(entry, true);
        if (!saved || this.openFiles.get(key) !== entry) continue;
      }
      closableKeys.push(key);
    }
    if (!closableKeys.length) return;
    const activeClosed = closableKeys.includes(this.activeFileKey);
    for (const key of closableKeys) {
      const entry = this.openFiles.get(key);
      if (entry) this.closeOpenFileEntry(key, entry);
    }
    this.persistOpenFiles();
    if (activeClosed) {
      const remaining = [...this.openFiles.keys()];
      if (remaining.length) {
        const nextKey = remaining[remaining.length - 1];
        await this.activateFile(nextKey, null, { history: false });
        this.replaceNav({ kind: "file", key: nextKey });
        this.saveSettings();
        return;
      }
      this.lspClient?.deactivate();
      this.activeFileKey = null;
      this.applyMainLayout();
      const view = this.views.get(this.activeId);
      if (view) view.term.focus();
      this.replaceNav(this.activeId ? { kind: "term", id: this.activeId } : { kind: "init" });
    }
    this.renderList();
    this.renderTopbar();
    this.saveSettings();
  }

  closeActiveItem() {
    if (this.activeFileKey !== null) void this.closeFile(this.activeFileKey);
    else this.closeActive();
  }

  terminalPathBoundaryContinues(leftText, rightText) {
    const left = String(leftText || "").replace(/\s+$/, "");
    const right = String(rightText || "").replace(/^\s+/, "");
    if (!left || !right) return false;
    // A hard column wrap can land the path separator on either side of the break: "trainer/" then
    // "prep.py", but just as often "zscripts" then "/probe.py", or a base name then its own ".py".
    // Only the first shape was recognized before, so a directory name ending a wrapped row (with
    // no trailing slash) silently dropped its own prefix when the file link was opened.
    if (/[\\/._-]$/.test(left) && /^[\w@%+=.-]+(?:[\\/._-]|:\d)/.test(right)) return true;
    if (/[\w@%+=-]$/.test(left) && /^[\\/][\w@%+=.-]*\.[A-Za-z]/.test(right)) return true;
    if (/[\w@%+=-]$/.test(left) && /^\.[A-Za-z][A-Za-z0-9]{0,7}(?::\d+){0,2}\b/.test(right)) return true;
    return false;
  }

  providePathLinks(term, sessionId, bufferLineNumber, callback) {
    const buffer = term.buffer.active;
    const targetIndex = bufferLineNumber - 1;
    if (!buffer.getLine(targetIndex)) { callback(undefined); return; }

    let firstIndex = targetIndex;
    while (firstIndex > 0) {
      const current = buffer.getLine(firstIndex);
      const previous = buffer.getLine(firstIndex - 1);
      if (current?.isWrapped || this.terminalPathBoundaryContinues(
        previous?.translateToString(true), current?.translateToString(true))) firstIndex -= 1;
      else break;
    }
    const segments = [];
    let nextIndex = firstIndex;
    let logicalOffset = 0;
    while (nextIndex < buffer.length) {
      const line = buffer.getLine(nextIndex);
      if (!line) break;
      const text = line.translateToString(true);
      segments.push({ index: nextIndex, text, logicalStart: logicalOffset });
      logicalOffset += text.length;
      const nextLine = buffer.getLine(nextIndex + 1);
      if (!nextLine || (!nextLine.isWrapped && !this.terminalPathBoundaryContinues(
        text, nextLine.translateToString(true)))) break;
      nextIndex += 1;
    }
    const logicalText = segments.map((segment) => segment.text).join("");
    const links = [];
    for (const segment of segments) {
      const segmentStart = segment.logicalStart;
      const segmentEnd = segmentStart + segment.text.length;
      if (segment.index === targetIndex && segment.text.length) {
        for (const match of logicalText.matchAll(PATH_LINK_RE)) {
          const raw = match[0];
          const matchStart = match.index;
          const matchEnd = matchStart + raw.length;
          const ext = raw.split(":")[0].split(".").pop().toLowerCase();
          if (!raw.includes("/") && !KNOWN_EXTS.has(ext)) continue;
          if (matchStart >= segmentEnd || matchEnd <= segmentStart) continue;
          const start = Math.max(matchStart, segmentStart) - segmentStart;
          const end = Math.min(matchEnd, segmentEnd) - segmentStart;
          if (end <= start) continue;
          links.push({
            range: { start: { x: start + 1, y: bufferLineNumber }, end: { x: end, y: bufferLineNumber } },
            text: raw,
            activate: () => this.openFileFromLink(sessionId, raw),
          });
        }
      }
    }
    if (!links.length) {
      const collapsedChars = [];
      const logicalCharStarts = [];
      for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
        const segment = segments[segmentIndex];
        const previousText = segmentIndex > 0 ? segments[segmentIndex - 1].text : "";
        const rightText = String(segment.text || "");
        const trimStart = this.terminalPathBoundaryContinues(previousText, rightText) ? (rightText.match(/^\s*/)?.[0]?.length ?? 0) : 0;
        for (let charIndex = trimStart; charIndex < segment.text.length; charIndex += 1) {
          collapsedChars.push(segment.text[charIndex]);
          logicalCharStarts.push(segment.logicalStart + charIndex);
        }
      }
      const collapsedText = collapsedChars.join("");
      for (const segment of segments) {
        const segmentStart = segment.logicalStart;
        const segmentEnd = segmentStart + segment.text.length;
        if (segment.index === targetIndex && segment.text.length) {
          for (const match of collapsedText.matchAll(PATH_LINK_RE)) {
            const raw = match[0];
            const matchStart = match.index;
            const matchEnd = matchStart + raw.length;
            const logicalMatchStart = logicalCharStarts[matchStart];
            if (typeof logicalMatchStart !== "number") continue;
            const logicalMatchEnd = logicalCharStarts[matchEnd] ?? logicalText.length;
            const ext = raw.split(":")[0].split(".").pop().toLowerCase();
            if (!raw.includes("/") && !KNOWN_EXTS.has(ext)) continue;
            if (logicalMatchStart >= segmentEnd || logicalMatchEnd <= segmentStart) continue;
            const start = Math.max(logicalMatchStart, segmentStart) - segmentStart;
            const end = Math.min(logicalMatchEnd, segmentEnd) - segmentStart;
            if (end <= start) continue;
            links.push({
              range: { start: { x: start + 1, y: bufferLineNumber }, end: { x: end, y: bufferLineNumber } },
              text: raw,
              activate: (_event, linkText) => this.openFileFromLink(sessionId, linkText || raw),
            });
          }
        }
      }
    }
    callback(links.length ? links : undefined);
  }

  parseVscodeFileLink(linkText) {
    let value = String(linkText || "").trim().replace(/\s+/g, "");
    if (!value || /^(?:https?|mailto|data|javascript):/i.test(value)) return null;
    let line = null;
    let column = null;
    let match = value.match(/#L(\d+)(?:-L\d+)?$/i);
    if (match) {
      line = Number(match[1]);
      value = value.slice(0, match.index);
    } else {
      match = value.match(/:(\d+)(?::(\d+))?$/);
      if (match) {
        line = Number(match[1]);
        column = match[2] ? Number(match[2]) : null;
        value = value.slice(0, match.index);
      }
    }
    if (/^file:\/\//i.test(value)) {
      try { value = decodeURIComponent(new URL(value).pathname); } catch (_error) { return null; }
    }
    value = value.replace(/[),.;]+$/, "");
    const fileName = value.split("/").pop() || "";
    const extension = fileName.includes(".") ? fileName.split(".").pop().toLowerCase() : "";
    if (!value || (!value.includes("/") && !KNOWN_EXTS.has(extension))) return null;
    return { path: value, line, column };
  }

  postVscodeFileOpen(path, line, column, cwd) {
    if (!this.vscodeMode || window.parent === window) return false;
    window.parent.postMessage({ type: "termdeck-open-file", path, line, column, cwd }, "*");
    return true;
  }

  requestVscodeRefresh(hard = false) {
    if (!this.vscodeMode) return;
    if (window.parent !== window) {
      window.parent.postMessage({ type: "termdeck-refresh", hard: !!hard }, "*");
      return;
    }
    location.reload();
  }

  postVscodeNativeSession(session, visible) {
    if (!this.nativeVscodeMode || window.parent === window || !session) return;
    window.parent.postMessage({
      type: "termdeck-native-session",
      session: { session_id: session.session_id, title: this.titlePresentation(session).text, cwd: session.cwd },
      ...(typeof visible === "boolean" ? { visible } : {}),
    }, "*");
  }

  postVscodeNativeClose(sessionId) {
    if (!this.nativeVscodeMode || window.parent === window || !sessionId) return;
    window.parent.postMessage({ type: "termdeck-native-close", session_id: sessionId }, "*");
  }

  handleHistoryFileLink(event) {
    const anchor = event.target.closest?.("a");
    if (!anchor) return;
    const linkText = anchor.dataset.terminalFile || anchor.getAttribute("href") || "";
    if (!this.parseVscodeFileLink(linkText)) return;
    event.preventDefault();
    event.stopPropagation();
    this.openFileFromLink(this.activeId, linkText);
  }

  openFileFromLink(sessionId, linkText) {
    const parsed = this.parseVscodeFileLink(linkText);
    if (!parsed) return;
    const s = this.session(sessionId);
    const returnTo = String(sessionId || "").trim();
    if (this.vscodeMode) {
      this.postVscodeFileOpen(parsed.path, parsed.line, parsed.column, s ? s.cwd : "~");
      return;
    }
    this.openFile(s ? s.cwd : "~", parsed.path, parsed.line, null, { returnTo });
  }

  sessionSuggestionEntries() {
    const entries = [];
    const seen = new Set();
    const addEntry = (value, label) => {
      const normalized = String(value || "").trim();
      if (!normalized) return;
      const key = normalized.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      entries.push({ value: normalized, label });
    };
    const sessions = [...this.sessions, ...this.closedSessions];
    for (const session of sessions) {
      if (!session) continue;
      addEntry(session.session_id, session.session_id ? "session id" : "");
      if (session.title) addEntry(session.title, `title: ${session.title}`);
      if (session.cli_title) addEntry(session.cli_title, `agent title: ${session.cli_title}`);
    }
    return entries;
  }

  updateModalSessionSuggestions() {
    const datalist = this.$("modal-session-refs");
    if (!datalist) return;
    datalist.textContent = "";
    const entries = this.sessionSuggestionEntries().sort((left, right) => {
      const leftLabel = String(left.value).toLowerCase();
      const rightLabel = String(right.value).toLowerCase();
      return leftLabel < rightLabel ? -1 : leftLabel > rightLabel ? 1 : 0;
    });
    for (const item of entries) {
      const option = document.createElement("option");
      option.value = item.value;
      if (item.label) option.label = item.label;
      datalist.appendChild(option);
    }
  }

  resolveSessionNameAndReference(model, rawValue) {
    const modelValue = String(model || "").trim().toLowerCase();
    const value = String(rawValue || "").trim();
    if (!value || modelValue === "none" || modelValue === "agy") {
      return { title: value, session_ref: "" };
    }
    const needle = value.toLowerCase();
    const matches = [];
    for (const session of [...this.sessions, ...this.closedSessions]) {
      if (!session) continue;
      const sessionId = String(session.session_id || "").trim();
      const title = String(session.title || "").trim();
      const cliTitle = String(session.cli_title || "").trim();
      if (sessionId && sessionId.toLowerCase() === needle) matches.push(sessionId);
      if (title && title.toLowerCase() === needle) matches.push(sessionId);
      if (cliTitle && cliTitle.toLowerCase() === needle) matches.push(sessionId);
    }
    const unique = [...new Set(matches)];
    if (unique.length === 1 && unique[0]) {
      return { title: "", session_ref: unique[0] };
    }
    return { title: value, session_ref: "" };
  }

  clearModalError() {
    const error = this.$("modal-error");
    const install = this.$("modal-error-install");
    if (error) error.classList.add("hidden");
    if (install) {
      install.classList.add("hidden");
      install.disabled = false;
      install.onclick = null;
    }
  }

  showModalDependencyError(detail) {
    const error = this.$("modal-error");
    const message = this.$("modal-error-message");
    const install = this.$("modal-error-install");
    if (!error || !message || !install) return;
    const command = String(detail?.install_command || "").trim();
    message.textContent = `${detail?.message || "The selected agent is unavailable."}${command ? ` Run ${command} in a new terminal to install it.` : ""}`;
    error.classList.remove("hidden");
    if (!command) return;
    install.classList.remove("hidden");
    install.onclick = () => void this.openModelInstallTerminal(detail);
  }

  async openModelInstallTerminal(detail) {
    const install = this.$("modal-error-install");
    const command = String(detail?.install_command || "").trim();
    if (!command || install?.disabled) return;
    if (install) install.disabled = true;
    const cwd = this.$("modal-cwd").value.trim() || this.resolveVscodeDefaultCwd();
    let project = this.projectForCwd(cwd)?.name || "";
    try {
      if (cwd) {
        const projectResponse = await fetch("/api/projects", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ root: cwd }),
        });
        const projectPayload = await projectResponse.json().catch(() => ({}));
        if (!projectResponse.ok) throw new Error(projectPayload.detail || "failed to register project folder");
        project = projectPayload.name || project;
      }
      const response = await fetch("/api/sessions", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command, cwd, title: `Install ${detail.display_name || detail.program}`, project,
          after: this.activeId ? `session:${this.activeId}` : null }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof payload.detail === "string" ? payload.detail : "failed to open install terminal");
      const created = payload;
      this.closeModal();
      if (!this.vscodeMode && created.project && created.project !== (this.projectSlug || "")) {
        location.href = `/p/${encodeURIComponent(created.project)}`;
        return;
      }
      await this.refresh();
      this.activate(created.session_id, { reveal: true });
    } catch (error) {
      this.showModalDependencyError({ ...detail, message: error.message || "failed to open install terminal" });
    } finally {
      if (install) install.disabled = false;
    }
  }

  openModal(groupId = null, afterSessionId = null, initialAgentText = "") {
    this.pendingNewAgentSelection = this.normalizeSelectionText(initialAgentText);
    this.modalGroupId = !this.vscodeMode && groupId && this.terminalGroups().some((group) => group.id === groupId)
      ? groupId : null;
    this.modalAfterSessionId = !this.modalGroupId && afterSessionId && this.session(afterSessionId) ? afterSessionId : null;
    const model = this.settings.last_model || DEFAULT_COMMAND;
    this.$("modal-model").value = MODEL_PERMISSIONS[model] ? model : DEFAULT_COMMAND;
    this.updateModalPermissions();
    this.updateModalSessionSuggestions();
    this.$("modal-project-add-btn").classList.toggle("hidden", !!this.vscodeMode);
    this.$("modal-session-title").value = "";
    this.$("modal-cwd").value = this.resolveVscodeDefaultCwd();
    this.$("modal-cwd").dataset.projectSeeded = "0";
    this.clearModalError();
    this.$("modal-backdrop").classList.remove("hidden");
    this.$("modal-session-title").focus();
  }

  closeModal() {
    this.modalGroupId = null;
    this.modalAfterSessionId = null;
    this.pendingNewAgentSelection = "";
    this.$("modal-backdrop").classList.add("hidden");
  }

  updateModalPermissions() {
    const model = this.$("modal-model").value;
    const permission = this.$("modal-permission");
    permission.textContent = "";
    for (const option of MODEL_PERMISSIONS[model] || MODEL_PERMISSIONS.codex) {
      const el = document.createElement("option");
      el.value = option.value;
      el.textContent = option.label;
      permission.appendChild(el);
    }
    const remembered = (this.settings.last_permissions || {})[model] || "default";
    permission.value = [...permission.options].some((option) => option.value === remembered) ? remembered : "default";
    this.$("modal-permission-field").classList.toggle("hidden", model === "none");
  }

  async createSession() {
    if (this.$("modal-backdrop").classList.contains("hidden")) return;
    const createButton = this.$("modal-create");
    if (createButton.disabled) return;
    createButton.disabled = true;
    try {
      await this.createSessionFromModal();
    } finally {
      createButton.disabled = false;
    }
  }

  async createSessionFromModal() {
    const pendingAgentText = this.pendingNewAgentSelection;
    const targetGroupId = this.modalGroupId;
    const requestedAfterSessionId = this.modalAfterSessionId;
    const model = this.$("modal-model").value;
    const permission = this.$("modal-permission").value;
    const resolved = this.resolveSessionNameAndReference(model, this.$("modal-session-title").value);
    const { title, session_ref: sessionRef } = resolved;
    const project = this.projectSlug || "";
    const cwd = this.worktreeRoot() || this.resolveVscodeDefaultCwd();
    this.settings.last_model = model;
    this.settings.last_permissions = { ...(this.settings.last_permissions || {}), [model]: permission };
    this.saveSettings();
    // Land the new terminal directly below the one in focus rather than at the end of the sidebar.
    // An explicitly chosen group already dictates placement, so it wins.
    const anchorSessionId = !targetGroupId && requestedAfterSessionId && this.session(requestedAfterSessionId)
      ? requestedAfterSessionId : !targetGroupId && this.activeId && this.session(this.activeId) ? this.activeId : null;
    const res = await fetch("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, permission, session_ref: sessionRef, cwd, title,
        project, worktree_id: this.stateWorktreeId() }),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      if (detail.detail?.code === "model_dependency_missing") this.showModalDependencyError(detail.detail);
      else alert(typeof detail.detail === "string" ? detail.detail : "failed to create session");
      return;
    }
    const created = await res.json();
    this.closeModal();
    if (!this.vscodeMode && created.project && created.project !== (this.projectSlug || "")) {
      location.href = `/p/${encodeURIComponent(created.project)}`;
      return;
    }
    if (this.nativeVscodeMode) this.postVscodeNativeSession(created, true);
    await this.refresh();
    if (targetGroupId && this.terminalGroups().some((group) => group.id === targetGroupId)) {
      const state = this.getProjectState();
      this.applyLocalProjectStatePatch({
        session_groups: { ...(state.session_groups || {}), [created.session_id]: targetGroupId },
        terminal_layout: this.terminalLayout().filter((entry) => entry !== `session:${created.session_id}`),
      });
      this.queueSessionGroupAssignments({ [created.session_id]: targetGroupId });
      this.renderList();
    } else if (anchorSessionId && this.session(anchorSessionId) && this.session(created.session_id)) {
      this.repositionSelectedSessions([created.session_id], anchorSessionId, true);
    }
    this.activate(created.session_id, { reveal: true });
    const createdView = this.views.get(created.session_id);
    if (createdView && pendingAgentText) this.queuePendingAgentPaste(createdView, pendingAgentText);
  }

  async openLanguageServerInstallTerminal(details) {
    const project = this.projectForCwd(details.root)?.name || this.projectSlug || "";
    const languageName = this.lspClient?.languageDisplayName(details.language) || details.language;
    const response = await fetch("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "none", permission: "default", cwd: details.root, project,
        title: `Install ${languageName} language server` }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      this.$("status-name").textContent = error.detail || "could not open install terminal";
      return;
    }
    const session = await response.json();
    await this.refresh();
    this.activate(session.session_id, { reveal: true });
    this.prefillTerminalWhenConnected(session.session_id, details.installHint, 0);
  }

  prefillTerminalWhenConnected(sessionId, command, attempt) {
    const view = this.views.get(sessionId);
    if (view?.ws?.readyState === WebSocket.OPEN) {
      this.sendTrackedInput(view, this.terminalPastePayload(view, command));
      view.term.focus();
      this.$("status-name").textContent = "install command ready — press Enter to run";
      return;
    }
    if (attempt >= 80) {
      this.$("status-name").textContent = "install terminal did not become ready";
      return;
    }
    setTimeout(() => this.prefillTerminalWhenConnected(sessionId, command, attempt + 1), 100);
  }

  createShortcutSection(title) {
    const section = document.createElement("section");
    section.className = "keys-section";
    const heading = document.createElement("div");
    heading.className = "keys-section-title";
    heading.textContent = title;
    section.appendChild(heading);
    return section;
  }

  appendShortcutRow(section, shortcut, builtin = false) {
    const row = document.createElement("div");
    row.className = builtin ? "keys-row builtin" : "keys-row";
    const label = document.createElement("span");
    label.className = "keys-label";
    label.textContent = shortcut.label;
    const bind = document.createElement("button");
    bind.className = builtin ? "keys-bind builtin" : "keys-bind";
    bind.textContent = builtin ? shortcut.keys : this.bindingToDisplay(this.bindingFor(shortcut.id));
    if (builtin) {
      bind.disabled = true;
      bind.setAttribute("aria-disabled", "true");
    } else {
      bind.onclick = () => this.captureBinding(shortcut.id, bind);
    }
    row.append(label, bind);
    section.appendChild(row);
  }

  shortcutMatchesSearch(shortcut, builtin, query) {
    if (!query) return true;
    const binding = builtin ? shortcut.keys : this.bindingFor(shortcut.id);
    const aliasBindings = [String(binding).replaceAll("Meta", "Cmd").replaceAll("Alt", "Option").replaceAll("Ctrl", "Control"),
      String(binding).replaceAll("Meta", "Command")];
    const keyQuery = /(?:meta|cmd|command|ctrl|control|alt|option|shift|[⌘⌥⇧⌃+])/i.test(query);
    if (keyQuery) {
      const compactQuery = query.replace(/[\s+_-]/g, "");
      return [binding, builtin ? shortcut.keys : this.bindingToDisplay(binding), ...aliasBindings]
        .some((value) => String(value).toLowerCase().replace(/[\s+_-]/g, "").includes(compactQuery));
    }
    const searchable = [shortcut.label, shortcut.id || "", shortcut.section, binding,
      builtin ? shortcut.keys : this.bindingToDisplay(binding), ...aliasBindings].join(" ").toLowerCase();
    return query.split(/\s+/).filter(Boolean).every((term) => searchable.includes(term));
  }

  renderKeybindingsList() {
    const list = this.$("keys-list");
    list.textContent = "";
    const query = String(this.$("keys-search")?.value || "").trim().toLowerCase();
    const references = this.vscodeMode ? VSCODE_REFERENCE_KEYS : REFERENCE_KEYS;
    let visibleRows = 0;
    for (const sectionName of KEYBOARD_SHORTCUT_SECTIONS) {
      const section = this.createShortcutSection(sectionName);
      let hasRows = false;
      for (const shortcut of this.keybindingDefinitions()) {
        if (shortcut.section !== sectionName || !this.shortcutMatchesSearch(shortcut, false, query)) continue;
        this.appendShortcutRow(section, shortcut);
        hasRows = true;
        visibleRows += 1;
      }
      for (const shortcut of references) {
        if (shortcut.section !== sectionName || !this.shortcutMatchesSearch(shortcut, true, query)) continue;
        this.appendShortcutRow(section, shortcut, true);
        hasRows = true;
        visibleRows += 1;
      }
      if (hasRows) list.appendChild(section);
    }
    if (!visibleRows) {
      const empty = document.createElement("div");
      empty.className = "keys-empty";
      empty.textContent = "No matching shortcuts";
      list.appendChild(empty);
    }
  }

  openKeybindings() {
    const search = this.$("keys-search");
    search.value = "";
    this.renderKeybindingsList();
    this.$("keys-backdrop").classList.remove("hidden");
    requestAnimationFrame(() => search.focus());
  }

  captureBinding(actionId, bindEl) {
    bindEl.classList.add("capturing");
    bindEl.textContent = "press keys…";
    const handler = (e) => {
      if (["Meta", "Shift", "Alt", "Control"].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      document.removeEventListener("keydown", handler, true);
      bindEl.classList.remove("capturing");
      if (e.key === "Escape") { bindEl.textContent = this.bindingToDisplay(this.bindingFor(actionId)); return; }
      const binding = this.eventToBinding(e);
      const key = this.keybindingsStorageKey();
      this.settings[key] = { ...(this.settings[key] || {}), [actionId]: binding };
      this.saveSettings();
      bindEl.textContent = this.bindingToDisplay(binding);
      this.updateShortcutTitles();
    };
    document.addEventListener("keydown", handler, true);
  }

  resetKeybindings() {
    this.settings[this.keybindingsStorageKey()] = {};
    this.saveSettings();
    this.openKeybindings();
  }

  exportSettings() {
    const blob = new Blob([JSON.stringify(this.settings, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "termdeck-settings.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  async killAllRunningTerminals() {
    const message = "Kill all running terminals, including detached sessions? This stops only terminal processes; " +
      "session tabs, transcripts, and history are preserved.";
    const confirmed = window.confirm(message);
    if (!confirmed) return;
    try {
      const response = await fetch("/api/terminals/kill-all", { method: "POST" });
      if (!response.ok) throw new Error(`kill request failed: ${response.status}`);
      const result = await response.json();
      const killed = Number(result.killed || 0);
      const terminalWord = killed === 1 ? "terminal" : "terminals";
      this.$("status-name").textContent = `killed ${killed} running ${terminalWord}; history preserved`;
      await this.refresh();
    } catch (error) {
      this.$("status-name").textContent = `unable to kill terminals: ${error.message}`;
    }
  }

  async killStaleTerminals() {
    const message = "Stop running terminals older than 24 hours? Their tabs and session information will stay available for reattach.";
    if (!window.confirm(message)) return;
    const button = this.$("kill-stale-terminals-btn");
    if (button) button.disabled = true;
    try {
      const response = await fetch("/api/terminals/kill-stale", { method: "POST" });
      if (!response.ok) throw new Error(`stale terminal cleanup failed: ${response.status}`);
      const result = await response.json();
      const killed = Array.isArray(result.killed) ? result.killed.length : 0;
      const failed = Array.isArray(result.failed) ? result.failed.length : 0;
      this.$("status-name").textContent = failed
        ? `stopped ${killed} old terminal${killed === 1 ? "" : "s"}; ${failed} could not be stopped`
        : killed ? `stopped ${killed} old terminal${killed === 1 ? "" : "s"}; tabs preserved` : "no terminals older than 24 hours";
      await this.refresh();
    } catch (error) {
      this.$("status-name").textContent = `unable to stop old terminals: ${error.message}`;
    } finally {
      if (button) button.disabled = false;
    }
  }

  closeTerminalProcessReport() {
    this.$("terminal-process-report-backdrop").classList.add("hidden");
  }

  formatTerminalProcessReportEntry(entry, compact = false) {
    const sessionId = String(entry.session_id || "unknown");
    const name = entry.known_session ? (entry.title || sessionId) : `ORPHAN ${sessionId}`;
    const project = entry.project ? ` · project ${entry.project}` : "";
    const socket = String(entry.socket || "").split(/[\\/]/).pop() || "unknown socket";
    const mode = entry.live ? entry.attached ? "attached" : entry.detached ? "detached" : "live" : "stale";
    const processes = Array.isArray(entry.processes) ? entry.processes : [];
    const processDetails = processes.map((process) => {
      const command = String(process.command || "").replace(/\s+/g, " ").trim();
      const state = process.state ? ` ${process.state}` : "";
      return `pid ${process.pid}${state}${command ? ` ${command}` : ""}`;
    });
    if (compact) {
      const pidText = processDetails.length ? processDetails.join("; ") : "no live pids";
      return `• ${name}${project} · ${mode} · ${socket} · ${pidText}`;
    }
    const lines = [`${name} [${sessionId}]${project}`, `  ${mode} · socket ${socket}`];
    if (processDetails.length) lines.push(...processDetails.map((detail) => `  ${detail}`));
    else lines.push("  no processes found");
    return lines.join("\n");
  }

  formatTerminalProcessReport(report) {
    const summary = report.summary || {};
    const entries = Array.isArray(report.sockets) ? report.sockets : [];
    const liveSockets = Number(summary.live_sockets || 0);
    const header = `${liveSockets} live socket${liveSockets === 1 ? "" : "s"} · ` +
      `${summary.processes || 0} processes · ${summary.node_repl_processes || 0} node_repl · ` +
      `${summary.zombie_processes || 0} zombies · ${summary.orphan_sockets || 0} orphan sockets`;
    const body = entries.length ? entries.map((entry) => this.formatTerminalProcessReportEntry(entry)).join("\n\n") : "No TermDeck dtach sockets found.";
    return { header, body, entries };
  }

  async showTerminalProcessReport() {
    const backdrop = this.$("terminal-process-report-backdrop");
    const status = this.$("terminal-process-report-status");
    const text = this.$("terminal-process-report-text");
    backdrop.classList.remove("hidden");
    backdrop.setAttribute("aria-busy", "true");
    status.classList.add("loading");
    status.textContent = "Generating report…";
    text.textContent = "";
    try {
      const response = await fetch("/api/terminals/processes");
      if (response.status === 404) {
        throw new Error("available after the next planned TermDeck server restart");
      }
      if (!response.ok) throw new Error(`report request failed: ${response.status}`);
      const report = await response.json();
      const formatted = this.formatTerminalProcessReport(report);
      status.classList.remove("loading");
      status.textContent = `Generated · ${formatted.header}`;
      text.textContent = formatted.body;
      backdrop.setAttribute("aria-busy", "false");
      text.focus({ preventScroll: true });
      this.$("status-name").textContent = formatted.header;
    } catch (error) {
      status.classList.remove("loading");
      status.textContent = `Unable to generate report: ${error.message}`;
      backdrop.setAttribute("aria-busy", "false");
      this.$("status-name").textContent = status.textContent;
    }
  }

  async reclaimOrphanTerminals() {
    try {
      const response = await fetch("/api/terminals/processes");
      if (response.status === 404) {
        throw new Error("available after the next planned TermDeck server restart");
      }
      if (!response.ok) throw new Error(`report request failed: ${response.status}`);
      const report = await response.json();
      const orphans = (report.sockets || []).filter((entry) => !entry.known_session);
      if (!orphans.length) {
        this.$("status-name").textContent = "no orphaned TermDeck terminal sockets";
        return;
      }
      const details = orphans.map((entry) => this.formatTerminalProcessReportEntry(entry, true)).join("\n");
      const confirmed = window.confirm([`Reclaim ${orphans.length} orphaned TermDeck socket${orphans.length === 1 ? "" : "s"}?`,
        "These are the processes that will be terminated:", "", details, "",
        "This terminates only processes reachable from those unlisted TermDeck sockets."].join("\n"));
      if (!confirmed) return;
      const cleanup = await fetch("/api/terminals/reclaim-orphans", { method: "POST" });
      if (!cleanup.ok) throw new Error(`cleanup request failed: ${cleanup.status}`);
      const result = await cleanup.json();
      const reclaimed = (result.reclaimed || []).length;
      const failed = (result.failed || []).length;
      this.$("status-name").textContent = failed
        ? `reclaimed ${reclaimed} orphan sockets; ${failed} still need attention`
        : `reclaimed ${reclaimed} orphaned TermDeck sockets`;
    } catch (error) {
      this.$("status-name").textContent = `unable to reclaim orphan terminals: ${error.message}`;
    }
  }

  eventToBinding(e) {
    if (["Meta", "Shift", "Alt", "Control"].includes(e.key)) return "";
    const parts = [];
    if (e.metaKey) parts.push("Meta");
    if (e.ctrlKey) parts.push("Ctrl");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    const key = /^Key[A-Z]$/.test(e.code || "") ? e.code.slice(3).toLowerCase()
      : e.key.length === 1 ? e.key.toLowerCase() : e.key;
    parts.push(key);
    return parts.join("+");
  }

  isRecentTerminalsShortcut(e) {
    if (this.vscodeMode || e.altKey || e.shiftKey || e.metaKey === e.ctrlKey || e.key.toLowerCase() !== "e") return false;
    const mappedAction = this.bindingMap()[this.eventToBinding(e)];
    return !mappedAction || mappedAction === "recent-terminals";
  }

  isDesktopTerminalSelectInputEvent(e) {
    return !this.vscodeMode && e.metaKey && !e.shiftKey && !e.ctrlKey && !e.altKey &&
      (e.code === "KeyA" || String(e.key || "").toLowerCase() === "a") &&
      this.activeFileKey === null && !this.historyOpen && !!this.views.get(this.activeId) &&
      !!e.target?.closest?.(".xterm");
  }

  isDesktopTerminalSelectAllEvent(e) {
    return !this.vscodeMode && this.bindingFor("select-terminal-all") === "Meta+Shift+a" &&
      e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey &&
      (e.code === "KeyA" || String(e.key || "").toLowerCase() === "a") &&
      this.activeFileKey === null && !this.historyOpen && !!this.views.get(this.activeId) &&
      !!e.target?.closest?.(".xterm");
  }

  bindingFor(actionId) {
    const definition = this.keybindingDefinitions().find((k) => k.id === actionId);
    return (this.settings[this.keybindingsStorageKey()] || {})[actionId] || definition?.def || "";
  }

  bindingMap() {
    const map = {};
    for (const k of this.keybindingDefinitions()) {
      const binding = this.bindingFor(k.id);
      map[binding] = k.id;
      if (!this.vscodeMode && !IS_MAC_KEYBOARD_PLATFORM && binding.includes("Meta")) {
        const platformBinding = binding.split("+").map((part) => part === "Meta" ? "Ctrl" : part).join("+");
        if (!map[platformBinding]) map[platformBinding] = k.id;
      }
    }
    return map;
  }

  tryAppShortcut(e) {
    const binding = this.eventToBinding(e);
    const actionId = binding ? this.bindingMap()[binding] : "";
    if (actionId) {
      if (["selection-copy", "selection-note-new", "selection-note-append"].includes(actionId) &&
          !this.readSelectionActionState()) return false;
      e.preventDefault();
      e.stopPropagation();
      this.runAction(actionId);
      return true;
    }
    if (!this.vscodeMode && e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey) {
      const key = e.key.toLowerCase();
      if (key === "f") {
        e.preventDefault();
        e.stopPropagation();
        this.focusFileContentSearch();
        return true;
      }
      if (e.key === " " || e.key === "Spacebar") {
        e.preventDefault();
        e.stopPropagation();
        this.cycleView("project");
        return true;
      }
    }
    if (this.isRecentTerminalsShortcut(e)) {
      e.preventDefault();
      e.stopPropagation();
      this.runAction("recent-terminals");
      return true;
    }
    return false;
  }

  closeContextMenu() {
    const menu = this.$("context-menu");
    if (menu) menu.classList.add("hidden");
    this.contextMenuTarget = null;
  }

  runContextMenuAction(actionId) {
    const menu = this.$("context-menu");
    if (!this.contextMenuTarget || !menu || menu.classList.contains("hidden")) return false;
    if (this.contextMenuTarget.type === "files" && actionId === "close-item") {
      const keys = [...this.contextMenuTarget.keys];
      this.closeContextMenu();
      void this.closeFiles(keys);
      return true;
    }
    if (this.contextMenuTarget.type === "sessions" && actionId === "close-item") {
      const sessionIds = [...this.contextMenuTarget.ids];
      this.closeContextMenu();
      void this.closeSelectedSessions(sessionIds);
      return true;
    }
    if (this.contextMenuTarget.type === "group") {
      const groupId = this.contextMenuTarget.id;
      if (!this.terminalGroups().some((group) => group.id === groupId)) return false;
      if (actionId === "move-active-to-top") {
        this.closeContextMenu();
        this.moveTerminalLayoutToTop(`group:${groupId}`);
        return true;
      }
      if (actionId === "rename-terminal") {
        this.closeContextMenu();
        this.renameTerminalGroup(groupId);
        return true;
      }
      if (actionId === "mark-terminal-unread") {
        this.closeContextMenu();
        this.markTerminalGroupUnread(groupId);
        return true;
      }
      if (actionId === "create-terminal-group-from-active") {
        this.closeContextMenu();
        this.removeTerminalGroup(groupId);
        return true;
      }
      if (actionId === "close-item") {
        this.closeContextMenu();
        this.closeAllInTerminalGroup(groupId);
        return true;
      }
    }
    return false;
  }

  runAction(actionId) {
    if (this.runContextMenuAction(actionId)) return;
    if (actionId === "new-terminal") this.openModal();
    else if (actionId === "new-project") void this.addProjectFromHeader();
    else if (actionId === "new-worktree") this.openWorktreeModal();
    else if (actionId === "new-group") this.createTerminalGroup();
    else if (actionId === "close-item") this.closeActiveItem();
    else if (actionId === "fork-terminal") { const s = this.session(this.activeId); if (s) this.forkSession(s); }
    else if (actionId === "restart-terminal") { if (this.activeId) this.restartSession(this.activeId); }
    else if (actionId === "restore-last-closed-terminal") void this.restoreLastClosedTerminal();
    else if (actionId === "resync-terminal") this.resyncActiveTerminal();
    else if (actionId === "rename-terminal") { const s = this.session(this.activeId); if (s) this.renameSession(s); }
    else if (actionId === "copy-session-id") {
      if (this.activeId) this.copyTextToClipboard(this.activeId, "session id copied");
    }
    else if (actionId === "mark-terminal-unread") {
      if (this.activeId) this.setSessionUnread(this.activeId, true);
    }
    else if (actionId === "create-terminal-group-from-active") {
      if (this.activeId) this.createTerminalGroupFromSession(this.activeId);
    }
    else if (actionId === "move-active-to-top") {
      if (this.activeId) {
        const assignedGroupId = this.getProjectState().session_groups?.[this.activeId] || "";
        this.moveTerminalLayoutToTop(assignedGroupId ? `group:${assignedGroupId}` : `session:${this.activeId}`);
      }
    }
    else if (actionId === "open-move-menu") this.openActiveMoveMenu();
    else if (actionId === "undo-terminal-edit") {
      const view = this.views.get(this.activeId);
      if (view && this.activeFileKey === null) this.sendTrackedInput(view, "\x1f");
    }
    else if (actionId === "open-terminal-new-tab") {
      const session = this.session(this.activeId);
      if (session) this.openTerminalInNewTab(session);
    }
    else if (actionId === "save-file") { if (this.activeFileKey !== null) this.saveActiveFile(); }
    else if (actionId === "prev-terminal") this.cycleTerminal(-1);
    else if (actionId === "next-terminal") this.cycleTerminal(1);
    else if (actionId === "cycle-side-panel") this.cycleFilesSidePanel();
    else if (actionId === "open-files-panel") this.openFilesSidePanelView("project");
    else if (actionId === "open-file-search") this.openFilesSidePanelView("search");
    else if (actionId === "open-files-new-tab") this.openFileDeckViewInNewTab(this.treeRoot || this.projectRoot(), "tree");
    else if (actionId === "open-search-new-tab") this.openFileDeckViewInNewTab(this.treeRoot || this.projectRoot(), "search", "", this.$("search-query").value.trim());
    else if (actionId === "open-terminal-search") this.toggleTerminalSearchEditor();
    else if (actionId === "view-terminals") this.setSideView("terminals");
    else if (actionId === "switch-project") this.openProjectSwitcher();
    else if (actionId === "toggle-notebook") this.toggleNotebook();
    else if (actionId === "selection-copy") this.copySelectionToClipboard();
    else if (actionId === "selection-note-new") void this.createNotebookNoteFromSelection();
    else if (actionId === "selection-note-append") void this.appendSelectionToNotebook();
    else if (actionId === "selection-copy-history") this.toggleSelectionCopyHistory();
    else if (actionId === "toggle-history") this.toggleHistory();
    else if (actionId === "scroll-bottom") this.scrollActiveSurfaceToBottom();
    else if (actionId === "focus-prompt") this.focusActivePrompt();
    else if (actionId === "show-usages") this.showEditorUsages();
    else if (actionId === "select-active-input") this.selectActiveInputText();
    else if (actionId === "select-terminal-all") this.selectActiveTerminalText();
    else if (actionId === "recent-terminals") this.openRecentTerminalsQuickOpen();
    else if (actionId === "quick-open") {
      if (this.$("quick-open-backdrop").classList.contains("hidden")) this.openQuickOpen();
      else this.closeQuickOpen();
    }
    else if (actionId === "toggle-problems") this.toggleProblemsPanel();
    else if (actionId === "conversation-outline") this.toggleConversationOutline();
    else if (actionId === "vscode-refresh") this.requestVscodeRefresh(false);
    else if (actionId === "vscode-reload") this.requestVscodeRefresh(true);
  }

  selectActiveTerminalText() {
    if (this.activeFileKey !== null || this.historyOpen) return;
    const view = this.views.get(this.activeId);
    if (!view) return;
    const select = () => {
      if (this.activeFileKey !== null || this.historyOpen || this.views.get(this.activeId) !== view) return;
      window.getSelection()?.removeAllRanges();
      view.term.focus();
      view.term.selectAll();
    };
    select();
    // Some browser/macOS paths apply their page-level select-all after the
    // key event despite preventDefault(). Re-apply xterm's selection after
    // that default-action frame.
    requestAnimationFrame(select);
  }

  selectActiveTerminalInputText() {
    if (this.activeFileKey !== null || this.historyOpen) return;
    const view = this.views.get(this.activeId);
    if (!view) return;
    const select = () => {
      if (this.activeFileKey !== null || this.historyOpen || this.views.get(this.activeId) !== view) return;
      const buffer = view.term.buffer.active;
      const line = buffer.cursorY + buffer.baseY;
      window.getSelection()?.removeAllRanges();
      view.term.focus();
      view.term.selectLines(line, line);
    };
    select();
    requestAnimationFrame(select);
  }

  selectActiveInputText() {
    if (this.activeFileKey !== null) {
      if (!this.editor) return;
      this.editor.focus();
      this.editor.trigger("termdeck", "editor.action.selectAll", null);
      return;
    }
    if (this.historyOpen) {
      const prompt = this.$("history-prompt");
      prompt.focus();
      prompt.select();
      return;
    }
    this.selectActiveTerminalText();
  }

  focusActivePrompt() {
    if (this.activeFileKey !== null) {
      this.editor?.focus();
      return;
    }
    if (this.historyOpen) {
      const prompt = this.$("history-prompt");
      prompt.focus();
      prompt.setSelectionRange(prompt.value.length, prompt.value.length);
      return;
    }
    this.views.get(this.activeId)?.term.focus();
  }

  openProjectSwitcher() {
    if (this.vscodeMode) return;
    const select = this.$("project-select");
    if (!select || select.disabled || select.classList.contains("hidden")) return;
    select.focus();
    if (typeof select.showPicker === "function") {
      select.showPicker();
      return;
    }
    select.click();
  }

  bindingToDisplay(binding) {
    const symbols = IS_MAC_KEYBOARD_PLATFORM
      ? { Meta: "⌘", Shift: "⇧", Alt: "⌥", Ctrl: "⌃", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Backspace: "⌫", Enter: "⏎", Escape: "esc" }
      : { Meta: "Ctrl", Shift: "Shift", Alt: "Alt", Ctrl: "Ctrl", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Backspace: "Backspace", Enter: "Enter", Escape: "Esc" };
    return binding.split("+").map((part) => symbols[part] || part.toUpperCase()).join(IS_MAC_KEYBOARD_PLATFORM ? "" : "+");
  }

  cycleTerminal(delta) {
    if (!this.sessions.length) return;
    const ids = this.sessions.map((s) => s.session_id);
    const current = ids.indexOf(this.activeId);
    const next = current === -1 ? 0 : (current + delta + ids.length) % ids.length;
    // Keyboard cycling may move past the visible portion of the sidebar.
    // Reveal only this newly selected row; ordinary clicks and browser
    // history navigation should not continually reposition the sidebar.
    this.activate(ids[next], { history: false, reveal: true });
  }

  applyForkPlacement(sourceSessionId, createdSessions) {
    const createdIds = createdSessions.map((session) => session.session_id);
    const createdIdSet = new Set(createdIds);
    const state = this.getProjectState();
    const sourceGroupId = state.session_groups?.[sourceSessionId] || null;
    const order = this.sessions.map((session) => session.session_id).filter((id) => !createdIdSet.has(id));
    const sourceIndex = order.indexOf(sourceSessionId);
    if (sourceIndex < 0) return;
    order.splice(sourceIndex + 1, 0, ...createdIds);
    const patch = { session_order: order };
    if (sourceGroupId) {
      patch.session_groups = { ...(state.session_groups || {}), ...Object.fromEntries(createdIds.map((id) => [id, sourceGroupId])) };
      patch.terminal_layout = this.terminalLayout().filter((entry) => !createdIdSet.has(entry.replace(/^session:/, "")));
    } else {
      const sourceToken = `session:${sourceSessionId}`;
      const layout = this.terminalLayout().filter((entry) => !createdIdSet.has(entry.replace(/^session:/, "")));
      const sourceIndexInLayout = layout.indexOf(sourceToken);
      layout.splice(sourceIndexInLayout < 0 ? layout.length : sourceIndexInLayout + 1, 0,
        ...createdIds.map((id) => `session:${id}`));
      patch.terminal_layout = layout;
    }
    this.applyLocalProjectStatePatch(patch);
    this.queueSessionOrderMove(createdIds, sourceSessionId, true);
    if (sourceGroupId) this.queueSessionGroupAssignments(
      Object.fromEntries(createdIds.map((id) => [id, sourceGroupId])), sourceSessionId, true);
    else {
      let previousToken = `session:${sourceSessionId}`;
      for (const createdId of createdIds) {
        const token = `session:${createdId}`;
        this.queueTerminalLayoutMove(token, previousToken, true);
        previousToken = token;
      }
    }
  }

  stripTitleStatusPrefixes(title) {
    let text = String(title || "");
    while (TITLE_STATUS_PREFIX_RE.test(text)) text = text.replace(TITLE_STATUS_PREFIX_RE, "");
    return text.trim();
  }

  async forkSession(s) {
    const baseTitle = this.stripTitleStatusPrefixes(this.effectiveTitle(s)) || "terminal";
    const rawValue = prompt(`Fork "${baseTitle}": enter a number from 1 to ${MAX_FORK_COUNT}, or enter a name for one fork.`, "1");
    if (rawValue === null || !rawValue.trim()) return;
    const value = rawValue.trim();
    if (!/^\d+$/.test(value)) {
      await this.createForkedSessions(s, [value]);
      return;
    }
    const count = Number.parseInt(value, 10);
    if (count < 1 || count > MAX_FORK_COUNT) {
      alert(`Enter a whole number from 1 to ${MAX_FORK_COUNT}, or a name for one fork.`);
      return;
    }
    await this.createForkedSessions(s, Array.from({ length: count }, (_unused, index) => `${baseTitle} ${index + 1}`));
  }

  async createForkedSessions(s, titles, options = {}) {
    const created = [];
    let failedAt = 0;
    for (let index = 0; index < titles.length; index += 1) {
      const res = await fetch(`/api/sessions/${s.session_id}/fork`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: titles[index], worktree: !!options.worktree }),
      });
      if (!res.ok) {
        failedAt = index + 1;
        break;
      }
      created.push(await res.json());
    }
    if (!created.length) {
      alert("fork failed");
      return;
    }
    if (this.nativeVscodeMode) {
      for (const session of created) this.postVscodeNativeSession(session, false);
    }
    this.applyForkPlacement(s.session_id, created);
    await this.refresh();
    if (created.length === 1 && !failedAt) {
      this.activate(created[0].session_id, { reveal: true });
      const view = this.views.get(created[0].session_id);
      if (view) view.pinBottomUntil = Date.now() + 8000;
    }
    this.$("status-name").textContent = failedAt
      ? `forked ${created.length} of ${titles.length}`
      : `forked ${created.length}`;
    if (failedAt) alert(`Forked ${created.length} of ${titles.length}; fork ${failedAt} failed.`);
  }

  async restartSession(sessionId, permission = "") {
    this.activate(sessionId);
    this.$("status-name").textContent = "restarting…";
    const view = this.views.get(sessionId);
    if (view) view.pinBottomUntil = Date.now() + 6000;
    const response = await fetch(`/api/sessions/${sessionId}/restart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ permission }),
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      this.$("status-name").textContent = detail?.detail || "restart failed";
      return;
    }
    this.refresh();
  }

  async closeSession(sessionId) {
    const s = this.session(sessionId);
    if (!s) return;
    if (!confirm(`Close "${this.effectiveTitle(s)}"? This kills the process (it moves to closed history).`)) return;
    const wasActive = this.activeId === sessionId;
    const closeOrder = this.sessions.map((session) => session.session_id);
    const closeIndex = closeOrder.indexOf(sessionId);
    const previouslyOpened = this.previouslyOpenedTerminalId(new Set([sessionId]));
    const adjacentSession = closeIndex >= 0 && closeIndex + 1 < closeOrder.length ? closeOrder[closeIndex + 1]
      : closeIndex > 0 ? closeOrder[closeIndex - 1] : null;
    const nextOnClose = previouslyOpened || adjacentSession;
    const response = await fetch(`/api/sessions/${sessionId}`, {
      method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group_name: this.terminalGroupNameForSession(sessionId) }),
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      this.$("status-name").textContent = detail.detail || "terminal process cleanup did not complete";
      return;
    }
    this.restoreLastClosedTerminalNeedsConfirmation = false;
    this.postVscodeNativeClose(sessionId);
    if (wasActive && nextOnClose && this.session(nextOnClose)) {
      this.activate(nextOnClose, { history: false, reveal: true });
      this.replaceNav({ kind: "term", id: nextOnClose });
    }
    await this.refresh();
    if (wasActive && nextOnClose) {
      const nextSession = this.session(nextOnClose);
      if (nextSession && this.activeId !== nextSession.session_id) {
        this.activate(nextSession.session_id, { history: false, reveal: true });
      }
    }
  }

  async closeSelectedSessions(sessionIds) {
    const selectedSessions = [...new Set(sessionIds)].map((sessionId) => this.session(sessionId)).filter(Boolean);
    if (!selectedSessions.length) return;
    if (!confirm(`Close ${selectedSessions.length} selected terminals? This kills their processes and moves them to closed history.`)) return;
    const selectedIds = new Set(selectedSessions.map((session) => session.session_id));
    const activeWasSelected = selectedIds.has(this.activeId);
    const activeIndex = this.sessions.findIndex((session) => session.session_id === this.activeId);
    const previouslyOpenedId = this.previouslyOpenedTerminalId(selectedIds);
    const nextSession = this.session(previouslyOpenedId) ||
      this.sessions.slice(activeIndex + 1).find((session) => !selectedIds.has(session.session_id)) ||
      this.sessions.slice(0, Math.max(activeIndex, 0)).reverse().find((session) => !selectedIds.has(session.session_id)) || null;
    const results = await Promise.all(selectedSessions.map(async (session) => ({ session,
      response: await fetch(`/api/sessions/${session.session_id}`, {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ group_name: this.terminalGroupNameForSession(session.session_id) }),
      }) })));
    const closedIds = results.filter((result) => result.response.ok).map((result) => result.session.session_id);
    if (closedIds.length) this.restoreLastClosedTerminalNeedsConfirmation = false;
    for (const sessionId of closedIds) this.postVscodeNativeClose(sessionId);
    this.sidebarSelectedSessionIds = new Set([...this.sidebarSelectedSessionIds]
      .filter((sessionId) => !closedIds.includes(sessionId)));
    if (activeWasSelected && nextSession && this.session(nextSession.session_id)) {
      this.activate(nextSession.session_id, { history: false, reveal: true });
      this.replaceNav({ kind: "term", id: nextSession.session_id });
    }
    await this.refresh();
    if (activeWasSelected && nextSession && this.session(nextSession.session_id) && this.activeId !== nextSession.session_id) {
      this.activate(nextSession.session_id, { history: false, reveal: true });
    }
    const failedCount = results.length - closedIds.length;
    if (failedCount) this.$("status-name").textContent = `${failedCount} terminal${failedCount === 1 ? "" : "s"} could not be closed`;
  }

  closeActive() {
    if (this.activeFileKey === null && this.activeId) this.closeSession(this.activeId);
  }

  async renameSession(s) {
    const title = prompt("Rename terminal", this.effectiveTitle(s));
    if (!title) return;
    await fetch(`/api/sessions/${s.session_id}/rename`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    this.refresh();
  }

  async moveSessionToProject(session, project) {
    if (!session || !project || project === session.project) return;
    const response = await fetch(`/api/sessions/${session.session_id}/project`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      alert(error.detail || "move terminal to project failed");
      return;
    }
    if (this.projectSlug && this.projectSlug !== project) {
      location.href = `/p/${encodeURIComponent(project)}`;
      return;
    }
    await this.refresh();
  }

  searchRoot() {
    if (this.vscodeMode && this.vscodeWorkspaceRoot) return this.vscodeWorkspaceRoot;
    const projectRoot = this.worktreeRoot();
    if (projectRoot) return projectRoot;
    const s = this.session(this.activeId);
    return s ? s.cwd : "~";
  }

  loadSearchHistory() {
    if (Array.isArray(this.settings.file_search_history) && this.settings.file_search_history.length) {
      this.searchHistory = this.settings.file_search_history.filter((entry) => entry && typeof entry.q === "string" &&
        (entry.mode === "content" || entry.mode === "name")).slice(-30);
      return;
    }
    const raw = localStorage.getItem(SEARCH_HISTORY_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    this.searchHistory = parsed.filter((entry) => entry && typeof entry.q === "string" &&
      (entry.mode === "content" || entry.mode === "name")).slice(-30);
    if (this.searchHistory.length) this.saveSearchHistory();
  }

  saveSearchHistory() {
    this.settings.file_search_history = this.searchHistory.slice(-30);
    this.saveSettings();
    localStorage.setItem(SEARCH_HISTORY_STORAGE_KEY, JSON.stringify(this.searchHistory.slice(-30)));
  }

  recordSearch(state) {
    const normalized = { ...state, mode: state.mode || "content" };
    if (this.pendingSearchHistoryState && JSON.stringify(this.pendingSearchHistoryState) === JSON.stringify(normalized)) return;
    this.pendingSearchHistoryState = normalized;
    clearTimeout(this.searchHistoryRecordTimer);
    this.searchHistoryRecordTimer = setTimeout(() => this.commitPendingSearchHistoryRecord(), SEARCH_HISTORY_RECORD_DELAY_MS);
  }

  commitPendingSearchHistoryRecord() {
    this.searchHistoryRecordTimer = 0;
    const pending = this.pendingSearchHistoryState;
    this.pendingSearchHistoryState = null;
    if (!pending) return;
    const last = this.searchHistory[this.searchHistory.length - 1];
    if (last && JSON.stringify(last) === JSON.stringify(pending)) return;
    this.searchHistoryBackIndex = null;
    this.searchHistory.push(pending);
    if (this.searchHistory.length > 30) this.searchHistory.shift();
    this.saveSearchHistory();
  }

  flushPendingSearchHistoryRecord() {
    if (!this.pendingSearchHistoryState) return;
    clearTimeout(this.searchHistoryRecordTimer);
    this.commitPendingSearchHistoryRecord();
  }

  positionSearchHistoryMenu(button) {
    const menu = this.$("search-history-menu");
    const rect = button.getBoundingClientRect();
    const width = Math.min(420, window.innerWidth - 20);
    const left = Math.max(10, Math.min(rect.right - width, window.innerWidth - width - 10));
    const top = rect.bottom + 4;
    menu.style.width = `${width}px`;
    menu.style.left = `${left}px`;
    menu.style.top = `${top + menu.offsetHeight <= window.innerHeight - 10 ? top : Math.max(10, rect.top - menu.offsetHeight - 4)}px`;
  }

  closeSearchHistory() {
    const menu = this.$("search-history-menu");
    menu.classList.add("hidden");
    for (const id of ["search-history-btn", "name-search-history-btn"]) this.$(id)?.setAttribute("aria-expanded", "false");
  }

  splitFileGlobTokens(raw) {
    return String(raw || "").split(",").map((token) => token.trim()).filter(Boolean);
  }

  fileIncludeGlob(mode) {
    return String(this.settings[mode === "tree" ? "tree_file_glob" : "search_file_glob"] || "").trim();
  }

  fileExcludeGlob() {
    return String(this.settings.excluded_file_glob || "").trim();
  }

  fileGlobForMode(mode) {
    return [...this.splitFileGlobTokens(this.fileIncludeGlob(mode)), ...this.fileTypeFilterTokens()].join(", ");
  }

  fileGlobForNameSearch() {
    return this.fileTypeFilterTokens().join(", ");
  }

  updateSearchIncludeGlob(raw) {
    this.settings.search_file_glob = String(raw || "").trim();
    this.syncLegacySearchGlob();
    this.saveSettings();
    if (this.sideView === "search" && this.$("search-query").value.trim()) this.debouncedSearch();
  }

  syncLegacySearchGlob() {
    this.settings.search_glob = this.fileGlobForMode("search");
    const hidden = this.$("search-glob");
    if (hidden) hidden.value = this.settings.search_glob;
  }

  syncFileGlobInputs() {
    const treeInput = this.$("tree-file-glob");
    const searchInput = this.$("search-file-glob");
    if (treeInput) treeInput.value = this.fileIncludeGlob("tree");
    if (searchInput) searchInput.value = this.fileIncludeGlob("search");
    this.syncLegacySearchGlob();
  }

  setFileGlobForMode(mode, raw) {
    const tokens = this.splitFileGlobTokens(raw);
    this.settings[mode === "tree" ? "tree_file_glob" : "search_file_glob"] = tokens.filter((token) => !token.startsWith("!")).join(", ");
    const excluded = tokens.filter((token) => token.startsWith("!"));
    if (excluded.length) this.settings.excluded_file_glob = [...new Set([...this.fileTypeFilterTokens(), ...excluded])].join(", ");
    this.syncFileGlobInputs();
    this.saveSettings();
  }

  fileTypeFilterTokens() {
    return this.splitFileGlobTokens(this.settings.excluded_file_glob || this.settings.search_glob || "").filter((token) => token.startsWith("!"));
  }

  recentFileExcludeTokens() {
    return this.splitFileGlobTokens(this.getProjectState().recent_file_exclude_glob);
  }

  normalizedFileExclusionTokens(tokens) {
    return [...new Set(tokens.map((token) => {
      const value = String(token).trim();
      return value ? (value.startsWith("!") ? value : `!${value}`) : "";
    }).filter(Boolean))];
  }

  updateFileTypeFilterTokens(tokens) {
    const normalized = this.normalizedFileExclusionTokens(tokens);
    this.settings.hide_dot_folders = normalized.includes("!.*");
    this.settings.excluded_file_glob = normalized.join(", ");
    this.updateHideDotButton();
    this.syncFileGlobInputs();
    this.saveSettings();
    this.renderFileTypeFilterMenu();
    if (this.sideView === "search" && this.$("search-query").value.trim()) this.debouncedSearch();
    else if (this.sideView === "project" && this.$("search-name").value.trim()) this.debouncedNameSearch();
    else this.rerenderTree();
  }

  updateVisibleFileTypeFilterTokens(tokens) {
    if (this.fileTypeFilterMenuMode !== "recent") {
      this.updateFileTypeFilterTokens(tokens);
      return;
    }
    this.patchProjectState({ recent_file_exclude_glob: this.normalizedFileExclusionTokens(tokens).join(", ") });
    this.recentFilesExpanded = false;
    this.renderList();
    this.$("recent-file-type-filter-button")?.setAttribute("aria-expanded", "true");
    this.renderFileTypeFilterMenu();
  }

  closeFileTypeFilterMenu() {
    this.$("file-type-filter-menu")?.classList.add("hidden");
    this.fileTypeFilterMenuMode = "name";
    for (const id of ["file-type-filter-button", "search-file-type-filter-button", "recent-file-type-filter-button"]) {
      this.$(id)?.setAttribute("aria-expanded", "false");
    }
  }

  toggleFileTypeFilterMenu(button) {
    const menu = this.$("file-type-filter-menu");
    if (!menu.classList.contains("hidden")) {
      this.closeFileTypeFilterMenu();
      return;
    }
    this.closeSearchHistory();
    this.fileTypeFilterMenuMode = button.id === "search-file-type-filter-button" ? "search" :
      button.id === "recent-file-type-filter-button" ? "recent" : "name";
    menu.classList.remove("hidden");
    for (const id of ["file-type-filter-button", "search-file-type-filter-button", "recent-file-type-filter-button"]) {
      this.$(id)?.setAttribute("aria-expanded", String(id === button.id));
    }
    this.renderFileTypeFilterMenu();
    const rect = button.getBoundingClientRect();
    const width = Math.min(360, window.innerWidth - 20);
    const left = Math.max(10, Math.min(rect.right - width, window.innerWidth - width - 10));
    const below = rect.bottom + 4;
    menu.style.width = `${width}px`;
    menu.style.left = `${left}px`;
    menu.style.top = `${below + menu.offsetHeight <= window.innerHeight - 10 ? below : Math.max(10, rect.top - menu.offsetHeight - 4)}px`;
  }

  renderFileTypeFilterMenu() {
    const menu = this.$("file-type-filter-menu");
    if (!menu || menu.classList.contains("hidden")) return;
    menu.textContent = "";
    const head = document.createElement("div");
    head.className = "file-type-filter-head";
    const title = document.createElement("span");
    title.className = "file-type-filter-title";
    title.textContent = this.fileTypeFilterMenuMode === "search" ? "Search file filters" :
      this.fileTypeFilterMenuMode === "recent" ? "Recently modified filters" : "Name search filters";
    head.appendChild(title);
    menu.appendChild(head);
    if (this.fileTypeFilterMenuMode === "search") {
      const include = document.createElement("div");
      include.className = "file-type-filter-include";
      const includeLabel = document.createElement("div");
      includeLabel.className = "file-type-filter-section";
      includeLabel.textContent = "Include patterns";
      const includeInput = document.createElement("input");
      includeInput.id = "search-file-glob";
      includeInput.className = "file-include-glob";
      includeInput.type = "text";
      includeInput.value = this.fileIncludeGlob("search");
      includeInput.placeholder = "*.py, src/**";
      includeInput.title = "Only search these file patterns";
      includeInput.autocomplete = "off";
      includeInput.autocapitalize = "off";
      includeInput.autocorrect = "off";
      includeInput.spellcheck = false;
      includeInput.addEventListener("input", () => this.updateSearchIncludeGlob(includeInput.value));
      include.append(includeLabel, includeInput);
      menu.appendChild(include);
    }
    const excludeLabel = document.createElement("div");
    excludeLabel.className = "file-type-filter-section";
    excludeLabel.textContent = "Exclude patterns";
    menu.appendChild(excludeLabel);
    const list = document.createElement("div");
    list.className = "file-type-filter-chip-list";
    const tokens = this.fileTypeFilterMenuMode === "recent" ? this.recentFileExcludeTokens() : this.fileTypeFilterTokens();
    for (const [index, token] of tokens.entries()) {
      const chip = document.createElement("span");
      chip.className = "file-type-filter-chip";
      chip.textContent = token.replace(/^!/, "");
      chip.title = token === "!.*" ? "Hidden files are excluded; remove this chip to include them" : token;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.title = token === "!.*" ? "Include hidden files" : "Remove exclusion";
      remove.setAttribute("aria-label", token === "!.*" ? "Include hidden files" : `Remove ${token}`);
      remove.innerHTML = '<span class="codicon codicon-close"></span>';
      remove.onclick = () => this.updateVisibleFileTypeFilterTokens(tokens.filter((candidate) => candidate !== token));
      remove.onkeydown = (event) => {
        const buttons = [...list.querySelectorAll(".file-type-filter-chip button")];
        if (event.key === "ArrowLeft" && index > 0) {
          event.preventDefault();
          buttons[index - 1]?.focus();
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          (buttons[index + 1] || input)?.focus();
        } else if (event.key === "Backspace" || event.key === "Delete") {
          event.preventDefault();
          this.updateVisibleFileTypeFilterTokens(tokens.filter((_, candidateIndex) => candidateIndex !== index));
        }
      };
      chip.appendChild(remove);
      list.appendChild(chip);
    }
    if (!tokens.length) {
      const empty = document.createElement("div");
      empty.className = "file-type-filter-empty";
      empty.textContent = "No excluded file patterns";
      list.appendChild(empty);
    }
    menu.appendChild(list);
    const manual = document.createElement("div");
    manual.className = "file-type-filter-manual";
    const input = document.createElement("input");
    input.id = "file-type-filter-manual-input";
    input.type = "text";
    input.placeholder = "add exclusion: *.log or .*";
    input.title = "Press Enter to add an excluded file pattern";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        const value = input.value.trim();
        if (!value) return;
        this.updateVisibleFileTypeFilterTokens([...tokens, value]);
        this.$("file-type-filter-manual-input")?.focus();
      } else if (event.key === "Backspace" && !input.value && tokens.length) {
        event.preventDefault();
        this.updateVisibleFileTypeFilterTokens(tokens.slice(0, -1));
        this.$("file-type-filter-manual-input")?.focus();
      } else if (event.key === "ArrowLeft" && input.selectionStart === 0 && tokens.length) {
        event.preventDefault();
        list.querySelector(".file-type-filter-chip button:last-child")?.focus();
      }
    });
    manual.appendChild(input);
    menu.appendChild(manual);
  }

  deleteSearchHistoryEntry(entry) {
    this.searchHistory = this.searchHistory.filter((candidate) => candidate !== entry);
    this.saveSearchHistory();
    this.renderSearchHistoryMenu();
  }

  useSearchHistory(entry) {
    this.closeSearchHistory();
    if (entry.mode === "name") {
      this.nameSearchCase = !!entry.case_sensitive;
      this.$("name-case-toggle").classList.toggle("on", this.nameSearchCase);
      this.setFileGlobForMode("tree", entry.glob || "");
      this.$("search-name").value = entry.q;
      if (this.sideView !== "project") this.setSideView("project");
      void this.runNameSearch(true);
      return;
    }
    this.searchWord = !!entry.word;
    this.searchCase = !!entry.case_sensitive;
    this.searchRegex = !!entry.regex;
    this.$("search-word-toggle").classList.toggle("on", this.searchWord);
    this.$("search-case-toggle").classList.toggle("on", this.searchCase);
    this.$("search-regex-toggle").classList.toggle("on", this.searchRegex);
    this.setFileGlobForMode("search", entry.glob || "");
    if (this.sideView !== "search") this.setSideView("search");
    void this.runSearch(entry.q, true);
  }

  renderSearchHistoryMenu() {
    const items = this.$("search-history-items");
    items.textContent = "";
    const entries = [...this.searchHistory].reverse();
    if (!entries.length) {
      const empty = document.createElement("div");
      empty.className = "search-history-empty";
      empty.textContent = "No recent searches";
      items.appendChild(empty);
      return;
    }
    for (const entry of entries) {
      const row = document.createElement("div");
      row.className = "search-history-item";
      row.setAttribute("role", "menuitem");
      row.onclick = () => this.useSearchHistory(entry);
      const mode = document.createElement("span");
      mode.className = "search-history-mode";
      mode.textContent = entry.mode === "name" ? "name" : "text";
      const query = document.createElement("span");
      query.className = "search-history-query";
      query.textContent = entry.q;
      query.title = entry.q;
      const remove = document.createElement("button");
      remove.className = "search-history-delete";
      remove.type = "button";
      remove.title = "Delete recent search";
      remove.setAttribute("aria-label", "Delete recent search");
      remove.innerHTML = '<span class="codicon codicon-close"></span>';
      remove.onclick = (event) => {
        event.stopPropagation();
        this.deleteSearchHistoryEntry(entry);
      };
      row.append(mode, query, remove);
      items.appendChild(row);
    }
  }

  toggleSearchHistory(button) {
    const menu = this.$("search-history-menu");
    if (!menu.classList.contains("hidden") && menu.dataset.anchor === button.id) {
      this.closeSearchHistory();
      return;
    }
    this.renderSearchHistoryMenu();
    menu.dataset.anchor = button.id;
    menu.classList.remove("hidden");
    button.setAttribute("aria-expanded", "true");
    this.positionSearchHistoryMenu(button);
  }

  showEditorUsages(word = "") {
    if (this.vscodeMode || !this.editor) return;
    const model = this.editor.getModel();
    const position = this.editor.getPosition();
    const selectedWord = word || model?.getWordAtPosition(position)?.word || "";
    if (!selectedWord) return;
    if (this.lspClient?.handlesModel(model)) {
      void this.editor.getAction("editor.action.referenceSearch.trigger")?.run();
      return;
    }
    if (this.sideView !== "search") {
      this.sideView = "terminals";
      this.setSideView("search");
    }
    this.searchWord = true;
    this.$("search-word-toggle").classList.add("on");
    void this.runSearch(selectedWord);
  }

  editorSymbolDefinitionPattern(word, path) {
    const escaped = String(word).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const identifier = `(?:${escaped})`;
    const python = `^\\s*(?:async\\s+)?(?:def|class)\\s+${identifier}\\b`;
    const javascript = `^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function|class)\\s+${identifier}\\b` +
      `|^\\s*(?:export\\s+)?(?:const|let|var)\\s+${identifier}\\s*=`;
    const rust = `^\\s*(?:pub\\s+)?(?:async\\s+)?fn\\s+${identifier}\\b`;
    const go = `^\\s*func(?:\\s+\\([^)]*\\))?\\s+${identifier}\\b`;
    const extension = String(path || "").split(".").pop().toLowerCase();
    if (extension === "py") return python;
    if (["js", "jsx", "ts", "tsx", "mjs", "cjs"].includes(extension)) return javascript;
    if (extension === "rs") return rust;
    if (extension === "go") return go;
    return [python, javascript, rust, go].join("|");
  }

  async findEditorSymbolDefinition(entry, word) {
    const glob = this.fileGlobForMode("search");
    const ignore = this.searchIgnoreTokens();
    const params = new URLSearchParams({ root: entry.root, q: this.editorSymbolDefinitionPattern(word, entry.path),
      glob, ignore, include_hidden: String(this.includeHiddenFilesInSearch()), word: "false", case_sensitive: "true", regex: "true" });
    try {
      const response = await fetch(`/api/files/search?${params}`);
      if (!response.ok) return null;
      const hits = await response.json();
      return hits.sort((a, b) => (Number(a.path !== entry.path) - Number(b.path !== entry.path)) ||
        (Number(a.line) - Number(b.line)))[0] || null;
    } catch (_error) {
      return null;
    }
  }

  async openEditorSymbolAtPosition(position) {
    if (this.vscodeMode || this.activeFileKey === null) return;
    const entry = this.openFiles.get(this.activeFileKey);
    const model = this.editor?.getModel();
    const word = model?.getWordAtPosition(position);
    if (!entry || !model || !word) return;
    const key = this.activeFileKey;
    const lspDefinition = await this.lspClient?.definitionAt(position);
    if (this.activeFileKey !== key) return;
    if (lspDefinition && await this.lspClient.openLocation(lspDefinition)) return;
    const definition = await this.findEditorSymbolDefinition(entry, word.word);
    if (this.activeFileKey !== key) return;
    if (!definition) {
      this.showEditorUsages(word.word);
      return;
    }
    await this.openFile(entry.root, definition.path, definition.line, null);
    this.editor?.focus();
  }

  prevSearch() {
    const entries = this.searchHistory.filter((entry) => (entry.mode || "content") === "content");
    if (entries.length < 2) return;
    if (this.searchHistoryBackIndex === null) this.searchHistoryBackIndex = entries.length - 2;
    else this.searchHistoryBackIndex = Math.max(0, this.searchHistoryBackIndex - 1);
    const prev = entries[this.searchHistoryBackIndex];
    this.searchWord = prev.word;
    this.searchCase = prev.case_sensitive;
    this.$("search-word-toggle").classList.toggle("on", this.searchWord);
    this.$("search-case-toggle").classList.toggle("on", this.searchCase);
    this.setFileGlobForMode("search", prev.glob || "");
    if (this.sideView !== "search") {
      this.sideView = "terminals";
      this.setSideView("search");
    }
    this.runSearch(prev.q, true);
  }

  searchHighlightRanges(text, query, options = {}) {
    const source = String(text || "");
    const needle = String(query || "");
    if (!source || !needle) return [];
    const caseSensitive = Boolean(options.caseSensitive);
    const regexMode = Boolean(options.regex);
    const fuzzy = Boolean(options.fuzzy);
    const wholeWord = Boolean(options.wholeWord);
    const flags = caseSensitive ? "g" : "gi";
    if (regexMode || wholeWord) {
      const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = regexMode ? needle : (/\s/.test(needle) ? escaped : `\\b${escaped}\\b`);
      let matcher;
      try {
        matcher = new RegExp(pattern, flags);
      } catch (error) {
        return [];
      }
      const ranges = [];
      let match;
      while ((match = matcher.exec(source))) {
        if (match[0].length) ranges.push([match.index, match.index + match[0].length]);
        else matcher.lastIndex += 1;
      }
      return ranges;
    }
    if (fuzzy) {
      const sourceValue = caseSensitive ? source : source.toLocaleLowerCase();
      const queryValue = caseSensitive ? needle : needle.toLocaleLowerCase();
      const ranges = [];
      let cursor = 0;
      for (const character of queryValue) {
        const index = sourceValue.indexOf(character, cursor);
        if (index < 0) return [];
        ranges.push([index, index + character.length]);
        cursor = index + character.length;
      }
      return ranges;
    }
    const sourceValue = caseSensitive ? source : source.toLocaleLowerCase();
    const queryValue = caseSensitive ? needle : needle.toLocaleLowerCase();
    const ranges = [];
    let cursor = 0;
    while (true) {
      const index = sourceValue.indexOf(queryValue, cursor);
      if (index < 0) break;
      ranges.push([index, index + queryValue.length]);
      cursor = index + queryValue.length;
    }
    return ranges;
  }

  appendSearchHighlightedText(element, text, query, options = {}) {
    const value = String(text || "");
    element.textContent = "";
    const ranges = this.searchHighlightRanges(value, query, options);
    let cursor = 0;
    for (const [start, end] of ranges) {
      if (start > cursor) element.appendChild(document.createTextNode(value.slice(cursor, start)));
      const mark = document.createElement("mark");
      mark.className = "search-match-highlight";
      mark.textContent = value.slice(start, end);
      element.appendChild(mark);
      cursor = end;
    }
    if (cursor < value.length) element.appendChild(document.createTextNode(value.slice(cursor)));
  }

  buildContentSearchHierarchy(files) {
    const root = { path: "", directories: new Map(), files: [] };
    const directories = new Set();
    for (const file of files) {
      const parts = String(file.path || "").split("/").filter(Boolean);
      let node = root;
      let directoryPath = "";
      for (const part of parts.slice(0, -1)) {
        directoryPath = directoryPath ? `${directoryPath}/${part}` : part;
        directories.add(directoryPath);
        if (!node.directories.has(part)) node.directories.set(part, { path: directoryPath, name: part, directories: new Map(), files: [] });
        node = node.directories.get(part);
      }
      node.files.push(file);
    }
    return { root, directories };
  }

  collapseSearchDirectoryChain(directory, includeMatchedDirectory = false) {
    const chain = [directory];
    let current = directory;
    while (!current.files.length && current.directories.size === 1 && (!includeMatchedDirectory || !current.hit)) {
      current = [...current.directories.values()][0];
      chain.push(current);
    }
    return { chain, directory: current };
  }

  appendSearchDirectoryChainName(element, chain, query, options = {}) {
    element.textContent = "";
    chain.forEach((part, index) => {
      if (index) {
        const separator = document.createElement("span");
        separator.className = "search-tree-path-separator";
        separator.textContent = ">";
        element.appendChild(separator);
      }
      const segment = document.createElement("span");
      segment.className = "search-tree-path-segment";
      if (options.highlight) this.appendSearchHighlightedText(segment, part.name, query, options);
      else segment.textContent = part.name;
      element.appendChild(segment);
    });
  }

  renderContentSearchHierarchy(node, container, root, query) {
    const directories = [...node.directories.values()].sort((a, b) => String(a.name).localeCompare(String(b.name), undefined,
      { numeric: true, sensitivity: "base" }));
    for (const directory of directories) {
      const collapsed = this.collapseSearchDirectoryChain(directory);
      const displayDirectory = collapsed.directory;
      const row = document.createElement("div");
      row.className = `tree-row dir search-tree-row search-tree-directory search-tree-context-directory open${collapsed.chain.length > 1 ? " search-tree-collapsed-directory" : ""}`;
      row.tabIndex = 0;
      row.title = `${root}/${displayDirectory.path}`;
      const chevron = document.createElement("span");
      chevron.className = "codicon codicon-chevron-right tree-chevron";
      const icon = document.createElement("img");
      icon.className = "tree-type-icon tree-folder-icon";
      icon.src = FOLDER_ICON_OPEN;
      const name = document.createElement("span");
      name.className = "tree-name search-tree-directory-name";
      this.appendSearchDirectoryChainName(name, collapsed.chain, query);
      row.append(chevron, icon, name);
      const children = document.createElement("div");
      children.className = "tree-children-wrap search-tree-children";
      row.onclick = () => {
        const open = row.classList.toggle("open");
        children.classList.toggle("hidden", !open);
        icon.src = open ? FOLDER_ICON_OPEN : FOLDER_ICON_CLOSED;
      };
      container.append(row, children);
      this.renderContentSearchHierarchy(displayDirectory, children, root, query);
    }
    const files = [...node.files].sort((a, b) => this.compareSearchFiles(a, b));
    for (const file of files) {
      const fileRow = document.createElement("div");
      fileRow.className = "tree-row file search-file search-tree-row search-tree-file";
      fileRow.tabIndex = 0;
      fileRow.title = `${root}/${file.path}\nMiddle-click opens in a new TermDeck tab`;
      const spacer = document.createElement("span");
      spacer.className = "tree-file-spacer";
      const fileName = document.createElement("span");
      fileName.className = "search-file-name tree-name";
      this.appendSearchHighlightedText(fileName, String(file.path).split("/").pop(), query, { caseSensitive: this.searchCase });
      fileRow.append(spacer, this.fileTypeIconEl(fileName.textContent, "tree-type-icon"), fileName);
      fileRow.onclick = () => this.openFile(root, file.path, file.hits[0]?.line || null, null, { fromFilePanel: true, preview: true });
      fileRow.ondblclick = () => this.openFile(root, file.path, file.hits[0]?.line || null, null, { fromFilePanel: true, pinned: true });
      fileRow.onauxclick = (event) => this.handleFileDeckAuxClick(event, root, file.path);
      fileRow.oncontextmenu = (event) => this.openFileDeckRowContextMenu(event, root, file.path);
      this.appendMtime(fileRow, file);
      this.appendGitStatus(fileRow, file);
      container.appendChild(fileRow);
      const hits = document.createElement("div");
      hits.className = "search-tree-hits";
      for (const hit of file.hits) {
        const hitRow = document.createElement("div");
        hitRow.className = "search-hit";
        hitRow.tabIndex = -1;
        hitRow.setAttribute("role", "option");
        const line = document.createElement("span");
        line.className = "hit-line";
        line.textContent = hit.line;
        const text = document.createElement("span");
        text.className = "hit-text";
        this.appendSearchHighlightedText(text, hit.text, query, {
          caseSensitive: this.searchCase, regex: this.searchRegex, wholeWord: this.searchWord,
        });
        hitRow.append(line, text);
        hitRow.title = `${hit.path}:${hit.line}`;
        hitRow.onclick = (event) => {
          event.stopPropagation();
          this.openFile(root, hit.path, hit.line, null, { fromFilePanel: true, preview: true });
        };
        hitRow.onauxclick = (event) => this.handleFileDeckAuxClick(event, root, hit.path);
        hitRow.onmouseenter = () => this.selectFileSearchResult("content", hitRow, { reveal: false });
        hits.appendChild(hitRow);
      }
      container.appendChild(hits);
    }
  }

  async runSearch(queryOverride, skipRecord) {
    const generation = ++this.searchGeneration;
    if (queryOverride != null) this.$("search-query").value = queryOverride;
    const query = this.$("search-query").value.trim();
    const resultsEl = this.$("search-results");
    this.$("replace-preview").classList.add("hidden");
    this.lastSearchRoot = "";
    this.lastSearchFiles = [];
    resultsEl.textContent = "";
    this.clearFileSearchSelection("content");
    this.contentSearchTree = null;
    if (!query) { this.setExplorerMode("tree"); return; }
    if (this.sideView !== "search") {
      this.sideView = "terminals";
      this.setSideView("search");
    }
    this.setExplorerMode("content");
    if (!skipRecord) {
      const state = { mode: "content", q: query, glob: this.fileGlobForMode("search"),
                      word: this.searchWord, case_sensitive: this.searchCase, regex: this.searchRegex };
      this.recordSearch(state);
      // Search selection is also a fixed sidebar view, so keep it in the
      // current URL without adding a browser-history step.
      this.replaceNav({ kind: "search", ...state });
    }
    const summary = document.createElement("div");
    summary.className = "search-summary";
    summary.textContent = "searching…";
    resultsEl.appendChild(summary);
    const root = this.searchRoot();
    const globParts = this.splitFileGlobTokens(this.fileGlobForMode("search"));
    const ignore = this.searchIgnoreTokens();
    const params = new URLSearchParams({ root, q: query, glob: globParts.join(","), ignore,
                                         include_hidden: String(this.includeHiddenFilesInSearch()),
                                         word: this.searchWord ? "true" : "false",
                                         case_sensitive: this.searchCase ? "true" : "false",
                                         regex: this.searchRegex ? "true" : "false" });
    const res = await fetch(`/api/files/search?${params}`);
    if (generation !== this.searchGeneration) return;
    if (!res.ok) {
      summary.textContent = "search failed";
      return;
    }
    const hits = await res.json();
    resultsEl.textContent = "";
    const byFile = new Map();
    for (const hit of hits) {
      if (!byFile.has(hit.path)) byFile.set(hit.path, { path: hit.path, mtime: hit.mtime || 0, git_status: hit.git_status || "", hits: [] });
      byFile.get(hit.path).hits.push(hit);
    }
    const files = [...byFile.values()].sort((a, b) => this.compareSearchFiles(a, b));
    this.lastSearchRoot = root;
    this.lastSearchFiles = files;
    const hierarchy = this.buildContentSearchHierarchy(files);
    this.contentSearchTree = { root, paths: new Set(files.map((file) => file.path)), directories: hierarchy.directories };
    this.renderContentSearchHierarchy(hierarchy.root, resultsEl, root, query);
    const done = document.createElement("div");
    done.className = "search-summary";
    const flags = [this.searchWord ? "whole word" : "", this.searchCase ? "case sensitive" : ""].filter(Boolean).join(", ");
    done.textContent = `${hits.length} match${hits.length === 1 ? "" : "es"} in ${files.length} file${files.length === 1 ? "" : "s"}${flags ? ` · ${flags}` : ""}`;
    resultsEl.prepend(done);
  }

  compareSearchFiles(a, b) {
    if (this.settings.file_tree_sort === "mtime") {
      const mtimeOrder = Number(b.mtime || 0) - Number(a.mtime || 0);
      if (mtimeOrder) return mtimeOrder;
    } else {
      const directoryOrder = Number(Boolean(b.is_dir)) - Number(Boolean(a.is_dir));
      if (directoryOrder) return directoryOrder;
    }
    return String(a.path || "").localeCompare(String(b.path || ""), undefined,
      { numeric: true, sensitivity: "base" });
  }

  compareNameSearchFiles(a, b, query) {
    return this.nameSearchMatchRank(a, query) - this.nameSearchMatchRank(b, query) || this.compareSearchFiles(a, b);
  }

  nameSearchMatchRank(entry, query) {
    const basename = String(entry.path || "").split("/").pop() || "";
    const normalizedName = this.nameSearchCase ? basename : basename.toLowerCase();
    const normalizedQuery = this.nameSearchCase ? query : query.toLowerCase();
    if (normalizedName === normalizedQuery) return 0;
    if (!entry.is_dir && normalizedName.replace(/\.[^.]+$/, "") === normalizedQuery) return 1;
    if (normalizedName.startsWith(normalizedQuery)) return 2;
    return this.searchHighlightRanges(basename, query, { caseSensitive: this.nameSearchCase, fuzzy: true }).length ? 4 : 5;
  }

  debouncedSearch() {
    clearTimeout(this.searchDebounce);
    const query = this.$("search-query").value.trim();
    if (!query) {
      this.$("search-results").textContent = "";
      this.$("replace-preview").classList.add("hidden");
      this.lastSearchRoot = "";
      this.lastSearchFiles = [];
      this.clearFileSearchSelection("content");
      this.contentSearchTree = null;
      this.treeSearchFilter = null;
      return;
    }
    this.searchDebounce = setTimeout(() => this.runSearch(), SEARCH_DEBOUNCE_MS);
  }

  fileSearchResultRows(mode) {
    const container = this.$(mode === "name" ? "name-results" : "search-results");
    const selector = mode === "name" ? ".search-file.clickable, .search-tree-directory.clickable" : ".search-hit";
    return container ? [...container.querySelectorAll(selector)] : [];
  }

  clearFileSearchSelection(mode) {
    this.searchSelection[mode] = -1;
  }

  selectFileSearchResult(mode, row, { reveal = true } = {}) {
    const rows = this.fileSearchResultRows(mode);
    const index = rows.indexOf(row);
    if (index < 0) return false;
    this.searchSelection[mode] = index;
    for (const candidate of rows) {
      const selected = candidate === row;
      candidate.classList.toggle("keyboard-selected", selected);
      candidate.setAttribute("aria-selected", String(selected));
    }
    if (reveal) row.scrollIntoView({ block: "nearest" });
    return true;
  }

  moveFileSearchSelection(mode, delta) {
    const rows = this.fileSearchResultRows(mode);
    if (!rows.length) return false;
    const current = this.searchSelection[mode];
    const index = current < 0 ? (delta < 0 ? rows.length - 1 : 0) :
      Math.max(0, Math.min(rows.length - 1, current + delta));
    return this.selectFileSearchResult(mode, rows[index]);
  }

  activateFileSearchSelection(mode) {
    const row = this.fileSearchResultRows(mode)[this.searchSelection[mode]];
    if (!row) return false;
    row.click();
    return true;
  }

  handleFileSearchNavigation(event, mode) {
    if (event.metaKey || event.ctrlKey || event.altKey) return false;
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return false;
    event.preventDefault();
    this.moveFileSearchSelection(mode, event.key === "ArrowDown" ? 1 : -1);
    return true;
  }

  treeFilterForSearch(mode) {
    const search = mode === "name" ? this.nameSearchTree : this.contentSearchTree;
    if (!search) return null;
    const paths = new Set(search.paths || []);
    const directories = new Set(search.directories || []);
    const expandedDirs = new Set();
    const addParents = (path, includeSelf) => {
      const parts = String(path || "").split("/").filter(Boolean);
      const count = includeSelf ? parts.length : Math.max(0, parts.length - 1);
      let rel = "";
      for (let index = 0; index < count; index += 1) {
        rel = rel ? `${rel}/${parts[index]}` : parts[index];
        expandedDirs.add(rel);
      }
    };
    for (const path of paths) addParents(path, directories.has(path));
    return { root: search.root, paths, directories, expandedDirs };
  }

  treeFilterAllows(relPath, isDir) {
    const filter = this.treeSearchFilter;
    if (!filter) return true;
    const path = String(relPath || "");
    const prefix = `${path}/`;
    const isWithinMatchedDirectory = [...filter.directories].some((directory) => path.startsWith(`${directory}/`));
    if (!isDir) return filter.paths.has(path) || isWithinMatchedDirectory;
    return isWithinMatchedDirectory || filter.directories.has(path) ||
      [...filter.paths].some((candidate) => candidate === path || candidate.startsWith(prefix));
  }

  async enterFileTreeNavigation(mode) {
    if (this.vscodeMode) return;
    const filter = this.treeFilterForSearch(mode);
    this.treeSearchFilter = filter;
    this.expandedDirs = new Set(filter?.expandedDirs || []);
    const expectedRoot = filter?.root || this.searchRoot();
    if (this.sideView !== "project" && this.sideView !== "search") {
      this.setSideView(mode === "content" ? "search" : "project", false);
    }
    this.setExplorerMode("tree");
    this.treeReloadPromise = this.reloadTree(expectedRoot);
    await this.treeReloadPromise;
    const tree = this.$("files-tree");
    tree.focus({ preventScroll: true });
    await this.treeKeyNav("ArrowDown");
  }

  async replaceAll() {
    const query = this.$("search-query").value.trim();
    const replacement = this.$("replace-with").value;
    if (!query) {
      alert("enter a search query first");
      return;
    }
    if (!this.lastSearchFiles.length) await this.runSearch(null, true);
    this.renderReplacePreview(query, replacement);
  }

  renderReplacePreview(query, replacement) {
    const panel = this.$("replace-preview");
    panel.textContent = "";
    panel.classList.remove("hidden");
    const head = document.createElement("div");
    head.className = "replace-preview-head";
    const title = document.createElement("strong");
    title.textContent = `${this.lastSearchFiles.length} files`;
    const detail = document.createElement("span");
    detail.textContent = `“${query}” → “${replacement}”`;
    const apply = document.createElement("button");
    apply.type = "button";
    apply.textContent = "Apply selected";
    apply.onclick = () => void this.applyReplacementPreview();
    head.append(title, detail, apply);
    panel.appendChild(head);
    for (const file of this.lastSearchFiles) {
      const label = document.createElement("label");
      label.className = "replace-preview-file";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = true;
      checkbox.value = file.path;
      const path = document.createElement("span");
      path.textContent = file.path;
      const count = document.createElement("small");
      count.textContent = `${file.hits.length}`;
      label.append(checkbox, path, count);
      panel.appendChild(label);
    }
  }

  async applyReplacementPreview() {
    const query = this.$("search-query").value.trim();
    const replacement = this.$("replace-with").value;
    const paths = [...this.$("replace-preview").querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value);
    if (!paths.length) return;
    if (!confirm(`Replace matches in ${paths.length} selected file${paths.length === 1 ? "" : "s"}?`)) return;
    const res = await fetch("/api/files/replace", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root: this.lastSearchRoot || this.searchRoot(), q: query, glob: this.fileGlobForMode("search"),
                             ignore: this.searchIgnoreTokens(),
                             include_hidden: this.includeHiddenFilesInSearch(),
                             word: this.searchWord, case_sensitive: this.searchCase, regex: this.searchRegex,
                             replacement, paths }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(err.detail || "replace failed");
      return;
    }
    const result = await res.json();
    this.$("replace-preview").classList.add("hidden");
    alert(`replaced ${result.replacements} match${result.replacements === 1 ? "" : "es"} in ${result.files} file${result.files === 1 ? "" : "s"}`);
    for (const entry of this.openFiles.values()) {
      if (entry.model && !entry.dirty) {
        entry.model.dispose();
        entry.model = null;
      }
    }
    if (this.activeFileKey !== null) this.activateFile(this.activeFileKey, null);
    this.runSearch(null, true);
  }

  debouncedNameSearch() {
    clearTimeout(this.nameDebounce);
    if (!this.$("search-name").value.trim()) {
      this.nameDebounce = setTimeout(() => this.runNameSearch(), 0);
      return;
    }
    this.nameDebounce = setTimeout(() => this.runNameSearch(), SEARCH_DEBOUNCE_MS);
  }

  async runNameSearch(skipRecord = false) {
    const generation = ++this.nameSearchGeneration;
    const query = this.$("search-name").value.trim();
    const resultsEl = this.$("name-results");
    resultsEl.textContent = "";
    this.clearFileSearchSelection("name");
    this.nameSearchTree = null;
    this.treeSearchFilter = null;
    if (!query) {
      this.setExplorerMode("tree");
      return;
    }
    if (this.sideView !== "project" && this.sideView !== "search") {
      this.sideView = "terminals";
      this.setSideView("project");
    }
    this.setExplorerMode("name");
    if (!skipRecord) this.recordSearch({ mode: "name", q: query, glob: this.fileGlobForNameSearch(), case_sensitive: this.nameSearchCase });
    const loading = document.createElement("div");
    loading.className = "search-summary";
    loading.textContent = "loading project files…";
    resultsEl.appendChild(loading);
    const root = this.searchRoot();
    const ignore = this.searchIgnoreTokens();
    const glob = this.fileGlobForNameSearch();
    const res = await fetch(`/api/files/find?${new URLSearchParams({ root, q: query, glob, ignore,
      include_hidden: String(this.includeHiddenFilesInSearch()), case_sensitive: this.nameSearchCase ? "true" : "false" })}`);
    if (!res.ok) return;
    const hits = await res.json();
    if (generation !== this.nameSearchGeneration) return;
    const orderedHits = [...hits].sort((a, b) => this.compareNameSearchFiles(a, b, query));
    this.nameSearchTree = {
      root,
      paths: new Set(orderedHits.map((hit) => hit.path)),
      directories: new Set(orderedHits.filter((hit) => hit.is_dir).map((hit) => hit.path)),
    };
    resultsEl.textContent = "";
    const summary = document.createElement("div");
    summary.className = "search-summary";
    const folderCount = orderedHits.filter((hit) => hit.is_dir).length;
    summary.textContent = `${orderedHits.length} result${orderedHits.length === 1 ? "" : "s"}${folderCount ? ` · ${folderCount} folder${folderCount === 1 ? "" : "s"}` : ""}`;
    resultsEl.appendChild(summary);
    const exactHits = orderedHits.filter((hit) => this.nameSearchMatchRank(hit, query) < 2);
    const fuzzyHits = orderedHits.filter((hit) => this.nameSearchMatchRank(hit, query) >= 2);
    for (const [label, sectionHits] of [["Exact matches", exactHits], ["Fuzzy matches", fuzzyHits]]) {
      if (!sectionHits.length) continue;
      const section = document.createElement("div");
      section.className = "search-result-section-label";
      section.textContent = `${label} · ${sectionHits.length}`;
      resultsEl.appendChild(section);
      this.renderNameSearchHierarchy(this.buildNameSearchHierarchy(sectionHits), resultsEl, root, query);
    }
  }

  buildNameSearchHierarchy(hits) {
    const root = { path: "", directories: new Map(), files: [] };
    for (const hit of hits) {
      const parts = String(hit.path || "").split("/").filter(Boolean);
      if (!parts.length) continue;
      const directoryParts = hit.is_dir ? parts : parts.slice(0, -1);
      let node = root;
      let directoryPath = "";
      for (const part of directoryParts) {
        directoryPath = directoryPath ? `${directoryPath}/${part}` : part;
        if (!node.directories.has(part)) node.directories.set(part, { path: directoryPath, name: part, hit: null, directories: new Map(), files: [] });
        node = node.directories.get(part);
      }
      if (hit.is_dir) node.hit = hit;
      else node.files.push(hit);
    }
    return root;
  }

  renderNameSearchHierarchy(node, container, root, query) {
    const directories = [...node.directories.values()].sort((a, b) => String(a.name).localeCompare(String(b.name), undefined,
      { numeric: true, sensitivity: "base" }));
    for (const directory of directories) {
      const collapsed = this.collapseSearchDirectoryChain(directory, true);
      const displayDirectory = collapsed.directory;
      const row = document.createElement("div");
      const directoryNameMatches = collapsed.chain.some((part) => part.hit || this.searchHighlightRanges(part.name, query, { caseSensitive: this.nameSearchCase, fuzzy: true }).length > 0);
      row.className = `tree-row dir clickable search-tree-row search-tree-directory ${directoryNameMatches ? "search-tree-matching-directory" : "search-tree-context-directory"} open${collapsed.chain.length > 1 ? " search-tree-collapsed-directory" : ""}`;
      row.tabIndex = 0;
      row.title = `${root}/${displayDirectory.path}`;
      const chevron = document.createElement("span");
      chevron.className = "codicon codicon-chevron-right tree-chevron";
      const icon = document.createElement("img");
      icon.className = "tree-type-icon tree-folder-icon";
      icon.src = FOLDER_ICON_OPEN;
      const name = document.createElement("span");
      name.className = "tree-name search-tree-directory-name";
      this.appendSearchDirectoryChainName(name, collapsed.chain, query, { caseSensitive: this.nameSearchCase, fuzzy: true, highlight: true });
      row.append(chevron, icon, name);
      if (displayDirectory.hit) {
        this.appendMtime(row, displayDirectory.hit);
        this.appendGitStatus(row, displayDirectory.hit);
      }
      const children = document.createElement("div");
      children.className = "tree-children-wrap search-tree-children";
      row.onclick = () => {
        const open = row.classList.toggle("open");
        children.classList.toggle("hidden", !open);
        icon.src = open ? FOLDER_ICON_OPEN : FOLDER_ICON_CLOSED;
      };
      row.ondblclick = () => this.openNameDirectory(root, displayDirectory.path);
      row.onmouseenter = () => this.selectFileSearchResult("name", row, { reveal: false });
      container.append(row, children);
      this.renderNameSearchHierarchy(displayDirectory, children, root, query);
    }
    const files = [...node.files].sort((a, b) => this.compareSearchFiles(a, b));
    for (const file of files) {
      const fileRow = document.createElement("div");
      fileRow.className = "tree-row file search-file clickable search-tree-row search-tree-file";
      fileRow.tabIndex = 0;
      fileRow.title = `${root}/${file.path}\nMiddle-click opens in a new TermDeck tab`;
      const spacer = document.createElement("span");
      spacer.className = "tree-file-spacer";
      const fileName = String(file.path).split("/").pop() || "";
      fileRow.append(spacer, this.fileTypeIconEl(fileName, "tree-type-icon"));
      const name = document.createElement("span");
      name.className = "tree-name search-file-name";
      this.appendSearchHighlightedText(name, fileName, query, { caseSensitive: this.nameSearchCase, fuzzy: true });
      fileRow.appendChild(name);
      this.appendMtime(fileRow, file);
      this.appendGitStatus(fileRow, file);
      fileRow.onclick = () => this.openFile(root, file.path, null, null, { fromFilePanel: true, preview: true });
      fileRow.ondblclick = () => this.openFile(root, file.path, null, null, { fromFilePanel: true, pinned: true });
      fileRow.onauxclick = (event) => this.handleFileDeckAuxClick(event, root, file.path);
      fileRow.oncontextmenu = (event) => this.openFileDeckRowContextMenu(event, root, file.path);
      fileRow.onmouseenter = () => this.selectFileSearchResult("name", fileRow, { reveal: false });
      container.appendChild(fileRow);
    }
  }

  async openNameDirectory(root, relPath) {
    if (this.sideView !== "project") this.setSideView("project");
    if (this.treeRoot !== root) await this.reloadTree(root);
    this.setExplorerMode("tree");
    let rel = "";
    for (const part of relPath.split("/").filter(Boolean)) {
      rel = rel ? `${rel}/${part}` : part;
      const row = this.$("files-tree").querySelector(`[data-rel="${CSS.escape(rel)}"]`);
      if (!row) return;
      if (rel !== relPath && !row.classList.contains("open")) await this.toggleDir(row, rel);
      if (rel === relPath) this.markTreeSelection(row);
    }
  }

  cssVar(name) {
    return getComputedStyle(document.body).getPropertyValue(name).trim();
  }

  formatKb(kb) {
    return kb >= 1048576 ? (kb / 1048576).toFixed(1) + "G" : Math.round(kb / 1024) + "M";
  }

  async pollStats() {
    if (!this.settings.show_stats) return;
    let data;
    try {
      const query = this.activeId ? `?session_id=${encodeURIComponent(this.activeId)}` : "";
      const res = await fetch(`/api/stats${query}`);
      if (!res.ok) return;
      data = await res.json();
    } catch (err) {
      return;
    }
    this.statHistory.push({ cpu: data.app.cpu, rss: data.app.rss_kb });
    if (this.statHistory.length > STAT_HISTORY_MAX) this.statHistory.shift();
    const active = data.sessions[this.activeId];
    const parts = [];
    if (active) parts.push(`term ${this.formatKb(active.rss_kb)} · ${active.cpu.toFixed(0)}%`);
    parts.push(`app ${this.formatKb(data.app.rss_kb)} · ${data.app.cpu.toFixed(0)}%`);
    this.$("stat-text").textContent = parts.join("   ");
    this.drawSparkline();
  }

  drawSparkline() {
    const canvas = this.$("stat-spark");
    const ctx = canvas.getContext("2d");
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (this.statHistory.length < 2) return;
    const maxCpu = Math.max(100, ...this.statHistory.map((p) => p.cpu));
    const maxRss = Math.max(1, ...this.statHistory.map((p) => p.rss));
    const step = w / (STAT_HISTORY_MAX - 1);
    ctx.strokeStyle = this.cssVar("--dim");
    ctx.lineWidth = 1;
    ctx.beginPath();
    this.statHistory.forEach((p, i) => {
      const x = w - (this.statHistory.length - 1 - i) * step, y = h - 1 - (p.rss / maxRss) * (h - 3);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.strokeStyle = this.cssVar("--accent");
    ctx.beginPath();
    this.statHistory.forEach((p, i) => {
      const x = w - (this.statHistory.length - 1 - i) * step, y = h - 1 - (p.cpu / maxCpu) * (h - 3);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
}

// TEMPORARY debug hook for the scroll-position investigation -- read-only ground truth access to
// live view/xterm state from outside (e.g. a Playwright script), since DOM proxies like
// .xterm-viewport.scrollTop/scrollHeight do not reliably correspond to xterm's real internal
// buffer.viewportY/baseY in V2 scroll mode. Remove once that investigation concludes.
window.__td = new TermdeckApp();
window.__td.init();
