const express = require('express');
const router = express.Router();
const stripeService = require('../services/stripe');
const dbService = require('../services/db');
const logger = require('../utils/logger');

function normalizePlan(plan) {
    return ['starter', 'business', 'pro'].includes(plan) ? plan : 'starter';
}

function normalizeBillingCycle(cycle) {
    return cycle === 'annual' ? 'annual' : 'monthly';
}

async function resolveUidFromStripeRefs(subscriptionId, customerId) {
    if (subscriptionId) {
        const bySubscription = await dbService.findUserByStripeSubscriptionId(subscriptionId);
        if (bySubscription?.uid) return bySubscription.uid;
    }
    if (customerId) {
        const byCustomer = await dbService.findUserByStripeCustomerId(customerId);
        if (byCustomer?.uid) return byCustomer.uid;
    }
    return null;
}

async function handleCheckoutCompleted(session) {
    if (session.mode !== 'subscription') return;

    const uid = session?.metadata?.uid || null;
    if (!uid) {
        logger.warn('Stripe checkout.session.completed: uid metadata not found, skipping user update');
        return;
    }

    let plan = session?.metadata?.plan || null;
    let billingCycle = session?.metadata?.billingCycle || null;
    let stripeStatus = 'ACTIVE';
    let trialEndsAt = null;

    const subscriptionId = typeof session.subscription === 'string'
        ? session.subscription
        : (session.subscription?.id || null);
    if (subscriptionId) {
        try {
            const subscription = await stripeService.getSubscription(subscriptionId);
            stripeStatus = subscription?.status ? String(subscription.status).toUpperCase() : 'ACTIVE';
            if (subscription?.trial_end) {
                trialEndsAt = new Date(subscription.trial_end * 1000).toISOString();
            }
            const resolved = stripeService.resolvePlanBySubscription(subscription);
            if (resolved) {
                plan = resolved.plan;
                billingCycle = resolved.billingCycle;
            }
        } catch (error) {
            logger.warn(`Stripe webhook: failed to resolve plan from subscription ${subscriptionId}: ${error.message}`);
        }
    }

    await dbService.updatePaymentInfo(uid, {
        hasPaymentMethod: true,
        paymentRegisteredAt: new Date().toISOString(),
        trialStartedAt: null,
        pendingPlan: null,
        pendingBillingCycle: null,
        stripeStatus,
        subscriptionState: stripeStatus === 'TRIALING' ? 'trial' : 'active',
        trialEndsAt,
        stripePaymentFailed: false,
        lastPaymentFailedAt: null,
        stripeCheckoutSessionId: session.id,
        stripeCustomerId: typeof session.customer === 'string' ? session.customer : null,
        stripeSubscriptionId: subscriptionId,
        stripePlan: normalizePlan(plan || 'starter')
    });

    await dbService.setUserPlan(
        uid,
        normalizePlan(plan || 'starter'),
        normalizeBillingCycle(billingCycle || 'monthly')
    );
    logger.info(`Stripe webhook: checkout completed, uid=${uid}, plan=${plan}, billingCycle=${billingCycle}`);
}

async function handleSubscriptionDeleted(subscription) {
    const subscriptionId = subscription?.id || null;
    const customerId = typeof subscription?.customer === 'string' ? subscription.customer : null;
    const uidFromMetadata = subscription?.metadata?.uid || null;
    const uid = uidFromMetadata || await resolveUidFromStripeRefs(subscriptionId, customerId);

    if (!uid) {
        logger.warn(`Stripe webhook: customer.subscription.deleted user not found, sub=${subscriptionId}`);
        return;
    }

    await dbService.updatePaymentInfo(uid, {
        hasPaymentMethod: false,
        stripeStatus: 'CANCELLED',
        subscriptionState: 'free',
        cancelledAt: new Date().toISOString(),
        stripeSubscriptionId: subscriptionId,
        stripeCustomerId: customerId,
        stripePlan: 'free',
        pendingPlan: null,
        pendingBillingCycle: null
    });
    await dbService.setUserPlan(uid, 'starter', 'monthly');
    logger.info(`Stripe webhook: subscription deleted, uid=${uid}`);
}

async function handleInvoicePaymentFailed(invoice) {
    const subscriptionId = typeof invoice?.subscription === 'string'
        ? invoice.subscription
        : (invoice?.subscription?.id || null);
    const customerId = typeof invoice?.customer === 'string' ? invoice.customer : null;
    const uid = await resolveUidFromStripeRefs(subscriptionId, customerId);

    if (!uid) {
        logger.warn(`Stripe webhook: invoice.payment_failed user not found, sub=${subscriptionId}`);
        return;
    }

    await dbService.updatePaymentInfo(uid, {
        stripeStatus: 'PAYMENT_FAILED',
        subscriptionState: 'past_due',
        stripePaymentFailed: true,
        lastPaymentFailedAt: new Date().toISOString(),
        stripeSubscriptionId: subscriptionId,
        stripeCustomerId: customerId
    });
    logger.warn(`Stripe webhook: payment failed, uid=${uid}, sub=${subscriptionId}`);
}

async function handleInvoicePaid(invoice) {
    const subscriptionId = typeof invoice?.subscription === 'string'
        ? invoice.subscription
        : (invoice?.subscription?.id || null);
    const customerId = typeof invoice?.customer === 'string' ? invoice.customer : null;
    const uid = await resolveUidFromStripeRefs(subscriptionId, customerId);
    if (!uid) {
        logger.warn(`Stripe webhook: invoice.paid user not found, sub=${subscriptionId}`);
        return;
    }

    await dbService.updatePaymentInfo(uid, {
        stripeStatus: 'ACTIVE',
        subscriptionState: 'active',
        stripePaymentFailed: false,
        lastPaymentAt: new Date().toISOString(),
        stripeSubscriptionId: subscriptionId,
        stripeCustomerId: customerId
    });
    logger.info(`Stripe webhook: invoice paid, uid=${uid}, sub=${subscriptionId}`);
}

router.post('/webhook', async (req, res) => {
    if (!stripeService.isConfigured()) {
        return res.status(503).json({ success: false, error: 'Stripe is not configured.' });
    }

    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';
    if (!webhookSecret) {
        return res.status(503).json({ success: false, error: 'STRIPE_WEBHOOK_SECRET is not configured.' });
    }

    const signature = req.headers['stripe-signature'];
    if (!signature) {
        return res.status(400).json({ success: false, error: 'Missing stripe-signature header.' });
    }

    let event;
    try {
        event = stripeService.constructWebhookEvent(req.body, signature, webhookSecret);
    } catch (error) {
        logger.warn(`Stripe webhook signature verification failed: ${error.message}`);
        return res.status(400).send(`Webhook Error: ${error.message}`);
    }

    try {
        switch (event.type) {
            case 'checkout.session.completed':
                await handleCheckoutCompleted(event.data.object);
                break;
            case 'customer.subscription.deleted':
                await handleSubscriptionDeleted(event.data.object);
                break;
            case 'invoice.payment_failed':
                await handleInvoicePaymentFailed(event.data.object);
                break;
            case 'invoice.paid':
                await handleInvoicePaid(event.data.object);
                break;
            default:
                logger.info(`Stripe webhook: unhandled event type ${event.type}`);
        }
    } catch (error) {
        logger.error(`Stripe webhook handler error (${event.type}): ${error.message}`);
        return res.status(500).json({ success: false, error: 'Webhook processing failed' });
    }

    return res.json({ received: true });
});

module.exports = router;
