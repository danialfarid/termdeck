// Split from app.js (2026-08-26): closed sessions, file history, markdown/transcript view, editors, notebook.
// Same class, split across files: this attaches methods to TermdeckApp.prototype, and
// index.html loads the app_*.js files after app.js and before app_boot.js.
Object.assign(TermdeckApp.prototype, {


  async purgeClosed(sessionId) {
    await fetch(`/api/closed/${sessionId}`, { method: "DELETE" });
    this.refresh();
  },


  restorePageFavicon() {
    if (!this.pageFavicon) return;
    this.pageFavicon.type = this.pageFaviconType;
    this.pageFavicon.href = this.pageFaviconHref;
  },


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
  },


  updateDocumentTitle(pageTitle, faviconState) {
    document.title = pageTitle;
    if (this.pageTitleFaviconState === faviconState) return;
    this.pageTitleFaviconState = faviconState;
    this.showPageTitleFaviconState(faviconState);
  },


  activePageTabTitle(entry, session) {
    if (entry) return entry.name;
    if (this.sideView === "git") {
      if (this.gitReviewOpen && this.gitFocusedFile?.scope === "pull-request") {
        return this.$("git-review-title")?.textContent || "Pull requests";
      }
      if (this.gitReviewOpen && this.gitFocusedFile?.path) {
        return this.gitFocusedFile.path.split("/").pop();
      }
      return this.gitPanelView === "pull-requests" ? "Pull requests" : "Changes";
    }
    if (this.sideView === "project") return "Files";
    if (this.sideView === "search") return "Search";
    return session ? this.titlePresentation(session).text : null;
  },


  renderTopbar() {
    const s = this.session(this.activeId);
    const entry = this.activeFileKey !== null ? this.openFiles.get(this.activeFileKey) : null;
    const tabTitle = this.activePageTabTitle(entry, s);
    const pageTitle = this.vscodeMode ? "TermDeck" : (tabTitle ? `${tabTitle} — TermDeck` : "TermDeck");
    const terminalPage = !entry && this.sideView === "terminals";
    const processing = terminalPage && !!s && this.titlePresentation(s).spinning;
    const unread = terminalPage && !!s && !processing && this.unreadSessions.has(s.session_id);
    this.updateDocumentTitle(pageTitle, processing ? "processing" : unread ? "unread" : "plain");
    const statusEl = this.$("status-name");
    if (entry) {
      statusEl.textContent = this.vscodeMode ? entry.name : "";
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
      const reviewHistoryTarget = this.gitReviewOpen && !["pull-request"].includes(this.gitFocusedFile?.scope)
        ? this.gitFocusedFile : null;
      const historyTarget = entry || reviewHistoryTarget;
      const historyActive = !!entry && this.fileHistoryOpen && this.fileHistoryTabKey === this.activeFileKey;
      fileHistoryToggle.classList.toggle("hidden", !historyTarget || this.vscodeMode);
      fileHistoryToggle.classList.toggle("on", historyActive);
      const historyName = entry?.name || this.gitFocusedFile?.path?.split("/").pop();
      fileHistoryToggle.title = historyTarget
        ? `File history for ${historyName} · right-click to filter Local or Git history` : "File history";
      fileHistoryToggle.setAttribute("aria-pressed", String(historyActive));
    }
    this.updateFileHistoryFilterButtons();
    const navigationState = this.parseNavState(this.lastNavJson);
    if (!entry && s && navigationState?.kind === "term" && navigationState.id === s.session_id) {
      // Through replaceNav, not history directly: this runs on every chrome render, so calling history
      // itself rewrote the identical URL about once a second and skipped the identical-state guard that
      // exists to prevent exactly that. History writes are rate limited in WebKit, so no-ops are not free.
      this.replaceNav(navigationState);
    }
    this.renderHistoryMeta();
    this.renderFileEditorChrome();
  },


  fileHistorySourceLabel(source) {
    return { opened: "Opened", external: "External change", manual: "Edited", restore: "Restored" }[source] || source;
  },


  fileHistoryTimestampLabel(value) {
    const text = String(value || "").replace("T", " ");
    return text.length >= 16 ? text.slice(0, 16) : text;
  },


  fileHistoryItemKey(item) {
    if (item.kind === "current") return "current";
    return `${item.kind}:${item.kind === "git" ? item.commit_id : item.version_id}`;
  },


  fileHistoryItemLabel(item) {
    if (item.kind === "current") return "Current file";
    if (item.kind === "git") return `${item.short_id} ${item.message}`;
    return this.fileHistorySourceLabel(item.source);
  },


  fileHistoryItemTimestampLabel(item) {
    if (item.kind === "current") return "Working copy";
    return this.fileHistoryTimestampLabel(item.kind === "git" ? item.committed_at : item.captured_at_est);
  },


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
    this.fileHistoryDiffPending = false;
  },


  updateFileHistoryDiffToolbar() {
    const toolbar = this.$("file-history-diff-toolbar");
    const comparison = this.fileHistoryActiveComparison;
    const hasChanges = this.fileHistoryDiffBlocks.length > 0;
    toolbar.classList.toggle("hidden", !comparison?.isDiff);
    const previous = this.$("file-history-diff-previous");
    const next = this.$("file-history-diff-next");
    previous.disabled = !hasChanges;
    next.disabled = !hasChanges;
    this.$("file-history-diff-position").textContent = this.fileHistoryDiffPending ? "…" : hasChanges
      ? `${this.fileHistoryDiffBlockIndex + 1}/${this.fileHistoryDiffBlocks.length}` : "0/0";
  },


  refreshFileHistoryDiffNavigation() {
    if (!this.fileHistoryActiveComparison?.isDiff) return;
    this.syncFileHistoryDiffBlocksFromEditor();
  },


  markFileHistoryDiffPending() {
    if (!this.fileHistoryActiveComparison?.isDiff) return;
    this.fileHistoryDiffPending = true;
    this.fileHistoryDiffBlocks = [];
    this.fileHistoryDiffBlockIndex = -1;
    this.updateFileHistoryDiffToolbar();
  },


  fileHistoryNavigationState() {
    const view = FILES_SIDE_PANEL_TABS.includes(this.sideView) ? this.sideView : this.lastFilesSidePanelTab;
    return { kind: "file-history", key: this.fileHistoryTabKey || this.activeFileKey, mode: this.fileHistoryMode,
      selection: [...this.fileHistorySelections], view: FILES_SIDE_PANEL_TABS.includes(view) ? view : "project" };
  },


  syncFileHistorySurface() {
    const active = !!this.fileHistoryOpen && this.fileHistoryTabKey !== null && this.activeFileKey === this.fileHistoryTabKey;
    const sidebarVisible = active && this.fileHistorySidebarVisible && FILES_SIDE_PANEL_TABS.includes(this.sideView);
    this.$("file-history-diff-pane").classList.toggle("hidden", !active);
    this.$("file-history-sidebar").classList.toggle("hidden", !sidebarVisible);
    this.$("files-section").classList.toggle("with-file-history", sidebarVisible);
    this.$("file-history-toggle")?.classList.toggle("on", active);
    this.$("file-history-toggle")?.setAttribute("aria-pressed", String(active));
  },


  hideFileHistorySidebar() {
    if (!this.fileHistoryOpen) return;
    this.fileHistorySidebarVisible = false;
    this.setSideView(CLOSED_SIDE_VIEW, false);
    this.syncFileHistorySurface();
    requestAnimationFrame(() => {
      if (this.fileHistoryDiffEditor) this.fileHistoryDiffEditor.layout();
      else this.fileHistoryCurrentEditor?.layout();
    });
  },


  deactivateFileHistoryTab() {
    if (!this.fileHistoryOpen) return;
    this.fileHistoryOpen = false;
    this.fileHistorySidebarVisible = false;
    this.syncFileHistorySurface();
    this.applyMainLayout();
    this.renderFileEditorChrome();
  },


  async activateFileHistoryTab(options = {}) {
    const key = this.fileHistoryTabKey;
    if (!key || !this.openFiles.has(key)) {
      this.closeFileHistory(false);
      return;
    }
    const view = FILES_SIDE_PANEL_TABS.includes(options.view) ? options.view : this.lastFilesSidePanelTab;
    if (this.activeFileKey !== key) {
      await this.activateFile(key, null, { history: false, preserveFileHistory: true, view });
    }
    this.fileHistoryOpen = true;
    this.fileHistorySidebarVisible = true;
    if (!FILES_SIDE_PANEL_TABS.includes(this.sideView)) {
      this.setSideView(FILES_SIDE_PANEL_TABS.includes(view) ? view : "project", false);
    }
    this.applyMainLayout();
    this.renderFileEditorChrome();
    if (options.reload || this.fileHistoryLoadedKey !== key || !this.fileHistoryItems.length) await this.loadFileHistory();
    else requestAnimationFrame(() => this.fileHistoryDiffEditor?.layout());
    if (options.history !== false) this.pushNav(this.fileHistoryNavigationState());
  },


  toggleFileHistory() {
    if (this.fileHistoryOpen) {
      this.closeFileHistory();
      return;
    }
    if (this.vscodeMode) return;
    if (this.activeFileKey === null) {
      if (this.gitReviewOpen && this.gitFocusedFile) {
        const selection = this.gitFocusedFile.revision ? ["current", `git:${this.gitFocusedFile.revision}`] : [];
        void this.openFileHistoryForPath(this.gitFocusedFile.root, this.gitFocusedFile.path, "all", { selection });
      }
      return;
    }
    if (this.fileHistoryTabKey === this.activeFileKey) {
      void this.activateFileHistoryTab();
      return;
    }
    if (this.fileHistoryTabKey !== null) this.closeFileHistory(false);
    this.fileHistoryMode = "all";
    this.fileHistoryTabKey = this.activeFileKey;
    this.fileHistoryLoadedKey = null;
    this.fileHistoryOpen = true;
    this.fileHistorySidebarVisible = true;
    this.fileHistorySelections = [];
    if (!FILES_SIDE_PANEL_TABS.includes(this.sideView)) this.setSideView(this.lastFilesSidePanelTab || "project", false);
    this.applyMainLayout();
    this.renderFileEditorChrome();
    void this.loadFileHistory();
    this.pushNav(this.fileHistoryNavigationState());
  },


  openActiveFileHistoryMenu(event) {
    event.preventDefault();
    event.stopPropagation();
    const entry = this.activeFileKey !== null ? this.openFiles.get(this.activeFileKey) : null;
    const target = entry || (this.gitReviewOpen ? this.gitFocusedFile : null);
    if (!target) return;
    const menu = this.$("context-menu");
    menu.textContent = "";
    this.contextMenuTarget = { type: "file-history", key: this.activeFileKey };
    this.addContextItem(menu, "All history", () => this.openFileHistoryForPath(target.root, target.path, "all"), "history");
    this.addContextItem(menu, "Local history", () => this.openFileHistoryForPath(target.root, target.path, "local"), "history");
    this.addContextItem(menu, "Git history", () => this.openFileHistoryForPath(target.root, target.path, "git"), "git-commit");
    this.positionContextMenu(menu, event.clientX, event.clientY);
  },


  closeFileHistory(updateNavigation = true) {
    const historyKey = this.fileHistoryTabKey;
    const navigationKey = this.activeFileKey !== null && this.openFiles.has(this.activeFileKey)
      ? this.activeFileKey : historyKey;
    this.fileHistoryOpen = false;
    this.fileHistoryTabKey = null;
    this.fileHistoryLoadedKey = null;
    this.fileHistorySidebarVisible = false;
    clearTimeout(this.fileHistoryComparisonTimer);
    this.fileHistoryComparisonTimer = 0;
    this.disposeFileHistoryEditors();
    this.updateFileHistoryDiffToolbar();
    this.fileHistorySelections = [];
    this.fileHistoryVersions = [];
    this.fileHistoryItems = [];
    this.fileHistoryLoadGeneration += 1;
    this.syncFileHistorySurface();
    this.applyMainLayout();
    this.renderFileEditorChrome();
    if (updateNavigation && navigationKey !== null && this.openFiles.has(navigationKey)) {
      this.pushNav({ kind: "file", key: navigationKey, view: this.sideView });
    }
  },


  setFileHistoryMode(mode, updateNavigation = true) {
    if (!this.fileHistoryOpen || !["all", "local", "git"].includes(mode) || this.fileHistoryMode === mode) return;
    this.fileHistoryMode = mode;
    this.fileHistorySelections = [];
    this.updateFileHistoryFilterButtons();
    void this.loadFileHistory();
    if (updateNavigation && this.activeFileKey !== null) {
      this.replaceNav(this.fileHistoryNavigationState());
    }
  },


  updateFileHistoryFilterButtons() {
    const filters = this.$("file-history-filters");
    if (!filters) return;
    for (const button of filters.querySelectorAll("button[data-mode]")) {
      const selected = button.dataset.mode === this.fileHistoryMode;
      button.classList.toggle("on", selected);
      button.setAttribute("aria-pressed", String(selected));
    }
  },


  fileHistoryItemTime(item) {
    if (item.kind === "git") return Date.parse(item.committed_at) || 0;
    const localTime = String(item.captured_at_est || "").replace(" ", "T");
    return Date.parse(localTime) || 0;
  },


  resolveFileHistorySelectionKey(key) {
    if (key === "current") return key;
    const exact = this.fileHistoryItems.find((item) => this.fileHistoryItemKey(item) === key);
    if (exact) return key;
    if (!String(key).startsWith("git:")) return "";
    const commitId = String(key).slice(4);
    const matched = this.fileHistoryItems.find((item) => item.kind === "git" && this.gitCommitIdsMatch(item.commit_id, commitId));
    return matched ? this.fileHistoryItemKey(matched) : "";
  },


  async loadFileHistory(compareWithPreviousVersion = false) {
    const key = this.fileHistoryTabKey;
    const entry = key !== null ? this.openFiles.get(key) : null;
    if (!entry || this.activeFileKey !== key || !this.fileHistoryOpen || this.vscodeMode) {
      this.closeFileHistory(false);
      return;
    }
    this.fileHistoryLoadedKey = key;
    const generation = ++this.fileHistoryLoadGeneration;
    this.updateFileHistoryFilterButtons();
    const path = `${entry.root}/${entry.path}`;
    this.$("file-history-path").textContent = path;
    this.$("file-history-path").title = path;
    this.$("file-history-list").textContent = "loading history…";
    this.$("file-history-preview-empty").textContent = "Select one version to compare with the current file, or select two timeline entries to compare them.";
    this.$("file-history-preview-empty").classList.remove("hidden");
    this.$("file-history-preview").classList.add("hidden");
    const query = `root=${encodeURIComponent(entry.root)}&path=${encodeURIComponent(entry.path)}`;
    const [localResponse, gitResponse] = await Promise.all([
      fetch(`/api/files/history?${query}`),
      fetch(`/api/files/git-history?${query}`),
    ]);
    if (generation !== this.fileHistoryLoadGeneration || !this.fileHistoryOpen ||
        this.fileHistoryTabKey !== key || this.activeFileKey !== key) return;
    if (!localResponse.ok && !gitResponse.ok) {
      this.$("file-history-list").textContent = "history unavailable";
      return;
    }
    const localVersions = localResponse.ok ? await localResponse.json() : [];
    const gitCommits = gitResponse.ok ? await gitResponse.json() : [];
    if (generation !== this.fileHistoryLoadGeneration || !this.fileHistoryOpen ||
        this.fileHistoryTabKey !== key || this.activeFileKey !== key) return;
    this.fileHistoryVersions = localVersions;
    const localItems = localVersions.map((version) => ({ kind: "local", ...version }));
    const gitItems = gitCommits.map((commit) => ({ kind: "git", ...commit }));
    const historicalItems = [
      ...(this.fileHistoryMode === "git" ? [] : localItems),
      ...(this.fileHistoryMode === "local" ? [] : gitItems),
    ].sort((left, right) => this.fileHistoryItemTime(right) - this.fileHistoryItemTime(left));
    this.fileHistoryItems = [{ kind: "current" }, ...historicalItems];
    if (generation !== this.fileHistoryLoadGeneration || !this.fileHistoryOpen ||
        this.fileHistoryTabKey !== key || this.activeFileKey !== key) return;
    this.fileHistorySelections = this.fileHistorySelections.map((key) => this.resolveFileHistorySelectionKey(key)).filter(Boolean).slice(-2);
    if (compareWithPreviousVersion && historicalItems.length) {
      this.fileHistorySelections = ["current", this.fileHistoryItemKey(historicalItems[0])];
    } else if (!this.fileHistorySelections.length && this.fileHistoryItems.length) {
      this.fileHistorySelections = [this.fileHistoryItemKey(this.fileHistoryItems[0])];
    }
    this.renderFileHistoryRows();
    await this.renderFileHistoryComparison(generation);
  },


  renderFileHistoryRows() {
    const list = this.$("file-history-list");
    list.textContent = "";
    if (!this.fileHistoryItems.length) {
      list.textContent = "No matching history found for this file.";
      return;
    }
    for (const item of this.fileHistoryItems) {
      const itemKey = this.fileHistoryItemKey(item);
      const row = document.createElement("div");
      row.className = `file-history-version kind-${item.kind}` + (item.kind === "current" ? " current" : "") +
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
      row.oncontextmenu = (event) => this.openFileHistoryItemContextMenu(event, item);
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
  },


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
      this.fileHistorySelections = key === "current" ? [key] : ["current", key];
    }
    this.applyFileHistorySelections();
  },


  applyFileHistorySelections(selections = this.fileHistorySelections) {
    this.fileHistorySelections = [...new Set(selections)].slice(-2);
    this.renderFileHistoryRows();
    this.renderFileTabs();
    void this.renderFileHistoryComparison(this.fileHistoryLoadGeneration);
    if (this.fileHistoryTabKey !== null) this.replaceNav(this.fileHistoryNavigationState());
  },


  openFileHistoryItemContextMenu(event, item) {
    event.preventDefault();
    event.stopPropagation();
    const key = this.fileHistoryItemKey(item);
    const menu = this.$("context-menu");
    menu.textContent = "";
    this.contextMenuTarget = { type: "file-history-item", key };
    if (item.kind !== "current") {
      this.addContextItem(menu, "Compare with current", () => this.applyFileHistorySelections(["current", key]), "compare-changes");
      const other = this.fileHistorySelections.find((selected) => selected !== key && selected !== "current");
      if (other) this.addContextItem(menu, "Compare with selected version", () =>
        this.applyFileHistorySelections([other, key]), "compare-changes");
    }
    if (item.kind === "local") {
      this.addContextItem(menu, "Restore this local version…", () => this.restoreFileHistoryVersion(item.version_id), "discard");
    }
    if (item.kind === "git") {
      this.addContextItem(menu, "Copy commit hash", () => this.copyTextToClipboard(item.commit_id, "commit hash copied"), "copy");
      this.addContextItem(menu, "Copy commit message", () => this.copyTextToClipboard(item.message, "commit message copied"), "copy");
    }
    this.positionContextMenu(menu, event.clientX, event.clientY);
  },


  async loadFileHistoryItemContent(item, entry) {
    const url = item.kind === "git"
      ? `/api/files/git-history/${encodeURIComponent(item.commit_id)}?root=${encodeURIComponent(entry.root)}&path=${encodeURIComponent(entry.path)}`
      : `/api/files/history/${encodeURIComponent(item.version_id)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("history version unavailable");
    const payload = await res.json();
    return String(payload.content || "");
  },


  async currentFileHistoryContent(entry) {
    if (entry.model) return entry.model.getValue();
    const res = await fetch(`/api/files/read?root=${encodeURIComponent(entry.root)}&path=${encodeURIComponent(entry.path)}`);
    if (!res.ok) throw new Error("current file unavailable");
    const payload = await res.json();
    return String(payload.content || "");
  },


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
  },


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
  },


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
  },


  fileHistoryModelLines(model, startLine, endLine) {
    const start = Number(startLine) || 0;
    const end = Number(endLine) || 0;
    if (!model || start < 1 || end < start) return [];
    return model.getLinesContent().slice(start - 1, end);
  },


  syncFileHistoryDiffBlocksFromEditor() {
    const editor = this.fileHistoryDiffEditor;
    const changes = editor?.getLineChanges();
    if (!editor || changes === null || changes === undefined) {
      this.fileHistoryDiffPending = !!editor;
      this.updateFileHistoryDiffToolbar();
      return;
    }
    const originalModel = editor.getOriginalEditor().getModel();
    const modifiedModel = editor.getModifiedEditor().getModel();
    this.fileHistoryDiffPending = false;
    this.fileHistoryDiffBlocks = changes.map((change) => {
      const originalStart = Math.max(1, Number(change.originalStartLineNumber) || 1);
      const originalEnd = Number(change.originalEndLineNumber) || 0;
      const modifiedStartCandidate = Number(change.modifiedStartLineNumber) || originalStart;
      const modifiedStart = Math.max(1, Math.min((modifiedModel?.getLineCount() || 0) + 1, modifiedStartCandidate));
      const modifiedEnd = Number(change.modifiedEndLineNumber) || 0;
      return { oldStart: originalStart, oldEnd: originalEnd >= originalStart ? originalEnd : originalStart - 1,
        newStart: modifiedStart, newEnd: modifiedEnd >= modifiedStart ? modifiedEnd : modifiedStart - 1,
        originalLines: this.fileHistoryModelLines(originalModel, originalStart, originalEnd),
        modifiedLines: this.fileHistoryModelLines(modifiedModel, modifiedStart, modifiedEnd), monacoChange: change };
    });
    this.fileHistoryDiffBlockIndex = this.fileHistoryDiffBlocks.length
      ? Math.min(Math.max(this.fileHistoryDiffBlockIndex, 0), this.fileHistoryDiffBlocks.length - 1) : -1;
    this.updateFileHistoryDiffToolbar();
  },


  createFileHistoryTransientModel(content, entry, item) {
    const language = entry.model?.getLanguageId();
    const model = monaco.editor.createModel(content, language, monaco.Uri.parse(
      `inmemory://termdeck-file-history/${encodeURIComponent(`${entry.root}/${entry.path}/${this.fileHistoryItemKey(item)}`)}`));
    this.fileHistoryTransientModels.add(model);
    return model;
  },


  fileHistoryEditorOptions() {
    return { automaticLayout: true, minimap: { enabled: false }, scrollBeyondLastLine: false,
      fontSize: this.scaledSettingSize("code_font_size"), lineNumbersMinChars: 4, renderLineHighlight: "all", folding: true,
      wordWrap: this.settings.editor_no_wrap ? "off" : "on", fixedOverflowWidgets: true };
  },


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
  },


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
    this.fileHistoryDiffBlocks = [];
    this.fileHistoryDiffBlockIndex = -1;
    this.fileHistoryDiffPending = true;
    this.$("file-history-preview-empty").classList.add("hidden");
    this.$("file-history-preview").classList.add("hidden");
    this.updateFileHistoryDiffToolbar();
    if (typeof editor.onDidUpdateDiff === "function") editor.onDidUpdateDiff(() => this.syncFileHistoryDiffBlocksFromEditor());
    if (modifiedEditable) editor.getModifiedEditor().onDidChangeModelContent(() => this.markFileHistoryDiffPending());
    requestAnimationFrame(() => {
      editor.layout();
      if (modifiedEditable) editor.getModifiedEditor().focus();
      this.syncFileHistoryDiffBlocksFromEditor();
      if (this.fileHistoryDiffBlocks.length) this.navigateFileHistoryDiff(0);
    });
  },


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
  },


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
    this.markFileHistoryDiffPending();
    editor.executeEdits("termdeck-file-history-restore", [{ range, text: lines.join("\n") }]);
    editor.focus();
  },


  applyFileHistoryDiffBlockToCurrent() {
    const block = this.fileHistoryDiffBlocks[this.fileHistoryDiffBlockIndex];
    if (!block) return;
    this.replaceCurrentFileHistoryLines(block.newStart, block.newEnd, block.originalLines);
  },


  async renderFileHistoryComparison(generation) {
    const key = this.fileHistoryTabKey;
    const entry = key !== null ? this.openFiles.get(key) : null;
    if (!entry || this.activeFileKey !== key || !this.fileHistoryOpen || generation !== this.fileHistoryLoadGeneration ||
        !this.fileHistorySelections.length) return;
    const selectionKeys = [...this.fileHistorySelections];
    const selectedItems = selectionKeys.map((key) => this.fileHistoryItems.find((item) => this.fileHistoryItemKey(item) === key)).filter(Boolean);
    if (!selectedItems.length) return;
    try {
      if (!entry.model) await this.refreshFileModelFromDisk(entry);
      if (generation !== this.fileHistoryLoadGeneration || !this.fileHistoryOpen || this.fileHistoryTabKey !== key ||
          this.activeFileKey !== key || selectionKeys.join("\n") !== this.fileHistorySelections.join("\n")) return;
      const historyItems = selectedItems.filter((item) => item.kind !== "current");
      if (!historyItems.length) {
        this.renderFileHistoryCurrentEditor(entry);
        return;
      }
      if (historyItems.length === 1) {
        const originalContent = await this.loadFileHistoryItemContent(historyItems[0], entry);
        if (generation !== this.fileHistoryLoadGeneration || !this.fileHistoryOpen || this.fileHistoryTabKey !== key ||
            this.activeFileKey !== key || selectionKeys.join("\n") !== this.fileHistorySelections.join("\n")) return;
        this.renderFileHistorySplitEditor(entry, originalContent, entry.model.getValue(), historyItems[0], { kind: "current" }, true);
        return;
      }
      const selectedContents = await Promise.all(historyItems.slice(0, 2).map((item) => this.loadFileHistoryItemContent(item, entry)));
      if (generation !== this.fileHistoryLoadGeneration || !this.fileHistoryOpen || this.fileHistoryTabKey !== key ||
          this.activeFileKey !== key || selectionKeys.join("\n") !== this.fileHistorySelections.join("\n")) return;
      this.renderFileHistorySplitEditor(entry, selectedContents[0], selectedContents[1], historyItems[0], historyItems[1], false);
    } catch (error) {
      this.disposeFileHistoryEditors();
      this.updateFileHistoryDiffToolbar();
      this.$("file-history-preview-empty").textContent = error.message || "history comparison unavailable";
      this.$("file-history-preview-empty").classList.remove("hidden");
      this.$("file-history-editor-host").classList.add("hidden");
      this.$("file-history-preview").classList.add("hidden");
    }
  },


  async restoreFileHistoryVersion(versionId) {
    const entry = this.fileHistoryTabKey !== null ? this.openFiles.get(this.fileHistoryTabKey) : null;
    const version = this.fileHistoryVersions.find((candidate) => candidate.version_id === versionId);
    if (!entry || !version) return;
    if (entry.dirty && !await uiConfirm("Discard the current unsaved editor changes and restore this version?")) return;
    if (!await uiConfirm(`Restore ${entry.name} from ${version.captured_at_est}?`)) return;
    const res = await fetch("/api/files/history/restore", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root: entry.root, path: entry.path, version_id: versionId }),
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      void uiAlert(error.detail || "restore failed");
      return;
    }
    entry.dirty = false;
    await this.refreshFileModelFromDisk(entry);
    this.renderList();
    await this.loadFileHistory();
  },


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
  },


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
    const fromTitleText = this.agentKindInText(session?.title) || this.agentKindInText(session?.cli_title);
    if (fromTitleText) return fromTitleText;
    if (String(session?.command || "").toLowerCase().includes("zsh") ||
        String(session?.command || "").toLowerCase().includes("bash") ||
        String(session?.command || "").toLowerCase().includes("sh")) return "none";
    if (this.historyModelFromText(session?.agent_kind)) return this.historyModelFromText(session?.agent_kind);
    return "none";
  },


  historyModelFromCommand(command) {
    const text = this.normalizeModelText(command);
    if (!text) return "";
    const modelFromFlag = this.historyModelFromCommandFlags(text);
    if (modelFromFlag) return modelFromFlag;
    const commandModel = this.normalizeModelKind(text);
    return commandModel || this.historyModelFromValue(text);
  },


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
  },


  historyModelFromValue(raw) {
    const value = this.normalizeModelText(raw).replace(/^["']|["']$/g, "");
    if (!value) return "";
    const modelPattern = /\b(gpt-[a-z0-9.+-]+(?:-[a-z0-9.+-]+)*(?:\s+(?:x)?(?:high|medium|low|standard|mini|turbo))?)\b/gi;
    const match = value.match(modelPattern);
    if (!match) return "";
    return match[0];
  },


  historyModelFromText(raw) {
    const value = this.historyModelFromValue(raw);
    if (value) return value;
    return this.normalizeModelKind(raw);
  },


  normalizeModelText(raw) {
    return typeof raw === "string" ? raw.trim() : "";
  },


  agentKindInText(raw) {
    const text = String(raw || "").toLowerCase();
    if (!text) return "";
    for (const kind of Object.keys(this.agentSpecs)) {
      if (kind !== "none" && text.includes(kind)) return kind;
    }
    return "";
  },


  normalizeModelKind(raw) {
    const text = String(raw || "").toLowerCase();
    if (!text) return "";
    const kind = this.agentKindInText(text);
    if (kind) return kind;
    if (text.includes("none") || /\b(shell|zsh|bash)\b/.test(text)) return "none";
    return "";
  },


  cacheSessionModel(session) {
    if (!session || !session.session_id) return;
    const sessionId = session.session_id;
    const commandModel = this.historyModelFromCommand(session.command);
    const titleModel = this.historyModelFromText(session.title);
    const cliTitleModel = this.historyModelFromText(session.cli_title);
    const specific = [commandModel, titleModel, cliTitleModel].find((value) => value && !this.historyModelIsGeneric(value));
    if (specific) this.sessionModelById.set(sessionId, specific);
    else this.sessionModelById.delete(sessionId);
  },


  cacheSessionModelFromHistory(sessionId, turns = []) {
    if (!sessionId) return;
    const specific = this.historyModelFromTranscript(turns);
    if (specific) this.sessionModelById.set(sessionId, specific);
  },


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
  },


  historyModelDisplayFromTranscript(turns = []) {
    if (!Array.isArray(turns)) return "";
    return this.historyModelFromTranscript(turns);
  },


  historyModelIsGeneric(raw) {
    const text = this.normalizeModelText(raw).toLowerCase();
    return !!this.agentSpecs[text] || text === "shell" || text === "bash" || text === "zsh" || text === "sh";
  },


  historyModelDisplay(session, turns = []) {
    const fromTranscript = this.historyModelDisplayFromTranscript(turns);
    if (fromTranscript) return fromTranscript;
    return this.historyModelLabel(session, turns);
  },


  historyModelLabel(session, turns = []) {
    const model = this.historyModel(session, turns);
    if (this.historyModelIsGeneric(model)) {
      const label = this.agentLabel(model, "Shell");
      return label;
    }
    const label = this.historyModelModelLabel(model);
    return label || "";
  },


  historyModelModelLabel(model) {
    return this.normalizeModelText(model);
  },


  terminalStatusModelFromLine(line) {
    const text = this.normalizeTerminalTailLine(line);
    if (!text || !/(?:context|tokens?|remaining|left|used|model|thinking|working|%)/i.test(text)) return "";
    const gptModel = this.historyModelFromValue(text);
    if (gptModel && !this.historyModelIsGeneric(gptModel)) return gptModel;
    const match = text.match(/\b((?:claude|gemini)(?:[-\s](?!(?:context|tokens?|remaining|left|used|model|thinking|working)\b)[a-z0-9.]+)*|(?:opus|sonnet|haiku)(?:[-\s](?!(?:context|tokens?|remaining|left|used|model|thinking|working)\b)[a-z0-9.]+)*)\b/i);
    const model = this.normalizeModelText(match?.[1] || "");
    return this.historyModelIsGeneric(model) ? "" : model;
  },


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
  },


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
  },


  sessionSupportsTranscript(session = this.session(this.activeId)) {
    return !!session && !!this.agentSpec(session.agent_kind)?.is_agent;
  },


  usesTranscriptFirstSession(session = this.session(this.activeId)) {
    return this.sessionSupportsTranscript(session);
  },


  selectedHistoryMode(session = this.session(this.activeId)) {
    if (!this.sessionSupportsTranscript(session)) return false;
    if (this.touchMobileLayoutEnabled()) return true;
    const savedMode = this.getProjectState().session_view_modes?.[session.session_id];
    if (savedMode === "markdown" || savedMode === "terminal") return savedMode === "markdown";
    return this.settings.transcript_first_surface === "markdown";
  },


  reconcileActiveSessionViewMode() {
    if (!this.activeId || this.activeFileKey !== null || !this.session(this.activeId)) return;
    const enabled = this.selectedHistoryMode();
    if (this.historyOpen !== enabled) this.setHistoryMode(enabled, { persist: false });
  },


  applyMainLayout() {
    this.ensureHistoryFiltersForProject();
    const fileMode = this.activeFileKey !== null;
    if (!fileMode && this.fileHistoryOpen) {
      this.fileHistoryOpen = false;
      this.fileHistorySidebarVisible = false;
    }
    const fileHistoryMode = fileMode && this.fileHistoryOpen && this.fileHistoryTabKey === this.activeFileKey;
    const gitReviewMode = this.gitReviewOpen && this.sideView === "git" && !fileMode;
    const historyMode = this.historyOpen && !fileMode && !gitReviewMode;
    const transcriptSupported = this.sessionSupportsTranscript();
    const transcriptFirstMode = historyMode && this.usesTranscriptFirstSession();
    document.body.classList.toggle("mobile-history-surface", this.touchMobileLayoutEnabled() && historyMode);
    const fileWorkspaceMode = fileMode || FILES_SIDE_PANEL_TABS.includes(this.sideView);
    this.$("file-tabs-bar").classList.toggle("hidden",
      this.vscodeMode || (!fileMode && !FILES_SIDE_PANEL_TABS.includes(this.sideView)));
    this.$("notebook-toggle").classList.toggle("hidden", fileMode || gitReviewMode || FILES_SIDE_PANEL_TABS.includes(this.sideView));
    this.$("editor-wrap-toggle").classList.toggle("hidden", !fileWorkspaceMode);
    this.$("editor-area").classList.toggle("hidden", !fileMode || fileHistoryMode);
    this.$("git-review-area").classList.toggle("hidden", !gitReviewMode);
    this.$("history-area").classList.toggle("hidden", !historyMode);
    this.$("history-area").classList.toggle("transcript-first", transcriptFirstMode);
    this.$("terminal-area").classList.toggle("hidden", fileMode || gitReviewMode);
    this.$("terminal-area").classList.toggle("history-suspended", historyMode);
    this.$("conversation-outline").classList.toggle("hidden",
      fileMode || gitReviewMode || !transcriptSupported || !this.conversationOutlineOpen);
    this.$("conversation-outline-toggle").classList.toggle("transcript-unavailable", !fileMode && !transcriptSupported);
    this.$("conversation-outline-toggle").classList.toggle("on", fileMode
      ? this.fileInspectorMode === "outline" : !gitReviewMode && this.conversationOutlineOpen);
    for (const id of ["history-btn", "vscode-history-btn"]) {
      const historyButton = this.$(id);
      if (!historyButton) continue;
      historyButton.classList.toggle("transcript-unavailable", !transcriptSupported);
      historyButton.classList.toggle("on", historyMode);
      const openTerminal = transcriptFirstMode && historyMode;
      const label = openTerminal ? "Open terminal" : "Open transcript";
      historyButton.title = label;
      historyButton.setAttribute("aria-label", label);
      const icon = historyButton.querySelector(".codicon");
      if (icon) icon.className = `codicon codicon-${openTerminal ? "terminal" : "comment-discussion"}`;
    }
    this.$("history-edits-toggle")?.classList.add("hidden");
    this.$("history-scroll-bottom")?.classList.toggle("hidden", !historyMode);
    this.updateProblemsAvailability();
    this.updateShortcutTitles();
    this.$("attach-btn").classList.toggle("hidden", fileMode || gitReviewMode);
    const revealButton = this.$("reveal-session-btn");
    revealButton.classList.toggle("hidden", gitReviewMode);
    const revealLabel = fileMode ? "Reveal active file in tree" : "Select current terminal in terminal list";
    revealButton.title = revealLabel;
    revealButton.setAttribute("aria-label", revealLabel);
    const attachButton = this.$("attach-btn");
    if (attachButton) {
      const label = historyMode ? "Upload file/image into transcript prompt" : "Attach file/image to terminal";
      attachButton.title = label;
      attachButton.setAttribute("aria-label", label);
    }
    for (const id of ["terminal-resync-btn"]) {
      const button = this.$(id);
      if (button) {
        button.classList.toggle("hidden", fileMode || gitReviewMode);
        const label = historyMode ? "Refresh transcript" : "Resync terminal content";
        button.title = label;
        button.setAttribute("aria-label", label);
      }
    }
    const terminalScrollButton = this.$("scroll-bottom-btn");
    if (terminalScrollButton) {
      terminalScrollButton.classList.toggle("hidden", historyMode || fileMode || gitReviewMode);
    }
    this.$("history-btn").classList.toggle("hidden", fileMode || gitReviewMode ||
      (this.touchMobileLayoutEnabled() && transcriptSupported));
    this.updateTerminalHistoryMoreButton();
    this.syncFileHistorySurface();
    this.renderHistoryMeta();
    this.updateHistoryThinkingIndicator();
    this.renderHistoryQueue();
    this.fitActive();
    this.updateEventlyDemoFeatureBanner();
    if (fileHistoryMode) requestAnimationFrame(() => {
      if (this.fileHistoryDiffEditor) this.fileHistoryDiffEditor.layout();
      else this.fileHistoryCurrentEditor?.layout();
    });
    this.renderInlineSizeControls();
  },


  updateHistoryThinkingIndicator() {
    const indicator = this.$("history-thinking-banner");
    const processing = !!this.processingStates.get(this.activeId);
    const awaitingProcessing = this.historyPendingProcessing.has(this.activeId);
    const spinning = !!this.historyOpen && (processing || awaitingProcessing);
    this.updateHistorySendButton(spinning);
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
  },


  updateHistorySendButton(spinning = !!this.historyOpen &&
    (!!this.processingStates.get(this.activeId) || this.historyPendingProcessing.has(this.activeId))) {
    const button = this.$("history-send");
    if (!button) return;
    const label = "Send prompt";
    const icon = button.querySelector(".codicon");
    if (icon) icon.className = "codicon codicon-send";
    button.title = label;
    button.setAttribute("aria-label", label);
    this.updateHistorySendMenu(spinning);
  },


  updateHistorySendMenu(spinning = !!this.historyOpen &&
    (!!this.processingStates.get(this.activeId) || this.historyPendingProcessing.has(this.activeId))) {
    const queue = this.$("history-queue");
    const stop = this.$("history-stop");
    const prompt = this.$("history-prompt");
    if (!queue || !stop) return;
    const hasPrompt = !!prompt?.value.trim();
    queue.classList.toggle("hidden", !this.historyOpen || (spinning && !hasPrompt));
    stop.classList.toggle("hidden", !this.historyOpen || !spinning);
  },


  handleHistorySendButton() {
    this.sendHistoryPrompt();
  },


  toggleHistorySendMenu() {
    const menu = this.$("history-send-menu");
    const toggle = this.$("history-send-menu-toggle");
    if (!menu || !toggle || !this.historyOpen || this.activeFileKey !== null) return;
    this.updateHistorySendMenu();
    const opening = menu.classList.contains("hidden");
    menu.classList.toggle("hidden", !opening);
    toggle.setAttribute("aria-expanded", String(opening));
    if (opening) this.closePromptHistory();
  },


  closeHistorySendMenu() {
    const menu = this.$("history-send-menu");
    const toggle = this.$("history-send-menu-toggle");
    if (!menu || !toggle) return;
    menu.classList.add("hidden");
    toggle.setAttribute("aria-expanded", "false");
  },


  async interruptHistoryPrompt() {
    if (!this.historyOpen || !this.activeId) return;
    const view = this.sessionInteractionState(this.activeId);
    if (!view || view.promptApiInterrupting) return;
    view.promptApiInterrupting = true;
    this.historyPendingProcessing.delete(this.activeId);
    view.promptQueueHold = false;
    this.updateHistoryThinkingIndicator();
    this.$("status-name").textContent = "stopping response…";
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(view.sessionId)}/interrupt`, { method: "POST" });
      if (!response.ok) {
        const failure = await response.json().catch(() => ({}));
        throw new Error(String(failure.detail || `interrupt failed (${response.status})`));
      }
      const session = await response.json();
      this.applySessionStatus({ ...session, session_id: view.sessionId });
      this.$("status-name").textContent = "stop requested";
    } catch (error) {
      this.$("status-name").textContent = error instanceof Error ? error.message : "unable to stop response";
    } finally {
      view.promptApiInterrupting = false;
    }
  },


  updateActiveThinkingBlock() {
    const body = this.$("history-body");
    if (!body) return;
    body.querySelectorAll(".history-event.thinking.active").forEach((event) => event.classList.remove("active"));
    if (!this.historyOpen || !this.processingStates.get(this.activeId)) return;
    const last = body.lastElementChild;
    if (last?.classList.contains("history-event") && last.classList.contains("thinking")) {
      last.classList.add("active");
    }
  },


  formatElapsed(seconds) {
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  },


  renderHistoryQueue(view = this.sessionInteractionState(this.activeId, false)) {
    const container = this.$("history-queued");
    const items = this.$("history-queued-items");
    const count = this.$("history-queued-count");
    const toggle = this.$("history-queued-toggle");
    if (!container || !items || !count || !toggle) return;
    const queued = view?.promptQueue || [];
    container.classList.toggle("hidden", !this.historyOpen || !queued.length);
    if (!queued.length) container.classList.remove("editing");
    const collapsed = view?.promptQueueCollapsed === true;
    container.classList.toggle("collapsed", collapsed);
    toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
    toggle.setAttribute("aria-label", collapsed ? "Expand queued messages" : "Collapse queued messages");
    toggle.title = collapsed ? "Expand queued messages" : "Collapse queued messages";
    const toggleIcon = toggle.querySelector(".codicon");
    if (toggleIcon) toggleIcon.className = `codicon codicon-chevron-${collapsed ? "right" : "down"}`;
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
      const keepActiveQueuedEditorCaretVisible = () => {
        if (document.activeElement !== editor || editor.selectionEnd !== editor.value.length) return;
        editor.scrollTop = editor.scrollHeight;
        requestAnimationFrame(() => {
          if (document.activeElement === editor && editor.selectionEnd === editor.value.length) {
            editor.scrollTop = editor.scrollHeight;
          }
        });
      };
      const resize = () => {
        if (row.classList.contains("editing")) {
          editor.style.height = "100%";
          editor.classList.add("scrollable");
          keepActiveQueuedEditorCaretVisible();
          return;
        }
        const previousScrollTop = editor.scrollTop;
        editor.style.height = "auto";
        const contentHeight = editor.scrollHeight;
        editor.style.height = `${Math.min(contentHeight, 120)}px`;
        editor.classList.toggle("scrollable", contentHeight > 120);
        if (document.activeElement === editor && editor.selectionEnd === editor.value.length) {
          keepActiveQueuedEditorCaretVisible();
        } else {
          editor.scrollTop = previousScrollTop;
        }
      };
      editor.addEventListener("focus", () => {
        if (view) view.promptQueueEditIndex = index;
        container.classList.add("editing");
        row.classList.add("editing");
        resize();
        keepActiveQueuedEditorCaretVisible();
      });
      editor.addEventListener("input", () => {
        const current = view?.promptQueue?.[index];
        if (!current) return;
        current.draftText = editor.value;
        this.persistMarkdownPromptQueue(view);
        resize();
        keepActiveQueuedEditorCaretVisible();
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
        container.classList.remove("editing");
        row.classList.remove("editing");
        editor.style.height = "";
        const current = view?.promptQueue?.[index];
        if (!current) return;
        const next = editor.value;
        current.draftText = next;
        this.commitHistoryQueueEdit(view, index, next);
      });
      resize();
      const sendNow = document.createElement("button");
      sendNow.className = "history-queued-send-now";
      sendNow.type = "button";
      sendNow.title = "Send this queued prompt now";
      sendNow.setAttribute("aria-label", `Send queued prompt ${index + 1} now`);
      sendNow.innerHTML = '<span class="codicon codicon-send"></span>';
      sendNow.addEventListener("mousedown", (event) => event.preventDefault());
      sendNow.addEventListener("click", () => this.sendHistoryQueueItemNow(view, index));
      const remove = document.createElement("button");
      remove.className = "history-queued-remove";
      remove.type = "button";
      remove.title = "Remove queued prompt";
      remove.setAttribute("aria-label", `Remove queued prompt ${index + 1}`);
      remove.textContent = "×";
      remove.addEventListener("mousedown", (event) => event.preventDefault());
      remove.addEventListener("click", () => this.removeHistoryQueueItem(view, index));
      row.append(number, editor, sendNow, remove);
      items.appendChild(row);
    });
  },


  toggleHistoryQueueCollapsed() {
    const view = this.sessionInteractionState(this.activeId, false);
    if (!view?.promptQueue?.length) return;
    view.promptQueueCollapsed = view.promptQueueCollapsed !== true;
    this.renderHistoryQueue(view);
  },


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
  },


  removeHistoryQueueItem(view, index) {
    if (!view?.promptQueue?.[index]) return;
    view.promptQueue.splice(index, 1);
    view.promptQueueEditIndex = null;
    this.persistMarkdownPromptQueue(view);
    this.renderHistoryQueue(view);
  },


  async sendHistoryQueueItemNow(view, index) {
    const item = view?.promptQueue?.[index];
    const text = String(item?.draftText ?? item?.text ?? "");
    if (!view || !item || !text.trim()) return false;
    if (view.promptQueueDispatching) return false;
    view.promptQueueDispatching = true;
    this.renderHistoryQueue(view);
    const sent = await this.submitHistoryPromptViaApi(view, text, { fromQueue: true });
    view.promptQueueDispatching = false;
    if (!sent) {
      this.renderHistoryQueue(view);
      return false;
    }
    this.acknowledgeSubmittedMarkdownQueueItem(view, item, text);
    return true;
  },


  focusActiveEditor() {
    const view = this.sessionInteractionState(this.activeId, false);
    if (this.activeFileKey !== null) {
      if (this.fileHistoryOpen && this.fileHistoryTabKey === this.activeFileKey) {
        const diffEditor = this.fileHistoryDiffEditor;
        if (diffEditor) diffEditor.getModifiedEditor().focus();
        else this.fileHistoryCurrentEditor?.focus();
      } else this.editor?.focus();
      return;
    }
    if (this.gitReviewOpen && this.sideView === "git") {
      this.gitReviewDiffEditor?.getModifiedEditor().focus();
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
  },


  refocusActiveInputAfterToolbarAction() {
    if (this.touchMobileLayoutEnabled()) {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      return;
    }
    requestAnimationFrame(() => requestAnimationFrame(() => this.focusActiveEditor()));
  },


  scheduleActiveEditorFocus(sessionId) {
    clearTimeout(this.activeEditorFocusTimer);
    if (this.historyOpen) return;
    this.activeEditorFocusTimer = window.setTimeout(this.runScheduledActiveEditorFocus.bind(this, sessionId), 80);
  },


  runScheduledActiveEditorFocus(sessionId) {
    this.activeEditorFocusTimer = 0;
    if (sessionId !== this.activeId || this.historyOpen) return;
    this.focusActiveEditor();
  },


  closeHistory() {
    this.setHistoryMode(false);
  },


  async toggleHistory() {
    if (this.activeFileKey !== null || (!this.historyOpen && !this.sessionSupportsTranscript())) return;
    if (this.touchMobileLayoutEnabled() && this.sessionSupportsTranscript()) return;
    this.setHistoryMode(!this.historyOpen);
  },


  setHistoryMode(enabled, options = {}) {
    if (!this.activeId) return;
    if (enabled && !this.sessionSupportsTranscript()) return;
    const mobileTranscriptMode = this.touchMobileLayoutEnabled() && this.sessionSupportsTranscript();
    if (mobileTranscriptMode) enabled = true;
    if (this.historyOpen && !enabled) this.rememberHistoryScrollPosition(this.activeId);
    this.closeTerminalFind();
    this.closeHistorySlashMenu();
    this.hideSelectionActions(true);
    if (!enabled) {
      this.closePromptHistory();
      this.closeHistoryFilterMenu();
    }
    const mode = enabled ? "markdown" : "terminal";
    if (options.persist !== false && !mobileTranscriptMode) {
      const sessionViewModes = { ...(this.getProjectState().session_view_modes || {}), [this.activeId]: mode };
      this.applyLocalProjectStatePatch({ session_view_modes: sessionViewModes });
      this.queueProjectResourceRequest(this.projectStateKey(),
        `/api/session-view-modes/${encodeURIComponent(this.activeId)}`, "PUT", { mode });
    }
    this.stopHistoryRefresh();
    this.disconnectHistoryStream();
    this.historyFingerprint = "";
    this.historyTurns = [];
    this.historyRenderedTurns = [];
    this.historyLoaded = false;
    let view = this.sessionInteractionState(this.activeId);
    this.beginTerminalLayoutTransition(view?.term ? view : null);
    this.historyOpen = !!enabled && this.activeFileKey === null && !!this.activeId;
    if (this.historyOpen && view?.term) this.suspendMobileTranscriptTerminalSocket(view);
    this.postVscodeNativeSession(this.session(this.activeId), !this.historyOpen);
    this.applyMainLayout();
    this.scheduleTerminalLayoutFit();
    if (this.historyOpen) {
      const sessionId = this.activeId;
      this.showPromptDraft(view);
      const cached = this.historyTurnsBySession.get(sessionId);
      if (cached) this.applyHistoryTurns(sessionId, cached, { preserveScroll: false });
      this.connectHistoryStream(sessionId, { fresh: true });
    } else {
      view = this.ensureView(this.activeId);
      if (view) {
        this.resumeMobileTerminalSocket(view);
        if (this.nativeVscodeMode) this.postVscodeNativeSession(this.session(this.activeId), true);
        else view.term.focus();
        setTimeout(() => {
          if (!view.closed && this.activeId === view.sessionId && !this.historyOpen) {
            this.refreshTerminalAppearance(view, true);
          }
        }, 500);
      }
    }
  },


  suspendMobileTranscriptTerminalSocket(view) {
    if (!view || !this.usesLightweightTranscriptTransport() || !this.historyOpen || view.sessionId !== this.activeId) return false;
    view.suppressReconnect = true;
    view.reconnectAfterClose = false;
    clearTimeout(view.reconnectTimer);
    view.reconnectTimer = 0;
    if (view.ws) view.ws.close();
    return true;
  },


  resumeMobileTerminalSocket(view) {
    if (!view || !this.usesLightweightTranscriptTransport() || this.historyOpen || view.sessionId !== this.activeId) return;
    view.suppressReconnect = false;
    if (!view.ws) this.connect(view.sessionId, view);
  },


  usesLightweightTranscriptTransport() {
    return this.touchMobileLayoutEnabled() || location.protocol === "https:";
  },


  startHistoryRefresh() {
    // Transcript updates arrive from the file watcher over the transcript
    // websocket. Kept as a no-op for callers from older saved UI state.
    this.stopHistoryRefresh();
  },


  stopHistoryRefresh() {
    if (this.historyRefreshTimer) clearInterval(this.historyRefreshTimer);
    this.historyRefreshTimer = 0;
  },


  disconnectHistoryStream() {
    this.cancelHistoryBackgroundLoad();
    this.cancelFilteredHistoryContinuation();
    clearTimeout(this.historyWsReconnectTimer);
    this.historyWsReconnectTimer = 0;
    const ws = this.historyWs;
    const sessionId = this.historyStreamSessionId;
    this.historyWs = null;
    this.historyStreamSessionId = null;
    if (sessionId) this.historySnapshotBuffers.delete(sessionId);
    if (ws) ws.close();
  },


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
      if (this.touchMobileLayoutEnabled()) {
        clearTimeout(this.mobileConnectionWarningTimer);
        this.mobileConnectionWarningTimer = 0;
        this.setMobileConnectionWarning(false);
      }
      // A tab switch can carry a cached revision from before a fork/resume
      // changed the underlying rollout. Request the authoritative snapshot in
      // that case instead of treating inherited history as current.
      const revision = fresh ? 0 : (this.historyRevisions.get(sessionId) || 0);
      const initialLimit = this.usesLightweightTranscriptTransport() ? 20 : HISTORY_BACKGROUND_PAGE_TURNS;
      ws.send(JSON.stringify({ type: "transcript_subscribe", revision, fresh, latest_first: true,
        initial_limit: initialLimit }));
      this.scheduleHistoryPendingPromptReconciliation(sessionId);
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
      this.scheduleMobileConnectionWarning();
      if (!this.historyOpen || sessionId !== this.activeId) return;
      clearTimeout(this.historyWsReconnectTimer);
      this.historyWsReconnectTimer = setTimeout(() => this.connectHistoryStream(sessionId), RECONNECT_MS);
    };
  },


  historySlashMenuOpen() {
    return !this.$("history-slash-menu")?.classList.contains("hidden");
  },


  historySlashCommands() {
    const commands = this.agentSpec(this.session(this.activeId)?.agent_kind)?.transcript_commands;
    return Array.isArray(commands) ? commands.filter((item) => item && typeof item.command === "string") : [];
  },


  updateHistorySlashMenu() {
    const menu = this.$("history-slash-menu");
    const prompt = this.$("history-prompt");
    if (!menu || !prompt || !this.historyOpen) return;
    const firstLine = prompt.value.split("\n", 1)[0];
    if (!firstLine.startsWith("/") || /\s/.test(firstLine)) {
      this.closeHistorySlashMenu();
      return;
    }
    const query = firstLine.toLowerCase();
    const commands = this.historySlashCommands().filter((item) =>
      item.command.toLowerCase().includes(query) || String(item.description || "").toLowerCase().includes(query.slice(1)));
    if (!commands.length) {
      this.closeHistorySlashMenu();
      return;
    }
    this.historySlashMenuMatches = commands;
    this.historySlashMenuIndex = Math.max(0, Math.min(this.historySlashMenuIndex, commands.length - 1));
    menu.replaceChildren();
    commands.forEach((item, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "history-slash-command";
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(index === this.historySlashMenuIndex));
      button.classList.toggle("selected", index === this.historySlashMenuIndex);
      const command = document.createElement("span");
      command.className = "history-slash-command-name";
      command.textContent = item.command;
      const description = document.createElement("span");
      description.className = "history-slash-command-description";
      description.textContent = String(item.description || "");
      button.append(command, description);
      button.onmousedown = (event) => event.preventDefault();
      button.onclick = () => this.selectHistorySlashCommand(index);
      menu.append(button);
    });
    menu.classList.remove("hidden");
  },


  moveHistorySlashMenuSelection(delta) {
    if (!this.historySlashMenuMatches.length) return;
    this.historySlashMenuIndex = (this.historySlashMenuIndex + delta + this.historySlashMenuMatches.length) %
      this.historySlashMenuMatches.length;
    this.updateHistorySlashMenu();
    this.$("history-slash-menu")?.querySelector(".history-slash-command.selected")?.scrollIntoView({ block: "nearest" });
  },


  selectHistorySlashCommand(index) {
    const item = this.historySlashMenuMatches[index];
    const view = this.sessionInteractionState(this.activeId, false);
    if (!item || !view) return;
    const prompt = this.$("history-prompt");
    prompt.value = item.command;
    this.persistMarkdownPromptDraft(view, prompt.value);
    this.resizeHistoryPrompt();
    this.closeHistorySlashMenu();
    prompt.focus();
    prompt.setSelectionRange(prompt.value.length, prompt.value.length);
  },


  closeHistorySlashMenu() {
    const menu = this.$("history-slash-menu");
    if (menu) {
      menu.classList.add("hidden");
      menu.replaceChildren();
    }
    this.historySlashMenuIndex = -1;
    this.historySlashMenuMatches = [];
  },


  refreshActiveTranscript() {
    if (!this.historyOpen || this.activeFileKey !== null || !this.activeId) return false;
    this.historyManualRefreshSessionId = this.activeId;
    this.$("status-name").textContent = "refreshing transcript…";
    this.connectHistoryStream(this.activeId, { fresh: true });
    return true;
  },


  applyHistoryStreamMessage(sessionId, message) {
    if (sessionId !== this.activeId || !this.historyOpen) return;
    const type = message.type;
    if (type === "transcript_snapshot_start") {
      this.historySnapshotBuffers.set(sessionId, { revision: Number(message.revision || 0), turns: [],
        chunks: [], latestFirst: message.latest_first === true, rendered: false,
        before: message.before == null ? null : Number(message.before), hasMore: !!message.has_more });
      return;
    }
    if (type === "transcript_snapshot_chunk") {
      const buffer = this.historySnapshotBuffers.get(sessionId);
      if (!buffer || !Array.isArray(message.turns)) return;
      const index = Number(message.index);
      if (buffer.latestFirst && Number.isInteger(index) && index >= 0) {
        buffer.chunks[index] = message.turns;
        buffer.turns = buffer.chunks.filter(Array.isArray).flat();
        this.renderHistorySnapshotProgress(sessionId, buffer);
      } else buffer.turns.push(...message.turns);
      return;
    }
    if (type === "transcript_snapshot_end") {
      const buffer = this.historySnapshotBuffers.get(sessionId);
      if (!buffer) return;
      this.historySnapshotBuffers.delete(sessionId);
      const turns = this.mergePendingHistoryPrompts(sessionId, buffer.turns);
      this.historyRevisions.set(sessionId, Number(message.revision || buffer.revision || 0));
      this.applyHistoryWindow(sessionId, turns, { before: buffer.before, hasMore: buffer.hasMore },
        { resetOlder: this.historyStreamFresh && this.historyManualRefreshSessionId !== sessionId,
          preserveScroll: this.historyLoaded && this.historyTurns.length > 0 });
      if (this.historyManualRefreshSessionId === sessionId) {
        this.historyManualRefreshSessionId = "";
        this.$("status-name").textContent = "transcript refreshed";
      }
      return;
    }
    if (type === "transcript_snapshot") {
      const turns = this.mergePendingHistoryPrompts(sessionId, Array.isArray(message.turns) ? message.turns : []);
      this.historyRevisions.set(sessionId, Number(message.revision || 0));
      this.applyHistoryWindow(sessionId, turns, { before: message.before, hasMore: !!message.has_more },
        { resetOlder: this.historyStreamFresh && this.historyManualRefreshSessionId !== sessionId,
          preserveScroll: this.historyLoaded && this.historyTurns.length > 0 });
      if (this.historyManualRefreshSessionId === sessionId) {
        this.historyManualRefreshSessionId = "";
        this.$("status-name").textContent = "transcript refreshed";
      }
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
  },


  renderHistorySnapshotProgress(sessionId, buffer) {
    if (!buffer.latestFirst || !buffer.turns.length || sessionId !== this.activeId || !this.historyOpen) return;
    if (!buffer.rendered && this.historyStreamFresh && this.historyManualRefreshSessionId !== sessionId) {
      this.historyOlderTurnsBySession.set(sessionId, []);
    }
    this.historyLiveTurnsBySession.set(sessionId, buffer.turns);
    this.historyBeforeBySession.set(sessionId, buffer.before);
    this.historyHasMoreBySession.set(sessionId, buffer.hasMore);
    const combined = this.combineHistoryWindow(sessionId, buffer.turns);
    this.applyHistoryTurns(sessionId, combined, {
      preserveScroll: buffer.rendered || (this.historyLoaded && this.historyTurns.length > 0),
      followLatest: !buffer.rendered,
    });
    buffer.rendered = true;
  },


  combineHistoryWindow(sessionId, liveTurns) {
    const older = this.historyOlderTurnsBySession.get(sessionId) || [];
    return older.concat(liveTurns);
  },


  cancelHistoryBackgroundLoad() {
    clearTimeout(this.historyBackgroundLoadTimer);
    this.historyBackgroundLoadTimer = 0;
    this.historyBackgroundLoadSessionId = "";
  },


  cancelFilteredHistoryContinuation() {
    clearTimeout(this.historyFilteredLoadTimer);
    this.historyFilteredLoadTimer = 0;
  },


  historyFiltersActive() {
    return Object.values(this.historyFilters).some(Boolean);
  },


  historyBodyNearTop(body = this.$("history-body")) {
    if (!body) return false;
    const viewportFactor = this.usesLightweightTranscriptTransport() ? 1.5 : 0.3;
    return body.scrollTop <= Math.max(160, Math.round(body.clientHeight * viewportFactor));
  },


  loadOlderHistoryWhenNearTop() {
    if (!this.historyOpen || this.activeFileKey !== null || !this.historyBodyNearTop()) return;
    void this.loadOlderHistory();
  },


  observeHistoryTopForPaging() {
    const body = this.$("history-body");
    if (!body || typeof IntersectionObserver !== "function") return;
    if (!this.historyTopLoadObserver) {
      this.historyTopLoadObserver = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) this.loadOlderHistoryWhenNearTop();
      }, { root: body, rootMargin: "240px 0px 0px", threshold: 0 });
    }
    this.historyTopLoadObserver.disconnect();
    if (!this.historyOpen || this.activeFileKey !== null || !this.historyHasMoreBySession.get(this.activeId)) return;
    const firstTurn = body.firstElementChild;
    if (firstTurn) this.historyTopLoadObserver.observe(firstTurn);
  },


  scheduleFilteredHistoryContinuation(sessionId = this.activeId, delay = 80) {
    this.cancelFilteredHistoryContinuation();
    if (!sessionId || sessionId !== this.activeId || !this.historyOpen || this.activeFileKey !== null ||
        !this.historyFiltersActive() || !this.historyHasMoreBySession.get(sessionId)) return;
    this.historyFilteredLoadTimer = window.setTimeout(() => {
      this.historyFilteredLoadTimer = 0;
      if (sessionId !== this.activeId || !this.historyOpen || this.activeFileKey !== null ||
          !this.historyHasMoreBySession.get(sessionId)) return;
      const body = this.$("history-body");
      if (body.scrollTop >= 80 && body.scrollHeight > body.clientHeight + 4) return;
      void this.loadOlderHistory({ sessionId, limit: HISTORY_BACKGROUND_PAGE_TURNS });
    }, delay);
  },


  scheduleHistoryBackgroundLoad(sessionId, delay = HISTORY_BACKGROUND_LOAD_DELAY_MS) {
    this.cancelHistoryBackgroundLoad();
    if (this.usesLightweightTranscriptTransport()) return;
    if (!sessionId || sessionId !== this.activeId || !this.historyOpen || this.activeFileKey !== null ||
        !this.historyHasMoreBySession.get(sessionId)) return;
    const loadedTurns = this.historyTurnsBySession.get(sessionId) || [];
    if (loadedTurns.length >= HISTORY_BACKGROUND_TARGET_TURNS) return;
    this.historyBackgroundLoadSessionId = sessionId;
    this.historyBackgroundLoadTimer = window.setTimeout(() => void this.continueHistoryBackgroundLoad(sessionId), delay);
  },


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
  },


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
  },


  async loadOlderHistory(options = {}) {
    if (this.historyOlderLoadBusy || !this.historyOpen || !this.activeId || this.activeFileKey !== null) return false;
    const sessionId = String(options.sessionId || this.activeId);
    if (sessionId !== this.activeId) return false;
    if (!this.historyHasMoreBySession.get(sessionId)) return false;
    const before = this.historyBeforeBySession.get(sessionId);
    if (before == null) return false;
    this.historyOlderLoadBusy = true;
    try {
      const defaultLimit = this.usesLightweightTranscriptTransport() ? 40 : HISTORY_BACKGROUND_PAGE_TURNS;
      const requestedLimit = Math.max(20, Math.min(HISTORY_BACKGROUND_PAGE_TURNS, Number(options.limit) || defaultLimit));
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
      this.applyHistoryTurns(sessionId, combined, { preserveScroll: true });
      return olderPage.length > 0 || nextBefore !== before;
    } catch (error) {
      console.warn("unable to load older transcript history", error);
      return false;
    } finally {
      this.historyOlderLoadBusy = false;
    }
  },


  mergePendingHistoryPrompts(sessionId, turns) {
    const pending = this.persistedHistoryPendingPrompts(sessionId);
    if (!pending.length) return turns;
    const merged = turns.slice();
    const remaining = [];
    for (const item of pending) {
      const pendingId = item.pending_id || `${Date.now()}-${this.historyPendingPromptSequence++}`;
      item.pending_id = pendingId;
      const authoritativeCount = merged.filter((turn) => turn.role === "user" && !turn.pending_id &&
        this.historyAuthoritativePromptMatchesPending(turn.text, item.text)).length;
      const timestampConfirmed = merged.some((turn) => turn.role === "user" && !turn.pending_id &&
        this.historyAuthoritativePromptMatchesPending(turn.text, item.text) &&
        this.historyTurnTimestampMillis(turn) >= item.timestamp - 5000);
      const optimisticIndex = merged.findIndex((turn) => turn.pending_id === pendingId);
      if (timestampConfirmed || authoritativeCount > item.beforeCount) {
        if (optimisticIndex >= 0) merged.splice(optimisticIndex, 1);
        continue;
      }
      const optimisticTurn = { role: "user", text: item.text, pending_id: pendingId,
        pending_delivery_state: item.delivery_state || "awaiting_transcript", timestamp: item.timestamp || Date.now() };
      if (optimisticIndex < 0) merged.push(optimisticTurn);
      else merged[optimisticIndex] = { ...merged[optimisticIndex], ...optimisticTurn };
      remaining.push(item);
    }
    if (remaining.length) this.historyPendingPrompts.set(sessionId, remaining);
    else this.historyPendingPrompts.delete(sessionId);
    this.persistHistoryPendingPrompts(sessionId, remaining);
    return merged;
  },


  historyPendingPromptStorageKey(sessionId) {
    return `termdeck.transcript-pending-prompts.v1.${encodeURIComponent(this.projectStateKey())}.${encodeURIComponent(sessionId)}`;
  },


  persistedHistoryPendingPrompts(sessionId) {
    if (this.historyPendingPrompts.has(sessionId)) return this.historyPendingPrompts.get(sessionId);
    let pending = [];
    try {
      const parsed = JSON.parse(localStorage.getItem(this.historyPendingPromptStorageKey(sessionId)) || "[]");
      if (Array.isArray(parsed)) {
        pending = parsed.slice(-25).map((item) => ({
          text: String(item?.text || "").slice(0, 20000),
          beforeCount: Math.max(0, Number(item?.beforeCount) || 0),
          pending_id: String(item?.pending_id || `${Date.now()}-${this.historyPendingPromptSequence++}`),
          timestamp: Number(item?.timestamp) || Date.now(),
          delivery_state: ["sending", "awaiting_transcript", "unconfirmed"].includes(item?.delivery_state)
            ? item.delivery_state : "awaiting_transcript",
        })).filter((item) => item.text.trim());
      }
    } catch (_error) {
      pending = [];
    }
    if (pending.length) this.historyPendingPrompts.set(sessionId, pending);
    return pending;
  },


  persistHistoryPendingPrompts(sessionId, pending = this.historyPendingPrompts.get(sessionId) || []) {
    try {
      const key = this.historyPendingPromptStorageKey(sessionId);
      if (pending.length) localStorage.setItem(key, JSON.stringify(pending.slice(-25)));
      else localStorage.removeItem(key);
    } catch (_error) {
    }
  },


  stageHistoryPendingPrompt(view, text) {
    const sessionId = view.sessionId;
    const promptText = String(text);
    const pending = this.persistedHistoryPendingPrompts(sessionId);
    const live = this.historyLiveTurnsBySession.get(sessionId) || this.historyTurnsBySession.get(sessionId) || [];
    const authoritativeCount = live.filter((turn) => turn.role === "user" && !turn.pending_id &&
      this.historyAuthoritativePromptMatchesPending(turn.text, promptText)).length;
    const comparisonText = this.historyPromptComparisonText(promptText);
    const beforeCount = authoritativeCount + pending.filter((item) =>
      this.historyPromptComparisonText(item.text) === comparisonText).length;
    const pendingId = `${Date.now()}-${this.historyPendingPromptSequence++}`;
    pending.push({ text: promptText, beforeCount, pending_id: pendingId, timestamp: Date.now(), delivery_state: "sending" });
    this.historyPendingPrompts.set(sessionId, pending);
    this.persistHistoryPendingPrompts(sessionId, pending);
    this.renderHistoryPendingPromptState(sessionId, live);
    return pendingId;
  },


  setHistoryPendingPromptDeliveryState(sessionId, pendingId, deliveryState) {
    const pending = this.persistedHistoryPendingPrompts(sessionId);
    const item = pending.find((candidate) => candidate.pending_id === pendingId);
    if (!item) return;
    item.delivery_state = deliveryState;
    this.historyPendingPrompts.set(sessionId, pending);
    this.persistHistoryPendingPrompts(sessionId, pending);
    const live = this.historyLiveTurnsBySession.get(sessionId) || this.historyTurnsBySession.get(sessionId) || [];
    this.renderHistoryPendingPromptState(sessionId, live);
  },


  renderHistoryPendingPromptState(sessionId, live) {
    if (!this.historyOpen || this.activeId !== sessionId) return;
    const optimisticLive = this.mergePendingHistoryPrompts(sessionId, live);
    this.historyLiveTurnsBySession.set(sessionId, optimisticLive);
    this.applyHistoryTurns(sessionId, this.combineHistoryWindow(sessionId, optimisticLive),
      { preserveScroll: true, followLatest: true });
  },


  historyPromptComparisonText(text) {
    return String(text || "").replace(/^\x15+/, "").replace(/\r\n?/g, "\n").trim();
  },


  historyAuthoritativePromptMatchesPending(authoritativeText, pendingText) {
    const authoritative = this.historyPromptComparisonText(authoritativeText);
    const pending = this.historyPromptComparisonText(pendingText);
    if (!pending) return false;
    return authoritative === pending || authoritative.startsWith(`${pending}\n`) ||
      authoritative.endsWith(`\n${pending}`) || authoritative.includes(`\n${pending}\n`);
  },


  historyTurnTimestampMillis(turn) {
    if (typeof turn?.timestamp === "number") return turn.timestamp > 100000000000 ? turn.timestamp : turn.timestamp * 1000;
    const parsed = Date.parse(String(turn?.timestamp || ""));
    return Number.isFinite(parsed) ? parsed : 0;
  },


  scheduleHistoryPendingPromptReconciliation(sessionId) {
    if (!this.persistedHistoryPendingPrompts(sessionId).length) return;
    if (!this.historyPendingPromptReconcileTimers) this.historyPendingPromptReconcileTimers = new Map();
    if (this.historyPendingPromptReconcileTimers.has(sessionId)) return;
    const timer = window.setTimeout(() => {
      this.historyPendingPromptReconcileTimers.delete(sessionId);
      void this.reconcileHistoryPendingPrompts(sessionId);
    }, 1200);
    this.historyPendingPromptReconcileTimers.set(sessionId, timer);
  },


  async reconcileHistoryPendingPrompts(sessionId) {
    const pending = this.persistedHistoryPendingPrompts(sessionId);
    if (!pending.length) return;
    let turns;
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/history`);
      if (!response.ok) return;
      turns = await response.json();
    } catch (_error) {
      return;
    }
    if (!Array.isArray(turns)) return;
    const remaining = pending.filter((item) => !turns.some((turn) => turn.role === "user" &&
      this.historyAuthoritativePromptMatchesPending(turn.text, item.text) &&
      this.historyTurnTimestampMillis(turn) >= item.timestamp - 5000));
    if (remaining.length === pending.length) return;
    if (remaining.length) this.historyPendingPrompts.set(sessionId, remaining);
    else this.historyPendingPrompts.delete(sessionId);
    this.persistHistoryPendingPrompts(sessionId, remaining);
    if (!this.historyOpen || this.activeId !== sessionId) return;
    const remainingIds = new Set(remaining.map((item) => item.pending_id));
    const live = (this.historyLiveTurnsBySession.get(sessionId) || []).filter((turn) =>
      !turn.pending_id || remainingIds.has(turn.pending_id));
    this.historyLiveTurnsBySession.set(sessionId, live);
    this.applyHistoryTurns(sessionId, this.combineHistoryWindow(sessionId, live),
      { preserveScroll: true, followLatest: true, forceRender: true });
  },


  sendHistoryPrompt(options = {}) {
    if (!this.historyOpen || this.activeFileKey !== null || !this.activeId) return;
    this.closeHistorySlashMenu();
    const prompt = this.$("history-prompt");
    const rawText = prompt.value;
    const text = rawText;
    if (!text.trim()) return;
    const view = this.sessionInteractionState(this.activeId);
    if (!view) return;
    view.promptQueueHold = false;
    if (options.queue) {
      view.promptQueue.push({ text });
      this.persistMarkdownPromptQueue(view);
      this.renderHistoryQueue(view);
      this.recordPromptHistory(view.sessionId, text);
      this.persistMarkdownPromptDraft(view, "", { immediate: true });
      this.showPromptDraft(view);
      if (this.touchMobileLayoutEnabled()) prompt.blur();
      else prompt.focus();
      this.$("status-name").textContent = "prompt queued";
      this.dispatchNextMarkdownPrompt(view);
      return;
    }
    void this.submitHistoryPromptViaApi(view, text);
  },


  async submitHistoryPromptViaApi(view, text, options = {}) {
    if (!view || view.closed || !String(text || "").trim()) return false;
    if (view.promptApiSubmitting) {
      this.$("status-name").textContent = "prompt is already sending";
      return false;
    }
    const pendingId = this.stageHistoryPendingPrompt(view, text);
    view.promptApiSubmitting = true;
    this.$("status-name").textContent = "sending prompt…";
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(view.sessionId)}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: String(text), bracketed: true, queue: false,
          automatically_queue_when_busy: false }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const failure = await response.json().catch(() => ({}));
        throw new Error(String(failure.detail || `prompt submission failed (${response.status})`));
      }
      const result = await response.json();
      this.setHistoryPendingPromptDeliveryState(view.sessionId, pendingId, "awaiting_transcript");
      const submitted = this.submitHistoryPromptText(view, text, { ...options, pendingId });
      if (result.session) this.applySessionStatus({ ...result.session, session_id: view.sessionId });
      return submitted;
    } catch (error) {
      this.setHistoryPendingPromptDeliveryState(view.sessionId, pendingId, "unconfirmed");
      this.$("status-name").textContent = error?.name === "AbortError" ? "prompt send timed out · message kept" :
        error instanceof Error ? error.message : "unable to send prompt";
      return false;
    } finally {
      clearTimeout(timeout);
      view.promptApiSubmitting = false;
    }
  },


  submitHistoryPromptText(view, text, options = {}) {
    if (!view || !String(text || "").trim()) return false;
    const promptText = String(text);
    const prompt = this.$("history-prompt");
    view.promptSubmitting = true;
    view.promptSubmitEntered = false;
    view.promptEditing = false;
    view.promptSubmitVersion = view.promptEditVersion;
    const sessionId = view.sessionId;
    if (view.term) this.deferTerminalReflowAfterPrompt(view);
    this.historyPendingProcessing.set(sessionId, Date.now());
    this.updateHistoryThinkingIndicator();
    if (view.term) {
      view.tallFollowing = true;
      this.scrollTallContainerToCursor(view);
    }
    if (!options.fromQueue) this.recordPromptHistory(sessionId, promptText);
    if (!options.fromQueue) this.persistMarkdownPromptDraft(view, "", { immediate: true });
    if (this.historyOpen && this.activeId === sessionId) {
      this.showPromptDraft(view);
      this.scrollHistoryToBottom();
      if (this.touchMobileLayoutEnabled()) prompt.blur();
      else prompt.focus();
    }
    clearTimeout(view.promptSubmitTimer);
    view.promptSubmitTimer = setTimeout(() => {
      view.promptSubmitting = false;
      view.promptSubmitEntered = false;
    }, 1500);
    if (view.term) {
      view.keepBottom = true;
      view.pinBottomUntil = Date.now() + 5000;
    }
    this.$("status-name").textContent = options.fromQueue
      ? "queued prompt sent · waiting for transcript" : "prompt sent · waiting for transcript";
    return true;
  },


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
  },


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
  },


  togglePromptHistory() {
    const panel = this.$("history-prompt-history");
    const button = this.$("history-prompt-history-btn");
    if (!panel || !button || !this.historyOpen || this.activeFileKey !== null) return;
    const opening = panel.classList.contains("hidden");
    if (opening) {
      this.closeHistorySendMenu();
      this.renderPromptHistory();
    }
    panel.classList.toggle("hidden", !opening);
    button.classList.toggle("on", opening);
    button.setAttribute("aria-expanded", String(opening));
  },


  closePromptHistory() {
    const panel = this.$("history-prompt-history");
    const button = this.$("history-prompt-history-btn");
    if (!panel || !button) return;
    panel.classList.add("hidden");
    button.classList.remove("on");
    button.setAttribute("aria-expanded", "false");
  },


  restorePromptHistoryEntry(text) {
    const view = this.sessionInteractionState(this.activeId, false);
    const prompt = this.$("history-prompt");
    if (!view || !prompt || !this.historyOpen || this.activeFileKey !== null) return;
    prompt.value = text;
    prompt.dispatchEvent(new Event("input", { bubbles: true }));
    this.closePromptHistory();
    prompt.focus();
    prompt.setSelectionRange(prompt.value.length, prompt.value.length);
  },


  resizeHistoryPrompt() {
    const prompt = this.$("history-prompt");
    if (!prompt) return;
    const followCaret = prompt.selectionEnd === prompt.value.length;
    prompt.style.overflowY = "hidden";
    prompt.style.height = "auto";
    prompt.style.height = `${prompt.scrollHeight + 2}px`;
    prompt.style.overflowY = prompt.scrollHeight > prompt.clientHeight + 1 ? "auto" : "hidden";
    if (followCaret) {
      prompt.scrollTop = prompt.scrollHeight;
      requestAnimationFrame(() => {
        if (prompt.selectionEnd === prompt.value.length) prompt.scrollTop = prompt.scrollHeight;
      });
    }
  },


  showPromptDraft(view) {
    if (!this.historyOpen || view !== this.sessionInteractionState(this.activeId, false)) return;
    const prompt = this.$("history-prompt");
    if (!prompt) return;
    prompt.value = view.markdownPromptDraft || "";
    this.updateHistorySendMenu();
    this.resizeHistoryPrompt();
    requestAnimationFrame(() => {
      if (prompt.value !== (view.markdownPromptDraft || "")) return;
      this.resizeHistoryPrompt();
      requestAnimationFrame(() => {
        if (prompt.value === (view.markdownPromptDraft || "")) this.resizeHistoryPrompt();
      });
    });
  },


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
  },


  writePromptDraftToTerminal(view, text) {
    this.sendInput(view, "\x15");
    if (text) this.sendInput(view, text.includes("\n") ? this.terminalPastePayload(view, text) : text);
  },


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
  },


  schedulePromptDraftSync(view, text) {
    view.pendingDraftSync = text;
    clearTimeout(view.promptDraftSyncDebounceTimer);
    view.promptDraftSyncDebounceTimer = setTimeout(() => {
      view.promptDraftSyncDebounceTimer = 0;
      this.sendPromptDraftSync(view, view.promptDraft);
    }, PROMPT_DRAFT_SYNC_PASTE_DELAY_MS);
  },


  deferTerminalReflowAfterPrompt(view) {
    if (!view?.term || !this.agentBehavior(this.session(view.sessionId)?.agent_kind)?.deferReflowAfterPrompt) return;
    view.promptSubmissionReflowGuardUntil = Date.now() + CODEX_PROMPT_REFLOW_GUARD_MS;
    clearTimeout(view.promptSubmissionReflowGuardTimer);
    view.promptSubmissionReflowGuardTimer = setTimeout(() => {
      view.promptSubmissionReflowGuardTimer = 0;
      if (!view.closed && view.container.classList.contains("visible") && this.activeId === view.sessionId) {
        this.scheduleTerminalTailRepair(view);
      }
    }, CODEX_PROMPT_REFLOW_GUARD_MS + 40);
  },


  shouldDeferPromptReflowFit(view) {
    if (!view) return false;
    return view.promptSubmissionReflowGuardUntil > Date.now();
  },


  isPastedTerminalInput(data) {
    const input = String(data || "");
    return input.includes("\x1b[200~") || input.includes("\x1b[201~") || input.length >= 128;
  },


  terminalPastePayload(view, text) {
    const agentTerminal = !!this.agentSpec(this.session(view.sessionId)?.agent_kind)?.is_agent;
    const bracketed = agentTerminal || !view.term.modes || view.term.modes.bracketedPasteMode !== false;
    return bracketed ? `\x1b[200~${text}\x1b[201~` : text;
  },


  flushPromptSync(view) {
    if (!view.ws || view.ws.readyState !== WebSocket.OPEN || view.promptSubmitting) return;
    if (view.pendingTerminalDraft !== null) {
      const text = view.pendingTerminalDraft;
      view.pendingTerminalDraft = null;
      this.writePromptDraftToTerminal(view, text);
    }
    if (view.pendingDraftSync !== null) this.sendPromptDraftSync(view, view.pendingDraftSync);
  },


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
        view.pendingAgentPasteExpectedTitle = "";
        view.pendingAgentPasteRequireComposer = false;
        this.$("status-name").textContent = "selected text could not be pasted into the agent";
        return;
      }
      if (view.awaitingSnapshot || view.replaying || !view.ws || view.ws.readyState !== WebSocket.OPEN ||
          Date.now() < (view.pendingAgentPasteReadyAt || 0) || !this.agentPasteDestinationReady(view)) {
        this.schedulePendingAgentPaste(view, AGENT_PASTE_RETRY_DELAY_MS);
        return;
      }
      this.flushPendingAgentPaste(view);
    }, wait);
  },


  agentPasteDestinationReady(view) {
    if (!view.pendingAgentPasteRequireComposer) return true;
    if (view.lastTerminalOutputAt && Date.now() - view.lastTerminalOutputAt < AGENT_PASTE_OUTPUT_QUIET_MS) return false;
    const session = this.session(view.sessionId);
    const expectedTitle = String(view.pendingAgentPasteExpectedTitle || "").trim();
    if (expectedTitle) {
      const cliTitle = this.stripTitleStatusPrefixes(session?.cli_title || "");
      if (cliTitle !== expectedTitle) return false;
    }
    const buffer = view.term?.buffer?.active;
    if (!buffer) return false;
    const baseY = Number(buffer.baseY || 0);
    const cursorRow = baseY + Number(buffer.cursorY || 0);
    const firstRow = Math.max(baseY, cursorRow - 8);
    const lastRow = Math.min(buffer.length - 1, cursorRow + 8);
    const promptMarker = this.agentSpec(session?.agent_kind)?.prompt_marker || "";
    if (!promptMarker) return true;
    for (let row = firstRow; row <= lastRow; row += 1) {
      if ((buffer.getLine(row)?.translateToString(true) || "").trimStart().startsWith(promptMarker)) return true;
    }
    return false;
  },


  queuePendingAgentPaste(view, text, options = {}) {
    const value = this.normalizeSelectionText(text);
    if (!view || view.closed || !value) return false;
    view.pendingAgentPaste = value;
    view.pendingAgentPasteStartedAt = Date.now();
    view.pendingAgentPasteReadyAt = Date.now() + DEFAULT_AGENT_PASTE_DELAY_MS;
    view.pendingAgentPasteExpectedTitle = String(options.expectedTitle || "").trim();
    view.pendingAgentPasteRequireComposer = options.requireComposer !== false;
    this.schedulePendingAgentPaste(view);
    return true;
  },


  flushPendingAgentPaste(view) {
    if (!view || view.closed || !view.pendingAgentPaste || view.awaitingSnapshot || view.replaying ||
        !view.ws || view.ws.readyState !== WebSocket.OPEN || Date.now() < (view.pendingAgentPasteReadyAt || 0) ||
        !this.agentPasteDestinationReady(view)) return false;
    const text = view.pendingAgentPaste;
    view.pendingAgentPaste = "";
    view.pendingAgentPasteStartedAt = 0;
    view.pendingAgentPasteReadyAt = 0;
    view.pendingAgentPasteExpectedTitle = "";
    view.pendingAgentPasteRequireComposer = false;
    if (this.activeId === view.sessionId && this.activeFileKey === null && !this.historyOpen) view.term.focus();
    this.sendTrackedInput(view, this.terminalPastePayload(view, text));
    this.$("status-name").textContent = "selected text pasted into " +
      this.agentLabel(this.session(view.sessionId)?.agent_kind, "agent");
    return true;
  },


  sendTrackedInput(view, data) {
    const pastedInput = this.isPastedTerminalInput(data);
    const session = this.session(view.sessionId);
    const submittedText = (data === "\r" || data === "\n") && session && this.agentSpec(session.agent_kind)?.is_agent
      ? view.promptDraft.trim() : "";
    const queueText = data === "\t" && this.agentSpec(session?.agent_kind)?.has_prompt_queue && view.promptDraft.trim()
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
    if (data === "\r" || data === "\n") {
      this.deferTerminalReflowAfterPrompt(view);
    }
    this.sendInput(view, data);
    if (submittedText && view.ws && view.ws.readyState === WebSocket.OPEN) this.recordPromptHistory(view.sessionId, submittedText);
    if (queueText) {
      view.promptDraft = "";
      view.promptEditing = false;
      view.pendingTerminalDraft = null;
      view.pendingDraftSync = null;
      if (view.ws && view.ws.readyState === WebSocket.OPEN) this.recordPromptHistory(view.sessionId, queueText);
      this.sendPromptDraftSync(view, "");
      this.showPromptDraft(view);
    }
  },


  normalizeMobileTerminalInput(view, data) {
    const input = String(data || "");
    if (!this.touchMobileLayoutEnabled() || view.promptPaste || /[\x00-\x1f\x7f\x1b]/.test(input)) return input;
    const imeDelta = this.consumeMobileTerminalImeDelta(view);
    if (imeDelta !== null) return imeDelta;
    if (input.length <= 1) return input;
    const draft = String(view.promptDraft || "");
    if (draft.length < 8) return input;
    if (input.startsWith(draft)) return input.slice(draft.length);
    if (draft.startsWith(input) && input.length >= Math.floor(draft.length * 0.8)) return "";
    return input;
  },


  consumeMobileTerminalImeDelta(view) {
    const baseline = view.mobileImeTextareaBaseline;
    if (baseline == null) return null;
    view.mobileImeTextareaBaseline = null;
    if (Date.now() > Number(view.mobileImeTextareaDeadline || 0)) return null;
    const textarea = view.term?.textarea || view.container?.querySelector(".xterm-helper-textarea");
    const current = String(textarea?.value || "");
    if (current === baseline) return null;
    let prefixLength = 0;
    while (prefixLength < baseline.length && prefixLength < current.length &&
           baseline[prefixLength] === current[prefixLength]) prefixLength += 1;
    let suffixLength = 0;
    while (suffixLength < baseline.length - prefixLength && suffixLength < current.length - prefixLength &&
           baseline[baseline.length - suffixLength - 1] === current[current.length - suffixLength - 1]) suffixLength += 1;
    const inserted = current.slice(prefixLength, current.length - suffixLength);
    if (inserted) return inserted;
    return "\x7f".repeat(Math.max(0, baseline.length - prefixLength - suffixLength));
  },


  installMobileTerminalTextareaStabilizer(view) {
    if (!this.touchMobileLayoutEnabled() || view.term.options.screenReaderMode) return;
    const textarea = view.term.textarea || view.container.querySelector(".xterm-helper-textarea");
    if (!textarea) return;
    let composing = false;
    const clearTextarea = () => {
      view.mobileTextareaCleanupTimer = 0;
      if (composing || view.closed) return;
      textarea.value = "";
      textarea.setSelectionRange(0, 0);
    };
    const scheduleTextareaClear = () => {
      if (composing || view.mobileTextareaCleanupTimer) return;
      view.mobileTextareaCleanupTimer = window.setTimeout(clearTextarea, 40);
    };
    const handleKeyDown = (event) => {
      if ((event.keyCode || event.which) !== 229 || event.isComposing || composing) return;
      view.mobileImeTextareaBaseline = textarea.value;
      view.mobileImeTextareaDeadline = Date.now() + 250;
    };
    const handleCompositionStart = () => {
      composing = true;
      clearTimeout(view.mobileTextareaCleanupTimer);
      view.mobileTextareaCleanupTimer = 0;
    };
    const handleCompositionEnd = () => {
      composing = false;
      scheduleTextareaClear();
    };
    const handleInput = (event) => {
      if (!event.isComposing) scheduleTextareaClear();
    };
    textarea.addEventListener("keydown", handleKeyDown, true);
    textarea.addEventListener("compositionstart", handleCompositionStart, true);
    textarea.addEventListener("compositionend", handleCompositionEnd, true);
    textarea.addEventListener("input", handleInput, true);
    view.disposeMobileTextareaStabilizer = () => {
      textarea.removeEventListener("keydown", handleKeyDown, true);
      textarea.removeEventListener("compositionstart", handleCompositionStart, true);
      textarea.removeEventListener("compositionend", handleCompositionEnd, true);
      textarea.removeEventListener("input", handleInput, true);
      clearTimeout(view.mobileTextareaCleanupTimer);
    };
  },


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
  },


  historyTurnKey(turn) {
    return JSON.stringify([turn.role, turn.kind, turn.title, turn.text, turn.timestamp, turn.diff, turn.diff_files,
      turn.plan, turn.items, turn.folded_responses, turn.pending_id, turn.pending_delivery_state]);
  },


  historyFilterStorageKey() {
    return `termdeck.history-filters.v1.${encodeURIComponent(this.projectSlug || "__all__")}`;
  },


  ensureHistoryFiltersForProject() {
    const storageKey = this.historyFilterStorageKey();
    if (storageKey === this.historyFilterProjectKey) return;
    this.historyFilterProjectKey = storageKey;
    let stored = {};
    try {
      stored = JSON.parse(window.localStorage.getItem(storageKey) || "{}");
    } catch (_error) {
      stored = {};
    }
    this.historyFilters = {
      hidePrompts: stored.hidePrompts === true,
      hideThinking: stored.hideThinking === true,
      codeOnly: stored.codeOnly === true,
      foldRepetitive: stored.foldRepetitive === true,
    };
    this.updateHistoryFilterControls();
  },


  saveHistoryFilters() {
    try {
      window.localStorage.setItem(this.historyFilterStorageKey(), JSON.stringify(this.historyFilters));
    } catch (_error) {
    }
  },


  initHistoryFilters() {
    const toggles = [this.$("history-filter-toggle"), this.$("mobile-history-filter-toggle")].filter(Boolean);
    const menu = this.$("history-filter-menu");
    if (!toggles.length || !menu) return;
    this.ensureHistoryFiltersForProject();
    for (const toggle of toggles) {
      toggle.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        const open = menu.classList.contains("hidden");
        menu.classList.toggle("hidden", !open);
        for (const item of toggles) item.setAttribute("aria-expanded", String(open));
      };
    }
    const bindings = [
      ["history-filter-hide-prompts", "hidePrompts"],
      ["history-filter-hide-thinking", "hideThinking"],
      ["history-filter-code-only", "codeOnly"],
      ["history-filter-fold-repetitive", "foldRepetitive"],
    ];
    for (const [id, key] of bindings) {
      this.$(id).onchange = (event) => {
        this.historyFilters = { ...this.historyFilters, [key]: event.currentTarget.checked };
        this.saveHistoryFilters();
        this.updateHistoryFilterControls();
        this.refreshFilteredHistoryView();
      };
    }
    this.$("history-filter-collapse-edits").onchange = (event) => {
      if (event.currentTarget.checked !== this.historyEditsCollapsed) this.toggleHistoryEdits();
    };
    document.addEventListener("pointerdown", (event) => {
      if (menu.classList.contains("hidden") || menu.contains(event.target) || toggles.some((toggle) => toggle.contains(event.target))) return;
      this.closeHistoryFilterMenu();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || menu.classList.contains("hidden")) return;
      event.preventDefault();
      this.closeHistoryFilterMenu();
      this.$("history-prompt")?.focus();
    }, true);
  },


  closeHistoryFilterMenu() {
    this.$("history-filter-menu")?.classList.add("hidden");
    this.$("history-filter-toggle")?.setAttribute("aria-expanded", "false");
    this.$("mobile-history-filter-toggle")?.setAttribute("aria-expanded", "false");
  },


  updateHistoryFilterControls() {
    const mapping = {
      "history-filter-hide-prompts": this.historyFilters.hidePrompts,
      "history-filter-hide-thinking": this.historyFilters.hideThinking,
      "history-filter-code-only": this.historyFilters.codeOnly,
      "history-filter-fold-repetitive": this.historyFilters.foldRepetitive,
    };
    for (const [id, checked] of Object.entries(mapping)) {
      const input = this.$(id);
      if (input) input.checked = checked;
    }
    const count = Object.values(this.historyFilters).filter(Boolean).length;
    for (const toggle of [this.$("history-filter-toggle"), this.$("mobile-history-filter-toggle")].filter(Boolean)) {
      toggle.classList.toggle("on", count > 0);
      toggle.title = count ? `Filter transcript · ${count} active` : "Filter transcript";
    }
  },


  refreshFilteredHistoryView() {
    const sessionId = this.activeId;
    const turns = this.historyTurnsBySession.get(sessionId) || this.historyTurns;
    if (this.historyOpen && sessionId) {
      this.historyFingerprint = "";
      this.applyHistoryTurns(sessionId, turns, { preserveScroll: true, forceRender: true });
      requestAnimationFrame(() => this.scheduleFilteredHistoryContinuation(sessionId));
    }
    if (this.conversationOutlineOpen && sessionId) this.renderConversationOutline(turns, { preserveScroll: true });
  },


  historyResponseShingles(text) {
    const words = String(text || "").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/).filter(Boolean);
    if (words.length < 3) return new Set(words);
    return new Set(words.slice(0, -2).map((word, index) => `${word} ${words[index + 1]} ${words[index + 2]}`));
  },


  historyResponseSimilarity(left, right) {
    const leftText = String(left || "").replace(/\s+/g, " ").trim();
    const rightText = String(right || "").replace(/\s+/g, " ").trim();
    if (!leftText || !rightText) return 0;
    if (leftText === rightText) return 1;
    if (Math.min(leftText.length, rightText.length) / Math.max(leftText.length, rightText.length) < 0.8) return 0;
    const leftShingles = this.historyResponseShingles(leftText);
    const rightShingles = this.historyResponseShingles(rightText);
    if (!leftShingles.size || !rightShingles.size) return 0;
    let common = 0;
    for (const shingle of leftShingles) if (rightShingles.has(shingle)) common += 1;
    return (2 * common) / (leftShingles.size + rightShingles.size);
  },


  foldRepetitiveHistoryResponses(turns) {
    const folded = [];
    for (const turn of turns) {
      const previous = folded[folded.length - 1];
      const previousResponses = Array.isArray(previous?.folded_responses) ? previous.folded_responses : [previous];
      const previousResponse = previousResponses[previousResponses.length - 1];
      if (turn.role === "assistant" && previousResponse?.role === "assistant" &&
          this.historyResponseSimilarity(previousResponse.text, turn.text) >= 0.8) {
        folded[folded.length - 1] = { ...turn, folded_responses: previousResponses.concat(turn) };
      } else {
        folded.push(turn);
      }
    }
    return folded;
  },


  filteredHistoryTurns(turns) {
    this.ensureHistoryFiltersForProject();
    let filtered = Array.isArray(turns) ? turns : [];
    if (this.historyFilters.codeOnly) filtered = filtered.filter((turn) => turn.kind === "edit");
    if (this.historyFilters.hidePrompts) filtered = filtered.filter((turn) => turn.role !== "user");
    if (this.historyFilters.hideThinking) filtered = filtered.filter((turn) => turn.kind !== "thinking");
    return this.historyFilters.foldRepetitive ? this.foldRepetitiveHistoryResponses(filtered) : filtered;
  },


  // Identity for re-finding a rendered element across a full rebuild. Purely DOM-side:
  // after paged history loads, body.children and historyTurns segment differently mid-array,
  // so index-based correlation attributes state to the wrong turns. Digits are collapsed
  // ("Thinking · 12 operations" grows while streaming) and volatile classes dropped;
  // same-key elements align by document order.
  historyElementPreserveKey(element) {
    const classes = [...(element.classList || [])].filter((name) => name !== "active").join(" ");
    const label = element.matches?.("details")
      ? element.querySelector(":scope > summary")?.textContent || ""
      : (element.textContent || "").slice(0, 80);
    return `${classes}|${label.replace(/\d+/g, "#")}`;
  },


  toggleHistoryEdits() {
    this.historyEditsCollapsed = !this.historyEditsCollapsed;
    for (const event of this.$("history-body").querySelectorAll(".history-event.edit")) {
      event.open = !this.historyEditsCollapsed;
    }
    this.updateHistoryEditToggle();
    if (body === this.$("history-body")) this.updateActiveThinkingBlock();
  },


  updateHistoryEditToggle() {
    const button = this.$("history-edits-toggle");
    const hasEdits = !!this.$("history-body").querySelector(".history-event.edit");
    if (button) {
      button.disabled = !hasEdits;
      button.classList.toggle("on", this.historyEditsCollapsed && hasEdits);
    }
    const label = this.historyEditsCollapsed ? "Expand all code edits" : "Collapse all code edits";
    if (button) {
      button.title = label;
      button.setAttribute("aria-label", label);
      const icon = button.querySelector(".codicon");
      if (icon) icon.className = `codicon codicon-${this.historyEditsCollapsed ? "expand-all" : "collapse-all"}`;
    }
    const menuToggle = this.$("history-filter-collapse-edits");
    if (menuToggle) {
      menuToggle.checked = this.historyEditsCollapsed && hasEdits;
      menuToggle.disabled = !hasEdits;
    }
  },


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
  },


  historyDiffPath(path) {
    const value = String(path || "Changes").replaceAll("\\", "/");
    const cwd = String(this.session(this.activeId)?.cwd || "").replace(/[\\/]$/, "");
    if (cwd && (value === cwd || value.startsWith(`${cwd}/`))) return value.slice(cwd.length + 1) || value;
    return value;
  },


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
  },


  collapseHistoryThinkingEvent(event) {
    if (!event?.matches?.(".history-event.thinking")) return;
    event.open = false;
    const summary = event.querySelector("summary");
    requestAnimationFrame(() => {
      if (summary) summary.scrollIntoView({ block: "nearest" });
    });
  },


  renderHistoryTurns(turns, options = {}) {
    const body = options.target || this.$("history-body");
    const append = options.append === true;
    const expandedByKey = options.expandedByKey || null;
    for (const turn of turns) {
      if (Array.isArray(turn.folded_responses) && turn.folded_responses.length > 1) {
        const group = document.createElement("details");
        group.className = "history-repetition-group";
        group.dataset.outlineKey = this.conversationOutlineTurnKey(turn);
        const summary = document.createElement("summary");
        const count = document.createElement("span");
        count.className = "history-repetition-count";
        count.textContent = `${turn.folded_responses.length} similar responses`;
        const preview = document.createElement("span");
        preview.className = "history-repetition-preview";
        preview.textContent = String(turn.text || "").replace(/\s+/g, " ").trim();
        summary.append(count, preview);
        const items = document.createElement("div");
        items.className = "history-repetition-items";
        this.renderHistoryTurns(turn.folded_responses, { target: items });
        group.append(summary, items);
        body.appendChild(group);
        continue;
      }
      if (turn.kind === "compaction") {
        // Not a <details>: there is nothing to expand, and collapsing it away would defeat the
        // point -- the boundary needs to stay visible so turns from before and after it don't read
        // as one continuous exchange.
        const divider = document.createElement("div");
        divider.className = "history-compaction";
        const label = document.createElement("span");
        label.textContent = turn.text ? `${turn.title} · ${turn.text}` : turn.title;
        divider.appendChild(label);
        body.appendChild(divider);
        continue;
      }
      if (turn.kind && turn.kind !== "message") {
        const event = document.createElement("details");
        event.className = "history-event " + turn.kind;
        event.dataset.outlineKey = this.conversationOutlineTurnKey(turn);
        event.open = turn.kind === "edit" ? !this.historyEditsCollapsed : turn.kind === "plan" ? true : turn.expanded === true;
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
        // The element is fully built here (summary included), so its preserve key is final.
        const preservedOpen = expandedByKey?.get(this.historyElementPreserveKey(event));
        if (preservedOpen?.length) event.open = preservedOpen.shift();
        body.appendChild(event);
        continue;
      }
      const block = document.createElement("div");
      block.className = "turn " + turn.role;
      if (turn.pending_id) block.classList.add("pending-delivery");
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
      if (turn.pending_id) {
        const delivery = document.createElement("div");
        delivery.className = `history-pending-delivery ${turn.pending_delivery_state || "awaiting_transcript"}`;
        const icon = document.createElement("span");
        icon.className = `codicon ${turn.pending_delivery_state === "unconfirmed" ? "codicon-warning" : "codicon-cloud-upload"}`;
        const label = document.createElement("span");
        label.textContent = turn.pending_delivery_state === "unconfirmed"
          ? "Submission not confirmed · saved on this device" : "Submitting";
        delivery.append(icon, label);
        block.append(delivery);
      }
      body.appendChild(block);
    }
    this.updateHistoryEditToggle();
  },


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
    if (snapshot.anchorIndex >= 0 && children[snapshot.anchorIndex]) {
      // Keyed off the DOM, not the turns array: after paged loads the two segment
      // differently mid-array, and a turns-index anchor lands on the wrong element.
      snapshot.anchorKey = this.historyElementPreserveKey(children[snapshot.anchorIndex]);
      snapshot.anchorOccurrence = children.slice(0, snapshot.anchorIndex + 1)
        .filter((child) => this.historyElementPreserveKey(child) === snapshot.anchorKey).length - 1;
    }
    return snapshot;
  },


  rememberHistoryScrollPosition(sessionId) {
    const body = this.$("history-body");
    if (!sessionId || !body || !this.historyOpen || !this.historyLoaded || this.activeFileKey !== null) return;
    this.historyScrollBySession.set(sessionId, this.captureHistoryScroll(body, this.historyTurns));
  },


  restoreHistoryScroll(body, snapshot, turns = this.historyTurns, settling = false) {
    if (!snapshot) {
      body.scrollTop = body.scrollHeight;
      return;
    }
    if (snapshot.atBottom) {
      body.scrollTop = body.scrollHeight;
      return;
    }
    let anchor = null;
    if (snapshot.anchorKey) {
      let occurrence = 0;
      for (const child of body.children) {
        if (this.historyElementPreserveKey(child) !== snapshot.anchorKey) continue;
        if (occurrence++ === snapshot.anchorOccurrence) { anchor = child; break; }
      }
    }
    // The anchor element itself may have mutated past key recognition (streaming changes
    // its text); its old index is still the best guess -- prefix elements rarely move.
    if (!anchor && snapshot.anchorIndex >= 0) anchor = body.children[snapshot.anchorIndex] || null;
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
  },


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
  },


  applyHistoryTurns(sessionId, turns, options = {}) {
    const body = this.$("history-body");
    const preserveScroll = options.preserveScroll === true;
    const followLatest = options.followLatest === true;
    if (sessionId !== this.activeId || !this.historyOpen) return;
    this.cacheSessionModelFromHistory(sessionId, turns);
    const renderedTurns = this.filteredHistoryTurns(turns);
    const previousRenderedTurns = this.historyRenderedTurns;
    // Capture this after the request completes so scrolling while the refresh
    // is in flight is never overwritten by an older scroll position.
    const scrollSnapshot = followLatest
      ? null
      : preserveScroll
        ? this.captureHistoryScroll(body, this.historyTurns)
        : (this.historyScrollBySession.get(sessionId) || null);
    const fingerprint = `${renderedTurns.length}|${JSON.stringify(renderedTurns.slice(-3).map((turn) =>
      [turn.role, turn.kind, turn.text, turn.timestamp, turn.diff?.length, turn.diff_files, turn.plan, turn.items,
        turn.folded_responses?.length, turn.pending_id, turn.pending_delivery_state]))}`;
    if (preserveScroll && !options.forceRender && fingerprint === this.historyFingerprint) {
      this.historyTurns = turns;
      this.historyTurnsBySession.set(sessionId, turns);
      if (this.conversationOutlineOpen) this.renderConversationOutline(turns, { preserveScroll: true });
      if (followLatest) this.scrollHistoryToBottom();
      this.observeHistoryTopForPaging();
      requestAnimationFrame(() => this.scheduleFilteredHistoryContinuation(sessionId));
      return;
    }
    let commonPrefix = 0;
    if (preserveScroll && this.historyLoaded) {
      while (commonPrefix < previousRenderedTurns.length && commonPrefix < renderedTurns.length &&
        this.historyTurnKey(previousRenderedTurns[commonPrefix]) === this.historyTurnKey(renderedTurns[commonPrefix])) commonPrefix += 1;
    }
    const canAppend = !options.forceRender && preserveScroll && this.historyLoaded && previousRenderedTurns.length > 0 &&
      commonPrefix === previousRenderedTurns.length && renderedTurns.length >= previousRenderedTurns.length;
    const canPatchTail = !options.forceRender && preserveScroll && this.historyLoaded && previousRenderedTurns.length > 0 &&
      commonPrefix === previousRenderedTurns.length - 1 && renderedTurns.length >= previousRenderedTurns.length;
    this.historyFingerprint = fingerprint;
    this.historyLoaded = true;
    const s = this.sessionOrClosed(sessionId);
    this.$("history-title").textContent = s ? this.effectiveTitle(s) : "";
    this.renderHistoryModel(s, turns);
    if (canPatchTail) {
      // Keep the unchanged transcript nodes in place so browser-find selection
      // and the user's reading position survive live output updates.
      const existing = body.children[previousRenderedTurns.length - 1];
      const scratch = document.createElement("div");
      this.renderHistoryTurns([renderedTurns[previousRenderedTurns.length - 1]], { target: scratch });
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
      if (renderedTurns.length > previousRenderedTurns.length) {
        this.renderHistoryTurns(renderedTurns.slice(previousRenderedTurns.length), { target: body });
      }
    } else if (!canAppend) {
      // Expanded state must be captured BEFORE the clear below wipes the DOM, keyed by the
      // stable turn identity: streaming mutates earlier turns (forcing this full rebuild),
      // and an expanded thinking block collapsing mid-read also throws away the reader's
      // scroll position with it.
      const expandedByKey = new Map();
      if (preserveScroll && this.historyLoaded) {
        for (const child of body.children) {
          if (!child.matches?.("details")) continue;
          const key = this.historyElementPreserveKey(child);
          if (!expandedByKey.has(key)) expandedByKey.set(key, []);
          expandedByKey.get(key).push(child.open);
        }
      }
      body.textContent = "";
      if (!renderedTurns.length) {
        const empty = document.createElement("div");
        empty.className = "history-empty";
        empty.textContent = turns.length
          ? "no transcript turns match the active filters"
          : "no transcript found yet (send a message first, or the session id isn't resolved)";
        body.appendChild(empty);
      } else {
        this.renderHistoryTurns(renderedTurns, { expandedByKey });
      }
    } else {
      this.renderHistoryTurns(renderedTurns.slice(previousRenderedTurns.length), { append: true });
    }
    this.historyTurns = turns;
    this.historyRenderedTurns = renderedTurns;
    this.historyTurnsBySession.set(sessionId, turns);
    if (this.conversationOutlineOpen) this.renderConversationOutline(turns, { preserveScroll: true });
    this.renderHistoryMeta();
    this.updateHistoryEditToggle();
    this.updateActiveThinkingBlock();
    this.restoreHistoryScroll(body, scrollSnapshot, turns);
    this.observeHistoryTopForPaging();
    this.schedulePendingHistorySearchReveal();
    requestAnimationFrame(() => this.scheduleFilteredHistoryContinuation(sessionId));
  },


  renderMarkdown(text) {
    if (window.marked) {
      return marked.parse(text, { breaks: true, gfm: true });
    }
    const escaped = document.createElement("div");
    escaped.textContent = text;
    return escaped.innerHTML;
  },


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
  },


  initNotebook() {
    const toggles = [this.$("notebook-toggle"), this.$("history-notebook-toggle"), this.$("file-tabs-notebook"),
      this.$("mobile-notebook-toggle")].filter(Boolean);
    const panel = this.$("notebook-panel");
    const host = this.$("notebook-editor-host");
    if (!toggles.length || !panel || !host) return;
    this.normalizeNotebookNotes();
    for (const toggle of toggles) toggle.onclick = () => this.toggleNotebook();
    const notebookTabs = this.$("notebook-tabs");
    notebookTabs.addEventListener("pointerdown", (event) => {
      const tab = event.target.closest?.(".notebook-tab[data-note-id]");
      if (!tab || event.target.closest?.(".notebook-tab-close") || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      void this.selectNotebookNote(tab.dataset.noteId);
    }, true);
    notebookTabs.addEventListener("click", (event) => {
      const tab = event.target.closest?.(".notebook-tab[data-note-id]");
      if (!tab || event.target.closest?.(".notebook-tab-close") || event.detail !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      void this.selectNotebookNote(tab.dataset.noteId);
    }, true);
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
  },


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
      const fileLink = this.fileLinkAtContextEvent(event, source);
      if (fileLink) {
        this.openFileLinkContextMenu(event, fileLink);
        return;
      }
      const state = this.readSelectionActionState(event.target);
      event.preventDefault();
      event.stopPropagation();
      const contextKind = source.matches(".xterm") ? "terminal" : source.id === "history-body" ? "history"
        : source.id === "monaco-host" ? "file" : "notebook";
      this.openSelectionContextMenu(state, { x: event.clientX, y: event.clientY }, contextKind);
    });
    document.addEventListener("auxclick", (event) => this.handleDetectedFileLinkAuxClick(event));
    document.addEventListener("selectionchange", () => this.scheduleSelectionActions());
    document.addEventListener("mouseup", () => this.scheduleSelectionActions());
    document.addEventListener("copy", () => this.recordDocumentSelectionCopy());
    window.addEventListener("resize", () => this.scheduleSelectionActions());
    window.addEventListener("scroll", () => this.scheduleSelectionActions(), true);
  },


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
    const fileTabs = this.$("file-tabs");
    fileTabs.addEventListener("wheel", (event) => {
      if (fileTabs.scrollWidth <= fileTabs.clientWidth) return;
      const delta = Math.abs(event.deltaX) >= Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (!delta) return;
      event.preventDefault();
      fileTabs.scrollLeft += delta;
    }, { passive: false });
    this.$("problems-toggle").onclick = () => this.toggleProblemsPanel();
    this.$("problems-close").onclick = () => this.setProblemsOpen(false);
    this.$("problems-refresh").onclick = () => this.refreshProblems();
    this.$("conversation-outline-toggle").onclick = () => this.toggleContextualOutline();
    this.$("conversation-outline-close").onclick = () => this.setConversationOutlineOpen(false);
    this.$("conversation-outline-refresh").onclick = () => void this.loadConversationOutline(true);
    document.addEventListener("pointerdown", (event) => {
      if (this.activeFileKey !== null && this.fileInspectorMode === "outline") {
        if (this.$("file-inspector").contains(event.target) || this.$("conversation-outline-toggle").contains(event.target)) return;
        this.closeFileInspector();
        return;
      }
      if (!this.conversationOutlineOpen) return;
      if (this.$("conversation-outline").contains(event.target) || this.$("conversation-outline-toggle").contains(event.target) ||
          this.$("history-filter-toggle").contains(event.target) || this.$("mobile-history-filter-toggle").contains(event.target) ||
          this.$("history-filter-menu").contains(event.target)) return;
      this.setConversationOutlineOpen(false);
    });
  },


  openQuickOpen(initialQuery = "") {
    if (this.vscodeMode) return;
    this.quickOpenMode = "all";
    this.showQuickOpen(initialQuery);
  },


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
  },


  showQuickOpen(initialQuery) {
    const backdrop = this.$("quick-open-backdrop");
    const input = this.$("quick-open-input");
    backdrop.classList.remove("hidden");
    input.value = initialQuery;
    this.quickOpenSelection = 0;
    void this.renderQuickOpen(initialQuery);
    requestAnimationFrame(() => { input.focus(); input.select(); });
  },


  closeQuickOpen() {
    clearTimeout(this.quickOpenTimer);
    this.$("quick-open-backdrop").classList.add("hidden");
    this.quickOpenMode = "all";
    requestAnimationFrame(() => this.focusActiveEditor());
  },


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
  },


  quickOpenTextMatches(query, ...values) {
    const terms = String(query || "").toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return true;
    const text = values.filter(Boolean).join(" ").toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  },


  quickOpenCommands() {
    const commands = [
      { title: "New terminal", icon: "add", run: () => this.openModal() },
      { title: "Show Problems", icon: "warning", run: () => this.setProblemsOpen(true) },
      { title: "Show file Outline", icon: "symbol-class", run: () => this.toggleFileInspector("outline", true) },
      { title: "Split active editor", icon: "split-horizontal", run: () => this.toggleSplitEditor(true) },
      { title: "Reveal active file in tree", icon: "target", run: () => void this.revealActiveFile() },
      { title: "Open Quick Notes", icon: "notebook", run: () => this.setNotebookOpen(true) },
    ];
    if (this.sessionSupportsTranscript()) commands.splice(commands.length - 1, 0,
      { title: "Open transcript", icon: "comment-discussion", run: () => this.setHistoryMode(true) });
    return commands;
  },


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
  },


  quickOpenTerminalResult(session, kind) {
    const title = this.titlePresentation(session).text;
    return { kind, title, detail: session.cwd, icon: "terminal",
      run: () => this.activate(session.session_id, { reveal: true }) };
  },


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
  },


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
  },


  updateQuickOpenSelection(scroll = true) {
    for (const row of this.$("quick-open-results").querySelectorAll(".quick-open-item")) {
      const selected = Number(row.dataset.index) === this.quickOpenSelection;
      row.classList.toggle("selected", selected);
      row.setAttribute("aria-selected", String(selected));
      if (selected && scroll) row.scrollIntoView({ block: "nearest" });
    }
  },


  renderFileEditorChrome() {
    if (this.vscodeMode) return;
    const fileWorkspaceMode = this.activeFileKey !== null || FILES_SIDE_PANEL_TABS.includes(this.sideView);
    this.$("file-tabs-bar").classList.toggle("hidden", !fileWorkspaceMode);
    this.$("notebook-toggle").classList.toggle("hidden", fileWorkspaceMode);
    this.$("editor-wrap-toggle").classList.toggle("hidden", !fileWorkspaceMode);
    this.$("notebook-panel")?.classList.toggle("notebook-over-file-area", fileWorkspaceMode);
    this.renderFileTabs();
    this.renderFileBreadcrumbs();
    this.renderSecondaryFileSelect();
    if (this.fileInspectorMode === "outline") this.renderFileOutline();
    if (this.problemsOpen) this.scheduleProblemsRefresh();
    this.syncFileHistorySurface();
  },


  renderFileTabs() {
    const container = this.$("file-tabs");
    if (!container) return;
    const previousScrollLeft = container.scrollLeft;
    const previousActiveTab = container.dataset.activeTab || "";
    const renderVersion = Number(container.dataset.renderVersion || 0) + 1;
    container.dataset.renderVersion = String(renderVersion);
    container.textContent = "";
    const historyActive = this.fileHistoryOpen && this.fileHistoryTabKey !== null &&
      this.fileHistoryTabKey === this.activeFileKey;
    const activeTab = historyActive ? `history:${this.fileHistoryTabKey}`
      : this.activeFileKey !== null ? `file:${this.activeFileKey}` : "";
    for (const [key, entry] of this.visibleOrderedFileTabs()) {
      const active = key === this.activeFileKey && !historyActive;
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = `file-editor-tab${active ? " active" : ""}${entry.preview ? " preview" : ""}`;
      tab.title = this.fileTabHoverPath(entry);
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(active));
      const name = document.createElement("span");
      name.className = "file-editor-tab-name";
      name.textContent = entry.name;
      const gitStatus = this.gitStatusPresentation(entry.git_status);
      if (gitStatus) {
        name.classList.add(`git-row-${gitStatus.statusClass}`);
        tab.title = `${tab.title}\ngit: ${gitStatus.label}`;
      }
      tab.appendChild(name);
      const pin = document.createElement("span");
      pin.className = `file-editor-tab-pin codicon codicon-${entry.preview ? "pin" : "pinned"}`;
      pin.title = entry.preview ? "Pin file" : "Unpin to preview";
      pin.onclick = (event) => { event.stopPropagation(); this.setFilePreview(key, !entry.preview); };
      const close = document.createElement("span");
      close.className = "file-editor-tab-close codicon codicon-close";
      close.title = "Close file";
      close.onclick = (event) => { event.stopPropagation(); void this.closeFile(key); };
      tab.append(pin, close);
      tab.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        void this.activateFile(key, null);
      };
      tab.ondblclick = () => this.setFilePreview(key, false);
      tab.oncontextmenu = (event) => this.openFileTabContextMenu(event, key);
      container.appendChild(tab);
    }
    const historyEntry = this.fileHistoryTabKey !== null ? this.openFiles.get(this.fileHistoryTabKey) : null;
    if (historyEntry) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = `file-editor-tab history-tab${historyActive ? " active" : ""}`;
      const comparisonLabels = this.fileHistorySelections.map((key) =>
        this.fileHistoryItems.find((item) => this.fileHistoryItemKey(item) === key)).filter(Boolean)
        .map((item) => this.fileHistoryItemLabel(item));
      tab.title = `History: ${this.fileTabHoverPath(historyEntry)}` +
        (comparisonLabels.length ? `\n${comparisonLabels.join(" ↔ ")}` : "");
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(historyActive));
      tab.setAttribute("aria-label", `History of ${historyEntry.name}`);
      const icon = document.createElement("span");
      icon.className = "file-editor-tab-history-icon codicon codicon-history";
      const name = document.createElement("span");
      name.className = "file-editor-tab-name";
      name.textContent = historyEntry.name;
      const close = document.createElement("span");
      close.className = "file-editor-tab-close codicon codicon-close";
      close.title = "Close file history";
      close.onclick = (event) => { event.stopPropagation(); this.closeFileHistory(); };
      tab.append(icon, name, close);
      tab.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        void this.activateFileHistoryTab();
      };
      container.appendChild(tab);
    }
    container.dataset.activeTab = activeTab;
    const restoreFileTabScroll = () => {
      if (Number(container.dataset.renderVersion) !== renderVersion) return;
      const maximumScrollLeft = Math.max(0, container.scrollWidth - container.clientWidth);
      let nextScrollLeft = Math.max(0, Math.min(maximumScrollLeft, previousScrollLeft));
      if (activeTab !== previousActiveTab) {
        const active = container.querySelector(".file-editor-tab.active");
        if (active) {
          const activeLeft = active.offsetLeft;
          const activeRight = activeLeft + active.offsetWidth;
          if (activeLeft < nextScrollLeft) nextScrollLeft = activeLeft;
          else if (activeRight > nextScrollLeft + container.clientWidth) {
            nextScrollLeft = activeRight - container.clientWidth;
          }
        }
      }
      container.scrollLeft = Math.max(0, Math.min(maximumScrollLeft, nextScrollLeft));
    };
    restoreFileTabScroll();
    requestAnimationFrame(restoreFileTabScroll);
  },


  visibleOrderedFileTabs() {
    const entries = [...this.openFiles.entries()];
    if (this.settings.file_tab_order === "modified") {
      entries.sort((left, right) => (Number(right[1].mtime) || 0) - (Number(left[1].mtime) || 0));
    }
    const maximumVisible = Math.max(1, Math.min(OPEN_FILES_MAX_ENTRIES,
      Number(this.settings.file_tab_max_visible) || SETTINGS_DEFAULTS.file_tab_max_visible));
    const visible = entries.slice(0, maximumVisible);
    if (this.activeFileKey !== null && !visible.some(([key]) => key === this.activeFileKey)) {
      const active = entries.find(([key]) => key === this.activeFileKey);
      if (active) visible[Math.max(0, visible.length - 1)] = active;
    }
    return visible;
  },


  setFilePreview(key, preview) {
    const entry = this.openFiles.get(key);
    if (!entry) return;
    entry.preview = !!preview && !entry.dirty;
    this.persistOpenFiles();
    this.renderFileEditorChrome();
  },


  fileTabSettingsFontRow(label, key) {
    const row = document.createElement("label");
    row.className = "file-tab-settings-row";
    row.appendChild(document.createTextNode(label));
    const select = document.createElement("select");
    select.setAttribute("aria-label", label);
    for (let value = FONT_MIN; value <= FONT_MAX; value += 1) {
      const option = document.createElement("option");
      option.value = String(value);
      option.textContent = `${value}px`;
      select.appendChild(option);
    }
    select.value = String(Math.max(FONT_MIN, Math.min(FONT_MAX,
      Number(this.settings[key]) || SETTINGS_DEFAULTS[key])));
    select.onchange = () => {
      this.settings[key] = Number(select.value);
      this.applySettings();
      this.saveSettings();
    };
    row.appendChild(select);
    return row;
  },


  openFileTabsMenu(anchor) {
    const menu = this.$("context-menu");
    menu.textContent = "";
    menu.classList.remove("hidden");
    const title = document.createElement("div");
    title.className = "file-tab-settings-title";
    title.textContent = "File tabs";
    const maximumRow = document.createElement("label");
    maximumRow.className = "file-tab-settings-row";
    maximumRow.appendChild(document.createTextNode("Maximum visible"));
    const maximum = document.createElement("select");
    maximum.setAttribute("aria-label", "Maximum visible file tabs");
    for (const value of [5, 10, 15, 20, 25, 30, 40, 50, 60, 80]) {
      const option = document.createElement("option");
      option.value = String(value);
      option.textContent = String(value);
      maximum.appendChild(option);
    }
    maximum.value = String(Math.max(1, Math.min(OPEN_FILES_MAX_ENTRIES,
      Number(this.settings.file_tab_max_visible) || SETTINGS_DEFAULTS.file_tab_max_visible)));
    maximum.onchange = () => {
      this.settings.file_tab_max_visible = Number(maximum.value);
      this.saveSettings();
      this.renderFileTabs();
    };
    maximumRow.appendChild(maximum);
    const orderRow = document.createElement("label");
    orderRow.className = "file-tab-settings-row";
    orderRow.appendChild(document.createTextNode("Order"));
    const order = document.createElement("select");
    order.setAttribute("aria-label", "File tab order");
    for (const [value, label] of [["opened", "Opening order"], ["modified", "Last modified first"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      order.appendChild(option);
    }
    order.value = this.settings.file_tab_order === "modified" ? "modified" : "opened";
    order.onchange = () => {
      this.settings.file_tab_order = order.value;
      this.saveSettings();
      this.renderFileTabs();
    };
    orderRow.appendChild(order);
    menu.append(title, maximumRow, orderRow,
      this.fileTabSettingsFontRow("Tab font size", "files_tab_font_size"),
      this.fileTabSettingsFontRow("Code font size", "code_font_size"));
    const recentlyClosed = (this.settings.recent_closed_files || [])[0];
    this.addContextItem(menu, recentlyClosed ? `Reopen ${recentlyClosed.path.split("/").pop()}` : "No recently closed files",
      recentlyClosed ? () => void this.openFile(recentlyClosed.root, recentlyClosed.path, null, null, { pinned: true }) : null,
      "history");
    const rect = anchor.getBoundingClientRect();
    this.positionContextMenu(menu, rect.right, rect.bottom + 4);
  },


  renderFileBreadcrumbs() {
    const container = this.$("file-breadcrumbs");
    if (!container) return;
    container.textContent = "";
    const entry = this.activeFileKey !== null ? this.openFiles.get(this.activeFileKey) : null;
    container.classList.toggle("hidden", !entry || this.vscodeMode);
    if (!entry || this.vscodeMode) {
      container.title = "";
      return;
    }
    container.title = entry.fullPath || `${entry.root}/${entry.path}`;
    const project = this.projectForCwd(entry.root);
    const parts = entry.path.split("/").filter(Boolean);
    const labels = [project?.name || entry.root.split("/").filter(Boolean).pop() || entry.root, ...parts];
    for (const [index, label] of labels.entries()) {
      const crumb = document.createElement("button");
      crumb.type = "button";
      crumb.className = "file-breadcrumb";
      crumb.textContent = label;
      crumb.title = container.title;
      if (index < labels.length - 1) {
        const folderPath = index === 0 ? "" : parts.slice(0, index).join("/");
        crumb.onclick = () => void this.revealFileBreadcrumb(entry, folderPath);
      }
      container.appendChild(crumb);
    }
  },


  fileTabHoverPath(entry) {
    const absolutePath = this.normalizedFileSystemPath(entry.fullPath || `${entry.root}/${entry.path}`);
    const projectBases = [this.worktreeRoot(), this.projectRoot()].filter(Boolean)
      .map((base) => this.normalizedFileSystemPath(base)).sort((left, right) => right.length - left.length);
    const matchingBase = projectBases.find((base) => absolutePath.startsWith(`${base}/`));
    return matchingBase ? absolutePath.slice(matchingBase.length + 1) : absolutePath;
  },


  async revealFileBreadcrumb(entry, folderPath) {
    if (this.sideView !== "project") this.setSideView("project", false);
    if (this.treeRoot !== entry.root || !this.treeDirs.get("")) await this.reloadTree(entry.root);
    if (!folderPath) {
      this.markTreeSelection(null);
      this.$("files-tree").scrollTop = 0;
      return;
    }
    let relativePath = "";
    let folderRow = null;
    for (const part of folderPath.split("/")) {
      relativePath = relativePath ? `${relativePath}/${part}` : part;
      folderRow = this.treeRowForPath(relativePath);
      if (!folderRow) return;
      if (!this.expandedDirs.has(relativePath)) await this.toggleDir(folderRow, relativePath);
    }
    this.markTreeSelection(folderRow);
    folderRow?.scrollIntoView({ block: "center" });
  },


  async openFileBlame(root, path) {
    const key = `${root}|${path}`;
    if (this.fileBlameActiveKey === key && this.activeFileKey === key) {
      this.clearFileBlameAnnotations();
      this.editor?.focus();
      return;
    }
    await this.openFile(root, path, null, null, { fromFilePanel: true, pinned: true });
    if (this.activeFileKey !== key) return;
    await this.loadFileBlameAnnotations(this.openFiles.get(key));
  },


  toggleFileInspector(mode, forceOpen = false) {
    if (this.activeFileKey === null) return;
    if (!forceOpen && this.fileInspectorMode === mode) {
      this.closeFileInspector();
      return;
    }
    this.fileInspectorMode = mode;
    this.$("file-inspector").classList.remove("hidden");
    this.$("file-outline-toggle")?.classList.toggle("on", mode === "outline");
    this.$("conversation-outline-toggle").classList.toggle("on", mode === "outline");
    this.refreshFileInspector();
  },


  closeFileInspector() {
    this.fileInspectorMode = null;
    this.$("file-inspector").classList.add("hidden");
    this.$("file-outline-toggle")?.classList.remove("on");
    if (this.activeFileKey !== null) this.$("conversation-outline-toggle").classList.remove("on");
    this.editor?.layout();
  },


  refreshFileInspector() {
    if (this.fileInspectorMode === "outline") this.renderFileOutline();
  },


  async loadFileBlameAnnotations(entry) {
    if (!entry || !this.editor) return;
    const generation = ++this.fileBlameGeneration;
    this.fileBlameDecorationIds = this.editor.deltaDecorations(this.fileBlameDecorationIds, []);
    this.$("stat-text").textContent = `Loading blame for ${entry.name}…`;
    const response = await fetch(`/api/files/git-blame?${new URLSearchParams({ root: entry.root, path: entry.path })}`);
    if (generation !== this.fileBlameGeneration || this.activeFileKey !== `${entry.root}|${entry.path}`) return;
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      this.$("stat-text").textContent = error.detail || "Git blame is unavailable for this file.";
      return;
    }
    const records = await response.json();
    if (!records.length) {
      this.$("stat-text").textContent = "No Git blame records found for this file.";
      return;
    }
    this.fileBlameActiveKey = `${entry.root}|${entry.path}`;
    this.fileBlameRecordsByLine = new Map(records.map((record) => [Number(record.line), record]));
    const authorLabels = records.filter((record) => !this.fileBlameRecordIsUncommitted(record)).map((record) => this.fileBlameAuthorLabel(record.author));
    this.fileBlameAuthorWidth = Math.min(4, Math.max(2, ...authorLabels.map((label) => label.length)));
    const lineNumberWidth = String(this.editor.getModel()?.getLineCount() || records.length).length;
    this.fileBlameDecorationIds = this.editor.deltaDecorations(this.fileBlameDecorationIds, records.filter((record) => this.fileBlameRecordIsUncommitted(record)).map((record) => ({
      range: new monaco.Range(Number(record.line), 1, Number(record.line), 1),
      options: { linesDecorationsClassName: "git-blame-uncommitted-gutter" },
    })));
    this.editor.updateOptions({
      lineNumbers: (lineNumber) => this.fileBlameLineNumberLabel(lineNumber),
      lineNumbersMinChars: this.fileBlameAuthorWidth + lineNumberWidth + 2,
    });
    this.$("monaco-host").classList.add("git-blame-active");
    this.editor.layout();
    this.editor.focus();
    this.$("stat-text").textContent = `Annotated ${records.length} lines · hover an author for commit details`;
  },


  fileBlameRecordIsUncommitted(record) {
    const commitId = String(record.commit_id || "").trim().toLowerCase();
    const author = String(record.author || "").trim();
    return /^0+$/.test(commitId) || /not committed yet|uncommitted/i.test(author);
  },


  fileBlameAuthorLabel(author) {
    const label = String(author || "Unknown").trim() || "Unknown";
    const initials = label.split(/\s+/).map((part) => part.replace(/[^A-Za-z0-9]/g, "").charAt(0)).join("");
    return (initials || label.replace(/[^A-Za-z0-9]/g, "").slice(0, 2) || "?").slice(0, 3).toUpperCase();
  },


  fileBlameLineNumberLabel(lineNumber) {
    const record = this.fileBlameRecordsByLine.get(lineNumber);
    if (!record) return String(lineNumber);
    const author = this.fileBlameRecordIsUncommitted(record) ? "" : this.fileBlameAuthorLabel(record.author);
    return `${author.padEnd(this.fileBlameAuthorWidth)} ${lineNumber}`;
  },


  updateFileBlameGutterHover(event) {
    if (!this.fileBlameActiveKey || event.target?.type !== monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS) return;
    const lineNumber = Number(event.target.position?.lineNumber || 0);
    const record = this.fileBlameRecordsByLine.get(lineNumber);
    const element = event.target.element;
    if (!record || !element) return;
    const committedAt = record.author_time ? new Date(Number(record.author_time) * 1000).toLocaleString() : "Unknown date";
    const commitId = String(record.commit_id || "");
    element.title = [this.fileBlameRecordIsUncommitted(record) ? "Not committed yet" : record.author || "Unknown", committedAt, record.summary || "", commitId].filter(Boolean).join("\n");
  },


  clearFileBlameAnnotations() {
    this.fileBlameGeneration += 1;
    this.fileBlameActiveKey = null;
    this.fileBlameRecordsByLine.clear();
    this.fileBlameAuthorWidth = 0;
    if (this.editor) this.fileBlameDecorationIds = this.editor.deltaDecorations(this.fileBlameDecorationIds, []);
    this.$("monaco-host")?.classList.remove("git-blame-active");
    this.editor?.updateOptions({ lineNumbers: "on", lineNumbersMinChars: 4 });
    this.editor?.layout();
  },


  async loadActiveFileGitHunks() {
    const entry = this.activeFileKey !== null ? this.openFiles.get(this.activeFileKey) : null;
    if (!entry || !this.editor || this.editor.getModel() !== entry.model) {
      this.clearActiveFileGitHunks();
      return null;
    }
    const key = `${entry.root}|${entry.path}`;
    const generation = ++this.fileGitHunkGeneration;
    const response = await fetch(`/api/git/hunks?${new URLSearchParams({ root: entry.root, path: entry.path })}`);
    if (generation !== this.fileGitHunkGeneration || this.activeFileKey !== key || this.editor.getModel() !== entry.model) return null;
    if (!response.ok) {
      this.applyActiveFileGitHunks({ working: [], staged: [] });
      return null;
    }
    const payload = await response.json();
    this.applyActiveFileGitHunks(payload);
    return payload;
  },


  scheduleActiveFileGitHunkRefresh(delay = 180) {
    clearTimeout(this.fileGitHunkRefreshTimer);
    this.fileGitHunkRefreshTimer = setTimeout(() => {
      this.fileGitHunkRefreshTimer = 0;
      void this.loadActiveFileGitHunks();
    }, delay);
  },


  applyActiveFileGitHunks(payload) {
    if (!this.editor?.getModel()) return;
    const modelLineCount = this.editor.getModel().getLineCount();
    const decorations = [];
    this.fileGitHunksByLine.clear();
    for (const hunk of [...(payload.staged || []), ...(payload.working || [])]) {
      const lineNumber = Math.max(1, Math.min(modelLineCount, Number(hunk.new_start) || Number(hunk.old_start) || 1));
      const lineHunks = this.fileGitHunksByLine.get(lineNumber) || [];
      lineHunks.push(hunk);
      this.fileGitHunksByLine.set(lineNumber, lineHunks);
      decorations.push({
        range: new monaco.Range(lineNumber, 1, lineNumber, 1),
        options: {
          isWholeLine: true,
          linesDecorationsClassName: `git-hunk-decoration git-hunk-${hunk.scope} git-hunk-${hunk.kind}`,
          hoverMessage: { value: `${hunk.scope === "staged" ? "Staged" : "Working"} hunk: ${hunk.heading || "Changed lines"}` },
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      });
    }
    this.fileGitHunkDecorationIds = this.editor.deltaDecorations(this.fileGitHunkDecorationIds, decorations);
    this.$("monaco-host")?.classList.toggle("git-hunks-active", decorations.length > 0);
  },


  clearActiveFileGitHunks() {
    clearTimeout(this.fileGitHunkRefreshTimer);
    this.fileGitHunkRefreshTimer = 0;
    this.fileGitHunkGeneration += 1;
    if (this.editor?.getModel() && this.fileGitHunkDecorationIds.length) {
      this.fileGitHunkDecorationIds = this.editor.deltaDecorations(this.fileGitHunkDecorationIds, []);
    } else {
      this.fileGitHunkDecorationIds = [];
    }
    this.fileGitHunksByLine.clear();
    this.$("monaco-host")?.classList.remove("git-hunks-active");
  },


  openFileGitHunkMenu(mouseEvent) {
    const targetType = mouseEvent.target?.type;
    const lineNumber = Number(mouseEvent.target?.position?.lineNumber || 0);
    const gutterTarget = targetType === monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS ||
      targetType === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN;
    const hunks = gutterTarget ? this.fileGitHunksByLine.get(lineNumber) || [] : [];
    if (!hunks.length) return false;
    const browserEvent = mouseEvent.event?.browserEvent || mouseEvent.event;
    browserEvent?.preventDefault?.();
    browserEvent?.stopPropagation?.();
    const menu = this.$("context-menu");
    menu.textContent = "";
    this.contextMenuTarget = { type: "git-hunks", line: lineNumber };
    for (const hunk of hunks) {
      const scope = hunk.scope === "staged" ? "Staged" : "Working";
      this.addContextItem(menu, `${scope}: ${hunk.heading || "changed lines"}`, null, "diff-modified");
      if (hunk.scope === "working") {
        this.addContextItem(menu, "Stage this hunk", () => this.applyActiveFileGitHunkAction(hunk, "stage"), "add");
      } else {
        this.addContextItem(menu, "Unstage this hunk", () => this.applyActiveFileGitHunkAction(hunk, "unstage"), "remove");
      }
      this.addContextItem(menu, "Revert this hunk…", () => this.applyActiveFileGitHunkAction(hunk, "revert"), "discard");
    }
    const x = Number(browserEvent?.clientX ?? mouseEvent.event?.posx ?? 0);
    const y = Number(browserEvent?.clientY ?? mouseEvent.event?.posy ?? 0);
    this.positionContextMenu(menu, x, y);
    return true;
  },


  async applyActiveFileGitHunkAction(selectedHunk, action) {
    const entry = this.activeFileKey !== null ? this.openFiles.get(this.activeFileKey) : null;
    if (!entry) return;
    let hunk = selectedHunk;
    if (entry.dirty || entry.savePromise) {
      if (!await this.saveFileEntry(entry, true)) return;
      const refreshed = await this.loadActiveFileGitHunks();
      hunk = [...(refreshed?.staged || []), ...(refreshed?.working || [])].find((candidate) =>
        candidate.scope === selectedHunk.scope && candidate.new_start === selectedHunk.new_start &&
        candidate.heading === selectedHunk.heading);
      if (!hunk) {
        await this.showGitMessage("Hunk changed", "The file changed while it was being saved. Select the hunk again from the gutter.");
        return;
      }
    }
    if (action === "revert") {
      const confirmed = await this.confirmGitAction("Revert this hunk?",
        "The current file is saved to Local History first. Only the selected hunk is reverted.", "Revert hunk", true);
      if (!confirmed) return;
    }
    const response = await fetch("/api/git/hunks/action", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root: entry.root, path: entry.path, scope: hunk.scope, hunk_id: hunk.hunk_id, action }) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      await this.showGitMessage("Git hunk operation failed", payload.detail || "The selected hunk is stale or could not be applied.");
      await this.loadActiveFileGitHunks();
      return;
    }
    if (action === "revert") {
      entry.dirty = false;
      await this.refreshFileModelFromDisk(entry);
    }
    this.applyActiveFileGitHunks(payload);
    void this.refreshOpenFileGitStatuses(entry.root, true);
    if (this.sideView === "git") void this.loadGitSidePanel();
    this.editor?.focus();
  },


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
  },


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
  },


  revealEditorLine(line, column = 1) {
    if (!this.editor) return;
    this.editor.setPosition({ lineNumber: line, column });
    this.editor.revealLineInCenter(line);
    this.editor.focus();
  },


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
  },


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
  },


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
  },


  toggleSecondaryDiff() {
    if (this.$("secondary-editor-pane").classList.contains("hidden")) return;
    this.$("secondary-diff-toggle").classList.toggle("on");
    void this.renderSecondaryEditor(true);
  },


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
      fontSize: this.scaledSettingSize("code_font_size"), wordWrap: this.settings.editor_no_wrap ? "off" : "on", fixedOverflowWidgets: true };
    if (diff) {
      this.secondaryDiffEditor = monaco.editor.createDiffEditor(host, { ...options, readOnly: true, renderSideBySide: false });
      this.secondaryDiffEditor.setModel({ original: activeEntry.model, modified: secondaryEntry.model });
    } else {
      this.secondaryEditor = monaco.editor.create(host, { ...options, readOnly: false, model: secondaryEntry.model });
    }
  },


  toggleProblemsPanel() {
    if (!this.problemsAvailableForCurrentSurface()) return;
    this.setProblemsOpen(!this.problemsOpen);
  },


  problemsAvailableForCurrentSurface() {
    return this.activeFileKey !== null || this.gitReviewOpen || FILES_SIDE_PANEL_TABS.includes(this.sideView);
  },


  updateProblemsAvailability() {
    const available = this.problemsAvailableForCurrentSurface();
    this.$("problems-toggle")?.classList.toggle("hidden", !available);
    if (!available && this.problemsOpen) this.setProblemsOpen(false);
  },


  setProblemsOpen(open) {
    this.problemsOpen = !!open && this.problemsAvailableForCurrentSurface();
    this.$("problems-panel").classList.toggle("hidden", !this.problemsOpen);
    this.$("problems-toggle").classList.toggle("on", this.problemsOpen);
    if (this.problemsOpen) this.refreshProblems();
    this.editor?.layout();
    this.secondaryEditor?.layout();
    this.secondaryDiffEditor?.layout();
    this.fitActive();
  },


  scheduleProblemsRefresh() {
    if (!this.problemsOpen) return;
    clearTimeout(this.problemsRefreshTimer);
    this.problemsRefreshTimer = setTimeout(() => this.refreshProblems(), 180);
  },


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
  },


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
  },


  toggleConversationOutline() {
    this.setConversationOutlineOpen(!this.conversationOutlineOpen);
  },


  toggleContextualOutline() {
    if (this.activeFileKey !== null) {
      this.toggleFileInspector("outline");
      return;
    }
    this.toggleConversationOutline();
  },


  setConversationOutlineOpen(open) {
    this.conversationOutlineOpen = !!open && this.activeFileKey === null && !!this.activeId && this.sessionSupportsTranscript();
    this.$("conversation-outline").classList.toggle("hidden", !this.conversationOutlineOpen);
    this.$("conversation-outline-toggle").classList.toggle("on", this.conversationOutlineOpen);
    if (this.conversationOutlineOpen) void this.loadConversationOutline(true);
    else this.conversationOutlineSessionId = null;
    this.fitActive();
  },


  async loadConversationOutline(force = false) {
    const sessionId = this.activeId;
    if (!this.conversationOutlineOpen || !sessionId || this.activeFileKey !== null) return;
    const list = this.$("conversation-outline-list");
    let turns = this.historyTurnsBySession.get(sessionId) || this.conversationOutlineTurnsBySession.get(sessionId) || [];
    const needsFetch = !turns.length || (force && !this.historyOpen);
    if (needsFetch) {
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
    this.renderConversationOutline(turns, { revealLatestPrompt: true });
  },


  conversationOutlineTurnKey(turn) {
    return `${turn.role || ""}|${turn.kind || ""}|${turn.timestamp || ""}|${String(turn.text || "").replace(/\s+/g, " ").trim().slice(0, 220)}|${turn.folded_responses?.length || 0}`;
  },


  formatConversationOutlineTimestamp(value) {
    if (value == null || value === "") return null;
    const numeric = typeof value === "number" ? (value < 1e12 ? value * 1000 : value) : value;
    const date = new Date(numeric);
    if (Number.isNaN(date.getTime())) return null;
    const currentYear = new Date().getFullYear();
    const options = date.getFullYear() === currentYear
      ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
      : { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
    return { compact: new Intl.DateTimeFormat(undefined, options).format(date), exact: date.toLocaleString() };
  },


  conversationOutlineText(turn) {
    if (turn.kind === "edit") {
      const files = Array.isArray(turn.diff_files) ? turn.diff_files.map((file) => this.historyDiffPath(file?.path)).filter(Boolean) : [];
      return files.length ? `${files.join(", ")} · ${this.historyEditSummary(turn)}` : this.historyEditSummary(turn);
    }
    return String(turn.text || "").replace(/\s+/g, " ").trim();
  },


  renderConversationOutline(turns, options = {}) {
    const list = this.$("conversation-outline-list");
    const previousScrollTop = list.scrollTop;
    list.textContent = "";
    const messages = this.filteredHistoryTurns(turns).filter((turn) =>
      (["user", "assistant"].includes(turn.role) && String(turn.text || "").trim()) || turn.kind === "edit");
    let latestPromptItem = null;
    for (const turn of messages) {
      const item = document.createElement("button");
      item.type = "button";
      const prompt = turn.role === "user";
      const edit = turn.kind === "edit";
      const foldedCount = Array.isArray(turn.folded_responses) ? turn.folded_responses.length : 0;
      const question = !prompt && !edit && /[?？]\s*$/.test(String(turn.text || "").trim());
      const messageType = prompt ? "prompt" : edit ? "edit" : question ? "question" : "response";
      item.className = `conversation-outline-item ${messageType}`;
      const role = document.createElement("span");
      role.className = `conversation-outline-role codicon codicon-${prompt ? "arrow-right" : edit ? "diff" : question ? "question" : "sparkle"}`;
      const label = document.createElement("span");
      label.className = "conversation-outline-label";
      label.textContent = prompt ? "Prompt" : edit ? "Code edit" : foldedCount > 1
        ? `${foldedCount} similar responses` : question ? "Question" : "LLM response";
      const timestamp = this.formatConversationOutlineTimestamp(turn.timestamp);
      const time = document.createElement("time");
      time.className = "conversation-outline-time";
      if (timestamp) {
        time.textContent = timestamp.compact;
        time.title = timestamp.exact;
      }
      const text = document.createElement("span");
      text.className = "conversation-outline-text";
      text.textContent = this.conversationOutlineText(turn);
      item.append(role, label);
      if (timestamp) item.append(time);
      item.append(text);
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
    if (options.revealLatestPrompt && latestPromptItem) {
      requestAnimationFrame(() => {
        if (!this.conversationOutlineOpen || !latestPromptItem.isConnected) return;
        list.scrollTop = Math.max(0, latestPromptItem.offsetTop - list.offsetTop - 6);
      });
    } else if (options.preserveScroll) {
      list.scrollTop = previousScrollTop;
    }
  },


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
  },


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
  },


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
  },


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
  },


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
  },


  mobileTerminalSelectionPoint(view, touch) {
    const screen = view.container.querySelector(".xterm-screen");
    const dimensions = view.term._core?._renderService?.dimensions?.css?.cell;
    const buffer = view.term.buffer.active;
    if (!screen || !dimensions?.width || !dimensions?.height || !buffer?.length) return null;
    const bounds = screen.getBoundingClientRect();
    const column = Math.max(0, Math.min(view.term.cols - 1, Math.floor((touch.clientX - bounds.left) / dimensions.width)));
    const visibleRow = Math.floor((touch.clientY - bounds.top) / dimensions.height);
    const row = Math.max(0, Math.min(buffer.length - 1, buffer.viewportY + visibleRow));
    return { column, row };
  },


  mobileTerminalWordRange(view, point) {
    const line = view.term.buffer.active.getLine(point.row);
    const text = line?.translateToString(false) || "";
    if (!text || /\s/.test(text[point.column] || " ")) return { start: point, end: point };
    let startColumn = point.column;
    let endColumn = point.column;
    while (startColumn > 0 && !/\s/.test(text[startColumn - 1] || " ")) startColumn -= 1;
    while (endColumn + 1 < view.term.cols && !/\s/.test(text[endColumn + 1] || " ")) endColumn += 1;
    return { start: { column: startColumn, row: point.row }, end: { column: endColumn, row: point.row } };
  },


  selectMobileTerminalRange(view, start, end) {
    const columns = view.term.cols;
    const startIndex = start.row * columns + start.column;
    const endIndex = end.row * columns + end.column;
    const first = startIndex <= endIndex ? start : end;
    view.term.select(first.column, first.row, Math.abs(endIndex - startIndex) + 1);
  },


  cancelMobileTerminalLongPress(view) {
    const state = view.mobileTerminalSelection;
    if (state?.timer) clearTimeout(state.timer);
    view.mobileTerminalSelection = null;
  },


  installMobileTerminalLongPressSelection(view) {
    if (!this.touchMobileLayoutEnabled()) return;
    const surface = view.container.querySelector(".xterm");
    if (!surface) return;
    surface.addEventListener("touchstart", (event) => {
      this.cancelMobileTerminalLongPress(view);
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      const state = { identifier: touch.identifier, startX: touch.clientX, startY: touch.clientY,
        lastX: touch.clientX, lastY: touch.clientY, active: false, wordRange: null, timer: 0 };
      state.timer = window.setTimeout(() => {
        state.timer = 0;
        if (view.closed || view.mobileTerminalSelection !== state || !view.container.classList.contains("visible")) return;
        const point = this.mobileTerminalSelectionPoint(view, { clientX: state.lastX, clientY: state.lastY });
        if (!point) return;
        state.active = true;
        state.wordRange = this.mobileTerminalWordRange(view, point);
        this.selectMobileTerminalRange(view, state.wordRange.start, state.wordRange.end);
      }, MOBILE_TERMINAL_LONG_PRESS_MS);
      view.mobileTerminalSelection = state;
    }, { passive: true, capture: true });
    surface.addEventListener("touchmove", (event) => {
      const state = view.mobileTerminalSelection;
      if (event.touches.length !== 1) {
        this.cancelMobileTerminalLongPress(view);
        event.stopImmediatePropagation();
        return;
      }
      if (!state) return;
      const touch = [...event.touches].find((candidate) => candidate.identifier === state.identifier);
      if (!touch) return;
      state.lastX = touch.clientX;
      state.lastY = touch.clientY;
      if (!state.active) {
        if (Math.hypot(touch.clientX - state.startX, touch.clientY - state.startY) > MOBILE_TERMINAL_SELECTION_MOVE_TOLERANCE) {
          this.cancelMobileTerminalLongPress(view);
        }
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      const point = this.mobileTerminalSelectionPoint(view, touch);
      if (!point || !state.wordRange) return;
      const pointIndex = point.row * view.term.cols + point.column;
      const startIndex = state.wordRange.start.row * view.term.cols + state.wordRange.start.column;
      const endIndex = state.wordRange.end.row * view.term.cols + state.wordRange.end.column;
      this.selectMobileTerminalRange(view, pointIndex < startIndex ? point : state.wordRange.start,
        pointIndex > endIndex ? point : state.wordRange.end);
    }, { passive: false, capture: true });
    surface.addEventListener("touchend", (event) => {
      const state = view.mobileTerminalSelection;
      if (!state) return;
      if (state.timer) clearTimeout(state.timer);
      if (state.active) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const changedTouch = [...event.changedTouches].find((candidate) => candidate.identifier === state.identifier);
        window.setTimeout(() => {
          const selectionState = this.readSelectionActionState(surface);
          if (selectionState) this.openSelectionContextMenu(selectionState,
            { x: changedTouch?.clientX || state.lastX, y: changedTouch?.clientY || state.lastY }, "terminal");
        }, 0);
      }
      view.mobileTerminalSelection = null;
    }, { passive: false, capture: true });
    surface.addEventListener("touchcancel", () => this.cancelMobileTerminalLongPress(view), { passive: true, capture: true });
    surface.addEventListener("touchmove", (event) => event.stopImmediatePropagation(), { passive: true, capture: true });
  },


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
  },


  markdownSelectionHtml(range) {
    const wrapper = document.createElement("div");
    wrapper.appendChild(range.cloneContents());
    return wrapper.innerHTML;
  },


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
  },


  selectionAncestorElement(node, tagName) {
    let current = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    while (current) {
      if (current.tagName === tagName) return current;
      current = current.parentElement;
    }
    return null;
  },


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
  },


  selectionWithinContainer(selection, container) {
    if (!selection || selection.isCollapsed || !selection.rangeCount || !container) return false;
    const anchor = selection.anchorNode?.nodeType === Node.ELEMENT_NODE ? selection.anchorNode : selection.anchorNode?.parentElement;
    const focus = selection.focusNode?.nodeType === Node.ELEMENT_NODE ? selection.focusNode : selection.focusNode?.parentElement;
    return !!anchor && !!focus && container.contains(anchor) && container.contains(focus);
  },


  normalizeSelectionText(text) {
    return String(text || "").replace(/\r/g, "").trim();
  },


  selectionRangeRect(selection) {
    if (!selection || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    const rects = [...range.getClientRects()].filter((rect) => rect.width || rect.height);
    return rects[rects.length - 1] || range.getBoundingClientRect();
  },


  terminalSelectionRect(view) {
    const rects = [...view.container.querySelectorAll(".xterm-selection, .xterm-selection > div")]
      .map((element) => element.getBoundingClientRect()).filter((rect) => rect.width || rect.height)
      .sort((left, right) => left.bottom - right.bottom);
    if (rects.length) return rects[rects.length - 1];
    const container = view.container.getBoundingClientRect();
    return { left: container.left + container.width / 2 - 1, right: container.left + container.width / 2 + 1,
      top: container.bottom - 28, bottom: container.bottom - 8 };
  },


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
  },


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
      this.addContextItem(menu, "Search in files", hasSelection ? () => this.searchContentFromSelection() : null, "search");
      if (selectionState.kind === "terminal") {
        this.addContextItem(menu, "Repaint display", () => this.repaintActiveTerminalDisplay(), "refresh");
      }
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
  },


  closeSelectionContextMenu() {
    if (this.contextMenuTarget?.type !== "selection") return;
    this.closeContextMenu();
  },


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
  },


  closeSelectionCopyHistoryPicker() {
    this.hideSelectionActions();
    requestAnimationFrame(() => this.focusActiveEditor());
  },


  recordDocumentSelectionCopy() {
    const state = this.readSelectionActionState();
    if (state) this.recordSelectionCopyHistory(state.text);
  },


  recordSelectionCopyHistory(text) {
    const copied = this.normalizeSelectionText(text);
    if (!copied) return;
    const notebookState = this.notebookProjectState();
    const previous = this.projectSelectionCopyHistory();
    notebookState.selection_copy_history = [copied, ...previous.filter((item) => item !== copied)].slice(0, 50);
    this.saveProjectSelectionCopyHistory();
    const panel = this.$("selection-copy-history-panel");
    if (panel && !panel.classList.contains("hidden")) this.renderSelectionCopyHistory();
    if (this.settings.notebook_open) {
      this.renderNotebookRecentCopies();
      this.renderNotebookTabs();
    }
  },


  renderSelectionCopyHistory() {
    const panel = this.$("selection-copy-history-panel");
    if (!panel) return;
    panel.textContent = "";
    const history = this.projectSelectionCopyHistory();
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
  },


  toggleSelectionCopyHistory() {
    const panel = this.$("selection-copy-history-panel");
    if (!panel) return;
    const opening = panel.classList.contains("hidden");
    if (!opening) {
      this.closeSelectionCopyHistoryPicker();
      return;
    }
    this.showSelectionCopyHistoryPicker();
  },


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
  },


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
  },


  selectionActionAnchorRect() {
    if (this.selectionActionState?.rect) return this.selectionActionState.rect;
    const prompt = this.historyOpen ? this.$("history-prompt") : null;
    const view = this.views.get(this.activeId);
    const source = prompt || (view && view.container.classList.contains("visible") ? view.container : null);
    const sourceRect = source?.getBoundingClientRect();
    return sourceRect || { left: window.innerWidth / 2, right: window.innerWidth / 2, top: window.innerHeight / 2,
      bottom: window.innerHeight / 2 };
  },


  positionSelectionCopyHistoryPanel(rect) {
    if (this.$("selection-copy-history-panel")?.classList.contains("hidden")) return;
    this.positionSelectionActions(rect);
  },


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
  },


  fileNameSearchQueryFromSelection(text) {
    const normalized = String(text || "").replace(/\r/g, "").replace(/\s*\/\s*/g, "/").trim();
    if (!normalized) return "";
    const candidates = normalized.match(/(?:[A-Za-z0-9_.~-]+\/)*[A-Za-z0-9_.~-]+(?:\.[A-Za-z0-9_-]+)?(?::\d+(?::\d+)?)?/g) || [];
    const fileCandidate = candidates.filter((candidate) => candidate.includes("/") || candidate.includes(".")).sort((left, right) => right.length - left.length)[0];
    const fallback = normalized.split(/\s+/).pop() || "";
    return (fileCandidate || fallback).replace(/:\d+(?::\d+)?$/, "").replace(/^[([{<]+|[)\]}>.,;]+$/g, "");
  },


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
  },


  selectedTextForAutomaticSearch() {
    const state = this.selectionActionState || this.readSelectionActionState();
    if (!state) return "";
    this.selectionActionState = state;
    const query = this.normalizeSelectionText(state.rawText || state.text);
    if (!query || query.includes("\n") || query.length > SELECTION_SEARCH_MAX_CHARS) return "";
    return query;
  },


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
  },


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
  },


  recentAgentSessionsForContextMenu() {
    return this.sessions.filter((session) => session.agent_kind && session.agent_kind !== "none" &&
      (session.running || session.dormant)).sort((left, right) => {
      const activityDifference = this.sessionActivityTime(right) - this.sessionActivityTime(left);
      if (activityDifference) return activityDifference;
      return this.agentSessionContextLabel(left).localeCompare(this.agentSessionContextLabel(right));
    });
  },


  agentSessionContextLabel(session) {
    const title = this.titlePresentation(session).text.trim();
    const cwd = String(session.cwd || "").replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop() || "";
    const name = title || cwd || session.session_id;
    return this.agentLabel(session.agent_kind, session.agent_kind) + " · " + name;
  },


  pasteSelectionIntoAgent(sessionId, text = "") {
    const value = this.normalizeSelectionText(text || this.selectionActionState?.text);
    const session = this.session(sessionId);
    if (!value || !session || !session.agent_kind || session.agent_kind === "none" ||
        (!session.running && !session.dormant)) return false;
    const useHistoryComposer = this.historyOpen;
    this.hideSelectionActions(true);
    this.activate(sessionId, { reveal: true });
    const view = this.views.get(sessionId) || this.ensureView(sessionId);
    if (useHistoryComposer && this.sessionSupportsTranscript(session)) {
      if (!this.historyOpen) this.setHistoryMode(true);
      this.appendTextToHistoryPrompt(value);
      this.$("status-name").textContent = "selected text added to transcript composer for " + this.agentSessionContextLabel(session);
      return true;
    }
    if (!this.queuePendingAgentPaste(view, value)) return false;
    if (!view.ws) this.connect(sessionId, view);
    this.$("status-name").textContent = "selected text queued for " + this.agentSessionContextLabel(session);
    return true;
  },


  openNewAgentFromSelection(text = "") {
    const value = this.normalizeSelectionText(text || this.selectionActionState?.text);
    if (!value) return false;
    this.hideSelectionActions(true);
    this.openModal(null, null, value, { useHistoryComposer: this.historyOpen });
    return true;
  },


  pasteSelectionIntoNewAgentWhenReady(sessionId, text, expectedTitle = "") {
    const value = this.normalizeSelectionText(text);
    if (!sessionId || !value) return false;
    const view = this.views.get(sessionId) || this.ensureView(sessionId);
    if (!this.queuePendingAgentPaste(view, value, { requireComposer: true, expectedTitle })) return false;
    if (!view.ws) this.connect(sessionId, view);
    this.$("status-name").textContent = "waiting for the new agent to accept selected text";
    return true;
  },


  appendTextToHistoryPrompt(text) {
    const value = this.normalizeSelectionText(text);
    if (!value) return;
    if (!this.historyOpen) this.setHistoryMode(true);
    const view = this.sessionInteractionState(this.activeId);
    const prompt = this.$("history-prompt");
    if (!view || !prompt || !this.historyOpen) return;
    const current = String(prompt.value || view.markdownPromptDraft || "").trimEnd();
    this.persistMarkdownPromptDraft(view, current ? `${current}\n\n${value}\n\n` : `${value}\n\n`);
    this.showPromptDraft(view);
    prompt.focus();
    prompt.setSelectionRange(prompt.value.length, prompt.value.length);
  },


  pasteSelectionCopyHistory(text) {
    this.insertSelectionCopyHistory(text, false);
  },


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
  },


  async prepareNotebookSelectionEdit() {
    await this.flushNotebook();
    this.notebookCopiesOpen = false;
    if (this.notebookEditor) this.notebookEditor.setModel(null);
    this.notebookMounted = false;
    this.normalizeNotebookNotes();
  },


  openNotebookAfterSelectionEdit(status) {
    const fallback = this.$("notebook-editor-host")?.querySelector(".notes-area");
    if (fallback) fallback.value = this.activeNotebookNote()?.text || "";
    this.settings.notebook_open = true;
    this.renderNotebook();
    this.saveNotebookProjectState();
    this.persistNotebookOpenState();
    void this.mountNotebookEditor().then(() => this.focusNotebookEditor());
    this.$("status-name").textContent = status;
  },


  async createNotebookNoteFromSelection() {
    const state = this.selectionActionState;
    if (!state) return;
    const text = state.text;
    this.hideSelectionActions(true);
    await this.prepareNotebookSelectionEdit();
    const note = { note_id: this.createNotebookNoteId(), text: `${text}\n` };
    const notebookState = this.notebookProjectState();
    notebookState.notebook_notes.push(note);
    notebookState.notebook_active_note_id = note.note_id;
    notebookState.notebook_notes_initialized = true;
    notebookState.notebook_text = note.text;
    this.openNotebookAfterSelectionEdit("selection added as new note");
  },


  async appendSelectionToNotebook() {
    const state = this.selectionActionState;
    if (!state) return;
    const text = state.text;
    this.hideSelectionActions(true);
    await this.prepareNotebookSelectionEdit();
    let note = this.activeNotebookNote();
    const notebookState = this.notebookProjectState();
    if (!note) {
      note = { note_id: this.createNotebookNoteId(), text: "" };
      notebookState.notebook_notes.push(note);
      notebookState.notebook_active_note_id = note.note_id;
      notebookState.notebook_notes_initialized = true;
    }
    const current = String(note.text || "").trimEnd();
    note.text = current ? `${current}\n\n${text}\n` : `${text}\n`;
    notebookState.notebook_text = note.text;
    const fallback = this.$("notebook-editor-host")?.querySelector(".notes-area");
    if (fallback) fallback.value = note.text;
    this.openNotebookAfterSelectionEdit("selection appended to note");
  },


  createNotebookNoteId() {
    return `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  },


  notebookProjectStateKey() {
    return this.projectSlug || "__all__";
  },


  notebookOpenSessionKey() {
    return `termdeck.notebook_open.${this.projectSlug || "__all__"}`;
  },


  readNotebookOpenState() {
    try {
      return window.sessionStorage.getItem(this.notebookOpenSessionKey()) === "1";
    } catch (error) {
      return false;
    }
  },


  persistNotebookOpenState() {
    try {
      window.sessionStorage.setItem(this.notebookOpenSessionKey(), this.settings.notebook_open ? "1" : "0");
    } catch (error) {
      return;
    }
  },


  notebookProjectState() {
    const stateKey = this.notebookProjectStateKey();
    const states = this.settings.project_state || {};
    states[stateKey] = states[stateKey] || {};
    this.settings.project_state = states;
    return states[stateKey];
  },


  saveNotebookProjectState() {
    const stateKey = this.notebookProjectStateKey();
    const notebookState = this.notebookProjectState();
    const patch = {
      notebook_notes: notebookState.notebook_notes || [],
      notebook_active_note_id: notebookState.notebook_active_note_id || "",
      notebook_notes_initialized: !!notebookState.notebook_notes_initialized,
      notebook_text: notebookState.notebook_text || "",
    };
    this.applyLocalProjectStatePatch(patch, stateKey);
    this.queueProjectResourceRequest(stateKey, "/api/terminal-layout", "PATCH", patch);
  },


  projectSelectionCopyHistory() {
    const history = this.notebookProjectState().selection_copy_history;
    return Array.isArray(history) ? history : [];
  },


  normalizeProjectSelectionCopyHistory() {
    const notebookState = this.notebookProjectState();
    if (notebookState.selection_copy_history_initialized === true) return false;
    const legacyHistory = Array.isArray(this.settings.selection_copy_history) ? this.settings.selection_copy_history : [];
    notebookState.selection_copy_history = [...new Set(legacyHistory.map((item) => String(item || "").trim()).filter(Boolean))].slice(0, 50);
    notebookState.selection_copy_history_initialized = true;
    this.settings.selection_copy_history = [];
    return true;
  },


  saveProjectSelectionCopyHistory() {
    const stateKey = this.notebookProjectStateKey();
    const notebookState = this.notebookProjectState();
    const patch = {
      selection_copy_history: this.projectSelectionCopyHistory(),
      selection_copy_history_initialized: true,
    };
    notebookState.selection_copy_history_initialized = true;
    this.applyLocalProjectStatePatch(patch, stateKey);
    this.queueProjectResourceRequest(stateKey, "/api/terminal-layout", "PATCH", patch);
  },


  normalizeNotebookNotes() {
    const notebookState = this.notebookProjectState();
    const scopedInitialized = notebookState.notebook_notes_initialized === true;
    const legacyNotes = Array.isArray(this.settings.notebook_notes) ? this.settings.notebook_notes : [];
    const hasLegacyNotebook = !scopedInitialized && (this.settings.notebook_notes_initialized === true ||
      legacyNotes.length > 0 || String(this.settings.notebook_text || "").length > 0);
    const sourcePresent = Array.isArray(notebookState.notebook_notes) || hasLegacyNotebook;
    const source = hasLegacyNotebook ? legacyNotes : Array.isArray(notebookState.notebook_notes) ? notebookState.notebook_notes : [];
    const sourceActiveNoteId = hasLegacyNotebook ? this.settings.notebook_active_note_id : notebookState.notebook_active_note_id;
    const sourceNotebookText = hasLegacyNotebook ? this.settings.notebook_text : notebookState.notebook_text;
    const seen = new Set();
    const notes = [];
    for (const raw of source) {
      const noteId = String(raw?.note_id || raw?.id || "").trim();
      if (!noteId || seen.has(noteId)) continue;
      seen.add(noteId);
      notes.push({ note_id: noteId, text: String(raw?.text || "") });
    }
    if (!notes.length && (!scopedInitialized || hasLegacyNotebook)) {
      notes.push({ note_id: this.createNotebookNoteId(), text: String(sourceNotebookText || "") });
    }
    const activeNoteId = notes.some((note) => note.note_id === sourceActiveNoteId)
      ? sourceActiveNoteId : notes[0]?.note_id || "";
    const active = notes.find((note) => note.note_id === activeNoteId) || null;
    const changed = JSON.stringify(source) !== JSON.stringify(notes) || notebookState.notebook_active_note_id !== activeNoteId ||
      notebookState.notebook_text !== (active?.text || "") || !sourcePresent || !scopedInitialized || hasLegacyNotebook;
    notebookState.notebook_notes = notes;
    notebookState.notebook_active_note_id = activeNoteId;
    notebookState.notebook_text = active?.text || "";
    notebookState.notebook_notes_initialized = true;
    if (hasLegacyNotebook) {
      this.settings.notebook_notes = [];
      this.settings.notebook_active_note_id = "";
      this.settings.notebook_text = "";
      this.settings.notebook_notes_initialized = false;
    }
    return changed;
  },


  activeNotebookNote() {
    this.normalizeNotebookNotes();
    const notebookState = this.notebookProjectState();
    return notebookState.notebook_notes.find((note) => note.note_id === notebookState.notebook_active_note_id) || null;
  },


  notebookTabTitle(note) {
    const source = String(note?.text || "").replace(/!\[[^\]]*\]\([^)]*\)|\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[`*_~>#]/g, " ").replace(/\s+/g, " ").trim();
    const words = source.split(" ").filter(Boolean).slice(0, 6);
    return words.length ? words.join(" ") : "Untitled note";
  },


  renderNotebookTabs() {
    const tabs = this.$("notebook-tabs");
    if (!tabs) return;
    this.normalizeNotebookNotes();
    const notebookState = this.notebookProjectState();
    tabs.textContent = "";
    for (const note of notebookState.notebook_notes) {
      const tab = document.createElement("div");
      const active = !this.notebookCopiesOpen && note.note_id === notebookState.notebook_active_note_id;
      tab.className = "notebook-tab" + (active ? " active" : "");
      tab.dataset.noteId = note.note_id;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(active));
      const label = document.createElement("button");
      label.type = "button";
      label.className = "notebook-tab-label";
      label.title = this.notebookTabTitle(note);
      label.textContent = this.notebookTabTitle(note);
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
      if (note.note_id === notebookState.notebook_active_note_id) requestAnimationFrame(() => tab.scrollIntoView({ block: "nearest", inline: "nearest" }));
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
    const history = this.projectSelectionCopyHistory();
    copiedCount.textContent = history.length ? String(history.length) : "";
    copiedTab.append(copiedIcon, copiedLabel, copiedCount);
    copiedTab.onclick = () => this.selectNotebookCopies();
    tabs.appendChild(copiedTab);
  },


  renderNotebookRecentCopies() {
    const items = this.$("notebook-recent-copies-items");
    const count = this.$("notebook-recent-copies-count");
    if (!items || !count) return;
    const history = this.projectSelectionCopyHistory();
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
  },


  setActiveNotebookText(text, save = true, renderTitle = true) {
    const note = this.activeNotebookNote();
    if (!note) return;
    const normalizedText = String(text || "");
    const changed = note.text !== normalizedText;
    note.text = normalizedText;
    this.notebookProjectState().notebook_text = normalizedText;
    if (changed && renderTitle) this.renderNotebookTabs();
    if (save) this.saveNotebookProjectState();
  },


  selectNotebookCopies() {
    if (this.notebookCopiesOpen) {
      this.setNotebookOpen(false);
      return;
    }
    this.notebookCopiesOpen = true;
    this.closeNotebookFind(false);
    this.renderNotebook();
  },


  activeNotebookText() {
    const note = this.activeNotebookNote();
    if (!note) return "";
    const model = this.notebookEditor?.getModel();
    const notebookModel = this.notebookEditorModels.get(note.note_id);
    return model && model === notebookModel ? this.notebookEditor.getValue() : note.text;
  },


  notebookModelForNote(note) {
    let model = this.notebookEditorModels.get(note.note_id);
    if (!model) {
      const uri = monaco.Uri.parse(`inmemory://termdeck/notebook/${encodeURIComponent(note.note_id)}.txt`);
      model = monaco.editor.createModel(note.text, "plaintext", uri);
      this.notebookEditorModels.set(note.note_id, model);
    } else if (model.getValue() !== note.text && this.notebookEditor?.getModel() !== model) {
      // Only a model that is NOT on screen may be reset from the stored text. The model the user is
      // typing into holds the newest version of the note; the stored text is only as fresh as the
      // last flush. Overwriting it here threw away every unsaved edit, and mountNotebookEditor runs
      // from nine places -- opening the notebook, re-rendering, selecting a tab -- so a sentence
      // vanished on the next thing that touched the panel. An external change to the note on screen
      // (appending a selection to it) sets the model's value at its own call site.
      model.setValue(note.text);
    }
    return model;
  },


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
  },


  flushNotebook() {
    if (!this.notebookEditor || !this.notebookMounted) return Promise.resolve();
    this.setActiveNotebookText(this.activeNotebookText());
    return Promise.resolve();
  },


  collapseNotebookEditorSelection() {
    const selection = this.notebookEditor?.getSelection();
    if (!selection || selection.isEmpty) return;
    this.notebookEditor.setPosition({ lineNumber: selection.endLineNumber, column: selection.endColumn });
  },


  async selectNotebookNote(noteId) {
    this.normalizeNotebookNotes();
    const notebookState = this.notebookProjectState();
    this.notebookCopiesOpen = false;
    this.collapseNotebookEditorSelection();
    this.hideSelectionActions(true);
    if (!notebookState.notebook_notes.some((note) => note.note_id === noteId) || noteId === notebookState.notebook_active_note_id) {
      this.renderNotebook();
      void this.mountNotebookEditor();
      this.focusNotebookEditor();
      return;
    }
    const currentNote = this.activeNotebookNote();
    const currentModel = currentNote ? this.notebookEditorModels.get(currentNote.note_id) : null;
    if (currentNote && currentModel && this.notebookEditor?.getModel() === currentModel) {
      currentNote.text = this.notebookEditor.getValue();
    }
    notebookState.notebook_active_note_id = noteId;
    notebookState.notebook_text = this.activeNotebookNote()?.text || "";
    this.notebookSearchIndex = 0;
    this.notebookMounted = false;
    this.saveNotebookProjectState();
    this.renderNotebookTabs();
    await this.mountNotebookEditor();
    this.collapseNotebookEditorSelection();
    this.renderNotebook();
    this.focusNotebookEditor();
  },


  async closeNotebookNote(noteId) {
    this.normalizeNotebookNotes();
    const notebookState = this.notebookProjectState();
    const index = notebookState.notebook_notes.findIndex((note) => note.note_id === noteId);
    if (index < 0) return;
    const wasActive = noteId === notebookState.notebook_active_note_id;
    if (wasActive) await this.flushNotebook();
    const note = notebookState.notebook_notes[index];
    const title = this.notebookTabTitle(note);
    if (!await uiConfirm(`Move "${title}" to the macOS Trash?`)) return;
    const response = await fetch("/api/notebook/trash", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, content: note.text }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      void uiAlert(error.detail || "could not move note to Trash");
      return;
    }
    const notes = notebookState.notebook_notes.filter((note) => note.note_id !== noteId);
    const next = wasActive ? notes[Math.min(index, notes.length - 1)] || null : this.activeNotebookNote();
    if (wasActive) {
      if (this.notebookEditor) this.notebookEditor.setModel(null);
      this.notebookMounted = false;
    }
    const model = this.notebookEditorModels.get(noteId);
    if (model) model.dispose();
    this.notebookEditorModels.delete(noteId);
    notebookState.notebook_notes = notes;
    notebookState.notebook_active_note_id = next?.note_id || "";
    notebookState.notebook_text = next?.text || "";
    notebookState.notebook_notes_initialized = true;
    this.notebookSearchIndex = 0;
    this.renderNotebook();
    this.saveNotebookProjectState();
    if (next && wasActive) {
      await this.mountNotebookEditor();
      this.focusNotebookEditor();
    }
  },


  async createNotebookNote() {
    await this.flushNotebook();
    const note = { note_id: this.createNotebookNoteId(), text: "" };
    const notebookState = this.notebookProjectState();
    notebookState.notebook_notes.push(note);
    this.notebookCopiesOpen = false;
    if (this.notebookEditor) this.notebookEditor.setModel(null);
    this.notebookMounted = false;
    notebookState.notebook_active_note_id = note.note_id;
    notebookState.notebook_text = note.text;
    this.notebookSearchIndex = 0;
    this.renderNotebook();
    this.saveNotebookProjectState();
    await this.mountNotebookEditor();
    this.focusNotebookEditor();
  },


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
  },


  updateNotebookSearchState(reset = false) {
    const matches = this.notebookSearchMatches();
    if (reset) this.notebookSearchIndex = 0;
    if (!matches.length) this.notebookSearchIndex = 0;
    else this.notebookSearchIndex = Math.max(0, Math.min(this.notebookSearchIndex, matches.length - 1));
    const count = this.$("notebook-find-count");
    if (count) count.textContent = matches.length ? `${this.notebookSearchIndex + 1} / ${matches.length}` :
      (this.$("notebook-find-query").value ? "0 / 0" : "");
    return matches;
  },


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
  },


  closeNotebookFind(focusEditor = false) {
    this.$("notebook-find-bar").classList.add("hidden");
    this.$("notebook-replace-row").classList.add("hidden");
    this.$("notebook-replace-toggle").classList.remove("on");
    if (focusEditor) this.focusNotebookEditor();
  },


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
  },


  stepNotebookSearch(direction) {
    const matches = this.updateNotebookSearchState();
    if (!matches.length) return;
    this.notebookSearchIndex = (this.notebookSearchIndex + direction + matches.length) % matches.length;
    this.updateNotebookSearchState();
  },


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
  },


  renderNotebook() {
    const panel = this.$("notebook-panel");
    const toggles = [this.$("notebook-toggle"), this.$("history-notebook-toggle"), this.$("file-tabs-notebook"),
      this.$("mobile-notebook-toggle")].filter(Boolean);
    if (!panel || !toggles.length) return;
    const notebookOpen = !!this.settings.notebook_open;
    document.body.classList.toggle("notebook-open", notebookOpen);
    panel.classList.toggle("notebook-over-file-area",
      this.activeFileKey !== null || FILES_SIDE_PANEL_TABS.includes(this.sideView));
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
    for (const toggle of toggles) {
      toggle.classList.toggle("on", notebookOpen);
      toggle.setAttribute("aria-pressed", String(notebookOpen));
    }
    if (notebookOpen && this.activeNotebookNote() && !this.notebookMounted) {
      void this.mountNotebookEditor();
    }
    this.updateEventlyDemoFeatureBanner();
  },


  finishNotebookClose() {
    this.notebookCloseTimer = null;
    if (this.settings.notebook_open) return;
    const panel = this.$("notebook-panel");
    if (!panel) return;
    panel.classList.add("hidden");
    panel.classList.remove("notebook-closing");
  },


  startNotebookResize(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    this.notebookResizePointerId = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add("dragging-notebook");
  },


  resizeNotebookFromPointer(event) {
    if (event.pointerId !== this.notebookResizePointerId) return;
    const minimumLeft = 0;
    const maximumLeft = Math.max(minimumLeft, window.innerWidth - 334);
    this.settings.notebook_left = Math.max(minimumLeft, Math.min(maximumLeft, Math.round(event.clientX)));
    document.documentElement.style.setProperty("--notebook-panel-left", `${this.settings.notebook_left}px`);
  },


  finishNotebookResize(event) {
    if (event.pointerId !== this.notebookResizePointerId) return;
    this.notebookResizePointerId = null;
    document.body.classList.remove("dragging-notebook");
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    this.saveSettings();
  },


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
    this.persistNotebookOpenState();
    if (!shouldOpen && options.focus !== false) requestAnimationFrame(() => this.focusActiveEditor());
    if (this.settings.notebook_open && options.focus !== false) {
      requestAnimationFrame(() => this.focusNotebookEditor());
    }
  },


  toggleNotebook() {
    this.setNotebookOpen(!this.settings.notebook_open, { focus: true });
  },


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
  },


  activate(id, options = {}) {
    this.closePromptHistory();
    this.closeHistorySendMenu();
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
    void this.refreshSessionUsage(id);
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
    if (this.fileHistoryOpen) this.deactivateFileHistoryTab();
    this.saveActiveFileViewState();
    this.lspClient?.deactivate();
    this.activeFileKey = null;
    this.stopHistoryRefresh();
    this.disconnectHistoryStream();
    this.closeHistorySlashMenu();
    this.historyOpen = false;
    this.historyFingerprint = "";
    const cachedHistory = this.historyTurnsBySession.get(id) || [];
    this.historyTurns = cachedHistory;
    this.historyRenderedTurns = [];
    this.historyLoaded = cachedHistory.length > 0;
    const previousView = previousId ? this.views.get(previousId) : null;
    this.activeId = id;
    this.updateEventlyDemoFeatureBanner();
    this.updateRecentFilesWatch();
    this.historyOpen = this.selectedHistoryMode(selected);
    if (options.history !== false) this.pushNav({ kind: "term", id });
    this.updateSizeOwnershipIndicator(this.views.get(id));
    if (this.getProjectState().active_session_id !== id) {
      this.patchProjectState({ active_session_id: id });
    }
    const s = this.session(id);
    this.postVscodeNativeSession(s, !this.historyOpen);
    if (s && this.treeRoot !== null && this.treeRoot !== s.cwd && !this.$("files-section").classList.contains("hidden")) {
      this.reloadTree();
    }
    const view = this.historyOpen ? this.ensureTranscriptSessionState(id) : this.ensureView(id);
    if (view.promptQueue?.length) this.dispatchNextMarkdownPrompt(view);
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
      this.showPromptDraft(view);
      if (previousId !== id) {
        // Do not leave the previous tab's transcript rendered while a fork's
        // authoritative snapshot is being loaded.
        this.historyTurns = [];
        this.historyRenderedTurns = [];
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
    if (view?.term && !this.historyOpen) {
      this.drainTerminalWrites(view);
      this.scheduleV2ViewportSync(view);
      this.prepareTerminalForFirstPaint(view);
      this.scheduleClaudeWebglColdPrimeCompletion(view);
      if (this.isTerminalScrollV2() && !view.userScrollIntent) view.scrollMode = "follow";
      this.refreshTerminalAppearance(view);
      const terminalSocketSuspended = this.suspendMobileTranscriptTerminalSocket(view);
      if (options.startDormant !== false && !terminalSocketSuspended) {
        if (!view.ws) this.connect(id, view);
      }
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
          const forceFit = previousId !== id || this.shouldForceTerminalActivationReflow(view);
          this.scheduleV2Fit(view, { force: forceFit });
          this.scheduleInitialV2Fit(view);
          if (view.scrollMode === "follow") this.scrollTerminalV2ToBottom(view);
          this.scheduleTerminalActivationRepair(view, {
            forceReflow: this.shouldForceTerminalActivationReflow(view),
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
  },
});
