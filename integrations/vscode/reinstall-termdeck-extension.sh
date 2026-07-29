#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if ! command -v npx >/dev/null 2>&1; then
  echo "npm/npx is not available. Install Node.js before running this script."
  exit 1
fi

CODE_COMMAND=""
if command -v code >/dev/null 2>&1; then
  CODE_COMMAND="$(command -v code)"
elif [ -x "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" ]; then
  CODE_COMMAND="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
elif [ -x "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code" ]; then
  CODE_COMMAND="/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code"
elif [ -x "${HOME}/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" ]; then
  CODE_COMMAND="${HOME}/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
fi

if [ -z "${CODE_COMMAND}" ]; then
  echo "VS Code CLI could not be found."
  echo "Set PATH to include 'code', or run VS Code: Command Palette -> 'Shell Command: Install 'code' command in PATH'."
  exit 1
fi

VSIX_NAME="termdeck-vscode-0.2.7.vsix"
npx --yes @vscode/vsce package

"${CODE_COMMAND}" --install-extension "${VSIX_NAME}" --force
