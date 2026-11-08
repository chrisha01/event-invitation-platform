'use strict';

/**
 * Validate deployment configuration without ever logging a connection string.
 * SQLite remains the default for local development and the existing test suite.
 */
function validateDatabaseUrl(value, { required = true } = {}) {
  if (!value) {
    if (required) throw new Error('DATABASE_URL is required for the hosted database.');
    return null;
  }
  let url;
  try { url = new URL(value); } catch { throw new Error('DATABASE_URL must be a valid PostgreSQL URL.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL using postgres:// or postgresql://.');
  }
  return value;
}

function validateRuntimeEnv(env = process.env, { hosted = false } = {}) {
  const databaseUrl = validateDatabaseUrl(env.DATABASE_URL, { required: hosted });
  return Object.freeze({
    databaseUrl,
    isHosted: hosted,
    nodeEnv: env.NODE_ENV || 'development'
  });
}

module.exports = { validateDatabaseUrl, validateRuntimeEnv };
