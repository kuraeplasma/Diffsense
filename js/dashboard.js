import { dbService } from './db-service.js';

// --- Static Content (Still used for UI structure/details) ---
const STATIC_CONTENT = {
    diffDetails: {
        1: {
            title: "クラウドサービス利用規約 (SaaS) - 2026.01.29版",
            summary: "サービス提供事業者が「損害賠償の上限」を「利用料の3ヶ月分」から「1ヶ月分」に縮小する変更を行いました。また、データバックアップの保証条項が削除されています。",
            riskLevel: 3,
            riskReason: "損害賠償額の大幅な減額およびデータ保全義務の免責が含まれており、当社にとって著しく不利な変更であるため。",
            changes: [
                {
                    type: "modification",
                    section: "第15条（損害賠償）",
                    old: "甲が乙に支払う損害賠償の額は、当該損害が発生した月の利用料金の【3ヶ月分】を上限とする。",
                    new: "甲が乙に支払う損害賠償の額は、当該損害が発生した月の利用料金の【1ヶ月分】を上限とする。"
                },
                {
                    type: "deletion",
                    section: "第18条（データの保全）",
                    old: "当社は、ユーザーのデータを毎日1回バックアップし、障害発生時には直近のバックアップ地点まで復旧するものとします。",
                    new: "(削除されました)"
                }
            ]
        }
    }
};

