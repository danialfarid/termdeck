import json
import re
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class PermissionProfile:
    value: str
    label: str
    arguments: tuple[str, ...]


@dataclass(frozen=True)
class TranscriptProfile:
    root: Path
    path_template: str
    file_glob: str
    session_id_regex: re.Pattern[str]
    role_path: str
    content_path: str
    timestamp_path: str
    model_path: str
    cwd_path: str
    title_path: str
    user_roles: frozenset[str]
    assistant_roles: frozenset[str]
    thinking_roles: frozenset[str]
    event_roles: frozenset[str]


@dataclass(frozen=True)
class ActivityProfile:
    strategy: str
    event_path: str
    active_values: frozenset[str]
    idle_values: frozenset[str]
    keepalive_seconds: float


@dataclass(frozen=True)
class AgentProfile:
    kind: str
    label: str
    executable: str
    aliases: tuple[str, ...]
    base_arguments: tuple[str, ...]
    model_arguments: tuple[str, ...]
    permissions: tuple[PermissionProfile, ...]
    resume_arguments: tuple[str, ...]
    fork_arguments: tuple[str, ...]
    session_value_flags: tuple[str, ...]
    session_switch_flags: tuple[str, ...]
    rename_input: str
    transcript: TranscriptProfile | None
    activity: ActivityProfile
    attention_markers: tuple[str, ...]
    icon_svg: str
    install_hint: str
    prompt_marker: str
    model_placeholder: str
    model_help: str
    sessionless: bool
    records_raw_replay: bool
    fullscreen_tui: bool
    has_prompt_queue: bool
    canonical_resume_command: bool
    history_indexed: bool


