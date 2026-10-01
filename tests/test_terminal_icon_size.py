import re
import unittest
from pathlib import Path

from termdeck.server import UiSettings


class TerminalIconSizeTest(unittest.TestCase):
    """The sidebar provider icons stay small by default and resizable.

    The size lives in three places -- the server settings default, the client
    SETTINGS_DEFAULTS, and the CSS var() fallbacks -- which drift apart silently.
    The default is 12px (down from 14); the "Terminal icons" control in the font
    size editor is what lets the user go smaller or bigger. Rows showing icons
    indent from the icon size itself, so shrinking the icons shifts the title
    left; icon-hidden rows keep their own padding for the status dot and spinner.
    """

    @classmethod
    def setUpClass(cls) -> None:
        static = Path(__file__).resolve().parent.parent / "termdeck" / "static"
        cls.app_js = (static / "app.js").read_text()
        cls.settings_ui_js = (static / "app_settings_ui.js").read_text()
        cls.css = (static / "style.css").read_text()

    def test_server_default_is_12(self) -> None:
        self.assertEqual(UiSettings().terminal_icon_size, 12)

    def test_client_default_matches_server(self) -> None:
        match = re.search(r"terminal_icon_size: (\d+)", self.app_js)
        self.assertIsNotNone(match, "terminal_icon_size missing from SETTINGS_DEFAULTS")
        assert match is not None
        self.assertEqual(int(match.group(1)), UiSettings().terminal_icon_size)

    def test_css_fallbacks_match_default(self) -> None:
        fallbacks = re.findall(r"--terminal-icon-size, (\d+)px", self.css)
        self.assertGreater(len(fallbacks), 0, "no --terminal-icon-size fallbacks found")
        self.assertEqual(sorted(set(fallbacks)), ["12"],
                         f"CSS fallbacks drifted from the default: {sorted(set(fallbacks))}")

    def test_size_control_is_exposed(self) -> None:
        self.assertIn('{ key: "terminal_icon_size", label: "Terminal icons" }', self.app_js)

    def test_sample_preview_uses_the_real_provider_marks(self) -> None:
        # Built by the sidebar's own icon renderer, not a row of lookalike codicons.
        self.assertIsNotNone(
            re.search(r'key === "terminal_icon_size"\) \{\s+preview\.textContent = "";\s+'
                      r"preview\.appendChild\(this\.terminalIconSampleStage\(\)\);",
                      self.settings_ui_js),
            "terminal_icon_size preview no longer builds from terminalIconSampleStage")
        self.assertIsNotNone(
            re.search(r"terminalIconSampleStage\(\) \{.*?this\.terminalTypeIcon\(\{ agent_kind: kind \}\)",
                      self.settings_ui_js, re.S),
            "terminalIconSampleStage no longer uses the sidebar icon renderer")

    def test_sample_preview_sizes_from_the_slider(self) -> None:
        for fragment in (
            ".font-sample-icons span.terminal-type-icon { position: static;",
            ".font-sample-icons .terminal-type-icon svg "
            "{ width: calc(var(--font-sample-size) - 1px);",
            ".font-sample-icons .codex-terminal-icon svg "
            "{ width: calc(var(--font-sample-size) - 2px);",
            ".font-sample-icons .claude-terminal-icon svg "
            "{ width: var(--font-sample-size);",
        ):
            self.assertIn(fragment, self.css, f"preview sizing lost: {fragment[:60]}...")

    def test_shown_rows_indent_from_the_icon_size(self) -> None:
        tracked = [rule for rule in re.findall(r"([^{}]*\.session-item[^{}]*\{[^}]*\})", self.css)
                   if "terminal-icons-hidden" not in rule.split("{")[0]
                   and re.search(r"padding(-left)?\s*:", rule)]
        self.assertGreater(len(tracked), 0, "no shown-row padding rules found")
        for rule in tracked:
            self.assertIn("--terminal-icon-size", rule,
                          f"shown-row padding no longer tracks the icon size: {rule[:80]}...")
            self.assertNotIn("--terminal-row-left-padding", rule,
                             f"shown-row padding still uses the fixed variable: {rule[:80]}...")

    def test_hidden_rows_keep_their_own_padding(self) -> None:
        hidden = re.findall(r"([^{}]*\.terminal-icons-hidden[^{}]*\{[^}]*\})", self.css)
        padded = [rule for rule in hidden if re.search(r"padding(-left)?\s*:", rule)]
        self.assertGreater(len(padded), 0, "no hidden-row padding rules found")
        for rule in padded:
            self.assertIn("--terminal-row-left-padding", rule,
                          f"hidden-row padding lost its variable: {rule[:80]}...")

    def test_hidden_floor_aligns_with_shown_rows_at_default(self) -> None:
        self.assertIn("Math.max(19, terminalIconSize + 7)", self.settings_ui_js)

    def test_activity_dots_track_the_title_on_shown_rows(self) -> None:
        self.assertIn(
            ".session-item:not(.terminal-icons-hidden).has-activity .session-activity-dots "
            "{ left: calc((var(--terminal-icon-size, 12px) + 7px) * var(--ui-scale)); }",
            self.css)

    def test_icon_stays_on_the_title_when_a_description_is_shown(self) -> None:
        self.assertIn(
            ".session-item:has(.session-description:not(.hidden)) .terminal-type-icon "
            "{ top: calc(5px * var(--ui-scale) + var(--sidebar-font-size) * 11 / 18); }",
            self.css)
