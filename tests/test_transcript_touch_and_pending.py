"""Two things the transcript owes a phone.

A message held under a finger selects whole, because dragging two handles through text that scrolls
away is not a way to copy an answer. And a prompt waiting to be confirmed is looked for on a clock,
rather than only when the transcript happens to say something -- an agent that has taken the prompt
and gone quiet left the message reading as one that was never sent.

The client has no JS harness; as in test_terminal_cycle_order the methods are lifted out of the
shipped source and run under node against stubs.
"""

import json
import os
import re
import shutil
import subprocess
import unittest
from pathlib import Path

from tests.test_terminal_cycle_order import method_source

STATIC = Path(__file__).resolve().parent.parent / "termdeck" / "static"

SELECTION_HARNESS = """
const scenario = JSON.parse(process.env.TERMDECK_TOUCH_SCENARIO);

// Enough of a document for closest()/querySelector(":scope > .turn-text") to mean what they mean.
class Node {
  constructor(classes, parent = null) {
    this.classes = new Set(classes);
    this.parent = parent;
    this.children = [];
    if (parent) parent.children.push(this);
  }
  matchesSelector(selector) {
    return selector.split(",").map((part) => part.trim()).some((part) => {
      if (part.startsWith(".")) return this.classes.has(part.slice(1));
      return this.tag === part;
    });
  }
  closest(selector) {
    let node = this;
    while (node) {
      if (node.matchesSelector(selector)) return node;
      node = node.parent;
    }
    return null;
  }
  querySelector(selector) {
    const wanted = selector.replace(":scope > ", "");
    const direct = selector.startsWith(":scope > ");
    const search = (node) => {
      for (const child of node.children) {
        if (child.matchesSelector(wanted)) return child;
        if (!direct) {
          const found = search(child);
          if (found) return found;
        }
      }
      return null;
    };
    return search(this);
  }
}

const build = (spec, parent = null) => {
  const node = new Node(spec.classes || [], parent);
  node.tag = spec.tag || "div";
  node.name = spec.name || "";
  for (const child of spec.children || []) build(child, node);
  return node;
};

const root = build(scenario.tree);
const find = (node, name) => node.name === name ? node
  : node.children.reduce((found, child) => found || find(child, name), null);

const app = {
  __METHODS__
};
const target = find(root, scenario.target);
const section = app.transcriptSectionForSelection(target);
process.stdout.write(JSON.stringify({ selected: section ? section.name : null }));
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


def turn_tree() -> dict:
    return {"name": "body", "classes": ["history-body"], "children": [
        {"name": "user-turn", "classes": ["turn", "user"], "children": [
            {"name": "user-role", "classes": ["turn-role"]},
            {"name": "user-text", "classes": ["turn-text", "markdown"], "children": [
                {"name": "paragraph", "tag": "p"},
            ]},
            {"name": "delivery", "classes": ["history-pending-delivery"], "children": [
                {"name": "retry", "tag": "button", "classes": ["history-pending-action"]},
            ]},
        ]},
        {"name": "tool-event", "classes": ["history-event", "edit"], "children": [
            {"name": "event-summary", "tag": "summary"},
            {"name": "event-diff", "classes": ["history-diff"]},
        ]},
        {"name": "composer", "tag": "textarea", "classes": ["history-composer"]},
    ]}


class TranscriptLongPressSelectionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        source = (STATIC / "app_markdown_files.js").read_text()
        cls.harness = SELECTION_HARNESS.replace(
            "__METHODS__", method_source(source, "transcriptSectionForSelection(target)"))

    def selected(self, target: str) -> str | None:
        return run_node(self.harness, "TERMDECK_TOUCH_SCENARIO",
                        {"tree": turn_tree(), "target": target}, self.node)["selected"]

    def test_holding_a_message_selects_what_was_said(self) -> None:
        # Not the "You" label above it, nor the delivery note below it: those are the transcript
        # talking about the message, and copying them with it is noise.
        self.assertEqual(self.selected("paragraph"), "user-text")

    def test_holding_the_role_label_selects_the_same_message(self) -> None:
        self.assertEqual(self.selected("user-role"), "user-text")

    def test_holding_a_tool_call_selects_the_whole_call(self) -> None:
        # An operation has no message text; what is on screen is the summary and whatever it has open.
        self.assertEqual(self.selected("event-diff"), "tool-event")

    def test_a_button_inside_a_message_is_still_a_button(self) -> None:
        self.assertIsNone(self.selected("retry"))

    def test_holding_outside_a_message_selects_nothing(self) -> None:
        self.assertIsNone(self.selected("composer"))


SELECT_HARNESS = """
const scenario = JSON.parse(process.env.TERMDECK_SELECT_SCENARIO);
const opened = [];
let selectedNode = null;
let ranges = 0;
global.document = { createRange: () => ({ selectNodeContents: (node) => { selectedNode = node; } }) };
global.navigator = { vibrate: () => { opened.push("vibrate"); } };
global.window = {
  getSelection: () => scenario.noSelection ? null : {
    removeAllRanges: () => { ranges = 0; selectedNode = null; },
    addRange: () => { ranges += 1; },
    toString: () => (ranges ? scenario.text : ""),
  },
};
const app = {
  readSelectionActionState: () => ({ kind: "history", text: scenario.text }),
  openSelectionContextMenu: (state, point, kind) => opened.push({ state, point, kind }),
  __METHODS__
};
const result = app.selectTranscriptSection({ name: "section" }, { x: 12, y: 40 });
process.stdout.write(JSON.stringify({ result, opened, selected: !!selectedNode }));
"""


class SelectTranscriptSectionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        source = (STATIC / "app_markdown_files.js").read_text()
        cls.harness = SELECT_HARNESS.replace(
            "__METHODS__", method_source(source, "selectTranscriptSection(section, point)"))

    def select(self, **scenario: object) -> dict:
        return run_node(self.harness, "TERMDECK_SELECT_SCENARIO", {"text": "what the agent said", **scenario}, self.node)

    def test_the_hold_opens_the_menu_at_the_finger(self) -> None:
        # Selecting text leaves nothing to press. The menu a right-click opens on a desktop is what
        # the hold opens here -- Copy, New note, Search in files, Ask an agent.
        result = self.select()

        self.assertTrue(result["result"])
        menu = next(entry for entry in result["opened"] if isinstance(entry, dict))
        self.assertEqual(menu["point"], {"x": 12, "y": 40})
        self.assertEqual(menu["kind"], "history")
        self.assertEqual(menu["state"]["text"], "what the agent said")

    def test_a_section_with_no_text_selects_nothing_and_opens_nothing(self) -> None:
        result = self.select(text="   ")

        self.assertFalse(result["result"])
        self.assertEqual([entry for entry in result["opened"] if isinstance(entry, dict)], [])


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


class ShippedSourceTest(unittest.TestCase):
    def test_the_recheck_interval_is_seconds_not_minutes(self) -> None:
        # A prompt that has landed should stop looking undelivered while the person is still looking
        # at it, which is the whole point of the clock.
        source = (STATIC / "app.js").read_text()
        interval = int(re.search(r"PENDING_PROMPT_RECHECK_MS = (\d+)", source).group(1))

        self.assertLessEqual(interval, 10000)
        self.assertGreaterEqual(interval, 1000)


if __name__ == "__main__":
    unittest.main()
