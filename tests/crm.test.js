'use strict';
// Run with: node tests/crm.test.js
// Tests the rules in crm.js and checks crm.html against the script. All data is fake.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const C = require('../crm.js');
const Store = require('../helpdesk-store.js');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'crm.html'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'crm.js'), 'utf8');

const T0 = Date.parse('2026-11-27T12:00:00Z');
const HOUR = 3600 * 1000;
let clock = T0;

function fakeStorage() {
  const data = {};
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); }
  };
}
function newCrm(storage) {
  clock = T0;
  const crm = C.createCrm(storage || fakeStorage(), () => clock);
  crm.init();
  return crm;
}

// ---------- seed and storage ----------

test('seed data: three fake leads, one case, nothing else', () => {
  const s = C.seed(T0);
  assert.equal(s.leads.length, 3);
  assert.equal(s.cases.length, 1);
  assert.equal(s.accounts.length + s.contacts.length + s.opportunities.length, 0);
  assert.equal(C.valid(s), true);
  assert.ok(s.leads.every((l) => l.status === 'Open' && /@example\.(com|org|net)$/.test(l.email)), 'fake reserved email domains only');
});

test('first load seeds and saves; later loads read what was saved', () => {
  const st = fakeStorage();
  const crm = newCrm(st);
  assert.equal(crm.state.leads.length, 3);
  assert.ok(st.data[C.STORAGE_KEY]);
  crm.addLead({ name: 'Eli Extra', company: 'Extra Co', email: 'eli@example.com', source: 'Other', value: '100' });
  assert.equal(newCrm(st).state.leads.length, 4);
});

test('unusable stored data is replaced, and the bad copy is kept as a backup', () => {
  for (const bad of ['{not json', JSON.stringify({ leads: 'x' })]) {
    const st = fakeStorage();
    st.setItem(C.STORAGE_KEY, bad);
    const crm = newCrm(st);
    assert.equal(crm.state.leads.length, 3);
    assert.equal(st.data[C.BACKUP_KEY], bad);
  }
});

test('stored data with a broken link between records is rejected', () => {
  const crm = newCrm();
  const r = crm.convertLead(1);
  assert.equal(r.ok, true);
  const good = JSON.parse(JSON.stringify(crm.state));
  assert.equal(C.valid(good), true);

  const noAccount = JSON.parse(JSON.stringify(good));
  noAccount.opportunities[0].accountId = 999;
  assert.equal(C.valid(noAccount), false);

  const noContact = JSON.parse(JSON.stringify(good));
  noContact.contacts = [];
  assert.equal(C.valid(noContact), false);

  const badStage = JSON.parse(JSON.stringify(good));
  badStage.opportunities[0].stage = 'Maybe';
  assert.equal(C.valid(badStage), false);

  const dupIds = JSON.parse(JSON.stringify(good));
  dupIds.leads[1].id = dupIds.leads[0].id;
  assert.equal(C.valid(dupIds), false);

  const badCase = JSON.parse(JSON.stringify(good));
  badCase.cases[0].priority = 'P9';
  assert.equal(C.valid(badCase), false);
});

// ---------- convert ----------

test('Convert makes an account, a contact and an opportunity from the lead', () => {
  const crm = newCrm();
  clock = T0 + HOUR;
  const r = crm.convertLead(2); // Dana Demo, Harbor and Pine Outfitters, 24000
  assert.equal(r.ok, true);

  assert.equal(crm.state.accounts.length, 1);
  assert.equal(crm.state.contacts.length, 1);
  assert.equal(crm.state.opportunities.length, 1);

  const { account, contact, opportunity, lead } = r;
  assert.equal(account.name, 'Harbor and Pine Outfitters');
  assert.equal(contact.name, 'Dana Demo');
  assert.equal(contact.email, 'dana@example.org');
  assert.equal(contact.accountId, account.id);
  assert.equal(opportunity.accountId, account.id);
  assert.equal(opportunity.contactId, contact.id);
  assert.equal(opportunity.value, 24000);
  assert.equal(opportunity.stage, C.NEW_OPP_STAGE);
  assert.equal(C.NEW_OPP_STAGE, 'Lead');
  assert.equal(opportunity.createdAt, T0 + HOUR);

  assert.equal(lead.status, 'Converted');
  assert.deepEqual([lead.accountId, lead.contactId, lead.opportunityId], [account.id, contact.id, opportunity.id]);
  assert.equal(C.valid(crm.state), true);
});

