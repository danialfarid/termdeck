# Troubleshooting

Start here:

```sh
termdeck doctor
```

It prints the resolved host/port, data directory, file root, shell, and every external program TermDeck
looked for — with the install command for anything missing.

---

## Startup

### `termdeck cannot start, missing required programs`

TermDeck refuses to start without its hard dependencies rather than failing later in a confusing way. The
error names each missing program and how to install it. Most often it is `dtach`:

```sh
brew install dtach          # macOS, Linuxbrew
sudo apt install dtach      # Debian, Ubuntu
```

### `command not found: termdeck`

The install directory isn't on your `PATH`.

| Installed with | Fix |
|---|---|
| uv | `uv tool update-shell`, then restart your shell |
| pipx | `pipx ensurepath`, then restart your shell |
| pip | Use `python3 -m termdeck`, or add the user script directory to `PATH` |
| Homebrew | `brew doctor` — Homebrew's `bin` should already be on `PATH` |

### `Address already in use`

Something already holds port 8530 — most likely a TermDeck you forgot about.

```sh
lsof -nP -iTCP:8530 -sTCP:LISTEN     # who has it
termdeck service status              # is it the service?
termdeck --port 8531                 # or just use another port
```

### The server starts but the page is blank

Hard-reload the browser (**⌘⇧R** / **⌃⇧R**). If it persists, check the browser console for a failed asset
load and open an issue with what it says.

---

## Terminals

### A terminal shows `[termdeck] spawn failed: …`

The command couldn't be executed. The message carries the underlying error. Usual causes: the agent CLI isn't
installed or isn't on the login shell's `PATH`, or the working directory no longer exists.

Check what a login shell actually sees:

```sh
zsh -ilc 'which claude codex; echo $PATH'
```

### Terminals disappear after a restart

Sessions live in `sessions.json` inside the data directory. If you started TermDeck with a different
`--data-dir` (or a different `TERMDECK_DATA_DIR` in a service unit) it will look in the wrong place.

```sh
termdeck doctor                # shows the data dir actually in use
ls ~/.termdeck/sessions.json
```

### A terminal is stuck / not responding

Use **⟳** in the topbar to restart it. That kills the process group and respawns with resume, so an agent
session is preserved.

### Scrollback is empty after a server restart

Expected. The per-terminal ring buffer survives page reloads but not a server restart. For agent terminals
the resume redraw restores the conversation anyway; for shells, the history is gone.

---

## Agent session resume

### It starts a fresh session instead of resuming

An interactive agent session only gets an ID once the **first message is sent** — the CLI creates its session
file lazily. If you open a terminal, type nothing, and restart, there is no session to resume, so the
original command runs again.

Check what TermDeck recorded:

```sh
python3 -m json.tool ~/.termdeck/sessions.json | grep -A1 agent_session_id
```

### It resumed into the *wrong* session

Codex holds its session file open, so attribution via `lsof` is exact. Claude doesn't, so picker-resumes and
`/clear` are attributed by watching `~/.claude/projects/<munged-cwd>/` for new files and crediting the
terminal most recently typed into. Two Claude terminals in the **same directory**, switching sessions at the
same moment, can rarely be mis-attributed.

Workaround: give concurrent Claude terminals different working directories, or set the session explicitly
with the **Resume existing session** field when opening a terminal.

### Resume flags land in the wrong place

The resume flag is appended to the **whole command string**, so `claude` or `codex` has to be last:

| Command | Works? |
|---|---|
| `claude` | yes |
| `cd project && claude` | yes |
| `claude --model opus` | yes |
| `claude; echo done` | **no** — the flag lands after `echo done` |

### My unsent prompt didn't come back

Drafts are persisted on a 2-second debounce, so the last couple of seconds of typing before a hard kill can
be lost. Enter and Ctrl-C intentionally clear the draft. Drafts are replayed a few seconds after the CLI
boots — if the CLI is slow to start, the paste may land early; press **⟳** to restart the terminal.

---

## Files and search

### Search returns nothing

ripgrep is missing or wasn't found. `termdeck doctor` will show `rg` as missing. Install it, or point
TermDeck at it directly:

```sh
export TERMDECK_RG_BIN=/custom/path/to/rg
```

Also check the glob filter box — a leftover filter like `*.py` silently narrows every search.

### `outside the allowed root` when opening a file

The file browser is confined to `TERMDECK_FILE_ROOT` (your home directory by default). Symlinks that resolve
outside the root are rejected too.

### A file won't open

Files over 2 MB and files detected as binary are refused by design.

### Deleting a file — where does it go?

To the system trash: `~/.Trash` on macOS, `~/.local/share/Trash/files` on Linux. Never `rm`. If the trash is
on a different filesystem than the file, the move can fail — delete it from your file manager instead.

---

## The background service

### It isn't running

```sh
termdeck service status
termdeck service logs
```

On macOS the log is `~/.termdeck/termdeck.log`; on Linux, `journalctl --user -u termdeck`.

### It stops when I log out (Linux)

systemd user units end with the session unless lingering is enabled:

```sh
sudo loginctl enable-linger $USER
```

### It won't start after moving or upgrading Python

The unit file records an absolute path to the interpreter or console script that installed it. If that path
moved, regenerate the unit:

```sh
termdeck service install
```

### It can't find `dtach` even though my shell can

launchd and systemd start services with a minimal `PATH`. TermDeck falls back to well-known directories, but
if yours is installed somewhere unusual, pin it and reinstall the service:

```sh
TERMDECK_DTACH_BIN=/custom/path/dtach termdeck service install
```

The variable is copied into the unit's environment block.

---

## Still stuck

Open an issue at <https://github.com/danialfarid/termdeck/issues> with:

- `termdeck doctor` output
- `termdeck --version`, your OS and version
- Relevant lines from `termdeck service logs`
- What you did, what happened, what you expected
