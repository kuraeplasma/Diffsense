const sgMail = require('@sendgrid/mail');
const logger = require('../utils/logger');

// Set API Key
if (process.env.SENDGRID_API_KEY) {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
} else {
    logger.warn('SENDGRID_API_KEY is not set. Email sending will fail.');
}

const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@diffsense.com';
const FROM_NAME = process.env.FROM_NAME || 'DIFFsense';
const FRONTEND_BASE_URL = String(process.env.FRONTEND_URL || 'https://diffsense.spacegleam.co.jp').replace(/\/$/, '');
const DASHBOARD_URL = process.env.DASHBOARD_URL || `${FRONTEND_BASE_URL}/dashboard.html`;
const LOGIN_URL = `${FRONTEND_BASE_URL}/login.html`;

logger.info(`Email Service Configured: From: "${FROM_NAME}" <${FROM_EMAIL}>, Link: ${DASHBOARD_URL}`);

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Send an invitation email to a new member with login credentials
 * @param {string} to - Recipient email
 * @param {string} name - Recipient name
 * @param {string} role - Assigned role
 * @param {string} inviterName - Name of the person inviting
 * @param {string} tempPassword - Temporary password for login
 */
exports.sendInviteEmail = async (to, name, role, inviterName, tempPassword) => {
    const msg = {
        to: to,
        from: {
            email: FROM_EMAIL,
            name: FROM_NAME
        },
        subject: '【DIFFsense】チームへの招待・ログイン情報のお知らせ',
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
            `ログインURL: ${LOGIN_URL}`,
            '',
            '※セキュリティのため、初回ログイン後にパスワードの変更を推奨します。',
        ].join('\n'),
        html: `
            <div style="font-family: 'Helvetica Neue', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #ffffff;">
                <div style="background: #24292e; padding: 24px 30px; border-radius: 8px 8px 0 0;">
                    <h2 style="color: #c5a059; margin: 0; font-size: 20px;">DIFFsense チーム招待</h2>
                </div>
                <div style="padding: 30px;">
                    <p style="font-size: 15px; color: #333;"><strong>${name}</strong> 様</p>
                    <p style="font-size: 14px; color: #555; line-height: 1.6;">
                        ${inviterName} 様から DIFFsense チームへ招待されました。<br>
                        以下のログイン情報でアクセスしてください。
                    </p>

                    <div style="background: #f8f9fa; border: 1px solid #e9ecef; border-radius: 8px; padding: 20px; margin: 24px 0;">
                        <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
                            <tr>
                                <td style="padding: 8px 0; color: #666; width: 120px;">メールアドレス</td>
                                <td style="padding: 8px 0; color: #333; font-weight: 600;">${to}</td>
                            </tr>
                            <tr>
                                <td style="padding: 8px 0; color: #666;">仮パスワード</td>
                                <td style="padding: 8px 0; color: #333; font-weight: 600; font-family: monospace; font-size: 15px; letter-spacing: 1px;">${tempPassword}</td>
                            </tr>
                            <tr>
                                <td style="padding: 8px 0; color: #666;">権限</td>
                                <td style="padding: 8px 0; color: #333; font-weight: 600;">${role}</td>
                            </tr>
                        </table>
                    </div>

                    <div style="text-align: center; margin: 30px 0;">
                        <a href="${LOGIN_URL}" style="background-color: #c5a059; color: #ffffff; padding: 14px 40px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 15px; display: inline-block;">ログインする</a>
                    </div>

                    <p style="font-size: 12px; color: #999; margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; line-height: 1.6;">
                        ※ セキュリティのため、初回ログイン後にパスワードの変更を推奨します。<br>
                        ※ このメールに心当たりのない場合は、無視してください。
                    </p>
                </div>
            </div>
        `,
    };

    try {
        await sgMail.send(msg);
        logger.info(`Invitation email sent to ${to}`);
        return true;
    } catch (error) {
        logger.error(`Error sending email: ${error.message}`);
        if (error.response) {
            logger.error(JSON.stringify(error.response.body));
        }
        throw error;
    }
};
/**
 * Send a trial reminder email to a user whose trial is ending in 3 days
 * @param {string} to - Recipient email
 * @param {string} name - Recipient name
 * @param {number} daysLeft - Days remaining in trial
 */
