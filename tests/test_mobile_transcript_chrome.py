"""What a phone's transcript looks like while a prompt is in flight.

A sent message sits greyed until the transcript confirms it -- no cloud badge
row beneath it -- while a failed send stays readable with its warning and
retry/dismiss riding the message's own last line. The thinking banner names
what its counter counts ("Thinking 1m 5s"), and the banner, composer, and
scroll-area bottom air tighten so more conversation fits. Desktop is untouched:
every rule below is scoped to the touch history surface except the banner
wording, which names the counter on all platforms.
"""

import json
import os
import shutil
import subprocess
import unittest
from pathlib import Path

from tests.test_terminal_cycle_order import method_source

STATIC = Path(__file__).resolve().parent.parent / "termdeck" / "static"

BANNER_HARNESS = """
const scenario = JSON.parse(process.env.TERMDECK_BANNER_SCENARIO);
global.setInterval = () => 0;
global.clearInterval = () => {};
const duration = { textContent: "stale" };
const indicator = { classList: { toggle: () => {} } };
const app = {
  $(id) {
    if (id === "history-thinking-banner") return indicator;
    if (id === "history-thinking-duration") return duration;
    return null;
  },
  session() { return {}; },
  processingStates: new Map(scenario.busy ? [["s1", true]] : []),
  historyPendingProcessing: new Map(),
  processingSince: new Map(scenario.busy ? [["s1", Date.now() - scenario.elapsedMs]] : []),
  historyOpen: true,
  activeId: "s1",
  processingTimer: 0,
  updateHistorySendButton() {},
  updateActiveThinkingBlock() {},
  __METHODS__
};
app.updateHistoryThinkingIndicator();
process.stdout.write(JSON.stringify({ text: duration.textContent }));
"""


class ThinkingBannerTextTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        source = (STATIC / "app_markdown_files.js").read_text()
        cls.harness = BANNER_HARNESS.replace(
            "__METHODS__",
            "\n  ".join(method_source(source, name) for name in
                        ("updateHistoryThinkingIndicator()", "formatElapsed(seconds)")))

    def banner_text(self, busy: bool, elapsed_ms: int) -> str:
        env = dict(os.environ, TERMDECK_BANNER_SCENARIO=json.dumps(
            {"busy": busy, "elapsedMs": elapsed_ms}))
        completed = subprocess.run([self.node, "-e", self.harness], env=env,
                                   capture_output=True, text=True, timeout=30)
        self.assertEqual(completed.returncode, 0, completed.stderr[-500:])
        return json.loads(completed.stdout)["text"]

    def test_spinning_names_thinking_before_the_count(self) -> None:
        self.assertEqual(self.banner_text(True, 65000), "Thinking 1m 5s")

    def test_seconds_count_names_thinking_too(self) -> None:
        self.assertEqual(self.banner_text(True, 5000), "Thinking 5s")

    def test_idle_clears_the_banner(self) -> None:
        self.assertEqual(self.banner_text(False, 0), "")


class MobileTranscriptChromeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.css = (STATIC / "style.css").read_text()
        cls.client = (STATIC / "app_markdown_files.js").read_text()

    def test_pending_text_greys_until_confirmed(self) -> None:
        self.assertIn(
            "body.mobile-touch-layout.mobile-history-surface "
            ".turn.user.pending-delivery:not(:has(.history-pending-delivery.unconfirmed)) "
            ".turn-text { opacity: 0.55; }",
            self.css)

    def test_pending_badge_hides_while_greyed(self) -> None:
        self.assertIn(
            "body.mobile-touch-layout.mobile-history-surface "
            ".turn.user.pending-delivery:not(:has(.history-pending-delivery.unconfirmed)) "
            ".history-pending-delivery { display: none; }",
            self.css)

    def test_failed_badge_rides_the_message_line(self) -> None:
        self.assertIn(
            "body.mobile-touch-layout.mobile-history-surface "
            ".turn.user.pending-delivery .turn-text > .history-pending-delivery.unconfirmed "
            "{ display: inline-flex; margin: 0 0 0 6px; vertical-align: middle; }",
            self.css)
        self.assertIn(
            ".turn-text > .history-pending-delivery.unconfirmed "
            ".history-pending-label { display: none; }",
            self.css)
        self.assertIn(
            ".turn-text.history-pending-inline > p:last-of-type { display: inline; }",
            self.css)

    def test_failed_badge_moves_inside_only_on_touch(self) -> None:
        self.assertIn(
            'if (deliveryState === "unconfirmed" && this.touchMobileLayoutEnabled()) {',
            self.client)

    def test_open_sidebar_floats_translucent(self) -> None:
        for fragment in (
            "body.mobile-touch-layout:not(.mobile-sidebar-collapsed) #sidebar {",
            "position: fixed; z-index: 80; top: 0; bottom: 0; left: 0;",
            "background: color-mix(in srgb, var(--panel) 80%, transparent);",
            "-webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);",
            "body.mobile-touch-layout:not(.mobile-sidebar-collapsed) "
            "#sidebar-resizer { display: none; }",
            "body.mobile-touch-layout:not(.mobile-sidebar-collapsed) "
            "#sidebar .terminal-group-label {",
            "background: color-mix(in srgb, var(--panel2) 80%, transparent);",
        ):
            self.assertIn(fragment, self.css, f"sidebar overlay lost: {fragment[:60]}...")

    def test_thinking_banner_has_no_uppercase_transform(self) -> None:
        self.assertIn(
            "#history-thinking-banner { display: flex; align-items: center; gap: 8px; "
            "padding: 5px 12px 4px; border-top: 1px solid var(--border); color: var(--accent); "
            "font: 600 calc(var(--ui-font-size) - 1px) Menlo, monospace; letter-spacing: 0.04em; }",
            self.css)

    def test_mobile_chrome_tightens(self) -> None:
        for fragment in (
            "body.mobile-touch-layout.mobile-history-surface "
            "#history-area.transcript-first #history-body { padding-bottom: 12px; }",
            "body.mobile-touch-layout.mobile-history-surface "
            "#history-thinking-banner { padding: 2px 9px; }",
            "body.mobile-touch-layout.mobile-history-surface "
            "#history-area.transcript-first #history-composer { padding: 5px 9px 6px; }",
            "#history-area.transcript-first .turn { grid-template-columns: 10px "
            "minmax(0, 1fr); column-gap: 4px; margin: 0 0 10px; }",
        ):
            self.assertIn(fragment, self.css, f"tightening lost: {fragment[:70]}...")
