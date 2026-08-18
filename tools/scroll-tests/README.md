# Tall-terminal scroll tests

Regression tests for the tall-terminal layout (1000-row PTY, container-owned scrolling). Each one was
written against a bug that actually shipped, and several caught regressions introduced by later fixes in
this same area -- the interactions here are subtle enough that reasoning alone repeatedly got them wrong.

Install the browser driver once (`node_modules/` is ignored; the browsers themselves are already cached
by Playwright):

    npm install

Run a TermDeck instance on 8536 with a throwaway data dir, then run any file with `node`:

    TERMDECK_PORT=8536 TERMDECK_DATA_DIR=/tmp/td-test \
      TERMDECK_DEFAULT_CWD=~/workspace/height-probe-root ./run.sh &
    node tools/scroll-tests/no_extra_space.cjs

| file | what it pins down |
| --- | --- |
| `no_extra_space.cjs` | the scrollable range equals the content: zero reachable space past the last line |
| `jump_on_shrink.cjs` | a redrawing composer must not shrink the scroll box and jump the view up |
| `held_at_bottom.cjs` | holding the scrollbar at the bottom must not tear (the app never moves a held view) |
| `drag_fight2.cjs` | a moving drag is never clamped mid-gesture, only once it settles |
| `slow_scroll_and_button.cjs` | a slow scroll detaches from the bottom; the scroll-to-bottom button works |
| `snapback.cjs` | a small overshoot is left alone, a large one is still corrected |
| `scroll_sources.cjs` | scrollbar drag and middle-click autoscroll (neither emits wheel events) |
| `bounce_check2.cjs` | wheel overscroll is prevented, not corrected after the fact |
| `copy_paste_check.cjs` | Cmd+C keeps the view and selection; typing returns to the prompt |
| `webkit_scroll.cjs` | Safari scrolls at all, and a scrollbar drag does not pop back to the top |
| `history_write_rate.cjs` | no-op history writes stay at zero (WebKit throws past 100 per 10s) |
| `nav_still_works.cjs` | that dedupe did not cost real navigation: distinct URLs, working Back |
| `settings_popover_opens.cjs` | the settings popover renders its rows |
| `symptom_detector.cjs` | the live fault recorder can fire, and does not fire on look-alike states |

Two faults only ever appear in real use -- a view that cannot reach its own bottom, and a parked view
losing its place as output arrives. Neither survives a synthetic session (a fresh one has no history to
park in and falls idle before the window closes), so `tools/watch_symptoms.cjs` records them during
ordinary use instead of asking for them to be caught in the act:

    node tools/watch_symptoms.cjs 30

It attaches to the testing Chrome, never drives it, prints nothing while things are healthy, and dumps
the four seconds either side of a fault when one appears. `symptom_detector.cjs` is what keeps it honest.

Two lessons the tests themselves taught, both of which produced false PASSes:

- Sample the thing the user sees, not a proxy. Counting `scrollTop` writes flags writes that change
  nothing; measuring at animation frames misses a clamp that runs inside the scroll handler.
- Verify a test can fail. Several of these passed against known-broken code until the assertion was
  corrected -- disable the fix and confirm the test goes red before trusting it green.
