import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Literal, TypedDict

import httpx

from termdeck.remote_connector import RemoteConnector
from termdeck.remote_credentials import RemoteCredentials, RemoteCredentialStore

LOGGER = logging.getLogger("termdeck.remote")


class RemoteAccessStatus(TypedDict):
    state: Literal["disconnected", "pairing", "ready", "connected", "error"]
    relay_url: str
    public_url: str
    email: str
    login_url: str
    error: str
    # Why the relay last let this computer go while it is otherwise "ready": another computer on the
    # same account holds the slot, or access was revoked. Cleared when the relay accepts it again.
    notice: str


class RemotePairingStartPayload(TypedDict):
    pairing_id: str
    pairing_secret: str
    login_url: str


class RemotePairingResultPayload(TypedDict, total=False):
    state: Literal["pending", "complete", "expired"]
    connector_token: str
    email: str


@dataclass(frozen=True)
class RemotePairingState:
    pairing_id: str
    pairing_secret: str
    login_url: str
    started_monotonic: float


class RemoteAccessManager:
    def __init__(self, relay_url: str, public_url: str, local_url: str, credential_store: RemoteCredentialStore,
                 pair_poll_seconds: float, pair_timeout_seconds: float, reconnect_min_seconds: float,
                 reconnect_max_seconds: float, http_timeout_seconds: float, demand_poll_seconds: float,
                 local_access_token: str = "") -> None:
        self.relay_url = relay_url.rstrip("/")
        self.public_url = public_url.rstrip("/")
        self.local_url = local_url.rstrip("/")
        self.credential_store = credential_store
        self.pair_poll_seconds = pair_poll_seconds
        self.pair_timeout_seconds = pair_timeout_seconds
        self.reconnect_min_seconds = reconnect_min_seconds
        self.reconnect_max_seconds = reconnect_max_seconds
        self.http_timeout_seconds = http_timeout_seconds
        self.demand_poll_seconds = demand_poll_seconds
        self.local_access_token = local_access_token
        self.credentials: RemoteCredentials | None = None
        self.connector: RemoteConnector | None = None
        self.connector_task: asyncio.Task[None] | None = None
        self.pairing_state: RemotePairingState | None = None
        self.pairing_task: asyncio.Task[None] | None = None
        self.last_error = ""
        self._http_client = httpx.AsyncClient(timeout=http_timeout_seconds)

    async def start(self) -> None:
        self.credentials = self.credential_store.load()
        if self.credentials is not None:
            self._start_connector(self.credentials)

    async def stop(self) -> None:
        if self.pairing_task is not None:
            self.pairing_task.cancel()
            await asyncio.gather(self.pairing_task, return_exceptions=True)
            self.pairing_task = None
        await self._stop_connector()
        await self._http_client.aclose()

    async def begin_pairing(self) -> RemoteAccessStatus:
        if self.pairing_task is not None and not self.pairing_task.done():
            return self.status()
        response = await self._http_client.post(f"{self.relay_url}/_remote/api/pairings")
        response.raise_for_status()
        payload = RemotePairingStartPayload(**response.json())
        self.pairing_state = RemotePairingState(
            pairing_id=payload["pairing_id"], pairing_secret=payload["pairing_secret"],
            login_url=payload["login_url"], started_monotonic=time.monotonic())
        self.last_error = ""
        self.pairing_task = asyncio.create_task(self._poll_pairing())
        return self.status()

    async def disconnect(self) -> RemoteAccessStatus:
        credentials = self.credentials
        if credentials is not None:
            response = await self._http_client.post(
                f"{credentials.relay_url}/_remote/api/connectors/revoke",
                headers={"Authorization": f"Bearer {credentials.connector_token}"})
            response.raise_for_status()
        await self._stop_connector()
        self.credentials = None
        self.credential_store.delete()
        self.last_error = ""
        return self.status()

    def status(self) -> RemoteAccessStatus:
        self._revive_stopped_connector()
        connector_error = self.connector.last_error if self.connector is not None else ""
        connector_notice = self.connector.relay_notice if self.connector is not None else ""
        if self.pairing_state is not None:
            state: Literal["disconnected", "pairing", "ready", "connected", "error"] = "pairing"
        elif self.credentials is None:
            state = "error" if self.last_error else "disconnected"
        elif self.connector is not None and self.connector.connected:
            state = "connected"
        else:
            state = "ready"
        return {
            "state": state,
            "relay_url": self.credentials.relay_url if self.credentials is not None else self.relay_url,
            "public_url": self.public_url,
            "email": self.credentials.email if self.credentials is not None else "",
            "login_url": self.pairing_state.login_url if self.pairing_state is not None else "",
            "error": self.last_error or connector_error,
            "notice": connector_notice,
        }

    def _revive_stopped_connector(self) -> None:
        task = self.connector_task
        stale = self.connector
        if task is None or not task.done() or stale is None or self.credentials is None:
            return
        # The connector loop is written to outlive any single failure, so a finished task means run()
        # escaped anyway. Before this check the deck kept reporting "ready" while nothing polled the
        # relay, and a phone sat on "Connecting to TermDeck" until the server was restarted by hand.
        failure = None if task.cancelled() else task.exception()
        LOGGER.error("remote connector task ended unexpectedly (%r); starting a new one", failure)
        self.connector_task = None
        self._start_connector(self.credentials)
        if failure is not None:
            self.connector.last_error = f"remote connector restarted after: {failure!r}"
        try:
            asyncio.get_running_loop().create_task(stale.stop())
        except RuntimeError:
            pass

    async def _poll_pairing(self) -> None:
        pairing_state = self.pairing_state
        if pairing_state is None:
            return
        try:
            while time.monotonic() - pairing_state.started_monotonic < self.pair_timeout_seconds:
                response = await self._http_client.post(
                    f"{self.relay_url}/_remote/api/pairings/{pairing_state.pairing_id}/result",
                    json={"pairing_secret": pairing_state.pairing_secret})
                response.raise_for_status()
                payload = RemotePairingResultPayload(**response.json())
                if payload["state"] == "complete":
                    credentials = RemoteCredentials(relay_url=self.relay_url,
                                                    connector_token=payload["connector_token"], email=payload["email"])
                    self.credential_store.save(credentials)
                    self.credentials = credentials
                    self.pairing_state = None
                    self._start_connector(credentials)
                    return
                if payload["state"] == "expired":
                    self.last_error = "Google pairing expired"
                    self.pairing_state = None
                    return
                await asyncio.sleep(self.pair_poll_seconds)
            self.last_error = "Google pairing timed out"
            self.pairing_state = None
        except httpx.HTTPError as pairing_error:
            self.last_error = str(pairing_error)
            self.pairing_state = None
        finally:
            self.pairing_task = None

    def _start_connector(self, credentials: RemoteCredentials) -> None:
        if self.connector_task is not None and not self.connector_task.done():
            return
        self.connector = RemoteConnector(
            relay_url=credentials.relay_url, connector_token=credentials.connector_token, local_url=self.local_url,
            reconnect_min_seconds=self.reconnect_min_seconds, reconnect_max_seconds=self.reconnect_max_seconds,
            http_timeout_seconds=self.http_timeout_seconds, demand_poll_seconds=self.demand_poll_seconds,
            local_access_token=self.local_access_token)
        self.connector_task = asyncio.create_task(self.connector.run())

    async def _stop_connector(self) -> None:
        if self.connector is not None:
            await self.connector.stop()
            self.connector = None
        if self.connector_task is not None:
            await asyncio.gather(self.connector_task, return_exceptions=True)
            self.connector_task = None
