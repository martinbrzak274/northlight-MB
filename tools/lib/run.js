'use strict';
const { execFile } = require('node:child_process');
const { assertReadOnly } = require('./safety');

// Runs one read-only command without a shell. Never rejects for a failing
// command: the caller gets { ok, stdout } and decides what it means.
async function run(file, args, { timeout = 10000 } = {}) {
  assertReadOnly(file, args);
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

module.exports = { run };
