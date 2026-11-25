#!/bin/sh
# Xcode Cloud runs this before every xcodebuild action (Apple: "Writing custom build scripts").
#
# For an archive, it puts the Honeycomb ingest key into the build the way ios/AppStore/archive.sh
# does on a Mac: as ios/SessionPlanner/Honeycomb.plist, which the app reads and git ignores. The
# key comes from the workflow's secret environment variable HONEYCOMB_KEY (and optionally
# HONEYCOMB_DATASET); it is never written into the repository. Without a key the build neither
# asks the attendee nor sends anything, as with archive.sh.
set -eu

repo="${CI_PRIMARY_REPOSITORY_PATH:?not running in Xcode Cloud}"
plist="$repo/ios/SessionPlanner/Honeycomb.plist"
rm -f "$plist"

if [ "${CI_XCODEBUILD_ACTION:-}" != "archive" ]; then
    exit 0
fi

if [ -z "${HONEYCOMB_KEY:-}" ]; then
    echo "No HONEYCOMB_KEY: this build sends nothing to Honeycomb."
    exit 0
fi

# The app refuses a key with a space or control character in it and would send nothing.
case "$HONEYCOMB_KEY" in
    *[[:space:]]*|*[[:cntrl:]]*)
        echo "HONEYCOMB_KEY holds a space or control character; the app would refuse it." >&2
        exit 1 ;;
esac

# It also refuses a dataset of anything but ASCII letters, digits, ".", "_" and "-", or of
# dots alone (HoneycombConfig in EventLog.swift; it trims spaces first, this script refuses them).
dataset="${HONEYCOMB_DATASET:-session-planner}"
case "$dataset" in
    *[!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-]*)
        echo "HONEYCOMB_DATASET may hold only ASCII letters, digits, \".\", \"_\" and \"-\", with no spaces." >&2
        exit 1 ;;
    *[!.]*) ;;
    *)
        echo "HONEYCOMB_DATASET is dots alone; the app would refuse it." >&2
        exit 1 ;;
esac

plutil -create xml1 "$plist"
plutil -insert IngestKey -string "$HONEYCOMB_KEY" "$plist"
plutil -insert Dataset -string "$dataset" "$plist"
echo "Honeycomb key included (dataset $dataset)."
