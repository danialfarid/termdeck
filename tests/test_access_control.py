import asyncio
import unittest
from unittest.mock import AsyncMock, MagicMock

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.testclient import TestClient

from termdeck.access_control import DirectAccessMiddleware, DirectAccessPolicy
from termdeck.remote_connector import RemoteConnector
from termdeck.server import TermdeckServer


class DirectAccessControlTest(unittest.TestCase):
    @staticmethod
    def client(token: str = "", read_only: bool = False) -> TestClient:
        policy = DirectAccessPolicy(token, read_only)
        app = FastAPI()
        app.add_middleware(DirectAccessMiddleware, policy=policy)
        app.add_api_route("/page", lambda: {"ok": True}, methods=["GET"])
        app.add_api_route("/change", lambda: {"changed": True}, methods=["POST"])

        async def websocket_status(websocket: WebSocket) -> None:
            await websocket.accept()
            await websocket.send_json({"read_only": websocket.scope["state"]["termdeck_read_only"]})

        app.add_api_websocket_route("/ws", websocket_status)
        return TestClient(app)

    def test_bearer_token_protects_http_and_websocket_routes(self) -> None:
        client = self.client("secret-token")

        self.assertEqual(client.get("/page").status_code, 401)
        self.assertEqual(client.get("/page", headers={"Accept": "text/html"}, follow_redirects=False).status_code, 303)
        self.assertEqual(client.get("/page", headers={"Authorization": "Bearer secret-token"}).json(), {"ok": True})
        with client.websocket_connect("/ws", headers={"Authorization": "Bearer secret-token"}) as websocket:
            self.assertEqual(websocket.receive_json(), {"read_only": False})

    def test_browser_session_cookie_is_derived_from_token(self) -> None:
        policy = DirectAccessPolicy("secret-token", False)
        client = self.client("secret-token")
        client.cookies.set(policy.COOKIE_NAME, policy.browser_session)

        self.assertEqual(client.get("/page").json(), {"ok": True})
        self.assertNotEqual(policy.browser_session, "secret-token")

    def test_read_only_mode_blocks_http_mutations_and_marks_websockets(self) -> None:
        client = self.client(read_only=True)

        self.assertEqual(client.get("/page").status_code, 200)
        self.assertEqual(client.post("/change").status_code, 403)
        with client.websocket_connect("/ws") as websocket:
            self.assertEqual(websocket.receive_json(), {"read_only": True})

    def test_remote_connector_injects_local_access_token(self) -> None:
        connector = RemoteConnector("https://relay.example", "connector", "http://127.0.0.1:8530", 1, 2, 3,
                                    local_access_token="local-secret")
        headers = connector._local_request_headers([("Authorization", "Bearer remote-browser"), ("X-Test", "yes")])

        self.assertEqual(headers, [("X-Test", "yes"), ("Authorization", "Bearer local-secret")])
        asyncio.run(connector.stop())

    def test_read_only_terminal_websocket_discards_client_input(self) -> None:
        server = TermdeckServer.__new__(TermdeckServer)
        server.manager = MagicMock()
        websocket = MagicMock()
        websocket.receive_text = AsyncMock(side_effect=['{"type":"input","data":"rm file"}', WebSocketDisconnect()])

        asyncio.run(server._pump_client_to_pty(websocket, "session", read_only=True))

        server.manager.write_input.assert_not_called()


if __name__ == "__main__":
    unittest.main()
