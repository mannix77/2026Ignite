"""Tests for scripts/bdd_lint.py, the checker for specs/features/*.feature.

    python3 -m unittest tests.test_bdd_lint -v

Mirrors specs/features/spec-lint.feature. Each rule is shown a file that breaks it and the
whole list of findings is compared, so a rule that also fires somewhere it should not fails
its test. The last class runs the checker over every feature file on disk: that is what makes
`npm test` (and so the Tests workflow) lint the specs.
"""
import contextlib
import io
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SCRIPT = os.path.join(ROOT, "scripts", "bdd_lint.py")
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import bdd_lint  # noqa: E402

GOOD = """\
Feature: Picks are kept
  A pick survives a reload, so a plan is never lost.

  Rule: A pick is saved when it is made

    Scenario: Rating a session
      Given a session
      When it is rated Must
      Then the rating is saved
"""


def found(text):
    """[(line, code)] for every finding, in the order reported."""
    return [(line, code) for line, code, _ in bdd_lint.lint_text(text)]


def scenario(*steps, head="    Scenario: Rating a session"):
    """GOOD with its scenario replaced: `head`, then `steps` at the usual indentation."""
    top = GOOD.split("    Scenario:")[0]
    return top + head + "\n" + "".join("      " + s + "\n" for s in steps)


class StructureTests(unittest.TestCase):
    def test_a_well_formed_file_has_no_findings(self):
        self.assertEqual(bdd_lint.lint_text(GOOD), [])

    def test_a_scenario_outside_any_rule_is_reported(self):
        text = ("Feature: Picks are kept\n  Why it matters.\n\n"
                "    Scenario: Rating a session\n      Given a session\n      Then it is saved\n")
        self.assertEqual(found(text), [(4, "rule")])

    def test_a_feature_with_no_description_is_reported(self):
        text = GOOD.replace("  A pick survives a reload, so a plan is never lost.\n", "")
        self.assertEqual(found(text), [(1, "description")])

    def test_a_rule_with_no_scenario_is_reported(self):
        text = GOOD.replace("  Rule: A pick is saved when it is made\n",
                            "  Rule: An empty rule\n\n  Rule: A pick is saved when it is made\n")
        self.assertEqual(found(text), [(4, "rule")])

    def test_a_rule_or_scenario_with_no_title_is_reported(self):
        text = GOOD.replace("Rule: A pick is saved when it is made", "Rule:").replace(
            "Scenario: Rating a session", "Scenario:")
        self.assertEqual(found(text), [(4, "rule"), (6, "title")])

    def test_a_file_must_be_exactly_one_feature_and_start_with_it(self):
        self.assertEqual(found("# only a comment\n"), [(1, "feature")])
        self.assertEqual(found(""), [(1, "feature")])
        self.assertEqual(found("Some text first\n" + GOOD), [(1, "feature")])
        self.assertEqual(found(GOOD + "\nFeature: A second one\n  Described.\n"), [(11, "feature")])
        self.assertEqual(found("Feature:\n" + GOOD.split("\n", 1)[1]), [(1, "feature")])

    def test_text_with_no_feature_is_reported_once(self):
        self.assertEqual(found("hello\nworld\n"), [(1, "feature")])

    def test_a_second_feature_ends_the_scenario_before_it_and_does_not_describe_the_first(self):
        first = scenario("Given a session", "When it is rated Must")       # no Then
        self.assertEqual(found(first + "\nFeature: A second one\n  Described.\n"), [(6, "steps"), (10, "feature")])
        bare = GOOD.replace("  A pick survives a reload, so a plan is never lost.\n", "")
        self.assertEqual(found(bare + "\nFeature: A second one\n  Described.\n"), [(1, "description"), (10, "feature")])

    def test_an_outline_does_not_reach_past_a_second_feature_for_its_examples(self):
        text = OutlineTests.OUTLINE.split("\n      Examples:")[0] + (
            "\nFeature: A second one\n  Described.\n      Examples:\n        | rating | kept |\n")
        self.assertEqual(found(text), [(6, "outline"), (11, "feature"), (13, "outline")])

    def test_a_comment_before_the_feature_is_allowed(self):
        self.assertEqual(found("# Issue 98 covered this.\n" + GOOD), [])

    def test_a_feature_with_no_scenario_is_reported(self):
        self.assertEqual(found("Feature: Picks are kept\n  Why it matters.\n"), [(1, "feature")])


