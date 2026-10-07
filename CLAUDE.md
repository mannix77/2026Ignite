# Working on 2026Ignite

A no-build PWA conference planner (Ignite, Gartner, re:Invent) with Python catalog importers
and GitHub Actions that sync catalogs and deploy GitHub Pages. These are the practices this
repo settled on, mostly learned from CodeRabbit reviews during the October 2026 test-gap work
(PRs #25–#67). Follow them in every change, by hand or by an agent.

## How a change is made

- **Spec first for new behaviour.** Add or update a scenario in `specs/features/*.feature`
  (BRIEF Gherkin; `bdd_lint.py` clean), then a failing test, then the code. Watch the test
  fail for the right reason before writing the fix.
- **One small PR per change**, branched from the latest `main`, in its own worktree. The main
  checkout may hold someone else's work: don't commit, stash or switch it.
- **Run `npm test`** (all JS suites and Python `unittest discover`) before every push.
- **Merge gate**: tests pass, CodeRabbit's review is complete with no unresolved threads, and
  just before merging: check what landed on `main` since you branched, check `main`'s latest CI
  runs, and run the full suite on the exact merge result. `git archive` takes a tree id,
  so no temporary commit is needed:

  ```sh
  git fetch origin || exit 1                                       # never test against a stale main
  tree=$(git merge-tree --write-tree origin/main HEAD) || exit 1   # non-zero on conflicts
  dir=$(mktemp -d) && git archive "$tree" | tar -x -C "$dir" && (cd "$dir" && npm test)
  ```

  A "success" status from a rate-limited CodeRabbit is not a review.
- **Another agent may be working in parallel.** Check open PRs that touch the same files.
  The test-command lists in `package.json` and `.github/workflows/sync.yml` are
  append-only lists that conflict easily: while another PR edits them, add tests to existing
  files (or a Python file `unittest discover` picks up) instead of a new JS test file.

## Tests that can't pass for the wrong reason

Before pushing, check every new test against this list. Most review findings were one of
these.

1. **Assert the outcome, not that something ran.** Check the served response, the written
   file, the returned value; not just that a handler or callback was called.
2. **Pair "X didn't happen" with "Y did".** An absence check alone also passes when nothing
   happens at all (e.g. the main site's key is empty *and* the copy's key holds the value).
3. **Assert the precondition the test depends on.** If the point is "preview still runs
   despite an added session", also assert the added session is in the model and timed.
4. **Assert every output.** If a function returns `(added, removed, changed)`, compare the
   whole tuple, or "only a change" goes untested.
5. **Take expected values from the source of truth**: files on disk (existence-filtered,
   recursive, files only), the list the code actually fetches, literal values. Never rebuild
   the expectation with the code's own rule.
6. **Cover the whole set, not the instance a review named.** If one note field, one weak id
   check or one subprocess call is flagged, find the others in the same change.
7. **A parity or differential test also asserts the expected result.** "Browser and sync
   agree" passes when both are wrong the same way.
8. **Cure a tautological test with an independent expected value** (a published fact, a
   literal), never with a weaker assertion such as "any valid timestamp".
9. **Pin both sides of every threshold** (accepted just inside, refused just outside), and
   test isolation in both directions (A doesn't see B; B doesn't see A, each from its own
   context).
10. **Don't depend on the wall clock or the machine's time zone.** Patch `utcnow`, pass `now`,
   or express times relative to `Date.now()`. A fixed date that happens to be in the future
   can pass against the bug.
11. **Guarantees about what is published or committed** (private sessions, personal notes)
   are asserted on the file the real entry point writes, not on a helper's return value.
12. **Every subprocess or network call in a test has a timeout.**
13. **Share Python fixtures through a mixin**, never by subclassing a concrete `TestCase`
    (that silently runs its tests twice). After adding tests, check the "Ran N" count went up
    by exactly the number you added.

## Code patterns

- **Identifiers go through one helper** that defines "usable" (right type, trimmed,
  non-blank, or matching its own key) and downstream code uses the cleaned value. Look ups by
  id use `Object.hasOwn` / exact keys, never `obj[id]` truthiness or a regex over source text.
- **A guard's threshold is fixed from the first trusted reading.** Later input that disagrees
  is itself a reason to refuse, never a reason to lower the bar.
- **A new sentinel value** (e.g. `at: 0` for "undated") means checking every comparison it
  feeds for ties.
- **When a safeguard can itself fail, decide what happens then.** For saved data, refuse the
  destructive step (overwriting) until the safeguard (the copy) succeeds.
- **When a function starts throwing**, check every caller, especially startup paths, so a bad
  file shows a message instead of the app's error page.
- **Untrusted input is skipped and counted, never fatal**: a junk record, a garbled speaker,
  a hand-edited `keynotes.json` entry. A feed that is mostly junk is refused by the existing
  guards and keeps the last good data.
- **Browser and Python normalizers must agree.** `live.js` mirrors `sync.py`; change both and
  extend the parity tests (`tests/normalize_cli.js`, `tests/diff_cli.js`).
- **Logic that decides what the user sees belongs in a pure module, not `app.js`**, so it can
  be tested (e.g. pick resolution in `groupPick`/`prioOf` is still untested for this reason).
- **Convert file URLs with `fileURLToPath`**, not `new URL(...).pathname` (keeps `%20`).

## Mutation checks

When a test is meant to guard a line, break that line in a scratch copy and run the suite:
the test must fail. A mutation that didn't apply, or that crashes the suite, proves nothing:
confirm the edit applied and the mutant compiles (`node --check`, `py_compile`) before
counting failures.
