/**
 * PayPal サブスクリプションプラン作成スクリプト
 * 使い方: node scripts/create-paypal-plans.js
 * PAYPAL_MODE=live で本番、sandbox でサンドボックス
 */
require('dotenv').config();
const axios = require('axios');

const CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const MODE = process.env.PAYPAL_MODE || 'sandbox';
const BASE_URL = MODE === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';

async function getAccessToken() {
    const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const res = await axios.post(`${BASE_URL}/v1/oauth2/token`, 'grant_type=client_credentials', {
        headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    });
    return res.data.access_token;
}

async function createProduct(token) {
    console.log('Creating product...');
    const res = await axios.post(`${BASE_URL}/v1/catalogs/products`, {
        name: 'DIFFsense AI Contract Analysis',
        description: 'AI契約差分検知SaaS - 月額サブスクリプション',
        type: 'SERVICE',
        category: 'SOFTWARE'
    }, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        }
    });
    console.log(`Product created: ${res.data.id}`);
    return res.data.id;
}

async function createPlan(token, productId, name, price) {
    console.log(`Creating plan: ${name} (¥${price}/月)...`);
    const res = await axios.post(`${BASE_URL}/v1/billing/plans`, {
        product_id: productId,
        name: `DIFFsense ${name}`,
        description: `DIFFsense ${name}プラン - ¥${price}/月`,
        billing_cycles: [
            {
                frequency: {
                    interval_unit: 'MONTH',
                    interval_count: 1
                },
                tenure_type: 'REGULAR',
                sequence: 1,
                total_cycles: 0,
                pricing_scheme: {
                    fixed_price: {
                        value: price,
                        currency_code: 'JPY'
                    }
                }
            }
        ],
        payment_preferences: {
            auto_bill_outstanding: true,
            payment_failure_threshold: 3
        }
    }, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        }
    });
    console.log(`  Plan ID: ${res.data.id} (${res.data.status})`);
    return res.data.id;
}

async function main() {
    try {
        console.log(`=== PayPal ${MODE.toUpperCase()} プラン作成 ===`);
        console.log(`API: ${BASE_URL}\n`);

        const token = await getAccessToken();
        console.log('OAuth token取得成功\n');

        const productId = await createProduct(token);
        console.log('');

        const starterPlanId = await createPlan(token, productId, 'Starter', '1480');
        const businessPlanId = await createPlan(token, productId, 'Business', '4980');
        const proPlanId = await createPlan(token, productId, 'Pro', '9800');

        console.log('\n=== 完了 ===');
        console.log('以下を .env に設定してください:\n');
        console.log(`PAYPAL_PLAN_STARTER=${starterPlanId}`);
        console.log(`PAYPAL_PLAN_BUSINESS=${businessPlanId}`);
        console.log(`PAYPAL_PLAN_PRO=${proPlanId}`);
    } catch (error) {
        console.error('Error:', error.response?.data || error.message);
    }
}

main();
