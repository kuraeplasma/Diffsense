const createDashboardModel = (dbService) => {
    try {
        const stats = (typeof dbService.getStats === 'function' ? dbService.getStats() : {}) || {};
        const rawContracts = typeof dbService.getContracts === 'function'
            ? dbService.getContracts()
            : (typeof dbService.getFilteredContracts === 'function' ? dbService.getFilteredContracts('total') : []);
        const contracts = Array.isArray(rawContracts) ? rawContracts : [];
        const now = new Date();
        const month = now.getMonth();
        const year = now.getFullYear();

        const toTime = (value) => {
            if (!value) return 0;
            const time = new Date(value).getTime();
            return Number.isFinite(time) ? time : 0;
        };
        const toDate = (value) => {
            if (!value) return null;
            const date = new Date(value);
            return Number.isFinite(date.getTime()) ? date : null;
        };
        const isConfirmed = (status) => ['確認済み', '確認済'].includes(String(status || '').trim());
        const deadlineInfo = (contract) => {
            if (!contract) return null;
            const date = toDate(contract.expiry_date || contract.renewal_deadline || contract.deadline_at);
            if (!date) return null;
            const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const due = new Date(date.getFullYear(), date.getMonth(), date.getDate());
            const days = Math.ceil((due - today) / 86400000);
            return { date, days };
        };

        const highRisk = contracts.filter((c) => c?.risk_level === 'High');
        const pending = contracts.filter((c) => !isConfirmed(c?.status));
        const analyzed = contracts.filter((c) => c && (c.last_analyzed_at || c.ai_summary || c.ai_changes?.length || c.ai_rewrite_clauses?.length));
        const analyzedThisMonth = analyzed.filter((c) => {
            const date = toDate(c?.last_analyzed_at || c?.last_updated_at || c?.created_at);
            return date && date.getFullYear() === year && date.getMonth() === month;
        });
        const deadlines = contracts
            .map((contract) => ({ contract, info: deadlineInfo(contract) }))
            .filter((item) => item.info && item.info.days >= 0 && item.info.days <= 30)
            .sort((a, b) => a.info.days - b.info.days);

        const actionMap = new Map();
        [...highRisk, ...deadlines.map((item) => item.contract), ...pending].forEach((contract) => {
            if (contract && contract.id != null && !actionMap.has(String(contract.id))) {
                actionMap.set(String(contract.id), contract);
            }
        });
        const actions = [...actionMap.values()].slice(0, 3);
        const recent = [...contracts]
            .sort((a, b) => toTime(b?.last_analyzed_at || b?.last_updated_at || b?.created_at) - toTime(a?.last_analyzed_at || a?.last_updated_at || a?.created_at))
            .slice(0, 3);

        return {
            stats,
            contracts,
            highRisk,
            pending,
            analyzed,
            analyzedThisMonth,
            deadlines,
            actions,
            recent
        };
    } catch (e) {
        console.error('Error in createDashboardModel:', e);
        return {
            stats: {}, contracts: [], highRisk: [], pending: [], analyzed: [], analyzedThisMonth: [], deadlines: [], actions: [], recent: []
        };
    }
};

