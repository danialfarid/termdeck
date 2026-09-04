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
| `TERMDECK_REMOTE_URL` | | TermDeck hosted relay | Hosted relay used by Settings → Remote access |
| `TERMDECK_ACCESS_TOKEN` | | disabled | Bearer token required by direct HTTP, API, and WebSocket access |
| `TERMDECK_READ_ONLY` | | `false` | Allow reads and live monitoring but reject terminal input and mutating HTTP requests |

## Storage

| Variable | Flag | Default | Notes |
|---|---|---|---|
| `TERMDECK_DATA_DIR` | `--data-dir` | `~/.termdeck` | Everything TermDeck persists |

Layout inside the data directory:

| Path | Contents |
|---|---|
| `sessions.json` | Every terminal: command, cwd, title, agent session ID, unsent draft |
| `closed_sessions.json` | The last 100 closed terminals, so they can be reopened |
| `projects.json` | Registered project directories and their slugs |
| `settings.json` | Fonts, panel widths, theme, keybindings, open files, active terminal |
| `agent-profiles.json` | Optional declarative launch, resume, fork, transcript, activity, permission, and icon profiles |
| `scrollback/` | One ring-buffer file per terminal |
| `backups/` | Rotating snapshots of sessions, settings, projects, and closed-session metadata, capped at 50 MB |
| `dtach/` | One socket per live terminal |
| `uploads/` | Files pasted or dropped into a prompt |
| `update-check.json` | Latest GitHub release metadata, refreshed at most once per day when a UI is opened |
| `termdeck.log` | Service log (macOS; Linux logs to the journal) |

Running two instances against the same data directory is not supported — give each one its own
`TERMDECK_DATA_DIR` and port.

`agent-profiles.json` is loaded once at startup. See [Declarative agent profiles](agent-profiles.md) for the
schema and a complete example.

TermDeck writes a state snapshot before critical JSON changes, throttled to one pre-write snapshot every five
minutes, and once per hour. The backup directory is
rotated by total size, keeping the newest snapshots within the 50 MB cap. If a critical JSON file is missing,
malformed, or has the wrong top-level shape at startup, TermDeck enters recovery mode and does not restore
anything automatically. The recovery page lists the available snapshots and their timestamps; selecting one
explicitly restores all critical JSON files, preserves the current files under `backups/recovery/`, and restarts
the service.

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

## Language servers

Language-server commands are optional and start lazily when a matching file is opened. TermDeck checks the
default executable names unless the corresponding complete command is supplied through
`TERMDECK_LSP_PYTHON`, `TERMDECK_LSP_TYPESCRIPT`, `TERMDECK_LSP_GO`, `TERMDECK_LSP_RUST`,
`TERMDECK_LSP_CLANGD`, `TERMDECK_LSP_JAVA`, `TERMDECK_LSP_RUBY`, `TERMDECK_LSP_PHP`,
`TERMDECK_LSP_BASH`, `TERMDECK_LSP_YAML`, `TERMDECK_LSP_JSON`, `TERMDECK_LSP_HTML`, or
`TERMDECK_LSP_CSS`. See [Language servers](language-servers.md) for the command and installation table.
The Language servers section in the UI settings can disable LSP entirely, assign a complete command globally
or for one project, and takes precedence over these environment defaults. TypeScript projects automatically
select the native TypeScript 7 LSP or the TypeScript 6 legacy server from their project-local version.

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

Without `TERMDECK_ACCESS_TOKEN`, whoever can reach the port can run arbitrary commands as your user, read any
file under the file root, and drive your agent sessions. Binding to `0.0.0.0` without an access token therefore
exposes a remote shell to the network.

Set a long random bearer token before direct network access:

```sh
export TERMDECK_ACCESS_TOKEN="$(openssl rand -hex 32)"
termdeck service install
```

The browser redirects to a local token form and stores a derived HttpOnly session cookie. API clients send
`Authorization: Bearer <token>`. TermDeck's generated launchd/systemd unit is owner-readable only when it
persists this environment variable. A token authenticates the client but does not encrypt traffic, so use an
SSH tunnel, a VPN such as Tailscale, or an HTTPS reverse proxy on untrusted networks.

For a monitoring-only server, also set `TERMDECK_READ_ONLY=1`. Read-only mode allows pages, searches, files,
transcripts, Git status, session exports, and live terminal output. It rejects terminal input, terminal startup,
and all non-GET APIs. It is not a confidentiality boundary: the viewer can still read everything TermDeck exposes.

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
