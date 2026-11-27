'use strict';
// Run with: node tests/csp.test.js
// Quick checks of the content security policy, without a browser. The browser tests in tests/e2e/csp.spec.js
// check that the policy is really enforced.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const pages = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html')).sort();
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const POLICY = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; form-action 'none'; base-uri 'none'; object-src 'none'";
const META_RE = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/g;

test('there are pages to check', () => {
  assert.equal(pages.length, 7);
});

test('every page has exactly one policy tag, with exactly this policy', () => {
  for (const f of pages) {
    const tags = [...read(f).matchAll(META_RE)];
    assert.equal(tags.length, 1, f + ' has ' + tags.length + ' policy tags');
    assert.equal(tags[0][1], POLICY, f);
  }
});

test('the keywords in the policy are written with single quotes (without them the browser reads a host name)', () => {
  for (const f of pages) {
    const policy = META_RE.exec(read(f)) || (META_RE.lastIndex = 0, META_RE.exec(read(f)));
    META_RE.lastIndex = 0;
    const values = policy[1].split(';').map((s) => s.trim()).flatMap((d) => d.split(/\s+/).slice(1));
    for (const v of values) assert.match(v, /^'(?:self|none|unsafe-inline)'$/, f + ': ' + v);
  }
});

test('the policy tag comes right after the charset line, before any script, style or link', () => {
  for (const f of pages) {
    const html = read(f);
    const policyAt = html.indexOf('http-equiv="Content-Security-Policy"');
    assert.ok(policyAt > html.indexOf('<head>'), f);
    for (const tag of ['<script', '<style', '<link']) {
      const at = html.indexOf(tag);
      assert.ok(at === -1 || at > policyAt, f + ': ' + tag + ' comes before the policy');
    }
    assert.ok(html.indexOf('<meta charset="utf-8">') < policyAt, f + ': charset first');
  }
});

test('no page needs more than the policy allows', () => {
  for (const f of pages) {
    const html = read(f);
    // inline scripts are blocked: only a data block (the FAQ structured data) may be inline
    const inline = [...html.matchAll(/<script\b([^>]*)>/g)].filter((m) => !/\bsrc=/.test(m[1])).map((m) => m[1].trim());
    assert.ok(inline.every((a) => /type="application\/ld\+json"/.test(a)), f + ' has an inline script: ' + inline);
    assert.ok(!/\son[a-z]+\s*=/.test(html), f + ' has an inline event handler');
    assert.ok(!/javascript:/i.test(html), f + ' has a javascript: address');
    assert.ok(!/<base\b/i.test(html), f + ' has a <base> tag (base-uri is none)');
    assert.ok(!/<form\b[^>]*\baction=/i.test(html), f + ' has a form with an action (form-action is none)');
    assert.ok(!/<(?:iframe|frame|object|embed|applet)\b/i.test(html), f + ' embeds something');
    // scripts, styles and images come from the site itself
    for (const m of html.matchAll(/<(?:script|link|img)\b[^>]*\b(?:src|href)="([^"]+)"/g)) {
      if (/^(?:#|index|helpdesk|crm|automation|settings|staff|troubleshoot)/.test(m[1]) && m[1].endsWith('.html')) continue;
      assert.ok(!/^(?:[a-z]+:)?\/\//i.test(m[1]), f + ' loads ' + m[1] + ' from outside');
      assert.ok(fs.existsSync(path.join(ROOT, m[1])), f + ' loads a missing file: ' + m[1]);
    }
  }
});

test('the decision tree script is a separate file, because inline scripts are blocked', () => {
  const html = read('troubleshoot.html');
  assert.match(html, /<script src="troubleshoot\.js"><\/script>/);
  assert.ok(!/<script>/.test(html));
  assert.ok(fs.existsSync(path.join(ROOT, 'troubleshoot.js')));
});

test('the scripts never write HTML or run text as code', () => {
  const files = fs.readdirSync(ROOT).filter((f) => f.endsWith('.js')).concat(fs.readdirSync(path.join(ROOT, 'tools')).filter((f) => f.endsWith('.js')).map((f) => 'tools/' + f));
  assert.ok(files.length >= 10);
  for (const f of files) {
    const code = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const banned of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'setTimeout("', "setTimeout('"]) {
      assert.ok(!code.includes(banned), f + ' uses ' + banned);
    }
  }
});

test('the only addresses the scripts fetch are the site\'s own files', () => {
  for (const f of ['automation.js', 'settings.js', 'contact.js', 'crm.js', 'helpdesk.js', 'staff.js']) {
    const code = read(f);
    assert.ok(!/https?:\/\//.test(code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/xmlns="[^"]*"|'http:\/\/www\.w3\.org\/2000\/svg'/g, '')), f + ' mentions a web address');
  }
});
