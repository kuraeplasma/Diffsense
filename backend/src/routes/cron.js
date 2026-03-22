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

module.exports = router;
