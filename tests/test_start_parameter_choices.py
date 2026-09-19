"""Choosing a model, and turning an agent's animations off, from the new-terminal and restart dialogs.

Both dialogs reach the same place: start parameters merged onto a command, where an option given later
replaces the same option already there. That merge was keyed on the flag alone, which is wrong for an
option a CLI expects several times -- codex's `-c key=value` -- and this is where the animations switch
lands, so the two are tested together.
"""

import json
import os
import shutil
import subprocess
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from termdeck import agents
from tests.test_terminal_cycle_order import method_source
from termdeck.config import TermdeckConfig
from termdeck.models import SessionRecord
from termdeck.session_manager import TerminalSessionManager


def record(session_id: str, **overrides) -> SessionRecord:
    fields = dict(session_id=session_id, title=session_id, title_user_set=False, command="codex",
                  cwd="/tmp", agent_kind="codex", agent_session_id="agent-1",
                  created_at_est="2026-09-19 10:00:00", draft="", project="stock")
    fields.update(overrides)
    return SessionRecord(**fields)


class RepeatableOptionOverrideTest(unittest.TestCase):
    """`-c key=value` is identified by its key, not by `-c`.

    Codex takes several of them, and TermDeck writes one itself for the reasoning effort. Keyed on the
    flag, adding any `-c` stripped every other `-c` already on the command -- so turning animations off
    would silently drop the reasoning effort the terminal was started with.
    """

    COMMAND = 'codex --no-alt-screen -c model_reasoning_effort="xhigh" --model gpt-5.6-luna'

    def merge(self, arguments: str) -> str:
        return TerminalSessionManager.append_additional_start_arguments(self.COMMAND, arguments)

    def test_a_different_key_is_added_beside_the_one_already_there(self) -> None:
        merged = self.merge("-c tui.animations=false")

        self.assertIn("model_reasoning_effort=xhigh", merged)
        self.assertIn("tui.animations=false", merged)

    def test_the_same_key_replaces_it(self) -> None:
        merged = self.merge('-c model_reasoning_effort="low"')

        self.assertIn("model_reasoning_effort=low", merged)
        self.assertNotIn("xhigh", merged)

    def test_an_ordinary_option_is_still_replaced_whole(self) -> None:
        merged = self.merge("--model gpt-6-astra")

        self.assertIn("--model gpt-6-astra", merged)
        self.assertNotIn("gpt-5.6-luna", merged)

    def test_the_reasoning_effort_survives_an_unrelated_flag(self) -> None:
        self.assertIn("model_reasoning_effort=xhigh", self.merge("--search"))


class DisableAnimationArgumentsTest(unittest.TestCase):
    """The flag belongs to the agent, not to the dialog: the dialogs ask, and show the option to
    whichever agents answer."""

    def test_codex_offers_its_own_switch(self) -> None:
        self.assertEqual(agents.agent_cli("codex").disable_animation_arguments(), ("-c", "tui.animations=false"))

    def test_an_agent_with_nothing_to_turn_off_says_so(self) -> None:
        self.assertEqual(agents.agent_cli("claude").disable_animation_arguments(), ())

    def test_the_dialogs_are_told_which_agents_have_one(self) -> None:
        self.assertIs(agents.agent_cli("codex").client_descriptor()["supports_disable_animations"], True)
        self.assertIs(agents.agent_cli("claude").client_descriptor()["supports_disable_animations"], False)


class NewSessionCommandTest(unittest.TestCase):
    def command(self, **kwargs) -> str:
        manager = TerminalSessionManager.__new__(TerminalSessionManager)
        manager._tracker = MagicMock()
        return manager.command_for_new_session(kwargs.pop("model", "codex"), kwargs.pop("permission", "default"),
                                               "", **kwargs)

    def test_the_checkbox_puts_the_agent_s_switch_on_the_command(self) -> None:
        self.assertIn("tui.animations=false", self.command(disable_animations=True))

    def test_it_is_absent_unless_asked_for(self) -> None:
        self.assertNotIn("tui.animations", self.command())

    def test_it_does_not_disturb_the_model_choice(self) -> None:
        # The chosen model reaches codex as a --model plus a -c for the reasoning effort, which is the
        # pair the flag-keyed merge used to break.
        built = self.command(model_name="gpt-5.6-luna xhigh", disable_animations=True)

        self.assertIn("--model gpt-5.6-luna", built)
        self.assertIn('model_reasoning_effort="xhigh"', built)
        self.assertIn("tui.animations=false", built)

    def test_a_parameter_typed_by_hand_still_wins(self) -> None:
        built = self.command(disable_animations=True, additional_args="-c tui.animations=true")

        self.assertIn("tui.animations=true", built)
        self.assertNotIn("tui.animations=false", built)

    def test_an_agent_with_no_such_switch_is_unaffected(self) -> None:
        self.assertNotIn("-c", self.command(model="claude", disable_animations=True))


