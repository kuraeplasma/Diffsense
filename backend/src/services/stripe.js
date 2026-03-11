const Stripe = require('stripe');

const DEFAULT_PRICE_IDS = {
    monthly: {
        starter: 'price_1T9iXH2NMkk9rteNzfHmJ6IH',
        business: 'price_1T9iXI2NMkk9rteNKImWXoud',
        pro: 'price_1T9iXI2NMkk9rteN3MXhXIZE'
    },
    annual: {
        starter: 'price_1T9iXI2NMkk9rteNNDv4X0lP',
        business: 'price_1T9iXJ2NMkk9rteNReZKwrBq',
        pro: 'price_1T9iXJ2NMkk9rteNMtxh3vIU'
    }
};

class StripeService {
    constructor() {
        this.secretKey = process.env.STRIPE_SECRET_KEY || '';
        this.client = this.secretKey
            ? new Stripe(this.secretKey, { apiVersion: '2024-06-20' })
            : null;
    }

    isConfigured() {
        return Boolean(this.secretKey);
    }

    getClient() {
        if (!this.secretKey) {
            throw new Error('Stripe secret key is not configured.');
        }
        if (!this.client) {
            this.client = new Stripe(this.secretKey, { apiVersion: '2024-06-20' });
        }
        return this.client;
    }

    getPriceId(plan, billingCycle = 'monthly') {
        const cycle = billingCycle === 'annual' ? 'annual' : 'monthly';
        const ids = {
            monthly: {
                starter: process.env.STRIPE_PRICE_STARTER || DEFAULT_PRICE_IDS.monthly.starter,
                business: process.env.STRIPE_PRICE_BUSINESS || DEFAULT_PRICE_IDS.monthly.business,
                pro: process.env.STRIPE_PRICE_PRO || DEFAULT_PRICE_IDS.monthly.pro
            },
            annual: {
                starter: process.env.STRIPE_PRICE_STARTER_ANNUAL || DEFAULT_PRICE_IDS.annual.starter,
                business: process.env.STRIPE_PRICE_BUSINESS_ANNUAL || DEFAULT_PRICE_IDS.annual.business,
                pro: process.env.STRIPE_PRICE_PRO_ANNUAL || DEFAULT_PRICE_IDS.annual.pro
            }
        };
        return ids[cycle][plan] || null;
    }

    getAllPriceMappings() {
        return {
            monthly: {
                starter: process.env.STRIPE_PRICE_STARTER || DEFAULT_PRICE_IDS.monthly.starter,
                business: process.env.STRIPE_PRICE_BUSINESS || DEFAULT_PRICE_IDS.monthly.business,
                pro: process.env.STRIPE_PRICE_PRO || DEFAULT_PRICE_IDS.monthly.pro
            },
            annual: {
                starter: process.env.STRIPE_PRICE_STARTER_ANNUAL || DEFAULT_PRICE_IDS.annual.starter,
                business: process.env.STRIPE_PRICE_BUSINESS_ANNUAL || DEFAULT_PRICE_IDS.annual.business,
                pro: process.env.STRIPE_PRICE_PRO_ANNUAL || DEFAULT_PRICE_IDS.annual.pro
            }
        };
    }

    resolvePlanByPriceId(priceId) {
        if (!priceId) return null;
        const mappings = this.getAllPriceMappings();
        for (const billingCycle of ['monthly', 'annual']) {
            for (const plan of ['starter', 'business', 'pro']) {
                if (mappings[billingCycle][plan] === priceId) {
                    return { plan, billingCycle };
                }
            }
        }
        return null;
    }

    resolvePlanBySubscription(subscription) {
        const priceId = subscription?.items?.data?.[0]?.price?.id;
        const fromPrice = this.resolvePlanByPriceId(priceId);
        if (fromPrice) return fromPrice;

        const plan = subscription?.metadata?.plan;
        const billingCycle = subscription?.metadata?.billingCycle === 'annual' ? 'annual' : 'monthly';
        if (plan && ['starter', 'business', 'pro'].includes(plan)) {
            return { plan, billingCycle };
        }
        return null;
    }

    getInlinePlanPrice(plan, billingCycle = 'monthly') {
        const cycle = billingCycle === 'annual' ? 'annual' : 'monthly';
        const unitAmountMap = {
            monthly: {
                starter: 1480,
                business: 4980,
                pro: 9800
            },
            annual: {
                starter: 14800,
                business: 49800,
                pro: 98000
            }
        };
        const planLabelMap = {
            starter: 'Starter',
            business: 'Business',
            pro: 'Pro / Legal'
        };
        const amount = unitAmountMap[cycle]?.[plan];
        if (!amount) return null;
        return {
            currency: 'jpy',
            unit_amount: amount,
            recurring: {
                interval: cycle === 'annual' ? 'year' : 'month',
                interval_count: 1
            },
            product_data: {
                name: `DIFFsense ${planLabelMap[plan] || plan} (${cycle === 'annual' ? '年額' : '月額'})`
            }
        };
    }

    async createCheckoutSession({
        priceId,
        inlinePrice,
        successUrl,
        cancelUrl,
        customerEmail,
        metadata = {},
        trialPeriodDays = 7
    }) {
        const stripe = this.getClient();
        const sanitizedMetadata = {};
        Object.entries(metadata || {}).forEach(([key, value]) => {
            if (value !== undefined && value !== null) {
                sanitizedMetadata[key] = String(value);
            }
        });

        const lineItem = priceId
            ? { price: priceId, quantity: 1 }
            : { price_data: inlinePrice, quantity: 1 };

        return stripe.checkout.sessions.create({
            mode: 'subscription',
            success_url: successUrl,
            cancel_url: cancelUrl,
            line_items: [lineItem],
            payment_method_types: ['card'],
            customer_email: customerEmail || undefined,
            metadata: sanitizedMetadata,
            subscription_data: {
                metadata: sanitizedMetadata,
                trial_period_days: Number.isInteger(trialPeriodDays) && trialPeriodDays > 0
                    ? trialPeriodDays
                    : undefined
            },
            allow_promotion_codes: true
        });
    }

    async getCheckoutSession(sessionId) {
        const stripe = this.getClient();
        return stripe.checkout.sessions.retrieve(sessionId, { expand: ['subscription'] });
    }

    async getSubscription(subscriptionId) {
        const stripe = this.getClient();
        return stripe.subscriptions.retrieve(subscriptionId);
    }

    constructWebhookEvent(payload, signature, webhookSecret) {
        const stripe = this.getClient();
        return stripe.webhooks.constructEvent(payload, signature, webhookSecret);
    }
}

module.exports = new StripeService();
