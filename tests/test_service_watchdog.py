import json
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

from termdeck.config import TermdeckConfig
from termdeck.platform_paths import PlatformPaths
from termdeck.service_installer import ServiceInstaller
from termdeck.service_watchdog import ServiceWatchdog


class FakeInstaller:
    """Stands in for the service manager: records what the watchdog asked it to do."""

    def __init__(self, loaded: bool = True, failure: Exception | None = None) -> None:
        self.loaded = loaded
        self.failure = failure
        self.restarts = 0

    def is_loaded(self) -> bool:
        return self.loaded

    def restart(self) -> str:
        if self.failure is not None:
            raise self.failure
        self.restarts += 1
        return "restarted"


class ServiceWatchdogProbeTest(unittest.TestCase):
    """The probe answers one question -- did the server reply at all -- so every HTTP status counts as
    alive and only silence counts as wedged."""

    def _probe_raising(self, error: Exception) -> bool:
        with patch("urllib.request.urlopen", side_effect=error):
            return ServiceWatchdog.probe("http://127.0.0.1:8530/api/health")

    def test_an_error_status_still_proves_the_event_loop_turns(self) -> None:
        # A deck behind an access token answers the watchdog with 401, and a deck running an older build
        # answers with 404. Treating either as "frozen" would restart a perfectly healthy server forever.
        for status in (401, 404, 500):
            with self.subTest(status=status):
                error = urllib.error.HTTPError("url", status, "denied", {}, None)
                self.assertTrue(self._probe_raising(error))

    def test_a_timeout_is_the_freeze_signature(self) -> None:
        # The wedged deck this exists for kept accepting connections and never replied.
        self.assertFalse(self._probe_raising(TimeoutError("timed out")))

    def test_a_refused_connection_counts_as_not_serving(self) -> None:
        self.assertFalse(self._probe_raising(urllib.error.URLError(ConnectionRefusedError())))

    def test_a_server_on_every_interface_is_probed_over_the_loopback(self) -> None:
        with patch.object(TermdeckConfig, "HOST", "0.0.0.0"), patch.object(TermdeckConfig, "PORT", 8530):
            self.assertEqual(ServiceWatchdog.health_url(), "http://127.0.0.1:8530/api/health")


