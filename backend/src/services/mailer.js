'use strict';

const { Resend } = require('resend');
const logger = require('../utils/logger');
const mailQuota = require('./mailQuota');

const FROM = process.env.MAIL_FROM || 'noreply@send.spacegleam.co.jp';
const REPLY_TO = process.env.MAIL_REPLY_TO || 'contact@spacegleam.co.jp';
const CONTACT_TO = process.env.CONTACT_NOTIFY_EMAIL || process.env.MAIL_QUOTA_ALERT_TO || REPLY_TO;

let resendClient = null;
let rawResendSend = null;

function getResendClient() {
    if (resendClient) {
        return resendClient;
    }
    const apiKey = String(process.env.RESEND_API_KEY || '').trim();
    if (!apiKey) {
        throw new Error('RESEND_API_KEY is not configured');
    }
    resendClient = new Resend(apiKey);
    rawResendSend = resendClient.emails.send.bind(resendClient.emails);
    resendClient.emails.send = async (payload) => {
        const result = await rawResendSend(payload);
        if (!result.error) {
            try {
                const status = await mailQuota.recordMailSent('general');
                if (status.warningLevel) await sendQuotaWarningEmail(status);
            } catch (error) {
                logger.warn(`[mailer] quota tracking failed: ${error.message}`);
            }
        }
        return result;
    };
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


function _notificationEmailTo() {
    return process.env.MAIL_QUOTA_ALERT_TO || process.env.CONTACT_NOTIFY_EMAIL || REPLY_TO || 'contact@spacegleam.co.jp';
}

async function sendQuotaWarningEmail(status) {
    if (!rawResendSend) return;
    try {
        const to = _notificationEmailTo();
        const subject = `【DIFFsense】メール送信数が月間上限の${status.warningLevel}%に達しました`;
        const text = [
            'DIFFsenseのメール送信数が上限に近づいています。',
            '',
            `対象月: ${status.yearMonth}`,
            `送信数: ${status.total} / ${status.limit}`,
            `到達率: ${status.percent}%`,
            '',
            '95%に到達すると、お問い合わせフォームの送信だけを一時停止します。',
            '会員招待・署名通知など重要メールは停止しません。'
        ].join('\n');
        const result = await rawResendSend({ from: FROM, to: [to], reply_to: REPLY_TO, subject, text });
        if (result.error) {
            logger.error(`[mailer] sendQuotaWarningEmail failed error=${formatResendError(result.error)}`);
            return;
        }
        await mailQuota.recordMailSent('quota_warning', { suppressWarnings: true });
    } catch (error) {
        logger.error(`[mailer] sendQuotaWarningEmail failed: ${error.message}`);
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

async function sendInviteEmail({ to, name, role, inviterName, tempPassword }) {
    const resend = getResendClient();
    const frontendUrl = _frontendBaseUrl();
    const loginUrl = `${frontendUrl}/login.html`;
    const result = await resend.emails.send({
        from: FROM,
        to: [to],
        reply_to: REPLY_TO,
        subject: '【DIFFsense】チームへの招待・ログイン情報のお知らせ',
        html: _inviteHtml({ to, name, role, inviterName, tempPassword, loginUrl }),
        text: [
            `${name} 様`,
            '',
            `${inviterName} 様から DIFFsense チームへ招待されました。`,
            '',
            '以下のログイン情報でアクセスしてください:',
            '',
            `メールアドレス: ${to}`,
            `仮パスワード: ${tempPassword}`,
            `権限: ${role}`,
            '',
            `ログインURL: ${loginUrl}`,
            '',
            '※セキュリティのため、初回ログイン後にパスワードの変更を推奨します。'
        ].join('\n')
    });
    if (result.error) {
        const detail = formatResendError(result.error);
        logger.error(`[mailer] sendInviteEmail failed to=${to} from=${FROM} replyTo=${REPLY_TO} error=${detail}`);
        throw new Error(detail);
    }
    logger.info(`[mailer] sendInviteEmail sent to=${to} emailId=${result.data?.id || 'unknown'}`);
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

function _inviteHtml({ to, name, role, inviterName, tempPassword, loginUrl }) {
    return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#fdfcfb;font-family:'Noto Sans JP','Inter','Hiragino Sans','Yu Gothic','Meiryo',sans-serif;color:#2b2623;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#fdfcfb;padding:40px 20px;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0"
       style="background:#ffffff;border-radius:16px;border:1px solid #e7e0d6;overflow:hidden;box-shadow:0 12px 32px rgba(26,21,18,0.08);">
  <tr><td style="padding:32px;">
    <p style="margin:0 0 24px;font-size:17px;line-height:1;font-family:Helvetica,Arial,sans-serif;font-weight:600;letter-spacing:0.5px;color:#c5a059;">DIFFsense</p>
    <p style="margin:0 0 8px;font-size:15px;font-weight:700;color:#2b2623;">${_e(name)} 様</p>
    <p style="margin:0 0 24px;font-size:14px;color:#5e544d;line-height:1.8;">
      ${_e(inviterName)} 様から DIFFsense チームへ招待されました。<br>
      以下のログイン情報でアクセスしてください。
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fbfaf8;border:1px solid #eee3d2;border-radius:12px;padding:16px 20px;margin-bottom:28px;">
      <tr>
        <td style="padding:8px 0;color:#8a7a6a;font-size:12px;width:120px;">メールアドレス</td>
        <td style="padding:8px 0;color:#2b2623;font-size:14px;font-weight:700;">${_e(to)}</td>
      </tr>
      <tr>
        <td style="padding:8px 0;color:#8a7a6a;font-size:12px;">仮パスワード</td>
        <td style="padding:8px 0;color:#2b2623;font-size:15px;font-weight:700;font-family:Consolas,Menlo,monospace;letter-spacing:1px;">${_e(tempPassword)}</td>
      </tr>
      <tr>
        <td style="padding:8px 0;color:#8a7a6a;font-size:12px;">権限</td>
        <td style="padding:8px 0;color:#2b2623;font-size:14px;font-weight:700;">${_e(role)}</td>
      </tr>
    </table>
    <div style="text-align:center;margin:30px 0;">
      <a href="${loginUrl}"
         style="display:inline-block;background:#c5a059;color:#fff;text-decoration:none;border-radius:12px;padding:13px 34px;font-size:14px;font-weight:700;box-shadow:0 8px 18px rgba(197,160,89,0.28);">
        ログインする
      </a>
    </div>
    <p style="margin:26px 0 0;padding-top:18px;border-top:1px solid #eee3d2;color:#8a7a6a;font-size:12px;line-height:1.7;">
      ※ セキュリティのため、初回ログイン後にパスワードの変更を推奨します。<br>
      ※ このメールに心当たりのない場合は、無視してください。
    </p>
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

async function sendPaymentSuccessEmail({ to, plan, billingCycle }) {
    const resend = getResendClient();
    const planName = {
        'starter': 'Starter',
        'business': 'Business',
        'pro': 'Pro'
    }[plan] || plan;
    const cycleName = billingCycle === 'annual' ? '年額' : '月額';

    const result = await resend.emails.send({
        from: FROM,
        to: [to],
        reply_to: REPLY_TO,
        subject: `【重要】DIFFsense サブスクリプションお申し込み完了のお知らせ`,
        html: _paymentSuccessHtml({ planName, cycleName }),
        text: `お申し込みありがとうございます。\n\nDIFFsense の ${planName} プラン（${cycleName}）へのお申し込みが完了しました。\n\nダッシュボードより解析機能をご利用いただけます。\n---\nDIFFsense`
    });

    if (result.error) {
        const detail = formatResendError(result.error);
        logger.error(`[mailer] sendPaymentSuccessEmail failed to=${to} error=${detail}`);
        throw new Error(detail);
    }
    logger.info(`[mailer] sendPaymentSuccessEmail sent to=${to} emailId=${result.data?.id || 'unknown'}`);
}

async function sendAnalysisFailureAlertEmail({ userEmail, userId, contractId, method, errorMessage, endpoint, contractName }) {
    const to = _notificationEmailTo();
    const safeMethod = String(method || 'unknown').toUpperCase();
    const subject = `【DIFFsense】資料解析に失敗しました (${safeMethod})`;
    const text = [
        'DIFFsenseで資料解析エラーが発生しました。',
        '',
        `発生日時: ${new Date().toISOString()}`,
        `エンドポイント: ${endpoint || '-'}`,
        `契約ID: ${contractId || '-'}`,
        `契約名: ${contractName || '-'}`,
        `形式: ${safeMethod}`,
        `ユーザーID: ${userId || '-'}`,
        `ユーザーEmail: ${userEmail || '-'}`,
        '',
        'エラー:',
        String(errorMessage || 'Unknown error').slice(0, 4000)
    ].join('\n');

    const result = await getResendClient().emails.send({
        from: FROM,
        to: [to],
        reply_to: REPLY_TO,
        subject,
        text
    });
    if (result.error) {
        const detail = formatResendError(result.error);
        logger.error(`[mailer] sendAnalysisFailureAlertEmail failed to=${to} error=${detail}`);
        throw new Error(detail);
    }
    logger.info(`[mailer] sendAnalysisFailureAlertEmail sent to=${to} emailId=${result.data?.id || 'unknown'}`);
}

function _paymentSuccessHtml({ planName, cycleName }) {
    return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#fdfcfb;font-family:'Noto Sans JP','Inter','Hiragino Sans','Yu Gothic','Meiryo',sans-serif;color:#2b2623;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#fdfcfb;padding:40px 20px;">
<tr><td align="center">
<table width="520" cellpadding="0" cellspacing="0"
       style="background:#fff;border-radius:16px;border:1px solid #e7e0d6;overflow:hidden;box-shadow:0 12px 32px rgba(26,21,18,0.08);">
  <tr><td style="padding:32px;text-align:center;">
    <p style="margin:0 0 24px;font-size:17px;line-height:1;font-family:Helvetica,Arial,sans-serif;font-weight:600;letter-spacing:0.5px;color:#c5a059;">DIFFsense</p>
    <div style="display:inline-block;font-size:28px;line-height:1;margin-bottom:16px;">✨</div>
    <p style="margin:0 0 6px;font-size:16px;font-weight:700;color:#2b2623;">サブスクリプションのお申し込み完了</p>
    <p style="margin:0 0 24px;font-size:14px;color:#5e544d;line-height:1.8;">
      お申し込みいただき、誠にありがとうございます。<br>
      ご契約内容は以下の通りです。
    </p>
    <div style="background:#fbfaf8;border:1px solid #eee3d2;border-radius:12px;padding:16px 20px;margin-bottom:28px;text-align:left;">
      <p style="margin:0 0 4px;font-size:12px;color:#8a7a6a;">プラン</p>
      <p style="margin:0 0 12px;font-size:16px;font-weight:700;color:#2b2623;">${_e(planName)} プラン</p>
      <p style="margin:0 0 4px;font-size:12px;color:#8a7a6a;">お支払いサイクル</p>
      <p style="margin:0;font-size:16px;font-weight:700;color:#2b2623;">${_e(cycleName)}</p>
    </div>
    <a href="${_frontendBaseUrl()}/dashboard.html"
       style="display:inline-block;background:#c5a059;color:#fff;text-decoration:none;
              border-radius:12px;padding:14px 40px;font-size:14px;font-weight:700;box-shadow:0 8px 18px rgba(197,160,89,0.28);">
      ダッシュボードへ移動
    </a>
  </td></tr>
  <tr><td style="background:#f8f5f0;border-top:1px solid #eee3d2;padding:18px 32px;text-align:center;">
    <p style="margin:0;font-size:11px;color:#8a7a6a;line-height:1.6;">
      今後とも DIFFsense をよろしくお願いいたします。
    </p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

async function sendCrawlChangeAlertEmail(toEmail, userName, contractName, sourceUrl, detectedAt, changeSummary = '') {
    const resend = getResendClient();
    const displayName = _normalizeHonorificName(userName, toEmail);
    const frontendUrl = _frontendBaseUrl();
    const targetLabel = contractName || sourceUrl;
    const summaryBlock = changeSummary
        ? `<tr><td style="padding-top:8px"><strong>■ 変更概要</strong><br><span style="color:#555;line-height:1.7">${_e(changeSummary)}</span></td></tr>`
        : '';

    const html = `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:sans-serif">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 20px">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
<tr><td style="background:#111827;padding:20px 40px;text-align:left">
<span style="color:#c5a059;font-size:18px;font-weight:700;letter-spacing:0.5px">DIFFsense</span></td></tr>
<tr><td style="padding:40px">
<h2 style="color:#1a1a2e;margin-top:0;font-size:20px;border-left:4px solid #c5a059;padding-left:12px">変更を検知しました</h2>
<p style="color:#444;margin-bottom:24px">DIFFsenseよりお知らせです。<br>監視中の対象に変更が検知されました。</p>
<table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e1e4e8;border-radius:6px;padding:20px;margin:0 0 24px">
<tr><td style="padding-bottom:10px"><strong style="color:#1a1a2e">■ 対象</strong><br><span style="color:#555">${_e(targetLabel)}</span></td></tr>
<tr><td style="padding:10px 0;border-top:1px solid #e1e4e8"><strong style="color:#1a1a2e">■ 検知日時</strong><br><span style="color:#555">${_e(detectedAt)}</span></td></tr>
${summaryBlock}
</table>
<p style="color:#444;margin-bottom:24px">この変更は契約条件やリスクに影響する可能性があります。</p>
<div style="text-align:center;margin:28px 0">
<a href="${frontendUrl}/dashboard.html" style="background:#c5a059;color:#fff;padding:14px 36px;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block;font-size:15px">▼ 詳細を確認する</a>
</div>
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f7fa;border-radius:6px;padding:16px;margin:0 0 28px">
<tr><td style="color:#555;font-size:13px;line-height:1.9">
<strong style="color:#1a1a2e">▼ そのまま対応する</strong><br>
・差分を確認<br>
・リスクをチェック<br>
・署名依頼を送信
</td></tr>
</table>
<hr style="border:none;border-top:1px solid #e1e4e8;margin:24px 0">
<p style="color:#888;font-size:12px;line-height:1.7">
DIFFsense ― 契約の変更点を見逃さない<br>
メール通知は設定画面からON/OFFできます。<br>
© DIFFsense - spacegleam.co.jp
</p>
</td></tr></table></td></tr></table>
</body></html>`;

    const result = await resend.emails.send({
        from: FROM,
        to: toEmail,
        replyTo: REPLY_TO,
        subject: `【DIFFsense】変更を検知しました｜${targetLabel}`,
        html
    });

    if (result.error) {
        throw new Error(`Resend error: ${formatResendError(result.error)}`);
    }
    logger.info(`Crawl change alert email sent to ${toEmail} for contract: ${contractName}`);
    return result;
}


async function sendContactInquiryEmail({ company, name, email, category, subject, message, source, meta = {} }) {
    const mailSubject = `【DIFFsense】お問い合わせ: ${subject}`;
    const text = [
        'DIFFsense LPからお問い合わせが届きました。',
        '',
        `会社名: ${company}`,
        `お名前: ${name}`,
        `メール: ${email}`,
        `種別: ${category}`,
        `件名: ${subject}`,
        '',
        'お問い合わせ内容:',
        message
    ].join('\n');
    const html = `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f7fb;font-family:'Noto Sans JP','Inter','Hiragino Sans','Yu Gothic','Meiryo',sans-serif;color:#06163b;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;background:#f5f7fb;"><tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #dbe6f5;border-radius:14px;overflow:hidden;">
<tr><td style="background:#071326;color:#fff;padding:20px 28px;font-weight:800;font-size:18px;">DIFFsense お問い合わせ</td></tr>
<tr><td style="padding:28px;">
<p><strong>会社名:</strong> ${_e(company)}</p>
<p><strong>お名前:</strong> ${_e(name)}</p>
<p><strong>メール:</strong> <a href="mailto:${_e(email)}">${_e(email)}</a></p>
<p><strong>種別:</strong> ${_e(category)}</p>
<p><strong>件名:</strong> ${_e(subject)}</p>
<div style="margin-top:22px;padding:18px;border-radius:12px;background:#f8fbff;border:1px solid #e1ebf8;white-space:pre-wrap;line-height:1.8;">${_e(message)}</div>
</td></tr></table></td></tr></table></body></html>`;

    const result = await getResendClient().emails.send({
        from: FROM,
        to: [CONTACT_TO],
        reply_to: email,
        subject: mailSubject,
        html,
        text
    });
    if (result.error) {
        const detail = formatResendError(result.error);
        logger.error(`[mailer] sendContactInquiryEmail failed from=${email} to=${CONTACT_TO} error=${detail}`);
        throw new Error(detail);
    }
    logger.info(`[mailer] sendContactInquiryEmail sent from=${email} to=${CONTACT_TO} emailId=${result.data?.id || 'unknown'}`);
}
module.exports = {
    sendInviteEmail,
    sendSigningRequestEmail,
    sendCompletionEmail,
    sendReminderEmail,
    sendRecipientActionEmail,
    sendPaymentSuccessEmail,
    sendAnalysisFailureAlertEmail,
    sendCrawlChangeAlertEmail,
    sendContactInquiryEmail
};

