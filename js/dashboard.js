import { dbService } from './db-service.js';
import { aiService } from './ai-service.js';

// --- Static Content ---

// --- View Renderers ---
const Views = {
    // 5. Plan Management (New)
    plan: () => {
        const sub = window.app ? window.app.subscription : null;
        const payment = window.app ? window.app.paymentStatus : null;
        if (!sub) return '<div class="text-center p-5">利用状況を読み込んでいます...</div>';

        const plans = [
            { id: 'starter', name: 'Starter', price: '¥1,480', features: ['AI解析 15回/月', '履歴管理', '判定: High/Med/Low'] },
            { id: 'business', name: 'Business', price: '¥4,980', features: ['AI解析 120回/月', 'AI詳細解説', 'ステータス管理', 'チーム3人'] },
            { id: 'pro', name: 'Pro / Legal', price: '¥9,800', features: ['AI解析 400回/月', '定期URL監視', 'CSV/PDFエクスポート', 'チーム5人'] }
        ];

        const hasPayment = payment && payment.hasPaymentMethod;

        const cards = plans.map(p => {
            const isCurrent = sub.plan === p.id;
            return `
                <div class="pricing-card ${isCurrent ? 'business highlight-plan' : ''}" style="border: 1px solid #eee; padding: 20px; border-radius: 8px; flex: 1; background: #fff; display:flex; flex-direction:column;">
                    <div style="height:22px; margin-bottom:6px;">
                        ${isCurrent ? '<span style="background:#c19b4a; color:#fff; font-size:10px; padding:2px 8px; border-radius:10px;">現在のプラン</span>' : ''}
                    </div>
                    <h3 style="margin-bottom:10px;">${p.name}</h3>
                    <div style="font-size: 24px; font-weight: bold; margin-bottom: 20px;">${p.price}<small style="font-size:12px; color:#666;"> / 月</small></div>
                    <ul style="list-style: none; padding: 0; margin-bottom: 20px; font-size: 0.85rem; color: #555; flex:1;">
                        ${p.features.map(f => `<li style="margin-bottom:8px;"><i class="fa-solid fa-check" style="color:#c19b4a; margin-right:8px;"></i>${f}</li>`).join('')}
                    </ul>
                    ${!isCurrent ? `<button class="btn-dashboard full-width" style="background:#c19b4a; color:#fff; border:none;" onclick="window.app.startPayPalSubscription('${p.id}')">プランを変更する</button>` : ''}
                </div>
            `;
        }).join('');

        // Payment section
        let paymentSection = '';
        if (hasPayment) {
            paymentSection = `
                <div style="background:#f0fdf4; border:1px solid #86efac; border-radius:8px; padding:20px; margin-bottom:20px;">
                    <div style="display:flex; align-items:center; gap:10px; margin-bottom:8px;">
                        <i class="fa-solid fa-circle-check" style="color:#22c55e; font-size:1.2rem;"></i>
                        <strong style="color:#166534;">お支払い方法が登録されています</strong>
                    </div>
                    <p style="font-size:0.85rem; color:#555; margin:0;">サブスクリプション: アクティブ</p>
                </div>
            `;
        } else {
            paymentSection = `
                <div style="background:#fffbeb; border:1px solid #fbbf24; border-radius:8px; padding:20px; margin-bottom:20px;">
                    <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
                        <i class="fa-solid fa-triangle-exclamation" style="color:#d97706; font-size:1.2rem;"></i>
                        <strong style="color:#92400e;">お支払い方法が未登録です</strong>
                    </div>
                    <p style="font-size:0.85rem; color:#555; margin-bottom:16px;">
                        ${sub.isInTrial
                            ? 'トライアル終了後も継続利用するには、お支払い方法（PayPal/クレジットカード）の登録が必要です。'
                            : 'トライアルが終了しました。継続利用にはお支払い方法の登録が必要です。'}
                    </p>
                    <button onclick="window.app.startPayPalSubscription()" class="btn-dashboard" style="background:#c19b4a; color:#fff; border:none; padding:10px 24px; border-radius:6px; font-weight:600; cursor:pointer;">
                        <i class="fa-solid fa-credit-card" style="margin-right:8px;"></i>お支払い方法を登録する
                    </button>
                </div>
            `;
        }

        // Cancel section
        let cancelSection = '';
        if (hasPayment) {
            cancelSection = `
                <div style="border-top:1px solid #eee; padding-top:20px; margin-top:20px;">
                    <p style="font-size:0.85rem; color:#888; margin-bottom:12px;">プランの解約をご希望の場合：</p>
                    <button onclick="window.app.showCancelModal()" class="btn-dashboard" style="background:#fff; color:#d73a49; border:1px solid #d73a49; padding:8px 20px; border-radius:6px; font-size:0.85rem; cursor:pointer;">
                        <i class="fa-solid fa-xmark" style="margin-right:6px;"></i>プランをキャンセル
                    </button>
                </div>
            `;
        }

        return `
            <div class="page-title">プラン管理</div>
            ${paymentSection}
            <div style="display: flex; gap: 20px; margin-bottom: 30px;">
                ${cards}
            </div>
            ${cancelSection}
        `;
    },
    // 1. Dashboard Overview
    dashboard: () => {
        const stats = dbService.getStats();
        const currentFilter = window.app ? window.app.dashboardFilter : 'pending';
        const filteredItems = dbService.getFilteredContracts(currentFilter);

        let sectionTitle = "要確認アイテム (優先度順)";
        if (currentFilter === 'pending') sectionTitle = "未処理のアイテム (新着・変更検知)";
        if (currentFilter === 'risk') sectionTitle = "リスク要判定アイテム";
        if (currentFilter === 'total') sectionTitle = "全監視対象（最新順）";

        const tableRows = filteredItems.length > 0 ? filteredItems.slice(0, 10).map(c => {
            let riskBadgeClass = 'badge-neutral';
            if (c.risk_level === 'High') riskBadgeClass = 'badge-danger';
            else if (c.risk_level === 'Medium') riskBadgeClass = 'badge-warning';
            else if (c.risk_level === 'Low') riskBadgeClass = 'badge-success';

            let statusBadge = '';
            if (c.status === '未解析') statusBadge = '<span class="badge badge-info">未解析 (新規)</span>';
            else if (c.status === '未確認') statusBadge = '<span class="badge badge-warning">要確認 (変更)</span>';
            else if (c.status === '確認済') statusBadge = '<span class="badge badge-neutral"><i class="fa-solid fa-check"></i> 確認済</span>';

            const actionBtn = window.app.can('operate_contract')
                ? `<button class="btn-dashboard">${c.status === '確認済' ? '履歴を見る' : '確認する'}</button>`
                : `<button class="btn-dashboard">詳細を見る</button>`;

            return `
                <tr onclick="window.app.navigate('diff', ${c.id})">
                    <td><span class="badge ${riskBadgeClass}">${c.risk_level === 'High' ? 'High' : (c.risk_level === 'Medium' ? 'Medium' : (c.risk_level === 'Low' ? 'Low' : c.risk_level))}</span></td>
                    <td class="col-name" title="${c.name}">${c.name}</td>
                    <td>${c.last_updated_at}</td>
                    <td>${statusBadge}</td>
                    <td>${actionBtn}</td>
                </tr>
            `;
        }).join('') : '<tr><td colspan="5" class="text-center text-muted" style="padding:40px;">該当するアイテムはありません</td></tr>';

        return `
            <div class="stats-grid">
                <div class="stat-card ${currentFilter === 'pending' ? 'active' : ''}" onclick="window.app.setDashboardFilter('pending')">
                    <div class="stat-label ${currentFilter === 'pending' ? 'text-warning' : ''}"><i class="fa-regular fa-square-check"></i> 未処理</div>
                    <div class="stat-value">${stats.pending}件</div>
                </div>
                <div class="stat-card ${currentFilter === 'risk' ? 'active' : ''}" onclick="window.app.setDashboardFilter('risk')">
                    <div class="stat-label ${currentFilter === 'risk' ? 'text-danger' : ''}"><i class="fa-solid fa-triangle-exclamation"></i> リスク要判定</div>
                    <div class="stat-value">${stats.highRisk}件</div>
                </div>
                <div class="stat-card ${currentFilter === 'total' ? 'active' : ''}" onclick="window.app.setDashboardFilter('total')">
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
        const pageSize = 10;
        const appFilters = window.app ? window.app.filters : {};

        const { items, totalPages, totalItems } = dbService.getPaginatedContracts(page, pageSize, params);

        const rows = items.map(c => {
            let riskBadge = '';
            if (c.risk_level === 'High') riskBadge = '<span class="badge badge-danger">High</span>';
            else if (c.risk_level === 'Medium') riskBadge = '<span class="badge badge-warning">Medium</span>';
            else if (c.risk_level === 'Low') riskBadge = '<span class="badge badge-success">Low</span>';
            else riskBadge = '<span class="badge badge-neutral">-</span>';

            const statusBadge = c.status === '確認済'
                ? '<span class="badge badge-neutral"><i class="fa-solid fa-check"></i> 確認済</span>'
                : '<span class="badge badge-warning">未確認</span>';

            return `
                <tr onclick="window.app.navigate('diff', ${c.id})">
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
                   ${(window.app.subscription?.plan === 'pro') ? `<button class="btn-dashboard" onclick="window.app.exportCSV()"><i class="fa-solid fa-download"></i> CSV出力</button>` : ''}
                </div>
            </div>

            <div class="filter-bar mb-md">
                <div class="flex flex-wrap gap-md items-center">
                    <div style="position:relative; flex:1; min-width:250px;">
                        <i class="fa-solid fa-magnifying-glass" style="position:absolute; left:12px; top:50%; transform:translateY(-50%); color:#999;"></i>
                        <input type="text" id="contract-search" placeholder="契約名・種別・担当者で検索..." 
                               value="${appFilters.query || ''}"
                               style="padding:8px 12px 8px 36px; border:1px solid #ddd; border-radius:4px; width:100%; font-size:13px;"
                               oninput="window.app.updateFilter('query', this.value)">
                    </div>
                    
                    <div class="flex gap-sm items-center">
                        <span class="text-muted" style="font-size:12px;">リスク:</span>
                        <select onchange="window.app.updateFilter('risk', this.value)" style="padding:6px 8px; border:1px solid #ddd; border-radius:4px; font-size:13px;">
                            <option value="all" ${appFilters.risk === 'all' ? 'selected' : ''}>すべて</option>
                            <option value="High" ${appFilters.risk === 'High' ? 'selected' : ''}>High</option>
                            <option value="Medium" ${appFilters.risk === 'Medium' ? 'selected' : ''}>Medium</option>
                            <option value="Low" ${appFilters.risk === 'Low' ? 'selected' : ''}>Low</option>
                        </select>
                    </div>

                    <div class="flex gap-sm items-center">
                        <span class="text-muted" style="font-size:12px;">状態:</span>
                        <select onchange="window.app.updateFilter('status', this.value)" style="padding:6px 8px; border:1px solid #ddd; border-radius:4px; font-size:13px;">
                            <option value="all" ${appFilters.status === 'all' ? 'selected' : ''}>すべて</option>
                            <option value="未確認" ${appFilters.status === '未確認' ? 'selected' : ''}>未確認</option>
                            <option value="確認済" ${appFilters.status === '確認済' ? 'selected' : ''}>確認済</option>
                        </select>
                    </div>

                    <div class="flex gap-sm items-center">
                        <span class="text-muted" style="font-size:12px;">種別:</span>
                        <select onchange="window.app.updateFilter('type', this.value)" style="padding:6px 8px; border:1px solid #ddd; border-radius:4px; font-size:13px;">
                            <option value="all" ${appFilters.type === 'all' ? 'selected' : ''}>すべて</option>
                            <option value="利用規約" ${appFilters.type === '利用規約' ? 'selected' : ''}>利用規約</option>
                            <option value="秘密保持契約書" ${appFilters.type === '秘密保持契約書' ? 'selected' : ''}>秘密保持契約書</option>
                            <option value="業務委託契約書" ${appFilters.type === '業務委託契約書' ? 'selected' : ''}>業務委託契約書</option>
                        </select>
                    </div>
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
                    <button class="btn-dashboard" ${page <= 1 ? 'disabled' : ''} onclick="window.app.changePage(${page - 1})">前へ</button>
                    <div style="display:flex; align-items:center; padding:0 12px; font-size:13px; font-weight:600;">${page} / ${totalPages || 1}</div>
                    <button class="btn-dashboard" ${page >= totalPages ? 'disabled' : ''} onclick="window.app.changePage(${page + 1})">次へ</button>
                </div>
            </div>
`;
    },

    // 3. Diff Details
    diff: (id) => {
        const contract = dbService.getContractById(id);
        const activeTab = window.app ? window.app.activeDetailTab : 'diff';

        // AI解析結果があればそれを使用、なければ静的コンテンツまたはデフォルト
        const hasAIResults = contract.ai_summary || contract.ai_changes;

        let diffData;
        if (hasAIResults) {
            // AI解析結果を使用
            diffData = {
                title: `${contract.name} - AI解析結果`,
                summary: contract.ai_summary || 'AI解析が完了しました',
                riskLevel: contract.risk_level === 'High' ? 3 : (contract.risk_level === 'Medium' ? 2 : 1),
                riskReason: contract.ai_risk_reason || 'リスク判定が完了しました',
                changes: contract.ai_changes || []
            };
        } else {
            // デフォルトデータ
            diffData = {
                title: `${contract.name} - 詳細分析`,
                summary: contract.status === '未解析'
                    ? 'このドキュメントはまだAI解析されていません。新規登録から解析を実行してください。'
                    : 'このドキュメントの最新の変更要約をAIが生成しています...',
                riskLevel: contract.risk_level === 'High' ? 3 : (contract.risk_level === 'Medium' ? 2 : 1),
                riskReason: contract.status === '未解析'
                    ? 'AI解析が未実行です'
                    : '特定の変更箇所において、リスク要因が検知されました。詳細を確認してください。',
                changes: []
            };
        }

        // デバッグ情報（開発時のみ表示）
        const debugInfoHtml = '';

        const changesHtml = (diffData.changes.length > 0 ? diffData.changes : []).map(c => `
            <div style="margin-bottom: 24px; border:1px solid #eee; border-radius:4px; overflow:hidden;">
                <div style="background:#f0f0f0; padding:8px 12px; font-weight:600; font-size:12px; border-bottom:1px solid #eee;">
                    ${c.section} <span style="font-weight:normal; color:#666; margin-left:8px;">(${c.type === 'modification' ? '変更' : '削除'})</span>
                </div>
                <div class="diff-container" style="height:auto; min-height:100px;">
                    <div class="diff-pane diff-left"><span class="diff-del">${c.old}</span></div>
                    <div class="diff-pane diff-right"><span class="diff-add">${c.new}</span></div>
                </div>
                ${(c.impact || c.concern) ? `
                <div style="background:#fff8e1; padding:10px 12px; border-top:1px solid #ffeeba; font-size:12px; color:#5c3a00;">
                    ${c.impact ? `<div style="margin-bottom:4px;"><strong><i class="fa-solid fa-scale-balanced"></i> 法的影響:</strong> ${c.impact}</div>` : ''}
                    ${c.concern ? `<div><strong><i class="fa-solid fa-triangle-exclamation"></i> 懸念点:</strong> ${c.concern}</div>` : ''}
                </div>
                ` : ''}
            </div>
    `).join('');

        return `
            <div class="detail-split-container">
                <!-- Breadcrumb & Top Actions -->
                <div class="detail-split-header flex justify-between items-center">
                    <div class="flex items-center gap-md">
                        <a onclick="window.app.navigate('dashboard')" style="color:#666; font-size:12px; cursor:pointer;" title="戻る">
                            <i class="fa-solid fa-arrow-left"></i>
                        </a>
                        <h2 style="font-size:18px; font-weight:700; color:var(--text-main); margin:0;">${diffData.title}</h2>
                        <div style="font-size:12px; color:#666; margin-top:4px;">
                            ${contract.source_url ? `<i class="fa-solid fa-link"></i> Source: <a href="${contract.source_url}" target="_blank" style="color:#2196F3; text-decoration:underline;">${contract.source_url}</a>` : ''}
                            ${contract.original_filename ? `<i class="fa-solid fa-file-pdf"></i> Original File: ${contract.original_filename}` : ''}
                        </div>
                    </div>
                    <div class="flex gap-sm">
                        ${(window.app.subscription?.plan === 'pro') ? `<button class="btn-dashboard" onclick="window.app.exportPDF(${contract.id})"><i class="fa-solid fa-file-pdf"></i> PDF出力</button>` : ''}
                        ${window.app.can('operate_contract') ? `<button class="btn-dashboard" onclick="window.app.showHistoryModal(${id})"><i class="fa-solid fa-note-sticky"></i> メモ</button>` : ''}
                        ${window.app.can('operate_contract')
                ? (contract.status === '未処理'
                    ? ''
                    : contract.status === '未確認'
                        ? `<button class="btn-dashboard btn-primary-action" onclick="window.app.confirmContract(${id})"><i class="fa-solid fa-check"></i> 確認済みにする</button>`
                        : `<button class="btn-dashboard" disabled><i class="fa-solid fa-check"></i> 確認済み</button>`)
                : ''}
                    </div>
                </div>

                <div class="detail-split-body">
                    <!-- Left Pane: Analysis & Diffs -->
                    <div class="pane">
                        <div class="pane-header">
                            <span><i class="fa-solid fa-magnifying-glass-chart"></i> AI解析・差分判定</span>
                            <span class="text-muted" style="font-weight:normal; font-size:11px;">最終解析: ${contract.last_analyzed_at || '-'}</span>
                        </div>
                        <div class="pane-scroll-area">
                            <div class="analysis-section-title">
                                <i class="fa-solid fa-robot text-primary"></i> AIリスク要約
                            </div>
                            <div style="margin-bottom:24px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:16px;">
                                <div style="display:flex; align-items:center; gap:8px; margin-bottom:10px;">
                                    <span class="badge ${diffData.riskLevel >= 3 ? 'badge-danger' : diffData.riskLevel >= 2 ? 'badge-warning' : 'badge-success'}">
                                        ${diffData.riskLevel >= 3 ? 'High' : diffData.riskLevel >= 2 ? 'Medium' : 'Low'}
                                    </span>
                                    <span style="font-size:12px; color:#666;">${diffData.riskReason || ''}</span>
                                </div>
                                <div style="font-size:13px; color:#333; line-height:1.7; white-space:pre-wrap;">${diffData.summary || 'AI解析結果がありません'}</div>
                            </div>

                            <div class="analysis-section-title">
                                <i class="fa-solid fa-circle-exclamation text-warning"></i> 検知された重要な変更点
                            </div>
                            <div style="margin-bottom:32px;">
                                ${changesHtml || '<div style="padding:20px; text-align:center; color:#999; font-size:13px;">変更点は検知されませんでした</div>'}
                            </div>
                        </div>
                        
                        ${contract.source_type === 'URL' && (window.app.subscription?.plan === 'pro' || window.app.subscription?.isInTrial) ? `
                        <div class="analysis-section" style="margin-top: 24px; padding-top: 24px; border-top: 1px solid #eee;">
                            <div class="analysis-section-title" style="display:flex; justify-content:space-between; align-items:center;">
                                <span><i class="fa-solid fa-eye text-primary"></i> 定期監視（クローリング）</span>
                                <label class="switch">
                                    <input type="checkbox" ${contract.monitoring_enabled ? 'checked' : ''} onchange="window.app.toggleMonitoring(${id}, this.checked)">
                                    <span class="slider round"></span>
                                </label>
                            </div>
                            <div style="font-size: 13px; color: #666; margin-bottom:16px;">
                                URLの変更を毎日自動でチェックします。差分がある場合のみAI解析を実行します。
                            </div>
                            <div style="background: #f8f9fa; border-radius: 8px; padding: 12px; font-size: 12px;">
                                <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
                                    <span class="text-muted">最終チェック:</span>
                                    <span>${contract.last_checked_at ? new Date(contract.last_checked_at).toLocaleString('ja-JP') : '未実行'}</span>
                                </div>
                                <div style="display:flex; justify-content:space-between; margin-bottom:12px;">
                                    <span class="text-muted">監視頻度:</span>
                                    <span>${contract.stable_count >= 14 ? '3日に1回（安定）' : (contract.stable_count >= 7 ? '2日に1回' : '毎日')}</span>
                                </div>
                                <button class="btn-dashboard btn-outline" style="width:100%; justify-content:center;" onclick="window.app.manualCrawl(${id})">
                                    <i class="fa-solid fa-sync"></i> 今すぐ更新を確認（AI回数消費）
                                </button>
                            </div>
                        </div>
                        ` : ''}
                    </div>

                    <!-- Right Pane: Original Document -->
                    <div class="pane">
                        <div class="pane-header" style="display:flex; justify-content:space-between; align-items:center;">
                            <div style="display:flex; align-items:center; gap:8px;">
                                <span><i class="fa-solid fa-file-contract"></i> ドキュメント表示</span>
                                <!-- History Dropdown -->
                                <div class="header-dropdown-container">
                                    <button class="btn-dashboard" style="display:flex; align-items:center; gap:6px; padding:4px 10px; font-size:12px;" onclick="event.stopPropagation(); document.getElementById('history-menu-${id}').classList.toggle('show');" title="バージョン履歴">
                                        <i class="fa-solid fa-clock-rotate-left"></i> バージョン履歴
                                    </button>
                                    <div id="history-menu-${id}" class="header-dropdown-menu" style="left:0; right:auto; min-width:180px;" onclick="event.stopPropagation();">
                                        ${contract.history && contract.history.length > 0
                ? contract.history.slice().reverse().map(h => `
                                                <div class="header-dropdown-item" onclick="window.app.viewHistory(${id}, ${h.version}); document.getElementById('history-menu-${id}').classList.remove('show');" style="padding:10px 16px; border-bottom:1px solid #f5f5f5; display:flex; justify-content:space-between; align-items:center;">
                                                    <span style="display:flex; align-items:center;"><i class="fa-solid fa-clock-rotate-left" style="color:#ccc; margin-right:8px;"></i> Version ${h.version}</span>
                                                    <span style="font-size:11px; color:#999;">${h.date}</span>
                                                </div>
                                            `).join('')
                : '<div style="padding:10px 16px; font-size:12px; color:#999;">履歴はありません</div>'
            }
                                    </div>
                                </div>
                            </div>
                            
                            ${window.app.can('operate_contract') ? `
                            <button class="btn-upload-version" onclick="window.app.uploadNewVersion(${id})">
                                <i class="fa-solid fa-cloud-arrow-up"></i> 新しいバージョンをアップロード
                            </button>` : ''}
                        </div>
                        <div class="tabs-row">
                            <button class="tab-item ${activeTab === 'diff' ? 'active' : ''}" onclick="window.app.setDetailTab('diff')">差分表示</button>
                            <button class="tab-item ${activeTab === 'original' ? 'active' : ''}" onclick="window.app.setDetailTab('original')">原本全文</button>
                        </div>
                        <div class="pane-scroll-area ${activeTab === 'original' && (contract.pdf_url || contract.pdf_storage_path) ? '' : 'document-pane-bg is-frameless'}" style="padding:0; flex:1; display:flex; flex-direction:column; overflow-y:auto;">
                                ${activeTab === 'original' && (contract.pdf_url || contract.pdf_storage_path)
                ? `<div style="width:100%; height:100%; display:flex; flex-direction:column;">
                        <iframe src="${contract.pdf_url || contract.pdf_storage_path}" style="width:100%; flex:1; border:none; background:#525659; min-height:600px;"></iframe>
                        <div style="padding:10px; text-align:center; background:#f9f9f9; border-top:1px solid #ddd; font-size:12px;">
                            <a href="${contract.pdf_url || contract.pdf_storage_path}" target="_blank" class="text-primary"><i class="fa-solid fa-external-link-alt"></i> PDFを別ウィンドウで開く</a>
                             <span style="margin-left:10px; color:#999;">(Shift+Clickでダウンロード)</span>
                        </div>
                   </div>`
                : `<div class="document-paper-container is-frameless">
                     <div class="document-content-full">
                                        ${activeTab === 'diff'
                    ? (() => {
                        // 差分表示ロジック
                        if (!contract.history || contract.history.length === 0) {
                            return '<div class="text-muted text-center" style="padding:40px;">比較対象となる旧バージョンがありません（初回登録）</div><br>' + (contract.original_content || '');
                        }

                        // 最新の旧バージョンを取得
                        const previousVersion = contract.history[contract.history.length - 1].content;
                        const currentVersion = contract.original_content || '';

                        // jsdiffで差分生成 (文字単位)
                        if (typeof Diff === 'undefined') {
                            return '<div class="text-danger">エラー: Diffライブラリが読み込まれていません</div>';
                        }

                        const diff = Diff.diffChars(previousVersion, currentVersion);

                        // HTML生成
                        let diffHtml = diff.map(part => {
                            const colorClass = part.added ? 'diff-inline-add' :
                                part.removed ? 'diff-inline-del' : '';

                            // エスケープ処理（XSS対策）
                            const escapedValue = part.value
                                .replace(/&/g, "&amp;")
                                .replace(/</g, "&lt;")
                                .replace(/>/g, "&gt;");

                            return colorClass ? `<span class="${colorClass}">${escapedValue}</span>` : escapedValue;
                        }).join('');

                        return `<div style="white-space: pre-wrap;">${diffHtml}</div>`;
                    })()
                    : (contract.original_content || (contract.source_type === 'URL' ? '<div class="text-center text-muted" style="padding:40px;">URLから取り込んだコンテンツです。<br><a href="' + (contract.pdf_storage_path || '#') + '" target="_blank">元のページを開く <i class="fa-solid fa-external-link-alt"></i></a></div>' : '原本データがありません'))}
                    </div>
                </div>`
            }
                        </div>
                    </div>
                </div>
            </div>

`;
    },

    // 4. History
    history: () => {
        const logs = dbService.getActivityLogs();
        const rows = logs.map(h => {
            let statusBadge = 'badge-neutral';
            if (h.status === '成功') statusBadge = 'badge-success';
            else if (h.status === '失敗') statusBadge = 'badge-danger';
            else if (h.status === 'スキップ') statusBadge = 'badge-info';

            return `
            <tr>
                <td>${h.created_at}</td>
                <td class="col-name" title="${h.target_name}">${h.target_name}</td>
                <td><span class="badge ${statusBadge}">${h.status || '成功'}</span></td>
                <td>${h.action}</td>
                <td>${h.actor}</td>
                <td><button class="btn-dashboard" style="padding:2px 8px; font-size:11px;" onclick="window.app.showLogDetails(${h.id})">詳細</button></td>
            </tr>
        `}).join('');

        return `
            <h2 class="page-title">解析ログ・監査履歴</h2>
            <div class="table-container">
                <table class="data-table history-table">
                    <thead>
                        <tr>
                            <th>日時</th>
                            <th>対象</th>
                            <th>ステータス</th>
                            <th>操作/種別</th>
                            <th>実行者</th>
                            <th>詳細</th>
                        </tr>
                    </thead>
                    <tbody>${rows || '<tr><td colspan="6" class="text-center text-muted">履歴はありません</td></tr>'}</tbody>
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
            <td><span class="badge ${m.role === '管理者' ? 'badge-warning' : (m.role === '作業者' ? 'badge-success' : 'badge-neutral')}">${m.role}</span></td>
            <td>${m.last_active_at}</td>
            <td>${window.app.can('manage_team') ? `<button class="btn-dashboard" onclick="window.app.showEditMemberModal('${m.email}')">編集</button>` : '-'}</td>
        </tr>
`).join('');

        return `
            <div class="flex justify-between items-center mb-md">
                <h2 class="page-title" style="margin-bottom:0;">チーム管理</h2>
                ${window.app.can('manage_team') ? `<button class="btn-dashboard btn-primary-action" onclick="window.app.showInviteModal()"><i class="fa-solid fa-user-plus"></i> メンバー招待</button>` : ''}
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

        if (this.modal) {
            this.modal.onclick = (e) => {
                if (e.target === this.modal) this.close();
            };
        }

        if (this.fileInput) {
            this.fileInput.onchange = (e) => this.handleFileSelect(e.target.files[0]);
        }
    }

    open() {
        this.currentStep = 1;
        this.tempData = {};

        // 先にレンダリング
        this.renderStep();

        // 次のフレームで表示（描画のちらつき防止＆滑らかさ向上）
        requestAnimationFrame(() => {
            if (this.modal) this.modal.classList.add('active');
        });
    }

    close() {
        if (this.modal) this.modal.classList.remove('active');
        if (this.fileInput) this.fileInput.value = '';
    }

    renderStep() {
        if (!this.modalBody) return;

        if (this.currentStep === 1) {
            this.modalTitle.textContent = "新規登録 - 登録方法の選択";
            this.modalBody.innerHTML = `
                <p class="reg-step-title">監視対象（契約書・規約）の追加方法を選んでください</p>
                <div class="reg-method-card" id="reg-card-pdf">
                    <div class="reg-method-icon"><i class="fa-solid fa-file-pdf"></i></div>
                    <div class="reg-method-info">
                        <h4>PDFをアップロード</h4>
                        <p>ファイルをここにドロップするか、クリックして選択</p>
                        <p style="font-size:11px; color:#ff9800; margin-top:4px;">※スキャンした画像PDFやパスワード付きPDFは文字を抽出できない場合があります</p>
                    </div>
                </div>
                <div class="reg-method-card" onclick="window.app.registration.nextStep(2, {method: 'url'})">
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
                    <button class="btn-dashboard" onclick="window.app.registration.nextStep(1)">戻る</button>
                    <button class="btn-dashboard btn-primary-action" onclick="window.app.registration.submit()">登録する</button>
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
                    <button class="btn-dashboard btn-primary-action" onclick="window.app.registration.close()">ダッシュボードへ</button>
                </div>
            `;
        }
    }

    bindCardEvents() {
        const cardPdf = document.getElementById('reg-card-pdf');
        if (!cardPdf) return;

        cardPdf.onclick = () => this.fileInput.click();

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
            Notify.warning('PDFファイルを選択してください');
            return;
        }

        this.nextStep(2, {
            method: 'pdf',
            fileName: file.name,
            fileSize: file.size,
            fileData: file  // ファイルオブジェクトを保持
        });
    }

    nextStep(step, data = {}) {
        this.tempData = { ...this.tempData, ...data };
        this.currentStep = step;
        this.renderStep();
    }

    async submit() {
        const nameInput = document.getElementById('reg-name');
        const typeInput = document.getElementById('reg-type');
        const sourceInput = document.getElementById('reg-source');

        const name = nameInput ? nameInput.value : "";
        const type = typeInput ? typeInput.value : "";
        const source = sourceInput ? sourceInput.value : "";

        if (!name) {
            Notify.warning('管理名を入力してください');
            return;
        }

        this.tempData.name = name;
        this.tempData.type = type;
        this.tempData.source = source;

        // ローディング表示（抽出中）
        const isPdf = this.tempData.method === 'pdf';
        const loadingText = isPdf ? 'PDFを取り込み中...' : 'URLから規約を解析中...';
        const loadingSubText = isPdf ? '解析準備をしています' : 'Webサイトから詳細を取得しています';

        const loadingMsg = document.createElement('div');
        loadingMsg.id = 'reg-loading';
        loadingMsg.style.cssText = 'position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); background:white; padding:30px; border-radius:8px; box-shadow:0 4px 20px rgba(0,0,0,0.3); z-index:10005; text-align:center; min-width:300px;';
        loadingMsg.innerHTML = `<div class="custom-loader"></div><br><strong>${loadingText}</strong><br><span style="font-size:12px; color:#666;">${loadingSubText}</span>`;
        document.body.appendChild(loadingMsg);

        // 背景を暗くするオーバーレイ
        const overlay = document.createElement('div');
        overlay.id = 'reg-overlay';
        overlay.style.cssText = 'position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); z-index:10004;';
        document.body.appendChild(overlay);

        // UI描画を確実にするための短い遅延
        await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 50)));

        try {
            // DBに登録
            const newContract = dbService.addContract({
                name: this.tempData.name || (this.tempData.method === 'pdf' ? this.tempData.fileData.name : 'Web規約'),
                type: this.tempData.type, // デフォルト
                sourceUrl: this.tempData.method === 'url' ? this.tempData.source : '',
                originalFilename: this.tempData.method === 'pdf' ? this.tempData.fileData.name : ''
            });
            // 2. テキスト抽出を実行（失敗しても登録は維持する）
            try {
                await this.extractTextOnly(newContract.id);
            } catch (extractError) {
                console.error('Text Extraction Failed (Non-fatal):', extractError);
                // 失敗時はステータスを更新しておく（ユーザーには後で通知）
                // NOTE: dbService側で自動的に '未処理' になっているはずだが、エラー情報を残すならここで更新
            }

            // 3. 完了処理
            if (document.getElementById('reg-loading')) document.getElementById('reg-loading').remove();
            if (document.getElementById('reg-overlay')) document.getElementById('reg-overlay').remove();

            this.close();

            // 4. 詳細ページへ遷移（まずは原本を表示して安心させる）
            this.app.activeDetailTab = 'original';
            this.app.navigate('diff', newContract.id);
            this.app.showToast('✅ 読み込み完了<br><small>※AI解析用テキストは「差分表示」で確認できます</small>', 'success', 5000);

        } catch (error) {
            console.error('Registration Error:', error);
            if (document.getElementById('reg-loading')) document.getElementById('reg-loading').remove();
            if (document.getElementById('reg-overlay')) document.getElementById('reg-overlay').remove();
            Notify.error('登録中にエラーが発生しました: ' + error.message);
        }
    }

    async extractTextOnly(contractId) {
        try {
            let sourceData = this.tempData.source;

            // PDFの場合はFileReaderでBase64に変換
            if (this.tempData.method === 'pdf' && this.tempData.fileData) {
                sourceData = await aiService.convertFileToBase64(this.tempData.fileData);
            }

            // バックエンドAPIにテキスト抽出リクエスト
            const result = await aiService.analyzeContract(
                contractId,
                this.tempData.method,
                sourceData,
                null  // previousVersion なし
            );

            if (result.success) {
                // 抽出されたテキストのみを保存（AI解析結果は保存しない）
                dbService.updateContractText(contractId, {
                    extractedText: result.data.extractedText,
                    extractedTextHash: result.data.extractedTextHash,
                    extractedTextLength: result.data.extractedTextLength,
                    sourceType: result.data.sourceType,
                    pdfStoragePath: result.data.pdfStoragePath,
                    pdfUrl: result.data.pdfUrl,
                    status: '未処理'  // 差分がまだないので未処理
                });

                console.log('Text extraction completed');
                return true;
            } else {
                throw new Error(result.error || 'テキスト抽出に失敗しました');
            }

        } catch (error) {
            console.error('テキスト抽出エラー:', error);

            // エラーステータスに更新
            dbService.updateContractStatus(contractId, '登録失敗');

            // ユーザーにエラーを通知
            Notify.alert(`申し訳ありません。PDFからのテキスト抽出に失敗しました。\n\n原因: ${error.message}\n\n※画像PDFやパスワード付きPDFは対応していない場合があります。`, { type: 'error' });

            console.warn(`テキスト抽出に失敗: ${error.message}`);
        }
    }

}

