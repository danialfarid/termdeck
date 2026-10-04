"""Three things the transcript owes a phone.

A finger holding transcript text gets the platform's own menu: iOS and Android select natively
and offer Copy there, while the scripted whole-message selection the hold used to trigger kept
being blown away as the platform's own handling ran. A prompt waiting to be confirmed is looked
for on a clock, rather than only when the transcript happens to say something -- an agent that
has taken the prompt and gone quiet left the message reading as one that was never sent. And
the keyboard shift happens once: Android's keyboard shrinks both viewports and pans nothing, so
the transcript shifts itself, while iPhone Safari pans to the field on its own and a shift on
top of that moves everything twice.

The client has no JS harness; as in test_terminal_cycle_order the methods are lifted out of the
shipped source and run under node against stubs.
"""

import json
import os
import re
import shutil
import subprocess
import time
import unittest
from pathlib import Path

from tests.test_terminal_cycle_order import method_source

STATIC = Path(__file__).resolve().parent.parent / "termdeck" / "static"

NATIVE_MENU_HARNESS = """
const scenario = JSON.parse(process.env.TERMDECK_TOUCH_SCENARIO);
const app = {
  touchMobileLayoutEnabled: () => scenario.touch,
  __METHODS__
};
const source = scenario.source === null ? null : { id: scenario.source };
process.stdout.write(JSON.stringify({ native: app.transcriptTouchMenuIsNative(source) }));
"""

MAIN_SCROLL_HARNESS = """
const scenario = JSON.parse(process.env.TERMDECK_SCROLL_SCENARIO);
let frame = null;
global.requestAnimationFrame = (cb) => { frame = cb; return 1; };
const main = scenario.missing ? null : { scrollTop: 50, scrollLeft: 30 };
const app = {
  $(id) { return id === "main" ? main : null; },
  __METHODS__
};
app.resetMainScrollAfterKeyboard();
frame();
process.stdout.write(JSON.stringify(
  main === null ? { missing: true } : { top: main.scrollTop, left: main.scrollLeft }));
"""

KEYBOARD_SHIFT_HARNESS = """
const scenario = JSON.parse(process.env.TERMDECK_KEYBOARD_SCENARIO);
const KEYBOARD_NATIVE_PAN_SLACK_PX = 24;
const frames = [];
global.requestAnimationFrame = (cb) => { frames.push(cb); return frames.length; };
global.window = {
  innerHeight: scenario.layout,
  visualViewport: scenario.visual === null ? null : { height: scenario.visual },
};
const body = { scrollTop: 0, scrollHeight: 1000, clientHeight: 300 };
const app = {
  $(id) { return id === "history-body" ? body : null; },
  __METHODS__
};
const native = app.keyboardShiftIsNative();
app.keepHistoryPinnedToBottom(scenario.wasAtBottom !== false);
while (frames.length) frames.shift()();
process.stdout.write(JSON.stringify({ native, scrollTop: body.scrollTop }));
"""

MERGE_HARNESS = r"""
const scenario = JSON.parse(process.env.TERMDECK_MERGE_SCENARIO);
const PENDING_PROMPT_DISCARD_MS = 600000;
const PENDING_PROMPT_UNCONFIRMED_MS = 25000;
const app = {
  historyPendingPrompts: new Map([["s1", scenario.pending]]),
  historyPendingPromptSequence: 100,
  processingStates: new Map(scenario.processing ? [["s1", true]] : []),
  session() { return { session_id: "s1", processing: !!scenario.sessionProcessing }; },
  agentSpec() { return { transcript_commands: [] }; },
  persistedHistoryPendingPrompts(sessionId) {
    return this.historyPendingPrompts.get(sessionId) || [];
  },
  persistHistoryPendingPrompts() {},
  syncPendingPromptRecheck() {},
  __METHODS__
};
const merged = app.mergePendingHistoryPrompts("s1", scenario.turns || []);
process.stdout.write(JSON.stringify({
  states: merged.map((turn) => turn.pending_id ? turn.pending_delivery_state : "authoritative"),
}));
"""

STALLED_HARNESS = """
const scenario = JSON.parse(process.env.TERMDECK_STALL_SCENARIO);
const STREAM_CONNECT_TIMEOUT_MS = 10000;
global.WebSocket = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };
const app = {
  __METHODS__
};
const socket = scenario.state === null ? null : { readyState: global.WebSocket[scenario.state] };
const startedAt = scenario.age === null ? scenario.startedAt : Date.now() - scenario.age;
process.stdout.write(JSON.stringify({ stalled: app.streamSocketConnectStalled(socket, startedAt) }));
"""

