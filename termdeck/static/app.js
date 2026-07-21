const REFRESH_MS = 5000;
const TITLE_REFRESH_MS = 1000;
const TITLE_SPINNER_RE = /^[\u2800-\u28ff✳](\s+)/;
const RECONNECT_MS = 1500;
const DEFAULT_COMMAND = "codex";
const DEFAULT_CWD = "~/workspace/stock";
const SETTINGS_DEFAULTS = { sidebar_width: 250, files_width: 380, sidebar_font_size: 13, terminal_font_size: 13,
  viewer_font_size: 12, tree_font_size: 12, active_session_id: "", open_files: [], project_state: {}, theme: "dark",
  ignored_dirs: [], hide_excluded: false, side_split: 0.55, side_full: false, show_stats: true,
  tree_sort: "name", show_mtime: false, word_wrap: false, search_glob: "!*.json, !*.csv", keybindings: {},
  last_command: "codex", last_model: "codex", last_permissions: { codex: "default", claude: "default", none: "default" } };
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
  { id: "new-terminal", label: "New terminal", def: "Meta+k" },
  { id: "close-item", label: "Close active terminal / file", def: "Meta+Shift+Backspace" },
  { id: "save-file", label: "Save open file", def: "Meta+s" },
  { id: "prev-terminal", label: "Previous terminal", def: "Meta+Alt+ArrowUp" },
  { id: "next-terminal", label: "Next terminal", def: "Meta+Alt+ArrowDown" },
  { id: "view-files", label: "Files view (cycle show / full / hide)", def: "Meta+Shift+e" },
  { id: "view-search", label: "Search view (cycle show / full / hide)", def: "Meta+Shift+f" },
  { id: "view-terminals", label: "Terminals view", def: "Meta+Shift+t" },
];
const REFERENCE_KEYS = [
  { keys: "⌘⌫ / ⌥⌫", label: "Delete to line start / delete word (in terminal)" },
  { keys: "⌘← / ⌘→", label: "Line start / end (in terminal)" },
  { keys: "⌘A", label: "Select all terminal text" },
  { keys: "⌘[ / ⌘]", label: "Back / forward (browser history: terminals, files, searches)" },
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
    this.closedExpanded = false;
    this.settings = { ...SETTINGS_DEFAULTS };
    this.saveTimer = null;
    this.treeRoot = null;
    this.treeDirs = new Map();
    this.expandedDirs = new Set();
    this.treePollBusy = false;
    this.sideView = "terminals";
    this.searchWord = false;
    this.searchCase = false;
    this.searchRegex = false;
    this.searchHistory = [];
    this.applyingHistory = false;
    this.lastNavJson = "";
    this.sessionTitleEls = new Map();
    this.sessionSpinnerEls = new Map();
    this.sessionStatusEls = new Map();
    this.processingStates = new Map();
    this.unreadSessions = new Set();
    this.statHistory = [];
    this.editor = null;
    this.selectedTreeRow = null;
    this.iconMap = null;
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
    return states[this.projectStateKey()] || { active_session_id: "", open_files: [], pinned_sessions: [] };
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
       { label: "Viewer font", key: "viewer_font_size" }, { label: "Tree/search font", key: "tree_font_size" }]);
    for (const view of ["terminals", "project", "search"]) {
      this.$("view-" + view).onclick = () => this.setSideView(view);
    }
    this.$("view-project").ondblclick = () => { if (this.sideView !== "project") this.setSideView("project"); this.toggleSideFull(); };
    this.$("view-search").ondblclick = () => { if (this.sideView !== "search") this.setSideView("search"); this.toggleSideFull(); };
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
    this.$("expand-toggle").onclick = () => this.toggleSideFull();
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
    this.$("history-close").onclick = () => this.closeHistory();
    this.$("attach-btn").onclick = () => this.attachToActive();
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
    this.refresh();
    setInterval(() => this.refresh(), REFRESH_MS);
    setInterval(() => this.refreshTitles(), TITLE_REFRESH_MS);
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
    this.sessions = this.applySessionOrder(sessions);
    this.closedSessions = closed;
    for (const s of this.sessions) {
      const spinning = this.titlePresentation(s).spinning;
      if (!this.processingStates.has(s.session_id)) this.processingStates.set(s.session_id, spinning);
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
    this.renderList();
    this.renderTopbar();
  }

  async refreshTitles() {
    let sessions;
    try {
      const res = await fetch("/api/sessions" + this.projectQuery());
      if (!res.ok) return;
      sessions = await res.json();
    } catch (err) {
      return;
    }
    let activeTitleChanged = false;
    for (const incoming of sessions) {
      const current = this.session(incoming.session_id);
      if (!current || (current.cli_title === incoming.cli_title && current.processing === incoming.processing)) continue;
      current.cli_title = incoming.cli_title;
      current.processing = incoming.processing;
      const presentation = this.titlePresentation(current);
      const titleEl = this.sessionTitleEls.get(incoming.session_id);
      if (titleEl) titleEl.textContent = presentation.text;
      this.updateProcessingState(current.session_id, presentation.spinning);
      if (incoming.session_id === this.activeId) activeTitleChanged = true;
    }
    if (activeTitleChanged) this.renderTopbar();
  }

  titlePresentation(s) {
    const title = this.effectiveTitle(s);
    const spinner = title.match(TITLE_SPINNER_RE);
    return spinner ? { text: title.slice(spinner[0].length), spinning: s.processing !== false } : { text: title, spinning: false };
  }

  updateSessionSpinner(id, spinning) {
    const spinner = this.sessionSpinnerEls.get(id);
    if (spinner) spinner.classList.toggle("on", spinning);
  }

  updateUnreadIndicator(id) {
    const dot = this.sessionStatusEls.get(id);
    if (!dot) return;
    dot.classList.toggle("unread", this.unreadSessions.has(id) && !this.processingStates.get(id));
  }

  updateProcessingState(id, spinning) {
    const previous = this.processingStates.get(id);
    if (previous === true && !spinning) this.unreadSessions.add(id);
    this.processingStates.set(id, spinning);
    this.updateSessionSpinner(id, spinning);
    this.updateUnreadIndicator(id);
  }

  session(id) {
    return this.sessions.find((s) => s.session_id === id) || null;
  }

  effectiveTitle(s) {
    if (!s.title_user_set) return s.cli_title || s.title;
    const spinner = s.cli_title && /^([⠀-⣿○-◗⠁-⣿⏳⚡]+\s*)/.exec(s.cli_title);
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
    label.textContent = text;
    return label;
  }

  renderList() {
    const list = this.$("session-list");
    list.textContent = "";
    this.sessionTitleEls.clear();
    this.sessionSpinnerEls.clear();
    this.sessionStatusEls.clear();
    if (this.sessions.length) list.appendChild(this.sectionLabel("terminals"));
    for (const s of this.sessions) {
      const item = document.createElement("div");
      item.className = "session-item" + (s.session_id === this.activeId && this.activeFileKey === null ? " active" : "");
      item.title = `${s.command || "zsh"}\n${s.cwd}` + (s.agent_session_id ? `\n${s.agent_kind}: ${s.agent_session_id}` : "") + "\ndouble-click to rename";
      const dot = document.createElement("span");
      dot.className = "status-dot" + (s.running ? "" : " exited") +
        (this.unreadSessions.has(s.session_id) && !this.processingStates.get(s.session_id) ? " unread" : "");
      this.sessionStatusEls.set(s.session_id, dot);
      const spinner = document.createElement("span");
      spinner.className = "session-spinner";
      spinner.innerHTML = "<i></i>";
      spinner.firstElementChild.style.animationDelay = `-${Date.now() % 2400}ms`;
      const presentation = this.titlePresentation(s);
      spinner.classList.toggle("on", presentation.spinning);
      this.sessionSpinnerEls.set(s.session_id, spinner);
      const title = document.createElement("span");
      title.className = "session-title";
      title.textContent = presentation.text;
      this.sessionTitleEls.set(s.session_id, title);
      const agentKind = document.createElement("span");
      agentKind.className = "agent-kind agent-kind-" + (s.agent_kind || "none");
      const agentLabel = { claude: "Cl", codex: "Cx" }[s.agent_kind];
      if (agentLabel) {
        agentKind.textContent = agentLabel;
        agentKind.title = s.agent_kind === "claude" ? "Claude" : "Codex";
      }
      const pin = document.createElement("button");
      const pinned = (this.getProjectState().pinned_sessions || []).includes(s.session_id);
      pin.className = "row-action pin-action" + (pinned ? " on" : "");
      pin.innerHTML = `<span class="codicon codicon-${pinned ? "pinned" : "pin"}"></span>`;
      pin.title = pinned ? "Unpin terminal" : "Pin terminal to the top";
      pin.onclick = (e) => { e.stopPropagation(); this.togglePin(s.session_id); };
      const fork = document.createElement("button");
      fork.className = "row-action";
      fork.innerHTML = '<span class="codicon codicon-repo-forked"></span>';
      fork.title = "Fork into a new terminal (branches the agent session)";
      fork.onclick = (e) => { e.stopPropagation(); this.forkSession(s); };
      const restart = document.createElement("button");
      restart.className = "row-action";
      restart.innerHTML = '<span class="codicon codicon-refresh"></span>';
      restart.title = "Restart — relaunch this terminal, resuming the same session (recovery for a hung agent)";
      restart.onclick = (e) => { e.stopPropagation(); this.restartSession(s.session_id); };
      const close = document.createElement("button");
      close.className = "item-close";
      close.textContent = "✕";
      close.title = "Close terminal (⌘⇧⌫ when active)";
      close.onclick = (e) => { e.stopPropagation(); this.closeSession(s.session_id); };
      item.append(dot, spinner, agentKind, title, pin, fork, restart, close);
      item.onclick = () => this.activate(s.session_id);
      item.ondblclick = () => this.renameSession(s);
      this.makeDraggable(item, "session", s.session_id, (dragged, target) => this.reorderSessions(dragged, target));
      list.appendChild(item);
    }
    if (this.openFiles.size) {
      list.appendChild(this.sectionLabel("open files"));
      for (const [key, entry] of this.openFiles) {
        const item = document.createElement("div");
        item.className = "file-item" + (key === this.activeFileKey ? " active" : "");
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
    this.renderClosedInto(list);
    this.$("empty-state").style.display = this.sessions.length || this.openFiles.size ? "none" : "flex";
    this.keepActiveSessionVisible();
  }

  keepActiveSessionVisible() {
    if (!this.activeId || this.activeFileKey !== null) return;
    const title = this.sessionTitleEls.get(this.activeId);
    const row = title && title.closest(".session-item");
    if (!row) return;
    requestAnimationFrame(() => row.scrollIntoView({ block: "nearest" }));
  }

  setSideView(view) {
    this.sideView = this.sideView === view && view !== "terminals" ? "terminals" : view;
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
    if (!filesVisible) return;
    if (view === "search") this.$("search-query").focus();
    if (view === "search" && this.$("search-query").value.trim()) this.runSearch(null, true);
    else if (this.$("search-name").value.trim()) this.runNameSearch();
    else this.setExplorerMode("tree");
  }

  setExplorerMode(mode) {
    this.$("files-tree").classList.toggle("hidden", mode !== "tree");
    this.$("search-results").classList.toggle("hidden", mode !== "content");
    this.$("name-results").classList.toggle("hidden", mode !== "name");
  }

  cycleView(view) {
    if (this.sideView !== view) {
      this.settings.side_full = false;
      this.setSideView(view);
    } else if (!this.settings.side_full) {
      this.settings.side_full = true;
      this.applySideLayout();
      this.saveSettings();
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
    const expandBtn = this.$("expand-toggle");
    expandBtn.classList.toggle("on", full);
    expandBtn.querySelector(".codicon").className = "codicon " + (full ? "codicon-screen-normal" : "codicon-screen-full");
    if (!sectionId) return;
    const section = this.$(sectionId);
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

  addContextItem(menu, label, handler) {
    const item = document.createElement("div");
    item.className = "context-item" + (handler ? "" : " disabled");
    item.textContent = label;
    if (handler) {
      item.onclick = () => {
        menu.classList.add("hidden");
        handler();
      };
    }
    menu.appendChild(item);
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

  renderClosedInto(list) {
    if (!this.closedSessions.length) return;
    const header = document.createElement("div");
    header.className = "side-section-label closed-header";
    const chevron = document.createElement("span");
    chevron.className = "codicon codicon-chevron-right closed-chevron" + (this.closedExpanded ? " open" : "");
    header.append(chevron, document.createTextNode(`closed (${this.closedSessions.length})`));
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
    this.fitActive();
  }

  closeHistory() {
    this.historyOpen = false;
    this.applyMainLayout();
    const view = this.views.get(this.activeId);
    if (view) view.term.focus();
  }

  async toggleHistory() {
    if (this.activeFileKey !== null) return;
    if (this.historyOpen) { this.closeHistory(); return; }
    if (!this.activeId) return;
    this.historyOpen = true;
    this.applyMainLayout();
    await this.loadHistory(this.activeId);
  }

  async loadHistory(sessionId) {
    const body = this.$("history-body");
    body.textContent = "";
    const loading = document.createElement("div");
    loading.className = "history-empty";
    loading.textContent = "loading transcript…";
    body.appendChild(loading);
    let turns = [];
    try {
      const res = await fetch(`/api/sessions/${sessionId}/history`);
      turns = await res.json();
    } catch (err) {
      turns = [];
    }
    if (sessionId !== this.activeId || !this.historyOpen) return;
    body.textContent = "";
    const s = this.session(sessionId);
    this.$("history-title").textContent = s ? `Full transcript · ${this.effectiveTitle(s)}` : "Full transcript";
    if (!turns.length) {
      const empty = document.createElement("div");
      empty.className = "history-empty";
      empty.textContent = s && s.agent_kind !== "none"
        ? "no transcript found yet (send a message first, or the session id isn't resolved)"
        : "transcript history is only available for claude/codex terminals";
      body.appendChild(empty);
      return;
    }
    for (const turn of turns) {
      const block = document.createElement("div");
      block.className = "turn " + turn.role;
      const role = document.createElement("div");
      role.className = "turn-role";
      role.textContent = turn.role;
      const text = document.createElement("div");
      text.className = "turn-text markdown";
      text.innerHTML = this.renderMarkdown(turn.text);
      block.append(role, text);
      body.appendChild(block);
    }
    body.scrollTop = body.scrollHeight;
  }

  renderMarkdown(text) {
    if (window.marked) {
      return marked.parse(text, { breaks: true, gfm: true });
    }
    const escaped = document.createElement("div");
    escaped.textContent = text;
    return escaped.innerHTML;
  }

  activate(id) {
    const previousId = this.activeId;
    if (previousId && previousId !== id) {
      this.unreadSessions.delete(previousId);
      this.updateUnreadIndicator(previousId);
    }
    if (previousId !== id) {
      this.unreadSessions.delete(id);
      this.updateUnreadIndicator(id);
    }
    this.activeFileKey = null;
    this.historyOpen = false;
    this.activeId = id;
    this.pushNav({ kind: "term", id });
    if (this.getProjectState().active_session_id !== id) {
      this.patchProjectState({ active_session_id: id });
    }
    const s = this.session(id);
    if (s && this.treeRoot !== null && this.treeRoot !== s.cwd && !this.$("files-section").classList.contains("hidden")) {
      this.reloadTree();
    }
    const view = this.ensureView(id);
    const previousView = this.views.get(this.activeId);
    if (previousView && previousView !== view) {
      const buffer = previousView.term.buffer.active;
      previousView.keepBottom = buffer.viewportY >= buffer.baseY;
    }
    for (const [viewId, v] of this.views) {
      v.container.classList.toggle("visible", viewId === id);
    }
    this.applyMainLayout();
    if (view) {
      if (!view.ws) this.connect(id, view);
      view.term.focus();
      if (view.keepBottom) view.pinBottomUntil = Date.now() + 3000;
      this.scheduleViewportSettle(view);
    }
    this.renderList();
    this.renderTopbar();
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
                   replaying: false, pasting: false, cliTitle: null, pinBottomUntil: 0, scrollSettleTimer: 0,
                   replayTimer: 0, settleFrame: 0, keepBottom: true, lastSentCols: null, lastSentRows: null };
    container.addEventListener("wheel", () => { view.pinBottomUntil = 0; }, { passive: true });
    container.addEventListener("paste", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const cd = e.clipboardData || window.clipboardData;
      const files = cd && cd.files && cd.files.length ? [...cd.files] : [];
      if (files.length) { this.uploadAndInsert(view, files); return; }
      const text = cd && (cd.getData("text/plain") || cd.getData("text"));
      if (!text || !view.ws || view.ws.readyState !== WebSocket.OPEN) return;
      const bracketed = !view.term.modes || view.term.modes.bracketedPasteMode !== false;
      this.sendInput(view, bracketed ? `\x1b[200~${text}\x1b[201~` : text);
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
    term.onData((data) => this.sendInput(view, data));
    term.onResize(({ cols, rows }) => this.sendResize(view, cols, rows));
    term.onScroll(() => {
      const buffer = term.buffer.active;
      view.keepBottom = buffer.viewportY >= buffer.baseY;
      if (!view.keepBottom) view.pinBottomUntil = 0;
    });
    const ref = [...this.views.values()].find((v) => v.term.cols > 2);
    if (ref) term.resize(ref.term.cols, ref.term.rows);
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
      if (view.everConnected) view.term.reset();
      view.everConnected = true;
      if (id === this.activeId) this.fitActive();
    };
    ws.onmessage = (e) => {
      if (typeof e.data === "string") { this.handleControl(id, view, JSON.parse(e.data)); return; }
      if (view.awaitingSnapshot) {
        view.awaitingSnapshot = false;
        view.replaying = true;
        view.pinBottomUntil = Date.now() + 3000;
        clearTimeout(view.replayTimer);
        view.replayTimer = setTimeout(() => { view.replaying = false; }, 2000);
        view.term.write(new Uint8Array(e.data), () => {
          clearTimeout(view.replayTimer);
          view.replaying = false;
          view.keepBottom = true;
          this.scheduleViewportSettle(view);
        });
        return;
      }
      view.term.write(new Uint8Array(e.data), () => {
        if (Date.now() < view.pinBottomUntil) {
          clearTimeout(view.scrollSettleTimer);
          view.scrollSettleTimer = setTimeout(() => {
            if (Date.now() < view.pinBottomUntil) this.scheduleViewportSettle(view);
          }, 250);
        }
      });
    };
    ws.onclose = () => {
      if (!view.closed) setTimeout(() => this.connect(id, view), RECONNECT_MS);
    };
    view.ws = ws;
  }

  handleTerminalEditingKeys(view, e) {
    if (e.type !== "keydown") return true;
    if (this.tryAppShortcut(e)) return false;
    if (e.key === "Enter" && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      this.sendInput(view, "\x1b\r");
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
      if (key === "backspace") { e.preventDefault(); this.sendInput(view, "\x15"); return false; }
      if (key === "arrowleft") { e.preventDefault(); this.sendInput(view, "\x01"); return false; }
      if (key === "arrowright") { e.preventDefault(); this.sendInput(view, "\x05"); return false; }
      if (key === "a") { e.preventDefault(); view.term.selectAll(); return false; }
    }
    if (e.altKey && !e.metaKey && !e.ctrlKey) {
      if (e.key === "Backspace") { e.preventDefault(); this.sendInput(view, "\x1b\x7f"); return false; }
      if (e.key === "ArrowLeft") { e.preventDefault(); this.sendInput(view, "\x1bb"); return false; }
      if (e.key === "ArrowRight") { e.preventDefault(); this.sendInput(view, "\x1bf"); return false; }
    }
    return true;
  }

  handleControl(id, view, msg) {
    if (msg.type === "exit") {
      view.term.write(`\r\n\x1b[2m[termdeck] process exited (${msg.code})\x1b[0m\r\n`);
      view.pinBottomUntil = Date.now() + 5000;
    } else if (msg.type === "agent_session") {
      view.pinBottomUntil = Date.now() + 4000;
      view.term.scrollToBottom();
    }
    this.refresh();
  }

  sendInput(view, data) {
    if (view.replaying && QUERY_RESPONSE_RE.test(data)) return;
    if (view.ws && view.ws.readyState === WebSocket.OPEN) {
      view.ws.send(JSON.stringify({ type: "input", data }));
    }
  }

  async uploadAndInsert(view, files) {
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
    if (!paths.length) { this.$("status-name").textContent = "upload failed"; return; }
    const text = paths.map((p) => (/\s/.test(p) ? `'${p}'` : p)).join(" ") + " ";
    if (view.ws && view.ws.readyState === WebSocket.OPEN) {
      const bracketed = !view.term.modes || view.term.modes.bracketedPasteMode !== false;
      view.ws.send(JSON.stringify({ type: "input", data: bracketed ? `\x1b[200~${text}\x1b[201~` : text }));
    }
    this.$("status-name").textContent = `inserted ${paths.length} path${paths.length === 1 ? "" : "s"}`;
    view.term.focus();
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

  scheduleViewportSettle(view) {
    if (view.settleFrame) cancelAnimationFrame(view.settleFrame);
    view.settleFrame = requestAnimationFrame(() => {
      view.settleFrame = requestAnimationFrame(() => {
        view.settleFrame = 0;
        if (view.keepBottom) view.term.scrollToBottom();
      });
    });
  }

  fitActive() {
    if (this.$("terminal-area").classList.contains("hidden")) return;
    const view = this.views.get(this.activeId);
    if (!view || !view.container.classList.contains("visible")) return;
    view.fit.fit();
    const { cols, rows } = view.term;
    if (cols < 2 || rows < 2) return;
    this.sendResize(view, cols, rows);
  }

  destroyView(id, view) {
    view.closed = true;
    if (view.ws) view.ws.close();
    view.term.dispose();
    view.container.remove();
    this.views.delete(id);
  }

  async loadSettings() {
    try {
      const res = await fetch("/api/settings");
      this.settings = { ...SETTINGS_DEFAULTS, ...(await res.json()) };
    } catch (err) {
      this.settings = { ...SETTINGS_DEFAULTS };
    }
    const states = this.settings.project_state || {};
    if (!Object.keys(states).length && (this.settings.active_session_id || (this.settings.open_files || []).length)) {
      states.__all__ = { active_session_id: this.settings.active_session_id, open_files: this.settings.open_files };
      this.settings.project_state = states;
    }
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
    document.documentElement.style.setProperty("--viewer-font-size", s.viewer_font_size + "px");
    document.documentElement.style.setProperty("--tree-font-size", s.tree_font_size + "px");
    document.body.classList.toggle("theme-light", this.isLight());
    for (const view of this.views.values()) {
      if (view.term.options.fontSize !== s.terminal_font_size) view.term.options.fontSize = s.terminal_font_size;
      view.term.options.theme = this.termTheme();
    }
    if (this.editor) {
      this.editor.updateOptions({ fontSize: s.viewer_font_size, wordWrap: s.word_wrap ? "on" : "off" });
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
          scrollBeyondLastLine: false, fontSize: this.settings.viewer_font_size, lineNumbersMinChars: 4,
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
    const tree = this.$("files-tree");
    tree.textContent = "";
    await this.renderDirInto(tree, "");
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
      const childRel = relPath ? `${relPath}/${entry.name}` : entry.name;
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
    this.$("modal-session-ref").value = "";
    this.$("modal-cwd").value = this.projectRoot() || DEFAULT_CWD;
    this.$("modal-backdrop").classList.remove("hidden");
    this.$("modal-command").focus();
    this.$("modal-command").select();
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
    const sessionRef = this.$("modal-session-ref").value;
    const cwd = this.$("modal-cwd").value;
    this.settings.last_model = model;
    this.settings.last_permissions = { ...(this.settings.last_permissions || {}), [model]: permission };
    this.saveSettings();
    const res = await fetch("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, permission, session_ref: sessionRef, cwd, title: "" }),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      alert(detail.detail || "failed to create session");
      return;
    }
    const created = await res.json();
    this.closeModal();
    await this.refresh();
    this.activate(created.session_id);
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
    const head = document.createElement("div");
    head.className = "ref-head";
    head.textContent = "Built-in (not editable)";
    ref.appendChild(head);
    for (const r of REFERENCE_KEYS) {
      const row = document.createElement("div");
      row.className = "ref-row";
      const lbl = document.createElement("span");
      lbl.textContent = r.label;
      const keys = document.createElement("span");
      keys.className = "ref-keys";
      keys.textContent = r.keys;
      row.append(lbl, keys);
      ref.appendChild(row);
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
    this.activate(ids[next]);
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
    this.activate(created.session_id);
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
    if (!this.$("search-name").value.trim()) { this.setExplorerMode("tree"); return; }
    this.nameDebounce = setTimeout(() => this.runNameSearch(), SEARCH_DEBOUNCE_MS);
  }

  async runNameSearch() {
    const query = this.$("search-name").value.trim();
    const resultsEl = this.$("name-results");
    resultsEl.textContent = "";
    if (!query) {
      this.setExplorerMode("tree");
      return;
    }
    if (this.sideView !== "project" && this.sideView !== "search") {
      this.sideView = "terminals";
      this.setSideView("project");
    }
    this.setExplorerMode("name");
    const root = this.searchRoot();
    const ignore = [...ALWAYS_EXCLUDED, ...(this.settings.ignored_dirs || [])].join(",");
    const res = await fetch(`/api/files/find?${new URLSearchParams({ root, q: query, ignore })}`);
    if (!res.ok) return;
    const hits = await res.json();
    const summary = document.createElement("div");
    summary.className = "search-summary";
    summary.textContent = `${hits.length} file${hits.length === 1 ? "" : "s"}`;
    resultsEl.appendChild(summary);
    for (const hit of hits) {
      const row = document.createElement("div");
      row.className = "search-file clickable";
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
      const res = await fetch("/api/stats");
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
