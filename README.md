<div align="center">

# TermDeck

**A persistent workspace for coding agents.**

[![Release](https://img.shields.io/github/v/release/danialfarid/termdeck?sort=semver)](https://github.com/danialfarid/termdeck/releases)
[![Python](https://img.shields.io/badge/python-3.11%2B-blue.svg)](https://www.python.org/downloads/)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![CI](https://github.com/danialfarid/termdeck/actions/workflows/ci.yml/badge.svg)](https://github.com/danialfarid/termdeck/actions/workflows/ci.yml)

</div>

Puppeteer all your coding agents from one local browser workspace. TermDeck keeps Codex, Claude Code, Aider,
AGY, OpenCode, and shell sessions organized across projects and worktrees — showing what is running, finished,
unread, or waiting for you.

Sessions survive browser and server restarts. Read clean transcripts, hand work between agents, search every
conversation, and use the built-in files, Git, and code-intelligence tools without losing track of the terminals
doing the work. Remote access built in: reach the whole deck from anywhere.

## Why TermDeck?

VS Code and IntelliJ IDEA treat terminals as panels inside an editor; TermDeck treats long-running coding agents as
the workspace itself. Codex, Claude Code, and their apps are powerful on their own but remain separate experiences;
TermDeck brings their CLIs and other agents under one umbrella for shared visibility, search, handoff, and delegation.
Run different agent CLIs side by side, organize them by project and worktree, and see who is working, finished, or
waiting for their human. Sessions keep running when you close the browser or restart TermDeck. Switch between the live
terminal and readable Transcript mode, search past conversations, preserve unfinished prompts, queue follow-ups, and
hand context or tasks between agents. Built-in file editing, Git, and code intelligence keep review and development
close to the work, while optional remote access lets you continue from another computer or your phone. Your existing
CLIs, running on your machine, with fewer tabs to babysit.

## Demos

Persistent agents, worktrees, queues, notes, grouping, search, cross-agent handoff, and background activity.

![TermDeck terminal workflow](docs/media/demo-terminals.gif)

*[Full-resolution terminal workflow video](docs/media/demo-terminals.webm)*

File tree, usages, history, blame, pending diffs, remotes, and stashes.

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

- **Keep agents running** — sessions continue through browser closures and TermDeck server restarts. Tracked agent
  conversations resume after a machine restart, while saved drafts and prompt history help you continue where you
  left off.
- **Keep track of parallel work** — group sessions by project, task, and worktree, with activity and unread
  indicators showing what needs your attention.
- **Read conversations in Transcript mode** — switch from terminal output to formatted prompts and responses,
  with collapsible thinking blocks, a conversation outline, and a composer for follow-up questions.
- **[Let agents delegate](docs/agents-termdeck-api.md)** — use the local API to start named agents with a chosen
  model, permission level, and prompt, then monitor their responses. Each task appears as an ordinary session in
  your workspace.
- **Review and edit alongside your agents** — open referenced files, search code, inspect changes, and use Git
  and language-server tools without leaving the workspace.
- **Any agent CLI** — Codex, Claude Code, AGY, Aider, OpenCode, and plain shells, side by side. Teaching it a
  new CLI is one [declarative profile](docs/agent-profiles.md), with Python adapters reserved for unusual formats.
- **Portable workspaces** — export one terminal with its resume profile, draft, transcript, and available replay,
  or export a whole project with its tabs, groups, notes, colors, and layout; restore it elsewhere after cloning
  the source.
- **Never lose a half-written prompt** — what you have typed is saved as you type. Refresh the page, restart
  the server, come back tomorrow: it is still in the box, and everything you have sent is in the history.
- **Notifications** — attention and finished runs reach you while the tab is in the background, and a quiet
  release badge appears when a newer TermDeck version is available. Expand it to preview the upgrade command,
  then click Run update to install on the machine hosting TermDeck, with progress and errors shown in place.
- **Search and hand off across sessions** — find sessions, prompts, responses, file names, and code across a
  project, then send selected or copied context from a terminal, transcript, file, or note straight to another
  agent without rebuilding the prompt.
- **Files, Markdown, and media** — edit in Monaco, read Markdown as a rendered document, and open images, video,
  audio, and PDFs in place.
- **Git** — history, blame, diffs, staging, and GitHub pull requests, with a separate worktree when a task
  needs one of its own.
- **Code intelligence** — language servers for definitions, usages, diagnostics, hover, and code actions.
- **Notes, clipboard history, and attachments** — keep decisions and reusable context beside the agents, and
  drop a file or an image straight into a prompt.
- **Phone and remote** — touch layouts, local Wi-Fi, Google-authenticated hosted access, or your own bearer-token
  tunnel with an optional monitoring-only mode.

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
**Stop running terminals** after a few seconds; from a shell, `termdeck service restart` does the same.

If the server will not start with *address already in use*, something else has port 8530: run it on another
with `termdeck --port 9000`, or bake that in with `termdeck --port 9000 service install`.

More in [docs/troubleshooting.md](docs/troubleshooting.md).

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

## Features in detail

**Terminals and agents**

- Codex, Claude Code, AGY, Aider, OpenCode, or a plain shell, launched with the CLI's own permission mode
  (read-only, workspace-write, accept-edits, full access, …).
- Every terminal runs under `dtach`: closing the tab or restarting the server leaves the process running.
- Claude, Codex, and OpenCode sessions are tracked continuously — through `/clear` and in-TUI session switches —
  and resumed after a machine restart.
- Unsent input is reconstructed and saved as you type, and re-injected when the terminal comes back.
- Fork a session into one copy or up to 25 numbered ones, placed beside the original.
- Restart with a different permission mode, rename, copy the session ID, mark unread, ignore attention, or
  open a terminal alone in its own browser tab.
- Drag to reorder; collapsible, nameable groups; move one or many terminals between groups and projects.
- Search names and output across open and closed terminals, with match navigation inside a terminal.
- Recently closed terminals keep their history and group and reopen from the list.
- File paths and `path:line` references printed in any terminal are clickable.
- Drop a file or paste an image into a terminal and its path lands at the cursor.
- Per-agent icons in the terminal list, each toggleable; working state animates, unread stays until you look.
- Choose an explicit model at launch for Codex, Claude, AGY, Aider, or OpenCode. Aider and OpenCode accept
  OpenRouter model IDs while retaining their own terminal icon, activity signal, permissions, and resume rules.
- Add another CLI through `agent-profiles.json`: launch/model arguments, permission presets, resume, fork,
  rename, generic JSONL transcripts, event-driven activity, attention markers, and a brand icon are declarative.
- Live activity dots for background commands, monitors, and subagents under the session that owns them.
- The favicon shows the selected terminal's working and unread state.
- CPU and memory for the app and for each terminal's process tree in the bottom bar; under Maintenance, a
  process report, orphan cleanup, kill terminals older than 24 hours, and kill all.

**Transcript mode**

- The agent's own session file rendered as Markdown: code edits and thinking collapsible; model, reasoning
  effort, and elapsed time shown.
- A composer where Enter is a newline, Shift+Enter sends, ⌘Enter queues; queued prompts run in order, stay
  editable, and any one can be sent now.
- The agent's slash commands from a palette.
- Filters: hide prompts or thinking, show only code edits, fold near-duplicate responses.
- Conversation outline with timestamps for jumping between turns.
- Live context usage (`ctx 118k/258k`) and persisted prompt history.
- A submitted prompt stays visibly pending until the transcript confirms it — through reloads and restarts.

**Notifications**

- Desktop notifications when an agent needs attention or finishes a run longer than five seconds, unless you
  are looking at that terminal.
- Installed as a browser app, they carry TermDeck's name and icon.
- A Claude Code hook endpoint drives the attention badge from real permission prompts.

**Projects and worktrees**

- A project is a folder: add one from the **+** menu with a folder picker, or open a terminal in it and it
  registers itself. Switching projects swaps terminals, files, closed history, and defaults.
- Give a project or worktree a colour from its picker; the header label and the browser tab's favicon take
  it, so ten tabs tell apart at a glance.
- Every project, worktree, terminal, and file has a stable URL — one browser tab per project, or per task.
- Worktrees are discovered and created (named, on a chosen branch, in a remembered folder); view one or all;
  each keeps its own terminals, groups, and closed history.
- Delegated tasks can run in an isolated worktree with a review diff and keep, merge, or discard.

**Files and editor**

- VS Code's Monaco editor: highlighting, folding, find and replace, symbols, definitions and usages, Problems.
- Language servers add rename, code actions, hover documentation, and diagnostics.
- Markdown renders as a document with working links; images, video, audio, and PDFs open in place.
- Local snapshots and Git history for any open file, with diffs and targeted restore.
- Create, rename, duplicate, move, refresh, and trash from the tree — deletes go to the system trash.
- Open files and navigation history survive reloads; external changes are re-read.

**Git**

- Stage and unstage files or single hunks, commit, branches, stashes, and the commit graph.
- Diffs for pending changes and any commit, blame, compare any two versions, cherry-pick, and revert.
- Conflicts resolved ours, theirs, or by hand.
- Remotes: fetch, fast-forward pull, push over SSH or HTTPS, and clone straight into a project.
- GitHub pull requests listed in the panel; open on GitHub or copy the URL.

**Search**

- ripgrep across the project — plain or regex, case, whole word, include patterns, exclusion chips — with
  results that keep the tree, Git state, and modified time.
- Project-wide replace, capped at 200 files per run.
- Filename search: exact and contains first, typos second, with its own history and filters.
- Quick Open across commands, recent terminals, open files, file names, and symbols.

**Notes and clipboard**

- Multi-tab plain-text notes over the workspace, autosaved, edited in Monaco, filled from any selection;
  closed notes go to the trash.
- Copied-text history, with a picker that pastes into whatever is focused.
- Right-click any selection to copy it, note it, search from it, or hand it to an agent as **Ask an agent**.

**Automation**

- A local API to start a named agent with a model, permission mode, and placement; send it prompts; poll its
  last turn; write its output to a file; close it.
- Batch launch of up to 32 named tasks.
- Everything an agent starts is an ordinary terminal in the deck.

**Remote and mobile**

- Local Wi-Fi access on its own listener — no relay, no login.
- TermDeck Remote: Google sign-in through a hosted relay, with pairing controls.
- Optional bearer-token protection for direct LAN, VPN, SSH-tunnel, and reverse-proxy access; server-wide
  read-only mode keeps monitoring live while blocking terminal input and mutations.
- Touch layouts with long-press row actions, drafts kept through outages, and automatic reconnection.
- Agent CLIs use the touch-friendly Transcript surface on phones; plain shell sessions keep the live terminal
  and mobile keyboard/paste input for commands that do not depend on TUI arrow-key menus.

**Look and feel**

- Themes: Nord, macOS Terminal, GitHub, One Dark, Monokai, Dracula, Solarized, Gruvbox, Tokyo Night,
  Catppuccin, Rosé Pine, Ayu, and high contrast.
- Font size per region — title, terminal list, terminal, editor, tree, tabs, diffs, icons, bottom bar — with an
  in-place slider over each.
- Every shortcut rebindable; panel widths remembered.
- Settings, notes, keybindings, and layout live in `~/.termdeck/settings.json` and can be exported.

**CLI and service**

- `termdeck` runs in the foreground; `termdeck service` installs, starts, stops, restarts, and tails a launchd
  or systemd user service.
- `termdeck doctor` names any missing program with its install command.
- One-click diagnostics downloads a bounded, sanitized support bundle; opt-in recording captures browser geometry
  and interaction timing without terminal output, prompts, source files, or credentials.
- Every flag is a `TERMDECK_*` variable, so a shell profile and a service unit are configured the same way.

## Security

TermDeck listens only on <http://127.0.0.1:8530> by default, so other machines cannot connect. Local Wi-Fi and
TermDeck Remote are both disabled by default and create no external access until you explicitly enable them.
When enabled, TermDeck Remote keeps the local listener private: the browser signs in with Google, the computer
is explicitly paired, and traffic to and from the hosted relay is encrypted with HTTPS/WSS.

If enabled, Local Wi-Fi uses a separate port, `8532`. Enable it only on a trusted home or office network and never
on public Wi-Fi.

See [Remote access and encryption](docs/remote-access.md) for authentication, encryption, SSH/VPN, and read-only
setup options, and see [the security policy](SECURITY.md) for the full threat model and reporting process.

## License

[Apache License 2.0](LICENSE)
