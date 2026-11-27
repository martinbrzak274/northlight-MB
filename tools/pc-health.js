#!/usr/bin/env node
'use strict';
// Read-only PC health report. Usage: node tools/pc-health.js
// Changes no settings; see tools/lib/safety.js.
const os = require('node:os');
const fs = require('node:fs');
const { run } = require('./lib/run');
const { runHealth } = require('./lib/health');
const { format } = require('./lib/report');

async function main() {
  const root = process.platform === 'win32' ? (process.env.SystemDrive || 'C:') + '\\' : '/';
  const results = await runHealth({
    platform: process.platform, run, os, statfs: (p) => fs.statfsSync(p), now: Date.now(), root
  });
  console.log('PC health report');
  results.forEach((r) => console.log(format(r)));
  process.exitCode = results.some((r) => r.status === 'FAIL') ? 1 : 0;
}

main();
