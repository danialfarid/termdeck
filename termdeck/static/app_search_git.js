// Split from app.js (2026-08-26): terminal find, history search, git panel, file context menus.
// Same class, split across files: this attaches methods to TermdeckApp.prototype, and
// index.html loads the app_*.js files after app.js and before app_boot.js.
Object.assign(TermdeckApp.prototype, {


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
  },


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
  },


  terminalFindOptions(incremental = false) {
    return { caseSensitive: false, incremental, decorations: TERMINAL_FIND_DECORATIONS };
  },


  // Only the session actually being searched gets the override, and only while a query is live, so an
  // ordinary mouse selection anywhere (including in this same terminal once find closes) keeps the normal,
  // deliberately unobtrusive selection color.
  terminalFindThemeOverride(view) {
    if (!view || view.sessionId !== this.terminalFindSessionId || !this.terminalFindQuery) return null;
    return { selectionBackground: TERMINAL_FIND_SELECTION_BACKGROUND,
             selectionInactiveBackground: TERMINAL_FIND_SELECTION_BACKGROUND,
             selectionForeground: TERMINAL_FIND_SELECTION_FOREGROUND };
  },


  terminalDisplayTheme(view = null) {
    const mobileSelection = this.touchMobileLayoutEnabled()
      ? { selectionBackground: MOBILE_TERMINAL_SELECTION_BACKGROUND,
          selectionInactiveBackground: MOBILE_TERMINAL_SELECTION_BACKGROUND,
          selectionForeground: MOBILE_TERMINAL_SELECTION_FOREGROUND }
      : {};
    return { ...this.termTheme(), ...mobileSelection, ...(this.terminalFindThemeOverride(view) || {}) };
  },


  applyTerminalFindHighlight(view) {
    if (!view || view.closed || !view.term) return;
    view.term.options.theme = this.terminalDisplayTheme(view);
  },


  prepareTerminalFindNavigation(view) {
    view.userScrollIntent = true;
    view.scrollMode = "preserve";
    this.cancelTerminalViewportRestore(view);
    this.clearActiveTerminalSettleWatchdog(view);
    clearTimeout(view.tailRepairTimer);
    clearTimeout(view.tailRepairConfirmTimer);
    view.tailRepairTimer = 0;
    view.tailRepairConfirmTimer = 0;
  },


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
  },


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
  },


  revealTerminalBufferFindMatch(view, query) {
    const count = this.$("terminal-find-count");
    const match = this.terminalFindFallbackMatches[this.terminalFindFallbackIndex];
    if (!match) {
      if (count) count.textContent = "no matches";
      return false;
    }
    view.v2Programmatic = true;
    view.term.select(match.column, match.row, query.length);
    this.scrollTallContainerToRow(view, match.row);
    requestAnimationFrame(() => { view.v2Programmatic = false; });
    if (count) count.textContent = `${this.terminalFindFallbackIndex + 1}/${this.terminalFindFallbackMatches.length}`;
    return true;
  },


  // Find highlights the match but cannot bring it into view on its own: the addon scrolls xterm's
  // viewport, which is not the surface being scrolled. The container's scrollTop is an absolute buffer
  // offset, so the match's row maps to it directly -- subtracting viewportY (the old rendered-window
  // frame) landed the view somewhere unrelated, which read as "search moves the scroll but the match is
  // further down". Centering is deliberate rather than a minimal scroll-into-view: a match found
  // mid-search usually wants its surrounding context readable, and centering also keeps repeat presses
  // of the same direction moving a predictable distance instead of pinning the match to whichever edge
  // it entered from.
  scrollTallContainerToRow(view, absoluteRow) {
    if (!view || view.closed) return;
    const cellHeight = view.term._core?._renderService?.dimensions?.css?.cell?.height;
    if (!cellHeight || !view.container.clientHeight) return;
    const centered = absoluteRow * cellHeight - Math.max(0, (view.container.clientHeight - cellHeight) / 2);
    const nativeMax = Math.max(0, view.container.scrollHeight - view.container.clientHeight);
    // Honor the same content ceiling the scroll listener enforces, so centering a match near the end
    // cannot park the view in the blank rows past the content.
    const ceiling = view.tallMaxScrollTop == null ? nativeMax : Math.min(nativeMax, view.tallMaxScrollTop);
    this.tallSetScrollTop(view, Math.max(0, Math.min(centered, ceiling)));
    // Our own scrollTop write suppresses its scroll event as an echo, so the listener's viewport sync
    // never runs for it -- the rendered window has to be brought along explicitly, or the container
    // points at a region the window does not cover and the match "lands" on blank canvas.
    this.tallSyncBufferToScroll(view);
    // Searching is the user asking to look at something specific, so stop following new output -- other-
    // wise the next write scrolls straight back to the prompt and the match they just navigated to is
    // gone. Typing resumes following (see the key handler in ensureView). Anchoring to the match's row
    // keeps it pinned even as new output pushes lines into scrollback underneath it.
    view.tallFollowing = false;
    this.tallCaptureAnchorRow(view);
  },


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
  },


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
  },


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
  },


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
  },


  filterTerminalSearchMatchesToGroup() {
    if (!this.terminalSearchGroupId) return;
    const worktreeId = this.terminalSearchWorktreeId || this.stateWorktreeId();
    const state = this.getProjectStateForWorktree(worktreeId);
    for (const sessionId of this.terminalSearchMatches.keys()) {
      if (state.session_groups?.[sessionId] !== this.terminalSearchGroupId) this.terminalSearchMatches.delete(sessionId);
    }
    this.terminalSearchClosedMatches.clear();
  },


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
  },


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
  },


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
  },


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
  },


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
  },


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
  },


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
      row.onclick = () => this.activate(result.open_session_id, { reveal: true });
      section.appendChild(row);
    }
    container.appendChild(section);
  },


  searchResultSessionKey(result) {
    if (result.is_subagent && result.parent_agent_session_id) {
      return `parent:${result.agent_kind}:${result.parent_agent_session_id}`;
    }
    return result.open_session_id || result.closed_session_id ||
      (result.agent_session_id ? `${result.agent_kind}:${result.agent_session_id}` :
        result.title ? `title:${result.title}` : `source:${result.source_path}`);
  },


  searchResultTitle(result) {
    return result.is_subagent && result.parent_title
      ? result.parent_title
      : result.title || `${result.agent_kind} session`;
  },


  searchResultStatus(result) {
    return result.parent_status || result.status || "not_open";
  },


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
  },


  searchMatchText(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  },


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
  },


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
  },


  closeHistorySearchContext() {
    this.$("history-search-backdrop").classList.add("hidden");
    this.historySearchContextResult = null;
  },


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
        void uiAlert(detail.detail || "unable to open saved session");
        return null;
      }
      sessionId = (await response.json()).session_id;
    }
    return sessionId;
  },


  async openHistorySearchSession() {
    const result = this.historySearchContextResult;
    if (!result) return;
    const sessionId = await this.ensureHistorySearchSession(result);
    if (!sessionId) return;
    this.closeHistorySearchContext();
    await this.refresh();
    this.activate(sessionId, { reveal: true });
  },


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
  },


  normalizedHistorySearchText(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
  },


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
  },


  schedulePendingHistorySearchReveal() {
    if (!this.pendingHistorySearchNavigation || this.historySearchNavigationBusy) return;
    requestAnimationFrame(() => { void this.revealPendingHistorySearchMatch(); });
  },


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
  },


  terminalTypeIcon(s) {
    const icon = document.createElement("span");
    icon.className = "terminal-type-icon";
    icon.setAttribute("aria-hidden", "true");
    if (TERMINAL_TYPE_SVGS[s.agent_kind]) {
      icon.innerHTML = TERMINAL_TYPE_SVGS[s.agent_kind];
    } else {
      icon.innerHTML = '<span class="codicon codicon-terminal"></span>';
    }
    icon.title = this.agentSpec(s.agent_kind)?.is_agent ? this.agentLabel(s.agent_kind) : "Shell terminal";
    for (const kind of Object.keys(this.agentSpecs)) {
      if (kind !== "none") icon.classList.toggle(`${kind}-terminal-icon`, s.agent_kind === kind);
    }
    icon.classList.toggle("on", this.terminalIconEnabledForAgent(s.agent_kind));
    return icon;
  },


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
  },


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
    dot.className = "status-dot" +
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
    typeIcon.classList.toggle("terminal-status-active", iconStatusActive);
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
    const activityDots = document.createElement("span");
    activityDots.className = "session-activity-dots";
    item.append(activityDots);
    this.sessionActivityEls.set(s.session_id, activityDots);
    this.updateSessionActivityDots(s.session_id);
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
  },


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
  },


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
  },


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
  },


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
    this.sessionActivityEls.clear();
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
  },


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
  },


  keepActiveSessionVisible() {
    this.revealActiveTerminalInSidebar();
  },


  revealAndFocusActiveTerminalInSidebar() {
    this.revealActiveTerminalInSidebar({ focus: true, switchToTerminals: true });
  },


  revealActiveTerminalInSidebar({ focus = false, switchToTerminals = false } = {}) {
    if (!this.activeId || !this.session(this.activeId)) return;
    const sessionId = this.activeId;
    if (switchToTerminals) this.setSideView("terminals", false);
    if (this.sideView !== "terminals" || this.activeFileKey !== null) return;
    const groupId = this.getProjectState().session_groups?.[sessionId] || "";
    const group = groupId ? this.terminalGroups().find((candidate) => candidate.id === groupId) : null;
    let renderRequired = false;
    if (group?.collapsed) {
      this.applyLocalProjectStatePatch({ terminal_groups: this.terminalGroups().map((candidate) => candidate.id === groupId
        ? { ...candidate, collapsed: false } : candidate) });
      this.queueTerminalGroupUpdate(groupId, { collapsed: false });
      renderRequired = true;
    }
    if (focus) {
      this.sidebarSelectedFileKeys.clear();
      this.sidebarSelectedSessionIds = new Set([sessionId]);
      this.sidebarSelectionAnchorId = sessionId;
      renderRequired = true;
    }
    if (renderRequired) this.renderList();
    requestAnimationFrame(() => {
      const row = this.$("session-list")?.querySelector(`[data-session-id="${CSS.escape(sessionId)}"]`);
      if (!row) return;
      row.scrollIntoView({ block: "center" });
      if (focus) row.focus({ preventScroll: true });
    });
  },


  setSideView(view, allowToggle = true) {
    if (this.vscodeMode && view !== "terminals") return;
    if (!this.filesSidePanelCycleTransition) this.filesSidePanelCycleView = null;
    const nextView = allowToggle && this.sideView === view
      ? (view === "terminals" ? CLOSED_SIDE_VIEW : "terminals") : view;
    this.sideView = nextView;
    view = this.sideView;
    if (view !== "git") this.closeGitReview(false);
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
    const gitView = view === "git";
    this.settings.side_full = filesVisible;
    this.$("files-section").classList.toggle("hidden", !filesVisible);
    this.$("session-list").classList.toggle("hidden", view === CLOSED_SIDE_VIEW);
    this.$("files-section").classList.toggle("with-search", view === "search");
    this.$("files-section").classList.toggle("with-git", view === "git");
    this.$("file-header-controls")?.classList.toggle("hidden", !filesVisible || gitView);
    this.$("git-branch-controls").classList.toggle("hidden", !gitView);
    this.$("git-refresh").classList.toggle("hidden", !gitView);
    for (const [name, id] of [["terminals", "view-terminals"], ["project", "view-project"], ["search", "view-search"], ["git", "view-git"]]) {
      const button = this.$(id);
      if (button) {
        const selected = name === view;
        button.classList.toggle("on", selected);
        button.setAttribute("aria-selected", String(selected));
      }
    }
    this.renderFileEditorChrome();
    this.$("side-split").classList.toggle("hidden", view === "terminals" || view === CLOSED_SIDE_VIEW || filesVisible);
    this.applySettings();
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
      this.scheduleTerminalLayoutFit();
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
    this.scheduleTerminalLayoutFit();
  },


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
  },


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
  },


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
  },


  handleFileModeNavigationClick(view) {
    if (view === "terminals") {
      this.setSideView(view, false);
      const session = this.recentlyOpenedTerminalSessions()[0];
      if (session) this.activate(session.session_id, { reveal: true });
      else if (this.activeFileKey !== null) this.navigateBackFromActiveFile();
      return;
    }
    if (this.fileHistoryOpen) this.deactivateFileHistoryTab();
    if (this.sideView === view) {
      this.handleFileModeNavigationClick("terminals");
      return;
    } else if (view === "search") {
      this.openSearchSidePanelFromNavigation();
    } else if (view !== "project" || !this.searchFileFromSelection()) {
      this.openFilesSidePanelView(view);
    }
    if (!FILES_SIDE_PANEL_TABS.includes(this.sideView)) {
      if (view === "git" && this.activeId && this.session(this.activeId)) this.pushNav({ kind: "term", id: this.activeId });
      return;
    }
    if (this.sideView === "git") {
      this.pushNav({ kind: "files", view: "git" });
      if (this.activeFileKey === null && this.openFiles.size) {
        const key = [...this.openFiles.keys()].at(-1);
        void this.activateFile(key, null, { history: false });
      }
      return;
    }
    if (this.activeFileKey !== null && this.openFiles.has(this.activeFileKey)) {
      this.pushNav({ kind: "file", key: this.activeFileKey, view: this.sideView });
      return;
    }
    if (this.openFiles.size) {
      const key = [...this.openFiles.keys()].at(-1);
      void this.activateFile(key, null);
      return;
    }
    const state = { kind: "files", view: this.sideView };
    if (this.sideView === "search" && this.$("search-query").value.trim()) state.q = this.$("search-query").value.trim();
    this.pushNav(state);
  },


  setExplorerMode(mode) {
    this.$("search-scroll-region").classList.toggle("with-results", mode === "content");
    this.$("files-tree").classList.toggle("hidden", mode !== "tree");
    this.$("search-results").classList.toggle("hidden", mode !== "content");
    this.$("name-results").classList.toggle("hidden", mode !== "name");
    this.$("git-results").classList.toggle("hidden", mode !== "git");
    if (mode !== "git") {
      this.gitSideGeneration += 1;
      this.$("git-results").textContent = "";
      this.$("git-header-branch-select").textContent = "";
      this.closeGitReview(false);
    }
  },


  async loadGitSidePanel() {
    if (this.sideView !== "git" || this.vscodeMode) return;
    const generation = ++this.gitSideGeneration;
    const root = this.session(this.activeId)?.cwd || this.treeRoot || this.worktreeRoot() || this.projectRoot();
    const results = this.$("git-results");
    if (!root || !results) return;
    results.textContent = "Loading Git status…";
    const response = await fetch(`/api/git/state?${new URLSearchParams({ root, limit: "200" })}`);
    if (generation !== this.gitSideGeneration || this.sideView !== "git") return;
    if (!response.ok) {
      results.textContent = "";
      const unavailable = document.createElement("div");
      unavailable.className = "file-inspector-empty";
      unavailable.textContent = "This folder is not a Git repository.";
      const clone = this.gitWorkflowButton("repo-clone", "Clone SSH or remote project",
                                           () => this.gitCloneProject(root), " clone remote project");
      clone.classList.add("git-clone-empty");
      results.append(unavailable, clone);
      this.$("git-header-branch-select").textContent = "";
      this.$("git-header-branch-select").disabled = true;
      this.$("git-new-branch").disabled = true;
      return;
    }
    const state = await response.json();
    this.gitSideState = state;
    const tracking = state.upstream ? `${state.branch} → ${state.upstream} · ↑${state.ahead || 0} ↓${state.behind || 0}` : state.branch;
    this.renderGitHeaderState(state.repository_root || root, state, tracking);
    this.renderGitSidePanelState(results, state.repository_root || root, state);
    const pendingHistoryScope = this.gitPendingHistoryScope;
    if (pendingHistoryScope) {
      this.gitPendingHistoryScope = null;
      void this.loadGitCommitGraph(pendingHistoryScope.root, [pendingHistoryScope.path], "", { historyScope: true });
    }
  },


  renderGitHeaderState(root, state, tracking) {
    const branchSelect = this.$("git-header-branch-select");
    branchSelect.textContent = "";
    branchSelect.disabled = false;
    for (const branch of (state.branches || []).filter((candidate) => !candidate.remote)) {
      const option = document.createElement("option");
      option.value = branch.name;
      option.textContent = branch.name;
      option.selected = branch.current || branch.name === state.branch;
      branchSelect.appendChild(option);
    }
    branchSelect.title = tracking || state.branch || "Switch branch";
    branchSelect.onchange = () => void this.gitWorkflowAction("/api/git/switch", { root, name: branchSelect.value });
    this.$("git-new-branch").disabled = false;
    this.$("git-new-branch").onclick = () => void this.gitCreateBranch(root);
  },


  renderGitSidePanelState(results, root, state) {
    results.textContent = "";
    const view = ["changes", "pull-requests"].includes(this.gitPanelView) ? this.gitPanelView : "changes";
    if (this.gitSelectionRoot !== root) {
      const preserveReviewTarget = this.gitPendingReview?.root === root ||
        this.gitReviewOpen && this.gitFocusedFile?.root === root;
      this.gitSelectionRoot = root;
      this.gitSelectedPaths.clear();
      this.gitHistoryScopePaths = [];
      this.gitSelectionExplicitlyCleared = false;
      this.gitSelectionAnchorPath = "";
      this.gitHistoryQuery = "";
      this.gitHistoryFilters = { author: "", since: "", until: "", revision: "", path: "" };
      this.gitHistoryFiltersOpen = false;
      this.gitGraphPathsKey = "";
      this.gitGraphError = "";
      this.gitComparison = null;
      this.gitPullRequestRoot = "";
      this.gitPullRequests = [];
      this.gitPullRequestDetail = null;
      this.gitPullRequestLoaded = false;
      this.gitPullRequestError = "";
      clearTimeout(this.gitHistorySearchTimer);
      if (!preserveReviewTarget) {
        this.gitFocusedFile = null;
        this.gitExpandedCommitId = "";
      }
      this.gitCommitDetails.clear();
    }
    if (view === "pull-requests") {
      this.renderGitPanelTabs(results, root, state, view);
      this.renderGitWorkflowControls(results, root, state, view);
      this.renderGitPullRequestPanel(results, root);
      this.$("status-name").textContent = "GitHub pull requests";
      return;
    }
    if (this.gitReviewOpen && this.gitFocusedFile?.scope === "pull-request") this.closeGitReview(false);
    const fileGroups = this.gitFileGroups(state.files || []);
    const descriptors = fileGroups.flatMap(([, , files, scope]) => files.map((file) => ({ file, scope })));
    const validPaths = new Set(descriptors.map(({ file }) => file.path));
    this.gitSelectedPaths = new Set([...this.gitSelectedPaths].filter((path) => validPaths.has(path)));
    if (!this.gitSelectedPaths.size && descriptors.length && !this.gitSelectionExplicitlyCleared) {
      this.gitSelectedPaths.add(descriptors[0].file.path);
    }
    const focusedHistoricalReview = this.gitReviewOpen && ["commit", "compare"].includes(this.gitFocusedFile?.scope);
    if (!focusedHistoricalReview && (!this.gitFocusedFile ||
        !descriptors.some(({ file, scope }) => file.path === this.gitFocusedFile.path && scope === this.gitFocusedFile.scope))) {
      this.gitFocusedFile = descriptors.length ? { root, path: descriptors[0].file.path, scope: descriptors[0].scope } : null;
    }
    this.renderGitPanelTabs(results, root, state, view);
    this.renderGitWorkflowControls(results, root, state, view);
    this.renderGitOperationBanner(results, root, state.operation || {});
    if (this.gitComparison?.root === root) this.renderGitComparison(results, root, this.gitComparison);
    const files = state.files || [];
    const changesPanel = this.createGitPanelSection(results, "Current changes", "diff", "git-current-changes-panel");
    const summary = document.createElement("div");
    summary.className = "git-summary";
    const conflicted = files.filter((file) => file.conflicted).length;
    const staged = files.filter((file) => file.staged).length;
    summary.textContent = files.length
      ? `${files.length} changed · ${staged} staged${conflicted ? ` · ${conflicted} conflicted` : ""}`
      : `Working tree clean · ${state.branch}`;
    changesPanel.appendChild(summary);
    if (!files.length) {
      const empty = document.createElement("div");
      empty.className = "file-inspector-empty";
      empty.textContent = "No uncommitted changes on this branch.";
      changesPanel.appendChild(empty);
    }
    const orderedPaths = [...new Set(descriptors.map(({ file }) => file.path))];
    for (const [label, icon, groupFiles, scope] of fileGroups) {
      if (!groupFiles.length) continue;
      this.renderGitSideGroupHeader(changesPanel, `${label} (${groupFiles.length})`, icon);
      for (const file of groupFiles) this.renderGitSideFile(changesPanel, root, file, scope, orderedPaths);
    }
    const stashAction = this.gitTextButton("+ Stash", () => this.gitCreateStash(root));
    stashAction.classList.add("compact");
    const stashPanel = this.createGitPanelSection(results, `Stashes (${(state.stashes || []).length})`, "archive",
      "git-stashes-panel", { collapsible: true, collapsed: this.gitStashesCollapsed, action: stashAction,
        onToggle: (collapsed) => {
          this.gitStashesCollapsed = collapsed;
          localStorage.setItem("termdeck.git_stashes_collapsed", collapsed ? "1" : "0");
        } });
    this.renderGitStashes(stashPanel, root, state.stashes || []);
    const repositoriesPanel = this.createGitPanelSection(results, "Worktrees & remotes", "repo", "git-repositories-panel");
    const repositoryActions = document.createElement("div");
    repositoryActions.className = "git-workflow-controls repository-controls git-repository-actions";
    repositoryActions.append(
      this.gitWorkflowButton("repo-create", "Create worktree", () => this.gitCreateWorktree(root, state.branch), " worktree"),
      this.gitWorkflowButton("remote", "Add Git remote", () => this.gitAddRemote(root), " remote"),
      this.gitWorkflowButton("repo-clone", "Clone SSH or remote project", () => this.gitCloneProject(root), " clone"),
    );
    repositoriesPanel.appendChild(repositoryActions);
    this.renderGitAgentWorktrees(repositoriesPanel, state.agents || []);
    this.renderGitWorktrees(repositoriesPanel, root, state.worktrees || [], state.repository_root);
    this.renderGitRemotes(repositoriesPanel, root, state.remotes || [], state.branch);
    const graphPaths = this.gitHistoryScopePaths.length ? [...this.gitHistoryScopePaths] : [...this.gitSelectedPaths];
    const historyScope = graphPaths.length === 1 ? graphPaths[0]
      : graphPaths.length > 1 ? `${graphPaths.length} selected files` : "whole worktree";
    const historyPanel = this.createGitPanelSection(results, `History · ${historyScope}`, "git-commit", "git-history-panel");
    this.renderGitHistorySearch(historyPanel, root, graphPaths);
    const historyGraph = document.createElement("div");
    historyGraph.className = "git-history-graph";
    historyPanel.appendChild(historyGraph);
    this.renderGitCommitGraph(historyGraph, root, state.graph || [], graphPaths, this.gitHistoryQuery);
    this.$("status-name").textContent = `${files.length} modified file${files.length === 1 ? "" : "s"} · branch ${state.branch}`;
    if (this.gitGraphPathsKey !== this.gitCommitGraphKey(root, graphPaths, this.gitHistoryQuery)) {
      void this.loadGitCommitGraph(root, graphPaths, this.gitHistoryQuery);
    }
    if (!this.gitExpandedCommitId && this.gitFocusedFile && ["conflict", "staged", "working", "untracked"].includes(this.gitFocusedFile.scope) &&
        this.activeFileKey === null && !this.gitConflictResolutionInProgress) {
      void this.openGitReviewDiff(this.gitFocusedFile.root, this.gitFocusedFile.path, this.gitFocusedFile.scope, false);
    }
  },


  gitFileGroups(files) {
    return [
      ["conflicts", "warning", files.filter((file) => file.conflicted), "conflict"],
      ["staged changes", "check", files.filter((file) => file.staged && !file.conflicted), "staged"],
      ["working tree", "diff-modified", files.filter((file) => file.unstaged && !file.conflicted), "working"],
      ["untracked", "new-file", files.filter((file) => file.untracked), "untracked"],
    ];
  },


  renderGitPanelTabs(container, root, state, view) {
    const tabs = document.createElement("div");
    tabs.className = "git-panel-tabs";
    for (const [value, label] of [["changes", "Changes"], ["pull-requests", "Pull requests"]]) {
      const tab = document.createElement("button");
      tab.className = `git-panel-tab${view === value ? " active" : ""}`;
      tab.textContent = label;
      tab.setAttribute("aria-pressed", String(view === value));
      tab.onclick = () => {
        if (this.gitPanelView === value) return;
        this.gitPanelView = value;
        this.renderGitSidePanelState(container, root, state);
      };
      tabs.appendChild(tab);
    }
    container.appendChild(tabs);
  },


  renderGitWorkflowControls(container, root, state, view) {
    if (view === "pull-requests") {
      const controls = document.createElement("div");
      controls.className = "git-workflow-controls repository-controls";
      controls.append(
        this.gitWorkflowButton("refresh", "Refresh pull requests", () => this.loadGitPullRequests(root, true), " refresh"),
        this.gitWorkflowButton("github", "Open repository on GitHub", () => this.openGitHubRepository(root), " GitHub"),
      );
      container.appendChild(controls);
      return;
    }
    const primaryActions = document.createElement("div");
    primaryActions.className = "git-primary-actions";
    const selectedFiles = (state.files || []).filter((file) => this.gitSelectedPaths.has(file.path));
    primaryActions.append(
      this.gitWorkflowButton("add", `Stage ${selectedFiles.length || "all"}`, () => this.gitStagePaths(root,
        selectedFiles.length ? selectedFiles : state.files || [], true)),
      this.gitWorkflowButton("remove", `Unstage ${selectedFiles.length || "all"}`, () => this.gitStagePaths(root,
        selectedFiles.length ? selectedFiles : state.files || [], false)),
      this.gitTextButton("Commit", () => this.gitCommit(root), true),
    );
    container.appendChild(primaryActions);
    const historyActions = document.createElement("div");
    historyActions.className = "git-workflow-controls git-history-actions";
    historyActions.append(
      this.gitWorkflowButton("compare-changes", "Compare branches, tags, or revisions", () => this.gitOpenComparison(root), " compare"),
      this.gitWorkflowButton("git-commit", "Interactively rebase recent commits", () => this.gitOpenInteractiveRebase(root), " rebase"),
    );
    container.appendChild(historyActions);
    const selection = document.createElement("div");
    selection.className = "git-selection-summary";
    selection.textContent = this.gitHistoryScopePaths.length
      ? `History scoped to ${this.gitHistoryScopePaths.length === 1 ? this.gitHistoryScopePaths[0] : `${this.gitHistoryScopePaths.length} paths`}`
      : this.gitSelectedPaths.size
      ? `${this.gitSelectedPaths.size} selected · commit graph scoped to ${this.gitSelectedPaths.size === 1 ? "this file" : "these files"}`
      : "No files selected · commit graph scoped to the whole worktree";
    if (this.gitSelectedPaths.size || this.gitHistoryScopePaths.length) {
      const clear = this.gitTextButton("Whole worktree", () => {
        this.gitSelectedPaths.clear();
        this.gitHistoryScopePaths = [];
        this.gitSelectionExplicitlyCleared = true;
        this.gitSelectionAnchorPath = "";
        this.gitGraphPathsKey = "";
        this.renderGitSidePanelState(container, root, state);
      });
      clear.classList.add("compact");
      selection.appendChild(clear);
    }
    container.appendChild(selection);
  },


  renderGitOperationBanner(container, root, operation) {
    if (!operation.in_progress) return;
    const banner = document.createElement("div");
    banner.className = "git-operation-banner";
    const text = document.createElement("span");
    const conflictCount = Array.isArray(operation.conflicts) ? operation.conflicts.length : 0;
    text.textContent = `${operation.operation} in progress${conflictCount ? ` · ${conflictCount} conflict${conflictCount === 1 ? "" : "s"}` : ""}`;
    const actions = document.createElement("span");
    actions.className = "git-row-actions";
    actions.appendChild(this.gitTextButton("Continue", () => this.gitOperationAction(root, "continue")));
    if (!["merge", "revert"].includes(operation.operation)) {
      actions.appendChild(this.gitTextButton("Skip", () => this.gitOperationAction(root, "skip")));
    }
    actions.appendChild(this.gitTextButton("Abort", () => this.gitOperationAction(root, "abort")));
    banner.append(text, actions);
    container.appendChild(banner);
  },


  renderGitComparison(container, root, comparison) {
    const close = this.gitWorkflowButton("close", "Close comparison", () => {
      this.gitComparison = null;
      if (this.gitFocusedFile?.scope === "compare") this.closeGitReview(false);
      this.renderGitSidePanelState(this.$("git-results"), root, this.gitSideState);
    });
    const body = this.createGitPanelSection(container, `${comparison.base} ↔ ${comparison.target}`, "compare-changes",
      "git-comparison-panel", { action: close });
    const summary = document.createElement("div");
    summary.className = "git-summary";
    summary.textContent = `${comparison.files.length} changed file${comparison.files.length === 1 ? "" : "s"}`;
    body.appendChild(summary);
    if (!comparison.files.length) {
      const empty = document.createElement("div");
      empty.className = "file-inspector-empty";
      empty.textContent = "These revisions have identical file content.";
      body.appendChild(empty);
      return;
    }
    for (const file of comparison.files) {
      const row = document.createElement("div");
      const active = this.gitReviewOpen && this.gitFocusedFile?.scope === "compare" &&
        this.gitFocusedFile.path === file.path && this.gitFocusedFile.base === comparison.base &&
        this.gitFocusedFile.target === comparison.target;
      row.className = `git-comparison-file${active ? " active" : ""}`;
      row.dataset.path = file.path;
      const status = document.createElement("span");
      status.className = `git-commit-file-status status-${String(file.status || "M").toLowerCase()}`;
      status.textContent = file.status || "M";
      const path = document.createElement("span");
      path.className = "git-commit-file-path";
      path.textContent = file.previous_path ? `${file.previous_path} → ${file.path}` : file.path;
      row.append(status, this.fileTypeIconEl(file.path.split("/").pop(), "tree-type-icon"), path);
      row.title = `Compare ${file.path}`;
      row.onclick = () => void this.openGitComparisonDiff(root, comparison, file, true);
      row.oncontextmenu = (event) => {
        event.preventDefault();
        event.stopPropagation();
        const menu = this.$("context-menu");
        menu.textContent = "";
        this.addContextItem(menu, "Show comparison diff", () => this.openGitComparisonDiff(root, comparison, file, true), "diff");
        this.addContextItem(menu, "Open working file", () => this.openFile(root, file.path, null, null,
          { fromFilePanel: true, pinned: true }), "go-to-file");
        this.addContextItem(menu, "Copy relative path", () => this.copyTextToClipboard(file.path, "relative path copied"), "copy");
        this.positionContextMenu(menu, event.clientX, event.clientY);
      };
      body.appendChild(row);
    }
  },


  async gitOpenComparison(root, initialBase = "", initialTarget = "HEAD") {
    const defaultBase = initialBase || this.gitSideState?.upstream || this.gitSideState?.branch || "HEAD~1";
    const values = await this.openGitDialog({
      title: "Compare Git revisions",
      description: "Use any branch, tag, remote branch, commit hash, or revision expression.",
      submitLabel: "Compare",
      fields: [
        { name: "base", label: "Base revision", value: defaultBase, required: true,
          suggestions: this.gitSideState?.references || [] },
        { name: "target", label: "Target revision", value: initialTarget || "HEAD", required: true,
          suggestions: this.gitSideState?.references || [] },
      ],
    });
    if (!values?.base.trim() || !values.target.trim()) return;
    const response = await fetch("/api/git/compare", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root, base: values.base.trim(), target: values.target.trim() }) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      await this.showGitMessage("Comparison unavailable", payload.detail || "The selected revisions could not be compared.");
      return;
    }
    this.gitComparison = { ...payload, root };
    this.gitPanelView = "changes";
    this.renderGitSidePanelState(this.$("git-results"), root, this.gitSideState);
    const firstFile = payload.files?.[0];
    if (firstFile) await this.openGitComparisonDiff(root, this.gitComparison, firstFile, false);
  },


  async openGitComparisonDiff(root, comparison, file, focus) {
    await this.openGitReviewDiff(root, file.path, "compare", focus, { base: comparison.base, target: comparison.target,
      previousPath: file.previous_path || "", updateUrl: true });
  },


  async gitOperationAction(root, action) {
    if (["abort", "skip"].includes(action)) {
      const confirmed = await this.confirmGitAction(`${action === "abort" ? "Abort" : "Skip during"} Git operation`,
        action === "abort" ? "Discard the in-progress Git operation and return to its starting point?"
          : "Skip the current commit and continue the in-progress Git operation?",
        action === "abort" ? "Abort operation" : "Skip commit", action === "abort");
      if (!confirmed) return;
    }
    await this.gitWorkflowAction("/api/git/operation", { root, action });
  },


  gitWorkflowButton(icon, title, run, text = "") {
    const button = document.createElement("button");
    button.className = "git-workflow-button";
    button.title = title;
    button.setAttribute("aria-label", title);
    const glyph = document.createElement("span");
    glyph.className = `codicon codicon-${icon}`;
    button.appendChild(glyph);
    if (text) button.append(document.createTextNode(text));
    button.onclick = (event) => { event.stopPropagation(); run(); };
    return button;
  },


  gitTextButton(label, run, primary = false) {
    const button = document.createElement("button");
    button.className = `git-text-button${primary ? " primary" : ""}`;
    button.textContent = label;
    button.title = label;
    button.onclick = (event) => { event.stopPropagation(); run(); };
    return button;
  },


  openGitDialog({ title, description = "", fields = [], submitLabel = "Continue", danger = false,
                  hideCancel = false }) {
    return new Promise((resolve) => {
      const backdrop = document.createElement("div");
      backdrop.className = "git-dialog-backdrop";
      const form = document.createElement("form");
      form.className = "git-dialog";
      form.setAttribute("role", "dialog");
      form.setAttribute("aria-modal", "true");
      const heading = document.createElement("div");
      heading.className = "git-dialog-title";
      heading.textContent = title;
      form.appendChild(heading);
      if (description) {
        const detail = document.createElement("div");
        detail.className = "git-dialog-description";
        detail.textContent = description;
        form.appendChild(detail);
      }
      const controls = new Map();
      for (const field of fields) {
        const label = document.createElement("label");
        label.className = `git-dialog-field${field.type === "checkbox" ? " checkbox" : ""}`;
        const caption = document.createElement("span");
        caption.textContent = field.label;
        let control;
        if (field.type === "textarea") {
          control = document.createElement("textarea");
          control.rows = field.rows || 5;
          control.value = field.value || "";
        } else if (field.type === "select") {
          control = document.createElement("select");
          for (const choice of field.options || []) {
            const option = document.createElement("option");
            option.value = typeof choice === "string" ? choice : choice.value;
            option.textContent = typeof choice === "string" ? choice : choice.label;
            control.appendChild(option);
          }
          control.value = field.value || "";
        } else {
          control = document.createElement("input");
          control.type = field.type || "text";
          if (control.type === "checkbox") control.checked = field.checked !== false;
          else control.value = field.value || "";
        }
        control.name = field.name;
        control.placeholder = field.placeholder || "";
        control.required = !!field.required;
        if (field.suggestions?.length && control instanceof HTMLInputElement) {
          const listId = `git-dialog-${field.name}-${Math.random().toString(36).slice(2)}`;
          const suggestions = document.createElement("datalist");
          suggestions.id = listId;
          for (const suggestion of field.suggestions) {
            const option = document.createElement("option");
            option.value = typeof suggestion === "string" ? suggestion : suggestion.name || suggestion.value || "";
            option.label = typeof suggestion === "string" ? "" : suggestion.kind || suggestion.label || "";
            suggestions.appendChild(option);
          }
          control.setAttribute("list", listId);
          label.append(caption, control, suggestions);
        } else if (field.type === "checkbox") label.append(control, caption);
        else label.append(caption, control);
        controls.set(field.name, control);
        form.appendChild(label);
      }
      const actions = document.createElement("div");
      actions.className = "git-dialog-actions";
      if (!hideCancel) {
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.textContent = "Cancel";
        cancel.onclick = () => close(null);
        actions.appendChild(cancel);
      }
      const submit = document.createElement("button");
      submit.type = "submit";
      submit.className = danger ? "danger" : "primary";
      submit.textContent = submitLabel;
      actions.appendChild(submit);
      form.appendChild(actions);
      backdrop.appendChild(form);
      const close = (value) => {
        document.removeEventListener("keydown", onKeyDown, true);
        backdrop.remove();
        requestAnimationFrame(() => this.focusActiveEditor());
        resolve(value);
      };
      const onKeyDown = (event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopImmediatePropagation();
        close(null);
      };
      form.onsubmit = (event) => {
        event.preventDefault();
        const values = {};
        for (const [name, control] of controls) {
          values[name] = control.type === "checkbox" ? control.checked : control.value;
        }
        close(values);
      };
      backdrop.onmousedown = (event) => {
        if (event.target === backdrop) close(null);
      };
      document.addEventListener("keydown", onKeyDown, true);
      document.body.appendChild(backdrop);
      requestAnimationFrame(() => (controls.values().next().value || submit).focus());
    });
  },


  async confirmGitAction(title, description, submitLabel, danger = false) {
    return !!await this.openGitDialog({ title, description, submitLabel, danger, fields: [] });
  },


  async showGitMessage(title, description) {
    await this.openGitDialog({ title, description, submitLabel: "Close", hideCancel: true, fields: [] });
  },


  renderGitSideGroupHeader(container, label, icon) {
    const header = document.createElement("div");
    header.className = "git-group-header";
    const glyph = document.createElement("span");
    glyph.className = `codicon codicon-${icon}`;
    const text = document.createElement("span");
    text.textContent = label;
    header.append(glyph, text);
    container.appendChild(header);
  },


  createGitPanelSection(container, label, icon, extraClass = "", options = {}) {
    const section = document.createElement("section");
    section.className = `git-panel-section${extraClass ? ` ${extraClass}` : ""}${options.collapsed ? " collapsed" : ""}`;
    const header = document.createElement("div");
    header.className = "git-panel-section-header";
    if (options.collapsible) {
      const chevron = document.createElement("span");
      chevron.className = `codicon codicon-chevron-${options.collapsed ? "right" : "down"} git-panel-chevron`;
      header.appendChild(chevron);
      header.onclick = () => {
        const collapsed = section.classList.toggle("collapsed");
        chevron.className = `codicon codicon-chevron-${collapsed ? "right" : "down"} git-panel-chevron`;
        options.onToggle?.(collapsed);
      };
    }
    const glyph = document.createElement("span");
    glyph.className = `codicon codicon-${icon}`;
    const title = document.createElement("span");
    title.textContent = label;
    header.append(glyph, title);
    if (options.action) header.appendChild(options.action);
    const body = document.createElement("div");
    body.className = "git-panel-section-body";
    section.append(header, body);
    container.appendChild(section);
    return body;
  },


  renderGitSideFile(container, root, file, scope, orderedPaths) {
    const row = document.createElement("div");
    row.className = "tree-row file git-file-row";
    row.dataset.path = file.path;
    row.dataset.scope = scope;
    row.classList.toggle("selected", this.gitSelectedPaths.has(file.path));
    row.classList.toggle("focused", this.gitReviewOpen && this.gitFocusedFile?.path === file.path && this.gitFocusedFile?.scope === scope);
    row.title = `${root}/${file.path}\nClick to review pending changes; middle-click opens the working file in a new TermDeck tab`;
    row.append(this.fileTypeIconEl(file.path.split("/").pop(), "tree-type-icon"));
    const name = document.createElement("span");
    name.className = "tree-name";
    name.textContent = file.path;
    row.appendChild(name);
    this.appendGitStatus(row, { git_status: file.status });
    const actions = document.createElement("span");
    actions.className = "git-file-actions";
    if (file.conflicted) {
      actions.appendChild(this.gitWorkflowButton("git-merge", "Open merge resolver", () =>
        this.openGitReviewDiff(root, file.path, "conflict", true, { updateUrl: true })));
    } else {
      if (file.staged) actions.appendChild(this.gitWorkflowButton("remove", "Unstage", () => this.gitStagePaths(root, [file], false)));
      if (file.unstaged || file.untracked) {
        actions.appendChild(this.gitWorkflowButton("add", "Stage", () => this.gitStagePaths(root, [file], true)));
      }
    }
    row.appendChild(actions);
    row.onclick = (event) => this.selectGitFile(event, container, root, file, scope, orderedPaths);
    row.onauxclick = (event) => this.handleFileDeckAuxClick(event, root, file.path);
    row.oncontextmenu = (event) => this.openGitFileContextMenu(event, root, file, scope);
    container.appendChild(row);
  },


  openGitFileContextMenu(event, root, file, scope) {
    event.preventDefault();
    event.stopPropagation();
    this.gitHistoryScopePaths = [];
    if (!this.gitSelectedPaths.has(file.path)) {
      this.gitSelectedPaths = new Set([file.path]);
      this.gitSelectionExplicitlyCleared = false;
      this.gitSelectionAnchorPath = file.path;
    }
    this.gitFocusedFile = { root, path: file.path, scope };
    this.gitSelectionExplicitlyCleared = this.gitSelectedPaths.size === 0;
    const selectedFiles = (this.gitSideState?.files || []).filter((candidate) => this.gitSelectedPaths.has(candidate.path));
    const menu = this.$("context-menu");
    menu.textContent = "";
    this.contextMenuTarget = { type: "git-files", paths: [...this.gitSelectedPaths] };
    this.addContextItem(menu, file.conflicted ? "Open merge resolver" : "View pending diff",
      () => this.openGitReviewDiff(root, file.path, scope, true, { updateUrl: true }), file.conflicted ? "git-merge" : "diff");
    this.addContextItem(menu, "Open working file", () => this.openFile(root, file.path, null, null,
      { fromFilePanel: true, pinned: true }), "go-to-file");
    this.addContextItem(menu, "Open working file in new browser tab", () => this.openFileDeckInNewTab(root, file.path), "new-window");
    this.addOpenFileExternallyContextItem(menu, root, file.path);
    this.addGitPathContextActions(menu, root, file.path, false);
    if (selectedFiles.some((candidate) => !candidate.conflicted && (candidate.unstaged || candidate.untracked))) {
      this.addContextItem(menu, `Stage${selectedFiles.length > 1 ? ` ${selectedFiles.length} files` : ""}`,
        () => this.gitStagePaths(root, selectedFiles, true), "add");
    }
    if (selectedFiles.some((candidate) => !candidate.conflicted && candidate.staged)) {
      this.addContextItem(menu, `Unstage${selectedFiles.length > 1 ? ` ${selectedFiles.length} files` : ""}`,
        () => this.gitStagePaths(root, selectedFiles, false), "remove");
    }
    if (selectedFiles.length === 1 && file.conflicted) {
      this.addContextItem(menu, "Accept ours and stage…", () => this.gitResolveConflict(root, file.path, "ours"), "arrow-left");
      this.addContextItem(menu, "Accept theirs and stage…", () => this.gitResolveConflict(root, file.path, "theirs"), "arrow-right");
    }
    this.addContextItem(menu, `Revert${selectedFiles.length > 1 ? ` ${selectedFiles.length} files` : " changes"} to HEAD…`,
      () => this.gitRevertPaths(root, selectedFiles), "discard");
    if (selectedFiles.length === 1) {
      this.addFileHistoryContextSubmenu(menu, root, file.path);
    } else {
      this.addContextItem(menu, `Show Git history for ${selectedFiles.length} files`,
        () => this.loadGitCommitGraph(root, [...this.gitSelectedPaths]), "git-commit");
    }
    this.addContextItem(menu, "Copy relative path", () => this.copyTextToClipboard(file.path, "relative path copied"), "copy");
    this.positionContextMenu(menu, event.clientX, event.clientY);
  },


  selectGitFile(event, container, root, file, scope, orderedPaths) {
    this.gitHistoryScopePaths = [];
    const additive = event.metaKey || event.ctrlKey;
    if (event.shiftKey && this.gitSelectionAnchorPath) {
      const anchorIndex = orderedPaths.indexOf(this.gitSelectionAnchorPath);
      const targetIndex = orderedPaths.indexOf(file.path);
      if (anchorIndex >= 0 && targetIndex >= 0) {
        if (!additive) this.gitSelectedPaths.clear();
        const [start, end] = anchorIndex < targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
        for (const path of orderedPaths.slice(start, end + 1)) this.gitSelectedPaths.add(path);
      }
    } else if (additive) {
      if (this.gitSelectedPaths.has(file.path)) this.gitSelectedPaths.delete(file.path);
      else this.gitSelectedPaths.add(file.path);
      this.gitSelectionAnchorPath = file.path;
    } else {
      this.gitSelectedPaths = new Set([file.path]);
      this.gitSelectionAnchorPath = file.path;
    }
    this.gitSelectionExplicitlyCleared = this.gitSelectedPaths.size === 0;
    this.gitFocusedFile = { root, path: file.path, scope };
    if (this.gitSideState) this.renderGitSidePanelState(container, root, this.gitSideState);
    if (!additive && !event.shiftKey) void this.openGitReviewDiff(root, file.path, scope, false, { updateUrl: true });
  },


  renderGitAgentWorktrees(container, agents) {
    if (!agents.length) return;
    this.renderGitSideGroupHeader(container, `agent worktrees (${agents.length})`, "organization");
    for (const agent of agents) {
      const details = document.createElement("details");
      details.className = "git-agent-details";
      const row = document.createElement("summary");
      row.className = "git-agent-row";
      const status = document.createElement("span");
      status.className = `git-agent-status${agent.processing ? " working" : ""}`;
      const title = document.createElement("span");
      title.className = "git-agent-title";
      title.textContent = agent.sessions?.length === 1 ? agent.sessions[0].title : `${agent.sessions?.length || 0} agents`;
      const branch = document.createElement("span");
      branch.className = "git-agent-branch";
      branch.textContent = `${agent.branch} · ${agent.changed_files}`;
      row.append(status, title, branch);
      const sessionNames = (agent.sessions || []).map((session) => `${session.agent_kind}: ${session.title}`).join("\n");
      row.title = `${agent.worktree}\n${sessionNames}\n${agent.changed_files} worktree changes`;
      details.appendChild(row);
      for (const file of agent.files || []) {
        const fileRow = document.createElement("div");
        fileRow.className = "git-agent-file";
        fileRow.append(this.fileTypeIconEl(file.path.split("/").pop(), "tree-type-icon"));
        const fileName = document.createElement("span");
        fileName.textContent = file.path;
        fileRow.appendChild(fileName);
        this.appendGitStatus(fileRow, { git_status: file.status });
        fileRow.onclick = () => void this.openFile(agent.worktree, file.path, null, fileRow,
                                                   { fromFilePanel: true, pinned: false });
        details.appendChild(fileRow);
      }
      for (const session of agent.sessions || []) {
        if (!this.session(session.session_id)) continue;
        const open = this.gitWorkflowButton("terminal", `Open ${session.title}`,
                                            () => this.activate(session.session_id), ` ${session.title}`);
        open.classList.add("git-agent-open");
        details.appendChild(open);
      }
      container.appendChild(details);
    }
  },


  renderGitStashes(container, root, stashes) {
    if (!stashes.length) {
      const empty = document.createElement("div");
      empty.className = "file-inspector-empty";
      empty.textContent = "No saved stashes.";
      container.appendChild(empty);
      return;
    }
    for (const stash of stashes) {
      const row = document.createElement("div");
      row.className = "git-stash-row";
      const name = document.createElement("span");
      name.className = "git-stash-name";
      name.textContent = stash.message;
      const actions = document.createElement("span");
      actions.className = "git-row-actions";
      actions.append(
        this.gitWorkflowButton("play", "Apply stash", () => this.gitStashAction(root, stash.reference, "apply")),
        this.gitWorkflowButton("move", "Pop stash", () => this.gitStashAction(root, stash.reference, "pop")),
        this.gitWorkflowButton("trash", "Delete stash", () => this.gitStashAction(root, stash.reference, "drop")),
      );
      row.append(name, actions);
      row.title = `${stash.reference} · ${stash.created_at}`;
      container.appendChild(row);
    }
  },


  renderGitWorktrees(container, root, worktrees, repositoryRoot) {
    this.renderGitSideGroupHeader(container, `worktrees (${worktrees.length})`, "repo");
    for (const worktree of worktrees) {
      const row = document.createElement("div");
      row.className = "git-worktree-row";
      const name = document.createElement("span");
      name.className = "git-worktree-name";
      name.textContent = worktree.branch || "detached";
      const path = document.createElement("span");
      path.className = "git-worktree-path";
      path.textContent = worktree.path;
      row.append(name, path);
      if (worktree.path !== repositoryRoot) {
        row.appendChild(this.gitWorkflowButton("trash", "Remove clean worktree", () => this.gitRemoveWorktree(root, worktree.path)));
      }
      row.title = worktree.path;
      container.appendChild(row);
    }
    const prune = this.gitWorkflowButton("clear-all", "Prune missing worktrees", () => this.gitPruneWorktrees(root), " prune missing");
    prune.classList.add("git-worktree-prune");
    container.appendChild(prune);
  },


  renderGitRemotes(container, root, remotes, branch) {
    this.renderGitSideGroupHeader(container, `remotes (${remotes.length})`, "remote");
    if (!remotes.length) {
      const empty = document.createElement("div");
      empty.className = "file-inspector-empty";
      empty.textContent = "No remotes. Add an SSH or HTTPS repository URL.";
      container.appendChild(empty);
      return;
    }
    for (const remote of remotes) {
      const row = document.createElement("div");
      row.className = "git-remote-row";
      const name = document.createElement("span");
      name.className = "git-remote-name";
      name.textContent = remote.name;
      const url = document.createElement("span");
      url.className = "git-remote-url";
      url.textContent = remote.fetch_url;
      const actions = document.createElement("span");
      actions.className = "git-row-actions";
      actions.append(
        this.gitWorkflowButton("sync", `Fetch ${remote.name}`, () => this.gitRemoteAction(root, remote.name, "fetch", branch)),
        this.gitWorkflowButton("cloud-download", `Pull ${remote.name}/${branch}`, () => this.gitRemoteAction(root, remote.name, "pull", branch)),
        this.gitWorkflowButton("cloud-upload", `Push ${branch} to ${remote.name}`, () => this.gitRemoteAction(root, remote.name, "push", branch)),
        this.gitWorkflowButton("trash", `Remove remote ${remote.name}`, () => this.gitRemoteAction(root, remote.name, "remove", branch)),
      );
      row.append(name, url, actions);
      row.title = `Fetch: ${remote.fetch_url}\nPush: ${remote.push_url}`;
      container.appendChild(row);
    }
  },


  renderGitPullRequestPanel(container, root) {
    if (this.gitReviewOpen && this.gitFocusedFile?.scope !== "pull-request") this.closeGitReview(false);
    if (this.gitPullRequestRoot !== root) {
      this.gitPullRequestRoot = root;
      this.gitPullRequests = [];
      this.gitPullRequestDetail = null;
      this.gitPullRequestLoaded = false;
      this.gitPullRequestError = "";
    }
    const toolbar = document.createElement("div");
    toolbar.className = "git-pull-request-toolbar";
    const state = document.createElement("select");
    state.setAttribute("aria-label", "Pull-request state");
    for (const [value, label] of [["open", "Open"], ["closed", "Closed"], ["merged", "Merged"], ["all", "All"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      state.appendChild(option);
    }
    state.value = this.gitPullRequestState;
    state.onchange = () => {
      this.gitPullRequestState = state.value;
      this.gitPullRequestDetail = null;
      this.gitPullRequestLoaded = false;
      this.gitPullRequestError = "";
      void this.loadGitPullRequests(root, true);
    };
    toolbar.appendChild(state);
    container.appendChild(toolbar);
    const panel = this.createGitPanelSection(container, "GitHub pull requests", "github", "git-pull-requests-panel");
    if (this.gitPullRequestLoading) {
      const loading = document.createElement("div");
      loading.className = "file-inspector-empty";
      loading.textContent = "Loading pull requests…";
      panel.appendChild(loading);
      return;
    }
    if (this.gitPullRequestError) {
      const error = document.createElement("div");
      error.className = "git-pull-request-error";
      error.textContent = this.gitPullRequestError;
      panel.appendChild(error);
      return;
    }
    if (!this.gitPullRequests.length) {
      const empty = document.createElement("div");
      empty.className = "file-inspector-empty";
      empty.textContent = "No pull requests found for this filter.";
      panel.appendChild(empty);
    }
    for (const pullRequest of this.gitPullRequests) {
      const selected = this.gitPullRequestDetail?.number === pullRequest.number;
      const row = document.createElement("div");
      row.className = `git-pull-request-row${selected ? " active" : ""}`;
      row.tabIndex = 0;
      row.dataset.number = String(pullRequest.number);
      const number = document.createElement("span");
      number.className = "git-pull-request-number";
      number.textContent = `#${pullRequest.number}`;
      const title = document.createElement("span");
      title.className = "git-pull-request-title";
      title.textContent = pullRequest.title;
      const branch = document.createElement("span");
      branch.className = "git-pull-request-branch";
      branch.textContent = `${pullRequest.head_branch} → ${pullRequest.base_branch}`;
      row.append(number, title, branch);
      row.title = `${pullRequest.author} · ${pullRequest.head_branch} → ${pullRequest.base_branch}${pullRequest.draft ? " · draft" : ""}`;
      row.onclick = () => void this.loadGitPullRequestDetail(root, pullRequest.number);
      row.onkeydown = (event) => this.handleGitPullRequestKeyDown(event, root, pullRequest.number);
      row.oncontextmenu = (event) => {
        event.preventDefault();
        event.stopPropagation();
        const menu = this.$("context-menu");
        menu.textContent = "";
        this.addContextItem(menu, "Open on GitHub", () => window.open(pullRequest.url, "_blank", "noopener"), "link-external");
        this.addContextItem(menu, "View patch", () => this.openGitHubPullRequestPatch(root, pullRequest), "diff");
        this.addContextItem(menu, "Copy pull-request URL", () => this.copyTextToClipboard(pullRequest.url, "pull-request URL copied"), "copy");
        this.positionContextMenu(menu, event.clientX, event.clientY);
      };
      panel.appendChild(row);
      if (selected) this.renderGitPullRequestDetail(panel, root, this.gitPullRequestDetail);
    }
    if (!this.gitPullRequestLoaded && !this.gitPullRequestError) {
      void this.loadGitPullRequests(root);
    }
  },


  async loadGitPullRequests(root, force = false) {
    if (this.gitPullRequestLoading || !force && this.gitPullRequestRoot === root && this.gitPullRequests.length) return;
    const generation = ++this.gitPullRequestGeneration;
    this.gitPullRequestLoading = true;
    this.gitPullRequestError = "";
    if (this.gitPanelView === "pull-requests" && this.gitSideState) {
      this.renderGitSidePanelState(this.$("git-results"), root, this.gitSideState);
    }
    try {
      const response = await fetch(`/api/git/github/pull-requests?${new URLSearchParams({ root,
        state: this.gitPullRequestState, limit: "50" })}`);
      const payload = await response.json().catch(() => ([]));
      if (generation !== this.gitPullRequestGeneration) return;
      if (!response.ok) {
        this.gitPullRequestError = payload.detail || "GitHub pull requests are unavailable.";
        this.gitPullRequests = [];
      } else {
        this.gitPullRequestRoot = root;
        this.gitPullRequests = payload;
        if (this.gitPullRequestDetail && !payload.some((item) => item.number === this.gitPullRequestDetail.number)) {
          this.gitPullRequestDetail = null;
        }
      }
      this.gitPullRequestLoaded = true;
    } catch (error) {
      if (generation !== this.gitPullRequestGeneration) return;
      this.gitPullRequestError = error.message || "GitHub pull requests are unavailable.";
      this.gitPullRequests = [];
      this.gitPullRequestLoaded = true;
    } finally {
      if (generation === this.gitPullRequestGeneration) {
        this.gitPullRequestLoading = false;
        if (this.gitPanelView === "pull-requests" && this.gitSideState) {
          this.renderGitSidePanelState(this.$("git-results"), root, this.gitSideState);
        }
      }
    }
  },


  async loadGitPullRequestDetail(root, number) {
    if (this.gitPullRequestDetail?.number === number && !this.gitPullRequestDetail.loading) {
      this.gitPullRequestDetail = null;
      this.renderGitSidePanelState(this.$("git-results"), root, this.gitSideState);
      return;
    }
    this.gitPullRequestDetail = { number, loading: true };
    this.renderGitSidePanelState(this.$("git-results"), root, this.gitSideState);
    const response = await fetch(`/api/git/github/pull-request?${new URLSearchParams({ root, number: String(number) })}`);
    const payload = await response.json().catch(() => ({}));
    if (this.gitPanelView !== "pull-requests" || this.gitPullRequestDetail?.number !== number) return;
    this.gitPullRequestDetail = response.ok ? payload : { number, error: payload.detail || "Pull request unavailable." };
    this.renderGitSidePanelState(this.$("git-results"), root, this.gitSideState);
  },


  renderGitPullRequestDetail(container, root, detail) {
    const body = document.createElement("div");
    body.className = "git-pull-request-detail";
    if (detail.loading || detail.error) {
      body.textContent = detail.loading ? "Loading details…" : detail.error;
      container.appendChild(body);
      return;
    }
    const metadata = document.createElement("div");
    metadata.className = "git-pull-request-metadata";
    metadata.textContent = `${detail.author} · ${detail.state.toLowerCase()} · ${detail.mergeable.toLowerCase()}`;
    const description = document.createElement("div");
    description.className = "git-pull-request-body";
    description.textContent = detail.body || "No pull-request description.";
    const actions = document.createElement("div");
    actions.className = "git-pull-request-actions";
    actions.append(
      this.gitTextButton("View patch", () => this.openGitHubPullRequestPatch(root, detail)),
      this.gitTextButton("Open GitHub", () => window.open(detail.url, "_blank", "noopener")),
      this.gitTextButton("Approve", () => this.submitGitHubPullRequestReview(root, detail, "approve")),
      this.gitTextButton("Comment", () => this.submitGitHubPullRequestReview(root, detail, "comment")),
      this.gitTextButton("Request changes", () => this.submitGitHubPullRequestReview(root, detail, "request-changes")),
    );
    body.append(metadata, description, actions);
    const files = document.createElement("div");
    files.className = "git-pull-request-files";
    for (const file of detail.files || []) {
      const row = document.createElement("div");
      row.className = "git-pull-request-file";
      row.append(this.fileTypeIconEl(file.path.split("/").pop(), "tree-type-icon"));
      const path = document.createElement("span");
      path.textContent = file.path;
      const changes = document.createElement("span");
      changes.textContent = `+${file.additions} −${file.deletions}`;
      row.append(path, changes);
      files.appendChild(row);
    }
    body.appendChild(files);
    container.appendChild(body);
  },


  handleGitPullRequestKeyDown(event, root, number) {
    if (["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      const rows = [...event.currentTarget.closest(".git-pull-requests-panel").querySelectorAll(".git-pull-request-row")];
      const next = rows[rows.indexOf(event.currentTarget) + (event.key === "ArrowDown" ? 1 : -1)];
      next?.focus();
      return;
    }
    if (["Enter", " "].includes(event.key)) {
      event.preventDefault();
      void this.loadGitPullRequestDetail(root, number);
    }
  },


  async openGitHubPullRequestPatch(root, pullRequest) {
    const response = await fetch(`/api/git/github/pull-request/patch?${new URLSearchParams({ root,
      number: String(pullRequest.number) })}`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      await this.showGitMessage("Pull-request patch unavailable", payload.detail || "The patch could not be loaded.");
      return;
    }
    await this.monacoReady;
    this.disposeGitReviewEditor();
    const model = monaco.editor.createModel(payload.patch || "", "diff",
      monaco.Uri.parse(`inmemory://termdeck-pull-request/${pullRequest.number}.diff`));
    this.gitReviewModels = [model];
    this.gitReviewTextEditor = monaco.editor.create(this.$("git-review-editor-host"), {
      ...this.fileHistoryEditorOptions(), readOnly: true, theme: this.monacoThemeName(), wordWrap: "off",
    });
    this.gitReviewTextEditor.setModel(model);
    this.gitReviewOpen = true;
    this.gitReviewKey = `${root}\u0000pull-request\u0000${pullRequest.number}`;
    this.gitFocusedFile = { root, path: `Pull request #${pullRequest.number}`, scope: "pull-request",
      number: pullRequest.number, url: pullRequest.url };
    this.activeFileKey = null;
    this.$("git-review-area").classList.add("git-review-patch");
    this.$("git-review-title").textContent = `#${pullRequest.number} ${pullRequest.title}`;
    this.$("git-review-title").title = pullRequest.url || "";
    this.$("git-review-scope").textContent = `${pullRequest.head_branch} → ${pullRequest.base_branch}`;
    this.updateGitConflictControls();
    this.updateGitReviewDiffNavigation();
    this.renderTopbar();
    this.applyMainLayout();
    requestAnimationFrame(() => {
      this.gitReviewTextEditor?.layout();
      this.gitReviewTextEditor?.focus();
    });
  },


  async submitGitHubPullRequestReview(root, pullRequest, action) {
    const labels = { approve: "Approve", comment: "Comment", "request-changes": "Request changes" };
    const values = await this.openGitDialog({
      title: `${labels[action]} pull request #${pullRequest.number}`,
      description: action === "approve" ? "Optionally include a review message." : "A review message is required.",
      submitLabel: labels[action],
      danger: action === "request-changes",
      fields: [{ name: "body", label: "Review message", type: "textarea", rows: 5,
        placeholder: action === "approve" ? "Optional" : "Describe your feedback…", required: action !== "approve" }],
    });
    if (!values || action !== "approve" && !values.body.trim()) return;
    const succeeded = await this.gitWorkflowAction("/api/git/github/pull-request/review",
      { root, number: pullRequest.number, action, body: values.body.trim() });
    if (!succeeded) return;
    this.gitPullRequestDetail = null;
    await this.loadGitPullRequests(root, true);
  },


  openGitHubRepository() {
    const remote = this.gitSideState?.remotes?.find((item) => item.name === "origin") || this.gitSideState?.remotes?.[0];
    const rawUrl = String(remote?.fetch_url || "");
    let url = rawUrl.replace(/^git@github\.com:/, "https://github.com/").replace(/\.git$/, "");
    if (!/^https?:\/\/github\.com\//.test(url)) {
      void this.showGitMessage("GitHub remote unavailable", "Add a GitHub SSH or HTTPS remote before opening the repository.");
      return;
    }
    window.open(url, "_blank", "noopener");
  },


  renderGitHistorySearch(container, root, paths) {
    const search = document.createElement("div");
    search.className = "git-history-search";
    const icon = document.createElement("span");
    icon.className = "codicon codicon-search";
    const input = document.createElement("input");
    input.type = "search";
    input.className = "git-history-search-input";
    input.placeholder = "Search commit messages";
    input.value = this.gitHistoryQuery;
    input.autocomplete = "off";
    input.maxLength = 200;
    input.spellcheck = false;
    input.setAttribute("aria-label", "Search commit messages");
    input.oninput = () => {
      this.gitHistoryQuery = input.value;
      this.gitHistoryLimit = 25;
      this.scheduleGitHistoryLoad(root, paths);
    };
    input.onkeydown = (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        clearTimeout(this.gitHistorySearchTimer);
        this.gitHistorySearchTimer = 0;
        void this.loadGitCommitGraph(root, paths, this.gitHistoryQuery);
      } else if (event.key === "Escape" && input.value) {
        event.preventDefault();
        clearTimeout(this.gitHistorySearchTimer);
        this.gitHistorySearchTimer = 0;
        input.value = "";
        this.gitHistoryQuery = "";
        this.gitHistoryLimit = 25;
        void this.loadGitCommitGraph(root, paths, "");
      }
    };
    const filters = this.gitWorkflowButton("filter", "Filter history by author, date, branch, or path", () => {
      this.gitHistoryFiltersOpen = !this.gitHistoryFiltersOpen;
      this.renderGitSidePanelState(this.$("git-results"), root, this.gitSideState);
    });
    filters.classList.toggle("on", Object.values(this.gitHistoryFilters).some((value) => String(value).trim()));
    search.append(icon, input, filters);
    container.appendChild(search);
    if (this.gitHistoryFiltersOpen) this.renderGitHistoryFilters(container, root, paths);
  },


  renderGitHistoryFilters(container, root, paths) {
    const panel = document.createElement("div");
    panel.className = "git-history-filters";
    const definitions = [
      ["author", "Author", "Name or email", "text"],
      ["since", "From", "", "date"],
      ["until", "To", "", "date"],
      ["revision", "Branch / tag / revision", "All references", "text"],
      ["path", "Path", paths.length === 1 ? paths[0] : "Repository-relative path", "text"],
    ];
    const revisionListId = `git-history-revisions-${Math.random().toString(36).slice(2)}`;
    for (const [key, label, placeholder, type] of definitions) {
      const field = document.createElement("label");
      field.className = `git-history-filter git-history-filter-${key}`;
      const caption = document.createElement("span");
      caption.textContent = label;
      const input = document.createElement("input");
      input.type = type;
      input.value = this.gitHistoryFilters[key] || "";
      input.placeholder = placeholder;
      input.autocomplete = "off";
      input.spellcheck = false;
      if (key === "revision") input.setAttribute("list", revisionListId);
      input.oninput = () => {
        this.gitHistoryFilters[key] = input.value;
        this.gitHistoryLimit = 25;
        this.gitGraphPathsKey = "";
        this.scheduleGitHistoryLoad(root, paths);
      };
      field.append(caption, input);
      panel.appendChild(field);
    }
    const revisions = document.createElement("datalist");
    revisions.id = revisionListId;
    for (const reference of this.gitSideState?.references || []) {
      const option = document.createElement("option");
      option.value = reference.name;
      option.label = reference.kind;
      revisions.appendChild(option);
    }
    panel.appendChild(revisions);
    const reset = this.gitTextButton("Reset filters", () => {
      this.gitHistoryFilters = { author: "", since: "", until: "", revision: "", path: "" };
      this.gitHistoryLimit = 25;
      this.gitGraphPathsKey = "";
      this.renderGitSidePanelState(this.$("git-results"), root, this.gitSideState);
    });
    reset.classList.add("git-history-filter-reset");
    panel.appendChild(reset);
    container.appendChild(panel);
  },


  scheduleGitHistoryLoad(root, paths) {
    clearTimeout(this.gitHistorySearchTimer);
    this.gitHistorySearchTimer = setTimeout(() => {
      this.gitHistorySearchTimer = 0;
      void this.loadGitCommitGraph(root, paths, this.gitHistoryQuery);
    }, 280);
  },


  gitHistoryEffectivePaths(paths) {
    const filteredPath = String(this.gitHistoryFilters.path || "").trim();
    return filteredPath ? [filteredPath] : paths;
  },


  gitCommitGraphKey(root, paths, query = "") {
    const filters = this.gitHistoryFilters;
    return JSON.stringify([root, query.trim(), filters.author.trim(), filters.since.trim(), filters.until.trim(),
      filters.revision.trim(), ...this.gitHistoryEffectivePaths(paths)]);
  },


  renderGitCommitGraph(container, root, graph, paths = [], query = "") {
    if (this.gitGraphError) {
      const error = document.createElement("div");
      error.className = "git-pull-request-error";
      error.textContent = this.gitGraphError;
      container.appendChild(error);
      return;
    }
    if (!graph.length) {
      const empty = document.createElement("div");
      empty.className = "file-inspector-empty";
      empty.textContent = query.trim() ? `No commit messages match “${query.trim()}”.`
        : paths.length ? "No commits found for this selection." : "No commits in this worktree yet.";
      container.appendChild(empty);
      return;
    }
    const visibleGraph = [];
    let visibleCommits = 0;
    for (const line of graph) {
      const commitLine = /[0-9a-f]{4,64}/i.test(line.split("\u0000", 1)[0] || "");
      if (commitLine && visibleCommits >= this.gitHistoryLimit) break;
      visibleGraph.push(line);
      if (commitLine) visibleCommits += 1;
    }
    for (const line of visibleGraph) {
      const fields = line.split("\u0000");
      const commitId = (fields[0] || "").match(/[0-9a-f]{4,64}/i)?.[0] || "";
      if (!commitId) {
        const connector = document.createElement("div");
        connector.className = "git-graph-connector";
        connector.textContent = fields[0] || "";
        container.appendChild(connector);
        continue;
      }
      const entry = document.createElement("div");
      const activeCommit = this.gitReviewOpen && this.gitFocusedFile?.scope === "commit" &&
        this.gitCommitIdsMatch(this.gitFocusedFile.revision, commitId);
      const expandedCommit = this.gitCommitIdsMatch(this.gitExpandedCommitId, commitId);
      entry.className = `git-graph-entry${expandedCommit ? " expanded" : ""}${activeCommit ? " active" : ""}`;
      const row = document.createElement("div");
      row.className = "git-graph-row";
      row.tabIndex = 0;
      row.dataset.commitId = commitId;
      const graphText = document.createElement("span");
      graphText.className = "git-graph-lines";
      graphText.textContent = fields[0] || "";
      const message = document.createElement("span");
      message.className = "git-graph-message";
      message.textContent = fields[1] || "";
      const age = document.createElement("span");
      age.className = "git-graph-age";
      const committedAtEpoch = Number(fields[2]) || 0;
      age.textContent = committedAtEpoch ? this.formatMtime(committedAtEpoch) : fields[2] || "";
      age.title = committedAtEpoch ? new Date(committedAtEpoch * 1000).toLocaleString() : fields[2] || "";
      row.append(graphText, message, age);
      row.title = [fields[1], fields[3]].filter(Boolean).join("\n");
      row.onclick = () => void this.selectGitCommit(root, commitId, false);
      row.onkeydown = (event) => this.handleGitCommitKeyDown(event, root, commitId);
      row.oncontextmenu = (event) => this.openGitCommitContextMenu(event, root, commitId, paths, fields[1] || "");
      entry.appendChild(row);
      if (expandedCommit) this.renderGitCommitDetails(entry, root, commitId);
      container.appendChild(entry);
    }
    const totalCommits = graph.filter((line) => /[0-9a-f]{4,64}/i.test(line.split("\u0000", 1)[0] || "")).length;
    if (totalCommits > visibleCommits) {
      const loadMore = this.gitTextButton(`Load ${Math.min(25, totalCommits - visibleCommits)} more`, () => {
        this.gitHistoryLimit = Math.min(totalCommits, this.gitHistoryLimit + 25);
        this.renderGitSidePanelState(this.$("git-results"), root, this.gitSideState);
      });
      loadMore.classList.add("git-history-load-more");
      container.appendChild(loadMore);
    }
  },


  gitCommitIdsMatch(left, right) {
    const leftId = String(left || "").toLowerCase();
    const rightId = String(right || "").toLowerCase();
    return !!leftId && !!rightId && (leftId.startsWith(rightId) || rightId.startsWith(leftId));
  },


  updateGitReviewSelectionStyles() {
    for (const row of this.$("git-results")?.querySelectorAll(".git-file-row") || []) {
      row.classList.toggle("focused", this.gitReviewOpen && this.gitFocusedFile?.scope === row.dataset.scope &&
        this.gitFocusedFile?.path === row.dataset.path);
    }
    for (const row of this.$("git-results")?.querySelectorAll(".git-graph-row") || []) {
      row.closest(".git-graph-entry")?.classList.toggle("active", this.gitReviewOpen &&
        this.gitFocusedFile?.scope === "commit" && this.gitCommitIdsMatch(this.gitFocusedFile?.revision, row.dataset.commitId));
    }
    for (const row of this.$("git-results")?.querySelectorAll(".git-commit-file") || []) {
      row.classList.toggle("active", this.gitReviewOpen && this.gitFocusedFile?.scope === "commit" &&
        this.gitCommitIdsMatch(this.gitFocusedFile?.revision, row.dataset.commitId) && this.gitFocusedFile?.path === row.dataset.path);
    }
    for (const row of this.$("git-results")?.querySelectorAll(".git-comparison-file") || []) {
      row.classList.toggle("active", this.gitReviewOpen && this.gitFocusedFile?.scope === "compare" &&
        this.gitFocusedFile?.path === row.dataset.path);
    }
  },


  openGitCommitContextMenu(event, root, commitId, paths, message) {
    event.preventDefault();
    event.stopPropagation();
    const menu = this.$("context-menu");
    menu.textContent = "";
    this.contextMenuTarget = { type: "git-commit", commitId, paths };
    this.addContextItem(menu, "Show commit changes", () => this.selectGitCommit(root, commitId, true), "git-commit");
    this.addContextItem(menu, "Compare this commit with…", () => this.gitOpenComparison(root, commitId, "HEAD"), "compare-changes");
    this.addContextItem(menu, "Cherry-pick commit…", () => this.gitCommitAction(root, commitId, "cherry-pick"), "git-pull-request-go-to-changes");
    this.addContextItem(menu, "Revert commit…", () => this.gitCommitAction(root, commitId, "revert"), "discard");
    const focusedCommitPath = this.gitFocusedFile?.scope === "commit" &&
      this.gitCommitIdsMatch(this.gitFocusedFile.revision, commitId) ? this.gitFocusedFile.path : "";
    const comparisonPath = paths.length === 1 ? paths[0] : focusedCommitPath;
    if (comparisonPath) {
      this.addContextItem(menu, "Compare file at commit with current", () =>
        this.openGitCommitPathHistoryComparison(root, comparisonPath, commitId), "compare-changes");
      this.addContextItem(menu, "Open current file", () => this.openFile(root, comparisonPath, null, null,
        { fromFilePanel: true, pinned: true }), "go-to-file");
      this.addContextItem(menu, "Open file history", () => this.openFileHistoryForPath(root, comparisonPath, "all"), "history");
    }
    this.addContextItem(menu, "Copy commit hash", () => this.copyTextToClipboard(commitId, "commit hash copied"), "copy");
    if (message) this.addContextItem(menu, "Copy commit message", () => this.copyTextToClipboard(message, "commit message copied"), "copy");
    this.positionContextMenu(menu, event.clientX, event.clientY);
  },


  async gitCommitAction(root, commitId, action) {
    const verb = action === "cherry-pick" ? "Cherry-pick" : "Revert";
    const description = action === "cherry-pick"
      ? `Apply commit ${commitId} on top of the current branch? Conflicts will open the in-progress operation controls.`
      : `Create a new commit that reverses ${commitId}? Conflicts will open the in-progress operation controls.`;
    if (!await this.confirmGitAction(`${verb} commit`, description, verb, action === "revert")) return;
    await this.gitWorkflowAction("/api/git/commit/action", { root, commit_id: commitId, action });
  },


  handleGitCommitKeyDown(event, root, commitId) {
    if (["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      const rows = [...event.currentTarget.closest(".git-history-panel").querySelectorAll(".git-graph-row")];
      const currentIndex = rows.indexOf(event.currentTarget);
      const next = rows[currentIndex + (event.key === "ArrowDown" ? 1 : -1)];
      if (!next) return;
      next.focus();
      void this.selectGitCommit(root, next.dataset.commitId, true);
      return;
    }
    if (["Enter", " ", "ArrowRight"].includes(event.key)) {
      event.preventDefault();
      void this.selectGitCommit(root, commitId, event.key === "ArrowRight");
      return;
    }
    if (event.key === "ArrowLeft" && this.gitCommitIdsMatch(this.gitExpandedCommitId, commitId)) {
      event.preventDefault();
      this.gitExpandedCommitId = "";
      this.closeGitReview(false);
      this.renderGitSidePanelState(this.$("git-results"), root, this.gitSideState);
      requestAnimationFrame(() => this.$("git-results")?.querySelector(`[data-commit-id="${CSS.escape(commitId)}"]`)?.focus());
    }
  },


  async selectGitCommit(root, commitId, keepOpen) {
    if (!commitId) return;
    this.gitExpandedCommitId = keepOpen || !this.gitCommitIdsMatch(this.gitExpandedCommitId, commitId) ? commitId : "";
    if (!this.gitExpandedCommitId) {
      this.closeGitReview(false);
      this.renderGitSidePanelState(this.$("git-results"), root, this.gitSideState);
      return;
    }
    this.closeGitReview(false);
    this.renderGitSidePanelState(this.$("git-results"), root, this.gitSideState);
    if (!this.gitCommitDetails.has(commitId)) await this.loadGitCommitDetails(root, commitId);
    else await this.openFirstGitCommitDiff(root, this.gitCommitDetails.get(commitId));
    requestAnimationFrame(() => this.$("git-results")?.querySelector(`[data-commit-id="${CSS.escape(commitId)}"]`)?.focus());
  },


  async loadGitCommitDetails(root, commitId, openFirstDiff = true) {
    const generation = ++this.gitCommitDetailGeneration;
    const commit = await this.fetchGitCommitDetails(root, commitId);
    if (!commit || generation !== this.gitCommitDetailGeneration || !this.gitCommitIdsMatch(this.gitExpandedCommitId, commitId)) return;
    this.renderGitSidePanelState(this.$("git-results"), root, this.gitSideState);
    if (openFirstDiff) await this.openFirstGitCommitDiff(root, commit);
  },


  async fetchGitCommitDetails(root, commitId) {
    const cached = this.gitCommitDetails.get(commitId);
    if (cached) return cached;
    const response = await fetch(`/api/git/commit-detail?${new URLSearchParams({ root, commit_id: commitId })}`);
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      await this.showGitMessage("Commit unavailable", error.detail || "The selected commit could not be loaded.");
      return null;
    }
    const commit = await response.json();
    this.gitCommitDetails.set(commitId, commit);
    this.gitCommitDetails.set(commit.commit_id, commit);
    this.gitCommitDetails.set(commit.short_id, commit);
    return commit;
  },


  renderGitCommitDetails(container, root, commitId) {
    const details = document.createElement("div");
    details.className = "git-commit-details";
    const commit = this.gitCommitDetails.get(commitId);
    if (!commit) {
      details.textContent = "Loading commit changes…";
      container.appendChild(details);
      void this.loadGitCommitDetails(root, commitId, false);
      return;
    }
    const message = document.createElement("div");
    message.className = "git-commit-full-message";
    message.textContent = commit.message;
    const metadata = document.createElement("div");
    metadata.className = "git-commit-metadata";
    metadata.textContent = `${commit.author} <${commit.email}> · ${commit.committed_at}`;
    details.append(message, metadata);
    const files = document.createElement("div");
    files.className = "git-commit-files";
    for (const file of commit.files || []) {
      const row = document.createElement("button");
      row.type = "button";
      const activeFile = this.gitReviewOpen && this.gitFocusedFile?.scope === "commit" &&
        this.gitCommitIdsMatch(this.gitFocusedFile.revision, commit.commit_id) && this.gitFocusedFile.path === file.path;
      row.className = `git-commit-file${activeFile ? " active" : ""}`;
      row.dataset.commitId = commit.commit_id;
      row.dataset.path = file.path;
      const status = document.createElement("span");
      status.className = `git-commit-file-status status-${String(file.status || "M").toLowerCase()}`;
      status.textContent = file.status || "M";
      const path = document.createElement("span");
      path.className = "git-commit-file-path";
      path.textContent = file.previous_path ? `${file.previous_path} → ${file.path}` : file.path;
      row.append(status, this.fileTypeIconEl(file.path.split("/").pop(), "tree-type-icon"), path);
      row.title = `Show ${file.path} diff in ${commit.short_id}`;
      row.onclick = (event) => {
        event.stopPropagation();
        void this.openGitCommitDiff(root, commit, file, true);
      };
      row.oncontextmenu = (event) => this.openGitCommitFileContextMenu(event, root, commit, file);
      files.appendChild(row);
    }
    details.appendChild(files);
    container.appendChild(details);
  },


  async openFirstGitCommitDiff(root, commit) {
    const firstFile = commit?.files?.[0];
    if (firstFile) await this.openGitCommitDiff(root, commit, firstFile, false, true);
  },


  async openGitCommitDiff(root, commit, file, focus, updateUrl = true) {
    await this.openGitReviewDiff(root, file.path, "commit", focus,
      { revision: commit.commit_id, previousPath: file.previous_path || "", updateUrl });
  },


  openGitCommitFileContextMenu(event, root, commit, file) {
    event.preventDefault();
    event.stopPropagation();
    const menu = this.$("context-menu");
    menu.textContent = "";
    this.contextMenuTarget = { type: "git-commit-file", commitId: commit.commit_id, path: file.path };
    this.addContextItem(menu, "Show this commit diff", () => this.openGitCommitDiff(root, commit, file, true), "diff");
    this.addContextItem(menu, "Compare with current version", () =>
      this.openGitCommitPathHistoryComparison(root, file.path, commit.commit_id), "compare-changes");
    this.addContextItem(menu, "Open current file", () => this.openFile(root, file.path, null, null,
      { fromFilePanel: true, pinned: true }), "go-to-file");
    this.addContextItem(menu, "Open file history", () => this.openFileHistoryForPath(root, file.path, "all"), "history");
    this.addContextItem(menu, "Copy relative path", () => this.copyTextToClipboard(file.path, "relative path copied"), "copy");
    this.addContextItem(menu, "Copy commit hash", () => this.copyTextToClipboard(commit.commit_id, "commit hash copied"), "copy");
    this.positionContextMenu(menu, event.clientX, event.clientY);
  },


  async openGitCommitPathHistoryComparison(root, path, commitId) {
    const commit = await this.fetchGitCommitDetails(root, commitId);
    if (!commit) return;
    await this.openFileHistoryForPath(root, path, "all", { selection: ["current", `git:${commit.commit_id}`] });
  },


  async gitWorkflowAction(endpoint, payload) {
    if (this.gitActionPending) return false;
    this.gitActionPending = true;
    this.$("git-results")?.classList.add("git-action-pending");
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" },
                                               body: JSON.stringify(payload) });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        await this.showGitMessage("Git operation failed", error.detail || "The Git operation could not be completed.");
        await this.loadGitSidePanel();
        return false;
      }
      await this.loadGitSidePanel();
      return true;
    } catch (error) {
      await this.showGitMessage("Git operation failed", error.message || "The Git operation could not be completed.");
      return false;
    } finally {
      this.gitActionPending = false;
      this.$("git-results")?.classList.remove("git-action-pending");
    }
  },


  async gitStagePaths(root, files, stage) {
    const paths = files.filter((file) => !file.conflicted && (stage ? (file.unstaged || file.untracked) : file.staged))
      .map((file) => file.path);
    if (!paths.length) return;
    await this.gitWorkflowAction(stage ? "/api/git/stage" : "/api/git/unstage", { root, paths });
  },


  async gitRevertPaths(root, files) {
    const paths = [...new Set(files.map((file) => file.path))];
    if (!paths.length) return;
    const confirmed = await this.confirmGitAction(
      `Revert ${paths.length === 1 ? paths[0] : `${paths.length} files`} to HEAD?`,
      "Current working copies are moved to Trash first, so their contents remain recoverable. Staged and working-tree changes will both be reverted.",
      "Move copies to Trash and revert", true,
    );
    if (!confirmed) return;
    const reverted = await this.gitWorkflowAction("/api/git/revert", { root, paths });
    if (!reverted) return;
    const revertedKeys = [...this.openFiles.entries()]
      .filter(([, entry]) => entry.root === root && paths.includes(entry.path)).map(([key]) => key);
    if (revertedKeys.length) await this.closeFiles(revertedKeys, { discard: true });
  },


  openGitHistoryForPath(root, path) {
    this.gitHistoryQuery = "";
    this.gitHistoryFilters = { author: "", since: "", until: "", revision: "", path: "" };
    this.gitHistoryLimit = 25;
    this.gitGraphPathsKey = "";
    this.gitSelectedPaths.clear();
    this.gitSelectionExplicitlyCleared = true;
    this.gitSelectionAnchorPath = "";
    if (this.sideView === "git" && this.gitSideState) {
      void this.loadGitCommitGraph(root, [path], "", { historyScope: true });
      return;
    }
    this.gitPendingHistoryScope = { root, path };
    this.setSideView("git", false);
  },


  async loadGitCommitGraph(root, paths, query = "", options = {}) {
    const generation = ++this.gitGraphGeneration;
    const requestedPaths = [...paths];
    const effectivePaths = this.gitHistoryEffectivePaths(requestedPaths);
    const filters = this.gitHistoryFilters;
    const response = await fetch("/api/git/graph", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root, paths: effectivePaths, query, limit: 200, author: filters.author,
        since: filters.since, until: filters.until, revision: filters.revision }) });
    if (generation !== this.gitGraphGeneration || this.sideView !== "git" || !this.gitSideState) return;
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      this.gitGraphError = error.detail || "Git history could not be loaded.";
      this.gitGraphPathsKey = this.gitCommitGraphKey(root, requestedPaths, query);
      const graphContainer = this.$("git-results")?.querySelector(".git-history-graph");
      if (graphContainer) {
        graphContainer.textContent = "";
        this.renderGitCommitGraph(graphContainer, root, [], requestedPaths, query);
      }
      return;
    }
    const result = await response.json();
    this.gitGraphError = "";
    const resultRoot = result.repository_root || root;
    const resultPaths = result.paths || paths;
    this.gitSideState.graph = result.graph || [];
    this.gitGraphPathsKey = this.gitCommitGraphKey(resultRoot, requestedPaths, result.query || query);
    if (options.historyScope) {
      this.gitHistoryScopePaths = [...resultPaths];
      this.gitSelectionRoot = resultRoot;
      this.renderGitSidePanelState(this.$("git-results"), resultRoot, this.gitSideState);
      return;
    }
    const graphContainer = this.$("git-results")?.querySelector(".git-history-graph");
    if (!graphContainer) return;
    graphContainer.textContent = "";
    this.renderGitCommitGraph(graphContainer, resultRoot, this.gitSideState.graph, resultPaths, result.query || query);
  },


  disposeGitReviewEditor() {
    this.gitReviewDiffEditor?.dispose();
    this.gitReviewTextEditor?.dispose();
    this.gitReviewDiffEditor = null;
    this.gitReviewTextEditor = null;
    for (const model of this.gitReviewModels) model.dispose();
    this.gitReviewModels = [];
    this.gitConflictReview = null;
    this.gitReviewDiffPending = false;
    this.$("git-review-area")?.classList.remove("git-review-patch");
  },


  async openGitReviewDiff(root, path, scope, focus, options = {}) {
    const revision = String(options.revision || "");
    const previousPath = String(options.previousPath || "");
    const base = String(options.base || "");
    const target = String(options.target || "");
    const reviewKey = `${root}\u0000${path}\u0000${scope}\u0000${revision}\u0000${previousPath}\u0000${base}\u0000${target}`;
    if (!focus && this.gitReviewOpen && this.gitReviewKey === reviewKey) {
      if (options.history !== false && options.updateUrl) {
        this.pushNav({ kind: "git-diff", path, scope, revision, previous_path: previousPath, base, target });
      }
      return;
    }
    this.gitPendingReview = { root, reviewKey };
    const generation = ++this.gitReviewGeneration;
    const response = scope === "compare"
      ? await fetch("/api/git/compare/review", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root, path, previous_path: previousPath, base, target }) })
      : await fetch(`/api/git/review?${new URLSearchParams({ root, path, scope, revision,
                                                             previous_path: previousPath })}`);
    if (!response.ok) {
      if (this.gitPendingReview?.reviewKey === reviewKey) this.gitPendingReview = null;
      if (focus) {
        const error = await response.json().catch(() => ({}));
        await this.showGitMessage("Git diff unavailable", error.detail || "The pending diff could not be loaded.");
      }
      return;
    }
    const review = await response.json();
    await this.monacoReady;
    if (generation !== this.gitReviewGeneration || this.sideView !== "git") {
      if (this.gitPendingReview?.reviewKey === reviewKey) this.gitPendingReview = null;
      return;
    }
    this.disposeGitReviewEditor();
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const conflictReview = scope === "conflict";
    if (conflictReview && !["base", "ours", "theirs"].includes(this.gitConflictSource)) this.gitConflictSource = "theirs";
    const originalContent = conflictReview ? String(review[this.gitConflictSource] ?? review.theirs ?? review.original) : review.original;
    const originalModel = monaco.editor.createModel(originalContent, undefined,
      monaco.Uri.parse(`inmemory://termdeck-git-review/original/${encodedPath}`));
    const modifiedModel = monaco.editor.createModel(review.modified, undefined,
      monaco.Uri.parse(`inmemory://termdeck-git-review/modified/${encodedPath}`));
    this.gitReviewModels = [originalModel, modifiedModel];
    this.gitReviewDiffEditor = monaco.editor.createDiffEditor(this.$("git-review-editor-host"), {
      ...this.fileHistoryEditorOptions(), readOnly: !conflictReview, originalEditable: false, renderSideBySide: this.gitReviewSideBySide,
      theme: this.monacoThemeName(),
    });
    this.gitReviewDiffPending = true;
    this.gitReviewDiffEditor.setModel({ original: originalModel, modified: modifiedModel });
    this.gitReviewDiffIndex = -1;
    this.gitReviewDiffEditor.onDidUpdateDiff(() => {
      this.gitReviewDiffPending = false;
      this.updateGitReviewDiffNavigation();
    });
    this.gitReviewOpen = true;
    this.gitReviewKey = reviewKey;
    this.gitPendingReview = null;
    this.gitFocusedFile = { root, path, scope, revision, previousPath, base, target };
    this.gitConflictReview = conflictReview ? { ...review, root, path, originalModel, modifiedModel } : null;
    this.updateGitReviewSelectionStyles();
    this.activeFileKey = null;
    this.$("git-review-title").textContent = path;
    this.$("git-review-title").title = `${root}/${path}`;
    this.$("git-review-scope").textContent = conflictReview
      ? `${this.gitConflictSource} → merge result` : `${review.original_label} → ${review.modified_label}`;
    this.updateGitConflictControls();
    if (options.history !== false && (focus || options.updateUrl)) {
      this.pushNav({ kind: "git-diff", path, scope, revision, previous_path: previousPath, base, target });
    }
    this.renderTopbar();
    this.$("status-name").textContent = `${path} · ${review.original_label} → ${review.modified_label}`;
    this.applyMainLayout();
    requestAnimationFrame(() => {
      this.gitReviewDiffEditor?.layout();
      this.updateGitReviewDiffNavigation();
      if (focus) this.gitReviewDiffEditor?.getModifiedEditor().focus();
    });
  },


  gitReviewLineChanges() {
    const changes = this.gitReviewDiffEditor?.getLineChanges();
    return Array.isArray(changes) ? changes : null;
  },


  updateGitReviewDiffNavigation() {
    const changes = this.gitReviewLineChanges() || [];
    const patchReview = !!this.gitReviewTextEditor;
    if (!changes.length) this.gitReviewDiffIndex = -1;
    else if (this.gitReviewDiffIndex >= changes.length) this.gitReviewDiffIndex = changes.length - 1;
    this.$("git-review-position").textContent = this.gitReviewDiffPending ? "…" : changes.length
      ? `${Math.max(0, this.gitReviewDiffIndex) + 1}/${changes.length}` : "0/0";
    this.$("git-review-previous").disabled = patchReview || !changes.length;
    this.$("git-review-next").disabled = patchReview || !changes.length;
    this.$("git-review-layout").disabled = patchReview;
    this.$("git-review-open-file").disabled = patchReview;
    this.$("git-review-layout").classList.toggle("on", !this.gitReviewSideBySide);
  },


  navigateGitReviewDiff(direction) {
    const changes = this.gitReviewLineChanges() || [];
    if (!changes.length) return;
    this.gitReviewDiffIndex = (this.gitReviewDiffIndex + direction + changes.length) % changes.length;
    const change = changes[this.gitReviewDiffIndex];
    const modifiedLine = change.modifiedStartLineNumber || change.modifiedEndLineNumber;
    const originalLine = change.originalStartLineNumber || change.originalEndLineNumber;
    if (modifiedLine) this.gitReviewDiffEditor.getModifiedEditor().revealLineInCenter(modifiedLine);
    if (originalLine) this.gitReviewDiffEditor.getOriginalEditor().revealLineInCenter(originalLine);
    this.updateGitReviewDiffNavigation();
  },


  toggleGitReviewLayout() {
    this.gitReviewSideBySide = !this.gitReviewSideBySide;
    this.gitReviewDiffEditor?.updateOptions({ renderSideBySide: this.gitReviewSideBySide });
    this.gitReviewDiffEditor?.layout();
    this.updateGitReviewDiffNavigation();
  },


  updateGitConflictControls() {
    const controls = this.$("git-review-conflict-controls");
    if (!controls) return;
    const visible = this.gitReviewOpen && this.gitFocusedFile?.scope === "conflict" && !!this.gitConflictReview;
    controls.classList.toggle("hidden", !visible);
    if (!visible) return;
    const conflicts = (this.gitSideState?.files || []).filter((file) => file.conflicted);
    const index = conflicts.findIndex((file) => file.path === this.gitFocusedFile.path);
    this.$("git-review-conflict-position").textContent = conflicts.length
      ? `${Math.max(0, index) + 1}/${conflicts.length} conflicts` : "merge conflict";
    for (const button of this.$("git-review-conflict-sources").querySelectorAll("button[data-source]")) {
      button.classList.toggle("on", button.dataset.source === this.gitConflictSource);
    }
    this.$("git-review-conflict-stage").disabled = this.gitConflictResolutionInProgress;
  },


  selectGitConflictSource(source) {
    if (!this.gitConflictReview || !["base", "ours", "theirs"].includes(source)) return;
    this.gitConflictSource = source;
    this.gitReviewDiffPending = true;
    this.gitConflictReview.originalModel.setValue(String(this.gitConflictReview[source] || ""));
    this.$("git-review-scope").textContent = `${source} → merge result`;
    this.gitReviewDiffIndex = -1;
    this.updateGitConflictControls();
    requestAnimationFrame(() => {
      this.gitReviewDiffEditor?.layout();
      this.updateGitReviewDiffNavigation();
    });
  },


  gitConflictMarkersRemain(content) {
    return /^(<<<<<<<|=======|>>>>>>>)(?: |$)/m.test(String(content || ""));
  },


  async stageGitConflictResultAndOpenNext() {
    const conflict = this.gitConflictReview;
    if (!conflict || this.gitConflictResolutionInProgress) return;
    const content = conflict.modifiedModel.getValue();
    if (this.gitConflictMarkersRemain(content)) {
      await this.showGitMessage("Conflict markers remain", "Resolve every <<<<<<<, =======, and >>>>>>> marker before staging this file.");
      return;
    }
    const previousConflicts = (this.gitSideState?.files || []).filter((file) => file.conflicted);
    const currentIndex = previousConflicts.findIndex((file) => file.path === conflict.path);
    const preferredNextPath = previousConflicts[currentIndex + 1]?.path || previousConflicts[0]?.path || "";
    this.gitConflictResolutionInProgress = true;
    this.updateGitConflictControls();
    try {
      const resolved = await this.gitWorkflowAction("/api/git/conflict",
        { root: conflict.root, path: conflict.path, resolution: "resolved", content });
      if (!resolved) return;
      const remaining = (this.gitSideState?.files || []).filter((file) => file.conflicted);
      const next = remaining.find((file) => file.path === preferredNextPath) || remaining[0];
      if (next) {
        await this.openGitReviewDiff(conflict.root, next.path, "conflict", true, { updateUrl: true });
      } else {
        this.closeGitReview(false);
        await this.showGitMessage("All conflicts staged", "Every conflicted file is resolved and staged. Review the staged changes, then commit to complete the merge.");
      }
    } finally {
      this.gitConflictResolutionInProgress = false;
      this.updateGitConflictControls();
    }
  },


  closeGitReview(restoreFocus = true) {
    if (!this.gitReviewOpen && !this.gitReviewDiffEditor && !this.gitReviewTextEditor) return;
    this.gitReviewGeneration += 1;
    this.gitReviewOpen = false;
    this.gitReviewKey = "";
    this.gitPendingReview = null;
    this.gitReviewDiffIndex = -1;
    this.disposeGitReviewEditor();
    this.updateGitReviewSelectionStyles();
    this.updateGitConflictControls();
    this.renderTopbar();
    this.applyMainLayout();
    if (restoreFocus) {
      this.pushNav({ kind: "files", view: "git" });
      requestAnimationFrame(() => this.focusActiveEditor());
    }
  },


  async openFocusedGitWorkingFile() {
    const focused = this.gitFocusedFile;
    if (!focused || focused.scope === "pull-request") return;
    this.closeGitReview(false);
    await this.openFile(focused.root, focused.path, null, null, { fromFilePanel: true, pinned: true });
  },


  async openFocusedGitFileHistory() {
    const focused = this.gitFocusedFile;
    if (!focused || focused.scope === "pull-request") return;
    await this.openFileHistoryForPath(focused.root, focused.path, "all");
  },


  async openFileHistoryForPath(root, path, mode, options = {}) {
    const key = `${root}|${path}`;
    if (this.fileHistoryTabKey && this.fileHistoryTabKey !== key) this.closeFileHistory(false);
    if (this.activeFileKey !== key || !this.openFiles.has(key)) {
      await this.openFile(root, path, null, null, { fromFilePanel: true, pinned: true,
        history: options.history !== false, view: options.view });
    }
    if (this.activeFileKey !== key || !this.openFiles.has(key)) return;
    this.fileHistoryMode = ["all", "local", "git"].includes(mode) ? mode : "all";
    this.fileHistoryTabKey = key;
    this.fileHistoryLoadedKey = null;
    this.fileHistoryOpen = true;
    this.fileHistorySidebarVisible = true;
    this.fileHistorySelections = Array.isArray(options.selection) ? options.selection.slice(-2) : [];
    const view = FILES_SIDE_PANEL_TABS.includes(options.view) ? options.view : this.lastFilesSidePanelTab;
    const historySideView = FILES_SIDE_PANEL_TABS.includes(view) ? view : "project";
    if (this.sideView !== historySideView) this.setSideView(historySideView, false);
    this.applyMainLayout();
    this.renderFileEditorChrome();
    this.renderTopbar();
    await this.loadFileHistory(!!options.compareWithPreviousVersion);
    if (options.history !== false) this.pushNav(this.fileHistoryNavigationState());
  },


  async gitCommit(root) {
    const values = await this.openGitDialog({
      title: "Commit staged changes",
      description: "Write the commit message for the currently staged files.",
      submitLabel: "Commit",
      fields: [{ name: "message", label: "Commit message", type: "textarea", rows: 6,
                 placeholder: "Describe the change…", required: true }],
    });
    if (!values?.message.trim()) return;
    await this.gitWorkflowAction("/api/git/commit", { root, message: values.message.trim() });
  },


  async gitOpenInteractiveRebase(root) {
    const response = await fetch(`/api/git/rebase/plan?${new URLSearchParams({ root, limit: "12" })}`);
    const plan = await response.json().catch(() => ({}));
    if (!response.ok) {
      await this.showGitMessage("Interactive rebase unavailable", plan.detail || "The recent commit plan could not be loaded.");
      return;
    }
    if (!plan.base || !Array.isArray(plan.commits) || plan.commits.length < 2) {
      await this.showGitMessage("Interactive rebase unavailable", "At least two linear commits after the nearest merge are required.");
      return;
    }
    const entries = await this.openGitRebaseDialog(plan);
    if (!entries) return;
    await this.gitWorkflowAction("/api/git/rebase", { root, base: plan.base, entries });
  },


  openGitRebaseDialog(plan) {
    return new Promise((resolve) => {
      const entries = plan.commits.map((commit) => ({ ...commit, action: "pick" }));
      const backdrop = document.createElement("div");
      backdrop.className = "git-dialog-backdrop";
      const form = document.createElement("form");
      form.className = "git-dialog git-rebase-dialog";
      form.setAttribute("role", "dialog");
      form.setAttribute("aria-modal", "true");
      const heading = document.createElement("div");
      heading.className = "git-dialog-title";
      heading.textContent = "Interactive rebase";
      const detail = document.createElement("div");
      detail.className = "git-dialog-description";
      detail.textContent = "Oldest commit is first. Drag or use the arrows to reorder, then choose pick, squash, fixup, or drop. The working tree must be clean.";
      const list = document.createElement("div");
      list.className = "git-rebase-list";
      let draggedIndex = -1;
      const render = () => {
        list.textContent = "";
        entries.forEach((entry, index) => {
          const row = document.createElement("div");
          row.className = "git-rebase-row";
          row.draggable = true;
          const handle = document.createElement("span");
          handle.className = "codicon codicon-gripper git-rebase-handle";
          const action = document.createElement("select");
          action.setAttribute("aria-label", `Action for ${entry.short_id}`);
          for (const value of ["pick", "squash", "fixup", "drop"]) {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = value;
            option.disabled = index === 0 && ["squash", "fixup"].includes(value);
            action.appendChild(option);
          }
          action.value = index === 0 && ["squash", "fixup"].includes(entry.action) ? "pick" : entry.action;
          entry.action = action.value;
          action.onchange = () => { entry.action = action.value; };
          const id = document.createElement("span");
          id.className = "git-rebase-id";
          id.textContent = entry.short_id;
          const subject = document.createElement("span");
          subject.className = "git-rebase-subject";
          subject.textContent = entry.subject;
          const controls = document.createElement("span");
          controls.className = "git-rebase-move-controls";
          const up = this.gitWorkflowButton("chevron-up", "Move commit earlier", () => {
            if (index === 0) return;
            entries.splice(index - 1, 0, entries.splice(index, 1)[0]);
            render();
          });
          const down = this.gitWorkflowButton("chevron-down", "Move commit later", () => {
            if (index >= entries.length - 1) return;
            entries.splice(index + 1, 0, entries.splice(index, 1)[0]);
            render();
          });
          up.disabled = index === 0;
          down.disabled = index === entries.length - 1;
          controls.append(up, down);
          row.append(handle, action, id, subject, controls);
          row.ondragstart = () => { draggedIndex = index; };
          row.ondragover = (event) => { event.preventDefault(); row.classList.add("drag-over"); };
          row.ondragleave = () => row.classList.remove("drag-over");
          row.ondrop = (event) => {
            event.preventDefault();
            row.classList.remove("drag-over");
            if (draggedIndex < 0 || draggedIndex === index) return;
            entries.splice(index, 0, entries.splice(draggedIndex, 1)[0]);
            draggedIndex = -1;
            render();
          };
          list.appendChild(row);
        });
      };
      const actions = document.createElement("div");
      actions.className = "git-dialog-actions";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "Cancel";
      const submit = document.createElement("button");
      submit.type = "submit";
      submit.className = "primary";
      submit.textContent = "Start rebase";
      actions.append(cancel, submit);
      form.append(heading, detail, list, actions);
      backdrop.appendChild(form);
      const close = (value) => {
        document.removeEventListener("keydown", onKeyDown, true);
        backdrop.remove();
        requestAnimationFrame(() => this.focusActiveEditor());
        resolve(value);
      };
      const onKeyDown = (event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopImmediatePropagation();
        close(null);
      };
      cancel.onclick = () => close(null);
      form.onsubmit = (event) => {
        event.preventDefault();
        close(entries.map((entry) => ({ commit_id: entry.commit_id, action: entry.action })));
      };
      backdrop.onmousedown = (event) => { if (event.target === backdrop) close(null); };
      document.addEventListener("keydown", onKeyDown, true);
      document.body.appendChild(backdrop);
      render();
      requestAnimationFrame(() => list.querySelector("select")?.focus());
    });
  },


  async gitCreateBranch(root) {
    const values = await this.openGitDialog({
      title: "Create branch",
      description: "The new branch starts at the current HEAD and becomes active immediately.",
      submitLabel: "Create and switch",
      fields: [{ name: "name", label: "Branch name", placeholder: "feature/my-change", required: true }],
    });
    if (!values?.name.trim()) return;
    await this.gitWorkflowAction("/api/git/branch", { root, name: values.name.trim(), start_point: "HEAD", switch: true });
  },


  async gitCreateStash(root) {
    const values = await this.openGitDialog({
      title: "Stash working changes",
      description: "Review the message and untracked-file choice. Nothing changes until you press Create stash.",
      submitLabel: "Create stash",
      fields: [
        { name: "message", label: "Stash message", type: "textarea", rows: 3, value: "TermDeck stash" },
        { name: "include_untracked", label: "Include untracked files", type: "checkbox", checked: true },
      ],
    });
    if (!values) return;
    await this.gitWorkflowAction("/api/git/stash", { root, message: values.message.trim(),
                                                     include_untracked: values.include_untracked });
  },


  async gitStashAction(root, reference, action) {
    const labels = {
      apply: ["Apply stash", `Apply ${reference} while keeping it in the stash list?`, "Apply stash", false],
      pop: ["Pop stash", `Apply ${reference} and remove it from the stash list if Git succeeds?`, "Pop stash", false],
      drop: ["Delete stash", `Permanently delete ${reference}? This cannot be restored by TermDeck.`, "Delete stash", true],
    };
    const confirmation = labels[action];
    if (!confirmation || !await this.confirmGitAction(...confirmation)) return;
    await this.gitWorkflowAction("/api/git/stash/action", { root, reference, action });
  },


  async gitResolveConflict(root, path, resolution) {
    if (resolution !== "resolved" &&
        !await this.confirmGitAction(`Accept ${resolution}`, `Replace ${path} with the ${resolution} version and stage it.`,
                                     `Accept ${resolution}`, true)) return;
    await this.gitWorkflowAction("/api/git/conflict", { root, path, resolution });
  },


  async gitCreateWorktree(root, currentBranch) {
    const suggestedBranch = `${currentBranch || "work"}-agent`;
    const values = await this.openGitDialog({
      title: "Create worktree",
      description: "Create and register an isolated project worktree for an agent or parallel task.",
      submitLabel: "Create worktree",
      fields: [
        { name: "branch", label: "New branch", value: suggestedBranch, required: true },
        { name: "path", label: "Worktree folder",
          value: `${root.replace(/\/$/, "")}-${suggestedBranch.replaceAll("/", "-")}`, required: true },
      ],
    });
    if (!values?.branch.trim() || !values.path.trim()) return;
    await this.gitWorkflowAction("/api/git/worktree", { root, action: "create", path: values.path.trim(),
                                                       branch: values.branch.trim(),
                                                       create_branch: true, start_point: "HEAD" });
  },


  async gitRemoveWorktree(root, path) {
    if (!await this.confirmGitAction("Remove worktree", path, "Remove worktree", true)) return;
    await this.gitWorkflowAction("/api/git/worktree", { root, action: "remove", path });
  },


  async gitPruneWorktrees(root) {
    await this.gitWorkflowAction("/api/git/worktree", { root, action: "prune" });
  },


  async gitAddRemote(root) {
    const values = await this.openGitDialog({
      title: "Add Git remote",
      submitLabel: "Add remote",
      fields: [
        { name: "name", label: "Remote name", value: "origin", required: true },
        { name: "url", label: "SSH or HTTPS URL", value: "git@github.com:", required: true },
      ],
    });
    if (!values?.name.trim() || !values.url.trim()) return;
    await this.gitWorkflowAction("/api/git/remote", { root, action: "add", name: values.name.trim(),
                                                     url: values.url.trim() });
  },


  async gitRemoteAction(root, name, action, branch) {
    if (action === "remove" &&
        !await this.confirmGitAction("Remove Git remote", name, "Remove remote", true)) return;
    if (["pull", "push"].includes(action)) {
      const fetchResponse = await fetch("/api/git/remote", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root, action: "fetch", name, branch }) });
      if (!fetchResponse.ok) {
        const error = await fetchResponse.json().catch(() => ({}));
        await this.showGitMessage("Remote preview unavailable", error.detail || `Could not fetch ${name}.`);
        return;
      }
      const response = await fetch(`/api/git/divergence?${new URLSearchParams({ root, remote: name, branch })}`);
      const divergence = await response.json().catch(() => ({}));
      if (!response.ok) {
        await this.showGitMessage("Commit preview unavailable", divergence.detail || "Fetch the remote before previewing incoming and outgoing commits.");
        return;
      }
      const incoming = divergence.incoming || [];
      const outgoing = divergence.outgoing || [];
      const relevant = action === "pull" ? incoming : outgoing;
      const direction = action === "pull" ? `${name}/${branch} → ${branch}` : `${branch} → ${name}/${branch}`;
      const lines = relevant.slice(0, 10).map((commit) => `${commit.short_id}  ${commit.subject}`);
      const extra = relevant.length > lines.length ? `\n…and ${relevant.length - lines.length} more` : "";
      const crossWarning = action === "pull" && outgoing.length
        ? `\n\n${outgoing.length} outgoing commit${outgoing.length === 1 ? "" : "s"}; fast-forward pull may be refused.`
        : action === "push" && incoming.length
        ? `\n\n${incoming.length} incoming commit${incoming.length === 1 ? "" : "s"}; a non-fast-forward push will be refused.` : "";
      const description = `${direction}\n${relevant.length} ${action === "pull" ? "incoming" : "outgoing"} commit${relevant.length === 1 ? "" : "s"}` +
        `${lines.length ? `\n\n${lines.join("\n")}${extra}` : "\n\nNothing to transfer."}${crossWarning}`;
      if (!await this.confirmGitAction(`${action === "pull" ? "Pull" : "Push"} preview`, description,
                                       action === "pull" ? "Pull" : "Push")) return;
    }
    await this.gitWorkflowAction("/api/git/remote", { root, action, name, branch,
                                                     set_upstream: action === "push" });
  },


  async gitCloneProject(root) {
    const parent = String(root || "~/workspace/project").replace(/\/+$/, "").replace(/\/[^/]+$/, "");
    const values = await this.openGitDialog({
      title: "Clone remote project",
      description: "SSH uses your existing Git and SSH configuration. Leave branch blank for the remote default.",
      submitLabel: "Clone project",
      fields: [
        { name: "url", label: "SSH or HTTPS URL", value: "git@github.com:", required: true },
        { name: "path", label: "Local project folder", value: `${parent}/project`, required: true },
        { name: "branch", label: "Branch", placeholder: "Remote default" },
      ],
    });
    if (!values?.url.trim() || !values.path.trim()) return;
    const response = await fetch("/api/git/clone", { method: "POST", headers: { "Content-Type": "application/json" },
                                                     body: JSON.stringify({ url: values.url.trim(), path: values.path.trim(),
                                                                            branch: values.branch.trim() }) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      await this.showGitMessage("Git clone failed", payload.detail || "The remote project could not be cloned.");
      return;
    }
    await this.loadProjects();
    if (payload.project?.name &&
        await this.confirmGitAction("Clone complete", `Open ${payload.project.name} now?`, "Open project")) {
      location.href = `/p/${encodeURIComponent(payload.project.name)}`;
    } else {
      await this.loadGitSidePanel();
    }
  },


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
  },


  gitDateLabel(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value || "") : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  },


  openGitHistoryForActiveFile() {
    if (this.activeFileKey === null) {
      this.$("status-name").textContent = "Open a file to inspect its Git history";
      return;
    }
    const entry = this.openFiles.get(this.activeFileKey);
    if (entry) void this.openFileHistoryForPath(entry.root, entry.path, "git");
  },


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
  },


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
  },


  terminalSurfaceAvailableForFit(view) {
    return !!view && !view.closed && !this.terminalLayoutTransitioning && !this.sidebarResizeInProgress &&
      this.activeId === view.sessionId && this.activeFileKey === null && !this.historyOpen &&
      !this.$("terminal-area").classList.contains("hidden") && view.container.classList.contains("visible") &&
      this.terminalPageCanResize();
  },


  beginTerminalLayoutTransition(view) {
    const generation = ++this.terminalLayoutTransitionGeneration;
    this.terminalLayoutTransitioning = true;
    if (view) {
      if (view.v2FitFrame) cancelAnimationFrame(view.v2FitFrame);
      view.v2FitFrame = 0;
      if (view.v2InitialFitFrame) cancelAnimationFrame(view.v2InitialFitFrame);
      view.v2InitialFitFrame = 0;
      clearTimeout(view.layoutFitRetryTimer);
      view.layoutFitRetryTimer = 0;
      view.layoutFitRetryCount = 0;
      this.clearActiveTerminalSettleWatchdog(view);
    }
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (generation !== this.terminalLayoutTransitionGeneration) return;
      this.terminalLayoutTransitioning = false;
      this.fitActive();
    }));
  },


  cycleView(view) {
    if (this.vscodeMode && view !== "terminals") return;
    this.setSideView(view);
    if (this.sideView !== view) return;
    if (view === "project") this.focusFileNameSearch();
    else if (view === "search") this.focusFileContentSearch();
  },


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
  },


  openFilesSidePanelView(view) {
    if (this.vscodeMode || !FILES_SIDE_PANEL_TABS.includes(view)) return;
    if (this.sideView === view) {
      this.setSideView(this.activeFileKey !== null ? CLOSED_SIDE_VIEW : "terminals", false);
      requestAnimationFrame(() => this.focusActiveEditor());
      return;
    }
    this.setSideView(view, false);
    if (view === "project") this.focusFileNameSearch();
    else if (view === "search") this.focusFileContentSearch();
  },


  // How wide the sidebar becomes while the files/search/git panel is open: the width the user
  // dragged, or half again the terminal list's width when they have not chosen one. Capped so
  // the panel can never crowd out the workspace it sits beside.
  filesPanelWidth() {
    const normalWidth = Number(this.settings.sidebar_width) || SETTINGS_DEFAULTS.sidebar_width;
    const chosenWidth = Number(this.settings.files_panel_width) || Math.round(normalWidth * FILES_PANEL_WIDTH_RATIO);
    return Math.min(Math.max(chosenWidth, FILES_PANEL_MIN_WIDTH),
      Math.max(normalWidth, Math.floor(window.innerWidth * 0.75)));
  },


  applySideLayout() {
    const sectionId = FILES_SIDE_PANEL_TABS.includes(this.sideView) ? "files-section" : null;
    const full = !!this.settings.side_full && !!sectionId;
    this.$("session-list").classList.toggle("collapsed", full);
    if (!sectionId) return;
    const section = this.$(sectionId);
    if (full) {
      section.style.height = "";
      section.style.flex = "1";
    } else {
      section.style.flex = "";
      section.style.height = Math.round((this.settings.side_split ?? 0.55) * 100) + "%";
    }
  },


  toggleSideFull() {
    this.settings.side_full = !this.settings.side_full;
    this.applySideLayout();
    this.saveSettings();
  },


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
  },


  isExcludedName(name) {
    return ALWAYS_EXCLUDED.includes(name) || (this.settings.ignored_dirs || []).includes(name);
  },


  isDotFolderName(name) {
    return String(name || "").startsWith(".");
  },


  searchIgnoreTokens() {
    const tokens = [...ALWAYS_EXCLUDED, ...(this.settings.ignored_dirs || [])];
    if (this.settings.hide_dot_folders) tokens.push(".*");
    return [...new Set(tokens)].join(",");
  },


  includeHiddenFilesInSearch() {
    return this.settings.hide_dot_folders === false;
  },


  isExcludedPath(relPath) {
    return String(relPath || "").split("/").filter(Boolean).some((part) => this.isExcludedName(part));
  },


  updateTreeSortButton() {
    const button = this.$("tree-sort-toggle");
    if (!button) return;
    const recent = this.settings.file_tree_sort === "mtime";
    button.classList.toggle("on", recent);
    button.title = recent ? "Sort files alphabetically (folders first)" : "Sort files by recently modified";
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-pressed", String(recent));
  },


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
  },


  toggleHideDotFolders() {
    const nextHidden = !this.settings.hide_dot_folders;
    const tokens = this.fileTypeFilterTokens().filter((token) => token !== "!.*");
    if (nextHidden) tokens.unshift("!.*");
    this.updateFileTypeFilterTokens(tokens);
  },


  toggleExcludeDir(name) {
    const list = this.settings.ignored_dirs || [];
    this.settings.ignored_dirs = list.includes(name) ? list.filter((n) => n !== name) : [...list, name];
    this.saveSettings();
    this.rerenderTree();
  },


  rerenderTree() {
    const root = this.treeDirs.get("");
    if (root) this.renderDirInto(root.container, "", JSON.parse(root.cache));
  },


  captureTreeScrollPosition() {
    const tree = this.$("files-tree");
    const treeRect = tree.getBoundingClientRect();
    const anchor = [...tree.querySelectorAll(".tree-row")].find((row) => row.getBoundingClientRect().bottom > treeRect.top);
    return {
      top: tree.scrollTop,
      anchorRel: anchor?.dataset.rel || "",
      anchorOffset: anchor ? anchor.getBoundingClientRect().top - treeRect.top : 0,
    };
  },


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
  },


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
  },


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
  },


  positionContextMenu(menu, x, y) {
    menu.classList.remove("hidden");
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 10)) + "px";
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 10)) + "px";
  },


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
  },


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
  },


  shortcutLabel(label, actionId) {
    const binding = this.bindingFor(actionId);
    return binding ? `${label}   ${this.bindingToDisplay(binding)}` : label;
  },


  shortcutTitle(label, actionId) {
    const binding = this.bindingToDisplay(this.bindingFor(actionId));
    return binding ? `${label} (${binding})` : label;
  },


  keybindingDefinitions() {
    return this.vscodeMode ? VSCODE_KEYBINDINGS : DESKTOP_KEYBINDINGS;
  },


  keybindingsStorageKey() {
    return this.vscodeMode ? "vscode_keybindings" : "keybindings";
  },


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
      ["view-search", "Search & replace", "open-file-search"], ["view-git", "Git", "open-git-panel"],
      ["terminal-search-inline-toggle", "Search terminal names and output", "open-terminal-search"]];
    for (const [id, label, actionId] of sidePanelTitles) {
      const button = this.$(id);
      const directAction = this.bindingToDisplay(this.bindingFor(actionId));
      if (button) button.title = `${label} (${directAction}; ${sidePanelAction} cycles tabs)`;
    }
    for (const id of ["view-project", "view-search", "view-git"]) {
      const button = this.$(id);
      if (button) button.title = `${button.title} · middle/right-click opens file mode in a new tab`;
    }
    const notebookTitle = `Quick notebook (${this.bindingToDisplay(this.bindingFor("toggle-notebook"))})`;
    for (const button of [this.$("notebook-toggle"), this.$("file-tabs-notebook"), this.$("mobile-notebook-toggle")]) {
      if (button) button.title = notebookTitle;
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
        // Keep the size-ownership explanation if it is showing: this pass runs on every shortcut refresh
        // and would otherwise replace the only text that says why the button is marked.
        const owned = this.views.get(this.activeId)?.sizeOwnedElsewhere;
        resyncButton.title = owned
          ? `Another window is using this terminal at ${owned.cols} columns. Click to resize it to this window. (${resyncAction})`
          : `Resync terminal content (${resyncAction})`;
        resyncButton.setAttribute("aria-label", resyncButton.title);
      }
    }
    const conversationOutlineButton = this.$("conversation-outline-toggle");
    if (conversationOutlineButton) {
      const outlineLabel = this.activeFileKey !== null ? "File outline" : "Conversation outline";
      conversationOutlineButton.title = this.shortcutTitle(outlineLabel, "conversation-outline");
      conversationOutlineButton.setAttribute("aria-label", outlineLabel);
    }
    const fileHistoryNavigationButtons = [
      ["file-history-diff-previous", "Previous change", "file-history-previous-change"],
      ["file-history-diff-next", "Next change", "file-history-next-change"],
    ];
    for (const [id, label, actionId] of fileHistoryNavigationButtons) {
      const button = this.$(id);
      if (button) button.title = this.shortcutTitle(label, actionId);
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
  },


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
      const permissions = this.agentPermissions(session.agent_kind);
      if (permissions.length > 1) {
        this.addContextSubmenu(menu, "Restart with permission", permissions.map((entry) => ({
          label: entry.label,
          handler: () => this.restartSession(session.session_id, entry.value),
          icon: "refresh",
        })), "refresh");
      }
      this.addContextItem(menu, "Stop", session.running ? () => this.stopSession(session.session_id) : null, "debug-stop");
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
  },


  async openWorktreeReview(sessionId) {
    this.worktreeReviewSessionId = sessionId;
    this.$("worktree-review-backdrop").classList.remove("hidden");
    await this.refreshWorktreeReview();
  },


  closeWorktreeReview() {
    this.worktreeReviewSessionId = null;
    this.$("worktree-review-backdrop").classList.add("hidden");
  },


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
  },


  async finishWorktree(action) {
    const sessionId = this.worktreeReviewSessionId;
    if (!sessionId) return;
    if (action === "discard" && !await uiConfirm("Discard the worktree and its branch? Uncommitted changes will be lost.")) return;
    if (action === "merge" && !await uiConfirm("Merge the worktree branch into its base branch?")) return;
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
  },


  openFileContextMenu(event, key) {
    event.preventDefault();
    event.stopPropagation();
    const keys = this.selectContextMenuFileKeys(key);
    const menu = this.$("context-menu");
    menu.textContent = "";
    this.contextMenuTarget = { type: "files", keys };
    if (keys.length === 1) {
      const entry = this.openFiles.get(keys[0]);
      if (entry) {
        this.addContextItem(menu, "Open this file in a new browser tab", () => this.openFileDeckInNewTab(entry.root, entry.path), "new-window");
        this.addOpenFileExternallyContextItem(menu, entry.root, entry.path);
        this.addGitPathContextActions(menu, entry.root, entry.path, false);
        this.addFileHistoryContextSubmenu(menu, entry.root, entry.path);
      }
    }
    const label = keys.length === 1 ? "Close file" : `Close ${keys.length} selected files`;
    this.addContextItem(menu, this.shortcutLabel(label, "close-item"), () => this.closeFiles(keys), "close-all");
    this.positionContextMenu(menu, event.clientX, event.clientY);
  },


  openFileDeckRowContextMenu(event, root, relativePath) {
    event.preventDefault();
    event.stopPropagation();
    const menu = this.$("context-menu");
    menu.textContent = "";
    this.contextMenuTarget = { type: "filedeck", root, path: relativePath };
    this.addContextItem(menu, "Open this file in a new browser tab", () => this.openFileDeckInNewTab(root, relativePath), "new-window");
    this.addOpenFileExternallyContextItem(menu, root, relativePath);
    this.addGitPathContextActions(menu, root, relativePath, false);
    this.addFileHistoryContextSubmenu(menu, root, relativePath);
    this.positionContextMenu(menu, event.clientX, event.clientY);
  },


  addFileHistoryContextSubmenu(menu, root, path) {
    this.addContextSubmenu(menu, "File history", [
      { label: "All history", handler: () => this.openFileHistoryForPath(root, path, "all"), icon: "history" },
      { label: "Local history only", handler: () => this.openFileHistoryForPath(root, path, "local"), icon: "history" },
      { label: "Git history only", handler: () => this.openFileHistoryForPath(root, path, "git"), icon: "git-commit" },
    ], "history");
  },


  addGitPathContextActions(menu, root, path, directory) {
    this.addContextItem(menu, `Show Git log for this ${directory ? "folder" : "file"}`,
      () => this.openGitHistoryForPath(root, path), "git-commit");
    if (!directory) {
      this.addContextItem(menu, "Annotate (Git Blame)", () => void this.openFileBlame(root, path), "account");
    }
    const name = path.split("/").filter(Boolean).pop() || path;
    this.addContextSubmenu(menu, "Git ignore", [
      { label: `Ignore this ${directory ? "folder" : "file"}`, handler: () => this.gitUpdateIgnore(root, path, "exact", directory),
        icon: "exclude" },
      { label: `Ignore every “${name}”`, handler: () => this.gitUpdateIgnore(root, path, "name", directory), icon: "exclude" },
      { label: `Unignore this ${directory ? "folder" : "file"}`, handler: () => this.gitUpdateIgnore(root, path, "unignore", directory),
        icon: "add" },
    ], "exclude");
  },


  async gitUpdateIgnore(root, path, mode, directory) {
    const succeeded = await this.gitWorkflowAction("/api/git/ignore", { root, path, mode, directory });
    if (!succeeded) return;
    if (this.treeRoot === root) await this.refreshTreeDirectories();
    void this.refreshOpenFileGitStatuses(root, true);
  },


  openFileTabContextMenu(event, key) {
    event.preventDefault();
    event.stopPropagation();
    const entry = this.openFiles.get(key);
    if (!entry) return;
    const menu = this.$("context-menu");
    menu.textContent = "";
    this.contextMenuTarget = { type: "file-tab", key };
    this.addContextItem(menu, "Open this file in a new browser tab", () => this.openFileDeckInNewTab(entry.root, entry.path), "new-window");
    this.addOpenFileExternallyContextItem(menu, entry.root, entry.path);
    this.addGitPathContextActions(menu, entry.root, entry.path, false);
    this.addFileHistoryContextSubmenu(menu, entry.root, entry.path);
    this.addContextItem(menu, "Close file", () => this.closeFile(key), "close");
    this.positionContextMenu(menu, event.clientX, event.clientY);
  },


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
  },


  openTreeContextMenu(event, row) {
    event.preventDefault();
    event.stopPropagation();
    const rel = row.dataset.rel;
    const isDir = row.dataset.kind === "dir";
    const name = rel.split("/").pop();
    const menu = this.$("context-menu");
    menu.textContent = "";
    if (isDir) {
      this.addOpenFolderExternallyContextItem(menu, this.treeRoot, rel);
      if (ALWAYS_EXCLUDED.includes(name)) {
        this.addContextItem(menu, `"${name}" is always excluded from search`, null);
      } else {
        const excluded = (this.settings.ignored_dirs || []).includes(name);
        this.addContextItem(menu, excluded ? "Include in search" : "Exclude from search",
          () => this.toggleExcludeDir(name));
      }
      this.addGitPathContextActions(menu, this.treeRoot, rel, true);
    } else {
      this.addContextItem(menu, "Open this file in a new browser tab", () => this.openFileDeckInNewTab(this.treeRoot, rel), "new-window");
      this.addContextItem(menu, "Open", () => this.openFile(this.treeRoot, rel, null, row));
      this.addOpenFileExternallyContextItem(menu, this.treeRoot, rel);
      this.addGitPathContextActions(menu, this.treeRoot, rel, false);
      this.addFileHistoryContextSubmenu(menu, this.treeRoot, rel);
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
  },


  async fsOp(route, payload, failLabel) {
    const res = await fetch(route, { method: "POST", headers: { "Content-Type": "application/json" },
                                     body: JSON.stringify({ root: this.treeRoot, ...payload }) });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      void uiAlert(err.detail || failLabel);
      return null;
    }
    return await res.json();
  },


  async renameTreePath(rel) {
    const base = rel.split("/").pop();
    const newName = await uiPrompt(`Rename "${base}" to`, base);
    if (!newName || newName === base) return;
    if (!await this.saveOpenFileBeforePathChange(rel)) return;
    const result = await this.fsOp("/api/files/rename", { path: rel, new_name: newName }, "rename failed");
    if (result === null) return;
    const parent = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    this.afterFsChange(rel, parent ? `${parent}/${result.new_name}` : result.new_name);
  },


  async createTreePath(parent, directory) {
    const suggested = parent ? `${parent}/` : "";
    const path = await uiPrompt(`${directory ? "Folder" : "File"} path relative to ${this.treeRoot}`, suggested);
    if (!path || path === suggested) return;
    const result = await this.fsOp("/api/files/create", { path, directory }, "create failed");
    if (result === null) return;
    this.selectedTreeRow = null;
    await this.refreshTreeDirectories();
    if (!result.directory) void this.openFile(this.treeRoot, result.rel, null, null, { pinned: true });
  },


  async duplicateTreePath(rel) {
    const dot = rel.lastIndexOf(".");
    const slash = rel.lastIndexOf("/");
    const suggested = dot > slash ? `${rel.slice(0, dot)} copy${rel.slice(dot)}` : `${rel} copy`;
    const destination = await uiPrompt(`Duplicate "${rel}" to`, suggested);
    if (!destination || destination === rel) return;
    const result = await this.fsOp("/api/files/duplicate", { path: rel, destination }, "duplicate failed");
    if (result === null) return;
    this.selectedTreeRow = null;
    await this.refreshTreeDirectories();
  },


  async moveTreePath(rel) {
    const destination = await uiPrompt(`Move "${rel}" to (path relative to ${this.treeRoot}; existing folder = move into it)`, rel);
    if (!destination || destination === rel) return;
    if (!await this.saveOpenFileBeforePathChange(rel)) return;
    const result = await this.fsOp("/api/files/move", { path: rel, destination }, "move failed");
    if (result === null) return;
    this.afterFsChange(rel, result.rel);
  },


  async saveOpenFileBeforePathChange(rel) {
    const entry = this.openFiles.get(`${this.treeRoot}|${rel}`);
    if (!entry || (!entry.dirty && !entry.savePromise)) return true;
    return await this.saveFileEntry(entry, true);
  },


  async deleteTreePath(rel) {
    if (!await uiConfirm(`Move "${rel}" to Trash?`)) return;
    const result = await this.fsOp("/api/files/delete", { path: rel }, "delete failed");
    if (result === null) return;
    this.afterFsChange(rel, null);
  },


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
        if (this.fileHistoryTabKey === key) {
          this.fileHistoryTabKey = newKey;
          this.fileHistoryLoadedKey = null;
        }
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
  },


  async revealActiveFile(options = {}) {
    const entry = this.activeFileKey !== null ? this.openFiles.get(this.activeFileKey) : null;
    if (!entry) return;
    if (this.sideView !== "project") {
      if (options.switchToProject === false) return;
      this.sideView = "terminals";
      this.setSideView("project");
    }
    if (options.switchExplorerMode === false) {
      if (this.$("files-tree").classList.contains("hidden")) return;
    } else {
      this.setExplorerMode("tree");
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
  },


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
  },


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
  },


  async openRecentlyModifiedFile(root, path) {
    await this.openFileHistoryForPath(root, path, "all", { compareWithPreviousVersion: true });
  },


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
  },


  renderClosedInto(list, closedSessions = this.closedSessions, worktreeId = this.worktreeId || "root") {
    if (!closedSessions.length) return;
    const search = this.terminalSearchText.trim();
    const matchingClosed = search
      ? closedSessions.filter((session) => this.terminalSearchClosedMatches.has(session.session_id))
      : closedSessions;
    if (search && !matchingClosed.length) return;
    const header = document.createElement("div");
    header.className = "side-section-label side-section-header collapsible-section-header closed-header";
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
        void this.reopenClosed(c.session_id).then((reopened) => {
          if (reopened) this.collapseMobileSidebarAfterSelection();
        });
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
  },


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
  },


  async restoreLastClosedTerminal() {
    if (this.restoreLastClosedTerminalBusy) return;
    const lastClosed = this.closedSessions[0];
    if (!lastClosed) {
      this.$("status-name").textContent = "no recently closed terminal";
      return;
    }
    if (this.restoreLastClosedTerminalNeedsConfirmation &&
        !await uiConfirm("You already restored the last closed terminal. Restore another older terminal?")) return;
    this.restoreLastClosedTerminalBusy = true;
    try {
      if (await this.reopenClosed(lastClosed.session_id)) this.restoreLastClosedTerminalNeedsConfirmation = true;
    } finally {
      this.restoreLastClosedTerminalBusy = false;
    }
  },
});
