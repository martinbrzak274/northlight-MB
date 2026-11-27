'use strict';
// Every page must fit and stay usable on a phone, a tablet and a desktop, in light and dark.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect, sitePages, ROOT } = require('./fixtures');

const SIZES = [
  { name: 'phone', width: 360, height: 740 },
  { name: 'tablet', width: 820, height: 1100 },
  { name: 'desktop', width: 1280, height: 800 }
];

for (const file of sitePages()) {
  for (const size of SIZES) {
    test(`${file} fits a ${size.name} (${size.width}px) without sideways scrolling`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.goto(file);
      await page.waitForLoadState('networkidle');
      await expect(page.locator('h1')).toBeVisible();

      const fit = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth
      }));
      expect(fit.scrollWidth, 'the page is wider than the screen').toBeLessThanOrEqual(fit.clientWidth + 1);

      // The main menu is reachable: every link is in the header, and the current page is marked.
      const links = page.locator('.site-header nav a');
      expect(await links.count()).toBeGreaterThanOrEqual(7);
      if (file !== 'index.html') await expect(page.locator('.site-header nav a[aria-current="page"]')).toHaveCount(1);

      // Buttons and links are big enough to tap (44px is the usual minimum; 40px for compact table buttons).
      const small = await page.evaluate(() => {
        const tooSmall = [];
        for (const el of document.querySelectorAll('button, .button, .site-header nav a, summary')) {
          const box = el.getBoundingClientRect();
          if (box.width === 0 || box.height === 0) continue; // hidden
          if (box.height < 40) tooSmall.push((el.textContent || el.id).trim().slice(0, 30) + ' ' + Math.round(box.height) + 'px');
        }
        return tooSmall;
      });
      expect(small, 'too small to tap').toEqual([]);
    });
  }

  test(`${file} is readable in dark mode as well as light`, async ({ page }) => {
    await page.goto(file);
    const textColor = () => page.evaluate(() => getComputedStyle(document.body).color);
    const lum = (rgb) => { const [r, g, b] = rgb.match(/\d+/g).map(Number); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(async () => lum(await textColor()), { message: 'dark text on the light theme' }).toBeLessThan(90);
    await page.emulateMedia({ colorScheme: 'dark' });
    // the browser applies the setting a moment after it is changed, so wait for it
    await expect.poll(async () => lum(await textColor()), { message: 'light text on the dark theme' }).toBeGreaterThan(165);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('dark');
  });
}

// A drop-down list is drawn by the browser from the colours of the select and its options. With a see-through
// select it came out white with light text in the dark theme, which could not be read.
for (const scheme of ['dark', 'light']) {
  test(`drop-down lists have solid colours and readable text in the ${scheme} theme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('crm.html');
    await expect(page.locator('#k-priority')).toBeVisible();
    const parse = (rgb) => rgb.match(/[\d.]+/g).map(Number);
    const lum = ([r, g, b]) => {
      const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    for (const id of ['k-priority', 'k-account', 'l-source']) {
      const c = await page.evaluate((sel) => {
        const s = document.getElementById(sel);
        const read = (el) => { const x = getComputedStyle(el); return { bg: x.backgroundColor, fg: x.color, checked: el.selected }; };
        return { select: read(s), options: [...s.options].map(read) };
      }, id);
      const parts = [['select', c.select, 7], ...c.options.map((o, i) => [`option ${i + 1}${o.checked ? ' (selected)' : ''}`, o, o.checked ? 4.5 : 7])];
      for (const [name, part, minimum] of parts) {
        const bg = parse(part.bg);
        expect(bg.length === 3 || bg[3] === 1, `${id} ${name}: background must be solid, not see-through (${part.bg})`).toBe(true);
        expect(contrast(parse(part.fg), bg), `${id} ${name}: text on its background`).toBeGreaterThanOrEqual(minimum);
        if (scheme === 'dark' && !part.checked) expect(lum(bg), `${id} ${name}: dark in the dark theme`).toBeLessThan(0.02);
      }
    }
  });
}

test('glass surfaces really blur what is behind them, and fall back to solid ones', async ({ page }) => {
  await page.goto('index.html');
  const header = await page.locator('.site-header').evaluate((el) => {
    const s = getComputedStyle(el);
    return { blur: s.backdropFilter || s.webkitBackdropFilter, bg: s.backgroundColor + ' ' + s.backgroundImage, radius: s.borderRadius };
  });
  expect(header.blur).toMatch(/blur\(\d+px\)/);
  expect(header.radius).not.toBe('0px');
  // with less transparency asked for, the blur goes and the surface is opaque enough to read
  // (read from the file: a browser will not show the rules of a stylesheet on a page opened from disk)
  const cssText = fs.readFileSync(path.join(ROOT, 'glass.css'), 'utf8');
  expect(cssText).toMatch(/@media \(prefers-reduced-transparency: reduce\)[\s\S]*backdrop-filter: none/);
  expect(cssText).toMatch(/@supports not \(\(backdrop-filter: blur\(1px\)\)/);
  expect(cssText).toMatch(/@media \(forced-colors: active\)/);
});
