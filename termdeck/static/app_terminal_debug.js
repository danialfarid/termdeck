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
    panel.setAttribute("aria-label", "Terminal debug view");
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
    // Tapping the terminal raises the keyboard into it, as on the desktop.
    screen.onclick = () => preview.term?.focus();
    const keys = this.terminalKeyPad(() => preview.term, (data) => this.sendTerminalDebugInput(preview, data));
    panel.append(header, viewport, keys);
    // In place of the transcript and its composer: the terminal itself takes the typing.
    this.$("history-body").before(panel);
    this.$("history-area").classList.add("terminal-debug-open");
    const preview = { sessionId: this.activeId, panel, viewport, screen, label, term: null, ws: null,
      follow: true, closed: false, timeout: 0, escape: null };
    this.terminalDebugPreview = preview;
    this.$("terminal-debug-toggle").setAttribute("aria-pressed", "true");
    preview.escape = (event) => {
      if (event.key !== "Escape" || panel.contains(event.target)) return;
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
        // A read-only remote viewer: the server drops what is typed, so the terminal takes none.
        if (message.type === "access_mode" && message.read_only && preview.term) {
          preview.readOnly = true;
          preview.term.options.disableStdin = true;
          keys.remove();
          preview.label.textContent = preview.label.textContent.replace("Live", "Read only");
          return;
        }
        if (message.type !== "debug_geometry" || preview.term) return;
        clearTimeout(preview.timeout);
        preview.term = new Terminal({ cols: message.cols, rows: message.rows, scrollback: 0,
          cursorBlink: false, fontSize: this.scaledSettingSize("terminal_font_size"),
          fontFamily: '"SF Mono", Menlo, monospace', theme: this.terminalDisplayTheme() });
        preview.term.open(screen);
        // Typing only: the terminal's own query replies are the main view's to give, and doubled they confuse the agent.
        preview.term.onData((data) => {
          const typed = data.replace(TERMINAL_REPLY_RE, "");
          if (typed) this.sendTerminalDebugInput(preview, this.withTerminalKeyModifiers(keys, typed));
        });
        screen.style.width = `${preview.term.element.querySelector(".xterm-screen").getBoundingClientRect().width}px`;
        preview.label.textContent = `Live · ${message.cols} × ${message.rows}${message.running ? "" : " · saved output"}`;
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

  // The keys a phone keyboard lacks. Pressing them must not take focus, so the keyboard stays up.
  terminalKeyPad(term, send) {
    const keys = document.createElement("div");
    keys.className = "terminal-debug-keys";
    // Push buttons, xterm's modifier bits: held until tapped again, so Cmd+← can be pressed repeatedly.
    for (const [name, glyph, bit] of [["Shift", "⇧", 1], ["Option", "⌥", 2], ["Control", "⌃", 4], ["Command", "⌘", 8]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.title = name;
      button.textContent = glyph;
      button.dataset.modifier = bit;
      button.setAttribute("aria-pressed", "false");
      button.onpointerdown = (event) => event.preventDefault();
      button.onclick = () => button.setAttribute("aria-pressed", String(button.getAttribute("aria-pressed") !== "true"));
      keys.append(button);
    }
    for (const [name, icon, final] of [["Left", "arrow-left", "D"], ["Up", "arrow-up", "A"],
      ["Down", "arrow-down", "B"], ["Right", "arrow-right", "C"], ["Esc", "close", ""]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.title = `Send ${name}`;
      button.setAttribute("aria-label", button.title);
      button.innerHTML = `<span class="codicon codicon-${icon}"></span>`;
      button.onpointerdown = (event) => event.preventDefault();
      button.onclick = () => {
        const bits = this.terminalKeyModifiers(keys);
        let data;
        if (!final) data = bits & 2 ? "\x1b\x1b" : "\x1b";
        else if (bits) data = `\x1b[1;${1 + bits}${final}`;
        else data = `\x1b${term()?.modes.applicationCursorKeysMode ? "O" : "["}${final}`;
        send(data);
      };
      keys.append(button);
    }
    return keys;
  },

  terminalKeyModifiers(keys) {
    let bits = 0;
    for (const button of keys.querySelectorAll('[aria-pressed="true"]')) bits |= Number(button.dataset.modifier);
    return bits;
  },

  // Held Control or Option applies to a typed key too.
  withTerminalKeyModifiers(keys, typed) {
    const bits = keys && typed.length === 1 ? this.terminalKeyModifiers(keys) : 0;
    if (bits & 4 && /[a-z@[\\\]^_]/i.test(typed)) typed = String.fromCharCode(typed.toUpperCase().charCodeAt(0) & 31);
    if (bits & 2) typed = `\x1b${typed}`;
    return typed;
  },

  sendTerminalDebugInput(preview, data) {
    if (!preview.readOnly && preview.ws?.readyState === WebSocket.OPEN) {
      preview.ws.send(JSON.stringify({ type: "input", data }));
    }
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
    this.$("history-area").classList.remove("terminal-debug-open");
    this.$("terminal-debug-toggle")?.setAttribute("aria-pressed", "false");
    if (restoreFocus && this.historyOpen && this.activeId === preview.sessionId) this.$("history-prompt")?.focus();
  },
});
