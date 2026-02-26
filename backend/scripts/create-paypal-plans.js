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
        description: 'AI契約差分検知SaaS - 月額・年額サブスクリプション',
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

async function createPlan(token, productId, name, price, billingCycle = 'monthly') {
    const isAnnual = billingCycle === 'annual';
    const intervalUnit = isAnnual ? 'YEAR' : 'MONTH';
    const cycleLabel = isAnnual ? '年額' : '月額';
    const periodLabel = isAnnual ? '年' : '月';

    console.log(`Creating plan: ${name} ${cycleLabel} (¥${price}/${periodLabel})...`);
    const res = await axios.post(`${BASE_URL}/v1/billing/plans`, {
        product_id: productId,
        name: `DIFFsense ${name} ${cycleLabel}`,
        description: `DIFFsense ${name}プラン - ${cycleLabel} ¥${price}/${periodLabel}`,
        billing_cycles: [
            {
                frequency: {
                    interval_unit: intervalUnit,
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

        const starterMonthlyPlanId = await createPlan(token, productId, 'Starter', '1480', 'monthly');
        const businessMonthlyPlanId = await createPlan(token, productId, 'Business', '4980', 'monthly');
        const proMonthlyPlanId = await createPlan(token, productId, 'Pro', '9800', 'monthly');
        console.log('');
        const starterAnnualPlanId = await createPlan(token, productId, 'Starter', '14800', 'annual');
        const businessAnnualPlanId = await createPlan(token, productId, 'Business', '49800', 'annual');
        const proAnnualPlanId = await createPlan(token, productId, 'Pro', '98000', 'annual');

        console.log('\n=== 完了 ===');
        console.log('以下を .env に設定してください:\n');
        console.log(`PAYPAL_PLAN_STARTER=${starterMonthlyPlanId}`);
        console.log(`PAYPAL_PLAN_BUSINESS=${businessMonthlyPlanId}`);
        console.log(`PAYPAL_PLAN_PRO=${proMonthlyPlanId}`);
        console.log(`PAYPAL_PLAN_STARTER_ANNUAL=${starterAnnualPlanId}`);
        console.log(`PAYPAL_PLAN_BUSINESS_ANNUAL=${businessAnnualPlanId}`);
        console.log(`PAYPAL_PLAN_PRO_ANNUAL=${proAnnualPlanId}`);
    } catch (error) {
        console.error('Error:', error.response?.data || error.message);
    }
}

main();
