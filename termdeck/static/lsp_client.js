class TermdeckLspClient {
  constructor(app) {
    this.app = app;
    this.transport = new TermdeckLspTransport();
    this.conversions = new TermdeckLspConversions();
    this.supportedLanguages = new Set(["python", "javascript", "javascriptreact", "typescript", "typescriptreact", "go",
      "rust", "c", "cpp", "objective-c", "objective-cpp", "cuda-cpp", "java", "ruby", "php", "shell", "yaml",
      "json", "jsonc", "html", "css", "scss", "less"]);
    this.entry = null;
    this.model = null;
    this.uri = "";
    this.serverName = "";
    this.capabilities = {};
    this.modelSubscription = null;
    this.changeTimer = 0;
    this.pullDiagnosticsTimer = 0;
    this.pullDiagnosticsResultId = "";
    this.activationGeneration = 0;
    this.providerDisposables = [];
    this.installDetails = null;
    this.dismissedInstallLanguages = new Set();
    this.settingsStatus = [];
    this.settingsProjectRoot = "";
    this.settingsLanguageKey = "";
    this.settingsElements = null;
    this.app.$("lsp-install-open-terminal").onclick = () => void this.openInstallTerminal();
    this.app.$("lsp-install-dismiss").onclick = () => this.dismissInstallBanner();
  }

  registerProviders() {
    for (const language of this.supportedLanguages) {
      this.providerDisposables.push(monaco.languages.registerDefinitionProvider(language, {
        provideDefinition: (model, position) => this.provideDefinition(model, position),
      }));
      this.providerDisposables.push(monaco.languages.registerReferenceProvider(language, {
        provideReferences: (model, position, context) => this.provideReferences(model, position, context),
      }));
      this.providerDisposables.push(monaco.languages.registerHoverProvider(language, {
        provideHover: (model, position) => this.provideHover(model, position),
      }));
      this.providerDisposables.push(monaco.languages.registerRenameProvider(language, {
        resolveRenameLocation: (model, position) => this.resolveRenameLocation(model, position),
        provideRenameEdits: (model, position, newName) => this.provideRenameEdits(model, position, newName),
      }));
      this.providerDisposables.push(monaco.languages.registerCodeActionProvider(language, {
        provideCodeActions: (model, range, context) => this.provideCodeActions(model, range, context),
      }));
    }
    this.providerDisposables.push(monaco.editor.registerCommand("termdeck.lsp.executeCodeAction",
      (_accessor, action) => this.executeCodeAction(action)));
    if (typeof monaco.editor.registerEditorOpener === "function") {
      this.providerDisposables.push(monaco.editor.registerEditorOpener({
        openCodeEditor: (_source, resource, selection) => this.openResource(resource, selection),
      }));
    }
  }

  async activate(entry, model) {
    if (this.entry === entry && this.model === model && this.transport.available) return;
    this.deactivate();
    if (this.app.settings.lsp_enabled === false) return;
    const language = model.getLanguageId();
    if (!this.supportedLanguages.has(language)) {
      this.setStatus("", "");
      return;
    }
    const generation = ++this.activationGeneration;
    this.entry = entry;
    this.model = model;
    const openingText = model.getValue();
    this.modelSubscription = model.onDidChangeContent(() => this.scheduleDocumentChange());
    this.setStatus("LSP", "Connecting language server");
    try {
      const status = await this.transport.connect(entry.root, entry.path, language, openingText,
        (message) => this.handleEvent(message));
      if (generation !== this.activationGeneration || this.entry !== entry || this.model !== model) return;
      if (!status.available) {
        this.modelSubscription?.dispose();
        this.modelSubscription = null;
        this.setStatus("LSP unavailable", status.error || "Language server unavailable");
        this.showInstallBanner(status, entry);
        return;
      }
      this.uri = status.uri;
      this.serverName = status.server || "Language server";
      this.capabilities = status.capabilities || {};
      this.setStatus(this.serverName, `${this.serverName} connected`);
      this.schedulePullDiagnostics(0);
      if (model.getValue() !== openingText) this.transport.notify("change", model.getValue());
    } catch (error) {
      if (generation === this.activationGeneration) {
        this.modelSubscription?.dispose();
        this.modelSubscription = null;
        this.setStatus("LSP unavailable", error.message);
      }
    }
  }

  deactivate() {
    this.activationGeneration += 1;
    clearTimeout(this.changeTimer);
    clearTimeout(this.pullDiagnosticsTimer);
    this.changeTimer = 0;
    this.pullDiagnosticsTimer = 0;
    this.pullDiagnosticsResultId = "";
    this.modelSubscription?.dispose();
    this.modelSubscription = null;
    if (this.model) monaco.editor.setModelMarkers(this.model, "termdeck-lsp", []);
    this.transport.close();
    this.entry = null;
    this.model = null;
    this.uri = "";
    this.serverName = "";
    this.capabilities = {};
    this.setStatus("", "");
    this.hideInstallBanner();
  }

  languageDisplayName(language) {
    const names = { javascript: "JavaScript", javascriptreact: "JavaScript JSX", typescript: "TypeScript",
      typescriptreact: "TypeScript TSX", go: "Go", rust: "Rust", c: "C", cpp: "C++", "objective-c": "Objective-C",
      "objective-cpp": "Objective-C++", "cuda-cpp": "CUDA C++", java: "Java", ruby: "Ruby", php: "PHP",
      shell: "shell", yaml: "YAML", json: "JSON", jsonc: "JSON with comments", html: "HTML", css: "CSS",
      scss: "SCSS", less: "Less", python: "Python" };
    return names[language] || language;
  }

  showInstallBanner(status, entry) {
    const language = String(status.language || "");
    const installHint = String(status.install_hint || "").trim();
    const server = String(status.server || "Language server").trim();
    if (this.app.settings.lsp_enabled === false || status.disabled || !language || !installHint ||
        this.dismissedInstallLanguages.has(language)) return;
    this.installDetails = { language, installHint, server, root: entry.root };
    this.app.$("lsp-install-message").textContent = `${server} is not installed. Add ${this.languageDisplayName(language)} diagnostics, navigation, rename, and hover.`;
    const button = this.app.$("lsp-install-open-terminal");
    button.title = installHint;
    this.app.$("lsp-install-banner").classList.remove("hidden");
  }

  hideInstallBanner() {
    this.installDetails = null;
    this.app.$("lsp-install-banner")?.classList.add("hidden");
  }

  dismissInstallBanner() {
    if (this.installDetails?.language) this.dismissedInstallLanguages.add(this.installDetails.language);
    this.hideInstallBanner();
  }

  async openInstallTerminal() {
    const details = this.installDetails;
    if (!details) return;
    this.hideInstallBanner();
    await this.app.openLanguageServerInstallTerminal(details);
  }

  buildSettingsSection(anchor) {
    const root = document.createElement("div");
    root.className = "settings-submenu lsp-settings-submenu";
    const header = document.createElement("div");
    header.className = "settings-row settings-submenu-header";
    const label = document.createElement("span");
    label.className = "settings-label";
    label.textContent = "Language servers";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "theme-toggle settings-submenu-toggle";
    toggle.textContent = "open";
    toggle.setAttribute("aria-expanded", "false");
    const enabledToggle = document.createElement("button");
    enabledToggle.type = "button";
    enabledToggle.className = "theme-toggle lsp-settings-enabled";
    enabledToggle.setAttribute("aria-label", "Enable or disable language servers");
    const headerControls = document.createElement("span");
    headerControls.className = "lsp-settings-header-controls";
    const content = document.createElement("div");
    content.className = "settings-submenu-items lsp-settings-content";
    const projectLabel = document.createElement("label");
    projectLabel.className = "lsp-settings-field";
    const projectCaption = document.createElement("span");
    projectCaption.textContent = "Scope";
    const project = document.createElement("select");
    project.setAttribute("aria-label", "Language server project scope");
    const defaultOption = document.createElement("option");
    defaultOption.value = "";
    defaultOption.textContent = "All projects (default)";
    project.appendChild(defaultOption);
    for (const registeredProject of this.app.projects) {
      const option = document.createElement("option");
      option.value = registeredProject.root;
      option.textContent = registeredProject.name;
      option.title = registeredProject.root;
      project.appendChild(option);
    }
    const currentRoot = this.app.projectRoot() || "";
    project.value = [...project.options].some((option) => option.value === this.settingsProjectRoot)
      ? this.settingsProjectRoot : currentRoot;
    this.settingsProjectRoot = project.value;
    projectLabel.append(projectCaption, project);
    const languageLabel = document.createElement("label");
    languageLabel.className = "lsp-settings-field";
    const languageCaption = document.createElement("span");
    languageCaption.textContent = "Language";
    const language = document.createElement("select");
    language.setAttribute("aria-label", "Language server language");
    languageLabel.append(languageCaption, language);
    const status = document.createElement("div");
    status.className = "lsp-settings-status";
    status.textContent = "Select a project to inspect language servers.";
    const commandLabel = document.createElement("label");
    commandLabel.className = "lsp-settings-command-field";
    const commandCaption = document.createElement("span");
    commandCaption.textContent = "Command override";
    const command = document.createElement("input");
    command.type = "text";
    command.autocomplete = "off";
    command.spellcheck = false;
    command.setAttribute("aria-label", "Language server command override");
    commandLabel.append(commandCaption, command);
    const installRow = document.createElement("div");
    installRow.className = "lsp-settings-install-row";
    const install = document.createElement("select");
    install.setAttribute("aria-label", "Language server installation option");
    const installButton = document.createElement("button");
    installButton.type = "button";
    installButton.textContent = "install";
    const actions = document.createElement("div");
    actions.className = "lsp-settings-actions";
    const save = document.createElement("button");
    save.type = "button";
    save.textContent = "save override";
    const automatic = document.createElement("button");
    automatic.type = "button";
    automatic.textContent = "use automatic";
    installRow.append(install, installButton);
    actions.append(automatic, save);
    content.append(projectLabel, languageLabel, status, commandLabel, installRow, actions);
    headerControls.append(enabledToggle, toggle);
    header.append(label, headerControls);
    root.append(header, content);
    this.settingsElements = { root, anchor, project, language, status, command, install, installButton, save, automatic,
      enabledToggle };
    this.renderEnabledControl();
    toggle.onclick = () => {
      const expanded = root.classList.toggle("expanded");
      toggle.setAttribute("aria-expanded", String(expanded));
      this.app.$("settings-popover").classList.toggle("lsp-settings-expanded", expanded);
      if (expanded) void this.loadSettingsStatus();
      requestAnimationFrame(() => this.app.positionPopover(this.app.$("settings-popover"), anchor));
    };
    enabledToggle.onclick = () => void this.setEnabled(this.app.settings.lsp_enabled === false);
    project.onchange = () => {
      this.settingsProjectRoot = project.value;
      void this.loadSettingsStatus();
    };
    language.onchange = () => {
      this.settingsLanguageKey = language.value;
      this.renderSettingsStatus();
    };
    save.onclick = () => void this.saveSettingsOverride(command.value);
    automatic.onclick = () => void this.saveSettingsOverride("");
    installButton.onclick = () => void this.openSettingsInstallTerminal();
    command.onkeydown = (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      void this.saveSettingsOverride(command.value);
    };
    return root;
  }

  async loadSettingsStatus() {
    const elements = this.settingsElements;
    if (!elements) return;
    elements.status.textContent = "Detecting language servers…";
    const params = new URLSearchParams();
    if (elements.project.value) params.set("root", elements.project.value);
    try {
      const response = await fetch(`/api/lsp/status${params.size ? `?${params}` : ""}`);
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.detail || "could not load language servers");
      }
      const payload = await response.json();
      this.app.settings.lsp_enabled = payload.enabled !== false;
      this.settingsStatus = payload.servers || [];
      this.app.settings.lsp_command_overrides = payload.overrides || {};
      this.app.persistedSettings.lsp_enabled = this.app.settings.lsp_enabled;
      this.app.persistedSettings.lsp_command_overrides = JSON.parse(JSON.stringify(this.app.settings.lsp_command_overrides));
      this.renderEnabledControl();
      this.populateSettingsLanguages();
      this.renderSettingsStatus();
    } catch (error) {
      elements.status.textContent = error.message || "could not load language servers";
      elements.status.classList.add("error");
    }
  }

  populateSettingsLanguages() {
    const elements = this.settingsElements;
    if (!elements) return;
    const activeLanguage = this.model?.getLanguageId() || "";
    const activeStatus = this.settingsStatus.find((server) => (server.languages || []).includes(activeLanguage));
    const requestedKey = this.settingsLanguageKey || activeStatus?.key || "python";
    elements.language.textContent = "";
    for (const server of this.settingsStatus) {
      const option = document.createElement("option");
      option.value = server.key;
      option.textContent = server.name;
      elements.language.appendChild(option);
    }
    elements.language.value = this.settingsStatus.some((server) => server.key === requestedKey)
      ? requestedKey : this.settingsStatus[0]?.key || "";
    this.settingsLanguageKey = elements.language.value;
  }

  selectedSettingsStatus() {
    return this.settingsStatus.find((server) => server.key === this.settingsElements?.language.value) || null;
  }

  renderEnabledControl() {
    const elements = this.settingsElements;
    if (!elements) return;
    const enabled = this.app.settings.lsp_enabled !== false;
    elements.enabledToggle.textContent = enabled ? "on" : "off";
    elements.enabledToggle.classList.toggle("on", enabled);
    elements.enabledToggle.setAttribute("aria-pressed", String(enabled));
    for (const element of [elements.project, elements.language, elements.command, elements.install,
      elements.installButton, elements.save, elements.automatic]) element.disabled = !enabled;
    if (!enabled) {
      elements.status.classList.remove("error");
      elements.status.textContent = "Disabled — no language-server processes will start.";
    }
  }

  async setEnabled(enabled) {
    const elements = this.settingsElements;
    if (!elements || elements.enabledToggle.disabled) return;
    const activeEntry = this.entry;
    const activeModel = this.model;
    elements.enabledToggle.disabled = true;
    if (!enabled) this.deactivate();
    try {
      const response = await fetch("/api/lsp/enabled", { method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }) });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.detail || "could not update language servers");
      }
      const payload = await response.json();
      this.app.settings.lsp_enabled = payload.enabled !== false;
      this.settingsStatus = payload.servers || [];
      this.app.settings.lsp_command_overrides = payload.overrides || {};
      this.app.persistedSettings.lsp_enabled = this.app.settings.lsp_enabled;
      this.app.persistedSettings.lsp_command_overrides = JSON.parse(JSON.stringify(this.app.settings.lsp_command_overrides));
      this.renderEnabledControl();
      if (enabled) {
        this.populateSettingsLanguages();
        this.renderSettingsStatus();
        const entry = activeEntry || (this.app.activeFileKey !== null ? this.app.openFiles.get(this.app.activeFileKey) : null);
        const model = activeModel || entry?.model;
        if (entry && model) void this.activate(entry, model);
      }
    } catch (error) {
      this.app.settings.lsp_enabled = !enabled;
      this.renderEnabledControl();
      elements.status.textContent = error.message || "could not update language servers";
      elements.status.classList.add("error");
    } finally {
      elements.enabledToggle.disabled = false;
    }
  }

  renderSettingsStatus() {
    const elements = this.settingsElements;
    const server = this.selectedSettingsStatus();
    if (!elements) return;
    this.renderEnabledControl();
    if (this.app.settings.lsp_enabled === false || !server) return;
    elements.status.classList.toggle("error", !server.available);
    const version = server.version ? ` ${server.version}` : "";
    const command = server.command_text || "no executable detected";
    elements.status.textContent = `${server.available ? "Ready" : "Unavailable"} · ${server.name}${version} · ${server.source}`;
    elements.status.title = command;
    elements.command.value = server.override || "";
    elements.command.placeholder = server.effective_override && !server.override
      ? `Inherited: ${server.effective_override}` : `Automatic: ${command}`;
    elements.install.textContent = "";
    for (const optionValue of server.install_options || []) {
      const option = document.createElement("option");
      option.value = optionValue.command;
      option.textContent = optionValue.label;
      elements.install.appendChild(option);
    }
    elements.installButton.disabled = !elements.install.options.length;
    elements.automatic.disabled = !server.override;
  }

  async saveSettingsOverride(command) {
    const elements = this.settingsElements;
    const server = this.selectedSettingsStatus();
    if (!elements || !server) return;
    elements.save.disabled = true;
    elements.automatic.disabled = true;
    elements.status.textContent = "Saving language server configuration…";
    const activeEntry = this.entry;
    const activeModel = this.model;
    let saved = false;
    try {
      const response = await fetch("/api/lsp/config", { method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root: elements.project.value, language: server.key, command: String(command || "").trim() }) });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.detail || "could not save language server configuration");
      }
      const payload = await response.json();
      this.settingsStatus = payload.servers || [];
      this.app.settings.lsp_command_overrides = payload.overrides || {};
      this.app.persistedSettings.lsp_command_overrides = JSON.parse(JSON.stringify(this.app.settings.lsp_command_overrides));
      this.renderSettingsStatus();
      saved = true;
      if (activeEntry && activeModel) {
        this.deactivate();
        void this.activate(activeEntry, activeModel);
      }
    } catch (error) {
      elements.status.textContent = error.message || "could not save language server configuration";
      elements.status.classList.add("error");
    } finally {
      elements.save.disabled = false;
      if (saved) this.renderSettingsStatus();
    }
  }

  async openSettingsInstallTerminal() {
    const elements = this.settingsElements;
    const server = this.selectedSettingsStatus();
    const installHint = elements?.install.value || server?.install_hint || "";
    if (this.app.settings.lsp_enabled === false || !elements || !server || !installHint) return;
    const root = elements.project.value || this.app.projectRoot() || this.app.session(this.app.activeId)?.cwd || "~";
    this.app.$("settings-popover").classList.add("hidden");
    await this.app.openLanguageServerInstallTerminal({ root, installHint, language: server.languages?.[0] || server.key,
      server: server.name });
  }

  scheduleDocumentChange() {
    clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => {
      this.changeTimer = 0;
      if (this.model) {
        this.transport.notify("change", this.model.getValue());
        this.schedulePullDiagnostics(120);
      }
    }, 180);
  }

  didSave(entry, model, content) {
    if (this.entry === entry && this.model === model) {
      this.transport.notify("save", content);
      this.schedulePullDiagnostics(80);
    }
  }

  schedulePullDiagnostics(delay = 120) {
    if (!this.capabilities.diagnosticProvider) return;
    clearTimeout(this.pullDiagnosticsTimer);
    this.pullDiagnosticsTimer = setTimeout(() => {
      this.pullDiagnosticsTimer = 0;
      void this.refreshPullDiagnostics();
    }, delay);
  }

  async refreshPullDiagnostics() {
    if (!this.transport.available || !this.model || !this.uri || !this.capabilities.diagnosticProvider) return;
    const model = this.model;
    const uri = this.uri;
    const params = { textDocument: { uri } };
    if (this.pullDiagnosticsResultId) params.previousResultId = this.pullDiagnosticsResultId;
    try {
      const result = await this.transport.request("textDocument/diagnostic", params);
      if (this.model !== model || this.uri !== uri || !result) return;
      if (result.kind === "unchanged") return;
      this.pullDiagnosticsResultId = String(result.resultId || "");
      this.publishDiagnostics({ uri, diagnostics: Array.isArray(result.items) ? result.items : [] });
    } catch (error) {
      if (this.model === model && this.uri === uri) this.setStatus("LSP diagnostics unavailable", error.message);
    }
  }

  setStatus(text, title) {
    const element = this.app.$("lsp-status");
    if (!element) return;
    element.textContent = text;
    element.title = title;
    element.classList.toggle("hidden", !text);
  }

  handlesModel(model) {
    return this.transport.available && this.model === model && this.entry !== null && this.uri !== "";
  }

  textDocumentPosition(position) {
    return { textDocument: { uri: this.uri }, position: { line: position.lineNumber - 1, character: position.column - 1 } };
  }

  async provideDefinition(model, position) {
    if (!this.handlesModel(model)) return null;
    return this.conversions.normalizeLocations(await this.transport.request("textDocument/definition", this.textDocumentPosition(position)));
  }

  async provideReferences(model, position, context) {
    if (!this.handlesModel(model)) return null;
    const params = { ...this.textDocumentPosition(position), context: { includeDeclaration: context.includeDeclaration } };
    return this.conversions.normalizeLocations(await this.transport.request("textDocument/references", params));
  }

  async provideHover(model, position) {
    if (!this.handlesModel(model)) return null;
    const result = await this.transport.request("textDocument/hover", this.textDocumentPosition(position));
    if (!result?.contents) return null;
    const hover = { contents: this.conversions.hoverContents(result.contents) };
    const range = this.conversions.toMonacoRange(result.range);
    if (range) hover.range = range;
    return hover;
  }

  async resolveRenameLocation(model, position) {
    if (!this.handlesModel(model)) return null;
    const result = await this.transport.request("textDocument/prepareRename", this.textDocumentPosition(position));
    if (!result) return null;
    const range = this.conversions.toMonacoRange(result.range || result);
    return range ? { range, text: result.placeholder || model.getValueInRange(range) } : null;
  }

  async provideRenameEdits(model, position, newName) {
    if (!this.handlesModel(model)) return { edits: [] };
    if (!await this.app.saveOpenFilesForLsp(this.entry.root)) return { edits: [] };
    const params = { ...this.textDocumentPosition(position), newName };
    const edit = await this.transport.request("textDocument/rename", params);
    if (edit) await this.applyWorkspaceEdit(edit);
    return { edits: [] };
  }

  async provideCodeActions(model, range, context) {
    if (!this.handlesModel(model)) return { actions: [], dispose() {} };
    const params = { textDocument: { uri: this.uri }, range: this.conversions.toLspRange(range),
      context: { diagnostics: context.markers.map((marker) => ({ range: this.conversions.toLspRange(marker), message: marker.message,
        severity: this.conversions.lspDiagnosticSeverity(marker.severity), code: marker.code, source: marker.source })),
        only: context.only ? [context.only.value || String(context.only)] : undefined, triggerKind: context.trigger === 2 ? 2 : 1 } };
    const result = await this.transport.request("textDocument/codeAction", params);
    const actions = (Array.isArray(result) ? result : []).map((action) => ({
      title: action.title || action.command || "Language server action", kind: action.kind, diagnostics: action.diagnostics,
      isPreferred: action.isPreferred, disabled: action.disabled?.reason, command: { id: "termdeck.lsp.executeCodeAction",
        title: action.title || "Language server action", arguments: [action] },
    }));
    return { actions, dispose() {} };
  }

  async executeCodeAction(action) {
    if (!action || !this.transport.available) return;
    if (!await this.app.saveOpenFilesForLsp(this.entry.root)) return;
    if (action.edit) await this.applyWorkspaceEdit(action.edit);
    if (action.command) {
      const command = typeof action.command === "string" ? action.command : action.command.command;
      const argumentsValue = typeof action.command === "string" ? [] : action.command.arguments || [];
      if (command) await this.transport.request("workspace/executeCommand", { command, arguments: argumentsValue });
    }
  }

  handleEvent(message) {
    if (message.type === "notification" && message.method === "textDocument/publishDiagnostics") {
      this.publishDiagnostics(message.params || {});
    } else if (message.type === "workspaceEditApplied" && message.changed) {
      void this.app.refreshFilesChangedByLsp(message.changed, message.root);
    } else if (message.type === "status" && !message.available) {
      this.setStatus("LSP disconnected", message.error || "Language server disconnected");
    }
  }

  publishDiagnostics(params) {
    if (!this.model || params.uri !== this.uri) return;
    const markers = (params.diagnostics || []).map((diagnostic) => {
      const range = this.conversions.toMonacoRange(diagnostic.range);
      return { startLineNumber: range.startLineNumber, startColumn: range.startColumn,
        endLineNumber: range.endLineNumber, endColumn: range.endColumn, message: diagnostic.message,
        severity: this.conversions.diagnosticSeverity(diagnostic.severity), source: diagnostic.source || this.serverName,
        code: diagnostic.code == null ? undefined : String(diagnostic.code), relatedInformation: [] };
    });
    monaco.editor.setModelMarkers(this.model, "termdeck-lsp", markers);
  }

  async provideWorkspaceSymbols(query) {
    if (!this.transport.available || !query) return [];
    const result = await this.transport.request("workspace/symbol", { query });
    return (Array.isArray(result) ? result : []).map((symbol) => {
      const location = this.conversions.toMonacoLocation(symbol.location);
      if (!location) return null;
      return { name: symbol.name, kind: Number.isInteger(symbol.kind) ? Math.max(0, symbol.kind - 1) : monaco.languages.SymbolKind.Variable,
        tags: symbol.tags || [], containerName: symbol.containerName || "", location };
    }).filter(Boolean);
  }

  async workspaceSymbols(query) {
    const symbols = await this.provideWorkspaceSymbols(query);
    return symbols.map((symbol) => ({ name: symbol.name, containerName: symbol.containerName,
      location: { uri: symbol.location.uri.toString(), range: { start: {
        line: symbol.location.range.startLineNumber - 1, character: symbol.location.range.startColumn - 1 }, end: {
        line: symbol.location.range.endLineNumber - 1, character: symbol.location.range.endColumn - 1 } } } }));
  }

  async definitionAt(position) {
    if (!this.handlesModel(this.model)) return null;
    const result = await this.transport.request("textDocument/definition", this.textDocumentPosition(position));
    const locations = Array.isArray(result) ? result : result ? [result] : [];
    return locations[0] || null;
  }

  locationDescriptor(location) {
    const parts = this.conversions.lspLocationParts(location);
    if (!parts || !this.entry || !this.model) return null;
    const absolutePath = monaco.Uri.parse(parts.uri).fsPath;
    const activePath = this.model.uri.fsPath;
    const normalizedEntryPath = this.entry.path.replaceAll("\\", "/");
    const normalizedActivePath = activePath.replaceAll("\\", "/");
    const rootPath = normalizedActivePath.endsWith(`/${normalizedEntryPath}`) ?
      normalizedActivePath.slice(0, -normalizedEntryPath.length - 1) : normalizedActivePath.slice(0, normalizedActivePath.lastIndexOf("/"));
    const normalizedTarget = absolutePath.replaceAll("\\", "/");
    if (normalizedTarget !== rootPath && !normalizedTarget.startsWith(`${rootPath}/`)) return null;
    return { root: this.entry.root, path: normalizedTarget.slice(rootPath.length + 1),
      line: parts.range.start.line + 1, column: parts.range.start.character + 1 };
  }

  async openLocation(location) {
    const target = this.locationDescriptor(location);
    if (!target) return false;
    await this.app.openFile(target.root, target.path, target.line, null, { pinned: true });
    this.app.revealEditorLine(target.line, target.column);
    return true;
  }

  async openResource(resource, selection) {
    const startLine = selection?.startLineNumber || selection?.lineNumber || 1;
    const startColumn = selection?.startColumn || selection?.column || 1;
    const endLine = selection?.endLineNumber || startLine;
    const endColumn = selection?.endColumn || startColumn;
    return this.openLocation({ uri: resource.toString(), range: { start: { line: startLine - 1, character: startColumn - 1 },
      end: { line: endLine - 1, character: endColumn - 1 } } });
  }

  async applyWorkspaceEdit(edit) {
    if (!this.entry) return [];
    const root = this.entry.root;
    const response = await fetch("/api/lsp/apply-workspace-edit", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root, edit }) });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || "language server edit failed");
    }
    const result = await response.json();
    await this.app.refreshFilesChangedByLsp(result.changed || [], root);
    return result.changed || [];
  }
}

window.TermdeckLspClient = TermdeckLspClient;
