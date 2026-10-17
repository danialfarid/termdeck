"""The "Taking longer than expected" panel can be closed, and stays closed for that outage.

With the connection cut, loading never finishes, so the panel used to sit over the page with no way to
move it. Closed by hand, it stays hidden through the rest of that stall -- a later timer or load failure
does not bring it back -- and returns for the next stall once loading has ended.
"""

import json
import shutil
import subprocess
import unittest
from pathlib import Path

STATIC = Path(__file__).resolve().parent.parent / "termdeck" / "static"

HARNESS = """
const steps = JSON.parse(process.argv[1]);
const elements = new Map();
const element = (id) => {
  if (!elements.has(id)) {
    const classes = new Set();
    const handlers = {};
    elements.set(id, {
      classList: {
        add: (name) => classes.add(name), remove: (name) => classes.delete(name),
        contains: (name) => classes.has(name),
        toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
      },
      addEventListener: (type, handler) => { handlers[type] = handler; },
      click: () => handlers.click && handlers.click(),
      textContent: "", disabled: false,
    });
  }
  return elements.get(id);
};
element("initial-loading-recovery").classList.add("hidden");
element("mobile-connection-warning").classList.add("hidden");
let timer = null;
global.window = { setTimeout: (fn) => { timer = fn; return 1; }, __td: null };
global.clearTimeout = () => { timer = null; };
global.document = { getElementById: element, body: { appendChild() {} } };
global.location = { protocol: "http:" };
__SOURCE__
const controller = window.TermdeckLoadingRecovery;
const panel = element("initial-loading-recovery");
const seen = [];
for (const step of steps) {
  if (step === "elapse") { const fire = timer; timer = null; if (fire) fire(); }
  else if (step === "close") element("initial-loading-recovery-close").click();
  else if (step === "loaded") { element("initial-loading-state").classList.add("hidden"); controller.finish(); }
  else if (step === "stall") { element("initial-loading-state").classList.remove("hidden"); controller.schedule(); }
  else if (step === "fail") controller.show();
  else if (step === "check") seen.push(!panel.classList.contains("hidden"));
}
process.stdout.write(JSON.stringify(seen));
"""


class LoadingRecoveryCloseTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")
        cls.harness = HARNESS.replace("__SOURCE__", (STATIC / "loading_recovery.js").read_text())

    def shown(self, *steps: str) -> list[bool]:
        done = subprocess.run([self.node, "-e", self.harness, json.dumps(steps)],
                              capture_output=True, text=True, check=False)
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def test_a_stall_shows_the_panel_and_close_hides_it(self) -> None:
        self.assertEqual(self.shown("elapse", "check", "close", "check"), [True, False])

    def test_closed_it_stays_closed_through_the_same_stall(self) -> None:
        self.assertEqual(self.shown("elapse", "close", "stall", "elapse", "check", "fail", "check"),
                         [False, False])

    def test_the_next_stall_after_loading_shows_it_again(self) -> None:
        self.assertEqual(self.shown("elapse", "close", "loaded", "stall", "elapse", "check"), [True])

    def test_markup_has_the_close_button(self) -> None:
        self.assertIn('id="initial-loading-recovery-close"', (STATIC / "index.html").read_text())


if __name__ == "__main__":
    unittest.main()
