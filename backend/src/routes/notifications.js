'use strict';

const express = require('express');
const router = express.Router();
const dbService = require('../services/db');
const logger = require('../utils/logger');

/**
 * GET /api/notifications/settings
 * 通知設定を取得
 */
router.get('/settings', async (req, res) => {
    try {
        const uid = req.user.uid;
        const settings = await dbService.getNotificationSettings(uid);
        res.json({ success: true, data: settings });
    } catch (error) {
        logger.error('GET /notifications/settings error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * PATCH /api/notifications/settings
 * 通知設定を更新
 */
router.patch('/settings', async (req, res) => {
    try {
        const uid = req.user.uid;
        const { email, slack } = req.body;

        // バリデーション
        const settings = {};
        if (email !== undefined) {
            settings.email = { crawlAlert: Boolean(email?.crawlAlert ?? true) };
        }
        if (slack !== undefined) {
            settings.slack = { enabled: Boolean(slack?.enabled ?? false) };
            // webhookUrlは明示的に送られた場合のみ更新（省略時は既存値を保持）
            if (slack?.webhookUrl !== undefined) {
                const webhookUrl = String(slack.webhookUrl || '').trim();
                if (webhookUrl && !webhookUrl.startsWith('https://hooks.slack.com/')) {
                    return res.status(400).json({ success: false, error: 'Slack Webhook URLの形式が正しくありません' });
                }
                settings.slack.webhookUrl = webhookUrl;
            }
        }

        // 既存設定とマージ
        const current = await dbService.getNotificationSettings(uid);
        const merged = {
            email: { ...current.email, ...settings.email },
            slack: { ...current.slack, ...settings.slack }
        };

        await dbService.updateNotificationSettings(uid, merged);
        res.json({ success: true, data: merged });
    } catch (error) {
        logger.error('PATCH /notifications/settings error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
