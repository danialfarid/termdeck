"""Esc reaches an agent stuck behind a mode of its own, from the phone and before TermDeck types.

Codex's find-in-transcript hides its composer behind a footer ("ctrl+p older · ctrl+n newer · esc
latest"). A prompt typed then became a search, and a model change's "/model" and menu numbers went into
the search box, with nothing said. TermDeck now presses Esc once first when that footer is up, and says
why when Esc does not close it. The transcript's send menu also offers a single Esc at all times: on a
phone there is no terminal to press it in.
"""

import asyncio
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from termdeck import agents
from termdeck.server import TermdeckServer
from termdeck.session_manager import ManagedSession, TerminalSessionManager
from tests.test_terminal_lifecycle import record

FIND_FOOTER = (b"\x1b[2J\x1b[H\xe2\x96\xa0 Conversation interrupted\r\n"
               b"\x1b[40;1H     \xc2\xb7 ctrl+p older \xc2\xb7 ctrl+n newer \xc2\xb7 esc latest")
COMPOSER = b"\x1b[2J\x1b[H\xe2\x96\xa0 Conversation interrupted\r\n\x1b[38;1H\xe2\x80\xba Ask Codex to do anything"


def codex_session(screen: bytes) -> ManagedSession:
    session_record = record("codex-1")
    session_record.agent_kind = "codex"
    session_record.cols, session_record.rows = 105, 60
    ms = ManagedSession(session_record)
    ms.raw_replay_buffer = bytearray(screen)
    return ms


class FindModeDetectionTest(unittest.TestCase):
    def test_codex_find_footer_is_recognised(self) -> None:
        self.assertTrue(agents.agent_cli("codex").in_escapable_mode(codex_session(FIND_FOOTER)))

    def test_the_composer_is_not(self) -> None:
        self.assertFalse(agents.agent_cli("codex").in_escapable_mode(codex_session(COMPOSER)))

    def test_an_agent_without_such_a_mode_never_is(self) -> None:
        self.assertFalse(agents.agent_cli("claude").in_escapable_mode(codex_session(FIND_FOOTER)))


class LeaveModeTest(unittest.TestCase):
    def run_leave(self, screens: list[bytes]) -> tuple[str, list[str]]:
        """screens: what is on screen before, then after the Esc."""
        manager = TerminalSessionManager.__new__(TerminalSessionManager)
        ms = codex_session(screens[0])
        written: list[str] = []

        def write_input(session_id: str, data: str) -> None:
            written.append(data)
            ms.raw_replay_buffer = bytearray(screens[1])

        manager.write_input = write_input
        manager._wait_for_paste_to_settle = AsyncMock()
        reason = asyncio.run(manager._leave_escapable_mode(ms, agents.agent_cli("codex")))
        return reason, written

    def test_esc_closes_the_search_and_typing_goes_ahead(self) -> None:
        self.assertEqual(self.run_leave([FIND_FOOTER, COMPOSER]), ("", ["\x1b"]))

    def test_a_search_esc_does_not_close_is_reported_after_one_press(self) -> None:
        reason, written = self.run_leave([FIND_FOOTER, FIND_FOOTER])
        self.assertIn("press Esc in that terminal", reason)
        # Once only: a second Esc at an idle Codex composer arms its edit-previous-message.
        self.assertEqual(written, ["\x1b"])

    def test_nothing_is_pressed_at_the_composer(self) -> None:
        self.assertEqual(self.run_leave([COMPOSER, COMPOSER]), ("", []))


class ModelChangeTest(unittest.TestCase):
    def manager_with(self, ms: ManagedSession) -> tuple[TerminalSessionManager, list[str]]:
        manager = TerminalSessionManager.__new__(TerminalSessionManager)
        written: list[str] = []
        manager.ensure_session_running = lambda session_id: ms
        manager._processing_state = lambda session: False
        manager.write_input = lambda session_id, data: written.append(data)
        manager._write_agent_menu_input = lambda session, text: written.append(text)
        manager.set_draft = lambda session_id, text: None
        manager._wait_for_paste_to_settle = AsyncMock()
        return manager, written

    def test_a_search_that_will_not_close_stops_the_model_keys(self) -> None:
        manager, written = self.manager_with(codex_session(FIND_FOOTER))
        with patch("termdeck.session_manager.asyncio.sleep", AsyncMock()):
            with self.assertRaises(RuntimeError):
                asyncio.run(manager.change_codex_model("codex-1", 3, "medium"))
        self.assertEqual(written, ["\x1b"])

    def test_at_the_composer_the_model_keys_go_in_as_before(self) -> None:
        manager, written = self.manager_with(codex_session(COMPOSER))
        with patch("termdeck.session_manager.asyncio.sleep", AsyncMock()):
            asyncio.run(manager.change_codex_model("codex-1", 3, "medium"))
        self.assertEqual(written, ["\x15/model", "\r", "3", "2"])


class EscapeEndpointTest(unittest.TestCase):
    def test_it_sends_exactly_one_esc(self) -> None:
        server = TermdeckServer.__new__(TermdeckServer)
        server.manager = MagicMock()
        server.manager.has_session.return_value = True
        server.manager.session_summary_by_id.return_value = {"session_id": "s1"}
        asyncio.run(server._escape_session("s1"))
        server.manager.write_input.assert_called_once_with("s1", "\x1b")

    def test_the_send_menu_always_offers_it(self) -> None:
        html = (Path(__file__).resolve().parent.parent / "termdeck" / "static" / "index.html").read_text()
        line = next(line for line in html.splitlines() if 'id="history-escape"' in line)
        self.assertNotIn('class="hidden"', line)


if __name__ == "__main__":
    unittest.main()
