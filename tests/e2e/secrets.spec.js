'use strict';
// The repository must contain no real password, key or token. This needs no browser: it reads the files.
// The fake demo logins on staff.html are the one allowed exception, by exact value (see secret-scan.js).
const base = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { scanText, scanRepo, forbiddenFile, ALLOWED_FAKE_VALUES } = require('./secret-scan.js');

const { test, expect } = base;
const ROOT = path.join(__dirname, '..', '..');

const describeFindings = (list) => list.map((f) => `${f.file}:${f.line}  ${f.rule}  (${f.value})`).join('\n');

test('no file in the repository contains a password, key or token', () => {
  const result = scanRepo(ROOT);
  expect(result.scanned, 'the scan really read the files').toBeGreaterThan(30);
  expect(result.files).toContain('index.html');
  expect(result.findings, 'secrets found:\n' + describeFindings(result.findings)).toEqual([]);
});

test('no file that normally holds secrets is in the repository', () => {
  const { badNames } = scanRepo(ROOT);
  expect(badNames, 'files that should not be committed: ' + JSON.stringify(badNames)).toEqual([]);
});

test('.gitignore keeps secret files and test output out of the repository', () => {
  const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/).map((l) => l.trim());
  for (const entry of ['.env', '*.pem', '*.key', 'node_modules/', 'playwright-report/', 'test-results/']) {
    expect(ignore, entry + ' is ignored').toContain(entry);
  }
});

test('the only passwords and secrets allowed are the fake demo ones, by exact value', () => {
  const demo = fs.readFileSync(path.join(ROOT, 'staff.js'), 'utf8');
  const passwords = [...demo.matchAll(/password: '([^']+)'/g)].map((m) => m[1]);
  const secrets = [...demo.matchAll(/secret: '([^']+)'/g)].map((m) => m[1]);
  expect(passwords).toHaveLength(6);
  expect(secrets).toHaveLength(6);
  // Everything staff.js has must be on the allow list, and nothing else is.
  for (const v of [...passwords, ...secrets]) expect(ALLOWED_FAKE_VALUES.has(v), v + ' is allowed').toBe(true);
  expect(ALLOWED_FAKE_VALUES.size).toBe(13); // 6 passwords, 6 secrets and the public RFC 6238 test secret
  // The page says they are fake.
  expect(fs.readFileSync(path.join(ROOT, 'staff.html'), 'utf8')).toMatch(/Demo accounts \(all fake\)/);
});

// The scanner itself: it must catch obvious secrets, or the tests above would prove nothing.
// The samples are built from pieces so that this file does not contain them in one piece.
test.describe('the scanner catches what it should', () => {
  const samples = [
    ['private key block', '-----BEGIN ' + 'RSA PRIVATE KEY-----'],
    ['AWS access key id', 'AKIA' + 'IOSFODNN7EXAMPLE'],
    ['GitHub token', 'ghp_' + 'a1B2c3D4e5'.repeat(4)],
    ['Slack token', 'xoxb-' + '1234567890-abcdefghij'],
    ['Google API key', 'AIza' + 'Sy' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q'],
    ['JSON web token', ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'abcdefghijk'].join('.')],
    ['cloud storage key or connection string', 'AccountKey=' + 'Ab1+'.repeat(10)],
    ['user and password inside a web address', 'https://admin:' + 'pa55w0rd@db.example.com/x']
  ];
  for (const [rule, text] of samples) {
    test(`finds a ${rule}`, () => {
      const f = scanText('x.txt', 'before\n' + text + '\nafter');
      expect(f.map((x) => x.rule)).toContain(rule);
      expect(f[0].line).toBe(2);
      expect(JSON.stringify(f), 'the report must not print the secret').not.toContain(text);
    });
  }

  // Builds a line such as  name = "value"  from separate pieces, so that this file never contains one.
  const assign = (name, sep, value) => name + sep + value;
  const FLAGGED = 'password, secret or token written into a file';

  test('finds a password, secret or token written as a value', () => {
    for (const line of [
      assign('pass' + 'word', ' = ', '"hunter2-real"'),
      assign('const api', 'Key = ', "'abcd1234efgh'"),
      assign('client_' + 'secret', ': ', '"s3cr3t-value"'),
      assign('tok' + 'en', ': ', "'abcdef123456'"),
      assign('"pass' + 'word"', ': ', '"Winter2026!"')
    ]) {
      const f = scanText('x.js', line);
      expect(f.length, line.slice(0, 8) + '...').toBe(1);
      expect(f[0].rule).toBe(FLAGGED);
      expect(JSON.stringify(f)).not.toContain(line.split(/[:=]\s*/).pop().replace(/["']/g, ''));
    }
  });

  test('allows the fake demo logins only by exact value', () => {
    expect(scanText('staff.js', assign('pass' + 'word', ': ', "'design-demo-1'"))).toEqual([]);
    expect(scanText('staff.js', assign('sec' + 'ret', ': ', "'JBSWY3DPEHPK3PXP'"))).toEqual([]);
    expect(scanText('staff.js', assign('pass' + 'word', ': ', "'design-demo-1x'"))).toHaveLength(1);
    expect(scanText('staff.js', assign('pass' + 'word', ': ', "'something-new'"))).toHaveLength(1);
  });

  test('does not flag ordinary code, words or placeholders', () => {
    for (const line of [
      'function hashPassword(password, salt) { return password; }',
      '<input id="password" type="password" autocomplete="current-password">',
      'The password hashes and the secrets behind the codes are fake.',
      assign('pass' + 'word', ': ', "'{password}'"),
      assign('pass' + 'word', ' = ', '"********"'),
      'const token = nextToken();',
      'secret: process.env.SECRET',
      "add(days < 30 ? 'PASS' : 'FAIL', 'Last restart')",
      "status: 'PASS', label: 'FAIL'"
    ]) {
      expect(scanText('x.js', line), line).toEqual([]);
    }
  });

  test('flags files that normally hold secrets', () => {
    for (const name of ['.env', '.env.local', 'server.pem', 'private.key', 'cert.pfx', 'id_rsa', 'credentials.json', '.npmrc', 'service-account-prod.json']) {
      expect(forbiddenFile(name), name).not.toBeNull();
    }
    for (const name of ['.env.example', 'index.html', 'package.json', 'crm.js', 'northlight.cloud.json', 'key-visual.svg']) {
      expect(forbiddenFile(name), name).toBeNull();
    }
  });
});
