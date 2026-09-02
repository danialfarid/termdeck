# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Transcript composers provide an agent-specific slash-command palette for safe noninteractive commands,
  submitted through the existing session without creating a terminal renderer.
- Mobile terminal rows expose their actions through a movement-cancelled long press, while the selected row
  shows a discoverable actions button in place of its close button.
- Mobile Transcript mode now keeps drafts in browser-local storage during server or network outages and
  shows a fixed connection-loss warning with a Refresh action.
- Each queued Transcript prompt now has a Send now action that immediately submits that item without
  replacing the current composer draft.
- Transcripts now expose Quick Notes and project-scoped filters for hiding prompts or thinking,
  showing only structured code edits, and folding adjacent responses whose text is at least 80% similar.
- Conversation outlines show each turn's transcript timestamp and include every older page loaded by
  scrolling transcript history instead of remaining limited to the initial transcript page.

### Changed

- Transcript prompts awaiting authoritative history confirmation keep a distinct pending background and show
  a compact blue Submitting state directly below the message.
- Transcript history collapses Codex's mirrored `item_completed` and `response_item` records even when
  incremental file reads or history paging parse the two records in separate batches.
- Agent sessions remain Transcript-only on touch/mobile layouts, and a live Transcript connection now clears
  stale connection-loss warnings even while the status socket is reconnecting.
- Transcript Send controls use less horizontal space, stacking the options arrow underneath Send so the
  composer gains the full width previously occupied by the arrow segment.
- Transcript activation no longer constructs xterm or opens a terminal replay connection; each terminal is
  materialized and connected only when that session is explicitly switched to Terminal mode.
- Add-terminal, add-group, project-add, branch-add, and note-add glyphs are about 25% larger without changing
  their button dimensions or surrounding layout.
- Side-panel add controls keep their larger cross shape with thin CSS strokes instead of a heavier enlarged font glyph.
- Mobile Quick Notes keeps a reachable toggle for closing the panel and places the panel close control above other mobile controls.
- Transcript elapsed-time blinking now uses the same 1.65-second cadence as the active thinking indicator.
- Quick Notes uses a smaller single rounded edit-square glyph, and the Transcript progress elapsed time gently
  pulses while a response is running.
- Touch layouts omit keyboard-shortcut suffixes from menus and Transcript hints, while Transcript controls now
  use a conversation icon and the README consistently calls the surface Transcript mode.
- Mobile Transcript keeps Notes, filters, and zoom controls right-aligned, with Notes nearest the edge and
  zoom controls grouped to their left.
- Transcript code-edit collapse now lives in the filter menu, and Problems is available only on file,
  search, and Git surfaces.
- The app now calls the rendered agent-history surface Transcript mode instead of Markdown mode.
- Mobile Transcript mode no longer opens the terminal replay socket in the background, so switching
  sessions starts from the small newest-turn transcript page without downloading the terminal buffer,
  including when a phone requests the browser's desktop-site layout.
- Transcripts render their newest snapshot chunk first while older chunks continue loading,
  reducing the time to visible content on mobile and slower connections.
- Mobile transcripts load a small newest-turn page first and fetch older pages only when the reader
  scrolls upward instead of eagerly rendering hundreds of turns during every tab switch.
- Ask an agent actions started from Transcript mode now place the selected text directly into the chosen
  existing or newly created agent's persisted Transcript composer and focus it.
- Transcript prompts now use Enter for new lines, Shift+Enter to send, and Command/Ctrl+Enter to queue,
  while saved drafts appear immediately when a transcript is restored after a page reload.
- The Transcript composer now starts at one line, keeps prompt history beneath the editor, and combines
  immediate Send with an attached menu that clearly offers Send to queue.
- Project and worktree titles now open searchable TermDeck menus with keyboard navigation instead of
  native browser selects, showing up to 50 choices before asking for a narrower search.
- Transcript prompt queues use a stronger separator, subtle panel tint, roomier prompt padding, and
  scrollbars only when a queued message exceeds its height limit, plus an expandable header that can
  collapse the queue while keeping its message count visible.
- Transcript Send remains available while a response is running; the arrow menu offers Stop and, when a
  prompt is present, Send to queue, while submitted prompts bring the transcript to the latest turn.
- The recent-prompt history control now stays at the right edge of the Transcript composer footer.
- The Transcript composer uses a compact one-line continuation placeholder, while its send controls stay
  one-line tall as the prompt grows.
- Touch layouts start with the sidebar collapsed so the main surface is immediately visible; the sidebar
  can be expanded when terminal switching is needed.
- A mobile Transcript Send tap made while the selected terminal is still connecting is held and submitted once
  its websocket opens, so progressing sessions do not silently drop the prompt.

### Fixed

- Quick Notes added or edited in one window stay put: notes are stored one at a time instead of as a whole
  list, so a note added in one window or device is no longer deleted by the next save from another one.
- Returning focus to a disconnected TermDeck page now reconnects only the status and active-surface sockets,
  shows a temporary Reconnecting message, and preserves existing views instead of offering a full-page reload.
