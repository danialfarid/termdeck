"""A file too big to load fully opens as an honest read-only preview.

The server only sends the first FILE_READ_MAX_BYTES of a huge file (the 81 MB agent export that
prompted this opens as a 2 MB slice). Three things had to be true of that slice and were not:

- saving it wrote the slice back over the whole file, destroying the tail;
- the Markdown reading view parsed the entire slice on the main thread (~7 s frozen);
- nothing on screen said the file was cut off, so the slice looked like the whole file.

The methods are lifted out of the shipped source and run under node against stubs.
"""

import json
import os
import shutil
import subprocess
import unittest
from pathlib import Path

from tests.test_terminal_cycle_order import method_source

STATIC = Path(__file__).resolve().parent.parent / "termdeck" / "static"

SAVE_HARNESS = """
const scenario = JSON.parse(process.env.TERMDECK_TRUNCATED_SCENARIO);
const MARKDOWN_FILE_VIEW_MAX_CHARS = 200000;
const calls = { fetch: 0, alerts: [] };
global.fetch = async () => ({ ok: true, json: async () => ({}) , _counted: (calls.fetch += 1) });
global.uiAlert = (message) => { calls.alerts.push(message); };
const app = {
  activeFileKey: null,
  fileHistoryOpen: false,
  lspClient: { didSave() {} },
  $: () => ({ textContent: "" }),
  persistOpenFiles() {},
  renderFileEditorChrome() {},
  async refreshOpenFileGitStatuses() {},
  scheduleActiveFileGitHunkRefresh() {},
  async loadFileHistory() {},
  enforceOpenFilesLimit() { return false; },
  __METHODS__
};
const entry = {
  root: "/tmp", path: "export.md", dirty: true, savePromise: null, autosaveTimer: 0,
  truncated: scenario.truncated,
  model: { getVersionId: () => 1, getValue: () => "slice" },
};
(async () => {
  const saved = await app.saveFileEntry(entry, scenario.manual);
  process.stdout.write(JSON.stringify({ saved, fetchCalls: calls.fetch, alerts: calls.alerts.length }));
})();
"""

VIEW_HARNESS = """
const scenario = JSON.parse(process.env.TERMDECK_TRUNCATED_SCENARIO);
const MARKDOWN_FILE_VIEW_MAX_CHARS = 200000;
let renders = 0;
let parsedChars = 0;
const banners = [];
const host = {
  dataset: { fileKey: "" },
  scrollTop: 0,
  classList: { contains: () => false },
  set innerHTML(html) { renders += 1; },
  prepend(element) { banners.push(element.textContent); },
  querySelectorAll() { return []; },
};
global.document = { createElement: () => ({ textContent: "", className: "" }) };
const app = {
  markdownFileViewScroll: new Map(),
  markdownFileViewRendered: { key: "", source: null },
  $: () => host,
  renderMarkdown: (text) => { parsedChars = text.length; return "<p>doc</p>"; },
  markLocalMarkdownImages() {},
  linkHistoryFileReferences() {},
  rememberMarkdownFileViewScroll() {},
  markdownFileViewInnerScroll() { return []; },
  restoreMarkdownFileViewInnerScroll() {},
  __METHODS__
};
const big = "x".repeat(scenario.chars);
const entry = { root: "/tmp", path: "export.md", model: { getValue: () => big } };
app.renderMarkdownFileView(entry);
app.renderMarkdownFileView(entry);
process.stdout.write(JSON.stringify({ renders, parsedChars, banners }));
"""

CRUMB_HARNESS = """
const scenario = JSON.parse(process.env.TERMDECK_TRUNCATED_SCENARIO);
const children = [];
const container = {
  textContent: "",
  title: "",
  classList: { toggle() {} },
  appendChild(element) { children.push({ tag: element.tag, className: element.className, text: element.textContent }); },
};
global.document = { createElement: (tag) => ({ tag, className: "", textContent: "", title: "", onclick: null }) };
const app = {
  activeFileKey: "/tmp|export.md",
  vscodeMode: false,
  openFiles: new Map([["/tmp|export.md", {
    root: "/tmp", path: "export.md", fullPath: "/private/tmp/export.md",
    truncated: scenario.truncated, size: scenario.size, shownBytes: scenario.shown,
  }]]),
  $: () => container,
  projectForCwd: () => null,
  __METHODS__
};
app.renderFileBreadcrumbs();
process.stdout.write(JSON.stringify({ children }));
"""

