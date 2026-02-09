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
        const needsUpdate = currentContracts.length > 0 && !currentContracts[0].original_content.includes('</h1>');

        if (!localStorage.getItem(this.KEYS.INITIALIZED) || currentContracts.length < 10 || needsUpdate) {
            console.log('Updating Seed Data to HTML format...');
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
                assignee_name: status === "確認済" ? assignees[Math.floor(Math.random() * assignees.length)] : "-",
                original_content: `
<h1 style="text-align:center; font-size:20px; margin-bottom:40px;">${type}</h1>

<p style="text-align:right; margin-bottom:20px;">締結日：2025年12月15日</p>

<p>${company}（以下「甲」という）と、SpaceGleam株式会社（以下「乙」という）は、乙が甲に対して提供するサービスに関して、以下の通り契約を締結する。</p>

<h3 style="margin-top:30px; border-bottom:1px solid #333; display:inline-block; padding-bottom:2px;">第1条（目的）</h3>
<p>本契約は、甲および乙の間における本件業務（${type}）の円滑な遂行を目的とし、双方が誠実に履行することを合意するものである。</p>

<h3 style="margin-top:30px; border-bottom:1px solid #333; display:inline-block; padding-bottom:2px;">第2条（個別契約）</h3>
<p>個別の業務に関する詳細（業務内容、期間、委託料等）については、別途甲乙間で締結する個別契約または注文書・請書によって定めるものとする。</p>

<h3 style="margin-top:30px; border-bottom:1px solid #333; display:inline-block; padding-bottom:2px;">第3条（善管注意義務）</h3>
<p>乙は、本件業務の遂行にあたり、善良なる管理者の注意をもって業務を遂行し、甲の指示を遵守するものとする。</p>

<h3 style="margin-top:30px; border-bottom:1px solid #333; display:inline-block; padding-bottom:2px;">第4条（秘密保持）</h3>
<p>甲および乙は、本契約の履行過程で知り得た相手方の機密情報を、相手方の事前の書面による承諾なく、第三者に開示または漏洩してはならない。</p>

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

        localStorage.setItem(this.KEYS.CONTRACTS, JSON.stringify(initialContracts));
        localStorage.setItem(this.KEYS.USERS, JSON.stringify(initialUsers));
        localStorage.setItem(this.KEYS.ACTIVITY_LOGS, JSON.stringify(initialLogs));
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
            original_content: `
<h1 style="text-align:center; font-size:20px; margin-bottom:40px;">${data.name}</h1>

<p style="text-align:right; margin-bottom:20px;">登録日：${new Date().toLocaleDateString('ja-JP')}</p>

<p>本ドキュメントは、システムによって解析の対象として指定された原本データの内容を再現したものです。</p>

<h3 style="margin-top:30px; border-bottom:1px solid #333; display:inline-block; padding-bottom:2px;">第1条（適用範囲）</h3>
<p>本規定は、${data.name}（以下「本ドキュメント」）における${data.type}に関連するすべての取引および行為に適用されるものとします。</p>

<h3 style="margin-top:30px; border-bottom:1px solid #333; display:inline-block; padding-bottom:2px;">第2条（情報の取り扱い）</h3>
<p>ユーザーから提供された情報の取り扱いについては、乙が別途定めるプライバシーポリシーに従うものとし、本件業務の遂行に必要な範囲内で使用されるものとします。</p>

<h3 style="margin-top:30px; border-bottom:1px solid #333; display:inline-block; padding-bottom:2px;">第3条（保証の制限）</h3>
<p>提供されるサービスおよび情報について、その正確性、完全性、最新性を保証するものではなく、現状有姿での提供となります。</p>

<p style="margin-top:50px; text-align:center; color:#999;">[PDF/URLから抽出されたテキストデータがここに表示されます]</p>
            `.trim()
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
