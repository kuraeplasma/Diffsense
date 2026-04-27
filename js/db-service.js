/**
 * DIFFsense Simulated Database Service (localStorage + Backend API)
 * Data is isolated per user (UID-based keys or Backend Auth)
 */
import { getIdToken } from './auth.js';
import { toApiUrl } from './api-base.js?v=20260321f';

const LOCAL_CACHE_VERSION = '20260310v2';

export const dbService = {
    // Current user UID (set on login)
    _uid: null,

    // Base key names (UID prefix added dynamically)
    _BASE_KEYS: {
        CONTRACTS: 'contracts',
        ACTIVITY_LOGS: 'logs',
        USERS: 'users',
        INITIALIZED: 'initialized',
        DIFF_RESULTS: 'diff_results',
        RECENT_DIFF: 'recent_diff',
        SIGN_REQUESTS: 'sign_requests'
    },

    cloneContent(value) {
        if (value === null || value === undefined) return value;
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            return value;
        }
        try {
            return JSON.parse(JSON.stringify(value));
        } catch {
            return value;
        }
    },

    contentSignature(value) {
        if (value === null || value === undefined) return '';
        if (typeof value === 'string') return value.trim();
        if (typeof value === 'number' || typeof value === 'boolean') return String(value);
        try {
            return JSON.stringify(value);
        } catch {
            return String(value);
        }
    },

    nowIso() {
        return new Date().toISOString();
    },

    toSortableTime(value) {
        const raw = String(value || '').trim();
        if (!raw) return 0;
        const normalized = /^\d{4}-\d{2}-\d{2}$/.test(raw)
            ? `${raw}T00:00:00`
            : /^\d{4}-\d{2}-\d{2}T\d{2}$/.test(raw)
                ? `${raw}:00:00`
                : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw)
                    ? `${raw}:00`
                    : raw.replace(' ', 'T');
        const parsed = new Date(normalized);
        return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
    },

    normalizeContractStatus(status) {
        const value = String(status || '').trim();
        if (value === '確認済') return '確認済み';
        return value;
    },

    isConfirmedStatus(status) {
        return this.normalizeContractStatus(status) === '確認済み';
    },
    // Dynamic KEYS getter (with UID prefix)
    get KEYS() {
        const prefix = this._uid ? `diffsense_${this._uid}_` : 'diffsense_';
        return {
            CONTRACTS: `${prefix}contracts`,
            ACTIVITY_LOGS: `${prefix}logs`,
            USERS: `${prefix}users`,
            INITIALIZED: `${prefix}initialized`,
            DIFF_RESULTS: `${prefix}diff_results_${LOCAL_CACHE_VERSION}`,
            RECENT_DIFF: `${prefix}recent_diff_${LOCAL_CACHE_VERSION}`,
            SIGN_REQUESTS: `${prefix}sign_requests`
        };
    },

    /**
     * Set current user UID for data isolation
     * Must be called before init() after login
     */
    setCurrentUser(uid) {
        this._uid = uid;
        console.log(`DB Service: User set to ${uid}`);
    },

    /**
     * Helper to call backend API with Firebase Auth
     */
    async _callApi(endpoint, method = 'GET', body = null, options = {}) {
        try {
            const fetchOptions = {
                method,
                headers: {
                    'Content-Type': 'application/json'
                }
            };

            const token = await getIdToken();
            if (token) {
                fetchOptions.headers.Authorization = `Bearer ${token}`;
            } else if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.hostname === '[::1]' || window.location.hostname.endsWith('.local') || window.location.hostname.startsWith('192.168.') || window.location.hostname.startsWith('10.')) {
                // Local/LAN development uses backend AUTH_BYPASS, so allow API access without Firebase login.
                console.warn(`API Call proceeding without authenticated user in local/LAN dev: ${endpoint}`);
            } else {
                console.error('API Call failed: No authenticated user');
                return null;
            }

            if (body) {
                fetchOptions.body = JSON.stringify(body);
            }

            const path = String(endpoint || '').trim();
            const candidates = [path];
            if (path.startsWith('/api/')) {
                candidates.push(path.replace(/^\/api/, ''));
            } else if (path.startsWith('/')) {
                candidates.push(`/api${path}`);
            }

            let lastError = null;
            for (let i = 0; i < candidates.length; i += 1) {
                const candidate = candidates[i];
                const url = toApiUrl(candidate);
                const response = await fetch(url, fetchOptions);
                const raw = await response.text();
                let result = {};
                try {
                    result = raw ? JSON.parse(raw) : {};
                } catch {
                    result = { error: raw || `API Error: ${response.status}` };
                }

                if (!response.ok) {
                    const message = String(result.error || `API Error: ${response.status}`);
                    const isEndpointNotFound = response.status === 404 && /endpoint not found/i.test(message);
                    const canRetry = isEndpointNotFound && i < candidates.length - 1;
                    if (canRetry) {
                        console.warn(`API fallback retry: ${candidate} -> ${candidates[i + 1]}`);
                        continue;
                    }
                    const error = new Error(message);
                    error.code = result.code || null;
                    error.status = response.status;
                    lastError = error;
                    break;
                }

                return result.data;
            }

            throw (lastError || new Error('API request failed'));
        } catch (error) {
            console.error(`API Call failed (${endpoint}):`, error);
            if (options.throwOnError) {
                throw error;
            }
            return null;
        }
    },

    PLAN_LIMITS: {
        'free': 1,
        'starter': 1,
        'business': 3,
        'pro': 5
    },
    init() {
        // Migrate legacy data (no UID prefix) to current user if needed
        this._migrateLegacyData();

        const currentContracts = JSON.parse(localStorage.getItem(this.KEYS.CONTRACTS) || '[]');

        if (!localStorage.getItem(this.KEYS.INITIALIZED) && currentContracts.length === 0) {
            console.log('Initializing Seed Data...');
            this._seed();
            localStorage.setItem(this.KEYS.INITIALIZED, 'true');
        }

        // Always seed signatures if missing, for restoration purposes
        if (!localStorage.getItem(this.KEYS.SIGN_REQUESTS)) {
            console.log('Restoring Signature Seed Data...');
            this._seedSignatures();
        }
    },


    /**
     * Migrate old non-UID data to the current user (one-time)
     */
    _migrateLegacyData() {
        if (!this._uid) return;
        const legacyKey = 'diffsense_contracts';
        const legacyData = localStorage.getItem(legacyKey);
        const userKey = this.KEYS.CONTRACTS;

        // Only migrate if legacy data exists AND user has no data yet
        if (legacyData && !localStorage.getItem(userKey)) {
            console.log('Migrating legacy data to user-scoped storage...');
            localStorage.setItem(userKey, legacyData);

            const legacyLogs = localStorage.getItem('diffsense_logs');
            if (legacyLogs) localStorage.setItem(this.KEYS.ACTIVITY_LOGS, legacyLogs);

            const legacyUsers = localStorage.getItem('diffsense_users');
            if (legacyUsers) localStorage.setItem(this.KEYS.USERS, legacyUsers);

            localStorage.setItem(this.KEYS.INITIALIZED, 'true');

            // Remove legacy keys to avoid re-migration
            localStorage.removeItem('diffsense_contracts');
            localStorage.removeItem('diffsense_logs');
            localStorage.removeItem('diffsense_users');
            localStorage.removeItem('diffsense_initialized');
            console.log('Legacy data migration complete.');
        }
    },

    _seed() {
        // Keep everything empty for a clean start
        localStorage.setItem(this.KEYS.CONTRACTS, JSON.stringify([]));
        localStorage.setItem(this.KEYS.USERS, JSON.stringify([]));
        localStorage.setItem(this.KEYS.ACTIVITY_LOGS, JSON.stringify([]));
        localStorage.setItem(this.KEYS.DIFF_RESULTS, JSON.stringify([]));
        localStorage.setItem(this.KEYS.RECENT_DIFF, JSON.stringify([]));
    },

    /**
     * Clear all local storage data associated with this app
     */
    clearAllData() {
        Object.values(this.KEYS).forEach(key => {
            localStorage.removeItem(key);
        });
        console.log('All local data cleared.');
    },

    // --- Contract Methods ---
    getContracts() {
        return JSON.parse(localStorage.getItem(this.KEYS.CONTRACTS) || '[]');
    },

    async syncContractsFromApi() {
        const apiData = await this._callApi('/api/contracts');
        if (Array.isArray(apiData)) {
            // ローカルキャッシュのoriginal_contentを保持（APIが返さない場合）
            const local = this.getContracts();
            const merged = apiData.map(remote => {
                const cached = local.find(c => String(c.id) === String(remote.id));
                if (cached && !remote.original_content && cached.original_content) {
                    return { ...remote, original_content: cached.original_content };
                }
                return remote;
            });
            localStorage.setItem(this.KEYS.CONTRACTS, JSON.stringify(merged));
            return merged;
        }
        return this.getContracts();
    },

    _mergeContractIntoCache(contract, tempId = null) {
        if (!contract) return;
        const contracts = this.getContracts();
        
        // 1. Try to find by tempId if provided (for new contracts)
        if (tempId) {
            const index = contracts.findIndex(c => String(c.id) === String(tempId));
            if (index >= 0) {
                contracts[index] = { ...contracts[index], ...contract };
                localStorage.setItem(this.KEYS.CONTRACTS, JSON.stringify(contracts));
                return;
            }
        }

        // 2. Try to find by authoritative ID
        const index = contracts.findIndex(c => String(c.id) === String(contract.id));
        if (index >= 0) {
            const existing = contracts[index];
            const merged = { ...existing, ...contract };
            // APIレスポンスがoriginal_contentを返さない場合はローカルキャッシュを保持
            if (!merged.original_content && existing.original_content) {
                merged.original_content = existing.original_content;
            }
            contracts[index] = merged;
        } else {
            contracts.unshift(contract);
        }
        localStorage.setItem(this.KEYS.CONTRACTS, JSON.stringify(contracts));
    },

    _persistContractToApi(contract, method = 'PATCH', tempId = null) {
        if (!contract?.id && !tempId) return;
        (async () => {
            try {
                const saved = await this.persistContractToApi(contract, method, { tempId });
                if (saved) {
                    this._mergeContractIntoCache(saved, tempId);
                }
            } catch (error) {
                console.warn('Contract sync failed:', error);
            }
        })();
    },

    async persistContractToApi(contract, method = 'PATCH', options = {}) {
        const id = contract?.id || options.tempId;
        if (!id && method !== 'POST') return null;
        
        const endpoint = method === 'POST' ? '/api/contracts' : `/api/contracts/${id}`;
        const saved = await this._callApi(endpoint, method, contract, options);
        if (saved) {
            this._mergeContractIntoCache(saved, options.tempId);
        }
        return saved;
    },

    getPaginatedContracts(page = 1, pageSize = 10, filters = {}) {
        let contracts = this.getContracts();
        const { query = "", risk = "all", status = "all", type = "all", sortBy = "date_desc" } = filters;

        // 1. Text Search
        if (query) {
            const q = query.toLowerCase();
            contracts = contracts.filter(c =>
                c.name.toLowerCase().includes(q) ||
                c.type.toLowerCase().includes(q) ||
                c.assignee_name.toLowerCase().includes(q)
            );
        }

        // 2. Multi-Filters
        if (risk !== "all") {
            contracts = contracts.filter(c => c.risk_level === risk);
        }
        if (status !== "all") {
            if (status === '未確認') {
                // UI表示（dashboard.js）のバッジと合わせ、「確認済み」以外はすべて「未確認」としてフィルタリングする
                contracts = contracts.filter(c => !this.isConfirmedStatus(c.status));
            } else if (this.isConfirmedStatus(status)) {
                contracts = contracts.filter(c => this.isConfirmedStatus(c.status));
            } else {
                const normalizedStatus = this.normalizeContractStatus(status);
                contracts = contracts.filter(c => this.normalizeContractStatus(c.status) === normalizedStatus);
            }
        }
        if (type !== "all") {
            contracts = contracts.filter(c => c.type === type);
        }

        // 3. Sorting
        if (sortBy === "date_desc") {
            contracts.sort((a, b) => this.toSortableTime(b.last_updated_at || b.last_analyzed_at || b.created_at) - this.toSortableTime(a.last_updated_at || a.last_analyzed_at || a.created_at));
        } else if (sortBy === "date_asc") {
            contracts.sort((a, b) => this.toSortableTime(a.last_updated_at || a.last_analyzed_at || a.created_at) - this.toSortableTime(b.last_updated_at || b.last_analyzed_at || b.created_at));
        } else if (sortBy === "name_asc") {
            contracts.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
        }

        // Stats for pagination
        const totalItems = contracts.length;
        const totalPages = Math.ceil(totalItems / pageSize);

        // Slice
        const start = (page - 1) * pageSize;
        const end = start + pageSize;
        const items = contracts.slice(start, end);

        return {
            items,
            totalItems,
            totalPages,
            currentPage: page
        };
    },

    getContractById(id) {
        const contracts = this.getContracts();
        return contracts.find(c => String(c.id) === String(id));
    },

    getDocumentsByContractId(id) {
        const contract = this.getContractById(id);
        if (!contract) return [];

        const docs = [];
        const baseName = contract.name || '契約書';
        const fileType = (contract.original_filename || '').split('.').pop() || contract.source_type || 'document';
        const history = Array.isArray(contract.history) ? contract.history : [];

        history.forEach((entry, index) => {
            docs.push({
                id: `contract-${contract.id}-hist-${entry.version ?? index + 1}`,
                contract_id: contract.id,
                document_name: entry.original_filename || `${baseName}_ver${entry.version ?? index + 1}`,
                file_type: fileType,
                uploaded_at: entry.date || contract.last_updated_at || '',
                user_id: this._uid || null,
                content: this.cloneContent(entry.content),
                version_label: `ver${entry.version ?? index + 1}`,
                sort_order: index + 1,
                is_current: false
            });
        });

        docs.push({
            id: `contract-${contract.id}-current`,
            contract_id: contract.id,
            document_name: contract.original_filename || baseName,
            file_type: fileType,
            uploaded_at: contract.last_analyzed_at || contract.last_updated_at || '',
            user_id: this._uid || null,
            content: this.cloneContent(contract.original_content),
            version_label: `ver${history.length + 1}`,
            sort_order: history.length + 1,
            is_current: true
        });

        return docs.filter((doc) => doc.content).sort((a, b) => a.sort_order - b.sort_order);
    },

    getDiffResults() {
        return JSON.parse(localStorage.getItem(this.KEYS.DIFF_RESULTS) || '[]');
    },

    getDiffResult(docAId, docBId, contractId = null) {
        const results = this.getDiffResults();
        return results.find((item) => {
            if (item.docA_id !== docAId || item.docB_id !== docBId) return false;
            if (contractId === null || contractId === undefined || contractId === '') return true;
            if (item.contract_id !== undefined && item.contract_id !== null) {
                return String(item.contract_id) === String(contractId);
            }
            return String(docAId).startsWith(`contract-${contractId}-`)
                && String(docBId).startsWith(`contract-${contractId}-`);
        }) || null;
    },

    saveDiffResult(payload) {
        const results = this.getDiffResults();
        const existingIndex = results.findIndex((item) => item.docA_id === payload.docA_id && item.docB_id === payload.docB_id);
        const nextValue = {
            contract_id: payload.contract_id || null,
            docA_id: payload.docA_id,
            docB_id: payload.docB_id,
            diff_data: payload.diff_data || {},
            created_at: payload.created_at || new Date().toISOString(),
            updated_at: new Date().toISOString()
        };
        if (existingIndex >= 0) {
            results[existingIndex] = { ...results[existingIndex], ...nextValue };
        } else {
            results.unshift(nextValue);
        }
        localStorage.setItem(this.KEYS.DIFF_RESULTS, JSON.stringify(results));
        return nextValue;
    },

    getRecentDiffs() {
        return JSON.parse(localStorage.getItem(this.KEYS.RECENT_DIFF) || '[]');
    },

    touchRecentDiff(docAId, docBId, contractId = null) {
        const items = this.getRecentDiffs().filter((item) => !(item.docA === docAId && item.docB === docBId));
        items.unshift({
            contract_id: contractId || null,
            docA: docAId,
            docB: docBId,
            last_viewed: new Date().toISOString()
        });
        localStorage.setItem(this.KEYS.RECENT_DIFF, JSON.stringify(items.slice(0, 20)));
    },

    updateContractStatus(id, status, options = {}) {
        const { skipRemotePersist = false, skipActivityLog = false } = options;
        const contracts = this.getContracts();
        const contract = contracts.find(c => String(c.id) === String(id));
        if (contract) {
            const normalizedStatus = this.normalizeContractStatus(status);
            contract.status = normalizedStatus;
            contract.last_updated_at = this.nowIso();
            localStorage.setItem(this.KEYS.CONTRACTS, JSON.stringify(contracts));
            if (!skipRemotePersist) {
                this._persistContractToApi(contract);
            }

            if (!skipActivityLog) {
                this.addActivityLog(`ステータス更新 (${normalizedStatus})`, contract.name, "ユーザー", "成功");
            }
            return true;
        }
        return false;
    },

    async updateContractStatusAndSync(id, status, options = {}) {
        const { retryCount = 1, rollbackOnSyncError = true } = options;
        const current = this.getContractById(id);
        if (!current) {
            return { ok: false, synced: false, error: new Error('Contract not found') };
        }

        const previousStatus = current.status;
        const previousUpdatedAt = current.last_updated_at;
        const normalizedStatus = this.normalizeContractStatus(status);

        const updated = this.updateContractStatus(id, normalizedStatus, {
            skipRemotePersist: true,
            skipActivityLog: true
        });
        if (!updated) {
            return { ok: false, synced: false, error: new Error('Contract not found') };
        }

        const currentContract = this.getContractById(id);
        let lastError = null;
        for (let attempt = 0; attempt <= retryCount; attempt += 1) {
            try {
                await this.persistContractToApi(currentContract, 'PATCH', { throwOnError: true });
                this.addActivityLog(`ステータス更新 (${normalizedStatus})`, currentContract.name, "ユーザー", "成功");
                return { ok: true, synced: true, contract: this.getContractById(id) || currentContract };
            } catch (error) {
                lastError = error;
            }
        }

        if (rollbackOnSyncError) {
            const contracts = this.getContracts();
            const rollbackTarget = contracts.find(c => String(c.id) === String(id));
            if (rollbackTarget) {
                rollbackTarget.status = previousStatus;
                rollbackTarget.last_updated_at = previousUpdatedAt || this.nowIso();
                localStorage.setItem(this.KEYS.CONTRACTS, JSON.stringify(contracts));
            }
        }
        this.addActivityLog(`ステータス更新 (${normalizedStatus})`, currentContract.name, "ユーザー", "失敗");
        return { ok: true, synced: false, error: lastError };
    },

    /**
     * Add a new contract (Monitoring Target)
     */
    addContract(data) {
        const contracts = this.getContracts();
        const newId = Date.now();
        const newContract = {
            id: newId,
            name: data.name,
            type: data.type,
            created_at: this.nowIso(),
            last_updated_at: this.nowIso(),
            risk_level: 'None', // "未判定"
            status: '未解析',  // "未解析"
            assignee_name: "-",
            original_content: "",
            source_url: data.sourceUrl || "",
            original_filename: data.originalFilename || "",
            // Crawling / Monitoring fields
            monitoring_enabled: data.monitoring_enabled || false,
            last_checked_at: null,
            last_hash: null,
            stable_count: 0
        };
        contracts.unshift(newContract); // Add to top
        localStorage.setItem(this.KEYS.CONTRACTS, JSON.stringify(contracts));
        this.addActivityLog("新規登録", data.name, "ユーザー", "成功");
        this._persistContractToApi(newContract, 'POST', newId);
        return newContract;
    },

    isPendingContract(contract) {
        const status = String(contract?.status || '').trim();
        return !status || status === '未解析' || status === '未処理' || status === '未確認' || status === '登録失敗';
    },

    isMonitoringContract(contract) {
        return !this.isPendingContract(contract);
    },

    // --- Stats Method ---
    getStats() {
        const contracts = this.getContracts();

        // 1. Pending (未処理): Unconfirmed OR Not Analyzed
        const pending = contracts.filter(c => this.isPendingContract(c)).length;

        // 2. Risk Review (リスク要確認): High Risk AND NOT Confirmed
        const highRisk = contracts.filter(c => c.risk_level === 'High' && !this.isConfirmedStatus(c.status)).length;

        // 3. Monitoring (監視中): 差分チェック未実施を除外
        const total = contracts.filter(c => this.isMonitoringContract(c)).length;

        return {
            pending,
            highRisk,
            total
        };
    },

    getFilteredContracts(type) {
        let contracts = [...this.getContracts()];
        // Sort by last_updated_at desc to show recent items first
        contracts.sort((a, b) => this.toSortableTime(b.last_updated_at || b.last_analyzed_at || b.created_at) - this.toSortableTime(a.last_updated_at || a.last_analyzed_at || a.created_at));

        switch (type) {
            case 'pending':
                return contracts.filter(c => this.isPendingContract(c));
            case 'risk':
                return contracts.filter(c => c.risk_level === 'High' && !this.isConfirmedStatus(c.status));
            case 'total':
                return contracts.filter(c => this.isMonitoringContract(c)); // Now sorted
            default:
                return contracts;
        }
    },

    // --- Log Methods ---
    getActivityLogs() {
        return JSON.parse(localStorage.getItem(this.KEYS.ACTIVITY_LOGS) || '[]');
    },

    addActivityLog(action, target_name, actor = "ユーザー", status = "成功") {
        const logs = this.getActivityLogs();
        const now = new Date();
        const newLog = {
            id: Date.now(),
            action,
            target_name,
            actor,
            status, // 成功 / 失敗 / スキップ
            created_at: now.toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(/\//g, '-'),
            timestamp: now.getTime()
        };
        logs.unshift(newLog); // Newest first
        localStorage.setItem(this.KEYS.ACTIVITY_LOGS, JSON.stringify(logs));
    },

    /**
     * プランに応じた保持期間でログをクリーンアップ
     */
    cleanupLogs(plan = 'starter') {
        const logs = this.getActivityLogs();
        const now = Date.now();

        const retentionDays = {
            'free': 30,
            'starter': 30,
            'business': 90,
            'pro': 365
        };

        const days = retentionDays[plan] || 30;
        const cutoff = now - (days * 24 * 60 * 60 * 1000);

        const filteredLogs = logs.filter(log => {
            // timestampがない古いログは、created_atから推測するか、安全のため残す/消す
            if (!log.timestamp) return true;
            return log.timestamp > cutoff;
        });

        if (filteredLogs.length !== logs.length) {
            console.log(`Cleaned up ${logs.length - filteredLogs.length} old logs for plan: ${plan}`);
            localStorage.setItem(this.KEYS.ACTIVITY_LOGS, JSON.stringify(filteredLogs));
        }
        return filteredLogs;
    },

    // --- User Methods ---
    getUsers() {
        return JSON.parse(localStorage.getItem(this.KEYS.USERS) || '[]');
    },

    updateUserRole(email, newRole) {
        const users = this.getUsers();
        const user = users.find(u => u.email === email);
        if (user) {
            user.role = newRole;
            localStorage.setItem(this.KEYS.USERS, JSON.stringify(users));
            this.addActivityLog(`権限変更 (${newRole})`, user.name, "管理者", "成功");
            return true;
        }
        return false;
    },

    addUser(name, email, role, currentPlan = 'starter') {
        const users = this.getUsers();
        if (users.find(u => u.email === email)) {
            return { success: false, error: 'already_exists' };
        }

        const limit = this.PLAN_LIMITS[currentPlan] || 1;
        if (users.length >= limit) {
            return { success: false, error: 'limit_reached', limit };
        }

        const newUser = {
            id: Date.now(),
            name,
            email,
            role,
            last_active_at: "-"
        };
        users.push(newUser);
        localStorage.setItem(this.KEYS.USERS, JSON.stringify(users));
        this.addActivityLog("メンバー追加", name, "管理者", "成功");
        return { success: true };
    },

    updateUser(email, data) {
        const users = this.getUsers();
        const user = users.find(u => u.email === email);
        if (user) {
            if (data.name) user.name = data.name;
            if (data.role) user.role = data.role;
            localStorage.setItem(this.KEYS.USERS, JSON.stringify(users));
            this.addActivityLog("メンバー情報更新", user.name, "管理者", "成功");
            return true;
        }
        return false;
    },

    deleteUser(email) {
        let users = this.getUsers();
        const user = users.find(u => u.email === email);
        if (user) {
            // Prevent deleting the last admin or self (simplified logic)
            // if (user.role === '管理者') return false; 

            users = users.filter(u => u.email !== email);
            localStorage.setItem(this.KEYS.USERS, JSON.stringify(users));
            this.addActivityLog("メンバー削除", user.name, "管理者", "成功");
            return true;
        }
        return false;
    },

    // --- MCP Methods ---
    async getMcpApiKey() {
        return await this._callApi('/api/user/mcp-key');
    },

    async generateMcpApiKey() {
        return await this._callApi('/api/user/mcp-key', 'POST');
    },

    // --- AI Analysis Methods ---

    /**
     * テキスト抽出結果のみを保存（初回登録時）
     */
    updateContractText(id, data) {
        const contracts = this.getContracts();
        const contract = contracts.find(c => String(c.id) === String(id));
        if (contract) {
            const sourceType = String(data.sourceType || '').toUpperCase();

            // 抽出されたテキストを保存
            if (data.extractedText !== undefined) {
                contract.original_content = this.cloneContent(data.extractedText) || "（テキストデータを抽出できませんでした）";
                contract.extracted_text_hash = data.extractedTextHash;
                contract.extracted_text_length = data.extractedTextLength;
                contract.source_type = sourceType || data.sourceType;
                contract.pdf_storage_path = sourceType === 'DOCX' ? null : data.pdfStoragePath;
                contract.pdf_url = sourceType === 'DOCX' ? null : data.pdfUrl;
                if (data.rawExtractedText !== undefined) {
                    contract.pdf_raw_text = data.rawExtractedText || '';
                }
                if (data.doc && typeof data.doc === 'object') {
                    contract.doc_type = data.doc.type || sourceType || null;
                    contract.doc_size = Number(data.doc.size || 0) || 0;
                } else if (sourceType === 'DOCX') {
                    contract.doc_type = 'docx';
                    contract.doc_size = Number(data.extractedTextLength || 0) || 0;
                }
                if (sourceType === 'DOCX') {
                    contract.original_file_path = null;
                }
            }

            // ステータスを更新
            // 解析・差分データがあれば保存
            if (data.ai_changes) contract.ai_changes = data.ai_changes;
            if (data.summary) contract.summary = data.summary;
            if (data.ai_summary) contract.ai_summary = data.ai_summary;
            if (data.risk_level) contract.risk_level = data.risk_level;
            if (data.ai_risk_reason) contract.ai_risk_reason = data.ai_risk_reason;
            if (data.contract_meta) contract.contract_meta = data.contract_meta;
            if (data.ai_succeeded !== undefined) contract.ai_succeeded = data.ai_succeeded;

            contract.extract_status = 'success';
            contract.status = data.status || '未処理';
            contract.last_updated_at = this.nowIso();

            localStorage.setItem(this.KEYS.CONTRACTS, JSON.stringify(contracts));
            this._persistContractToApi(contract);
            this.addActivityLog('テキスト抽出完了', contract.name, 'system', '成功');
            return true;
        }
        return false;
    },

    /**
     * AI解析結果を契約に反映
     */
    updateContractAnalysis(id, analysisData, options = {}) {
        const contracts = this.getContracts();
        const contract = contracts.find(c => String(c.id) === String(id));
        if (contract) {
            const sourceType = String(analysisData.sourceType || '').toUpperCase();
            const incomingContent = this.cloneContent(analysisData.extractedText);
            const hasIncomingContent = incomingContent !== undefined && incomingContent !== null && this.contentSignature(incomingContent).length > 0;
            const currentSignature = this.contentSignature(contract.original_content);
            const incomingSignature = hasIncomingContent ? this.contentSignature(incomingContent) : '';
            const shouldBumpVersion = Boolean(hasIncomingContent && currentSignature && incomingSignature && incomingSignature !== currentSignature);

            // バージョン保存 (新しい本文がある場合のみ履歴に追加)
            if (shouldBumpVersion) {
                if (!contract.history) contract.history = [];
                contract.history.push({
                    version: contract.history.length + 1,
                    date: contract.last_analyzed_at || contract.last_updated_at || this.nowIso(),
                    content: this.cloneContent(contract.original_content),
                    original_filename: contract.original_filename || contract.name || '',
                    pdf_storage_path: contract.pdf_storage_path, // PDFパスも一応残すが、実体は削除される前提
                    pdf_url: null // 古いPDFは見れない
                });
            }

            // 抽出されたテキストを保存
            if (hasIncomingContent) {
                contract.original_content = incomingContent;
            }
            if (analysisData.rawExtractedText !== undefined) {
                contract.pdf_raw_text = analysisData.rawExtractedText || '';
            }

            // PDF情報も更新（新バージョン取り込み時）
            if (Object.prototype.hasOwnProperty.call(analysisData, 'pdfUrl')) {
                contract.pdf_url = analysisData.pdfUrl || null;
                contract.pdf_storage_path = analysisData.pdfStoragePath || null;
            }
            if (sourceType) {
                contract.source_type = sourceType;
            }
            if (sourceType === 'DOCX') {
                contract.pdf_url = null;
                contract.pdf_storage_path = null;
            }

            // 元のDOCX/PDFファイルパスを保存（docx-preview/PDFビューア用）
            if (Object.prototype.hasOwnProperty.call(analysisData, 'originalFilePath')) {
                contract.original_file_path = analysisData.originalFilePath || null;
            } else if (sourceType === 'DOCX') {
                contract.original_file_path = null;
            }
            if (analysisData.doc && typeof analysisData.doc === 'object') {
                contract.doc_type = analysisData.doc.type || sourceType || contract.doc_type || null;
                contract.doc_size = Number(analysisData.doc.size || 0) || 0;
            } else if (sourceType === 'DOCX') {
                contract.doc_type = 'docx';
                contract.doc_size = Number(analysisData.extractedTextLength || 0) || 0;
            }

            // ファイル名も更新（ある場合）
            if (analysisData.originalFilename) {
                contract.original_filename = analysisData.originalFilename;
            }
            if (analysisData.sourceUrl) {
                contract.source_url = analysisData.sourceUrl;
            }

            // リスクレベルを変換して保存
            if (analysisData.riskLevel !== undefined || analysisData.risk_level !== undefined) {
                const rl = analysisData.riskLevel !== undefined ? analysisData.riskLevel : analysisData.risk_level;
                contract.risk_level = this.convertRiskLevel(rl);
            }

            // ステータスを更新
            contract.status = analysisData.status || '未確認';

            // AI解析結果を保存
            contract.ai_summary = analysisData.summary || analysisData.ai_summary || '';
            contract.ai_risk_reason = analysisData.riskReason || analysisData.ai_risk_reason || '';
            contract.ai_changes = analysisData.changes || analysisData.ai_changes || [];
            contract.ai_is_fallback = analysisData.isFallback === true || analysisData.is_fallback === true;

            // 期限情報（contract_meta）を保存
            const metaSource = (analysisData.contract_meta && typeof analysisData.contract_meta === 'object')
                ? analysisData.contract_meta
                : analysisData;
            const pickMeta = (key) => {
                if (Object.prototype.hasOwnProperty.call(analysisData, key)) return analysisData[key];
                if (metaSource && Object.prototype.hasOwnProperty.call(metaSource, key)) return metaSource[key];
                return undefined;
            };
            const expiryDate = pickMeta('expiry_date');
            const renewalDeadline = pickMeta('renewal_deadline');
            const contractStart = pickMeta('contract_start');
            const autoRenewal = pickMeta('auto_renewal');
            const noticePeriodDays = pickMeta('notice_period_days');
            const contractCategory = pickMeta('contract_category');
            const dateConfidence = pickMeta('date_confidence');
            if (expiryDate !== undefined) contract.expiry_date = expiryDate || null;
            if (renewalDeadline !== undefined) contract.renewal_deadline = renewalDeadline || null;
            if (contractStart !== undefined) contract.contract_start = contractStart || null;
            if (autoRenewal !== undefined) contract.auto_renewal = (autoRenewal === null) ? null : (autoRenewal === true);
            if (noticePeriodDays !== undefined) {
                const numericNotice = Number(noticePeriodDays);
                contract.notice_period_days = Number.isFinite(numericNotice) ? numericNotice : null;
            }
            if (contractCategory !== undefined) contract.contract_category = contractCategory || null;
            if (dateConfidence !== undefined) contract.date_confidence = dateConfidence || 'unknown';
             
            // フラグの強制Boolean化
            contract.ai_succeeded = Boolean(analysisData.aiSucceeded !== undefined ? analysisData.aiSucceeded : analysisData.ai_succeeded);
            contract.ai_limited = Boolean(analysisData.isLimited !== undefined ? analysisData.isLimited : (analysisData.is_limited || analysisData.ai_limited));
            
            // 解析タイムスタンプの更新
            // isAnalysisUpdate が false でない限り（解析APIが呼ばれたとみなされる場合）は必ず更新する
            if (options.isAnalysisUpdate !== false) {
                contract.last_analyzed_at = this.nowIso();
            }
            contract.last_updated_at = this.nowIso();

            localStorage.setItem(this.KEYS.CONTRACTS, JSON.stringify(contracts));
            this._persistContractToApi(contract);

            if (shouldBumpVersion) {
                const latestHistory = Array.isArray(contract.history) && contract.history.length > 0
                    ? contract.history[contract.history.length - 1]
                    : null;
                const historyVersion = latestHistory?.version ?? contract.history?.length;
                if (latestHistory && historyVersion) {
                    this.saveDiffResult({
                        contract_id: contract.id,
                        docA_id: `contract-${contract.id}-hist-${historyVersion}`,
                        docB_id: `contract-${contract.id}-current`,
                        diff_data: {
                            summary: analysisData.summary || '',
                            riskLevel: analysisData.riskLevel,
                            riskReason: analysisData.riskReason || '',
                            changes: Array.isArray(analysisData.changes) ? analysisData.changes : [],
                            isFallback: analysisData.isFallback === true,
                            aiFailed: analysisData.aiFailed === true
                        },
                        created_at: new Date().toISOString()
                    });
                }
            }

            this.addActivityLog('AI解析完了', contract.name, 'system', '成功');
            return true;
        }
        return false;
    },

    /**
     * 数値リスクレベルを文字列に変換
     */
    convertRiskLevel(value) {
        if (value === null || value === undefined) return 'None';
        
        // すでに正規化された文字列ラベルの場合
        if (typeof value === 'string') {
            const normalized = value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
            if (['High', 'Medium', 'Low', 'None'].includes(normalized)) return normalized;
            
            // 数値文字列 "3", "2", "1" の場合
            const num = parseInt(value, 10);
            if (!isNaN(num)) return this.convertRiskLevel(num);
            return 'None';
        }
        
        if (value >= 3) return 'High';
        if (value === 2) return 'Medium';
        if (value === 1) return 'Low';
        return 'None';
    },

    /**
     * 定期監視のON/OFFを切り替える
     */
    toggleMonitoring(id, enabled) {
        const contracts = this.getContracts();
        const contract = contracts.find(c => String(c.id) === String(id));
        if (contract) {
            contract.monitoring_enabled = enabled;
            localStorage.setItem(this.KEYS.CONTRACTS, JSON.stringify(contracts));
            this.addActivityLog(`定期監視 ${enabled ? '開始' : '停止'}`, contract.name, "ユーザー", "成功");
            return true;
        }
        return false;
    },

    /**
     * クローリング結果を保存
     */
    updateCrawlResult(id, data) {
        const contracts = this.getContracts();
        const contract = contracts.find(c => String(c.id) === String(id));
        if (contract) {
            contract.last_checked_at = data.checkedAt;
            contract.last_hash = data.newHash;

            if (data.changed) {
                contract.status = 'リスク要確認';
                contract.original_content = data.text;
                contract.stable_count = 0;
            } else {
                contract.stable_count = (contract.stable_count || 0) + 1;
            }

            localStorage.setItem(this.KEYS.CONTRACTS, JSON.stringify(contracts));
            return true;
        }
        return false;
    },

    /**
     * Signature Request Methods (Async API-based)
     */
    async getSignRequests() {
        // Try API first
        const apiData = await this._callApi('/api/sign/list');
        if (apiData) {
            // Update local cache
            localStorage.setItem(this.KEYS.SIGN_REQUESTS, JSON.stringify(apiData));
            return apiData;
        }
        // Fallback to local
        return JSON.parse(localStorage.getItem(this.KEYS.SIGN_REQUESTS) || '[]');
    },

    async addSignRequest(data, options = {}) {
        const recipients = Array.isArray(data?.recipients) ? data.recipients.filter(Boolean) : [];
        const shouldCreateLocalDraft = recipients.length === 0;

        if (shouldCreateLocalDraft) {
            const requests = JSON.parse(localStorage.getItem(this.KEYS.SIGN_REQUESTS) || '[]');
            const newRequest = {
                id: Date.now(),
                created_at: new Date().toISOString(),
                status: 'pending',
                recipients: [],
                ...data
            };
            requests.unshift(newRequest);
            localStorage.setItem(this.KEYS.SIGN_REQUESTS, JSON.stringify(requests));
            this.addActivityLog('署名依頼ドラフト作成', newRequest.document_name || '未命名書類', 'user', '成功');
            return newRequest;
        }

        try {
            const result = await this._callApi('/api/sign/create', 'POST', data, options);
            if (result) {
                const requests = JSON.parse(localStorage.getItem(this.KEYS.SIGN_REQUESTS) || '[]');
                requests.unshift(result);
                localStorage.setItem(this.KEYS.SIGN_REQUESTS, JSON.stringify(requests));
                this.addActivityLog('署名依頼作成', result.document_name, 'user', '成功');
                return result;
            }
        } catch (error) {
            console.warn('API addSignRequest failed, falling back to local mock:', error);
            if (options.throwOnError && window.location.hostname !== 'localhost') {
                throw error;
            }
        }

        // Local fallback for dev/local testing
        const requests = JSON.parse(localStorage.getItem(this.KEYS.SIGN_REQUESTS) || '[]');
        const mockRequest = {
            id: 'local-' + Date.now(),
            created_at: new Date().toISOString(),
            status: 'sent',
            ...data
        };
        requests.unshift(mockRequest);
        localStorage.setItem(this.KEYS.SIGN_REQUESTS, JSON.stringify(requests));
        this.addActivityLog('署名依頼作成 (ローカル模擬)', mockRequest.document_name || '未命名書類', 'user', '成功');
        return mockRequest;
    },

    async getEmbeddedSignUrl(requestId, actionId) {
        const result = await this._callApi(`/api/sign/embed/${requestId}/${actionId}`);
        return result ? result.url : null;
    },

    async updateSignRequest(id, data, options = {}) {
        try {
            const result = await this._callApi(`/api/sign/${id}`, 'PATCH', data, options);
            if (result) {
                // Also update local cache
                const requests = JSON.parse(localStorage.getItem(this.KEYS.SIGN_REQUESTS) || '[]');
                const index = requests.findIndex(r => String(r.id) === String(id));
                if (index !== -1) {
                    requests[index] = { ...requests[index], ...result, updated_at: new Date().toISOString() };
                    localStorage.setItem(this.KEYS.SIGN_REQUESTS, JSON.stringify(requests));
                }
                return result;
            }
        } catch (error) {
            console.warn('API updateSignRequest failed, using local fallback:', error);
            if (options.throwOnError && window.location.hostname !== 'localhost') {
                throw error;
            }
        }

        const requests = JSON.parse(localStorage.getItem(this.KEYS.SIGN_REQUESTS) || '[]');
        const index = requests.findIndex(r => String(r.id) === String(id));
        if (index !== -1) {
            requests[index] = { ...requests[index], ...data, updated_at: new Date().toISOString() };
            localStorage.setItem(this.KEYS.SIGN_REQUESTS, JSON.stringify(requests));
            return requests[index];
        }
        return null;
    },

    async remindSignRequest(id) {
        const result = await this._callApi(`/api/sign/${id}/remind`, 'POST', {});
        if (result) {
            const requests = JSON.parse(localStorage.getItem(this.KEYS.SIGN_REQUESTS) || '[]');
            const index = requests.findIndex(r => String(r.id) === String(id));
            if (index !== -1 && result.request) {
                requests[index] = { ...requests[index], ...result.request };
                localStorage.setItem(this.KEYS.SIGN_REQUESTS, JSON.stringify(requests));
            }
            return result;
        }
        return null;
    },

    deleteSignRequest(id) {
        let requests = JSON.parse(localStorage.getItem(this.KEYS.SIGN_REQUESTS) || '[]');
        requests = requests.filter(r => String(r.id) !== String(id));
        localStorage.setItem(this.KEYS.SIGN_REQUESTS, JSON.stringify(requests));
        return true;
    },

    _seedSignatures() {
        // 資料をすべて削除する要望に対応し、サンプルデータは投入しない
        localStorage.setItem(this.KEYS.SIGN_REQUESTS, JSON.stringify([]));
        return;
        const seedData = [
            {
                id: 101,
                document_name: '業務委託契約書_202403.pdf',
                sender: '山田 太郎',
                recipients: [
                    { name: '田中 実', email: 'tanaka@example.com', status: 'completed' },
                    { name: '佐藤 健', email: 'sato@example.com', status: 'pending' }
                ],
                status: 'pending',
                created_at: '2024-03-15T10:00:00Z'
            },
            {
                id: 102,
                document_name: '秘密保持契約書(NDA).pdf',
                sender: '山田 太郎',
                recipients: [
                    { name: '鈴木 一郎', email: 'suzuki@example.com', status: 'completed' }
                ],
                status: 'completed',
                created_at: '2024-03-10T14:30:00Z'
            }
        ];
        localStorage.setItem(this.KEYS.SIGN_REQUESTS, JSON.stringify(seedData));
    }
};
