// Status/title/processing changes arrive through /ws/status. This slower
// fallback only reconciles session-list metadata such as created/closed tabs.
const SESSION_LIST_REFRESH_MS = 30000;
const TITLE_STATUS_RE = /^[\u2800-\u28ff○-◗⏳⚡✳](\s+)/;
const RECONNECT_MS = 1500;
const DEFAULT_COMMAND = "codex";
const DEFAULT_CWD = "~";
const SETTINGS_DEFAULTS = { sidebar_width: 250, files_width: 380, sidebar_font_size: 13, terminal_font_size: 13,
  ui_font_size: 11, code_font_size: 12, diff_font_size: 13, tree_font_size: 12, active_session_id: "", open_files: [], project_state: {}, theme: "dark",
  ignored_dirs: [], hide_excluded: false, side_split: 0.55, side_full: false, side_split_user_set: false, show_stats: true,
  show_mtime: true, show_git_status: true, recent_exclude: "", word_wrap: false, search_glob: "!*.json, !*.csv", keybindings: {},
  last_command: "codex", last_model: "codex", last_permissions: { codex: "default", claude: "default", none: "default" },
  show_terminal_icons: false, compact_terminal_icons: false, history_mode: false, notebook_open: false, notebook_left: -1, notebook_text: "",
  notebook_notes: [], notebook_active_note_id: "", notebook_notes_initialized: false,
  files_pinned: false, sidebar_text_color: "#d5dbe5", vscode_keybindings: {} };
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
  none: [{ value: "default", label: "Shell permissions" }],
};
const EXT_PRIORITY = ["py", "ipynb", "js", "ts", "tsx", "jsx", "go", "rs", "java", "c", "h", "cpp", "hpp", "sh", "zsh",
  "md", "rst", "txt", "html", "css", "sql", "yaml", "yml", "toml", "ini", "cfg", "xml", "json", "csv", "log"];
