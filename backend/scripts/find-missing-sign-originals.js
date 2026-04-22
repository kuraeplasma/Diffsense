const dbService = require('../src/services/db');
const { db: firestore, firebaseInitialized } = require('../src/firebase');

function pick(...values) {
    for (const value of values) {
        const normalized = String(value || '').trim();
        if (normalized) return normalized;
    }
    return '';
}

function toSummary(request = {}) {
    const snapshot = request.document_snapshot || {};
    const originalFileUrl = pick(request.original_file_url, request.originalFileUrl, snapshot.original_file_url, snapshot.originalFileUrl);
    const filePath = pick(request.original_file_path, request.filePath, request.originalFilePath, snapshot.original_file_path, snapshot.filePath, snapshot.originalFilePath);
    const sourceUrl = pick(request.source_url, request.sourceUrl, snapshot.source_url, snapshot.sourceUrl);
    return {
        id: String(request.id || ''),
        ownerUid: String(request.ownerUid || request.requestedBy || ''),
        contractId: String(request.contract_id || ''),
        hasOriginalFileUrl: Boolean(originalFileUrl),
        hasFilePath: Boolean(filePath),
        hasSourceUrl: Boolean(sourceUrl),
        status: String(request.status || '')
    };
}

function isMissing(summary) {
    return !summary.hasOriginalFileUrl;
}

async function loadSignRequests() {
    if (firebaseInitialized && firestore) {
        const snapshot = await firestore.collection('sign_requests').get();
        return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    }
    return await dbService.getAll('sign_requests');
}

async function main() {
    const signRequests = await loadSignRequests();
    const summaries = (Array.isArray(signRequests) ? signRequests : []).map(toSummary);
    const missing = summaries.filter(isMissing);

    console.log(`total=${summaries.length}`);
    console.log(`missingOriginalFileUrl=${missing.length}`);
    for (const item of missing.slice(0, 200)) {
        console.log(JSON.stringify(item));
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
