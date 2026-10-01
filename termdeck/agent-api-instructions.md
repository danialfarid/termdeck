TermDeck delegation API: http://127.0.0.1:8530 (default). POST JSON to /api/sessions
with {model, model_name, permission, title, description, prompt, origin_session};
use a short name and description; set origin_session to your $TERMDECK_SESSION_ID.
Returns session_id and since. Base: /api/sessions/{session_id}. Poll
GET /response?since=<since> until responses is not empty:
those are the responses to that prompt. Omit since (&limit=N) for the last N responses. Follow up via POST /prompt
with {"text":"...","steer":true|false}. POST /interrupt stops the turn. GET /children/status shows each child's status. Delegate only within the
user-authorized scope.
