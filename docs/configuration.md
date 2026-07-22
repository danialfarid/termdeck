# Configuration

There is one configuration mechanism: **environment variables**. Every CLI flag simply sets one before the
server starts, and `termdeck service install` copies whichever ones are set into the generated service unit.
So the same knob works identically from a shell, a shell profile, and a launchd/systemd unit.

`TermdeckConfig` reads the environment **once, at import time**. Changing a variable in a running process has
no effect — restart instead.

---

## Server

| Variable | Flag | Default | Notes |
|---|---|---|---|
| `TERMDECK_HOST` | `--host` | `127.0.0.1` | See [binding to other interfaces](#binding-to-other-interfaces) before changing this |
| `TERMDECK_PORT` | `--port` | `8530` | |
| `TERMDECK_LOG_LEVEL` | `--log-level` | `info` | `critical`, `error`, `warning`, `info`, `debug`, `trace` |

## Storage

| Variable | Flag | Default | Notes |
|---|---|---|---|
| `TERMDECK_DATA_DIR` | `--data-dir` | `~/.termdeck` | Everything TermDeck persists |

Layout inside the data directory:

| Path | Contents |
|---|---|
| `sessions.json` | Every terminal: command, cwd, title, agent session ID, unsent draft |
| `closed_sessions.json` | The last 20 closed terminals, so they can be reopened |
| `projects.json` | Registered project directories and their slugs |
| `settings.json` | Fonts, panel widths, theme, keybindings, open files, active terminal |
| `scrollback/` | One ring-buffer file per terminal |
| `dtach/` | One socket per live terminal |
| `uploads/` | Files pasted or dropped into a prompt |
| `termdeck.log` | Service log (macOS; Linux logs to the journal) |

Running two instances against the same data directory is not supported — give each one its own
`TERMDECK_DATA_DIR` and port.

### Changing the data directory later

Stop TermDeck **and let your terminals exit** before moving the data directory. A `dtach` socket records the
path it was bound to inside the kernel, not just on disk, so a moved socket can no longer be found at its new
location. TermDeck will correctly decide the old terminal is dead and respawn it — your agent sessions still
resume, because the session IDs live in `sessions.json` — but the original processes are left running with
nothing able to reattach to them.

If you move the directory while terminals are live, clean up the strays afterwards:

```sh
ps -axo pid=,command= | grep "[d]tach -A /old/path"      # find them
kill <pids>                                              # then stop them
```

## Terminals

| Variable | Flag | Default | Notes |
|---|---|---|---|
| `TERMDECK_DEFAULT_CWD` | `--default-cwd` | `~` | Directory for new terminals when the project doesn't imply one |
| `TERMDECK_SHELL` | | `$SHELL`, else `/bin/zsh` (macOS) or `/bin/bash` (Linux) | Terminals run `<shell> -il`, commands run `<shell> -ilc <command>` |

Because commands run through a **login interactive** shell, your aliases, functions, and `PATH` edits from
`.zshrc`/`.bashrc` all apply.

Environment variables starting with `CLAUDE` are removed from the environment of spawned terminals, so a
terminal you launch from inside an agent session doesn't inherit that session's identity.

## File browser

| Variable | Flag | Default | Notes |
|---|---|---|---|
| `TERMDECK_FILE_ROOT` | `--file-root` | `~` | Hard confinement boundary for reading, writing, renaming, and trashing |

Requests that resolve outside this root are rejected. Files above 2 MB and binary files are refused.
Narrow this if you want a smaller blast radius — for example `--file-root ~/projects`.

## External programs

Each of these is resolved by checking the override, then `PATH`, then a list of well-known directories
(`/opt/homebrew/bin`, `/usr/local/bin`, `/home/linuxbrew/.linuxbrew/bin`, `/usr/bin`, `/bin`, `/usr/sbin`,
`/sbin`, `/snap/bin`). The fallback list is what makes discovery work under launchd and systemd, which start
services with a minimal `PATH`.

| Variable | Program | Required | Used for |
|---|---|---|---|
| `TERMDECK_DTACH_BIN` | `dtach` | yes | Keeping terminals alive across restarts |
| `TERMDECK_LSOF_BIN` | `lsof` | yes | Attributing agent sessions to terminals; process trees |
| `TERMDECK_PS_BIN` | `ps` | yes | Per-terminal cpu/rss stats |
| `TERMDECK_RG_BIN` | `rg` | no | Project search and replace |
| `TERMDECK_PGREP_BIN` | `pgrep` | no | Process lookup |

`termdeck doctor` prints what each one resolved to.

---

## Examples

**A second instance on another port, isolated from the first:**

```sh
termdeck --port 8531 --data-dir ~/.termdeck-scratch
```

**Confine the file browser to one tree and default new terminals there:**

```sh
termdeck --file-root ~/work --default-cwd ~/work
```

**Persist settings in your shell profile:**

```sh
export TERMDECK_PORT=9000
export TERMDECK_DEFAULT_CWD="$HOME/projects"
```

**Bake settings into the background service:**

```sh
termdeck --port 9000 --default-cwd ~/projects service install
```

The generated unit carries `TERMDECK_PORT` and `TERMDECK_DEFAULT_CWD` in its environment block. To change
them later, run `service install` again with the new flags — it overwrites the unit in place.

---

## Binding to other interfaces

TermDeck has **no authentication**. Whoever can reach the port can run arbitrary commands as your user, read
any file under the file root, and drive your agent sessions.

Binding to `0.0.0.0` therefore exposes a remote shell to the network. Don't, unless you have deliberately put
an authenticating reverse proxy in front of it.

To reach TermDeck from another device, forward the port over SSH instead:

```sh
ssh -N -L 8530:127.0.0.1:8530 you@your-machine
```

Then open <http://127.0.0.1:8530> on the local device. The traffic is authenticated and encrypted by SSH, and
the port is never exposed.

---

## UI settings

Fonts, panel widths, theme, keybindings, open files, and the remembered active terminal are **not**
environment variables — they are set in the UI and stored server-side in `settings.json`. That is deliberate:
they follow you across browsers and machines instead of living in one browser's local storage.

Reset them by stopping TermDeck and deleting `settings.json`.
