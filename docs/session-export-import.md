# Session export and import

Right-click a terminal and choose **Export session…** to download a `.termdeck-session` archive. Import one
from the **+** menu beside the project name. The destination is the selected project and worktree.

An archive contains:

- the terminal title, agent kind, resume identity, saved command, draft, dimensions, and project-relative
  working directory;
- up to 24 MB of normalized conversation turns for portable transcript reading;
- up to 24 MB of terminal replay when that adapter has durable replay data.

Importing creates a dormant tab. It does not start a process or send a prompt. The imported conversation is
available in transcript mode even when the original agent's native session store is absent. When that native
store is present, TermDeck uses it as the authoritative live transcript.

Opening the imported terminal is an explicit resume action and may execute the command recorded in the archive.
Only import archives you trust. A relative working directory is restored beneath the selected project or
worktree; a missing directory falls back to that root. Worktree ownership, output delivery paths, and absolute
source-machine paths are not imported.

The HTTP surface is:

```text
GET  /api/sessions/{session_id}/export
POST /api/sessions/import?project={project}&worktree_id={id}&trusted=true
     multipart field: file
```

`trusted=true` is required so API clients acknowledge the same command-execution boundary shown by the UI.
