/**
 * DIFFsense Simulated Database Service (localStorage based)
 */
export const dbService = {
    // Key names for localStorage
    KEYS: {
        CONTRACTS: 'diffsense_contracts',
        ACTIVITY_LOGS: 'diffsense_logs',
        USERS: 'diffsense_users',
        INITIALIZED: 'diffsense_initialized'
    },

    /**
     * Initialize DB if not already done
     */
    init() {
        const currentContracts = JSON.parse(localStorage.getItem(this.KEYS.CONTRACTS) || '[]');

        // データが全くない場合のみシードデータを投入する
        // (以前は count < 10 で強制リセットしていたため、ユーザーが追加したデータが消えていた可能性あり)
        if (!localStorage.getItem(this.KEYS.INITIALIZED) && currentContracts.length === 0) {
            console.log('Initializing Seed Data...');
            this._seed();
            localStorage.setItem(this.KEYS.INITIALIZED, 'true');
        }
    },

    _seed() {
        // Keep everything empty for a clean start
        localStorage.setItem(this.KEYS.CONTRACTS, JSON.stringify([]));
        localStorage.setItem(this.KEYS.USERS, JSON.stringify([]));
        localStorage.setItem(this.KEYS.ACTIVITY_LOGS, JSON.stringify([]));
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

    updateContractStatus(id, status) {
        const contracts = this.getContracts();
        const contract = contracts.find(c => c.id === parseInt(id));
        if (contract) {
            contract.status = status;
            contract.last_updated_at = new Date().toISOString().split('T')[0];
            localStorage.setItem(this.KEYS.CONTRACTS, JSON.stringify(contracts));

            // Log this action
            this.addActivityLog(`ステータス更新 (${status})`, contract.name, "ユーザー");
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
            original_filename: data.originalFilename || ""
        };
        contracts.unshift(newContract); // Add to top
        localStorage.setItem(this.KEYS.CONTRACTS, JSON.stringify(contracts));
        this.addActivityLog("新規登録", data.name, "ユーザー");
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

    addActivityLog(action, target_name, actor = "ユーザー") {
        const logs = this.getActivityLogs();
        const newLog = {
            id: Date.now(),
            action,
            target_name,
            actor,
            created_at: new Date().toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(/\//g, '-')
        };
        logs.unshift(newLog); // Newest first
        localStorage.setItem(this.KEYS.ACTIVITY_LOGS, JSON.stringify(logs.slice(0, 100))); // Keep last 100
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
            this.addActivityLog(`権限変更 (${newRole})`, user.name, "管理者");
            return true;
        }
        return false;
    },

    addUser(name, email, role) {
        const users = this.getUsers();
        if (users.find(u => u.email === email)) {
            return false; // Email already exists
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
        this.addActivityLog("メンバー追加", name, "管理者");
        return true;
    },

    updateUser(email, data) {
        const users = this.getUsers();
        const user = users.find(u => u.email === email);
        if (user) {
            if (data.name) user.name = data.name;
            if (data.role) user.role = data.role;
            localStorage.setItem(this.KEYS.USERS, JSON.stringify(users));
            this.addActivityLog("メンバー情報更新", user.name, "管理者");
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
            this.addActivityLog("メンバー削除", user.name, "管理者");
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
                contract.original_content = data.extractedText || "（テキストデータを抽出できませんでした）";
                contract.extracted_text_hash = data.extractedTextHash;
                contract.extracted_text_length = data.extractedTextLength;
                contract.source_type = data.sourceType;
                contract.pdf_storage_path = data.pdfStoragePath;
                contract.pdf_url = data.pdfUrl;
            }

            // ステータスを更新
            contract.extract_status = 'success';
            contract.status = data.status || '未処理';
            contract.last_updated_at = new Date().toISOString().split('T')[0];

            localStorage.setItem(this.KEYS.CONTRACTS, JSON.stringify(contracts));
            this.addActivityLog('テキスト抽出完了', contract.name, 'system');
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
            // バージョン保存 (履歴に追加)
            if (contract.original_content) {
                if (!contract.history) contract.history = [];
                contract.history.push({
                    version: contract.history.length + 1,
                    date: contract.last_analyzed_at || contract.last_updated_at || new Date().toISOString().split('T')[0],
                    content: contract.original_content,
                    pdf_storage_path: contract.pdf_storage_path, // PDFパスも一応残すが、実体は削除される前提
                    pdf_url: null // 古いPDFは見れない
                });
            }

            // 抽出されたテキストを保存
            if (analysisData.extractedText) {
                contract.original_content = analysisData.extractedText;
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
            this.addActivityLog('AI解析完了', contract.name, 'system');
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
    }
};
