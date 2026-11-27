/*
 * Settings page: shows the version (health.json), the settings (config.js) and the records saved in this
 * browser, and exports every localStorage record as one JSON file. Fake data only.
 * Nothing leaves the browser: the export is a file download made on this computer, and the only thing
 * fetched is health.json.
 *
 * Layout: core functions (testable in Node) -> UI at the bottom (browser only).
 */
(function () {
  'use strict';

  var isNode = typeof module !== 'undefined' && module.exports;
  var Config = isNode ? require('./config.js') : globalThis.NorthlightConfig;
  var encoder = new TextEncoder();

  // ---------- health.json ----------
  function validDate(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    var d = new Date(s + 'T00:00:00Z');
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; // rejects 2026-02-31
  }
  function validHealth(h) {
    return !!h && typeof h === 'object' && typeof h.name === 'string' && h.name.trim() !== '' &&
      typeof h.version === 'string' && /^\d+\.\d+\.\d+$/.test(h.version) && validDate(h.buildDate);
  }

  // fetchFn: fetch, or null. Returns { ok: true, info: { name, version, buildDate } } or { ok: false, message }.
  async function loadHealth(fetchFn) {
    if (typeof fetchFn !== 'function') return { ok: false, message: 'health.json is not available here.' };
    try {
      var res = await fetchFn(Config.healthUrl, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var h = JSON.parse(await res.text());
      if (!validHealth(h)) return { ok: false, message: 'health.json does not have a name, a version like 1.2.3 and a build date like 2026-11-27.' };
      return { ok: true, info: { name: h.name, version: h.version, buildDate: h.buildDate } };
    } catch (e) {
      return { ok: false, message: 'health.json could not be read (' + ((e && e.message) || e) + '). This is normal for a page opened from disk.' };
    }
  }

  // ---------- reading every record ----------
  // One entry per localStorage key, sorted by key. Objects and lists are stored parsed ("json");
  // everything else is kept as the exact text ("text"), so a value such as "007" is never changed to 7.
  function collectRecords(storage, prefix) {
    var keys = [];
    for (var i = 0; i < storage.length; i++) {
      var k = storage.key(i);
      if (k !== null) keys.push(k);
    }
    keys.sort();
    return keys.map(function (key) {
      var owned = key.indexOf(prefix) === 0;
      var raw = null;
      try { raw = storage.getItem(key); } catch (e) { raw = null; }
      if (raw === null) return { key: key, owned: owned, valueType: 'unreadable', bytes: 0, value: null };
      var value = raw, type = 'text';
      try {
        var parsed = JSON.parse(raw);
        if (parsed !== null && typeof parsed === 'object') { value = parsed; type = 'json'; }
      } catch (e) { /* not JSON: keep the text */ }
      return { key: key, owned: owned, valueType: type, bytes: encoder.encode(raw).length, value: value };
    });
  }

  function pad(n) { return String(n).padStart(2, '0'); }
  // UTC, so the name does not depend on the time zone: northlight-export-20261127-120000.json
  function exportFileName(cfg, now) {
    var d = new Date(now);
    return cfg.export.filePrefix + '-' + d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) +
      '-' + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + '.json';
  }

  // Builds the export. meta: { name, version, buildDate } from health.json, or null.
  // Returns { ok: true, data, json, fileName, count } or { ok: false, message }.
  function exportAll(storage, cfg, meta, now) {
    var records;
    try {
      if (!storage) throw new Error('no storage');
      records = collectRecords(storage, cfg.storagePrefix);
    } catch (e) {
      return { ok: false, message: 'The browser would not let this page read its storage, so nothing was exported.' };
    }
    var data = {
      format: cfg.export.filePrefix,
      formatVersion: cfg.export.formatVersion,
      exportedAt: new Date(now).toISOString(),
      site: cfg.appName,
      app: meta || null,
      count: records.length,
      records: records
    };
    return { ok: true, data: data, json: JSON.stringify(data, null, 2), fileName: exportFileName(cfg, now), count: records.length };
  }

  function flattenConfig(obj, prefix) {
    var rows = [];
    Object.keys(obj).forEach(function (k) {
      var v = obj[k], name = prefix ? prefix + '.' + k : k;
      if (v !== null && typeof v === 'object') rows = rows.concat(flattenConfig(v, name));
      else rows.push([name, String(v)]);
    });
    return rows;
  }

  function sizeText(bytes) {
    return bytes < 1024 ? bytes + ' B' : (bytes / 1024).toFixed(1) + ' KB';
  }

  var api = {
    validHealth: validHealth, loadHealth: loadHealth, collectRecords: collectRecords, exportAll: exportAll,
    exportFileName: exportFileName, flattenConfig: flattenConfig, sizeText: sizeText
  };
  if (isNode) module.exports = api;

  // ---------- UI (browser only) ----------
  function initUI() {
    var $ = function (id) { return document.getElementById(id); };
    var storage = null;
    try {
      storage = globalThis.localStorage;
      storage.getItem(Config.storagePrefix); // throws if the browser blocks storage
    } catch (e) { storage = null; }

    var statusEl = $('status');
    function say(msg, bad) { statusEl.textContent = msg || ''; statusEl.className = bad ? 'bad' : 'good'; }
    function el(tag, text, cls) {
      var n = document.createElement(tag);
      if (text !== undefined) n.textContent = text;
      if (cls) n.className = cls;
      return n;
    }
    function row(cells) {
      var tr = el('tr');
      cells.forEach(function (c) { tr.appendChild(el('td', c)); });
      return tr;
    }

    // About: from health.json
    var healthReady = loadHealth(typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    healthReady.then(function (h) {
      if (h.ok) {
        $('about-name').textContent = h.info.name;
        $('about-version').textContent = h.info.version;
        $('about-build').textContent = h.info.buildDate;
        $('about-note').textContent = 'Read from ' + Config.healthUrl + '.';
      } else {
        $('about-name').textContent = Config.appName;
        $('about-version').textContent = 'unknown';
        $('about-build').textContent = 'unknown';
        $('about-note').textContent = h.message;
      }
    });

    // Settings: from config.js
    var cfgBody = $('config-table');
    cfgBody.textContent = '';
    flattenConfig(Config, '').forEach(function (r) { cfgBody.appendChild(row(r)); });

    // Records in this browser
    function renderRecords() {
      var body = $('records-table');
      body.textContent = '';
      if (!storage) {
        $('records-count').textContent = 'The browser is blocking local storage, so no records can be read.';
        return;
      }
      var recs = collectRecords(storage, Config.storagePrefix);
      var mine = recs.filter(function (r) { return r.owned; }).length;
      $('records-count').textContent = recs.length + (recs.length === 1 ? ' record' : ' records') + ' in this browser: ' +
        mine + ' from Northlight, ' + (recs.length - mine) + ' from other pages.';
      if (!recs.length) body.appendChild(row(['(nothing saved yet)', '', '']));
      recs.forEach(function (r) { body.appendChild(row([r.key, r.owned ? 'Northlight' : 'Other', sizeText(r.bytes)])); });
    }

    function download(json, fileName) {
      var blob = new Blob([json], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }

    $('export-all').addEventListener('click', async function () {
      var h = await healthReady;
      var r = exportAll(storage, Config, h.ok ? h.info : null, Date.now());
      if (!r.ok) { say(r.message, true); return; }
      download(r.json, r.fileName);
      say('Export started: ' + r.count + (r.count === 1 ? ' record' : ' records') + ' in ' + r.fileName + ' (' + sizeText(r.json.length) +
        '). Look in your Downloads folder.');
    });

    renderRecords();
    if (typeof globalThis.addEventListener === 'function') globalThis.addEventListener('storage', renderRecords);
  }

  if (typeof document !== 'undefined' && document.getElementById('export-all')) initUI();
})();
