# Architecture

TermDeck is a single-process FastAPI server that owns a set of ptys and streams them to browsers over
WebSockets. There is no database, no message broker, and no build step — the frontend is plain JavaScript
served straight from `termdeck/static/`.

```
browser                          server                            OS
───────                          ──────                            ──
xterm.js  ──ws /ws/<id>──▶  TermdeckServer
                                  │
Monaco    ──http /api/*───▶  TerminalSessionManager ──▶ PtyProcess ──▶ dtach ──▶ $SHELL ──▶ claude/codex
                                  │                                                          │
transcript ─ws /ws/transcript─▶  TranscriptService ◀── watchdog ────────── ~/.claude/projects/*.jsonl
                                  │                                        ~/.codex/sessions/**
                             AgentSessionTracker ◀── lsof ────────────────────────┘
                                  │
                             SessionStore ──▶ ~/.termdeck/sessions.json
```

---

## Process model

Each terminal is a **real pty** (`pty.openpty`) whose child is `dtach`, which in turn runs your login shell,
which runs the command.

```
termdeck server
 └─ dtach -A ~/.termdeck/dtach/<id>.sock -E -z -r winch /bin/zsh -ilc "claude"
     └─ (daemonized master, outside the server's process tree)
         └─ /bin/zsh -ilc claude
             └─ claude
```

The `dtach` indirection is the whole reason terminals outlive the server. `dtach` daemonizes the master
process that holds the pty and the agent CLI, so when the TermDeck process dies the agent keeps running.
On startup, TermDeck checks each recorded socket: if it is still live it **reattaches** (printing
`──── reconnected (kept running) ────`), otherwise it respawns with a resume flag
(`──── restarted ────`).

The cost of this design is that the agent's pids are **not** reachable by walking the server's children.
`ProcTreeUtil` recovers them from the socket instead: `lsof -t <sock>` yields the master, then a ppid walk
expands to the shell and CLI descendants. `ResourceStatsService` uses the same trick for per-terminal
cpu/rss.

---

## Modules

### Core

| Module | Responsibility |
|---|---|
| `cli.py` | The `termdeck` command. Translates flags into `TERMDECK_*` variables **before** importing anything else, then dispatches to run / `doctor` / `service`. |
| `config.py` | `TermdeckConfig` — every constant in one place: routes, paths, limits, escape sequences, resume command shapes. Reads the environment once at import time. |
| `platform_paths.py` | Resolves OS-dependent values: binary discovery (override → `PATH` → well-known dirs), trash directory, login shell, data directory. |
| `server.py` | `TermdeckServer` — HTTP + WebSocket surface. Session CRUD, file and search APIs, static UI, one WebSocket per terminal. |
| `session_manager.py` | `TerminalSessionManager` — creates, respawns, and tears down terminals; broadcasts pty output to attached client queues; owns the resume logic. |
| `pty_process.py` | `PtyProcess` — one command on one pty. Non-blocking reads pumped into the event loop, buffered writes, winsize, signals. |
| `models.py` | `SessionRecord`, `AgentKind`, and the WebSocket/API field-name constants mirrored by `static/app.js`. |

### Persistence

| Module | Responsibility |
|---|---|
| `session_store.py` | `SessionStore` (atomic JSON rewrite of all terminals) and `ClosedSessionStore` (capped history of closed ones). |
| `settings_store.py` | UI settings, stored server-side so they follow you across browsers. |
| `project_registry.py` | Named base directories addressable as `/p/<name>`; auto-registered on first terminal in a directory. |

### Agent integration

| Module | Responsibility |
|---|---|
| `agent_session_tracker.py` | Resolves which CLI session a terminal is on *right now*. See below. |
| `transcript_service.py` | Reads the CLI's own on-disk log (codex rollout / claude jsonl) into a clean conversation transcript for the Markdown view. |
| `claude_activity_watcher.py` | Delivers Claude JSONL changes via `watchdog` instead of polling transcript files. |
| `draft_tracker.py` | Reconstructs unsubmitted input from the raw keystroke stream so a restart can re-inject it. |

### Files

