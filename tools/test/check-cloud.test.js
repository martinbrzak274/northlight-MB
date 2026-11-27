'use strict';
// Run with: node tools/test/check-cloud.test.js
// Tests tools/check-cloud.js with fake descriptions, the real northlight.cloud.json, and the workflow.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { checkCloud } = require('../check-cloud.js');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'tools', 'check-cloud.js');
const real = JSON.parse(fs.readFileSync(path.join(ROOT, 'northlight.cloud.json'), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));

const find = (doc, type) => doc.resources.find((r) => r.type === type);
const failures = (doc) => checkCloud(doc).results.filter((r) => r.status === 'FAIL');
const messages = (doc) => failures(doc).map((r) => r.subject + ': ' + r.message);
const only = (doc, re) => {
  const m = messages(doc);
  assert.ok(m.length >= 1, 'expected a failure, got none');
  assert.ok(m.some((x) => re.test(x)), 'no failure matched ' + re + '\n' + m.join('\n'));
  return m;
};

// ---------- the real file ----------

test('the real northlight.cloud.json passes', () => {
  const r = checkCloud(real);
  assert.equal(r.failures, 0, messages(real).join('\n'));
  assert.ok(r.results.every((x) => x.status === 'PASS'));
});

test('the real file describes a resource group, a web app and storage, each with the three tags', () => {
  assert.deepEqual(real.resources.map((r) => r.type), ['resourceGroup', 'webApp', 'storageAccount']);
  for (const r of real.resources) {
    assert.deepEqual(Object.keys(r.tags).sort(), ['cost-center', 'env', 'owner'], r.name);
  }
});

// ---------- tags ----------

test('a missing tag is an error, for each required tag and each resource', () => {
  for (const tag of ['owner', 'env', 'cost-center']) {
    for (const type of ['resourceGroup', 'webApp', 'storageAccount']) {
      const doc = clone(real);
      delete find(doc, type).tags[tag];
      const m = only(doc, new RegExp('tag "' + tag + '" is missing'));
      assert.ok(m.some((x) => x.startsWith(type + ' ')), type + ' / ' + tag);
      assert.equal(m.length, 1, 'only that one problem is reported');
    }
  }
});

test('an empty or blank tag value is an error', () => {
  for (const bad of ['', '   ']) {
    const doc = clone(real);
    find(doc, 'webApp').tags.owner = bad;
    only(doc, /tag "owner" is empty/);
  }
  const doc = clone(real);
  find(doc, 'webApp').tags['cost-center'] = 1042;
  only(doc, /tag "cost-center" is empty/);
});

