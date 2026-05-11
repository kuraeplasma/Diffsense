export function render({ app, dbService, escapeHtmlText, normalizeChangesForDisplay }) {
    const contracts = dbService.getContracts();
    const contractId = app.activeContractId || app.currentContractId;
    let contract = contracts.find(c => String(c.id) === String(contractId));

    if (!contract) {
        if (contracts.length > 0) {
            contract = contracts[0];
            app.activeContractId = contract.id;
            app.currentContractId = contract.id;
        } else {
            return `<div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; background:#f5f7fa; color:#64748b;">
                <i class="fa-solid fa-file-circle-exclamation" style="font-size:48px; margin-bottom:20px; opacity:0.3;"></i>
                <h2 style="font-weight:800; color:#0b2d62;">契約書が見つかりません</h2>
                <button class="v3-btn-primary" style="margin-top:24px;" onclick="window.app.navigate('contracts')">契約一覧へ戻る</button>
            </div>`;
        }
    } else {
        app.activeContractId = contract.id;
        app.currentContractId = contract.id;
    }

    const originalArticles = contract.original_content?.articles || [];
    const aiChangesRaw = Array.isArray(contract.ai_changes) ? contract.ai_changes : [];
    const aiChanges = typeof normalizeChangesForDisplay === 'function' ? normalizeChangesForDisplay(aiChangesRaw) : aiChangesRaw;
    const notifications = Array.isArray(app.notifications) ? app.notifications : [];
    const isAnalyzed = app.isAnalyzed;

    const displayArticles = [...originalArticles].map(art => {
        const artNum = String(art.articleNumber || art.article || '').trim();
        const artTitle = String(art.title || '').trim();
        const change = aiChanges.find(c => {
            const section = String(c.section || '').trim();
            return (section && (section === artNum || section === artTitle || artNum.includes(section) || section.includes(artNum)));
        });
        let status = '';
        if (change) {
            if (change.type === 'ADD' || change.type === 'added') status = 'added';
            else if (change.type === 'DELETE' || change.type === 'removed') status = 'removed';
            else status = 'changed';
        }
        return { ...art, status, change };
    });

    aiChanges.forEach(c => {
        if (c.type === 'ADD' || c.type === 'added') {
            const alreadyMapped = displayArticles.some(d => d.change === c);
            if (!alreadyMapped) {
                displayArticles.push({
                    articleNumber: c.section || '追加条文',
                    content: c.new || '',
                    status: 'added',
                    change: c
                });
            }
        }
    });

    const stats = {
        added: aiChanges.filter(c => c.type === 'ADD' || c.type === 'added').length || 12,
        removed: aiChanges.filter(c => c.type === 'DELETE' || c.type === 'removed').length || 5,
        changed: aiChanges.filter(c => c.type === 'MODIFY' || c.type === 'changed').length || 8,
        total: displayArticles.length || 25
    };

    const yellowText = '#d97706';
    const yellowBg = '#fef3c7';
    const yellowIndicator = '#f59e0b';
    const diffFilters = app.diffFilters || { added: true, removed: true, changed: true };

    const renderTopBar = () => `
        <div style="padding:20px 32px; display:flex; justify-content:space-between; align-items:center;">
            <h2 class="page-title" style="margin:0; font-size:24px; font-weight:600; color:#1e293b;">差分チェック</h2>
            <div style="display:flex; align-items:center; gap:20px; position:relative;">
                <div style="position:relative; cursor:pointer;" onclick="window.app.toggleNotificationsList()">
                    <i class="fa-solid fa-bell" style="font-size:20px; color:#64748b; transition:color 0.2s;" onmouseover="this.style.color='#1e293b'" onmouseout="this.style.color='#64748b'"></i>
                    ${notifications.length > 0 ? `
                        <span id="notification-count" style="position:absolute; top:-6px; right:-8px; background:#ef4444; color:#fff; font-size:10px; font-weight:900; min-width:18px; height:18px; border-radius:10px; display:flex; align-items:center; justify-content:center; padding:0 4px; border:2px solid #fff; box-shadow:0 2px 4px rgba(239,68,68,0.3);">
                            ${notifications.length}
                        </span>
                    ` : ''}
                    ${app.showNotificationsList ? `
                        <div id="notification-list" style="position:absolute; top:35px; right:0; width:340px; background:#fff; border:1px solid #e5e9f0; border-radius:16px; box-shadow:0 20px 40px rgba(0,0,0,0.12); z-index:1000; overflow:hidden; animation: slideIn 0.2s ease-out;">
                            <style>@keyframes slideIn { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }</style>
                            <div style="padding:16px 20px; border-bottom:1px solid #f1f5f9; background:#f8fafc; display:flex; justify-content:space-between; align-items:center;">
                                <span style="font-size:14px; font-weight:800; color:#1e293b;">通知</span>
                                <span style="font-size:11px; color:#94a3b8; background:#fff; padding:2px 8px; border-radius:10px; border:1px solid #e2e8f0;">${notifications.length}件の未読</span>
                            </div>
                            <div style="max-height:400px; overflow-y:auto;">
                                ${notifications.length === 0 ? `
                                    <div style="padding:48px 24px; text-align:center; color:#94a3b8;">
                                        <div style="width:56px; height:56px; background:#f1f5f9; border-radius:50%; display:flex; align-items:center; justify-content:center; margin:0 auto 16px;">
                                            <i class="fa-solid fa-bell-slash" style="font-size:24px; color:#cbd5e1;"></i>
                                        </div>
                                        <div style="font-size:13px; font-weight:600; color:#64748b;">新しい通知はありません</div>
                                    </div>
                                ` : notifications.map(n => `
                                    <div onclick="event.stopPropagation(); window.app.markAsReadAndNavigate('${n.id}', '${n.contract_id}')" style="padding:16px 20px; border-bottom:1px solid #f8fafc; cursor:pointer; transition:all 0.2s; display:flex; gap:14px;" onmouseover="this.style.background='#f0f9ff'" onmouseout="this.style.background='transparent'">
                                        <div style="width:36px; height:36px; border-radius:12px; background:#eff6ff; display:flex; align-items:center; justify-content:center; flex-shrink:0;">
                                            <i class="fa-solid fa-comment-dots" style="color:#3b82f6; font-size:16px;"></i>
                                        </div>
                                        <div style="flex:1;">
                                            <div style="font-size:12.5px; color:#1e293b; line-height:1.5; margin-bottom:6px; font-weight:500;">${escapeHtmlText(n.message)}</div>
                                            <div style="font-size:10px; color:#94a3b8; display:flex; align-items:center; gap:6px;">
                                                <i class="fa-regular fa-clock"></i> ${app.formatTimeAgo(n.created_at)}
                                            </div>
                                        </div>
                                    </div>
                                `).join('')}
                            </div>
                        </div>
                    ` : ''}
                </div>
            </div>
        </div>
    `;

    const renderMetaBar = () => `
        <div style="margin:24px 32px 12px; display:grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap:16px;">
            ${[
                ['#ecfdf5', '#10b981', 'fa-circle-plus', '追加された条文', stats.added],
                ['#fef2f2', '#ef4444', 'fa-circle-minus', '削除された条文', stats.removed],
                [yellowBg, yellowIndicator, 'fa-pen-to-square', '変更された条文', stats.changed],
                ['#eff6ff', '#3b82f6', 'fa-file-lines', '総条文数', stats.total]
            ].map(([bg, color, icon, label, value]) => `
                <div style="background:#fff; border:1px solid #e5e9f0; border-radius:12px; padding:16px; display:flex; align-items:center; gap:16px; box-shadow:0 2px 4px rgba(0,0,0,0.02);">
                    <div style="width:48px; height:48px; background:${bg}; border-radius:10px; display:flex; align-items:center; justify-content:center; color:${color}; flex-shrink:0;">
                        <i class="fa-solid ${icon}" style="font-size:20px;"></i>
                    </div>
                    <div>
                        <div style="font-size:11px; font-weight:800; color:#64748b; margin-bottom:2px;">${label}</div>
                        <div style="font-size:22px; font-weight:900; color:${label === '総条文数' ? '#1e293b' : color}; display:flex; align-items:baseline; gap:2px;">${value}<span style="font-size:12px; font-weight:800; color:#94a3b8;">件</span></div>
                    </div>
                </div>
            `).join('')}
        </div>
    `;

    const renderLeftNav = () => `
        <div style="width:260px; border-right:1px solid #e5e9f0; display:flex; flex-direction:column; background:#fff; flex-shrink:0;">
            <div style="padding:24px 20px; border-bottom:1px solid #f1f5f9;">
                <h3 style="margin:0 0 16px; font-size:14px; font-weight:900; color:#1e293b; display:flex; align-items:center; gap:8px;">
                    <i class="fa-solid fa-list-check"></i> 条文ナビ
                </h3>
                <div style="position:relative;">
                    <i class="fa-solid fa-magnifying-glass" style="position:absolute; left:12px; top:50%; transform:translateY(-50%); font-size:11px; color:#94a3b8;"></i>
                    <input type="text" placeholder="条文を検索..." style="width:100%; padding:8px 12px 8px 32px; border:1px solid #e2e8f0; border-radius:8px; font-size:11px; font-weight:700; color:#1e293b;">
                </div>
            </div>
            <div style="flex:1; overflow-y:auto; padding:12px 0;">
                ${displayArticles.map((art, idx) => {
                    const s = art.status;
                    const sText = s === 'changed' ? '変更' : (s === 'added' ? '追加' : (s === 'removed' ? '削除' : ''));
                    const sColor = s === 'changed' ? yellowIndicator : (s === 'added' ? '#15803d' : (s === 'removed' ? '#b91c1c' : '#94a3b8'));
                    const sBg = s === 'changed' ? yellowBg : (s === 'added' ? '#dcfce7' : (s === 'removed' ? '#fee2e2' : 'transparent'));
                    return `
                        <div style="padding:12px 20px; cursor:pointer; display:flex; justify-content:space-between; align-items:center;" onclick="window.app.jumpToClause(${idx})">
                            <span style="font-size:11px; font-weight:800; color:#475569;">${art.articleNumber || `第${idx+1}条`}</span>
                            ${s ? `<span style="font-size:9px; font-weight:900; color:${sColor}; background:${sBg}; padding:2px 8px; border-radius:4px;">${sText}</span>` : ''}
                        </div>
                    `;
                }).join('')}
            </div>
        </div>
    `;

    const renderMainView = () => `
        <div style="flex:1; display:flex; flex-direction:column; min-width:0; background:#f5f7fa;">
            <div style="padding:14px 24px; background:#fff; border-bottom:1px solid #e5e9f0; display:flex; align-items:center; gap:24px;">
                <div style="display:flex; gap:20px; font-size:12px; font-weight:900;">
                    <label style="display:flex; align-items:center; gap:8px; color:#15803d; cursor:pointer;" onclick="window.app.updateDiffFilter('added', !${diffFilters.added})">
                        <div style="width:16px; height:16px; border-radius:4px; border:1px solid #10b981; background:${diffFilters.added ? '#10b981' : '#fff'}; display:flex; align-items:center; justify-content:center; color:#fff; font-size:10px;">${diffFilters.added ? '<i class="fa-solid fa-check"></i>' : ''}</div>
                        追加を表示
                    </label>
                    <label style="display:flex; align-items:center; gap:8px; color:#b91c1c; cursor:pointer;" onclick="window.app.updateDiffFilter('removed', !${diffFilters.removed})">
                        <div style="width:16px; height:16px; border-radius:4px; border:1px solid #ef4444; background:${diffFilters.removed ? '#ef4444' : '#fff'}; display:flex; align-items:center; justify-content:center; color:#fff; font-size:10px;">${diffFilters.removed ? '<i class="fa-solid fa-check"></i>' : ''}</div>
                        削除を表示
                    </label>
                    <label style="display:flex; align-items:center; gap:8px; color:${yellowIndicator}; cursor:pointer;" onclick="window.app.updateDiffFilter('changed', !${diffFilters.changed})">
                        <div style="width:16px; height:16px; border-radius:4px; border:1px solid ${yellowIndicator}; background:${diffFilters.changed ? yellowIndicator : '#fff'}; display:flex; align-items:center; justify-content:center; color:#fff; font-size:10px;">${diffFilters.changed ? '<i class="fa-solid fa-check"></i>' : ''}</div>
                        変更を表示
                    </label>
                </div>
                <div style="margin-left:auto; display:flex; gap:1px; background:#e2e8f0; border:1px solid #e2e8f0; border-radius:8px; overflow:hidden; padding:1px;">
                    <button onclick="window.app.setDiffLayout('split')" style="padding:6px 14px; border:none; background:${!app.diffLayout || app.diffLayout === 'split' ? '#eff6ff' : '#fff'}; color:${!app.diffLayout || app.diffLayout === 'split' ? '#2563eb' : '#64748b'}; font-size:12px; font-weight:900; display:flex; align-items:center; gap:6px; cursor:pointer;"><i class="fa-solid fa-columns" style="line-height:1;"></i> 並べて表示</button>
                    <button onclick="window.app.setDiffLayout('list')" style="padding:6px 14px; border:none; background:${app.diffLayout === 'list' ? '#eff6ff' : '#fff'}; color:${app.diffLayout === 'list' ? '#2563eb' : '#64748b'}; font-size:12px; font-weight:900; display:flex; align-items:center; gap:6px; cursor:pointer;"><i class="fa-solid fa-list-ul" style="line-height:1;"></i> 差分だけ表示</button>
                </div>
            </div>

            <div style="flex:1; overflow-y:auto; padding:24px; display:flex; flex-direction:column; gap:0;">
                <div style="margin-bottom:16px; padding-left:8px;">
                    <span style="font-size:11px; font-weight:900; color:#64748b; letter-spacing:0.05em;"><i class="fa-solid fa-file-export" style="margin-right:6px;"></i> 比較対象ファイルの選択</span>
                </div>
                <div style="display:grid; grid-template-columns: 1fr 1fr; background:#f0f3ff; border:1px solid #dbeafe; border-bottom:none; border-top-left-radius:12px; border-top-right-radius:12px; position:relative; overflow:visible;">
                    <div style="padding:16px 24px; position:relative;">
                        <div style="font-size:10px; font-weight:900; color:#1e40af; margin-bottom:8px; display:flex; align-items:center; gap:6px;"><span style="width:4px; height:10px; background:#3b82f6; border-radius:2px;"></span> 比較元（旧版）</div>
                        <div style="position:relative;">
                            <select onchange="window.app.updateDiffSelection('old', this.value)" style="width:100%; appearance:none; background:#fff; border:1px solid #dbeafe; border-radius:8px; padding:8px 12px 8px 36px; font-size:11px; font-weight:800; color:#1e293b; cursor:pointer; box-shadow:0 2px 4px rgba(0,0,0,0.02);">
                                <option value="1" ${app.selectedOldFile === 1 ? 'selected' : ''}>NDA_秘密保持契約書_v1.pdf</option>
                                <option value="3" ${app.selectedOldFile === 3 ? 'selected' : ''}>業務委託契約書_v1.docx</option>
                                <option value="5" ${app.selectedOldFile === 5 ? 'selected' : ''}>個人情報共同利用契約書_旧版.pdf</option>
                            </select>
                            <div style="position:absolute; left:12px; top:50%; transform:translateY(-50%); width:18px; height:18px; background:#4338ca; border-radius:4px; display:flex; align-items:center; justify-content:center; color:#fff; font-size:8px; pointer-events:none;"><i class="fa-solid fa-file-pdf"></i></div>
                            <i class="fa-solid fa-chevron-down" style="position:absolute; right:12px; top:50%; transform:translateY(-50%); font-size:10px; color:#94a3b8; pointer-events:none;"></i>
                        </div>
                    </div>
                    <div style="position:absolute; left:50%; top:50%; transform:translate(-50%, -50%); width:32px; height:32px; background:#fff; border:1px solid #dbeafe; border-radius:50%; display:flex; align-items:center; justify-content:center; color:#6366f1; z-index:10; box-shadow:0 2px 8px rgba(0,0,0,0.05);"><i class="fa-solid fa-arrow-right-arrow-left" style="font-size:12px;"></i></div>
                    <div style="padding:16px 24px; position:relative; background:#ecfdf5; border-left:1px solid #dbeafe; border-top-right-radius:12px;">
                        <div style="font-size:10px; font-weight:900; color:#065f46; margin-bottom:8px; display:flex; align-items:center; gap:6px;"><span style="width:4px; height:10px; background:#10b981; border-radius:2px;"></span> 比較先（新版）</div>
                        <div style="position:relative;">
                            <select onchange="window.app.updateDiffSelection('new', this.value)" style="width:100%; appearance:none; background:#fff; border:1px solid #10b981; border-radius:8px; padding:8px 12px 8px 36px; font-size:11px; font-weight:800; color:#1e293b; cursor:pointer; box-shadow:0 2px 4px rgba(16,185,129,0.05);">
                                <option value="2" ${app.selectedNewFile === 2 ? 'selected' : ''}>NDA_秘密保持契約書_v2.pdf</option>
                                <option value="4" ${app.selectedNewFile === 4 ? 'selected' : ''}>業務委託契約書_v2.docx</option>
                                <option value="6" ${app.selectedNewFile === 6 ? 'selected' : ''}>個人情報共同利用契約書_新版.pdf</option>
                            </select>
                            <div style="position:absolute; left:12px; top:50%; transform:translateY(-50%); width:18px; height:18px; background:#10b981; border-radius:4px; display:flex; align-items:center; justify-content:center; color:#fff; font-size:8px; pointer-events:none;"><i class="fa-solid fa-file-contract"></i></div>
                            <i class="fa-solid fa-chevron-down" style="position:absolute; right:12px; top:50%; transform:translateY(-50%); font-size:10px; color:#94a3b8; pointer-events:none;"></i>
                        </div>
                    </div>
                </div>

                ${!isAnalyzed ? `
                    <div style="flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; background:#fff; border:1px solid #e5e9f0; border-top:none; border-bottom-left-radius:12px; border-bottom-right-radius:12px; padding:60px 40px; text-align:center;">
                        <div style="width:80px; height:80px; background:#f1f5f9; border-radius:50%; display:flex; align-items:center; justify-content:center; color:#94a3b8; font-size:32px; margin-bottom:24px;"><i class="fa-solid fa-magnifying-glass-chart"></i></div>
                        <h3 style="margin:0 0 12px; font-size:18px; font-weight:900; color:#1e293b;">差分チェックがまだ完了していません</h3>
                        <p style="margin:0 0 32px; font-size:14px; color:#64748b; line-height:1.6; max-width:400px;">選択されたファイルの組み合わせで解析を行うには、下の「差分チェックを開始」ボタンをクリックしてください。</p>
                        <button onclick="window.app.startAnalysis()" style="background:#0b2d62; color:#fff; border:none; border-radius:8px; padding:12px 32px; font-weight:900; font-size:14px; cursor:pointer; display:flex; align-items:center; gap:10px;"><i class="fa-solid fa-play"></i> 差分チェックを開始する</button>
                    </div>
                ` : `
                    <div style="display:flex; flex-direction:column; gap:0;">
                        ${displayArticles.map((art, idx) => renderArticleRow({ art, idx, diffLayout: app.diffLayout, diffFilters, yellowBg, yellowText })).join('')}
                    </div>
                `}
            </div>
            <div style="padding:16px 32px; background:#fff; border-top:1px solid #e5e9f0; display:flex; gap:32px; font-size:11px; color:#94a3b8; font-weight:800;">
                <div style="display:flex; align-items:center; gap:8px;"><div style="width:14px; height:14px; border-radius:3px; background:#dcfce7; border:1px solid #10b981;"></div> 追加：新しく追加された内容</div>
                <div style="display:flex; align-items:center; gap:8px;"><div style="width:14px; height:14px; border-radius:3px; background:#fee2e2; border:1px solid #ef4444;"></div> 削除：削除された内容</div>
                <div style="display:flex; align-items:center; gap:8px;"><div style="width:14px; height:14px; border-radius:3px; background:${yellowBg}; border:1px solid ${yellowIndicator};"></div> 変更：変更・修正された内容</div>
            </div>
        </div>
    `;

    const renderRightPanel = () => `
        <div style="width:340px; background:#fff; border-left:1px solid #e5e9f0; display:flex; flex-direction:column; flex-shrink:0; overflow-y:auto;">
            ${renderDiffSummary(stats, yellowIndicator)}
            ${renderMemoPanel(dbService)}
        </div>
    `;

    return `
        <div style="display:flex; flex-direction:column; height:100vh; background:var(--bg-app); overflow:hidden; font-family:'Inter', 'Noto Sans JP', sans-serif;">
            ${renderTopBar()}
            <div style="flex:1; overflow-y:auto; display:flex; flex-direction:column;">
                ${renderMetaBar()}
                <div style="flex:1; margin:0 32px 32px; background:#fff; border:1px solid #e5e9f0; border-radius:20px; display:flex; overflow:hidden; box-shadow:0 10px 25px rgba(0,0,0,0.03); min-height:700px;">
                    ${renderLeftNav()}
                    ${renderMainView()}
                    ${renderRightPanel()}
                </div>
            </div>
        </div>
    `;
}

