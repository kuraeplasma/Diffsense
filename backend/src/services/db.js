const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { db: firestore, firebaseInitialized } = require('../firebase');

const PLAN_LIMITS = {
    'trial': 1,      // Team member limits
    'starter': 1,
    'business': 3,
    'pro': 5
};

const AI_USAGE_LIMITS = {
    'trial': 5,
    'starter': 15,
    'business': 120,
    'pro': 400
};

const SIGN_USAGE_LIMITS = {
    'trial': 3,
    'starter': 10,
    'business': 50,
    'pro': 999999 // Unlimited for now, handled in code
};

const TRIAL_AI_LIMIT = 5;
const TRIAL_DURATION_DAYS = 7;
const VALID_BILLING_CYCLES = ['monthly', 'annual'];

function normalizeBillingCycle(value) {
    return VALID_BILLING_CYCLES.includes(value) ? value : 'monthly';
}

class DBService {
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

    getOriginalPlanLimit(plan) {
        return AI_USAGE_LIMITS[plan] || 0;
    }

    getSignUsageLimit(plan) {
        return SIGN_USAGE_LIMITS[plan] || 0;
    }

    getSignUsageLimitForUser(userProfile) {
        // トライアル中はトライアル上限を適用（getUsageLimitと同様の挙動）
        if (this.isTrialActive(userProfile)) {
            return SIGN_USAGE_LIMITS['trial'];
        }
        const plan = userProfile.plan || 'pro';
        return SIGN_USAGE_LIMITS[plan] || 0;
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

    // --- New Firestore support for Contracts ---

    async _firestoreGetContracts(ownerUid) {
        if (!this.useFirestore) return null;
        try {
            const snapshot = await firestore.collection('contracts')
                .where('ownerUid', '==', ownerUid).get();
            return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        } catch (error) {
            logger.error(`Firestore contracts read error: ${error.message}`);
            return null;
        }
    }

    async _firestoreSaveContract(ownerUid, contract) {
        if (!this.useFirestore) return;
        try {
            const docId = contract.id ? String(contract.id) : null;
            if (docId) {
                await firestore.collection('contracts').doc(docId).set({ ...contract, ownerUid }, { merge: true });
            } else {
                await firestore.collection('contracts').add({ ...contract, ownerUid });
            }
        } catch (error) {
            logger.error(`Firestore contract write error: ${error.message}`);
        }
    }

    // --- New Firestore support for Sign Requests ---

    async _firestoreGetSignRequests(ownerUid) {
        if (!this.useFirestore) return null;
        try {
            const snapshot = await firestore.collection('sign_requests')
                .where('ownerUid', '==', ownerUid).get();
            return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        } catch (error) {
            logger.error(`Firestore sign_requests read error: ${error.message}`);
            return null;
        }
    }

    async getSignRequestById(signRequestId) {
        if (this.useFirestore) {
            try {
                const docId = String(signRequestId || '').trim();
                if (docId) {
                    const direct = await firestore.collection('sign_requests').doc(docId).get();
                    if (direct.exists) {
                        return { id: direct.id, ...direct.data() };
                    }
                }

                const idCandidates = [];
                if (docId) idCandidates.push(docId);
                const numericId = Number(signRequestId);
                if (!Number.isNaN(numericId) && String(numericId) === docId) {
                    idCandidates.push(numericId);
                }

                for (const idValue of idCandidates) {
                    const snapshot = await firestore.collection('sign_requests')
                        .where('id', '==', idValue)
                        .limit(1)
                        .get();
                    if (!snapshot.empty) {
                        const doc = snapshot.docs[0];
                        return { id: doc.id, ...doc.data() };
                    }
                }
            } catch (error) {
                logger.warn(`getSignRequestById Firestore failed id=${signRequestId} error=${error.message}`);
            }
        }

        const requests = await this.readData('sign_requests');
        return (Array.isArray(requests) ? requests : []).find((request) => String(request.id) === String(signRequestId)) || null;
    }

    async _firestoreSaveSignRequest(ownerUid, request) {
        if (!this.useFirestore) return;
        try {
            const docId = request.id ? String(request.id) : null;
            const payload = { ...request, ownerUid, updatedAt: new Date().toISOString() };
            if (docId) {
                await firestore.collection('sign_requests').doc(docId).set(payload, { merge: true });
            } else {
                await firestore.collection('sign_requests').add(payload);
            }
        } catch (error) {
            logger.error(`Firestore sign_request write error: ${error.message}`);
        }
    }

    async canAddMember(uid) {
        const user = await this.getUserProfile(uid);
        const plan = user.plan || 'pro';
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
        if (!userProfile) return false;

        // If user has a paid active subscription, they are NOT in trial
        if (userProfile.subscriptionState === 'active' || 
            userProfile.stripeStatus === 'ACTIVE' || 
            userProfile.paypalStatus === 'ACTIVE') {
            logger.info(`isTrialActive(${userProfile.uid}): false (Active paid status detected)`);
            return false;
        }

        if (!userProfile.trialStartedAt) {
            logger.info(`isTrialActive(${userProfile.uid}): false (No trialStartedAt)`);
            return false;
        }

        const trialStart = new Date(userProfile.trialStartedAt);
        const now = new Date();
        const diffTime = now - trialStart;
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

        const isActive = diffDays <= TRIAL_DURATION_DAYS && diffDays >= 0;
        logger.info(`isTrialActive(${userProfile.uid}): ${isActive} (diffDays=${diffDays}, started=${userProfile.trialStartedAt})`);
        return isActive;
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
        const plan = userProfile.plan || 'pro';
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
            logger.info(`getUserProfile(${uid}): Found in Firestore (plan=${firestoreUser.plan}, trialStart=${firestoreUser.trialStartedAt})`);
            firestoreUser.billingCycle = normalizeBillingCycle(firestoreUser.billingCycle);
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
            user.billingCycle = normalizeBillingCycle(user.billingCycle);
            logger.info(`getUserProfile(${uid}): Found in file (not Firestore), plan=${user.plan}, syncing to Firestore`);
            // Found in file but not in Firestore - sync to Firestore
            await this._firestoreSetUser(uid, user);
            return user;
        }

        // 3. New user: create with pro plan and trial
        logger.info(`getUserProfile(${uid}): NOT FOUND anywhere, creating new pro profile`);
        user = {
            uid: uid,
            plan: 'pro',
            billingCycle: 'monthly',
            trialStartedAt: new Date().toISOString(),
            hasPaymentMethod: false,
            usageCount: 0,
            lastResetDate: new Date().toISOString()
        };
        users.push(user);
        await this.writeData('users', users);
        await this._firestoreSetUser(uid, user);
        logger.info(`New user profile created: ${uid}, plan: pro`);

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
     * Set/Update user email in profile
     * @param {string} uid 
     * @param {string} email 
     */
    async upsertUserEmail(uid, email) {
        if (!uid || !email) return;

        // Try to get profile first to check if update is needed
        const profile = await this.getUserProfile(uid);
        if (profile.email === email) return;

        logger.info(`upsertUserEmail: uid=${uid}, email=${email}`);
        await this.updatePaymentInfo(uid, { email });
    }

    /**
     * Set user's selected plan
     * @param {string} uid - Firebase UID
     * @param {string} plan - Plan ID (starter, business, pro)
     * @param {string|null} billingCycle - Billing cycle (monthly, annual)
     */
    async setUserPlan(uid, plan, billingCycle = null, options = {}) {
        const normalizedBillingCycle = billingCycle ? normalizeBillingCycle(billingCycle) : null;
        const forceTrialStart = options.forceTrialStart === true;
        logger.info(`setUserPlan: uid=${uid}, plan=${plan}, billingCycle=${normalizedBillingCycle || 'keep'}, forceTrialStart=${forceTrialStart}`);

        const existingProfile = await this.getUserProfile(uid);
        let trialStartedAt = existingProfile?.trialStartedAt || null;

        if (forceTrialStart) {
            trialStartedAt = new Date().toISOString();
        }

        const firestorePayload = normalizedBillingCycle
            ? { uid, plan, billingCycle: normalizedBillingCycle, trialStartedAt }
            : { uid, plan, trialStartedAt };

        // Always persist to Firestore first
        logger.info(`setUserPlan(${uid}): Updating to plan=${plan}, billingCycle=${normalizedBillingCycle}, trialStart=${trialStartedAt}`);
        await this._firestoreSetUser(uid, firestorePayload);

        const users = await this.readData('users');
        const index = users.findIndex(u => u.uid === uid);

        if (index > -1) {
            users[index].plan = plan;
            users[index].trialStartedAt = trialStartedAt;
            if (normalizedBillingCycle) {
                users[index].billingCycle = normalizedBillingCycle;
            } else {
                users[index].billingCycle = normalizeBillingCycle(users[index].billingCycle);
            }
            await this.writeData('users', users);
            return users[index];
        } else {
            // New user with selected plan
            const user = {
                uid: uid,
                plan: plan,
                billingCycle: normalizedBillingCycle || 'monthly',
                trialStartedAt,
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
    async getContracts(ownerUid) {
        if (this.useFirestore && ownerUid) {
            const fsContracts = await this._firestoreGetContracts(ownerUid);
            if (fsContracts) return fsContracts;
        }
        return await this.readData('contracts');
    }

    async saveContract(ownerUid, contract) {
        if (this.useFirestore && ownerUid) {
            await this._firestoreSaveContract(ownerUid, contract);
        }
        // Always sync to file as fallback/cache
        const contracts = await this.readData('contracts');
        const index = contracts.findIndex(c => c.id === contract.id);
        if (index > -1) {
            contracts[index] = { ...contracts[index], ...contract };
        } else {
            contracts.push(contract);
        }
        await this.writeData('contracts', contracts);
        return contract;
    }

    async getSignRequests(ownerUid) {
        if (this.useFirestore && ownerUid) {
            const fsRequests = await this._firestoreGetSignRequests(ownerUid);
            if (fsRequests) return fsRequests;
        }
        return await this.readData('sign_requests');
    }

    async addSignRequest(ownerUid, request) {
        const timestamp = new Date().toISOString();
        const newRequest = {
            id: request.id || Date.now(),
            created_at: timestamp,
            ...request
        };

        if (this.useFirestore && ownerUid) {
            await this._firestoreSaveSignRequest(ownerUid, newRequest);
        }

        // Sync to file
        const requests = await this.readData('sign_requests');
        requests.push(newRequest);
        await this.writeData('sign_requests', requests);
        return newRequest;
    }

    /**
     * Update a contract by ID
     */
    async updateContract(id, updates, ownerUid = null) {
        const contracts = await this.readData('contracts');
        const index = contracts.findIndex(c => c.id === id);

        if (index > -1) {
            contracts[index] = { ...contracts[index], ...updates };
            if (this.useFirestore && ownerUid) {
                await this._firestoreSaveContract(ownerUid, contracts[index]);
            }
            await this.writeData('contracts', contracts);
            return contracts[index];
        }
        return null;
    }

    /**
     * Update sign request status by Zoho Request ID (called by webhook)
     */
    async updateSignRequestStatusByZohoId(zohoRequestId, status, metadata = {}) {
        const requests = await this.readData('sign_requests');
        const index = requests.findIndex(r => r.zoho_request_id === zohoRequestId);

        if (index > -1) {
            const request = requests[index];
            request.status = status;
            request.updated_at = new Date().toISOString();
            request.zoho_last_event = metadata;

            // Also update recipients if present in metadata
            if (metadata.requests?.actions) {
                request.actions = metadata.requests.actions;
                request.recipients = metadata.requests.actions.map(a => ({
                    email: a.recipient_email,
                    name: a.recipient_name,
                    status: a.action_status,
                    action_id: a.action_id
                }));
            }

            if (this.useFirestore && request.ownerUid) {
                await this._firestoreSaveSignRequest(request.ownerUid, request);
            }

            await this.writeData('sign_requests', requests);
            return request;
        } else {
            logger.warn(`Sign request with zoho_request_id ${zohoRequestId} not found for webhook update.`);
            return null;
        }
    }

    /**
     * Get all contracts that have URL monitoring enabled (for cron crawling)
     * Returns contracts with source_url set, along with ownerUid and owner email
     */
    async getMonitoringContracts() {
        if (this.useFirestore) {
            try {
                const snapshot = await firestore.collection('contracts')
                    .where('source_url', '!=', null)
                    .get();
                if (!snapshot.empty) {
                    return snapshot.docs
                        .map(doc => ({ id: doc.id, ...doc.data() }))
                        .filter(c => c.source_url && c.source_url.trim() !== '');
                }
            } catch (err) {
                logger.warn(`getMonitoringContracts Firestore failed: ${err.message}`);
            }
        }
        const contracts = await this.readData('contracts');
        return contracts.filter(c => c.source_url && c.source_url.trim() !== '');
    }

    /**
     * Get notification settings for a user
     */
    async getNotificationSettings(uid) {
        const profile = await this.getUserProfile(uid);
        return profile.notificationSettings || {
            email: { crawlAlert: true },
            slack: { enabled: false, webhookUrl: '' }
        };
    }

    /**
     * Update notification settings for a user
     */
    async updateNotificationSettings(uid, settings) {
        logger.info(`updateNotificationSettings: uid=${uid}`);
        const payload = { notificationSettings: settings };
        await this._firestoreSetUser(uid, payload);

        // Sync to file
        const users = await this.readData('users');
        const index = users.findIndex(u => u.uid === uid);
        if (index > -1) {
            users[index].notificationSettings = settings;
            await this.writeData('users', users);
        }
    }

    /**
     * Slack OAuth state の一時保存（10分TTL想定）
     */
    async saveSlackOAuthState(state, uid) {
        if (this.useFirestore) {
            await firestore.collection('slack_oauth_states').doc(state).set({
                uid,
                createdAt: new Date().toISOString()
            });
        }
        // ファイルフォールバック（メモリでも可だがシンプルにスキップ）
    }

    async getSlackOAuthState(state) {
        if (this.useFirestore) {
            const doc = await firestore.collection('slack_oauth_states').doc(state).get();
            if (doc.exists) {
                const data = doc.data();
                // 10分以上経過していたら無効
                const createdAt = new Date(data.createdAt);
                if (Date.now() - createdAt.getTime() < 10 * 60 * 1000) {
                    return data.uid;
                }
            }
        }
        return null;
    }

    async deleteSlackOAuthState(state) {
        if (this.useFirestore) {
            await firestore.collection('slack_oauth_states').doc(state).delete();
        }
    }

    async updateSignRequest(id, updates, ownerUid = null) {
        const requestId = String(id || '').trim();

        // Firestore-first update (Cloud Run production-safe)
        if (this.useFirestore && requestId) {
            try {
                const collection = firestore.collection('sign_requests');
                let docRef = collection.doc(requestId);
                let snapshot = await docRef.get();

                if (!snapshot.exists) {
                    const idCandidates = [requestId];
                    const numericId = Number(requestId);
                    if (!Number.isNaN(numericId) && String(numericId) === requestId) {
                        idCandidates.push(numericId);
                    }

                    for (const idValue of idCandidates) {
                        const queried = await collection.where('id', '==', idValue).limit(1).get();
                        if (!queried.empty) {
                            docRef = queried.docs[0].ref;
                            snapshot = queried.docs[0];
                            break;
                        }
                    }
                }

                if (snapshot.exists) {
                    const base = snapshot.data() || {};
                    const merged = {
                        ...base,
                        ...updates,
                        updated_at: new Date().toISOString()
                    };
                    if (!merged.id) {
                        const numericId = Number(requestId);
                        merged.id = Number.isNaN(numericId) ? requestId : numericId;
                    }
                    if (!merged.ownerUid && ownerUid) {
                        merged.ownerUid = ownerUid;
                    }
                    await docRef.set(merged, { merge: true });

                    // Best-effort file cache sync
                    const requests = await this.readData('sign_requests');
                    const index = requests.findIndex(r => r.id === id || String(r.id) === requestId);
                    if (index > -1) {
                        requests[index] = { ...requests[index], ...merged };
                    } else {
                        requests.push(merged);
                    }
                    await this.writeData('sign_requests', requests);
                    return merged;
                }
            } catch (error) {
                logger.warn(`updateSignRequest Firestore failed id=${requestId} error=${error.message}`);
            }
        }

        // File fallback
        const requests = await this.readData('sign_requests');
        const index = requests.findIndex(r => r.id === id || String(r.id) === requestId);
        if (index > -1) {
            requests[index] = { ...requests[index], ...updates };
            if (this.useFirestore && ownerUid) {
                await this._firestoreSaveSignRequest(ownerUid, requests[index]);
            }
            await this.writeData('sign_requests', requests);
            return requests[index];
        }
        return null;
    }
}


module.exports = new DBService();