class AgentProfileLoader:
    VERSION = 1
    KIND_RE = re.compile(r"^[a-z][a-z0-9-]{1,31}$")
    EXECUTABLE_RE = re.compile(r"^[A-Za-z0-9._+-]+$")
    PLACEHOLDER_RE = re.compile(r"{([^{}]+)}")
    ALLOWED_ARGUMENT_PLACEHOLDERS = frozenset({"model", "session_id", "title"})
    ALLOWED_ACTIVITY_STRATEGIES = frozenset({"terminal-title", "terminal-output", "jsonl-event"})
    UNSAFE_SVG_RE = re.compile(r"<(?:script|foreignObject)|\son[a-z]+\s*=|javascript:|(?:xlink:)?href\s*=", re.I)

    @classmethod
    def load(cls, path: Path) -> tuple[AgentProfile, ...]:
        if not path.is_file():
            return ()
        try:
            payload = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError) as error:
            raise ValueError(f"cannot read agent profiles from {path}: {error}") from error
        root = cls._mapping(payload, "agent profile document")
        if root.get("version") != cls.VERSION:
            raise ValueError(f"agent profile document version must be {cls.VERSION}")
        raw_agents = root.get("agents")
        if not isinstance(raw_agents, list):
            raise ValueError("agent profile document agents must be a list")
        profiles = tuple(cls._profile(cls._mapping(item, f"agents[{index}]"), index)
                         for index, item in enumerate(raw_agents))
        kinds = [profile.kind for profile in profiles]
        if len(kinds) != len(set(kinds)):
            raise ValueError("agent profile kinds must be unique")
        return profiles

    @classmethod
    def _profile(cls, raw: dict[str, object], index: int) -> AgentProfile:
        prefix = f"agents[{index}]"
        kind = cls._required_text(raw, "kind", prefix).lower()
        executable = cls._required_text(raw, "executable", prefix)
        if not cls.KIND_RE.fullmatch(kind):
            raise ValueError(f"{prefix}.kind must use lowercase letters, digits, and hyphens")
        if not cls.EXECUTABLE_RE.fullmatch(executable):
            raise ValueError(f"{prefix}.executable must be a binary name without a path")
        permissions = cls._permissions(raw.get("permissions"), prefix)
        transcript = cls._transcript(raw.get("transcript"), prefix)
        activity = cls._activity(raw.get("activity"), prefix, transcript)
        model_arguments = cls._tokens(raw.get("model_arguments", ["--model", "{model}"]),
                                      f"{prefix}.model_arguments")
        base_arguments = cls._tokens(raw.get("base_arguments", []), f"{prefix}.base_arguments")
        resume_arguments = cls._tokens(raw.get("resume_arguments", []), f"{prefix}.resume_arguments")
        fork_arguments = cls._tokens(raw.get("fork_arguments", []), f"{prefix}.fork_arguments")
        cls._validate_placeholders(base_arguments, set(), f"{prefix}.base_arguments")
        cls._validate_placeholders(model_arguments, {"model"}, f"{prefix}.model_arguments")
        cls._validate_placeholders(resume_arguments, {"session_id"}, f"{prefix}.resume_arguments")
        cls._validate_placeholders(fork_arguments, {"session_id", "title"}, f"{prefix}.fork_arguments")
        rename_input = cls._text(raw.get("rename_input", ""), f"{prefix}.rename_input")
        cls._validate_text_placeholders(rename_input, {"title"}, f"{prefix}.rename_input")
        icon_svg = cls._text(raw.get("icon_svg", ""), f"{prefix}.icon_svg")
        cls._validate_icon(icon_svg, prefix)
        sessionless = cls._boolean(raw.get("sessionless", False), f"{prefix}.sessionless")
        if sessionless and (resume_arguments or fork_arguments or transcript):
            raise ValueError(f"{prefix} sessionless profiles cannot define resume, fork, or transcript identity")
        return AgentProfile(
            kind=kind, label=cls._required_text(raw, "label", prefix), executable=executable,
            aliases=tuple(alias.lower() for alias in cls._texts(raw.get("aliases", []), f"{prefix}.aliases")),
            base_arguments=base_arguments,
            model_arguments=model_arguments, permissions=permissions, resume_arguments=resume_arguments,
            fork_arguments=fork_arguments,
            session_value_flags=cls._texts(raw.get("session_value_flags", []), f"{prefix}.session_value_flags"),
            session_switch_flags=cls._texts(raw.get("session_switch_flags", []), f"{prefix}.session_switch_flags"),
            rename_input=rename_input, transcript=transcript, activity=activity,
            attention_markers=cls._texts(raw.get("attention_markers", []), f"{prefix}.attention_markers"),
            icon_svg=icon_svg, install_hint=cls._text(raw.get("install_hint", ""), f"{prefix}.install_hint"),
            prompt_marker=cls._text(raw.get("prompt_marker", ""), f"{prefix}.prompt_marker"),
            model_placeholder=cls._text(raw.get("model_placeholder", "model ID"), f"{prefix}.model_placeholder"),
            model_help=cls._text(raw.get("model_help", ""), f"{prefix}.model_help"), sessionless=sessionless,
            records_raw_replay=cls._boolean(raw.get("records_raw_replay", False), f"{prefix}.records_raw_replay"),
            fullscreen_tui=cls._boolean(raw.get("fullscreen_tui", False), f"{prefix}.fullscreen_tui"),
            has_prompt_queue=cls._boolean(raw.get("has_prompt_queue", False), f"{prefix}.has_prompt_queue"),
            canonical_resume_command=cls._boolean(raw.get("canonical_resume_command", bool(resume_arguments)),
                                                  f"{prefix}.canonical_resume_command"),
            history_indexed=cls._boolean(raw.get("history_indexed", transcript is not None),
                                         f"{prefix}.history_indexed"))

    @classmethod
    def _permissions(cls, value: object, prefix: str) -> tuple[PermissionProfile, ...]:
        if value is None:
            return (PermissionProfile("default", "Default", ()),)
        if not isinstance(value, list) or not value:
            raise ValueError(f"{prefix}.permissions must be a non-empty list")
        profiles: list[PermissionProfile] = []
        for index, item in enumerate(value):
            raw = cls._mapping(item, f"{prefix}.permissions[{index}]")
            item_prefix = f"{prefix}.permissions[{index}]"
            arguments = cls._tokens(raw.get("arguments", []), f"{item_prefix}.arguments")
            cls._validate_placeholders(arguments, set(), f"{item_prefix}.arguments")
            profiles.append(PermissionProfile(
                cls._required_text(raw, "value", item_prefix).lower(),
                cls._required_text(raw, "label", item_prefix),
                arguments))
        if profiles[0].value != "default" or profiles[0].arguments:
            raise ValueError(f"{prefix}.permissions must begin with an argument-free default preset")
        values = [profile.value for profile in profiles]
        if len(values) != len(set(values)):
            raise ValueError(f"{prefix}.permissions values must be unique")
        return tuple(profiles)

    @classmethod
    def _transcript(cls, value: object, prefix: str) -> TranscriptProfile | None:
        if value is None:
            return None
        raw = cls._mapping(value, f"{prefix}.transcript")
        item_prefix = f"{prefix}.transcript"
        root = Path(cls._required_text(raw, "root", item_prefix)).expanduser()
        if not root.is_absolute():
            raise ValueError(f"{item_prefix}.root must be an absolute or home-relative path")
        path_template = cls._required_text(raw, "path", item_prefix)
        cls._validate_text_placeholders(path_template, {"session_id"}, f"{item_prefix}.path")
        file_glob = cls._text(raw.get("glob", "**/*.jsonl"), f"{item_prefix}.glob") or "**/*.jsonl"
        if Path(file_glob).is_absolute() or ".." in Path(file_glob).parts:
            raise ValueError(f"{item_prefix}.glob must stay inside the transcript root")
        regex_text = cls._required_text(raw, "session_id_regex", item_prefix)
        try:
            session_id_regex = re.compile(regex_text)
        except re.error as error:
            raise ValueError(f"{item_prefix}.session_id_regex is invalid: {error}") from error
        if "session_id" not in session_id_regex.groupindex:
            raise ValueError(f"{item_prefix}.session_id_regex needs a named session_id group")
        roles = cls._mapping(raw.get("roles", {}), f"{item_prefix}.roles")
        return TranscriptProfile(
            root=root, path_template=path_template,
            file_glob=file_glob,
            session_id_regex=session_id_regex,
            role_path=cls._text(raw.get("role_path", "role"), f"{item_prefix}.role_path"),
            content_path=cls._text(raw.get("content_path", "content"), f"{item_prefix}.content_path"),
            timestamp_path=cls._text(raw.get("timestamp_path", "timestamp"), f"{item_prefix}.timestamp_path"),
            model_path=cls._text(raw.get("model_path", "model"), f"{item_prefix}.model_path"),
            cwd_path=cls._text(raw.get("cwd_path", "cwd"), f"{item_prefix}.cwd_path"),
            title_path=cls._text(raw.get("title_path", "title"), f"{item_prefix}.title_path"),
            user_roles=frozenset(item.lower() for item in cls._texts(roles.get("user", ["user"]), f"{item_prefix}.roles.user")),
            assistant_roles=frozenset(item.lower() for item in cls._texts(roles.get("assistant", ["assistant"]), f"{item_prefix}.roles.assistant")),
            thinking_roles=frozenset(item.lower() for item in cls._texts(roles.get("thinking", ["thinking", "reasoning"]), f"{item_prefix}.roles.thinking")),
            event_roles=frozenset(item.lower() for item in cls._texts(roles.get("event", ["tool", "system"]), f"{item_prefix}.roles.event")))

    @classmethod
    def _activity(cls, value: object, prefix: str, transcript: TranscriptProfile | None) -> ActivityProfile:
        raw = cls._mapping(value or {}, f"{prefix}.activity")
        strategy = cls._text(raw.get("strategy", "terminal-title"), f"{prefix}.activity.strategy")
        if strategy not in cls.ALLOWED_ACTIVITY_STRATEGIES:
            raise ValueError(f"{prefix}.activity.strategy must be terminal-title, terminal-output, or jsonl-event")
        if strategy == "jsonl-event" and transcript is None:
            raise ValueError(f"{prefix}.activity jsonl-event requires a transcript")
        event_path = cls._text(raw.get("event_path", "type"), f"{prefix}.activity.event_path")
        active_values = frozenset(item.lower() for item in cls._texts(raw.get("active_values", []), f"{prefix}.activity.active_values"))
        idle_values = frozenset(item.lower() for item in cls._texts(raw.get("idle_values", []), f"{prefix}.activity.idle_values"))
        if strategy == "jsonl-event" and (not active_values or not idle_values):
            raise ValueError(f"{prefix}.activity jsonl-event needs active_values and idle_values")
        keepalive = raw.get("keepalive_seconds", 4.0)
        if not isinstance(keepalive, (int, float)) or not 0.5 <= float(keepalive) <= 60:
            raise ValueError(f"{prefix}.activity.keepalive_seconds must be between 0.5 and 60")
        return ActivityProfile(strategy, event_path, active_values, idle_values, float(keepalive))

    @classmethod
    def _validate_icon(cls, icon_svg: str, prefix: str) -> None:
        if not icon_svg:
            return
        if len(icon_svg) > 8192 or not icon_svg.lstrip().startswith("<svg") or not icon_svg.rstrip().endswith("</svg>"):
            raise ValueError(f"{prefix}.icon_svg must be one SVG no larger than 8 KB")
        if cls.UNSAFE_SVG_RE.search(icon_svg):
            raise ValueError(f"{prefix}.icon_svg contains unsafe markup")

    @classmethod
    def _validate_placeholders(cls, tokens: tuple[str, ...], allowed: set[str], name: str) -> None:
        for token in tokens:
            cls._validate_text_placeholders(token, allowed, name)

    @classmethod
    def _validate_text_placeholders(cls, value: str, allowed: set[str], name: str) -> None:
        matches = cls.PLACEHOLDER_RE.findall(value)
        placeholders = set(matches)
        if placeholders - allowed:
            raise ValueError(f"{name} has unsupported placeholders: {', '.join(sorted(placeholders - allowed))}")
        if value.count("{") != len(matches) or value.count("}") != len(matches):
            raise ValueError(f"{name} contains malformed placeholders")

    @staticmethod
    def _mapping(value: object, name: str) -> dict[str, object]:
        if not isinstance(value, dict):
            raise ValueError(f"{name} must be an object")
        return value

    @staticmethod
    def _text(value: object, name: str) -> str:
        if not isinstance(value, str):
            raise ValueError(f"{name} must be a string")
        return value.strip()

    @classmethod
    def _required_text(cls, raw: dict[str, object], key: str, prefix: str) -> str:
        value = cls._text(raw.get(key, ""), f"{prefix}.{key}")
        if not value:
            raise ValueError(f"{prefix}.{key} is required")
        return value

    @classmethod
    def _texts(cls, value: object, name: str) -> tuple[str, ...]:
        if not isinstance(value, list) or any(not isinstance(item, str) or not item.strip() for item in value):
            raise ValueError(f"{name} must be a list of non-empty strings")
        return tuple(str(item).strip() for item in value)

    @classmethod
    def _tokens(cls, value: object, name: str) -> tuple[str, ...]:
        return cls._texts(value, name)

    @staticmethod
    def _boolean(value: object, name: str) -> bool:
        if not isinstance(value, bool):
            raise ValueError(f"{name} must be true or false")
        return value
