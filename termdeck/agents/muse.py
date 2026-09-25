import asyncio
import json
import os
import re
import shlex
import subprocess
import time
from datetime import timedelta
from pathlib import Path
from typing import Iterable

from termdeck.agents.base import AgentCli, OutputActivityState
from termdeck.config import TermdeckConfig
from termdeck.platform_paths import PlatformPaths
from termdeck.transcript_turns import TurnBuilder
from termdeck.util import TimeUtil


class MuseSessionState(OutputActivityState):
    def __init__(self) -> None:
        super().__init__()
        # An approval the log is still waiting on owns the badge until its terminal record
        # lands; the trust question stops matching once the first run settles it.
        self.approval_attention = False
        self.trust_settled = False
        # Run ids with a `started` record and no `terminal`/`run_retracted` yet: the
        # log-derived processing signal. run_scan_offset bounds each rescan to new bytes;
        # until the first scan lands, output flow stays the signal (see is_processing).
        # The log is NOT append-only -- compaction rewrites it, which a shrink-only check
        # misses whenever the rewritten file stays longer than the old offset -- so the
        # offset commits with the inode and the bytes just before it, and any mismatch
        # (or a write racing the scan itself) falls back to a full rescan, never a skip.
        self.open_runs: set[str] = set()
        self.run_scan_offset = 0
        self.run_scan_inode: int | None = None
        self.run_scan_sig_start = 0
        self.run_scan_sig = b""
        self.run_state_known = False


