const express = require('express');
const router = express.Router();
const dbService = require('../services/db');
const logger = require('../utils/logger');

// Get all items from a collection
router.get('/:collection', async (req, res) => {
    try {
        const { collection } = req.params;
        const data = await dbService.getAll(collection);
        res.json({ success: true, data });
    } catch (error) {
        logger.error(`API Error getting ${req.params.collection}:`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Save an item (upsert)
router.post('/:collection', async (req, res) => {
    try {
        const { collection } = req.params;
        const item = req.body;

        if (!item || typeof item !== 'object') {
            return res.status(400).json({ success: false, error: 'Invalid data' });
        }

        const result = await dbService.save(collection, item);
        res.json({ success: true, data: result });
    } catch (error) {
        logger.error(`API Error saving to ${req.params.collection}:`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Bulk replace (for syncing full lists if needed)
router.post('/:collection/bulk', async (req, res) => {
    try {
        const { collection } = req.params;
        const items = req.body;

        if (!Array.isArray(items)) {
            return res.status(400).json({ success: false, error: 'Data must be an array' });
        }

        const result = await dbService.saveAll(collection, items);
        res.json({ success: true, data: result });
    } catch (error) {
        logger.error(`API Error bulk saving to ${req.params.collection}:`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Delete an item
router.delete('/:collection/:id', async (req, res) => {
    try {
        const { collection, id } = req.params;
        const success = await dbService.delete(collection, id);
        res.json({ success });
    } catch (error) {
        logger.error(`API Error deleting from ${req.params.collection}:`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
