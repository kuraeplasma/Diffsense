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
