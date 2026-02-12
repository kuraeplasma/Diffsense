const express = require('express');
const router = express.Router();
const paypalService = require('../services/paypal');
const dbService = require('../services/db');
const logger = require('../utils/logger');

/**
 * POST /webhook/paypal
 * Handle PayPal webhook events (no auth middleware - PayPal calls this directly)
 *
 * Key events:
 * - BILLING.SUBSCRIPTION.ACTIVATED   → サブスク有効化
 * - BILLING.SUBSCRIPTION.CANCELLED   → ユーザーがPayPal側でキャンセル
 * - BILLING.SUBSCRIPTION.SUSPENDED   → 支払い失敗で停止
 * - BILLING.SUBSCRIPTION.EXPIRED     → サブスク期限切れ
 * - PAYMENT.SALE.COMPLETED           → 月次決済成功
 * - PAYMENT.SALE.DENIED              → 月次決済失敗
 */
router.post('/paypal', express.json(), async (req, res) => {
    try {
        const event = req.body;
        const eventType = event.event_type;
        const resource = event.resource;

        logger.info(`PayPal Webhook received: ${eventType}`, {
            id: event.id,
            resourceType: event.resource_type
        });

        // Verify webhook signature in production
        if (process.env.NODE_ENV === 'production' && process.env.PAYPAL_WEBHOOK_ID) {
            const isValid = await paypalService.verifyWebhookSignature(req.headers, req.body);
            if (!isValid) {
                logger.warn('PayPal Webhook signature verification failed');
                return res.status(401).json({ error: 'Invalid webhook signature' });
            }
        }

        switch (eventType) {
            case 'BILLING.SUBSCRIPTION.ACTIVATED': {
                // サブスクリプションが有効化された
                const subscriptionId = resource.id;
                const user = await dbService.findUserBySubscriptionId(subscriptionId);
                if (user) {
                    const targetPlan = user.pendingPlan || user.plan || 'starter';
                    await dbService.updatePaymentInfo(user.uid, {
                        hasPaymentMethod: true,
                        paypalStatus: 'ACTIVE',
                        paymentRegisteredAt: new Date().toISOString(),
                        pendingPlan: null
                    });
                    await dbService.setUserPlan(user.uid, targetPlan);
                    logger.info(`Webhook: Subscription activated for user ${user.uid}, plan: ${targetPlan}`);
                }
                break;
            }

            case 'BILLING.SUBSCRIPTION.CANCELLED': {
                // ユーザーがPayPal側からキャンセルした場合
                const subscriptionId = resource.id;
                const user = await dbService.findUserBySubscriptionId(subscriptionId);
                if (user) {
                    await dbService.updatePaymentInfo(user.uid, {
                        hasPaymentMethod: false,
                        paypalStatus: 'CANCELLED',
                        cancelledAt: new Date().toISOString()
                    });
                    await dbService.setUserPlan(user.uid, 'starter');
                    logger.info(`Webhook: Subscription cancelled for user ${user.uid}`);
                }
                break;
            }

            case 'BILLING.SUBSCRIPTION.SUSPENDED': {
                // 支払い失敗でサブスクリプションが停止
                const subscriptionId = resource.id;
                const user = await dbService.findUserBySubscriptionId(subscriptionId);
                if (user) {
                    await dbService.updatePaymentInfo(user.uid, {
                        paypalStatus: 'SUSPENDED'
                    });
                    logger.warn(`Webhook: Subscription suspended for user ${user.uid}`);
                }
                break;
            }

            case 'BILLING.SUBSCRIPTION.EXPIRED': {
                // サブスクリプション期限切れ
                const subscriptionId = resource.id;
                const user = await dbService.findUserBySubscriptionId(subscriptionId);
                if (user) {
                    await dbService.updatePaymentInfo(user.uid, {
                        hasPaymentMethod: false,
                        paypalStatus: 'EXPIRED'
                    });
                    await dbService.setUserPlan(user.uid, 'starter');
                    logger.info(`Webhook: Subscription expired for user ${user.uid}`);
                }
                break;
            }

            case 'PAYMENT.SALE.COMPLETED': {
                // 月次決済が成功
                const subscriptionId = resource.billing_agreement_id;
                if (subscriptionId) {
                    const user = await dbService.findUserBySubscriptionId(subscriptionId);
                    if (user) {
                        // 月次決済成功 → 使用量をリセット
                        await dbService.resetMonthlyUsage(user.uid);
                        await dbService.updatePaymentInfo(user.uid, {
                            lastPaymentAt: new Date().toISOString(),
                            paypalStatus: 'ACTIVE'
                        });
                        logger.info(`Webhook: Payment completed for user ${user.uid}, usage reset`);
                    }
                }
                break;
            }

            case 'PAYMENT.SALE.DENIED':
            case 'PAYMENT.SALE.REFUNDED': {
                // 決済失敗またはリファンド
                const subscriptionId = resource.billing_agreement_id;
                if (subscriptionId) {
                    const user = await dbService.findUserBySubscriptionId(subscriptionId);
                    if (user) {
                        await dbService.updatePaymentInfo(user.uid, {
                            paypalStatus: eventType === 'PAYMENT.SALE.DENIED' ? 'PAYMENT_FAILED' : 'REFUNDED'
                        });
                        logger.warn(`Webhook: ${eventType} for user ${user.uid}`);
                    }
                }
                break;
            }

            default:
                logger.info(`Webhook: Unhandled event type: ${eventType}`);
        }

        // Always return 200 to acknowledge receipt
        res.status(200).json({ received: true });

    } catch (error) {
        logger.error('Webhook processing error:', error);
        // Still return 200 to prevent PayPal from retrying
        res.status(200).json({ received: true, error: 'Processing error logged' });
    }
});

module.exports = router;
