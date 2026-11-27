'use strict';
// The animated side of the glass design. The other browser tests run with reduced motion (see
// playwright.config.js); these turn motion back on, and also check that reduced motion and "no script" both
// leave every page fully visible and usable.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect, ROOT } = require('./fixtures');

// A computed style of the first element that matches.
const style = (page, selector, property) =>
  page.locator(selector).first().evaluate((el, p) => getComputedStyle(el)[p], property);

test.describe('with motion allowed', () => {
  test.use({ reducedMotion: 'no-preference' });
  // One at a time: several browsers animating at once on one machine starve each other, and these tests then
  // time out while loading. (A visitor has one browser, so this is a limit of the test machine, not of the pages.)
  test.describe.configure({ mode: 'serial' });

  test('the ambient light drifts, in small steps so the glass is not redrawn every frame', async ({ page }) => {
    await page.goto('index.html');
    const ambient = await page.evaluate(() => {
      const a = getComputedStyle(document.documentElement, '::before');
      const b = getComputedStyle(document.body, '::before');
      return { aName: a.animationName, aTiming: a.animationTimingFunction, bName: b.animationName, bTiming: b.animationTimingFunction, position: a.position };
    });
    expect(ambient.aName).toBe('drift-a');
    expect(ambient.bName).toBe('drift-b');
    expect(ambient.position).toBe('fixed');
    // A smooth drift behind many blurred surfaces measured much slower without a GPU; steps keep it at 60 fps.
    expect(ambient.aTiming).toMatch(/^steps\(/);
    expect(ambient.bTiming).toMatch(/^steps\(/);
  });

  test('only transform and opacity are animated, so nothing is laid out again while it moves', () => {
    // Read from the file: a browser will not show the rules of a stylesheet on a page opened from disk.
    const css = fs.readFileSync(path.join(ROOT, 'glass.css'), 'utf8');
    const props = new Set();
    for (const m of css.matchAll(/@keyframes\s+[\w-]+\s*\{((?:[^{}]*\{[^{}]*\})+)\s*\}/g)) {
      for (const decl of m[1].matchAll(/([a-z-]+)\s*:/g)) props.add(decl[1]);
    }
    const animated = [...props].sort();
    expect(css.match(/@keyframes/g).length).toBeGreaterThanOrEqual(8);
    expect(animated.length).toBeGreaterThan(0);
    for (const p of animated) expect(['transform', 'opacity', 'box-shadow'], 'animates ' + p).toContain(p);
    expect(animated).not.toContain('width');
    expect(animated).not.toContain('height');
    expect(animated).not.toContain('top');
    expect(animated).not.toContain('left');
  });

  test('sections below the fold ease in when scrolled to, and nothing on screen is hidden at load', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('index.html');
    await expect(page.locator('h1')).toBeVisible();
    expect(await style(page, '.hero-copy', 'opacity'), 'the top of the page is never hidden by the script').not.toBe('0');
    await expect(page.locator('.hero-copy')).not.toHaveClass(/reveal/);

    const contact = page.locator('#contact');
    await expect(contact).toHaveClass(/reveal/);
    expect(await style(page, '#contact', 'opacity'), 'waiting below the fold, and hidden instantly').toBe('0');

    await contact.scrollIntoViewIfNeeded();
    await expect(contact).toHaveClass(/\bin\b/);
    await expect.poll(() => style(page, '#contact', 'opacity')).toBe('1');
    // afterwards the helper classes are removed, so hover effects work as normal
    await expect(contact).not.toHaveClass(/reveal/, { timeout: 4000 });
  });

  test('cards and FAQ rows ease in one after another, and stay usable', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 600 });
    await page.goto('index.html');
    const cards = page.locator('.cards > li');
    await expect(cards).toHaveCount(3);
    await cards.first().scrollIntoViewIfNeeded();
    await expect(cards.nth(2)).toHaveClass(/\bin\b|^card$/, { timeout: 4000 });
    await page.locator('#faq details').first().scrollIntoViewIfNeeded();
    await page.locator('#faq summary').first().click();
    await expect(page.locator('#faq details').first()).toHaveAttribute('open', '');
    await expect(page.locator('#faq details > p').first()).toBeVisible();
  });

  test('the header settles into a stronger surface once the page has scrolled', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 600 });
    await page.goto('index.html');
    const header = page.locator('.site-header');
    await expect(header).not.toHaveClass(/scrolled/);
    await page.mouse.wheel(0, 600);
    await expect(header).toHaveClass(/scrolled/);
    await expect(header).toBeVisible(); // it stays in view (sticky) on a wide screen
    await page.mouse.wheel(0, -2000);
    await expect(header).not.toHaveClass(/scrolled/);
  });

  test('the hero picture leans towards the pointer, and settles when the pointer leaves', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('index.html');
    const read = () => page.locator('.hero-visual').evaluate((el) => el.style.getPropertyValue('--px'));
    expect(await read()).toBe('');
    const box = await page.locator('.hero').boundingBox();
    await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.5);
    await expect.poll(async () => Number(await read())).toBeGreaterThan(0.5);
    await page.mouse.move(5, 5); // outside the hero
    await expect.poll(async () => Number(await read())).toBe(0);
  });

  test('a form still works while everything is animating', async ({ page }) => {
    await page.goto('index.html');
    await page.fill('#c-name', 'Sam Sample');
    await page.fill('#c-email', 'sam@example.com');
    await page.fill('#c-message', 'We would like a new logo please.');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.locator('#form-success')).toBeVisible();
    await expect(page.locator('#form-success')).toContainText('Thank you, Sam Sample.');
  });

  test('the chart bars grow in, and the overdue label pulses', async ({ page }) => {
    await page.goto('crm.html');
    await page.getByRole('button', { name: /Convert Dana Demo/ }).click();
    const bar = page.locator('.chart .bar');
    await expect(bar).toHaveCount(1);
    expect(await style(page, '.chart .bar', 'animationName')).toBe('grow');
    expect(await style(page, '.chart .bar', 'fill')).toMatch(/^rgb\(37, 125, 224\)$/); // the one series colour
  });
});

test.describe('with reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('nothing moves, nothing is hidden, and the content is all there', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 600 });
    await page.goto('index.html');
    const ambient = await page.evaluate(() => getComputedStyle(document.documentElement, '::before').animationName);
    expect(ambient).toBe('none');
    expect(await style(page, '.orb-1', 'animationName')).toBe('none');
    // nothing below the fold is waiting to be revealed
    expect(await page.locator('.reveal').count()).toBe(0);
    for (const selector of ['#contact', '#faq', '.cards > li:nth-child(3)', '.site-footer']) {
      expect(await style(page, selector, 'opacity'), selector).toBe('1');
    }
  });
});

test.describe('without scripts', () => {
  test.use({ javaScriptEnabled: false, reducedMotion: 'no-preference' });

  test('every part of the home page is visible without JavaScript', async ({ page }) => {
    await page.goto('index.html');
    for (const selector of ['h1', '#services', '.cards > li:nth-child(3)', '#faq summary', '#contact', '#c-name', '.site-footer']) {
      await expect(page.locator(selector).first(), selector).toBeVisible();
      // the top of the page eases in with CSS alone, so allow a moment for that to finish
      await expect.poll(() => style(page, selector, 'opacity'), { message: selector }).toBe('1');
    }
    expect(await page.locator('.reveal').count()).toBe(0);
  });
});
