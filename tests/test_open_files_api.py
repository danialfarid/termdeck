"""The open files belong to the project, and every window opens and closes its own.

A window wrote the whole list back, so two decks open on the same project talked over each other: the
files one had opened were closed again by the next save in the other, and a reload came back missing
them. One call opens one file, one closes one, and nothing else in the list is touched.
"""

import asyncio
import unittest
from unittest.mock import MagicMock

from fastapi import HTTPException

from termdeck.server import (OpenFileRequest, ProjectUiState, StoredValueRequest, TermdeckServer,
                             UiSettings)


class Store:
    def __init__(self, payload: dict[str, object]) -> None:
        self.payload = payload

    def load(self) -> dict[str, object]:
        return self.payload

    def save(self, payload: dict[str, object]) -> None:
        self.payload = payload


def server(open_files: list[dict[str, str]] | None = None, payload: dict[str, object] | None = None) -> TermdeckServer:
    instance = TermdeckServer.__new__(TermdeckServer)
    instance.settings_store = Store(payload or UiSettings(project_state={
        "stock": ProjectUiState(open_files=open_files or [])}).model_dump())
    instance.manager = MagicMock()
    instance.manager.list_sessions.return_value = []
    return instance


def opened(instance: TermdeckServer) -> list[tuple[str, str]]:
    return [(entry["root"], entry["path"])
            for entry in instance.settings_store.payload["project_state"]["stock"]["open_files"]]


def open_file(instance: TermdeckServer, path: str, root: str = "/repo", mtime: str = "1", status: str = "") -> None:
    asyncio.run(instance._open_project_file(OpenFileRequest(root=root, path=path, mtime=mtime, git_status=status),
                                            project="stock", worktree_id="root"))


def close_file(instance: TermdeckServer, path: str, root: str = "/repo") -> None:
    asyncio.run(instance._close_project_file(OpenFileRequest(root=root, path=path),
                                             project="stock", worktree_id="root"))


class OpenFilesApiTest(unittest.TestCase):
    def test_two_windows_keep_both_files(self) -> None:
        instance = server([{"root": "/repo", "path": "a.py", "mtime": "1", "git_status": ""}])

        open_file(instance, "b.py")
        open_file(instance, "c.py")

        self.assertEqual(opened(instance), [("/repo", "a.py"), ("/repo", "b.py"), ("/repo", "c.py")])

    def test_opening_a_file_again_updates_it_where_it_is(self) -> None:
        instance = server([{"root": "/repo", "path": "a.py", "mtime": "1", "git_status": ""},
                           {"root": "/repo", "path": "b.py", "mtime": "1", "git_status": ""}])

        open_file(instance, "a.py", mtime="9", status="M")
        files = instance.settings_store.payload["project_state"]["stock"]["open_files"]

        self.assertEqual(opened(instance), [("/repo", "a.py"), ("/repo", "b.py")])
        self.assertEqual(files[0]["mtime"], "9")
        self.assertEqual(files[0]["git_status"], "M")

    def test_closing_one_leaves_the_others(self) -> None:
        instance = server([{"root": "/repo", "path": "a.py", "mtime": "1", "git_status": ""},
                           {"root": "/repo", "path": "b.py", "mtime": "1", "git_status": ""}])

        close_file(instance, "a.py")

        self.assertEqual(opened(instance), [("/repo", "b.py")])

    def test_the_same_name_under_another_root_is_another_file(self) -> None:
        instance = server([{"root": "/repo", "path": "a.py", "mtime": "1", "git_status": ""},
                           {"root": "/other", "path": "a.py", "mtime": "1", "git_status": ""}])

        close_file(instance, "a.py", root="/repo")

        self.assertEqual(opened(instance), [("/other", "a.py")])

    def test_closing_a_file_that_is_not_open_says_so(self) -> None:
        instance = server([{"root": "/repo", "path": "a.py", "mtime": "1", "git_status": ""}])

        with self.assertRaises(HTTPException) as raised:
            close_file(instance, "gone.py")

        self.assertEqual(raised.exception.status_code, 404)
        self.assertEqual(opened(instance), [("/repo", "a.py")])

    def test_a_file_without_a_path_is_refused(self) -> None:
        instance = server([])

        with self.assertRaises(HTTPException) as raised:
            open_file(instance, "   ")

        self.assertEqual(raised.exception.status_code, 422)

    def test_the_whole_list_cannot_be_written_in_one_call(self) -> None:
        instance = server([{"root": "/repo", "path": "a.py", "mtime": "1", "git_status": ""}])

        with self.assertRaises(HTTPException) as raised:
            asyncio.run(instance._put_project_state_field(StoredValueRequest(value=[]), field_name="open_files",
                                                          project="stock", worktree_id="root"))

        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(opened(instance), [("/repo", "a.py")])

    def test_they_can_still_be_read(self) -> None:
        instance = server([{"root": "/repo", "path": "a.py", "mtime": "1", "git_status": ""}])

        listed = asyncio.run(instance._list_open_files(project="stock", worktree_id="root"))

        self.assertEqual([entry["path"] for entry in listed["open_files"]], ["a.py"])


class UpgradeKeepsWhatWasSavedTest(unittest.TestCase):
    """Settings written by an older version are read as they are: an upgrade loses nothing."""

    def test_files_saved_by_an_older_version_are_still_open(self) -> None:
        # The stored shape has not changed; only the calls that write it have.
        older = {"project_state": {"stock": {"open_files": [{"root": "/repo", "path": "a.py", "mtime": "3",
                                                             "git_status": "M"}],
                                             "notebook_text": "# notes", "selection_copy_history": ["copied once"]}}}
        instance = server(payload=UiSettings(**older).model_dump())

        listed = asyncio.run(instance._list_open_files(project="stock", worktree_id="root"))
        open_file(instance, "b.py")

        self.assertEqual([entry["path"] for entry in listed["open_files"]], ["a.py"])
        self.assertEqual(opened(instance), [("/repo", "a.py"), ("/repo", "b.py")])

    def test_the_older_notes_and_copies_beside_them_are_untouched(self) -> None:
        older = {"project_state": {"stock": {"open_files": [], "notebook_text": "# notes",
                                             "notebook_notes": [{"note_id": "note-1", "text": "kept"}],
                                             "selection_copy_history": [{"text": "copied once", "copied_at_ms": 4}]}}}
        instance = server(payload=UiSettings(**older).model_dump())

        open_file(instance, "b.py")
        state = instance.settings_store.payload["project_state"]["stock"]

        self.assertEqual(state["notebook_text"], "# notes")
        self.assertEqual([note["text"] for note in state["notebook_notes"]], ["kept"])
        self.assertEqual([copy["text"] for copy in state["selection_copy_history"]], ["copied once"])


if __name__ == "__main__":
    unittest.main()