class StepTests(unittest.TestCase):
    def test_six_steps_are_allowed_and_the_seventh_is_reported(self):
        six = ["Given a", "And b", "When c", "And d", "Then e", "And f"]
        self.assertEqual(found(scenario(*six)), [])
        self.assertEqual(found(scenario(*six, "But g")), [(13, "brief")])

    def test_only_the_first_step_over_the_limit_is_reported(self):
        steps = ["Given a", "And b", "When c", "And d", "Then e", "And f", "And g", "And h"]
        self.assertEqual(found(scenario(*steps)), [(13, "brief")])

    def test_a_scenario_with_no_then_is_reported_on_its_title_line(self):
        self.assertEqual(found(scenario("Given a session", "When it is rated Must")), [(6, "steps")])

    def test_given_then_without_a_when_is_allowed(self):
        # 14 scenarios in the repository state a fact and its outcome with no action between.
        self.assertEqual(found(scenario("Given a session rated Must", "Then it is in the plan")), [])

    def test_when_then_without_a_given_is_allowed(self):
        self.assertEqual(found(scenario("When a session is rated Must", "Then it is in the plan")), [])

    def test_a_step_out_of_order_is_reported_on_its_own_line(self):
        self.assertEqual(found(scenario("Given a", "Then b", "When c")), [(9, "steps")])
        self.assertEqual(found(scenario("When a", "Given b", "Then c")), [(8, "steps")])

    def test_a_repeated_given_when_or_then_is_reported_on_the_repeat(self):
        self.assertEqual(found(scenario("Given a", "When b", "Then c", "Then d")), [(10, "steps")])
        self.assertEqual(found(scenario("Given a", "Given b", "Then c")), [(8, "steps")])

    def test_a_scenario_cannot_open_with_and_or_but(self):
        self.assertEqual(found(scenario("And a", "When b", "Then c")), [(7, "steps")])
        self.assertEqual(found(scenario("But a", "When b", "Then c")), [(7, "steps")])

    def test_a_scenario_with_no_steps_is_reported_once(self):
        self.assertEqual(found(scenario()), [(6, "steps")])

    def test_two_scenarios_with_one_title_report_the_second(self):
        text = GOOD + "\n    Scenario: Rating a session\n      Given another\n      Then it is saved\n"
        self.assertEqual(found(text), [(11, "title")])

    def test_the_same_title_in_different_words_or_case_is_not_a_duplicate(self):
        text = GOOD + "\n    Scenario: rating a session\n      Given another\n      Then it is saved\n"
        self.assertEqual(found(text), [])

    def test_example_is_read_as_a_scenario(self):
        self.assertEqual(found(GOOD.replace("Scenario:", "Example:")), [])
        self.assertEqual(found(scenario("Given a", head="    Example: Rating a session")), [(6, "steps")])

    def test_a_background_needs_steps_but_no_then_and_does_not_count_as_a_scenario(self):
        background = "    Background:\n      Given a catalog\n\n"
        text = GOOD.replace("    Scenario:", background + "    Scenario:")
        self.assertEqual(found(text), [])
        self.assertEqual(found(text.replace("      Given a catalog\n", "")), [(6, "steps")])
        only = GOOD.split("    Scenario:")[0] + background.rstrip("\n") + "\n"
        self.assertEqual(found(only), [(4, "rule")])     # the rule still has no scenario

    def test_a_background_may_run_longer_than_a_scenario(self):
        seven = "    Background:\n      Given a\n" + "".join("      And %s\n" % c for c in "bcdefg") + "\n"
        self.assertEqual(found(GOOD.replace("    Scenario:", seven + "    Scenario:")), [])

    def test_a_background_comes_once_and_before_the_scenarios(self):
        background = "    Background:\n      Given a catalog\n"
        self.assertEqual(found(GOOD + "\n" + background), [(11, "steps")])
        twice = GOOD.replace("    Scenario:", background + "\n" + background + "\n    Scenario:")
        self.assertEqual(found(twice), [(9, "steps")])
        # One at the feature level and one in a rule are two different places.
        both = GOOD.replace("  Rule:", "  Background:\n    Given a device\n\n  Rule:", 1).replace(
            "    Scenario:", background + "\n    Scenario:")
        self.assertEqual(found(both), [])
        # A new rule starts again: its background may follow the previous rule's scenarios.
        next_rule = GOOD + "\n  Rule: Another\n\n" + background + "\n    Scenario: Again\n      Given a\n      Then b\n"
        self.assertEqual(found(next_rule), [])

    def test_a_background_before_the_first_rule_sits_one_level_out(self):
        text = GOOD.replace("  Rule:", "  Background:\n    Given a catalog\n\n  Rule:", 1)
        self.assertEqual(found(text), [])


