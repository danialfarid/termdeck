# TermDeck

Mini terminal IDE in the browser: named persistent terminal sessions with automatic claude/codex CLI session
resume across restarts. Sidebar on the left lists terminals by title; the selected terminal (xterm.js) fills
the right side.

## Run

Always-on via launchd `com.termdeck` (installed at `~/Library/LaunchAgents/com.termdeck.plist`, source copy
`com.termdeck.plist` in this repo; RunAtLoad + KeepAlive, log at `~/data/termdeck/termdeck.log`):

```
launchctl kickstart -kp gui/$UID/com.termdeck   # restart
launchctl bootout gui/$UID/com.termdeck         # stop (until next login)
./run.sh                                       # manual foreground run (stop launchd copy first)
```

UI: http://127.0.0.1:8530. Setup (once): `python3.14 -m venv .venv && .venv/bin/pip install -r requirements.txt`

## Behavior

- Multi-project: a project = a named base directory, auto-registered from a terminal's cwd (registry in
  `~/data/termdeck/projects.json`). Each project is URL-addressable at `/p/<name>` (e.g. `/p/stock`) — keep one
  browser tab per project; `/` shows everything. The sidebar dropdown switches projects; terminals, open files,
  closed history, remembered selection, and the new-terminal default cwd are all per-project.

- `+` opens a terminal; the command, cwd, and title are recorded in `~/data/termdeck/sessions.json`.
- Empty command = interactive zsh. Any command runs via `zsh -ilc`.
- Unsubmitted input drafts survive restarts: keystrokes since the last Enter are reconstructed server-side
  (backspace-aware, escape-sequences ignored), persisted into sessions.json (2s debounce), and re-injected as a
  bracketed paste ~4s after the respawned CLI boots. Enter/Ctrl-C clears the stored draft.
- Commands containing `claude` or `codex` are agent sessions: termdeck continuously tracks which CLI session the
  terminal is CURRENTLY on — primarily via the session file the process group holds open (lsof; exact, catches
  picker-resumes and in-TUI switches), falling back to new/grown files under `~/.claude/projects/<munged-cwd>/`
  / `~/.codex/sessions/YYYY/MM/DD/`. `/clear` or switching sessions updates the recorded id.
- Sidebar/topbar titles show the CLI-set terminal title (OSC 0/1/2 — session name, loading indicators) when one
  is emitted; a manual rename (double-click) pins your title instead. Plain shells show the auto/user title.
- On server restart every saved terminal respawns automatically:
  - claude: `<original command> --resume <agent-session-id>`
  - codex: `codex resume <agent-session-id>`
  - anything else: the original command / a fresh shell.
- Sidebar: TERMINALS (one-line rows: status dot + agent icon claude/codex/shell + CLI title), OPEN FILES
  (material-icon rows, ✕ to close), CLOSED at the bottom — history of closed terminals (capped 20, in
  `~/data/termdeck/closed_sessions.json`); click to reopen one with its claude/codex session resumed.
- Topbar: double-click title to rename, `⟳` restart (kills + respawns with resume), `✕` close, `▤` files panel.
- Shortcuts: `⌘K` new terminal, `⌘⇧⌫` close active item (files close instantly; terminals ask to confirm and
  go to closed history). Inside a terminal the macOS editing keys work like iTerm: `⌘⌫` delete to line start,
  `⌥⌫` delete word, `⌘←`/`⌘→` line start/end, `⌥←`/`⌥→` word jumps, `⌘A` select all terminal text — and the
  draft tracker understands the deletion keys so saved drafts stay accurate.
- Selecting an open file swaps the main area to the Monaco viewer; selecting a terminal swaps back. Open files
  persist across reloads/restarts (content re-fetched lazily).
- Files panel (right): VS Code-style lazy tree (vendored codicons; auto re-roots to the active terminal's cwd)
  + read-only Monaco editor (the actual VS Code editor component, vendored at static/vendor/monaco) with full
  syntax highlighting, vs-dark theme, folding, find (Cmd+F). File paths printed in any terminal are clickable
  (resolved against that terminal's cwd, `path:line` reveals the line). Access confined to `~`; 2MB cap;
  binary files refused.
- Per-panel gear (`⚙`) popovers set font size (sidebar / terminal / viewer); sidebar and files panel are
  drag-resizable. Settings + last-selected terminal persist server-side in `~/data/termdeck/settings.json`.
- Scrollback survives page reloads via a 2MB server-side ring buffer per terminal (not across server restarts;
  claude/codex resume redraws the conversation anyway).

## Caveats

- Compound commands: the claude resume flag is appended to the whole command string, so keep `claude`/`codex`
  last (`cd x && claude` is fine, `claude; echo done` is not).
- Interactive claude sessions only get an id once the first message is sent (the CLI creates the session file
  lazily); restarting before that re-runs the original command fresh.
- Claude picker-resumes/`/clear` are tracked via dir changes (claude doesn't hold its file open), so two claude
  terminals in the same cwd can very rarely mis-attribute; codex attribution is exact (open-file based).
