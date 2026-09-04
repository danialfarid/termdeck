import asyncio
import json
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, call

from starlette.websockets import WebSocketDisconnect

from termdeck.lsp_service import LanguageServerManager
from termdeck.server import TermdeckServer


class LspReadOnlyTest(unittest.TestCase):
    def test_server_workspace_edits_are_rejected_in_read_only_mode(self) -> None:
        workspace_edits = MagicMock()
        manager = LanguageServerManager(MagicMock(), workspace_edits, read_only_provider=lambda: True)

        result = asyncio.run(manager._apply_workspace_edit(Path("/tmp"), {}))

        self.assertFalse(result["applied"])
        self.assertEqual(result["changed"], [])
        workspace_edits.apply.assert_not_called()

    def test_read_only_lsp_websocket_allows_queries_and_rejects_mutations(self) -> None:
        connection = MagicMock()
        connection.server_name = "fake-lsp"
        connection.capabilities = {}
        connection.subscribe.return_value = asyncio.Queue()
        connection.open_document = AsyncMock()
        connection.save_document = AsyncMock()
        connection.request = AsyncMock(return_value={"contents": "safe"})

        language_servers = MagicMock()
        language_servers.open_document = AsyncMock(return_value=(connection, "file:///tmp/example.py"))
        language_servers.close_document = AsyncMock()
        language_servers.enabled.return_value = True

        websocket = MagicMock()
        websocket.scope = {"state": {"termdeck_read_only": True}}
        websocket.query_params = {}
        websocket.accept = AsyncMock()
        websocket.send_text = AsyncMock()
        websocket.receive_text = AsyncMock(side_effect=[
            json.dumps({"type": "open", "text": "pass\n"}),
            json.dumps({"type": "save", "text": "changed\n"}),
            json.dumps({"type": "request", "requestId": 7, "method": "workspace/executeCommand", "params": {}}),
            json.dumps({"type": "request", "requestId": 8, "method": "custom/mutate", "params": {}}),
            json.dumps({"type": "request", "requestId": 9, "method": "textDocument/hover", "params": {}}),
            WebSocketDisconnect(),
        ])
        server = TermdeckServer.__new__(TermdeckServer)
        server.language_servers = language_servers

        asyncio.run(server._ws_lsp(websocket))

        connection.save_document.assert_not_awaited()
        connection.request.assert_awaited_once_with("textDocument/hover", {})
        sent_messages = [json.loads(sent.args[0]) for sent in websocket.send_text.await_args_list]
        self.assertEqual([message["requestId"] for message in sent_messages if message.get("error")], [7, 8])
        self.assertIn(call("textDocument/hover", {}), connection.request.await_args_list)
        language_servers.close_document.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
