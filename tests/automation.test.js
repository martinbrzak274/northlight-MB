'use strict';
// Run with: node tests/automation.test.js
// Tests rules.json and the engine in automation.js. All data is fake.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const A = require('../automation.js');
const Store = require('../helpdesk-store.js');
const Crm = require('../crm.js');
const Contact = require('../contact.js');

const ROOT = path.join(__dirname, '..');
const rulesText = fs.readFileSync(path.join(ROOT, 'rules.json'), 'utf8');
const rulesDoc = JSON.parse(rulesText);
const clone = (x) => JSON.parse(JSON.stringify(x));

const NOW = Date.parse('2026-11-27T12:00:00Z');
const info = (doc) => { const v = A.validateRules(doc || rulesDoc); return { rules: v.rules, source: 'test rules', problems: v.problems }; };

function fakeStorage() {
  const data = {};
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); }
  };
}

const person = { name: 'Sam Sample', email: 'sam@example.com', message: 'We would like a new logo please.' };
const send = (st, payload, doc, now) => A.runEvent(st, info(doc), 'form.sent', Object.assign({}, person, payload), now == null ? NOW : now);
const lines = (st) => A.readLog(st).sort((a, b) => a.id - b.id);

// ---------- rules.json ----------

test('rules.json is valid and has the three rules in order', () => {
  const v = A.validateRules(rulesDoc);
  assert.deepEqual(v.problems, []);
  assert.deepEqual(v.rules.map((r) => r.id), ['form-create-lead', 'form-create-ticket', 'urgent-escalate']);
});

test('the built-in copy used on file:// pages is identical to rules.json', () => {
  assert.deepEqual(A.DEFAULT_DOC, rulesDoc);
});

test('the rules say what the brief says', () => {
  const [lead, ticket, urgent] = rulesDoc.rules;
  assert.equal(lead.when.event, 'form.sent');
  assert.equal(lead.do[0].action, 'crm.createLead');
  assert.equal(ticket.when.event, 'form.sent');
  assert.equal(ticket.do[0].action, 'helpdesk.createTicket');
  assert.equal(urgent.when.messageContainsWord, 'urgent');
  assert.deepEqual(urgent.do.map((a) => a.action), ['helpdesk.setPriority', 'outbox.add']);
  assert.equal(urgent.do[0].priority, 'P1');
});

// ---------- validating rules ----------

function withRule(mutate) {
  const doc = clone(rulesDoc);
  mutate(doc.rules[2]);
  return A.validateRules(doc);
}

test('a bad rule is skipped and reported, and the others are kept', () => {
  const bad = [
    ['unknown action', (r) => { r.do[0].action = 'email.send'; }, /unknown "action"/],
    ['missing setting', (r) => { delete r.do[1].subject; }, /missing the setting "subject"/],
    ['misspelt setting', (r) => { r.do[0].priorty = 'P1'; }, /unknown setting "priorty"/],
    ['bad priority', (r) => { r.do[0].priority = 'P9'; }, /P1, P2 or P3/],
    ['bad placeholder', (r) => { r.do[1].body = 'Hi {nane}'; }, /unknown placeholder \{nane\}/],
    ['wrong type', (r) => { r.do[1].to = 42; }, /must be some text/],
    ['unknown event', (r) => { r.when.event = 'form.opened'; }, /when\.event/],
    ['unknown condition', (r) => { r.when.messageContains = 'urgent'; }, /unknown condition/],
    ['word with symbols', (r) => { r.when.messageContainsWord = 'ur(gent'; }, /one word of letters only/],
    ['empty do', (r) => { r.do = []; }, /at least one action/],
    ['bad id', (r) => { r.id = 'Urgent Rule!'; }, /"id" must be/],
    ['unknown key', (r) => { r.whenn = {}; }, /unknown key "whenn"/],
    ['bad enabled', (r) => { r.enabled = 'yes'; }, /true or false/]
  ];
  for (const [name, mutate, re] of bad) {
    const v = withRule(mutate);
    assert.equal(v.rules.length, 2, name + ': only the bad rule is dropped');
    assert.equal(v.problems.length, 1, name);
    assert.match(v.problems[0], re, name);
    assert.match(v.problems[0], /skipped/, name);
  }
});

