# Automation API

TermDeck exposes a small local HTTP API for agents and scripts. The default server is
`http://127.0.0.1:8530`. There is no authentication, so keep the server bound to localhost or place it
behind your own access control before exposing it to a network.

These endpoints start real persistent TermDeck terminals. A successful prompt response means the prompt was
written to the terminal and submitted; it does not mean the agent has finished processing it. Use
`GET /api/sessions/{session_id}/last_turn` for the minimal status/result poll.

## Start one terminal task (create + run in one call)

`POST /api/terminals/task` creates one terminal, starts it immediately, submits a single prompt, and returns
the created session summary. Set `origin_session` to have the completed child result sent back to that session.

```sh
task_json=$(curl -sS -X POST http://127.0.0.1:8530/api/terminals/task \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "reviewer",
    "cwd": "/Users/dan/workspace/stock",
    "project": "stock",
    "model": "codex",
    "model_name": "gpt-5.6-luna xhigh",
    "permission": "workspace-write",
    "prompt": "Please review this terminal state and summarize the top 3 risks.",
    "output_path": "/tmp/termdeck/reviewer.out",
    "after": "termde",
    "origin_session": "termde",
    "bracketed": true,
    "queue": false
  }')
```

If `project` is omitted and `after` is the unique session/group name in a single project, TermDeck infers that project
from the anchor before creating the new terminal.

For a minimal result poll, use `GET /api/sessions/{session_id}/last_turn`:

```sh
session_id=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["session_id"])' <<< "$task_json")
curl -sS "http://127.0.0.1:8530/api/sessions/$session_id/last_turn"
```

Relative `output_path` values are resolved under `cwd` before writing.

Response:

```json
{
  "session_id": "abc123...",
  "status": "completed",
  "last_turn": {"role": "assistant", "text": "..."}
}
```

`output_path` is where raw terminal bytes are appended. Set a per-project path and include that file in any monitor
process that needs deterministic logs.
`model_name` is passed as an explicit `--model` argument to Codex, Claude, or AGY.
The request is not blocking; it returns after prompt submission. Poll `last_turn` for status and the latest turn.

## Launch several named terminals

`POST /api/terminals/batch` creates up to 32 terminals and submits their prompts. The top-level `prompt`,
`cwd`, `project`, `model`, `permission`, `bracketed`, `queue`, and `after` values are defaults for every item.
An item can override any of them. `after` accepts an existing session name or group name (case-insensitive),
or the stable `session:<id>` / `group:<id>` layout token. It inserts each new terminal immediately after that
anchor. If the anchor is a member of a group, the new terminal inherits that group and is inserted immediately
after that member; when several items share the same `after`, their request order is preserved. Every request
creates new terminals; it is not idempotent.

For a new Codex terminal, `name` is also submitted as Codex's thread name after the new session is detected.
The initial prompt is sent only after that rename and the Codex composer are ready, so it is not lost during
startup. Resuming an existing Codex session does not rename the resumed thread.

```sh
curl -sS -X POST http://127.0.0.1:8530/api/terminals/batch \
  -H 'Content-Type: application/json' \
  -d '{
    "cwd": "/Users/dan/workspace/stock",
    "project": "stock",
    "model": "codex",
    "model_name": "gpt-5.6-luna xhigh",
    "permission": "workspace-write",
    "after": "existing session or group name",
    "prompt": "Inspect the current task, make the requested change, and report the result.",
    "terminals": [
      {"name": "x"},
      {"name": "y"},
      {"name": "z"}
    ]
  }'
```

The response contains one result per requested terminal. A terminal that was created successfully remains
available even if its prompt submission fails, so a partial failure does not silently kill work already started.

```json
{
  "requested": 3,
  "created": 3,
  "prompt_submitted": 3,
  "failed": 0,
  "items": [
    {
      "name": "x",
      "session": {
        "session_id": "abc123...",
        "title": "x",
        "project": "stock",
        "agent_kind": "codex",
        "agent_session_id": null,
        "running": true
      },
      "prompt_submitted": true,
      "queued": false
    }
  ]
}
```

The agent session ID may initially be `null`; TermDeck discovers the Codex or Claude session asynchronously
after the CLI creates its session file.

## Create one terminal, then submit a prompt

For callers that want individual control, use the existing session-create endpoint followed by the prompt
endpoint. It also accepts the optional `after` field, using the same session/group name or stable layout token
rules as the batch endpoint.

```sh
session_json=$(curl -sS -X POST http://127.0.0.1:8530/api/sessions \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "x",
    "cwd": "/Users/dan/workspace/stock",
    "project": "stock",
    "model": "codex",
    "model_name": "gpt-5.6-luna xhigh",
    "permission": "workspace-write",
    "after": "termde"
  }')

session_id=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["session_id"])' <<< "$session_json")

curl -sS -X POST "http://127.0.0.1:8530/api/sessions/$session_id/prompt" \
  -H 'Content-Type: application/json' \
  -d '{
    "text": "Inspect the current task, make the requested change, and report the result.",
    "bracketed": true,
    "queue": false
  }'
```

`bracketed` defaults to `true` and sends the prompt as one paste operation before pressing Enter. Set
`queue: true` for Codex to place the prompt in its queue with Tab instead of submitting it for immediate
processing. If a requested placement target is missing or ambiguous, that terminal is still created and its
prompt is still submitted; the item reports `placement_error` and the response increments `placement_failed`.

## Other useful calls

List active terminals:

```sh
curl -sS 'http://127.0.0.1:8530/api/sessions?project=stock'
```

Delete a terminal and stop its running process:

```sh
curl -sS -X DELETE "http://127.0.0.1:8530/api/sessions/$session_id"
```

The delete succeeds only after TermDeck has terminated that session's dtach process tree and verified that its
socket was removed. A failed cleanup returns HTTP 409 and leaves the terminal session visible for inspection.

## Terminal process health and orphan cleanup

`GET /api/terminals/processes` is a local, read-only inventory of processes reachable from TermDeck's own
`dtach` sockets. It reports each socket's session/title, whether it is attached or detached, descendant PIDs,
RSS, CPU, process state, `node_repl` count, zombie count, and any socket with no persisted session record.

```sh
curl -sS http://127.0.0.1:8530/api/terminals/processes
```

`POST /api/terminals/reclaim-orphans` is deliberately explicit: it terminates only process trees reachable
from dtach sockets that are not present in the TermDeck session store, then verifies their socket removal. It
does not affect named/current sessions.

```sh
curl -sS -X POST http://127.0.0.1:8530/api/terminals/reclaim-orphans
```

The normal terminal WebSocket remains available at `/ws/<session_id>` for interactive input, resize events,
scrollback, and live output. The HTTP prompt endpoint is intended for automation that does not need to attach a
terminal renderer.
