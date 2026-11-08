'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const netlify = fs.readFileSync(path.join(root, 'netlify.toml'), 'utf8');
const requiredMarkers = [
  'command = "npm run build"',
  'publish = "v0.1/public"',
  'functions = "v0.1/netlify/functions"',
  'from = "/api/*"',
  'to = "/.netlify/functions/api/:splat"',
  'to = "/index.html"'
];

for (const marker of requiredMarkers) {
  if (!netlify.includes(marker)) throw new Error(`netlify.toml is missing: ${marker}`);
}

const files = [
  path.join(root, 'v0.1', 'netlify', 'functions', 'api.js'),
  path.join(root, 'v0.1', 'lib', 'neon-handler.js'),
  path.join(root, 'scripts', 'build.js'),
  path.join(root, 'scripts', 'validate-deployment.js')
];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `Syntax check failed: ${file}`);
}

console.log('Deployment configuration and Function syntax validated.');
