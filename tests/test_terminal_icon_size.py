import re
import unittest
from pathlib import Path

from termdeck.server import UiSettings


class TerminalIconSizeTest(unittest.TestCase):
    """The sidebar provider icons stay small by default and resizable.

    The size lives in three places -- the server settings default, the client
    SETTINGS_DEFAULTS, and the CSS var() fallbacks -- which drift apart silently.
    The default is 12px (down from 14); the "Terminal icons" control in the font
    size editor is what lets the user go smaller or bigger.
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
        self.assertIsNotNone(
            re.search(r"terminal_icon_size:.*?font-sample-icons", self.settings_ui_js),
            "terminal_icon_size missing from the font-sample previews")
