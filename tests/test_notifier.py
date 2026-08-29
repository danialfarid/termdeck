import unittest
from types import SimpleNamespace
from unittest.mock import patch

from termdeck.notifier import AgentNotifier


def session(**overrides):
    fields = {"attention_required": False, "running": True, "notified_attention": False,
              "notified_processing": False, "notified_processing_since": 0.0}
    fields.update(overrides)
    return SimpleNamespace(**fields)


class AgentNotifierTest(unittest.TestCase):
    def _notifier(self, prefs):
        return AgentNotifier(lambda: prefs)

    def test_attention_fires_once_per_transition(self) -> None:
        notifier = self._notifier({"notify_attention": True})
        ms = session(attention_required=True)
        with patch.object(notifier, "_fire") as fire:
            notifier.observe_status(ms, False, "tab-1")
            notifier.observe_status(ms, False, "tab-1")
        fire.assert_called_once_with("tab-1", "needs your attention")

    def test_attention_refires_after_clearing(self) -> None:
        notifier = self._notifier({"notify_attention": True})
        ms = session(attention_required=True)
        with patch.object(notifier, "_fire") as fire:
            notifier.observe_status(ms, False, "tab-1")
            ms.attention_required = False
            notifier.observe_status(ms, False, "tab-1")
            ms.attention_required = True
            notifier.observe_status(ms, False, "tab-1")
        self.assertEqual(fire.call_count, 2)

    def test_attention_respects_preference(self) -> None:
        notifier = self._notifier({"notify_attention": False})
        ms = session(attention_required=True)
        with patch.object(notifier, "_fire") as fire:
            notifier.observe_status(ms, False, "tab-1")
        fire.assert_not_called()

    def test_idle_notice_requires_a_real_run_and_opt_in(self) -> None:
        notifier = self._notifier({"notify_agent_idle": True})
        ms = session()
        with patch.object(notifier, "_fire") as fire, patch("termdeck.notifier.time") as clock:
            clock.monotonic.return_value = 100.0
            notifier.observe_status(ms, True, "tab-1")
            clock.monotonic.return_value = 101.0   # too short
            notifier.observe_status(ms, False, "tab-1")
            fire.assert_not_called()
            clock.monotonic.return_value = 200.0
            notifier.observe_status(ms, True, "tab-1")
            clock.monotonic.return_value = 210.0   # long enough
            notifier.observe_status(ms, False, "tab-1")
        fire.assert_called_once_with("tab-1", "finished")

    def test_idle_notice_defaults_on_but_defers_to_a_watching_page(self) -> None:
        notifier = self._notifier({})
        ms = session()
        with patch.object(notifier, "_fire") as fire, patch("termdeck.notifier.time") as clock:
            clock.monotonic.return_value = 100.0
            notifier.observe_status(ms, True, "tab-1")
            clock.monotonic.return_value = 200.0
            notifier.observe_status(ms, False, "tab-1")
        fire.assert_called_once_with("tab-1", "finished")
        # A connected status websocket means a page is watching; the browser notifies instead.
        ms = session()
        with patch.object(notifier, "_fire") as fire, patch("termdeck.notifier.time") as clock:
            clock.monotonic.return_value = 100.0
            notifier.observe_status(ms, True, "tab-1", watched=True)
            clock.monotonic.return_value = 200.0
            notifier.observe_status(ms, False, "tab-1", watched=True)
        fire.assert_not_called()

    def test_broken_preferences_loader_falls_back_to_defaults(self) -> None:
        def explode():
            raise OSError("settings unreadable")
        notifier = AgentNotifier(explode)
        ms = session(attention_required=True)
        with patch.object(notifier, "_fire") as fire:
            notifier.observe_status(ms, False, "tab-1")
        fire.assert_called_once()
