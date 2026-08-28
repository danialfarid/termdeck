# Agent CLI API — one class per agent

Goal: adding a new agent CLI (a `claude`/`codex`-like tool) means writing **one Python class**,
registering it in one list, and optionally adding one small client behavior object + icon. No
scattered `if kind == CLAUDE` branches.

## Why

As of the checkpoint before this refactor there were ~300 agent-kind branch sites:
`session_manager.py` (115), `history_index.py` (39), `transcript_service.py` (35),
`agent_session_tracker.py` (28), `server.py` (19), `app.js` (65). Payload parsing was duplicated
between `transcript_service` and `history_index`. Per-agent session state (claude_*, codex_*,
agy_* fields) accreted directly on `ManagedSession`.

## The inventory (what "agent things" exist)

Every per-agent behavior in the codebase falls into one of these concerns:

1. **Identity & detection** — kind string, executable name, model-field aliases
   (`gemini` → agy), detecting the kind from a shell command's tokens.
2. **Command lifecycle** — building the spawn command (permission flags, model flags, fixed
   flags like codex `--no-alt-screen`), resume command, fork command, stripping session args
   for restart, swapping permission flags on a saved command.
3. **Transcript store discovery** — where the CLI writes its session files
   (`~/.claude/projects/<munged-cwd>/`, `~/.codex/sessions/Y/M/D/`, agy brain dir), resolving
   the transcript path for (cwd, agent_session_id), enumerating candidate session files for
   new-session detection, extracting the session id from a path, detection retry policy.
4. **Transcript parsing** — jsonl payload → turns, user-payload predicate, payload text,
   conversation text, title/cwd extraction, user timestamps. Used by BOTH the transcript
   service (live view) and the history index (search) — single implementation.
5. **Activity / processing** — is the agent working (transcript activity, subagent scans,
   OSC-title spinner), keepalive windows, interrupted state.
6. **Titles / attention / rename** — session title sources, "needs permission" detection from
   the title, rename mechanism (claude `--name` flag / codex `/rename` command).
7. **Input interpretation** — what Enter/Ctrl-C/Tab mean for this CLI (prompt submitted,
   interrupt, queue prompt).
8. **Terminal replay** — whether raw pty recordings are kept and replayed
   (`records_raw_replay`), restart divider policy.
9. **Client presentation & behavior** — label, icon, permission options offered in the UI,
   composer prompt marker, replay flags on the websocket URL, JS-only quirks (codex
   command-collapse anchor, claude status-row refresh).

## Design

### Python: `termdeck/agents/` package

```
termdeck/agents/
  __init__.py    # registry: AGENT_CLIS, agent_cli(kind), detect_agent_cli(command),
                 # resolve_model_alias(name)
  base.py        # AgentCli base class; ShellCli (kind="none") null object
  claude.py      # ClaudeCli
  codex.py       # CodexCli
  agy.py         # AgyCli
```

- Adapters are **stateless singletons** (small path caches allowed). All session state stays
  on `ManagedSession`; per-agent state moves into `ms.agent_state = agent.new_session_state()`
  (phase 4).
- `ShellCli` is a **null object**: every method has shell-sane defaults so orchestration code
  never writes `if kind != NONE`. Use `agent.is_agent` where the distinction matters.
- **Capability flags, not identity checks.** `if ms.record.agent_kind in (CLAUDE, CODEX)`
  becomes `if agent.records_raw_replay` / `agent.supports_fork` / etc. New agents opt into
  behaviors by flipping flags, and orchestration code never learns their names.
- The `AgentKind` enum dies at the end of the migration; kinds are plain strings validated
  against the registry (an enum is exactly the closed world this refactor removes).

### The base class surface

