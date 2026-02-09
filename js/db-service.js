/**
 * DIFFsense Database Service (LocalStorage + Backend Sync)
 */
export const dbService = {
    // Key names for localStorage
    KEYS: {
        CONTRACTS: 'diffsense_contracts',
        ACTIVITY_LOGS: 'diffsense_logs',
        USERS: 'diffsense_users',
        INITIALIZED: 'diffsense_initialized'
    },

    API_BASE: 'http://localhost:3001/api/db',

    /**
     * Initialize DB if not already done
     */
    async init() {
        console.log('Initializing DB Service...');

        try {
            // 1. Fetch data from backend
            const [contractsRes, logsRes, usersRes] = await Promise.all([
                fetch(`${this.API_BASE}/contracts`),
                fetch(`${this.API_BASE}/activity_logs`),
                fetch(`${this.API_BASE}/users`)
            ]);

            const contractsData = await contractsRes.json();
            const logsData = await logsRes.json();
            const usersData = await usersRes.json();

            let contracts = contractsData.data || [];
            let logs = logsData.data || [];
            let users = usersData.data || [];

            // 2. If backend is empty, check localStorage or Seed
            if (contracts.length === 0) {
                const localContracts = JSON.parse(localStorage.getItem(this.KEYS.CONTRACTS) || '[]');
                if (localContracts.length > 0) {
                    console.log('Syncing LocalStorage to Backend...');
                    contracts = localContracts;
                    // Sync initial data (best effort)
                    await this.syncToBackend('contracts', contracts);
                } else {
                    console.log('Backend empty, seeding data...');
                    const seedData = this._getSeedData();
                    contracts = seedData.contracts;
                    logs = seedData.logs;
                    users = seedData.users;

                    await Promise.all([
                        this.syncToBackend('contracts', contracts),
                        this.syncToBackend('activity_logs', logs),
                        this.syncToBackend('users', users)
                    ]);
                }
            }

            // 3. Update LocalStorage (Source of Truth for UI)
            localStorage.setItem(this.KEYS.CONTRACTS, JSON.stringify(contracts));
            localStorage.setItem(this.KEYS.ACTIVITY_LOGS, JSON.stringify(logs));
            localStorage.setItem(this.KEYS.USERS, JSON.stringify(users));
            localStorage.setItem(this.KEYS.INITIALIZED, 'true');

            console.log('DB Initialized & Synced');

        } catch (error) {
            console.error('DB Init Error (Backend might be down):', error);
            // Fallback to LocalStorage if backend fails
            const currentContracts = JSON.parse(localStorage.getItem(this.KEYS.CONTRACTS) || '[]');
            if (currentContracts.length === 0 && !localStorage.getItem(this.KEYS.INITIALIZED)) {
                this._seed(); // Use legacy sync seed
            }
        }
    },

    async syncToBackend(collection, data) {
        try {
            await fetch(`${this.API_BASE}/${collection}/bulk`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
        } catch (e) {
            console.error(`Sync error for ${collection}:`, e);
        }
    },

    async saveItemToBackend(collection, item) {
        try {
            // Background sync, don't await strictly for UI
            fetch(`${this.API_BASE}/${collection}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(item)
            }).catch(e => console.error(`Save error for ${collection}:`, e));
        } catch (e) {
            console.error(`Save error for ${collection}:`, e);
        }
    },

    async deleteItemFromBackend(collection, id) {
        try {
            fetch(`${this.API_BASE}/${collection}/${id}`, {
                method: 'DELETE'
            }).catch(e => console.error(`Delete error for ${collection}:`, e));
        } catch (e) {
            console.error(`Delete error for ${collection}:`, e);
        }
    },

    _getSeedData() {
        const contractTypes = ["利用規約", "業務委託契約書", "秘密保持契約書", "賃貸借契約書", "雇用契約書", "代理店契約書", "ライセンス契約書", "売買契約書"];
        const companies = ["株式会社ABC", "合同会社XYZ", "TechFrontier Inc.", "日本システムソリューション", "グローバル通商", "未来創造パートナーズ", "デジタルエッジ", "スマートライフ開発"];
        const assignees = ["山田 太郎", "鈴木 一郎", "佐藤 花子", "田中 次郎", "伊藤 博", "渡辺 健"];
        const risks = ["High", "Medium", "Low", "None"];
        const statuses = ["未確認", "確認済"];

        const initialContracts = [];

        // Generate 50 items
        for (let i = 1; i <= 50; i++) {
            const type = contractTypes[Math.floor(Math.random() * contractTypes.length)];
            const company = companies[Math.floor(Math.random() * companies.length)];
            const name = `${type} (${company}) - v${(i % 3) + 1}.0`;
            const risk = (i <= 5) ? "High" : risks[Math.floor(Math.random() * risks.length)];
            const status = (i <= 10) ? "未確認" : statuses[Math.floor(Math.random() * statuses.length)];

            const date = new Date();
            date.setDate(date.getDate() - Math.floor(Math.random() * 365));
            const dateStr = date.toISOString().split('T')[0];

            initialContracts.push({
                id: i,
                name: name,
                type: type,
                last_updated_at: dateStr,
                risk_level: risk,
                status: status,
                assignee_name: status === "確認済" ? assignees[Math.floor(Math.random() * assignees.length)] : "-",
                original_content: `
<h1 style="text-align:center; font-size:20px; margin-bottom:40px;">${type}</h1>
<p style="text-align:right; margin-bottom:20px;">締結日：2025年12月15日</p>
<p>${company}（以下「甲」という）と、SpaceGleam株式会社（以下「乙」という）は、乙が甲に対して提供するサービスに関して、以下の通り契約を締結する。</p>
<h3 style="margin-top:30px; border-bottom:1px solid #333; display:inline-block; padding-bottom:2px;">第1条（目的）</h3>
<p>本契約は、甲および乙の間における本件業務（${type}）の円滑な遂行を目的とし、双方が誠実に履行することを合意するものである。</p>
<p style="margin-top:50px; text-align:center; color:#999;">[以下、条項が続きます...]</p>
                `.trim()
            });
        }

        const initialUsers = [
            { id: 101, name: "山田 太郎", email: "taro@example.com", role: "管理者", last_active_at: "2026-01-30 18:45" },
            { id: 102, name: "鈴木 一郎", email: "ichiro@example.com", role: "承認者", last_active_at: "2026-01-29 11:20" },
            { id: 103, name: "佐藤 花子", email: "hanako@example.com", role: "閲覧のみ", last_active_at: "2026-01-30 09:00" },
        ];

        const initialLogs = [
            { id: Date.now() - 10000, action: "解析完了", target_name: "クラウドサービス利用規約", actor: "system", created_at: "2026-01-30 09:15" },
            { id: Date.now() - 20000, action: "メンバー追加", target_name: "佐藤 花子", actor: "管理者", created_at: "2026-01-29 09:00" },
        ];

        return { contracts: initialContracts, users: initialUsers, logs: initialLogs };
    },

    _seed() {
        const data = this._getSeedData();
        localStorage.setItem(this.KEYS.CONTRACTS, JSON.stringify(data.contracts));
        localStorage.setItem(this.KEYS.USERS, JSON.stringify(data.users));
        localStorage.setItem(this.KEYS.ACTIVITY_LOGS, JSON.stringify(data.logs));
        localStorage.setItem(this.KEYS.INITIALIZED, 'true');
    },

    // --- Contract Methods ---
    getContracts() {
        return JSON.parse(localStorage.getItem(this.KEYS.CONTRACTS) || '[]');
    },

    getPaginatedContracts(page = 1, pageSize = 10, filters = {}) {
        let contracts = this.getContracts();
        const { query = "", risk = "all", status = "all", type = "all", sortBy = "date_desc" } = filters;

        if (query) {
            const q = query.toLowerCase();
            contracts = contracts.filter(c =>
                c.name.toLowerCase().includes(q) ||
                c.type.toLowerCase().includes(q) ||
                c.assignee_name.toLowerCase().includes(q)
            );
        }

        if (risk !== "all") contracts = contracts.filter(c => c.risk_level === risk);
        if (status !== "all") contracts = contracts.filter(c => c.status === status);
        if (type !== "all") contracts = contracts.filter(c => c.type === type);

        if (sortBy === "date_desc") contracts.sort((a, b) => new Date(b.last_updated_at) - new Date(a.last_updated_at));
        else if (sortBy === "date_asc") contracts.sort((a, b) => new Date(a.last_updated_at) - new Date(b.last_updated_at));
        else if (sortBy === "name_asc") contracts.sort((a, b) => a.name.localeCompare(b.name, 'ja'));

        const totalItems = contracts.length;
        const totalPages = Math.ceil(totalItems / pageSize);
        const start = (page - 1) * pageSize;
        const end = start + pageSize;
        const items = contracts.slice(start, end);

        return { items, totalItems, totalPages, currentPage: page };
    },

    getContractById(id) {
        return this.getContracts().find(c => c.id === parseInt(id));
    },

    updateContractStatus(id, status) {
        const contracts = this.getContracts();
        const contract = contracts.find(c => c.id === parseInt(id));
        if (contract) {
            contract.status = status;
            localStorage.setItem(this.KEYS.CONTRACTS, JSON.stringify(contracts));

            // Sync to backend
            this.saveItemToBackend('contracts', contract);

            this.addActivityLog(`ステータス更新 (${status})`, contract.name, "ユーザー");
            return true;
        }
        return false;
    },

    addContract(data) {
        const contracts = this.getContracts();
        const newId = contracts.length > 0 ? Math.max(...contracts.map(c => c.id)) + 1 : 1;
        const newContract = {
            id: newId,
            name: data.name,
            type: data.type,
            last_updated_at: new Date().toISOString().replace('T', ' ').split('.')[0],
            risk_level: 'None',
            status: '未解析',
            assignee_name: "-",
            original_content: "",
            source_url: data.sourceUrl || "",
            original_filename: data.originalFilename || ""
        };
        contracts.unshift(newContract);
        localStorage.setItem(this.KEYS.CONTRACTS, JSON.stringify(contracts));

        // Sync to backend
        this.saveItemToBackend('contracts', newContract);

        this.addActivityLog("新規登録", data.name, "ユーザー");
        return newContract;
    },

    // --- Stats Method ---
    getStats() {
        const contracts = this.getContracts();
        const pending = contracts.filter(c => c.status === '未確認' || c.status === '未解析').length;
        const highRisk = contracts.filter(c => c.risk_level === 'High' && c.status !== '確認済').length;
        const total = contracts.length;
        return { pending, highRisk, total };
    },

    getFilteredContracts(type) {
        const contracts = this.getContracts();
        switch (type) {
            case 'pending': return contracts.filter(c => c.status === '未確認' || c.status === '未解析');
            case 'risk': return contracts.filter(c => c.risk_level === 'High' && c.status !== '確認済');
            case 'total': return contracts;
            default: return contracts;
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
        logs.unshift(newLog);
        localStorage.setItem(this.KEYS.ACTIVITY_LOGS, JSON.stringify(logs.slice(0, 100)));

        // Sync (Fire and forget)
        this.saveItemToBackend('activity_logs', newLog);
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

            // Sync
            this.saveItemToBackend('users', user);

            this.addActivityLog(`権限変更 (${newRole})`, user.name, "管理者");
            return true;
        }
        return false;
    },

    addUser(name, email, role) {
        const users = this.getUsers();
        const newUser = {
            id: Date.now(),
            name,
            email,
            role,
            last_active_at: "-"
        };
        users.push(newUser);
        localStorage.setItem(this.KEYS.USERS, JSON.stringify(users));

        // Sync
        this.saveItemToBackend('users', newUser);

        this.addActivityLog("メンバー追加", name, "管理者");
        return true;
    },

    // --- AI Analysis Methods ---

    updateContractText(id, data) {
        const contracts = this.getContracts();
        const contract = contracts.find(c => c.id === parseInt(id));
        if (contract) {
            if (data.extractedText !== undefined) {
                contract.original_content = data.extractedText || "（テキストデータを抽出できませんでした）";
                contract.extracted_text_hash = data.extractedTextHash;
                contract.extracted_text_length = data.extractedTextLength;
                contract.source_type = data.sourceType;
                contract.pdf_storage_path = data.pdfStoragePath;
                contract.pdf_url = data.pdfUrl;
            }

            contract.extract_status = 'success';
            contract.status = data.status || '未処理';
            contract.last_updated_at = new Date().toISOString().replace('T', ' ').split('.')[0];

            localStorage.setItem(this.KEYS.CONTRACTS, JSON.stringify(contracts));

            // Sync
            this.saveItemToBackend('contracts', contract);

            this.addActivityLog('テキスト抽出完了', contract.name, 'system');
            return true;
        }
        return false;
    },

    updateContractAnalysis(id, analysisData) {
        const contracts = this.getContracts();
        const contract = contracts.find(c => c.id === parseInt(id));
        if (contract) {
            // Versioning
            if (contract.original_content) {
                if (!contract.history) contract.history = [];
                contract.history.push({
                    version: contract.history.length + 1,
                    date: contract.last_analyzed_at || contract.last_updated_at || new Date().toISOString().split('T')[0],
                    content: contract.original_content,
                    pdf_storage_path: contract.pdf_storage_path,
                    pdf_url: null
                });
            }

            if (analysisData.extractedText) contract.original_content = analysisData.extractedText;
            if (analysisData.pdfUrl) {
                contract.pdf_url = analysisData.pdfUrl;
                contract.pdf_storage_path = analysisData.pdfStoragePath;
                contract.source_type = analysisData.sourceType || contract.source_type;
            }
            if (analysisData.originalFilename) contract.original_filename = analysisData.originalFilename;
            if (analysisData.sourceUrl) contract.source_url = analysisData.sourceUrl;
            if (analysisData.riskLevel !== undefined) contract.risk_level = this.convertRiskLevel(analysisData.riskLevel);

            contract.status = analysisData.status || '未確認';
            contract.ai_summary = analysisData.summary || '';
            contract.ai_risk_reason = analysisData.riskReason || '';
            contract.ai_changes = analysisData.changes || [];
            contract.last_analyzed_at = new Date().toISOString().replace('T', ' ').split('.')[0];
            contract.last_updated_at = contract.last_analyzed_at;

            localStorage.setItem(this.KEYS.CONTRACTS, JSON.stringify(contracts));

            // Sync
            this.saveItemToBackend('contracts', contract);

            this.addActivityLog('AI解析完了', contract.name, 'system');
            return true;
        }
        return false;
    },

    convertRiskLevel(numericLevel) {
        if (numericLevel >= 3) return 'High';
        if (numericLevel === 2) return 'Medium';
        if (numericLevel === 1) return 'Low';
        return 'None';
    },

};

window.dbService = dbService;
