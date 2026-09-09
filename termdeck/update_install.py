import asyncio
import codecs
import importlib.metadata
import os
import platform
import shlex
import shutil
import sys
import uuid
from pathlib import Path

from termdeck.platform_paths import PlatformPaths
from termdeck.service_installer import ServiceInstaller


class UpdateInstallService:
    REPOSITORY_URL = "https://github.com/danialfarid/termdeck.git"
    BREW_FORMULA = "danialfarid/tap/termdeck"

    def __init__(self) -> None:
        self.task: asyncio.Task[None] | None = None
        self.output = ""
        self.state = "idle"
        self.exit_code: int | None = None
        self.instance_id = uuid.uuid4().hex

    def status(self) -> dict[str, str | int | None]:
        return {"state": self.state, "output": self.output, "exit_code": self.exit_code, "instance_id": self.instance_id}

    def start(self) -> dict[str, str | int | None]:
        if self.task is not None and not self.task.done():
            return self.status()
        plan = self.installation_plan()
        if not plan["command"]:
            raise ValueError(plan["reason"])
        self.output = "$ " + plan["command"] + "\n"
        self.state = "running"
        self.exit_code = None
        self.task = asyncio.create_task(self.run(plan["command"]))
        return self.status()

    async def run(self, command: str) -> None:
        environment = os.environ.copy()
        environment["PATH"] = os.pathsep.join((str(Path.home() / ".local" / "bin"), *PlatformPaths.FALLBACK_BIN_DIRS, environment.get("PATH", "")))
        environment["GIT_TERMINAL_PROMPT"] = "0"
        environment["UV_NO_PROGRESS"] = "1"
        try:
            process = await asyncio.create_subprocess_exec("/bin/sh", "-c", command, cwd=Path.home(), env=environment,
                stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        except OSError as error:
            self.output += str(error)
            self.state = "failed"
            return
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        while chunk := await process.stdout.read(8192):
            self.output = (self.output + decoder.decode(chunk))[-200_000:]
        self.output += decoder.decode(b"", final=True)
        self.exit_code = await process.wait()
        self.state = "succeeded" if self.exit_code == 0 else "failed"
        if self.exit_code != 0:
            self.output += f"\nUpdate failed (exit {self.exit_code}).\n"
            return
        if not ServiceInstaller.unit_file().is_file():
            self.output += "\nUpdate installed. No TermDeck service is installed; restart your manually started server to use it.\n"
            return
        self.state = "restarting"
        self.output += "\nUpdate installed. Restarting the TermDeck service…\n"
        await asyncio.sleep(3)
        await self.restart_installed_service()

    async def restart_installed_service(self) -> None:
        command = (["/bin/launchctl", "kickstart", "-k", f"gui/{os.getuid()}/{ServiceInstaller.LABEL}"]
                   if PlatformPaths.IS_MACOS else ["systemctl", "--user", "--no-block", "restart", ServiceInstaller.SYSTEMD_UNIT_NAME])
        try:
            process = await asyncio.create_subprocess_exec(*command, stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, start_new_session=True)
            output, _ = await process.communicate()
        except OSError as error:
            self.state = "restart_failed"
            self.output += f"\nUpdate installed, but service restart failed: {error}\n"
            return
        if process.returncode:
            self.state = "restart_failed"
            self.output += f"\nUpdate installed, but service restart failed ({process.returncode}): {output.decode('utf-8', 'replace')}\n"

    @staticmethod
    def installer_executable(program: str) -> str | None:
        directories = (str(Path.home() / ".local" / "bin"), str(Path.home() / ".cargo" / "bin"), *PlatformPaths.FALLBACK_BIN_DIRS)
        return shutil.which(program) or shutil.which(program, path=os.pathsep.join(directories))

    @classmethod
    def installation_plan(cls) -> dict[str, str]:
        package_root = Path(__file__).resolve().parent.parent
        python_path = Path(sys.executable).resolve()
        if platform.system() not in {"Darwin", "Linux"}:
            return {"command": "", "method": "", "reason": "Automatic installation supports macOS and Linux."}
        if "Cellar/termdeck/" in str(package_root) or "Cellar/termdeck/" in str(python_path):
            brew = cls.installer_executable("brew")
            if not brew:
                return {"command": "", "method": "Homebrew", "reason": "Homebrew is not available in the server PATH."}
            executable = shlex.quote(brew)
            command = f"{executable} update && {executable} upgrade {cls.BREW_FORMULA}"
            method = "Homebrew"
        elif (package_root / ".git").exists() and (package_root / "pyproject.toml").is_file():
            git = cls.installer_executable("git")
            if not git:
                return {"command": "", "method": "Git checkout", "reason": "Git is not available in the server PATH."}
            prefix = f"{shlex.quote(git)} -C {shlex.quote(str(package_root))}"
            command = f"{prefix} diff --exit-code && {prefix} diff --cached --exit-code && {prefix} pull --ff-only"
            method = "Git checkout"
        elif "/uv/tools/" in str(python_path) or "/uv/tools/" in str(package_root):
            uv = cls.installer_executable("uv")
            if not uv:
                return {"command": "", "method": "uv", "reason": "uv is not available in the server PATH."}
            command = f"{shlex.quote(uv)} tool install --force {shlex.quote('git+' + cls.REPOSITORY_URL)}"
            method = "uv"
        elif "/pipx/venvs/" in str(python_path) or "/pipx/venvs/" in str(package_root):
            pipx = cls.installer_executable("pipx")
            if not pipx:
                return {"command": "", "method": "pipx", "reason": "pipx is not available in the server PATH."}
            command = f"{shlex.quote(pipx)} upgrade termdeck"
            method = "pipx"
        else:
            try:
                installer = importlib.metadata.distribution("termdeck").read_text("INSTALLER")
            except importlib.metadata.PackageNotFoundError:
                installer = None
            if (installer or "").strip() != "pip":
                return {"command": "", "method": "", "reason": "Installation method was not recognized; see the release installation instructions."}
            command = f"{shlex.quote(sys.executable)} -m pip install --upgrade {shlex.quote('git+' + cls.REPOSITORY_URL)}"
            method = "pip"
        return {"command": command, "method": method, "reason": ""}
