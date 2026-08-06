const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const vscode = require("vscode");
const { NativeTerminalManager } = require("./native_terminal");
const { TermDeckEditorPanel } = require("./termdeck_editor");

const REFRESH_MS = 1500;
const TREE_MIME = "application/vnd.code.tree.termdeck.sidebar";
const TITLE_STATUS_RE = /^[\u2800-\u28ff○-◗⏳⚡✳](\s+)/;

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === "https:" ? https : http;
    const body = options.body === undefined ? "" : JSON.stringify(options.body);
    const request = transport.request(target, {
      method: options.method || "GET",
      timeout: 2500,
      headers: body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {},
    }, (response) => {
      let responseBody = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { responseBody += chunk; });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          let detail = responseBody;
          try { detail = JSON.parse(responseBody).detail || detail; } catch (_error) { }
          reject(new Error(`TermDeck returned HTTP ${response.statusCode}: ${detail}`));
          return;
        }
        if (!responseBody) {
          resolve({});
          return;
        }
        try { resolve(JSON.parse(responseBody)); } catch (error) { reject(error); }
      });
    });
    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error("TermDeck request timed out")));
    if (body) request.write(body);
    request.end();
  });
}

function sessionTitle(session) {
  if (session?.title_user_set) return String(session.title || session.session_id);
  const title = String(session?.cli_title || session?.title || session?.session_id || "Terminal");
  return title.replace(TITLE_STATUS_RE, "");
}

function sessionIconPath(extensionUri, session, unread) {
  const kind = String(session?.agent_kind || "none");
  const iconKind = kind === "codex" ? "codex" : kind === "claude" ? "claude" : kind === "agy" ? "shell" : "shell";
  const state = session?.processing ? "working" : unread ? "unread" : "idle";
  return vscode.Uri.joinPath(extensionUri, "media", "icons", `${iconKind}-${state}.svg`);
}

function emptySnapshot(project = "") {
  return {
    project,
    sessions: [],
    active_session_id: "",
    open_files: [],
    session_order: [],
    pinned_sessions: [],
    unread_sessions: [],
    terminal_groups: [],
    session_groups: {},
    terminal_layout: [],
  };
}

class SessionTreeItem extends vscode.TreeItem {
  constructor(session, unread, extensionUri) {
    super(sessionTitle(session), vscode.TreeItemCollapsibleState.None);
    this.kind = "session";
    this.session = session;
    this.contextValue = "termdeckSession";
    this.iconPath = sessionIconPath(extensionUri, session, unread);
    this.command = { command: "termdeck.selectSession", title: "Open TermDeck terminal", arguments: [this] };
    this.tooltip = session.cwd ? `${sessionTitle(session)}\n${session.cwd}` : sessionTitle(session);
  }
}

class GroupTreeItem extends vscode.TreeItem {
  constructor(group, count) {
    super(group.name, group.collapsed ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded);
    this.kind = "group";
    this.group = group;
    this.contextValue = "termdeckGroup";
    this.description = String(count);
    this.iconPath = new vscode.ThemeIcon("folder-library");
    this.tooltip = `${group.name} · ${count} terminal${count === 1 ? "" : "s"}`;
  }
}

class NativeTreeProvider {
  constructor(client, extensionUri) {
    this.client = client;
    this.extensionUri = extensionUri;
    this.snapshot = emptySnapshot();
    this.unreadSessionIds = new Set();
    this.changeEmitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changeEmitter.event;
  }

  update(snapshot) {
    this.snapshot = snapshot || emptySnapshot();
    this.unreadSessionIds = new Set((this.snapshot.unread_sessions || []).map(String));
    this.changeEmitter.fire();
  }

  sessionItem(session) {
    return new SessionTreeItem(session, this.unreadSessionIds.has(String(session.session_id)), this.extensionUri);
  }

  getTreeItem(element) {
    return element;
  }

  getChildren(element) {
    if (element?.kind === "group") return this.groupChildren(element.group.id);
    return this.rootChildren();
  }

  groupChildren(groupId) {
    const members = new Set(Object.entries(this.snapshot.session_groups || {})
      .filter(([, assigned]) => assigned === groupId).map(([sessionId]) => sessionId));
    const ordered = this.orderedSessions();
    return ordered.filter((session) => members.has(String(session.session_id)))
      .map((session) => this.sessionItem(session));
  }

