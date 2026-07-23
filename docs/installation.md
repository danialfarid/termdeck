# Installation

TermDeck is a Python package that ships its own web UI. It needs a couple of small external programs to do
its job — `dtach` above all, because that is what keeps terminals alive when the server goes away.

## Requirements

| | |
|---|---|
| OS | macOS 13+ or Linux |
| Python | 3.11+ |
| Required | `dtach` |
| Recommended | `ripgrep` (project search and replace) |
| Optional | `claude` and/or `codex` CLIs (agent session resume) |

`lsof` and `ps` are also used, and are present by default on both macOS and every mainstream Linux distro.

> **Not yet on PyPI.** `pip install termdeck` is planned. On macOS use the Homebrew tap below; everywhere
> else install from the GitHub release with `uv` or `pipx`.

---

## Homebrew (macOS)

```sh
brew install danialfarid/tap/termdeck
```

The tap pulls in `dtach` and `ripgrep` automatically, and installs TermDeck's Python dependencies from
prebuilt CPython 3.13 wheels, so nothing compiles at install time. Works on Apple Silicon and Intel.

Upgrade later with `brew update && brew upgrade termdeck`.

---

## uv (macOS and Linux)

`uv` brings its own Python, so the system Python version doesn't matter.

```sh
uv tool install "git+https://github.com/danialfarid/termdeck.git@v0.1.0"
```

Upgrade to a newer release by re-running with the new tag. Pin to `main` instead of a tag for the latest
development version.

## pipx

```sh
pipx install "git+https://github.com/danialfarid/termdeck.git@v0.1.0"
```

## pip

Only if you want it inside a specific environment rather than as a standalone tool:

```sh
python3 -m pip install "git+https://github.com/danialfarid/termdeck.git@v0.1.0"
```

### Installing the external tools

Homebrew handles this for you. Everyone else:

```sh
brew install dtach ripgrep                 # macOS, Linuxbrew
sudo apt install dtach ripgrep             # Debian, Ubuntu
sudo dnf install dtach ripgrep             # Fedora, RHEL
sudo pacman -S dtach ripgrep               # Arch
sudo zypper install dtach ripgrep          # openSUSE
```

The agent CLIs, if you want session resume:

```sh
npm install -g @anthropic-ai/claude-code
npm install -g @openai/codex
```

---

## From source

```sh
git clone https://github.com/danialfarid/termdeck.git
cd termdeck
python3 -m venv .venv
.venv/bin/pip install -e .
.venv/bin/termdeck --open
```

`-e` gives you an editable install, so edits to the Python source take effect on the next restart and edits
to `termdeck/static/` take effect on the next browser reload.

---

## Verify the install

```sh
termdeck doctor
```

```
termdeck  http://127.0.0.1:8530
data dir  /Users/you/.termdeck
file root /Users/you
shell     /bin/zsh

[ok ] dtach    /opt/homebrew/bin/dtach
[ok ] zsh      /bin/zsh
[ok ] lsof     /usr/sbin/lsof
[ok ] ps       /bin/ps
[ok ] rg       /opt/homebrew/bin/rg
[ok ] claude   /Users/you/.local/bin/claude
[ok ] codex    /opt/homebrew/bin/codex

all required programs present
```

Anything missing is printed with the exact command to install it. `doctor` exits non-zero if a **required**
program is missing, so it is safe to use in a setup script.

---

## First run

```sh
termdeck --open
```

The server starts on <http://127.0.0.1:8530> and your browser opens. Press **⌘B** to open your first terminal.

To pick a different port or data directory:

```sh
termdeck --port 9000 --data-dir ~/somewhere-else
```

---

## Install as a background service

So it is always there, and starts at login:

```sh
termdeck service install
```

Flags given at install time are baked into the generated unit:

```sh
termdeck --port 9000 --default-cwd ~/projects service install
```

| | macOS | Linux |
|---|---|---|
| Mechanism | launchd user agent | systemd user unit |
| Unit file | `~/Library/LaunchAgents/com.termdeck.plist` | `~/.config/systemd/user/termdeck.service` |
| Logs | `~/.termdeck/termdeck.log` | systemd journal |
| Restart | `termdeck service restart` | `termdeck service restart` |

On Linux, to have the service run without a graphical login session:

```sh
sudo loginctl enable-linger $USER
```

Remove it with `termdeck service uninstall`.

---

## Upgrading

| Installed with | Upgrade |
|---|---|
| Homebrew | `brew update && brew upgrade termdeck` |
| uv | `uv tool install --force "git+https://github.com/danialfarid/termdeck.git@v0.1.0"` |
| pipx | `pipx install --force "git+https://github.com/danialfarid/termdeck.git@v0.1.0"` |
| pip | `pip install --upgrade "git+https://github.com/danialfarid/termdeck.git@v0.1.0"` |
| Source | `git pull` |

If you run it as a service, restart it afterwards so the new version is picked up:

```sh
termdeck service restart
```

Your terminals will respawn and resume, so an upgrade costs you nothing but a few seconds.

---

## Uninstalling

```sh
termdeck service uninstall     # stop the service and remove the unit file first
brew uninstall termdeck        # or: uv tool uninstall termdeck / pipx uninstall termdeck
```

Your data in `~/.termdeck` is left alone. Delete it yourself if you want it gone.
