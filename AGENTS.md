# Agent guide: debugging TermDeck (especially visual/scroll bugs)

TermDeck is a web UI (FastAPI server in `termdeck/`, single-page client in `termdeck/static/app*.js` —
one `TermdeckApp` class split across ordered files: `app.js` declares it, the `app_*.js` chunks attach
method groups to its prototype, `app_boot.js` instantiates; see index.html for the load order)
that hosts many persistent terminal sessions (dtach-backed ptys, xterm.js in the browser). The live
instance runs on **port 8530 from this working tree**: static-file edits are live on the next page
reload; Python edits need a server restart (launchd restarts it if you kill the listener; sessions and
scrollback survive restarts).

## The golden rule: ground truth beats reasoning

Every hard rendering/scroll bug in this repo's history was cracked by *measuring the live system*, and
nearly every purely-static theory about them was wrong (see the commit messages around the scroll
fixes, and `tools/scroll-tests/README.md`). Reproduce first, read state from the running page, and only
then read code. When a fix is in, prove it with the same measurement that showed the bug — and prove
the test can fail (run it against the broken code, or wedge the broken state by hand).

## The toolkit

**`window.__td`** — the app object, exposed in every page. The standard probe pattern:

```js
const v = window.__td.views.get(window.__td.activeId);   // or .get('<session-id>')
const b = v.term.buffer.active;
const cell = v.term._core?._renderService?.dimensions?.css?.cell?.height || 21;
// The row actually rendered at the top of the pane — valid since scrollTop is an absolute buffer offset
// and the rendered window sits at element.offsetTop inside the scroll box:
const firstVisible = b.viewportY + Math.floor((v.container.scrollTop - v.term.element.offsetTop) / cell);
```
Useful fields: `v.container.scrollTop`, `v.tallMaxScrollTop` (the content ceiling), `v.tallFollowing`,
`v.tallAnchorRow`/`v.tallAnchorMarker` (parked-reader anchor), `b.viewportY/baseY/length/cursorY`,
`v.term.element.offsetTop` (where the rendered window sits in the scroll box), `v.outputQueue` /
`v.outputWriteInFlight` (write pump), `v.replaying` / `v.awaitingSnapshot` (attach replay).

**Throwaway instance** — never experiment on the live one:

```sh
DATA_DIR="$(mktemp -d /tmp/termdeck-probe.XXXXXX)"
TERMDECK_PORT=8539 TERMDECK_DATA_DIR="$DATA_DIR" \
  TERMDECK_DEFAULT_CWD="$HOME/workspace/height-probe-root" ./run.sh > "$DATA_DIR/server.log" 2>&1 &
# settings: curl -X PATCH http://127.0.0.1:8539/api/settings -d '{"tall_webgl": true}' ...
# teardown: kill the listener, then kill this run's dtach children (match on $DATA_DIR).
```

**Playwright** (`node_modules` has it; headless needs `--use-gl=angle --use-angle=swiftshader
--enable-unsafe-swiftshader` for WebGL). Drive a real session: create via
`POST /api/sessions {model, model_name, permission, cwd, title}`, `window.__td.activate(id)`,
`window.__td.sendInput(view, 'cmd\n')`, `page.keyboard` for typing, `page.mouse.wheel` for scrolling.
For a bug only the user can reproduce, launch a **headed** browser on :8530, install a recorder
(wrap `td.tallSetScrollTop` to log value+stack, plus a 30ms scrollTop sampler for native movers),
and let them reproduce in it.

**Measuring an attach replay** — it arrives as one binary websocket frame:
`ws://127.0.0.1:<port>/ws/<session-id>?screen_repaint=0&have_buffer=0` (python `websockets` works).
Histogram its escape sequences before assuming volume is the problem: one real 5.9s load was 99% OSC
title spam (49,777 spinner frames), not content.

**Write-pump timing** — monkeypatch `td.drainTerminalWrites` to log per-batch bytes and gaps. One giant
first batch with a multi-second gap after it = the cost is inside a single `term.write` (parse or
per-sequence handler work), not transfer.

## Scroll architecture crib sheet (as of release-0.6.1)

- **Whole-buffer scrolling is permanent**: the scroll box (`.term-inner`) spans the entire buffer;
  `container.scrollTop` is an **absolute buffer pixel offset**; the rendered xterm window is positioned
  inside the box at `viewportY * cell` (`tallPositionRenderedWindow`) and is derived FROM scrollTop by
  `tallSyncBufferToScroll`. Any code computing positions as `viewportY + scrollTop/cell` double-counts.
