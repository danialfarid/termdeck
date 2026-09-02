// Split from app.js (2026-08-26): settings, Monaco, fonts, themes, create modal, shortcut sections.
// Same class, split across files: this attaches methods to TermdeckApp.prototype, and
// index.html loads the app_*.js files after app.js and before app_boot.js.
Object.assign(TermdeckApp.prototype, {


  applySettings({ fitTerminals = true } = {}) {
    const s = this.settings;
    const sidebarFontSize = this.scaledSettingSize("sidebar_font_size");
    const projectFontSize = this.scaledSettingSize("project_font_size");
    const terminalFontSize = this.scaledSettingSize("terminal_font_size");
    const uiFontSize = this.scaledSettingSize("ui_font_size");
    const systemFontSize = this.scaledSettingSize("system_font_size");
    const codeFontSize = this.scaledSettingSize("code_font_size");
    const bottomFontSize = this.scaledSettingSize("bottom_font_size");
    const treeFontSize = this.scaledSettingSize("tree_font_size");
    const filesTabFontSize = this.scaledSettingSize("files_tab_font_size");
    const sidebar = this.$("sidebar");
    const filesVisible = FILES_SIDE_PANEL_TABS.includes(this.sideView);
    const normalWidth = Number(s.sidebar_width) || SETTINGS_DEFAULTS.sidebar_width;
    const activeSidebarWidth = filesVisible ? this.filesPanelWidth() : normalWidth;
    const sidebarLeft = sidebar.getBoundingClientRect().left || 0;
    const sidebarRight = sidebarLeft + activeSidebarWidth;
    const maximumNotebookLeft = Math.max(0, window.innerWidth - 334);
    const defaultNotebookLeft = Math.min(Math.round(sidebarRight + 32), maximumNotebookLeft);
    const configuredNotebookLeft = Number(s.notebook_left);
    const notebookLeft = configuredNotebookLeft >= 0
      ? Math.max(0, Math.min(maximumNotebookLeft, configuredNotebookLeft))
      : defaultNotebookLeft;
    sidebar.style.width = activeSidebarWidth + "px";
    sidebar.style.minWidth = activeSidebarWidth + "px";
    document.documentElement.style.setProperty("--history-sidebar-width", `${normalWidth}px`);
    document.documentElement.style.setProperty("--notebook-panel-left", `${notebookLeft}px`);
    document.documentElement.style.setProperty("--sidebar-font-size", sidebarFontSize + "px");
    document.documentElement.style.setProperty("--project-font-size", projectFontSize + "px");
    document.documentElement.style.setProperty("--terminal-font-size", terminalFontSize + "px");
    document.documentElement.style.setProperty("--ui-font-size", uiFontSize + "px");
    document.documentElement.style.setProperty("--system-font-size", systemFontSize + "px");
    document.documentElement.style.setProperty("--code-font-size", codeFontSize + "px");
    document.documentElement.style.setProperty("--files-tab-font-size", filesTabFontSize + "px");
    document.documentElement.style.setProperty("--bottom-font-size", bottomFontSize + "px");
    const baseBottomFontSize = this.touchMobileLayoutEnabled()
      ? SETTINGS_DEFAULTS.bottom_font_size : Number(s.bottom_font_size) || SETTINGS_DEFAULTS.bottom_font_size;
    document.documentElement.style.setProperty("--ui-scale", String(this.normalizeUiScale(baseBottomFontSize / SETTINGS_DEFAULTS.bottom_font_size)));
    document.documentElement.style.setProperty("--sidebar-text-color", s.sidebar_text_color);
    const terminalIconSize = Math.max(FONT_MIN, Math.min(FONT_MAX * this.displayScale(), this.scaledSettingSize("terminal_icon_size")));
    const terminalStatusDotSize = Math.max(5, Math.min(10, terminalIconSize * 0.43));
    const terminalStatusDotLeft = 2 + (terminalIconSize - terminalStatusDotSize) / 2;
    const terminalRowLeftPadding = Math.max(20, terminalIconSize + 7);
    document.documentElement.style.setProperty("--terminal-icon-size", `${terminalIconSize}px`);
    document.documentElement.style.setProperty("--terminal-status-dot-size", `${terminalStatusDotSize}px`);
    document.documentElement.style.setProperty("--terminal-status-dot-left", `${terminalStatusDotLeft}px`);
    document.documentElement.style.setProperty("--terminal-row-left-padding", `${terminalRowLeftPadding}px`);
    this.updateSessionAgeStyles();
    const configuredDiffFontSize = this.touchMobileLayoutEnabled()
      ? SETTINGS_DEFAULTS.diff_font_size : Number(s.diff_font_size) || SETTINGS_DEFAULTS.diff_font_size;
    const baseCodeFontSize = this.touchMobileLayoutEnabled()
      ? SETTINGS_DEFAULTS.code_font_size : Number(s.code_font_size) || SETTINGS_DEFAULTS.code_font_size;
    const baseRelativeDiffFontSize = configuredDiffFontSize === SETTINGS_DEFAULTS.diff_font_size
      ? Math.max(8, baseCodeFontSize - 1)
      : Math.min(configuredDiffFontSize, Math.max(8, baseCodeFontSize - 1));
    const relativeDiffFontSize = Math.round(baseRelativeDiffFontSize * this.displayScale() * 100) / 100;
    document.documentElement.style.setProperty("--diff-font-size", relativeDiffFontSize + "px");
    document.documentElement.style.setProperty("--tree-font-size", treeFontSize + "px");
    // The tree owns its own spacing scale. Row padding, indent and icon gaps used to ride on
    // --ui-scale ("UI icons / spacing"), so resizing global chrome silently re-spaced a tree that
    // has its own size control -- and the tree could not be tightened without shrinking the rest of
    // the app. Derived from the tree size the same way --ui-scale is derived from the bottom bar.
    document.documentElement.style.setProperty("--tree-scale",
      String(this.normalizeUiScale(treeFontSize / SETTINGS_DEFAULTS.tree_font_size)));
    this.applyThemeVariables();
    for (const view of this.views.values()) {
      if (view.term.options.fontSize !== terminalFontSize) view.term.options.fontSize = terminalFontSize;
      this.refreshTerminalAppearance(view);
    }
    if (this.editor) {
      this.editor.updateOptions({ fontSize: codeFontSize, wordWrap: s.editor_no_wrap ? "off" : "on" });
      this.defineMonacoTheme();
    }
    if (this.notebookEditor) {
      this.notebookEditor.updateOptions({ fontSize: codeFontSize, wordWrap: s.editor_no_wrap ? "off" : "on" });
      this.notebookEditor.layout();
    }
    if (this.fileHistoryCurrentEditor) {
      this.fileHistoryCurrentEditor.updateOptions({ fontSize: codeFontSize, wordWrap: s.editor_no_wrap ? "off" : "on" });
      this.fileHistoryCurrentEditor.layout();
    }
    if (this.fileHistoryDiffEditor) {
      this.fileHistoryDiffEditor.updateOptions({ fontSize: codeFontSize, wordWrap: s.editor_no_wrap ? "off" : "on" });
      this.fileHistoryDiffEditor.getOriginalEditor().updateOptions({ fontSize: codeFontSize, wordWrap: s.editor_no_wrap ? "off" : "on" });
      this.fileHistoryDiffEditor.getModifiedEditor().updateOptions({ fontSize: codeFontSize, wordWrap: s.editor_no_wrap ? "off" : "on" });
      this.fileHistoryDiffEditor.layout();
    }
    if (this.gitReviewDiffEditor) {
      this.gitReviewDiffEditor.updateOptions({ fontSize: codeFontSize, wordWrap: s.editor_no_wrap ? "off" : "on" });
      this.gitReviewDiffEditor.getOriginalEditor().updateOptions({ fontSize: codeFontSize, wordWrap: s.editor_no_wrap ? "off" : "on" });
      this.gitReviewDiffEditor.getModifiedEditor().updateOptions({ fontSize: codeFontSize, wordWrap: s.editor_no_wrap ? "off" : "on" });
      this.gitReviewDiffEditor.layout();
    }
    this.$("stat-text").classList.toggle("hidden", !s.show_stats);
    this.$("stat-spark").classList.toggle("hidden", !s.show_stats);
    const editorWrapToggle = this.$("editor-wrap-toggle");
    if (editorWrapToggle) {
      const editorNoWrapEnabled = !!s.editor_no_wrap;
      editorWrapToggle.classList.toggle("on", editorNoWrapEnabled);
      editorWrapToggle.setAttribute("aria-pressed", String(editorNoWrapEnabled));
      editorWrapToggle.title = `Editor no wrap: ${editorNoWrapEnabled ? "on" : "off"}`;
    }
    this.renderInlineSizeControls();
    if (fitTerminals) this.fitActive();
  },


  replaceMonacoFunctionKeybindings() {
    const ctrlCmd = monaco.KeyMod.CtrlCmd;
    const shift = monaco.KeyMod.Shift;
    const alt = monaco.KeyMod.Alt;
    const replacements = [
      { keybinding: ctrlCmd | shift | monaco.KeyCode.KeyP, command: "editor.action.quickCommand" },
      { keybinding: ctrlCmd | alt | shift | monaco.KeyCode.KeyR, command: "editor.action.rename" },
      { keybinding: ctrlCmd | monaco.KeyCode.KeyG, command: "editor.action.nextMatchFindAction" },
      { keybinding: ctrlCmd | shift | monaco.KeyCode.KeyG, command: "editor.action.previousMatchFindAction" },
      { keybinding: ctrlCmd | alt | monaco.KeyCode.KeyG, command: "editor.action.nextSelectionMatchFindAction" },
      { keybinding: ctrlCmd | alt | shift | monaco.KeyCode.KeyG, command: "editor.action.previousSelectionMatchFindAction" },
      { keybinding: ctrlCmd | shift | monaco.KeyCode.KeyL, command: "editor.action.changeAll" },
      { keybinding: ctrlCmd | alt | shift | monaco.KeyCode.KeyL, command: "editor.action.linkedEditing" },
      { keybinding: alt | shift | monaco.KeyCode.ArrowDown, command: "editor.action.accessibleDiffViewer.next", when: "isInDiffEditor" },
      { keybinding: alt | shift | monaco.KeyCode.ArrowUp, command: "editor.action.accessibleDiffViewer.prev", when: "isInDiffEditor" },
      { keybinding: alt | shift | monaco.KeyCode.Period, command: "editor.action.wordHighlight.next" },
      { keybinding: alt | shift | monaco.KeyCode.Comma, command: "editor.action.wordHighlight.prev" },
      { keybinding: ctrlCmd | alt | monaco.KeyCode.BracketRight, command: "editor.action.marker.next" },
      { keybinding: ctrlCmd | alt | monaco.KeyCode.BracketLeft, command: "editor.action.marker.prev" },
      { keybinding: ctrlCmd | alt | shift | monaco.KeyCode.BracketRight, command: "editor.action.marker.nextInFiles" },
      { keybinding: ctrlCmd | alt | shift | monaco.KeyCode.BracketLeft, command: "editor.action.marker.prevInFiles" },
      { keybinding: ctrlCmd | alt | monaco.KeyCode.Period, command: "goToNextReference" },
      { keybinding: ctrlCmd | alt | monaco.KeyCode.Comma, command: "goToPreviousReference" },
      { keybinding: ctrlCmd | alt | monaco.KeyCode.Backslash, command: "togglePeekWidgetFocus" },
      { keybinding: ctrlCmd | alt | shift | monaco.KeyCode.ArrowRight, command: "editor.gotoNextSymbolFromResult" },
      { keybinding: ctrlCmd | alt | monaco.KeyCode.KeyJ, command: "editor.action.revealDefinition" },
      { keybinding: ctrlCmd | alt | shift | monaco.KeyCode.KeyJ, command: "editor.action.revealDefinitionAside" },
      { keybinding: ctrlCmd | alt | monaco.KeyCode.KeyK, command: "editor.action.peekDefinition" },
      { keybinding: ctrlCmd | alt | monaco.KeyCode.KeyI, command: "editor.action.goToImplementation" },
      { keybinding: ctrlCmd | alt | shift | monaco.KeyCode.KeyI, command: "editor.action.peekImplementation" },
      { keybinding: ctrlCmd | alt | monaco.KeyCode.KeyU, command: "editor.action.goToReferences" },
      { keybinding: ctrlCmd | alt | monaco.KeyCode.Enter, command: "editor.action.showContextMenu" },
    ];
    const removedFunctionKeybindings = [
      monaco.KeyCode.F1, monaco.KeyCode.F2, ctrlCmd | monaco.KeyCode.F2, ctrlCmd | shift | monaco.KeyCode.F2,
      monaco.KeyCode.F3, shift | monaco.KeyCode.F3, ctrlCmd | monaco.KeyCode.F3, ctrlCmd | shift | monaco.KeyCode.F3,
      monaco.KeyCode.F4, shift | monaco.KeyCode.F4,
      monaco.KeyCode.F7, shift | monaco.KeyCode.F7,
      monaco.KeyCode.F8, shift | monaco.KeyCode.F8, alt | monaco.KeyCode.F8, alt | shift | monaco.KeyCode.F8,
      shift | monaco.KeyCode.F10, ctrlCmd | shift | monaco.KeyCode.F10,
      monaco.KeyCode.F12, shift | monaco.KeyCode.F12, alt | monaco.KeyCode.F12,
      ctrlCmd | monaco.KeyCode.F12, ctrlCmd | shift | monaco.KeyCode.F12,
      monaco.KeyMod.chord(ctrlCmd | monaco.KeyCode.KeyK, monaco.KeyCode.F2),
      monaco.KeyMod.chord(ctrlCmd | monaco.KeyCode.KeyK, monaco.KeyCode.F12),
      monaco.KeyMod.chord(ctrlCmd | monaco.KeyCode.KeyK, ctrlCmd | monaco.KeyCode.F12),
    ];
    monaco.editor.addKeybindingRules([
      ...replacements,
      ...removedFunctionKeybindings.map((keybinding) => ({ keybinding, command: null })),
    ]);
  },


  initMonaco() {
    this.monacoReady = new Promise((resolve) => {
      require.config({ paths: { vs: "/static/vendor/monaco/vs" } });
      require(["vs/editor/editor.main"], () => {
        this.defineMonacoTheme();
        this.editor = monaco.editor.create(this.$("monaco-host"), {
          readOnly: false, theme: this.monacoThemeName(),
          automaticLayout: true, minimap: { enabled: false },
          scrollBeyondLastLine: false, fontSize: this.scaledSettingSize("code_font_size"), lineNumbersMinChars: 4,
          renderLineHighlight: "all", folding: true, wordWrap: this.settings.editor_no_wrap ? "off" : "on", fixedOverflowWidgets: true,
        });
        this.lspClient = new TermdeckLspClient(this);
        this.lspClient.registerProviders();
        monaco.editor.onDidChangeMarkers(() => this.scheduleProblemsRefresh());
        this.editor.onMouseMove((event) => this.updateFileBlameGutterHover(event));
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
          keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyF],
          run: (ed) => ed.getAction("editor.action.startFindReplaceAction").run(),
        });
        this.editor.addAction({
          id: "termdeck-find-usages", label: "Find Usages in Project", contextMenuGroupId: "navigation",
          contextMenuOrder: 1.5,
          run: () => this.showEditorUsages(),
        });
        this.editor.addAction({
          id: "termdeck-file-history", label: "File History", contextMenuGroupId: "navigation", contextMenuOrder: 1.6,
          run: () => {
            const entry = this.activeFileKey !== null ? this.openFiles.get(this.activeFileKey) : null;
            if (entry) return this.openFileHistoryForPath(entry.root, entry.path, "all");
          },
        });
        this.editor.addAction({
          id: "termdeck-file-git-log", label: "Show Git Log for This File", contextMenuGroupId: "navigation",
          contextMenuOrder: 1.7,
          run: () => {
            const entry = this.activeFileKey !== null ? this.openFiles.get(this.activeFileKey) : null;
            if (entry) this.openGitHistoryForPath(entry.root, entry.path);
          },
        });
        this.editor.addAction({
          id: "termdeck-file-git-blame", label: "Annotate (Git Blame)", contextMenuGroupId: "navigation",
          contextMenuOrder: 1.8,
          run: () => {
            const entry = this.activeFileKey !== null ? this.openFiles.get(this.activeFileKey) : null;
            if (entry) return this.openFileBlame(entry.root, entry.path);
          },
        });
        this.replaceMonacoFunctionKeybindings();
        const notebookHost = this.$("notebook-editor-host");
        if (notebookHost) {
          notebookHost.textContent = "";
          this.notebookEditor = monaco.editor.create(notebookHost, {
            readOnly: false, theme: this.monacoThemeName(),
            automaticLayout: true, minimap: { enabled: false }, scrollBeyondLastLine: false,
            fontSize: this.scaledSettingSize("code_font_size"), lineNumbersMinChars: 2, lineDecorationsWidth: 8, glyphMargin: false,
            renderLineHighlight: "all", folding: true, wordWrap: this.settings.editor_no_wrap ? "off" : "on",
            selectionHighlight: false, occurrencesHighlight: "off", matchBrackets: "never",
            unicodeHighlight: { nonBasicASCII: false, invisibleCharacters: false, ambiguousCharacters: false },
            fixedOverflowWidgets: true, padding: { top: 10, bottom: 10 },
          });
          this.notebookEditor.onDidChangeModelContent(() => {
            if (!this.notebookMounted) return;
            const note = this.activeNotebookNote();
            const model = note ? this.notebookEditorModels.get(note.note_id) : null;
            if (!note || model !== this.notebookEditor.getModel()) return;
            this.setActiveNotebookText(this.notebookEditor.getValue(), false, false);
            clearTimeout(this.notebookTitleTimer);
            this.notebookTitleTimer = setTimeout(() => {
              this.renderNotebookTabs();
              this.saveActiveNotebookNote();
            }, 160);
          });
          this.notebookEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { void this.flushNotebook(); });
        }
        this.editor.onMouseDown((mouseEvent) => {
          const event = mouseEvent.event;
          if (this.openFileGitHunkMenu(mouseEvent)) return;
          if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || !mouseEvent.target.position) return;
          event.preventDefault();
          event.stopPropagation();
          void this.openEditorSymbolAtPosition(mouseEvent.target.position);
        });
        resolve();
      });
    });
  },


  saveSettings() {
    if (/^#[0-9a-f]{6}$/i.test(String(this.settings.sidebar_text_color || ""))) {
      localStorage.setItem("termdeck.sidebar_text_color", this.settings.sidebar_text_color);
    }
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.queueSettingsPatch();
    }, 400);
  },


  saveSettingsImmediately() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.queueSettingsPatch();
  },


  flushPendingSettingsSave() {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const patch = this.changedSettingsPatch(this.copySettings(this.settings));
    if (!Object.keys(patch).length) return;
    for (const operation of this.settingWriteOperations(patch)) {
      const body = operation.method === "PUT" ? JSON.stringify({ value: operation.value }) : undefined;
      void fetch(operation.path, { method: operation.method, headers: body ? { "Content-Type": "application/json" } : {},
        body, keepalive: !body || body.length < 60000 }).catch((error) => console.error("TermDeck settings exit save failed", error));
    }
  },


  copySettings(settings) {
    return JSON.parse(JSON.stringify(settings));
  },


  changedSettingsPatch(settingsSnapshot) {
    const patch = {};
    for (const [key, value] of Object.entries(settingsSnapshot)) {
      if (key === "project_state" || SERVER_LOCAL_SETTING_KEYS.has(key)) continue;
      if (JSON.stringify(value) !== JSON.stringify(this.persistedSettings[key])) patch[key] = value;
    }
    return patch;
  },


  settingWriteOperations(patch) {
    const operations = [];
    for (const [key, value] of Object.entries(patch)) {
      const previous = this.persistedSettings[key];
      const keyed = value && previous && typeof value === "object" && typeof previous === "object" &&
        !Array.isArray(value) && !Array.isArray(previous);
      if (!keyed) {
        operations.push({ key, method: "PUT", path: `/api/settings/${encodeURIComponent(key)}`, value });
        continue;
      }
      const entryKeys = new Set([...Object.keys(previous), ...Object.keys(value)]);
      for (const entryKey of entryKeys) {
        if (!Object.prototype.hasOwnProperty.call(value, entryKey)) {
          operations.push({ key, entryKey, method: "DELETE",
            path: `/api/settings/${encodeURIComponent(key)}/${encodeURIComponent(entryKey)}` });
        } else if (JSON.stringify(value[entryKey]) !== JSON.stringify(previous[entryKey])) {
          operations.push({ key, entryKey, method: "PUT",
            path: `/api/settings/${encodeURIComponent(key)}/${encodeURIComponent(entryKey)}`, value: value[entryKey] });
        }
      }
    }
    return operations;
  },


  applyPersistedSettingOperation(operation, value) {
    if (operation.entryKey === undefined) {
      this.persistedSettings[operation.key] = this.copySettings(value);
      return;
    }
    const current = this.persistedSettings[operation.key] && typeof this.persistedSettings[operation.key] === "object"
      ? this.copySettings(this.persistedSettings[operation.key]) : {};
    if (operation.method === "DELETE") delete current[operation.entryKey];
    else current[operation.entryKey] = this.copySettings(value);
    this.persistedSettings[operation.key] = current;
  },


  queueSettingsPatch() {
    this.settingsSavePromise = this.settingsSavePromise.catch((error) => {
      console.error("TermDeck settings save failed", error);
    }).then(async () => {
      const settingsSnapshot = this.copySettings(this.settings);
      const patch = this.changedSettingsPatch(settingsSnapshot);
      if (!Object.keys(patch).length) return;
      for (const operation of this.settingWriteOperations(patch)) {
        const body = operation.method === "PUT" ? JSON.stringify({ value: operation.value }) : undefined;
        const response = await fetch(operation.path, { method: operation.method,
          headers: body ? { "Content-Type": "application/json" } : {}, body });
        if (!response.ok) throw new Error(`setting save failed for ${operation.key} (${response.status})`);
        const persisted = await response.json();
        this.applyPersistedSettingOperation(operation, persisted.value);
      }
      if (Object.keys(this.changedSettingsPatch(this.settings)).length) this.saveSettings();
    });
  },


  initFontSampleEditor() {
    const backdrop = this.$("font-samples-backdrop");
    const range = this.$("font-samples-range");
    if (!backdrop || !range) return;
    this.$("font-samples-close").onclick = () => this.closeFontSampleEditor();
    this.$("font-samples-minus").onclick = () => this.changeSelectedFontSampleSize(-1);
    this.$("font-samples-plus").onclick = () => this.changeSelectedFontSampleSize(1);
    this.$("font-samples-reset").onclick = () => this.resetSelectedFontSampleSize();
    range.oninput = () => this.setSelectedFontSampleSize(Number(range.value));
    backdrop.addEventListener("mousedown", (event) => {
      if (event.target === backdrop) this.closeFontSampleEditor();
    });
    backdrop.addEventListener("pointerdown", (event) => event.stopPropagation());
    backdrop.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        this.closeFontSampleEditor();
        return;
      }
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        this.selectFontSample(this.fontSampleSelectionIndex + (event.key === "ArrowDown" ? 1 : -1), true);
        return;
      }
      if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        this.selectFontSample(event.key === "Home" ? 0 : INLINE_SIZE_SETTING_DEFINITIONS.length - 1, true);
        return;
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        this.changeSelectedFontSampleSize(event.key === "ArrowRight" ? 1 : -1);
      }
    });
  },


  openFontSampleEditor() {
    this.fontSampleReturnFocus = this.$("settings-gear");
    this.$("settings-popover").classList.add("hidden");
    this.$("font-samples-backdrop").classList.remove("hidden");
    this.renderFontSampleList();
    this.selectFontSample(this.fontSampleSelectionIndex, false);
    requestAnimationFrame(() => this.$("font-samples-list")?.querySelector(".font-samples-list-item.selected")?.focus());
  },


  closeFontSampleEditor() {
    const backdrop = this.$("font-samples-backdrop");
    if (!backdrop || backdrop.classList.contains("hidden")) return false;
    backdrop.classList.add("hidden");
    this.flushPendingSettingsSave();
    const returnFocus = this.fontSampleReturnFocus;
    this.fontSampleReturnFocus = null;
    requestAnimationFrame(() => returnFocus?.focus());
    return true;
  },


  selectedFontSampleDefinition() {
    return INLINE_SIZE_SETTING_DEFINITIONS[this.fontSampleSelectionIndex] || INLINE_SIZE_SETTING_DEFINITIONS[0];
  },


  renderFontSampleList() {
    const list = this.$("font-samples-list");
    if (!list) return;
    list.textContent = "";
    INLINE_SIZE_SETTING_DEFINITIONS.forEach((definition, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "font-samples-list-item";
      button.dataset.index = String(index);
      button.dataset.key = definition.key;
      button.setAttribute("role", "option");
      const label = document.createElement("span");
      label.textContent = definition.label;
      const value = document.createElement("span");
      value.className = "font-samples-list-value";
      value.textContent = `${Math.round(Number(this.settings[definition.key]) || SETTINGS_DEFAULTS[definition.key])}px`;
      button.append(label, value);
      button.onclick = () => this.selectFontSample(index, true);
      list.appendChild(button);
    });
  },


  selectFontSample(index, focus = false) {
    const count = INLINE_SIZE_SETTING_DEFINITIONS.length;
    this.fontSampleSelectionIndex = (Number(index) + count) % count;
    this.refreshFontSampleEditor();
    if (focus) this.$("font-samples-list")?.querySelector(".font-samples-list-item.selected")?.focus();
  },


  setSelectedFontSampleSize(value) {
    const definition = this.selectedFontSampleDefinition();
    const normalized = Math.max(FONT_MIN, Math.min(FONT_MAX, Number(value) || FONT_MIN));
    this.settings[definition.key] = normalized;
    this.applySettings({ fitTerminals: false });
    this.saveSettings();
    this.refreshFontSampleEditor();
  },


  changeSelectedFontSampleSize(delta) {
    const definition = this.selectedFontSampleDefinition();
    this.setSelectedFontSampleSize((Number(this.settings[definition.key]) || SETTINGS_DEFAULTS[definition.key]) + delta);
  },


  resetSelectedFontSampleSize() {
    const definition = this.selectedFontSampleDefinition();
    this.setSelectedFontSampleSize(SETTINGS_DEFAULTS[definition.key]);
  },


  refreshFontSampleEditor() {
    const definition = this.selectedFontSampleDefinition();
    const value = Math.round(Number(this.settings[definition.key]) || SETTINGS_DEFAULTS[definition.key]);
    this.$("font-samples-selection-label").textContent = definition.label;
    this.$("font-samples-selection-value").textContent = `${value}px`;
    this.$("font-samples-range").value = String(value);
    const preview = this.$("font-samples-preview");
    preview.style.setProperty("--font-sample-size", `${value}px`);
    this.renderSelectedFontSamplePreview(definition.key);
    for (const row of this.$("font-samples-list").querySelectorAll(".font-samples-list-item")) {
      const selected = row.dataset.key === definition.key;
      row.classList.toggle("selected", selected);
      row.setAttribute("aria-selected", String(selected));
      row.tabIndex = selected ? 0 : -1;
      const rowValue = row.querySelector(".font-samples-list-value");
      if (rowValue) {
        const rowDefinition = INLINE_SIZE_SETTING_DEFINITIONS[Number(row.dataset.index)];
        rowValue.textContent = `${Math.round(Number(this.settings[rowDefinition.key]) || SETTINGS_DEFAULTS[rowDefinition.key])}px`;
      }
      if (selected) row.scrollIntoView({ block: "nearest" });
    }
  },


  renderSelectedFontSamplePreview(key) {
    const preview = this.$("font-samples-preview");
    const samples = {
      sidebar_font_size: '<section class="font-sample-stage font-sample-terminal-list"><div class="font-sample-terminal-group"><span class="codicon codicon-chevron-down"></span><strong>RESEARCH</strong><span class="font-sample-count">2 active</span></div><div class="font-sample-terminal-row"><span class="font-sample-dot"></span><span>feat-model-review</span><span class="font-sample-age">4m</span></div></section>',
      project_font_size: '<section class="font-sample-stage"><div class="font-sample-project">stock-intraday <span>main · ~/workspace</span></div></section>',
      terminal_icon_size: '<section class="font-sample-stage font-sample-icons"><span class="codicon codicon-terminal"></span><span class="codicon codicon-sparkle"></span><span class="codicon codicon-hubot"></span></section>',
      terminal_font_size: '<section class="font-sample-stage font-sample-terminal"><pre><span class="prompt">›</span> review the current feature cache\n\n<span class="assistant">•</span> Working through the source files…</pre></section>',
      ui_font_size: '<section class="font-sample-stage font-sample-status"><div class="font-sample-status-row"><span>agent-session · ~/workspace/project</span><span>12m</span></div><div class="font-sample-status-row"><span>project › src › main.py</span><span>model · 41% context</span></div></section>',
      system_font_size: '<section class="font-sample-stage font-sample-menu"><div><span class="codicon codicon-go-to-file"></span>Open</div><div><span class="codicon codicon-edit"></span>Rename</div><div><span class="codicon codicon-arrow-swap"></span>Move to</div></section>',
      code_font_size: '<section class="font-sample-stage font-sample-code"><pre><span class="line-number">12</span> <span class="keyword">const</span> cache = <span class="function">loadFeatures</span>(<span class="string">"stock"</span>);\n<span class="line-number">13</span> cache.validate();</pre></section>',
      files_tab_font_size: '<section class="font-sample-stage font-sample-file-tabs"><div class="active">model_config.py<span class="codicon codicon-close"></span></div><div>universe.py<span class="codicon codicon-close"></span></div></section>',
      bottom_font_size: '<section class="font-sample-stage font-sample-bottom"><span class="codicon codicon-comment-discussion"></span><span class="codicon codicon-refresh"></span><span class="codicon codicon-fold-down"></span><span class="codicon codicon-cloud-upload"></span></section>',
      diff_font_size: '<section class="font-sample-stage font-sample-diff"><pre><div class="removed">− old_feature = cache.final_value</div><div class="added">+ feature = cache.point_in_time_value</div></pre></section>',
      tree_font_size: '<section class="font-sample-stage font-sample-tree"><div class="folder"><span class="codicon codicon-folder-opened"></span>trainer</div><div class="child"><span class="codicon codicon-file-code"></span><span class="match">model_<mark>config</mark>.py</span></div><div class="child"><span class="codicon codicon-file"></span>features.py</div></section>',
    };
    preview.innerHTML = samples[key] || "";
  },


  initInlineSizeControls() {
    this.inlineSizeControlRoots = new Map();
    const done = document.createElement("button");
    done.id = "inline-size-done";
    done.type = "button";
    done.className = "hidden";
    done.innerHTML = '<span class="codicon codicon-save"></span><span>Save</span>';
    done.title = "Save font sizes and close Visualize";
    done.setAttribute("aria-label", done.title);
    done.onclick = () => this.exitInlineSizeControls();
    document.body.appendChild(done);
    for (const definition of INLINE_SIZE_SETTING_DEFINITIONS) {
      const root = document.createElement("div");
      root.id = `inline-size-control-${definition.key}`;
      root.className = "inline-size-controls hidden";
      root.setAttribute("role", "toolbar");
      root.setAttribute("aria-label", `${definition.label} size`);
      root.title = `${definition.label} size`;
      const row = document.createElement("div");
      row.className = "inline-size-control-row";
      const label = document.createElement("span");
      label.className = "inline-size-control-label";
      label.textContent = definition.label;
      const minus = document.createElement("button");
      minus.type = "button";
      minus.className = "inline-size-control-step";
      minus.textContent = "−";
      minus.title = `Decrease ${definition.label.toLowerCase()} size`;
      minus.setAttribute("aria-label", minus.title);
      const range = document.createElement("input");
      range.type = "range";
      range.className = "inline-size-control-range";
      range.min = String(FONT_MIN);
      range.max = String(FONT_MAX);
      range.step = "1";
      range.title = `Adjust ${definition.label.toLowerCase()} size`;
      range.setAttribute("aria-label", range.title);
      const value = document.createElement("span");
      value.className = "inline-size-control-value";
      const plus = document.createElement("button");
      plus.type = "button";
      plus.className = "inline-size-control-step";
      plus.textContent = "+";
      plus.title = `Increase ${definition.label.toLowerCase()} size`;
      plus.setAttribute("aria-label", plus.title);
      const reset = document.createElement("button");
      reset.type = "button";
      reset.className = "inline-size-control-reset";
      reset.textContent = "↺";
      reset.title = `Reset ${definition.label.toLowerCase()} size to default`;
      reset.setAttribute("aria-label", reset.title);
      minus.onclick = () => this.setInlineSize(definition.key, Number(range.value) - 1);
      plus.onclick = () => this.setInlineSize(definition.key, Number(range.value) + 1);
      range.oninput = () => this.setInlineSize(definition.key, Number(range.value));
      reset.onclick = () => this.resetInlineSize(definition.key);
      row.append(label, minus, range, value, plus, reset);
      root.appendChild(row);
      root.addEventListener("pointerdown", (event) => {
        this.startInlineSizeControlDrag(event, this.inlineSizeControlRoots.get(definition.key));
        event.stopPropagation();
      });
      root.addEventListener("click", (event) => event.stopPropagation());
      document.body.appendChild(root);
      this.inlineSizeControlRoots.set(definition.key, { root, range, value, position: null });
    }
    document.addEventListener("pointerover", (event) => {
      if (!this.settings.inline_size_controls || !(event.target instanceof Element)) return;
      if ([...this.inlineSizeControlRoots.values()].some((controls) => !controls.root.classList.contains("hidden"))) return;
      if (this.inlineSizeTargetForElement(event.target)) this.renderInlineSizeControls();
    });
    document.addEventListener("pointerdown", (event) => {
      if (![...this.inlineSizeControlRoots.values()].some((controls) => controls.root.contains(event.target))) {
        this.hideInlineSizeControls();
      }
    }, true);
    document.addEventListener("pointermove", (event) => this.dragInlineSizeControl(event));
    document.addEventListener("pointerup", () => this.finishInlineSizeControlDrag());
    window.addEventListener("resize", () => this.renderInlineSizeControls());
  },


  startInlineSizeControlDrag(event, controls) {
    if (event.button !== 0 || event.target instanceof HTMLInputElement || event.target instanceof HTMLButtonElement || !controls) return;
    const rect = controls.root.getBoundingClientRect();
    controls.position = { left: rect.left, top: rect.top };
    this.inlineSizeDrag = { controls, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
    controls.root.classList.add("dragging");
    event.preventDefault();
  },


  dragInlineSizeControl(event) {
    if (!this.inlineSizeDrag) return;
    const { controls, offsetX, offsetY } = this.inlineSizeDrag;
    const width = controls.root.offsetWidth;
    const height = controls.root.offsetHeight;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, event.clientX - offsetX));
    const top = Math.max(8, Math.min(window.innerHeight - height - 8, event.clientY - offsetY));
    controls.position = { left, top };
    controls.root.style.left = `${left}px`;
    controls.root.style.top = `${top}px`;
  },


  finishInlineSizeControlDrag() {
    if (!this.inlineSizeDrag) return;
    this.inlineSizeDrag.controls.root.classList.remove("dragging");
    this.inlineSizeDrag = null;
  },


  inlineSizeTargetForElement(element) {
    if (element.closest(".inline-size-controls, #settings-popover, #keys-backdrop")) return null;
    const targets = [
      { selectors: "#project-select", key: "project_font_size" },
      { selectors: "#file-breadcrumbs, .file-breadcrumb, #status-name, #lsp-status, #terminal-age, #history-meta, #stat-text", key: "ui_font_size" },
      { selectors: ".collapsible-section-header, .closed-header, .file-item, .closed-item, #context-menu, #settings-popover, #keys-modal", key: "system_font_size" },
      { selectors: "#bottombar, #sidebar-footer, #terminal-actions, #files-section-header", key: "bottom_font_size" },
      { selectors: ".history-event pre, .history-diff, .markdown pre code", key: "diff_font_size" },
      { selectors: "#terminal-area, .term-container, .xterm", key: "terminal_font_size" },
      { selectors: "#file-tabs-bar", key: "files_tab_font_size" },
      { selectors: "#editor-area, #history-area, #notebook-panel, #file-history-editor-host, #file-history-preview", key: "code_font_size" },
      { selectors: ".terminal-type-icon", key: "terminal_icon_size" },
      { selectors: ".tree-row, .search-file, .search-hit, .git-commit, .terminal-history-title-match, #files-section, #terminal-search-inline", key: "tree_font_size" },
      { selectors: ".session-item, .terminal-group, .closed-item, #sidebar-header, #session-list, #closed-section", key: "sidebar_font_size" },
      { selectors: "#main", key: "ui_font_size" },
    ];
    for (const target of targets) {
      const matched = element.closest(target.selectors);
      if (matched) return { element: matched, key: target.key };
    }
    return null;
  },


  inlineSizeTargetForKey(key) {
    const selectors = {
      sidebar_font_size: "#session-list, #closed-section",
      project_font_size: "#project-select",
      terminal_icon_size: ".terminal-type-icon",
      terminal_font_size: "#terminal-area",
      ui_font_size: "#file-breadcrumbs, #status-name, #lsp-status, #terminal-age, #history-meta, #stat-text",
      system_font_size: "#sidebar",
      code_font_size: "#editor-area, #history-area, #notebook-panel, #file-history-diff-pane",
      files_tab_font_size: "#file-tabs-bar",
      bottom_font_size: "#sidebar-footer",
      diff_font_size: ".history-diff, .history-event pre, #file-history-preview",
      tree_font_size: "#files-tree, #search-results, #name-results, #git-results, #terminal-search-inline",
    }[key];
    if (!selectors) return null;
    for (const element of document.querySelectorAll(selectors)) {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" &&
          rect.width > 1 && rect.height > 1 && rect.bottom > 0 && rect.right > 0 &&
          rect.top < window.innerHeight && rect.left < window.innerWidth) return element;
    }
    return null;
  },


  renderInlineSizeControls() {
    if (!this.inlineSizeControlRoots) return;
    const done = this.$("inline-size-done");
    if (!this.settings.inline_size_controls) {
      this.hideInlineSizeControls();
      done?.classList.add("hidden");
      return;
    }
    done?.classList.remove("hidden");
    const visibleTargets = new Map();
    const placedControls = [];
    for (const definition of INLINE_SIZE_SETTING_DEFINITIONS) {
      const controls = this.inlineSizeControlRoots.get(definition.key);
      const target = this.inlineSizeTargetForKey(definition.key);
      if (!target) {
        controls.root.classList.add("hidden");
        continue;
      }
      controls.range.value = String(Math.round(Number(this.settings[definition.key]) || 0));
      controls.value.textContent = `${Math.round(Number(this.settings[definition.key]) || 0)}px`;
      controls.root.classList.remove("hidden");
      visibleTargets.set(definition.key, target);
      if (controls.position) {
        const width = controls.root.offsetWidth;
        const height = controls.root.offsetHeight;
        const left = Math.max(8, Math.min(window.innerWidth - width - 8, controls.position.left));
        const top = Math.max(8, Math.min(window.innerHeight - height - 8, controls.position.top));
        controls.position = { left, top };
        placedControls.push({ left, top, right: left + width, bottom: top + height });
      }
    }
    for (const definition of INLINE_SIZE_SETTING_DEFINITIONS) {
      const controls = this.inlineSizeControlRoots.get(definition.key);
      const target = visibleTargets.get(definition.key);
      if (!target || controls.position) continue;
      const rect = target.getBoundingClientRect();
      const width = controls.root.offsetWidth;
      const height = controls.root.offsetHeight;
      const maxLeft = Math.max(8, window.innerWidth - width - 8);
      const maxTop = Math.max(8, window.innerHeight - height - 8);
      const left = Math.min(Math.max(8, rect.right - width - 8), maxLeft);
      let top = Math.min(Math.max(8, rect.top + 8), maxTop);
      for (let attempt = 0; attempt <= placedControls.length; attempt += 1) {
        const overlap = placedControls.find((placed) => left < placed.right && left + width > placed.left &&
          top < placed.bottom && top + height > placed.top);
        if (!overlap) break;
        top = overlap.bottom + 8;
        if (top > maxTop) top = Math.max(8, overlap.top - height - 8);
      }
      controls.root.style.left = `${left}px`;
      controls.root.style.top = `${top}px`;
      controls.position = { left, top };
      placedControls.push({ left, top, right: left + width, bottom: top + height });
    }
  },


  hideInlineSizeControls() {
    if (!this.inlineSizeControlRoots) return;
    for (const controls of this.inlineSizeControlRoots.values()) controls.root.classList.add("hidden");
  },


  setInlineSize(key, value) {
    if (!this.inlineSizeControlRoots?.has(key)) return;
    this.settings[key] = Math.max(FONT_MIN, Math.min(FONT_MAX, Number(value) || FONT_MIN));
    this.applySettings({ fitTerminals: false });
    this.saveSettings();
    this.renderInlineSizeControls();
  },


  resetInlineSize(key) {
    if (!this.inlineSizeControlRoots?.has(key) || typeof SETTINGS_DEFAULTS[key] !== "number") return;
    this.setInlineSize(key, SETTINGS_DEFAULTS[key]);
  },


  resetAllFontSizes() {
    for (const definition of INLINE_SIZE_SETTING_DEFINITIONS) this.settings[definition.key] = SETTINGS_DEFAULTS[definition.key];
    this.applySettings({ fitTerminals: false });
    this.saveSettings();
    this.renderInlineSizeControls();
  },


  async resetAllFontSizesWithConfirmation() {
    if (await uiConfirm("Reset all font sizes to their defaults?")) this.resetAllFontSizes();
  },


  openInlineSizeEditor() {
    this.settings.inline_size_controls = true;
    this.applySettings({ fitTerminals: false });
    this.saveSettings();
    this.$("settings-popover").classList.add("hidden");
    this.renderInlineSizeControls();
  },


  exitInlineSizeControls() {
    if (!this.settings.inline_size_controls) return false;
    this.settings.inline_size_controls = false;
    this.hideInlineSizeControls();
    this.$("inline-size-done")?.classList.add("hidden");
    this.saveSettings();
    this.flushPendingSettingsSave();
    this.$("settings-popover").classList.add("hidden");
    requestAnimationFrame(() => this.focusActiveEditor());
    return true;
  },


  openSettingsPopover(anchor) {
    const pop = this.$("settings-popover");
    pop.classList.remove("lsp-settings-expanded", "lsp-install-options-popover");
    pop.textContent = "";
    pop.onkeydown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      pop.classList.add("hidden");
      anchor.focus();
    };
    pop.appendChild(this.buildThemeSelectRow());
    pop.appendChild(this.buildRemoteAccessRow());
    pop.appendChild(this.buildLanAccessRow());
    pop.appendChild(this.buildTerminalIconSettingsRow());
    if (!this.touchMobileLayoutEnabled()) pop.appendChild(this.buildFontSizeEditRow());
    if (this.lspClient) pop.appendChild(this.lspClient.buildSettingsSection(anchor));
    // The readout is the entry point to the maintenance menu, so hiding it hides both.
    pop.appendChild(this.buildToggleRow("Resource monitor & maintenance",
      () => (this.settings.show_stats ? "shown" : "hidden"),
      () => { this.settings.show_stats = !this.settings.show_stats; }));
    // One switch drives both notification kinds (attention + finished runs); the two
    // underlying settings keys stay separate because the server-side notifier reads them.
    const agentNotificationsEnabled = () =>
      this.settings.notify_attention !== false || this.settings.notify_agent_idle !== false;
    pop.appendChild(this.buildToggleRow("Notify on attention & finished runs",
      () => (agentNotificationsEnabled() ? "on" : "off"),
      () => {
        const next = !agentNotificationsEnabled();
        this.settings.notify_attention = next;
        this.settings.notify_agent_idle = next;
        if (next) this.maybeRequestNotificationPermission();
      }));
    if (this.touchMobileLayoutEnabled()) pop.appendChild(this.buildMobileDisplayScaleRow());
    // Experiment switch: see tallRowPlan(). GPU rendering, at the cost of a much shorter scrollable
    // canvas -- the whole trade is explained there.
    pop.appendChild(this.buildToggleRow("WebGL renderer (this browser, reload)",
      () => (this.standardTallWebglEnabled() ? "on" : "off"),
      () => { this.setBrowserBooleanSetting(BROWSER_TALL_WEBGL_KEY, !this.standardTallWebglEnabled()); }, null, false));
    pop.appendChild(this.buildActionRow("Export settings", "download",
      () => { pop.classList.add("hidden"); this.exportSettings(); }));
    this.positionPopover(pop, anchor);
    this.updateEventlyDemoFeatureBanner();
  },


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
  },


  buildFontSizeEditRow() {
    const row = document.createElement("div");
    row.className = "settings-row settings-font-size-mode-row";
    const label = document.createElement("span");
    label.className = "settings-label";
    label.textContent = "Font sizes";
    const controls = document.createElement("span");
    controls.className = "settings-font-size-mode-controls";
    const visualize = document.createElement("button");
    visualize.type = "button";
    visualize.className = "theme-toggle";
    visualize.textContent = "visualize";
    visualize.title = "Edit font sizes in place on their UI elements";
    const samples = document.createElement("button");
    samples.type = "button";
    samples.className = "theme-toggle";
    samples.textContent = "samples";
    samples.title = "Edit font sizes with representative UI samples";
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "settings-font-size-reset";
    reset.innerHTML = '<span class="codicon codicon-refresh"></span>';
    reset.title = "Reset all font sizes to defaults";
    reset.setAttribute("aria-label", reset.title);
    visualize.onclick = () => this.openInlineSizeEditor();
    samples.onclick = () => this.openFontSampleEditor(samples);
    reset.onclick = () => this.resetAllFontSizesWithConfirmation();
    controls.append(visualize, samples, reset);
    row.append(label, controls);
    return row;
  },


  buildThemeSelectRow() {
    const row = document.createElement("div");
    row.className = "settings-row settings-theme-row";
    const label = document.createElement("div");
    label.className = "settings-theme-heading";
    const title = document.createElement("span");
    title.className = "settings-label";
    title.textContent = "Theme";
    label.append(title);
    const controls = document.createElement("div");
    controls.className = "settings-theme-control";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "theme-toggle settings-theme-toggle";
    toggle.setAttribute("aria-haspopup", "listbox");
    toggle.setAttribute("aria-expanded", "false");
    const updateToggle = () => {
      const theme = this.themeDefinition();
      toggle.textContent = theme.label;
      toggle.title = `${theme.label} theme · Click to expand`;
    };
    const select = document.createElement("select");
    select.className = "settings-theme-list";
    select.setAttribute("aria-label", "Choose a TermDeck theme");
    select.setAttribute("size", String(Math.min(8, THEME_DEFINITIONS.length)));
    select.setAttribute("role", "listbox");
    for (const theme of THEME_DEFINITIONS) {
      const option = document.createElement("option");
      option.value = theme.id;
      option.textContent = theme.label;
      select.appendChild(option);
    }
    select.value = this.themeDefinition().id;
    const applySelection = () => {
      this.settings.theme = THEME_BY_ID[select.value] ? select.value : SETTINGS_DEFAULTS.theme;
      select.value = this.settings.theme;
      this.applySettings();
      this.saveSettings();
      updateToggle();
      this.updateEventlyDemoFeatureBanner();
    };
    const moveSelection = (delta) => {
      const currentIndex = THEME_DEFINITIONS.findIndex((theme) => theme.id === this.settings.theme);
      const nextIndex = (Math.max(0, currentIndex) + delta + THEME_DEFINITIONS.length) % THEME_DEFINITIONS.length;
      select.value = THEME_DEFINITIONS[nextIndex].id;
      applySelection();
    };
    const setExpanded = (expanded) => {
      row.classList.toggle("expanded", expanded);
      select.classList.toggle("hidden", !expanded);
      toggle.setAttribute("aria-expanded", String(expanded));
      toggle.title = expanded ? "Collapse theme list" : `${this.themeDefinition().label} theme · Click to expand`;
      if (expanded) select.focus();
      else toggle.focus();
    };
    toggle.onclick = () => setExpanded(!row.classList.contains("expanded"));
    toggle.onkeydown = (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowRight") {
        event.preventDefault();
        moveSelection(1);
      } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
        event.preventDefault();
        moveSelection(-1);
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        setExpanded(!row.classList.contains("expanded"));
      } else if (event.key === "Escape" && row.classList.contains("expanded")) {
        event.preventDefault();
        setExpanded(false);
      }
    };
    select.oninput = applySelection;
    select.onchange = applySelection;
    updateToggle();
    select.classList.add("hidden");
    controls.append(toggle, select);
    row.append(label, controls);
    return row;
  },


  buildToggleRow(labelText, valueText, flip, afterFlip = null, persistSettings = true) {
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
      if (persistSettings) this.saveSettings();
      if (afterFlip) afterFlip();
    };
    row.append(label, button);
    return row;
  },


  buildMobileDisplayScaleRow() {
    const row = document.createElement("div");
    row.className = "settings-row mobile-display-scale-row";
    const label = document.createElement("span");
    label.className = "settings-label";
    label.textContent = "Mobile size";
    const controls = document.createElement("span");
    controls.className = "settings-controls mobile-display-scale-controls";
    const minus = document.createElement("button");
    minus.type = "button";
    minus.textContent = "−";
    minus.setAttribute("aria-label", "Decrease mobile display size");
    const value = document.createElement("button");
    value.type = "button";
    value.className = "mobile-display-scale-value";
    value.title = "Reset mobile display size";
    const plus = document.createElement("button");
    plus.type = "button";
    plus.textContent = "+";
    plus.setAttribute("aria-label", "Increase mobile display size");
    const updateValue = () => { value.textContent = `${Math.round(this.mobileDisplayScale() * 100)}%`; };
    minus.onclick = () => { this.setMobileDisplayScale(this.mobileDisplayScale() - MOBILE_DISPLAY_SCALE_STEP); updateValue(); };
    plus.onclick = () => { this.setMobileDisplayScale(this.mobileDisplayScale() + MOBILE_DISPLAY_SCALE_STEP); updateValue(); };
    value.onclick = () => { this.setMobileDisplayScale(1); updateValue(); };
    updateValue();
    controls.append(minus, value, plus);
    row.append(label, controls);
    return row;
  },


  // xterm's default DOM renderer rebuilds row spans on every refresh, which dominated CPU on a busy
  // terminal (measured: JS 92% idle while the tab burned ~30%, i.e. the cost is paint, not script). The
  // WebGL renderer draws to a canvas instead. Must be attached after term.open() so a context exists, and
  // must fall back to the DOM renderer on context loss, which browsers do trigger under memory pressure.
  // The largest terminal this machine's GPU can actually back, in rows. Returns 0 when WebGL is
  // unavailable, which callers read as "use DOM".
  maxWebglSafeRows(cellHeight) {
    if (!cellHeight) return 0;
    try {
      const probe = document.createElement("canvas");
      const gl = probe.getContext("webgl2") || probe.getContext("webgl");
      if (!gl) return 0;
      const limit = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 0;
      const deviceCellHeight = Math.max(1, cellHeight * (window.devicePixelRatio || 1));
      // Headroom, not the whole limit. Sizing right up against MAX_TEXTURE_SIZE does not fail loudly --
      // the addon silently allocates a 1x backing store and lets the browser stretch it, which renders as
      // text that is both too large and soft. Measured at dpr 2.5: 154 rows needed 8162 device px against
      // an 8192 cap, and the WebGL canvas came back at ratio 1 while the 2D link layer beside it scaled
      // correctly. The margin covers the addon's own padding and the atlas it allocates alongside.
      return Math.floor((limit * TALL_WEBGL_TEXTURE_HEADROOM) / deviceCellHeight);
    } catch (webglProbeError) {
      return 0;
    }
  },


  // Decides the two things that have to agree: how tall to make the terminal, and which renderer can
  // survive that height. They cannot be chosen independently -- asking for more rows than the GPU can
  // back does not fail loudly, it silently corrupts (see the WebGL note in ensureView) -- so this is the
  // single place that picks both.
  // Fit for the tall layout. FitAddon derives BOTH dimensions from the element it renders into, which is
  // why .term-inner had to stay a full 1000 rows tall -- and that fixed height is the entire reason the
  // scrollable area extends past the last line. Taking the row count out of the measurement frees the
  // element's height to track the content instead. Columns still come from xterm's own math (it accounts
  // for padding and scrollbar width), only the rows are overridden.
  tallFit(view) {
    if (!view || view.closed || !view.term) return;
    if (this.nativeVscodeMode) { view.fit.fit(); return; }
    // NOTE: xterm reserves ~15px for a scrollbar it never draws here (style.css hides .xterm-viewport's
    // overflow), and zeroing that reserve to reclaim the space was tried and reverted -- it yields three
    // more columns whose arithmetic fits (98 x 10.84 = 1062 inside a 1068px pane) but whose glyphs do
    // not: text was visibly clipped at the right edge in BOTH renderers. Whatever xterm withholds that
    // width for, the painted line needs it. Do not reclaim it without measuring painted glyph extent,
    // not column arithmetic.
    let dims = null;
    try { dims = view.fit.proposeDimensions(); } catch (fitError) { dims = null; }
    const rows = view.tallRows || TALL_ROWS_DOM;
    // Width can be unmeasurable -- a container that is hidden or not laid out yet reports nothing. The
    // height must still be applied in that case: returning early here left the terminal sitting at
    // xterm's construction default of 80x24, which the old fit could never do because it always set both
    // dimensions. Keep whatever width is in effect and fix the height; a later fit corrects the width.
    if (!dims || !Number.isFinite(dims.cols) || dims.cols < 2) {
      if (view.term.rows !== rows && view.term.cols >= 2) {
        view.term.resize(view.term.cols, rows);
        this.tallApplyGeometry(view);
      }
      return;
    }
    // While another window owns the size, render at ITS width rather than the one this window measures.
    // Measuring wins otherwise: the pty stays at the owner's width while xterm reflows to this window's,
    // and every line then wraps at a column the pty never used -- the corruption this whole ownership
    // rule exists to prevent, reintroduced one step later.
    const owned = view.sizeOwnedElsewhere;
    const cols = owned && owned.cols >= 2 ? owned.cols : dims.cols;
    if (view.term.cols !== cols || view.term.rows !== rows) view.term.resize(cols, rows);
    this.tallApplyGeometry(view);
  },


  // Keeps the two heights that must differ in sync: the terminal element stays its full forced height so
  // xterm renders every row, while the scrollable box is only as tall as the content. The container then
  // cannot scroll past the last line, because there is nothing past it -- no clamp, nothing to correct,
  // and the scrollbar thumb is sized to the real content.
  tallApplyGeometry(view) {
    if (!view || view.closed) return;
    const inner = view.container.querySelector(".term-inner");
    const cellHeight = view.term._core?._renderService?.dimensions?.css?.cell?.height;
    if (!inner || !cellHeight) return;
    if (view.tallWebgl) this.syncWebglCanvasToDevicePixels(view);
    const fullPx = Math.round((view.term.rows || TALL_ROWS_DOM) * cellHeight);
    if (view.term.element && view.term.element.style.height !== `${fullPx}px`) {
      view.term.element.style.height = `${fullPx}px`;
    }
    // Whole-buffer mode measures in absolute buffer rows -- scrollTop spans the scrollback too -- so the
    // content bottom counts the history above the screen, and the cap is history plus the screen. It is
    // still the CONTENT bottom, not the rendered window's: the window ends with however many hundred
    // blank rows the forced height leaves under the cursor, and a box sized to it opens a fresh session
    // as one mostly-empty page with the ceiling -- and the following view -- parked in the blank space
    // at its bottom, the real content out of sight above the fold.
    const baseRows = Number(view.term.buffer.active.baseY || 0);
    const contentPx = Math.round((baseRows + this.tallEffectiveBottomRow(view) + 1) * cellHeight);
    const capPx = Math.round(this.tallBufferRows(view) * cellHeight);
    // Never shorter than the viewport, never taller than the terminal itself.
    const desired = Math.max(view.container.clientHeight || 0, Math.min(capPx, contentPx));
    const current = view.tallInnerHeight || 0;
    let height = desired;
    if (desired < current) {
      // Shrinking is the only direction that can move the view: the browser has to pull scrollTop back
      // inside the smaller box, and that pull is exactly the jump. Measured while a composer redrew
      // itself: the content height flickered by one row 19 times in a few seconds, and the view jumped
      // up to 63px with it. Two rules make that impossible -- ignore a dip until it has held for a
      // moment, and never shrink past what the current scroll position needs to stay valid. Following
      // moves the view down to the real bottom first, which then lets the box shrink on a later pass,
      // so this converges without ever yanking anything.
      if (view.tallShrinkTarget !== desired) {
        view.tallShrinkTarget = desired;
        view.tallShrinkSince = Date.now();
      }
      const shrinkReadyAt = Math.max((view.tallShrinkSince || Date.now()) + TALL_SHRINK_SETTLE_MS,
        Number(view.codexCollapseSettleUntil || 0));
      const settled = Date.now() >= shrinkReadyAt;
      const keepScrollValid = Math.ceil(view.container.scrollTop + (view.container.clientHeight || 0));
      height = settled ? Math.max(desired, Math.min(current, keepScrollValid)) : current;
      if (!settled) this.scheduleTallGeometrySettle(view, shrinkReadyAt - Date.now());
    } else {
      view.tallShrinkTarget = null;
    }
    if (view.tallInnerHeight !== height) {
      view.tallInnerHeight = height;
      inner.style.height = `${height}px`;
    }
    this.tallPositionRenderedWindow(view, cellHeight);
  },


  // Attaching to a terminal forces it to repaint itself, permanently (formerly the attach_repaint
  // experiment). The mechanisms exist because agents paint their screens inside synchronized-update
  // frames, which the durable scrollback deliberately strips -- so after a server restart the replay can
  // lack the actual current screen, and the failure that leaves (a blank or stale pane) is worse than
  // the flicker a redundant repaint costs.
  // Repaint only if the terminal has nothing to show. Deliberately checked after the replay rather than
  // before connecting: whether anything exists to replay is only knowable once it has arrived, and a
  // server restart is exactly the case where the answer is "nothing".
  requestRepaintIfBlank(view) {
    if (!view || view.closed || !view.ws || view.ws.readyState !== WebSocket.OPEN) return false;
    // A reconnect clears the buffer before replaying it, so "empty" during that window means "not filled
    // yet", not "nothing to show". Asking then forces a redraw of content that was about to arrive
    // anyway, which is the flicker on switching to an already-loaded tab. Try again once it has landed.
    if (view.replaying || view.awaitingSnapshot) {
      clearTimeout(view.blankRepaintTimer);
      view.blankRepaintTimer = setTimeout(() => this.requestRepaintIfBlank(view), TALL_BLANK_REPAINT_MS);
      return false;
    }
    const buffer = view.term.buffer.active;
    const blankDespiteScrollback = !!this.agentBehavior(this.session(view.sessionId)?.agent_kind)?.blankRepaintDespiteScrollback;
    if (!blankDespiteScrollback && Number(buffer.baseY || 0) > 0) return false;
    const visibleLines = [];
    const start = Number(buffer.baseY || 0);
    const end = Math.min(buffer.length, start + Math.max(1, Number(view.term.rows || 1)));
    for (let row = start; row < end; row += 1) {
      const line = buffer.getLine(row)?.translateToString(true).trim() || "";
      if (line) visibleLines.push(line);
    }
    if (!blankDespiteScrollback && visibleLines.length) return false;
    if (blankDespiteScrollback && /OpenAI Codex|Ask Codex|Context \d+% used|view transcript|q to quit|Press enter to continue/i.test(
      visibleLines.join("\n"))) return false;
    view.ws.send(JSON.stringify({ type: "repaint" }));
    return true;
  },


  scheduleInitialCodexRepaintCompletion(view) {
    if (!view?.initialCodexRepaintPending) return;
    if (!view.initialCodexRepaintWatchdogTimer) {
      const remaining = Math.max(0,
        view.initialCodexRepaintStartedAt + CODEX_INITIAL_REPAINT_MAX_MS - Date.now());
      view.initialCodexRepaintWatchdogTimer = setTimeout(() => {
        view.initialCodexRepaintWatchdogTimer = 0;
        this.finishInitialCodexRepaint(view);
      }, remaining);
    }
    clearTimeout(view.initialCodexRepaintTimer);
    view.initialCodexRepaintTimer = setTimeout(() => {
      view.initialCodexRepaintTimer = 0;
      if (!view.initialCodexRepaintPending || view.closed) return;
      const stillWriting = view.outputWriteInFlight || view.outputQueue.length;
      const repaintElapsed = Date.now() - view.initialCodexRepaintStartedAt;
      if ((stillWriting || !view.initialCodexRepaintOutputSeen) && repaintElapsed < CODEX_INITIAL_REPAINT_MAX_MS) {
        this.scheduleInitialCodexRepaintCompletion(view);
        return;
      }
      this.finishInitialCodexRepaint(view);
    }, CODEX_INITIAL_REPAINT_SETTLE_MS);
  },


  finishInitialCodexRepaint(view) {
    if (!view?.initialCodexRepaintPending || view.closed) return;
    clearTimeout(view.initialCodexRepaintTimer);
    clearTimeout(view.initialCodexRepaintWatchdogTimer);
    view.initialCodexRepaintTimer = 0;
    view.initialCodexRepaintWatchdogTimer = 0;
    view.initialCodexRepaintPending = false;
    this.refreshTerminal(view);
    // The redraw this attach asked for has stopped painting, so give the follow settle a fresh window to
    // correct whatever the last frame of it left behind (see extendAttachFollowSettle).
    this.extendAttachFollowSettle(view);
    this.finishInitialPageContentLoading(view.sessionId);
  },


  terminalPayloadContainsBytes(payload, needle) {
    if (!payload || !needle?.length || payload.length < needle.length) return false;
    for (let start = 0; start <= payload.length - needle.length; start += 1) {
      let matched = true;
      for (let offset = 0; offset < needle.length; offset += 1) {
        if (payload[start + offset] === needle[offset]) continue;
        matched = false;
        break;
      }
      if (matched) return true;
    }
    return false;
  },


  captureCodexCommandCollapseAnchor(view, following) {
    if (!following || view.tallFollowing === false || !view.container.clientHeight) return null;
    const cellHeight = view.term._core?._renderService?.dimensions?.css?.cell?.height;
    if (!cellHeight) return null;
    const buffer = view.term.buffer.active;
    const baseRows = Number(buffer.baseY || 0);
    return { cursorScreenTop: (baseRows + Number(buffer.cursorY || 0)) * cellHeight - view.container.scrollTop };
  },


  restoreCodexCommandCollapseAnchor(view, anchor) {
    if (!anchor || view.tallFollowing === false || !view.container.clientHeight) return;
    const cellHeight = view.term._core?._renderService?.dimensions?.css?.cell?.height;
    if (!cellHeight) return;
    const buffer = view.term.buffer.active;
    const baseRows = Number(buffer.baseY || 0);
    const cursorTop = (baseRows + Number(buffer.cursorY || 0)) * cellHeight;
    const nextTop = Math.max(0, cursorTop - anchor.cursorScreenTop);
    const bottomPx = (baseRows + this.tallEffectiveBottomRow(view) + 1) * cellHeight;
    const boundRows = Number(buffer.length || 0);
    const hardMax = Math.max(0, boundRows * cellHeight - view.container.clientHeight);
    view.tallMaxScrollTop = Math.min(hardMax, Math.max(0, bottomPx - view.container.clientHeight));
    view.tallCeilingShrinkSince = null;
    view.tallFollowTop = nextTop;
    this.tallSetScrollTop(view, nextTop);
    this.tallSyncBufferToScroll(view);
  },


  // A status-bar line is not enough on its own: the status text is rewritten constantly by other
  // activity, so the warning was gone before it could be read -- which is why opening a second window at
  // a different width appeared to warn about nothing. Marking the resync control keeps it visible for as
  // long as the condition lasts, and points at the thing that resolves it.
  updateSizeOwnershipIndicator(view) {
    const owned = view && !view.closed ? view.sizeOwnedElsewhere : null;
    const active = !!owned && this.activeId === view.sessionId;
    for (const buttonId of ["terminal-resync-btn", "vscode-terminal-resync-btn"]) {
      const button = this.$(buttonId);
      if (!button) continue;
      button.classList.toggle("size-owned-elsewhere", active);
      if (this.historyOpen) {
        button.title = "Refresh transcript";
        button.setAttribute("aria-label", button.title);
      } else if (active) {
        button.title = `Another window is using this terminal at ${owned.cols} columns. Click to resize it to this window.`;
        button.setAttribute("aria-label", button.title);
      } else {
        button.title = "Resync terminal content";
        button.setAttribute("aria-label", button.title);
      }
    }
    if (active) {
      this.$("status-name").textContent = `${owned.cols} cols — another window owns this terminal's size`;
    }
  },



    // Off by default, and a reload is needed either way: the row count is fixed when a view is built, and
  // the renderer is chosen to match it. Turning it ON trades canvas height for GPU rendering -- the GPU
  // can only back MAX_TEXTURE_SIZE / (cellHeight * dpr) rows, measured at 309 on this machine against
  // 1000 for DOM, so the scrollable canvas drops from ~25 screens to ~8 and the scrollback bridge starts
  // moving the buffer viewport that much sooner. Search, selection and how far back you can reach are
  // unaffected: they read the 20,000-line buffer, not the rendered rows.
  tallWebglEnabled() {
    return this.standardTallWebglEnabled();
  },


  standardTallWebglEnabled() {
    return this.browserBooleanSetting(BROWSER_TALL_WEBGL_KEY, true);
  },


  deferInactiveTerminalOutputEnabled() {
    return DEFER_INACTIVE_TERMINAL_OUTPUT;
  },


  // Rows of history the scroll box spans. Everything above the rendered window plus the window itself.
  // The scroll box spanning the whole buffer (formerly the scroll_whole_buffer experiment) is the only
  // layout: scrollTop is an absolute buffer offset, the rendered rows are positioned inside the box, so
  // the scrollbar thumb means what it looks like it means and the canvas row count stops governing how
  // far you can scroll -- which is also what puts WebGL and a long history on speaking terms.
  tallBufferRows(view) {
    const buffer = view.term.buffer.active;
    return Math.max(view.term.rows || 0, Number(buffer.baseY || 0) + (view.term.rows || 0));
  },


  // Puts the rendered window where the scroll position says it should be. xterm always draws the same
  // `rows` rows; this slides that block down the tall box so the row under the reader is the row the
  // scrollbar is pointing at.
  tallPositionRenderedWindow(view, cellHeight) {
    const element = view.term.element;
    if (!element) return;
    const offset = Math.round(Number(view.term.buffer.active.viewportY || 0) * cellHeight);
    if (element.style.position !== "absolute") {
      element.style.position = "absolute";
      element.style.left = "0";
      element.style.right = "0";
    }
    const wanted = `${offset}px`;
    if (element.style.top !== wanted) element.style.top = wanted;
  },


  // Maps a scroll position onto the buffer: the top of the box is row 0, the bottom is the newest line.
  // Only the rendered window has to move, and only when the wanted row leaves it.
  tallSyncBufferToScroll(view) {
    if (!view || view.closed) return;
    const cellHeight = view.term._core?._renderService?.dimensions?.css?.cell?.height;
    if (!cellHeight) return;
    const buffer = view.term.buffer.active;
    const wantedRow = Math.max(0, Math.min(Number(buffer.baseY || 0),
      Math.floor(view.container.scrollTop / cellHeight)));
    const current = Number(buffer.viewportY || 0);
    if (wantedRow !== current) view.term.scrollLines(wantedRow - current);
    this.tallPositionRenderedWindow(view, cellHeight);
  },


  tallRowPlan(cellHeight) {
    if (!this.tallWebglEnabled()) return { rows: TALL_ROWS_DOM, webgl: false };
    const safeRows = this.maxWebglSafeRows(cellHeight);
    if (safeRows < TALL_ROWS_MIN_FOR_WEBGL) return { rows: TALL_ROWS_DOM, webgl: false };
    return { rows: Math.min(TALL_ROWS_MAX, safeRows), webgl: true };
  },


  enableWebglRenderer(term) {
    const Addon = window.WebglAddon?.WebglAddon;
    if (!Addon) return false;
    try {
      const addon = new Addon();
      addon.onContextLoss(() => {
        try { addon.dispose(); } catch (disposeError) { /* already gone; DOM renderer takes over */ }
      });
      term.loadAddon(addon);
      return true;
    } catch (webglError) {
      return false;
    }
  },



  // The addon sizes its canvas when it loads and again on a terminal resize, but this layout changes the
  // terminal element's height directly rather than through one, so the canvas can be left holding the
  // size it was born with. Measured at dpr 2.5: the render service had device canvas 2781x6943 and the
  // canvas element was still 2777x2777 -- a backing store at 1x stretched across a 2.5x box, which reads
  // as text that is too large, soft, and running off the right edge. The correct numbers are already
  // computed; this just applies them.

  syncWebglCanvasToDevicePixels(view) {
    const term = view.term;
    const dimensions = term._core?._renderService?.dimensions;
    const canvas = term.element?.querySelector("canvas:not(.xterm-link-layer)");
    // Taken from xterm's own dimensions rather than recomputed here. Two attempts to derive it from
    // cols x deviceCell have now been reverted, and the second one is worth recording precisely:
    // dimensions.device.cell is ALREADY in device pixels (measured: css 13.5 -> device 27 at dpr 2), so
    // multiplying by devicePixelRatio again doubles it. That produced a 5184x21216 canvas where xterm
    // wanted 2592x10608 -- past MAX_TEXTURE_SIZE and far past the ~11500px where this GPU silently stops
    // drawing, i.e. the blank-new-terminal bug. It was aimed at right-edge truncation, which cannot be
    // this code in any case: that happens in DOM mode too, where no canvas exists.
    const wanted = dimensions?.device?.canvas;
    if (!canvas || !wanted?.width || !wanted?.height) return;
    const styleWidth = `${dimensions.css.canvas.width}px`;
    const styleHeight = `${dimensions.css.canvas.height}px`;
    const restyled = canvas.style.width !== styleWidth || canvas.style.height !== styleHeight;
    if (restyled) {
      canvas.style.width = styleWidth;
      canvas.style.height = styleHeight;
    }
    const resized = canvas.width !== wanted.width || canvas.height !== wanted.height;
    if (resized) {
      canvas.width = wanted.width;
      canvas.height = wanted.height;
    }
    if (resized || restyled) term.refresh(0, Math.max(0, term.rows - 1));
  },



  buildTerminalIconSettingsRow() {
    const rows = document.createDocumentFragment();
    const heading = document.createElement("div");
    heading.className = "settings-row terminal-icon-settings-row";
    const label = document.createElement("span");
    label.className = "settings-label";
    label.textContent = "Show terminal icons";
    heading.appendChild(label);
    rows.appendChild(heading);
    const row = document.createElement("div");
    row.className = "settings-row terminal-icon-agent-row";
    const controls = document.createElement("span");
    controls.className = "settings-controls terminal-icon-settings-controls";
    const buttons = new Map();
    const updateButtons = () => {
      for (const [kind, button] of buttons) {
        const enabled = this.terminalIconEnabledForAgent(kind);
        const labelText = this.agentLabel(kind, "Shell");
        const iconSvg = this.agentSpec(kind)?.icon_svg || '<span class="codicon codicon-terminal"></span>';
        button.innerHTML = `<span class="terminal-icon-toggle-glyph" aria-hidden="true">${iconSvg}</span><span>${labelText}</span>`;
        button.classList.toggle("on", enabled);
        button.setAttribute("aria-pressed", String(enabled));
        button.title = `${labelText} terminal icons: ${enabled ? "on" : "off"}`;
        button.setAttribute("aria-label", button.title);
      }
    };
    // Registry-driven like the create dialog: agents first, shell last.
    const specs = Object.values(this.agentSpecs);
    const iconKinds = [...specs.filter((spec) => spec.is_agent), ...specs.filter((spec) => !spec.is_agent)]
      .map((spec) => spec.kind);
    for (const kind of iconKinds) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "theme-toggle terminal-icon-agent-toggle";
      button.title = `${this.agentLabel(kind, "Shell")} terminal icon`;
      button.setAttribute("aria-label", button.title);
      button.onclick = () => {
        this.setTerminalIconEnabledForAgent(kind, !this.terminalIconEnabledForAgent(kind));
        updateButtons();
        this.applySettings();
        this.saveSettings();
        this.renderList();
      };
      buttons.set(kind, button);
      controls.appendChild(button);
    }
    updateButtons();
    row.appendChild(controls);
    rows.appendChild(row);
    return rows;
  },


  normalizeUiScale(value) {
    return Math.max(0.8, Math.min(1.4, Math.round((Number(value) || 1) * 20) / 20));
  },


  initResizer(handleId, key, fromRight, minWidth, maxWidth) {
    this.$(handleId).onmousedown = (e) => {
      e.preventDefault();
      document.body.classList.add("dragging");
      if (handleId === "sidebar-resizer") {
        this.sidebarResizeInProgress = true;
        if (this.sidebarResizeFinalFitFrame) {
          cancelAnimationFrame(this.sidebarResizeFinalFitFrame);
          this.sidebarResizeFinalFitFrame = 0;
        }
      }
      const move = (ev) => {
        const width = fromRight ? window.innerWidth - ev.clientX : ev.clientX;
        const resizingFiles = handleId === "sidebar-resizer" && FILES_SIDE_PANEL_TABS.includes(this.sideView);
        const targetKey = resizingFiles ? "files_panel_width" : key;
        const targetMin = resizingFiles ? Math.max(minWidth, FILES_PANEL_MIN_WIDTH) : minWidth;
        const targetMax = resizingFiles ? Math.max(maxWidth, Math.floor(window.innerWidth * 0.75)) : maxWidth;
        this.settings[targetKey] = Math.max(targetMin, Math.min(targetMax, Math.round(width)));
        this.applySettings({ fitTerminals: false });
      };
      const up = () => {
        document.body.classList.remove("dragging");
        if (handleId === "sidebar-resizer") this.sidebarResizeInProgress = false;
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        this.applySettings({ fitTerminals: false });
        if (handleId === "sidebar-resizer") this.scheduleFinalTerminalFitAfterSidebarResize();
        this.saveSettings();
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    };
  },


  async reloadTree(rootOverride) {
    const s = this.session(this.activeId);
    this.treeRoot = rootOverride || (s ? s.cwd : (this.worktreeRoot() || "~"));
    this.connectFileTreeWatch(this.treeRoot);
    this.treeDirs.clear();
    this.expandedDirs = new Set(this.treeSearchFilter?.expandedDirs || []);
    this.recentFiles = [];
    this.recentFilesRoot = null;
    this.recentFilesFingerprint = "";
    this.recentFilesFetchedAt = 0;
    this.recentFilesExpanded = false;
    const tree = this.$("files-tree");
    tree.textContent = "";
    await this.renderDirInto(tree, "");
    this.updateRecentFilesWatch();
    this.refreshRecentFiles(true);
  },


  async fetchDirEntries(relPath) {
    const res = await fetch(`/api/files/list?root=${encodeURIComponent(this.treeRoot)}&path=${encodeURIComponent(relPath)}`);
    return res.ok ? await res.json() : null;
  },


  sortTreeEntries(entries) {
    const sorted = [...entries];
    const recent = this.settings.file_tree_sort === "mtime";
    sorted.sort((left, right) => {
      if (recent) {
        const mtimeOrder = Number(right.mtime || 0) - Number(left.mtime || 0);
        if (mtimeOrder) return mtimeOrder;
      } else {
        const directoryOrder = Number(right.is_dir) - Number(left.is_dir);
        if (directoryOrder) return directoryOrder;
      }
      return String(left.name || "").localeCompare(String(right.name || ""), undefined,
        { numeric: true, sensitivity: "base" });
    });
    return sorted;
  },


  treeEntryCache(entries) {
    return JSON.stringify(this.sortTreeEntries(entries));
  },


  treeRowMetadataKey(entry) {
    return `${entry.mtime || 0}|${String(entry.git_status || "").toUpperCase()}`;
  },


  filePatternRegex(pattern) {
    const value = String(pattern || "").trim();
    if (!value) return null;
    const source = value.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    try {
      return new RegExp(`^${source}$`, "i");
    } catch (_error) {
      return null;
    }
  },


  filePathMatchesPattern(relativePath, pattern) {
    const normalizedPath = String(relativePath || "").replaceAll("\\", "/");
    const basename = normalizedPath.split("/").pop() || normalizedPath;
    let value = String(pattern || "").trim();
    if (!value) return false;
    if (value === ".*" || value === "**/.*") return normalizedPath.split("/").some((part) => part.startsWith("."));
    if (value.startsWith(".")) value = `*${value}`;
    const matcher = this.filePatternRegex(value);
    return !!matcher && (matcher.test(normalizedPath) || matcher.test(basename));
  },


  filePathMatchesExcludedPattern(relativePath) {
    return this.fileTypeFilterTokens().some((token) => this.filePathMatchesPattern(relativePath, token.replace(/^!/, "")));
  },


  filePathMatchesIncludedPattern(relativePath, mode) {
    const patterns = this.splitFileGlobTokens(this.fileIncludeGlob(mode));
    return !patterns.length || patterns.some((pattern) => this.filePathMatchesPattern(relativePath, pattern));
  },


  async renderDirInto(container, relPath, entries) {
    if (entries === undefined) entries = await this.fetchDirEntries(relPath);
    if (entries === null) return;
    entries = this.sortTreeEntries(entries);
    this.treeDirs.set(relPath, { container, cache: JSON.stringify(entries) });
    container.textContent = "";
    for (const entry of entries) {
      const excluded = entry.is_dir && this.isExcludedName(entry.name);
      const hiddenDotFolder = entry.is_dir && this.settings.hide_dot_folders !== false && this.isDotFolderName(entry.name);
      if (hiddenDotFolder || (excluded && this.settings.hide_excluded)) continue;
      const childRel = relPath ? `${relPath}/${entry.name}` : entry.name;
      if (!entry.is_dir && (this.filePathMatchesExcludedPattern(childRel) || !this.filePathMatchesIncludedPattern(childRel, "tree"))) continue;
      if (!this.treeFilterAllows(childRel, entry.is_dir)) continue;
      const row = TermDeckFileBrowser.createTreeEntryRow({ root: this.treeRoot, relativePath: relPath, entry, excluded,
        showMtime: this.settings.show_mtime, showGitStatus: this.settings.show_git_status !== false,
        fileIcon: (name) => this.fileTypeIconEl(name, "tree-type-icon"),
        onDirectory: (directoryRow, path) => void this.toggleDir(directoryRow, path),
        onFile: (event, fileRow, path) => void this.openFile(this.treeRoot, path, null, fileRow, { preview: true, fromFilePanel: true }),
        onDoubleClick: (fileRow, path) => void this.openFile(this.treeRoot, path, null, fileRow, { pinned: true, fromFilePanel: true }),
        onAuxClick: (event, fileRow, path) => this.handleFileDeckAuxClick(event, this.treeRoot, path),
        onContextMenu: (event, fileRow) => this.openTreeContextMenu(event, fileRow),
      });
      if (!entry.is_dir) row.title = `${row.title || childRel}\nMiddle-click opens in a new TermDeck tab`;
      row.dataset.metadata = this.treeRowMetadataKey(entry);
      container.appendChild(row);
      if (entry.is_dir && this.expandedDirs.has(childRel)) await this.expandDirRow(row, childRel);
    }
  },


  appendMtime(row, entry) {
    if (!this.settings.show_mtime || !entry.mtime) return;
    const mtimeEl = document.createElement("span");
    mtimeEl.className = "tree-mtime";
    mtimeEl.textContent = this.formatMtime(entry.mtime);
    mtimeEl.title = `modified ${this.exactMtime(entry.mtime)}`;
    row.appendChild(mtimeEl);
  },


  appendGitStatus(row, entry) {
    if (this.settings.show_git_status === false || !entry.git_status) return;
    const gitStatus = this.gitStatusPresentation(entry.git_status);
    if (!gitStatus) return;
    row.dataset.gitStatus = gitStatus.code;
    row.classList.add("git-row", `git-row-${gitStatus.statusClass}`);
    row.title = `${row.title ? `${row.title}\n` : ""}git: ${gitStatus.label}`;
  },


  gitStatusPresentation(rawStatus) {
    const code = String(rawStatus || "").trim().toUpperCase();
    if (!code) return null;
    const labels = { "?": "untracked", "M": "modified", "A": "added", "D": "deleted",
      "R": "renamed", "C": "copied", "U": "conflicted" };
    return { code, statusClass: code === "?" ? "untracked" : code.toLowerCase(), label: labels[code] || code };
  },


  async refreshOpenFileGitStatuses(root = "", refresh = false) {
    const roots = [...new Set([...this.openFiles.values()].map((entry) => entry.root).filter((entryRoot) => !root || entryRoot === root))];
    let changed = false;
    await Promise.all(roots.map(async (entryRoot) => {
      const params = new URLSearchParams({ root: entryRoot });
      if (refresh) params.set("refresh", "true");
      let response;
      try {
        response = await fetch(`/api/files/git-status?${params}`);
      } catch (error) {
        return;
      }
      if (!response.ok) return;
      const statuses = await response.json();
      for (const entry of this.openFiles.values()) {
        if (entry.root !== entryRoot) continue;
        const nextStatus = String(statuses[entry.path] || "");
        if (entry.git_status === nextStatus) continue;
        entry.git_status = nextStatus;
        changed = true;
      }
    }));
    if (!changed) return;
    this.persistOpenFiles();
    this.renderFileTabs();
  },


  formatMtime(epochSeconds) {
    return TermDeckFileBrowser.formatMtime(epochSeconds);
  },


  exactMtime(epochSeconds) {
    const date = new Date(epochSeconds * 1000);
    return `${date.toLocaleString()} (${date.toISOString()})`;
  },


  async expandDirRow(row, relPath) {
    row.classList.add("open");
      row.querySelector(".tree-folder-icon").src = FOLDER_ICON_OPEN;
    const wrap = document.createElement("div");
    wrap.className = "tree-children-wrap";
    row.after(wrap);
    await this.renderDirInto(wrap, relPath);
  },


  dropTreeDirsUnder(relPath) {
    for (const key of [...this.treeDirs.keys()]) {
      if (key === relPath || key.startsWith(relPath + "/")) this.treeDirs.delete(key);
    }
  },


  async toggleDir(row, relPath) {
    const next = row.nextSibling;
    if (next && next.classList && next.classList.contains("tree-children-wrap")) {
      next.remove();
      row.classList.remove("open");
      row.querySelector(".tree-folder-icon").src = FOLDER_ICON_CLOSED;
      this.expandedDirs.delete(relPath);
      this.dropTreeDirsUnder(relPath);
      return;
    }
    this.expandedDirs.add(relPath);
    await this.expandDirRow(row, relPath);
  },


  connectFileTreeWatch(root) {
    if (this.vscodeMode || !root) return;
    if (this.treeWs && this.treeWsRoot === root &&
        (this.treeWs.readyState === WebSocket.CONNECTING || this.treeWs.readyState === WebSocket.OPEN)) return;
    this.disconnectFileTreeWatch();
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}${FILE_TREE_WS_ROUTE}?root=${encodeURIComponent(root)}`);
    this.treeWs = socket;
    this.treeWsRoot = root;
    socket.onmessage = (event) => {
      if (this.treeWs !== socket) return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch (error) {
        if (error instanceof SyntaxError) return;
        throw error;
      }
      if (message.type === FILE_TREE_CHANGED) this.queueFileTreeRefresh(message.changes);
    };
    socket.onclose = () => {
      if (this.treeWs !== socket) return;
      this.treeWs = null;
      this.treeWsRoot = "";
      if (this.sideView !== "project" && this.sideView !== "search") return;
      clearTimeout(this.treeWsReconnectTimer);
      this.treeWsReconnectTimer = setTimeout(() => {
        this.treeWsReconnectTimer = 0;
        if (this.sideView === "project" || this.sideView === "search") this.connectFileTreeWatch(this.treeRoot);
      }, 5000);
    };
  },


  disconnectFileTreeWatch() {
    clearTimeout(this.treeWsReconnectTimer);
    this.treeWsReconnectTimer = 0;
    clearTimeout(this.treeEventRefreshTimer);
    this.treeEventRefreshTimer = 0;
    this.treeChangedDirectories.clear();
    this.treeChangedEntries.clear();
    const socket = this.treeWs;
    this.treeWs = null;
    this.treeWsRoot = "";
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
  },


  queueFileTreeRefresh(changes) {
    if (!Array.isArray(changes)) return;
    for (const change of changes) {
      if (!change || typeof change.path !== "string") continue;
      const operation = String(change.operation || "");
      const parent = typeof change.parent === "string" ? change.parent : "";
      if (this.isExcludedPath(parent) || (operation === "modified" && this.isExcludedPath(change.path))) continue;
      if (operation === "modified" && change.is_directory) continue;
      if (operation === "modified" && !change.is_directory) {
        this.treeChangedEntries.set(change.path, change);
        if (!this.treeRowForPath(change.path) && this.treeDirs.has(parent)) this.treeChangedDirectories.add(parent);
      } else {
        this.treeChangedDirectories.add(parent);
        if (change.is_directory && operation === "deleted") {
          this.expandedDirs.delete(change.path);
          this.dropTreeDirsUnder(change.path);
        }
      }
    }
    if (!this.treeChangedDirectories.size && !this.treeChangedEntries.size) return;
    clearTimeout(this.treeEventRefreshTimer);
    this.treeEventRefreshTimer = setTimeout(() => {
      this.treeEventRefreshTimer = 0;
      void this.refreshChangedFileTreeEvents();
    }, 120);
  },


  async refreshChangedFileTreeEvents() {
    if (this.treePollBusy) {
      clearTimeout(this.treeEventRefreshTimer);
      this.treeEventRefreshTimer = setTimeout(() => {
        this.treeEventRefreshTimer = 0;
        void this.refreshChangedFileTreeEvents();
      }, 120);
      return;
    }
    const directories = [...this.treeChangedDirectories];
    const entries = [...this.treeChangedEntries.values()];
    this.treeChangedDirectories.clear();
    this.treeChangedEntries.clear();
    const openDirectories = directories.filter((directory) => this.treeDirs.has(directory));
    if (openDirectories.length) await this.refreshTreeDirectories(openDirectories);
    const openEntryChanges = entries.filter((change) => !openDirectories.includes(change.parent) && this.treeRowForPath(change.path));
    if (openEntryChanges.length) await this.refreshChangedFileTreeEntries(openEntryChanges);
    await this.refreshOpenFilesFromDisk(entries);
    this.queueRecentFilesEventRefresh();
    if (this.shouldRefreshActiveFileSearch(entries)) await this.refreshActiveFileSearch();
  },


  async refreshOpenFilesFromDisk(changes) {
    if (!Array.isArray(changes) || !changes.length) return;
    const changedKeys = new Set(changes
      .filter((change) => change && ["modified", "created"].includes(change.operation) && !change.is_directory && typeof change.path === "string")
      .map((change) => `${this.treeRoot}|${change.path}`));
    if (!changedKeys.size) return;
    for (const [key, entry] of this.openFiles) {
      if (!changedKeys.has(key)) continue;
      if (!entry.model || entry.dirty) {
        await this.observeExternalFileHistory(entry);
        continue;
      }
      await this.refreshFileModelFromDisk(entry);
    }
  },


  async observeExternalFileHistory(entry) {
    const res = await fetch(`/api/files/read?root=${encodeURIComponent(entry.root)}&path=${encodeURIComponent(entry.path)}`);
    if (!res.ok) return;
    await res.json();
    if (this.fileHistoryOpen && this.activeFileKey !== null && this.openFiles.get(this.activeFileKey) === entry) {
      void this.loadFileHistory();
    }
  },


  shouldRefreshActiveFileSearch(changes) {
    if (!Array.isArray(changes) || !changes.length) return false;
    const structuralChange = changes.some((change) => String(change.operation || "") !== "modified");
    if (this.sideView === "search" && this.$("search-query").value.trim()) {
      if (structuralChange) return true;
      const displayedPaths = this.contentSearchTree?.paths;
      return changes.some((change) => displayedPaths?.has(change.path));
    }
    return this.sideView === "project" && this.$("search-name").value.trim() && structuralChange;
  },


  async refreshActiveFileSearch() {
    if (this.sideView === "search" && this.$("search-query").value.trim()) {
      await this.runSearch(null, true);
      return;
    }
    if (this.sideView === "project" && this.$("search-name").value.trim()) await this.runNameSearch();
  },


  treeRowForPath(relPath) {
    return [...this.$("files-tree").querySelectorAll(".tree-row")].find((row) => row.dataset.rel === relPath) || null;
  },


  async refreshChangedFileTreeEntries(changes) {
    if (this.settings.show_mtime === false && this.settings.show_git_status === false) return;
    const entriesByParent = new Map();
    for (const change of changes) {
      if (!entriesByParent.has(change.parent)) entriesByParent.set(change.parent, await this.fetchDirEntries(change.parent));
    }
    for (const change of changes) {
      const entries = entriesByParent.get(change.parent);
      if (!entries) continue;
      const name = change.path.slice(change.parent ? change.parent.length + 1 : 0);
      const entry = entries.find((candidate) => candidate.name === name);
      const row = this.treeRowForPath(change.path);
      if (!row) continue;
      if (!entry) {
        this.treeChangedDirectories.add(change.parent);
        continue;
      }
      this.updateTreeRowMetadata(row, entry);
    }
    const missingParents = [...this.treeChangedDirectories].filter((directory) => this.treeDirs.has(directory));
    this.treeChangedDirectories.clear();
    if (missingParents.length) await this.refreshTreeDirectories(missingParents);
  },


  updateTreeRowMetadata(row, entry) {
    const metadataKey = this.treeRowMetadataKey(entry);
    if (row.dataset.metadata === metadataKey) return;
    row.dataset.metadata = metadataKey;
    row.querySelector(".tree-mtime")?.remove();
    for (const className of [...row.classList]) {
      if (className === "git-row" || className.startsWith("git-row-")) row.classList.remove(className);
    }
    delete row.dataset.gitStatus;
    row.title = `${this.treeRoot}/${row.dataset.rel}`;
    this.appendMtime(row, entry);
    this.appendGitStatus(row, entry);
    const openEntry = this.openFiles.get(`${this.treeRoot}|${row.dataset.rel}`);
    if (openEntry && openEntry.git_status !== String(entry.git_status || "")) {
      openEntry.git_status = String(entry.git_status || "");
      this.persistOpenFiles();
      this.renderFileTabs();
    }
  },


  async refreshTreeDirectories(directoryPaths = null) {
    if (this.treePollBusy || this.treeRoot === null || this.$("files-section").classList.contains("hidden")) return;
    this.treePollBusy = true;
    const scrollPosition = this.captureTreeScrollPosition();
    const selectedPath = this.selectedTreeRow?.dataset?.rel || "";
    let changed = false;
    const paths = directoryPaths === null ? [...this.treeDirs.keys()] : [...new Set(directoryPaths)];
    try {
      for (const relPath of paths) {
        const info = this.treeDirs.get(relPath);
        if (!info || this.treeDirs.get(relPath) !== info) continue;
        const entries = await this.fetchDirEntries(relPath);
        if (entries === null || this.treeEntryCache(entries) === info.cache) continue;
        changed = true;
        await this.renderDirInto(info.container, relPath, entries);
      }
    } finally {
      this.treePollBusy = false;
      if (changed) {
        const selectedRow = selectedPath ? this.treeRowForPath(selectedPath) : null;
        this.markTreeSelection(selectedRow);
        this.restoreTreeScrollPosition(scrollPosition);
        requestAnimationFrame(() => this.restoreTreeScrollPosition(scrollPosition));
      }
    }
  },


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
      else this.openFile(this.treeRoot, rel, null, current, { preview: true, fromFilePanel: true });
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
  },


  markTreeSelection(row) {
    if (this.selectedTreeRow) this.selectedTreeRow.classList.remove("selected");
    this.selectedTreeRow = row || null;
    if (row) row.classList.add("selected");
  },


  persistOpenFiles() {
    const groups = {};
    for (const entry of this.openFiles.values()) {
      const key = this.owningProjectKey(entry.root);
      (groups[key] = groups[key] || []).push({ root: entry.root, path: entry.path,
        mtime: String(Math.max(0, Number(entry.mtime) || 0)), git_status: String(entry.git_status || "") });
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
    const projectKeys = this.projectSlug ? [this.projectStateKey()]
      : [...new Set([...Object.keys(states), ...Object.keys(groups)])];
    const updates = projectKeys.map((projectKey) => ({ projectKey, openFiles: [...(states[projectKey]?.open_files || [])] }));
    this.openFilesPersistPromise = this.openFilesPersistPromise.then(async () => {
      for (const update of updates) {
        const params = this.projectStateSearchParams(update.projectKey);
        const response = await fetch(`/api/project-state/open_files?${params}`, { method: "PUT", keepalive: true,
          headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: update.openFiles }) });
        if (!response.ok) throw new Error(`server returned ${response.status}`);
      }
    }).catch((error) => { this.$("stat-text").textContent = `Could not persist open files: ${error.message}`; });
  },


  async openFile(root, path, line, treeRow, options = {}) {
    const key = `${root}|${path}`;
    if (!this.openFiles.has(key)) {
      this.openFiles.set(key, { root, path, name: path.split("/").pop(), model: null, fullPath: null,
        truncated: false, preview: !!options.preview && !options.pinned, mtime: 0,
        git_status: String(treeRow?.dataset.gitStatus || "") });
    } else {
      const entry = this.openFiles.get(key);
      if (options.pinned) entry.preview = false;
      this.openFiles.delete(key);
      this.openFiles.set(key, entry);
    }
    this.enforceOpenFilesLimit();
    this.persistOpenFiles();
    this.markTreeSelection(treeRow || null);
    const returnTo = typeof options.returnTo === "string" ? options.returnTo.trim() : "";
    await this.activateFile(key, line, { returnTo, history: options.history, view: options.view,
      revealInTree: options.revealInTree !== false && !treeRow });
    if (options.fromFilePanel && this.activeFileKey === key && this.openFiles.get(key)?.model) {
      this.collapseMobileSidebarAfterSelection();
    }
    void this.refreshOpenFileGitStatuses(root);
  },


  saveActiveFileViewState() {
    if (this.activeFileKey === null || !this.editor) return;
    const entry = this.openFiles.get(this.activeFileKey);
    if (!entry?.model || this.editor.getModel() !== entry.model) return;
    entry.viewState = this.editor.saveViewState();
  },


  positionPopover(pop, anchor) {
    const rect = anchor.getBoundingClientRect();
    pop.classList.remove("hidden");
    const below = rect.bottom + 6;
    const top = below + pop.offsetHeight > window.innerHeight - 8 ? rect.top - pop.offsetHeight - 6 : below;
    pop.style.top = Math.max(8, top) + "px";
    pop.style.left = Math.min(rect.left, window.innerWidth - pop.offsetWidth - 12) + "px";
  },


  buildRemoteAccessRow() {
    const row = document.createElement("div");
    row.className = "settings-row remote-access-settings-row";
    const heading = document.createElement("span");
    heading.className = "remote-access-heading";
    const label = document.createElement("span");
    label.className = "settings-label";
    label.textContent = "Remote access";
    const status = document.createElement("span");
    status.className = "remote-access-status";
    status.textContent = "checking…";
    const accessUrl = document.createElement("a");
    accessUrl.className = "remote-access-url hidden";
    accessUrl.target = "_blank";
    accessUrl.rel = "noopener";
    heading.append(label, status, accessUrl);
    const controls = document.createElement("span");
    controls.className = "settings-controls";
    const open = document.createElement("button");
    open.type = "button";
    open.className = "remote-access-open hidden";
    open.textContent = "↗";
    open.title = "Open TermDeck Remote";
    const action = document.createElement("button");
    action.type = "button";
    action.className = "remote-access-action";
    action.textContent = "Sign in";
    controls.append(open, action);
    row.append(heading, controls);
    row.remoteAccessElements = { status, accessUrl, open, action };
    action.onclick = () => this.handleRemoteAccessAction(row);
    open.onclick = () => {
      const relayUrl = row.dataset.relayUrl;
      if (relayUrl) window.open(relayUrl, "_blank", "noopener");
    };
    void this.refreshRemoteAccessRow(row);
    return row;
  },


  async refreshRemoteAccessRow(row) {
    if (!row) return;
    const { status, accessUrl, open, action } = row.remoteAccessElements;
    try {
      const response = await fetch("/api/remote/status");
      if (!response.ok) throw new Error(`remote status failed (${response.status})`);
      const remote = await response.json();
      if (!row.isConnected) return;
      row.dataset.remoteState = remote.state;
      row.dataset.relayUrl = remote.public_url || remote.relay_url || "";
      row.dataset.loginUrl = remote.login_url || "";
      const showAccessUrl = !!row.dataset.relayUrl && !!(remote.email || this.remoteBrowserEmail);
      accessUrl.href = showAccessUrl ? row.dataset.relayUrl : "";
      accessUrl.textContent = showAccessUrl ? row.dataset.relayUrl : "";
      accessUrl.title = showAccessUrl ? `Open ${row.dataset.relayUrl}` : "";
      accessUrl.classList.toggle("hidden", !showAccessUrl);
      const labels = {
        disconnected: "off",
        pairing: "finish Google sign-in",
        ready: remote.email ? `${remote.email} · ready` : "ready",
        connected: remote.email ? `${remote.email} · connected` : "connected",
        error: remote.error || "connection failed",
      };
      status.textContent = labels[remote.state] || remote.state;
      status.title = remote.error || remote.relay_url || "";
      open.classList.toggle("hidden", !!this.remoteBrowserEmail || !showAccessUrl);
      action.textContent = this.remoteBrowserEmail ? "Log out" :
        ["connected", "ready"].includes(remote.state) ? "Disconnect" :
          remote.state === "pairing" ? "Open login" : "Sign in";
      if (remote.state === "pairing") {
        clearTimeout(row.remoteStatusTimer);
        row.remoteStatusTimer = setTimeout(() => this.refreshRemoteAccessRow(row), 1800);
      }
    } catch (error) {
      status.textContent = "unavailable";
      status.title = error instanceof Error ? error.message : String(error);
      accessUrl.classList.add("hidden");
      action.textContent = "Retry";
    }
  },


  async handleRemoteAccessAction(row) {
    if (this.remoteBrowserEmail) {
      await this.logoutRemoteBrowser(row.remoteAccessElements.action);
      return;
    }
    const state = row.dataset.remoteState || "disconnected";
    if (["connected", "ready"].includes(state)) {
      if (!await uiConfirm("Disconnect this computer from TermDeck Remote?")) return;
      const response = await fetch("/api/remote/disconnect", { method: "POST" });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        void uiAlert(payload.detail || `remote disconnect failed (${response.status})`);
      }
      await this.refreshRemoteAccessRow(row);
      return;
    }
    if (state === "pairing" && row.dataset.loginUrl) {
      window.open(row.dataset.loginUrl, "_blank", "noopener");
      return;
    }
    const loginWindow = window.open("about:blank", "termdeck-remote-login");
    try {
      const response = await fetch("/api/remote/pair", { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || `remote pairing failed (${response.status})`);
      if (payload.login_url && loginWindow) loginWindow.location.replace(payload.login_url);
      else if (payload.login_url) window.open(payload.login_url, "_blank", "noopener");
      await this.refreshRemoteAccessRow(row);
    } catch (error) {
      if (loginWindow) loginWindow.close();
      void uiAlert(error instanceof Error ? error.message : String(error));
      await this.refreshRemoteAccessRow(row);
    }
  },


  buildLanAccessRow() {
    const row = document.createElement("div");
    row.className = "settings-row lan-access-settings-row";
    const heading = document.createElement("span");
    heading.className = "lan-access-heading";
    const label = document.createElement("span");
    label.className = "settings-label";
    label.textContent = "Local Wi-Fi";
    const status = document.createElement("span");
    status.className = "lan-access-status";
    status.textContent = "checking…";
    const accessUrl = document.createElement("a");
    accessUrl.className = "lan-access-url hidden";
    accessUrl.target = "_blank";
    accessUrl.rel = "noopener";
    heading.append(label, status, accessUrl);
    const controls = document.createElement("span");
    controls.className = "settings-controls";
    const open = document.createElement("button");
    open.type = "button";
    open.className = "lan-access-open hidden";
    open.textContent = "↗";
    open.title = "Open over local Wi-Fi";
    const action = document.createElement("button");
    action.type = "button";
    action.className = "lan-access-action";
    action.textContent = "Enable";
    controls.append(open, action);
    row.append(heading, controls);
    row.lanAccessElements = { status, accessUrl, open, action };
    action.onclick = () => this.handleLanAccessAction(row);
    open.onclick = () => {
      const url = row.dataset.accessUrl;
      if (url) window.open(url, "_blank", "noopener");
    };
    void this.refreshLanAccessRow(row);
    return row;
  },


  async refreshLanAccessRow(row) {
    if (!row) return;
    const { status, accessUrl, open, action } = row.lanAccessElements;
    try {
      const response = await fetch("/api/lan/status");
      const lan = await response.json();
      if (!response.ok) throw new Error(lan.detail || `local Wi-Fi status failed (${response.status})`);
      if (!row.isConnected) return;
      const enabled = !!lan.enabled;
      const running = !!lan.running;
      const baseUrl = Array.isArray(lan.urls) ? String(lan.urls[0] || "") : "";
      const pageUrl = baseUrl ? new URL(`${location.pathname}${location.search}${location.hash}`, `${baseUrl}/`).href : "";
      row.dataset.enabled = enabled ? "1" : "0";
      row.dataset.accessUrl = pageUrl;
      this.settings.lan_access_enabled = enabled;
      this.persistedSettings.lan_access_enabled = enabled;
      status.textContent = enabled ? running ? "on · same network only" : lan.error || "not listening" : "off";
      status.title = lan.error || (Array.isArray(lan.networks) ? lan.networks.join("\n") : "");
      accessUrl.href = enabled && running ? pageUrl : "";
      accessUrl.textContent = enabled && running ? baseUrl : "";
      accessUrl.title = enabled && running ? `Open ${pageUrl}` : "";
      accessUrl.classList.toggle("hidden", !enabled || !running || !pageUrl);
      open.classList.toggle("hidden", !enabled || !running || !pageUrl);
      action.textContent = enabled ? "Disable" : "Enable";
    } catch (error) {
      status.textContent = "unavailable";
      status.title = error instanceof Error ? error.message : String(error);
      accessUrl.classList.add("hidden");
      open.classList.add("hidden");
      action.textContent = "Retry";
    }
  },


  async handleLanAccessAction(row) {
    const enabled = row.dataset.enabled === "1";
    const message = enabled
      ? "Disable local Wi-Fi access? A page currently using the Wi-Fi address will disconnect."
      : "Anyone on your current local Wi-Fi network will be able to control terminals and access files without signing in. Enable local Wi-Fi access?";
    if (!await uiConfirm(message)) return;
    const action = row.lanAccessElements.action;
    action.disabled = true;
    try {
      const response = await fetch("/api/lan/access", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !enabled }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || `local Wi-Fi update failed (${response.status})`);
      row.dataset.enabled = payload.enabled ? "1" : "0";
      this.settings.lan_access_enabled = !!payload.enabled;
      this.persistedSettings.lan_access_enabled = !!payload.enabled;
      await this.refreshLanAccessRow(row);
    } catch (error) {
      void uiAlert(error instanceof Error ? error.message : String(error));
      await this.refreshLanAccessRow(row);
    } finally {
      action.disabled = false;
    }
  },


  async activateFile(key, line, options = {}) {
    const entry = this.openFiles.get(key);
    if (!entry) return;
    const activeFileChanged = this.activeFileKey !== key;
    if (this.fileHistoryOpen && !options.preserveFileHistory) {
      this.fileHistoryOpen = false;
      this.fileHistorySidebarVisible = false;
      this.syncFileHistorySurface();
    }
    // An explicitly requested panel wins even when a files tab is already showing. The nav state below
    // records whichever tab ends up active, and navUrl routes on that -- so without this, a file opened
    // while the git tab happened to be up was recorded as a git-view state and the address became /g/,
    // whatever the file had to do with git.
    if (!this.vscodeMode) {
      const requested = FILES_SIDE_PANEL_TABS.includes(options.view) ? options.view : "";
      if (requested) {
        this.setSideView(requested, false);
      } else if (!FILES_SIDE_PANEL_TABS.includes(this.sideView)) {
        const fallback = FILES_SIDE_PANEL_TABS.includes(this.lastFilesSidePanelTab)
          ? this.lastFilesSidePanelTab : "project";
        this.setSideView(fallback, false);
      }
    }
    this.closeTerminalFind();
    this.closePromptHistory();
    if (this.activeFileKey === null && this.historyOpen && this.activeId) {
      this.rememberHistoryScrollPosition(this.activeId);
    }
    if (this.activeFileKey !== key) this.saveActiveFileViewState();
    if (activeFileChanged && this.fileBlameActiveKey) this.clearFileBlameAnnotations();
    if (activeFileChanged) this.clearActiveFileGitHunks();
    this.activeFileKey = key;
    if (options.history !== false && !this.vscodeMode) {
      const requestedReturnTo = typeof options.returnTo === "string" ? options.returnTo.trim() : "";
      const activeSessionId = String(this.activeId || requestedReturnTo || "");
      const current = this.parseNavState(this.lastNavJson);
      const fallback = activeSessionId || (current?.kind === "term" ? String(current.id || "") : "");
      const fallbackFromFile = current?.kind === "file" ? String(current.return_to || "") : "";
      const returnTo = (this.session(fallback) ? fallback : fallbackFromFile && this.session(fallbackFromFile) ? fallbackFromFile : "");
      const fromCurrentFile = current?.kind === "file" && String(current.return_to || "") === returnTo;
      const fromFileMode = ["files", "file", "open-file", "file-history", "file-history-path"].includes(current?.kind);
      const fileState = { kind: "file", key, view: this.sideView };
      if (returnTo && !fromCurrentFile && !fromFileMode) {
        const returnState = { kind: "term", id: returnTo };
        const historyScroll = this.historyScrollBySession.get(returnTo);
        if (historyScroll) returnState.history_scroll = historyScroll;
        if (current?.kind === "term" && String(current.id || "") === returnTo) this.replaceNav(returnState);
        else this.pushNav(returnState);
      }
      if (returnTo) {
        this.pushNav({ ...fileState, return_to: returnTo });
      } else {
        this.pushNav(fileState);
      }
    }
    else if (options.history !== false) this.replaceNav({ kind: "file", key, view: this.sideView });
    this.applyMainLayout();
    this.renderList();
    this.renderTopbar();
    await this.monacoReady;
    if (!entry.model || !entry.dirty) {
      const loaded = await this.refreshFileModelFromDisk(entry);
      if (!loaded && !entry.model) return;
    }
    if (this.activeFileKey !== key) return;
    this.editor.setModel(entry.model);
    void this.lspClient?.activate(entry, entry.model);
    if (line) {
      this.editor.revealLineInCenter(line);
      this.editor.setPosition({ lineNumber: line, column: 1 });
    } else if (entry.viewState) this.editor.restoreViewState(entry.viewState);
    this.editor.focus();
    void this.loadActiveFileGitHunks();
    this.renderList();
    this.renderTopbar();
    if (this.fileInspectorMode) this.refreshFileInspector();
    void this.renderSecondaryEditor(true);
    if (activeFileChanged && options.revealInTree !== false && this.sideView === "project") {
      await this.revealActiveFile({ switchToProject: false, switchExplorerMode: false });
    }
    if (options.fromOpenFiles) {
      requestAnimationFrame(() => this.$("session-list").querySelector(".file-item.active")?.scrollIntoView({ block: "nearest" }));
    }
  },


  navigateBackFromActiveFile() {
    if (this.activeFileKey === null) return false;
    const current = this.parseNavState(this.lastNavJson);
    if (current?.kind === "file" && current.return_to && this.session(current.return_to)) {
      history.back();
      return true;
    }
    const activeId = this.activeId;
    if (this.fileHistoryOpen) this.deactivateFileHistoryTab();
    this.saveActiveFileViewState();
    this.lspClient?.deactivate();
    this.clearActiveFileGitHunks();
    this.activeFileKey = null;
    this.applyMainLayout();
    this.renderList();
    this.renderTopbar();
    if (activeId && this.session(activeId)) {
      this.replaceNav({ kind: "term", id: activeId });
      requestAnimationFrame(() => this.focusActiveEditor());
    } else {
      this.replaceNav({ kind: "init" });
    }
    return true;
  },


  async refreshFileModelFromDisk(entry) {
    const res = await fetch(`/api/files/read?root=${encodeURIComponent(entry.root)}&path=${encodeURIComponent(entry.path)}`);
    if (!res.ok) {
      if (!entry.model) {
        const err = await res.json().catch(() => ({}));
        this.$("stat-text").textContent = err.detail || `${entry.path} — cannot open`;
      }
      return false;
    }
    const data = await res.json();
    entry.fullPath = data.path;
    entry.truncated = data.truncated;
    const previousMtime = Number(entry.mtime) || 0;
    entry.mtime = Number(data.mtime) || 0;
    if (entry.mtime !== previousMtime) this.persistOpenFiles();
    if (this.settings.file_tab_order === "modified") this.renderFileTabs();
    if (!entry.model) {
      const uri = monaco.Uri.file(data.path);
      const existing = monaco.editor.getModel(uri);
      if (existing) existing.dispose();
      entry.model = monaco.editor.createModel(data.content, undefined, uri);
      entry.model.onDidChangeContent(() => {
        if (entry.applyingDiskContent) return;
        if (this.fileBlameActiveKey === `${entry.root}|${entry.path}`) this.clearFileBlameAnnotations();
        const becameDirty = !entry.dirty;
        entry.dirty = true;
        entry.preview = false;
        this.scheduleFileAutosave(entry);
        if (becameDirty) this.renderFileEditorChrome();
        if (this.fileInspectorMode === "outline" && this.activeFileKey !== null && this.openFiles.get(this.activeFileKey) === entry) {
          clearTimeout(this.fileOutlineTimer);
          this.fileOutlineTimer = setTimeout(() => this.renderFileOutline(), 240);
        }
        this.scheduleProblemsRefresh();
        if (this.fileHistoryOpen && this.activeFileKey !== null && this.openFiles.get(this.activeFileKey) === entry) {
          clearTimeout(this.fileHistoryComparisonTimer);
          this.fileHistoryComparisonTimer = setTimeout(() => {
            this.fileHistoryComparisonTimer = 0;
            this.refreshFileHistoryDiffNavigation();
          }, 250);
        }
      });
      return true;
    }
    if (entry.dirty || entry.model.getValue() === data.content) return false;
    if (this.fileBlameActiveKey === `${entry.root}|${entry.path}`) this.clearFileBlameAnnotations();
    entry.applyingDiskContent = true;
    try {
      entry.model.setValue(data.content);
    } finally {
      entry.applyingDiskContent = false;
    }
    if (this.fileHistoryOpen && this.activeFileKey !== null && this.openFiles.get(this.activeFileKey) === entry) {
      void this.loadFileHistory();
    }
    return true;
  },


  scheduleFileAutosave(entry) {
    clearTimeout(entry.autosaveTimer);
    entry.autosaveTimer = setTimeout(() => {
      entry.autosaveTimer = 0;
      void this.saveFileEntry(entry, false);
    }, FILE_AUTOSAVE_DELAY_MS);
  },


  flushPendingFileSavesOnPageExit() {
    clearTimeout(this.exitFileSaveResetTimer);
    for (const entry of this.openFiles.values()) {
      if (!entry.model || (!entry.dirty && !entry.savePromise)) continue;
      const versionId = entry.model.getVersionId();
      if (entry.exitSaveVersionId === versionId) continue;
      entry.exitSaveVersionId = versionId;
      const body = JSON.stringify({ root: entry.root, path: entry.path, content: entry.model.getValue() });
      const queued = typeof navigator.sendBeacon === "function" &&
        navigator.sendBeacon("/api/files/write", new Blob([body], { type: "application/json" }));
      if (!queued) {
        void fetch("/api/files/write", { method: "POST", keepalive: true,
          headers: { "Content-Type": "application/json" }, body }).catch(() => {});
      }
    }
    this.exitFileSaveResetTimer = setTimeout(() => {
      for (const entry of this.openFiles.values()) delete entry.exitSaveVersionId;
    }, 2000);
  },


  async saveFileEntry(entry, showFailureAlert) {
    if (!entry?.model) return false;
    clearTimeout(entry.autosaveTimer);
    entry.autosaveTimer = 0;
    if (entry.savePromise) {
      const previousSaveSucceeded = await entry.savePromise;
      if (!entry.dirty || !previousSaveSucceeded) return previousSaveSucceeded;
    }
    const model = entry.model;
    const versionId = model.getVersionId();
    const content = model.getValue();
    const savePromise = (async () => {
      try {
        const response = await fetch("/api/files/write", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ root: entry.root, path: entry.path, content }),
        });
        if (!response.ok) {
          const error = await response.json().catch(() => ({}));
          const message = error.detail || "autosave failed";
          this.$("stat-text").textContent = message;
          if (showFailureAlert) void uiAlert(message);
          return false;
        }
        if (entry.model === model && model.getVersionId() === versionId) {
          entry.dirty = false;
          entry.mtime = Math.floor(Date.now() / 1000);
          this.persistOpenFiles();
          this.renderFileEditorChrome();
          void this.refreshOpenFileGitStatuses(entry.root, true);
          if (this.activeFileKey === `${entry.root}|${entry.path}`) this.scheduleActiveFileGitHunkRefresh();
        } else if (entry.model && !entry.autosaveTimer) {
          this.scheduleFileAutosave(entry);
        }
        if (this.fileHistoryOpen && this.activeFileKey !== null && this.openFiles.get(this.activeFileKey) === entry) {
          void this.loadFileHistory();
        }
        if (this.enforceOpenFilesLimit()) this.persistOpenFiles();
        this.lspClient?.didSave(entry, model, content);
        return true;
      } catch (error) {
        const message = error.message || "autosave failed";
        this.$("stat-text").textContent = message;
        if (showFailureAlert) void uiAlert(message);
        return false;
      }
    })();
    entry.savePromise = savePromise;
    try {
      return await savePromise;
    } finally {
      if (entry.savePromise === savePromise) entry.savePromise = null;
    }
  },


  async saveActiveFile() {
    const entry = this.activeFileKey !== null ? this.openFiles.get(this.activeFileKey) : null;
    if (entry) await this.saveFileEntry(entry, true);
  },


  async saveOpenFilesForLsp(root) {
    for (const entry of this.openFiles.values()) {
      if (entry.root !== root) continue;
      if (!entry.dirty && !entry.savePromise) continue;
      if (!await this.saveFileEntry(entry, true)) return false;
    }
    return true;
  },


  async refreshFilesChangedByLsp(changedFiles, root) {
    const changedPaths = new Set(changedFiles.map((file) => String(file.path || "")));
    for (const entry of this.openFiles.values()) {
      if (entry.root !== root || !changedPaths.has(entry.path)) continue;
      entry.dirty = false;
      await this.refreshFileModelFromDisk(entry);
    }
    this.renderList();
    this.renderTopbar();
    this.scheduleProblemsRefresh();
    requestAnimationFrame(() => this.editor?.focus());
  },


  async closeFile(key, options = {}) {
    await this.closeFiles([key], options);
  },


  async closeFiles(keys, options = {}) {
    const entries = [...new Set(keys)].map((key) => [key, this.openFiles.get(key)]).filter(([, entry]) => !!entry);
    if (!entries.length) return;
    const closableKeys = [];
    for (const [key, entry] of entries) {
      if (!options.discard && (entry.dirty || entry.savePromise)) {
        const saved = await this.saveFileEntry(entry, true);
        if (!saved || this.openFiles.get(key) !== entry) continue;
      }
      closableKeys.push(key);
    }
    if (!closableKeys.length) return;
    const activeClosed = closableKeys.includes(this.activeFileKey);
    if (activeClosed) this.clearActiveFileGitHunks();
    if (this.fileHistoryTabKey !== null && closableKeys.includes(this.fileHistoryTabKey)) this.closeFileHistory(false);
    for (const key of closableKeys) {
      const entry = this.openFiles.get(key);
      if (entry) this.closeOpenFileEntry(key, entry);
    }
    this.persistOpenFiles();
    if (activeClosed) {
      const remaining = [...this.openFiles.keys()];
      if (remaining.length) {
        const nextKey = remaining[remaining.length - 1];
        await this.activateFile(nextKey, null, { history: false });
        this.replaceNav({ kind: "file", key: nextKey, view: this.sideView });
        this.saveSettings();
        return;
      }
      this.lspClient?.deactivate();
      this.activeFileKey = null;
      this.setSideView("terminals", false);
      this.applyMainLayout();
      const view = this.views.get(this.activeId);
      if (view) view.term.focus();
      this.replaceNav(this.activeId ? { kind: "term", id: this.activeId } : { kind: "init" });
    }
    this.renderList();
    this.renderTopbar();
    this.saveSettings();
  },


  closeActiveItem() {
    if (this.activeFileKey !== null) void this.closeFile(this.activeFileKey);
    else this.closeActive();
  },


  terminalPathBoundaryContinues(leftText, rightText) {
    const left = String(leftText || "").replace(/\s+$/, "");
    const right = String(rightText || "").replace(/^\s+/, "");
    if (!left || !right) return false;
    // A hard column wrap can land the path separator on either side of the break: "trainer/" then
    // "prep.py", but just as often "zscripts" then "/probe.py", or a base name then its own ".py".
    // Only the first shape was recognized before, so a directory name ending a wrapped row (with
    // no trailing slash) silently dropped its own prefix when the file link was opened.
    if (/[\\/._-]$/.test(left) && /^[\w@%+=.-]+(?:[\\/._-]|:\d)/.test(right)) return true;
    if (/[\w@%+=-]$/.test(left) && /^[\\/][\w@%+=.-]*\.[A-Za-z]/.test(right)) return true;
    if (/[\w@%+=-]$/.test(left) && /^\.[A-Za-z][A-Za-z0-9]{0,7}(?::\d+){0,2}\b/.test(right)) return true;
    return false;
  },


  providePathLinks(term, sessionId, bufferLineNumber, callback) {
    const buffer = term.buffer.active;
    const targetIndex = bufferLineNumber - 1;
    if (!buffer.getLine(targetIndex)) { callback(undefined); return; }

    let firstIndex = targetIndex;
    while (firstIndex > 0) {
      const current = buffer.getLine(firstIndex);
      const previous = buffer.getLine(firstIndex - 1);
      if (current?.isWrapped || this.terminalPathBoundaryContinues(
        previous?.translateToString(true), current?.translateToString(true))) firstIndex -= 1;
      else break;
    }
    const segments = [];
    let nextIndex = firstIndex;
    let logicalOffset = 0;
    while (nextIndex < buffer.length) {
      const line = buffer.getLine(nextIndex);
      if (!line) break;
      const text = line.translateToString(true);
      segments.push({ index: nextIndex, text, logicalStart: logicalOffset });
      logicalOffset += text.length;
      const nextLine = buffer.getLine(nextIndex + 1);
      if (!nextLine || (!nextLine.isWrapped && !this.terminalPathBoundaryContinues(
        text, nextLine.translateToString(true)))) break;
      nextIndex += 1;
    }
    const logicalText = segments.map((segment) => segment.text).join("");
    const links = [];
    for (const segment of segments) {
      const segmentStart = segment.logicalStart;
      const segmentEnd = segmentStart + segment.text.length;
      if (segment.index === targetIndex && segment.text.length) {
        for (const match of logicalText.matchAll(PATH_LINK_RE)) {
          const raw = match[0];
          const matchStart = match.index;
          const matchEnd = matchStart + raw.length;
          const ext = raw.split(":")[0].split(".").pop().toLowerCase();
          if (!raw.includes("/") && !KNOWN_EXTS.has(ext)) continue;
          if (matchStart >= segmentEnd || matchEnd <= segmentStart) continue;
          const start = Math.max(matchStart, segmentStart) - segmentStart;
          const end = Math.min(matchEnd, segmentEnd) - segmentStart;
          if (end <= start) continue;
          links.push({
            range: { start: { x: start + 1, y: bufferLineNumber }, end: { x: end, y: bufferLineNumber } },
            text: raw,
            activate: (event, linkText) => this.activateTerminalFileLink(event, sessionId, linkText || raw),
          });
        }
      }
    }
    if (!links.length) {
      const collapsedChars = [];
      const logicalCharStarts = [];
      for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
        const segment = segments[segmentIndex];
        const previousText = segmentIndex > 0 ? segments[segmentIndex - 1].text : "";
        const rightText = String(segment.text || "");
        const trimStart = this.terminalPathBoundaryContinues(previousText, rightText) ? (rightText.match(/^\s*/)?.[0]?.length ?? 0) : 0;
        for (let charIndex = trimStart; charIndex < segment.text.length; charIndex += 1) {
          collapsedChars.push(segment.text[charIndex]);
          logicalCharStarts.push(segment.logicalStart + charIndex);
        }
      }
      const collapsedText = collapsedChars.join("");
      for (const segment of segments) {
        const segmentStart = segment.logicalStart;
        const segmentEnd = segmentStart + segment.text.length;
        if (segment.index === targetIndex && segment.text.length) {
          for (const match of collapsedText.matchAll(PATH_LINK_RE)) {
            const raw = match[0];
            const matchStart = match.index;
            const matchEnd = matchStart + raw.length;
            const logicalMatchStart = logicalCharStarts[matchStart];
            if (typeof logicalMatchStart !== "number") continue;
            const logicalMatchEnd = logicalCharStarts[matchEnd] ?? logicalText.length;
            const ext = raw.split(":")[0].split(".").pop().toLowerCase();
            if (!raw.includes("/") && !KNOWN_EXTS.has(ext)) continue;
            if (logicalMatchStart >= segmentEnd || logicalMatchEnd <= segmentStart) continue;
            const start = Math.max(logicalMatchStart, segmentStart) - segmentStart;
            const end = Math.min(logicalMatchEnd, segmentEnd) - segmentStart;
            if (end <= start) continue;
            links.push({
              range: { start: { x: start + 1, y: bufferLineNumber }, end: { x: end, y: bufferLineNumber } },
              text: raw,
              activate: (event, linkText) => this.activateTerminalFileLink(event, sessionId, linkText || raw),
            });
          }
        }
      }
    }
    callback(links.length ? links : undefined);
  },


  parseVscodeFileLink(linkText) {
    let value = String(linkText || "").trim().replace(/\s+/g, "");
    if (!value || /^(?:https?|mailto|data|javascript):/i.test(value)) return null;
    let line = null;
    let column = null;
    let match = value.match(/#L(\d+)(?:-L\d+)?$/i);
    if (match) {
      line = Number(match[1]);
      value = value.slice(0, match.index);
    } else {
      match = value.match(/:(\d+)(?::(\d+))?$/);
      if (match) {
        line = Number(match[1]);
        column = match[2] ? Number(match[2]) : null;
        value = value.slice(0, match.index);
      }
    }
    if (/^file:\/\//i.test(value)) {
      try { value = decodeURIComponent(new URL(value).pathname); } catch (_error) { return null; }
    }
    value = value.replace(/[),.;]+$/, "");
    const fileName = value.split("/").pop() || "";
    const extension = fileName.includes(".") ? fileName.split(".").pop().toLowerCase() : "";
    if (!value || (!value.includes("/") && !KNOWN_EXTS.has(extension))) return null;
    return { path: value, line, column };
  },


  postVscodeFileOpen(path, line, column, cwd) {
    if (!this.vscodeMode || window.parent === window) return false;
    window.parent.postMessage({ type: "termdeck-open-file", path, line, column, cwd }, "*");
    return true;
  },


  requestVscodeRefresh(hard = false) {
    if (!this.vscodeMode) return;
    if (window.parent !== window) {
      window.parent.postMessage({ type: "termdeck-refresh", hard: !!hard }, "*");
      return;
    }
    location.reload();
  },


  postVscodeNativeSession(session, visible) {
    if (!this.nativeVscodeMode || window.parent === window || !session) return;
    window.parent.postMessage({
      type: "termdeck-native-session",
      session: { session_id: session.session_id, title: this.titlePresentation(session).text, cwd: session.cwd },
      ...(typeof visible === "boolean" ? { visible } : {}),
    }, "*");
  },


  postVscodeNativeClose(sessionId) {
    if (!this.nativeVscodeMode || window.parent === window || !sessionId) return;
    window.parent.postMessage({ type: "termdeck-native-close", session_id: sessionId }, "*");
  },


  handleHistoryFileLink(event) {
    const anchor = event.target.closest?.("a");
    if (!anchor) return;
    const linkText = anchor.dataset.terminalFile || anchor.getAttribute("href") || "";
    if (!this.parseVscodeFileLink(linkText)) return;
    if (event.button !== 0 || event.ctrlKey) return;
    event.preventDefault();
    event.stopPropagation();
    this.openFileFromLink(this.activeId, linkText);
  },


  openDetectedFileLinkExternally(fileLink) {
    const parsed = this.parseVscodeFileLink(fileLink?.linkText);
    if (!parsed) return false;
    const session = this.session(fileLink.sessionId);
    void this.openFileExternally(session?.cwd || this.worktreeRoot() || "~", parsed.path);
    return true;
  },


  handleDetectedFileLinkAuxClick(event) {
    if (event.button !== 1) return;
    const source = event.target.closest?.(".xterm, #history-body");
    if (!source) return;
    const fileLink = this.fileLinkAtContextEvent(event, source);
    if (!fileLink || !this.openDetectedFileLinkExternally(fileLink)) return;
    event.preventDefault();
    event.stopPropagation();
  },


  activateTerminalFileLink(event, sessionId, linkText) {
    if (event?.button === 1) {
      this.openDetectedFileLinkExternally({ sessionId, linkText });
      return;
    }
    if (event?.button !== 0 || event?.ctrlKey) return;
    this.openFileFromLink(sessionId, linkText);
  },


  fileLinkAtContextEvent(event, source) {
    if (source.id === "history-body") {
      const anchor = event.target.closest?.("a[data-terminal-file]");
      const linkText = anchor?.dataset.terminalFile || "";
      return this.parseVscodeFileLink(linkText) ? { sessionId: this.activeId, linkText } : null;
    }
    if (!source.matches(".xterm")) return null;
    const view = [...this.views.values()].find((candidate) => candidate.term.element === source);
    if (!view) return null;
    const screenElement = view.term._core?.screenElement;
    const mouseService = view.term._core?._mouseService;
    const coordinates = screenElement && mouseService
      ? mouseService.getCoords(event, screenElement, view.term.cols, view.term.rows) : null;
    if (!coordinates) return null;
    const point = { x: coordinates[0], y: coordinates[1] + view.term.buffer.active.viewportY };
    const currentLink = view.term._core?.linkifier?.currentLink?.link;
    if (currentLink && this.terminalLinkRangeContainsPoint(currentLink.range, point) &&
        this.parseVscodeFileLink(currentLink.text)) {
      return { sessionId: view.sessionId, linkText: currentLink.text };
    }
    let links = [];
    this.providePathLinks(view.term, view.sessionId, point.y, (providedLinks) => { links = providedLinks || []; });
    const pathLink = links.find((link) => this.terminalLinkRangeContainsPoint(link.range, point) &&
      this.parseVscodeFileLink(link.text));
    return pathLink ? { sessionId: view.sessionId, linkText: pathLink.text } : null;
  },


  terminalLinkRangeContainsPoint(range, point) {
    if (!range || point.y < range.start.y || point.y > range.end.y) return false;
    if (point.y === range.start.y && point.x < range.start.x) return false;
    if (point.y === range.end.y && point.x > range.end.x) return false;
    return true;
  },


  openFileLinkContextMenu(event, fileLink) {
    const parsed = this.parseVscodeFileLink(fileLink.linkText);
    if (!parsed) return;
    event.preventDefault();
    event.stopPropagation();
    const session = this.session(fileLink.sessionId);
    const root = session?.cwd || this.worktreeRoot() || "~";
    const menu = this.$("context-menu");
    menu.textContent = "";
    this.contextMenuTarget = { type: "file-link", sessionId: fileLink.sessionId, linkText: fileLink.linkText };
    this.addContextItem(menu, "Open", () => this.openFileFromLink(fileLink.sessionId, fileLink.linkText), "go-to-file");
    this.addOpenFileExternallyContextItem(menu, root, parsed.path);
    this.positionContextMenu(menu, event.clientX, event.clientY);
  },


  openFileFromLink(sessionId, linkText) {
    const parsed = this.parseVscodeFileLink(linkText);
    if (!parsed) return;
    const s = this.session(sessionId);
    const returnTo = String(sessionId || "").trim();
    if (this.vscodeMode) {
      this.postVscodeFileOpen(parsed.path, parsed.line, parsed.column, s ? s.cwd : "~");
      return;
    }
    // A path printed by a terminal is a file to read, not a diff: name the file view so it opens under
    // /f/ rather than inheriting /g/ from whichever side tab was last used.
    this.openFile(s ? s.cwd : "~", parsed.path, parsed.line, null, { returnTo, view: "project" });
  },


  sessionSuggestionEntries() {
    const entries = [];
    const seen = new Set();
    const addEntry = (value, label) => {
      const normalized = String(value || "").trim();
      if (!normalized) return;
      const key = normalized.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      entries.push({ value: normalized, label });
    };
    const sessions = [...this.sessions, ...this.closedSessions];
    for (const session of sessions) {
      if (!session) continue;
      addEntry(session.session_id, session.session_id ? "session id" : "");
      if (session.title) addEntry(session.title, `title: ${session.title}`);
      if (session.cli_title) addEntry(session.cli_title, `agent title: ${session.cli_title}`);
    }
    return entries;
  },


  updateModalSessionSuggestions() {
    const datalist = this.$("modal-session-refs");
    if (!datalist) return;
    datalist.textContent = "";
    const entries = this.sessionSuggestionEntries().sort((left, right) => {
      const leftLabel = String(left.value).toLowerCase();
      const rightLabel = String(right.value).toLowerCase();
      return leftLabel < rightLabel ? -1 : leftLabel > rightLabel ? 1 : 0;
    });
    for (const item of entries) {
      const option = document.createElement("option");
      option.value = item.value;
      if (item.label) option.label = item.label;
      datalist.appendChild(option);
    }
  },


  resolveSessionNameAndReference(model, rawValue) {
    const modelValue = String(model || "").trim().toLowerCase();
    const value = String(rawValue || "").trim();
    if (!value || !this.agentSpecs[modelValue]?.accepts_session_ref) {
      return { title: value, session_ref: "" };
    }
    const needle = value.toLowerCase();
    const matches = [];
    for (const session of [...this.sessions, ...this.closedSessions]) {
      if (!session) continue;
      const sessionId = String(session.session_id || "").trim();
      const title = String(session.title || "").trim();
      const cliTitle = String(session.cli_title || "").trim();
      if (sessionId && sessionId.toLowerCase() === needle) matches.push(sessionId);
      if (title && title.toLowerCase() === needle) matches.push(sessionId);
      if (cliTitle && cliTitle.toLowerCase() === needle) matches.push(sessionId);
    }
    const unique = [...new Set(matches)];
    if (unique.length === 1 && unique[0]) {
      return { title: "", session_ref: unique[0] };
    }
    return { title: value, session_ref: "" };
  },


  clearModalError() {
    const error = this.$("modal-error");
    const install = this.$("modal-error-install");
    if (error) error.classList.add("hidden");
    if (install) {
      install.classList.add("hidden");
      install.disabled = false;
      install.onclick = null;
    }
  },


  showModalDependencyError(detail) {
    const error = this.$("modal-error");
    const message = this.$("modal-error-message");
    const install = this.$("modal-error-install");
    if (!error || !message || !install) return;
    const command = String(detail?.install_command || "").trim();
    message.textContent = `${detail?.message || "The selected agent is unavailable."}${command ? ` Run ${command} in a new terminal to install it.` : ""}`;
    error.classList.remove("hidden");
    if (!command) return;
    install.classList.remove("hidden");
    install.onclick = () => void this.openModelInstallTerminal(detail);
  },


  async openModelInstallTerminal(detail) {
    const install = this.$("modal-error-install");
    const command = String(detail?.install_command || "").trim();
    if (!command || install?.disabled) return;
    if (install) install.disabled = true;
    const cwd = this.$("modal-cwd").value.trim() || this.resolveVscodeDefaultCwd();
    let project = this.projectForCwd(cwd)?.name || "";
    try {
      if (cwd) {
        const projectResponse = await fetch("/api/projects", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ root: cwd }),
        });
        const projectPayload = await projectResponse.json().catch(() => ({}));
        if (!projectResponse.ok) throw new Error(projectPayload.detail || "failed to register project folder");
        project = projectPayload.name || project;
      }
      const response = await fetch("/api/sessions", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command, cwd, title: `Install ${detail.display_name || detail.program}`, project,
          after: this.activeId ? `session:${this.activeId}` : null }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof payload.detail === "string" ? payload.detail : "failed to open install terminal");
      const created = payload;
      this.closeModal();
      if (!this.vscodeMode && created.project && created.project !== (this.projectSlug || "")) {
        location.href = `/p/${encodeURIComponent(created.project)}`;
        return;
      }
      await this.refresh();
      this.activate(created.session_id, { reveal: true });
    } catch (error) {
      this.showModalDependencyError({ ...detail, message: error.message || "failed to open install terminal" });
    } finally {
      if (install) install.disabled = false;
    }
  },


  // The dialog's model list comes from the served agent registry, so a newly registered
  // AgentCli appears here without touching index.html. Agents first, shell last.
  populateModalModelOptions() {
    const select = this.$("modal-model");
    const specs = Object.values(this.agentSpecs);
    const ordered = [...specs.filter((spec) => spec.is_agent), ...specs.filter((spec) => !spec.is_agent)];
    if (!ordered.length) return;
    const previous = select.value;
    select.textContent = "";
    for (const spec of ordered) {
      const option = document.createElement("option");
      option.value = spec.kind;
      option.textContent = spec.label || spec.kind;
      select.appendChild(option);
    }
    if (ordered.some((spec) => spec.kind === previous)) select.value = previous;
  },

  openModal(groupId = null, afterSessionId = null, initialAgentText = "", options = {}) {
    this.pendingNewAgentSelection = this.normalizeSelectionText(initialAgentText);
    this.pendingNewAgentSelectionUseHistory = options.useHistoryComposer === true;
    this.modalGroupId = !this.vscodeMode && groupId && this.terminalGroups().some((group) => group.id === groupId)
      ? groupId : null;
    this.modalAfterSessionId = !this.modalGroupId && afterSessionId && this.session(afterSessionId) ? afterSessionId : null;
    this.populateModalModelOptions();
    const model = this.settings.last_model || DEFAULT_COMMAND;
    this.$("modal-model").value = this.agentSpecs[model] ? model : DEFAULT_COMMAND;
    this.updateModalPermissions();
    this.updateModalSessionSuggestions();
    this.$("modal-project-add-btn").classList.toggle("hidden", !!this.vscodeMode);
    this.$("modal-session-title").value = "";
    this.$("modal-cwd").value = this.resolveVscodeDefaultCwd();
    this.$("modal-cwd").dataset.projectSeeded = "0";
    this.clearModalError();
    this.$("modal-backdrop").classList.remove("hidden");
    this.$("modal-session-title").focus();
  },


  closeModal() {
    this.modalGroupId = null;
    this.modalAfterSessionId = null;
    this.pendingNewAgentSelection = "";
    this.pendingNewAgentSelectionUseHistory = false;
    this.$("modal-backdrop").classList.add("hidden");
  },


  updateModalPermissions() {
    const model = this.$("modal-model").value;
    const permission = this.$("modal-permission");
    permission.textContent = "";
    for (const option of this.agentPermissions(model, "codex")) {
      const el = document.createElement("option");
      el.value = option.value;
      el.textContent = option.label;
      permission.appendChild(el);
    }
    const remembered = (this.settings.last_permissions || {})[model] || "default";
    permission.value = [...permission.options].some((option) => option.value === remembered) ? remembered : "default";
    this.$("modal-permission-field").classList.toggle("hidden", this.agentPermissions(model).length <= 1);
  },


  async createSession() {
    if (this.$("modal-backdrop").classList.contains("hidden")) return;
    const createButton = this.$("modal-create");
    if (createButton.disabled) return;
    createButton.disabled = true;
    try {
      await this.createSessionFromModal();
    } finally {
      createButton.disabled = false;
    }
  },


  async createSessionFromModal() {
    const pendingAgentText = this.pendingNewAgentSelection;
    const pendingAgentTextUseHistory = this.pendingNewAgentSelectionUseHistory;
    const targetGroupId = this.modalGroupId;
    const requestedAfterSessionId = this.modalAfterSessionId;
    const model = this.$("modal-model").value;
    const permission = this.$("modal-permission").value;
    const resolved = this.resolveSessionNameAndReference(model, this.$("modal-session-title").value);
    const { title, session_ref: sessionRef } = resolved;
    const project = this.projectSlug || "";
    const cwd = this.worktreeRoot() || this.resolveVscodeDefaultCwd();
    this.settings.last_model = model;
    this.settings.last_permissions = { ...(this.settings.last_permissions || {}), [model]: permission };
    this.saveSettings();
    // Land the new terminal directly below the one in focus rather than at the end of the sidebar.
    // An explicitly chosen group already dictates placement, so it wins.
    const anchorSessionId = !targetGroupId && requestedAfterSessionId && this.session(requestedAfterSessionId)
      ? requestedAfterSessionId : !targetGroupId && this.activeId && this.session(this.activeId) ? this.activeId : null;
    const res = await fetch("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, permission, session_ref: sessionRef, cwd, title,
        project, worktree_id: this.stateWorktreeId() }),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      if (detail.detail?.code === "model_dependency_missing") this.showModalDependencyError(detail.detail);
      else void uiAlert(typeof detail.detail === "string" ? detail.detail : "failed to create session");
      return;
    }
    const created = await res.json();
    this.closeModal();
    if (!this.vscodeMode && created.project && created.project !== (this.projectSlug || "")) {
      location.href = `/p/${encodeURIComponent(created.project)}`;
      return;
    }
    if (this.nativeVscodeMode) this.postVscodeNativeSession(created, true);
    await this.refresh();
    if (targetGroupId && this.terminalGroups().some((group) => group.id === targetGroupId)) {
      const state = this.getProjectState();
      this.applyLocalProjectStatePatch({
        session_groups: { ...(state.session_groups || {}), [created.session_id]: targetGroupId },
        terminal_layout: this.terminalLayout().filter((entry) => entry !== `session:${created.session_id}`),
      });
      this.queueSessionGroupAssignments({ [created.session_id]: targetGroupId });
      this.renderList();
    } else if (anchorSessionId && this.session(anchorSessionId) && this.session(created.session_id)) {
      this.repositionSelectedSessions([created.session_id], anchorSessionId, true);
    }
    this.activate(created.session_id, { reveal: true });
    const createdSession = this.session(created.session_id) || created;
    if (pendingAgentText && pendingAgentTextUseHistory && this.sessionSupportsTranscript(createdSession)) {
      if (!this.historyOpen) this.setHistoryMode(true);
      this.appendTextToHistoryPrompt(pendingAgentText);
      this.$("status-name").textContent = "selected text added to new agent transcript composer";
    } else if (pendingAgentText) {
      this.pasteSelectionIntoNewAgentWhenReady(created.session_id, pendingAgentText, title);
    }
  },


  async openLanguageServerInstallTerminal(details) {
    const project = this.projectForCwd(details.root)?.name || this.projectSlug || "";
    const languageName = this.lspClient?.languageDisplayName(details.language) || details.language;
    const command = String(details.installHint || "").trim();
    if (!command) return;
    const response = await fetch("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command, cwd: details.root, project,
        title: details.title || `Install ${languageName} language server`,
        after: this.activeId ? `session:${this.activeId}` : null }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      this.$("status-name").textContent = error.detail || "could not open install terminal";
      return;
    }
    const session = await response.json();
    if (!this.vscodeMode && session.project && session.project !== (this.projectSlug || "")) {
      location.href = `/p/${encodeURIComponent(session.project)}?t=${encodeURIComponent(session.session_id)}`;
      return;
    }
    await this.refresh();
    this.activate(session.session_id, { reveal: true });
  },


  createShortcutSection(title) {
    const section = document.createElement("section");
    section.className = "keys-section";
    const heading = document.createElement("div");
    heading.className = "keys-section-title";
    heading.textContent = title;
    section.appendChild(heading);
    return section;
  },


  appendShortcutRow(section, shortcut, builtin = false) {
    const row = document.createElement("div");
    row.className = builtin ? "keys-row builtin" : "keys-row";
    const label = document.createElement("span");
    label.className = "keys-label";
    label.textContent = shortcut.label;
    const bind = document.createElement("button");
    bind.className = builtin ? "keys-bind builtin" : "keys-bind";
    bind.textContent = builtin ? shortcut.keys : this.bindingToDisplay(this.bindingFor(shortcut.id));
    if (builtin) {
      bind.disabled = true;
      bind.setAttribute("aria-disabled", "true");
    } else {
      bind.onclick = () => this.captureBinding(shortcut.id, bind);
    }
    row.append(label, bind);
    section.appendChild(row);
  },


  shortcutMatchesSearch(shortcut, builtin, query) {
    if (!query) return true;
    const binding = builtin ? shortcut.keys : this.bindingFor(shortcut.id);
    const aliasBindings = [String(binding).replaceAll("Meta", "Cmd").replaceAll("Alt", "Option").replaceAll("Ctrl", "Control"),
      String(binding).replaceAll("Meta", "Command")];
    const keyQuery = /(?:meta|cmd|command|ctrl|control|alt|option|shift|[⌘⌥⇧⌃+])/i.test(query);
    if (keyQuery) {
      const compactQuery = query.replace(/[\s+_-]/g, "");
      return [binding, builtin ? shortcut.keys : this.bindingToDisplay(binding), ...aliasBindings]
        .some((value) => String(value).toLowerCase().replace(/[\s+_-]/g, "").includes(compactQuery));
    }
    const searchable = [shortcut.label, shortcut.id || "", shortcut.section, binding,
      builtin ? shortcut.keys : this.bindingToDisplay(binding), ...aliasBindings].join(" ").toLowerCase();
    return query.split(/\s+/).filter(Boolean).every((term) => searchable.includes(term));
  },
});
