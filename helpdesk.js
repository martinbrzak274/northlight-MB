(function () {
  'use strict';

  var STORAGE_KEY = 'northlight-helpdesk-tickets';
  var HOUR = 3600 * 1000;
  var TARGET_HOURS = { P1: 1, P2: 4, P3: 24 };
  var STATUSES = ['New', 'In progress', 'Resolved'];
  var LEVELS = { 3: 'High', 2: 'Medium', 1: 'Low' };

  // Impact and urgency (High=3, Medium=2, Low=1): sum 5-6 = P1, 4 = P2, 2-3 = P3.
  function priorityFor(impact, urgency) {
    var sum = Number(impact) + Number(urgency);
    return sum >= 5 ? 'P1' : sum === 4 ? 'P2' : 'P3';
  }

  function isOverdue(t, now) {
    return t.status === 'New' && now > t.createdAt + TARGET_HOURS[t.priority] * HOUR;
  }

  function seed() {
    var now = Date.now();
    function t(id, requester, issue, impact, urgency, status, hoursAgo) {
      return {
        id: id, requester: requester, issue: issue, impact: impact, urgency: urgency,
        priority: priorityFor(impact, urgency), status: status,
        createdAt: now - hoursAgo * HOUR
      };
    }
    return [
      t(1, 'Alex Example', 'Shared design drive is unreachable for the whole studio.', 3, 3, 'New', 2.5),
      t(2, 'Sam Sample', 'Printer on floor 2 jams on A3 paper.', 1, 2, 'New', 6),
      t(3, 'Jordan Demo', 'Figma licence expired for one designer.', 2, 3, 'In progress', 3),
      t(4, 'Casey Test', 'Wi-Fi drops in the small meeting room.', 2, 2, 'New', 1),
      t(5, 'Riley Placeholder', 'Request for a second monitor.', 1, 1, 'Resolved', 30),
      t(6, 'Taylor Fake', 'Slow laptop when exporting large files.', 2, 1, 'New', 5)
    ];
  }

  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* fall through to seed */ }
    var data = seed();
    save(data);
    return data;
  }

  function save(data) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e) { /* ignore */ }
  }

  var tickets = load();

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
    tickets = seed();
    save(tickets);
    render();
  });

  updatePreview();
  render();
  setInterval(render, 30000); // keep Overdue labels current
})();
