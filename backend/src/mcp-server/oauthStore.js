const { randomUUID } = require('crypto');
const logger = require('../utils/logger');
const db = require('../services/db');
const { db: firestore, firebaseInitialized } = require('../firebase');

const COLLECTIONS = {
    CLIENTS: 'mcp_oauth_clients',
    CODES: 'mcp_oauth_codes',
    TOKENS: 'mcp_oauth_tokens'
};

class McpOAuthStore {
    constructor() {
        this.useFirestore = firebaseInitialized && !!firestore;
    }

    async _getById(collection, id) {
        const normalizedId = String(id || '').trim();
        if (!normalizedId) return null;

        if (this.useFirestore) {
            try {
                const doc = await firestore.collection(collection).doc(normalizedId).get();
                if (doc.exists) {
                    return { id: doc.id, ...doc.data() };
                }
            } catch (error) {
                logger.warn(`[mcp-oauth] Firestore read failed ${collection}/${normalizedId}: ${error.message}`);
            }
        }

        const items = await db.readData(collection);
        return (Array.isArray(items) ? items : []).find((item) => String(item.id) === normalizedId) || null;
    }

    async _queryOne(collection, field, value) {
        if (this.useFirestore) {
            try {
                const snapshot = await firestore.collection(collection)
                    .where(field, '==', value)
                    .limit(1)
                    .get();
                if (!snapshot.empty) {
                    const doc = snapshot.docs[0];
                    return { id: doc.id, ...doc.data() };
                }
            } catch (error) {
                logger.warn(`[mcp-oauth] Firestore query failed ${collection}.${field}: ${error.message}`);
            }
        }

        const items = await db.readData(collection);
        return (Array.isArray(items) ? items : []).find((item) => item && item[field] === value) || null;
    }

    async _queryMany(collection, field, value) {
        if (this.useFirestore) {
            try {
                const snapshot = await firestore.collection(collection)
                    .where(field, '==', value)
                    .get();
                if (!snapshot.empty) {
                    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
                }
            } catch (error) {
                logger.warn(`[mcp-oauth] Firestore query failed ${collection}.${field}: ${error.message}`);
            }
        }

        const items = await db.readData(collection);
        return (Array.isArray(items) ? items : []).filter((item) => item && item[field] === value);
    }

    async _save(collection, id, payload) {
        const normalizedId = String(id || randomUUID()).trim();
        const record = { id: normalizedId, ...payload };

        if (this.useFirestore) {
            try {
                await firestore.collection(collection).doc(normalizedId).set(record, { merge: true });
            } catch (error) {
                logger.warn(`[mcp-oauth] Firestore write failed ${collection}/${normalizedId}: ${error.message}`);
            }
        }

        const items = await db.readData(collection);
        const index = (Array.isArray(items) ? items : []).findIndex((item) => String(item.id) === normalizedId);
        if (index > -1) {
            items[index] = { ...items[index], ...record };
        } else {
            items.push(record);
        }
        await db.writeData(collection, items);
        return record;
    }

    async _delete(collection, id) {
        const normalizedId = String(id || '').trim();
        if (!normalizedId) return;

        if (this.useFirestore) {
            try {
                await firestore.collection(collection).doc(normalizedId).delete();
            } catch (error) {
                logger.warn(`[mcp-oauth] Firestore delete failed ${collection}/${normalizedId}: ${error.message}`);
            }
        }

        const items = await db.readData(collection);
        const filtered = (Array.isArray(items) ? items : []).filter((item) => String(item.id) !== normalizedId);
        await db.writeData(collection, filtered);
    }

    async getClient(clientId) {
        return this._getById(COLLECTIONS.CLIENTS, clientId);
    }

    async registerClient(clientInfo) {
        const now = Math.floor(Date.now() / 1000);
        const payload = {
            ...clientInfo,
            client_id: clientInfo.client_id || randomUUID(),
            client_id_issued_at: clientInfo.client_id_issued_at || now,
            createdAt: new Date().toISOString()
        };
        return this._save(COLLECTIONS.CLIENTS, payload.client_id, payload);
    }

    async saveAuthorizationCode(code, payload) {
        return this._save(COLLECTIONS.CODES, code, payload);
    }

    async getAuthorizationCode(code) {
        return this._getById(COLLECTIONS.CODES, code);
    }

    async deleteAuthorizationCode(code) {
        return this._delete(COLLECTIONS.CODES, code);
    }

    async saveToken(id, payload) {
        return this._save(COLLECTIONS.TOKENS, id, payload);
    }

    async getTokenByLookup(type, lookup) {
        const token = await this._queryOne(COLLECTIONS.TOKENS, 'lookup', lookup);
        if (!token) return null;
        return token.type === type ? token : null;
    }

    async revokeToken(id) {
        const token = await this._getById(COLLECTIONS.TOKENS, id);
        if (!token) return null;
        return this._save(COLLECTIONS.TOKENS, id, {
            ...token,
            revokedAt: new Date().toISOString()
        });
    }

    async revokeTokensByUid(uid) {
        const normalizedUid = String(uid || '').trim();
        if (!normalizedUid) {
            return { total: 0, access: 0, refresh: 0 };
        }

        const tokens = await this._queryMany(COLLECTIONS.TOKENS, 'uid', normalizedUid);
        const activeTokens = (Array.isArray(tokens) ? tokens : []).filter((token) => !token?.revokedAt);
        let access = 0;
        let refresh = 0;

        for (const token of activeTokens) {
            await this._save(COLLECTIONS.TOKENS, token.id, {
                ...token,
                revokedAt: new Date().toISOString()
            });
            if (token.type === 'refresh') {
                refresh += 1;
            } else if (token.type === 'access') {
                access += 1;
            }
        }

        return {
            total: activeTokens.length,
            access,
            refresh
        };
    }

    async deleteAuthorizationCodesByUid(uid) {
        const normalizedUid = String(uid || '').trim();
        if (!normalizedUid) {
            return { total: 0 };
        }

        const codes = await this._queryMany(COLLECTIONS.CODES, 'uid', normalizedUid);
        for (const code of (Array.isArray(codes) ? codes : [])) {
            await this._delete(COLLECTIONS.CODES, code.id);
        }

        return {
            total: Array.isArray(codes) ? codes.length : 0
        };
    }
}

module.exports = new McpOAuthStore();
