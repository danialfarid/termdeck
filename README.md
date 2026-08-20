<div align="center">

# TermDeck

**A persistent local workspace for Codex, Claude Code, AGY/Antigravity, and shell terminals — built
for running, watching, and returning to many agent sessions without losing the thread.**

[![Release](https://img.shields.io/github/v/release/danialfarid/termdeck?sort=semver)](https://github.com/danialfarid/termdeck/releases)
[![Python](https://img.shields.io/badge/python-3.11%2B-blue.svg)](https://www.python.org/downloads/)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![CI](https://github.com/danialfarid/termdeck/actions/workflows/ci.yml/badge.svg)](https://github.com/danialfarid/termdeck/actions/workflows/ci.yml)

</div>

---

## What it is

TermDeck is a small local web app that runs a deck of named terminals and serves them to your browser.
It is built around one idea: **an AI coding agent session should never be lost in a pile of terminal
windows.**

Close the tab or restart the TermDeck server and live processes keep running under `dtach`. After a computer
restart, saved Codex and Claude terminals reopen **resumed into the exact agent session they were on**, not a
fresh one.

The terminal deck stays at the center. Around it are tools that shorten the loop around agent work: grouped
and searchable sessions, activity and unread state, an MD conversation mode, prompt and clipboard
history, quick notes, a Monaco file editor, project search, Git history, and an automation API for spawning
parallel agents and coordinating work between them.

```
┌──────────────────────────┬────────────────────────────────────────────────────┐
│ stock ▾                  │ terminal / MD conversation / file editor           │
├──────────────────────────┤                                                    │
│ TERMINALS          +  ⋯  │ $ codex resume 4f2a…                              │
│ ▾ ingestion         2 ●  │                                                    │
│   ◉ refactor parser      │   Analyzing the parser module…                     │
│   ○ review tests         │                                                    │
│ ● migrate cache         │   I found three call sites that need updating:      │
│                          │     trainer/prep/features/index_feat.py:210         │
│ RECENTLY CLOSED (50)     │     miner/sec/sec_miner.py:88                      │
│   ↺ old bugfix run       │                                                    │
│                          │ > continue                                          │
├──────────────────────────┼────────────────────────────────────────────────────┤
│ Files Search Git Notes   │ MD  refresh  bottom  upload   model · cpu · rss    │
└──────────────────────────┴────────────────────────────────────────────────────┘
```

## Why you might want it

- **Agent sessions are precious.** A long Claude Code or Codex session holds hours of context. TermDeck
  tracks the active CLI session and re-enters it after a restart instead of starting over.
- **Terminals keep running when nothing is watching.** Every terminal is backed by
  [`dtach`](https://github.com/crigler/dtach), so processes survive browser and TermDeck server restarts.
- **Parallel work remains understandable.** Group and reorder terminals, see working and unread state, sort
  by recent activity, search every terminal, and open a conversation outline when you need the short version.
- **Agents can delegate through the same UI.** Fork one session or up to 25 copies, or use the local API to
  start named tasks with a model, permission, prompt, placement, and result path. Every child remains a normal,
  inspectable TermDeck terminal.
- **Useful context can move directly between agents.** Select text in a terminal, MD conversation, file, or note
  and choose **Ask an agent** to hand it to a new agent without rebuilding the prompt. Agents and scripts can also
  use the API to start another agent, send follow-up prompts, monitor completion, and read its response, enabling
  review, delegation, and cross-agent workflows while every participant remains visible in the deck.
- **Projects have first-class worktrees.** The project header shows the current branch, discovers existing Git
  worktrees, and creates new branches in free folders. Each worktree has its own terminals, closed-session history,
  layout, file/search view, and Git context; worktrees can be opened in a separate browser tab or moved to trash.
- **Agent work can stay isolated.** New sessions and forks can run in managed Git worktrees with a visible branch
  identity, parent-relative review diff, and explicit keep, merge, or discard actions.
- **Use the live terminal and MD mode side by side.** Switch any agent session between its interactive terminal
  and a rendered MD conversation with model and status information, collapsible thinking and diffs, prompt
  history, a composer, and a queue.
- **Your input is recoverable.** Unsent drafts are persisted, terminal and Markdown prompts stay in history,
  and clipboard history and quick notes keep useful snippets nearby.
- **One browser tab per project — or per task.** Project worktrees are URL-addressable at `/p/<project>/<worktree>`,
  while a terminal or file can append its stable session ID or repo-relative path and open in its own browser tab.
- **The supporting tools understand the terminal workflow.** Printed paths are clickable, files open in
  Monaco, and file-name search, content search, Git history, blame, definitions, usages, and Problems are close
  without turning TermDeck into a full IDE replacement.
- **Long-running decks are maintainable.** Process inventory, orphan cleanup, recently closed sessions, and an
  explicit kill-all action help reclaim resources without erasing saved history.
- **It's local.** Binds `127.0.0.1` by default, keeps server state in `~/.termdeck`, and adds no cloud service.

---

## Requirements

| | |
|---|---|
| **OS** | macOS 13+ or Linux |
| **Python** | 3.11 or newer |
| **Required** | [`dtach`](https://github.com/crigler/dtach) — keeps terminals alive across restarts |
| **Recommended** | [`ripgrep`](https://github.com/BurntSushi/ripgrep) — powers project search and replace |
| **Optional** | A language server for IDE navigation, diagnostics, refactoring, code actions, and hover information |
| **Optional** | [`claude`](https://claude.com/claude-code), [`codex`](https://github.com/openai/codex), and/or the `agy` Antigravity CLI |
| **Browser** | Any current Chrome, Safari, Firefox, or Edge |

Run `termdeck doctor` at any time to see exactly what was found and what's missing.

---

## Install and update

### macOS — Homebrew (recommended)

Fresh install:

```sh
brew install danialfarid/tap/termdeck
termdeck service install
open http://127.0.0.1:8530
```

Homebrew installs `dtach`, `ripgrep`, Python, and prebuilt dependency wheels automatically on both Apple Silicon
and Intel Macs. Nothing should compile during installation.

Upgrade an existing installation:

```sh
brew update
brew upgrade danialfarid/tap/termdeck
termdeck service restart
```

That is the complete macOS install and upgrade path. Your sessions and settings remain in `~/.termdeck`, and
upgrading or restarting the TermDeck service does not stop live `dtach` terminals.

### Linux or installation without Homebrew

Install `dtach` and `ripgrep` with the system package manager, then install the tagged release with `uv`:

```sh
sudo apt install dtach ripgrep
uv tool install "git+https://github.com/danialfarid/termdeck.git@v0.6.0"
termdeck service install
```

The equivalent `pipx` command and source-install instructions are in
[docs/installation.md](docs/installation.md). TermDeck is not yet published on PyPI, so plain
`pip install termdeck` does not install this project.

---

## Quickstart

```sh
termdeck --open
```

That starts the server on <http://127.0.0.1:8530> and opens it in your browser. Then:

1. Press **⌘B** (or click **+**) to open a terminal.
2. Pick **Codex**, **Claude**, **AGY**, or **Shell**, choose a permission mode, and select the project directory.
3. Work in it like any terminal.
4. Close the browser or restart TermDeck — the live process remains attached to its saved terminal. After a
   machine restart, Codex and Claude sessions resume when opened.

To keep it running in the background forever:

```sh
termdeck service install
```

---

## Running as a background service

`termdeck service` manages a per-user launchd agent on macOS or a systemd user unit on Linux. Both are
generated from the interpreter you installed with, and both capture whatever `--port`, `--data-dir`, etc.
you pass at install time.

```sh
termdeck service install               # install + start, and start at every login
termdeck --port 9000 service install   # same, but the service remembers port 9000
termdeck service restart               # restart TermDeck; live dtach terminals keep running
termdeck service status                # is it running?
termdeck service logs                  # tail the log (journalctl on Linux)
termdeck service uninstall             # stop it and remove the unit file
```

The unit file lands at:

- macOS — `~/Library/LaunchAgents/com.termdeck.plist`, log at `~/.termdeck/termdeck.log`
- Linux — `~/.config/systemd/user/termdeck.service`, log in the systemd journal

On Linux, if you want the service to run before you log in graphically, enable lingering once:
`sudo loginctl enable-linger $USER`.

---

## Guide

### Opening terminals

Click **+** or press **⌘B**:

| Field | Meaning |
|---|---|
| **Model** | `Codex`, `Claude`, `AGY`, or `Shell` (a plain interactive login shell) |
| **Permission** | The sandbox/approval mode to launch the agent with — see the table below |
| **Session name / Resume** | Name a new terminal, or choose a saved Codex/Claude session ID or name to resume |
| **Directory** | Working directory, with a native folder picker for adding a project |

Permission modes map to real CLI flags:

| Model | Mode | Flag |
|---|---|---|
| Codex | `default` | *(none)* |
| Codex | `read-only` | `--sandbox read-only` |
| Codex | `workspace-write` | `--sandbox workspace-write` |
| Codex | `full-access` | `--dangerously-bypass-approvals-and-sandbox` |
| Claude | `default` | *(none)* |
| Claude | `accept-edits` | `--permission-mode acceptEdits` |
| Claude | `auto` | `--permission-mode auto` |
| Claude | `full-access` | `--dangerously-skip-permissions` |
| AGY | `default` | *(none)* |
| AGY | `full-access` | `--dangerously-skip-permissions` |

An empty command gives you an interactive login shell. Any other command runs through your login shell
(`$SHELL -ilc`), so aliases and shell functions work.

### Agent session resume — how it actually works

This is the core feature, so it's worth knowing the mechanics.

For any terminal whose command contains `claude` or `codex`, TermDeck continuously tracks **which CLI session
that terminal is on right now**.

- **Primarily via open file handles.** It uses `lsof` to see which session file the process group holds open.
  This is exact, and it catches picker-resumes and in-TUI session switches.
- **Falling back to directory watching.** New or growing files under `~/.claude/projects/<munged-cwd>/` and
  `~/.codex/sessions/YYYY/MM/DD/` are attributed to the terminal that was most recently typed into.

After a computer restart, opening a saved terminal starts it as:

| Kind | Respawn command |
|---|---|
| Claude | `<original command> --resume <session-id>` |
| Codex | `codex resume <session-id>` |
| Anything else | The original command, or a fresh shell |

Using `/clear` or switching sessions inside the TUI updates the recorded ID, so a restart always lands you
on the session you were actually on — not the one you started with.

**Fork** branches the current Codex or Claude session into a new terminal, leaving the original untouched.
Enter a name for one fork or a number to create up to 25 numbered forks. New forks are placed beside the
source terminal.

### Managing a large terminal deck

Terminals can be reordered by drag and drop, placed into collapsible groups, moved between projects, or opened
alone in a browser tab. Working state animates while an agent is active; unread dots remain after it finishes.
Group headers summarize active/unread children, and sorting by recent activity temporarily flattens the groups.

- **Terminal search** searches names and conversation/output text, groups results by session, and can group
  similar matches from several agents.
- **Quick Open** searches commands, recently opened terminals, open files, file names, and symbols.
- **Conversation outline** presents the prompts and responses in a compact, clickable history.
- The context menu supports fork, restart with a permission mode, rename, copy session ID, mark unread, move,
  open in a new tab, and close. Multi-selection is available for moving several terminals together.
- Recently closed terminals retain their group and session metadata and can be searched and reopened.

### Terminals that outlive the server

Every terminal runs under `dtach`. When TermDeck's server restarts, it leaves live terminal processes alone and
reattaches to them when opened. If the computer restarted and the old socket is gone, opening a saved terminal
starts it with the saved session and prints `──── restarted ────`.

### Unsent prompt drafts

Keystrokes since your last Enter are reconstructed server-side (backspace- and word-delete-aware, escape
sequences ignored), persisted to disk on a 2-second debounce, and re-injected as a bracketed paste a few
seconds after the CLI boots. Pressing Enter or Ctrl-C clears the stored draft.

So if you were three sentences into a prompt when your laptop rebooted, you get those three sentences back.

### Projects

A project is just a named base directory. The first time you open a terminal in a directory, that directory
is registered as a project (stored in `~/.termdeck/projects.json`).

Each selected worktree is URL-addressable at `/p/<project>/<worktree>` — for example `/p/termdeck/main`.
Terminal URLs append the stable session ID and show the terminal name in the fragment; file URLs append the
repo-relative file path. The intended workflow is **one browser tab per project**. `/` shows everything at once.
Switching projects from the sidebar dropdown swaps
terminals, open files, closed history, remembered selection, and the default directory for new terminals.
The worktree selector can show one worktree or **All worktrees**; the latter keeps each worktree's terminals,
groups, and closed-session history in its own collapsible section. Selecting a specific worktree filters the panel
to that worktree and preserves the selection across reloads.

### MD conversation mode

Click the **MD** icon in the bottom toolbar (or press **⌥G**) to swap an agent terminal for a rendered
transcript read directly from the CLI's own session file:

- Prose rendered as Markdown instead of TUI-wrapped text — selectable and copyable properly
- Code edits and thinking blocks shown as collapsible sections
- Live working state, elapsed time, model name, reasoning effort, and context/status information
- A prompt composer at the bottom: **Enter** submits, **Shift+Enter** newline, **Esc** interrupts
- **Tab** queues a prompt (Codex); queued prompts are listed, editable in place, and removable
- Persisted prompt history from both terminal and conversation mode
- A conversation outline (**⌥O**) for jumping to earlier prompts and responses
- An attach button to upload a file or image straight into the prompt

Press **⌥G** again, or hit **TERM**, to go back to the live terminal.

### Files and the editor

The **Files** view (**⌘⇧D**) is a lazy VS Code–style tree rooted at the active project. It can float over the
terminal, stay pinned, or open in its own browser tab. Selecting a file swaps the main area to Monaco — the
actual VS Code editor component, vendored locally — with syntax highlighting, folding, find/replace, symbol
navigation, definitions, usages, and a Problems panel. Install a matching language server to add precise
definitions and references, workspace symbols, rename refactoring, diagnostics, code actions, and hover types
and documentation. See [Language servers](docs/language-servers.md) for supported commands and setup.

- **File paths printed in any terminal are clickable.** They resolve against that terminal's directory, and
  `path:line` references jump straight to the requested line.
- Open files and navigation history persist across reloads; externally changed content is re-fetched.
- **⌘S** saves. **⌃R** renames, **⌃M** moves, **⌘⌫** trashes the selected tree file.
- The file-tree context menu creates, renames, duplicates, moves, refreshes, or trashes files and folders.
- Local snapshots and Git history show earlier versions of an open file, with diffs and targeted restore.
- Git view stages and unstages files, commits staged work, creates and switches branches, manages stashes and
  worktrees, resolves conflicts with ours/theirs/manual choices, attributes changes to agent terminals, and
  renders the commit graph. Remotes can be fetched, fast-forward pulled, pushed over SSH or HTTPS, and cloned
  directly into a registered TermDeck project. File tools also include history and blame.
- Access is confined to your home directory, files over 2 MB are refused, and binaries are refused.
- Deletes go to the system trash (`~/.Trash` on macOS, the XDG trash on Linux), never `rm`.

### Search and replace

The **Search** view (**⌘⇧F**) runs ripgrep across the project: fixed-string or regex, match case, whole word,
include patterns, and editable exclusion chips. Results retain the file-tree hierarchy, Git state, and modified
time and click through to the exact line. File-name search ranks exact matches before fuzzy matches and keeps
its own search history and filters.

Toggle the replace bar to run a project-wide replace across every matching file (capped at 200 files per
run). Files, Search, and Git share one panel; **⌘⇧E** cycles through them and closes the panel on the fourth
press.

### Quick notes and copied text

Press **⌥N** to open a resizable, multi-tab plain-text notebook over the workspace. Notes autosave, use the
same Monaco editing behavior as source files, and can be populated directly from selected terminal or
conversation text. Closed notes go to the system trash.

TermDeck also keeps a bounded copied-text history. **⌘⇧V** opens a keyboard-navigable picker that pastes into
the currently focused terminal, conversation prompt, file, or note. The notebook's **Copied** tab provides a
larger view for reviewing and reusing snippets.

Right-click selected terminal, conversation, file, or note text to copy it, add it to notes, search from it,
or open the New terminal dialog as **Ask an agent**; the selected text is pasted into the new agent after it
starts.

### Automation and parallel agents

The localhost API can create a persistent terminal, select Codex, Claude, AGY, or shell, choose a model and
permission mode, place it after a session or group, submit a prompt, and optionally append raw output to a
file. Calls are non-blocking; poll the last-turn endpoint for status and the latest agent response.

`POST /api/terminals/batch` launches up to 32 named tasks at once. This makes TermDeck useful as a visible
agent orchestration layer: a parent agent or script can delegate reviews and subtasks while every worker stays
available in the same deck for inspection, follow-up, restart, or manual takeover. See
[docs/api.md](docs/api.md) and [docs/agents-termdeck-api.md](docs/agents-termdeck-api.md).

### VS Code integration

The optional [VS Code extension](integrations/vscode/README.md) uses a native Activity Bar Tree View and native
VS Code terminals by default. Its groups, ordering, selection, and sessions are shared with the browser app.
An optional single-tab mode keeps one TermDeck editor open while the native tree switches the selected
terminal. The extension can auto-start the local TermDeck server.

### Keyboard shortcuts

All of these are rebindable — click the **⌨** icon in the sidebar footer, click a binding, press the keys
you want. **Reset to defaults** undoes everything.

| Action | Default |
|---|---|
| New terminal | **⌘B** |
| Fork active terminal | **⌘⇧B** |
| Restart active terminal | **⌘⌥R** |
| Close active terminal / file | **⌘⇧⌫** |
| Previous / next terminal | **⌘⌥↑** / **⌘⌥↓** |
| Search terminal names and output | **⌘⇧S** |
| Cycle Files / Search / Git | **⌘⇧E** |
| Recently opened terminals | **⌘E** |
| Conversation outline | **⌥O** |
| Open active terminal in a new tab | **⌘⌥O** |
| Terminals view | **⌘⇧T** |
| Switch terminal ⇄ conversation | **⌥G** |
| Scroll terminal / conversation to bottom | **⌘⇧↓** |
| Undo terminal composer edit | **⌘Z** |
| Toggle Files view | **⌘⇧D** |
| Toggle file-content Search | **⌘⇧F** |
| Quick Open | **⌥P** |
| Save open file | **⌘S** |
| Problems panel | **⌥⇧P** |
| Switch project | **⌥S** |
| Quick notes | **⌥N** |
| Copied-text history | **⌘⇧V** |
| Focus active terminal / editor / conversation prompt | **⌥F** |
| Select active terminal / editor / prompt text | **⌥A** |
| Select all terminal text | **⌘⇧A** |

Fixed bindings:

| Action | Keys |
|---|---|
| Browser back / forward | **⌘[** / **⌘]** |
| Focus file-content search | **⌃⇧F** |
| Open file browser/search modal | **⌃⇧Space** |
| Delete to line start / delete word *(in terminal)* | **⌘⌫** / **⌥⌫** |
| Line start / end *(in terminal)* | **⌘←** / **⌘→** |
| Select active terminal input line | **⌘A** |
| Rename / move / delete selected tree file | **⌃R** / **⌃M** / **⌘⌫** |
| Navigate the file tree | **↑ ↓ ← → Enter** |

On macOS the primary modifier is shown as ⌘. On Windows and Linux the same desktop shortcuts use Ctrl and
are displayed as `Ctrl+Shift+S` and `Ctrl+Shift+E`.

Inside a terminal, the macOS editing keys behave like iTerm — and the draft tracker understands the deletion
keys, so saved drafts stay accurate.

### Attachments

Drag and drop a file onto a terminal, paste an image from the clipboard, or use the upload button. The file
is stored under `~/.termdeck/uploads` and its path is inserted at the cursor, which is exactly what Claude
Code and Codex want in order to read it.

### Closed terminals

Closing a terminal moves it to **RECENTLY CLOSED** instead of deleting its saved history. The first 50 are
shown, **load more** expands the list up to 100, and name search, group labels, and session-ID tooltips help
find the right one before reopening it.

### Settings

Choose from Nord, macOS Terminal, GitHub, One Dark, Monokai, Dracula, Solarized, Gruvbox, Tokyo Night,
Catppuccin, Rosé Pine, Ayu, and high-contrast themes. Font sizes are independently adjustable for the project
title, terminal list, terminal, editor, file tree, tabs, diffs, icons, and bottom controls; an in-place editor
puts the relevant slider over each visible UI region. Panel widths are drag-resizable and remembered.

Interface settings, keybindings, notes, copied-text history, open files, and layout are stored server-side in
`~/.termdeck/settings.json`. The Maintenance submenu can export settings, show a terminal process report,
reclaim orphaned `dtach` process trees, or explicitly kill all running terminals without erasing their saved
session history.

---

## Configuration

Every setting is an environment variable, and every CLI flag simply sets one. That means the same knob works
for an ad-hoc run, a shell profile, and a service unit.

| Flag | Environment variable | Default | What it does |
|---|---|---|---|
| `--host` | `TERMDECK_HOST` | `127.0.0.1` | Interface to bind |
| `--port` | `TERMDECK_PORT` | `8530` | Port to serve on |
| `--data-dir` | `TERMDECK_DATA_DIR` | `~/.termdeck` | Sessions, settings, scrollback, uploads |
| `--default-cwd` | `TERMDECK_DEFAULT_CWD` | `~` | Starting directory for new terminals |
| `--file-root` | `TERMDECK_FILE_ROOT` | `~` | Directory the file browser is confined to |
| `--log-level` | `TERMDECK_LOG_LEVEL` | `info` | Uvicorn log level |
| | `TERMDECK_SHELL` | `$SHELL` | Shell used to run terminals |
| | `TERMDECK_DTACH_BIN` | *auto* | Path to `dtach` |
| | `TERMDECK_RG_BIN` | *auto* | Path to `rg` |
| | `TERMDECK_LSOF_BIN` | *auto* | Path to `lsof` |

Binary paths are discovered by checking the environment override, then `PATH`, then well-known locations
(`/opt/homebrew/bin`, `/usr/local/bin`, `/home/linuxbrew/.linuxbrew/bin`, …). The fallback list exists
because launchd and systemd start services with a minimal `PATH`.

See [docs/configuration.md](docs/configuration.md) for the full reference.

### What it writes to disk

TermDeck's server-managed state lives under `~/.termdeck` (or `$TERMDECK_DATA_DIR`):

```
~/.termdeck/
├── sessions.json          terminals: command, cwd, title, agent session id, draft
├── closed_sessions.json   the last 100 closed terminals
├── projects.json          registered project directories
├── settings.json          UI, layout, keybindings, open files, notes, copied text
├── file-history.sqlite3   bounded local snapshots of files viewed or edited
├── backups/               rotating backups of TermDeck's state files
├── scrollback/            per-terminal ring buffer
├── dtach/                 dtach sockets for live terminals
├── uploads/               pasted and dropped attachments
└── termdeck.log           service log (macOS)
```

Files you edit and items you move to the system trash naturally live outside the TermDeck data directory.

---

## Security

TermDeck runs terminals on your machine. Treat it as exactly that.

- It binds **`127.0.0.1`** by default, so it is reachable only from your own machine.
- There is **no authentication**. Anyone who can reach the port can run commands as you.
- **Do not bind `0.0.0.0`** unless you fully control the network, and even then put an authenticating
  reverse proxy in front of it. To use it from another device, prefer an SSH tunnel:
  ```sh
  ssh -N -L 8530:127.0.0.1:8530 you@your-machine
  ```
- File browsing and editing are confined to `$TERMDECK_FILE_ROOT` (your home directory by default). Set it
  to something narrower if you want a tighter blast radius.
- Environment variables starting with `CLAUDE` are scrubbed from spawned terminals.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

### Remote access

TermDeck Remote uses Google login and an outbound, on-demand connector so the server remains bound to localhost.
The hosted relay can be deployed from `remote_service/`, and the local pairing flow is available under Settings →
Remote access. See [docs/remote-access.md](docs/remote-access.md) for the security model, deployment requirements,
and current single-instance limit.

---

## Troubleshooting

**`termdeck cannot start, missing required programs`** — run `termdeck doctor`. It prints every program
TermDeck looked for, where it resolved to, and the install command for anything missing.

**Terminals don't resume, they start fresh.** An interactive agent session only gets an ID once you send the
first message — the CLI creates the session file lazily. Restarting before that re-runs the original command.

**A terminal resumed into the wrong session.** Claude doesn't hold its session file open, so picker-resumes
and `/clear` are attributed via directory watching. Two Claude terminals in the same directory can, rarely,
be mis-attributed. Codex attribution is open-file based and exact.

**Search is slower than expected.** Run `termdeck doctor` and install ripgrep if it is missing. TermDeck has a
Python fallback, but ripgrep is substantially faster on large projects.

**The service isn't starting.** `termdeck service status`, then `termdeck service logs`.

More in [docs/troubleshooting.md](docs/troubleshooting.md).

---

## Known limitations

- **Compound commands:** the resume flag is appended to the whole command string, so keep `claude`/`codex`
  last. `cd x && claude` is fine; `claude; echo done` is not.
- **Scrollback across server restarts:** the per-terminal ring buffer is snapshotted during a graceful server
  restart and restored when the terminal is opened.
- **macOS-first:** developed and used daily on macOS. Linux support is implemented and the code paths are
  portable, but it gets far less mileage — [bug reports welcome](https://github.com/danialfarid/termdeck/issues).
- **Single user:** no authentication, no multi-tenancy. It's a local tool.

---

## How it works

A FastAPI server owns a set of `PtyProcess` objects, each a real pty running your login shell under `dtach`.
Output is pumped through a per-terminal ring buffer to any attached browser over a WebSocket, where xterm.js
renders it. A separate tracker watches `lsof` and the agent CLIs' session directories to keep each terminal's
current session ID up to date, and the session store persists everything needed to rebuild the whole deck.

See [docs/architecture.md](docs/architecture.md) for the module-by-module walkthrough.
For programmatic terminal creation and prompt submission, see [docs/api.md](docs/api.md).

---

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup and
the code conventions this project follows.

## License

[Apache License 2.0](LICENSE). Bundled third-party components and their licenses are listed in [NOTICE](NOTICE).
