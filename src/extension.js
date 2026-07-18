'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const { URL } = require('node:url');
const vscode = require('vscode');

const {
  BridgeError,
  ERROR_CODES,
  errorEnvelope,
  successEnvelope
} = require('./contracts');
const {
  collectModelResponseText,
  describeResponseShape
} = require('./streamText');

const TOKEN_STATE_KEY = 'digitalrcs.aiBridge.generatedToken';
const MAX_EMPTY_RESPONSE_ATTEMPTS = 2;
const DEFAULT_MAX_OUTPUT_TOKENS = 65_536;
const KNOWN_BAD_REASONING_FRAGMENT =
  'ili in is ability a';

const bridgeState = {
  context: undefined,
  output: undefined,
  server: undefined,
  host: undefined,
  port: undefined,
  requestLog: []
};

function configuration() {
  return vscode.workspace.getConfiguration('digitalrcs.aiBridge');
}

function log(message) {
  bridgeState.output?.appendLine(`[${new Date().toISOString()}] ${message}`);
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

async function resolveBearerToken() {
  const configured = String(configuration().get('sharedToken', '')).trim();
  if (configured) {
    return configured;
  }

  const stored = bridgeState.context.workspaceState.get(TOKEN_STATE_KEY);
  if (typeof stored === 'string' && stored) {
    return stored;
  }

  const generated = crypto.randomBytes(24).toString('hex');
  await bridgeState.context.workspaceState.update(TOKEN_STATE_KEY, generated);
  return generated;
}

function registerCommand(context, name, callback) {
  context.subscriptions.push(vscode.commands.registerCommand(name, callback));
}

async function activate(context) {
  bridgeState.context = context;
  bridgeState.output = vscode.window.createOutputChannel('DigitalRCS AI Bridge');
  context.subscriptions.push(bridgeState.output);

  await resolveBearerToken();

  registerCommand(context, 'digitalrcsBridge.start', () => startBridge(true));
  registerCommand(context, 'digitalrcsBridge.stop', () => stopBridge(true));
  registerCommand(context, 'digitalrcsBridge.status', showStatus);
  registerCommand(context, 'digitalrcsBridge.copyToken', copyToken);
  registerCommand(context, 'digitalrcsBridge.tempTest', runTempTest);

  if (configuration().get('autoStart', false)) {
    try {
      await startBridge(false);
    } catch (error) {
      log(`Auto-start failed: ${messageOf(error)}`);
      vscode.window.showErrorMessage(`DigitalRCS AI Bridge could not auto-start: ${messageOf(error)}`);
    }
  }
}

async function startBridge(showNotification = true) {
  if (bridgeState.server) {
    if (showNotification) {
      vscode.window.showInformationMessage(
        `DigitalRCS AI Bridge is already running at http://${bridgeState.host}:${bridgeState.port}.`
      );
    }
    return;
  }

  const host = String(configuration().get('host', '127.0.0.1')).trim() || '127.0.0.1';
  const port = Number(configuration().get('port', 8787));
  const server = http.createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      log(`Unhandled request failure: ${messageOf(error)}`);
      if (!response.headersSent) {
        sendError(response, new BridgeError(
          ERROR_CODES.INTERNAL_ERROR,
          'The bridge could not complete the request.',
          { cause: error }
        ));
      } else if (!response.writableEnded) {
        response.end();
      }
    });
  });

  server.on('clientError', (error, socket) => {
    log(`HTTP client error: ${messageOf(error)}`);
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    }
  });
  server.on('error', (error) => log(`HTTP server error: ${messageOf(error)}`));

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });

  const address = server.address();
  bridgeState.server = server;
  bridgeState.host = host;
  bridgeState.port = typeof address === 'object' && address ? address.port : port;
  bridgeState.requestLog = [];

  log(`Bridge started at http://${bridgeState.host}:${bridgeState.port}.`);
  if (showNotification) {
    vscode.window.showInformationMessage(
      `DigitalRCS AI Bridge started at http://${bridgeState.host}:${bridgeState.port}.`
    );
  }
}

async function stopBridge(showNotification = true) {
  const server = bridgeState.server;
  if (!server) {
    if (showNotification) {
      vscode.window.showInformationMessage('DigitalRCS AI Bridge is already stopped.');
    }
    return;
  }

  bridgeState.server = undefined;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  log('Bridge stopped.');
  bridgeState.host = undefined;
  bridgeState.port = undefined;

  if (showNotification) {
    vscode.window.showInformationMessage('DigitalRCS AI Bridge stopped.');
  }
}

function showStatus() {
  if (bridgeState.server) {
    vscode.window.showInformationMessage(
      `DigitalRCS AI Bridge is running at http://${bridgeState.host}:${bridgeState.port}.`
    );
  } else {
    vscode.window.showInformationMessage('DigitalRCS AI Bridge is stopped.');
  }
}

