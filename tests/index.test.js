'use strict';
// Run with: node tests/index.test.js
// Checks index.html (SEO, structured data, links), the contact form logic and the help desk storage.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const Store = require('../helpdesk-store.js');
const Contact = require('../contact.js');

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const text = (s) => decode(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

function fakeStorage() {
  const data = {};
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); }
  };
}

// ---------- SEO and structure ----------

test('title is present and under 60 characters', () => {
  const m = /<title>([^<]*)<\/title>/.exec(html);
  assert.ok(m, 'no <title>');
  const title = decode(m[1]).trim();
  assert.ok(title.length > 0 && title.length < 60, `title is ${title.length} characters: ${title}`);
});

test('meta description is present and under 155 characters', () => {
  const m = /<meta\s+name="description"\s+content="([^"]*)"/.exec(html);
  assert.ok(m, 'no meta description');
  const d = decode(m[1]).trim();
  assert.ok(d.length >= 50 && d.length < 155, `description is ${d.length} characters`);
});

test('exactly one H1', () => {
  assert.equal((html.match(/<h1[\s>]/g) || []).length, 1);
});

test('headings do not skip levels', () => {
  const levels = [...html.matchAll(/<h([1-6])[\s>]/g)].map((m) => Number(m[1]));
  for (let i = 1; i < levels.length; i++) assert.ok(levels[i] - levels[i - 1] <= 1, 'jump to h' + levels[i]);
});

test('every image has alt text, with width and height set', () => {
  const imgs = html.match(/<img\b[^>]*>/g) || [];
  assert.ok(imgs.length >= 1, 'expected at least one image');
  for (const img of imgs) {
    const alt = /\balt="([^"]*)"/.exec(img);
    assert.ok(alt && alt[1].trim().length >= 10, 'missing or weak alt: ' + img);
    assert.match(img, /\bwidth="\d+"/);
    assert.match(img, /\bheight="\d+"/);
    const src = /\bsrc="([^"]+)"/.exec(img)[1];
    assert.ok(fs.existsSync(path.join(ROOT, src)), 'image file missing: ' + src);
  }
});

test('page is phone friendly: viewport meta and lang attribute', () => {
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(html, /<html lang="en">/);
});

