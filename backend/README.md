# DIFFsense Backend API

契約書差分解析のためのバックエンドAPI（Gemini 1.5 Flash使用）

## セットアップ

### 1. 依存関係のインストール

```bash
cd backend
npm install
```

### 2. 環境変数の設定

`.env.example`を`.env`にコピーして、Gemini API Keyを設定:

```bash
cp .env.example .env
```

`.env`ファイルを編集:

```env
GEMINI_API_KEY=your_actual_gemini_api_key_here
PORT=3001
NODE_ENV=development
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:8000
```

### 3. サーバー起動

```bash
npm start
```

開発モード（自動再起動）:

```bash
npm run dev
```

## API エンドポイント

### ヘルスチェック

```
GET /api/health
```

**レスポンス例**:
```json
{
  "status": "ok",
  "timestamp": "2026-02-08T11:15:00.000Z",
  "uptime": 123.45,
  "environment": "development"
}
```

### 契約書解析

```
POST /api/contracts/analyze
```

**リクエストボディ**:
```json
{
  "contractId": 123,
  "method": "pdf",
  "source": "base64_encoded_pdf_data",
  "previousVersion": "旧バージョンのテキスト（オプション）"
}
```

**レスポンス例**:
```json
{
  "success": true,
  "data": {
    "extractedText": "契約書の全文...",
    "changes": [
      {
        "section": "第15条（損害賠償）",
        "type": "modification",
        "old": "3ヶ月分",
        "new": "1ヶ月分"
      }
    ],
    "riskLevel": 3,
    "riskReason": "損害賠償額の大幅な減額...",
    "summary": "サービス提供事業者が..."
  }
}
```

## テスト

### ヘルスチェック

```bash
curl http://localhost:3001/api/health
```

### PDF解析テスト

```bash
curl -X POST http://localhost:3001/api/contracts/analyze \
  -H "Content-Type: application/json" \
  -d '{
    "contractId": 999,
    "method": "pdf",
    "source": "JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAwIG9iago8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PgplbmRvYmoKMyAwIG9iago8PC9UeXBlL1BhZ2UvTWVkaWFCb3hbMCAwIDYxMiA3OTJdL1BhcmVudCAyIDAgUi9SZXNvdXJjZXM8PC9Gb250PDwvRjEgNCAwIFI+Pj4+L0NvbnRlbnRzIDUgMCBSPj4KZW5kb2JqCjQgMCBvYmoKPDwvVHlwZS9Gb250L1N1YnR5cGUvVHlwZTEvQmFzZUZvbnQvSGVsdmV0aWNhPj4KZW5kb2JqCjUgMCBvYmoKPDwvTGVuZ3RoIDQ0Pj4Kc3RyZWFtCkJUCi9GMSA0OCBUZgoxMCA3MDAgVGQKKFRlc3QpIFRqCkVUCmVuZHN0cmVhbQplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDE1IDAwMDAwIG4gCjAwMDAwMDAwNjQgMDAwMDAgbiAKMDAwMDAwMDEyMSAwMDAwMCBuIAowMDAwMDAwMjQ1IDAwMDAwIG4gCjAwMDAwMDAzMjcgMDAwMDAgbiAKdHJhaWxlcgo8PC9TaXplIDYvUm9vdCAxIDAgUj4+CnN0YXJ0eHJlZgo0MTkKJSVFT0YK"
  }'
```

## ディレクトリ構造

```
backend/
├── src/
│   ├── server.js              # メインサーバー
│   ├── routes/
│   │   └── contracts.js       # 契約解析エンドポイント
│   ├── services/
│   │   ├── gemini.js          # Gemini API統合
│   │   ├── pdf.js             # PDF解析
│   │   └── url.js             # URL解析
│   ├── middleware/
│   │   ├── errorHandler.js    # エラーハンドリング
│   │   └── rateLimit.js       # レート制限
│   └── utils/
│       ├── logger.js          # ロギング
│       └── validator.js       # バリデーション
├── logs/                      # ログファイル（自動生成）
├── package.json
├── .env                       # 環境変数（要作成）
└── README.md
```

## 本番デプロイ

### PM2を使用したデーモン化

```bash
npm install -g pm2
pm2 start src/server.js --name diffsense-api
pm2 save
pm2 startup
```

### 環境変数（本番）

```env
GEMINI_API_KEY=your_production_key
PORT=3001
NODE_ENV=production
ALLOWED_ORIGINS=https://yourdomain.com
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=10
MAX_FILE_SIZE_MB=50
```

## トラブルシューティング

### Gemini API エラー

- API Keyが正しく設定されているか確認
- `.env`ファイルが正しい場所にあるか確認
- Gemini APIの利用制限を確認

### PDF解析エラー

- PDFファイルが50MB以下か確認
- PDFが暗号化されていないか確認
- PDFにテキストレイヤーがあるか確認（画像のみのPDFは解析不可）

### CORS エラー

- `ALLOWED_ORIGINS`にフロントエンドのURLが含まれているか確認
- ブラウザのコンソールでエラー詳細を確認
