import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

from termdeck.config import TermdeckConfig

# Deliberately not termdeck/watchdog.py: the third-party `watchdog` package (filesystem observers) is
# imported by file_service, transcript_service and claude_activity_watcher, and a same-named module in
# this package would shadow it.


class ServiceWatchdog:
    """Restarts the deck when it is running but no longer answering.

    The failure this exists for is not a crash -- a crashed server is what KeepAlive/Restart=always
    already handle. It is the wedged server: the process is alive, the port is still bound and accepting
    connections, and nothing ever comes back. To the service manager that job looks perfectly healthy, so
    it sits wedged until a person notices. Asking over HTTP is the only check that tells the two apart.

    Each tick runs as its own short-lived process (launchd StartInterval, systemd timer), so the state
    that spans ticks -- how many probes in a row have failed -- lives in a small JSON file rather than in
    memory. That also means a tick that hangs costs one interval and is replaced by the next one.
    """

    HEALTHY = "healthy"
    UNANSWERED = "unanswered"
    RESTARTED = "restarted"
    COOLING_DOWN = "cooling-down"
    NOT_INSTALLED = "not-installed"
    # Reached when the deck is unreachable AND the watchdog cannot persist what it is doing. It stops
    # short of restarting and says so on every tick, rather than failing silently in either direction.
    STATE_UNWRITABLE = "state-unwritable"

    def __init__(self, installer=None, state_file: Path | None = None, log_file: Path | None = None,
                 now=time.time) -> None:
        from termdeck.service_installer import ServiceInstaller

        self._installer = installer if installer is not None else ServiceInstaller
        self._state_file = state_file if state_file is not None else TermdeckConfig.WATCHDOG_STATE_FILE
        self._log_file = log_file if log_file is not None else TermdeckConfig.WATCHDOG_LOG_FILE
        self._now = now

    # -- probe -------------------------------------------------------------

    @staticmethod
    def health_url() -> str:
        # A server bound to every interface is still reachable on the loopback, and the loopback is the
        # only address the watchdog can count on being its own deck.
        host = TermdeckConfig.HOST
        if host in ("0.0.0.0", "::", ""):
            host = "127.0.0.1"
        if ":" in host and not host.startswith("["):
            host = f"[{host}]"
        return f"http://{host}:{TermdeckConfig.PORT}{TermdeckConfig.API_HEALTH_ROUTE}"

    @classmethod
    def probe(cls, url: str | None = None, timeout: float | None = None) -> bool:
        """Whether the server answered at all.

        Any HTTP status counts as alive, including 401 and 404. What is being tested is whether the event
        loop still turns, and an access-token deck or an older build that has no health route answers
        both of those questions the same way a 200 does. Only a timeout, a refused connection or a
        half-open socket that never replies mean the deck is not serving.
        """
        request = urllib.request.Request(url or cls.health_url(), method="GET",
                                         headers={"User-Agent": "termdeck-watchdog"})
        try:
            with urllib.request.urlopen(
                    request, timeout=timeout if timeout is not None else TermdeckConfig.WATCHDOG_PROBE_TIMEOUT_SECONDS):
                return True
        except urllib.error.HTTPError:
            return True
        except (urllib.error.URLError, OSError, ValueError):
            return False

    # -- cross-tick state --------------------------------------------------

    def read_state(self) -> dict:
        try:
            state = json.loads(self._state_file.read_text())
        except (OSError, ValueError):
            return {}
        return state if isinstance(state, dict) else {}

    def _write_state(self, state: dict) -> bool:
        """Persist the state, reporting whether it actually landed.

        The return value is load-bearing. Every tick is a fresh process, so this file is the watchdog's
        only memory: how many probes have failed in a row, and when it last restarted anything. If the
        write fails and the caller carries on regardless, a state file already past the threshold with
        an expired cooldown makes every subsequent tick restart the deck -- the restart timestamp never
        persists, so the cooldown never starts. That is the crash loop this is all meant to prevent.
        """
        try:
            self._state_file.parent.mkdir(parents=True, exist_ok=True)
            temporary = self._state_file.with_name(f".{self._state_file.name}.{os.getpid()}.tmp")
            temporary.write_text(json.dumps(state, indent=2, sort_keys=True))
            temporary.replace(self._state_file)
            return True
        except OSError as write_error:
            self._log(f"state write failed: {write_error}")
            return False

    def _log(self, message: str) -> None:
        line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {message}"
        print(line, flush=True)
        try:
            self._log_file.parent.mkdir(parents=True, exist_ok=True)
            if self._log_file.exists() and self._log_file.stat().st_size > TermdeckConfig.WATCHDOG_LOG_MAX_BYTES:
                self._log_file.write_text(self._log_file.read_text()[-TermdeckConfig.WATCHDOG_LOG_MAX_BYTES // 2:])
            with self._log_file.open("a") as handle:
                handle.write(line + "\n")
        except OSError:
            pass

    # -- one tick ----------------------------------------------------------

    def tick(self) -> str:
        """Probe once and act. Returns the outcome, for the CLI to print and the tests to assert on."""
        state = self.read_state()
        now = self._now()

        # A deck the user stopped on purpose is not a deck that froze. Reviving it would make `service
        # stop` mean nothing, so an unloaded unit ends the tick before the probe.
        if not self._installer.is_loaded():
            self._write_state({**state, "consecutive_failures": 0, "last_status": self.NOT_INSTALLED,
                               "last_checked_at": now})
            return self.NOT_INSTALLED

        if self.probe():
            if state.get("consecutive_failures"):
                self._log(f"recovered after {state['consecutive_failures']} unanswered probe(s)")
            # Backoff resets on a run of healthy probes, not on elapsed time since the restart. Time
            # alone does not say the deck recovered: a server that binds, answers one probe and wedges
            # again would clear the backoff every cycle and restart at the base rate forever. A streak
            # is the thing "stayed healthy" actually means.
            streak = int(state.get("healthy_streak", 0)) + 1
            recovered = {**state, "consecutive_failures": 0, "healthy_streak": streak,
                         "last_status": self.HEALTHY, "last_checked_at": now, "last_healthy_at": now}
            if streak >= TermdeckConfig.WATCHDOG_FAILURE_THRESHOLD:
                recovered["restarts_since_healthy"] = 0
            self._write_state(recovered)
            return self.HEALTHY

        failures = int(state.get("consecutive_failures", 0)) + 1
        state = {**state, "consecutive_failures": failures, "healthy_streak": 0,
                 "last_status": self.UNANSWERED, "last_checked_at": now}
        if failures < TermdeckConfig.WATCHDOG_FAILURE_THRESHOLD:
            self._log(f"no answer from {self.health_url()} ({failures}/{TermdeckConfig.WATCHDOG_FAILURE_THRESHOLD})")
            if not self._write_state(state):
                # The count cannot carry to the next tick, so it will never reach the threshold and the
                # watchdog will never act. Saying so beats reporting an ordinary failed probe and
                # leaving someone to wonder why a wedged deck was never restarted.
                self._log("failure count cannot be persisted -- this deck will not be restarted until "
                          f"{self._state_file} is writable")
                return self.STATE_UNWRITABLE
            return self.UNANSWERED

        # A restart is not instant and the replacement is not reachable while it restores scrollback.
        # Without this the next tick would count that boot as another failure and bounce it again.
        since_restart = now - float(state.get("last_restart_at", 0.0) or 0.0)
        cooldown = self.current_cooldown(state)
        if since_restart < cooldown:
            self._log(f"no answer, but the restart {int(since_restart)}s ago has {int(cooldown - since_restart)}s "
                      f"of its {int(cooldown)}s cooldown left")
            self._write_state({**state, "last_status": self.COOLING_DOWN})
            return self.COOLING_DOWN

        ineffective = int(state.get("restarts_since_healthy", 0))
        self._log(f"no answer after {failures} probes -- restarting the deck"
                  + (f" (attempt {ineffective + 1} since it was last healthy)" if ineffective else ""))
        # The attempt is persisted BEFORE it is made, and the restart only happens if that write landed.
        # Two things depend on it. A restart command that fails -- launchctl refusing, the binary gone --
        # is still an attempt, and leaving the timestamp unset let the next tick retry immediately and
        # every tick after. And if the state file cannot be written at all, the cooldown cannot be
        # enforced across ticks, so restarting would loop unbounded; refusing is the safe direction,
        # because an unrestarted deck is a deck someone can still look at.
        state = {**state, "last_restart_at": now, "restarts_since_healthy": ineffective + 1,
                 "last_status": self.UNANSWERED}
        if not self._write_state(state):
            self._log("cannot record a restart attempt -- not restarting, as the cooldown that keeps "
                      "this from looping cannot be enforced without it")
            return self.STATE_UNWRITABLE
        try:
            outcome = self._installer.restart()
        except (RuntimeError, OSError) as restart_error:
            self._log(f"restart failed: {restart_error}")
            return self.UNANSWERED
        self._log(outcome)
        state = {**state, "consecutive_failures": 0, "last_status": self.RESTARTED,
                 "restarts": int(state.get("restarts", 0)) + 1}
        next_cooldown = self.current_cooldown(state)
        if next_cooldown > cooldown:
            self._log(f"next restart no sooner than {int(next_cooldown)}s from now")
        self._write_state(state)
        return self.RESTARTED

    @staticmethod
    def current_cooldown(state: dict) -> float:
        """How long to wait after the last restart before another one is allowed.

        Doubles per restart that has not yet produced a lastingly healthy deck, capped. A restart is the
        only tool this has, and when it is not the right tool -- a build that will not boot, a state file
        it dies on, a disk with nothing left on it -- backing off is what keeps the watchdog from killing
        the process every few minutes while someone is trying to get a look at it.
        """
        ineffective = max(0, int(state.get("restarts_since_healthy", 0)) - 1)
        cooldown = TermdeckConfig.WATCHDOG_RESTART_COOLDOWN_SECONDS * \
            TermdeckConfig.WATCHDOG_RESTART_BACKOFF_MULTIPLIER ** ineffective
        return min(cooldown, TermdeckConfig.WATCHDOG_RESTART_COOLDOWN_MAX_SECONDS)

    # -- reporting ---------------------------------------------------------

    def describe(self) -> str:
        state = self.read_state()
        if not state:
            return f"watchdog · no probe recorded yet · {self.health_url()}"
        checked = state.get("last_checked_at")
        parts = [f"watchdog · {state.get('last_status', 'unknown')}",
                 f"probing {self.health_url()} every {TermdeckConfig.WATCHDOG_INTERVAL_SECONDS}s"]
        if checked:
            parts.append(f"last probe {int(self._now() - float(checked))}s ago")
        if state.get("consecutive_failures"):
            parts.append(f"{state['consecutive_failures']} unanswered in a row")
        if state.get("restarts"):
            parts.append(f"{state['restarts']} restart(s) so far")
        if state.get("restarts_since_healthy"):
            parts.append(f"{state['restarts_since_healthy']} since last healthy "
                         f"· next no sooner than {int(self.current_cooldown(state))}s after the last")
        return " · ".join(parts)
