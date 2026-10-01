#!/bin/bash
set -euo pipefail

project_root="$(cd "$(dirname "$0")/.." && pwd)"
version="$(node -p "require('$project_root/package.json').version")"
output_dir="$project_root/dist/mac"
working_dir="$(mktemp -d)"
trap 'rm -rf "$working_dir"' EXIT
sdk_path="$(xcrun --sdk macosx --show-sdk-path)"
if xcrun swiftc --version | grep -q 'Apple Swift version 5.7.2' && \
    [ -d /Library/Developer/CommandLineTools/SDKs/MacOSX12.3.sdk ]; then
    sdk_path=/Library/Developer/CommandLineTools/SDKs/MacOSX12.3.sdk
fi

app="$working_dir/WPS 文本校对.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources/addon" "$output_dir"
for item in index.html main.js ribbon.xml package.json; do
    cp "$project_root/$item" "$app/Contents/Resources/addon/$item"
done
cp -R "$project_root/js" "$project_root/ui" "$project_root/rules" "$app/Contents/Resources/addon/"

cat > "$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>WPS 文本校对</string>
<key>CFBundleDisplayName</key><string>WPS 文本校对</string>
<key>CFBundleIdentifier</key><string>net.wps-proofreading.mac</string>
<key>CFBundleVersion</key><string>$version</string>
<key>CFBundleShortVersionString</key><string>$version</string>
<key>CFBundleExecutable</key><string>WPSProofreading</string>
<key>LSMinimumSystemVersion</key><string>11.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
EOF

for arch in x86_64 arm64; do
    xcrun swiftc -O -sdk "$sdk_path" \
        -module-cache-path "$working_dir/swift-module-cache" -target "$arch-apple-macos11.0" \
        "$project_root/mac/ProofreadingApp.swift" -o "$working_dir/WPSProofreading-$arch"
done
lipo -create "$working_dir/WPSProofreading-x86_64" "$working_dir/WPSProofreading-arm64" \
    -output "$app/Contents/MacOS/WPSProofreading"
sign_identity="${MAC_SIGN_IDENTITY:--}"
if [ "$sign_identity" = "-" ]; then
    codesign --force --deep --sign - "$app"
else
    codesign --force --deep --options runtime --sign "$sign_identity" "$app"
fi
"$app/Contents/MacOS/WPSProofreading" --self-test

staging="$working_dir/dmg"
mkdir -p "$staging"
cp -R "$app" "$staging/"
ln -s /Applications "$staging/应用程序"
cp "$project_root/mac/安装说明.txt" "$staging/安装说明.txt"
cp "$project_root/LICENSE" "$project_root/THIRD_PARTY_NOTICES.md" \
    "$project_root/SOURCE_PROVENANCE.md" "$staging/"
hdiutil create -quiet -volname "WPS 文本校对 $version" -srcfolder "$staging" \
    -format UDZO -ov "$output_dir/WPS-文本校对-$version-macOS.dmg"
echo "$output_dir/WPS-文本校对-$version-macOS.dmg"