exports.sendTrialReminderEmail = async (to, name, daysLeft) => {
    const msg = {
        to: to,
        from: {
            email: FROM_EMAIL,
            name: FROM_NAME
        },
        subject: `【重要】DIFFsense 無料トライアル終了まで残り${daysLeft}日のお知らせ`,
        text: [
            `${name} 様`,
            '',
            'DIFFsense をご利用いただきありがとうございます。',
            '',
            `現在ご利用中の無料トライアルの終了期限まで、残り ${daysLeft}日 となりました。`,
            '',
            'トライアル終了後も解析データや高度なAI判定機能を引き続きご利用いただくには、',
            'プランの継続（決済情報の登録）が必要となります。',
            '',
            '以下のURLよりプラン管理画面へアクセスし、お手続きをお願いいたします。',
            '',
            `プラン管理URL: ${DASHBOARD_URL}#plan`,
            '',
            'ご不明な点がございましたら、本メールへの返信にてお問い合わせください。',
            '',
            '今後とも DIFFsense をよろしくお願いいたします。',
        ].join('\n'),
        html: `
            <div style="font-family: 'Helvetica Neue', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #ffffff; border: 1px solid #eee; border-radius: 8px;">
                <div style="background: #24292e; padding: 24px 30px; border-radius: 8px 8px 0 0; text-align: center;">
                    <h2 style="color: #c5a059; margin: 0; font-size: 20px;">無料トライアル終了のお知らせ</h2>
                </div>
                <div style="padding: 30px;">
                    <p style="font-size: 16px; color: #333;"><strong>${name}</strong> 様</p>
                    <p style="font-size: 15px; color: #555; line-height: 1.6;">
                        DIFFsense をご利用いただきありがとうございます。<br>
                        現在ご利用中の無料トライアルの終了期限まで、残り <strong style="color: #d73a49; font-size: 18px;">${daysLeft}日</strong> となりました。
                    </p>

                    <p style="font-size: 14px; color: #555; line-height: 1.6; background: #fffcf0; border-left: 4px solid #ccb37a; padding: 15px; margin: 24px 0;">
                        トライアル終了後も解析データや高度なAI判定機能を引き続きご利用いただくには、プランの継続（決済情報の登録）が必要となります。
                    </p>

                    <div style="text-align: center; margin: 36px 0;">
                        <a href="${DASHBOARD_URL}#plan" style="background-color: #c5a059; color: #ffffff; padding: 14px 40px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 16px; display: inline-block; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">プランを継続・管理する</a>
                    </div>

                    <p style="font-size: 13px; color: #666; margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; line-height: 1.6;">
                        ※ トライアル期間終了までに決済登録がない場合、一部の機能が制限されます。<br>
                        ※ すでに登録済みの場合は、このメールを破棄してください。
                    </p>
                </div>
            </div>
        `,
    };

    try {
        await sgMail.send(msg);
        logger.info(`Trial reminder email sent to ${to}`);
        return true;
    } catch (error) {
        logger.error(`Error sending trial reminder email: ${error.message}`);
        throw error;
    }
};

/**
 * Send a signature request email
 * @param {object} params
 * @param {string} params.to
 * @param {string} params.recipientName
 * @param {string} params.documentName
 * @param {string} params.senderName
 * @param {string} params.signUrl
 */
