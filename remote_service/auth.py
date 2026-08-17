import asyncio
import hashlib
import secrets
from dataclasses import dataclass
from typing import NotRequired, TypedDict, cast

from google.auth.exceptions import GoogleAuthError
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer


class IdentityPayload(TypedDict):
    sub: str
    email: str
    nonce: NotRequired[str]


class LoginCsrfPayload(TypedDict):
    nonce: str


@dataclass(frozen=True)
class AuthenticatedUser:
    user_id: str
    email: str


class GoogleIdentityVerifier:
    def __init__(self, client_id: str) -> None:
        self.client_id = client_id
        self._request = google_requests.Request()

    async def verify(self, credential: str) -> AuthenticatedUser:
        payload = await asyncio.to_thread(self._verify_synchronously, credential)
        if payload.get("email_verified") is not True:
            raise ValueError("Google email is not verified")
        user_id = payload.get("sub")
        email = payload.get("email")
        if not isinstance(user_id, str) or not user_id or not isinstance(email, str) or not email:
            raise ValueError("Google identity is missing sub or email")
        return AuthenticatedUser(user_id=user_id, email=email)

    def _verify_synchronously(self, credential: str) -> dict[str, object]:
        try:
            return cast(dict[str, object], id_token.verify_oauth2_token(credential, self._request, self.client_id))
        except GoogleAuthError as verification_error:
            raise ValueError("Google identity verification failed") from verification_error


class SignedTokenService:
    SESSION_SALT = "termdeck-browser-session"
    CONNECTOR_SALT = "termdeck-local-connector"
    LOGIN_CSRF_SALT = "termdeck-login-csrf"

    def __init__(self, secret: str, session_max_age_seconds: int, connector_max_age_seconds: int,
                 login_csrf_max_age_seconds: int) -> None:
        self.serializer = URLSafeTimedSerializer(secret)
        self.session_max_age_seconds = session_max_age_seconds
        self.connector_max_age_seconds = connector_max_age_seconds
        self.login_csrf_max_age_seconds = login_csrf_max_age_seconds

    def issue_login_csrf(self) -> str:
        return self.serializer.dumps(LoginCsrfPayload(nonce=secrets.token_urlsafe(24)), salt=self.LOGIN_CSRF_SALT)

    def verify_login_csrf(self, token: str) -> bool:
        if not token:
            return False
        try:
            payload = self.serializer.loads(token, salt=self.LOGIN_CSRF_SALT, max_age=self.login_csrf_max_age_seconds)
        except (BadSignature, SignatureExpired):
            return False
        return isinstance(payload, dict) and isinstance(payload.get("nonce"), str) and bool(payload["nonce"])

    def issue_session(self, user: AuthenticatedUser) -> str:
        return self.serializer.dumps(IdentityPayload(sub=user.user_id, email=user.email), salt=self.SESSION_SALT)

    def verify_session(self, token: str) -> AuthenticatedUser | None:
        return self._verify(token, self.SESSION_SALT, self.session_max_age_seconds)

    def issue_connector(self, user: AuthenticatedUser) -> str:
        payload = IdentityPayload(sub=user.user_id, email=user.email, nonce=secrets.token_urlsafe(24))
        return self.serializer.dumps(payload, salt=self.CONNECTOR_SALT)

    def verify_connector(self, token: str) -> AuthenticatedUser | None:
        return self._verify(token, self.CONNECTOR_SALT, self.connector_max_age_seconds)

    @staticmethod
    def digest(token: str) -> str:
        return hashlib.sha256(token.encode()).hexdigest()

    def _verify(self, token: str, salt: str, max_age_seconds: int) -> AuthenticatedUser | None:
        if not token:
            return None
        try:
            payload = self.serializer.loads(token, salt=salt, max_age=max_age_seconds)
        except (BadSignature, SignatureExpired):
            return None
        if not isinstance(payload, dict) or not isinstance(payload.get("sub"), str) or not isinstance(payload.get("email"), str):
            return None
        return AuthenticatedUser(user_id=payload["sub"], email=payload["email"])
