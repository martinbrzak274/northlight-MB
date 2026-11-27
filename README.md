# Northlight Studio website

A plain HTML website for Northlight Studio, a 25-person design studio.

## Structure

- `index.html`: the whole site, with a heading and a short description.
- `.github/workflows/deploy.yml`: GitHub Actions workflow that deploys the site to GitHub Pages.

There are no frameworks, no dependencies and no build step. The repository root is published as it is.

## Local preview

Open `index.html` in a browser.

## Deployment

Every push to `main` runs the workflow, which uploads the repository contents and publishes them to GitHub Pages. You can also run it manually from the Actions tab.

One-time setup: in the repository go to **Settings → Pages** and set **Source** to **GitHub Actions**.

The site is then served at `https://martinbrzak274.github.io/northlight-MB/`.