class OutlineTests(unittest.TestCase):
    OUTLINE = scenario("Given a session", "When it is rated <rating>", "Then it is <kept>",
                       head="    Scenario Outline: Rating a session as <rating>") + (
        "\n      Examples:\n        | rating | kept    |\n        | Must   | planned |\n")

    def test_an_outline_with_a_header_and_one_row_is_clean(self):
        self.assertEqual(found(self.OUTLINE), [])

    def test_an_outline_with_a_header_and_no_rows_is_reported(self):
        self.assertEqual(found(self.OUTLINE.replace("        | Must   | planned |\n", "")), [(6, "outline")])

    def test_an_outline_with_no_examples_is_reported(self):
        self.assertEqual(found(self.OUTLINE.split("\n      Examples:")[0]), [(6, "outline")])

    def test_a_placeholder_with_no_column_is_reported_where_it_is_used(self):
        self.assertEqual(found(self.OUTLINE.replace("it is <kept>", "it is <shown>")), [(9, "outline")])
        self.assertEqual(found(self.OUTLINE.replace("as <rating>", "as <mark>")), [(6, "outline")])

    def test_one_placeholder_used_twice_on_a_line_is_reported_once(self):
        text = self.OUTLINE.replace("it is rated <rating>", "it is rated <mark> or <mark>")
        self.assertEqual(found(text), [(8, "outline")])

    def test_less_than_and_greater_than_signs_are_not_a_placeholder(self):
        text = self.OUTLINE.replace("Given a session", "Given a count < 5 and > 2")
        self.assertEqual(found(text), [])

    def test_a_placeholder_in_a_steps_table_needs_a_column_too(self):
        table = "        | <kept> |\n"
        text = self.OUTLINE.replace("      When it is rated", table + "      When it is rated")
        self.assertEqual(found(text), [])
        self.assertEqual(found(text.replace("| <kept> |", "| <gone> |")), [(8, "outline")])

    def test_an_escaped_bar_stays_inside_its_cell(self):
        self.assertEqual(found(self.OUTLINE.replace("| Must   |", "| A\\|B   |")), [])
        self.assertEqual(bdd_lint.cells("| A\\|B | planned |"), ["A\\|B", "planned"])

    def test_every_examples_table_needs_rows_and_every_column(self):
        second = "\n      Examples: at Gartner\n        | rating | kept    |\n        | Want   | likely  |\n"
        self.assertEqual(found(self.OUTLINE + second), [])
        self.assertEqual(found(self.OUTLINE + second.replace("        | Want   | likely  |\n", "")), [(6, "outline")])
        self.assertEqual(found(self.OUTLINE + second.replace("| kept    |", "| shown   |")), [(9, "outline")])

    def test_a_column_no_step_uses_is_allowed(self):
        # suggestions.feature has a "description" column that only labels each row.
        text = self.OUTLINE.replace("| rating |", "| why | rating |").replace("| Must   |", "| top | Must   |")
        self.assertEqual(found(text), [])

    def test_examples_under_a_plain_scenario_are_reported(self):
        text = self.OUTLINE.replace("Scenario Outline: Rating a session as <rating>", "Scenario: Rating").replace(
            "<rating>", "Must").replace("<kept>", "planned")
        self.assertEqual(found(text), [(11, "outline")])

    def test_a_row_with_a_different_number_of_cells_is_reported(self):
        self.assertEqual(found(self.OUTLINE.replace("| Must   | planned |", "| Must   |")), [(13, "outline")])


