"""What a folded block of operations says it is doing.

A run of tool calls folds into "Thinking · 12 operations", which says how busy the agent has been and
nothing about what with. An agent that writes a line before it starts says it itself; one that goes
straight to work says nothing, and a column of folded blocks reads as a row of identical lids.
"""

import json
import unittest

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
        self.assertEqual(folded["title"], "Thinking · 4 operations")


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
