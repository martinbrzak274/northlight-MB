#!/usr/bin/env node
'use strict';
// Read-only network check: router, then 1.1.1.1, then a website name.
// Usage: node tools/network-doctor.js [website-name]   (default: example.com)
// Changes no settings; see tools/lib/safety.js.
const dns = require('node:dns').promises;
const { run } = require('./lib/run');
const { runDoctor } = require('./lib/network');
const { format } = require('./lib/report');
const { HOST_RE } = require('./lib/safety');

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), ms))
  ]);
}

async function main() {
  const host = process.argv[2] || 'example.com';
  if (!HOST_RE.test(host)) {
    console.error('Invalid website name: ' + host);
    process.exit(2);
  }
  const { steps, verdict } = await runDoctor({
    platform: process.platform,
    run,
    lookup: (h) => withTimeout(dns.lookup(h, { family: 4 }), 5000),
    host
  });
  console.log('Network doctor');
  steps.forEach((s) => console.log(format(s)));
  console.log('');
  if (verdict.ok) console.log(verdict.message);
  else console.log('First failing step: ' + verdict.failedLabel + '\n' + verdict.message);
  process.exitCode = verdict.ok ? 0 : 1;
}

main();
