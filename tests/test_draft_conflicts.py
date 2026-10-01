"""A window may only push a draft from the copy it has.

Every window keeps its own copy of a session's draft and pushes the whole text back over the
terminal websocket, so a window left open while the draft was typed somewhere else pushed its stale
copy over the newer one on its next sync -- a backgrounded phone was enough. The newer text was
gone, and nothing anywhere held it. A push now says which revision it was made from; one made from
an older copy is refused, the newer text survives, and the refused text is kept in the draft's
history rather than lost. The same two answers notes got for the same corruption.
"""

import asyncio
import json
import os
import shutil
import subprocess
import tempfile
import unittest
import unittest.mock
from pathlib import Path

from tests.environment import TEST_DATA_DIRECTORY  # noqa: F401  (redirect DATA_DIR before config loads)
from tests.test_terminal_cycle_order import method_source
from termdeck.config import TermdeckConfig
from termdeck.file_history_service import FileHistoryService
from termdeck.models import SessionRecord, WsMessageFields
from termdeck.session_manager import ManagedSession, TerminalSessionManager

STATIC = Path(__file__).resolve().parent.parent / "termdeck" / "static"


def record(session_id: str = "draft1") -> SessionRecord:
    return SessionRecord(session_id=session_id, title="session", title_user_set=True, command="",
                         cwd="/tmp", agent_kind="none", agent_session_id=None,
                         created_at_est="2026-01-01T00:00:00", draft="", project="test")


def manager_with_session(test: unittest.TestCase) -> tuple[TerminalSessionManager, ManagedSession, asyncio.Queue]:
    manager = TerminalSessionManager()
    directory = tempfile.mkdtemp()
    test.addCleanup(shutil.rmtree, directory, True)
    manager.draft_history = FileHistoryService(Path(directory) / "draft-history.sqlite3",
                                               TermdeckConfig.DRAFT_HISTORY_MAX_VERSIONS_PER_DRAFT)
    session = ManagedSession(record())
    manager._sessions = {session.record.session_id: session}
    manager._schedule_draft_persist = lambda: None  # type: ignore[method-assign]
    manager.replay = unittest.mock.MagicMock()
    queue: asyncio.Queue = asyncio.Queue()
    session.client_queues.add(queue)
    return manager, session, queue


def broadcasts(queue: asyncio.Queue) -> list[dict]:
    messages = []
    while True:
        try:
            messages.append(queue.get_nowait())
        except asyncio.QueueEmpty:
            return messages


