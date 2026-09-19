import os
import plistlib
import subprocess
import sys
from pathlib import Path

from termdeck.platform_paths import PlatformPaths


class ServiceInstaller:
    """Installs termdeck as an always-on per-user background service: a launchd agent on macOS, a systemd user
    unit on Linux. Both are generated from the interpreter/console-script that is running right now, and both
    carry the TERMDECK_* variables currently in the environment so `termdeck --port 9000 service install`
    persists that port. Nothing is ever written outside the user's own home directory."""

    LABEL = "com.termdeck"
    SYSTEMD_UNIT_NAME = "termdeck.service"
    # The freeze watchdog ships as a second, short-lived job on a timer rather than as a thread inside
    # the server: the failure it watches for is the server's own event loop stopping, and nothing running
    # on that loop can report that it has stopped.
    WATCHDOG_LABEL = "com.termdeck.watchdog"
    WATCHDOG_SYSTEMD_UNIT_NAME = "termdeck-watchdog.service"
    WATCHDOG_SYSTEMD_TIMER_NAME = "termdeck-watchdog.timer"
    WATCHDOG_ARGS = ("service", "watchdog-tick")
    LAUNCHD_PLIST_DIR = Path.home() / "Library" / "LaunchAgents"
    SYSTEMD_UNIT_DIR = Path.home() / ".config" / "systemd" / "user"
    LAUNCHCTL_BIN = "launchctl"
    SYSTEMCTL_BIN = "systemctl"
    JOURNALCTL_BIN = "journalctl"
    TAIL_BIN = "tail"
    LOG_FILE_NAME = "termdeck.log"
    CONSOLE_SCRIPT_NAME = "termdeck"
    MODULE_ARGS = ("-m", "termdeck")
    SERVICE_NOT_FOUND_MARKERS = ("could not find service", "could not be found", "not found", "not loaded")
    FORWARDED_ENV_KEYS = (PlatformPaths.ENV_HOST, PlatformPaths.ENV_PORT, PlatformPaths.ENV_LAN_PORT,
                          PlatformPaths.ENV_DATA_DIR,
                          PlatformPaths.ENV_DEFAULT_CWD, PlatformPaths.ENV_FILE_ROOT, PlatformPaths.ENV_SHELL,
                          PlatformPaths.ENV_DTACH_BIN, PlatformPaths.ENV_RG_BIN, PlatformPaths.ENV_LOG_LEVEL,
                          PlatformPaths.ENV_REMOTE_URL, PlatformPaths.ENV_ACCESS_TOKEN, PlatformPaths.ENV_READ_ONLY)
    SYSTEMD_UNIT_TEMPLATE = """[Unit]
Description=TermDeck - browser terminal deck with agent session resume
After=default.target

[Service]
Type=simple
ExecStart={exec_start}
WorkingDirectory={working_directory}
Restart=always
RestartSec=2
{environment_lines}
[Install]
WantedBy=default.target
"""
    WATCHDOG_SYSTEMD_UNIT_TEMPLATE = """[Unit]
Description=TermDeck freeze watchdog - restarts the deck when it stops answering

[Service]
Type=oneshot
ExecStart={exec_start}
WorkingDirectory={working_directory}
{environment_lines}"""
    WATCHDOG_SYSTEMD_TIMER_TEMPLATE = """[Unit]
Description=TermDeck freeze watchdog timer

[Timer]
OnBootSec={interval}s
OnUnitActiveSec={interval}s
AccuracySec=5s
Unit={unit}

[Install]
WantedBy=timers.target
"""

    @staticmethod
    def launch_argv() -> list[str]:
        installed_module_path = str(Path(__file__).resolve())
        cellar_marker = "/Cellar/termdeck/"
        if cellar_marker in installed_module_path:
            stable_console_script = Path(installed_module_path.split(cellar_marker, 1)[0]) / "opt" / "termdeck" / "bin" / ServiceInstaller.CONSOLE_SCRIPT_NAME
            if not stable_console_script.is_file():
                raise FileNotFoundError(stable_console_script)
            return [str(stable_console_script)]
        console_script = Path(sys.executable).parent / ServiceInstaller.CONSOLE_SCRIPT_NAME
        if console_script.exists():
            return [str(console_script)]
        return [sys.executable, *ServiceInstaller.MODULE_ARGS]

    @staticmethod
    def forwarded_environment() -> dict[str, str]:
        return {key: os.environ[key] for key in ServiceInstaller.FORWARDED_ENV_KEYS if os.environ.get(key, "").strip()}

    @staticmethod
    def log_file() -> Path:
        from termdeck.config import TermdeckConfig

        return TermdeckConfig.DATA_DIR / ServiceInstaller.LOG_FILE_NAME

    @staticmethod
    def watchdog_log_file() -> Path:
        from termdeck.config import TermdeckConfig

        return TermdeckConfig.WATCHDOG_LOG_FILE

    @staticmethod
    def unit_file() -> Path:
        if PlatformPaths.IS_MACOS:
            return ServiceInstaller.LAUNCHD_PLIST_DIR / f"{ServiceInstaller.LABEL}.plist"
        return ServiceInstaller.SYSTEMD_UNIT_DIR / ServiceInstaller.SYSTEMD_UNIT_NAME

    @staticmethod
    def watchdog_unit_files() -> list[Path]:
        """The watchdog's own unit file(s): one plist on macOS, a service plus its timer on Linux."""
        if PlatformPaths.IS_MACOS:
            return [ServiceInstaller.LAUNCHD_PLIST_DIR / f"{ServiceInstaller.WATCHDOG_LABEL}.plist"]
        return [ServiceInstaller.SYSTEMD_UNIT_DIR / ServiceInstaller.WATCHDOG_SYSTEMD_UNIT_NAME,
                ServiceInstaller.SYSTEMD_UNIT_DIR / ServiceInstaller.WATCHDOG_SYSTEMD_TIMER_NAME]

    @staticmethod
    def install_watchdog() -> None:
        """Install and load the freeze watchdog beside the server.

        Failures here are reported but never raised: a deck that is running is worth more than a deck
        that refused to install because its watchdog could not be scheduled.
        """
        from termdeck.config import TermdeckConfig

        try:
            unit_files = ServiceInstaller.watchdog_unit_files()
            unit_files[0].parent.mkdir(parents=True, exist_ok=True)
            if PlatformPaths.IS_MACOS:
                ServiceInstaller._write_watchdog_launchd_plist(unit_files[0])
                unit_files[0].chmod(0o600)
                ServiceInstaller._bootout_launchd_quietly(ServiceInstaller.WATCHDOG_LABEL)
                ServiceInstaller._run(ServiceInstaller.LAUNCHCTL_BIN, "bootstrap",
                                      ServiceInstaller._launchd_domain(), str(unit_files[0]))
                return
            service_file, timer_file = unit_files
            service_file.write_text(ServiceInstaller.WATCHDOG_SYSTEMD_UNIT_TEMPLATE.format(
                exec_start=" ".join([*ServiceInstaller.launch_argv(), *ServiceInstaller.WATCHDOG_ARGS]),
                working_directory=str(Path.home()),
                environment_lines=ServiceInstaller._environment_lines()))
            timer_file.write_text(ServiceInstaller.WATCHDOG_SYSTEMD_TIMER_TEMPLATE.format(
                interval=TermdeckConfig.WATCHDOG_INTERVAL_SECONDS,
                unit=ServiceInstaller.WATCHDOG_SYSTEMD_UNIT_NAME))
            for unit in unit_files:
                unit.chmod(0o600)
            ServiceInstaller._run(ServiceInstaller.SYSTEMCTL_BIN, "--user", "daemon-reload")
            ServiceInstaller._run(ServiceInstaller.SYSTEMCTL_BIN, "--user", "enable", "--now",
                                  ServiceInstaller.WATCHDOG_SYSTEMD_TIMER_NAME)
        except (RuntimeError, OSError) as watchdog_error:
            print(f"termdeck: freeze watchdog not scheduled ({watchdog_error})", file=sys.stderr)

    @staticmethod
    def uninstall_watchdog() -> None:
        if PlatformPaths.IS_MACOS:
            ServiceInstaller._bootout_launchd_quietly(ServiceInstaller.WATCHDOG_LABEL)
        else:
            ServiceInstaller._run(ServiceInstaller.SYSTEMCTL_BIN, "--user", "disable", "--now",
                                  ServiceInstaller.WATCHDOG_SYSTEMD_TIMER_NAME, check=False)
        for unit in ServiceInstaller.watchdog_unit_files():
            if unit.exists():
                unit.unlink()

    @staticmethod
    def install() -> Path:
        from termdeck.config import TermdeckConfig

        TermdeckConfig.DATA_DIR.mkdir(parents=True, exist_ok=True)
        unit_file = ServiceInstaller.unit_file()
        unit_file.parent.mkdir(parents=True, exist_ok=True)
        if PlatformPaths.IS_MACOS:
            ServiceInstaller._write_launchd_plist(unit_file)
            unit_file.chmod(0o600)
            ServiceInstaller._bootout_launchd_quietly()
            ServiceInstaller._run(ServiceInstaller.LAUNCHCTL_BIN, "bootstrap", ServiceInstaller._launchd_domain(),
                                  str(unit_file))
        else:
            unit_file.write_text(ServiceInstaller._render_systemd_unit())
            unit_file.chmod(0o600)
            ServiceInstaller._run(ServiceInstaller.SYSTEMCTL_BIN, "--user", "daemon-reload")
            ServiceInstaller._run(ServiceInstaller.SYSTEMCTL_BIN, "--user", "enable", "--now",
                                  ServiceInstaller.SYSTEMD_UNIT_NAME)
        ServiceInstaller.install_watchdog()
        return unit_file

    @staticmethod
    def uninstall() -> Path:
        unit_file = ServiceInstaller.unit_file()
        ServiceInstaller.uninstall_watchdog()
        if PlatformPaths.IS_MACOS:
            ServiceInstaller._bootout_launchd_quietly()
        else:
            ServiceInstaller._run(ServiceInstaller.SYSTEMCTL_BIN, "--user", "disable", "--now",
                                  ServiceInstaller.SYSTEMD_UNIT_NAME, check=False)
        if unit_file.exists():
            unit_file.unlink()
        if not PlatformPaths.IS_MACOS:
            ServiceInstaller._run(ServiceInstaller.SYSTEMCTL_BIN, "--user", "daemon-reload")
        return unit_file

    @staticmethod
    def is_loaded() -> bool:
        """Whether the service manager currently knows the unit -- bootstrapped on macOS, loaded on Linux."""
        if PlatformPaths.IS_MACOS:
            return ServiceInstaller._succeeds(ServiceInstaller.LAUNCHCTL_BIN, "print",
                                              f"{ServiceInstaller._launchd_domain()}/{ServiceInstaller.LABEL}")
        # is-active, not cat. `cat` only proves a unit file exists, so a deck the user stopped with
        # `termdeck service stop` still read as loaded -- and the watchdog's guard against reviving a
        # deliberately stopped deck rests on this answer.
        return ServiceInstaller._succeeds(ServiceInstaller.SYSTEMCTL_BIN, "--user", "is-active",
                                          "--quiet", ServiceInstaller.SYSTEMD_UNIT_NAME)

    @staticmethod
    def is_current_process_owned_by_service_manager(process_id: int) -> bool | None:
        if PlatformPaths.IS_MACOS:
            result = ServiceInstaller._probe(ServiceInstaller.LAUNCHCTL_BIN, "print",
                                             f"{ServiceInstaller._launchd_domain()}/{ServiceInstaller.LABEL}")
            if result is None:
                return None
            if result.returncode != 0:
                return False if ServiceInstaller._reports_missing_service(result) else None
            for line in result.stdout.splitlines():
                if line.strip().startswith("pid = "):
                    return line.split("=", 1)[1].strip() == str(process_id)
            return None
        if os.name == "nt":
            return None
        result = ServiceInstaller._probe(ServiceInstaller.SYSTEMCTL_BIN, "--user", "show",
                                         ServiceInstaller.SYSTEMD_UNIT_NAME, "--property=MainPID", "--value")
        if result is None:
            return None
        if result.returncode != 0:
            return False if ServiceInstaller._reports_missing_service(result) else None
        value = result.stdout.strip()
        if "=" in value:
            value = value.rsplit("=", 1)[1].strip()
        try:
            return int(value) == process_id
        except ValueError:
            return None

    @staticmethod
    def launch_replacement_after_process_exit(process_id: int) -> None:
        from termdeck.restart_helper import ServerRestartHelper

        launch_argv = [*ServiceInstaller.launch_argv(), *sys.argv[1:]]
        ServerRestartHelper.launch(process_id, launch_argv, Path.cwd(), os.environ.copy())

    @staticmethod
    def start() -> str:
        """Start the service, installing it first if it has never been installed.

        Returns what was done, for the CLI to print. A `start` (or `restart`) on a machine where only
        `brew install` has run used to die in launchctl with "Could not find service": the unit had
        never been bootstrapped. Nothing about that situation needs a person to sort out, so it is
        sorted out here -- an existing unit file is loaded, a missing one is written and loaded."""
        if ServiceInstaller.is_loaded():
            if PlatformPaths.IS_MACOS:
                ServiceInstaller._run(ServiceInstaller.LAUNCHCTL_BIN, "kickstart",
                                      f"{ServiceInstaller._launchd_domain()}/{ServiceInstaller.LABEL}")
            else:
                ServiceInstaller._run(ServiceInstaller.SYSTEMCTL_BIN, "--user", "start",
                                      ServiceInstaller.SYSTEMD_UNIT_NAME)
            ServiceInstaller.install_watchdog()
            return "started"
        if not ServiceInstaller.unit_file().exists():
            ServiceInstaller.install()
            return "installed and started"
        if PlatformPaths.IS_MACOS:
            ServiceInstaller._run(ServiceInstaller.LAUNCHCTL_BIN, "bootstrap", ServiceInstaller._launchd_domain(),
                                  str(ServiceInstaller.unit_file()))
        else:
            ServiceInstaller._run(ServiceInstaller.SYSTEMCTL_BIN, "--user", "daemon-reload")
            ServiceInstaller._run(ServiceInstaller.SYSTEMCTL_BIN, "--user", "start",
                                  ServiceInstaller.SYSTEMD_UNIT_NAME)
        ServiceInstaller.install_watchdog()
        return "loaded and started"

    @staticmethod
    def stop() -> str:
        """Stop the service until the next `start` or login. The unit file stays, so this is the
        counterpart of `start`, not of `install`: `uninstall` is what removes it for good."""
        if not ServiceInstaller.is_loaded():
            return "not running"
        # The watchdog goes first. It would not revive a deliberately stopped deck either way -- a tick
        # checks that the server's unit is still loaded before it probes -- but leaving a timer firing
        # every minute against something the user turned off is noise for no purpose.
        ServiceInstaller.uninstall_watchdog()
        if PlatformPaths.IS_MACOS:
            # KeepAlive would revive a merely killed process; unloading the job is what stops it.
            ServiceInstaller._bootout_launchd_quietly()
        else:
            ServiceInstaller._run(ServiceInstaller.SYSTEMCTL_BIN, "--user", "stop",
                                  ServiceInstaller.SYSTEMD_UNIT_NAME)
        return "stopped"

    @staticmethod
    def restart() -> str:
        """Restart the server only.

        The watchdog is deliberately left alone: this is the method a watchdog tick calls when it decides
        the deck is wedged, and restarting the watchdog job from inside one of its own ticks would kill
        the tick partway through -- before it recorded the restart it just performed, so the next tick
        would see the old failure count and bounce the recovering server again.
        """
        if not ServiceInstaller.is_loaded():
            return ServiceInstaller.start()
        if PlatformPaths.IS_MACOS:
            ServiceInstaller._run(ServiceInstaller.LAUNCHCTL_BIN, "kickstart", "-kp",
                                  f"{ServiceInstaller._launchd_domain()}/{ServiceInstaller.LABEL}")
        else:
            ServiceInstaller._run(ServiceInstaller.SYSTEMCTL_BIN, "--user", "restart",
                                  ServiceInstaller.SYSTEMD_UNIT_NAME)
        return "restarted"

    @staticmethod
    def is_watchdog_loaded() -> bool:
        if PlatformPaths.IS_MACOS:
            return ServiceInstaller._succeeds(ServiceInstaller.LAUNCHCTL_BIN, "print",
                                              f"{ServiceInstaller._launchd_domain()}/{ServiceInstaller.WATCHDOG_LABEL}")
        return ServiceInstaller._succeeds(ServiceInstaller.SYSTEMCTL_BIN, "--user", "is-active",
                                          ServiceInstaller.WATCHDOG_SYSTEMD_TIMER_NAME)

    @staticmethod
    def status_argv() -> list[str]:
        if PlatformPaths.IS_MACOS:
            return [ServiceInstaller.LAUNCHCTL_BIN, "print",
                    f"{ServiceInstaller._launchd_domain()}/{ServiceInstaller.LABEL}"]
        return [ServiceInstaller.SYSTEMCTL_BIN, "--user", "status", ServiceInstaller.SYSTEMD_UNIT_NAME]

    @staticmethod
    def logs_argv() -> list[str]:
        if PlatformPaths.IS_MACOS:
            return [ServiceInstaller.TAIL_BIN, "-n", "200", "-f", str(ServiceInstaller.log_file())]
        return [ServiceInstaller.JOURNALCTL_BIN, "--user", "-u", ServiceInstaller.SYSTEMD_UNIT_NAME, "-n", "200", "-f"]

    @staticmethod
    def _launchd_domain() -> str:
        return f"gui/{os.getuid()}"

    @staticmethod
    def _write_launchd_plist(unit_file: Path) -> None:
        log_file = str(ServiceInstaller.log_file())
        payload: dict[str, object] = {
            "Label": ServiceInstaller.LABEL,
            "ProgramArguments": ServiceInstaller.launch_argv(),
            "WorkingDirectory": str(Path.home()),
            "RunAtLoad": True,
            "KeepAlive": True,
            "StandardOutPath": log_file,
            "StandardErrorPath": log_file,
        }
        environment = ServiceInstaller.forwarded_environment()
        if environment:
            payload["EnvironmentVariables"] = environment
        unit_file.write_bytes(plistlib.dumps(payload))

    @staticmethod
    def _write_watchdog_launchd_plist(unit_file: Path) -> None:
        from termdeck.config import TermdeckConfig

        log_file = str(ServiceInstaller.watchdog_log_file())
        payload: dict[str, object] = {
            "Label": ServiceInstaller.WATCHDOG_LABEL,
            "ProgramArguments": [*ServiceInstaller.launch_argv(), *ServiceInstaller.WATCHDOG_ARGS],
            "WorkingDirectory": str(Path.home()),
            # StartInterval, and pointedly NOT KeepAlive: each tick is meant to run, probe once and exit.
            # KeepAlive would respawn it the instant it finished, turning a once-a-minute check into a
            # hot loop. RunAtLoad is off for the same reason a boot is not a good time to probe -- the
            # server it watches is still coming up.
            "StartInterval": TermdeckConfig.WATCHDOG_INTERVAL_SECONDS,
            "RunAtLoad": False,
            "StandardOutPath": log_file,
            "StandardErrorPath": log_file,
        }
        environment = ServiceInstaller.forwarded_environment()
        if environment:
            payload["EnvironmentVariables"] = environment
        unit_file.write_bytes(plistlib.dumps(payload))

    @staticmethod
    def _environment_lines() -> str:
        return "".join(f'Environment="{key}={value}"\n'
                       for key, value in ServiceInstaller.forwarded_environment().items())

    @staticmethod
    def _render_systemd_unit() -> str:
        return ServiceInstaller.SYSTEMD_UNIT_TEMPLATE.format(
            exec_start=" ".join(ServiceInstaller.launch_argv()), working_directory=str(Path.home()),
            environment_lines=ServiceInstaller._environment_lines())

    @staticmethod
    def _bootout_launchd_quietly(label: str | None = None) -> None:
        ServiceInstaller._run(ServiceInstaller.LAUNCHCTL_BIN, "bootout",
                              f"{ServiceInstaller._launchd_domain()}/{label or ServiceInstaller.LABEL}", check=False)

    # Every call into the service manager is bounded. The watchdog runs these on a timer and its whole
    # design rests on a tick being short-lived; launchctl or systemctl blocking forever would leave a
    # tick hung with nothing watching the watcher.
    SERVICE_COMMAND_TIMEOUT_SECONDS = 30

    @staticmethod
    def _succeeds(*argv: str) -> bool:
        try:
            return subprocess.run(argv, capture_output=True, text=True,
                                  timeout=ServiceInstaller.SERVICE_COMMAND_TIMEOUT_SECONDS).returncode == 0
        except subprocess.TimeoutExpired:
            return False

    @staticmethod
    def _probe(*argv: str) -> subprocess.CompletedProcess[str] | None:
        try:
            return subprocess.run(argv, capture_output=True, text=True, timeout=2, check=False)
        except (OSError, subprocess.SubprocessError):
            return None

    @staticmethod
    def _reports_missing_service(result: subprocess.CompletedProcess[str]) -> bool:
        output = f"{result.stdout}\n{result.stderr}".casefold()
        return any(marker in output for marker in ServiceInstaller.SERVICE_NOT_FOUND_MARKERS)

    @staticmethod
    def _run(*argv: str, check: bool = True) -> None:
        try:
            result = subprocess.run(argv, capture_output=True, text=True,
                                    timeout=ServiceInstaller.SERVICE_COMMAND_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired as timed_out:
            raise RuntimeError(f"{' '.join(argv)} did not finish within "
                               f"{ServiceInstaller.SERVICE_COMMAND_TIMEOUT_SECONDS}s") from timed_out
        if check and result.returncode != 0:
            raise RuntimeError(f"{' '.join(argv)} failed ({result.returncode}): {result.stderr.strip()}")
