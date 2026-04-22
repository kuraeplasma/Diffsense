const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('../utils/logger');
const { processDocxBackground } = require('./docxBackgroundProcessor');

const JOBS_DIR = path.resolve(__dirname, '../../tmp/docx-jobs');

function ensureJobsDir() {
    if (!fs.existsSync(JOBS_DIR)) {
        fs.mkdirSync(JOBS_DIR, { recursive: true });
    }
}

function safeParseJob(jsonRaw) {
    try {
        return JSON.parse(String(jsonRaw || '{}'));
    } catch {
        return null;
    }
}

function createJobId(contractId) {
    return `${contractId}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
}

async function enqueueDocxJob({
    contractId,
    uid,
    filename,
    contentType,
    previousVersion,
    skipAI,
    fileBuffer,
    source
}) {
    ensureJobsDir();

    const jobId = createJobId(contractId);
    const metaPath = path.join(JOBS_DIR, `${jobId}.json`);
    const payloadPath = path.join(JOBS_DIR, `${jobId}.payload`);

    if (Buffer.isBuffer(fileBuffer)) {
        await fs.promises.writeFile(payloadPath, fileBuffer);
    } else if (typeof source === 'string' && source.trim().length > 0) {
        await fs.promises.writeFile(payloadPath, source, 'utf8');
    } else {
        throw new Error('No DOCX payload to enqueue');
    }

    const metadata = {
        jobId,
        contractId,
        uid,
        filename,
        contentType,
        previousVersion: previousVersion ?? null,
        skipAI: skipAI === true,
        payloadType: Buffer.isBuffer(fileBuffer) ? 'buffer' : 'base64_source',
        payloadPath,
        createdAt: new Date().toISOString()
    };

    await fs.promises.writeFile(metaPath, JSON.stringify(metadata), 'utf8');
    return { jobId };
}

async function loadJob(jobId) {
    const metaPath = path.join(JOBS_DIR, `${jobId}.json`);
    if (!fs.existsSync(metaPath)) {
        throw new Error(`Job metadata missing: ${jobId}`);
    }
    const metadata = safeParseJob(await fs.promises.readFile(metaPath, 'utf8'));
    if (!metadata) {
        throw new Error(`Job metadata is invalid JSON: ${jobId}`);
    }
    return metadata;
}

async function cleanupJobFiles(job) {
    const paths = [
        path.join(JOBS_DIR, `${job.jobId}.json`),
        job.payloadPath
    ];
    await Promise.all(paths.map(async (targetPath) => {
        if (!targetPath) return;
        if (!fs.existsSync(targetPath)) return;
        try {
            await fs.promises.unlink(targetPath);
        } catch (error) {
            logger.warn(`DOCX job cleanup failed for ${targetPath}: ${error.message}`);
        }
    }));
}

function toDocxBuffer(job, payloadRaw) {
    if (job.payloadType === 'buffer') {
        return payloadRaw;
    }
    if (job.payloadType === 'base64_source') {
        const sourceRaw = String(payloadRaw || '');
        const base64Clean = sourceRaw.split(',').pop();
        return Buffer.from(base64Clean, 'base64');
    }
    throw new Error(`Unsupported payloadType: ${job.payloadType}`);
}

async function processDocxJob(jobId) {
    const job = await loadJob(jobId);
    logger.info(`DOCX async job started: ${jobId}`);
    try {
        const payloadRaw = await fs.promises.readFile(job.payloadPath);
        const currentBuffer = toDocxBuffer(job, payloadRaw);
        await processDocxBackground(
            Number(job.contractId),
            currentBuffer,
            String(job.filename || 'document.docx'),
            String(job.contentType || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
            job.previousVersion ?? null,
            job.skipAI === true,
            String(job.uid || '')
        );
        logger.info(`DOCX async job completed: ${jobId}`);
    } catch (error) {
        logger.error(`DOCX async job failed: ${jobId}`, error);
    } finally {
        await cleanupJobFiles(job);
    }
}

function scheduleDocxJob(jobId) {
    setImmediate(() => {
        processDocxJob(jobId).catch((error) => {
            logger.error(`DOCX async scheduler failed: ${jobId}`, error);
        });
    });
}

module.exports = {
    enqueueDocxJob,
    scheduleDocxJob
};
