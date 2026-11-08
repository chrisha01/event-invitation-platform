'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const requiredFiles = [
  'v0.1/public/index.html',
  'v0.1/public/styles.css',
  'v0.1/public/app.js',
  'netlify.toml',
  'v0.1/netlify/functions/api.js'
];

for (const file of requiredFiles) {
  const fullPath = path.join(root, file);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Build input is missing: ${file}`);
  }
}

// Netlify publishes the migrated v0.1 RSVP workspace; Functions are bundled
// separately from the v0.1 Netlify function directory.
console.log(`Static build validated (${requiredFiles.length} files).`);
