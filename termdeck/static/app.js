// Status/title/processing changes arrive through /ws/status. This slower
// fallback only reconciles session-list metadata such as created/closed tabs.
const SESSION_LIST_REFRESH_MS = 30000;
const TITLE_STATUS_RE = /^[\u2800-\u28ff○-◗⏳⚡✳](\s+)/;
const RECONNECT_MS = 1500;
const DEFAULT_COMMAND = "codex";
const DEFAULT_CWD = "~";
const SETTINGS_DEFAULTS = { sidebar_width: 250, files_width: 380, sidebar_font_size: 13, terminal_font_size: 13,
  ui_font_size: 11, code_font_size: 12, diff_font_size: 13, tree_font_size: 12, active_session_id: "", open_files: [], project_state: {}, theme: "dark",
  ignored_dirs: [], hide_excluded: true, hide_dot_folders: true, file_tree_sort: "name", side_split: 0.55, side_full: false, side_split_user_set: false, show_stats: true,
  show_mtime: true, show_git_status: true, recent_exclude: "", word_wrap: false, search_glob: "!*.json, !*.csv, !*.log", keybindings: {},
  last_command: "codex", last_model: "codex", last_permissions: { codex: "default", claude: "default", agy: "default", none: "default" },
  show_terminal_icons: false, history_mode: false, notebook_open: false, notebook_left: -1, notebook_text: "", prompt_history: {}, selection_copy_history: [],
  notebook_notes: [], notebook_active_note_id: "", notebook_notes_initialized: false,
  files_pinned: false, show_terminal_age: true, sidebar_text_color: "#d5dbe5", vscode_keybindings: {}, prompt_wrap_guard: false };
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
const TERMINAL_SEARCH_DEBOUNCE_MS = 250;
const SEARCH_HISTORY_STORAGE_KEY = "termdeck.search_history";
const SEARCH_HISTORY_RECORD_DELAY_MS = 3000;
const PROMPT_DRAFT_SYNC_PASTE_DELAY_MS = 250;
const FILE_AUTOSAVE_DELAY_MS = 500;
const SESSION_GROUP_HOVER_DELAY_MS = 700;
const CLOSED_SESSIONS_INITIAL_DISPLAY = 50;
const CLOSED_SESSIONS_MAX_DISPLAY = 100;
const ACTIVITY_SORT_BUCKET_MS = 15 * 60 * 1000;
const TERMINAL_AGE_REFRESH_MS = 30000;
const TERMINAL_AGE_DAY_MS = 24 * 60 * 60 * 1000;
const TERMINAL_AGE_WEEK_MS = 7 * TERMINAL_AGE_DAY_MS;
const TERMINAL_AGE_INTERMEDIATE_FADE = 0.48;
const TERMINAL_GROUP_AGE_BRIGHTNESS = [1, 0.9, 0.8];
const TERMINAL_TAIL_REPAIR_LINES = 16;
const TERMINAL_ACTIVATION_REFLOW_IDLE_MS = 1200;
const OPEN_FILES_MAX_ENTRIES = 80;
const TERMINAL_V2_FIT_RETRY_LIMIT = 32;
const TERMINAL_V2_FIT_RETRY_DELAY_MS = 140;
// Three checks, well spread out, not five packed inside the first 600ms: only a genuine geometry change
// sends a pty resize, so a tight burst cannot interrupt an agent CLI's multi-line composer redraw.
const TERMINAL_ACTIVE_SETTLE_DELAYS_MS = [150, 800, 2000];
const PROMPT_WRAP_GUARD_IDLE_MS = 1200;
const TERMINAL_DEBUG_SNAPSHOT_LIMIT = 50;
const SELECTION_SEARCH_MAX_CHARS = 1000;
const TERMINAL_CLAUDE_IDLE_RECONNECT_MS = 5 * 60 * 1000;
const CODEX_PROMPT_REFLOW_GUARD_MS = 1800;
// Files viewer, file search, and terminal search share one files-section panel and one shortcut.
const FILES_SIDE_PANEL_TABS = ["project", "search", "terminal-search"];
const DESKTOP_KEYBINDINGS = [
  { id: "new-terminal", label: "New terminal", def: "Meta+b" },
  { id: "close-item", label: "Close active terminal / file", def: "Meta+Shift+Backspace" },
  { id: "fork-terminal", label: "Fork active terminal", def: "Meta+Shift+b" },
  { id: "restart-terminal", label: "Restart active terminal", def: "Meta+Alt+r" },
  { id: "rename-terminal", label: "Rename active terminal", def: "Alt+r" },
  { id: "copy-session-id", label: "Copy active session id", def: "Alt+i" },
  { id: "mark-terminal-unread", label: "Mark active terminal as unread", def: "Alt+u" },
  { id: "create-terminal-group-from-active", label: "Create group from active terminal", def: "Alt+Shift+g" },
  { id: "move-active-to-top", label: "Move active terminal / group to top", def: "Alt+t" },
  { id: "open-move-menu", label: "Open active terminal Move to menu", def: "Alt+m" },
  { id: "save-file", label: "Save open file", def: "Meta+s" },
  { id: "prev-terminal", label: "Previous terminal", def: "Meta+Alt+ArrowUp" },
  { id: "next-terminal", label: "Next terminal", def: "Meta+Alt+ArrowDown" },
  { id: "cycle-side-panel", label: "Files / Search / Terminal search (4th press closes)", def: "Meta+Shift+f" },
  { id: "view-terminals", label: "Terminals view", def: "Meta+Shift+t" },
  { id: "switch-project", label: "Switch project", def: "Alt+s" },
  { id: "toggle-notebook", label: "Quick notebook", def: "Alt+n" },
  { id: "selection-copy", label: "Copy selected terminal / Markdown text", def: "Meta+c" },
  { id: "selection-note-new", label: "Create note from selected text", def: "Meta+Alt+n" },
  { id: "selection-note-append", label: "Append selected text to note", def: "Meta+Alt+Shift+n" },
  { id: "selection-copy-history", label: "Open copied text history", def: "Meta+Shift+v" },
  { id: "toggle-history", label: "Switch terminal / Markdown transcript", def: "Alt+g" },
  { id: "scroll-bottom", label: "Scroll terminal / transcript to bottom", def: "Meta+Shift+ArrowDown" },
  { id: "focus-prompt", label: "Focus active terminal / editor / Markdown prompt", def: "Alt+f" },
  { id: "show-usages", label: "Show usages of editor symbol", def: "Shift+F12" },
  { id: "select-active-input", label: "Select active terminal / editor / prompt text", def: "Alt+a" },
  { id: "select-terminal-all", label: "Select all terminal text", def: "Meta+Shift+a" },
];
const VSCODE_KEYBINDINGS = [
  { id: "new-terminal", label: "New terminal", def: "Ctrl+Alt+b" },
  { id: "close-item", label: "Close active terminal", def: "Ctrl+Alt+Backspace" },
  { id: "fork-terminal", label: "Fork active terminal", def: "Ctrl+Alt+Shift+b" },
  { id: "restart-terminal", label: "Restart active terminal", def: "Ctrl+Alt+Shift+r" },
  { id: "prev-terminal", label: "Previous terminal", def: "Ctrl+Alt+ArrowUp" },
  { id: "next-terminal", label: "Next terminal", def: "Ctrl+Alt+ArrowDown" },
  { id: "toggle-notebook", label: "Quick notebook", def: "Ctrl+Alt+n" },
  { id: "toggle-history", label: "Switch terminal / Markdown transcript", def: "Ctrl+Alt+m" },
  { id: "select-terminal-all", label: "Select all terminal text", def: "Ctrl+Alt+Shift+a" },
  { id: "vscode-refresh", label: "Refresh TermDeck", def: "Ctrl+r" },
  { id: "vscode-reload", label: "Reload TermDeck webview", def: "Ctrl+Shift+r" },
];
const REFERENCE_KEYS = [
  { keys: "⌘[ / ⌘]", label: "Browser back / forward (last-clicked navigation)" },
  { keys: "⌃⇧E", label: "Focus file-name search" },
  { keys: "⌃⇧F", label: "Focus file-content search" },
  { keys: "⌃⇧Space", label: "Open file browser/search" },
  { keys: "↑ ↓ Enter", label: "Navigate file and content search results from their search input" },
  { keys: "⌘⌫ / ⌥⌫", label: "Delete to line start / delete word (in terminal)" },
  { keys: "⌘← / ⌘→", label: "Line start / end (in terminal)" },
  { keys: "⌘A", label: "Select all terminal text" },
  { keys: "⇧F12", label: "Show usages of the editor symbol" },
  { keys: "⌃R / ⌃M / ⌘⌫", label: "Rename / move / delete selected tree file" },
  { keys: "↑ ↓ ← → Enter", label: "Navigate the file tree (when focused)" },
];
const VSCODE_REFERENCE_KEYS = [
  { keys: "⌘⇧P", label: "Open VS Code Command Palette" },
  { keys: "⌘⇧E", label: "Open VS Code Explorer" },
  { keys: "⌘W", label: "Close editor tab" },
];
function parseModeFlag(raw) {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw === 1;
  const value = String(raw || "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return false;
}
const ALWAYS_EXCLUDED = [".git", "node_modules", "__pycache__", ".venv", ".idea", "_"];
const STATS_POLL_MS = 5000;
const STAT_HISTORY_MAX = 48;
const FONT_MIN = 8, FONT_MAX = 32;
const RECENT_FILES_REFRESH_MS = 5000;
const FILE_TREE_WS_ROUTE = "/ws/files";
const FILE_TREE_CHANGED = "file_tree_changed";
const QUERY_RESPONSE_RE = /^\x1b\[[?>]?[\d;]*[Rc]$/;
const PATH_LINK_RE = /(?:~\/|\.{1,2}\/|\/)?[\w@%+=.-]+(?:\/[\w@%+=.-]+)*\.[A-Za-z][A-Za-z0-9]{0,7}(?::\d+){0,2}/g;
const KNOWN_EXTS = new Set(["py", "md", "json", "js", "ts", "tsx", "css", "html", "sh", "zsh", "txt", "yaml", "yml",
  "toml", "csv", "log", "plist", "sql", "xml", "ini", "cfg", "lock", "ipynb", "rs", "go", "c", "h", "cpp", "hpp", "java"]);
const MATERIAL_ICONS_BASE = "/static/vendor/material-icons/icons/";
const MATERIAL_ICONS_MAP_URL = "/static/vendor/material-icons/dist/material-icons.json";
const HAS_VSCODE_WEBVIEW_API = typeof acquireVsCodeApi === "function";
const IS_VSCODE_EMBEDDED = window.parent !== window;
const HOST_HINT = String(location.host || "").toLowerCase();
const PATH_HINT = String(location.pathname || "").toLowerCase();
const LOCATION_HINT = String(location.href || "").toLowerCase();
const LOCATION_PARAMS = new URLSearchParams(location.search);
const WORKSPACE_ROOT_QUERY = LOCATION_PARAMS.get("workspace_root") || "";
if (location.hash) {
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
const TERM_THEME_DARK = {
  background: "#0a0c10", foreground: "#d8dee9", cursor: "#8fbcbb", selectionBackground: "#3b4252",
  black: "#3b4252", red: "#bf616a", green: "#a3be8c", yellow: "#ebcb8b",
  blue: "#81a1c1", magenta: "#b48ead", cyan: "#88c0d0", white: "#e5e9f0",
  brightBlack: "#4c566a", brightRed: "#bf616a", brightGreen: "#a3be8c", brightYellow: "#ebcb8b",
  brightBlue: "#81a1c1", brightMagenta: "#b48ead", brightCyan: "#8fbcbb", brightWhite: "#eceff4",
};
const TERM_THEME_LIGHT = {
  background: "#ffffff", foreground: "#1f2328", cursor: "#0969da", selectionBackground: "#b6d7fb",
  black: "#24292f", red: "#cf222e", green: "#116329", yellow: "#4d2d00",
  blue: "#0969da", magenta: "#8250df", cyan: "#1b7c83", white: "#6e7781",
  brightBlack: "#57606a", brightRed: "#a40e26", brightGreen: "#1a7f37", brightYellow: "#633c01",
  brightBlue: "#218bff", brightMagenta: "#a475f9", brightCyan: "#3192aa", brightWhite: "#8c959f",
};

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
    this.views = new Map();
    this.openFiles = new Map();
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
    this.historyLiveTurnsBySession = new Map();
    this.historyOlderTurnsBySession = new Map();
    this.historyBeforeBySession = new Map();
    this.historyHasMoreBySession = new Map();
    this.historyOlderLoadBusy = false;
    this.historyStreamFresh = false;
    this.historyRevisions = new Map();
    this.historyPendingPrompts = new Map();
    this.historyPendingPromptSequence = 0;
    this.historyFingerprint = "";
    this.historyTurns = [];
    this.historyLoaded = false;
    this.historyEditsCollapsed = false;
    this.closedExpanded = false;
    this.closedDisplayLimit = CLOSED_SESSIONS_INITIAL_DISPLAY;
    this.settings = { ...SETTINGS_DEFAULTS };
    this.saveTimer = null;
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
    this.recentFiles = [];
    this.recentFilesRoot = null;
    this.recentFilesFingerprint = "";
    this.recentFilesBusy = false;
    this.recentFilesFetchedAt = 0;
    this.recentFilesExpanded = false;
    this.sideView = "terminals";
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
    this.historySearchResults = [];
    this.historySearchOperations = false;
    this.terminalSearchGroupSimilar = false;
    this.terminalSearchAbort = null;
    this.terminalSearchTimer = 0;
    this.nameSearchGeneration = 0;
    this.applyingHistory = false;
    this.lastNavJson = "";
    this.activitySort = false;
    this.sessionActivityAt = new Map();
    this.activitySortRenderTimer = 0;
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
    this.revealActiveSessionOnLoad = true;
    this.processingStates = new Map();
    this.processingSince = new Map();
    // A prompt can be accepted by the PTY before the agent reports
    // processing=true. Keep that hand-off visible in Markdown mode.
    this.historyPendingProcessing = new Map();
    this.processingTimer = 0;
    this.viewedCompletedSessions = new Set();
    this.unreadSessions = new Set();
    this.statHistory = [];
    this.editor = null;
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
    this.nativeSessionIds = new Set();
    this.sessionModelById = new Map();
    this.selectedTreeRow = null;
    this.iconMap = null;
    this.lastValidNavState = null;
    this.statusWs = null;
    this.statusWsReconnectTimer = 0;
    this.layoutFitSettleTimer = 0;
    this.activeEditorFocusTimer = 0;
    this.projects = [];
    const projectMatch = location.pathname.match(/^\/p\/([^/]+)/);
    this.projectSlug = projectMatch ? decodeURIComponent(projectMatch[1])
      : this.vscodeEditorMode ? (LOCATION_PARAMS.get("project") || null) : null;
    const urlParams = new URLSearchParams(location.search);
    if (urlParams.get("t")) this.initialNav = { kind: "term", id: urlParams.get("t") };
    else if (urlParams.get("f")) {
      this.initialNav = {
        kind: "file",
        key: urlParams.get("f"),
        return_to: String(urlParams.get("rt") || "").trim(),
      };
    }
    else if (urlParams.get("q")) {
      this.initialNav = { kind: "search", q: urlParams.get("q"), glob: urlParams.get("glob") || "",
                          word: urlParams.get("w") === "1", case_sensitive: urlParams.get("c") === "1",
                          regex: urlParams.get("re") === "1" };
    } else this.initialNav = null;
    this.$ = (id) => document.getElementById(id);
    this.ensureDesktopTerminalsHeader();
    this.applyVscodeModeLayout();
  }

  projectQuery() {
    return this.projectSlug ? `?project=${encodeURIComponent(this.projectSlug)}` : "";
  }

  applyVscodeModeLayout() {
    document.body.classList.toggle("vscode-mode", this.vscodeMode);
    document.body.classList.toggle("vscode-native-mode", this.nativeVscodeMode);
    document.body.classList.toggle("vscode-editor-mode", this.vscodeEditorMode);
    if (!this.vscodeMode) return;
    const forceHidden = ["active-toggle", "terminal-search-toggle",
      "view-project", "view-search", "files-section", "side-split", "project-select", "project-select-label"];
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

  projectStateKey() {
    return this.projectSlug || "__all__";
  }

  getProjectState() {
    const states = this.settings.project_state || {};
    return states[this.projectStateKey()] || {
      active_session_id: "", open_files: [], open_files_collapsed: false, recent_files_collapsed: false,
      unread_sessions: [],
      terminal_groups: [], session_groups: {},
    };
  }

  patchProjectState(patch) {
    const states = this.settings.project_state || {};
    states[this.projectStateKey()] = { ...this.getProjectState(), ...patch };
    this.settings.project_state = states;
    this.saveSettings();
  }

  sectionCollapsed(field) {
    const storageKey = `termdeck.${this.projectStateKey()}.${field}`;
    try {
      const stored = window.localStorage.getItem(storageKey);
      if (stored === "1" || stored === "0") return stored === "1";
    } catch (error) {
      // localStorage can be unavailable in restricted webviews; use settings below.
    }
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
    this.setSectionCollapsed(field, !this.sectionCollapsed(field));
    this.renderList();
  }

  terminalGroups() {
    return (this.getProjectState().terminal_groups || [])
      .filter((group) => group && group.id && String(group.name || "").trim())
      .map((group) => ({ id: String(group.id), name: String(group.name).trim(), collapsed: !!group.collapsed }));
  }

  createTerminalGroup() {
    const name = prompt("Name for the terminal group", "New group");
    if (!name || !name.trim()) return;
    const groups = this.terminalGroups();
    const group = { id: `group-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: name.trim(), collapsed: false };
    this.patchProjectState({ terminal_groups: [...groups, group] });
    this.renderList();
  }

  renameTerminalGroup(groupId) {
    const group = this.terminalGroups().find((candidate) => candidate.id === groupId);
    if (!group) return;
    const name = prompt("Rename terminal group", group.name);
    if (!name || !name.trim() || name.trim() === group.name) return;
    const groups = this.terminalGroups().map((candidate) => candidate.id === groupId
      ? { ...candidate, name: name.trim() } : candidate);
    this.patchProjectState({ terminal_groups: groups });
    this.renderList();
  }

  deleteTerminalGroup(groupId) {
    const group = this.terminalGroups().find((candidate) => candidate.id === groupId);
    if (!group || !confirm(`Delete group "${group.name}"? Terminals will remain ungrouped.`)) return;
    const state = this.getProjectState();
    const sessionGroups = { ...(state.session_groups || {}) };
    for (const [sessionId, assignedGroupId] of Object.entries(sessionGroups)) {
      if (assignedGroupId === groupId) delete sessionGroups[sessionId];
    }
    this.patchProjectState({
      terminal_groups: this.terminalGroups().filter((candidate) => candidate.id !== groupId),
      session_groups: sessionGroups,
    });
    this.renderList();
  }

  toggleTerminalGroup(groupId) {
    const current = this.terminalGroups().find((group) => group.id === groupId);
    if (!current) return;
    const collapsed = !current.collapsed;
    const groups = this.terminalGroups().map((group) => group.id === groupId
      ? { ...group, collapsed } : group);
    this.patchProjectState({ terminal_groups: groups });
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
    return Object.entries(sessionGroups)
      .filter(([, assignedGroupId]) => assignedGroupId === groupId)
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
    this.patchProjectState(patch);
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
    const orderedIds = this.sidebarSessionIdsInRenderOrder();
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
    const selected = this.sidebarSelectedSessionIds.has(sessionId)
      ? [...this.sidebarSelectedSessionIds]
      : [sessionId];
    const order = new Map(this.sidebarSessionIdsInRenderOrder().map((id, index) => [id, index]));
    return [...new Set(selected)]
      .filter((id) => !!this.session(id))
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
    const order = this.sessions.map((session) => session.session_id).filter((id) => !selected.has(id));
    const targetIndex = order.indexOf(targetId);
    if (targetIndex < 0) return order;
    order.splice(targetIndex + (after ? 1 : 0), 0, ...selectedIds);
    return order;
  }

  moveSelectedSessionsIntoGroup(sessionIds, groupId, targetId = null, after = false) {
    const ids = [...new Set(sessionIds)].filter((id) => !!this.session(id));
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
    this.patchProjectState(patch);
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
    const ids = [...new Set(sessionIds)].filter((id) => !!this.session(id) && id !== targetId);
    const target = this.session(targetId);
    if (!ids.length || !target) return;
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
    this.patchProjectState({
      session_groups: sessionGroups,
      terminal_layout: layout,
      session_order: this.sessionOrderWithSelectedIdsAroundTarget(ids, targetId, after),
    });
    this.sessions = this.applySessionOrder(this.sessions);
    this.renderList();
  }

  groupSelectedSessionsFromDrop(sessionIds, targetId, after = false) {
    const ids = [...new Set(sessionIds)].filter((id) => !!this.session(id) && id !== targetId);
    const target = this.session(targetId);
    if (!ids.length || !target) return;
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
    this.patchProjectState({
      terminal_groups: [...this.terminalGroups(), group],
      session_groups: nextSessionGroups,
      terminal_layout: layout,
      session_order: this.sessionOrderWithSelectedIdsAroundTarget(ids, targetId, after),
    });
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
    this.patchProjectState(patch);
    this.sessions = this.applySessionOrder(this.sessions);
    this.renderList();
  }

  terminalLayout() {
    const state = this.getProjectState();
    const groups = this.terminalGroups();
    const groupIds = new Set(groups.map((group) => group.id));
    const sessionIds = new Set(this.sessions.map((session) => session.session_id));
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
        : this.sessions.map((session) => session.session_id);
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
    for (const session of this.sessions) add(`session:${session.session_id}`);
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
    this.patchProjectState({
      terminal_layout: [...top, ...layout.filter((entry) => !legacyTokens.has(entry))],
      pinned_sessions: [],
      pinned_groups: [],
    });
  }

  moveTerminalLayoutToTop(token) {
    const current = this.terminalLayout();
    if (!current.includes(token)) return;
    const layout = current.filter((entry) => entry !== token);
    layout.unshift(token);
    this.patchProjectState({ terminal_layout: layout });
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
    this.patchProjectState(patch);
    this.renderList();
  }

  reorderGroupedSessions(draggedId, targetId, after = false) {
    const ids = this.sessions.map((session) => session.session_id).filter((id) => id !== draggedId);
    const targetIndex = ids.indexOf(targetId);
    if (targetIndex < 0) return;
    ids.splice(targetIndex + (after ? 1 : 0), 0, draggedId);
    this.patchProjectState({ session_order: ids });
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
    this.patchProjectState({
      terminal_groups: groups.filter((group) => group.id !== sourceId),
      session_groups: sessionGroups,
      terminal_layout: this.terminalLayout().filter((entry) => entry !== `group:${sourceId}`),
    });
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
    this.patchProjectState({ terminal_groups: [...this.terminalGroups(), group], session_groups: sessionGroups,
      terminal_layout: layout });
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
    this.patchProjectState({
      terminal_groups: [...this.terminalGroups(), group],
      session_groups: sessionGroups,
      terminal_layout: nextLayout,
    });
    this.renderList();
  }

  removeTerminalGroup(groupId) {
    const group = this.terminalGroups().find((candidate) => candidate.id === groupId);
    if (!group) return;
    const state = this.getProjectState();
    const sessionGroups = { ...(state.session_groups || {}) };
    for (const [sessionId, assignedGroupId] of Object.entries(sessionGroups)) {
      if (assignedGroupId === groupId) delete sessionGroups[sessionId];
    }
    this.patchProjectState({
      terminal_groups: this.terminalGroups().filter((candidate) => candidate.id !== groupId),
      session_groups: sessionGroups,
    });
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
    await Promise.all(sessions.map((session) => fetch(`/api/sessions/${session.session_id}`, { method: "DELETE" })));
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
    this.addContextItem(menu, this.shortcutLabel("Close all terminals", "close-item"),
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
  }

  projectRoot() {
    const p = this.projects.find((x) => x.name === this.projectSlug);
    return p ? p.root : null;
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

  populateModalProjects() {
    const select = this.$("modal-project");
    if (!select) return;
    const cwd = this.resolveVscodeDefaultCwd();
    const currentProject = this.projects.find((project) => project.name === this.projectSlug);
    const preferred = currentProject || this.projectForCwd(cwd);
    select.textContent = "";
    for (const project of this.projects) {
      const option = document.createElement("option");
      option.value = project.name;
      option.textContent = `${project.name} · ${this.compactProjectPath(project.root)}`;
      option.title = project.root;
      select.appendChild(option);
    }
    const custom = document.createElement("option");
    custom.value = "";
    custom.textContent = "Choose folder…";
    select.appendChild(custom);
    select.value = preferred?.name || "";
    select.disabled = !!this.modalGroupId;
    this.syncModalProjectCwd();
  }

  syncModalProjectCwd() {
    const select = this.$("modal-project");
    const cwdInput = this.$("modal-cwd");
    if (!select || !cwdInput) return;
    const project = this.projects.find((candidate) => candidate.name === select.value);
    if (project) {
      cwdInput.value = project.root;
      cwdInput.readOnly = true;
      cwdInput.dataset.projectSeeded = "1";
      return;
    }
    if (cwdInput.dataset.projectSeeded === "1") cwdInput.value = this.resolveVscodeDefaultCwd();
    cwdInput.readOnly = false;
    cwdInput.dataset.projectSeeded = "0";
  }

  async chooseProjectFolder() {
    if (this.vscodeMode) return;
    const button = this.$("modal-project-add-btn");
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
      const cwdInput = this.$("modal-cwd");
      if (cwdInput) {
        cwdInput.value = project.root || "";
        cwdInput.dataset.projectSeeded = "1";
      }
    } catch (error) {
      alert(error.message || "failed to choose project folder");
    } finally {
      if (button) button.disabled = false;
    }
  }

  async init() {
    window.addEventListener("message", this.handleHostMessageBound, false);
    window.addEventListener("pagehide", () => {
      this.flushPendingFileSavesOnPageExit();
      this.flushPendingSearchHistoryRecord();
    });
    window.addEventListener("beforeunload", () => {
      this.flushPendingFileSavesOnPageExit();
      this.flushPendingSearchHistoryRecord();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        this.flushPendingFileSavesOnPageExit();
        this.flushPendingSearchHistoryRecord();
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
      [{ label: "Sidebar font", key: "sidebar_font_size" }, { label: "Terminal font", key: "terminal_font_size" },
       { label: "UI font", key: "ui_font_size" }, { label: "Code font", key: "code_font_size" },
       { label: "Diff font", key: "diff_font_size" }, { label: "Tree/search font", key: "tree_font_size" },
       { label: "Sidebar text color", key: "sidebar_text_color", type: "color" }]);
    this.$("file-view-close").onclick = () => this.navigateBackFromActiveFile();
    this.$("file-history-toggle").onclick = () => this.toggleFileHistory();
    this.$("file-history-close").onclick = () => this.closeFileHistory();
    this.$("file-history-git-toggle").onclick = () => this.toggleFileHistoryMode();
    this.$("file-history-diff-previous").onclick = () => this.navigateFileHistoryDiff(-1);
    this.$("file-history-diff-next").onclick = () => this.navigateFileHistoryDiff(1);
    this.$("file-history-diff-undo-block").onclick = () => this.undoFileHistoryDiffBlock();
    this.$("file-history-diff-undo-line").onclick = () => this.undoFileHistoryDiffLine();
    this.initNotebook();
    this.initSelectionActions();
    for (const view of ["terminals", "project", "search"]) {
      this.$("view-" + view).onclick = () => {
        if (view === "search" && this.searchContentFromSelection()) return;
        if (view === "project" && this.searchFileFromSelection()) return;
        this.setSideView(view);
      };
    }
    for (const [view, id] of [["project", "files-tab-project"], ["search", "files-tab-search"],
      ["terminal-search", "files-tab-terminal-search"]]) {
      const button = this.$(id);
      if (!button) continue;
      button.onclick = () => {
        if (view === "search" && this.searchContentFromSelection()) return;
        if (view === "project" && this.searchFileFromSelection()) return;
        this.setSideView(view, false);
      };
    }
    const replaceToggle = this.$("replace-toggle");
    replaceToggle.onclick = () => {
      const bar = this.$("replace-bar");
      bar.classList.toggle("hidden");
      replaceToggle.classList.toggle("on", !bar.classList.contains("hidden"));
    };
    this.$("view-terminals").classList.add("on");
    this.$("vscode-refresh-btn").onclick = () => this.requestVscodeRefresh(false);
    this.$("modal-project-add-btn").onclick = () => this.chooseProjectFolder();
    this.$("modal-cwd").addEventListener("input", () => {
      this.$("modal-cwd").dataset.projectSeeded = "0";
    });
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
    const globInput = this.$("search-glob");
    globInput.autocomplete = "off";
    globInput.autocapitalize = "off";
    globInput.autocorrect = "off";
    globInput.value = this.settings.search_glob || "";
    globInput.addEventListener("input", () => {
      this.settings.search_glob = globInput.value;
      this.saveSettings();
      this.debouncedSearch();
    });
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
    this.$("reveal-toggle").onclick = () => this.revealActiveFile();
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
    const hideDotBtn = this.$("hide-dot-toggle");
    this.updateHideDotButton();
    hideDotBtn.onclick = () => this.toggleHideDotFolders();
    this.$("files-pin-toggle").onclick = () => this.toggleFilesPinned();
    this.updateFilesPinButton();
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
      setInterval(() => this.refreshRecentFiles(), RECENT_FILES_REFRESH_MS);
      this.terminalAgeRefreshTimer = window.setInterval(() => {
        this.updateSessionAgeStyles();
        this.updateActiveTerminalAge();
      }, TERMINAL_AGE_REFRESH_MS);
    }
    setInterval(() => this.pollStats(), STATS_POLL_MS);
    this.pollStats();
    document.addEventListener("mousedown", (e) => {
      for (const id of ["settings-popover", "context-menu"]) {
        const pop = this.$(id);
        if (!pop.classList.contains("hidden") && !pop.contains(e.target)) {
          pop.classList.add("hidden");
          if (id === "context-menu") this.contextMenuTarget = null;
        }
      }
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
      const notebookPanel = this.$("notebook-panel");
      const notebookToggle = this.$("notebook-toggle");
      if (this.settings.notebook_open && notebookPanel && !notebookPanel.contains(e.target) &&
          !notebookToggle?.contains(e.target)) this.setNotebookOpen(false, { focus: false });
      const fileHistoryPanel = this.$("file-history-panel");
      const fileHistoryToggle = this.$("file-history-toggle");
      if (this.fileHistoryOpen && fileHistoryPanel && !fileHistoryPanel.contains(e.target) &&
          !fileHistoryToggle?.contains(e.target)) this.closeFileHistory();
    });
    this.$("terminal-search-toggle").onclick = () => this.setSideView("terminal-search");
    this.$("terminal-search-submit").onclick = () => {
      clearTimeout(this.terminalSearchTimer);
      this.runTerminalSearch();
    };
    this.$("terminal-search-group-toggle").onclick = () => {
      this.terminalSearchGroupSimilar = !this.terminalSearchGroupSimilar;
      this.updateTerminalSearchGroupButton();
      this.renderTerminalHistoryResults();
    };
    this.$("terminal-search-input").addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); clearTimeout(this.terminalSearchTimer); this.runTerminalSearch(); }
      if (event.key === "Escape") {
        event.preventDefault();
        if (!this.closeUnpinnedFilesPanelAndFocusEditor()) this.clearTerminalSearch();
      }
    });
    this.$("history-search-close").onclick = () => this.closeHistorySearchContext();
    this.$("history-search-open").onclick = () => this.openHistorySearchSession();
    this.$("history-search-backdrop").onclick = (event) => {
      if (event.target === this.$("history-search-backdrop")) this.closeHistorySearchContext();
    };
    this.$("modal-cancel").onclick = () => this.closeModal();
    this.$("modal-create").onclick = () => this.createSession();
    this.$("modal-model").onchange = () => this.updateModalPermissions();
    for (const id of ["history-btn", "vscode-history-btn"]) {
      const button = this.$(id);
      if (button) button.onclick = () => this.toggleHistory();
    }
    this.updateShortcutTitles();
    this.$("history-edits-toggle").onclick = () => this.toggleHistoryEdits();
    this.$("history-scroll-bottom").onclick = () => this.scrollHistoryToBottom();
    this.$("history-body").addEventListener("scroll", () => {
      if (this.historyOpen && this.$("history-body").scrollTop < 80) this.loadOlderHistory();
    });
    this.$("history-body").addEventListener("click", (event) => this.handleVscodeFileLink(event));
    for (const id of ["terminal-resync-btn", "vscode-terminal-resync-btn"]) {
      const button = this.$(id);
      if (button) button.onclick = () => this.resyncActiveTerminal();
    }
    this.$("history-attach").onclick = () => this.attachToHistory();
    this.$("history-reveal-session-btn").onclick = () => this.revealAndFocusActiveTerminalInSidebar();
    this.$("history-send").onclick = () => this.sendHistoryPrompt();
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
        if (this.session(this.activeId)?.agent_kind !== "codex") return;
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
    this.$("history-prompt").addEventListener("input", () => {
      const view = this.views.get(this.activeId);
      if (!view) return;
      this.markPromptWrapActivity(view);
      view.promptSubmitEntered = false;
      view.promptSubmitting = false;
      clearTimeout(view.promptSubmitTimer);
      view.promptEditing = true;
      view.promptEditVersion += 1;
      view.promptDraft = this.$("history-prompt").value;
      this.syncPromptToTerminal(view, { writeToTerminal: false });
      this.resizeHistoryPrompt();
    });
    this.$("attach-btn").onclick = () => this.attachToActive();
    this.$("reveal-session-btn").onclick = () => this.revealAndFocusActiveTerminalInSidebar();
    for (const id of ["scroll-bottom-btn", "vscode-scroll-bottom-btn"]) {
      const button = this.$(id);
      if (button) button.onclick = () => this.scrollActiveToBottom();
    }
    this.$("keys-btn").onclick = () => this.openKeybindings();
    this.$("keys-done").onclick = () => this.$("keys-backdrop").classList.add("hidden");
    this.$("keys-reset").onclick = () => this.resetKeybindings();
    this.$("keys-backdrop").addEventListener("mousedown", (e) => { if (e.target.id === "keys-backdrop") this.$("keys-backdrop").classList.add("hidden"); });
    this.$("modal-backdrop").addEventListener("mousedown", (e) => {
      if (e.target.id === "modal-backdrop") this.closeModal();
    });
    document.addEventListener("keydown", (e) => {
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
    document.addEventListener("keydown", (e) => {
      if (!this.$("keys-backdrop").classList.contains("hidden")) {
        if (e.key === "Escape") this.$("keys-backdrop").classList.add("hidden");
        return;
      }
      const modalOpen = !this.$("modal-backdrop").classList.contains("hidden");
      if (modalOpen) {
        if (e.key === "Escape") this.closeModal();
        if (e.key === "Enter") this.createSession();
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
      if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "a" &&
          e.target.closest && e.target.closest(".xterm") && this.activeFileKey === null && !this.historyOpen) {
        e.preventDefault();
        e.stopPropagation();
        this.selectActiveTerminalText();
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
    window.addEventListener("popstate", (e) => this.applyNavState(e.state));
    const startupNav = this.initialNav && this.initialNav.kind !== "file" ? this.initialNav : { kind: "init" };
    this.lastValidNavState = startupNav;
    this.lastNavJson = JSON.stringify(startupNav);
    history.replaceState(startupNav, "", location.pathname + location.search);
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
    this.refresh().finally(() => this.connectStatusStream());
    setInterval(() => this.refresh(), SESSION_LIST_REFRESH_MS);
  }

  navUrl(state) {
    const params = new URLSearchParams();
    if (state.kind === "term") params.set("t", state.id);
    else if (state.kind === "file") {
      params.set("f", state.key);
      if (state.return_to) params.set("rt", String(state.return_to));
    }
    else if (state.kind === "search") {
      params.set("q", state.q);
      if (state.glob) params.set("glob", state.glob);
      if (state.word) params.set("w", "1");
      if (state.case_sensitive) params.set("c", "1");
      if (state.regex) params.set("re", "1");
    }
    const qs = params.toString();
    return location.pathname + (qs ? "?" + qs : "");
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

  applyNavState(state) {
    if (!state || state.kind === "init") return;
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
        this.$("search-glob").value = state.glob || "";
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
    let sessions, closed;
    try {
      const [sessionsRes, closedRes] = await Promise.all(
        [fetch("/api/sessions" + this.projectQuery()), fetch("/api/closed" + this.projectQuery())]);
      sessions = await sessionsRes.json();
      closed = await closedRes.json();
    } catch (err) {
      return;
    }
    const previousSessionListSignature = this.sessionListSignature;
    this.sessions = this.applySessionOrder(sessions);
    this.closedSessions = closed;
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
    if (!this.vscodeMode) this.refreshRecentFiles();
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

  applySessionStatus(message) {
    const session = this.session(message.session_id);
    if (!session) return;
    const previousAgentSessionId = session.agent_session_id;
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
    if (message.processing === true) this.touchSessionActivity(session.session_id);
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
    this.cacheSessionModel(session);
    const presentation = this.titlePresentation(session);
    const spinning = !session.dormant && session.processing === true;
    const titleEl = this.sessionTitleEls.get(session.session_id);
    if (titleEl) this.setSessionTitleText(titleEl, presentation.text,
      this.usesTextTerminalStatus() && presentation.spinning);
    this.postVscodeNativeSession(session, session.session_id === this.activeId ? !this.historyOpen : undefined);
    this.updateProcessingState(session.session_id, spinning);
    // The initial session list is rendered before the status websocket sends
    // its snapshot. Keep the row's running/dormant dot in sync with the
    // session object as soon as that snapshot arrives; selecting the row
    // should not be required to repaint it.
    this.updateSessionRows();
    if (session.session_id === this.activeId) {
      if (this.historyOpen && previousAgentSessionId !== session.agent_session_id) {
        this.connectHistoryStream(session.session_id, { fresh: true });
      }
      this.renderTopbar();
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
    const textOnly = this.usesTextTerminalStatus();
    const working = textOnly && !!spinning;
    title.classList.toggle("session-title-working", working);
    title.classList.toggle("session-title-unread", textOnly && !working && this.unreadSessions.has(id));
    const session = this.session(id);
    if (!this.vscodeMode && session && !working) title.style.color = this.terminalAgeColor(session);
    else title.style.removeProperty("color");
  }

  setSessionTitleText(title, text) {
    title.textContent = text;
  }

  usesTextTerminalStatus() {
    return !this.vscodeMode && !this.settings.show_terminal_icons;
  }

  updateUnreadIndicator(id) {
    const dot = this.sessionStatusEls.get(id);
    if (dot) {
      dot.classList.toggle("processing", !!this.processingStates.get(id));
      dot.classList.toggle("unread", this.unreadSessions.has(id) && !this.processingStates.get(id));
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
      unreadDot.classList.toggle("on", attentionCount > 0);
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
    this.patchProjectState({ unread_sessions: [...this.unreadSessions] });
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
    const enabled = !!this.settings.show_terminal_icons;
    const active = enabled && (!!this.processingStates.get(id) || this.unreadSessions.has(id));
    const exited = enabled && !session.running && !session.dormant;
    icon.classList.toggle("terminal-status-active", active);
    icon.classList.toggle("terminal-status-exited", !active && exited);
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
    if (id !== this.activeId && !dormant && previous === true && !spinning &&
        !this.viewedCompletedSessions.has(id) && !this.unreadSessions.has(id)) {
      this.unreadSessions.add(id);
      this.patchProjectState({ unread_sessions: [...this.unreadSessions] });
    }
    this.processingStates.set(id, spinning);
    this.updateSessionSpinner(id, spinning);
    this.updateUnreadIndicator(id);
    this.updateHistoryThinkingIndicator();
    this.renderHistoryMeta();
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

  updateSessionRows() {
    for (const s of this.sessions) {
      const presentation = this.titlePresentation(s);
      const title = this.sessionTitleEls.get(s.session_id);
      if (title) this.setSessionTitleText(title, presentation.text,
        this.usesTextTerminalStatus() && presentation.spinning);
      const dot = this.sessionStatusEls.get(s.session_id);
      if (dot) {
        dot.className = "status-dot" + (s.running ? "" : s.dormant ? " dormant" : " exited") +
          (presentation.spinning ? " processing" : this.unreadSessions.has(s.session_id) ? " unread" : "");
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

  makeLayoutDraggable(item, token, kind) {
    item.draggable = true;
    item.ondragstart = (event) => {
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
      this.dragItem = { type: "layout", token, kind, tokens };
      this.clearDragGroupingTimer();
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", tokens.join("\n"));
    };
    item.ondragover = (event) => {
      const source = this.dragItem;
      if (!source || source.type !== "layout" || source.token === token) return;
      const sourceSessionIds = this.sessionIdsFromDragItem(source);
      const targetId = kind === "session" ? token.slice("session:".length) : null;
      if (targetId && sourceSessionIds.includes(targetId)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      if (source.kind === "session" && kind === "group") {
        this.clearDragLandingIndicator();
        item.classList.add("drop-group");
        const hint = item.querySelector(".group-drop-indicator span:last-child");
        if (hint) hint.textContent = "group";
        return;
      }
      const holdToMerge = source.kind === "group" && kind === "group";
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
        item.classList.add(event.clientY >= rect.top + rect.height / 2 ? "drop-after" : "drop-before");
        return;
      }
      if (holdToMerge || holdToCreate) {
        if (this.dragGroupTargetKey === token) {
          item.classList.remove("drop-before", "drop-after");
          item.classList.add("group-drop-target");
          return;
        }
        if (this.dragGroupHoverKey !== token) {
          this.clearDragLandingIndicator();
          if (!holdToCreate) {
            item.classList.add(event.clientY >= rect.top + rect.height / 2 ? "drop-after" : "drop-before");
          }
          this.dragGroupHoverKey = token;
          const sourceToken = source.token;
          this.dragGroupTimer = window.setTimeout(() => {
            if (this.dragItem?.type !== "layout" || this.dragItem.token !== sourceToken) return;
            this.dragGroupTargetKey = token;
            item.classList.remove("drop-before", "drop-after");
            const hint = item.querySelector(".group-drop-indicator span:last-child");
            if (hint) hint.textContent = holdToMerge ? "merge" : targetGroup || sourceGroupIds.length ? "group" : "new group";
            item.classList.add("group-drop-target");
          }, SESSION_GROUP_HOVER_DELAY_MS);
        } else if (!holdToCreate) {
          item.classList.remove("group-drop-target");
          item.classList.add(event.clientY >= rect.top + rect.height / 2 ? "drop-after" : "drop-before");
        }
        return;
      }
      this.clearDragLandingIndicator();
      item.classList.add(event.clientY >= rect.top + rect.height / 2 ? "drop-after" : "drop-before");
    };
    item.ondragleave = (event) => {
      if (!event.relatedTarget || !item.contains(event.relatedTarget)) this.clearDragLandingIndicator();
    };
    item.ondrop = (event) => {
      event.preventDefault();
      const source = this.dragItem;
      if (source?.type === "layout" && source.token !== token) {
        const sourceSessionIds = this.sessionIdsFromDragItem(source);
        const sourceId = source.token.slice(source.token.indexOf(":") + 1);
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
        else if (source.kind === "group" && kind === "group" && this.dragGroupTargetKey === token) {
          this.mergeTerminalGroups(sourceId, targetId);
        } else if (source.kind === "session" && kind === "session" && this.dragGroupTargetKey === token) {
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
    const landingClasses = ["drop-before", "drop-after", "drop-group", "group-drop-target", "drag-over"];
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
    const ids = this.sessions.map((s) => s.session_id).filter((id) => id !== draggedId);
    const targetIndex = ids.indexOf(targetId);
    if (targetIndex < 0) return;
    ids.splice(targetIndex + (after ? 1 : 0), 0, draggedId);
    this.patchProjectState({ session_order: ids });
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
      sort.classList.toggle("on", this.activitySort);
      sort.innerHTML = '<span class="codicon codicon-sort-precedence"></span>';
      sort.setAttribute("aria-pressed", String(this.activitySort));
      sort.title = this.activitySort ? "Show grouped terminals" : "Sort terminals by recent activity";
      sort.setAttribute("aria-label", sort.title);
      sort.onclick = (event) => {
        event.stopPropagation();
        this.toggleActivitySort();
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
      controls.append(sort, group, add);
      label.appendChild(controls);
    }
    return label;
  }

  ensureDesktopTerminalsHeader(list = this.$("session-list")) {
    if (this.vscodeMode || !list || list.querySelector("#new-session-btn")) return;
    const header = this.sectionLabel("terminals");
    this.attachGroupDropTarget(header, null);
    list.prepend(header);
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

  sessionActivitySortBucket(session) {
    const activity = this.sessionActivityTime(session);
    return activity > 0 ? Math.floor(activity / ACTIVITY_SORT_BUCKET_MS) : 0;
  }

  compareRecentActivityForSort(a, b) {
    return this.sessionActivitySortBucket(b) - this.sessionActivitySortBucket(a);
  }

  touchSessionActivity(sessionId, timestamp = Date.now()) {
    if (!sessionId) return;
    const previous = Number(this.sessionActivityAt.get(sessionId) || 0);
    if (timestamp <= previous) return;
    const previousBucket = previous > 0 ? Math.floor(previous / ACTIVITY_SORT_BUCKET_MS) : 0;
    const nextBucket = Math.floor(timestamp / ACTIVITY_SORT_BUCKET_MS);
    this.sessionActivityAt.set(sessionId, timestamp);
    if (this.activitySort && previousBucket !== nextBucket && !this.activitySortRenderTimer) {
      this.activitySortRenderTimer = window.setTimeout(() => {
        this.activitySortRenderTimer = 0;
        this.renderList();
      }, 180);
    }
  }

  updateActivitySortButton() {
    const button = this.$("active-toggle");
    if (!button) return;
    button.classList.toggle("on", this.activitySort);
    button.setAttribute("aria-pressed", String(this.activitySort));
    button.title = this.activitySort ? "Show grouped terminals" : "Sort terminals by recent activity";
    button.setAttribute("aria-label", button.title);
  }

  toggleActivitySort() {
    this.activitySort = !this.activitySort;
    this.updateActivitySortButton();
    this.renderList();
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

  clearTerminalSearch() {
    clearTimeout(this.terminalSearchTimer);
    if (this.terminalSearchAbort) this.terminalSearchAbort.abort();
    this.terminalSearchAbort = null;
    this.$("terminal-search-input").value = "";
    this.$("terminal-search-summary").textContent = "";
    this.$("terminal-search-results").textContent = "";
    this.historySearchResults = [];
    this.terminalSearchMatches.clear();
    this.renderList();
  }

  async runTerminalSearch() {
    const input = this.$("terminal-search-input");
    const query = input.value.trim();
    if (!query) {
      this.clearTerminalSearch();
      return;
    }
    if (this.terminalSearchAbort) this.terminalSearchAbort.abort();
    this.terminalSearchAbort = new AbortController();
    this.$("terminal-search-summary").textContent = "searching…";
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
      this.terminalSearchMatches = new Map(liveResults.map((result) => [result.session_id, result]));
      for (const result of this.historySearchResults) {
        const openSessionId = result.open_session_id || result.parent_open_session_id;
        if (!openSessionId) continue;
        this.terminalSearchMatches.set(openSessionId, {
          count: result.count, snippets: (result.matches || []).map((match) => ({ line: match.line_no, text: match.text })),
        });
      }
      const terminalCount = new Set([...liveResults.map((result) => result.session_id),
        ...this.historySearchResults.map((result) => result.open_session_id || result.parent_open_session_id).filter(Boolean)]).size;
      const matchCount = liveResults.reduce((sum, result) => sum + Number(result.count || 0), 0) +
        this.historySearchResults.reduce((sum, result) => sum + Number(result.count || 0), 0);
      const indexing = historyPayload.indexing ? " · indexing history" : "";
      const scope = this.historySearchOperations ? "all output" : "conversation";
      this.$("terminal-search-summary").textContent = terminalCount || this.historySearchResults.length
        ? `${scope} · ${terminalCount} open terminal${terminalCount === 1 ? "" : "s"} · ${matchCount} match${matchCount === 1 ? "" : "es"}${indexing}`
        : `no ${scope} matches${indexing}`;
      this.renderList();
      this.renderTerminalHistoryResults();
    } catch (error) {
      if (error.name === "AbortError") return;
      this.terminalSearchMatches.clear();
      this.historySearchResults = [];
      this.$("terminal-search-results").textContent = "";
      this.$("terminal-search-summary").textContent = error.message || "search failed";
      this.renderList();
    }
  }

  renderTerminalHistoryResults() {
    const container = this.$("terminal-search-results");
    container.textContent = "";
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

  async openHistorySearchSession() {
    const result = this.historySearchContextResult;
    if (!result) return;
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
        return;
      }
      sessionId = (await response.json()).session_id;
    }
    this.closeHistorySearchContext();
    await this.refresh();
    this.activate(sessionId, { reveal: true });
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
    icon.classList.toggle("on", !!this.settings.show_terminal_icons);
    return icon;
  }

  terminalGroupLabel(group, attentionCount = 0, working = false, members = []) {
    const label = document.createElement("div");
    label.className = "side-section-label terminal-group-label";
    const chevron = document.createElement("span");
    chevron.className = "codicon " + (group.collapsed ? "codicon-chevron-right" : "codicon-chevron-down");
    const name = document.createElement("span");
    name.className = "terminal-group-name";
    name.textContent = group.name;
    if (!this.vscodeMode) name.style.color = this.terminalGroupAgeColor(members);
    const unreadDot = document.createElement("span");
    unreadDot.className = "group-unread-dot" + (attentionCount ? " on" : "");
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
        this.openModal(group.id);
      });
      label.appendChild(add);
    }
    label.onclick = () => this.toggleTerminalGroup(group.id);
    label.oncontextmenu = (event) => this.openTerminalGroupContextMenu(event, group);
    this.makeLayoutDraggable(label, `group:${group.id}`, "group");
    return label;
  }

  renderTerminalItem(s, list) {
    const searchMatch = this.terminalSearchMatches.get(s.session_id);
    const item = document.createElement("div");
    item.className = "session-item" + (s.session_id === this.activeId && this.activeFileKey === null ? " active" : "") +
      (searchMatch ? " terminal-search-match" : "");
    item.dataset.sessionId = s.session_id;
    item.classList.toggle("sidebar-selected", this.sidebarSelectedSessionIds.has(s.session_id));
    item.title = `${s.command || "zsh"}\n${s.cwd}` + (s.agent_session_id ? `\n${s.agent_kind}: ${s.agent_session_id}` : "") + "\nright-click for actions";
    if (searchMatch) {
      const snippets = (searchMatch.snippets || []).map((snippet) => `${snippet.line}: ${snippet.text}`).join("\n");
      item.title += `\n${searchMatch.count} terminal match${searchMatch.count === 1 ? "" : "es"}${snippets ? `\n${snippets}` : ""}`;
    }
    item.dataset.baseTitle = item.title;
    item.style.setProperty("--session-age-color", this.terminalAgeColor(s));
    this.sessionRowEls.set(s.session_id, item);
    const presentation = this.titlePresentation(s);
    const useTextStatusIndicator = this.usesTextTerminalStatus();
    if (useTextStatusIndicator) item.classList.add("terminal-icons-hidden");
    const dot = document.createElement("span");
    dot.className = "status-dot" + (s.running ? "" : s.dormant ? " dormant" : " exited") +
      (presentation.spinning ? " processing" : this.unreadSessions.has(s.session_id) ? " unread" : "");
    this.sessionStatusEls.set(s.session_id, dot);
    const spinner = document.createElement("span");
    spinner.className = "session-spinner";
    const rectPathId = `session-spinner-path-${s.session_id}`;
    const rectPath = "M8 2.2 H12 Q13.8 2.2 13.8 4 V12 Q13.8 13.8 12 13.8 H4 Q2.2 13.8 2.2 12 V4 Q2.2 2.2 4 2.2 H8";
    spinner.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">
      <g class="session-spinner-circle-backup session-spinner-orbit">
        <path class="session-spinner-tail faint" d="M2.6 6.1 C2.7 4.5 5 3.4 8 3.4 C9.5 3.4 10.2 4.5 10.7 5.3"/>
        <path class="session-spinner-tail bright" d="M5 4 C7 3.3 9.6 4 10.7 5.3"/>
        <circle class="session-spinner-head" cx="10.7" cy="5.3" r="4.3"/>
      </g>
      <g class="session-spinner-rectangle-current">
        <path id="${rectPathId}" class="session-spinner-rect-motion" d="${rectPath}" pathLength="100"/>
        <path class="session-spinner-rect-tail faint" d="${rectPath}" pathLength="100"/>
        <path class="session-spinner-rect-tail bright" d="${rectPath}" pathLength="100"/>
        <circle class="session-spinner-rect-head" cx="8" cy="2.2" r="1.65">
          <animateMotion dur="1.7s" repeatCount="indefinite" rotate="auto"><mpath href="#${rectPathId}"/></animateMotion>
        </circle>
      </g>
    </svg>`;
    const backupOrbit = spinner.querySelector(".session-spinner-circle-backup");
    if (backupOrbit) backupOrbit.style.animationDelay = `-${Date.now() % 3200}ms`;
    spinner.classList.toggle("on", !useTextStatusIndicator && presentation.spinning);
    this.sessionSpinnerEls.set(s.session_id, spinner);
    const title = document.createElement("span");
    title.className = "session-title";
    title.classList.toggle("session-title-working", useTextStatusIndicator && presentation.spinning);
    title.classList.toggle("session-title-unread",
      useTextStatusIndicator && !presentation.spinning && this.unreadSessions.has(s.session_id));
    this.setSessionTitleText(title, presentation.text, useTextStatusIndicator && presentation.spinning);
    if (!this.vscodeMode && !presentation.spinning) title.style.color = this.terminalAgeColor(s);
    this.sessionTitleEls.set(s.session_id, title);
    const typeIcon = this.terminalTypeIcon(s);
    const showDesktopBrandIndicator = !this.vscodeMode && this.settings.show_terminal_icons;
    const iconStatusActive = showDesktopBrandIndicator &&
      (presentation.spinning || this.unreadSessions.has(s.session_id));
    const iconStatusExited = showDesktopBrandIndicator && !s.running && !s.dormant;
    typeIcon.classList.toggle("terminal-status-active", iconStatusActive);
    typeIcon.classList.toggle("terminal-status-exited", !iconStatusActive && iconStatusExited);
    const close = document.createElement("button");
    close.className = "item-close";
    close.textContent = "✕";
    close.title = this.shortcutTitle("Close terminal", "close-item");
    close.onclick = (event) => { event.stopPropagation(); this.closeSession(s.session_id); };
    const groupIndicator = document.createElement("span");
    groupIndicator.className = "group-drop-indicator";
    groupIndicator.innerHTML = '<span class="codicon codicon-folder-library"></span><span>group</span>';
    groupIndicator.title = "Release to group with this terminal";
    if (showDesktopBrandIndicator) item.append(spinner, typeIcon, title, groupIndicator, close);
    else if (useTextStatusIndicator) item.append(dot, typeIcon, title, groupIndicator, close);
    else item.append(dot, typeIcon, title, groupIndicator, close);
    item.title = `${item.dataset.baseTitle}\nlast activity ${this.terminalAgeAgoLabel(s)}\n${this.terminalAgeExactTimestamp(s)}`;
    item.onclick = (event) => this.handleSessionRowSelection(event, s.session_id);
    item.oncontextmenu = (event) => this.openSessionContextMenu(event, s);
    this.makeLayoutDraggable(item, `session:${s.session_id}`, "session");
    list.appendChild(item);
  }

  renderTerminalGroup(group, members, list) {
    const groupBox = document.createElement("div");
    // Without brand icons, retain a little breathing room between grouped
    // rows and the group border instead of pinning their status mark to it.
    groupBox.className = "terminal-group" + (this.usesTextTerminalStatus()
      ? " terminal-icons-hidden" : "");
    groupBox.dataset.groupId = group.id;
    const attentionCount = members.filter((session) => this.processingStates.get(session.session_id) ||
      this.unreadSessions.has(session.session_id)).length;
    const working = members.some((session) => this.processingStates.get(session.session_id));
    groupBox.appendChild(this.terminalGroupLabel(group, attentionCount, working, members));
    const membersBox = document.createElement("div");
    membersBox.className = "terminal-group-members" + (group.collapsed ? " collapsed" : "");
    const membersInner = document.createElement("div");
    membersInner.className = "terminal-group-members-inner";
    for (const session of members) this.renderTerminalItem(session, membersInner);
    membersBox.appendChild(membersInner);
    groupBox.appendChild(membersBox);
    list.appendChild(groupBox);
  }

  renderList() {
    const list = this.$("session-list");
    list.textContent = "";
    this.ensureDesktopTerminalsHeader(list);
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
    const state = this.getProjectState();
    const groups = this.terminalGroups();
    const groupsById = new Map(groups.map((group) => [group.id, group]));
    const sessionGroups = state.session_groups || {};
    const visibleSessions = this.activitySort
      ? [...this.sessions].sort((a, b) => this.compareRecentActivityForSort(a, b))
      : this.sessions;
    const sessionsById = new Map(visibleSessions.map((session) => [session.session_id, session]));
    const grouped = new Map(groups.map((group) => [group.id, []]));
    for (const session of visibleSessions) {
      if (grouped.has(sessionGroups[session.session_id])) {
        grouped.get(sessionGroups[session.session_id]).push(session);
      }
    }
    const layout = this.terminalLayout();
    if (this.activitySort) {
      for (const members of grouped.values()) {
        members.sort((a, b) => this.compareRecentActivityForSort(a, b));
      }
      const entryActivity = (entry) => {
        const [kind, id] = entry.split(":", 2);
        if (kind !== "group") return this.sessionActivitySortBucket(sessionsById.get(id));
        return Math.max(0, ...(grouped.get(id) || []).map((session) => this.sessionActivitySortBucket(session)));
      };
      layout.sort((a, b) => entryActivity(b) - entryActivity(a));
    }
    if (this.activitySort) {
      for (const session of visibleSessions) this.renderTerminalItem(session, list);
    } else {
      for (const entry of layout) {
        const [kind, id] = entry.split(":", 2);
        if (kind === "group") {
          const group = groupsById.get(id);
          if (!group) continue;
          const members = grouped.get(id) || [];
          this.renderTerminalGroup(group, members, list);
          continue;
        }
        const session = sessionsById.get(id);
        if (!session || sessionGroups[id]) continue;
        this.renderTerminalItem(session, list);
      }
    }
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
          item.oncontextmenu = (event) => this.openFileContextMenu(event, key);
          this.makeDraggable(item, "file", key, (dragged, target, after) => this.reorderFiles(dragged, target, after));
          list.appendChild(item);
        }
      }
    }
    if (!this.vscodeMode) this.renderRecentFilesInto(list);
    this.renderClosedInto(list);
    this.$("empty-state").style.display = this.sessions.length || (!this.vscodeMode && this.openFiles.size) ? "none" : "flex";
    this.sessionListSignature = this.sessionListSignatureFor();
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
      this.patchProjectState({ terminal_groups: this.terminalGroups().map((candidate) => candidate.id === groupId
        ? { ...candidate, collapsed: false } : candidate) });
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
    const nextView = allowToggle && this.sideView === view && view !== "terminals" ? "terminals" : view;
    this.sideView = nextView;
    view = this.sideView;
    const filesVisible = FILES_SIDE_PANEL_TABS.includes(view);
    const filesPinned = filesVisible && !!this.settings.files_pinned;
    this.settings.side_full = filesVisible;
    if (filesPinned) {
      const normalWidth = Number(this.settings.sidebar_width) || SETTINGS_DEFAULTS.sidebar_width;
      this.settings.files_width = Math.max(Number(this.settings.files_width) || 0, normalWidth * 2);
    }
    this.$("files-section").classList.toggle("hidden", !filesVisible);
    this.$("files-section").classList.toggle("with-search", view === "search");
    this.$("files-section").classList.toggle("with-terminal-search", view === "terminal-search");
    this.$("files-section").classList.toggle("floating", filesVisible && !filesPinned);
    for (const [name, id] of [["terminals", "view-terminals"], ["project", "view-project"], ["search", "view-search"]]) {
      const button = this.$(id);
      if (button) button.classList.toggle("on", name === view);
    }
    this.$("terminal-search-toggle").classList.toggle("on", view === "terminal-search");
    for (const name of ["project", "search", "terminal-search"]) {
      const id = `files-tab-${name}`;
      const button = this.$(id);
      if (button) button.classList.toggle("on", name === view);
    }
    this.$("side-split").classList.toggle("hidden", view === "terminals" || filesVisible);
    this.applySettings();
    this.applySideLayout();
    if (view === "project" || view === "search") {
      const session = this.session(this.activeId);
      const expectedRoot = session ? session.cwd : (this.projectRoot() || "~");
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
    } else if (view === "terminal-search") {
      this.updateTerminalSearchGroupButton();
      this.$("terminal-search-input").focus();
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

  setExplorerMode(mode) {
    this.$("files-tree").classList.toggle("hidden", mode !== "tree");
    this.$("search-results").classList.toggle("hidden", mode !== "content");
    this.$("name-results").classList.toggle("hidden", mode !== "name");
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

  toggleFilesPinned() {
    this.settings.files_pinned = !this.settings.files_pinned;
    localStorage.setItem("termdeck.files_pinned", this.settings.files_pinned ? "1" : "0");
    if (this.settings.files_pinned) {
      const normalWidth = Number(this.settings.sidebar_width) || SETTINGS_DEFAULTS.sidebar_width;
      this.settings.files_width = Math.max(Number(this.settings.files_width) || 0, normalWidth * 2);
    }
    const filesVisible = FILES_SIDE_PANEL_TABS.includes(this.sideView);
    this.$("files-section").classList.toggle("floating", filesVisible && !this.settings.files_pinned);
    this.updateFilesPinButton();
    this.applySettings();
    this.scheduleTerminalFitAfterSidebarChange();
    this.saveSettings();
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
    this.scheduleTerminalLayoutFit();
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
    else if (view === "terminal-search") this.$("terminal-search-input").focus();
  }

  cycleFilesSidePanel() {
    if (this.vscodeMode) return;
    const currentIndex = FILES_SIDE_PANEL_TABS.indexOf(this.sideView);
    const nextIndex = currentIndex < 0 ? 0 : currentIndex + 1;
    const nextView = nextIndex >= FILES_SIDE_PANEL_TABS.length ? "terminals" : FILES_SIDE_PANEL_TABS[nextIndex];
    this.setSideView(nextView, false);
    if (nextView === "project") this.focusFileNameSearch();
    else if (nextView === "search") this.focusFileContentSearch();
    else if (nextView === "terminal-search") this.$("terminal-search-input").focus();
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
    this.settings.hide_dot_folders = !this.settings.hide_dot_folders;
    this.updateHideDotButton();
    this.saveSettings();
    if (this.sideView === "search" && this.$("search-query").value.trim()) void this.runSearch(null, true);
    else if (this.sideView === "project" && this.$("search-name").value.trim()) void this.runNameSearch();
    else this.rerenderTree();
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
    menu.style.left = Math.min(x, window.innerWidth - menu.offsetWidth - 10) + "px";
    menu.style.top = Math.min(y, window.innerHeight - menu.offsetHeight - 10) + "px";
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
    const sidePanelTitles = [["view-project", "Files"], ["view-search", "Search & replace"],
      ["terminal-search-toggle", "Search terminal output"],
      ["files-tab-project", "Files"], ["files-tab-search", "Search & replace"],
      ["files-tab-terminal-search", "Search terminal output"]];
    for (const [id, label] of sidePanelTitles) {
      const button = this.$(id);
      if (button) button.title = `${label} (${sidePanelAction} cycles tabs)`;
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
    const newSession = this.$("new-session-btn");
    if (newSession) {
      newSession.title = this.shortcutTitle("New terminal", "new-terminal");
      newSession.setAttribute("aria-label", newSession.title);
    }
    const emptyState = this.$("empty-state");
    if (emptyState) emptyState.textContent = "no terminals — press + to open one";
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
      this.addContextItem(menu, this.shortcutLabel("Fork into a new terminal", "fork-terminal"),
        () => this.forkSession(session), "repo-forked");
      this.addContextItem(menu, "Fork into N terminals…",
        () => this.forkSessionMultiple(session), "repo-forked");
      this.addContextItem(menu, this.shortcutLabel("Restart terminal", "restart-terminal"),
        () => this.restartSession(session.session_id), "refresh");
      const permissions = MODEL_PERMISSIONS[session.agent_kind || "none"] || MODEL_PERMISSIONS.none;
      if (permissions.length > 1) {
        this.addContextSubmenu(menu, "Restart with permission", permissions.map((entry) => ({
          label: entry.label,
          handler: () => this.restartSession(session.session_id, entry.value),
          icon: "refresh",
        })), "refresh");
      }
      this.addContextItem(menu, this.shortcutLabel("Close terminal", "close-item"),
        () => this.closeSession(session.session_id), "close");
      this.addContextItem(menu, this.shortcutLabel("Rename terminal", "rename-terminal"),
        () => this.renameSession(session), "edit");
      this.addContextItem(menu, this.shortcutLabel("Copy session id", "copy-session-id"),
        () => this.copyTextToClipboard(session.session_id, "session id copied"), "copy");
    } else {
      this.addContextItem(menu, this.shortcutLabel(`Close ${sessionIds.length} selected terminals`, "close-item"),
        () => this.closeSelectedSessions(sessionIds), "close-all");
    }
    const terminalLabel = multiple ? `${sessionIds.length} terminals` : "terminal";
    this.addContextItem(menu, multiple ? `Mark ${terminalLabel} as unread`
      : this.shortcutLabel("Mark as unread", "mark-terminal-unread"),
    () => this.setSessionsUnread(sessionIds, true), "eye-closed");
    this.addContextItem(menu, multiple ? `Create group from ${terminalLabel}`
      : this.shortcutLabel("Create group from this terminal", "create-terminal-group-from-active"),
    () => this.createTerminalGroupFromSessions(sessionIds), "folder-library");
    const moveEntries = multiple ? [] : [{
      label: this.shortcutLabel(assignedGroupId ? "Top of group" : "Top of terminals", "move-active-to-top"),
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
    this.positionContextMenu(menu, event.clientX, event.clientY);
  }

  openFileContextMenu(event, key) {
    event.preventDefault();
    event.stopPropagation();
    const keys = this.selectContextMenuFileKeys(key);
    const menu = this.$("context-menu");
    menu.textContent = "";
    this.contextMenuTarget = { type: "files", keys };
    const label = keys.length === 1 ? "Close file" : `Close ${keys.length} selected files`;
    this.addContextItem(menu, this.shortcutLabel(label, "close-item"), () => this.closeFiles(keys), "close-all");
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
      this.addContextItem(menu, "Open", () => this.openFile(this.treeRoot, rel, null, row));
      this.markTreeSelection(row);
    }
    this.addContextItem(menu, "Rename…", () => this.renameTreePath(rel));
    this.addContextItem(menu, "Move…", () => this.moveTreePath(rel));
    this.addContextItem(menu, "Delete (to Trash)", () => this.deleteTreePath(rel));
    this.addContextItem(menu, "Copy path", () => navigator.clipboard.writeText(`${this.treeRoot}/${rel}`));
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
    const filter = document.createElement("input");
    filter.className = "recent-files-filter";
    filter.placeholder = "exclude types: .json, .csv";
    filter.title = "Comma-separated extensions or globs to exclude";
    filter.value = this.settings.recent_exclude || "";
    controls.appendChild(filter);
    list.appendChild(controls);
    const body = document.createElement("div");
    body.className = "recent-files-list";
    list.appendChild(body);

    const renderBody = () => {
      const recent = this.recentFiles.filter((entry) => entry.path &&
        !openKeys.has(`${this.recentFilesRoot}|${entry.path}`) && !this.recentFileExcluded(entry, filter.value));
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
        item.onclick = () => this.openFile(this.recentFilesRoot, entry.path, null, null);
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
    filter.addEventListener("input", () => {
      this.settings.recent_exclude = filter.value;
      this.saveSettings();
      this.recentFilesExpanded = false;
      renderBody();
    });
    renderBody();
  }

  recentFileExcluded(entry, rawPatterns) {
    const path = String(entry.path || "").toLowerCase();
    const name = String(entry.name || path.split("/").pop() || "").toLowerCase();
    const patterns = String(rawPatterns || "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
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

  async refreshRecentFiles(force = false) {
    if (this.vscodeMode) return;
    if (this.recentFilesBusy) return;
    const activeRoot = this.session(this.activeId)?.cwd || this.projectRoot();
    const filesVisible = !this.$("files-section").classList.contains("hidden");
    const root = (filesVisible && this.treeRoot) || activeRoot;
    if (!root) return;
    if (!force && this.recentFilesRoot === root && Date.now() - this.recentFilesFetchedAt < RECENT_FILES_REFRESH_MS) return;
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

  renderClosedInto(list) {
    if (!this.closedSessions.length) return;
    const header = document.createElement("div");
    header.className = "side-section-label closed-header";
    const chevron = document.createElement("span");
    chevron.className = "codicon codicon-chevron-right closed-chevron" + (this.closedExpanded ? " open" : "");
    header.append(chevron, document.createTextNode(`closed terminals (${this.closedSessions.length})`));
    header.onclick = () => { this.closedExpanded = !this.closedExpanded; this.renderList(); };
    list.appendChild(header);
    if (!this.closedExpanded) return;
    const visibleClosed = this.closedSessions.slice(0, Math.min(
      this.closedDisplayLimit, CLOSED_SESSIONS_MAX_DISPLAY));
    for (const c of visibleClosed) {
      const item = document.createElement("div");
      item.className = "closed-item";
      item.title = `${c.command || "zsh"}\n${c.cwd}\nclosed ${c.closed_at_est}` +
        (c.agent_session_id ? `\nreopens ${c.agent_kind} session ${c.agent_session_id}` : "") + "\nclick to reopen";
      const icon = document.createElement("span");
      icon.className = "codicon codicon-history";
      const name = document.createElement("span");
      name.className = "file-item-name";
      name.textContent = c.title;
      const purge = document.createElement("button");
      purge.className = "item-close";
      purge.textContent = "✕";
      purge.title = "Remove from history";
      purge.onclick = (e) => { e.stopPropagation(); this.purgeClosed(c.session_id); };
      item.append(icon, name, purge);
      item.onclick = () => this.reopenClosed(c.session_id);
      list.appendChild(item);
    }
    if (this.closedSessions.length > visibleClosed.length && visibleClosed.length < CLOSED_SESSIONS_MAX_DISPLAY) {
      const loadMore = document.createElement("button");
      loadMore.className = "closed-load-more";
      loadMore.textContent = `load more (${Math.min(
        CLOSED_SESSIONS_MAX_DISPLAY - visibleClosed.length,
        this.closedSessions.length - visibleClosed.length)})`;
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
    if (!res.ok) return;
    await this.refresh();
    this.activate(sessionId);
    const view = this.views.get(sessionId);
    if (view) view.pinBottomUntil = Date.now() + 6000;
  }

  async purgeClosed(sessionId) {
    await fetch(`/api/closed/${sessionId}`, { method: "DELETE" });
    this.refresh();
  }

  renderTopbar() {
    const s = this.session(this.activeId);
    const entry = this.activeFileKey !== null ? this.openFiles.get(this.activeFileKey) : null;
    const tabTitle = entry ? entry.name : (s ? this.titlePresentation(s).text : null);
    document.title = this.vscodeMode ? "TermDeck" : (tabTitle ? `${tabTitle} — TermDeck` : "TermDeck");
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
    this.renderHistoryMeta();
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

  async loadFileHistory() {
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
    if (!this.fileHistorySelections.length && this.fileHistoryItems.length) {
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
      wordWrap: this.settings.word_wrap ? "on" : "off", fixedOverflowWidgets: true };
  }

  renderFileHistoryCurrentEditor(entry) {
    this.disposeFileHistoryEditors();
    const host = this.$("file-history-editor-host");
    host.classList.remove("hidden");
    const editor = monaco.editor.create(host, { ...this.fileHistoryEditorOptions(), readOnly: false, model: entry.model,
      theme: this.isLight() ? "termdeck-light" : "termdeck-dark" });
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
      originalEditable: false, renderSideBySide: true, theme: this.isLight() ? "termdeck-light" : "termdeck-dark" });
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
    const modelPattern = /\b(gpt-[a-z0-9.+-]+(?:-[a-z0-9.+-]+)*(?:\s+x(?:high|medium|low|standard|mini|turbo))?)\b/gi;
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

  renderHistoryModel(session, turns = []) {
    const modelEl = this.$("history-model");
    if (!modelEl) return;
    if (!this.historyOpen || this.activeFileKey !== null) {
      modelEl.textContent = "";
      modelEl.classList.add("hidden");
      return;
    }
    const model = this.historyModelDisplay(session, turns);
    if (!model) {
      modelEl.textContent = "";
      modelEl.classList.add("hidden");
      return;
    }
    modelEl.textContent = model;
    modelEl.classList.remove("hidden");
    modelEl.title = modelEl.textContent;
  }

  applyMainLayout() {
    const fileMode = this.activeFileKey !== null;
    if (!fileMode && this.fileHistoryOpen) this.closeFileHistory();
    const historyMode = this.historyOpen && !fileMode;
    this.$("editor-area").classList.toggle("hidden", !fileMode);
    this.$("history-area").classList.toggle("hidden", !historyMode);
    this.$("terminal-area").classList.toggle("hidden", fileMode || historyMode);
    for (const id of ["history-btn", "vscode-history-btn"]) {
      const historyButton = this.$(id);
      if (historyButton) historyButton.classList.toggle("on", historyMode);
    }
    for (const id of ["history-edits-toggle", "history-scroll-bottom"]) {
      const button = this.$(id);
      if (button) button.classList.toggle("hidden", !historyMode);
    }
    this.updateShortcutTitles();
    this.$("attach-btn").classList.toggle("hidden", historyMode || fileMode);
    this.$("reveal-session-btn").classList.toggle("hidden", historyMode || fileMode);
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
    container.classList.toggle("hidden", !this.historyOpen || !queued.length);
    count.textContent = queued.length ? `${queued.length} message${queued.length === 1 ? "" : "s"}` : "";
    const activeEditor = document.activeElement?.classList?.contains("history-queued-editor") ? document.activeElement : null;
    if (activeEditor && items.contains(activeEditor) && activeEditor.dataset.sessionId === view?.sessionId &&
        !view?.promptQueueMutation) return;
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
      editor.disabled = !!view?.promptQueueMutation;
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
        resize();
      });
      editor.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          const current = view?.promptQueue?.[index];
          if (current) delete current.draftText;
          this.renderHistoryQueue(view);
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
      remove.disabled = !!view?.promptQueueMutation;
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
    if (!item || item.mutationPending) return;
    const next = String(text || "");
    if (next === item.text) {
      delete item.draftText;
      return;
    }
    this.mutateHistoryQueue(view, index, next, !next.trim());
  }

  removeHistoryQueueItem(view, index) {
    if (!view?.promptQueue?.[index] || view.promptQueueMutation) return;
    this.mutateHistoryQueue(view, index, "", true);
  }

  mutateHistoryQueue(view, index, text, remove) {
    if (!view || view.promptQueueMutation || this.session(view.sessionId)?.agent_kind !== "codex" ||
        !view.ws || view.ws.readyState !== WebSocket.OPEN) return;
    const queue = view.promptQueue.map((item) => String(item.text || ""));
    if (index < 0 || index >= queue.length) return;
    view.promptQueueMutation = true;
    view.promptQueue.forEach((item) => { item.mutationPending = true; });
    this.renderHistoryQueue(view);
    const bracketed = !view.term.modes || view.term.modes.bracketedPasteMode !== false;
    view.ws.send(JSON.stringify({ type: "queue_edit", index, queue, text: String(text || ""), remove, bracketed }));
    this.$("status-name").textContent = remove ? "removing queued prompt…" : "updating queued prompt…";
  }

  reconcileHistoryQueue(view, turns) {
    if (!view?.promptQueue?.length) return;
    const userTexts = turns.filter((turn) => turn.role === "user").map((turn) => String(turn.text || ""));
    for (let index = 0; index < view.promptQueue.length;) {
      const queued = view.promptQueue[index];
      const match = userTexts.slice(queued.userCount || 0).indexOf(queued.text);
      if (match < 0) {
        index += 1;
        continue;
      }
      view.promptQueue.splice(index, 1);
    }
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

  scheduleActiveEditorFocus(sessionId) {
    clearTimeout(this.activeEditorFocusTimer);
    this.activeEditorFocusTimer = window.setTimeout(this.runScheduledActiveEditorFocus.bind(this, sessionId), 80);
  }

  // Called after a view's container is revealed from a visibility:hidden reflow hide (see
  // forceVisibleTerminalReflowViaResizeNudge) that may have swallowed an earlier focus() attempt.
  // Only reclaims focus if nothing else meaningful has since claimed it -- a user who clicked into the
  // search box, an editor, or a modal while the terminal was hidden must not have that focus stolen
  // back out from under them.
  reclaimTerminalFocusIfIdle(view) {
    if (!view || view.closed || this.activeId !== view.sessionId || this.activeFileKey !== null ||
        this.historyOpen || this.nativeVscodeMode) return;
    const active = document.activeElement;
    if (active && active !== document.body && !view.container.contains(active)) return;
    view.term.focus();
  }

  runScheduledActiveEditorFocus(sessionId) {
    this.activeEditorFocusTimer = 0;
    if (sessionId !== this.activeId) return;
    this.focusActiveEditor();
  }

  closeHistory() {
    this.setHistoryMode(false);
  }

  async toggleHistory() {
    if (this.activeFileKey !== null) return;
    this.setHistoryMode(!this.historyOpen);
  }

  setHistoryMode(enabled) {
    this.hideSelectionActions(true);
    if (!enabled) this.closePromptHistory();
    this.settings.history_mode = !!enabled;
    this.saveSettings();
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
        this.syncPromptToTerminal(view);
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
  }

  async loadOlderHistory() {
    if (this.historyOlderLoadBusy || !this.historyOpen || !this.activeId || this.activeFileKey !== null) return;
    const sessionId = this.activeId;
    if (!this.historyHasMoreBySession.get(sessionId)) return;
    const before = this.historyBeforeBySession.get(sessionId);
    if (before == null) return;
    this.historyOlderLoadBusy = true;
    const body = this.$("history-body");
    const previousHeight = body.scrollHeight;
    try {
      const params = new URLSearchParams({ before: String(before), limit: "160" });
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/history-page?${params}`);
      if (!response.ok) throw new Error(`history page failed: ${response.status}`);
      const page = await response.json();
      if (page.reset) {
        this.historyOlderTurnsBySession.set(sessionId, []);
        this.historyBeforeBySession.set(sessionId, null);
        this.historyHasMoreBySession.set(sessionId, false);
        this.connectHistoryStream(sessionId, { fresh: true });
        return;
      }
      const olderPage = Array.isArray(page.turns) ? page.turns : [];
      const existingOlder = this.historyOlderTurnsBySession.get(sessionId) || [];
      this.historyOlderTurnsBySession.set(sessionId, olderPage.concat(existingOlder));
      this.historyBeforeBySession.set(sessionId, page.before == null ? null : Number(page.before));
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
        requestAnimationFrame(() => { body.scrollTop += body.scrollHeight - previousHeight; });
      }
    } catch (error) {
      console.warn("unable to load older transcript history", error);
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
      const authoritativeCount = merged.filter((turn) => turn.role === "user" && turn.text === item.text && !turn.pending_id).length;
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

  sendHistoryPrompt(options = {}) {
    if (!this.historyOpen || this.activeFileKey !== null || !this.activeId) return;
    const prompt = this.$("history-prompt");
    const rawText = prompt.value;
    const text = this.settings.prompt_wrap_guard ? rawText.replace(/\r\n/g, "\n").replace(/[\r\n]+$/, "") : rawText;
    if (!text.trim()) return;
    const view = this.views.get(this.activeId);
    if (!view || !view.ws || view.ws.readyState !== WebSocket.OPEN) {
      this.$("status-name").textContent = "terminal is still connecting…";
      return;
    }
    this.markPromptWrapActivity(view);
    view.promptDraft = text;
    view.promptSubmitting = true;
    view.promptSubmitEntered = false;
    view.promptEditing = false;
    view.promptSubmitVersion = view.promptEditVersion;
    const bracketed = !view.term.modes || view.term.modes.bracketedPasteMode !== false;
    const queue = !!options.queue && this.session(this.activeId)?.agent_kind === "codex";
    const sessionId = this.activeId;
    if (this.session(sessionId)?.agent_kind === "codex") this.deferTerminalReflowAfterPrompt(view);
    if (!queue) {
      this.historyPendingProcessing.set(sessionId, Date.now());
      this.updateHistoryThinkingIndicator();
    }
    if (!queue) {
      // The agent transcript may not contain the submitted user turn until it
      // starts producing its next event. Show it immediately, then let the
      // authoritative transcript update reconcile this optimistic row.
      const turns = this.historyTurnsBySession.get(sessionId) || this.historyTurns;
      const pending = this.historyPendingPrompts.get(sessionId) || [];
      const authoritativeCount = turns.filter((turn) => turn.role === "user" && turn.text === text && !turn.pending_id).length;
      const beforeCount = authoritativeCount + pending.filter((item) => item.text === text).length;
      const pendingId = `${Date.now()}-${this.historyPendingPromptSequence++}`;
      pending.push({ text, beforeCount, pending_id: pendingId });
      this.historyPendingPrompts.set(sessionId, pending);
      const live = this.historyLiveTurnsBySession.get(sessionId) || turns;
      const optimisticLive = this.mergePendingHistoryPrompts(sessionId, live);
      this.historyLiveTurnsBySession.set(sessionId, optimisticLive);
      const optimisticTurns = this.combineHistoryWindow(sessionId, optimisticLive);
      this.applyHistoryTurns(sessionId, optimisticTurns, { preserveScroll: true });
    }
    if (queue) {
      view.promptQueue.push({ text, userCount: this.historyTurns.filter((turn) => turn.role === "user").length });
      this.renderHistoryQueue(view);
    }
    try {
      view.ws.send(JSON.stringify({ type: "submit", text, bracketed, queue }));
    } catch (error) {
      this.historyPendingProcessing.delete(sessionId);
      this.updateHistoryThinkingIndicator();
      this.$("status-name").textContent = "unable to send prompt";
      console.warn("unable to send Markdown prompt", error);
      return;
    }
    this.recordPromptHistory(sessionId, text);
    // Clear the local draft immediately so switching views cannot reinsert the
    // prompt while the PTY consumes the synchronized text and Enter.
    view.promptDraft = "";
    this.showPromptDraft(view);
    prompt.focus();
    clearTimeout(view.promptSubmitTimer);
    view.promptSubmitTimer = setTimeout(() => {
      view.promptSubmitting = false;
      view.promptSubmitEntered = false;
    }, 1500);
    view.keepBottom = true;
    view.pinBottomUntil = Date.now() + 5000;
    this.$("status-name").textContent = queue ? "prompt queued" : "prompt sent";
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
    prompt.value = view.promptDraft || "";
    this.resizeHistoryPrompt();
    requestAnimationFrame(() => {
      if (prompt.value !== (view.promptDraft || "")) return;
      this.resizeHistoryPrompt();
      requestAnimationFrame(() => {
        if (prompt.value === (view.promptDraft || "")) this.resizeHistoryPrompt();
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
    this.markPromptWrapActivity(view);
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

  markPromptWrapActivity(view) {
    if (!view || !this.settings.prompt_wrap_guard) return;
    view.promptWrapGuardUntil = Date.now() + PROMPT_WRAP_GUARD_IDLE_MS;
    clearTimeout(view.promptWrapGuardTimer);
    view.promptWrapGuardTimer = setTimeout(() => {
      view.promptWrapGuardTimer = 0;
      if (view.closed || view.promptWrapGuardUntil > Date.now() || !view.container.classList.contains("visible")) return;
      this.scheduleV2Fit(view);
    }, PROMPT_WRAP_GUARD_IDLE_MS + 20);
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

  shouldDeferPromptWrapFit(view) {
    if (!view) return false;
    return (this.settings.prompt_wrap_guard && view.promptWrapGuardUntil > Date.now()) ||
      view.promptSubmissionReflowGuardUntil > Date.now();
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

  sendTrackedInput(view, data) {
    this.markPromptWrapActivity(view);
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
      // Codex has accepted this composer into its queue. Keep the two editors
      // consistent with the terminal instead of leaving the queued text as a
      // draft that reappears when Markdown is opened.
      view.promptDraft = "";
      view.promptEditing = false;
      view.pendingTerminalDraft = null;
      view.pendingDraftSync = null;
      if (view.ws && view.ws.readyState === WebSocket.OPEN) this.recordPromptHistory(view.sessionId, queueText);
      view.promptQueue.push({
        text: queueText,
        userCount: this.historyTurns.filter((turn) => turn.role === "user").length,
      });
      this.sendPromptDraftSync(view, "");
      this.showPromptDraft(view);
      if (this.historyOpen && view.sessionId === this.activeId) this.renderHistoryQueue(view);
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
      const text = document.createElement("div");
      text.className = "turn-text markdown";
      text.innerHTML = this.renderMarkdown(turn.text);
      if (turn.role === "user") {
        const role = document.createElement("div");
        role.className = "turn-role";
        role.textContent = "You";
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
    this.reconcileHistoryQueue(this.views.get(sessionId), turns);
    // Capture this after the request completes so scrolling while the refresh
    // is in flight is never overwritten by an older scroll position.
    const scrollSnapshot = preserveScroll ? this.captureHistoryScroll(body, this.historyTurns) : null;
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
  }

  renderMarkdown(text) {
    if (window.marked) {
      return marked.parse(text, { breaks: true, gfm: true });
    }
    const escaped = document.createElement("div");
    escaped.textContent = text;
    return escaped.innerHTML;
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
    document.addEventListener("selectionchange", () => this.scheduleSelectionActions());
    document.addEventListener("mouseup", () => this.scheduleSelectionActions());
    document.addEventListener("copy", () => this.recordDocumentSelectionCopy());
    window.addEventListener("resize", () => this.scheduleSelectionActions());
    window.addEventListener("scroll", () => this.scheduleSelectionActions(), true);
  }

  scheduleSelectionActions() {
    if (this.selectionActionUpdateFrame) return;
    this.selectionActionUpdateFrame = requestAnimationFrame(() => {
      this.selectionActionUpdateFrame = 0;
      this.updateSelectionActions();
    });
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
      this.hideSelectionActions();
      return;
    }
    this.selectionActionState = state;
    if (!actions) return;
    if (!historyPanelOpen) actions.classList.remove("history-picker");
    actions.classList.remove("hidden");
    this.positionSelectionActions(state.rect);
    if (historyPanelOpen) this.positionSelectionCopyHistoryPanel(state.rect);
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
  }

  readSelectionActionState() {
    if (this.activeFileKey !== null) return null;
    if (this.historyOpen) {
      const selection = window.getSelection();
      const body = this.$("history-body");
      if (!this.selectionWithinContainer(selection, body)) return null;
      const text = this.normalizeSelectionText(selection.toString());
      const rect = this.selectionRangeRect(selection);
      return text && rect ? { kind: "history", text, rect } : null;
    }
    const view = this.views.get(this.activeId);
    if (!view || !view.container.classList.contains("visible") || !view.term.hasSelection()) return null;
    const text = this.normalizeSelectionText(view.term.getSelection());
    const rect = this.terminalSelectionRect(view);
    return text && rect ? { kind: "terminal", sessionId: view.sessionId, text, rect } : null;
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

  hideSelectionActions(clearSelection = false) {
    const state = this.selectionActionState;
    this.selectionActionState = null;
    this.selectionCopyHistoryIndex = 0;
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

  copySelectionToClipboard() {
    const state = this.selectionActionState;
    if (!state) return;
    const text = state.text;
    this.recordSelectionCopyHistory(text);
    void this.copyTextToClipboard(text, "selection copied");
    this.hideSelectionActions();
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
    const query = this.normalizeSelectionText(state.text);
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
    const query = this.normalizeSelectionText(state.text);
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

  appendTextToHistoryPrompt(text) {
    const value = this.normalizeSelectionText(text);
    if (!value) return;
    if (!this.historyOpen) this.setHistoryMode(true);
    const view = this.views.get(this.activeId);
    const prompt = this.$("history-prompt");
    if (!view || !prompt || !this.historyOpen) return;
    const current = String(prompt.value || view.promptDraft || "").trimEnd();
    view.promptDraft = current ? `${current}\n\n${value}\n\n` : `${value}\n\n`;
    view.promptEditing = true;
    view.promptEditVersion += 1;
    this.showPromptDraft(view);
    this.syncPromptToTerminal(view, { writeToTerminal: false });
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
        view.ws.readyState !== WebSocket.OPEN) return false;
    return Date.now() - view.hiddenAt >= TERMINAL_CLAUDE_IDLE_RECONNECT_MS;
  }

  reconnectIdleClaudeView(view) {
    if (!view?.ws || view.closed || view.reconnectAfterClose) return;
    view.reconnectAfterClose = true;
    view.suppressReconnect = true;
    view.ws.close(1000, "idle Claude terminal replay");
  }

  scheduleClaudeInitialReplayRecovery(id, view) {
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
    let unreadChanged = false;
    if (previousId && previousId !== id) {
      unreadChanged = this.unreadSessions.delete(previousId) || unreadChanged;
      this.updateUnreadIndicator(previousId);
    }
    if (previousId !== id) {
      unreadChanged = this.unreadSessions.delete(id) || unreadChanged;
      this.updateUnreadIndicator(id);
    }
    if (unreadChanged) this.patchProjectState({ unread_sessions: [...this.unreadSessions] });
    const selected = this.session(id);
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
    this.historyOpen = !!this.settings.history_mode;
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
    if (previousView && previousView !== view) {
      if (this.isTerminalScrollV2()) {
        // v2 deliberately trusts xterm's own buffer state instead of the
        // browser's private viewport scroll position.
        previousView.scrollMode = this.xtermAtBottom(previousView) ? "follow" : "preserve";
        // Captured as an OFFSET, not the absolute viewportY: if this tab's background websocket has
        // closed by the time we come back to it, reactivating it resets and replays the whole buffer
        // from scratch (see ws.onopen's view.term.reset()), making an absolute row index meaningless
        // against the freshly rebuilt buffer. "N rows above the latest line" survives that rebuild.
        previousView.preserveRowsFromBottom =
          previousView.term.buffer.active.baseY - previousView.term.buffer.active.viewportY;
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
    if (options.reveal) this.keepActiveSessionVisible();
    this.scheduleActiveEditorFocus(id);
  }

  ensureView(id) {
    if (this.views.has(id)) return this.views.get(id);
    const container = document.createElement("div");
    container.className = "term-container";
    this.$("terminal-area").appendChild(container);
    const term = new Terminal({
      fontSize: this.settings.terminal_font_size, fontFamily: '"SF Mono", Menlo, monospace', letterSpacing: -0.2, theme: this.termTheme(),
      scrollback: 20000, cursorBlink: true, macOptionIsMeta: true, allowProposedApi: true,
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(container);
    term.registerLinkProvider({ provideLinks: (y, cb) => this.providePathLinks(term, id, y, cb) });
    const view = { sessionId: id, container, term, fit, ws: null, closed: false, everConnected: false, awaitingSnapshot: true,
                   replaying: false, pasting: false, suppressReconnect: false, cliTitle: null, pinBottomUntil: 0,
                   programmaticScrollUntil: 0, programmaticScrollGeneration: 0, scrollSettleTimer: 0,
                   reconnectTimer: 0, settleFrame: 0, viewportRepairFrame: 0, needsViewportRepair: false,
                   resizeRepairTimer: 0, outputQueue: [], outputWriteInFlight: false, outputWriteGeneration: 0,
                   layoutObserver: null, scrollObserver: null, visibilityObserver: null,
                   layoutFitRetryTimer: 0, layoutFitRetryCount: 0,
                   keepBottom: true, manualScroll: false, manualScrollGeneration: 0, manualScrollReleaseTimer: 0,
                   wasAtBottom: true, scrollMode: "follow", v2Programmatic: false, v2FitFrame: 0,
                   v2InitialFitPending: true, v2InitialFitFrame: 0, hiddenOutputPending: false, v2ViewportSyncFrame: 0,
                   forceResizeAfterFit: true, v2ForcedReflowFrame: 0, v2ForcedReflowRestoreFrame: 0,
                   suppressResizeToServer: false, resyncResizeRepairPending: false,
                   hiddenAt: 0, lastShownAt: 0, lastActivationReflowAt: 0,
                   tailRepairFrame: 0, activationRepairFrame: 0, tailRepairSignature: "",
                   lastSentCols: null, lastSentRows: null, settleWatchdogTimers: [], codexReflowFollowupTimers: [],
                   codexReflowEverAttempted: false, preserveRowsFromBottom: 0, reconnectReset: false,
                   promptDraft: this.session(id)?.draft || "", promptPaste: false, promptEscape: "", promptEditing: false,
                   promptSubmitting: false, promptSubmitEntered: false, promptSubmitTimer: 0,
                   promptSubmissionReflowGuardUntil: 0, promptSubmissionReflowGuardTimer: 0, promptWrapGuardUntil: 0, promptWrapGuardTimer: 0,
                   reconnectAfterClose: false, claudeInitialReplayCheckTimer: 0,
                   claudeInitialReplayRecoveryAttempted: false,
                   promptQueue: [], promptQueueEditIndex: null, promptQueueMutation: false,
                   promptDraftSyncPending: false, promptDraftSyncTimer: 0, promptDraftSyncDebounceTimer: 0,
                   pendingDraftSync: null, pendingTerminalDraft: null,
                   promptEditVersion: 0, promptSubmitVersion: -1 };
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
      // Wheel/scrollbar intent arrives before xterm publishes onScroll().
      // Preserve immediately so a live output callback in that gap cannot
      // pull the viewport back to the prompt.
      view.v2Programmatic = false;
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
      return this.handleTerminalEditingKeys(view, e);
    });
    term.onData((data) => this.sendTrackedInput(view, data));
    term.onResize(({ cols, rows }) => {
      if (!view.suppressResizeToServer) this.sendResize(view, cols, rows);
    });
    term.onScroll(() => {
      if (!view.container.classList.contains("visible")) return;
      if (this.isTerminalScrollV2()) {
        if (!view.v2Programmatic) view.scrollMode = this.xtermAtBottom(view) ? "follow" : "preserve";
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
      if (!view.container.classList.contains("visible") || view.closed) return;
      if (this.isTerminalScrollV2()) {
        this.scheduleV2Fit(view);
        return;
      }
      const rect = view.container.getBoundingClientRect();
      if (rect.width < 40 || rect.height < 40) return;
      view.fit.fit();
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

  connect(id, view) {
    if (view.closed) return;
    view.suppressReconnect = false;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws/${id}?screen_repaint=1`);
    ws.binaryType = "arraybuffer";
    view.awaitingSnapshot = true;
    view.replaying = false;
    view.needsViewportRepair = false;
    view.outputWriteGeneration += 1;
    view.outputQueue = [];
    view.lastSentCols = null;
    view.lastSentRows = null;
    ws.onopen = () => {
      view.reconnectReset = view.everConnected;
      if (view.everConnected) {
        view.replaying = true;
        if (!this.isTerminalScrollV2()) {
          if (view.keepBottom && !view.manualScroll) view.pinBottomUntil = Date.now() + 8000;
          else view.pinBottomUntil = 0;
        }
      }
      view.everConnected = true;
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
    };
    ws.onmessage = (e) => {
      if (typeof e.data === "string") { this.handleControl(id, view, JSON.parse(e.data)); return; }
      // xterm's buffer continues to process output while an inactive tab is
      // display:none, but its browser viewport has zero height. Remember that
      // state so activation can synchronize the now-visible scrollbar through
      // xterm's public scroll API, rather than a DOM scroll listener or PTY
      // resize/reflow.
      if (!view.container.classList.contains("visible")) view.hiddenOutputPending = true;
      if (!view.awaitingSnapshot) this.touchSessionActivity(id);
      if (view.awaitingSnapshot) {
        if (view.reconnectReset && e.data.byteLength > 0) view.term.reset();
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
          if (!view.reconnectReset && this.session(id)?.agent_kind === "claude") {
            this.scheduleClaudeInitialReplayRecovery(id, view);
          }
          if (v2 && view.container.classList.contains("visible")) {
            view.forceResizeAfterFit = true;
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
      if (view.promptQueueMutation) {
        view.promptQueueMutation = false;
        view.promptQueue.forEach((item) => { delete item.mutationPending; });
        this.renderHistoryQueue(view);
        if (id === this.activeId) this.$("status-name").textContent = "queued prompt update disconnected — retry";
      }
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
      if (key === "a") { e.preventDefault(); this.selectActiveTerminalText(); return false; }
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
      if (view.promptQueueMutation) return;
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
    } else if (msg.type === "queue_mutation") {
      view.promptQueueMutation = false;
      view.promptQueue.forEach((item) => { delete item.mutationPending; });
      if (msg.ok && Array.isArray(msg.queue)) {
        const userCount = this.historyTurns.filter((turn) => turn.role === "user").length;
        view.promptQueue = msg.queue.map((text) => ({ text: String(text || ""), userCount }));
        view.promptQueueEditIndex = null;
        this.renderHistoryQueue(view);
        this.$("status-name").textContent = "queued prompt updated";
      } else {
        this.renderHistoryQueue(view);
        this.$("status-name").textContent = msg.error || "queued prompt update failed";
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
    if (data) this.touchSessionActivity(view.sessionId);
    if (view.replaying && QUERY_RESPONSE_RE.test(data)) return;
    if (view.ws && view.ws.readyState === WebSocket.OPEN) {
      view.ws.send(JSON.stringify({ type: "input", data }));
    }
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
      const text = paths.map((p) => (/\s/.test(p) ? `'${p}'` : p)).join(" ") + " ";
      const prompt = this.$("history-prompt");
      const separator = prompt.value && !/\s$/.test(prompt.value) ? " " : "";
      view.promptDraft = `${prompt.value}${separator}${text}`;
      view.promptEditing = true;
      this.showPromptDraft(view);
      this.syncPromptToTerminal(view, { writeToTerminal: false });
      prompt.focus();
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

  sendResize(view, cols, rows, force = false) {
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

  scheduleV2Fit(view, options = {}) {
    const forceResize = !!options.force;
    if (!view || view.closed || !view.container.classList.contains("visible")) return;
    if (this.shouldDeferPromptWrapFit(view)) return;
    if (view.v2FitFrame && forceResize) {
      cancelAnimationFrame(view.v2FitFrame);
      view.v2FitFrame = 0;
    }
    if (view.v2FitFrame) return;
    view.v2FitFrame = requestAnimationFrame(() => {
      view.v2FitFrame = 0;
      if (view.closed || !view.container.classList.contains("visible")) return;
      if (this.shouldDeferPromptWrapFit(view)) return;
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
      view.fit.fit();
      if (view.scrollMode !== "follow" && (view.term.cols !== beforeCols || view.term.rows !== beforeRows)) {
        this.scrollTerminalV2ToLine(view, Math.max(0, view.term.buffer.active.baseY - rowsFromBottom));
      }
      // A terminal may have been painted while its container was hidden or
      // at its pre-flex width. Refresh after the settled fit so the canvas
      // and text colors are repainted together with the final geometry.
      const forceResizeThisFrame = forceResize || view.forceResizeAfterFit;
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

  terminalRenderedTailLines(view, count = TERMINAL_TAIL_REPAIR_LINES) {
    const rows = [...(view?.container?.querySelectorAll(".xterm-rows > div") || [])];
    return rows.slice(-count).map((row) => this.normalizeTerminalTailLine(row.textContent || ""));
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
    let visible = 0;
    for (let index = 0; index < expected.length; index++) {
      if (!expected[index].trim()) continue;
      compared += 1;
      const row = rows[index];
      const renderedLine = rendered[index] || "";
      if (!row || !renderedLine.trim()) {
        invisible += 1;
        continue;
      }
      const spans = [...row.querySelectorAll("span")];
      const sample = spans.find((span) => String(span.textContent || "").trim()) || row;
      const style = window.getComputedStyle(sample);
      const opacity = Number.parseFloat(style.opacity);
      if (style.visibility === "hidden" || style.display === "none" || opacity === 0) {
        invisible += 1;
        continue;
      }
      const foreground = this.parseCssColor(style.color);
      if (foreground && foreground[3] === 0) {
        invisible += 1;
      } else if (foreground && background && this.colorDistance(foreground, background) < 32) {
        invisible += 1;
      } else {
        visible += 1;
      }
    }
    return compared > 0 && invisible > 0 && visible === 0;
  }

  terminalTailRenderMismatch(view) {
    // forceVisibleTerminalReflowViaResizeNudge deliberately hides the container (visibility:hidden)
    // for the brief window of its own shrink/grow cycle. Without this guard, a concurrently-running
    // check (e.g. scheduleActiveTerminalSettleWatchdog's own periodic timers) could see that
    // self-inflicted, intentional invisibility via terminalRenderedTailLooksInvisible and misread it as
    // a genuine paint bug, triggering an unnecessary SECOND repair on top of the nudge already in
    // flight -- worse under CPU load, where the nudge's own hide window runs longer.
    if (view.v2ForcedReflowFrame || view.v2ForcedReflowRestoreFrame) return false;
    const expected = this.terminalBufferVisibleTailLines(view);
    const rendered = this.terminalRenderedTailLines(view);
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

  repairTerminalRenderIfStale(view) {
    if (!view || view.closed || !view.container.classList.contains("visible")) return false;
    if (this.shouldDeferPromptWrapFit(view)) return false;
    if (!this.terminalTailRenderMismatch(view)) return false;
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
    // A stale-looking render is not always a paint problem: the terminal's own cols/rows can be wrong for
    // its actual container width (a sibling's DOM change, a still-settling flex pass) without ever having
    // gone through a resize event. fit() re-measures the container and calls term.resize() when that
    // differs, which repaints AND corrects wrapping in one pass. Re-check the mismatch afterward — a pure
    // paint glitch (fit is a no-op) still needs the appearance refresh below.
    const beforeCols = view.term.cols, beforeRows = view.term.rows;
    view.fit.fit();
    if (view.term.cols !== beforeCols || view.term.rows !== beforeRows) {
      if (view.term.cols >= 2 && view.term.rows >= 2) this.sendResize(view, view.term.cols, view.term.rows, true);
      if (!this.terminalTailRenderMismatch(view)) {
        if (follow) this.scrollTerminalV2ToBottom(view);
        else this.scrollTerminalV2ToLine(view, Math.max(0, view.term.buffer.active.baseY - restoreRowsFromBottom));
        return true;
      }
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
    if (!view || view.closed || !this.isTerminalScrollV2()) return;
    for (const delay of TERMINAL_ACTIVE_SETTLE_DELAYS_MS) {
      view.settleWatchdogTimers.push(setTimeout(() => {
        if (view.closed || this.activeId !== view.sessionId || !view.container.classList.contains("visible")) return;
        if (this.shouldDeferPromptWrapFit(view)) return;
        const beforeCols = view.term.cols, beforeRows = view.term.rows;
        view.fit.fit();
        const colsChanged = view.term.cols !== beforeCols || view.term.rows !== beforeRows;
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
    if (!view || view.closed || view.tailRepairFrame || !view.container.classList.contains("visible")) return;
    if (!this.isTerminalScrollV2() || view.scrollMode !== "follow") return;
    view.tailRepairFrame = requestAnimationFrame(() => {
      view.tailRepairFrame = requestAnimationFrame(() => {
        view.tailRepairFrame = 0;
        if (view.closed || !view.container.classList.contains("visible") || view.scrollMode !== "follow") return;
        this.repairTerminalRenderIfStale(view);
      });
    });
  }

  scheduleTerminalActivationRepair(view, options = {}) {
    if (!view || view.closed || view.activationRepairFrame || !view.container.classList.contains("visible")) return;
    if (!this.isTerminalScrollV2()) return;
    const generation = view.outputWriteGeneration;
    const forceReflow = !!options.forceReflow;
    view.activationRepairFrame = requestAnimationFrame(() => {
      view.activationRepairFrame = requestAnimationFrame(() => {
        view.activationRepairFrame = 0;
        if (view.closed || !view.container.classList.contains("visible")) return;
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
    if (localStorage.getItem("td-debug-reflow-mode") === "nudge") return this.forceVisibleTerminalReflowViaResizeNudge(view, 2);
    const kind = this.session(view.sessionId)?.agent_kind;
    if (kind !== "codex") return this.forceVisibleTerminalReflowViaClear(view);
    // A "guarded" candidate (skip the nudge on repeat re-triggers unless terminalTailRenderMismatch
    // actually finds something) was tried here to reduce the odd, self-healing wrap corruption reported
    // on some running codex tabs, but showed no observed difference from unconditional nudging in
    // practice and added a toggle nobody could tell apart -- removed. Always nudge; isFirstEverReflow
    // is kept only to decide how long to hide the container below, not whether to nudge at all.
    const isFirstEverReflow = !view.codexReflowEverAttempted;
    view.codexReflowEverAttempted = true;
    // Only a session's first-ever reflow can still have the SERVER's own screen repair
    // (session_manager.py _force_screen_repaint, scheduled once per session per server run) yet to
    // land -- it arrives ~0.28-0.43s later as ordinary output, a second genuine full-screen redraw from
    // the real CLI process that this function's own hide (above) never covers. Stay hidden long enough
    // to also mask that, so only one final, settled paint is ever visible; later re-triggers have no
    // such pending server-side repair to wait out, so keep their hide brief.
    const result = this.forceVisibleTerminalReflowViaResizeNudge(view, 2, isFirstEverReflow ? 600 : 0);
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
    view.codexReflowFollowupTimers = [1500, 3500, 6000].map((delay) => setTimeout(() => {
      if (view.closed || this.activeId !== view.sessionId || !view.container.classList.contains("visible")) return;
      if (!this.terminalTailRenderMismatch(view)) return;
      this.forceVisibleTerminalReflowViaResizeNudge(view, 2);
    }, delay));
  }

  forceVisibleTerminalReflowViaClear(view) {
    if (!view || view.closed || view.v2ForcedReflowFrame || !view.container.classList.contains("visible")) return false;
    if (this.shouldDeferPromptWrapFit(view)) return false;
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
  // minHideMs: keeps the container hidden for at least this long, even though this function's OWN
  // shrink/grow cycle finishes in about a frame. Reported: opening/refreshing shows content, then
  // visibly repaints a second time shortly after with identical-looking content -- almost certainly the
  // SERVER's own screen repair (session_manager.py _force_screen_repaint, ~0.28-0.43s delayed, now
  // unconditional) landing as a second, genuine full-screen redraw from the real CLI process. That
  // arrives as ordinary output (queueTerminalWrite), not through this function at all, so it was never
  // covered by the hide above. On a session's first-ever reflow (forceVisibleTerminalReflow passes a
  // longer minHideMs there), stay hidden long enough to cover that server-side window too, so only the
  // one, final, settled paint is ever visible.
  forceVisibleTerminalReflowViaResizeNudge(view, nudgeCols = 2, minHideMs = 0) {
    if (!view || view.closed || view.v2ForcedReflowFrame || view.v2ForcedReflowRestoreFrame ||
        !view.container.classList.contains("visible")) return false;
    if (this.shouldDeferPromptWrapFit(view)) return false;
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
    // The shrink/grow cycle below visibly re-wraps every on-screen line narrower and then back to
    // normal -- reported as an "everything jumps/repaints" flicker. Hide the container for the
    // duration (visibility, not display: it must keep its layout box so fit()/getBoundingClientRect()
    // still measure real geometry, and IntersectionObserver-based renderer suspension only reacts to
    // display:none, not visibility) so only the FINAL, correctly-sized result is ever actually seen.
    //
    // The hide is synchronous but the reveal depends on two requestAnimationFrame calls completing --
    // under CPU load, rAFs can stall arbitrarily, which would leave the terminal invisible for however
    // long that stall lasts and then have it "pop back" to its already-correct content once the reveal
    // finally runs. That is indistinguishable from "it cleared everything and caught back up" to a
    // user watching it happen, and was reported as exactly that right after this hide was added. A
    // bounded setTimeout safety net (not tied to rAF, so it fires even if rAF itself is what's stalled)
    // caps how long the terminal can ever stay invisible for, regardless of system load.
    const hideStartedAt = Date.now();
    view.container.style.visibility = "hidden";
    // A visibility:hidden container cannot hold focus -- if scheduleActiveEditorFocus's
    // view.term.focus() call (fired 80ms after activate(), see runScheduledActiveEditorFocus) lands
    // while this hide is still in effect, the browser silently drops it (a hidden element is not a
    // focusable area) and activeElement falls back to <body>. Nothing else ever re-requests focus once
    // this reveals, so the terminal is left unfocusable until the user clicks it a second time -- this
    // is what made a fresh/slow-loading codex tab need an extra click to type into, since only codex
    // goes through this hide/reveal cycle and a slow tab is exactly the case where the 80ms focus
    // attempt is most likely to race the hide window. Reclaim focus once actually revealed instead of
    // just restoring visibility.
    const restoreVisibility = () => { view.container.style.visibility = ""; this.reclaimTerminalFocusIfIdle(view); };
    const revealDeadline = setTimeout(restoreVisibility, minHideMs + 250);
    const revealContainer = () => {
      const remaining = minHideMs - (Date.now() - hideStartedAt);
      clearTimeout(revealDeadline);
      if (remaining > 0) setTimeout(restoreVisibility, remaining);
      else restoreVisibility();
    };
    view.v2ForcedReflowFrame = requestAnimationFrame(() => {
      view.v2ForcedReflowFrame = 0;
      if (view.closed || !view.container.classList.contains("visible")) {
        revealContainer();
        view.suppressResizeToServer = false;
        view.v2Programmatic = false;
        return;
      }
      view.container.style.right = `${nudgeRight}px`;
      view.fit.fit();
      this.refreshTerminalAppearance(view, true);
      view.v2ForcedReflowRestoreFrame = requestAnimationFrame(() => {
        view.v2ForcedReflowRestoreFrame = 0;
        if (!view.closed) {
          view.container.style.right = originalRight;
          if (view.container.classList.contains("visible")) {
            view.fit.fit();
            this.refreshTerminalAppearance(view, true);
            if (view.term.cols >= 2 && view.term.rows >= 2) this.sendResize(view, view.term.cols, view.term.rows, true);
            if (follow) this.scrollTerminalV2ToBottom(view);
            else view.term.scrollToLine(Math.min(restoreLine, view.term.buffer.active.baseY));
          }
          revealContainer();
        }
        view.suppressResizeToServer = false;
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

  drainTerminalWrites(view) {
    if (!view || view.closed || view.outputWriteInFlight) return;
    const item = view.outputQueue.shift();
    if (!item) return;
    view.outputWriteInFlight = true;
    view.term.write(item.data, () => {
      // Always release the writer. A reconnect invalidates the old callback's
      // UI work but must not strand the new connection's queued output.
      view.outputWriteInFlight = false;
      if (!view.closed && item.generation === view.outputWriteGeneration && item.afterWrite) {
        item.afterWrite();
      }
      if (!view.closed && item.generation === view.outputWriteGeneration && view.needsViewportRepair &&
          !view.outputQueue.length && view.container.classList.contains("visible")) {
        view.needsViewportRepair = false;
        this.repairTerminalViewport(view);
      }
      if (!view.closed && item.generation === view.outputWriteGeneration) this.scheduleTerminalTailRepair(view);
      this.drainTerminalWrites(view);
    });
  }

  repairTerminalViewport(view) {
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
        view.fit.fit();
        this.refreshTerminal(view);
        const { cols, rows } = view.term;
        if (cols >= 2 && rows >= 2) this.sendResize(view, cols, rows);
        this.scrollTerminalToBottom(view);
      });
    });
  }

  refreshTerminalAppearance(view, forceResize = false) {
    if (!view || !view.term) return;
    view.term.options.theme = { ...this.termTheme() };
    if (typeof view.term.clearTextureAtlas === "function") view.term.clearTextureAtlas();
    const renderService = view.term._core?._renderService;
    if (forceResize && renderService) {
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
    if (this.nativeVscodeMode) return;
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
    view.fit.fit();
    this.refreshTerminal(view);
    const { cols, rows } = view.term;
    if (cols < 2 || rows < 2) return;
    this.sendResize(view, cols, rows);
    if (view.keepBottom || Date.now() < view.pinBottomUntil) this.scheduleViewportSettle(view);
  }

  destroyView(id, view) {
    view.closed = true;
    this.clearActiveTerminalSettleWatchdog(view);
    clearTimeout(view.manualScrollReleaseTimer);
    clearTimeout(view.scrollSettleTimer);
    clearTimeout(view.resizeRepairTimer);
    clearTimeout(view.claudeInitialReplayCheckTimer);
    clearTimeout(view.promptWrapGuardTimer);
    clearTimeout(view.promptSubmissionReflowGuardTimer);
    clearTimeout(view.promptDraftSyncTimer);
    clearTimeout(view.promptDraftSyncDebounceTimer);
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
    clearTimeout(view.layoutFitRetryTimer);
    if (view.layoutObserver) view.layoutObserver.disconnect();
    if (view.scrollObserver) view.scrollObserver.disconnect();
    if (view.visibilityObserver) view.visibilityObserver.disconnect();
    if (view.ws) view.ws.close();
    view.term.dispose();
    view.container.remove();
    this.views.delete(id);
  }

  async loadSettings() {
    try {
      const res = await fetch("/api/settings");
      const incoming = await res.json();
      if (incoming.code_font_size == null) incoming.code_font_size = incoming.viewer_font_size || SETTINGS_DEFAULTS.code_font_size;
      if (incoming.side_split != null && incoming.side_split !== SETTINGS_DEFAULTS.side_split) {
        incoming.side_split_user_set = true;
      }
      if (incoming.sidebar_text_color == null) {
        const legacyColor = incoming.sidebar_status_color || incoming.wave_color;
        if (/^#[0-9a-f]{6}$/i.test(String(legacyColor || ""))) incoming.sidebar_text_color = legacyColor;
      }
      this.settings = { ...SETTINGS_DEFAULTS, ...incoming };
      this.settings.show_git_status = true;
      const searchGlobTokens = String(this.settings.search_glob || "").split(",").map((token) => token.trim()).filter(Boolean);
      if (!searchGlobTokens.includes("!*.log")) {
        this.settings.search_glob = [...searchGlobTokens, "!*.log"].join(", ");
        this.saveSettings();
      }
    } catch (err) {
      this.settings = { ...SETTINGS_DEFAULTS };
    }
    const storedFilesPinned = localStorage.getItem("termdeck.files_pinned");
    if (storedFilesPinned !== null) this.settings.files_pinned = parseModeFlag(storedFilesPinned);
    const storedSidebarColor = localStorage.getItem("termdeck.sidebar_text_color");
    const storedLegacyColor = localStorage.getItem("termdeck.sidebar_status_color") ||
      localStorage.getItem("termdeck.wave_color");
    if (/^#[0-9a-f]{6}$/i.test(storedSidebarColor || "")) this.settings.sidebar_text_color = storedSidebarColor;
    else if (/^#[0-9a-f]{6}$/i.test(storedLegacyColor || "") &&
             storedLegacyColor.toLowerCase() !== "#a5e5f0") this.settings.sidebar_text_color = storedLegacyColor;
    if (!localStorage.getItem("termdeck.sidebar_text_color") &&
        String(this.settings.sidebar_text_color || "").toLowerCase() === "#a5e5f0") {
      this.settings.sidebar_text_color = SETTINGS_DEFAULTS.sidebar_text_color;
    }
    if (!/^#[0-9a-f]{6}$/i.test(String(this.settings.sidebar_text_color || ""))) {
      this.settings.sidebar_text_color = SETTINGS_DEFAULTS.sidebar_text_color;
    }
    if (this.normalizeNotebookNotes()) this.saveSettings();
    // V2 is now the only desktop terminal scroll controller. Remove the old
    // browser-only opt-in so a previous preference cannot revive V1.
    localStorage.removeItem("termdeck.terminal_scroll_v2");
    const states = this.settings.project_state || {};
    if (!Object.keys(states).length && (this.settings.active_session_id || (this.settings.open_files || []).length)) {
      states.__all__ = { active_session_id: this.settings.active_session_id, open_files: this.settings.open_files };
      this.settings.project_state = states;
    }
    this.unreadSessions = new Set(this.getProjectState().unread_sessions || []);
    this.applySettings();
  }

  restoreOpenFiles() {
    const states = this.settings.project_state || {};
    const lists = this.projectSlug ? [this.getProjectState().open_files || []]
      : Object.values(states).map((state) => state.open_files || []);
    const files = lists.flat().slice(-OPEN_FILES_MAX_ENTRIES);
    for (const f of files) {
      if (f && f.root && f.path) {
        this.openFiles.set(`${f.root}|${f.path}`,
          { root: f.root, path: f.path, name: f.path.split("/").pop(), model: null, fullPath: null, truncated: false });
      }
    }
  }

  closeOpenFileEntry(key, entry) {
    clearTimeout(entry.autosaveTimer);
    entry.autosaveTimer = 0;
    if (entry.model) {
      entry.model.dispose();
      entry.model = null;
    }
    this.openFiles.delete(key);
    this.sidebarSelectedFileKeys.delete(key);
    if (this.sidebarFileSelectionAnchorKey === key) this.sidebarFileSelectionAnchorKey = null;
  }

  enforceOpenFilesLimit() {
    let changed = false;
    for (const [key, entry] of this.openFiles) {
      if (this.openFiles.size <= OPEN_FILES_MAX_ENTRIES) break;
      if (key === this.activeFileKey || entry.dirty || entry.savePromise) continue;
      this.closeOpenFileEntry(key, entry);
      changed = true;
    }
    return changed;
  }

  owningProjectKey(root) {
    const p = this.projects.find((x) => root === x.root || root.startsWith(x.root + "/"));
    return p ? p.name : "__all__";
  }

  isLight() {
    return this.settings.theme === "light";
  }

  termTheme() {
    return this.isLight() ? TERM_THEME_LIGHT : TERM_THEME_DARK;
  }

  applySettings() {
    const s = this.settings;
    const sidebar = this.$("sidebar");
    const filesVisible = FILES_SIDE_PANEL_TABS.includes(this.sideView);
    const normalWidth = Number(s.sidebar_width) || SETTINGS_DEFAULTS.sidebar_width;
    const fileWidth = Math.max(Number(s.files_width) || 0, normalWidth * 2);
    const activeSidebarWidth = filesVisible && s.files_pinned ? fileWidth : normalWidth;
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
    this.positionFloatingFilesPanel(fileWidth);
    document.documentElement.style.setProperty("--sidebar-font-size", s.sidebar_font_size + "px");
    document.documentElement.style.setProperty("--ui-font-size", s.ui_font_size + "px");
    document.documentElement.style.setProperty("--code-font-size", s.code_font_size + "px");
    document.documentElement.style.setProperty("--sidebar-text-color", s.sidebar_text_color);
    this.updateSessionAgeStyles();
    const codeFontSize = Number(s.code_font_size) || SETTINGS_DEFAULTS.code_font_size;
    const configuredDiffFontSize = Number(s.diff_font_size) || SETTINGS_DEFAULTS.diff_font_size;
    const relativeDiffFontSize = configuredDiffFontSize === SETTINGS_DEFAULTS.diff_font_size
      ? Math.max(8, codeFontSize - 1)
      : Math.min(configuredDiffFontSize, Math.max(8, codeFontSize - 1));
    document.documentElement.style.setProperty("--diff-font-size", relativeDiffFontSize + "px");
    document.documentElement.style.setProperty("--tree-font-size", s.tree_font_size + "px");
    document.body.classList.toggle("theme-light", this.isLight());
    for (const view of this.views.values()) {
      if (view.term.options.fontSize !== s.terminal_font_size) view.term.options.fontSize = s.terminal_font_size;
      this.refreshTerminalAppearance(view);
    }
    if (this.editor) {
      this.editor.updateOptions({ fontSize: s.code_font_size, wordWrap: s.word_wrap ? "on" : "off" });
      monaco.editor.setTheme(this.isLight() ? "termdeck-light" : "termdeck-dark");
    }
    if (this.notebookEditor) {
      this.notebookEditor.updateOptions({ fontSize: s.code_font_size, wordWrap: s.word_wrap ? "on" : "off" });
      this.notebookEditor.layout();
    }
    if (this.fileHistoryCurrentEditor) {
      this.fileHistoryCurrentEditor.updateOptions({ fontSize: s.code_font_size, wordWrap: s.word_wrap ? "on" : "off" });
      this.fileHistoryCurrentEditor.layout();
    }
    if (this.fileHistoryDiffEditor) {
      this.fileHistoryDiffEditor.updateOptions({ fontSize: s.code_font_size, wordWrap: s.word_wrap ? "on" : "off" });
      this.fileHistoryDiffEditor.getOriginalEditor().updateOptions({ fontSize: s.code_font_size, wordWrap: s.word_wrap ? "on" : "off" });
      this.fileHistoryDiffEditor.getModifiedEditor().updateOptions({ fontSize: s.code_font_size, wordWrap: s.word_wrap ? "on" : "off" });
      this.fileHistoryDiffEditor.layout();
    }
    this.$("stat-text").classList.toggle("hidden", !s.show_stats);
    this.$("stat-spark").classList.toggle("hidden", !s.show_stats);
    this.fitActive();
  }

  initMonaco() {
    this.monacoReady = new Promise((resolve) => {
      require.config({ paths: { vs: "/static/vendor/monaco/vs" } });
      require(["vs/editor/editor.main"], () => {
        monaco.editor.defineTheme("termdeck-dark", {
          base: "vs-dark", inherit: true, rules: [],
          colors: { "editor.background": "#101418", "editorGutter.background": "#101418" },
        });
        monaco.editor.defineTheme("termdeck-light", { base: "vs", inherit: true, rules: [], colors: {} });
        this.editor = monaco.editor.create(this.$("monaco-host"), {
          readOnly: false, theme: this.isLight() ? "termdeck-light" : "termdeck-dark",
          automaticLayout: true, minimap: { enabled: false },
          scrollBeyondLastLine: false, fontSize: this.settings.code_font_size, lineNumbersMinChars: 4,
          renderLineHighlight: "all", folding: true, wordWrap: this.settings.word_wrap ? "on" : "off", fixedOverflowWidgets: true,
        });
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
          contextMenuOrder: 1.5, keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.F12],
          run: () => this.showEditorUsages(),
        });
        const notebookHost = this.$("notebook-editor-host");
        if (notebookHost) {
          notebookHost.textContent = "";
          this.notebookEditor = monaco.editor.create(notebookHost, {
            readOnly: false, theme: this.isLight() ? "termdeck-light" : "termdeck-dark",
            automaticLayout: true, minimap: { enabled: false }, scrollBeyondLastLine: false,
            fontSize: this.settings.code_font_size, lineNumbersMinChars: 2, lineDecorationsWidth: 8, glyphMargin: false,
            renderLineHighlight: "all", folding: true, wordWrap: this.settings.word_wrap ? "on" : "off",
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
      fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" },
                               body: JSON.stringify(this.settings) }).catch(() => {});
    }, 400);
  }

  openSettingsPopover(anchor, items) {
    const pop = this.$("settings-popover");
    pop.textContent = "";
    for (const item of items) {
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
      value.textContent = this.settings[item.key];
      const plus = document.createElement("button");
      plus.textContent = "+";
      minus.onclick = () => { this.bumpSetting(item.key, -1); value.textContent = this.settings[item.key]; };
      plus.onclick = () => { this.bumpSetting(item.key, 1); value.textContent = this.settings[item.key]; };
      controls.append(minus, value, plus);
      row.append(label, controls);
      pop.appendChild(row);
    }
    pop.appendChild(this.buildToggleRow("Theme", () => this.settings.theme,
      () => { this.settings.theme = this.isLight() ? "dark" : "light"; }));
    pop.appendChild(this.buildToggleRow("Stats", () => (this.settings.show_stats ? "shown" : "hidden"),
      () => { this.settings.show_stats = !this.settings.show_stats; }));
    pop.appendChild(this.buildToggleRow("Terminal icons", () => (this.settings.show_terminal_icons ? "on" : "off"),
      () => { this.settings.show_terminal_icons = !this.settings.show_terminal_icons; this.renderList(); }));
    pop.appendChild(this.buildToggleRow("Terminal age colors", () => (this.settings.show_terminal_age ? "on" : "off"),
      () => { this.settings.show_terminal_age = !this.settings.show_terminal_age; }));
    pop.appendChild(this.buildToggleRow("Editor wrap", () => (this.settings.word_wrap ? "on" : "off"),
      () => { this.settings.word_wrap = !this.settings.word_wrap; }));
    pop.appendChild(this.buildToggleRow("Prompt wrap fix (test)", () => (this.settings.prompt_wrap_guard ? "on" : "off"),
      () => { this.settings.prompt_wrap_guard = !this.settings.prompt_wrap_guard; }));
    pop.appendChild(this.buildToggleRow("Markdown transcript mode", () => (this.settings.history_mode ? "on" : "off"),
      () => { this.setHistoryMode(!this.settings.history_mode); }));
    pop.appendChild(this.buildActionRow("Keyboard shortcuts", "edit", () => { pop.classList.add("hidden"); this.openKeybindings(); }));
    pop.appendChild(this.buildActionRow("Export settings", "download", () => { pop.classList.add("hidden"); this.exportSettings(); }));
    pop.appendChild(this.buildActionRow("Terminal process report", "view", () => {
      void this.showTerminalProcessReport();
    }));
    pop.appendChild(this.buildActionRow("Reclaim orphan terminals", "clean", () => {
      pop.classList.add("hidden");
      void this.reclaimOrphanTerminals();
    }));
    pop.appendChild(this.buildActionRow("Kill all running terminals", "kill", () => {
      pop.classList.add("hidden");
      void this.killAllRunningTerminals();
    }));
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

  buildToggleRow(labelText, valueText, flip) {
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
    };
    row.append(label, button);
    return row;
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
      const move = (ev) => {
        const width = fromRight ? window.innerWidth - ev.clientX : ev.clientX;
        const resizingFiles = handleId === "sidebar-resizer" && this.settings.files_pinned &&
          FILES_SIDE_PANEL_TABS.includes(this.sideView);
        const targetKey = resizingFiles ? "files_width" : key;
        const targetMin = resizingFiles
          ? Math.max(minWidth, (Number(this.settings.sidebar_width) || SETTINGS_DEFAULTS.sidebar_width) * 2)
          : minWidth;
        const targetMax = resizingFiles ? Math.max(maxWidth, Math.floor(window.innerWidth * 0.75)) : maxWidth;
        this.settings[targetKey] = Math.max(targetMin, Math.min(targetMax, Math.round(width)));
        this.applySettings();
      };
      const up = () => {
        document.body.classList.remove("dragging");
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
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
    this.applySettings();
    this.saveSettings();
  }

  async reloadTree(rootOverride) {
    const s = this.session(this.activeId);
    this.treeRoot = rootOverride || (s ? s.cwd : (this.projectRoot() || "~"));
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
      if (!this.treeFilterAllows(childRel, entry.is_dir)) continue;
      const row = document.createElement("div");
      row.className = "tree-row " + (entry.is_dir ? "dir" : "file") + (excluded ? " excluded" : "");
      row.tabIndex = 0;
      row.title = `${this.treeRoot}/${childRel}`;
      row.dataset.metadata = this.treeRowMetadataKey(entry);
      const name = document.createElement("span");
      name.className = "tree-name";
      name.textContent = entry.name;
      if (entry.is_dir) {
        const chevron = document.createElement("span");
        chevron.className = "codicon codicon-chevron-right tree-chevron";
        const icon = document.createElement("img");
        icon.className = "tree-type-icon tree-folder-icon";
        icon.src = MATERIAL_ICONS_BASE + "folder.svg";
        row.append(chevron, icon, name);
        row.dataset.rel = childRel;
        row.dataset.kind = "dir";
        row.onclick = () => this.toggleDir(row, childRel);
        this.appendMtime(row, entry);
        this.appendGitStatus(row, entry);
        container.appendChild(row);
        if (this.expandedDirs.has(childRel)) await this.expandDirRow(row, childRel);
      } else {
        const spacer = document.createElement("span");
        spacer.className = "tree-file-spacer";
        row.append(spacer, this.fileTypeIconEl(entry.name, "tree-type-icon"), name);
        row.dataset.rel = childRel;
        row.dataset.kind = "file";
        row.onclick = () => this.openFile(this.treeRoot, childRel, null, row);
        this.appendMtime(row, entry);
        this.appendGitStatus(row, entry);
        container.appendChild(row);
      }
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
    const totalMinutes = Math.max(0, Math.floor((Date.now() - new Date(epochSeconds * 1000).getTime()) / 60000));
    const totalHours = Math.floor(totalMinutes / 60);
    const totalDays = Math.floor(totalHours / 24);
    const totalWeeks = Math.floor(totalDays / 7);
    const totalMonths = Math.floor(totalWeeks / 4);
    const items = totalMonths >= 12 ? [[Math.floor(totalMonths / 12), "y"], [totalMonths % 12, "m"]] :
      totalMonths ? [[totalMonths, "m"], [totalWeeks % 4, "w"]] : totalWeeks ? [[totalWeeks, "w"], [totalDays % 7, "d"]] :
      totalDays ? [[totalDays, "d"], [totalHours % 24, "h"]] : totalHours ? [[totalHours, "h"], [totalMinutes % 60, "m"]] : [[totalMinutes, "m"]];
    return `${items.filter(([value]) => value > 0).map(([value, suffix]) => `${value}${suffix}`).join(" ") || "0m"} ago`;
  }

  exactMtime(epochSeconds) {
    const date = new Date(epochSeconds * 1000);
    return `${date.toLocaleString()} (${date.toISOString()})`;
  }

  async expandDirRow(row, relPath) {
    row.classList.add("open");
    row.querySelector(".tree-folder-icon").src = MATERIAL_ICONS_BASE + "folder-open.svg";
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
      row.querySelector(".tree-folder-icon").src = MATERIAL_ICONS_BASE + "folder.svg";
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
    this.refreshRecentFiles();
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
      else this.openFile(this.treeRoot, rel, null, current);
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
        const params = new URLSearchParams();
        if (update.projectKey !== "__all__") params.set("project", update.projectKey);
        const response = await fetch(`/api/terminal-layout?${params}`, { method: "PATCH", keepalive: true,
          headers: { "Content-Type": "application/json" }, body: JSON.stringify({ open_files: update.openFiles }) });
        if (!response.ok) throw new Error(`server returned ${response.status}`);
      }
    }).catch((error) => { this.$("stat-text").textContent = `Could not persist open files: ${error.message}`; });
  }

  async openFile(root, path, line, treeRow, options = {}) {
    const key = `${root}|${path}`;
    if (!this.openFiles.has(key)) {
      this.openFiles.set(key, { root, path, name: path.split("/").pop(), model: null, fullPath: null, truncated: false });
    } else {
      const entry = this.openFiles.get(key);
      this.openFiles.delete(key);
      this.openFiles.set(key, entry);
    }
    this.enforceOpenFilesLimit();
    this.persistOpenFiles();
    this.markTreeSelection(treeRow || null);
    const entry = this.openFiles.get(key);
    const returnTo = typeof options.returnTo === "string" ? options.returnTo.trim() : "";
    await this.activateFile(key, line, { returnTo });
    const openedFromFilePanel = !!treeRow || !!options.fromFilePanel;
    if (openedFromFilePanel && !this.settings.files_pinned && entry.model && this.sideView !== "terminals") {
      this.setSideView("terminals", false);
    }
  }

  positionPopover(pop, anchor) {
    const rect = anchor.getBoundingClientRect();
    pop.classList.remove("hidden");
    const below = rect.bottom + 6;
    const top = below + pop.offsetHeight > window.innerHeight - 8 ? rect.top - pop.offsetHeight - 6 : below;
    pop.style.top = Math.max(8, top) + "px";
    pop.style.left = Math.min(rect.left, window.innerWidth - pop.offsetWidth - 12) + "px";
  }

  async activateFile(key, line, options = {}) {
    const entry = this.openFiles.get(key);
    if (!entry) return;
    this.closePromptHistory();
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
        this.pushNav({ kind: "term", id: returnTo });
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
    if (line) {
      this.editor.revealLineInCenter(line);
      this.editor.setPosition({ lineNumber: line, column: 1 });
    }
    this.renderList();
    this.renderTopbar();
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
        entry.dirty = true;
        this.scheduleFileAutosave(entry);
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
        } else if (entry.model && !entry.autosaveTimer) {
          this.scheduleFileAutosave(entry);
        }
        if (this.fileHistoryOpen && this.activeFileKey !== null && this.openFiles.get(this.activeFileKey) === entry) {
          void this.loadFileHistory();
        }
        if (this.enforceOpenFilesLimit()) this.persistOpenFiles();
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
        return;
      }
      this.activeFileKey = null;
      this.applyMainLayout();
      const view = this.views.get(this.activeId);
      if (view) view.term.focus();
      this.replaceNav(this.activeId ? { kind: "term", id: this.activeId } : { kind: "init" });
    }
    this.renderList();
    this.renderTopbar();
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

  handleVscodeFileLink(event) {
    if (!this.vscodeMode) return;
    const anchor = event.target.closest?.("a");
    if (!anchor) return;
    const parsed = this.parseVscodeFileLink(anchor.getAttribute("href"));
    if (!parsed) return;
    event.preventDefault();
    event.stopPropagation();
    const session = this.session(this.activeId);
    this.postVscodeFileOpen(parsed.path, parsed.line, parsed.column, session?.cwd || this.projectRoot() || "");
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

  openModal(groupId = null) {
    this.modalGroupId = !this.vscodeMode && groupId && this.terminalGroups().some((group) => group.id === groupId)
      ? groupId : null;
    const model = this.settings.last_model || DEFAULT_COMMAND;
    this.$("modal-model").value = MODEL_PERMISSIONS[model] ? model : DEFAULT_COMMAND;
    this.updateModalPermissions();
    this.updateModalSessionSuggestions();
    this.$("modal-project-add-btn").classList.toggle("hidden", !!this.vscodeMode);
    this.$("modal-session-title").value = "";
    this.$("modal-cwd").value = this.resolveVscodeDefaultCwd();
    this.$("modal-cwd").dataset.projectSeeded = "0";
    this.$("modal-backdrop").classList.remove("hidden");
    this.$("modal-session-title").focus();
  }

  closeModal() {
    this.modalGroupId = null;
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
    const targetGroupId = this.modalGroupId;
    const model = this.$("modal-model").value;
    const permission = this.$("modal-permission").value;
    const resolved = this.resolveSessionNameAndReference(model, this.$("modal-session-title").value);
    const { title, session_ref: sessionRef } = resolved;
    const rawCwd = this.$("modal-cwd").value.trim();
    const cwd = this.vscodeMode ? rawCwd || this.resolveVscodeDefaultCwd() : rawCwd;
    let project = "";
    if (cwd) {
      const projectResponse = await fetch("/api/projects", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root: cwd }),
      });
      const projectPayload = await projectResponse.json().catch(() => ({}));
      if (!projectResponse.ok) {
        alert(projectPayload.detail || "failed to register project folder");
        return;
      }
      if (projectPayload && projectPayload.name) {
        project = projectPayload.name;
      }
    }
    if (!project) project = this.projectForCwd(cwd)?.name || "";
    this.settings.last_model = model;
    this.settings.last_permissions = { ...(this.settings.last_permissions || {}), [model]: permission };
    this.saveSettings();
    // Land the new terminal directly below the one in focus rather than at the end of the sidebar.
    // An explicitly chosen group already dictates placement, so it wins.
    const anchorSessionId = !targetGroupId && this.activeId && this.session(this.activeId) ? this.activeId : null;
    const res = await fetch("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, permission, session_ref: sessionRef, cwd, title,
        project }),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      alert(detail.detail || "failed to create session");
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
      this.patchProjectState({
        session_groups: { ...(state.session_groups || {}), [created.session_id]: targetGroupId },
        terminal_layout: this.terminalLayout().filter((entry) => entry !== `session:${created.session_id}`),
      });
      this.renderList();
    } else if (anchorSessionId && this.session(anchorSessionId) && this.session(created.session_id)) {
      this.repositionSelectedSessions([created.session_id], anchorSessionId, true);
    }
    this.activate(created.session_id, { reveal: true });
  }

  openKeybindings() {
    const list = this.$("keys-list");
    list.textContent = "";
    for (const k of this.keybindingDefinitions()) {
      const row = document.createElement("div");
      row.className = "keys-row";
      const label = document.createElement("span");
      label.className = "keys-label";
      label.textContent = k.label;
      const bind = document.createElement("button");
      bind.className = "keys-bind";
      bind.textContent = this.bindingToDisplay(this.bindingFor(k.id));
      bind.onclick = () => this.captureBinding(k.id, bind);
      row.append(label, bind);
      list.appendChild(row);
    }
    const ref = this.$("keys-reference");
    ref.textContent = "";
    for (const r of (this.vscodeMode ? VSCODE_REFERENCE_KEYS : REFERENCE_KEYS)) {
      const row = document.createElement("div");
      row.className = "keys-row builtin";
      const lbl = document.createElement("span");
      lbl.className = "keys-label";
      lbl.textContent = r.label;
      const bind = document.createElement("button");
      bind.className = "keys-bind builtin";
      bind.textContent = r.keys;
      bind.disabled = true;
      bind.setAttribute("aria-disabled", "true");
      row.append(lbl, bind);
      list.appendChild(row);
    }
    this.$("keys-backdrop").classList.remove("hidden");
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

  async showTerminalProcessReport() {
    try {
      const response = await fetch("/api/terminals/processes");
      if (response.status === 404) {
        throw new Error("available after the next planned TermDeck server restart");
      }
      if (!response.ok) throw new Error(`report request failed: ${response.status}`);
      const report = await response.json();
      const summary = report.summary || {};
      const entries = Array.isArray(report.sockets) ? report.sockets : [];
      const lines = entries.map((entry) => {
        const name = entry.known_session ? (entry.title || entry.session_id) : `orphan ${entry.session_id}`;
        const mode = entry.live ? entry.detached ? "detached" : "attached" : "stale";
        return `• ${name}: ${mode}, ${(entry.processes || []).length} processes`;
      });
      const header = `${summary.live_sockets || 0} live socket${summary.live_sockets === 1 ? "" : "s"} · ` +
        `${summary.processes || 0} processes · ${summary.node_repl_processes || 0} node_repl · ` +
        `${summary.zombie_processes || 0} zombies · ${summary.orphan_sockets || 0} orphan sockets`;
      this.$("status-name").textContent = header;
      window.alert(["TermDeck terminal process report", "", header, "", ...lines].join("\n"));
    } catch (error) {
      this.$("status-name").textContent = `unable to load terminal process report: ${error.message}`;
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
      const confirmed = window.confirm(`Reclaim ${orphans.length} orphaned TermDeck socket${orphans.length === 1 ? "" : "s"}? ` +
        "This terminates only processes reachable from those unlisted TermDeck sockets.");
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

  isDesktopTerminalSelectAllEvent(e) {
    return !this.vscodeMode && e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey &&
      (e.code === "KeyA" || String(e.key || "").toLowerCase() === "a") &&
      this.activeFileKey === null && !this.historyOpen && !!this.views.get(this.activeId);
  }

  bindingFor(actionId) {
    const definition = this.keybindingDefinitions().find((k) => k.id === actionId);
    return (this.settings[this.keybindingsStorageKey()] || {})[actionId] || definition?.def || "";
  }

  bindingMap() {
    const map = {};
    for (const k of this.keybindingDefinitions()) map[this.bindingFor(k.id)] = k.id;
    return map;
  }

  tryAppShortcut(e) {
    if (!this.vscodeMode && e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey) {
      const key = e.key.toLowerCase();
      if (key === "e") {
        e.preventDefault();
        e.stopPropagation();
        this.focusFileNameSearch();
        return true;
      }
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
    const binding = this.eventToBinding(e);
    if (!binding) return false;
    const actionId = this.bindingMap()[binding];
    if (!actionId) return false;
    if (["selection-copy", "selection-note-new", "selection-note-append"].includes(actionId) &&
        !this.readSelectionActionState()) return false;
    e.preventDefault();
    e.stopPropagation();
    this.runAction(actionId);
    return true;
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
    else if (actionId === "new-group") this.createTerminalGroup();
    else if (actionId === "close-item") this.closeActiveItem();
    else if (actionId === "fork-terminal") { const s = this.session(this.activeId); if (s) this.forkSession(s); }
    else if (actionId === "restart-terminal") { if (this.activeId) this.restartSession(this.activeId); }
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
    else if (actionId === "save-file") { if (this.activeFileKey !== null) this.saveActiveFile(); }
    else if (actionId === "prev-terminal") this.cycleTerminal(-1);
    else if (actionId === "next-terminal") this.cycleTerminal(1);
    else if (actionId === "cycle-side-panel") this.cycleFilesSidePanel();
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
    return binding.split("+").map((p) => ({ Meta: "⌘", Shift: "⇧", Alt: "⌥", Ctrl: "⌃",
      ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Backspace: "⌫", Enter: "⏎", Escape: "esc" }[p] || p.toUpperCase())).join("");
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
    this.patchProjectState(patch);
  }

  async forkSession(s) {
    const suggestion = this.effectiveTitle(s) + " fork";
    const title = prompt(`Name for the forked terminal (branches ${s.agent_kind !== "none" ? s.agent_kind + " session" : "the shell"})`, suggestion);
    if (!title) return;
    const res = await fetch(`/api/sessions/${s.session_id}/fork`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (!res.ok) { alert("fork failed"); return; }
    const created = await res.json();
    if (this.nativeVscodeMode) this.postVscodeNativeSession(created, true);
    this.applyForkPlacement(s.session_id, [created]);
    await this.refresh();
    this.activate(created.session_id, { reveal: true });
    const view = this.views.get(created.session_id);
    if (view) view.pinBottomUntil = Date.now() + 8000;
  }

  async forkSessionMultiple(s) {
    const baseTitle = this.effectiveTitle(s) || "terminal";
    const rawCount = prompt(`How many terminals should be forked from "${baseTitle}"?`, "3");
    if (rawCount === null) return;
    const normalizedCount = rawCount.trim();
    const count = Number.parseInt(normalizedCount, 10);
    if (!/^\d+$/.test(normalizedCount) || count < 1 || count > 50) {
      alert("Enter a whole number from 1 to 50.");
      return;
    }
    const created = [];
    let failedAt = 0;
    for (let index = 1; index <= count; index += 1) {
      const res = await fetch(`/api/sessions/${s.session_id}/fork`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: `${baseTitle} ${index}` }),
      });
      if (!res.ok) {
        failedAt = index;
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
    this.$("status-name").textContent = failedAt
      ? `forked ${created.length} of ${count} terminals`
      : `forked ${created.length} terminals`;
    if (failedAt) alert(`Forked ${created.length} of ${count}; fork ${failedAt} failed.`);
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
    const nextOnClose = closeIndex >= 0 && closeIndex + 1 < closeOrder.length ? closeOrder[closeIndex + 1]
      : closeIndex > 0 ? closeOrder[closeIndex - 1] : null;
    const response = await fetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      this.$("status-name").textContent = detail.detail || "terminal process cleanup did not complete";
      return;
    }
    this.postVscodeNativeClose(sessionId);
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
    const nextSession = this.sessions.slice(activeIndex + 1).find((session) => !selectedIds.has(session.session_id)) ||
      this.sessions.slice(0, Math.max(activeIndex, 0)).reverse().find((session) => !selectedIds.has(session.session_id)) || null;
    const results = await Promise.all(selectedSessions.map(async (session) => ({ session,
      response: await fetch(`/api/sessions/${session.session_id}`, { method: "DELETE" }) })));
    const closedIds = results.filter((result) => result.response.ok).map((result) => result.session.session_id);
    for (const sessionId of closedIds) this.postVscodeNativeClose(sessionId);
    this.sidebarSelectedSessionIds = new Set([...this.sidebarSelectedSessionIds]
      .filter((sessionId) => !closedIds.includes(sessionId)));
    await this.refresh();
    if (activeWasSelected && nextSession && this.session(nextSession.session_id)) {
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
    const projectRoot = this.projectRoot();
    if (projectRoot) return projectRoot;
    const s = this.session(this.activeId);
    return s ? s.cwd : "~";
  }

  loadSearchHistory() {
    const raw = localStorage.getItem(SEARCH_HISTORY_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    this.searchHistory = parsed.filter((entry) => entry && typeof entry.q === "string" &&
      (entry.mode === "content" || entry.mode === "name")).slice(-30);
  }

  saveSearchHistory() {
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
    this.$("search-glob").value = entry.glob || "";
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
    const glob = this.$("search-glob")?.value.trim() || "";
    const ignore = this.searchIgnoreTokens();
    const params = new URLSearchParams({ root: entry.root, q: this.editorSymbolDefinitionPattern(word, entry.path),
      glob, ignore, word: "false", case_sensitive: "true", regex: "true" });
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
    this.$("search-glob").value = prev.glob;
    if (this.sideView !== "search") {
      this.sideView = "terminals";
      this.setSideView("search");
    }
    this.runSearch(prev.q, true);
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

  compactSearchDirectoryChain(directory) {
    const chain = [directory];
    let terminal = directory;
    while (!terminal.files.length && terminal.directories.size === 1) {
      terminal = [...terminal.directories.values()][0];
      chain.push(terminal);
    }
    return { chain, terminal };
  }

  appendCompactSearchPath(row, path, isDirectory) {
    const parts = String(path || "").split("/").filter(Boolean);
    const visibleParts = isDirectory ? parts : parts.slice(0, -1);
    for (const [index, part] of visibleParts.entries()) {
      row.appendChild(this.createCompactSearchPathPart(part));
      if (index < visibleParts.length - 1 || !isDirectory) {
        const separator = document.createElement("span");
        separator.className = "search-tree-path-separator";
        separator.textContent = "›";
        row.appendChild(separator);
      }
    }
    if (!isDirectory) {
      const file = document.createElement("span");
      file.className = "search-file-name";
      file.textContent = parts[parts.length - 1] || "";
      row.appendChild(file);
    }
  }

  createCompactSearchPathPart(part, includeTreeName = false) {
    const folder = document.createElement("span");
    folder.className = includeTreeName ? "tree-name search-tree-path-part" : "search-tree-path-part";
    folder.textContent = part;
    folder.title = part;
    const width = `${Math.min(Array.from(String(part)).length, 4)}ch`;
    folder.style.width = width;
    folder.style.flexBasis = width;
    return folder;
  }

  renderContentSearchHierarchy(node, container, root) {
    const directories = [...node.directories.values()].sort((a, b) => String(a.name).localeCompare(String(b.name), undefined,
      { numeric: true, sensitivity: "base" }));
    for (const directory of directories) {
      const compacted = this.compactSearchDirectoryChain(directory);
      const terminal = compacted.terminal;
      const row = document.createElement("div");
      row.className = "tree-row dir search-tree-row search-tree-directory open";
      row.tabIndex = 0;
      row.title = `${root}/${terminal.path}`;
      const chevron = document.createElement("span");
      chevron.className = "codicon codicon-chevron-right tree-chevron";
      const icon = document.createElement("img");
      icon.className = "tree-type-icon tree-folder-icon";
      icon.src = MATERIAL_ICONS_BASE + "folder-open.svg";
      row.append(chevron, icon);
      compacted.chain.forEach((part, index) => {
        const name = this.createCompactSearchPathPart(part.name, true);
        row.appendChild(name);
        if (index < compacted.chain.length - 1) {
          const separator = document.createElement("span");
          separator.className = "search-tree-path-separator";
          separator.textContent = "›";
          row.appendChild(separator);
        }
      });
      const children = document.createElement("div");
      children.className = "tree-children-wrap search-tree-children";
      row.onclick = () => {
        const open = row.classList.toggle("open");
        children.classList.toggle("hidden", !open);
        icon.src = MATERIAL_ICONS_BASE + (open ? "folder-open.svg" : "folder.svg");
      };
      container.append(row, children);
      this.renderContentSearchHierarchy(terminal, children, root);
    }
    const files = [...node.files].sort((a, b) => this.compareSearchFiles(a, b));
    for (const file of files) {
      const fileRow = document.createElement("div");
      fileRow.className = "tree-row file search-file search-tree-row search-tree-file";
      fileRow.tabIndex = 0;
      fileRow.title = `${root}/${file.path}`;
      const spacer = document.createElement("span");
      spacer.className = "tree-file-spacer";
      const fileName = document.createElement("span");
      fileName.className = "search-file-name tree-name";
      fileName.textContent = String(file.path).split("/").pop();
      fileRow.append(spacer, this.fileTypeIconEl(fileName.textContent, "tree-type-icon"), fileName);
      fileRow.onclick = () => this.openFile(root, file.path, file.hits[0]?.line || null, null, { fromFilePanel: true });
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
        text.textContent = hit.text;
        hitRow.append(line, text);
        hitRow.title = `${hit.path}:${hit.line}`;
        hitRow.onclick = (event) => {
          event.stopPropagation();
          this.openFile(root, hit.path, hit.line, null, { fromFilePanel: true });
        };
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
      const state = { mode: "content", q: query, glob: this.$("search-glob").value.trim(),
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
    const globParts = this.$("search-glob").value.split(",").map((g) => g.trim()).filter(Boolean);
    const ignore = this.searchIgnoreTokens();
    const params = new URLSearchParams({ root, q: query, glob: globParts.join(","), ignore,
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
    const hierarchy = this.buildContentSearchHierarchy(files);
    this.contentSearchTree = { root, paths: new Set(files.map((file) => file.path)), directories: hierarchy.directories };
    this.renderContentSearchHierarchy(hierarchy.root, resultsEl, root);
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

  debouncedSearch() {
    clearTimeout(this.searchDebounce);
    const query = this.$("search-query").value.trim();
    if (!query) {
    this.$("search-results").textContent = "";
    this.clearFileSearchSelection("content");
    this.contentSearchTree = null;
    this.treeSearchFilter = null;
      return;
    }
    this.searchDebounce = setTimeout(() => this.runSearch(), SEARCH_DEBOUNCE_MS);
  }

  fileSearchResultRows(mode) {
    const container = this.$(mode === "name" ? "name-results" : "search-results");
    const selector = mode === "name" ? ".search-file.clickable" : ".search-hit";
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
    if (!confirm(`Replace ALL matches of "${query}" with "${replacement}" across the project?\n` +
                 "This edits files on disk (respects filters/excludes; capped at 200 files).")) return;
    const res = await fetch("/api/files/replace", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root: this.searchRoot(), q: query, glob: this.$("search-glob").value.trim(),
                             ignore: this.searchIgnoreTokens(),
                             word: this.searchWord, case_sensitive: this.searchCase, regex: this.searchRegex,
                             replacement }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(err.detail || "replace failed");
      return;
    }
    const result = await res.json();
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
    if (!skipRecord) this.recordSearch({ mode: "name", q: query, glob: this.$("search-glob").value.trim(), case_sensitive: this.nameSearchCase });
    const loading = document.createElement("div");
    loading.className = "search-summary";
    loading.textContent = "loading project files…";
    resultsEl.appendChild(loading);
    const root = this.searchRoot();
    const ignore = this.searchIgnoreTokens();
    const glob = this.$("search-glob").value.trim();
    const res = await fetch(`/api/files/find?${new URLSearchParams({ root, q: query, glob, ignore, case_sensitive: this.nameSearchCase ? "true" : "false" })}`);
    if (!res.ok) return;
    const hits = await res.json();
    if (generation !== this.nameSearchGeneration) return;
    const orderedHits = [...hits].sort((a, b) => this.compareSearchFiles(a, b));
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
    for (const hit of orderedHits) {
      const row = document.createElement("div");
      row.className = "search-file clickable";
      row.tabIndex = 0;
      row.title = hit.path;
      const icon = hit.is_dir ? document.createElement("span") : this.fileTypeIconEl(hit.path.split("/").pop(), "file-type-icon");
      if (hit.is_dir) {
        icon.className = "codicon codicon-folder file-type-icon";
        icon.setAttribute("aria-hidden", "true");
      }
      row.append(icon);
      this.appendCompactSearchPath(row, hit.path, hit.is_dir);
      this.appendMtime(row, hit);
      this.appendGitStatus(row, hit);
      row.onclick = () => hit.is_dir ? this.openNameDirectory(root, hit.path) :
        this.openFile(root, hit.path, null, null, { fromFilePanel: true });
      row.onmouseenter = () => this.selectFileSearchResult("name", row, { reveal: false });
      resultsEl.appendChild(row);
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
      const x = i * step, y = h - 1 - (p.rss / maxRss) * (h - 3);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.strokeStyle = this.cssVar("--accent");
    ctx.beginPath();
    this.statHistory.forEach((p, i) => {
      const x = i * step, y = h - 1 - (p.cpu / maxCpu) * (h - 3);
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
