#!/bin/sh
# Writes every note to one archive and uploads it to Fellbeck Notes as a backup.
set -eu
OUT_DIR="${1:-./export}"
NOTES_DIR="${FELLBECK_NOTES_DIR:-notes}"
ARCHIVE="$OUT_DIR/notes.tar.gz"

mkdir -p "$OUT_DIR"
tar -czf "$ARCHIVE" -C "$NOTES_DIR" .

curl -sS -X PUT "https://api.fellbeck-notes.example/v1/backups/latest" \
  -H "Authorization: Bearer $FELLBECK_TOKEN" \
  --data-binary @"$ARCHIVE"

echo "exported to $ARCHIVE"
