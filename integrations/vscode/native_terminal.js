const crypto = require("crypto");
const http = require("http");
const https = require("https");
const vscode = require("vscode");

const RECONNECT_MS = 1500;
const TITLE_STATUS_RE = /^[\u2800-\u28ff○-◗⏳⚡✳](\s+)/;
const PATH_LINK_RE = /(?:~\/|\.{1,2}\/|\/)?[\w@%+=.-]+(?:\/[\w@%+=.-]+)*\.[A-Za-z][A-Za-z0-9]{0,7}(?::\d+){0,2}/g;
const KNOWN_EXTS = new Set(["py", "md", "json", "js", "ts", "tsx", "css", "html", "sh", "zsh", "txt", "yaml", "yml",
  "toml", "csv", "log", "plist", "sql", "xml", "ini", "cfg", "lock", "ipynb", "rs", "go", "c", "h", "cpp", "hpp", "java"]);

function parseFileLink(linkText) {
  let value = String(linkText || "").trim().replace(/[),.;]+$/, "");
  let line = null;
  let column = null;
  const match = value.match(/:(\d+)(?::(\d+))?$/);
  if (match) {
    line = Number(match[1]);
    column = match[2] ? Number(match[2]) : null;
    value = value.slice(0, match.index);
  }
  const fileName = value.split("/").pop() || "";
  const extension = fileName.includes(".") ? fileName.split(".").pop().toLowerCase() : "";
  if (!value || (!value.includes("/") && !KNOWN_EXTS.has(extension))) return null;
  return { path: value, line, column };
}

function terminalTitle(session, unread) {
  const title = session?.title_user_set
    ? String(session.title || session.session_id)
    : String(session?.cli_title || session?.title || session?.session_id || "Terminal");
  const marker = session?.processing ? "⟳ " : unread ? "● " : "";
  return `${marker}${title.replace(TITLE_STATUS_RE, "")}`;
}

class RawWebSocket {
  constructor(url, handlers = {}) {
    this.url = url;
    this.handlers = handlers;
    this.request = null;
    this.socket = null;
    this.receiveBuffer = Buffer.alloc(0);
    this.fragmentOpcode = null;
    this.fragmentParts = [];
    this.closed = false;
    this.closeNotified = false;
  }

  connect() {
    const target = new URL(this.url);
    const transport = target.protocol === "wss:" ? https : http;
    const key = crypto.randomBytes(16).toString("base64");
    const request = transport.request({
      hostname: target.hostname,
      port: target.port || (target.protocol === "wss:" ? 443 : 80),
      path: `${target.pathname || "/"}${target.search || ""}`,
      method: "GET",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": key,
      },
    });
    this.request = request;
    request.once("upgrade", (response, socket, head) => {
      if (this.closed || response.statusCode !== 101) {
        socket.destroy();
        this.notifyClose(new Error(`WebSocket upgrade failed (${response.statusCode})`));
        return;
      }
      this.socket = socket;
      this.receiveBuffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
      socket.on("data", (chunk) => {
        this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk]);
        this.parseFrames();
      });
      socket.on("error", (error) => this.notifyClose(error));
      socket.on("close", () => this.notifyClose());
      this.handlers.onOpen?.();
      this.parseFrames();
    });
    request.once("response", (response) => {
      response.resume();
      this.notifyClose(new Error(`WebSocket request returned HTTP ${response.statusCode}`));
    });
    request.once("error", (error) => this.notifyClose(error));
    request.end();
  }

  sendJson(payload) {
    this.send(Buffer.from(JSON.stringify(payload), "utf8"), 0x1);
  }

  send(payload, opcode = 0x1) {
    if (!this.socket || this.closed) return false;
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    const mask = crypto.randomBytes(4);
    let header;
    if (data.length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | data.length]);
    } else if (data.length <= 0xffff) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(data.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(data.length), 2);
    }
    const masked = Buffer.allocUnsafe(data.length);
    for (let index = 0; index < data.length; index += 1) masked[index] = data[index] ^ mask[index % 4];
    this.socket.write(Buffer.concat([header, mask, masked]));
    return true;
  }

  close() {
    if (this.closed) return;
    if (this.socket) {
      try { this.send(Buffer.alloc(0), 0x8); } catch (_error) { /* socket is already closing */ }
      this.closed = true;
      this.socket.end();
      this.socket.destroySoon?.();
    } else if (this.request) {
      this.closed = true;
      this.request.destroy();
    } else this.closed = true;
    this.notifyClose();
  }

  notifyClose(error) {
    if (this.closeNotified) return;
    this.closeNotified = true;
    this.handlers.onClose?.(error);
  }

  parseFrames() {
    while (this.receiveBuffer.length >= 2) {
      const first = this.receiveBuffer[0];
      const second = this.receiveBuffer[1];
      const opcode = first & 0x0f;
      const fin = !!(first & 0x80);
      const masked = !!(second & 0x80);
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.receiveBuffer.length < offset + 2) return;
        length = this.receiveBuffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.receiveBuffer.length < offset + 8) return;
        const longLength = this.receiveBuffer.readBigUInt64BE(offset);
        if (longLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          this.close();
          return;
        }
        length = Number(longLength);
        offset += 8;
      }
      const maskOffset = offset;
      if (masked) offset += 4;
      if (this.receiveBuffer.length < offset + length) return;
      const mask = masked ? this.receiveBuffer.subarray(maskOffset, maskOffset + 4) : null;
      const payload = Buffer.from(this.receiveBuffer.subarray(offset, offset + length));
      this.receiveBuffer = this.receiveBuffer.subarray(offset + length);
      if (mask) {
        for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
      }
      if (opcode === 0x8) {
        this.closed = true;
        this.notifyClose();
        this.socket?.end();
      } else if (opcode === 0x9) {
        this.send(payload, 0xA);
      } else if (opcode === 0x1 || opcode === 0x2) {
        if (fin) this.emitMessage(opcode, payload);
        else {
          this.fragmentOpcode = opcode;
          this.fragmentParts = [payload];
        }
      } else if (opcode === 0x0 && this.fragmentOpcode !== null) {
        this.fragmentParts.push(payload);
        if (fin) {
          this.emitMessage(this.fragmentOpcode, Buffer.concat(this.fragmentParts));
          this.fragmentOpcode = null;
          this.fragmentParts = [];
        }
      }
    }
  }

  emitMessage(opcode, payload) {
    if (opcode === 0x1) this.handlers.onText?.(payload.toString("utf8"));
    if (opcode === 0x2) this.handlers.onBinary?.(payload);
  }
}

