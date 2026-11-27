'use strict';
// Guard that keeps every tool strictly read-only. run.js calls assertReadOnly()
// before executing anything, and the tests check it against the real commands.

const HOST_RE = /^(?!-)[A-Za-z0-9.-]{1,253}$/;

const PS_PREFIX = ['-NoProfile', '-NonInteractive', '-Command'];
const ALLOWED_PS_VERBS = new Set(['Get', 'Sort', 'Select', 'ForEach', 'Where']);
const FIREWALL_MAC = '/usr/libexec/ApplicationFirewall/socketfilterfw';

function refuse(file, args) {
  throw new Error('Refusing to run a command that is not on the read-only list: ' +
    file + ' ' + args.join(' '));
}

function checkPowerShell(args) {
  if (args.length !== 4 || PS_PREFIX.some((a, i) => args[i] !== a)) refuse('powershell', args);
  const cmd = args[3];
  if (!/^\(?\s*Get-[A-Z]/.test(cmd)) refuse('powershell', args);
  if (/[;>`&<]/.test(cmd) || /\b(iex|Invoke)/i.test(cmd)) refuse('powershell', args);
  for (const m of cmd.matchAll(/\b([A-Z][A-Za-z]*)-[A-Z][A-Za-z]+/g)) {
    if (!ALLOWED_PS_VERBS.has(m[1])) refuse('powershell', args);
  }
}

function assertReadOnly(file, args) {
  switch (file) {
    case 'powershell':
      return checkPowerShell(args);
    case 'ping': {
      const flagsOk = args.slice(0, -1).every((a) => /^-[nwcW]$/.test(a) || /^\d+$/.test(a));
      if (flagsOk && HOST_RE.test(args[args.length - 1])) return;
      break;
    }
    case 'ip':
      if (args[0] === 'route' && args[1] === 'show') return;
      break;
    case 'route':
      if (args[0] === '-n' && args[1] === 'get') return;
      break;
    case FIREWALL_MAC:
      if (args.length === 1 && args[0].startsWith('--get')) return;
      break;
    default:
  }
  refuse(file, args);
}

module.exports = { HOST_RE, assertReadOnly };
