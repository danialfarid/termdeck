# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- One call for what an agent answered: `GET /api/sessions/{session_id}/last-turns`, with `limit`
  counting answers rather than transcript entries (default 1, capped at 50) and `final=true` keeping
  only the answers a turn ended with. Neither of the calls it replaces could say "the last five things
  this agent said": a page of transcript is mostly thinking, commands and their output, so ten entries
  can hold one answer. `/task-result`, the second name for the same single turn, is gone; `/last_turn`
  still answers in its old shape for scripts already written against it, and is no longer documented.
  The whole transcript is still `/history-page`, whose `limit` counts entries.
  See [docs/api.md](docs/api.md#start-one-terminal-task-create--run-in-one-call).

## [0.23.0] — 2026-09-22

Reload any deck already open in a browser after upgrading: a page loaded from the previous version
writes its project state the old way, and those writes are refused until it is reloaded. Nothing
stored is lost either way.

### Added

- The open files are shared: `POST /api/open-files` opens one and `DELETE /api/open-files` closes
  one. Each window wrote the whole list back, so two decks open on the same project talked over each
  other — a file opened in one was closed again by the next save in the other, and a reload came back
  missing it. A window now writes what it opened and what it closed, and says nothing about files it
  never had open. See [docs/api.md](docs/api.md#open-files).
- The copied-text list has calls of its own: `GET /api/notebook/copies` reads it and
  `POST /api/notebook/copies` records one copy. It rode on the terminal layout before, which meant a
  deck that had been open for a while sent its whole list back and copies made in another window were
  lost. The layout call refuses that field now, as it already refuses the notes. See
  [docs/api.md](docs/api.md#copied-text).

### Changed

- Every part of the project state is written by a call of its own. Clearing the pins, or opening the
  notebook on another note, wrote the whole state — from the copy the window making the change
  happened to be holding — so a window open for a while put its own stale notes, layout and copied
  text back over what had been saved since it loaded. `PATCH /api/terminal-layout` is gone; that call
  reads, and `PUT /api/project-state/<field>` writes one field. See
  [docs/api.md](docs/api.md#project-state).
- A copy says how old it is in one unit — `2m`, `4h`, `1d` — and resting on it gives the date and time
  it was made. Both in the notebook's copied text and in the ⌘⇧V picker.
- In the paste picker, the time a copy was made moved to the end of its row. In front of the text it
  pushed the first words of every copy out of line, and the first words are how anyone finds the copy
  they are looking for.

### Fixed

- A notebook save that did not reach the server is written again by the next save. Counted as written
  the moment it went out, a save that failed looked like one that had, and the field — which note is
  open, for one — was never written again.
- A fork keeps the terminal its source was filed under. It inherited the group but not the parent, so
  forking a child produced a copy at the end of the list, in the group and outside the stack at once.
- Resting on a name too wide for the sidebar — a terminal's or a group's — shows the whole of it. They
  are cut off at an ellipsis, and two terminals whose names differ only past the cut could not be told
  apart without opening one. Notebook tabs do the same.

## [0.22.0] — 2026-09-22

### Changed

- A write to a note must say which version it was made from. A caller that says nothing cannot be told
  it is behind, and taking such a write is how a stale window overwrote newer text; it is refused now
  unless the note has no version yet. `PUT /api/project-state/notebook_notes` no longer writes the
  whole note list either — one call, one note. See [docs/api.md](docs/api.md#notebook-notes).
- The versions button moved out of the notebook's row of buttons to just under them, with Restore
  under it while a version is being read. It belongs to a note, so it comes and goes with one, and
  from inside the row that shifted every other button sideways each time. It is a push button: it
  opens the versions and puts the note back, so that panel has no × of its own. It is not offered on
  the copied-text view, which is not a note and has no versions.
- The description button stays lit while the drawer it opened is open, the way the deck's other push
  buttons do. Nothing in the bar said whether the drawer below it was open.

### Fixed

- Text typed in the moment before a save could be overwritten by state arriving from the server. The
  note was claimed only when the save went out, a fraction of a second later, and anything arriving in
  that gap was taken as newer. Typing claims the note from the keystroke.
- A page closed, reloaded or sent to the background writes the note it was in the middle of, and sends
  it itself rather than queueing it behind whatever else is waiting. Settings, files and search history
  were all written on the way out; the notebook was not, so the last thing typed went with the page.
- Restoring an earlier version can no longer take unsaved text with it. The save queued for the text
  being replaced carries that text rather than whatever the note has become by the time it goes out,
  waiting on a flush waits for the write to land, and the history keeps the version a restore
  replaces: versions fold together only while the text grows, which is someone typing on.
- A save refused while the deck is not connected keeps what was typed: it goes into a note of its own
  rather than living in a browser that is one reload away from losing it.
- A delete that never reached the server stops hiding the note; it was filtered out of everything
  arriving afterwards until the page was reloaded.
- Importing a project brings its notes with it. The merge kept whichever list was not empty, so every
  imported note was dropped the moment the destination had one of its own.

## [0.21.0] — 2026-09-21

### Added

- A note's earlier versions open in the notebook itself, from a button in its head: the versions down
  the left by when they were written, the one being looked at on the right, and a button to put it
  back. Fifty versions are kept per note.
- A note changed somewhere else changes here as it arrives, in the open editor, rather than the next
  time someone opens it. A note being typed into is left alone: what is being typed is what the server
  is about to judge.

### Changed

- A save the server refuses no longer asks anything. While the deck is connected the newer text is on
  its way here anyway, so the note takes it and the notebook says, in red, that the save did not land.
  With no connection there is nothing to catch up from, so the note is held and says the server
  rejected the edit.
- Copied text says when it was copied under the button beside it rather than in front of the text, and
  the Insert button is gone: copying is what that list is for.

## [0.20.1] — 2026-09-21

### Fixed

- Reopening a closed terminal puts it back in the group it was closed from. The assignment was dropped
  when the terminal closed — they accumulate otherwise — and nothing remembered it, so the terminal
  came back at the end of the list with no sign of where it used to live. The group now travels with
  the closed record, and reopening restores it unless that group is gone.

## [0.20.0] — 2026-09-21

### Added

- Every version of every note that was ever saved is kept, the way a file's versions are, and a note's
  tab menu opens them: pick one by when it was written and it opens as a note of its own, beside the
  current one rather than over it.
- Copied text says when it was copied, and a copy made in one window no longer disappears from another.
  The list was written back whole by whichever window saved last, so an older window could put its list
  back over a newer one -- recent copies gone, week-old ones at the top.

### Fixed

- A window can no longer overwrite a note it has not caught up with. Each window keeps its own copy and
  writes the whole text back, so a window left open while the note was edited somewhere else wrote its
  stale copy over the newer one, and the newer text existed nowhere afterwards. A write now says which
  version it was made from; a write from an older version is refused, the note is locked in that window
  with a dialog offering to refresh, and anything typed on the stale copy is kept as a separate note
  rather than dropped.

## [0.19.7] — 2026-09-21

### Changed

- The open notebook carries its own Notes button, in its head, in line with the head's other buttons
  and in the same place whichever mode the deck is in. The button outside stands down while the
  notebook is open: it sits in a different place in each mode — a few pixels below the head's buttons
  in terminal mode, behind the panel in transcript mode — which is what made it look misaligned in one
  and swallowed in the other. In terminal mode the button now sits exactly where the panel's own
  button appears, so pressing Notes never moves it.

## [0.19.6] — 2026-09-21

### Changed

- The notebook has no × of its own any more, on any screen. The Notes button is a push button: it
  opens the notebook beside itself and closes it again, keeping its place, with the head's own buttons
  to its left. The panel used to cover the button, which is the only reason a second way out existed.

### Fixed

- Switching notes no longer flashes the previous note's tab on the way. Which note a window is looking
  at is that window's business, and taking whatever arrived meant two open windows each pulled the
  tabs to their own note: one tap read as two highlights.

## [0.19.5] — 2026-09-21

### Fixed

- Deleting a note removes it there and then. Its tab stayed until something else happened to redraw
  the strip — switching notes, usually — because the state that arrived next had been written before
  the delete landed and still carried the note, and nothing asked the notebook to catch up when notes
  changed under it. Both are fixed, so a note added or deleted in another window now shows up here
  without being asked, and a note made here still survives the broadcast that overtakes its write.

## [0.19.4] — 2026-09-20

### Added

- A shut block of output says what came back, not only that something did: "Result · The file
  …/termdeck/transcript_turns.py has been updated successfully". Long paths keep the end that tells
  two of them apart, so the lid is not spent on the part every line shares. Code edits keep their own
  summary, which already says which files changed and by how much.

## [0.19.3] — 2026-09-20

### Fixed

- Pressing the Notes button on a phone closes the notebook. A press outside the notebook closes it, and
  the check for "outside" knew two of the four buttons that open it — so the press closed the notebook
  and the button's own handler opened it again, and it could not be closed at all.
- A folded block of operations reads "12 Thinking · Bash Run the tests". "Operations" was a long word
  to spend a wrapped line on, and on a phone that is what it cost.

## [0.19.2] — 2026-09-20

### Added

- A folded run of operations says what the agent is doing, not only how much of it: "Thinking · 12
  operations · Bash Run the tests". An agent that writes a line before it starts work says it itself;
  one that goes straight to work said nothing, and a column of folded blocks read as a row of lids.

### Fixed

- The notebook's tab row can be scrolled on a phone. A finger landing on a tab opened that note there
  and then, so every reach for a tab further along opened two or three notes on the way. A tap opens a
  note, a swipe scrolls past it, and a hold still offers the Trash.

## [0.19.1] — 2026-09-20

### Fixed

- On a phone the Notes button sat on top of the notebook's own buttons. It moves to the corner the
  notebook's × used to hold, and the head stops short of it, so new note and find sit alongside it.
- A note's tab is no longer held wider than its name: six characters of the title is the floor, rather
  than a fixed width that made short names take a third of the row.

## [0.19.0] — 2026-09-20

### Added

- The model shown beside the composer is a control. Click it and pick a model, then the reasoning level
  that model offers; a model no list has heard of can be typed instead. Which of the two it takes comes
  from the agent: codex is told by position, so a model outside its catalog restarts the terminal on it
  (resuming the session, not starting a new one), while an agent with a command of its own — claude's
  `/model`, then `/effort` for the level — is simply told, whatever the name. For an agent whose model
  TermDeck cannot change it stays the readout it was.
- Claude is asked which models it takes, rather than offered the ones this deck happens to have started
  it on: its help names the aliases and the levels it accepts, and its settings carry the full ids this
  install has used. Every agent is asked the same way, through its adapter; one with nothing to say
  leaves the field the free-text box it was.
- Code edits in a transcript are folded by default, and the one line a folded edit gets says which files
  changed and by how much. Paths are shortened against the terminal's own directory. The filter that
  collapsed them now expands them, since folded is what they are unless asked otherwise.
- The notebook has a plain API of its own: list the notes of a project, create one, read or write the
  text of one, delete one. Create mints the id when the caller has none, and creating an id that is
  already there changes nothing, so a retry cannot undo what was typed in between. See
  [docs/api.md](docs/api.md#notebook-notes).

- Holding a finger on a message in the transcript selects that message whole and opens the menu the
  right-click opens on a desktop — Copy, New note, Search in files, Ask an agent — at the finger.
  Selecting an answer to copy used to mean dragging two handles through text that scrolls away under
  them. A hold that turns into a scroll is still a scroll.

- Holding a note's tab opens a menu with New note and Move to Trash, which is how a note is thrown
  away on a phone now that the × is not on the tab.

### Fixed

- A message sent while an agent was working now appears in the transcript. Claude Code does not record
  one as a user turn — it hands the text to the turn already running and writes an attachment line
  instead — so the transcript showed the agent answering a question nobody could see it being asked,
  the phone left the message marked as not delivered, and the submit path kept pressing Enter at a
  prompt the agent had already taken. (In one long session, 11 messages were missing this way.)
- The notebook's tabs no longer pile up on a phone. They kept shrinking until six notes fitted in the
  width of one and the titles ran together; each tab now keeps a width it can be read and hit at, and
  the row scrolls sideways. The × that moves a note to the Trash is off the tab there — it sat a
  mis-tap from the tab's own target — and "Copied" shows its icon and count without the word. The
  notebook's own × in the corner is gone too on a phone: the Notes button that opened it closes it.
- A prompt waiting to be confirmed is now looked for every few seconds, instead of only when the
  transcript happens to say something. An agent that takes a prompt and then works quietly says
  nothing for minutes, which left the message reading as one that was never sent.
- A note made in one window stopped disappearing. Project state arrives whole — from a refetch, or from
  the broadcast every save anywhere in the deck produces — and the copy on the server is only as new as
  the last write to land, so a broadcast could overtake a new note and take it back out of the list.
  The editor then moved to another note and everything typed after that went there instead, which is
  what "the note was not saved" looked like. Arriving state can no longer drop a note this page holds;
  only deleting one removes it. Each note is also named by a UUID now, so two notes made in the same
  moment on two machines cannot land on the same id.

## [0.18.0] — 2026-09-20

### Added

- Both start dialogs ask for a model and a reasoning level, not just a name typed from memory. The
  models codex publishes are offered as suggestions behind a field that stays typable, so a model the
  catalog has not heard of can still be started on, and the level beside it belongs to whichever model
  is in the field. "Restart with…" gained the same pair, blank meaning the model the command already
  names, so a restart can change what a terminal runs on and not only what it may do.
- Both start dialogs can turn an agent's own visual effects off — `tui.whimsy` for codex, whose
  composer twinkles and redraws while it works. The flag belongs to the agent, so a CLI that gains such
  a switch is one method away from being offered it, and the choice is remembered like the model and
  the permission.
- The terminal cursor's blink can be turned off, in settings. An agent that redraws its composer walks
  the cursor across the line and back on every redraw, and a blinking cursor on top of that is what
  reads as flickering. A TUI asking for a blinking cursor of its own is refused while the switch is off,
  keeping the shape it asked for and dropping only the blink.
- A terminal can be filed under another by holding a drag over the middle of its row — where the gesture
  for "these two belong together" already lived. The first hold still offers the group; holding on past
  it offers to file instead, and the label says which is on the table. Filing under itself, where it
  already is, or under one of its own children is refused.

### Changed

- The + at the top of the terminal list makes a terminal of its own. The dialog opened from there is not
  told where to put it, and fell back to whatever was selected — landing it in that terminal's group, or
  inside its stack. A group's own + and a row's "New terminal after this" still say where.
- A terminal asked for from a spawned agent opens under that agent, rather than a level out beside the
  agent that spawned it.
- The transcript's folded blocks stay folded when the browser's find-in-page runs. Chrome searches
  inside a closed block and forces it open on a match, so a search sprang open folded code edits,
  thinking blocks and folded repetitions — including the ones the transcript's own filters had just
  folded away.
- The session description is set as prose rather than code — reading font, a reading measure, and
  spellchecking — and its panel closes on a click anywhere else, saving what is in it.

### Fixed

- Pairing a computer for remote access again puts the connector on the new token. Pairing saved the
  token and asked for a connector, but the one already running was left alone with the token the relay
  had just replaced: the relay accepted the computer while the deck went on being refused, and a phone
  waited for a computer that was right there.
- A prompt sent through the API to a busy agent that has no prompt queue is sent rather than queued.
  Queueing is Tab, which queues only for an agent whose composer does that, so for the others the prompt
  was pasted and left sitting there — the draft cleared, the confirmation that watches a prompt into the
  transcript skipped, and the caller told it had been queued.
- A codex terminal binds to its session from the moment it starts, through the writer lock a running
  codex holds for the thread it is writing, rather than only once the session has a transcript file. A
  terminal that had not yet taken a turn had nothing to bind to, so its identity never resolved and it
  could not be restarted at all.
- Restarting looks for the session once more before refusing over an unresolved identity, which was
  otherwise permanent for a terminal that was never typed into.
- A terminal whose agent refuses to resume the session it is pointed at starts a new one rather than
  staying dead. The saved command is kept rewritten as a resume, so every restart ran the same refused
  resume and died the same way.
- Restarting names the command it runs, under the "restarted" line: a restart is exactly when that
  command becomes something else.
- A `-c key=value` start parameter is identified by its key, so adding one no longer strips every other
  one already on the command — codex's reasoning effort survives anything else set that way. Codex's
  reasoning levels now include `max` and `ultra`.
- A terminal renamed from inside Claude takes the new name, and stops spinning. Claude may have moved
  the conversation to a new transcript by then, leaving the deck bound to one that carries the old name
  and an unfinished last turn, which is a spinner with nothing left to stop it. An unfinished turn in a
  transcript nothing has written to for half an hour now reads as stopped.
- Undo in the deck's own text fields is left to the field. Meta+Z is bound to the terminal composer's
  undo, and the dispatcher claimed it before looking at what had focus, so undo did nothing where it was
  pressed and something invisible somewhere else.
- Next and previous terminal step through the sidebar in the order it is drawn in, so an open stack is
  walked in place and a collapsed one is stepped over rather than selecting a terminal nobody can see.
- Revealing a terminal opens the stacks above it. A terminal filed under another has no row while that
  stack is shut, so opening one by its link switched the deck to it and left the sidebar showing no sign
  of it.
- An unread badge that lands on the terminal being looked at clears. Unread is project state, so it
  arrives from another window or a phone as well, and selecting a terminal is what clears a badge — but
  it was already selected, so clicking its row did nothing.
- The line marking a stack reaches the title of a row carrying a band of activity dots, rather than
  starting below it.

## [0.17.0] — 2026-09-19

### Fixed

- Transcript-index cleanup reclaims all available free pages on Python 3.11 as well as newer Python versions.

- Terminal find closes when you switch terminals, and its box is emptied. It stayed open on the next
  terminal, so Cmd+F there started searching the previous terminal's query against a buffer it was
  never typed for. Escape still closes it on the terminal being searched without losing what was typed.
- A prompt sent through the API is checked for having arrived, and Enter pressed again for up to 15
  seconds if it has not. The Enter that submits a pasted prompt only lands once the agent's TUI has
  taken the paste, and the wait for that was a flat 80ms — fine for an idle terminal, not for one
  streaming tens of thousands of tokens, where the Enter was absorbed and the prompt sat in the
  composer looking sent. TermDeck now waits for the terminal's own output to go quiet before pressing
  Enter, and treats the prompt as delivered only once it appears as a user turn in the agent's
  transcript.
- A codex terminal stops showing progress once its turn has plainly stopped. A turn ends with
  `task_complete` or `turn_aborted`, but a codex killed mid-turn — a restart, a crash — writes neither,
  so the last thing in its transcript stayed `task_started` and the terminal spun for good, its dtach
  session alive so nothing else cleared it. An unfinished turn whose transcript has not been written to
  for five minutes now reads as stopped.
- Terminal layout changes made in one browser or mobile device now arrive in other connected TermDeck views without requiring a refresh.
- Resuming a terminal the deck already has sends the agent's session id rather than TermDeck's own, which
  meant nothing to the agent: the command came out as `--resume <deck id>` and the resume picker answered
  "No sessions match". A name that belongs to a terminal whose agent has never started a session now says
  there is nothing to resume, instead of quietly opening another terminal under the same name.
- The terminal dialog resumes an agent session by the name it shows, not only by terminals TermDeck
  already has. A session started in a plain terminal has no row here to match, so its name was read as a
  name for a NEW session and an empty one opened under it. Claude's named sessions for the chosen
  directory are now offered in the field's suggestions and resolved when typed, and an agent session id
  pasted in is accepted as well.
- Opening the keyboard on a phone keeps the end of the transcript in view above the composer. The pane
  shrank to the space the keyboard left but held its scroll position, so the newest lines — the ones
  being replied to — slid behind the keyboard. Someone who had scrolled up to read something is left
  where they were.
- A dialog on a phone stays inside the part of the screen the keyboard has left, and scrolls, so the field
  being typed into cannot end up underneath the keyboard. A dialog is positioned against the whole screen,
  which the keyboard does not shrink.
- The terminal dialog's name field accepts an agent's own session id, so a session TermDeck has never owned
  can be resumed by pasting its id. Anything it could not match was read as a name, which opened a new empty
  session under that name instead.
- Retry and dismiss on an unconfirmed prompt are the same size, and the "Not confirmed" label no longer
  collapses to nothing beside them.
- The unconfirmed-prompt row in the transcript keeps to one line on a phone, and carries an × on the
  right that takes the prompt off the transcript for good. Its label could break across two lines in a
  narrow column, and there was no way to dismiss an entry the agent had plainly received.
- A prompt whose send could not be confirmed no longer stays in the composer as well as the transcript.
  Holding both copies is what turned one prompt into two: the next thing typed landed on the end of the
  old text and went out as a single message, leaving the original behind as a second pending entry.
- A prompt is called unconfirmed after 25 seconds rather than 60.
- Terminal recordings whose session is gone are collected every 15 minutes. Recordings were only ever
  deleted for Claude, so every Codex, Opencode and plain shell session left one behind: 1,143 of 1,227
  files in one deck's scrollback directory belonged to no session. Cleanup now reconciles the whole
  directory against the sessions the deck still has, so it does not depend on having witnessed the
  close, and it costs the startup path nothing.
- Terminal recordings are stored as `<session>.replay.bin`. The old `.claude-replay.bin` name described
  only the first agent to use them and made a Claude-only cleanup look correct; recordings already
  written under it are still read and appended to, so upgrading keeps every open terminal's scrollback.
- The transcript search index no longer grows without limit. It indexes every agent transcript on the
  machine, a corpus that only grows and that TermDeck does not own, and it had no ceiling of any kind:
  on one deck it reached 3.5GB, filled the disk and wedged the server. It now keeps to roughly 3GB by default,
  evicting the oldest transcripts when it passes that, and drops transcripts that have been deleted
  from disk instead of keeping their search hits forever. Evicted transcripts stay evicted rather than
  being indexed straight back in by the next startup scan, and come back if something appends to them
  or the index is rebuilt.
- Transcript changes are indexed in batches of a few seconds rather than one at a time, so a streaming
  agent no longer has the indexer re-reading its transcript on every append.
- The indexer survives a full or failing disk instead of stopping for the life of the server. It reports
  itself degraded, keeps retrying every few minutes without waiting for another transcript to change,
  and resumes on its own once storage recovers — which matters most because the size cleanup that would
  relieve the disk pressure is part of what used to be lost.

### Added

- The terminal context menu's "Restart with permission" submenu is now "Restart with…", a dialog that
  takes a permission and additional start parameters together and shows the command it is about to run.
  A parameter typed here replaces the matching option already on that command rather than being added
  beside it, and unparseable parameters are refused while the terminal is still running.
- Agents an agent spawns are grouped under it in the sidebar, rather than scattered through the list as
  unrelated terminals. Collapsed they are one line: a dot carrying their combined state — throbbing
  while any is working, lit when one has finished unread, ringed when one is waiting on an answer —
  then how many there are and the first couple by name. Clicking the line opens them at full size,
  marked as the parent's by a rule down the left rather than by an indent, and clicking that rule folds
  them away again. The parent's own row carries a chevron for the same thing, shown on hover beside its
  close button and kept visible while the group is open.
- A terminal can be dragged onto another's spawned agents — the summary line or any of the agents
  themselves — to be filed under that same parent, and dragged back into the list to be un-filed. A drop
  that would close a loop is refused and says so.
- A terminal can be filed under another by hand, through
  `POST /api/sessions/{session_id}/spawned-by`, so a deck whose agents were spawned before TermDeck
  recorded that link can still be grouped. An empty parent clears it, and a parent that would close a
  loop is refused.
- A freeze watchdog is installed and scheduled alongside the service, so a deck that stops answering
  while still running is restarted on its own instead of waiting to be noticed. A wedged server keeps
  its port open and its process alive, so launchd KeepAlive and systemd Restart=always consider it
  healthy; the watchdog asks it a question over HTTP every couple of minutes and restarts it after
  three unanswered asks in a row. Restarts that do not produce a healthy deck back off — 5, 10, 20, 40
  minutes, up to an hour — so an install that cannot start is not held in a crash loop. A deck stopped
  with `termdeck service stop` is left stopped.
- `termdeck service watchdog` reports whether the watchdog is scheduled, when it last probed, and
  whether it has had to restart anything.
- `GET /api/health` reports that the server is alive.
- A `history_index_max_mb` setting caps the transcript search index. Unset or 0 uses the 3GB default;
  a negative value turns the ceiling off.

## [0.16.2] — 2026-09-17

### Changed
- Terminal rows no longer show session details in a hover tooltip; use the terminal context menu's Info action to open those details in a modal.
- The active terminal Info action is available from the context menu and its keyboard shortcut.
- Native Cmd+C copying is no longer intercepted by the generic app shortcut dispatcher, preserving reliable selection copying.
- Pending transcript prompts marked Not confirmed have one compact retry action beside the status; it restores the prompt in the terminal and sends Enter again.
- Mobile connections receive a lightweight keepalive, avoiding idle relay timeouts that unnecessarily show Reconnecting.
- Installed TermDeck opens the last project, worktree, and terminal route instead of always starting at the all-projects screen.

### Fixed

- Clipboard-history persistence failures no longer replace the status bar with a raw `Failed to fetch` message; copying remains local and immediate.

## [0.16.1] — 2026-09-15

### Fixed

- Terminal history search no longer returns an internal server error for underscore-containing queries such as `task_runs_store.py`.

## [0.16.0] — 2026-09-15

### Changed

- The built-in delegation instructions focus on starting, monitoring, and following up with an agent; creation APIs accept a short description alongside the session name and prompt.

### Fixed

- Codex submitted-input activity expires when no new task appears in its transcript, preventing a completed session from remaining marked as processing indefinitely.

### Added

- Agent terminals expose their session id, name, and direct URL to child processes, and user-visible session descriptions can be stored through the API for workspace organization.
- The README documents cross-agent communication through the TermDeck API and automatic guidance for spawned agents.
- New agent sessions can receive the TermDeck API guidance automatically, with a setting to disable it.
- Agent spawning accepts optional additional launch parameters, appended after generated parameters for overrides, in the UI and automation APIs.

## [0.15.1] — 2026-09-14

### Fixed

- Changing conversation filters preserves the visible prompt and its position in both the outline and transcript, rather than jumping when hidden responses reappear.

## [0.15.0] — 2026-09-14

### Fixed

- Agent and other context submenus expand upward near the bottom edge instead of clipping the available list.

- “Ask an agent” pastes into the receiving tab's current composer or terminal, including running agents that are still producing output.

- Automatic PyPI publication uses the registered publishing workflow directly, avoiding the signing-identity mismatch that required a manual retry.

## [0.14.0] — 2026-09-12

### Added

- The loading recovery action force-restarts the TermDeck server when it is stuck, allowing the service manager
  to relaunch it without stopping detached agent terminals.
- Loading recovery detects service ownership before restarting; a confirmed manually launched server is relaunched
  with its current command, while unknown ownership safely follows the service-managed path.
- The update panel explains that running agents stay alive while the TermDeck server briefly restarts.
- The transcript shows what changed in the working tree while a Bash command ran, as a collapsed
  "Changed on disk" entry with the diff. The agent CLI reports these and draws them in its terminal, so
  the transcript and the terminal used to tell different stories about the same session. The entry does
  not say the agent made the change: another agent working in the same checkout at that moment is
  reported here too.

### Changed

- A pending prompt's status reads "Pending", "Sending" or "Not confirmed" rather than a sentence, which
  wrapped to five lines in a phone's column above the prompt it belonged to. The sentence moved to the
  tooltip.

### Fixed

- Selecting a prompt on a phone no longer takes the delivery status line with it. Pasting that back sent
  the deck's own wording to the agent as though it had been typed.
- TermDeck Remote reconnects by itself instead of parking on a page with a Reconnect button. The deck now
  releases the remote connection only while its page is hidden, so reading a transcript without touching
  the screen no longer replaces it with "Remote connection paused", and the page it parks on reconnects as
  soon as it is on screen again, including when a phone restores it from the back/forward cache.
- The + on a terminal group's header lines up with the group name and the search glass beside it. It sat
  three pixels high: the button centres its contents with a grid, and an invisible "+" text node counted
  as a second grid item, so the drawn cross was centred in the first of two rows rather than the button.
- TermDeck installed as an app on a phone reopens where you left it. A launch always went to the
  all-projects page, because that is the address an installed app starts from; the deck now records its
  own address and a cold launch returns to it. Reloading, or walking to all-projects inside the app,
  stays where you put it.
- Opening the sidebar on a phone pushes the transcript aside instead of squeezing it, so closing the
  sidebar comes back to the line you were reading. The sidebar used to take its width out of the panel,
  which rewrapped every line and threw the scroll position away.
- Tapping anything inside the transcript on a phone keeps the keyboard open. Opening a thinking block or
  expanding one of its operations took focus off the composer and shut the keyboard mid-prompt; the
  transcript's own controls now decline focus the way the toolbar buttons always have. Nothing reopens the
  keyboard on its own either: the composer is no longer focused programmatically on a phone.
- The reconnecting notice no longer says your transcript is saved on this device. It only ever meant the
  prompt you had half typed, which is still there when the deck comes back.

## [0.13.0] — 2026-09-10

### Fixed

- Claude transcript `/model` accepts Claude aliases or model IDs instead of opening the Codex picker, and the composer shows Claude's reported model rather than GPT names mentioned in conversation text.

### Added

- Prompt-only, response-only, and code-only filters shared between the transcript and conversation outline;
  code filtering includes edits and messages with fenced code blocks. Filter selections last only in the
  current browser tab and reset on refresh.

### Changed

- Install published releases from PyPI with `uv tool install termdeck-agents`; Homebrew installation stays unchanged.

## [0.12.3] — 2026-09-09

### Fixed

- Homebrew-installed background services use the stable executable path so upgrades do not leave the service pointing at a removed version.

## [0.12.2] — 2026-09-09

### Changed

- Python distribution is named `termdeck-agents`; the `termdeck` command, Homebrew formula, and saved data paths stay unchanged.
- Release packaging supports PyPI trusted publishing and verifies uninstall/reinstall with a real shell on Linux.
- Homebrew downloads the published release source asset, allowing aggregate GitHub download counts without
  changing install commands or adding application telemetry.

## [0.12.1] — 2026-09-09

### Changed

- Remove the project-title hover underline; the dropdown arrow indicates the project selector.
- Give the project and group-header Search and + buttons roomier hover highlights.
- Alternate the current terminal's browser-tab attention dot between top and bottom every two seconds.
- Check for updates hourly while TermDeck is open, with a one-hour shared server cache and a manual
  compact Check for updates icon button beside the version in Settings.

## [0.12.0] — 2026-09-08

### Fixed

- Closing an unavailable or unsupported file clears its error panel through the shared tab-close path,
  including the tab ×, context menu, and keyboard shortcut.

- Terminal search preserves hyphenated identifiers and only highlights sessions with matching conversation text,
  instead of treating separate words scattered through a history chunk as a match.
- Update progress recognizes a restarted release even when that release lacks the new progress endpoint,
  instead of remaining on “Waiting for server to reconnect”.

### Added

- A small version readout at the bottom of Settings shows the running TermDeck version.

- Show a visible progress spinner beside terminal and file-content search messages while results are loading.
- A separate Homebrew core source-build candidate, source-archive checksum generator, and manually triggered
  macOS/Linux packaging validation workflow prepare official packaging without changing the existing tap.
  Installed-package smoke checks exercise isolated server startup and real shell input/output through dtach.

- Expand the update notification to preview the detected Homebrew, uv, pipx, pip, or Git command. Run it explicitly
  and follow progress, output, and errors in place. Successful updates automatically restart an installed
  TermDeck service; the panel reconnects and offers to reload the updated UI.

### Changed

- Closing Claude sessions deletes their raw replay files; startup also removes replay files for already-closed
  Claude sessions. Recently closed entries and agent transcripts are retained.
- Increase the shared terminal replay budget from 100 MB to 5 GB while retaining the 24 MB per-terminal limit.
- The README now leads with parallel coding-agent management and Transcript mode, with worktrees matched to the
  terminal workflow demo and the main benefits ordered around the agent workflow.
- The README now distinguishes TermDeck's independent persistent agent processes from editor-owned terminal panels,
  and the repository social preview presents the same local-first multi-agent positioning.

## [0.11.1] — 2026-09-08

### Fixed

- Opening or dismissing an external-link confirmation no longer moves a scrolled terminal to the bottom when
  focus returns to its prompt.

## [0.11.0] — 2026-09-08

### Added

- Single-terminal and full-project exports now share one session-collection archive format. Import sessions accepts
  that format and legacy single-session archives; multi-session imports can merge into the current project or create
  a separate linked project.
- Terminal context menus can move selected terminals to a freshly named group, and desktop drag-and-drop now
  accepts an insertion lane between top-level groups without making the terminal a member of either group.
- Declarative agent profiles in the data directory can add a CLI's launch/model arguments, permissions,
  resume, fork, rename, JSONL transcript mapping, activity detector, attention markers, and brand icon without
  changing TermDeck; complex integrations continue to use Python adapters.
- A dismissible update notice backed by an on-demand GitHub release check cached for 24 hours; it never installs
  or restarts anything automatically.
- Optional bearer-token authentication for direct HTTP/WebSocket access and a server-wide read-only monitoring
  mode; the hosted relay authenticates locally without disclosing the direct-access token to its browser.
- Portable session export/import archives preserve the resume profile, draft, normalized transcript, and
  available terminal replay, and restore as dormant tabs without executing on import.
- An agent-readable `/llms.txt` capability and API index, plus a one-click diagnostics bundle containing
  sanitized dependency, session-state, process, language-server, remote-access, and bounded log information.
- A richer adapter surface for Aider, AGY, and OpenCode: model IDs and provider routes can be chosen when a
  terminal is opened, AGY exposes its resume, effort, and permission modes, OpenCode restores working state
  from its session database, and output-driven agents report work immediately when a prompt is submitted.
- A colour for each project and worktree, chosen from the row of swatches at the bottom of its picker. A worktree
  color takes priority; otherwise its project color marks the worktree label and browser-tab favicon.
- Full-project exports migrate all dormant session archives and the saved deck layout, notes, and project/worktree
  colors without source files.
- Transcript slash commands now run according to their actual behavior: `/status` renders model, reasoning, fast-mode,
  and token usage, `/ps` renders the terminal process tree, and `/model` uses Codex's live model picker without
  restarting the session. Command results remain visible in the current browser tab while the transcript updates.
- A prompt whose submission could not be confirmed offers Retry and Discard right under it in the transcript.
  Retry sends the same text again; Discard forgets it. It used to sit there for ten minutes with no way
  forward but retyping.
- On a phone, tapping the transcript or terminal while the sidebar is open folds the sidebar away. A pinned
  sidebar stays.

### Changed

- The README header again shows the current release, supported Python version, license, and CI status.
- The README security overview now names the default local and Wi-Fi ports, explains the hosted relay's encrypted
  Google-authenticated path, and links to the detailed remote-access and security guides.
- The project header now owns terminal search, and its + menu includes terminal groups. The TERMINALS row keeps only
  the active filter and new-terminal control, while terminal URL confirmations use TermDeck's modal instead of the
  browser's native prompt.
- Inside an expanded thinking block, each operation shows its first four lines with a "N more lines" control
  under it; opening one keeps it open through re-renders while the agent is still streaming. A block of
  twenty tool calls used to be twenty full outputs end to end.
- The chevron beside the project and worktree names sits right after the name rather than at the far end of
  the row, where a short name left a panel-wide gap.
- The − button on a phone goes further: mobile text scales down to 50% instead of stopping at 80%.
- Changing the zoom on a phone keeps your place: the transcript stays on the turn you were reading.

### Fixed

- Opening a terminal now puts its dialog into a visible progress state until creation finishes instead of leaving
  an apparently stuck popup during slower agent startup.
- Conversation outlines distinguish agent responses from code edits with two shades of the same color, and switching
  terminals opens the new terminal's outline at its latest prompt instead of inheriting another outline's scroll position.
- The main checkout can have its own worktree color independently of the project color; both header rows show
  their assigned colors, while the worktree color takes precedence for the active deck color.
- Remote access no longer stops quietly. An unexpected error inside the relay connector used to end its loop
  while the deck kept reporting "ready", so a phone sat on "Connecting to TermDeck" until the server was
  restarted; the loop now survives any single failure, and the status endpoint restarts a connector whose task
  has ended, saying why. The relay's reason for letting this computer go — another computer on the same
  Google account took the one connector slot, or access was revoked — stays visible beside "ready" in Remote
  access until the relay accepts this computer again, and a rejected token says to pair again instead of a
  bare 401. The relay handshake also has a timeout.
- TermDeck Remote's "Connecting to TermDeck" page says after thirty seconds that the computer may be asleep,
  offline, or not running TermDeck, and shows how long it has been waiting, instead of spinning silently.
- A Codex turn that fails now says so in the transcript. Codex records a failed turn as a completion with
  an error and no reply, which the transcript ignored, so a session on a model the account cannot use, or
  past its usage limit, answered every prompt with nothing; only the terminal view carried the reason. The
  error now appears as an open "Codex error" (or "Usage limit reached") event with Codex's message.
- A prompt sent to an agent that is still on its previous turn shows as "Queued" until that turn ends, instead
  of aging to "Submission not confirmed" while it sat in the agent's own queue. That warning read as a failed
  send, and sending again made Claude deliver both copies as one message. The transcript also recognises a
  prompt inside the merged message Claude hands over, and one whose attached image it shows as "[Image #N]".
- A shell no longer receives "12;2$y" and the like when a phone reconnects. A replayed recording can carry a
  program's terminal-mode query; xterm answered it again on every reconnect and the answer was typed into
  whatever sat at the prompt. Mode, status and keyboard-flag reports now stay out of the input the way
  cursor-position and device-attribute answers already did.
- On a phone, "Reconnecting…" no longer stays up forever once the TermDeck Remote session has run out: the
  deck goes to the login page with its address as the way back. While the relay is waking the computer the
  message says so, and asking the relay is what wakes it.
- Through TermDeck Remote, a script fetch or websocket that arrives before the computer has dialed in waits
  up to fifteen seconds for it instead of failing at once, so a phone coming back to the deck reconnects on
  the first try. The web-app manifest is requested with credentials, so it no longer fails with 401 there.

- The attach button works in a phone's transcript. It looked the session up among the terminal
  renderers, and on a phone the transcript has none, so it did nothing.
- Pasting an image into the transcript prompt on a phone attaches it. Android's keyboard does not hand an
  image to the paste event, so the deck also asks the clipboard directly, with the browser's permission
  prompt the first time.
- A phone coming back to TermDeck Remote after its session ran out no longer lands on
  `{"detail":"Google login required"}` with no way forward. The deck parks itself on the relay's idle page
  when unattended, and that page answered an expired session with JSON — reloading fetched the same JSON.
  It now sends the browser to the login page with the deck as the way back. A session that runs out under
  an open deck is caught by the deck's own refreshes, which now get a plain 401 from the relay instead of the
  login page's HTML, and it takes itself to login the same way.
- Terminal-only slash commands no longer appear as user prompts waiting forever for transcript confirmation.
- Transcript slash-command suggestions open and filter while typing, rank exact command names first, and let Enter
  run an exact typed command instead of replacing it with a fuzzy description match.
- Diagnostics recordings, imported shell replays, and session archive contents stay within their configured size
  and structure limits; malformed ZIP compression is reported as an invalid archive.
- Support bundles redact complete authorization and cookie values, including values in JSON diagnostics.
- Read-only monitoring blocks language-server saves, command execution, and workspace edits while retaining
  read-only language-server features; the fallback agent catalog matches the richer Aider, AGY, and OpenCode UI.

## [0.10.1] — 2026-09-03

### Fixed

- A finished turn is marked unread even when the page was not listening at the moment it ended. Unread was
  driven by watching a terminal go from working to idle, so a page whose status socket was reconnecting, a
  phone that was asleep, or a suspended tab saw neither edge and never marked anything — while a sibling
  page that was listening did, which is how the same Codex turn showed unread on one device and idle on
  another. The server now stamps when each turn ends, and a page treats a stamp it has not accounted for as
  a completion it missed. A page that loads after a turn ended does not report it.

## [0.10.0] — 2026-09-03

### Added

- `termdeck service start` and `termdeck service stop`. `stop` unloads the service until the next `start` or
  login and leaves its unit file in place; `uninstall` remains the way to remove it.
- Markdown files open as rendered documents as well as source: a toggle beside the notes button under the
  tab strip, a rebindable shortcut (**⌥⇧M**), and one remembered choice and reading position per file.
  Links to other files in the project resolve against the document and open in the deck; code blocks are
  left as literals rather than linkified.
- Images, video, audio and PDFs open from the file tree instead of being refused as binary — pictures in
  a viewer, video and audio in a player that seeks, PDFs in the browser's own reader. Images stored beside
  a Markdown document now load in the rendered view for the same reason. The bytes come from a route that
  serves an allowlist of media types and nothing that a browser could treat as a document, confined to the
  same directory every other file read is.

### Changed

- Mobile transcripts give their margins back to the text: side padding down to the safe area, a narrower
  marker column, and lists with a shallower indent and no gaps between items. On a 390px screen a line is
  370px wide rather than 328, and the same answer takes 14% less height.
- Side-panel project, Terminals-header, and terminal-group add glyphs share the same 25%-smaller thin-plus
  treatment while retaining their existing click targets.
- The file-tab menu button at the end of the tab strip is a chevron rather than a gear: it opens a dropdown
  about the tabs, not the application's settings, which is what a gear in that corner promises.
- The selected file tab fills its whole slot and is marked by a tint plus an accent line underneath, joining
  it to the editor, instead of a bar above it over the editor's background. The vertical dividers between
  tabs are gone with it.
- Notes and the Markdown toggle sit side by side in one row under the file tabs, Markdown on the right,
  held clear of the editor's own scrollbar instead of hanging over it.
- The file editor's scrollbars match the rest of the app — same width, colour, and rounded inset thumb as
  the terminal's — rather than Monaco's wider default.
- The editor's line-number column is narrower and its digits smaller and dimmer: the gutter reserves three
  characters instead of four (files past 999 lines still get the room they need) and a thinner strip beside
  them, taking it from 55px to 49px on a long file and 48px to 42px on a short one.
- Every files surface shares one route. The Git panel and an open diff are now `?view=git` and `git_path=`
  on `/f/…` rather than a `/g/` route of their own, matching the fact that both show the same file tabs.
  Existing `/g/` addresses still load and are read the same way.
- Terminal-group headers place unread activity beside the group name, followed by right-aligned Search and Add controls.

### Fixed

- `termdeck service restart` (and `start`) on a machine where the service was never installed now installs
  it, and loads a unit file that exists but is not loaded, instead of dying in `launchctl` with "Could not
  find service". A service-manager refusal that does remain is one line on stderr, not a traceback.
- An address the deck cannot open no longer sits on "loading TermDeck…" forever. A worktree or terminal the
  project does not have drops back to the project root; a project this deck does not have lands on the
  all-projects root; and anything that still fails during boot is retried once at the nearest working
  address before the loading screen's own recovery actions take over. The same rules apply through the
  remote relay.
- A phone that has been away reconnects on its own. The page retries every few seconds while the
  connection-loss message is up, notices a return from the browser's back/forward cache as well as focus,
  and takes the message down only once a socket is genuinely open — no tap needed to get terminals back.
- A submitted prompt stops claiming to be in flight forever. It waits for the agent's transcript to carry
  it back, which never happens for a slash command the CLI handles itself: after a minute the message says
  the submission could not be confirmed, and after ten it leaves the transcript to speak for itself.
- Reloading with a file open no longer loses it. The open file now owns the address whichever side panel is
  showing, and the panel rides along in `?view=`; previously a file opened while the Git panel was up was
  addressed under `/g/`, where the path is read as part of the Git route and dropped — so the reload came
  back on whatever the Git panel had selected. Addresses of the old shape still open their file.
- The Markdown toggle appears only for Markdown files. It was being given the `hidden` class correctly,
  but nothing in the stylesheet acts on that class for it, so it stayed on screen for every file.
- Four more controls that the client hides the same way now actually hide: the Git refresh button outside
  the Git panel, the transcript Stop button, the language-server status, the project-add button in the new
  terminal dialog, and the terminal list when the side panel is closed. There is no blanket rule for the
  `hidden` class — each element needs its own, and these were missing (the terminal list had one that lost
  to a more specific selector). A check now forces the class onto every element the client uses it on and
  fails if the element is still displayed.
- A file tab whose file cannot be opened now says so, with Try again and Close tab, instead of leaving the
  previously open file on screen under a tab and an address that both name the new one. A tab restored
  from an earlier session whose file has since been deleted is the usual way in: switching to it looked
  like the tab simply refused to change, and reloading onto it showed an empty panel.
- The Git panel can change the middle panel again after a file has been opened over a diff. Opening a file
  hid the diff but left it flagged as showing, and clicking that same Git row then decided it was already
  on screen and did nothing at all.

## [0.9.0] — 2026-09-03

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

- File tabs are sized by their name rather than a fixed minimum width, and their pin and close controls
  appear on the tab under the pointer, so a tab is its name with the controls a hover away.
- The selected row in the file side panel is a plain band across the panel, the way a selected terminal is,
  rather than an outlined box.
- Filename search keeps every name that contains what was typed in Exact matches, wherever in the name it
  sits, and reserves Fuzzy matches for names that need editing to fit.
- Fuzzy filename matching now means one or two typos -- a wrong, missing, doubled or swapped letter -- close
  to the query, instead of the query's letters collected from anywhere in the name, and it is consulted only
  when what was typed matched almost nothing.
- The editor line holding the caret keeps its tint but loses the outline above and below it, so it no longer
  reads as a selected line.
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

- A terminal that finished a turn while its own browser tab sat in the background drops its unread mark when
  you come back to that tab. Unread was cleared only when the selection moved to a different terminal, so the
  one already on screen kept the mark however often you looked at it. Its badge also appears as soon as the
  turn ends rather than waiting for the next redraw of the list.
- Quick Notes added or edited in one window stay put: notes are stored one at a time instead of as a whole
  list, so a note added in one window or device is no longer deleted by the next save from another one.
- Text typed into a note is saved to the note showing in the editor, so an edit is never silently dropped
  when the selected tab and the editor disagree about which note is open.
- Moving a note to the Trash leaves Quick Notes open and selects the neighbouring note, instead of closing
  the panel when the confirmation is answered and reopening on an empty editor.
- Answering any confirmation dialog no longer counts as a click outside the popup that opened it.
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

[Unreleased]: https://github.com/danialfarid/termdeck/compare/v0.23.0...HEAD
[0.23.0]: https://github.com/danialfarid/termdeck/compare/v0.22.0...v0.23.0
[0.22.0]: https://github.com/danialfarid/termdeck/compare/v0.21.0...v0.22.0
[0.21.0]: https://github.com/danialfarid/termdeck/compare/v0.20.1...v0.21.0
[0.20.1]: https://github.com/danialfarid/termdeck/compare/v0.20.0...v0.20.1
[0.20.0]: https://github.com/danialfarid/termdeck/compare/v0.19.7...v0.20.0
[0.19.7]: https://github.com/danialfarid/termdeck/compare/v0.19.6...v0.19.7
[0.19.6]: https://github.com/danialfarid/termdeck/compare/v0.19.5...v0.19.6
[0.19.5]: https://github.com/danialfarid/termdeck/compare/v0.19.4...v0.19.5
[0.19.4]: https://github.com/danialfarid/termdeck/compare/v0.19.3...v0.19.4
[0.19.3]: https://github.com/danialfarid/termdeck/compare/v0.19.2...v0.19.3
[0.19.2]: https://github.com/danialfarid/termdeck/compare/v0.19.1...v0.19.2
[0.19.1]: https://github.com/danialfarid/termdeck/compare/v0.19.0...v0.19.1
[0.19.0]: https://github.com/danialfarid/termdeck/compare/v0.18.0...v0.19.0
[0.18.0]: https://github.com/danialfarid/termdeck/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/danialfarid/termdeck/compare/v0.16.2...v0.17.0
[0.16.2]: https://github.com/danialfarid/termdeck/compare/v0.16.1...v0.16.2
[0.16.1]: https://github.com/danialfarid/termdeck/compare/v0.16.0...v0.16.1
[0.16.0]: https://github.com/danialfarid/termdeck/compare/v0.15.1...v0.16.0
[0.15.1]: https://github.com/danialfarid/termdeck/compare/v0.15.0...v0.15.1
[0.15.0]: https://github.com/danialfarid/termdeck/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/danialfarid/termdeck/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/danialfarid/termdeck/compare/v0.12.3...v0.13.0
[0.12.3]: https://github.com/danialfarid/termdeck/compare/v0.12.2...v0.12.3
[0.12.2]: https://github.com/danialfarid/termdeck/compare/v0.12.1...v0.12.2
[0.12.1]: https://github.com/danialfarid/termdeck/compare/v0.12.0...v0.12.1
[0.12.0]: https://github.com/danialfarid/termdeck/compare/v0.11.1...v0.12.0
[0.11.1]: https://github.com/danialfarid/termdeck/compare/v0.11.0...v0.11.1
[0.11.0]: https://github.com/danialfarid/termdeck/compare/v0.10.1...v0.11.0
[0.10.1]: https://github.com/danialfarid/termdeck/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/danialfarid/termdeck/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/danialfarid/termdeck/compare/v0.8.1...v0.9.0
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
