import io
import unittest
import warnings
import zipfile

from termdeck.project_bundle import ProjectBundleService, ProjectBundleSession
from termdeck.server import ProjectUiState, TermdeckServer


class ProjectBundleServiceTest(unittest.TestCase):
    def test_export_import_preserves_session_archives_layout_and_worktrees(self) -> None:
        service = ProjectBundleService()
        filename, archive = service.build(
            "1.2.3", "stock", [{"id": "root", "name": "stock", "branch": "main", "is_root": True},
                              {"id": "wt-abcdef123456", "name": "feature", "branch": "feature/x", "is_root": False}],
            {"root": {"color": "#3b82f6", "session_order": ["abc123def456"]},
             "wt-abcdef123456": {"color": "#f97316", "session_order": ["def456abc123"]}},
            [ProjectBundleSession("abc123def456", "root", b"root archive"),
             ProjectBundleSession("def456abc123", "wt-abcdef123456", b"worktree archive")])

        imported = service.read(archive)

        self.assertEqual(filename, "stock.termdeck-project")
        self.assertEqual(service.archive_format(archive), service.FORMAT)
        self.assertEqual(imported.project_name, "stock")
        self.assertEqual(imported.project_states["root"]["color"], "#3b82f6")
        self.assertEqual(imported.worktrees[1]["branch"], "feature/x")
        self.assertEqual([(item.source_session_id, item.source_worktree_id, item.archive) for item in imported.sessions],
                         [("abc123def456", "root", b"root archive"),
                         ("def456abc123", "wt-abcdef123456", b"worktree archive")])

    def test_single_session_export_uses_collection_format_and_session_title(self) -> None:
        service = ProjectBundleService()

        filename, archive = service.build(
            "1.2.3", "stock", [{"id": "root", "name": "stock", "branch": "main", "is_root": True}],
            {"root": {"session_order": ["abc123def456"]}},
            [ProjectBundleSession("abc123def456", "root", b"session archive")], "Review cache safety")

        self.assertEqual(filename, "Review-cache-safety.termdeck-project")
        self.assertEqual(service.archive_format(archive), service.FORMAT)
        self.assertEqual(len(service.read(archive).sessions), 1)

    def test_archive_format_recognizes_legacy_single_session_archive(self) -> None:
        payload = io.BytesIO()
        with zipfile.ZipFile(payload, "w") as archive:
            archive.writestr("manifest.json", '{"format":"termdeck-session","format_version":1}')

        self.assertEqual(ProjectBundleService.archive_format(payload.getvalue()), "termdeck-session")

    def test_import_rejects_unexpected_or_duplicate_entries(self) -> None:
        payload = io.BytesIO()
        with warnings.catch_warnings(), zipfile.ZipFile(payload, "w") as archive:
            warnings.simplefilter("ignore", UserWarning)
            archive.writestr("manifest.json", '{"format":"termdeck-project","format_version":1,"session_count":0,"sessions":[]}')
            archive.writestr("project.json", '{"name":"stock","worktrees":[]}')
            archive.writestr("project-state.json", "{}")
            archive.writestr("README.txt", "x")
            archive.writestr("README.txt", "x")

        with self.assertRaisesRegex(ValueError, "unexpected or duplicate"):
            ProjectBundleService().read(payload.getvalue())

    def test_import_rejects_session_path_not_declared_by_manifest(self) -> None:
        payload = io.BytesIO()
        with zipfile.ZipFile(payload, "w") as archive:
            archive.writestr("manifest.json", '{"format":"termdeck-project","format_version":1,"session_count":0,"sessions":[]}')
            archive.writestr("project.json", '{"name":"stock","worktrees":[]}')
            archive.writestr("project-state.json", "{}")
            archive.writestr("README.txt", "x")
            archive.writestr("sessions/001-abc123def456.termdeck-session", "x")

        with self.assertRaisesRegex(ValueError, "unexpected or duplicate"):
            ProjectBundleService().read(payload.getvalue())

    def test_layout_remap_keeps_groups_and_session_references_consistent(self) -> None:
        imported = ProjectUiState(
            color="#f97316", session_order=["abc123def456"], unread_sessions=["abc123def456"],
            terminal_groups=[{"id": "review", "name": "Review", "collapsed": False}],
            session_groups={"abc123def456": "review"},
            terminal_layout=["group:review"], session_view_modes={"abc123def456": "markdown"})

        remapped = TermdeckServer._remap_imported_project_state(imported, {"abc123def456": "new123abc456"}, set())

        self.assertEqual(remapped.session_order, ["new123abc456"])
        self.assertEqual(remapped.unread_sessions, ["new123abc456"])
        self.assertEqual(remapped.terminal_layout, ["group:review"])
        self.assertEqual(remapped.session_groups, {"new123abc456": "review"})
        self.assertEqual(remapped.session_view_modes, {"new123abc456": "markdown"})

    def test_empty_worktree_state_keeps_its_color(self) -> None:
        imported = ProjectUiState(color="#f97316", root_worktree_color="#3b82f6")

        remapped = TermdeckServer._remap_imported_project_state(imported, {}, set())

        self.assertEqual(remapped.color, "#f97316")
        self.assertEqual(remapped.root_worktree_color, "#3b82f6")

    def test_single_session_export_state_excludes_other_sessions_and_groups(self) -> None:
        state = ProjectUiState(
            color="#f97316", root_worktree_color="#3b82f6", session_order=["abc123def456", "def456abc123"],
            unread_sessions=["abc123def456", "def456abc123"],
            terminal_groups=[{"id": "review", "name": "Review", "collapsed": False},
                             {"id": "build", "name": "Build", "collapsed": False}],
            session_groups={"abc123def456": "review", "def456abc123": "build"},
            terminal_layout=["group:review", "group:build"],
            session_view_modes={"abc123def456": "markdown", "def456abc123": "terminal"})

        exported = TermdeckServer._single_session_export_state(state, "abc123def456")

        self.assertEqual(exported.session_order, ["abc123def456"])
        self.assertEqual(exported.unread_sessions, ["abc123def456"])
        self.assertEqual(exported.terminal_layout, ["group:review"])
        self.assertEqual(exported.session_groups, {"abc123def456": "review"})
        self.assertEqual(exported.session_view_modes, {"abc123def456": "markdown"})
        self.assertEqual(exported.terminal_groups, [{"id": "review", "name": "Review", "collapsed": False}])


if __name__ == "__main__":
    unittest.main()
