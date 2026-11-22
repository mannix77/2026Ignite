# Working on 2026Ignite

A native iPhone app, Session Planner (`ios/`), that signs in to the AWS Events API on the phone
and shows an attendee's re:Invent schedule as a calendar. A small GitHub Action publishes the
app's support and privacy pages. Until November 2026 this repo was a web planner (PWA, Python
catalog importers, sync workflows); that code is gone and lives only in git history. These are
the practices the repo settled on, mostly learned from CodeRabbit reviews during the October
2026 test-gap work (PRs #25–#67). Follow them in every change, by hand or by an agent.

## How a change is made

- **Spec first for new behaviour.** Add or update an example in
  `specs/features/ios-app.feature` (brief Gherkin: rules and examples), then a failing test,
  then the code. Watch the test fail for the right reason before writing the fix.
- **One small PR per change**, branched from the latest `main`, in its own worktree. The main
  checkout may hold someone else's work: don't commit, stash or switch it.
- **Run the tests before every push**: `swift test --package-path ios/PlannerCore`, and build
  the app for the simulator when anything under `ios/SessionPlanner/` changed (the command is in
  `.github/workflows/ios-tests.yml`). If `xcode-select` points at the Command Line Tools,
  prefix with `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`.
- **Merge gate**: tests pass, CodeRabbit's review is complete with no unresolved threads, and
  just before merging: check what landed on `main` since you branched, check `main`'s latest CI
  runs, and run the tests on the exact merge result. `git archive` takes a tree id, so no
  temporary commit is needed:

  ```sh
  git fetch origin || exit 1                                       # never test against a stale main
  tree=$(git merge-tree --write-tree origin/main HEAD) || exit 1   # non-zero on conflicts
  dir=$(mktemp -d) && git archive "$tree" | tar -x -C "$dir" && (cd "$dir" && swift test --package-path ios/PlannerCore)
  ```

  A "success" status from a rate-limited CodeRabbit is not a review.
- **Another agent may be working in parallel.** Check open PRs that touch the same files.
  `ios/SessionPlanner.xcodeproj/project.pbxproj` conflicts easily: while another PR edits it,
  prefer changes inside `ios/PlannerCore/` (a Swift package picks up new files by itself).

## What must not break

- **The support and privacy page addresses.** The App Store listing links to
  `https://mannix77.github.io/2026Ignite/ios/AppStore/support.html` and `.../privacy.html`.
  `.github/workflows/pages.yml` publishes exactly those two files. Don't move or rename them,
  and don't widen what the workflow publishes: `archive/` holds personal selections and stays
  off the site.
- **The signing team stays out of the repository.** It is passed on the command line
  (`TEAM=... ios/AppStore/archive.sh`); this repo is public.
- **Uploading a build or submitting for review is the owner's decision**, every time.
- **Real reserve, cancel and favorite calls change the owner's actual conference schedule.**
  Never exercise them against the live API without asking; tests use canned responses.
- **`archive/` is a reference record**, not app data. Nothing reads it; don't "tidy" it.

## Tests that can't pass for the wrong reason

Before pushing, check every new test against this list. Most review findings were one of
these.

Rules 10, 12 and 13 are also checked by `swift test` itself (`TestRulesTests.swift`): no wall
clock or machine time zone (including `Calendar(identifier:)` and `DateFormatter()`, which
start in the machine's zone), no network, no wait without a timeout, no subclassing of a
concrete `XCTestCase`. A line that truly needs an exception says why on that line, with
`// test-rules: allow <reason>`. The rest of the list still needs a reader.

1. **Assert the outcome, not that something ran.** Check the returned value, the request that
   was sent, the saved file; not just that a handler or callback was called.
2. **Pair "X didn't happen" with "Y did".** An absence check alone also passes when nothing
   happens at all.
3. **Assert the precondition the test depends on.** If the point is "the calendar survives a
   bad answer", also assert the good calendar was there first.
4. **Assert every output.** If a function returns several values, compare all of them, or
   "only a change" goes untested.
5. **Take expected values from the source of truth**: the published API guide, a literal, a
   file on disk. Never rebuild the expectation with the code's own rule.
6. **Cover the whole set, not the instance a review named.** If one field, one weak id check
   or one request is flagged, find the others in the same change.
7. **A parity or differential test also asserts the expected result.** "Both agree" passes
   when both are wrong the same way.
8. **Cure a tautological test with an independent expected value** (a published fact, a
   literal), never with a weaker assertion such as "any valid timestamp".
9. **Pin both sides of every threshold** (accepted just inside, refused just outside; e.g. the
   30-minute walk warning), and test isolation in both directions (one sign-in's saved calendar
   is not shown to another, and the reverse).
10. **Don't depend on the wall clock or the machine's time zone.** Pass `now` and the time
    zone in. A fixed date that happens to be in the future can pass against the bug.
11. **Guarantees about what is stored or sent** (tokens in the keychain only, nothing sent to
    anyone but AWS) are asserted on what the real entry point writes or sends, not on a
    helper's return value.
12. **No test touches the network.** Every request goes through `ScriptedTransport` in
    `TestSupport.swift`; anything that waits has a timeout.
13. **Share fixtures through helpers in `TestSupport.swift`**, never by subclassing a concrete
    `XCTestCase` (that runs its tests twice). After adding tests, check the "Executed N tests"
    count went up by exactly the number you added.

## Code patterns

- **Identifiers go through one helper** that defines "usable" (right type, trimmed,
  non-blank) and downstream code uses the cleaned value. Look ups by id use exact keys.
- **A guard's threshold is fixed from the first trusted reading.** Later input that disagrees
  is itself a reason to refuse, never a reason to lower the bar.
- **A new sentinel value** (e.g. "no time yet") means checking every comparison it feeds for
  ties.
- **When a safeguard can itself fail, decide what happens then.** For saved data, refuse the
  destructive step (overwriting the saved calendar) until the safeguard succeeds.
- **When a function starts throwing**, check every caller, especially launch paths, so a bad
  saved file shows a message instead of a crash or an empty calendar.
- **Untrusted input is skipped and counted, never fatal**: a junk session record, a garbled
  speaker. An answer that is mostly junk is refused and the last good calendar is kept.
- **Logic that decides what the user sees belongs in `PlannerCore`, not in a SwiftUI view or
  `AppModel`**, so it can be tested. The screens, sign-in sheet and keychain code have no
  automated tests; keep them thin.

## Mutation checks

When a test is meant to guard a line, break that line in a scratch copy and run the suite:
the test must fail. A mutation that didn't apply, or that fails to compile, proves nothing:
confirm the edit applied and the package builds (`swift build`) before counting failures.

## Before you push

Reviews keep finding the same things, and almost all of them can be found before the push.
CodeRabbit costs the owner money and time, and its allowance is limited (its summary comment
says how many reviews remain), so it is the last review a change gets, not the first: review
the change ourselves, and send it to CodeRabbit once.

1. **Review the diff ourselves first.** Three passes, all before the PR is marked ready:
   - Re-read the diff by hand as a reviewer would, with "Tests that can't pass for the wrong
     reason" and the path instructions in `.coderabbit.yaml` open, and check every new test
     against the rules by number. When one instance of a problem turns up, list the others in
     the same file yourself (rule 6).
   - Run the `/code-review` skill on the diff.
   - Give the diff to a fresh reviewer that has none of the session's context (a subagent
     started with the files and the rules here, never with your conclusions), and have it probe
     the code with inputs of its own. It finds what the author's context hides.

   Don't run the `coderabbit` CLI (`coderabbit review`) without asking the owner first: it is
   tied to the owner's account, and whether it counts against the allowance is not known.
2. **Run it, don't guess it.** An expected value in a test (a return value, a count, a message)
   comes from running the code once and judging the result, or from a published fact; never from
   memory. Copy commit SHAs, thread ids and other identifiers from tool output; never type or
   complete one from memory.
3. **Open as a draft, mark ready once, one push per review.** Open every PR as a draft
   (`gh pr create --draft`): CodeRabbit doesn't review a draft, so nothing is spent while our
   own review is still finding things. Mark it ready when that review is clean and the owner
   wants CodeRabbit's. If CodeRabbit skips that first review ("Review limit reached"), nothing
   was pushed and nothing will retry it: wait for the time its comment gives, then ask for the
   review with a PR comment, `@coderabbitai review`. After a review, fix everything it raised
   locally (every open thread, conflicts, nits that cite a rule here), then push once: one
   batched push per review, never a string of small ones. If the review of that push finds
   something new, the same applies again (the merge gate still needs every thread resolved), so
   a further batched push is allowed. Before any push, read the PR's latest CodeRabbit comment:
   if it says "Review limit reached", wait for the time it gives unless the push is needed to
   unblock something. Pushing to several PRs in the same hour starves all of them; order them
   by what is waiting to merge. Replies and "resolved" don't use a review, so answer a thread
   once its fix is pushed and name the commit.
4. **Read the PR first.** Before changing a PR or acting on a finding, read all its threads and
   the issues it links to or is linked from. A decision recorded there ("deferred to #89", "keep
   the owner's wording") outranks a bot finding or a task list; if your change would reverse one,
   stop and ask. Check that a finding's premise is still the owner's current requirement (an
   issue's first wording can be superseded by a later instruction).
