import asyncio
from types import TracebackType
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from termdeck.agents.base import AgentCli
    from termdeck.session_manager import ManagedSession, TerminalSessionManager


class PreservedTerminalComposer:
    def __init__(self, manager: "TerminalSessionManager", session: "ManagedSession", agent: "AgentCli") -> None:
        self.manager = manager
        self.session = session
        self.agent = agent
        self.held_draft = ""

    async def __aenter__(self) -> "PreservedTerminalComposer":
        session = self.session
        if session.prompt_submit_lock is None:
            session.prompt_submit_lock = asyncio.Lock()
        await session.prompt_submit_lock.acquire()
        entered = False
        try:
            blocked = self.agent.prompt_blocked_by(session) or await self.manager._leave_escapable_mode(session, self.agent)
            if blocked:
                raise RuntimeError(blocked)
            self.held_draft = session.record.draft
            session.prompt_going_in = True
            entered = True
            return self
        finally:
            if not entered:
                session.prompt_submit_lock.release()

    async def __aexit__(self, exception_type: type[BaseException] | None, exception: BaseException | None,
                        traceback: TracebackType | None) -> None:
        session = self.session
        try:
            if self.held_draft:
                if exception_type is None:
                    self.manager._put_back_held_draft(session, self.held_draft)
                else:
                    self.manager._draft_history_service().record_snapshot(
                        "/drafts", f"{session.record.session_id}.md", self.held_draft, "automatic-command")
        finally:
            session.prompt_going_in = False
            held, session.held_user_input = session.held_user_input, []
            try:
                for text in held:
                    self.manager.write_input(session.record.session_id, text)
            finally:
                session.prompt_submit_lock.release()
