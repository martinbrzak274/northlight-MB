'use strict';
// Run with: node tools/test/tools.test.js
// All command output below is fake; nothing is executed on the real system.
const test = require('node:test');
const assert = require('node:assert/strict');

const P = require('../lib/parsers');
const { assertReadOnly } = require('../lib/safety');
const { commands, pingCommand } = require('../lib/commands');
const { runDoctor } = require('../lib/network');
const { runHealth } = require('../lib/health');

test('parseGateway reads fake output from each OS', () => {
  assert.equal(P.parseGateway('192.168.1.1\r\n', 'win32'), '192.168.1.1');
  assert.equal(P.parseGateway('default via 192.168.0.1 dev wlan0 proto dhcp metric 600', 'linux'), '192.168.0.1');
  assert.equal(P.parseGateway('   route to: default\n    gateway: 10.0.0.1\n  interface: en0', 'darwin'), '10.0.0.1');
  assert.equal(P.parseGateway('', 'win32'), null);
  assert.equal(P.parseGateway('0.0.0.0', 'win32'), null);
});

test('parsePing tells replies from failures, in any language', () => {
  assert.deepEqual(P.parsePing('Reply from 1.1.1.1: bytes=32 time=12ms TTL=57'), { reachable: true, ms: 12 });
  assert.equal(P.parsePing('Odpověď od 1.1.1.1: bajtů=32 čas=12ms TTL=57').reachable, true);
  assert.equal(P.parsePing('64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=11.9 ms').reachable, true);
  assert.equal(P.parsePing('Reply from 192.168.1.50: Destination host unreachable.').reachable, false);
  assert.equal(P.parsePing('Request timed out.').reachable, false);
});

test('parseFirewall', () => {
  assert.deepEqual(P.parseFirewall('Domain=True\r\nPrivate=True\r\nPublic=True\r\n', 'win32').enabled, true);
  const off = P.parseFirewall('Domain=True\nPrivate=False\nPublic=True\n', 'win32');
  assert.equal(off.enabled, false);
  assert.deepEqual(off.off, ['Private']);
  assert.equal(P.parseFirewall('Firewall is enabled. (State = 1)', 'darwin').enabled, true);
  assert.equal(P.parseFirewall('Firewall is disabled. (State = 0)', 'darwin').enabled, false);
  assert.equal(P.parseFirewall('garbage', 'win32').known, false);
  assert.equal(P.parseFirewall('Status: active', 'linux').known, false);
});

test('parseHotfix, daysSince and diskStatus', () => {
  assert.deepEqual(P.parseHotfix('KB5034441|2026-10-14\r\n'), { id: 'KB5034441', date: '2026-10-14' });
  assert.equal(P.parseHotfix(''), null);
  assert.equal(P.daysSince('2026-10-14', Date.parse('2026-11-27T12:00:00Z')), 44);
  assert.equal(P.diskStatus(100e9, 20e9).ok, true);
  assert.equal(P.diskStatus(100e9, 4e9).ok, false);
  assert.equal(P.diskStatus(1000e9, 60e9).ok, false); // under 10 %
});

// --- fake command output for the end-to-end checks -------------------------

function fakeRun(table) {
  return async (file, args) => {
    const key = file + ' ' + args.join(' ');
    for (const [needle, out] of table) if (key.includes(needle)) return { ok: out !== null, stdout: out || '' };
    return { ok: false, stdout: '' };
  };
}
const GOOD_PING = 'Reply from X: bytes=32 time=5ms TTL=64';
const dnsOk = async () => ({ address: '93.184.216.34' });
const dnsFail = async () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); };

function doctor(table, lookup) {
  return runDoctor({ platform: 'win32', run: fakeRun(table), lookup, host: 'example.com' });
}

test('network doctor: everything passes', async () => {
  const r = await doctor([['NextHop', '192.168.1.1\n'], ['ping', GOOD_PING]], dnsOk);
  assert.deepEqual(r.steps.map((s) => s.status), ['PASS', 'PASS', 'PASS']);
  assert.equal(r.verdict.ok, true);
});

test('network doctor: router unreachable is the first failing step', async () => {
  const r = await doctor([['NextHop', '192.168.1.1\n'], ['192.168.1.1', 'Request timed out.'], ['1.1.1.1', 'Request timed out.']], dnsFail);
  assert.deepEqual(r.steps.map((s) => s.status), ['FAIL', 'FAIL', 'FAIL']);
  assert.equal(r.verdict.failedId, 'router');
});

test('network doctor: no gateway at all', async () => {
  const r = await doctor([['NextHop', '']], dnsOk);
  assert.equal(r.steps[0].status, 'FAIL');
  assert.equal(r.verdict.failedId, 'router');
});

test('network doctor: router ok, internet down', async () => {
  const r = await doctor([['NextHop', '192.168.1.1\n'], ['192.168.1.1', GOOD_PING], ['1.1.1.1', 'Request timed out.']], dnsFail);
  assert.equal(r.verdict.failedId, 'internet');
});

