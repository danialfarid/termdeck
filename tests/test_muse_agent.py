"""Muse, Meta's terminal coding agent, as the deck starts and resumes it.

Its sessions are directories rather than files -- the log lives at
`<data home>/muse/sessions/<yyyy>/<mm>/<dd>/<session>/session.jsonl` -- so the id a terminal binds
to is the name of the directory holding the log, and `muse resume <id>` is what reopens it.
"""

import asyncio
import json
import os
import time
import unittest
from datetime import timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from termdeck import agents
from termdeck.agent_session_tracker import AgentSessionTracker
from termdeck.agents.muse import MuseCli
from termdeck.proc_tree import ProcTreeSnapshot
from termdeck.util import TimeUtil


class RegisteredTest(unittest.TestCase):
    def test_the_deck_offers_it(self) -> None:
        self.assertIn("muse", agents.AGENT_CLIS)
        self.assertIs(type(agents.agent_cli("muse")), MuseCli)

    def test_a_muse_command_is_recognised_as_one(self) -> None:
        # What a terminal started from the command line is detected as, and what its dialog shows.
        self.assertEqual(agents.detect_agent_cli("muse --approval-mode never").kind, "muse")

    def test_a_muse_log_is_recognised_as_its_own(self) -> None:
        log = MuseCli.sessions_root / "2026" / "09" / "24" / "01a0-one" / MuseCli.SESSION_LOG_NAME

        self.assertEqual(agents.agent_for_transcript_path(log).kind, "muse")

    def test_it_says_how_to_get_it(self) -> None:
        self.assertIn("muse", MuseCli.install_hint.lower())


class TranscriptModelTest(unittest.TestCase):
    """Selecting the model from the transcript view, the way claude's /model works.

    The transcript's model badge is clickable only for an agent that names a model command,
    and the chooser sends that command with the picked model through the prompt API.
    """

    def setUp(self) -> None:
        self.cli = MuseCli()

    def test_the_transcript_sends_a_model_command(self) -> None:
        # Seen in a real session log: a `command.invoked` record with command `/model`.
        self.assertEqual(self.cli.model_command(), "/model")

    def test_the_transcript_offers_changing_the_model(self) -> None:
        self.assertIn(("/model", "Change the active model"), self.cli.transcript_commands)

    def test_the_client_learns_the_model_command(self) -> None:
        # client_descriptor is what /api/agents serves; the badge reads model_command off it.
        self.assertEqual(self.cli.client_descriptor()["model_command"], "/model")


class TranscriptParsingTest(unittest.TestCase):
    """The session log parsed into turns, in the shapes a real log writes."""

    def setUp(self) -> None:
        self.cli = MuseCli()

    @staticmethod
    def line(payload_type: str, payload: dict, recorded_at: int = 1790290923224584) -> str:
        return json.dumps({"schema_version": 1, "id": "x", "stream": {"kind": "session", "id": "s"},
                           "sequence": 1, "recorded_at": recorded_at, "record_type": "event",
                           "durability": "durable", "causation_id": None, "payload_type": payload_type,
                           "payload_schema_version": 1, "payload": payload})

    def run_line(self, event: dict, recorded_at: int = 1790290923224584) -> str:
        return self.line("runtime.session", {"kind": "run", "run_id": "r", "event": event}, recorded_at)

    def test_a_submitted_prompt_is_a_user_turn(self) -> None:
        turns = self.cli.parse_transcript_lines([self.run_line({"kind": "started", "prompt": "hello there"})])

        self.assertEqual([(turn["role"], turn["text"]) for turn in turns], [("user", "hello there")])
        self.assertEqual(turns[0]["timestamp"], 1790290923224584 / 1_000_000)

    def test_an_answer_is_an_assistant_turn(self) -> None:
        turns = self.cli.parse_transcript_lines(
            [self.run_line({"kind": "assistant_message_committed", "message_id": "m", "text": "done"})])

        self.assertEqual([(turn["role"], turn["text"]) for turn in turns], [("assistant", "done")])

    def test_a_forked_turn_is_prompt_and_answer(self) -> None:
        line = json.dumps({"payload_type": "session.fork.turn",
                           "payload": {"turn": {"prompt": "remember this", "answer": "echo: remember this",
                                                "source": {"started_recorded_at": 1790290923224584,
                                                           "answer_recorded_at": 1790290924224584}}}})
        turns = self.cli.parse_transcript_lines([line])

        self.assertEqual([(turn["role"], turn["text"]) for turn in turns],
                         [("user", "remember this"), ("assistant", "echo: remember this")])
        self.assertEqual(turns[0]["timestamp"], 1790290923224584 / 1_000_000)
        self.assertEqual(turns[1]["timestamp"], 1790290924224584 / 1_000_000)

    def test_tool_calls_and_results_are_events(self) -> None:
        lines = [self.run_line({"kind": "assistant_tool_calls_committed", "message_id": "m",
                                "tool_calls": [{"name": "search", "args": '{"pattern": "x"}'}]}),
                 self.run_line({"kind": "tool_result_batch_committed", "batch_id": "b",
                                "results": [{"text": "found it"}]})]
        turns = self.cli.parse_transcript_lines(lines)

        self.assertEqual(turns[0]["role"], "event")
        self.assertIn("search", turns[0]["title"])
        self.assertIn("found it", turns[1]["text"])

    def test_machinery_is_not_conversation(self) -> None:
        lines = [self.run_line({"kind": "reasoning_committed", "text": "", "encrypted_content": "xyz"}),
                 self.run_line({"kind": "context_block_diagnostic"}),
                 self.run_line({"kind": "started", "prompt": "hi"})]
        turns = self.cli.parse_transcript_lines(lines)

        self.assertEqual([turn["role"] for turn in turns], ["user"])

    def test_the_intent_record_does_not_double_the_prompt(self) -> None:
        # The accepted intent carries the same prompt as the run's started event.
        lines = [self.run_line({"kind": "started", "prompt": "hi"}),
                 self.line("runtime.user_intent.accepted",
                           {"intent_id": "r", "refill_blocks": [{"kind": "text", "text": "hi"}]})]

        self.assertEqual(len(self.cli.parse_transcript_lines(lines)), 1)

    def test_a_retained_frame_yields_its_children(self) -> None:
        child = json.dumps({"schema_version": 1, "payload_type": "runtime.session",
                            "recorded_at": 1790290923224584,
                            "payload": {"kind": "run", "run_id": "r", "event": {"kind": "started", "prompt": "hi"}}})
        line = json.dumps({"retained_frame": "x", "frame_schema_version": 1, "outer_log_ordinal": 1,
                           "children": [{"child_index": 0, "record_json": child}]})

        turns = self.cli.parse_transcript_lines([line, "not json at all"])

        self.assertEqual([(turn["role"], turn["text"]) for turn in turns], [("user", "hi")])

    def test_the_model_comes_from_the_configuration(self) -> None:
        lines = [self.line("run.model.configured",
                           {"kind": "run_model", "record": {"model_id": "muse-spark-1.3-contributor"}}),
                 self.run_line({"kind": "assistant_message_committed", "message_id": "m", "text": "done"})]
        turns = self.cli.parse_transcript_lines(lines)

        self.assertEqual(turns[0].get("model"), "muse-spark-1.3-contributor")

    def test_user_payloads_timestamps_titles_cwd_and_usage(self) -> None:
        started = self.run_line({"kind": "started", "prompt": "hi"})
        answer = self.run_line({"kind": "assistant_message_committed", "message_id": "m", "text": "done"})
        usage = self.run_line({"kind": "model_completed", "model": "muse-spark-1.3-contributor",
                               "usage": {"input_tokens": 100, "output_tokens": 10, "cached_tokens": 5,
                                         "cache_read_tokens": 2, "cache_write_tokens": 1}})

        started_payload = json.loads(started)
        self.assertTrue(self.cli.is_user_payload(started_payload))
        self.assertFalse(self.cli.is_user_payload(json.loads(answer)))
        self.assertEqual(self.cli.user_payload_timestamp(started_payload), 1790290923224584 / 1_000_000)
        self.assertIn("hi", self.cli.payload_text(started_payload))
        self.assertIn("done", self.cli.payload_text(json.loads(answer)))
        self.assertTrue(self.cli.is_conversation_payload(started_payload))
        self.assertEqual(self.cli.title_from_payload(
            json.loads(self.line("session.name.changed", {"new_name": "cerulean-draco"}))), "cerulean-draco")
        self.assertEqual(self.cli.cwd_from_payload(
            Path("/x"), json.loads(self.line("runtime.session.route_facts",
                                             {"kind": "route_facts", "record": {"cwd": "/work"}}))), "/work")
        report = self.cli.usage_from_payload(json.loads(usage))
        self.assertIsNotNone(report)
        assert report is not None
        self.assertEqual(report["output_tokens"], 10)
        self.assertEqual(report["context_tokens"], 100 + 5 + 2 + 1)


