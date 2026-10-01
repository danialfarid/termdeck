import unittest
from pathlib import Path


class UpdateNoticeLayoutTest(unittest.TestCase):
    """The expanded update notice keeps its controls where they belong.

    The install panel stretches the notice to full width, which used to leave the
    dismiss button floating right after the version text and the Run update button
    flush against the command and output boxes.
    """

    @classmethod
    def setUpClass(cls) -> None:
        static = Path(__file__).resolve().parent.parent / "termdeck" / "static"
        cls.css = (static / "style.css").read_text()

    def test_link_stretches_so_close_stays_top_right(self) -> None:
        self.assertIn("#update-notice a { flex: 1;", self.css)

    def test_run_button_has_breathing_room(self) -> None:
        self.assertIn("#update-install-run { margin: 10px 0; }", self.css)
