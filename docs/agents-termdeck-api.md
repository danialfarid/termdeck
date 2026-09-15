# TermDeck API for agents

How one agent puts another agent to work. Every terminal TermDeck opens carries its own session id in
`$TERMDECK_SESSION_ID`, so an agent running inside the deck can start a second agent, send it prompts, read
what it answered, and close it — all over `http://127.0.0.1:8530`, and all of it visible to you as ordinary
terminals in the deck.

## Link a trainer study to its agent tab

Every agent terminal also receives these environment variables:

| Variable | Meaning |
|---|---|
| `TERMDECK_SESSION_ID` | The TermDeck terminal id. Use this value in a trainer experiment's `agent_ids` list. |
| `TERMDECK_SESSION_NAME` | The TermDeck terminal title. |
| `TERMDECK_SESSION_URL` | A direct local URL that opens this terminal. |

`Experiment` automatically includes `TERMDECK_SESSION_ID` when it is created inside TermDeck. Explicitly
pass `agent_ids=[...]` when an orchestrator wants to attach more than one agent to the same experiment:

```python
import os

experiment = Experiment(name="feature_study", version="1", agent_ids=[os.environ["TERMDECK_SESSION_ID"]])
```

Add the studies launched by the agent to the tab description. The trainer dashboard uses the persisted
`agent_ids` to show direct links back to the matching TermDeck tabs.

```sh
curl -sS -X POST "http://127.0.0.1:8530/api/sessions/$TERMDECK_SESSION_ID/description" \
  -H 'Content-Type: application/json' \
  -d '{"description":"feature_study / 2026-09-14 baseline","append":true}'
```

`GET /api/sessions` and `GET /api/sessions/{session_id}` return `title`, `description`, `termdeck_url`,
and `termdeck_url_path` for dashboard and automation integrations.

## Start an agent

`POST /api/terminals/task`

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
| `origin_session` | Your own session id — pass `$TERMDECK_SESSION_ID` unchanged. It files the child under the session that started it. |
| `fork` | `false` starts a new agent; `true` forks from your session/memory. |
| `worktree_id` | Starts the child in an existing project worktree returned by `GET /api/worktrees`. Omit it for the project root. |
| `worktree` | `true` starts the child in a separate Git worktree and branch. The response includes its path and branch. |

Response: `session_id`

For isolated work, poll `GET /api/sessions/{session_id}/worktree/review` to inspect the branch and diff. Use
`POST /api/sessions/{session_id}/worktree/finish` with `{"action":"keep"}`, `{"action":"merge"}`, or
`{"action":"discard"}` when the review is complete. `merge` requires committed worktree changes and a clean base
checkout; `discard` is destructive to uncommitted work.

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
