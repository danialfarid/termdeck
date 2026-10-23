import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from termdeck.codex_capacity_retry import CapacityRetryBackoff, CodexCapacityRetry


class CodexCapacityRetryTest(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / 'rollout.jsonl'
        self.error = {'type': 'task_complete', 'turn_id': 'turn1', 'error': {
            'message': CodexCapacityRetry.CAPACITY_MESSAGE, 'codex_error_info': 'server_overloaded'}}

    def write_events(self, *events: dict[str, object]) -> None:
        self.path.write_text(''.join(json.dumps({'type': 'event_msg', 'payload': event}) + '\n' for event in events))

    def test_capacity_retries_but_usage_limit_does_not(self) -> None:
        self.write_events(self.error)
        self.assertEqual(CodexCapacityRetry.read_candidate(self.path).command, 'go')
        self.write_events({'type': 'task_complete', 'error': {'message': 'Usage limit reached',
                                                           'codex_error_info': 'usage_limit'}})
        self.assertIsNone(CodexCapacityRetry.read_candidate(self.path))

    def test_only_structured_error_not_quoted_text(self) -> None:
        self.write_events({'type': 'agent_message', 'message': CodexCapacityRetry.CAPACITY_MESSAGE})
        self.assertIsNone(CodexCapacityRetry.read_candidate(self.path))

    def test_later_turn_or_user_action_cancels_retry(self) -> None:
        for event in ({'type': 'task_started'}, {'type': 'user_message'}, {'type': 'turn_aborted'},
                      {'type': 'task_complete'}, {'type': 'thread_goal_updated', 'goal': {'status': 'paused'}}):
            self.write_events(self.error, event)
            self.assertIsNone(CodexCapacityRetry.read_candidate(self.path))

    def test_active_goal_resumed_but_paused_goal_left_alone(self) -> None:
        self.write_events({'type': 'thread_goal_updated', 'goal': {'status': 'active'}}, self.error)
        self.assertEqual(CodexCapacityRetry.read_candidate(self.path).command, '/goal resume')
        self.write_events({'type': 'thread_goal_updated', 'goal': {'status': 'paused'}}, self.error)
        self.assertIsNone(CodexCapacityRetry.read_candidate(self.path))

    def test_partial_record_not_used(self) -> None:
        self.write_events(self.error)
        with self.path.open('a') as stream:
            stream.write('{"type":')
        self.assertIsNone(CodexCapacityRetry.read_candidate(self.path))

    def test_retry_once_per_error_and_never_start_a_terminal(self) -> None:
        self.write_events(self.error)
        session = SimpleNamespace(record=SimpleNamespace(agent_kind='codex', agent_session_id='agent',
                                 session_id='session', cwd='/', draft=''), running=True, attention_required=False,
                                 prompt_going_in=False, last_typing_monotonic=0, last_agent_submit_monotonic=0,
                                 last_output_monotonic=0, prompt_submit_lock=None)
        manager = Mock()
        manager._sessions = {'session': session}
        manager._ui_setting.return_value = True
        manager._processing_state.return_value = False
        manager._submit_prompt_now = AsyncMock()
        retry = CodexCapacityRetry(manager)
        with patch('termdeck.codex_capacity_retry.agents.agent_cli') as agent:
            agent.return_value.transcript_path.return_value = self.path
            asyncio.run(retry.retry_session(session))
            retry.backoffs['session'].retry_at = 0
            asyncio.run(retry.retry_session(session))
            asyncio.run(retry.retry_session(session))
            manager._submit_prompt_now.assert_awaited_once_with(session, 'go', False, False, None)
            session.running = False
            self.assertFalse(retry.eligible(session))
            manager.ensure_session_running.assert_not_called()

    def test_disabled_processing_draft_and_attention_prevent_retry(self) -> None:
        session = SimpleNamespace(record=SimpleNamespace(agent_kind='codex', agent_session_id='agent', draft=''),
                                  running=True, attention_required=False, prompt_going_in=False,
                                  last_typing_monotonic=0, last_agent_submit_monotonic=0, last_output_monotonic=0)
        manager = Mock()
        manager._ui_setting.return_value = False
        retry = CodexCapacityRetry(manager)
        self.assertFalse(retry.eligible(session))
        manager._ui_setting.return_value = True
        manager._processing_state.return_value = True
        self.assertFalse(retry.eligible(session))
        manager._processing_state.return_value = False
        session.record.draft = 'typing'
        self.assertFalse(retry.eligible(session))
        session.record.draft = ''
        session.attention_required = True
        self.assertFalse(retry.eligible(session))

    def test_backoff_doubles_and_caps_at_two_days(self) -> None:
        self.assertEqual([CodexCapacityRetry.retry_delay(n) for n in range(4)], [180, 360, 720, 1440])
        self.assertEqual(CodexCapacityRetry.retry_delay(9), 92160)
        self.assertEqual(CodexCapacityRetry.retry_delay(10), 172800)
        self.assertEqual(CodexCapacityRetry.retry_delay(1000), 172800)

    def test_progress_requires_fifteen_continuous_minutes(self) -> None:
        manager = Mock()
        manager._ui_setting.return_value = True
        manager._processing_state.return_value = True
        session = SimpleNamespace(record=SimpleNamespace(session_id='session'), running=True, attention_required=False)
        retry = CodexCapacityRetry(manager)
        state = CapacityRetryBackoff(attempts=10, last_error_id='previous')
        retry.backoffs['session'] = state
        for now in range(0, 900, 15):
            retry.observe_progress(session, now)
        self.assertEqual(state.attempts, 10)
        retry.observe_progress(session, 900)
        self.assertEqual(state.attempts, 0)
        self.assertEqual(state.last_error_id, 'previous')

    def test_idle_attention_or_missing_observations_do_not_reset_backoff(self) -> None:
        manager = Mock()
        manager._ui_setting.return_value = True
        manager._processing_state.return_value = True
        session = SimpleNamespace(record=SimpleNamespace(session_id='session'), running=True, attention_required=False)
        retry = CodexCapacityRetry(manager)
        state = CapacityRetryBackoff(attempts=10)
        retry.backoffs['session'] = state
        retry.observe_progress(session, 0)
        retry.observe_progress(session, 1000)
        self.assertEqual(state.attempts, 10)
        manager._processing_state.return_value = False
        retry.observe_progress(session, 1015)
        self.assertIsNone(state.progressing_since)
        manager._processing_state.return_value = True
        retry.observe_progress(session, 1030)
        session.attention_required = True
        retry.observe_progress(session, 1045)
        self.assertIsNone(state.progressing_since)
        self.assertEqual(state.attempts, 10)

    def test_two_quiet_checks_park_session_until_new_output(self) -> None:
        self.write_events({'type': 'agent_message', 'message': 'ordinary output'})
        session = SimpleNamespace(record=SimpleNamespace(agent_kind='codex', agent_session_id='agent',
                                 session_id='session', cwd='/', draft=''), running=True, attention_required=False,
                                 prompt_going_in=False, last_typing_monotonic=0, last_agent_submit_monotonic=0,
                                 last_output_monotonic=100, prompt_submit_lock=None)
        manager = Mock()
        manager._sessions = {'session': session}
        manager._ui_setting.return_value = True
        manager._processing_state.return_value = False
        retry = CodexCapacityRetry(manager)
        with patch('termdeck.codex_capacity_retry.agents.agent_cli') as agent, \
                patch.object(CodexCapacityRetry, 'read_candidate', wraps=CodexCapacityRetry.read_candidate) as read, \
                patch('termdeck.codex_capacity_retry.time.monotonic', return_value=1000):
            agent.return_value.transcript_path.return_value = self.path
            asyncio.run(retry.retry_session(session))
            asyncio.run(retry.retry_session(session))
            self.assertTrue(retry.watches['session'].parked)
            asyncio.run(retry.retry_session(session))
            self.assertEqual(read.call_count, 1)
            self.write_events(self.error)
            session.last_output_monotonic = 101
            asyncio.run(retry.retry_session(session))
            self.assertFalse(retry.watches['session'].parked)
            self.assertEqual(read.call_count, 2)
            self.assertEqual(retry.backoffs['session'].pending_error_id, 'turn1')

    def test_each_new_failure_retries_after_increasing_delay(self) -> None:
        session = SimpleNamespace(record=SimpleNamespace(agent_kind='codex', agent_session_id='agent',
                                 session_id='session', cwd='/', draft=''), running=True, attention_required=False,
                                 prompt_going_in=False, last_typing_monotonic=0, last_agent_submit_monotonic=0,
                                 last_output_monotonic=0, prompt_submit_lock=None)
        manager = Mock()
        manager._sessions = {'session': session}
        manager._ui_setting.return_value = True
        manager._processing_state.return_value = False
        manager._submit_prompt_now = AsyncMock()
        retry = CodexCapacityRetry(manager)
        with patch('termdeck.codex_capacity_retry.agents.agent_cli') as agent:
            agent.return_value.transcript_path.return_value = self.path
            for number in range(10):
                self.write_events(dict(self.error, turn_id=f'turn{number}'))
                asyncio.run(retry.retry_session(session))
                state = retry.backoffs['session']
                self.assertEqual(state.attempts, number)
                asyncio.run(retry.retry_session(session))
                self.assertEqual(manager._submit_prompt_now.await_count, number)
                state.retry_at = 0
                asyncio.run(retry.retry_session(session))
                self.assertEqual(manager._submit_prompt_now.await_count, number + 1)
