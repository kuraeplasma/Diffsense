const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const paypalService = require('../services/paypal');
const dbService = require('../services/db');
const zohoService = require('../services/zoho');
const firmaService = require('../services/firma');
const logger = require('../utils/logger');
const mailer = require('../services/mailer');
const { admin } = require('../firebase');

function getBackendBaseUrl(req) {
    const configured = process.env.API_BASE_URL || process.env.BACKEND_BASE_URL;
    if (configured) return configured.replace(/\/$/, '');
    const host = req.get('host') || 'localhost:3001';
    return `${req.protocol}://${host}`;
}

function getFrontendBaseUrl() {
    const configured = String(process.env.FRONTEND_URL || process.env.APP_URL || '').trim();
    if (configured) return configured.replace(/\/$/, '');
    return 'https://diffsense.spacegleam.co.jp';
}

function verifyZohoWebhook(req) {
    const secret = process.env.ZOHO_WEBHOOK_SECRET;
    if (!secret) {
        logger.error('ZOHO_WEBHOOK_SECRET が未設定です。本番環境では必須です。');
        return false;
    }

    const headerSignature = req.get('x-zs-webhook-signature');
    if (!headerSignature || !req.rawBody) {
        return false;
    }

    const expected = crypto
        .createHmac('sha256', secret)
        .update(req.rawBody)
        .digest('hex');

    try {
        return crypto.timingSafeEqual(
            Buffer.from(String(headerSignature).trim()),
            Buffer.from(expected)
        );
    } catch {
        return false;
    }
}

function saveBinaryArtifact(baseDirName, signRequestId, downloaded, baseUrl) {
    if (!downloaded?.buffer?.length) return null;
    const uploadsDir = path.join(__dirname, `../../uploads/${baseDirName}`);
    if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
    }

    const ext = path.extname(downloaded.fileName || '') || '.pdf';
    const filename = `sign-${signRequestId}-${Date.now()}${ext}`;
    const filePath = path.join(uploadsDir, filename);
    fs.writeFileSync(filePath, downloaded.buffer);

    return {
        filename,
        url: `${baseUrl}/uploads/${baseDirName}/${filename}`,
        mimeType: downloaded.mimeType || 'application/pdf',
        originalName: downloaded.fileName || filename
    };
}

async function persistCompletedDocument(req, signRequest) {
    if (!signRequest?.zoho_request_id) return null;

    try {
        const downloaded = await zohoService.downloadCompletedDocument(signRequest.zoho_request_id);
        const baseUrl = getBackendBaseUrl(req);
        const stored = saveBinaryArtifact('sign-completed', signRequest.id, downloaded, baseUrl);
        if (!stored) {
            return null;
        }
        return {
            completed_document_url: stored.url,
            completed_document_name: stored.originalName,
            completed_document_mime: stored.mimeType,
            completed_document_synced_at: new Date().toISOString(),
            completed_document_source: 'zoho'
        };
    } catch (error) {
        logger.warn('Completed document persistence failed', {
            requestId: signRequest.zoho_request_id,
            error: error.message
        });
    }

    if (process.env.NODE_ENV === 'development' || process.env.AUTH_BYPASS === 'true') {
        try {
            const contracts = await dbService.getContracts(signRequest.ownerUid);
            const contract = contracts.find((item) => String(item.id) === String(signRequest.contract_id));
            const fallbackUrl = contract?.pdf_url || contract?.pdf_storage_path || null;
            if (fallbackUrl) {
                return {
                    completed_document_url: String(fallbackUrl).startsWith('http')
                        ? fallbackUrl
                        : `${getBackendBaseUrl(req)}${String(fallbackUrl).startsWith('/') ? '' : '/'}${fallbackUrl}`,
                    completed_document_name: contract?.original_filename || contract?.name || 'signed-document.pdf',
                    completed_document_mime: 'application/pdf',
                    completed_document_synced_at: new Date().toISOString(),
                    completed_document_source: 'local-fallback'
                };
            }
        } catch (fallbackError) {
            logger.warn('Local fallback for completed document failed', {
                requestId: signRequest.zoho_request_id,
                error: fallbackError.message
            });
        }
    }

    return null;
}

async function persistFirmaCompletedDocument(req, signRequest) {
    if (!signRequest?.firma_request_id) return null;

    try {
        const downloaded = await firmaService.downloadSignedPdf(signRequest.firma_request_id);
        const baseUrl = getBackendBaseUrl(req);
        const stored = saveBinaryArtifact('sign-completed', signRequest.id, {
            buffer: downloaded,
            fileName: `${signRequest.firma_request_id}-signed.pdf`,
            mimeType: 'application/pdf'
        }, baseUrl);
        if (!stored) return null;
        return {
            completed_document_url: stored.url,
            completed_document_name: stored.originalName,
            completed_document_mime: stored.mimeType,
            completed_document_synced_at: new Date().toISOString(),
            completed_document_source: 'firma'
        };
    } catch (error) {
        logger.warn('Firma completed document persistence failed', {
            requestId: signRequest.firma_request_id,
            error: error.message
        });
        return null;
    }
}