test('a lead source must be one the CRM knows, amounts must be whole numbers', () => {
  const doc = clone(rulesDoc);
  doc.rules[0].do[0].source = 'Carrier pigeon';
  assert.match(A.validateRules(doc).problems[0], /Website form/);
  const doc2 = clone(rulesDoc);
  doc2.rules[0].do[0].value = 1.5;
  assert.match(A.validateRules(doc2).problems[0], /whole number/);
});

test('duplicate ids and a malformed file are rejected', () => {
  const doc = clone(rulesDoc);
  doc.rules[1].id = doc.rules[0].id;
  const v = A.validateRules(doc);
  assert.equal(v.rules.length, 2);
  assert.match(v.problems[0], /already uses this id/);
  for (const junk of [null, 'x', [], { version: 2, rules: [] }, { version: 1 }, { version: 1, rules: {} }]) {
    const r = A.validateRules(junk);
    assert.deepEqual(r.rules, []);
    assert.equal(r.problems.length, 1);
  }
});

// ---------- running the rules ----------

test('a normal message creates a lead and a P3 ticket, and no alert', () => {
  const st = fakeStorage();
  const run = send(st);
  assert.equal(run.ok, true);
  assert.deepEqual(run.matched, ['form-create-lead', 'form-create-ticket']);

  const crm = Crm.load(st, NOW);
  assert.equal(crm.leads.length, 4, 'three demo leads plus the new one');
  const lead = crm.leads[3];
  assert.deepEqual([lead.name, lead.email, lead.company, lead.source, lead.value, lead.status],
    ['Sam Sample', 'sam@example.com', 'Not given', 'Website form', 0, 'Open']);
  assert.equal(Crm.valid(crm), true);

  const tickets = Store.load(st, NOW);
  assert.equal(tickets.length, 7);
  const t = tickets[6];
  assert.equal(t.requester, 'Sam Sample');
  assert.equal(t.issue, 'Website enquiry: We would like a new logo please. (reply to sam@example.com)');
  assert.equal(t.priority, 'P3');
  assert.equal(t.status, 'New');

  assert.deepEqual(A.readOutbox(st), []);
});

test('an urgent message sets the ticket to P1 and adds an alert to the outbox', () => {
  const st = fakeStorage();
  const run = send(st, { message: 'Our site is down and this is URGENT, please call.' });
  assert.equal(run.ok, true);
  assert.deepEqual(run.matched, ['form-create-lead', 'form-create-ticket', 'urgent-escalate']);

  const tickets = Store.load(st, NOW);
  const t = tickets[tickets.length - 1];
  assert.equal(t.priority, 'P1');
  assert.equal(Store.TARGET_HOURS[t.priority], 1);
  assert.equal(t.id, run.ctx.ticket.id);
  assert.equal(tickets.filter((x) => x.priority === 'P1' && /Website enquiry/.test(x.issue)).length, 1);

  const out = A.readOutbox(st);
  assert.equal(out.length, 1);
  assert.equal(out[0].channel, 'alert');
  assert.equal(out[0].to, 'oncall@example.com');
  assert.equal(out[0].subject, 'URGENT enquiry: ticket #' + t.id);
  assert.match(out[0].body, /^Sam Sample \(sam@example\.com\) wrote: Our site is down/);
  assert.equal(out[0].status, A.NOT_SENT);
  assert.equal(out[0].ruleId, 'urgent-escalate');
});

test('the word "urgent" is matched as a whole word in any case', () => {
  const hit = ['This is urgent', 'URGENT: call me', 'Urgent!', 'it is (urgent) really', 'not urgent at all'];
  const miss = ['This is urgently needed', 'An insurgent idea for us', 'nonurgent matter here', 'We need help soon please'];
  for (const m of hit) assert.equal(A.matches({ messageContainsWord: 'urgent' }, { message: m }), true, m);
  for (const m of miss) assert.equal(A.matches({ messageContainsWord: 'urgent' }, { message: m }), false, m);
});

