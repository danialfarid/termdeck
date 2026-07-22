<div align="center">

# TermDeck

**A deck of persistent terminals in your browser — where your Claude Code and Codex sessions
survive restarts, reboots, and closed tabs.**

[![Release](https://img.shields.io/github/v/release/danialfarid/termdeck?sort=semver)](https://github.com/danialfarid/termdeck/releases)
[![Python](https://img.shields.io/badge/python-3.11%2B-blue.svg)](https://www.python.org/downloads/)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![CI](https://github.com/danialfarid/termdeck/actions/workflows/ci.yml/badge.svg)](https://github.com/danialfarid/termdeck/actions/workflows/ci.yml)

</div>

---

## What it is

TermDeck is a small local web app that runs a deck of named terminals and serves them to your browser.
It is built around one idea: **an AI coding agent session should never be lost.**

Close the tab, reboot your laptop, restart the server — every terminal comes back, and any terminal running
`claude` or `codex` comes back **resumed into the exact session it was on**, not a fresh one.

Around that sits a small IDE: a VS Code file tree, the real Monaco editor, project-wide ripgrep search and
replace, and a rendered Markdown view of your agent's conversation with a prompt composer.

```
┌────────────────────────┬──────────────────────────────────────────────────────┐
│ stock            ▾  +  │                                              ⟳  ▤  ⌄ │
├────────────────────────┤                                                      │
│ TERMINALS              │  $ claude --resume 4f2a…                             │
│  ● ⌁ refactor parser   │                                                      │
│  ● ⌁ fix flaky test    │    ● Analyzing the parser module…                    │
│  ○ ⌁ codex: migrate    │                                                      │
│  ● $ zsh               │    I found three call sites that need updating:      │
│                        │      1. trainer/prep/features/index_feat.py:210      │
│ FILES                  │      2. miner/sec/sec_miner.py:88                    │
│  index_feat.py       ✕ │                                                      │
│  README.md           ✕ │  > continue                                          │
│                        │                                                      │
│ CLOSED                 │                                                      │
│  ↺ old bugfix run      │                                                      │
├────────────────────────┼──────────────────────────────────────────────────────┤
│ ⌨  ⚙                   │  refactor parser            cpu 12%  rss 480M   ▁▃▅▂ │
└────────────────────────┴──────────────────────────────────────────────────────┘
```

## Why you might want it

- **Agent sessions are precious.** A long Claude Code or Codex session holds hours of context. TermDeck
  tracks which session each terminal is currently on and re-enters it on restart with `--resume`.
- **Terminals keep running when nothing is watching.** Every terminal is backed by
  [`dtach`](https://github.com/crigler/dtach), so processes survive the server going away, not just the tab.
- **Your unsent prompt survives too.** Half-typed input is reconstructed server-side and re-injected after
  the CLI boots back up.
- **One browser tab per project.** Terminals, open files, and layout are scoped per project and
  URL-addressable at `/p/<name>`.
- **Read your agent, don't squint at it.** Switch any agent terminal to a rendered Markdown transcript with
  collapsible diffs, a prompt composer, and a queue.
- **It's local.** Binds `127.0.0.1` by default, stores everything in `~/.termdeck`, talks to no network service.

---

## Requirements

| | |
|---|---|
| **OS** | macOS 13+ or Linux |
| **Python** | 3.11 or newer |
| **Required** | [`dtach`](https://github.com/crigler/dtach) — keeps terminals alive across restarts |
| **Recommended** | [`ripgrep`](https://github.com/BurntSushi/ripgrep) — powers project search and replace |
| **Optional** | [`claude`](https://claude.com/claude-code) and/or [`codex`](https://github.com/openai/codex) CLIs — for agent session resume |
| **Browser** | Any current Chrome, Safari, Firefox, or Edge |

Run `termdeck doctor` at any time to see exactly what was found and what's missing.

---

## Install

TermDeck installs straight from its GitHub release. Two external tools come first:
`dtach` (required — it keeps terminals alive across restarts) and `ripgrep` (recommended — project search).

```sh
brew install dtach ripgrep                 # macOS / Linuxbrew
sudo apt install dtach ripgrep             # Debian / Ubuntu
sudo dnf install dtach ripgrep             # Fedora
sudo pacman -S dtach ripgrep               # Arch
```

### uv (recommended)

`uv` brings its own Python, so nothing else is needed.

```sh
uv tool install "git+https://github.com/danialfarid/termdeck.git@v0.1.0"
termdeck --open
```

Upgrade to a newer release by re-running the same command with the new tag.

### pipx

```sh
pipx install "git+https://github.com/danialfarid/termdeck.git@v0.1.0"
```

### From source

```sh
git clone https://github.com/danialfarid/termdeck.git
cd termdeck
python3 -m venv .venv && .venv/bin/pip install -e .
.venv/bin/termdeck
```

### Homebrew and PyPI

A one-line `brew install` and `pip install termdeck` are planned but not published yet
([tracking issue](https://github.com/danialfarid/termdeck/issues)). Use the `uv`/`pipx`
commands above in the meantime.

---

## Quickstart

```sh
termdeck --open
```

That starts the server on <http://127.0.0.1:8530> and opens it in your browser. Then:

1. Press **⌘B** (or click **+**) to open a terminal.
2. Pick **Codex**, **Claude**, or **Shell**, choose a permission mode, and set the directory.
3. Work in it like any terminal.
4. Now quit the server and start it again — the terminal is back, resumed, with your unsent prompt intact.

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
termdeck service restart               # restart it (terminals respawn and resume)
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

Click **+** or press **⌘B**. The dialog asks for four things:

| Field | Meaning |
|---|---|
| **Model** | `Codex`, `Claude`, or `Shell` (a plain interactive login shell) |
| **Permission** | The sandbox/approval mode to launch the agent with — see the table below |
| **Session name** | Optional. Pins a title so the CLI can't overwrite it |
| **Resume existing session** | Optional. A saved session ID or a name you gave a past session |
| **Directory** | Working directory. Defaults to the current project's root |

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

An empty command gives you an interactive login shell. Any other command runs through your login shell
(`$SHELL -ilc`), so aliases and shell functions work.

### Agent session resume — how it actually works

This is the core feature, so it's worth knowing the mechanics.

For any terminal whose command contains `claude` or `codex`, TermDeck continuously tracks **which CLI session
that terminal is on right now**:

- **Primarily via open file handles.** It uses `lsof` to see which session file the process group holds open.
  This is exact, and it catches picker-resumes and in-TUI session switches.
- **Falling back to directory watching.** New or growing files under `~/.claude/projects/<munged-cwd>/` and
  `~/.codex/sessions/YYYY/MM/DD/` are attributed to the terminal that was most recently typed into.

When the server restarts, each terminal respawns as:

| Kind | Respawn command |
|---|---|
| Claude | `<original command> --resume <session-id>` |
| Codex | `codex resume <session-id>` |
| Anything else | The original command, or a fresh shell |

Using `/clear` or switching sessions inside the TUI updates the recorded ID, so a restart always lands you
on the session you were actually on — not the one you started with.

**Fork** branches a copy of the current agent session into a new terminal, leaving the original untouched —
`--fork-session` for Claude, `codex fork` for Codex.

### Terminals that outlive the server

Every terminal runs under `dtach`. When TermDeck restarts, it first checks whether the old `dtach` socket is
still live: if it is, it **reattaches to the still-running process** and prints
`──── reconnected (kept running) ────` — your build keeps building, your agent keeps thinking. Only if the
socket is dead does it respawn and resume, printing `──── restarted ────`.

### Unsent prompt drafts

Keystrokes since your last Enter are reconstructed server-side (backspace- and word-delete-aware, escape
sequences ignored), persisted to disk on a 2-second debounce, and re-injected as a bracketed paste a few
seconds after the CLI boots. Pressing Enter or Ctrl-C clears the stored draft.

So if you were three sentences into a prompt when your laptop rebooted, you get those three sentences back.

### Projects

A project is just a named base directory. The first time you open a terminal in a directory, that directory
is registered as a project (stored in `~/.termdeck/projects.json`).

Each project is URL-addressable at `/p/<name>` — for example `/p/termdeck`. The intended workflow is **one
browser tab per project**. `/` shows everything at once. Switching projects from the sidebar dropdown swaps
terminals, open files, closed history, remembered selection, and the default directory for new terminals.

### The Markdown transcript

Click the **markdown** icon in the terminal toolbar (or press **⌘⇧M**) to swap an agent terminal for a
rendered transcript of the conversation, read directly from the CLI's own session file:

- Prose rendered as Markdown instead of TUI-wrapped text — selectable and copyable properly
- Code edits shown as collapsible diffs — collapse them all with one button
- A live **THINKING** banner with elapsed time
- A prompt composer at the bottom: **Enter** submits, **Shift+Enter** newline, **Esc** interrupts
- **Tab** queues a prompt (Codex); queued prompts are listed, editable in place, and removable
- An attach button to upload a file or image straight into the prompt

Press **⌘⇧M** again, or hit the terminal icon, to go back to the live terminal.

### Files and the editor

The **Files** view (**⌘⇧D**) is a lazy VS Code–style tree that auto-re-roots to the active terminal's
directory. Selecting a file swaps the main area to a Monaco editor — the actual VS Code editor component,
vendored locally — with syntax highlighting, folding, and find.

- **File paths printed in any terminal are clickable.** They resolve against that terminal's directory, and
  `path:line` jumps straight to the line.
- Open files persist across reloads and restarts; content is re-fetched lazily.
- **⌘S** saves. **⌃R** renames, **⌃M** moves, **⌘⌫** trashes the selected tree file.
- Access is confined to your home directory, files over 2 MB are refused, and binaries are refused.
- Deletes go to the system trash (`~/.Trash` on macOS, the XDG trash on Linux), never `rm`.

### Search and replace

The **Search** view (**⌘⇧F**) runs ripgrep across the project: fixed-string or regex, match case, whole word,
and an `rg`-glob filter box (`!*.json, *.py, trainer/**`). Results are grouped by file and click through to
the exact line.

Toggle the replace bar to run a project-wide replace across every matching file (capped at 200 files per
run). The fuzzy **find file by name** box sits above it.

### Keyboard shortcuts

All of these are rebindable — click the **⌨** icon in the sidebar footer, click a binding, press the keys
you want. **Reset to defaults** undoes everything.

| Action | Default |
|---|---|
| New terminal | **⌘B** |
| Close active terminal / file | **⌘⇧⌫** |
| Save open file | **⌘S** |
| Previous / next terminal | **⌘⌥↑** / **⌘⌥↓** |
| Toggle Files view | **⌘⇧D** |
| Toggle Search view | **⌘⇧F** |
| Terminals view | **⌘⇧T** |
| Switch terminal ⇄ Markdown transcript | **⌘⇧M** |
| Select all terminal text | **⌘⇧A** |

Fixed bindings:

| Action | Keys |
|---|---|
| Browser back / forward | **⌘[** / **⌘]** |
| Focus file-name search | **⌃⇧E** |
| Focus file-content search | **⌃⇧F** |
| Open file browser/search modal | **⌃⇧Space** |
| Delete to line start / delete word *(in terminal)* | **⌘⌫** / **⌥⌫** |
| Line start / end *(in terminal)* | **⌘←** / **⌘→** |
| Rename / move / delete selected tree file | **⌃R** / **⌃M** / **⌘⌫** |
| Navigate the file tree | **↑ ↓ ← → Enter** |

Inside a terminal, the macOS editing keys behave like iTerm — and the draft tracker understands the deletion
keys, so saved drafts stay accurate.

### Attachments

Drag and drop a file onto a terminal, paste an image from the clipboard, or use the upload button. The file
is stored under `~/.termdeck/uploads` and its path is inserted at the cursor, which is exactly what Claude
Code and Codex want in order to read it.

### Closed terminals

Closing a terminal doesn't destroy it — it moves to **CLOSED** at the bottom of the sidebar (last 20). Click
one to reopen it with its agent session resumed.

### Settings

Per-panel gear popovers set font sizes independently for the sidebar, terminal, viewer, tree, and diffs;
panels are drag-resizable; there's a light and a dark theme. Everything persists **server-side** in
`~/.termdeck/settings.json`, so it follows you across browsers and machines rather than living in one
browser's local storage.

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

Everything lives under `~/.termdeck` (or `$TERMDECK_DATA_DIR`):

```
~/.termdeck/
├── sessions.json          terminals: command, cwd, title, agent session id, draft
├── closed_sessions.json   the last 20 closed terminals
├── projects.json          registered project directories
├── settings.json          fonts, panel widths, theme, keybindings, open files
├── scrollback/            per-terminal ring buffer
├── dtach/                 dtach sockets for live terminals
├── uploads/               pasted and dropped attachments
└── termdeck.log           service log (macOS)
```

Nothing is written outside this directory and the files you explicitly edit.

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

---

## Troubleshooting

**`termdeck cannot start, missing required programs`** — run `termdeck doctor`. It prints every program
TermDeck looked for, where it resolved to, and the install command for anything missing.

**Terminals don't resume, they start fresh.** An interactive agent session only gets an ID once you send the
first message — the CLI creates the session file lazily. Restarting before that re-runs the original command.

**A terminal resumed into the wrong session.** Claude doesn't hold its session file open, so picker-resumes
and `/clear` are attributed via directory watching. Two Claude terminals in the same directory can, rarely,
be mis-attributed. Codex attribution is open-file based and exact.

**Search doesn't work.** ripgrep isn't installed or isn't found — `termdeck doctor` will say so.

**The service isn't starting.** `termdeck service status`, then `termdeck service logs`.

More in [docs/troubleshooting.md](docs/troubleshooting.md).

---

## Known limitations

- **Compound commands:** the resume flag is appended to the whole command string, so keep `claude`/`codex`
  last. `cd x && claude` is fine; `claude; echo done` is not.
- **Scrollback across server restarts:** the per-terminal ring buffer survives page reloads but not a server
  restart. In practice claude/codex resume redraws the conversation anyway.
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

---

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup and
the code conventions this project follows.

## License

[Apache License 2.0](LICENSE). Bundled third-party components and their licenses are listed in [NOTICE](NOTICE).
