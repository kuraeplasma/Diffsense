const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const router = express.Router();
const logger = require('../utils/logger');
const zohoService = require('../services/zoho');
const firmaService = require('../services/firma');
const dbService = require('../services/db');
const mailer = require('../services/mailer');
const { admin, bucket, firebaseInitialized } = require('../firebase');
const SIGN_LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TRIAL_SIGN_REQUEST_LIMIT = 3;

function useDiffsenseProvider() {
    return Boolean(String(process.env.JWT_SECRET || '').trim());
}

function useFirmaProvider() {
    return firmaService.isConfigured();
}

function getFrontendBaseUrl() {
    const explicit = String(process.env.FRONTEND_URL || '').trim();
    if (explicit) return explicit.replace(/\/$/, '');
    const appUrl = String(process.env.APP_URL || '').trim();
    if (appUrl) return appUrl.replace('://localhost:3001', '://localhost:3000').replace(/\/$/, '');
    return 'https://diffsense.spacegleam.co.jp';
}

function getBackendBaseUrl(req) {
    const explicit = String(process.env.APP_URL || process.env.BACKEND_BASE_URL || '').trim();
    if (explicit) return explicit.replace(/\/$/, '');
    const host = req.get('host') || 'localhost:3001';
    return `${req.protocol}://${host}`;
}

function findSignRequestById(requests, signRequestId) {
    return (Array.isArray(requests) ? requests : []).find((item) => String(item.id) === String(signRequestId));
}

function annotateFieldsWithRecipientEmail(fields, recipients) {
    return (Array.isArray(fields) ? fields : []).map((field) => {
        const recipientIndex = Number(field?.assigneeIndex ?? field?.recipientIndex ?? 0);
        return {
            ...field,
            recipientIndex,
            assigneeIndex: recipientIndex,
            recipientEmail: recipients?.[recipientIndex]?.email || field?.recipientEmail || null
        };
    });
}

function createRecipientTokens(signRequestId, recipients) {
    const secret = String(process.env.JWT_SECRET || '').trim();
    if (!secret) {
        throw new Error('JWT_SECRET is not configured');
    }
    const tokens = {};
    for (const recipient of (Array.isArray(recipients) ? recipients : [])) {
        if (!recipient?.email) continue;
        tokens[recipient.email] = jwt.sign(
            {
                signRequestId: String(signRequestId),
                email: String(recipient.email).trim()
            },
            secret,
            { expiresIn: '30d' }
        );
    }
    return tokens;
}

function getSignRequestExpiryIso(signRequest) {
    const explicit = String(signRequest?.expiresAt || '').trim();
    if (explicit) return explicit;

    const tokens = signRequest?.recipientTokens && typeof signRequest.recipientTokens === 'object'
        ? Object.values(signRequest.recipientTokens)
        : [];
    for (const token of tokens) {
        const decoded = jwt.decode(String(token || ''));
        if (decoded?.exp) {
            return new Date(decoded.exp * 1000).toISOString();
        }
    }

    const base = String(signRequest?.sent_at || signRequest?.created_at || '').trim();
    if (!base) return '';
    const baseTime = new Date(base).getTime();
    if (Number.isNaN(baseTime)) return '';
    return new Date(baseTime + SIGN_LINK_TTL_MS).toISOString();
}

function isTerminalRequestStatus(status) {
    const normalized = String(status || '').toLowerCase();
    return normalized === 'completed' || normalized === 'declined' || normalized === 'expired';
}

function isSignRequestExpired(signRequest, now = Date.now()) {
    if (!signRequest || isTerminalRequestStatus(signRequest.status)) return false;
    const expiryIso = getSignRequestExpiryIso(signRequest);
    if (!expiryIso) return false;
    const expiryTime = new Date(expiryIso).getTime();
    return !Number.isNaN(expiryTime) && now >= expiryTime;
}

async function markSignRequestExpired(signRequest) {
    if (!signRequest || isTerminalRequestStatus(signRequest.status)) {
        return signRequest;
    }
    const expiresAt = getSignRequestExpiryIso(signRequest);
    if (!expiresAt || !isSignRequestExpired(signRequest)) {
        return signRequest;
    }
    return await dbService.updateSignRequest(
        signRequest.id,
        {
            status: 'expired',
            expiresAt,
            expiredAt: new Date().toISOString()
        },
        signRequest.ownerUid || signRequest.requestedBy || null
    );
}

async function syncExpiredSignRequests(requests) {
    const result = [];
    for (const request of (Array.isArray(requests) ? requests : [])) {
        if (isSignRequestExpired(request)) {
            result.push(await markSignRequestExpired(request));
        } else {
            result.push(request);
        }
    }
    return result;
}

async function markExpiredFromToken(token) {
    const decoded = jwt.decode(String(token || ''));
    const signRequestId = decoded?.signRequestId;
    if (!signRequestId) return null;
    const requests = await dbService.getSignRequests(null);
    const signRequest = findSignRequestById(requests, signRequestId);
    if (!signRequest) return null;
    return await markSignRequestExpired(signRequest);
}

function buildTokenSigningUrl(token) {
    return `${getFrontendBaseUrl()}/signing.html?token=${encodeURIComponent(token)}`;
}

