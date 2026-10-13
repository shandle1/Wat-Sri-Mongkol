const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const siteDir = path.resolve(__dirname, '..', 'site');
const postDir = path.join(siteDir, 'post');

async function walk(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(fullPath));
    else files.push(fullPath);
  }
  return files;
}

async function main() {
  const replacements = [];
  for (const entry of await fs.readdir(postDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || Buffer.byteLength(entry.name, 'utf8') <= 180) continue;
    const hash = crypto.createHash('sha1').update(entry.name).digest('hex').slice(0, 16);
    const newName = `page-${hash}`;
    await fs.rename(path.join(postDir, entry.name), path.join(postDir, newName));
    replacements.push([entry.name, newName]);
  }

  for (const file of (await walk(siteDir)).filter((name) => name.endsWith('.html'))) {
    let html = await fs.readFile(file, 'utf8');
    const original = html;
    for (const [oldName, newName] of replacements) {
      html = html
        .split(encodeURIComponent(oldName)).join(newName)
        .split(encodeURI(oldName)).join(newName)
        .split(oldName).join(newName);
    }
    if (html !== original) await fs.writeFile(file, html);
  }

  console.log(`Normalized ${replacements.length} overlong post path(s).`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
