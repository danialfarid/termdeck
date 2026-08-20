"""Standalone pty playground for testing how zsh/claude/codex actually behave at an unusual terminal
height (default 1000 rows), separate from TermDeck entirely.

Reuses termdeck.pty_process.PtyProcess directly (the same spawn/resize/env-scrub code TermDeck's real
sessions use), so behavior here is representative of the real app, not a reimplementation that could
drift from it. Deliberately does NONE of TermDeck's own compensation work on top -- no scrollback
stripping, no snapshot/replay, no forced-repaint-on-attach heuristics -- so what you see is the raw CLI
behavior TermDeck itself has to work around, not TermDeck's workarounds for it.

Every launch runs in a fresh, empty, non-TermDeck project directory (~/workspace/height-probe-root) with
no CLAUDE.md/AGENTS.md/.claude/.codex project settings, so results aren't shaped by this repo's own
config. Env is scrubbed the same way PtyProcess always scrubs it (drops CLAUDE_*-prefixed vars) so a
claude launched from inside a claude session doesn't inherit this session's identity and get confused --
that contamination was hit and fixed once already while testing this by hand.

    python3 tools/height_probe_server.py [--port 8532] [--termdeck http://127.0.0.1:8530]

Then open http://127.0.0.1:8532/ . Pick rows (1000 default), cols, a command, and Launch. The "resize"
and "force repaint (SIGWINCH nudge)" controls let you change an already-running session's height and
trigger TermDeck's exact attach-repaint sequence (shrink cols by 1, hold 80ms, restore) on demand.
"""

import argparse
import asyncio
import json
import sys
import uuid
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI, WebSocket, WebSocketDisconnect  # noqa: E402
from fastapi.responses import HTMLResponse  # noqa: E402
from pydantic import BaseModel  # noqa: E402
from starlette.requests import Request  # noqa: E402
from starlette.responses import Response  # noqa: E402

from termdeck.pty_process import PtyProcess  # noqa: E402

ROOT_DIR = Path.home() / "workspace" / "height-probe-root"
BUFFER_MAX_BYTES = 4_000_000
NUDGE_HOLD_SECONDS = 0.08  # matches TermdeckConfig.SCREEN_REPAINT_NUDGE_HOLD_SECONDS


@dataclass
class Session:
    session_id: str
    command: str
    cols: int
    rows: int
    proc: PtyProcess | None = None
    buffer: bytearray = field(default_factory=bytearray)
    clients: set[asyncio.Queue] = field(default_factory=set)
    exit_code: int | None = None


class LaunchRequest(BaseModel):
    command: str = ""
    cols: int = 104
    rows: int = 1000


class ResizeRequest(BaseModel):
    cols: int
    rows: int


sessions: dict[str, Session] = {}
termdeck_origin = "http://127.0.0.1:8530"


