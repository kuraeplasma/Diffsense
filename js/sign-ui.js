/**
 * SignUI - Signature Management UI Component (Redesigned)
 * Facilitates selecting documents from the contract pool for signature.
 */

import { dbService } from './db-service.js';
import { Notify } from './notify.js';

export const SignUI = {
    currentTab: 'new-request', // 'new-request' | 'sent-requests' | 'completed-requests'
    selectedDocIds: new Set(),
    filters: {
        query: '',
        sortBy: 'date_desc'
    },
    localDummyContracts: [
        {
            name: 'サンプル_業務委託基本契約書',
            type: '業務委託契約',
            last_updated_at: '2026-03-17',
            risk_level: 'Medium',
            status: '解析済み',
            original_content: {
                preamble: '本契約は、発注者と受託者の間で業務委託に関する基本事項を定めるものです。',
                articles: [
                    { articleNumber: '第1条', title: '委託業務', paragraphs: ['受託者は発注者の指定する制作業務を遂行します。'] },
                    { articleNumber: '第2条', title: '報酬', paragraphs: ['報酬額、支払期日、検収条件は個別発注書で定めます。'] }
                ]
            }
        },
        {
            name: 'サンプル_NDA_共同提案用',
            type: '秘密保持契約',
            last_updated_at: '2026-03-16',
            risk_level: 'None',
            status: '解析済み',
            original_content: {
                preamble: '本契約は、共同提案に関連して開示される秘密情報の取扱いを定めます。',
                articles: [
                    { articleNumber: '第1条', title: '秘密情報', paragraphs: ['秘密情報には書面、口頭、電磁的記録を含みます。'] },
                    { articleNumber: '第2条', title: '利用制限', paragraphs: ['受領者は本目的以外に秘密情報を利用してはなりません。'] }
                ]
            }
        },
        {
            name: 'サンプル_SaaS利用規約_2026春版',
            type: '利用規約',
            last_updated_at: '2026-03-15',
            risk_level: 'High',
            status: '解析済み',
            original_content: {
                preamble: '本利用規約は、当社サービスの利用条件を定めるものです。',
                articles: [
                    { articleNumber: '第1条', title: '適用', paragraphs: ['本規約は、全ての利用者に適用されます。'] },
                    { articleNumber: '第2条', title: '禁止事項', paragraphs: ['不正アクセス、再配布、競合調査目的の利用を禁止します。'] }
                ]
            }
        }
    ],

    isCompletedRequest(request) {
        return String(request?.status || '').toLowerCase() === 'completed';
    },

    isTerminalRequest(request) {
        const status = String(request?.status || '').toLowerCase();
        return status === 'completed' || status === 'declined' || status === 'expired';
    },

    isDraftRequest(request) {
        const status = String(request?.status || '').toLowerCase();
        return status === 'draft' || status === 'pending';
    },

    isSentRequest(request) {
        return String(request?.status || '').toLowerCase() === 'sent';
    },

    getRequestStatusMeta(request) {
        const status = String(request?.status || '').toLowerCase();
        if (status === 'completed') {
            return { label: '完了', className: 'badge-completed' };
        }
        if (status === 'declined') {
            return { label: '辞退', className: 'badge-danger' };
        }
        if (status === 'expired') {
            return { label: '期限切れ', className: 'badge-neutral' };
        }
        if (this.isDraftRequest(request)) {
            return { label: '作成中', className: 'badge-neutral' };
        }
        const recipients = Array.isArray(request?.recipients) ? request.recipients : [];
        const signedCount = recipients.filter((recipient) => this.isRecipientCompleted(recipient)).length;
        if (recipients.length > 0 && signedCount > 0) {
            return { label: `進行中 ${signedCount}/${recipients.length}`, className: 'badge-pending' };
        }
        return { label: '送信済み', className: 'badge-pending' };
    },

    isRecipientCompleted(recipient) {
        const status = String(recipient?.status || '').toLowerCase();
        return status === 'completed' || status === 'signed';
    },

    getRecipientStatusMeta(recipient) {
        const status = String(recipient?.status || '').toLowerCase();
        if (status === 'declined') {
            return { label: '辞退', className: 'badge-danger' };
        }
        if (status === 'completed' || status === 'signed') {
            return { label: '完了', className: 'badge-completed' };
        }
        if (status === 'expired') {
            return { label: '期限切れ', className: 'badge-neutral' };
        }
        return { label: '依頼中', className: 'badge-pending' };
    },

    getRequestSortTimestamp(request) {
        const candidates = [
            request?.expiredAt,
            request?.declinedAt,
            request?.completedAt,
            request?.completed_at,
            request?.updated_at,
            request?.sent_at,
            request?.created_at
        ];
        for (const value of candidates) {
            const time = new Date(value || '').getTime();
            if (!Number.isNaN(time) && time > 0) return time;
        }
        return 0;
    },

    formatDateTime(value) {
        const time = new Date(value || '');
        if (Number.isNaN(time.getTime())) return '-';
        return time.toLocaleString('ja-JP', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        });
    },

    getContractSortTimestamp(contract) {
        const candidates = [
            contract?.updated_at,
            contract?.last_updated_at,
            contract?.created_at
        ];
        for (const value of candidates) {
            const time = new Date(value || '').getTime();
            if (!Number.isNaN(time) && time > 0) return time;
        }
        return 0;
    },

    getRequestSearchText(request) {
        const recipients = Array.isArray(request?.recipients) ? request.recipients : [];
        return [
            request?.document_name,
            request?.sender,
            request?.requestedByName,
            request?.requestedByEmail,
            recipients.map((recipient) => `${recipient?.name || ''} ${recipient?.email || ''}`).join(' '),
            this.getRequestStatusMeta(request).label
        ].join(' ').toLowerCase();
    },

    getContractSearchText(contract) {
        return [
            contract?.name,
            contract?.type,
            contract?.status,
            contract?.risk_level
        ].join(' ').toLowerCase();
    },

    hasComparableVersion(contract) {
        const historyCount = Array.isArray(contract?.history) ? contract.history.filter(Boolean).length : 0;
        return historyCount >= 2;
    },

    isContractDiffAnalyzed(contract) {
        const status = String(contract?.status || '').trim();
        if (!status || status === '未解析') return false;
        return this.hasComparableVersion(contract);
    },

    applyRequestFiltersAndSort(requests) {
        const query = String(this.filters.query || '').trim().toLowerCase();
        const sortBy = String(this.filters.sortBy || 'date_desc');
        const filtered = (Array.isArray(requests) ? requests : []).filter((request) => {
            if (!query) return true;
            return this.getRequestSearchText(request).includes(query);
        });

        filtered.sort((a, b) => {
            if (sortBy === 'date_asc') {
                return this.getRequestSortTimestamp(a) - this.getRequestSortTimestamp(b);
            }
            if (sortBy === 'name_asc') {
                return String(a?.document_name || '').localeCompare(String(b?.document_name || ''), 'ja');
            }
            if (sortBy === 'name_desc') {
                return String(b?.document_name || '').localeCompare(String(a?.document_name || ''), 'ja');
            }
            return this.getRequestSortTimestamp(b) - this.getRequestSortTimestamp(a);
        });

        return filtered;
    },

    applyContractFiltersAndSort(contracts) {
        const query = String(this.filters.query || '').trim().toLowerCase();
        const sortBy = String(this.filters.sortBy || 'date_desc');
        const filtered = (Array.isArray(contracts) ? contracts : []).filter((contract) => {
            if (!query) return true;
            return this.getContractSearchText(contract).includes(query);
        });

        filtered.sort((a, b) => {
            if (sortBy === 'date_asc') {
                return this.getContractSortTimestamp(a) - this.getContractSortTimestamp(b);
            }
            if (sortBy === 'name_asc') {
                return String(a?.name || '').localeCompare(String(b?.name || ''), 'ja');
            }
            if (sortBy === 'name_desc') {
                return String(b?.name || '').localeCompare(String(a?.name || ''), 'ja');
            }
            return this.getContractSortTimestamp(b) - this.getContractSortTimestamp(a);
        });

        return filtered;
    },

    updateFilter(key, value) {
        this.filters[key] = value;
        this.refreshList();
    },

    getTrialSignQuotaMeta(app = window.app) {
        const sub = app?.subscription || null;
        if (!sub?.isInTrial) {
            return { isLimited: false, count: 0, limit: 0 };
        }

        const count = Number(sub?.signUsageCount || 0);
        const limit = Number(sub?.signUsageLimit || 3);
        return {
            isLimited: count >= limit,
            count,
            limit
        };
    },

    redirectToBillingForSignLimit(app = window.app) {
        Notify.warning('トライアル期間中の署名は3回までです。プラン選択画面へ移動します。');
        if (app?.redirectToPlanSelection) {
            app.redirectToPlanSelection('trial_sign_limit');
            return;
        }
        window.location.replace(`${window.location.origin}/select-plan-preview.html?reason=trial_sign_limit&billing=monthly`);
    },

    ensureSignQuota(app = window.app) {
        const quota = this.getTrialSignQuotaMeta(app);
        if (!quota.isLimited) return true;
        this.redirectToBillingForSignLimit(app);
        return false;
    },

    /**
     * Renders the main Signature Management view
     */
    async renderSignView(app) {
        this.selectedDocIds.clear();
        const quota = this.getTrialSignQuotaMeta(app);
        return `
            <div class="sign-container">
                <div class="sign-header">
                    <div class="sign-title">
                        <h1>署名管理</h1>
                        <p>契約済み書類や未解析の書類から、電子署名の依頼を開始・管理できます</p>
                    </div>
                </div>

                ${app?.subscription?.isInTrial ? `
                    <div class="sign-list-card" style="margin-bottom:16px; padding:16px 20px; border:1px solid ${quota.isLimited ? '#f3c2c2' : '#ead9b0'}; background:${quota.isLimited ? '#fff6f6' : '#fffbf0'};">
                        <div style="font-size:13px; color:#6b7280;">
                            トライアル中の署名: <strong style="color:#111827;">${quota.count} / ${quota.limit}回</strong>
                            ${quota.isLimited ? `
                                <button class="btn-dashboard btn-primary-action" style="margin-left:12px; font-size:12px;" onclick="window.signUI.redirectToBillingForSignLimit()">
                                    プラン登録へ進む
                                </button>
                            ` : ''}
                        </div>
                    </div>
                ` : ''}

                <div class="sign-tabs">
                    <button class="sign-tab ${this.currentTab === 'new-request' ? 'active' : ''}" 
                            onclick="window.signUI.switchTab('new-request')">
                        署名依頼の新規作成
                    </button>
                    <button class="sign-tab ${this.currentTab === 'sent-requests' ? 'active' : ''}" 
                            onclick="window.signUI.switchTab('sent-requests')">
                        送信済み一覧
                    </button>
                    <button class="sign-tab ${this.currentTab === 'completed-requests' ? 'active' : ''}" 
                            onclick="window.signUI.switchTab('completed-requests')">
                        完了一覧
                    </button>
                </div>

                <div class="filter-bar mb-md">
                    <div class="flex flex-wrap gap-md items-center">
                        <div style="position:relative; flex:1; min-width:250px;">
                            <i class="fa-solid fa-magnifying-glass" style="position:absolute; left:12px; top:50%; transform:translateY(-50%); color:#999;"></i>
                            <input type="text" id="sign-search" placeholder="書類名・送信者・署名者で検索..." 
                                   value="${this.escapeHtml(this.filters.query || '')}"
                                   style="padding:8px 12px 8px 36px; border:1px solid #ddd; border-radius:4px; width:100%; font-size:13px;"
                                   oninput="window.signUI.updateFilter('query', this.value)">
                        </div>

                        <div class="flex gap-sm items-center">
                            <span class="text-muted" style="font-size:12px;">並び順:</span>
                            <select onchange="window.signUI.updateFilter('sortBy', this.value)" style="padding:6px 8px; border:1px solid #ddd; border-radius:4px; font-size:13px;">
                                <option value="date_desc" ${this.filters.sortBy === 'date_desc' ? 'selected' : ''}>最新順</option>
                                <option value="date_asc" ${this.filters.sortBy === 'date_asc' ? 'selected' : ''}>古い順</option>
                                <option value="name_asc" ${this.filters.sortBy === 'name_asc' ? 'selected' : ''}>書類名 A-Z</option>
                                <option value="name_desc" ${this.filters.sortBy === 'name_desc' ? 'selected' : ''}>書類名 Z-A</option>
                            </select>
                        </div>
                    </div>
                </div>

                <div class="sign-list-card">
                    <table class="sign-table">
                        <thead id="sign-table-head">
                            <!-- Dynamic Head -->
                        </thead>
                        <tbody id="sign-list-body">
                            <tr>
                                <td colspan="6" style="text-align:center; padding:40px; color:#999;">読み込み中...</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>
        `;
    },

    /**
     * Switch between tabs
     */
    switchTab(tabId) {
        this.currentTab = tabId;
        this.selectedDocIds.clear();
        
        // Update tab button classes
        const tabs = document.querySelectorAll('.sign-tab');
        tabs.forEach(t => t.classList.remove('active'));
        const activeLabel = tabId === 'new-request'
            ? '新規作成'
            : (tabId === 'completed-requests' ? '完了' : '送信済み');
        const activeTab = Array.from(tabs).find(t => t.textContent.trim().includes(activeLabel));
        if (activeTab) activeTab.classList.add('active');

        this.refreshList();
    },

    /**
     * Refreshes the list based on the active tab
     */
    async refreshList(app) {
        const listBody = document.getElementById('sign-list-body');
        const tableHead = document.getElementById('sign-table-head');
        if (!listBody || !tableHead) return;

        if (this.currentTab === 'new-request') {
            await this.renderNewRequestTab(tableHead, listBody);
        } else if (this.currentTab === 'completed-requests') {
            await this.renderCompletedRequestsTab(tableHead, listBody);
        } else {
            await this.renderSentRequestsTab(tableHead, listBody);
        }
    },

    /**
     * Tab 1: New Request (From Contracts)
     */
    async renderNewRequestTab(tableHead, listBody) {
        tableHead.innerHTML = `
            <tr>
                <th>書類名</th>
                <th>種別</th>
                <th>解析ステータス</th>
                <th>リスク</th>
                <th>最終更新</th>
                <th style="width:180px; text-align:right;">操作</th>
            </tr>
        `;

        await dbService.syncContractsFromApi();
        const contracts = this.applyContractFiltersAndSort(await this.ensureLocalDummyContracts());
        
        if (contracts.length === 0) {
            const hasFilter = Boolean(String(this.filters.query || '').trim());
            listBody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:60px; color:#999;">${hasFilter ? '検索条件に一致する書類がありません。' : '書類データがありません。契約管理からアップロードしてください。'}</td></tr>`;
            return;
        }

        listBody.innerHTML = contracts.map(c => {
            const isAnalyzed = this.isContractDiffAnalyzed(c);
            const riskClass = !isAnalyzed
                ? 'badge-neutral'
                : (c.risk_level === 'High'
                    ? 'badge-danger'
                    : (c.risk_level === 'Medium'
                        ? 'badge-warning'
                        : (c.risk_level === 'Low' ? 'badge-success' : 'badge-neutral')));
            const riskLabel = !isAnalyzed
                ? '-'
                : (c.risk_level === 'High'
                    ? 'High'
                    : (c.risk_level === 'Medium'
                        ? 'Medium'
                        : (c.risk_level === 'Low' ? 'Low' : '-')));
            const updatedAt = this.formatDateTime(c.last_updated_at || c.updated_at || c.created_at);

            return `
                <tr>
                    <td style="font-weight:600;">${this.escapeHtml(c.name)}</td>
                    <td>${this.escapeHtml(c.type || '-')}</td>
                    <td>
                        <span class="badge ${isAnalyzed ? 'badge-info' : 'badge-neutral'}">
                            ${isAnalyzed ? '解析済み' : '未解析'}
                        </span>
                    </td>
                    <td><span class="badge ${riskClass}">${riskLabel}</span></td>
                    <td>${updatedAt}</td>
                    <td style="text-align:right;" onclick="event.stopPropagation()">
                        <button class="btn-dashboard btn-primary-action" style="font-size:12px; min-width:140px; justify-content:center;${this.getTrialSignQuotaMeta(window.app).isLimited ? ' opacity:0.5; cursor:not-allowed;' : ''}" onclick="window.signUI.startSingleRequest(${c.id})" ${this.getTrialSignQuotaMeta(window.app).isLimited ? 'disabled' : ''}>
                            署名依頼を開始
                        </button>
                    </td>
                </tr>
            `;
        }).join('');
    },

    /**
     * Tab 2: Sent Requests (Tracking)
     */
    async renderSentRequestsTab(tableHead, listBody) {
        tableHead.innerHTML = `
            <tr>
                <th>書類名</th>
                <th>送信者</th>
                <th>ステータス</th>
                <th>作成日</th>
                <th>アクション</th>
            </tr>
        `;

        const requests = this.applyRequestFiltersAndSort(
            (await dbService.getSignRequests()).filter((request) => !this.isTerminalRequest(request))
        );

        if (requests.length === 0) {
            const hasFilter = Boolean(String(this.filters.query || '').trim());
            listBody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:60px; color:#999;">${hasFilter ? '検索条件に一致する署名依頼はありません。' : '進行中の署名依頼はありません。'}</td></tr>`;
            return;
        }

        listBody.innerHTML = requests.map(r => {
            const statusMeta = this.getRequestStatusMeta(r);
            const dateStr = this.formatDateTime(r.created_at);
            
            return `
                <tr onclick="window.app.navigate('sign-viewer', ${r.id})">
                    <td style="font-weight:600;">${this.escapeHtml(r.document_name)}</td>
                    <td>${this.escapeHtml(r.sender)}</td>
                    <td><span class="sign-badge ${statusMeta.className}">${statusMeta.label}</span></td>
                    <td>${dateStr}</td>
                    <td onclick="event.stopPropagation()">
                        <div style="display:flex; gap:8px;">
                            ${this.isDraftRequest(r) ? `
                                <button class="btn-dashboard" onclick="window.app.navigate('sign-editor', ${r.id})">
                                    <i class="fa-solid fa-pen-nib"></i> 配置
                                </button>
                                <button class="btn-dashboard btn-icon-only" title="キャンセル" onclick="window.signUI.cancelSignRequest(${r.id})" style="color:#ea4335;">
                                    <i class="fa-solid fa-ban"></i>
                                </button>
                            ` : (this.isSentRequest(r) ? `
                                <button class="btn-dashboard btn-primary-action" style="font-size:11px;" onclick="window.app.navigate('sign-viewer', ${r.id})">
                                    進捗を確認
                                </button>
                                <button class="btn-dashboard btn-icon-only" title="催促" onclick="window.signUI.remindRecipient(${r.id})">
                                    <i class="fa-solid fa-bell"></i>
                                </button>
                            ` : `
                                <button class="btn-dashboard" style="font-size:11px;" onclick="window.app.navigate('sign-viewer', ${r.id})">詳細</button>
                            `)}
                        </div>
                    </td>
                </tr>
            `;
        }).join('');
    },

    async renderCompletedRequestsTab(tableHead, listBody) {
        tableHead.innerHTML = `
            <tr>
                <th>書類名</th>
                <th>送信者</th>
                <th>ステータス</th>
                <th>完了日</th>
                <th>アクション</th>
            </tr>
        `;

        const requests = this.applyRequestFiltersAndSort(
            (await dbService.getSignRequests()).filter((request) => this.isTerminalRequest(request))
        );

        if (requests.length === 0) {
            const hasFilter = Boolean(String(this.filters.query || '').trim());
            listBody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:60px; color:#999;">${hasFilter ? '検索条件に一致する署名依頼はありません。' : '完了した署名依頼はありません。'}</td></tr>`;
            return;
        }

        listBody.innerHTML = requests.map((r) => {
            const statusMeta = this.getRequestStatusMeta(r);
            const completedDate = this.formatDateTime(r.completedAt || r.completed_at || r.declinedAt || r.expiredAt || r.updated_at || r.created_at);
            return `
                <tr onclick="window.app.navigate('sign-viewer', ${r.id})">
                    <td style="font-weight:600;">${this.escapeHtml(r.document_name)}</td>
                    <td>${this.escapeHtml(r.sender)}</td>
                    <td><span class="sign-badge ${statusMeta.className}">${statusMeta.label}</span></td>
                    <td>${completedDate}</td>
                    <td onclick="event.stopPropagation()">
                        <div style="display:flex; gap:8px;">
                            <button class="btn-dashboard" style="font-size:11px;" onclick="window.app.navigate('sign-viewer', ${r.id})">詳細</button>
                        </div>
                    </td>
                </tr>
            `;
        }).join('');
    },

    async remindRecipient(id) {
        const result = await dbService.remindSignRequest(id);
        if (result) {
            Notify.success('署名依頼を再送しました');
            await this.refreshList();
            return;
        }
        Notify.error('署名依頼の再送に失敗しました');
    },

    async cancelSignRequest(id) {
        if (confirm('この署名依頼をキャンセルしてもよろしいですか？')) {
            Notify.success('署名依頼をキャンセルしました');
            // Future: call backend API and update list
        }
    },


    /**
     * Selection Logic
     */
    toggleDocSelection(id, event) {
        if (this.selectedDocIds.has(id)) {
            this.selectedDocIds.delete(id);
        } else {
            this.selectedDocIds.add(id);
        }
        this.refreshList();
    },

    async startSingleRequest(id) {
        if (!this.ensureSignQuota()) return;
        this.selectedDocIds.clear();
        this.selectedDocIds.add(id);
        await this.startOneScreenEditor();
    },

    async ensureLocalDummyContracts() {
        const contracts = await dbService.getContracts();
        const isLocalDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
        if (!isLocalDev) {
            return contracts;
        }

        let changed = false;
        const nextContracts = [...contracts];
        for (const dummy of this.localDummyContracts) {
            if (nextContracts.some((item) => item.name === dummy.name)) {
                continue;
            }
            const created = dbService.addContract({
                name: dummy.name,
                type: dummy.type,
                sourceUrl: '',
                monitoring_enabled: false
            });
            const stored = nextContracts.find((item) => item.id === created.id) || created;
            Object.assign(stored, {
                type: dummy.type,
                last_updated_at: dummy.last_updated_at,
                risk_level: dummy.risk_level,
                status: dummy.status,
                original_content: dummy.original_content
            });
            if (!nextContracts.some((item) => item.id === stored.id)) {
                nextContracts.unshift(stored);
            }
            changed = true;
        }

        if (changed) {
            localStorage.setItem(dbService.KEYS.CONTRACTS, JSON.stringify(nextContracts));
        }

        return dbService.getContracts();
    },

    async toggleAllSelection(checked) {
        if (checked) {
            const contracts = await dbService.getContracts();
            contracts.forEach(c => this.selectedDocIds.add(c.id));
        } else {
            this.selectedDocIds.clear();
        }
        await this.refreshList();
    },

    /**
     * Batch Recipient Modal
     */
    async openRecipientModalBatch() {
        console.log("SignUI: Opening batch recipient modal...");
        if (!this.ensureSignQuota()) return;
        const selectedCount = this.selectedDocIds.size;
        if (selectedCount === 0) {
            Notify.warning('書類を選択してください');
            return;
        }

        // --- REMOVED QUICK SIGN OPTIMIZATION ---
        // We now always show the recipient modal to allow the user to enter recipients properly.

        const overlay = document.getElementById('sign-upload-overlay');
        const modal = document.getElementById('sign-upload-modal');
        
        if (overlay && modal) {
            overlay.style.display = 'block';
            modal.style.display = 'block';
            
            const titleEl = modal.querySelector('h2');
            if (titleEl) titleEl.textContent = `署名依頼の開始 (${selectedCount}件の書類)`;

            // Robust hide/show of the upload area
            const uploadArea = document.getElementById('sign-upload-section');
            if (uploadArea) {
                uploadArea.style.display = 'none';
            } else {
                // Fallback to query selector if ID missing
                const fallbackArea = modal.querySelector('.sign-form-group');
                if (fallbackArea) fallbackArea.style.display = 'none';
            }

            // Ensure recipients list is initialized
            const list = document.getElementById('recipients-input-list');
            if (list) {
                list.innerHTML = `
                    <div class="recipient-input-row" style="display:grid; gap:8px; margin-bottom:8px;">
                        <input type="email" placeholder="メールアドレス" class="ri-email-input sign-input" />
                        <input type="text" placeholder="宛名" class="ri-name-input sign-input" />
                    </div>
                `;
            }

            const submitBtn = modal.querySelector('.btn-sign-primary') || modal.querySelector('.btn-primary-action');
            if (submitBtn) {
                submitBtn.textContent = 'この内容で署名依頼を送信';
                submitBtn.onclick = () => this.submitBatchRequest();
            }
            console.log("SignUI: Modal should now be visible.");
        } else {
            console.error("SignUI: Modal or overlay element NOT found in DOM!");
            Notify.error('システムエラー: モーダルが見つかりません');
        }
    },

    async submitBatchRequest() {
        if (!this.ensureSignQuota()) return;
        const contracts = await dbService.getContracts();
        const selectedContracts = contracts.filter(c => this.selectedDocIds.has(c.id));
        
        // Get recipients
        const recipientRows = document.querySelectorAll('.recipient-input-row');
        const recipients = [];
        recipientRows.forEach((row, index) => {
            const name = String(row.querySelector('.ri-name-input')?.value || '').trim();
            const email = String(row.querySelector('.ri-email-input')?.value || '').trim();
            if (name && email && this.validateEmail(email)) {
                recipients.push({
                    name,
                    email,
                    role: 'signer',
                    display_name: `${name}様`
                });
            }
        });

        if (recipients.length === 0) {
            Notify.warning('宛名とメールアドレスを正しく入力してください');
            return;
        }

        try {
            Notify.info(`${selectedContracts.length}件の署名依頼を処理中...`);
            
            // Create sign requests for each selected contract in parallel
            const promises = selectedContracts.map(c => 
                dbService.addSignRequest({
                    contractId: c.id,
                    recipients: recipients
                })
            );

            const createdRequests = await Promise.all(promises);
            const firstRequestId = createdRequests[0]?.id;

            this.closeSignUploadModal();
            Notify.success(`${selectedContracts.length}件の署名依頼を作成しました`);
            
            // Selection reset
            this.selectedDocIds.clear();

            if (selectedContracts.length === 1 && firstRequestId) {
                // Navigate to Editor for the single document
                window.app.navigate('sign-editor', firstRequestId);
            } else {
                // Refresh list and switch to tracking tab
                this.switchTab('sent-requests');
            }
        } catch (error) {
            console.error('Batch sign request failed:', error);
            if (error?.code === 'TRIAL_SIGN_LIMIT_REACHED') {
                this.redirectToBillingForSignLimit();
                return;
            }
            Notify.error('署名依頼の一部または全ての作成に失敗しました');
        }
    },

    closeSignUploadModal() {
        const overlay = document.getElementById('sign-upload-overlay');
        const modal = document.getElementById('sign-upload-modal');
        if (overlay && modal) {
            overlay.style.display = 'none';
            modal.style.display = 'none';
            
            // Restore modal title and file area for next time
            const titleEl = modal.querySelector('h2');
            if (titleEl) titleEl.textContent = '新規署名依頼';
            const uploadArea = modal.querySelector('.sign-form-group:first-child');
            if (uploadArea) uploadArea.style.display = 'block';
            
            const submitBtn = modal.querySelector('.reg-actions .btn-primary-action');
            if (submitBtn) {
                submitBtn.textContent = '依頼を作成';
                submitBtn.onclick = () => this.createSignRequest();
            }
        }
    },

    addRecipientInput() {
        const list = document.getElementById('recipients-input-list');
        if (list) {
            const row = document.createElement('div');
            row.className = 'recipient-input-row';
            row.style.display = 'grid';
            row.style.gap = '8px';
            row.style.marginBottom = '8px';
            row.innerHTML = `
                <input type="email" placeholder="メールアドレス" class="ri-email-input sign-input" />
                <div style="display:flex; gap:8px; align-items:center;">
                    <input type="text" placeholder="宛名" class="ri-name-input sign-input" style="flex:1;" />
                    <button onclick="this.closest('.recipient-input-row').remove()" style="background:none; border:none; color:#ea4335; cursor:pointer;"><i class="fa-solid fa-trash-can"></i></button>
                </div>
            `;
            list.appendChild(row);
        }
    },

    escapeHtml(str) {
        if (!str) return '';
        return str.replace(/[&<>"']/g, m => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[m]));
    },

    buildDocumentSnapshot(contract) {
        if (!contract) return null;
        return {
            id: contract.id,
            name: contract.name || '',
            type: contract.type || '',
            pdf_url: contract.pdf_url || '',
            pdf_storage_path: contract.pdf_storage_path || '',
            original_content: contract.original_content || '',
            source_url: contract.source_url || '',
            original_filename: contract.original_filename || ''
        };
    },

    /**
     * One-Screen Flow: Start Editor directly
     */
    async startOneScreenEditor() {
        if (!this.ensureSignQuota()) return;
        const contracts = await dbService.getContracts();
        const selected = contracts.filter(c => this.selectedDocIds.has(c.id));
        
        if (selected.length === 0) return;

        try {
            // For now, optimize for the first selected document
            const contract = selected[0];
            
            // Create a draft request
            const draft = await dbService.addSignRequest({
                contractId: contract.id,
                contract_id: contract.id, // For consistency across components
                recipients: [], // Empty for now, filled in editor
                document_name: contract.name,
                document_snapshot: this.buildDocumentSnapshot(contract),
                sender: '山田 太郎', // Mock current user
                status: 'pending'
            });

            if (draft) {
                this._lastDraft = draft; // Pass to editor via object reference if possible, or use global
                window._lastSignDraft = draft; 
                this.selectedDocIds.clear();
                window.app.navigate('sign-editor', draft.id);
            }
        } catch (error) {
            Notify.error('エディタの起動に失敗しました');
        }
    },

    collectRecipientInputs() {
        const recipientRows = document.querySelectorAll('.recipient-input-row');
        const recipients = [];
        recipientRows.forEach((row, index) => {
            const name = String(row.querySelector('.ri-name-input')?.value || '').trim();
            const email = String(row.querySelector('.ri-email-input')?.value || '').trim();
            if (email && this.validateEmail(email)) {
                recipients.push({
                    name,
                    email,
                    role: 'signer',
                    status: 'pending',
                    display_name: `${(name || email.split('@')[0] || `署名者${index + 1}`).trim()}様`
                });
            }
        });
        return recipients;
    },

    validateEmail(email) {
        const value = String(email || '').trim();
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    },

    async createSignRequest() {
        const recipients = this.collectRecipientInputs();
        if (recipients.length === 0) {
            Notify.warning('送信先のメールアドレスを正しく入力してください');
            return;
        }

        if (this.selectedDocIds.size > 1) {
            await this.submitBatchRequest();
            return;
        }

        if (this.selectedDocIds.size === 1) {
            if (!this.ensureSignQuota()) return;
            const contracts = await dbService.getContracts();
            const contract = contracts.find((item) => this.selectedDocIds.has(item.id));
            if (!contract) {
                Notify.error('対象の書類が見つかりません');
                return;
            }

            try {
                const draft = await dbService.addSignRequest({
                    contractId: contract.id,
                    contract_id: contract.id,
                    document_name: contract.name,
                    document_snapshot: this.buildDocumentSnapshot(contract),
                    sender: '山田 太郎',
                    recipients,
                    status: 'pending'
                });

                if (!draft) {
                    Notify.error('署名依頼の作成に失敗しました');
                    return;
                }

                this.closeSignUploadModal();
                this.selectedDocIds.clear();
                window._lastSignDraft = draft;
                window.app.navigate('sign-editor', draft.id);
                return;
            } catch (error) {
                if (error?.code === 'TRIAL_SIGN_LIMIT_REACHED') {
                    this.redirectToBillingForSignLimit();
                    return;
                }
                Notify.error('署名依頼の作成に失敗しました');
                return;
            }
        }

        const fileInput = document.getElementById('sign-file-input');
        const file = fileInput?.files?.[0];
        if (!file) {
            Notify.warning('書類を選択するか、契約一覧から対象書類を選んでください');
            return;
        }

        Notify.warning('アップロード書類からの署名依頼はまだ接続中です。いまは契約一覧から開始してください。');
    },

    /**
     * Renders the Unified Signature Editor (One-Screen)
     */
    renderSignEditor(app, requestId) {
        return `
            <div class="sign-editor-container" style="display:flex; height:calc(100vh - 64px); background:#f0f2f5; overflow:hidden;">
                <!-- Left Sidebar: Recipients & Tools -->
                <div class="sign-editor-sidebar" style="width:340px; background:#fff; border-right:1px solid #ddd; display:flex; flex-direction:column; box-shadow:2px 0 12px rgba(0,0,0,0.08); z-index:100;">
                    <div style="padding:24px; border-bottom:1px solid #eee;">
                        <button class="btn-dashboard" onclick="window.app.navigate('sign')" style="margin-bottom:16px; font-size:12px; background:none; border:none; padding:0; color:#666;">
                            <i class="fa-solid fa-chevron-left"></i> 戻る
                        </button>
                        <h2 style="font-size:18px; margin:0; color:var(--sign-primary); font-weight:700;">この契約に署名を依頼する</h2>
                    </div>

                    <div class="sign-editor-sidebar-body">
                        <!-- Section 1: Recipients -->
                        <div class="editor-sidebar-section sign-editor-sidebar-section is-recipient">
                            <label style="display:block; font-size:11px; font-weight:700; color:#999; margin-bottom:16px; text-transform:uppercase; letter-spacing:1px;">宛先設定</label>
                            <div id="editor-recipients-list" class="sign-editor-recipient-list">
                                <!-- Recipient rows injected here by SignEditor -->
                            </div>
                            <button class="btn-dashboard" onclick="window.SignEditor.addRecipientRow()" style="width:100%; border:1px dashed #ccc; background:#fafafa; font-size:11px; margin-top:12px; border-radius:8px; height:36px;">
                                <i class="fa-solid fa-plus"></i> 署名者を追加
                            </button>
                        </div>

                        <div class="sign-editor-sidebar-divider"></div>

                        <!-- Section 2: Fields -->
                        <div class="editor-sidebar-section sign-editor-sidebar-section">
                            <label style="display:block; font-size:11px; font-weight:700; color:#999; margin-bottom:16px; text-transform:uppercase; letter-spacing:1px;">フィールド配置</label>
                            <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
                                <button class="btn-dashboard field-tool" id="tool-signature" onclick="window.SignEditor.setTool('signature')" style="height:auto; padding:16px; flex-direction:column; gap:8px; border-radius:12px; cursor:grab;">
                                    <i class="fa-solid fa-signature" style="font-size:20px; color:var(--sign-primary);"></i>
                                    <span style="font-size:12px; font-weight:600;">署名枠</span>
                                </button>
                                <button class="btn-dashboard field-tool" id="tool-date" onclick="window.SignEditor.setTool('date')" style="height:auto; padding:16px; flex-direction:column; gap:8px; border-radius:12px; cursor:grab;">
                                    <i class="fa-regular fa-calendar" style="font-size:20px; color:var(--sign-primary);"></i>
                                    <span style="font-size:12px; font-weight:600;">日付枠</span>
                                </button>
                            </div>
                            <p style="font-size:11px; color:#888; margin-top:16px; line-height:1.6; background:#f8f9fa; padding:12px; border-radius:8px; border:1px solid #eee;">
                                ドラッグアンドドロップで配置してください。
                            </p>
                        </div>

                        <div id="editor-field-settings-section" class="editor-sidebar-section sign-editor-sidebar-section" style="display:none;">
                            <div class="sign-editor-sidebar-divider" style="margin-bottom:24px;"></div>
                            <label style="display:block; font-size:11px; font-weight:700; color:#999; margin-bottom:16px; text-transform:uppercase; letter-spacing:1px;">フィールド設定</label>
                            <div id="editor-field-settings" class="sign-editor-field-settings" style="background:#fafafa; border:1px solid #eee; border-radius:12px; padding:14px; min-height:160px; font-size:12px; color:#666;">
                                
                            </div>
                        </div>
                    </div>

                    <!-- Bottom Action -->
                    <div style="padding:24px; border-top:1px solid #eee; background:#fff;">
                        <button id="sign-editor-preview-toggle" class="btn-dashboard" onclick="window.SignEditor.openRecipientPreview()" style="width:100%; height:46px; font-size:14px; font-weight:600; border-radius:12px; margin-bottom:12px; justify-content:center;">
                            受信者プレビュー
                        </button>
                        <button id="sign-editor-send-btn" class="btn-sign btn-sign-primary" onclick="window.SignEditor.saveAndSend()" style="width:100%; min-height:46px; font-size:15px;">
                            この内容で署名依頼を送信 <i class="fa-solid fa-paper-plane" style="margin-left:8px;"></i>
                        </button>
                    </div>
                </div>

                <!-- Center: PDF Viewer -->
                <div class="sign-editor-viewport" style="flex:1; position:relative; overflow:hidden; padding:40px; background:#dfe1e5;">
                    <div id="sign-editor-page-switcher" class="sign-page-switcher is-hidden" style="max-width:240px; margin:0 auto 20px;"></div>
                    <div id="sign-editor-canvas-container" style="display:flex; flex-direction:column; align-items:center; position:relative; min-height:100%;">
                        <div class="loader-spinner" style="margin-top:120px;"></div>
                        <p style="margin-top:24px; color:#5f6368; font-weight:500;">ドキュメントを読み込み中...</p>
                    </div>
                </div>
            </div>
        `;
    },

    /**
     * Renders the Sign Recipient View (One-Screen)
     */
    renderSignRecipient(app, requestId) {
        return `
            <div class="sign-recipient-view-container" style="display:flex; flex-direction:column; height:calc(100vh - 64px); background:#f0f2f5;">
                <!-- Top Header: Progress & Actions -->
                <div class="sign-recipient-header" style="height:72px; background:#fff; border-bottom:1px solid #ddd; display:flex; align-items:center; justify-content:space-between; padding:0 32px; box-shadow:0 2px 8px rgba(0,0,0,0.05); z-index:100;">
                    <div style="display:flex; align-items:center; gap:16px;">
                        <div style="width:40px; height:40px; background:var(--sign-primary); color:#fff; border-radius:10px; display:flex; align-items:center; justify-content:center; font-size:20px;">
                            <i class="fa-solid fa-signature"></i>
                        </div>
                        <div>
                            <h2 style="font-size:16px; margin:0; font-weight:700; color:#1a1d21;">署名依頼の確認と署名</h2>
                            <p id="recipient-progress" style="font-size:12px; margin:0; color:#666;">読み込み中...</p>
                        </div>
                    </div>
                    <div>
                        <label style="display:flex; align-items:center; gap:8px; font-size:12px; color:#555; margin-bottom:8px; justify-content:flex-end;">
                            <input id="recipient-agreement-checkbox" type="checkbox" onchange="window.SignRecipient.handleAgreementToggle(this.checked)">
                            内容を確認し、署名に同意します
                        </label>
                        <button id="recipient-finish-btn" class="btn-sign btn-sign-primary" onclick="window.SignRecipient.complete()" style="display:none; min-height:44px; padding:10px 24px;">
                            完了して送信
                        </button>
                    </div>
                </div>

                <!-- Main Content: PDF Viewer -->
                <div class="sign-recipient-viewport" style="flex:1; overflow:hidden; padding:40px; background:#dfe1e5;">
                    <div id="sign-recipient-page-switcher" class="sign-page-switcher is-hidden" style="max-width:240px; margin:0 auto 20px;"></div>
                    <div id="sign-recipient-canvas-container" style="display:flex; flex-direction:column; align-items:center; position:relative; min-height:100%;">
                        <div class="loader-spinner" style="margin-top:120px;"></div>
                        <p style="margin-top:24px; color:#5f6368; font-weight:500;">ドキュメントを読み込み中...</p>
                    </div>
                </div>
            </div>
        `;
    },

    /**
     * Renders the Signature Detail Viewer
     */
    async renderSignViewer(app, id) {
        const requests = await dbService.getSignRequests();
        const request = requests.find(r => String(r.id) === String(id));
        
        if (!request) {
            return `<div class="sign-container"><div class="badge-danger">依頼が見つかりません</div></div>`;
        }

        const dateStr = this.formatDateTime(request.created_at);
        
        return `
            <div class="sign-container">
                <div class="sign-header">
                    <div class="sign-title">
                        <div style="display:flex; align-items:center; gap:16px;">
                            <button class="btn-dashboard" onclick="window.app.navigate('sign')" style="padding: 4px 8px; border: none; background: transparent; font-size: 18px; color: var(--text-main); cursor: pointer;">
                                <i class="fa-solid fa-arrow-left"></i>
                            </button>
                            <h1 style="margin:0;">署名状況の詳細</h1>
                        </div>
                        <p>${this.escapeHtml(request.document_name)} - ${dateStr} 作成</p>
                    </div>
                    <div class="sign-actions">
                    </div>
                </div>

                <div style="display:grid; grid-template-columns: 2fr 1fr; gap:24px;">
                    <div style="display:flex; flex-direction:column; gap:14px;">
                        <div id="sign-viewer-content" class="sign-list-card" style="padding:0; min-height:600px; display:flex; align-items:center; justify-content:center; background:#f0f0f0; border-radius:var(--radius-md);">
                            <div style="text-align:center; color:var(--text-muted);">
                                <i class="fa-solid fa-file-pdf" style="font-size:64px; margin-bottom:16px;"></i>
                                <p>ドキュメント・プレビュー<br>(PDF表示エンジンを読み込み中)</p>
                            </div>
                        </div>
                    </div>

                    <div class="sign-viewer-detail-card">
                        <h3 style="font-size:16px; margin-bottom:16px; padding-bottom:12px; border-bottom:1px solid var(--border-subtle);">
                            <i class="fa-solid fa-users-line"></i> 署名者の状況
                        </h3>
                        <div id="viewer-recipient-list">
                            ${request.recipients.map((rec, idx) => {
                                const recipientStatusMeta = this.getRecipientStatusMeta(rec);
                                return `
                                <div style="display:flex; align-items:center; justify-content:space-between; padding:12px 0; border-bottom:1px solid #f9f9f9;">
                                    <div>
                                        <div style="font-weight:600; font-size:14px;">${this.escapeHtml(rec.display_name || rec.name || rec.email)}</div>
                                        <div style="font-size:11px; color:#888;">${this.escapeHtml(rec.email)}</div>
                                        ${rec.signed_at ? `<div style="font-size:11px; color:#888; margin-top:4px;">署名日時: ${this.escapeHtml(new Date(rec.signed_at).toLocaleString('ja-JP'))}</div>` : ''}
                                        ${rec.signedAt ? `<div style="font-size:11px; color:#888; margin-top:4px;">署名日時: ${this.escapeHtml(new Date(rec.signedAt).toLocaleString('ja-JP'))}</div>` : ''}
                                        ${rec.declinedAt ? `<div style="font-size:11px; color:#888; margin-top:4px;">辞退日時: ${this.escapeHtml(new Date(rec.declinedAt).toLocaleString('ja-JP'))}</div>` : ''}
                                        ${rec.consented_at ? `<div style="font-size:11px; color:#888; margin-top:2px;">同意確認: ${this.escapeHtml(new Date(rec.consented_at).toLocaleString('ja-JP'))}</div>` : ''}
                                    </div>
                                    <span class="sign-badge ${recipientStatusMeta.className}" style="font-size:10px;">
                                        ${recipientStatusMeta.label}
                                    </span>
                                </div>
                            `;}).join('')}
                        </div>
                        
                        <div style="margin-top:24px; padding-top:24px; border-top:1px solid var(--border-subtle);">
                            ${request.completed_document_url ? `
                                <a class="btn-dashboard btn-primary-action" style="width:100%; justify-content:center; text-decoration:none; min-height:48px; font-size:14px; padding:12px 16px;" href="${this.escapeHtml(request.completed_document_url)}" target="_blank" rel="noopener noreferrer" download>
                                    <i class="fa-solid fa-download"></i> ダウンロード
                                </a>
                            ` : ''}
                            ${request.completion_certificate_url ? `
                                <a class="btn-dashboard" style="width:100%; justify-content:center; text-decoration:none; margin-top:10px;" href="${this.escapeHtml(request.completion_certificate_url)}" target="_blank" rel="noopener noreferrer">
                                    <i class="fa-solid fa-certificate"></i> 完了証明書を開く
                                </a>
                            ` : ''}
                            ${this.isDraftRequest(request) ? `<p style="font-size:11px; color:#888; text-align:center; margin-top:12px;">※作成中の依頼は編集画面から配置を見直せます</p>` : ''}
                        </div>

                    </div>
                </div>
            </div>
        `;
    },

};

window.signUI = SignUI;