exports.sendSignatureRequestEmail = async ({ to, recipientName, documentName, senderName, signUrl }) => {
    const honorificName = String(recipientName || '').trim() || String(to || '').split('@')[0] || 'ご担当者';
    const safeRecipientName = `${honorificName}様`;
    const safeDocumentName = String(documentName || '署名書類').trim();
    const safeSenderName = String(senderName || FROM_NAME).trim();
    const resolvedSignUrl = signUrl || DASHBOARD_URL;

    const msg = {
        to,
        from: {
            email: FROM_EMAIL,
            name: FROM_NAME
        },
        subject: `【DIFFsense】${safeDocumentName} への署名のお願い`,
        text: [
            safeRecipientName,
            '',
            `${safeSenderName}より、電子署名の依頼が届いています。`,
            '',
            `対象書類: ${safeDocumentName}`,
            '',
            '以下のリンクから内容をご確認のうえ、署名をお願いいたします。',
            resolvedSignUrl,
            '',
            'ご不明な点がある場合は、この依頼元へご確認ください。',
            '',
            'よろしくお願いいたします。'
        ].join('\n'),
        html: `
            <div style="font-family: 'Helvetica Neue', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #ffffff; border: 1px solid #eee; border-radius: 8px; overflow: hidden;">
                <div style="background: #24292e; padding: 24px 30px;">
                    <h2 style="color: #c5a059; margin: 0; font-size: 20px;">電子署名のご依頼</h2>
                </div>
                <div style="padding: 30px;">
                    <p style="font-size: 16px; color: #333; margin-top: 0;"><strong>${escapeHtml(safeRecipientName)}</strong></p>
                    <p style="font-size: 14px; color: #555; line-height: 1.8;">
                        ${escapeHtml(safeSenderName)}より、電子署名の依頼が届いています。<br>
                        下記の書類をご確認のうえ、ご対応をお願いいたします。
                    </p>

                    <div style="background: #f8f9fa; border: 1px solid #e9ecef; border-radius: 8px; padding: 18px 20px; margin: 24px 0;">
                        <div style="font-size: 12px; color: #666; margin-bottom: 6px;">対象書類</div>
                        <div style="font-size: 15px; color: #222; font-weight: 700;">${escapeHtml(safeDocumentName)}</div>
                    </div>

                    <div style="text-align: center; margin: 30px 0;">
                        <a href="${escapeHtml(resolvedSignUrl)}" style="background-color: #c5a059; color: #ffffff; padding: 14px 40px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 15px; display: inline-block;">書類を確認して署名する</a>
                    </div>

                    <p style="font-size: 12px; color: #777; line-height: 1.7; margin-top: 28px;">
                        ボタンが開けない場合は、以下のURLをブラウザに貼り付けてください。<br>
                        <a href="${escapeHtml(resolvedSignUrl)}" style="color: #8a6d2f; word-break: break-all;">${escapeHtml(resolvedSignUrl)}</a>
                    </p>
                </div>
            </div>
        `,
    };

    try {
        await sgMail.send(msg);
        logger.info(`Signature request email sent to ${to}`);
        return true;
    } catch (error) {
        logger.error(`Error sending signature request email: ${error.message}`);
        if (error.response) {
            logger.error(JSON.stringify(error.response.body));
        }
        throw error;
    }
};

exports.sendSignatureReminderEmail = async ({ to, recipientName, documentName, senderName, signUrl }) => {
    const honorificName = String(recipientName || '').trim() || String(to || '').split('@')[0] || 'ご担当者';
    const safeRecipientName = `${honorificName}様`;
    const safeDocumentName = String(documentName || '署名書類').trim();
    const safeSenderName = String(senderName || FROM_NAME).trim();
    const resolvedSignUrl = signUrl || DASHBOARD_URL;

    const msg = {
        to,
        from: {
            email: FROM_EMAIL,
            name: FROM_NAME
        },
        subject: `【再送】${safeDocumentName} への署名のお願い`,
        text: [
            safeRecipientName,
            '',
            `${safeSenderName}よりお送りした電子署名の依頼について、再度ご案内いたします。`,
            '',
            `対象書類: ${safeDocumentName}`,
            '',
            '以下のリンクから内容をご確認のうえ、署名をお願いいたします。',
            resolvedSignUrl
        ].join('\n'),
        html: `
            <div style="font-family: 'Helvetica Neue', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #ffffff; border: 1px solid #eee; border-radius: 8px; overflow: hidden;">
                <div style="background: #24292e; padding: 24px 30px;">
                    <h2 style="color: #c5a059; margin: 0; font-size: 20px;">電子署名のご依頼（再送）</h2>
                </div>
                <div style="padding: 30px;">
                    <p style="font-size: 16px; color: #333; margin-top: 0;"><strong>${escapeHtml(safeRecipientName)}</strong></p>
                    <p style="font-size: 14px; color: #555; line-height: 1.8;">
                        ${escapeHtml(safeSenderName)}よりお送りした電子署名の依頼について、再度ご案内いたします。<br>
                        お手すきの際に、下記リンクよりご対応をお願いいたします。
                    </p>
                    <div style="text-align: center; margin: 30px 0;">
                        <a href="${escapeHtml(resolvedSignUrl)}" style="background-color: #c5a059; color: #ffffff; padding: 14px 40px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 15px; display: inline-block;">書類を確認して署名する</a>
                    </div>
                </div>
            </div>
        `
    };

    try {
        await sgMail.send(msg);
        logger.info(`Signature reminder email sent to ${to}`);
        return true;
    } catch (error) {
        logger.error(`Error sending signature reminder email: ${error.message}`);
        if (error.response) {
            logger.error(JSON.stringify(error.response.body));
        }
        throw error;
    }
};
