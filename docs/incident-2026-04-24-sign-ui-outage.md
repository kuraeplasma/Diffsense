# インシデント記録: 署名管理が開かない（2026-04-24）

## 1. 症状
- 本番 `diffsense.spacegleam.co.jp` で「署名管理」が読み込み中のまま停止。
- ブラウザコンソールに `Unexpected token ']'` が表示。

## 2. 直接原因（Technical Root Cause）
- `js/sign-ui.js` の `localDummyContracts` 定義で、`*/ ],` という不正なトークン構成が混入。
- その結果、`sign-ui.js` の評価で構文エラーとなり、署名管理画面の初期化が停止。

## 3. いつ混入したか
- コミット: `e808379e14c88dcc25727c1227a60611f864a161`
- 日時: 2026-04-24 03:55 JST
- 変更内容: `localDummyContracts` をコメント化する過程で不整合な `]` が残存。

## 4. なぜ長引いたか（Process Root Cause）
- 本番ドメイン `diffsense.spacegleam.co.jp` は Netlify 配信だが、初動で Firebase へデプロイしたため修正が当たらなかった。
- ルール文書は存在したが、デプロイ前に強制実行される機械チェックが不足していた。

## 5. 恒久対策（Implemented）
- `scripts/check-sign-ui-syntax.mjs` を追加し、署名UIの構文破壊を検知。
- `scripts/check-prod-guard.mjs` を追加し、以下を強制検証:
  - `.netlify/state.json` の Site ID が本番ID `63a3902a-8d74-4914-9d80-2e5cf53a28d8` と一致
  - `js/dashboard.js` 内の `sign-ui.js` バージョンが単一
  - 既知の危険版 `sign-ui.js?v=20260407_final_v10` が残っていない
  - `js/sign-ui.js` に既知の破壊パターン `*/ ],` がない
- `package.json` に `preflight:prod` と `deploy:prod` を追加し、本番デプロイ導線を Netlify 固定に統一。
- `.husky/pre-commit` に `check:prod-guard` を追加。

## 6. 今後の運用ルール
- 本番前に必ず `npm run preflight:prod` を実行し、失敗時はデプロイしない。
- `diffsense.spacegleam.co.jp` 本番反映は `npm run deploy:prod` のみ使用する。
