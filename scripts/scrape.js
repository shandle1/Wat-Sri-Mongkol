const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const START_URL = 'https://dryvtech.wixsite.com/wat-si-mongkol';
const ORIGIN = new URL(START_URL).origin;
const SITE_BASE_PATH = new URL(START_URL).pathname.replace(/\/$/, '');
const OUTPUT_DIR = path.resolve(__dirname, '..', 'site');
const MAX_PAGES = 100;
const allowedAssetHosts = new Set([
  new URL(START_URL).host,
  'static.wixstatic.com',
  'static.parastorage.com',
]);

const pageExtensions = new Set(['', '.html', '.htm', '.php', '.asp', '.aspx']);
const assetTypes = new Set(['stylesheet', 'script', 'image', 'font', 'media']);

function cleanUrl(value) {
  const url = new URL(value, START_URL);
  url.hash = '';
  return url;
}

function safeSegment(value) {
  const cleaned = value.replace(/[<>:"|?*\x00-\x1F]/g, '_');
  if (Buffer.byteLength(cleaned, 'utf8') <= 180) return cleaned;
  const hash = crypto.createHash('sha1').update(cleaned).digest('hex').slice(0, 16);
  return `page-${hash}`;
}

function outputPathFor(url, isDocument = false, contentType = '') {
  let pathname = decodeURIComponent(url.pathname);
  if (
    isDocument &&
    url.origin === ORIGIN &&
    (pathname === SITE_BASE_PATH || pathname.startsWith(`${SITE_BASE_PATH}/`))
  ) {
    pathname = pathname.slice(SITE_BASE_PATH.length) || '/';
  }
  const extension = path.posix.extname(pathname);

  if (isDocument || pageExtensions.has(extension.toLowerCase())) {
    if (pathname.endsWith('/')) pathname += 'index.html';
    else if (!extension) pathname += '/index.html';
  }

  if (!pathname || pathname === '/') pathname = '/index.html';

  let parts = pathname.split('/').filter(Boolean).map(safeSegment);
  if (!isDocument && url.origin !== ORIGIN) {
    parts = ['_assets', safeSegment(url.host), ...parts];
  }
  let relative = parts.join('/');

  if (!isDocument && (!relative || relative.endsWith('/'))) relative += 'asset';
  if (!isDocument && !path.extname(relative)) {
    const mimeExtensions = {
      'text/css': '.css',
      'application/javascript': '.js',
      'text/javascript': '.js',
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/webp': '.webp',
      'image/svg+xml': '.svg',
      'font/woff': '.woff',
      'font/woff2': '.woff2',
      'video/mp4': '.mp4',
    };
    relative += mimeExtensions[contentType.split(';')[0].toLowerCase()] || '.bin';
  }

  if (url.search) {
    const suffix = crypto.createHash('sha1').update(url.search).digest('hex').slice(0, 10);
    const ext = path.extname(relative);
    relative = ext
      ? `${relative.slice(0, -ext.length)}.${suffix}${ext}`
      : `${relative}.${suffix}`;
  }

  return relative || 'index.html';
}

async function writeFile(relativePath, body) {
  const destination = path.join(OUTPUT_DIR, relativePath);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, body);
}

function rewriteHtml(html, documentPath) {
  const depth = documentPath.split('/').length - 1;
  const root = depth ? '../'.repeat(depth) : './';
  const escapedOrigin = ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const escapedSiteRoot = `${escapedOrigin}${SITE_BASE_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;

  return html
    .replace(new RegExp(`${escapedSiteRoot}/`, 'g'), root)
    .replace(new RegExp(`${escapedSiteRoot}(["'])`, 'g'), `${root}$1`)
    .replace(new RegExp(`${escapedOrigin}/`, 'g'), root)
    .replace(/(href|src|poster|action)=(['"])\/(?!\/)/gi, `$1=$2${root}`);
}

function relativeReference(fromFile, toFile) {
  const relative = path.posix.relative(path.posix.dirname(fromFile), toFile);
  return relative || path.posix.basename(toFile);
}

function replaceCapturedUrls(text, fromFile, urlMap) {
  let result = text;
  const entries = [...urlMap.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [url, localPath] of entries) {
    const replacement = relativeReference(fromFile, localPath);
    result = result.split(url).join(replacement);
    result = result.split(url.replaceAll('&', '&amp;')).join(replacement);
  }
  return result;
}

async function responseBodyWithTimeout(response, timeoutMs = 15_000) {
  let timer;
  try {
    return await Promise.race([
      response.body(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('asset download timed out')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function revealLazyContent(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let previous = -1;
      const timer = setInterval(() => {
        window.scrollBy(0, Math.max(600, window.innerHeight));
        const current = window.scrollY;
        if (current === previous || current + window.innerHeight >= document.documentElement.scrollHeight) {
          clearInterval(timer);
          window.scrollTo(0, 0);
          resolve();
        }
        previous = current;
      }, 150);
    });
  });
}

async function main() {
  await fs.rm(OUTPUT_DIR, { recursive: true, force: true });
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  const queue = [cleanUrl(START_URL).href];
  const visited = new Set();
  const savedAssets = new Set();
  const urlMap = new Map();
  const pendingDownloads = new Set();
  const documents = [];
  const stylesheets = [];

  page.on('response', (response) => {
    const download = (async () => {
      try {
      const request = response.request();
      const url = cleanUrl(response.url());
      if (!allowedAssetHosts.has(url.host) || !response.ok() || request.method() !== 'GET' || !assetTypes.has(request.resourceType())) return;

      const contentType = response.headers()['content-type'] || '';
      const relativePath = outputPathFor(url, false, contentType);
      urlMap.set(url.href, relativePath);
      if (savedAssets.has(relativePath)) return;
      savedAssets.add(relativePath);
      await writeFile(relativePath, await responseBodyWithTimeout(response));
      if (contentType.toLowerCase().startsWith('text/css')) stylesheets.push(relativePath);
      console.log(`asset ${relativePath}`);
      } catch (error) {
        console.warn(`Could not save asset: ${error.message}`);
      }
    })();
    pendingDownloads.add(download);
    download.finally(() => pendingDownloads.delete(download));
  });

  try {
    while (queue.length && visited.size < MAX_PAGES) {
      const current = queue.shift();
      if (visited.has(current)) continue;
      visited.add(current);

      console.log(`page  ${current}`);
      const response = await page.goto(current, { waitUntil: 'load', timeout: 60_000 });
      if (!response || !response.ok()) {
        console.warn(`Skipped ${current}: HTTP ${response?.status() ?? 'unknown'}`);
        continue;
      }

      await revealLazyContent(page);
      await page.waitForTimeout(750);
      const links = await page.locator('a[href]').evaluateAll((anchors) =>
        anchors.map((anchor) => anchor.href)
      );

      for (const link of links) {
        try {
          const url = cleanUrl(link);
          const extension = path.posix.extname(url.pathname).toLowerCase();
          const inSite = url.pathname === SITE_BASE_PATH || url.pathname.startsWith(`${SITE_BASE_PATH}/`);
          if (url.origin === ORIGIN && inSite && pageExtensions.has(extension) && !visited.has(url.href)) {
            queue.push(url.href);
          }
        } catch {}
      }

      const documentPath = outputPathFor(cleanUrl(current), true);
      documents.push({ documentPath, html: await page.content() });
    }

    await Promise.allSettled([...pendingDownloads]);

    for (const { documentPath, html } of documents) {
      const rewritten = replaceCapturedUrls(rewriteHtml(html, documentPath), documentPath, urlMap);
      await writeFile(documentPath, rewritten);
    }

    for (const stylesheet of stylesheets) {
      const absolute = path.join(OUTPUT_DIR, stylesheet);
      const css = await fs.readFile(absolute, 'utf8');
      await fs.writeFile(absolute, replaceCapturedUrls(css, stylesheet, urlMap));
    }
  } finally {
    await browser.close();
  }

  console.log(`Saved ${visited.size} page(s) and ${savedAssets.size} asset(s) to ${OUTPUT_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
