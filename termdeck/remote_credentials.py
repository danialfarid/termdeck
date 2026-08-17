import json
import os
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import TypedDict


class RemoteCredentialsPayload(TypedDict):
    relay_url: str
    connector_token: str
    email: str


@dataclass(frozen=True)
class RemoteCredentials:
    relay_url: str
    connector_token: str
    email: str


class RemoteCredentialStore:
    FILE_MODE = 0o600

    def __init__(self, path: Path) -> None:
        self.path = path

    def load(self) -> RemoteCredentials | None:
        if not self.path.exists():
            return None
        payload: RemoteCredentialsPayload = json.loads(self.path.read_text())
        return RemoteCredentials(relay_url=payload["relay_url"], connector_token=payload["connector_token"],
                                 email=payload["email"])

    def save(self, credentials: RemoteCredentials) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary_path = self.path.with_suffix(".tmp")
        temporary_path.write_text(json.dumps(asdict(credentials), indent=2) + "\n")
        os.chmod(temporary_path, self.FILE_MODE)
        temporary_path.replace(self.path)

    def delete(self) -> None:
        if self.path.exists():
            self.path.unlink()
