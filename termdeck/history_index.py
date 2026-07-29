import json
import hashlib
import queue
import re
import sqlite3
import threading
from pathlib import Path

from termdeck.config import TermdeckConfig
from termdeck.models import AgentKind


class HistorySearchIndex:
    _CODEX_UUID_RE = re.compile(r"-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$")
    _MAX_RESULTS = 300
    _MAX_CONTEXT_LINES = 15
    _INDEX_VERSION = 7
    _CHUNK_LINES = 32

    def __init__(self, database_path: Path) -> None:
        self._database_path = database_path
        self._pending_paths: queue.Queue[Path | None] = queue.Queue()
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._ready = False

    @property
    def indexing(self) -> bool:
        return not self._ready

    def start(self) -> None:
        if self._thread is not None:
            return
        self._initialize_database()
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, name="termdeck-history-index", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        thread, self._thread = self._thread, None
        if thread is None:
            return
        self._stop_event.set()
        self._pending_paths.put(None)
        thread.join(timeout=2)

    def notify_file_changed(self, path: Path) -> None:
        if path.suffix == ".jsonl":
            self._pending_paths.put(path)

    def search(self, query: str, include_operations: bool = False) -> list[dict[str, object]]:
        expression = self._fts_expression(query)
        if not expression:
            return []
        grouped: dict[str, dict[str, object]] = {}
        fts_table = "history_fts" if include_operations else "history_fts_conversation"
        try:
            with self._connect(0.5) as database:
                rows = database.execute(
                    "SELECT d.source_path, d.agent_kind, d.agent_session_id, d.cwd, d.title, d.line_no, d.line_end, "
                    "d.byte_start, d.byte_end "
                    f"FROM {fts_table} f JOIN history_documents d ON d.rowid = f.rowid "
                    f"WHERE {fts_table} MATCH ? LIMIT ?",
                    (expression, self._MAX_RESULTS),
                ).fetchall()
        except sqlite3.OperationalError as search_error:
            if "locked" in str(search_error).lower():
                return []
            raise
        parent_metadata: dict[str, tuple[str, str]] = {}
        parent_paths = {
            str(self._parent_source_path(Path(row[0])))
            for row in rows
            if self._parent_source_path(Path(row[0])) is not None
        }
        if parent_paths:
            placeholders = ",".join("?" for _ in parent_paths)
            try:
                with self._connect(0.5) as database:
                    parent_metadata = {
                        source_path: (str(title), str(cwd))
                        for source_path, title, cwd in database.execute(
                            f"SELECT source_path, title, cwd FROM history_sources WHERE source_path IN ({placeholders})",
                            tuple(parent_paths),
                        ).fetchall()
                    }
            except sqlite3.OperationalError as search_error:
                if "locked" not in str(search_error).lower():
                    raise
        chunk_cache: dict[tuple[str, int, int], list[dict[str, object]]] = {}
        for source_path, agent_kind, session_id, cwd, title, line_no, line_end, byte_start, byte_end in rows:
            source = Path(source_path)
            parent_session_id = self._parent_session_id_for_source(source)
            parent_source = self._parent_source_path(source)
            parent_title, parent_cwd = parent_metadata.get(str(parent_source), (None, None)) if parent_source else (None, None)
            result = grouped.setdefault(source_path, {"source_path": source_path, "agent_kind": agent_kind,
                "agent_session_id": session_id, "cwd": cwd, "title": title, "count": 0, "matches": [],
                "is_subagent": parent_session_id is not None,
                "parent_agent_session_id": parent_session_id, "parent_title": parent_title,
                "parent_cwd": parent_cwd})
            result["count"] = int(result["count"]) + 1
            result_matches = result["matches"]
            if isinstance(result_matches, list) and len(result_matches) < 6:
                cache_key = (source_path, int(byte_start), int(byte_end))
                if cache_key not in chunk_cache:
                    chunk_cache[cache_key] = self._matching_document_lines(
                        source, int(byte_start), int(byte_end), int(line_no), query, include_operations)
                for match in chunk_cache[cache_key]:
                    if len(result_matches) >= 6:
                        break
                    if any(existing.get("line_no") == match.get("line_no") for existing in result_matches):
                        continue
                    result_matches.append(match)
        return sorted(grouped.values(), key=lambda item: (-int(item["count"]), str(item["title"])))

    @staticmethod
    def _parent_session_id_for_source(path: Path) -> str | None:
        """Return the parent Claude session for a sidechain transcript, if this is one."""
        try:
            subagents_index = path.parts.index("subagents")
        except ValueError:
            return None
        if subagents_index == 0:
            return None
        return path.parts[subagents_index - 1] or None

    @classmethod
    def _parent_source_path(cls, path: Path) -> Path | None:
        parent_session_id = cls._parent_session_id_for_source(path)
        if not parent_session_id:
            return None
        return path.parents[2] / f"{parent_session_id}.jsonl"

    @classmethod
    def _matching_document_lines(cls, path: Path, byte_start: int, byte_end: int,
                                 line_start: int, query: str, include_operations: bool) -> list[dict[str, object]]:
        terms = [term.casefold() for term in re.findall(r"[\w]+", query, re.UNICODE)]
        if not terms:
            return []
        try:
            with path.open("rb") as source:
                source.seek(byte_start)
                raw_lines = source.read(max(0, byte_end - byte_start)).splitlines()
        except OSError:
            return []
        decoded: list[tuple[int, str]] = []
        for offset, raw in enumerate(raw_lines):
            text = cls._line_text(path, raw.decode(errors="replace"), conversation_only=not include_operations)
            text = re.sub(r"\s+", " ", text).strip()
            if text:
                decoded.append((line_start + offset, text))
        matching = [(line_no, text) for line_no, text in decoded
                    if all(term in text.casefold() for term in terms)]
        if not matching:
            matching = [(line_no, text) for line_no, text in decoded
                        if any(term in text.casefold() for term in terms)]
        return [{"line_no": line_no, "line_end": line_no, "text": text[:240]}
                for line_no, text in matching[:6]]

    def context(self, source_path: str, line_no: int, radius: int = 4, query: str = "",
                include_operations: bool = False) -> dict[str, object]:
        path = Path(source_path).resolve()
        self._validate_source_path(path)
        radius = max(1, min(radius, self._MAX_CONTEXT_LINES // 2))
        with self._connect() as database:
            metadata = database.execute(
                "SELECT agent_kind, agent_session_id, cwd, title FROM history_sources WHERE source_path = ?",
                (str(path),),
            ).fetchone()
            chunk = database.execute(
                "SELECT line_no, line_end, byte_start, byte_end FROM history_documents "
                "WHERE source_path = ? AND scope = ? AND line_no <= ? AND line_end >= ? LIMIT 1",
                (str(path), "all" if include_operations else "conversation", int(line_no), int(line_no)),
            ).fetchone()
        if metadata is None:
            raise FileNotFoundError(source_path)
        if chunk is None:
            raise FileNotFoundError(f"history line {line_no} is no longer indexed")
        with path.open("rb") as source:
            source.seek(int(chunk[2]))
            raw_lines = source.read(int(chunk[3]) - int(chunk[2])).splitlines()
        decoded_lines = [(int(chunk[0]) + index, self._line_text(
            path, raw.decode(errors="replace"), conversation_only=not include_operations))
                         for index, raw in enumerate(raw_lines)]
        terms = [term.lower() for term in re.findall(r"[\w]+", query, re.UNICODE)]
        target_index = next((index for index, (_, text) in enumerate(decoded_lines)
                             if text and terms and all(term in text.lower() for term in terms)), 0)
        start_index = max(0, target_index - radius)
        end_index = min(len(decoded_lines), target_index + radius + 1)
        records = [{"line_no": line, "text": text} for line, text in decoded_lines[start_index:end_index] if text]
        target_line = decoded_lines[target_index][0] if decoded_lines else int(line_no)
        return {"source_path": str(path), "agent_kind": metadata[0], "agent_session_id": metadata[1],
                "cwd": metadata[2], "title": metadata[3], "line_no": target_line, "lines": records}

    def _run(self) -> None:
        self._sync_all()
        self._ready = True
        while not self._stop_event.is_set():
            try:
                path = self._pending_paths.get(timeout=0.5)
            except queue.Empty:
                continue
            if path is None:
                continue
            self._sync_path(path)

    def _sync_all(self) -> None:
        for root in (TermdeckConfig.CODEX_SESSIONS_DIR, TermdeckConfig.CLAUDE_PROJECTS_DIR):
            if not root.is_dir():
                continue
            for path in root.rglob("*.jsonl"):
                if self._stop_event.is_set():
                    return
                self._sync_path(path)

    def _sync_path(self, path: Path) -> None:
        path = path.resolve()
        try:
            self._validate_source_path(path)
            stat = path.stat()
        except (FileNotFoundError, OSError, ValueError):
            return
        with self._connect() as database:
            known = database.execute(
                "SELECT size, mtime_ns, agent_kind, agent_session_id, cwd, title "
                "FROM history_sources WHERE source_path = ?",
                (str(path),),
            ).fetchone()
            if known is not None and int(known[0]) == stat.st_size and int(known[1]) == stat.st_mtime_ns:
                return

            # Session JSONL files are append-only. Re-reading a whole active
            # session on every filesystem event made the index compete with
            # the agent itself. Rebuild the final chunk and scan only bytes
            # appended after it. A shrink/replace falls back to a full scan.
            incremental = False
            start_byte = 0
            start_line = 1
            metadata = None
            if known is not None and stat.st_size > int(known[0]):
                tail = database.execute(
                    "SELECT line_no, MIN(byte_start) FROM history_documents "
                    "WHERE source_path = ? AND line_no = ("
                    "SELECT MAX(line_no) FROM history_documents WHERE source_path = ?) "
                    "GROUP BY line_no",
                    (str(path), str(path)),
                ).fetchone()
                if tail is not None:
                    incremental = True
                    start_line = int(tail[0])
                    start_byte = int(tail[1])
                    metadata = (str(known[2]), str(known[3]), str(known[4]), str(known[5]))

            agent_kind, session_id, cwd, title, documents = self._read_source(
                path, start_byte=start_byte, start_line=start_line, metadata=metadata,
            )
            if incremental:
                old_rows = database.execute(
                    "SELECT rowid FROM history_documents WHERE source_path = ? AND line_no >= ?",
                    (str(path), start_line),
                ).fetchall()
            else:
                old_rows = database.execute("SELECT rowid FROM history_documents WHERE source_path = ?", (str(path),)).fetchall()
            database.executemany("DELETE FROM history_fts WHERE rowid = ?", old_rows)
            database.executemany("DELETE FROM history_fts_conversation WHERE rowid = ?", old_rows)
            database.executemany("DELETE FROM history_documents WHERE rowid = ?", old_rows)
            database.execute("DELETE FROM history_sources WHERE source_path = ?", (str(path),))
            document_rows = [(self._document_id(path, line_no, scope), str(path), agent_kind, session_id, cwd, title, scope,
                              line_no, line_end, byte_start, byte_end)
                             for line_no, line_end, byte_start, byte_end, scope, _ in documents]
            database.executemany(
                "INSERT INTO history_documents(rowid, source_path, agent_kind, agent_session_id, cwd, title, scope, line_no, line_end, byte_start, byte_end) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", document_rows,
            )
            database.executemany(
                "INSERT INTO history_fts(rowid, text) VALUES (?, ?)",
                ((row[0], text) for row, (_, _, _, _, _, text) in zip(document_rows, documents)),
            )
            database.executemany(
                "INSERT INTO history_fts_conversation(rowid, text) VALUES (?, ?)",
                ((row[0], text) for row, (_, _, _, _, scope, text) in zip(document_rows, documents) if scope == "conversation"),
            )
            database.execute(
                "INSERT INTO history_sources(source_path, agent_kind, agent_session_id, cwd, title, size, mtime_ns) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)", (str(path), agent_kind, session_id, cwd, title, stat.st_size, stat.st_mtime_ns),
            )

    def _read_source(
        self,
        path: Path,
        *,
        start_byte: int = 0,
        start_line: int = 1,
        metadata: tuple[str, str, str, str] | None = None,
    ) -> tuple[str, str, str, str, list[tuple[int, int, int, int, str, str]]]:
        if metadata is None:
            agent_kind = AgentKind.CLAUDE.value if path.is_relative_to(TermdeckConfig.CLAUDE_PROJECTS_DIR.resolve()) else AgentKind.CODEX.value
            session_match = self._CODEX_UUID_RE.search(path.name)
            session_id = session_match.group(1) if session_match else path.stem
            cwd = ""
            title = ""
        else:
            agent_kind, session_id, cwd, title = metadata
        first_prompt = ""
        documents: list[tuple[int, int, int, int, str, str]] = []
        chunk: list[tuple[int, str]] = []
        chunk_scope = ""
        chunk_start_byte = start_byte
        chunk_end_byte = 0
        try:
            with path.open("rb") as source:
                source.seek(start_byte)
                for line_no, raw_line in enumerate(source, start_line):
                    line_start_byte = source.tell() - len(raw_line)
                    line_end_byte = source.tell()
                    try:
                        payload = json.loads(raw_line.decode(errors="replace"))
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(payload, dict):
                        continue
                    cwd = cwd or self._cwd_from_payload(agent_kind, path, payload)
                    title = self._title_from_payload(agent_kind, payload) or title
                    text = self._payload_text(agent_kind, payload)
                    if text:
                        scope = "conversation" if self._is_conversation_payload(agent_kind, payload) else "all"
                        scoped_text = self._conversation_payload_text(agent_kind, payload) if scope == "conversation" else text
                        if scope == "conversation" and not scoped_text:
                            scope = "all"
                            scoped_text = text
                        if not scoped_text:
                            continue
                        if not chunk or chunk_scope != scope:
                            if chunk:
                                documents.append((chunk[0][0], chunk[-1][0], chunk_start_byte, chunk_end_byte,
                                                  chunk_scope, "\n".join(item[1] for item in chunk)))
                            chunk = []
                            chunk_scope = scope
                        if not chunk:
                            chunk_start_byte = line_start_byte
                        chunk_end_byte = line_end_byte
                        chunk.append((line_no, scoped_text))
                        if len(chunk) >= self._CHUNK_LINES:
                            documents.append((chunk[0][0], chunk[-1][0], chunk_start_byte, chunk_end_byte,
                                               chunk_scope, "\n".join(item[1] for item in chunk)))
                            chunk = []
                        if not first_prompt and self._is_user_payload(agent_kind, payload) and not self._is_boilerplate(text):
                            first_prompt = text
        except OSError:
            return agent_kind, session_id, cwd, title, []
        if chunk:
            documents.append((chunk[0][0], chunk[-1][0], chunk_start_byte, chunk_end_byte,
                              chunk_scope, "\n".join(item[1] for item in chunk)))
        if not title or title.startswith(("<user_instructions>", "<INSTRUCTIONS>", "# AGENTS.md")):
            compact = re.sub(r"\s+", " ", first_prompt).strip()
            title = compact[:56].rstrip() + ("…" if len(compact) > 56 else "") if compact else f"{agent_kind} · {Path(cwd).name or 'session'}"
        return agent_kind, session_id, cwd, title, documents

    def _initialize_database(self) -> None:
        with self._connect() as database:
            version = int(database.execute("PRAGMA user_version").fetchone()[0])
            if version != self._INDEX_VERSION:
                database.execute("DROP TABLE IF EXISTS history_fts")
                database.execute("DROP TABLE IF EXISTS history_fts_conversation")
                database.execute("DROP TABLE IF EXISTS history_documents")
                database.execute("DROP TABLE IF EXISTS history_sources")
                database.execute(f"PRAGMA user_version = {self._INDEX_VERSION}")
                database.commit()
                database.execute("VACUUM")
            database.execute("CREATE TABLE IF NOT EXISTS history_sources (source_path TEXT PRIMARY KEY, agent_kind TEXT NOT NULL, agent_session_id TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL, size INTEGER NOT NULL, mtime_ns INTEGER NOT NULL)")
            database.execute("CREATE TABLE IF NOT EXISTS history_documents (rowid INTEGER PRIMARY KEY, source_path TEXT NOT NULL, agent_kind TEXT NOT NULL, agent_session_id TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL, scope TEXT NOT NULL, line_no INTEGER NOT NULL, line_end INTEGER NOT NULL, byte_start INTEGER NOT NULL, byte_end INTEGER NOT NULL)")
            database.execute("CREATE INDEX IF NOT EXISTS history_documents_source ON history_documents(source_path)")
            database.execute("CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(text, content='', contentless_delete=1, detail=none, tokenize='unicode61 remove_diacritics 2')")
            database.execute("CREATE VIRTUAL TABLE IF NOT EXISTS history_fts_conversation USING fts5(text, content='', contentless_delete=1, detail=none, tokenize='unicode61 remove_diacritics 2')")

    def _connect(self, timeout: float = 30) -> sqlite3.Connection:
        self._database_path.parent.mkdir(parents=True, exist_ok=True)
        database = sqlite3.connect(self._database_path, timeout=timeout)
        database.execute("PRAGMA journal_mode=WAL")
        database.execute("PRAGMA synchronous=NORMAL")
        return database

    @staticmethod
    def _document_id(path: Path, line_no: int, scope: str) -> int:
        digest = hashlib.blake2b(f"{path}:{line_no}:{scope}".encode(), digest_size=8).digest()
        return max(1, int.from_bytes(digest, "big") & 0x7FFFFFFFFFFFFFFF)

    @staticmethod
    def _fts_expression(query: str) -> str:
        terms = re.findall(r"[\w]+", query, re.UNICODE)
        return " AND ".join(f'"{term.replace(chr(34), chr(34) + chr(34))}"' for term in terms)

    @staticmethod
    def _validate_source_path(path: Path) -> None:
        roots = (TermdeckConfig.CODEX_SESSIONS_DIR.resolve(), TermdeckConfig.CLAUDE_PROJECTS_DIR.resolve())
        if not any(path.is_relative_to(root) for root in roots):
            raise ValueError("history source is outside the agent history directories")

    @staticmethod
    def _cwd_from_payload(agent_kind: str, path: Path, payload: dict[str, object]) -> str:
        if agent_kind == AgentKind.CODEX.value:
            body = payload.get("payload")
            return str(body.get("cwd", "")) if isinstance(body, dict) else ""
        return str(payload.get("cwd", ""))

    @staticmethod
    def _title_from_payload(agent_kind: str, payload: dict[str, object]) -> str:
        if agent_kind == AgentKind.CODEX.value:
            body = payload.get("payload")
            return str(body.get("thread_name", "")) if isinstance(body, dict) and body.get("type") == "thread_name_updated" else ""
        return str(payload.get("aiTitle", "")) if payload.get("type") == "ai-title" else ""

    @classmethod
    def _payload_text(cls, agent_kind: str, payload: dict[str, object]) -> str:
        if agent_kind == AgentKind.CODEX.value:
            body = payload.get("payload")
            if not isinstance(body, dict):
                return ""
            body_type = body.get("type")
            if body_type == "agent_message":
                return str(body.get("message", ""))
            if body_type == "user_message":
                return cls._content_text(body.get("message") or body.get("text"))
            if body_type == "message":
                return cls._content_text(body.get("content"))
            if body_type in ("custom_tool_call", "function_call"):
                return cls._content_text(body.get("input") or body.get("arguments"))
            if body_type in ("custom_tool_call_output", "function_call_output"):
                return cls._content_text(body.get("output") or body.get("result"))
            return ""
        if payload.get("type") in ("user", "assistant"):
            message = payload.get("message")
            return cls._content_text(message.get("content")) if isinstance(message, dict) else ""
        if payload.get("type") in ("tool_use", "tool_result"):
            return cls._content_text(payload.get("input") or payload.get("content"))
        return ""

    @classmethod
    def _conversation_payload_text(cls, agent_kind: str, payload: dict[str, object]) -> str:
        """Return only user/assistant prose, excluding tool and thinking blocks."""
        if agent_kind == AgentKind.CODEX.value:
            body = payload.get("payload")
            if not isinstance(body, dict):
                return ""
            body_type = body.get("type")
            if body_type == "agent_message":
                return cls._conversation_content_text(body.get("message"))
            if body_type == "user_message":
                return cls._conversation_content_text(body.get("message") or body.get("text"))
            if body_type == "message" and body.get("role") in ("user", "assistant"):
                return cls._conversation_content_text(body.get("content"))
            return ""
        if payload.get("type") in ("user", "assistant"):
            message = payload.get("message")
            return cls._conversation_content_text(message.get("content") if isinstance(message, dict) else message)
        return ""

    @staticmethod
    def _is_conversation_payload(agent_kind: str, payload: dict[str, object]) -> bool:
        if agent_kind == AgentKind.CODEX.value:
            body = payload.get("payload")
            if not isinstance(body, dict):
                return False
            body_type = body.get("type")
            return body_type in ("agent_message", "user_message") or (
                body_type == "message" and body.get("role") in ("user", "assistant")
            )
        return payload.get("type") in ("user", "assistant")

    @classmethod
    def _conversation_content_text(cls, value: object) -> str:
        if isinstance(value, str):
            return value.strip()
        if isinstance(value, list):
            parts: list[str] = []
            for item in value:
                if isinstance(item, dict) and item.get("type") in ("thinking", "tool_use", "tool_result"):
                    continue
                text = cls._conversation_content_text(item)
                if text:
                    parts.append(text)
            return "\n".join(parts)
        if isinstance(value, dict):
            item_type = value.get("type")
            if item_type in ("thinking", "tool_use", "tool_result"):
                return ""
            if item_type in ("text", "input_text", "output_text") and "text" in value:
                return cls._conversation_content_text(value["text"])
            for key in ("text", "content", "message"):
                if key in value:
                    text = cls._conversation_content_text(value[key])
                    if text:
                        return text
        return ""

    @classmethod
    def _line_text(cls, path: Path, raw_line: str, conversation_only: bool = False) -> str:
        try:
            payload = json.loads(raw_line)
        except json.JSONDecodeError:
            return raw_line.strip()
        if not isinstance(payload, dict):
            return ""
        agent_kind = AgentKind.CLAUDE.value if path.is_relative_to(TermdeckConfig.CLAUDE_PROJECTS_DIR.resolve()) else AgentKind.CODEX.value
        if conversation_only:
            return cls._conversation_payload_text(agent_kind, payload)
        return cls._payload_text(agent_kind, payload) or raw_line.strip()

    @classmethod
    def _content_text(cls, value: object) -> str:
        if isinstance(value, str):
            return value.strip()
        if isinstance(value, (int, float, bool)):
            return str(value)
        if isinstance(value, list):
            return "\n".join(text for item in value if (text := cls._content_text(item)))
        if isinstance(value, dict):
            for key in ("text", "content", "message", "input", "output", "result"):
                if key in value:
                    text = cls._content_text(value[key])
                    if text:
                        return text
            return json.dumps(value, ensure_ascii=False)
        return ""

    @staticmethod
    def _is_user_payload(agent_kind: str, payload: dict[str, object]) -> bool:
        if agent_kind == AgentKind.CODEX.value:
            body = payload.get("payload")
            return isinstance(body, dict) and (
                (body.get("type") == "message" and body.get("role") == "user") or body.get("type") == "user_message"
            )
        return payload.get("type") == "user"

    @staticmethod
    def _is_boilerplate(text: str) -> bool:
        head = text.lstrip()[:80]
        return head.startswith(("<user_instructions>", "<INSTRUCTIONS>", "# AGENTS.md", "<environment_context>"))
