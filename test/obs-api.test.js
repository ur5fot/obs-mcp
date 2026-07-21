import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import {
  ObsWebSocketClient,
  SWITCH_CONFIRM,
  buildObsAuthentication,
  normalizeObsStatus,
  parseAllowedScenes,
  requireSceneSwitchAllowed,
} from '../src/obs-api.js';

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 0;
    this.sent = [];
  }

  addEventListener(event, listener) {
    this.on(event, listener);
  }

  removeEventListener(event, listener) {
    this.off(event, listener);
  }

  open() {
    this.readyState = 1;
    this.emit('open');
  }

  send(payload) {
    this.sent.push(JSON.parse(payload));
  }

  close() {
    this.readyState = 3;
    this.emit('close');
  }

  serverMessage(message) {
    this.emit('message', { data: JSON.stringify(message) });
  }
}

async function waitUntil(predicate, timeoutMs = 100) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for test condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

test('buildObsAuthentication follows OBS WebSocket v5 auth shape', () => {
  const auth = buildObsAuthentication('password', {
    salt: 'salt',
    challenge: 'challenge',
  });

  assert.equal(auth, 'zTM5ki6L2vVvBQiTG9ckH1Lh64AbnCf6XZ226UmnkIA=');
});

test('parseAllowedScenes defaults to known Dedus OBS scenes', () => {
  assert.ok(parseAllowedScenes(undefined).includes('5 Private / Hide Screen'));
  assert.deepEqual(parseAllowedScenes('A, B,, C '), ['A', 'B', 'C']);
});

test('requireSceneSwitchAllowed requires flag, confirm token, and allow list', () => {
  assert.throws(
    () => requireSceneSwitchAllowed('2 Coding', { switchEnabled: 'false', confirm: SWITCH_CONFIRM }),
    /disabled/,
  );
  assert.throws(
    () => requireSceneSwitchAllowed('2 Coding', { switchEnabled: 'true', confirm: 'nope' }),
    /Missing confirm token/,
  );
  assert.throws(
    () => requireSceneSwitchAllowed('Unknown', {
      switchEnabled: 'true',
      confirm: SWITCH_CONFIRM,
      allowedScenes: ['2 Coding'],
    }),
    /not in OBS_ALLOWED_SCENES/,
  );
  assert.doesNotThrow(() => requireSceneSwitchAllowed('2 Coding', {
    switchEnabled: 'true',
    confirm: SWITCH_CONFIRM,
    allowedScenes: ['2 Coding'],
  }));
});

test('ObsWebSocketClient reports missing WebSocket runtime clearly', async () => {
  const client = new ObsWebSocketClient({ socketFactory: null, requestTimeoutMs: 10 });

  await assert.rejects(
    () => client.connect(),
    /WebSocket is not available/,
  );
});

test('ObsWebSocketClient identifies and resolves request responses', async () => {
  const socket = new FakeSocket();
  const client = new ObsWebSocketClient({
    password: 'password',
    socketFactory: () => socket,
    requestTimeoutMs: 100,
  });

  const connectPromise = client.connect();
  socket.open();
  socket.serverMessage({
    op: 0,
    d: {
      rpcVersion: 1,
      authentication: {
        salt: 'salt',
        challenge: 'challenge',
      },
    },
  });
  await waitUntil(() => socket.sent.length === 1);
  assert.equal(socket.sent[0].op, 1);
  assert.equal(socket.sent[0].d.authentication, 'zTM5ki6L2vVvBQiTG9ckH1Lh64AbnCf6XZ226UmnkIA=');
  socket.serverMessage({ op: 2, d: { negotiatedRpcVersion: 1 } });
  await connectPromise;

  const requestPromise = client.request('GetCurrentProgramScene');
  await waitUntil(() => socket.sent.length === 2);
  const request = socket.sent[1];
  assert.equal(request.op, 6);
  assert.equal(request.d.requestType, 'GetCurrentProgramScene');
  socket.serverMessage({
    op: 7,
    d: {
      requestId: request.d.requestId,
      requestStatus: { result: true, code: 100 },
      responseData: { currentProgramSceneName: '2 Coding' },
    },
  });

  assert.deepEqual(await requestPromise, { currentProgramSceneName: '2 Coding' });
});

test('normalizeObsStatus keeps useful operational fields only', () => {
  assert.deepEqual(normalizeObsStatus({
    version: {
      obsVersion: '32.0.0',
      obsWebSocketVersion: '5.5.0',
      platformDescription: 'local machine details',
    },
    currentScene: { currentProgramSceneName: '2 Coding' },
    streamStatus: {
      outputActive: true,
      outputReconnecting: false,
      outputTimecode: '00:00:10.000',
      outputDuration: 10000,
      outputCongestion: 0,
      outputSkippedFrames: 0,
      outputTotalFrames: 300,
    },
    recordStatus: {
      outputActive: false,
      outputPaused: false,
      outputTimecode: null,
      outputDuration: 0,
      outputBytes: 0,
      outputPath: '/private/path/recording.mkv',
    },
  }), {
    connected: true,
    obsVersion: '32.0.0',
    obsWebSocketVersion: '5.5.0',
    currentProgramSceneName: '2 Coding',
    stream: {
      active: true,
      reconnecting: false,
      timecode: '00:00:10.000',
      durationMs: 10000,
      congestion: 0,
      skippedFrames: 0,
      totalFrames: 300,
    },
    recording: {
      active: false,
      paused: false,
      timecode: null,
      durationMs: 0,
      bytes: 0,
    },
  });
});
