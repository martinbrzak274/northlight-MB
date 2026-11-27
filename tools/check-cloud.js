#!/usr/bin/env node
'use strict';
// Checks northlight.cloud.json: every resource needs the tags owner, env and cost-center, and every name must
// follow the Azure limits and the naming convention below. Prints PASS or FAIL for each check and exits with 1
// if anything fails. Read-only: it never changes a file and never contacts any cloud.
// Usage: node tools/check-cloud.js [path-to-file]   (default: northlight.cloud.json in the repository root)
const fs = require('node:fs');
const path = require('node:path');

// ---------- the rules (change them here) ----------
const REQUIRED_TAGS = ['owner', 'env', 'cost-center'];
const ENVIRONMENTS = ['dev', 'test', 'prod'];
const REGION_CODES = { westeurope: 'we', northeurope: 'ne', germanywestcentral: 'gwc' };

// Limits follow Azure's naming rules for each resource type. The convention is the shape we choose on top:
//   resourceGroup  rg-<project>-<env>-<region>        optionally followed by -<suffix>
//   webApp         app-<project>-<env>-<region>       optionally followed by -<suffix>
//   storageAccount st<project><env><region>           optionally followed by up to 6 letters or digits
const TYPES = {
  resourceGroup: {
    min: 1, max: 90, allowed: /^[A-Za-z0-9_().-]+$/,
    allowedText: 'letters, digits, underscores, hyphens, periods and parentheses',
    edge: [/\.$/, 'must not end with a period']
  },
  webApp: {
    min: 2, max: 60, allowed: /^[A-Za-z0-9-]+$/,
    allowedText: 'letters, digits and hyphens',
    edge: [/^-|-$/, 'must not start or end with a hyphen']
  },
  storageAccount: {
    min: 3, max: 24, allowed: /^[a-z0-9]+$/,
    allowedText: 'lowercase letters and digits only (no hyphens or capitals)'
  }
};