async function copyToken() {
  const token = await resolveBearerToken();
  await vscode.env.clipboard.writeText(token);
  vscode.window.showInformationMessage('DigitalRCS AI Bridge bearer token copied.');
}

async function runTempTest() {
  const question = 'What is Resiliency in IT?';
  const prompt = 'Answer the question in clear, concise plain text.';

  bridgeState.output.show(true);
  log('Smoke test started.');

  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'DigitalRCS AI Bridge: running smoke test...',
    cancellable: false
  }, async () => {
    try {
      const response = await runAnalysisWithModel('', prompt, undefined, true, question);
      log(`Smoke test response: ${response || '<empty>'}`);
      if (response) {
        vscode.window.showInformationMessage(`DigitalRCS AI Bridge smoke test: ${response}`);
      } else {
        vscode.window.showErrorMessage('DigitalRCS AI Bridge smoke test returned an empty response.');
      }
    } catch (error) {
      log(`Smoke test failed: ${messageOf(error)}`);
      vscode.window.showErrorMessage(`DigitalRCS AI Bridge smoke test failed: ${messageOf(error)}`);
    }
  });
}

async function handleRequest(request, response) {
  try {
    const token = await resolveBearerToken();
    authenticate(request, token);
    enforceRateLimit();

    const url = new URL(request.url || '/', `http://${bridgeState.host || '127.0.0.1'}`);
    const method = String(request.method || 'GET').toUpperCase();

    if (method === 'GET' && url.pathname === '/bridge/health') {
      await handleHealth(response);
      return;
    }
    if (method === 'GET' && url.pathname === '/bridge/models') {
      await handleModels(response);
      return;
    }
    if (method === 'POST' && url.pathname === '/bridge/analyze') {
      await handleAnalyze(request, response);
      return;
    }

    throw new BridgeError(ERROR_CODES.NOT_FOUND, 'Route not found.');
  } catch (error) {
    const bridgeError = toBridgeError(error);
    sendError(response, bridgeError);
    if (bridgeError.destroyRequest) {
      request.pause();
      response.once('finish', () => request.destroy());
    }
  }
}

function authenticate(request, expectedToken) {
  const authorization = request.headers.authorization;
  const expected = `Bearer ${expectedToken}`;
  if (typeof authorization !== 'string' || !safeStringEqual(authorization, expected)) {
    throw new BridgeError(ERROR_CODES.UNAUTHORIZED, 'A valid bearer token is required.');
  }
}

function safeStringEqual(actual, expected) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function enforceRateLimit() {
  const now = Date.now();
  const cutoff = now - 60_000;
  bridgeState.requestLog = bridgeState.requestLog.filter((timestamp) => timestamp > cutoff);
  const limit = Number(configuration().get('requestsPerMinute', 30));
  if (bridgeState.requestLog.length >= limit) {
    throw new BridgeError(
      ERROR_CODES.RATE_LIMITED,
      `Rate limit exceeded. Try again after older requests leave the 60-second window.`
    );
  }
  bridgeState.requestLog.push(now);
}

async function handleHealth(response) {
  let modelCount = 0;
  try {
    modelCount = (await vscode.lm.selectChatModels({})).length;
  } catch (error) {
    log(`Unable to count models for health response: ${messageOf(error)}`);
  }

  sendJson(response, 200, successEnvelope({
    status: 'running',
    modelCount
  }));
}

async function handleModels(response) {
  let models;
  try {
    models = await vscode.lm.selectChatModels({});
  } catch (error) {
    throw new BridgeError(
      ERROR_CODES.AI_UNAVAILABLE,
      `VS Code language models are unavailable: ${messageOf(error)}`,
      { cause: error }
    );
  }

  const modelIds = models
    .map((model) => model.id)
    .filter((id) => typeof id === 'string')
    .sort((left, right) => left.localeCompare(right));

  sendJson(response, 200, successEnvelope({ models: modelIds }));
}

async function handleAnalyze(request, response) {
  const maxRequestBytes = Number(configuration().get('maxRequestBytes', 5_242_880));
  const body = await readJsonBody(request, maxRequestBytes);
  const input = validateAnalyzeRequest(body);
  const analysis = await runAnalysisWithModel(
    input.model,
    input.prompt,
    input.resultData,
    input.useManualInput,
    input.manualInput
  );

  sendJson(response, 200, successEnvelope({
    analysis,
    ...(input.requestId ? { requestId: input.requestId } : {})
  }));
}