// --- View Renderers ---
const Views = {
    // 1. Dashboard Overview
    dashboard: () => {
        const stats = dbService.getStats();
        const currentFilter = app.dashboardFilter || 'pending';
        const filteredItems = dbService.getFilteredContracts(currentFilter);

        // Dynamic Title
        let sectionTitle = "要確認アイテム (優先度順)";
        if (currentFilter === 'pending') sectionTitle = "未処理のアイテム (新着・変更検知)";
        if (currentFilter === 'risk') sectionTitle = "リスク要判定アイテム";
        if (currentFilter === 'total') sectionTitle = "全監視対象（最新順）";

        const tableRows = filteredItems.length > 0 ? filteredItems.slice(0, 10).map(c => {
            // Risk Badge logic
            let riskBadgeClass = 'badge-neutral';
            if (c.risk_level === 'High') riskBadgeClass = 'badge-danger';
            else if (c.risk_level === 'Medium') riskBadgeClass = 'badge-warning';
            else if (c.risk_level === 'Low') riskBadgeClass = 'badge-success';

            // Status Badge logic
            let statusBadge = '';
            if (c.status === '未解析') statusBadge = '<span class="badge badge-info">未解析 (新規)</span>';
            else if (c.status === '未確認') statusBadge = '<span class="badge badge-warning">要確認 (変更)</span>';
            else if (c.status === '確認済') statusBadge = '<span class="badge badge-neutral"><i class="fa-solid fa-check"></i> 確認済</span>';

            return `
                <tr onclick="app.navigate('diff', ${c.id})">
                    <td><span class="badge ${riskBadgeClass}">${c.risk_level}</span></td>
                    <td class="col-name" title="${c.name}">${c.name}</td>
                    <td>${c.last_updated_at}</td>
                    <td>${statusBadge}</td>
                    <td><button class="btn-dashboard">${c.status === '確認済' ? '履歴を見る' : '確認する'}</button></td>
                </tr>
            `;
        }).join('') : '<tr><td colspan="5" class="text-center text-muted" style="padding:40px;">該当するアイテムはありません</td></tr>';

        return `
            <div class="stats-grid">
                <div class="stat-card ${currentFilter === 'pending' ? 'active' : ''}" onclick="app.setDashboardFilter('pending')">
                    <div class="stat-label ${currentFilter === 'pending' ? 'text-warning' : ''}"><i class="fa-regular fa-square-check"></i> 未処理</div>
                    <div class="stat-value">${stats.pending}件</div>
                </div>
                <div class="stat-card ${currentFilter === 'risk' ? 'active' : ''}" onclick="app.setDashboardFilter('risk')">
                    <div class="stat-label ${currentFilter === 'risk' ? 'text-danger' : ''}"><i class="fa-solid fa-triangle-exclamation"></i> リスク要判定</div>
                    <div class="stat-value">${stats.highRisk}件</div>
                </div>
                <div class="stat-card ${currentFilter === 'total' ? 'active' : ''}" onclick="app.setDashboardFilter('total')">
                    <div class="stat-label"><i class="fa-solid fa-satellite-dish"></i> 監視中</div>
                    <div class="stat-value text-muted">${stats.total}</div>
                </div>
            </div>

            <h3 id="dashboard-section-title" style="font-size:16px; margin-bottom:16px; font-weight:600;">${sectionTitle}</h3>
            <div class="table-container">
                <table class="data-table dashboard-table">
                    <thead>
                        <tr>
                            <th>リスク</th>
                            <th>契約・規約名</th>
                            <th>日付</th>
                            <th>ステータス</th>
                            <th>アクション</th>
                        </tr>
                    </thead>
                    <tbody id="dashboard-table-body">
                        ${tableRows}
                    </tbody>
                </table>
            </div>
        `;
    },

    // 2. Contract List
    contracts: (params) => {
        const page = params?.page || 1;
        const query = params?.query || "";
        const pageSize = 10;

        const { items, totalPages, totalItems } = dbService.getPaginatedContracts(page, pageSize, query);

        const rows = items.map(c => {
            let riskBadge = '';
            if (c.risk_level === 'High') riskBadge = '<span class="badge badge-danger">High</span>';
            else if (c.risk_level === 'Medium') riskBadge = '<span class="badge badge-warning">Med</span>';
            else if (c.risk_level === 'Low') riskBadge = '<span class="badge badge-success">Low</span>';
            else riskBadge = '<span class="badge badge-neutral">No</span>';

            const statusBadge = c.status === '確認済'
                ? '<span class="badge badge-neutral"><i class="fa-solid fa-check"></i> 確認済</span>'
                : '<span class="badge badge-warning">未確認</span>';

            return `
                <tr onclick="app.navigate('diff', ${c.id})">
                    <td class="col-name" title="${c.name}">${c.name}</td>
                    <td>${c.type}</td>
                    <td>${c.last_updated_at}</td>
                    <td>${riskBadge}</td>
                    <td>${statusBadge}</td>
                    <td>${c.assignee_name}</td>
                </tr>
            `;
        }).join('');

        return `
            <div class="flex justify-between items-center mb-md">
                <h2 class="page-title" style="margin-bottom:0;">契約・規約管理</h2>
                <div class="flex gap-sm">
                   <div style="position:relative;">
                        <i class="fa-solid fa-magnifying-glass" style="position:absolute; left:12px; top:50%; transform:translateY(-50%); color:#999;"></i>
                        <input type="text" id="contract-search" placeholder="契約名・種別・担当者で検索..." 
                               value="${query}"
                               style="padding:8px 12px 8px 36px; border:1px solid #ddd; border-radius:4px; width:300px; font-size:13px;"
                               oninput="app.searchContracts(this.value)">
                   </div>
                   <button class="btn-dashboard" onclick="app.exportCSV()"><i class="fa-solid fa-download"></i> CSV出力</button>
                </div>
            </div>

            <div class="table-container">
                <table class="data-table contracts-table">
                    <thead>
                        <tr>
                            <th>契約・規約名</th>
                            <th>種別</th>
                            <th>最終更新</th>
                            <th>リスク</th>
                            <th>状態</th>
                            <th>担当者</th>
                        </tr>
                    </thead>
                    <tbody>${rows || '<tr><td colspan="6" class="text-center text-muted" style="padding:40px;">該当する契約が見つかりませんでした</td></tr>'}</tbody>
                </table>
            </div>

            <div class="flex justify-between items-center mt-md">
                <div class="text-muted" style="font-size:13px;">全 ${totalItems} 件中 ${(page - 1) * pageSize + 1}〜${Math.min(page * pageSize, totalItems)} 件を表示</div>
                <div class="flex gap-sm">
                    <button class="btn-dashboard" ${page <= 1 ? 'disabled' : ''} onclick="app.changePage(${page - 1})">前へ</button>
                    <div style="display:flex; align-items:center; padding:0 12px; font-size:13px; font-weight:600;">${page} / ${totalPages || 1}</div>
                    <button class="btn-dashboard" ${page >= totalPages ? 'disabled' : ''} onclick="app.changePage(${page + 1})">次へ</button>
                </div>
            </div>
`;
    },

    // 3. Diff Details
    diff: (id) => {
        const contract = dbService.getContractById(id);
        const diffData = STATIC_CONTENT.diffDetails[id] || {
            title: `${contract.name} - 詳細分析`,
            summary: "このドキュメントの最新の変更要約をAIが生成しています...",
            riskLevel: contract.risk_level === 'High' ? 3 : (contract.risk_level === 'Medium' ? 2 : 1),
            riskReason: "特定の変更箇所において、リスク要因が検知されました。詳細を確認してください。",
            changes: [
                {
                    type: "modification",
                    section: "一般条項",
                    old: "従前の規定がここに表示されます。",
                    new: "新しい規定がここに表示されます。"
                }
            ]
        };

        const changesHtml = diffData.changes.map(c => `
            <div style="margin-bottom: 24px; border:1px solid #eee; border-radius:4px; overflow:hidden;">
                <div style="background:#f0f0f0; padding:8px 12px; font-weight:600; font-size:12px; border-bottom:1px solid #eee;">
                    ${c.section} <span style="font-weight:normal; color:#666; margin-left:8px;">(${c.type === 'modification' ? '変更' : '削除'})</span>
                </div>
                <div class="diff-container" style="height:auto; min-height:100px;">
                    <div class="diff-pane diff-left"><span class="diff-del">${c.old}</span></div>
                    <div class="diff-pane diff-right"><span class="diff-add">${c.new}</span></div>
                </div>
            </div>
    `).join('');

        return `
            <div style="margin-bottom:16px;">
                <a onclick="app.navigate('dashboard')" style="color:#666; font-size:12px; cursor:pointer;"><i class="fa-solid fa-arrow-left"></i> ダッシュボードに戻る</a>
            </div>
            
            <div class="flex justify-between items-start mb-md">
                <div>
                     <h2 class="page-title" style="margin-bottom:8px;">${diffData.title}</h2>
                     <div class="flex gap-sm">
                        <span class="badge ${contract.risk_level === 'High' ? 'badge-danger' : 'badge-warning'}">Risk Level: ★${diffData.riskLevel}</span>
                        <span class="badge ${contract.status === '確認済' ? 'badge-neutral' : 'badge-warning'}">${contract.status}</span>
                     </div>
                </div>
                <div class="flex gap-sm">
                    <button class="btn-dashboard"><i class="fa-solid fa-share-nodes"></i> 共有</button>
                    ${contract.status === '未確認'
                ? `<button class="btn-dashboard btn-primary-action" onclick="app.confirmContract(${id})"><i class="fa-solid fa-check"></i> 確認済みにする</button>`
                : `<button class="btn-dashboard" disabled><i class="fa-solid fa-check"></i> 確認済み</button>`}
                </div>
            </div>

            <!-- AI Summary -->
            <div class="ai-summary">
                <div class="risk-level ${contract.risk_level === 'High' ? 'text-danger' : 'text-warning'}"><i class="fa-solid fa-robot"></i> AIリスク判定：${contract.risk_level === 'High' ? '要警戒' : '要確認'}</div>
                <p style="margin-bottom:12px; font-weight:600;">${diffData.riskReason}</p>
                <p class="text-muted">${diffData.summary}</p>
            </div>

            <div style="margin-bottom:16px; font-weight:600;">検知された変更箇所</div>
            ${changesHtml}

            <!-- Memos -->
            <div style="margin-top:32px; padding-top:24px; border-top:1px solid #eee;">
                <h3 style="font-size:14px; margin-bottom:12px;">社内メモ</h3>
                <textarea id="memo-input" style="width:100%; border:1px solid #ddd; padding:8px; border-radius:4px; font-family:inherit;" rows="3" placeholder="確認事項や法務部への相談内容を入力..."></textarea>
                <button class="btn-dashboard mt-md" onclick="app.addMemo(${id})">メモを追加</button>
            </div>
`;
    },

    // 4. History
    history: () => {
        const logs = dbService.getActivityLogs();
        const rows = logs.map(h => `
            <tr>
                <td>${h.created_at}</td>
                <td class="col-name" title="${h.target_name}">${h.target_name}</td>
                <td><span class="badge badge-success">${h.action}</span></td>
                <td>${h.actor}</td>
                <td><button class="btn-dashboard" style="padding:2px 8px; font-size:11px;" onclick="alert('詳細ログ機能は開発中です')">詳細</button></td>
            </tr>
    `).join('');

        return `
            <h2 class="page-title">解析ログ・監査履歴</h2>
            <div class="table-container">
                <table class="data-table history-table">
                    <thead>
                        <tr>
                            <th>日時</th>
                            <th>対象</th>
                            <th>結果/操作</th>
                            <th>実行者</th>
                            <th>操作</th>
                        </tr>
                    </thead>
                    <tbody>${rows || '<tr><td colspan="5" class="text-center text-muted">履歴はありません</td></tr>'}</tbody>
                </table>
            </div>
`;
    },

    // 5. Team
    team: () => {
        const users = dbService.getUsers();
        const rows = users.map(m => `
            <tr>
                <td class="col-name" title="${m.name}">${m.name}</td>
                <td>${m.email}</td>
                <td>
                    <select onchange="app.updateUserRole('${m.email}', this.value)" style="border:1px solid #ddd; padding:4px; border-radius:4px;">
                        <option value="管理者" ${m.role === '管理者' ? 'selected' : ''}>管理者</option>
                        <option value="承認者" ${m.role === '承認者' ? 'selected' : ''}>承認者</option>
                        <option value="閲覧のみ" ${m.role === '閲覧のみ' ? 'selected' : ''}>閲覧のみ</option>
                    </select>
                </td>
                <td>${m.last_active_at}</td>
                <td><button class="btn-dashboard" onclick="alert('編集機能は開発中です')">編集</button></td>
            </tr>
    `).join('');

        return `
            <div class="flex justify-between items-center mb-md">
                <h2 class="page-title" style="margin-bottom:0;">チーム管理</h2>
                <button class="btn-dashboard btn-primary-action" onclick="app.showInviteModal()"><i class="fa-solid fa-user-plus"></i> メンバー招待</button>
            </div>
    <div class="table-container">
        <table class="data-table team-table">
            <thead>
                <tr>
                    <th>名前</th>
                    <th>メールアドレス</th>
                    <th>権限</th>
                    <th>最終アクティブ</th>
                    <th>操作</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
    </div>
`;
    }
};

