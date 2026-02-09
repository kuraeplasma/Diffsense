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
