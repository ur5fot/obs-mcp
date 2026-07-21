#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  DEFAULT_PRIVATE_SCENE,
  ObsWebSocketClient,
  SWITCH_CONFIRM,
  parseAllowedScenes,
  requireSceneSwitchAllowed,
} from './obs-api.js';

const SERVER_INFO = {
  name: 'obs-mcp',
  version: '0.1.0',
};

const tools = [
  {
    name: 'obs_get_status',
    description: 'Read OBS version, current scene, stream status, and recording status through local OBS WebSocket.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'obs_get_scene_list',
    description: 'Read OBS scenes and current program/preview scene through local OBS WebSocket.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'obs_switch_to_private',
    description: 'Emergency switch to OBS private/hide scene. Defaults to OBS_PRIVATE_SCENE or "5 Private / Hide Screen".',
    inputSchema: {
      type: 'object',
      properties: {
        sceneName: {
          type: 'string',
          description: 'Private scene name. Defaults to OBS_PRIVATE_SCENE or "5 Private / Hide Screen".',
        },
      },
      additionalProperties: false,
    },
    annotations: { destructiveHint: true },
  },
  {
    name: 'obs_switch_scene',
    description: `Switch OBS program scene. Requires OBS_SCENE_SWITCH_ENABLED=true, allowed scene list, and confirm="${SWITCH_CONFIRM}".`,
    inputSchema: {
      type: 'object',
      properties: {
        sceneName: {
          type: 'string',
          description: 'Exact OBS scene name to switch to.',
        },
        confirm: {
          type: 'string',
          description: `Required confirm token: ${SWITCH_CONFIRM}`,
        },
      },
      required: ['sceneName'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true },
  },
];

function textResult(value, isError = false) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return {
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {}),
  };
}

async function withObs(callback) {
  const obs = new ObsWebSocketClient();
  await obs.connect();
  try {
    return await callback(obs);
  } finally {
    await obs.disconnect();
  }
}

async function callTool(name, args) {
  switch (name) {
    case 'obs_get_status':
      return withObs((obs) => obs.getStatus());
    case 'obs_get_scene_list':
      return withObs((obs) => obs.getSceneList());
    case 'obs_switch_to_private': {
      const sceneName = args.sceneName ?? process.env.OBS_PRIVATE_SCENE ?? DEFAULT_PRIVATE_SCENE;
      if (!parseAllowedScenes(process.env.OBS_ALLOWED_SCENES).includes(sceneName)) {
        throw new Error(`Private scene is not in OBS_ALLOWED_SCENES: ${sceneName}`);
      }
      return withObs((obs) => obs.setCurrentProgramScene(sceneName));
    }
    case 'obs_switch_scene':
      requireSceneSwitchAllowed(args.sceneName, { confirm: args.confirm });
      return withObs((obs) => obs.setCurrentProgramScene(args.sceneName));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const value = await callTool(
      request.params.name,
      request.params.arguments ?? {},
    );
    return textResult(value);
  } catch (error) {
    return textResult(error instanceof Error ? error.message : String(error), true);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
