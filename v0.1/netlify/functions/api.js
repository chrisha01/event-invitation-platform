'use strict';

const { neon } = require('@neondatabase/serverless');
const { createHandler } = require('../../lib/neon-handler');
const { validateRuntimeEnv } = require('../../lib/env');

let handlerPromise;

function getHandler() {
  if (!handlerPromise) {
    const config = validateRuntimeEnv(process.env, { hosted: true });
    if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
      throw new Error('SESSION_SECRET must be configured with at least 32 characters.');
    }
    const sql = neon(config.databaseUrl);
    handlerPromise = createHandler({ sql, env: process.env });
  }
  return handlerPromise;
}

exports.handler = async (event, context) => {
  try {
    return await (await getHandler())(event, context);
  } catch (error) {
    // Configuration errors are intentionally explicit; never fall back to
    // SQLite or accept writes on an ephemeral Function filesystem.
    return {
      statusCode: 503,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      body: JSON.stringify({
        error: error.message || 'Hosted database is not configured.',
        code: 'HOSTED_DATABASE_REQUIRED'
      })
    };
  }
};
