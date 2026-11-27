'use strict';
const { commands } = require('./commands');
const { parseFirewall, parseHotfix, daysSince, diskStatus } = require('./parsers');

const MAX_UPTIME_DAYS = 30;
const MAX_UPDATE_AGE_DAYS = 60;

// deps: { platform, run, os, statfs, now, root }
async function runHealth({ platform, run, os, statfs, now, root }) {
  const results = [];
  const add = (status, label, detail) => results.push({ status, label, detail });

  add('INFO', 'OS', `${os.type()} ${os.release()} (${os.arch()}), host ${os.hostname()}`);

  const days = os.uptime() / 86400;
  add(days < MAX_UPTIME_DAYS ? 'PASS' : 'FAIL', 'Last restart',
    `${days.toFixed(1)} days ago` + (days < MAX_UPTIME_DAYS ? '' : ' (a restart is recommended)'));

  try {
    const s = statfs(root);
    const d = diskStatus(s.blocks * s.bsize, s.bavail * s.bsize);
    add(d.ok ? 'PASS' : 'FAIL', 'Free disk space',
      `${d.freeGB.toFixed(1)} GB free of ${d.totalGB.toFixed(1)} GB (${d.pct.toFixed(0)}%) on ${root}`);
  } catch (e) {
    add('FAIL', 'Free disk space', 'could not read disk space');
  }

  const fcmd = commands[platform] && commands[platform].firewall;
  if (!fcmd) {
    add('INFO', 'Firewall', 'not checked on this OS');
  } else {
    const r = await run(fcmd[0], fcmd[1]);
    const f = r.ok ? parseFirewall(r.stdout, platform) : { known: false };
    if (!f.known) add('FAIL', 'Firewall', 'could not determine the state');
    else if (f.enabled) add('PASS', 'Firewall', 'enabled');
    else add('FAIL', 'Firewall', 'off for: ' + f.off.join(', '));
  }

  const hcmd = commands[platform] && commands[platform].hotfix;
  if (!hcmd) {
    add('INFO', 'Updates', 'not checked on this OS');
  } else {
    const r = await run(hcmd[0], hcmd[1], { timeout: 30000 });
    const h = r.ok ? parseHotfix(r.stdout) : null;
    if (!h) {
      add('INFO', 'Updates', 'update history not available (pending updates are not checked)');
    } else {
      const age = daysSince(h.date, now);
      add(age <= MAX_UPDATE_AGE_DAYS ? 'PASS' : 'FAIL', 'Updates',
        `last installed update ${h.id} on ${h.date} (${age} days ago); pending updates are not checked`);
    }
  }

  return results;
}

module.exports = { runHealth };
