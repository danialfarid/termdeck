"""The app's element lookup exists before the constructor first uses it.

`this.$` is an instance field set inside the constructor, not a method. Setting the project label from
the address was added above the line that defined it; the constructor threw on it, the app never
started, and every page -- desktop and mobile -- sat at "Loading…" with nothing else drawn.
"""

import re
import unittest
from pathlib import Path

APP = Path(__file__).resolve().parent.parent / "termdeck" / "static" / "app.js"


class ElementLookupOrderTest(unittest.TestCase):
    def test_it_is_defined_before_its_first_use(self) -> None:
        source = APP.read_text()
        body = re.search(r"\n  constructor\(\) \{\n(.*?)\n  \}\n", source, re.S).group(1)
        defined = body.index("this.$ = (id) =>")
        uses = [match.start() for match in re.finditer(r"this\.\$\(", body)]

        self.assertTrue(uses, "the constructor no longer looks up an element; this test has nothing to guard")
        self.assertLess(defined, min(uses))


if __name__ == "__main__":
    unittest.main()
