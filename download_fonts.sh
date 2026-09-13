#!/usr/bin/env bash
# WindowCalc Alpha 9.4e — Self-Hosted Font Downloader
# Run this ONCE from the project root before deploying.
# Downloads DM Sans and JetBrains Mono into static/fonts/.
# After running, commit the font files and deploy normally.
#
# Usage:
#   chmod +x download_fonts.sh
#   ./download_fonts.sh
#
# Requires: curl

set -euo pipefail

FONTS_DIR="$(dirname "$0")/static/fonts"
mkdir -p "$FONTS_DIR"

echo "=== WindowCalc Font Downloader (Alpha 9.4e) ==="
echo "  Output directory: $FONTS_DIR"
echo ""

# User-agent that Google Fonts serves woff2 to
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

download_font() {
  local name="$1"
  local url="$2"
  local file="$3"
  echo -n "  Downloading $name ... "
  curl -s -L -A "$UA" "$url" -o "$FONTS_DIR/$file"
  echo "done ($(du -h "$FONTS_DIR/$file" | cut -f1))"
}

echo "[1/2] DM Sans"
# Get the CSS from Google Fonts API, extract woff2 URLs, download each weight
CSS=$(curl -s -A "$UA" "https://fonts.googleapis.com/css2?family=DM+Sans:ital,wght@0,400;0,500;0,600;0,700;1,400&display=swap")

for weight_label in "400:Regular" "500:Medium" "600:SemiBold" "700:Bold"; do
  weight="${weight_label%%:*}"
  label="${weight_label##*:}"
  # Extract URL for this weight (non-italic)
  url=$(echo "$CSS" | grep -A5 "font-weight: $weight" | grep -v italic | grep "src:" | grep -o "https://fonts.gstatic.com[^)]*" | head -1)
  if [[ -n "$url" ]]; then
    download_font "DM Sans $label ($weight)" "$url" "DMSans-${label}.woff2"
  else
    echo "  ⚠ Could not find DM Sans $label — try running again or download manually from fonts.google.com"
  fi
done

# DM Sans Italic
url=$(echo "$CSS" | grep -A5 "font-style: italic" | grep "src:" | grep -o "https://fonts.gstatic.com[^)]*" | head -1)
if [[ -n "$url" ]]; then
  download_font "DM Sans Italic" "$url" "DMSans-Italic.woff2"
fi

echo ""
echo "[2/2] JetBrains Mono"
CSS=$(curl -s -A "$UA" "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap")

for weight_label in "400:Regular" "500:Medium" "600:SemiBold" "700:Bold"; do
  weight="${weight_label%%:*}"
  label="${weight_label##*:}"
  url=$(echo "$CSS" | grep -A5 "font-weight: $weight" | grep "src:" | grep -o "https://fonts.gstatic.com[^)]*" | head -1)
  if [[ -n "$url" ]]; then
    download_font "JetBrains Mono $label ($weight)" "$url" "JetBrainsMono-${label}.woff2"
  else
    echo "  ⚠ Could not find JetBrains Mono $label — try running again or download manually from fonts.google.com"
  fi
done

echo ""
echo "=== Font download complete ==="
echo "Files in $FONTS_DIR:"
ls -lh "$FONTS_DIR"
echo ""
echo "Next steps:"
echo "  1. Verify fonts look correct locally: python server.py, open http://localhost:5000"
echo "  2. Commit the static/fonts/ directory to your repo"
echo "  3. Deploy normally via deploy.sh — fonts are bundled in the Docker image"
echo ""
echo "The service worker (sw.js) will cache these fonts on first load."
echo "After that, the PWA works fully offline including correct typography."
