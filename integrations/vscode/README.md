# TermDeck for VS Code

The VS Code integration is a native VS Code client by default. It contributes a
native Tree View to the TermDeck Activity Bar and creates native VS Code
terminals for TermDeck sessions. An opt-in single-tab mode shows the selected
session in one TermDeck editor tab while the Activity Bar tree switches sessions.
The standalone desktop/browser application remains the HTML client, including
its HTML file tree.

The native view opens when the TermDeck Activity Bar icon is selected. Its
Refresh, New Group, and New Terminal actions are native view-title actions.
Right-clicking a session or group opens the native VS Code context menu. Rename,
new-session, move, and confirmation flows use VS Code InputBox, QuickPick, and
confirmation dialogs.

Session tabs, ordering, pinned sessions, groups, group membership, and the
active session are shared through the standalone server's
`/api/terminal-layout` API. Terminal output continues to use the server's
existing terminal WebSocket protocol.

## Install locally

For development, launch an Extension Development Host:

```sh
code --extensionDevelopmentPath=/Users/dan/workspace/termdeck/integrations/vscode /Users/dan/workspace/stock
```

To rebuild and install the local extension after editing the VS Code
integration:

```sh
cd /Users/dan/workspace/termdeck/integrations/vscode
./reinstall-termdeck-extension.sh
```

The script packages the extension as `termdeck-vscode-0.2.7.vsix` and installs
it with `--force`.

The extension uses `http://127.0.0.1:8530` by default. If that server is not
running, `termdeck.autoStart` starts it using the current workspace as the
default working directory and file root.

## Settings

- `termdeck.serverUrl`: standalone server URL, default `http://127.0.0.1:8530`.
- `termdeck.autoStart`: start the server if it is unavailable, default `true`.
- `termdeck.command`: executable used for auto-start, default `termdeck`.
- `termdeck.singleTabMode`: use one TermDeck editor tab instead of separate
  native VS Code terminal tabs, default `false`. The TermDeck sidebar gear also
  toggles this setting.
