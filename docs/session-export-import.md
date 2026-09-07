# Session export and import

Right-click a terminal and choose **Export session…** to download a `.termdeck-project` session-collection
archive containing that terminal. Choose **Export all sessions…** from the **+** menu beside the project name to
download the same archive format with every session and the deck layout. **Import sessions…** accepts either
form, as well as older `.termdeck-session` archives.

An archive contains:

- the terminal title, agent kind, resume identity, saved command, draft, dimensions, and project-relative
  working directory;
- up to 24 MB of normalized conversation turns for portable transcript reading;
- up to 24 MB of terminal replay when that adapter has durable replay data.

Importing one session creates a dormant tab in the selected project and worktree. For an archive with multiple
sessions, TermDeck asks whether to merge into the current project or create a separate imported project. A new
project is registered with all imported tabs and shown as a link that can be opened in the current or a new
browser tab. Import never starts a process or sends a prompt. The imported conversation is available in
transcript mode even when the original agent's native session store is absent. When that native store is present,
TermDeck uses it as the authoritative live transcript.

Opening the imported terminal is an explicit resume action and may execute the command recorded in the archive.
Only import archives you trust. A relative working directory is restored beneath the selected project or
worktree; a missing directory falls back to that root. Worktree ownership, output delivery paths, and absolute
source-machine paths are not imported.

The HTTP surface is:

```text
GET  /api/sessions/{session_id}/export
POST /api/sessions/import?project={project}&worktree_id={id}&trusted=true
     multipart field: file
POST /api/imports/inspect
     multipart field: file
```

`trusted=true` is required so API clients acknowledge the same command-execution boundary shown by the UI.

## Project migration

A full `.termdeck-project` archive contains every open or dormant TermDeck session in one project, each session's
portable archive, its normalized transcript and available replay, grouping/order/view state, notebook notes, copy
history, and the project and worktree colors. A one-session export uses the same container with only that
session's relevant layout state. Neither form contains project source files, Git objects, working trees, or
absolute machine paths.

To move a project to another machine, clone or otherwise copy the source project first, add that folder to
TermDeck, then import the archive into the selected project. Existing target worktrees are matched first by stable
ID, then branch, then name. A session from an unavailable worktree is restored under the project root and reported
after import. Imported sessions stay dormant until explicitly opened.

The project HTTP surface is:

```text
GET  /api/projects/{project}/export
POST /api/projects/import?project={project}&trusted=true&import_mode=merge
POST /api/projects/import?trusted=true&import_mode=new
     multipart field: file
```
