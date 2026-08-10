#Spawining subagents for tasks:

```sh
curl -sS -X POST http://127.0.0.1:8530/api/terminals/task \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"codex\",\"model_name\":\"gpt-5.6-luna xhigh\",\"permission\":\"full-access\",\"title\":\"agent-reviewer\",\"prompt\":\"Review the current task and report the result.\",\"origin_session\":\"$TERMDECK_SESSION_ID\"}"
```

| Parameter | Description |
|---|---|
| `model` | `codex`, `claude`, `agy`, or `none`. |
| `model_name` | Model name; Codex may include reasoning effort after a space, for example `gpt-5.6-luna xhigh`; Claude/AGY examples: `opus`, `gemini-2.5-pro`. |
| `permission` | Agent permission mode, such as `default`, `workspace-write`, or `full-access`. |
| `title` | Child terminal title. |
| `prompt` | Prompt sent to the child agent. |
| `origin_session` | leave as env variable |
| `fork` | `false` starts a new agent; `true` forks from your session/memory. |

Response: `session_id`

## Send a follow-up message to them

`POST /api/terminals/task/{session_id}/prompt`

```sh
curl -sS -X POST http://127.0.0.1:8530/api/terminals/task/CHILD_SESSION_ID/prompt \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Now summarize your findings."}'
```

## Get their latest turn text

`GET /api/sessions/{session_id_or_name}/last_turn`

Names must be unique; duplicate names return an error.

## Close an agent

`DELETE /api/sessions/{session_id}`

Stops the terminal and moves it to closed sessions without erasing its history.
