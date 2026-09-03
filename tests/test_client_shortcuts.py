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
