"""Stopping an agent takes repetition: one Escape is often swallowed, while two in quick
succession read as a double-press with its own meaning. Interrupting presses the agent's stop
key three times with a pause between them; the terminal itself is untouched.
"""

import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, call, patch

from termdeck.server import TermdeckServer


class InterruptPressesTest(unittest.IsolatedAsyncioTestCase):
    def server(self) -> tuple[TermdeckServer, list[str]]:
        server = TermdeckServer.__new__(TermdeckServer)
        written: list[str] = []
        server.manager = SimpleNamespace(
            has_session=lambda session_id: session_id == "s1",
            ensure_session_running=lambda session_id: None,
            session_summary_by_id=lambda session_id: {"session_id": session_id, "agent_kind": "codex"},
            write_input=lambda session_id, text: written.append(text),
        )
        return server, written

    async def test_interrupt_presses_thrice_with_pauses(self) -> None:
        server, written = self.server()

        with patch("termdeck.server.asyncio.sleep", new=AsyncMock()) as slept:
            response = await server._interrupt_session("s1")

        self.assertEqual(written, ["\x1b", "\x1b", "\x1b"])
        self.assertEqual(slept.call_args_list, [call(0.75), call(0.75)])
        self.assertEqual(response["session_id"], "s1")

    async def test_unknown_session_is_404(self) -> None:
        from fastapi import HTTPException
        server, _written = self.server()

        with self.assertRaises(HTTPException) as missing:
            await server._interrupt_session("nope")

        self.assertEqual(missing.exception.status_code, 404)