class AttentionTest(unittest.TestCase):
    def test_the_trust_prompt_asks_for_you(self) -> None:
        # What muse opens an untrusted workspace with, seen on a real terminal. Markers are matched
        # against lowercased output.
        drawn = "Do you trust this workspace?\n> 1  Trust and continue\n  2  Quit".lower()

        self.assertTrue(any(marker in drawn for marker in MuseCli.attention_output_markers))

    def test_the_tool_approval_asks_for_you(self) -> None:
        # Approvals report structurally off the log rather than by screen text: the footer
        # matches ordinary conversation too. See ApprovalAttentionTest.
        drawn = ("Would you like to allow this network access?"
                 " 4. No, and tell Muse Code what to do differently (esc)").lower()

        self.assertFalse(any(marker in drawn for marker in MuseCli.attention_output_markers))

    def test_thinking_out_loud_does_not_ask_for_you(self) -> None:
        # Past badges latched on conversation text: the picker hint and the approval footer both
        # match prose, so an agent merely discussing them re-raised attention while thinking.
        # Approvals now report structurally off the log instead; only the trust question keeps a
        # text marker, and it stops matching once the session's first run settles that question.
        self.assertEqual(MuseCli.attention_output_markers, ("do you trust this workspace?",))
        for drawn in ("use up/down or 1/2, then enter the model id".lower(),
                      "no, and tell muse code what to do differently (esc)".lower()):
            self.assertFalse(any(marker in drawn for marker in MuseCli.attention_output_markers),
                             drawn)

    def test_the_trust_question_expires_after_the_first_run(self) -> None:
        from termdeck.agents.muse import MuseSessionState

        manager = SimpleNamespace(user_recently_typed=lambda ms, seconds: False)
        ms = SimpleNamespace(attention_required=False, attention_text_carry="",
                             agent_state=MuseSessionState())
        drawn = b"so -- do you trust this workspace? just asking"

        self.assertTrue(MuseCli().update_attention_from_output(manager, ms, drawn))
        ms.attention_required, ms.attention_text_carry = False, ""
        ms.agent_state.trust_settled = True

        self.assertFalse(MuseCli().update_attention_from_output(manager, ms, drawn))


class ApprovalAttentionTest(unittest.TestCase):
    """Attention off the approval log instead of screen text.

    The log brackets every wait with `approval_wait.effect.started` and its resolution with
    `approval_wait.effect.terminal` for the same pending action, so the badge can both rise
    and clear structurally.
    """

    def setUp(self) -> None:
        from termdeck.agents.muse import MuseSessionState

        self.cli = MuseCli()
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name) / "muse" / "sessions"
        patched = patch.object(MuseCli, "sessions_root", self.root)
        patched.start()
        self.addCleanup(patched.stop)
        self.broadcasts: list[str] = []
        manager = SimpleNamespace(
            _broadcast_status=lambda ms: self.broadcasts.append(ms.record.agent_session_id))
        self.manager = manager
        self.state = MuseSessionState()

    def session(self, session_id: str) -> Path:
        day = TimeUtil.today_est()
        path = self.root / f"{day.year:04d}" / f"{day.month:02d}" / f"{day.day:02d}" / session_id / \
            MuseCli.SESSION_LOG_NAME
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("")
        return path

    @staticmethod
    def approval_line(kind: str, action_id: str) -> str:
        return json.dumps({"payload_type": f"approval_wait.effect.{kind}",
                           "payload": {"kind": "approval_wait_effect",
                                       "record": {"kind": kind, "pending_action_id": action_id}}})

    @staticmethod
    def input_line(kind: str, prompt_id: str) -> str:
        return json.dumps({"payload_type": "runtime.session",
                           "payload": {"kind": "run", "run_id": "run-1",
                                       "event": {"kind": f"user_input_prompt_{kind}",
                                                 "prompt_id": prompt_id}}})

    def ms(self, session_id: str) -> SimpleNamespace:
        return SimpleNamespace(record=SimpleNamespace(agent_session_id=session_id, cwd="/work"),
                               attention_required=False, agent_state=self.state)

    def test_a_waiting_approval_asks_for_you(self) -> None:
        path = self.session("01a0-one")
        path.write_text(self.approval_line("started", "action-1") + "\n")

        self.assertTrue(self.cli.transcript_requires_attention(self.manager, self.ms("01a0-one")))

    def test_nothing_waiting_asks_for_nothing(self) -> None:
        self.session("01a0-one")

        self.assertFalse(self.cli.transcript_requires_attention(self.manager, self.ms("01a0-one")))
        self.assertFalse(self.cli.transcript_requires_attention(
            self.manager, SimpleNamespace(record=SimpleNamespace(agent_session_id=None, cwd="/w"),
                                          attention_required=False, agent_state=self.state)))

    def test_a_resolved_approval_clears_the_badge(self) -> None:
        path = self.session("01a0-one")
        ms = self.ms("01a0-one")
        path.write_text(self.approval_line("started", "action-1") + "\n")
        self.cli.on_transcript_event(self.manager, ms, path)

        self.assertTrue(ms.attention_required)
        path.write_text(path.read_text() + self.approval_line("terminal", "action-1") + "\n")
        self.cli.on_transcript_event(self.manager, ms, path)

        self.assertFalse(ms.attention_required)
        self.assertEqual(self.broadcasts, ["01a0-one", "01a0-one"])

    def test_an_unrelated_log_is_ignored(self) -> None:
        elsewhere = self.session("01a0-two")
        elsewhere.write_text(self.approval_line("started", "action-9") + "\n")
        ms = self.ms("01a0-one")

        self.cli.on_transcript_event(self.manager, ms, elsewhere)

        self.assertFalse(ms.attention_required)
        self.assertEqual(self.broadcasts, [])

    def test_a_waiting_input_prompt_asks_for_you(self) -> None:
        path = self.session("01a0-one")
        path.write_text(self.input_line("requested", "prompt-1") + "\n")

        self.assertTrue(self.cli.transcript_requires_attention(self.manager, self.ms("01a0-one")))

    def test_a_settled_input_prompt_asks_for_nothing(self) -> None:
        path = self.session("01a0-one")
        path.write_text(self.input_line("requested", "prompt-1") + "\n" +
                        self.input_line("settled", "prompt-1") + "\n")

        self.assertFalse(self.cli.transcript_requires_attention(self.manager, self.ms("01a0-one")))

    def test_a_settled_prompt_clears_the_badge(self) -> None:
        path = self.session("01a0-one")
        ms = self.ms("01a0-one")
        path.write_text(self.input_line("requested", "prompt-1") + "\n")
        self.cli.on_transcript_event(self.manager, ms, path)

        self.assertTrue(ms.attention_required)
        path.write_text(path.read_text() + self.input_line("settled", "prompt-1") + "\n")
        self.cli.on_transcript_event(self.manager, ms, path)

        self.assertFalse(ms.attention_required)
        self.assertEqual(self.broadcasts, ["01a0-one", "01a0-one"])

    def test_a_prompt_and_an_approval_share_the_badge(self) -> None:
        path = self.session("01a0-one")
        ms = self.ms("01a0-one")
        path.write_text(self.approval_line("started", "action-1") + "\n" +
                        self.input_line("requested", "prompt-1") + "\n")

        self.assertTrue(self.cli.transcript_requires_attention(self.manager, ms))
        path.write_text(path.read_text() + self.input_line("settled", "prompt-1") + "\n")

        self.assertTrue(self.cli.transcript_requires_attention(self.manager, ms))
        path.write_text(path.read_text() + self.approval_line("terminal", "action-1") + "\n")

        self.assertFalse(self.cli.transcript_requires_attention(self.manager, ms))

    def test_the_first_run_settles_the_trust_question(self) -> None:
        path = self.session("01a0-one")
        path.write_text(json.dumps({"payload_type": "runtime.session", "recorded_at": 1,
                                    "payload": {"kind": "run", "event": {"kind": "started",
                                                                        "prompt": "hi"}}}) + "\n")
        ms = self.ms("01a0-one")

        self.cli.on_transcript_event(self.manager, ms, path)

        self.assertTrue(ms.agent_state.trust_settled)


