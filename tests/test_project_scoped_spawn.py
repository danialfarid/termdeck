import asyncio
import json
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from termdeck.mcp_server import TermdeckMcpClient
from termdeck.server import CreateSessionRequest, RunTerminalTaskRequest, TermdeckServer


class ProjectScopedSpawnTest(unittest.TestCase):
    def setUp(self) -> None:
        self.server = object.__new__(TermdeckServer)
        self.server.manager = Mock()
        self.server.manager.registry.root_for.side_effect = {"stock": "/projects/stock", "other": "/projects/other"}.get
        self.server.manager.session_summary_by_id.return_value = {
            "project": "stock", "cwd": "/worktrees/feature", "worktree_id": "feature"}
        self.server._resolve_origin_session = Mock(return_value="parent")
        self.server.worktree_registry = Mock()
        self.server.worktree_registry.get.return_value = SimpleNamespace(path="/worktrees/feature")

    def test_unscoped_creation_inherits_parent_for_both_entry_points(self) -> None:
        for request_class in (CreateSessionRequest, RunTerminalTaskRequest):
            result = self.server._resolve_creation_scope(request_class(origin_session="parent"))
            self.assertEqual((result.project, result.worktree_id, result.cwd),
                             ("stock", "feature", "/worktrees/feature"))

    def test_explicit_project_uses_destination_root(self) -> None:
        result = self.server._resolve_creation_scope(CreateSessionRequest(project="other", origin_session="parent"))
        self.assertEqual((result.worktree_id, result.cwd), ("root", str(Path('/projects/other').resolve())))

    def test_explicit_worktree_uses_registered_directory(self) -> None:
        result = self.server._resolve_creation_scope(CreateSessionRequest(project="stock", worktree_id="feature"))
        self.assertEqual(result.cwd, "/worktrees/feature")
        self.server.worktree_registry.get.assert_called_once_with("stock", "/projects/stock", "feature")

    def test_conflicting_cwd_and_unknown_project_are_rejected(self) -> None:
        for request in (CreateSessionRequest(project="missing"),
                        CreateSessionRequest(project="other", cwd="/projects/stock"),
                        CreateSessionRequest(project="stock", worktree_id="feature", cwd="/projects/stock"),
                        CreateSessionRequest(project="other", origin_session="parent", fork=True)):
            with self.assertRaises(ValueError):
                self.server._resolve_creation_scope(request)

    def test_scoped_route_passes_project_and_rejects_body_conflict(self) -> None:
        self.server._create_session = AsyncMock(return_value={"session_id": "new"})
        app = FastAPI()
        app.post("/api/projects/{project}/sessions")(self.server._create_project_session)
        with TestClient(app) as client:
            self.assertEqual(client.post('/api/projects/stock/sessions', json={"model": "codex"}).status_code, 200)
            self.assertEqual(self.server._create_session.call_args.args[0].project, "stock")
            self.assertEqual(client.post('/api/projects/stock/sessions', json={"project": "other"}).status_code, 400)

    def test_unknown_worktree_is_rejected(self) -> None:
        self.server.worktree_registry.get.side_effect = ValueError("unknown worktree")
        with self.assertRaisesRegex(ValueError, "unknown worktree"):
            self.server._resolve_creation_scope(CreateSessionRequest(project="stock", worktree_id="missing"))

    def test_fork_cannot_silently_ignore_explicit_root_scope(self) -> None:
        with self.assertRaisesRegex(ValueError, "forking into root"):
            self.server._resolve_creation_scope(CreateSessionRequest(
                project="stock", origin_session="parent", fork=True))

    def test_mcp_scoped_route_and_discovery(self) -> None:
        requests = []
        transport = httpx.MockTransport(lambda request: requests.append(request) or httpx.Response(200, json={}))
        client = TermdeckMcpClient(base_url="http://localhost:8530", transport=transport)
        asyncio.run(client.spawn_agent(project="stock", worktree_id="feature", prompt="review"))
        self.assertEqual(requests[-1].url.path, '/api/projects/stock/sessions')
        self.assertEqual(json.loads(requests[-1].content)['worktree_id'], 'feature')
        asyncio.run(client.list_projects())
        self.assertEqual(requests[-1].url.path, '/api/projects')
        asyncio.run(client.list_worktrees(project="stock"))
        self.assertEqual(requests[-1].url.params['project'], 'stock')
