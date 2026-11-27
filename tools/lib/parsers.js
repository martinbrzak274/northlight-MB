'use strict';
// Pure functions: text in, data out. Easy to test with fake command output.

const IPV4 = /\b(\d{1,3}(?:\.\d{1,3}){3})\b/;

function parseGateway(text, platform) {
  let m;
  if (platform === 'linux') m = /default via (\d{1,3}(?:\.\d{1,3}){3})/.exec(text);
  else if (platform === 'darwin') m = /gateway:\s*(\d{1,3}(?:\.\d{1,3}){3})/.exec(text);
  else m = IPV4.exec(text);
  if (!m || m[1] === '0.0.0.0') return null;
  return m[1];
}

// A reply line always contains TTL=, whatever the OS language is. Windows can
// exit with 0 on "Destination host unreachable", so the exit code is not used.
function parsePing(text) {
  const reachable = /\bttl[=:]\s*\d+/i.test(text);
  const t = /(?:time|čas)[=<]\s*([\d.]+)\s*ms/i.exec(text);
  return { reachable, ms: t ? Number(t[1]) : null };
}

function parseFirewall(text, platform) {
  if (platform === 'win32') {
    const profiles = [];
    for (const line of text.split(/\r?\n/)) {
      const m = /^(\w+)=(True|False)$/.exec(line.trim());
      if (m) profiles.push({ name: m[1], enabled: m[2] === 'True' });
    }
    if (!profiles.length) return { known: false };
    const off = profiles.filter((p) => !p.enabled).map((p) => p.name);
    return { known: true, enabled: off.length === 0, off, profiles };
  }
  if (platform === 'darwin') {
    if (/is enabled/i.test(text)) return { known: true, enabled: true, off: [] };
    if (/is disabled/i.test(text)) return { known: true, enabled: false, off: ['all'] };
  }
  return { known: false };
}

function parseHotfix(text) {
  const m = /^(\S+)\|(\d{4}-\d{2}-\d{2})\s*$/m.exec(text.trim());
  return m ? { id: m[1], date: m[2] } : null;
}

function daysSince(dateStr, now) {
  return Math.floor((now - Date.parse(dateStr + 'T00:00:00Z')) / 86400000);
}

function diskStatus(totalBytes, freeBytes) {
  const pct = (freeBytes / totalBytes) * 100;
  const freeGB = freeBytes / 1e9;
  return { pct, freeGB, totalGB: totalBytes / 1e9, ok: pct >= 10 && freeGB >= 5 };
}

// Names the first failing step and says what it usually means.
function diagnose(steps) {
  const failed = steps.find((s) => s.status === 'FAIL');
  if (!failed) return { ok: true, message: 'All checks passed. Connectivity looks healthy.' };
  const allElseOk = steps.every((s) => s === failed || s.status === 'PASS');
  const hints = {
    router: allElseOk && steps.length > 1
      ? 'The router did not answer ping, but the internet and DNS work, so the router probably just blocks ping.'
      : 'This PC cannot reach the router. Check the Wi-Fi or cable connection, then power-cycle the router.',
    internet: 'The router answers but 1.1.1.1 does not: the router has no internet. Check the modem and WAN light, or contact the ISP.',
    dns: 'The internet is reachable but the website name does not resolve: a DNS problem. Ask IT or the ISP to check the DNS servers.'
  };
  return { ok: false, failedId: failed.id, failedLabel: failed.label, message: hints[failed.id] };
}

module.exports = { parseGateway, parsePing, parseFirewall, parseHotfix, daysSince, diskStatus, diagnose };
