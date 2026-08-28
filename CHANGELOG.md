# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.7.0] — 2026-08-27

### Added

- Aider and OpenCode agent support: spawn with permission modes, activity tracking, Markdown transcripts,
  and restart recovery (OpenCode resumes with `-s <session-id>` and forks with `--fork`; Aider has no session
  IDs and restores its own conversation via an always-passed `--restore-chat-history`).
- Live activity dots under each session row showing what a Claude session is running in the background:
  active subagents, backgrounded shell commands, and persistent monitors, each with a count and hover
  description — derived from transcript state the watchers already maintain, never from polling.
- Browser desktop notifications when an agent needs attention or finishes a run longer than five seconds —
  only while the TermDeck tab is not focused — controlled by one settings switch. Notification permission is
  requested on the first click or keypress, where the browser actually allows the prompt to appear.
- A web app manifest makes TermDeck installable as a browser app; notifications from the installed app carry
  the TermDeck name and icon instead of the raw localhost origin, and carry the icon either way.
- Live context usage for the active agent session (`ctx 118k/258k`) in the bottom toolbar.
- Per-agent sidebar terminal icons, each toggleable in settings; the icon set is defined by the agent
  adapters, so a new agent brings its own.
- The Markdown-mode prompt queue works for every agent kind and accepts prompts while a response is still
  streaming, via a dedicated queue button beside send.
- An agent-CLI adapter API: supporting a new agent CLI is one Python class plus an optional client behavior
  entry (`docs/agent-cli-api.md`).
- The service log is trimmed to its last 2 MB once it passes 5 MB, at startup and every 15 minutes, so an
  always-on deck no longer accumulates an unbounded `termdeck.log`.

### Changed

- Stopping a response in Markdown mode now holds the prompt queue and returns the first queued prompt to the
  composer, instead of the interrupt immediately auto-dispatching the next queued prompt.

### Fixed

- Expanded thinking blocks and the reading position in Markdown mode survive live transcript updates. The
  rebuild that streaming routinely forces re-derived both from element indexes that stop matching the turn
  list after paged history loads; both are now keyed off the rendered elements themselves.
- Switching from Markdown mode back to the terminal repaints with a cleared glyph atlas, fixing scrollback
  rows rendering with mixed character widths and overlapping glyphs after output arrived while hidden.
- Activity dots no longer disappear for a few seconds whenever the session list refreshes.
- A running Claude `/compact` no longer shows the session as idle while it works (bounded at 15 minutes).
- Opening a terminal from the all-projects root view no longer aborts with a history SecurityError, which
  could leave the page stuck on boot (empty session list) when the last-visited state was a terminal there.

- Server startup no longer probes the process tree once per saved session. Reconciling dtach sockets now
  shares one machine-wide `lsof`/`ps` sample, so a deck of ~90 terminals reaches the listening port in
  well under a second instead of spending ~40-60s in `lsof` before uvicorn binds.
- A page that sees the server restart now waits five seconds before reloading, instead of reloading into
  the instant the new instance's port opened.

## [0.6.1] — 2026-08-20

### Fixed

- Homebrew now copies cached wheel resources back to their original filenames before invoking pip, avoiding the invalid `<sha>--<wheel>` filenames used by Homebrew's download cache.

## [0.6.0] — 2026-08-20

### Added

- Terminal groups with naming, renaming, merging, collapse state, and drag-driven ordering of terminals and groups.
- Per-session unread and view-mode state, and a confirmation step before restoring the last closed terminal.
- Claude Code hook endpoint so permission and elicitation prompts drive the attention indicator directly instead of being inferred from terminal text.
- Regression tests for terminal scrolling under `tools/scroll-tests/`, and a blank-screen guard that checks every running session for an empty pane, an oversized renderer canvas, or a transparent terminal surface.
- Direct local Wi-Fi access on a separate same-subnet-only listener, with a persisted Settings toggle and no cloud relay or login requirement.

### Changed

- Terminals run far taller than the visible viewport, so an agent CLI paints its whole interface into one screen and its history stays scrollable without relying on the terminal's own scrollback.
- Scrolling moves an outer container over that terminal rather than xterm's viewport, giving one scroll surface with a scrollable range that matches the content exactly.
- Sidebar animations changed to compositor-only properties, pause while the document is hidden, and pause outside the visible sidebar viewport, which measurably lowered idle browser CPU.
- Mobile browser sizing follows the visual viewport and supports horizontal access to the full desktop workspace in landscape and desktop-site modes.
- Homebrew formula generation now discovers native wheels for both Apple Silicon and Intel automatically, and tagged releases publish and clean-install-test the tap formula.

### Removed

- The experimental IndexedDB terminal-snapshot restore, superseded by the server-side repaint that reattaching already performs.

### Fixed

- Scrolling no longer fights the pointer: holding the scrollbar, dragging it, middle-click autoscroll, and fast wheel scrolling all leave the view where the gesture puts it.
- The newest output stays reachable after scrolling into history and back, and the scroll-to-bottom button and shortcut work against the scrolled surface.
- Typing returns to the prompt while Cmd shortcuts do not, so copying a selection no longer scrolls away from it.
- Find scrolls its match into view and holds it while output continues arriving.
- A composer redrawing itself no longer jumps the view, and reading history is no longer disturbed by output arriving underneath it.
- Codex transcript events with equivalent text no longer render as duplicate turns, and Claude prompt control prefixes no longer leak into Markdown history.
- Homebrew installs no longer omit the Intel `msgpack` wheel.

## [0.5.0] — 2026-08-17

### Added

