# Raynard documentation

This directory contains the standalone Docusaurus documentation site for the
Raynard desktop app.

The production site is published at
<https://geirfreysson.github.io/raynard/> by the
`Deploy documentation to GitHub Pages` workflow whenever documentation changes
land on `main`. The workflow can also be run manually from GitHub Actions.

## Development

```bash
cd docs
npm install
npm start
```

The development server opens at `http://localhost:3000`.

## Production build

```bash
cd docs
npm run build
npm run serve
```
