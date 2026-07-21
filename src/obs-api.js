import { createHash, randomUUID } from 'node:crypto';

export const DEFAULT_OBS_URL = 'ws://127.0.0.1:4455';
export const SWITCH_CONFIRM = 'SWITCH_DEDUS_DEV_OBS_SCENE';

const OPCODES = {
  hello: 0,
  identify: 1,
  identified: 2,
  request: 6,
  requestResponse: 7,
};

export class ObsWebSocketError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ObsWebSocketError';
    this.details = details;
  }
}

export function buildObsAuthentication(password, { salt, challenge }) {
  if (!password) return undefined;
  const secret = sha256Base64(`${password}${salt}`);
  return sha256Base64(`${secret}${challenge}`);
}

function sha256Base64(value) {
  return createHash('sha256').update(value).digest('base64');
}

/**
 * Scene names belong to an account, not to this repo: an unset OBS_ALLOWED_SCENES
 * means nothing is allowed, so a second account cannot inherit someone else's
 * allow list by forgetting the key.
 */
export function parseAllowedScenes(rawValue) {
  if (!rawValue) return [];
  return rawValue
    .split(',')
    .map((scene) => scene.trim())
    .filter(Boolean);
}

export function requirePrivateScene(sceneName) {
  const value = String(sceneName ?? process.env.OBS_PRIVATE_SCENE ?? '').trim();
  if (!value) {
    throw new Error('OBS_PRIVATE_SCENE is not set: this instance has no private scene configured');
  }
  return value;
}

export function isSceneAllowed(sceneName, allowedScenes) {
  return allowedScenes.includes(sceneName);
}

export function requireSceneSwitchAllowed(sceneName, {
  confirm,
  switchEnabled = process.env.OBS_SCENE_SWITCH_ENABLED,
  allowedScenes = parseAllowedScenes(process.env.OBS_ALLOWED_SCENES),
} = {}) {
  if (switchEnabled !== 'true') {
    throw new Error('OBS scene switching is disabled. Set OBS_SCENE_SWITCH_ENABLED=true after reviewing the safety setup.');
  }
  if (confirm !== SWITCH_CONFIRM) {
    throw new Error(`Missing confirm token. Pass confirm="${SWITCH_CONFIRM}" to switch non-private scenes.`);
  }
  if (allowedScenes.length === 0) {
    throw new Error('OBS_ALLOWED_SCENES is not set: no scene may be switched to');
  }
  if (!isSceneAllowed(sceneName, allowedScenes)) {
    throw new Error(`Scene is not in OBS_ALLOWED_SCENES: ${sceneName}`);
  }
}

export function normalizeObsStatus({ version, streamStatus, recordStatus, currentScene }) {
  return {
    connected: true,
    obsVersion: version?.obsVersion,
    obsWebSocketVersion: version?.obsWebSocketVersion,
    currentProgramSceneName: currentScene?.currentProgramSceneName,
    stream: streamStatus
      ? {
        active: Boolean(streamStatus.outputActive),
        reconnecting: Boolean(streamStatus.outputReconnecting),
        timecode: streamStatus.outputTimecode,
        durationMs: streamStatus.outputDuration,
        congestion: streamStatus.outputCongestion,
        skippedFrames: streamStatus.outputSkippedFrames,
        totalFrames: streamStatus.outputTotalFrames,
      }
      : null,
    recording: recordStatus
      ? {
        active: Boolean(recordStatus.outputActive),
        paused: Boolean(recordStatus.outputPaused),
        timecode: recordStatus.outputTimecode,
        durationMs: recordStatus.outputDuration,
        bytes: recordStatus.outputBytes,
      }
      : null,
  };
}

export function normalizeSceneList(sceneList) {
  return {
    currentProgramSceneName: sceneList.currentProgramSceneName,
    currentPreviewSceneName: sceneList.currentPreviewSceneName,
    scenes: (sceneList.scenes ?? []).map((scene) => ({
      name: scene.sceneName,
      index: scene.sceneIndex,
    })),
  };
}

export class ObsWebSocketClient {
  constructor(options = {}) {
    this.url = options.url ?? process.env.OBS_WEBSOCKET_URL ?? DEFAULT_OBS_URL;
    this.password = options.password ?? process.env.OBS_WEBSOCKET_PASSWORD;
    this.rpcVersion = Number(options.rpcVersion ?? process.env.OBS_RPC_VERSION ?? 1);
    this.socketFactory = Object.hasOwn(options, 'socketFactory')
      ? options.socketFactory
      : (typeof WebSocket !== 'undefined' ? ((url) => new WebSocket(url)) : null);
    this.requestTimeoutMs = Number(options.requestTimeoutMs ?? process.env.OBS_REQUEST_TIMEOUT_MS ?? 5000);
    this.socket = null;
    this.pending = new Map();
    this.hello = null;
  }

