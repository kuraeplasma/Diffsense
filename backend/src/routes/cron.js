'use strict';

const express = require('express');
const router = express.Router();
const cronService = require('../services/cronService');
const logger = require('../utils/logger');

const CRON_SECRET = process.env.CRON_SECRET || '';

/**
 * POST /api/cron/daily-crawl
 * Cloud Scheduler から呼び出される毎日クロールエンドポイント
 * X-Cron-Secret ヘッダーで認証
 */
router.post('/daily-crawl', async (req, res) => {
    const secret = req.headers['x-cron-secret'] || '';

    if (!CRON_SECRET || secret !== CRON_SECRET) {
        logger.warn('Cron endpoint called with invalid secret');
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    logger.info('Cron daily-crawl triggered by Cloud Scheduler');

    // 非同期で実行（レスポンスはすぐ返す）
    res.json({ success: true, message: 'Daily crawl started' });

    try {
        await cronService.executeDailyCrawl();
        logger.info('Cloud Scheduler triggered crawl completed');
    } catch (err) {
        logger.error('Cloud Scheduler triggered crawl error:', err.message);
    }
});

/**
 * POST /api/cron/test-notification
 * テスト通知送信（メール + Slack）
 * X-Cron-Secret ヘッダーで認証
 */
router.post('/test-notification', async (req, res) => {
    const secret = req.headers['x-cron-secret'] || '';

    if (!CRON_SECRET || secret !== CRON_SECRET) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    let { email, webhookUrl, uid } = req.body;
    if (!email && !webhookUrl && !uid) {
        return res.status(400).json({ success: false, error: 'email, webhookUrl, or uid required' });
    }

    // UID指定の場合はFirestoreからメール・Slack設定を自動取得
    if (uid && (!email || !webhookUrl)) {
        try {
            const dbService = require('../services/db');
            const [userProfile, notifSettings] = await Promise.all([
                dbService.getUserProfile(uid),
                dbService.getNotificationSettings(uid)
            ]);
            if (!email && userProfile?.email) email = userProfile.email;
            if (!webhookUrl && notifSettings?.slack?.enabled && notifSettings?.slack?.webhookUrl) {
                webhookUrl = notifSettings.slack.webhookUrl;
            }
        } catch (err) {
            logger.error('Failed to fetch user settings for test:', err.message);
        }
    }

    const testData = {
        contractName: 'テスト契約書（利用規約）',
        sourceUrl: 'https://example.com/terms',
        detectedAt: new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }),
        changeSummary: '第3条の料金体系が変更されました。月額プランの価格が改定されています。'
    };

    const results = {};

    if (email) {
        try {
            const mailer = require('../services/mailer');
            await mailer.sendCrawlChangeAlertEmail(
                email,
                'テストユーザー',
                testData.contractName,
                testData.sourceUrl,
                testData.detectedAt,
                testData.changeSummary
            );
            results.email = 'sent';
            logger.info(`Test email sent to ${email}`);
        } catch (err) {
            results.email = `error: ${err.message}`;
            logger.error('Test email error:', err.message);
        }
    }

    if (webhookUrl) {
        try {
            const slackService = require('../services/slackService');
            await slackService.sendSlackNotification(
                webhookUrl,
                testData.contractName,
                testData.sourceUrl,
                testData.detectedAt,
                testData.changeSummary
            );
            results.slack = 'sent';
            logger.info('Test Slack notification sent');
        } catch (err) {
            results.slack = `error: ${err.message}`;
            logger.error('Test Slack error:', err.message);
        }
    }

    res.json({ success: true, results, testData });
});

module.exports = router;
