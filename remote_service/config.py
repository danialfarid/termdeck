import os
from dataclasses import dataclass


@dataclass(frozen=True)
class RemoteServiceConfig:
    google_client_id: str
    session_secret: str
    public_url: str
    firestore_project: str
    session_max_age_seconds: int
    connector_max_age_seconds: int
    pairing_max_age_seconds: int
    relay_request_timeout_seconds: float
    max_body_bytes: int
    cookie_secure: bool
    connector_idle_seconds: float
    browser_idle_seconds: float
    anonymous_requests_per_hour: int

    @staticmethod
    def from_environment() -> "RemoteServiceConfig":
        public_url = os.environ.get("TERMDECK_REMOTE_PUBLIC_URL", "http://127.0.0.1:8540").rstrip("/")
        google_client_id = os.environ.get("TERMDECK_REMOTE_GOOGLE_CLIENT_ID", "").strip()
        session_secret = os.environ.get("TERMDECK_REMOTE_SESSION_SECRET", "").strip()
        if not google_client_id:
            raise RuntimeError("TERMDECK_REMOTE_GOOGLE_CLIENT_ID is required")
        if len(session_secret) < 32:
            raise RuntimeError("TERMDECK_REMOTE_SESSION_SECRET must contain at least 32 characters")
        return RemoteServiceConfig(
            google_client_id=google_client_id,
            session_secret=session_secret,
            public_url=public_url,
            firestore_project=os.environ.get("GOOGLE_CLOUD_PROJECT", "").strip(),
            session_max_age_seconds=int(os.environ.get("TERMDECK_REMOTE_SESSION_MAX_AGE", "43200")),
            connector_max_age_seconds=int(os.environ.get("TERMDECK_REMOTE_CONNECTOR_MAX_AGE", "2592000")),
            pairing_max_age_seconds=int(os.environ.get("TERMDECK_REMOTE_PAIRING_MAX_AGE", "600")),
            relay_request_timeout_seconds=float(os.environ.get("TERMDECK_REMOTE_REQUEST_TIMEOUT", "60")),
            max_body_bytes=int(os.environ.get("TERMDECK_REMOTE_MAX_BODY_BYTES", "25165824")),
            cookie_secure=public_url.startswith("https://"),
            connector_idle_seconds=float(os.environ.get("TERMDECK_REMOTE_CONNECTOR_IDLE_SECONDS", "45")),
            browser_idle_seconds=float(os.environ.get("TERMDECK_REMOTE_BROWSER_IDLE_SECONDS", "600")),
            anonymous_requests_per_hour=int(os.environ.get("TERMDECK_REMOTE_ANONYMOUS_REQUESTS_PER_HOUR", "30")),
        )