test('a tag spelled differently is reported as missing, with the spelling it found', () => {
  const doc = clone(real);
  const tags = find(doc, 'storageAccount').tags;
  tags['Cost-Center'] = tags['cost-center'];
  delete tags['cost-center'];
  const m = only(doc, /tag "cost-center" is missing \(found "Cost-Center"/);
  assert.equal(m.length, 1);
  const doc2 = clone(real);
  const t2 = find(doc2, 'webApp').tags;
  t2.cost_center = t2['cost-center'];
  delete t2['cost-center'];
  only(doc2, /found "cost_center"/);
});

test('no tags object at all is an error that lists the required tags', () => {
  const doc = clone(real);
  delete find(doc, 'resourceGroup').tags;
  only(doc, /has no "tags" object \(required tags: owner, env, cost-center\)/);
});

test('the env tag must be a known environment that matches the description', () => {
  const doc = clone(real);
  find(doc, 'webApp').tags.env = 'production';
  only(doc, /tag "env" must be one of dev, test, prod \(found "production"\)/);
  const doc2 = clone(real);
  find(doc2, 'webApp').tags.env = 'dev';
  only(doc2, /tag "env" is "dev" but the environment of this description is "prod"/);
});

test('every problem in one resource is reported, not just the first', () => {
  const doc = clone(real);
  const st = find(doc, 'storageAccount');
  delete st.tags.owner;
  delete st.tags.env;
  st.name = 'Northlight-Storage';
  const m = messages(doc).filter((x) => x.startsWith('storageAccount'));
  assert.ok(m.length >= 3, m.join('\n'));
});

// ---------- names ----------

test('storage account names: length, characters and convention', () => {
  const cases = [
    ['too short', 'st', /must be 3 to 24 characters long \(it has 2\)/],
    ['too long', 'stnorthlightprodwe' + 'x'.repeat(7), /3 to 24 characters long \(it has 25\)/],
    ['capitals', 'StNorthlightProdWe', /lowercase letters and digits only/],
    ['hyphens', 'st-northlight-prod-we', /lowercase letters and digits only/],
    ['wrong prefix', 'sa' + 'northlightprodwe', /does not follow the convention/],
    ['wrong env segment', 'stnorthlightdevwe', /does not follow the convention/],
    ['wrong region', 'stnorthlightprodne', /does not follow the convention/],
    ['suffix too long (the 24 character limit stops it first)', 'stnorthlightprodwe1234567', /3 to 24 characters long \(it has 25\)/]
  ];
  for (const [name, bad, re] of cases) {
    const doc = clone(real);
    find(doc, 'storageAccount').name = bad;
    only(doc, re);
    assert.ok(failures(doc).every((f) => f.subject.startsWith('storageAccount')), name);
  }
});

test('web app names: length, characters, hyphens at the edges and convention', () => {
  const cases = [
    ['too short', 'a', /2 to 60 characters/],
    ['too long', 'app-northlight-prod-we-' + 'x'.repeat(40), /2 to 60 characters/],
    ['underscore', 'app_northlight_prod_we', /letters, digits and hyphens/],
    ['starts with hyphen', '-app-northlight-prod-we', /must not start or end with a hyphen/],
    ['ends with hyphen', 'app-northlight-prod-we-', /must not start or end with a hyphen/],
    ['wrong prefix', 'web-northlight-prod-we', /does not follow the convention/],
    ['typo in project', 'app-northlite-prod-we', /does not follow the convention/]
  ];
  for (const [, bad, re] of cases) {
    const doc = clone(real);
    find(doc, 'webApp').name = bad;
    only(doc, re);
  }
});

test('resource group names: length, characters, a final period and convention', () => {
  const cases = [
    ['too long', 'rg-northlight-prod-we-' + 'x'.repeat(80), /1 to 90 characters/],
    ['space', 'rg northlight prod we', /may only use letters/],
    ['final period', 'rg-northlight-prod-we.', /must not end with a period/],
    ['wrong prefix', 'group-northlight-prod-we', /does not follow the convention/]
  ];
  for (const [, bad, re] of cases) {
    const doc = clone(real);
    const group = find(doc, 'resourceGroup');
    find(doc, 'webApp').resourceGroup = bad;
    find(doc, 'storageAccount').resourceGroup = bad;
    group.name = bad;
    only(doc, re);
  }
});

test('names with an allowed suffix pass', () => {
  const doc = clone(real);
  find(doc, 'webApp').name = 'app-northlight-prod-we-api';
  find(doc, 'storageAccount').name = 'stnorthlightprodwe01';
  assert.equal(checkCloud(doc).failures, 0, messages(doc).join('\n'));
});

test('a missing or non-text name is an error', () => {
  const doc = clone(real);
  delete find(doc, 'webApp').name;
  only(doc, /has no name/);
  const doc2 = clone(real);
  find(doc2, 'webApp').name = 42;
  only(doc2, /has no name/);
});

test('two resources must not share a name, even in different capitals', () => {
  const doc = clone(real);
  doc.resources.push(Object.assign(clone(find(doc, 'webApp')), { name: 'APP-northlight-prod-we' }));
  only(doc, /is used by more than one resource/);
});

// ---------- structure ----------

test('a resource must point at a resource group described in the file', () => {
  const doc = clone(real);
  find(doc, 'webApp').resourceGroup = 'rg-northlight-prod-ne';
  only(doc, /resourceGroup "rg-northlight-prod-ne" is not described/);
  const doc2 = clone(real);
  delete find(doc2, 'storageAccount').resourceGroup;
  only(doc2, /has no "resourceGroup"/);
});

test('each of the three resource types must be present', () => {
  for (const type of ['resourceGroup', 'webApp', 'storageAccount']) {
    const doc = clone(real);
    doc.resources = doc.resources.filter((r) => r.type !== type);
    only(doc, new RegExp('the description has no ' + type));
  }
});

test('an unknown resource type is an error', () => {
  const doc = clone(real);
  doc.resources.push({ type: 'database', name: 'db1', tags: {} });
  only(doc, /unknown type "database"/);
});

test('project, environment, location and schema version are checked', () => {
  const cases = [
    ['project', (d) => { d.project = 'North-Light'; }, /"project" must be/],
    ['project too short', (d) => { d.project = 'n'; }, /"project" must be/],
    ['environment', (d) => { d.environment = 'staging'; }, /"environment" must be one of/],
    ['location', (d) => { d.location = 'mars'; }, /"location" must be one of/],
    ['schemaVersion', (d) => { d.schemaVersion = 2; }, /"schemaVersion" must be 1/],
    ['no resources', (d) => { d.resources = []; }, /"resources" must be a list/]
  ];
  for (const [, mutate, re] of cases) {
    const doc = clone(real);
    mutate(doc);
    only(doc, re);
  }
});

test('not an object is an error, and junk never crashes the checker', () => {
  for (const junk of [null, 'x', 5, [], { resources: 'no' }, { resources: [null, 7, 'x'] }]) {
    assert.doesNotThrow(() => checkCloud(junk));
    assert.ok(checkCloud(junk).failures > 0);
  }
});

// ---------- the command line ----------

function run(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: Object.assign({}, process.env, { GITHUB_ACTIONS: '' }, env) });
}
function tmpFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-check-'));
  const file = path.join(dir, 'cloud.json');
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

