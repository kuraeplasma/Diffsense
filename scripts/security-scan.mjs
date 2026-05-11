import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const rootDir = process.cwd();
const targetDirs = ['js', 'backend/src', 'scripts'];
const forbiddenPatterns = [
  // Browser Security
  { name: 'innerHTML', pattern: /\binnerHTML\b/ },
  { name: 'eval', pattern: /\beval\s*\(/ },
  { name: 'new Function', pattern: /\bnew\s+Function\b/ },
  { name: 'document.write', pattern: /\bdocument\.write\s*\(/ },
  // Secret Leaks
  { name: 'Google API Key', pattern: /AIzaSy[0-9A-Za-z-_]{33}/ },
  { name: 'Stripe Secret Key', pattern: /sk_(?:live|test)_[0-9a-zA-Z]{24}/ },
  { name: 'Private Key', pattern: /-----BEGIN (?:RSA|OPENSSH|PRIVATE) KEY-----/ },
  { name: 'Firebase AppId', pattern: /1:\d+:web:[a-f0-9]{22}/ },
];

const excludeFiles = [
  'js/firebase-config.js', // Public Firebase web configuration
];

async function collectFiles(dir) {
  const absDir = path.join(rootDir, dir);
  let entries;
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch (error) {
    // If directory doesn't exist (e.g. backend/src in some environments), skip it.
    return [];
  }
  const files = [];

  for (const entry of entries) {
    const relPath = path.join(dir, entry.name).replace(/\\/g, '/');
    if (excludeFiles.includes(relPath)) continue;

    if (entry.isDirectory()) {
      files.push(...await collectFiles(relPath));
    } else if (entry.isFile() && /\.(m?js|html)$/i.test(entry.name)) {
      files.push(relPath);
    }
  }

  return files;
}

const files = (await Promise.all(targetDirs.map(collectFiles))).flat();
const findings = [];

for (const file of files) {
  const content = await readFile(path.join(rootDir, file), 'utf8');
  const lines = content.split(/\r?\n/);
  lines.forEach((line, index) => {
    forbiddenPatterns.forEach(({ name, pattern }) => {
      if (pattern.test(line)) {
        findings.push(`${file}:${index + 1} forbidden ${name}`);
      }
    });
  });
}

if (findings.length > 0) {
  console.error('Forbidden security-sensitive patterns found:');
  findings.forEach((finding) => console.error(`- ${finding}`));
  process.exit(1);
}

console.log(`security-scan ok (${files.length} files)`);