class MuseCli(AgentCli):
    """muse — Meta's interactive terminal coding agent.

    Sessions are directories rather than files: the store is
    `<XDG_DATA_HOME | ~/.local/share>/muse/sessions/<yyyy>/<mm>/<dd>/<session>/session.jsonl`,
    so a session id is the name of the directory holding the log, and `muse resume <session-ref>`
    takes that id (or a session name).

    Each log line is an event envelope (`payload_type` plus `payload`); the conversation reads
    off the run events inside it — `started` prompts, `assistant_message_committed` answers,
    committed tool calls and their result batches. Reasoning lines carry only encrypted content
    and are skipped, as are the diagnostics and the user-intent record, which repeats the prompt
    the run's own `started` event already carries. `muse schema` documents the MSP wire surface
    rather than this log, so anything not yet seen on a real log stays unparsed rather than
    guessed at.
    """

    kind = "muse"
    executable = "muse"
    label = "Muse"

    # A Path the transcript watcher reads directly, like every other agent's.
    _DATA_HOME = Path(os.environ["XDG_DATA_HOME"]) if os.environ.get("XDG_DATA_HOME") else Path.home() / ".local" / "share"
    sessions_root = _DATA_HOME / "muse" / "sessions"

    supports_resume = True
    canonical_resume_command = True
    accepts_session_ref = True
    records_raw_replay = True
    # The session log brackets every run with started/terminal records, so processing reads
    # off the log once bound; terminal output stays the fallback until the first scan lands.
    processing_from_output = True
    activity_source = "session-log+terminal-output"
    DAY_DIR_LOOKAROUND_DAYS = (-1, 0, 1)
    SESSION_LOG_NAME = "session.jsonl"

    install_hint = "Install Muse from Meta, then sign in with `muse login`."
    model_placeholder = "model id, optionally with a reasoning effort (for example high)"
    model_help = ("A trailing effort word becomes --reasoning-effort: "
                  "none, minimal, low, medium, high, xhigh, max or ultra.")
    transcript_commands = (("/model", "Change the active model"),
                           ("/help", "Show Muse commands"),)
    # The prompt muse opens an untrusted workspace with. Matched against lowercased output,
    # and only until the session's first run settles that question (see update_attention_from_
    # output): past badges latched on conversation merely discussing the workspace trust, the
    # tool-approval footer, or the picker's own instruction line, re-raising the badge while the
    # agent was just thinking. Tool approvals instead report structurally off the log, where
    # every wait is bracketed by started and terminal records for the same pending action.
    attention_output_markers = ("do you trust this workspace?",)

    # Its own approval modes, plus the one switch that turns approval and the sandbox off together.
    permission_flags = {
        "default": (),
        "untrusted": ("--approval-mode", "untrusted"),
        "on-request": ("--approval-mode", "on-request"),
        "never": ("--approval-mode", "never"),
        "full-access": ("--yolo",),
    }
    ui_permission_options = (("default", "Default (approve on request)"), ("untrusted", "Untrusted"),
                             ("never", "Never ask"), ("full-access", "Full access (--yolo)"))
    permission_value_flags = ("--approval-mode", "--permission-profile")
    permission_switch_flags = ("--yolo", "--disable-approval", "--disable-sandbox", "--trust-workspace")

    REASONING_EFFORTS = frozenset({"none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"})

    # Meta's own AI mark, the infinity loop, flattened to one ink: the fifteen gradient
    # segments off Meta's developer page, drawn in currentColor like every sibling icon.
    icon_svg = ('<svg viewBox="0 0 32 32" aria-hidden="true">'
                '<path fill="currentColor" d="M10.5119 6.03125C10.5023 6.03125 10.4927 6.03128 10.4831 6.03133L10.4436 9.28995C10.4526 9.28986 10.4616 9.28978 10.4707 9.28978H10.4707C12.6156 9.28978 14.2792 10.9809 17.8952 17.0717L18.1157 17.4425L18.1301 17.4668L20.1543 14.4297L20.1403 14.4062C19.6639 13.6315 19.2062 12.9186 18.7673 12.2677C18.2583 11.5135 17.7715 10.8397 17.2991 10.2382C14.907 7.19246 12.906 6.03125 10.5119 6.03125Z"/>'
                '<path fill="currentColor" d="M10.4832 6.03133C8.07758 6.04371 5.95081 7.5993 4.4151 9.97968C4.4106 9.98665 4.40611 9.99363 4.40161 10.0006L7.22059 11.5349C7.22516 11.528 7.22976 11.5211 7.23436 11.5142C8.13112 10.164 9.24711 9.30277 10.4438 9.28995C10.4528 9.28986 10.4618 9.28978 10.4709 9.28978L10.5121 6.03125C10.5025 6.03125 10.4929 6.03128 10.4832 6.03133Z"/>'
                '<path fill="currentColor" d="M4.41535 9.98047C4.41086 9.98744 4.40636 9.99442 4.40187 10.0014C3.39273 11.5723 2.64046 13.5 2.2339 15.5796C2.23214 15.5886 2.23039 15.5976 2.22864 15.6066L5.39564 16.3538C5.3973 16.3448 5.39896 16.3358 5.40063 16.3267C5.73914 14.4991 6.38363 12.8041 7.22083 11.5357C7.2254 11.5288 7.23 11.5219 7.2346 11.515L4.41535 9.98047Z"/>'
                '<path fill="currentColor" d="M5.40046 16.3253L2.23373 15.5781C2.23197 15.5871 2.23021 15.5961 2.22846 15.6052C2.00677 16.7488 1.89399 17.911 1.89162 19.0759C1.89161 19.0853 1.8916 19.0948 1.8916 19.1042L5.13949 19.3947C5.13923 19.3853 5.13896 19.376 5.13874 19.3665C5.13715 19.2989 5.13634 19.2304 5.13631 19.161C5.13793 18.2189 5.22467 17.2789 5.39547 16.3524C5.39712 16.3434 5.39879 16.3343 5.40046 16.3253Z"/>'
                '<path fill="currentColor" d="M5.23828 20.4083C5.18002 20.0735 5.147 19.7348 5.13949 19.395C5.13923 19.3855 5.13896 19.3762 5.13874 19.3667L1.89162 19.0762C1.89161 19.0856 1.8916 19.095 1.8916 19.1044V19.1063C1.8916 19.8313 1.95207 20.5101 2.06958 21.1373C2.07127 21.1463 2.07294 21.1552 2.07467 21.1643L5.24319 20.4354C5.24152 20.4264 5.2399 20.4174 5.23828 20.4083Z"/>'
                '<path fill="currentColor" d="M5.97788 22.0873C5.62446 21.7015 5.37433 21.145 5.24283 20.4334C5.24117 20.4244 5.23955 20.4153 5.23793 20.4062L2.06921 21.1352C2.07091 21.1443 2.07258 21.1532 2.07431 21.1622C2.31381 22.4197 2.78352 23.4677 3.45618 24.2605C3.46216 24.2676 3.46816 24.2746 3.47418 24.2816L5.99676 22.1076C5.99045 22.1009 5.98413 22.0941 5.97788 22.0873Z"/>'
                '<path fill="currentColor" d="M15.3659 13.0742C13.4565 16.003 12.2997 17.84 12.2997 17.84C9.75613 21.8273 8.87619 22.7209 7.46004 22.7209C6.86912 22.7209 6.37545 22.5105 5.99724 22.1083C5.99094 22.1016 5.98462 22.0948 5.97837 22.088L3.45667 24.2613C3.46265 24.2683 3.46865 24.2754 3.47467 24.2824C4.40346 25.365 5.71446 25.9657 7.3363 25.9657C9.79005 25.9657 11.5548 24.8089 14.6921 19.3249C14.6921 19.3249 15.9999 17.0155 16.8995 15.4246C16.3422 14.5248 15.8351 13.7459 15.3659 13.0742Z"/>'
                '<path fill="currentColor" d="M18.7696 8.45312C18.7631 8.45996 18.7566 8.46694 18.7501 8.47379C18.2487 9.00804 17.7675 9.60466 17.2993 10.2377C17.7717 10.8392 18.2594 11.5143 18.7685 12.2684C19.3684 11.3425 19.9284 10.5925 20.4773 10.0177C20.4838 10.0109 20.4902 10.0043 20.4967 9.99749L18.7696 8.45312Z"/>'
                '<path fill="currentColor" d="M28.0392 8.16596C26.7076 6.82063 25.1197 6.03125 23.4223 6.03125C21.6324 6.03125 20.1269 7.01209 18.7689 8.45306C18.7625 8.45989 18.7559 8.46688 18.7495 8.47373L20.4767 10.0176C20.4832 10.0108 20.4896 10.0042 20.4961 9.99742C21.3906 9.06692 22.2564 8.60233 23.2161 8.60233H23.2161C24.249 8.60233 25.2161 9.08859 26.0536 9.94106C26.0601 9.94774 26.0666 9.95436 26.0732 9.96109L28.059 8.18599C28.0524 8.17928 28.0458 8.17264 28.0392 8.16596Z"/>'
                '<path fill="currentColor" d="M31.8895 18.6478C31.8149 14.3282 30.3034 10.4665 28.0597 8.18604C28.053 8.17933 28.0464 8.1727 28.0398 8.16602L26.0542 9.94111C26.0608 9.94779 26.0673 9.95441 26.0738 9.96114C27.7617 11.695 28.9195 14.9199 29.0248 18.6468C29.025 18.6562 29.0253 18.6656 29.0256 18.675L31.89 18.6759C31.8898 18.6665 31.8897 18.6572 31.8895 18.6478Z"/>'
                '<path fill="currentColor" d="M31.8892 18.6756C31.8891 18.6662 31.8889 18.6568 31.8888 18.6474L29.024 18.6465C29.0243 18.6559 29.0246 18.6652 29.0248 18.6746C29.0295 18.8496 29.0318 19.0255 29.0318 19.2026C29.0318 20.2187 28.8801 21.0401 28.5714 21.6331C28.5668 21.6419 28.5621 21.6508 28.5575 21.6595L30.6934 23.8808C30.6987 23.8728 30.7039 23.8647 30.7091 23.8566C31.4845 22.6602 31.8916 20.9981 31.8916 18.9826C31.8916 18.88 31.8908 18.7776 31.8892 18.6756Z"/>'
                '<path fill="currentColor" d="M28.5715 21.6328C28.5669 21.6416 28.5622 21.6504 28.5576 21.6591C28.2904 22.159 27.9092 22.4924 27.4108 22.6382L28.3845 25.7068C28.5134 25.663 28.6389 25.6139 28.7611 25.5593C28.7975 25.5431 28.8337 25.5264 28.8696 25.5092C28.8903 25.4993 28.9109 25.4892 28.9314 25.479C29.5752 25.1581 30.1193 24.6849 30.5593 24.0751C30.5862 24.0378 30.6128 24.0003 30.6389 23.9621C30.6573 23.9351 30.6755 23.9079 30.6934 23.8805C30.6987 23.8725 30.7039 23.8644 30.7092 23.8563L28.5715 21.6328Z"/>'
                '<path fill="currentColor" d="M26.7913 22.7234C26.4648 22.7234 26.1767 22.6748 25.8948 22.5488L24.8978 25.6905C25.4582 25.8819 26.0559 25.9682 26.7225 25.9682C27.3367 25.9682 27.9005 25.8762 28.4116 25.6991L27.4381 22.6315C27.2283 22.6944 27.0103 22.7254 26.7913 22.7234V22.7234Z"/>'
                '<path fill="currentColor" d="M24.7959 21.6464C24.7897 21.6393 24.7836 21.6322 24.7774 21.625L22.4834 24.0108C22.4898 24.0177 22.4962 24.0246 22.5026 24.0314C23.2998 24.8808 24.0609 25.4078 24.9241 25.697L25.9203 22.5577C25.5565 22.4014 25.2047 22.1182 24.7959 21.6464Z"/>'
                '<path fill="currentColor" d="M24.7774 21.6268C24.0893 20.8266 23.2381 19.4942 21.8991 17.3398L20.1542 14.4297L20.1402 14.4062L18.1156 17.4426L18.13 17.4668L19.3664 19.5467C20.5648 21.5522 21.5412 23.003 22.4834 24.0126C22.4898 24.0195 22.4962 24.0263 22.5026 24.0331L24.7958 21.6482C24.7897 21.6411 24.7836 21.634 24.7774 21.6268Z"/>'
                '</svg>')

    def __init__(self) -> None:
        self._session_logs: dict[str, Path] = {}

    def new_session_state(self) -> MuseSessionState:
        return MuseSessionState()

    async def list_models(self) -> list[dict[str, object]]:
        """What the /model picker offers: muse's own cached catalog first, then fallbacks.

        The picker reads the authenticated provider catalog the TUI keeps on disk (sibling
        of the sessions tree), so that file is the first source; a throwaway `muse serve`
        host's `model/list` and ids recent sessions resolved cover a missing or stale cache.
        Each row carries its own reasoning tiers when its source names them, else the
        `--help` order; the default stays `high` wherever the row offers it.
        """
        cached = getattr(self, "_models_cache", None)
        if cached and time.monotonic() - cached[0] < TermdeckConfig.AGENT_MODEL_CATALOG_CACHE_SECONDS:
            return [dict(model) for model in cached[1]]
        stored, live, logged = await asyncio.gather(asyncio.to_thread(self._stored_catalog),
                                                    asyncio.to_thread(self._live_catalog),
                                                    asyncio.to_thread(self._models_from_recent_logs))
        rows: dict[str, dict[str, object]] = {}
        for row in stored + live:
            rows.setdefault(str(row["id"]), row)
        for model in logged:
            rows.setdefault(model, {"id": model, "label": model, "description": "", "tiers": []})
        models = []
        for row in rows.values():
            tiers = [tier for tier in row.get("tiers", []) if isinstance(tier, str) and tier.strip()] \
                or list(self.REASONING_EFFORT_ORDER)
            levels = [{"value": tier, "description": ""} for tier in tiers]
            models.append({"id": row["id"], "label": row["label"], "description": row["description"],
                           "reasoning_efforts": levels,
                           "default_reasoning_effort": "high" if "high" in tiers else tiers[0]})
        self._models_cache = (time.monotonic(), models)
        return [dict(model) for model in models]

    def _stored_catalog(self) -> list[dict[str, object]]:
        """Visible rows from muse's own on-disk provider-catalog cache; [] when absent.

        The TUI refreshes `<data>/muse/model-catalog/*.json` itself (one file per
        provider/profile, rows newest first), so reading it shows exactly what /models
        offers — including rows the serve host's bundled catalog never names.
        """
        rows: list[dict[str, object]] = []
        try:
            files = sorted((self.sessions_root.parent / "model-catalog").glob("*.json"))
        except OSError:
            return []
        for file in files:
            try:
                catalog = json.loads(file.read_bytes())
            except (OSError, ValueError):
                continue
            entries = catalog.get("rows") if isinstance(catalog, dict) else None
            for entry in entries if isinstance(entries, list) else []:
                if not isinstance(entry, dict):
                    continue
                model_id = entry.get("model_id")
                if not isinstance(model_id, str) or not model_id.strip():
                    continue
                visibility = entry.get("visibility")
                if isinstance(visibility, str) and visibility.strip().lower() != "visible":
                    continue
                variants = entry.get("reasoning_effort_variants")
                tiers = [variant.get("tier") for variant in variants
                         if isinstance(variant, dict)] if isinstance(variants, list) else []
                rows.append({"id": model_id.strip(),
                             "label": str(entry.get("display_label") or model_id).strip(),
                             "description": str(entry.get("description") or ""),
                             "tiers": [tier for tier in tiers if isinstance(tier, str) and tier.strip()]})
        return rows

    def _live_catalog(self) -> list[dict[str, object]]:
        """Catalog rows from a throwaway `muse serve` host; [] when it cannot answer.

        `model/list` is a query, and the host runs memory-only, so this changes nothing;
        anything going wrong (no binary, no login, a timeout) just leaves the other sources.
        """
        binary = PlatformPaths.resolve_binary(PlatformPaths.ENV_MUSE_BIN, self.executable)
        requests = [{"jsonrpc": "2.0", "id": 1, "method": "initialize",
                     "params": {"clientInfo": {"name": "termdeck_models", "version": "0"}}},
                    {"jsonrpc": "2.0", "method": "initialized", "params": {}},
                    {"jsonrpc": "2.0", "id": 2, "method": "model/list", "params": {}}]
        try:
            proc = subprocess.Popen([binary, "serve", "--no-session-log"], stdin=subprocess.PIPE,
                                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        except OSError:
            return []
        try:
            stdout, _ = proc.communicate("\n".join(json.dumps(request) for request in requests) + "\n",
                                          timeout=TermdeckConfig.AGENT_MODEL_CATALOG_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            proc.kill()
            return []
        except OSError:
            return []
        rows: list[dict[str, object]] = []
        for line in stdout.splitlines():
            try:
                response = json.loads(line)
            except ValueError:
                continue
            if not isinstance(response, dict) or response.get("id") != 2:
                continue
            result = response.get("result")
            models = result.get("models") if isinstance(result, dict) else None
            for entry in models if isinstance(models, list) else []:
                if not isinstance(entry, dict):
                    continue
                model_id = entry.get("modelId")
                if isinstance(model_id, str) and model_id.strip():
                    variants = entry.get("variants")
                    tiers = [variant for variant in variants
                             if isinstance(variant, str) and variant.strip()] \
                        if isinstance(variants, list) else []
                    rows.append({"id": model_id.strip(),
                                 "label": str(entry.get("displayLabel") or model_id).strip(),
                                 "description": str(entry.get("description") or ""),
                                 "tiers": tiers})
        return rows

    # The `--reasoning-effort` values `muse --help` names, in the order it names them; `high`
    # is its default.
    REASONING_EFFORT_ORDER = ("none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra")
    _MODEL_ID_RE = re.compile(r'"model_id"\s*:\s*"([^"]+)"')
    _COMPLETED_MODEL_RE = re.compile(r'"model"\s*:\s*"([^"]+)"')
    _MODEL_LOG_TAIL_BYTES = 64 * 1024
    _MODEL_LOG_FILES = 25

    def _models_from_recent_logs(self) -> list[str]:
        ids: list[str] = []
        try:
            candidates = self.candidate_session_files(Path.home())
        except OSError:
            return []
        for path, _ in candidates[:self._MODEL_LOG_FILES]:
            try:
                with path.open("rb") as handle:
                    handle.seek(0, 2)
                    handle.seek(max(0, handle.tell() - self._MODEL_LOG_TAIL_BYTES))
                    tail = handle.read().decode(errors="replace")
            except OSError:
                continue
            for match in self._MODEL_ID_RE.findall(tail):
                model = match.strip()
                if model and model not in ids:
                    ids.append(model)
            if '"model_completed"' in tail:
                for line in tail.splitlines():
                    if '"model_completed"' not in line:
                        continue
                    for match in self._COMPLETED_MODEL_RE.findall(line):
                        model = match.strip()
                        if model and model not in ids:
                            ids.append(model)
        return ids

    def model_arguments(self, model_name: str) -> tuple[str, ...]:
        # A trailing effort word ("some-model xhigh") is muse's --reasoning-effort, not part of the id.
        parts = model_name.split()
        arguments: list[str] = []
        if len(parts) > 1 and parts[-1].lower() in self.REASONING_EFFORTS:
            arguments.extend(("--reasoning-effort", parts[-1].lower()))
            model_name = " ".join(parts[:-1])
        arguments.extend(("--model", model_name))
        return tuple(arguments)

    def model_command(self) -> str:
        # Seen invoked in a real session log (`command.invoked` with command `/model`): the
        # transcript's model badge sends the picked model through it, like claude's.
        return "/model"

    def new_session_resume_arguments(self, session_ref: str, tracker) -> tuple[str, ...]:
        return ("resume", session_ref)

    def resume_command(self, original_command: str, agent_session_id: str) -> str:
        cleaned = self.strip_session_arguments(self.command_parts(original_command)) or [self.executable]
        cleaned.extend(("resume", agent_session_id))
        return shlex.join(cleaned)

    def fresh_session_command(self, original_command: str) -> str:
        cleaned = self.strip_session_arguments(self.command_parts(original_command)) or [self.executable]
        return shlex.join(cleaned)

    # Flags taking a value, so the first positional read below skips what belongs to them.
    # `--worktree` is left out on purpose: bare it takes no value, and guessing wrong would eat
    # the subcommand the check below exists to see.
    _VALUE_FLAGS = frozenset({"--model", "--reasoning-effort", "--approval-mode", "--permission-profile",
                              "--provider", "--preset", "--base-url", "--image", "--workspace",
                              "--worktree-base", "--worktree-existing", "--echo-delay-ms",
                              "--sandbox-network", "--approval-judge"})

    def strip_session_arguments(self, parts: list[str]) -> list[str]:
        # Only the resume subcommand carries a session ref; after any other subcommand `resume`
        # is that command's own word (`muse exec resume` is a headless prompt, not a resume).
        # Root options may sit on either side of the subcommand, so the check skips flags and
        # what belongs to them rather than demanding `resume` in first position.
        command_index = next((index for index, token in enumerate(parts)
                              if Path(token).name == self.executable), None)
        if command_index is None or \
                self._first_positional(parts[command_index + 1:]) != "resume":
            return list(parts)
        cleaned: list[str] = []
        command_seen = False
        skip_session_ref = False
        for token in parts:
            if skip_session_ref:
                skip_session_ref = False
                continue
            if not command_seen:
                cleaned.append(token)
                command_seen = Path(token).name == self.executable
                continue
            if token == "resume":
                # `resume` is followed by a session ref, or by --last, which is one too.
                skip_session_ref = True
                continue
            cleaned.append(token)
        return cleaned

    @classmethod
    def _first_positional(cls, tokens: list[str]) -> str | None:
        skip_value = False
        for token in tokens:
            if skip_value:
                skip_value = False
                continue
            if token == "--":
                continue
            if token.startswith("-") and "=" not in token:
                skip_value = token in cls._VALUE_FLAGS
                continue
            return token
        return None

    # -- sessions on disk --------------------------------------------------

    def transcript_path(self, cwd: Path | None, agent_session_id: str) -> Path | None:
        # A session's directory never moves once it exists, so the search is done once per session.
        cached = self._session_logs.get(agent_session_id)
        if cached is not None and cached.exists():
            return cached
        try:
            for path in self.sessions_root.rglob(f"{agent_session_id}/{self.SESSION_LOG_NAME}"):
                self._session_logs[agent_session_id] = path
                return path
        except OSError:
            return None
        return None

    def candidate_session_files(self, cwd: Path) -> list[tuple[Path, str]]:
        pairs: list[tuple[Path, str]] = []
        for day_dir in self._recent_day_dirs():
            try:
                entries = list(day_dir.iterdir())
            except OSError:
                continue
            for session_dir in entries:
                log = session_dir / self.SESSION_LOG_NAME
                if log.exists():
                    pairs.append((log, session_dir.name))
        return pairs

    def owns_transcript_path(self, path: Path) -> bool:
        root = self.sessions_root
        try:
            return path.is_relative_to(root) or path.is_relative_to(root.resolve())
        except OSError:
            return False

    def session_id_from_path(self, path: Path) -> str | None:
        if path.name != self.SESSION_LOG_NAME or not self.owns_transcript_path(path):
            return None
        for root in (self.sessions_root, self.sessions_root.resolve()):
            try:
                relative = path.relative_to(root)
            except ValueError:
                continue
            # Only <yyyy>/<mm>/<dd>/<session>/session.jsonl names a session: a stray log filed
            # beside the day directories, or a subagent log nested under its parent session,
            # must not bind as a session of its own.
            if len(relative.parts) != 5:
                return None
            return relative.parts[3] or None
        return None

    @classmethod
    def _recent_day_dirs(cls) -> list[Path]:
        today = TimeUtil.today_est()
        root = cls.sessions_root
        return [root / f"{day.year:04d}" / f"{day.month:02d}" / f"{day.day:02d}"
                for day in (today + timedelta(days=offset) for offset in cls.DAY_DIR_LOOKAROUND_DAYS)]

    # -- transcript parsing --------------------------------------------------

    @staticmethod
    def _records_from_envelope(envelope: dict) -> list[tuple[str | None, dict, int | float | None]]:
        """(payload_type, payload, recorded_at) triples carried by one envelope.

        Most log lines are one event envelope; a retained frame instead wraps its records as
        embedded JSON strings in `children`.
        """
        records: list[tuple[str | None, dict, int | float | None]] = []
        payload = envelope.get("payload")
        if isinstance(payload, dict):
            records.append((envelope.get("payload_type"), payload, envelope.get("recorded_at")))
        if isinstance(envelope.get("retained_frame"), str):
            children = envelope.get("children")
            for child in children if isinstance(children, list) else []:
                record_json = child.get("record_json") if isinstance(child, dict) else None
                record = TurnBuilder.loads(record_json) if isinstance(record_json, str) else None
                if isinstance(record, dict) and isinstance(record.get("payload"), dict):
                    records.append((record.get("payload_type"), record["payload"],
                                    record.get("recorded_at")))
        return records

    @classmethod
    def _records_from_line(cls, line: str) -> list[tuple[str | None, dict, int | float | None]]:
        envelope = TurnBuilder.loads(line)
        return cls._records_from_envelope(envelope) if isinstance(envelope, dict) else []

    @staticmethod
    def _record_timestamp(recorded_at: object) -> float | None:
        # The log stamps microseconds; turns carry epoch seconds.
        return float(recorded_at) / 1_000_000 if isinstance(recorded_at, (int, float)) else None

    @classmethod
    def _record_model(cls, payload_type: str | None, payload: dict) -> str:
        if payload_type == "run.model.configured":
            record = payload.get("record")
            if isinstance(record, dict):
                return str(record.get("model_id") or record.get("display_label") or "")
        if payload_type == "runtime.model_reconfigure.completed":
            record = payload.get("record")
            effective = record.get("effective") if isinstance(record, dict) else None
            if isinstance(effective, dict):
                return str(effective.get("model_id") or effective.get("display_label") or "")
        if payload.get("kind") == "run":
            event = payload.get("event")
            if isinstance(event, dict) and event.get("kind") == "model_completed":
                return str(event.get("model") or "")
        return ""

    def parse_transcript_lines(self, lines: Iterable[str]) -> list[dict[str, object]]:
        turns: list[dict[str, object]] = []
        current_model = ""
        for line in lines:
            for payload_type, payload, recorded_at in self._records_from_line(line):
                model = self._record_model(payload_type, payload)
                if model:
                    current_model = model
                    continue
                if payload.get("kind") != "run":
                    continue
                event = payload.get("event")
                if not isinstance(event, dict):
                    continue
                timestamp = self._record_timestamp(recorded_at)
                kind = event.get("kind")
                if kind == "started":
                    prompt = event.get("prompt")
                    if isinstance(prompt, str) and prompt.strip():
                        turns.append(TurnBuilder.turn(TurnBuilder.ROLE_USER, prompt, model=current_model,
                                                      timestamp=timestamp))
                elif kind == "assistant_message_committed":
                    text = event.get("text")
                    if isinstance(text, str) and text.strip():
                        turns.append(TurnBuilder.turn(TurnBuilder.ROLE_ASSISTANT, text, model=current_model,
                                                      timestamp=timestamp))
                elif kind == "assistant_tool_calls_committed":
                    calls = event.get("tool_calls")
                    for call in calls if isinstance(calls, list) else []:
                        if not isinstance(call, dict):
                            continue
                        arguments = call.get("args")
                        try:
                            arguments = json.loads(arguments) if isinstance(arguments, str) else arguments
                        except ValueError:
                            pass
                        turns.append(TurnBuilder.tool_event(str(call.get("name") or "tool"), arguments,
                                                            model=current_model, timestamp=timestamp))
                elif kind == "tool_result_batch_committed":
                    results = event.get("results")
                    for result in results if isinstance(results, list) else []:
                        text = result.get("text") if isinstance(result, dict) else None
                        turns.append(TurnBuilder.turn("event", TurnBuilder.format_result_value(text),
                                                      "result", "Result", model=current_model,
                                                      timestamp=timestamp))
        return turns

    def is_user_payload(self, payload: dict[str, object]) -> bool:
        return any(event.get("kind") == "started" for _, event, _ in self._run_events(payload))

    def user_payload_timestamp(self, payload: dict[str, object]) -> float | None:
        for _, event, recorded_at in self._run_events(payload):
            if event.get("kind") == "started":
                return self._record_timestamp(recorded_at)
        return None

    def payload_text(self, payload: dict[str, object]) -> str:
        parts: list[str] = []
        for _, event, _ in self._run_events(payload):
            kind = event.get("kind")
            if kind == "started" and isinstance(event.get("prompt"), str):
                parts.append(event["prompt"])
            elif kind == "assistant_message_committed" and isinstance(event.get("text"), str):
                parts.append(event["text"])
            elif kind == "assistant_tool_calls_committed" and isinstance(event.get("tool_calls"), list):
                parts.append("\n".join(str(call.get("name") or "tool")
                                       for call in event["tool_calls"] if isinstance(call, dict)))
            elif kind == "tool_result_batch_committed" and isinstance(event.get("results"), list):
                parts.append("\n".join(str(result.get("text") or "")
                                       for result in event["results"] if isinstance(result, dict)))
        return "\n".join(part for part in parts if part.strip())

    def conversation_payload_text(self, payload: dict[str, object]) -> str:
        parts: list[str] = []
        for _, event, _ in self._run_events(payload):
            if event.get("kind") == "started" and isinstance(event.get("prompt"), str):
                parts.append(event["prompt"])
            elif event.get("kind") == "assistant_message_committed" and isinstance(event.get("text"), str):
                parts.append(event["text"])
        return "\n".join(part for part in parts if part.strip())

    def is_conversation_payload(self, payload: dict[str, object]) -> bool:
        return any(event.get("kind") in ("started", "assistant_message_committed")
                   for _, event, _ in self._run_events(payload))

    def title_from_payload(self, payload: dict[str, object]) -> str:
        for payload_type, record, _ in self._records_from_envelope(payload):
            if payload_type == "session.name.changed" and isinstance(record.get("new_name"), str):
                return record["new_name"]
        return ""

    def cwd_from_payload(self, path: Path, payload: dict[str, object]) -> str:
        for _, record, _ in self._route_records(payload):
            inner = record.get("record")
            if isinstance(inner, dict) and isinstance(inner.get("cwd"), str) and inner["cwd"]:
                return inner["cwd"]
        for _, record, _ in self._metadata_records(payload):
            inner = record.get("record")
            if isinstance(inner, dict) and isinstance(inner.get("workspace_root"), str):
                return inner["workspace_root"]
        return super().cwd_from_payload(path, payload)

    def usage_from_payload(self, payload: dict[str, object]) -> dict[str, int | None] | None:
        for _, event, _ in self._run_events(payload):
            if event.get("kind") != "model_completed" or not isinstance(event.get("usage"), dict):
                continue
            usage = event["usage"]
            return {
                # The prompt side of the newest completion is the live context: fresh input
                # plus everything served from or written to the cache.
                "context_tokens": self._count(usage, "input_tokens") + self._count(usage, "cached_tokens") +
                                  self._count(usage, "cache_read_tokens") +
                                  self._count(usage, "cache_write_tokens"),
                "output_tokens": self._count(usage, "output_tokens"),
                "context_window": None,
                "total_tokens": None,
            }
        return None

    @staticmethod
    def _count(usage: dict, key: str) -> int:
        value = usage.get(key)
        return int(value) if isinstance(value, (int, float)) else 0

    def session_title(self, tracker, cwd: Path, agent_session_id: str | None) -> str | None:
        # The session is named once near the top of its log, so this streams the whole file
        # rather than the usage tail. It runs once per session bind, as a fallback for a tab
        # whose scrollback carries no title of its own.
        if not agent_session_id:
            return None
        path = self.transcript_path(cwd, agent_session_id)
        if path is None:
            return None
        title: str | None = None
        try:
            with path.open("rb") as handle:
                for raw in handle:
                    for payload_type, record, _ in self._records_from_line(
                            raw.decode(errors="replace")):
                        if payload_type == "session.name.changed" \
                                and isinstance(record.get("new_name"), str) \
                                and record["new_name"].strip():
                            title = record["new_name"].strip()
        except OSError:
            return None
        return title

    @classmethod
    def _run_events(cls, envelope: dict[str, object]) -> list[tuple[str | None, dict, object]]:
        """(payload_type, run event, recorded_at) triples on one envelope's records."""
        return [(payload_type, record["event"], recorded_at)
                for payload_type, record, recorded_at in cls._records_from_envelope(envelope)
                if isinstance(record, dict) and record.get("kind") == "run"
                and isinstance(record.get("event"), dict)]

    # -- activity / attention --------------------------------------------------

    def update_attention_from_output(self, manager, ms, data: bytes) -> bool:
        state = getattr(ms, "agent_state", None)
        if state is not None and getattr(state, "trust_settled", False):
            # The trust question is asked once, before the first run; after that the words are
            # just conversation again, and matching them re-raised the badge at every turn end.
            return False
        return super().update_attention_from_output(manager, ms, data)

    # Event kinds that close a run. Every started run on real logs eventually lands
    # `terminal` — even retracted and fatal ones — so started-minus-closed is exact, and a
    # retraction closes early rather than latching on a run that will produce nothing.
    _RUN_CLOSE_EVENT_KINDS = frozenset({"terminal", "run_retracted"})

    def is_processing(self, ms) -> bool:
        """A run is open in the session log, or output is flowing while unbound.

        Output flow used to be the whole signal, which read every TUI redraw as work
        (progress stuck on at idle) and went blind while the user typed (the input-suppress
        window drops output as echo). The log's started/terminal brackets answer directly,
        and typing never touches them; the output fallback only covers a session whose log
        has not been scanned yet.
        """
        state = getattr(ms, "agent_state", None)
        if state is not None and getattr(state, "run_state_known", False):
            return bool(ms.processing) or bool(state.open_runs)
        return super().is_processing(ms)

    def refresh_activity_for_status(self, manager, ms) -> None:
        record = getattr(ms, "record", None)
        session_id = getattr(record, "agent_session_id", None)
        state = getattr(ms, "agent_state", None)
        if not session_id or state is None:
            return
        cwd = getattr(record, "cwd", None)
        path = self.transcript_path(Path(cwd) if cwd else None, session_id)
        if path is None:
            return
        self._scan_run_state(path, state)

    def refresh_persisted_activity(self, manager, ms) -> None:
        self.refresh_activity_for_status(manager, ms)

    # Bytes before the scan offset re-read on every scan: a rewrite that keeps the file
    # longer than the old offset leaves the size check blind, but the bytes it parsed from
    # no longer sit where the offset says they do.
    _RUN_SCAN_SIG_BYTES = 4096

    def _scan_run_state(self, path: Path, state: MuseSessionState) -> bool:
        """Fold new log bytes into the open-run set; True when the set changed."""
        before = set(state.open_runs)
        offset = state.run_scan_offset
        try:
            with path.open("rb") as handle:
                pre = os.fstat(handle.fileno())
                if state.run_scan_inode is not None and state.run_scan_inode != pre.st_ino:
                    offset = 0
                if offset > pre.st_size:
                    offset = 0
                if offset:
                    handle.seek(state.run_scan_sig_start)
                    if handle.read(offset - state.run_scan_sig_start) != state.run_scan_sig:
                        offset = 0
                if not offset:
                    state.open_runs = set()
                handle.seek(offset)
                for raw in handle:
                    if not raw.endswith(b"\n"):
                        break  # a torn final line completes on the next scan
                    offset += len(raw)
                    for _, record, _ in self._records_from_line(raw.decode(errors="replace")):
                        if not isinstance(record, dict) or record.get("kind") != "run":
                            continue
                        event = record.get("event")
                        if not isinstance(event, dict):
                            continue
                        run_id = record.get("run_id") or event.get("run_id")
                        if not isinstance(run_id, str) or not run_id:
                            continue
                        if event.get("kind") == "started":
                            state.open_runs.add(run_id)
                        elif event.get("kind") in self._RUN_CLOSE_EVENT_KINDS:
                            state.open_runs.discard(run_id)
                post = os.fstat(handle.fileno())
                if (post.st_ino, post.st_size, post.st_mtime_ns) != \
                        (pre.st_ino, pre.st_size, pre.st_mtime_ns):
                    return False  # rewritten mid-scan; retry cleanly next time
                sig_start = max(0, offset - self._RUN_SCAN_SIG_BYTES)
                handle.seek(sig_start)
                sig = handle.read(offset - sig_start)
        except OSError:
            return False
        state.run_scan_offset = offset
        state.run_scan_inode = post.st_ino
        state.run_scan_sig_start = sig_start
        state.run_scan_sig = sig
        state.run_state_known = True
        return state.open_runs != before

    def transcript_requires_attention(self, manager, ms) -> bool:
        """Whether the session log is currently waiting on an approval, for startup reconcile."""
        record = getattr(ms, "record", None)
        session_id = getattr(record, "agent_session_id", None)
        if not session_id:
            return False
        cwd = getattr(record, "cwd", None)
        pending, saw_run = self._attention_signals(Path(cwd) if cwd else None, session_id)
        state = getattr(ms, "agent_state", None)
        if state is not None:
            if saw_run:
                state.trust_settled = True
            state.approval_attention = bool(pending)
        return bool(pending)

    def on_transcript_event(self, manager, ms, path: Path) -> None:
        """A watched transcript file changed; approvals own the badge until resolved."""
        record = getattr(ms, "record", None)
        session_id = getattr(record, "agent_session_id", None)
        state = getattr(ms, "agent_state", None)
        if not session_id or state is None or self.session_id_from_path(path) != session_id:
            return
        cwd = getattr(record, "cwd", None)
        pending, saw_run = self._attention_signals(Path(cwd) if cwd else None, session_id)
        if saw_run:
            state.trust_settled = True
        if pending:
            state.approval_attention = True
            if not ms.attention_required:
                ms.attention_required = True
                manager._broadcast_status(ms)
        elif state.approval_attention:
            # Only what approvals raised is cleared here: a trust wait and an approval wait
            # cannot overlap, since the trust gate holds the session before its first run.
            state.approval_attention = False
            ms.attention_required = False
            manager._broadcast_status(ms)
        if self._scan_run_state(path, state):
            # A run opened or closed with no output around it — the terminal's own ended
            # turn is the common case — so nothing else announces the flip.
            processing = manager._processing_state(ms)
            manager._broadcast_processing(ms, processing)
            manager._broadcast_status(ms)

    def _attention_signals(self, cwd: Path | None,
                           agent_session_id: str) -> tuple[set[str], bool]:
        """(waits still open, whether any run started) in the session log.

        Approvals bracket with started/terminal records per pending action; questions put to
        the user bracket the same way with `user_input_prompt_requested`/`settled` per prompt
        id. Either one open owns the badge.
        """
        path = self.transcript_path(cwd, agent_session_id)
        if path is None:
            return set(), False
        pending: set[str] = set()
        saw_run = False
        try:
            with path.open("rb") as handle:
                for raw in handle:
                    for payload_type, record, _ in self._records_from_line(
                            raw.decode(errors="replace")):
                        if payload_type == "approval_wait.effect.started":
                            inner = record.get("record")
                            action = inner.get("pending_action_id") if isinstance(inner, dict) else None
                            if isinstance(action, str) and action:
                                pending.add(action)
                        elif payload_type == "approval_wait.effect.terminal":
                            inner = record.get("record")
                            action = inner.get("pending_action_id") if isinstance(inner, dict) else None
                            pending.discard(action)
                        elif isinstance(record, dict) and record.get("kind") == "run" \
                                and isinstance(record.get("event"), dict):
                            event = record["event"]
                            if event.get("kind") == "started":
                                saw_run = True
                            elif event.get("kind") in ("user_input_prompt_requested",
                                                      "user_input_prompt_settled"):
                                prompt = event.get("prompt_id") or event.get("tool_call_id")
                                if not isinstance(prompt, str) or not prompt:
                                    continue
                                if event.get("kind") == "user_input_prompt_requested":
                                    pending.add(f"input:{prompt}")
                                else:
                                    pending.discard(f"input:{prompt}")
        except OSError:
            return set(), False
        return pending, saw_run

    @classmethod
    def _route_records(cls, envelope: dict[str, object]) -> list[tuple[str | None, dict, object]]:
        return [(payload_type, record, recorded_at)
                for payload_type, record, recorded_at in cls._records_from_envelope(envelope)
                if isinstance(record, dict) and record.get("kind") == "route_facts"]

    @classmethod
    def _metadata_records(cls, envelope: dict[str, object]) -> list[tuple[str | None, dict, object]]:
        return [(payload_type, record, recorded_at)
                for payload_type, record, recorded_at in cls._records_from_envelope(envelope)
                if isinstance(record, dict) and record.get("kind") == "metadata"]
