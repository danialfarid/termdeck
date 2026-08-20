#!/bin/zsh
# Runs every scroll test against a throwaway TermDeck instance, then tears it down.
#
#   tools/scroll-tests/run-all.sh            # default port 8536
#   tools/scroll-tests/run-all.sh 8540       # somewhere else
#
# Each test creates and deletes its own sessions, and the instance gets its own data dir, so nothing
# touches a real workspace.
#
# These drive a real pty through a real websocket in a real browser, which makes them slow (~10-15 min for
# the set) and sensitive to timing. That is why this is a pre-release gate rather than a per-commit check:
# on a shared CI runner the fixed waits drift and the suite goes flaky.
set -u
cd "$(dirname "$0")/../.."

PORT="${1:-8536}"
DATA_DIR="$(mktemp -d /tmp/termdeck-scroll-tests.XXXXXX)"
LOG="$DATA_DIR/server.log"

cleanup() {
  local pid
  pid=$(lsof -ti "TCP:$PORT" -sTCP:LISTEN 2>/dev/null)
  [[ -n "$pid" ]] && kill "$pid" 2>/dev/null
  sleep 2
  # dtach outlives the server that spawned it; match on THIS run's data dir so nothing else is touched.
  ps -Ao pid=,command= | awk -v d="$DATA_DIR" '$2 ~ /dtach$/ && index($0, d) > 0 {print $1}' | xargs kill 2>/dev/null
}
trap cleanup EXIT INT TERM

if [[ ! -d node_modules/playwright ]]; then
  echo "playwright is not installed -- run: npm install"
  exit 2
fi

echo "throwaway instance on $PORT (data: $DATA_DIR)"
TERMDECK_PORT="$PORT" TERMDECK_DATA_DIR="$DATA_DIR" \
  TERMDECK_DEFAULT_CWD="$HOME/workspace/height-probe-root" ./run.sh > "$LOG" 2>&1 &

for _ in $(seq 1 40); do
  curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/" && break
  sleep 1
done
if ! curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/"; then
  echo "instance never came up; tail of $LOG:"
  tail -20 "$LOG"
  exit 1
fi
echo

# Cheapest first, so a broken build fails early.
TESTS=(
  no_extra_space
  jump_on_shrink
  held_at_bottom
  drag_fight2
  snapback
  bounce_check2
  copy_paste_check
  settings_popover_opens
  slow_scroll_and_button
  scroll_sources
  wheel_travel
  scrollback_wheel_travel
  composer_cap
  find_reveals_match
  scroll_round_trip
  short_session_scrollback
  parked_under_chunks
  follow_survives_growth
  returns_to_bottom
)

typeset -a failed
for name in "${TESTS[@]}"; do
  printf "%-30s " "$name"
  if node "tools/scroll-tests/$name.cjs" "$PORT" > "$DATA_DIR/$name.out" 2>&1; then
    echo "PASS"
  else
    echo "FAIL   ($DATA_DIR/$name.out)"
    failed+=("$name")
  fi
done

# Needs no instance: it drives the fault detector with fabricated samples.
printf "%-30s " "symptom_detector"
if node tools/scroll-tests/symptom_detector.cjs > "$DATA_DIR/symptom_detector.out" 2>&1; then
  echo "PASS"
else
  echo "FAIL   ($DATA_DIR/symptom_detector.out)"
  failed+=("symptom_detector")
fi

echo
if (( ${#failed[@]} == 0 )); then
  echo "all ${#TESTS[@]} scroll tests passed"
  exit 0
fi
echo "${#failed[@]} failed: ${failed[*]}"
echo "logs kept in $DATA_DIR"
exit 1
