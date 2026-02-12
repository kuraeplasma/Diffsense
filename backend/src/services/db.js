const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { db: firestore, firebaseInitialized } = require('../firebase');

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
        this.useFirestore = firebaseInitialized && !!firestore;
        if (this.useFirestore) {
            logger.info('DBService: Using Firestore for user data persistence');
        } else {
            logger.warn('DBService: Firestore not available, falling back to file-based storage (data may be lost on restart)');
        }
    }

    // --- Firestore helpers for user profiles ---

    async _firestoreGetUser(uid) {
        if (!this.useFirestore) {
            logger.warn(`_firestoreGetUser(${uid}): Firestore not available`);
            return null;
        }
        try {
            const doc = await firestore.collection('users').doc(uid).get();
            if (doc.exists) {
                const data = doc.data();
                logger.info(`_firestoreGetUser(${uid}): Found, plan=${data.plan}`);
                return data;
            }
            logger.info(`_firestoreGetUser(${uid}): Document does not exist`);
            return null;
        } catch (error) {
            logger.error(`Firestore read error for user ${uid}: ${error.message}`);
            return null;
        }
    }

    async _firestoreSetUser(uid, data) {
        if (!this.useFirestore) return;
        try {
            await firestore.collection('users').doc(uid).set(data, { merge: true });
        } catch (error) {
            logger.error(`Firestore write error for user ${uid}: ${error.message}`);
        }
    }

    async _firestoreGetTeamMembers(ownerUid) {
        if (!this.useFirestore) return [];
        try {
            const snapshot = await firestore.collection('teams')
                .where('ownerUid', '==', ownerUid).get();
            return snapshot.docs.map(doc => doc.data());
        } catch (error) {
            logger.error(`Firestore team read error: ${error.message}`);
            return [];
        }
    }

    async _firestoreAddTeamMember(member) {
        if (!this.useFirestore) return;
        try {
            await firestore.collection('teams').add(member);
        } catch (error) {
            logger.error(`Firestore team write error: ${error.message}`);
        }
    }

    async canAddMember(uid) {
        const user = await this.getUserProfile(uid);
        const plan = user.plan || 'starter';
        const limit = PLAN_LIMITS[plan] || 1;

        // Count only team members invited by this user
        let myMembers;
        if (this.useFirestore) {
            myMembers = await this._firestoreGetTeamMembers(uid);
        } else {
            const teams = await this.readData('teams');
            myMembers = teams.filter(t => t.ownerUid === uid);
        }
        logger.info(`canAddMember: uid=${uid}, plan=${plan}, limit=${limit}, currentMembers=${myMembers.length}`);
        return myMembers.length < limit;
    }

    async addTeamMember(ownerUid, member) {
        const record = {
            ownerUid: ownerUid,
            memberUid: member.memberUid || null,
            email: member.email,
            name: member.name,
            role: member.role,
            invitedAt: new Date().toISOString()
        };

        // Save to Firestore
        await this._firestoreAddTeamMember(record);

        // Also save to file (fallback)
        const teams = await this.readData('teams');
        teams.push(record);
        await this.writeData('teams', teams);
        return true;
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
     * Uses Firestore as primary store, file as fallback cache
     * @param {string} uid - Firebase UID
     */
    async getUserProfile(uid) {
        // 1. Try Firestore first (persistent, survives cold starts)
        const firestoreUser = await this._firestoreGetUser(uid);
        if (firestoreUser) {
            logger.info(`getUserProfile(${uid}): Found in Firestore, plan=${firestoreUser.plan}`);
            // Also update local file cache
            const users = await this.readData('users');
            const index = users.findIndex(u => u.uid === uid);
            if (index > -1) {
                users[index] = { ...users[index], ...firestoreUser };
                await this.writeData('users', users);
            } else {
                users.push(firestoreUser);
                await this.writeData('users', users);
            }
            return firestoreUser;
        }

        // 2. Try file-based storage
        const users = await this.readData('users');
        let user = users.find(u => u.uid === uid);

        if (user) {
            logger.info(`getUserProfile(${uid}): Found in file (not Firestore), plan=${user.plan}, syncing to Firestore`);
            // Found in file but not in Firestore - sync to Firestore
            await this._firestoreSetUser(uid, user);
            return user;
        }

        // 3. New user: create with starter plan and trial
        logger.info(`getUserProfile(${uid}): NOT FOUND anywhere, creating new starter profile`);
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
        await this._firestoreSetUser(uid, user);
        logger.info(`New user profile created: ${uid}, plan: starter`);

        return user;
    }

    /**
     * Update payment info for a user
     * @param {string} uid - Firebase UID
     * @param {object} paymentData - Payment fields to update
     */
    async updatePaymentInfo(uid, paymentData) {
        // Update Firestore
        await this._firestoreSetUser(uid, paymentData);

        // Update file
        const users = await this.readData('users');
        const index = users.findIndex(u => u.uid === uid);

        if (index > -1) {
            Object.assign(users[index], paymentData);
            await this.writeData('users', users);
            return users[index];
        }
        return null;
    }

    /**
     * Set user's selected plan
     * @param {string} uid - Firebase UID
     * @param {string} plan - Plan ID (starter, business, pro)
     */
    async setUserPlan(uid, plan) {
        logger.info(`setUserPlan: uid=${uid}, plan=${plan}`);

        // Always persist to Firestore first
        await this._firestoreSetUser(uid, { uid, plan });

        const users = await this.readData('users');
        const index = users.findIndex(u => u.uid === uid);

        if (index > -1) {
            users[index].plan = plan;
            await this.writeData('users', users);
            return users[index];
        } else {
            // New user with selected plan
            const user = {
                uid: uid,
                plan: plan,
                trialStartedAt: new Date().toISOString(),
                hasPaymentMethod: false,
                usageCount: 0,
                lastResetDate: new Date().toISOString()
            };
            users.push(user);
            await this.writeData('users', users);
            await this._firestoreSetUser(uid, user);
            return user;
        }
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
            // Sync to Firestore
            await this._firestoreSetUser(uid, {
                usageCount: users[index].usageCount,
                lastUsedAt: users[index].lastUsedAt
            });
            return users[index];
        }
        return null;
    }

    /**
     * Find a user by their PayPal subscription ID (for webhook processing)
     * @param {string} subscriptionId
     */
    async findUserBySubscriptionId(subscriptionId) {
        // Try Firestore first
        if (this.useFirestore) {
            try {
                const snapshot = await firestore.collection('users')
                    .where('paypalSubscriptionId', '==', subscriptionId).limit(1).get();
                if (!snapshot.empty) {
                    return snapshot.docs[0].data();
                }
            } catch (error) {
                logger.error(`Firestore query error: ${error.message}`);
            }
        }
        // Fallback to file
        const users = await this.readData('users');
        return users.find(u => u.paypalSubscriptionId === subscriptionId) || null;
    }

    /**
     * Reset monthly usage count for a user (called on monthly payment success)
     * @param {string} uid
     */
    async resetMonthlyUsage(uid) {
        const resetData = {
            usageCount: 0,
            lastResetDate: new Date().toISOString()
        };

        // Sync to Firestore
        await this._firestoreSetUser(uid, resetData);

        const users = await this.readData('users');
        const index = users.findIndex(u => u.uid === uid);

        if (index > -1) {
            Object.assign(users[index], resetData);
            await this.writeData('users', users);
            return users[index];
        }
        return null;
    }

    /**
     * Get a user's team role and owner info by checking if they were invited as a member
     * Returns { role, ownerUid, isTeamMember }
     * @param {string} email - User's email
     * @param {string} uid - User's UID
     */
    async getTeamRole(email, uid) {
        // Check Firestore for team membership
        if (this.useFirestore) {
            try {
                const snapshot = await firestore.collection('teams')
                    .where('email', '==', email).limit(1).get();
                if (!snapshot.empty) {
                    const member = snapshot.docs[0].data();
                    logger.info(`getTeamRole: ${email} found as team member, role=${member.role}, ownerUid=${member.ownerUid}`);
                    return {
                        role: member.role,
                        ownerUid: member.ownerUid,
                        isTeamMember: true
                    };
                }
            } catch (error) {
                logger.error(`Firestore team role query error: ${error.message}`);
            }
        }

        // Fallback to file-based
        const teams = await this.readData('teams');
        const member = teams.find(t => t.email === email);
        if (member) {
            logger.info(`getTeamRole (file): ${email} found as team member, role=${member.role}, ownerUid=${member.ownerUid}`);
            return {
                role: member.role,
                ownerUid: member.ownerUid,
                isTeamMember: true
            };
        }

        // Not found as invited member = owner/admin
        logger.info(`getTeamRole: ${email} not found as invited member, defaulting to 管理者`);
        return {
            role: '管理者',
            ownerUid: uid,
            isTeamMember: false
        };
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