async function persistCompletionCertificate(req, signRequest) {
    if (!signRequest?.zoho_request_id) return null;
    try {
        const downloaded = await zohoService.downloadCompletionCertificate(signRequest.zoho_request_id);
        const baseUrl = getBackendBaseUrl(req);
        const stored = saveBinaryArtifact('sign-certificates', signRequest.id, downloaded, baseUrl);
        if (!stored) return null;
        return {
            completion_certificate_url: stored.url,
            completion_certificate_name: stored.originalName,
            completion_certificate_mime: stored.mimeType,
            completion_certificate_synced_at: new Date().toISOString()
        };
    } catch (error) {
        logger.warn('Completion certificate persistence failed', {
            requestId: signRequest.zoho_request_id,
            error: error.message
        });
        return null;
    }
}

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
        if (process.env.NODE_ENV === 'production') {
            if (!process.env.PAYPAL_WEBHOOK_ID) {
                logger.error('PAYPAL_WEBHOOK_ID が未設定です。本番環境では必須です。');
                return res.status(503).json({ error: 'Webhook verification is not configured' });
            }
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
                    const targetBillingCycle = user.pendingBillingCycle || user.billingCycle || 'monthly';
                    await dbService.updatePaymentInfo(user.uid, {
                        hasPaymentMethod: true,
                        paypalStatus: 'ACTIVE',
                        paymentRegisteredAt: new Date().toISOString(),
                        trialStartedAt: null,
                        nextBillingDate: resource.billing_info?.next_billing_time || null,
                        pendingPlan: null,
                        pendingBillingCycle: null
                    });
                    await dbService.setUserPlan(user.uid, targetPlan, targetBillingCycle);
                    logger.info(`Webhook: Subscription activated for user ${user.uid}, plan: ${targetPlan}, billingCycle: ${targetBillingCycle}`);
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
                        cancelledAt: new Date().toISOString(),
                        pendingPlan: null,
                        pendingBillingCycle: null
                    });
                    await dbService.setUserPlan(user.uid, 'starter', 'monthly');
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
                        paypalStatus: 'EXPIRED',
                        pendingPlan: null,
                        pendingBillingCycle: null
                    });
                    await dbService.setUserPlan(user.uid, 'starter', 'monthly');
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

/**
 * POST /webhook/zoho
 * Handle Zoho Sign webhook events
 */
router.post('/zoho', express.json({
    verify: (req, _res, buf) => {
        req.rawBody = Buffer.from(buf);
    }
}), async (req, res) => {
    try {
        if (!verifyZohoWebhook(req)) {
            logger.warn('Zoho Webhook signature verification failed');
            return res.status(401).json({ success: false, error: 'Invalid webhook signature' });
        }

        const payload = req.body;
        const requestId = payload.requests?.request_id || payload.request_id;
        const eventType = payload.operation_type || payload.event_type;
        
        logger.info(`Zoho Sign Webhook received: ${eventType}`, { requestId });

        if (!requestId) {
            return res.status(200).json({ success: true, info: 'No request_id to process' });
        }

        let internalStatus = 'pending';
        // Map Zoho status to internal status
        if (eventType === 'document_completed' || payload.requests?.request_status === 'completed') {
            internalStatus = 'completed';
        } else if (eventType === 'document_declined' || payload.requests?.request_status === 'declined') {
            internalStatus = 'declined';
        } else if (eventType === 'document_signed') {
            internalStatus = 'signed';
        }

        const updatedRequest = await dbService.updateSignRequestStatusByZohoId(requestId, internalStatus, payload);

        if (internalStatus === 'completed' && updatedRequest) {
            const completedArtifact = await persistCompletedDocument(req, updatedRequest);
            const completionCertificate = await persistCompletionCertificate(req, updatedRequest);
            const mergedArtifacts = {
                ...(completedArtifact || {}),
                ...(completionCertificate || {})
            };
            if (Object.keys(mergedArtifacts).length > 0) {
                await dbService.updateSignRequest(updatedRequest.id, mergedArtifacts, updatedRequest.ownerUid);
            }
        }

        res.status(200).json({ success: true });
    } catch (error) {
        logger.error('Zoho Webhook processing error:', error);
        res.status(200).json({ received: true, error: error.message });
    }
});

