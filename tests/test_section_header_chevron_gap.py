"""The collapsible section headers give their chevron breathing room.

The open-files, recently-modified, and closed-terminals headers pack a 20px chevron box directly
against the label text (gap 0, 10px label padding): the arrow reads as too far right, nearly
touching the words. The header pulls its left padding in and puts an explicit gap between the
arrow box and the text, so the arrow sits left with air on both sides while the text stays put.
"""

import re
import unittest
from pathlib import Path

from tests.test_terminal_cycle_order import method_source

STATIC = Path(__file__).resolve().parent.parent / "termdeck" / "static"


class SectionHeaderChevronGapTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.css = (STATIC / "style.css").read_text()
        match = re.search(r"\.collapsible-section-header \{([^}]*)\}", cls.css)
        assert match is not None, ".collapsible-section-header rule missing from style.css"
        cls.rule = match.group(1)
        app_js = (STATIC / "app.js").read_text()
        cls.label_method = method_source(app_js, "collapsibleSectionLabel(text, field, extra = null)")

    def test_the_arrow_box_is_separated_from_the_text(self) -> None:
        match = re.search(r"(?<!-)gap: (\d+)px", self.rule)
        self.assertIsNotNone(match, "no gap between the chevron and the label text")
        assert match is not None
        self.assertEqual(int(match.group(1)), 4)

    def test_the_header_pulls_in_from_the_base_label_padding(self) -> None:
        base = re.search(r"\.side-section-label \{([^}]*)\}", self.css)
        assert base is not None
        base_pad = re.search(r"padding: [\d.]+px ([\d.]+)px", base.group(1))
        assert base_pad is not None
        match = re.search(r"padding-left: (\d+)px", self.rule)
        self.assertIsNotNone(match, "no padding-left override on the collapsible header")
        assert match is not None
        self.assertLess(int(match.group(1)), int(float(base_pad.group(1))))
        self.assertEqual(int(match.group(1)), 2)

    def test_expanding_rotates_one_chevron_instead_of_swapping_glyphs(self) -> None:
        # chevron-right and chevron-down have different ink (10px vs 18px wide), so swapping them
        # on expand visibly jumped the arrow sideways. One glyph plus a quarter turn cannot shift.
        self.assertNotIn("chevron-down", self.label_method)
        self.assertIn('" open"', self.label_method)
        turned = re.search(r"\.section-collapse-toggle\.open \.codicon \{([^}]*)\}", self.css)
        self.assertIsNotNone(turned, "no rotation rule for the expanded chevron")
        assert turned is not None
        self.assertIn("rotate(90deg)", turned.group(1))

    def test_the_closed_header_shares_the_collapsible_gap(self) -> None:
        # Its own gap: 0 packed the label against the arrow box while the other two headers breathe.
        closed = re.search(r"\.closed-header \{([^}]*)\}", self.css)
        assert closed is not None
        self.assertNotIn("gap", closed.group(1))

    def test_the_expanded_closed_chevron_holds_its_collapsed_center(self) -> None:
        # Rotating the 20px span lands the opened ink a pixel right of the closed ink (measured
        # 23.5 vs 25.5 device px); the nudge pulls it back without moving the label text.
        turned = re.search(r"\.closed-chevron\.open \{([^}]*)\}", self.css)
        self.assertIsNotNone(turned, "no rule for the expanded closed chevron")
        assert turned is not None
        self.assertIn("rotate(90deg)", turned.group(1))
        self.assertIn("left: -1px", turned.group(1))


if __name__ == "__main__":
    unittest.main()