  rootChildren() {
    const sessions = new Map(this.snapshot.sessions.map((session) => [String(session.session_id), session]));
    const groups = new Map(this.groups().map((group) => [group.id, group]));
    const assigned = this.snapshot.session_groups || {};
    const pinned = new Set((this.snapshot.pinned_sessions || []).map(String));
    const usedSessions = new Set();
    const usedGroups = new Set();
    const items = [];
    for (const session of this.orderedSessions()) {
      const id = String(session.session_id);
      if (pinned.has(id) && !assigned[id]) {
        usedSessions.add(id);
        items.push(this.sessionItem(session));
      }
    }
    for (const token of this.snapshot.terminal_layout || []) {
      const [kind, id] = String(token).split(":", 2);
      if (kind === "group" && groups.has(id) && !usedGroups.has(id)) {
        usedGroups.add(id);
        const group = groups.get(id);
        items.push(new GroupTreeItem(group, this.groupChildren(id).length));
      } else if (kind === "session" && sessions.has(id) && !assigned[id] && !usedSessions.has(id)) {
        usedSessions.add(id);
        items.push(this.sessionItem(sessions.get(id)));
      }
    }
    for (const session of this.orderedSessions()) {
      const id = String(session.session_id);
      if (!assigned[id] && !usedSessions.has(id)) {
        usedSessions.add(id);
        items.push(this.sessionItem(session));
      }
    }
    for (const group of this.groups()) {
      if (usedGroups.has(group.id)) continue;
      usedGroups.add(group.id);
      items.push(new GroupTreeItem(group, this.groupChildren(group.id).length));
    }
    return items;
  }

  groups() {
    return (this.snapshot.terminal_groups || [])
      .filter((group) => group && group.id && String(group.name || "").trim())
      .map((group) => ({ id: String(group.id), name: String(group.name).trim(), collapsed: !!group.collapsed }));
  }

  orderedSessions() {
    const sessions = [...this.snapshot.sessions];
    const order = new Map((this.snapshot.session_order || []).map((id, index) => [String(id), index]));
    const pinned = new Set((this.snapshot.pinned_sessions || []).map(String));
    return sessions.sort((left, right) => (Number(pinned.has(String(right.session_id))) - Number(pinned.has(String(left.session_id)))) ||
      (order.has(String(left.session_id)) ? order.get(String(left.session_id)) : 1e9) -
      (order.has(String(right.session_id)) ? order.get(String(right.session_id)) : 1e9));
  }

  dispose() {
    this.changeEmitter.dispose();
  }
}

class NativeTreeDragAndDropController {
  constructor(client) {
    this.client = client;
    this.dragMimeTypes = [TREE_MIME];
    this.dropMimeTypes = [TREE_MIME];
  }

  handleDrag(source, dataTransfer) {
    const item = source[0];
    if (!item) return;
    const id = item.kind === "group" ? item.group.id : item.session.session_id;
    dataTransfer.set(TREE_MIME, new vscode.DataTransferItem(JSON.stringify({ kind: item.kind, id })));
  }

  async handleDrop(target, dataTransfer) {
    const item = dataTransfer.get(TREE_MIME);
    if (!item) return;
    try {
      const source = JSON.parse(await item.asString());
      await this.client.handleTreeDrop(source, target);
    } catch (error) {
      vscode.window.showErrorMessage(`TermDeck: ${error.message || error}`);
    }
  }
}

class NativeTermDeckClient {
  constructor(context, ensureServer, getWorkspaceRoot, resolveProject, openFile) {
    this.context = context;
    this.ensureServer = ensureServer;
    this.getWorkspaceRoot = getWorkspaceRoot;
    this.resolveProject = resolveProject;
    this.openFile = openFile;
    this.serverUrl = "";
    this.project = "";
    this.snapshot = emptySnapshot();
    this.closedSessions = [];
    this.closedSessionsProject = "";
    this.refreshTimer = undefined;
    this.refreshInProgress = false;
    this.started = false;
    this.editorPanel = undefined;
    this.tree = new NativeTreeProvider(this, context.extensionUri);
    this.treeView = vscode.window.createTreeView("termdeck.sidebar", {
      treeDataProvider: this.tree,
      showCollapseAll: true,
      dragAndDropController: new NativeTreeDragAndDropController(this),
    });
    this.treeView.onDidCollapseElement((event) => {
      if (event.element?.kind === "group") void this.setGroupCollapsed(event.element.group.id, true);
    }, null, context.subscriptions);
    this.treeView.onDidExpandElement((event) => {
      if (event.element?.kind === "group") void this.setGroupCollapsed(event.element.group.id, false);
    }, null, context.subscriptions);
  }

