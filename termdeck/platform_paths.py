import os
import platform
import shutil
from pathlib import Path


class PlatformPaths:
    """Resolves every OS-dependent value termdeck needs so a single package runs on macOS and Linux.

    Lookup order for each value: the matching TERMDECK_* environment variable, then PATH, then a list of
    well-known bin directories. The fallback list matters because launchd and systemd start services with a
    minimal PATH that usually omits homebrew/linuxbrew, so PATH-only discovery finds nothing in production."""

    IS_MACOS: bool = platform.system() == "Darwin"

    FALLBACK_BIN_DIRS: tuple[str, ...] = ("/opt/homebrew/bin", "/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin",
                                          "/usr/bin", "/bin", "/usr/sbin", "/sbin", "/snap/bin")

    ENV_HOST = "TERMDECK_HOST"
    ENV_PORT = "TERMDECK_PORT"
    ENV_DATA_DIR = "TERMDECK_DATA_DIR"
    ENV_DEFAULT_CWD = "TERMDECK_DEFAULT_CWD"
    ENV_FILE_ROOT = "TERMDECK_FILE_ROOT"
    ENV_SHELL = "TERMDECK_SHELL"
    ENV_DTACH_BIN = "TERMDECK_DTACH_BIN"
    ENV_RG_BIN = "TERMDECK_RG_BIN"
    ENV_LSOF_BIN = "TERMDECK_LSOF_BIN"
    ENV_PS_BIN = "TERMDECK_PS_BIN"
    ENV_PGREP_BIN = "TERMDECK_PGREP_BIN"
    ENV_LOG_LEVEL = "TERMDECK_LOG_LEVEL"

    @staticmethod
    def env_text(name: str, default: str) -> str:
        return os.environ.get(name, "").strip() or default

    @staticmethod
    def env_int(name: str, default: int) -> int:
        raw = os.environ.get(name, "").strip()
        return int(raw) if raw else default

    @staticmethod
    def env_directory(name: str, default: Path) -> Path:
        raw = os.environ.get(name, "").strip()
        return Path(raw).expanduser() if raw else default

    @staticmethod
    def resolve_binary(env_name: str, program: str) -> str:
        override = os.environ.get(env_name, "").strip()
        if override:
            return override
        on_path = shutil.which(program)
        if on_path:
            return on_path
        for directory in PlatformPaths.FALLBACK_BIN_DIRS:
            candidate = Path(directory) / program
            if candidate.exists():
                return str(candidate)
        return program

    @staticmethod
    def user_trash_dir() -> Path:
        if PlatformPaths.IS_MACOS:
            return Path.home() / ".Trash"
        xdg_data_home = PlatformPaths.env_text("XDG_DATA_HOME", str(Path.home() / ".local" / "share"))
        return Path(xdg_data_home).expanduser() / "Trash" / "files"

    @staticmethod
    def login_shell() -> str:
        override = os.environ.get(PlatformPaths.ENV_SHELL, "").strip()
        if override:
            return override
        user_shell = os.environ.get("SHELL", "").strip()
        if user_shell and Path(user_shell).exists():
            return user_shell
        return "/bin/zsh" if PlatformPaths.IS_MACOS else "/bin/bash"

    @staticmethod
    def default_data_dir() -> Path:
        return Path.home() / ".termdeck"
