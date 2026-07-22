# Contributing

Thanks for taking a look. Issues and pull requests are both welcome.

## Getting set up

```sh
git clone https://github.com/danialfarid/termdeck.git
cd termdeck
python3 -m venv .venv
.venv/bin/pip install -e .
.venv/bin/termdeck doctor      # confirm dtach, rg, lsof are found
```

Run a development instance on its own port and data directory so it can't disturb an installed copy:

```sh
.venv/bin/termdeck --port 8531 --data-dir ~/.termdeck-dev --open
```

Python changes take effect on restart; changes under `termdeck/static/` take effect on a browser reload.

## Before opening a pull request

```sh
ruff check .                            # if you have ruff; config is in pyproject.toml
python -m compileall -q termdeck        # syntax check
python -m build                         # the package still builds
```

Then exercise what you changed in a real browser. There is no test suite yet — a PR that adds meaningful
tests for the module it touches is very welcome.

## Code conventions

This codebase is deliberately consistent. Match the surrounding style:

- **Descriptive names instead of comments.** If a block needs explaining, extract it into a well-named
  method. Comments are reserved for class-level docstrings describing workflow, contracts, and corner cases —
  never a running narration of the code, and never a reference to a specific caller.
- **Constants, not literal strings.** Routes, escape sequences, filenames, and limits belong in
  `TermdeckConfig`.
- **No module-level functions and no nested functions.** Behaviour belongs to a class as a method or a
  static method; shared helpers go in a util class.
- **Fail fast.** Don't catch bare `Exception`, don't swallow errors to keep going, and don't guard an
  expected key or column with `if x in y` / `.get(...)` — a missing expected value is a bug and should raise
  at the real failure site.
- **Type hints on every method and property**, with precise container types (`dict[str, int]`, not `dict`).
- **120-column lines.** Keep signatures, dict literals, and call sites dense rather than one argument per
  line.
- **Small files.** Aim under ~300 lines per class file; split by responsibility instead of growing one.
- **YAGNI.** Add a parameter or field when it has a caller, not before.

New user-visible behaviour should come with a README or `docs/` update in the same PR.

## Architecture

[docs/architecture.md](docs/architecture.md) walks through the process model, every module's
responsibility, the agent-session tracking design, and the WebSocket protocol. Worth reading before a change
that spans more than one file.

## Reporting bugs

Include:

- `termdeck doctor` output
- `termdeck --version`, your OS and version
- Steps to reproduce, what happened, what you expected
- Relevant lines from `termdeck service logs` if you run it as a service

## Security issues

Please don't open a public issue — see [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).