function extractUploadsRelativePath(value) {
    const normalized = String(value || '').trim().replace(/\\/g, '/');
    if (!normalized) return '';
    const uploadsIndex = normalized.toLowerCase().indexOf('/uploads/');
    if (uploadsIndex >= 0) {
        return normalized.slice(uploadsIndex);
    }
    if (normalized.startsWith('uploads/')) {
        return `/${normalized}`;
    }
    if (normalized.startsWith('/uploads/')) {
        return normalized;
    }
    const backendUploads = '/backend/uploads/';
    const backendIndex = normalized.toLowerCase().indexOf(backendUploads);
    if (backendIndex >= 0) {
        return normalized.slice(backendIndex + '/backend'.length);
    }
    return '';
}

function resolveSignRequestPdfUrl(signRequest, req) {
    const backendBaseUrl = getBackendBaseUrl(req);
    const candidates = [
        signRequest?.document_snapshot?.pdf_url,
        signRequest?.document_snapshot?.pdf_storage_path,
        signRequest?.completed_document_url
    ];
    for (const candidate of candidates) {
        const value = String(candidate || '').trim();
        if (!value) continue;
        if (/^https?:\/\//i.test(value)) {
            return value;
        }
        const uploadsPath = extractUploadsRelativePath(value);
        if (uploadsPath) {
            return `${backendBaseUrl}${uploadsPath}`;
        }
    }
    return '';
}

