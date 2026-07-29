const vscode = require("vscode");

function escapeAttribute(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

class TermDeckEditorPanel {
  constructor(context, serverUrl, project, workspaceRoot, onMessage) {
    this.context = context;
    this.serverUrl = serverUrl;
    this.project = project || "";
    this.workspaceRoot = workspaceRoot || "";
    this.onMessage = onMessage;
    this.panel = vscode.window.createWebviewPanel(
      "termdeck.editor",
      "TermDeck",
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.ready = false;
    this.pending = [];
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage((message) => {
      if (message?.type === "termdeck-editor-ready") {
        this.ready = true;
        this.flush();
      }
      this.onMessage?.(message);
    }, null, context.subscriptions);
    this.panel.onDidDispose(() => {
      this.ready = false;
      this.onMessage?.({ type: "termdeck-editor-disposed" });
    }, null, context.subscriptions);
  }

  updateContext(serverUrl, project, workspaceRoot) {
    this.serverUrl = serverUrl || this.serverUrl;
    this.project = project || "";
    this.workspaceRoot = workspaceRoot || this.workspaceRoot;
  }

  show() {
    this.panel.reveal(vscode.ViewColumn.One, false);
  }

  postMessage(message) {
    if (!this.panel) return;
    if (!this.ready) {
      this.pending.push(message);
      return;
    }
    void this.panel.webview.postMessage(message);
  }

  flush() {
    const pending = this.pending.splice(0);
    for (const message of pending) this.postMessage(message);
  }

  dispose() {
    this.pending = [];
    this.panel?.dispose();
  }

  html() {
    const params = new URLSearchParams({
      vscode: "1",
      native_terminal: "0",
      termdeck_editor: "1",
      workspace_root: this.workspaceRoot,
    });
    if (this.project) params.set("project", this.project);
    const frameUrl = escapeAttribute(`${this.serverUrl}/?${params.toString()}`);
    const origin = new URL(this.serverUrl).origin;
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin}; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';">
  <style>html, body, iframe { width: 100%; height: 100%; margin: 0; border: 0; overflow: hidden; background: #0b0e12; }</style>
</head>
<body>
  <iframe id="termdeck-frame" title="TermDeck" src="${frameUrl}" sandbox="allow-scripts allow-forms allow-same-origin"></iframe>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const frame = document.getElementById("termdeck-frame");
    frame.addEventListener("load", () => vscode.postMessage({ type: "termdeck-editor-ready" }));
    window.addEventListener("message", (event) => {
      if (!event.data) return;
      if (event.source === frame.contentWindow) vscode.postMessage(event.data);
      else frame.contentWindow.postMessage(event.data, "*");
    });
  </script>
</body>
</html>`;
  }
}

module.exports = { TermDeckEditorPanel };
