"""The Cloudflare relay signs tokens the way the Cloud Run relay did, so browser sessions and connector
tokens survive the move and either side can read the other's."""

import json
import os
import shutil
import subprocess
import unittest
from pathlib import Path

from remote_service.auth import AuthenticatedUser, SignedTokenService

SIGNING = Path(__file__).resolve().parent.parent / "remote_service" / "cloudflare" / "src" / "signing.js"
SECRET = "s" * 40

HARNESS = f"""
import {{ dumps, loads, CONNECTOR_SALT, SESSION_SALT }} from {json.dumps(SIGNING.as_uri())};
const scenario = JSON.parse(process.env.SCENARIO);
const read = await loads(scenario.secret, CONNECTOR_SALT, scenario.token, 2592000);
const issued = await dumps(scenario.secret, SESSION_SALT, {{ sub: "s2", email: "d@e.f" }});
process.stdout.write(JSON.stringify({{ read, issued }}));
"""


class CloudflareSigningTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is not installed")

    def run_harness(self, secret: str, token: str) -> dict:
        done = subprocess.run([self.node, "--input-type=module", "-e", HARNESS], capture_output=True, text=True,
                              check=False, env={**os.environ, "SCENARIO": json.dumps({"secret": secret, "token": token})})
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def test_tokens_cross_both_ways(self) -> None:
        service = SignedTokenService(SECRET, 43200, 2592000, 600)
        token = service.issue_connector(AuthenticatedUser("sub1", "a@b.c"))

        result = self.run_harness(SECRET, token)

        self.assertEqual((result["read"]["sub"], result["read"]["email"]), ("sub1", "a@b.c"))
        self.assertEqual(service.verify_session(result["issued"]), AuthenticatedUser("s2", "d@e.f"))

    def test_another_secret_reads_nothing(self) -> None:
        token = SignedTokenService(SECRET, 43200, 2592000, 600).issue_connector(AuthenticatedUser("sub1", "a@b.c"))

        self.assertIsNone(self.run_harness("t" * 40, token)["read"])


if __name__ == "__main__":
    unittest.main()