class RestartWithModelTest(unittest.IsolatedAsyncioTestCase):
    """Restart can change the model, the same way it can change the permission."""

    def setUp(self) -> None:
        self.manager = TerminalSessionManager.__new__(TerminalSessionManager)
        self.session = SimpleNamespace(
            record=record("s1", command='codex --no-alt-screen -c model_reasoning_effort="xhigh" --model gpt-5.6-luna'),
            detect_task=None, exit_code=0, dormant=True)
        self.manager._sessions = {"s1": self.session}
        for method in ("_persist", "_spawn", "_canonicalize_agent_resume_command"):
            patcher = patch.object(TerminalSessionManager, method, lambda *a, **k: None)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.terminate = AsyncMock(return_value=True)
        terminate = patch.object(TerminalSessionManager, "_terminate_proc", self.terminate)
        terminate.start()
        self.addCleanup(terminate.stop)
        self.manager._tracker = SimpleNamespace(codex_session_permission_mode=lambda *a, **k: "")
        clear = patch.object(TerminalSessionManager, "replay", SimpleNamespace(clear_for_restart=lambda ms: None),
                             create=True)
        clear.start()
        self.addCleanup(clear.stop)

    async def test_the_chosen_model_replaces_the_one_on_the_command(self) -> None:
        await self.manager.restart_session("s1", "", "", "gpt-6-astra")

        self.assertIn("--model gpt-6-astra", self.session.record.command)
        self.assertNotIn("gpt-5.6-luna", self.session.record.command)

    async def test_a_reasoning_level_rides_along_with_it(self) -> None:
        # "<model> <effort>" is how codex's own picker names a choice, and it becomes two parameters.
        await self.manager.restart_session("s1", "", "", "gpt-6-astra max")

        self.assertIn("--model gpt-6-astra", self.session.record.command)
        self.assertIn('model_reasoning_effort="max"', self.session.record.command)
        self.assertNotIn("xhigh", self.session.record.command)

    async def test_no_model_leaves_the_command_alone(self) -> None:
        before = self.session.record.command

        await self.manager.restart_session("s1", "")

        self.assertEqual(self.session.record.command, before)

    async def test_the_animations_checkbox_reaches_the_restarted_command(self) -> None:
        await self.manager.restart_session("s1", "", "", "", True)

        self.assertIn("tui.animations=false", self.session.record.command)
        # Re-quoted by the merge, which strips the inner quotes the value was written with. Checked
        # against codex 0.155.0: `-c model_reasoning_effort=xhigh` and `-c model_reasoning_effort="xhigh"`
        # are read the same.
        self.assertIn("model_reasoning_effort=xhigh", self.session.record.command)

    async def test_a_typed_parameter_still_wins_over_both(self) -> None:
        await self.manager.restart_session("s1", "", "--model typed-by-hand", "gpt-6-astra", True)

        self.assertIn("--model typed-by-hand", self.session.record.command)
        self.assertNotIn("gpt-6-astra", self.session.record.command)

    async def test_a_bad_model_is_refused_before_the_terminal_is_killed(self) -> None:
        # Same rule as the typed parameters: raising after the terminal has been stopped leaves it dead
        # with nothing restarted.
        with self.assertRaises(ValueError):
            await self.manager.restart_session("s1", "", '--flag "unclosed', "gpt-6-astra")

        self.terminate.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()


