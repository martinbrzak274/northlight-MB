'use strict';
const { commands, pingCommand } = require('./commands');
const { parseGateway, parsePing, diagnose } = require('./parsers');

// deps: { platform, run(file, args) -> {ok, stdout}, lookup(host) -> {address}, host, target }
async function runDoctor({ platform, run, lookup, host, target = '1.1.1.1' }) {
  const steps = [];

  // 1. Router (default gateway)
  let gateway = null;
  const gcmd = commands[platform] && commands[platform].gateway;
  if (gcmd) {
    const r = await run(gcmd[0], gcmd[1]);
    if (r.ok) gateway = parseGateway(r.stdout, platform);
  }
  if (!gateway) {
    steps.push({ id: 'router', status: 'FAIL', label: 'Router (default gateway)', detail: 'no default gateway found' });
  } else {
    const p = parsePing((await run(...pingCommand(platform, gateway))).stdout);
    steps.push({
      id: 'router', status: p.reachable ? 'PASS' : 'FAIL', label: 'Router (default gateway)',
      detail: gateway + (p.reachable ? (p.ms !== null ? ', ' + p.ms + ' ms' : ', replied') : ', no reply')
    });
  }

  // 2. Internet by IP address
  const p2 = parsePing((await run(...pingCommand(platform, target))).stdout);
  steps.push({
    id: 'internet', status: p2.reachable ? 'PASS' : 'FAIL', label: 'Internet (' + target + ')',
    detail: p2.reachable ? (p2.ms !== null ? p2.ms + ' ms' : 'replied') : 'no reply'
  });

  // 3. Website name (DNS)
  try {
    const a = await lookup(host);
    steps.push({ id: 'dns', status: 'PASS', label: 'Website name (' + host + ')', detail: 'resolved to ' + a.address });
  } catch (e) {
    steps.push({ id: 'dns', status: 'FAIL', label: 'Website name (' + host + ')', detail: e.code || e.message });
  }

  return { steps, verdict: diagnose(steps) };
}

module.exports = { runDoctor };