class TextTests(unittest.TestCase):
    def test_a_misspelled_step_is_reported_not_skipped(self):
        text = scenario("Given a session", "Whne it is rated Must", "Then the rating is saved")
        findings = bdd_lint.lint_text(text)
        self.assertEqual([(l, c) for l, c, _ in findings], [(8, "text")])
        self.assertIn("Whne it is rated Must", findings[0][2])

    def test_a_keyword_needs_a_space_after_it(self):
        self.assertEqual(found(scenario("Given a session", "Thenit is saved")), [(6, "steps"), (8, "text")])

    def test_a_description_under_a_rule_is_allowed(self):
        text = GOOD.replace("  Rule: A pick is saved when it is made\n",
                            "  Rule: A pick is saved when it is made\n\n    Saved means written to the device.\n")
        self.assertEqual(found(text), [])

    def test_free_text_after_a_scenario_has_started_is_reported(self):
        self.assertEqual(found(GOOD + "    A stray sentence.\n"), [(10, "text")])

    def test_tags_and_doc_strings_are_reported_as_not_used_here(self):
        self.assertEqual(found(GOOD.replace("    Scenario:", "    @wip\n    Scenario:")), [(6, "text")])
        findings = bdd_lint.lint_text(GOOD + '      """\n')
        self.assertEqual([(line, code) for line, code, _ in findings], [(10, "text")])
        self.assertIn("doc strings", findings[0][2])

    def test_a_description_line_may_start_with_a_step_word_or_a_bar(self):
        # To a Gherkin parser these are prose, and a wrapped sentence can start with "And".
        text = GOOD.replace("  A pick survives a reload, so a plan is never lost.\n",
                            "  Given the app is offline, a pick must still survive a reload,\n  And so must notes.\n")
        self.assertEqual(found(text), [])
        text = GOOD.replace("  Rule: A pick is saved when it is made\n",
                            "  Rule: A pick is saved when it is made\n\n    When it is made, not later.\n    | not a table |\n")
        self.assertEqual(found(text), [])

    def test_a_feature_described_only_by_a_step_like_line_is_described(self):
        text = GOOD.replace("  A pick survives a reload, so a plan is never lost.", "  Given a reload, a pick survives.")
        self.assertEqual(found(text), [])

    def test_a_step_after_the_examples_is_reported(self):
        self.assertEqual(found(OutlineTests.OUTLINE + "      And one more step\n"), [(14, "steps")])

    def test_a_step_word_with_nothing_after_it_is_not_a_step(self):
        self.assertEqual(found(scenario("Given", "Then the rating is saved")), [(7, "text")])

    def test_a_table_under_a_step_is_allowed_at_its_own_indentation(self):
        table = "        | code   |\n        | BRK101 |\n"
        self.assertEqual(found(GOOD.replace("      When it", table + "      When it")), [])
        shallow = "      | code   |\n        | BRK101 |\n"
        self.assertEqual(found(GOOD.replace("      When it", shallow + "      When it")), [(8, "layout")])

    def test_a_table_with_no_step_above_it_is_reported_row_by_row(self):
        table = "        | code   |\n        | BRK101 |\n"
        self.assertEqual(found(GOOD.replace("      Given a session\n", table)), [(7, "text"), (8, "text")])

    def test_a_comment_inside_a_scenario_is_allowed(self):
        self.assertEqual(found(GOOD.replace("      When it", "      # issue 98\n      When it")), [])