  async connect() {
    if (!this.socketFactory) {
      throw new ObsWebSocketError('WebSocket is not available in this Node runtime.');
    }

    const socket = this.socketFactory(this.url);
    this.socket = socket;

    socket.addEventListener('message', (event) => this.handleMessage(event));
    socket.addEventListener('close', () => this.rejectPending(new ObsWebSocketError('OBS WebSocket closed.')));
    socket.addEventListener('error', () => this.rejectPending(new ObsWebSocketError('OBS WebSocket error.')));

    const helloPromise = this.waitForOpcode(OPCODES.hello);
    // helloPromise is rejected by the socket error/close listeners; without a catch
    // here the rejection is unhandled (and kills the process) whenever the socket
    // itself fails first, because connect() rejects on waitForSocketOpen instead.
    helloPromise.catch(() => {});

    try {
      await waitForSocketOpen(socket, this.requestTimeoutMs);
      const hello = await helloPromise;
      this.hello = hello.d;

      const authentication = hello.d?.authentication
        ? buildObsAuthentication(this.password, hello.d.authentication)
        : undefined;

      if (hello.d?.authentication && !authentication) {
        throw new ObsWebSocketError('OBS WebSocket requires OBS_WEBSOCKET_PASSWORD.');
      }

      const identifiedPromise = this.waitForOpcode(OPCODES.identified);
      identifiedPromise.catch(() => {});
      socket.send(JSON.stringify({
        op: OPCODES.identify,
        d: {
          rpcVersion: this.rpcVersion,
          ...(authentication ? { authentication } : {}),
        },
      }));

      await identifiedPromise;
      return this;
    } catch (error) {
      // The socket may already be open (handshake failure); close it so a failed
      // tool call does not leak a live connection to OBS.
      await this.disconnect();
      throw error;
    }
  }

  async disconnect() {
    if (!this.socket) return;
    this.rejectPending(new ObsWebSocketError('OBS WebSocket disconnected.'));
    this.socket.close();
    this.socket = null;
  }

  async request(requestType, requestData = {}) {
    if (!this.socket) throw new ObsWebSocketError('OBS WebSocket is not connected.');

    const requestId = randomUUID();
    const promise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new ObsWebSocketError(`OBS request timed out: ${requestType}`));
      }, this.requestTimeoutMs);
      this.pending.set(requestId, { resolve, reject, timeout, requestType });
    });

    // send() throws when OBS closed the socket between connect and request. The
    // pending promise already exists at that point and nobody is holding it, so
    // its later rejection (timeout or disconnect) would be unhandled and kill the
    // process — drop the entry here instead of leaving it orphaned.
    try {
      this.socket.send(JSON.stringify({
        op: OPCODES.request,
        d: { requestType, requestId, requestData },
      }));
    } catch (error) {
      const entry = this.pending.get(requestId);
      if (entry) {
        clearTimeout(entry.timeout);
        this.pending.delete(requestId);
      }
      promise.catch(() => {});
      throw new ObsWebSocketError(`OBS request failed to send: ${requestType}`, { cause: String(error) });
    }

    return promise;
  }

  async getStatus() {
    const [version, streamStatus, recordStatus, currentScene] = await Promise.all([
      this.request('GetVersion'),
      this.request('GetStreamStatus'),
      this.request('GetRecordStatus'),
      this.request('GetCurrentProgramScene'),
    ]);
    return normalizeObsStatus({ version, streamStatus, recordStatus, currentScene });
  }

  async getSceneList() {
    return normalizeSceneList(await this.request('GetSceneList'));
  }

  async setCurrentProgramScene(sceneName) {
    await this.request('SetCurrentProgramScene', { sceneName });
    const currentScene = await this.request('GetCurrentProgramScene');
    return {
      switched: currentScene.currentProgramSceneName === sceneName,
      currentProgramSceneName: currentScene.currentProgramSceneName,
    };
  }

  handleMessage(event) {
    const raw = typeof event.data === 'string' ? event.data : event.data.toString();
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      // A malformed frame must not throw out of the listener as an uncaught
      // exception — fail the in-flight requests instead of killing the process.
      this.rejectPending(new ObsWebSocketError('OBS WebSocket sent a malformed frame.'));
      return;
    }

    if (message.op === OPCODES.requestResponse) {
      this.handleRequestResponse(message.d);
      return;
    }

    const pendingOpcode = this.pending.get(`op:${message.op}`);
    if (pendingOpcode) {
      clearTimeout(pendingOpcode.timeout);
      this.pending.delete(`op:${message.op}`);
      pendingOpcode.resolve(message);
    }
  }

  handleRequestResponse(data) {
    const pending = this.pending.get(data.requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(data.requestId);

    if (data.requestStatus?.result !== true) {
      pending.reject(new ObsWebSocketError(
        data.requestStatus?.comment ?? `OBS request failed: ${pending.requestType}`,
        {
          code: data.requestStatus?.code,
          requestType: pending.requestType,
        },
      ));
      return;
    }

    pending.resolve(data.responseData ?? {});
  }

  waitForOpcode(opcode) {
    return new Promise((resolve, reject) => {
      const key = `op:${opcode}`;
      const timeout = setTimeout(() => {
        this.pending.delete(key);
        reject(new ObsWebSocketError(`OBS did not send opcode ${opcode}.`));
      }, this.requestTimeoutMs);
      this.pending.set(key, { resolve, reject, timeout });
    });
  }

  rejectPending(error) {
    for (const [key, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(key);
    }
  }
}

function waitForSocketOpen(socket, timeoutMs) {
  if (socket.readyState === 1) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new ObsWebSocketError('Timed out connecting to OBS WebSocket.'));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timeout);
      socket.removeEventListener('open', handleOpen);
      socket.removeEventListener('error', handleError);
    }

    function handleOpen() {
      cleanup();
      resolve();
    }

    function handleError() {
      cleanup();
      reject(new ObsWebSocketError('Failed to connect to OBS WebSocket.'));
    }

    socket.addEventListener('open', handleOpen);
    socket.addEventListener('error', handleError);
  });
}
