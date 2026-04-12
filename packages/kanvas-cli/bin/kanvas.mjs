#!/usr/bin/env node
/**
 * kanvas CLI — agent-facing control surface for kanvas canvas app.
 *
 * Communicates with the running kanvas Electron app via a Unix domain
 * socket at ~/.kanvas/cli.sock using newline-delimited JSON.
 *
 * Commands:
 *   kanvas tiles                       — list open tiles
 *   kanvas tile get <id>               — get one tile
 *   kanvas new-terminal [cwd]          — create a terminal tile
 *   kanvas new-note [content]          — create a sticky note
 *   kanvas note write <id> <content>   — overwrite a note
 *   kanvas note append <id> <content>  — append to a note
 *   kanvas note read <id>              — read a note
 *   kanvas connect <from> <to>         — draw a connection between tiles
 *   kanvas send <tileId> <text>        — send text to a terminal
 *   kanvas focus <tileId>              — bring a tile to the front
 *   kanvas roles                       — list agent roles
 *   kanvas assign <tileId> <roleId>    — assign a role
 */

import net from 'node:net'
import path from 'node:path'
import os from 'node:os'

const SOCK = path.join(os.homedir(), '.kanvas', 'cli.sock')

async function request(method, params = {}) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(SOCK)
    let buf = ''
    client.on('data', (d) => { buf += d.toString() })
    client.on('end', () => {
      try {
        const res = JSON.parse(buf)
        if (res.error) reject(new Error(res.error))
        else resolve(res.result)
      } catch (e) { reject(e) }
    })
    client.on('error', (e) => reject(e))
    client.write(JSON.stringify({ method, params }) + '\n')
    client.end()
  })
}

function usage() {
  console.error(`
Usage: kanvas <command> [args]

Commands:
  tiles                           List all tiles
  tile <id>                       Get a single tile
  new-terminal [cwd]              Create a terminal tile
  new-note [content]              Create a sticky note
  note write <id> <content>       Overwrite a note
  note append <id> <content>      Append to a note
  note read <id>                  Read a note
  connect <from> <to>             Connect two tiles
  send <tileId> <text>            Send text to a terminal
  focus <tileId>                  Focus a tile
  roles                           List agent roles
  assign <tileId> <roleId>        Assign role to tile

Communicates with kanvas via ${SOCK}
`.trim())
  process.exit(1)
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  if (!cmd) usage()

  try {
    let result
    switch (cmd) {
      case 'tiles':
        result = await request('tiles.list')
        break
      case 'tile':
        result = await request('tile.get', { id: rest[0] })
        break
      case 'new-terminal':
        result = await request('tile.create', { type: 'terminal', cwd: rest[0] })
        break
      case 'new-note': {
        const content = rest.join(' ')
        result = await request('tile.create', { type: 'note', noteContent: content })
        break
      }
      case 'note':
        if (rest[0] === 'write') result = await request('note.write', { id: rest[1], content: rest.slice(2).join(' ') })
        else if (rest[0] === 'append') result = await request('note.append', { id: rest[1], content: rest.slice(2).join(' ') })
        else if (rest[0] === 'read') result = await request('note.read', { id: rest[1] })
        else usage()
        break
      case 'connect':
        result = await request('connection.create', { from: rest[0], to: rest[1] })
        break
      case 'send':
        result = await request('terminal.send', { id: rest[0], text: rest.slice(1).join(' ') })
        break
      case 'focus':
        result = await request('tile.focus', { id: rest[0] })
        break
      case 'roles':
        result = await request('roles.list')
        break
      case 'assign':
        result = await request('role.assign', { id: rest[0], roleId: rest[1] })
        break
      case 'events':
        result = await request('events.list')
        break
      case 'floors':
        if (rest[0] === 'list' || !rest[0]) result = await request('floors.list')
        else if (rest[0] === 'create') result = await request('floors.create', { name: rest[1] || 'floor', sourceDir: rest[2] })
        else if (rest[0] === 'remove') result = await request('floors.remove', { id: rest[1] })
        else usage()
        break
      default:
        usage()
    }
    console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2))
  } catch (err) {
    console.error(`kanvas: ${err.message}`)
    console.error(`  Is kanvas running? (Socket: ${SOCK})`)
    process.exit(1)
  }
}

main()