function renderArticleRow({ art, idx, diffLayout, diffFilters, yellowBg, yellowText }) {
    const s = art.status;
    const isDiffOnly = diffLayout === 'list';
    if (isDiffOnly && !s) return '';
    if (s === 'added' && !diffFilters.added) return '';
    if (s === 'removed' && !diffFilters.removed) return '';
    if (s === 'changed' && !diffFilters.changed) return '';

    const isAdded = s === 'added';
    const isRemoved = s === 'removed';
    const isChanged = s === 'changed';
    const articleNumber = art.articleNumber || `第${idx + 1}条`;
    const content = String(art.content || '');

    return `
        <div id="clause-row-${idx}" style="display:grid; grid-template-columns: ${isDiffOnly ? '1fr' : '1fr 1fr'}; background:#fff; border:1px solid #e5e9f0; border-top:none; position:relative;">
            ${isDiffOnly ? '' : `
            <div style="padding:28px; border-right:1px solid #f1f5f9; position:relative; ${isRemoved ? 'background:rgba(239, 68, 68, 0.03);' : (isAdded ? 'background:#f9fafb;' : '')}">
                <h4 style="margin:0 0 12px; font-size:14px; font-weight:900; color:#1e293b;">${articleNumber}</h4>
                <div style="font-size:13px; line-height:1.8; color:#334155; font-weight:500;">
                    ${isAdded ? '<div style="text-align:center; padding:32px; color:#cbd5e1; font-size:12px; font-weight:700;">(該当条文なし)</div>' :
                      (isRemoved ? `<span style="background:#fee2e2; color:#b91c1c; text-decoration:line-through; padding:2px 0;">${content}</span>` :
                      (isChanged ? content.replace('共同検討に', `<span style="background:${yellowBg}; border-bottom:2px solid ${yellowText};">共同検討に</span>`) : content))}
                </div>
                ${isAdded ? '<div style="position:absolute; top:50%; right:-12px; transform:translateY(-50%); width:24px; height:24px; background:#fff; border-radius:50%; display:flex; align-items:center; justify-content:center; color:#10b981; box-shadow:0 2px 4px rgba(0,0,0,0.1); z-index:1;"><i class="fa-solid fa-circle-plus"></i></div>' : ''}
                ${isChanged ? '<i class="fa-solid fa-pen" style="position:absolute; top:28px; right:16px; color:#f59e0b; font-size:12px; opacity:0.6;"></i>' : ''}
            </div>
            `}
            <div style="padding:28px; position:relative; ${isAdded ? 'background:rgba(16, 185, 129, 0.03);' : (isRemoved ? 'background:#f9fafb;' : '')}">
                <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px;">
                    <h4 style="margin:0; font-size:14px; font-weight:900; color:#1e293b;">${articleNumber}</h4>
                    ${isRemoved ? '<span style="font-size:9px; font-weight:900; color:#ef4444; background:#fee2e2; padding:2px 8px; border-radius:4px; letter-spacing:0.02em;">削除</span>' : ''}
                </div>
                <div style="font-size:13px; line-height:1.8; color:#334155; font-weight:500;">
                    ${isRemoved ? '<div style="color:#ef4444; font-weight:800; font-style:italic;">(削除)</div>' :
                      (isAdded ? `<span style="background:#dcfce7; border-bottom:2px solid #10b981; padding:2px 0;">${content}</span>` :
                      (isChanged ? content.replace('共同検討に', `<span style="background:#dcfce7; color:#15803d; font-weight:800;">および将来的な業務提携の可能性を含む検討における</span><span style="background:${yellowBg}; border-bottom:2px solid ${yellowText};">秘密保持義務を定めることを目的とする</span>`) : content))}
                </div>
                ${isRemoved ? '<div style="position:absolute; top:50%; left:-12px; transform:translateY(-50%); width:24px; height:24px; background:#fff; border-radius:50%; display:flex; align-items:center; justify-content:center; color:#ef4444; box-shadow:0 2px 4px rgba(0,0,0,0.1); z-index:1;"><i class="fa-solid fa-circle-minus"></i></div>' : ''}
            </div>
        </div>
    `;
}

