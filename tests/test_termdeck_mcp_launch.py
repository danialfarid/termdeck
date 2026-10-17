"""Agents started in TermDeck get its MCP server without anyone registering it.

Settings calls this "TermDeck MCP for spawned agents"; with it on, an agent that can take the server at
launch gets it in place of the curl guide, and one that cannot still gets the guide.

The launch command carries the server for that run only -- Claude through --mcp-config, Codex and Muse
through -c -- so nothing is written to the agent's own configuration and the saved command is untouched.
The server is started with the deck's own Python and address, so the tools match the running deck
whatever `termdeck` the PATH holds.
"""

import json
import shlex
import sys
import tempfile
import tomllib
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from termdeck import agents
from termdeck.agents.muse import MuseCli
from termdeck.config import TermdeckConfig
from termdeck.session_manager import TerminalSessionManager

SERVER = ("/opt/deck/python", ("-m", "termdeck", "--host", "127.0.0.1", "--port", "8530", "mcp"))


class LaunchArgumentsTest(unittest.TestCase):
    def launched(self, kind: str, command: str) -> list[str]:
        agent = agents.agent_cli(kind)
        return shlex.split(agent.command_with_launch_arguments(command, agent.termdeck_mcp_arguments(*SERVER)))

    def test_claude_gets_one_mcp_config_token_after_the_executable(self) -> None:
        parts = self.launched("claude", "claude --resume aa11 'review this'")
        self.assertEqual(parts[0], "claude")
        flag, _, value = parts[1].partition("=")
        self.assertEqual(flag, "--mcp-config")
        self.assertEqual(json.loads(value), {"mcpServers": {"termdeck": {
            "command": "/opt/deck/python", "args": list(SERVER[1])}}})
        # The prompt after it is still the prompt, not a second config.
        self.assertEqual(parts[2:], ["--resume", "aa11", "review this"])

    def test_codex_gets_toml_overrides_before_its_subcommand(self) -> None:
        parts = self.launched("codex", "codex --no-alt-screen resume 01a0")
        self.assertEqual(parts[0], "codex")
        self.assertEqual((parts[1], parts[3], parts[5]), ("-c", "-c", "-c"))
        parsed = tomllib.loads(f"{parts[2]}\n{parts[4]}\n{parts[6]}")
        # Codex gives an MCP server only the environment it names; the session id files spawned agents.
        self.assertEqual(parsed, {"mcp_servers": {"termdeck": {
            "command": "/opt/deck/python", "args": list(SERVER[1]), "env_vars": ["TERMDECK_SESSION_ID"]}}})
        self.assertEqual(parts[7:], ["--no-alt-screen", "resume", "01a0"])

    def test_an_agent_without_a_switch_is_left_alone(self) -> None:
        for kind, command in (("aider", "aider --restore-chat-history"), ("agy", "agy --model gemini"),
                              ("opencode", "opencode")):
            agent = agents.agent_cli(kind)
            self.assertEqual(agent.termdeck_mcp_arguments(*SERVER), (), kind)
            self.assertEqual(agent.command_with_launch_arguments(command, ()), command, kind)


class MuseLaunchTest(unittest.TestCase):
    def arguments_with_settings(self, text: str | None) -> tuple[str, ...]:
        with tempfile.TemporaryDirectory() as directory:
            settings = Path(directory) / "settings.json"
            if text is not None:
                settings.write_text(text, encoding="utf-8")
            with patch.object(MuseCli, "settings_file", settings):
                return agents.agent_cli("muse").termdeck_mcp_arguments(*SERVER)

    def test_muse_gets_one_named_server(self) -> None:
        arguments = self.arguments_with_settings(json.dumps({"mcpServers": {"other": {"command": "x"}}}))
        self.assertEqual(arguments[0], "-c")
        key, _, value = arguments[1].partition("=")
        self.assertEqual(key, "mcpServers.termdeck")
        # Muse passes on only the variables an entry names, and only as a whole ${VAR} value.
        self.assertEqual(json.loads(value), {"mode": "optional", "transport": "stdio",
                                             "command": "/opt/deck/python", "args": list(SERVER[1]),
                                             "env": {"TERMDECK_SESSION_ID": "${TERMDECK_SESSION_ID}"}})

    def test_no_settings_file_still_gets_the_server(self) -> None:
        self.assertEqual(len(self.arguments_with_settings(None)), 2)

    def test_a_hand_registered_server_is_left_to_muse(self) -> None:
        # Muse refuses the whole run when -c names a server its settings define.
        settings = json.dumps({"mcpServers": {"termdeck": {"command": "termdeck", "args": ["mcp"]}}})
        self.assertEqual(self.arguments_with_settings(settings), ())

    def test_unreadable_settings_are_not_risked(self) -> None:
        self.assertEqual(self.arguments_with_settings("{not json"), ())


class LaunchCommandTest(unittest.TestCase):
    """The "TermDeck MCP for spawned agents" setting: the tools where an agent can take them, the curl
    guide where it cannot, and neither when it is off."""

    def launch(self, kind: str, command: str, enabled: bool = True) -> tuple[str, MagicMock]:
        manager = TerminalSessionManager.__new__(TerminalSessionManager)
        manager._settings_reader = lambda: {"agent_api_instructions_enabled": enabled}
        manager.agent_instructions = MagicMock()
        manager.agent_instructions.ensure_instruction_file.return_value = Path("/tmp/guide.md")
        with patch.object(TerminalSessionManager, "termdeck_mcp_launch", staticmethod(lambda: SERVER)), \
                patch.object(MuseCli, "settings_file", Path("/nonexistent/settings.json")):
            return manager._agent_launch_command(agents.agent_cli(kind), command), manager.agent_instructions

    def test_an_agent_that_takes_the_server_gets_it_and_no_guide(self) -> None:
        for kind in ("claude", "codex", "muse"):
            launched, instructions = self.launch(kind, kind)
            self.assertIn("termdeck", launched, kind)
            self.assertNotIn("guide.md", launched, kind)
            instructions.ensure_instruction_file.assert_not_called()

    def test_an_agent_that_cannot_take_it_gets_the_guide(self) -> None:
        launched, _ = self.launch("aider", "aider --restore-chat-history")
        self.assertEqual(launched, "aider --read /tmp/guide.md --restore-chat-history")
        launched, instructions = self.launch("agy", "agy --model gemini")
        self.assertEqual(launched, "agy --model gemini")
        instructions.synchronize_global_instruction_files.assert_called_once()
        self.assertTrue(instructions.synchronize_global_instruction_files.call_args.args[0])

    def test_off_gives_neither(self) -> None:
        launched, instructions = self.launch("claude", "claude --resume aa11", enabled=False)
        self.assertEqual(launched, "claude --resume aa11")
        instructions.synchronize_global_instruction_files.assert_called_once_with(False)


class ServerLaunchTest(unittest.TestCase):
    def test_the_server_runs_on_the_decks_own_python_and_address(self) -> None:
        command, arguments = TerminalSessionManager.termdeck_mcp_launch()
        self.assertEqual(command, sys.executable)
        self.assertEqual(arguments, ("-m", "termdeck", "--host", TermdeckConfig.HOST,
                                     "--port", str(TermdeckConfig.PORT), "mcp"))


if __name__ == "__main__":
    unittest.main()