test('a lead can be converted only once, and unknown leads are refused', () => {
  const crm = newCrm();
  assert.equal(crm.convertLead(1).ok, true);
  const again = crm.convertLead(1);
  assert.equal(again.ok, false);
  assert.match(again.message, /already been converted/);
  assert.equal(crm.state.accounts.length, 1, 'no duplicate account');
  assert.equal(crm.state.contacts.length, 1);
  assert.equal(crm.state.opportunities.length, 1);
  assert.equal(crm.convertLead(99).ok, false);
});

test('converting several leads gives each its own records and ids', () => {
  const crm = newCrm();
  [1, 2, 3].forEach((id) => assert.equal(crm.convertLead(id).ok, true));
  assert.deepEqual(crm.state.accounts.map((a) => a.id), [1, 2, 3]);
  assert.equal(new Set(crm.state.opportunities.map((o) => o.contactId)).size, 3);
  assert.ok(crm.state.leads.every((l) => l.status === 'Converted'));
});

test('conversion is saved, and survives a reload', () => {
  const st = fakeStorage();
  const crm = newCrm(st);
  crm.convertLead(3);
  const again = newCrm(st);
  assert.equal(again.state.opportunities.length, 1);
  assert.equal(again.state.leads.find((l) => l.id === 3).status, 'Converted');
});

test('conversion is all or nothing: if saving fails, nothing changes', () => {
  const st = fakeStorage();
  const crm = newCrm(st);
  st.setItem = () => { throw new Error('quota'); };
  const r = crm.convertLead(1);
  assert.equal(r.ok, false);
  assert.equal(r.message, C.STORAGE_FAILED);
  assert.equal(crm.state.leads.find((l) => l.id === 1).status, 'Open');
  assert.equal(crm.state.accounts.length + crm.state.contacts.length + crm.state.opportunities.length, 0);
});

// ---------- stages ----------

test('opportunity stages can be changed and the change time is recorded', () => {
  const crm = newCrm();
  const opp = crm.convertLead(1).opportunity;
  assert.deepEqual(C.STAGES, ['Lead', 'Qualified', 'Quote', 'Won', 'Lost']);
  clock = T0 + 5 * HOUR;
  for (const stage of C.STAGES) {
    const r = crm.setStage(opp.id, stage);
    assert.equal(r.ok, true, stage);
    assert.equal(crm.state.opportunities[0].stage, stage);
  }
  assert.equal(crm.state.opportunities[0].stageChangedAt, T0 + 5 * HOUR);
  assert.equal(crm.setStage(opp.id, 'Maybe').ok, false);
  assert.equal(crm.setStage(99, 'Won').ok, false);
  assert.equal(crm.state.opportunities[0].stage, 'Lost');
});

// ---------- leads ----------

test('adding a lead validates every field with a clear message', () => {
  const crm = newCrm();
  const empty = crm.addLead({ name: '', company: '', email: '', source: '', value: '' });
  assert.equal(empty.ok, false);
  assert.deepEqual(empty.errors, {
    name: 'Enter the contact name.',
    company: 'Enter the company name.',
    email: 'Enter an email address.',
    source: 'Choose where the lead came from.',
    value: 'Enter the estimated value in euros.'
  });
  assert.equal(crm.state.leads.length, 3, 'nothing was added');

  const bad = C.validateLead({ name: 'A', company: 'B', email: 'nope', source: 'Referral', value: '12.5' });
  assert.match(bad.errors.name, /2 to 60 characters \(you entered 1\)/);
  assert.match(bad.errors.email, /name@example\.com/);
  assert.match(bad.errors.value, /whole euros/);
  assert.match(C.validateLead({ name: 'Ab', company: 'Cd', email: 'a@b.cc', source: 'Referral', value: '1000001' }).errors.value, /1,000,000/);
  assert.equal(C.validateLead({ name: 'Ab', company: 'Cd', email: 'a@b.cc', source: 'Referral', value: '0' }).valid, true);
});

test('a valid lead is added as Open with the entered values', () => {
  const crm = newCrm();
  const r = crm.addLead({ name: ' Eli  Extra ', company: 'Extra Co', email: 'eli@example.com', source: 'Referral', value: '2500' });
  assert.equal(r.ok, true);
  assert.equal(r.lead.id, 4);
  assert.equal(r.lead.name, 'Eli Extra');
  assert.equal(r.lead.value, 2500);
  assert.equal(r.lead.status, 'Open');
});

// ---------- support cases ----------

test('default due time follows the help desk response targets', () => {
  for (const p of C.PRIORITIES) {
    const due = C.parseLocalInput(C.defaultDue(p, T0));
    const expected = T0 + Store.TARGET_HOURS[p] * HOUR;
    assert.ok(due >= expected && due - expected < 60000, p + ' is within a minute of the target');
  }
});

