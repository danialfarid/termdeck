from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, TypeAlias
from urllib.parse import unquote, urlsplit

from termdeck.file_history_service import FileHistoryService
from termdeck.file_service import ProjectFileService


JsonObject: TypeAlias = dict[str, Any]


@dataclass(frozen=True)
class PlannedFileEdit:
    relative_path: str
    current_content: str
    updated_content: str


class LspWorkspaceEditService:
    def __init__(self, files: ProjectFileService, history: FileHistoryService) -> None:
        self._files = files
        self._history = history

    def apply(self, root: str, workspace_edit: JsonObject) -> list[dict[str, str | int]]:
        edits_by_uri = self._collect_text_edits(workspace_edit)
        plans = [self._plan_file_edit(root, uri, edits) for uri, edits in edits_by_uri.items()]
        results: list[dict[str, str | int]] = []
        for plan in plans:
            self._history.observe_file(root, plan.relative_path, plan.current_content)
            write_result = self._files.write_file(root, plan.relative_path, plan.updated_content)
            self._history.record_snapshot(root, plan.relative_path, plan.updated_content, "lsp")
            results.append({"path": plan.relative_path, "bytes": int(write_result["size"])})
        return results

    def _collect_text_edits(self, workspace_edit: JsonObject) -> dict[str, list[JsonObject]]:
        edits_by_uri: dict[str, list[JsonObject]] = {}
        changes = workspace_edit.get("changes", {})
        if changes is not None and not isinstance(changes, dict):
            raise ValueError("language server workspace edit has invalid changes")
        for uri, edits in changes.items():
            edits_by_uri.setdefault(str(uri), []).extend(self._validated_edits(edits))
        document_changes = workspace_edit.get("documentChanges", [])
        if document_changes is not None and not isinstance(document_changes, list):
            raise ValueError("language server workspace edit has invalid documentChanges")
        for document_change in document_changes:
            if not isinstance(document_change, dict) or "textDocument" not in document_change:
                raise ValueError("file create, rename, and delete operations are not supported in language-server edits")
            text_document = document_change["textDocument"]
            if not isinstance(text_document, dict) or not isinstance(text_document.get("uri"), str):
                raise ValueError("language server text document edit has no URI")
            edits_by_uri.setdefault(text_document["uri"], []).extend(self._validated_edits(document_change.get("edits")))
        return edits_by_uri

    @staticmethod
    def _validated_edits(edits: object) -> list[JsonObject]:
        if not isinstance(edits, list):
            raise ValueError("language server text edits must be a list")
        if not all(isinstance(edit, dict) and isinstance(edit.get("range"), dict) and
                   isinstance(edit.get("newText"), str) for edit in edits):
            raise ValueError("language server returned an invalid text edit")
        return edits

    def _plan_file_edit(self, root: str, uri: str, edits: list[JsonObject]) -> PlannedFileEdit:
        root_path = self._files.resolve_confined(root, "")
        absolute_path = self._file_uri_path(uri)
        if not absolute_path.is_relative_to(root_path):
            raise ValueError(f"language server edit is outside project root: {absolute_path}")
        relative_path = absolute_path.relative_to(root_path).as_posix()
        file_data = self._files.read_file(root, relative_path)
        current_content = str(file_data["content"])
        replacements: list[tuple[int, int, str]] = []
        for edit in edits:
            range_value = edit["range"]
            start = self._position_offset(current_content, range_value.get("start"))
            end = self._position_offset(current_content, range_value.get("end"))
            if end < start:
                raise ValueError("language server edit range ends before it starts")
            replacements.append((start, end, edit["newText"]))
        replacements.sort(key=lambda item: (item[0], item[1]))
        for previous, current in zip(replacements, replacements[1:], strict=False):
            if current[0] < previous[1]:
                raise ValueError(f"language server returned overlapping edits for {relative_path}")
        updated_content = current_content
        for start, end, new_text in reversed(replacements):
            updated_content = updated_content[:start] + new_text + updated_content[end:]
        return PlannedFileEdit(relative_path, current_content, updated_content)

    @staticmethod
    def _file_uri_path(uri: str) -> Path:
        parsed = urlsplit(uri)
        if parsed.scheme != "file" or parsed.netloc not in {"", "localhost"}:
            raise ValueError(f"unsupported language server URI: {uri}")
        return Path(unquote(parsed.path)).resolve()

    @classmethod
    def _position_offset(cls, text: str, position: object) -> int:
        if not isinstance(position, dict) or not isinstance(position.get("line"), int) or not isinstance(position.get("character"), int):
            raise ValueError("language server edit has an invalid position")
        line_number = position["line"]
        character = position["character"]
        if line_number < 0 or character < 0:
            raise ValueError("language server edit position cannot be negative")
        lines = text.splitlines(keepends=True)
        if not lines:
            lines = [""]
        if line_number == len(lines) and text.endswith(("\n", "\r")) and character == 0:
            return len(text)
        if line_number >= len(lines):
            raise ValueError("language server edit line exceeds the file")
        line = lines[line_number]
        line_content = line.rstrip("\r\n")
        return sum(len(value) for value in lines[:line_number]) + cls._utf16_character_offset(line_content, character)

    @staticmethod
    def _utf16_character_offset(text: str, character: int) -> int:
        utf16_units = 0
        for index, value in enumerate(text):
            if utf16_units == character:
                return index
            next_units = utf16_units + len(value.encode("utf-16-le")) // 2
            if next_units > character:
                raise ValueError("language server edit splits a UTF-16 surrogate pair")
            utf16_units = next_units
        if utf16_units == character:
            return len(text)
        raise ValueError("language server edit character exceeds the line")
