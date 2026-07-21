#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  ObsWebSocketClient,
  SWITCH_CONFIRM,
  parseAllowedScenes,
  requirePrivateScene,
  requireSceneSwitchAllowed,
} from './obs-api.js';

const SERVER_INFO = {
  name: 'obs-mcp',
  version: '0.1.0',
};

export const tools = [
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
    description: 'Emergency switch to OBS private/hide scene. Takes no arguments: the target scene is OBS_PRIVATE_SCENE.',
    inputSchema: {
      type: 'object',
      properties: {},
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
  try {
    await obs.connect();
    return await callback(obs);
  } finally {
    await obs.disconnect();
  }
}

async function callTool(name, args, { connect = withObs } = {}) {
  switch (name) {
    case 'obs_get_status':
      return connect((obs) => obs.getStatus());
    case 'obs_get_scene_list':
      return connect((obs) => obs.getSceneList());
    case 'obs_switch_to_private': {
      // This tool deliberately bypasses both OBS_SCENE_SWITCH_ENABLED and the
      // confirm token, so it takes no scene from the caller: an argument here
      // would open every allow-listed scene (full-screen capture included) to
      // any session with no gate at all. Target is OBS_PRIVATE_SCENE, and the
      // allow list stays as the second check.
      const sceneName = requirePrivateScene();
      if (!parseAllowedScenes(process.env.OBS_ALLOWED_SCENES).includes(sceneName)) {
        throw new Error(`Private scene is not in OBS_ALLOWED_SCENES: ${sceneName}`);
      }
      return connect((obs) => obs.setCurrentProgramScene(sceneName));
    }
    case 'obs_switch_scene':
      requireSceneSwitchAllowed(args.sceneName, { confirm: args.confirm });
      return connect((obs) => obs.setCurrentProgramScene(args.sceneName));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/** Runs a tool and formats both success and failure the way MCP clients see it. */
export async function handleToolCall(name, args = {}, options = {}) {
  try {
    return textResult(await callTool(name, args, options));
  } catch (error) {
    return textResult(error instanceof Error ? error.message : String(error), true);
  }
}

function isMainModule() {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(entry).href;
}

if (isMainModule()) {
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => handleToolCall(
    request.params.name,
    request.params.arguments ?? {},
  ));

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