class LayoutTests(unittest.TestCase):
    def test_each_block_has_one_indentation(self):
        for old, new, line in (("Feature:", " Feature:", 1),
                               ("  Rule:", "   Rule:", 4),
                               ("    Scenario:", "  Scenario:", 6),
                               ("    Scenario:", "      Example:", 6),
                               ("      Given a", "    Given a", 7),
                               ("      Then the", "        Then the", 9)):
            with self.subTest(line=line):
                self.assertEqual(found(GOOD.replace(old, new)), [(line, "layout")])

    def test_a_background_is_indented_by_where_it_sits(self):
        in_rule = GOOD.replace("    Scenario:", "    Background:\n      Given a catalog\n\n    Scenario:")
        self.assertEqual(found(in_rule.replace("    Background:", "  Background:")), [(6, "layout")])
        self.assertEqual(found(in_rule.replace("      Given a catalog", "    Given a catalog")), [(7, "layout")])
        top = GOOD.replace("  Rule:", "  Background:\n    Given a catalog\n\n  Rule:", 1)
        self.assertEqual(found(top.replace("  Background:", "    Background:")), [(4, "layout")])
        self.assertEqual(found(top.replace("    Given a catalog", "      Given a catalog")), [(5, "layout")])

    def test_the_message_says_the_indentation_expected(self):
        findings = bdd_lint.lint_text(GOOD.replace("      Given a", "    Given a"))
        self.assertEqual(findings, [(7, "layout", "a step should be indented 6 spaces, has 4")])

    def test_examples_and_their_rows_are_indented_under_the_outline(self):
        self.assertEqual(found(OutlineTests.OUTLINE.replace("      Examples:", "    Examples:")), [(11, "layout")])
        self.assertEqual(found(OutlineTests.OUTLINE.replace("        | Must", "      | Must")), [(13, "layout")])

    def test_a_tab_trailing_spaces_and_a_missing_final_newline_are_each_reported(self):
        text = GOOD.replace("      Given a session", "      Given a\tsession").replace(
            "      When it is rated Must", "      When it is rated Must  ")
        self.assertEqual(found(text[:-1]), [(7, "layout"), (8, "layout"), (9, "layout")])

    def test_a_step_indented_with_a_tab_is_reported_once(self):
        self.assertEqual(found(GOOD.replace("      Given a session", "\tGiven a session")), [(7, "layout")])

    def test_blank_lines_at_the_end_are_each_reported_in_line_order(self):
        self.assertEqual(found(GOOD + "\n"), [(10, "layout")])
        self.assertEqual(found(GOOD + "\n\n"), [(10, "layout"), (11, "layout")])

    def test_a_byte_order_mark_is_reported_as_one_and_the_file_is_still_read(self):
        findings = bdd_lint.lint_text("\ufeff" + GOOD)
        self.assertEqual([(line, code) for line, code, _ in findings], [(1, "layout")])
        self.assertIn("byte order mark", findings[0][2])

    def test_windows_line_endings_are_reported_once_not_on_every_line(self):
        self.assertEqual(found(GOOD.replace("\n", "\r\n")), [(1, "layout")])


def feature_files_on_disk():
    out = []
    for folder, _, files in os.walk(os.path.join(ROOT, "specs")):
        out += [os.path.join(folder, f) for f in files if f.endswith(".feature")]
    return sorted(out)


