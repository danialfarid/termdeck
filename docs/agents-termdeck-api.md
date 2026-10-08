# TermDeck API for agents

Start, prompt, monitor, and close local agent sessions. The default server is `http://127.0.0.1:8530`.
TermDeck-launched processes receive `TERMDECK_SESSION_ID`, `TERMDECK_SESSION_NAME`, `TERMDECK_PROJECT`,
`TERMDECK_CWD`, and `TERMDECK_SESSION_URL`. Always keep `$TERMDECK_SESSION_ID` and pass it unchanged as
`origin_session` for every delegated child task; this is how TermDeck knows where to add the child.

## MCP server

MCP-capable models can use the same API as typed tools instead of curl. `termdeck mcp` serves
them over stdio against the local deck (honoring `--host`/`--port`); point the model's MCP
configuration at it:

```json
{
  "mcpServers": {
    "termdeck": { "command": "termdeck", "args": ["mcp"] }
  }
}
```

The tools mirror the calls below one for one: `spawn_agent`, `spawn_batch`, `send_prompt`,
`get_response`, `session_status`, `children_status`, `interrupt`, `list_sessions`,
`get_session`, `close_session`, `set_description`, `worktree_review`, `worktree_finish`, and
`session_history`. Two conveniences over raw HTTP: `spawn_agent` defaults `origin_session` to
the caller's own `$TERMDECK_SESSION_ID`, and `wait_for_response` polls `get_response` with the
prompt's `since` stamp until the agent answers or a bounded timeout runs out, so models need
not hand-roll polling loops. The `since` contract is unchanged: only responses stamped after
a prompt's own stamp answer that prompt.

## Start and prompt an agent

`POST /api/sessions`

```sh
curl -sS -X POST http://127.0.0.1:8530/api/sessions \
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
| `output_path`, `write_back`, `steer`, `bracketed` | Optional output file, parent result delivery, prompt steering (`steer: false` queues), and bracketed prompt input. |

The response contains `session_id`. Leave `prompt` out to create the terminal without starting it on
anything, and send one later with `POST /api/sessions/{session_id}/prompt` and `{"text":"..."}`.

For example, include `"title":"review-parser","description":"Review parser edge cases"` in the creation
JSON alongside the model, prompt, and origin session. No separate description request is needed.
Creation returns before the agent finishes, and carries `since`. Poll `response?since=<since>` for the
responses to that prompt; `/status` has the full session state. `running` means the terminal process is
alive, not that a response is still being generated, and `/response.status` says the same thing.

## Batch work

`POST /api/sessions/batch` accepts a `terminals` list with per-agent `name` and `prompt`; shared launch fields
above can be overridden per item. It returns one result per requested agent.
Each item also accepts its own optional `description`.

## Monitor and follow up

- `GET /api/sessions/{session_id}/status` returns running state, transcript tail, and the latest turn.
- `GET /api/sessions/{session_id}/children/status` returns each spawned child's status.
- `GET /api/sessions/{session_id}/response` returns what the agent said back, under `responses`.
  `limit` counts responses rather than transcript entries (default 1, capped at 50).
- To wait for the response to your own prompt, pass the `since` the prompt call returned:
  `response?since=<since>`, and poll until `responses` is not empty. It finds your prompt in the
  transcript and returns what the agent said after it, so a prompt queued behind another does not come
  back with the other one's answer. Only that ties a response to your prompt: `status` describes the
  terminal process, which stays open between prompts, and `processing` is false both before an agent
  starts and while it waits on a person (`needs_attention`).
- `GET /api/sessions/{session_id}/response/final` is the same with what an agent says on its way
  through the work left out, for the agents that mark which message ended a turn.
- `POST /api/sessions/{session_id}/prompt` sends a prompt with `{"text":"..."}`.
- Every call that sends a prompt waits until the agent has recorded it and says what happened.
  `prompt_submitted: false` (`delivery: "failed"`, the reason in `delivery_detail`, and no `since`) means
  it did not go in, for example because Codex was asking whether to update or the terminal exited:
  send it again, or start another terminal. `delivery: "unconfirmed"` means it went in and may well
  have arrived: never send it again, wait for the response instead. See
  [Did the prompt go in](api.md#did-the-prompt-go-in).
- `POST /api/sessions/{session_id}/interrupt` stops the turn.
- `GET /api/sessions` lists sessions and `GET /api/sessions/{session_id}` returns one session.

For isolated work, `GET /api/sessions/{session_id}/worktree/review` shows the branch and diff. Finish it with
`POST /api/sessions/{session_id}/worktree/finish` and `{"action":"keep"}`, `{"action":"merge"}`, or
`{"action":"discard"}`.

Use `POST /api/sessions/{session_id}/description` with `{"description":"...","append":true}` to set the
user-visible session description. `DELETE /api/sessions/{session_id}`
stops it without erasing its history.
