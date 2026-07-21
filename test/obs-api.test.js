import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import {
  ObsWebSocketClient,
  SWITCH_CONFIRM,
  buildObsAuthentication,
  normalizeObsStatus,
  parseAllowedScenes,
  requirePrivateScene,
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

  rawMessage(data) {
    this.emit('message', { data });
  }

  fail() {
    this.emit('error', new Error('connect ECONNREFUSED'));
    this.close();
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

test('parseAllowedScenes is empty without OBS_ALLOWED_SCENES, so no scene is inherited', () => {
  assert.deepEqual(parseAllowedScenes(undefined), []);
  assert.deepEqual(parseAllowedScenes(''), []);
  assert.deepEqual(parseAllowedScenes('A, B,, C '), ['A', 'B', 'C']);
});

test('requirePrivateScene fails loudly instead of guessing a scene name', () => {
  assert.equal(requirePrivateScene('Private'), 'Private');

  const previous = process.env.OBS_PRIVATE_SCENE;
  process.env.OBS_PRIVATE_SCENE = 'Env Private';
  try {
    assert.equal(requirePrivateScene(undefined), 'Env Private');
    delete process.env.OBS_PRIVATE_SCENE;
    assert.throws(() => requirePrivateScene(undefined), /OBS_PRIVATE_SCENE is not set/);
  } finally {
    if (previous === undefined) delete process.env.OBS_PRIVATE_SCENE;
    else process.env.OBS_PRIVATE_SCENE = previous;
  }
});

test('requireSceneSwitchAllowed requires flag, confirm token, and allow list', () => {
  assert.throws(
    () => requireSceneSwitchAllowed('Scene A', { switchEnabled: 'false', confirm: SWITCH_CONFIRM }),
    /disabled/,
  );
  assert.throws(
    () => requireSceneSwitchAllowed('Scene A', { switchEnabled: 'true', confirm: 'nope' }),
    /Missing confirm token/,
  );
  assert.throws(
    () => requireSceneSwitchAllowed('Unknown', {
      switchEnabled: 'true',
      confirm: SWITCH_CONFIRM,
      allowedScenes: ['Scene A'],
    }),
    /not in OBS_ALLOWED_SCENES/,
  );
  assert.throws(
    () => requireSceneSwitchAllowed('Scene A', {
      switchEnabled: 'true',
      confirm: SWITCH_CONFIRM,
      allowedScenes: [],
    }),
    /OBS_ALLOWED_SCENES is not set/,
  );
  assert.doesNotThrow(() => requireSceneSwitchAllowed('Scene A', {
    switchEnabled: 'true',
    confirm: SWITCH_CONFIRM,
    allowedScenes: ['Scene A'],
  }));
});

test('ObsWebSocketClient reports missing WebSocket runtime clearly', async () => {
  const client = new ObsWebSocketClient({ socketFactory: null, requestTimeoutMs: 10 });

  await assert.rejects(
    () => client.connect(),
    /WebSocket is not available/,
  );
});

test('failed connect rejects without leaving an unhandled rejection behind', async () => {
  const socket = new FakeSocket();
  const client = new ObsWebSocketClient({
    socketFactory: () => socket,
    requestTimeoutMs: 50,
  });

  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  try {
    const connectPromise = client.connect();
    socket.fail();
    await assert.rejects(() => connectPromise, /OBS WebSocket/);
    // Let the microtask queue drain so a stray rejection would surface.
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(rejections, []);
    assert.equal(client.socket, null, 'socket must be closed when the handshake fails');
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});

test('malformed frame fails in-flight requests instead of crashing the process', async () => {
  const socket = new FakeSocket();
  const client = new ObsWebSocketClient({
    socketFactory: () => socket,
    requestTimeoutMs: 100,
  });

  const connectPromise = client.connect();
  socket.open();
  socket.serverMessage({ op: 0, d: { rpcVersion: 1 } });
  await waitUntil(() => socket.sent.length === 1);
  socket.serverMessage({ op: 2, d: { negotiatedRpcVersion: 1 } });
  await connectPromise;

  const requestPromise = client.request('GetVersion');
  assert.doesNotThrow(() => socket.rawMessage('not-json{'));
  await assert.rejects(() => requestPromise, /malformed frame/);
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
      responseData: { currentProgramSceneName: 'Scene A' },
    },
  });

  assert.deepEqual(await requestPromise, { currentProgramSceneName: 'Scene A' });
});

test('normalizeObsStatus keeps useful operational fields only', () => {
  assert.deepEqual(normalizeObsStatus({
    version: {
      obsVersion: '32.0.0',
      obsWebSocketVersion: '5.5.0',
      platformDescription: 'local machine details',
    },
    currentScene: { currentProgramSceneName: 'Scene A' },
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
    currentProgramSceneName: 'Scene A',
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

test('request() does not orphan a pending promise when the socket rejects send', async () => {
  const socket = new FakeSocket();
  const client = new ObsWebSocketClient({
    socketFactory: () => socket,
    requestTimeoutMs: 10,
  });

  const connectPromise = client.connect();
  socket.open();
  socket.serverMessage({ op: 0, d: { rpcVersion: 1 } });
  await waitUntil(() => socket.sent.length === 1);
  socket.serverMessage({ op: 2, d: { negotiatedRpcVersion: 1 } });
  await connectPromise;

  // OBS closed the socket between connect and request: undici throws here.
  socket.send = () => {
    throw new Error('InvalidStateError: WebSocket is not open');
  };

  await assert.rejects(
    () => client.request('GetVersion'),
    /OBS request failed to send: GetVersion/,
  );
  // An entry left in `pending` would reject with nobody listening once the
  // timeout fires, which takes the whole stdio server down.
  assert.equal(client.pending.size, 0);
  await new Promise((resolve) => setTimeout(resolve, 30));
});
