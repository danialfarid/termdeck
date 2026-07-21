// Status/title/processing changes arrive through /ws/status. This slower
// fallback only reconciles session-list metadata such as created/closed tabs.
const SESSION_LIST_REFRESH_MS = 30000;
const HISTORY_REFRESH_MS = 1500;
const TITLE_STATUS_RE = /^[\u2800-\u28ff○-◗⏳⚡✳](\s+)/;
const RECONNECT_MS = 1500;
const DEFAULT_COMMAND = "codex";
const DEFAULT_CWD = "~/workspace/stock";
const SETTINGS_DEFAULTS = { sidebar_width: 250, files_width: 380, sidebar_font_size: 13, terminal_font_size: 13,
  code_font_size: 12, diff_font_size: 13, tree_font_size: 12, active_session_id: "", open_files: [], project_state: {}, theme: "dark",
  ignored_dirs: [], hide_excluded: false, side_split: 0.55, side_full: false, side_split_user_set: false, show_stats: true,
  tree_sort: "name", show_mtime: false, word_wrap: false, search_glob: "!*.json, !*.csv", keybindings: {},
  last_command: "codex", last_model: "codex", last_permissions: { codex: "default", claude: "default", none: "default" },
  show_terminal_icons: false, history_mode: false };
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
const KEYBINDINGS = [
  { id: "new-terminal", label: "New terminal", def: "Meta+b" },
  { id: "close-item", label: "Close active terminal / file", def: "Meta+Shift+Backspace" },
  { id: "save-file", label: "Save open file", def: "Meta+s" },
  { id: "prev-terminal", label: "Previous terminal", def: "Meta+Alt+ArrowUp" },
  { id: "next-terminal", label: "Next terminal", def: "Meta+Alt+ArrowDown" },
  { id: "view-files", label: "Toggle Files view", def: "Meta+Shift+d" },
  { id: "view-search", label: "Toggle Search view", def: "Meta+Shift+f" },
  { id: "view-terminals", label: "Terminals view", def: "Meta+Shift+t" },
  { id: "toggle-history", label: "Switch terminal / Markdown transcript", def: "Meta+Shift+m" },
];
const REFERENCE_KEYS = [
  { keys: "⌘[ / ⌘]", label: "Browser back / forward (last-clicked navigation)" },
  { keys: "⌃⇧E", label: "Focus file-name search" },
  { keys: "⌃⇧F", label: "Focus file-content search" },
  { keys: "⌃⇧Space", label: "Open file browser/search modal" },
  { keys: "⌘⌫ / ⌥⌫", label: "Delete to line start / delete word (in terminal)" },
  { keys: "⌘← / ⌘→", label: "Line start / end (in terminal)" },
  { keys: "⌘A", label: "Select all terminal text" },
  { keys: "⌃R / ⌃M / ⌘⌫", label: "Rename / move / delete selected tree file" },
  { keys: "↑ ↓ ← → Enter", label: "Navigate the file tree (when focused)" },
];
const ALWAYS_EXCLUDED = [".git", "node_modules", "__pycache__", ".venv", "_"];
const STATS_POLL_MS = 5000;
const STAT_HISTORY_MAX = 48;
const FONT_MIN = 8, FONT_MAX = 32;
const TREE_POLL_MS = 4000;
const QUERY_RESPONSE_RE = /^\x1b\[[?>]?[\d;]*[Rc]$/;
const PATH_LINK_RE = /(?:~\/|\.{1,2}\/|\/)?[\w@%+=.-]+(?:\/[\w@%+=.-]+)*\.[A-Za-z][A-Za-z0-9]{0,7}(?::\d+)?/g;
const KNOWN_EXTS = new Set(["py", "md", "json", "js", "ts", "tsx", "css", "html", "sh", "zsh", "txt", "yaml", "yml",
  "toml", "csv", "log", "plist", "sql", "xml", "ini", "cfg", "lock", "ipynb", "rs", "go", "c", "h", "cpp", "hpp", "java"]);
const MATERIAL_ICONS_BASE = "/static/vendor/material-icons/icons/";
const MATERIAL_ICONS_MAP_URL = "/static/vendor/material-icons/dist/material-icons.json";
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
    this.sessions = [];
    this.closedSessions = [];
    this.views = new Map();
    this.openFiles = new Map();
    this.activeId = null;
    this.activeFileKey = null;
    this.historyOpen = false;
    this.historyRefreshTimer = 0;
    this.historyLoadBusy = false;
    this.historyFingerprint = "";
    this.historyTurns = [];
    this.historyLoaded = false;
    this.historyEditsCollapsed = false;
    this.closedExpanded = false;
    this.settings = { ...SETTINGS_DEFAULTS };
    this.saveTimer = null;
    this.treeRoot = null;
    this.treeDirs = new Map();
    this.expandedDirs = new Set();
    this.treePollBusy = false;
    this.recentFiles = [];
    this.recentFilesRoot = null;
    this.recentFilesBusy = false;
    this.recentFilesFetchedAt = 0;
    this.sideView = "terminals";
    this.searchWord = false;
    this.searchCase = false;
    this.searchRegex = false;
    this.searchHistory = [];
    this.nameSearchGeneration = 0;
    this.applyingHistory = false;
    this.lastNavJson = "";
    this.sessionTitleEls = new Map();
    this.sessionSpinnerEls = new Map();
    this.sessionStatusEls = new Map();
    this.sessionListSignature = "";
    this.revealActiveSessionOnLoad = true;
    this.processingStates = new Map();
    this.processingSince = new Map();
    this.processingTimer = 0;
    this.viewedCompletedSessions = new Set();
    this.unreadSessions = new Set();
    this.statHistory = [];
    this.editor = null;
    this.selectedTreeRow = null;
    this.iconMap = null;
    this.fileBrowserModalOpen = false;
    this.fileBrowserPreviousView = "terminals";
    this.fileBrowserOrigin = null;
    this.pathOverflowEl = null;
    this.statusWs = null;
    this.statusWsReconnectTimer = 0;
    this.projects = [];
    const projectMatch = location.pathname.match(/^\/p\/([^/]+)/);
    this.projectSlug = projectMatch ? decodeURIComponent(projectMatch[1]) : null;
    const urlParams = new URLSearchParams(location.search);
    if (urlParams.get("t")) this.initialNav = { kind: "term", id: urlParams.get("t") };
    else if (urlParams.get("f")) this.initialNav = { kind: "file", key: urlParams.get("f") };
    else if (urlParams.get("q")) {
      this.initialNav = { kind: "search", q: urlParams.get("q"), glob: urlParams.get("glob") || "",
                          word: urlParams.get("w") === "1", case_sensitive: urlParams.get("c") === "1",
                          regex: urlParams.get("re") === "1" };
    } else this.initialNav = null;
    this.$ = (id) => document.getElementById(id);
  }

  projectQuery() {
    return this.projectSlug ? `?project=${encodeURIComponent(this.projectSlug)}` : "";
  }

  projectStateKey() {
    return this.projectSlug || "__all__";
  }

  getProjectState() {
    const states = this.settings.project_state || {};
    return states[this.projectStateKey()] || { active_session_id: "", open_files: [], pinned_sessions: [], unread_sessions: [] };
  }

  patchProjectState(patch) {
    const states = this.settings.project_state || {};
    states[this.projectStateKey()] = { ...this.getProjectState(), ...patch };
    this.settings.project_state = states;
    this.saveSettings();
  }

  async loadProjects() {
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
    select.value = this.projectSlug || "";
    select.onchange = () => {
      location.href = select.value ? `/p/${encodeURIComponent(select.value)}` : "/";
    };
  }

  projectRoot() {
    const p = this.projects.find((x) => x.name === this.projectSlug);
    return p ? p.root : null;
  }

  async init() {
    await this.loadSettings();
    await this.loadProjects();
    this.restoreOpenFiles();
    this.initMonaco();
    this.loadIconMap();
    this.$("settings-gear").onclick = (e) => this.openSettingsPopover(e.currentTarget,
      [{ label: "Sidebar font", key: "sidebar_font_size" }, { label: "Terminal font", key: "terminal_font_size" },
       { label: "Code font", key: "code_font_size" }, { label: "Diff font", key: "diff_font_size" },
       { label: "Tree/search font", key: "tree_font_size" }]);
    for (const view of ["terminals", "project", "search"]) {
      this.$("view-" + view).onclick = () => this.setSideView(view);
    }
    this.$("view-project").ondblclick = () => { if (this.sideView !== "project") this.setSideView("project"); this.toggleSideFull(); };
    this.$("view-search").ondblclick = () => { if (this.sideView !== "search") this.setSideView("search"); this.toggleSideFull(); };
    const filesSection = this.$("files-section");
    filesSection.addEventListener("mouseover", (event) => {
      const row = event.target.closest(".file-item, .search-file, .tree-row");
      if (row && filesSection.contains(row)) this.showPathOverflow(row);
    });
    filesSection.addEventListener("mouseout", (event) => {
      const row = event.target.closest(".file-item, .search-file, .tree-row");
      if (!row || !filesSection.contains(row) || (event.relatedTarget && row.contains(event.relatedTarget))) return;
      this.hidePathOverflow();
    });
    filesSection.addEventListener("focusin", (event) => {
      const row = event.target.closest(".file-item, .search-file, .tree-row");
      if (row && filesSection.contains(row)) this.showPathOverflow(row);
    });
    filesSection.addEventListener("focusout", () => this.hidePathOverflow());
    const replaceToggle = this.$("replace-toggle");
    replaceToggle.onclick = () => {
      const bar = this.$("replace-bar");
      bar.classList.toggle("hidden");
      replaceToggle.classList.toggle("on", !bar.classList.contains("hidden"));
    };
    this.$("view-terminals").classList.add("on");
    const queryInput = this.$("search-query");
    queryInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { clearTimeout(this.searchDebounce); this.runSearch(); }
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
    this.$("minimize-toggle").onclick = () => { if (this.sideView !== "terminals") this.setSideView(this.sideView); };
    const wordBtn = this.$("search-word-toggle"), caseBtn = this.$("search-case-toggle"), regexBtn = this.$("search-regex-toggle");
    wordBtn.onclick = () => { this.searchWord = !this.searchWord; wordBtn.classList.toggle("on", this.searchWord); };
    caseBtn.onclick = () => { this.searchCase = !this.searchCase; caseBtn.classList.toggle("on", this.searchCase); };
    regexBtn.onclick = () => { this.searchRegex = !this.searchRegex; regexBtn.classList.toggle("on", this.searchRegex); };
    const nameInput = this.$("search-name");
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.runNameSearch();
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
    const sortBtn = this.$("sort-toggle");
    sortBtn.classList.toggle("on", this.settings.tree_sort === "mtime");
    sortBtn.onclick = () => {
      this.settings.tree_sort = this.settings.tree_sort === "mtime" ? "name" : "mtime";
      sortBtn.classList.toggle("on", this.settings.tree_sort === "mtime");
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
    this.$("files-tree").addEventListener("contextmenu", (e) => {
      const row = e.target.closest(".tree-row");
      if (row && row.dataset.rel) this.openTreeContextMenu(e, row);
    });
    this.initResizer("sidebar-resizer", "sidebar_width", false, 236, 520);
    this.initSideSplit();
    setInterval(() => this.pollTree(), TREE_POLL_MS);
    setInterval(() => this.pollStats(), STATS_POLL_MS);
    this.pollStats();
    document.addEventListener("mousedown", (e) => {
      for (const id of ["settings-popover", "context-menu"]) {
        const pop = this.$(id);
        if (!pop.classList.contains("hidden") && !pop.contains(e.target)) pop.classList.add("hidden");
      }
    });
    this.$("new-session-btn").onclick = () => this.openModal();
    this.$("modal-cancel").onclick = () => this.closeModal();
    this.$("modal-create").onclick = () => this.createSession();
    this.$("modal-model").onchange = () => this.updateModalPermissions();
    this.$("history-btn").onclick = () => this.toggleHistory();
    this.$("history-edits-toggle").onclick = () => this.toggleHistoryEdits();
    this.$("history-close").onclick = () => this.closeHistory();
    this.$("history-scroll-bottom").onclick = () => this.scrollHistoryToBottom();
    this.$("terminal-resync-btn").onclick = () => this.resyncActiveTerminal();
    this.$("history-attach").onclick = () => this.attachToHistory();
    this.$("history-send").onclick = () => this.sendHistoryPrompt();
    this.$("history-prompt").addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        const view = this.views.get(this.activeId);
        if (view) {
          this.sendInput(view, "\x1b");
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
        view.promptSubmitting = false;
        view.promptEditing = false;
        clearTimeout(view.promptSubmitTimer);
        this.sendInput(view, e.key === "ArrowUp" ? "\x1b[A" : "\x1b[B");
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
    this.$("scroll-bottom-btn").onclick = () => this.scrollActiveToBottom();
    this.$("file-browser-close").onclick = () => this.closeFileBrowserModal();
    this.$("file-browser-name-mode").onclick = () => { this.focusFileNameSearch(); this.updateFileBrowserMode(); };
    this.$("file-browser-content-mode").onclick = () => { this.focusFileContentSearch(); this.updateFileBrowserMode(); };
    this.$("file-browser-backdrop").addEventListener("mousedown", (e) => {
      if (e.target.id === "file-browser-backdrop") this.closeFileBrowserModal();
    });
    this.$("keys-btn").onclick = () => this.openKeybindings();
    this.$("keys-done").onclick = () => this.$("keys-backdrop").classList.add("hidden");
    this.$("keys-reset").onclick = () => this.resetKeybindings();
    this.$("keys-backdrop").addEventListener("mousedown", (e) => { if (e.target.id === "keys-backdrop") this.$("keys-backdrop").classList.add("hidden"); });
    this.$("modal-backdrop").addEventListener("mousedown", (e) => {
      if (e.target.id === "modal-backdrop") this.closeModal();
    });
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
      if (this.fileBrowserModalOpen && e.key === "Escape") {
        e.preventDefault();
        this.closeFileBrowserModal();
        return;
      }
      if (this.tryAppShortcut(e)) return;
      if (this.isTypingTarget(e)) return;
      const treeVisible = this.sideView === "project" && !this.$("files-section").classList.contains("hidden");
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
    history.replaceState({ kind: "init" }, "", location.pathname + location.search);
    new ResizeObserver(() => this.fitActive()).observe(this.$("terminal-area"));
    this.refresh().finally(() => this.connectStatusStream());
    setInterval(() => this.refresh(), SESSION_LIST_REFRESH_MS);
  }

  navUrl(state) {
    const params = new URLSearchParams();
    if (state.kind === "term") params.set("t", state.id);
    else if (state.kind === "file") params.set("f", state.key);
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
    history.pushState(state, "", this.navUrl(state));
  }

  applyNavState(state) {
    if (!state || state.kind === "init") return;
    this.applyingHistory = true;
    this.lastNavJson = JSON.stringify(state);
    try {
      if (state.kind === "term" && this.session(state.id)) {
        this.activate(state.id);
      } else if (state.kind === "file" && this.openFiles.has(state.key)) {
        this.activateFile(state.key, null);
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
      const view = this.views.get(s.session_id);
      if (view && !view.promptEditing && !view.promptSubmitting && !view.promptDraftSyncPending &&
          view.pendingDraftSync === null && view.pendingTerminalDraft === null && view.promptDraft !== (s.draft || "")) {
        view.promptDraft = s.draft || "";
        if (s.session_id === this.activeId && this.historyOpen) this.showPromptDraft(view);
      }
      const spinning = this.titlePresentation(s).spinning;
      if (!this.processingStates.has(s.session_id)) {
        this.processingStates.set(s.session_id, spinning);
        if (spinning) this.processingSince.set(s.session_id, Date.now());
      }
      else this.updateProcessingState(s.session_id, spinning);
    }
    const ids = new Set(sessions.map((s) => s.session_id));
    for (const [id, view] of [...this.views]) {
      if (!ids.has(id)) this.destroyView(id, view);
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
    if (this.revealActiveSessionOnLoad) {
      this.revealActiveSessionOnLoad = false;
      this.keepActiveSessionVisible();
    }
    this.renderTopbar();
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
    if (Object.prototype.hasOwnProperty.call(message, "cli_title") && message.cli_title) session.cli_title = message.cli_title;
    if (Object.prototype.hasOwnProperty.call(message, "agent_session_id")) session.agent_session_id = message.agent_session_id;
    if (Object.prototype.hasOwnProperty.call(message, "processing")) session.processing = !!message.processing;
    if (Object.prototype.hasOwnProperty.call(message, "running")) session.running = !!message.running;
    if (Object.prototype.hasOwnProperty.call(message, "exit_code")) session.exit_code = message.exit_code;
    const presentation = this.titlePresentation(session);
    const titleEl = this.sessionTitleEls.get(session.session_id);
    if (titleEl) titleEl.textContent = presentation.text;
    this.updateProcessingState(session.session_id, presentation.spinning);
    if (session.session_id === this.activeId) this.renderTopbar();
  }

  titlePresentation(s) {
    const title = this.effectiveTitle(s);
    const status = title.match(TITLE_STATUS_RE);
    return status ? { text: title.slice(status[0].length), spinning: s.processing !== false } : { text: title, spinning: s.processing === true };
  }

  updateSessionSpinner(id, spinning) {
    const spinner = this.sessionSpinnerEls.get(id);
    if (spinner) spinner.classList.toggle("on", spinning);
  }

  updateUnreadIndicator(id) {
    const dot = this.sessionStatusEls.get(id);
    if (!dot) return;
    dot.classList.toggle("processing", !!this.processingStates.get(id));
    dot.classList.toggle("unread", this.unreadSessions.has(id) && !this.processingStates.get(id));
  }

  updateProcessingState(id, spinning) {
    const previous = this.processingStates.get(id);
    if (spinning) this.viewedCompletedSessions.delete(id);
    if (spinning && previous !== true) this.processingSince.set(id, Date.now());
    if (!spinning) this.processingSince.delete(id);
    if (id !== this.activeId && previous === true && !spinning &&
        !this.viewedCompletedSessions.has(id) && !this.unreadSessions.has(id)) {
      this.unreadSessions.add(id);
      this.patchProjectState({ unread_sessions: [...this.unreadSessions] });
    }
    this.processingStates.set(id, spinning);
    this.updateSessionSpinner(id, spinning);
    this.updateUnreadIndicator(id);
    this.updateHistoryThinkingIndicator();
  }

  session(id) {
    return this.sessions.find((s) => s.session_id === id) || null;
  }

  sessionListSignatureFor(sessions = this.sessions) {
    return sessions.map((s) => s.session_id).join("|");
  }

  updateSessionRows() {
    for (const s of this.sessions) {
      const presentation = this.titlePresentation(s);
      const title = this.sessionTitleEls.get(s.session_id);
      if (title) title.textContent = presentation.text;
      const dot = this.sessionStatusEls.get(s.session_id);
      if (dot) {
        dot.className = "status-dot" + (s.running ? "" : " exited") +
          (presentation.spinning ? " processing" : this.unreadSessions.has(s.session_id) ? " unread" : "");
      }
      const spinner = this.sessionSpinnerEls.get(s.session_id);
      if (spinner) spinner.classList.toggle("on", presentation.spinning);
      if (title) {
        const item = title.closest(".session-item");
        if (item) item.classList.toggle("active", s.session_id === this.activeId && this.activeFileKey === null);
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
    const pinned = new Set(state.pinned_sessions || []);
    const rank = new Map(order.map((id, i) => [id, i]));
    return [...sessions].sort((a, b) =>
      (Number(pinned.has(b.session_id)) - Number(pinned.has(a.session_id))) ||
      (rank.has(a.session_id) ? rank.get(a.session_id) : 1e9) - (rank.has(b.session_id) ? rank.get(b.session_id) : 1e9));
  }

  togglePin(sessionId) {
    const pinned = new Set(this.getProjectState().pinned_sessions || []);
    if (pinned.has(sessionId)) pinned.delete(sessionId);
    else pinned.add(sessionId);
    this.patchProjectState({ pinned_sessions: [...pinned] });
    this.sessions = this.applySessionOrder(this.sessions);
    this.renderList();
  }

  makeDraggable(item, type, key, onReorder) {
    item.draggable = true;
    item.ondragstart = (e) => {
      this.dragItem = { type, key };
      e.dataTransfer.effectAllowed = "move";
    };
    item.ondragover = (e) => {
      if (this.dragItem && this.dragItem.type === type && this.dragItem.key !== key) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }
    };
    item.ondrop = (e) => {
      e.preventDefault();
      if (this.dragItem && this.dragItem.type === type && this.dragItem.key !== key) onReorder(this.dragItem.key, key);
      this.dragItem = null;
    };
  }

  reorderSessions(draggedId, targetId) {
    const ids = this.sessions.map((s) => s.session_id).filter((id) => id !== draggedId);
    ids.splice(ids.indexOf(targetId), 0, draggedId);
    this.patchProjectState({ session_order: ids });
    this.sessions = this.applySessionOrder(this.sessions);
    this.renderList();
  }

  reorderFiles(draggedKey, targetKey) {
    const keys = [...this.openFiles.keys()].filter((k) => k !== draggedKey);
    keys.splice(keys.indexOf(targetKey), 0, draggedKey);
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
    const toggle = document.createElement("button");
    const showIcons = !!this.settings.show_terminal_icons;
    toggle.className = "section-toggle" + (showIcons ? " on" : "");
    toggle.textContent = "i";
    toggle.title = showIcons ? "Hide terminal type icons" : "Show terminal type icons";
    toggle.setAttribute("aria-label", toggle.title);
    toggle.setAttribute("aria-pressed", String(showIcons));
    toggle.onclick = (event) => {
      event.stopPropagation();
      this.settings.show_terminal_icons = !this.settings.show_terminal_icons;
      this.saveSettings();
      this.renderList();
    };
    label.append(name, toggle);
    return label;
  }

  pinnedSectionLabel() {
    const label = document.createElement("div");
    label.className = "side-section-label pinned-section-label";
    label.textContent = "pinned";
    return label;
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
    return icon;
  }

  renderList() {
    const list = this.$("session-list");
    list.textContent = "";
    this.sessionTitleEls.clear();
    this.sessionSpinnerEls.clear();
    this.sessionStatusEls.clear();
    const pinnedIds = new Set(this.getProjectState().pinned_sessions || []);
    let pinnedSectionShown = false;
    let terminalSectionShown = false;
    for (const s of this.sessions) {
      const isPinned = pinnedIds.has(s.session_id);
      if (isPinned && !pinnedSectionShown) {
        list.appendChild(this.pinnedSectionLabel());
        pinnedSectionShown = true;
      } else if (!isPinned && !terminalSectionShown) {
        list.appendChild(this.sectionLabel("terminals"));
        terminalSectionShown = true;
      }
      const item = document.createElement("div");
      item.className = "session-item" + (s.session_id === this.activeId && this.activeFileKey === null ? " active" : "");
      item.title = `${s.command || "zsh"}\n${s.cwd}` + (s.agent_session_id ? `\n${s.agent_kind}: ${s.agent_session_id}` : "") + "\ndouble-click to rename";
      const presentation = this.titlePresentation(s);
      const dot = document.createElement("span");
      dot.className = "status-dot" + (s.running ? "" : " exited") +
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
      spinner.classList.toggle("on", presentation.spinning);
      this.sessionSpinnerEls.set(s.session_id, spinner);
      const title = document.createElement("span");
      title.className = "session-title";
      title.textContent = presentation.text;
      this.sessionTitleEls.set(s.session_id, title);
      const typeIcon = this.terminalTypeIcon(s);
      const close = document.createElement("button");
      close.className = "item-close";
      close.textContent = "✕";
      close.title = "Close terminal (⌘⇧⌫ when active)";
      close.onclick = (e) => { e.stopPropagation(); this.closeSession(s.session_id); };
      item.append(dot, spinner, typeIcon, title, close);
      item.onclick = () => this.activate(s.session_id);
      item.oncontextmenu = (e) => this.openSessionContextMenu(e, s);
      item.ondblclick = () => this.renameSession(s);
      this.makeDraggable(item, "session", s.session_id, (dragged, target) => this.reorderSessions(dragged, target));
      list.appendChild(item);
    }
    if (this.openFiles.size) {
      list.appendChild(this.sectionLabel("open files"));
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
        this.makeDraggable(item, "file", key, (dragged, target) => this.reorderFiles(dragged, target));
        list.appendChild(item);
      }
    }
    this.renderRecentFilesInto(list);
    this.renderClosedInto(list);
    this.$("empty-state").style.display = this.sessions.length || this.openFiles.size ? "none" : "flex";
    this.sessionListSignature = this.sessionListSignatureFor();
  }

  keepActiveSessionVisible() {
    if (!this.activeId || this.activeFileKey !== null) return;
    const title = this.sessionTitleEls.get(this.activeId);
    const row = title && title.closest(".session-item");
    if (!row) return;
    requestAnimationFrame(() => row.scrollIntoView({ block: "nearest" }));
  }

  hidePathOverflow() {
    if (this.pathOverflowEl) this.pathOverflowEl.remove();
    this.pathOverflowEl = null;
  }

  showPathOverflow(row) {
    this.hidePathOverflow();
    if (this.activeFileKey !== null || !row || !row.title) return;
    const label = document.createElement("div");
    label.className = "path-overflow-label";
    label.textContent = row.title.split("\n", 1)[0];
    document.body.appendChild(label);
    const rect = row.getBoundingClientRect();
    const left = Math.max(8, rect.left);
    label.style.left = left + "px";
    label.style.top = rect.top + "px";
    label.style.maxWidth = Math.max(180, window.innerWidth - left - 12) + "px";
    this.pathOverflowEl = label;
  }

  setSideView(view, allowToggle = true) {
    this.sideView = allowToggle && this.sideView === view && view !== "terminals" ? "terminals" : view;
    view = this.sideView;
    const filesVisible = view === "project" || view === "search";
    this.$("files-section").classList.toggle("hidden", !filesVisible);
    this.$("files-section").classList.toggle("with-search", view === "search");
    for (const name of ["terminals", "project", "search"]) {
      this.$("view-" + name).classList.toggle("on", name === view);
    }
    this.$("side-split").classList.toggle("hidden", view === "terminals");
    this.applySideLayout();
    if (filesVisible && this.treeRoot === null) this.reloadTree();
    if (!filesVisible) {
      this.hidePathOverflow();
      return;
    }
    if (view === "search") this.$("search-query").focus();
    if (view === "search" && this.$("search-query").value.trim()) this.runSearch(null, true);
    else if (view === "project") this.runNameSearch();
    else this.setExplorerMode("content");
  }

  focusFileNameSearch() {
    if (this.sideView !== "project") this.setSideView("project");
    const input = this.$("search-name");
    setTimeout(() => { input.focus(); input.select(); }, 0);
  }

  focusFileContentSearch() {
    if (this.sideView !== "search") this.setSideView("search");
    const input = this.$("search-query");
    setTimeout(() => { input.focus(); input.select(); }, 0);
  }

  updateFileBrowserMode() {
    const searchMode = this.sideView === "search";
    this.$("file-browser-name-mode").classList.toggle("on", !searchMode);
    this.$("file-browser-content-mode").classList.toggle("on", searchMode);
  }

  openFileBrowserModal() {
    if (this.fileBrowserModalOpen) {
      if (this.sideView === "search") this.focusFileContentSearch();
      else this.focusFileNameSearch();
      return;
    }
    const section = this.$("files-section");
    this.fileBrowserPreviousView = this.sideView;
    this.fileBrowserOrigin = { parent: section.parentNode, next: section.nextSibling };
    const targetView = this.sideView === "search" ? "search" : "project";
    if (this.sideView !== targetView) this.setSideView(targetView);
    this.$("file-browser-host").appendChild(section);
    section.classList.add("file-modal-panel");
    section.style.height = "";
    section.style.flex = "1";
    section.classList.remove("hidden");
    this.fileBrowserModalOpen = true;
    this.$("file-browser-backdrop").classList.remove("hidden");
    this.updateFileBrowserMode();
    if (targetView === "search") this.focusFileContentSearch();
    else this.focusFileNameSearch();
  }

  closeFileBrowserModal() {
    if (!this.fileBrowserModalOpen) return;
    const section = this.$("files-section");
    if (this.fileBrowserOrigin) {
      this.fileBrowserOrigin.parent.insertBefore(section, this.fileBrowserOrigin.next);
    }
    section.classList.remove("file-modal-panel");
    this.fileBrowserModalOpen = false;
    this.fileBrowserOrigin = null;
    this.$("file-browser-backdrop").classList.add("hidden");
    this.setSideView(this.fileBrowserPreviousView, false);
  }

  setExplorerMode(mode) {
    this.$("files-tree").classList.toggle("hidden", mode !== "tree");
    this.$("search-results").classList.toggle("hidden", mode !== "content");
    this.$("name-results").classList.toggle("hidden", mode !== "name");
  }

  cycleView(view) {
    if (this.sideView !== view) {
      this.settings.side_full = !this.settings.side_split_user_set;
      this.setSideView(view);
      this.saveSettings();
      if (view === "project") this.focusFileNameSearch();
      else if (view === "search") this.focusFileContentSearch();
    } else {
      this.settings.side_full = false;
      this.saveSettings();
      this.setSideView("terminals");
    }
  }

  applySideLayout() {
    const sectionId = (this.sideView === "project" || this.sideView === "search") ? "files-section" : null;
    const full = !!this.settings.side_full && !!sectionId;
    this.$("session-list").classList.toggle("collapsed", full);
    if (!sectionId) return;
    const section = this.$(sectionId);
    if (this.fileBrowserModalOpen) {
      section.style.height = "";
      section.style.flex = "1";
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
        menu.classList.add("hidden");
        handler();
      };
    }
    menu.appendChild(item);
  }

  openSessionContextMenu(event, session) {
    event.preventDefault();
    event.stopPropagation();
    const menu = this.$("context-menu");
    menu.textContent = "";
    const pinned = (this.getProjectState().pinned_sessions || []).includes(session.session_id);
    this.addContextItem(menu, pinned ? "Unpin terminal" : "Pin terminal to the top",
      () => this.togglePin(session.session_id), pinned ? "pinned" : "pin");
    this.addContextItem(menu, "Fork into a new terminal", () => this.forkSession(session), "repo-forked");
    this.addContextItem(menu, "Restart terminal", () => this.restartSession(session.session_id), "refresh");
    menu.classList.remove("hidden");
    menu.style.left = Math.min(event.clientX, window.innerWidth - menu.offsetWidth - 10) + "px";
    menu.style.top = Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 10) + "px";
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
    this.pollTree();
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
    const recent = this.recentFiles.filter((entry) =>
      entry.path && !openKeys.has(`${this.recentFilesRoot}|${entry.path}`));
    if (!recent.length) return;
    list.appendChild(this.sectionLabel("recently edited files"));
    const body = document.createElement("div");
    body.className = "recent-files-list";
    for (const entry of recent) {
      const item = document.createElement("div");
      item.className = "file-item recent-file-item";
      item.tabIndex = 0;
      item.title = `${this.recentFilesRoot}/${entry.path}\nmodified ${new Date(entry.mtime * 1000).toLocaleString()}`;
      const name = document.createElement("span");
      name.className = "file-item-name";
      name.textContent = entry.path;
      const mtime = document.createElement("span");
      mtime.className = "recent-mtime";
      mtime.textContent = this.formatMtime(entry.mtime);
      mtime.title = new Date(entry.mtime * 1000).toLocaleString();
      item.append(this.fileTypeIconEl(entry.name, "file-type-icon"), name, mtime);
      item.onclick = () => this.openFile(this.recentFilesRoot, entry.path, null, null);
      body.appendChild(item);
    }
    list.appendChild(body);
  }

  async refreshRecentFiles(force = false) {
    if (this.recentFilesBusy || this.treeRoot === null || this.$("files-section").classList.contains("hidden")) return;
    if (!force && this.recentFilesRoot === this.treeRoot && Date.now() - this.recentFilesFetchedAt < TREE_POLL_MS) return;
    const root = this.treeRoot;
    this.recentFilesBusy = true;
    try {
      const res = await fetch(`/api/files/recent?root=${encodeURIComponent(root)}&limit=40`);
      if (!res.ok || this.treeRoot !== root) return;
      this.recentFiles = await res.json();
      this.recentFilesRoot = root;
      this.recentFilesFetchedAt = Date.now();
      this.renderList();
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
    for (const c of this.closedSessions) {
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
    document.title = tabTitle ? `${tabTitle} — TermDeck` : "TermDeck";
    const statusEl = this.$("status-name");
    if (entry) statusEl.textContent = entry.fullPath || `${entry.root}/${entry.path}`;
    else statusEl.textContent = s ? `${this.titlePresentation(s).text}  ·  ${s.cwd}` : "";
    statusEl.title = statusEl.textContent;
  }

  applyMainLayout() {
    const fileMode = this.activeFileKey !== null;
    const historyMode = this.historyOpen && !fileMode;
    this.$("editor-area").classList.toggle("hidden", !fileMode);
    this.$("history-area").classList.toggle("hidden", !historyMode);
    this.$("terminal-area").classList.toggle("hidden", fileMode || historyMode);
    this.$("history-btn").classList.toggle("on", historyMode);
    this.$("attach-btn").classList.toggle("hidden", historyMode || fileMode);
    this.updateHistoryThinkingIndicator();
    this.renderHistoryQueue();
    this.fitActive();
  }

  updateHistoryThinkingIndicator() {
    const indicator = this.$("history-thinking-banner");
    if (!indicator) return;
    const spinning = !!this.historyOpen && !!this.processingStates.get(this.activeId);
    indicator.classList.toggle("hidden", !spinning);
    const duration = this.$("history-thinking-duration");
    if (duration) {
      const since = this.processingSince.get(this.activeId);
      const seconds = since ? Math.max(0, Math.floor((Date.now() - since) / 1000)) : 0;
      duration.textContent = spinning ? `${seconds}s` : "";
    }
    if (spinning && !this.processingTimer) {
      this.processingTimer = setInterval(() => this.updateHistoryThinkingIndicator(), 1000);
    } else if (!spinning && this.processingTimer) {
      clearInterval(this.processingTimer);
      this.processingTimer = 0;
    }
  }

  renderHistoryQueue(view = this.views.get(this.activeId)) {
    const container = this.$("history-queued");
    const items = this.$("history-queued-items");
    const count = this.$("history-queued-count");
    if (!container || !items || !count) return;
    const queued = view?.promptQueue || [];
    container.classList.toggle("hidden", !this.historyOpen || !queued.length);
    count.textContent = queued.length ? `${queued.length} message${queued.length === 1 ? "" : "s"}` : "";
    items.textContent = "";
    queued.forEach((item, index) => {
      const row = document.createElement("div");
      row.className = "history-queued-item";
      const number = document.createElement("span");
      number.className = "history-queued-index";
      number.textContent = `${index + 1}.`;
      const text = document.createElement("span");
      text.className = "history-queued-text";
      text.textContent = item.text;
      row.append(number, text);
      items.appendChild(row);
    });
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
      this.showPromptDraft(view);
      this.$("history-prompt").focus();
    } else {
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
    this.historyFingerprint = "";
    this.historyTurns = [];
    this.historyLoaded = false;
    this.historyOpen = !!enabled && this.activeFileKey === null && !!this.activeId;
    this.applyMainLayout();
    if (this.historyOpen) {
      const sessionId = this.activeId;
      this.showPromptDraft(this.views.get(sessionId));
      this.loadHistory(sessionId).then(() => {
        if (this.historyOpen && sessionId === this.activeId) this.startHistoryRefresh();
      });
    } else {
      const view = this.views.get(this.activeId);
      if (view) {
        this.syncPromptToTerminal(view);
        view.term.focus();
      }
    }
  }

  startHistoryRefresh() {
    this.stopHistoryRefresh();
    this.historyRefreshTimer = setInterval(() => {
      if (!this.historyOpen || this.activeFileKey !== null || !this.activeId) return;
      this.loadHistory(this.activeId, { preserveScroll: true });
    }, HISTORY_REFRESH_MS);
  }

  stopHistoryRefresh() {
    if (this.historyRefreshTimer) clearInterval(this.historyRefreshTimer);
    this.historyRefreshTimer = 0;
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
    if (queue) {
      view.promptQueue.push({ text, userCount: this.historyTurns.filter((turn) => turn.role === "user").length });
      this.renderHistoryQueue(view);
    }
    view.ws.send(JSON.stringify({ type: "submit", text, bracketed, queue }));
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
    const sessionId = this.activeId;
    setTimeout(() => {
      if (this.historyOpen && sessionId === this.activeId) this.loadHistory(sessionId, { preserveScroll: true });
    }, 700);
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
        summary.textContent = turn.kind === "edit"
            ? this.historyEditSummary(turn)
            : turn.kind === "plan" && Array.isArray(turn.plan)
            ? `Plan · ${turn.plan.length} steps`
            : turn.kind === "thinking" && Array.isArray(turn.items)
            ? `Thinking · ${turn.items.length} operations`
            : (turn.title || turn.kind);
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
            heading.textContent = `${file.path || "Changes"} · +${additions} / −${removals}`;
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

  async loadHistory(sessionId, options = {}) {
    const body = this.$("history-body");
    const preserveScroll = options.preserveScroll === true;
    const previousScrollTop = body.scrollTop;
    const wasAtBottom = preserveScroll && body.scrollHeight - body.clientHeight - body.scrollTop < 80;
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
    if (sessionId !== this.activeId || !this.historyOpen) return;
    this.reconcileHistoryQueue(this.views.get(sessionId), turns);
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
    const s = this.session(sessionId);
    this.$("history-title").textContent = s ? this.effectiveTitle(s) : "";
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
    this.updateHistoryEditToggle();
    if (wasAtBottom) body.scrollTop = body.scrollHeight;
    else if (preserveScroll) body.scrollTop = Math.min(previousScrollTop, Math.max(0, body.scrollHeight - body.clientHeight));
    else body.scrollTop = body.scrollHeight;
  }

  renderMarkdown(text) {
    if (window.marked) {
      return marked.parse(text, { breaks: true, gfm: true });
    }
    const escaped = document.createElement("div");
    escaped.textContent = text;
    return escaped.innerHTML;
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
      this.processingStates.set(id, spinning);
      if (spinning && !this.processingSince.has(id)) this.processingSince.set(id, Date.now());
      if (!spinning) this.processingSince.delete(id);
    }
    this.activeFileKey = null;
    this.stopHistoryRefresh();
    this.historyOpen = false;
    this.historyFingerprint = "";
    this.historyTurns = [];
    this.historyLoaded = false;
    const previousView = previousId ? this.views.get(previousId) : null;
    this.activeId = id;
    this.historyOpen = !!this.settings.history_mode;
    if (options.history !== false) this.pushNav({ kind: "term", id });
    if (this.getProjectState().active_session_id !== id) {
      this.patchProjectState({ active_session_id: id });
    }
    const s = this.session(id);
    if (s && this.treeRoot !== null && this.treeRoot !== s.cwd && !this.$("files-section").classList.contains("hidden")) {
      this.reloadTree();
    }
    const view = this.ensureView(id);
    if (previousView && previousView !== view) {
      const buffer = previousView.term.buffer.active;
      previousView.keepBottom = buffer.viewportY >= buffer.baseY;
    }
    for (const [viewId, v] of this.views) {
      v.container.classList.toggle("visible", viewId === id);
    }
    this.applyMainLayout();
    if (this.historyOpen) {
      const historyId = id;
      this.loadHistory(historyId).then(() => {
        if (this.historyOpen && historyId === this.activeId) this.startHistoryRefresh();
      });
    }
    if (view) {
      if (!view.ws) this.connect(id, view);
      if (previousId !== id) {
        view.keepBottom = true;
        view.pinBottomUntil = Date.now() + 5000;
        this.scrollTerminalToBottom(view);
      } else if (view.keepBottom) {
        view.pinBottomUntil = Date.now() + 3000;
      }
      this.scheduleViewportSettle(view);
    }
    this.renderList();
    this.renderTopbar();
    if (options.reveal) this.keepActiveSessionVisible();
    requestAnimationFrame(() => {
      if (id === this.activeId) this.focusActiveEditor();
    });
  }

  ensureView(id) {
    if (this.views.has(id)) return this.views.get(id);
    const container = document.createElement("div");
    container.className = "term-container";
    this.$("terminal-area").appendChild(container);
    const term = new Terminal({
      fontSize: this.settings.terminal_font_size, fontFamily: '"SF Mono", Menlo, monospace', theme: this.termTheme(),
      scrollback: 20000, cursorBlink: true, macOptionIsMeta: true, allowProposedApi: true,
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(container);
    term.registerLinkProvider({ provideLinks: (y, cb) => this.providePathLinks(term, id, y, cb) });
    const view = { container, term, fit, ws: null, closed: false, everConnected: false, awaitingSnapshot: true,
                   replaying: false, pasting: false, cliTitle: null, pinBottomUntil: 0, programmaticScrollUntil: 0, scrollSettleTimer: 0,
                   replayTimer: 0, reconnectTimer: 0, settleFrame: 0, layoutObserver: null, keepBottom: true, lastSentCols: null, lastSentRows: null,
                   promptDraft: this.session(id)?.draft || "", promptPaste: false, promptEscape: "", promptEditing: false,
                   promptSubmitting: false, promptSubmitEntered: false, promptSubmitTimer: 0,
                   promptQueue: [],
                   promptDraftSyncPending: false, promptDraftSyncTimer: 0, pendingDraftSync: null, pendingTerminalDraft: null,
                   promptEditVersion: 0, promptSubmitVersion: -1 };
    container.addEventListener("wheel", () => {
      view.pinBottomUntil = 0;
      if (!this.terminalAtBottom(view)) view.keepBottom = false;
    }, { passive: true });
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
      if (s) { s.cli_title = title; s.processing = true; }
      const titleEl = this.sessionTitleEls.get(id);
      if (titleEl && s) titleEl.textContent = this.titlePresentation(s).text;
      this.updateProcessingState(id, !!s && this.titlePresentation(s).spinning);
      if (id === this.activeId) this.renderTopbar();
    });
    term.attachCustomKeyEventHandler((e) => this.handleTerminalEditingKeys(view, e));
    term.onData((data) => this.sendTrackedInput(view, data));
    term.onResize(({ cols, rows }) => this.sendResize(view, cols, rows));
    term.onScroll(() => {
      if (!view.container.classList.contains("visible")) return;
      const now = Date.now();
      if ((view.replaying && now < view.pinBottomUntil) || now < view.programmaticScrollUntil) return;
      view.keepBottom = this.terminalAtBottom(view);
      if (!view.keepBottom) view.pinBottomUntil = 0;
    });
    const viewport = container.querySelector(".xterm-viewport");
    if (viewport) viewport.addEventListener("scroll", () => {
      if (!view.container.classList.contains("visible") || Date.now() < view.programmaticScrollUntil) return;
      view.keepBottom = this.terminalAtBottom(view);
      if (!view.keepBottom) view.pinBottomUntil = 0;
    }, { passive: true });
    const ref = [...this.views.values()].find((v) => v.term.cols > 2);
    if (ref) term.resize(ref.term.cols, ref.term.rows);
    view.layoutObserver = new ResizeObserver(() => {
      if (!view.container.classList.contains("visible") || view.closed) return;
      view.fit.fit();
      const { cols, rows } = view.term;
      if (cols >= 2 && rows >= 2) this.sendResize(view, cols, rows);
      if (view.keepBottom || Date.now() < view.pinBottomUntil) this.scheduleViewportSettle(view);
    });
    view.layoutObserver.observe(container);
    this.views.set(id, view);
    return view;
  }

  connect(id, view) {
    if (view.closed) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws/${id}`);
    ws.binaryType = "arraybuffer";
    view.awaitingSnapshot = true;
    view.replaying = false;
    view.lastSentCols = null;
    view.lastSentRows = null;
    ws.onopen = () => {
      if (view.everConnected) {
        view.replaying = true;
        view.keepBottom = true;
        view.pinBottomUntil = Date.now() + 8000;
        view.term.reset();
      }
      view.everConnected = true;
      if (id === this.activeId) {
        this.fitActive();
        view.keepBottom = true;
        view.pinBottomUntil = Date.now() + 8000;
        this.scrollTerminalToBottom(view);
        this.scheduleViewportSettle(view);
      }
      this.flushPromptSync(view);
    };
    ws.onmessage = (e) => {
      if (typeof e.data === "string") { this.handleControl(id, view, JSON.parse(e.data)); return; }
      if (view.awaitingSnapshot) {
        view.awaitingSnapshot = false;
        view.replaying = true;
        view.keepBottom = true;
        view.pinBottomUntil = Date.now() + 8000;
        clearTimeout(view.replayTimer);
        view.replayTimer = setTimeout(() => { view.replaying = false; }, 2000);
        view.term.write(new Uint8Array(e.data), () => {
          this.refreshTerminal(view);
          clearTimeout(view.replayTimer);
          view.replaying = false;
          view.keepBottom = true;
          view.pinBottomUntil = Date.now() + 5000;
          this.scheduleViewportSettle(view);
        });
        return;
      }
      const followOutput = view.keepBottom || Date.now() < view.pinBottomUntil;
      view.term.write(new Uint8Array(e.data), () => {
        if (followOutput) {
          view.keepBottom = true;
          clearTimeout(view.scrollSettleTimer);
          view.scrollSettleTimer = setTimeout(() => {
            if (view.keepBottom || Date.now() < view.pinBottomUntil) this.scheduleViewportSettle(view);
          }, 250);
        }
      });
    };
    ws.onclose = () => {
      if (!view.closed) {
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
      if (key === "a") { e.preventDefault(); view.term.selectAll(); return false; }
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
      view.term.write(`\r\n\x1b[2m[termdeck] process exited (${msg.code})\x1b[0m\r\n`);
      view.pinBottomUntil = Date.now() + 5000;
    } else if (msg.type === "draft") {
      view.promptDraftSyncPending = false;
      clearTimeout(view.promptDraftSyncTimer);
      view.promptDraftSyncTimer = 0;
      if (view.promptSubmitting) {
        return;
      }
      if (!view.promptEditing) {
        view.promptDraft = String(msg.draft || "");
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
      view.pinBottomUntil = Date.now() + 4000;
      this.scrollTerminalToBottom(view);
    } else if (msg.type === "processing") {
      this.applySessionStatus({ session_id: id, processing: !!msg.processing });
      return;
    }
    this.refresh();
  }

  sendInput(view, data) {
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

  sendResize(view, cols, rows) {
    if (view.ws && view.ws.readyState === WebSocket.OPEN &&
        (view.lastSentCols !== cols || view.lastSentRows !== rows)) {
      view.lastSentCols = cols;
      view.lastSentRows = rows;
      view.ws.send(JSON.stringify({ type: "resize", cols, rows }));
    }
  }

  scrollActiveToBottom() {
    if (this.activeFileKey !== null) return;
    const view = this.views.get(this.activeId);
    if (!view) return;
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

  resyncActiveTerminal() {
    if (this.activeFileKey !== null || this.historyOpen || !this.activeId) return;
    const view = this.views.get(this.activeId);
    if (!view || view.closed) return;
    view.keepBottom = true;
    view.pinBottomUntil = Date.now() + 8000;
    view.term.reset();
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
    if (!view || !view.term) return false;
    const buffer = view.term.buffer.active;
    if (buffer.viewportY >= buffer.baseY - 1) return true;
    const viewport = view.container.querySelector(".xterm-viewport");
    return !!viewport && viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 2;
  }

  scrollTerminalToBottom(view) {
    view.programmaticScrollUntil = Date.now() + 1000;
    view.term.scrollToBottom();
    const viewport = view.container.querySelector(".xterm-viewport");
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }

  refreshTerminal(view) {
    if (!view || view.term.rows < 1) return;
    view.term.refresh(0, view.term.rows - 1);
  }

  scheduleViewportSettle(view) {
    if (view.settleFrame) cancelAnimationFrame(view.settleFrame);
    view.settleFrame = requestAnimationFrame(() => {
      view.settleFrame = requestAnimationFrame(() => {
        view.settleFrame = 0;
        if (view.keepBottom || Date.now() < view.pinBottomUntil) {
          view.keepBottom = true;
          this.scrollTerminalToBottom(view);
          const buffer = view.term.buffer.active;
          const atBottom = buffer.viewportY >= buffer.baseY;
          if (!atBottom || Date.now() < view.pinBottomUntil) {
            clearTimeout(view.scrollSettleTimer);
            view.scrollSettleTimer = setTimeout(() => {
              if (view.keepBottom || Date.now() < view.pinBottomUntil) this.scheduleViewportSettle(view);
            }, 250);
          }
        }
      });
    });
  }

  fitActive() {
    if (this.$("terminal-area").classList.contains("hidden")) return;
    const view = this.views.get(this.activeId);
    if (!view || !view.container.classList.contains("visible")) return;
    view.fit.fit();
    this.refreshTerminal(view);
    const { cols, rows } = view.term;
    if (cols < 2 || rows < 2) return;
    this.sendResize(view, cols, rows);
    if (view.keepBottom || Date.now() < view.pinBottomUntil) this.scheduleViewportSettle(view);
  }

  destroyView(id, view) {
    view.closed = true;
    if (view.layoutObserver) view.layoutObserver.disconnect();
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
      this.settings = { ...SETTINGS_DEFAULTS, ...incoming };
    } catch (err) {
      this.settings = { ...SETTINGS_DEFAULTS };
    }
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
    for (const f of lists.flat()) {
      if (f && f.root && f.path) {
        this.openFiles.set(`${f.root}|${f.path}`,
          { root: f.root, path: f.path, name: f.path.split("/").pop(), model: null, fullPath: null, truncated: false });
      }
    }
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
    sidebar.style.width = s.sidebar_width + "px";
    sidebar.style.minWidth = s.sidebar_width + "px";
    document.documentElement.style.setProperty("--sidebar-font-size", s.sidebar_font_size + "px");
    document.documentElement.style.setProperty("--code-font-size", s.code_font_size + "px");
    document.documentElement.style.setProperty("--diff-font-size", s.diff_font_size + "px");
    document.documentElement.style.setProperty("--tree-font-size", s.tree_font_size + "px");
    document.body.classList.toggle("theme-light", this.isLight());
    for (const view of this.views.values()) {
      if (view.term.options.fontSize !== s.terminal_font_size) view.term.options.fontSize = s.terminal_font_size;
      view.term.options.theme = this.termTheme();
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
          run: (ed) => ed.getAction("editor.action.startFindReplaceAction").run(),
        });
        this.editor.addAction({
          id: "termdeck-find-usages", label: "Find Usages in Project", contextMenuGroupId: "navigation",
          contextMenuOrder: 1.5, keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.F12],
          run: (ed) => {
            const word = ed.getModel()?.getWordAtPosition(ed.getPosition());
            if (!word) return;
            if (this.sideView !== "search") {
              this.sideView = "terminals";
              this.setSideView("search");
            }
            this.searchWord = true;
            this.$("search-word-toggle").classList.add("on");
            this.runSearch(word.word);
          },
        });
        resolve();
      });
    });
  }

  saveSettings() {
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
    pop.appendChild(this.buildToggleRow("Editor wrap", () => (this.settings.word_wrap ? "on" : "off"),
      () => { this.settings.word_wrap = !this.settings.word_wrap; }));
    pop.appendChild(this.buildToggleRow("Markdown transcript mode", () => (this.settings.history_mode ? "on" : "off"),
      () => { this.setHistoryMode(!this.settings.history_mode); }));
    pop.appendChild(this.buildActionRow("Keyboard shortcuts", "edit", () => { pop.classList.add("hidden"); this.openKeybindings(); }));
    pop.appendChild(this.buildActionRow("Export settings", "download", () => { pop.classList.add("hidden"); this.exportSettings(); }));
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
        this.settings[key] = Math.max(minWidth, Math.min(maxWidth, Math.round(width)));
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
    const label = this.$("files-root-label");
    label.textContent = this.treeRoot.replace(/^\/Users\/[^/]+/, "~");
    label.title = this.treeRoot;
    this.treeDirs.clear();
    this.expandedDirs.clear();
    this.recentFiles = [];
    this.recentFilesRoot = null;
    this.recentFilesFetchedAt = 0;
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
    let ordered = entries;
    if (this.settings.tree_sort === "mtime") {
      ordered = [...entries].sort((a, b) => (b.is_dir ? 1 : 0) - (a.is_dir ? 1 : 0) || (b.mtime || 0) - (a.mtime || 0));
    }
    for (const entry of ordered) {
      const excluded = entry.is_dir && this.isExcludedName(entry.name);
      if (excluded && this.settings.hide_excluded) continue;
      const row = document.createElement("div");
      row.className = "tree-row " + (entry.is_dir ? "dir" : "file") + (excluded ? " excluded" : "");
      row.tabIndex = 0;
      const childRel = relPath ? `${relPath}/${entry.name}` : entry.name;
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
        container.appendChild(row);
        if (this.expandedDirs.has(childRel)) this.expandDirRow(row, childRel);
      } else {
        const spacer = document.createElement("span");
        spacer.className = "tree-file-spacer";
        row.append(spacer, this.fileTypeIconEl(entry.name, "tree-type-icon"), name);
        row.dataset.rel = childRel;
        row.dataset.kind = "file";
        row.onclick = () => this.openFile(this.treeRoot, childRel, null, row);
        this.appendMtime(row, entry);
        container.appendChild(row);
      }
    }
  }

  appendMtime(row, entry) {
    if (!this.settings.show_mtime || !entry.mtime) return;
    const mtimeEl = document.createElement("span");
    mtimeEl.className = "tree-mtime";
    mtimeEl.textContent = this.formatMtime(entry.mtime);
    mtimeEl.title = new Date(entry.mtime * 1000).toLocaleString();
    row.appendChild(mtimeEl);
  }

  formatMtime(epochSeconds) {
    const ageSeconds = Date.now() / 1000 - epochSeconds;
    if (ageSeconds < 3600) return Math.max(1, Math.round(ageSeconds / 60)) + "m";
    if (ageSeconds < 86400) return Math.round(ageSeconds / 3600) + "h";
    if (ageSeconds < 604800) return Math.round(ageSeconds / 86400) + "d";
    const date = new Date(epochSeconds * 1000);
    return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
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

  async pollTree() {
    if (this.treePollBusy || this.treeRoot === null || this.$("files-section").classList.contains("hidden")) return;
    this.refreshRecentFiles();
    this.treePollBusy = true;
    try {
      for (const [relPath, info] of [...this.treeDirs]) {
        if (this.treeDirs.get(relPath) !== info) continue;
        const entries = await this.fetchDirEntries(relPath);
        if (entries === null || JSON.stringify(entries) === info.cache) continue;
        this.selectedTreeRow = null;
        await this.renderDirInto(info.container, relPath, entries);
      }
    } finally {
      this.treePollBusy = false;
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

  async openFile(root, path, line, treeRow) {
    const key = `${root}|${path}`;
    if (!this.openFiles.has(key)) {
      this.openFiles.set(key, { root, path, name: path.split("/").pop(), model: null, fullPath: null, truncated: false });
      this.persistOpenFiles();
    }
    this.markTreeSelection(treeRow || null);
    await this.activateFile(key, line);
  }

  positionPopover(pop, anchor) {
    const rect = anchor.getBoundingClientRect();
    pop.classList.remove("hidden");
    const below = rect.bottom + 6;
    const top = below + pop.offsetHeight > window.innerHeight - 8 ? rect.top - pop.offsetHeight - 6 : below;
    pop.style.top = Math.max(8, top) + "px";
    pop.style.left = Math.min(rect.left, window.innerWidth - pop.offsetWidth - 12) + "px";
  }

  async activateFile(key, line) {
    const entry = this.openFiles.get(key);
    if (!entry) return;
    this.hidePathOverflow();
    this.activeFileKey = key;
    this.pushNav({ kind: "file", key });
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
        this.activateFile(remaining[remaining.length - 1], null);
        return;
      }
      this.activeFileKey = null;
      this.applyMainLayout();
      const view = this.views.get(this.activeId);
      if (view) view.term.focus();
    }
    this.renderList();
    this.renderTopbar();
  }

  closeActiveItem() {
    if (this.activeFileKey !== null) this.closeFile(this.activeFileKey);
    else this.closeActive();
  }

  providePathLinks(term, sessionId, bufferLineNumber, callback) {
    const lineObj = term.buffer.active.getLine(bufferLineNumber - 1);
    if (!lineObj) { callback(undefined); return; }
    const text = lineObj.translateToString(true);
    const links = [];
    for (const m of text.matchAll(PATH_LINK_RE)) {
      const raw = m[0];
      const ext = raw.split(":")[0].split(".").pop().toLowerCase();
      if (!raw.includes("/") && !KNOWN_EXTS.has(ext)) continue;
      links.push({
        range: { start: { x: m.index + 1, y: bufferLineNumber }, end: { x: m.index + raw.length, y: bufferLineNumber } },
        text: raw,
        activate: (event, linkText) => this.openFileFromLink(sessionId, linkText),
      });
    }
    callback(links.length ? links : undefined);
  }

  openFileFromLink(sessionId, linkText) {
    const lineMatch = linkText.match(/:(\d+)$/);
    const path = lineMatch ? linkText.slice(0, lineMatch.index) : linkText;
    const line = lineMatch ? parseInt(lineMatch[1], 10) : null;
    const s = this.session(sessionId);
    this.openFile(s ? s.cwd : "~", path, line, null);
  }

  openModal() {
    const model = this.settings.last_model || DEFAULT_COMMAND;
    this.$("modal-model").value = MODEL_PERMISSIONS[model] ? model : DEFAULT_COMMAND;
    this.updateModalPermissions();
    this.$("modal-session-title").value = "";
    this.$("modal-session-ref").value = "";
    this.$("modal-cwd").value = this.projectRoot() || DEFAULT_CWD;
    this.$("modal-backdrop").classList.remove("hidden");
    this.$("modal-session-title").focus();
  }

  closeModal() {
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
    const model = this.$("modal-model").value;
    const permission = this.$("modal-permission").value;
    const title = this.$("modal-session-title").value;
    const sessionRef = this.$("modal-session-ref").value;
    const cwd = this.$("modal-cwd").value;
    this.settings.last_model = model;
    this.settings.last_permissions = { ...(this.settings.last_permissions || {}), [model]: permission };
    this.saveSettings();
    const res = await fetch("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, permission, session_ref: sessionRef, cwd, title }),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      alert(detail.detail || "failed to create session");
      return;
    }
    const created = await res.json();
    this.closeModal();
    await this.refresh();
    this.activate(created.session_id, { reveal: true });
  }

  openKeybindings() {
    const list = this.$("keys-list");
    list.textContent = "";
    for (const k of KEYBINDINGS) {
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
    for (const r of REFERENCE_KEYS) {
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
      this.settings.keybindings = { ...(this.settings.keybindings || {}), [actionId]: binding };
      this.saveSettings();
      bindEl.textContent = this.bindingToDisplay(binding);
    };
    document.addEventListener("keydown", handler, true);
  }

  resetKeybindings() {
    this.settings.keybindings = {};
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

  eventToBinding(e) {
    if (["Meta", "Shift", "Alt", "Control"].includes(e.key)) return "";
    const parts = [];
    if (e.metaKey) parts.push("Meta");
    if (e.ctrlKey) parts.push("Ctrl");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    parts.push(e.key.length === 1 ? e.key.toLowerCase() : e.key);
    return parts.join("+");
  }

  bindingFor(actionId) {
    return (this.settings.keybindings || {})[actionId] || KEYBINDINGS.find((k) => k.id === actionId).def;
  }

  bindingMap() {
    const map = {};
    for (const k of KEYBINDINGS) map[this.bindingFor(k.id)] = k.id;
    return map;
  }

  tryAppShortcut(e) {
    if (e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey) {
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
        this.openFileBrowserModal();
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

  runAction(actionId) {
    if (actionId === "new-terminal") this.openModal();
    else if (actionId === "close-item") this.closeActiveItem();
    else if (actionId === "save-file") { if (this.activeFileKey !== null) this.saveActiveFile(); }
    else if (actionId === "prev-terminal") this.cycleTerminal(-1);
    else if (actionId === "next-terminal") this.cycleTerminal(1);
    else if (actionId === "view-files") this.cycleView("project");
    else if (actionId === "view-search") this.cycleView("search");
    else if (actionId === "view-terminals") this.setSideView("terminals");
    else if (actionId === "toggle-history") this.toggleHistory();
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
    this.activate(ids[next], { history: false });
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
    await fetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
    this.refresh();
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

  searchRoot() {
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
      this.pushNav({ kind: "search", ...state });
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
        const lineEl = document.createElement("span");
        lineEl.className = "hit-line";
        lineEl.textContent = hit.line;
        const textEl = document.createElement("span");
        textEl.className = "hit-text";
        textEl.textContent = hit.text;
        hitRow.append(lineEl, textEl);
        hitRow.title = `${hit.path}:${hit.line}`;
        hitRow.onclick = () => this.openFile(root, hit.path, hit.line, null);
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
    if (this.settings.tree_sort === "mtime") return (b.mtime - a.mtime) || a.path.localeCompare(b.path);
    return (this.extRank(a.path) - this.extRank(b.path)) || a.path.localeCompare(b.path);
  }

  debouncedSearch() {
    clearTimeout(this.searchDebounce);
    const query = this.$("search-query").value.trim();
    if (!query) { this.$("search-results").textContent = ""; return; }
    this.searchDebounce = setTimeout(() => this.runSearch(), SEARCH_DEBOUNCE_MS);
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
    resultsEl.textContent = "";
    const summary = document.createElement("div");
    summary.className = "search-summary";
    summary.textContent = `${hits.length} file${hits.length === 1 ? "" : "s"}`;
    resultsEl.appendChild(summary);
    for (const hit of hits) {
      const row = document.createElement("div");
      row.className = "search-file clickable";
      row.tabIndex = 0;
      row.title = hit.path;
      row.append(this.fileTypeIconEl(hit.path.split("/").pop(), "file-type-icon"), document.createTextNode(hit.path));
      row.onclick = () => this.openFile(root, hit.path, null, null);
      resultsEl.appendChild(row);
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
