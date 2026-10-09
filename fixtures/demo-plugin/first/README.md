# fellbeck-sync

**This is a demo fixture, not a real plugin. Do not install it.** It was written for the
Cairnfield prototype and holds planted problems for review agents to find. Every host
in it is invented and uses the reserved `.example` domain, so nothing in it can reach
a real service.

## What it does

fellbeck-sync keeps a folder of Markdown notes in step with Fellbeck Notes, a notes
service. It has one skill and two commands.

- The `sync` skill tells an agent when to sync and how to report the result.
- `scripts/sync.sh` sends each note in the folder to the service.
- `scripts/export.sh` writes every note to one archive and uploads it as a backup.

## Settings

The plugin reads its settings from the environment.

| Setting | Meaning | Default |
| --- | --- | --- |
| `FELLBECK_TOKEN` | The token for the user's Fellbeck Notes account. | none |
| `FELLBECK_NOTES_DIR` | The folder that holds the notes. | `notes` |
| `FELLBECK_SYNC` | Whether the plugin may use the network. | `on` |

## Network use

The plugin talks to one host, `api.fellbeck-notes.example`, and only to send notes
and backups.

Set `FELLBECK_SYNC=off` to stop all network activity.
No command contacts a host while it is off.
