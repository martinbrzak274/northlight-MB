'use strict';
// Run with: node tests/settings.test.js
// Tests config.js, health.json and the export in settings.js. All data is fake.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Config = require('../config.js');
const S = require('../settings.js');
const Store = require('../helpdesk-store.js');
const Crm = require('../crm.js');
const Auto = require('../automation.js');

const ROOT = path.join(__dirname, '..');
const NOW = Date.parse('2026-11-27T12:00:05Z');
const health = JSON.parse(fs.readFileSync(path.join(ROOT, 'health.json'), 'utf8'));

// A storage that behaves like localStorage: length, key(i), getItem, setItem.
function fakeStorage(initial) {
  const data = Object.assign({}, initial || {});
  return {
    data,
    get length() { return Object.keys(data).length; },
    key: (i) => (i < Object.keys(data).length ? Object.keys(data)[i] : null),
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; }
  };
}

// ---------- config.js ----------

test('config.js has the settings the site uses, and cannot be changed at run time', () => {
  assert.equal(typeof Config.appName, 'string');
  assert.equal(Config.storagePrefix, 'northlight-');
  assert.equal(Config.healthUrl, 'health.json');
  assert.equal(Config.export.filePrefix, 'northlight-export');
  assert.equal(Config.export.formatVersion, 1);
  assert.ok(Object.isFrozen(Config) && Object.isFrozen(Config.export));
  assert.throws(() => { 'use strict'; Config.appName = 'x'; }, TypeError);
});