- Transcript prompt submissions remain visibly pending in per-project browser storage through refreshes and
  server restarts, and clear only after the authoritative agent transcript contains the matching user turn.
- Pending Transcript prompts now confirm when Codex records multiple submissions as one newline-delimited user
  turn, with a one-time authoritative-history reconciliation for pending records restored after reconnect.
- Sending a Transcript prompt while an agent is working submits it directly without automatically interrupting
  the current response or routing it through TermDeck's queue; interruption and queuing remain explicit actions.
- Transcript Stop sends each agent's actual interrupt input, including Escape for Codex instead of the
  previously ineffective universal Ctrl-C, without pulling queued prompts back into the composer.
- Touching a queued Transcript message now expands its editor to the mobile Transcript surface and keeps the
  active final line visible while typing instead of resetting the queue scroll position.
- Mobile Transcript exposes its filter menu, keeps the active multiline composer line visible while typing,
  and re-arms long-load recovery actions for later terminal switches.
- The bottom refresh action now reloads Transcript content instead of doing nothing in Transcript mode,
  while mobile toolbar actions dismiss rather than reopen the on-screen composer keyboard.
- Mobile Transcript zoom and Notes controls now hide while the sidebar is expanded, preventing them from
  overlapping the sidebar controls and terminal list.
- Successful Transcript queue sends now remove the acknowledged item from persisted queue state and clear
  only an identical composer draft, while multiline drafts grow to a larger scrollable editor.
- Transcript reconnect parsing now runs outside the server request loop and paints the newest page before
  refreshing the live cache, keeping mobile Send, Queue, and history paging responsive on large sessions.
- Remote and touch Transcript readers use the same lightweight paging policy, prefetch older turns before
  reaching the exact top, and persist queue changes immediately instead of waiting for the settings debounce.
- Queued Transcript prompts now dispatch through the server even when the terminal websocket is unavailable,
  so an idle prompt no longer waits for a full page refresh before it starts.
- Transcript Send and queued dispatch now use the acknowledged prompt API, preserving the composer or queue
  when submission fails instead of depending on a potentially stale mobile terminal websocket.
- Mobile Transcript history loads older transcript pages before the scroll reaches the exact top and
  keeps loading through touch momentum instead of depending on one narrow scroll-event threshold.
- Transcript history pages apply their turn limit after collapsing tool activity, so scrolling upward
  receives a full page of visible conversation instead of a handful of rows from a raw-event page.
- Mobile Transcript controls remain available whether the sidebar is open or collapsed, terminal resync
  fits the phone-width surface, and Quick Notes stays within the mobile viewport without focus zoom or
  duplicate Notes buttons.
- Transcript mode preserves the hidden terminal's geometry while live output continues and resets its
  renderer after returning to Terminal mode, preventing stale glyph rows from garbling Codex's TUI.

- Codex terminals no longer remain marked as processing after a Transcript/API prompt completes before
  the transcript watcher receives its final lifecycle event.

## [0.8.1] — 2026-08-30

### Added

- A recorded demo on the project's front page.

### Fixed

- A terminal scrolled back into its history stays there when you switch to another app and return.
  The focus report a terminal sends on the way back counted as input, which snapped the view down to
  the composer and lost the reading position.

### Changed

- The terminal selection menu offers one **Search in files** entry instead of separate "File
  contents" and "File name" ones; searching by file name stays on its toolbar button and keybinding.

## [0.8.0] — 2026-08-29

### Added

- **Ignore attention** in a terminal's context menu: drop the attention badge on a terminal you do
  not want to answer yet without touching its prompt. The terminal stays unread, so it is still
  visibly waiting for you.

- **A new worktree is described rather than generated.** The dialog asks for a worktree name, the branch to
  check out, an optional new branch, and the exact folder to check out into. The branch field filters as you
  type (prefix matches first), the folder field shows the full path and follows the name until you edit it,
  and Browse picks the folder it goes in. Creating shows a spinner with the git commands as they run, since
  `git worktree add` copies a whole checkout and otherwise looks frozen.

- A worktree's folder is remembered per project: rename the root once — `stock-wts` instead of the default —
  and the next worktree starts there.

- Font size for the open-file tabs. The `files_tab_font_size` setting existed but nothing had read it since
  the side-panel redesign, so the tabs borrowed the status-line size; the whole strip now scales with it.

### Changed

- **A worktree no longer creates a branch unless you name one.** A worktree and a branch are separate
  things; creation forced `git worktree add -b` and invented a `termdeck/<slug>-<sha>` branch nobody asked
  for. Leaving the new-branch field empty checks the selected branch out as it is.

- A project's worktrees default to a sibling `<project>-worktrees/` folder instead of a hidden shared
  `.termdeck-worktrees/`, and the folder is named for the worktree with nothing appended. A folder that is
  already taken is reported in the dialog, offering to open the worktree that is in the way.

- The files, search, and git side panel is part of the sidebar again instead of floating over it. It had
  become an overlay covering the terminal list, the sidebar chrome and part of the workspace, with no way to
  pin it — the pin button had been dropped from the markup while the code still keyed off it. The sidebar
  now widens to half again its width and the workspace shifts over.

