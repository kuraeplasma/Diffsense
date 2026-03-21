'use strict';

const { Resend } = require('resend');
const logger = require('../utils/logger');

const FROM = process.env.MAIL_FROM || 'noreply@send.spacegleam.co.jp';
const REPLY_TO = process.env.MAIL_REPLY_TO || 'contact@spacegleam.co.jp';

let resendClient = null;

function getResendClient() {
    if (resendClient) {
        return resendClient;
    }
    const apiKey = String(process.env.RESEND_API_KEY || '').trim();
    if (!apiKey) {
        throw new Error('RESEND_API_KEY is not configured');
    }
    resendClient = new Resend(apiKey);
    return resendClient;
}

function formatResendError(error) {
    if (!error) return 'Unknown Resend error';
    if (typeof error === 'string') return error;
    if (error.message) return error.message;
    try {
        return JSON.stringify(error);
    } catch (_) {
        return String(error);
    }
}

function _isEmailLike(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function _normalizeHonorificName(name, email, fallback = 'ご担当者') {
    const rawName = String(name || '').trim();
    if (rawName && !_isEmailLike(rawName)) {
        return rawName;
    }
    const mail = String(email || '').trim();
    if (mail) {
        const localPart = mail.split('@')[0] || '';
        const cleaned = localPart
            .replace(/[._+-]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        if (cleaned) {
            return cleaned;
        }
    }
    return fallback;
}
function _frontendBaseUrl() {
    const explicit = String(process.env.FRONTEND_URL || '').trim();
    if (explicit) {
        return explicit.replace(/\/$/, '');
    }
    const appUrl = String(process.env.APP_URL || '').trim();
    if (appUrl) {
        return appUrl.replace('://localhost:3001', '://localhost:3000').replace(/\/$/, '');
    }
    return 'https://diffsense.spacegleam.co.jp';
}

function _wrapSigningUrl(signingUrl, fileName = '') {
    const normalized = String(signingUrl || '').trim();
    if (!normalized) return '';
    if (/\/signing\.html\?/i.test(normalized) || /[?&]token=/i.test(normalized)) {
        return normalized;
    }
    const base = _frontendBaseUrl();
    return `${base}/signing.html?url=${encodeURIComponent(normalized)}&name=${encodeURIComponent(fileName || '')}`;
}

async function sendSigningRequestEmail({ to, recipientName, senderName, fileName, signingUrl }) {
    const resend = getResendClient();
    const wrappedSigningUrl = _wrapSigningUrl(signingUrl, fileName);
    const result = await resend.emails.send({
        from: FROM,
        to: [to],
        reply_to: REPLY_TO,
        subject: `【署名依頼】${fileName}`,
        html: _signingHtml({ recipientName, senderName, fileName, signingUrl: wrappedSigningUrl }),
        text: `${recipientName} 様\n\n${senderName}より署名依頼をお送りしています。\n\n対象書類: ${fileName}\n\n署名はこちら:\n${wrappedSigningUrl}\n\nご不明点は依頼元（${senderName}）へご確認ください。\n---\nDIFFsense`
    });
    if (result.error) {
        const detail = formatResendError(result.error);
        logger.error(`[mailer] sendSigningRequestEmail failed to=${to} from=${FROM} replyTo=${REPLY_TO} error=${detail}`);
        throw new Error(detail);
    }
    logger.info(`[mailer] sendSigningRequestEmail sent to=${to} emailId=${result.data?.id || 'unknown'}`);
}

async function sendCompletionEmail({ to, senderName, fileName, downloadUrl }) {
    const resend = getResendClient();
    const honorificName = _normalizeHonorificName(senderName, to, 'ご担当者');
    const result = await resend.emails.send({
        from: FROM,
        to: [to],
        reply_to: REPLY_TO,
        subject: `【署名完了】${fileName}`,
        html: _completionHtml({ senderName: honorificName, fileName, downloadUrl }),
        text: `${honorificName} 様\n\n「${fileName}」の署名が完了しました。\n\nダウンロード（7日間有効）:\n${downloadUrl}\n---\nDIFFsense`
    });
    if (result.error) {
        const detail = formatResendError(result.error);
        logger.error(`[mailer] sendCompletionEmail failed to=${to} from=${FROM} replyTo=${REPLY_TO} error=${detail}`);
        throw new Error(detail);
    }
    logger.info(`[mailer] sendCompletionEmail sent to=${to} emailId=${result.data?.id || 'unknown'}`);
}

async function sendReminderEmail({ to, recipientName, senderName, fileName, signingUrl }) {
    const resend = getResendClient();
    const wrappedSigningUrl = _wrapSigningUrl(signingUrl, fileName);
    const result = await resend.emails.send({
        from: FROM,
        to: [to],
        reply_to: REPLY_TO,
        subject: `【署名リマインド】${fileName}`,
        html: _reminderHtml({ recipientName, senderName, fileName, signingUrl: wrappedSigningUrl }),
        text: `${recipientName} 様\n\n署名依頼がまだ完了していません。\n\n対象書類: ${fileName}\n\n署名はこちら:\n${wrappedSigningUrl}\n---\nDIFFsense`
    });
    if (result.error) {
        const detail = formatResendError(result.error);
        logger.error(`[mailer] sendReminderEmail failed to=${to} from=${FROM} replyTo=${REPLY_TO} error=${detail}`);
        throw new Error(detail);
    }
    logger.info(`[mailer] sendReminderEmail sent to=${to} emailId=${result.data?.id || 'unknown'}`);
}

async function sendRecipientActionEmail({ to, senderName, fileName, recipientName, actionLabel, dashboardUrl }) {
    const resend = getResendClient();
    const result = await resend.emails.send({
        from: FROM,
        to: [to],
        reply_to: REPLY_TO,
        subject: `【署名状況更新】${fileName}`,
        html: _recipientActionHtml({ senderName, fileName, recipientName, actionLabel, dashboardUrl }),
        text: `${senderName} 様\n\n「${fileName}」の署名状況が更新されました。\n署名者: ${recipientName}\n状態: ${actionLabel}\n\n確認はこちら:\n${dashboardUrl}\n---\nDIFFsense`
    });
    if (result.error) {
        const detail = formatResendError(result.error);
        logger.error(`[mailer] sendRecipientActionEmail failed to=${to} from=${FROM} replyTo=${REPLY_TO} error=${detail}`);
        throw new Error(detail);
    }
    logger.info(`[mailer] sendRecipientActionEmail sent to=${to} emailId=${result.data?.id || 'unknown'}`);
}

function _signingHtml({ recipientName, senderName, fileName, signingUrl }) {
    return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#fdfcfb;font-family:'Noto Sans JP','Inter','Hiragino Sans','Yu Gothic','Meiryo',sans-serif;color:#2b2623;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#fdfcfb;padding:40px 20px;">
<tr><td align="center">
<table width="520" cellpadding="0" cellspacing="0"
       style="background:#ffffff;border-radius:16px;border:1px solid #e7e0d6;overflow:hidden;box-shadow:0 12px 32px rgba(26,21,18,0.08);">
  <tr><td style="padding:32px;">
    <p style="margin:0 0 24px;font-size:17px;line-height:1;font-family:Helvetica,Arial,sans-serif;font-weight:600;letter-spacing:0.5px;color:#c5a059;">DIFFsense</p>
    <p style="margin:0 0 8px;font-size:15px;font-weight:700;color:#2b2623;">${_e(recipientName)} 様</p>
    <p style="margin:0 0 24px;font-size:14px;color:#5e544d;line-height:1.8;">
      ${_e(senderName)}より、この契約へのご署名依頼をお送りしています。
    </p>
    <div style="background:#f4f0ec;border:1px solid #eadfcd;border-radius:12px;
                padding:16px 20px;margin-bottom:28px;">
      <p style="margin:0 0 5px;font-size:11px;color:#8a7a6a;text-transform:uppercase;letter-spacing:.06em;">対象書類</p>
      <p style="margin:0;font-size:15px;font-weight:700;color:#2b2623;">${_e(fileName)}</p>
    </div>
    <div style="text-align:center;margin-bottom:28px;">
      <a href="${signingUrl}"
         style="display:inline-block;background:#c5a059;color:#ffffff;text-decoration:none;
                border-radius:12px;padding:14px 42px;font-size:15px;font-weight:700;box-shadow:0 8px 18px rgba(197,160,89,0.28);">
        書類を確認して署名する
      </a>
    </div>
    <p style="margin:0 0 6px;font-size:13px;color:#5e544d;line-height:1.8;">
      書類内容をご確認のうえ、ご署名をお願いいたします。<br>
      ご不明な点がある場合は、依頼元（${_e(senderName)}）へご確認ください。
    </p>
    <div style="margin-top:20px;padding:12px 16px;background:#f8f5f0;border-radius:10px;border:1px solid #eee3d2;">
      <p style="margin:0 0 4px;font-size:11px;color:#8a7a6a;">ボタンが開かない場合は以下のURLをブラウザに貼り付けてください</p>
      <a href="${signingUrl}" style="font-size:11px;color:#c5a059;word-break:break-all;">${signingUrl}</a>
    </div>
  </td></tr>
  <tr><td style="background:#f8f5f0;border-top:1px solid #eee3d2;padding:18px 32px;text-align:center;">
    <p style="margin:0;font-size:11px;color:#8a7a6a;line-height:1.6;white-space:nowrap;">
      このメールはDIFFsenseから送信されています。心当たりがない場合は破棄してください。
    </p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

function _completionHtml({ senderName, fileName, downloadUrl }) {
    return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#fdfcfb;font-family:'Noto Sans JP','Inter','Hiragino Sans','Yu Gothic','Meiryo',sans-serif;color:#2b2623;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#fdfcfb;padding:40px 20px;">
<tr><td align="center">
<table width="520" cellpadding="0" cellspacing="0"
       style="background:#fff;border-radius:16px;border:1px solid #e7e0d6;overflow:hidden;box-shadow:0 12px 32px rgba(26,21,18,0.08);">
  <tr><td style="padding:32px;text-align:center;">
    <p style="margin:0 0 24px;font-size:17px;line-height:1;font-family:Helvetica,Arial,sans-serif;font-weight:600;letter-spacing:0.5px;color:#c5a059;">DIFFsense</p>
    <div style="display:inline-block;font-size:28px;line-height:1;margin-bottom:16px;">✅</div>
    <p style="margin:0 0 6px;font-size:16px;font-weight:700;color:#2b2623;">署名が完了しました</p>
    <p style="margin:0 0 24px;font-size:14px;color:#5e544d;line-height:1.8;">
      ${_e(senderName)} 様<br>「${_e(fileName)}」のすべての署名が完了しました。
    </p>
    <a href="${downloadUrl}"
       style="display:inline-block;background:#c5a059;color:#fff;text-decoration:none;
              border-radius:12px;padding:12px 32px;font-size:14px;font-weight:700;box-shadow:0 8px 18px rgba(197,160,89,0.28);">
      署名済み書類をダウンロード
    </a>
    <p style="margin:16px 0 0;font-size:11px;color:#8a7a6a;">ダウンロードリンクは7日間有効です</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

function _reminderHtml({ recipientName, senderName, fileName, signingUrl }) {
    return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#fdfcfb;font-family:'Noto Sans JP','Inter','Hiragino Sans','Yu Gothic','Meiryo',sans-serif;color:#2b2623;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#fdfcfb;padding:40px 20px;">
<tr><td align="center">
<table width="520" cellpadding="0" cellspacing="0"
       style="background:#fff;border-radius:16px;border:1px solid #e7e0d6;overflow:hidden;box-shadow:0 12px 32px rgba(26,21,18,0.08);">
  <tr><td style="padding:32px;">
    <p style="margin:0 0 24px;font-size:17px;line-height:1;font-family:Helvetica,Arial,sans-serif;font-weight:600;letter-spacing:0.5px;color:#c5a059;">DIFFsense</p>
    <p style="margin:0 0 6px;font-size:15px;font-weight:700;color:#2b2623;">${_e(recipientName)} 様</p>
    <p style="margin:0 0 20px;font-size:14px;color:#5e544d;line-height:1.8;">
      以前お送りした署名依頼がまだ完了していません。<br>お手すきの際に、ご署名をお願いいたします。
    </p>
    <div style="background:#f4f0ec;border:1px solid #eadfcd;border-radius:12px;
                padding:14px 18px;margin-bottom:24px;">
      <p style="margin:0 0 4px;font-size:11px;color:#8a7a6a;text-transform:uppercase;letter-spacing:.06em;">対象書類</p>
      <p style="margin:0;font-size:14px;font-weight:700;color:#2b2623;">${_e(fileName)}</p>
    </div>
    <div style="text-align:center;margin-bottom:20px;">
      <a href="${signingUrl}"
         style="display:inline-block;background:#c5a059;color:#fff;text-decoration:none;
                border-radius:12px;padding:13px 38px;font-size:14px;font-weight:700;box-shadow:0 8px 18px rgba(197,160,89,0.28);">
        署名する
      </a>
    </div>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

function _recipientActionHtml({ senderName, fileName, recipientName, actionLabel, dashboardUrl }) {
    return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#fdfcfb;font-family:'Noto Sans JP','Inter','Hiragino Sans','Yu Gothic','Meiryo',sans-serif;color:#2b2623;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#fdfcfb;padding:40px 20px;">
<tr><td align="center">
<table width="520" cellpadding="0" cellspacing="0"
       style="background:#fff;border-radius:16px;border:1px solid #e7e0d6;overflow:hidden;box-shadow:0 12px 32px rgba(26,21,18,0.08);">
  <tr><td style="padding:32px;">
    <p style="margin:0 0 24px;font-size:17px;line-height:1;font-family:Helvetica,Arial,sans-serif;font-weight:600;letter-spacing:0.5px;color:#c5a059;">DIFFsense</p>
    <p style="margin:0 0 8px;font-size:16px;font-weight:700;color:#2b2623;">署名依頼の状況が更新されました</p>
    <p style="margin:0 0 24px;font-size:14px;color:#5e544d;line-height:1.8;">
      ${_e(senderName)} 様<br>署名者の対応内容をお知らせします。
    </p>
    <div style="background:#f4f0ec;border:1px solid #eadfcd;border-radius:12px;padding:16px 20px;margin-bottom:24px;">
      <p style="margin:0 0 5px;font-size:11px;color:#8a7a6a;text-transform:uppercase;letter-spacing:.06em;">対象書類</p>
      <p style="margin:0;font-size:15px;font-weight:700;color:#2b2623;">${_e(fileName)}</p>
    </div>
    <div style="background:#fbfaf8;border:1px solid #eee3d2;border-radius:12px;padding:16px 20px;margin-bottom:28px;">
      <p style="margin:0 0 6px;font-size:12px;color:#8a7a6a;">署名者</p>
      <p style="margin:0 0 12px;font-size:14px;font-weight:700;color:#2b2623;">${_e(recipientName)}</p>
      <p style="margin:0 0 6px;font-size:12px;color:#8a7a6a;">対応状況</p>
      <p style="margin:0;font-size:14px;font-weight:700;color:#2b2623;">${_e(actionLabel)}</p>
    </div>
    <div style="text-align:center;">
      <a href="${dashboardUrl}"
         style="display:inline-block;background:#c5a059;color:#fff;text-decoration:none;border-radius:12px;padding:13px 34px;font-size:14px;font-weight:700;box-shadow:0 8px 18px rgba(197,160,89,0.28);">
        ダッシュボードで確認する
      </a>
    </div>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

function _e(s) {
    return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

module.exports = {
    sendSigningRequestEmail,
    sendCompletionEmail,
    sendReminderEmail,
    sendRecipientActionEmail
};