// --- App Logic ---
class DashboardApp {
    constructor() {
        this.currentView = 'dashboard';
        this.mainContent = document.getElementById('app-content');
        this.pageTitle = document.getElementById('page-header-title');
        this.currentViewParams = null;
        this.userRole = '閲覧のみ'; // Default to safest


        // Navigation State
        this.searchQuery = "";
        this.currentPage = 1;
        this.dashboardFilter = "pending";
        this.activeDetailTab = 'diff';
        this.filters = {
            query: "",
            risk: "all",
            status: "all",
            type: "all",
            sortBy: "date_desc"
        };
        this.searchTimeout = null;

        // Registration Flow
        this.registration = new RegistrationFlow(this);
    }

    can(action) {
        if (!this.userRole) return false;

        switch (action) {
            case 'manage_team':
                return this.userRole === '管理者';
            case 'operate_contract':
                return this.userRole === '管理者' || this.userRole === '作業者';
            case 'view_only':
                return true;
            default:
                return false;
        }
    }

    init() {
        try {
            console.log('Dashboard App Initializing...');
            dbService.init();
            this.bindEvents();
            this.registration.init();

            // Auto-register current user as Admin if needed
            this.checkAndRegisterAdmin();

            this.navigate('dashboard');
            console.log('Dashboard App Initialized Successfully');
        } catch (error) {
            console.error('Initialization Error:', error);
            Notify.error('ダッシュボードの初期化中にエラーが発生しました。詳細はコンソールを確認してください。');
        }
    }

