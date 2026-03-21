# 本番デプロイ手順・確認チェックリスト

最終更新日: 2026-03-20

## 1. 事前準備

### 1.1 本番環境変数

本番環境では少なくとも以下を設定する。

- `NODE_ENV=production`
- `AUTH_BYPASS=false`
- `JWT_SECRET`
- `RESEND_API_KEY`
- `MAIL_FROM`
- `APP_URL`
- `FRONTEND_URL`
- `ALLOWED_ORIGINS`
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY`
- `FIREBASE_STORAGE_BUCKET`

必要に応じて以下も設定する。

- `GEMINI_API_KEY`
- `PAYPAL_CLIENT_ID`
- `PAYPAL_CLIENT_SECRET`
- `PAYPAL_MODE`
- `PAYPAL_PLAN_*`
- `PAYPAL_WEBHOOK_ID`
- `STRIPE_SECRET_KEY`
- `STRIPE_PUBLISHABLE_KEY`
- `STRIPE_PRICE_*`
- `STRIPE_WEBHOOK_SECRET`
- `FIRMA_API_KEY`
- `FIRMA_BASE_URL`
- `FIRMA_WEBHOOK_SECRET`

### 1.2 起動前チェック

バックエンドで以下を実行する。

```bash
npm run check:env:prod
```

期待結果:

- `Production environment validation passed.`

## 2. デプロイ手順

### 2.1 バックエンド

1. 本番 `.env` を反映する
2. 依存関係をインストールする
3. `npm run check:env:prod` を実行する
4. バックエンドを起動または再デプロイする
5. `/health` が `status: ok` を返すことを確認する

### 2.2 フロントエンド

1. 最新コードをデプロイする
2. `diffsense.spacegleam.co.jp` など本番ドメインで配信する
3. 必要に応じて `apiBase` の上書き設定を行う

### 2.3 デプロイ後確認

以下を確認する。

- 本番フロントからAPIへ疎通できる
- ログインできる
- ダッシュボード表示が崩れていない
- 署名管理画面が開ける

## 3. 署名機能 E2E チェック

### 3.1 署名依頼作成

- 書類を選択できる
- 署名者を設定できる
- 署名欄を配置できる
- 送信できる

### 3.2 署名依頼メール

- 署名依頼メールが届く
- 上部は `DIFFsense` の文字のみ
- 謎のロゴ枠や下部の `DIFFsense` が出ない
- リンクから署名画面が開く

### 3.3 署名画面

- 書類が表示される
- ページめくりできる
- 手書き署名できる
- テキスト署名できる
- 必須未入力では完了できない

### 3.4 完了

- 署名して完了できる
- 依頼者ダッシュボードが更新される
- 依頼者へ完了通知メールが届く
- 署名者へ完了メールが届く
- 署名済みPDFをダウンロードできる

### 3.5 辞退

- 辞退確認モーダルが表示される
- 辞退完了画面が表示される
- 依頼者へ辞退通知が届く
- ダッシュボードで `辞退` と表示される

### 3.6 リマインド

- 再送できる
- 再送メールでも余計なロゴ枠が出ない

### 3.7 期限切れ

- 期限切れリンクで適切な文言が出る
- ダッシュボードで `期限切れ` に更新される

## 4. リリース判定

以下をすべて満たした場合に本番運用開始とする。

- 本番環境変数が設定済み
- `npm run check:env:prod` が成功
- バックエンド `/health` 正常
- 署名依頼から完了まで一連のE2Eが成功
- 辞退、再送、期限切れも確認済み
- 署名済みPDFが正しく生成される