function isObject(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
const show = (v) => JSON.stringify(v);
const norm = (s) => String(s).toLowerCase().replace(/[\s_-]/g, '');

function conventionFor(type, doc) {
  const region = REGION_CODES[doc.location];
  if (type === 'storageAccount') {
    const base = 'st' + doc.project + doc.environment + region;
    return { example: base, regex: new RegExp('^' + base + '[a-z0-9]{0,6}$') };
  }
  const base = (type === 'webApp' ? 'app' : 'rg') + '-' + doc.project + '-' + doc.environment + '-' + region;
  return { example: base, regex: new RegExp('^' + base + '(-[a-z0-9]{1,10})?$') };
}

function nameProblems(type, name, doc, docOk) {
  if (typeof name !== 'string' || name === '') return ['has no name'];
  const rule = TYPES[type];
  const problems = [];
  if (name.length < rule.min || name.length > rule.max) {
    problems.push('name ' + show(name) + ' must be ' + rule.min + ' to ' + rule.max + ' characters long (it has ' + name.length + ')');
  }
  if (!rule.allowed.test(name)) problems.push('name ' + show(name) + ' may only use ' + rule.allowedText);
  else if (rule.edge && rule.edge[0].test(name)) problems.push('name ' + show(name) + ' ' + rule.edge[1]);
  if (!problems.length && docOk) {
    const c = conventionFor(type, doc);
    if (!c.regex.test(name)) problems.push('name ' + show(name) + ' does not follow the convention (expected something like ' + show(c.example) + ')');
  }
  return problems;
}

function tagProblems(tags, doc, envOk) {
  if (!isObject(tags)) return ['has no "tags" object (required tags: ' + REQUIRED_TAGS.join(', ') + ')'];
  const problems = [];
  for (const key of REQUIRED_TAGS) {
    if (Object.prototype.hasOwnProperty.call(tags, key)) {
      if (typeof tags[key] !== 'string' || !tags[key].trim()) problems.push('tag ' + show(key) + ' is empty');
    } else {
      const near = Object.keys(tags).find((k) => norm(k) === norm(key));
      problems.push('tag ' + show(key) + ' is missing' + (near ? ' (found ' + show(near) + ': tag names must be spelled exactly)' : ''));
    }
  }
  if (typeof tags.env === 'string' && tags.env.trim()) {
    if (ENVIRONMENTS.indexOf(tags.env) < 0) problems.push('tag "env" must be one of ' + ENVIRONMENTS.join(', ') + ' (found ' + show(tags.env) + ')');
    else if (envOk && tags.env !== doc.environment) problems.push('tag "env" is ' + show(tags.env) + ' but the environment of this description is ' + show(doc.environment));
  }
  return problems;
}

// Returns { results: [{ status: 'PASS' | 'FAIL', subject, message }], failures }.
function checkCloud(doc) {
  const results = [];
  let failures = 0;
  const pass = (subject, message) => results.push({ status: 'PASS', subject, message });
  const fail = (subject, message) => { failures++; results.push({ status: 'FAIL', subject, message }); };

  if (!isObject(doc)) {
    fail('file', 'must contain one JSON object');
    return { results, failures };
  }

  // The description as a whole
  const before = failures;
  if (doc.schemaVersion !== 1) fail('file', '"schemaVersion" must be 1');
  const projectOk = typeof doc.project === 'string' && /^[a-z][a-z0-9]{1,15}$/.test(doc.project);
  if (!projectOk) fail('file', '"project" must be 2 to 16 lowercase letters or digits, starting with a letter (it is used in every name)');
  const envOk = ENVIRONMENTS.indexOf(doc.environment) >= 0;
  if (!envOk) fail('file', '"environment" must be one of ' + ENVIRONMENTS.join(', '));
  const locationOk = typeof doc.location === 'string' && Object.prototype.hasOwnProperty.call(REGION_CODES, doc.location);
  if (!locationOk) fail('file', '"location" must be one of ' + Object.keys(REGION_CODES).join(', '));
  const resourcesOk = Array.isArray(doc.resources) && doc.resources.length > 0;
  if (!resourcesOk) fail('file', '"resources" must be a list with at least one resource');
  if (failures === before) pass('file', 'schemaVersion, project, environment and location are ok');
  if (!resourcesOk) return { results, failures };
  const docOk = projectOk && envOk && locationOk;

  // Resource groups first, so other resources can be checked against them
  const groupNames = new Set(doc.resources.filter((r) => isObject(r) && r.type === 'resourceGroup' && typeof r.name === 'string').map((r) => r.name));
  const seen = new Set();
  const typesSeen = new Set();

  doc.resources.forEach((r, i) => {
    if (!isObject(r)) { fail('resource #' + (i + 1), 'must be an object'); return; }
    const subject = (typeof r.type === 'string' ? r.type : 'resource #' + (i + 1)) + ' ' + (typeof r.name === 'string' ? show(r.name) : '(no name)');
    if (!Object.prototype.hasOwnProperty.call(TYPES, r.type)) {
      fail(subject, 'has an unknown type ' + show(r.type) + ' (known: ' + Object.keys(TYPES).join(', ') + ')');
      return;
    }
    typesSeen.add(r.type);
    const problems = nameProblems(r.type, r.name, doc, docOk);
    if (typeof r.name === 'string') {
      const key = r.name.toLowerCase();
      if (seen.has(key)) problems.push('name ' + show(r.name) + ' is used by more than one resource');
      seen.add(key);
    }
    if (r.type !== 'resourceGroup') {
      if (typeof r.resourceGroup !== 'string' || !r.resourceGroup) problems.push('has no "resourceGroup"');
      else if (!groupNames.has(r.resourceGroup)) problems.push('resourceGroup ' + show(r.resourceGroup) + ' is not described in this file');
    }
    problems.push(...tagProblems(r.tags, doc, envOk));
    if (!problems.length) pass(subject, 'name and tags are ok');
    else problems.forEach((p) => fail(subject, p));
  });

  for (const type of Object.keys(TYPES)) {
    if (!typesSeen.has(type)) fail('file', 'the description has no ' + type);
  }
  return { results, failures };
}

function format(r) { return r.status.padEnd(4) + '  ' + r.subject + ': ' + r.message; }

function main(argv) {
  const file = argv[2] ? path.resolve(argv[2]) : path.join(__dirname, '..', 'northlight.cloud.json');
  const label = path.basename(file);
  const inActions = process.env.GITHUB_ACTIONS === 'true';
  const out = [];
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    out.push({ status: 'FAIL', subject: 'file', message: 'cannot read ' + label + ' (' + (e.code || e.message) + ')' });
  }
  let doc;
  if (text !== undefined) {
    try { doc = JSON.parse(text); } catch (e) {
      out.push({ status: 'FAIL', subject: 'file', message: label + ' is not valid JSON (' + e.message + ')' });
    }
  }
  if (doc !== undefined) out.push(...checkCloud(doc).results);

  console.log('Cloud description check: ' + label);
  out.forEach((r) => console.log(format(r)));
  const failed = out.filter((r) => r.status === 'FAIL');
  if (inActions) {
    failed.forEach((r) => console.log('::error title=Cloud description::' + r.subject.replace(/[\r\n]/g, ' ') + ': ' + r.message.replace(/[\r\n]/g, ' ')));
  }
  console.log('');
  console.log(failed.length ? failed.length + (failed.length === 1 ? ' problem' : ' problems') + ' found. Fix them before deploying.' : 'All checks passed.');
  return failed.length ? 1 : 0;
}

module.exports = { checkCloud, REQUIRED_TAGS, ENVIRONMENTS, REGION_CODES, TYPES };

if (require.main === module) process.exitCode = main(process.argv);
