# Northlight Studio website

A plain HTML website for Northlight Studio, a 25-person design studio.

## Structure

- `index.html`, `contact.js`, `images/`: the home page with a header, three services, an FAQ (with JSON-LD) and a contact form. A sent form creates a ticket in the help desk storage of the visitor's browser; nothing is sent over the internet.
- `helpdesk.html`, `helpdesk.js`, `helpdesk.css`, `helpdesk-store.js`: a demo helpdesk (fake data, tickets saved in localStorage). `helpdesk-store.js` holds the storage and priority rules shared with the contact form.
- `crm.html`, `crm.js`: a small demo CRM (see below).
- `automation.html`, `automation.js`, `rules.json`: rules that run when the website form is sent (see below).
- `settings.html`, `settings.js`, `config.js`, `health.json`: version, settings and the Export all data button (see below).
- `troubleshoot.html`, `troubleshoot.js`: a click-through decision tree for "no internet".
- `staff.html`, `staff.js`: a learning model of staff accounts (see below).
- `northlight.cloud.json`: a description of the cloud resources (see below).
- `tests/`: tests for the pages, for example `node tests/index.test.js`. `tests/e2e/` holds the browser tests (see below).
- `tools/`: read-only Node.js scripts and their tests (see below), and `tools/serve.js`, a small local web server.
- `glass.css`, `glass.js`: the design of every page (see below).
- `package.json`, `package-lock.json`, `playwright.config.js`: only for the browser tests.
- `.github/workflows/deploy.yml`: GitHub Actions workflow that checks the cloud description, runs the browser tests and then deploys the site to GitHub Pages.

The site itself has no frameworks, no dependencies and no build step. The repository root is published as it is. Playwright is a development dependency for the tests only.

## Design: glass

Every page shares one stylesheet, `glass.css`, and one small script, `glass.js`.

- **Glass, used with care.** Frosted blur is on the header, the hero picture, the service cards, the panels, the chart tooltip and the troubleshooting card. Items inside a panel (list rows, FAQ rows) use a lighter see-through fill without blur, which looks cleaner and costs far less to draw. Where a browser has no `backdrop-filter`, or the visitor asks for less transparency, the surfaces become solid.
- **Light and dark.** Both follow the visitor's system setting. Every colour is a variable at the top of `glass.css`.
- **Type.** A modern system font stack with a fluid size scale. The content security policy allows no outside fonts.
- **Motion.** Slowly drifting ambient light, the page easing in at load, sections easing in as they are scrolled to, floating orbs, a hero picture that leans towards the pointer, buttons that lift, shimmer and press, a soft light that follows the pointer over cards, smooth opening of the FAQ, and chart bars that grow in. Only `transform` and `opacity` are animated. Everything stops for visitors who prefer reduced motion, and everything is visible without JavaScript.
- **Performance.** Measured without a GPU, a smoothly drifting background behind many blurred surfaces took the busiest page from 60 down to 43 frames per second, because every blurred surface is redrawn each time something behind it changes. The ambient light therefore moves in about four tiny steps a second, which looks the same for soft light and keeps the page at 60. The hero picture reacts to the pointer instead of floating on its own.
- **Phones.** The menu becomes a row that scrolls sideways, tap targets are at least 40 px, and no page scrolls sideways at 360 px.

To change the look, start with the variables at the top of `glass.css`. The chart's single colour is set in `crm.html`.

## Browser tests and security checks