RETRY_HARNESS = """
const scenario = JSON.parse(process.env.TERMDECK_RETRY_SCENARIO);
global.WebSocket = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };
global.window = { setTimeout: () => 99 };
const calls = [];
const statusNode = { textContent: "" };
const app = {
  activeId: "s1",
  historyOpen: true,
  activeFileKey: null,
  $(id) { return id === "status-name" ? statusNode : { value: scenario.promptValue || "" }; },
  writePromptDraftToTerminal(view, text) { calls.push(["write", text]); },
  sendTrackedInput(view, text) { calls.push(["send", text]); },
  setHistoryPendingPromptDeliveryState(sessionId, pendingId, state) { calls.push(["state", state]); },
  __METHODS__
};
const view = { sessionId: "s1", closed: false, awaitingSnapshot: false, replaying: false,
  retryTerminalEnterTimer: 0, ...scenario.view };
app.maybeSendRetryTerminalEnter(view);
process.stdout.write(JSON.stringify({ status: statusNode.textContent, calls,
  pending: !!view.retryTerminalEnterPending }));
"""

RECHECK_HARNESS = """
const scenario = JSON.parse(process.env.TERMDECK_RECHECK_SCENARIO);
const MOBILE_TERMINAL_LONG_PRESS_MS = 450;
const PENDING_PROMPT_RECHECK_MS = 4000;
const calls = { setInterval: 0, clearInterval: 0, reloads: 0 };
let tick = null;
global.window = {
  setInterval: (fn, ms) => { calls.setInterval += 1; calls.intervalMs = ms; tick = fn; return 7; },
};
global.clearInterval = (handle) => { calls.clearInterval += 1; calls.cleared = handle; tick = null; };

const app = {
  historyOpen: scenario.historyOpen,
  activeId: scenario.activeId,
  historyPendingPrompts: new Map(Object.entries(scenario.pendingBySession || {})),
  pendingPromptRecheckTimer: scenario.existingTimer || 0,
  loadHistory(sessionId, options) { calls.reloads += 1; calls.reloadedSession = sessionId; calls.reloadOptions = options; },
  __METHODS__
};
app.syncPendingPromptRecheck(scenario.sessionId, scenario.pendingCount);
if (scenario.fireTicks) {
  for (let i = 0; i < scenario.fireTicks; i += 1) {
    if (scenario.clearPendingBeforeTick) app.historyPendingPrompts.delete(app.activeId);
    if (tick) tick();
  }
}
process.stdout.write(JSON.stringify({ ...calls, timer: app.pendingPromptRecheckTimer }));
"""


def run_node(harness: str, env_name: str, scenario: dict, node: str) -> dict:
    done = subprocess.run([node, "-e", harness], capture_output=True, text=True, check=False,
                          env={**os.environ, env_name: json.dumps(scenario)})
    if done.returncode != 0:
        raise AssertionError(done.stderr)
    return json.loads(done.stdout)


class NativeTouchMenuTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        source = (STATIC / "app_markdown_files.js").read_text()
        cls.harness = NATIVE_MENU_HARNESS.replace(
            "__METHODS__", method_source(source, "transcriptTouchMenuIsNative(source)"))

    def native(self, source: str | None, touch: bool) -> bool:
        return run_node(self.harness, "TERMDECK_TOUCH_SCENARIO",
                        {"source": source, "touch": touch}, self.node)["native"]

    def test_transcript_hold_on_a_phone_is_native(self) -> None:
        self.assertTrue(self.native("history-body", True))

    def test_transcript_right_click_on_desktop_keeps_the_custom_menu(self) -> None:
        self.assertFalse(self.native("history-body", False))

    def test_terminal_and_notebook_keep_the_custom_menu_on_touch(self) -> None:
        # The terminal is a canvas and the notebook an editor: neither selects natively.
        self.assertFalse(self.native("terminal", True))
        self.assertFalse(self.native("notebook-editor-host", True))

    def test_no_source_is_never_native(self) -> None:
        self.assertFalse(self.native(None, True))


class MainScrollResetTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        source = (STATIC / "app.js").read_text()
        cls.harness = MAIN_SCROLL_HARNESS.replace(
            "__METHODS__", method_source(source, "resetMainScrollAfterKeyboard()"))

    def test_keyboard_resize_zeroes_the_main_pan(self) -> None:
        result = run_node(self.harness, "TERMDECK_SCROLL_SCENARIO", {}, self.node)

        self.assertEqual(result, {"top": 0, "left": 0})

    def test_missing_main_is_not_an_error(self) -> None:
        result = run_node(self.harness, "TERMDECK_SCROLL_SCENARIO", {"missing": True}, self.node)

        self.assertEqual(result, {"missing": True})


class KeyboardShiftTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        source = (STATIC / "app.js").read_text()
        cls.harness = KEYBOARD_SHIFT_HARNESS.replace(
            "__METHODS__",
            "\n  ".join(method_source(source, name) for name in (
                "keyboardShiftIsNative()", "keepHistoryPinnedToBottom(wasAtBottom)")))

    def shifted(self, visual: int | None, layout: int, **scenario: object) -> dict:
        return run_node(self.harness, "TERMDECK_KEYBOARD_SCENARIO",
                        {"visual": visual, "layout": layout, **scenario}, self.node)

    def test_iphone_safari_pans_so_the_transcript_stays_put(self) -> None:
        # The visual viewport shrank while the layout viewport stayed: Safari is moving the
        # content itself, and pinning the transcript on top of that shifts everything twice.
        result = self.shifted(visual=400, layout=844)

        self.assertTrue(result["native"])
        self.assertEqual(result["scrollTop"], 0)

    def test_android_shrinks_both_so_the_transcript_shifts_itself(self) -> None:
        # Both viewports shrank together: the browser panned nothing, and without the pin the
        # newest lines end up behind the keyboard.
        result = self.shifted(visual=400, layout=400)

        self.assertFalse(result["native"])
        self.assertEqual(result["scrollTop"], 1000)

    def test_no_keyboard_means_no_native_pan(self) -> None:
        result = self.shifted(visual=844, layout=844)

        self.assertFalse(result["native"])
        self.assertEqual(result["scrollTop"], 1000)

    def test_a_few_pixels_of_noise_is_not_a_keyboard(self) -> None:
        # Rounding and URL-bar settle can leave the two heights a hair apart.
        result = self.shifted(visual=840, layout=844)

        self.assertFalse(result["native"])
        self.assertEqual(result["scrollTop"], 1000)

    def test_no_visual_viewport_means_no_native_pan(self) -> None:
        result = self.shifted(visual=None, layout=844)

        self.assertFalse(result["native"])
        self.assertEqual(result["scrollTop"], 1000)

    def test_a_reader_up_in_history_is_never_pinned(self) -> None:
        result = self.shifted(visual=400, layout=400, wasAtBottom=False)

        self.assertEqual(result["scrollTop"], 0)


class PendingPromptRecheckTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        source = (STATIC / "app_markdown_files.js").read_text()
        cls.harness = RECHECK_HARNESS.replace(
            "__METHODS__", method_source(source, "syncPendingPromptRecheck(sessionId, pendingCount)"))

    def run_scenario(self, **scenario: object) -> dict:
        base = {"historyOpen": True, "activeId": "s1", "sessionId": "s1", "pendingCount": 1,
                "pendingBySession": {"s1": [{"text": "hello"}]}}
        return run_node(self.harness, "TERMDECK_RECHECK_SCENARIO", {**base, **scenario}, self.node)

    def test_a_waiting_prompt_starts_the_clock(self) -> None:
        result = self.run_scenario()

        self.assertEqual(result["setInterval"], 1)
        self.assertEqual(result["intervalMs"], 4000)

    def test_each_tick_asks_the_transcript_again(self) -> None:
        # The confirmation can only come from the transcript, and nothing else is going to ask for it
        # while the agent works in silence.
        result = self.run_scenario(fireTicks=2)

        self.assertEqual(result["reloads"], 2)
        self.assertEqual(result["reloadedSession"], "s1")
        self.assertTrue(result["reloadOptions"]["preserveScroll"])

    def test_the_tick_never_steals_the_scroll(self) -> None:
        # followLatest nulls the scroll snapshot, so passing it here yanked a reader mid-transcript
        # to the bottom every four seconds for as long as any prompt sat unconfirmed. The recheck
        # is a quiet background ask: it preserves the scroll and follows nothing.
        result = self.run_scenario(fireTicks=1)

        self.assertFalse(result["reloadOptions"].get("followLatest", False))

    def test_the_clock_stops_once_nothing_is_waiting(self) -> None:
        result = self.run_scenario(fireTicks=1, clearPendingBeforeTick=True)

        self.assertEqual(result["reloads"], 0)
        self.assertEqual(result["clearInterval"], 1)
        self.assertEqual(result["timer"], 0)

    def test_nothing_waiting_means_no_clock(self) -> None:
        result = self.run_scenario(pendingCount=0, pendingBySession={})

        self.assertEqual(result["setInterval"], 0)

    def test_a_closed_transcript_is_not_polled(self) -> None:
        result = self.run_scenario(historyOpen=False)

        self.assertEqual(result["setInterval"], 0)

    def test_one_clock_at_a_time(self) -> None:
        result = self.run_scenario(existingTimer=7)

        self.assertEqual(result["setInterval"], 0)
        self.assertEqual(result["timer"], 7)

    def test_a_prompt_waiting_on_another_terminal_does_not_start_it(self) -> None:
        result = self.run_scenario(sessionId="s2")

        self.assertEqual(result["setInterval"], 0)


class PendingPromptBusyStateTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        source = (STATIC / "app_markdown_files.js").read_text()
        cls.harness = MERGE_HARNESS.replace(
            "__METHODS__",
            "\n  ".join(method_source(source, name) for name in (
                "mergePendingHistoryPrompts(sessionId, turns)",
                "historyAuthoritativePromptMatchesPending(authoritativeText, pendingText)",
                "historyPromptComparisonText(text)", "historyPromptLooseMatchText(text)",
                "historyTurnTimestampMillis(turn)",
                "historyTextIsUntrackedSlashCommand(text, sessionId = this.activeId)",
                "historySlashCommandForText(text, sessionId = this.activeId)")))

    def merge(self, pending: list, busy: bool, turns: list | None = None) -> list:
        done = subprocess.run(
            [self.node, "-e", self.harness], capture_output=True, text=True, check=False,
            env={**os.environ, "TERMDECK_MERGE_SCENARIO": json.dumps(
                {"pending": pending, "processing": busy, "sessionProcessing": busy,
                 "turns": turns or []})})
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)["states"]

    def entry(self, **overrides: object) -> dict:
        # Aged a minute: past the 25s "unconfirmed" line, far short of the 10min discard.
        base = {"text": "do the thing", "beforeCount": 0, "pending_id": "p1",
                "timestamp": int(time.time() * 1000) - 60000,
                "delivery_state": "awaiting_transcript",
                "busy_at_submit": False, "idle_since": 0}
        return {**base, **overrides}

    def test_a_working_agent_means_queued_even_when_submit_thought_otherwise(self) -> None:
        # busy_at_submit froze what the tab knew at send time; a tab that sent during a stale
        # moment aged a delivered, queued prompt to "unconfirmed" with a retry button that would
        # have sent it a second time. What matters is whether the agent is working now.
        states = self.merge([self.entry()], busy=True)

        self.assertEqual(states, ["queued"])

    def test_a_working_agent_means_queued(self) -> None:
        states = self.merge([self.entry(busy_at_submit=True)], busy=True)

        self.assertEqual(states, ["queued"])

    def test_an_idle_agent_means_unconfirmed(self) -> None:
        states = self.merge([self.entry()], busy=False)

        self.assertEqual(states, ["unconfirmed"])

    def test_a_matching_turn_confirms_and_removes_the_entry(self) -> None:
        item = self.entry()
        states = self.merge(
            [item], busy=False,
            turns=[{"role": "user", "text": "do the thing",
                    "timestamp": item["timestamp"] + 1000}])

        self.assertEqual(states, ["authoritative"])


class StreamConnectStallTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        source = (STATIC / "app.js").read_text()
        cls.harness = STALLED_HARNESS.replace(
            "__METHODS__", method_source(source, "streamSocketConnectStalled(socket, startedAt)"))

    def stalled(self, state: str | None, age: int | None, started_at: int = 0) -> bool:
        return run_node(self.harness, "TERMDECK_STALL_SCENARIO",
                        {"state": state, "age": age, "startedAt": started_at},
                        self.node)["stalled"]

    def test_an_open_socket_is_never_stalled(self) -> None:
        self.assertFalse(self.stalled("OPEN", 60000))

    def test_a_fresh_connect_is_not_stalled(self) -> None:
        self.assertFalse(self.stalled("CONNECTING", 1000))

    def test_a_connect_hung_past_the_deadline_is_stalled(self) -> None:
        # The reconnect loop used to wait on a CONNECTING socket forever: a handshake the relay
        # held open without answering kept the tab on "Reconnecting…" until a reload.
        self.assertTrue(self.stalled("CONNECTING", 60000))

    def test_a_closed_socket_is_not_stalled(self) -> None:
        # Closed is the reconnect path's ordinary business, not this predicate's.
        self.assertFalse(self.stalled("CLOSED", 60000))

    def test_no_socket_is_not_stalled(self) -> None:
        self.assertFalse(self.stalled(None, 60000))

    def test_an_unknown_start_is_not_stalled(self) -> None:
        # Fail open: never kill a socket whose age cannot be proven.
        self.assertFalse(self.stalled("CONNECTING", None, 0))


class RetryExpiryTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        source = (STATIC / "app_markdown_files.js").read_text()
        cls.harness = RETRY_HARNESS.replace(
            "__METHODS__", method_source(source, "maybeSendRetryTerminalEnter(view)"))

    def run_view(self, view: dict, prompt_value: str = "") -> dict:
        return run_node(self.harness, "TERMDECK_RETRY_SCENARIO",
                        {"view": view, "promptValue": prompt_value}, self.node)

    def test_an_expired_retry_says_so(self) -> None:
        # The wait used to end in silence: fifteen seconds of nothing, then the request was gone
        # with no word on the status line about why the button had done nothing.
        result = self.run_view({"retryTerminalEnterPending": True,
                                "retryTerminalEnterExpiresAt": int(time.time() * 1000) - 1,
                                "retryTerminalEnterText": "do the thing",
                                "ws": None})

        self.assertFalse(result["pending"])
        self.assertIn("retry", result["status"].lower())
        self.assertEqual(result["calls"], [])

    def test_navigating_away_dismisses_without_announcing(self) -> None:
        view = {"sessionId": "s2", "retryTerminalEnterPending": True,
                "retryTerminalEnterExpiresAt": int(time.time() * 1000) + 15000,
                "retryTerminalEnterText": "do the thing", "ws": None}
        result = self.run_view(view)

        self.assertFalse(result["pending"])
        self.assertEqual(result["status"], "")
        self.assertEqual(result["calls"], [])

    def test_an_open_terminal_sends_the_retry(self) -> None:
        result = self.run_view({"retryTerminalEnterPending": True,
                                "retryTerminalEnterExpiresAt": int(time.time() * 1000) + 15000,
                                "retryTerminalEnterText": "do the thing",
                                "retryTerminalEnterPendingId": "p1",
                                "ws": {"readyState": 1}},
                               prompt_value="something else")

        self.assertEqual(result["calls"], [["write", "do the thing"], ["send", "\r"],
                                           ["state", "awaiting_transcript"]])
        self.assertEqual(result["status"], "retry Enter sent to terminal")


class ShippedSourceTest(unittest.TestCase):
    def test_the_recheck_interval_is_seconds_not_minutes(self) -> None:
        # A prompt that has landed should stop looking undelivered while the person is still looking
        # at it, which is the whole point of the clock.
        source = (STATIC / "app.js").read_text()
        interval = int(re.search(r"PENDING_PROMPT_RECHECK_MS = (\d+)", source).group(1))

        self.assertLessEqual(interval, 10000)
        self.assertGreaterEqual(interval, 1000)

    def test_the_native_pan_gap_is_noise_not_keyboard(self) -> None:
        # The gap that tells an iPhone keyboard (visual shrank, layout stayed) from rounding
        # and URL-bar settle has to sit between the two: above a few pixels, far below ~300.
        source = (STATIC / "app.js").read_text()
        slack = int(re.search(r"KEYBOARD_NATIVE_PAN_SLACK_PX = (\d+)", source).group(1))

        self.assertGreaterEqual(slack, 8)
        self.assertLessEqual(slack, 100)

    def test_the_connect_deadline_is_patient_but_bounded(self) -> None:
        # A handshake takes well under a second; the reconnect loop ticks every few. Past ten
        # seconds a CONNECTING socket is one the relay is holding open without answering.
        source = (STATIC / "app.js").read_text()
        deadline = int(re.search(r"STREAM_CONNECT_TIMEOUT_MS = (\d+)", source).group(1))

        self.assertGreaterEqual(deadline, 5000)
        self.assertLessEqual(deadline, 30000)


if __name__ == "__main__":
    unittest.main()
