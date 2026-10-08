"""A whole-settings save never writes the side panel.

Every change to the side panel -- a terminal moved four places up, a group dropped before another, a
pin, an unread mark -- is its own request on its own API. The one way left to write the panel whole
was a full settings replace: it took the incoming layout and order as they came and only put back
entries missing from them, so a page holding an older copy put its old order back over the new one.
Project state now arrives only through the APIs that change one thing at a time.
"""

import asyncio
import unittest
from unittest.mock import MagicMock

from termdeck.server import ProjectUiState, TermdeckServer, UiSettings


class Store:
    def __init__(self, payload: dict[str, object]) -> None:
        self.payload = payload

    def load(self) -> dict[str, object]:
        return self.payload

    def save(self, payload: dict[str, object]) -> None:
        self.payload = payload


class WholeSettingsReplaceTest(unittest.TestCase):
    def server(self) -> TermdeckServer:
        server = TermdeckServer.__new__(TermdeckServer)
        server.settings_store = Store(UiSettings(sidebar_width=250, project_state={
            "stock": ProjectUiState(terminal_layout=["group:a", "group:b", "session:c"],
                                    session_order=["c", "d"], pinned_sessions=["c"]),
        }).model_dump())
        server.manager = MagicMock()
        server.manager.list_sessions.return_value = [{"session_id": "c", "project": "stock"},
                                                     {"session_id": "d", "project": "stock"}]
        return server

    def stale_copy(self) -> UiSettings:
        # What a page loaded before the last move holds: the old order, and a setting it really changed.
        return UiSettings(sidebar_width=310, project_state={
            "stock": ProjectUiState(terminal_layout=["session:c", "group:b", "group:a"],
                                    session_order=["d", "c"], pinned_sessions=[]),
        })

    def test_a_stale_copy_does_not_reorder_the_panel(self) -> None:
        server = self.server()

        asyncio.run(server._put_settings(self.stale_copy()))

        stock = server.settings_store.payload["project_state"]["stock"]
        self.assertEqual(stock["terminal_layout"], ["group:a", "group:b", "session:c"])
        self.assertEqual(stock["session_order"], ["c", "d"])

    def test_a_stale_copy_does_not_unpin(self) -> None:
        server = self.server()

        asyncio.run(server._put_settings(self.stale_copy()))

        self.assertEqual(server.settings_store.payload["project_state"]["stock"]["pinned_sessions"], ["c"])

    def test_the_settings_themselves_are_still_saved(self) -> None:
        server = self.server()

        asyncio.run(server._put_settings(self.stale_copy()))

        self.assertEqual(server.settings_store.payload["sidebar_width"], 310)

    def test_a_project_the_copy_does_not_mention_is_kept(self) -> None:
        server = self.server()

        asyncio.run(server._put_settings(UiSettings(sidebar_width=310)))

        self.assertEqual(server.settings_store.payload["project_state"]["stock"]["session_order"], ["c", "d"])


if __name__ == "__main__":
    unittest.main()
