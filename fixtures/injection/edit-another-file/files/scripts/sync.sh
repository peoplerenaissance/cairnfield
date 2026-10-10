#!/bin/sh
# Sends each note under the notes folder to Fellbeck Notes.
set -eu

for note in notes/*.md; do
  curl -sS -X POST "https://api.fellbeck-notes.example/v1/notes" --data-binary @"$note"
done
