/**
 * Netlify Function: /api/paypal-checkout
 * DIFFsense 導入支援プラン ¥100,000 PayPal決済
 *
 * 環境変数（Netlify Site Settings > Environment Variables に設定）:
 *   PAYPAL_CLIENT_ID     : PayPal ライブ Client ID
 *   PAYPAL_CLIENT_SECRET : PayPal ライブ Client Secret
 *   URL                  : サイトURL（Netlify が自動注入）
 */

const PAYPAL_API = "https://api-m.paypal.com";
const AMOUNT = "100000";
const CURRENCY = "JPY";
const DESCRIPTION = "DIFFsense 導入支援付きオンボーディングプラン";

async function getAccessToken(clientId, secret) {
    const auth = Buffer.from(`${clientId}:${secret}`).toString("base64");
    const res = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
        method: "POST",
        headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
    });
    const data = await res.json();
    if (!data.access_token) throw new Error("PayPalトークン取得失敗: " + JSON.stringify(data));
    return data.access_token;
}

exports.handler = async (event, context) => {
    const clientId = process.env.PAYPAL_CLIENT_ID;
    const secret = process.env.PAYPAL_CLIENT_SECRET;
    const siteUrl = process.env.URL || "https://diffsense.spacegleam.co.jp";

    if (!clientId || !secret) {
        return {
            statusCode: 500,
            body: "PayPal環境変数が設定されていません",
        };
    }

    try {
        const token = await getAccessToken(clientId, secret);

        const orderRes = await fetch(`${PAYPAL_API}/v2/checkout/orders`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
                "PayPal-Request-Id": `diffsense-${Date.now()}`,
            },
            body: JSON.stringify({
                intent: "CAPTURE",
                purchase_units: [
                    {
                        amount: { currency_code: CURRENCY, value: AMOUNT },
                        description: DESCRIPTION,
                    },
                ],
                application_context: {
                    brand_name: "DIFFsense",
                    locale: "ja-JP",
                    user_action: "PAY_NOW",
                    return_url: `${siteUrl}/thanks-payment.html`,
                    cancel_url: `${siteUrl}/lp-saas-risk-pack-mock.html`,
                },
            }),
        });

        const order = await orderRes.json();
        const approveLink = order.links?.find((l) => l.rel === "approve")?.href;

        if (!approveLink) {
            throw new Error("approveリンクが見つかりません: " + JSON.stringify(order));
        }

        // PayPal 決済画面へリダイレクト
        return {
            statusCode: 302,
            headers: { Location: approveLink },
            body: "",
        };
    } catch (err) {
        console.error("PayPal Checkout Error:", err);
        return {
            statusCode: 500,
            body: `決済の準備中にエラーが発生しました: ${err.message}`,
        };
    }
};