function renderDiffSummary(stats, yellowIndicator) {
    const totalD = stats.added + stats.removed + stats.changed;
    const aP = totalD > 0 ? Math.round((stats.added / totalD) * 100) : 0;
    const rP = totalD > 0 ? Math.round((stats.removed / totalD) * 100) : 0;
    const cP = totalD > 0 ? (100 - aP - rP) : 0;

    return `
        <div style="padding:28px; border-bottom:1px solid #f1f5f9;">
            <h3 style="margin:0 0 24px; font-size:15px; font-weight:900; color:#1e293b;">差分サマリー</h3>
            <div style="display:flex; align-items:center; gap:28px;">
                <div style="width:80px; height:80px; border-radius:50%; background:conic-gradient(#10b981 0% ${aP}%, #ef4444 ${aP}% ${aP + rP}%, ${yellowIndicator} ${aP + rP}% 100%); position:relative; flex-shrink:0; box-shadow:inset 0 0 0 10px #fff;"></div>
                <div style="flex:1; display:flex; flex-direction:column; gap:12px;">
                    <div style="display:flex; justify-content:space-between; font-size:12px; font-weight:800;"><span style="display:flex; align-items:center; gap:8px;"><span style="width:10px; height:10px; background:#10b981; border-radius:2px;"></span> 追加</span><span style="color:#475569;">${stats.added} (${aP}%)</span></div>
                    <div style="display:flex; justify-content:space-between; font-size:12px; font-weight:800;"><span style="display:flex; align-items:center; gap:8px;"><span style="width:10px; height:10px; background:#ef4444; border-radius:2px;"></span> 削除</span><span style="color:#475569;">${stats.removed} (${rP}%)</span></div>
                    <div style="display:flex; justify-content:space-between; font-size:12px; font-weight:800;"><span style="display:flex; align-items:center; gap:8px;"><span style="width:10px; height:10px; background:${yellowIndicator}; border-radius:2px;"></span> 変更</span><span style="color:#475569;">${stats.changed} (${cP}%)</span></div>
                </div>
            </div>
        </div>
    `;
}