function validateAnalyzeRequest(body) {
  if (!isPlainObject(body)) {
    throw new BridgeError(ERROR_CODES.BAD_REQUEST, 'Request body must be a JSON object.');
  }

  if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
    throw new BridgeError(ERROR_CODES.BAD_REQUEST, 'prompt must be a non-empty string.');
  }

  const useManualInput = body.useManualInput === true;
  if (body.useManualInput !== undefined && typeof body.useManualInput !== 'boolean') {
    throw new BridgeError(ERROR_CODES.BAD_REQUEST, 'useManualInput must be a boolean.');
  }

  if (useManualInput) {
    if (typeof body.manualInput !== 'string' || !body.manualInput.trim()) {
      throw new BridgeError(
        ERROR_CODES.BAD_REQUEST,
        'manualInput must be a non-empty string when useManualInput is true.'
      );
    }
  } else if (!isPlainObject(body.resultData)) {
    throw new BridgeError(
      ERROR_CODES.BAD_REQUEST,
      'resultData must be a non-null object when useManualInput is false.'
    );
  }

  if (body.model !== undefined && typeof body.model !== 'string') {
    throw new BridgeError(ERROR_CODES.BAD_REQUEST, 'model must be a string when provided.');
  }
  if (body.requestId !== undefined && typeof body.requestId !== 'string') {
    throw new BridgeError(ERROR_CODES.BAD_REQUEST, 'requestId must be a string when provided.');
  }

  return {
    model: typeof body.model === 'string' ? body.model : '',
    prompt: body.prompt,
    resultData: body.resultData,
    useManualInput,
    manualInput: body.manualInput,
    requestId: body.requestId
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readJsonBody(request, maxBytes) {
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new BridgeError(
      ERROR_CODES.REQUEST_TOO_LARGE,
      `Request body exceeds the ${maxBytes}-byte limit.`,
      { destroyRequest: true }
    );
  }

  const chunks = [];
  let received = 0;

  for await (const chunk of request) {
    received += chunk.length;
    if (received > maxBytes) {
      throw new BridgeError(
        ERROR_CODES.REQUEST_TOO_LARGE,
        `Request body exceeds the ${maxBytes}-byte limit.`,
        { destroyRequest: true }
      );
    }
    chunks.push(chunk);
  }

  if (received === 0) {
    throw new BridgeError(ERROR_CODES.BAD_REQUEST, 'A JSON request body is required.');
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    throw new BridgeError(ERROR_CODES.BAD_REQUEST, 'Request body must contain valid JSON.', {
      cause: error
    });
  }
}

async function runAnalysisWithModel(modelId, prompt, resultData, useManualInput, manualInput) {
  let models;
  try {
    models = await vscode.lm.selectChatModels({});
  } catch (error) {
    throw new BridgeError(
      ERROR_CODES.AI_UNAVAILABLE,
      `VS Code language models are unavailable: ${messageOf(error)}`,
      { cause: error }
    );
  }

  if (!models.length) {
    throw new BridgeError(ERROR_CODES.AI_UNAVAILABLE, 'No VS Code language models are available.');
  }

  log(`Discovered ${models.length} VS Code language model(s).`);
  const requestedModelId = requestedModelIdFromInput(modelId);
  const requested = requestedModelId
    ? models.find((candidate) => candidate.id === requestedModelId)
    : undefined;
  const model = requested || models[0];
  if (requestedModelId && !requested) {
    log(
      `Requested model ${requestedModelId} is unavailable; `
      + `falling back to ${model.id}.`
    );
  } else if (!requestedModelId) {
    log(`No model requested or configured; using first VS Code model: ${model.id}.`);
  }
  log(
    `Selected model: id=${model.id}, vendor=${model.vendor || '<unknown>'}, `
    + `family=${model.family || '<unknown>'}.`
  );
  const userContentPrefix = shouldUseQwenNoThinkPrefix(model) ? '/no_think\n' : '';
  if (userContentPrefix) {
    log(`Applying Qwen /no_think prompt prefix for model ${model.id}.`);
  }
  const userContent = userContentPrefix + (useManualInput
    ? `Use only the following user-provided input and return plain text only:\n\n${manualInput}`
    : `Analyze this latest raw resiliency data and return plain text only:\n\n${JSON.stringify(resultData, null, 2)}`);
  const messages = buildMessages(prompt, userContent);

  for (let attempt = 1; attempt <= MAX_EMPTY_RESPONSE_ATTEMPTS; attempt += 1) {
    const cts = new vscode.CancellationTokenSource();
    let response;
    let diagnostic = { fragmentCount: 0, assembledLength: 0, source: 'none' };

    try {
      try {
        const maxOutputTokens = requestedMaxOutputTokens();
        log(
          `Sending model request (attempt ${attempt}/${MAX_EMPTY_RESPONSE_ATTEMPTS}, `
          + `maxOutputTokens=${maxOutputTokens}).`
        );
        response = await model.sendRequest(
          messages,
          {
            justification: 'DigitalRCS AI Bridge: analyzing resiliency data for the user.',
            modelOptions: { maxOutputTokens }
          },
          cts.token
        );
      } catch (error) {
        throw new BridgeError(
          ERROR_CODES.AI_UNAVAILABLE,
          `The language model request failed: ${messageOf(error)}`,
          { cause: error }
        );
      }

      log(`Model ${model.id} response shape: ${JSON.stringify(describeResponseShape(response))}`);
      const output = await collectModelResponseText(response, {
        logger: log,
        onDiagnostic: (value) => {
          diagnostic = value;
        }
      });
      log(
        `Model ${model.id} collection: source=${diagnostic.source}, `
        + `fragments=${diagnostic.fragmentCount}, assembledLength=${diagnostic.assembledLength}.`
      );

      if (diagnostic.fragmentCount > 0 || output) {
        assertUsableModelOutput(output, diagnostic, model);
        return output;
      }
    } finally {
      cts.dispose();
    }

    if (attempt < MAX_EMPTY_RESPONSE_ATTEMPTS) {
      log(`Model ${model.id} returned zero chunks; retrying once.`);
    }
  }

  return '';
}