class NativeTerminalManager {
  constructor(context, serverUrl, openFile, onActiveSession) {
    this.context = context;
    this.serverUrl = serverUrl;
    this.openFile = openFile;
    this.onActiveSession = onActiveSession;
    this.entries = new Map();
    this.activeId = null;
    this.disposables = [];
    this.disposables.push(vscode.window.onDidCloseTerminal((terminal) => {
      for (const [sessionId, entry] of this.entries) {
        if (entry.terminal !== terminal) continue;
        if (!entry.disposing) this.detach(sessionId);
        break;
      }
    }));
    this.disposables.push(vscode.window.onDidChangeActiveTerminal((terminal) => {
      const entry = [...this.entries.values()].find((candidate) => candidate.terminal === terminal);
      if (!entry) return;
      this.activeId = entry.id;
      this.onActiveSession?.(entry.id);
    }));
    this.disposables.push(vscode.window.registerTerminalLinkProvider({
      provideTerminalLinks: (context) => {
        const entry = [...this.entries.values()].find((candidate) => candidate.terminal === context.terminal);
        if (!entry) return [];
        const links = [];
        for (const match of context.line.matchAll(PATH_LINK_RE)) {
          const parsed = parseFileLink(match[0]);
          if (!parsed) continue;
          const link = new vscode.TerminalLink(match.index, match[0].length, "Open in VS Code");
          link.data = { ...parsed, cwd: entry.cwd };
          links.push(link);
        }
        return links;
      },
      handleTerminalLink: (link) => {
        if (link.data && this.openFile) {
          void this.openFile(link.data.path, link.data.line, link.data.column, link.data.cwd);
        }
      },
    }));
  }

  setServerUrl(serverUrl) {
    this.serverUrl = serverUrl;
  }

  websocketUrl(sessionId) {
    const target = new URL(this.serverUrl);
    target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
    target.pathname = `${target.pathname.replace(/\/+$/, "")}/ws/${encodeURIComponent(sessionId)}`;
    target.search = "";
    return target.toString();
  }

  showSession(session, unread = false) {
    if (!session?.session_id) return;
    const entry = this.updateSession(session, true, unread);
    if (!entry) return;
    this.activeId = session.session_id;
    entry.terminal.show(false);
  }