// --- Registration Flow Logic ---
class RegistrationFlow {
    constructor(app) {
        this.app = app;
        this.modal = document.getElementById('registration-modal');
        this.modalBody = document.getElementById('modal-body');
        this.modalTitle = document.getElementById('modal-title');
        this.fileInput = document.getElementById('reg-file-input');
        this.currentStep = 1;
        this.tempData = {};
    }

    init() {
        const openBtn = document.getElementById('open-registration-btn');
        const closeBtn = document.getElementById('close-registration-modal');

        if (openBtn) openBtn.onclick = () => this.open();
        if (closeBtn) closeBtn.onclick = () => this.close();

        // Close on overlay click
        this.modal.onclick = (e) => {
            if (e.target === this.modal) this.close();
        };

        // Handle File Input Change
        if (this.fileInput) {
            this.fileInput.onchange = (e) => this.handleFileSelect(e.target.files[0]);
        }
    }

    open() {
        this.currentStep = 1;
        this.tempData = {};
        this.modal.classList.add('active');
        this.renderStep();
    }

    close() {
        this.modal.classList.remove('active');
        if (this.fileInput) this.fileInput.value = ''; // Reset file input
    }

    renderStep() {
        if (this.currentStep === 1) {
            this.modalTitle.textContent = "新規登録 - 登録方法の選択";
            this.modalBody.innerHTML = `
                <p class="reg-step-title">監視対象（契約書・規約）の追加方法を選んでください</p>
                <div class="reg-method-card" id="reg-card-pdf">
                    <div class="reg-method-icon"><i class="fa-solid fa-file-pdf"></i></div>
                    <div class="reg-method-info">
                        <h4>PDFをアップロード</h4>
                        <p>ファイルをここにドロップするか、クリックして選択</p>
                    </div>
                </div>
                <div class="reg-method-card" onclick="app.registration.nextStep(2, {method: 'url'})">
                    <div class="reg-method-icon"><i class="fa-solid fa-globe"></i></div>
                    <div class="reg-method-info">
                        <h4>URLを登録 (Web規約)</h4>
                        <p>公開URLを監視対象に設定します</p>
                    </div>
                </div>
            `;
            this.bindCardEvents();
        } else if (this.currentStep === 2) {
            const isPdf = this.tempData.method === 'pdf';
            const methodLabel = isPdf ? 'アップロードされたファイル' : '監視対象のURL';
            const sourceVal = isPdf ? (this.tempData.fileName || '選択済み') : "";
            const defaultName = this.tempData.fileName ? this.tempData.fileName.replace(/\.[^/.]+$/, "") : "";

            this.modalBody.innerHTML = `
                <div class="form-group">
                    <label>管理名 (必須)</label>
                    <input type="text" id="reg-name" class="form-control" placeholder="例: 利用規約 (2026年版)" value="${defaultName}">
                </div>
                <div class="form-group">
                    <label>種別</label>
                    <select id="reg-type" class="form-control">
                        <option value="利用規約">利用規約</option>
                        <option value="NDA">NDA (秘密保持契約)</option>
                        <option value="業務委託契約">業務委託契約</option>
                        <option value="プライバシーポリシー">プライバシーポリシー</option>
                        <option value="その他">その他</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>${methodLabel}</label>
                    <input type="text" id="reg-source" class="form-control" 
                        placeholder="${isPdf ? '' : 'https://example.com/terms'}" 
                        value="${sourceVal}" 
                        ${isPdf ? 'readonly style="background:#f5f5f5; cursor:not-allowed;"' : ''}>
                </div>
                <div class="reg-actions">
                    <button class="btn-dashboard" onclick="app.registration.nextStep(1)">戻る</button>
                    <button class="btn-dashboard btn-primary-action" onclick="app.registration.submit()">登録する</button>
                </div>
            `;
        } else if (this.currentStep === 3) {
            this.modalTitle.textContent = "登録完了";
            this.modalBody.innerHTML = `
                <div class="reg-success-icon"><i class="fa-solid fa-check-circle"></i></div>
                <div class="reg-success-text">
                    <h4>登録を受け付けました</h4>
                    <p>「${this.tempData.name}」を監視対象として登録しました。ダッシュボードから確認できます。</p>
                </div>
                <div class="reg-actions">
                    <button class="btn-dashboard btn-primary-action" onclick="app.registration.close()">ダッシュボードへ</button>
                </div>
            `;
        }
    }