test('local date and time parsing round trips and rejects impossible dates', () => {
  const ms = C.parseLocalInput('2026-12-01T09:30');
  assert.equal(C.toLocalInput(ms), '2026-12-01T09:30');
  for (const bad of ['', 'tomorrow', '2026-02-31T10:00', '2026-13-01T10:00', '2026-12-01T25:00', '2026-12-01']) {
    assert.equal(C.parseLocalInput(bad), null, bad);
  }
});

test('a case needs a subject, a priority and a valid due time', () => {
  const crm = newCrm();
  const empty = crm.addCase({ subject: '', account: '', priority: '', due: '' });
  assert.deepEqual(empty.errors, {
    subject: 'Describe the problem in a few words.',
    priority: 'Choose a priority.',
    due: 'Enter a due date and time.'
  });
  assert.match(crm.addCase({ subject: 'Hi', account: '', priority: 'P1', due: '2026-12-01T09:30' }).errors.subject, /5 to 100/);
  assert.equal(crm.addCase({ subject: 'Printer is broken', account: '', priority: 'P1', due: '2026-02-31T10:00' }).errors.due, 'Enter a valid due date and time.');
  assert.match(crm.addCase({ subject: 'Printer is broken', account: '77', priority: 'P1', due: '2026-12-01T09:30' }).errors.account, /Choose an account/);
  assert.equal(crm.state.cases.length, 1, 'nothing was added');
});

test('a case is saved with its priority, due time and optional account', () => {
  const crm = newCrm();
  const acc = crm.convertLead(1).account;
  const r = crm.addCase({ subject: '  Website is down  ', account: String(acc.id), priority: 'P1', due: '2026-12-01T09:30' });
  assert.equal(r.ok, true);
  assert.equal(r.case.id, 2);
  assert.equal(r.case.subject, 'Website is down');
  assert.equal(r.case.priority, 'P1');
  assert.equal(r.case.accountId, acc.id);
  assert.equal(r.case.dueAt, C.parseLocalInput('2026-12-01T09:30'));
  assert.equal(r.case.status, 'Open');
  const noAcc = crm.addCase({ subject: 'No account case', account: '', priority: 'P3', due: '2026-12-01T09:30' });
  assert.equal(noAcc.case.accountId, null);
  assert.equal(C.valid(crm.state), true);
});

test('Overdue: only open cases past their due time', () => {
  const crm = newCrm();
  const c = crm.state.cases[0]; // due T0 + 3h
  assert.equal(crm.isOverdue(c), false);
  clock = T0 + 3 * HOUR;
  assert.equal(crm.isOverdue(c), false, 'exactly at the due time is not yet overdue');
  clock = T0 + 3 * HOUR + 1;
  assert.equal(crm.isOverdue(c), true);
  assert.equal(crm.closeCase(c.id).ok, true);
  assert.equal(crm.isOverdue(crm.state.cases[0]), false, 'closed cases are never overdue');
  assert.equal(crm.closeCase(c.id).ok, false);
  assert.equal(crm.closeCase(99).ok, false);
});

// ---------- chart ----------

test('stage summary counts opportunities and sums their value per stage', () => {
  const crm = newCrm();
  [1, 2, 3].forEach((id) => crm.convertLead(id));
  crm.setStage(1, 'Quote');
  crm.setStage(2, 'Quote');
  crm.setStage(3, 'Won');
  const s = crm.summary();
  assert.deepEqual(s.stages.map((x) => x.stage), C.STAGES);
  assert.deepEqual(s.stages.map((x) => x.count), [0, 0, 2, 1, 0]);
  assert.equal(s.stages[2].value, 8000 + 24000);
  assert.equal(s.stages[3].value, 15000);
  assert.equal(s.total, 3);
  assert.equal(s.totalValue, 47000);
});

test('with no opportunities the chart still has all five stages at zero', () => {
  const s = C.stageSummary([]);
  const g = C.chartGeometry(s.stages);
  assert.equal(g.rows.length, 5);
  assert.ok(g.rows.every((r) => r.barW === 0 && C.barPath(r) === ''));
  assert.equal(g.niceMax, 4);
  assert.deepEqual(g.ticks.map((t) => t.value), [0, 1, 2, 3, 4]);
});

test('bar lengths are proportional and bars stay thin', () => {
  const stages = ['Lead', 'Qualified', 'Quote', 'Won', 'Lost'].map((stage, i) => ({ stage, count: [1, 2, 4, 0, 3][i], value: 0 }));
  const g = C.chartGeometry(stages);
  assert.equal(g.niceMax, 4);
  const w = g.rows.map((r) => r.barW);
  assert.equal(w[1], w[0] * 2);
  assert.equal(w[2], g.plotW, 'the longest bar reaches the end of the plot');
  assert.equal(w[3], 0);
  assert.ok(g.rows.every((r) => r.barH <= 24), 'bars are at most 24 units thick');
  assert.ok(C.chartGeometry(stages, { barThickness: 60 }).rows.every((r) => r.barH <= 24), 'the cap holds even if asked for more');
  assert.ok(g.rows.every((r) => r.height >= 24), 'hover area is at least 24 units tall');
  // everything sits inside the drawing
  assert.ok(g.rows.every((r) => r.labelX < g.width && r.top + r.height <= g.plotBottom));
});

