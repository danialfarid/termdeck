import asyncio
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from websockets.exceptions import ConnectionClosedError
from websockets.frames import Close

from termdeck.remote_access import RemoteAccessManager
from termdeck.remote_connector import RemoteConnector
from termdeck.remote_credentials import RemoteCredentials, RemoteCredentialStore

RELAY_URL = "https://relay.example"
LOCAL_URL = "http://127.0.0.1:1"


def connector() -> RemoteConnector:
    return RemoteConnector(relay_url=RELAY_URL, connector_token="token", local_url=LOCAL_URL,
                           reconnect_min_seconds=0.01, reconnect_max_seconds=0.02, http_timeout_seconds=1,
                           demand_poll_seconds=0.01)


async def never_in_demand() -> bool:
    return False


class ConnectorLoopTest(unittest.TestCase):
    """The connector loop must outlive anything a single poll or connection does to it.

    On 2026-09-05 the loop stopped polling the relay while the deck kept answering "ready", and a phone
    sat on the relay's "Connecting to TermDeck" page until the computer was restarted.
    """

    def test_an_unexpected_error_does_not_end_the_loop(self) -> None:
        async def scenario() -> tuple[int, str]:
            remote = connector()
            polls = 0
            errors: list[str] = []

            async def demand() -> bool:
                nonlocal polls
                polls += 1
                if polls == 1:
                    raise AttributeError("'list' object has no attribute 'get'")
                errors.append(remote.last_error)
                if polls >= 3:
                    remote._stop_event.set()
                return False

            remote._relay_requests_connection = demand  # type: ignore[method-assign]
            await asyncio.wait_for(remote.run(), timeout=5)
            await remote._http_client.aclose()
            return polls, errors[0]

        polls, error_after_failure = asyncio.run(scenario())
        self.assertGreaterEqual(polls, 3)
        self.assertIn("AttributeError", error_after_failure)

    def test_being_replaced_by_another_computer_stays_visible_after_the_error_clears(self) -> None:
        async def scenario() -> RemoteConnector:
            remote = connector()
            polls = 0

            async def demand() -> bool:
                nonlocal polls
                polls += 1
                if polls >= 3:
                    remote._stop_event.set()
                return polls == 1

            async def connect_once() -> None:
                raise ConnectionClosedError(Close(4001, "another TermDeck computer connected for this account"), None)

            remote._relay_requests_connection = demand  # type: ignore[method-assign]
            remote._connect_once = connect_once  # type: ignore[method-assign]
            await asyncio.wait_for(remote.run(), timeout=5)
            await remote._http_client.aclose()
            return remote

        remote = asyncio.run(scenario())
        self.assertEqual(remote.last_error, "", "a later 'no demand' poll clears the plain error")
        self.assertEqual(remote.relay_notice, "another TermDeck computer connected for this account")

    def test_an_ordinary_close_leaves_no_notice(self) -> None:
        async def scenario() -> RemoteConnector:
            remote = connector()
            polls = 0

            async def demand() -> bool:
                nonlocal polls
                polls += 1
                if polls >= 2:
                    remote._stop_event.set()
                return polls == 1

            async def connect_once() -> None:
                raise ConnectionClosedError(Close(1006, ""), None)

            remote._relay_requests_connection = demand  # type: ignore[method-assign]
            remote._connect_once = connect_once  # type: ignore[method-assign]
            await asyncio.wait_for(remote.run(), timeout=5)
            await remote._http_client.aclose()
            return remote

        self.assertEqual(asyncio.run(scenario()).relay_notice, "")