    bindCardEvents() {
        const cardPdf = document.getElementById('reg-card-pdf');
        if (!cardPdf) return;

        // Click to select
        cardPdf.onclick = () => this.fileInput.click();

        // Drag & Drop
        cardPdf.ondragover = (e) => {
            e.preventDefault();
            cardPdf.classList.add('drop-active');
        };
        cardPdf.ondragleave = () => {
            cardPdf.classList.remove('drop-active');
        };
        cardPdf.ondrop = (e) => {
            e.preventDefault();
            cardPdf.classList.remove('drop-active');
            if (e.dataTransfer.files.length > 0) {
                this.handleFileSelect(e.dataTransfer.files[0]);
            }
        };
    }

    handleFileSelect(file) {
        if (!file) return;
        if (file.type !== 'application/pdf') {
            alert('PDFファイルを選択してください');
            return;
        }

        this.nextStep(2, {
            method: 'pdf',
            fileName: file.name,
            fileSize: file.size
        });
    }

    nextStep(step, data = {}) {
        this.tempData = { ...this.tempData, ...data };
        this.currentStep = step;
        this.renderStep();
    }

    submit() {
        const nameInput = document.getElementById('reg-name');
        const typeInput = document.getElementById('reg-type');

        const name = nameInput ? nameInput.value : "";
        const type = typeInput ? typeInput.value : "";

        if (!name) {
            alert('管理名を入力してください');
            return;
        }

        this.tempData.name = name;
        this.tempData.type = type;

        // Add to DB
        dbService.addContract({
            name: this.tempData.name,
            type: this.tempData.type
        });

        // Show success
        this.nextStep(3);

        // Refresh dashboard background
        if (this.app.currentView === 'dashboard' || this.app.currentView === 'contracts') {
            this.app.navigate(this.app.currentView);
        }
    }
}



