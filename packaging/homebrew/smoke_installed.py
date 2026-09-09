import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

from websockets.sync.client import connect


class InstalledFormulaSmoke:
    @staticmethod
    def stop_remaining_test_dtach(directory: str, session_id: str) -> None:
        socket_path = str(Path(directory) / "dtach" / f"{session_id}.sock")
        processes = subprocess.check_output(["/bin/ps", "-axo", "pid=,command="], text=True)
        for row in processes.splitlines():
            process_id, command = row.strip().split(None, 1)
            arguments = command.split()
            if Path(arguments[0]).name == "dtach" and socket_path in arguments:
                try:
                    os.kill(int(process_id), signal.SIGTERM)
                except ProcessLookupError:
                    print(f"Test dtach {process_id} already exited")

    @staticmethod
    def available_port() -> int:
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            return listener.getsockname()[1]

    @staticmethod
    def wait_for_empty_server(base_url: str, server: subprocess.Popen[bytes]) -> None:
        for _ in range(60):
            if server.poll() is not None:
                raise RuntimeError(f"Installed server exited during startup: {server.returncode}")
            try:
                with urllib.request.urlopen(base_url + "/api/sessions", timeout=1) as response:
                    assert json.load(response) == [], "Test server must start with no sessions"
                return
            except urllib.error.URLError:
                time.sleep(0.25)
        raise TimeoutError("Installed server did not start within 15 seconds")

    @staticmethod
    def verify_shell_output(port: int, session_id: str) -> None:
        with connect(f"ws://127.0.0.1:{port}/ws/{session_id}?screen_repaint=1", open_timeout=10) as websocket:
            websocket.send(json.dumps({"type": "resize", "cols": 100, "rows": 30}))
            websocket.send(json.dumps({"type": "input", "data": "printf 'BREW-%s\\n' VM-SHELL-OK\r"}))
            deadline = time.monotonic() + 15
            received = ""
            while time.monotonic() < deadline:
                frame = websocket.recv(timeout=max(0.1, deadline - time.monotonic()))
                received += frame.decode(errors="replace") if isinstance(frame, bytes) else frame
                if "BREW-VM-SHELL-OK" in received:
                    return
            raise AssertionError(f"Missing shell output: {received[-1500:]}")

    @staticmethod
    def run(executable: Path) -> None:
        if not executable.is_file():
            raise FileNotFoundError(executable)
        with tempfile.TemporaryDirectory(prefix="termdeck-brew-smoke-") as directory, tempfile.NamedTemporaryFile() as log:
            port = InstalledFormulaSmoke.available_port()
            environment = dict(os.environ, PATH=f"{executable.parent}:/usr/bin:/bin:/usr/sbin:/sbin",
                               TERMDECK_DATA_DIR=directory, TERMDECK_DEFAULT_CWD=directory, TERMDECK_FILE_ROOT=directory,
                               TERMDECK_HOST="127.0.0.1", TERMDECK_PORT=str(port),
                               TERMDECK_LAN_PORT=str(InstalledFormulaSmoke.available_port()))
            server = subprocess.Popen([str(executable)], env=environment, stdout=log, stderr=log)
            session_id = None
            base_url = f"http://127.0.0.1:{port}"
            try:
                InstalledFormulaSmoke.wait_for_empty_server(base_url, server)
                with urllib.request.urlopen(base_url + "/static/app.js", timeout=5) as response:
                    assert b"class TermdeckApp" in response.read(), "Installed UI asset missing"
                request = urllib.request.Request(base_url + "/api/sessions", data=json.dumps(
                    {"command": "/bin/bash --noprofile --norc", "cwd": directory, "title": "brew-vm-smoke"}).encode(),
                    headers={"Content-Type": "application/json"})
                with urllib.request.urlopen(request, timeout=15) as response:
                    session_id = json.load(response)["session_id"]
                InstalledFormulaSmoke.verify_shell_output(port, session_id)
                print("PASS: installed server, UI, session creation, dtach, WebSocket resize/input/output")
            finally:
                try:
                    if session_id is not None:
                        request = urllib.request.Request(base_url + f"/api/sessions/{session_id}/stop", method="POST")
                        with urllib.request.urlopen(request, timeout=10) as response:
                            assert response.status == 200, "Test terminal stop failed"
                        request = urllib.request.Request(base_url + f"/api/sessions/{session_id}", method="DELETE")
                        with urllib.request.urlopen(request, timeout=10) as response:
                            assert response.status == 200, "Test session cleanup failed"
                finally:
                    if server.poll() is None:
                        server.terminate()
                        server.wait(timeout=15)
                    if session_id is not None:
                        InstalledFormulaSmoke.stop_remaining_test_dtach(directory, session_id)
                    log.seek(0)
                    print(log.read().decode(errors="replace")[-1500:])


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise ValueError("Usage: installed-python smoke_installed.py /absolute/path/to/bin/termdeck")
    InstalledFormulaSmoke.run(Path(sys.argv[1]))
