// In-app dialogs (dialogs.js) stand in for window.confirm / alert / prompt: the native ones block the
// event loop, cannot be styled or positioned, and can be permanently suppressed by the browser's
// "prevent this page from creating more dialogs" checkbox. confirm/prompt must be awaited; alert may be
// dropped where the caller does not depend on dismissal.
const uiConfirm = (...args) => window.TermdeckDialogs.confirm(...args);
const uiAlert = (...args) => window.TermdeckDialogs.alert(...args);
const uiPrompt = (...args) => window.TermdeckDialogs.prompt(...args);
const FILEDECK_TAB_SHORTCUTS = { tree: "d", search: "f", git: "g" };

class FileDeckApp {
  constructor() {
    this.projectName = decodeURIComponent(location.pathname.split("/")[2] || "");
    this.project = null;
    this.projects = [];
    this.settings = { ignored_dirs: [], hide_excluded: true, hide_dot_folders: true, file_tree_sort: "name", show_mtime: true, bottom_font_size: 14 };
    this.view = "tree";
    this.searchMode = "content";
    this.sortMode = "name";
    this.showMtime = true;
    this.editor = null;
    this.model = null;
    this.activePath = "";
    this.activeRow = null;
    this.treeGeneration = 0;
    this.inspectorMode = "history";
    this.inspectorPath = "";
    this.inspectorCommit = "";
    const params = new URLSearchParams(location.search);
    this.initialView = ["tree", "search", "git"].includes(params.get("view")) ? params.get("view") : "tree";
    this.initialSearchQuery = params.get("q") || "";
    this.$ = (id) => document.getElementById(id);
  }

  async start() {
    this.bindEvents();
    await this.loadProjects();
    await this.loadSettings();
    await this.initEditor();
    await this.loadTree();
    const path = new URLSearchParams(location.search).get("file") || "";
    if (path) await this.openFile(path);
    if (this.initialView !== "tree") this.setView(this.initialView);
    if (this.initialView === "search" && this.initialSearchQuery) {
      this.$("search-input").value = this.initialSearchQuery;
      await this.runSearch();
    }
  }

