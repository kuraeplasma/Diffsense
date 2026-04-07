const express = require('express');
const router = express.Router();
const paypalService = require('../services/paypal');
const stripeService = require('../services/stripe');
const dbService = require('../services/db');
const logger = require('../utils/logger');

function isValidEmail(value) {
    return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function resolveFrontendBase(req) {
    const configured = String(process.env.FRONTEND_URL || '').trim();
    if (configured) {
        return configured.replace(/\/$/, '');
    }
    if (process.env.NODE_ENV === 'production') {
        return 'https://diffsense.spacegleam.co.jp';
    }
    const origin = req.headers.origin;
    if (origin && /^https?:\/\/[^/]+$/i.test(origin)) {
        return origin;
    }
    return 'http://localhost:3000';
}

function resolveSafeCancelUrl(req, frontendBase) {
    const _isSafeUrl = (url, base) => {
        try {
            const parsed = new URL(url);
            const baseParsed = new URL(base);
            return parsed.origin === baseParsed.origin;
        } catch (_) { return false; }
    };
    const requestedCancelUrl = req.body?.cancelUrl;
    if (typeof requestedCancelUrl === 'string' && _isSafeUrl(requestedCancelUrl, frontendBase)) {
        return requestedCancelUrl;
    }
    const referer = req.headers.referer;
    if (typeof referer === 'string' && _isSafeUrl(referer, frontendBase)) {
        return referer;
    }
    return `${frontendBase}/`;
}

const ALLOWED_PRICE_IDS = Object.freeze({
    starter_monthly: process.env.STRIPE_PRICE_STARTER || 'price_1T9iXH2NMkk9rteNzfHmJ6IH',
    starter_yearly: process.env.STRIPE_PRICE_STARTER_ANNUAL || 'price_1T9iXI2NMkk9rteNNDv4X0lP',
    business_monthly: process.env.STRIPE_PRICE_BUSINESS || 'price_1T9iXI2NMkk9rteNKImWXoud',
    business_yearly: process.env.STRIPE_PRICE_BUSINESS_ANNUAL || 'price_1T9iXJ2NMkk9rteNReZKwrBq',
    pro_monthly: process.env.STRIPE_PRICE_PRO || 'price_1T9iXI2NMkk9rteN3MXhXIZE',
    pro_yearly: process.env.STRIPE_PRICE_PRO_ANNUAL || 'price_1T9iXJ2NMkk9rteNMtxh3vIU'
});

const ALLOWED_PRICE_ID_VALUES = new Set(
    Object.values(ALLOWED_PRICE_IDS).filter((priceId) => typeof priceId === 'string' && priceId.trim())
);

/**
 * POST /payment/create-subscription
 * Create a PayPal subscription and return approval URL
 */
router.post('/create-subscription', async (req, res) => {
    try {
        const uid = req.user.uid;
        const userProfile = await dbService.getUserProfile(uid);
        // Use requested plan if provided (for upgrades), otherwise use current plan
        const requestedPlan = req.body.plan;
        const requestedBillingCycle = req.body.billingCycle;
        const validPlans = ['starter', 'business', 'pro'];
        const validBillingCycles = ['monthly', 'annual'];
        const plan = (requestedPlan && validPlans.includes(requestedPlan))
            ? requestedPlan
            : (userProfile.plan || 'free');
        const billingCycle = (requestedBillingCycle && validBillingCycles.includes(requestedBillingCycle))
            ? requestedBillingCycle
            : (userProfile.billingCycle || 'monthly');

        if (!paypalService.isConfigured()) {
            return res.status(503).json({
                success: false,
                error: 'PayPal is not configured. Please set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.'
            });
        }

        const dashboardUrl = process.env.DASHBOARD_URL || `${resolveFrontendBase(req)}/dashboard.html`;

        const returnUrl = `${dashboardUrl}?payment=success&plan=${plan}&billing=${billingCycle}`;
        const cancelUrl = `${dashboardUrl}?payment=cancelled&plan=${plan}&billing=${billingCycle}`;

        // If user has an existing active subscription and is changing plan/cycle, cancel the old one
        const currentBillingCycle = userProfile.billingCycle || 'monthly';
        const hasPlanOrCycleChange = plan !== userProfile.plan || billingCycle !== currentBillingCycle;
        if (userProfile.paypalSubscriptionId && userProfile.paypalStatus === 'ACTIVE' && hasPlanOrCycleChange) {
            try {
                await paypalService.cancelSubscription(userProfile.paypalSubscriptionId, 'プラン変更');
                logger.info(`Old subscription ${userProfile.paypalSubscriptionId} cancelled for plan change`);
            } catch (e) {
                logger.warn('Failed to cancel old subscription during upgrade:', e.message);
            }
        }

        const result = await paypalService.createSubscription(plan, billingCycle, returnUrl, cancelUrl);

        // Save pending subscription ID and the target plan/cycle
        await dbService.updatePaymentInfo(uid, {
            paypalSubscriptionId: result.subscriptionId,
            paypalStatus: 'APPROVAL_PENDING',
            pendingPlan: plan,
            pendingBillingCycle: billingCycle,
            previousPlan: userProfile.plan,
            previousBillingCycle: currentBillingCycle
        });

        res.json({
            success: true,
            data: {
                subscriptionId: result.subscriptionId,
                approvalUrl: result.approvalUrl,
                plan,
                billingCycle
            }
        });
    } catch (error) {
        logger.error('Create subscription error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /payment/confirm-subscription
 * Confirm subscription after PayPal approval
 */
router.post('/confirm-subscription', async (req, res) => {
    try {
        const uid = req.user.uid;
        const { subscriptionId, plan: requestedPlan, billingCycle: requestedBillingCycle } = req.body;

        if (!subscriptionId) {
            return res.status(400).json({ success: false, error: 'subscriptionId is required' });
        }

        let status = 'ACTIVE';

        // If PayPal is configured, verify with PayPal
        if (paypalService.isConfigured()) {
            const subscription = await paypalService.getSubscription(subscriptionId);
            status = subscription.status;
        }

        if (status === 'ACTIVE' || status === 'APPROVED') {
            // Get the pending plan/cycle that was set during create-subscription
            const userProfile = await dbService.getUserProfile(uid);
            const validPlans = ['starter', 'business', 'pro'];
            const validBillingCycles = ['monthly', 'annual'];
            const targetPlan = (requestedPlan && validPlans.includes(requestedPlan))
                ? requestedPlan
                : (userProfile.pendingPlan || userProfile.plan || 'free');
            const targetBillingCycle = (requestedBillingCycle && validBillingCycles.includes(requestedBillingCycle))
                ? requestedBillingCycle
                : (userProfile.pendingBillingCycle || userProfile.billingCycle || 'monthly');

            await dbService.updatePaymentInfo(uid, {
                hasPaymentMethod: true,
                paypalSubscriptionId: subscriptionId,
                paypalStatus: 'ACTIVE',
                paymentRegisteredAt: new Date().toISOString(),

                pendingPlan: null,
                pendingBillingCycle: null
            });

            // Update user's plan and billing cycle to the target values
            await dbService.setUserPlan(uid, targetPlan, targetBillingCycle);

            logger.info(`User ${uid} subscription confirmed: ${subscriptionId}, plan: ${targetPlan}, billingCycle: ${targetBillingCycle}`);
            res.json({ success: true, data: { status: 'ACTIVE', plan: targetPlan, billingCycle: targetBillingCycle } });
        } else {
            res.status(400).json({
                success: false,
                error: `サブスクリプションのステータスが無効です: ${status}`
            });
        }
    } catch (error) {
        logger.error('Confirm subscription error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /payment/cancel-subscription
 * Cancel the user's subscription
 */
router.post('/cancel-subscription', async (req, res) => {
    try {
        const uid = req.user.uid;
        const userProfile = await dbService.getUserProfile(uid);

        const paypalId = userProfile.paypalSubscriptionId;
        const stripeId = userProfile.stripeSubscriptionId;

        if (!paypalId && !stripeId) {
            return res.status(400).json({ success: false, error: 'アクティブなサブスクリプションがありません' });
        }

        // 1. Cancel on PayPal if exists
        if (paypalId && paypalService.isConfigured()) {
            try {
                await paypalService.cancelSubscription(paypalId);
            } catch (e) {
                logger.warn('PayPal cancel failed (may already be cancelled):', e.message);
            }
        }

        // 2. Cancel on Stripe if exists
        if (stripeId && stripeService.isConfigured()) {
            try {
                await stripeService.cancelSubscription(stripeId);
            } catch (e) {
                logger.warn('Stripe cancel failed (may already be cancelled):', e.message);
            }
        }

        // Update local DB
        await dbService.updatePaymentInfo(uid, {
            hasPaymentMethod: false,
            paypalStatus: 'CANCELLED',
            stripeStatus: 'CANCELLED',
            cancelledAt: new Date().toISOString(),
            pendingPlan: null,
            pendingBillingCycle: null
        });

        // Reset to free monthly plan
        await dbService.setUserPlan(uid, 'free', 'monthly');

        logger.info(`User ${uid} subscription cancelled`);
        res.json({ success: true, data: { plan: 'free', status: 'CANCELLED' } });
    } catch (error) {
        logger.error('Cancel subscription error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /payment/status
 * Get payment/subscription status
 */
router.get('/status', async (req, res) => {
    try {
        const uid = req.user.uid;
        const userProfile = await dbService.getUserProfile(uid);

        res.json({
            success: true,
            data: {
                hasPaymentMethod: userProfile.hasPaymentMethod || false,
                paypalSubscriptionId: userProfile.paypalSubscriptionId || null,
                paypalStatus: userProfile.paypalStatus || null,
                billingCycle: userProfile.billingCycle || 'monthly',
                pendingPlan: userProfile.pendingPlan || null,
                pendingBillingCycle: userProfile.pendingBillingCycle || null,
                paymentRegisteredAt: userProfile.paymentRegisteredAt || null,
                cancelledAt: userProfile.cancelledAt || null,
                stripeStatus: userProfile.stripeStatus || null,
                subscriptionState: userProfile.subscriptionState || null,
                stripePlan: userProfile.stripePlan || null,
                trialEndsAt: userProfile.trialEndsAt || null
            }
        });
    } catch (error) {
        logger.error('Payment status error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

async function createStripeCheckoutSessionHandler(req, res) {
    try {
        if (!stripeService.isConfigured()) {
            return res.status(503).json({
                success: false,
                error: 'Stripe is not configured. Please set STRIPE_SECRET_KEY.'
            });
        }

        const uid = req.user.uid;
        const email = req.user.email || '';
        const requestEmail = req.body?.email || '';
        const emailForStripe = isValidEmail(requestEmail)
            ? requestEmail
            : (isValidEmail(email) ? email : '');
        const userProfile = await dbService.getUserProfile(uid);

        if (req.body?.userId && req.body.userId !== uid) {
            logger.warn(`createCheckoutSession: userId mismatch ignored (body=${req.body.userId}, auth=${uid})`);
        }

        const requestedPriceId = (req.body?.priceId || '').trim();
        if (requestedPriceId && !ALLOWED_PRICE_ID_VALUES.has(requestedPriceId)) {
            return res.status(400).json({
                success: false,
                error: '許可されていない価格IDです'
            });
        }
        const requestedPlan = req.body.plan;
        const requestedBillingCycle = req.body.billingCycle;
        const validPlans = ['starter', 'business', 'pro'];
        const validBillingCycles = ['monthly', 'annual'];
        let plan = (requestedPlan && validPlans.includes(requestedPlan))
            ? requestedPlan
            : (userProfile.plan || 'free');
        let billingCycle = (requestedBillingCycle && validBillingCycles.includes(requestedBillingCycle))
            ? requestedBillingCycle
            : (userProfile.billingCycle || 'monthly');

        const resolvedFromPriceId = requestedPriceId
            ? stripeService.resolvePlanByPriceId(requestedPriceId)
            : null;
        if (resolvedFromPriceId) {
            plan = resolvedFromPriceId.plan;
            billingCycle = resolvedFromPriceId.billingCycle;
        }

        const priceId = requestedPriceId || stripeService.getPriceId(plan, billingCycle);
        const inlinePrice = priceId ? null : stripeService.getInlinePlanPrice(plan, billingCycle);
        if (!priceId && !inlinePrice) {
            return res.status(400).json({
                success: false,
                error: 'Stripe決済設定が不正です（プラン価格を解決できません）。'
            });
        }

        const frontendBase = resolveFrontendBase(req);
        const successUrl = `${frontendBase}/thanks-payment.html?plan=${plan}&billing=${billingCycle}&session_id={CHECKOUT_SESSION_ID}`;
        const cancelUrl = resolveSafeCancelUrl(req, frontendBase);

        const session = await stripeService.createCheckoutSession({
            priceId,
            inlinePrice,
            successUrl,
            cancelUrl,
            customerEmail: emailForStripe,
            metadata: { uid, plan, billingCycle, source: 'checkout' },
            trialPeriodDays: null
        });

        await dbService.updatePaymentInfo(uid, {
            pendingPlan: plan,
            pendingBillingCycle: billingCycle,
            stripeCheckoutSessionId: session.id,
            stripeCheckoutCreatedAt: new Date().toISOString()
        });

        res.json({
            success: true,
            data: {
                sessionId: session.id,
                url: session.url,
                plan,
                billingCycle
            }
        });
    } catch (error) {
        logger.error('Create Stripe checkout session error:', error.response?.data || error.message);
        res.status(500).json({ success: false, error: error.message });
    }
}

/**
 * POST /payment/create-stripe-checkout-session
 * POST /payment/create-checkout-session
 * POST /payment/createCheckoutSession
 * Create a Stripe Checkout session and return redirect URL
 */
router.post('/create-stripe-checkout-session', createStripeCheckoutSessionHandler);
router.post('/create-checkout-session', createStripeCheckoutSessionHandler);
router.post('/createCheckoutSession', createStripeCheckoutSessionHandler);

/**
 * POST /payment/confirm-stripe-session
 * Confirm Stripe Checkout session after redirect
 */
router.post('/confirm-stripe-session', async (req, res) => {
    try {
        if (!stripeService.isConfigured()) {
            return res.status(503).json({ success: false, error: 'Stripe is not configured.' });
        }

        const uid = req.user.uid;
        const { sessionId, plan: requestedPlan, billingCycle: requestedBillingCycle } = req.body || {};
        if (!sessionId) {
            return res.status(400).json({ success: false, error: 'sessionId is required' });
        }

        const session = await stripeService.getCheckoutSession(sessionId);
        if (!session || session.payment_status !== 'paid') {
            return res.status(400).json({
                success: false,
                error: `Stripe決済が未完了です（status: ${session?.payment_status || 'unknown'}）`
            });
        }

        const sessionOwnerUid = String(session?.metadata?.uid || '').trim();
        if (!sessionOwnerUid || sessionOwnerUid !== String(uid).trim()) {
            return res.status(403).json({
                success: false,
                error: 'この決済セッションにアクセスする権限がありません'
            });
        }

        const userProfile = await dbService.getUserProfile(uid);
        const validPlans = ['starter', 'business', 'pro'];
        const validBillingCycles = ['monthly', 'annual'];
        const targetPlan = (requestedPlan && validPlans.includes(requestedPlan))
            ? requestedPlan
            : (session?.metadata?.plan || userProfile.pendingPlan || userProfile.plan || 'free');
        const targetBillingCycle = (requestedBillingCycle && validBillingCycles.includes(requestedBillingCycle))
            ? requestedBillingCycle
            : (session?.metadata?.billingCycle || userProfile.pendingBillingCycle || userProfile.billingCycle || 'monthly');

        await dbService.updatePaymentInfo(uid, {
            hasPaymentMethod: true,
            paymentRegisteredAt: new Date().toISOString(),
            pendingPlan: null,
            pendingBillingCycle: null,
            stripeCheckoutSessionId: session.id,
            stripeCustomerId: session.customer || null,
            stripeSubscriptionId: typeof session.subscription === 'string'
                ? session.subscription
                : (session.subscription?.id || null),
            stripeStatus: 'ACTIVE'
        });

        await dbService.setUserPlan(uid, targetPlan, targetBillingCycle);

        logger.info(`User ${uid} Stripe checkout confirmed: ${session.id}, plan: ${targetPlan}, billingCycle: ${targetBillingCycle}`);
        res.json({ success: true, data: { status: 'ACTIVE', plan: targetPlan, billingCycle: targetBillingCycle } });
    } catch (error) {
        logger.error('Confirm Stripe session error:', error.response?.data || error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
