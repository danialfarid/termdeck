import os
import subprocess
import sys
import time
from pathlib import Path


class ServerRestartHelper:
    PROCESS_POLL_INTERVAL_SECONDS = 0.1

    @staticmethod
    def launch(process_id: int, launch_argv: list[str], working_directory: Path,
               environment: dict[str, str]) -> None:
        helper_argv = [sys.executable, "-m", "termdeck.restart_helper", str(process_id), *launch_argv]
        subprocess.Popen(helper_argv, cwd=working_directory, env=environment, close_fds=True,
                         start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL)

    @staticmethod
    def wait_for_process_exit(process_id: int) -> None:
        while True:
            try:
                os.kill(process_id, 0)
            except (ProcessLookupError, PermissionError):
                return
            time.sleep(ServerRestartHelper.PROCESS_POLL_INTERVAL_SECONDS)

    @staticmethod
    def run(argv: list[str]) -> int:
        process_id = int(argv[1])
        launch_argv = argv[2:]
        ServerRestartHelper.wait_for_process_exit(process_id)
        os.execvpe(launch_argv[0], launch_argv, os.environ)
        return 0


if __name__ == "__main__":
    sys.exit(ServerRestartHelper.run(sys.argv))
