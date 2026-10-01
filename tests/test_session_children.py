"""A parent asks after its children in one call: who they are and how each is doing.

Children are the sessions filed under a session -- the spawned-agents stack the sidebar shows --
and each child's entry answers in the same shape as its own status call.
"""

import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from tests.test_session_route_names import registrations
from termdeck.models import SessionRecord
from termdeck.server import TermdeckServer
from termdeck.session_manager import ManagedSession, TerminalSessionManager


def record(session_id: str, spawned_by: str | None = None) -> SessionRecord:
    return SessionRecord(session_id=session_id, title=session_id, title_user_set=True, command="",
                         cwd="/tmp", agent_kind="none", agent_session_id=None,
                         created_at_est="2026-01-01T00:00:00", draft="", project="test",
                         spawned_by_session_id=spawned_by)


class ChildSessionIdsTest(unittest.TestCase):
    def test_lists_direct_children_only(self) -> None:
        manager = TerminalSessionManager.__new__(TerminalSessionManager)
        manager._sessions = {session_id: ManagedSession(record(session_id, spawned_by))
                             for session_id, spawned_by in
                             (("parent", None), ("child-a", "parent"), ("child-b", "parent"),
                              ("grandchild", "child-a"), ("sibling", None), ("niece", "sibling"))}

        self.assertEqual(manager.child_session_ids("parent"), ["child-a", "child-b"])

    def test_parent_without_children_lists_none(self) -> None:
        manager = TerminalSessionManager.__new__(TerminalSessionManager)
        manager._sessions = {"parent": ManagedSession(record("parent"))}

        self.assertEqual(manager.child_session_ids("parent"), [])


class ChildrenStatusApiTest(unittest.TestCase):
    def server(self, children: list[str]) -> TermdeckServer:
        server = TermdeckServer.__new__(TermdeckServer)
        server.manager = SimpleNamespace(has_session=lambda session_id: session_id == "parent",
                                         child_session_ids=lambda session_id: children)
        return server

    def test_each_child_answers_in_its_status_shape(self) -> None:
        server = self.server(["child-a", "child-b"])
        statuses = {"child-a": {"session_id": "child-a", "processing": True},
                    "child-b": {"session_id": "child-b", "processing": False}}
        with patch.object(TermdeckServer, "_session_status",
                          new=AsyncMock(side_effect=lambda session_id: statuses[session_id])) as status:
            payload = asyncio.run(server._session_children_status("parent"))

        self.assertEqual(payload, {"session_id": "parent",
                                   "children": [statuses["child-a"], statuses["child-b"]]})
        self.assertEqual([call.args[0] for call in status.await_args_list], ["child-a", "child-b"])

    def test_parent_without_children_answers_empty(self) -> None:
        server = self.server([])

        payload = asyncio.run(server._session_children_status("parent"))

        self.assertEqual(payload, {"session_id": "parent", "children": []})

    def test_unknown_parent_is_404(self) -> None:
        server = self.server(["child-a"])

        with self.assertRaises(HTTPException) as missing:
            asyncio.run(server._session_children_status("nope"))

        self.assertEqual(missing.exception.status_code, 404)

    def test_children_status_is_registered(self) -> None:
        self.assertEqual(registrations()[("/api/sessions/{session_id}/children/status", "GET")],
                         "_session_children_status")
