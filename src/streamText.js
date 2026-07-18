'use strict';

function isAsyncIterable(value) {
  return value !== null
    && value !== undefined
    && typeof value[Symbol.asyncIterator] === 'function';
}

function normalizeModelText(value) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

function extractChunkText(chunk, seen = new WeakSet()) {
  if (typeof chunk === 'string') {
    return chunk;
  }

  if (chunk === null || chunk === undefined) {
    return '';
  }

  if (Array.isArray(chunk)) {
    return chunk.map((part) => extractChunkText(part, seen)).join('');
  }

  if (typeof chunk !== 'object') {
    return '';
  }

  if (seen.has(chunk)) {
    return '';
  }
  seen.add(chunk);

  if (Array.isArray(chunk.parts)) {
    return chunk.parts.map((part) => extractChunkText(part, seen)).join('');
  }

  for (const property of ['text', 'value', 'delta']) {
    if (typeof chunk[property] === 'string') {
      return chunk[property];
    }
  }

  return '';
}

function describeResponseShape(response) {
  if (response === null || response === undefined) {
    return {
      type: String(response),
      keys: [],
      textIsString: false,
      textIsAsyncIterable: false,
      streamIsAsyncIterable: false
    };
  }

  let text;
  let stream;
  try {
    text = response.text;
  } catch {
    text = undefined;
  }
  try {
    stream = response.stream;
  } catch {
    stream = undefined;
  }

  return {
    type: typeof response,
    keys: Object.keys(response).sort(),
    textIsString: typeof text === 'string',
    textIsAsyncIterable: isAsyncIterable(text),
    streamIsAsyncIterable: isAsyncIterable(stream)
  };
}

async function collectModelResponseText(response, options = {}) {
  const logger = typeof options.logger === 'function' ? options.logger : () => {};
  const onDiagnostic = typeof options.onDiagnostic === 'function'
    ? options.onDiagnostic
    : () => {};

  if (!response || typeof response !== 'object') {
    onDiagnostic({ source: 'none', fragmentCount: 0, assembledLength: 0 });
    return '';
  }

  const streamResult = await collectFromStream(response, logger);
  if (streamResult.fragmentCount > 0) {
    onDiagnostic(streamResult.diagnostic);
    return streamResult.text;
  }

  let text;
  try {
    text = response.text;
  } catch (error) {
    logger(`Unable to read response.text: ${errorMessage(error)}`);
  }

  if (typeof text === 'string') {
    const normalized = normalizeModelText(text).trim();
    onDiagnostic({
      source: 'text-string',
      fragmentCount: text.length > 0 ? 1 : 0,
      assembledLength: normalized.length
    });
    return normalized;
  }

  const textPieces = [];
  let fragmentCount = 0;

  if (isAsyncIterable(text)) {
    try {
      for await (const fragment of text) {
        if (typeof fragment === 'string') {
          textPieces.push(fragment);
          fragmentCount += 1;
        }
      }
    } catch (error) {
      logger(`Error while collecting response.text: ${errorMessage(error)}`);
    }

    if (fragmentCount > 0) {
      const normalized = normalizeModelText(textPieces.join('')).trim();
      onDiagnostic({
        source: 'text',
        fragmentCount,
        assembledLength: normalized.length
      });
      return normalized;
    }
  }

  onDiagnostic({ source: 'none', fragmentCount: 0, assembledLength: 0 });
  return '';
}

async function collectFromStream(response, logger) {
  const pieces = [];
  let fragmentCount = 0;
  let stream;

  try {
    stream = response.stream;
  } catch (error) {
    logger(`Unable to read response.stream: ${errorMessage(error)}`);
  }

  if (isAsyncIterable(stream)) {
    try {
      for await (const chunk of stream) {
        const piece = typeof chunk === 'string' ? chunk : extractChunkText(chunk);
        if (piece !== '') {
          pieces.push(piece);
          fragmentCount += 1;
        }
      }
    } catch (error) {
      logger(`Error while collecting response.stream: ${errorMessage(error)}`);
    }
  }

  const normalized = normalizeModelText(pieces.join('')).trim();
  return {
    text: normalized,
    fragmentCount,
    diagnostic: {
      source: 'stream',
      fragmentCount,
      assembledLength: normalized.length
    }
  };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

module.exports = {
  collectModelResponseText,
  describeResponseShape,
  extractChunkText,
  isAsyncIterable,
  normalizeModelText
};