def create_app() -> FastAPI:
    app = FastAPI()

    @app.middleware("http")
    async def no_cache(request: Request, call_next) -> Response:
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        return response

    @app.get("/", response_class=HTMLResponse)
    async def index() -> str:
        return PAGE.replace("__TD__", termdeck_origin)

    @app.get("/api/sessions")
    async def list_sessions() -> list[dict]:
        return [
            {"id": s.session_id, "command": s.command or "(shell)", "cols": s.cols, "rows": s.rows,
             "alive": bool(s.proc and s.proc.alive), "exit_code": s.exit_code}
            for s in sessions.values()
        ]

    @app.post("/launch")
    async def launch(request: LaunchRequest) -> dict:
        session_id = uuid.uuid4().hex[:12]
        session = Session(session_id=session_id, command=request.command.strip(),
                          cols=max(2, request.cols), rows=max(2, request.rows))
        sessions[session_id] = session

        def on_output(data: bytes) -> None:
            session.buffer.extend(data)
            overflow = len(session.buffer) - BUFFER_MAX_BYTES
            if overflow > 0:
                del session.buffer[:overflow]
            for queue in list(session.clients):
                queue.put_nowait(data)

        def on_exit(_proc: PtyProcess, exit_code: int) -> None:
            session.exit_code = exit_code
            for queue in list(session.clients):
                queue.put_nowait(None)

        ROOT_DIR.mkdir(parents=True, exist_ok=True)
        session.proc = PtyProcess(session.command, ROOT_DIR, session.cols, session.rows,
                                  on_output, on_exit)
        return {"id": session_id}

    @app.post("/sessions/{session_id}/resize")
    async def resize(session_id: str, request: ResizeRequest) -> dict:
        session = sessions.get(session_id)
        if not session or not session.proc:
            return {"ok": False}
        session.cols, session.rows = max(2, request.cols), max(2, request.rows)
        session.proc.resize(session.cols, session.rows)
        return {"ok": True}

    @app.post("/sessions/{session_id}/repaint")
    async def repaint(session_id: str) -> dict:
        # Exactly session_manager._force_screen_repaint: shrink cols by 1, hold, restore. A pty only
        # raises SIGWINCH when the size actually changes, so re-sending the same size is a no-op --
        # this is the real mechanism TermDeck relies on to make a TUI redraw itself on demand.
        session = sessions.get(session_id)
        if not session or not session.proc or not session.proc.alive:
            return {"ok": False}
        nudged = session.cols - 1 if session.cols > 20 else session.cols + 1
        session.proc.resize(nudged, session.rows)
        await asyncio.sleep(NUDGE_HOLD_SECONDS)
        if session.proc.alive:
            session.proc.resize(session.cols, session.rows)
        return {"ok": True}

    @app.post("/sessions/{session_id}/kill")
    async def kill(session_id: str) -> dict:
        session = sessions.get(session_id)
        if session and session.proc:
            session.proc.kill()
        return {"ok": True}

    @app.websocket("/ws/{session_id}")
    async def ws_terminal(websocket: WebSocket, session_id: str) -> None:
        session = sessions.get(session_id)
        if not session:
            await websocket.close(code=4404)
            return
        await websocket.accept()
        await websocket.send_bytes(bytes(session.buffer))
        queue: asyncio.Queue = asyncio.Queue()
        session.clients.add(queue)

        async def pump_client_to_pty() -> None:
            while True:
                message = await websocket.receive_text()
                payload = json.loads(message)
                if payload.get("type") == "input" and session.proc:
                    session.proc.write(payload["data"].encode())
                elif payload.get("type") == "resize" and session.proc:
                    session.cols, session.rows = int(payload["cols"]), int(payload["rows"])
                    session.proc.resize(session.cols, session.rows)

        async def pump_queue_to_client() -> None:
            while True:
                item = await queue.get()
                if item is None:
                    await websocket.send_text(json.dumps({"type": "exit", "code": session.exit_code}))
                    continue
                await websocket.send_bytes(item)

        client_task = asyncio.create_task(pump_client_to_pty())
        queue_task = asyncio.create_task(pump_queue_to_client())
        try:
            await asyncio.wait({client_task, queue_task}, return_when=asyncio.FIRST_COMPLETED)
        except WebSocketDisconnect:
            pass
        finally:
            client_task.cancel()
            queue_task.cancel()
            session.clients.discard(queue)

    return app


