"""The group header: the name gets the width, everything else gets out of its way.

A group's row carried a full-size chevron, a dot and a count side by side, and its two buttons at
opposite ends of a gap -- so the name, the one thing worth reading there, was squeezed between them.
"""

import re
import unittest
from pathlib import Path

STATIC = Path(__file__).resolve().parent.parent / "termdeck" / "static"


class GroupHeaderLayoutTest(unittest.TestCase):
    def setUp(self) -> None:
        self.css = (STATIC / "style.css").read_text()
        self.js = (STATIC / "app_search_git.js").read_text()

    def rule(self, selector: str, last: bool = True) -> str:
        matches = re.findall(rf"(?:^|\n)\s*{re.escape(selector)} \{{([^}}]*)\}}", self.css)
        self.assertTrue(matches, selector)
        # The scaled rules come last and are the ones in effect; the plain ones above are the fallback.
        return matches[-1] if last else matches[0]

    def scaled(self, rule: str, property_name: str) -> float:
        value = re.search(rf"{property_name}:\s*calc\(([\d.]+)px", rule)
        self.assertIsNotNone(value, f"{property_name} in {rule}")
        return float(value.group(1))

    def test_the_chevron_is_smaller_than_the_row_s_other_icons(self) -> None:
        # It is a hinge, not a label: the name is what the row is for.
        self.assertIn("terminal-group-chevron", self.js)
        chevron = self.rule(".terminal-group-chevron.codicon")

        self.assertLess(self.scaled(chevron, "font-size"), 8)
        # And a pixel further out than the row would put it, toward the edge rather than the name.
        self.assertRegex(chevron, r"margin-left:\s*calc\(-[\d.]+px")
        self.assertNotIn("margin-right", chevron)

    def test_the_name_starts_near_the_edge(self) -> None:
        label = self.rule(".terminal-group-label")
        padding = re.search(r"padding:\s*([^;]+);", label).group(1)
        sides = re.findall(r"calc\(([\d.]+)px", padding)

        self.assertEqual(len(sides), 4, "a left of its own, smaller than the right")
        self.assertLess(float(sides[3]), float(sides[1]))

    def test_the_count_stands_alone_and_says_what_it_is_by_its_colour(self) -> None:
        # The number says how many terminals want you; a dot beside it said the same thing again, in
        # the width the name wanted.
        attention = self.rule(".group-attention")

        self.assertIn("color: var(--accent)", attention)
        self.assertNotIn("group-unread-dot", self.css)
        self.assertNotIn("group-unread-dot", self.js)

    def test_a_terminal_waiting_to_be_let_through_is_counted(self) -> None:
        # It was what lit the dot, and with the dot gone it would go unmentioned on a shut group.
        counted = re.search(r"const attentionCount = members\.filter\((.*?)\)\.length;", self.js, re.S).group(1)

        self.assertIn("attentionSessions.has(session.session_id)", counted)

    def test_the_two_buttons_of_the_row_sit_together(self) -> None:
        search = self.rule(".terminal-group-search")

        self.assertRegex(search, r"margin-right:\s*calc\(-[\d.]+px")

    def test_the_buttons_leave_more_of_the_row_than_they_take(self) -> None:
        search = self.rule(".terminal-group-search")
        add = self.rule(".terminal-group-add")

        for rule in (search, add):
            self.assertLessEqual(self.scaled(rule, "width"), 22)


if __name__ == "__main__":
    unittest.main()
