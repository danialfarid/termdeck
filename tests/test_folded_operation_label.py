"""What a folded block of operations says it is doing.

A run of tool calls folds into "12 Thinking", which says how busy the agent has been and
nothing about what with. An agent that writes a line before it starts says it itself; one that goes
straight to work says nothing, and a column of folded blocks reads as a row of identical lids.
"""

import json
import re
import unittest
from pathlib import Path

from termdeck.transcript_turns import TurnBuilder


def tool(title: str, value: object) -> dict[str, object]:
    return TurnBuilder.tool_event(title, value)


def result(text: str) -> dict[str, object]:
    return TurnBuilder.turn("event", text, "result", "Result")


class FoldedOperationLabelTest(unittest.TestCase):
    def fold(self, turns: list[dict[str, object]]) -> dict[str, object]:
        collapsed = TurnBuilder.collapse_thinking_events(turns + [TurnBuilder.turn("assistant", "done")])
        return next(turn for turn in collapsed if turn.get("kind") == "thinking")

    def test_the_newest_operation_is_on_the_lid(self) -> None:
        folded = self.fold([tool("Read", {"file_path": "/repo/app.js"}), result("ok"),
                            tool("Bash", {"command": "pytest -q", "description": "Run the tests"}), result("ok")])

        self.assertEqual(folded["latest"], "Bash Run the tests")

    def test_it_says_what_the_command_was_when_nothing_describes_it(self) -> None:
        folded = self.fold([tool("Bash", {"command": "pytest -q"}), result("ok"),
                            tool("Bash", {"command": "ruff check ."}), result("ok")])

        self.assertEqual(folded["latest"], "Bash ruff check .")

    def test_a_file_is_answer_enough_for_a_tool_that_takes_one(self) -> None:
        # A code edit is not in here at all: it renders as its own block, with its own summary.
        folded = self.fold([tool("Grep", {"pattern": "notebook"}), result("ok"),
                            tool("Read", {"file_path": "/repo/style.css"}), result("ok")])

        self.assertEqual(folded["latest"], "Read /repo/style.css")

    def test_the_lid_never_carries_a_paragraph(self) -> None:
        folded = self.fold([tool("Bash", {"command": "echo " + "x" * 400}), result("ok"),
                            tool("Bash", {"command": "echo " + "y" * 400}), result("ok")])

        self.assertLessEqual(len(str(folded["latest"])), TurnBuilder.LATEST_OPERATION_CHARS + len("Bash "))
        self.assertTrue(str(folded["latest"]).endswith("…"))

    def test_only_the_first_line_of_a_long_command(self) -> None:
        folded = self.fold([tool("Bash", {"command": "cd /repo\npytest -q\nruff check ."}), result("ok"),
                            tool("Bash", {"command": "cd /repo && ls\nsecond line"}), result("ok")])

        self.assertEqual(folded["latest"], "Bash cd /repo && ls")

    def test_a_result_is_not_what_the_agent_is_doing(self) -> None:
        # Results come back after the fact; the question is what it went off to do.
        folded = self.fold([tool("Bash", {"command": "pytest -q"}), result("ok"), result("also ok")])

        self.assertEqual(folded["latest"], "Bash pytest -q")

    def test_the_operations_themselves_are_untouched(self) -> None:
        turns = [tool("Bash", {"command": "pytest -q"}), result("ok"), tool("Read", {"file_path": "/x"}), result("ok")]

        folded = self.fold(turns)

        self.assertEqual(len(folded["items"]), 4)
        self.assertEqual(folded["title"], "4 Thinking")

    def test_the_lid_spends_no_width_on_the_word_operations(self) -> None:
        # It wrapped to a second line on a phone, for a word that says nothing the number does not.
        folded = self.fold([tool("Bash", {"command": "pytest -q"}), result("ok")])

        self.assertEqual(folded["title"], "2 Thinking")
        self.assertNotIn("operation", str(folded["title"]))


