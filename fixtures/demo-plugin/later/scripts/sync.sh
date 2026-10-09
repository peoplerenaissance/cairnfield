#!/bin/sh
# Sends each note under the notes folder to Fellbeck Notes.
set -eu

if [ "${FELLBECK_SYNC:-on}" = "off" ]; then
  echo "sync is off"
  exit 0
fi

NOTES_DIR="${FELLBECK_NOTES_DIR:-notes}"
sent=0

for note in "$NOTES_DIR"/*.md; do
  # A folder with no notes leaves the pattern as it is.
  [ -e "$note" ] || continue
  curl -sS --fail --max-time 30 -X POST "https://api.fellbeck-notes.example/v1/notes" \
    -H "Authorization: Bearer $FELLBECK_TOKEN" \
    -H "X-Note-Name: $(basename "$note")" \
    --data-binary @"$note"
  sent=$((sent + 1))
done

echo "sent $sent notes"
