class RootFileHistoryBrowser {
  constructor(app, root) {
    this.app = app;
    this.root = root;
    this.offset = 0;
    this.files = [];
    this.selected = null;
    this.closed = false;
    this.controllers = new Map();
    this.dialog = document.createElement("dialog");
    this.dialog.className = "root-file-history-dialog";
    this.dialog.setAttribute("aria-label", "Root file history");
    this.dialog.innerHTML = `
      <header><strong>Root file history</strong><button type="button" data-close aria-label="Close root file history"><span class="codicon codicon-close"></span></button></header>
      <div class="root-history-root"></div>
      <p class="root-history-help">Saved local versions, including deleted or moved files. Only files previously opened or saved in TermDeck are recorded.</p>
      <div class="root-history-body">
        <div class="root-history-files">
          <div class="root-history-search"><input type="search" placeholder="Filter file paths…" aria-label="Filter history by file path" autocomplete="off" spellcheck="false"><button type="button" data-refresh title="Refresh history" aria-label="Refresh history"><span class="codicon codicon-refresh"></span></button></div>
          <div class="root-history-file-list" aria-label="Files with saved history"></div>
          <button type="button" data-more hidden>Load 50 more</button>
          <div class="root-history-status" role="status"></div>
        </div>
        <div class="root-history-detail">
          <div class="root-history-path">Select a file to view its saved versions.</div>
          <div class="root-history-version-controls"><select aria-label="Saved version" disabled></select><button type="button" data-full-history disabled>Open file history</button></div>
          <pre class="root-history-preview" tabindex="0" aria-label="Saved file content"></pre>
        </div>
      </div>`;
    this.element(".root-history-root").textContent = root;
    this.element("[data-close]").onclick = () => this.close();
    this.element("[data-refresh]").onclick = () => void this.loadFiles();
    this.element("[data-more]").onclick = () => void this.loadFiles(true);
    this.element("input").oninput = () => {
      this.controllers.get("files")?.abort();
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => void this.loadFiles(), 250);
    };
    this.element("select").onchange = () => void this.loadVersion();
    this.element("[data-full-history]").onclick = () => {
      const file = this.selected;
      const selection = [`local:${this.element("select").value}`];
      this.close();
      void this.app.openFileHistoryForPath(file.root, file.path, "local", { selection });
    };
    this.dialog.addEventListener("close", () => this.dispose(), { once: true });
    this.dialog.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        this.close();
      }
    });
    this.dialog.onclick = (event) => {
      if (event.target !== this.dialog) return;
      const bounds = this.dialog.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) this.close();
    };
    document.body.append(this.dialog);
    this.dialog.showModal();
    this.element("input").focus();
    void this.loadFiles();
  }

  element(selector) {
    return this.dialog.querySelector(selector);
  }

  requestController(kind) {
    this.controllers.get(kind)?.abort();
    const controller = new AbortController();
    this.controllers.set(kind, controller);
    return controller;
  }

  async readJson(url, controller) {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Unable to load history (${response.status})`);
    return response.json();
  }

  async loadFiles(append = false) {
    clearTimeout(this.searchTimer);
    const controller = this.requestController("files");
    const status = this.element(".root-history-status");
    const more = this.element("[data-more]");
    more.disabled = true;
    if (!append) {
      this.files = [];
      this.offset = 0;
      more.hidden = true;
      this.element(".root-history-file-list").replaceChildren();
    }
    status.textContent = "Loading history…";
    try {
      const query = new URLSearchParams({ root: this.root, q: this.element("input").value, offset: String(this.offset) });
      const payload = await this.readJson(`/api/files/history/files?${query}`, controller);
      if (this.closed || controller.signal.aborted) return;
      this.files.push(...payload.files);
      this.offset = payload.next_offset;
      more.hidden = !payload.has_more;
      more.disabled = false;
      status.textContent = this.files.length ? `${this.files.length} ${this.files.length === 1 ? "file" : "files"} shown` : "No retained history matches this path.";
      this.renderFiles();
    } catch (error) {
      if (this.closed || controller.signal.aborted) return;
      status.textContent = error.message;
      more.disabled = false;
    }
  }

  renderFiles() {
    const list = this.element(".root-history-file-list");
    list.replaceChildren();
    for (const file of this.files) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "root-history-file";
      row.classList.toggle("selected", this.selected?.root === file.root && this.selected?.path === file.path);
      row.title = `${file.root}/${file.path}`;
      const path = document.createElement("span");
      path.textContent = file.relative_path;
      const detail = document.createElement("small");
      detail.textContent = `${file.version_count} versions · ${this.app.fileHistoryTimestampLabel(file.captured_at_est)}`;
      row.append(path, detail);
      if (file.missing) {
        const missing = document.createElement("span");
        missing.className = "root-history-missing";
        missing.textContent = "Deleted / moved";
        row.append(missing);
      }
      row.onclick = () => void this.selectFile(file);
      list.append(row);
    }
  }

  async selectFile(file) {
    this.selected = file;
    this.renderFiles();
    this.controllers.get("content")?.abort();
    const controller = this.requestController("versions");
    const select = this.element("select");
    select.disabled = true;
    select.replaceChildren();
    this.element("[data-full-history]").disabled = true;
    this.element(".root-history-path").textContent = `${file.relative_path}${file.missing ? " · deleted or moved" : ""}`;
    this.element(".root-history-preview").textContent = "Loading versions…";
    try {
      const query = new URLSearchParams({ root: file.root, path: file.path });
      const versions = await this.readJson(`/api/files/history?${query}`, controller);
      if (this.closed || controller.signal.aborted) return;
      for (const version of versions) {
        const option = document.createElement("option");
        option.value = String(version.version_id);
        option.textContent = `${this.app.fileHistoryTimestampLabel(version.captured_at_est)} · ${this.app.fileHistorySourceLabel(version.source)}`;
        select.append(option);
      }
      select.disabled = !versions.length;
      this.element("[data-full-history]").disabled = file.missing || !versions.length;
      if (versions.length) await this.loadVersion();
      else this.element(".root-history-preview").textContent = "These versions are no longer retained.";
    } catch (error) {
      if (!this.closed && !controller.signal.aborted) this.element(".root-history-preview").textContent = error.message;
    }
  }

  async loadVersion() {
    const controller = this.requestController("content");
    const preview = this.element(".root-history-preview");
    preview.textContent = "Loading saved content…";
    try {
      const version = await this.readJson(`/api/files/history/${encodeURIComponent(this.element("select").value)}?root=${encodeURIComponent(this.selected.root)}`, controller);
      if (this.closed || controller.signal.aborted) return;
      preview.textContent = version.content;
      preview.scrollTop = 0;
    } catch (error) {
      if (!this.closed && !controller.signal.aborted) preview.textContent = error.message;
    }
  }

  close() {
    this.dialog.close();
    this.dispose();
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.searchTimer);
    for (const controller of this.controllers.values()) controller.abort();
    this.dialog.remove();
    if (this.app.rootFileHistoryBrowser === this) this.app.rootFileHistoryBrowser = null;
    this.app.$("root-file-history-toggle")?.focus();
  }
}

Object.assign(TermdeckApp.prototype, {
  openRootFileHistory() {
    if (this.rootFileHistoryBrowser) {
      this.rootFileHistoryBrowser.close();
      return;
    }
    this.rootFileHistoryBrowser = new RootFileHistoryBrowser(this, this.treeRoot || this.searchRoot());
  },
});
