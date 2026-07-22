import argparse
import os
import subprocess
import sys
import threading
import webbrowser

from termdeck.platform_paths import PlatformPaths


class TermdeckCli:
    """The `termdeck` command. Flags are translated into TERMDECK_* environment variables before anything from
    the server package is imported, because TermdeckConfig snapshots the environment at import time — that is
    what lets `termdeck --port 9000 service install` bake the same port into the generated service unit.

    Subcommands: (none) runs the server, `doctor` reports external dependencies, `service` manages the
    always-on launchd/systemd unit."""

    PROGRAM_NAME = "termdeck"
    DESCRIPTION = "Browser terminal deck with persistent sessions and claude/codex resume."
    SERVICE_COMMAND = "service"
    DOCTOR_COMMAND = "doctor"
    SERVICE_ACTION_DEST = "service_action"
    SERVICE_INSTALL = "install"
    SERVICE_UNINSTALL = "uninstall"
    SERVICE_RESTART = "restart"
    SERVICE_STATUS = "status"
    SERVICE_LOGS = "logs"
    COMMAND_DEST = "command"
    BROWSER_OPEN_DELAY_SECONDS = 1.5
    EXIT_OK = 0
    EXIT_FAILURE = 1
    OK_MARK = "ok "
    MISSING_MARK = "MISSING"
    OPTIONAL_MARK = "-  "

    @staticmethod
    def main(argv: list[str] | None = None) -> int:
        parser = TermdeckCli.build_parser()
        args = parser.parse_args(argv)
        TermdeckCli.apply_environment_overrides(args)
        if args.command == TermdeckCli.DOCTOR_COMMAND:
            return TermdeckCli.run_doctor()
        if args.command == TermdeckCli.SERVICE_COMMAND:
            return TermdeckCli.run_service_action(getattr(args, TermdeckCli.SERVICE_ACTION_DEST))
        return TermdeckCli.run_server(args.open_browser)

    @staticmethod
    def build_parser() -> argparse.ArgumentParser:
        from termdeck import __version__

        parser = argparse.ArgumentParser(prog=TermdeckCli.PROGRAM_NAME, description=TermdeckCli.DESCRIPTION)
        parser.add_argument("--version", action="version", version=f"{TermdeckCli.PROGRAM_NAME} {__version__}")
        parser.add_argument("--host", help="interface to bind (default 127.0.0.1; use 0.0.0.0 only behind a trusted network)")
        parser.add_argument("--port", type=int, help="port to serve on (default 8530)")
        parser.add_argument("--data-dir", help="where sessions/settings/scrollback live (default ~/.termdeck)")
        parser.add_argument("--default-cwd", help="starting directory for new terminals (default ~)")
        parser.add_argument("--file-root", help="directory the file browser is confined to (default ~)")
        parser.add_argument("--log-level", help="uvicorn log level: critical, error, warning, info, debug, trace")
        parser.add_argument("--open", dest="open_browser", action="store_true", help="open the UI in a browser once the server is up")
        subparsers = parser.add_subparsers(dest=TermdeckCli.COMMAND_DEST)
        subparsers.add_parser(TermdeckCli.DOCTOR_COMMAND, help="report which external programs termdeck found")
        service_parser = subparsers.add_parser(TermdeckCli.SERVICE_COMMAND, help="manage the always-on background service")
        service_parser.add_argument(TermdeckCli.SERVICE_ACTION_DEST,
                                    choices=(TermdeckCli.SERVICE_INSTALL, TermdeckCli.SERVICE_UNINSTALL,
                                             TermdeckCli.SERVICE_RESTART, TermdeckCli.SERVICE_STATUS,
                                             TermdeckCli.SERVICE_LOGS))
        return parser

    @staticmethod
    def apply_environment_overrides(args: argparse.Namespace) -> None:
        overrides: tuple[tuple[str, str | int | None], ...] = (
            (PlatformPaths.ENV_HOST, args.host), (PlatformPaths.ENV_PORT, args.port),
            (PlatformPaths.ENV_DATA_DIR, args.data_dir), (PlatformPaths.ENV_DEFAULT_CWD, args.default_cwd),
            (PlatformPaths.ENV_FILE_ROOT, args.file_root), (PlatformPaths.ENV_LOG_LEVEL, args.log_level),
        )
        for key, value in overrides:
            if value is not None:
                os.environ[key] = str(value)

    @staticmethod
    def run_server(open_browser: bool) -> int:
        from setproctitle import setproctitle

        setproctitle("_termdeck")
        from termdeck.config import TermdeckConfig
        from termdeck.environment_check import EnvironmentCheck
        from termdeck.server import TermdeckServer

        EnvironmentCheck.raise_if_required_missing()
        url = f"http://{TermdeckConfig.HOST}:{TermdeckConfig.PORT}"
        print(f"termdeck  {url}   data: {TermdeckConfig.DATA_DIR}", flush=True)
        if open_browser:
            threading.Timer(TermdeckCli.BROWSER_OPEN_DELAY_SECONDS, webbrowser.open, args=(url,)).start()
        TermdeckServer().run()
        return TermdeckCli.EXIT_OK

    @staticmethod
    def run_doctor() -> int:
        from termdeck.config import TermdeckConfig
        from termdeck.environment_check import EnvironmentCheck

        reports = EnvironmentCheck.collect_reports()
        print(f"termdeck  http://{TermdeckConfig.HOST}:{TermdeckConfig.PORT}")
        print(f"data dir  {TermdeckConfig.DATA_DIR}")
        print(f"file root {TermdeckConfig.FILE_ACCESS_ROOT}")
        print(f"shell     {TermdeckConfig.SHELL}\n")
        for report in reports:
            if report.is_present:
                mark = TermdeckCli.OK_MARK
            else:
                mark = TermdeckCli.MISSING_MARK if report.is_required else TermdeckCli.OPTIONAL_MARK
            location = report.resolved_path if report.is_present else f"not found - {report.install_hint}"
            print(f"[{mark}] {report.program:<8} {location}")
            if not report.is_present:
                print(f"           needed for: {report.used_for}")
        missing = EnvironmentCheck.missing_required(reports)
        print("\nall required programs present" if not missing else f"\n{len(missing)} required program(s) missing")
        return TermdeckCli.EXIT_OK if not missing else TermdeckCli.EXIT_FAILURE

    @staticmethod
    def run_service_action(action: str) -> int:
        from termdeck.service_installer import ServiceInstaller

        if action == TermdeckCli.SERVICE_INSTALL:
            unit_file = ServiceInstaller.install()
            from termdeck.config import TermdeckConfig

            print(f"installed {unit_file}\nrunning at http://{TermdeckConfig.HOST}:{TermdeckConfig.PORT}")
            return TermdeckCli.EXIT_OK
        if action == TermdeckCli.SERVICE_UNINSTALL:
            print(f"removed {ServiceInstaller.uninstall()}")
            return TermdeckCli.EXIT_OK
        if action == TermdeckCli.SERVICE_RESTART:
            ServiceInstaller.restart()
            print("restarted")
            return TermdeckCli.EXIT_OK
        argv = ServiceInstaller.status_argv() if action == TermdeckCli.SERVICE_STATUS else ServiceInstaller.logs_argv()
        return subprocess.run(argv).returncode


if __name__ == "__main__":
    sys.exit(TermdeckCli.main())