class RunStateTest(unittest.TestCase):
    """Processing off the log's started/terminal run brackets instead of output flow.

    Output flow read every TUI redraw as work (progress stuck on at idle) and went blind
    while the user typed (the input-suppress window drops output as echo). The log
    brackets every run structurally, and typing never touches those records.
    """

    def setUp(self) -> None:
        from termdeck.agents.muse import MuseSessionState

        self.cli = MuseCli()
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name) / "muse" / "sessions"
        patched = patch.object(MuseCli, "sessions_root", self.root)
        patched.start()
        self.addCleanup(patched.stop)
        self.status_broadcasts: list[str] = []
        self.processing_broadcasts: list[bool] = []
        self.manager = SimpleNamespace(
            _broadcast_status=lambda ms: self.status_broadcasts.append(ms.record.agent_session_id),
            _broadcast_processing=lambda ms, processing: self.processing_broadcasts.append(processing),
            _processing_state=lambda ms: self.cli.is_processing(ms))
        self.state = MuseSessionState()

    def session(self, session_id: str) -> Path:
        day = TimeUtil.today_est()
        path = self.root / f"{day.year:04d}" / f"{day.month:02d}" / f"{day.day:02d}" / session_id / \
            MuseCli.SESSION_LOG_NAME
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("")
        return path

    @staticmethod
    def run_line(kind: str, run_id: str) -> str:
        return json.dumps({"payload_type": "runtime.session",
                           "payload": {"kind": "run", "run_id": run_id, "event": {"kind": kind}}})

    def ms(self, session_id: str | None) -> SimpleNamespace:
        return SimpleNamespace(record=SimpleNamespace(agent_session_id=session_id, cwd="/work"),
                               attention_required=False, processing=False, running=True,
                               agent_state=self.state)

    def subagent_log(self, session_id: str, subagent_id: str) -> Path:
        path = self.session(session_id).parent / "subagent" / subagent_id / MuseCli.SESSION_LOG_NAME
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("")
        return path

    def test_an_open_run_is_processing(self) -> None:
        path = self.session("01a0-one")
        path.write_text(self.run_line("started", "run-1") + "\n")
        ms = self.ms("01a0-one")

        self.cli.refresh_activity_for_status(self.manager, ms)

        self.assertTrue(self.cli.is_processing(ms))

    def test_a_closed_run_is_idle(self) -> None:
        path = self.session("01a0-one")
        path.write_text(self.run_line("started", "run-1") + "\n" +
                        self.run_line("terminal", "run-1") + "\n")
        ms = self.ms("01a0-one")

        self.cli.refresh_activity_for_status(self.manager, ms)

        self.assertFalse(self.cli.is_processing(ms))

    def test_a_retracted_run_closes_early(self) -> None:
        path = self.session("01a0-one")
        path.write_text(self.run_line("started", "run-1") + "\n" +
                        self.run_line("run_retracted", "run-1") + "\n")
        ms = self.ms("01a0-one")

        self.cli.refresh_activity_for_status(self.manager, ms)

        self.assertFalse(self.cli.is_processing(ms))

    def test_mid_run_events_do_not_close_or_latch(self) -> None:
        path = self.session("01a0-one")
        path.write_text(self.run_line("started", "run-1") + "\n" +
                        self.run_line("model_completed", "run-1") + "\n" +
                        self.run_line("tool_result_batch_committed", "run-1") + "\n")
        ms = self.ms("01a0-one")

        self.cli.refresh_activity_for_status(self.manager, ms)

        self.assertTrue(self.cli.is_processing(ms))
        self.assertTrue(self.state.run_state_known)

    def test_output_flow_is_the_fallback_until_the_first_scan(self) -> None:
        ms = self.ms("01a0-one")
        self.state.output_active_until = time.monotonic() + 10

        self.assertTrue(self.cli.is_processing(ms))
        self.state.output_active_until = time.monotonic() - 10

        self.assertFalse(self.cli.is_processing(ms))

    def test_typing_never_clears_log_derived_processing(self) -> None:
        path = self.session("01a0-one")
        path.write_text(self.run_line("started", "run-1") + "\n")
        ms = self.ms("01a0-one")
        self.cli.refresh_activity_for_status(self.manager, ms)

        ms.last_input_monotonic = time.monotonic()  # a keystroke this instant

        self.assertTrue(self.cli.is_processing(ms))

    def test_a_torn_final_line_waits_for_its_rest(self) -> None:
        path = self.session("01a0-one")
        path.write_text(self.run_line("started", "run-1") + "\n")
        self.cli._scan_run_state(path, self.state)
        with path.open("ab") as handle:
            handle.write(self.run_line("terminal", "run-1").encode()[:40])

        self.assertFalse(self.cli._scan_run_state(path, self.state))
        self.assertEqual(self.state.open_runs, {"run-1"})
        with path.open("ab") as handle:
            handle.write(self.run_line("terminal", "run-1").encode()[40:] + b"\n")

        self.assertTrue(self.cli._scan_run_state(path, self.state))
        self.assertEqual(self.state.open_runs, set())

    def test_a_rewrite_without_shrink_rescans_from_the_start(self) -> None:
        # Compaction rewrites the log without necessarily shrinking it below the old offset;
        # a shrink-only check would keep parsing at the stale offset and miss the close.
        path = self.session("01a0-one")
        started = self.run_line("started", "run-1") + "\n"
        path.write_text(started)
        self.cli._scan_run_state(path, self.state)
        terminal = self.run_line("terminal", "run-1") + "\n"
        path.write_text(terminal + "x" * len(started) + "\n")

        self.assertTrue(self.cli._scan_run_state(path, self.state))
        self.assertEqual(self.state.open_runs, set())

    def test_an_inode_change_rescans_from_the_start(self) -> None:
        path = self.session("01a0-one")
        path.write_text(self.run_line("started", "run-1") + "\n")
        self.cli._scan_run_state(path, self.state)
        self.state.run_scan_inode = -1

        changed = self.cli._scan_run_state(path, self.state)

        self.assertFalse(changed)
        self.assertEqual(self.state.open_runs, {"run-1"})
        self.assertEqual(self.state.run_scan_inode, path.stat().st_ino)

    def test_a_write_racing_the_scan_aborts_the_commit(self) -> None:
        path = self.session("01a0-one")
        path.write_text(self.run_line("started", "run-1") + "\n")
        self.cli._scan_run_state(path, self.state)
        committed = self.state.run_scan_offset
        with path.open("ab") as handle:
            handle.write((self.run_line("terminal", "run-1") + "\n").encode())
        real_fstat = os.fstat
        calls = []

        def racing_fstat(fd):
            stats = real_fstat(fd)
            calls.append(fd)
            if len(calls) == 2:
                return SimpleNamespace(st_ino=stats.st_ino, st_size=stats.st_size,
                                       st_mtime_ns=stats.st_mtime_ns + 1)
            return stats

        with patch("termdeck.agents.muse.os.fstat", side_effect=racing_fstat):
            changed = self.cli._scan_run_state(path, self.state)

        self.assertFalse(changed)
        self.assertEqual(self.state.run_scan_offset, committed)

    def test_a_truncated_log_rescans_from_the_start(self) -> None:
        path = self.session("01a0-one")
        path.write_text(self.run_line("started", "run-1") + "\n" +
                        self.run_line("model_completed", "run-1") + "\n" +
                        self.run_line("tool_result_batch_committed", "run-1") + "\n")
        self.cli._scan_run_state(path, self.state)
        path.write_text(self.run_line("terminal", "run-1") + "\n")

        self.assertTrue(self.cli._scan_run_state(path, self.state))
        self.assertEqual(self.state.open_runs, set())

    def test_run_edges_broadcast_from_transcript_events(self) -> None:
        path = self.session("01a0-one")
        ms = self.ms("01a0-one")
        path.write_text(self.run_line("started", "run-1") + "\n")
        self.cli.on_transcript_event(self.manager, ms, path)

        self.assertEqual(self.processing_broadcasts, [True])
        self.assertEqual(self.status_broadcasts, ["01a0-one"])
        path.write_text(path.read_text() + self.run_line("terminal", "run-1") + "\n")
        self.cli.on_transcript_event(self.manager, ms, path)

        self.assertEqual(self.processing_broadcasts, [True, False])
        self.assertEqual(self.status_broadcasts, ["01a0-one", "01a0-one"])

    def test_an_unbound_session_keeps_the_output_signal(self) -> None:
        ms = self.ms(None)
        self.state.output_active_until = time.monotonic() + 10

        self.cli.refresh_activity_for_status(self.manager, ms)

        self.assertFalse(self.state.run_state_known)
        self.assertTrue(self.cli.is_processing(ms))

    def test_an_open_subagent_run_marks_processing_and_dot(self) -> None:
        # The main run closes while its workflow's children are still working.
        self.subagent_log("01a0-one", "sub-1").write_text(self.run_line("started", "run-9") + "\n")
        self.session("01a0-one").write_text(self.run_line("started", "run-1") + "\n" +
                                            self.run_line("terminal", "run-1") + "\n")
        ms = self.ms("01a0-one")

        self.cli.refresh_activity_for_status(self.manager, ms)

        self.assertTrue(self.cli.is_processing(ms))
        self.assertEqual(self.cli.activity_detail(ms), {"main": False, "subagents": 1})

    def test_a_closed_subagent_run_clears(self) -> None:
        self.session("01a0-one").write_text("")
        sub = self.subagent_log("01a0-one", "sub-1")
        sub.write_text(self.run_line("started", "run-9") + "\n")
        ms = self.ms("01a0-one")
        self.cli.refresh_activity_for_status(self.manager, ms)
        sub.write_text(sub.read_text() + self.run_line("terminal", "run-9") + "\n")

        self.cli.refresh_activity_for_status(self.manager, ms)

        self.assertFalse(self.cli.is_processing(ms))
        self.assertEqual(self.cli.activity_detail(ms), {"main": False, "subagents": 0})

    def test_a_pruned_subagent_log_drops_its_cursor(self) -> None:
        self.session("01a0-one").write_text("")
        sub = self.subagent_log("01a0-one", "sub-1")
        sub.write_text(self.run_line("started", "run-9") + "\n")
        ms = self.ms("01a0-one")
        self.cli.refresh_activity_for_status(self.manager, ms)
        self.assertTrue(self.cli.is_processing(ms))
        sub.unlink()
        sub.parent.rmdir()

        self.cli.refresh_activity_for_status(self.manager, ms)

        self.assertFalse(self.cli.is_processing(ms))
        self.assertEqual(self.state.subagent_scans, {})

    def test_main_and_subagent_dots_report_separately(self) -> None:
        self.subagent_log("01a0-one", "sub-1").write_text(self.run_line("started", "run-9") + "\n")
        self.subagent_log("01a0-one", "sub-2").write_text(self.run_line("started", "run-8") + "\n" +
                                                         self.run_line("terminal", "run-8") + "\n")
        self.session("01a0-one").write_text(self.run_line("started", "run-1") + "\n")
        ms = self.ms("01a0-one")

        self.cli.refresh_activity_for_status(self.manager, ms)

        self.assertEqual(self.cli.activity_detail(ms), {"main": True, "subagents": 1})

    def test_a_dead_terminal_reports_no_activity(self) -> None:
        self.session("01a0-one").write_text("")
        self.subagent_log("01a0-one", "sub-1").write_text(self.run_line("started", "run-9") + "\n")
        ms = self.ms("01a0-one")
        self.cli.refresh_activity_for_status(self.manager, ms)
        ms.running = False

        self.assertEqual(self.cli.activity_detail(ms), {"main": False, "subagents": 0})

    def test_subagent_run_edges_broadcast(self) -> None:
        sub = self.subagent_log("01a0-one", "sub-1")
        self.session("01a0-one").write_text(self.run_line("started", "run-1") + "\n" +
                                            self.run_line("terminal", "run-1") + "\n")
        ms = self.ms("01a0-one")
        self.cli.refresh_activity_for_status(self.manager, ms)
        sub.write_text(self.run_line("started", "run-9") + "\n")
        self.cli.on_transcript_event(self.manager, ms, sub)

        self.assertEqual(self.processing_broadcasts, [True])
        sub.write_text(sub.read_text() + self.run_line("terminal", "run-9") + "\n")
        self.cli.on_transcript_event(self.manager, ms, sub)

        self.assertEqual(self.processing_broadcasts, [True, False])

    def test_a_foreign_nested_log_is_ignored(self) -> None:
        self.session("01a0-one").write_text("")
        foreign = self.subagent_log("01a0-two", "sub-1")
        foreign.write_text(self.run_line("started", "run-9") + "\n")
        ms = self.ms("01a0-one")

        self.cli.on_transcript_event(self.manager, ms, foreign)

        self.assertEqual(self.processing_broadcasts, [])
        self.assertEqual(self.state.subagent_scans, {})