// --- App Logic ---
class DashboardApp {
    constructor() {
        this.currentView = 'dashboard';
        this.mainContent = document.getElementById('app-content');
        this.pageTitle = document.getElementById('page-header-title');

        // Navigation State
        this.searchQuery = "";
        this.currentPage = 1;
        this.dashboardFilter = "pending"; // Default filter

        // Registration Flow
        this.registration = new RegistrationFlow(this);
    }

    init() {
        console.log('Dashboard App Initialized (Live Mode)');
        dbService.init();
        this.bindEvents();
        this.registration.init(); // Initialize registration flow
        this.navigate('dashboard');
    }

    bindEvents() {
        // Mobile Toggle
        const toggle = document.getElementById('sidebar-toggle');
        const sidebar = document.getElementById('app-sidebar');
        const main = document.getElementById('app-main');

        if (toggle && sidebar) {
            toggle.addEventListener('click', () => {
                sidebar.classList.toggle('active');
            });
            if (main) {
                main.addEventListener('click', (e) => {
                    if (window.innerWidth <= 768 && sidebar.classList.contains('active')) {
                        if (!toggle.contains(e.target)) {
                            sidebar.classList.remove('active');
                        }
                    }
                });
            }
        }
    }
    navigate(viewId, params = null) {
        this.currentView = viewId;

        // Reset search/page if moving away from contracts list
        if (viewId !== 'contracts') {
            this.searchQuery = "";
            this.currentPage = 1;
        }

        // Handle specific params for contracts view
        let renderParams = params;
        if (viewId === 'contracts') {
            renderParams = {
                page: this.currentPage,
                query: this.searchQuery,
                ...params
            };
        }

        // Update Sidebar Active State
        const navMap = {
            'dashboard': 0, 'contracts': 1, 'history': 2, 'team': 3
        };

        if (navMap.hasOwnProperty(viewId)) {
            document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
            const navItems = document.querySelectorAll('.nav-item');
            const navIndex = navMap[viewId];
            if (navItems[navIndex]) navItems[navIndex].classList.add('active');
        }

        // Render View
        if (Views[viewId]) {
            this.mainContent.innerHTML = Views[viewId](renderParams);

            // Update Header Breadcrumb
            let title = 'ダッシュボード';
            if (viewId === 'contracts') title = '契約管理';
            if (viewId === 'diff') title = '差分詳細';
            if (viewId === 'history') title = '解析履歴';
            if (viewId === 'team') title = 'チーム設定';
            this.pageTitle.textContent = title;

            // Scroll to top
            window.scrollTo(0, 0);

            // Maintain focus for search
            if (viewId === 'contracts' && this.searchQuery) {
                const searchInput = document.getElementById('contract-search');
                if (searchInput) {
                    searchInput.focus();
                    searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);
                }
            }
        }
    }

    setDashboardFilter(filter) {
        this.dashboardFilter = filter;

        // Get fresh data
        const filteredItems = dbService.getFilteredContracts(filter);

        // 1. Update Section Title
        const titleEl = document.getElementById('dashboard-section-title');
        if (titleEl) {
            let sectionTitle = "要確認アイテム (優先度順)";
            if (filter === 'pending') sectionTitle = "未処理のアイテム (新着・変更検知)";
            if (filter === 'risk') sectionTitle = "リスク要判定アイテム";
            if (filter === 'total') sectionTitle = "全監視対象（最新順）";
            titleEl.textContent = sectionTitle;
        }

        // 2. Update Table Content
        const tableBody = document.getElementById('dashboard-table-body');
        if (tableBody) {
            const rows = filteredItems.length > 0 ? filteredItems.slice(0, 10).map(c => {
                let riskBadgeClass = 'badge-neutral';
                if (c.risk_level === 'High') riskBadgeClass = 'badge-danger';
                else if (c.risk_level === 'Medium') riskBadgeClass = 'badge-warning';
                else if (c.risk_level === 'Low') riskBadgeClass = 'badge-success';

                let statusBadge = '';
                if (c.status === '未解析') statusBadge = '<span class="badge badge-info">未解析 (新規)</span>';
                else if (c.status === '未確認') statusBadge = '<span class="badge badge-warning">要確認 (変更)</span>';
                else if (c.status === '確認済') statusBadge = '<span class="badge badge-neutral"><i class="fa-solid fa-check"></i> 確認済</span>';

                return `
                    <tr onclick="app.navigate('diff', ${c.id})">
                        <td><span class="badge ${riskBadgeClass}">${c.risk_level}</span></td>
                        <td class="col-name" title="${c.name}">${c.name}</td>
                        <td>${c.last_updated_at}</td>
                        <td>${statusBadge}</td>
                        <td><button class="btn-dashboard">${c.status === '確認済' ? '履歴を見る' : '確認する'}</button></td>
                    </tr>
                `;
            }).join('') : '<tr><td colspan="5" class="text-center text-muted" style="padding:40px;">該当するアイテムはありません</td></tr>';
            tableBody.innerHTML = rows;
        }

        // 3. Update Stat Card Active States
        document.querySelectorAll('.stat-card').forEach(card => {
            card.classList.remove('active');
            const isActive = (filter === 'pending' && card.textContent.includes('未処理')) ||
                (filter === 'risk' && card.textContent.includes('リスク要判定')) ||
                (filter === 'total' && card.textContent.includes('監視中'));
            if (isActive) card.classList.add('active');
        });
    }


    // --- Action Handlers ---

    searchContracts(query) {
        this.searchQuery = query;
        this.currentPage = 1; // Reset to page 1 on search
        this.navigate('contracts', { query, page: 1 });
    }

    changePage(newPage) {
        this.currentPage = newPage;
        this.navigate('contracts', { query: this.searchQuery, page: newPage });
    }

    confirmContract(id) {
        if (dbService.updateContractStatus(id, '確認済')) {
            alert('確認済みに更新しました');
            this.navigate('dashboard'); // Go back to refresh stats
        }
    }

    addMemo(id) {
        const input = document.getElementById('memo-input');
        if (input && input.value.trim()) {
            dbService.addActivityLog(`メモ追加: ${input.value.substring(0, 20)}...`, dbService.getContractById(id).name);
            alert('メモを保存しました');
            input.value = '';
        }
    }

    updateUserRole(email, newRole) {
        if (dbService.updateUserRole(email, newRole)) {
            console.log(`Role updated for ${email} to ${newRole} `);
        }
    }

    showInviteModal() {
        const name = prompt('名前を入力してください');
        const email = prompt('メールアドレスを入力してください');
        if (name && email) {
            dbService.addUser(name, email, '閲覧のみ');
            this.navigate('team');
        }
    }

    exportCSV() {
        const contracts = dbService.getContracts();
        let csvContent = "data:text/csv;charset=utf-8,ID,契約名,種別,最終更新,リスク,状態,担当者\n";
        contracts.forEach(c => {
            csvContent += `${c.id},${c.name},${c.type},${c.last_updated_at},${c.risk_level},${c.status},${c.assignee_name} \n`;
        });
        const encodedUri = encodeURI(csvContent);
        const link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        link.setAttribute("download", `diffsense_contracts_${new Date().toISOString().split('T')[0]}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }
}

// Global App Instance
window.app = new DashboardApp();
document.addEventListener('DOMContentLoaded', () => window.app.init());
