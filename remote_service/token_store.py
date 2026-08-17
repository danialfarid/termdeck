import hmac
from typing import Protocol

from google.cloud.firestore_v1.async_client import AsyncClient


class ConnectorTokenStore(Protocol):
    async def save(self, user_id: str, email: str, token_digest: str) -> None: ...
    async def matches(self, user_id: str, token_digest: str) -> bool: ...
    async def revoke(self, user_id: str) -> None: ...


class MemoryConnectorTokenStore:
    def __init__(self) -> None:
        self._tokens: dict[str, tuple[str, str]] = {}

    async def save(self, user_id: str, email: str, token_digest: str) -> None:
        self._tokens[user_id] = (email, token_digest)

    async def matches(self, user_id: str, token_digest: str) -> bool:
        stored = self._tokens.get(user_id)
        return stored is not None and hmac.compare_digest(stored[1], token_digest)

    async def revoke(self, user_id: str) -> None:
        self._tokens.pop(user_id, None)


class FirestoreConnectorTokenStore:
    COLLECTION = "termdeck_remote_connectors"

    def __init__(self, project: str) -> None:
        self._client = AsyncClient(project=project)

    async def save(self, user_id: str, email: str, token_digest: str) -> None:
        await self._client.collection(self.COLLECTION).document(user_id).set({"email": email, "token_digest": token_digest})

    async def matches(self, user_id: str, token_digest: str) -> bool:
        snapshot = await self._client.collection(self.COLLECTION).document(user_id).get()
        if not snapshot.exists:
            return False
        stored = snapshot.to_dict()["token_digest"]
        return isinstance(stored, str) and hmac.compare_digest(stored, token_digest)

    async def revoke(self, user_id: str) -> None:
        await self._client.collection(self.COLLECTION).document(user_id).delete()
