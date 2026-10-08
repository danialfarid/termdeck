"""TermDeck's agent delegation API as MCP tools.

A thin stdio wrapper over the local HTTP API (docs/agents-termdeck-api.md): it adds no
capability of its own, it just lets MCP-capable models spawn agents, send prompts, and read
responses back as typed tools instead of hand-rolled curl and polling loops. Run it with
``termdeck mcp``; it talks to the deck on the configured host and port (``--host``/``--port``).
"""

import asyncio
import os
import time
from typing import Any

import httpx
from mcp.server.mcpserver import MCPServer

SERVER_NAME = "termdeck"
# TermDeck-launched processes receive their own session id here; a child spawned without an
# explicit origin is filed under it, which is how the deck knows where the child belongs.
ENV_SESSION_ID = "TERMDECK_SESSION_ID"
DEFAULT_HTTP_TIMEOUT_SECONDS = 30.0
DEFAULT_WAIT_TIMEOUT_SECONDS = 60.0
DEFAULT_WAIT_POLL_SECONDS = 2.0
# One wait call never holds the agent's turn longer than this; poll again for longer runs.
MAX_WAIT_TIMEOUT_SECONDS = 600.0
MIN_WAIT_POLL_SECONDS = 0.5

SERVER_INSTRUCTIONS = (
    "TermDeck: a local deck of persistent agent terminals. Spawn an agent with spawn_agent "
    "(or send_prompt on an existing session); both hand back a `since` stamp. Pass that stamp "
    "to wait_for_response or get_response: only responses stamped after it answer that prompt. "
    "A session id or name from list_sessions addresses every other tool."
)


class TermdeckMcpError(RuntimeError):
    """The deck answered with an error, or could not be reached at all."""


def default_base_url() -> str:
    """Where the local deck listens. Read at call time so `termdeck --port N mcp` applies."""
    from termdeck.config import TermdeckConfig

    host = TermdeckConfig.HOST
    if host in ("0.0.0.0", "::"):
        host = "127.0.0.1"
    return f"http://{host}:{TermdeckConfig.PORT}"


