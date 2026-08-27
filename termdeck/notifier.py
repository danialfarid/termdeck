import asyncio
import json
import time

from termdeck.platform_paths import PlatformPaths


class AgentNotifier:
    """Fires OS user notifications on agent state transitions.

    Two events, both edge-triggered and deduplicated per session: the agent starts requiring
    the user's attention (a permission prompt), and a long-enough run of processing ends. The
    preferences live in UiSettings (notify_attention, default on; notify_agent_idle, default
    off) and are loaded only when a transition actually fires, so the hot status path costs
    two boolean comparisons.

    macOS only for now: notifications go through `osascript -e 'display notification'`.
    Elsewhere every call is a no-op.
    """

    MIN_PROCESSING_SECONDS_FOR_IDLE_NOTICE = 5.0

    def __init__(self, load_preferences) -> None:
        self._load_preferences = load_preferences

    def observe_status(self, ms, processing: bool, display_title: str, watched: bool = False) -> None:
        attention = bool(ms.attention_required)
        if attention != ms.notified_attention:
            ms.notified_attention = attention
            if attention and ms.running and not watched and self._enabled("notify_attention", True):
                self._fire(display_title, "needs your attention")
        if processing and not ms.notified_processing:
            ms.notified_processing_since = time.monotonic()
        if not processing and ms.notified_processing:
            ran_for = time.monotonic() - ms.notified_processing_since
            if ran_for >= self.MIN_PROCESSING_SECONDS_FOR_IDLE_NOTICE and not watched and \
                    self._enabled("notify_agent_idle", True):
                self._fire(display_title, "finished")
        ms.notified_processing = processing

    def _enabled(self, name: str, default: bool) -> bool:
        try:
            value = self._load_preferences().get(name, default)
        except Exception:
            return default
        return bool(value)

    def _fire(self, title: str, message: str) -> None:
        if not PlatformPaths.IS_MACOS:
            return
        script = f"display notification {json.dumps(message)} with title {json.dumps('TermDeck')} " \
                 f"subtitle {json.dumps(title or 'terminal')}"
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        loop.create_task(self._run_osascript(script))

    @staticmethod
    async def _run_osascript(script: str) -> None:
        try:
            process = await asyncio.create_subprocess_exec(
                "osascript", "-e", script,
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
            await asyncio.wait_for(process.wait(), timeout=10)
        except (OSError, asyncio.TimeoutError):
            pass
