const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const axios = require('axios');

async function registerWebhook() {
    try {
        const baseUrl = String(process.env.FIRMA_BASE_URL || 'https://api.firma.dev/functions/v1/signing-request-api').replace(/\/$/, '');
        const apiKey = String(process.env.FIRMA_API_KEY || '').trim();
        const auth = apiKey.toLowerCase().startsWith('bearer ') ? apiKey : `Bearer ${apiKey}`;
        const appUrl = String(process.env.APP_URL || process.env.BACKEND_BASE_URL || '').replace(/\/$/, '');
        const webhookUrl = `${appUrl}/webhook/firma`;

        const response = await axios.post(`${baseUrl}/webhooks`, {
            url: webhookUrl,
            events: [
                'signing_request.completed',
                'signing_request.signed',
                'signing_request.cancelled',
                'signing_request.expired'
            ],
            description: 'DIFFsense Firma webhook'
        }, {
            headers: {
                Authorization: auth,
                'Content-Type': 'application/json'
            }
        });

        console.log('✅ Webhook登録成功');
        console.log(JSON.stringify(response.data, null, 2));
    } catch (error) {
        console.error('❌ 登録失敗:', error.response?.data || error.message);
    }
}

registerWebhook();
