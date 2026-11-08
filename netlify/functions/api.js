'use strict';

const { neon } = require('@neondatabase/serverless');

let backendPromise;

async function loadBackend() {
  if (!backendPromise) {
    backendPromise = import('./_shared/backend.mjs').catch((error) => {
      if (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND') return null;
      throw error;
    });
  }
  return backendPromise;
}

function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    },
    body: JSON.stringify(body)
  };
}

exports.handler = async (event, context) => {
  const backend = await loadBackend();
  if (!backend || typeof backend.createHandler !== 'function') {
    // Keep deploys safe until the backend agent supplies the application adapter.
    // Do not silently fall back to SQLite or accept writes without a persistent DB.
    return response(503, {
      error: 'Backend handler is not configured for Netlify Functions.',
      code: 'FUNCTION_BACKEND_NOT_CONFIGURED'
    });
  }

  if (!process.env.DATABASE_URL) {
    return response(503, {
      error: 'DATABASE_URL is not configured.',
      code: 'DATABASE_URL_REQUIRED'
    });
  }
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
    return response(503, {
      error: 'SESSION_SECRET must be configured with at least 32 characters.',
      code: 'SESSION_SECRET_REQUIRED'
    });
  }

  const sql = neon(process.env.DATABASE_URL);
  const handler = await backend.createHandler({ sql, env: process.env });
  return handler(event, context);
};
