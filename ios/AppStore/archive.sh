#!/bin/sh
# Builds the Session Planner release archive, and with a paid team exports it for the App Store.
#
#   ios/AppStore/archive.sh
#       Unsigned release archive. Proves the release build is sound; cannot be submitted.
#
#   TEAM=ABCDE12345 ios/AppStore/archive.sh
#       Signed archive, exported as an .ipa for App Store Connect. Uploads nothing.
#       TEAM is the 10-character id of a paid Apple Developer Program team that Xcode is
#       signed in to (Xcode > Settings > Accounts). A free Personal Team cannot do this.
#
#   TEAM=ABCDE12345 UPLOAD=1 ios/AppStore/archive.sh
#       The same, and uploads the build to App Store Connect. It then appears under
#       TestFlight after Apple finishes processing it; submitting for review is done there.
#
#   BUILD=2 ...   sets the build number. Apple refuses a number it has already seen for the
#                 same version, so raise it for every upload.
#
#   HONEYCOMB_KEY=hcaik_... ...   puts the send-only Honeycomb ingest key in the build, so it
#                 can send how suggestions work, only if the attendee agrees (#193). Without
#                 it the build asks nothing and sends nothing. HONEYCOMB_DATASET names the
#                 dataset (default session-planner). The key is written to
#                 ios/SessionPlanner/Honeycomb.plist only while the build runs; git ignores it.
#
# The team id and the Honeycomb key are passed on the command line on purpose, so they are
# never written into this public repository.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
ios=$(dirname "$here")
out="$ios/build"
archive="$out/SessionPlanner.xcarchive"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"

rm -rf "$archive" "$out/export"
mkdir -p "$out"

# The Honeycomb key goes in only for this build: a file left from an earlier run is removed
# first, so a build without HONEYCOMB_KEY never carries an old key.
honeycomb="$ios/SessionPlanner/Honeycomb.plist"
rm -f "$honeycomb"
if [ -n "${HONEYCOMB_KEY:-}" ]; then
    # The app refuses a key with a space or control character in it and would send nothing.
    case "$HONEYCOMB_KEY" in
        *[[:space:]]*|*[[:cntrl:]]*) echo "HONEYCOMB_KEY holds a space or control character; the app would refuse it." >&2; exit 1 ;;
    esac
    trap 'rm -f "$honeycomb"' EXIT
    plutil -create xml1 "$honeycomb"
    plutil -insert IngestKey -string "$HONEYCOMB_KEY" "$honeycomb"
    plutil -insert Dataset -string "${HONEYCOMB_DATASET:-session-planner}" "$honeycomb"
    echo "Honeycomb key included (dataset ${HONEYCOMB_DATASET:-session-planner})."
else
    echo "No HONEYCOMB_KEY: this build sends nothing to Honeycomb."
fi

set -- -project "$ios/SessionPlanner.xcodeproj" -scheme SessionPlanner -configuration Release \
    -destination 'generic/platform=iOS' -archivePath "$archive"
if [ -n "${BUILD:-}" ]; then
    set -- "$@" "CURRENT_PROJECT_VERSION=$BUILD"
fi

if [ -z "${TEAM:-}" ]; then
    echo "Building an unsigned release archive (set TEAM to sign and export)."
    xcodebuild archive "$@" CODE_SIGNING_ALLOWED=NO
    echo "Unsigned archive: $archive"
    exit 0
fi

echo "Building a signed release archive for team $TEAM."
xcodebuild archive "$@" -allowProvisioningUpdates "DEVELOPMENT_TEAM=$TEAM" CODE_SIGN_STYLE=Automatic

destination=export
if [ "${UPLOAD:-}" = "1" ]; then
    destination=upload
fi
options="$out/ExportOptions.plist"
cat > "$options" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key>
	<string>app-store-connect</string>
	<key>destination</key>
	<string>$destination</string>
	<key>teamID</key>
	<string>$TEAM</string>
	<key>signingStyle</key>
	<string>automatic</string>
	<key>manageAppVersionAndBuildNumber</key>
	<false/>
	<key>uploadSymbols</key>
	<true/>
</dict>
</plist>
EOF

xcodebuild -exportArchive -archivePath "$archive" -exportOptionsPlist "$options" \
    -exportPath "$out/export" -allowProvisioningUpdates

if [ "$destination" = "upload" ]; then
    echo "Uploaded. Look for the build under TestFlight in App Store Connect once processing ends."
else
    echo "Exported for the App Store: $out/export"
    echo "Nothing was uploaded. Run again with UPLOAD=1 to send it to App Store Connect."
fi
