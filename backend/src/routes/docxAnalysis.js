const express = require('express');
const router = express.Router();
const multer = require('multer');
const mammoth = require('mammoth');
const logger = require('../utils/logger');
const dbService = require('../services/db');
const { enqueueDocxJob, scheduleDocxJob } = require('../services/docxAsyncQueue');

const upload = multer({
    storage: multer.memoryStorage()
});

async function validateDocxExtraction(buffer, timeoutMs = 30000) {
    let timerId = null;
    try {
        const result = await Promise.race([
            mammoth.extractRawText({ buffer }),
            new Promise((_, reject) => {
                timerId = setTimeout(() => {
                    reject(new Error(`Mammoth extraction timeout (${timeoutMs}ms)`));
                }, timeoutMs);
            })
        ]);
        const extracted = String(result?.value || '').trim();
        if (!extracted) {
            throw new Error('Mammoth extracted empty text');
        }
        return { ok: true };
    } catch (error) {
        logger.error('DOCX preflight mammoth extraction failed:', error);
        return { ok: false, error };
    } finally {
        if (timerId) clearTimeout(timerId);
    }
}

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
        if (!file) {
            return res.status(400).json({ success: false, error: 'file が未指定です。FormData の file フィールドを確認してください。' });
        }
        if (!Buffer.isBuffer(currentBuffer) || currentBuffer.length === 0) {
            return res.status(400).json({ success: false, error: 'アップロードファイルの読み取りに失敗しました。' });
        }

        const extractionCheck = await validateDocxExtraction(currentBuffer);
        if (!extractionCheck.ok) {
            return res.status(500).json({
                success: false,
                error: 'Wordからのテキスト抽出に失敗しました。',
                detail: extractionCheck.error.message
            });
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

        scheduleDocxJob(queued.jobId);

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