router.post('/firma', express.json({
    verify: (req, _res, buf) => {
        req.rawBody = Buffer.from(buf);
    }
}), async (req, res) => {
    try {
        const signatureHeader = req.get('x-firma-signature');
        const rawBody = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {});
        const allowUnsignedLocal = (process.env.NODE_ENV === 'development' || process.env.AUTH_BYPASS === 'true')
            && !process.env.FIRMA_WEBHOOK_SECRET;

        if (!allowUnsignedLocal && !firmaService.verifyWebhook(rawBody, signatureHeader)) {
            logger.warn('Firma Webhook signature verification failed');
            return res.status(401).json({ success: false, error: 'Invalid webhook signature' });
        }

        const payload = req.body || {};
        const eventType = payload.event_type;
        const requestId = payload?.data?.signing_request_id;

        logger.info(`Firma Webhook received: ${eventType}`, { requestId });

        if (!requestId) {
            return res.status(200).json({ success: true, info: 'No signing_request_id to process' });
        }

        const requests = await dbService.getSignRequests();
        const signRequest = requests.find((item) => String(item.firma_request_id || '') === String(requestId));
        if (!signRequest) {
            return res.status(200).json({ success: true, info: 'No local request matched the provider id' });
        }

        if (eventType === 'signing_request.signed') {
            const signedEmails = new Set((payload?.data?.recipients || []).map((recipient) => String(recipient?.email || '').trim()).filter(Boolean));
            if (signedEmails.size > 0) {
                const updatedRecipients = (signRequest.recipients || []).map((recipient) =>
                    signedEmails.has(String(recipient?.email || '').trim())
                        ? { ...recipient, status: 'signed', signed_at: new Date().toISOString() }
                        : recipient
                );
                await dbService.updateSignRequest(signRequest.id, {
                    status: 'signed',
                    recipients: updatedRecipients,
                    firma_last_event: payload,
                    updated_at: new Date().toISOString()
                }, signRequest.ownerUid || null);
            }
            return res.status(200).json({ success: true });
        }

        if (eventType === 'signing_request.completed') {
            const completedArtifact = await persistFirmaCompletedDocument(req, signRequest);
            const updatedRecipients = (signRequest.recipients || []).map((recipient) => ({
                ...recipient,
                status: 'completed',
                signed_at: recipient.signed_at || new Date().toISOString()
            }));
            const updated = await dbService.updateSignRequest(signRequest.id, {
                status: 'completed',
                recipients: updatedRecipients,
                firma_last_event: payload,
                ...(completedArtifact || {})
            }, signRequest.ownerUid || null);

            try {
                await firmaService.deleteSigningRequest(signRequest.firma_request_id);
                await dbService.updateSignRequest(signRequest.id, {
                    firma_deleted_at: new Date().toISOString()
                }, signRequest.ownerUid || null);
            } catch (deleteError) {
                logger.warn('Firma deletion after completion failed', {
                    requestId: signRequest.firma_request_id,
                    error: deleteError.message
                });
            }

            if (process.env.RESEND_API_KEY) {
                try {
                    const userRecord = await admin.auth().getUser(signRequest.ownerUid || signRequest.requestedBy);
                    const senderEmail = userRecord?.email;
                    const senderName = userRecord?.displayName || userRecord?.email || 'DIFFsense ユーザー';
                    if (senderEmail) {
                        let downloadUrl = completedArtifact?.completed_document_url || `${getBackendBaseUrl(req)}/sign`;
                        if (completedArtifact?.completed_document_url?.includes('/uploads/')) {
                            downloadUrl = completedArtifact.completed_document_url;
                        }
                        await mailer.sendCompletionEmail({
                            to: senderEmail,
                            senderName,
                            fileName: signRequest.document_name || '',
                            downloadUrl
                        }).catch((mailError) => console.error('[webhook/firma] completion mail error:', mailError.message));
                        await mailer.sendRecipientActionEmail({
                            to: senderEmail,
                            senderName,
                            fileName: signRequest.document_name || '',
                            recipientName: '全署名者',
                            actionLabel: 'すべての署名が完了しました',
                            dashboardUrl: `${getFrontendBaseUrl()}/dashboard.html`
                        }).catch((mailError) => console.error('[webhook/firma] dashboard mail error:', mailError.message));
                    }
                } catch (authErr) {
                    console.error('[webhook/firma] getUser error:', authErr.message);
                }
            }

            return res.status(200).json({ success: true, data: updated || signRequest });
        }

        if (eventType === 'signing_request.cancelled' || eventType === 'signing_request.expired') {
            const status = eventType === 'signing_request.cancelled' ? 'declined' : 'expired';
            await dbService.updateSignRequest(signRequest.id, {
                status,
                firma_last_event: payload
            }, signRequest.ownerUid || null);
            return res.status(200).json({ success: true });
        }

        res.status(200).json({ success: true });
    } catch (error) {
        logger.error('Firma Webhook processing error:', error);
        res.status(200).json({ received: true, error: error.message });
    }
});

module.exports = router;