class CodexIdentityFromThreadLockTest(unittest.TestCase):
    """Codex 0.155 moved thread storage into sqlite, so a running codex no longer holds a file named
    after its own session -- except the writer lock it takes for the thread it is writing.

    Detection reads the open files of the process tree and asks the agent which of them names a session.
    With the rollout files gone, nothing answered, so a terminal started under the new codex never bound
    to a session at all -- and a restart refused, permanently, because the identity "is still resolving".
    """

    def setUp(self) -> None:
        self.codex = agents.agent_cli("codex")
        self.thread = "01a0ba4a-8705-74e3-a91e-5b0a74d3bcfd"

    def test_the_writer_lock_names_the_thread(self) -> None:
        lock = self.codex.THREAD_LOCK_DIR / f"{self.thread}.lock"

        self.assertEqual(self.codex.session_id_from_path(lock), self.thread)

    def test_a_rollout_file_still_names_its_session(self) -> None:
        # The older codex is still out there, and its own sessions are still on disk.
        rollout = self.codex.sessions_root / "2026" / "09" / "19" / f"rollout-2026-09-19T04-28-56-{self.thread}.jsonl"

        self.assertEqual(self.codex.session_id_from_path(rollout), self.thread)

    def test_a_lock_somewhere_else_is_not_a_session(self) -> None:
        # Every long-running process holds locks; only the ones in codex's own directory are threads.
        self.assertIsNone(self.codex.session_id_from_path(Path(f"/tmp/somewhere/{self.thread}.lock")))

    def test_a_lock_not_named_for_a_thread_is_ignored(self) -> None:
        self.assertIsNone(self.codex.session_id_from_path(self.codex.THREAD_LOCK_DIR / "index.lock"))

    def test_another_agent_s_file_is_still_not_codex_s(self) -> None:
        self.assertIsNone(self.codex.session_id_from_path(
            Path.home() / ".claude" / "projects" / "p" / f"{self.thread}.jsonl"))


class RestartLooksAgainBeforeRefusingTest(unittest.IsolatedAsyncioTestCase):
    """The refusal is only fair while it is temporary.

    Detection runs on a startup deadline and on input, so a terminal that was never typed into -- or
    whose detection ran before the agent opened anything -- stayed unbound for good, and "wait before
    restarting" was advice that never came true.
    """

    def setUp(self) -> None:
        self.manager = TerminalSessionManager.__new__(TerminalSessionManager)
        self.session = SimpleNamespace(record=record("s1", agent_session_id=None), detect_task=None,
                                       exit_code=None, dormant=False)
        self.manager._sessions = {"s1": self.session}
        for method in ("_persist", "_spawn", "_canonicalize_agent_resume_command"):
            patcher = patch.object(TerminalSessionManager, method, lambda *a, **k: None)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.terminate = AsyncMock(return_value=True)
        terminate = patch.object(TerminalSessionManager, "_terminate_proc", self.terminate)
        terminate.start()
        self.addCleanup(terminate.stop)
        self.manager._tracker = SimpleNamespace(codex_session_permission_mode=lambda *a, **k: "")
        clear = patch.object(TerminalSessionManager, "replay", SimpleNamespace(clear_for_restart=lambda ms: None),
                             create=True)
        clear.start()
        self.addCleanup(clear.stop)

    def _detection(self, binds: str | None):
        async def detect(manager_self, ms, delay):
            if binds:
                ms.record.agent_session_id = binds
        return patch.object(TerminalSessionManager, "_detect_after", detect)

    async def test_a_detection_that_finds_the_session_lets_the_restart_through(self) -> None:
        with self._detection("01a0ba4a-8705-74e3-a91e-5b0a74d3bcfd"):
            await self.manager.restart_session("s1")

        self.terminate.assert_awaited()

    async def test_it_still_refuses_when_there_is_nothing_to_find(self) -> None:
        with self._detection(None), self.assertRaises(RuntimeError):
            await self.manager.restart_session("s1")

        self.terminate.assert_not_awaited()

    async def test_a_terminal_that_already_knows_its_session_is_not_delayed_by_a_lookup(self) -> None:
        self.session.record.agent_session_id = "already-bound"
        detect = AsyncMock()
        with patch.object(TerminalSessionManager, "_detect_after", detect):
            await self.manager.restart_session("s1")

        detect.assert_not_awaited()


