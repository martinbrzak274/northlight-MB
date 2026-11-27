'use strict';
// Every external command the tools can run. All are read-only (see safety.js).
// PowerShell cmdlets are used on Windows because their output does not depend
// on the display language, unlike ipconfig or netsh.

const PS = ['-NoProfile', '-NonInteractive', '-Command'];

const commands = {
  win32: {
    gateway: ['powershell', [...PS,
      "Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | " +
      'Select-Object -First 1 | ForEach-Object { $_.NextHop }']],
    firewall: ['powershell', [...PS,
      "Get-NetFirewallProfile | ForEach-Object { $_.Name + '=' + $_.Enabled }"]],
    hotfix: ['powershell', [...PS,
      'Get-HotFix | Sort-Object InstalledOn -Descending | Select-Object -First 1 | ' +
      "ForEach-Object { $_.HotFixID + '|' + $_.InstalledOn.ToString('yyyy-MM-dd') }"]]
  },
  linux: {
    gateway: ['ip', ['route', 'show', 'default']]
  },
  darwin: {
    gateway: ['route', ['-n', 'get', 'default']],
    firewall: ['/usr/libexec/ApplicationFirewall/socketfilterfw', ['--getglobalstate']]
  }
};

function pingCommand(platform, host) {
  if (platform === 'win32') return ['ping', ['-n', '1', '-w', '2000', host]];
  if (platform === 'darwin') return ['ping', ['-c', '1', '-W', '2000', host]];
  return ['ping', ['-c', '1', '-W', '2', host]];
}

module.exports = { commands, pingCommand };