- Switching between the files, search, and git tabs updates the address again. Once git had been opened the
  URL stayed on `/g/`, because the mode was read from the path already showing rather than from the tab.

- Settings are shorter and better ordered: font sizes and language servers follow the terminal icons, export
  settings is its own row rather than buried under Maintenance, rules separate the entries, and the stats
  toggle reads "Resource monitor & maintenance". Maintenance itself moved onto the CPU/memory readout —
  click it for the process report, orphan reclaim, and both kill actions, including the bottom bar's former
  trash button. Clicking it again closes the menu, and hovering names which number is which.

- Font sizes are edited through Visualize or Samples; the inline +/- list they duplicated is gone. "Pause
  inactive rendering" is now a code-only flag rather than a switch, being unfinished.

### Fixed

- **Deleting a worktree no longer deletes a branch it did not create.** Removal ran `git branch -D`
  unconditionally, so checking out an existing branch and later removing the worktree would have taken the
  branch with it.

- A failed worktree creation says what went wrong. Every failure — a bad path, a taken branch name, a base
  ref that does not exist — was reported as "project is not a Git repository", and the message replaced the
  dialog rather than appearing in it, losing what you had typed.

- Icons inside the file tabs can be sized at all. Both codicon.css and Monaco's stylesheet size every icon
  through `.codicon[class*='codicon-']`, and Monaco's copy is injected after the app's, so the tab rules
  never applied — the history tab's icon had never rendered at its intended size.

- Interrupting a busy Claude no longer leaves the session without a working indicator. Escape makes
  Claude cancel and immediately start whatever was queued behind it; the interrupt flag used to hold
  until the next prompt submitted through TermDeck, so that real work ran with no spinner.

- Right-clicking near the bottom of the window now opens the context menu above the pointer instead of
  pinning it to the bottom edge, where it covered the very selection it was acting on.

- A terminal you had scrolled up in now returns to the composer whenever input is sent to it, not only
  when you type or paste into it. Sending a queued prompt, handing a selection to an agent, or driving a
  terminal from a script left the view parked where you had scrolled it, writing into a composer that
  stayed off screen.

- A streaming agent no longer walks its composer off the bottom of the screen, most visibly on a
  terminal whose first prompt is still short enough to fit. The follow target comes from buffer rows,
  which run ahead of the height the box has laid out, so a follow scroll issued by the write that grew
  the output is clamped short — and the follow-break guard, which compares the view against where the
  code last put it, was comparing against the position it had *asked* for. The unreachable request read
  as a scroll nobody made, so the guard parked the terminal at the top and the output ran on below it.
  The guard now records where the container actually landed, a clamped follow scroll re-applies over
  the next few frames, and a view resting on the container's own maximum counts as following.

- Clicking a desktop notification lands on the tab showing the terminal deck and selects that
  session there, instead of whichever tab happened to post the banner — which with two tabs open
  could drop you into a file view. Only one tab posts, and the session you are actually looking at
  stays silent — a session finishing anywhere else still notifies, including from a tab you are not
  looking at.

- Coming back to a terminal after a restart no longer opens it part-way up the conversation. An attach
  is several paints, not one — the recording replays, then the agent redraws its own screen over the
  tail of it — and a redraw that walks the cursor high reads either as a fold or as "somebody moved
  this view", both of which park the tab mid-history and stay there once that redraw was the last
  write. A tab that was following now keeps re-asserting the composer for a few seconds after
  attaching, until the paints go quiet. Scrolling, dragging, PageUp or jumping to a find match inside
  that window ends it on the spot: it only ever corrects positions nobody asked for.

- The recovery screen no longer crashes on startup. The state files it exists to repair are exactly the
  ones that leave the session manager unbuilt, and one of its collaborators was being wired up without
  checking for that.

- Reattaching to a Claude terminal that has compacted now scrolls back to some of the conversation
  from before the compaction. Compacting makes the CLI redraw everything it has rendered, which it
  does by jumping the cursor far up and erasing line by line on the way down — and because the
  recording kept that erase, replaying it destroyed the same conversation a second time. The
  recording now scrolls the screen into scrollback ahead of such a redraw, out of reach of the erase.
  Partial by nature: which redraw is a compaction is inferred from the size of the cursor jump, so
  the top of the conversation can still be lost and some blank rows are added. Recording only: a
  live client still receives exactly the bytes it always did.

- A terminal no longer opens blank when its recording ended on a screen clear. A TUI erases and
  redraws in two writes, and a server restart landing between them left the erase as the last thing
  recorded — every later attach replayed it, showing the conversation cut mid tool-call with no
  composer, and no repaint could recover it because an idle agent sends nothing.

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

[Unreleased]: https://github.com/danialfarid/termdeck/compare/v0.8.1...HEAD
[0.8.1]: https://github.com/danialfarid/termdeck/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/danialfarid/termdeck/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/danialfarid/termdeck/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/danialfarid/termdeck/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/danialfarid/termdeck/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/danialfarid/termdeck/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/danialfarid/termdeck/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/danialfarid/termdeck/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/danialfarid/termdeck/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/danialfarid/termdeck/releases/tag/v0.1.0