test('exit code 0 and PASS lines for the real file', () => {
  const r = run([]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /PASS {2}resourceGroup "rg-northlight-prod-we"/);
  assert.match(r.stdout, /All checks passed\./);
  assert.ok(!/FAIL/.test(r.stdout));
});

test('exit code 1 and a FAIL line for a missing tag', () => {
  const doc = clone(real);
  delete find(doc, 'webApp').tags.owner;
  const r = run([tmpFile(doc)]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL {2}webApp "app-northlight-prod-we": tag "owner" is missing/);
  assert.match(r.stdout, /1 problem found/);
});

test('exit code 1 and a FAIL line for a bad name', () => {
  const doc = clone(real);
  find(doc, 'storageAccount').name = 'Northlight_Storage';
  const r = run([tmpFile(doc)]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL {2}storageAccount "Northlight_Storage"/);
});

test('exit code 1 for a file that is missing or is not JSON', () => {
  const missing = run([path.join(os.tmpdir(), 'does-not-exist-' + Date.now() + '.json')]);
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /FAIL {2}file: cannot read/);
  const broken = run([tmpFile('{ not json')]);
  assert.equal(broken.status, 1);
  assert.match(broken.stdout, /is not valid JSON/);
});

test('inside GitHub Actions each problem is also written as an error annotation', () => {
  const doc = clone(real);
  delete find(doc, 'resourceGroup').tags['cost-center'];
  const r = run([tmpFile(doc)], { GITHUB_ACTIONS: 'true' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^::error title=Cloud description::resourceGroup "rg-northlight-prod-we": tag "cost-center" is missing$/m);
  const quiet = run([tmpFile(doc)]);
  assert.ok(!/::error/.test(quiet.stdout), 'no annotations outside Actions');
});

test('the checker only reads: it does not change the file it checks', () => {
  const file = tmpFile(real);
  const before = fs.readFileSync(file, 'utf8');
  run([file]);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  const code = fs.readFileSync(SCRIPT, 'utf8');
  assert.ok(!/writeFile|appendFile|unlink|rmSync|child_process|https?\.|fetch\(/.test(code), 'no writing, no processes, no network');
});

// ---------- the workflow ----------

const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'deploy.yml'), 'utf8');
const section = (name) => {
  const m = new RegExp('^  ' + name + ':\\n([\\s\\S]*?)(?=^  \\S|(?![\\s\\S]))', 'm').exec(workflow);
  assert.ok(m, 'no job named ' + name);
  return m[1];
};