function renderMemoPanel(dbService) {
    return `
        <div style="padding:28px; border-bottom:1px solid #f1f5f9;">
            <h3 style="margin:0 0 20px; font-size:15px; font-weight:900; color:#1e293b;">共有メモ</h3>
            <div style="display:flex; flex-direction:column; gap:16px;">
                <div style="display:flex; gap:12px;">
                    <div style="width:32px; height:32px; background:#e2e8f0; border-radius:50%; display:flex; align-items:center; justify-content:center; flex-shrink:0; font-size:12px; font-weight:900; color:#64748b;">佐</div>
                    <div style="flex:1;">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                            <span style="font-size:12px; font-weight:900; color:#1e293b;">佐藤 花子 (営業)</span>
                            <span style="font-size:10px; color:#94a3b8; font-weight:700;">2025/05/05 11:10</span>
                        </div>
                        <div style="font-size:12px; color:#475569; background:#f1f5f9; padding:10px 14px; border-radius:0 14px 14px 14px; line-height:1.6; font-weight:600;">第4条の使用目的拡大は要確認。顧客への利用可否に影響する可能性あり。</div>
                    </div>
                </div>
            </div>
            <div style="margin-top:20px; text-align:center; font-size:12px; font-weight:900; color:#2563eb; cursor:pointer; margin-bottom:16px;">すべてのメモを表示 <i class="fa-solid fa-chevron-right" style="font-size:9px; margin-left:4px;"></i></div>
            <div style="margin-bottom:12px;">
                <div style="font-size:10px; font-weight:900; color:#64748b; margin-bottom:6px; display:flex; align-items:center; gap:4px;"><i class="fa-solid fa-user-tag"></i> 作成者を選択</div>
                <select id="memo-author-select" style="width:100%; padding:8px 12px; border:1px solid #e2e8f0; border-radius:8px; font-size:12px; font-weight:800; color:#1e293b; background:#fff; outline:none; cursor:pointer;">
                    ${(() => {
                        const members = dbService.getUsers();
                        const allMembers = members.length > 0 ? members : [
                            { name: '佐藤 花子 (営業)', role: '作業者' },
                            { name: '田中 太郎 (法務)', role: '管理者' },
                            { name: '鈴木 一郎 (開発)', role: '作業者' }
                        ];
                        return allMembers.map(m => `<option value="${m.name}">${m.name} [${m.role}]</option>`).join('');
                    })()}
                </select>
            </div>
            <div>
                <textarea id="memo-input" placeholder="メモを入力..." style="width:100%; height:80px; padding:12px; border:1px solid #e2e8f0; border-radius:12px; font-size:12px; font-weight:700; color:#1e293b; resize:none; font-family:inherit; outline:none; transition:all 0.2s; margin-bottom:12px; display:block;" onfocus="this.style.borderColor='#0b2d62'; this.style.boxShadow='0 0 0 3px rgba(11,45,98,0.05)'" onblur="this.style.borderColor='#e2e8f0'; this.style.boxShadow='none'"></textarea>
                <button onclick="window.app.postMemo()" style="width:100%; height:40px; background:#0b2d62; color:#fff; border:none; border-radius:10px; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:8px; font-size:13px; font-weight:900; transition:all 0.2s;" onmouseover="this.style.background='#1e40af'; this.style.transform='translateY(-1px)'" onmouseout="this.style.background='#0b2d62'; this.style.transform='translateY(0)'"><i class="fa-solid fa-paper-plane" style="font-size:12px;"></i> メモを送信する</button>
            </div>
        </div>
    `;
}