READONLY_HARNESS = """
const scenario = JSON.parse(process.env.TERMDECK_TRUNCATED_SCENARIO);
const updates = [];
const app = {
  editor: { updateOptions: (options) => updates.push(options) },
  __METHODS__
};
app.syncFileEditorReadOnly({ truncated: scenario.truncated });
process.stdout.write(JSON.stringify({ updates }));
"""


class TruncatedFilePreviewTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        settings_ui = (STATIC / "app_settings_ui.js").read_text()
        markdown_files = (STATIC / "app_markdown_files.js").read_text()
        byte_size = method_source(markdown_files, "formatByteSize(bytes)")
        cls.save_harness = SAVE_HARNESS.replace(
            "__METHODS__", "\n  ".join((method_source(settings_ui, "async saveFileEntry(entry, showFailureAlert)"),
                                        byte_size)))
        cls.view_harness = VIEW_HARNESS.replace(
            "__METHODS__", "\n  ".join((method_source(markdown_files, "renderMarkdownFileView(entry)"),
                                        byte_size)))
        cls.crumb_harness = CRUMB_HARNESS.replace(
            "__METHODS__", "\n  ".join((method_source(markdown_files, "renderFileBreadcrumbs()"),
                                        byte_size)))
        try:
            readonly_source = method_source(settings_ui, "syncFileEditorReadOnly(entry)")
        except ValueError:
            readonly_source = "syncFileEditorReadOnly(entry) {}"
        cls.readonly_harness = READONLY_HARNESS.replace("__METHODS__", readonly_source)

    def run_harness(self, harness: str, scenario: dict) -> dict:
        done = subprocess.run([self.node, "-e", harness], capture_output=True, text=True, check=False,
                              env={**os.environ, "TERMDECK_TRUNCATED_SCENARIO": json.dumps(scenario)})
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def test_a_truncated_file_is_never_written_back(self) -> None:
        # The model holds the first 2 MB of an 81 MB file; a write would amputate the rest.
        result = self.run_harness(self.save_harness, {"truncated": True, "manual": False})

        self.assertFalse(result["saved"])
        self.assertEqual(result["fetchCalls"], 0)

    def test_a_manual_save_of_a_truncated_file_says_why_it_refused(self) -> None:
        result = self.run_harness(self.save_harness, {"truncated": True, "manual": True})

        self.assertFalse(result["saved"])
        self.assertEqual(result["alerts"], 1)

    def test_a_whole_file_still_saves(self) -> None:
        result = self.run_harness(self.save_harness, {"truncated": False, "manual": False})

        self.assertTrue(result["saved"])
        self.assertEqual(result["fetchCalls"], 1)

    def test_the_reading_view_only_parses_a_bounded_prefix(self) -> None:
        # Parsing the whole 2 MB slice froze the page for ~7 s; the reader gets the first 200 kB.
        result = self.run_harness(self.view_harness, {"chars": 600000})

        self.assertLessEqual(result["parsedChars"], 200000)
        self.assertEqual(result["renders"], 2 - 1)  # the unchanged second render is still skipped
        self.assertEqual(len(result["banners"]), 1)
        self.assertIn("195.3 KB", result["banners"][0])
        self.assertIn("585.9 KB", result["banners"][0])

    def test_a_short_document_renders_whole_with_no_banner(self) -> None:
        result = self.run_harness(self.view_harness, {"chars": 5000})

        self.assertEqual(result["parsedChars"], 5000)
        self.assertEqual(result["banners"], [])

    def test_the_breadcrumbs_name_the_cut(self) -> None:
        result = self.run_harness(self.crumb_harness, {"truncated": True, "size": 85092782, "shown": 1999755})

        notes = [child for child in result["children"] if child["className"] == "file-breadcrumb-truncated"]
        self.assertEqual(len(notes), 1)
        self.assertIn("1.9 MB", notes[0]["text"])
        self.assertIn("81.2 MB", notes[0]["text"])

    def test_whole_files_get_no_cut_note(self) -> None:
        result = self.run_harness(self.crumb_harness, {"truncated": False, "size": 1200, "shown": 1200})

        self.assertEqual([child for child in result["children"]
                          if child["className"] == "file-breadcrumb-truncated"], [])

    def test_the_editor_locks_while_a_truncated_file_is_active(self) -> None:
        self.assertEqual(self.run_harness(self.readonly_harness, {"truncated": True})["updates"],
                         [{"readOnly": True}])
        self.assertEqual(self.run_harness(self.readonly_harness, {"truncated": False})["updates"],
                         [{"readOnly": False}])


if __name__ == "__main__":
    unittest.main()
