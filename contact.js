/*
 * Contact form for index.html. Fake data only.
 * This site is static, so nothing is sent anywhere. When the form is sent it runs the rules in
 * rules.json (see automation.js): a lead in the CRM, a ticket in the help desk, and for urgent
 * messages a P1 ticket plus an alert in the outbox. All of that is saved in this browser only.
 */
(function () {
  'use strict';

  var isNode = typeof module !== 'undefined' && module.exports;
  var Store = isNode ? require('./helpdesk-store.js') : globalThis.HelpdeskStore;
  var Automation = isNode ? require('./automation.js') : globalThis.Automation;

  var LIMITS = { nameMin: 2, nameMax: 60, emailMax: 60, messageMin: 10, messageMax: 200 };
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  var FIELDS = ['name', 'email', 'message'];

  // Collapse whitespace and newlines so counts match what is stored.
  function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

  function validate(values) {
    var v = { name: clean(values.name), email: clean(values.email), message: clean(values.message) };
    var e = {};

    if (!v.name) e.name = 'Enter your name.';
    else if (v.name.length < LIMITS.nameMin || v.name.length > LIMITS.nameMax) {
      e.name = 'Your name must be ' + LIMITS.nameMin + ' to ' + LIMITS.nameMax + ' characters (you entered ' + v.name.length + ').';
    }

    if (!v.email) e.email = 'Enter your email address so we can reply.';
    else if (v.email.length > LIMITS.emailMax) e.email = 'That email address is too long. Use ' + LIMITS.emailMax + ' characters or fewer.';
    else if (!EMAIL_RE.test(v.email)) e.email = 'That email address does not look right. Use a format like name@example.com.';

    if (!v.message) e.message = 'Write a short message about what you need.';
    else if (v.message.length < LIMITS.messageMin) {
      e.message = 'Your message is too short (' + v.message.length + ' of at least ' + LIMITS.messageMin + ' characters). Add a little more detail.';
    } else if (v.message.length > LIMITS.messageMax) {
      e.message = 'Your message is ' + v.message.length + ' characters. Shorten it to ' + LIMITS.messageMax + ' or fewer.';
    }

    return { values: v, errors: e, valid: Object.keys(e).length === 0 };
  }

  var STORAGE_FAILED = 'We could not save your message because this browser is blocking local storage. Please try another browser.';

  // Validates the form, then runs the "form.sent" rules. rules: what Automation.loadRules() returned
  // (defaults to the built-in copy). Returns
  //   { ok: true, name, ticket, lead, alerts, results }   (ticket / lead may be null if no rule makes one)
  //   { ok: false, errors, message }
  function submit(storage, values, now, rules) {
    var r = validate(values);
    if (!r.valid) return { ok: false, errors: r.errors };
    if (!storage) return { ok: false, errors: {}, message: STORAGE_FAILED };
    var info = rules || Automation.defaultRules();
    var run = Automation.runEvent(storage, info, 'form.sent', r.values, now);
    if (!run.ok) {
      var blocked = run.errors.some(function (e) { return e.code === 'storage'; });
      return {
        ok: false, errors: {}, run: run,
        message: blocked ? STORAGE_FAILED
          : 'We could not process your message (' + run.errors[0].ruleId + ': ' + run.errors[0].message + ') See the automation log.'
      };
    }
    return { ok: true, name: r.values.name, ticket: run.ctx.ticket, lead: run.ctx.lead, alerts: run.ctx.alerts, results: run.results };
  }

  var api = { LIMITS: LIMITS, validate: validate, submit: submit, clean: clean, STORAGE_FAILED: STORAGE_FAILED };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  // ---------- UI (browser only) ----------
  function initUI() {
    var $ = function (id) { return document.getElementById(id); };
    var form = $('contact-form');
    var summary = $('form-errors');
    var success = $('form-success');
    var counter = $('msg-count');
    var attempted = false;

    var storage = null;
    try {
      storage = globalThis.localStorage;
      storage.getItem(Store.STORAGE_KEY);
    } catch (e) { storage = null; }

    function el(tag, text) {
      var n = document.createElement(tag);
      if (text !== undefined) n.textContent = text;
      return n;
    }

    function values() {
      return { name: $('c-name').value, email: $('c-email').value, message: $('c-message').value };
    }

    function showFieldErrors(errors) {
      FIELDS.forEach(function (f) {
        var input = $('c-' + f);
        var out = $(f + '-error');
        if (errors[f]) {
          out.textContent = errors[f];
          out.hidden = false;
          input.setAttribute('aria-invalid', 'true');
          input.setAttribute('aria-describedby', f + '-error');
        } else {
          out.textContent = '';
          out.hidden = true;
          input.removeAttribute('aria-invalid');
          input.removeAttribute('aria-describedby');
        }
      });
    }

    function showSummary(errors, extra) {
      summary.textContent = '';
      var keys = FIELDS.filter(function (f) { return errors[f]; });
      if (!keys.length && !extra) { summary.hidden = true; return; }
      if (keys.length) {
        var title = el('p');
        title.appendChild(el('strong', 'Please fix ' + keys.length + (keys.length === 1 ? ' problem' : ' problems') + ' before sending:'));
        summary.appendChild(title);
        var ul = el('ul');
        keys.forEach(function (f) {
          var li = el('li');
          var a = el('a', errors[f]);
          a.href = '#c-' + f;
          li.appendChild(a);
          ul.appendChild(li);
        });
        summary.appendChild(ul);
      }
      if (extra) summary.appendChild(el('p', extra));
      summary.hidden = false;
    }

    function updateCounter() {
      var n = clean($('c-message').value).length;
      counter.textContent = n + ' / ' + LIMITS.messageMax;
      counter.className = n > LIMITS.messageMax ? 'count over' : 'count';
    }

    function link(href, text) {
      var a = el('a', text);
      a.href = href;
      var p = el('p');
      p.appendChild(a);
      return p;
    }

    function showSuccess(r) {
      success.textContent = '';
      success.appendChild(el('h3', 'Thank you, ' + r.name + '.'));
      if (r.ticket) {
        var hours = Store.TARGET_HOURS[r.ticket.priority];
        success.appendChild(el('p', 'Your message is ticket #' + r.ticket.id + ' (priority ' + r.ticket.priority +
          '). We aim to reply within ' + hours + (hours === 1 ? ' hour.' : ' hours.')));
      } else {
        success.appendChild(el('p', 'Your message was received.'));
      }
      if (r.results.length) {
        success.appendChild(el('p', 'These automation rules ran:'));
        var ul = el('ul');
        r.results.forEach(function (x) { ul.appendChild(el('li', x.ruleId + ': ' + x.message + '.')); });
        success.appendChild(ul);
      }
      success.appendChild(el('p', 'This is a demo: everything is saved in this browser only, and nothing is sent over the internet.'));
      if (r.ticket) success.appendChild(link('helpdesk.html', 'See the ticket in the help desk'));
      success.appendChild(link('automation.html', 'See the outbox and the log'));
      success.hidden = false;
    }

    // Start loading rules.json now so it is ready when the form is sent.
    var rulesReady = Automation.getRules();

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      attempted = true;
      success.hidden = true;
      var r = submit(storage, values(), Date.now(), await rulesReady);
      if (r.ok) {
        showFieldErrors({});
        showSummary({}, null);
        showSuccess(r);
        form.reset();
        attempted = false;
        updateCounter();
        success.focus();
        return;
      }
      showFieldErrors(r.errors);
      showSummary(r.errors, r.message);
      summary.focus();
    });

    // After a failed attempt, re-check on every keystroke so errors disappear as they are fixed.
    form.addEventListener('input', function () {
      updateCounter();
      if (attempted) {
        var r = validate(values());
        showFieldErrors(r.errors);
        if (r.valid) showSummary({}, null);
      }
    });

    updateCounter();
  }

  if (typeof document !== 'undefined' && document.getElementById('contact-form')) initUI();
})();
