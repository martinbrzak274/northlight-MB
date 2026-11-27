'use strict';
// Looks for passwords, keys and tokens in the files of the repository. Used by secrets.spec.js.
// It reports the rule and the place, and only the first two characters of a value, so a failing run does not
// print a secret in the log.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// The fake demo credentials on staff.html (shown on the page on purpose) and the public RFC 6238 test secret.
// They are allowed by exact value only: any other password or secret in the same place is still reported.
const ALLOWED_FAKE_VALUES = new Set([
  'design-demo-1', 'design-demo-2', 'sales-demo-1', 'sales-demo-2', 'it-demo-1', 'it-demo-2',
  'JBSWY3DPEHPK3PXP', 'GEZDGNBVGY3TQOJQ', 'MFRGGZDFMZTWQ2LK', 'NBSWY3DPO5XXE3DE', 'KRSXG5CTMVRXEZLU', 'ONSWG4TFOQYTEMZU',
  'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
]);

// Shapes of real keys and tokens. These are specific enough that a match is almost certainly a real credential.
const KEY_RULES = [
  { name: 'private key block', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
  { name: 'AWS access key id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/ },
  { name: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'npm token', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { name: 'JSON web token', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { name: 'cloud storage key or connection string', re: /\b(?:AccountKey|SharedAccessKey|SharedAccessSignature)=[A-Za-z0-9+/=%]{16,}|DefaultEndpointsProtocol=https?;/ },
  { name: 'user and password inside a web address', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@"'<>]+:[^\s/@"'<>]+@[^\s/"'<>]+/i }
];

// name = "value" or name: "value" where the name says it is a password or key.
// ("pass" on its own is not a name here: it would match PASS / FAIL results in ordinary code.)
const ASSIGNMENT = /\b(?:pass(?:word|wd)|pwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|token)\w*["']?\s*[:=]\s*(["'`])([^"'`\s]{4,})\1/i;

const FORBIDDEN_FILES = [
  { name: 'environment file', re: /^\.env(?:\..+)?$/, except: /^\.env\.(?:example|sample|template)$/ },
  { name: 'certificate or key file', re: /\.(?:pem|key|pfx|p12|jks|keystore)$/i },
  { name: 'SSH private key', re: /^id_(?:rsa|dsa|ecdsa|ed25519)$/ },
  { name: 'credentials file', re: /^(?:credentials|secrets?)\.(?:json|ya?ml|txt|csv|ini|xml|toml|env|properties)$/i },
  { name: 'package manager login file', re: /^\.(?:npmrc|netrc|pypirc)$/ },
  { name: 'service account file', re: /service[-_]?account.*\.json$/i }
];

function looksLikePlaceholder(value) {
  return /^[x*.]+$/i.test(value) || /[{}$<>]/.test(value);
}

function mask(value) { return value.slice(0, 2) + '***'; }

// Returns [{ file, line, rule, value }] for one file's text.
function scanText(file, text) {
  const findings = [];
  text.split(/\r?\n/).forEach((lineText, i) => {
    for (const rule of KEY_RULES) {
      const m = rule.re.exec(lineText);
      if (m) findings.push({ file, line: i + 1, rule: rule.name, value: mask(m[0]) });
    }
    const a = ASSIGNMENT.exec(lineText);
    if (a) {
      const value = a[2];
      if (!ALLOWED_FAKE_VALUES.has(value) && !looksLikePlaceholder(value)) {
        findings.push({ file, line: i + 1, rule: 'password, secret or token written into a file', value: mask(value) });
      }
    }
  });
  return findings;
}

function forbiddenFile(file) {
  const base = path.basename(file);
  for (const f of FORBIDDEN_FILES) {
    if (f.re.test(base) && !(f.except && f.except.test(base))) return f.name;
  }
  return null;
}

// Tracked files plus new files that are not ignored, so a secret is caught before it is committed.
function listRepoFiles(root) {
  try {
    const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return out.split('\0').filter(Boolean).filter((f) => fs.existsSync(path.join(root, f)));
  } catch (e) {
    const files = [];
    (function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['.git', 'node_modules', 'playwright-report', 'test-results'].includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else files.push(path.relative(root, full).split(path.sep).join('/'));
      }
    })(root);
    return files;
  }
}

function scanRepo(root) {
  const files = listRepoFiles(root);
  const findings = [];
  const badNames = [];
  let scanned = 0;
  for (const file of files) {
    const kind = forbiddenFile(file);
    if (kind) badNames.push({ file, kind });
    const full = path.join(root, file);
    const stat = fs.statSync(full);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
    const buf = fs.readFileSync(full);
    if (buf.includes(0)) continue; // a binary file
    scanned++;
    findings.push(...scanText(file, buf.toString('utf8')));
  }
  return { files, scanned, findings, badNames };
}

module.exports = { scanText, scanRepo, forbiddenFile, listRepoFiles, ALLOWED_FAKE_VALUES, KEY_RULES };
