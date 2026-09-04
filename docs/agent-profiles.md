# Declarative agent profiles

TermDeck's built-in adapters cover Codex, Claude Code, AGY, Aider, and OpenCode. A simple agent CLI can be
added without changing Python by creating `agent-profiles.json` in the TermDeck data directory (normally
`~/.termdeck`) and restarting the server. Profiles use argument arrays rather than shell fragments, so model,
session, and title values remain single escaped arguments.

```json
{
  "version": 1,
  "agents": [
    {
      "kind": "reviewer",
      "label": "Reviewer",
      "executable": "reviewer-cli",
      "aliases": ["review"],
      "base_arguments": ["--tui"],
      "model_arguments": ["--model", "{model}"],
      "permissions": [
        {"value": "default", "label": "Default", "arguments": []},
        {"value": "auto", "label": "Auto approve", "arguments": ["--permission", "auto"]}
      ],
      "resume_arguments": ["--session", "{session_id}"],
      "fork_arguments": ["--session", "{session_id}", "--fork", "--name", "{title}"],
      "session_value_flags": ["--session", "--name"],
      "session_switch_flags": ["--fork"],
      "rename_input": "/rename {title}",
      "activity": {
        "strategy": "terminal-output",
        "keepalive_seconds": 4
      },
      "attention_markers": ["approve this action"],
      "model_placeholder": "provider/model",
      "model_help": "Use openrouter/provider/model after configuring OPENROUTER_API_KEY.",
      "icon_svg": "<svg viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"8\" fill=\"currentColor\"/></svg>",
      "install_hint": "brew install reviewer-cli"
    }
  ]
}
```

The profile appears in New Terminal, receives its own icon toggle and permission selector, is detected from
its executable, and participates in dependency diagnostics. `resume_arguments`, `fork_arguments`, and
`rename_input` enable the corresponding terminal actions. Omit a command to omit that capability.

## Activity strategies

- `terminal-title` uses the same OSC-title spinner detection as the base adapter.
- `terminal-output` marks the agent working while output continues, suppressing input echoes and resize
  repaints. `keepalive_seconds` may be between 0.5 and 60 seconds.
- `jsonl-event` restores working state from a transcript without starting the terminal. Set `event_path`,
  `active_values`, and `idle_values` under `activity`; file-change events update the dot without polling.

## JSONL transcripts

Add `transcript` when the CLI writes one JSON object per line:

```json
{
  "root": "~/.reviewer/sessions",
  "path": "{session_id}/events.jsonl",
  "glob": "*/events.jsonl",
  "session_id_regex": "^(?P<session_id>[^/]+)/events\\.jsonl$",
  "role_path": "message.role",
  "content_path": "message.content",
  "timestamp_path": "created_at",
  "model_path": "message.model",
  "cwd_path": "session.cwd",
  "title_path": "session.title",
  "roles": {
    "user": ["user"],
    "assistant": ["assistant"],
    "thinking": ["thinking", "reasoning"],
    "event": ["tool", "system"]
  }
}
```

Dotted paths traverse nested objects; numeric segments address list elements. With a transcript, Markdown
mode, history search, model display, title recovery, and session binding use the same generic services as the
built-in adapters. Set `history_indexed` to `false` if its transcript tree should not enter terminal search.

For event-driven activity, add this beside `transcript`:

```json
{
  "activity": {
    "strategy": "jsonl-event",
    "event_path": "event",
    "active_values": ["turn.started", "turn.streaming"],
    "idle_values": ["turn.completed", "turn.failed", "turn.cancelled"]
  }
}
```

Use `sessionless: true` for directory-scoped agents like Aider; sessionless profiles cannot define transcript
identity, resume arguments, or fork arguments. Other optional booleans are `records_raw_replay`,
`fullscreen_tui`, `has_prompt_queue`, and `canonical_resume_command`.

Profiles are intentionally bounded to data mapping and command templates. A CLI with SQLite state, a
whole-document transcript, subagents, or protocol-specific attention handling should use a Python
`AgentCli` subclass described in [Agent CLI API](agent-cli-api.md).

The SVG is trusted local configuration but is still restricted to one 8 KB SVG; scripts, event handlers,
foreign objects, links, and JavaScript URLs are rejected. Profile kinds and executables cannot shadow a
built-in adapter. A malformed profile fails startup with the field name so configuration mistakes do not
silently launch the wrong command.
