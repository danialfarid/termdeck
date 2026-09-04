import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from termdeck.agents.declarative import DeclarativeAgentCli
from termdeck.agents.profile_schema import AgentProfileLoader


class DeclarativeAgentProfileTest(unittest.TestCase):
    def _load(self, root: Path, overrides: dict[str, object] | None = None) -> DeclarativeAgentCli:
        profile: dict[str, object] = {
            "kind": "reviewer",
            "label": "Reviewer",
            "executable": "reviewer-cli",
            "aliases": ["review"],
            "base_arguments": ["--tui"],
            "model_arguments": ["--engine", "{model}"],
            "permissions": [
                {"value": "default", "label": "Default", "arguments": []},
                {"value": "auto", "label": "Auto approve", "arguments": ["--permission", "auto"]},
            ],
            "resume_arguments": ["--session", "{session_id}"],
            "fork_arguments": ["--session", "{session_id}", "--fork", "--name", "{title}"],
            "session_value_flags": ["--session", "--name"],
            "session_switch_flags": ["--fork"],
            "rename_input": "/name {title}",
            "transcript": {
                "root": str(root / "sessions"),
                "path": "{session_id}/events.jsonl",
                "glob": "*/events.jsonl",
                "session_id_regex": "^(?P<session_id>[^/]+)/events\\.jsonl$",
                "role_path": "message.role",
                "content_path": "message.content",
                "timestamp_path": "created_at",
                "model_path": "message.model",
                "title_path": "session.title",
                "cwd_path": "session.cwd",
            },
            "activity": {
                "strategy": "jsonl-event",
                "event_path": "event",
                "active_values": ["turn.started"],
                "idle_values": ["turn.completed", "turn.failed"],
            },
            "attention_markers": ["approve this action"],
            "icon_svg": "<svg viewBox=\"0 0 10 10\"><circle cx=\"5\" cy=\"5\" r=\"4\"/></svg>",
            "install_hint": "brew install reviewer-cli",
        }
        profile.update(overrides or {})
        config = root / "agent-profiles.json"
        config.write_text(json.dumps({"version": 1, "agents": [profile]}))
        return DeclarativeAgentCli(AgentProfileLoader.load(config)[0])

    def test_profile_builds_launch_resume_fork_permission_and_descriptor(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            agent = self._load(Path(directory))
        self.assertEqual(agent.build_command("auto", "openrouter/acme/model", "abc", None),
                         "reviewer-cli --tui --permission auto --engine openrouter/acme/model --session abc")
        self.assertEqual(agent.resume_command(
            "reviewer-cli --tui --session old --fork --name old-title --permission auto", "next"),
            "reviewer-cli --tui --permission auto --session next")
        self.assertEqual(agent.fork_command("reviewer-cli --tui --session old", "next", "new review"),
                         "reviewer-cli --tui --session next --fork --name 'new review'")
        self.assertEqual(agent.set_model("reviewer-cli --engine old --tui", "new/model"),
                         "reviewer-cli --engine new/model --tui")
        descriptor = agent.client_descriptor()
        self.assertTrue(descriptor["declarative"])
        self.assertEqual(descriptor["activity_source"], "jsonl-event")
        self.assertTrue(descriptor["supports_agent_rename"])

    def test_profile_parses_transcript_and_restores_event_activity(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            agent = self._load(root)
            transcript = root / "sessions" / "abc" / "events.jsonl"
            transcript.parent.mkdir(parents=True)
            transcript.write_text("\n".join((
                json.dumps({"event": "turn.started", "created_at": "2026-09-04T10:00:00Z",
                            "message": {"role": "user", "content": "Review this", "model": "m1"},
                            "session": {"title": "API review", "cwd": "/work/api"}}),
                json.dumps({"event": "stream.delta", "message": {"role": "assistant",
                                                                    "content": [{"text": "Working"}]}}),
            )) + "\n")
            self.assertEqual(agent.transcript_path(root, "abc"), transcript.resolve())
            self.assertEqual(agent.candidate_session_files(root), [(transcript, "abc")])
            turns = agent.parse_transcript_lines(transcript.read_text().splitlines())
            self.assertEqual([(turn["role"], turn["text"]) for turn in turns],
                             [("user", "Review this"), ("assistant", "Working")])
            state = agent.new_session_state()
            ms = SimpleNamespace(record=SimpleNamespace(agent_session_id="abc", cwd=str(root)), agent_state=state,
                                 processing=False)
            agent.refresh_persisted_activity(None, ms)
            self.assertTrue(agent.is_processing(ms))
            with transcript.open("a") as handle:
                handle.write(json.dumps({"event": "turn.completed"}) + "\n")
            agent.refresh_persisted_activity(None, ms)
            self.assertFalse(agent.is_processing(ms))
            self.assertEqual(agent.session_title(None, root, "abc"), "API review")

    def test_profile_rejects_unsafe_or_structurally_ambiguous_values(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaisesRegex(ValueError, "unsafe markup"):
                self._load(root, {"icon_svg": "<svg><script>alert(1)</script></svg>"})
            with self.assertRaisesRegex(ValueError, "sessionless profiles"):
                self._load(root, {"sessionless": True})
            with self.assertRaisesRegex(ValueError, "unsupported placeholders"):
                self._load(root, {"model_arguments": ["--model", "{shell_command}"]})

    def test_missing_profile_file_is_empty(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(AgentProfileLoader.load(Path(directory) / "missing.json"), ())


if __name__ == "__main__":
    unittest.main()