class DraftRevisionTest(unittest.TestCase):
    def test_first_push_starts_the_revision(self) -> None:
        manager, session, queue = manager_with_session(self)

        manager.set_draft(session.record.session_id, "hello", base_revision=0)

        self.assertEqual(session.record.draft, "hello")
        self.assertEqual(session.record.draft_revision, 1)
        self.assertEqual(broadcasts(queue), [{"type": "draft", "draft": "hello", "draft_revision": 1}])

    def test_pushes_from_the_current_copy_are_accepted(self) -> None:
        manager, session, queue = manager_with_session(self)

        manager.set_draft(session.record.session_id, "hello", base_revision=0)
        manager.set_draft(session.record.session_id, "hello there", base_revision=1)

        self.assertEqual(session.record.draft, "hello there")
        self.assertEqual(session.record.draft_revision, 2)

    def test_stale_push_is_refused_and_current_text_survives(self) -> None:
        manager, session, queue = manager_with_session(self)
        manager.set_draft(session.record.session_id, "four or five lines of typing", base_revision=0)
        broadcasts(queue)

        manager.set_draft(session.record.session_id, "es", base_revision=0)

        self.assertEqual(session.record.draft, "four or five lines of typing")
        self.assertEqual(session.record.draft_revision, 1)
        refused = broadcasts(queue)
        self.assertEqual(len(refused), 1)
        self.assertTrue(refused[0].get("draft_conflict"))
        self.assertEqual(refused[0]["draft"], "four or five lines of typing")
        self.assertEqual(refused[0]["draft_revision"], 1)

    def test_refused_text_is_kept_in_history(self) -> None:
        manager, session, _queue = manager_with_session(self)
        manager.set_draft(session.record.session_id, "four or five lines of typing", base_revision=0)

        manager.set_draft(session.record.session_id, "es", base_revision=0)

        versions = manager.draft_history.list_versions("/drafts", "draft1.md")
        refused = [version for version in versions if version["source"] == "refused"]
        self.assertEqual(len(refused), 1)
        self.assertEqual(manager.draft_history.get_version(refused[0]["version_id"])["content"], "es")

    def test_push_without_a_version_is_taken_as_before(self) -> None:
        # A client from before revisions says nothing about the copy it wrote from. Notes refuse such
        # a write, but a draft push is an invisible background sync: refusing it would silently unsync
        # a cached client's live typing, which is the loss this fix exists to prevent. It lands, and
        # what it replaced is in the history.
        manager, session, _queue = manager_with_session(self)
        manager.set_draft(session.record.session_id, "typed here", base_revision=0)

        manager.set_draft(session.record.session_id, "typed on an old client")

        self.assertEqual(session.record.draft, "typed on an old client")
        self.assertEqual(session.record.draft_revision, 2)

    def test_resync_of_current_text_is_acknowledged_not_refused(self) -> None:
        # A reconnect flushes whatever it holds; when that is already the current text there is
        # nothing to refuse, however old the copy it was made from claims to be.
        manager, session, queue = manager_with_session(self)
        manager.set_draft(session.record.session_id, "hello", base_revision=0)
        broadcasts(queue)

        manager.set_draft(session.record.session_id, "hello", base_revision=0)

        self.assertEqual(session.record.draft_revision, 1)
        acked = broadcasts(queue)
        self.assertEqual(len(acked), 1)
        self.assertNotIn("draft_conflict", acked[0])
        self.assertEqual(acked[0]["draft_revision"], 1)

    def test_terminal_typing_advances_the_revision(self) -> None:
        manager, session, queue = manager_with_session(self)

        manager.write_input(session.record.session_id, "hello")

        self.assertEqual(session.record.draft, "hello")
        self.assertEqual(session.record.draft_revision, 1)
        moved = broadcasts(queue)
        drafts = [message for message in moved if message.get("type") == "draft"]
        self.assertEqual(drafts, [{"type": "draft", "draft": "hello", "draft_revision": 1}])

    def test_every_accepted_change_is_kept_in_history(self) -> None:
        manager, session, _queue = manager_with_session(self)

        manager.set_draft(session.record.session_id, "first", base_revision=0)
        manager.set_draft(session.record.session_id, "second", base_revision=1)

        contents = [manager.draft_history.get_version(version["version_id"])["content"]
                    for version in manager.draft_history.list_versions("/drafts", "draft1.md")]
        self.assertIn("first", contents)
        self.assertIn("second", contents)

    def test_record_written_before_revisions_loads_at_zero(self) -> None:
        payload = record().to_dict()
        del payload["draft_revision"]

        loaded = SessionRecord.from_dict(payload)

        self.assertEqual(loaded.draft_revision, 0)
        self.assertIn("draft_revision", record().to_dict())


SYNC_HARNESS = """
global.WebSocket = { OPEN: 1 };
const scenario = JSON.parse(process.env.TERMDECK_DRAFT_SCENARIO);
const sent = [];
const view = {
  ws: scenario.connected === false ? null : {
    readyState: 1, send: (text) => sent.push(JSON.parse(text)),
  },
  promptDraftRevision: scenario.revision || 0, promptDraftSyncPending: false, promptDraftSyncTimer: 0,
  promptDraftSyncDebounceTimer: 0, pendingDraftSync: null, promptDraftSyncSent: "",
};
const app = { __METHODS__ };
app.sendPromptDraftSync(view, scenario.text);
clearTimeout(view.promptDraftSyncTimer);
clearTimeout(view.promptDraftSyncDebounceTimer);
process.stdout.write(JSON.stringify({ sent, syncSent: view.promptDraftSyncSent,
  pendingSync: view.pendingDraftSync }));
"""

