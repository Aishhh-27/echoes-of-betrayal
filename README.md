# Echoes of Betrayal

A complete, no-login multiplayer deduction game for 3–8 players. One Node.js web service serves both the interface and the authoritative WebSocket game server.

## Play flow

1. One player creates a room and shares its five-character code.
2. Three to eight crew members join with callsigns.
3. Each player privately receives their role and a signal fragment. Three different players use their fragments to tune the Echo System.
4. The crew investigates the shared evidence. The Saboteur can alter one evidence card once.
5. Crew members post theories, then cast secret votes. Ballots are not exposed until the final reveal.

The server assigns roles, retains role and clue data, validates each action and only sends private briefings to their owner. Room state is intentionally kept in memory; a service restart ends any active rooms. Reconnecting players can recover a session with their local session token, and a connected player becomes captain if the captain disconnects.

## Run locally

Requires Node.js 22 or newer.

```powershell
node server.js
```

Open `http://localhost:3000`. For the development runtime included in this workspace:

```powershell
.\work\runtime\node-v24.22.1-win-x64\node.exe server.js
```

## Automated multiplayer test

The repeatable integration test starts a disposable server and uses independent WebSocket clients:

```powershell
node test/multiplayer.mjs
```

It covers the 3-player start gate, private role delivery, puzzle completion from private fragments, role-based evidence tampering and its one-use limit, discussion notes, secret voting and final reveal, 8-player capacity, reconnecting, and captain handoff.

## Deployment

`render.yaml` configures one Render web service on the free plan. It serves the site and WebSockets from the same Node process. Render supports inbound WebSockets, but free instances can spin down after 15 minutes without traffic, can restart, and have ephemeral filesystems; active rooms can be lost on restart. The client sends a keepalive while connected.

To deploy, connect a Git provider and Render account, push this project to a repository, then create a Render Blueprint from that repository and select the free plan. The project has not been deployed yet because those provider connections are not available in this workspace.