class ModelCatalogTest(unittest.TestCase):
    """The models the transcript picker and the spawn dialogs offer.

    muse's TUI keeps its authenticated provider catalog on disk next to the sessions tree,
    so that file is read first; the serve host's bundled list and the install's own recent
    logs cover a missing cache, and each row carries its own reasoning tiers when named.
    """

    def setUp(self) -> None:
        self.cli = MuseCli()
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name) / "muse" / "sessions"
        patched = patch.object(MuseCli, "sessions_root", self.root)
        patched.start()
        self.addCleanup(patched.stop)

    def catalog_file(self, rows: list[dict[str, object]]) -> Path:
        directory = self.root.parent / "model-catalog"
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / "6d657461__p746268.json"
        path.write_text(json.dumps({"schema_version": 1, "provider_id": "meta",
                                    "profile_id": "tbh", "source": "provider_catalog",
                                    "rows": rows}))
        return path

    @staticmethod
    def stored_row(model_id: str, tiers: list[str] | None = None,
                   visibility: str = "visible") -> dict[str, object]:
        row: dict[str, object] = {"model_id": model_id, "display_label": model_id,
                                  "visibility": visibility}
        if tiers is not None:
            row["reasoning_effort_variants"] = [{"tier": tier} for tier in tiers]
        return row

    def session(self, session_id: str, *lines: str) -> Path:
        day = TimeUtil.today_est()
        path = self.root / f"{day.year:04d}" / f"{day.month:02d}" / f"{day.day:02d}" / session_id / \
            MuseCli.SESSION_LOG_NAME
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("".join(lines))
        return path

    def catalog(self, live: list[dict[str, str]]) -> list[dict[str, object]]:
        with patch.object(MuseCli, "_live_catalog", lambda self: live):
            return asyncio.run(self.cli.list_models())

    def test_models_come_from_recent_logs(self) -> None:
        self.session("01a0-one",
                     json.dumps({"payload_type": "run.model.configured",
                                 "payload": {"record": {"model_id": "muse-spark-1.3-contributor"}}}) + "\n",
                     json.dumps({"payload_type": "runtime.session",
                                 "payload": {"kind": "run",
                                             "event": {"kind": "model_completed", "model": "other-model",
                                                       "usage": {}}}}) + "\n")

        models = self.catalog([])

        self.assertEqual([model["id"] for model in models],
                         ["muse-spark-1.3-contributor", "other-model"])
        for model in models:
            self.assertEqual([effort["value"] for effort in model["reasoning_efforts"]],
                             ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"])
            self.assertEqual(model["default_reasoning_effort"], "high")

    def test_the_live_catalog_comes_first_with_its_labels(self) -> None:
        self.session("01a0-one",
                     json.dumps({"payload_type": "run.model.configured",
                                 "payload": {"record": {"model_id": "muse-spark-1.3-contributor"}}}) + "\n")

        models = self.catalog([{"id": "muse-spark-1.3", "label": "Muse Spark",
                                "description": "fast one"}])

        self.assertEqual([(model["id"], model["label"], model["description"]) for model in models],
                         [("muse-spark-1.3", "Muse Spark", "fast one"),
                          ("muse-spark-1.3-contributor", "muse-spark-1.3-contributor", "")])

    def test_a_dead_serve_leaves_the_recent_logs(self) -> None:
        self.session("01a0-one",
                     json.dumps({"payload_type": "run.model.configured",
                                 "payload": {"record": {"model_id": "muse-spark-1.3"}}}) + "\n")
        with patch("termdeck.agents.muse.subprocess.Popen", side_effect=OSError("no muse")):
            models = asyncio.run(MuseCli().list_models())

        self.assertEqual([model["id"] for model in models], ["muse-spark-1.3"])

    def test_the_wire_rows_are_read_off_model_list(self) -> None:
        answer = ("\n".join(json.dumps(payload) for payload in
                             ({"jsonrpc": "2.0", "id": 1, "result": {"serverInfo": {}}},
                              {"jsonrpc": "2.0", "id": 2,
                               "result": {"models": [
                                   {"modelId": "muse-spark-1.3", "displayLabel": "Muse Spark",
                                    "description": None},
                                   {"modelId": "  "},
                                   "not-a-row"]}})) + "\n")

        class FakeServe:
            def communicate(self, *args: object, **kwargs: object) -> tuple[str, str]:
                return answer, ""

        # resolve_binary is pinned: without a muse on PATH it shells out to a login shell,
        # which the Popen fake below cannot serve (and CI has no muse at all).
        with patch("termdeck.agents.muse.subprocess.Popen", lambda *args, **kwargs: FakeServe()), \
             patch("termdeck.agents.muse.PlatformPaths.resolve_binary", return_value="muse"):
            rows = MuseCli()._live_catalog()

        self.assertEqual(rows, [{"id": "muse-spark-1.3", "label": "Muse Spark", "description": "",
                                     "tiers": []}])

    def test_the_stored_catalog_comes_first_and_skips_hidden_rows(self) -> None:
        self.catalog_file([self.stored_row("muse-spark-1.3", ["low", "high"]),
                           self.stored_row("muse-spark-1.2", ["low", "high"]),
                           self.stored_row("muse-spark-0.9", ["low"], visibility="hidden")])
        self.session("01a0-one",
                     json.dumps({"payload_type": "run.model.configured",
                                 "payload": {"record": {"model_id": "muse-spark-1.3"}}}) + "\n")

        models = self.catalog([{"id": "muse-spark-1.1", "label": "old", "description": "",
                                "tiers": []}])

        self.assertEqual([model["id"] for model in models],
                         ["muse-spark-1.3", "muse-spark-1.2", "muse-spark-1.1"])
        self.assertEqual([effort["value"] for effort in models[0]["reasoning_efforts"]],
                         ["low", "high"])
        self.assertEqual(models[0]["default_reasoning_effort"], "high")

    def test_a_row_without_high_defaults_to_its_first_tier(self) -> None:
        self.catalog_file([self.stored_row("muse-spark-1.3", ["minimal", "low"])])

        models = self.catalog([])

        self.assertEqual(models[0]["default_reasoning_effort"], "minimal")

    def test_broken_cache_files_fall_back_to_the_other_sources(self) -> None:
        directory = self.root.parent / "model-catalog"
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "bad.json").write_text("not json{")
        (directory / "empty.json").write_text(json.dumps({"rows": "nope"}))
        self.session("01a0-one",
                     json.dumps({"payload_type": "run.model.configured",
                                 "payload": {"record": {"model_id": "muse-spark-1.3"}}}) + "\n")

        models = self.catalog([])

        self.assertEqual([model["id"] for model in models], ["muse-spark-1.3"])

    def test_no_logs_means_no_catalog(self) -> None:
        self.assertEqual(self.catalog([]), [])