CONFLICT_HARNESS = """
const scenario = JSON.parse(process.env.TERMDECK_DRAFT_SCENARIO);
const pushed = [];
const shown = [];
const app = {
  showPromptDraft: (view) => shown.push(view.promptDraft),
  updateSessionDraftPen: () => {},
  sendPromptDraftSync: (view, text) => pushed.push(
    { text, base: view.promptDraftRevision }),
  __METHODS__
};
const view = { sessionId: "draft1", promptDraft: scenario.local, promptDraftSyncSent: scenario.sent,
  promptDraftRevision: scenario.revision || 0, promptDraftSyncPending: true, promptDraftSyncTimer: 0 };
app.handleDraftConflict(view, scenario.message);
clearTimeout(view.promptDraftSyncTimer);
process.stdout.write(JSON.stringify({ draft: view.promptDraft, revision: view.promptDraftRevision,
  pending: view.promptDraftSyncPending, syncSent: view.promptDraftSyncSent, pushed, shown }));
"""

ADOPT_HARNESS = """
const scenario = JSON.parse(process.env.TERMDECK_DRAFT_SCENARIO);
const pens = [];
const app = {
  activeId: scenario.active || "", historyOpen: !!scenario.historyOpen,
  updateSessionDraftPen: (id) => pens.push(id),
  showPromptDraft: () => {},
  __METHODS__
};
const view = { sessionId: "draft1", promptDraft: scenario.local, promptDraftRevision: scenario.known || 0 };
const adopted = app.adoptSessionDraftFromList(view, scenario.listed);
process.stdout.write(JSON.stringify({ adopted, draft: view.promptDraft, pens }));
"""

REVISION_HARNESS = """
const scenario = JSON.parse(process.env.TERMDECK_DRAFT_SCENARIO);
const app = { __METHODS__ };
const view = { promptDraftRevision: scenario.known || 0 };
app.trackDraftRevision(view, scenario.message);
process.stdout.write(JSON.stringify({ revision: view.promptDraftRevision }));
"""


def run(harness: str, scenario: dict, node: str) -> dict:
    done = subprocess.run([node, "--input-type=module", "-e", harness], capture_output=True, text=True,
                          check=False, env={**os.environ, "TERMDECK_DRAFT_SCENARIO": json.dumps(scenario)})
    if done.returncode != 0:
        raise AssertionError(done.stderr)
    return json.loads(done.stdout)


class DraftSyncClientTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        markdown = (STATIC / "app_markdown_files.js").read_text()
        cls.sync_harness = SYNC_HARNESS.replace(
            "__METHODS__", method_source(markdown, "sendPromptDraftSync(view, text)"))
        terminal = (STATIC / "app_terminal.js").read_text()
        cls.conflict_harness = CONFLICT_HARNESS.replace(
            "__METHODS__", "\n  ".join(method_source(terminal, name) for name in
                                       ("handleDraftConflict(view, msg)", "trackDraftRevision(view, msg)")))
        cls.revision_harness = REVISION_HARNESS.replace(
            "__METHODS__", method_source(terminal, "trackDraftRevision(view, msg)"))
        cls.adopt_harness = ADOPT_HARNESS.replace(
            "__METHODS__", method_source((STATIC / "app.js").read_text(), "adoptSessionDraftFromList(view, s)"))

    def test_push_says_which_copy_it_was_made_from(self) -> None:
        result = run(self.sync_harness, {"text": "hello", "revision": 3}, self.node)

        self.assertEqual(result["sent"], [{"type": "draft_sync", "draft": "hello", "base_revision": 3}])
        self.assertEqual(result["syncSent"], "hello")

    def test_refusal_with_no_typing_since_adopts_the_newer_text(self) -> None:
        result = run(self.conflict_harness, {
            "local": "es", "sent": "es", "revision": 0,
            "message": {"type": "draft", "draft": "four or five lines of typing",
                        "draft_revision": 1, "draft_conflict": True}}, self.node)

        self.assertEqual(result["draft"], "four or five lines of typing")
        self.assertEqual(result["revision"], 1)
        self.assertFalse(result["pending"])
        self.assertEqual(result["pushed"], [])
        self.assertEqual(result["shown"], ["four or five lines of typing"])

    def test_refusal_after_typing_rebases_and_pushes_again(self) -> None:
        result = run(self.conflict_harness, {
            "local": "es, and more", "sent": "es", "revision": 0,
            "message": {"type": "draft", "draft": "four or five lines of typing",
                        "draft_revision": 1, "draft_conflict": True}}, self.node)

        self.assertEqual(result["draft"], "es, and more")
        self.assertEqual(result["pushed"], [{"text": "es, and more", "base": 1}])

    def test_every_draft_message_advances_the_known_revision(self) -> None:
        result = run(self.revision_harness, {"known": 1, "message": {"draft_revision": 4}}, self.node)

        self.assertEqual(result["revision"], 4)

    def test_known_revision_never_moves_backwards(self) -> None:
        result = run(self.revision_harness, {"known": 4, "message": {"draft_revision": 2}}, self.node)

        self.assertEqual(result["revision"], 4)

    def test_list_newer_than_the_copy_held_is_adopted(self) -> None:
        result = run(self.adopt_harness, {
            "local": "old", "known": 1,
            "listed": {"session_id": "draft1", "draft": "newer", "draft_revision": 2}}, self.node)

        self.assertTrue(result["adopted"])
        self.assertEqual(result["draft"], "newer")
        self.assertEqual(result["pens"], ["draft1"])

    def test_stale_list_does_not_wipe_newer_text(self) -> None:
        result = run(self.adopt_harness, {
            "local": "newer", "known": 2,
            "listed": {"session_id": "draft1", "draft": "old", "draft_revision": 1}}, self.node)

        self.assertFalse(result["adopted"])
        self.assertEqual(result["draft"], "newer")
        self.assertEqual(result["pens"], [])


class DraftProtocolTest(unittest.TestCase):
    def test_revision_fields_are_protocol(self) -> None:
        self.assertEqual(WsMessageFields.DRAFT_REVISION, "draft_revision")
        self.assertEqual(WsMessageFields.BASE_REVISION, "base_revision")
        self.assertEqual(WsMessageFields.DRAFT_CONFLICT, "draft_conflict")


class DraftHistoryApiTest(unittest.TestCase):
    def server(self):
        from termdeck.server import TermdeckServer
        manager, _session, _queue = manager_with_session(self)
        server = TermdeckServer.__new__(TermdeckServer)
        server.manager = manager
        return server

    def test_history_serves_every_version_kept(self) -> None:
        server = self.server()
        server.manager.set_draft("draft1", "first", base_revision=0)
        server.manager.set_draft("draft1", "second", base_revision=1)
        server.manager.set_draft("draft1", "stale", base_revision=0)

        payload = asyncio.run(server._draft_history("draft1"))

        by_source = {}
        for version in payload["versions"]:
            content = asyncio.run(server._draft_version("draft1", version["version_id"]))
            by_source.setdefault(version["source"], []).append(content["content"])
        self.assertIn("second", by_source["manual"])
        self.assertIn("first", by_source.get("manual", []) + by_source.get("opened", []))
        self.assertEqual(by_source["refused"], ["stale"])
        self.assertTrue(all(version["captured_at_ms"] > 0 for version in payload["versions"]))

    def test_unknown_session_or_version_is_404(self) -> None:
        from fastapi import HTTPException
        server = self.server()
        server.manager.set_draft("draft1", "first", base_revision=0)

        with self.assertRaises(HTTPException) as missing_session:
            asyncio.run(server._draft_history("nope"))
        self.assertEqual(missing_session.exception.status_code, 404)
        with self.assertRaises(HTTPException) as missing_version:
            asyncio.run(server._draft_version("draft1", 999999))
        self.assertEqual(missing_version.exception.status_code, 404)
