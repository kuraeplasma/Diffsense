/**
 * DIFFsense Simulated Database Service (localStorage based)
 * Data is isolated per user (UID-based keys)
 */
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
        RECENT_DIFF: 'recent_diff'
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

    // Dynamic KEYS getter (with UID prefix)
    get KEYS() {
        const prefix = this._uid ? `diffsense_${this._uid}_` : 'diffsense_';
        return {
            CONTRACTS: `${prefix}contracts`,
            ACTIVITY_LOGS: `${prefix}logs`,
            USERS: `${prefix}users`,
            INITIALIZED: `${prefix}initialized`,
            DIFF_RESULTS: `${prefix}diff_results`,
            RECENT_DIFF: `${prefix}recent_diff`
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

    PLAN_LIMITS: {
        'starter': 1,
        'business': 3,
        'pro': 5
    },

    /**
     * Initialize DB if not already done
     */
    init() {
        // Migrate legacy data (no UID prefix) to current user if needed
        this._migrateLegacyData();

        const currentContracts = JSON.parse(localStorage.getItem(this.KEYS.CONTRACTS) || '[]');

        if (!localStorage.getItem(this.KEYS.INITIALIZED) && currentContracts.length === 0) {
            console.log('Initializing Seed Data...');
            this._seed();
            localStorage.setItem(this.KEYS.INITIALIZED, 'true');
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
            contracts = contracts.filter(c => c.status === status);
        }
        if (type !== "all") {
            contracts = contracts.filter(c => c.type === type);
        }

        // 3. Sorting
        if (sortBy === "date_desc") {
            contracts.sort((a, b) => new Date(b.last_updated_at) - new Date(a.last_updated_at));
        } else if (sortBy === "date_asc") {
            contracts.sort((a, b) => new Date(a.last_updated_at) - new Date(b.last_updated_at));
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
        return contracts.find(c => c.id === parseInt(id));
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

    getDiffResult(docAId, docBId) {
        const results = this.getDiffResults();
        return results.find((item) => item.docA_id === docAId && item.docB_id === docBId) || null;
    },

    saveDiffResult(payload) {
        const results = this.getDiffResults();
        const existingIndex = results.findIndex((item) => item.docA_id === payload.docA_id && item.docB_id === payload.docB_id);
        const nextValue = {
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

    touchRecentDiff(docAId, docBId) {
        const items = this.getRecentDiffs().filter((item) => !(item.docA === docAId && item.docB === docBId));
        items.unshift({
            docA: docAId,
            docB: docBId,
            last_viewed: new Date().toISOString()
        });
        localStorage.setItem(this.KEYS.RECENT_DIFF, JSON.stringify(items.slice(0, 20)));
    },

    updateContractStatus(id, status) {
        const contracts = this.getContracts();
        const contract = contracts.find(c => c.id === parseInt(id));
        if (contract) {
            contract.status = status;
            contract.last_updated_at = new Date().toISOString().split('T')[0];
            localStorage.setItem(this.KEYS.CONTRACTS, JSON.stringify(contracts));

            // Log this action
            this.addActivityLog(`ステータス更新 (${status})`, contract.name, "ユーザー", "成功");
            return true;
        }
        return false;
    },

    /**
     * Add a new contract (Monitoring Target)
     */
    addContract(data) {
        const contracts = this.getContracts();
        const newId = contracts.length > 0 ? Math.max(...contracts.map(c => c.id)) + 1 : 1;
        const newContract = {
            id: newId,
            name: data.name,
            type: data.type,
            last_updated_at: new Date().toISOString().split('T')[0],
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
        return newContract;
    },

    // --- Stats Method ---
    getStats() {
        const contracts = this.getContracts();

        // 1. Pending (未処理): Unconfirmed OR Not Analyzed
        const pending = contracts.filter(c => c.status === '未確認' || c.status === '未解析').length;

        // 2. Risk Review (リスク要確認): High Risk AND NOT Confirmed
        const highRisk = contracts.filter(c => c.risk_level === 'High' && c.status !== '確認済').length;

        // 3. Monitoring (監視中): Total managed contracts
        const total = contracts.length;

        return {
            pending,
            highRisk,
            total
        };
    },

    getFilteredContracts(type) {
        let contracts = [...this.getContracts()];
        // Sort by last_updated_at desc to show recent items first
        contracts.sort((a, b) => new Date(b.last_updated_at) - new Date(a.last_updated_at));

        switch (type) {
            case 'pending':
                return contracts.filter(c => c.status === '未確認' || c.status === '未解析');
            case 'risk':
                return contracts.filter(c => c.risk_level === 'High' && c.status !== '確認済');
            case 'total':
                return contracts; // Now sorted
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

    // --- AI Analysis Methods ---

    /**
     * テキスト抽出結果のみを保存（初回登録時）
     */
    updateContractText(id, data) {
        const contracts = this.getContracts();
        const contract = contracts.find(c => c.id === parseInt(id));
        if (contract) {
            // 抽出されたテキストを保存
            if (data.extractedText !== undefined) {
                contract.original_content = this.cloneContent(data.extractedText) || "（テキストデータを抽出できませんでした）";
                contract.extracted_text_hash = data.extractedTextHash;
                contract.extracted_text_length = data.extractedTextLength;
                contract.source_type = data.sourceType;
                contract.pdf_storage_path = data.pdfStoragePath;
                contract.pdf_url = data.pdfUrl;
                if (data.rawExtractedText !== undefined) {
                    contract.pdf_raw_text = data.rawExtractedText || '';
                }
            }

            // ステータスを更新
            contract.extract_status = 'success';
            contract.status = data.status || '未処理';
            contract.last_updated_at = new Date().toISOString().split('T')[0];

            localStorage.setItem(this.KEYS.CONTRACTS, JSON.stringify(contracts));
            this.addActivityLog('テキスト抽出完了', contract.name, 'system', '成功');
            return true;
        }
        return false;
    },

    /**
     * AI解析結果を契約に反映
     */
    updateContractAnalysis(id, analysisData) {
        const contracts = this.getContracts();
        const contract = contracts.find(c => c.id === parseInt(id));
        if (contract) {
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
                    date: contract.last_analyzed_at || contract.last_updated_at || new Date().toISOString().split('T')[0],
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
            if (analysisData.pdfUrl) {
                contract.pdf_url = analysisData.pdfUrl;
                contract.pdf_storage_path = analysisData.pdfStoragePath;
                contract.source_type = analysisData.sourceType || contract.source_type;
            }

            // ファイル名も更新（ある場合）
            if (analysisData.originalFilename) {
                contract.original_filename = analysisData.originalFilename;
            }
            if (analysisData.sourceUrl) {
                contract.source_url = analysisData.sourceUrl;
            }

            // リスクレベルを変換して保存
            if (analysisData.riskLevel !== undefined) {
                contract.risk_level = this.convertRiskLevel(analysisData.riskLevel);
            }

            // ステータスを更新
            contract.status = analysisData.status || '未確認';

            // AI解析結果を保存（新規フィールド）
            contract.ai_summary = analysisData.summary || '';
            contract.ai_risk_reason = analysisData.riskReason || '';
            contract.ai_changes = analysisData.changes || [];
            contract.last_analyzed_at = new Date().toISOString().split('T')[0];

            localStorage.setItem(this.KEYS.CONTRACTS, JSON.stringify(contracts));
            this.addActivityLog('AI解析完了', contract.name, 'system', '成功');
            return true;
        }
        return false;
    },

    /**
     * 数値リスクレベルを文字列に変換
     */
    convertRiskLevel(numericLevel) {
        if (numericLevel >= 3) return 'High';
        if (numericLevel === 2) return 'Medium';
        if (numericLevel === 1) return 'Low';
        return 'None';
    },

    /**
     * 定期監視のON/OFFを切り替える
     */
    toggleMonitoring(id, enabled) {
        const contracts = this.getContracts();
        const contract = contracts.find(c => c.id === parseInt(id));
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
        const contract = contracts.find(c => c.id === parseInt(id));
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
    }
};
