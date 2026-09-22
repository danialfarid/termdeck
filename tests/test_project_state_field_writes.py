"""One action writes one field of the project state.

Everything the deck remembers about a project used to be written by one call that took the whole state,
so clearing the pins also wrote the notes, the copied text and the layout -- from whatever copy the
sending window happened to be holding. A window that had been open a while put its own stale copy back
over what another window had just saved. There is no whole-state write any more: every field has a call
of its own, and the lists that several windows add to have calls that write one entry.
"""

import asyncio
import tempfile
import unittest
from unittest.mock import MagicMock

from fastapi import HTTPException

from termdeck.server import (NotebookNote, ProjectUiState, SelectionCopy, StoredValueRequest, TermdeckServer,
                             UiSettings)


class Store:
    def __init__(self, state: ProjectUiState) -> None:
        self.payload = UiSettings(project_state={"stock": state}).model_dump()

    def load(self) -> dict[str, object]:
        return self.payload

    def save(self, payload: dict[str, object]) -> None:
        self.payload = payload


def server(state: ProjectUiState) -> TermdeckServer:
    instance = TermdeckServer.__new__(TermdeckServer)
    instance.settings_store = Store(state)
    instance.manager = MagicMock()
    instance.manager.list_sessions.return_value = []
    instance.notebook_history = None
    instance.data_directory = tempfile.mkdtemp()
    return instance


def write(instance: TermdeckServer, field: str, value: object) -> dict[str, object]:
    return asyncio.run(instance._put_project_state_field(StoredValueRequest(value=value), field_name=field,
                                                         project="stock", worktree_id="root"))


def saved(instance: TermdeckServer) -> dict[str, object]:
    return instance.settings_store.payload["project_state"]["stock"]


def populated() -> ProjectUiState:
    return ProjectUiState(notebook_notes=[NotebookNote(note_id="note-1", text="what was typed", revision=3)],
                          notebook_active_note_id="note-1", notebook_notes_initialized=True,
                          selection_copy_history=[SelectionCopy(text="copied", copied_at_ms=7)],
                          terminal_layout=["session:abc"], session_order=["abc"],
                          session_groups={"abc": "group-1"}, pinned_sessions=["abc"],
                          color="#101010")


class OneFieldPerWriteTest(unittest.TestCase):
    def test_clearing_the_pins_writes_only_the_pins(self) -> None:
        instance = server(populated())

        write(instance, "pinned_sessions", [])
        state = saved(instance)

        self.assertEqual(state["pinned_sessions"], [])
        self.assertEqual([note["text"] for note in state["notebook_notes"]], ["what was typed"])
        self.assertEqual([copy["text"] for copy in state["selection_copy_history"]], ["copied"])
        self.assertEqual(state["terminal_layout"], ["session:abc"])
        self.assertEqual(state["session_groups"], {"abc": "group-1"})
        self.assertEqual(state["color"], "#101010")

    def test_the_rest_of_the_project_state_is_left_exactly_as_it_was(self) -> None:
        instance = server(populated())
        before = {field: value for field, value in saved(instance).items() if field != "pinned_sessions"}

        write(instance, "pinned_sessions", [])
        after = {field: value for field, value in saved(instance).items() if field != "pinned_sessions"}

        self.assertEqual(after, before)

    def test_a_value_the_field_cannot_hold_is_refused_and_changes_nothing(self) -> None:
        instance = server(populated())

        with self.assertRaises(HTTPException) as raised:
            write(instance, "pinned_sessions", {"not": "a list"})

        self.assertEqual(raised.exception.status_code, 422)
        self.assertEqual(saved(instance)["pinned_sessions"], ["abc"])

    def test_an_unknown_field_is_refused(self) -> None:
        instance = server(populated())

        with self.assertRaises(HTTPException) as raised:
            write(instance, "invented_field", "x")

        self.assertEqual(raised.exception.status_code, 404)


class SharedListsHaveCallsOfTheirOwnTest(unittest.TestCase):
    """The fields several windows add to are the ones a whole-list write destroys."""

    def test_every_shared_list_is_refused_by_the_field_call(self) -> None:
        for field in sorted(TermdeckServer.WRITE_THROUGH_TARGETED_API):
            instance = server(populated())
            with self.assertRaises(HTTPException) as raised:
                write(instance, field, [])

            self.assertEqual(raised.exception.status_code, 409, field)
            self.assertIn(field, raised.exception.detail)

    def test_they_can_still_be_read(self) -> None:
        instance = server(populated())

        field = asyncio.run(instance._get_project_state_field(field_name="notebook_notes", project="stock",
                                                              worktree_id="root"))

        self.assertEqual([note.note_id for note in field["value"]], ["note-1"])

    def test_every_other_field_of_the_state_can_be_written(self) -> None:
        # The two sets together are the whole state: nothing is left without a way to save it.
        writable = set(ProjectUiState.model_fields) - TermdeckServer.WRITE_THROUGH_TARGETED_API
        instance = server(populated())

        for field in sorted(writable):
            write(instance, field, ProjectUiState().model_dump()[field])

        self.assertEqual(saved(instance)["color"], "")


class NoWholeStateWriteTest(unittest.TestCase):
    def test_the_layout_call_no_longer_takes_a_whole_state(self) -> None:
        # It reads; writing through it is what carried every other field along for the ride.
        self.assertFalse(hasattr(TermdeckServer, "_patch_terminal_layout"))
        self.assertTrue(hasattr(TermdeckServer, "_get_terminal_layout"))


if __name__ == "__main__":
    unittest.main()
