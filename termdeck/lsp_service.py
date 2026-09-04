from __future__ import annotations

import asyncio
import json
import os
import shlex
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from termdeck.file_service import ProjectFileService
from termdeck.lsp_protocol import LanguageServerConnection
from termdeck.lsp_workspace_edit import LspWorkspaceEditService
from termdeck.platform_paths import PlatformPaths


class LanguageServerUnavailableError(RuntimeError):
    pass


@dataclass(frozen=True)
class LanguageServerSpec:
    name: str
    languages: tuple[str, ...]
    environment_variable: str
    command_candidates: tuple[tuple[str, ...], ...]
    install_hint: str


@dataclass(frozen=True)
class ResolvedLanguageServer:
    spec: LanguageServerSpec
    name: str
    command: tuple[str, ...]
    source: str
    version: str = ""


class LanguageServerRegistry:
    DEFAULT_OVERRIDE_SCOPE = "__default__"
    TYPESCRIPT_KEY = "typescript"
    SPECS: tuple[LanguageServerSpec, ...] = (
        LanguageServerSpec("BasedPyright", ("python",), "TERMDECK_LSP_PYTHON",
                           (("basedpyright-langserver", "--stdio"), ("pyright-langserver", "--stdio"), ("pylsp",)),
                           "pipx install basedpyright"),
        LanguageServerSpec("TypeScript / JavaScript", ("javascript", "javascriptreact", "typescript", "typescriptreact"),
                           "TERMDECK_LSP_TYPESCRIPT", (("typescript-language-server", "--stdio"),),
                           "npm install -g typescript@7"),
        LanguageServerSpec("gopls", ("go",), "TERMDECK_LSP_GO", (("gopls",),),
                           "go install golang.org/x/tools/gopls@latest"),
        LanguageServerSpec("rust-analyzer", ("rust",), "TERMDECK_LSP_RUST", (("rust-analyzer",),),
                           "rustup component add rust-analyzer"),
        LanguageServerSpec("clangd", ("c", "cpp", "objective-c", "objective-cpp", "cuda-cpp"), "TERMDECK_LSP_CLANGD",
                           (("clangd", "--background-index"),), "brew install llvm"),
        LanguageServerSpec("JDT LS", ("java",), "TERMDECK_LSP_JAVA", (("jdtls",),), "brew install jdtls"),
        LanguageServerSpec("Solargraph", ("ruby",), "TERMDECK_LSP_RUBY", (("solargraph", "stdio"),),
                           "gem install solargraph"),
        LanguageServerSpec("Intelephense", ("php",), "TERMDECK_LSP_PHP", (("intelephense", "--stdio"),),
                           "npm install -g intelephense"),
        LanguageServerSpec("Bash Language Server", ("shell",), "TERMDECK_LSP_BASH",
                           (("bash-language-server", "start"),), "npm install -g bash-language-server"),
        LanguageServerSpec("YAML Language Server", ("yaml",), "TERMDECK_LSP_YAML",
                           (("yaml-language-server", "--stdio"),), "npm install -g yaml-language-server"),
        LanguageServerSpec("JSON Language Server", ("json", "jsonc"), "TERMDECK_LSP_JSON",
                           (("vscode-json-language-server", "--stdio"),), "npm install -g vscode-langservers-extracted"),
        LanguageServerSpec("HTML Language Server", ("html",), "TERMDECK_LSP_HTML",
                           (("vscode-html-language-server", "--stdio"),), "npm install -g vscode-langservers-extracted"),
        LanguageServerSpec("CSS Language Server", ("css", "scss", "less"), "TERMDECK_LSP_CSS",
                           (("vscode-css-language-server", "--stdio"),), "npm install -g vscode-langservers-extracted"),
    )

    @classmethod
    def setting_key(cls, spec: LanguageServerSpec) -> str:
        return spec.environment_variable.removeprefix("TERMDECK_LSP_").lower()

    @classmethod
    def spec_for_language(cls, language: str) -> LanguageServerSpec | None:
        normalized = language.strip().lower()
        return next((spec for spec in cls.SPECS if normalized in spec.languages), None)

    @classmethod
    def spec_for_setting_key(cls, setting_key: str) -> LanguageServerSpec | None:
        normalized = setting_key.strip().lower()
        return next((spec for spec in cls.SPECS if cls.setting_key(spec) == normalized), None)

    @classmethod
    def resolve(cls, language: str, root: Path | None = None,
                overrides: dict[str, dict[str, str]] | None = None) -> ResolvedLanguageServer | None:
        spec = cls.spec_for_language(language)
        if spec is None:
            return None
        override, override_source = cls.command_override(spec, root, overrides or {})
        if override:
            return cls._resolve_candidate(spec, tuple(shlex.split(override)), root, override_source)
        environment_command = os.environ.get(spec.environment_variable, "").strip()
        if environment_command:
            return cls._resolve_candidate(spec, tuple(shlex.split(environment_command)), root, "environment override")
        if cls.setting_key(spec) == cls.TYPESCRIPT_KEY:
            native_typescript = cls._resolve_native_typescript(root)
            if native_typescript is not None:
                return native_typescript
            project_typescript_version = cls._typescript_package_version(root / "node_modules" / "typescript") if root else ""
            if cls._major_version(project_typescript_version) >= 7:
                return None
        for candidate in spec.command_candidates:
            resolved = cls._resolve_candidate(spec, candidate, root, "automatic")
            if resolved is not None:
                version = cls._legacy_typescript_version(root) if cls.setting_key(spec) == cls.TYPESCRIPT_KEY else ""
                return ResolvedLanguageServer(spec, spec.name, resolved.command, resolved.source, version)
        return None

    @classmethod
    def command_override(cls, spec: LanguageServerSpec, root: Path | None,
                         overrides: dict[str, dict[str, str]]) -> tuple[str, str]:
        setting_key = cls.setting_key(spec)
        root_key = str(root.resolve()) if root is not None else ""
        project_command = str(overrides.get(root_key, {}).get(setting_key, "")).strip() if root_key else ""
        if project_command:
            return project_command, "project override"
        default_command = str(overrides.get(cls.DEFAULT_OVERRIDE_SCOPE, {}).get(setting_key, "")).strip()
        return (default_command, "default override") if default_command else ("", "")

    @classmethod
    def _resolve_candidate(cls, spec: LanguageServerSpec, candidate: tuple[str, ...], root: Path | None,
                           source: str) -> ResolvedLanguageServer | None:
        if not candidate:
            return None
        executable = cls._resolve_executable(candidate[0], root)
        if executable is None:
            return None
        command = (executable, *candidate[1:])
        if cls.setting_key(spec) == cls.TYPESCRIPT_KEY:
            package_root = cls._typescript_package_for_executable(Path(executable))
            version = cls._typescript_package_version(package_root) if package_root is not None else ""
            if cls._major_version(version) >= 7 and "--lsp" in command:
                return ResolvedLanguageServer(spec, "TypeScript 7 Language Server", command, source, version)
            return ResolvedLanguageServer(spec, spec.name, command, source, version or cls._legacy_typescript_version(root))
        return ResolvedLanguageServer(spec, spec.name, command, source)

    @classmethod
    def _resolve_native_typescript(cls, root: Path | None) -> ResolvedLanguageServer | None:
        spec = cls.spec_for_setting_key(cls.TYPESCRIPT_KEY)
        if spec is None:
            return None
        if root is not None:
            project_package = root / "node_modules" / "typescript"
            project_version = cls._typescript_package_version(project_package)
            if project_version:
                if cls._major_version(project_version) < 7:
                    return None
                project_executable = cls._typescript_package_executable(project_package)
                if project_executable is None:
                    return None
                return ResolvedLanguageServer(spec, "TypeScript 7 Language Server",
                                              (str(project_executable), "--lsp", "--stdio"),
                                              "project TypeScript", project_version)
        global_tsc = cls._resolve_executable("tsc", root)
        global_package = cls._typescript_package_for_executable(Path(global_tsc)) if global_tsc else None
        if global_package is not None:
            version = cls._typescript_package_version(global_package)
            executable = cls._typescript_package_executable(global_package)
            if cls._major_version(version) >= 7 and executable is not None:
                return ResolvedLanguageServer(spec, "TypeScript 7 Language Server",
                                              (str(executable), "--lsp", "--stdio"), "global TypeScript", version)
        return None

    @classmethod
    def _legacy_typescript_version(cls, root: Path | None) -> str:
        if root is not None:
            project_version = cls._typescript_package_version(root / "node_modules" / "typescript")
            if project_version and cls._major_version(project_version) <= 6:
                return project_version
        global_tsc = cls._resolve_executable("tsc", root)
        global_package = cls._typescript_package_for_executable(Path(global_tsc)) if global_tsc else None
        return cls._typescript_package_version(global_package) if global_package is not None else ""

    @staticmethod
    def _typescript_package_version(package_root: Path) -> str:
        try:
            payload = json.loads((package_root / "package.json").read_text())
        except (FileNotFoundError, PermissionError, OSError, UnicodeDecodeError, json.JSONDecodeError):
            return ""
        version = payload.get("version", "") if isinstance(payload, dict) else ""
        return str(version).strip()

    @staticmethod
    def _major_version(version: str) -> int:
        head = version.split(".", 1)[0]
        return int(head) if head.isdigit() else 0

    @classmethod
    def _typescript_package_for_executable(cls, executable: Path) -> Path | None:
        resolved = executable.resolve()
        for parent in (resolved.parent, *resolved.parents):
            if parent.name == "typescript" and cls._typescript_package_version(parent):
                return parent
        return None

    @classmethod
    def _typescript_package_executable(cls, package_root: Path) -> Path | None:
        for candidate in (package_root / "bin" / "tsc", package_root.parent / ".bin" / "tsc"):
            if candidate.is_file() and os.access(candidate, os.X_OK):
                return candidate.resolve()
        return None

    @staticmethod
    def _resolve_executable(program: str, root: Path | None = None) -> str | None:
        path = Path(program).expanduser()
        if path.is_absolute():
            return str(path) if path.is_file() and os.access(path, os.X_OK) else None
        if root is not None and len(path.parts) > 1:
            project_candidate = (root / path).resolve()
            return str(project_candidate) if project_candidate.is_file() and os.access(project_candidate, os.X_OK) else None
        on_path = shutil.which(program)
        if on_path:
            return on_path
        for directory in PlatformPaths.FALLBACK_BIN_DIRS:
            candidate = Path(directory) / program
            if candidate.is_file() and os.access(candidate, os.X_OK):
                return str(candidate)
        return None

    @classmethod
    def installation_options(cls, spec: LanguageServerSpec) -> list[dict[str, str]]:
        if cls.setting_key(spec) == cls.TYPESCRIPT_KEY:
            return [
                {"label": "TypeScript 7 native", "command": "npm install -g typescript@7"},
                {"label": "TypeScript 6 legacy", "command": "npm install -g typescript@6 typescript-language-server"},
            ]
        return [{"label": f"Install {spec.name}", "command": spec.install_hint}]

    @classmethod
    def status(cls, root: Path | None = None,
               overrides: dict[str, dict[str, str]] | None = None) -> list[dict[str, object]]:
        statuses: list[dict[str, object]] = []
        configured_overrides = overrides or {}
        for spec in cls.SPECS:
            setting_key = cls.setting_key(spec)
            resolved = cls.resolve(spec.languages[0], root, configured_overrides)
            effective_override, override_source = cls.command_override(spec, root, configured_overrides)
            scope_key = str(root.resolve()) if root is not None else cls.DEFAULT_OVERRIDE_SCOPE
            scoped_override = str(configured_overrides.get(scope_key, {}).get(setting_key, "")).strip()
            statuses.append({"key": setting_key, "name": resolved.name if resolved else spec.name,
                             "languages": list(spec.languages), "available": resolved is not None,
                             "command": list(resolved.command) if resolved else [],
                             "command_text": shlex.join(resolved.command) if resolved else "",
                             "source": resolved.source if resolved else override_source or "not installed",
                             "version": resolved.version if resolved else "", "override": scoped_override,
                             "effective_override": effective_override,
                             "environment_variable": spec.environment_variable, "install_hint": spec.install_hint,
                             "install_options": cls.installation_options(spec)})
        return statuses

    @classmethod
    def installation_status(cls, language: str, root: Path | None = None,
                            overrides: dict[str, dict[str, str]] | None = None) -> dict[str, object] | None:
        spec = cls.spec_for_language(language)
        if spec is None:
            return None
        resolved = cls.resolve(language, root, overrides or {})
        options = cls.installation_options(spec)
        return {"language": language, "server": resolved.name if resolved else spec.name,
                "install_hint": options[0]["command"], "install_options": options}


