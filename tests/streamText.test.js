'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  collectModelResponseText,
  describeResponseShape,
  extractChunkText,
  normalizeModelText
} = require('../src/streamText');

async function* fragments(...values) {
  for (const value of values) {
    yield value;
  }
}

test('collects response.text fragments as deltas with plain concatenation', async () => {
  let diagnostic;
  const response = {
    text: fragments('The', ' problem', ' is', ' solved.')
  };

  const actual = await collectModelResponseText(response, {
    onDiagnostic: (value) => {
      diagnostic = value;
    }
  });

  assert.equal(actual, 'The problem is solved.');
  assert.deepEqual(diagnostic, {
    source: 'text',
    fragmentCount: 4,
    assembledLength: 22
  });
});

test('prefers response.stream text parts when both stream and text are present', async () => {
  let diagnostic;
  const response = {
    text: fragments('il in refers the of system'),
    stream: fragments(
      { value: 'Resiliency in IT ' },
      { value: 'refers to the ability of a system.' }
    )
  };

  const actual = await collectModelResponseText(response, {
    onDiagnostic: (value) => {
      diagnostic = value;
    }
  });

  assert.equal(actual, 'Resiliency in IT refers to the ability of a system.');
  assert.deepEqual(diagnostic, {
    source: 'stream',
    fragmentCount: 2,
    assembledLength: 51
  });
});

test('accepts response.text when it is already a resolved string', async () => {
  const actual = await collectModelResponseText({ text: '  plain text  ' });
  assert.equal(actual, 'plain text');
});

test('falls back to response.stream when response.text produces zero chunks', async () => {
  let diagnostic;
  const response = {
    text: fragments(),
    stream: fragments(
      'Fallback ',
      { value: 'stream' },
      { parts: [{ text: ' works' }, { delta: '.' }] }
    )
  };

  const actual = await collectModelResponseText(response, {
    onDiagnostic: (value) => {
      diagnostic = value;
    }
  });

  assert.equal(actual, 'Fallback stream works.');
  assert.deepEqual(diagnostic, {
    source: 'stream',
    fragmentCount: 3,
    assembledLength: 22
  });
});

test('uses response.stream without touching a broken response.text iterable', async () => {
  async function* brokenText() {
    throw new Error('text stream failed');
  }

  const logLines = [];
  const actual = await collectModelResponseText({
    text: brokenText(),
    stream: fragments({ text: 'Recovered' })
  }, {
    logger: (line) => logLines.push(line)
  });

  assert.equal(actual, 'Recovered');
  assert.deepEqual(logLines, []);
});

test('extractChunkText handles supported object shapes and nested parts', () => {
  assert.equal(extractChunkText({ text: 'a' }), 'a');
  assert.equal(extractChunkText({ value: 'b' }), 'b');
  assert.equal(extractChunkText({ delta: 'c' }), 'c');
  assert.equal(
    extractChunkText({ parts: [{ value: 'one' }, { parts: [{ text: 'two' }] }] }),
    'onetwo'
  );
});

test('normalizes CRLF and removes unsafe control characters', () => {
  assert.equal(
    normalizeModelText('line 1\r\nline\u0000 2\tok\u007f'),
    'line 1\nline 2\tok'
  );
});

test('describes response structure without logging response content', () => {
  const shape = describeResponseShape({
    text: fragments('secret response'),
    stream: fragments()
  });

  assert.deepEqual(shape, {
    type: 'object',
    keys: ['stream', 'text'],
    textIsString: false,
    textIsAsyncIterable: true,
    streamIsAsyncIterable: true
  });
  assert.doesNotMatch(JSON.stringify(shape), /secret response/);
});