class RefusedResumeStartsFreshTest(unittest.TestCase):
    """An agent that will not resume the session it was pointed at must not leave a dead terminal.

    The saved command is kept rewritten as a resume of the bound session, so once the agent refuses it
    every later restart dies the same way: the terminal is dead for good and nothing the user can press
    changes that. Codex refuses a thread that recorded no turns, which is any terminal restarted before
    it was ever used -- and after the 0.155 storage change that is the common case.

    What it wrote says nothing: measured against codex 0.155, a refused resume paints the whole splash
    screen and "Resuming session..." -- 12KB -- before giving up 3 seconds in. What it comes down to is
    that it stopped by itself, and leaving takes a keystroke.
    """

    def setUp(self) -> None:
        self.manager = TerminalSessionManager.__new__(TerminalSessionManager)
        self.session = SimpleNamespace(
            record=record("s1", command="codex --no-alt-screen resume thread-1", agent_session_id="thread-1"),
            proc=object(), exit_code=None, dormant=False, resume_fallback_used=False,
            resume_spawn_monotonic=0.0, last_typing_monotonic=0.0,
            processing_expiry_task=None, output_activity_expiry_task=None, client_queues=[])
        self.manager._sessions = {"s1": self.session}
        self.spawned = []
        for method, replacement in (("_persist", lambda *a, **k: None),
                                    ("_broadcast_status", lambda *a, **k: None),
                                    ("_broadcast_control", lambda *a, **k: None),
                                    ("_dtach_socket_live", lambda *a, **k: False),
                                    ("_dtach_socket", lambda self_, session_id: Path("/tmp/s.sock")),
                                    ("_handle_output", lambda self_, ms, data, mark_activity=True: None)):
            patcher = patch.object(TerminalSessionManager, method, replacement)
            patcher.start()
            self.addCleanup(patcher.stop)
        spawn = patch.object(TerminalSessionManager, "_spawn",
                             lambda self_, ms, **kwargs: self.spawned.append(ms.record.command))
        spawn.start()
        self.addCleanup(spawn.stop)

    def exit_after(self, seconds: float, typed: bool = False, exit_code: int = 0) -> None:
        """The terminal was spawned as a resume this long ago, perhaps typed into, and has now exited."""
        self.session.resume_spawn_monotonic = time.monotonic() - seconds
        self.session.last_typing_monotonic = time.monotonic() if typed else 0.0
        self.manager._handle_exit(self.session, self.session.proc, exit_code)

    def test_a_refused_resume_comes_back_as_a_new_session(self) -> None:
        self.exit_after(3.0)

        self.assertEqual(self.spawned, ["codex --no-alt-screen"])

    def test_the_refused_session_is_let_go_of(self) -> None:
        # Kept, the command would be rewritten back into a resume of the same refused session and the
        # next restart would die exactly the same way.
        self.exit_after(3.0)

        self.assertIsNone(self.session.record.agent_session_id)

    def test_an_agent_that_was_quit_is_left_alone(self) -> None:
        # Quitting is a keystroke. Respawning over it would fight the person who just left.
        self.exit_after(3.0, typed=True)

        self.assertEqual(self.spawned, [])
        self.assertEqual(self.session.record.agent_session_id, "thread-1")

    def test_an_agent_that_ran_for_a_while_is_left_alone(self) -> None:
        # Long past startup: whatever ended it, it was not a refused resume.
        self.exit_after(45.0)

        self.assertEqual(self.spawned, [])

    def test_it_only_tries_once(self) -> None:
        # Otherwise an agent that exits during startup for any other reason is respawned forever.
        self.exit_after(3.0)
        self.session.record.agent_session_id = "thread-2"
        self.exit_after(3.0)

        self.assertEqual(len(self.spawned), 1)

    def test_a_terminal_with_no_session_bound_is_left_alone(self) -> None:
        self.session.record.agent_session_id = None
        self.exit_after(3.0)

        self.assertEqual(self.spawned, [])

    def test_a_spawn_that_was_not_a_resume_is_left_alone(self) -> None:
        self.session.resume_spawn_monotonic = 0.0
        self.manager._handle_exit(self.session, self.session.proc, 0)

        self.assertEqual(self.spawned, [])