const SEARCH_DEBOUNCE_MS = 500;
const TERMINAL_SEARCH_DEBOUNCE_MS = 250;
const SESSION_GROUP_HOVER_DELAY_MS = 700;
const CLOSED_SESSIONS_INITIAL_DISPLAY = 50;
const CLOSED_SESSIONS_MAX_DISPLAY = 100;
const ACTIVITY_SORT_BUCKET_MS = 15 * 60 * 1000;
const TERMINAL_TAIL_REPAIR_LINES = 16;
const TERMINAL_ACTIVATION_REFLOW_IDLE_MS = 1200;
const OPEN_FILES_MAX_ENTRIES = 80;
const TERMINAL_V2_FIT_RETRY_LIMIT = 32;
const TERMINAL_V2_FIT_RETRY_DELAY_MS = 140;
// Three checks, well spread out, not five packed inside the first 600ms: each forced resize is a real
// SIGWINCH even when nothing actually changed (see scheduleActiveTerminalSettleWatchdog), and a tight
// burst of those landing while an agent CLI is mid-redraw of a multi-line composer can visibly corrupt
// it. Spreading them out keeps the same retry-safety property (still self-corrects a resize the server
// silently dropped) while cutting how often two land close enough together to overlap a single redraw.
const TERMINAL_ACTIVE_SETTLE_DELAYS_MS = [150, 800, 2000];
const TERMINAL_DEBUG_SNAPSHOT_LIMIT = 50;
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
  { id: "view-files", label: "Toggle Files view", def: "Meta+Shift+d" },
  { id: "view-search", label: "Toggle Search view", def: "Meta+Shift+f" },
  { id: "terminal-search", label: "Search terminal output", def: "Meta+Shift+s" },
  { id: "view-terminals", label: "Terminals view", def: "Meta+Shift+t" },
  { id: "switch-project", label: "Switch project", def: "Alt+s" },
  { id: "toggle-notebook", label: "Quick notebook", def: "Alt+n" },
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
  { keys: "↓ then ↑ ↓ ← → Enter", label: "Navigate the filtered file tree from a file-search input" },
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
const ALWAYS_EXCLUDED = [".git", "node_modules", "__pycache__", ".venv", "_"];
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
    this.activeId = null;
    this.activeFileKey = null;
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
    this.searchHistory = [];
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
    this.notebookMounted = false;
    this.notebookSearchIndex = 0;
    this.notebookTitleTimer = 0;
    this.notebookResizePointerId = null;
    this.nativeSessionIds = new Set();
    this.sessionModelById = new Map();
    this.selectedTreeRow = null;
    this.iconMap = null;
    this.lastValidNavState = null;
    this.statusWs = null;
    this.statusWsReconnectTimer = 0;
    this.layoutFitSettleTimer = 0;
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
    const forceHidden = ["active-toggle", "terminal-search-toggle", "terminal-search-bar",
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
    this.applySidebarSelectionStyles();
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
      await this.loadProjects();
      this.populateModalProjects();
      this.$("modal-project").value = project.name;
      this.syncModalProjectCwd();
    } catch (error) {
      alert(error.message || "failed to choose project folder");
    } finally {
      if (button) button.disabled = false;
    }
  }

  async init() {
    window.addEventListener("message", this.handleHostMessageBound, false);
    await this.loadSettings();
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
    this.initNotebook();
    for (const view of ["terminals", "project", "search"]) {
      this.$("view-" + view).onclick = () => this.setSideView(view);
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
    this.$("modal-project").onchange = () => {
      if (!this.$("modal-project").value) {
        this.chooseProjectFolder();
        return;
      }
      this.syncModalProjectCwd();
    };
    this.$("modal-cwd").addEventListener("input", () => {
      this.$("modal-cwd").dataset.projectSeeded = "0";
      const projectSelect = this.$("modal-project");
      if (projectSelect && !projectSelect.disabled) projectSelect.value = "";
    });
    const queryInput = this.$("search-query");
    queryInput.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        void this.enterFileTreeNavigation("content");
        return;
      }
      if (this.handleFileSearchNavigation(e, "content")) return;
      if (e.key === "Enter") {
        e.preventDefault();
        clearTimeout(this.searchDebounce);
        if (!this.activateFileSearchSelection("content")) this.runSearch();
      }
      if (e.key === "Escape") { queryInput.value = ""; this.setExplorerMode("tree"); }
    });
    queryInput.addEventListener("input", () => this.debouncedSearch());
    const globInput = this.$("search-glob");
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
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        void this.enterFileTreeNavigation("name");
        return;
      }
      if (this.handleFileSearchNavigation(e, "name")) return;
      if (e.key === "Enter") {
        e.preventDefault();
        if (!this.activateFileSearchSelection("name")) this.runNameSearch();
      }
      if (e.key === "Escape") { nameInput.value = ""; this.setExplorerMode("tree"); }
    });
    nameInput.addEventListener("input", () => this.debouncedNameSearch());
    this.$("replace-all-btn").onclick = () => this.replaceAll();
    this.$("reveal-toggle").onclick = () => this.revealActiveFile();
    this.$("search-back").onclick = () => this.prevSearch();
    const mtimeBtn = this.$("mtime-toggle");
    mtimeBtn.classList.toggle("on", !!this.settings.show_mtime);
    mtimeBtn.onclick = () => {
      this.settings.show_mtime = !this.settings.show_mtime;
      mtimeBtn.classList.toggle("on", this.settings.show_mtime);
      this.saveSettings();
      this.rerenderTree();
    };
    const gitBtn = this.$("git-status-toggle");
    gitBtn.title = "Git colors: blue modified · green added/untracked · cyan copied · purple renamed · red deleted · orange conflict";
    gitBtn.classList.toggle("on", this.settings.show_git_status !== false);
    gitBtn.onclick = () => {
      this.settings.show_git_status = this.settings.show_git_status === false;
      gitBtn.classList.toggle("on", this.settings.show_git_status);
      this.saveSettings();
      this.rerenderTree();
    };
    const hideBtn = this.$("hide-excluded-toggle");
    hideBtn.classList.toggle("on", !!this.settings.hide_excluded);
    hideBtn.onclick = () => {
      this.settings.hide_excluded = !this.settings.hide_excluded;
      hideBtn.classList.toggle("on", this.settings.hide_excluded);
      this.saveSettings();
      this.rerenderTree();
    };
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
    this.initSideSplit();
    if (!this.vscodeMode) {
      setInterval(() => this.refreshRecentFiles(), RECENT_FILES_REFRESH_MS);
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
      const searchBar = this.$("terminal-search-bar");
      const searchToggle = this.$("terminal-search-toggle");
      if (searchBar && !searchBar.classList.contains("hidden") &&
          !searchBar.contains(e.target) && !searchToggle?.contains(e.target)) {
        this.clearTerminalSearch(true);
      }
      const notebookPanel = this.$("notebook-panel");
      const notebookToggle = this.$("notebook-toggle");
      if (this.settings.notebook_open && notebookPanel && !notebookPanel.contains(e.target) &&
          !notebookToggle?.contains(e.target)) this.setNotebookOpen(false, { focus: false });
    });
    this.$("terminal-search-toggle").onclick = () => this.toggleTerminalSearch();
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
      if (event.key === "Escape") { event.preventDefault(); this.clearTerminalSearch(true); }
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
    this.$("history-send").onclick = () => this.sendHistoryPrompt();
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
      this.positionFloatingTerminalSearch();
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
      (target.closest && (target.closest(".xterm") || target.closest("#monaco-host")));
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
  }

  setSessionTitleText(title, text) {
    title.textContent = text;
  }

  usesTextTerminalStatus() {
    return !this.vscodeMode && (!this.settings.show_terminal_icons || !!this.settings.compact_terminal_icons);
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
    const unreadCount = memberIds.filter((id) => this.unreadSessions.has(id)).length;
    label.classList.remove("group-working", "group-unread");
    const unreadDot = label.querySelector(".group-unread-dot");
    if (unreadDot) {
      unreadDot.classList.toggle("on", unreadCount > 0);
      unreadDot.title = unreadCount ? `${unreadCount} unread terminal${unreadCount === 1 ? "" : "s"}` : "";
    }
    const suffix = [working ? "working" : "", unreadCount ? `${unreadCount} unread` : ""]
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
      add.title = `New terminal (${this.bindingToDisplay(this.bindingFor("new-terminal"))})`;
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

  toggleTerminalSearch() {
    const bar = this.$("terminal-search-bar");
    const opening = bar.classList.contains("hidden");
    bar.classList.toggle("hidden", !opening);
    bar.classList.toggle("expanded", opening && !this.vscodeMode);
    this.$("terminal-search-toggle").classList.toggle("on", opening);
    this.updateTerminalSearchGroupButton();
    this.positionFloatingTerminalSearch();
    if (opening) this.$("terminal-search-input").focus();
    else this.clearTerminalSearch(true);
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

  clearTerminalSearch(closeBar = false) {
    clearTimeout(this.terminalSearchTimer);
    if (this.terminalSearchAbort) this.terminalSearchAbort.abort();
    this.terminalSearchAbort = null;
    this.$("terminal-search-input").value = "";
    this.$("terminal-search-summary").textContent = "";
    this.$("terminal-search-results").textContent = "";
    this.historySearchResults = [];
    this.terminalSearchMatches.clear();
    this.$("terminal-search-toggle").classList.toggle("on", !closeBar);
    if (closeBar) {
      this.$("terminal-search-bar").classList.add("hidden");
      this.$("terminal-search-bar").classList.remove("expanded");
    }
    this.positionFloatingTerminalSearch();
    this.renderList();
  }

  async runTerminalSearch() {
    const input = this.$("terminal-search-input");
    const query = input.value.trim();
    if (!query) {
      this.clearTerminalSearch(false);
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
    icon.title = s.agent_kind === "claude" ? "Claude" : s.agent_kind === "codex" ? "Codex" : "Shell terminal";
    icon.classList.toggle("claude-terminal-icon", s.agent_kind === "claude");
    icon.classList.toggle("codex-terminal-icon", s.agent_kind === "codex");
    icon.classList.toggle("on", !!this.settings.show_terminal_icons);
    icon.classList.toggle("compact-terminal-icon", !this.vscodeMode && !!this.settings.compact_terminal_icons);
    return icon;
  }

  terminalGroupLabel(group, count, unreadCount = 0, working = false) {
    const label = document.createElement("div");
    label.className = "side-section-label terminal-group-label";
    const chevron = document.createElement("span");
    chevron.className = "codicon " + (group.collapsed ? "codicon-chevron-right" : "codicon-chevron-down");
    const name = document.createElement("span");
    name.className = "terminal-group-name";
    name.textContent = group.name;
    const total = document.createElement("span");
    total.className = "terminal-group-count";
    total.textContent = String(count);
    const unreadDot = document.createElement("span");
    unreadDot.className = "group-unread-dot" + (unreadCount ? " on" : "");
    unreadDot.title = unreadCount ? `${unreadCount} unread terminal${unreadCount === 1 ? "" : "s"}` : "";
    const indicator = document.createElement("span");
    indicator.className = "group-drop-indicator";
    indicator.innerHTML = '<span class="codicon codicon-folder-library"></span><span>group</span>';
    label.title = "Click to collapse/expand · right-click for group actions · drop terminals here" +
      (working ? " · working" : "") + (unreadCount ? ` · ${unreadCount} unread` : "");
    label.append(chevron, name, total, unreadDot, indicator);
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
    this.sessionTitleEls.set(s.session_id, title);
    const typeIcon = this.terminalTypeIcon(s);
    const showHoverBrandIndicator = !this.vscodeMode && this.settings.show_terminal_icons && !!this.settings.compact_terminal_icons;
    const showDesktopBrandIndicator = !this.vscodeMode && this.settings.show_terminal_icons && !showHoverBrandIndicator;
    item.classList.toggle("compact-terminal-icons", showHoverBrandIndicator);
    const iconStatusActive = (showDesktopBrandIndicator || showHoverBrandIndicator) &&
      (presentation.spinning || this.unreadSessions.has(s.session_id));
    const iconStatusExited = (showDesktopBrandIndicator || showHoverBrandIndicator) && !s.running && !s.dormant;
    typeIcon.classList.toggle("terminal-status-active", iconStatusActive);
    typeIcon.classList.toggle("terminal-status-exited", !iconStatusActive && iconStatusExited);
    const close = document.createElement("button");
    close.className = "item-close";
    close.textContent = "✕";
    close.title = "Close terminal (⌘⇧⌫ when active)";
    close.onclick = (event) => { event.stopPropagation(); this.closeSession(s.session_id); };
    const groupIndicator = document.createElement("span");
    groupIndicator.className = "group-drop-indicator";
    groupIndicator.innerHTML = '<span class="codicon codicon-folder-library"></span><span>group</span>';
    groupIndicator.title = "Release to group with this terminal";
    if (showDesktopBrandIndicator) item.append(spinner, typeIcon, title, groupIndicator, close);
    else if (useTextStatusIndicator) item.append(dot, typeIcon, title, groupIndicator, close);
    else item.append(dot, typeIcon, title, groupIndicator, close);
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
    const unreadCount = members.filter((session) => this.unreadSessions.has(session.session_id)).length;
    const working = members.some((session) => this.processingStates.get(session.session_id));
    groupBox.appendChild(this.terminalGroupLabel(group, members.length, unreadCount, working));
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
    this.migrateLegacyPinnedLayout();
    const list = this.$("session-list");
    list.textContent = "";
    const currentSessionIds = new Set(this.sessions.map((session) => session.session_id));
    this.sidebarSelectedSessionIds = new Set([...this.sidebarSelectedSessionIds]
      .filter((sessionId) => currentSessionIds.has(sessionId)));
    if (!this.sidebarSelectedSessionIds.has(this.sidebarSelectionAnchorId)) {
      this.sidebarSelectionAnchorId = [...this.sidebarSelectedSessionIds][0] || null;
    }
    this.sessionTitleEls.clear();
    this.sessionSpinnerEls.clear();
    this.sessionStatusEls.clear();
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
    let terminalsHeaderShown = false;
    const ensureTerminalsHeader = () => {
      if (terminalsHeaderShown) return;
      const header = this.sectionLabel("terminals");
      this.attachGroupDropTarget(header, null);
      list.appendChild(header);
      terminalsHeaderShown = true;
    };
    if (this.activitySort) {
      ensureTerminalsHeader();
      for (const session of visibleSessions) this.renderTerminalItem(session, list);
    } else {
      for (const entry of layout) {
        const [kind, id] = entry.split(":", 2);
        if (kind === "group") {
          const group = groupsById.get(id);
          if (!group) continue;
          const members = grouped.get(id) || [];
          ensureTerminalsHeader();
          this.renderTerminalGroup(group, members, list);
          continue;
        }
        const session = sessionsById.get(id);
        if (!session || sessionGroups[id]) continue;
        ensureTerminalsHeader();
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
          item.tabIndex = 0;
          item.title = entry.fullPath || `${entry.root}/${entry.path}`;
          const name = document.createElement("span");
          name.className = "file-item-name";
          name.textContent = entry.name;
          const close = document.createElement("button");
          close.className = "item-close";
          close.textContent = "✕";
          close.title = "Close file (⌘⇧⌫ when active)";
          close.onclick = (e) => { e.stopPropagation(); this.closeFile(key); };
          item.append(this.fileTypeIconEl(entry.name, "file-type-icon"), name);
          if (entry.dirty) {
            const dirty = document.createElement("span");
            dirty.className = "file-dirty";
            dirty.textContent = "●";
            dirty.title = "unsaved changes (⌘S to save)";
            item.appendChild(dirty);
          }
          item.appendChild(close);
          item.onclick = () => this.activateFile(key, null);
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

  setSideView(view, allowToggle = true, allowFloating = true) {
    if (this.vscodeMode && (view === "project" || view === "search")) return;
    const nextView = allowToggle && this.sideView === view && view !== "terminals" ? "terminals" : view;
    this.sideView = nextView;
    view = this.sideView;
    const filesVisible = view === "project" || view === "search";
    const filesPinned = filesVisible && !!this.settings.files_pinned;
    this.settings.side_full = filesVisible;
    if (filesPinned) {
      const normalWidth = Number(this.settings.sidebar_width) || SETTINGS_DEFAULTS.sidebar_width;
      this.settings.files_width = Math.max(Number(this.settings.files_width) || 0, normalWidth * 2);
    }
    this.$("files-section").classList.toggle("hidden", !filesVisible);
    this.$("files-section").classList.toggle("with-search", view === "search");
    this.$("files-section").classList.toggle("floating", filesVisible && !filesPinned);
    for (const name of ["terminals", "project", "search"]) {
      this.$("view-" + name).classList.toggle("on", name === view);
    }
    this.$("side-split").classList.toggle("hidden", view === "terminals" || filesVisible);
    this.applySettings();
    this.applySideLayout();
    if (filesVisible) {
      const session = this.session(this.activeId);
      const expectedRoot = session ? session.cwd : (this.projectRoot() || "~");
      if (this.treeRoot !== expectedRoot || !this.treeDirs.has("")) {
        this.treeReloadPromise = this.reloadTree(expectedRoot);
      } else {
        this.connectFileTreeWatch(expectedRoot);
        void this.refreshTreeDirectories();
      }
    }
    if (!filesVisible) {
      this.disconnectFileTreeWatch();
      this.scheduleTerminalFitAfterSidebarChange();
      return;
    }
    if (view === "search") this.$("search-query").focus();
    if (view === "search" && this.$("search-query").value.trim()) this.runSearch(null, true);
    else if (view === "project") this.setExplorerMode("tree");
    else this.setExplorerMode("content");
    this.scheduleTerminalFitAfterSidebarChange();
  }

  focusFileNameSearch() {
    if (this.vscodeMode) return;
    if (this.sideView !== "project") this.setSideView("project");
    const input = this.$("search-name");
    setTimeout(() => { input.focus(); input.select(); }, 0);
  }

  focusFileContentSearch() {
    if (this.vscodeMode) return;
    if (this.sideView !== "search") this.setSideView("search");
    const input = this.$("search-query");
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
    const filesVisible = this.sideView === "project" || this.sideView === "search";
    this.$("files-section").classList.toggle("floating", filesVisible && !this.settings.files_pinned);
    this.updateFilesPinButton();
    this.applySettings();
    this.scheduleTerminalFitAfterSidebarChange();
    this.saveSettings();
  }

  dismissUnpinnedFilesPanel() {
    if (this.settings.files_pinned || (this.sideView !== "project" && this.sideView !== "search")) return;
    this.setSideView("terminals", false);
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
    const footer = this.$("sidebar-footer");
    const terminalSearch = this.$("terminal-search-bar");
    const searchOffset = terminalSearch && !terminalSearch.classList.contains("hidden") ? terminalSearch.offsetHeight : 0;
    const normalWidth = Number(this.settings.sidebar_width) || SETTINGS_DEFAULTS.sidebar_width;
    const requestedWidth = Number(fileWidth) || Math.max(Number(this.settings.files_width) || 0, normalWidth * 2);
    const availableWidth = Math.max(normalWidth, window.innerWidth - sidebar.getBoundingClientRect().left - 20);
    section.style.top = `${(header?.offsetHeight || 0) + searchOffset}px`;
    section.style.bottom = `${footer?.offsetHeight || 0}px`;
    section.style.width = `${Math.min(requestedWidth, availableWidth)}px`;
    document.documentElement.style.setProperty("--files-panel-width", `${Math.min(requestedWidth, availableWidth)}px`);
  }

  positionFloatingTerminalSearch() {
    const bar = this.$("terminal-search-bar");
    if (!bar || !bar.classList.contains("expanded") || bar.classList.contains("hidden")) {
      if (bar) {
        bar.style.top = "";
        bar.style.width = "";
        bar.style.maxHeight = "";
      }
      return;
    }
    const sidebar = this.$("sidebar");
    const header = this.$("sidebar-header");
    const footer = this.$("sidebar-footer");
    const normalWidth = Number(this.settings.sidebar_width) || SETTINGS_DEFAULTS.sidebar_width;
    const requestedWidth = Math.max(Number(this.settings.files_width) || 0, normalWidth * 2);
    const availableWidth = Math.max(normalWidth, window.innerWidth - sidebar.getBoundingClientRect().left - 20);
    const top = header?.offsetHeight || 0;
    bar.style.top = `${top}px`;
    bar.style.width = `${Math.min(requestedWidth, availableWidth)}px`;
    bar.style.maxHeight = `calc(100vh - ${top + (footer?.offsetHeight || 0) + 8}px)`;
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
    if (this.vscodeMode && (view === "project" || view === "search")) return;
    this.setSideView(view);
    if (this.sideView !== view) return;
    if (view === "project") this.focusFileNameSearch();
    else if (view === "search") this.focusFileContentSearch();
  }

  applySideLayout() {
    const sectionId = (this.sideView === "project" || this.sideView === "search") ? "files-section" : null;
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
    const terminalSearch = this.$("terminal-search-toggle");
    if (terminalSearch) {
      terminalSearch.title = `Search terminal output (${this.bindingToDisplay(this.bindingFor("terminal-search"))})`;
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
      newSession.title = `New terminal (${this.bindingToDisplay(this.bindingFor("new-terminal"))})`;
      newSession.setAttribute("aria-label", newSession.title);
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
      this.addContextItem(menu, this.shortcutLabel("Restart terminal", "restart-terminal"),
        () => this.restartSession(session.session_id), "refresh");
      this.addContextItem(menu, this.shortcutLabel("Close terminal", "close-item"),
        () => this.closeSession(session.session_id), "close");
      this.addContextItem(menu, this.shortcutLabel("Rename terminal", "rename-terminal"),
        () => this.renameSession(session), "edit");
      this.addContextItem(menu, this.shortcutLabel("Copy session id", "copy-session-id"),
        () => this.copyTextToClipboard(session.session_id, "session id copied"), "copy");
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
    this.addContextItem(menu, "Rename…   ⌃R", () => this.renameTreePath(rel));
    this.addContextItem(menu, "Move…   ⌃M", () => this.moveTreePath(rel));
    this.addContextItem(menu, "Delete (to Trash)   ⌘⌫", () => this.deleteTreePath(rel));
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
    const result = await this.fsOp("/api/files/rename", { path: rel, new_name: newName }, "rename failed");
    if (result === null) return;
    const parent = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    this.afterFsChange(rel, parent ? `${parent}/${result.new_name}` : result.new_name);
  }

  async moveTreePath(rel) {
    const destination = prompt(`Move "${rel}" to (path relative to ${this.treeRoot}; existing folder = move into it)`, rel);
    if (!destination || destination === rel) return;
    const result = await this.fsOp("/api/files/move", { path: rel, destination }, "move failed");
    if (result === null) return;
    this.afterFsChange(rel, result.rel);
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
        this.closeFile(key);
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
    this.renderHistoryMeta();
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
    const sessionCliTitle = String(session?.cli_title || "").toLowerCase();
    if (sessionCliTitle.includes("codex")) return "codex";
    if (sessionCliTitle.includes("claude")) return "claude";
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
    return this.historyModelFromValue(text);
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
      || text === "bash" || text === "zsh" || text === "sh";
  }

  historyModelDisplay(session, turns = []) {
    const fromTranscript = this.historyModelDisplayFromTranscript(turns);
    if (fromTranscript) return fromTranscript;
    return this.historyModelLabel(session, turns);
  }

  historyModelLabel(session, turns = []) {
    const model = this.historyModel(session, turns);
    if (this.historyModelIsGeneric(model)) {
      const label = model === "codex" ? "Codex" : model === "claude" ? "Claude" : "Shell";
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
    if (!view || this.activeFileKey !== null) return;
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

  closeHistory() {
    this.setHistoryMode(false);
  }

  async toggleHistory() {
    if (this.activeFileKey !== null) return;
    this.setHistoryMode(!this.historyOpen);
  }

  setHistoryMode(enabled) {
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
      const seen = merged.filter((turn) => turn.role === "user" && turn.text === item.text).length;
      if (seen > item.beforeCount) continue;
      merged.push({ role: "user", text: item.text });
      remaining.push(item);
    }
    if (remaining.length) this.historyPendingPrompts.set(sessionId, remaining);
    else this.historyPendingPrompts.delete(sessionId);
    return merged;
  }

  sendHistoryPrompt(options = {}) {
    if (!this.historyOpen || this.activeFileKey !== null || !this.activeId) return;
    const prompt = this.$("history-prompt");
    const text = prompt.value;
    if (!text.trim()) return;
    const view = this.views.get(this.activeId);
    if (!view || !view.ws || view.ws.readyState !== WebSocket.OPEN) {
      this.$("status-name").textContent = "terminal is still connecting…";
      return;
    }
    view.promptDraft = text;
    view.promptSubmitting = true;
    view.promptSubmitEntered = false;
    view.promptEditing = false;
    view.promptSubmitVersion = view.promptEditVersion;
    const bracketed = !view.term.modes || view.term.modes.bracketedPasteMode !== false;
    const queue = !!options.queue && this.session(this.activeId)?.agent_kind === "codex";
    const sessionId = this.activeId;
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
      const beforeCount = turns.filter((turn) => turn.role === "user" && turn.text === text).length -
        pending.filter((item) => item.text === text).length;
      pending.push({ text, beforeCount });
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

  resizeHistoryPrompt() {
    const prompt = this.$("history-prompt");
    if (!prompt) return;
    prompt.style.height = "auto";
    const height = Math.min(prompt.scrollHeight, 150);
    prompt.style.height = `${height}px`;
    prompt.style.overflowY = prompt.scrollHeight > height ? "auto" : "hidden";
  }

  showPromptDraft(view) {
    if (view !== this.views.get(this.activeId)) return;
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
    const bracketed = !view.term.modes || view.term.modes.bracketedPasteMode !== false;
    this.sendInput(view, "\x15");
    if (text) this.sendInput(view, text.includes("\n") && bracketed ? `\x1b[200~${text}\x1b[201~` : text);
  }

  sendPromptDraftSync(view, text) {
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
      view.promptDraftSyncPending = true;
      clearTimeout(view.promptDraftSyncTimer);
      view.promptDraftSyncTimer = setTimeout(() => {
        view.promptDraftSyncPending = false;
        view.promptDraftSyncTimer = 0;
      }, 3000);
    }
    this.sendInput(view, data);
    if (view.promptDraft !== previousDraft) this.sendPromptDraftSync(view, view.promptDraft);
    if (queueText) {
      // Codex has accepted this composer into its queue. Keep the two editors
      // consistent with the terminal instead of leaving the queued text as a
      // draft that reappears when Markdown is opened.
      view.promptDraft = "";
      view.promptEditing = false;
      view.pendingTerminalDraft = null;
      view.pendingDraftSync = null;
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
        view.promptDraft += ch;
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
          : "transcript history is only available for claude/codex terminals";
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
    host.addEventListener("input", () => {
      clearTimeout(this.notebookTitleTimer);
      this.notebookTitleTimer = setTimeout(() => {
        const markdown = window.PlannerEditor?.getMarkdown();
        if (markdown !== null && markdown !== undefined) this.setActiveNotebookMarkdown(markdown, false);
      }, 160);
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
    if (window.PlannerEditor) {
      void this.mountNotebookEditor();
    } else {
      host.textContent = "";
      const fallback = document.createElement("textarea");
      fallback.className = "notes-area";
      fallback.placeholder = "Quick notes… Markdown supported.";
      fallback.value = this.activeNotebookNote()?.text || "";
      fallback.addEventListener("input", () => this.setActiveNotebookMarkdown(fallback.value));
      host.appendChild(fallback);
    }
    this.renderNotebook();
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
      tab.className = "notebook-tab" + (note.note_id === this.settings.notebook_active_note_id ? " active" : "");
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(note.note_id === this.settings.notebook_active_note_id));
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
  }

  setActiveNotebookMarkdown(markdown, save = true) {
    const note = this.activeNotebookNote();
    if (!note) return;
    const text = String(markdown || "");
    const changed = note.text !== text;
    note.text = text;
    this.settings.notebook_text = text;
    if (changed) this.renderNotebookTabs();
    if (save) this.saveSettings();
  }

  async mountNotebookEditor() {
    if (this.notebookMounted || !window.PlannerEditor) return;
    const host = this.$("notebook-editor-host");
    if (!host) return;
    const note = this.activeNotebookNote();
    host.textContent = "";
    if (!note) return;
    try {
      await window.PlannerEditor.open(host, note.text, {
        onSave: (markdown) => this.setActiveNotebookMarkdown(markdown),
      });
      this.notebookMounted = true;
    } catch (error) {
      this.notebookMounted = false;
      this.$("status-name").textContent = `notebook editor failed: ${error.message || error}`;
    }
  }

  flushNotebook() {
    if (!window.PlannerEditor || !window.PlannerEditor.isOpen()) return Promise.resolve();
    const markdown = window.PlannerEditor.getMarkdown();
    if (markdown !== null) this.setActiveNotebookMarkdown(markdown);
    return window.PlannerEditor.flush();
  }

  async selectNotebookNote(noteId) {
    this.normalizeNotebookNotes();
    if (!this.settings.notebook_notes.some((note) => note.note_id === noteId) || noteId === this.settings.notebook_active_note_id) {
      this.focusNotebookEditor();
      return;
    }
    await this.flushNotebook();
    if (window.PlannerEditor) window.PlannerEditor.closeNow();
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
      if (window.PlannerEditor) window.PlannerEditor.closeNow();
      this.notebookMounted = false;
    }
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
    if (window.PlannerEditor) window.PlannerEditor.closeNow();
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
    const current = window.PlannerEditor?.getMarkdown();
    const text = current === null || current === undefined ? note.text : String(current);
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
    const current = window.PlannerEditor?.getMarkdown();
    const text = current === null || current === undefined ? note.text : String(current);
    const replacement = this.$("notebook-replace-query").value;
    const selected = all ? matches : [matches[this.notebookSearchIndex]];
    let nextText = text;
    for (const match of [...selected].reverse()) {
      nextText = nextText.slice(0, match.start) + replacement + nextText.slice(match.end);
    }
    await this.flushNotebook();
    this.setActiveNotebookMarkdown(nextText);
    if (window.PlannerEditor) window.PlannerEditor.closeNow();
    this.notebookMounted = false;
    await this.mountNotebookEditor();
    this.updateNotebookSearchState();
  }

  renderNotebook() {
    const panel = this.$("notebook-panel");
    const toggle = this.$("notebook-toggle");
    if (!panel || !toggle) return;
    this.renderNotebookTabs();
    if (this.settings.notebook_open) {
      clearTimeout(this.notebookCloseTimer);
      this.notebookCloseTimer = null;
      panel.classList.remove("hidden", "notebook-closing");
    } else if (!panel.classList.contains("notebook-closing")) {
      panel.classList.add("hidden");
    }
    toggle.classList.toggle("on", !!this.settings.notebook_open);
    if (this.settings.notebook_open && this.activeNotebookNote() && !this.notebookMounted && window.PlannerEditor) {
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
    const target = host.querySelector(".milkdown .ProseMirror, textarea");
    if (target) {
      target.focus();
      return;
    }
    host.focus();
  }

  activate(id, options = {}) {
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
      if (!view.ws) this.connect(id, view);
      if (this.isTerminalScrollV2()) {
        if (previousId !== id && (!view.everConnected || view.awaitingSnapshot || view.replaying)) {
          view.scrollMode = "follow";
        }
        const forceFit = previousId !== id || this.shouldForceTerminalActivationReflow(view, switchedViews);
        this.scheduleV2Fit(view, { force: forceFit });
        this.scheduleInitialV2Fit(view);
        if (view.scrollMode === "follow") this.scrollTerminalV2ToBottom(view);
        this.scheduleTerminalActivationRepair(view, {
          forceReflow: this.shouldForceTerminalActivationReflow(view, switchedViews),
        });
        this.scheduleActiveTerminalSettleWatchdog(view);
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
    requestAnimationFrame(() => {
      if (id !== this.activeId) return;
      this.focusActiveEditor();
    });
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
                   codexReflowEverAttempted: false,
                   promptDraft: this.session(id)?.draft || "", promptPaste: false, promptEscape: "", promptEditing: false,
                   promptSubmitting: false, promptSubmitEntered: false, promptSubmitTimer: 0,
                   promptQueue: [], promptQueueEditIndex: null, promptQueueMutation: false,
                   promptDraftSyncPending: false, promptDraftSyncTimer: 0, pendingDraftSync: null, pendingTerminalDraft: null,
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
      const bracketed = !view.term.modes || view.term.modes.bracketedPasteMode !== false;
      this.sendTrackedInput(view, bracketed ? `\x1b[200~${text}\x1b[201~` : text);
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
      if (view.everConnected) {
        view.replaying = true;
        if (!this.isTerminalScrollV2()) {
          if (view.keepBottom && !view.manualScroll) view.pinBottomUntil = Date.now() + 8000;
          else view.pinBottomUntil = 0;
        }
        view.term.reset();
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
          } else {
            if (!v2) view.pinBottomUntil = 0;
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
      view.ws = null;
      if (view.promptQueueMutation) {
        view.promptQueueMutation = false;
        view.promptQueue.forEach((item) => { delete item.mutationPending; });
        this.renderHistoryQueue(view);
        if (id === this.activeId) this.$("status-name").textContent = "queued prompt update disconnected — retry";
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
        .then((text) => { if (text) view.term.paste(text); })
        .catch(() => { this.$("status-name").textContent = "clipboard blocked — use ⌘V (allow clipboard in site settings for ⌃V)"; });
      return false;
    }
    if (e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "c" && view.term.hasSelection()) {
      e.preventDefault();
      navigator.clipboard.writeText(view.term.getSelection());
      view.term.clearSelection();
      return false;
    }
    if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      const key = e.key.toLowerCase();
      if (key === "c" && view.term.hasSelection()) {
        e.preventDefault();
        navigator.clipboard.writeText(view.term.getSelection());
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
      const bracketed = !view.term.modes || view.term.modes.bracketedPasteMode !== false;
      this.sendTrackedInput(view, bracketed ? `\x1b[200~${text}\x1b[201~` : text);
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

  scheduleV2Fit(view, options = {}) {
    const forceResize = !!options.force;
    if (!view || view.closed || !view.container.classList.contains("visible")) return;
    if (view.v2FitFrame && forceResize) {
      cancelAnimationFrame(view.v2FitFrame);
      view.v2FitFrame = 0;
    }
    if (view.v2FitFrame) return;
    view.v2FitFrame = requestAnimationFrame(() => {
      view.v2FitFrame = 0;
      if (view.closed || !view.container.classList.contains("visible")) return;
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
      // FitAddon is the public xterm sizing mechanism. v2 never writes to
      // .xterm-viewport or .xterm-scroll-area; xterm owns its scrollbar.
      view.fit.fit();
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
    if (!this.terminalTailRenderMismatch(view)) return false;
    const restoreLine = view.term.buffer.active.viewportY;
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
        else view.term.scrollToLine(Math.min(restoreLine, view.term.buffer.active.baseY));
        return true;
      }
    }
    this.refreshTerminalAppearance(view, true);
    if (follow) this.scrollTerminalV2ToBottom(view);
    else view.term.scrollToLine(Math.min(restoreLine, view.term.buffer.active.baseY));
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
        const beforeCols = view.term.cols, beforeRows = view.term.rows;
        view.fit.fit();
        if (view.term.cols >= 2 && view.term.rows >= 2) this.sendResize(view, view.term.cols, view.term.rows, true);
        if (view.term.cols !== beforeCols || view.term.rows !== beforeRows || this.terminalTailRenderMismatch(view)) {
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
    const revealDeadline = setTimeout(() => { view.container.style.visibility = ""; }, minHideMs + 250);
    const revealContainer = () => {
      const remaining = minHideMs - (Date.now() - hideStartedAt);
      clearTimeout(revealDeadline);
      if (remaining > 0) setTimeout(() => { view.container.style.visibility = ""; }, remaining);
      else view.container.style.visibility = "";
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

  enforceOpenFilesLimit() {
    if (this.openFiles.size <= OPEN_FILES_MAX_ENTRIES) return;
    const candidates = [...this.openFiles.keys()];
    for (const key of candidates) {
      if (this.openFiles.size <= OPEN_FILES_MAX_ENTRIES) break;
      if (key === this.activeFileKey) continue;
      const entry = this.openFiles.get(key);
      if (!entry || entry.dirty) continue;
      this.closeOpenFileEntry(key, entry);
    }
    if (this.openFiles.size <= OPEN_FILES_MAX_ENTRIES) return;
    for (const key of [...this.openFiles.keys()]) {
      if (this.openFiles.size <= OPEN_FILES_MAX_ENTRIES) break;
      if (key === this.activeFileKey) continue;
      const entry = this.openFiles.get(key);
      if (!entry) continue;
      this.closeOpenFileEntry(key, entry);
    }
  }

  closeOpenFileEntry(key, entry) {
    if (entry.model) {
      entry.model.dispose();
      entry.model = null;
    }
    this.openFiles.delete(key);
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
    const filesVisible = this.sideView === "project" || this.sideView === "search";
    const normalWidth = Number(s.sidebar_width) || SETTINGS_DEFAULTS.sidebar_width;
    const fileWidth = Math.max(Number(s.files_width) || 0, normalWidth * 2);
    const activeSidebarWidth = filesVisible && s.files_pinned ? fileWidth : normalWidth;
    const sidebarLeft = sidebar.getBoundingClientRect().left || 0;
    const sidebarRight = sidebarLeft + activeSidebarWidth;
    const maximumNotebookLeft = Math.max(0, window.innerWidth - 334);
    const defaultNotebookLeft = Math.min(Math.round(sidebarRight + 8), maximumNotebookLeft);
    const configuredNotebookLeft = Number(s.notebook_left);
    const notebookLeft = configuredNotebookLeft >= 0
      ? Math.max(0, Math.min(maximumNotebookLeft, configuredNotebookLeft))
      : defaultNotebookLeft;
    sidebar.style.width = activeSidebarWidth + "px";
    sidebar.style.minWidth = activeSidebarWidth + "px";
    document.documentElement.style.setProperty("--notebook-panel-left", `${notebookLeft}px`);
    this.positionFloatingFilesPanel(fileWidth);
    this.positionFloatingTerminalSearch();
    document.documentElement.style.setProperty("--sidebar-font-size", s.sidebar_font_size + "px");
    document.documentElement.style.setProperty("--ui-font-size", s.ui_font_size + "px");
    document.documentElement.style.setProperty("--code-font-size", s.code_font_size + "px");
    document.documentElement.style.setProperty("--sidebar-text-color", s.sidebar_text_color);
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
    pop.appendChild(this.buildToggleRow("Hover brand icons", () => (this.settings.compact_terminal_icons ? "on" : "off"),
      () => {
        this.settings.compact_terminal_icons = !this.settings.compact_terminal_icons;
        if (this.settings.compact_terminal_icons) this.settings.show_terminal_icons = true;
        this.renderList();
      }));
    pop.appendChild(this.buildToggleRow("Editor wrap", () => (this.settings.word_wrap ? "on" : "off"),
      () => { this.settings.word_wrap = !this.settings.word_wrap; }));
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
          (this.sideView === "project" || this.sideView === "search");
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

  async renderDirInto(container, relPath, entries) {
    entries = entries || await this.fetchDirEntries(relPath);
    if (entries === null) return;
    this.treeDirs.set(relPath, { container, cache: JSON.stringify(entries) });
    container.textContent = "";
    for (const entry of entries) {
      const excluded = entry.is_dir && this.isExcludedName(entry.name);
      if (excluded && this.settings.hide_excluded) continue;
      const childRel = relPath ? `${relPath}/${entry.name}` : entry.name;
      if (!this.treeFilterAllows(childRel, entry.is_dir)) continue;
      const row = document.createElement("div");
      row.className = "tree-row " + (entry.is_dir ? "dir" : "file") + (excluded ? " excluded" : "");
      row.tabIndex = 0;
      row.title = `${this.treeRoot}/${childRel}`;
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
    const date = new Date(epochSeconds * 1000);
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
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
      if (operation === "modified" && !change.is_directory) this.treeChangedEntries.set(change.path, change);
      else {
        this.treeChangedDirectories.add(parent);
        if (change.is_directory && operation === "deleted") {
          this.expandedDirs.delete(change.path);
          this.dropTreeDirsUnder(change.path);
        }
      }
    }
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
    this.refreshRecentFiles();
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
    let changed = false;
    const paths = directoryPaths === null ? [...this.treeDirs.keys()] : [...new Set(directoryPaths)];
    try {
      for (const relPath of paths) {
        const info = this.treeDirs.get(relPath);
        if (!info || this.treeDirs.get(relPath) !== info) continue;
        const entries = await this.fetchDirEntries(relPath);
        if (entries === null || JSON.stringify(entries) === info.cache) continue;
        this.selectedTreeRow = null;
        changed = true;
        await this.renderDirInto(info.container, relPath, entries);
      }
    } finally {
      this.treePollBusy = false;
      if (changed) {
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
    this.saveSettings();
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
    this.applyMainLayout();
    this.renderList();
    this.renderTopbar();
    await this.monacoReady;
    if (!entry.model) {
      const res = await fetch(`/api/files/read?root=${encodeURIComponent(entry.root)}&path=${encodeURIComponent(entry.path)}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        this.$("stat-text").textContent = err.detail || `${entry.path} — cannot open`;
        return;
      }
      const data = await res.json();
      entry.fullPath = data.path;
      entry.truncated = data.truncated;
      const uri = monaco.Uri.file(data.path);
      const existing = monaco.editor.getModel(uri);
      if (existing) existing.dispose();
      entry.model = monaco.editor.createModel(data.content, undefined, uri);
      entry.model.onDidChangeContent(() => {
        if (!entry.dirty) {
          entry.dirty = true;
          this.renderList();
        }
      });
    }
    if (this.activeFileKey !== key) return;
    this.editor.setModel(entry.model);
    if (line) {
      this.editor.revealLineInCenter(line);
      this.editor.setPosition({ lineNumber: line, column: 1 });
    }
    this.renderList();
    this.renderTopbar();
  }

  async saveActiveFile() {
    const entry = this.activeFileKey !== null ? this.openFiles.get(this.activeFileKey) : null;
    if (!entry || !entry.model) return;
    const res = await fetch("/api/files/write", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root: entry.root, path: entry.path, content: entry.model.getValue() }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(err.detail || "save failed");
      return;
    }
    entry.dirty = false;
    this.renderList();
  }

  closeFile(key) {
    const entry = this.openFiles.get(key);
    if (!entry) return;
    if (entry.dirty && !confirm(`"${entry.name}" has unsaved changes — close anyway?`)) return;
    if (entry.model) entry.model.dispose();
    this.openFiles.delete(key);
    this.persistOpenFiles();
    if (this.activeFileKey === key) {
      const remaining = [...this.openFiles.keys()];
      if (remaining.length) {
        const nextKey = remaining[remaining.length - 1];
        this.activateFile(nextKey, null, { history: false });
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
    if (this.activeFileKey !== null) this.closeFile(this.activeFileKey);
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

  openModal(groupId = null) {
    this.modalGroupId = !this.vscodeMode && groupId && this.terminalGroups().some((group) => group.id === groupId)
      ? groupId : null;
    const model = this.settings.last_model || DEFAULT_COMMAND;
    this.$("modal-model").value = MODEL_PERMISSIONS[model] ? model : DEFAULT_COMMAND;
    this.updateModalPermissions();
    this.$("modal-session-title").value = "";
    this.$("modal-session-ref").value = "";
    this.$("modal-cwd").value = this.resolveVscodeDefaultCwd();
    this.$("modal-cwd").dataset.projectSeeded = "0";
    this.populateModalProjects();
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
    const isShell = model === "none";
    this.$("modal-permission-field").classList.toggle("hidden", isShell);
    this.$("modal-session-ref-field").classList.toggle("hidden", isShell);
  }

  async createSession() {
    if (this.$("modal-backdrop").classList.contains("hidden")) return;
    const targetGroupId = this.modalGroupId;
    const model = this.$("modal-model").value;
    const permission = this.$("modal-permission").value;
    const title = this.$("modal-session-title").value;
    const sessionRef = this.$("modal-session-ref").value;
    const rawCwd = this.$("modal-cwd").value.trim();
    const selectedProject = this.projects.find((project) => project.name === this.$("modal-project")?.value);
    const cwd = selectedProject ? selectedProject.root
      : (this.vscodeMode ? rawCwd || this.resolveVscodeDefaultCwd() : rawCwd);
    let project = selectedProject?.name || "";
    if (!selectedProject && cwd) {
      const projectResponse = await fetch("/api/projects", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root: cwd }),
      });
      const projectPayload = await projectResponse.json().catch(() => ({}));
      if (!projectResponse.ok) {
        alert(projectPayload.detail || "failed to register project folder");
        return;
      }
      project = projectPayload.name || "";
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
    else if (actionId === "view-files") this.cycleView("project");
    else if (actionId === "view-search") this.cycleView("search");
    else if (actionId === "terminal-search") this.toggleTerminalSearch();
    else if (actionId === "view-terminals") this.setSideView("terminals");
    else if (actionId === "switch-project") this.openProjectSwitcher();
    else if (actionId === "toggle-notebook") this.toggleNotebook();
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
    const state = this.getProjectState();
    const sourceGroupId = state.session_groups?.[s.session_id] || null;
    const order = this.sessions.map((session) => session.session_id);
    const sourceIndex = order.indexOf(s.session_id);
    if (sourceIndex >= 0) {
      order.splice(sourceIndex + 1, 0, created.session_id);
      const patch = { session_order: order };
      if (sourceGroupId) {
        patch.session_groups = { ...(state.session_groups || {}), [created.session_id]: sourceGroupId };
        patch.terminal_layout = this.terminalLayout()
          .filter((entry) => entry !== `session:${created.session_id}`);
      } else {
        const sourceToken = `session:${s.session_id}`;
        const createdToken = `session:${created.session_id}`;
        const layout = this.terminalLayout().filter((entry) => entry !== createdToken);
        const layoutSourceIndex = layout.indexOf(sourceToken);
        layout.splice(layoutSourceIndex < 0 ? layout.length : layoutSourceIndex + 1, 0, createdToken);
        patch.terminal_layout = layout;
      }
      this.patchProjectState(patch);
    }
    await this.refresh();
    this.activate(created.session_id, { reveal: true });
    const view = this.views.get(created.session_id);
    if (view) view.pinBottomUntil = Date.now() + 8000;
  }

  async restartSession(sessionId) {
    this.activate(sessionId);
    this.$("status-name").textContent = "restarting…";
    const view = this.views.get(sessionId);
    if (view) view.pinBottomUntil = Date.now() + 6000;
    await fetch(`/api/sessions/${sessionId}/restart`, { method: "POST" });
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

  recordSearch(state) {
    const last = this.searchHistory[this.searchHistory.length - 1];
    if (last && JSON.stringify(last) === JSON.stringify(state)) return;
    this.searchHistory.push(state);
    if (this.searchHistory.length > 30) this.searchHistory.shift();
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
    const ignore = [...ALWAYS_EXCLUDED, ...(this.settings.ignored_dirs || [])].join(",");
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
    if (this.searchHistory.length < 2) return;
    this.searchHistory.pop();
    const prev = this.searchHistory[this.searchHistory.length - 1];
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

  async runSearch(queryOverride, skipRecord) {
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
      const state = { q: query, glob: this.$("search-glob").value.trim(),
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
    const ignore = [...ALWAYS_EXCLUDED, ...(this.settings.ignored_dirs || [])].join(",");
    const params = new URLSearchParams({ root, q: query, glob: globParts.join(","), ignore,
                                         word: this.searchWord ? "true" : "false",
                                         case_sensitive: this.searchCase ? "true" : "false",
                                         regex: this.searchRegex ? "true" : "false" });
    const res = await fetch(`/api/files/search?${params}`);
    if (!res.ok) {
      summary.textContent = "search failed";
      return;
    }
    const hits = await res.json();
    resultsEl.textContent = "";
    const byFile = new Map();
    for (const hit of hits) {
      if (!byFile.has(hit.path)) byFile.set(hit.path, { path: hit.path, mtime: hit.mtime || 0, hits: [] });
      byFile.get(hit.path).hits.push(hit);
    }
    const files = [...byFile.values()].sort((a, b) => this.compareSearchFiles(a, b));
    this.contentSearchTree = { root, paths: new Set(files.map((file) => file.path)), directories: new Set() };
    for (const file of files) {
      const fileRow = document.createElement("div");
      fileRow.className = "search-file group";
      fileRow.tabIndex = 0;
      fileRow.title = file.path;
      fileRow.append(this.fileTypeIconEl(file.path.split("/").pop(), "file-type-icon"), document.createTextNode(file.path));
      resultsEl.appendChild(fileRow);
      for (const hit of file.hits) {
        const hitRow = document.createElement("div");
        hitRow.className = "search-hit";
        hitRow.tabIndex = -1;
        hitRow.setAttribute("role", "option");
        const lineEl = document.createElement("span");
        lineEl.className = "hit-line";
        lineEl.textContent = hit.line;
        const textEl = document.createElement("span");
        textEl.className = "hit-text";
        textEl.textContent = hit.text;
        hitRow.append(lineEl, textEl);
        hitRow.title = `${hit.path}:${hit.line}`;
        hitRow.onclick = () => this.openFile(root, hit.path, hit.line, null, { fromFilePanel: true });
        hitRow.onmouseenter = () => this.selectFileSearchResult("content", hitRow, { reveal: false });
        resultsEl.appendChild(hitRow);
      }
    }
    const done = document.createElement("div");
    done.className = "search-summary";
    const flags = [this.searchWord ? "whole word" : "", this.searchCase ? "case sensitive" : ""].filter(Boolean).join(", ");
    done.textContent = `${hits.length} match${hits.length === 1 ? "" : "es"} in ${files.length} file${files.length === 1 ? "" : "s"}${flags ? ` · ${flags}` : ""}`;
    resultsEl.prepend(done);
  }

  extRank(path) {
    const ext = path.split(".").pop().toLowerCase();
    const idx = EXT_PRIORITY.indexOf(ext);
    return idx === -1 ? EXT_PRIORITY.length : idx;
  }

  compareSearchFiles(a, b) {
    return (this.extRank(a.path) - this.extRank(b.path)) || a.path.localeCompare(b.path);
  }

  debouncedSearch() {
    clearTimeout(this.searchDebounce);
    const query = this.$("search-query").value.trim();
    if (!query) {
      this.$("search-results").textContent = "";
      this.clearFileSearchSelection("content");
      this.contentSearchTree = null;
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
                             ignore: [...ALWAYS_EXCLUDED, ...(this.settings.ignored_dirs || [])].join(","),
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

  async runNameSearch() {
    const generation = ++this.nameSearchGeneration;
    const query = this.$("search-name").value.trim();
    const resultsEl = this.$("name-results");
    resultsEl.textContent = "";
    this.clearFileSearchSelection("name");
    this.nameSearchTree = null;
    if (!query) {
      this.setExplorerMode("tree");
      return;
    }
    if (this.sideView !== "project" && this.sideView !== "search") {
      this.sideView = "terminals";
      this.setSideView("project");
    }
    this.setExplorerMode("name");
    const loading = document.createElement("div");
    loading.className = "search-summary";
    loading.textContent = "loading project files…";
    resultsEl.appendChild(loading);
    const root = this.searchRoot();
    const ignore = [...ALWAYS_EXCLUDED, ...(this.settings.ignored_dirs || [])].join(",");
    const res = await fetch(`/api/files/find?${new URLSearchParams({ root, q: query, ignore })}`);
    if (!res.ok) return;
    const hits = await res.json();
    if (generation !== this.nameSearchGeneration) return;
    this.nameSearchTree = {
      root,
      paths: new Set(hits.map((hit) => hit.path)),
      directories: new Set(hits.filter((hit) => hit.is_dir).map((hit) => hit.path)),
    };
    resultsEl.textContent = "";
    const summary = document.createElement("div");
    summary.className = "search-summary";
    const folderCount = hits.filter((hit) => hit.is_dir).length;
    summary.textContent = `${hits.length} result${hits.length === 1 ? "" : "s"}${folderCount ? ` · ${folderCount} folder${folderCount === 1 ? "" : "s"}` : ""}`;
    resultsEl.appendChild(summary);
    for (const hit of hits) {
      const row = document.createElement("div");
      row.className = "search-file clickable";
      row.tabIndex = 0;
      row.title = hit.path;
      const icon = hit.is_dir ? document.createElement("span") : this.fileTypeIconEl(hit.path.split("/").pop(), "file-type-icon");
      if (hit.is_dir) {
        icon.className = "codicon codicon-folder file-type-icon";
        icon.setAttribute("aria-hidden", "true");
      }
      row.append(icon, document.createTextNode(hit.path));
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

new TermdeckApp().init();