test('the workflow runs the checker in a job that the deploy job waits for', () => {
  const check = section('check');
  const deploy = section('deploy');
  assert.match(check, /run: node tools\/check-cloud\.js/);
  assert.match(deploy, /^ {4}needs: \[check, test\]$/m, 'deploy needs both check and test');
  assert.ok(!/deploy-pages/.test(check), 'the check job does not deploy');
  assert.ok(workflow.indexOf('  check:') < workflow.indexOf('  deploy:'));
});

test('the workflow runs the browser tests in a job that the deploy job also waits for', () => {
  const testJob = section('test');
  assert.match(testJob, /run: npm ci$/m, 'installs exactly what package-lock.json says');
  assert.match(testJob, /run: npx playwright install --with-deps chromium$/m);
  assert.match(testJob, /run: npx playwright test$/m);
  assert.match(testJob, /cache: npm/);
  assert.ok(!/deploy-pages|upload-pages-artifact/.test(testJob), 'the test job does not deploy');
  assert.ok(testJob.indexOf('npm ci') < testJob.indexOf('playwright install'));
  assert.ok(testJob.indexOf('playwright install') < testJob.indexOf('playwright test'));
  // the report is kept even when the tests fail, which is when it is needed
  assert.match(testJob, /if: \$\{\{ !cancelled\(\) \}\}\n\s+uses: actions\/upload-artifact@v4/);
  assert.match(testJob, /path: playwright-report\//);
  assert.ok(workflow.indexOf('  test:') < workflow.indexOf('  deploy:'));
});

test('the workflow does not point the browser tests at an outside site', () => {
  assert.ok(!/SITE_URL/.test(workflow), 'in CI the tests use the local server');
  assert.ok(fs.existsSync(path.join(ROOT, 'package-lock.json')), 'npm ci needs the lock file');
});

test('only the deploy job gets the Pages permissions', () => {
  assert.ok(!/pages: write|id-token: write/.test(section('check')));
  assert.ok(!/pages: write|id-token: write/.test(section('test')));
  assert.match(section('deploy'), /pages: write/);
  assert.match(section('deploy'), /id-token: write/);
  const top = workflow.split(/^jobs:/m)[0];
  assert.match(top, /permissions:\n {2}contents: read/);
  assert.ok(!/pages: write|id-token: write/.test(top), 'the workflow default stays read-only');
});

test('the workflow still deploys on every push to main and keeps the Pages steps in order', () => {
  assert.match(workflow, /on:\n {2}push:\n {4}branches: \[main\]/);
  const deploy = section('deploy');
  const order = ['actions/checkout@', 'actions/configure-pages@', 'Stamp the build date', 'actions/upload-pages-artifact@', 'actions/deploy-pages@'].map((s) => deploy.indexOf(s));
  assert.ok(order.every((i) => i >= 0), 'a step is missing');
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'steps are out of order');
});

test('the workflow file has no tabs and uses two-space indentation', () => {
  assert.ok(!/\t/.test(workflow));
  for (const line of workflow.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    assert.equal(indent % 2, 0, 'odd indentation: ' + JSON.stringify(line));
  }
});
