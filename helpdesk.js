(function () {
  'use strict';

  // Storage rules (priority, response targets, seed data) live in helpdesk-store.js,
  // shared with the contact form on index.html.
  var Store = globalThis.HelpdeskStore;
  var HOUR = Store.HOUR;
  var TARGET_HOURS = Store.TARGET_HOURS;
  var STATUSES = Store.STATUSES;
  var LEVELS = Store.LEVELS;
  var priorityFor = Store.priorityFor;
  var isOverdue = Store.isOverdue;

  var memory = {};
  var storage;
  try {
    storage = globalThis.localStorage;
    storage.getItem(Store.STORAGE_KEY);
  } catch (e) {
    // localStorage blocked (for example a private window): keep tickets in memory for this visit.
    storage = {
      getItem: function (k) { return k in memory ? memory[k] : null; },
      setItem: function (k, v) { memory[k] = String(v); }
    };
  }

  function save(data) { Store.save(storage, data); }

  var tickets = Store.load(storage);

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function render() {
    var now = Date.now();
    var list = document.getElementById('list');
    list.textContent = '';

    var sorted = tickets.slice().sort(function (a, b) {
      return a.priority.localeCompare(b.priority) || a.createdAt - b.createdAt;
    });

    sorted.forEach(function (t) {
      var li = el('li', 'ticket ' + t.priority + (t.status === 'Resolved' ? ' Resolved' : ''));

      var row = el('div', 'row');
      row.appendChild(el('span', 'badge ' + t.priority, t.priority));
      row.appendChild(el('strong', '', '#' + t.id + ' ' + t.requester));
      if (isOverdue(t, now)) row.appendChild(el('span', 'overdue', 'Overdue'));
      li.appendChild(row);

      li.appendChild(el('p', 'issue', t.issue));

      var due = new Date(t.createdAt + TARGET_HOURS[t.priority] * HOUR);
      li.appendChild(el('div', 'meta',
        'Impact ' + LEVELS[t.impact] + ' · Urgency ' + LEVELS[t.urgency] +
        ' · Response target ' + TARGET_HOURS[t.priority] + ' h (' +
        due.toLocaleString() + ') · Opened ' + new Date(t.createdAt).toLocaleString()));

      var statusRow = el('div', 'row');
      var label = el('label', '', 'Status ');
      var select = el('select');
      select.setAttribute('aria-label', 'Status of ticket ' + t.id);
      STATUSES.forEach(function (s) {
        var o = el('option', '', s);
        o.value = s;
        if (s === t.status) o.selected = true;
        select.appendChild(o);
      });
      select.addEventListener('change', function () {
        t.status = select.value;
        save(tickets);
        render();
      });
      label.appendChild(select);
      statusRow.appendChild(label);
      li.appendChild(statusRow);

      list.appendChild(li);
    });

    if (!sorted.length) list.appendChild(el('li', 'meta', 'No tickets.'));
  }

  function updatePreview() {
    var p = priorityFor(document.getElementById('impact').value, document.getElementById('urgency').value);
    document.getElementById('preview').textContent = p + ' (response target ' + TARGET_HOURS[p] + ' h)';
  }

  document.getElementById('impact').addEventListener('change', updatePreview);
  document.getElementById('urgency').addEventListener('change', updatePreview);

  document.getElementById('ticket-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var requester = document.getElementById('requester').value.trim();
    var issue = document.getElementById('issue').value.trim();
    if (!requester || !issue) return;
    var impact = Number(document.getElementById('impact').value);
    var urgency = Number(document.getElementById('urgency').value);
    var nextId = tickets.reduce(function (m, t) { return Math.max(m, t.id); }, 0) + 1;
    tickets.push({
      id: nextId, requester: requester, issue: issue, impact: impact, urgency: urgency,
      priority: priorityFor(impact, urgency), status: 'New', createdAt: Date.now()
    });
    save(tickets);
    e.target.reset();
    updatePreview();
    render();
  });

  document.getElementById('reset').addEventListener('click', function () {
    tickets = Store.seed();
    save(tickets);
    render();
  });

  updatePreview();
  render();
  setInterval(render, 30000); // keep Overdue labels current
})();
