import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const htmlPath = path.join(root, 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

const refs = new Set();
const patterns = [
  /\b(?:src|href|poster)=["']([^"']*(?:images\/|favicon)[^"']*)["']/g,
  /\bsrcset=["']([^"']+)["']/g,
  /url\(["']?([^"')]*(?:images\/|favicon)[^"')?]*)["']?\)/g,
  /\bcontent=["']([^"']*(?:images\/|favicon)[^"']*)["']/g,
];

for (const pattern of patterns) {
  for (const match of html.matchAll(pattern)) {
    const value = match[1];
    if (pattern.source.includes('srcset')) {
      value.split(',').forEach((part) => {
        const ref = part.trim().split(/\s+/)[0];
        if (ref) refs.add(ref);
      });
      continue;
    }
    refs.add(value);
  }
}

const missing = [];
for (const ref of refs) {
  if (/^(?:https?:)?\/\//.test(ref) && !ref.startsWith('https://diffsense.spacegleam.co.jp/')) {
    continue;
  }

  const cleanRef = ref
    .replace(/^https:\/\/diffsense\.spacegleam\.co\.jp\//, '')
    .replace(/[#?].*$/, '');

  if (!cleanRef || cleanRef.startsWith('#')) continue;

  const filePath = path.join(root, cleanRef);
  if (!fs.existsSync(filePath)) {
    missing.push(ref);
  }
}

if (missing.length > 0) {
  console.error('Missing LP image/static references:');
  for (const ref of missing) {
    console.error(`- ${ref}`);
  }
  process.exit(1);
}

console.log(`LP image/static references OK (${refs.size} refs checked)`);
