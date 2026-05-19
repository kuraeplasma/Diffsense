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

        // Check if there are any diff results for this contract
        const results = (typeof dbService.getDiffResults === 'function') ? dbService.getDiffResults() : [];
        const diffResult = results.find(r => String(r.contract_id) === String(c.id));

        let actionButton = '';
        if (diffResult) {
            actionButton = `
                <button onclick="window.app.selectedOldFile = '${diffResult.docA_id}'; window.app.selectedNewFile = '${diffResult.docB_id}'; window.app.isAnalyzed = true; window.app.navigate('diff-check', { id: '${c.id}', source: 'contracts' })"
                        style="background:#16a34a; color:#fff; border:none; border-radius:6px; padding:6px 12px; font-size:11px; font-weight:700; cursor:pointer; white-space:nowrap; display:inline-flex; align-items:center; justify-content:center; gap:6px; width:100%; transition:all 0.2s; box-shadow:0 2px 4px rgba(22,163,74,0.15);" onmouseover="this.style.background='#15803d'; this.style.transform='translateY(-1px)';" onmouseout="this.style.background='#16a34a'; this.style.transform='translateY(0)';">
                    <i class="fa-solid fa-square-check"></i> 差分チェック済み
                </button>
            `;
        } else {
            actionButton = `
                <button onclick="window.app.selectedOldFile = '${c.id}'; window.app.selectedNewFile = null; window.app.isAnalyzed = false; window.app.navigate('diff-check', { id: '${c.id}', source: 'contracts' })"
                        style="background:#0b2d62; color:#fff; border:none; border-radius:6px; padding:6px 12px; font-size:11px; font-weight:700; cursor:pointer; white-space:nowrap; display:inline-flex; align-items:center; justify-content:center; gap:6px; width:100%; transition:all 0.2s; box-shadow:0 2px 4px rgba(11,45,98,0.15);" onmouseover="this.style.background='#1e40af'; this.style.transform='translateY(-1px)';" onmouseout="this.style.background='#0b2d62'; this.style.transform='translateY(0)';">
                    <i class="fa-solid fa-code-compare"></i> 差分チェック
                </button>
            `;
        }

        return `
                <tr onclick='window.app.navigate("diff", ${JSON.stringify({ id: c.id, source: 'contracts' })})' style="cursor:pointer;">
                    <td class="col-name" title="${escapeHtmlText(c.name)}">${escapeHtmlText(c.name)}</td>
                    <td>${escapeHtmlText(c.type)}</td>
                    <td>${formatDisplayTimestamp(c.last_updated_at || c.last_analyzed_at || c.created_at)}</td>
                    <td>${riskBadge}</td>
                    <td>${statusBadge}</td>
                    <td onclick="event.stopPropagation()" style="width:120px; text-align:center; vertical-align:middle;">
                        ${actionButton}
                    </td>
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
            <div class="flex justify-between items-center mb-md">
                <h2 class="page-title" style="margin-bottom:0;">契約・規約管理</h2>
                <div class="flex gap-sm">
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
                            <option value="確認済み" ${isConfirmedStatus(appFilters.status) ? 'selected' : ''}>確認済み</option>
                        </select>
                    </div>

                    <div class="flex gap-sm items-center">
                        <span class="text-muted" style="font-size:12px;">種別:</span>
                        <select onchange="window.app.updateFilter('type', this.value)" style="padding:6px 8px; border:1px solid #ddd; border-radius:4px; font-size:13px;">
                            <option value="all" ${appFilters.type === 'all' ? 'selected' : ''}>すべて</option>
                            ${typeOptions}
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
                            <th style="width:120px; text-align:center;">操作</th>
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
}