class ConnectorRevivalTest(unittest.TestCase):
    def test_status_restarts_a_connector_whose_task_ended_and_reports_why(self) -> None:
        async def scenario() -> tuple[dict[str, object], bool]:
            with TemporaryDirectory() as directory:
                store = RemoteCredentialStore(Path(directory) / "remote-credentials.json")
                store.save(RemoteCredentials(relay_url=RELAY_URL, connector_token="token", email="user@example.com"))
                manager = RemoteAccessManager(
                    relay_url=RELAY_URL, public_url="https://public.example", local_url=LOCAL_URL,
                    credential_store=store, pair_poll_seconds=0.01, pair_timeout_seconds=1,
                    reconnect_min_seconds=0.01, reconnect_max_seconds=0.02, http_timeout_seconds=1,
                    demand_poll_seconds=0.01)
                manager.credentials = store.load()

                async def escaped_loop() -> None:
                    raise RuntimeError("the loop escaped")

                first = connector()
                manager.connector = first
                manager.connector_task = asyncio.get_running_loop().create_task(escaped_loop())
                await asyncio.sleep(0)
                with patch.object(RemoteConnector, "_relay_requests_connection", new=never_in_demand):
                    status = manager.status()
                    revived = manager.connector is not first and manager.connector_task is not None \
                        and not manager.connector_task.done()
                    await asyncio.sleep(0.05)
                    await manager.stop()
                return dict(status), revived

        status, revived = asyncio.run(scenario())
        self.assertTrue(revived)
        self.assertEqual(status["state"], "ready")
        self.assertIn("the loop escaped", str(status["error"]))
        self.assertEqual(status["notice"], "")


class RejectedTokenTest(unittest.TestCase):
    def test_a_token_the_relay_refuses_reads_as_an_error_so_settings_offers_sign_in(self) -> None:
        """On 2026-10-21 an expired token left Settings on "ready", offering only Disconnect, which the relay
        refused with that same token."""
        with TemporaryDirectory() as directory:
            store = RemoteCredentialStore(Path(directory) / "remote-credentials.json")
            manager = RemoteAccessManager(
                relay_url=RELAY_URL, public_url="https://public.example", local_url=LOCAL_URL,
                credential_store=store, pair_poll_seconds=0.01, pair_timeout_seconds=1,
                reconnect_min_seconds=0.01, reconnect_max_seconds=0.02, http_timeout_seconds=1,
                demand_poll_seconds=0.01)
            manager.credentials = RemoteCredentials(relay_url=RELAY_URL, connector_token="token",
                                                    email="user@example.com")
            manager.connector = connector()
            manager.connector.last_error = RemoteConnector.TOKEN_REJECTED_MESSAGE
            status = manager.status()
        self.assertEqual(status["state"], "error")
        self.assertEqual(status["error"], RemoteConnector.TOKEN_REJECTED_MESSAGE)

    def test_a_computer_paired_with_another_relay_follows_the_configured_one(self) -> None:
        """Pairings made with the Cloud Run relay go to the Cloudflare relay, which refuses them, so Settings
        offers signing in again instead of reading "ready" against a relay that is gone."""
        async def scenario() -> str:
            with TemporaryDirectory() as directory:
                store = RemoteCredentialStore(Path(directory) / "remote-credentials.json")
                store.save(RemoteCredentials(relay_url="https://old.example", connector_token="token",
                                             email="user@example.com"))
                manager = RemoteAccessManager(
                    relay_url=RELAY_URL, public_url="https://public.example", local_url=LOCAL_URL,
                    credential_store=store, pair_poll_seconds=0.01, pair_timeout_seconds=1,
                    reconnect_min_seconds=0.01, reconnect_max_seconds=0.02, http_timeout_seconds=1,
                    demand_poll_seconds=0.01)
                with patch.object(RemoteConnector, "run", lambda self: never_in_demand()):
                    await manager.start()
                    relay = manager.connector.relay_url
                    await manager.stop()
                return relay

        self.assertEqual(asyncio.run(scenario()), RELAY_URL)

    def test_a_refused_token_stops_polling_the_relay_every_few_seconds(self) -> None:
        """Computers with expired tokens polled every 5 seconds forever, billing the relay for nothing."""
        async def scenario() -> int:
            remote = connector()
            polls = 0

            async def refused() -> bool:
                nonlocal polls
                polls += 1
                raise ValueError(RemoteConnector.TOKEN_REJECTED_MESSAGE)

            remote._relay_requests_connection = refused  # type: ignore[method-assign]
            task = asyncio.create_task(remote.run())
            await asyncio.sleep(0.3)
            remote._stop_event.set()
            await asyncio.wait_for(task, timeout=5)
            await remote._http_client.aclose()
            return polls

        self.assertEqual(asyncio.run(scenario()), 1)


if __name__ == "__main__":
    unittest.main()
