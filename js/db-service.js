/**
 * DiffSense Simulated Database Service (localStorage based)
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
        // Force re-seed if contract count is low (to accommodate the new 50-item request)
        const currentContracts = JSON.parse(localStorage.getItem(this.KEYS.CONTRACTS) || '[]');
        if (!localStorage.getItem(this.KEYS.INITIALIZED) || currentContracts.length < 10) {
            console.log('Scaling Seed Data to 50+ items...');
            this._seed();
            localStorage.setItem(this.KEYS.INITIALIZED, 'true');
        }
    },

    _seed() {
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
            const risk = (i <= 5) ? "High" : risks[Math.floor(Math.random() * risks.length)]; // Ensure some High risks
            const status = (i <= 10) ? "未確認" : statuses[Math.floor(Math.random() * statuses.length)];

            // Random date in the last 12 months
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
                assignee_name: status === "確認済" ? assignees[Math.floor(Math.random() * assignees.length)] : "-"
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

        localStorage.setItem(this.KEYS.CONTRACTS, JSON.stringify(initialContracts));
        localStorage.setItem(this.KEYS.USERS, JSON.stringify(initialUsers));
        localStorage.setItem(this.KEYS.ACTIVITY_LOGS, JSON.stringify(initialLogs));
    },

    // --- Contract Methods ---
    getContracts() {
        return JSON.parse(localStorage.getItem(this.KEYS.CONTRACTS) || '[]');
    },

    getPaginatedContracts(page = 1, pageSize = 10, query = "") {
        let contracts = this.getContracts();

        // Filter
        if (query) {
            const q = query.toLowerCase();
            contracts = contracts.filter(c =>
                c.name.toLowerCase().includes(q) ||
                c.type.toLowerCase().includes(q) ||
                c.assignee_name.toLowerCase().includes(q)
            );
        }

        // Stats for pagination
        const totalItems = contracts.length;
        const totalPages = Math.ceil(totalItems / pageSize);

        // Sort by date (newest first)
        contracts.sort((a, b) => new Date(b.last_updated_at) - new Date(a.last_updated_at));

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
            assignee_name: "-"
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
        const contracts = this.getContracts();
        switch (type) {
            case 'pending':
                return contracts.filter(c => c.status === '未確認' || c.status === '未解析');
            case 'risk':
                return contracts.filter(c => c.risk_level === 'High' && c.status !== '確認済');
            case 'total':
                return contracts; // Sorted by recent in db
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
    }
};
