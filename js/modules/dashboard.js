// Lazy-loaded dashboard overview module.
// Keep this renderer dependency-injected so dashboard.js can migrate gradually.

export function render({ app, dbService, escapeHtmlText, formatDisplayTimestamp } = {}) {
    if (!dbService || typeof escapeHtmlText !== 'function' || typeof formatDisplayTimestamp !== 'function') {
        throw new Error('dashboard module missing render dependencies');
    }

    const stats = dbService.getStats();
    const currentFilter = app ? app.dashboardFilter : 'pending';
    const filteredItems = dbService.getFilteredContracts(currentFilter);

    let sectionTitle = "要確認アイテム (優先度順)";
    if (currentFilter === 'pending') sectionTitle = "未処理のアイテム (新着・変更検知)";
    if (currentFilter === 'risk') sectionTitle = "リスク要判定アイテム";
    if (currentFilter === 'total') sectionTitle = "全監視対象（最新順）";

    const canOperateContract = typeof app?.can === 'function' && app.can('operate_contract');
    const isConfirmedStatus = (status) => ['確認済み', '確認済'].includes(String(status || '').trim());
    const renderContractStatusBadge = (status) => {
        const value = String(status || '').trim();
        if (value === '未解析') return '<span class="badge badge-info">未解析 (新規)</span>';
        if (value === '未処理') return '<span class="badge badge-info">未処理</span>';
        if (value === '未確認') return '<span class="badge badge-warning">要確認 (変更)</span>';
        if (value === '解析済み') return '<span class="badge badge-warning">要確認 (解析済み)</span>';
        if (isConfirmedStatus(value)) return '<span class="badge badge-neutral"><i class="fa-solid fa-check"></i> 確認済み</span>';
        if (!value) return '<span class="badge badge-neutral">未設定</span>';
        return `<span class="badge badge-neutral">${escapeHtmlText(value)}</span>`;
    };
    const tableRows = filteredItems.length > 0 ? filteredItems.slice(0, 10).map(c => {
        let riskBadgeClass = 'badge-neutral';
        if (c.risk_level === 'High') riskBadgeClass = 'badge-danger';
        else if (c.risk_level === 'Medium') riskBadgeClass = 'badge-warning';
        else if (c.risk_level === 'Low') riskBadgeClass = 'badge-success';

        const statusBadge = renderContractStatusBadge(c.status);

        const actionBtn = canOperateContract
            ? `<button class="btn-dashboard">${isConfirmedStatus(c.status) ? '履歴を見る' : '確認する'}</button>`
            : `<button class="btn-dashboard">詳細を見る</button>`;

        return `
                <tr onclick="window.app.navigate('diff', ${c.id})">
                    <td><span class="badge ${riskBadgeClass}">${c.risk_level === 'High' ? 'High' : (c.risk_level === 'Medium' ? 'Medium' : (c.risk_level === 'Low' ? 'Low' : c.risk_level))}</span></td>
                    <td class="col-name" title="${escapeHtmlText(c.name)}">${escapeHtmlText(c.name)}</td>
                    <td>${formatDisplayTimestamp(c.last_updated_at || c.last_analyzed_at || c.created_at)}</td>
                    <td>${statusBadge}</td>
                    <td>${actionBtn}</td>
                </tr>
            `;
    }).join('') : '<tr><td colspan="5" class="text-center text-muted" style="padding:40px;">該当するアイテムはありません</td></tr>';

    return `
            <div class="page-title">ダッシュボード</div>
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
}