class WatchableRootsTest(unittest.TestCase):
    """The transcript watcher reads `sessions_root` off every agent and calls `is_dir()` on it.

    Handing it something to call instead of a path took the whole server down at startup, and every
    test still passed, because nothing else in the suite touches all the agents at once.
    """

    def test_every_agent_offers_a_path_or_nothing(self) -> None:
        for cli in agents.AGENT_CLIS.values():
            root = getattr(cli, "sessions_root", None)
            with self.subTest(agent=cli.kind):
                self.assertTrue(root is None or isinstance(root, Path), f"{cli.kind}: {root!r}")


class CommandTest(unittest.TestCase):
    def setUp(self) -> None:
        self.cli = MuseCli()

    def test_resuming_keeps_the_options_the_terminal_was_started_with(self) -> None:
        self.assertEqual(self.cli.resume_command("muse --approval-mode never --model m", "abc-123"),
                         "muse --approval-mode never --model m resume abc-123")

    def test_resuming_a_resumed_terminal_does_not_stack_session_refs(self) -> None:
        # The saved command is rewritten as a resume of the bound session, so it is read back often.
        self.assertEqual(self.cli.resume_command("muse resume old-id --model m", "abc-123"),
                         "muse --model m resume abc-123")

    def test_starting_fresh_drops_the_session_it_was_resuming(self) -> None:
        self.assertEqual(self.cli.fresh_session_command("muse resume old-id --model m"), "muse --model m")

    def test_attaching_to_a_session_by_reference(self) -> None:
        self.assertEqual(self.cli.new_session_resume_arguments("my-session", None), ("resume", "my-session"))

    def test_a_trailing_effort_word_is_an_effort_not_a_model(self) -> None:
        # Muse takes the reasoning effort as its own option; leaving it on the id starts nothing.
        self.assertEqual(self.cli.model_arguments("some-model xhigh"),
                         ("--reasoning-effort", "xhigh", "--model", "some-model"))

    def test_a_model_id_is_left_alone(self) -> None:
        self.assertEqual(self.cli.model_arguments("some-model"), ("--model", "some-model"))

    def test_a_model_whose_last_word_is_not_an_effort(self) -> None:
        self.assertEqual(self.cli.model_arguments("some model"), ("--model", "some model"))

    def test_the_permission_modes_are_muse_s_own(self) -> None:
        self.assertEqual(self.cli.permission_flags["never"], ("--approval-mode", "never"))
        self.assertEqual(self.cli.permission_flags["full-access"], ("--yolo",))
        self.assertEqual(self.cli.permission_flags["default"], ())

    def test_swapping_permission_drops_the_named_profile(self) -> None:
        # --permission-profile is muse's own named profile, not one of the deck's modes: keeping
        # it would silently keep the old profile alongside the new mode.
        self.assertEqual(self.cli.set_permission("muse --permission-profile investors --model m", "never"),
                         "muse --approval-mode never --model m")

    def test_a_headless_prompt_is_not_a_session_resume(self) -> None:
        # `resume` after another subcommand is that command's own word, not a session ref.
        self.assertEqual(self.cli.strip_session_arguments(self.cli.command_parts("muse exec resume")),
                         ["muse", "exec", "resume"])
        self.assertEqual(self.cli.fresh_session_command("muse exec resume"), "muse exec resume")

    def test_the_repaint_nudge_holds_past_muse_s_resize_debounce(self) -> None:
        # An 80ms hold coalesces into a no-op on muse (a cursor re-park, never a
        # redraw); 500ms and 3s holds both produce a full frame.
        from termdeck.config import TermdeckConfig
        self.assertEqual(self.cli.repaint_nudge_hold_seconds(),
                         TermdeckConfig.SCREEN_REPAINT_NUDGE_HOLD_MUSE_SECONDS)
        self.assertGreater(TermdeckConfig.SCREEN_REPAINT_NUDGE_HOLD_MUSE_SECONDS,
                           TermdeckConfig.SCREEN_REPAINT_NUDGE_HOLD_SECONDS)


