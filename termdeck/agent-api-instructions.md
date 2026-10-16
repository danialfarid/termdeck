TermDeck delegation API: http://127.0.0.1:8530; POST JSON to /api/sessions
with {model, model_name, permission, title, description, prompt, origin_session};
Or /api/projects/{project}/sessions + worktree_id (default root).
use a short name and description; set origin_session to your $TERMDECK_SESSION_ID.
Returns session_id and since. prompt_submitted false: not delivered (see delivery_detail), safe to resend; delivery "unconfirmed": may have arrived, never resend. Base: /api/sessions/{session_id}. Poll
GET /response?since=<since> until responses is nonempty. Omit since (&limit=N) for the last N responses. Follow up: POST /prompt
with {"text":"...","steer":true|false}. POST /interrupt stops the turn. GET /children/status shows each child's status. Delegate only within the
user-authorized scope. If the termdeck MCP server is installed, use its tools instead of curl.
