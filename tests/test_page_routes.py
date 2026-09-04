import asyncio
import unittest
from unittest.mock import MagicMock

from fastapi.responses import FileResponse, RedirectResponse

from termdeck.server import TermdeckServer


class ProjectPageRouteTest(unittest.TestCase):
    def server(self, known_projects: set[str]) -> TermdeckServer:
        server = TermdeckServer.__new__(TermdeckServer)
        server.recovery_mode = False
        server.manager = MagicMock()
        server.manager.registry.root_for = lambda name: f"/home/{name}" if name in known_projects else None
        return server

    def test_an_unknown_project_lands_on_the_all_projects_root(self) -> None:
        server = self.server({"stock"})
        for page in (server._project_page, server._filedeck_page):
            response = asyncio.run(page("nope"))

            self.assertIsInstance(response, RedirectResponse)
            self.assertEqual(response.status_code, 302)
            self.assertEqual(response.headers["location"], "/")

    def test_a_known_project_serves_the_app(self) -> None:
        server = self.server({"stock"})

        response = asyncio.run(server._project_page("stock"))

        self.assertIsInstance(response, FileResponse)


if __name__ == "__main__":
    unittest.main()
