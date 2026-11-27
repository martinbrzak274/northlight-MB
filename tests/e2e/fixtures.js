'use strict';
// Shared helpers for the browser tests.
//
// Every test that uses `page` also fails if, while it ran, the page
//   - broke its content security policy,
//   - threw an uncaught error,
//   - opened an alert/confirm/prompt dialog (what injected script usually does),
//   - or asked for anything from outside the site that the policy did not block (the site must work without
//     outside services).
// A test that expects policy violations switches the first check off with test.use({ expectCspViolations: true }).
const base = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

const test = base.test.extend({
  expectCspViolations: [false, { option: true }],

  page: async ({ page, baseURL, expectCspViolations }, use) => {
    const problems = [];
    const siteOrigin = new URL(baseURL).origin;
    const isFileSite = baseURL.startsWith('file:');

    // The browser reports every policy violation as an event. Keep them so the test can read them at the end.
    await page.addInitScript(() => {
      window.__cspViolations = [];
      document.addEventListener('securitypolicyviolation', (e) => {
        window.__cspViolations.push({ directive: e.violatedDirective, uri: e.blockedURI || 'inline' });
      });
    });

    page.on('pageerror', (err) => problems.push('page error: ' + err.message));
    page.on('dialog', (dialog) => {
      problems.push('dialog opened: ' + dialog.type() + ' "' + dialog.message() + '"');
      dialog.dismiss().catch(() => {});
    });
    page.on('console', (msg) => {
      if (!expectCspViolations && msg.type() === 'error' && /Content Security Policy|Refused to/.test(msg.text())) {
        problems.push('console: ' + msg.text());
      }
    });

    // Requests to other sites. Playwright reports a request even when the policy then blocks it, so at the end
    // the ones the browser says it blocked are taken off the list.
    const outsideRequests = [];
    page.on('request', (req) => {
      const url = req.url();
      if (/^(data|blob|about):/.test(url)) return;
      // A site opened from disk (file://) has no real origin, so compare the address scheme instead.
      const outside = isFileSite ? !url.startsWith('file:') : new URL(url).origin !== siteOrigin;
      if (outside) outsideRequests.push(url);
    });

    await use(page);

    let violations = [];
    if (!page.isClosed()) {
      try { violations = await page.evaluate(() => window.__cspViolations || []); } catch (e) { /* the page was navigating away */ }
    }
    if (!expectCspViolations) violations.forEach((v) => problems.push('policy violation: ' + v.directive + ' blocked ' + v.uri));
    const blocked = new Set(violations.map((v) => v.uri));
    outsideRequests.filter((url) => !blocked.has(url)).forEach((url) => problems.push('request outside the site: ' + url));

    base.expect(problems, 'problems seen while the test ran').toEqual([]);
  }
});

// Every page of the site: all .html files in the repository root.
function sitePages() {
  return fs.readdirSync(ROOT).filter((f) => f.endsWith('.html')).sort();
}

module.exports = { test, expect: base.expect, ROOT, sitePages };