const createDashboardMarkup = ({ app, dbService, escapeHtmlText, formatDisplayTimestamp } = {}) => {
    try {
        const model = createDashboardModel(dbService);
        const esc = escapeHtmlText;
        const nav = (view, id = '') => `window.app.navigate('${view}'${id === '' ? '' : `, ${JSON.stringify(id)}`})`;
        const fmtDate = (value) => value ? formatDisplayTimestamp(value).replace(/\s+\d{1,2}:\d{2}.*/, '') : '-';
        const isConfirmed = (status) => ['確認済み', '確認済'].includes(String(status || '').trim());
        const actionCount = model.actions.length || model.pending.length;
        const riskCount = model.highRisk.length || Number(model.stats.highRisk || 0);
        const deadlineCount = model.deadlines.length;
        const totalCount = Number(model.stats.total || model.contracts.length || 0);
        const analyzedCount = model.analyzed.length;
        const analyzedMonthCount = model.analyzedThisMonth.length;

        const statusLabel = (contract) => {
            if (contract.risk_level === 'High') return '高リスク';
            const deadline = model.deadlines.find((item) => item.contract.id === contract.id);
            if (deadline) return '期限間近';
            if (!isConfirmed(contract.status)) return '要確認';
            return '確認';
        };
        const actionChip = (contract) => {
            const rewrite = contract.ai_rewrite_clauses?.[0];
            if (rewrite?.issue) return esc(rewrite.issue);
            if (contract.risk_level === 'High') return '重要な変更あり';
            const deadline = model.deadlines.find((item) => item.contract.id === contract.id);
            if (deadline) return `契約終了まで残り${deadline.info.days}日`;
            return esc(contract.status || '確認待ち');
        };
        const secondChip = (contract) => {
            const rewrite = contract.ai_rewrite_clauses?.[0];
            if (rewrite?.suggestion) return esc(rewrite.suggestion);
            if (contract.risk_level === 'High') return 'リスク確認が必要';
            const deadline = model.deadlines.find((item) => item.contract.id === contract.id);
            return deadline ? '更新期限を確認' : '';
        };
        const renderEmpty = (text) => `<div class="dashboard-v2-empty">${esc(text)}</div>`;

        const metricCards = [
            {
                tone: 'danger',
                icon: 'fa-solid fa-triangle-exclamation',
                label: '要対応の契約',
                value: actionCount,
                sub: `高リスク：${riskCount}件<br>期限間近：${deadlineCount}件`
            },
            {
                tone: 'warning',
                icon: 'fa-regular fa-calendar',
                label: '期限が近い契約',
                value: deadlineCount,
                sub: `30日以内：${deadlineCount}件`
            },
            {
                tone: 'success',
                icon: 'fa-solid fa-shield-halved',
                label: '解析済みの契約',
                value: analyzedCount,
                sub: `今月：${analyzedMonthCount}件`
            },
            {
                tone: 'info',
                icon: 'fa-regular fa-file-lines',
                label: '総契約書数',
                value: totalCount,
                sub: 'すべての契約書'
            }
        ].map((card) => `
            <article class="dashboard-v2-metric">
                <div class="dashboard-v2-icon is-${card.tone}"><i class="${card.icon}"></i></div>
                <div>
                    <div class="dashboard-v2-metric-label">${card.label}</div>
                    <div class="dashboard-v2-metric-value">${card.value}<span>件</span></div>
                    <div class="dashboard-v2-metric-sub">${card.sub}</div>
                </div>
            </article>
        `).join('');

        const actionRows = model.actions.length ? model.actions.map((contract) => {
            if (!contract) return '';
            const mainChip = statusLabel(contract);
            const tone = mainChip === '高リスク' ? 'danger' : (mainChip === '期限間近' ? 'warning' : 'neutral');
            const extraChip = secondChip(contract);
            return `
                <div class="dashboard-v2-action-row" onclick="${nav('diff', contract.id)}">
                    <span class="dashboard-v2-status is-${tone}">${mainChip}</span>
                    <div class="dashboard-v2-contract-main">
                        <strong>${esc(contract.name || '名称未設定')}</strong>
                        <span>${esc(contract.counterparty || contract.company_name || contract.type || '契約書')}</span>
                    </div>
                    <div class="dashboard-v2-chips">
                        <span>${actionChip(contract)}</span>
                        ${extraChip ? `<span>${extraChip}</span>` : ''}
                    </div>
                    <div class="dashboard-v2-date">${fmtDate(contract.last_updated_at || contract.last_analyzed_at || contract.created_at)}</div>
                    <button class="dashboard-v2-button">確認する <i class="fa-solid fa-arrow-right"></i></button>
                </div>
            `;
        }).join('') : renderEmpty('要対応の契約はありません');

        const fileIcon = (contract) => {
            const name = String(contract?.name || '').toLowerCase();
            if (name.includes('.pdf')) return '<span class="dashboard-v2-file is-pdf"><i class="fa-regular fa-file-pdf"></i></span>';
            if (contract?.source_url || name.startsWith('http')) return '<span class="dashboard-v2-file is-url"><i class="fa-solid fa-link"></i></span>';
            return '<span class="dashboard-v2-file is-word"><i class="fa-regular fa-file-word"></i></span>';
        };
        const recentRows = model.recent.length ? model.recent.map((contract) => `
            <div class="dashboard-v2-compact-row">
                ${fileIcon(contract)}
                <div class="dashboard-v2-compact-main">
                    <strong>${esc(contract?.name || '名称未設定')}</strong>
                    <span>更新日：${formatDisplayTimestamp(contract?.last_analyzed_at || contract?.last_updated_at || contract?.created_at)}</span>
                </div>
                <span class="dashboard-v2-pill is-success">${contract?.last_analyzed_at ? '解析完了' : '取得・解析完了'}</span>
                <button class="dashboard-v2-button" onclick="${nav('diff', contract?.id)}">結果を見る <i class="fa-solid fa-arrow-right"></i></button>
            </div>
        `).join('') : renderEmpty('最近の解析はありません');

        const deadlineRows = model.deadlines.slice(0, 3).map(({ contract, info }) => {
            const weekday = ['日', '月', '火', '水', '木', '金', '土'][info.date.getDay()];
            const tone = info.days <= 7 ? 'danger' : 'warning';
            return `
                <div class="dashboard-v2-calendar-row">
                    <strong>${info.date.getMonth() + 1}/${info.date.getDate()} (${weekday})</strong>
                    <span>${esc(contract?.name || '名称未設定')}</span>
                    <em class="is-${tone}">残り${info.days}日</em>
                </div>
            `;
        }).join('') || renderEmpty('今後30日の期限はありません');

        return `
            <div class="page-title">ダッシュボード</div>
            <div class="dashboard-v2">
                <div class="dashboard-v2-metrics">${metricCards}</div>

                <section class="dashboard-v2-panel">
                    <div class="dashboard-v2-panel-head">
                        <h2>要対応の契約</h2>
                        <button onclick="${nav('contracts')}" class="dashboard-v2-link">すべて見る <i class="fa-solid fa-arrow-right"></i></button>
                    </div>
                    <div class="dashboard-v2-action-list">${actionRows}</div>
                </section>

                <div class="dashboard-v2-bottom">
                    <section class="dashboard-v2-panel">
                        <div class="dashboard-v2-panel-head">
                            <h2>最近の解析</h2>
                            <button onclick="${nav('history')}" class="dashboard-v2-link">すべて見る <i class="fa-solid fa-arrow-right"></i></button>
                        </div>
                        <div class="dashboard-v2-compact-list">${recentRows}</div>
                    </section>

                    <section class="dashboard-v2-panel">
                        <div class="dashboard-v2-panel-head">
                            <h2>期限カレンダー <span>（今後30日）</span></h2>
                            <button onclick="${nav('deadlines')}" class="dashboard-v2-link">すべて見る <i class="fa-solid fa-arrow-right"></i></button>
                        </div>
                        <div class="dashboard-v2-calendar-list">${deadlineRows}</div>
                        <button onclick="${nav('deadlines')}" class="dashboard-v2-calendar-link">カレンダーで確認する <i class="fa-solid fa-arrow-right"></i></button>
                    </section>
                </div>
            </div>
        `;
    } catch (e) {
        console.error('Error in createDashboardMarkup:', e);
        return '<div class="alert alert-danger">ダッシュボードの表示に失敗しました</div>';
    }
};

export function render({ app, dbService, escapeHtmlText, formatDisplayTimestamp } = {}) {
    try {
        if (!dbService || typeof escapeHtmlText !== 'function' || typeof formatDisplayTimestamp !== 'function') {
            throw new Error('dashboard module missing render dependencies');
        }
        return createDashboardMarkup({ app, dbService, escapeHtmlText, formatDisplayTimestamp });
    } catch (e) {
        console.error('dashboard module render error:', e);
        return `<div class="p-4 text-danger">モジュールの描画に失敗しました: ${e.message}</div>`;
    }
}
