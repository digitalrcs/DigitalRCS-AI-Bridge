'use strict';

const ERROR_CODES = Object.freeze({
  UNAUTHORIZED: 'UNAUTHORIZED',
  NOT_FOUND: 'NOT_FOUND',
  BAD_REQUEST: 'BAD_REQUEST',
  REQUEST_TOO_LARGE: 'REQUEST_TOO_LARGE',
  RATE_LIMITED: 'RATE_LIMITED',
  AI_UNAVAILABLE: 'AI_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR'
});

const ERROR_STATUS = Object.freeze({
  [ERROR_CODES.UNAUTHORIZED]: 401,
  [ERROR_CODES.NOT_FOUND]: 404,
  [ERROR_CODES.BAD_REQUEST]: 400,
  [ERROR_CODES.REQUEST_TOO_LARGE]: 413,
  [ERROR_CODES.RATE_LIMITED]: 429,
  [ERROR_CODES.AI_UNAVAILABLE]: 503,
  [ERROR_CODES.INTERNAL_ERROR]: 500
});

class BridgeError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.statusCode = ERROR_STATUS[code] || 500;
    this.status = this.statusCode;
    this.destroyRequest = options.destroyRequest === true;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

function successEnvelope(fields = {}) {
  return { ok: true, ...fields };
}

function errorEnvelope(code, message) {
  return {
    ok: false,
    error: {
      code,
      message
    }
  };
}

module.exports = {
  BridgeError,
  ERROR_CODES,
  ERROR_STATUS,
  errorEnvelope,
  successEnvelope
};