  updateSession(session, create = true, unread = false) {
    if (!session?.session_id) return;
    let entry = this.entries.get(session.session_id);
    if (!entry && !create) return;
    if (!entry) entry = this.createEntry(session);
    const title = terminalTitle(session, unread);
    if (title !== entry.title) {
      entry.title = title;
      entry.nameEmitter.fire(title);
    }
    if (session.cwd && entry.cwd !== session.cwd) {
      entry.cwd = session.cwd;
    }
    return entry;
  }

  closeSession(sessionId) {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    entry.disposing = true;
    clearTimeout(entry.reconnectTimer);
    entry.socket?.close();
    entry.socket = null;
    this.entries.delete(sessionId);
    entry.terminal.dispose();
  }

  syncSessions(sessionIds) {
    const keep = new Set((sessionIds || []).map((id) => String(id)));
    for (const [sessionId, entry] of [...this.entries]) {
      if (!keep.has(sessionId)) this.closeSession(sessionId);
    }
  }

  detach(sessionId) {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    entry.disposing = true;
    clearTimeout(entry.reconnectTimer);
    entry.socket?.close();
    entry.socket = null;
    this.entries.delete(sessionId);
  }

  dispose() {
    for (const sessionId of [...this.entries.keys()]) this.closeSession(sessionId);
    this.entries.clear();
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }

  createEntry(session) {
    const writeEmitter = new vscode.EventEmitter();
    const closeEmitter = new vscode.EventEmitter();
    const nameEmitter = new vscode.EventEmitter();
    const entry = {
      id: session.session_id,
      title: terminalTitle(session, false),
      cwd: session.cwd,
      writeEmitter,
      closeEmitter,
      nameEmitter,
      socket: null,
      reconnectTimer: 0,
      dimensions: null,
      pendingInput: [],
      opened: false,
      disposing: false,
    };
    const pty = {
      onDidWrite: writeEmitter.event,
      onDidClose: closeEmitter.event,
      onDidChangeName: nameEmitter.event,
      open: (dimensions) => {
        entry.opened = true;
        entry.dimensions = dimensions;
        this.connect(entry);
      },
      close: () => {
        if (!entry.disposing) this.detach(entry.id);
      },
      handleInput: (data) => this.send(entry, { type: "input", data }),
      setDimensions: (dimensions) => {
        entry.dimensions = dimensions;
        this.sendResize(entry);
      },
    };
    entry.pty = pty;
    entry.terminal = vscode.window.createTerminal({ name: entry.title, cwd: entry.cwd, pty });
    this.entries.set(entry.id, entry);
    return entry;
  }

  connect(entry) {
    if (entry.disposing || !entry.opened) return;
    clearTimeout(entry.reconnectTimer);
    entry.socket?.close();
    const socket = new RawWebSocket(this.websocketUrl(entry.id), {
      onOpen: () => {
        entry.socket = socket;
        this.sendResize(entry);
        for (const data of entry.pendingInput.splice(0)) this.send(entry, { type: "input", data });
      },
      onBinary: (data) => entry.writeEmitter.fire(data.toString("utf8")),
      onText: (text) => this.handleControl(entry, text),
      onClose: () => {
        if (entry.socket === socket) entry.socket = null;
        if (!entry.disposing) this.scheduleReconnect(entry);
      },
    });
    entry.socket = socket;
    socket.connect();
  }

  scheduleReconnect(entry) {
    if (entry.reconnectTimer || entry.disposing) return;
    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = 0;
      this.connect(entry);
    }, RECONNECT_MS);
  }

  send(entry, message) {
    if (entry.socket?.sendJson(message)) return;
    if (message.type === "input" && entry.pendingInput.length < 100) entry.pendingInput.push(message.data);
  }

  sendResize(entry) {
    if (!entry.dimensions) return;
    this.send(entry, { type: "resize", cols: entry.dimensions.columns, rows: entry.dimensions.rows });
  }

  handleControl(entry, text) {
    let message;
    try { message = JSON.parse(text); } catch (_error) { return; }
    if (message.type === "exit") {
      entry.writeEmitter.fire(`\r\n\x1b[2m[termdeck] process exited (${message.code})\x1b[0m\r\n`);
    } else if (message.type === "deleted") {
      entry.disposing = true;
      this.entries.delete(entry.id);
      entry.closeEmitter.fire();
      entry.socket?.close();
      entry.socket = null;
    }
  }
}

module.exports = { NativeTerminalManager };
