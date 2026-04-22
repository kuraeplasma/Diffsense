const express = require('express');
const router = express.Router();
const multer = require('multer');
const logger = require('../utils/logger');
const dbService = require('../services/db');
const { enqueueDocxJob, scheduleDocxJob } = require('../services/docxAsyncQueue');

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
        console.log("DOCX ROUTE HIT:", req.originalUrl);
        const uid = req.user.uid;
        const { contractId, source, previousVersion, skipAI } = req.body;
        const file = req.file;

        let currentBuffer = null;
        let sourcePayload = '';
        let filename = 'document.docx';
        let contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

        if (file) {
            currentBuffer = file.buffer;
            filename = file.originalname;
            contentType = file.mimetype;
        } else if (source) {
            sourcePayload = String(source || '');
            filename = req.body.filename || 'document.docx';
            contentType = req.body.contentType || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        }

        if (!currentBuffer && !sourcePayload) {
            return res.status(400).json({ success: false, error: 'ファイルがアップロードされていません' });
        }

        const parsedContractId = parseInt(contractId, 10);
        if (isNaN(parsedContractId)) {
            return res.status(400).json({ success: false, error: '契約IDが不正です' });
        }

        // Set initial status
        await dbService.updateContract(parsedContractId, {
            status: 'processing',
            last_updated_at: new Date().toISOString()
        }, uid);

        const queued = await enqueueDocxJob({
            contractId: parsedContractId,
            uid,
            filename,
            contentType,
            previousVersion,
            skipAI: skipAI === 'true' || skipAI === true,
            fileBuffer: currentBuffer,
            source: sourcePayload
        });

        res.once('finish', () => {
            scheduleDocxJob(queued.jobId);
        });

        // Immediate response
        return res.json({
            status: 'processing',
            contractId: parsedContractId
        });

    } catch (error) {
        logger.error('Async DOCX upload route error:', error);
        next(error);
    }
});

module.exports = router;