class RepositoryTests(unittest.TestCase):
    def test_every_feature_file_on_disk_is_clean(self):
        files = feature_files_on_disk()
        self.assertIn(os.path.join(ROOT, "specs", "features", "up-next.feature"), files)
        self.assertIn(os.path.join(ROOT, "specs", "features", "spec-lint.feature"), files)
        self.assertEqual(bdd_lint.lint_paths(files), [])

    def test_the_default_run_checks_every_feature_file_on_disk(self):
        self.assertEqual(bdd_lint.default_paths(ROOT), feature_files_on_disk())
        run = subprocess.run([sys.executable, SCRIPT], capture_output=True, text=True, timeout=60, cwd=HERE)
        self.assertEqual((run.returncode, run.stderr), (0, ""))
        self.assertEqual(run.stdout, "%d feature files checked, no findings\n" % len(feature_files_on_disk()))


class CommandTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def write(self, name, data):
        path = os.path.join(self.tmp, name)
        with open(path, "wb") as f:
            f.write(data)
        return path

    def main(self, argv, root):
        """(exit code, stdout, stderr) of bdd_lint.main run in this process."""
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = bdd_lint.main(argv, root=root)
        return code, out.getvalue(), err.getvalue()

    def run_on(self, *paths):
        return subprocess.run([sys.executable, SCRIPT, *paths], capture_output=True, text=True, timeout=60)

    def test_a_finding_is_printed_with_file_line_and_reason_and_the_exit_is_an_error(self):
        bad = self.write("bad.feature", scenario("Given a session", "When it is rated Must").encode())
        good = self.write("good.feature", GOOD.encode())
        run = self.run_on(good, bad)
        self.assertEqual(run.returncode, 1)
        self.assertEqual(run.stdout, bad + ":6: [steps] the scenario has no Then: it states no outcome\n"
                                           "2 feature files checked, 1 finding\n")

    def test_clean_files_exit_zero(self):
        run = self.run_on(self.write("good.feature", GOOD.encode()))
        self.assertEqual((run.returncode, run.stdout), (0, "1 feature file checked, no findings\n"))

    def test_a_file_that_is_missing_or_not_text_is_a_finding_not_a_crash(self):
        binary = self.write("binary.feature", b"\xff\xfe\x00Feature")
        missing = os.path.join(self.tmp, "missing.feature")
        self.assertEqual([(p, l, c) for p, l, c, _ in bdd_lint.lint_paths([binary, missing])],
                         [(binary, 1, "file"), (missing, 1, "file")])
        run = self.run_on(binary, missing)
        self.assertEqual((run.returncode, run.stderr), (1, ""))
        self.assertEqual(run.stdout, binary + ":1: [file] could not be read as UTF-8 text (UnicodeDecodeError)\n" +
                         missing + ":1: [file] could not be read as UTF-8 text (FileNotFoundError)\n"
                         "2 feature files checked, 2 findings\n")

    def test_the_default_run_looks_in_every_folder_under_specs_and_only_at_feature_files(self):
        deep = os.path.join(self.tmp, "specs", "features", "ios")
        os.makedirs(deep)
        for path in (os.path.join(deep, "app.feature"), os.path.join(self.tmp, "specs", "top.feature"),
                     os.path.join(deep, "notes.md"), os.path.join(self.tmp, "outside.feature")):
            with open(path, "w", encoding="utf-8") as f:
                f.write(GOOD)
        self.assertEqual(bdd_lint.default_paths(self.tmp),
                         [os.path.join(deep, "app.feature"), os.path.join(self.tmp, "specs", "top.feature")])
        self.assertEqual(self.main([], self.tmp), (0, "2 feature files checked, no findings\n", ""))

    def test_a_run_that_finds_no_files_is_an_error_not_a_pass(self):
        self.assertEqual(bdd_lint.default_paths(self.tmp), [])
        self.assertEqual(self.main([], self.tmp),
                         (2, "", "no feature files found under %s\n" % os.path.join(self.tmp, "specs")))


if __name__ == "__main__":
    unittest.main()