class ServiceWatchdogTickTest(unittest.TestCase):
    """Each tick is its own process, so what spans them is the state file. These drive ticks in sequence
    and assert on when a restart is and is not issued."""

    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.state_file = Path(self.directory.name) / "watchdog-state.json"
        self.log_file = Path(self.directory.name) / "watchdog.log"
        self.installer = FakeInstaller()
        self.clock = 1_000_000.0

    def _watchdog(self) -> ServiceWatchdog:
        return ServiceWatchdog(self.installer, self.state_file, self.log_file, now=lambda: self.clock)

    def _tick(self, healthy: bool) -> str:
        with patch.object(ServiceWatchdog, "probe", staticmethod(lambda *a, **k: healthy)):
            return self._watchdog().tick()

    def test_a_healthy_probe_records_health_and_restarts_nothing(self) -> None:
        self.assertEqual(self._tick(healthy=True), ServiceWatchdog.HEALTHY)
        self.assertEqual(self.installer.restarts, 0)
        self.assertEqual(json.loads(self.state_file.read_text())["consecutive_failures"], 0)

    def test_failures_below_the_threshold_only_count(self) -> None:
        for expected in range(1, TermdeckConfig.WATCHDOG_FAILURE_THRESHOLD):
            self.assertEqual(self._tick(healthy=False), ServiceWatchdog.UNANSWERED)
            self.assertEqual(json.loads(self.state_file.read_text())["consecutive_failures"], expected)
        self.assertEqual(self.installer.restarts, 0)

    def test_the_threshold_tick_restarts_the_deck(self) -> None:
        for _ in range(TermdeckConfig.WATCHDOG_FAILURE_THRESHOLD - 1):
            self._tick(healthy=False)

        self.assertEqual(self._tick(healthy=False), ServiceWatchdog.RESTARTED)

        self.assertEqual(self.installer.restarts, 1)
        state = json.loads(self.state_file.read_text())
        self.assertEqual(state["consecutive_failures"], 0)
        self.assertEqual(state["restarts"], 1)

    def test_one_recovered_probe_clears_the_count(self) -> None:
        # A single slow minute must not accumulate toward a restart across an otherwise healthy hour.
        for _ in range(TermdeckConfig.WATCHDOG_FAILURE_THRESHOLD - 1):
            self._tick(healthy=False)
        self._tick(healthy=True)

        self.assertEqual(self._tick(healthy=False), ServiceWatchdog.UNANSWERED)
        self.assertEqual(self.installer.restarts, 0)

    def test_a_restarting_server_is_not_restarted_again_while_it_boots(self) -> None:
        # The replacement is unreachable while it restores scrollback; without the cooldown the watchdog
        # would read its own restart as another freeze and bounce it every threshold window.
        for _ in range(TermdeckConfig.WATCHDOG_FAILURE_THRESHOLD):
            self._tick(healthy=False)
        self.assertEqual(self.installer.restarts, 1)

        self.clock += TermdeckConfig.WATCHDOG_RESTART_COOLDOWN_SECONDS / 2
        for _ in range(TermdeckConfig.WATCHDOG_FAILURE_THRESHOLD):
            outcome = self._tick(healthy=False)

        self.assertEqual(outcome, ServiceWatchdog.COOLING_DOWN)
        self.assertEqual(self.installer.restarts, 1)

    def test_a_deck_still_dead_after_the_cooldown_is_restarted_again(self) -> None:
        for _ in range(TermdeckConfig.WATCHDOG_FAILURE_THRESHOLD):
            self._tick(healthy=False)
        self.clock += TermdeckConfig.WATCHDOG_RESTART_COOLDOWN_SECONDS + 1
        for _ in range(TermdeckConfig.WATCHDOG_FAILURE_THRESHOLD):
            outcome = self._tick(healthy=False)

        self.assertEqual(outcome, ServiceWatchdog.RESTARTED)
        self.assertEqual(self.installer.restarts, 2)

    def _restart_times(self, ticks: int, tick_seconds: float) -> list[float]:
        """Run a deck that never comes back, and return when each restart happened."""
        times: list[float] = []
        for _ in range(ticks):
            if self._tick(healthy=False) == ServiceWatchdog.RESTARTED:
                times.append(self.clock)
            self.clock += tick_seconds
        return times

    def test_a_deck_that_cannot_start_is_restarted_less_and_less_often(self) -> None:
        # The case this guards: termdeck is broken badly enough that restarting never helps (a bad build,
        # a state file it dies on, a full disk). A fixed cooldown would bounce the process every few
        # minutes forever, fighting whoever is trying to debug it.
        times = self._restart_times(ticks=400, tick_seconds=TermdeckConfig.WATCHDOG_INTERVAL_SECONDS)
        gaps = [later - earlier for earlier, later in zip(times, times[1:], strict=False)]

        self.assertGreater(len(gaps), 3)
        for earlier_gap, later_gap in zip(gaps, gaps[1:], strict=False):
            self.assertGreaterEqual(later_gap, earlier_gap)
        self.assertGreaterEqual(gaps[-1], TermdeckConfig.WATCHDOG_RESTART_COOLDOWN_SECONDS * 2)
        self.assertLessEqual(max(gaps), TermdeckConfig.WATCHDOG_RESTART_COOLDOWN_MAX_SECONDS
                             + TermdeckConfig.WATCHDOG_INTERVAL_SECONDS * TermdeckConfig.WATCHDOG_FAILURE_THRESHOLD)

    def test_a_dead_deck_is_restarted_only_a_handful_of_times_an_hour(self) -> None:
        one_hour = 3600
        times = self._restart_times(ticks=one_hour // TermdeckConfig.WATCHDOG_INTERVAL_SECONDS,
                                    tick_seconds=TermdeckConfig.WATCHDOG_INTERVAL_SECONDS)

        self.assertLessEqual(len(times), 5, f"restarted {len(times)} times in an hour: too close to a crash loop")

    def test_a_deck_that_recovers_and_stays_up_goes_back_to_the_base_cooldown(self) -> None:
        self._restart_times(ticks=40, tick_seconds=TermdeckConfig.WATCHDOG_INTERVAL_SECONDS)
        self.assertGreater(self._watchdog().read_state()["restarts_since_healthy"], 1)

        # A run of healthy probes is what recovery means.
        for _ in range(TermdeckConfig.WATCHDOG_FAILURE_THRESHOLD):
            self.clock += TermdeckConfig.WATCHDOG_INTERVAL_SECONDS
            self._tick(healthy=True)

        state = self._watchdog().read_state()
        self.assertEqual(state["restarts_since_healthy"], 0)
        self.assertEqual(ServiceWatchdog.current_cooldown(state),
                         TermdeckConfig.WATCHDOG_RESTART_COOLDOWN_SECONDS)

    def test_a_deck_that_answers_once_then_wedges_again_does_not_reset_the_backoff(self) -> None:
        # A server that binds, answers a single probe and dies again is still a crash loop; treating that
        # first answer as recovery would let it restart at the base rate forever. Elapsed time since the
        # restart cannot tell these apart, which is why a streak of healthy probes is what counts.
        self._restart_times(ticks=40, tick_seconds=TermdeckConfig.WATCHDOG_INTERVAL_SECONDS)
        backed_off = self._watchdog().read_state()["restarts_since_healthy"]

        self.clock += TermdeckConfig.WATCHDOG_RESTART_COOLDOWN_SECONDS * 4
        self._tick(healthy=True)

        self.assertEqual(self._watchdog().read_state()["restarts_since_healthy"], backed_off)

    def test_a_restart_command_that_fails_still_counts_against_the_cooldown(self) -> None:
        # Otherwise a launchctl that refuses is retried on every tick: the timestamp was only recorded
        # on success, so the cooldown never started and the crash loop it prevents ran at full speed.
        self.installer.failure = RuntimeError("launchctl: could not find service")
        for _ in range(TermdeckConfig.WATCHDOG_FAILURE_THRESHOLD):
            self._tick(healthy=False)
        first_attempt = self._watchdog().read_state()["last_restart_at"]

        self.installer.failure = None
        self.clock += TermdeckConfig.WATCHDOG_INTERVAL_SECONDS
        outcome = self._tick(healthy=False)

        self.assertGreater(first_attempt, 0)
        self.assertEqual(outcome, ServiceWatchdog.COOLING_DOWN)
        self.assertEqual(self.installer.restarts, 0)

    def test_a_deliberately_stopped_deck_is_left_alone(self) -> None:
        # `termdeck service stop` has to mean something: an unloaded unit is not a frozen one.
        self.installer.loaded = False
        probed: list[bool] = []
        with patch.object(ServiceWatchdog, "probe", staticmethod(lambda *a, **k: probed.append(True) or False)):
            for _ in range(TermdeckConfig.WATCHDOG_FAILURE_THRESHOLD + 2):
                outcome = self._watchdog().tick()

        self.assertEqual(outcome, ServiceWatchdog.NOT_INSTALLED)
        self.assertEqual(probed, [])
        self.assertEqual(self.installer.restarts, 0)

    def test_a_failed_restart_keeps_the_failure_count(self) -> None:
        # If launchctl refuses, the next tick should retry rather than start counting from zero.
        self.installer.failure = RuntimeError("launchctl: could not find service")
        for _ in range(TermdeckConfig.WATCHDOG_FAILURE_THRESHOLD):
            outcome = self._tick(healthy=False)

        self.assertEqual(outcome, ServiceWatchdog.UNANSWERED)
        self.assertGreaterEqual(json.loads(self.state_file.read_text())["consecutive_failures"],
                                TermdeckConfig.WATCHDOG_FAILURE_THRESHOLD)

    def _unwritable_watchdog(self) -> ServiceWatchdog:
        return ServiceWatchdog(self.installer, Path("/nonexistent-root/state.json"), self.log_file,
                               now=lambda: self.clock)

    def test_an_unwritable_state_file_never_restarts_and_says_so(self) -> None:
        # Every tick is a fresh process, so the state file is the only memory there is. Without it the
        # failure count cannot carry between ticks, so the threshold is never reached -- the watchdog is
        # simply not going to restart anything, and the one thing it must not do is fail silently.
        with patch.object(ServiceWatchdog, "probe", staticmethod(lambda *a, **k: False)):
            for _ in range(TermdeckConfig.WATCHDOG_FAILURE_THRESHOLD * 3):
                outcome = self._unwritable_watchdog().tick()
                self.clock += TermdeckConfig.WATCHDOG_INTERVAL_SECONDS

        self.assertEqual(outcome, ServiceWatchdog.STATE_UNWRITABLE)
        self.assertEqual(self.installer.restarts, 0)
        self.assertIn("will not be restarted", self.log_file.read_text())

    def test_a_stale_state_past_the_threshold_does_not_restart_on_every_tick(self) -> None:
        # The dangerous half of an unwritable state file: a count already past the threshold with an
        # expired cooldown. The restart timestamp cannot be persisted either, so every tick would read
        # the same stale state, decide the cooldown had elapsed, and restart the deck again -- exactly
        # the unbounded loop the cooldown exists to prevent.
        stale = {"consecutive_failures": TermdeckConfig.WATCHDOG_FAILURE_THRESHOLD + 1,
                 "last_restart_at": self.clock - TermdeckConfig.WATCHDOG_RESTART_COOLDOWN_MAX_SECONDS * 2}
        watchdog = self._unwritable_watchdog()
        with patch.object(ServiceWatchdog, "probe", staticmethod(lambda *a, **k: False)), \
             patch.object(ServiceWatchdog, "read_state", lambda self: dict(stale)):
            for _ in range(6):
                outcome = watchdog.tick()
                self.clock += TermdeckConfig.WATCHDOG_INTERVAL_SECONDS

        self.assertEqual(outcome, ServiceWatchdog.STATE_UNWRITABLE)
        self.assertEqual(self.installer.restarts, 0,
                         "restarting without being able to record it is an unbounded loop")

    def test_the_restart_attempt_is_persisted_before_the_restart_is_made(self) -> None:
        # Not after: a process killed during the restart command would otherwise lose the attempt, and
        # the next tick would have no cooldown to respect.
        recorded: list[float] = []
        self.installer.restart = lambda: (recorded.append(
            float(self._watchdog().read_state().get("last_restart_at", 0))), "restarted")[1]
        for _ in range(TermdeckConfig.WATCHDOG_FAILURE_THRESHOLD):
            self._tick(healthy=False)

        self.assertEqual(recorded, [self.clock])


