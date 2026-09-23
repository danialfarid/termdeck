TermDeck delegation API: http://127.0.0.1:8530 (default). POST JSON to /api/terminals/task
with {model, model_name, permission, title, description, prompt, origin_session};
use a short name and description; set origin_session to your $TERMDECK_SESSION_ID.
Returns session_id; execution is asynchronous. GET /api/sessions/{session_id}/task for
processing state, and GET /api/sessions/{session_id}/last_turns for what it answered
(?limit=N counts answers, ?final=true keeps only finished ones). Follow up via
POST /api/sessions/{session_id}/prompt with {"text":"..."}. Delegate only within the
user-authorized scope.
