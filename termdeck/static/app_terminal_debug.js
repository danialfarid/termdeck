Object.assign(TermdeckApp.prototype, {
  terminalDebugPreviewEligible() {
    return this.touchMobileLayoutEnabled() && window.matchMedia("(pointer: coarse)").matches &&
      this.historyOpen && this.activeFileKey === null && !(this.gitReviewOpen && this.sideView === "git") &&
      !!this.session(this.activeId);
  },

  updateTerminalDebugPreview() {
    const eligible = this.terminalDebugPreviewEligible();
    if (this.terminalDebugPreview && (!eligible || this.terminalDebugPreview.sessionId !== this.activeId)) {
      this.closeTerminalDebugPreview(false);
    }
    this.$("terminal-debug-toggle")?.classList.toggle("hidden", !eligible);
  },

  toggleTerminalDebugPreview() {
    if (this.terminalDebugPreview) {
      this.closeTerminalDebugPreview();
      return;
    }
    if (!this.terminalDebugPreviewEligible()) return;
    const panel = document.createElement("section");
    panel.className = "terminal-debug-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Read-only terminal debug preview");
    panel.style.bottom = `${this.$("bottombar").getBoundingClientRect().height}px`;
    const header = document.createElement("div");
    header.className = "terminal-debug-header";
    const label = document.createElement("span");
    label.textContent = "Loading terminal preview…";
    const close = document.createElement("button");
    close.type = "button";
    close.title = "Close debug preview";
    close.setAttribute("aria-label", close.title);
    close.innerHTML = '<span class="codicon codicon-close"></span>';
    close.onclick = () => this.closeTerminalDebugPreview();
    header.append(label, close);
    const viewport = document.createElement("div");
    viewport.className = "terminal-debug-viewport";
    const screen = document.createElement("div");
    screen.className = "terminal-debug-screen";
    viewport.append(screen);
    panel.append(header, viewport);
    this.$("main").append(panel);
    const preview = { sessionId: this.activeId, panel, viewport, screen, label, term: null, ws: null,
      follow: true, closed: false, timeout: 0, escape: null };
    this.terminalDebugPreview = preview;
    this.$("terminal-debug-toggle").setAttribute("aria-pressed", "true");
    preview.escape = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.closeTerminalDebugPreview();
    };
    window.addEventListener("keydown", preview.escape, true);
    viewport.onscroll = () => {
      preview.follow = viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 12;
    };
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws/${encodeURIComponent(preview.sessionId)}/debug`);
    ws.binaryType = "arraybuffer";
    preview.ws = ws;
    preview.timeout = window.setTimeout(() => {
      if (preview.closed || preview.term) return;
      preview.label.textContent = "Preview connection timed out · close and retry";
      ws.close();
    }, 15000);
    ws.onmessage = (event) => {
      if (preview.closed) return;
      if (typeof event.data === "string") {
        const message = JSON.parse(event.data);
        if (message.type !== "debug_geometry" || preview.term) return;
        clearTimeout(preview.timeout);
        preview.term = new Terminal({ cols: message.cols, rows: message.rows, scrollback: 0,
          disableStdin: true, cursorBlink: false,
          fontSize: this.scaledSettingSize("terminal_font_size"),
          fontFamily: '"SF Mono", Menlo, monospace', theme: this.terminalDisplayTheme() });
        preview.term.open(screen);
        screen.style.width = `${preview.term.element.querySelector(".xterm-screen").getBoundingClientRect().width}px`;
        screen.querySelector("textarea")?.setAttribute("tabindex", "-1");
        screen.querySelector("textarea")?.setAttribute("inputmode", "none");
        screen.querySelector("textarea")?.setAttribute("readonly", "");
        preview.label.textContent = `Read only · ${message.cols} × ${message.rows}${message.running ? "" : " · saved output"}`;
        return;
      }
      if (!preview.term) return;
      preview.term.write(new Uint8Array(event.data), () => {
        if (!preview.closed && preview.follow) viewport.scrollTop = viewport.scrollHeight;
      });
    };
    ws.onerror = () => {
      if (!preview.closed) preview.label.textContent = "Preview unavailable · close and retry";
    };
    ws.onclose = () => {
      clearTimeout(preview.timeout);
      if (!preview.closed && preview.term) preview.label.textContent += " · disconnected";
      else if (!preview.closed) preview.label.textContent = "Preview unavailable · close and retry";
    };
  },

  closeTerminalDebugPreview(restoreFocus = true) {
    const preview = this.terminalDebugPreview;
    if (!preview) return;
    this.terminalDebugPreview = null;
    preview.closed = true;
    clearTimeout(preview.timeout);
    window.removeEventListener("keydown", preview.escape, true);
    preview.viewport.onscroll = null;
    preview.ws.onmessage = null;
    preview.ws.onerror = null;
    preview.ws.onclose = null;
    preview.ws.close();
    preview.term?.dispose();
    preview.term = null;
    preview.ws = null;
    preview.panel.remove();
    this.$("terminal-debug-toggle")?.setAttribute("aria-pressed", "false");
    if (restoreFocus && this.historyOpen && this.activeId === preview.sessionId) this.$("history-prompt")?.focus();
  },
});
