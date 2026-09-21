"""A message sent while the agent is working belongs in the transcript.

Claude Code does not record one as a user turn: it hands the text to the turn already running and
writes an attachment line instead. The transcript therefore showed the agent answering a question
nobody could see it being asked, the phone kept the message marked as not yet delivered, and the
submit path kept pressing Enter at a prompt the agent had already taken.
"""

import json
import unittest

from termdeck import agents


def attachment(**overrides: object) -> str:
    payload = {
        "type": "attachment",
        "timestamp": "2026-09-21T00:25:44.036Z",
        "attachment": {
            "type": "queued_command",
            "prompt": "Make a clear API for it create note update delete",
            "commandMode": "prompt",
            "origin": {"kind": "human"},
            "humanTurn": True,
            "timestamp": "2026-09-21T00:25:44.036Z",
        },
    }
    payload["attachment"].update(overrides)
    return json.dumps(payload)


def user_turns(lines: list[str]) -> list[str]:
    return [str(turn.get("text")) for turn in agents.agent_cli("claude").parse_transcript_lines(lines)
            if turn.get("role") == "user"]


class MidTurnPromptTurnTest(unittest.TestCase):
    def test_a_message_sent_mid_turn_is_a_user_turn(self) -> None:
        turns = agents.agent_cli("claude").parse_transcript_lines([attachment()])

        self.assertEqual(turns, [{"role": "user", "text": "Make a clear API for it create note update delete",
                                  "timestamp": "2026-09-21T00:25:44.036Z"}])

    def test_it_sits_between_the_turns_it_arrived_between(self) -> None:
        lines = [
            json.dumps({"type": "user", "message": {"role": "user", "content": "start the work"}}),
            attachment(prompt="and one more thing"),
            json.dumps({"type": "assistant", "message": {"role": "assistant",
                                                         "content": [{"type": "text", "text": "done"}]}}),
        ]

        self.assertEqual(user_turns(lines), ["start the work", "and one more thing"])

    def test_a_task_notification_is_not_a_message_from_anyone(self) -> None:
        # The same record carries machinery: notifications about finished background work have no
        # human origin, and reading them as things the user said is how the transcript gains turns
        # nobody typed.
        lines = [attachment(prompt="<task-notification>\n<task-id>b5qjvgzev</task-id>",
                            commandMode="task-notification", origin=None, humanTurn=None)]

        self.assertEqual(user_turns(lines), [])

    def test_other_attachments_are_left_where_they_were(self) -> None:
        lines = [json.dumps({"type": "attachment", "attachment": {"type": "total_tokens_reminder",
                                                                  "prompt": "14920805 tokens left"}})]

        self.assertEqual(agents.agent_cli("claude").parse_transcript_lines(lines), [])

    def test_a_message_with_nothing_in_it_is_not_a_turn(self) -> None:
        self.assertEqual(user_turns([attachment(prompt="   ")]), [])

    def test_the_prompt_the_submit_path_waits_for_counts_as_a_user_payload(self) -> None:
        # _press_enter_until_prompt_lands keeps pressing Enter until the prompt is in the transcript
        # as a user turn, and the search index decides what was said the same way.
        payload = json.loads(attachment())
        claude = agents.agent_cli("claude")

        self.assertTrue(claude.is_user_payload(payload))
        self.assertTrue(claude.is_conversation_payload(payload))
        self.assertEqual(claude.payload_text(payload), "Make a clear API for it create note update delete")
        self.assertEqual(claude.conversation_payload_text(payload),
                         "Make a clear API for it create note update delete")

    def test_a_task_notification_is_not_a_user_payload_either(self) -> None:
        payload = json.loads(attachment(commandMode="task-notification", origin=None, humanTurn=None))
        claude = agents.agent_cli("claude")

        self.assertFalse(claude.is_user_payload(payload))
        self.assertEqual(claude.conversation_payload_text(payload), "")


if __name__ == "__main__":
    unittest.main()