The tests in `tests/e2e/` run in a real browser with [Playwright](https://playwright.dev). They check that:

- markup typed into the website form and the help desk form (for example `<b>`, `<img onerror=...>`, `<script>`) is shown as plain text everywhere it appears, and never runs
- a Design or Sales user cannot see the admin section of `staff.html`, even by un-hiding it, while an IT user can
- an empty form shows a clear message and saves nothing (the website form and the CRM forms show their own messages; the help desk and sign-in forms use the browser's "required" message)
- every page has a content security policy meta tag, the policy is strict, and the browser really enforces it
- the repository contains no password, key or token. Only the fake demo logins on `staff.html` are allowed, by exact value. Files that normally hold secrets (such as `.env` or `*.pem`) are not allowed at all, and `.gitignore` keeps them out

Every browser test also fails if the page breaks its content security policy, throws an error, opens an alert, or asks for anything from outside the site.

**Run them:** once, `npm ci` and `npx playwright install chromium`. Then `npx playwright test`. This starts `tools/serve.js` (port 4173, or set `PORT`) and tests the site from it.

- `SITE_URL=https://example.github.io/northlight-MB/ npx playwright test` tests a site that is already published instead. The local server is then not started. A folder opened from disk also works, for example `SITE_URL=file:///C:/path/to/northlight-MB/`.
- `PW_CHANNEL=msedge` (or `chrome`) uses a browser that is already installed, so nothing needs to be downloaded.
- `npx playwright test --project=repo` runs only the repository check, which needs no browser.
- The tests run with reduced motion, which the pages honour, so animation timing cannot make them flaky. `tests/e2e/motion.spec.js` turns motion back on for the animated side. At most 4 browsers (2 on CI) run at once: the pages are graphical, and many browsers at once on one computer starve each other.
- `tests/e2e/responsive.spec.js` opens every page at 360, 820 and 1280 px wide, and checks that nothing scrolls sideways, buttons are big enough to tap, and light and dark both work.
- `node tests/csp.test.js` and `node tests/serve.test.js` are quick checks without a browser.

The workflow runs the browser tests in a `test` job, in parallel with the cloud check. If either fails, the site is not deployed. The report is kept as a workflow artifact for 7 days.

**About the content security policy:** it is set in a meta tag in every page, because GitHub Pages cannot send headers. It allows scripts only from the site itself (no inline scripts), allows inline styles (the pages keep their styles in the page), and blocks all other requests, forms that send data anywhere, `<base>` tags and plugins. A meta tag cannot set `frame-ancestors`, so it does not stop other sites from showing these pages in a frame. That needs a real header, which a different host could send.

## Settings, health and data export

- `health.json` holds the name, version and build date. When the workflow deploys, it writes the date of that deploy into the deployed copy of `health.json` (the file in the repository keeps its committed date). Change the version by hand when you release.
- `config.js` holds the settings the site uses: the app name, the prefix of the localStorage keys (`northlight-`), where `health.json` is, and the export file settings. No secrets belong in it.
- `settings.html` shows the version, the settings and the records saved in this browser. **Export all data** downloads every localStorage record as one JSON file, `northlight-export-<date>-<time>.json`. The file is made in the browser and is not sent anywhere.
- The export lists every key in the browser's storage, not only ours. On GitHub Pages, other projects under the same account share that storage, so they appear too, marked as not from Northlight. The file also contains the fake staff password hashes and code secrets, so keep an export private if you ever use real data.
- Pages opened from disk cannot read `health.json`, so the page then shows "unknown" and says why.

Run the tests with `node tests/settings.test.js`.

## Cloud description and checks

`northlight.cloud.json` describes a resource group, a web app and a storage account, each with a name and the tags `owner`, `env` and `cost-center`. **It only describes them: nothing is created from it**, and the site itself is deployed to GitHub Pages.

`node tools/check-cloud.js` checks the file and exits with an error (code 1) if anything is wrong. It prints PASS or FAIL for each check:

- every resource has the three tags, each spelled exactly and not empty, and the `env` tag is `dev`, `test` or `prod` and matches the environment of the file
- every name follows the Azure limits (length and allowed characters) and the convention `rg-<project>-<env>-<region>`, `app-<project>-<env>-<region>` and `st<project><env><region>`, with an optional short suffix
- names are unique, every resource points at a resource group in the file, and the file has a resource group, a web app and a storage account

The naming rules and tags are my choices and sit together at the top of `tools/check-cloud.js`, so change them there. The workflow runs this check first, in its own job. If it fails, the deploy job does not start. Run the tests with `node tools/test/check-cloud.test.js`.

## Automation

When the contact form on `index.html` is sent, the rules in `rules.json` run. **Nothing is really sent**: the outbox is only a list kept in this browser.

- `form-create-lead` creates a lead in the CRM storage (source "Website form", company "Not given").
- `form-create-ticket` creates a ticket in the help desk storage.
- `urgent-escalate` runs when the message contains the whole word "urgent" (any case): it sets the ticket to P1 and adds an alert to the outbox. Note that "not urgent" also matches, because the rule only looks for the word.
- Every event and every rule that runs writes a line to the log. If an action fails, that rule stops, the error is logged, and the other rules still run.
- `automation.html` shows the rules, the outbox and the log.

The rule format is checked strictly: a rule with an unknown action, a missing or misspelt setting or an unknown placeholder is skipped and shown as a problem. A rule can be switched off with `"enabled": false`.

Browsers do not let a page opened from disk (`file://`) read `rules.json`, so `automation.js` also holds a built-in copy of the rules. A test keeps the two identical. The Automation page and every log line say which one was used. **Edits to `rules.json` only take effect when the site is served over http(s), for example on GitHub Pages.** If `rules.json` is broken, the built-in copy is used and a warning is shown, so a message is never lost.

Run the tests with `node tests/automation.test.js`.

## CRM

`crm.html` is a small CRM with fake data, saved in localStorage. It has leads, accounts, contacts, opportunities and support cases.

- **Convert** turns an open lead into an account (the lead's company), a contact (the lead's person) and an opportunity (the lead's estimated value). It is all or nothing, and a lead can be converted once. A new opportunity starts at the first stage, **Lead**.
- Opportunity stages are Lead, Qualified, Quote, Won and Lost. Change a stage from the dropdown on the opportunity.
- A support case has a priority (P1 to P3) and a due time. The due time is prefilled from the help desk response targets (1 h, 4 h, 24 h) and can be changed. An open case past its due time is labelled **Overdue**.
- The **Opportunities by stage** chart is plain SVG, no libraries: one colour, a value at the end of each bar, a hover and keyboard tooltip, and a "View as table" version of the same numbers. It has light and dark colours.
- It starts with three fake leads and one case. If the stored data is damaged, the page restores the demo data and keeps the damaged copy under the key `northlight-crm-v1-invalid`.

Run the tests with `node tests/crm.test.js`.

## Staff accounts (learning model)

`staff.html` models how sign-in and joiner/leaver handling work, with six fake users in the groups Design, Sales and IT. It is a **learning model, not real security**: everything runs in the browser and is saved in localStorage, and all names, passwords and codes are fake.

- Sign-in has two steps. First the password, hashed with the browser's Web Crypto API (PBKDF2-SHA-256 with a random salt per user). Then a time-based one-time code (TOTP, RFC 6238, 30-second steps), which a used code cannot repeat. A simulated authenticator panel stands in for the phone app.
- Only the IT group can open the admin section. IT can mark a **Leaver** (who then cannot sign in) and add a **Joiner** (who gets a random temporary password, shown once). The last active IT user cannot be marked as a leaver.
- The demo accounts are listed on the page. Passwords are not stored in readable form, only their hashes.
- Real systems do these checks on a server, rate-limit attempts and keep logs. None of that is modelled.

Run the tests with `node tests/staff.test.js` (Node.js 18.15 or newer).

## Tools

Both scripts only read information and never change a setting. Every command goes through an allowlist in `tools/lib/safety.js` that refuses anything else. They need Node.js 18.15 or newer.

- `node tools/pc-health.js`: OS, last restart, free disk space, firewall status and the last installed Windows update. Each check prints PASS or FAIL. Things that cannot be checked on an OS print INFO. Pending updates are not checked.
- `node tools/network-doctor.js [website]`: checks the router (default gateway), then 1.1.1.1, then a website name (default `example.com`). It prints PASS or FAIL for each and names the first failing step. Some routers ignore ping, and the tool says so when only the router check fails.
- `node tools/test/tools.test.js`: tests that run the logic on fake command output.

Both scripts exit with 1 if any check fails.

## Local preview

Open `index.html` in a browser.

## Deployment

Every push to `main` runs the workflow, which uploads the repository contents and publishes them to GitHub Pages. You can also run it manually from the Actions tab.

One-time setup: in the repository go to **Settings → Pages** and set **Source** to **GitHub Actions**.

The site is then served at `https://martinbrzak274.github.io/northlight-MB/`.