class RestartShowsItsCommandTest(unittest.TestCase):
    """Restarting is when the command changes, so that is where it has to be visible.

    A terminal opened from scratch prints "[termdeck] spawn: <command>" because it has nothing else in
    it. A restarted one printed only "restarted" -- and a restart is exactly when the command becomes
    something else: a different model, another permission, a resume the agent may or may not take.
    """

    def divider(self, reattach: bool, command: str) -> str:
        return TerminalSessionManager._spawn_divider(reattach, command)

    def test_a_restart_names_the_command_it_is_running(self) -> None:
        line = self.divider(False, "codex --model gpt-6-astra resume thread-1")

        self.assertIn("codex --model gpt-6-astra resume thread-1", line)
        self.assertIn("restarted", line)

    def test_reconnecting_to_a_terminal_that_kept_running_does_not(self) -> None:
        # Nothing was started, so there is no command to report; the process is the one already there.
        line = self.divider(True, "codex --model gpt-6-astra")

        self.assertNotIn("gpt-6-astra", line)

    def test_a_terminal_with_no_command_still_names_what_it_runs(self) -> None:
        self.assertIn(TermdeckConfig.SHELL, self.divider(False, ""))


MODEL_NAME_HARNESS = """
const scenario = JSON.parse(process.env.TERMDECK_MODEL_NAME_SCENARIO);
const elements = {
  "modal-model-effort": { value: scenario.selected },
  "modal-model-effort-field": { classList: { contains: () => scenario.effortFieldHidden } },
};
const app = { $: (id) => elements[id], __METHODS__ };
process.stdout.write(JSON.stringify({ name: app.modelNameWithEffort(scenario.field, "modal-model-effort") }));
"""


class ModelNameFromTheDialogTest(unittest.TestCase):
    """What the dialog hands over as the model, while its list of levels is still loading.

    The levels come from codex's catalog, which takes about three seconds to answer on the first open
    because codex starts an app server for it. Until then there is no list to read a level off -- but the
    field already holds one, because that is how the last choice is remembered ("gpt-6-astra high").
    Dropping it meant opening a terminal quickly started it on the agent's default while the box plainly
    said otherwise.
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        source = (Path(__file__).resolve().parent.parent / "termdeck" / "static" / "app_settings_ui.js").read_text()
        cls.harness = MODEL_NAME_HARNESS.replace(
            "__METHODS__", method_source(source, "modelNameWithEffort(modelValue, effortSelectId)"))

    def name_for(self, field: str, selected: str = "", effort_field_hidden: bool = False) -> str:
        scenario = {"field": field, "selected": selected, "effortFieldHidden": effort_field_hidden}
        done = subprocess.run([self.node, "-e", self.harness], capture_output=True, text=True, check=False,
                              env={**os.environ, "TERMDECK_MODEL_NAME_SCENARIO": json.dumps(scenario)})
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)["name"]

    def test_the_remembered_level_survives_the_catalog_still_loading(self) -> None:
        self.assertEqual(self.name_for("gpt-6-astra high", effort_field_hidden=True), "gpt-6-astra high")

    def test_a_chosen_level_is_what_is_sent(self) -> None:
        self.assertEqual(self.name_for("gpt-6-astra high", selected="max"), "gpt-6-astra max")

    def test_choosing_the_model_default_sends_no_level(self) -> None:
        # The blank option is a deliberate choice -- "whatever the agent is configured for" -- so it has
        # to beat the level the field was remembered with.
        self.assertEqual(self.name_for("gpt-6-astra high", selected=""), "gpt-6-astra")

    def test_a_model_the_catalog_does_not_know_passes_through(self) -> None:
        self.assertEqual(self.name_for("something-invented", effort_field_hidden=True), "something-invented")

    def test_an_empty_field_stays_empty(self) -> None:
        # Blank means the agent's own default model; it must not become a stray level.
        self.assertEqual(self.name_for("", selected="high"), "high")
        self.assertEqual(self.name_for("", effort_field_hidden=True), "")