- TermDeck Remote with Google sign-in, an outbound on-demand connector, hosted relay service, pairing controls, and deployment documentation.
- Cross-agent delegation from selected terminal, transcript, file, or note text to new or recently active agents.
- Stable project, worktree, terminal, and file navigation URLs for focused browser tabs and shared links.
- Processing and unread favicon states for the selected terminal.

### Changed

- Transcript-first is the standard Codex, Claude, and AGY conversation architecture, with terminal view remaining the default surface.
- Terminal reconnect and repaint behavior preserves usable client scrollback while repairing screens that missed detached output.
- Claude session tracking recognizes resume switches, excludes non-prompt metadata from activity, and retains parent transcript context for forks.
- Closing and reopening terminals restores focus and navigation more consistently.

### Fixed

- Reduced stale or blank terminal surfaces after reconnects and background-tab returns without disabling genuine terminal resizing.
- Corrected false Claude processing indicators caused by metadata-only transcript events.

## [0.4.0] — 2026-08-15

### Added

- First-class project worktree discovery, creation, selection, review, merge, keep, discard, and cleanup workflows.
- Managed isolated worktrees for delegated terminal tasks, with branch identity and parent-relative review diffs.
- AGY/Antigravity terminal, transcript, activity, model, permission, and dependency-install support.
- Expanded automation APIs for model selection, prompt submission and polling, placement, batching, worktrees, and output paths.
- Group-scoped terminal search, global open/closed terminal search, matching-line hover previews, and richer recently closed metadata.

### Changed

- Terminal groups, ordering, unread state, open files, and active selection are persisted independently per worktree.
- Settings and layout writes use scoped patches so concurrent browser tabs do not overwrite unrelated state.
- Terminal lifecycle, status restoration, prompt history, Claude snapshots, orphan cleanup, and restart behavior are more robust.
- Sidebar, notes, copied-text history, themes, file search, Git tools, keyboard shortcuts, and terminal maintenance controls were refined.

## [0.3.0] — 2026-08-14

### Added

- Native project file browsing, search, Git navigation, editor history, notes, themes, and terminal search improvements.
- Explicit hidden-file search through the file-type exclusion menu.
- Persistent terminal activity, prompt, clipboard, and automation workflow improvements.

### Changed

- Hidden project files are excluded from listings, recent-file scans, search, fuzzy filename matching, and replace by default.
- Git view typography follows the configurable tree font, and stale Git results are cleared when switching views.

## [0.2.0] — 2026-08-13

### Added

- Terminal output search with match navigation and viewport-aware highlighting.
- Manual Codex repaint with scroll-position restoration.
- Confirmed cleanup of running terminals older than 24 hours while retaining reattachable session records.
- FileDeck project viewer foundation and expanded editor workspace tools.

## [0.1.0] — 2026-07-22

First public release.

### Added

- **Persistent terminals.** Named terminal sessions in the browser, backed by real ptys running under
  `dtach` so processes survive the server going away. On restart TermDeck reattaches to still-live terminals
  and respawns dead ones.
- **Claude Code and Codex session resume.** Continuous tracking of which CLI session each terminal is
  currently on — exact when the CLI holds its session file open, inferred from newly created session files
  otherwise — so a restart re-enters that session with `--resume` / `codex resume`. Fork branches a session
  into a new terminal.
- **Unsent prompt drafts.** Keystrokes since the last Enter are reconstructed server-side, persisted, and
  re-injected after the CLI reboots.
- **Projects.** Named base directories, auto-registered from a terminal's cwd and URL-addressable at
  `/p/<name>`, each with its own terminals, open files, closed history, and default directory.
- **Markdown transcript view.** A rendered conversation read from the agent CLI's own session file, with
  collapsible diffs, a thinking indicator, a prompt composer, and an editable prompt queue.
- **File tree and Monaco editor.** Lazy VS Code-style tree that re-roots to the active terminal, the real
  Monaco editor for viewing and editing, clickable `path:line` links from terminal output, and trash-based
  deletes.
- **Project search and replace.** ripgrep-backed search with regex, case, whole-word, and glob filters, plus
  fuzzy find-by-name and project-wide replace.
- **Customizable keyboard shortcuts**, per-panel font sizes, resizable panels, light and dark themes — all
  persisted server-side so they follow you across browsers.
- **`termdeck` CLI** with `--host`, `--port`, `--data-dir`, `--default-cwd`, `--file-root`, `--log-level`,
  and `--open`.
- **`termdeck doctor`** — reports every external program TermDeck resolved, with install hints for anything
  missing. Exits non-zero when a required program is absent.
- **`termdeck service`** — installs, restarts, inspects, and removes a launchd user agent (macOS) or a
  systemd user unit (Linux), carrying the current `TERMDECK_*` settings into the generated unit.
- **Linux support** alongside macOS: binary discovery via `PATH` with well-known fallbacks, XDG trash,
  `$SHELL` detection, systemd units.
- **Configuration via `TERMDECK_*` environment variables**, with every CLI flag mapping to one.
- **Homebrew tap** (`danialfarid/tap/termdeck`) for macOS, installing dependencies from prebuilt wheels so
  nothing compiles; `uv`/`pipx` from the GitHub release everywhere else. Apache 2.0 license; full README,
  installation, configuration, troubleshooting, and architecture documentation.

[Unreleased]: https://github.com/danialfarid/termdeck/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/danialfarid/termdeck/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/danialfarid/termdeck/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/danialfarid/termdeck/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/danialfarid/termdeck/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/danialfarid/termdeck/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/danialfarid/termdeck/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/danialfarid/termdeck/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/danialfarid/termdeck/releases/tag/v0.1.0
