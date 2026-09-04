import hashlib
import hmac
import html
from http.cookies import CookieError, SimpleCookie
from urllib.parse import quote

from starlette.responses import JSONResponse, RedirectResponse, Response
from starlette.types import ASGIApp, Receive, Scope, Send


class DirectAccessPolicy:
    COOKIE_NAME = "termdeck_access"
    COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60
    COOKIE_CONTEXT = b"termdeck-browser-access-v1"
    EXEMPT_PATHS = frozenset({"/access", "/api/access/status", "/api/access/login", "/api/access/logout"})
    READ_ONLY_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})

    def __init__(self, bearer_token: str, read_only: bool) -> None:
        self.bearer_token = bearer_token.strip()
        self.read_only = read_only
        self.browser_session = hmac.new(self.bearer_token.encode(), self.COOKIE_CONTEXT, hashlib.sha256).hexdigest() \
            if self.bearer_token else ""

    @property
    def authentication_enabled(self) -> bool:
        return bool(self.bearer_token)

    def token_matches(self, candidate: str) -> bool:
        return bool(self.bearer_token) and hmac.compare_digest(candidate.encode(), self.bearer_token.encode())

    def scope_is_authenticated(self, scope: Scope) -> bool:
        if not self.authentication_enabled:
            return True
        authorization = self._scope_header(scope, b"authorization")
        scheme, separator, candidate = authorization.partition(" ")
        if separator and scheme.casefold() == "bearer" and self.token_matches(candidate):
            return True
        cookie_header = self._scope_header(scope, b"cookie")
        try:
            cookies = SimpleCookie(cookie_header)
        except CookieError:
            return False
        browser_cookie = cookies.get(self.COOKIE_NAME)
        return browser_cookie is not None and hmac.compare_digest(browser_cookie.value, self.browser_session)

    def set_browser_cookie(self, response: Response) -> None:
        response.set_cookie(self.COOKIE_NAME, self.browser_session, max_age=self.COOKIE_MAX_AGE_SECONDS,
                            httponly=True, samesite="strict", path="/")

    def delete_browser_cookie(self, response: Response) -> None:
        response.delete_cookie(self.COOKIE_NAME, path="/")

    @staticmethod
    def safe_return_path(candidate: str) -> str:
        return candidate if candidate.startswith("/") and not candidate.startswith("//") else "/"

    def login_page(self, return_path: str, invalid_token: bool = False) -> Response:
        safe_return_path = self.safe_return_path(return_path)
        error = '<div class="error">That access token is not valid.</div>' if invalid_token else ""
        action = "/api/access/login?next=" + quote(safe_return_path, safe="")
        body = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TermDeck access</title><style>
html,body{{height:100%;margin:0}}body{{display:grid;place-items:center;background:#11151b;color:#e6edf3;font:14px Menlo,monospace}}
form{{width:min(390px,calc(100vw - 48px));padding:28px;border:1px solid #35404d;border-radius:12px;background:#1b222c;box-shadow:0 18px 60px #0008}}
h1{{font-size:20px;margin:0 0 8px}}p{{color:#9aa7b4;line-height:1.5;margin:0 0 18px}}input,button{{box-sizing:border-box;width:100%;height:40px;border-radius:6px;font:inherit}}
input{{border:1px solid #465465;background:#10151c;color:#fff;padding:0 11px;outline:none}}input:focus{{border-color:#55b8e8}}
button{{margin-top:12px;border:0;background:#2789bd;color:white;cursor:pointer}}.error{{color:#ff9a9a;margin:0 0 12px}}
</style></head><body><form method="post" action="{html.escape(action, quote=True)}">
<h1>TermDeck</h1><p>Enter the bearer token configured on this TermDeck server.</p>{error}
<input name="token" type="password" autocomplete="current-password" autofocus required aria-label="Access token">
<button type="submit">Open TermDeck</button></form></body></html>"""
        return Response(body, media_type="text/html; charset=utf-8")

    @staticmethod
    def _scope_header(scope: Scope, name: bytes) -> str:
        return next((value.decode("latin-1") for key, value in scope.get("headers", ()) if key.lower() == name), "")


class DirectAccessMiddleware:
    def __init__(self, app: ASGIApp, policy: DirectAccessPolicy) -> None:
        self.app = app
        self.policy = policy

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in {"http", "websocket"}:
            await self.app(scope, receive, send)
            return
        path = str(scope.get("path") or "")
        exempt = path in self.policy.EXEMPT_PATHS
        authenticated = self.policy.scope_is_authenticated(scope)
        if self.policy.authentication_enabled and not exempt and not authenticated:
            await self._reject_unauthenticated(scope, receive, send)
            return
        if scope["type"] == "http" and self.policy.read_only and not exempt and \
                str(scope.get("method") or "GET").upper() not in self.policy.READ_ONLY_METHODS:
            await JSONResponse({"detail": "TermDeck is running in read-only mode"}, status_code=403)(scope, receive, send)
            return
        state = scope.setdefault("state", {})
        state["termdeck_authenticated"] = authenticated
        state["termdeck_read_only"] = self.policy.read_only
        await self.app(scope, receive, send)

    async def _reject_unauthenticated(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 4401, "reason": "TermDeck access token required"})
            return
        accept = self.policy._scope_header(scope, b"accept")
        method = str(scope.get("method") or "GET").upper()
        if method == "GET" and "text/html" in accept:
            target = str(scope.get("path") or "/")
            query = bytes(scope.get("query_string") or b"").decode("latin-1")
            if query:
                target += "?" + query
            response: Response = RedirectResponse("/access?next=" + quote(target, safe=""), status_code=303)
        else:
            response = JSONResponse({"detail": "TermDeck bearer token required"}, status_code=401,
                                    headers={"WWW-Authenticate": "Bearer"})
        await response(scope, receive, send)