  bindEvents() {
    this.$("project-select").onchange = () => { location.href = `/f/${encodeURIComponent(this.$("project-select").value)}`; };
    for (const [view, id] of [["terminals", "filedeck-view-terminals"], ["tree", "filedeck-view-project"],
      ["search", "filedeck-view-search"], ["git", "filedeck-view-git"]]) {
      const button = this.$(id);
      button.onclick = () => view === "terminals" ? location.href = `/p/${encodeURIComponent(this.projectName)}` : this.setView(view);
      button.onauxclick = (event) => this.handleNavigationAuxClick(event, view);
    }
    this.$("files-tab-project").onclick = () => this.setView("tree");
    this.$("files-tab-search").onclick = () => this.setView("search");
    this.$("files-tab-git").onclick = () => this.setView("git");
    this.$("tree-refresh").onclick = () => this.refreshCurrentView();
    this.$("tree-sort-toggle").onclick = () => { this.sortMode = this.sortMode === "name" ? "mtime" : "name"; this.settings.file_tree_sort = this.sortMode; this.updateSortButton(); void this.persistSettings(); void this.loadTree(); };
    this.$("mtime-toggle").onclick = () => { this.settings.show_mtime = !this.settings.show_mtime; this.showMtime = this.settings.show_mtime; this.updateFileBrowserButtons(); void this.persistSettings(); void this.loadTree(); };
    this.$("hide-excluded-toggle").onclick = () => { this.settings.hide_excluded = !this.settings.hide_excluded; this.updateFileBrowserButtons(); void this.persistSettings(); void this.loadTree(); };
    this.$("search-content-mode").onclick = () => this.setSearchMode("content");
    this.$("search-name-mode").onclick = () => this.setSearchMode("name");
    this.$("search-button").onclick = () => void this.runSearch();
    this.$("search-input").onkeydown = (event) => {
      if (event.key === "Enter") { event.preventDefault(); void this.runSearch(); }
      if (event.key === "Escape") { event.preventDefault(); this.clearSearch(); }
    };
    this.$("search-case-toggle").onclick = (event) => event.currentTarget.classList.toggle("on");
    this.$("search-regex-toggle").onclick = (event) => event.currentTarget.classList.toggle("on");
    this.$("replace-toggle").onclick = () => this.$("replace-bar").classList.toggle("hidden");
    this.$("replace-button").onclick = () => void this.replaceAll();
    this.$("save-button").onclick = () => void this.saveFile();
    this.$("find-button").onclick = () => this.editor?.getAction("editor.action.startFindReplaceAction")?.run();
    this.$("new-tab-button").onclick = () => this.openNewTab(this.activePath);
    this.updateTabShortcutTitles();
    this.updateSortButton();
    this.updateFileBrowserButtons();
    this.$("git-inspector-close").onclick = () => this.closeInspector();
    document.querySelectorAll("#git-inspector-tabs button").forEach((button) => {
      button.onclick = () => this.openInspector(button.dataset.inspectorMode, this.inspectorPath, this.inspectorCommit);
    });
    document.addEventListener("mousedown", (event) => {
      const menu = this.$("filedeck-context-menu");
      if (!menu.classList.contains("hidden") && !menu.contains(event.target)) menu.classList.add("hidden");
    });
    window.addEventListener("keydown", (event) => {
      if (this.handleTabShortcut(event)) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void this.saveFile(); }
    });
  }

  async loadProjects() {
    const response = await fetch("/api/projects");
    if (!response.ok) throw new Error("project list unavailable");
    this.projects = await response.json();
    this.project = this.projects.find((candidate) => candidate.name === this.projectName);
    if (!this.project) throw new Error(`project not found: ${this.projectName}`);
    document.title = `${this.project.name} · FileDeck`;
    const select = this.$("project-select");
    select.textContent = "";
    for (const project of this.projects) {
      const option = document.createElement("option");
      option.value = project.name;
      option.textContent = project.name;
      option.title = project.root;
      option.selected = project.name === this.projectName;
      select.appendChild(option);
    }
    this.$("files-root-label").title = this.project.root;
    this.$("filedeck-status").textContent = this.project.root;
  }

  async loadSettings() {
    try {
      const response = await fetch("/api/settings");
      if (response.ok) this.settings = { ...this.settings, ...(await response.json()) };
    } catch (error) {
      this.setStatus("Using local file browser defaults");
    }
    this.sortMode = this.settings.file_tree_sort === "mtime" ? "mtime" : "name";
    this.showMtime = this.settings.show_mtime !== false;
    document.documentElement.style.setProperty("--ui-scale", String(this.normalizeUiScale((Number(this.settings.bottom_font_size) || 14) / 14)));
    this.updateSortButton();
    this.updateFileBrowserButtons();
  }

  normalizeUiScale(value) {
    return Math.max(0.8, Math.min(1.4, Math.round((Number(value) || 1) * 20) / 20));
  }

  updateTabShortcutTitles() {
    const labels = { tree: "Files", search: "Search", git: "Git" };
    for (const [view, key] of Object.entries(FILEDECK_TAB_SHORTCUTS)) {
      const button = this.$(`files-tab-${view === "tree" ? "project" : view}`);
      if (button) button.title = `${labels[view]} · ⌘⇧${key.toUpperCase()} / Ctrl⇧${key.toUpperCase()}`;
    }
  }

  handleTabShortcut(event) {
    if ((!event.metaKey && !event.ctrlKey) || !event.shiftKey || event.altKey) return false;
    const key = event.key.toLowerCase();
    const directView = Object.entries(FILEDECK_TAB_SHORTCUTS).find(([, shortcut]) => shortcut === key)?.[0];
    if (directView) {
      event.preventDefault();
      this.setView(directView);
      return true;
    }
    if (key === "s") {
      event.preventDefault();
      const views = ["tree", "search", "git"];
      this.setView(views[(views.indexOf(this.view) + 1) % views.length]);
      return true;
    }
    return false;
  }

  openNavigationViewInNewTab(view) {
    if (view === "terminals") {
      window.open(`/p/${encodeURIComponent(this.projectName)}`, "_blank", "noopener,noreferrer");
      return;
    }
    const params = new URLSearchParams({ view });
    if (this.activePath) params.set("file", this.activePath);
    if (view === "search" && this.$("search-input").value.trim()) params.set("q", this.$("search-input").value.trim());
    window.open(`/f/${encodeURIComponent(this.projectName)}?${params}`, "_blank", "noopener,noreferrer");
  }

  handleNavigationAuxClick(event, view) {
    if (event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    this.openNavigationViewInNewTab(view);
  }

  async persistSettings() {
    const response = await fetch("/api/settings");
    if (!response.ok) return;
    const current = await response.json();
    await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...current, ignored_dirs: this.settings.ignored_dirs, hide_excluded: this.settings.hide_excluded,
        hide_dot_folders: this.settings.hide_dot_folders, file_tree_sort: this.sortMode, show_mtime: this.showMtime }) });
  }

  updateFileBrowserButtons() {
    const excluded = this.$("hide-excluded-toggle");
    excluded.classList.toggle("on", !this.settings.hide_excluded);
    excluded.title = this.settings.hide_excluded ? "Show excluded folders" : "Hide excluded folders";
    this.$("mtime-toggle").classList.toggle("on", this.showMtime);
  }

  isExcludedName(name) {
    return TermDeckFileBrowser.alwaysExcluded.includes(name) || (this.settings.ignored_dirs || []).includes(name);
  }

  isDotFolderName(name) {
    return String(name || "").startsWith(".");
  }

  searchIgnoreTokens() {
    const tokens = [...TermDeckFileBrowser.alwaysExcluded, ...(this.settings.ignored_dirs || [])];
    if (this.settings.hide_dot_folders) tokens.push(".*");
    return [...new Set(tokens)].join(",");
  }

  async initEditor() {
    await new Promise((resolve) => {
      require.config({ paths: { vs: "/static/vendor/monaco/vs" } });
      require(["vs/editor/editor.main"], () => {
        monaco.editor.defineTheme("filedeck-theme", { base: "vs-dark", inherit: true, rules: [], colors: {
          "editor.background": "#0a0c10", "editorLineNumber.foreground": "#526174", "editorLineNumber.activeForeground": "#a9c7e8",
        }});
        this.editor = monaco.editor.create(this.$("monaco-host"), { theme: "filedeck-theme", automaticLayout: true,
          minimap: { enabled: false }, fontSize: 14, lineNumbersMinChars: 4, scrollBeyondLastLine: false,
          wordWrap: "off", fixedOverflowWidgets: true, padding: { top: 10, bottom: 10 } });
        this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void this.saveFile());
        resolve();
      });
    });
  }

  setView(view) {
    this.view = view;
    const buttons = [["files-tab-project", "tree"], ["files-tab-search", "search"], ["files-tab-git", "git"]];
    for (const [id, value] of buttons) this.$(id).classList.toggle("on", value === view);
    const footerButtons = [["filedeck-view-project", "tree"], ["filedeck-view-search", "search"], ["filedeck-view-git", "git"]];
    for (const [id, value] of footerButtons) this.$(id).classList.toggle("on", value === view);
    this.$("search-view-controls").classList.toggle("hidden", view !== "search");
    this.$("files-tree").classList.toggle("hidden", view !== "tree");
    this.$("search-results").classList.toggle("hidden", view !== "search");
    this.$("git-results").classList.toggle("hidden", view !== "git");
    this.$("branch-label").classList.toggle("hidden", view !== "git");
    this.$("files-root-label").textContent = view === "tree" ? "FILES" : view === "search" ? "SEARCH" : "GIT";
    if (view === "tree") void this.loadTree();
    if (view === "git") void this.loadGitView();
    if (view === "search") this.$("search-input").focus();
  }

  setSearchMode(mode) {
    this.searchMode = mode;
    this.$("search-content-mode").classList.toggle("on", mode === "content");
    this.$("search-name-mode").classList.toggle("on", mode === "name");
    this.$("replace-toggle").classList.toggle("hidden", mode !== "content");
    if (this.$("search-input").value.trim()) void this.runSearch();
  }

  refreshCurrentView() {
    if (this.view === "git") void this.loadGitView();
    else if (this.view === "search") void this.runSearch();
    else void this.loadTree();
  }

  async loadTree() {
    const generation = ++this.treeGeneration;
    const tree = this.$("files-tree");
    tree.textContent = "";
    await this.renderDirectory(tree, "", generation);
    if (generation === this.treeGeneration) this.setStatus("Files refreshed");
  }

  async renderDirectory(container, relativePath, generation) {
    const response = await fetch(`/api/files/list?${new URLSearchParams({ root: this.project.root, path: relativePath })}`);
    if (!response.ok || generation !== this.treeGeneration) return;
    let entries = await response.json();
    entries = [...entries].sort((left, right) => {
      if (this.sortMode === "mtime") {
        const order = Number(right.mtime || 0) - Number(left.mtime || 0);
        if (order) return order;
      } else {
        const order = Number(right.is_dir) - Number(left.is_dir);
        if (order) return order;
      }
      return String(left.name).localeCompare(String(right.name), undefined, { numeric: true, sensitivity: "base" });
    });
    for (const entry of entries) {
      const excluded = entry.is_dir && this.isExcludedName(entry.name);
      const hiddenDotFolder = entry.is_dir && this.settings.hide_dot_folders && this.isDotFolderName(entry.name);
      if (hiddenDotFolder || (excluded && this.settings.hide_excluded)) continue;
      const row = TermDeckFileBrowser.createTreeEntryRow({ root: this.project.root, relativePath, entry, excluded,
        showMtime: this.showMtime,
        onDirectory: (directoryRow, path) => void this.toggleDirectory(directoryRow, path),
        onFile: (event, fileRow, path) => void this.openFile(path, fileRow),
        onDoubleClick: (fileRow, path) => void this.openFile(path, fileRow),
        onAuxClick: (event, fileRow, path) => this.handleAuxClick(event, path),
        onContextMenu: (event, fileRow, path) => this.openContextMenu(event, path, entry.is_dir),
      });
      container.appendChild(row);
    }
  }

  async toggleDirectory(row, path) {
    const children = row.nextElementSibling;
    if (children?.classList.contains("tree-children-wrap")) {
      children.remove();
      row.classList.remove("open");
      row.querySelector(".tree-chevron")?.classList.replace("codicon-chevron-down", "codicon-chevron-right");
      row.querySelector(".tree-folder-icon").src = `${TermDeckFileBrowser.materialIconsBase}folder-project.svg`;
      return;
    }
    const childContainer = document.createElement("div");
    childContainer.className = "tree-children-wrap";
    row.after(childContainer);
    row.classList.add("open");
    row.querySelector(".tree-chevron")?.classList.replace("codicon-chevron-right", "codicon-chevron-down");
    row.querySelector(".tree-folder-icon").src = `${TermDeckFileBrowser.materialIconsBase}folder-project-open.svg`;
    await this.renderDirectory(childContainer, path, this.treeGeneration);
  }

  makeIndent(relativePath) {
    const indent = document.createElement("span");
    indent.className = "tree-file-spacer";
    return indent;
  }

  makeName(name) {
    const element = document.createElement("span");
    element.className = "tree-name";
    element.textContent = name;
    return element;
  }

  fileIcon(name, className = "tree-type-icon") {
    return TermDeckFileBrowser.fileIconElement(name, className);
  }

  appendMtime(row, entry) {
    TermDeckFileBrowser.appendEntryMetadata(row, { ...entry, git_status: "" }, { showMtime: this.showMtime });
  }

  appendGitStatus(row, status) {
    TermDeckFileBrowser.appendEntryMetadata(row, { git_status: status }, { showMtime: false });
  }

  formatMtime(epoch) {
    return TermDeckFileBrowser.formatMtime(epoch);
  }

  updateSortButton() {
    const button = this.$("tree-sort-toggle");
    button.classList.toggle("on", this.sortMode === "mtime");
    button.title = this.sortMode === "mtime" ? "Sort alphabetically" : "Sort by recently modified";
  }

  async openFile(path, row = null, line = null) {
    const response = await fetch(`/api/files/read?${new URLSearchParams({ root: this.project.root, path })}`);
    if (!response.ok) { this.setStatus("Unable to read file"); return; }
    const data = await response.json();
    this.activePath = path;
    this.activeRow?.classList.remove("selected");
    this.activeRow = row || this.$("files-tree").querySelector(`[data-path="${CSS.escape(path)}"]`);
    this.activeRow?.classList.add("selected");
    if (this.model) this.model.dispose();
    this.model = monaco.editor.createModel(data.content, undefined, monaco.Uri.parse(`filedeck://${encodeURIComponent(this.project.name)}/${encodeURIComponent(path)}`));
    this.editor.setModel(this.model);
    this.$("file-title").textContent = path;
    this.$("file-title").title = `${this.project.root}/${path}`;
    this.setStatus(data.truncated ? "File truncated to the configured read limit" : "Ready");
    this.editor.focus();
    if (line) {
      this.editor.setPosition({ lineNumber: Math.max(1, Number(line)), column: 1 });
      this.editor.revealLineInCenter(Number(line));
    }
    history.replaceState(null, "", `/f/${encodeURIComponent(this.project.name)}?file=${encodeURIComponent(path)}`);
  }

  openNewTab(path) {
    const suffix = path ? `?file=${encodeURIComponent(path)}` : "";
    window.open(`/f/${encodeURIComponent(this.project.name)}${suffix}`, "_blank", "noopener,noreferrer");
  }

  handleAuxClick(event, path) {
    if (event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    this.openNewTab(path);
  }

  openContextMenu(event, path, isDirectory) {
    event.preventDefault();
    event.stopPropagation();
    const menu = this.$("filedeck-context-menu");
    menu.textContent = "";
    const name = path.split("/").pop() || path;
    if (isDirectory) {
      if (TermDeckFileBrowser.alwaysExcluded.includes(name)) {
        this.addMenuItem(menu, `"${name}" is always excluded from search`, null);
      } else {
        const excluded = (this.settings.ignored_dirs || []).includes(name);
        this.addMenuItem(menu, excluded ? "Include in search" : "Exclude from search", () => this.toggleExcludedFolder(name));
      }
    } else {
      this.addMenuItem(menu, "Open", () => void this.openFile(path));
      this.addMenuItem(menu, "Open this file in a new browser tab", () => this.openNewTab(path));
      this.addMenuItem(menu, "Git history", () => void this.openInspector("history", path));
      this.addMenuItem(menu, "Git blame", () => void this.openInspector("blame", path));
      this.addMenuItem(menu, "Diff against HEAD", () => void this.openInspector("diff", path));
    }
    const parent = isDirectory ? path : path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    this.addMenuItem(menu, "New file…", () => void this.createPath(parent, false));
    this.addMenuItem(menu, "New folder…", () => void this.createPath(parent, true));
    this.addMenuItem(menu, "Rename…", () => void this.renamePath(path));
    this.addMenuItem(menu, "Duplicate…", () => void this.duplicatePath(path));
    this.addMenuItem(menu, "Move…", () => void this.movePath(path));
    this.addMenuItem(menu, "Delete (to Trash)", () => void this.deletePath(path));
    this.addMenuItem(menu, "Copy relative path", () => void this.copyText(path));
    this.addMenuItem(menu, "Copy absolute path", () => void this.copyText(`${this.project.root}/${path}`));
    this.addMenuItem(menu, "Search in project", () => { this.setView("search"); this.$("search-input").value = path.split("/").pop(); void this.runSearch(); });
    menu.classList.remove("hidden");
    menu.style.left = `${Math.min(event.clientX, window.innerWidth - menu.offsetWidth - 8)}px`;
    menu.style.top = `${Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 8)}px`;
  }

  addMenuItem(menu, label, handler) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.disabled = !handler;
    button.onclick = () => { if (!handler) return; menu.classList.add("hidden"); handler(); };
    menu.appendChild(button);
  }

  async copyText(value) {
    try {
      await navigator.clipboard.writeText(value);
      this.setStatus("Copied to clipboard");
    } catch (error) {
      this.setStatus("Clipboard unavailable");
    }
  }

  async fsOp(route, payload, failLabel) {
    const response = await fetch(route, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root: this.project.root, ...payload }) });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      this.setStatus(error.detail || failLabel);
      return null;
    }
    return await response.json();
  }

  async toggleExcludedFolder(name) {
    const ignored = new Set(this.settings.ignored_dirs || []);
    if (ignored.has(name)) ignored.delete(name);
    else ignored.add(name);
    this.settings.ignored_dirs = [...ignored].sort();
    await this.persistSettings();
    this.updateFileBrowserButtons();
    await this.loadTree();
  }

  async createPath(parent, directory) {
    const suggested = parent ? `${parent}/` : "";
    const value = await uiPrompt(`${directory ? "Folder" : "File"} path relative to ${this.project.root}`, suggested);
    if (!value || value === suggested) return;
    const result = await this.fsOp("/api/files/create", { path: value, directory }, "Create failed");
    if (!result) return;
    await this.loadTree();
    if (!directory) await this.openFile(result.rel);
  }

  async renamePath(path) {
    const name = path.split("/").pop() || path;
    const newName = await uiPrompt(`Rename "${name}" to`, name);
    if (!newName || newName === name) return;
    const result = await this.fsOp("/api/files/rename", { path, new_name: newName }, "Rename failed");
    if (!result) return;
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    const newPath = parent ? `${parent}/${result.new_name}` : result.new_name;
    if (this.activePath === path) await this.openFile(newPath);
    else await this.loadTree();
  }

  async duplicatePath(path) {
    const dot = path.lastIndexOf(".");
    const slash = path.lastIndexOf("/");
    const suggested = dot > slash ? `${path.slice(0, dot)} copy${path.slice(dot)}` : `${path} copy`;
    const destination = await uiPrompt(`Duplicate "${path}" to`, suggested);
    if (!destination || destination === path) return;
    if (await this.fsOp("/api/files/duplicate", { path, destination }, "Duplicate failed")) await this.loadTree();
  }

  async movePath(path) {
    const destination = await uiPrompt(`Move "${path}" to (relative to ${this.project.root})`, path);
    if (!destination || destination === path) return;
    const result = await this.fsOp("/api/files/move", { path, destination }, "Move failed");
    if (!result) return;
    if (this.activePath === path) await this.openFile(result.rel);
    else await this.loadTree();
  }

  async deletePath(path) {
    if (!await uiConfirm(`Move "${path}" to Trash?`)) return;
    const result = await this.fsOp("/api/files/delete", { path }, "Delete failed");
    if (!result) return;
    if (this.activePath === path) {
      this.activePath = "";
      this.model?.dispose();
      this.model = null;
      this.editor?.setModel(null);
      this.$("file-title").textContent = "Select a file";
    }
    await this.loadTree();
  }

  async runSearch() {
    const query = this.$("search-input").value.trim();
    if (!query) { this.clearSearch(); return; }
    const results = this.$("search-results");
    results.textContent = "";
    const summary = document.createElement("div");
    summary.className = "search-summary";
    summary.textContent = "searching…";
    results.appendChild(summary);
    const params = new URLSearchParams({ root: this.project.root, q: query, ignore: this.searchIgnoreTokens(), case_sensitive: this.$("search-case-toggle").classList.contains("on") ? "true" : "false" });
    if (this.searchMode === "content") {
      params.set("regex", this.$("search-regex-toggle").classList.contains("on") ? "true" : "false");
      params.set("glob", "");
    }
    const response = await fetch(`${this.searchMode === "name" ? "/api/files/find" : "/api/files/search"}?${params}`);
    if (!response.ok) { summary.textContent = "search failed"; return; }
    const hits = await response.json();
    results.textContent = "";
    if (!hits.length) { results.textContent = "No matches"; return; }
    if (this.searchMode === "name") this.renderNameResults(results, hits);
    else this.renderContentResults(results, hits);
    this.setStatus(`${hits.length} result${hits.length === 1 ? "" : "s"}`);
  }

  renderNameResults(container, hits) {
    const summary = document.createElement("div");
    summary.className = "search-summary";
    summary.textContent = `${hits.length} result${hits.length === 1 ? "" : "s"}`;
    container.appendChild(summary);
    for (const hit of hits) {
      const row = document.createElement("div");
      row.className = "search-file";
      row.title = hit.path;
      if (hit.is_dir) {
        const folder = document.createElement("span");
        folder.className = "codicon codicon-folder file-type-icon";
        row.appendChild(folder);
      } else row.appendChild(this.fileIcon(String(hit.path).split("/").pop(), "file-type-icon"));
      this.appendSearchPath(row, hit.path, !!hit.is_dir);
      this.appendMtime(row, hit);
      this.appendGitStatus(row, hit.git_status);
      if (hit.is_dir) {
        row.onclick = () => void this.revealDirectory(hit.path);
        row.oncontextmenu = (event) => this.openContextMenu(event, hit.path, true);
      }
      else {
        row.onclick = () => void this.openFile(hit.path, null, null);
        row.onauxclick = (event) => this.handleAuxClick(event, hit.path);
        row.oncontextmenu = (event) => this.openContextMenu(event, hit.path, false);
      }
      container.appendChild(row);
    }
  }

  async revealDirectory(path) {
    this.setView("tree");
    await this.loadTree();
    let relativePath = "";
    for (const part of String(path).split("/").filter(Boolean)) {
      relativePath = relativePath ? `${relativePath}/${part}` : part;
      const row = this.$("files-tree").querySelector(`[data-path="${CSS.escape(relativePath)}"]`);
      if (!row) return;
      if (relativePath !== path && !row.classList.contains("open")) await this.toggleDirectory(row, relativePath);
      if (relativePath === path) row.classList.add("selected");
    }
  }

  appendSearchPath(row, path, isDirectory) {
    const parts = String(path).split("/").filter(Boolean);
    const folders = isDirectory ? parts : parts.slice(0, -1);
    for (const [index, folder] of folders.entries()) {
      const part = document.createElement("span");
      part.className = "search-tree-path-part";
      part.textContent = folder;
      part.title = folder;
      row.appendChild(part);
      if (index < folders.length - 1 || !isDirectory) {
        const separator = document.createElement("span");
        separator.className = "search-tree-path-separator";
        separator.textContent = "›";
        row.appendChild(separator);
      }
    }
    if (!isDirectory) {
      const name = document.createElement("span");
      name.className = "search-file-name";
      name.textContent = parts.at(-1) || "";
      row.appendChild(name);
    }
  }

  renderContentResults(container, hits) {
    const byPath = new Map();
    for (const hit of hits) {
      if (!byPath.has(hit.path)) byPath.set(hit.path, { path: hit.path, mtime: hit.mtime, git_status: hit.git_status, hits: [] });
      byPath.get(hit.path).hits.push(hit);
    }
    const summary = document.createElement("div");
    summary.className = "search-summary";
    summary.textContent = `${hits.length} match${hits.length === 1 ? "" : "es"} in ${byPath.size} file${byPath.size === 1 ? "" : "s"}`;
    container.appendChild(summary);
    for (const file of byPath.values()) {
      const row = document.createElement("div");
      row.className = "search-file";
      row.title = file.path;
      row.append(this.fileIcon(file.path.split("/").pop(), "file-type-icon"));
      this.appendSearchPath(row, file.path, false);
      this.appendMtime(row, file);
      this.appendGitStatus(row, file.git_status);
      row.onclick = () => void this.openFile(file.path, null, file.hits[0]?.line);
      row.onauxclick = (event) => this.handleAuxClick(event, file.path);
      row.oncontextmenu = (event) => this.openContextMenu(event, file.path, false);
      container.appendChild(row);
      const hitContainer = document.createElement("div");
      hitContainer.className = "search-hits";
      for (const hit of file.hits.slice(0, 8)) {
        const hitRow = document.createElement("div");
        hitRow.className = "search-hit";
        const line = document.createElement("span");
        line.className = "hit-line";
        line.textContent = hit.line;
        const text = document.createElement("span");
        text.className = "hit-text";
        text.textContent = hit.text;
        hitRow.append(line, text);
        hitRow.onclick = (event) => { event.stopPropagation(); void this.openFile(file.path, null, hit.line); };
        hitContainer.appendChild(hitRow);
      }
      container.appendChild(hitContainer);
    }
  }

  clearSearch() {
    this.$("search-input").value = "";
    this.$("search-results").textContent = "";
    this.setStatus("Search cleared");
  }

  async replaceAll() {
    const query = this.$("search-input").value.trim();
    if (!query || this.searchMode !== "content") return;
    const replacement = this.$("replace-input").value;
    if (!await uiConfirm(`Replace all project matches for “${query}”?`)) return;
    const response = await fetch("/api/files/replace", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root: this.project.root, q: query, replacement, ignore: this.searchIgnoreTokens(), regex: this.$("search-regex-toggle").classList.contains("on"), case_sensitive: this.$("search-case-toggle").classList.contains("on") }) });
    if (!response.ok) { this.setStatus("Replace failed"); return; }
    const result = await response.json();
    this.setStatus(`Replaced ${result.replacements} match${result.replacements === 1 ? "" : "es"} in ${result.files} file${result.files === 1 ? "" : "s"}`);
    await this.loadTree();
    if (this.activePath) await this.openFile(this.activePath);
    if (this.view === "search") await this.runSearch();
  }

  async loadGitView() {
    const results = this.$("git-results");
    results.textContent = "Loading Git status…";
    const response = await fetch(`/api/files/git-branch?${new URLSearchParams({ root: this.project.root, limit: "100" })}`);
    if (!response.ok) { results.textContent = "Git status unavailable"; this.$("branch-label").textContent = "Git unavailable"; return; }
    const state = await response.json();
    this.$("branch-label").textContent = state.branch || "(detached HEAD)";
    this.$("branch-label").title = state.upstream ? `${state.branch} → ${state.upstream}` : state.branch;
    results.textContent = "";
    const files = state.files || [];
    const summary = document.createElement("div");
    summary.className = "git-summary";
    summary.textContent = files.length ? `${files.length} modified file${files.length === 1 ? "" : "s"} in ${state.branch}` : `Working tree clean · ${state.branch}`;
    results.appendChild(summary);
    this.renderGitGroupHeader(results, "working tree", "diff-modified");
    if (!files.length) {
      const empty = document.createElement("div");
      empty.className = "git-inspector-empty";
      empty.textContent = "No uncommitted changes on this branch.";
      results.appendChild(empty);
    }
    for (const file of files) this.renderGitFile(results, file);
    this.renderGitGroupHeader(results, "branch history", "history");
    for (const commit of (state.commits || []).slice(0, 20)) {
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
      date.textContent = this.gitDate(commit.committed_at);
      row.append(id, message, date);
      row.title = `${commit.author} · ${commit.committed_at}`;
      row.onclick = () => void this.openInspector("history", this.activePath, commit.commit_id);
      results.appendChild(row);
    }
    this.setStatus(`${files.length} modified file${files.length === 1 ? "" : "s"} · branch ${state.branch}`);
  }

  renderGitGroupHeader(container, label, icon) {
    const header = document.createElement("div");
    header.className = "git-group-header";
    header.innerHTML = `<span class="codicon codicon-${icon}"></span><span>${label}</span>`;
    container.appendChild(header);
  }

  renderGitFile(container, file) {
    const row = document.createElement("div");
    row.className = "tree-row file";
    row.title = file.path;
    row.append(this.fileIcon(file.path.split("/").pop(), "tree-type-icon"));
    const name = this.makeName(file.path);
    row.appendChild(name);
    this.appendGitStatus(row, file.status);
    row.onclick = () => void this.openFile(file.path);
    row.onauxclick = (event) => this.handleAuxClick(event, file.path);
    row.oncontextmenu = (event) => this.openContextMenu(event, file.path, false);
    container.appendChild(row);
  }

  gitDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  async openInspector(mode, path = this.inspectorPath, commit = this.inspectorCommit) {
    this.inspectorMode = mode;
    this.inspectorPath = path || "";
    this.inspectorCommit = commit || "";
    this.$("git-inspector").classList.remove("hidden");
    document.querySelectorAll("#git-inspector-tabs button").forEach((button) => button.classList.toggle("on", button.dataset.inspectorMode === mode));
    const title = mode === "blame" ? "Git blame" : mode === "diff" ? "Git diff" : "Git history";
    this.$("git-inspector-title").textContent = `${title}${path ? ` · ${path}` : ""}`;
    const content = this.$("git-inspector-content");
    content.textContent = "Loading…";
    if (mode === "history") await this.renderHistory(content, path);
    else if (mode === "blame") await this.renderBlame(content, path);
    else await this.renderDiff(content, path, commit);
  }

  closeInspector() {
    this.$("git-inspector").classList.add("hidden");
    this.inspectorPath = "";
    this.inspectorCommit = "";
  }

  async renderHistory(container, path) {
    const query = new URLSearchParams({ root: this.project.root, path });
    const response = path ? await fetch(`/api/files/git-history?${query}`)
      : await fetch(`/api/files/git-branch?${new URLSearchParams({ root: this.project.root, limit: "100" })}`);
    if (!response.ok) { container.textContent = "Git history unavailable"; return; }
    const payload = await response.json();
    const history = path ? payload : payload.commits || [];
    container.textContent = "";
    if (!history.length) { container.textContent = "No Git history found."; return; }
    for (const item of history) {
      const row = document.createElement("div");
      row.className = "git-history-item";
      if (item.commit_id === this.inspectorCommit) row.classList.add("selected");
      const top = document.createElement("div");
      top.className = "git-history-top";
      const id = document.createElement("span");
      id.className = "git-history-id";
      id.textContent = item.short_id;
      const message = document.createElement("span");
      message.className = "git-history-message";
      message.textContent = item.message;
      const meta = document.createElement("div");
      meta.className = "git-history-meta";
      meta.textContent = `${item.author} · ${this.gitDate(item.committed_at)}`;
      top.append(id, message);
      row.append(top, meta);
      row.title = item.committed_at;
      row.onclick = () => void this.openInspector("diff", path, item.commit_id);
      container.appendChild(row);
    }
  }

  async renderBlame(container, path) {
    if (!path) { container.textContent = "Select a file first."; return; }
    const response = await fetch(`/api/files/git-blame?${new URLSearchParams({ root: this.project.root, path })}`);
    if (!response.ok) { container.textContent = "Git blame unavailable"; return; }
    const lines = await response.json();
    container.textContent = "";
    for (const line of lines) {
      const row = document.createElement("div");
      row.className = "git-blame-line";
      const commit = document.createElement("span");
      commit.className = "git-blame-commit";
      commit.textContent = String(line.commit_id).slice(0, 8);
      commit.title = String(line.summary || "");
      const author = document.createElement("span");
      author.className = "git-blame-author";
      author.textContent = String(line.author || "");
      author.title = String(line.summary || "");
      const text = document.createElement("span");
      text.className = "git-blame-text";
      text.textContent = `${line.line} ${line.text || ""}`;
      row.append(commit, author, text);
      container.appendChild(row);
    }
  }

  async renderDiff(container, path, commit = "") {
    if (!path) { container.textContent = "Select a file first."; return; }
    const response = await fetch(`/api/files/git-diff?${new URLSearchParams({ root: this.project.root, path, commit })}`);
    if (!response.ok) { container.textContent = "Git diff unavailable"; return; }
    const payload = await response.json();
    container.textContent = "";
    const pre = document.createElement("pre");
    pre.className = "git-diff";
    for (const line of String(payload.diff || "No differences.").split("\n")) {
      const element = document.createElement("div");
      element.className = `git-diff-line ${line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "remove" : ""}`;
      element.textContent = line;
      pre.appendChild(element);
    }
    container.appendChild(pre);
  }

  async saveFile() {
    if (!this.model || !this.activePath) return;
    const response = await fetch("/api/files/write", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root: this.project.root, path: this.activePath, content: this.model.getValue() }) });
    this.setStatus(response.ok ? "Saved" : "Save failed");
    if (response.ok && this.view === "git") void this.loadGitView();
  }

  setStatus(text) { this.$("editor-status").textContent = text; }
}

window.addEventListener("DOMContentLoaded", () => void new FileDeckApp().start().catch((error) => {
  document.getElementById("editor-status").textContent = error.message;
}));
