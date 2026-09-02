import unittest

from termdeck.file_service import ProjectFileService
from termdeck.search_service import FilenameMatcher, ProjectSearchService


class FilenameMatcherTest(unittest.TestCase):
    def rank(self, query: str, name: str, is_directory: bool = False) -> int | None:
        matcher = FilenameMatcher(query)
        rank, placing = matcher.literal_score(name, is_directory)
        if placing is not None:
            return rank
        return FilenameMatcher.FUZZY_RANK if matcher.fuzzy_distance(name) is not None else None

    def test_name_holding_the_query_is_a_literal_match_wherever_it_sits(self) -> None:
        self.assertEqual(self.rank("investigation.md", "investigation.md"), 0)
        self.assertEqual(self.rank("investigation", "investigation.md"), 1)
        self.assertEqual(self.rank("investig", "investigation.md"), 2)
        self.assertEqual(self.rank("investig", "c2o_investigation.md"), FilenameMatcher.CONTAINS_RANK)

    def test_name_needing_edits_is_a_fuzzy_match(self) -> None:
        self.assertEqual(self.rank("invegtisate", "investigate.py"), FilenameMatcher.FUZZY_RANK)
        self.assertEqual(self.rank("sec_fnud", "sec_fund.py"), FilenameMatcher.FUZZY_RANK)
        self.assertEqual(self.rank("investig", "involve_in_lestig.md"), FilenameMatcher.FUZZY_RANK)

    def test_letters_collected_from_across_the_name_do_not_match(self) -> None:
        self.assertIsNone(self.rank("investigate", "in_veg_tis_igate.md"))
        self.assertIsNone(self.rank("investigate", "index_of_generated_states.py"))

    def test_one_typo_is_forgiven_whatever_kind_it_is(self) -> None:
        for name in ["session_manager.py", "sesion_manager.py", "sesssion_manager.py", "sessino_manager.py"]:
            self.assertIsNotNone(self.rank("session_manager", name), name)

    def test_short_queries_get_no_typo_budget(self) -> None:
        self.assertEqual(FilenameMatcher("inv").pieces, [])
        self.assertIsNone(self.rank("inv", "navigate_verbose.py"))
        self.assertEqual(self.rank("inv", "invisible.py"), 2)

    def test_directories_have_no_extension_to_strip(self) -> None:
        self.assertEqual(self.rank("docs.md", "docs.md", is_directory=True), 0)
        self.assertEqual(self.rank("docs", "docs.md", is_directory=False), 1)
        self.assertEqual(self.rank("docs", "docs.md", is_directory=True), 2)

    def test_distance_counts_a_swap_of_neighbours_as_one_typo(self) -> None:
        matcher = FilenameMatcher("markdwon")
        self.assertEqual(matcher.fuzzy_distance("app_markdown_files.js"), 1)


class FuzzyFallbackTest(unittest.TestCase):
    def setUp(self) -> None:
        self.service = ProjectSearchService(ProjectFileService())
        self.candidates = {(f"docs/investigation-{index}.md", False) for index in range(8)}
        self.candidates.add(("src/investigate.py", False))

    def ranks(self, query: str) -> list[int]:
        return [rank for rank, _, _, _, _, _ in self.service._ranked_candidates(self.candidates, query, False)]

    def test_typos_are_not_chased_when_the_query_matched_plenty_as_typed(self) -> None:
        ranks = self.ranks("investigation")

        self.assertEqual(len(ranks), 8)
        self.assertNotIn(FilenameMatcher.FUZZY_RANK, ranks)

    def test_typos_are_chased_when_the_query_matched_almost_nothing(self) -> None:
        ranks = self.ranks("invegtisate")

        self.assertTrue(ranks)
        self.assertEqual(set(ranks), {FilenameMatcher.FUZZY_RANK})

    def test_literal_matches_are_ordered_ahead_of_typo_matches(self) -> None:
        self.candidates.add(("src/investigate_extra.py", False))

        ranks = self.ranks("investigate")

        self.assertEqual(ranks[0], 1)
        self.assertEqual(sorted(ranks), ranks)


if __name__ == "__main__":
    unittest.main()