    async checkAndRegisterAdmin() {
        try {
            const authModule = await import('./auth.js');
            const token = await authModule.getIdToken(); // Ensure auth is ready

            const fbConfig = await import('./firebase-config.js');
            const auth = fbConfig.auth;
            const user = auth.currentUser;

            if (user) {
                this.currentUser = user; // Store for later use

                const users = dbService.getUsers();
                const matchedUser = users.find(u => u.email === user.email);

                if (!matchedUser) {
                    console.log('Auto-registering admin user:', user.email);
                    const displayName = user.displayName || user.email.split('@')[0];
                    dbService.addUser(displayName, user.email, '管理者');
                    this.userRole = '管理者';
                } else {
                    this.userRole = matchedUser.role;
                }

                // Check if user just selected a plan from signup flow
                const selectedPlan = localStorage.getItem('diffsense_selected_plan');
                if (selectedPlan) {
                    await this.registerSelectedPlan(token, selectedPlan);
                    localStorage.removeItem('diffsense_selected_plan');
                }

                // Fetch real subscription status from backend
                await this.fetchSubscriptionStatus(token);
                await this.fetchPaymentStatus(token);

                // Check if trial expired and no payment method
                this.checkTrialExpired();

                // Clean any legacy payment URL params
                const urlParams = new URLSearchParams(window.location.search);
                if (urlParams.has('payment')) {
                    history.replaceState(null, '', window.location.pathname);
                }

                console.log('Current User Role:', this.userRole);

                // Hide Team menu for non-admins
                const teamNavLink = document.querySelector('.nav-item[onclick*="team"]');
                if (teamNavLink && !this.can('manage_team')) {
                    teamNavLink.style.display = 'none';
                }
            }
        } catch (e) {
            console.error('Admin Check Error:', e);
        }
    }

