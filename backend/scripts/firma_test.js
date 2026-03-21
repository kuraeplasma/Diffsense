const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const axios = require('axios');

async function test() {
    try {
        const baseUrl = String(process.env.FIRMA_BASE_URL || 'https://api.firma.dev/functions/v1/signing-request-api').replace(/\/$/, '');
        const apiKey = String(process.env.FIRMA_API_KEY || '').trim();
        const auth = apiKey.toLowerCase().startsWith('bearer ') ? apiKey : `Bearer ${apiKey}`;
        const response = await axios.get(`${baseUrl}/signing-requests`, {
            headers: { Authorization: auth },
            params: { limit: 1 }
        });
        console.log('✅ Firma.dev 接続成功');
        console.log(JSON.stringify(response.data, null, 2));
    } catch (error) {
        console.error('❌ 接続失敗:', error.response?.data || error.message);
    }
}

test();
