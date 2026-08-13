class FileDeckApp {
  constructor() {
    this.projectName = decodeURIComponent(location.pathname.split("/")[2] || "");
    this.project = null;
    this.projects = [];
    this.searchMode = "content";
    this.editor = null;
    this.model = null;
    this.activePath = "";
    this.activeRow = null;
    this.treeGeneration = 0;
    this.$ = (id) => document.getElementById(id);
  }

  async start() {
    this.bindEvents();
    await this.loadProjects();
    await this.loadTree();
    await this.initEditor();
    const path = new URLSearchParams(location.search).get("file") || "";
    if (path) await this.openFile(path);
  }

  bindEvents() {
    this.$("project-select").onchange = () => { location.href = `/f/${encodeURIComponent(this.$("project-select").value)}`; };
    this.$("tree-refresh").onclick = () => void this.loadTree();
    this.$("git-toggle").onclick = () => void this.showGitChanges();
    this.$("search-button").onclick = () => void this.runSearch();
    this.$("search-input").onkeydown = (event) => {
      if (event.key === "Enter") { event.preventDefault(); void this.runSearch(); }
      if (event.key === "Escape") { event.preventDefault(); this.clearSearch(); }
    };
    this.$("replace-button").onclick = () => void this.replaceAll();
    this.$("save-button").onclick = () => void this.saveFile();
    this.$("find-button").onclick = () => this.editor?.getAction("editor.action.startFindReplaceAction")?.run();
    this.$("new-tab-button").onclick = () => this.openNewTab(this.activePath);
    document.querySelectorAll("[data-search-mode]").forEach((button) => {
      button.onclick = () => {
        this.searchMode = button.dataset.searchMode;
        document.querySelectorAll("[data-search-mode]").forEach((candidate) => candidate.classList.toggle("active", candidate === button));
        this.$("replace-row").classList.toggle("hidden", this.searchMode !== "content");
        if (this.$("search-input").value.trim()) void this.runSearch();
      };
    });
    document.addEventListener("mousedown", (event) => {
      const menu = this.$("filedeck-context-menu");
      if (!menu.classList.contains("hidden") && !menu.contains(event.target)) menu.classList.add("hidden");
    });
    window.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void this.saveFile();
      }
    });
  }

  async loadProjects() {
    const response = await fetch("/api/projects");
    if (!response.ok) throw new Error("project list unavailable");
    this.projects = await response.json();
    this.project = this.projects.find((candidate) => candidate.name === this.projectName);
    if (!this.project) throw new Error(`project not found: ${this.projectName}`);
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
    this.$("sidebar-status").textContent = this.project.root;
  }

  async initEditor() {
    await new Promise((resolve) => {
      require.config({ paths: { vs: "/static/vendor/monaco/vs" } });
      require(["vs/editor/editor.main"], () => {
        monaco.editor.defineTheme("filedeck-dark", { base: "vs-dark", inherit: true, rules: [], colors: {
          "editor.background": "#0f141b", "editorLineNumber.foreground": "#526174", "editorLineNumber.activeForeground": "#a9c7e8",
        }});
        this.editor = monaco.editor.create(this.$("monaco-host"), { theme: "filedeck-dark", automaticLayout: true,
          minimap: { enabled: false }, fontSize: 14, lineNumbersMinChars: 4, scrollBeyondLastLine: false,
          wordWrap: "off", fixedOverflowWidgets: true, padding: { top: 10, bottom: 10 } });
        this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void this.saveFile());
        resolve();
      });
    });
  }

  async loadTree() {
    const generation = ++this.treeGeneration;
    const tree = this.$("project-tree");
    tree.textContent = "";
    await this.renderDirectory(tree, "", generation);
    this.$("project-tree").classList.remove("hidden");
    this.$("git-results").classList.add("hidden");
  }

  async renderDirectory(container, relativePath, generation) {
    const response = await fetch(`/api/files/list?${new URLSearchParams({ root: this.project.root, path: relativePath })}`);
    if (!response.ok || generation !== this.treeGeneration) return;
    const entries = await response.json();
    for (const entry of entries) {
      const path = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      const row = document.createElement("div");
      row.className = `tree-row ${entry.is_dir ? "dir" : "file"}`;
      row.dataset.path = path;
      row.title = `${this.project.root}/${path}`;
      row.append(this.makeIndent(relativePath), this.makeIcon(entry), this.makeName(entry.name));
      if (entry.git_status) row.appendChild(this.gitStatus(entry.git_status));
      row.onclick = () => entry.is_dir ? this.toggleDirectory(row, path) : void this.openFile(path, row);
      row.ondblclick = () => { if (!entry.is_dir) void this.openFile(path, row); };
      row.onauxclick = (event) => { if (event.button === 1) { event.preventDefault(); this.openNewTab(path); } };
      row.oncontextmenu = (event) => this.openContextMenu(event, path, entry.is_dir);
      container.appendChild(row);
    }
  }

  makeIndent(relativePath) {
    const indent = document.createElement("span");
    indent.className = "tree-indent";
    indent.style.width = `${14 * relativePath.split("/").filter(Boolean).length}px`;
    indent.style.flexBasis = indent.style.width;
    return indent;
  }

  makeIcon(entry) {
    const icon = document.createElement("span");
    icon.className = `codicon codicon-${entry.is_dir ? "chevron-right" : "file"}`;
    return icon;
  }

  makeName(name) {
    const element = document.createElement("span");
    element.className = "tree-name";
    element.textContent = name;
    return element;
  }

  gitStatus(status) {
    const element = document.createElement("span");
    element.className = "git-status";
    element.textContent = status;
    return element;
  }

  async toggleDirectory(row, path) {
    const existing = row.nextElementSibling;
    if (existing?.classList.contains("tree-children")) {
      existing.remove();
      row.querySelector(".codicon")?.classList.replace("codicon-chevron-down", "codicon-chevron-right");
      return;
    }
    const children = document.createElement("div");
    children.className = "tree-children";
    row.after(children);
    row.querySelector(".codicon")?.classList.replace("codicon-chevron-right", "codicon-chevron-down");
    await this.renderDirectory(children, path, this.treeGeneration);
  }

  async openFile(path, row = null) {
    const response = await fetch(`/api/files/read?${new URLSearchParams({ root: this.project.root, path })}`);
    if (!response.ok) { this.setStatus("Unable to read file"); return; }
    const data = await response.json();
    this.activePath = path;
    this.activeRow?.classList.remove("selected");
    this.activeRow = row || this.$("project-tree").querySelector(`[data-path="${CSS.escape(path)}"]`);
    this.activeRow?.classList.add("selected");
    if (this.model) this.model.dispose();
    this.model = monaco.editor.createModel(data.content, undefined, monaco.Uri.parse(`filedeck://${encodeURIComponent(this.project.name)}/${encodeURIComponent(path)}`));
    this.editor.setModel(this.model);
    this.$("file-title").textContent = path;
    this.$("file-title").title = `${this.project.root}/${path}`;
    this.setStatus(data.truncated ? "File truncated to the configured read limit" : "Ready");
    this.editor.focus();
    history.replaceState(null, "", `/f/${encodeURIComponent(this.project.name)}?file=${encodeURIComponent(path)}`);
  }

  openNewTab(path) {
    const suffix = path ? `?file=${encodeURIComponent(path)}` : "";
    window.open(`/f/${encodeURIComponent(this.project.name)}${suffix}`, "_blank", "noopener,noreferrer");
  }

  openContextMenu(event, path, isDirectory) {
    event.preventDefault();
    event.stopPropagation();
    const menu = this.$("filedeck-context-menu");
    menu.textContent = "";
    if (!isDirectory) {
      this.addMenuItem(menu, "Open", () => void this.openFile(path));
      this.addMenuItem(menu, "Open in new browser tab", () => this.openNewTab(path));
      this.addMenuItem(menu, "Copy relative path", () => void navigator.clipboard.writeText(path));
    }
    this.addMenuItem(menu, "Search in project", () => { this.$("search-input").value = path.split("/").pop(); void this.runSearch(); });
    menu.classList.remove("hidden");
    menu.style.left = `${Math.min(event.clientX, window.innerWidth - menu.offsetWidth - 8)}px`;
    menu.style.top = `${Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 8)}px`;
  }

  addMenuItem(menu, label, handler) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.onclick = () => { menu.classList.add("hidden"); handler(); };
    menu.appendChild(button);
  }

  async runSearch() {
    const query = this.$("search-input").value.trim();
    if (!query) { this.clearSearch(); return; }
    this.$("project-tree").classList.add("hidden");
    this.$("git-results").classList.add("hidden");
    const results = this.$("search-results");
    results.classList.remove("hidden");
    results.textContent = "Searching…";
    const route = this.searchMode === "name" ? "/api/files/find" : "/api/files/search";
    const response = await fetch(`${route}?${new URLSearchParams({ root: this.project.root, q: query, ignore: ".git,.venv,.venv*" })}`);
    if (!response.ok) { results.textContent = "Search failed"; return; }
    const hits = await response.json();
    results.textContent = "";
    if (!hits.length) { results.textContent = "No matches"; return; }
    const byPath = new Map();
    for (const hit of hits) {
      if (!byPath.has(hit.path)) byPath.set(hit.path, []);
      if (this.searchMode === "content") byPath.get(hit.path).push(hit);
    }
    for (const [path, pathHits] of byPath) {
      const row = document.createElement("div");
      row.className = "result-row";
      row.title = path;
      const icon = document.createElement("span");
      icon.className = "codicon codicon-file";
      const name = document.createElement("span");
      name.className = "result-name result-path";
      name.textContent = path;
      row.append(icon, name);
      if (this.searchMode === "content") for (const hit of pathHits.slice(0, 4)) {
        const line = document.createElement("span");
        line.className = "result-hit";
        line.textContent = `${hit.line}: ${hit.text}`;
        row.appendChild(line);
      }
      row.onclick = () => void this.openFile(path);
      row.onauxclick = (event) => { if (event.button === 1) { event.preventDefault(); this.openNewTab(path); } };
      row.oncontextmenu = (event) => this.openContextMenu(event, path, false);
      results.appendChild(row);
    }
    this.$("sidebar-status").textContent = `${hits.length} result${hits.length === 1 ? "" : "s"}`;
  }

  clearSearch() {
    this.$("search-input").value = "";
    this.$("search-results").textContent = "";
    this.$("search-results").classList.add("hidden");
    this.$("project-tree").classList.remove("hidden");
    this.$("git-results").classList.add("hidden");
    this.$("sidebar-status").textContent = this.project?.root || "";
  }

  async replaceAll() {
    const query = this.$("search-input").value.trim();
    if (!query || this.searchMode !== "content") return;
    const replacement = this.$("replace-input").value;
    if (!confirm(`Replace all project matches for “${query}”?`)) return;
    const response = await fetch("/api/files/replace", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root: this.project.root, q: query, replacement, ignore: ".git,.venv,.venv*" }) });
    if (!response.ok) { this.setStatus("Replace failed"); return; }
    const result = await response.json();
    this.setStatus(`Replaced ${result.replacements} match${result.replacements === 1 ? "" : "es"} in ${result.files} file${result.files === 1 ? "" : "s"}`);
    await this.loadTree();
    if (this.activePath) await this.openFile(this.activePath);
  }

  async showGitChanges() {
    this.$("project-tree").classList.add("hidden");
    this.$("search-results").classList.add("hidden");
    const results = this.$("git-results");
    results.classList.remove("hidden");
    results.textContent = "Loading Git changes…";
    const response = await fetch(`/api/files/git-status?root=${encodeURIComponent(this.project.root)}`);
    if (!response.ok) { results.textContent = "Git status unavailable"; return; }
    const statuses = await response.json();
    results.textContent = "";
    for (const [path, status] of Object.entries(statuses)) {
      const row = document.createElement("div");
      row.className = "result-row";
      row.title = path;
      const icon = document.createElement("span");
      icon.className = "codicon codicon-diff-modified";
      const name = document.createElement("span");
      name.className = "result-name result-path";
      name.textContent = path;
      row.append(icon, name, this.gitStatus(status));
      row.onclick = () => void this.openFile(path);
      row.onauxclick = (event) => { if (event.button === 1) { event.preventDefault(); this.openNewTab(path); } };
      row.oncontextmenu = (event) => this.openContextMenu(event, path, false);
      results.appendChild(row);
    }
    this.$("sidebar-status").textContent = `${Object.keys(statuses).length} changed file${Object.keys(statuses).length === 1 ? "" : "s"}`;
  }

  async saveFile() {
    if (!this.model || !this.activePath) return;
    const response = await fetch("/api/files/write", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root: this.project.root, path: this.activePath, content: this.model.getValue() }) });
    this.setStatus(response.ok ? "Saved" : "Save failed");
  }

  setStatus(text) { this.$("editor-status").textContent = text; }
}

window.addEventListener("DOMContentLoaded", () => void new FileDeckApp().start().catch((error) => {
  document.getElementById("editor-status").textContent = error.message;
}));
