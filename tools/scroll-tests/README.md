# Tall-terminal scroll tests

Regression tests for the tall-terminal layout (1000-row PTY, container-owned scrolling). Each one was
written against a bug that actually shipped, and several caught regressions introduced by later fixes in
this same area -- the interactions here are subtle enough that reasoning alone repeatedly got them wrong.

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

Two lessons the tests themselves taught, both of which produced false PASSes:

- Sample the thing the user sees, not a proxy. Counting `scrollTop` writes flags writes that change
  nothing; measuring at animation frames misses a clamp that runs inside the scroll handler.
- Verify a test can fail. Several of these passed against known-broken code until the assertion was
  corrected -- disable the fix and confirm the test goes red before trusting it green.
