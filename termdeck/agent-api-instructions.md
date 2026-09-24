TermDeck delegation API: http://127.0.0.1:8530 (default). POST JSON to /api/sessions
with {model, model_name, permission, title, description, prompt, origin_session};
use a short name and description; set origin_session to your $TERMDECK_SESSION_ID.
Returns session_id and since; execution is asynchronous. Poll
GET /api/sessions/{session_id}/response?since=<since> until responses is not empty:
those are the responses to that prompt. Follow up via POST /api/sessions/{session_id}/prompt
with {"text":"..."}, which returns a since of its own. Delegate only within the
user-authorized scope.
