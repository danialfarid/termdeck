<div align="center">

# TermDeck

**A persistent workspace for coding agents.**

</div>

Puppet-master all your agents from one light browser tab. Never lose a session again: group them, give them
worktrees, and let them talk to each other. Around them, a light IDE — code, search, find usages, Git, pull
requests, syntax highlighting, linters, and notes on the fly. From your desk, or from the couch or the road on
your phone.

## Demos

Persistent agents, queues, notes, grouping, search, cross-agent handoff, and background activity.

![TermDeck terminal workflow](docs/media/demo-terminals-hd.gif)

*[Full-resolution terminal workflow video](docs/media/demo-terminals.webm)*

File tree, usages, history, blame, pending diffs, worktrees, remotes, and stashes.

![TermDeck Files and Git workflow](docs/media/demo-files-git-hd.gif)

*[Full-resolution Files/Git workflow video](docs/media/demo-files-git.webm)*

## Install

**macOS** — Homebrew brings `dtach`, `ripgrep`, and Python with it.

```sh
brew install danialfarid/tap/termdeck
termdeck service install
open http://127.0.0.1:8530
```

**Linux** — needs [`uv`](https://docs.astral.sh/uv/getting-started/installation/).

```sh
sudo apt install dtach ripgrep
uv tool install "git+https://github.com/danialfarid/termdeck.git"
termdeck service install
xdg-open http://127.0.0.1:8530
```

That takes the current release from the default branch; append `@<tag>` to pin an older one.

`termdeck service install` runs TermDeck in the background and starts it at login.

To update — sessions and settings stay in `~/.termdeck`, and live terminals keep running:

```sh
brew update && brew upgrade danialfarid/tap/termdeck                       # macOS
uv tool install --force "git+https://github.com/danialfarid/termdeck.git"  # Linux
termdeck service restart
```

## Start and stop

```sh
termdeck --open              # run in the foreground; Ctrl-C stops it
termdeck service start       # start the background service (installs it if it never was)
termdeck service stop        # stop it until the next start or login
termdeck service restart     # restart it; installs it too if it never was
termdeck service status      # is it running?
termdeck service logs        # tail the log
termdeck service uninstall   # stop it and remove the service
termdeck doctor              # report which external programs it found
```

Stopping TermDeck does not stop your terminals. They stay attached to `dtach` and are still there when it
comes back.

Press **+** to open a terminal, then choose an agent or shell and a project folder.

## Features

- **Any agent CLI** — Codex, Claude Code, AGY, Aider, OpenCode, and plain shells, side by side. Teaching it a
  new CLI is one adapter class.
- **Persistent sessions** — terminals and agent sessions survive browser and server restarts, and reopen into
  the same conversation after a machine restart.
- **Never lose a half-written prompt** — what you have typed is saved as you type. Refresh the page, restart
  the server, come back tomorrow: it is still in the box, and everything you have sent is in the history.
- **Parallel work** — group, reorder, fork, rename, close, reopen, and monitor many terminals. Background
  commands, monitors, and subagents show as live dots under the session that started them: nine agents, one deck,
  and a dot that tells you which one is actually waiting on you.
- **Agent handoff** — send selected context from a terminal, transcript, file, or note straight to another
  agent, without rebuilding the prompt.
- **[Agents talking to agents](docs/agents-termdeck-api.md)** — Codex hands Claude a task, watches its answer
  come back, and asks a follow-up, all through one local API. Every agent it starts is an ordinary terminal in
  your deck, so you can read the whole exchange as it happens.
- **Notifications** — attention and finished runs reach you while the tab is in the background. Install TermDeck
  as a browser app and they arrive under its own name and icon instead of a localhost address.
- **Transcript mode** — read clean conversations, queue follow-ups, run an agent's slash commands, inspect
  models, and open a conversation outline.
- **Search** — find sessions, prompts, responses, file names, and code across a project.
- **Files, Markdown, and media** — edit in Monaco, read Markdown as a rendered document, and open images, video,
  audio, and PDFs in place.
- **Git** — history, blame, diffs, staging, and GitHub pull requests, with a separate worktree when a task
  needs one of its own.
- **Code intelligence** — language servers for definitions, usages, diagnostics, hover, and code actions.
- **Notes, clipboard history, and attachments** — keep decisions and reusable context beside the agents, and
  drop a file or an image straight into a prompt.
- **Yours to rebind** — every keyboard shortcut, from the sidebar footer.
- **Phone and remote** — touch layouts, local Wi-Fi, and authenticated remote access when you are away from the
  machine.

```
┌──────────────────────────┬────────────────────────────────────────────────────┐
│ stock ▾                  │ terminal / transcript / file editor                │
├──────────────────────────┤                                                    │
│ TERMINALS          +  ⋯  │ $ codex resume 4f2a…                               │
│ ▾ ingestion         2 ●  │                                                    │
│   ◉ refactor parser      │   Analyzing the parser module…                     │
│   ○ review tests         │                                                    │
│ ● migrate cache          │   I found three call sites that need updating:     │
│                          │     trainer/prep/features/index_feat.py:210        │
│ RECENTLY CLOSED (50)     │     miner/sec/sec_miner.py:88                      │
│   ↺ old bugfix run       │                                                    │
│                          │ > continue                                         │
├──────────────────────────┼────────────────────────────────────────────────────┤
│ Files Search Git Notes   │ transcript  refresh  bottom  upload  model · stats │
└──────────────────────────┴────────────────────────────────────────────────────┘
```

## Requirements

- macOS 13+ or Linux
- Python 3.11+ (Homebrew installs it for you on macOS)
- `dtach` required; `ripgrep` recommended
- A current Chrome, Safari, Firefox, or Edge browser

## Troubleshooting

A terminal that looks wrong — garbled, blank, or behind — is almost always the browser's copy of it, not the
terminal. In order:

1. Reload the tab. If that is not enough, hard-refresh it (**⌘⇧R** / **Ctrl+Shift+R**).
2. Right-click the terminal in the side panel and choose **Restart**. The process is replaced; an agent
   terminal comes back into the same session.

If the page itself will not load, the loading screen offers **Refresh page**, **Restart TermDeck server**, and
**Stop running terminals** after a few seconds; from a shell, `termdeck service restart` does the same. More in
[docs/troubleshooting.md](docs/troubleshooting.md).

## Roadmap

- VS Code integration
- IntelliJ IDEA and JetBrains IDE integration
- Windows support

## Links

- [Full installation guide](docs/installation.md)
- [API reference](docs/api.md)
- [Configuration](docs/configuration.md)
- [Language servers](docs/language-servers.md)
- [Remote access](docs/remote-access.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Architecture](docs/architecture.md)

## Security

TermDeck runs commands on your machine and binds to localhost by default. Do not expose it to a network without
authentication and a protected tunnel or reverse proxy.

## License

[Apache License 2.0](LICENSE)
