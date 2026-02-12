const express = require('express');
const router = express.Router();
const paypalService = require('../services/paypal');
const dbService = require('../services/db');
const logger = require('../utils/logger');

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
        const validPlans = ['starter', 'business', 'pro'];
        const plan = (requestedPlan && validPlans.includes(requestedPlan))
            ? requestedPlan
            : (userProfile.plan || 'starter');

        if (!paypalService.isConfigured()) {
            return res.status(503).json({
                success: false,
                error: 'PayPal is not configured. Please set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.'
            });
        }

        const dashboardUrl = process.env.DASHBOARD_URL || 'http://localhost:3000/dashboard';

        const returnUrl = `${dashboardUrl}?payment=success&plan=${plan}`;
        const cancelUrl = `${dashboardUrl}?payment=cancelled`;

        // If user has an existing active subscription and is changing plans, cancel the old one
        if (userProfile.paypalSubscriptionId && userProfile.paypalStatus === 'ACTIVE' && plan !== userProfile.plan) {
            try {
                await paypalService.cancelSubscription(userProfile.paypalSubscriptionId, 'プラン変更');
                logger.info(`Old subscription ${userProfile.paypalSubscriptionId} cancelled for plan change`);
            } catch (e) {
                logger.warn('Failed to cancel old subscription during upgrade:', e.message);
            }
        }

        const result = await paypalService.createSubscription(plan, returnUrl, cancelUrl);

        // Save pending subscription ID and the target plan
        await dbService.updatePaymentInfo(uid, {
            paypalSubscriptionId: result.subscriptionId,
            paypalStatus: 'APPROVAL_PENDING',
            pendingPlan: plan,
            previousPlan: userProfile.plan
        });

        res.json({
            success: true,
            data: {
                subscriptionId: result.subscriptionId,
                approvalUrl: result.approvalUrl
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
        const { subscriptionId } = req.body;

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
            // Get the pending plan that was set during create-subscription
            const userProfile = await dbService.getUserProfile(uid);
            const targetPlan = req.body.plan || userProfile.pendingPlan || userProfile.plan || 'starter';

            await dbService.updatePaymentInfo(uid, {
                hasPaymentMethod: true,
                paypalSubscriptionId: subscriptionId,
                paypalStatus: 'ACTIVE',
                paymentRegisteredAt: new Date().toISOString(),
                pendingPlan: null
            });

            // Update user's plan to the target plan
            await dbService.setUserPlan(uid, targetPlan);

            logger.info(`User ${uid} subscription confirmed: ${subscriptionId}, plan: ${targetPlan}`);
            res.json({ success: true, data: { status: 'ACTIVE', plan: targetPlan } });
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

        if (!userProfile.paypalSubscriptionId) {
            return res.status(400).json({ success: false, error: 'アクティブなサブスクリプションがありません' });
        }

        // Cancel on PayPal if configured
        if (paypalService.isConfigured()) {
            try {
                await paypalService.cancelSubscription(userProfile.paypalSubscriptionId);
            } catch (e) {
                logger.warn('PayPal cancel failed (may already be cancelled):', e.message);
            }
        }

        // Update local DB
        await dbService.updatePaymentInfo(uid, {
            hasPaymentMethod: false,
            paypalStatus: 'CANCELLED',
            cancelledAt: new Date().toISOString()
        });

        // Reset to starter plan
        await dbService.setUserPlan(uid, 'starter');

        logger.info(`User ${uid} subscription cancelled`);
        res.json({ success: true, data: { plan: 'starter', status: 'CANCELLED' } });
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
                paymentRegisteredAt: userProfile.paymentRegisteredAt || null,
                cancelledAt: userProfile.cancelledAt || null
            }
        });
    } catch (error) {
        logger.error('Payment status error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
