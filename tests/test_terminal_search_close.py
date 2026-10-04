"""The header magnifier is the terminal search's way out.

While any terminal search editor is open -- global or group-scoped -- the
header magnifier turns into an X that clears the search and closes the
editor, so its click target reads as "close". The close lives only there:
the search bar itself keeps just its input and scope toggle.
"""

import unittest
from pathlib import Path

STATIC = Path(__file__).resolve().parent.parent / "termdeck" / "static"


class TerminalSearchCloseTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.client = (STATIC / "app.js").read_text()
        cls.css = (STATIC / "style.css").read_text()

    def test_header_magnifier_turns_into_a_close_glyph(self) -> None:
        self.assertIn(
            'glyph.className = `codicon ${terminalSearchOpen ? "codicon-close" : "codicon-search"}`;',
            self.client)

    def test_header_button_closes_any_open_search(self) -> None:
        self.assertIn("if (this.terminalSearchEditorOpen) this.closeTerminalSearchEditor();",
                      self.client)

    def test_bar_has_no_close_button_of_its_own(self) -> None:
        self.assertNotIn("terminal-search-inline-close", self.client)
        self.assertNotIn("terminal-search-inline-close", self.css)

    def test_row_fits_input_and_scope_only(self) -> None:
        self.assertIn(
            "#terminal-search-inline .terminal-search-row { display: grid; "
            "grid-template-columns: minmax(0, 1fr) auto;",
            self.css)