test('axis ticks are whole numbers that cover the largest count', () => {
  const mk = (n) => C.chartGeometry([{ stage: 'Lead', count: n, value: 0 }]);
  for (const n of [0, 1, 4, 5, 9, 13, 40, 101]) {
    const g = mk(n);
    assert.ok(g.ticks.every((t) => Number.isInteger(t.value)), 'integer ticks for ' + n);
    assert.ok(g.niceMax >= n, 'covers ' + n);
    assert.ok(g.ticks.length <= 6, 'at most 6 ticks for ' + n);
    assert.equal(g.ticks[0].value, 0);
    assert.equal(g.ticks[g.ticks.length - 1].value, g.niceMax);
  }
  assert.equal(mk(13).step, 4);
  assert.equal(mk(13).niceMax, 16);
});

test('bar path has a rounded end and a square base', () => {
  const g = C.chartGeometry([{ stage: 'Lead', count: 2, value: 0 }]);
  const d = C.barPath(g.rows[0]);
  assert.match(d, /^M/);
  assert.equal((d.match(/Q/g) || []).length, 2, 'two rounded corners at the data end');
  assert.ok(d.endsWith('Z'));
  const tiny = C.barPath({ barX: 78, barY: 10, barW: 2, barH: 20 });
  assert.ok(!tiny.includes('NaN'));
});

test('chart text: row labels and the accessible description', () => {
  assert.equal(C.rowLabel({ stage: 'Quote', count: 1, value: 8000 }), 'Quote: 1 opportunity, €8,000');
  assert.equal(C.rowLabel({ stage: 'Won', count: 0, value: 0 }), 'Won: 0 opportunities, €0');
  const alt = C.chartAlt(C.stageSummary([{ stage: 'Quote', value: 1 }]));
  assert.equal(alt, 'Opportunities by stage. Lead 0, Qualified 0, Quote 1, Won 0, Lost 0.');
});

// ---------- crm.html matches crm.js ----------

test('every element id that crm.js uses exists in crm.html', () => {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const used = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  for (const f of ['name', 'company', 'email', 'source', 'value']) { used.add('l-' + f); used.add('l-' + f + '-error'); }
  for (const f of ['subject', 'account', 'priority', 'due']) { used.add('k-' + f); used.add('k-' + f + '-error'); }
  for (const id of used) assert.ok(ids.has(id), 'missing id in crm.html: ' + id);
  assert.equal([...html.matchAll(/\bid="([^"]+)"/g)].length, ids.size, 'duplicate ids in crm.html');
});

test('form options in crm.html match the rules in crm.js', () => {
  const opts = (id) => {
    const block = new RegExp('<select id="' + id + '"[^>]*>([\\s\\S]*?)</select>').exec(html)[1];
    return [...block.matchAll(/<option(?:\s+value="([^"]*)")?[^>]*>([^<]*)<\/option>/g)].map((m) => (m[1] !== undefined ? m[1] : m[2]));
  };
  assert.deepEqual(opts('l-source'), C.SOURCES);
  assert.deepEqual(opts('k-priority'), C.PRIORITIES);
});

test('crm.html is a phone-friendly page with no outside resources', () => {
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.equal((html.match(/<h1[\s>]/g) || []).length, 1);
  assert.equal(/<(?:script|link|img)[^>]+(?:src|href)="(?:https?:)?\/\//.test(html), false);
  assert.equal(/url\(\s*["']?(?:https?:)?\/\//.test(html), false);
  assert.match(html, /<form id="lead-form" novalidate>/);
  assert.match(html, /<form id="case-form" novalidate>/);
  for (const f of ['helpdesk-store.js', 'crm.js']) assert.ok(html.includes('src="' + f + '"') && fs.existsSync(path.join(ROOT, f)));
});

test('the chart uses one series colour and no status colours, and has a dark mode', () => {
  assert.match(html, /\.chart \.bar \{ fill: var\(--series-1\); \}/);
  assert.match(html, /--series-1: #257de0/);
  assert.match(html, /--series-1: #338ced/);
  assert.equal((html.match(/prefers-color-scheme: dark/g) || []).length, 1);
  assert.match(html, /:root\[data-theme="dark"\]/);
});
