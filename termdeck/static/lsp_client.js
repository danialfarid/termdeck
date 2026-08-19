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
    this.settingsStatus = [];
    this.settingsProjectRoot = "";
    this.settingsLanguageKey = "";
    this.settingsElements = null;
    const status = this.app.$("lsp-status");
    status.onclick = () => { if (status.classList.contains("installable")) void this.openSettingsPanel(); };
    status.onkeydown = (event) => {
      if (!status.classList.contains("installable") || !["Enter", " "].includes(event.key)) return;
      event.preventDefault();
      void this.openSettingsPanel();
    };
    this.initializeSettingsPanel();
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
    const language = model.getLanguageId();
    if (!this.supportedLanguages.has(language)) return;
    if (this.app.settings.lsp_enabled === false) {
      this.setStatus("Language tools off · Enable", "Enable language tools for diagnostics, definitions, references, rename, hover help, and code actions.", true);
      return;
    }
    const generation = ++this.activationGeneration;
    this.entry = entry;
    this.model = model;
    const openingText = model.getValue();
    this.modelSubscription = model.onDidChangeContent(() => this.scheduleDocumentChange());
    this.installDetails = null;
    this.setStatus("LSP", "Connecting language server");
    try {
      const status = await this.transport.connect(entry.root, entry.path, language, openingText,
        (message) => this.handleEvent(message));
      if (generation !== this.activationGeneration || this.entry !== entry || this.model !== model) return;
      if (!status.available) {
        this.modelSubscription?.dispose();
        this.modelSubscription = null;
        this.showInstallStatus(status, entry);
        return;
      }
      this.uri = status.uri;
      this.serverName = status.server || "Language server";
      this.capabilities = status.capabilities || {};
      this.installDetails = null;
      this.setStatus(this.serverName, `${this.serverName} connected`);
      this.schedulePullDiagnostics(0);
      if (model.getValue() !== openingText) this.transport.notify("change", model.getValue());
    } catch (error) {
      if (generation === this.activationGeneration) {
        this.modelSubscription?.dispose();
        this.modelSubscription = null;
        this.installDetails = null;
        this.setStatus("Language tools need setup", `${error.message}. Click to configure language tools for this project.`, true);
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
    this.installDetails = null;
    this.setStatus("", "");
  }

  languageDisplayName(language) {
    const names = { javascript: "JavaScript", javascriptreact: "JavaScript JSX", typescript: "TypeScript",
      typescriptreact: "TypeScript TSX", go: "Go", rust: "Rust", c: "C", cpp: "C++", "objective-c": "Objective-C",
      "objective-cpp": "Objective-C++", "cuda-cpp": "CUDA C++", java: "Java", ruby: "Ruby", php: "PHP",
      shell: "shell", yaml: "YAML", json: "JSON", jsonc: "JSON with comments", html: "HTML", css: "CSS",
      scss: "SCSS", less: "Less", python: "Python" };
    return names[language] || language;
  }

  showInstallStatus(status, entry) {
    const language = String(status.language || "");
    const installHint = String(status.install_hint || "").trim();
    const server = String(status.server || "Language server").trim();
    const installOptions = Array.isArray(status.install_options) ? status.install_options
      .map((option) => ({ label: String(option.label || "Install"), command: String(option.command || "").trim() }))
      .filter((option) => option.command) : [];
    if (!installOptions.length && installHint) installOptions.push({ label: `Install ${server}`, command: installHint });
    this.installDetails = this.app.settings.lsp_enabled === false || status.disabled || !language || !installOptions.length
      ? null : { language, installHint: installOptions[0].command, installOptions, server, root: entry.root };
    const languageName = this.languageDisplayName(language);
    const title = status.error
      ? `${status.error}. Click to configure ${languageName} language tools.`
      : `Install or configure ${server} for ${languageName} diagnostics, definitions, references, rename, hover help, and code actions.`;
    this.setStatus(`Set up ${languageName} tools`, title, true);
  }

  openInstallOptionsPopover() {
    const details = this.installDetails;
    if (!details) return;
    const pop = this.app.$("settings-popover");
    pop.classList.remove("lsp-settings-expanded");
    pop.classList.add("lsp-install-options-popover");
    pop.textContent = "";
    const heading = document.createElement("div");
    heading.className = "lsp-install-options-heading";
    heading.textContent = `Install ${details.server}`;
    pop.appendChild(heading);
    for (const option of details.installOptions) {
      const row = document.createElement("div");
      row.className = "lsp-install-option";
      const text = document.createElement("span");
      text.className = "lsp-install-option-text";
      const label = document.createElement("strong");
      label.textContent = option.label;
      const command = document.createElement("code");
      command.textContent = option.command;
      text.append(label, command);
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "install";
      button.onclick = () => {
        pop.classList.add("hidden");
        void this.app.openLanguageServerInstallTerminal({ ...details, installHint: option.command });
      };
      row.append(text, button);
      pop.appendChild(row);
    }
    pop.onkeydown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      pop.classList.add("hidden");
      this.app.$("lsp-status").focus();
    };
    this.app.positionPopover(pop, this.app.$("lsp-status"));
  }

  buildSettingsSection() {
    const row = document.createElement("div");
    row.className = "settings-row";
    const rowLabel = document.createElement("span");
    rowLabel.className = "settings-label";
    rowLabel.textContent = "Language servers";
    const manage = document.createElement("button");
    manage.type = "button";
    manage.className = "theme-toggle";
    manage.textContent = "manage";
    manage.onclick = () => {
      this.app.$("settings-popover").classList.add("hidden");
      void this.openSettingsPanel();
    };
    row.append(rowLabel, manage);
    return row;
  }

  buildLegacySettingsSection(anchor) {
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
    installButton.disabled = true;
    const installAll = document.createElement("button");
    installAll.type = "button";
    installAll.textContent = "install all";
    installAll.title = "Install every missing language server";
    installAll.disabled = true;
    const actions = document.createElement("div");
    actions.className = "lsp-settings-actions";
    const save = document.createElement("button");
    save.type = "button";
    save.textContent = "save override";
    const automatic = document.createElement("button");
    automatic.type = "button";
    automatic.textContent = "use automatic";
    installRow.append(install, installButton, installAll);
    actions.append(automatic, save);
    content.append(projectLabel, languageLabel, status, commandLabel, installRow, actions);
    headerControls.append(enabledToggle, toggle);
    header.append(label, headerControls);
    root.append(header, content);
    this.settingsElements = { root, anchor, project, language, status, command, install, installButton, installAll, save,
      automatic, enabledToggle };
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
    installAll.onclick = () => void this.openSettingsInstallAllTerminal();
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
      elements.save, elements.automatic]) element.disabled = !enabled;
    if (!enabled) {
      elements.installButton.disabled = true;
      elements.installAll.disabled = true;
    }
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
    elements.installAll.disabled = !this.settingsStatus.some((status) => !status.available &&
      (status.install_options || []).some((option) => String(option.command || "").trim()));
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

  async openSettingsInstallAllTerminal() {
    const elements = this.settingsElements;
    if (this.app.settings.lsp_enabled === false || !elements) return;
    const commands = [];
    const seenCommands = new Set();
    for (const server of this.settingsStatus) {
      if (server.available) continue;
      const command = String(server.install_options?.[0]?.command || server.install_hint || "").trim();
      if (!command || seenCommands.has(command)) continue;
      seenCommands.add(command);
      commands.push(command);
    }
    if (!commands.length) {
      elements.status.classList.remove("error");
      elements.status.textContent = "All language servers are available.";
      return;
    }
    const root = elements.project.value || this.app.projectRoot() || this.app.session(this.app.activeId)?.cwd || "~";
    this.app.$("settings-popover").classList.add("hidden");
    await this.app.openLanguageServerInstallTerminal({ root, installHint: commands.join(" ; "), language: "all",
      server: "Language servers", title: "Install language servers" });
  }

  initializeSettingsPanel() {
    this.app.$("lsp-panel-close").onclick = () => this.closeSettingsPanel();
    this.app.$("lsp-panel-done").onclick = () => this.closeSettingsPanel();
    this.app.$("lsp-backdrop").addEventListener("mousedown", (event) => {
      if (event.target.id === "lsp-backdrop") this.closeSettingsPanel();
    });
    this.app.$("lsp-project-scope").onchange = () => {
      this.settingsProjectRoot = this.app.$("lsp-project-scope").value;
      void this.loadSettingsPanelStatus();
    };
    this.app.$("lsp-enabled-toggle").onclick = () => void this.setSettingsPanelEnabled(
      this.app.settings.lsp_enabled === false);
    this.app.$("lsp-install-all").onclick = () => void this.installAllMissingFromSettingsPanel();
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || this.app.$("lsp-backdrop").classList.contains("hidden")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.closeSettingsPanel();
    }, true);
  }

  populateSettingsPanelProjects() {
    const project = this.app.$("lsp-project-scope");
    const requestedRoot = this.settingsProjectRoot || this.app.projectRoot() || "";
    project.textContent = "";
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
    project.value = [...project.options].some((option) => option.value === requestedRoot) ? requestedRoot : "";
    this.settingsProjectRoot = project.value;
  }

  async openSettingsPanel() {
    this.populateSettingsPanelProjects();
    this.app.$("lsp-backdrop").classList.remove("hidden");
    this.app.$("lsp-modal-summary").textContent = "Detecting installed servers…";
    this.app.$("lsp-server-list").textContent = "";
    this.setSettingsPanelError("");
    await this.loadSettingsPanelStatus();
  }

  closeSettingsPanel() {
    this.app.$("lsp-backdrop").classList.add("hidden");
    requestAnimationFrame(() => this.app.focusActiveEditor());
  }

  setSettingsPanelError(message) {
    const status = this.app.$("lsp-panel-status");
    status.textContent = message;
    status.classList.toggle("hidden", !message);
  }

  async loadSettingsPanelStatus() {
    const project = this.app.$("lsp-project-scope");
    const params = new URLSearchParams();
    if (project.value) params.set("root", project.value);
    this.app.$("lsp-modal-summary").textContent = "Detecting installed servers…";
    this.setSettingsPanelError("");
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
      this.renderSettingsPanel();
    } catch (error) {
      this.app.$("lsp-modal-summary").textContent = "Language-server status unavailable";
      this.setSettingsPanelError(error.message || "could not load language servers");
    }
  }

  renderSettingsPanel() {
    const enabled = this.app.settings.lsp_enabled !== false;
    const enabledToggle = this.app.$("lsp-enabled-toggle");
    enabledToggle.textContent = enabled ? "on" : "off";
    enabledToggle.classList.toggle("on", enabled);
    enabledToggle.setAttribute("aria-pressed", String(enabled));
    const installed = this.settingsStatus.filter((server) => server.available).length;
    this.app.$("lsp-modal-summary").textContent = enabled
      ? `${installed} of ${this.settingsStatus.length} installed`
      : `Disabled · ${installed} of ${this.settingsStatus.length} installed`;
    const list = this.app.$("lsp-server-list");
    list.textContent = "";
    for (const server of this.settingsStatus) list.appendChild(this.createSettingsPanelServerRow(server, enabled));
    const hasMissingInstaller = this.settingsStatus.some((server) => !server.available &&
      (server.install_options || []).some((option) => String(option.command || "").trim()));
    this.app.$("lsp-install-all").disabled = !enabled || !hasMissingInstaller;
    this.app.$("lsp-project-scope").disabled = false;
  }

  createSettingsPanelServerRow(server, enabled) {
    const row = document.createElement("div");
    row.className = "lsp-server-row";
    const main = document.createElement("div");
    main.className = "lsp-server-main";
    const identity = document.createElement("div");
    identity.className = "lsp-server-name";
    identity.textContent = server.name;
    identity.title = server.command_text || server.install_hint || server.name;
    const languages = document.createElement("span");
    languages.className = "lsp-server-languages";
    languages.textContent = (server.languages || []).map((language) => this.languageDisplayName(language)).join(", ");
    identity.appendChild(languages);
    const state = document.createElement("span");
    state.className = `lsp-server-state${server.available ? " available" : ""}`;
    state.textContent = server.available ? `installed${server.version ? ` · ${server.version}` : ""}` : "not installed";
    state.title = server.source || "";
    const controls = document.createElement("div");
    controls.className = "lsp-server-controls";
    if (!server.available) {
      const installOptions = document.createElement("select");
      installOptions.setAttribute("aria-label", `${server.name} installation option`);
      for (const installOption of server.install_options || []) {
        const option = document.createElement("option");
        option.value = String(installOption.command || "");
        option.textContent = String(installOption.label || "Install");
        installOptions.appendChild(option);
      }
      const install = document.createElement("button");
      install.type = "button";
      install.textContent = "install";
      install.disabled = !enabled || !installOptions.options.length;
      install.onclick = () => void this.installServerFromSettingsPanel(server, installOptions.value);
      controls.append(installOptions, install);
    }
    const configure = document.createElement("button");
    configure.type = "button";
    configure.className = "lsp-server-configure";
    configure.title = "Command override";
    configure.setAttribute("aria-label", `Configure ${server.name}`);
    configure.innerHTML = '<span class="codicon codicon-settings-gear"></span>';
    controls.appendChild(configure);
    const override = document.createElement("div");
    override.className = "lsp-server-override hidden";
    const input = document.createElement("input");
    input.type = "text";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.value = server.override || "";
    input.placeholder = server.effective_override && !server.override
      ? `Inherited project command: ${server.effective_override}` : `Detected command: ${server.command_text || "not detected"}`;
    input.setAttribute("aria-label", `${server.name} command override`);
    input.disabled = !enabled;
    const overrideActions = document.createElement("div");
    overrideActions.className = "lsp-override-actions";
    const automatic = document.createElement("button");
    automatic.type = "button";
    automatic.textContent = "automatic";
    automatic.title = "Remove this project override and use TermDeck's detected/default command";
    automatic.disabled = !enabled || !server.override;
    automatic.onclick = () => void this.saveSettingsPanelOverride(server, "", automatic);
    const save = document.createElement("button");
    save.type = "button";
    save.textContent = "save";
    save.title = "Save this command as the selected project's language-server override";
    save.disabled = !enabled;
    save.onclick = () => void this.saveSettingsPanelOverride(server, input.value, save);
    input.onkeydown = (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      void this.saveSettingsPanelOverride(server, input.value, save);
    };
    configure.onclick = () => {
      override.classList.toggle("hidden");
      if (!override.classList.contains("hidden")) requestAnimationFrame(() => input.focus());
    };
    const help = document.createElement("div");
    help.className = "lsp-override-help";
    help.textContent = "Automatic uses TermDeck's detected/default command. Save stores the typed command for this project.";
    overrideActions.append(automatic, save);
    override.append(input, overrideActions, help);
    main.append(identity, state, controls);
    row.append(main, override);
    return row;
  }

  async setSettingsPanelEnabled(enabled) {
    const button = this.app.$("lsp-enabled-toggle");
    if (button.disabled) return;
    const activeEntry = this.entry;
    const activeModel = this.model;
    button.disabled = true;
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
      this.renderSettingsPanel();
      if (enabled) {
        const entry = activeEntry || (this.app.activeFileKey !== null ? this.app.openFiles.get(this.app.activeFileKey) : null);
        const model = activeModel || entry?.model;
        if (entry && model) void this.activate(entry, model);
      }
    } catch (error) {
      this.app.settings.lsp_enabled = !enabled;
      this.setSettingsPanelError(error.message || "could not update language servers");
      this.renderSettingsPanel();
    } finally {
      button.disabled = false;
    }
  }

  async saveSettingsPanelOverride(server, command, button) {
    if (!server || button.disabled) return;
    button.disabled = true;
    const activeEntry = this.entry;
    const activeModel = this.model;
    try {
      const response = await fetch("/api/lsp/config", { method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root: this.app.$("lsp-project-scope").value, language: server.key,
          command: String(command || "").trim() }) });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.detail || "could not save language server configuration");
      }
      const payload = await response.json();
      this.settingsStatus = payload.servers || [];
      this.app.settings.lsp_command_overrides = payload.overrides || {};
      this.app.persistedSettings.lsp_command_overrides = JSON.parse(JSON.stringify(this.app.settings.lsp_command_overrides));
      this.renderSettingsPanel();
      if (activeEntry && activeModel) {
        this.deactivate();
        void this.activate(activeEntry, activeModel);
      }
    } catch (error) {
      this.setSettingsPanelError(error.message || "could not save language server configuration");
      button.disabled = false;
    }
  }

  settingsPanelRoot() {
    return this.app.$("lsp-project-scope").value || this.app.projectRoot() ||
      this.app.session(this.app.activeId)?.cwd || "~";
  }

  async installServerFromSettingsPanel(server, installHint) {
    if (this.app.settings.lsp_enabled === false || !installHint) return;
    const root = this.settingsPanelRoot();
    this.closeSettingsPanel();
    await this.app.openLanguageServerInstallTerminal({ root, installHint, language: server.languages?.[0] || server.key,
      server: server.name });
  }

  async installAllMissingFromSettingsPanel() {
    if (this.app.settings.lsp_enabled === false) return;
    const commands = [];
    const seenCommands = new Set();
    for (const server of this.settingsStatus) {
      if (server.available) continue;
      const command = String(server.install_options?.[0]?.command || server.install_hint || "").trim();
      if (!command || seenCommands.has(command)) continue;
      seenCommands.add(command);
      commands.push(command);
    }
    if (!commands.length) return;
    const root = this.settingsPanelRoot();
    this.closeSettingsPanel();
    await this.app.openLanguageServerInstallTerminal({ root, installHint: commands.join(" ; "), language: "all",
      server: "Language servers", title: "Install language servers" });
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

  setStatus(text, title, unavailable = false) {
    const element = this.app.$("lsp-status");
    if (!element) return;
    element.textContent = text;
    element.title = title;
    element.classList.toggle("hidden", !text);
    element.classList.toggle("unavailable", unavailable);
    element.classList.toggle("installable", unavailable);
    element.tabIndex = unavailable ? 0 : -1;
    element.setAttribute("role", unavailable ? "button" : "status");
    element.setAttribute("aria-label", unavailable ? `${title} Open language-server settings` : title);
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