test('no outside scripts, styles, fonts or images', () => {
  assert.equal(/<script[^>]+src="(?:https?:)?\/\//.test(html), false, 'external script');
  assert.equal(/<link[^>]+href="(?:https?:)?\/\//.test(html), false, 'external link tag');
  assert.equal(/<img[^>]+src="(?:https?:)?\/\//.test(html), false, 'external image');
  assert.equal(/url\(\s*["']?(?:https?:)?\/\//.test(html), false, 'external CSS url()');
  assert.equal(/@import/.test(html), false, '@import');
});

test('header links to the other pages, and all links and anchors resolve', () => {
  const header = /<header[\s\S]*?<\/header>/.exec(html)[0];
  for (const page of ['helpdesk.html', 'crm.html', 'troubleshoot.html', 'staff.html']) {
    assert.ok(header.includes(`href="${page}"`), 'header missing ' + page);
    assert.ok(fs.existsSync(path.join(ROOT, page)), page + ' does not exist');
  }
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  for (const m of html.matchAll(/\bhref="([^"]+)"/g)) {
    const href = m[1];
    if (href.startsWith('#')) assert.ok(ids.has(href.slice(1)), 'broken anchor ' + href);
    else assert.ok(fs.existsSync(path.join(ROOT, href)), 'broken link ' + href);
  }
});

test('three services and four FAQ questions', () => {
  assert.equal((html.match(/<li class="card">/g) || []).length, 3);
  assert.equal((html.match(/<details>/g) || []).length, 4);
});

test('FAQ JSON-LD is valid and matches the visible FAQ word for word', () => {
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  assert.equal(blocks.length, 1);
  const data = JSON.parse(blocks[0][1]);
  assert.equal(data['@context'], 'https://schema.org');
  assert.equal(data['@type'], 'FAQPage');
  assert.equal(data.mainEntity.length, 4);

  const visible = [...html.matchAll(/<details>\s*<summary>([\s\S]*?)<\/summary>\s*<p>([\s\S]*?)<\/p>\s*<\/details>/g)]
    .map((m) => ({ q: text(m[1]), a: text(m[2]) }));
  assert.equal(visible.length, 4);
  data.mainEntity.forEach((item, i) => {
    assert.equal(item['@type'], 'Question');
    assert.equal(item.acceptedAnswer['@type'], 'Answer');
    assert.equal(item.name, visible[i].q, 'question ' + (i + 1));
    assert.equal(item.acceptedAnswer.text, visible[i].a, 'answer ' + (i + 1));
  });
});

test('form fields have labels and error containers', () => {
  for (const f of ['name', 'email', 'message']) {
    assert.ok(html.includes(`<label for="c-${f}">`), 'label for ' + f);
    assert.ok(html.includes(`id="${f}-error"`), 'error element for ' + f);
  }
  assert.match(html, /<form id="contact-form" novalidate>/);
});

// ---------- contact form logic ----------

const good = { name: 'Sam Sample', email: 'sam@example.com', message: 'We would like a new logo and website.' };

test('valid input passes', () => {
  const r = Contact.validate(good);
  assert.equal(r.valid, true);
  assert.deepEqual(r.errors, {});
});

test('empty form gives a clear message for every field', () => {
  const r = Contact.validate({ name: '', email: '', message: '' });
  assert.deepEqual(r.errors, {
    name: 'Enter your name.',
    email: 'Enter your email address so we can reply.',
    message: 'Write a short message about what you need.'
  });
});

test('whitespace-only input counts as empty', () => {
  const r = Contact.validate({ name: '   ', email: ' \n', message: '\n\n  ' });
  assert.equal(Object.keys(r.errors).length, 3);
});

test('name length limits', () => {
  assert.match(Contact.validate({ ...good, name: 'A' }).errors.name, /2 to 60 characters \(you entered 1\)/);
  assert.match(Contact.validate({ ...good, name: 'A'.repeat(61) }).errors.name, /you entered 61/);
  assert.equal(Contact.validate({ ...good, name: 'Al' }).errors.name, undefined);
});

test('email format', () => {
  for (const bad of ['sam', 'sam@', '@example.com', 'sam@example', 'sam @example.com', 'sam@@example.com']) {
    assert.match(Contact.validate({ ...good, email: bad }).errors.email, /does not look right.*name@example\.com/, bad);
  }
  assert.equal(Contact.validate({ ...good, email: 'first.last+tag@sub.example.co' }).errors.email, undefined);
  assert.match(Contact.validate({ ...good, email: 'a'.repeat(50) + '@example.com' }).errors.email, /too long/);
});

test('message length limits say how far off you are', () => {
  assert.match(Contact.validate({ ...good, message: 'Too short' }).errors.message, /9 of at least 10/);
  assert.equal(Contact.validate({ ...good, message: 'x'.repeat(10) }).errors.message, undefined);
  assert.equal(Contact.validate({ ...good, message: 'x'.repeat(200) }).errors.message, undefined);
  assert.match(Contact.validate({ ...good, message: 'x'.repeat(201) }).errors.message, /201 characters.*200 or fewer/);
});

test('the longest allowed enquiry still fits the help desk issue field (300 characters)', () => {
  const v = Contact.validate({ name: 'N'.repeat(60), email: 'a'.repeat(48) + '@example.com', message: 'm'.repeat(200) }).values;
  assert.ok(Contact.buildIssue(v).length <= 300, 'issue is ' + Contact.buildIssue(v).length);
});

// ---------- ticket creation in the help desk storage ----------

const NOW = Date.parse('2026-11-27T12:00:00Z');

test('sending the form creates a New P3 ticket in help desk storage', () => {
  const st = fakeStorage();
  const r = Contact.submit(st, good, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.ticket.requester, 'Sam Sample');
  assert.equal(r.ticket.status, 'New');
  assert.equal(r.ticket.priority, 'P3');
  assert.equal(r.ticket.createdAt, NOW);
  assert.match(r.ticket.issue, /^Website enquiry: We would like a new logo and website\. \(reply to sam@example\.com\)$/);
  // Stored under the key the help desk reads, and the help desk's own loader accepts it.
  const saved = Store.load(st, NOW);
  assert.equal(saved.length, 7, 'six demo tickets plus the new one');
  assert.deepEqual(saved[6], r.ticket);
  assert.equal(r.ticket.id, 7);
});

test('a second enquiry gets the next ticket number and keeps existing tickets', () => {
  const st = fakeStorage();
  Contact.submit(st, good, NOW);
  const r2 = Contact.submit(st, { ...good, name: 'Jordan Demo' }, NOW + 1000);
  assert.equal(r2.ticket.id, 8);
  assert.equal(Store.load(st, NOW).length, 8);
});

test('invalid input creates no ticket', () => {
  const st = fakeStorage();
  const r = Contact.submit(st, { name: '', email: 'x', message: 'short' }, NOW);
  assert.equal(r.ok, false);
  assert.equal(Object.keys(r.errors).length, 3);
  assert.equal(st.getItem(Store.STORAGE_KEY), null);
});

test('input is stored as plain text, not interpreted', () => {
  const st = fakeStorage();
  const r = Contact.submit(st, { ...good, name: 'Eve <b>Bold</b>', message: '<script>alert(1)</script> please call me' }, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.ticket.requester, 'Eve <b>Bold</b>'); // stored verbatim; helpdesk.js shows it with textContent
});

test('blocked storage is reported honestly instead of pretending it worked', () => {
  const blocked = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  const r = Contact.submit(blocked, good, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.message, Contact.STORAGE_FAILED);
  const full = { getItem: () => null, setItem() { throw new Error('quota'); } };
  assert.equal(Contact.submit(full, good, NOW).ok, false);
  assert.equal(Contact.submit(null, good, NOW).ok, false);
});

test('corrupt help desk storage is replaced rather than crashing the form', () => {
  const st = fakeStorage();
  st.setItem(Store.STORAGE_KEY, '{broken');
  assert.equal(Contact.submit(st, good, NOW).ok, true);
  st.setItem(Store.STORAGE_KEY, JSON.stringify([{ id: 'x' }]));
  assert.equal(Contact.submit(st, good, NOW).ok, true);
});

test('priority rules and overdue behave as before the refactor', () => {
  assert.equal(Store.priorityFor(3, 3), 'P1');
  assert.equal(Store.priorityFor(2, 3), 'P1');
  assert.equal(Store.priorityFor(2, 2), 'P2');
  assert.equal(Store.priorityFor(3, 1), 'P2');
  assert.equal(Store.priorityFor(1, 2), 'P3');
  assert.equal(Store.priorityFor(1, 1), 'P3');
  const t = { status: 'New', priority: 'P3', createdAt: NOW };
  assert.equal(Store.isOverdue(t, NOW + 24 * Store.HOUR), false);
  assert.equal(Store.isOverdue(t, NOW + 24 * Store.HOUR + 1), true);
  assert.equal(Store.isOverdue({ ...t, status: 'In progress' }, NOW + 99 * Store.HOUR), false);
  const demo = Store.seed(NOW);
  assert.equal(demo.length, 6);
  assert.equal(Store.valid(demo), true);
});
