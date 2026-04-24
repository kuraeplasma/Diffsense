import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const expectedNetlifySiteId = '63a3902a-8d74-4914-9d80-2e5cf53a28d8';
const errors = [];

function readUtf8(relPath) {
  const fullPath = path.resolve(root, relPath);
  if (!fs.existsSync(fullPath)) {
    errors.push(`[missing] ${relPath}`);
    return '';
  }
  return fs.readFileSync(fullPath, 'utf8');
}

function addError(message) {
  errors.push(message);
}

function checkNetlifyTarget() {
  const stateRaw = readUtf8('.netlify/state.json');
  if (!stateRaw) return;
  try {
    const state = JSON.parse(stateRaw);
    if (state.siteId !== expectedNetlifySiteId) {
      addError(
        `[target] .netlify/state.json の siteId が不一致です。expected=${expectedNetlifySiteId}, actual=${state.siteId || '(empty)'}`
      );
    }
  } catch (error) {
    addError(`[target] .netlify/state.json の JSON 解析に失敗: ${error.message}`);
  }
}

function checkDashboardVersionLinks() {
  const dashboardHtml = readUtf8('dashboard.html');
  const dashboardJs = readUtf8('js/dashboard.js');
  if (!dashboardHtml || !dashboardJs) return;

  const dashboardScriptMatch = dashboardHtml.match(/\/js\/dashboard\.js\?v=([A-Za-z0-9._-]+)/);
  if (!dashboardScriptMatch) {
    addError('[dashboard] dashboard.html に /js/dashboard.js?v=... の記述が見つかりません。');
  }

  const signUiVersionMatches = [...dashboardJs.matchAll(/sign-ui\.js\?v=([A-Za-z0-9._-]+)/g)];
  if (signUiVersionMatches.length === 0) {
    addError('[sign] js/dashboard.js に sign-ui.js?v=... の import が見つかりません。');
    return;
  }

  const signUiVersions = signUiVersionMatches.map((m) => m[1]);
  const uniqueVersions = [...new Set(signUiVersions)];
  if (uniqueVersions.length !== 1) {
    addError(`[sign] sign-ui.js の version が複数混在しています: ${uniqueVersions.join(', ')}`);
  }

  if (/sign-ui\.js\?v=20260407_final_v10/.test(dashboardJs)) {
    addError('[sign] 危険な旧バージョン sign-ui.js?v=20260407_final_v10 が残っています。');
  }
}

function checkSignUiKnownBadPattern() {
  const signUi = readUtf8('js/sign-ui.js');
  if (!signUi) return;
  if (/\*\/\s*\],/.test(signUi)) {
    addError('[sign-ui] 既知の構文破壊パターン "*/ ]," が検出されました。');
  }
}

checkNetlifyTarget();
checkDashboardVersionLinks();
checkSignUiKnownBadPattern();

if (errors.length > 0) {
  console.error('[check-prod-guard] NG');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log('[check-prod-guard] OK');
console.log(`[check-prod-guard] target siteId=${expectedNetlifySiteId}`);
