"""Dependency probes must not block session creation.

`collect_reports` shells out to a `--version` probe per program (~0.5s total), and it runs on
the session-create request path. Blocking the event loop that long starves the pty pump: a
freshly spawned codex asks the terminal for its colors in its first output burst and only waits
about a second for the answer before permanently painting its composer without the panel
background. These tests pin the cache that keeps the request path fast.
"""

import asyncio
import time
import unittest
from unittest.mock import patch

from termdeck.environment_check import DependencyReport, EnvironmentCheck


def _report(program: str, present: bool = True) -> DependencyReport:
    return DependencyReport(program=program, resolved_path=f"/bin/{program}", is_present=present,
                            is_required=False, used_for="test", install_hint="")


class CollectReportsCacheTest(unittest.TestCase):
    def setUp(self) -> None:
        self._cache = EnvironmentCheck._REPORTS_CACHE
        self._monotonic = EnvironmentCheck._REPORTS_CACHE_MONOTONIC
        self._in_flight = EnvironmentCheck._REPORT_REFRESH_IN_FLIGHT
        EnvironmentCheck._REPORTS_CACHE = None
        EnvironmentCheck._REPORT_REFRESH_IN_FLIGHT = False

    def tearDown(self) -> None:
        EnvironmentCheck._REPORTS_CACHE = self._cache
        EnvironmentCheck._REPORTS_CACHE_MONOTONIC = self._monotonic
        EnvironmentCheck._REPORT_REFRESH_IN_FLIGHT = self._in_flight

    def test_second_call_serves_cache_without_probing(self) -> None:
        with patch.object(EnvironmentCheck, "program_is_usable", return_value=True) as usable:
            EnvironmentCheck.collect_reports()
            first_calls = usable.call_count
            self.assertGreater(first_calls, 0)
            EnvironmentCheck.collect_reports()
            self.assertEqual(usable.call_count, first_calls)

    def test_force_refresh_probes_again(self) -> None:
        with patch.object(EnvironmentCheck, "program_is_usable", return_value=True) as usable:
            EnvironmentCheck.collect_reports()
            first_calls = usable.call_count
            EnvironmentCheck.collect_reports(force_refresh=True)
            self.assertGreater(usable.call_count, first_calls)

    def test_stale_missing_verdict_reprobes_before_refusing(self) -> None:
        with patch.object(EnvironmentCheck, "program_is_usable", return_value=False):
            EnvironmentCheck.collect_reports()
        with patch.object(EnvironmentCheck, "program_is_usable", return_value=True) as usable:
            # codex was installed after the cache called it missing: the miss must be
            # re-probed, not trusted from the stale cache.
            self.assertIsNone(EnvironmentCheck.missing_model_dependency("codex"))
            self.assertGreater(usable.call_count, 0)

    def test_confirmed_missing_is_reported(self) -> None:
        with patch.object(EnvironmentCheck, "program_is_usable", return_value=False):
            missing = EnvironmentCheck.missing_model_dependency("codex")
            self.assertIsNotNone(missing)
            assert missing is not None
            self.assertEqual(missing.program, "codex")

    def test_present_verdict_does_not_reprobe(self) -> None:
        with patch.object(EnvironmentCheck, "program_is_usable", return_value=True):
            EnvironmentCheck.collect_reports()
        with patch.object(EnvironmentCheck, "program_is_usable",
                          side_effect=AssertionError("must not probe")):
            self.assertIsNone(EnvironmentCheck.missing_model_dependency("codex"))


class StaleCacheRefreshTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self._cache = EnvironmentCheck._REPORTS_CACHE
        self._monotonic = EnvironmentCheck._REPORTS_CACHE_MONOTONIC
        self._in_flight = EnvironmentCheck._REPORT_REFRESH_IN_FLIGHT

    def tearDown(self) -> None:
        EnvironmentCheck._REPORTS_CACHE = self._cache
        EnvironmentCheck._REPORTS_CACHE_MONOTONIC = self._monotonic
        EnvironmentCheck._REPORT_REFRESH_IN_FLIGHT = self._in_flight

    async def test_stale_cache_serves_immediately_and_refreshes_behind(self) -> None:
        stale = [_report("codex", present=False)]
        EnvironmentCheck._REPORTS_CACHE = stale
        # Not 0.0: monotonic counts from boot, and a CI machine up for less than the TTL found 0.0 fresh.
        EnvironmentCheck._REPORTS_CACHE_MONOTONIC = time.monotonic() - EnvironmentCheck.REPORT_CACHE_TTL_SECONDS - 1
        EnvironmentCheck._REPORT_REFRESH_IN_FLIGHT = False
        fresh = [_report("codex", present=True)]

        with patch.object(EnvironmentCheck, "_collect_reports_uncached",
                          return_value=fresh) as probe:
            served = EnvironmentCheck.collect_reports()
            self.assertEqual(served, stale)
            for _ in range(200):
                if EnvironmentCheck._REPORTS_CACHE is fresh:
                    break
                await asyncio.sleep(0.01)
            self.assertIs(EnvironmentCheck._REPORTS_CACHE, fresh)
            probe.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
