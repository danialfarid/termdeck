class TermdeckLspTransport {
  constructor() {
    this.websocket = null;
    this.generation = 0;
    this.requestSequence = 0;
    this.pendingRequests = new Map();
    this.connectionAttempt = null;
    this.eventHandler = null;
    this.available = false;
  }

  async connect(root, path, language, text, eventHandler) {
    this.close();
    const generation = ++this.generation;
    this.eventHandler = eventHandler;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const params = new URLSearchParams({ root, path, language });
    const websocket = new WebSocket(`${protocol}//${location.host}/ws/lsp?${params}`);
    this.websocket = websocket;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled || generation !== this.generation) return;
        settled = true;
        if (this.connectionAttempt?.generation === generation) this.connectionAttempt = null;
        websocket.close();
        reject(new Error("language server connection timed out"));
      }, 20000);
      this.connectionAttempt = { generation, reject, timeout };
      websocket.onopen = () => websocket.send(JSON.stringify({ type: "open", text }));
      websocket.onmessage = (event) => {
        if (generation !== this.generation) return;
        let message;
        try {
          message = JSON.parse(event.data);
        } catch (error) {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            if (this.connectionAttempt?.generation === generation) this.connectionAttempt = null;
            reject(error);
          }
          return;
        }
        if (message.type === "status") {
          this.available = message.available === true;
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            if (this.connectionAttempt?.generation === generation) this.connectionAttempt = null;
            resolve(message);
          }
        }
        if (message.type === "response") this.resolveRequest(message);
        else this.eventHandler?.(message);
      };
      websocket.onerror = () => {
        if (settled || generation !== this.generation) return;
        settled = true;
        clearTimeout(timeout);
        if (this.connectionAttempt?.generation === generation) this.connectionAttempt = null;
        reject(new Error("language server connection failed"));
      };
      websocket.onclose = () => {
        if (generation !== this.generation) return;
        this.available = false;
        this.rejectPendingRequests(new Error("language server disconnected"));
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          if (this.connectionAttempt?.generation === generation) this.connectionAttempt = null;
          reject(new Error("language server disconnected before initialization"));
        }
      };
    });
  }

  request(method, params) {
    if (!this.available || !this.websocket || this.websocket.readyState !== WebSocket.OPEN) return Promise.resolve(null);
    const requestId = ++this.requestSequence;
    this.websocket.send(JSON.stringify({ type: "request", requestId, method, params }));
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`language server timed out handling ${method}`));
      }, 22000);
      this.pendingRequests.set(requestId, { resolve, reject, timeout });
    });
  }

  notify(type, text) {
    if (!this.available || !this.websocket || this.websocket.readyState !== WebSocket.OPEN) return;
    this.websocket.send(JSON.stringify({ type, text }));
  }

  resolveRequest(message) {
    const pending = this.pendingRequests.get(message.requestId);
    if (!pending) return;
    this.pendingRequests.delete(message.requestId);
    clearTimeout(pending.timeout);
    if (message.error) pending.reject(new Error(message.error.message || "language server request failed"));
    else pending.resolve(message.result);
  }

  rejectPendingRequests(error) {
    const pendingRequests = [...this.pendingRequests.values()];
    this.pendingRequests.clear();
    for (const pending of pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
  }

  close() {
    this.generation += 1;
    this.available = false;
    if (this.connectionAttempt) {
      clearTimeout(this.connectionAttempt.timeout);
      this.connectionAttempt.reject(new Error("language server connection replaced"));
      this.connectionAttempt = null;
    }
    this.rejectPendingRequests(new Error("language server document closed"));
    if (this.websocket) {
      this.websocket.onclose = null;
      this.websocket.close();
    }
    this.websocket = null;
    this.eventHandler = null;
  }
}

window.TermdeckLspTransport = TermdeckLspTransport;
