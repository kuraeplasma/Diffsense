# 本番移行ハンドオフ

最終更新日: 2026-03-20

## 1. こちらで実装済み

- 署名機能の本番向けAPI切り替え共通化
- 署名依頼、再送、完了、状況更新メールのテンプレート統一
- 受信メールの不要なロゴ枠・下部 `DIFFsense` の除去
- 署名完了、辞退、期限切れのダッシュボード反映
- 本番環境変数チェック機構
- 本番デプロイチェックリスト
- 本番 `.env` ひな形

## 2. あなた側で設定が必要なもの

以下は実値の投入が必要です。

### 必須

- `JWT_SECRET`
- `RESEND_API_KEY`
- `MAIL_FROM`
- `APP_URL`
- `FRONTEND_URL`
- `ALLOWED_ORIGINS`
- `FIREBASE_PROJECT_ID`
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY`
- `FIREBASE_STORAGE_BUCKET`

### 利用している場合に必要

- `GEMINI_API_KEY`
- `FIRMA_API_KEY`
- `FIRMA_BASE_URL`
- `FIRMA_WEBHOOK_SECRET`
- `PAYPAL_CLIENT_ID`
- `PAYPAL_CLIENT_SECRET`
- `PAYPAL_MODE`
- `PAYPAL_PLAN_*`
- `PAYPAL_WEBHOOK_ID`
- `STRIPE_PUBLISHABLE_KEY`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_*`

## 3. 本番で入れるべき値

ベースは [backend/.env.production.example](/d:/契約/backend/.env.production.example) を使用する。

最低限、以下はこの形にする。

```env
NODE_ENV=production
AUTH_BYPASS=false
APP_URL=https://diffsense.spacegleam.co.jp
FRONTEND_URL=https://diffsense.spacegleam.co.jp
ALLOWED_ORIGINS=https://diffsense.spacegleam.co.jp
```

## 4. デプロイ前にやること

バックエンドで以下を実行する。

```bash
npm run check:env:prod
```

成功したらデプロイする。

## 5. デプロイ後に確認すること

- ログインできる
- 署名依頼を送れる
- 再送メールの見た目が崩れない
- 署名できる
- 辞退できる
- 完了メールが届く
- 署名済みPDFがダウンロードできる
- ダッシュボードに完了、辞退、期限切れが反映される

詳細は [production-deploy-checklist.md](/d:/契約/docs/production-deploy-checklist.md) を参照。

