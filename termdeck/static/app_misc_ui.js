// Split from app.js (2026-08-26): keybindings, process report, search history, file search UI.
// Same class, split across files: this attaches methods to TermdeckApp.prototype, and
// index.html loads the app_*.js files after app.js and before app_boot.js.
Object.assign(TermdeckApp.prototype, {


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
  },


  openKeybindings() {
    const search = this.$("keys-search");
    search.value = "";
    this.renderKeybindingsList();
    this.$("keys-backdrop").classList.remove("hidden");
    requestAnimationFrame(() => search.focus());
  },


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
  },


  resetKeybindings() {
    this.settings[this.keybindingsStorageKey()] = {};
    this.saveSettings();
    this.openKeybindings();
  },


  exportSettings() {
    const blob = new Blob([JSON.stringify(this.settings, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "termdeck-settings.json";
    a.click();
    URL.revokeObjectURL(url);
  },


  async killAllRunningTerminals() {
    const message = "Kill all running terminals, including detached sessions? This stops only terminal processes; " +
      "session tabs, transcripts, and history are preserved.";
    const confirmed = await uiConfirm(message);
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
  },


  // Ownership is read off the menu's own content rather than a flag: every other opener rebuilds
  // #context-menu from scratch, so its heading disappears on its own and can never go stale.
  statsMaintenanceMenuOpen() {
    const menu = this.$("context-menu");
    return !menu.classList.contains("hidden") && !!menu.querySelector(".stats-maintenance-title");
  },


  toggleStatsMaintenanceMenu(anchor) {
    if (this.statsMaintenanceMenuOpen()) this.$("context-menu").classList.add("hidden");
    else this.openStatsMaintenanceMenu(anchor);
  },


  // Maintenance hangs off the CPU/memory readout: the actions are all about what the server is
  // spending that CPU and memory on, so they live where you notice the number is wrong.
  openStatsMaintenanceMenu(anchor) {
    const menu = this.$("context-menu");
    menu.textContent = "";
    menu.classList.remove("hidden");
    const title = document.createElement("div");
    title.className = "file-tab-settings-title stats-maintenance-title";
    title.textContent = "Maintenance";
    menu.appendChild(title);
    this.addContextItem(menu, "Terminal process report", () => void this.showTerminalProcessReport(), "list-tree");
    this.addContextItem(menu, "Reclaim orphan terminals", () => void this.reclaimOrphanTerminals(), "debug-disconnect");
    this.addContextItem(menu, "Kill terminals older than 24 hours", () => void this.killStaleTerminals(), "trash");
    this.addContextItem(menu, "Kill all running terminals", () => void this.killAllRunningTerminals(), "close-all");
    // Diagnostics belong here for the same reason the rest do: this is where you come when the app is
    // misbehaving. Off by default and free when off -- see toggleDiagnosticsRecorder.
    this.addContextItem(menu,
      this.diagnosticsRecording() ? "Stop recording diagnostics" : "Record diagnostics for a bug report",
      () => this.toggleDiagnosticsRecorder(),
      this.diagnosticsRecording() ? "debug-stop" : "record");
    const rect = anchor.getBoundingClientRect();
    this.positionContextMenu(menu, rect.right - menu.offsetWidth, rect.top - menu.offsetHeight - 4);
  },


  async killStaleTerminals() {
    const message = "Stop running terminals older than 24 hours? Their tabs and session information will stay available for reattach.";
    if (!await uiConfirm(message)) return;
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
    }
  },


  closeTerminalProcessReport() {
    this.$("terminal-process-report-backdrop").classList.add("hidden");
  },


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
  },


  formatTerminalProcessReport(report) {
    const summary = report.summary || {};
    const entries = Array.isArray(report.sockets) ? report.sockets : [];
    const liveSockets = Number(summary.live_sockets || 0);
    const header = `${liveSockets} live socket${liveSockets === 1 ? "" : "s"} · ` +
      `${summary.processes || 0} processes · ${summary.node_repl_processes || 0} node_repl · ` +
      `${summary.zombie_processes || 0} zombies · ${summary.orphan_sockets || 0} orphan sockets`;
    const body = entries.length ? entries.map((entry) => this.formatTerminalProcessReportEntry(entry)).join("\n\n") : "No TermDeck dtach sockets found.";
    return { header, body, entries };
  },


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
  },


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
      const confirmed = await uiConfirm([`Reclaim ${orphans.length} orphaned TermDeck socket${orphans.length === 1 ? "" : "s"}?`,
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
  },


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
  },


  isRecentTerminalsShortcut(e) {
    if (this.vscodeMode || e.altKey || e.shiftKey || e.metaKey === e.ctrlKey || e.key.toLowerCase() !== "e") return false;
    const mappedAction = this.bindingMap()[this.eventToBinding(e)];
    return !mappedAction || mappedAction === "recent-terminals";
  },


  isDesktopTerminalSelectInputEvent(e) {
    return !this.vscodeMode && e.metaKey && !e.shiftKey && !e.ctrlKey && !e.altKey &&
      (e.code === "KeyA" || String(e.key || "").toLowerCase() === "a") &&
      this.activeFileKey === null && !this.historyOpen && !!this.views.get(this.activeId) &&
      !!e.target?.closest?.(".xterm");
  },


  isDesktopTerminalSelectAllEvent(e) {
    return !this.vscodeMode && this.bindingFor("select-terminal-all") === "Meta+Shift+a" &&
      e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey &&
      (e.code === "KeyA" || String(e.key || "").toLowerCase() === "a") &&
      this.activeFileKey === null && !this.historyOpen && !!this.views.get(this.activeId) &&
      !!e.target?.closest?.(".xterm");
  },


  handleCodexCommandTranscriptShortcut(e, view = this.views.get(this.activeId)) {
    if (e.type !== "keydown" || !e.ctrlKey || e.metaKey || e.altKey || e.shiftKey ||
        String(e.key || "").toLowerCase() !== "t" || e.termdeckCodexTranscriptHandled) return false;
    if (!view || view.closed || this.activeFileKey !== null || this.historyOpen ||
        !this.agentBehavior(this.session(view.sessionId)?.agent_kind)?.commandTranscriptShortcut) return false;
    const visibleTextInput = this.isTypingTarget(e) && !e.target?.closest?.(".xterm") && e.target?.offsetParent !== null;
    if (visibleTextInput || ["keys-backdrop", "modal-backdrop", "worktree-result-backdrop", "worktree-modal-backdrop"]
        .some((id) => this.$(id)?.classList.contains("hidden") === false)) return false;
    e.termdeckCodexTranscriptHandled = true;
    e.preventDefault();
    e.stopPropagation();
    view.tallFollowing = true;
    this.sendTrackedInput(view, "\x14");
    this.scheduleTallGeometrySettle(view, TALL_SCROLL_SETTLE_MS);
    view.term.focus();
    return true;
  },


  bindingFor(actionId) {
    const definition = this.keybindingDefinitions().find((k) => k.id === actionId);
    return (this.settings[this.keybindingsStorageKey()] || {})[actionId] || definition?.def || "";
  },


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
  },


  tryAppShortcut(e) {
    const binding = this.eventToBinding(e);
    const actionId = binding ? this.bindingMap()[binding] : "";
    if (actionId) {
      if (FILE_HISTORY_SHORTCUT_ACTIONS.has(actionId) && !this.fileHistoryActiveComparison?.isDiff) return false;
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
  },


  closeContextMenu() {
    const menu = this.$("context-menu");
    if (menu) menu.classList.add("hidden");
    this.contextMenuTarget = null;
  },


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
  },


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
    else if (actionId === "toggle-diagnostics-recording") this.toggleDiagnosticsRecorder();
    else if (actionId === "save-file") { if (this.activeFileKey !== null) this.saveActiveFile(); }
    else if (actionId === "file-history-previous-change") this.navigateFileHistoryDiff(-1);
    else if (actionId === "file-history-next-change") this.navigateFileHistoryDiff(1);
    else if (actionId === "file-history-apply-change") this.applyFileHistoryDiffBlockToCurrent();
    else if (actionId === "prev-terminal") this.cycleTerminal(-1);
    else if (actionId === "next-terminal") this.cycleTerminal(1);
    else if (actionId === "cycle-side-panel") this.cycleFilesSidePanel();
    else if (actionId === "open-files-panel") this.openFilesSidePanelView("project");
    else if (actionId === "open-file-search") this.openFilesSidePanelView("search");
    else if (actionId === "open-git-panel") this.openFilesSidePanelView("git");
    else if (actionId === "open-files-new-tab") this.openFileDeckViewInNewTab(this.treeRoot || this.projectRoot(), "tree");
    else if (actionId === "open-search-new-tab") this.openFileDeckViewInNewTab(this.treeRoot || this.projectRoot(), "search", "", this.$("search-query").value.trim());
    else if (actionId === "open-terminal-search") this.toggleTerminalSearchEditor();
    else if (actionId === "view-terminals") this.handleFileModeNavigationClick("terminals");
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
    else if (actionId === "conversation-outline") this.toggleContextualOutline();
    else if (actionId === "vscode-refresh") this.requestVscodeRefresh(false);
    else if (actionId === "vscode-reload") this.requestVscodeRefresh(true);
  },


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
  },


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
  },


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
  },


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
  },


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
  },


  bindingToDisplay(binding) {
    const symbols = IS_MAC_KEYBOARD_PLATFORM
      ? { Meta: "⌘", Shift: "⇧", Alt: "⌥", Ctrl: "⌃", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Backspace: "⌫", Enter: "⏎", Escape: "esc" }
      : { Meta: "Ctrl", Shift: "Shift", Alt: "Alt", Ctrl: "Ctrl", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Backspace: "Backspace", Enter: "Enter", Escape: "Esc" };
    return binding.split("+").map((part) => symbols[part] || part.toUpperCase()).join(IS_MAC_KEYBOARD_PLATFORM ? "" : "+");
  },


  cycleTerminal(delta) {
    if (!this.sessions.length) return;
    const ids = this.sessions.map((s) => s.session_id);
    const current = ids.indexOf(this.activeId);
    const next = current === -1 ? 0 : (current + delta + ids.length) % ids.length;
    // Keyboard cycling may move past the visible portion of the sidebar.
    // Reveal only this newly selected row; ordinary clicks and browser
    // history navigation should not continually reposition the sidebar.
    this.activate(ids[next], { history: false, reveal: true });
  },


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
  },


  stripTitleStatusPrefixes(title) {
    let text = String(title || "");
    while (TITLE_STATUS_PREFIX_RE.test(text)) text = text.replace(TITLE_STATUS_PREFIX_RE, "");
    return text.trim();
  },


  async forkSession(s) {
    const baseTitle = this.stripTitleStatusPrefixes(this.effectiveTitle(s)) || "terminal";
    const rawValue = await uiPrompt(`Fork "${baseTitle}": enter a number from 1 to ${MAX_FORK_COUNT}, or enter a name for one fork.`, "1");
    if (rawValue === null || !rawValue.trim()) return;
    const value = rawValue.trim();
    if (!/^\d+$/.test(value)) {
      await this.createForkedSessions(s, [value]);
      return;
    }
    const count = Number.parseInt(value, 10);
    if (count < 1 || count > MAX_FORK_COUNT) {
      void uiAlert(`Enter a whole number from 1 to ${MAX_FORK_COUNT}, or a name for one fork.`);
      return;
    }
    await this.createForkedSessions(s, Array.from({ length: count }, (_unused, index) => `${baseTitle} ${index + 1}`));
  },


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
      void uiAlert("fork failed");
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
    if (failedAt) void uiAlert(`Forked ${created.length} of ${titles.length}; fork ${failedAt} failed.`);
  },


  async restartSession(sessionId, permission = "") {
    const wasDormant = !!this.session(sessionId)?.dormant;
    this.activate(sessionId, { startDormant: false });
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
    await this.refresh();
    if (wasDormant && this.activeId === sessionId) {
      const restartedView = this.views.get(sessionId);
      if (restartedView && !restartedView.ws) this.connect(sessionId, restartedView);
    }
  },


  async stopSession(sessionId) {
    const session = this.session(sessionId);
    if (!session?.running) return;
    this.$("status-name").textContent = "stopping…";
    const response = await fetch(`/api/sessions/${sessionId}/stop`, { method: "POST" });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      this.$("status-name").textContent = detail?.detail || "stop failed";
      return;
    }
    await this.refresh();
    this.$("status-name").textContent = "stopped";
  },


  async closeSession(sessionId) {
    const s = this.session(sessionId);
    if (!s) return;
    if (!await uiConfirm(`Close "${this.effectiveTitle(s)}"? This kills the process (it moves to closed history).`)) return;
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
  },


  async closeSelectedSessions(sessionIds) {
    const selectedSessions = [...new Set(sessionIds)].map((sessionId) => this.session(sessionId)).filter(Boolean);
    if (!selectedSessions.length) return;
    if (!await uiConfirm(`Close ${selectedSessions.length} selected terminals? This kills their processes and moves them to closed history.`)) return;
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
  },


  closeActive() {
    if (this.activeFileKey === null && this.activeId) this.closeSession(this.activeId);
  },


  async renameSession(s) {
    const title = await uiPrompt("Rename terminal", this.effectiveTitle(s));
    if (!title) return;
    await fetch(`/api/sessions/${s.session_id}/rename`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    this.refresh();
  },


  async moveSessionToProject(session, project) {
    if (!session || !project || project === session.project) return;
    const response = await fetch(`/api/sessions/${session.session_id}/project`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      void uiAlert(error.detail || "move terminal to project failed");
      return;
    }
    if (this.projectSlug && this.projectSlug !== project) {
      location.href = `/p/${encodeURIComponent(project)}`;
      return;
    }
    await this.refresh();
  },


  searchRoot() {
    if (this.vscodeMode && this.vscodeWorkspaceRoot) return this.vscodeWorkspaceRoot;
    const projectRoot = this.worktreeRoot();
    if (projectRoot) return projectRoot;
    const s = this.session(this.activeId);
    return s ? s.cwd : "~";
  },


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
  },


  saveSearchHistory() {
    this.settings.file_search_history = this.searchHistory.slice(-30);
    this.saveSettings();
    localStorage.setItem(SEARCH_HISTORY_STORAGE_KEY, JSON.stringify(this.searchHistory.slice(-30)));
  },


  recordSearch(state) {
    const normalized = { ...state, mode: state.mode || "content" };
    if (this.pendingSearchHistoryState && JSON.stringify(this.pendingSearchHistoryState) === JSON.stringify(normalized)) return;
    this.pendingSearchHistoryState = normalized;
    clearTimeout(this.searchHistoryRecordTimer);
    this.searchHistoryRecordTimer = setTimeout(() => this.commitPendingSearchHistoryRecord(), SEARCH_HISTORY_RECORD_DELAY_MS);
  },


  commitPendingSearchHistoryRecord() {
    this.searchHistoryRecordTimer = 0;
    const pending = this.pendingSearchHistoryState;
    this.pendingSearchHistoryState = null;
    if (!pending) return;
    const last = this.searchHistory[this.searchHistory.length - 1];
    if (last && JSON.stringify(last) === JSON.stringify(pending)) return;
    this.searchHistory.push(pending);
    if (this.searchHistory.length > 30) this.searchHistory.shift();
    this.saveSearchHistory();
  },


  flushPendingSearchHistoryRecord() {
    if (!this.pendingSearchHistoryState) return;
    clearTimeout(this.searchHistoryRecordTimer);
    this.commitPendingSearchHistoryRecord();
  },


  positionSearchHistoryMenu(button) {
    const menu = this.$("search-history-menu");
    const rect = button.getBoundingClientRect();
    const width = Math.min(420, window.innerWidth - 20);
    const left = Math.max(10, Math.min(rect.right - width, window.innerWidth - width - 10));
    const top = rect.bottom + 4;
    menu.style.width = `${width}px`;
    menu.style.left = `${left}px`;
    menu.style.top = `${top + menu.offsetHeight <= window.innerHeight - 10 ? top : Math.max(10, rect.top - menu.offsetHeight - 4)}px`;
  },


  closeSearchHistory() {
    const menu = this.$("search-history-menu");
    menu.classList.add("hidden");
    for (const id of ["search-history-btn", "name-search-history-btn"]) this.$(id)?.setAttribute("aria-expanded", "false");
  },


  splitFileGlobTokens(raw) {
    return String(raw || "").split(",").map((token) => token.trim()).filter(Boolean);
  },


  fileIncludeGlob(mode) {
    return String(this.settings[mode === "tree" ? "tree_file_glob" : "search_file_glob"] || "").trim();
  },


  fileExcludeGlob() {
    return String(this.settings.excluded_file_glob || "").trim();
  },


  fileGlobForMode(mode) {
    return [...this.splitFileGlobTokens(this.fileIncludeGlob(mode)), ...this.fileTypeFilterTokens()].join(", ");
  },


  fileGlobForNameSearch() {
    return this.fileTypeFilterTokens().join(", ");
  },


  updateSearchIncludeGlob(raw) {
    this.settings.search_file_glob = String(raw || "").trim();
    this.syncLegacySearchGlob();
    this.saveSettings();
    if (this.sideView === "search" && this.$("search-query").value.trim()) this.debouncedSearch();
  },


  handleSearchFileGlobInput(event) {
    this.updateSearchIncludeGlob(event.currentTarget.value);
  },


  handleSearchFileGlobKeydown(event) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    clearTimeout(this.searchDebounce);
    if (this.$("search-query").value.trim()) void this.runSearch();
  },


  syncLegacySearchGlob() {
    this.settings.search_glob = this.fileGlobForMode("search");
    const hidden = this.$("search-glob");
    if (hidden) hidden.value = this.settings.search_glob;
  },


  syncFileGlobInputs() {
    const treeInput = this.$("tree-file-glob");
    const searchInput = this.$("search-file-glob");
    if (treeInput) treeInput.value = this.fileIncludeGlob("tree");
    if (searchInput) searchInput.value = this.fileIncludeGlob("search");
    this.syncLegacySearchGlob();
  },


  setFileGlobForMode(mode, raw) {
    const tokens = this.splitFileGlobTokens(raw);
    this.settings[mode === "tree" ? "tree_file_glob" : "search_file_glob"] = tokens.filter((token) => !token.startsWith("!")).join(", ");
    const excluded = tokens.filter((token) => token.startsWith("!"));
    if (excluded.length) this.settings.excluded_file_glob = [...new Set([...this.fileTypeFilterTokens(), ...excluded])].join(", ");
    this.syncFileGlobInputs();
    this.saveSettings();
  },


  fileTypeFilterTokens() {
    return this.splitFileGlobTokens(this.settings.excluded_file_glob || this.settings.search_glob || "").filter((token) => token.startsWith("!"));
  },


  recentFileExcludeTokens() {
    return this.splitFileGlobTokens(this.getProjectState().recent_file_exclude_glob);
  },


  normalizedFileExclusionTokens(tokens) {
    return [...new Set(tokens.map((token) => {
      const value = String(token).trim();
      return value ? (value.startsWith("!") ? value : `!${value}`) : "";
    }).filter(Boolean))];
  },


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
  },


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
  },


  closeFileTypeFilterMenu() {
    this.$("file-type-filter-menu")?.classList.add("hidden");
    this.fileTypeFilterMenuMode = "name";
    for (const id of ["file-type-filter-button", "search-file-type-filter-button", "recent-file-type-filter-button"]) {
      this.$(id)?.setAttribute("aria-expanded", "false");
    }
  },


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
  },


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
  },


  deleteSearchHistoryEntry(entry) {
    this.searchHistory = this.searchHistory.filter((candidate) => candidate !== entry);
    this.saveSearchHistory();
    this.renderSearchHistoryMenu();
  },


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
  },


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
  },


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
  },


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
  },


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
  },


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
  },


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
  },


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
  },


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
  },


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
  },


  collapseSearchDirectoryChain(directory, includeMatchedDirectory = false) {
    const chain = [directory];
    let current = directory;
    while (!current.files.length && current.directories.size === 1 && (!includeMatchedDirectory || !current.hit)) {
      current = [...current.directories.values()][0];
      chain.push(current);
    }
    return { chain, directory: current };
  },


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
  },


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
  },


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
  },


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
  },


  compareNameSearchFiles(a, b, query) {
    return this.nameSearchMatchRank(a, query) - this.nameSearchMatchRank(b, query) || this.compareSearchFiles(a, b);
  },


  nameSearchMatchRank(entry, query) {
    const basename = String(entry.path || "").split("/").pop() || "";
    const normalizedName = this.nameSearchCase ? basename : basename.toLowerCase();
    const normalizedQuery = this.nameSearchCase ? query : query.toLowerCase();
    if (normalizedName === normalizedQuery) return 0;
    if (!entry.is_dir && normalizedName.replace(/\.[^.]+$/, "") === normalizedQuery) return 1;
    if (normalizedName.startsWith(normalizedQuery)) return 2;
    return this.searchHighlightRanges(basename, query, { caseSensitive: this.nameSearchCase, fuzzy: true }).length ? 4 : 5;
  },


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
  },


  fileSearchResultRows(mode) {
    const container = this.$(mode === "name" ? "name-results" : "search-results");
    const selector = mode === "name" ? ".search-file.clickable, .search-tree-directory.clickable" : ".search-hit";
    return container ? [...container.querySelectorAll(selector)] : [];
  },


  clearFileSearchSelection(mode) {
    this.searchSelection[mode] = -1;
  },


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
  },


  moveFileSearchSelection(mode, delta) {
    const rows = this.fileSearchResultRows(mode);
    if (!rows.length) return false;
    const current = this.searchSelection[mode];
    const index = current < 0 ? (delta < 0 ? rows.length - 1 : 0) :
      Math.max(0, Math.min(rows.length - 1, current + delta));
    return this.selectFileSearchResult(mode, rows[index]);
  },


  activateFileSearchSelection(mode) {
    const row = this.fileSearchResultRows(mode)[this.searchSelection[mode]];
    if (!row) return false;
    row.click();
    return true;
  },


  handleFileSearchNavigation(event, mode) {
    if (event.metaKey || event.ctrlKey || event.altKey) return false;
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return false;
    event.preventDefault();
    this.moveFileSearchSelection(mode, event.key === "ArrowDown" ? 1 : -1);
    return true;
  },


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
  },


  treeFilterAllows(relPath, isDir) {
    const filter = this.treeSearchFilter;
    if (!filter) return true;
    const path = String(relPath || "");
    const prefix = `${path}/`;
    const isWithinMatchedDirectory = [...filter.directories].some((directory) => path.startsWith(`${directory}/`));
    if (!isDir) return filter.paths.has(path) || isWithinMatchedDirectory;
    return isWithinMatchedDirectory || filter.directories.has(path) ||
      [...filter.paths].some((candidate) => candidate === path || candidate.startsWith(prefix));
  },


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
  },


  async replaceAll() {
    const query = this.$("search-query").value.trim();
    const replacement = this.$("replace-with").value;
    if (!query) {
      void uiAlert("enter a search query first");
      return;
    }
    if (!this.lastSearchFiles.length) await this.runSearch(null, true);
    this.renderReplacePreview(query, replacement);
  },


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
  },


  async applyReplacementPreview() {
    const query = this.$("search-query").value.trim();
    const replacement = this.$("replace-with").value;
    const paths = [...this.$("replace-preview").querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value);
    if (!paths.length) return;
    if (!await uiConfirm(`Replace matches in ${paths.length} selected file${paths.length === 1 ? "" : "s"}?`)) return;
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
      void uiAlert(err.detail || "replace failed");
      return;
    }
    const result = await res.json();
    this.$("replace-preview").classList.add("hidden");
    void uiAlert(`replaced ${result.replacements} match${result.replacements === 1 ? "" : "es"} in ${result.files} file${result.files === 1 ? "" : "s"}`);
    for (const entry of this.openFiles.values()) {
      if (entry.model && !entry.dirty) {
        entry.model.dispose();
        entry.model = null;
      }
    }
    if (this.activeFileKey !== null) this.activateFile(this.activeFileKey, null);
    this.runSearch(null, true);
  },


  debouncedNameSearch() {
    clearTimeout(this.nameDebounce);
    if (!this.$("search-name").value.trim()) {
      this.nameDebounce = setTimeout(() => this.runNameSearch(), 0);
      return;
    }
    this.nameDebounce = setTimeout(() => this.runNameSearch(), SEARCH_DEBOUNCE_MS);
  },


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
  },


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
  },


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
  },


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
  },


  cssVar(name) {
    return getComputedStyle(document.body).getPropertyValue(name).trim();
  },


  formatKb(kb) {
    return kb >= 1048576 ? (kb / 1048576).toFixed(1) + "G" : Math.round(kb / 1024) + "M";
  },


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
    // Each metric shows two numbers side by side, so every tooltip names them in the order they
    // are printed: the active terminal first, then the TermDeck server.
    const activeCpu = active ? `${active.cpu.toFixed(0)}%` : "—";
    const serverCpu = `${data.app.cpu.toFixed(0)}%`;
    const activeMemory = active ? this.formatKb(active.rss_kb) : "—";
    const serverMemory = this.formatKb(data.app.rss_kb);
    const cpuDetail = `CPU · active terminal ${activeCpu} · TermDeck server ${serverCpu}`;
    const memoryDetail = `Memory (RSS) · active terminal ${activeMemory} · TermDeck server ${serverMemory}`;
    const sparkDetail = `History · CPU (accent line) and memory (grey line), last ${STAT_HISTORY_MAX} samples`;
    const statText = this.$("stat-text");
    statText.textContent = "";
    const cpuMetric = document.createElement("span");
    cpuMetric.className = "stat-metric";
    cpuMetric.title = cpuDetail;
    const cpuIcon = document.createElement("span");
    cpuIcon.className = "codicon codicon-pulse stat-metric-icon";
    const cpuValue = document.createElement("span");
    cpuValue.textContent = `${activeCpu} ${serverCpu}`;
    cpuMetric.append(cpuIcon, cpuValue);
    const memoryMetric = document.createElement("span");
    memoryMetric.className = "stat-metric";
    memoryMetric.title = memoryDetail;
    const memoryIcon = document.createElement("span");
    memoryIcon.className = "codicon codicon-chip stat-metric-icon";
    const memoryValue = document.createElement("span");
    memoryValue.textContent = `${activeMemory} ${serverMemory}`;
    memoryMetric.append(memoryIcon, memoryValue);
    statText.append(cpuMetric, memoryMetric);
    this.$("stat-spark").title = sparkDetail;
    this.$("bottombar-stats").title = `${cpuDetail}\n${memoryDetail}\n${sparkDetail}\nClick for maintenance`;
    this.drawSparkline();
  },


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
  },
});
