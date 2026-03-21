# 署名機能 本番化チェックリスト

最終更新日: 2026-03-20

## 1. こちらで実装済み

- 署名依頼、再送、完了、状況更新メールのテンプレート統一
- メールの不要なロゴ枠、下部 `DIFFsense` 表示の除去
- 署名機能のAPI接続先共通化
- 署名完了、辞退、期限切れのダッシュボード反映
- 本番環境変数チェック機構

## 2. 本番で必要な最小環境変数

ベースは [backend/.env.signature.production.example](/d:/契約/backend/.env.signature.production.example) を使う。

必須:

- `NODE_ENV=production`
- `AUTH_BYPASS=false`
- `APP_URL=https://diffsense.spacegleam.co.jp`
- `FRONTEND_URL=https://diffsense.spacegleam.co.jp`
- `ALLOWED_ORIGINS=https://diffsense.spacegleam.co.jp`
- `JWT_SECRET`
- `RESEND_API_KEY`
- `MAIL_FROM`
- `FIREBASE_PROJECT_ID`
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY`
- `FIREBASE_STORAGE_BUCKET`

## 3. デプロイ前チェック

```bash
cd backend
npm run check:env:prod
```

期待結果:

- `Production environment validation passed.`

## 4. デプロイ後に確認すること

### 4.1 署名依頼

- 署名依頼を送れる
- 署名依頼メールが届く
- メール上部は `DIFFsense` 文字のみ
- 不要なロゴ枠が出ない

### 4.2 再送

- 再送できる
- 再送メールでも見た目が崩れない

### 4.3 署名

- 署名画面が開く
- 手書き署名できる
- テキスト署名できる
- 署名済みPDFに反映される

### 4.4 辞退

- 辞退確認モーダルが出る
- 辞退完了画面が出る
- ダッシュボードが `辞退` に更新される

### 4.5 完了

- 完了メールが依頼者へ届く
- 完了メールが署名者へ届く
- 署名済みPDFをダウンロードできる

### 4.6 期限切れ

- 期限切れ文言が正しい
- ダッシュボードで `期限切れ` へ更新される

## 5. あなた側で必要な作業

- 本番秘密値の投入
- デプロイ
- 実メール送受信を含む最終確認

