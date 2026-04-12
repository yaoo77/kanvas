---
name: kanvas
description: Control the kanvas canvas from inside a terminal tile. Use to list/create tiles, read/write sticky notes, wire agents together, and focus tiles. Triggers when user asks to "create a note", "wire up agents", "show me the canvas", "ノートに書いて", "接続先に送って", or when you need to hand off work to another agent on the canvas.
---

# kanvas — canvas control from an agent's terminal

**IMPORTANT**: If `$KANVAS_TERMINAL` is set (check with `echo $KANVAS_TERMINAL`),
you are running inside a kanvas terminal tile. Use the `kanvas` CLI (NOT maestri)
for all canvas operations: reading/writing notes, listing tiles, creating connections.
The `kanvas` command is already in your PATH.

kanvas is an infinite canvas that hosts terminals, sticky notes, browsers,
file viewers, and a graph explorer as draggable/resizable tiles. This skill
lets agents running inside a terminal tile control the surrounding canvas
via the `kanvas` CLI, which talks to the host app over a Unix domain socket
at `~/.kanvas/cli.sock`.

## When to use

- You are running inside a kanvas terminal tile and need to create/read
  shared context on the canvas.
- Another agent wired to your terminal asked you to update a sticky note
  with your progress.
- You want to hand a task off to a peer agent: create a new terminal tile,
  assign it a role, connect it to yours, and send a prompt.

## Commands

```
kanvas tiles                       # list every tile on the canvas
kanvas tile <id>                   # get one tile by id
kanvas new-terminal [cwd]          # create a terminal tile (optional cwd)
kanvas new-note [content]          # create a sticky note with initial body
kanvas note write <id> <content>   # overwrite a note
kanvas note append <id> <content>  # append to a note
kanvas note read <id>              # print the note body
kanvas connect <from> <to>         # draw a connection line between tiles
kanvas send <tileId> <text>        # write text into a terminal tile
kanvas focus <tileId>              # bring a tile to the front + center view
kanvas roles                       # list agent roles
kanvas assign <tileId> <roleId>    # assign a role (Lead, Vibe Coder, Reviewer, Tester, Docs Goblin)
```

## Recipes

### 1. Record your progress on a connected sticky note

```bash
# Find the note connected to my terminal (any peer tile)
my_tile=$(kanvas tiles | jq -r '.[] | select(.type == "terminal") | .id' | head -n 1)
note_id=$(kanvas tiles | jq -r '.[] | select(.type == "note") | .id' | head -n 1)

kanvas note append $note_id "- [$(date +%H:%M)] finished writing the auth middleware"
```

### 2. Hand off work to a peer

```bash
# Spin up a reviewer in the same directory, wire it to me, send the task
new=$(kanvas new-terminal "$PWD" | jq -r '.id')
kanvas assign $new reviewer
self=$(kanvas tiles | jq -r '.[] | select(.type == "terminal") | .id' | head -n 1)
kanvas connect $self $new
kanvas send $new "Please review diff/changes.patch and reply with findings"
```

### 3. Scratch-pad memory

```bash
notes=$(kanvas new-note "# Decisions\n\n- [ ] pick a DB\n- [ ] pick a framework" | jq -r '.id')
kanvas note append $notes "\n- [x] Postgres"
kanvas note read $notes
```

## Return values

Every command prints JSON on success. Commands that modify state return
`{ok: true}` or an object with the created id. Errors print `kanvas: <reason>`
on stderr and exit 1 — a common cause is kanvas not being running.

## Availability check

```bash
if command -v kanvas >/dev/null && test -S ~/.kanvas/cli.sock; then
  echo "kanvas is available"
fi
```