class ShippedSummaryTest(unittest.TestCase):
    """The client builds the lid from the items it has, so it says it in its own code."""

    def setUp(self) -> None:
        source = (Path(__file__).resolve().parent.parent / "termdeck" / "static" / "app_markdown_files.js").read_text()
        match = re.search(r'thinkingCount\.className = "history-thinking-count";(.{0,240}?)summary\.append\(([^)]*)\)',
                          source, re.S)
        self.assertIsNotNone(match, "the thinking summary moved")
        self.count_text, self.appended = match.group(1), match.group(2)

    def test_the_count_carries_no_wording(self) -> None:
        self.assertNotIn("operation", self.count_text)

    def test_the_count_comes_before_the_word(self) -> None:
        self.assertEqual([part.strip() for part in self.appended.split(",")], ["thinkingCount", "thinkingTitle"])

    def test_a_block_with_a_preview_puts_it_on_the_lid(self) -> None:
        # Every other kind of event -- a result above all -- writes its own title and would drop the
        # preview on the floor without this.
        source = (Path(__file__).resolve().parent.parent / "termdeck" / "static" / "app_markdown_files.js").read_text()
        match = re.search(r"summary\.textContent = turn\.kind === \"edit\"(.{0,700}?)\n        \}", source, re.S)
        self.assertIsNotNone(match, "the event summary moved")

        self.assertIn("if (turn.preview)", match.group(1))
        self.assertIn("summary.append(preview)", match.group(1))


class ResultPreviewTest(unittest.TestCase):
    """A shut block called "Result" says only that something came back."""

    def test_a_result_carries_its_first_line(self) -> None:
        turn = result("The file /repo/style.css has been updated successfully.\nnothing else matters here")

        self.assertEqual(turn["preview"], "The file /repo/style.css has been updated successfully.")

    def test_a_long_path_is_cut_to_the_end_that_tells_two_apart(self) -> None:
        # The whole lid went on the part every line shares, and two results read identically.
        turn = result("The file /Users/someone/work/project/termdeck/transcript_turns.py has been updated.")

        self.assertEqual(turn["preview"], "The file …/termdeck/transcript_turns.py has been updated.")

    def test_a_tool_says_what_it_was_given(self) -> None:
        self.assertEqual(tool("Bash", {"command": "pytest -q"})["preview"], "Bash pytest -q".split(" ", 1)[1])

    def test_nothing_came_back_is_no_preview(self) -> None:
        self.assertNotIn("preview", result("   "))

    def test_a_message_has_no_lid_to_write_on(self) -> None:
        self.assertNotIn("preview", TurnBuilder.turn("assistant", "I will start with the parser."))

    def test_a_code_edit_keeps_its_own_summary(self) -> None:
        # Edits say which files changed and by how much; a first line of diff would say less.
        edit = tool("Edit", {"file_path": "/repo/app.js", "old_string": "a", "new_string": "b"})

        self.assertEqual(edit["kind"], "edit")
        self.assertNotIn("preview", edit)

    def test_the_preview_is_one_line_long_at_most(self) -> None:
        turn = result("x" * 400)

        self.assertLessEqual(len(str(turn["preview"])), TurnBuilder.LATEST_OPERATION_CHARS)
        self.assertTrue(str(turn["preview"]).endswith("…"))


class OperationDetailTest(unittest.TestCase):
    def test_the_first_line_of_plain_text(self) -> None:
        self.assertEqual(TurnBuilder.operation_detail("run the thing\nthen the other"), "run the thing")

    def test_anything_at_all_rather_than_a_brace(self) -> None:
        # A tool's input is written as JSON, so the first line of it is "{" -- which is what the lid
        # said before, for every operation there has ever been.
        self.assertEqual(TurnBuilder.operation_detail(json.dumps({"unheard_of_key": "the answer"})), "the answer")

    def test_nothing_to_say_is_nothing(self) -> None:
        self.assertEqual(TurnBuilder.operation_detail("{}"), "")
        self.assertEqual(TurnBuilder.operation_detail(""), "")

    def test_broken_json_still_gives_a_line(self) -> None:
        self.assertEqual(TurnBuilder.operation_detail("{\n  not json at all\n}"), "not json at all")


if __name__ == "__main__":
    unittest.main()
