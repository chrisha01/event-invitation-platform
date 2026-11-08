/*
 * The deployable site uses the same hosted implementation as v0.1.  Keeping
 * this very small bridge avoids maintaining two API implementations while the
 * Netlify function remains independent from the local SQLite server.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createHandler } = require('../../../v0.1/lib/neon-handler.js');

export { createHandler };
