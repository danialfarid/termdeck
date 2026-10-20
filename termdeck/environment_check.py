import asyncio
import subprocess
import time
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
    AGY_INSTALL_HINT = "install the AGY/Antigravity CLI"
    AIDER_INSTALL_HINT = "uv tool install --force --python python3.12 --with pip aider-chat@latest"
    OPENCODE_INSTALL_HINT = "brew install anomalyco/tap/opencode"
    MODEL_ALIASES = {"agd": "agy", "agy-cli": "agy", "agycli": "agy", "gemini": "agy",
                     "antigravity": "agy", "antigravity-cli": "agy", "antigravitycli": "agy"}
    MODEL_INSTALL_COMMANDS = {"codex": "brew install --cask codex", "claude": "brew install --cask claude-code",
                              "agy": "brew install --cask antigravity", "aider": AIDER_INSTALL_HINT,
                              "opencode": OPENCODE_INSTALL_HINT}
    # Probing every `--version` costs ~0.5s of sequential subprocess spawns, and the probe runs on
    # the session-create request path. Blocking the event loop that long starves the pty pump: a
    # freshly spawned agent CLI asks the terminal for its colors in its first output burst and only
    # waits about a second for the answer before giving up and painting its composer without the
    # panel background -- permanently, for that session's whole life. Cache the reports briefly.
    REPORT_CACHE_TTL_SECONDS = 300.0
    _REPORTS_CACHE: list["DependencyReport"] | None = None
    _REPORTS_CACHE_MONOTONIC = 0.0
    _REPORT_REFRESH_IN_FLIGHT = False

    @staticmethod
    def package_install_hint(program: str) -> str:
        template = EnvironmentCheck.MACOS_INSTALL_HINT if PlatformPaths.IS_MACOS else EnvironmentCheck.LINUX_INSTALL_HINT
        return template.format(program=program)

    @staticmethod
    def normalize_model(model: str) -> str:
        raw_model = model.strip().strip("\"'").lower()
        normalized = EnvironmentCheck.MODEL_ALIASES.get(raw_model, raw_model)
        from termdeck import agents
        return agents.resolve_model_alias(normalized)

    @staticmethod
    def program_is_usable(program: str, resolved_path: str) -> bool:
        if not Path(resolved_path).is_absolute() or not Path(resolved_path).exists():
            return False
        if program not in EnvironmentCheck.MODEL_INSTALL_COMMANDS:
            return True
        try:
            result = subprocess.run([resolved_path, "--version"], capture_output=True, text=True, timeout=4, check=False)
        except (OSError, subprocess.SubprocessError):
            return False
        return result.returncode == 0

    @staticmethod
    def collect_reports(force_refresh: bool = False) -> list[DependencyReport]:
        """Dependency reports, cached briefly so the session-create path never blocks on probes.

        A stale cache is served while a refresh runs in a worker thread, so the event loop stays
        free for pty traffic. Pass force_refresh for diagnostics (doctor), which want live truth.
        """
        now = time.monotonic()
        if not force_refresh and EnvironmentCheck._REPORTS_CACHE is not None:
            if now - EnvironmentCheck._REPORTS_CACHE_MONOTONIC < EnvironmentCheck.REPORT_CACHE_TTL_SECONDS:
                return list(EnvironmentCheck._REPORTS_CACHE)
            if EnvironmentCheck._schedule_reports_refresh():
                return list(EnvironmentCheck._REPORTS_CACHE)
        reports = EnvironmentCheck._collect_reports_uncached()
        EnvironmentCheck._REPORTS_CACHE = reports
        EnvironmentCheck._REPORTS_CACHE_MONOTONIC = now
        return list(reports)

    @staticmethod
    def _schedule_reports_refresh() -> bool:
        """Refresh stale reports without blocking the caller; True when stale may be served."""
        if EnvironmentCheck._REPORT_REFRESH_IN_FLIGHT:
            return True
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return False
        EnvironmentCheck._REPORT_REFRESH_IN_FLIGHT = True

        async def _refresh() -> None:
            try:
                reports = await asyncio.to_thread(EnvironmentCheck._collect_reports_uncached)
            except Exception:
                EnvironmentCheck._REPORT_REFRESH_IN_FLIGHT = False
                return
            EnvironmentCheck._REPORTS_CACHE = reports
            EnvironmentCheck._REPORTS_CACHE_MONOTONIC = time.monotonic()
            EnvironmentCheck._REPORT_REFRESH_IN_FLIGHT = False

        loop.create_task(_refresh())
        return True

    @staticmethod
    def _collect_reports_uncached() -> list[DependencyReport]:
        from termdeck import agents
        from termdeck.config import TermdeckConfig

        specs: tuple[tuple[str, str, bool, str], ...] = (
            ("dtach", TermdeckConfig.DTACH_BIN, True, "keeps terminals alive across restarts"),
            (Path(TermdeckConfig.SHELL).name, TermdeckConfig.SHELL, True, "login shell for every terminal"),
            ("lsof", TermdeckConfig.LSOF_BIN, True, "tracks which agent session a terminal is on"),
            ("ps", TermdeckConfig.PS_BIN, True, "per-terminal cpu/memory stats"),
            ("rg", TermdeckConfig.RG_BIN, False, "project-wide search (ripgrep)"),
            ("claude", PlatformPaths.resolve_binary("", "claude"), False, "claude session resume"),
            ("codex", PlatformPaths.resolve_binary("", "codex"), False, "codex session resume"),
            ("agy", PlatformPaths.resolve_binary("", "agy"), False, "AGY terminal and transcript support"),
            ("aider", PlatformPaths.resolve_binary("", "aider"), False, "Aider terminal and activity status"),
            ("opencode", PlatformPaths.resolve_binary("", "opencode"), False, "OpenCode terminal and session status"),
        )
        hints = {"claude": EnvironmentCheck.CLAUDE_INSTALL_HINT, "codex": EnvironmentCheck.CODEX_INSTALL_HINT,
                 "agy": EnvironmentCheck.AGY_INSTALL_HINT, "aider": EnvironmentCheck.AIDER_INSTALL_HINT,
                 "opencode": EnvironmentCheck.OPENCODE_INSTALL_HINT,
                 "rg": EnvironmentCheck.package_install_hint("ripgrep")}
        if PlatformPaths.IS_MACOS:
            hints.update({program: EnvironmentCheck.MODEL_INSTALL_COMMANDS[program] for program in EnvironmentCheck.MODEL_INSTALL_COMMANDS})
        reports = [DependencyReport(program=program, resolved_path=resolved, is_present=EnvironmentCheck.program_is_usable(program, resolved), is_required=required, used_for=used_for,
                                    install_hint=hints.get(program, EnvironmentCheck.package_install_hint(program)))
                   for program, resolved, required, used_for in specs]
        known = {report.program for report in reports}
        for agent in agents.AGENT_CLIS.values():
            if not agent.is_agent or not agent.launchable or not agent.executable or agent.executable in known:
                continue
            resolved = PlatformPaths.resolve_binary("", agent.executable)
            reports.append(DependencyReport(
                program=agent.executable, resolved_path=resolved,
                is_present=EnvironmentCheck.program_is_usable(agent.executable, resolved), is_required=False,
                used_for=f"{agent.label} terminal integration",
                install_hint=getattr(agent, "install_hint", "") or EnvironmentCheck.package_install_hint(agent.executable)))
        return reports

    @staticmethod
    def missing_model_dependency(model: str) -> DependencyReport | None:
        normalized_model = EnvironmentCheck.normalize_model(model)
        for report in EnvironmentCheck.collect_reports():
            if report.program == normalized_model and not report.is_present:
                # A missing verdict from a stale cache would wrongly refuse a just-installed CLI,
                # so re-probe once on the slow path before reporting it missing. This runs before
                # the child starts, so the wait cannot starve its terminal answers.
                for fresh in EnvironmentCheck.collect_reports(force_refresh=True):
                    if fresh.program == normalized_model and not fresh.is_present:
                        return fresh
                return None
        return None

    @staticmethod
    def model_install_command(model: str) -> str:
        normalized = EnvironmentCheck.normalize_model(model)
        built_in = EnvironmentCheck.MODEL_INSTALL_COMMANDS.get(normalized)
        if built_in is not None:
            return built_in
        from termdeck import agents
        try:
            return str(getattr(agents.agent_cli(normalized), "install_hint", ""))
        except ValueError:
            return ""

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
