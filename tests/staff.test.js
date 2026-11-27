'use strict';
// Run with: node tests/staff.test.js
// Tests the logic in staff.js. All data is fake.
const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
const S = require('../staff.js');

const T0 = Date.parse('2026-11-27T12:00:10Z'); // 10 s into a 30 s step
let clock = T0;

function fakeStorage() {
  const data = {};
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); }
  };
}

async function newApp(storage) {
  const app = S.createApp(storage || fakeStorage(), () => clock);
  await app.init();
  return app;
}

const PASSWORDS = Object.fromEntries(S.DEMO_CREDENTIALS.map((d) => [d.username, d.password]));

// Password step, then the code the simulated authenticator shows.
async function fullSignIn(app, username) {
  const r1 = await app.signIn(username, PASSWORDS[username]);
  assert.equal(r1.ok, true, 'password step for ' + username);
  const { code } = await app.currentCode();
  return app.verifyCode(code);
}

// ---------- crypto building blocks ----------

test('base32 round trip', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255, 7]);
  assert.deepEqual(S.base32Decode(S.base32Encode(bytes)), bytes);
  assert.equal(S.base32Encode(new TextEncoder().encode('12345678901234567890')),
    'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
});

test('TOTP matches the RFC 6238 SHA-1 test vectors', async () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // "12345678901234567890"
  const vectors = [
    [59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'],
    [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']
  ];
  for (const [t, expected] of vectors) {
    assert.equal(await S.totpCode(secret, S.totpStep(t * 1000), 8), expected, 'T=' + t);
    assert.equal(await S.totpCode(secret, S.totpStep(t * 1000), 6), expected.slice(-6), 'T=' + t + ' (6 digits)');
  }
});

test('password hash equals an independent PBKDF2-SHA-256 implementation', async () => {
  const salt = Uint8Array.from({ length: 16 }, (_, i) => i * 7);
  const mine = await S.hashPassword('correct horse', salt, 5000);
  const ref = nodeCrypto.pbkdf2Sync('correct horse', Buffer.from(salt), 5000, 32, 'sha256').toString('base64');
  assert.equal(mine, ref);
  assert.notEqual(await S.hashPassword('correct horsf', salt, 5000), mine);
  assert.notEqual(await S.hashPassword('correct horse', salt.map((b) => b ^ 1), 5000), mine);
});

// ---------- seed data and storage ----------

test('six fake users, two in each of Design, Sales and IT, no plaintext passwords stored', async () => {
  const st = fakeStorage();
  const app = await newApp(st);
  assert.equal(app.users.length, 6);
  for (const g of S.GROUPS) assert.equal(app.users.filter((u) => u.group === g).length, 2, g);
  const raw = st.data[S.STORAGE_KEY];
  for (const pw of Object.values(PASSWORDS)) assert.ok(!raw.includes(pw), 'plaintext password found in storage');
  assert.equal(new Set(app.users.map((u) => u.salt)).size, 6, 'salts are unique');
});

test('corrupt storage is replaced by fresh demo data', async () => {
  const st = fakeStorage();
  st.setItem(S.STORAGE_KEY, '{not json');
  assert.equal((await newApp(st)).users.length, 6);
  st.setItem(S.STORAGE_KEY, JSON.stringify({ users: [{ id: 1 }] }));
  assert.equal((await newApp(st)).users.length, 6);
});

// ---------- sign-in: password then TOTP ----------

test('every demo user can sign in with password plus code', async () => {
  for (const d of S.DEMO_CREDENTIALS) {
    const app = await newApp();
    assert.equal((await fullSignIn(app, d.username)).ok, true, d.username);
    assert.equal(app.stage, 'in');
    clock += 30000; // keep each user's code fresh for the next iteration
  }
});

test('wrong password and unknown user get the same generic message', async () => {
  const app = await newApp();
  const a = await app.signIn('alex', 'nope');
  const b = await app.signIn('nobody', 'nope');
  assert.equal(a.ok, false);
  assert.equal(a.message, b.message);
  assert.equal(app.stage, 'out');
});

test('a correct password alone is not enough', async () => {
  const app = await newApp();
  await app.signIn('alex', PASSWORDS.alex);
  assert.equal(app.stage, 'mfa');
  assert.equal(app.user, null);
  assert.equal(app.openAdmin().ok, false);
});

test('a wrong code is rejected and codes cannot skip the password step', async () => {
  const app = await newApp();
  assert.equal((await app.verifyCode('123456')).ok, false); // no password yet
  await app.signIn('alex', PASSWORDS.alex);
  const { code } = await app.currentCode();
  const wrong = String((Number(code) + 1) % 1000000).padStart(6, '0');
  assert.equal((await app.verifyCode(wrong)).ok, false);
  assert.equal((await app.verifyCode('abcdef')).ok, false);
  assert.equal(app.stage, 'mfa');
  assert.equal((await app.verifyCode(code)).ok, true);
});

test('codes one step old or ahead are accepted, two steps old are not', async () => {
  const app = await newApp();
  const secret = app.users.find((u) => u.username === 'alex').totpSecret;
  const step = S.totpStep(clock);
  await app.signIn('alex', PASSWORDS.alex);
  assert.equal((await app.verifyCode(await S.totpCode(secret, step - 2))).ok, false);
  assert.equal((await app.verifyCode(await S.totpCode(secret, step - 1))).ok, true);
  // Newer steps are fine (the previous code is now used up).
  const app2 = await newApp();
  await app2.signIn('alex', PASSWORDS.alex);
  assert.equal((await app2.verifyCode(await S.totpCode(secret, step + 1))).ok, true);
});

test('a used code cannot be used again', async () => {
  const st = fakeStorage();
  let app = await newApp(st);
  assert.equal((await fullSignIn(app, 'alex')).ok, true);
  app.signOut();
  await app.signIn('alex', PASSWORDS.alex);
  const { code } = await app.currentCode();
  const r = await app.verifyCode(code);
  assert.equal(r.ok, false);
  assert.match(r.message, /already used/);
  // Still blocked after a reload, because the last used step is saved.
  app = await newApp(st);
  await app.signIn('alex', PASSWORDS.alex);
  assert.equal((await app.verifyCode((await app.currentCode()).code)).ok, false);
  clock += 30000;
  assert.equal((await app.verifyCode((await app.currentCode()).code)).ok, true);
});

// ---------- admin access: only IT ----------

test('only the IT group may open the admin section', async () => {
  for (const d of S.DEMO_CREDENTIALS) {
    clock += 30000;
    const app = await newApp();
    await fullSignIn(app, d.username);
    const r = app.openAdmin();
    assert.equal(r.ok, d.group === 'IT', d.username);
    assert.equal(app.adminOpen, d.group === 'IT', d.username);
    if (d.group !== 'IT') {
      assert.match(r.message, /Access denied/);
      assert.equal((await app.addJoiner({ name: 'Eve Fake', group: 'IT', role: 'Sysadmin' })).ok, false);
      assert.equal(app.markLeaver(app.users[0].id).ok, false);
      assert.equal(app.users.length, 6);
    }
  }
});

test('admin actions are refused when nobody is signed in', async () => {
  const app = await newApp();
  assert.equal(app.openAdmin().ok, false);
  assert.equal((await app.addJoiner({ name: 'Eve Fake', group: 'IT', role: 'Sysadmin' })).ok, false);
  assert.equal(app.markLeaver(app.users[0].id).ok, false);
});

// ---------- joiner and leaver ----------

async function signInAs(username) {
  clock += 30000;
  const st = fakeStorage();
  const app = await newApp(st);
  await fullSignIn(app, username);
  app.openAdmin();
  return { app, st };
}

test('a joiner can sign in with the temporary password and their own code', async () => {
  const { app, st } = await signInAs('riley');
  const r = await app.addJoiner({ name: 'Morgan Newhire', group: 'Sales', role: 'Account executive' });
  assert.equal(r.ok, true);
  assert.equal(r.user.username, 'morgan');
  assert.equal(r.password.length, 12);
  assert.ok(!st.data[S.STORAGE_KEY].includes(r.password), 'temporary password must not be stored');
  app.signOut();

  assert.equal((await app.signIn('morgan', 'wrong')).ok, false);
  assert.equal((await app.signIn('morgan', r.password)).ok, true);
  assert.equal((await app.verifyCode((await app.currentCode()).code)).ok, true);
  assert.equal(app.openAdmin().ok, false); // Sales, so no admin
});

test('joiner input is validated and usernames stay unique', async () => {
  const { app } = await signInAs('riley');
  assert.equal((await app.addJoiner({ name: '', group: 'IT', role: 'Sysadmin' })).ok, false);
  assert.equal((await app.addJoiner({ name: '<img src=x>', group: 'IT', role: 'Sysadmin' })).ok, false);
  assert.equal((await app.addJoiner({ name: 'Ok Name', group: 'Nope', role: 'Sysadmin' })).ok, false);
  assert.equal((await app.addJoiner({ name: 'Ok Name', group: 'IT', role: 'Designer' })).ok, false);
  const a = await app.addJoiner({ name: 'Alex Second', group: 'Design', role: 'Designer' });
  assert.equal(a.user.username, 'alex2');
  assert.equal(app.users.length, 7);
});

test('a leaver cannot sign in, even with the right password', async () => {
  const { app, st } = await signInAs('riley');
  const casey = app.users.find((u) => u.username === 'casey');
  assert.equal(app.markLeaver(casey.id).ok, true);
  assert.equal(app.markLeaver(casey.id).ok, false); // already left
  app.signOut();

  // Fresh app on the same storage proves it was saved.
  const app2 = await newApp(st);
  const r = await app2.signIn('casey', PASSWORDS.casey);
  assert.equal(r.ok, false);
  assert.match(r.message, /disabled/);
  assert.equal(app2.stage, 'out');
  // Without the right password a stranger learns nothing about the account status.
  assert.equal((await app2.signIn('casey', 'wrong')).message, (await app2.signIn('nobody', 'wrong')).message);
});

test('a leaver who is already mid sign-in is stopped at the code step', async () => {
  const app = await newApp();
  await app.signIn('casey', PASSWORDS.casey);
  app.pending.status = 'leaver'; // IT disabled the account in the meantime
  const r = await app.verifyCode((await app.currentCode()).code);
  assert.equal(r.ok, false);
  assert.equal(app.stage, 'out');
});

test('marking yourself as a leaver signs you out', async () => {
  const { app } = await signInAs('taylor');
  const me = app.users.find((u) => u.username === 'taylor');
  assert.equal(app.markLeaver(me.id).ok, true);
  assert.equal(app.stage, 'out');
  assert.equal(app.adminOpen, false);
});

test('the last active IT user cannot be marked as a leaver', async () => {
  const { app } = await signInAs('riley');
  const taylor = app.users.find((u) => u.username === 'taylor');
  const riley = app.users.find((u) => u.username === 'riley');
  assert.equal(app.markLeaver(taylor.id).ok, true);
  const r = app.markLeaver(riley.id);
  assert.equal(r.ok, false);
  assert.match(r.message, /last active IT/);
  assert.equal(riley.status, 'active');
});

test('an IT leaver cannot open admin even if a session object lingers', async () => {
  const { app } = await signInAs('riley');
  const riley = app.users.find((u) => u.username === 'riley');
  riley.status = 'leaver';
  assert.equal(app.openAdmin().ok, false);
  assert.equal(S.canOpenAdmin(riley), false);
});

test('reset restores the demo data', async () => {
  const { app } = await signInAs('riley');
  await app.addJoiner({ name: 'Extra Person', group: 'Design', role: 'Designer' });
  await app.reset();
  assert.equal(app.users.length, 6);
  assert.equal(app.stage, 'out');
});
