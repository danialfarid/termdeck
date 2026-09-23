# TermDeck API for agents

Start, prompt, monitor, and close local agent sessions. The default server is `http://127.0.0.1:8530`.
TermDeck-launched processes receive `TERMDECK_SESSION_ID`, `TERMDECK_SESSION_NAME`, `TERMDECK_PROJECT`,
`TERMDECK_CWD`, and `TERMDECK_SESSION_URL`. Always keep `$TERMDECK_SESSION_ID` and pass it unchanged as
`origin_session` for every delegated child task; this is how TermDeck knows where to add the child.

## Start and prompt an agent

`POST /api/terminals/task`

```sh
curl -sS -X POST http://127.0.0.1:8530/api/terminals/task \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"codex\",\"model_name\":\"gpt-5.6-luna xhigh\",\"permission\":\"full-access\",\"title\":\"agent-reviewer\",\"prompt\":\"Review the current task and report the result.\",\"origin_session\":\"$TERMDECK_SESSION_ID\"}"
```

| Parameter | Description |
|---|---|
| `model` | `codex`, `claude`, `agy`, or `none`. |
| `model_name` | Agent model identifier, optionally including reasoning effort. |
| `permission` | Agent permission mode, such as `default`, `workspace-write`, or `full-access`. |
| `additional_args` | Optional shell-style launch parameters; matching or conflicting generated options are replaced and other arguments are appended. |
| `title`, `prompt` | Child title and initial prompt. |
| `description` | Optional short, user-visible task description, saved during creation. |
| `origin_session` | Required for delegated child tasks: pass `$TERMDECK_SESSION_ID` unchanged so TermDeck links the child to this agent. |
| `session_ref` | Existing agent session ID or name to resume. |
| `cwd`, `project`, `after` | Directory, project, and optional placement anchor. |
| `worktree`, `worktree_id` | Start in a new isolated worktree or an existing project worktree. |
| `fork` | Fork the `origin_session` instead of starting a fresh agent. |
| `output_path`, `write_back`, `queue`, `bracketed` | Optional output file, parent result delivery, prompt queueing, and bracketed prompt input. |

The response contains `session_id`. `POST /api/sessions` creates the same kind of session without an initial
prompt; it also accepts `description`. Then use `POST /api/sessions/{session_id}/prompt` with `{"text":"..."}`.

For example, include `"title":"review-parser","description":"Review parser edge cases"` in the creation
JSON alongside the model, prompt, and origin session. No separate description request is needed.
Creation returns before the agent finishes. Poll `/task` for `processing` and `latest_turn`; confirm the
answer belongs to your submitted prompt. `running` means the terminal process is alive, not that an answer
is still being generated. `/last-turns.status` also describes process lifetime, not turn completion.

## Batch work

`POST /api/terminals/batch` accepts a `terminals` list with per-agent `name` and `prompt`; shared launch fields
above can be overridden per item. It returns one result per requested agent.
Each item also accepts its own optional `description`.

## Monitor and follow up

- `GET /api/sessions/{session_id}/task` returns running state, transcript tail, and the latest turn.
- `GET /api/sessions/{session_id}/last-turns` returns `status` and the agent's answers under `turns`.
  `limit` counts answers rather than transcript entries (default 1, capped at 50) and `final=true` keeps
  only the answers a turn ended with, which is what a caller waiting on a result wants.
- `POST /api/sessions/{session_id}/prompt` sends a prompt with `{"text":"..."}`; the task alias
  `POST /api/terminals/task/{session_id}/prompt` accepts `{"prompt":"..."}`.
- `GET /api/sessions` lists sessions and `GET /api/sessions/{session_id}` returns one session.

For isolated work, `GET /api/sessions/{session_id}/worktree/review` shows the branch and diff. Finish it with
`POST /api/sessions/{session_id}/worktree/finish` and `{"action":"keep"}`, `{"action":"merge"}`, or
`{"action":"discard"}`.

Use `POST /api/sessions/{session_id}/description` with `{"description":"...","append":true}` to set the
user-visible session description. `DELETE /api/sessions/{session_id}`
stops it without erasing its history.
