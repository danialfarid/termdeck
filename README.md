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

![TermDeck terminal workflow](docs/media/demo-terminals.gif)

*[Full-resolution terminal workflow video](docs/media/demo-terminals.webm)*

File tree, usages, history, blame, pending diffs, worktrees, remotes, and stashes.

![TermDeck Files and Git workflow](docs/media/demo-files-git.gif)

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
termdeck service restart     # restart the background service
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
- **Persistent sessions** — prompts, drafts, terminals, and agent sessions survive browser and server restarts,
  and reopen into the same conversation after a machine restart.
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
