import fs from 'node:fs';
import path from 'node:path';

const targetPath = path.resolve(process.cwd(), 'js/sign-ui.js');

if (!fs.existsSync(targetPath)) {
  console.error(`[check-sign-ui-syntax] File not found: ${targetPath}`);
  process.exit(1);
}

const source = fs.readFileSync(targetPath, 'utf8');
const transformed = source
  .replace(/^\s*import\s.+$/gm, '')
  .replace(/^\s*export\s+const\s+SignUI\s*=/m, 'const SignUI =');

try {
  // Parse as regular JS after removing module-only lines.
  // This catches accidental token breakage (e.g. unmatched ] or }) before deploy.
  new Function(transformed);
  console.log(`[check-sign-ui-syntax] OK: ${targetPath}`);
} catch (error) {
  console.error(`[check-sign-ui-syntax] NG: ${targetPath}`);
  console.error(`[check-sign-ui-syntax] ${error?.message || error}`);
  process.exit(1);
}
