/*
 * Small CRM: leads, accounts, contacts, opportunities and support cases.
 * Fake data only, saved in localStorage. Plain JavaScript, no libraries.
 *
 * Layout: pure helpers -> createCrm() state machine (all rules, no DOM) -> chart geometry -> UI at the bottom.
 * Works in the browser and in Node (require) so the rules can be tested.
 */
(function () {
  'use strict';

  var Store = (typeof module !== 'undefined' && module.exports)
    ? require('./helpdesk-store.js')
    : globalThis.HelpdeskStore;

  var STORAGE_KEY = 'northlight-crm-v1';
  var BACKUP_KEY = 'northlight-crm-v1-invalid';
  var STAGES = ['Lead', 'Qualified', 'Quote', 'Won', 'Lost'];
  var NEW_OPP_STAGE = STAGES[0]; // a freshly converted lead starts at the first stage
  var SOURCES = ['Website form', 'Referral', 'Trade show', 'Social media', 'Other'];
  var PRIORITIES = ['P1', 'P2', 'P3'];
  var HOUR = 3600 * 1000;
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  var STORAGE_FAILED = 'The browser would not save your change (local storage is blocked or full). Nothing was changed.';

  // ---------- small helpers ----------
  function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  function euro(n) { return '€' + Number(n).toLocaleString('en-GB'); }
  function pad(n) { return String(n).padStart(2, '0'); }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function nextId(list) { return list.reduce(function (m, x) { return Math.max(m, x.id); }, 0) + 1; }

  // "2026-11-27T14:30" (what <input type="datetime-local"> gives) -> local time in ms, or null.
  function parseLocalInput(str) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(str || '').trim());
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3], h = +m[4], mi = +m[5];
    var dt = new Date(y, mo - 1, d, h, mi);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d ||
        dt.getHours() !== h || dt.getMinutes() !== mi) return null;
    return dt.getTime();
  }
  function toLocalInput(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  // Suggested due time for a priority, from the same response targets the help desk uses.
  function defaultDue(priority, now) {
    var hours = Store.TARGET_HOURS[priority] || Store.TARGET_HOURS.P3;
    return toLocalInput(Math.ceil((now + hours * HOUR) / 60000) * 60000);
  }

  // ---------- seed data: three fake leads and one case ----------
  function seed(now) {
    return {
      leads: [
        { id: 1, name: 'Morgan Placeholder', company: 'Brightside Bakery', email: 'morgan@example.com', source: 'Website form', value: 8000, status: 'Open', createdAt: now - 52 * HOUR },
        { id: 2, name: 'Dana Demo', company: 'Harbor and Pine Outfitters', email: 'dana@example.org', source: 'Referral', value: 24000, status: 'Open', createdAt: now - 30 * HOUR },
        { id: 3, name: 'Quinn Sample', company: 'Greenfield Clinic', email: 'quinn@example.net', source: 'Trade show', value: 15000, status: 'Open', createdAt: now - 5 * HOUR }
      ],
      accounts: [],
      contacts: [],
      opportunities: [],
      cases: [
        { id: 1, accountId: null, subject: 'Cannot open the shared brand assets folder', priority: 'P2', dueAt: now + 3 * HOUR, status: 'Open', createdAt: now - HOUR }
      ]
    };
  }

  // ---------- validating stored data (including links between records) ----------
  function isInt(n) { return Number.isInteger(n); }
  function isStr(s) { return typeof s === 'string'; }
  function ids(list) { return list.map(function (x) { return x.id; }); }
  function unique(list) { return new Set(ids(list)).size === list.length; }

  function valid(d) {
    if (!d || typeof d !== 'object') return false;
    var keys = ['leads', 'accounts', 'contacts', 'opportunities', 'cases'];
    if (!keys.every(function (k) { return Array.isArray(d[k]) && d[k].every(function (x) { return x && isInt(x.id); }) && unique(d[k]); })) return false;
    var accountIds = new Set(ids(d.accounts)), contactIds = new Set(ids(d.contacts));
    var oppIds = new Set(ids(d.opportunities));
    return d.accounts.every(function (a) { return isStr(a.name) && Number.isFinite(a.createdAt); }) &&
      d.contacts.every(function (c) { return isStr(c.name) && isStr(c.email) && accountIds.has(c.accountId); }) &&
      d.opportunities.every(function (o) {
        return isStr(o.name) && Number.isFinite(o.value) && STAGES.indexOf(o.stage) >= 0 &&
          accountIds.has(o.accountId) && contactIds.has(o.contactId) &&
          Number.isFinite(o.createdAt) && Number.isFinite(o.stageChangedAt);
      }) &&
      d.leads.every(function (l) {
        var base = isStr(l.name) && isStr(l.company) && isStr(l.email) && isStr(l.source) &&
          Number.isFinite(l.value) && Number.isFinite(l.createdAt);
        if (l.status === 'Open') return base;
        return base && l.status === 'Converted' && accountIds.has(l.accountId) &&
          contactIds.has(l.contactId) && oppIds.has(l.opportunityId);
      }) &&
      d.cases.every(function (c) {
        return isStr(c.subject) && PRIORITIES.indexOf(c.priority) >= 0 && Number.isFinite(c.dueAt) &&
          Number.isFinite(c.createdAt) && (c.status === 'Open' || c.status === 'Closed') &&
          (c.accountId === null || accountIds.has(c.accountId));
      });
  }

  function save(storage, data) {
    try { storage.setItem(STORAGE_KEY, JSON.stringify(data)); return true; } catch (e) { return false; }
  }

  // Reads the CRM data. Unusable stored data is kept under a backup key before the demo data is restored.
  function load(storage, now) {
    var raw = null;
    try {
      raw = storage.getItem(STORAGE_KEY);
      if (raw) {
        var d = JSON.parse(raw);
        if (valid(d)) return d;
      }
    } catch (e) { /* fall through */ }
    if (raw) { try { storage.setItem(BACKUP_KEY, raw); } catch (e) { /* ignore */ } }
    var fresh = seed(now);
    save(storage, fresh);
    return fresh;
  }

  // ---------- validating forms ----------
  function lengthError(label, text, min, max) {
    return 'The ' + label + ' must be ' + min + ' to ' + max + ' characters (you entered ' + text.length + ').';
  }

  function validateLead(f) {
    var v = { name: clean(f.name), company: clean(f.company), email: clean(f.email), source: String(f.source || ''), value: clean(f.value) };
    var e = {};
    if (!v.name) e.name = 'Enter the contact name.';
    else if (v.name.length < 2 || v.name.length > 60) e.name = lengthError('name', v.name, 2, 60);
    if (!v.company) e.company = 'Enter the company name.';
    else if (v.company.length < 2 || v.company.length > 60) e.company = lengthError('company name', v.company, 2, 60);
    if (!v.email) e.email = 'Enter an email address.';
    else if (v.email.length > 60) e.email = 'That email address is too long. Use 60 characters or fewer.';
    else if (!EMAIL_RE.test(v.email)) e.email = 'That email address does not look right. Use a format like name@example.com.';
    if (SOURCES.indexOf(v.source) < 0) e.source = 'Choose where the lead came from.';
    if (!v.value) e.value = 'Enter the estimated value in euros.';
    else if (!/^\d+$/.test(v.value)) e.value = 'Use whole euros only, for example 8000.';
    else if (Number(v.value) > 1000000) e.value = 'The estimated value cannot be more than 1,000,000 euros.';
    return { values: v, errors: e, valid: Object.keys(e).length === 0 };
  }

  function validateCase(f, accounts) {
    var v = { subject: clean(f.subject), priority: String(f.priority || ''), due: String(f.due || '').trim(), account: String(f.account == null ? '' : f.account) };
    var e = {};
    if (!v.subject) e.subject = 'Describe the problem in a few words.';
    else if (v.subject.length < 5 || v.subject.length > 100) e.subject = lengthError('subject', v.subject, 5, 100);
    if (PRIORITIES.indexOf(v.priority) < 0) e.priority = 'Choose a priority.';
    var dueAt = null;
    if (!v.due) e.due = 'Enter a due date and time.';
    else if ((dueAt = parseLocalInput(v.due)) === null) e.due = 'Enter a valid due date and time.';
    var accountId = null;
    if (v.account !== '') {
      accountId = Number(v.account);
      if (!accounts.some(function (a) { return a.id === accountId; })) e.account = 'Choose an account from the list, or leave it empty.';
    }
    return { values: v, dueAt: dueAt, accountId: accountId, errors: e, valid: Object.keys(e).length === 0 };
  }

  // ---------- the app: all rules, no DOM ----------
  function createCrm(storage, nowFn) {
    var now = nowFn || Date.now;
    var crm = { state: null };

    crm.init = function () { crm.state = load(storage, now()); };

    crm.reset = function () {
      var fresh = seed(now());
      if (!save(storage, fresh)) return { ok: false, message: STORAGE_FAILED };
      crm.state = fresh;
      return { ok: true };
    };

    // Applies a change to a copy, saves it, and only then makes it current: all or nothing.
    function commit(fn) {
      var next = clone(crm.state);
      var r = fn(next);
      if (!r.ok) return r;
      if (!save(storage, next)) return { ok: false, message: STORAGE_FAILED };
      crm.state = next;
      return r;
    }

    crm.addLead = function (fields) {
      var r = validateLead(fields);
      if (!r.valid) return { ok: false, errors: r.errors };
      return commit(function (s) {
        var lead = {
          id: nextId(s.leads), name: r.values.name, company: r.values.company, email: r.values.email,
          source: r.values.source, value: Number(r.values.value), status: 'Open', createdAt: now()
        };
        s.leads.push(lead);
        return { ok: true, lead: lead };
      });
    };

    // Turns an open lead into an account, a contact and an opportunity.
    crm.convertLead = function (leadId) {
      return commit(function (s) {
        var lead = s.leads.find(function (l) { return l.id === leadId; });
        if (!lead) return { ok: false, message: 'No such lead.' };
        if (lead.status !== 'Open') return { ok: false, message: lead.name + ' has already been converted.' };
        var t = now();
        var account = { id: nextId(s.accounts), name: lead.company, createdAt: t, leadId: lead.id };
        s.accounts.push(account);
        var contact = { id: nextId(s.contacts), accountId: account.id, name: lead.name, email: lead.email, createdAt: t };
        s.contacts.push(contact);
        var opportunity = {
          id: nextId(s.opportunities), accountId: account.id, contactId: contact.id,
          name: lead.company + ' - first project', value: lead.value, stage: NEW_OPP_STAGE, createdAt: t, stageChangedAt: t
        };
        s.opportunities.push(opportunity);
        lead.status = 'Converted';
        lead.convertedAt = t;
        lead.accountId = account.id;
        lead.contactId = contact.id;
        lead.opportunityId = opportunity.id;
        return { ok: true, lead: lead, account: account, contact: contact, opportunity: opportunity };
      });
    };

    crm.setStage = function (oppId, stage) {
      if (STAGES.indexOf(stage) < 0) return { ok: false, message: 'Unknown stage.' };
      return commit(function (s) {
        var o = s.opportunities.find(function (x) { return x.id === oppId; });
        if (!o) return { ok: false, message: 'No such opportunity.' };
        if (o.stage !== stage) { o.stage = stage; o.stageChangedAt = now(); }
        return { ok: true, opportunity: o };
      });
    };

    crm.addCase = function (fields) {
      var r = validateCase(fields, crm.state.accounts);
      if (!r.valid) return { ok: false, errors: r.errors };
      return commit(function (s) {
        var c = {
          id: nextId(s.cases), accountId: r.accountId, subject: r.values.subject, priority: r.values.priority,
          dueAt: r.dueAt, status: 'Open', createdAt: now()
        };
        s.cases.push(c);
        return { ok: true, case: c };
      });
    };

    crm.closeCase = function (id) {
      return commit(function (s) {
        var c = s.cases.find(function (x) { return x.id === id; });
        if (!c) return { ok: false, message: 'No such case.' };
        if (c.status === 'Closed') return { ok: false, message: 'That case is already closed.' };
        c.status = 'Closed';
        c.closedAt = now();
        return { ok: true, case: c };
      });
    };

    crm.isOverdue = function (c) { return isOverdue(c, now()); };
    crm.accountName = function (id) {
      var a = crm.state.accounts.find(function (x) { return x.id === id; });
      return a ? a.name : null;
    };
    crm.summary = function () { return stageSummary(crm.state.opportunities); };
    crm.now = now;

    return crm;
  }

  function isOverdue(c, nowMs) { return c.status === 'Open' && nowMs > c.dueAt; }

  // ---------- chart: opportunities by stage ----------
  function stageSummary(opps) {
    var stages = STAGES.map(function (stage) {
      var list = opps.filter(function (o) { return o.stage === stage; });
      return { stage: stage, count: list.length, value: list.reduce(function (s, o) { return s + o.value; }, 0) };
    });
    return { stages: stages, total: opps.length, totalValue: opps.reduce(function (s, o) { return s + o.value; }, 0) };
  }

  // Horizontal bars: one row per stage, stage name at the left, count at the bar tip.
  // Bars are 20 units thick (never over 24) and grow from a single baseline.
  function chartGeometry(model, opts) {
    opts = opts || {};
    var W = opts.width || 360, rowH = opts.rowH || 40, thick = Math.min(24, opts.barThickness || 20);
    var m = { top: 8, right: 36, bottom: 44, left: 78 };
    var plotW = W - m.left - m.right, plotH = rowH * model.length;
    var max = model.reduce(function (a, s) { return Math.max(a, s.count); }, 0);
    var step = max <= 4 ? 1 : Math.ceil(max / 4);
    var niceMax = Math.max(4, Math.ceil(max / step) * step); // whole-number ticks; a lone bar never fills the plot
    var ticks = [];
    for (var v = 0; v <= niceMax; v += step) ticks.push({ value: v, x: m.left + plotW * v / niceMax });
    var rows = model.map(function (s, i) {
      var top = m.top + i * rowH, cy = top + rowH / 2, w = plotW * s.count / niceMax;
      return {
        stage: s.stage, count: s.count, value: s.value, top: top, height: rowH, cy: cy,
        barX: m.left, barY: cy - thick / 2, barW: w, barH: thick, tipX: m.left + w, labelX: m.left + w + 6
      };
    });
    return {
      width: W, height: m.top + plotH + m.bottom, margin: m, plotW: plotW, plotH: plotH, plotBottom: m.top + plotH,
      niceMax: niceMax, step: step, ticks: ticks, rows: rows
    };
  }

  // 4px rounded data-end, square at the baseline.
  function barPath(r) {
    if (r.barW <= 0) return '';
    var x = r.barX, y = r.barY, w = r.barW, h = r.barH, rr = Math.min(4, w, h / 2);
    return 'M' + x + ' ' + y + 'H' + (x + w - rr) + 'Q' + (x + w) + ' ' + y + ' ' + (x + w) + ' ' + (y + rr) +
      'V' + (y + h - rr) + 'Q' + (x + w) + ' ' + (y + h) + ' ' + (x + w - rr) + ' ' + (y + h) + 'H' + x + 'Z';
  }

  function rowLabel(r) {
    return r.stage + ': ' + r.count + (r.count === 1 ? ' opportunity' : ' opportunities') + ', ' + euro(r.value);
  }
  function chartAlt(summary) {
    return 'Opportunities by stage. ' + summary.stages.map(function (s) { return s.stage + ' ' + s.count; }).join(', ') + '.';
  }

  var api = {
    STORAGE_KEY: STORAGE_KEY, BACKUP_KEY: BACKUP_KEY, STAGES: STAGES, SOURCES: SOURCES, PRIORITIES: PRIORITIES,
    NEW_OPP_STAGE: NEW_OPP_STAGE, STORAGE_FAILED: STORAGE_FAILED,
    seed: seed, valid: valid, load: load, createCrm: createCrm, validateLead: validateLead, validateCase: validateCase,
    isOverdue: isOverdue, stageSummary: stageSummary, chartGeometry: chartGeometry, barPath: barPath,
    rowLabel: rowLabel, chartAlt: chartAlt, parseLocalInput: parseLocalInput, toLocalInput: toLocalInput,
    defaultDue: defaultDue, euro: euro
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else globalThis.NorthlightCrm = api; // lets automation.js use the CRM rules in the browser

  // ---------- UI (browser only) ----------
  function initUI() {
    var $ = function (id) { return document.getElementById(id); };
    var SVGNS = 'http://www.w3.org/2000/svg';

    var memory = {};
    var storage;
    try {
      storage = globalThis.localStorage;
      storage.getItem(STORAGE_KEY);
    } catch (e) {
      storage = { getItem: function (k) { return k in memory ? memory[k] : null; }, setItem: function (k, v) { memory[k] = String(v); } };
    }
    var crm = createCrm(storage, Date.now);
    crm.init();

    var statusEl = $('status');
    function say(msg, bad) { statusEl.textContent = msg || ''; statusEl.className = bad ? 'bad' : 'good'; }

    function el(tag, text, cls) {
      var n = document.createElement(tag);
      if (text !== undefined) n.textContent = text;
      if (cls) n.className = cls;
      return n;
    }
    function button(text, label, onClick) {
      var b = el('button', text);
      b.type = 'button';
      if (label) b.setAttribute('aria-label', label);
      b.addEventListener('click', onClick);
      return b;
    }
    function fmt(ms) { return new Date(ms).toLocaleString(); }

    // ----- chart -----
    var tip = $('chart-tip');
    function showTip(row, fx, fy) {
      tip.textContent = '';
      tip.appendChild(el('strong', row.count + (row.count === 1 ? ' opportunity' : ' opportunities')));
      tip.appendChild(el('span', row.stage + ' · ' + euro(row.value)));
      tip.style.left = (fx * 100) + '%';
      tip.style.top = (fy * 100) + '%';
      tip.className = fx > 0.6 ? 'tip flip' : 'tip';
      tip.hidden = false;
    }
    function hideTip() { tip.hidden = true; }

    function svgEl(name, attrs) {
      var n = document.createElementNS(SVGNS, name);
      Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
      return n;
    }
    function svgText(text, attrs) {
      var t = svgEl('text', attrs);
      t.textContent = text;
      return t;
    }

    function renderChart() {
      var summary = crm.summary();
      var g = chartGeometry(summary.stages);
      var svg = svgEl('svg', { viewBox: '0 0 ' + g.width + ' ' + g.height, role: 'group', 'aria-label': chartAlt(summary), 'class': 'chart' });

      g.ticks.forEach(function (t) {
        svg.appendChild(svgEl('line', { x1: t.x, x2: t.x, y1: g.margin.top, y2: g.plotBottom, 'class': t.value === 0 ? 'axis' : 'grid' }));
        svg.appendChild(svgText(String(t.value), { x: t.x, y: g.plotBottom + 16, 'text-anchor': 'middle', 'class': 'tick' }));
      });
      svg.appendChild(svgText('Number of opportunities', { x: g.margin.left + g.plotW / 2, y: g.plotBottom + 36, 'text-anchor': 'middle', 'class': 'tick' }));

      g.rows.forEach(function (r) {
        var grp = svgEl('g', { 'class': 'row', tabindex: '0', role: 'img', 'aria-label': rowLabel(r) });
        grp.appendChild(svgText(r.stage, { x: g.margin.left - 8, y: r.cy + 4, 'text-anchor': 'end', 'class': 'stage' }));
        if (r.count > 0) {
          grp.appendChild(svgEl('path', { d: barPath(r), 'class': 'bar' }));
          grp.appendChild(svgText(String(r.count), { x: r.labelX, y: r.cy + 4, 'class': 'value' }));
        }
        // Transparent hit area: the whole row, far bigger than the bar itself.
        grp.appendChild(svgEl('rect', { x: 0, y: r.top, width: g.width, height: r.height, 'class': 'hit' }));
        grp.addEventListener('pointermove', function (e) {
          var box = svg.getBoundingClientRect();
          showTip(r, (e.clientX - box.left) / box.width, (e.clientY - box.top) / box.height);
        });
        grp.addEventListener('pointerleave', hideTip);
        grp.addEventListener('focus', function () { showTip(r, Math.min(r.tipX + 8, g.width) / g.width, r.cy / g.height); });
        grp.addEventListener('blur', hideTip);
        svg.appendChild(grp);
      });

      if (summary.total === 0) {
        svg.appendChild(svgText('No opportunities yet. Convert a lead to add one.', {
          x: g.margin.left + g.plotW / 2, y: g.margin.top + g.plotH / 2 + 4, 'text-anchor': 'middle', 'class': 'empty'
        }));
      }

      var holder = $('chart');
      holder.textContent = '';
      holder.appendChild(svg);

      // Table twin: every value, readable without hovering.
      var body = $('chart-table');
      body.textContent = '';
      summary.stages.forEach(function (s) {
        var tr = el('tr');
        tr.appendChild(el('td', s.stage));
        tr.appendChild(el('td', String(s.count), 'num'));
        tr.appendChild(el('td', euro(s.value), 'num'));
        body.appendChild(tr);
      });
      var total = el('tr', undefined, 'total');
      total.appendChild(el('td', 'Total'));
      total.appendChild(el('td', String(summary.total), 'num'));
      total.appendChild(el('td', euro(summary.totalValue), 'num'));
      body.appendChild(total);
      $('chart-summary').textContent = summary.total + (summary.total === 1 ? ' opportunity' : ' opportunities') + ' worth ' + euro(summary.totalValue) + ' in total.';
    }

    // ----- lists -----
    function renderLeads() {
      var list = $('lead-list');
      list.textContent = '';
      var leads = crm.state.leads.slice().sort(function (a, b) {
        return (a.status === 'Open' ? 0 : 1) - (b.status === 'Open' ? 0 : 1) || b.createdAt - a.createdAt;
      });
      if (!leads.length) list.appendChild(el('li', 'No leads.', 'empty'));
      leads.forEach(function (l) {
        var li = el('li', undefined, 'item' + (l.status === 'Converted' ? ' done' : ''));
        var head = el('div', undefined, 'row');
        head.appendChild(el('strong', l.name));
        head.appendChild(el('span', l.company));
        head.appendChild(el('span', l.status, 'badge'));
        li.appendChild(head);
        li.appendChild(el('div', l.email + ' · ' + l.source + ' · est. ' + euro(l.value) + ' · added ' + fmt(l.createdAt), 'meta'));
        if (l.status === 'Open') {
          li.appendChild(button('Convert', 'Convert ' + l.name + ' to an account, a contact and an opportunity', function () {
            var r = crm.convertLead(l.id);
            if (r.ok) {
              say('Converted ' + l.name + ': created the account "' + r.account.name + '", a contact and an opportunity (' +
                euro(r.opportunity.value) + ', stage ' + r.opportunity.stage + ').');
            } else say(r.message, true);
            render();
          }));
        } else {
          li.appendChild(el('div', 'Converted to the account "' + (crm.accountName(l.accountId) || '?') + '", a contact and an opportunity.', 'meta'));
        }
        list.appendChild(li);
      });
    }

    function renderAccounts() {
      var list = $('account-list');
      list.textContent = '';
      var s = crm.state;
      if (!s.accounts.length) list.appendChild(el('li', 'No accounts yet. Convert a lead to create one.', 'empty'));
      s.accounts.forEach(function (a) {
        var li = el('li', undefined, 'item');
        li.appendChild(el('strong', a.name));
        var contacts = s.contacts.filter(function (c) { return c.accountId === a.id; });
        var opps = s.opportunities.filter(function (o) { return o.accountId === a.id; });
        li.appendChild(el('div', 'Contacts: ' + contacts.map(function (c) { return c.name + ' (' + c.email + ')'; }).join(', ') +
          ' · Opportunities: ' + opps.length, 'meta'));
        list.appendChild(li);
      });
    }

    function renderOpps() {
      var list = $('opp-list');
      list.textContent = '';
      var s = crm.state;
      if (!s.opportunities.length) list.appendChild(el('li', 'No opportunities yet. Convert a lead to create one.', 'empty'));
      s.opportunities.slice().sort(function (a, b) {
        return STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage) || b.value - a.value;
      }).forEach(function (o) {
        var li = el('li', undefined, 'item');
        var head = el('div', undefined, 'row');
        head.appendChild(el('strong', o.name));
        head.appendChild(el('span', euro(o.value)));
        li.appendChild(head);
        var contact = s.contacts.find(function (c) { return c.id === o.contactId; });
        li.appendChild(el('div', (crm.accountName(o.accountId) || '?') + ' · ' + (contact ? contact.name : '?') +
          ' · in this stage since ' + fmt(o.stageChangedAt), 'meta'));
        var label = el('label', 'Stage ');
        var sel = el('select');
        sel.setAttribute('aria-label', 'Stage of ' + o.name);
        STAGES.forEach(function (st) {
          var opt = el('option', st);
          opt.value = st;
          if (st === o.stage) opt.selected = true;
          sel.appendChild(opt);
        });
        sel.addEventListener('change', function () {
          var r = crm.setStage(o.id, sel.value);
          if (!r.ok) say(r.message, true);
          render();
        });
        label.appendChild(sel);
        li.appendChild(label);
        list.appendChild(li);
      });
    }

    function renderCases() {
      var sel = $('k-account');
      var chosen = sel.value;
      sel.textContent = '';
      var none = el('option', '(no account)');
      none.value = '';
      sel.appendChild(none);
      crm.state.accounts.forEach(function (a) {
        var o = el('option', a.name);
        o.value = String(a.id);
        sel.appendChild(o);
      });
      sel.value = chosen;

      var list = $('case-list');
      list.textContent = '';
      var t = crm.now();
      var cases = crm.state.cases.slice().sort(function (a, b) {
        return (a.status === 'Open' ? 0 : 1) - (b.status === 'Open' ? 0 : 1) ||
          a.priority.localeCompare(b.priority) || a.dueAt - b.dueAt;
      });
      if (!cases.length) list.appendChild(el('li', 'No cases.', 'empty'));
      cases.forEach(function (c) {
        var li = el('li', undefined, 'item' + (c.status === 'Closed' ? ' done' : ''));
        var head = el('div', undefined, 'row');
        head.appendChild(el('span', c.priority, 'badge ' + c.priority));
        head.appendChild(el('strong', '#' + c.id + ' ' + c.subject));
        if (isOverdue(c, t)) head.appendChild(el('span', 'Overdue', 'overdue'));
        li.appendChild(head);
        li.appendChild(el('div', (c.accountId === null ? 'No account' : (crm.accountName(c.accountId) || '?')) +
          ' · due ' + fmt(c.dueAt) + ' · ' + c.status, 'meta'));
        if (c.status === 'Open') {
          li.appendChild(button('Close case', 'Close case ' + c.id, function () {
            var r = crm.closeCase(c.id);
            say(r.ok ? 'Case #' + c.id + ' closed.' : r.message, !r.ok);
            render();
          }));
        }
        list.appendChild(li);
      });
    }

    function render() {
      renderChart();
      renderLeads();
      renderAccounts();
      renderOpps();
      renderCases();
    }

    // ----- forms -----
    function showErrors(prefix, fields, errors) {
      var first = null;
      fields.forEach(function (f) {
        var input = $(prefix + '-' + f), out = $(prefix + '-' + f + '-error');
        if (errors[f]) {
          out.textContent = errors[f];
          out.hidden = false;
          input.setAttribute('aria-invalid', 'true');
          input.setAttribute('aria-describedby', prefix + '-' + f + '-error');
          if (!first) first = input;
        } else {
          out.textContent = '';
          out.hidden = true;
          input.removeAttribute('aria-invalid');
          input.removeAttribute('aria-describedby');
        }
      });
      return first;
    }

    $('lead-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var r = crm.addLead({
        name: $('l-name').value, company: $('l-company').value, email: $('l-email').value,
        source: $('l-source').value, value: $('l-value').value
      });
      var first = showErrors('l', ['name', 'company', 'email', 'source', 'value'], r.errors || {});
      if (r.ok) {
        e.target.reset();
        say('Lead added: ' + r.lead.name + ' (' + r.lead.company + ').');
        render();
      } else {
        say(r.message || 'Please fix the highlighted fields.', true);
        if (first) first.focus();
      }
    });

    var dueEdited = false;
    function suggestDue() { $('k-due').value = defaultDue($('k-priority').value, crm.now()); }
    $('k-priority').addEventListener('change', function () { if (!dueEdited) suggestDue(); });
    $('k-due').addEventListener('input', function () { dueEdited = true; });

    $('case-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var r = crm.addCase({
        subject: $('k-subject').value, account: $('k-account').value, priority: $('k-priority').value, due: $('k-due').value
      });
      var first = showErrors('k', ['subject', 'account', 'priority', 'due'], r.errors || {});
      if (r.ok) {
        e.target.reset();
        dueEdited = false;
        suggestDue();
        say('Case #' + r.case.id + ' created (' + r.case.priority + ', due ' + fmt(r.case.dueAt) + ').');
        render();
      } else {
        say(r.message || 'Please fix the highlighted fields.', true);
        if (first) first.focus();
      }
    });

    $('reset').addEventListener('click', function () {
      var r = crm.reset();
      say(r.ok ? 'Demo data reset.' : r.message, !r.ok);
      render();
    });

    suggestDue();
    render();
    setInterval(renderCases, 30000); // keep Overdue labels current
  }

  if (typeof document !== 'undefined' && document.getElementById('lead-form')) initUI();
})();
