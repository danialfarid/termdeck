import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from termdeck.config import TermdeckConfig
from termdeck.server import TermdeckServer
from termdeck.session_manager import TerminalSessionManager


class TerminalDebugPreviewTest(unittest.TestCase):
    def test_debug_subscription_reads_replay_without_starting_or_repainting(self) -> None:
        manager = object.__new__(TerminalSessionManager)
        session = SimpleNamespace(record=SimpleNamespace(agent_kind="codex"), client_queues=set(),
                                  lazy_start_pending=True, cold_attach_repaint_done=False)
        manager._sessions = {"test": session}
        manager.replay = Mock()
        manager.replay.raw_bytes.return_value = b"saved screen"
        manager.replay.ends_inside_sync_update.return_value = False
        manager._spawn = Mock(side_effect=AssertionError("must not spawn"))
        manager._schedule_screen_repaint = Mock(side_effect=AssertionError("must not repaint"))
        replay, queue = manager.attach_debug_client("test")
        self.assertEqual(replay, b"saved screen")
        self.assertIn(queue, session.client_queues)
        self.assertTrue(session.lazy_start_pending)
        self.assertFalse(session.cold_attach_repaint_done)
        manager.detach_client("test", queue)
        self.assertFalse(session.client_queues)

    def test_debug_subscription_closes_an_incomplete_sync_frame(self) -> None:
        manager = object.__new__(TerminalSessionManager)
        manager._sessions = {"test": SimpleNamespace(record=SimpleNamespace(agent_kind="codex"), client_queues=set())}
        manager.replay = Mock()
        manager.replay.raw_bytes.return_value = TermdeckConfig.SYNC_UPDATE_START + b"screen"
        manager.replay.ends_inside_sync_update.return_value = True
        replay, _ = manager.attach_debug_client("test")
        self.assertTrue(replay.endswith(TermdeckConfig.SYNC_UPDATE_END))

    def test_debug_socket_is_read_only_and_can_inspect_a_dormant_session(self) -> None:
        server = object.__new__(TermdeckServer)
        server.manager = Mock()
        server.manager.has_session.return_value = True
        server.manager.session_summary_by_id.return_value = {"cols": 101, "rows": 200, "running": False, "dormant": True}
        server.manager.attach_debug_client.return_value = (b"saved screen", asyncio.Queue())
        server.manager.session_draft.return_value = ""
        server.manager.session_draft_revision.return_value = 0
        app = FastAPI()
        app.websocket("/ws/{session_id}/debug")(server._ws_terminal_debug)
        with TestClient(app) as client:
            with client.websocket_connect("/ws/test/debug") as websocket:
                self.assertEqual(websocket.receive_json(), {"type": "debug_geometry", "cols": 101, "rows": 200, "running": False})
                self.assertEqual(websocket.receive_bytes(), b"saved screen")
                websocket.receive_json()
                self.assertEqual(websocket.receive_json(), {"type": "access_mode", "read_only": True})
                websocket.send_json({"type": "input", "data": "dangerous command\r"})
                websocket.send_json({"type": "repaint"})
                websocket.send_json({"type": "resize", "cols": 40, "rows": 10})
                self.assertEqual(websocket.receive_json(), {"type": "resize_rejected", "cols": 101, "rows": 200})
        server.manager.attach_client.assert_not_called()
        server.manager.ensure_session_running.assert_not_called()
        server.manager.write_user_input.assert_not_called()
        server.manager.request_screen_repaint.assert_not_called()
        server.manager.resize.assert_not_called()
        server.manager.detach_client.assert_called_once()
