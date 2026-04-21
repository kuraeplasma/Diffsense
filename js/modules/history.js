// Lazy-loaded history view module.

export function render({ app, dbService, DASHBOARD_CACHE_KEYS, escapeHtmlText } = {}) {
    if (!app || !dbService || !DASHBOARD_CACHE_KEYS || typeof escapeHtmlText !== 'function') {
        throw new Error('history module missing render dependencies');
    }

    const liveLogs = dbService.getActivityLogs();
    const cachedLogs = app.getCachedItem(DASHBOARD_CACHE_KEYS.RECENT_HISTORY, 10 * 60 * 1000) || [];
    const logs = Array.isArray(liveLogs) && liveLogs.length > 0 ? liveLogs : cachedLogs;
    const rows = logs.map(h => {
        let statusBadge = 'badge-neutral';
        if (h.status === '成功') statusBadge = 'badge-success';
        else if (h.status === '失敗') statusBadge = 'badge-danger';
        else if (h.status === 'スキップ') statusBadge = 'badge-info';

        return `
                <tr>
                    <td>${h.created_at}</td>
                    <td class="col-name" title="${escapeHtmlText(h.target_name)}">${escapeHtmlText(h.target_name)}</td>
                    <td><span class="badge ${statusBadge}">${h.status || '成功'}</span></td>
                    <td>${h.action}</td>
                    <td>${h.actor}</td>
                    <td><button class="btn-dashboard" style="padding:2px 8px; font-size:11px;" onclick="window.app.showLogDetails(${h.id})">詳細</button></td>
                </tr>
            `;
    }).join('');

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
}