test('network doctor: internet ok, DNS down', async () => {
  const r = await doctor([['NextHop', '192.168.1.1\n'], ['ping', GOOD_PING]], dnsFail);
  assert.equal(r.verdict.failedId, 'dns');
  assert.match(r.steps[2].detail, /ENOTFOUND/);
});

test('network doctor: router that only blocks ping is called out', async () => {
  const r = await doctor([['NextHop', '192.168.1.1\n'], ['192.168.1.1', 'Request timed out.'], ['1.1.1.1', GOOD_PING]], dnsOk);
  assert.equal(r.verdict.failedId, 'router');
  assert.match(r.verdict.message, /blocks ping/);
});

const fakeOs = (uptimeDays) => ({
  type: () => 'Windows_NT', release: () => '10.0.26200', arch: () => 'x64',
  hostname: () => 'TEST-PC', uptime: () => uptimeDays * 86400
});
const NOW = Date.parse('2026-11-27T12:00:00Z');
const roomyDisk = () => ({ bsize: 4096, blocks: 25e6, bavail: 5e6 });
const fullDisk = () => ({ bsize: 4096, blocks: 25e6, bavail: 1e6 });

function health(table, { days = 3, disk = roomyDisk } = {}) {
  return runHealth({ platform: 'win32', run: fakeRun(table), os: fakeOs(days), statfs: disk, now: NOW, root: 'C:\\' });
}
const byLabel = (rs, label) => rs.find((r) => r.label === label);

test('pc health: healthy machine', async () => {
  const rs = await health([['Get-NetFirewallProfile', 'Domain=True\nPrivate=True\nPublic=True\n'], ['Get-HotFix', 'KB1|2026-11-01\n']]);
  assert.equal(byLabel(rs, 'OS').status, 'INFO');
  for (const l of ['Last restart', 'Free disk space', 'Firewall', 'Updates']) assert.equal(byLabel(rs, l).status, 'PASS', l);
});

test('pc health: problems are reported as FAIL', async () => {
  const rs = await health(
    [['Get-NetFirewallProfile', 'Domain=True\nPrivate=False\nPublic=True\n'], ['Get-HotFix', 'KB1|2026-05-01\n']],
    { days: 45, disk: fullDisk });
  for (const l of ['Last restart', 'Free disk space', 'Firewall', 'Updates']) assert.equal(byLabel(rs, l).status, 'FAIL', l);
  assert.match(byLabel(rs, 'Firewall').detail, /Private/);
});

test('pc health: unreadable firewall is FAIL, missing update history is INFO', async () => {
  const rs = await health([['Get-NetFirewallProfile', null], ['Get-HotFix', null]]);
  assert.equal(byLabel(rs, 'Firewall').status, 'FAIL');
  assert.equal(byLabel(rs, 'Updates').status, 'INFO');
});

test('pc health: unsupported OS checks are INFO, not guesses', async () => {
  const rs = await runHealth({ platform: 'linux', run: fakeRun([]), os: fakeOs(1), statfs: roomyDisk, now: NOW, root: '/' });
  assert.equal(byLabel(rs, 'Firewall').status, 'INFO');
  assert.equal(byLabel(rs, 'Updates').status, 'INFO');
});

// --- read-only guarantee ---------------------------------------------------

test('every command the tools use passes the read-only guard', () => {
  for (const platform of Object.keys(commands)) {
    for (const [file, args] of Object.values(commands[platform])) assert.doesNotThrow(() => assertReadOnly(file, args));
    const [file, args] = pingCommand(platform, '1.1.1.1');
    assert.doesNotThrow(() => assertReadOnly(file, args));
  }
});

test('the guard refuses anything that could change a setting', () => {
  const ps = (c) => ['powershell', ['-NoProfile', '-NonInteractive', '-Command', c]];
  const bad = [
    ps('Set-NetFirewallProfile -Enabled False'),
    ps('Get-NetRoute | Remove-NetRoute'),
    ps('Get-NetFirewallProfile; Disable-NetFirewallRule'),
    ps('Get-Content x > y'),
    ps('Invoke-Expression "x"'),
    ['powershell', ['-Command', 'Get-NetRoute']],
    ['netsh', ['advfirewall', 'set', 'allprofiles', 'state', 'off']],
    ['route', ['add', '0.0.0.0', 'mask', '0.0.0.0', '10.0.0.1']],
    ['ip', ['route', 'add', 'default', 'via', '10.0.0.1']],
    ['ping', ['-t', '1.1.1.1']],
    ['ping', ['-n', '1', '-f', '--help']],
    ['rm', ['-rf', '/']]
  ];
  for (const [file, args] of bad) assert.throws(() => assertReadOnly(file, args), /read-only/, file + ' ' + args.join(' '));
});
