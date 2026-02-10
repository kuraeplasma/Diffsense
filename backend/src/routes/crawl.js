const express = require('express');
const router = express.Router();
const crawlService = require('../services/crawlService');
const logger = require('../utils/logger');

/**
 * POST /api/crawl
 * Manual crawl a URL to check for changes
 */
router.post('/', async (req, res) => {
    try {
        const { url, lastHash } = req.body;

        if (!url) {
            return res.status(400).json({ error: 'URL is required' });
        }

        const result = await crawlService.fetchAndExtract(url);
        const changed = crawlService.hasChanged(result.hash, lastHash);

        res.json({
            success: true,
            changed: changed,
            newHash: result.hash,
            checkedAt: new Date().toISOString(),
            // Only return text if changed or it's the first time
            text: changed ? result.text : null
        });
    } catch (error) {
        logger.error('API Crawl Error:', error);
        res.status(500).json({ error: 'Failed to crawl URL' });
    }
});

module.exports = router;