function resolveSignRequestPdfBuffer(signRequest) {
    const candidates = [
        signRequest?.document_snapshot?.pdf_storage_path,
        signRequest?.document_snapshot?.pdf_url
    ];
    for (const candidate of candidates) {
        const value = String(candidate || '').trim();
        if (!value) continue;
        try {
            if (fs.existsSync(value)) {
                return fs.readFileSync(value);
            }
        } catch {}
        const uploadsRelative = extractUploadsRelativePath(value);
        if (uploadsRelative) {
            const localPath = path.join(__dirname, '..', '..', uploadsRelative.replace(/^\//, ''));
            try {
                if (fs.existsSync(localPath)) {
                    return fs.readFileSync(localPath);
                }
            } catch {}
        }
    }
    return null;
}

function buildFieldBox(field, signRequest, pageWidth, pageHeight) {
    const pageNumber = Number(field?.page || 1);
    const pageDims = signRequest?.page_dimensions?.[pageNumber]
        || signRequest?.page_dimensions?.[String(pageNumber)]
        || { width: pageWidth, height: pageHeight };
    const width = Math.max(24, (Number(field?.width || 88) / Math.max(1, Number(pageDims.width || pageWidth))) * pageWidth);
    const height = Math.max(18, (Number(field?.height || 48) / Math.max(1, Number(pageDims.height || pageHeight))) * pageHeight);
    const centerX = (Number(field?.x || 0) / 100) * pageWidth;
    const centerY = (Number(field?.y || 0) / 100) * pageHeight;
    const x = centerX - (width / 2);
    const y = pageHeight - centerY - (height / 2);
    return { x, y, width, height };
}

function hasNonLatinText(value) {
    return /[^\u0000-\u00ff]/.test(String(value || ''));
}

function saveCompletedPdfLocal(signRequestId, pdfBuffer, req) {
    const uploadsDir = path.join(__dirname, '../../uploads/sign-completed');
    if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
    }
    const filename = `sign-${signRequestId}-${Date.now()}-signed.pdf`;
    const absolutePath = path.join(uploadsDir, filename);
    fs.writeFileSync(absolutePath, pdfBuffer);
    const relativeUrl = `/uploads/sign-completed/${filename}`;
    return {
        signedPdfPath: absolutePath,
        completedDocumentUrl: `${getBackendBaseUrl(req)}${relativeUrl}`
    };
}

async function saveCompletedPdf(signRequestId, pdfBuffer, req) {
    const pdfHash = crypto.createHash('sha256').update(pdfBuffer).digest('hex');
    if (firebaseInitialized && bucket) {
        const storagePath = `sign_docs_completed/${signRequestId}_signed.pdf`;
        await bucket.file(storagePath).save(pdfBuffer, {
            metadata: { contentType: 'application/pdf' }
        });
        const [downloadUrl] = await bucket.file(storagePath).getSignedUrl({
            action: 'read',
            expires: Date.now() + 7 * 24 * 60 * 60 * 1000
        });
        return {
            signedPdfPath: storagePath,
            completedDocumentUrl: downloadUrl,
            pdfHash,
            storageRegion: 'asia-northeast1'
        };
    }

    const stored = saveCompletedPdfLocal(signRequestId, pdfBuffer, req);
    return {
        ...stored,
        pdfHash,
        storageRegion: 'local'
    };
}

async function sendCompletionNotice(signRequest, completedDocumentUrl) {
    const recipients = [];
    const ownerEmail = String(signRequest?.requestedByEmail || signRequest?.sender_email || '').trim();
    const ownerName = signRequest?.requestedByName || signRequest?.sender || ownerEmail || 'DIFFsense ユーザー';
    if (ownerEmail) {
        recipients.push({ email: ownerEmail, name: ownerName });
    }

    for (const recipient of (Array.isArray(signRequest?.recipients) ? signRequest.recipients : [])) {
        const email = String(recipient?.email || '').trim();
        if (!email) continue;
        recipients.push({
            email,
            name: recipient?.name || email
        });
    }

    const delivered = new Set();
    for (const recipient of recipients) {
        const emailKey = String(recipient.email || '').toLowerCase();
        if (!emailKey || delivered.has(emailKey)) continue;
        delivered.add(emailKey);

        try {
            await mailer.sendCompletionEmail({
                to: recipient.email,
                senderName: recipient.name,
                fileName: signRequest.document_name || signRequest.fileName || '署名済み書類',
                downloadUrl: completedDocumentUrl
            });
        } catch (error) {
            logger.error('[sign submit] completion mail error', {
                requestId: signRequest.id,
                to: recipient.email,
                error: error.message
            });
        }
    }
}

async function sendRecipientActionNotice(signRequest, recipient, actionLabel) {
    const recipientEmail = signRequest?.requestedByEmail || signRequest?.sender_email || '';
    const senderName = signRequest?.requestedByName || signRequest?.sender || recipientEmail || 'DIFFsense ユーザー';
    if (!recipientEmail) return;

    try {
        await mailer.sendRecipientActionEmail({
            to: recipientEmail,
            senderName,
            fileName: signRequest.document_name || signRequest.fileName || '署名依頼',
            recipientName: recipient?.name || recipient?.email || '署名者',
            actionLabel,
            dashboardUrl: `${getFrontendBaseUrl()}/dashboard.html`
        });
    } catch (error) {
        logger.error('[sign action] owner mail error', {
            requestId: signRequest?.id,
            error: error.message
        });
    }
}

async function generateSignedPdf(signRequest, req) {
    const pdfBuffer = resolveSignRequestPdfBuffer(signRequest);
    if (!pdfBuffer?.length) {
        throw new Error('元のPDFファイルを取得できませんでした');
    }

    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const pages = pdfDoc.getPages();
    const signaturesByRecipient = signRequest.signatures || {};

    for (const field of (signRequest.fields || [])) {
        const recipientEmail = String(field?.recipientEmail || '').trim();
        if (!recipientEmail) continue;
        const page = pages[Number(field?.page || 1) - 1];
        if (!page) continue;

        const { width: pageWidth, height: pageHeight } = page.getSize();
        const box = buildFieldBox(field, signRequest, pageWidth, pageHeight);
        const recipientSignatures = signaturesByRecipient[recipientEmail] || {};
        const signatureValue = recipientSignatures[String(field.id)] || Object.values(recipientSignatures)[0] || null;

        if (field.type === 'signature' && signatureValue?.dataUrl) {
            const pngBase64 = String(signatureValue.dataUrl).replace(/^data:image\/png;base64,/, '');
            const pngBytes = Buffer.from(pngBase64, 'base64');
            const image = await pdfDoc.embedPng(pngBytes);
            page.drawImage(image, {
                x: box.x,
                y: box.y,
                width: box.width,
                height: box.height
            });
        } else if (field.type === 'signature' && signatureValue?.type === 'text' && signatureValue?.fontText) {
            const textValue = String(signatureValue.fontText || '').trim();
            if (!textValue) {
                continue;
            }
            if (hasNonLatinText(textValue)) {
                throw new Error('日本語を含むテキスト署名の描画データを作成できませんでした');
            }
            const baseFontSize = Math.min(box.height * 0.6, 20);
            const textWidth = helvetica.widthOfTextAtSize(textValue, baseFontSize);
            const fontSize = textWidth > box.width * 0.9
                ? Math.max(8, baseFontSize * ((box.width * 0.9) / Math.max(textWidth, 1)))
                : baseFontSize;
            page.drawText(textValue, {
                x: box.x + 4,
                y: box.y + Math.max(2, (box.height - fontSize) / 2),
                size: fontSize,
                font: helvetica,
                color: rgb(0, 0, 0.55)
            });
        }

        if (field.type === 'date') {
            const signedAt = signatureValue?.signedAt || signRequest.recipients?.find((item) => item.email === recipientEmail)?.signedAt;
            const dateText = signedAt
                ? new Date(signedAt).toLocaleDateString('ja-JP')
                : new Date().toLocaleDateString('ja-JP');
            const fontSize = Math.max(10, Math.min(18, box.height * 0.45));
            page.drawText(dateText, {
                x: box.x + 4,
                y: box.y + Math.max(2, (box.height - fontSize) / 2),
                size: fontSize,
                font: helvetica,
                color: rgb(0.12, 0.32, 0.18)
            });
        }
    }

    pdfDoc.setTitle(signRequest.document_name || signRequest.fileName || 'DIFFsense Signed Document');
    pdfDoc.setSubject('DIFFsense 電子署名済み書類');
    pdfDoc.setCreationDate(new Date());

    const signedBytes = await pdfDoc.save();
    const saved = await saveCompletedPdf(signRequest.id, Buffer.from(signedBytes), req);

    return {
        ...saved,
        completedAt: new Date().toISOString()
    };
}

function buildDocumentSnapshot(contract) {
    return {
        id: contract.id,
        name: contract.name || '',
        type: contract.type || '',
        pdf_url: contract.pdf_url || '',
        pdf_storage_path: contract.pdf_storage_path || '',
        original_content: contract.original_content || '',
        source_url: contract.source_url || '',
        original_filename: contract.original_filename || ''
    };
}

function normalizeRecipients(recipients) {
    return (Array.isArray(recipients) ? recipients : [])
        .map((recipient) => {
            const email = String(recipient?.email || '').trim();
            let name = String(recipient?.name || '').trim();
            if (name && email && name.toLowerCase() === email.toLowerCase()) {
                name = email.split('@')[0];
            }
            return {
                ...recipient,
                email,
                name,
                display_name: name ? `${name}様` : ''
            };
        })
        .filter((recipient) => recipient.email && recipient.name);
}

function resolveUploadsPath(value) {
    const normalized = String(value || '').trim().replace(/\\/g, '/');
    if (!normalized) return '';
    const uploadsIndex = normalized.toLowerCase().indexOf('/uploads/');
    if (uploadsIndex >= 0) {
        return path.join(__dirname, '..', '..', normalized.slice(uploadsIndex + 1));
    }
    if (normalized.startsWith('/uploads/')) {
        return path.join(__dirname, '..', '..', normalized.slice(1));
    }
    return '';
}

async function loadContractPdfBuffer(contract) {
    const candidates = [
        contract?.pdf_storage_path,
        contract?.pdf_url
    ];

    for (const candidate of candidates) {
        const value = String(candidate || '').trim();
        if (!value) continue;

        try {
            if (fs.existsSync(value)) {
                return fs.readFileSync(value);
            }
        } catch {}

        const uploadsPath = resolveUploadsPath(value);
        if (uploadsPath) {
            try {
                if (fs.existsSync(uploadsPath)) {
                    return fs.readFileSync(uploadsPath);
                }
            } catch {}
        }

        if (/^https?:\/\//i.test(value)) {
            try {
                const response = await axios.get(value, { responseType: 'arraybuffer' });
                return Buffer.from(response.data);
            } catch (error) {
                logger.warn('Remote PDF fetch failed during Firma create', {
                    source: value,
                    error: error.message
                });
            }
        }
    }

    return null;
}

async function getRequestSigningUrl(signRequest, recipient) {
    if (signRequest?.firma_request_id) {
        const urlMap = await firmaService.getSigningUrls(signRequest.firma_request_id);
        return urlMap[String(recipient?.email || '').trim()] || recipient?.signing_url || null;
    }
    if (signRequest?.zoho_request_id && recipient?.action_id) {
        return zohoService.getEmbeddedUrl(signRequest.zoho_request_id, recipient.action_id);
    }
    return null;
}

async function ensureSignTrialQuota(ownerUid) {
    const userProfile = await dbService.getUserProfile(ownerUid);
    if (!dbService.isTrialActive(userProfile)) {
        return { limited: false, remaining: null };
    }

    const requests = await dbService.getSignRequests(ownerUid);
    const count = (Array.isArray(requests) ? requests : []).filter((request) => {
        const requestOwner = String(request?.ownerUid || request?.requestedBy || '').trim();
        if (requestOwner && requestOwner !== String(ownerUid)) return false;
        const createdAt = new Date(request?.created_at || 0).getTime();
        const trialStartedAt = new Date(userProfile?.trialStartedAt || 0).getTime();
        if (!Number.isNaN(trialStartedAt) && trialStartedAt > 0 && !Number.isNaN(createdAt) && createdAt > 0) {
            return createdAt >= trialStartedAt;
        }
        return true;
    }).length;

    if (count >= TRIAL_SIGN_REQUEST_LIMIT) {
        return {
            limited: true,
            remaining: 0,
            message: `トライアル期間中の署名は${TRIAL_SIGN_REQUEST_LIMIT}回までです。継続して利用するにはプラン登録をお願いします。`
        };
    }

    return {
        limited: false,
        remaining: Math.max(0, TRIAL_SIGN_REQUEST_LIMIT - count)
    };
}

router.post('/create', async (req, res) => {
    try {
        const { contractId, recipients, document_snapshot: documentSnapshot, document_name: documentName } = req.body;
        const ownerUid = req.user.uid;

        if ((!contractId && !documentSnapshot?.id) || !recipients || recipients.length === 0) {
            return res.status(400).json({ success: false, error: 'Missing parameters' });
        }

        const normalizedRecipients = normalizeRecipients(recipients);
        if (normalizedRecipients.length === 0) {
            return res.status(400).json({ success: false, error: 'Recipient name and email are required' });
        }

        const quota = await ensureSignTrialQuota(ownerUid);
        if (quota.limited) {
            return res.status(403).json({
                success: false,
                error: quota.message,
                code: 'TRIAL_SIGN_LIMIT_REACHED'
            });
        }

        const contracts = await dbService.getContracts(ownerUid);
        let contract = contracts.find((item) => item.id === contractId || String(item.id) === String(contractId));
        if (!contract && documentSnapshot) {
            contract = {
                id: contractId || documentSnapshot.id || Date.now(),
                name: documentName || documentSnapshot.name || '',
                ...documentSnapshot
            };
            logger.warn('Sign create using document_snapshot fallback', {
                ownerUid,
                contractId,
                snapshotId: documentSnapshot.id || null,
                snapshotName: documentSnapshot.name || ''
            });
        }
        if (!contract) {
            return res.status(404).json({ success: false, error: 'Contract not found' });
        }

        let providerPayload = {};
        if (useDiffsenseProvider()) {
            providerPayload = {
                provider: 'diffsense',
                recipients: normalizedRecipients.map((recipient, index) => ({
                    ...recipient,
                    status: 'pending',
                    order: index + 1
                })),
                recipientTokens: {},
                signatures: {}
            };
        } else if (useFirmaProvider()) {
            const pdfBuffer = await loadContractPdfBuffer(contract);
            if (!pdfBuffer?.length) {
                return res.status(400).json({ success: false, error: 'PDFファイルを取得できないため、署名依頼を作成できませんでした' });
            }

            const fileName = contract.original_filename || contract.name || 'document.pdf';
            const created = await firmaService.createSigningRequest({
                name: contract.name || fileName,
                pdfBase64: pdfBuffer.toString('base64'),
                fileName,
                recipients: normalizedRecipients
            });

            providerPayload = {
                provider: 'firma',
                firma_request_id: created.firmaRequestId,
                firma_recipient_id_map: created.recipientIdMap,
                recipients: normalizedRecipients.map((recipient, index) => ({
                    ...recipient,
                    action_id: recipient.email,
                    status: 'pending',
                    order: index + 1
                }))
            };
        } else {
            const signResult = await zohoService.createSignRequest(null, contract.name, normalizedRecipients);
            providerPayload = {
                provider: 'zoho',
                zoho_request_id: signResult.request_id,
                actions: signResult.actions,
                recipients: normalizedRecipients.map((recipient, index) => ({
                    ...recipient,
                    action_id: signResult.actions[index].action_id,
                    status: 'pending'
                }))
            };
        }

        const newRequest = await dbService.addSignRequest(ownerUid, {
            ownerUid,
            document_name: contract.name,
            contract_id: contract.id,
            document_snapshot: buildDocumentSnapshot(contract),
            status: 'pending',
            sender: req.user.name || 'USER',
            requestedBy: ownerUid,
            requestedByEmail: req.user.email || '',
            requestedByName: req.user.name || req.user.displayName || req.user.email || 'DIFFsense ユーザー',
            ...providerPayload
        });

        if (!useFirmaProvider()) {
            await Promise.allSettled(newRequest.recipients.map(async (recipient) => {
                try {
                    const signUrl = await getRequestSigningUrl(newRequest, recipient);
                    await mailer.sendSigningRequestEmail({
                        to: recipient.email,
                        recipientName: recipient.name,
                        fileName: contract.name,
                        senderName: req.user.name || 'DIFFsense',
                        signingUrl: signUrl
                    });
                } catch (mailError) {
                    logger.warn('Signature email send skipped/failed', {
                        email: recipient.email,
                        error: mailError.message
                    });
                }
            }));
        }

        res.json({ success: true, data: newRequest });
    } catch (error) {
        logger.error('API Sign Create Error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/embed/:requestId/:actionId', async (req, res) => {
    try {
        const { requestId, actionId } = req.params;
        if (useFirmaProvider()) {
            const requests = await dbService.getSignRequests(req.user.uid);
            const signRequest = requests.find((item) =>
                String(item.firma_request_id || '') === String(requestId)
                || String(item.id) === String(requestId)
            );
            if (!signRequest?.firma_request_id) {
                throw new Error('Firma request not found');
            }
            const urls = await firmaService.getSigningUrls(signRequest.firma_request_id);
            const url = urls[String(actionId || '').trim()];
            if (!url) {
                throw new Error('Could not retrieve signing URL');
            }
            return res.json({ success: true, data: { url } });
        }

        const url = await zohoService.getEmbeddedUrl(requestId, actionId);
        res.json({ success: true, data: { url } });
    } catch (error) {
        logger.error('API Sign Embed URL Error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/list', async (req, res) => {
    try {
        const ownerUid = req.user.uid;
        const requests = await syncExpiredSignRequests(await dbService.getSignRequests(ownerUid));
        res.json({ success: true, data: requests });
    } catch (error) {
        logger.error('API Sign List Error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/:id/signing-url', async (req, res) => {
    try {
        const requests = await dbService.getSignRequests(req.user.uid);
        const signRequest = requests.find((item) => String(item.id) === String(req.params.id));
        if (!signRequest) {
            return res.status(404).json({ success: false, error: 'Request not found' });
        }
        if (!signRequest.firma_request_id) {
            return res.json({ success: true, data: { urls: {} } });
        }
        const urls = await firmaService.getSigningUrls(signRequest.firma_request_id);
        res.json({ success: true, data: { urls } });
    } catch (error) {
        logger.error('API Sign Signing URL Error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/verify', async (req, res) => {
    try {
        const token = String(req.query.token || '').trim();
        if (!token) {
            return res.status(400).json({ success: false, error: 'トークンがありません' });
        }

        const payload = jwt.verify(token, String(process.env.JWT_SECRET || '').trim());
        const requests = await dbService.getSignRequests(null);
        const signRequest = await markSignRequestExpired(findSignRequestById(requests, payload.signRequestId));

        if (!signRequest) {
            return res.status(404).json({ success: false, error: '署名依頼が見つかりません' });
        }
        if (signRequest.status === 'expired') {
            return res.status(410).json({ success: false, error: '有効期限が切れましたので、再度発行依頼をしていただくようお願いいたします。' });
        }
        if (signRequest.status === 'completed') {
            return res.status(410).json({ success: false, error: 'この署名依頼はすでに完了しています' });
        }

        const recipient = (signRequest.recipients || []).find((item) => String(item.email || '').trim() === String(payload.email || '').trim());
        if (!recipient) {
            return res.status(403).json({ success: false, error: '署名者として登録されていません' });
        }
        if (recipient.status === 'signed' || recipient.status === 'completed') {
            return res.status(410).json({ success: false, error: 'すでに署名済みです' });
        }

        const fields = annotateFieldsWithRecipientEmail(signRequest.fields || [], signRequest.recipients || []);
        const pdfUrl = resolveSignRequestPdfUrl(signRequest, req);
        if (!pdfUrl) {
            return res.status(404).json({ success: false, error: '原本PDFが見つかりません' });
        }

        return res.json({
            success: true,
            data: {
                signRequestId: String(signRequest.id),
                email: recipient.email,
                recipientName: recipient.name || recipient.email,
                fileName: signRequest.document_name || '',
                pdfUrl,
                provider: signRequest.provider || 'diffsense',
                fields,
                fieldStyles: signRequest.fieldStyles || {},
                signatures: signRequest.signatures?.[recipient.email] || {}
            }
        });
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            await markExpiredFromToken(req.query.token);
            return res.status(401).json({ success: false, error: '有効期限が切れましたので、再度発行依頼をしていただくようお願いいたします。' });
        }
        return res.status(401).json({ success: false, error: '無効な署名リンクです' });
    }
});

router.post('/decline', async (req, res) => {
    try {
        const token = String(req.body?.token || '').trim();
        if (!token) {
            return res.status(400).json({ success: false, error: 'トークンがありません' });
        }

        const payload = jwt.verify(token, String(process.env.JWT_SECRET || '').trim());
        const requests = await dbService.getSignRequests(null);
        const signRequest = findSignRequestById(requests, payload.signRequestId);
        if (!signRequest) {
            return res.status(404).json({ success: false, error: '署名依頼が見つかりません' });
        }

        const declinedAt = new Date().toISOString();
        const updatedRecipients = (signRequest.recipients || []).map((recipient) =>
            String(recipient.email || '').trim() === String(payload.email || '').trim()
                ? { ...recipient, status: 'declined', declinedAt }
                : recipient
        );

        const saved = await dbService.updateSignRequest(
            signRequest.id,
            {
                status: 'declined',
                declinedAt,
                recipients: updatedRecipients
            },
            signRequest.ownerUid || signRequest.requestedBy || null
        );

        const declinedRecipient = updatedRecipients.find((recipient) =>
            String(recipient.email || '').trim() === String(payload.email || '').trim()
        );
        await sendRecipientActionNotice(saved || { ...signRequest, recipients: updatedRecipients, status: 'declined' }, declinedRecipient, '署名を辞退しました');

        return res.json({ success: true, data: { status: 'declined' } });
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            await markExpiredFromToken(req.body?.token);
        }
        return res.status(401).json({ success: false, error: '無効なトークンです' });
    }
});

router.post('/submit', async (req, res) => {
    try {
        const token = String(req.body?.token || '').trim();
        const signatures = Array.isArray(req.body?.signatures) ? req.body.signatures : [];
        if (!token) {
            return res.status(400).json({ success: false, error: 'トークンがありません' });
        }

        const payload = jwt.verify(token, String(process.env.JWT_SECRET || '').trim());
        const requests = await dbService.getSignRequests(null);
        const signRequest = findSignRequestById(requests, payload.signRequestId);
        if (!signRequest) {
            return res.status(404).json({ success: false, error: '署名依頼が見つかりません' });
        }

        const email = String(payload.email || '').trim();
        const annotatedFields = annotateFieldsWithRecipientEmail(signRequest.fields || [], signRequest.recipients || []);
        const updatedRecipients = (signRequest.recipients || []).map((recipient) =>
            String(recipient.email || '').trim() === email
                ? { ...recipient, status: 'signed', signedAt: new Date().toISOString() }
                : recipient
        );

        const currentSignatures = { ...(signRequest.signatures || {}) };
        const signatureMap = { ...(currentSignatures[email] || {}) };
        for (const signature of signatures) {
            const signatureType = String(signature?.type || 'draw').trim();
            const hasDrawData = Boolean(signature?.dataUrl);
            const hasTextData = signatureType === 'text' && Boolean(String(signature?.fontText || '').trim());
            if (!signature?.fieldId || (!hasDrawData && !hasTextData)) continue;
            signatureMap[String(signature.fieldId)] = {
                fieldId: String(signature.fieldId),
                type: signatureType,
                dataUrl: hasDrawData ? signature.dataUrl : '',
                fontName: signature.fontName || '',
                fontText: hasTextData ? String(signature.fontText || '').trim() : '',
                signedAt: new Date().toISOString(),
                ipAddress: req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown'
            };
        }
        currentSignatures[email] = signatureMap;

        const requiredSignatureFields = annotatedFields.filter((field) =>
            field.type === 'signature'
            && String(field.recipientEmail || '').trim() === email
            && field.required !== false
        );
        const missingRequiredSignature = requiredSignatureFields.find((field) => {
            const savedSignature = signatureMap[String(field.id)];
            if (!savedSignature) return true;
            if (savedSignature.type === 'text') {
                return !String(savedSignature.fontText || '').trim() && !String(savedSignature.dataUrl || '').trim();
            }
            return !String(savedSignature.dataUrl || '').trim();
        });
        if (missingRequiredSignature) {
            return res.status(400).json({ success: false, error: '必須の署名欄が未入力です。署名を入力してから完了してください。' });
        }

        const allSigned = updatedRecipients.length > 0 && updatedRecipients.every((recipient) => recipient.status === 'signed');
        const updates = {
            signatures: currentSignatures,
            recipients: updatedRecipients
        };

        const draftForPdf = {
            ...signRequest,
            signatures: currentSignatures,
            recipients: updatedRecipients,
            fields: annotatedFields
        };

        if (allSigned) {
            const completed = await generateSignedPdf(draftForPdf, req);
            Object.assign(updates, {
                status: 'completed',
                completedAt: completed.completedAt,
                signedPdfPath: completed.signedPdfPath,
                pdfHash: completed.pdfHash,
                storageRegion: completed.storageRegion,
                provider: 'diffsense',
                completed_document_url: completed.completedDocumentUrl,
                completed_document_synced_at: completed.completedAt,
                completed_document_source: 'diffsense'
            });
        }

        const saved = await dbService.updateSignRequest(
            signRequest.id,
            updates,
            signRequest.ownerUid || signRequest.requestedBy || null
        );

        const actingRecipient = updatedRecipients.find((recipient) =>
            String(recipient.email || '').trim() === email
        );

        if (allSigned && saved?.completed_document_url) {
            await sendCompletionNotice(saved, saved.completed_document_url);
        } else {
            await sendRecipientActionNotice(saved || { ...signRequest, recipients: updatedRecipients }, actingRecipient, '署名が完了しました');
        }

        return res.json({ success: true, data: { allSigned, request: saved || updates } });
    } catch (error) {
        logger.error('[sign submit] error', { error: error.message });
        if (error.name === 'TokenExpiredError') {
            await markExpiredFromToken(req.body?.token);
            return res.status(401).json({ success: false, error: '有効期限が切れましたので、再度発行依頼をしていただくようお願いいたします。' });
        }
        return res.status(500).json({ success: false, error: error.message || '署名の送信に失敗しました' });
    }
});

router.patch('/:id', async (req, res) => {
    try {
        console.log('[sign PATCH] called', { id: req.params.id, body: req.body, uid: req.user?.uid });
        const { id } = req.params;
        const updates = { ...req.body };
        const ownerUid = req.user.uid;
        const requests = await dbService.getSignRequests(ownerUid);
        const existing = requests.find((item) => String(item.id) === String(id));

        if (!existing) {
            return res.status(404).json({ success: false, error: 'Request not found' });
        }

        const mergedRecipients = Array.isArray(updates.recipients) ? updates.recipients : (existing.recipients || []);
        const mergedFields = Array.isArray(updates.fields) ? updates.fields : (existing.fields || []);
        const mergedFieldStyles = updates.fieldStyles && typeof updates.fieldStyles === 'object'
            ? updates.fieldStyles
            : (existing.fieldStyles || {});
        const pageDimensions = updates.page_dimensions || existing.page_dimensions || {};
        const annotatedFields = annotateFieldsWithRecipientEmail(mergedFields, mergedRecipients);

        let providerAugments = {};
        if ((existing.provider === 'diffsense' || useDiffsenseProvider()) && updates.status === 'sent') {
            const recipientTokens = createRecipientTokens(id, mergedRecipients);
            providerAugments = {
                provider: 'diffsense',
                sent_at: new Date().toISOString(),
                expiresAt: getSignRequestExpiryIso({ ...existing, recipientTokens }),
                recipientTokens,
                fields: annotatedFields,
                recipients: mergedRecipients.map((recipient) => ({
                    ...recipient,
                    status: recipient.status === 'signed' ? 'signed' : 'pending'
                }))
            };
        } else if (existing.firma_request_id && updates.status === 'sent') {
            if (mergedFields.length > 0) {
                await firmaService.updateFieldsWithRecipients({
                    firmaRequestId: existing.firma_request_id,
                    fields: mergedFields,
                    recipients: mergedRecipients,
                    recipientIdMap: existing.firma_recipient_id_map || {},
                    pageDimensions
                });
            }

            await firmaService.sendSigningRequest({
                firmaRequestId: existing.firma_request_id,
                fileName: existing.document_name,
                senderName: req.user.name || 'DIFFsense'
            });

            const signingUsers = await firmaService.getSigningUsers(existing.firma_request_id);
            providerAugments = {
                sent_at: new Date().toISOString(),
                recipients: mergedRecipients.map((recipient) => ({
                    ...recipient,
                    action_id: recipient.email,
                    signing_url: signingUsers[String(recipient.email || '').trim()]?.signingUrl || recipient.signing_url || null,
                    status: recipient.status || 'pending'
                }))
            };
        }

        const updated = await dbService.updateSignRequest(id, {
            ...updates,
            fields: annotatedFields,
            fieldStyles: mergedFieldStyles,
            page_dimensions: pageDimensions,
            ...providerAugments
        }, ownerUid);

        logger.info('[sign PATCH] reached mail block', {
            hasFirmaKey: !!process.env.FIRMA_API_KEY,
            hasResendKey: !!process.env.RESEND_API_KEY,
            firmaId: existing?.firma_request_id || updated?.firma_request_id || null
        });

        if (updated && updates.status === 'sent' && process.env.RESEND_API_KEY) {
            try {
                const recipients = updated.recipients || mergedRecipients || [];
                const fileName = updated.document_name || existing.document_name || '';
                const senderName = req.user.name || req.user.displayName || req.user.email || 'DIFFsense ユーザー';
                logger.info('[sign PATCH] sending signature request emails', {
                    requestId: updated.id || id,
                    recipientCount: recipients.length,
                    fileName
                });

                for (const recipient of recipients) {
                    const signingUrl = updated.provider === 'diffsense'
                        ? buildTokenSigningUrl(updated.recipientTokens?.[recipient.email])
                        : (recipient.signing_url || null);
                    if (!signingUrl) {
                        logger.warn('[sign PATCH] signing URL not found', {
                            requestId: updated.id || id,
                            email: recipient.email
                        });
                        continue;
                    }
                    await mailer.sendSigningRequestEmail({
                        to: recipient.email,
                        recipientName: recipient.name || recipient.email,
                        senderName,
                        fileName,
                        signingUrl
                    }).catch((mailError) => logger.error('[sign PATCH] mail error', {
                        requestId: updated.id || id,
                        email: recipient.email,
                        error: mailError.message
                    }));
                }
            } catch (mailFlowErr) {
                logger.error('[sign PATCH] mail flow error', {
                    requestId: updated?.id || id,
                    error: mailFlowErr.message
                });
            }
        }

        if (updated) {
            res.json({ success: true, data: updated });
        } else {
            res.status(404).json({ success: false, error: 'Request not found' });
        }
    } catch (error) {
        logger.error('API Sign Patch Error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/:id/remind', async (req, res) => {
    try {
        const { id } = req.params;
        const ownerUid = req.user.uid;
        const requests = await dbService.getSignRequests(ownerUid);
        const signRequest = requests.find((item) => String(item.id) === String(id));

        if (!signRequest) {
            return res.status(404).json({ success: false, error: 'Request not found' });
        }

        const pendingRecipients = (signRequest.recipients || []).filter((recipient) => recipient.status !== 'completed');
        if (pendingRecipients.length === 0) {
            return res.json({ success: true, data: { reminded: 0 } });
        }

        if ((signRequest.provider === 'diffsense' || signRequest.firma_request_id) && process.env.RESEND_API_KEY) {
            try {
                const senderName = req.user.name || req.user.displayName || req.user.email || 'DIFFsense ユーザー';
                const signingUrls = signRequest.provider === 'diffsense'
                    ? null
                    : await firmaService.getSigningUrls(signRequest.firma_request_id);
                let count = 0;

                for (const recipient of (signRequest.recipients || []).filter((item) => item.status !== 'signed')) {
                    const signingUrl = signRequest.provider === 'diffsense'
                        ? buildTokenSigningUrl(signRequest.recipientTokens?.[recipient.email])
                        : (signingUrls?.[String(recipient.email || '').trim()] || recipient.signing_url || null);
                    if (!signingUrl) continue;
                    await mailer.sendReminderEmail({
                        to: recipient.email,
                        recipientName: recipient.name || recipient.email,
                        senderName,
                        fileName: signRequest.document_name || '',
                        signingUrl
                    }).catch((mailError) => logger.error('[sign/remind] mail error', {
                        requestId: signRequest.id || id,
                        email: recipient.email,
                        error: mailError.message
                    }));
                    count++;
                }

                const updated = await dbService.updateSignRequest(id, {
                    reminder_sent_at: new Date().toISOString()
                }, ownerUid);

                return res.json({ success: true, data: { reminded: count, request: updated || signRequest } });
            } catch (err) {
                logger.error('[sign/remind] error', {
                    requestId: signRequest?.id || id,
                    error: err.message
                });
                return res.status(500).json({ success: false, error: 'リマインド送信に失敗しました' });
            }
        }

        const reminderResults = await Promise.allSettled(pendingRecipients.map(async (recipient) => {
            const signUrl = await getRequestSigningUrl(signRequest, recipient);
            return mailer.sendReminderEmail({
                to: recipient.email,
                recipientName: recipient.name,
                fileName: signRequest.document_name,
                senderName: req.user.name || 'DIFFsense',
                signingUrl: signUrl
            });
        }));

        const reminded = reminderResults.filter((result) => result.status === 'fulfilled').length;
        const updated = await dbService.updateSignRequest(id, {
            reminder_sent_at: new Date().toISOString()
        }, ownerUid);

        res.json({ success: true, data: { reminded, request: updated || signRequest } });
    } catch (error) {
        logger.error('API Sign Reminder Error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