class SessionStoreTest(unittest.TestCase):
    """A session is a directory; the log inside it is what the deck watches."""

    def setUp(self) -> None:
        self.cli = MuseCli()
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name) / "muse" / "sessions"
        patched = patch.object(MuseCli, "sessions_root", self.root)
        patched.start()
        self.addCleanup(patched.stop)

    def day_dir(self, offset_days: int = 0) -> Path:
        day = TimeUtil.today_est() + timedelta(days=offset_days)
        return self.root / f"{day.year:04d}" / f"{day.month:02d}" / f"{day.day:02d}"

    def session(self, session_id: str, offset_days: int = 0) -> Path:
        path = self.day_dir(offset_days) / session_id / MuseCli.SESSION_LOG_NAME
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("")
        return path

    def test_the_log_of_a_session(self) -> None:
        path = self.session("01a0-one")

        self.assertEqual(self.cli.transcript_path(None, "01a0-one"), path)

    def test_each_session_gets_its_own_log(self) -> None:
        # Every session's log is named the same; only the directory holding it tells them apart.
        first, second = self.session("01a0-one"), self.session("01a0-two", offset_days=-1)

        self.assertEqual(self.cli.transcript_path(None, "01a0-one"), first)
        self.assertEqual(self.cli.transcript_path(None, "01a0-two"), second)

    def test_a_session_started_before_midnight(self) -> None:
        # A terminal left running overnight keeps writing into yesterday's day directory.
        path = self.session("01a0-one", offset_days=-1)

        self.assertEqual(self.cli.transcript_path(None, "01a0-one"), path)

    def test_a_session_that_is_not_there(self) -> None:
        self.assertIsNone(self.cli.transcript_path(None, "01a0-missing"))

    def test_what_a_new_terminal_could_bind_to(self) -> None:
        self.session("01a0-one")
        self.session("01a0-two")
        (self.day_dir() / "01a0-empty").mkdir(parents=True, exist_ok=True)

        found = self.cli.candidate_session_files(Path("/workspace"))

        self.assertEqual(sorted(session_id for _, session_id in found), ["01a0-one", "01a0-two"])

    def test_the_session_a_log_belongs_to(self) -> None:
        path = self.session("01a0-one")

        self.assertEqual(self.cli.session_id_from_path(path), "01a0-one")

    def test_another_file_in_the_session_directory_is_not_the_log(self) -> None:
        path = self.session("01a0-one").parent / "notes.json"
        path.write_text("{}")

        self.assertIsNone(self.cli.session_id_from_path(path))

    def test_a_log_belonging_to_another_agent(self) -> None:
        elsewhere = Path(self.directory.name) / "codex" / MuseCli.SESSION_LOG_NAME
        elsewhere.parent.mkdir(parents=True, exist_ok=True)
        elsewhere.write_text("")

        self.assertIsNone(self.cli.session_id_from_path(elsewhere))

    def test_a_stray_log_is_not_a_session(self) -> None:
        # Only <yyyy>/<mm>/<dd>/<session>/session.jsonl names a session: a file directly under
        # the root, or a subagent log nested under its parent, must not bind as one.
        for stray in (self.root / MuseCli.SESSION_LOG_NAME,
                      self.day_dir() / MuseCli.SESSION_LOG_NAME,
                      self.day_dir() / "01a0-one" / "subagent" / "child" / MuseCli.SESSION_LOG_NAME):
            stray.parent.mkdir(parents=True, exist_ok=True)
            stray.write_text("")

            self.assertIsNone(self.cli.session_id_from_path(stray), stray)

    def test_the_title_comes_from_the_session_name(self) -> None:
        path = self.session("01a0-one")
        path.write_text(json.dumps({"payload_type": "session.name.changed",
                                    "payload": {"new_name": "cerulean-draco"}}) + "\n")

        self.assertEqual(self.cli.session_title(None, Path("/work"), "01a0-one"), "cerulean-draco")


