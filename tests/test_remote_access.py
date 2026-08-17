import asyncio
import json
import re
import unittest

from fastapi.testclient import TestClient

from remote_service.application import RemoteRelayApplication
from remote_service.auth import AuthenticatedUser
from remote_service.config import RemoteServiceConfig
from remote_service.token_store import MemoryConnectorTokenStore
from termdeck.remote_protocol import RemoteMessageCodec, RemoteMessageType


class FakeGoogleIdentityVerifier:
    async def verify(self, credential: str) -> AuthenticatedUser:
        if credential != "valid-google-id-token":
            raise ValueError("invalid Google token")
        return AuthenticatedUser(user_id="google-subject-1", email="user@example.com")


class RemoteAccessTest(unittest.TestCase):
    @staticmethod
    def config() -> RemoteServiceConfig:
        return RemoteServiceConfig(
            google_client_id="test.apps.googleusercontent.com", session_secret="s" * 64,
            public_url="http://testserver", firestore_project="", session_max_age_seconds=3600,
            connector_max_age_seconds=3600, pairing_max_age_seconds=600, relay_request_timeout_seconds=5,
            max_body_bytes=2_000_000, cookie_secure=False, connector_idle_seconds=5,
            browser_idle_seconds=600, anonymous_requests_per_hour=30)

    @staticmethod
    def login_csrf_token(login_html: str) -> str:
        config_match = re.search(r"const remoteLogin = (\{.*?\});", login_html, re.DOTALL)
        if config_match is None:
            raise AssertionError("login configuration is missing")
        return str(json.loads(config_match.group(1))["csrfToken"])

    def test_protocol_preserves_binary_terminal_output(self) -> None:
        encoded = RemoteMessageCodec.encode({"type": RemoteMessageType.WS_SERVER_BINARY,
                                             "channel_id": "channel", "body": b"\x00\x1b[31mtext"})
        decoded = RemoteMessageCodec.decode(encoded)
        self.assertEqual(decoded["body"], b"\x00\x1b[31mtext")

    def test_google_pairing_issues_connector_for_same_browser_identity(self) -> None:
        token_store = MemoryConnectorTokenStore()
        relay = RemoteRelayApplication(config=self.config(), token_store=token_store,
                                       identity_verifier=FakeGoogleIdentityVerifier())
        client = TestClient(relay.app)

        pairing = client.post("/_remote/api/pairings").json()
        login = client.get(f"/_remote/login?pair={pairing['pairing_id']}")
        self.assertEqual(login.status_code, 200)
        csrf_token = self.login_csrf_token(login.text)
        authentication = client.post("/_remote/auth/google", headers={"Origin": "http://testserver"}, json={
            "credential": "valid-google-id-token", "csrf_token": csrf_token,
            "pairing_id": pairing["pairing_id"], "return_to": "/p/project"})
        self.assertEqual(authentication.status_code, 200)
        self.assertEqual(authentication.json()["redirect"], "/p/project")

        pairing_result = client.post(f"/_remote/api/pairings/{pairing['pairing_id']}/result",
                                     json={"pairing_secret": pairing["pairing_secret"]})
        connector_token = pairing_result.json()["connector_token"]
        connector_user = relay.token_service.verify_connector(connector_token)
        self.assertEqual(connector_user, AuthenticatedUser(user_id="google-subject-1", email="user@example.com"))
        self.assertTrue(asyncio.run(token_store.matches("google-subject-1", relay.token_service.digest(connector_token))))

    def test_google_login_csrf_tokens_remain_valid_across_multiple_login_tabs(self) -> None:
        relay = RemoteRelayApplication(config=self.config(), token_store=MemoryConnectorTokenStore(),
                                       identity_verifier=FakeGoogleIdentityVerifier())
        client = TestClient(relay.app)
        first_token = self.login_csrf_token(client.get("/_remote/login").text)
        self.login_csrf_token(client.get("/_remote/login").text)
        authentication = client.post("/_remote/auth/google", headers={"Origin": "http://testserver"}, json={
            "credential": "valid-google-id-token", "csrf_token": first_token, "return_to": "/"})
        self.assertEqual(authentication.status_code, 200)

    def test_offline_browser_requests_an_on_demand_connector(self) -> None:
        token_store = MemoryConnectorTokenStore()
        relay = RemoteRelayApplication(config=self.config(), token_store=token_store,
                                       identity_verifier=FakeGoogleIdentityVerifier())
        user = AuthenticatedUser(user_id="google-subject-2", email="second@example.com")
        connector_token = relay.token_service.issue_connector(user)
        asyncio.run(token_store.save(user.user_id, user.email, relay.token_service.digest(connector_token)))
        client = TestClient(relay.app)
        client.cookies.set(relay.SESSION_COOKIE, relay.token_service.issue_session(user))

        status = client.get("/_remote/status")
        self.assertEqual(status.status_code, 200)
        self.assertEqual(status.json()["idle_seconds"], 600)

        idle_page = client.get("/_remote/idle?return_to=/p/project%3Ft%3Dterminal")
        self.assertEqual(idle_page.status_code, 200)
        self.assertIn('"returnTo": "/p/project?t=terminal"', idle_page.text)

        offline = client.get("/p/project")
        self.assertEqual(offline.status_code, 503)
        demand = client.post("/_remote/api/connectors/demand",
                             headers={"Authorization": f"Bearer {connector_token}"})
        self.assertEqual(demand.status_code, 200)
        self.assertTrue(demand.json()["connect"])


if __name__ == "__main__":
    unittest.main()
