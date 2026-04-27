// Lazy-loaded team view module.

export function render({ app, dbService } = {}) {
    if (!app || !dbService) {
        throw new Error('team module missing render dependencies');
    }

    const users = dbService.getUsers();
    const limit = dbService.PLAN_LIMITS[app.subscription?.plan] || 1;
    const rows = users.map(m => `
    <tr>
                <td class="col-name" title="${m.name}">${m.name}</td>
            <td>${m.email}</td>
            <td><span class="badge ${m.role === '管理者' ? 'badge-warning' : (m.role === '作業者' ? 'badge-success' : 'badge-neutral')}">${m.role}</span></td>
            <td>${m.last_active_at}</td>
            <td>${app.can('manage_team') ? `<button class="btn-dashboard" onclick="window.app.showEditMemberModal('${m.email}')">編集</button>` : '-'}</td>
        </tr>
    `).join('');

    return `
    <div class="plan-view-container">
        <div class="flex justify-between items-center mb-md">
            <h2 class="page-title" style="margin-bottom:0;">チーム管理 <small style="font-size:14px; font-weight:normal; color:#666; margin-left:12px;">(${users.length} / ${limit} 名)</small></h2>
                    ${app.can('manage_team') ? `<button class="btn-dashboard btn-primary-action" onclick="window.app.showInviteModal()"><i class="fa-solid fa-user-plus"></i> メンバー招待</button>` : ''}
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
    </div>
`;
}
