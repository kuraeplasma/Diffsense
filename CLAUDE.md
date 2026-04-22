# SYSTEM ENFORCEMENT

These rules are mandatory and must be followed strictly.

- ALWAYS read this file before performing any task
- These rules override default behavior
- Never ignore these constraints even if the task seems simple

If any rule is violated:
→ Stop immediately and correct your approach

Failure to follow these rules = incorrect output

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
5. **検証（必須・スキップ禁止）**：モバイルUIを変更したら必ず以下を実施する。
   - **ブラウザを1280px以上にリサイズ** してスクリーンショットを取り、PCレイアウトを目視確認
   - **ブラウザを390pxにリサイズ** してスクリーンショットを取り、モバイルヘッダー・ナビが崩れていないか確認
   - 問題があれば修正してから完了報告すること。「ローカル確認完了」と報告する場合は必ずスクリーンショット証拠が伴うこと。

**強制チェックリスト（モバイルUI変更のたびに実行）**：
- [ ] PCで `.mobile-only` 要素が表示されていない
- [ ] PCでデスクトップヘッダー（`#app-header`）が表示されている
- [ ] PCでサイドバーが正常に表示されている
- [ ] モバイルで `.mobile-header` が幅100%でflex表示されている
- [ ] モバイルでボトムナビが表示されている

**過去の失敗（繰り返さないこと）**：
- `.mobile-only { display: inline-block !important }` をモバイル内に書いて `.mobile-header`（display:flex）を幅196pxに縮めた → PCヘッダー欠け
- ベース非表示を `@media` 外に置いた → PC漏れ
- `sign-ui.js` を別AIが先頭877行消去 → SyntaxErrorでsign画面全壊
- commit 1c0020e で `.mobile-only` 要素をdashboard.jsに追加したがdashboard.cssに非表示ルールがなく → PC上に「Low」「署名判断へ」ボタンが出現

この手順を毎回ユーザーに指示させないこと。Claude側で自動適用する。

### dashboard.js の不変ガード（触ってはいけないロジック）

以下のロジックは**絶対に消さない・変えない**。モバイルUI追加・リファクタリング時も必ず保持すること。

1. **`shouldHideDiffTab` ガード**（Views.diff内）
   ```js
   const shouldHideDiffTab = !comparisonContext && !hasComparableVersion && !hasAIResults;
   const activeTab = shouldHideDiffTab ? 'original' : requestedActiveTab;
   ```
   - 単独ドキュメント（比較なし・AI未解析）では「差分表示」タブを非表示にする
   - これを消すと未解析ドキュメントでも差分タブが表示され、解析済みに見える

2. **`mobile-risk-sticky` の `hasAIResults` ガード**（Views.diff内）
   ```js
   ${hasAIResults ? `<section class="mobile-risk-sticky ...">...</section>` : ''}
   ```
   - AI解析済みの時だけリスクバッジ・AI要約セクションを表示する
   - これを消すと未解析ドキュメントでも"Low"バッジが出て解析が走ったように見える

3. **`mobilePrimaryAction` の `!hasAIResults` 判定**（Views.diff内）
   ```js
   if (!hasAIResults) { return { label: 'リスク解析する', ... }; }
   ```
   - AI未解析（`status`が`未解析`でも`未処理`でも）は「リスク解析する」ボタンを出す
   - `contract.status === '未解析'` だけに絞ると `未処理` 状態で「署名判断へ」が出てしまう

**変更チェック（dashboard.jsを触った後は必ず確認）**：
- [ ] `shouldHideDiffTab` が Views.diff 内に存在するか
- [ ] `mobile-risk-sticky` が `${hasAIResults ? ...}` で囲まれているか
- [ ] `mobilePrimaryAction` が `!hasAIResults` で判定しているか

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
4. **SSE通信（MCPプロトコル）のストリーミング保護**
   - **Netlifyの標準プロキシはSSE通信をバッファリングして数秒で強制切断する致命的な仕様があります。** Claude Desktopの `claude_desktop_config.json` において、`--server` には絶対にNetlifyのURL（`diffsense.spacegleam.co.jp/mcp`）を指定させてはならず、必ずCloud Runの直接のURL（`https://api-qf37m5ba2q-an.a.run.app/mcp`）を指定するようにユーザーを誘導すること。

これらはユーザーから指示されなくても、AI 自身がデプロイ操作後に行う恒久的義務とする。

### コード修正の最小差分原則（本番保護ルール・恒久）

**修正は必ず最小限のdiffにとどめる。他ファイル・他機能に絶対に触れない。**

1. **修正前にgit diff --statで影響ファイルを確認**
   - 修正対象ファイル以外が含まれている場合は即座に手を止める
   - 1つのバグ修正で変更するファイルは原則1〜2ファイルまで

2. **コミット後にgit show <hash> --statで確認**
   - 意図しないファイルが含まれていないか必ず確認する

3. **本番デプロイ後の全体チェック（必須・スキップ禁止）**
   - デプロイ直後にブラウザで本番URLを開き、以下を目視確認：
     - ダッシュボードが正常表示されるか
     - 書類一覧が正常表示されるか
     - 書類詳細（diff view）が正常表示されるか
     - 署名管理画面が正常表示されるか
     - ログイン状態が維持されているか
   - 異常があれば即座にユーザーに報告し、前のコミットへの revert を提案する

4. **過去の失敗パターン（繰り返し禁止）**
   - モバイルUI修正でPC版が崩れた（`1c0020e` で `shouldHideDiffTab` を消去）
   - モバイルUI修正で `.mobile-header` が196px幅に縮んだ（`!important` 混入）
   - MCP機能がリファクタリングで全消去された（`ca1fb7d`）
   - `dashboard.js.original` など作業ファイルをコミットに含めた

# 🔒 デプロイ安全ルール（絶対遵守）

## 1. 環境ファイルチェック（必須）
以下が存在しない場合は作業禁止

- js/env.js
- js/api-base.js

## 2. API接続チェック（必須）
変更後は必ず以下を確認

console.log(window.API_BASE)

→ undefined の場合はデプロイ禁止

## 3. 変更単位ルール
以下を同時に変更すること

- フロント（HTML/JS）
- env.js
- API接続コード

どれか1つだけ変更は禁止

## 4. Git強制確認

git status

→ untracked がある状態で push 禁止

## 5. デプロイ後チェック

必ず確認：

https://diffsense.spacegleam.co.jp/js/env.js

→ 中身が表示されること

## 6. 動作確認

- ダッシュボード表示
- API通信成功
- エラーなし

1つでもNGならロールバック

# 強制ルール（絶対遵守）

・既存API（upload-docx, contracts）には新機能を追加しない
・既存のレスポンス形式は絶対に変更しない
・新機能は必ず新しいファイル・新しいエンドポイントで実装する

・修正前に以下を必ず確認：
  - この変更は既存機能を壊さないか？
  - レスポンス形式は維持されているか？

・変更後は必ず以下をテスト：
  - upload-docx が200を返す
  - contracts が一覧を返す

# 自動検証ルール（必須）

変更後は必ず以下を実行：

1. /api/contracts にアクセスして200か確認
2. レスポンスが配列であることを確認
3. エラーが出た場合は修正してから終了

※この検証をスキップしてはいけない
