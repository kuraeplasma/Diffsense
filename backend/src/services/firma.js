'use strict';

const axios = require('axios');
const crypto = require('crypto');

const DEFAULT_BASE_URL = 'https://api.firma.dev/functions/v1/signing-request-api';

function getBaseUrl() {
    return String(process.env.FIRMA_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
}

function getAuthHeader() {
    const apiKey = String(process.env.FIRMA_API_KEY || '').trim();
    if (!apiKey) return '';
    return apiKey.toLowerCase().startsWith('bearer ') ? apiKey : `Bearer ${apiKey}`;
}

function headers() {
    return {
        Authorization: getAuthHeader(),
        'Content-Type': 'application/json'
    };
}

function splitName(fullName) {
    const normalized = String(fullName || '').trim().replace(/\s+/g, ' ');
    if (!normalized) {
        return { first_name: 'ご担当', last_name: '者' };
    }
    const parts = normalized.split(' ');
    if (parts.length === 1) {
        return { first_name: parts[0], last_name: '-' };
    }
    return {
        first_name: parts[0],
        last_name: parts.slice(1).join(' ')
    };
}

function toFirmaRecipients(recipients) {
    return (Array.isArray(recipients) ? recipients : []).map((recipient, index) => ({
        ...splitName(recipient?.name),
        email: String(recipient?.email || '').trim(),
        designation: 'Signer',
        order: Number(recipient?.order || index + 1)
    }));
}

function buildIndexToRecipientIdMap(recipients, recipientIdMap) {
    const map = {};
    (Array.isArray(recipients) ? recipients : []).forEach((recipient, index) => {
        const email = String(recipient?.email || '').trim();
        if (email && recipientIdMap?.[email]) {
            map[index] = recipientIdMap[email];
        }
    });
    return map;
}

function toFirmaFields(fields, indexToRecipientIdMap = {}, pageDimensions = {}) {
    return (Array.isArray(fields) ? fields : []).map((field) => {
        const pageNumber = Math.max(1, Number(field?.page || 1));
        const dims = pageDimensions?.[pageNumber] || pageDimensions?.[String(pageNumber)] || { width: 595, height: 842 };
        const widthPx = Number(field?.width || (field?.type === 'signature' ? 88 : 130));
        const heightPx = Number(field?.height || (field?.type === 'signature' ? 88 : 48));
        const xPercent = Number(field?.x || 0);
        const yPercent = Number(field?.y || 0);
        const toPercent = (value, size) => Number.isFinite(size) && size > 0
            ? Number(((Number(value || 0) / size) * 100).toFixed(2))
            : 0;

        return {
            type: {
                signature: 'signature',
                initials: 'initials',
                date: 'date',
                name: 'text',
                text: 'text',
                checkbox: 'checkbox'
            }[field?.type] || 'text',
            required: field?.required !== false,
            recipient_id: indexToRecipientIdMap[Number(field?.assigneeIndex ?? 0)] || null,
            page_number: pageNumber,
            position: {
                x: Number(xPercent.toFixed ? xPercent.toFixed(2) : Number(xPercent).toFixed(2)),
                y: Number(yPercent.toFixed ? yPercent.toFixed(2) : Number(yPercent).toFixed(2)),
                width: toPercent(widthPx, Number(dims.width || 595)),
                height: toPercent(heightPx, Number(dims.height || 842))
            },
            ...(field?.type === 'date' ? { date_signing_default: true } : {})
        };
    });
}

async function createSigningRequest({ name, pdfBase64, fileName, recipients }) {
    try {
        const response = await axios.post(
            `${getBaseUrl()}/signing-requests`,
            {
                name,
                document: pdfBase64,
                filename: fileName,
                recipients: toFirmaRecipients(recipients),
                settings: {
                    send_signing_email: false,
                    send_finish_email: false,
                    send_expiration_email: false,
                    send_cancellation_email: false
                }
            },
            { headers: headers() }
        );

        const recipientIdMap = {};
        for (const recipient of response.data?.recipients || []) {
            const email = String(recipient?.email || '').trim();
            if (email && recipient?.id) {
                recipientIdMap[email] = recipient.id;
            }
        }

        return {
            firmaRequestId: response.data?.id,
            recipientIdMap,
            rawResponse: response.data
        };
    } catch (error) {
        const detail = error.response?.data ? JSON.stringify(error.response.data) : error.message;
        console.error('[firma] createSigningRequest error', {
            status: error.response?.status || null,
            data: error.response?.data || null,
            requestName: name,
            fileName,
            recipientCount: Array.isArray(recipients) ? recipients.length : 0,
            recipients: toFirmaRecipients(recipients)
        });
        throw new Error(`Firma create failed (${error.response?.status || 'unknown'}): ${detail}`);
    }
}

async function updateFieldsWithRecipients({
    firmaRequestId,
    fields,
    recipients,
    recipientIdMap,
    pageDimensions
}) {
    if (!firmaRequestId || !Array.isArray(fields) || fields.length === 0) return;
    const indexToRecipientIdMap = buildIndexToRecipientIdMap(recipients, recipientIdMap);
    const firmaFields = toFirmaFields(fields, indexToRecipientIdMap, pageDimensions || {});
    try {
        await axios.put(
            `${getBaseUrl()}/signing-requests/${encodeURIComponent(firmaRequestId)}`,
            { fields: firmaFields },
            { headers: headers() }
        );
    } catch (error) {
        const detail = error.response?.data ? JSON.stringify(error.response.data) : error.message;
        throw new Error(`Firma fields update failed (${error.response?.status || 'unknown'}): ${detail}`);
    }
}

async function sendSigningRequest({ firmaRequestId, fileName, senderName }) {
    const safeFileName = String(fileName || '書類').trim();
    const safeSenderName = String(senderName || 'DIFFsense').trim();
    try {
        await axios.post(
            `${getBaseUrl()}/signing-requests/${encodeURIComponent(firmaRequestId)}/send`,
            {
                custom_message: [
                    `${safeSenderName}より、電子署名の依頼をお送りしています。`,
                    '',
                    `対象書類: ${safeFileName}`,
                    '',
                    '下記リンクより書類内容をご確認のうえ、ご署名をお願いいたします。',
                    'ご不明な点がある場合は、依頼元へご確認ください。'
                ].join('\n')
            },
            { headers: headers() }
        );
    } catch (error) {
        const detail = error.response?.data ? JSON.stringify(error.response.data) : error.message;
        throw new Error(`Firma send failed (${error.response?.status || 'unknown'}): ${detail}`);
    }
}

async function getSigningUrls(firmaRequestId) {
    const response = await axios.get(
        `${getBaseUrl()}/signing-requests/${encodeURIComponent(firmaRequestId)}`,
        { headers: headers() }
    );
    const urlMap = {};
    for (const recipient of response.data?.recipients || []) {
        const email = String(recipient?.email || '').trim();
        if (!email) continue;
        urlMap[email] = recipient.signing_url || (recipient.id ? `https://app.firma.dev/signing/${recipient.id}` : null);
    }
    return urlMap;
}

async function getSigningUsers(firmaRequestId) {
    console.log('[firma] getSigningUsers called', { firmaRequestId });
    const response = await axios.get(
        `${getBaseUrl()}/signing-requests/${encodeURIComponent(firmaRequestId)}/users`,
        { headers: headers() }
    );
    const users = response.data?.results || response.data?.recipients || [];
    const map = {};
    for (const user of users) {
        const email = String(user?.email || '').trim();
        if (!email) continue;
        map[email] = {
            userId: user.id,
            signingUrl: user.signing_url || (user.id ? `https://app.firma.dev/signing/${user.id}` : null)
        };
    }
    return map;
}

async function downloadSignedPdf(firmaRequestId) {
    const response = await axios.get(
        `${getBaseUrl()}/signing-requests/${encodeURIComponent(firmaRequestId)}/download`,
        {
            headers: headers(),
            responseType: 'arraybuffer'
        }
    );
    return Buffer.from(response.data);
}

async function deleteSigningRequest(firmaRequestId) {
    await axios.delete(
        `${getBaseUrl()}/signing-requests/${encodeURIComponent(firmaRequestId)}`,
        { headers: headers() }
    );
}

function verifyWebhook(rawBody, signatureHeader) {
    const secret = String(process.env.FIRMA_WEBHOOK_SECRET || '').trim();
    if (!secret) return false;
    if (!signatureHeader) return false;

    const parts = {};
    String(signatureHeader).split(',').forEach((part) => {
        const idx = part.indexOf('=');
        if (idx > 0) {
            parts[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
        }
    });

    const timestamp = parts.t;
    const signature = parts.v1;
    if (!timestamp || !signature) return false;

    const age = Math.floor(Date.now() / 1000) - Number(timestamp);
    if (!Number.isFinite(age) || age > 300) return false;

    const signedPayload = `${timestamp}.${rawBody}`;
    const expected = crypto
        .createHmac('sha256', secret)
        .update(signedPayload)
        .digest('hex');

    try {
        return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    } catch {
        return false;
    }
}

function isConfigured() {
    return Boolean(String(process.env.FIRMA_API_KEY || '').trim());
}

module.exports = {
    isConfigured,
    splitName,
    toFirmaRecipients,
    toFirmaFields,
    createSigningRequest,
    updateFieldsWithRecipients,
    sendSigningRequest,
    getSigningUrls,
    getSigningUsers,
    downloadSignedPdf,
    deleteSigningRequest,
    verifyWebhook
};
