const express = require('express');
const router = express.Router();
const multer = require('multer');
const logger = require('../utils/logger');
const dbService = require('../services/db');
const { processDocxBackground } = require('../services/docxBackgroundProcessor');

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 50 * 1024 * 1024 // 50MB
    }
});

/**
 * POST /api/docx/upload-async
 * Asynchronous DOCX upload and analysis
 */
router.post('/upload-async', upload.single('file'), async (req, res, next) => {
    try {
        const uid = req.user.uid;
        const { contractId, previousVersion, skipAI } = req.body;
        const file = req.file;

        if (!file) {
            return res.status(400).json({ success: false, error: 'ファイルがアップロードされていません' });
        }

        const parsedContractId = parseInt(contractId, 10);
        if (isNaN(parsedContractId)) {
            return res.status(400).json({ success: false, error: '契約IDが不正です' });
        }

        const currentBuffer = file.buffer;
        const filename = file.originalname;
        const contentType = file.mimetype;

        // DOCX Magic Bytes check
        if (currentBuffer.length < 4 ||
            currentBuffer[0] !== 0x50 || currentBuffer[1] !== 0x4B ||
            currentBuffer[2] !== 0x03 || currentBuffer[3] !== 0x04) {
            return res.status(400).json({ success: false, error: '無効なファイル形式です。Word文書（.docx）をアップロードしてください。' });
        }

        // Set initial status
        await dbService.updateContract(parsedContractId, {
            status: 'processing',
            last_updated_at: new Date().toISOString()
        }, uid);

        // Immediate response
        res.json({
            success: true,
            status: 'processing',
            contractId: parsedContractId
        });

        // Background task
        processDocxBackground(parsedContractId, currentBuffer, filename, contentType, previousVersion, skipAI === 'true' || skipAI === true, uid)
            .catch(err => logger.error(`Async route background error for ${parsedContractId}:`, err));

    } catch (error) {
        logger.error('Async DOCX upload route error:', error);
        next(error);
    }
});

module.exports = router;
