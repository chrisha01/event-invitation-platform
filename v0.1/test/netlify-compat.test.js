'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const publicDir = path.join(__dirname, '../public');
const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const redirects = fs.readFileSync(path.join(publicDir, '_redirects'), 'utf8');

test('frontend API requests are configurable for Netlify Functions and send cookies', () => {
  assert.match(html, /meta name="gatherly-api-base"/);
  assert.match(app, /window\.GATHERLY_API_BASE/);
  assert.match(app, /API_BASE.*\/api/);
  assert.match(app, /credentials:\s*'include'/);
  assert.match(app, /Unable to reach Gatherly/);
});

test('SPA routes and browser downloads work without a local absolute URL', () => {
  assert.match(redirects, /^\/\*\s+\/index\.html\s+200/m);
  assert.match(app, /String\(location\.hash \|\| ''\)/);
  assert.match(app, /function downloadFile/);
  assert.match(app, /URL\.createObjectURL/);
  assert.match(app, /downloadFile\(`\/api\/events\/\$\{event\.id\}\/export`/);
  assert.match(app, /function publicUrl/);
});

test('static assets remain usable after a direct RSVP route load', () => {
  assert.match(html, /<base href="\/">/);
  assert.match(html, /href="styles\.css"/);
  assert.match(html, /src="app\.js"/);
});
