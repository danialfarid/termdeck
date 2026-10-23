import asyncio
import inspect
import json
import os
import unittest
from typing import Any
from unittest import mock

import httpx
from mcp.server.mcpserver.exceptions import ToolError, UnexpectedToolError

from termdeck import agents
from termdeck.mcp_server import TermdeckMcpClient, TermdeckMcpError, build_server, default_base_url


def run(coro: Any) -> Any:
    return asyncio.run(coro)


class McpClientTest(unittest.TestCase):
    def setUp(self) -> None:
        # Run from a TermDeck terminal, the suite inherits a session id that would name a caller here.
        patcher = mock.patch.dict(os.environ, {"TERMDECK_SESSION_ID": ""})
        patcher.start()
        self.addCleanup(patcher.stop)

    def make_client(self, handler: Any) -> TermdeckMcpClient:
        return TermdeckMcpClient(base_url="http://127.0.0.1:8530",
                                 transport=httpx.MockTransport(handler))

    def test_registers_one_tool_per_agent_call(self) -> None:
        server = build_server(self.make_client(lambda request: httpx.Response(200, json={})))
        tools = run(server.list_tools())
        self.assertEqual([tool.name for tool in tools],
                         ["spawn_agent", "spawn_batch", "send_prompt", "get_response",
                          "wait_for_response", "session_status", "children_status",
                          "interrupt", "list_sessions", "get_session", "close_session",
                          "set_description", "worktree_review", "worktree_finish",
                          "session_history", "list_projects", "list_worktrees"])

    def test_tool_descriptions_document_the_since_contract(self) -> None:
        server = build_server(self.make_client(lambda request: httpx.Response(200, json={})))
        descriptions = {tool.name: tool.description for tool in run(server.list_tools())}
        self.assertIn("since", descriptions["get_response"])
        self.assertIn("since", descriptions["wait_for_response"])
        self.assertIn("since", descriptions["send_prompt"])
        self.assertIn("origin_session", descriptions["spawn_agent"])

    def test_spawn_agent_posts_sessions_and_defaults_origin_to_own_session(self) -> None:
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(200, json={"session_id": "abc", "since": "stamp"})

        client = self.make_client(handler)
        with mock.patch.dict(os.environ, {"TERMDECK_SESSION_ID": "parent-1"}):
            result = run(client.spawn_agent(model="codex", prompt="do it"))
        self.assertEqual(result["session_id"], "abc")
        self.assertEqual(seen[0].method, "POST")
        self.assertEqual(seen[0].url.path, "/api/sessions")
        body = json.loads(seen[0].content.decode("utf-8"))
        self.assertEqual(body["origin_session"], "parent-1")
        # An explicit origin wins over the environment.
        run(client.spawn_agent(model="codex", prompt="do it", origin_session="other-2"))
        self.assertEqual(json.loads(seen[1].content.decode("utf-8"))["origin_session"], "other-2")

    def test_send_prompt_posts_text_only(self) -> None:
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(200, json={"since": "stamp", "queued": False})

        run(self.make_client(handler).send_prompt("abc", "follow up"))
        self.assertEqual(seen[0].method, "POST")
        self.assertEqual(seen[0].url.path, "/api/sessions/abc/prompt")
        self.assertEqual(json.loads(seen[0].content.decode("utf-8")),
                         {"text": "follow up", "bracketed": True})

    def test_prompts_name_the_session_that_sends_them(self) -> None:
        seen: list[dict[str, Any]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(json.loads(request.content.decode("utf-8")))
            return httpx.Response(200, json={})

        client = self.make_client(handler)
        with mock.patch.dict(os.environ, {"TERMDECK_SESSION_ID": "parent-1"}):
            run(client.send_prompt("abc", "follow up"))
            run(client.spawn_agent(model="codex", prompt="do it"))
            run(client.spawn_batch([{"name": "a", "prompt": "item"}, {"name": "b"}], prompt="shared"))
            run(client.send_prompt("abc", "parent-1 here: follow up"))
            run(client.spawn_agent(model="codex"))
            run(client.send_prompt("abc", "/goal resume"))
        header = "[TermDeck message from session parent-1]\n"
        self.assertEqual(seen[0]["text"], header + "follow up")
        self.assertEqual(seen[1]["prompt"], header + "do it")
        self.assertEqual(seen[2]["prompt"], header + "shared")
        self.assertEqual(seen[2]["terminals"], [{"name": "a", "prompt": header + "item"}, {"name": "b"}])
        # Filed under the caller, as spawn_agent's child is.
        self.assertEqual(seen[2]["origin_session"], "parent-1")
        # Already named, or nothing to send: left as it is.
        self.assertEqual(seen[3]["text"], "parent-1 here: follow up")
        self.assertEqual(seen[4]["prompt"], "")
        # A slash command only runs as the prompt's first characters.
        self.assertEqual(seen[5]["text"], "/goal resume")

    def test_delivery_checks_look_past_the_caller_header(self) -> None:
        # The header is the same on every prompt one session sends; matching it would confirm a new
        # prompt by an old one still in the transcript.
        self.assertEqual(agents.AgentCli.prompt_needle("[TermDeck message from session p-1]\nfollow up"),
                         "follow up")

    def test_no_tool_offers_steer(self) -> None:
        # Prompts always steer; a tool that still offered steer would let an agent ask to queue.
        for name in ("spawn_agent", "spawn_batch", "send_prompt"):
            self.assertNotIn("steer", inspect.signature(getattr(TermdeckMcpClient, name)).parameters, name)

    def test_an_unknown_permission_names_the_ones_that_work(self) -> None:
        with self.assertRaises(ValueError) as raised:
            agents.agent_cli("codex").normalized_permission_flags("bypassPermissions")
        self.assertIn("default, full-access, read-only, workspace-write", str(raised.exception))

    def test_the_permissions_the_tool_names_are_ones_the_agents_take(self) -> None:
        described = TermdeckMcpClient.spawn_agent.__doc__ or ""
        for kind, names in (("codex", ("default", "full-access", "read-only", "workspace-write")),
                            ("claude", ("default", "full-access", "plan", "accept-edits", "bypassPermissions"))):
            for name in names:
                self.assertIn(f"`{name}`", described, name)
                agents.agent_cli(kind).normalized_permission_flags(name)

    def test_get_response_passes_since_limit_and_final_route(self) -> None:
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(200, json={"responses": []})

        client = self.make_client(handler)
        run(client.get_response("abc", since="stamp", limit=5))
        self.assertEqual(seen[0].url.path, "/api/sessions/abc/response")
        self.assertEqual(seen[0].url.params["since"], "stamp")
        self.assertEqual(seen[0].url.params["limit"], "5")
        run(client.get_response("abc", final=True))
        self.assertEqual(seen[1].url.path, "/api/sessions/abc/response/final")

    def test_wait_for_response_returns_answers_without_timing_out(self) -> None:
        calls = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            responses = [] if calls < 3 else [{"text": "done"}]
            return httpx.Response(200, json={"responses": responses})

        payload = run(self.make_client(handler).wait_for_response(
            "abc", "stamp", timeout_seconds=30, poll_interval_seconds=0.01))
        self.assertFalse(payload["timed_out"])
        self.assertEqual(payload["responses"], [{"text": "done"}])
        self.assertEqual(calls, 3)

    def test_wait_for_response_times_out_and_marks_it(self) -> None:
        calls = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            return httpx.Response(200, json={"responses": [], "status": "running"})

        payload = run(self.make_client(handler).wait_for_response(
            "abc", "stamp", timeout_seconds=1, poll_interval_seconds=0.01))
        self.assertTrue(payload["timed_out"])
        self.assertEqual(payload["responses"], [])
        self.assertGreaterEqual(calls, 2)

    def test_wait_for_response_requires_since(self) -> None:
        client = self.make_client(lambda request: httpx.Response(200, json={}))
        with self.assertRaises(ValueError):
            run(client.wait_for_response("abc", "  "))

    def test_http_errors_surface_status_and_detail(self) -> None:
        client = self.make_client(
            lambda request: httpx.Response(404, json={"detail": "no such session"}))
        with self.assertRaises(TermdeckMcpError) as raised:
            run(client.session_status("missing"))
        self.assertIn("404", str(raised.exception))
        self.assertIn("no such session", str(raised.exception))

    def test_the_deck_s_refusal_reaches_the_agent_through_the_tool(self) -> None:
        # The MCP library hides any exception but a ToolError behind "Error executing tool <name>":
        # an agent that passed Claude's bypassPermissions for Codex was told nothing it could correct.
        detail = "unknown codex permission: bypassPermissions; use one of default, full-access"
        server = build_server(self.make_client(lambda request: httpx.Response(400, json={"detail": detail})))
        with self.assertRaises(ToolError) as raised:
            run(server.call_tool("spawn_agent", {"model": "codex", "permission": "bypassPermissions"}))
        self.assertNotIsInstance(raised.exception, UnexpectedToolError)
        self.assertIn(detail, str(raised.exception))

    def test_connection_failure_names_the_deck_and_the_fix(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("refused")

        with self.assertRaises(TermdeckMcpError) as raised:
            run(self.make_client(handler).list_sessions())
        self.assertIn("http://127.0.0.1:8530", str(raised.exception))
        self.assertIn("is the server running?", str(raised.exception))

    def test_status_children_interrupt_and_worktree_routes(self) -> None:
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(200, json={"ok": True})

        client = self.make_client(handler)
        run(client.session_status("abc"))
        run(client.children_status("abc"))
        run(client.interrupt("abc"))
        run(client.worktree_review("abc"))
        run(client.worktree_finish("abc", "merge", target_branch="main"))
        run(client.set_description("abc", "reviewing", append=True))
        self.assertEqual([(request.method, request.url.path) for request in seen],
                         [("GET", "/api/sessions/abc/status"),
                          ("GET", "/api/sessions/abc/children/status"),
                          ("POST", "/api/sessions/abc/interrupt"),
                          ("GET", "/api/sessions/abc/worktree/review"),
                          ("POST", "/api/sessions/abc/worktree/finish"),
                          ("POST", "/api/sessions/abc/description")])
        self.assertEqual(json.loads(seen[4].content.decode("utf-8")),
                         {"action": "merge", "target_branch": "main"})
        self.assertEqual(json.loads(seen[5].content.decode("utf-8")),
                         {"description": "reviewing", "append": True})

    def test_list_get_close_history_and_batch_routes(self) -> None:
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(200, json=[])

        client = self.make_client(handler)
        run(client.list_sessions(project="stock"))
        run(client.get_session("abc"))
        run(client.close_session("abc"))
        run(client.session_history("abc"))
        run(client.spawn_batch([{"name": "one", "prompt": "go"}], model="claude"))
        self.assertEqual([(request.method, request.url.path) for request in seen],
                         [("GET", "/api/sessions"), ("GET", "/api/sessions/abc"),
                          ("DELETE", "/api/sessions/abc"), ("GET", "/api/sessions/abc/history"),
                          ("POST", "/api/sessions/batch")])
        self.assertEqual(seen[0].url.params["project"], "stock")
        batch = json.loads(seen[4].content.decode("utf-8"))
        self.assertEqual(batch["terminals"], [{"name": "one", "prompt": "go"}])
        self.assertEqual(batch["model"], "claude")

    def test_tool_call_through_the_server_reaches_the_deck(self) -> None:
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(200, json={"responses": [{"text": "hi"}], "status": "completed"})

        server = build_server(self.make_client(handler))
        result = run(server.call_tool("get_response", {"session_id": "abc", "since": "stamp"}))
        self.assertFalse(result.is_error)
        self.assertIn("hi", result.content[0].text)
        self.assertEqual(seen[0].url.path, "/api/sessions/abc/response")

    def test_default_base_url_follows_config_and_loopback_binds(self) -> None:
        from termdeck.config import TermdeckConfig

        with mock.patch.object(TermdeckConfig, "HOST", "0.0.0.0"), \
                mock.patch.object(TermdeckConfig, "PORT", 9000):
            self.assertEqual(default_base_url(), "http://127.0.0.1:9000")
        with mock.patch.object(TermdeckConfig, "HOST", "127.0.0.1"), \
                mock.patch.object(TermdeckConfig, "PORT", 8530):
            self.assertEqual(default_base_url(), "http://127.0.0.1:8530")


class McpCliTest(unittest.TestCase):
    def test_parser_accepts_the_mcp_subcommand(self) -> None:
        from termdeck.cli import TermdeckCli

        args = TermdeckCli.build_parser().parse_args(["--port", "9000", "mcp"])
        self.assertEqual(args.command, "mcp")
        self.assertEqual(args.port, 9000)

    def test_main_dispatches_mcp_without_serving(self) -> None:
        from termdeck.cli import TermdeckCli

        with mock.patch("termdeck.mcp_server.run_mcp_server") as run_server:
            self.assertEqual(TermdeckCli.main(["mcp"]), TermdeckCli.EXIT_OK)
        run_server.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
