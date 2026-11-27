# Northlight Studio website

A plain HTML website for Northlight Studio, a 25-person design studio.

## Structure

- `index.html`: the home page, with a heading, a short description and links to the pages below.
- `helpdesk.html`, `helpdesk.js`, `helpdesk.css`: a demo helpdesk (fake data, tickets saved in localStorage).
- `troubleshoot.html`: a click-through decision tree for "no internet".
- `staff.html`, `staff.js`: a learning model of staff accounts (see below).
- `tests/staff.test.js`: tests for `staff.js`.
- `tools/`: read-only Node.js scripts (see below).
- `.github/workflows/deploy.yml`: GitHub Actions workflow that deploys the site to GitHub Pages.

There are no frameworks, no dependencies and no build step. The repository root is published as it is.

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