class ServiceWatchdogInstallTest(unittest.TestCase):
    """The watchdog is installed with the deck, and -- critically -- is not touched by the restart it
    itself issues."""

    def setUp(self) -> None:
        self.commands: list[tuple[str, ...]] = []
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.unit_file = Path(self.directory.name) / "com.termdeck.plist"
        self.watchdog_unit = Path(self.directory.name) / "com.termdeck.watchdog.plist"
        patches = [
            patch.object(PlatformPaths, "IS_MACOS", True),
            patch.object(ServiceInstaller, "unit_file", staticmethod(lambda: self.unit_file)),
            patch.object(ServiceInstaller, "watchdog_unit_files", staticmethod(lambda: [self.watchdog_unit])),
            patch.object(ServiceInstaller, "_run", staticmethod(self._record)),
            patch.object(ServiceInstaller, "_succeeds", staticmethod(lambda *argv: True)),
        ]
        for active in patches:
            active.start()
            self.addCleanup(active.stop)

    def _record(self, *argv: str, check: bool = True) -> None:
        self.commands.append(argv)

    def test_installing_the_deck_schedules_the_watchdog(self) -> None:
        ServiceInstaller.install()

        self.assertTrue(self.watchdog_unit.exists())
        self.assertIn(("launchctl", "bootstrap", ServiceInstaller._launchd_domain(), str(self.watchdog_unit)),
                      self.commands)

    def test_the_watchdog_job_runs_a_tick_on_an_interval_and_is_never_kept_alive(self) -> None:
        import plistlib

        ServiceInstaller.install()
        payload = plistlib.loads(self.watchdog_unit.read_bytes())

        self.assertEqual(payload["ProgramArguments"][-2:], list(ServiceInstaller.WATCHDOG_ARGS))
        self.assertEqual(payload["StartInterval"], TermdeckConfig.WATCHDOG_INTERVAL_SECONDS)
        self.assertFalse(payload["RunAtLoad"])
        # KeepAlive on a job that exits after every probe would respawn it instantly -- a once-a-minute
        # check becomes a hot loop.
        self.assertNotIn("KeepAlive", payload)

    def test_restart_leaves_the_watchdog_job_alone(self) -> None:
        # restart() is what a watchdog tick calls. If it bounced the watchdog job too, launchd would kill
        # the tick mid-flight, before it recorded the restart it had just performed.
        ServiceInstaller.restart()

        self.assertEqual(self.commands,
                         [("launchctl", "kickstart", "-kp", f"{ServiceInstaller._launchd_domain()}/com.termdeck")])

    def test_stopping_the_deck_unschedules_the_watchdog(self) -> None:
        self.watchdog_unit.write_text("plist")

        ServiceInstaller.stop()

        self.assertFalse(self.watchdog_unit.exists())
        self.assertIn(("launchctl", "bootout", f"{ServiceInstaller._launchd_domain()}/com.termdeck.watchdog"),
                      self.commands)

    def test_uninstalling_removes_both_jobs(self) -> None:
        self.unit_file.write_text("plist")
        self.watchdog_unit.write_text("plist")

        ServiceInstaller.uninstall()

        self.assertFalse(self.unit_file.exists())
        self.assertFalse(self.watchdog_unit.exists())


if __name__ == "__main__":
    unittest.main()
