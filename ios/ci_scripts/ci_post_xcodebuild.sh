#!/bin/sh
# Xcode Cloud runs this after every xcodebuild action (Apple: "Writing custom build scripts").
#
# After the pull-request workflow's Build action, it runs PlannerCore's tests, the same
# `swift test` as .github/workflows/ios-tests.yml; a failure fails the Xcode Cloud build. After
# an archive it removes the key file, though Xcode Cloud discards the build machine anyway.
set -eu

repo="${CI_PRIMARY_REPOSITORY_PATH:?not running in Xcode Cloud}"
rm -f "$repo/ios/SessionPlanner/Honeycomb.plist"

if [ "${CI_XCODEBUILD_ACTION:-}" = "build" ] && [ "${CI_XCODEBUILD_EXIT_CODE:-0}" = "0" ]; then
    swift test --package-path "$repo/ios/PlannerCore"
fi
