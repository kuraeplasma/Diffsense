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

logger.info(`Email Service Configured: From: "${FROM_NAME}" <${FROM_EMAIL}>, Link: ${DASHBOARD_URL}`);

/**
 * Send an invitation email to a new member
 * @param {string} to - Recipient email
 * @param {string} name - Recipient name
 * @param {string} role - Assigned role
 * @param {string} inviterName - Name of the person inviting
 */
exports.sendInviteEmail = async (to, name, role, inviterName) => {
    const msg = {
        to: to,
        from: {
            email: FROM_EMAIL,
            name: FROM_NAME
        },
        subject: '【DIFFsense】チームへの招待のお知らせ',
        text: `${name} 様\n\n${inviterName} 様から DIFFsense チームへ招待されました。\n\n以下の権限が付与されています:\n権限: ${role}\n\nDIFFsenseにログインして、チームに参加してください。\n${DASHBOARD_URL}`,
        html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
                <h2 style="color: #c5a059;">DIFFsense チーム招待</h2>
                <p><strong>${name} 様</strong></p>
                <p>${inviterName} 様から DIFFsense チームへ招待されました。</p>
                <div style="background-color: #f9f9f9; padding: 15px; border-radius: 4px; margin: 20px 0;">
                    <p style="margin: 0;"><strong>付与された権限:</strong> ${role}</p>
                </div>
                <p>以下のボタンからログインして、チームに参加してください。</p>
                <div style="text-align: center; margin-top: 30px;">
                    <a href="${DASHBOARD_URL}" style="background-color: #24292e; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: bold;">DIFFsenseを開く</a>
                </div>
            </div>
        `,
    };

    try {
        await sgMail.send(msg);
        logger.info(`Invitation email sent to ${to}`);
        return true;
    } catch (error) {
        logger.error('Error sending email:', error);
        if (error.response) {
            logger.error(error.response.body);
        }
        throw error;
    }
};
