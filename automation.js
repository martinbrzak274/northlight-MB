/*
 * Automation: runs the rules in rules.json when an event happens (today: the website form is sent).
 * Fake data only. NOTHING IS REALLY SENT: the "outbox" is a list saved in localStorage, and the only
 * thing this file ever fetches is rules.json itself.
 *
 * Layout: rule validation -> actions -> engine -> loading rules -> UI for automation.html (browser only).
 * Works in the browser and in Node (require) so the rules can be tested.
 */
(function () {
  'use strict';

  var isNode = typeof module !== 'undefined' && module.exports;
  var Store = isNode ? require('./helpdesk-store.js') : globalThis.HelpdeskStore;
  var Crm = isNode ? require('./crm.js') : globalThis.NorthlightCrm;

  var OUTBOX_KEY = 'northlight-outbox';
  var LOG_KEY = 'northlight-automation-log';
  var MAX_ENTRIES = 200;
  var NOT_SENT = 'Not sent (demo only)';
  var EVENTS = ['form.sent'];
  var PLACEHOLDERS = ['name', 'email', 'message', 'ticket.id', 'ticket.priority', 'lead.id'];

  // Every action and its settings. All settings are required; unknown settings are rejected.
  var ACTION_SPECS = {
    'crm.createLead': { source: 'source', company: 'string', value: 'amount' },
    'helpdesk.createTicket': { requester: 'string', issue: 'string', impact: 'level', urgency: 'level' },
    'helpdesk.setPriority': { priority: 'priority' },
    'outbox.add': { channel: 'string', to: 'string', subject: 'string', body: 'string' }
  };

  // A copy of rules.json for pages opened from disk (file://), where the browser blocks fetch.
  // tests/automation.test.js makes sure it is identical to rules.json.
  var DEFAULT_DOC = {
    version: 1,
    rules: [
      {
        id: 'form-create-lead',
        description: 'When the website form is sent, create a lead in the CRM.',
        when: { event: 'form.sent' },
        do: [{ action: 'crm.createLead', source: 'Website form', company: 'Not given', value: 0 }]
      },
      {
        id: 'form-create-ticket',
        description: 'When the website form is sent, create a ticket in the help desk.',
        when: { event: 'form.sent' },
        do: [{
          action: 'helpdesk.createTicket', requester: '{name}',
          issue: 'Website enquiry: {message} (reply to {email})', impact: 1, urgency: 1
        }]
      },
      {
        id: 'urgent-escalate',
        description: 'If the message contains the word urgent, set the ticket to P1 and add an alert to the outbox.',
        when: { event: 'form.sent', messageContainsWord: 'urgent' },
        do: [
          { action: 'helpdesk.setPriority', priority: 'P1' },
          {
            action: 'outbox.add', channel: 'alert', to: 'oncall@example.com',
            subject: 'URGENT enquiry: ticket #{ticket.id}', body: '{name} ({email}) wrote: {message}'
          }
        ]
      }
    ]
  };

  // ---------- validating rules ----------
  function isObject(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }

  function placeholderProblem(text) {
    var bad = null;
    String(text).replace(/\{([^}]*)\}/g, function (_, key) {
      if (bad === null && PLACEHOLDERS.indexOf(key) < 0) bad = key;
      return '';
    });
    return bad === null ? null : 'unknown placeholder {' + bad + '}';
  }

  function settingProblem(action, key, type, value) {
    var where = 'action ' + action + ', setting "' + key + '": ';
    switch (type) {
      case 'string':
        if (typeof value !== 'string' || !value.trim()) return where + 'must be some text';
        var p = placeholderProblem(value);
        return p ? where + p : null;
      case 'source':
        return Crm.SOURCES.indexOf(value) >= 0 ? null : where + 'must be one of ' + Crm.SOURCES.join(', ');
      case 'amount':
        return Number.isInteger(value) && value >= 0 && value <= 1000000 ? null : where + 'must be a whole number from 0 to 1000000';
      case 'level':
        return value === 1 || value === 2 || value === 3 ? null : where + 'must be 1, 2 or 3';
      case 'priority':
        return Store.TARGET_HOURS && Object.prototype.hasOwnProperty.call(Store.TARGET_HOURS, value) ? null : where + 'must be P1, P2 or P3';
      default:
        return where + 'unknown setting type';
    }
  }

  function actionProblem(a, n) {
    if (!isObject(a)) return 'action ' + n + ' must be an object';
    var spec = ACTION_SPECS[a.action];
    if (!spec) return 'action ' + n + ' has an unknown "action": ' + JSON.stringify(a.action);
    var keys = Object.keys(spec);
    for (var i = 0; i < keys.length; i++) {
      if (!(keys[i] in a)) return 'action ' + a.action + ' is missing the setting "' + keys[i] + '"';
    }
    var extra = Object.keys(a).filter(function (k) { return k !== 'action' && !(k in spec); });
    if (extra.length) return 'action ' + a.action + ' has an unknown setting "' + extra[0] + '"';
    for (var j = 0; j < keys.length; j++) {
      var p = settingProblem(a.action, keys[j], spec[keys[j]], a[keys[j]]);
      if (p) return p;
    }
    return null;
  }

  function ruleProblem(r, seen) {
    if (!isObject(r)) return 'a rule must be an object';
    if (typeof r.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(r.id)) return '"id" must be 1 to 40 lowercase letters, digits or hyphens';
    if (seen[r.id]) return 'another rule already uses this id';
    var extra = Object.keys(r).filter(function (k) { return ['id', 'description', 'enabled', 'when', 'do'].indexOf(k) < 0; });
    if (extra.length) return 'unknown key "' + extra[0] + '"';
    if ('description' in r && typeof r.description !== 'string') return '"description" must be text';
    if ('enabled' in r && typeof r.enabled !== 'boolean') return '"enabled" must be true or false';
    if (!isObject(r.when)) return '"when" must be an object';
    if (EVENTS.indexOf(r.when.event) < 0) return '"when.event" must be one of ' + EVENTS.join(', ');
    var cond = Object.keys(r.when).filter(function (k) { return k !== 'event' && k !== 'messageContainsWord'; });
    if (cond.length) return 'unknown condition "' + cond[0] + '"';
    if ('messageContainsWord' in r.when && !/^[A-Za-z]{2,30}$/.test(String(r.when.messageContainsWord))) {
      return '"messageContainsWord" must be one word of letters only';
    }
    if (!Array.isArray(r.do) || !r.do.length) return '"do" must be a list with at least one action';
    for (var i = 0; i < r.do.length; i++) {
      var p = actionProblem(r.do[i], i + 1);
      if (p) return p;
    }
    return null;
  }

  // Returns the usable rules and a list of problems. A bad rule is skipped; the others still run.
  function validateRules(doc) {
    var rules = [], problems = [], seen = {};
    if (!isObject(doc) || doc.version !== 1 || !Array.isArray(doc.rules)) {
      return { rules: [], problems: ['The rules file must look like {"version": 1, "rules": [ ... ]}.'] };
    }
    doc.rules.forEach(function (r, i) {
      var label = isObject(r) && typeof r.id === 'string' ? r.id : '#' + (i + 1);
      var why = ruleProblem(r, seen);
      if (why) { problems.push('Rule ' + label + ' skipped: ' + why + '.'); return; }
      seen[r.id] = true;
      rules.push(r);
    });
    return { rules: rules, problems: problems };
  }

  // ---------- small storage helpers (outbox and log are plain lists) ----------
  function readList(storage, key) {
    try {
      var raw = storage.getItem(key);
      if (raw) {
        var d = JSON.parse(raw);
        if (Array.isArray(d)) return d.filter(function (x) { return isObject(x) && Number.isInteger(x.id); });
      }
    } catch (e) { /* treat as empty */ }
    return [];
  }
  function writeList(storage, key, list) {
    try { storage.setItem(key, JSON.stringify(list.slice(-MAX_ENTRIES))); return true; } catch (e) { return false; }
  }
  function nextId(list) { return list.reduce(function (m, x) { return Math.max(m, x.id); }, 0) + 1; }

  function readOutbox(storage) { return readList(storage, OUTBOX_KEY); }
  function readLog(storage) { return readList(storage, LOG_KEY); }
  function clearOutbox(storage) { return writeList(storage, OUTBOX_KEY, []); }
  function clearLog(storage) { return writeList(storage, LOG_KEY, []); }

  function appendLog(storage, lines) {
    var list = readLog(storage);
    lines.forEach(function (l) {
      list.push({ id: nextId(list), at: l.at, ruleId: l.ruleId, status: l.status, message: l.message });
    });
    return writeList(storage, LOG_KEY, list); // a log that cannot be written must never break the rules
  }

  // ---------- placeholders and actions ----------
  function fail(code, message) {
    var e = new Error(message);
    e.code = code;
    return e;
  }

  function lookup(scope, key) {
    var parts = key.split('.');
    var v = scope[parts[0]];
    return parts.length > 1 && v ? v[parts[1]] : v;
  }

  function fill(template, scope) {
    return String(template).replace(/\{([^}]*)\}/g, function (_, key) {
      var v = lookup(scope, key);
      if (v === undefined || v === null) {
        throw fail('config', 'The placeholder {' + key + '} has no value yet. Create the ' + key.split('.')[0] + ' in an earlier rule.');
      }
      return String(v);
    });
  }

  var RUN = {
    'crm.createLead': function (a, env) {
      var crm = env.crm();
      var r = crm.addLead({
        name: env.payload.name, company: fill(a.company, env.scope()), email: env.payload.email,
        source: a.source, value: String(a.value)
      });
      if (!r.ok) {
        if (r.message === Crm.STORAGE_FAILED) throw fail('storage', r.message);
        throw fail('invalid', 'The CRM refused the lead: ' + Object.keys(r.errors || {}).map(function (k) { return r.errors[k]; }).join(' '));
      }
      env.ctx.lead = r.lead;
      return 'created CRM lead #' + r.lead.id + ' (' + r.lead.name + ', source ' + r.lead.source + ')';
    },

    'helpdesk.createTicket': function (a, env) {
      var scope = env.scope();
      var r = Store.createTicket(env.storage, {
        requester: fill(a.requester, scope).slice(0, 60),
        issue: fill(a.issue, scope).slice(0, 300),
        impact: a.impact, urgency: a.urgency
      }, env.now);
      if (!r.ok) throw fail('storage', 'The help desk storage could not be written.');
      env.ctx.ticket = r.ticket;
      return 'created help desk ticket #' + r.ticket.id + ' (' + r.ticket.priority + ')';
    },

    'helpdesk.setPriority': function (a, env) {
      var t = env.ctx.ticket;
      if (!t) throw fail('config', 'There is no ticket to change. Create one in an earlier rule.');
      var r = Store.setPriority(env.storage, t.id, a.priority, env.now);
      if (!r.ok) throw fail(r.error === 'storage' ? 'storage' : 'config', 'Could not set the priority of ticket #' + t.id + ' (' + r.error + ').');
      env.ctx.ticket = r.ticket;
      return r.previous === r.ticket.priority
        ? 'ticket #' + t.id + ' was already ' + r.ticket.priority
        : 'set ticket #' + t.id + ' to ' + r.ticket.priority + ' (was ' + r.previous + ')';
    },

    'outbox.add': function (a, env) {
      var scope = env.scope();
      var list = readOutbox(env.storage);
      var entry = {
        id: nextId(list), at: env.now, ruleId: env.rule.id, channel: a.channel, to: a.to,
        subject: fill(a.subject, scope), body: fill(a.body, scope), status: NOT_SENT
      };
      list.push(entry);
      if (!writeList(env.storage, OUTBOX_KEY, list)) throw fail('storage', 'The outbox could not be written.');
      env.ctx.alerts.push(entry);
      return 'added the ' + a.channel + ' "' + entry.subject + '" to the outbox (not sent)';
    }
  };

  // ---------- the engine ----------
  function matches(when, payload) {
    if (when.messageContainsWord) {
      // Whole word, any case. The word is letters only (checked when the rules load).
      if (!new RegExp('\\b' + when.messageContainsWord + '\\b', 'i').test(String(payload.message || ''))) return false;
    }
    return true;
  }

  // info: { rules, source, problems } from loadRules() (a plain array of rules also works).
  // Returns { ok, results, errors, ctx, matched }. Writes a log line for the event and one for each rule that runs.
  function runEvent(storage, info, event, payload, now) {
    var t = now == null ? Date.now() : now;
    if (Array.isArray(info)) info = { rules: info, source: 'the rules given', problems: [] };
    var ctx = { lead: null, ticket: null, alerts: [] };
    var results = [], errors = [], lines = [], crmInstance = null;

    function line(ruleId, status, message) { lines.push({ at: t, ruleId: ruleId, status: status, message: message }); }

    var matched = info.rules.filter(function (r) {
      return r.enabled !== false && r.when.event === event && matches(r.when, payload);
    });
    line('engine', 'ok', 'Event ' + event + ' from ' + payload.name + ': ' + matched.length + ' of ' + info.rules.length +
      ' rules matched (rules from ' + info.source + ').');
    info.problems.forEach(function (p) { line('engine', 'error', p); });

    var env = {
      storage: storage, now: t, payload: payload, ctx: ctx, rule: null,
      scope: function () { return { name: payload.name, email: payload.email, message: payload.message, ticket: ctx.ticket, lead: ctx.lead }; },
      crm: function () {
        if (!crmInstance) {
          crmInstance = Crm.createCrm(storage, function () { return t; });
          crmInstance.init();
        }
        return crmInstance;
      }
    };

    matched.forEach(function (rule) {
      var done = [];
      env.rule = rule;
      try {
        rule.do.forEach(function (a) { done.push(RUN[a.action](a, env)); });
        results.push({ ruleId: rule.id, status: 'ok', message: done.join('; ') });
        line(rule.id, 'ok', 'Ran: ' + done.join('; ') + '.');
      } catch (e) {
        var message = e && e.message ? e.message : String(e);
        errors.push({ ruleId: rule.id, code: (e && e.code) || 'error', message: message });
        results.push({ ruleId: rule.id, status: 'error', message: message });
        line(rule.id, 'error', (done.length ? 'Partly ran: ' + done.join('; ') + '. ' : '') + 'Stopped: ' + message);
      }
    });

    appendLog(storage, lines);
    return { ok: errors.length === 0, results: results, errors: errors, ctx: ctx, matched: matched.map(function (r) { return r.id; }) };
  }

  // ---------- loading the rules ----------
  function builtIn(extra) {
    var v = validateRules(DEFAULT_DOC);
    return { rules: v.rules, source: 'the built-in copy' + (extra || ''), problems: [] };
  }

  // fetchFn: fetch, or null. rules.json is read when the page is served over http(s). When it cannot be read
  // (a page opened from disk, or offline) or is badly broken, the built-in copy is used and the source says so.
  async function loadRules(fetchFn) {
    if (typeof fetchFn !== 'function') return builtIn(' (rules.json is not available here)');
    var text;
    try {
      var res = await fetchFn('rules.json', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      text = await res.text();
    } catch (e) {
      return builtIn(' (rules.json could not be read: ' + ((e && e.message) || e) + ')');
    }
    var doc;
    try { doc = JSON.parse(text); } catch (e) {
      var fb = builtIn(' (rules.json is not valid JSON)');
      fb.problems.push('rules.json is not valid JSON (' + e.message + '). The built-in copy of the rules is used instead.');
      return fb;
    }
    var v = validateRules(doc);
    if (!v.rules.length && v.problems.length) {
      var fb2 = builtIn(' (no usable rule in rules.json)');
      fb2.problems = v.problems.concat('No rule in rules.json is usable. The built-in copy of the rules is used instead.');
      return fb2;
    }
    return { rules: v.rules, source: 'rules.json', problems: v.problems };
  }

  // Rules used when none are given: the built-in copy.
  function defaultRules() { return builtIn(''); }

  var cachedRules = null;
  function getRules() {
    if (!cachedRules) cachedRules = loadRules(typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    return cachedRules;
  }

  var api = {
    OUTBOX_KEY: OUTBOX_KEY, LOG_KEY: LOG_KEY, NOT_SENT: NOT_SENT, MAX_ENTRIES: MAX_ENTRIES, EVENTS: EVENTS,
    ACTION_SPECS: ACTION_SPECS, PLACEHOLDERS: PLACEHOLDERS, DEFAULT_DOC: DEFAULT_DOC,
    validateRules: validateRules, matches: matches, fill: fill, runEvent: runEvent, loadRules: loadRules, getRules: getRules,
    defaultRules: defaultRules,
    readOutbox: readOutbox, readLog: readLog, clearOutbox: clearOutbox, clearLog: clearLog
  };
  if (isNode) module.exports = api;
  else globalThis.Automation = api;

  // ---------- UI for automation.html (browser only) ----------
  function initUI() {
    var $ = function (id) { return document.getElementById(id); };
    var memory = {};
    var storage;
    try {
      storage = globalThis.localStorage;
      storage.getItem(OUTBOX_KEY);
    } catch (e) {
      storage = { getItem: function (k) { return k in memory ? memory[k] : null; }, setItem: function (k, v) { memory[k] = String(v); } };
    }
    var statusEl = $('status');
    function say(msg, bad) { statusEl.textContent = msg || ''; statusEl.className = bad ? 'bad' : 'good'; }
    function el(tag, text, cls) {
      var n = document.createElement(tag);
      if (text !== undefined) n.textContent = text;
      if (cls) n.className = cls;
      return n;
    }
    function fmt(ms) { return new Date(ms).toLocaleString(); }

    function renderRules(info) {
      $('rules-source').textContent = 'Rules loaded from ' + info.source + '.';
      var probs = $('rules-problems');
      probs.textContent = '';
      info.problems.forEach(function (p) { probs.appendChild(el('li', p)); });
      probs.hidden = info.problems.length === 0;
      var list = $('rules-list');
      list.textContent = '';
      if (!info.rules.length) list.appendChild(el('li', 'No rules.', 'empty'));
      info.rules.forEach(function (r) {
        var li = el('li', undefined, 'item' + (r.enabled === false ? ' done' : ''));
        var head = el('div', undefined, 'row');
        head.appendChild(el('strong', r.id));
        head.appendChild(el('span', r.enabled === false ? 'Disabled' : 'Enabled', 'badge'));
        li.appendChild(head);
        if (r.description) li.appendChild(el('p', r.description, 'desc'));
        var when = 'When: ' + r.when.event + (r.when.messageContainsWord ? ' and the message contains the word "' + r.when.messageContainsWord + '"' : '');
        li.appendChild(el('div', when, 'meta'));
        li.appendChild(el('div', 'Then: ' + r.do.map(function (a) { return a.action; }).join(', '), 'meta'));
        list.appendChild(li);
      });
    }

    function renderOutbox() {
      var items = readOutbox(storage).sort(function (a, b) { return b.at - a.at || b.id - a.id; });
      $('outbox-count').textContent = String(items.length);
      var list = $('outbox-list');
      list.textContent = '';
      if (!items.length) list.appendChild(el('li', 'The outbox is empty. Send the form on the home page with the word "urgent" in the message to add an alert.', 'empty'));
      items.forEach(function (m) {
        var li = el('li', undefined, 'item');
        var head = el('div', undefined, 'row');
        head.appendChild(el('strong', String(m.subject)));
        head.appendChild(el('span', String(m.status), 'badge'));
        li.appendChild(head);
        li.appendChild(el('div', 'To ' + m.to + ' · ' + m.channel + ' · queued by rule ' + m.ruleId + ' · ' + fmt(m.at), 'meta'));
        li.appendChild(el('p', String(m.body), 'desc'));
        list.appendChild(li);
      });
    }

    function renderLog() {
      var items = readLog(storage).sort(function (a, b) { return b.at - a.at || a.id - b.id; });
      $('log-count').textContent = String(items.length);
      var list = $('log-list');
      list.textContent = '';
      if (!items.length) list.appendChild(el('li', 'The log is empty.', 'empty'));
      items.forEach(function (l) {
        var li = el('li', undefined, 'logline ' + l.status);
        var head = el('div', undefined, 'row');
        head.appendChild(el('span', l.status === 'error' ? 'ERROR' : 'OK', 'badge ' + l.status));
        head.appendChild(el('strong', String(l.ruleId)));
        head.appendChild(el('span', fmt(l.at), 'meta'));
        li.appendChild(head);
        li.appendChild(el('p', String(l.message), 'desc'));
        list.appendChild(li);
      });
    }

    function render() { renderOutbox(); renderLog(); }

    $('clear-outbox').addEventListener('click', function () {
      say(clearOutbox(storage) ? 'Outbox cleared.' : 'The browser would not save that change.', false);
      render();
    });
    $('clear-log').addEventListener('click', function () {
      say(clearLog(storage) ? 'Log cleared.' : 'The browser would not save that change.', false);
      render();
    });

    getRules().then(renderRules);
    render();
    // Pick up a form sent from another tab, and keep times current.
    if (typeof globalThis.addEventListener === 'function') globalThis.addEventListener('storage', render);
    setInterval(render, 5000);
  }

  if (typeof document !== 'undefined' && document.getElementById('outbox-list')) initUI();
})();
