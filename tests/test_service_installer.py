import io
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

from termdeck.cli import TermdeckCli
from termdeck.platform_paths import PlatformPaths
from termdeck.service_installer import ServiceInstaller


class ServiceInstallerRecoveryTest(unittest.TestCase):
    """The service manager is mocked at the two calls that touch it: `_run` (must succeed or raise) and
    `_succeeds` (a probe). What matters is which commands each action decides to issue."""

    def setUp(self) -> None:
        self.commands: list[tuple[str, ...]] = []
        self.loaded = False
        self.directory = tempfile.TemporaryDirectory()
        self.unit_file = Path(self.directory.name) / "com.termdeck.plist"
        patches = [
            patch.object(PlatformPaths, "IS_MACOS", True),
            patch.object(ServiceInstaller, "unit_file", staticmethod(lambda: self.unit_file)),
            patch.object(ServiceInstaller, "_run", staticmethod(self._record)),
            patch.object(ServiceInstaller, "_succeeds", staticmethod(lambda *argv: self.loaded)),
            patch.object(ServiceInstaller, "install", staticmethod(self._fake_install)),
        ]
        for active in patches:
            active.start()
            self.addCleanup(active.stop)
        self.addCleanup(self.directory.cleanup)

    def _record(self, *argv: str, check: bool = True) -> None:
        self.commands.append(argv)

    def _fake_install(self) -> Path:
        self.commands.append(("install",))
        self.unit_file.write_text("plist")
        self.loaded = True
        return self.unit_file

    def test_restart_on_a_never_installed_service_installs_it(self) -> None:
        self.assertEqual(ServiceInstaller.restart(), "installed and started")
        self.assertEqual(self.commands, [("install",)])

    def test_restart_on_an_unloaded_unit_file_loads_it_instead_of_failing(self) -> None:
        self.unit_file.write_text("plist")

        self.assertEqual(ServiceInstaller.restart(), "loaded and started")

        self.assertEqual(self.commands, [("launchctl", "bootstrap", ServiceInstaller._launchd_domain(), str(self.unit_file))])

    def test_restart_on_a_loaded_service_kickstarts_it(self) -> None:
        self.loaded = True

        self.assertEqual(ServiceInstaller.restart(), "restarted")

        self.assertEqual(self.commands, [("launchctl", "kickstart", "-kp", f"{ServiceInstaller._launchd_domain()}/com.termdeck")])

    def test_start_on_a_loaded_service_starts_without_killing_it(self) -> None:
        self.loaded = True

        self.assertEqual(ServiceInstaller.start(), "started")

        self.assertEqual(self.commands, [("launchctl", "kickstart", f"{ServiceInstaller._launchd_domain()}/com.termdeck")])

    def test_stop_unloads_the_job_and_keeps_the_unit_file(self) -> None:
        self.unit_file.write_text("plist")
        self.loaded = True

        self.assertEqual(ServiceInstaller.stop(), "stopped")

        self.assertEqual(self.commands, [("launchctl", "bootout", f"{ServiceInstaller._launchd_domain()}/com.termdeck")])
        self.assertTrue(self.unit_file.exists())

    def test_stop_on_a_stopped_service_says_so_and_touches_nothing(self) -> None:
        self.assertEqual(ServiceInstaller.stop(), "not running")
        self.assertEqual(self.commands, [])


class ServiceCliTest(unittest.TestCase):
    def test_start_and_stop_are_accepted_by_the_parser(self) -> None:
        parser = TermdeckCli.build_parser()
        for action in ("start", "stop", "restart"):
            self.assertEqual(getattr(parser.parse_args(["service", action]), TermdeckCli.SERVICE_ACTION_DEST), action)

    def test_a_service_manager_refusal_is_one_line_on_stderr_not_a_traceback(self) -> None:
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(ServiceInstaller, "restart",
                          staticmethod(lambda: (_ for _ in ()).throw(RuntimeError("launchctl kickstart failed (113)")))), \
             redirect_stdout(stdout), redirect_stderr(stderr):
            code = TermdeckCli.run_service_action("restart")

        self.assertEqual(code, TermdeckCli.EXIT_FAILURE)
        self.assertEqual(stderr.getvalue().strip(), "termdeck service restart: launchctl kickstart failed (113)")
        self.assertEqual(stdout.getvalue(), "")

    def test_start_reports_what_was_done_and_where_it_runs(self) -> None:
        stdout = io.StringIO()
        with patch.object(ServiceInstaller, "start", staticmethod(lambda: "installed and started")), redirect_stdout(stdout):
            code = TermdeckCli.run_service_action("start")

        self.assertEqual(code, TermdeckCli.EXIT_OK)
        self.assertTrue(stdout.getvalue().startswith("installed and started · http://"))


if __name__ == "__main__":
    unittest.main()
