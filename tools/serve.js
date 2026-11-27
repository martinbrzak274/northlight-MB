#!/usr/bin/env node
'use strict';
// A tiny static file server for running the browser tests locally. No dependencies.
// It serves the repository root on 127.0.0.1 only (not reachable from other computers), answers GET and HEAD
// only, never lists a directory, and refuses path tricks (.., encoded dots, backslashes), dotfiles such as
// .git, and node_modules.
// Usage: node tools/serve.js        (port 4173, or set PORT)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8'
};

// Returns { status: 200, file, type } or { status: 400 | 404 }.
function resolveRequest(root, rawUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(rawUrl, 'http://localhost').pathname);
  } catch (e) {
    return { status: 400 };
  }
  if (pathname.includes('\0') || pathname.includes('\\')) return { status: 400 };
  const segments = pathname.split('/').filter(Boolean);
  if (segments.some((s) => s === '..' || s === '.' || s.startsWith('.') || s === 'node_modules')) return { status: 404 };

  let file = path.join(root, ...segments);
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    const real = fs.realpathSync(file);
    const realRoot = fs.realpathSync(root);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return { status: 404 }; // a symlink out of the root
    if (!fs.statSync(real).isFile()) return { status: 404 };
    const type = TYPES[path.extname(real).toLowerCase()];
    if (!type) return { status: 404 };
    return { status: 200, file: real, type };
  } catch (e) {
    return { status: 404 };
  }
}

function createServer(root) {
  return http.createServer((req, res) => {
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, Object.assign({ Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' }, headers));
      res.end('Method not allowed');
      return;
    }
    const r = resolveRequest(root, req.url || '/');
    if (r.status !== 200) {
      res.writeHead(r.status, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, headers));
      res.end(r.status === 400 ? 'Bad request' : 'Not found');
      return;
    }
    fs.readFile(r.file, (err, data) => {
      if (err) {
        res.writeHead(500, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, headers));
        res.end('Server error');
        return;
      }
      res.writeHead(200, Object.assign({ 'Content-Type': r.type, 'Content-Length': data.length }, headers));
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  });
}

module.exports = { createServer, resolveRequest, TYPES };

if (require.main === module) {
  const root = path.join(__dirname, '..');
  const port = Number(process.env.PORT) || 4173;
  createServer(root).listen(port, '127.0.0.1', () => {
    console.log('Serving ' + root + ' at http://127.0.0.1:' + port + '/');
  });
}
