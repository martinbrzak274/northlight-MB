/*
 * Staff accounts: a LEARNING MODEL. Everything runs in the browser and all data is fake.
 * Real systems check passwords and codes on a server. See the note on staff.html.
 *
 * Layout: core functions (testable in Node) -> createApp() state machine -> thin UI at the bottom.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'northlight-staff-v1';
  var ITERATIONS = 100000;
  var TOTP_STEP_SECONDS = 30;
  var GROUPS = ['Design', 'Sales', 'IT'];
  var ROLES = {
    Design: ['Designer', 'Art director'],
    Sales: ['Account executive', 'Sales manager'],
    IT: ['Sysadmin', 'Helpdesk technician']
  };
  var B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  var PW_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

  // Fake people with fake passwords and fake TOTP secrets. Shown on the page on purpose.
  var DEMO = [
    { name: 'Alex Example', username: 'alex', group: 'Design', role: 'Designer', password: 'design-demo-1', secret: 'JBSWY3DPEHPK3PXP' },
    { name: 'Sam Sample', username: 'sam', group: 'Design', role: 'Art director', password: 'design-demo-2', secret: 'GEZDGNBVGY3TQOJQ' },
    { name: 'Jordan Demo', username: 'jordan', group: 'Sales', role: 'Account executive', password: 'sales-demo-1', secret: 'MFRGGZDFMZTWQ2LK' },
    { name: 'Casey Test', username: 'casey', group: 'Sales', role: 'Sales manager', password: 'sales-demo-2', secret: 'NBSWY3DPO5XXE3DE' },
    { name: 'Riley Placeholder', username: 'riley', group: 'IT', role: 'Sysadmin', password: 'it-demo-1', secret: 'KRSXG5CTMVRXEZLU' },
    { name: 'Taylor Fake', username: 'taylor', group: 'IT', role: 'Helpdesk technician', password: 'it-demo-2', secret: 'ONSWG4TFOQYTEMZU' }
  ];
  var DEMO_CREDENTIALS = DEMO.map(function (d) {
    return { username: d.username, password: d.password, name: d.name, group: d.group, role: d.role };
  });

  var enc = new TextEncoder();

  function subtle() {
    var c = globalThis.crypto;
    if (!c || !c.subtle) throw new Error('Web Crypto is not available (open this page over https or localhost).');
    return c.subtle;
  }

  // ---------- encoding helpers ----------
  function toB64(buf) {
    var b = new Uint8Array(buf), s = '';
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s);
  }
  function fromB64(s) {
    var bin = atob(s), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function randomBytes(n) {
    var b = new Uint8Array(n);
    globalThis.crypto.getRandomValues(b);
    return b;
  }
  function base32Encode(bytes) {
    var bits = 0, value = 0, out = '';
    for (var i = 0; i < bytes.length; i++) {
      value = (value << 8) | bytes[i];
      bits += 8;
      while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
    }
    if (bits > 0) out += B32[(value << (5 - bits)) & 31];
    return out;
  }
  function base32Decode(str) {
    var clean = str.toUpperCase().replace(/[\s=]/g, '');
    var bits = 0, value = 0, out = [];
    for (var i = 0; i < clean.length; i++) {
      var idx = B32.indexOf(clean[i]);
      if (idx < 0) throw new Error('Invalid base32 secret');
      value = (value << 5) | idx;
      bits += 5;
      if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
    }
    return new Uint8Array(out);
  }
  // Compare without stopping at the first different character.
  function constantTimeEqual(a, b) {
    if (a.length !== b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  // ---------- password hashing: PBKDF2-SHA-256 with a per-user random salt ----------
  async function hashPassword(password, salt, iterations) {
    var key = await subtle().importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    var bits = await subtle().deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: salt, iterations: iterations }, key, 256);
    return toB64(bits);
  }

  // ---------- TOTP (RFC 6238, built on HOTP from RFC 4226) ----------
  async function hotp(secretBytes, counter, digits) {
    var key = await subtle().importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    var msg = new ArrayBuffer(8), view = new DataView(msg);
    view.setUint32(0, Math.floor(counter / 4294967296));
    view.setUint32(4, counter >>> 0);
    var h = new Uint8Array(await subtle().sign('HMAC', key, msg));
    var off = h[19] & 15;
    var bin = ((h[off] & 127) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
    return String(bin % Math.pow(10, digits)).padStart(digits, '0');
  }
  function totpStep(nowMs) { return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS); }
  function totpCode(secretB32, step, digits) {
    return hotp(base32Decode(secretB32), step, digits || 6);
  }
  // Accepts the current step and one either side (clock drift). A step may be used only once.
  async function verifyTotp(user, code, nowMs) {
    if (!/^\d{6}$/.test(code)) return { ok: false, reason: 'wrong' };
    var cur = totpStep(nowMs), match = null;
    for (var s = cur - 1; s <= cur + 1; s++) {
      if (constantTimeEqual(code, await totpCode(user.totpSecret, s))) match = s;
    }
    if (match === null) return { ok: false, reason: 'wrong' };
    if (match <= (user.lastTotpStep || 0)) return { ok: false, reason: 'replay' };
    return { ok: true, step: match };
  }

  // ---------- rules ----------
  function canOpenAdmin(user) {
    return !!user && user.status === 'active' && user.group === 'IT';
  }

  // ---------- users and storage ----------
  async function makeUser(fields, password) {
    var salt = randomBytes(16);
    return {
      id: toB64(randomBytes(9)).replace(/[^A-Za-z0-9]/g, 'x'),
      name: fields.name, username: fields.username, group: fields.group, role: fields.role,
      status: 'active', salt: toB64(salt), iterations: ITERATIONS,
      hash: await hashPassword(password, salt, ITERATIONS),
      totpSecret: fields.secret || base32Encode(randomBytes(10)), lastTotpStep: 0
    };
  }

  async function seedUsers() {
    var users = [];
    for (var i = 0; i < DEMO.length; i++) users.push(await makeUser(DEMO[i], DEMO[i].password));
    return users;
  }

  function validUsers(data) {
    if (!data || !Array.isArray(data.users) || !data.users.length) return false;
    return data.users.every(function (u) {
      return u && typeof u.id === 'string' && typeof u.name === 'string' && typeof u.username === 'string' &&
        GROUPS.indexOf(u.group) >= 0 && typeof u.role === 'string' &&
        (u.status === 'active' || u.status === 'leaver') &&
        typeof u.salt === 'string' && typeof u.hash === 'string' &&
        typeof u.totpSecret === 'string' && Number.isInteger(u.iterations) && u.iterations > 0;
    });
  }

  function save(storage, users) {
    try { storage.setItem(STORAGE_KEY, JSON.stringify({ users: users })); } catch (e) { /* ignore */ }
  }

  async function loadOrSeed(storage) {
    try {
      var raw = storage.getItem(STORAGE_KEY);
      if (raw) {
        var data = JSON.parse(raw);
        if (validUsers(data)) return data.users;
      }
    } catch (e) { /* fall through to seed */ }
    var users = await seedUsers();
    save(storage, users);
    return users;
  }

  function randomPassword() {
    var out = '';
    while (out.length < 12) {
      var b = randomBytes(16);
      for (var i = 0; i < b.length && out.length < 12; i++) {
        if (b[i] < 248) out += PW_ALPHABET[b[i] % 31]; // 248 = 31 * 8, avoids modulo bias
      }
    }
    return out;
  }

  // ---------- the app: all rules, no DOM ----------
  var GENERIC_FAIL = 'Sign-in failed. Check the username and password.';
  var DISABLED = 'This account is disabled because the person has left. Contact IT.';
  var DENIED = 'Access denied: only the IT group may do this.';

  function createApp(storage, nowFn) {
    var now = nowFn || Date.now;
    var app = { users: [], stage: 'out', pending: null, user: null, adminOpen: false };

    app.init = async function () { app.users = await loadOrSeed(storage); };

    app.reset = async function () {
      app.signOut();
      app.users = await seedUsers();
      save(storage, app.users);
    };

    app.signIn = async function (username, password) {
      if (app.stage !== 'out') return { ok: false, message: 'Already signing in.' };
      var name = String(username || '').trim().toLowerCase();
      var u = app.users.find(function (x) { return x.username === name; });
      // Hash even for unknown names so the response time does not reveal which names exist.
      var ok = false;
      if (u) ok = constantTimeEqual(await hashPassword(String(password || ''), fromB64(u.salt), u.iterations), u.hash);
      else await hashPassword(String(password || ''), new Uint8Array(16), ITERATIONS);
      if (!ok) return { ok: false, message: GENERIC_FAIL };
      if (u.status !== 'active') return { ok: false, message: DISABLED };
      app.stage = 'mfa';
      app.pending = u;
      return { ok: true };
    };

    app.verifyCode = async function (code) {
      if (app.stage !== 'mfa') return { ok: false, message: 'Enter your password first.' };
      var u = app.pending;
      if (u.status !== 'active') { app.cancelSignIn(); return { ok: false, message: DISABLED }; }
      var r = await verifyTotp(u, String(code || '').trim(), now());
      if (!r.ok) {
        return { ok: false, message: r.reason === 'replay'
          ? 'That code was already used. Wait for the next one.' : 'Wrong code. Try again.' };
      }
      u.lastTotpStep = r.step;
      save(storage, app.users);
      app.user = u;
      app.pending = null;
      app.stage = 'in';
      return { ok: true };
    };

    app.currentCode = async function () {
      if (!app.pending) return null;
      var t = now();
      return {
        code: await totpCode(app.pending.totpSecret, totpStep(t)),
        secondsLeft: TOTP_STEP_SECONDS - (Math.floor(t / 1000) % TOTP_STEP_SECONDS)
      };
    };

    app.cancelSignIn = function () { app.pending = null; app.stage = 'out'; };
    app.signOut = function () { app.pending = null; app.user = null; app.adminOpen = false; app.stage = 'out'; };

    app.canOpenAdmin = function () { return app.stage === 'in' && canOpenAdmin(app.user); };

    app.openAdmin = function () {
      if (!app.canOpenAdmin()) return { ok: false, message: DENIED };
      app.adminOpen = true;
      return { ok: true };
    };

    app.addJoiner = async function (input) {
      if (!app.canOpenAdmin()) return { ok: false, message: DENIED };
      var name = String((input && input.name) || '').trim().replace(/\s+/g, ' ');
      if (!/^[\p{L}][\p{L} '\-]{1,39}$/u.test(name)) return { ok: false, message: 'Enter a name of 2 to 40 letters.' };
      if (ROLES[input.group] === undefined || ROLES[input.group].indexOf(input.role) < 0) {
        return { ok: false, message: 'Choose a valid group and role.' };
      }
      var base = name.split(' ')[0].toLowerCase().replace(/[^a-z0-9]/g, '') || 'user';
      var username = base, n = 1;
      while (app.users.some(function (x) { return x.username === username; })) username = base + (++n);
      var password = randomPassword();
      var user = await makeUser({ name: name, username: username, group: input.group, role: input.role }, password);
      app.users.push(user);
      save(storage, app.users);
      return { ok: true, user: user, password: password };
    };

    app.markLeaver = function (id) {
      if (!app.canOpenAdmin()) return { ok: false, message: DENIED };
      var u = app.users.find(function (x) { return x.id === id; });
      if (!u) return { ok: false, message: 'No such user.' };
      if (u.status === 'leaver') return { ok: false, message: u.name + ' has already left.' };
      if (u.group === 'IT' && app.users.filter(function (x) { return x.group === 'IT' && x.status === 'active'; }).length < 2) {
        return { ok: false, message: 'The last active IT user cannot be marked as a leaver: nobody could manage accounts.' };
      }
      u.status = 'leaver';
      u.leftAt = new Date(now()).toISOString();
      save(storage, app.users);
      if (app.user && app.user.id === u.id) app.signOut();
      return { ok: true, message: u.name + ' is now a leaver and can no longer sign in.' };
    };

    return app;
  }

  var api = {
    GROUPS: GROUPS, ROLES: ROLES, DEMO_CREDENTIALS: DEMO_CREDENTIALS, STORAGE_KEY: STORAGE_KEY,
    base32Encode: base32Encode, base32Decode: base32Decode, hashPassword: hashPassword,
    hotp: hotp, totpCode: totpCode, totpStep: totpStep, verifyTotp: verifyTotp,
    canOpenAdmin: canOpenAdmin, loadOrSeed: loadOrSeed, createApp: createApp, toB64: toB64, fromB64: fromB64
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  // ---------- UI (browser only) ----------
  function initUI() {
    var $ = function (id) { return document.getElementById(id); };
    var memory = {};
    var storage;
    try {
      storage = globalThis.localStorage;
      storage.getItem(STORAGE_KEY);
    } catch (e) {
      storage = { getItem: function (k) { return memory[k] || null; }, setItem: function (k, v) { memory[k] = v; } };
    }
    var app = createApp(storage, Date.now);
    var statusEl = $('status');
    var timer = null;

    function say(message, bad) {
      statusEl.textContent = message || '';
      statusEl.className = bad ? 'bad' : 'good';
    }

    function el(tag, text, cls) {
      var n = document.createElement(tag);
      if (text !== undefined) n.textContent = text;
      if (cls) n.className = cls;
      return n;
    }

    function renderDirectory() {
      var body = $('directory');
      body.textContent = '';
      var users = app.users.slice().sort(function (a, b) {
        return GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group) || a.name.localeCompare(b.name);
      });
      users.forEach(function (u) {
        var tr = el('tr');
        [u.name, u.username, u.group, u.role].forEach(function (t) { tr.appendChild(el('td', t)); });
        tr.appendChild(el('td', u.status === 'active' ? 'Active' : 'Leaver', u.status === 'active' ? '' : 'left'));
        var act = el('td');
        if (u.status === 'active') {
          var b = el('button', 'Leaver');
          b.type = 'button';
          b.setAttribute('aria-label', 'Mark ' + u.name + ' as leaver');
          b.addEventListener('click', function () {
            var r = app.markLeaver(u.id);
            say(r.message, !r.ok);
            render();
          });
          act.appendChild(b);
        }
        tr.appendChild(act);
        body.appendChild(tr);
      });
    }

    function renderAuthenticator() {
      if (app.stage !== 'mfa') return;
      var who = app.pending;
      app.currentCode().then(function (c) {
        if (!c || app.pending !== who) return; // sign-in moved on while the code was computed
        $('auth-name').textContent = who.name;
        $('auth-code').textContent = c.code;
        $('auth-timer').textContent = c.secondsLeft + ' s';
      });
    }

    function render() {
      var s = app.stage;
      $('login-form').hidden = s !== 'out';
      $('code-form').hidden = s !== 'mfa';
      $('session').hidden = s !== 'in';
      $('admin').hidden = !(s === 'in' && app.adminOpen);
      if (s === 'in') {
        $('who').textContent = 'Signed in as ' + app.user.name + ' (' + app.user.group + ', ' + app.user.role + ').';
      }
      if (app.adminOpen) renderDirectory();
      renderAuthenticator();
      if (s === 'mfa' && !timer) timer = setInterval(renderAuthenticator, 1000);
      if (s !== 'mfa' && timer) { clearInterval(timer); timer = null; }
    }

    function fillRoles() {
      var sel = $('j-role');
      sel.textContent = '';
      ROLES[$('j-group').value].forEach(function (r) {
        var o = el('option', r);
        o.value = r;
        sel.appendChild(o);
      });
    }

    function fillDemoTable() {
      var body = $('demo-accounts');
      body.textContent = '';
      DEMO_CREDENTIALS.forEach(function (d) {
        var tr = el('tr');
        [d.name, d.group, d.role, d.username, d.password].forEach(function (t) { tr.appendChild(el('td', t)); });
        body.appendChild(tr);
      });
    }

    $('login-form').addEventListener('submit', async function (e) {
      e.preventDefault();
      try {
        var r = await app.signIn($('username').value, $('password').value);
        $('password').value = '';
        if (r.ok) { $('code').value = ''; say('Password accepted. Now enter the 6-digit code (step 2 of 2).'); }
        else say(r.message, true);
      } catch (err) { say(err.message, true); }
      render();
    });

    $('code-form').addEventListener('submit', async function (e) {
      e.preventDefault();
      var r = await app.verifyCode($('code').value);
      $('code').value = '';
      say(r.ok ? 'Signed in.' : r.message, !r.ok);
      render();
    });

    $('cancel').addEventListener('click', function () { app.cancelSignIn(); say('Sign-in cancelled.'); render(); });
    $('sign-out').addEventListener('click', function () { app.signOut(); say('Signed out.'); render(); });

    $('open-admin').addEventListener('click', function () {
      var r = app.openAdmin();
      say(r.ok ? 'Admin section opened.' : r.message, !r.ok);
      render();
    });

    $('j-group').addEventListener('change', fillRoles);
    $('joiner-form').addEventListener('submit', async function (e) {
      e.preventDefault();
      var r = await app.addJoiner({ name: $('j-name').value, group: $('j-group').value, role: $('j-role').value });
      if (r.ok) {
        $('j-name').value = '';
        say('Joiner added: ' + r.user.name + '. Username ' + r.user.username + ', temporary password ' + r.password +
          ' (shown once; fake demo). Their authenticator code appears when they sign in.');
      } else say(r.message, true);
      render();
    });

    $('reset').addEventListener('click', async function () {
      await app.reset();
      say('Demo data reset.');
      render();
    });

    fillDemoTable();
    fillRoles();
    app.init().then(function () { render(); }, function (err) { say(err.message, true); });
  }

  if (typeof document !== 'undefined' && document.getElementById('login-form')) initUI();
})();
