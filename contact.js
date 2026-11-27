/*
 * Contact form for index.html. Fake data only.
 * This site is static, so nothing is sent anywhere: a sent form creates a ticket in the
 * help desk storage of this browser (see helpdesk-store.js).
 */
(function () {
  'use strict';

  var Store = (typeof module !== 'undefined' && module.exports)
    ? require('./helpdesk-store.js')
    : globalThis.HelpdeskStore;

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

  // The ticket "issue" field holds 300 characters at most; 17 + 200 + 11 + 60 + 1 = 289 fits.
  function buildIssue(v) { return 'Website enquiry: ' + v.message + ' (reply to ' + v.email + ')'; }

  var STORAGE_FAILED = 'We could not save your message because this browser is blocking local storage. Please try another browser.';

  // Returns { ok: true, ticket } or { ok: false, errors, message }.
  function submit(storage, values, now) {
    var r = validate(values);
    if (!r.valid) return { ok: false, errors: r.errors };
    // A general enquiry: Low impact, Low urgency, so priority P3 (response target 24 h).
    var res = storage
      ? Store.createTicket(storage, { requester: r.values.name, issue: buildIssue(r.values), impact: 1, urgency: 1 }, now)
      : { ok: false };
    if (!res.ok) return { ok: false, errors: {}, message: STORAGE_FAILED };
    return { ok: true, ticket: res.ticket };
  }

  var api = { LIMITS: LIMITS, validate: validate, buildIssue: buildIssue, submit: submit, clean: clean, STORAGE_FAILED: STORAGE_FAILED };
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

    function showSuccess(ticket) {
      success.textContent = '';
      success.appendChild(el('h3', 'Thank you, ' + ticket.requester + '.'));
      success.appendChild(el('p', 'Your message is ticket #' + ticket.id + ' (priority ' + ticket.priority +
        '). We aim to reply within ' + Store.TARGET_HOURS[ticket.priority] + ' hours.'));
      success.appendChild(el('p', 'This is a demo: the ticket is saved in the help desk of this browser and nothing is sent over the internet.'));
      var a = el('a', 'See it in the help desk');
      a.href = 'helpdesk.html';
      var p = el('p');
      p.appendChild(a);
      success.appendChild(p);
      success.hidden = false;
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      attempted = true;
      success.hidden = true;
      var r = submit(storage, values());
      if (r.ok) {
        showFieldErrors({});
        showSummary({}, null);
        showSuccess(r.ticket);
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