test('every rule that runs writes a log line, after one line for the event', () => {
  const st = fakeStorage();
  send(st, { message: 'This is urgent please help' });
  const log = lines(st);
  assert.deepEqual(log.map((l) => l.ruleId), ['engine', 'form-create-lead', 'form-create-ticket', 'urgent-escalate']);
  assert.ok(log.every((l) => l.status === 'ok' && l.at === NOW));
  assert.match(log[0].message, /Event form\.sent from Sam Sample: 3 of 3 rules matched \(rules from test rules\)/);
  assert.match(log[1].message, /created CRM lead #4 \(Sam Sample, source Website form\)/);
  assert.match(log[2].message, /created help desk ticket #7 \(P3\)/);
  assert.match(log[3].message, /set ticket #7 to P1 \(was P3\).*added the alert "URGENT enquiry: ticket #7" to the outbox \(not sent\)/);
});

test('a rule that does not match writes no line of its own', () => {
  const st = fakeStorage();
  send(st);
  assert.deepEqual(lines(st).map((l) => l.ruleId), ['engine', 'form-create-lead', 'form-create-ticket']);
  assert.match(lines(st)[0].message, /2 of 3 rules matched/);
});

test('the log keeps growing across events, with increasing ids', () => {
  const st = fakeStorage();
  send(st);
  send(st, { name: 'Jo Demo' }, null, NOW + 1000);
  const log = A.readLog(st);
  assert.equal(log.length, 6);
  assert.deepEqual(log.map((l) => l.id), [1, 2, 3, 4, 5, 6]);
  assert.equal(new Set(log.map((l) => l.at)).size, 2);
});

test('log lines and outbox entries do not contain the visitor\'s email twice over in the log', () => {
  const st = fakeStorage();
  send(st, { message: 'urgent please call me back' });
  const text = JSON.stringify(A.readLog(st));
  assert.ok(!text.includes('sam@example.com'), 'the log names the person but not their email');
});

test('disabled rules do not run and do not log', () => {
  const doc = clone(rulesDoc);
  doc.rules[0].enabled = false;
  const st = fakeStorage();
  const run = send(st, {}, doc);
  assert.deepEqual(run.matched, ['form-create-ticket']);
  assert.equal(Crm.load(st, NOW).leads.length, 3, 'no lead was added');
  assert.ok(!lines(st).some((l) => l.ruleId === 'form-create-lead'));
});

test('a failing rule stops, is logged as an error, and the other rules still run', () => {
  const doc = clone(rulesDoc);
  doc.rules.splice(1, 1); // no ticket rule, so the urgent rule has no ticket to change
  const st = fakeStorage();
  const run = send(st, { message: 'urgent: call me' }, doc);
  assert.equal(run.ok, false);
  assert.equal(run.errors.length, 1);
  assert.equal(run.errors[0].ruleId, 'urgent-escalate');
  assert.match(run.errors[0].message, /no ticket to change/);
  assert.deepEqual(A.readOutbox(st), [], 'the alert was not added');
  assert.equal(Crm.load(st, NOW).leads.length, 4, 'the lead rule still ran');
  const log = lines(st);
  assert.equal(log[log.length - 1].status, 'error');
  assert.match(log[log.length - 1].message, /Stopped: There is no ticket to change/);
});

test('an invalid lead (for example a bad email) is an error, not a crash', () => {
  const st = fakeStorage();
  const run = A.runEvent(st, info(), 'form.sent', { name: 'X', email: 'nope', message: 'hello there friend' }, NOW);
  assert.equal(run.ok, false);
  assert.equal(run.errors[0].ruleId, 'form-create-lead');
  assert.equal(run.errors[0].code, 'invalid');
  assert.equal(Store.load(st, NOW).length, 7, 'the ticket rule still ran');
});

test('blocked storage is reported as a storage error and never throws', () => {
  const blocked = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  const run = A.runEvent(blocked, info(), 'form.sent', Object.assign({}, person, { message: 'urgent help' }), NOW);
  assert.equal(run.ok, false);
  assert.equal(run.errors[0].code, 'storage', 'the first error is the storage error');
  assert.ok(run.errors.filter((e) => e.code === 'storage').length >= 2, 'both the lead and the ticket rule hit it');
  // the urgent rule then has no ticket to change, which is also reported rather than hidden
  assert.ok(run.errors.some((e) => e.ruleId === 'urgent-escalate'));
  const visitor = Contact.submit(blocked, Object.assign({}, person, { message: 'urgent help please' }), NOW);
  assert.equal(visitor.ok, false);
  assert.equal(visitor.message, Contact.STORAGE_FAILED, 'the visitor is told about storage, not about internals');
  const full = { getItem: () => null, setItem() { throw new Error('quota'); } };
  assert.equal(A.runEvent(full, info(), 'form.sent', person, NOW).ok, false);
});

test('the outbox and the log keep only the newest 200 entries', () => {
  const st = fakeStorage();
  const doc = clone(rulesDoc);
  doc.rules = doc.rules.slice(2); // only the urgent rule is needed here; give it its own ticket first
  const long = clone(rulesDoc);
  for (let i = 0; i < 70; i++) A.runEvent(st, info(long), 'form.sent', Object.assign({}, person, { message: 'urgent number ' + i + ' please' }), NOW + i);
  assert.equal(A.readOutbox(st).length, 70);
  assert.equal(A.readLog(st).length, 200, 'the log is capped (70 events x 4 lines)');
  assert.equal(A.readLog(st).slice(-1)[0].at, NOW + 69, 'the newest lines are kept');
  assert.equal(A.clearOutbox(st), true);
  assert.equal(A.clearLog(st), true);
  assert.deepEqual(A.readOutbox(st), []);
  assert.deepEqual(A.readLog(st), []);
});

test('placeholders are filled from the message and from earlier rules', () => {
  const scope = { name: 'Sam', email: 'e@example.com', message: 'hi {name}', ticket: { id: 9, priority: 'P1' }, lead: { id: 4 } };
  assert.equal(A.fill('{name} {ticket.id} {ticket.priority} {lead.id}', scope), 'Sam 9 P1 4');
  assert.equal(A.fill('{message}', scope), 'hi {name}', 'values are not filled a second time');
  assert.throws(() => A.fill('{ticket.id}', { name: 'x', ticket: null }), /Create the ticket in an earlier rule/);
});

test('a tidy corrupt outbox or log is replaced, not fatal', () => {
  const st = fakeStorage();
  st.setItem(A.OUTBOX_KEY, '{nope');
  st.setItem(A.LOG_KEY, JSON.stringify({ not: 'a list' }));
  assert.equal(send(st, { message: 'urgent now please' }).ok, true);
  assert.equal(A.readOutbox(st).length, 1);
});

// ---------- the setPriority helper in the help desk store ----------

test('Store.setPriority changes impact, urgency and priority together', () => {
  const st = fakeStorage();
  Store.load(st, NOW);
  const r = Store.setPriority(st, 2, 'P1', NOW);
  assert.equal(r.ok, true);
  assert.equal(r.previous, 'P3');
  assert.deepEqual([r.ticket.priority, r.ticket.impact, r.ticket.urgency], ['P1', 3, 3]);
  assert.equal(Store.load(st, NOW).find((t) => t.id === 2).priority, 'P1', 'it was saved');
  for (const p of ['P1', 'P2', 'P3']) {
    assert.equal(Store.setPriority(st, 2, p, NOW).ticket.priority, p);
  }
  assert.equal(Store.setPriority(st, 99, 'P1', NOW).ok, false);
  assert.equal(Store.setPriority(st, 2, 'P7', NOW).ok, false);
  const full = { getItem: () => null, setItem() { throw new Error('quota'); } };
  assert.equal(Store.setPriority(full, 1, 'P1', NOW).ok, false);
});

// ---------- loading rules.json ----------

const okFetch = (body, status) => async (url) => {
  assert.equal(url, 'rules.json', 'the only thing ever fetched is rules.json');
  return { ok: (status || 200) < 400, status: status || 200, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
};

test('rules.json is used when it can be read, so edits take effect', async () => {
  const edited = clone(rulesDoc);
  edited.rules[2].enabled = false;
  const r = await A.loadRules(okFetch(edited));
  assert.equal(r.source, 'rules.json');
  assert.deepEqual(r.problems, []);
  assert.equal(r.rules.length, 3);
  assert.equal(r.rules[2].enabled, false);
  // and the engine really follows the edit
  const st = fakeStorage();
  A.runEvent(st, r, 'form.sent', Object.assign({}, person, { message: 'urgent now please' }), NOW);
  assert.deepEqual(A.readOutbox(st), []);
});

test('when rules.json cannot be read the built-in copy is used, and the source says so', async () => {
  const cases = [
    ['no fetch', null, /not available/],
    ['network or file:// failure', async () => { throw new Error('Failed to fetch'); }, /could not be read: Failed to fetch/],
    ['404', okFetch('', 404), /HTTP 404/]
  ];
  for (const [name, f, re] of cases) {
    const r = await A.loadRules(f);
    assert.match(r.source, /^the built-in copy/, name);
    assert.match(r.source, re, name);
    assert.equal(r.rules.length, 3, name);
  }
});

test('a broken rules.json never loses a message: built-in copy plus a visible problem', async () => {
  const r = await A.loadRules(okFetch('{ this is not json'));
  assert.match(r.source, /not valid JSON/);
  assert.equal(r.rules.length, 3);
  assert.match(r.problems[0], /not valid JSON/);
  const allBad = await A.loadRules(okFetch({ version: 1, rules: [{ id: 'x' }] }));
  assert.equal(allBad.rules.length, 3);
  assert.ok(allBad.problems.some((p) => /Rule x skipped/.test(p)));
  assert.ok(allBad.problems.some((p) => /built-in copy/.test(p)));
});

test('one bad rule in rules.json is skipped and shown, the rest still run', async () => {
  const doc = clone(rulesDoc);
  doc.rules[2].do[0].priority = 'P9';
  const r = await A.loadRules(okFetch(doc));
  assert.equal(r.source, 'rules.json');
  assert.equal(r.rules.length, 2);
  assert.equal(r.problems.length, 1);
  // the problem is written to the log on every event, as an error line
  const st = fakeStorage();
  A.runEvent(st, r, 'form.sent', person, NOW);
  assert.ok(A.readLog(st).some((l) => l.ruleId === 'engine' && l.status === 'error' && /Rule urgent-escalate skipped/.test(l.message)));
});

test('an empty rule list in rules.json is respected (nothing runs)', async () => {
  const r = await A.loadRules(okFetch({ version: 1, rules: [] }));
  assert.equal(r.source, 'rules.json');
  assert.equal(r.rules.length, 0);
  const st = fakeStorage();
  const run = A.runEvent(st, r, 'form.sent', person, NOW);
  assert.equal(run.ok, true);
  assert.equal(Store.load(st, NOW).length, 6, 'no ticket was created');
});

// ---------- the website form runs the rules ----------

test('Contact.submit runs the rules: lead, ticket and an urgent alert', () => {
  const st = fakeStorage();
  const r = Contact.submit(st, { name: 'Sam Sample', email: 'sam@example.com', message: 'This is urgent, our site is down.' }, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.ticket.priority, 'P1');
  assert.equal(r.lead.source, 'Website form');
  assert.equal(r.alerts.length, 1);
  assert.deepEqual(r.results.map((x) => x.ruleId), ['form-create-lead', 'form-create-ticket', 'urgent-escalate']);
  assert.equal(A.readOutbox(st).length, 1);
});

test('Contact.submit with a normal message gives a P3 ticket and a lead but no alert', () => {
  const st = fakeStorage();
  const r = Contact.submit(st, { name: 'Sam Sample', email: 'sam@example.com', message: 'Can you design a new logo for us?' }, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.ticket.priority, 'P3');
  assert.ok(r.lead);
  assert.deepEqual(r.alerts, []);
});

test('Contact.submit follows custom rules, and still works when a rule makes no ticket', () => {
  const doc = clone(rulesDoc);
  doc.rules = doc.rules.slice(0, 1);
  const st = fakeStorage();
  const r = Contact.submit(st, person, NOW, info(doc));
  assert.equal(r.ok, true);
  assert.equal(r.ticket, null);
  assert.ok(r.lead);
});

test('invalid form input runs no rules and writes no log', () => {
  const st = fakeStorage();
  const r = Contact.submit(st, { name: '', email: 'x', message: 'short urgent' }, NOW);
  assert.equal(r.ok, false);
  assert.deepEqual(A.readLog(st), []);
  assert.equal(st.getItem(Crm.STORAGE_KEY), null);
});

test('when a rule fails the visitor gets a clear message that points to the log', () => {
  const doc = clone(rulesDoc);
  doc.rules.splice(1, 1);
  const st = fakeStorage();
  const r = Contact.submit(st, Object.assign({}, person, { message: 'urgent: please call me' }), NOW, info(doc));
  assert.equal(r.ok, false);
  assert.match(r.message, /urgent-escalate/);
  assert.match(r.message, /automation log/);
});

// ---------- nothing is really sent ----------

test('the code contains no way to send anything anywhere', () => {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const f of ['automation.js', 'contact.js', 'crm.js', 'helpdesk-store.js']) {
    const code = strip(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    for (const banned of ['XMLHttpRequest', 'sendBeacon', 'WebSocket', 'EventSource', 'mailto:', 'navigator.share', 'postMessage', 'importScripts']) {
      assert.ok(!code.includes(banned), f + ' contains ' + banned);
    }
    const fetches = code.match(/\bfetch\w*\s*\(/g) || [];
    if (f === 'automation.js') {
      assert.deepEqual(fetches.filter((x) => !/^fetchFn/.test(x)), [], 'only the injected fetchFn may be called');
      assert.equal((code.match(/fetchFn\('rules\.json'/g) || []).length, 1, 'fetchFn is only ever called with rules.json');
    } else {
      assert.deepEqual(fetches, [], f + ' calls fetch');
    }
  }
  for (const f of ['index.html', 'automation.html']) {
    const page = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!/mailto:|<form[^>]+action=/.test(page), f + ' has a form action or mailto link');
  }
});

// ---------- automation.html matches automation.js ----------

test('every element id that automation.js uses exists in automation.html', () => {
  const html = fs.readFileSync(path.join(ROOT, 'automation.html'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'automation.js'), 'utf8');
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const used = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  assert.ok(used.size >= 8);
  for (const id of used) assert.ok(ids.has(id), 'missing id in automation.html: ' + id);
  assert.equal([...html.matchAll(/\bid="([^"]+)"/g)].length, ids.size, 'duplicate ids');
});

test('automation.html is a phone-friendly page that says nothing is sent, with no outside resources', () => {
  const html = fs.readFileSync(path.join(ROOT, 'automation.html'), 'utf8');
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.equal((html.match(/<h1[\s>]/g) || []).length, 1);
  assert.match(html, /Nothing is really sent/);
  assert.equal(/<(?:script|link|img)[^>]+(?:src|href)="(?:https?:)?\/\//.test(html), false);
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(scripts, ['helpdesk-store.js', 'crm.js', 'automation.js', 'glass.js'], 'glass.js (design effects) loads last');
  for (const s of scripts) assert.ok(fs.existsSync(path.join(ROOT, s)));
});
