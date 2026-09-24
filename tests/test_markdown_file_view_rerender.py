"""The reading view for a Markdown file keeps the reader's place.

The rendered document follows the file, so anything that rewrites it -- an autosave, an agent, a disk
refresh -- replaced the whole document. That sent the reader back to the top of the page and, worse,
back to the left of whatever wide table they were reading, every few seconds, even when the file had
been written with exactly the text it already had.

The three methods are lifted out of the shipped source and run under node against a stub document.
"""

import json
import os
import shutil
import subprocess
import unittest
from pathlib import Path

from tests.test_terminal_cycle_order import method_source

STATIC = Path(__file__).resolve().parent.parent / "termdeck" / "static"
METHODS = ("renderMarkdownFileView(entry)", "markdownFileViewInnerScroll(host)",
           "restoreMarkdownFileViewInnerScroll(host, within)")

HARNESS = """
const scenario = JSON.parse(process.env.TERMDECK_MARKDOWN_SCENARIO);
let renders = 0;

// Each table in the rendered document scrolls inside itself; the stub gives one back per table in the
// source, so a re-render produces fresh elements exactly as innerHTML does.
function makeHost() {
  return {
    dataset: { fileKey: "" },
    scrollTop: 0,
    classList: { contains: () => false },
    tables: [],
    set innerHTML(html) {
      renders += 1;
      this.tables = (html.match(/<table>/g) || []).map(() => ({ scrollLeft: 0, scrollTop: 0 }));
    },
    querySelectorAll() { return this.tables; },
  };
}

const host = makeHost();
const app = {
  markdownFileViewScroll: new Map(),
  markdownFileViewRendered: { key: "", source: null },
  $: () => host,
  renderMarkdown: (text) => text.split("\\n").map((line) => (line === "TABLE" ? "<table>" : line)).join(""),
  markLocalMarkdownImages() {},
  linkHistoryFileReferences() {},
  rememberMarkdownFileViewScroll() {
    if (host.dataset.fileKey) this.markdownFileViewScroll.set(host.dataset.fileKey, host.scrollTop);
  },
  __METHODS__
};

const entry = { root: "/w", path: "notes.md", model: { getValue: () => scenario.source } };
app.renderMarkdownFileView(entry);
host.scrollTop = scenario.scrollTop;
host.tables.forEach((table, index) => { table.scrollLeft = scenario.tableScroll[index] || 0; });
entry.model.getValue = () => scenario.nextSource;
app.renderMarkdownFileView(entry);

process.stdout.write(JSON.stringify({
  renders,
  scrollTop: host.scrollTop,
  tableScroll: host.tables.map((table) => table.scrollLeft),
}));
"""


class MarkdownFileViewRerenderTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        source = (STATIC / "app_markdown_files.js").read_text()
        cls.harness = HARNESS.replace("__METHODS__", "\n  ".join(method_source(source, name) for name in METHODS))

    def run_view(self, source: str, next_source: str, scroll_top: int = 0,
                 table_scroll: tuple[int, ...] = ()) -> dict:
        scenario = {"source": source, "nextSource": next_source, "scrollTop": scroll_top,
                    "tableScroll": list(table_scroll)}
        done = subprocess.run([self.node, "-e", self.harness], capture_output=True, text=True, check=False,
                              env={**os.environ, "TERMDECK_MARKDOWN_SCENARIO": json.dumps(scenario)})
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def test_a_file_rewritten_with_the_same_text_is_left_alone(self) -> None:
        # What the reader sees would not change, so nothing about where they are should either.
        result = self.run_view("a\nTABLE\nb", "a\nTABLE\nb", scroll_top=420, table_scroll=(300,))

        self.assertEqual(result["renders"], 1)
        self.assertEqual(result["scrollTop"], 420)
        self.assertEqual(result["tableScroll"], [300])

    def test_a_file_that_really_changed_is_rendered_again(self) -> None:
        result = self.run_view("a\nTABLE\nb", "a\nTABLE\nb\nmore")

        self.assertEqual(result["renders"], 2)

    def test_the_place_inside_a_wide_table_survives_a_change(self) -> None:
        # The document's own scrollTop is not the whole of where the reader was: a wide table scrolls
        # inside itself, and that is the position that was being thrown away every few seconds.
        result = self.run_view("TABLE\nTABLE", "TABLE\nTABLE\nedited", scroll_top=120, table_scroll=(260, 40))

        self.assertEqual(result["renders"], 2)
        self.assertEqual(result["scrollTop"], 120)
        self.assertEqual(result["tableScroll"], [260, 40])

    def test_a_change_that_adds_a_table_keeps_the_page_position(self) -> None:
        # The tables no longer line up with the ones that were measured, so only the page position can
        # be honoured -- guessing which new table is which old one would land the reader somewhere
        # nobody asked for.
        result = self.run_view("TABLE", "TABLE\nTABLE", scroll_top=90, table_scroll=(200,))

        self.assertEqual(result["scrollTop"], 90)
        self.assertEqual(result["tableScroll"], [0, 0])


if __name__ == "__main__":
    unittest.main()