```python
class AgentCli:
    # -- identity --------------------------------------------------------
    kind: str                       # "claude" — serialized in SessionRecord.agent_kind
    executable: str                 # binary name; also the command-detection token
    label: str                      # "Claude" — UI display name
    model_aliases: tuple[str, ...]  # extra names accepted in the create-session model field
    is_agent: bool = True           # False only for ShellCli

    # -- capabilities ----------------------------------------------------
    supports_resume: bool = False
    supports_fork: bool = False
    records_raw_replay: bool = False   # keep+replay raw pty recordings
    has_prompt_queue: bool = False     # Tab queues the composer draft (codex)

    # -- command lifecycle ----------------------------------------------
    base_flags: tuple[str, ...] = ()            # always-on flags (codex --no-alt-screen)
    permission_flags: dict[str, tuple[str, ...]] # permission name (+aliases) -> CLI flags
    ui_permissions: tuple[str, ...]              # subset offered by the client UI
    def model_arguments(self, model_name) -> tuple[str, ...]
    def resolve_session_reference(self, reference) -> str      # codex: name -> id via index
    def build_command(self, permission, model_name, session_ref) -> str
    def resume_command(self, original_command, agent_session_id) -> str
    def fork_command(self, original_command, agent_session_id, session_name="") -> str
    def strip_session_arguments(self, parts) -> list[str]
    def set_permission(self, command, permission) -> str

    # -- transcript store ------------------------------------------------
    def transcript_path(self, cwd, agent_session_id) -> Path | None
    def candidate_session_files(self, cwd) -> list[tuple[Path, str]]
    def owns_transcript_path(self, path) -> bool
    def session_id_from_path(self, path) -> str | None
    detect_retry_seconds: float = 1.0
    def detection_active(self, attempts, deadline_monotonic) -> bool

    # -- transcript parsing (shared by live view + search index) ---------
    def parse_transcript_lines(self, lines) -> list[dict]
    def is_user_payload(self, payload) -> bool
    def payload_text(self, payload) -> str
    def is_conversation_payload(self, payload) -> bool
    def conversation_payload_text(self, payload) -> str
    def title_from_payload(self, payload) -> str
    def cwd_from_payload(self, path, payload) -> str

    # -- activity / titles / attention / rename --------------------------
    def refresh_activity(self, ms, tracker) -> None
    def is_processing(self, ms) -> bool
    def activity_detail(self, ms) -> dict | None   # {"main": bool, "<kind>": count} per background-activity kind;
                                                   # rides status payloads as "activity", client renders one dot per kind
    def title_requires_attention(self, title) -> bool
    def session_title(self, cwd, agent_session_id) -> str | None
    async def rename_after_fork(self, manager, ms, title) -> None

    # -- input interpretation --------------------------------------------
    def interpret_input(self, ms, text) -> InputSignals   # prompt_submitted / interrupt / queue

    # -- per-agent session state (phase 4) -------------------------------
    def new_session_state(self) -> object | None

    # -- client -----------------------------------------------------------
    prompt_marker: str = ""          # composer row marker ("❯" claude, "›" codex)
    def client_descriptor(self) -> dict   # everything app.js needs, served at /api/agents
```

### Registry

```python
# termdeck/agents/__init__.py — adding an agent is: write the class, add it here.
AGENT_CLIS: dict[str, AgentCli] = {a.kind: a for a in (ShellCli(), ClaudeCli(), CodexCli(), AgyCli())}

def agent_cli(kind: str) -> AgentCli           # raises on unknown kind
def detect_agent_cli(command: str) -> AgentCli # by executable token; ShellCli fallback
def resolve_model_alias(name: str) -> str      # "gemini" -> "agy"; unknown -> unchanged
```

Explicit dict, no metaclass/auto-registration magic — debuggable, and one obvious place to look.

### Client: served registry + one behavior object per agent

- `GET /api/agents` returns `{kind: client_descriptor()}`: label, ui_permissions,
  prompt_marker, records_raw_replay, has_prompt_queue, supports_fork. app.js loads it at
  bootstrap into `this.agentSpecs` and all data-driven sites read from it
  (labels, permission menus, composer markers, ws replay flags).
- JS-only quirks live in one `AGENT_CLIENT_BEHAVIORS = { codex: {...}, claude: {...} }`
  registry near the top of app.js (command-collapse anchor, reflow deferral, status-row
  refresh, focus refresh). Generic code calls optional hooks:
  `this.agentBehavior(view)?.afterPromptSubmit?.(view)`.
- Icons: `AgentCli.icon_svg` (inline single-color SVG, `fill="currentColor"`) travels in the
  descriptor. The sidebar terminal icon, and the per-agent toggles in the "Show terminal icons"
  settings row, are both built from the registry — a new adapter's icon appears in both without
  client changes. Empty means the generic codicon terminal glyph.

### Later additions (post-migration)

- **Token usage**: `usage_from_payload(payload)` normalizes a transcript line's token report;
  `latest_usage(cwd, id)` tail-reads the transcript for the newest one. Served at
  `GET /api/sessions/{id}/usage` as `{context_tokens, output_tokens, context_window, total_tokens}`.
- **Notifications**: `notifier.AgentNotifier` observes every status payload and fires macOS
  notifications on attention/idle transitions (UiSettings `notify_attention` / `notify_agent_idle`).
