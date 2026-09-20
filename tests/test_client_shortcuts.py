import re
import unittest
from pathlib import Path


class KeybindingDispatchTest(unittest.TestCase):
    """Every configurable shortcut declared in app.js is actually dispatched.

    The two halves live in different files -- the table in app.js, the `actionId === "..."` chain in
    app_misc_ui.js -- so a shortcut can be added to the settings list, shown to the user, bound to a key,
    and do nothing at all when pressed. Nothing else catches that.
    """

    @classmethod
    def setUpClass(cls) -> None:
        static = Path(__file__).resolve().parent.parent / "termdeck" / "static"
        cls.app_js = "\n".join(path.read_text() for path in sorted(static.glob("app*.js")))
        cls.index_html = (static / "index.html").read_text()

    def keybinding_ids(self) -> set[str]:
        ids: set[str] = set()
        for block in re.findall(r"const (?:DESKTOP|VSCODE)_KEYBINDINGS = \[(.*?)\n\];", self.app_js, re.S):
            ids |= set(re.findall(r'\{\s*id:\s*"([^"]+)"', block))
        return ids

    def test_every_keybinding_is_dispatched(self) -> None:
        ids = self.keybinding_ids()
        self.assertGreater(len(ids), 20, "the keybinding tables were not found")
        undispatched = sorted(action for action in ids if f'actionId === "{action}"' not in self.app_js)
        self.assertEqual(undispatched, [], f"shortcuts with no handler: {undispatched}")

    def test_shortcut_keys_are_unique_per_surface(self) -> None:
        for table in ("DESKTOP", "VSCODE"):
            block = re.search(rf"const {table}_KEYBINDINGS = \[(.*?)\n\];", self.app_js, re.S)
            self.assertIsNotNone(block, f"{table}_KEYBINDINGS not found")
            defaults = re.findall(r'\{\s*id:\s*"([^"]+)",\s*label:\s*"[^"]*",\s*def:\s*"([^"]+)"', block.group(1))
            seen: dict[str, str] = {}
            clashes = []
            for action, binding in defaults:
                if binding in seen:
                    clashes.append(f"{binding}: {seen[binding]} vs {action}")
                seen[binding] = action
            self.assertEqual(clashes, [], f"{table} default shortcuts collide: {clashes}")


class MarkdownFileViewWiringTest(unittest.TestCase):
    """The Markdown reading view's controls exist in the page it is wired against."""

    @classmethod
    def setUpClass(cls) -> None:
        static = Path(__file__).resolve().parent.parent / "termdeck" / "static"
        cls.app_js = "\n".join(path.read_text() for path in sorted(static.glob("app*.js")))
        cls.index_html = (static / "index.html").read_text()
        cls.style_css = (static / "style.css").read_text()

    def test_elements_exist(self) -> None:
        for element_id in ("file-tabs-markdown", "markdown-file-view"):
            self.assertIn(f'id="{element_id}"', self.index_html, f"#{element_id} missing from index.html")
            self.assertIn(f'"{element_id}"', self.app_js, f"#{element_id} is never referenced by the client")
            self.assertIn(f"#{element_id}", self.style_css, f"#{element_id} has no styling")

    def test_shortcut_is_offered(self) -> None:
        self.assertIn('id: "toggle-markdown-view"', self.app_js)
        self.assertIn('actionId === "toggle-markdown-view"', self.app_js)

    def test_file_tab_menu_button_is_not_a_gear(self) -> None:
        """It opens a dropdown, so it wears a chevron; a gear reads as 'app settings' in that corner."""
        button = re.search(r'<button id="file-tabs-more".*?</button>', self.index_html, re.S)
        self.assertIsNotNone(button, "#file-tabs-more not found")
        self.assertIn("codicon-chevron-down", button.group(0))


