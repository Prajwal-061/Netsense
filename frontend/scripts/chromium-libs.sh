#!/bin/sh
# Unpacks the system libraries headless Chromium needs into the user's cache,
# without root: apt-get download fetches the .deb files, dpkg -x extracts them.
# playwright.config.ts adds the folder to LD_LIBRARY_PATH when it exists.
# On a machine where `sudo npx playwright install-deps` is possible, use that.
set -e
DIR="$HOME/.cache/netsense-chromium-libs"
mkdir -p "$DIR/debs"
cd "$DIR/debs"
apt-get download libatk1.0-0t64 libatk-bridge2.0-0t64 libatspi2.0-0t64 libxcomposite1 \
  libxdamage1 libxfixes3 libxrandr2 libxrender1 libxi6 libgbm1 libasound2t64
for deb in *.deb; do dpkg -x "$deb" "$DIR/root"; done
echo "Unpacked into $DIR/root"
