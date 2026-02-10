const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

class DBService {
    constructor() {
        this.dataDir = path.join(__dirname, '../../data');
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
    }

    getFilePath(collection) {
        return path.join(this.dataDir, `${collection}.json`);
    }

    async readData(collection) {
        const filePath = this.getFilePath(collection);
        if (!fs.existsSync(filePath)) {
            return [];
        }
        try {
            const data = await fs.promises.readFile(filePath, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            logger.error(`Error reading ${collection}:`, error);
            return [];
        }
    }

    async writeData(collection, data) {
        const filePath = this.getFilePath(collection);
        try {
            await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
            return true;
        } catch (error) {
            logger.error(`Error writing ${collection}:`, error);
            return false;
        }
    }

    async getAll(collection) {
        return await this.readData(collection);
    }

    async save(collection, item) {
        const data = await this.readData(collection);
        // Check if item exists (update) or is new (insert)
        const index = data.findIndex(d => d.id === item.id);

        if (index > -1) {
            data[index] = { ...data[index], ...item };
        } else {
            data.push(item);
        }

        await this.writeData(collection, data);
        return item;
    }

    // Bulk save (replace all) - useful for initial sync or full updates
    async saveAll(collection, items) {
        await this.writeData(collection, items);
        return items;
    }

    async delete(collection, id) {
        let data = await this.readData(collection);
        const initialLength = data.length;
        data = data.filter(d => d.id !== parseInt(id));

        if (data.length !== initialLength) {
            await this.writeData(collection, data);
            return true;
        }
        return false;
    }

    // --- User Profile & Usage Tracking ---

    /**
     * Get or create a basic user profile for usage tracking
     * @param {string} uid - Firebase UID
     */
    async getUserProfile(uid) {
        const users = await this.readData('users');
        let user = users.find(u => u.uid === uid);

        if (!user) {
            user = {
                uid: uid,
                plan: 'starter', // Default plan
                usageCount: 0,
                lastResetDate: new Date().toISOString()
            };
            users.push(user);
            await this.writeData('users', users);
        }

        return user;
    }

    /**
     * Increment AI usage count for a user
     * @param {string} uid - Firebase UID
     */
    async incrementUsage(uid) {
        const users = await this.readData('users');
        const index = users.findIndex(u => u.uid === uid);

        if (index > -1) {
            users[index].usageCount = (users[index].usageCount || 0) + 1;
            users[index].lastUsedAt = new Date().toISOString();
            await this.writeData('users', users);
            return users[index];
        }
        return null;
    }

    // --- Crawling Support ---

    /**
     * Get all contracts for Pro-plan users that have monitoring enabled
     */
    async getMonitoringContracts() {
        const users = await this.readData('users');
        const proUsers = users.filter(u => u.plan === 'pro');
        const proUids = proUsers.map(u => u.uid);

        const contracts = await this.readData('contracts');
        // If owner_uid is not present, we assume for now (in dev) that it might be needed
        // but since we don't have owner_uid, we'll filter by source_type === 'URL' and monitoring_enabled
        return contracts.filter(c =>
            c.source_type === 'URL' &&
            c.monitoring_enabled === true
        );
    }

    /**
     * Update a contract by ID
     */
    async updateContract(id, updates) {
        const contracts = await this.readData('contracts');
        const index = contracts.findIndex(c => c.id === id);

        if (index > -1) {
            contracts[index] = { ...contracts[index], ...updates };
            await this.writeData('contracts', contracts);
            return contracts[index];
        }
        return null;
    }
}

module.exports = new DBService();
