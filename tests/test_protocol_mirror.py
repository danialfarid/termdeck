import re
import unittest
from pathlib import Path

from termdeck.models import ApiFields, WsMessageFields


class ProtocolMirrorTest(unittest.TestCase):
    """The ws/API field names in models.py are mirrored by static/app.js.

    There is no shared constants file between the two sides, so a rename on the Python side
    silently breaks the client. This tripwire fails when a protocol value declared on the
    server no longer appears anywhere in app.js — as a quoted string, a `.field` property
    access, or an object-literal key.
    """

    # Server-side values the client deliberately does not reference.
    ALLOWED_UNMIRRORED = {
        # Keepalive on the file-tree websocket; the client ignores unknown types by design.
        "file_tree_ping",
        # The codex in-TUI queue-edit surface (server.py QUEUE_EDIT handler and its
        # QUEUE_MUTATION responses) currently has NO client: app.js queues markdown prompts
        # itself (md_prompt_queues + dispatchNextMarkdownPrompt) and never sends queue_edit.
        # Kept until the surface grows a client UI or is removed.
        "queue_edit",
        "queue_mutation",
    }

    @classmethod
    def setUpClass(cls) -> None:
        static = Path(__file__).resolve().parent.parent / "termdeck" / "static"
        cls.app_js = "\n".join(path.read_text() for path in sorted(static.glob("app*.js")))

    def _mirrored(self, value: str) -> bool:
        if f'"{value}"' in self.app_js or f"'{value}'" in self.app_js:
            return True
        return re.search(rf"[.{{,\s]{re.escape(value)}\b", self.app_js) is not None

    def _assert_mirrored(self, owner: type) -> None:
        missing = []
        for name in dir(owner):
            if name.startswith("_"):
                continue
            value = getattr(owner, name)
            if not isinstance(value, str) or value in self.ALLOWED_UNMIRRORED:
                continue
            if not self._mirrored(value):
                missing.append(f"{owner.__name__}.{name} = {value!r}")
        self.assertEqual(missing, [], f"protocol values not found in app.js: {missing}")

    def test_ws_message_fields_appear_in_app_js(self) -> None:
        self._assert_mirrored(WsMessageFields)

    def test_api_fields_appear_in_app_js(self) -> None:
        self._assert_mirrored(ApiFields)

    def test_allowlist_matches_reality(self) -> None:
        """Entries here must stay genuinely unmirrored; prune when a client appears."""
        for value in self.ALLOWED_UNMIRRORED:
            self.assertFalse(self._mirrored(value),
                             f"{value!r} is now referenced by app.js; remove it from ALLOWED_UNMIRRORED")
