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
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://diffsense.netlify.app/dashboard';
const LOGIN_URL = DASHBOARD_URL.replace('/dashboard', '/login.html');

logger.info(`Email Service Configured: From: "${FROM_NAME}" <${FROM_EMAIL}>, Link: ${DASHBOARD_URL}`);

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