class ResumeRefParsingTest(unittest.TestCase):
    def test_a_resume_uuid_is_the_ref(self) -> None:
        self.assertEqual(
            MuseCli.resume_ref_from_parts(["muse", "resume", "01a0-one"]), "01a0-one")

    def test_a_versioned_binary_name_counts_as_muse(self) -> None:
        self.assertEqual(
            MuseCli.resume_ref_from_parts(
                ["/Users/dan/.local/bin/muse-bin-1.4.2-R4684.1", "resume", "01a0-one"]),
            "01a0-one")

    def test_a_name_ref_passes_through_unresolved(self) -> None:
        self.assertEqual(
            MuseCli.resume_ref_from_parts(["muse", "resume", "green-heliosphere"]),
            "green-heliosphere")

    def test_root_flags_before_the_subcommand_are_skipped(self) -> None:
        self.assertEqual(
            MuseCli.resume_ref_from_parts(
                ["muse", "--model", "spark", "--reasoning-effort", "high",
                 "resume", "01a0-one"]),
            "01a0-one")

    def test_a_resume_word_after_another_subcommand_is_not_a_ref(self) -> None:
        self.assertIsNone(MuseCli.resume_ref_from_parts(["muse", "exec", "resume"]))

    def test_a_bare_muse_has_no_ref(self) -> None:
        self.assertIsNone(MuseCli.resume_ref_from_parts(["muse"]))

    def test_last_is_not_a_static_ref(self) -> None:
        self.assertIsNone(MuseCli.resume_ref_from_parts(["muse", "resume", "--last"]))

    def test_a_non_muse_command_has_no_ref(self) -> None:
        self.assertIsNone(MuseCli.resume_ref_from_parts(["codex", "resume", "01a0-one"]))


class ResumeBindingGuardTest(unittest.TestCase):
    EXISTING = "01a0-old"
    FOUND = "01a0-new"

    def setUp(self) -> None:
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name) / "muse" / "sessions"
        patched = patch.object(MuseCli, "sessions_root", self.root)
        patched.start()
        self.addCleanup(patched.stop)
        self.cli = MuseCli()

    def session(self, session_id: str, age_seconds: float = 0) -> Path:
        day = TimeUtil.today_est()
        path = self.root / f"{day.year:04d}" / f"{day.month:02d}" / f"{day.day:02d}" / \
            session_id / MuseCli.SESSION_LOG_NAME
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{}\n")
        moment = time.time() - age_seconds
        os.utime(path, (moment, moment))
        return path

    def verify(self, existing: str | None, found: str | None, argv_ref: str | None) -> str | None:
        tracker = SimpleNamespace(
            muse_resume_ref_from_process_arguments=lambda socket, tree: argv_ref)
        manager = SimpleNamespace(_tracker=tracker)
        ms = SimpleNamespace(record=SimpleNamespace(agent_session_id=existing, cwd="/work"))
        socket = Path("/tmp/fake.sock")
        with patch("termdeck.agents.muse.ProcTreeSnapshot") as snapshot_cls:
            snapshot_cls.capture = AsyncMock(return_value=SimpleNamespace())
            return asyncio.run(self.cli.verify_detected_session_id(manager, ms, found, socket))

    def test_an_unbound_terminal_binds_whatever_was_found(self) -> None:
        self.assertEqual(self.verify(None, self.FOUND, None), self.FOUND)

    def test_nothing_found_binds_nothing(self) -> None:
        self.assertIsNone(self.verify(self.EXISTING, None, None))

    def test_the_current_binding_is_kept(self) -> None:
        self.assertEqual(self.verify(self.EXISTING, self.EXISTING, None), self.EXISTING)

    def test_process_arguments_confirming_the_new_id_rebind(self) -> None:
        self.assertEqual(self.verify(self.EXISTING, self.FOUND, self.FOUND), self.FOUND)

    def test_a_stale_listing_never_moves_the_binding(self) -> None:
        self.session(self.FOUND, age_seconds=86400)
        self.assertIsNone(self.verify(self.EXISTING, self.FOUND, self.EXISTING))

    def test_a_fresh_log_rebinds_past_stale_arguments(self) -> None:
        self.session(self.FOUND, age_seconds=5)
        self.assertEqual(self.verify(self.EXISTING, self.FOUND, self.EXISTING), self.FOUND)

    def test_a_missing_log_is_not_fresh(self) -> None:
        self.assertIsNone(self.verify(self.EXISTING, self.FOUND, self.EXISTING))