- **Ceiling** (`tallMaxScrollTop`, owned by `tallUpdateMaxScrollTop`): content bottom in absolute rows,
  hard-clamped to what the current buffer can support, growth immediate, shrink damped 400ms on a
  sustained below-current bound. Recomputed on writes, on gesture settles, and on tab-return catch-up —
  it CANNOT move while a pane is hidden (no height to measure against).
- **Follow** (`scrollTallContainerToCursor`): target = min(ceiling, cursor cap). The cap keeps the
  composer's row on screen when a popup paints a whole screen below it (Claude's slash menu). Writes
  snap to the capped target but may only pull the view UP when the cursor is above the visible top;
  gesture settles treat the cap as a floor (a reader in a popup's overflow chose to be there).
- **Parked readers** (`tallFollowing === false`): anchored to a LINE via an xterm marker
  (`tallCaptureAnchorRow` / `tallHoldAnchorRow`); trim drift is applied to scrollTop. Buffer trims at
  20k lines — a reader parked near the very top of a trimming buffer cannot hold (the line itself is
  deleted); that is inherent.
- **Programmatic scrolls** (`tallSetScrollTop`) suppress their own scroll event as an echo, so the
  listener's viewport sync does NOT run for them — whoever moves scrollTop programmatically must call
  `tallSyncBufferToScroll` themselves or the rendered window stays behind (symptom: blank canvas).
- **Attach replay** (`session_manager.attach_client`): durable scrollback with sync-update frames
  stripped at write time and OSC title churn collapsed at read time. Agents paint their screens inside
  sync frames, so after a server restart the replay may lack the live screen — the attach repaint
  (permanent, not a setting) is what restores it.

## Gotchas that have burned agents

- **Every scroll test takes `[port]` argv (or `TERMDECK_TEST_PORT`)** since 2026-08-26; suite tests
  default to 8536, the ad-hoc live probes to 8530. If a run produces all-zero geometry it is passing
  vacuously — print the measured state and read it.
- **The live server serves `static/` from the working tree.** Any page a test loads mid-edit gets your
  half-written app.js; never edit client files while a scroll-suite run is in flight, and treat a run
  that overlapped edits as void.
- **zsh `clear` sends ED3** and erases the scrollback your test just seeded. Use
  `printf '\033[2J\033[H'` to clear the screen and keep history.
- **The echoed command line matches string needles.** Seed search targets with `printf 'THE-%s' NEEDLE`
  so the literal never appears in the typed command.
- **Headless SwiftShader is slow**: frames can take ~1s, scroll/wheel events ride on frames, so
  event-timing measurements lie and wheel gestures get swallowed. Distrust timing-shaped failures that
  only happen headless; confirm in a real browser (headed Playwright, or the user's).
- **Never launch agent CLIs on expensive models for tests**: `claude --model haiku`, codex on `luna` —
  via the sessions API pass `model_name` alongside `model` (the agent kind).
- **Concurrent agents edit this repo constantly.** `git status`+`git diff` before every staging; commit
  their in-flight files first, then yours (split shared files by hunk with `git apply --cached`), so
  the work can be bisected apart. The checked-out branch can change under you (release rolls).
- A synthetic test that passes may be passing **vacuously** (zsh prompt erased your fixture; the seed
  never exceeded the screen; the match was in the command echo). Print the measured state and read it.

## Verifying

- Scroll suite: `tools/scroll-tests/run-all.sh [port]` boots its own throwaway instance (~15 min,
  pre-release gate). Individual tests: `node tools/scroll-tests/<name>.cjs [port]`.
- Python: `uv run python -m pytest tests/ -q` (bare `python3` lacks the deps). This includes the
  protocol-mirror tripwire (models.py field names vs app.js) and per-agent adapter tests.
- CI (`.github/workflows/ci.yml`) runs lint, unit tests, client `node --check`, doctor, and a boot
  smoke on pushes to main and release-* branches.
- Anything user-visible: reproduce the user's exact recipe on :8530 with a fresh page load before
  declaring victory, and state plainly what was and wasn't verified.

## Documenting changes

- Every user-facing addition, change, or fix goes into `CHANGELOG.md` under `[Unreleased]` in the same
  commit that ships it (Keep a Changelog sections: Added / Changed / Fixed / Removed). Write the entry as
  the capability or behavior the user gets, not the implementation.
- If it changes what TermDeck can do (a new agent, a new surface, a new workflow), also check whether the
  README's feature list and guide sections need a matching update. UI layout tweaks stay out of the README.
