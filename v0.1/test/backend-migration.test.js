'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { validateDatabaseUrl, validateRuntimeEnv } = require('../lib/env');
const { createNeonAdapter } = require('../lib/neon');

test('database environment validation accepts PostgreSQL URLs and rejects malformed values', () => {
  assert.equal(validateDatabaseUrl('postgresql://user:secret@example.test/app'), 'postgresql://user:secret@example.test/app');
  assert.throws(() => validateDatabaseUrl('sqlite://local'), /PostgreSQL URL/);
  assert.throws(() => validateRuntimeEnv({}, { hosted: true }), /DATABASE_URL/);
  assert.equal(validateRuntimeEnv({}, { hosted: false }).databaseUrl, null);
});

test('Neon adapter is dependency-injected and applies migrations in lexical order', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherly-migrations-'));
  fs.writeFileSync(path.join(directory, '002_second.sql'), 'select 2;');
  fs.writeFileSync(path.join(directory, '001_first.sql'), 'select 1;');
  fs.writeFileSync(path.join(directory, 'README.md'), 'ignored');
  const calls = [];
  const sql = (strings) => { calls.push(Array.isArray(strings) ? strings.join('') : strings); };
  try {
    const adapter = createNeonAdapter({ connectionString: 'postgres://u:p@example.test/db', sql });
    assert.equal(adapter.connectionString, 'postgres://u:p@example.test/db');
    assert.deepEqual(await adapter.migrate(directory), ['001_first.sql', '002_second.sql']);
    assert.deepEqual(calls, ['select 1;', 'select 2;']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('hosted schema contains the API contract core tables and idempotent DDL', () => {
  const schema = fs.readFileSync(path.join(__dirname, '../migrations/001_initial.sql'), 'utf8');
  for (const table of ['hosts', 'sessions', 'events', 'guest_units', 'rsvps', 'rsvp_attendees', 'email_outbox', 'local_messages', 'check_ins']) {
    assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  }
  assert.match(schema, /CREATE INDEX IF NOT EXISTS/);
});
