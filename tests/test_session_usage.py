import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from termdeck import agents


class SessionUsageTest(unittest.TestCase):
    def test_claude_latest_usage_reads_newest_assistant_event(self) -> None:
        claude = agents.agent_cli("claude")
        lines = [
            {"type": "user", "message": {"content": "hi"}},
            {"type": "assistant", "message": {"usage": {
                "input_tokens": 2, "cache_creation_input_tokens": 100, "cache_read_input_tokens": 50,
                "output_tokens": 10}}},
            {"type": "assistant", "message": {"usage": {
                "input_tokens": 4, "cache_creation_input_tokens": 200, "cache_read_input_tokens": 300,
                "output_tokens": 42, "output_tokens_details": {"thinking_tokens": 7}}}},
            {"type": "user", "message": {"content": "more"}},
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "abc.jsonl"
            path.write_text("\n".join(json.dumps(line) for line in lines) + "\n")
            with patch.object(type(claude), "transcript_path", return_value=path):
                usage = claude.latest_usage(Path(directory), "abc")
        self.assertEqual(usage, {"context_tokens": 504, "output_tokens": 42,
                                 "context_window": None, "total_tokens": None})

    def test_codex_latest_usage_reads_newest_token_count(self) -> None:
        codex = agents.agent_cli("codex")
        lines = [
            {"type": "event_msg", "payload": {"type": "agent_message", "message": "hello"}},
            {"type": "event_msg", "payload": {"type": "token_count", "info": {
                "total_token_usage": {"input_tokens": 16043, "cached_input_tokens": 9984,
                                      "output_tokens": 5, "total_tokens": 16048},
                "last_token_usage": {"input_tokens": 16043, "cached_input_tokens": 9984,
                                     "output_tokens": 5, "total_tokens": 16048},
                "model_context_window": 258400}}},
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "rollout-2026-08-26-x.jsonl"
            path.write_text("\n".join(json.dumps(line) for line in lines) + "\n")
            with patch.object(type(codex), "transcript_path", return_value=path):
                usage = codex.latest_usage(None, "x")
        self.assertEqual(usage, {"context_tokens": 16043, "output_tokens": 5,
                                 "context_window": 258400, "total_tokens": 16048})

    def test_shell_and_missing_transcript_report_nothing(self) -> None:
        self.assertIsNone(agents.agent_cli("none").latest_usage(Path.home(), "whatever"))
        self.assertIsNone(agents.agent_cli("claude").latest_usage(Path.home(), None))
