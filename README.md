# Echoes of Betrayal

A no-login, real-time social deduction game for 3–8 players. A single Node.js application serves the responsive game and its authoritative WebSocket server.

## Public demo

Play at [https://echoes-of-betrayal.onrender.com](https://echoes-of-betrayal.onrender.com). Players do not need accounts.

## How to play

1. A captain creates a room and shares its five-character code.
2. Crew join with callsigns. The captain can launch only when at least **three players are connected**; up to eight players may join.
3. Each player receives a private role and clue. Three different players use their clues to tune the Echo System.
4. The crew investigates shared evidence. The saboteur can alter one evidence card once.
5. Players discuss theories and vote secretly. Results appear after every eligible connected player votes, or an uncast ballot becomes an abstention if its player disconnects.

The server assigns roles, keeps private clues server-side, and validates game actions. Reconnecting with the saved browser session token restores the same player and role. A connected crew member becomes captain if the captain disconnects.

## Room and reconnect policy

Room state is held in server memory. A room remains available while any player is connected. After the last player disconnects, the room and its reconnect credentials are retained for `ROOM_RECONNECT_GRACE_MS` (five minutes by default). Reconnecting during that window restores the room and restarts the grace period. When the full grace period passes with no connected players, the server expires the room; later reconnect attempts receive a room-unavailable message. Returning to entry only disconnects that player and does not end a game for connected crew.

**Known limitation:** a server restart clears all in-memory rooms immediately, regardless of the reconnect grace period. The service may restart or sleep as part of hosting, so a live session can be lost.

## Run locally

Requires Node.js 22 or newer. There are no external runtime packages to install.

```sh
node server.js
```

Open [http://localhost:3000](http://localhost:3000). The captain must have at least three connected players before launching.

## Tests

Run the repeatable integration suite, which starts a disposable local server and connects independent WebSocket clients:

```sh
node test/multiplayer.mjs
node --check server.js
node --check public/app.js
git diff --check
```

The suite covers the three-connected-player launch gate, private roles, cooperative relay puzzle and ownership, evidence manipulation, discussion, secret voting and reveal, room capacity, reconnect and captain handoff, and abandoned-room expiration.

## Hosting

The public demo is hosted on Render using the single web service configured in `render.yaml`. The application serves both the site and persistent WebSocket connections from the same Node process. The client sends keepalives while connected. Render free instances may sleep or restart; because rooms are in memory, a restart loses active rooms.

