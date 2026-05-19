const crypto = require('crypto');

const TTL_MS = 5 * 60 * 1000; // 5 minutes
const store = new Map();

// Cleanup expired tokens every minute
setInterval(() => {
    const now = Date.now();
    for (const [token, entry] of store) {
        if (entry.expires < now) store.delete(token);
    }
}, 60_000).unref();

function createToken(filePath, originalName) {
    const token = crypto.randomUUID();
    store.set(token, { filePath, originalName, expires: Date.now() + TTL_MS });
    return token;
}

// Single-use: deletes the token after first successful read
function consumeToken(token) {
    const entry = store.get(token);
    if (!entry) return null;
    if (entry.expires < Date.now()) {
        store.delete(token);
        return null;
    }
    store.delete(token);
    return entry;
}

module.exports = { createToken, consumeToken };
