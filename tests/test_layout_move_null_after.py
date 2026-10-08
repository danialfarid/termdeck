"""A layout move from an older page is taken, not refused.

Pages built before the client was fixed send `after: null` when a group is dropped before another
group's label. The server refused it, the page reloaded the order it had just changed, and the group
snapped back a second after it moved -- on every tab left open since, until each was reloaded.
"""

import unittest

from pydantic import ValidationError

from termdeck.server import TerminalLayoutMoveRequest


class NullAfterTest(unittest.TestCase):
    def test_null_after_is_a_drop_before(self) -> None:
        move = TerminalLayoutMoveRequest(token="group:a", target_token="group:b", after=None)

        self.assertIs(move.after, False)

    def test_null_to_top_is_not_to_top(self) -> None:
        self.assertIs(TerminalLayoutMoveRequest(token="group:a", to_top=None).to_top, False)

    def test_an_explicit_after_is_kept(self) -> None:
        self.assertIs(TerminalLayoutMoveRequest(token="group:a", target_token="group:b", after=True).after, True)

    def test_something_that_is_not_a_boolean_at_all_is_still_refused(self) -> None:
        with self.assertRaises(ValidationError):
            TerminalLayoutMoveRequest(token="group:a", target_token="group:b", after="sideways")


if __name__ == "__main__":
    unittest.main()
