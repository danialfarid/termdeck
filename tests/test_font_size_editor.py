import re
import unittest
from pathlib import Path


class FontSizeEditorTest(unittest.TestCase):
    """One font-size editor: the adjust panel. Visualize is gone.

    The in-place overlay editor (Visualize) was removed in favor of the single
    adjust panel, which already had everything it did: per-size +/-, slider,
    per-size reset, live apply, and reset-all. This pins the removal so the
    overlay cannot come back piecemeal, and pins the row's two controls.
    """

    @classmethod
    def setUpClass(cls) -> None:
        root = Path(__file__).resolve().parent.parent
        cls.client = "\n".join(
            path.read_text()
            for path in sorted((root / "termdeck" / "static").glob("app*.js")))
        cls.css = (root / "termdeck" / "static" / "style.css").read_text()
        cls.server = (root / "termdeck" / "server.py").read_text()

    def test_no_visualize_references_remain(self) -> None:
        for name, text in (("client", self.client), ("style", self.css),
                           ("server", self.server)):
            leftovers = re.findall(r"InlineSize|inline-size|inlineSize|inline_size_controls"
                                   r"|[Vv]isualize", text)
            self.assertEqual(leftovers, [], f"Visualize leftovers in {name}: {leftovers}")

    def test_row_offers_adjust_and_reset_only(self) -> None:
        self.assertIn('samples.textContent = "adjust";', self.client)
        self.assertIn("controls.append(samples, reset);", self.client)

    def test_size_table_is_shared_by_name(self) -> None:
        self.assertIn("const FONT_SIZE_SETTING_DEFINITIONS = [", self.client)