class TranscriptFoldsAreOutOfFindsReachTest(unittest.TestCase):
    """The transcript has no find bar, so Cmd+F there is the browser's find-in-page -- which searches
    inside a closed <details> and forces it open on a match. Folded code edits, folded repetitions and
    thinking blocks all sprang open on a search. The stylesheet takes their content out of find's reach
    by hiding it outright, which only works while the transcript keeps folding with <details>.

    tools/scroll-tests/transcript_find_respects_folds.cjs checks the behaviour in a real browser,
    including a control fold that proves the rule is what makes the difference. This is the cheap guard
    that the two halves are still there.
    """

    @classmethod
    def setUpClass(cls) -> None:
        static = Path(__file__).resolve().parent.parent / "termdeck" / "static"
        cls.app_js = "\n".join(path.read_text() for path in sorted(static.glob("app*.js")))
        cls.style_css = (static / "style.css").read_text()

    def test_the_transcript_folds_with_details(self) -> None:
        self.assertIn('document.createElement("details")', self.app_js)

    def test_a_closed_fold_in_the_transcript_hides_its_content(self) -> None:
        rule = re.search(r"#history-body details:not\(\[open\]\)[^{]*\{([^}]*)\}", self.style_css)
        self.assertIsNotNone(rule, "nothing hides the content of a closed transcript fold")
        # content-visibility or visibility would not do: find-in-page reaches into both, and reveals
        # them. Only display:none is skipped outright.
        self.assertIn("display: none", rule.group(1))

    def test_the_summary_is_not_hidden_with_it(self) -> None:
        # The summary is the fold's only handle; hiding it would leave nothing to click.
        rule = re.search(r"#history-body details:not\(\[open\]\)([^{]*)\{", self.style_css)
        self.assertIn(":not(summary)", rule.group(1))


class StartParameterDialogWiringTest(unittest.TestCase):
    """The new-terminal and restart dialogs offer the same two choices, and both reach the server.

    Each is four parts in three files -- markup, the code that fills it, the code that reads it, and the
    request field -- so a half-wired one looks finished and silently does nothing.
    """

    @classmethod
    def setUpClass(cls) -> None:
        static = Path(__file__).resolve().parent.parent / "termdeck" / "static"
        cls.app_js = "\n".join(path.read_text() for path in sorted(static.glob("app*.js")))
        cls.index_html = (static / "index.html").read_text()
        cls.style_css = (static / "style.css").read_text()

    def test_both_model_fields_offer_a_suggestion_list(self) -> None:
        # A list the field is not bound to suggests nothing, and a list nothing fills is empty.
        for field, list_id in (("modal-model-name", "modal-model-ids"),
                               ("restart-modal-model", "restart-modal-model-ids")):
            self.assertRegex(self.index_html, rf'id="{field}"[^>]*list="{list_id}"')
            self.assertIn(f'<datalist id="{list_id}">', self.index_html)
            self.assertIn(f'fillModelSuggestionList("{list_id}"', self.app_js)

    def test_the_model_fields_stay_typable(self) -> None:
        # An <input list=...> is a suggestion; a <select> would only offer what the catalog knows.
        for field in ("modal-model-name", "restart-modal-model"):
            self.assertRegex(self.index_html, rf'<input id="{field}"')

    def test_both_dialogs_carry_the_animations_checkbox(self) -> None:
        for field in ("modal-disable-animations", "restart-modal-disable-animations"):
            self.assertIn(f'id="{field}" type="checkbox"', self.index_html)
            self.assertIn(f'this.$("{field}").checked', self.app_js)
            # Its row is hidden for agents with nothing to turn off, so the client has to hold the row.
            self.assertIn(f'this.$("{field}-field")', self.app_js)

    def test_both_dialogs_send_what_was_chosen(self) -> None:
        self.assertIn("disable_animations: disableAnimations", self.app_js)
        self.assertIn("model_name: options.modelName", self.app_js)

    def test_the_checkbox_rows_are_styled_in_both(self) -> None:
        self.assertIn("#restart-modal .modal-checkbox-label", self.style_css)


class DescriptionDrawerClosesOnAClickAwayTest(unittest.TestCase):
    """The description drawer sits over the terminal it describes, so a click anywhere else is someone
    going back to work and the drawer should get out of the way.

    Its own toggle has to be excluded, or the mousedown closes it and the click that follows reopens it,
    leaving a button that cannot put it away.

    tools/scroll-tests checks the behaviour in a real browser; this is the cheap guard that the drawer is
    still in the handler that every other panel closes from.
    """

    @classmethod
    def setUpClass(cls) -> None:
        static = Path(__file__).resolve().parent.parent / "termdeck" / "static"
        cls.app_js = (static / "app.js").read_text()

    def outside_click_handler(self) -> str:
        handler = re.search(r'document\.addEventListener\("mousedown".*?\n    \}\);', self.app_js, re.S)
        self.assertIsNotNone(handler, "the click-away handler was not found")
        return handler.group(0)

    def test_the_drawer_closes_from_the_click_away_handler(self) -> None:
        self.assertIn("closeSessionDescriptionEditor()", self.outside_click_handler())

    def test_a_click_inside_it_is_not_a_click_away(self) -> None:
        self.assertIn("descriptionDrawer.contains(e.target)", self.outside_click_handler())

    def test_its_own_toggle_is_left_to_do_the_toggling(self) -> None:
        self.assertIn('this.$("session-description-toggle")?.contains(e.target)', self.outside_click_handler())
