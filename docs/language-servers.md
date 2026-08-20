# Language servers

TermDeck connects Monaco to standard Language Server Protocol processes running on the same machine as the
TermDeck server. A language server starts only when a supported source file is opened, and one process is
shared by every open document in the same project.

When a server is available, Monaco gains:

- definitions and references;
- workspace symbols through Quick Open with an `@` prefix;
- rename refactoring;
- diagnostics in the editor and Problems panel;
- code actions and quick fixes;
- hover types and documentation.

The bottom status bar names the connected language server. If no matching server is installed, ordinary file
editing and TermDeck's project-search definition fallback continue to work.

## Supported servers

TermDeck first applies a command assigned to the project in **Settings → Language servers**, then a settings
default shared by all projects, then its environment override, project-aware detection, `PATH`, and the same
well-known binary directories used for other external tools. The settings panel reports the effective command,
source, and detected version and can reset any assignment back to automatic selection.

| Languages | Default command | Environment override | Installation example |
|---|---|---|---|
| Python | `basedpyright-langserver --stdio`, `pyright-langserver --stdio`, or `pylsp` | `TERMDECK_LSP_PYTHON` | `pipx install basedpyright` |
| JavaScript, TypeScript | TypeScript 7: project/global `tsc --lsp --stdio`; TypeScript 6: `typescript-language-server --stdio` | `TERMDECK_LSP_TYPESCRIPT` | `npm install -g typescript@7` or `npm install -g typescript@6 typescript-language-server` |
| Go | `gopls` | `TERMDECK_LSP_GO` | `go install golang.org/x/tools/gopls@latest` |
| Rust | `rust-analyzer` | `TERMDECK_LSP_RUST` | `rustup component add rust-analyzer` |
| C, C++, Objective-C, CUDA | `clangd --background-index` | `TERMDECK_LSP_CLANGD` | `brew install llvm` |
| Java | `jdtls` | `TERMDECK_LSP_JAVA` | `brew install jdtls` |
| Ruby | `solargraph stdio` | `TERMDECK_LSP_RUBY` | `gem install solargraph` |
| PHP | `intelephense --stdio` | `TERMDECK_LSP_PHP` | `npm install -g intelephense` |
| Shell | `bash-language-server start` | `TERMDECK_LSP_BASH` | `npm install -g bash-language-server` |
| YAML | `yaml-language-server --stdio` | `TERMDECK_LSP_YAML` | `npm install -g yaml-language-server` |
| JSON | `vscode-json-language-server --stdio` | `TERMDECK_LSP_JSON` | `npm install -g vscode-langservers-extracted` |
| HTML | `vscode-html-language-server --stdio` | `TERMDECK_LSP_HTML` | `npm install -g vscode-langservers-extracted` |
| CSS, SCSS, Less | `vscode-css-language-server --stdio` | `TERMDECK_LSP_CSS` | `npm install -g vscode-langservers-extracted` |

An override contains the complete command and arguments:

```sh
export TERMDECK_LSP_PYTHON="$HOME/.local/bin/basedpyright-langserver --stdio"
```

Environment changes require a TermDeck restart. Settings overrides reload the affected project immediately.
`GET /api/lsp/status?root=/path/to/project` reports discovered commands, versions, resolution sources, and
active project servers.

## Editor commands

Monaco's standard commands remain the interface: hover a symbol for its type and documentation, use its Go to
Definition, Peek References, Rename Symbol, and Quick Fix actions, or press `@` in Quick Open to search
workspace symbols. TermDeck's Command-click definition action uses the language server first and falls back to
project text search when no definition is returned.

Rename and code-action workspace edits are validated against `TERMDECK_FILE_ROOT`, recorded in local file
history, and then written to disk. Language-server requests cannot edit a file outside the active project.

## Project configuration

Language servers use the project directory as their workspace root and read their ordinary project files.
Examples include `pyproject.toml`, `tsconfig.json`, `go.mod`, `Cargo.toml`, and `compile_commands.json`. Configure
the language server through those native project files rather than through TermDeck.

For JavaScript and TypeScript, TermDeck reads the project-local `node_modules/typescript/package.json` first.
Version 7 uses its native LSP directly. Version 6 and earlier use `typescript-language-server`. A project command
assignment can select an exact executable or wrapper command without changing another project's compiler.
