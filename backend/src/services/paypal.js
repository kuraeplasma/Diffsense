const axios = require('axios');
const logger = require('../utils/logger');

/**
 * PayPal Subscription Service
 * Uses PayPal REST API for subscription management
 */
class PayPalService {
    constructor() {
        this.clientId = process.env.PAYPAL_CLIENT_ID;
        this.clientSecret = process.env.PAYPAL_CLIENT_SECRET;
        this.mode = process.env.PAYPAL_MODE || 'sandbox';
        this.baseUrl = this.mode === 'sandbox'
            ? 'https://api-m.sandbox.paypal.com'
            : 'https://api-m.paypal.com';
        this.accessToken = null;
        this.tokenExpiry = 0;
    }

    /**
     * Get PayPal OAuth access token
     */
    async getAccessToken() {
        if (this.accessToken && Date.now() < this.tokenExpiry) {
            return this.accessToken;
        }

        try {
            const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
            const response = await axios.post(
                `${this.baseUrl}/v1/oauth2/token`,
                'grant_type=client_credentials',
                {
                    headers: {
                        'Authorization': `Basic ${auth}`,
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                }
            );

            this.accessToken = response.data.access_token;
            this.tokenExpiry = Date.now() + (response.data.expires_in * 1000) - 60000; // 1min buffer
            return this.accessToken;
        } catch (error) {
            logger.error('PayPal OAuth token error:', error.response?.data || error.message);
            throw new Error('PayPal認証に失敗しました');
        }
    }

    /**
     * Plan ID mapping (must be created in PayPal Dashboard first)
     */
    getPlanId(plan) {
        const planIds = {
            starter: process.env.PAYPAL_PLAN_STARTER || 'P-STARTER-PLACEHOLDER',
            business: process.env.PAYPAL_PLAN_BUSINESS || 'P-BUSINESS-PLACEHOLDER',
            pro: process.env.PAYPAL_PLAN_PRO || 'P-PRO-PLACEHOLDER'
        };
        return planIds[plan];
    }

    /**
     * Create a PayPal subscription
     * @param {string} plan - Plan ID (starter, business, pro)
     * @param {string} returnUrl - URL after PayPal approval
     * @param {string} cancelUrl - URL if user cancels
     * @returns {object} - { subscriptionId, approvalUrl }
     */
    async createSubscription(plan, returnUrl, cancelUrl) {
        const token = await this.getAccessToken();
        const paypalPlanId = this.getPlanId(plan);

        try {
            const response = await axios.post(
                `${this.baseUrl}/v1/billing/subscriptions`,
                {
                    plan_id: paypalPlanId,
                    application_context: {
                        brand_name: 'DIFFsense',
                        locale: 'ja-JP',
                        shipping_preference: 'NO_SHIPPING',
                        user_action: 'SUBSCRIBE_NOW',
                        return_url: returnUrl,
                        cancel_url: cancelUrl
                    }
                },
                {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            const approvalLink = response.data.links.find(l => l.rel === 'approve');

            return {
                subscriptionId: response.data.id,
                approvalUrl: approvalLink ? approvalLink.href : null,
                status: response.data.status
            };
        } catch (error) {
            logger.error('PayPal create subscription error:', error.response?.data || error.message);
            throw new Error('サブスクリプションの作成に失敗しました');
        }
    }

    /**
     * Get subscription details
     * @param {string} subscriptionId
     */
    async getSubscription(subscriptionId) {
        const token = await this.getAccessToken();

        try {
            const response = await axios.get(
                `${this.baseUrl}/v1/billing/subscriptions/${subscriptionId}`,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            return {
                id: response.data.id,
                status: response.data.status,
                planId: response.data.plan_id,
                startTime: response.data.start_time,
                nextBillingTime: response.data.billing_info?.next_billing_time
            };
        } catch (error) {
            logger.error('PayPal get subscription error:', error.response?.data || error.message);
            throw new Error('サブスクリプション情報の取得に失敗しました');
        }
    }

    /**
     * Cancel a subscription
     * @param {string} subscriptionId
     * @param {string} reason
     */
    async cancelSubscription(subscriptionId, reason = 'ユーザーによるキャンセル') {
        const token = await this.getAccessToken();

        try {
            await axios.post(
                `${this.baseUrl}/v1/billing/subscriptions/${subscriptionId}/cancel`,
                { reason },
                {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            return { success: true };
        } catch (error) {
            logger.error('PayPal cancel subscription error:', error.response?.data || error.message);
            throw new Error('サブスクリプションのキャンセルに失敗しました');
        }
    }

    /**
     * Check if PayPal credentials are configured
     */
    isConfigured() {
        return !!(this.clientId && this.clientSecret &&
            !this.clientId.includes('PLACEHOLDER') &&
            !this.clientSecret.includes('PLACEHOLDER'));
    }
}

module.exports = new PayPalService();
