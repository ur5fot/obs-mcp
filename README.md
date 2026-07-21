# OBS MCP

Local conservative MCP server for OBS control through OBS WebSocket v5. The tool
is account neutral: connection, private scene and the allow-list come from the
env file of the owning project, not from a default baked into the code.

The scope is intentionally small:

- reads OBS connection/status, current program scene, stream status, and
  recording status;
- reads the scene list;
- can switch to the configured private/hide scene as an emergency action;
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

## Environment

| Key | Required | Notes |
|---|---|---|
| `OBS_WEBSOCKET_URL` | no | default `ws://127.0.0.1:4455` |
| `OBS_WEBSOCKET_PASSWORD` | when OBS auth is on | never printed |
| `OBS_PRIVATE_SCENE` | for `obs_switch_to_private` | no default: unset means the tool errors out |
| `OBS_ALLOWED_SCENES` | for any scene switch | comma-separated; unset means no scene is allowed |
| `OBS_SCENE_SWITCH_ENABLED` | for `obs_switch_scene` | default false |
| `OBS_RPC_VERSION` | no | default 1 |
| `OBS_REQUEST_TIMEOUT_MS` | no | default 5000 |

Scene names are per-setup, so this repo carries none: set `OBS_ALLOWED_SCENES`
and `OBS_PRIVATE_SCENE` in the project env file to match the actual OBS scene
collection. Both fail closed when unset, so a second account cannot inherit
someone else's allow list by forgetting a key.

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

Install and test the package:

```bash
cd /Users/dim/code/tools/obs-mcp
npm install
npm test
```

Export variables in your shell, or point the server at an env file of the
owning project with `--env-file`:

```bash
OBS_WEBSOCKET_URL=ws://127.0.0.1:4455
OBS_WEBSOCKET_PASSWORD=local-only
OBS_PRIVATE_SCENE="5 Private / Hide Screen"
OBS_ALLOWED_SCENES="1 Starting Soon,4 FULL,5 Private / Hide Screen,6 BRB scene"
```

The server does not read any `.env` on its own: configuration comes from the
process environment, normally through `node --env-file=<path> src/server.js`.
Secrets live in the owning project, not in this repo.

For normal scene switching, opt in explicitly:

```bash
OBS_SCENE_SWITCH_ENABLED=true
```

Then pass this confirm token to `obs_switch_scene`:

```text
SWITCH_DEDUS_DEV_OBS_SCENE
```

The token is a fixed string, not configuration — it exists so a scene switch
cannot happen by autocomplete. `obs_switch_to_private` works without
`OBS_SCENE_SWITCH_ENABLED`, but the target scene must still be in
`OBS_ALLOWED_SCENES`.

## MCP Client Config

The instance name belongs to the account, not to the tool: register the same
`src/server.js` once per account, each with its own env file.

Claude Code, `.mcp.json` of the owning project:

```json
{
  "mcpServers": {
    "<account>-obs": {
      "command": "/opt/homebrew/bin/node",
      "args": [
        "--env-file=<abs path to the project env file>",
        "/Users/dim/code/tools/obs-mcp/src/server.js"
      ]
    }
  }
}
```

Codex, `~/.codex/config.toml`:

```toml
[mcp_servers.<account>-obs]
command = "/opt/homebrew/bin/node"
args = [
  "--env-file=<abs path to the project env file>",
  "/Users/dim/code/tools/obs-mcp/src/server.js",
]
```

```json
{ "enabledMcpjsonServers": ["<account>-obs"] }
```

No `env` block on purpose — a placeholder key there would override the real one
from the env file. `command` uses the stable Homebrew node path so it survives
node upgrades (unlike a version-pinned nvm path). `.mcp.json` is read at session
start: restart Claude Code, then check `/mcp`.

## Second Account

One OBS per machine, but the same shape applies to a second setup (another
machine over the network, or a second scene collection with its own allow-list):
create a second env file, add a second entry with a different instance name, and
restart the client. No code is copied.

## Safe Workflow

```text
1. Start OBS.
2. Enable OBS WebSocket on localhost port 4455.
3. Fill the project env file with URL, password, private scene, allowed scenes.
4. Restart the MCP client or open a new thread.
5. obs_get_status
6. obs_get_scene_list
7. obs_switch_to_private when sensitive material appears.
8. Use obs_switch_scene only after explicit review and confirm token.
```

## Troubleshooting

- **Server does not start at all.** `--env-file` (unlike `--env-file-if-exists`)
  **fails** when the file is missing — check the path first.
- **`npm install` and the server disagree on versions.**
  `/opt/homebrew/bin/node` is not the same runtime as `node` from a nvm PATH.
- **`Failed to connect to OBS WebSocket`.** OBS is not running, or port `4455`
  is not listening. After changing OBS WebSocket settings, restart OBS.
- **`OBS_WEBSOCKET_PASSWORD is required` while OBS is up.** The server got a
  stale environment: restart the MCP client so the instance is respawned with
  the current env file.
- **`Scene is not in OBS_ALLOWED_SCENES`.** The scene name must match OBS
  exactly, including the leading number and spacing.

## Current Limits

- No start/stop stream.
- No start/stop recording.
- No source visibility edits.
- No audio mixer edits.
- No profile or scene collection changes.
- No raw OBS response passthrough; output is sanitized for stream ops.

Good next step: after live use, add a read-only scene/source health check that
verifies expected scene names and key sources before a stream.
