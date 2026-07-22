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
    LAUNCHD_PLIST_DIR = Path.home() / "Library" / "LaunchAgents"
    SYSTEMD_UNIT_DIR = Path.home() / ".config" / "systemd" / "user"
    LAUNCHCTL_BIN = "launchctl"
    SYSTEMCTL_BIN = "systemctl"
    JOURNALCTL_BIN = "journalctl"
    TAIL_BIN = "tail"
    LOG_FILE_NAME = "termdeck.log"
    CONSOLE_SCRIPT_NAME = "termdeck"
    MODULE_ARGS = ("-m", "termdeck")
    FORWARDED_ENV_KEYS = (PlatformPaths.ENV_HOST, PlatformPaths.ENV_PORT, PlatformPaths.ENV_DATA_DIR,
                          PlatformPaths.ENV_DEFAULT_CWD, PlatformPaths.ENV_FILE_ROOT, PlatformPaths.ENV_SHELL,
                          PlatformPaths.ENV_DTACH_BIN, PlatformPaths.ENV_RG_BIN, PlatformPaths.ENV_LOG_LEVEL)
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

    @staticmethod
    def launch_argv() -> list[str]:
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
    def unit_file() -> Path:
        if PlatformPaths.IS_MACOS:
            return ServiceInstaller.LAUNCHD_PLIST_DIR / f"{ServiceInstaller.LABEL}.plist"
        return ServiceInstaller.SYSTEMD_UNIT_DIR / ServiceInstaller.SYSTEMD_UNIT_NAME

    @staticmethod
    def install() -> Path:
        from termdeck.config import TermdeckConfig

        TermdeckConfig.DATA_DIR.mkdir(parents=True, exist_ok=True)
        unit_file = ServiceInstaller.unit_file()
        unit_file.parent.mkdir(parents=True, exist_ok=True)
        if PlatformPaths.IS_MACOS:
            ServiceInstaller._write_launchd_plist(unit_file)
            ServiceInstaller._bootout_launchd_quietly()
            ServiceInstaller._run(ServiceInstaller.LAUNCHCTL_BIN, "bootstrap", ServiceInstaller._launchd_domain(),
                                  str(unit_file))
        else:
            unit_file.write_text(ServiceInstaller._render_systemd_unit())
            ServiceInstaller._run(ServiceInstaller.SYSTEMCTL_BIN, "--user", "daemon-reload")
            ServiceInstaller._run(ServiceInstaller.SYSTEMCTL_BIN, "--user", "enable", "--now",
                                  ServiceInstaller.SYSTEMD_UNIT_NAME)
        return unit_file

    @staticmethod
    def uninstall() -> Path:
        unit_file = ServiceInstaller.unit_file()
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
    def restart() -> None:
        if PlatformPaths.IS_MACOS:
            ServiceInstaller._run(ServiceInstaller.LAUNCHCTL_BIN, "kickstart", "-kp",
                                  f"{ServiceInstaller._launchd_domain()}/{ServiceInstaller.LABEL}")
        else:
            ServiceInstaller._run(ServiceInstaller.SYSTEMCTL_BIN, "--user", "restart",
                                  ServiceInstaller.SYSTEMD_UNIT_NAME)

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
    def _render_systemd_unit() -> str:
        environment = ServiceInstaller.forwarded_environment()
        environment_lines = "".join(f'Environment="{key}={value}"\n' for key, value in environment.items())
        return ServiceInstaller.SYSTEMD_UNIT_TEMPLATE.format(
            exec_start=" ".join(ServiceInstaller.launch_argv()), working_directory=str(Path.home()),
            environment_lines=environment_lines)

    @staticmethod
    def _bootout_launchd_quietly() -> None:
        ServiceInstaller._run(ServiceInstaller.LAUNCHCTL_BIN, "bootout",
                              f"{ServiceInstaller._launchd_domain()}/{ServiceInstaller.LABEL}", check=False)

    @staticmethod
    def _run(*argv: str, check: bool = True) -> None:
        result = subprocess.run(argv, capture_output=True, text=True)
        if check and result.returncode != 0:
            raise RuntimeError(f"{' '.join(argv)} failed ({result.returncode}): {result.stderr.strip()}")
