# Wat Sri Mongkol mirror

This project captures rendered pages and same-origin assets from the authorized source site.

## Capture

```bash
npm install
npx playwright install chromium
npm run scrape
npm run serve
```

Open http://localhost:4173 and inspect the result before committing it.

## Publish

Authenticate Git separately (do not store a personal access token in this project), then:

```bash
git init
git add .
git commit -m "Initial authorized website capture"
git branch -M main
git remote add origin https://github.com/shandle1/Wat-Sri-Mongkol.git
git push -u origin main
```

Static capture cannot reproduce server-side features such as forms, authentication, databases, or private APIs.
