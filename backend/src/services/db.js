const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const PLAN_LIMITS = {
    'trial': 1,      // Legacy, but kept for compatibility during migration if needed
    'starter': 1,
    'business': 3,
    'pro': 5
};

const AI_USAGE_LIMITS = {
    'trial': 5,      // Legacy/Fallback
    'starter': 15,
    'business': 120,
    'pro': 400
};

const TRIAL_AI_LIMIT = 5;
const TRIAL_DURATION_DAYS = 7;

class DBService {
    // ...
    getOriginalPlanLimit(plan) {
        return AI_USAGE_LIMITS[plan] || 0;
    }
    constructor() {
        this.dataDir = path.join(__dirname, '../../data');
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
    }

    async canAddMember(uid) {
        const user = await this.getUserProfile(uid);
        const plan = user.plan || 'starter';
        const limit = PLAN_LIMITS[plan] || 1;

        const allUsers = await this.readData('users');
        // Simple logic for this prototype: limit applies to total users in the system
        return allUsers.length < limit;
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
     * Helper to check if a user is currently in the trial period
     * @param {object} userProfile 
     */
    isTrialActive(userProfile) {
        if (!userProfile.trialStartedAt) return false;

        const trialStart = new Date(userProfile.trialStartedAt);
        const now = new Date();
        const diffTime = now - trialStart;
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

        return diffDays <= TRIAL_DURATION_DAYS && diffDays >= 0;
    }

    /**
     * Get usage limit considering trial status
     * @param {object} userProfile 
     */
    getUsageLimit(userProfile) {
        // If in trial, limit is always 5 checks (Trial limitation)
        if (this.isTrialActive(userProfile)) {
            return TRIAL_AI_LIMIT;
        }
        // Otherwise, use plan-based limit
        const plan = userProfile.plan || 'starter';
        return AI_USAGE_LIMITS[plan] || 0;
    }

    /**
     * Get or create a basic user profile for usage tracking
     * @param {string} uid - Firebase UID
     */
    async getUserProfile(uid) {
        const users = await this.readData('users');
        let user = users.find(u => u.uid === uid);

        if (!user) {
            // New user: default to 'starter' plan but with 7-day trial active
            user = {
                uid: uid,
                plan: 'starter',
                trialStartedAt: new Date().toISOString(),
                hasPaymentMethod: false,
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
