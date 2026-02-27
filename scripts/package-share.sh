#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

DATE_TAG="$(date +%Y%m%d-%H%M%S)"
ARCHIVE_NAME="mindscope-atlas-share-${DATE_TAG}"
ARCHIVE_PATH="${PROJECT_ROOT}/${ARCHIVE_NAME}.zip"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

if ! command -v git >/dev/null 2>&1; then
  echo "git is required to build the share package."
  exit 1
fi

if ! command -v zip >/dev/null 2>&1; then
  echo "zip is required to build the share package."
  exit 1
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "This script must be run inside a git repository."
  exit 1
fi

echo "Creating package from current HEAD..."
git archive --format=tar HEAD | tar -x -C "$TMP_DIR"

echo "Creating zip: $ARCHIVE_PATH"
(cd "$TMP_DIR" && zip -qr "$ARCHIVE_PATH" .)

echo "Done. Share this file with your friend:"
echo "$ARCHIVE_PATH"
echo
echo "On their machine:"
echo "1) unzip $ARCHIVE_NAME.zip"
echo "2) cd $ARCHIVE_NAME"
echo "3) cp .env.example .env and add their own keys"
echo "4) npm install"
echo "5) cd backend && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt && cd .."
echo "6) npm run dev:browser (or npm run dev)"
