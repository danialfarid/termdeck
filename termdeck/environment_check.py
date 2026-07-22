import shutil
from dataclasses import dataclass
from pathlib import Path

from termdeck.platform_paths import PlatformPaths


@dataclass(frozen=True)
class DependencyReport:
    """One resolved external dependency: what termdeck looked for, where it landed, and how to get it."""

    program: str
    resolved_path: str
    is_present: bool
    is_required: bool
    used_for: str
    install_hint: str


class EnvironmentCheck:
    """Verifies the external programs termdeck shells out to. `dtach` is the only hard requirement — it is what
    keeps a terminal's process alive across server restarts, so without it nothing can be reattached. ripgrep
    powers project search, and the agent CLIs are only needed if you want claude/codex session resume."""

    MACOS_INSTALL_HINT = "brew install {program}"
    LINUX_INSTALL_HINT = "apt install {program}   # or: dnf/pacman/brew install {program}"
    CLAUDE_INSTALL_HINT = "npm install -g @anthropic-ai/claude-code"
    CODEX_INSTALL_HINT = "npm install -g @openai/codex"

    @staticmethod
    def package_install_hint(program: str) -> str:
        template = EnvironmentCheck.MACOS_INSTALL_HINT if PlatformPaths.IS_MACOS else EnvironmentCheck.LINUX_INSTALL_HINT
        return template.format(program=program)

    @staticmethod
    def collect_reports() -> list[DependencyReport]:
        from termdeck.config import TermdeckConfig

        specs: tuple[tuple[str, str, bool, str], ...] = (
            ("dtach", TermdeckConfig.DTACH_BIN, True, "keeps terminals alive across restarts"),
            (Path(TermdeckConfig.SHELL).name, TermdeckConfig.SHELL, True, "login shell for every terminal"),
            ("lsof", TermdeckConfig.LSOF_BIN, True, "tracks which agent session a terminal is on"),
            ("ps", TermdeckConfig.PS_BIN, True, "per-terminal cpu/memory stats"),
            ("rg", TermdeckConfig.RG_BIN, False, "project-wide search (ripgrep)"),
            ("claude", shutil.which("claude") or "claude", False, "claude session resume"),
            ("codex", shutil.which("codex") or "codex", False, "codex session resume"),
        )
        hints = {"claude": EnvironmentCheck.CLAUDE_INSTALL_HINT, "codex": EnvironmentCheck.CODEX_INSTALL_HINT,
                 "rg": EnvironmentCheck.package_install_hint("ripgrep")}
        return [DependencyReport(program=program, resolved_path=resolved, is_present=Path(resolved).is_absolute()
                                 and Path(resolved).exists(), is_required=required, used_for=used_for,
                                 install_hint=hints.get(program, EnvironmentCheck.package_install_hint(program)))
                for program, resolved, required, used_for in specs]

    @staticmethod
    def missing_required(reports: list[DependencyReport]) -> list[DependencyReport]:
        return [report for report in reports if report.is_required and not report.is_present]

    @staticmethod
    def raise_if_required_missing() -> None:
        missing = EnvironmentCheck.missing_required(EnvironmentCheck.collect_reports())
        if not missing:
            return
        lines = [f"  - {report.program} ({report.used_for})\n      install: {report.install_hint}" for report in missing]
        raise RuntimeError("termdeck cannot start, missing required programs:\n" + "\n".join(lines) +
                           "\n\nRun `termdeck doctor` for the full dependency report.")
