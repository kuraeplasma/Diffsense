const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const docxService = require('../services/docxService');
const logger = require('../utils/logger');
const busboy = require('busboy');
const { bucket } = require('../firebase');
const crypto = require('crypto');

// Helper to build Firebase download URL
function buildFirebaseDownloadUrl(bucketName, objectPath, token) {
    const encodedPath = encodeURIComponent(objectPath);
    return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodedPath}?alt=media&token=${token}`;
}

/**
 * POST /api/convert/docx-to-pdf
 * Matches the Cloud Run service API for DOCX conversion
 */
router.post('/docx-to-pdf', (req, res) => {
    const bb = busboy({ headers: req.headers });
    let fileBuffer = null;
    let fileName = 'document.docx';

    bb.on('file', (name, file, info) => {
        fileName = info.filename;
        const chunks = [];
        file.on('data', (data) => chunks.push(data));
        file.on('end', () => {
            fileBuffer = Buffer.concat(chunks);
        });
    });

    bb.on('finish', async () => {
        if (!fileBuffer) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const tmpDir = path.join(__dirname, '../../tmp/convert');
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

        const docxPath = path.join(tmpDir, `conv-${Date.now()}-${fileName}`);
        fs.writeFileSync(docxPath, fileBuffer);

        try {
            const pdfPath = await docxService.convertToPdf(docxPath);
            const pdfBuffer = fs.readFileSync(pdfPath);

            // Clean up
            fs.unlinkSync(docxPath);
            fs.unlinkSync(pdfPath);

            res.setHeader('Content-Type', 'application/pdf');
            res.send(pdfBuffer);
        } catch (err) {
            logger.error('Conversion error:', err);
            if (fs.existsSync(docxPath)) fs.unlinkSync(docxPath);
            res.status(500).json({ error: err.message });
        }
    });

    req.pipe(bb);
});

/**
 * POST /api/convert/final-docx-to-pdf
 * Applies approved revision paragraphs to the original DOCX, then converts the revised DOCX to PDF.
 */
router.post('/final-docx-to-pdf', (req, res) => {
    const bb = busboy({ headers: req.headers });
    let fileBuffer = null;
    let fileName = 'document.docx';
    let revisionsRaw = '[]';

    bb.on('file', (name, file, info) => {
        fileName = info.filename || fileName;
        const chunks = [];
        file.on('data', (data) => chunks.push(data));
        file.on('end', () => { fileBuffer = Buffer.concat(chunks); });
    });

    bb.on('field', (name, value) => {
        if (name === 'revisions') revisionsRaw = value || '[]';
    });

    bb.on('finish', async () => {
        if (!fileBuffer) return res.status(400).json({ error: 'No DOCX uploaded' });

        let revisions = [];
        try { revisions = JSON.parse(revisionsRaw || '[]'); }
        catch (_) { return res.status(400).json({ error: 'Invalid revisions payload' }); }

        const tmpDir = path.join(__dirname, '../../tmp/convert');
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

        const safeName = String(fileName || 'document.docx').replace(/[^a-zA-Z0-9_.-]/g, '_');
        const revisedPath = path.join(tmpDir, 'final-' + Date.now() + '-' + safeName);

        try {
            const revisedResult = docxService.applyRevisionsToDocx(fileBuffer, revisions);
            logger.info(`Final DOCX revisions requested=${revisedResult.requestedCount} inserted=${revisedResult.insertedCount} skipped=${JSON.stringify(revisedResult.skipped || [])}`);
            // 部分成功を許容: 反映できた分でPDFを生成し、未反映分はヘッダで通知する
            fs.writeFileSync(revisedPath, revisedResult.buffer);
            const pdfPath = await docxService.convertToPdf(revisedPath);
            const pdfBuffer = fs.readFileSync(pdfPath);

            fs.unlinkSync(revisedPath);
            fs.unlinkSync(pdfPath);

            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('X-Revisions-Requested', String(revisedResult.requestedCount));
            res.setHeader('X-Revisions-Inserted', String(revisedResult.insertedCount));
            res.setHeader('X-Revisions-Skipped', encodeURIComponent(JSON.stringify(revisedResult.skipped || [])));
            res.setHeader('Access-Control-Expose-Headers', 'X-Revisions-Requested, X-Revisions-Inserted, X-Revisions-Skipped');
            res.send(pdfBuffer);
        } catch (err) {
            logger.error('Final DOCX conversion error:', err);
            if (fs.existsSync(revisedPath)) fs.unlinkSync(revisedPath);
            res.status(500).json({ error: err.message });
        }
    });

    req.pipe(bb);
});

/**
 * POST /api/convert/final-docx
 * Applies approved revision paragraphs to the original DOCX and returns the revised DOCX.
 */
router.post('/final-docx', (req, res) => {
    const bb = busboy({ headers: req.headers });
    let fileBuffer = null;
    let fileName = 'document.docx';
    let revisionsRaw = '[]';

    bb.on('file', (name, file, info) => {
        fileName = info.filename || fileName;
        const chunks = [];
        file.on('data', (data) => chunks.push(data));
        file.on('end', () => { fileBuffer = Buffer.concat(chunks); });
    });

    bb.on('field', (name, value) => {
        if (name === 'revisions') revisionsRaw = value || '[]';
    });

    bb.on('finish', async () => {
        if (!fileBuffer) return res.status(400).json({ error: 'No DOCX uploaded' });

        let revisions = [];
        try { revisions = JSON.parse(revisionsRaw || '[]'); }
        catch (_) { return res.status(400).json({ error: 'Invalid revisions payload' }); }

        try {
            const revisedResult = docxService.applyRevisionsToDocx(fileBuffer, revisions);
            logger.info(`Final DOCX download requested=${revisedResult.requestedCount} inserted=${revisedResult.insertedCount} skipped=${JSON.stringify(revisedResult.skipped || [])}`);

            // 部分成功を許容: 一致した修正は反映し、未反映分はヘッダで通知する（全or無で全消失させない）
            const safeName = String(fileName || 'document.docx').replace(/[^a-zA-Z0-9_.-]/g, '_').replace(/\.docx?$/i, '');
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
            res.setHeader('Content-Disposition', `attachment; filename="${safeName}_final.docx"`);
            res.setHeader('X-Revisions-Requested', String(revisedResult.requestedCount));
            res.setHeader('X-Revisions-Inserted', String(revisedResult.insertedCount));
            res.setHeader('X-Revisions-Skipped', encodeURIComponent(JSON.stringify(revisedResult.skipped || [])));
            res.setHeader('Access-Control-Expose-Headers', 'X-Revisions-Requested, X-Revisions-Inserted, X-Revisions-Skipped');
            res.send(revisedResult.buffer);
        } catch (err) {
            logger.error('Final DOCX download error:', err);
            res.status(500).json({ error: err.message });
        }
    });

    req.pipe(bb);
});
/**
 * POST /api/convert/html-to-pdf
 * Matches the Cloud Run service API for HTML/Text conversion
 */
router.post('/html-to-pdf', async (req, res) => {
    try {
        const { html, text } = req.body;
        const content = html || (text ? `<html><body style="font-family:serif; white-space:pre-wrap;">${text}</body></html>` : '');
        
        if (!content) {
            return res.status(400).json({ error: 'No content' });
        }

        const tmpDir = path.join(__dirname, '../../tmp/convert');
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

        const htmlPath = path.join(tmpDir, `conv-${Date.now()}.html`);
        fs.writeFileSync(htmlPath, content);

        const pdfPath = await docxService.convertToPdf(htmlPath);
        const pdfBuffer = fs.readFileSync(pdfPath);

        // Clean up
        fs.unlinkSync(htmlPath);
        fs.unlinkSync(pdfPath);

        res.setHeader('Content-Type', 'application/pdf');
        res.send(pdfBuffer);
    } catch (err) {
        logger.error('HTML to PDF error:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