  registerCommands(context) {
    const commands = {
      "termdeck.refresh": () => this.refresh(),
      "termdeck.settings": () => this.openSettings(),
      "termdeck.newSession": () => this.newSession(),
      "termdeck.newGroup": () => this.newGroup(),
      "termdeck.selectSession": (item) => this.selectSession(item),
      "termdeck.renameSession": (item) => this.renameSession(item),
      "termdeck.restartSession": (item) => this.restartSession(item),
      "termdeck.forkSession": (item) => this.forkSession(item),
      "termdeck.closeSession": (item) => this.closeSession(item),
      "termdeck.pinSession": (item) => this.pinSession(item),
      "termdeck.assignSession": (item) => this.assignSession(item),
      "termdeck.openTranscript": (item) => this.openTranscript(item),
      "termdeck.renameGroup": (item) => this.renameGroup(item),
      "termdeck.removeGroup": (item) => this.removeGroup(item),
      "termdeck.closeGroup": (item) => this.closeGroup(item),
      "termdeck.toggleGroup": (item) => this.toggleGroup(item),
    };
    for (const [command, handler] of Object.entries(commands)) {
      context.subscriptions.push(vscode.commands.registerCommand(command, (...args) => handler(...args)));
    }
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("termdeck.singleTabMode")) return;
      if (!this.singleTabMode()) {
        this.editorPanel?.dispose();
        this.editorPanel = undefined;
      }
      void this.refresh();
    }));
  }

  singleTabMode() {
    return vscode.workspace.getConfiguration("termdeck").get("singleTabMode", false) === true;
  }

  editorHostState() {
    return {
      type: "termdeck-host-state",
      vscode: true,
      native_terminal: false,
      workspaceRoot: this.getWorkspaceRoot(),
      projectName: this.project,
    };
  }

  ensureEditorPanel() {
    if (this.editorPanel) {
      this.editorPanel.updateContext(this.serverUrl, this.project, this.getWorkspaceRoot());
      this.editorPanel.show();
      return this.editorPanel;
    }
    this.editorPanel = new TermDeckEditorPanel(this.context, this.serverUrl, this.project,
      this.getWorkspaceRoot(), (message) => this.handleEditorMessage(message));
    this.editorPanel.show();
    return this.editorPanel;
  }

  sendEditorState() {
    if (!this.editorPanel) return;
    this.editorPanel.postMessage(this.editorHostState());
  }

  handleEditorMessage(message) {
    if (!message) return;
    if (message.type === "termdeck-editor-ready") {
      this.sendEditorState();
      return;
    }
    if (message.type === "termdeck-editor-disposed") {
      this.editorPanel = undefined;
      return;
    }
    if (message.type === "termdeck-open-file") {
      this.openFile(message.path, message.line, message.column, message.cwd || this.getWorkspaceRoot());
      return;
    }
    if (message.type === "termdeck-refresh") {
      void this.refresh();
    }
  }

  async openSingleTabSession(sessionId, history = false) {
    const panel = this.ensureEditorPanel();
    panel.postMessage({ type: "termdeck-action", action: "select-session", payload: { session_id: String(sessionId) } });
    if (history) panel.postMessage({ type: "termdeck-action", action: "set-history", payload: { enabled: true } });
  }

  async openSettings() {
    const singleTab = this.singleTabMode();
    const treeConfig = vscode.workspace.getConfiguration("workbench.tree");
    const treeIndent = Number(treeConfig.get("indent", 8)) || 8;
    const choice = await vscode.window.showQuickPick([
      {
        label: `${singleTab ? "$(check)" : "$(circle-slash)"} Single TermDeck editor tab`,
        description: singleTab ? "Enabled · select terminals from the Activity Bar" : "Disabled · open native VS Code terminal tabs",
        detail: "Use one TermDeck tab and switch terminals from the TermDeck sidebar.",
        id: "single-tab",
      },
      {
        label: `${treeIndent <= 4 ? "$(check)" : "$(circle-slash)"} Compact native tree indentation`,
        description: `${treeIndent <= 4 ? "Enabled · 4px per level" : `Current · ${treeIndent}px per level`}`,
        detail: "Reduce the horizontal shift of groups and their terminals in VS Code trees.",
        id: "compact-tree",
      },
      {
        label: "$(settings-gear) Open VS Code settings",
        description: "Edit all TermDeck settings",
        id: "open-settings",
      },
    ], { placeHolder: "TermDeck settings" });
    if (!choice) return;
    if (choice.id === "open-settings") {
      await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:danialfarid.termdeck-vscode");
      return;
    }
    if (choice.id === "compact-tree") {
      await treeConfig.update("indent", treeIndent <= 4 ? 8 : 4, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`VS Code tree indentation set to ${treeIndent <= 4 ? 8 : 4}px.`);
      return;
    }
    const configuration = vscode.workspace.getConfiguration("termdeck");
    await configuration.update("singleTabMode", !singleTab, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`TermDeck: ${!singleTab ? "Single editor tab" : "Native VS Code terminals"} enabled.`);
  }

  async start() {
    this.started = true;
    await this.refresh();
    this.refreshTimer = setInterval(() => void this.refresh(), REFRESH_MS);
  }

  async refresh() {
    if (!this.started || this.refreshInProgress) return;
    this.refreshInProgress = true;
    try {
      const workspaceRoot = this.getWorkspaceRoot();
      const serverUrl = await this.ensureServer(workspaceRoot);
      const project = await this.resolveProject(serverUrl, workspaceRoot);
      const changedServer = this.serverUrl !== serverUrl;
      this.serverUrl = serverUrl;
      this.project = project;
      if (this.singleTabMode()) {
        this.nativeTerminals?.dispose();
        this.nativeTerminals = undefined;
      } else if (!this.nativeTerminals || changedServer) {
        this.nativeTerminals?.dispose();
        this.nativeTerminals = new NativeTerminalManager(this.context, serverUrl, this.openFile,
          (sessionId) => this.markSessionRead(sessionId));
      } else this.nativeTerminals.setServerUrl(serverUrl);
      this.editorPanel?.updateContext(serverUrl, project, workspaceRoot);
      const query = project ? `?project=${encodeURIComponent(project)}` : "";
      const snapshot = await requestJson(`${serverUrl}/api/terminal-layout${query}`);
      this.applySnapshot(snapshot);
    } catch (error) {
      if (this.started) vscode.window.showErrorMessage(`TermDeck: ${error.message || error}`);
    } finally {
      this.refreshInProgress = false;
    }
  }

  applySnapshot(snapshot) {
    this.snapshot = { ...emptySnapshot(this.project), ...snapshot, sessions: snapshot.sessions || [] };
    this.tree.update(this.snapshot);
    const unread = new Set((this.snapshot.unread_sessions || []).map(String));
    for (const session of this.snapshot.sessions) {
      this.nativeTerminals?.updateSession(session, false, unread.has(String(session.session_id)));
    }
    this.nativeTerminals?.syncSessions(this.snapshot.sessions.map((session) => String(session.session_id)));
    if (this.singleTabMode() && this.editorPanel) this.sendEditorState();
  }

  async closedSessionsForProject() {
    const query = this.project ? `?project=${encodeURIComponent(this.project)}` : "";
    const key = this.project || "__all__";
    if (this.closedSessionsProject === key) return this.closedSessions;
    const closed = await requestJson(`${this.serverUrl}/api/closed${query}`);
    this.closedSessions = Array.isArray(closed) ? closed : [];
    this.closedSessionsProject = key;
    return this.closedSessions;
  }

  async sessionReferenceSuggestions() {
    const projectSessions = [...(this.snapshot.sessions || []), ...(await this.closedSessionsForProject())];
    const seen = new Set();
    const suggestions = [];
    const add = (value, label) => {
      const key = String(value || "").trim().toLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      suggestions.push({ label, value: String(value) });
    };
    for (const session of projectSessions) {
      if (!session) continue;
      add(session.session_id, `Session id: ${session.session_id}`);
      if (session.title) add(session.title, `Title: ${session.title}`);
      if (session.cli_title) add(session.cli_title, `Agent title: ${session.cli_title}`);
    }
    return suggestions.sort((left, right) => {
      const leftValue = String(left.value).toLowerCase();
      const rightValue = String(right.value).toLowerCase();
      return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
    });
  }

  async resolveSessionNameAndReference(model, rawValue) {
    const modelValue = String(model || "").trim().toLowerCase();
    const value = String(rawValue || "").trim();
    if (!value || modelValue === "none" || modelValue === "agy") return { title: value, session_ref: "" };
    const needle = value.toLowerCase();
    const sessions = [...this.snapshot.sessions, ...(await this.closedSessionsForProject())];
    const matches = [];
    for (const session of sessions) {
      if (!session) continue;
      const sessionId = String(session.session_id || "").trim();
      const title = String(session.title || "").trim();
      const cliTitle = String(session.cli_title || "").trim();
      if (sessionId && sessionId.toLowerCase() === needle) matches.push(sessionId);
      if (title && title.toLowerCase() === needle) matches.push(sessionId);
      if (cliTitle && cliTitle.toLowerCase() === needle) matches.push(sessionId);
    }
    const unique = [...new Set(matches)];
    if (unique.length === 1 && unique[0]) return { title: "", session_ref: unique[0] };
    return { title: value, session_ref: "" };
  }

  stateUrl() {
    const query = this.project ? `?project=${encodeURIComponent(this.project)}` : "";
    return `${this.serverUrl}/api/terminal-layout${query}`;
  }

  async patchState(patch) {
    const snapshot = await requestJson(this.stateUrl(), { method: "PATCH", body: patch });
    this.applySnapshot(snapshot);
    return snapshot;
  }

  layoutWithFallback() {
    const groups = new Set(this.groups().map((group) => group.id));
    const sessions = new Set(this.snapshot.sessions.map((session) => String(session.session_id)));
    const assigned = this.snapshot.session_groups || {};
    const pinned = new Set((this.snapshot.pinned_sessions || []).map(String));
    const layout = [];
    const seen = new Set();
    const add = (token) => {
      if (seen.has(token)) return;
      const [kind, id] = String(token).split(":", 2);
      if (kind === "group" && !groups.has(id)) return;
      if (kind === "session" && (!sessions.has(id) || assigned[id] || pinned.has(id))) return;
      if (kind !== "group" && kind !== "session") return;
      seen.add(token);
      layout.push(token);
    };
    for (const token of this.snapshot.terminal_layout || []) add(token);
    for (const session of this.tree.orderedSessions()) {
      const id = String(session.session_id);
      if (!assigned[id] && !pinned.has(id)) add(`session:${id}`);
    }
    for (const group of this.groups()) add(`group:${group.id}`);
    return layout;
  }

  sessionOrderWith(sourceId, targetId) {
    const known = new Set(this.snapshot.sessions.map((session) => String(session.session_id)));
    const order = [];
    for (const id of this.snapshot.session_order || []) {
      if (known.has(String(id)) && !order.includes(String(id))) order.push(String(id));
    }
    for (const id of known) if (!order.includes(id)) order.push(id);
    const sourceIndex = order.indexOf(String(sourceId));
    const targetIndex = order.indexOf(String(targetId));
    if (sourceIndex < 0 || targetIndex < 0 || sourceId === targetId) return null;
    order.splice(sourceIndex, 1);
    order.splice(order.indexOf(String(targetId)), 0, String(sourceId));
    return order;
  }

  async handleTreeDrop(source, target) {
    if (!source?.id) return;
    if (source.kind === "session") {
      if (target?.kind === "group") return this.moveSessionToGroupFromDrop(source.id, target.group.id);
      if (target?.kind === "session") return this.moveSessionBeforeSession(source.id, target.session.session_id);
      return this.moveSessionToRootEnd(source.id);
    }
    if (source.kind !== "group") return;
    if (target?.kind === "group" && target.group.id === source.id) return;
    const targetToken = target?.kind === "group"
      ? `group:${target.group.id}`
      : target?.kind === "session"
        ? this.snapshot.session_groups?.[target.session.session_id]
          ? `group:${this.snapshot.session_groups[target.session.session_id]}`
          : `session:${target.session.session_id}`
        : null;
    const layout = this.layoutWithFallback().filter((token) => token !== `group:${source.id}`);
    const targetIndex = targetToken ? layout.indexOf(targetToken) : -1;
    layout.splice(targetIndex < 0 ? layout.length : targetIndex, 0, `group:${source.id}`);
    await this.patchState({ terminal_layout: layout });
  }

  async moveSessionToGroupFromDrop(sessionId, groupId) {
    if (!this.groups().some((group) => group.id === groupId)) return;
    const sessionGroups = { ...(this.snapshot.session_groups || {}), [sessionId]: groupId };
    const layout = this.layoutWithFallback().filter((token) => token !== `session:${sessionId}`);
    const pinned = (this.snapshot.pinned_sessions || []).filter((id) => String(id) !== String(sessionId));
    await this.patchState({ session_groups: sessionGroups, terminal_layout: layout, pinned_sessions: pinned });
  }

  async moveSessionBeforeSession(sessionId, targetId) {
    if (String(sessionId) === String(targetId)) return;
    const targetGroup = this.snapshot.session_groups?.[targetId] || null;
    const targetPinned = (this.snapshot.pinned_sessions || []).map(String).includes(String(targetId));
    const sessionGroups = { ...(this.snapshot.session_groups || {}) };
    if (targetGroup) sessionGroups[sessionId] = targetGroup;
    else delete sessionGroups[sessionId];
    const patch = { session_groups: sessionGroups };
    const order = this.sessionOrderWith(sessionId, targetId);
    if (order) patch.session_order = order;
    const pinned = new Set((this.snapshot.pinned_sessions || []).map(String));
    if (targetPinned) pinned.add(String(sessionId));
    else pinned.delete(String(sessionId));
    patch.pinned_sessions = [...pinned];
    if (!targetGroup && !targetPinned) {
      const layout = this.layoutWithFallback().filter((token) => token !== `session:${sessionId}`);
      const targetIndex = layout.indexOf(`session:${targetId}`);
      layout.splice(targetIndex < 0 ? layout.length : targetIndex, 0, `session:${sessionId}`);
      patch.terminal_layout = layout;
    } else {
      patch.terminal_layout = this.layoutWithFallback().filter((token) => token !== `session:${sessionId}`);
    }
    await this.patchState(patch);
  }

  async moveSessionToRootEnd(sessionId) {
    const sessionGroups = { ...(this.snapshot.session_groups || {}) };
    delete sessionGroups[sessionId];
    const pinned = (this.snapshot.pinned_sessions || []).filter((id) => String(id) !== String(sessionId));
    const layout = this.layoutWithFallback().filter((token) => token !== `session:${sessionId}`);
    layout.push(`session:${sessionId}`);
    await this.patchState({ session_groups: sessionGroups, pinned_sessions: pinned, terminal_layout: layout });
  }

  async selectSession(item) {
    const session = item?.session || item;
    if (!session?.session_id) return;
    const unread = new Set((this.snapshot.unread_sessions || []).map(String));
    unread.delete(String(session.session_id));
    if (this.singleTabMode()) await this.openSingleTabSession(session.session_id);
    else this.nativeTerminals?.showSession(session, false);
    try {
      await this.patchState({ active_session_id: String(session.session_id), unread_sessions: [...unread] });
    }
    catch (error) { vscode.window.showErrorMessage(`TermDeck: ${error.message || error}`); }
  }

  async markSessionRead(sessionId) {
    const unread = new Set((this.snapshot.unread_sessions || []).map(String));
    if (!unread.delete(String(sessionId))) return;
    try { await this.patchState({ unread_sessions: [...unread] }); }
    catch (error) { vscode.window.showErrorMessage(`TermDeck: ${error.message || error}`); }
  }

  async ensureSessionCreationConnection() {
    const workspaceRoot = this.getWorkspaceRoot();
    const serverUrl = await this.ensureServer(workspaceRoot);
    this.serverUrl = serverUrl;
    this.project = await this.resolveProject(serverUrl, workspaceRoot);
  }

  async newSession() {
    try {
      await this.ensureSessionCreationConnection();
    } catch (error) {
      vscode.window.showErrorMessage(`TermDeck: ${error.message || error}`);
      return;
    }
    const model = await vscode.window.showQuickPick([
      { label: "Codex", description: "Start a Codex terminal", value: "codex" },
      { label: "Claude", description: "Start a Claude terminal", value: "claude" },
      { label: "AGY", description: "Start an AGY terminal", value: "agy" },
      { label: "Shell", description: "Start a regular shell terminal", value: "none" },
    ], { placeHolder: "Choose the terminal type" });
    if (!model) return;
    const permission = model.value === "none" ? "" : await this.pickPermission(model.value);
    if (model.value !== "none" && !permission) return;
    const rootUri = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      defaultUri: this.getWorkspaceRoot() ? vscode.Uri.file(this.getWorkspaceRoot()) : undefined,
      openLabel: "Use this folder",
      title: "Select TermDeck project folder",
    });
    if (!rootUri?.length) return;
    const cwd = rootUri[0].fsPath;
    const project = path.basename(cwd);
    if (!cwd) {
      vscode.window.showErrorMessage("TermDeck: failed to select a project folder");
      return;
    }
    const titleInput = await this.pickTerminalName();
    if (titleInput === undefined) return;
    const { title, session_ref: sessionRef } = await this.resolveSessionNameAndReference(model.value, titleInput);
    try {
      const session = await requestJson(`${this.serverUrl}/api/sessions`, {
        method: "POST", body: { cwd, title, model: model.value, permission, session_ref: sessionRef, project },
      });
      if (!session?.session_id) throw new Error("TermDeck did not return the new terminal ID");
      await this.refresh();
      await this.selectSession(session);
    } catch (error) { vscode.window.showErrorMessage(`TermDeck: ${error.message || error}`); }
  }

  async pickPermission(model) {
    const options = model === "agy"
      ? [{ label: "Default", value: "default" }, { label: "Full access", value: "full-access" }]
      : model === "claude"
      ? [{ label: "Default", value: "default" }, { label: "Accept edits", value: "accept-edits" },
        { label: "Auto", value: "auto" }, { label: "Full access", value: "full-access" }]
      : [{ label: "Default", value: "default" }, { label: "Read-only", value: "read-only" },
        { label: "Workspace write", value: "workspace-write" }, { label: "Full access", value: "full-access" }];
    const choice = await vscode.window.showQuickPick(options, { placeHolder: `Choose ${model} permissions` });
    return choice?.value || "";
  }

  async pickTerminalName() {
    const suggestions = await this.sessionReferenceSuggestions();
    if (!suggestions.length) {
      return vscode.window.showInputBox({
        prompt: "Session name / Resume existing session (optional)",
        placeHolder: "Leave empty to auto-name. Use existing session id/name to resume",
      });
    }
    const options = suggestions.map((item) => ({ label: item.label, description: item.value, value: item.value }));
    const selected = await vscode.window.showQuickPick([
      { label: "Enter a custom session name", description: "Create a new terminal title", value: "" },
      ...options,
    ], { placeHolder: "Choose an existing session name/id or create a new one", matchOnDescription: true });
    if (!selected) return;
    if (selected.value) return selected.value;
    return vscode.window.showInputBox({
      prompt: "Session name / Resume existing session (optional)",
      placeHolder: "Leave empty to auto-name. Use existing session id/name to resume",
    });
  }

  async newGroup() {
    const name = await vscode.window.showInputBox({ prompt: "New terminal group name", value: "New group" });
    if (!name?.trim()) return;
    const group = { id: `group-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: name.trim(), collapsed: false };
    try { await this.patchState({ terminal_groups: [...this.groups(), group] }); }
    catch (error) { vscode.window.showErrorMessage(`TermDeck: ${error.message || error}`); }
  }

  groups() {
    return (this.snapshot.terminal_groups || []).filter((group) => group?.id && String(group.name || "").trim());
  }

  async renameSession(item) {
    const session = item?.session;
    if (!session) return;
    const title = await vscode.window.showInputBox({ prompt: "Rename terminal", value: sessionTitle(session) });
    if (!title?.trim() || title.trim() === sessionTitle(session)) return;
    try {
      await requestJson(`${this.serverUrl}/api/sessions/${encodeURIComponent(session.session_id)}/rename`, {
        method: "POST", body: { title: title.trim() },
      });
      await this.refresh();
    } catch (error) { vscode.window.showErrorMessage(`TermDeck: ${error.message || error}`); }
  }

  async restartSession(item) {
    const session = item?.session;
    if (!session || !(await this.confirm(`Restart "${sessionTitle(session)}"?`, "Restart"))) return;
    try {
      await requestJson(`${this.serverUrl}/api/sessions/${encodeURIComponent(session.session_id)}/restart`, { method: "POST" });
      await this.refresh();
    } catch (error) { vscode.window.showErrorMessage(`TermDeck: ${error.message || error}`); }
  }

  async forkSession(item) {
    const session = item?.session;
    if (!session) return;
    const title = await vscode.window.showInputBox({ prompt: "Fork terminal title", value: `${sessionTitle(session)} fork` });
    if (!title?.trim()) return;
    try {
      await requestJson(`${this.serverUrl}/api/sessions/${encodeURIComponent(session.session_id)}/fork`, {
        method: "POST", body: { title: title.trim() },
      });
      await this.refresh();
    } catch (error) { vscode.window.showErrorMessage(`TermDeck: ${error.message || error}`); }
  }

  async closeSession(item) {
    const session = item?.session;
    if (!session || !(await this.confirm(`Close "${sessionTitle(session)}"?`, "Close"))) return;
    try {
      await requestJson(`${this.serverUrl}/api/sessions/${encodeURIComponent(session.session_id)}`, { method: "DELETE" });
      await this.refresh();
    } catch (error) { vscode.window.showErrorMessage(`TermDeck: ${error.message || error}`); }
  }

  async pinSession(item) {
    const session = item?.session;
    if (!session) return;
    const id = String(session.session_id);
    const pinned = new Set((this.snapshot.pinned_sessions || []).map(String));
    if (pinned.has(id)) pinned.delete(id); else pinned.add(id);
    try { await this.patchState({ pinned_sessions: [...pinned] }); }
    catch (error) { vscode.window.showErrorMessage(`TermDeck: ${error.message || error}`); }
  }

  async assignSession(item) {
    const session = item?.session;
    if (!session) return;
    const choices = [{ label: "No group", id: "" }, ...this.groups().map((group) => ({ label: group.name, id: group.id }))];
    const choice = await vscode.window.showQuickPick(choices, { placeHolder: "Move terminal to group" });
    if (!choice) return;
    const id = String(session.session_id);
    const sessionGroups = { ...(this.snapshot.session_groups || {}) };
    const layout = (this.snapshot.terminal_layout || []).filter((token) => token !== `session:${id}`);
    const pinned = (this.snapshot.pinned_sessions || []).filter((sessionId) => String(sessionId) !== id);
    if (choice.id) sessionGroups[id] = choice.id;
    else {
      delete sessionGroups[id];
      layout.push(`session:${id}`);
    }
    try { await this.patchState({ session_groups: sessionGroups, terminal_layout: layout, pinned_sessions: pinned }); }
    catch (error) { vscode.window.showErrorMessage(`TermDeck: ${error.message || error}`); }
  }

  async openTranscript(item) {
    const session = item?.session;
    if (!session) return;
    if (this.singleTabMode()) {
      await this.openSingleTabSession(session.session_id, true);
      return;
    }
    try {
      const turns = await requestJson(`${this.serverUrl}/api/sessions/${encodeURIComponent(session.session_id)}/history`);
      const content = turns.map((turn) => `## ${String(turn.role || turn.kind || "event").toUpperCase()}\n\n${String(turn.text || turn.title || "")}`).join("\n\n");
      const document = await vscode.workspace.openTextDocument({ language: "markdown", content: `# ${sessionTitle(session)}\n\n${content}` });
      await vscode.window.showTextDocument(document, { preview: false });
    } catch (error) { vscode.window.showErrorMessage(`TermDeck: ${error.message || error}`); }
  }

  async renameGroup(item) {
    const group = item?.group;
    if (!group) return;
    const name = await vscode.window.showInputBox({ prompt: "Rename terminal group", value: group.name });
    if (!name?.trim() || name.trim() === group.name) return;
    const groups = this.groups().map((candidate) => candidate.id === group.id ? { ...candidate, name: name.trim() } : candidate);
    try { await this.patchState({ terminal_groups: groups }); }
    catch (error) { vscode.window.showErrorMessage(`TermDeck: ${error.message || error}`); }
  }

  async removeGroup(item) {
    const group = item?.group;
    if (!group || !(await this.confirm(`Remove grouping for "${group.name}"?`, "Remove"))) return;
    const sessionGroups = { ...(this.snapshot.session_groups || {}) };
    for (const [sessionId, groupId] of Object.entries(sessionGroups)) if (groupId === group.id) delete sessionGroups[sessionId];
    try {
      await this.patchState({ terminal_groups: this.groups().filter((candidate) => candidate.id !== group.id), session_groups: sessionGroups });
    } catch (error) { vscode.window.showErrorMessage(`TermDeck: ${error.message || error}`); }
  }

  async closeGroup(item) {
    const group = item?.group;
    if (!group) return;
    const ids = this.snapshot.sessions.filter((session) => this.snapshot.session_groups?.[session.session_id] === group.id)
      .map((session) => session.session_id);
    if (!ids.length || !(await this.confirm(`Close all ${ids.length} terminals in "${group.name}"?`, "Close all"))) return;
    try {
      for (const id of ids) await requestJson(`${this.serverUrl}/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
      await this.refresh();
    } catch (error) { vscode.window.showErrorMessage(`TermDeck: ${error.message || error}`); }
  }

  async toggleGroup(item) {
    if (item?.kind === "group") await this.setGroupCollapsed(item.group.id, !item.group.collapsed);
  }

  async setGroupCollapsed(groupId, collapsed) {
    const groups = this.groups();
    const current = groups.find((group) => group.id === groupId);
    if (!current || current.collapsed === collapsed) return;
    try { await this.patchState({ terminal_groups: groups.map((group) => group.id === groupId ? { ...group, collapsed } : group) }); }
    catch (error) { vscode.window.showErrorMessage(`TermDeck: ${error.message || error}`); }
  }

  async confirm(message, label) {
    return (await vscode.window.showWarningMessage(message, { modal: true }, label)) === label;
  }

  dispose() {
    this.started = false;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
    this.treeView.dispose();
    this.tree.dispose();
    this.nativeTerminals?.dispose();
    this.nativeTerminals = undefined;
    this.editorPanel?.dispose();
    this.editorPanel = undefined;
  }
}

module.exports = { NativeTermDeckClient, requestJson };
