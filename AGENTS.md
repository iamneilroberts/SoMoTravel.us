# Repository Guidelines

## Project Structure & Module Organization
- Root contains static HTML pages for proposals and itineraries (for example: `index.html`, `mobile.html`, `*_proposal.html`).
- `trips.json`: source-of-truth for trips referenced from the homepage. Keep entries well‑formed and sorted logically.
- `config.js`: site‑level settings used by `index.html` and related pages.
- `oldtrips/`: historical or archived documents.
- `CNAME`: custom domain for GitHub Pages — do not remove or rename.

## Build, Test, and Development Commands
- No build step — this is a static site. Open `index.html` directly or serve locally for consistent paths.
- Local server (Python):
  - `python3 -m http.server 8000` then visit `http://localhost:8000/`.
- Quick link check: open the browser console and verify network requests resolve (especially files referenced from `trips.json`).

## Coding Style & Naming Conventions
- HTML5, UTF‑8, 2‑space indentation. Keep markup semantic (use headings, lists, and descriptive `alt` text).
- Prefer classes and small utility styles; avoid large inline style blocks in new pages.
- Filenames: lowercase, kebab‑case (e.g., `welford-london-guide.html`). For new files prefer hyphens over underscores.
- Keep titles, primary `<h1>`, and page filenames aligned for searchability.

## Testing Guidelines
- Manual QA on desktop and mobile emulation (Chrome DevTools: iPhone/Pixel). Verify typography, spacing, and touch targets.
- From `index.html`, confirm links to any new page work and that the page references are included in `trips.json` when applicable.
- Validate HTML with an HTML validator and run a quick Lighthouse audit for basic accessibility and performance checks.

## Commit & Pull Request Guidelines
- Commit style: short, imperative subject; include scope/file when helpful.
  - Examples:
    - `Add travel document: Chastain2026.html`
    - `Update trips.json: add Welford London guide`
- PRs should include: summary of changes, before/after screenshots (or page URL when served locally), and any affected entries in `trips.json` or `config.js`.
- Use feature branches; avoid force‑pushes to `main`. Never alter `CNAME`.

## Security & Configuration Tips
- Do not commit secrets or client PII. Redact booking numbers and addresses.
- Keep file references relative; verify case‑sensitive paths to work on all hosts.
