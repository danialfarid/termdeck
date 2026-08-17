import asyncio
import hashlib
import hmac
import secrets
import time
from dataclasses import dataclass
from typing import Literal, TypedDict

from remote_service.auth import AuthenticatedUser, SignedTokenService
from remote_service.token_store import ConnectorTokenStore


class PairingStartResult(TypedDict):
    pairing_id: str
    pairing_secret: str


class PairingResult(TypedDict, total=False):
    state: Literal["pending", "complete", "expired"]
    connector_token: str
    email: str


@dataclass
class PairingRecord:
    secret_digest: str
    created_monotonic: float
    connector_token: str = ""
    email: str = ""


class PairingService:
    MAX_ACTIVE_PAIRINGS = 10000

    def __init__(self, token_service: SignedTokenService, token_store: ConnectorTokenStore, max_age_seconds: int) -> None:
        self.token_service = token_service
        self.token_store = token_store
        self.max_age_seconds = max_age_seconds
        self._records: dict[str, PairingRecord] = {}
        self._lock = asyncio.Lock()

    async def create(self) -> PairingStartResult:
        pairing_id = secrets.token_urlsafe(18)
        pairing_secret = secrets.token_urlsafe(32)
        async with self._lock:
            self._delete_expired_records()
            if len(self._records) >= self.MAX_ACTIVE_PAIRINGS:
                raise RuntimeError("pairing capacity reached")
            self._records[pairing_id] = PairingRecord(
                secret_digest=self._secret_digest(pairing_secret), created_monotonic=time.monotonic())
        return {"pairing_id": pairing_id, "pairing_secret": pairing_secret}

    async def authorize(self, pairing_id: str, user: AuthenticatedUser) -> None:
        async with self._lock:
            self._delete_expired_records()
            record = self._records.get(pairing_id)
            if record is None:
                raise KeyError(pairing_id)
            connector_token = self.token_service.issue_connector(user)
            await self.token_store.save(user.user_id, user.email, self.token_service.digest(connector_token))
            record.connector_token = connector_token
            record.email = user.email

    async def result(self, pairing_id: str, pairing_secret: str) -> PairingResult:
        async with self._lock:
            record = self._records.get(pairing_id)
            if record is None or self._record_expired(record):
                self._records.pop(pairing_id, None)
                return {"state": "expired"}
            if not hmac.compare_digest(record.secret_digest, self._secret_digest(pairing_secret)):
                raise PermissionError("pairing secret does not match")
            if not record.connector_token:
                return {"state": "pending"}
            return {"state": "complete", "connector_token": record.connector_token, "email": record.email}

    def _delete_expired_records(self) -> None:
        expired_ids = [pairing_id for pairing_id, record in self._records.items() if self._record_expired(record)]
        for pairing_id in expired_ids:
            self._records.pop(pairing_id, None)

    def _record_expired(self, record: PairingRecord) -> bool:
        return time.monotonic() - record.created_monotonic > self.max_age_seconds

    @staticmethod
    def _secret_digest(secret: str) -> str:
        return hashlib.sha256(secret.encode()).hexdigest()