class TermdeckMcpClient:
    """The agent-facing REST surface, one method per tool. A custom transport (for example
    httpx.MockTransport) stands in for the network in tests."""

    def __init__(self, base_url: str | None = None,
                 transport: httpx.AsyncBaseTransport | None = None,
                 timeout_seconds: float = DEFAULT_HTTP_TIMEOUT_SECONDS) -> None:
        self.base_url = (base_url or default_base_url()).rstrip("/")
        self._transport = transport
        self._timeout = timeout_seconds

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        async with httpx.AsyncClient(base_url=self.base_url, transport=self._transport,
                                     timeout=self._timeout) as http:
            try:
                response = await http.request(method, path, **kwargs)
                response.raise_for_status()
            except httpx.HTTPStatusError as status_error:
                raise TermdeckMcpError(
                    f"{method} {path} answered {status_error.response.status_code}: "
                    f"{self._error_detail(status_error.response)}") from status_error
            except httpx.HTTPError as transport_error:
                raise TermdeckMcpError(
                    f"cannot reach TermDeck at {self.base_url} ({transport_error}); "
                    "is the server running?") from transport_error
        if not response.content:
            return {}
        try:
            return response.json()
        except ValueError:
            return {"text": response.text}

    @staticmethod
    def _error_detail(response: httpx.Response) -> str:
        try:
            detail = response.json().get("detail", "")
        except ValueError:
            detail = ""
        return str(detail or response.text).strip()[:300] or "unknown error"

    async def spawn_agent(self, model: str = "", model_name: str = "", permission: str = "",
                          additional_args: str = "", title: str = "", description: str = "",
                          prompt: str = "", origin_session: str = "", session_ref: str = "",
                          cwd: str = "", project: str = "", after: str | None = None,
                          worktree: bool = False, worktree_branch: str = "",
                          worktree_base: str = "", worktree_id: str = "root",
                          fork: bool = False, output_path: str = "", write_back: bool = False,
                          steer: bool | None = None, bracketed: bool = True) -> dict[str, Any]:
        """Start an agent session, optionally already working on a prompt.

        Returns the session summary with `session_id`, and `since` when a prompt was sent:
        hand that stamp to wait_for_response/get_response to read what the agent says back.
        `prompt_submitted` false (`delivery` "failed", reason in `delivery_detail`) means the
        prompt did not go in and is safe to send again; "unconfirmed" may have arrived, so
        never send it again.
        origin_session files the child under its parent; empty means this process's own
        $TERMDECK_SESSION_ID, which is what a delegated child wants.
        """
        origin = origin_session.strip() or os.environ.get(ENV_SESSION_ID, "").strip()
        return await self._request("POST", "/api/sessions", json={
            "model": model, "model_name": model_name, "permission": permission,
            "additional_args": additional_args, "title": title, "description": description,
            "prompt": prompt, "origin_session": origin, "session_ref": session_ref, "cwd": cwd,
            "project": project, "after": after, "worktree": worktree,
            "worktree_branch": worktree_branch, "worktree_base": worktree_base,
            "worktree_id": worktree_id, "fork": fork, "output_path": output_path,
            "write_back": write_back, "steer": steer, "bracketed": bracketed})

    async def spawn_batch(self, terminals: list[dict[str, Any]], prompt: str = "", cwd: str = "",
                          project: str = "", model: str = "codex", model_name: str = "",
                          additional_args: str = "", permission: str = "default",
                          bracketed: bool = True, steer: bool | None = None,
                          after: str | None = None, worktree: bool = False,
                          worktree_branch: str = "", worktree_base: str = "",
                          worktree_id: str = "root") -> dict[str, Any]:
        """Start several agents at once. Each terminals item needs a `name` and takes its own
        `prompt`, `description`, `cwd`, `project`, `model`, `model_name`, `permission`, and
        worktree fields; the shared arguments cover what an item leaves out."""
        return await self._request("POST", "/api/sessions/batch", json={
            "terminals": terminals, "prompt": prompt, "cwd": cwd, "project": project,
            "model": model, "model_name": model_name, "additional_args": additional_args,
            "permission": permission, "bracketed": bracketed, "steer": steer, "after": after,
            "worktree": worktree, "worktree_branch": worktree_branch,
            "worktree_base": worktree_base, "worktree_id": worktree_id})

    async def send_prompt(self, session_id: str, text: str, steer: bool | None = None,
                          bracketed: bool = True) -> dict[str, Any]:
        """Send a follow-up prompt to a session. Returns `since`: the stamp tying the agent's
        next responses to this prompt. steer false queues behind the current turn where the
        agent has a queue; the default steers immediately. `prompt_submitted` false (`delivery`
        "failed", reason in `delivery_detail`, no `since`) means it did not go in and is safe to
        send again; "unconfirmed" may have arrived, so never send it again."""
        return await self._request("POST", f"/api/sessions/{session_id}/prompt",
                                   json={"text": text, "steer": steer, "bracketed": bracketed})

    async def get_response(self, session_id: str, since: str = "", limit: int = 1,
                           final: bool = False) -> dict[str, Any]:
        """What an agent said back, most recent last, under `responses`. since ties the answers
        to one prompt: only responses stamped after it are returned. limit counts responses,
        not transcript entries. final leaves out what the agent said on its way through the
        work, for the agents that mark which message ended a turn."""
        route = "/response/final" if final else "/response"
        return await self._request("GET", f"/api/sessions/{session_id}{route}",
                                   params={"since": since, "limit": limit})

    async def wait_for_response(self, session_id: str, since: str,
                                timeout_seconds: float = DEFAULT_WAIT_TIMEOUT_SECONDS,
                                poll_interval_seconds: float = DEFAULT_WAIT_POLL_SECONDS,
                                final: bool = False) -> dict[str, Any]:
        """Poll get_response until the agent answers this prompt or the timeout runs out.
        Returns the response payload with `timed_out` added: false means the answers are in
        `responses`, true means poll again. since is required: without the prompt's own stamp
        there is nothing tying an answer to it."""
        if not since.strip():
            raise ValueError("wait_for_response needs the since stamp from spawn_agent or send_prompt")
        deadline = time.monotonic() + min(max(float(timeout_seconds), 1.0), MAX_WAIT_TIMEOUT_SECONDS)
        interval = min(max(float(poll_interval_seconds), MIN_WAIT_POLL_SECONDS),
                       MAX_WAIT_TIMEOUT_SECONDS)
        payload = await self.get_response(session_id, since, final=final)
        while not payload.get("responses") and time.monotonic() < deadline:
            await asyncio.sleep(interval)
            payload = await self.get_response(session_id, since, final=final)
        payload["timed_out"] = not bool(payload.get("responses"))
        return payload

    async def session_status(self, session_id: str) -> dict[str, Any]:
        """How a session is doing: the process, the agent, and the transcript tail. `running`
        means the terminal process is alive, not that a response is still being generated."""
        return await self._request("GET", f"/api/sessions/{session_id}/status")

    async def children_status(self, session_id: str) -> dict[str, Any]:
        """How every child spawned from a session is doing, each in the shape of its own
        session_status call."""
        return await self._request("GET", f"/api/sessions/{session_id}/children/status")

    async def interrupt(self, session_id: str) -> dict[str, Any]:
        """Stop the agent's current turn."""
        return await self._request("POST", f"/api/sessions/{session_id}/interrupt")

    async def list_sessions(self, project: str = "", worktree_id: str = "") -> list[dict[str, Any]]:
        """List sessions, optionally confined to one project and worktree."""
        return await self._request("GET", "/api/sessions",
                                   params={"project": project, "worktree_id": worktree_id})

    async def get_session(self, session_id: str) -> dict[str, Any]:
        """One session's record: title, description, project, and direct TermDeck URL."""
        return await self._request("GET", f"/api/sessions/{session_id}")

    async def close_session(self, session_id: str) -> dict[str, Any]:
        """Stop a session without erasing its history."""
        return await self._request("DELETE", f"/api/sessions/{session_id}")

    async def set_description(self, session_id: str, description: str,
                              append: bool = False) -> dict[str, Any]:
        """Set the user-visible session description shown on the terminal tab."""
        return await self._request("POST", f"/api/sessions/{session_id}/description",
                                   json={"description": description, "append": append})

    async def worktree_review(self, session_id: str) -> dict[str, Any]:
        """Show the branch and diff of a session's isolated worktree."""
        return await self._request("GET", f"/api/sessions/{session_id}/worktree/review")

    async def worktree_finish(self, session_id: str, action: str,
                              target_branch: str = "") -> dict[str, Any]:
        """Finish a session's isolated worktree: `keep`, `merge`, or `discard`."""
        return await self._request("POST", f"/api/sessions/{session_id}/worktree/finish",
                                   json={"action": action, "target_branch": target_branch})

    async def session_history(self, session_id: str) -> list[dict[str, Any]]:
        """The session's normalized transcript turns: prompts, responses, and tool use."""
        return await self._request("GET", f"/api/sessions/{session_id}/history")


def build_server(client: TermdeckMcpClient | None = None) -> MCPServer:
    """The MCP server over one client. Each tool is its REST call, with the client's own
    docstring as the tool description."""
    server = MCPServer(name=SERVER_NAME, instructions=SERVER_INSTRUCTIONS)
    api = client or TermdeckMcpClient()
    for tool_method in (api.spawn_agent, api.spawn_batch, api.send_prompt, api.get_response,
                        api.wait_for_response, api.session_status, api.children_status,
                        api.interrupt, api.list_sessions, api.get_session, api.close_session,
                        api.set_description, api.worktree_review, api.worktree_finish,
                        api.session_history):
        server.tool()(tool_method)
    return server


def run_mcp_server() -> None:
    """Serve the TermDeck tools over stdio. This is what `termdeck mcp` runs."""
    build_server().run(transport="stdio")