class LanguageServerManager:
    def __init__(self, files: ProjectFileService, workspace_edits: LspWorkspaceEditService,
                 command_overrides_provider: Callable[[], dict[str, dict[str, str]]] | None = None,
                 enabled_provider: Callable[[], bool] | None = None,
                 read_only_provider: Callable[[], bool] | None = None) -> None:
        self._files = files
        self._workspace_edits = workspace_edits
        self._command_overrides_provider = command_overrides_provider or (lambda: {})
        self._enabled_provider = enabled_provider or (lambda: True)
        self._read_only_provider = read_only_provider or (lambda: False)
        self._connections: dict[tuple[str, str], LanguageServerConnection] = {}
        self._document_clients: dict[tuple[LanguageServerConnection, str], int] = {}
        self._lock = asyncio.Lock()

    def command_overrides(self) -> dict[str, dict[str, str]]:
        return self._command_overrides_provider()

    def enabled(self) -> bool:
        return self._enabled_provider()

    async def open_document(self, root: str, path: str, language: str, text: str) -> tuple[LanguageServerConnection, str]:
        if not self.enabled():
            raise LanguageServerUnavailableError("language servers are disabled in settings")
        root_path = self._files.resolve_confined(root, "")
        document_path = self._files.resolve_confined(root, path)
        if not document_path.is_relative_to(root_path):
            raise ValueError(f"language server document is outside project root: {document_path}")
        overrides = self.command_overrides()
        resolved = LanguageServerRegistry.resolve(language, root_path, overrides)
        if resolved is None:
            spec = LanguageServerRegistry.spec_for_language(language)
            if spec is None:
                raise LanguageServerUnavailableError(f"no language server is configured for {language}")
            override, _source = LanguageServerRegistry.command_override(spec, root_path, overrides)
            if override:
                raise LanguageServerUnavailableError(f"configured {spec.name} command is unavailable: {override}")
            raise LanguageServerUnavailableError(f"{spec.name} is not installed; {spec.install_hint}")
        key = (str(root_path), LanguageServerRegistry.setting_key(resolved.spec))
        async with self._lock:
            connection = self._connections.get(key)
            if connection is not None and (not connection.running() or connection.command != resolved.command):
                self._discard_document_clients(connection)
                if connection.running():
                    await connection.stop()
                self._connections.pop(key, None)
                connection = None
            if connection is None:
                connection = LanguageServerConnection(root_path, resolved.command, resolved.name, self._apply_workspace_edit)
                await connection.start()
                self._connections[key] = connection
        uri = document_path.as_uri()
        await connection.open_document(uri, language, text)
        document_key = (connection, uri)
        self._document_clients[document_key] = self._document_clients.get(document_key, 0) + 1
        return connection, uri

    async def _apply_workspace_edit(self, root: Path, workspace_edit: dict[str, object]) -> dict[str, object]:
        if self._read_only_provider():
            return {"applied": False, "failureReason": "TermDeck is running in read-only mode", "changed": []}
        try:
            changed = self._workspace_edits.apply(str(root), workspace_edit)
            return {"applied": True, "changed": changed}
        except (ValueError, FileNotFoundError, IsADirectoryError, PermissionError, OSError, UnicodeDecodeError) as edit_error:
            return {"applied": False, "failureReason": str(edit_error), "changed": []}

    def _discard_document_clients(self, connection: LanguageServerConnection) -> None:
        stale = [document_key for document_key in self._document_clients if document_key[0] is connection]
        for document_key in stale:
            self._document_clients.pop(document_key, None)

    async def close_document(self, connection: LanguageServerConnection, uri: str) -> None:
        document_key = (connection, uri)
        client_count = self._document_clients.get(document_key, 0)
        if client_count > 1:
            self._document_clients[document_key] = client_count - 1
            return
        self._document_clients.pop(document_key, None)
        if connection.running():
            await connection.close_document(uri)

    async def reload(self, root: str = "") -> None:
        resolved_root = str(self._files.resolve_confined(root, "")) if root else ""
        async with self._lock:
            selected = [(key, connection) for key, connection in self._connections.items()
                        if not resolved_root or key[0] == resolved_root]
            for key, connection in selected:
                self._connections.pop(key, None)
                self._discard_document_clients(connection)
        for _key, connection in selected:
            if connection.running():
                await connection.stop()

    async def shutdown(self) -> None:
        connections, self._connections = tuple(self._connections.values()), {}
        self._document_clients.clear()
        for connection in connections:
            await connection.stop()

    def status(self, root: str = "") -> dict[str, object]:
        root_path = self._files.resolve_confined(root, "") if root else None
        active = [{"root": connection_root, "key": setting_key, "server": connection.server_name,
                   "running": connection.running(), "command": list(connection.command)}
                  for (connection_root, setting_key), connection in self._connections.items()]
        return {"root": str(root_path) if root_path else "", "enabled": self.enabled(),
                "servers": LanguageServerRegistry.status(root_path, self.command_overrides()), "active": active,
                "overrides": self.command_overrides()}

    def installation_status(self, language: str, root: str = "") -> dict[str, object] | None:
        root_path = self._files.resolve_confined(root, "") if root else None
        return LanguageServerRegistry.installation_status(language, root_path, self.command_overrides())
