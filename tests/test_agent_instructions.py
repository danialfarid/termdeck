import tempfile
import unittest
from pathlib import Path

from termdeck.agent_instructions import AgentInstructionService


class AgentInstructionServiceTest(unittest.TestCase):
    def test_instruction_text_contains_the_local_api_surface(self) -> None:
        self.assertIn("POST /api/sessions/{session_id}/prompt", AgentInstructionService.INSTRUCTION_TEXT)
        self.assertIn("/api/terminals/task", AgentInstructionService.INSTRUCTION_TEXT)
        self.assertIn("title, description", AgentInstructionService.INSTRUCTION_TEXT)
        self.assertIn("/api/sessions/{session_id}/task for", AgentInstructionService.INSTRUCTION_TEXT)
        # One call for what an agent answered, and what it takes to ask for more than the latest.
        self.assertIn("/api/sessions/{session_id}/last_turns", AgentInstructionService.INSTRUCTION_TEXT)
        self.assertIn("?limit=", AgentInstructionService.INSTRUCTION_TEXT)
        self.assertIn("origin_session to your $TERMDECK_SESSION_ID", AgentInstructionService.INSTRUCTION_TEXT)
        self.assertIn("user-authorized scope", AgentInstructionService.INSTRUCTION_TEXT)
        self.assertLess(len(AgentInstructionService.INSTRUCTION_TEXT), 650)
        self.assertNotIn("github.com", AgentInstructionService.INSTRUCTION_TEXT)

    def test_ensures_one_termdeck_owned_instruction_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            instruction_file = Path(directory) / "agent-api-instructions.md"
            service = AgentInstructionService(instruction_file)
            self.assertEqual(service.ensure_instruction_file(), instruction_file)
            self.assertEqual(instruction_file.read_text(encoding="utf-8"), service.INSTRUCTION_TEXT)
            self.assertEqual(service.ensure_instruction_file(), instruction_file)
            self.assertEqual(instruction_file.read_text(encoding="utf-8"), service.INSTRUCTION_TEXT)

    def test_global_instruction_blocks_preserve_user_text_and_can_be_removed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            global_file = Path(directory) / "GEMINI.md"
            global_file.write_text("Existing global guidance.\n", encoding="utf-8")
            service = AgentInstructionService(Path(directory) / "agent-api-instructions.md")
            service.synchronize_global_instruction_files(True, (global_file,))
            injected = global_file.read_text(encoding="utf-8")
            self.assertIn("Existing global guidance.", injected)
            self.assertIn(service.INSTRUCTION_TEXT.rstrip(), injected)
            service.synchronize_global_instruction_files(False, (global_file,))
            self.assertEqual(global_file.read_text(encoding="utf-8"), "Existing global guidance.\n")


if __name__ == "__main__":
    unittest.main()
