import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const rootDir = process.cwd();
const targetDirs = ['js/modules'];
const forbiddenPatterns = [
  { name: 'innerHTML', pattern: /\binnerHTML\b/ },
  { name: 'eval', pattern: /\beval\s*\(/ },
  { name: 'new Function', pattern: /\bnew\s+Function\b/ },
  { name: 'document.write', pattern: /\bdocument\.write\s*\(/ },
];

async function collectFiles(dir) {
  const absDir = path.join(rootDir, dir);
  const entries = await readdir(absDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const relPath = path.join(dir, entry.name);
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
