"""A web address printed in a terminal opens in the browser, not as a file named after its host.

The path pattern matched "/cisco.wd5.myworkdayjobs.com" inside "https://cisco.wd5.myworkdayjobs.com/...",
so clicking the link opened that as a file. Codex also breaks a long URL itself and indents the rest,
which the terminal does not mark as a wrapped row, so the link stopped at the break.
"""

import json
import os
import re
import shutil
import subprocess
import unittest
from pathlib import Path

from tests.test_terminal_cycle_order import method_source

STATIC = Path(__file__).resolve().parent.parent / "termdeck" / "static"

HARNESS = """
const scenario = JSON.parse(process.env.TERMDECK_WEB_LINK_SCENARIO);
__CONSTANTS__
const app = {
  activateTerminalFileLink: () => {},
  openTerminalHyperlink: (url) => { opened.push(url); },
  __METHODS__
};
const opened = [];
const lines = scenario.lines.map((text) => ({ isWrapped: false, translateToString: () => text.replace(/\\s+$/, "") }));
const term = { cols: scenario.cols, buffer: { active: { length: lines.length, getLine: (i) => lines[i] } } };
let found = [];
app.providePathLinks(term, "s", scenario.row + 1, (links) => { found = links || []; });
for (const link of found) if (link.text.startsWith("http")) link.activate();
process.stdout.write(JSON.stringify({
  links: found.map((link) => ({ text: link.text, start: link.range.start.x, end: link.range.end.x })),
  opened,
}));
"""

LONG_URL = "https://cisco.wd5.myworkdayjobs.com/Cisco_Careers/job/San-Jose-California-US/Senior-Software-Engineer--Remote-_2023799"


def constant(source: str, name: str) -> str:
    return re.search(rf"^const {name} = .*?;$", source, re.M | re.S).group(0)


class TerminalWebLinkTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        app = (STATIC / "app.js").read_text()
        url_ranges = re.search(r"^function webUrlRanges\(text\) \{.*?^\}", app, re.M | re.S).group(0)
        constants = "\n".join([constant(app, "PATH_LINK_RE"), constant(app, "WEB_URL_RE"), url_ranges,
                               constant(app, "KNOWN_EXTS")])
        ui = (STATIC / "app_settings_ui.js").read_text()
        methods = "\n  ".join(method_source(ui, signature) for signature in (
            "terminalPathBoundaryContinues(leftText, rightText)",
            "terminalUrlContinuesAt(buffer, cols, index, depth = 0)",
            "terminalUrlLinks(buffer, cols, segments, targetIndex, bufferLineNumber)",
            "providePathLinks(term, sessionId, bufferLineNumber, callback)",
        ))
        cls.harness = HARNESS.replace("__CONSTANTS__", constants).replace("__METHODS__", methods)

    def links(self, lines: list[str], row: int, cols: int = 80) -> dict:
        scenario = {"lines": lines, "row": row, "cols": cols}
        done = subprocess.run([self.node, "-e", self.harness], capture_output=True, text=True, check=False,
                              env={**os.environ, "TERMDECK_WEB_LINK_SCENARIO": json.dumps(scenario)})
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def test_a_url_on_one_row_opens_in_the_browser(self) -> None:
        found = self.links(["  Link: https://example.com/jobs/board.html, apply soon"], 0)
        self.assertEqual(found["opened"], ["https://example.com/jobs/board.html"])
        self.assertEqual([link["text"] for link in found["links"]], ["https://example.com/jobs/board.html"])

    def test_a_url_broken_by_codex_opens_whole_from_either_row(self) -> None:
        head = "  Link: " + LONG_URL[:96]
        rows = [head, "  " + LONG_URL[96:], "", "  Posted: Sep 24"]
        cols = len(head) + 2
        for row in (0, 1):
            found = self.links(rows, row, cols)
            self.assertEqual(found["opened"], [LONG_URL], row)
            self.assertEqual(len(found["links"]), 1, row)
        self.assertEqual(self.links(rows, 1, cols)["links"][0]["start"], 3)

    def test_a_short_url_does_not_take_the_next_row(self) -> None:
        found = self.links(["see https://example.com/a", "  next"], 0, 80)
        self.assertEqual(found["opened"], ["https://example.com/a"])

    def test_a_plain_file_path_still_links_as_a_file(self) -> None:
        found = self.links(["edited trainer/prep/feat_cache.py:12 and docs/api.md"], 0)
        self.assertEqual([link["text"] for link in found["links"]], ["trainer/prep/feat_cache.py:12", "docs/api.md"])
        self.assertEqual(found["opened"], [])


class TranscriptSkipsUrlsTest(unittest.TestCase):
    def test_the_transcript_file_linker_leaves_web_addresses_alone(self) -> None:
        source = (STATIC / "app_markdown_files.js").read_text()
        linker = method_source(source, "linkHistoryFileReferences(container, { skipCode = false } = {})")
        self.assertIn("webUrlRanges(source)", linker)


if __name__ == "__main__":
    unittest.main()
