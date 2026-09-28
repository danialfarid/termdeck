"""Codex records each assistant message twice: once as event_msg/item_completed and once as
response_item/message. The response_item copy carries an appended <oai-mem-citation> metadata
block, which used to defeat the exact-text dedupe and show the final response twice."""

import json
import unittest

from termdeck.agents import agent_cli

CITATION = (
    "\n\n<oai-mem-citation>\n<citation_entries>\n"
    "MEMORY.md:29-35|note=[preserved cache boundaries]\n"
    "</citation_entries>\n<rollout_ids>\n01a0dc5e-00b1-7ff1-9139-d8d3895f666e\n"
    "</rollout_ids>\n</oai-mem-citation>"
)


def completed(text: str) -> str:
    return json.dumps(
        {
            "timestamp": "2026-09-26T17:21:31.827Z",
            "ordinal": 1,
            "type": "event_msg",
            "payload": {
                "type": "item_completed",
                "item": {
                    "type": "AgentMessage",
                    "id": "msg_1",
                    "phase": "final_answer",
                    "content": [{"type": "Text", "text": text}],
                },
            },
        }
    )


def response_item(text: str) -> str:
    return json.dumps(
        {
            "timestamp": "2026-09-26T17:21:31.837Z",
            "ordinal": 2,
            "type": "response_item",
            "payload": {
                "type": "message",
                "id": "msg_1",
                "role": "assistant",
                "phase": "final_answer",
                "content": [{"type": "output_text", "text": text}],
            },
        }
    )


class CodexTranscriptTest(unittest.TestCase):
    def test_mem_citation_suffix_does_not_duplicate_assistant_turn(self) -> None:
        turns = agent_cli("codex").parse_transcript_lines([completed("Done."), response_item("Done." + CITATION)])
        self.assertEqual([(turn["role"], turn["text"]) for turn in turns], [("assistant", "Done.")])
        self.assertTrue(turns[0].get("final"))

    def test_plain_duplicate_pair_still_dedupes(self) -> None:
        turns = agent_cli("codex").parse_transcript_lines([completed("Done."), response_item("Done.")])
        self.assertEqual([(turn["role"], turn["text"]) for turn in turns], [("assistant", "Done.")])

    def test_distinct_assistant_turns_are_kept(self) -> None:
        turns = agent_cli("codex").parse_transcript_lines([completed("First."), response_item("Second.")])
        self.assertEqual([turn["text"] for turn in turns], ["First.", "Second."])
