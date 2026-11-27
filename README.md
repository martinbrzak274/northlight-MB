# Northlight Studio website

A plain HTML website for Northlight Studio, a 25-person design studio.

## Structure

- `index.html`: the home page, with a heading, a short description and links to the pages below.
- `helpdesk.html`, `helpdesk.js`, `helpdesk.css`: a demo helpdesk (fake data, tickets saved in localStorage).
- `troubleshoot.html`: a click-through decision tree for "no internet".
- `tools/`: read-only Node.js scripts (see below).
- `.github/workflows/deploy.yml`: GitHub Actions workflow that deploys the site to GitHub Pages.

There are no frameworks, no dependencies and no build step. The repository root is published as it is.

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
