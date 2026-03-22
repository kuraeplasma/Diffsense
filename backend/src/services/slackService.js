'use strict';

const axios = require('axios');
const logger = require('../utils/logger');

/**
 * Slack Incoming Webhook 通知サービス
 */

async function sendSlackNotification(webhookUrl, contractName, sourceUrl, detectedAt, changeSummary = '') {
    if (!webhookUrl) return;
    const targetLabel = contractName || sourceUrl;
    const frontendUrl = (process.env.FRONTEND_URL || 'https://diffsense.spacegleam.co.jp').replace(/\/$/, '');
    const detailUrl = `${frontendUrl}/dashboard.html`;

    const textLines = [
        `⚠️ *変更を検知しました*`,
        `対象：${targetLabel}`,
        `時間：${detectedAt}`,
    ];
    if (changeSummary) {
        textLines.push(`変更概要：${changeSummary}`);
    }
    textLines.push(`<${detailUrl}|▶ 詳細を見る>`);

    const payload = {
        blocks: [
            {
                type: 'section',
                text: { type: 'mrkdwn', text: textLines.join('\n') }
            }
        ]
    };

    try {
        await axios.post(webhookUrl, payload, { timeout: 5000 });
        logger.info(`Slack notification sent for contract: ${contractName}`);
    } catch (error) {
        logger.error(`Failed to send Slack notification: ${error.message}`);
    }
}

module.exports = { sendSlackNotification };
