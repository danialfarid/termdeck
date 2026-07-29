const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vscode = require("vscode");
const { NativeTermDeckClient, requestJson } = require("./native_sidebar");

let serverProcess;
let nativeClient;

function trimUrl(value) {
  return String(value || "").replace(/\/+$/, "");
}

function getWorkspaceRoot() {
  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor?.document?.uri) {
    const folder = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri);
    if (folder?.uri?.fsPath) return folder.uri.fsPath;
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
}

function parseServerAddress(serverUrl) {
  const parsed = new URL(serverUrl);
  return { host: parsed.hostname, port: parsed.port || (parsed.protocol === "https:" ? "443" : "80") };
}

function startTermDeck(context, serverUrl, workspaceRoot) {
  const configuredCommand = vscode.workspace.getConfiguration("termdeck").get("command", "termdeck");
  const fallbackCommand = path.resolve(context.extensionPath, "..", "..", ".venv", "bin", "termdeck");
  const command = configuredCommand === "termdeck" && !fs.existsSync(configuredCommand) && fs.existsSync(fallbackCommand)
    ? fallbackCommand : configuredCommand;
  const address = parseServerAddress(serverUrl);
  const args = ["--host", address.host, "--port", address.port, "--default-cwd", workspaceRoot, "--file-root", workspaceRoot];
  const environment = { ...process.env, TERMDECK_DEFAULT_CWD: workspaceRoot, TERMDECK_FILE_ROOT: workspaceRoot };
  serverProcess = cp.spawn(command, args, { cwd: workspaceRoot, env: environment, detached: false, stdio: "ignore" });
  serverProcess.once("error", (error) => vscode.window.showErrorMessage(`TermDeck could not start: ${error.message}`));
  serverProcess.unref();
}

async function waitForServer(serverUrl) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await requestJson(`${serverUrl}/api/projects`);
      return;
    } catch (_error) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`TermDeck did not become available at ${serverUrl}`);
}

async function ensureServer(context, workspaceRoot) {
  const configuration = vscode.workspace.getConfiguration("termdeck");
  const serverUrl = trimUrl(configuration.get("serverUrl", "http://127.0.0.1:8530"));
  try {
    await requestJson(`${serverUrl}/api/projects`);
    return serverUrl;
  } catch (_error) {
    if (!configuration.get("autoStart", true)) {
      throw new Error(`TermDeck is not running at ${serverUrl}. Start it or enable termdeck.autoStart.`);
    }
    startTermDeck(context, serverUrl, workspaceRoot);
    await waitForServer(serverUrl);
    return serverUrl;
  }
}

async function resolveVscodeProjectName(serverUrl, workspaceRoot) {
  const normalizedRoot = String(workspaceRoot || "").replace(/\\/g, "/").replace(/\/+$/, "");
  const projects = await requestJson(`${serverUrl}/api/projects`);
  const match = projects.find((project) => String(project.root || "").replace(/\\/g, "/").replace(/\/+$/, "") === normalizedRoot);
  if (match) return String(match.name || "");
  // Register a newly opened workspace immediately so the project exists in
  // TermDeck before the user creates a terminal in it. Do not register the
  // home-directory fallback used when VS Code has no workspace open.
  if (!normalizedRoot || normalizedRoot === os.homedir().replace(/\\/g, "/").replace(/\/+$/, "")) return "";
  const created = await requestJson(`${serverUrl}/api/projects`, {
    method: "POST", body: { root: workspaceRoot },
  });
  return String(created.name || "");
}

async function openFileInEditor(filePath, line, column, cwd) {
  let target = String(filePath || "").trim();
  if (!target) return;
  if (target === "~") target = os.homedir();
  else if (target.startsWith("~/")) target = path.join(os.homedir(), target.slice(2));
  if (!path.isAbsolute(target)) target = path.resolve(String(cwd || getWorkspaceRoot()), target);
  target = path.normalize(target);
  try {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
    const lineIndex = Math.max(0, Math.min(document.lineCount - 1, Number(line || 1) - 1));
    const columnIndex = Math.max(0, Number(column || 1) - 1);
    const position = new vscode.Position(lineIndex, columnIndex);
    await vscode.window.showTextDocument(document, {
      preview: false, preserveFocus: false, selection: new vscode.Range(position, position),
    });
  } catch (error) {
    vscode.window.showErrorMessage(`TermDeck could not open ${target}: ${error.message || error}`);
  }
}

function activate(context) {
  nativeClient = new NativeTermDeckClient(
    context,
    (workspaceRoot) => ensureServer(context, workspaceRoot),
    getWorkspaceRoot,
    resolveVscodeProjectName,
    openFileInEditor,
  );
  nativeClient.registerCommands(context);
  context.subscriptions.push(nativeClient);
  void nativeClient.start();
}

function deactivate() {
  nativeClient?.dispose();
  nativeClient = undefined;
  serverProcess = undefined;
}

module.exports = { activate, deactivate };