| Module | Responsibility |
|---|---|
| `file_service.py` | Listing, reading, writing, renaming, moving, trashing — all confined to the file root, size-capped, binary-refusing. |
| `search_service.py` | ripgrep wrapper: fixed-string or regex, smart-case, gitignore-aware, glob filters, find-usages. |
| `proc_tree.py` | Socket → master pid → descendant pids. |
| `stats_service.py` | Per-terminal and whole-app cpu/rss sampling. |
| `util.py` | `OscTitleParser` (OSC 0/1/2 titles across chunk boundaries) and `TimeUtil` (EST-naive timestamps). |

### Packaging

| Module | Responsibility |
|---|---|
| `environment_check.py` | Resolves and reports external dependencies; raises with install hints if a required one is missing. |
| `service_installer.py` | Generates and manages the launchd agent / systemd user unit. |

---

## How agent session tracking works

`AgentSessionTracker` answers one question continuously: *which CLI session is this terminal on?* It uses
two signals, in order of authority.

**1. Open file handles (exact).** `lsof -a -p <pids> -Fn` over the terminal's process tree shows which
session file the CLI currently holds open. This catches everything — picker-resumes, `/clear`, in-TUI session
switches — because it observes the CLI's actual state rather than inferring it. Codex holds its rollout file
open, so Codex attribution is always exact.

**2. Newly created session files (inferred).** Claude only opens its JSONL briefly per turn, so handles are
usually invisible. The fallback watches `~/.claude/projects/<munged-cwd>/` for files created since the
terminal spawned and credits the terminal that was most recently typed into (within a short window). Files
that merely *grew* are deliberately ignored — growth doesn't distinguish between two terminals in the same
directory.

Signal 2 is why two Claude terminals in the same directory switching sessions simultaneously can, rarely, be
mis-attributed. It is the one imprecise thing in the system, and it is documented rather than hidden.

The resolved ID is written into `SessionRecord.agent_session_id`, which is what makes restart-and-resume
work:

| Agent | Respawn |
|---|---|
| Claude | `<original command> --resume <id>` |
| Codex | `codex resume <id>` |

Fork uses `--fork-session` / `codex fork` to branch a copy into a new terminal.

---

## The terminal WebSocket protocol

One WebSocket per terminal, at `/ws/<session_id>`.

**Server → client**

- **Binary frames** — raw pty output. On connect, the scrollback ring buffer is replayed first, so a new tab
  immediately shows what was already on screen.
- **Text frames (JSON)** — control events: title changes, exit notifications, resume dividers.

**Client → server**

- **Text frames (JSON)** — `input`, `resize`, `draft_sync`, `submit`, `queue_edit`.

Two more sockets exist: `/ws/status` (a single connection carrying title, status, and processing changes for
every terminal, so the sidebar updates without polling) and `/ws/transcript/<session_id>` (Markdown
transcript updates driven by `watchdog` file events).

Because output is a ring buffer rather than a log, memory per terminal is bounded and a slow client can't
stall the pty reader.

---

## Frontend

`termdeck/static/app.js` is a single plain-JS application class — no framework, no bundler, no build step.
Third-party components are vendored under `static/vendor/` so the app works fully offline and no CDN can
change behaviour under you:

| Component | Used for |
|---|---|
| xterm.js + fit addon | Terminal rendering |
| Monaco Editor | The file viewer/editor (the real VS Code component) |
| VS Code Codicons | UI icons |
| Material Icon Theme | File-type icons in the tree |
| marked | Markdown rendering in the transcript view |

Licenses for all of these are recorded in [NOTICE](../NOTICE).

---

## Conventions

Contributions should match the surrounding code:

- **Descriptive names over comments.** Comments are reserved for class-level docs (workflow, contracts,
  corner cases), not for narrating code.
- **Constants, not literals.** Route strings, escape sequences, and limits live in `TermdeckConfig`.
- **No module-level functions.** Behaviour belongs to a class, as a method or a static method.
- **Fail fast.** Never catch bare `Exception`, never swallow an error to keep going, never guard an expected
  key with `if x in y` — a missing expected key is a bug and should raise.
- **Type hints everywhere**, including precise `dict[K, V]` types.
- **120-column lines**, and keep definitions and call sites dense.