PAGE = """<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>pty height probe</title>
<link rel="stylesheet" href="__TD__/static/vendor/xterm.css">
<style>
  body { margin: 0; background: #0a0c10; color: #d8dee9; font: 12px ui-monospace, Menlo, monospace; }
  #bar { display: flex; gap: 10px; align-items: center; padding: 8px 12px; border-bottom: 1px solid #222; flex-wrap: wrap; }
  #bar label { display: flex; gap: 5px; align-items: center; }
  select, input, button { background: #14171c; color: #d8dee9; border: 1px solid #2a2f37; border-radius: 4px; padding: 3px 6px; font: inherit; }
  input[type=number] { width: 70px; }
  button { cursor: pointer; }
  button:hover { border-color: #4c8; }
  #tabs { display: flex; gap: 4px; padding: 6px 12px; border-bottom: 1px solid #222; flex-wrap: wrap; }
  #tabs button { padding: 2px 8px; }
  #tabs button.active { border-color: #7fd4a0; color: #7fd4a0; }
  #status { margin-left: auto; color: #7fd4a0; }
  #term { position: absolute; inset: 78px 0 0 0; }
  .hint { color: #666; }
</style></head><body>
<div id="bar">
  <label>command
    <select id="command"><option value="">zsh</option><option value="claude">claude</option><option value="codex">codex</option></select>
  </label>
  <label>rows <input id="rows" type="number" value="1000" min="2" max="20000"></label>
  <label>cols <input id="cols" type="number" value="104" min="2" max="1000"></label>
  <button id="launch">launch</button>
  <span class="hint">cwd: ~/workspace/height-probe-root (fresh, no project config)</span>
  <span id="status">no session</span>
</div>
<div id="bar">
  <label>resize this session: rows <input id="liveRows" type="number" value="1000" min="2" max="20000"></label>
  <label>cols <input id="liveCols" type="number" value="104" min="2" max="1000"></label>
  <button id="applyResize">apply resize</button>
  <button id="repaint">force repaint (SIGWINCH nudge)</button>
  <button id="kill">kill session</button>
</div>
<div id="tabs"></div>
<div id="term"></div>
<script src="__TD__/static/vendor/xterm.js"></script>
<script src="__TD__/static/vendor/addon-fit.js"></script>
<script src="__TD__/static/vendor/addon-webgl.js"></script>
<script>
const sessions = new Map(); // id -> { term, ws, tabBtn }
let activeId = null;

function makeTermFor(id, cols, rows) {
  const container = document.createElement("div");
  container.style.position = "absolute"; container.style.inset = "0"; container.style.display = "none";
  document.getElementById("term").appendChild(container);
  const term = new Terminal({ fontSize: 13, fontFamily: '"SF Mono", Menlo, monospace', letterSpacing: -0.2,
                              scrollback: 20000, cursorBlink: true, allowProposedApi: true, cols, rows,
                              theme: { background: "#0a0c10", foreground: "#d8dee9" } });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(container);
  // Deliberately no fit.fit() here: fit() would recompute cols/rows from the container's pixel size and
  // overwrite the tall value we asked for. cols/rows stay exactly what was requested; the container's
  // real viewport just shows a scrollable window into that.
  if (window.WebglAddon) {
    try { const w = new WebglAddon.WebglAddon(); w.onContextLoss(() => { try { w.dispose(); } catch (e) {} }); term.loadAddon(w); }
    catch (e) {}
  }
  term.onData((data) => {
    const s = sessions.get(id);
    if (s && s.ws && s.ws.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify({ type: "input", data }));
  });
  return { term, container };
}

function showSession(id) {
  for (const [sid, s] of sessions) {
    s.container.style.display = sid === id ? "" : "none";
    s.tabBtn.classList.toggle("active", sid === id);
  }
  activeId = id;
  const s = sessions.get(id);
  document.getElementById("status").textContent = s ? `${id}  ${s.command || "(shell)"}  ${s.cols}x${s.rows}` : "no session";
  if (s) {
    document.getElementById("liveRows").value = s.rows;
    document.getElementById("liveCols").value = s.cols;
    s.term.focus();
  }
}

async function launch() {
  const command = document.getElementById("command").value;
  const rows = Number(document.getElementById("rows").value) || 1000;
  const cols = Number(document.getElementById("cols").value) || 104;
  const res = await fetch("/launch", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command, rows, cols }) });
  const { id } = await res.json();
  const { term, container } = makeTermFor(id, cols, rows);
  const tabBtn = document.createElement("button");
  tabBtn.textContent = `${command || "zsh"} ${cols}x${rows}`;
  tabBtn.onclick = () => showSession(id);
  document.getElementById("tabs").appendChild(tabBtn);
  const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/ws/${id}`);
  ws.binaryType = "arraybuffer";
  ws.onmessage = (e) => {
    if (typeof e.data === "string") {
      const msg = JSON.parse(e.data);
      if (msg.type === "exit") term.write(`\\r\\n\\x1b[31m[process exited: ${msg.code}]\\x1b[0m\\r\\n`);
      return;
    }
    term.write(new Uint8Array(e.data));
  };
  sessions.set(id, { term, container, ws, tabBtn, command: command || "(shell)", cols, rows });
  showSession(id);
}

document.getElementById("launch").onclick = launch;
document.getElementById("applyResize").onclick = async () => {
  if (!activeId) return;
  const s = sessions.get(activeId);
  const rows = Number(document.getElementById("liveRows").value) || s.rows;
  const cols = Number(document.getElementById("liveCols").value) || s.cols;
  await fetch(`/sessions/${activeId}/resize`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rows, cols }) });
  s.term.resize(cols, rows);
  s.cols = cols; s.rows = rows;
  s.ws.send(JSON.stringify({ type: "resize", cols, rows }));
  document.getElementById("status").textContent = `${activeId}  ${s.command}  ${cols}x${rows}`;
};
document.getElementById("repaint").onclick = () => { if (activeId) fetch(`/sessions/${activeId}/repaint`, { method: "POST" }); };
document.getElementById("kill").onclick = () => { if (activeId) fetch(`/sessions/${activeId}/kill`, { method: "POST" }); };
</script></body></html>
"""

app = create_app()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8532)
    parser.add_argument("--termdeck", default="http://127.0.0.1:8530")
    arguments = parser.parse_args()
    global termdeck_origin
    termdeck_origin = arguments.termdeck.rstrip("/")
    import uvicorn
    print(f"pty height probe on http://127.0.0.1:{arguments.port}  (root={ROOT_DIR}, "
          f"xterm assets from {termdeck_origin})")
    uvicorn.run(app, host="127.0.0.1", port=arguments.port, log_level="warning")


if __name__ == "__main__":
    main()