    async registerSelectedPlan(token, plan) {
        try {
            const apiUrl = `${aiService.API_BASE}/user/select-plan`;

            await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ plan })
            });
            console.log('Selected plan registered:', plan);
        } catch (error) {
            console.error('Failed to register selected plan:', error);
        }
    }

    async fetchSubscriptionStatus(token) {
        try {
            const apiUrl = `${aiService.API_BASE}/user/subscription`;

            const response = await fetch(apiUrl, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });
            const result = await response.json();

            if (result.success) {
                this.subscription = result.data;
                this.userPlan = result.data.plan;
                this.updateSubscriptionUI();
            }
        } catch (error) {
            console.error('Failed to fetch subscription status:', error);
            // Fallback for dev - pro
            this.subscription = { plan: 'pro', usageCount: 0, usageLimit: 120, daysRemaining: 7, isInTrial: false, planLimit: 120 };
            this.userPlan = 'pro';
            this.updateSubscriptionUI();
        }
    }

    async fetchPaymentStatus(token) {
        try {
            const apiUrl = `${aiService.API_BASE}/payment/status`;

            const response = await fetch(apiUrl, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const result = await response.json();

            if (result.success) {
                this.paymentStatus = result.data;
            }
        } catch (error) {
            console.error('Failed to fetch payment status:', error);
            this.paymentStatus = { hasPaymentMethod: false };
        }
    }

    async startPayPalSubscription(plan) {
        const targetPlan = plan || this.subscription?.plan || 'starter';
        try {
            // Fetch PayPal config from backend
            const configRes = await fetch(`${aiService.API_BASE}/payment/config`);
            const configData = await configRes.json();
            if (!configData.success) {
                Notify.error('PayPal設定の取得に失敗しました。');
                return;
            }
            const { clientId, planIds } = configData.data;
            const paypalPlanId = planIds[targetPlan];
            if (!paypalPlanId) {
                Notify.error('プランIDが見つかりません。');
                return;
            }

            // If user has existing active subscription and is changing plans, cancel old one first
            if (this.paymentStatus?.hasPaymentMethod && this.subscription?.plan !== targetPlan) {
                const authModule = await import('./auth.js');
                const token = await authModule.getIdToken();
                try {
                    await fetch(`${aiService.API_BASE}/payment/cancel-subscription`, {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
                    });
                } catch (e) {
                    console.warn('Failed to cancel old subscription:', e);
                }
            }

            // Show modal with PayPal button container
            this.showPayPalModal(targetPlan);

            // Load PayPal JS SDK dynamically
            await this.loadPayPalSDK(clientId);

            // Render PayPal Buttons inside the modal
            const container = document.getElementById('paypal-button-container');
            if (!container) return;
            // Clear loading spinner
            container.innerHTML = '';
            container.style = '';

            paypal.Buttons({
                style: {
                    shape: 'rect',
                    color: 'gold',
                    layout: 'vertical',
                    label: 'subscribe'
                },
                createSubscription: (data, actions) => {
                    return actions.subscription.create({
                        plan_id: paypalPlanId
                    });
                },
                onApprove: async (data) => {
                    console.log('Subscription approved:', data.subscriptionID);
                    // Close the PayPal modal
                    const modal = document.getElementById('paypal-modal-overlay');
                    if (modal) modal.remove();

                    // Confirm with backend
                    await this.confirmPayPalSubscription(data.subscriptionID, targetPlan);
                },
                onCancel: () => {
                    console.log('User cancelled PayPal subscription');
                    const modal = document.getElementById('paypal-modal-overlay');
                    if (modal) modal.remove();
                    Notify.info('お支払いがキャンセルされました。');
                },
                onError: (err) => {
                    console.error('PayPal Buttons error:', err);
                    const modal = document.getElementById('paypal-modal-overlay');
                    if (modal) modal.remove();
                    Notify.error('お支払い処理でエラーが発生しました。');
                }
            }).render('#paypal-button-container');

        } catch (error) {
            console.error('PayPal subscription error:', error);
            Notify.error('お支払い処理でエラーが発生しました。');
        }
    }

    showPayPalModal(plan) {
        // Remove existing modal if any
        const existing = document.getElementById('paypal-modal-overlay');
        if (existing) existing.remove();

        const planNames = { starter: 'Starter', business: 'Business', pro: 'Pro / Legal' };
        const planPrices = { starter: '¥1,480/月', business: '¥4,980/月', pro: '¥9,800/月' };

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay active';
        overlay.id = 'paypal-modal-overlay';
        overlay.innerHTML = `
            <div class="modal-content" style="max-width:480px;">
                <div class="modal-header">
                    <h3 style="margin:0; font-size:1.1rem;">
                        <i class="fa-solid fa-credit-card" style="margin-right:8px; color:#c19b4a;"></i>お支払い方法を登録
                    </h3>
                    <button class="btn-close" onclick="document.getElementById('paypal-modal-overlay').remove()">&times;</button>
                </div>
                <div class="modal-body" style="padding:24px;">
                    <div style="background:#faf8f5; border:1px solid #e8e0d4; border-radius:8px; padding:16px; margin-bottom:20px; text-align:center;">
                        <div style="font-size:0.8rem; color:#888; margin-bottom:4px;">選択プラン</div>
                        <div style="font-size:1.1rem; font-weight:700; color:#24292E;">${planNames[plan] || plan}</div>
                        <div style="font-size:1.3rem; font-weight:700; color:#c19b4a; margin-top:4px;">${planPrices[plan] || ''}</div>
                    </div>
                    <p style="font-size:0.82rem; color:#666; margin-bottom:16px; text-align:center;">
                        PayPalアカウントまたはクレジットカード/デビットカードで<br>お支払いいただけます。
                    </p>
                    <div id="paypal-button-container" style="min-height:150px; display:flex; align-items:center; justify-content:center;">
                        <div style="color:#999; font-size:0.85rem;"><i class="fa-solid fa-spinner fa-spin" style="margin-right:8px;"></i>読み込み中...</div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
    }

    loadPayPalSDK(clientId) {
        return new Promise((resolve, reject) => {
            // If already loaded, resolve immediately
            if (window.paypal) {
                resolve();
                return;
            }
            // Remove any existing PayPal script
            const existingScript = document.getElementById('paypal-sdk-script');
            if (existingScript) existingScript.remove();

            const script = document.createElement('script');
            script.id = 'paypal-sdk-script';
            script.src = `https://www.paypal.com/sdk/js?client-id=${clientId}&vault=true&intent=subscription&locale=ja_JP`;
            script.onload = () => resolve();
            script.onerror = () => reject(new Error('PayPal SDKの読み込みに失敗しました'));
            document.head.appendChild(script);
        });
    }

    async confirmPayPalSubscription(subscriptionId, plan) {
        try {
            const authModule = await import('./auth.js');
            const token = await authModule.getIdToken();
            const apiUrl = `${aiService.API_BASE}/payment/confirm-subscription`;

            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ subscriptionId, plan })
            });
            const result = await response.json();

            if (result.success) {
                const confirmedPlan = result.data.plan || plan || this.subscription?.plan || 'starter';
                // Redirect to thanks page for GA conversion tracking
                window.location.replace(`thanks-payment.html?plan=${confirmedPlan}`);
            }
        } catch (error) {
            console.error('Confirm subscription error:', error);
        }
    }

    checkTrialExpired() {
        const sub = this.subscription;
        const payment = this.paymentStatus;
        if (!sub) return;

        // トライアル切れ + 決済未登録の場合にポップアップ表示
        const isTrialExpired = sub.trialStartedAt && !sub.isInTrial;
        const hasNoPayment = !payment || !payment.hasPaymentMethod;

        if (isTrialExpired && hasNoPayment) {
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay';
            overlay.id = 'trial-expired-overlay';
            overlay.innerHTML = `
                <div class="modal-content" style="max-width:520px;">
                    <div class="modal-header" style="background:#fffbeb; border-bottom:1px solid #fbbf24;">
                        <h3 style="color:#92400e; margin:0; font-size:1.1rem;">
                            <i class="fa-solid fa-clock" style="margin-right:8px;"></i>無料トライアルが終了しました
                        </h3>
                        <button class="btn-close" onclick="document.getElementById('trial-expired-overlay').remove()">×</button>
                    </div>
                    <div class="modal-body" style="padding:24px;">
                        <p style="margin-bottom:16px; color:#333; font-size:0.95rem;">
                            7日間の無料トライアル期間が終了しました。<br>
                            引き続きDIFFsenseをご利用いただくには、お支払い方法の登録が必要です。
                        </p>
                        <div style="background:#f0f9ff; border:1px solid #bae6fd; border-radius:8px; padding:16px; margin-bottom:20px;">
                            <p style="font-size:0.85rem; color:#0369a1; margin:0 0 8px 0; font-weight:600;">
                                <i class="fa-solid fa-info-circle" style="margin-right:6px;"></i>お支払い方法
                            </p>
                            <ul style="font-size:0.82rem; color:#555; margin:0; padding-left:20px;">
                                <li style="margin-bottom:4px;">PayPalアカウント</li>
                                <li>クレジットカード / デビットカード</li>
                            </ul>
                        </div>
                        <div style="display:flex; gap:12px; justify-content:flex-end;">
                            <button onclick="document.getElementById('trial-expired-overlay').remove()" class="btn-dashboard" style="padding:10px 20px;">後で</button>
                            <button onclick="document.getElementById('trial-expired-overlay').remove(); window.app.navigate('plan');" class="btn-dashboard" style="background:#0070ba; color:#fff; border:none; padding:10px 24px; font-weight:600;">
                                <i class="fa-solid fa-credit-card" style="margin-right:6px;"></i>お支払い方法を登録する
                            </button>
                        </div>
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);
        }
    }

    showCancelModal() {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'cancel-modal-overlay';
        overlay.innerHTML = `
            <div class="modal-content" style="max-width:480px;">
                <div class="modal-header" style="background:#fef2f2; border-bottom:1px solid #fecaca;">
                    <h3 style="color:#991b1b; margin:0; font-size:1.1rem;">
                        <i class="fa-solid fa-triangle-exclamation" style="margin-right:8px;"></i>プランのキャンセル
                    </h3>
                    <button class="btn-close" onclick="document.getElementById('cancel-modal-overlay').remove()">×</button>
                </div>
                <div class="modal-body" style="padding:24px;">
                    <p style="margin-bottom:16px; color:#333;">本当にプランをキャンセルしますか？</p>
                    <ul style="font-size:0.85rem; color:#666; margin-bottom:20px; padding-left:20px;">
                        <li style="margin-bottom:6px;">サブスクリプションが停止されます</li>
                        <li style="margin-bottom:6px;">Starterプラン（無料）に戻ります</li>
                        <li style="margin-bottom:6px;">AI解析回数が月15回に制限されます</li>
                    </ul>
                    <div style="display:flex; gap:12px; justify-content:flex-end;">
                        <button onclick="document.getElementById('cancel-modal-overlay').remove()" class="btn-dashboard" style="padding:8px 20px;">キャンセルしない</button>
                        <button onclick="window.app.executeCancelSubscription()" class="btn-dashboard" style="background:#d73a49; color:#fff; border:none; padding:8px 20px;">解約する</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
    }

    async executeCancelSubscription() {
        try {
            const authModule = await import('./auth.js');
            const token = await authModule.getIdToken();
            const apiUrl = `${aiService.API_BASE}/payment/cancel-subscription`;

            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            });
            const result = await response.json();

            // Close modal
            const modal = document.getElementById('cancel-modal-overlay');
            if (modal) modal.remove();

            if (result.success) {
                this.paymentStatus = { hasPaymentMethod: false };
                this.subscription.plan = 'starter';
                this.userPlan = 'starter';
                this.updateSubscriptionUI();
                Notify.success('プランがキャンセルされました。Starterプランに移行しました。');
                this.navigate('plan');
            } else {
                Notify.error('キャンセル処理でエラーが発生しました。');
            }
        } catch (error) {
            console.error('Cancel subscription error:', error);
            Notify.error('キャンセル処理でエラーが発生しました。');
        }
    }

    updateSubscriptionUI() {
        const container = document.getElementById('plan-status-container');
        if (!container) return;

        const sub = this.subscription;
        if (!sub) return;

        const planNames = {
            'starter': 'Starter',
            'business': 'Business',
            'pro': 'Pro / Legal'
        };

        const usagePercent = Math.min(100, (sub.usageCount / sub.usageLimit) * 100);
        const planName = planNames[sub.plan] || sub.plan;

        let upgradeAdvice = '';
        if (sub.usageCount >= sub.usageLimit) {
            if (sub.plan === 'starter') {
                upgradeAdvice = '<div class="upgrade-advice">月間上限に達しました。翌月まで待つか、Business以上のプランにすると回数が増えます。</div>';
            } else if (sub.plan === 'business') {
                upgradeAdvice = '<div class="upgrade-advice">月間上限に達しました。翌月まで待つか、Proプランにアップグレードすると回数が増えます。</div>';
            } else if (sub.plan === 'pro') {
                upgradeAdvice = '<div class="upgrade-advice">月間上限に達しました。翌月までお待ちいただくか、追加枠についてお問い合わせください。</div>';
            }
        }

        let statusHtml = `
            <div class="plan-status-card">
                <div class="plan-badge plan-badge-${sub.plan}">${planName}${sub.isInTrial ? '（トライアル）' : ''}</div>
                <div class="plan-info-text">
                    ${sub.isInTrial ? `残り期間: <strong>${sub.daysRemaining}日間</strong><br>` : ''}
                    AI解析: <strong>${sub.usageCount}</strong> / ${sub.usageLimit}回
                    ${sub.isInTrial ? `<br><small style="font-size: 0.75rem; opacity: 0.7;">通常枠: ${sub.planLimit}回</small>` : ''}
                </div>
                ${upgradeAdvice}
                ${sub.isInTrial ? `
                <div style="margin-top: 12px; font-size: 0.75rem; color: #a17e1a; border-top: 1px solid rgba(255, 255, 255, 0.05); padding-top: 8px;">
                    <i class="fa-solid fa-circle-info"></i> トライアル終了後、継続には決済登録が必要です。
                </div>
                ` : ''}
                ${(sub.isInTrial && this.paymentStatus && !this.paymentStatus.hasPaymentMethod) ? `
                <div onclick="window.app.navigate('plan')" style="margin-top:10px; padding:8px 10px; background:rgba(251,191,36,0.15); border:1px solid rgba(251,191,36,0.3); border-radius:6px; cursor:pointer; font-size:0.72rem; color:#fbbf24; text-align:center;">
                    <i class="fa-solid fa-credit-card" style="margin-right:4px;"></i>お支払い方法を登録
                </div>
                ` : ''}
            </div>
        `;

        container.innerHTML = statusHtml;
        this.updateUIByPlan();
    }

    updateUIByPlan() {
        if (!this.subscription) return;
        const plan = this.subscription.plan;
        const isInTrial = this.subscription.isInTrial;

        // --- Navigation Logic ---
        // Team Management: Business+, trial allowed
        const navTeam = document.querySelector('.nav-item[onclick*="navigate(\'team\')"]');
        if (plan === 'starter' && !isInTrial) {
            if (navTeam) navTeam.classList.add('feature-locked');
        } else {
            if (navTeam) {
                navTeam.classList.remove('feature-locked');
                navTeam.style.display = 'flex';
            }
        }
    }



    bindEvents() {
        const toggle = document.getElementById('sidebar-toggle');
        const sidebar = document.getElementById('app-sidebar');
        const overlay = document.getElementById('sidebar-overlay');

        const closeSidebar = () => {
            sidebar?.classList.remove('active');
            overlay?.classList.remove('active');
        };

        if (toggle && sidebar) {
            toggle.addEventListener('click', (e) => {
                e.stopPropagation();
                sidebar.classList.toggle('active');
                overlay?.classList.toggle('active');
            });
        }

        if (overlay) {
            overlay.addEventListener('click', closeSidebar);
        }

        // URL Modal Submit Binding
        const submitUrlBtn = document.getElementById('submit-url-btn');
        if (submitUrlBtn) {
            submitUrlBtn.onclick = () => {
                const urlInput = document.getElementById('new-version-url');
                const url = urlInput ? urlInput.value.trim() : "";
                if (!url) {
                    Notify.warning('URLを入力してください');
                    return;
                }
                const contractId = submitUrlBtn.getAttribute('data-contract-id');
                this.handleUrlVersionSubmit(contractId, url);
            };
        }
    }

    navigate(viewId, params = null) {
        console.log(`Navigating to ${viewId}`, params);

        // Auto-close sidebar on mobile
        document.getElementById('app-sidebar')?.classList.remove('active');
        document.getElementById('sidebar-overlay')?.classList.remove('active');

        // RBAC: Protect team view - Allow if Business+ OR Trial
        if (viewId === 'team' && this.subscription?.plan === 'starter' && !this.subscription?.isInTrial) {
            const upgradeModal = document.getElementById('upgrade-modal');
            if (upgradeModal) {
                upgradeModal.classList.add('active');
            }
            return;
        }

        if (viewId === 'history') {
            dbService.cleanupLogs(this.userPlan || 'starter');
        }

        this.currentView = viewId;

        // Toggle Fluid Layout Mode for Detail View
        if (viewId === 'diff') {
            this.mainContent.classList.add('is-detail-view');
        } else {
            this.mainContent.classList.remove('is-detail-view');
        }

        if (viewId !== 'contracts') {
            this.searchQuery = "";
            this.currentPage = 1;
        }

        let renderParams = params;
        if (viewId === 'contracts') {
            renderParams = {
                page: this.currentPage,
                ...this.filters,
                ...params
            };
        }
        if (viewId === 'diff') {
            this.currentViewParams = params;
        }

        const navMap = {
            'dashboard': 0, 'contracts': 1, 'history': 2, 'team': 3, 'plan': 4
        };

        // Update active menu state
        document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
        const navItems = document.querySelectorAll('.nav-item');
        // Find by content or click handler match
        navItems.forEach(item => {
            const onclick = item.getAttribute('onclick');
            if (onclick && onclick.includes(`navigate('${viewId}')`)) {
                item.classList.add('active');
            }
        });

        if (Views[viewId]) {
            try {
                this.mainContent.innerHTML = Views[viewId](renderParams);

                const titles = {
                    'dashboard': 'ダッシュボード',
                    'plan': 'プラン管理',
                    'contracts': '契約・規約管理',
                    'diff': '解析詳細',
                    'history': '履歴・ログ',
                    'team': 'チーム設定'
                };
                this.pageTitle.textContent = titles[viewId] || 'DIFFsense';

                window.scrollTo(0, 0);

                if (viewId === 'contracts' && this.filters.query) {
                    const searchInput = document.getElementById('contract-search');
                    if (searchInput) {
                        searchInput.focus();
                        searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);
                    }
                }
            } catch (error) {
                console.error(`View Render Error (${viewId}):`, error);
                this.mainContent.innerHTML = '<div class="p-md text-danger">画面の表示中にエラーが発生しました。</div>';
            }
        }
    }

    setDashboardFilter(filter) {
        this.dashboardFilter = filter;
        const filteredItems = dbService.getFilteredContracts(filter);

        const titleEl = document.getElementById('dashboard-section-title');
        if (titleEl) {
            let sectionTitle = "要確認アイテム (優先度順)";
            if (filter === 'pending') sectionTitle = "未処理のアイテム (新着・変更検知)";
            if (filter === 'risk') sectionTitle = "リスク要判定アイテム";
            if (filter === 'total') sectionTitle = "全監視対象（最新順）";
            titleEl.textContent = sectionTitle;
        }

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

                const actionBtn = window.app.can('operate_contract')
                    ? `<button class="btn-dashboard">${c.status === '確認済' ? '履歴を見る' : '確認する'}</button>`
                    : `<button class="btn-dashboard">詳細を見る</button>`;

                return `
                    <tr onclick="window.app.navigate('diff', ${c.id})">
                        <td><span class="badge ${riskBadgeClass}">${c.risk_level}</span></td>
                        <td class="col-name" title="${c.name}">${c.name}</td>
                        <td>${c.last_updated_at}</td>
                        <td>${statusBadge}</td>
                        <td>${actionBtn}</td>
                    </tr>
                `;
            }).join('') : '<tr><td colspan="5" class="text-center text-muted" style="padding:40px;">該当するアイテムはありません</td></tr>';
            tableBody.innerHTML = rows;
        }

        document.querySelectorAll('.stat-card').forEach(card => {
            card.classList.remove('active');
            const isActive = (filter === 'pending' && card.textContent.includes('未処理')) ||
                (filter === 'risk' && card.textContent.includes('リスク要判定')) ||
                (filter === 'total' && card.textContent.includes('監視中'));
            if (isActive) card.classList.add('active');
        });
    }

    // --- Action Handlers ---

    updateFilter(key, value) {
        this.filters[key] = value;
        this.currentPage = 1;

        if (key === 'query') {
            clearTimeout(this.searchTimeout);
            this.searchTimeout = setTimeout(() => this.navigate('contracts'), 300);
        } else {
            this.navigate('contracts');
        }
    }

    setDetailTab(tab) {
        this.activeDetailTab = tab;
        this.navigate('diff', this.currentViewParams);
    }

    changePage(newPage) {
        this.currentPage = newPage;
        this.navigate('contracts', { page: newPage });
    }

    confirmContract(id) {
        if (dbService.updateContractStatus(id, '確認済')) {
            // Switch to 'Monitoring' (Total) view and go back to dashboard
            this.dashboardFilter = 'total';
            this.navigate('dashboard');
        }
    }

    async analyzeContract(id) {
        const contract = dbService.getContractById(id);
        if (!contract) {
            Notify.error('契約が見つかりません');
            return;
        }

        if (!contract.original_content) {
            Notify.error('元のテキストが見つかりません。再度登録してください。');
            return;
        }

        // 確認ダイアログ
        if (!await Notify.confirm(`「${contract.name}」の差分解析を実行しますか？\n\nAI解析により、リスク判定と変更箇所の抽出を行います。`, { title: '確認', type: 'info' })) {
            return;
        }

        try {
            // ローディング表示
            const loadingMsg = document.createElement('div');
            loadingMsg.style.cssText = 'position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); background:white; padding:30px; border-radius:8px; box-shadow:0 4px 20px rgba(0,0,0,0.3); z-index:10000; text-align:center;';
            loadingMsg.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="font-size:32px; color:#4CAF50;"></i><br><br><strong>AI解析中...</strong><br><span style="font-size:12px; color:#666;">数秒お待ちください</span>';
            document.body.appendChild(loadingMsg);

            // AI解析を実行（previousVersionとして元のテキストを使用）
            const result = await aiService.analyzeContract(
                id,
                'text',  // テキストとして送信
                contract.original_content,
                null  // 将来的には旧バージョンとの比較に使用
            );

            // ローディング削除
            document.body.removeChild(loadingMsg);

            if (result.success) {
                // 解析結果をDBに保存
                dbService.updateContractAnalysis(id, {
                    extractedText: contract.original_content,  // 既存のテキストを保持
                    changes: result.data.changes,
                    riskLevel: result.data.riskLevel,
                    riskReason: result.data.riskReason,
                    summary: result.data.summary,
                    status: '未確認'  // 解析完了、確認待ち
                });

                // 画面を再読み込み
                this.navigate('diff', id);

                Notify.success('AI解析が完了しました！リスク判定と差分抽出が完了しました。');
            } else {
                throw new Error(result.error || '解析に失敗しました');
            }

        } catch (error) {
            console.error('AI解析エラー:', error);
            Notify.error(`AI解析中にエラーが発生しました: ${error.message}`);
        }
    }

    uploadNewVersion(id) {
        const contract = dbService.getContractById(id);
        if (!contract) {
            Notify.error('契約が見つかりません');
            return;
        }

        // URL形式の場合はURL入力モーダルを表示
        if (contract.source_url || contract.source_type === 'URL') {
            const urlModal = document.getElementById('url-input-modal');
            const urlInput = document.getElementById('new-version-url');
            const submitUrlBtn = document.getElementById('submit-url-btn');

            if (urlModal) {
                if (urlInput) urlInput.value = contract.source_url || "";
                if (submitUrlBtn) submitUrlBtn.setAttribute('data-contract-id', id);
                urlModal.classList.add('active');
            }
            return;
        }

        // それ以外（PDF）はファイル選択ダイアログを表示
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/pdf';

        // input.click() をトリガーする前にイベントハンドラを設定
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            if (file.type !== 'application/pdf') {
                Notify.warning('PDFファイルを選択してください');
                return;
            }

            const performAnalysis = async (retryCount = 0) => {
                try {
                    // ローディング表示
                    const loadingMsg = document.createElement('div');
                    loadingMsg.id = 'analysis-loading';
                    loadingMsg.style.cssText = 'position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); background:white; padding:30px; border-radius:8px; box-shadow:0 4px 20px rgba(0,0,0,0.3); z-index:10000; text-align:center; min-width:300px;';
                    loadingMsg.innerHTML = `<div class="custom-loader"></div><br><strong>PDFドキュメントを解析中...${retryCount > 0 ? '(再試行中)' : ''}</strong><br><span style="font-size:12px; color:#666;">テキストデータとレイアウトを抽出しています<br>※スキャンデータなどは時間がかかる場合があります</span>`;
                    document.body.appendChild(loadingMsg);

                    // 背景オーバーレイ
                    let overlay = document.getElementById('analysis-overlay');
                    if (!overlay) {
                        overlay = document.createElement('div');
                        overlay.id = 'analysis-overlay';
                        overlay.style.cssText = 'position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); z-index:9999;';
                        document.body.appendChild(overlay);
                    }

                    // UI描画待ち
                    await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 50)));

                    // 事前にトークンをリフレッシュ（念のため）
                    try {
                        const { getIdToken } = await import('./auth.js');
                        await getIdToken();
                        console.log("Token refreshed before upload");
                    } catch (e) {
                        console.warn("Token pre-refresh failed:", e);
                    }

                    // PDFをBase64に変換
                    const base64Data = await aiService.convertFileToBase64(file);

                    // 旧バージョンのテキストを取得
                    const previousVersion = contract.original_content;

                    // AI解析を実行（差分検出）
                    const result = await aiService.analyzeContract(
                        id,
                        'pdf',
                        base64Data,
                        previousVersion
                    );

                    // ローディング削除
                    if (document.getElementById('analysis-loading')) document.getElementById('analysis-loading').remove();
                    if (document.getElementById('analysis-overlay')) document.getElementById('analysis-overlay').remove();

                    if (result.success) {
                        // 解析結果をDBに保存
                        dbService.updateContractAnalysis(id, {
                            extractedText: result.data.extractedText,
                            extractedTextHash: result.data.extractedTextHash,
                            extractedTextLength: result.data.extractedTextLength,
                            sourceType: result.data.sourceType,
                            pdfStoragePath: result.data.pdfStoragePath,
                            pdfUrl: result.data.pdfUrl,
                            changes: result.data.changes,
                            riskLevel: result.data.riskLevel,
                            riskReason: result.data.riskReason,
                            summary: result.data.summary,
                            status: '未確認',
                            originalFilename: file.name
                        });

                        // 画面を再読み込み (差分表示を優先)
                        this.activeDetailTab = 'diff';
                        this.navigate('diff', id);

                        // 部分的な失敗（AI解析のみ失敗）のチェック
                        const aiFailed = result.data.aiFailed || (result.data.riskReason && result.data.riskReason.includes("AI解析サーバーからの応答がありませんでした"));
                        if (aiFailed) {
                            if (await Notify.confirm('AI解析に失敗しました。\n\nテキストデータの取り込みは完了しましたが、AIによるリスク判定ができませんでした。\n\n※ 解析失敗時は利用回数を消費しません。\nもう一度解析を試みますか？', { title: '確認', type: 'warning' })) {
                                await performAnalysis(retryCount + 1);
                                return;
                            } else {
                                this.showToast('⚠️ 解析は不完全ですが保存しました', 'warning', 5000);
                            }
                        } else {
                            this.showToast('✅ 差分解析が完了しました', 'success', 5000);
                        }

                    } else {
                        throw new Error(result.error || '解析に失敗しました');
                    }

                } catch (error) {
                    console.error('AI解析エラー:', error);
                    if (document.getElementById('analysis-loading')) document.getElementById('analysis-loading').remove();
                    if (document.getElementById('analysis-overlay')) document.getElementById('analysis-overlay').remove();

                    if (await Notify.confirm(`エラーが発生しました: ${error.message}\n\nもう一度試しますか？`, { title: '確認', type: 'error' })) {
                        await performAnalysis(retryCount + 1);
                    }
                }
            };

            await performAnalysis();
        };

        // ファイル選択ダイアログを表示
        input.click();
    }

    /**
     * URL版の新しいバージョンを解析して保存
     */
    async handleUrlVersionSubmit(id, url) {
        const urlModal = document.getElementById('url-input-modal');
        const contract = dbService.getContractById(id);

        const performUrlAnalysis = async (retryCount = 0) => {
            try {
                // ローディング表示
                const loadingMsg = document.createElement('div');
                loadingMsg.id = 'analysis-loading';
                loadingMsg.style.cssText = 'position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); background:white; padding:30px; border-radius:8px; box-shadow:0 4px 20px rgba(0,0,0,0.3); z-index:10000; text-align:center; min-width:300px;';
                loadingMsg.innerHTML = `<div class="custom-loader"></div><br><strong>指定されたURLを解析中...${retryCount > 0 ? '(再試行中)' : ''}</strong><br><span style="font-size:12px; color:#666;">最新のコンテンツを取得して差分を抽出しています</span>`;
                document.body.appendChild(loadingMsg);

                // 背景オーバーレイ
                let overlay = document.getElementById('analysis-overlay');
                if (!overlay) {
                    overlay = document.createElement('div');
                    overlay.id = 'analysis-overlay';
                    overlay.style.cssText = 'position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); z-index:9999;';
                    document.body.appendChild(overlay);
                }

                if (urlModal) urlModal.classList.remove('active');

                // UI描画待ち
                await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 50)));

                // AI解析を実行（URLメソッド）
                const result = await aiService.analyzeContract(
                    id,
                    'url',
                    url,
                    contract.original_content // 旧バージョンのテキスト
                );

                // ローディング削除
                if (document.getElementById('analysis-loading')) document.getElementById('analysis-loading').remove();
                if (document.getElementById('analysis-overlay')) document.getElementById('analysis-overlay').remove();

                if (result.success) {
                    // 解析結果をDBに保存
                    dbService.updateContractAnalysis(id, {
                        extractedText: result.data.extractedText,
                        sourceUrl: url,
                        sourceType: 'URL',
                        changes: result.data.changes,
                        riskLevel: result.data.riskLevel,
                        riskReason: result.data.riskReason,
                        summary: result.data.summary,
                        status: '未確認'
                    });

                    // 画面を再読み込み (差分表示を優先)
                    this.activeDetailTab = 'diff';
                    this.navigate('diff', id);
                    Notify.success('最新バージョンの取り込みとAI解析が完了しました！');
                } else {
                    throw new Error(result.error || '解析に失敗しました');
                }

            } catch (error) {
                console.error('URL AI Service Error:', error);
                if (document.getElementById('analysis-loading')) document.getElementById('analysis-loading').remove();
                if (document.getElementById('analysis-overlay')) document.getElementById('analysis-overlay').remove();

                if (await Notify.confirm(`エラーが発生しました: ${error.message}\n\nもう一度試しますか？`, { title: '確認', type: 'error' })) {
                    await performUrlAnalysis(retryCount + 1);
                }
            }
        };

        await performUrlAnalysis();
    }

    showSuccessModal(title, message) {
        // 既存のモダルがあれば削除
        const existing = document.getElementById('success-modal');
        if (existing) existing.remove();

        const modal = document.createElement('div');
        modal.id = 'success-modal';
        modal.style.cssText = 'position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:11000; animation: fadeIn 0.3s;';

        modal.innerHTML = `
            <div style="background:white; width:90%; max-width:450px; border-radius:12px; padding:32px; text-align:center; box-shadow:0 10px 40px rgba(0,0,0,0.2); animation: slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1);">
                <div style="width:60px; height:60px; background:#e6ffed; border-radius:50%; display:flex; align-items:center; justify-content:center; margin:0 auto 20px; color:#28a745; font-size:30px;">
                    <i class="fa-solid fa-check"></i>
                </div>
                <h3 style="margin:0 0 12px; color:#24292E; font-size:20px; font-weight:700;">${title}</h3>
                <p style="margin:0 0 24px; color:#586069; font-size:14px; line-height:1.6;">${message}</p>
                <button class="btn-dashboard btn-primary-action" style="padding:10px 32px; font-size:14px;" onclick="document.getElementById('success-modal').remove()">OK</button>
            </div>
        `;
        document.body.appendChild(modal);

        // アニメーション用スタイル定義（なければ追加）
        if (!document.getElementById('modal-styles')) {
            const style = document.createElement('style');
            style.id = 'modal-styles';
            style.innerText = `
                @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
                @keyframes slideUp { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
            `;
            document.head.appendChild(style);
        }
    }

    addMemo(id) {
        const input = document.getElementById('modal-memo-input');
        if (input && input.value.trim()) {
            const contract = dbService.getContractById(id);
            dbService.addActivityLog(`Memo: ${input.value}`, contract.name);

            // モダル内のリストを更新
            this.showHistoryModal(id);
        }
    }

    showHistoryModal(id) {
        const contract = dbService.getContractById(id);
        // systemのログ（自動生成ログ）を除外し、ユーザーのメモやアクションのみを表示
        const logs = dbService.getActivityLogs().filter(l => l.target_name === contract.name && l.actor !== 'system');

        // 既存のモダルがあれば削除
        const existing = document.getElementById('history-modal');
        if (existing) existing.remove();

        const modal = document.createElement('div');
        modal.id = 'history-modal';
        modal.className = 'modal-overlay active';

        const logsHtml = logs.length > 0 ? logs.map(l => `
            <div style="padding:12px; border-bottom:1px solid #eee;">
                <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
                    <span style="font-weight:600; font-size:12px; color:#333;">${l.actor}</span>
                    <span style="font-size:11px; color:#999;">${l.created_at}</span>
                </div>
                <div style="font-size:13px; color:#555;">${l.action}</div>
            </div>
        `).join('') : '<div style="padding:20px; text-align:center; color:#999;">履歴はありません</div>';

        modal.innerHTML = `
            <div class="modal-content" style="max-width:600px;">
                <div class="modal-header">
                    <h3>メモ</h3>
                    <button class="btn-close" onclick="document.getElementById('history-modal').remove()">&times;</button>
                </div>
                <div class="modal-body" style="padding:0;">
                    <div style="max-height:300px; overflow-y:auto; background:#f9f9f9;">
                        ${logsHtml}
                    </div>
                    <div style="padding:16px; border-top:1px solid #ddd; background:#fff;">
                        <textarea id="modal-memo-input" style="width:100%; border:1px solid #ddd; padding:10px; border-radius:4px; font-family:inherit; min-height:80px; resize:vertical; margin-bottom:10px;" placeholder="メモを入力..."></textarea>
                        <button class="btn-dashboard btn-primary-action" style="width:100%;" onclick="window.app.addMemo(${id})">メモを記録</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    }

    updateUserRole(email, newRole) {
        if (dbService.updateUserRole(email, newRole)) {
            console.log(`Role updated for ${email} to ${newRole} `);
        }
    }

    showLogDetails(logId) {
        const logs = dbService.getActivityLogs();
        const log = logs.find(l => l.id === logId);
        if (!log) return;

        const modalId = 'log-detail-modal';
        const existing = document.getElementById(modalId);
        if (existing) existing.remove();

        const modal = document.createElement('div');
        modal.id = modalId;
        modal.classList.add('modal-overlay', 'active');
        modal.style.zIndex = '12000';

        let statusColor = '#586069';
        if (log.status === '成功') statusColor = '#28a745';
        else if (log.status === '失敗') statusColor = '#d73a49';
        else if (log.status === 'スキップ') statusColor = '#005cc5';

        modal.innerHTML = `
            <div class="modal-content" style="max-width: 500px; padding: 0; overflow: hidden; border-radius: 12px; border: none; box-shadow: 0 20px 60px rgba(0,0,0,0.3);">
                <div style="background: #fafbfc; padding: 20px 24px; border-bottom: 1px solid #e1e4e8; display: flex; justify-content: space-between; align-items: center;">
                    <h3 style="margin: 0; font-size: 16px; color: #24292e; font-weight: 700;">ログ詳細（閲覧専用）</h3>
                    <button class="btn-close" onclick="document.getElementById('${modalId}').remove()">&times;</button>
                </div>
                <div style="padding: 24px;">
                    <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
                        <tr style="border-bottom: 1px solid #f6f8fa;">
                            <td style="padding: 12px 0; color: #586069; width: 120px;">日時</td>
                            <td style="padding: 12px 0; font-weight: 600;">${log.created_at}</td>
                        </tr>
                        <tr style="border-bottom: 1px solid #f6f8fa;">
                            <td style="padding: 12px 0; color: #586069;">実行種別</td>
                            <td style="padding: 12px 0; font-weight: 600;">${log.action}</td>
                        </tr>
                        <tr style="border-bottom: 1px solid #f6f8fa;">
                            <td style="padding: 12px 0; color: #586069;">対象</td>
                            <td style="padding: 12px 0; font-weight: 600;">${log.target_name}</td>
                        </tr>
                        <tr style="border-bottom: 1px solid #f6f8fa;">
                            <td style="padding: 12px 0; color: #586069;">実行者</td>
                            <td style="padding: 12px 0; font-weight: 600;">${log.actor}</td>
                        </tr>
                        <tr>
                            <td style="padding: 12px 0; color: #586069;">結果ステータス</td>
                            <td style="padding: 12px 0; font-weight: 600; color: ${statusColor};">
                                <i class="fa-solid ${log.status === '成功' ? 'fa-circle-check' : (log.status === '失敗' ? 'fa-circle-xmark' : 'fa-circle-info')}" style="margin-right: 6px;"></i>
                                ${log.status || '成功'}
                            </td>
                        </tr>
                    </table>
                    <div style="margin-top: 24px; padding: 12px; background: #f8f9fa; border-radius: 6px; font-size: 12px; color: #586069; line-height: 1.5;">
                        <i class="fa-solid fa-circle-info"></i> ※この画面は証跡確認のみ可能です。AIの再実行、差分の再表示等の高コスト操作はこの画面からは行えません。必要な場合は各契約情報の詳細画面から操作してください。
                    </div>
                </div>
                <div style="padding: 16px 24px; background: #fafbfc; border-top: 1px solid #e1e4e8; text-align: right;">
                    <button class="btn-dashboard" onclick="document.getElementById('${modalId}').remove()" style="padding: 8px 24px;">閉じる</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        // Handle click outside to close
        modal.onclick = (e) => {
            if (e.target === modal) modal.remove();
        };
    }

    // --- Team Management ---
    showInviteModal() {
        const users = dbService.getUsers();
        const limit = dbService.PLAN_LIMITS[this.userPlan] || 1;

        if (users.length >= limit) {
            const upgradeMessage = (this.userPlan === 'pro')
                ? 'さらにメンバーを追加するには、法人向け個別エンタープライズプランのご相談を承ります。サポートまでお問い合わせください。'
                : 'さらにメンバーを追加するにはプランをアップグレードしてください。';

            this.showAlertModal(
                '人数制限',
                `現在のプラン（${this.userPlan}）では、最大${limit}名までしか登録できません。<br>${upgradeMessage}`,
                'warning'
            );
            return;
        }

        document.getElementById('invite-name').value = '';
        document.getElementById('invite-email').value = '';
        document.getElementById('invite-role').value = '閲覧のみ';
        document.getElementById('invite-member-modal').classList.add('active');
    }

    showAlertModal(title, message, type = 'error') {
        const existing = document.getElementById('alert-modal');
        if (existing) existing.remove();

        const modal = document.createElement('div');
        modal.id = 'alert-modal';
        modal.style.cssText = 'position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:11000; animation: fadeIn 0.3s;';

        const iconColor = type === 'error' ? '#dc3545' : '#ffc107';
        const iconClass = type === 'error' ? 'fa-circle-xmark' : 'fa-triangle-exclamation';
        const bgColor = type === 'error' ? '#fde8e8' : '#fff3cd';

        modal.innerHTML = `
            <div style="background:white; width:90%; max-width:450px; border-radius:12px; padding:32px; text-align:center; box-shadow:0 10px 40px rgba(0,0,0,0.2); animation: slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1);">
                <div style="width:60px; height:60px; background:${bgColor}; border-radius:50%; display:flex; align-items:center; justify-content:center; margin:0 auto 20px; color:${iconColor}; font-size:30px;">
                    <i class="fa-solid ${iconClass}"></i>
                </div>
                <h3 style="margin:0 0 12px; color:#24292E; font-size:20px; font-weight:700;">${title}</h3>
                <p style="margin:0 0 24px; color:#586069; font-size:14px; line-height:1.6;">${message}</p>
                <button class="btn-dashboard btn-primary-action" style="padding:10px 32px; font-size:14px;" onclick="document.getElementById('alert-modal').remove()">OK</button>
            </div>
        `;
        document.body.appendChild(modal);
    }

    async submitInvite() {
        const name = document.getElementById('invite-name').value;
        const email = document.getElementById('invite-email').value;
        const role = document.getElementById('invite-role').value;

        if (!name || !email) {
            Notify.warning('名前とメールアドレスを入力してください');
            return;
        }

        const result = dbService.addUser(name, email, role, this.userPlan);

        if (result.success) {
            document.getElementById('invite-member-modal').classList.remove('active');
            this.navigate('team');

            // Send Email via Backend
            try {
                await aiService.sendInvite(email, name, role);
                this.showSuccessModal('招待送信完了', 'メンバーを追加し、招待メールを送信しました。');
            } catch (error) {
                console.error('Email send failed:', error);
                this.showAlertModal('送信エラー', 'メンバーは追加されましたが、招待メールの送信に失敗しました。<br>サーバーログを確認してください。', 'warning');
            }
        } else {
            if (result.error === 'already_exists') {
                this.showAlertModal('登録エラー', 'このメールアドレスは既に登録されています。<br>別のメールアドレスを使用するか、既存のメンバーを編集してください。');
            } else if (result.error === 'limit_reached') {
                const upgradeMsg = (this.userPlan === 'pro')
                    ? 'さらにメンバーを追加するには、法人向け個別エンタープライズプランのご相談をお受けします。'
                    : 'さらにメンバーを増やすには、上位プランへのアップグレードをご検討ください。';

                this.showAlertModal(
                    '登録エラー',
                    `人数制限（${result.limit}名）に達しました。${upgradeMsg}`,
                    'error'
                );
            } else {
                this.showAlertModal('登録エラー', 'メンバーの追加に失敗しました。');
            }
        }
    }

    showEditMemberModal(email) {
        const users = dbService.getUsers();
        const user = users.find(u => u.email === email);
        if (user) {
            document.getElementById('edit-original-email').value = user.email;
            // If name is same as email (default), show placeholder or empty
            document.getElementById('edit-name').value = (user.name === user.email) ? '' : user.name;
            document.getElementById('edit-email').value = user.email;
            document.getElementById('edit-role').value = user.role;

            // Protect current user from deletion
            const deleteBtn = document.querySelector('#edit-member-modal .btn-danger-action');
            if (this.currentUser && user.email === this.currentUser.email) {
                deleteBtn.style.display = 'none';
                // Optional: Disable role change for self to prevent lockout
                document.getElementById('edit-role').disabled = true;
            } else {
                deleteBtn.style.display = 'block';
                document.getElementById('edit-role').disabled = false;
            }

            document.getElementById('edit-member-modal').classList.add('active');
        }
    }

    updateMember() {
        const originalEmail = document.getElementById('edit-original-email').value;
        const name = document.getElementById('edit-name').value;
        const role = document.getElementById('edit-role').value;

        if (dbService.updateUser(originalEmail, { name, role })) {
            document.getElementById('edit-member-modal').classList.remove('active');
            this.navigate('team');
        } else {
            Notify.error('更新に失敗しました');
        }
    }

    deleteMember() {
        const email = document.getElementById('edit-original-email').value;

        // Final safeguard against self-deletion
        if (this.currentUser && email === this.currentUser.email) {
            Notify.warning('自分自身のアカウントは削除できません。');
            return;
        }

        // Just show the confirmation modal
        document.getElementById('delete-confirm-modal').classList.add('active');
    }

    executeDeleteMember() {
        const email = document.getElementById('edit-original-email').value;
        if (dbService.deleteUser(email)) {
            document.getElementById('delete-confirm-modal').classList.remove('active'); // Close confirm modal
            document.getElementById('edit-member-modal').classList.remove('active');   // Close edit modal
            this.navigate('team');
        } else {
            Notify.error('削除に失敗しました（管理者は削除できない場合があります）');
            document.getElementById('delete-confirm-modal').classList.remove('active');
        }
    }

    /**
     * 定期監視のON/OFFを切り替える
     */
    toggleMonitoring(id, enabled) {
        dbService.toggleMonitoring(id, enabled);
        this.navigate('diff', id);
    }

    /**
     * 手動クローリングを実行
     */
    async manualCrawl(id) {
        const contract = dbService.getContractById(id);
        if (!contract || !contract.source_url) return;

        try {
            Notify.info('URLをチェックしています...');

            const authModule = await import('./auth.js');
            const token = await authModule.getIdToken();

            const response = await fetch(`${aiService.API_BASE}/crawl`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    url: contract.source_url,
                    lastHash: contract.last_hash
                })
            });

            const result = await response.json();
            // loading complete

            if (result.success) {
                dbService.updateCrawlResult(id, result);

                if (result.changed) {
                    if (await Notify.confirm('更新（差分）が検知されました。AI解析を実行して内容を確認しますか？\n（解析回数を1回消費します）', { title: '確認', type: 'info' })) {
                        await this.performAIAnalysis(id);
                    } else {
                        this.navigate('diff', id);
                    }
                } else {
                    Notify.info('更新はありませんでした。');
                    this.navigate('diff', { id });
                }
            } else {
                throw new Error(result.error || 'クローリングに失敗しました');
            }
        } catch (error) {
            // loading complete
            console.error('Manual Crawl Error:', error);
            Notify.error('エラー: ' + error.message);
        }
    }

    /**
     * AI解析を実行（共通ロジック）
     */
    async performAIAnalysis(id) {
        const contract = dbService.getContractById(id);
        const fbModule = await import('./firebase-config.js');
        const user = fbModule.auth.currentUser;

        if (!user) {
            Notify.warning('セッションが切れました。再ログインしてください。');
            return;
        }

        try {
            Notify.info('AI解析を実行中...');
            const idToken = await fbModule.auth.currentUser.getIdToken();

            // 履歴用の前バージョン内容を取得
            const previousVersion = contract.original_content;

            const response = await fetch(`${aiService.API_BASE}/contracts/analyze`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${idToken}`
                },
                body: JSON.stringify({
                    contractId: contract.id,
                    method: 'url',
                    source: contract.source_url,
                    previousVersion: previousVersion
                })
            });

            const resData = await response.json();
            // loading complete

            if (resData.success) {
                dbService.updateContractAnalysis(id, resData.data);
                this.navigate('diff', id);
            } else {
                throw new Error(resData.error || '解析に失敗しました');
            }
        } catch (error) {
            // loading complete
            console.error('AI Analysis Error:', error);
            Notify.error('解析エラー: ' + error.message);
        }
    }




    viewHistory(contractId, version) {
        const contract = dbService.getContractById(contractId);
        if (!contract || !contract.history) return;

        const historyItem = contract.history.find(h => h.version === version);
        if (!historyItem) return;

        // 【修正】モーダルは使用せず、右側のペインに直接表示する（インライン表示）
        // 既存のモーダルがあれば削除（念のため）
        document.querySelectorAll('.modal').forEach(m => m.remove());

        // 右側のペインを取得 (Diffビューの構成に依存: .pane の2つ目)
        const panes = document.querySelectorAll('.pane');
        if (panes.length < 2) {
            // もしDiffビューでない場合、一旦移動してからリトライ
            this.navigate('diff', contractId);
            setTimeout(() => this.viewHistory(contractId, version), 300);
            return;
        }

        const rightPane = panes[1];

        // ヘッダーを一時的に書き換え（ハイライト）
        rightPane.querySelector('.pane-header').style.background = '#fff8e1';
        rightPane.querySelector('.pane-header').style.borderBottom = '1px solid #ffe0b2';

        // ヘッダー内容を書き換え
        rightPane.querySelector('.pane-header').innerHTML = `
            <div style="display:flex; justify-content:center; align-items:center; width:100%; position:relative;">
                <span style="position:absolute; left:0; font-weight:bold; color:#d4a017; display:flex; align-items:center; font-size:12px;">
                    <i class="fa-solid fa-clock-rotate-left" style="margin-right:6px;"></i> Version ${version} 
                </span>
                <button class="btn-dashboard" onclick="window.app.navigate('diff', ${contractId})" style="background:#fff; border:1px solid #c5a059; font-weight:600; font-size:13px; padding:6px 20px; color:#c5a059; border-radius:20px; transition:all 0.2s;">
                    <i class="fa-solid fa-rotate-left"></i> 最新版(原本)に戻す
                </button>
            </div>
        `;

        // タブとサブ情報を非表示にする
        const tabsRow = rightPane.querySelector('.tabs-row');
        if (tabsRow) tabsRow.style.display = 'none';

        // サブ情報（ファイル名など）を非表示にする
        // tabs-rowの次の要素を想定
        if (tabsRow && tabsRow.nextElementSibling) {
            tabsRow.nextElementSibling.style.display = 'none';
        }

        // コンテンツエリアを書き換え
        const contentArea = rightPane.querySelector('.document-content');
        if (contentArea) {
            // スクロールをトップへ
            const scrollArea = rightPane.querySelector('.pane-scroll-area');
            if (scrollArea) {
                scrollArea.scrollTop = 0;
                scrollArea.style.background = '#fafffd'; // 少し背景色を変える
            }

            // テキストを挿入
            contentArea.textContent = historyItem.content;
            contentArea.style.color = '#444';
        }

        // this.showToast(`Version ${version} をプレビュー中`, 'info'); // ポップアップ非表示
    }


    exportCSV() {
        if (this.subscription?.plan !== 'pro') return;

        // Get filters from current state
        const filters = this.filters || {};
        const contracts = dbService.getContracts().filter(c => {
            if (filters.query) {
                const q = filters.query.toLowerCase();
                const match = c.name.toLowerCase().includes(q) ||
                    c.type.toLowerCase().includes(q) ||
                    c.assignee_name.toLowerCase().includes(q);
                if (!match) return false;
            }
            if (filters.risk && filters.risk !== 'all') {
                if (c.risk_level !== filters.risk) return false;
            }
            if (filters.status && filters.status !== 'all') {
                if (c.status !== filters.status) return false;
            }
            if (filters.type && filters.type !== 'all') {
                if (c.type !== filters.type) return false;
            }
            return true;
        });

        // CSV Generation with Escaping
        const headers = ["契約名", "ステータス", "リスクレベル", "最終更新日"];
        const rows = contracts.map(c => [
            c.name,
            c.status,
            c.risk_level || '-',
            c.last_updated_at
        ]);

        const escapeCSV = (str) => {
            if (str === null || str === undefined) return '';
            const s = String(str);
            if (s.includes(',') || s.includes('"') || s.includes('\n')) {
                return `"${s.replace(/"/g, '""')}"`;
            }
            return s;
        };

        let csvContent = "\uFEFF"; // UTF-8 BOM for Excel
        csvContent += headers.map(escapeCSV).join(",") + "\n";
        csvContent += rows.map(row => row.map(escapeCSV).join(",")).join("\n");

        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.setAttribute("href", url);
        link.setAttribute("download", `契約一覧_${new Date().toISOString().split('T')[0]}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }

    async exportPDF(contractId) {
        if (this.subscription?.plan !== 'pro') return;

        const contract = dbService.getContractById(contractId);
        if (!contract) return;

        this.showToast('PDFレポートを生成中...', 'info');

        try {
            // 1. Create a structured report in a hidden container
            const reportId = 'pdf-export-container';
            let container = document.getElementById(reportId);
            if (!container) {
                container = document.createElement('div');
                container.id = reportId;
                // Off-screen but visible to the renderer
                container.style.position = 'absolute';
                container.style.left = '-9999px';
                container.style.width = '800px';
                container.style.background = 'white';
                container.style.color = '#333';
                container.style.fontFamily = "'Noto Sans JP', sans-serif";
                document.body.appendChild(container);
            }

            // 2. Build Report Content (Japanese text included)
            const riskColor = contract.risk_level === 'High' ? '#D73A49' : (contract.risk_level === 'Medium' ? '#f1c40f' : '#2ecc71');
            const analysisDate = new Date().toLocaleString('ja-JP');

            // Each direct child div = one section for page-break control
            container.innerHTML = `
                <div style="padding: 40px; line-height: 1.6;">
                    <!-- Section: Header -->
                    <div style="border-bottom: 2px solid #c19b4a; padding-bottom: 10px; margin-bottom: 20px; display: flex; justify-content: space-between; align-items: flex-end;">
                        <h1 style="margin: 0; color: #c19b4a; font-size: 24px;">DIFFsense AI解析レポート</h1>
                        <span style="font-size: 12px; color: #888;">出力日: ${analysisDate}</span>
                    </div>

                    <!-- Section: Document Info -->
                    <div style="margin-bottom: 20px; padding: 15px; background: #f9f9f9; border-radius: 4px;">
                        <div style="margin-bottom: 8px;"><strong>対象ドキュメント:</strong> ${contract.original_filename || contract.name}</div>
                        ${contract.source_url ? `<div style="margin-bottom: 8px;"><strong>対象URL:</strong> ${contract.source_url}</div>` : ''}
                        <div style="display: flex; align-items: center; gap: 10px;">
                            <strong>AIリスク判定:</strong>
                            <span style="padding: 2px 10px; border-radius: 4px; background: ${riskColor}; color: white; font-weight: bold;">${contract.risk_level || 'Low'}</span>
                        </div>
                    </div>

                    <!-- Section: AI Summary -->
                    <div style="margin-bottom: 20px;">
                        <h2 style="font-size: 18px; border-left: 4px solid #c19b4a; padding-left: 10px; margin: 0 0 15px;">【解析要約】</h2>
                        <div style="white-space: pre-wrap;">${contract.ai_summary || '解析データなし'}</div>
                    </div>

                    <!-- Section: Risk Reason -->
                    <div style="margin-bottom: 20px;">
                        <h2 style="font-size: 18px; border-left: 4px solid #c19b4a; padding-left: 10px; margin: 0 0 15px;">【AIリスク判定結果・理由】</h2>
                        <div style="white-space: pre-wrap;">${contract.ai_risk_reason || '判定データなし'}</div>
                    </div>

                    <!-- Section: Each change as separate section -->
                    <div style="margin-bottom: 10px;">
                        <h2 style="font-size: 18px; border-left: 4px solid #c19b4a; padding-left: 10px; margin: 0 0 15px;">【主要な差分箇所】</h2>
                    </div>
                    ${(contract.ai_changes || []).map(c => `
                    <div style="margin-bottom: 15px; border: 1px solid #eee; border-radius: 4px;">
                        <div style="background: #f5f5f5; padding: 8px 12px; font-weight: bold; border-bottom: 1px solid #eee;">${c.section}</div>
                        <div style="padding: 12px;">
                            <div style="background: #fff5f5; padding: 8px; margin-bottom: 5px; border-radius: 2px;"><span style="color: #D73A49; font-weight:600;">原文:</span> ${c.old}</div>
                            <div style="background: #f0fff4; padding: 8px; border-radius: 2px;"><span style="color: #2ecc71; font-weight:600;">修正後:</span> ${c.new}</div>
                            <div style="margin-top: 10px; font-size: 12px; color: #666;">
                                <strong>法的影響:</strong> ${c.impact || '-'}<br>
                                <strong>懸念点:</strong> ${c.concern || '-'}
                            </div>
                        </div>
                    </div>
                    `).join('') || '<div style="margin-bottom:20px;"><p style="color:#999;">差分データはありません</p></div>'}

                    <!-- Section: Original Content -->
                    <div style="margin-bottom: 20px;">
                        <h2 style="font-size: 18px; border-left: 4px solid #c19b4a; padding-left: 10px; margin: 0 0 15px;">【原本（全文）】</h2>
                        <div style="white-space: pre-wrap; background: #fafafa; padding: 20px; font-size: 12px; border: 1px solid #eee;">${contract.original_content || '原本データはありません'}</div>
                    </div>

                    <!-- Section: Footer -->
                    <div style="text-align: center; border-top: 1px solid #eee; padding-top: 10px; font-size: 10px; color: #aaa;">
                        Generated by DIFFsense - Professional Contract Analysis Service
                    </div>
                </div>
            `;

            // 3. Render each section separately to avoid mid-content page breaks
            const { jsPDF } = window.jspdf;
            const pdf = new jsPDF('p', 'mm', 'a4');
            const pageWidth = 210;
            const pageHeight = 297;
            const margin = 15;
            const contentWidth = pageWidth - margin * 2;
            const usableHeight = pageHeight - margin * 2;

            // Get all direct child sections of the report
            const reportInner = container.querySelector(':scope > div');
            const sections = reportInner.children;

            let currentY = margin;

            for (let i = 0; i < sections.length; i++) {
                const section = sections[i];

                const canvas = await html2canvas(section, {
                    scale: 2,
                    useCORS: true,
                    logging: false,
                    backgroundColor: '#ffffff',
                    width: 800
                });

                const imgData = canvas.toDataURL('image/png');
                const sectionImgHeight = (canvas.height * contentWidth) / canvas.width;

                // If this section is taller than a full page, fall back to slicing
                if (sectionImgHeight > usableHeight) {
                    // For very tall sections, slice into page-sized chunks
                    let sliceY = 0;
                    const sliceHeightPx = Math.floor((usableHeight / sectionImgHeight) * canvas.height);

                    while (sliceY < canvas.height) {
                        if (currentY > margin && currentY !== margin) {
                            pdf.addPage();
                            currentY = margin;
                        }

                        const remainPx = canvas.height - sliceY;
                        const thisSlicePx = Math.min(sliceHeightPx, remainPx);
                        const thisSliceMm = (thisSlicePx * contentWidth) / canvas.width;

                        // Create a sub-canvas for this slice
                        const sliceCanvas = document.createElement('canvas');
                        sliceCanvas.width = canvas.width;
                        sliceCanvas.height = thisSlicePx;
                        const ctx = sliceCanvas.getContext('2d');
                        ctx.drawImage(canvas, 0, sliceY, canvas.width, thisSlicePx, 0, 0, canvas.width, thisSlicePx);

                        const sliceImg = sliceCanvas.toDataURL('image/png');
                        pdf.addImage(sliceImg, 'PNG', margin, currentY, contentWidth, thisSliceMm);

                        sliceY += thisSlicePx;
                        if (sliceY < canvas.height) {
                            pdf.addPage();
                            currentY = margin;
                        } else {
                            currentY += thisSliceMm;
                        }
                    }
                } else {
                    // Check if section fits on current page
                    if (currentY + sectionImgHeight > pageHeight - margin) {
                        pdf.addPage();
                        currentY = margin;
                    }

                    pdf.addImage(imgData, 'PNG', margin, currentY, contentWidth, sectionImgHeight);
                    currentY += sectionImgHeight;
                }
            }

            pdf.save(`DIFFsense_Report_${contract.name}_${new Date().toISOString().split('T')[0]}.pdf`);
            this.showToast('PDFを出力しました', 'success');

        } catch (error) {
            console.error('PDF Export Error:', error);
            this.showToast('PDFの生成中にエラーが発生しました', 'error');
        } finally {
            // Clean up off-screen container
            const el = document.getElementById('pdf-export-container');
            if (el) el.remove();
        }
    }

    showToast(message, type = 'info', duration = 3000) {
        // Use Notify system for consistency
        if (type === 'success') {
            Notify.success(message);
        } else if (type === 'error') {
            Notify.error(message);
        } else if (type === 'warning') {
            Notify.warning(message);
        } else {
            Notify.info(message);
        }
    }
}

// Global App Instance
window.app = new DashboardApp();
document.addEventListener('DOMContentLoaded', () => window.app.init());