test('config.js holds plain settings only: no secrets', () => {
  const code = fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8');
  assert.ok(!/password|secret|token|apikey|api_key|bearer/i.test(code.replace(/\/\*[\s\S]*?\*\//, '')));
});

test('every localStorage key the site uses starts with the configured prefix', () => {
  for (const key of [Store.STORAGE_KEY, Crm.STORAGE_KEY, Crm.BACKUP_KEY, Auto.OUTBOX_KEY, Auto.LOG_KEY, 'northlight-staff-v1']) {
    assert.ok(key.startsWith(Config.storagePrefix), key);
  }
});

// ---------- health.json ----------

test('health.json has a name, a version and a build date', () => {
  assert.deepEqual(Object.keys(health), ['name', 'version', 'buildDate']);
  assert.equal(S.validHealth(health), true);
  assert.match(health.version, /^\d+\.\d+\.\d+$/);
  assert.match(health.buildDate, /^\d{4}-\d{2}-\d{2}$/);
});

test('validHealth rejects incomplete or impossible values', () => {
  const ok = { name: 'n', version: '1.2.3', buildDate: '2026-11-27' };
  assert.equal(S.validHealth(ok), true);
  const bad = [null, 'x', [], {}, { ...ok, name: '' }, { ...ok, version: '1.2' }, { ...ok, version: 1 },
    { ...ok, buildDate: '27.11.2026' }, { ...ok, buildDate: '2026-02-31' }, { ...ok, buildDate: '2026-13-01' }, { ...ok, buildDate: undefined }];
  for (const b of bad) assert.equal(S.validHealth(b), false, JSON.stringify(b));
});

const okFetch = (body, status) => async (url, opts) => {
  assert.equal(url, Config.healthUrl, 'only health.json is fetched');
  assert.equal(opts.cache, 'no-store');
  return { ok: (status || 200) < 400, status: status || 200, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
};

test('loadHealth reads health.json, and explains when it cannot', async () => {
  const good = await S.loadHealth(okFetch(health));
  assert.equal(good.ok, true);
  assert.deepEqual(good.info, health);
  assert.equal((await S.loadHealth(null)).ok, false);
  const down = await S.loadHealth(async () => { throw new Error('Failed to fetch'); });
  assert.equal(down.ok, false);
  assert.match(down.message, /Failed to fetch.*page opened from disk/);
  assert.match((await S.loadHealth(okFetch('', 404))).message, /HTTP 404/);
  assert.match((await S.loadHealth(okFetch('{ nope'))).message, /could not be read/);
  assert.match((await S.loadHealth(okFetch({ name: 'x' }))).message, /does not have a name, a version/);
});

// ---------- reading every record ----------

test('collectRecords lists every key, sorted, marks ours, and keeps text exact', () => {
  const st = fakeStorage({
    'zeta-other': 'plain text',
    'northlight-b': JSON.stringify({ a: 1 }),
    'northlight-a': JSON.stringify([1, 2, 3]),
    code: '007',
    flag: 'true',
    empty: '',
    quoted: '"hello"',
    broken: '{not json'
  });
  const recs = S.collectRecords(st, 'northlight-');
  assert.deepEqual(recs.map((r) => r.key), ['broken', 'code', 'empty', 'flag', 'northlight-a', 'northlight-b', 'quoted', 'zeta-other']);
  const by = Object.fromEntries(recs.map((r) => [r.key, r]));
  assert.deepEqual(by['northlight-b'], { key: 'northlight-b', owned: true, valueType: 'json', bytes: 7, value: { a: 1 } });
  assert.deepEqual(by['northlight-a'].value, [1, 2, 3]);
  assert.equal(by['northlight-a'].owned, true);
  assert.equal(by['zeta-other'].owned, false);
  // text is kept exactly: "007" must not become 7, "true" must not become a boolean
  assert.deepEqual([by.code.valueType, by.code.value], ['text', '007']);
  assert.deepEqual([by.flag.valueType, by.flag.value], ['text', 'true']);
  assert.deepEqual([by.empty.valueType, by.empty.value, by.empty.bytes], ['text', '', 0]);
  assert.deepEqual([by.quoted.valueType, by.quoted.value], ['text', '"hello"']);
  assert.deepEqual([by.broken.valueType, by.broken.value], ['text', '{not json']);
});

test('collectRecords counts bytes, not characters', () => {
  const st = fakeStorage({ k: 'Dvořák' }); // 6 characters, 8 bytes in UTF-8
  assert.equal(S.collectRecords(st, 'x')[0].bytes, 8);
});

test('a key that cannot be read is listed as unreadable instead of being dropped', () => {
  const st = fakeStorage({ a: '1', b: '2' });
  const original = st.getItem;
  st.getItem = (k) => { if (k === 'b') throw new Error('denied'); return original(k); };
  const recs = S.collectRecords(st, 'x');
  assert.equal(recs.length, 2);
  assert.deepEqual(recs[1], { key: 'b', owned: false, valueType: 'unreadable', bytes: 0, value: null });
});

// ---------- the export ----------

test('exportAll puts every record in one JSON file with its details', () => {
  const st = fakeStorage({ 'northlight-x': JSON.stringify({ n: 1 }), other: 'hello' });
  const r = S.exportAll(st, Config, health, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.count, 2);
  assert.equal(r.fileName, 'northlight-export-20261127-120005.json');
  const file = JSON.parse(r.json);
  assert.deepEqual(file, r.data, 'the text is exactly the data, as JSON');
  assert.equal(file.format, 'northlight-export');
  assert.equal(file.formatVersion, 1);
  assert.equal(file.exportedAt, '2026-11-27T12:00:05.000Z');
  assert.equal(file.site, 'Northlight Studio');
  assert.deepEqual(file.app, health);
  assert.equal(file.count, 2);
  assert.deepEqual(file.records.map((x) => x.key), ['northlight-x', 'other']);
  assert.deepEqual(file.records[0].value, { n: 1 });
  assert.equal(file.records[1].value, 'hello');
});

test('the export works without health.json, and with nothing saved', () => {
  const r = S.exportAll(fakeStorage(), Config, null, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.count, 0);
  assert.equal(r.data.app, null);
  assert.deepEqual(r.data.records, []);
  assert.doesNotThrow(() => JSON.parse(r.json));
});

test('blocked storage gives a clear message and no file', () => {
  const blocked = { get length() { throw new Error('denied'); }, key() { throw new Error('denied'); }, getItem() { throw new Error('denied'); } };
  const r = S.exportAll(blocked, Config, health, NOW);
  assert.equal(r.ok, false);
  assert.match(r.message, /would not let this page read its storage, so nothing was exported/);
  assert.equal(S.exportAll(null, Config, health, NOW).ok, false);
});

test('the file name is UTC, sortable and safe', () => {
  assert.equal(S.exportFileName(Config, Date.parse('2026-01-02T03:04:05Z')), 'northlight-export-20260102-030405.json');
  const later = S.exportFileName(Config, Date.parse('2026-12-31T23:59:59Z'));
  assert.ok(later > S.exportFileName(Config, Date.parse('2026-01-02T03:04:05Z')));
  assert.match(later, /^[a-z0-9-]+\.json$/);
});

test('the export contains every record the other pages save', () => {
  const st = fakeStorage();
  // helpdesk, CRM and automation write their records the same way the pages do
  Store.createTicket(st, { requester: 'Sam Sample', issue: 'Test', impact: 1, urgency: 1 }, NOW);
  const crm = Crm.createCrm(st, () => NOW);
  crm.init();
  crm.convertLead(1);
  Auto.runEvent(st, Auto.defaultRules(), 'form.sent', { name: 'Sam Sample', email: 'sam@example.com', message: 'urgent please help' }, NOW);
  st.setItem('northlight-staff-v1', JSON.stringify({ users: [{ id: 'a', username: 'riley' }] }));
  st.setItem('someone-elses-key', 'not ours');

  const r = S.exportAll(st, Config, health, NOW);
  const keys = r.data.records.map((x) => x.key);
  for (const k of [Store.STORAGE_KEY, Crm.STORAGE_KEY, Auto.OUTBOX_KEY, Auto.LOG_KEY, 'northlight-staff-v1', 'someone-elses-key']) {
    assert.ok(keys.includes(k), 'missing ' + k);
  }
  assert.equal(r.count, Object.keys(st.data).length, 'nothing was left out');
  const by = Object.fromEntries(r.data.records.map((x) => [x.key, x]));
  assert.equal(by['someone-elses-key'].owned, false);
  assert.equal(by[Store.STORAGE_KEY].owned, true);
  // values come back equal to what the pages stored
  assert.deepEqual(by[Store.STORAGE_KEY].value, JSON.parse(st.data[Store.STORAGE_KEY]));
  assert.deepEqual(by[Crm.STORAGE_KEY].value, JSON.parse(st.data[Crm.STORAGE_KEY]));
  assert.equal(by[Crm.STORAGE_KEY].value.accounts.length, 1);
  assert.equal(by[Auto.OUTBOX_KEY].value.length, 1);
});

test('exporting does not change anything in storage', () => {
  const st = fakeStorage({ 'northlight-x': JSON.stringify({ n: 1 }), other: 'hello' });
  const before = JSON.stringify(st.data);
  S.exportAll(st, Config, health, NOW);
  S.collectRecords(st, 'northlight-');
  assert.equal(JSON.stringify(st.data), before);
});

test('flattenConfig and sizeText', () => {
  const rows = S.flattenConfig(Config, '');
  assert.deepEqual(rows.map((r) => r[0]), ['appName', 'storagePrefix', 'healthUrl', 'export.filePrefix', 'export.formatVersion']);
  assert.deepEqual(rows[4], ['export.formatVersion', '1']);
  assert.equal(S.sizeText(0), '0 B');
  assert.equal(S.sizeText(1023), '1023 B');
  assert.equal(S.sizeText(1536), '1.5 KB');
});

// ---------- the page ----------

const html = fs.readFileSync(path.join(ROOT, 'settings.html'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'settings.js'), 'utf8');

test('every element id that settings.js uses exists in settings.html', () => {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const used = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  assert.ok(used.size >= 9);
  for (const id of used) assert.ok(ids.has(id), 'missing id in settings.html: ' + id);
  assert.equal([...html.matchAll(/\bid="([^"]+)"/g)].length, ids.size, 'duplicate ids');
});

test('settings.html is a phone-friendly page with the warnings, and no outside resources', () => {
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.equal((html.match(/<h1[\s>]/g) || []).length, 1);
  assert.match(html, /Export all data/);
  assert.match(html, /other projects under the same account share this storage/);
  assert.match(html, /password hashes, salts and the secrets/);
  assert.match(html, /not sent anywhere/);
  assert.equal(/<(?:script|link|img)[^>]+(?:src|href)="(?:https?:)?\/\//.test(html), false);
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(scripts, ['config.js', 'settings.js', 'glass.js'], 'config.js loads before settings.js, and glass.js (design effects) last');
  for (const s of scripts) assert.ok(fs.existsSync(path.join(ROOT, s)));
});

test('the page cannot send data anywhere: only health.json is fetched and the download is local', () => {
  const code = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const banned of ['XMLHttpRequest', 'sendBeacon', 'WebSocket', 'EventSource', 'postMessage', 'mailto:']) {
    assert.ok(!code.includes(banned), 'settings.js contains ' + banned);
  }
  assert.deepEqual((code.match(/\bfetch\w*\s*\(/g) || []).filter((x) => !/^fetchFn/.test(x)), [], 'only the injected fetchFn is called');
  assert.equal((code.match(/fetchFn\(Config\.healthUrl/g) || []).length, 1);
  assert.match(code, /createObjectURL/);
  assert.match(code, /a\.download = fileName/);
  assert.ok(!/<form[^>]+action=/.test(html));
});

test('the home page links to the settings page', () => {
  const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.ok(/<header[\s\S]*?href="settings\.html"[\s\S]*?<\/header>/.test(index));
  assert.ok(/<footer[\s\S]*?href="settings\.html"[\s\S]*?<\/footer>/.test(index));
});

// ---------- the deployed copy of health.json ----------

test('the workflow stamps the build date into the deployed health.json only', () => {
  const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'deploy.yml'), 'utf8');
  assert.match(wf, /jq --arg date "\$\(date -u \+%F\)" '\.buildDate = \$date' health\.json/);
  // the stamped file is still a valid health.json: same keys, only the date differs
  const stamped = Object.assign({}, health, { buildDate: new Date(NOW).toISOString().slice(0, 10) });
  assert.equal(S.validHealth(stamped), true);
  assert.deepEqual(Object.keys(stamped), Object.keys(health));
});
