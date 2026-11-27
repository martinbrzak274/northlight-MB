'use strict';
// Run with: node tests/serve.test.js
// Tests tools/serve.js, the small static server that the browser tests use by default.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createServer, resolveRequest } = require('../tools/serve.js');

const ROOT = path.join(__dirname, '..');

function listen(root) {
  return new Promise((resolve) => {
    const server = createServer(root);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// Raw request, so the path is sent exactly as written (fetch would tidy ".." away before sending).
function request(server, method, rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path: rawPath }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('serves pages and scripts with the right content types', async () => {
  const server = await listen(ROOT);
  try {
    const cases = [
      ['/index.html', 'text/html; charset=utf-8'],
      ['/helpdesk.js', 'text/javascript; charset=utf-8'],
      ['/rules.json', 'application/json; charset=utf-8'],
      ['/images/hero.svg', 'image/svg+xml']
    ];
    for (const [url, type] of cases) {
      const r = await request(server, 'GET', url);
      assert.equal(r.status, 200, url);
      assert.equal(r.headers['content-type'], type, url);
      assert.equal(r.headers['cache-control'], 'no-store');
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
    }
    const home = await request(server, 'GET', '/');
    assert.equal(home.status, 200);
    assert.equal(home.body, fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), '/ is index.html');
    assert.equal((await request(server, 'GET', '/index.html?x=1#top')).status, 200, 'a query string is ignored');
  } finally { server.close(); }
});

test('refuses to leave the site folder, in any spelling', async () => {
  const server = await listen(path.join(ROOT, 'images'));
  try {
    for (const url of ['/../README.md', '/%2e%2e/README.md', '/..%2fREADME.md', '/%2e%2e%2fREADME.md',
      '/images/../../README.md', '/./../README.md', '/..\\README.md', '/%5c..%5cREADME.md']) {
      const r = await request(server, 'GET', url);
      assert.ok(r.status === 400 || r.status === 404, url + ' gave ' + r.status);
      assert.ok(!r.body.includes('Northlight Studio website'), url + ' leaked a file');
    }
  } finally { server.close(); }
});

test('never serves dotfiles, .git, .github or node_modules', async () => {
  const server = await listen(ROOT);
  try {
    for (const url of ['/.git/config', '/.git/HEAD', '/.github/workflows/deploy.yml', '/.gitignore', '/node_modules/x/y.js', '/%2egit/config']) {
      assert.equal((await request(server, 'GET', url)).status, 404, url);
    }
  } finally { server.close(); }
});

test('no directory listing, unknown files and unknown types are 404', async () => {
  const server = await listen(ROOT);
  try {
    for (const url of ['/images/', '/images', '/tests/', '/tools', '/nope.html', '/package.lock', '/tests/staff.test.js/extra']) {
      assert.equal((await request(server, 'GET', url)).status, 404, url);
    }
  } finally { server.close(); }
});

test('a malformed address is a 400, not a crash', async () => {
  const server = await listen(ROOT);
  try {
    assert.equal((await request(server, 'GET', '/%E0%A4%A')).status, 400);
    assert.equal((await request(server, 'GET', '/a%00b')).status, 400);
    assert.equal((await request(server, 'GET', '/index.html')).status, 200, 'still running');
  } finally { server.close(); }
});

test('only GET and HEAD are allowed, and HEAD sends no body', async () => {
  const server = await listen(ROOT);
  try {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      const r = await request(server, method, '/index.html');
      assert.equal(r.status, 405, method);
      assert.equal(r.headers.allow, 'GET, HEAD');
    }
    const head = await request(server, 'HEAD', '/index.html');
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    assert.equal(Number(head.headers['content-length']), fs.statSync(path.join(ROOT, 'index.html')).size);
  } finally { server.close(); }
});

test('it listens on the loopback address only', async () => {
  const server = await listen(ROOT);
  try {
    assert.equal(server.address().address, '127.0.0.1');
  } finally { server.close(); }
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'serve.js'), 'utf8');
  assert.match(src, /listen\(port, '127\.0\.0\.1'/);
});

test('a symlink that points outside the folder is refused', async (t) => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside');
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-site-'));
  fs.writeFileSync(path.join(site, 'index.html'), '<p>ok</p>');
  try {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(site, 'link.txt'));
  } catch (e) {
    t.skip('this computer does not allow creating symlinks without extra rights');
    return;
  }
  assert.equal(resolveRequest(site, '/link.txt').status, 404);
  assert.equal(resolveRequest(site, '/index.html').status, 200);
});
