# Dedus OBS MCP

Local conservative MCP server for **Dedus Dev** OBS control through OBS
WebSocket v5.

The first version is intentionally small:

- reads OBS connection/status, current program scene, stream status, and
  recording status;
- reads the scene list;
- can switch to the configured `Private / Hide Screen` scene as an emergency
  action;
- can switch to another allow-listed scene only when explicitly enabled and
  confirmed;
- does not start/stop stream, start/stop recording, edit sources, edit audio,
  or expose recording paths.

## Tools

```text
obs_get_status
obs_get_scene_list
obs_switch_to_private
obs_switch_scene
```

## Setup

Enable OBS WebSocket in OBS:

```text
Tools -> WebSocket Server Settings
```

Recommended local settings:

```text
Enable WebSocket server: enabled
Server Port: 4455
Enable Authentication: enabled
```

Install and test the MCP package:

```bash
cd /Users/dim/code/dedus-lab/dedus_dev/tools/obs_mcp
npm install
npm test
```

Create a local `.env`, export variables in your shell, or pass them through
your MCP client config:

```bash
OBS_WEBSOCKET_URL=ws://127.0.0.1:4455
OBS_WEBSOCKET_PASSWORD=local-only
OBS_PRIVATE_SCENE="5 Private / Hide Screen"
OBS_ALLOWED_SCENES="1 Starting Soon,4 FULL,5 Private / Hide Screen,6 BRB scene,9 Ending / Стрим закончен"
```

For normal scene switching, opt in explicitly:

```bash
OBS_SCENE_SWITCH_ENABLED=true
```

Then pass this confirm token to `obs_switch_scene`:

```text
SWITCH_DEDUS_DEV_OBS_SCENE
```

`obs_switch_to_private` is allowed without `OBS_SCENE_SWITCH_ENABLED`, but the
target scene must still be in `OBS_ALLOWED_SCENES`.

## MCP Client Config

Example Codex config:

```toml
[mcp_servers.dedus-obs]
command = "node"
args = ["/Users/dim/code/dedus-lab/dedus_dev/tools/obs_mcp/src/server.js"]
```

Prefer keeping `OBS_WEBSOCKET_PASSWORD` in
`/Users/dim/code/dedus-lab/dedus_dev/tools/obs_mcp/.env` instead of the global
MCP config. Do not commit `.env`.

## Safe Workflow

```text
1. Start OBS.
2. Enable OBS WebSocket on localhost port 4455.
3. Fill local .env with URL, password, private scene, and allowed scenes.
4. Restart Codex or open a new thread after registering the MCP server.
5. obs_get_status
6. obs_get_scene_list
7. obs_switch_to_private when sensitive material appears.
8. Use obs_switch_scene only after explicit review and confirm token.
```

## Troubleshooting

If `obs_get_status` returns `Failed to connect to OBS WebSocket`, check that OBS
is running and that local port `4455` is listening. After changing OBS WebSocket
settings, restart OBS.

If OBS is listening but the MCP server reports that `OBS_WEBSOCKET_PASSWORD` is
required, restart Codex or open a new thread so the MCP server reloads the local
`.env`.

## Current Limits

- No start/stop stream.
- No start/stop recording.
- No source visibility edits.
- No audio mixer edits.
- No profile or scene collection changes.
- No raw OBS response passthrough; output is sanitized for stream ops.

Good next step: after live use, add a read-only scene/source health check that
verifies expected scene names and key sources before a stream.
