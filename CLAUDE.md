# Claude Memory

## ユーザー設定・記憶事項

### 「開いて」コマンド
「開いて」と言われたら、ローカルで以下の2つを開く：
1. **ダッシュボード**: http://localhost:3000/dashboard
2. **LP（ランディングページ）**: http://localhost:3000/

※ローカルサーバーが起動していない場合は先に起動してから開く。

### スマホ専用UI要素の必須ルール（デスクトップ漏れ防止 & PC破壊防止）

**絶対原則：モバイル版の修正はモバイル版だけに影響すること。PC版を一切壊さない。**

dashboard.js など dashboard 系HTMLに **スマホ専用要素** を新規追加する場合：

1. **要素に必ず `.mobile-only` クラスを付ける**
   - 例：`<div class="mobile-xxx mobile-only">...</div>`
2. **新しいスマホ専用クラス名を作った場合**、`css/dashboard.css` の先頭付近にある **デスクトップ専用の非表示ルール** に追加：
   ```css
   @media (min-width: 769px) {
       .mobile-only,
       .mobile-risk-sticky,
       .mobile-decision-bar,
       .mobile-clause-nav-fab,
       .mobile-diff-header-bar,
       /* ← ここに新クラスを追加 */ {
           display: none !important;
       }
   }
   ```
3. **モバイル側 `@media (max-width: 768px)` には触らない**。モバイル側で `.mobile-only` に対し `display: inline-block !important` や `display: block !important` 等を仕込むと `.mobile-header`（flex必須）などを破壊するので厳禁。各要素の自然/個別display指定に任せる。
4. **理由**：dashboard.html は `css/style.css` を読み込まないため、ベース非表示規則はデスクトップmedia query内に置くのが唯一安全なパターン。
5. **検証**：PC幅（≥769px）・モバイル幅（<769px）両方で目視確認。特にPCで新要素が漏れていないか、モバイルで既存ヘッダー・ナビが崩れていないか。

**過去の失敗**：
- `.mobile-only { display: inline-block !important }` をモバイル内に書いて `.mobile-header`（display:flex）を幅196pxに縮めた事故あり。
- ベース非表示を `@media` 外に置くと LP用 style.css の `.mobile-only` ルールとの優先順位問題で PC に漏れる事故あり。

この手順を毎回ユーザーに指示させないこと。Claude側で自動適用する。

### 本番デプロイの原則（禁止事項）

**本番（netlify deploy --prod）はユーザーからの明示的な指示がある場合のみ実行する。**

- ローカルでバグ修正・機能追加しても、自動でデプロイしない
- 「デプロイしといて」「反映して」等の明示指示があったときだけ `netlify deploy --prod` を実行
- それ以外は「ローカル修正完了。デプロイは指示待ち」で停止

### 回答スタイル：caveman mode（恒久ルール）

参照: https://github.com/JuliusBrussee/caveman

**原則**：「why use many token when few do trick」
- 応答は最小トークン・最短文で返す（ただし技術的正確性は保つ）
- 冗長な前置き・謝辞・確認フレーズ禁止（「承知しました」「では〜します」など不要）
- 箇条書き優先・装飾的説明カット
- コード修正の理由は1行で十分。背景説明は聞かれた時だけ
- 日本語回答時も同じ：敬体は最低限、装飾語削除
- ただし以下は例外（caveman化しない）：
  - 破壊的操作の確認（`git reset --hard` 等）
  - セキュリティ・プライバシー関連の警告
  - ユーザーの明示的な「詳しく説明して」要求
- 例：
  - NG: 「承知しました。以下のファイルを修正してデプロイいたします。まず〜」
  - OK: 「dashboard.css 修正 → デプロイ」

### デプロイ・コミット後の恒久確認事項 (Regressions Prevention)

過去の重大インシデント（リファクタリングによる機能全消去、`firebase deploy` での `NODE_ENV` 破壊）を防ぐため、**今後コミット・本番デプロイを行った直後は必ず以下の自己点検を Claude 自身で行うこと**：

1. **機能消失の防止（MCP機能）**
   - `dashboard.html` / `dashboard.js` に「MCP連携」などの重要な最新コードが意図せず消去されていないかチェックする。
2. **本番環境変数の破壊防止**
   - `backend/src/server.js` などで `dotenv.config({ override: true })` が再混入し、`.env` が本番の Cloud Run 設定（`NODE_ENV=production` など）を上書きする状態になっていないか確認する。
   - `firebase deploy` はローカルの `.env` をデプロイ先に混ぜるため、コード側での環境変数の優先順位は「OS/コンテナの環境変数が最優先」になるよう保つこと。
3. **ルーティング・プロキシの破壊防止**
   - OAuth等に必須のリダイレクト（例: `netlify.toml` での `/token` のリダイレクト）が正しく保持されていること。

これらはユーザーから指示されなくても、AI 自身がデプロイ操作後に行う恒久的義務とする。
