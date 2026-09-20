"""Pairing again has to put the connector on the new token.

The relay can stop accepting a computer's connector token -- revoked, or rotated on its side -- and the
answer offered is to pair again. Pairing saved the new token and asked for a connector, but the one
already running was left alone, and it holds the token the relay has just replaced. So the relay accepted
the computer while the deck went on presenting the old token and being refused, and the phone waited for
a computer that was right there.
"""

import json
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

from termdeck.remote_access import RemoteAccessManager, RemotePairingState
from termdeck.remote_credentials import RemoteCredentialStore


class FakeResponse:
    def __init__(self, payload: dict) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict:
        return self._payload


class PairingRestartsTheConnectorTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        store = RemoteCredentialStore(Path(self.directory.name) / "remote-credentials.json")
        self.manager = RemoteAccessManager(
            relay_url="https://relay.example", public_url="https://remote.example",
            local_url="http://127.0.0.1:8530", credential_store=store, pair_poll_seconds=0,
            pair_timeout_seconds=5, reconnect_min_seconds=0, reconnect_max_seconds=0,
            http_timeout_seconds=1, demand_poll_seconds=0)
        self.manager.pairing_state = RemotePairingState(pairing_id="pair-1", pairing_secret="secret",
                                                        login_url="https://remote.example/login",
                                                        started_monotonic=time.monotonic())
        self.manager._http_client = SimpleNamespace(post=self.pairing_result)
        self.started_tokens: list[str] = []
        self.stopped = 0
        start = patch.object(RemoteAccessManager, "_start_connector",
                             lambda manager, credentials: self.started_tokens.append(credentials.connector_token))
        start.start()
        self.addCleanup(start.stop)

    async def pairing_result(self, url: str, **kwargs) -> FakeResponse:
        return FakeResponse({"state": "complete", "connector_token": "fresh-token", "email": "dan@example.com"})

    async def stop_connector(self) -> None:
        self.stopped += 1

    def stored_token(self) -> str:
        path = Path(self.directory.name) / "remote-credentials.json"
        return json.loads(path.read_text())["connector_token"] if path.exists() else ""

    async def pair(self) -> None:
        with patch.object(RemoteAccessManager, "_stop_connector", lambda manager: self.stop_connector()):
            await self.manager._poll_pairing()

    async def test_the_connector_holding_the_old_token_is_stopped(self) -> None:
        await self.pair()

        self.assertEqual(self.stopped, 1)

    async def test_a_connector_is_started_on_the_new_token(self) -> None:
        await self.pair()

        self.assertEqual(self.started_tokens, ["fresh-token"])

    async def test_the_new_token_is_saved(self) -> None:
        await self.pair()

        self.assertEqual(self.stored_token(), "fresh-token")

    async def test_the_old_connector_goes_before_the_new_one_arrives(self) -> None:
        # Started first, the new connector is the live one and _start_connector's own guard would drop
        # it -- or two would poll the relay at once.
        order: list[str] = []
        with patch.object(RemoteAccessManager, "_stop_connector",
                          lambda manager: self.record_stop(order)), \
             patch.object(RemoteAccessManager, "_start_connector",
                          lambda manager, credentials: order.append("start")):
            await self.manager._poll_pairing()

        self.assertEqual(order, ["stop", "start"])

    async def record_stop(self, order: list[str]) -> None:
        order.append("stop")

    async def test_the_refusal_that_prompted_the_pairing_is_cleared(self) -> None:
        # Otherwise the deck keeps telling the user to pair again after they just did.
        self.manager.last_error = "the relay no longer accepts this computer's remote token"

        await self.pair()

        self.assertEqual(self.manager.last_error, "")


if __name__ == "__main__":
    unittest.main()
