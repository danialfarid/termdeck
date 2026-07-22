#!/bin/zsh
# Development launcher: runs termdeck from this source checkout's virtualenv.
# For a normal install use the `termdeck` command instead (see README.md).
cd "$(dirname "$0")"
exec .venv/bin/python -m termdeck "$@"
