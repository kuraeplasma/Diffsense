/**
 * Firebase Cloud Functions エントリーポイント
 */
const { onRequest } = require('firebase-functions/v2/https');
const { app } = require('./src/server');

// Cloud Function: api
// URL: https://api-<project>.cloudfunctions.net/api
exports.api = onRequest(
    {
        region: 'asia-northeast1',  // 東京リージョン
        timeoutSeconds: 120,
        memory: '512MiB',
    },
    app
);
