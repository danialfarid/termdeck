from pathlib import Path


class AgentInstructionService:
    GLOBAL_BLOCK_START = "<!-- termdeck-agent-api:start -->"
    GLOBAL_BLOCK_END = "<!-- termdeck-agent-api:end -->"
    INSTRUCTION_TEXT = Path(__file__).with_name("agent-api-instructions.md").read_text(encoding="utf-8")

    def __init__(self, instruction_file: Path) -> None:
        self.instruction_file = instruction_file

    def ensure_instruction_file(self) -> Path:
        self.instruction_file.parent.mkdir(parents=True, exist_ok=True)
        try:
            current = self.instruction_file.read_text(encoding="utf-8")
        except FileNotFoundError:
            current = ""
        if current != self.INSTRUCTION_TEXT:
            self.instruction_file.write_text(self.INSTRUCTION_TEXT, encoding="utf-8")
        return self.instruction_file

    def synchronize_global_instruction_files(self, enabled: bool,
                                             instruction_files: tuple[Path, ...] | None = None) -> None:
        for instruction_file in instruction_files or self._default_global_instruction_files():
            self._synchronize_global_instruction_file(instruction_file, enabled)

    def _synchronize_global_instruction_file(self, instruction_file: Path, enabled: bool) -> None:
        try:
            current = instruction_file.read_text(encoding="utf-8")
        except FileNotFoundError:
            current = ""
        cleaned = self._remove_global_instruction_block(current)
        updated = cleaned
        if enabled:
            block = f"{self.GLOBAL_BLOCK_START}\n{self.INSTRUCTION_TEXT.rstrip()}\n{self.GLOBAL_BLOCK_END}"
            updated = f"{cleaned.rstrip()}\n\n{block}\n" if cleaned.strip() else f"{block}\n"
            instruction_file.parent.mkdir(parents=True, exist_ok=True)
        if updated != current:
            instruction_file.write_text(updated, encoding="utf-8")

    def _remove_global_instruction_block(self, text: str) -> str:
        start = text.find(self.GLOBAL_BLOCK_START)
        if start < 0:
            return text
        end = text.find(self.GLOBAL_BLOCK_END, start)
        if end < 0:
            raise ValueError(f"incomplete TermDeck instruction block in {self.instruction_file}")
        end += len(self.GLOBAL_BLOCK_END)
        before = text[:start].rstrip()
        after = text[end:].lstrip()
        return "\n\n".join(part for part in (before, after) if part) + ("\n" if before or after else "")

    @staticmethod
    def _default_global_instruction_files() -> tuple[Path, ...]:
        return (Path.home() / ".gemini" / "GEMINI.md", Path.home() / ".config" / "opencode" / "AGENTS.md")
