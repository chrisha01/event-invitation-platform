'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { validateDatabaseUrl } = require('./env');

/**
 * Small, dependency-injected Neon adapter. Keeping the SQL client behind this
 * interface makes migrations testable and leaves SQLite Store untouched locally.
 */
function createNeonAdapter(options = {}) {
  const connectionString = validateDatabaseUrl(
    options.connectionString || process.env.DATABASE_URL
  );
  let sql = options.sql;
  if (!sql) {
    let neon;
    try { ({ neon } = require('@neondatabase/serverless')); } catch (error) {
      error.message = `@neondatabase/serverless is required for Neon: ${error.message}`;
      throw error;
    }
    sql = neon(connectionString);
  }
  if (typeof sql !== 'function') throw new TypeError('Neon adapter requires a SQL function.');

  return {
    connectionString,
    sql,
    query: (strings, ...values) => sql(strings, ...values),
    async migrate(directory = path.join(__dirname, '..', 'migrations')) {
      const files = (await fs.readdir(directory))
        .filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
      for (const file of files) {
        const source = await fs.readFile(path.join(directory, file), 'utf8');
        if (source.trim()) {
          if (typeof sql.query === 'function') {
            await sql.query(source);
          } else if (typeof sql.unsafe === 'function') {
            await sql.unsafe(source);
          } else {
            const strings = [source];
            strings.raw = strings;
            await sql(strings);
          }
        }
      }
      return files;
    }
  };
}

module.exports = { createNeonAdapter };
