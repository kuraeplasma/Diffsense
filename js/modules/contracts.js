// Lazy-loaded contract list view module.

export function render({ app, dbService, escapeHtmlText, formatDisplayTimestamp, params } = {}) {
    if (!dbService || typeof escapeHtmlText !== 'function' || typeof formatDisplayTimestamp !== 'function') {
        throw new Error('contracts module missing render dependencies');
    }

    const page = params?.page || 1;
    const pageSize = 10;
    const appFilters = app ? app.filters : {};

    const { items, totalPages, totalItems } = dbService.getPaginatedContracts(page, pageSize, params);
    const isConfirmedStatus = (status) => ['確認済み', '確認済'].includes(String(status || '').trim());

    const rows = items.map(c => {
        let riskBadge = '';
        if (c.risk_level === 'High') riskBadge = '<span class="badge badge-danger">High</span>';
        else if (c.risk_level === 'Medium') riskBadge = '<span class="badge badge-warning">Medium</span>';
        else if (c.risk_level === 'Low') riskBadge = '<span class="badge badge-success">Low</span>';
        else riskBadge = '<span class="badge badge-neutral">-</span>';

        const statusBadge = isConfirmedStatus(c.status)
            ? '<span class="badge badge-neutral"><i class="fa-solid fa-check"></i> 確認済み</span>'
            : '<span class="badge badge-warning">未確認</span>';

        return `
                <tr onclick="window.app.navigate('diff', ${c.id})">
                    <td class="col-name" title="${escapeHtmlText(c.name)}">${escapeHtmlText(c.name)}</td>
                    <td>${escapeHtmlText(c.type)}</td>
                    <td>${formatDisplayTimestamp(c.last_updated_at || c.last_analyzed_at || c.created_at)}</td>
                    <td>${riskBadge}</td>
                    <td>${statusBadge}</td>
                    <td>${c.assignee_name}</td>
                </tr>
            `;
    }).join('');

    const typeOptions = (() => {
        const fixed = ['利用規約','NDA','業務委託契約','プライバシーポリシー'];
        const dynamic = dbService.getContracts().map(c => c.type).filter(Boolean);
        const types = [...new Set([...fixed, ...dynamic.filter(t => t !== 'その他')])];
        types.push('その他');
        return types.map(t => `<option value="${t}" ${appFilters.type === t ? 'selected' : ''}>${t}</option>`).join('');
    })();

    return `
            <div class="dashboard-sticky-header">
                <div class="filter-bar mb-md">
                    <div class="contract-filters-grid">
                        <div class="search-input-container">
                            <i class="fa-solid fa-magnifying-glass search-icon"></i>
                            <input type="text" id="contract-search" placeholder="契約名・種別・担当者で検索..."
                                   value="${appFilters.query || ''}"
                                   class="search-input"
                                   oninput="window.app.updateFilter('query', this.value)">
                        </div>

                        <div class="filter-selects-row">
                            <select onchange="window.app.updateFilter('risk', this.value)" class="filter-select">
                                <option value="all" ${appFilters.risk === 'all' ? 'selected' : ''}>リスク: すべて</option>
                                <option value="High" ${appFilters.risk === 'High' ? 'selected' : ''}>High</option>
                                <option value="Medium" ${appFilters.risk === 'Medium' ? 'selected' : ''}>Medium</option>
                                <option value="Low" ${appFilters.risk === 'Low' ? 'selected' : ''}>Low</option>
                            </select>

                            <select onchange="window.app.updateFilter('status', this.value)" class="filter-select">
                                <option value="all" ${appFilters.status === 'all' ? 'selected' : ''}>状態: すべて</option>
                                <option value="未確認" ${appFilters.status === '未確認' ? 'selected' : ''}>未確認</option>
                                <option value="確認済み" ${isConfirmedStatus(appFilters.status) ? 'selected' : ''}>確認済み</option>
                            </select>

                            <select onchange="window.app.updateFilter('type', this.value)" class="filter-select">
                                <option value="all" ${appFilters.type === 'all' ? 'selected' : ''}>種別: すべて</option>
                                ${typeOptions}
                            </select>
                        </div>
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

            <div class="flex justify-between items-center mt-md" style="padding-bottom:20px;">
                <div class="text-muted" style="font-size:12px;">全 ${totalItems} 件</div>
                <div class="flex gap-sm">
                    <button class="btn-dashboard btn-sm" ${page <= 1 ? 'disabled' : ''} onclick="window.app.changePage(${page - 1})">前へ</button>
                    <div style="display:flex; align-items:center; padding:0 8px; font-size:13px; font-weight:600;">${page} / ${totalPages || 1}</div>
                    <button class="btn-dashboard btn-sm" ${page >= totalPages ? 'disabled' : ''} onclick="window.app.changePage(${page + 1})">次へ</button>
                </div>
            </div>
`;
}