class ReconcileBindingTest(unittest.TestCase):
    OLD = "01a0dcd4-99e2-75b0-ada7-7cbf141fc190"
    NEW = "01a0ff0a-3771-7c63-8529-c6b6f6083bf7"

    def setUp(self) -> None:
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name) / "muse" / "sessions"
        patched = patch.object(MuseCli, "sessions_root", self.root)
        patched.start()
        self.addCleanup(patched.stop)
        self.cli = MuseCli()
        self.bound: list[str] = []
        self.claimed: set[str] = set()
        self.manager = SimpleNamespace(
            _tracker=AgentSessionTracker(),
            _dtach_socket=lambda session_id: Path("sock"),
            _claimed_agent_ids=lambda ms: self.claimed,
            _set_agent_session_binding=lambda ms, cid: (
                setattr(ms.record, "agent_session_id", cid), self.bound.append(cid)))

    def session(self, session_id: str, age_seconds: float = 0) -> None:
        day = TimeUtil.today_est()
        path = self.root / f"{day.year:04d}" / f"{day.month:02d}" / f"{day.day:02d}" / \
            session_id / MuseCli.SESSION_LOG_NAME
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{}\n")
        moment = time.time() - age_seconds
        os.utime(path, (moment, moment))

    def tree(self, *commands: str) -> ProcTreeSnapshot:
        processes = [{"pid": 100, "ppid": 1, "command": "dtach"}]
        for index, command in enumerate(commands):
            processes.append({"pid": 110 + index, "ppid": 100, "command": command})
        return ProcTreeSnapshot({"sock": [100]}, processes)

    def reconcile(self, binding: str, live: bool, *commands: str) -> str:
        ms = SimpleNamespace(
            detached_live=live,
            record=SimpleNamespace(session_id="tab1", agent_session_id=binding, cwd="/work"))
        asyncio.run(self.cli.reconcile_bindings(self.manager, ms, self.tree(*commands)))
        return ms.record.agent_session_id

    def test_argv_naming_a_newer_session_rebinds(self) -> None:
        self.session(self.OLD, age_seconds=86400)
        self.session(self.NEW, age_seconds=5)
        self.assertEqual(
            self.reconcile(self.OLD, True, f"muse-bin-1.4.2 resume {self.NEW}"), self.NEW)
        self.assertEqual(self.bound, [self.NEW])

    def test_argv_naming_the_same_session_keeps_it(self) -> None:
        self.session(self.OLD, age_seconds=86400)
        self.session(self.NEW, age_seconds=5)
        self.assertEqual(
            self.reconcile(self.NEW, True, f"muse resume {self.NEW}"), self.NEW)
        self.assertEqual(self.bound, [])

    def test_argv_naming_an_older_session_keeps_the_binding(self) -> None:
        self.session(self.OLD, age_seconds=5)
        self.session(self.NEW, age_seconds=86400)
        self.assertEqual(
            self.reconcile(self.OLD, True, f"muse resume {self.NEW}"), self.OLD)
        self.assertEqual(self.bound, [])

    def test_a_name_ref_cannot_rebind(self) -> None:
        self.session(self.OLD, age_seconds=86400)
        self.assertEqual(
            self.reconcile(self.OLD, True, "muse resume green-heliosphere"), self.OLD)
        self.assertEqual(self.bound, [])

    def test_a_dead_terminal_keeps_its_binding(self) -> None:
        self.session(self.OLD, age_seconds=86400)
        self.session(self.NEW, age_seconds=5)
        self.assertEqual(
            self.reconcile(self.OLD, False, f"muse resume {self.NEW}"), self.OLD)
        self.assertEqual(self.bound, [])

    def test_a_session_owned_elsewhere_is_not_taken(self) -> None:
        self.session(self.OLD, age_seconds=86400)
        self.session(self.NEW, age_seconds=5)
        self.claimed.add(self.NEW)
        self.assertEqual(
            self.reconcile(self.OLD, True, f"muse resume {self.NEW}"), self.OLD)
        self.assertEqual(self.bound, [])


class ForkTest(unittest.TestCase):
    """/fork branches the live session into a detached session: the source terminal stays on
    the parent, and the new log opens with session.fork.created naming it."""

    def setUp(self) -> None:
        self.cli = MuseCli()
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name) / "muse" / "sessions"
        patched = patch.object(MuseCli, "sessions_root", self.root)
        patched.start()
        self.addCleanup(patched.stop)

    def session(self, session_id: str, first_line: str = "{}\n") -> Path:
        day = TimeUtil.today_est()
        path = self.root / f"{day.year:04d}" / f"{day.month:02d}" / f"{day.day:02d}" / session_id / \
            MuseCli.SESSION_LOG_NAME
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(first_line)
        return path

    @staticmethod
    def v7_id(unix_ms: int) -> str:
        head = f"{unix_ms:012x}"
        return f"{head[:8]}-{head[8:12]}-7abc-8def-123456789012"

    @staticmethod
    def fork_created_line(fork_id: str, source_id: str) -> str:
        # The real record carries no timestamp; recency reads off the fork id's UUIDv7 mint.
        return json.dumps({"record_type": "session.fork.created",
                           "payload": {"fork_session_id": fork_id, "source_session_id": source_id}}) + "\n"

    def test_finding_the_branch_ignores_other_sources_and_stale_forks(self) -> None:
        now_ms = int(time.time() * 1000)
        branch = self.v7_id(now_ms)
        elsewhere = self.v7_id(now_ms - 1000)
        stale = self.v7_id(now_ms - 3_600_000)
        since = time.time() - 60
        self.session("01a0-parent", "{}\n")
        self.session("01a0-branch", self.fork_created_line(branch, "01a0-parent"))
        self.session("01a0-elsewhere", self.fork_created_line(elsewhere, "01a0-other"))
        self.session("01a0-stale", self.fork_created_line(stale, "01a0-parent"))

        self.assertEqual(self.cli.latest_fork_of("01a0-parent", since), branch)

    def test_a_branch_without_a_v7_id_falls_back_to_freshness(self) -> None:
        self.session("01a0-parent", "{}\n")
        self.session("01a0-branch", self.fork_created_line("not-a-uuid", "01a0-parent"))

        self.assertEqual(self.cli.latest_fork_of("01a0-parent", time.time() - 60), "not-a-uuid")

    def test_no_branch_yet_is_none(self) -> None:
        self.session("01a0-parent", "{}\n")

        self.assertIsNone(self.cli.latest_fork_of("01a0-parent", time.time() - 60))

    def ms(self, **overrides) -> SimpleNamespace:
        fields = dict(running=True, proc=SimpleNamespace(alive=True),
                      record=SimpleNamespace(session_id="tab-1", agent_session_id="01a0-parent", draft=""))
        fields.update(overrides)
        return SimpleNamespace(**fields)

    def test_fork_sends_slash_fork_and_returns_the_branch(self) -> None:
        writes: list[tuple[str, str]] = []
        manager = SimpleNamespace(write_input=lambda session_id, text: writes.append((session_id, text)))
        with patch.object(self.cli, "is_processing", return_value=False), \
                patch.object(self.cli, "latest_fork_of", side_effect=[None, "01a0-branch"]) as discovered:
            fork_id = asyncio.run(self.cli.fork_through_source(manager, self.ms()))

        self.assertEqual(fork_id, "01a0-branch")
        self.assertEqual(len(writes), 2)
        self.assertTrue(writes[0][1].endswith("\x1b[200~/fork\x1b[201~"))
        self.assertEqual(writes[1], ("tab-1", "\r"))
        self.assertEqual(discovered.call_args[0][0], "01a0-parent")

    def test_fork_refuses_a_busy_terminal(self) -> None:
        manager = SimpleNamespace(write_input=AsyncMock())
        with patch.object(self.cli, "is_processing", return_value=True):
            with self.assertRaisesRegex(ValueError, "still working"):
                asyncio.run(self.cli.fork_through_source(manager, self.ms()))

        manager.write_input.assert_not_called()

    def test_fork_refuses_a_draft_and_a_dead_terminal(self) -> None:
        manager = SimpleNamespace(write_input=AsyncMock())
        with self.assertRaisesRegex(ValueError, "draft"):
            asyncio.run(self.cli.fork_through_source(manager, self.ms(
                record=SimpleNamespace(session_id="tab-1", agent_session_id="01a0-parent",
                                       draft="half typed"))))
        with self.assertRaisesRegex(ValueError, "not running"):
            asyncio.run(self.cli.fork_through_source(manager, self.ms(running=False)))

        manager.write_input.assert_not_called()


if __name__ == "__main__":
    unittest.main()