function shouldUseQwenNoThinkPrefix(model) {
  if (configuration().get('qwenNoThinkPrefix', false) !== true) {
    return false;
  }

  const modelText = [
    model?.id,
    model?.vendor,
    model?.family,
    model?.name
  ].filter((value) => typeof value === 'string').join(' ').toLowerCase();

  return modelText.includes('qwen');
}

function assertUsableModelOutput(output, diagnostic, model) {
  if (!looksLikeKnownReasoningFragmentLoss(output, diagnostic, model)) {
    return;
  }

  throw new BridgeError(
    ERROR_CODES.AI_UNAVAILABLE,
    'The selected VS Code language model returned malformed text fragments instead of a usable answer. '
      + 'This matches a provider reasoning-output routing failure through the VS Code Language Model API. '
      + 'Select a VS Code model/provider that emits normal response text, or disable '
      + 'digitalrcs.aiBridge.qwenNoThinkPrefix if this local Qwen workaround is not desired.'
  );
}

function looksLikeKnownReasoningFragmentLoss(output, diagnostic, model) {
  if (typeof output !== 'string') {
    return false;
  }

  const normalized = output.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  const modelText = [
    model?.id,
    model?.vendor,
    model?.family
  ].filter((value) => typeof value === 'string').join(' ').toLowerCase();

  return modelText.includes('lmstudio')
    && modelText.includes('qwen')
    && diagnostic.source === 'text'
    && diagnostic.assembledLength < 256
    && normalized.includes(KNOWN_BAD_REASONING_FRAGMENT);
}

function requestedModelIdFromInput(modelId) {
  const explicit = typeof modelId === 'string' ? modelId.trim() : '';
  if (explicit && explicit.toLowerCase() !== 'auto') {
    return explicit;
  }

  const configured = String(configuration().get('defaultModel', '')).trim();
  if (configured && configured.toLowerCase() !== 'auto') {
    return configured;
  }

  return '';
}

function requestedMaxOutputTokens() {
  const configured = Number(configuration().get('maxOutputTokens', DEFAULT_MAX_OUTPUT_TOKENS));
  if (!Number.isFinite(configured)) {
    return DEFAULT_MAX_OUTPUT_TOKENS;
  }
  return Math.max(256, Math.min(262_144, Math.trunc(configured)));
}

function buildMessages(promptText, userContent) {
  const chatMessage = vscode.LanguageModelChatMessage;
  if (chatMessage.System && chatMessage.User) {
    return [
      chatMessage.System(promptText),
      chatMessage.User(userContent)
    ];
  }
  if (chatMessage.User) {
    return [chatMessage.User(`${promptText}\n\n${userContent}`)];
  }

  throw new BridgeError(
    ERROR_CODES.AI_UNAVAILABLE,
    'This VS Code version does not expose the required language-model message API.'
  );
}

function sendJson(response, status, payload) {
  if (response.writableEnded) {
    return;
  }
  const json = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(json);
}

function sendError(response, error) {
  sendJson(response, error.statusCode, errorEnvelope(error.code, error.message));
}

function toBridgeError(error) {
  if (error instanceof BridgeError) {
    return error;
  }
  log(`Internal error: ${messageOf(error)}`);
  return new BridgeError(
    ERROR_CODES.INTERNAL_ERROR,
    'The bridge encountered an internal error.',
    { cause: error }
  );
}

async function deactivate() {
  await stopBridge(false);
}

module.exports = {
  activate,
  deactivate
};
