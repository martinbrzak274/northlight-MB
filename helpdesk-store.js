/*
 * Help desk ticket storage, shared by helpdesk.html and the contact form on index.html.
 * Fake data only. Works in the browser (global HelpdeskStore) and in Node (require) for tests.
 */
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

  // Overdue means still New after the response target. Moving to In progress counts as responding.
  function isOverdue(t, now) {
    return t.status === 'New' && now > t.createdAt + TARGET_HOURS[t.priority] * HOUR;
  }

  function seed(now) {
    now = now == null ? Date.now() : now;
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

  function isLevel(n) { return n === 1 || n === 2 || n === 3; }

  function valid(list) {
    return Array.isArray(list) && list.every(function (t) {
      return t && typeof t === 'object' && Number.isInteger(t.id) &&
        typeof t.requester === 'string' && typeof t.issue === 'string' &&
        isLevel(t.impact) && isLevel(t.urgency) &&
        Object.prototype.hasOwnProperty.call(TARGET_HOURS, t.priority) &&
        STATUSES.indexOf(t.status) >= 0 && Number.isFinite(t.createdAt);
    });
  }

  // Returns true if the data was stored, false if the browser refused.
  function save(storage, tickets) {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(tickets));
      return true;
    } catch (e) {
      return false;
    }
  }

  // Reads the tickets. If nothing usable is stored yet, saves and returns the fake demo tickets.
  function load(storage, now) {
    try {
      var raw = storage.getItem(STORAGE_KEY);
      if (raw) {
        var data = JSON.parse(raw);
        if (valid(data)) return data;
      }
    } catch (e) { /* fall through to seed */ }
    var fresh = seed(now);
    save(storage, fresh);
    return fresh;
  }

  // input: { requester, issue, impact, urgency }. Returns { ok: true, ticket } or { ok: false }.
  function createTicket(storage, input, now) {
    try {
      var t = now == null ? Date.now() : now;
      var tickets = load(storage, t);
      var id = tickets.reduce(function (m, x) { return Math.max(m, x.id); }, 0) + 1;
      var ticket = {
        id: id, requester: input.requester, issue: input.issue,
        impact: input.impact, urgency: input.urgency,
        priority: priorityFor(input.impact, input.urgency), status: 'New', createdAt: t
      };
      tickets.push(ticket);
      if (!save(storage, tickets)) return { ok: false };
      return { ok: true, ticket: ticket };
    } catch (e) {
      return { ok: false };
    }
  }

  // Impact and urgency that give each priority, used when a rule sets the priority directly.
  var LEVEL_FOR_PRIORITY = { P1: 3, P2: 2, P3: 1 };

  // Sets a ticket to P1, P2 or P3. Returns { ok: true, ticket, previous } or { ok: false, error }.
  function setPriority(storage, id, priority, now) {
    try {
      if (!Object.prototype.hasOwnProperty.call(LEVEL_FOR_PRIORITY, priority)) return { ok: false, error: 'priority' };
      var tickets = load(storage, now == null ? Date.now() : now);
      var ticket = tickets.find(function (x) { return x.id === id; });
      if (!ticket) return { ok: false, error: 'missing' };
      var previous = ticket.priority;
      ticket.impact = LEVEL_FOR_PRIORITY[priority];
      ticket.urgency = LEVEL_FOR_PRIORITY[priority];
      ticket.priority = priorityFor(ticket.impact, ticket.urgency);
      if (!save(storage, tickets)) return { ok: false, error: 'storage' };
      return { ok: true, ticket: ticket, previous: previous };
    } catch (e) {
      return { ok: false, error: 'storage' };
    }
  }

  var api = {
    STORAGE_KEY: STORAGE_KEY, HOUR: HOUR, TARGET_HOURS: TARGET_HOURS, STATUSES: STATUSES, LEVELS: LEVELS,
    priorityFor: priorityFor, isOverdue: isOverdue, seed: seed, valid: valid,
    load: load, save: save, createTicket: createTicket, setPriority: setPriority
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else globalThis.HelpdeskStore = api;
})();
