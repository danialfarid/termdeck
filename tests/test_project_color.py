import asyncio
import unittest
from unittest.mock import MagicMock

from termdeck.server import ProjectUiState, StoredValueRequest, TermdeckServer, UiSettings


class ProjectColorTest(unittest.TestCase):
    def server(self) -> TermdeckServer:
        class Store:
            def __init__(self) -> None:
                self.payload = UiSettings(project_state={"stock": ProjectUiState()}).model_dump()

            def load(self) -> dict[str, object]:
                return self.payload

            def save(self, payload: dict[str, object]) -> None:
                self.payload = payload

        server = TermdeckServer.__new__(TermdeckServer)
        server.settings_store = Store()
        server.manager = MagicMock()
        server.manager.list_sessions.return_value = []
        return server

    def test_a_project_has_no_colour_until_given_one(self) -> None:
        self.assertEqual(ProjectUiState().color, "")

    def test_a_colour_is_stored_under_the_project_or_worktree_it_was_set_on(self) -> None:
        server = self.server()

        asyncio.run(server._put_project_state_field(StoredValueRequest(value="#3b82f6"), "color",
                                                    project="stock", worktree_id="root"))
        asyncio.run(server._put_project_state_field(StoredValueRequest(value="#ef4444"), "color",
                                                    project="stock", worktree_id="wt-1"))

        states = server.settings_store.payload["project_state"]
        self.assertEqual(states["stock"]["color"], "#3b82f6")
        self.assertEqual(states["stock::worktree:wt-1"]["color"], "#ef4444")

    def test_clearing_the_colour_stores_an_empty_string(self) -> None:
        server = self.server()
        asyncio.run(server._put_project_state_field(StoredValueRequest(value="#3b82f6"), "color", project="stock", worktree_id="root"))

        asyncio.run(server._put_project_state_field(StoredValueRequest(value=""), "color", project="stock", worktree_id="root"))

        self.assertEqual(server.settings_store.payload["project_state"]["stock"]["color"], "")


if __name__ == "__main__":
    unittest.main()
