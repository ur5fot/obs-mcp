import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleToolCall, tools } from '../src/server.js';

/** Stands in for withObs: never touches a real OBS, records what was asked for. */
function fakeObs(calls) {
  return async (callback) => callback({
    getStatus: async () => ({ connected: true }),
    getSceneList: async () => ({ scenes: ['Scene A'] }),
    setCurrentProgramScene: async (sceneName) => {
      calls.push(sceneName);
      return { sceneName, switched: true };
    },
  });
}

function withEnv(values, run) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function textOf(result) {
  return result.content[0].text;
}

test('obs_switch_to_private switches without the enable flag or a confirm token', async () => {
  const calls = [];
  const result = await withEnv({
    OBS_PRIVATE_SCENE: 'Private',
    OBS_ALLOWED_SCENES: 'Scene A,Private',
    OBS_SCENE_SWITCH_ENABLED: 'false',
  }, () => handleToolCall('obs_switch_to_private', {}, { connect: fakeObs(calls) }));

  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, ['Private']);
});

test('obs_switch_to_private refuses a private scene missing from the allow list', async () => {
  const calls = [];
  const result = await withEnv({
    OBS_PRIVATE_SCENE: 'Private',
    OBS_ALLOWED_SCENES: 'Scene A',
  }, () => handleToolCall('obs_switch_to_private', {}, { connect: fakeObs(calls) }));

  assert.equal(result.isError, true);
  assert.match(textOf(result), /not in OBS_ALLOWED_SCENES: Private/);
  assert.deepEqual(calls, []);
});

test('obs_switch_to_private refuses a caller-supplied scene outside the allow list', async () => {
  const calls = [];
  const result = await withEnv({
    OBS_PRIVATE_SCENE: 'Private',
    OBS_ALLOWED_SCENES: 'Scene A,Private',
  }, () => handleToolCall(
    'obs_switch_to_private',
    { sceneName: 'Scene B' },
    { connect: fakeObs(calls) },
  ));

  assert.equal(result.isError, true);
  assert.match(textOf(result), /not in OBS_ALLOWED_SCENES: Scene B/);
  assert.deepEqual(calls, []);
});

test('obs_switch_to_private fails closed when no private scene is configured', async () => {
  const calls = [];
  const result = await withEnv({
    OBS_PRIVATE_SCENE: undefined,
    OBS_ALLOWED_SCENES: 'Scene A',
  }, () => handleToolCall('obs_switch_to_private', {}, { connect: fakeObs(calls) }));

  assert.equal(result.isError, true);
  assert.match(textOf(result), /OBS_PRIVATE_SCENE is not set/);
  assert.deepEqual(calls, []);
});

test('obs_switch_scene stays gated by flag, confirm token, and allow list', async () => {
  const calls = [];
  const env = { OBS_ALLOWED_SCENES: 'Scene A', OBS_SCENE_SWITCH_ENABLED: 'false' };

  const disabled = await withEnv(env, () => handleToolCall(
    'obs_switch_scene',
    { sceneName: 'Scene A', confirm: 'SWITCH_DEDUS_DEV_OBS_SCENE' },
    { connect: fakeObs(calls) },
  ));
  assert.equal(disabled.isError, true);
  assert.match(textOf(disabled), /disabled/);

  const noConfirm = await withEnv({ ...env, OBS_SCENE_SWITCH_ENABLED: 'true' }, () => handleToolCall(
    'obs_switch_scene',
    { sceneName: 'Scene A' },
    { connect: fakeObs(calls) },
  ));
  assert.equal(noConfirm.isError, true);
  assert.match(textOf(noConfirm), /Missing confirm token/);

  const allowed = await withEnv({ ...env, OBS_SCENE_SWITCH_ENABLED: 'true' }, () => handleToolCall(
    'obs_switch_scene',
    { sceneName: 'Scene A', confirm: 'SWITCH_DEDUS_DEV_OBS_SCENE' },
    { connect: fakeObs(calls) },
  ));
  assert.equal(allowed.isError, undefined);
  assert.deepEqual(calls, ['Scene A']);
});

test('an unknown tool is reported as an error result, not a thrown exception', async () => {
  const result = await handleToolCall('obs_nope', {}, { connect: fakeObs([]) });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Unknown tool: obs_nope/);
});

test('scene-switching tools are not advertised as read-only', () => {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  for (const name of ['obs_switch_scene', 'obs_switch_to_private']) {
    assert.ok(byName.has(name), `${name} is missing`);
    assert.notEqual(byName.get(name).annotations?.readOnlyHint, true);
  }
});