- **AiderCli** (`aider`): the sessionless archetype — aider has no session ids, just one chat
  history per directory that `--restore-chat-history` reloads, so `sessionless = True` turns off
  detection, the restart identity gate, and the new-binding prompt wait; a respawn in the same
  cwd IS the resume.
- **Output-driven processing** (`processing_from_output = True`, aider + opencode): neither CLI
  emits the spinner-marked titles `ms.processing` keys on, but both animate their own UI while
  working and are silent at rest (measured: output every second of a turn, nothing at idle). The
  base `on_pty_output` arms a keepalive window on each chunk — ignoring input echo, resize
  repaints, and the reattach-repaint suppression window — `is_processing` reads it, and the
  manager's `_schedule_output_activity_expiry` broadcasts the idle transition when silence
  outlasts the window. Requires `new_session_state()` returning an `OutputActivityState`.
- **OpencodeCli** (`opencode`): sessions live in a sqlite database, not files, so every
  file-shaped base hook stays unimplemented and the adapter uses read-only queries for
  detection (the `detection_fallback_session_id` hook), titles, and token usage; resume is
  `opencode -s <id>`, fork adds `--fork`. It is also the `fullscreen_tui = True` archetype: its
  TUI manages its own scrolling and must see the real viewport height, so the client sizes the
  pty to the visible rows instead of the tall canvas (on a tall pty it top-anchors the
  conversation and bottom-anchors the composer, leaving the visible window on the blank gap
  between them).
- **GeminiCli was built and then retired** (`termdeck/agents/_/gemini.py`): Google deprecated
  gemini-cli outright in favor of the Antigravity suite, which AgyCli already covers ("gemini"
  stays an agy model alias). The retired adapter remains a worked example of a foreign format —
  whole-document JSON sessions rewritten in place, parsed by joining the tail-reader's lines back
  into a document.

### What a new agent looks like

```python
# termdeck/agents/aider.py
class AiderCli(AgentCli):
    kind = "aider"
    executable = "aider"
    label = "Aider"
    supports_resume = True
    permission_flags = {"default": (), "full-access": ("--yes-always",)}
    ui_permissions = ("default", "full-access")
    def transcript_path(self, cwd, sid): ...
    def parse_transcript_lines(self, lines): ...
    def is_user_payload(self, payload): ...
```

Register it in `AGENT_CLIS`, set `icon_svg` on the class, done. Everything else
(spawn, detection loop, replay, activity polling, search indexing, UI menus) is generic code
driven by the flags and methods above.

## Migration phases (each a self-contained commit, tests green between)

Status 2026-08-26: ALL PHASES DONE. The `AgentKind` enum is gone; kinds are registry-validated
strings. Per-agent runtime state lives in `ms.agent_state` (see `new_session_state`). Client-side
quirks are flags in `AGENT_CLIENT_BEHAVIORS` in app.js. Per-CLI constants (session trees, resume
flags, keepalives) live on the adapter classes; generic services derive watch/index roots from
`sessions_root` + `history_indexed` + `has_own_transcript_watcher`. Deliberately NOT moved: the
`CLAUDE_RAW_REPLAY_*` recording limits in `TermdeckConfig` and the `claude_raw_replay_*` /
`full_claude_raw_replay` field and protocol names — the recording feature is generic (gated by
`records_raw_replay`), only its historical naming is claude-flavored; renaming would churn the ws
protocol and the scroll-test tooling for zero behavior. `AgentSessionTracker` remains as the
claude/codex/agy filesystem helper the adapters call — a NEW agent does not need it; implement the
AgentCli hooks directly.

1. **Package + registry** — new `termdeck/agents/`, no call sites yet.
2. **Command lifecycle** — `command_for_new_session`, `_permission_flags`,
   `_set_restart_permission`, `build_resume_command`, `build_fork_command`,
   `detect_agent_kind`, model aliases → adapters. Old copies deleted.
3. **Store discovery + parsing** — `transcript_service.source_path`, `_parse_lines`,
   `_latest_user_timestamp`, `history_index` payload helpers, tracker
   `_candidate_session_files` → adapters (history_index now shares the same parsing).
4. **Activity / attention / input / state** — `refresh_activity`, `is_processing`,
   `title_requires_attention`, `interpret_input`, per-agent `ms.agent_state`.
5. **Client** — `/api/agents`, `this.agentSpecs`, `AGENT_CLIENT_BEHAVIORS`, migrate the 65
   app.js sites.
6. **Cleanup** — delete `AgentKind`, move per-CLI constants out of `TermdeckConfig` into the
   adapter classes.

Rule for every phase: no shims, no dual paths — when a concern moves into the adapter, the old
branchy implementation is deleted in the same commit.
