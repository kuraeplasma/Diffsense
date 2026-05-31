/* eslint-disable no-restricted-syntax */
export const render = (options = {}) => {
    const { contractId, app, escapeHtmlText, formatDisplayTimestamp, parseContractIntoClauses, renderStructuredDiffView } = options;
    
    return `
        <div class="diff-view-v3" style="display:flex; flex-direction:column; height:calc(100vh - 64px); background:#f8fafc; overflow:hidden; font-family:'Inter', 'Noto Sans JP', sans-serif;">
            <!-- Top Header -->
            <div style="padding:16px 24px; display:flex; justify-content:space-between; align-items:center; background:#fff; border-bottom:1px solid #eef2f6;">
                <h1 style="font-size:18px; font-weight:700; color:#1e293b; margin:0;">差分チェック</h1>
            </div>

            <!-- Body Grid -->
            <div style="flex:1; display:grid; grid-template-columns:240px 1fr 300px; min-height:0; padding:20px 24px 24px 24px; gap:20px;">
                
                <!-- Left: Contract List (Draggable) -->
                <div style="background:#fff; border:1px solid #eef2f6; border-radius:8px; display:flex; flex-direction:column; overflow:hidden;">
                    <!-- AI Risk Summary Card Container -->
                    <div id="ai-risk-summary-container" style="border-bottom:1px solid #f1f5f9; background:#fff;"></div>

                    <div style="padding:16px; border-bottom:1px solid #f1f5f9;">
                        <div style="display:flex; align-items:center; gap:8px; margin-bottom:12px;">
                            <i class="fa-solid fa-folder-tree" style="color:#64748b; font-size:14px;"></i>
                            <span style="font-size:13px; font-weight:700; color:#1e293b;">契約書一覧</span>
                        </div>
                        <div style="font-size:11px; color:#64748b; margin-bottom:12px; background:#f0f9ff; padding:10px; border-radius:8px; line-height:1.4; border:1px solid #e0f2fe;">
                            <i class="fa-solid fa-lightbulb" style="color:#0ea5e9;"></i> 契約書を中央 of 枠へドラッグして比較を開始できます
                        </div>
                        <div style="position:relative;">
                            <i class="fa-solid fa-search" style="position:absolute; left:12px; top:50%; transform:translateY(-50%); color:#94a3b8; font-size:12px;"></i>
                            <input type="text" placeholder="契約書名で検索..." 
                                   style="width:100%; padding:8px 12px 8px 34px; border:1px solid #e2e8f0; border-radius:8px; font-size:12px; outline:none; box-sizing:border-box;">
                        </div>
                    </div>
                    
                    <!-- All Contracts List -->
                    <div id="diff-contract-list" style="flex:1; overflow-y:auto; padding:8px;">
                        <div style="padding:24px; text-align:center; color:#64748b;"><span style="width:14px;height:14px;border-radius:999px;background:conic-gradient(#22c55e, #3b82f6, #38bdf8, #22c55e);display:inline-block;animation:fa-spin 1s infinite linear;vertical-align:-2px;margin-right:8px;"></span>読み込み中...</div>
                    </div>
                </div>


                <!-- Middle: Main View -->
                <div style="background:#fff; border:1px solid #eef2f6; border-radius:8px; display:flex; flex-direction:column; overflow:hidden;">
                    <!-- Toolbar -->
                    <div style="padding:12px 20px; border-bottom:1px solid #f1f5f9; display:flex; justify-content:space-between; align-items:center; background:#fff;">
                        <div style="display:flex; align-items:center; gap:20px;">
                            <label class="custom-checkbox-label" style="color:#16a34a;">
                                <input type="checkbox" checked onchange="window.app.updateDiffFilterLegacy('added', this.checked)">
                                <span class="custom-checkbox" style="background-color:#16a34a;"></span>
                                追加を表示
                            </label>
                            <label class="custom-checkbox-label" style="color:#ef4444;">
                                <input type="checkbox" checked onchange="window.app.updateDiffFilterLegacy('removed', this.checked)">
                                <span class="custom-checkbox" style="background-color:#ef4444;"></span>
                                削除を表示
                            </label>
                            <label class="custom-checkbox-label" style="color:#f97316;">
                                <input type="checkbox" checked onchange="window.app.updateDiffFilterLegacy('changed', this.checked)">
                                <span class="custom-checkbox" style="background-color:#f97316;"></span>
                                変更を表示
                            </label>
                        </div>
                        
                        <div style="display:flex; align-items:center; gap:12px;">
                            <button onclick="window.app.startAnalysis()" 
                                    style="padding:8px 20px; background:#0b2d62; color:#fff; border:none; border-radius:8px; font-size:12px; font-weight:700; cursor:pointer; display:flex; align-items:center; gap:8px; transition:all 0.2s;"
                                    onmouseover="this.style.background='#1e40af'; this.style.transform='translateY(-1px)';"
                                    onmouseout="this.style.background='#0b2d62'; this.style.transform='none';">
                                <i class="fa-solid fa-code-compare"></i> 差分チェックを開始
                            </button>
                        </div>
                    </div>

                    <!-- File Select Row (プルダウン) -->
                    <div style="padding:12px 20px; border-top:1px solid #f1f5f9; border-bottom:2px solid #e2e8f0; display:grid; grid-template-columns:1fr 1fr; gap:16px; background:#f8fafc; box-shadow:0 2px 4px rgba(0,0,0,0.03);">
                        <div>
                            <div style="font-size:10px; font-weight:700; color:#94a3b8; margin-bottom:6px; text-transform:uppercase;">比較元（旧版）</div>
                            <select id="diff-select-old" onchange="window.app.updateDiffSelection('old', this.value)"
                                    style="width:100%; padding:7px 10px; border:1px solid #e2e8f0; border-radius:6px; font-size:13px; color:#334155; background:#fff; outline:none;">
                                <option value="">読み込み中...</option>
                            </select>
                        </div>
                        <div>
                            <div style="font-size:10px; font-weight:700; color:#94a3b8; margin-bottom:6px; text-transform:uppercase;">比較先（新版）</div>
                            <select id="diff-select-new" onchange="window.app.updateDiffSelection('new', this.value)"
                                    style="width:100%; padding:7px 10px; border:1px solid #e2e8f0; border-radius:6px; font-size:13px; color:#334155; background:#fff; outline:none;">
                                <option value="">読み込み中...</option>
                            </select>
                        </div>
                    </div>

                    <!-- Main Content Area -->
                    <div style="flex:1; display:flex; flex-direction:column; overflow:hidden; background:#fcfcfd;">
                        <!-- D&D Zones: 残り高さを全部使う -->
                        <div id="diff-dd-container" style="flex:1; padding:20px; display:grid; grid-template-columns:1fr 1fr; gap:16px; min-height:0;">
                            <div id="drop-zone-old"
                                 ondragenter="event.preventDefault();"
                                 ondragover="event.preventDefault(); event.dataTransfer.dropEffect='copy'; this.style.borderColor='#3b82f6'; this.style.background='#eff6ff';"
                                 ondragleave="this.style.borderColor='#cbd5e1'; this.style.background='#f8fafc';"
                                 ondrop="event.preventDefault(); this.style.borderColor='#cbd5e1'; this.style.background='#f8fafc'; window.app.handleDiffContractDrop(event, 'old');"
                                 style="border:2px dashed #cbd5e1; border-radius:10px; padding:24px 16px; background:#f8fafc; transition:all 0.2s; display:flex; flex-direction:column;">
                                <div style="font-size:10px; font-weight:700; color:#94a3b8; text-transform:uppercase; letter-spacing:0.05em; margin-bottom:14px;">比較元（旧版）</div>
                                <div id="drop-zone-old-content" style="flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px; text-align:center;">
                                    <span style="width:24px;height:24px;border-radius:999px;background:conic-gradient(#22c55e, #3b82f6, #38bdf8, #22c55e);display:inline-block;animation:fa-spin 1s infinite linear;"></span>
                                </div>
                            </div>
                            <div id="drop-zone-new"
                                 ondragenter="event.preventDefault();"
                                 ondragover="event.preventDefault(); event.dataTransfer.dropEffect='copy'; this.style.borderColor='#16a34a'; this.style.background='#f0fdf4';"
                                 ondragleave="this.style.borderColor='#cbd5e1'; this.style.background='#f8fafc';"
                                 ondrop="event.preventDefault(); this.style.borderColor='#cbd5e1'; this.style.background='#f8fafc'; window.app.handleDiffContractDrop(event, 'new');"
                                 style="border:2px dashed #cbd5e1; border-radius:10px; padding:24px 16px; background:#f8fafc; transition:all 0.2s; display:flex; flex-direction:column;">
                                <div style="font-size:10px; font-weight:700; color:#94a3b8; text-transform:uppercase; letter-spacing:0.05em; margin-bottom:14px;">比較先（新版）</div>
                                <div id="drop-zone-new-content" style="flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px; text-align:center;">
                                    <span style="width:24px;height:24px;border-radius:999px;background:conic-gradient(#22c55e, #3b82f6, #38bdf8, #22c55e);display:inline-block;animation:fa-spin 1s infinite linear;"></span>
                                </div>
                            </div>
                        </div>
                        <!-- 解析結果はここに表示 -->
                        <div id="diff-render-target" style="overflow-y:auto;"></div>
                    </div>
                </div>

                <!-- Right: Summary & Memos -->
                <div style="display:flex; flex-direction:column; gap:20px;">
                    <!-- Diff Summary -->
                    <div style="background:#fff; border:1px solid #eef2f6; border-radius:8px; padding:16px; flex-shrink:0;">
                        <h3 style="font-size:13px; font-weight:700; color:#1e293b; margin:0 0 16px 0;">差分サマリー</h3>
                        <div style="display:flex; align-items:center; gap:20px;">
                            <div id="summary-donut" style="width:80px; height:80px; position:relative; border-radius:50%; background:#f1f5f9; border:2px solid #e2e8f0; flex-shrink:0;"></div>
                            <div style="flex:1; display:flex; flex-direction:column; gap:8px;">
                                <div style="display:flex; align-items:center; justify-content:space-between; font-size:11px;">
                                    <div style="display:flex; align-items:center; gap:6px; color:#475569; font-weight:600;">
                                        <div style="width:8px; height:8px; background:#16a34a; border-radius:1px;"></div> 追加
                                    </div>
                                    <div id="summary-added-text" style="color:#1e293b; font-weight:700;">0 (0%)</div>
                                </div>
                                <div style="display:flex; align-items:center; justify-content:space-between; font-size:11px;">
                                    <div style="display:flex; align-items:center; gap:6px; color:#475569; font-weight:600;">
                                        <div style="width:8px; height:8px; background:#ef4444; border-radius:1px;"></div> 削除
                                    </div>
                                    <div id="summary-removed-text" style="color:#1e293b; font-weight:700;">0 (0%)</div>
                                </div>
                                <div style="display:flex; align-items:center; justify-content:space-between; font-size:11px;">
                                    <div style="display:flex; align-items:center; gap:6px; color:#475569; font-weight:600;">
                                        <div style="width:8px; height:8px; background:#f97316; border-radius:1px;"></div> 変更
                                    </div>
                                    <div id="summary-changed-text" style="color:#1e293b; font-weight:700;">0 (0%)</div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Shared Memos -->
                    <div style="background:#fff; border:1px solid #eef2f6; border-radius:8px; display:flex; flex-direction:column; overflow:hidden; flex:1;">
                        <h3 style="font-size:13px; font-weight:700; color:#1e293b; margin:16px 16px 12px 16px;">共有メモ</h3>
                        <div id="diff-memo-list" style="flex:1; overflow-y:auto; padding:0 16px;">
                            <div style="padding:40px 20px; text-align:center; color:#94a3b8; font-size:12px;">共有メモはありません</div>
                        </div>
                        <div style="padding:16px; border-top:1px solid #f1f5f9;">
                            <textarea id="diff-memo-input" placeholder="メモを入力..." style="width:100%; min-height:72px; padding:10px; border:1px solid #e2e8f0; border-radius:8px; font-size:12px; margin-bottom:10px; outline:none; resize:none; box-sizing:border-box;"
                                onkeydown="if(event.ctrlKey&&event.key==='Enter'){window.app.addDiffMemo();}"></textarea>
                            <button onclick="window.app.addDiffMemo()" style="width:100%; padding:10px; background:#0b2d62; color:#fff; border:none; border-radius:8px; font-size:12px; font-weight:700; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:8px;">
                                <i class="fa-solid fa-paper-plane"></i> メモを送信する
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Bottom Labels -->
            <div style="padding:12px 24px; border-top:1px solid #eef2f6; background:#fff; display:flex; gap:20px; align-items:center; font-size:11px; font-weight:600;">
                <div style="display:flex; align-items:center; gap:8px; color:#16a34a;">
                    <div style="width:12px; height:12px; border:1px solid #16a34a; border-radius:2px;"></div> 追加：新しく追加された内容
                </div>
                <div style="display:flex; align-items:center; gap:8px; color:#ef4444;">
                    <div style="width:12px; height:12px; border:1px solid #ef4444; border-radius:2px;"></div> 削除：削除された内容
                </div>
                <div style="display:flex; align-items:center; gap:8px; color:#f97316;">
                    <div style="width:12px; height:12px; border:1px solid #f97316; border-radius:2px;"></div> 変更：変更・修正された内容
                </div>
            </div>
        </div>

        <style>
            .diff-view-v3 * { box-sizing: border-box; }
            .diff-view-v3 select:hover { border-color: #3b82f6; }
            #diff-nav-list::-webkit-scrollbar, #diff-render-target::-webkit-scrollbar { width: 5px; }
            #diff-nav-list::-webkit-scrollbar-track, #diff-render-target::-webkit-scrollbar-track { background: transparent; }
            #diff-nav-list::-webkit-scrollbar-thumb, #diff-render-target::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 10px; }

            /* Custom Checkbox Styling */
            .custom-checkbox-label {
                display: flex;
                align-items: center;
                gap: 8px;
                font-size: 12px;
                font-weight: 700;
                cursor: pointer;
                position: relative;
                user-select: none;
            }
            .custom-checkbox-label input {
                position: absolute;
                opacity: 0;
                cursor: pointer;
                height: 0;
                width: 0;
            }
            .custom-checkbox {
                height: 18px;
                width: 18px;
                background-color: #fff;
                border-radius: 4px;
                border: 1px solid currentColor;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: all 0.2s;
            }
            .custom-checkbox-label input:checked ~ .custom-checkbox {
                background-color: currentColor;
            }
            .custom-checkbox:after {
                content: "";
                display: none;
                width: 5px;
                height: 10px;
                border: solid #fff;
                border-width: 0 2.5px 2.5px 0;
                transform: rotate(45deg);
                margin-top: -2px;
            }
            .custom-checkbox-label input:checked ~ .custom-checkbox:after {
                display: block;
            }
        </style>
    `;
};

export function afterRender(options = {}) {
    const { contractId, escapeHtmlText, formatDisplayTimestamp } = options;
    const app = options.app || window.app || {};
    const dbService = app.dbService || window.app?.dbService || options.dbService;
    if (!dbService) return;

    // Execute asynchronously to eliminate page transition blocking/freezing
    setTimeout(async () => {
        let actualContractId = contractId || app.currentContractId;
        const allContracts = dbService.getContracts();

        if (!actualContractId && allContracts.length > 0) {
            actualContractId = allContracts[0].id;
        }

        const contract = actualContractId ? dbService.getContractById(actualContractId) : null;
        const docs = actualContractId ? dbService.getDocumentsMetaByContractId(actualContractId) : [];

        const safeFormatDate = (date) => {
            const fmt = formatDisplayTimestamp?.(date) || String(date || '');
            return (fmt && fmt !== 'Invalid Date') ? fmt : '';
        };

        // 1. Populate old/new select dropdown lists
        const docOptionsOld = docs.map(d => `<option value="${d.id}" ${String(d.id) === String(app.selectedOldFile || '') ? 'selected' : ''}>${escapeHtmlText(d.document_name || '名称未設定')} (${safeFormatDate(d.uploaded_at || d.created_at)})</option>`).join('');
        const docOptionsNew = docs.map(d => `<option value="${d.id}" ${String(d.id) === String(app.selectedNewFile || '') ? 'selected' : ''}>${escapeHtmlText(d.document_name || '名称未設定')} (${safeFormatDate(d.uploaded_at || d.created_at)})</option>`).join('');

        const selectOld = document.getElementById('diff-select-old');
        const selectNew = document.getElementById('diff-select-new');
        if (selectOld) selectOld.innerHTML = `<option value="">バージョンを選択...</option>${docOptionsOld}`;
        if (selectNew) selectNew.innerHTML = `<option value="">バージョンを選択...</option>${docOptionsNew}`;

        // 2. Populate Drag & Drop zones (file name & icon details)
        const oldContractData = app.oldContractId ? dbService.getContractById(app.oldContractId) : null;
        const newContractData = app.newContractId ? dbService.getContractById(app.newContractId) : null;

        const dropZoneOldContent = document.getElementById('drop-zone-old-content');
        const dropZoneNewContent = document.getElementById('drop-zone-new-content');
        if (dropZoneOldContent) {
            dropZoneOldContent.innerHTML = oldContractData
                ? `<i class="fa-solid fa-file-contract" style="font-size:32px; color:#3b82f6;"></i><div style="font-size:14px; font-weight:700; color:#334155;">${escapeHtmlText(oldContractData.name)}</div>`
                : `<i class="fa-solid fa-file-arrow-down" style="font-size:32px; color:#cbd5e1;"></i><span style="font-size:13px; color:#94a3b8;">契約書一覧からドラッグ＆ドロップで選択</span>`;
        }
        if (dropZoneNewContent) {
            dropZoneNewContent.innerHTML = newContractData
                ? `<i class="fa-solid fa-file-contract" style="font-size:32px; color:#16a34a;"></i><div style="font-size:14px; font-weight:700; color:#334155;">${escapeHtmlText(newContractData.name)}</div>`
                : `<i class="fa-solid fa-file-arrow-up" style="font-size:32px; color:#cbd5e1;"></i><span style="font-size:13px; color:#94a3b8;">契約書一覧からドラッグ＆ドロップで選択</span>`;
        }

        const findDocumentById = (docId) => {
            if (!docId) return null;
            for (const item of allContracts) {
                const itemDocs = dbService.getDocumentsByContractId(item.id);
                const doc = itemDocs.find(entry => String(entry.id) === String(docId));
                if (doc) {
                    return {
                        ...doc,
                        contract: item,
                        contract_name: item.name || item.original_filename || '契約書'
                    };
                }
            }
            return null;
        };

        const contentToText = (content) => {
            if (!content) return '';
            if (typeof content === 'string') return content.trim();
            if (Array.isArray(content)) {
                return content.map(item => contentToText(item)).filter(Boolean).join('\n').trim();
            }
            const parts = [];
            [
                content.extractedText,
                content.text,
                content.fullText,
                content.full_text,
                content.rawText,
                content.raw_text,
                content.contractText
            ].forEach((value) => {
                if (!value) return;
                const text = typeof value === 'object' ? contentToText(value) : String(value).trim();
                if (text) parts.push(text);
            });
            const preamble = String(content.preamble || '').trim();
            if (preamble) parts.push(preamble);
            const articles = Array.isArray(content.articles)
                ? content.articles
                : (Array.isArray(content.clauses)
                    ? content.clauses
                    : (Array.isArray(content.sections) ? content.sections : []));
            articles.forEach((article) => {
                const title = String(article?.title || article?.articleNumber || article?.article || article?.heading || '').trim();
                const body = String(article?.content || article?.body || article?.text || '').trim();
                if (title) parts.push(title);
                if (body) parts.push(body);
                if (Array.isArray(article?.paragraphs)) {
                    article.paragraphs.forEach((paragraph) => {
                        const text = typeof paragraph === 'object'
                            ? contentToText(paragraph)
                            : String(paragraph || '').trim();
                        if (text) parts.push(text);
                    });
                }
            });
            return parts.join('\n').trim();
        };
        const getAiAnalysisStateKey = (id) => `diff-check-ai-state:${id}`;
        const lastAiAnalysisStateKey = 'diff-check-ai-state:last';
        const setAiAnalysisState = (id, state) => {
            if (!window.aiAnalysisStates) window.aiAnalysisStates = {};
            const nextState = { ...state, contractId: id };
            window.aiAnalysisStates[id] = nextState;
            try {
                if (nextState.status === 'analyzing') {
                    sessionStorage.setItem(getAiAnalysisStateKey(id), JSON.stringify(nextState));
                    sessionStorage.setItem(lastAiAnalysisStateKey, JSON.stringify(nextState));
                } else {
                    sessionStorage.removeItem(getAiAnalysisStateKey(id));
                    const lastSaved = sessionStorage.getItem(lastAiAnalysisStateKey);
                    if (lastSaved) {
                        const lastState = JSON.parse(lastSaved);
                        if (String(lastState?.contractId) === String(id)) {
                            sessionStorage.removeItem(lastAiAnalysisStateKey);
                        }
                    }
                }
            } catch (error) {
                console.warn('AI差分解析状態の保存に失敗しました:', error);
            }
        };
        const getAiAnalysisState = (id) => {
            if (!window.aiAnalysisStates) window.aiAnalysisStates = {};
            if (window.aiAnalysisStates[id]) return window.aiAnalysisStates[id];
            try {
                const saved = sessionStorage.getItem(getAiAnalysisStateKey(id));
                if (saved) {
                    const parsed = JSON.parse(saved);
                    if (['failed', 'timeout'].includes(parsed.status)) {
                        return { status: 'idle', progress: 0, message: '' };
                    }
                    window.aiAnalysisStates[id] = parsed;
                    return window.aiAnalysisStates[id];
                }
                const lastSaved = sessionStorage.getItem(lastAiAnalysisStateKey);
                if (lastSaved) {
                    const lastState = JSON.parse(lastSaved);
                    if (lastState && String(lastState.contractId) === String(id)) {
                        if (['failed', 'timeout'].includes(lastState.status)) {
                            return { status: 'idle', progress: 0, message: '' };
                        }
                        return lastState;
                    }
                }
            } catch (error) {
                console.warn('AI差分解析状態の読み込みに失敗しました:', error);
            }
            return { status: 'idle', progress: 0, message: '' };
        };
        const clearAiAnalysisState = (id) => {
            setAiAnalysisState(id, { status: 'idle', progress: 100, message: '' });
            try {
                sessionStorage.removeItem(getAiAnalysisStateKey(id));
                const lastSaved = sessionStorage.getItem(lastAiAnalysisStateKey);
                if (lastSaved) {
                    const lastState = JSON.parse(lastSaved);
                    if (String(lastState?.contractId) === String(id)) {
                        sessionStorage.removeItem(lastAiAnalysisStateKey);
                    }
                }
            } catch (error) {
                console.warn('AI差分解析状態の削除に失敗しました:', error);
            }
        };

        const splitLines = (value) => String(value || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        const renderLineList = (lines, color = '#334155') => lines.length
            ? lines.map(line => `<div style="font-size:12px; color:${color}; line-height:1.7; white-space:pre-wrap;">${escapeHtmlText(line)}</div>`).join('')
            : '<div style="font-size:12px; color:#94a3b8; text-align:center; padding:16px 8px;">該当する本文はありません</div>';

        const getArticleTitle = (article, index = 0) => {
            const rawTitle = String(article?.title || article?.articleNumber || article?.article || '').trim();
            return rawTitle || `条文 ${index + 1}`;
        };

        const getArticleBody = (article) => {
            const body = String(article?.content || '').trim();
            if (body) return body;
            if (Array.isArray(article?.paragraphs)) {
                return article.paragraphs.map(paragraph => String(paragraph || '').trim()).filter(Boolean).join('\n');
            }
            return '';
        };

        const getArticles = (content) => {
            if (!content || typeof content !== 'object') return [];
            const articles = Array.isArray(content) ? content : (Array.isArray(content.articles) ? content.articles : []);
            return articles.map((article, index) => ({
                title: getArticleTitle(article, index),
                body: getArticleBody(article)
            }));
        };

        const renderArticleCell = (article, type, side) => {
            if (!article) {
                return '<div style="height:100%; min-height:120px; display:flex; align-items:center; justify-content:center; color:#94a3b8; font-size:12px; font-weight:700;">（該当条文なし）</div>';
            }

            const color = type === 'removed'
                ? '#b42318'
                : side === 'new' && (type === 'added' || type === 'changed')
                    ? '#166534'
                    : '#111827';
            const marker = type === 'added' && side === 'new'
                ? '<span style="margin-left:8px; padding:2px 7px; border-radius:999px; background:#dcfce7; color:#16a34a; font-size:10px; font-weight:800;">追加</span>'
                : type === 'removed' && side === 'old'
                    ? '<span style="margin-left:8px; padding:2px 7px; border-radius:999px; background:#fee2e2; color:#ef4444; font-size:10px; font-weight:800;">削除</span>'
                    : '';
            const highlightBg = type === 'removed'
                ? '#fee2e2'
                : type === 'changed'
                    ? (side === 'old' ? '#fef3c7' : '#dcfce7')
                    : type === 'added'
                        ? '#dcfce7'
                        : 'transparent';
            const bodyHtml = escapeHtmlText(article.body || '本文なし').replace(/\n/g, '<br>');

            return `
                <div style="padding:18px 22px 20px;">
                    <div style="font-size:14px; font-weight:800; color:${color}; margin-bottom:12px;">
                        ${escapeHtmlText(article.title)}${marker}
                    </div>
                    <div style="display:inline; background:${highlightBg}; color:${color}; font-size:13px; font-weight:650; line-height:2; box-decoration-break:clone; -webkit-box-decoration-break:clone; padding:2px 4px; border-radius:4px;">
                        ${bodyHtml}
                    </div>
                </div>
            `;
        };

        const renderChangeIcon = (type) => {
            const config = {
                added: { icon: 'fa-plus', bg: '#16a34a', label: '追加' },
                removed: { icon: 'fa-minus', bg: '#ef4444', label: '削除' },
                changed: { icon: 'fa-pen', bg: '#f59e0b', label: '変更' },
                same: { icon: 'fa-equals', bg: '#cbd5e1', label: '同一' }
            }[type] || { icon: 'fa-pen', bg: '#f59e0b', label: '変更' };
            return `
                <div title="${config.label}" style="width:24px; height:24px; border-radius:999px; background:${config.bg}; color:#fff; display:flex; align-items:center; justify-content:center; font-size:11px; box-shadow:0 4px 10px rgba(15,23,42,0.12);">
                    <i class="fa-solid ${config.icon}"></i>
                </div>
            `;
        };

        const renderDiffRow = (oldArticle, newArticle, type) => {
            const oldBg = type === 'removed' ? '#fff7f7' : '#fff';
            const newBg = type === 'added' ? '#f7fff9' : '#fff';
            return `
                <div style="display:grid; grid-template-columns:minmax(0, 1fr) 40px minmax(0, 1fr); border-bottom:1px solid #e5e7eb; min-height:140px;">
                    <div style="background:${oldBg}; border-right:1px solid #e5e7eb;">${renderArticleCell(oldArticle, type, 'old')}</div>
                    <div style="background:#f8fafc; border-right:1px solid #e5e7eb; display:flex; align-items:center; justify-content:center;">${renderChangeIcon(type)}</div>
                    <div style="background:${newBg};">${renderArticleCell(newArticle, type, 'new')}</div>
                </div>
            `;
        };

        const updateDiffStats = (added, removed, changed, total) => {
            const setText = (id, value) => {
                const el = document.getElementById(id);
                if (el) el.textContent = String(value);
            };
            const percent = (value) => total > 0 ? Math.round((value / total) * 100) : 0;
            setText('summary-added-text', `${added} (${percent(added)}%)`);
            setText('summary-removed-text', `${removed} (${percent(removed)}%)`);
            setText('summary-changed-text', `${changed} (${percent(changed)}%)`);

            const donutEl = document.getElementById('summary-donut');
            if (donutEl) {
                const addedPct = percent(added);
                const removedPct = percent(removed);
                const changedPct = percent(changed);
                donutEl.style.border = 'none';
                donutEl.style.background = total > 0
                    ? `conic-gradient(#16a34a 0% ${addedPct}%, #ef4444 ${addedPct}% ${addedPct + removedPct}%, #f97316 ${addedPct + removedPct}% ${addedPct + removedPct + changedPct}%, #e2e8f0 ${addedPct + removedPct + changedPct}% 100%)`
                    : '#e2e8f0';
                donutEl.innerHTML = `<div style="position:absolute; inset:14px; background:#fff; border-radius:50%; display:flex; align-items:center; justify-content:center;"><span style="font-size:10px; font-weight:800; color:#334155;">${total}</span></div>`;
            }
        };

        const renderDiffResult = async () => {
            const oldDoc = findDocumentById(app.selectedOldFile);
            const newDoc = findDocumentById(app.selectedNewFile);
            const ddContainer = document.getElementById('diff-dd-container');
            const renderTarget = document.getElementById('diff-render-target');
            if (!renderTarget || !oldDoc || !newDoc) return;

            if (ddContainer) ddContainer.style.display = 'none';
            renderTarget.style.flex = '1';
            renderTarget.style.minHeight = '0';
            renderTarget.style.overflowY = 'auto';

            const oldText = contentToText(oldDoc.content);
            const newText = contentToText(newDoc.content);
            const oldArticles = getArticles(oldDoc.content);
            const newArticles = getArticles(newDoc.content);
            await app.ensureDiffLibrary?.();
            const diffParts = window.Diff?.diffLines ? window.Diff.diffLines(oldText, newText) : null;

            let added = 0;
            let removed = 0;
            let changed = 0;
            let rows = '';

            if (oldArticles.length || newArticles.length) {
                const usedNewIndexes = new Set();
                oldArticles.forEach((oldArticle) => {
                    const newIndex = newArticles.findIndex((candidate, index) => !usedNewIndexes.has(index) && candidate.title === oldArticle.title);
                    if (newIndex >= 0) {
                        usedNewIndexes.add(newIndex);
                        const newArticle = newArticles[newIndex];
                        const type = oldArticle.body === newArticle.body ? 'same' : 'changed';
                        if (type === 'changed') changed += 1;
                        rows += renderDiffRow(oldArticle, newArticle, type);
                    } else {
                        removed += 1;
                        rows += renderDiffRow(oldArticle, null, 'removed');
                    }
                });
                newArticles.forEach((newArticle, index) => {
                    if (usedNewIndexes.has(index)) return;
                    added += 1;
                    rows += renderDiffRow(null, newArticle, 'added');
                });
            } else if (diffParts) {
                for (let i = 0; i < diffParts.length; i += 1) {
                    const part = diffParts[i];
                    if (part.removed && diffParts[i + 1]?.added) {
                        const oldLines = splitLines(part.value);
                        const newLines = splitLines(diffParts[i + 1].value);
                        changed += Math.max(oldLines.length, newLines.length);
                        rows += `
                            <div style="display:grid; grid-template-columns:minmax(0, 1fr) 40px minmax(0, 1fr); border-bottom:1px solid #e5e7eb;">
                                <div style="padding:18px 22px; background:#fff7ed; border-right:1px solid #e5e7eb;">${renderLineList(oldLines, '#92400e')}</div>
                                <div style="background:#f8fafc; border-right:1px solid #e5e7eb; display:flex; align-items:center; justify-content:center;">${renderChangeIcon('changed')}</div>
                                <div style="padding:18px 22px; background:#f0fdf4;">${renderLineList(newLines, '#166534')}</div>
                            </div>
                        `;
                        i += 1;
                    } else if (part.removed) {
                        const oldLines = splitLines(part.value);
                        removed += oldLines.length;
                        rows += `
                            <div style="display:grid; grid-template-columns:minmax(0, 1fr) 40px minmax(0, 1fr); border-bottom:1px solid #e5e7eb;">
                                <div style="padding:18px 22px; background:#fff7f7; border-right:1px solid #e5e7eb;">${renderLineList(oldLines, '#991b1b')}</div>
                                <div style="background:#f8fafc; border-right:1px solid #e5e7eb; display:flex; align-items:center; justify-content:center;">${renderChangeIcon('removed')}</div>
                                <div style="padding:18px 22px; background:#fff; display:flex; align-items:center; justify-content:center;"><span style="font-size:12px; color:#94a3b8; font-weight:700;">（該当条文なし）</span></div>
                            </div>
                        `;
                    } else if (part.added) {
                        const newLines = splitLines(part.value);
                        added += newLines.length;
                        rows += `
                            <div style="display:grid; grid-template-columns:minmax(0, 1fr) 40px minmax(0, 1fr); border-bottom:1px solid #e5e7eb;">
                                <div style="padding:18px 22px; background:#fff; border-right:1px solid #e5e7eb; display:flex; align-items:center; justify-content:center;"><span style="font-size:12px; color:#94a3b8; font-weight:700;">（該当条文なし）</span></div>
                                <div style="background:#f8fafc; border-right:1px solid #e5e7eb; display:flex; align-items:center; justify-content:center;">${renderChangeIcon('added')}</div>
                                <div style="padding:18px 22px; background:#f7fff9;">${renderLineList(newLines, '#166534')}</div>
                            </div>
                        `;
                    }
                }
            }

            if (!rows) {
                rows = `
                    <div style="display:grid; grid-template-columns:minmax(0, 1fr) 40px minmax(0, 1fr); min-height:240px; border-bottom:1px solid #e5e7eb;">
                        <div style="padding:18px 22px; background:#fff; border-right:1px solid #e5e7eb;">${renderLineList(splitLines(oldText))}</div>
                        <div style="background:#f8fafc; border-right:1px solid #e5e7eb; display:flex; align-items:center; justify-content:center;">${renderChangeIcon('same')}</div>
                        <div style="padding:18px 22px; background:#fff;">${renderLineList(splitLines(newText))}</div>
                    </div>
                `;
            }

            const same = Math.max(0, (oldArticles.length || newArticles.length) ? rows.split('fa-equals').length - 1 : 0);
            const total = added + removed + changed + same;
            updateDiffStats(added, removed, changed, total);
            renderTarget.innerHTML = `
                <div style="height:100%; overflow-y:auto; background:#fff; border:1px solid #e5e7eb; border-radius:8px;">
                    <div style="display:grid; grid-template-columns:minmax(0, 1fr) 40px minmax(0, 1fr); position:sticky; top:0; z-index:5; background:#fff; border-bottom:1px solid #e5e7eb;">
                        <div style="padding:14px 18px; background:#eef2ff; font-size:13px; font-weight:800; color:#111827; border-right:1px solid #dbe3ef;">
                            <i class="fa-solid fa-clock-rotate-left" style="margin-right:6px;"></i>旧版：${escapeHtmlText(oldDoc.document_name || oldDoc.contract_name)}
                        </div>
                        <div style="background:#f8fafc; border-right:1px solid #dbe3ef;"></div>
                        <div style="padding:14px 18px; background:#dcfce7; font-size:13px; font-weight:800; color:#111827;">
                            <i class="fa-solid fa-file-circle-plus" style="margin-right:6px;"></i>新版：${escapeHtmlText(newDoc.document_name || newDoc.contract_name)}
                        </div>
                    </div>
                    ${rows}
                </div>
            `;
        };

        if (app.isAnalyzed && app.selectedOldFile && app.selectedNewFile) {
            await renderDiffResult();
        }

        // 3. Populate contract sidebar list
        const contractListEl = document.getElementById('diff-contract-list');
        if (contractListEl) {
            const listHtml = allContracts.filter(c => {
                if (c.original_content) return true;
                if (Array.isArray(c.history) && c.history.some(h => h.content)) return true;
                return false;
            }).map(c => {
                const safeName = escapeHtmlText(c.name).replace(/'/g, "&#39;");
                return `
                    <div draggable="true"
                         class="contract-item"
                         data-id="${c.id}"
                         data-name="${safeName}"
                         ondragstart="event.dataTransfer.setData('application/json', JSON.stringify({id:this.dataset.id,name:this.dataset.name})); event.dataTransfer.setData('text/plain', this.dataset.id); event.dataTransfer.effectAllowed='copy'; this.style.opacity='0.65';"
                         ondragend="this.style.opacity='1';"
                         onclick="window.app.navigate('diff-check', '${c.id}')"
                         style="padding:10px 12px; border:1px solid #f1f5f9; border-radius:6px; margin-bottom:6px; cursor:grab; background:#fff; transition:all 0.2s;"
                         onmouseover="this.style.boxShadow='0 4px 12px rgba(0,0,0,0.05)';"
                         onmouseout="this.style.boxShadow='none';">
                        <div style="display:flex; align-items:center; gap:12px; pointer-events:none;">
                            <div style="width:28px; height:28px; border-radius:6px; background:#f1f5f9; display:flex; align-items:center; justify-content:center; color:#64748b; font-size:13px; flex-shrink:0;">
                                <i class="fa-solid fa-file-contract"></i>
                            </div>
                            <div style="flex:1; min-width:0;">
                                <div style="font-size:13px; font-weight:600; color:#334155; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                                    ${safeName}
                                </div>
                            </div>
                        </div>
                    </div>
                `;
            }).join('');
            contractListEl.innerHTML = listHtml || '<div style="padding:20px;text-align:center;color:#94a3b8;font-size:12px;">対象の契約書はありません</div>';
        }

        // 4. Populate shared memos
        const memoListEl = document.getElementById('diff-memo-list');
        if (memoListEl) {
            const oldId = app.selectedOldFile;
            const newId = app.selectedNewFile;
            const memos = (oldId && newId && typeof dbService.getDiffMemos === 'function')
                ? dbService.getDiffMemos(oldId, newId)
                : [];
            if (memos && memos.length > 0) {
                memoListEl.innerHTML = memos.map(m => {
                    const author = escapeHtmlText(m.author || 'あなた');
                    const text = escapeHtmlText(m.text || '');
                    const dateStr = m.timestamp ? new Date(m.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : '以前';
                    return `
                        <div style="padding:10px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:6px; margin-bottom:8px; font-size:12px; color:#334155; line-height:1.4;">
                            <div style="display:flex; justify-content:space-between; margin-bottom:4px; font-weight:700; color:#64748b; font-size:10px;">
                                <span>${author}</span>
                                <span>${dateStr}</span>
                            </div>
                            <div style="white-space:pre-wrap; word-break:break-all;">${text}</div>
                        </div>
                    `;
                }).join('');
                memoListEl.scrollTop = memoListEl.scrollHeight;
            } else {
                memoListEl.innerHTML = '<div style="padding:40px 20px; text-align:center; color:#94a3b8; font-size:12px;">共有メモはありません</div>';
            }
        }

        // 5. Initialize & Render AI Risk Summary Card
        if (actualContractId) {
            // Setup global state container if not present
            if (!window.aiAnalysisStates) {
                window.aiAnalysisStates = {};
            }
            getAiAnalysisState(actualContractId);

            // Expose escapeHtmlText to app scope for dialogs
            window.app.escapeHtmlText = escapeHtmlText;
            window.app.dbService = dbService;

            // Define confirming overlay dialog
            window.app.confirmAiSummary = (contractId) => {
                const selectOld = document.getElementById('diff-select-old');
                const selectNew = document.getElementById('diff-select-new');
                const oldLabel = selectOld ? selectOld.options[selectOld.selectedIndex]?.text || '未選択' : '未選択';
                const newLabel = selectNew ? selectNew.options[selectNew.selectedIndex]?.text || '未選択' : '未選択';

                const overlay = document.createElement('div');
                overlay.id = 'ai-summary-confirm-overlay';
                overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:9500;display:flex;align-items:center;justify-content:center;font-family:\'Inter\', sans-serif;';
                overlay.innerHTML = `
                    <div style="background:#fff;border-radius:12px;padding:28px 32px;width:420px;max-width:92vw;box-shadow:0 8px 32px rgba(0,0,0,0.18);">
                        <div style="display:flex;align-items:flex-start;gap:14px;margin-bottom:20px;">
                            <div style="width:40px;height:40px;border-radius:10px;background:#eff6ff;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                                <i class="fa-solid fa-shield-halved" style="color:#2563eb;font-size:20px;"></i>
                            </div>
                            <div>
                                <div style="font-size:15px;font-weight:700;color:#1e293b;margin-bottom:6px;">AI差分解析を実行しますか？</div>
                                <div style="font-size:13px;color:#64748b;line-height:1.6;font-weight:500;">
                                    差分チェック結果をもとに、変更点の重要度・注意点・影響範囲をAIで整理します。<br>
                                    <strong style="color:#2563eb;">この解析はAI解析回数を1回消費します。</strong>
                                </div>
                            </div>
                        </div>
                        <div style="background:#f8fafc;border-radius:8px;padding:12px 14px;margin-bottom:20px;font-size:12px;color:#475569;line-height:1.6;border:1px solid #e2e8f0;font-weight:600;">
                            <div style="margin-bottom:4px;display:flex;gap:4px;"><span style="color:#64748b;min-width:48px;">比較元：</span><span style="color:#334155;word-break:break-all;">${escapeHtmlText(oldLabel)}</span></div>
                            <div style="display:flex;gap:4px;"><span style="color:#64748b;min-width:48px;">比較先：</span><span style="color:#334155;word-break:break-all;">${escapeHtmlText(newLabel)}</span></div>
                        </div>
                        <div style="display:flex;gap:10px;justify-content:flex-end;">
                            <button onclick="document.getElementById('ai-summary-confirm-overlay').remove()"
                                style="padding:8px 16px;border:1px solid #e2e8f0;border-radius:6px;background:#fff;color:#475569;font-size:12px;font-weight:700;cursor:pointer;outline:none;">あとで</button>
                            <button id="btn-start-ai-summary"
                                style="padding:8px 18px;border:none;border-radius:6px;background:#0b2d62;color:#fff;font-size:12px;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:6px;outline:none;transition:background 0.2s;"
                                onmouseover="this.style.background=\'#1e40af\'" onmouseout="this.style.background=\'#0b2d62\'">
                                <i class="fa-solid fa-play"></i>AI差分解析を実行
                            </button>
                        </div>
                    </div>`;
                document.body.appendChild(overlay);
                
                overlay.querySelector('#btn-start-ai-summary').onclick = () => {
                    overlay.remove();
                    window.app.runAiSummary(contractId);
                };
                overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
            };

            // Define real execution logic
            window.app.runAiSummary = async (contractId) => {
                setAiAnalysisState(contractId, { status: 'analyzing', progress: 10, message: '' });
                window.app.updateAiSummaryUi(contractId);

                // Start fake progress progress bar animation
                let currentProgress = 10;
                const progressTimer = setInterval(() => {
                    if (currentProgress < 90) {
                        currentProgress += Math.floor(Math.random() * 8) + 3;
                        if (currentProgress > 90) currentProgress = 90;
                        const currentState = getAiAnalysisState(contractId);
                        if (currentState.status === 'analyzing') {
                            setAiAnalysisState(contractId, { ...currentState, progress: currentProgress });
                            window.app.updateAiSummaryUi(contractId);
                        }
                    }
                }, 500);

                try {
                    const oldDoc = findDocumentById(window.app.selectedOldFile);
                    const newDoc = findDocumentById(window.app.selectedNewFile);
                    if (!oldDoc || !newDoc) {
                        throw new Error('比較元と比較先の資料を選択してください。');
                    }

                    const aiModule = await import('../ai-service.js');
                    const currentPayload = contentToText(newDoc.content);
                    const previousPayload = contentToText(oldDoc.content);
                    if (!currentPayload || !previousPayload) {
                        throw new Error('比較元または比較先の本文データを読み取れませんでした。資料を選び直してから再実行してください。');
                    }
                    if (currentPayload.length < 20 || previousPayload.length < 20) {
                        throw new Error('本文データが短すぎるためAI差分解析を実行できません。取り込み済みの資料内容を確認してください。');
                    }
                    const analysisPromise = aiModule.aiService.analyzeContract(
                        contractId,
                        'text',
                        currentPayload,
                        previousPayload,
                        { userTriggered: true }
                    );
                    let analysisTimeoutId = null;
                    const timeoutPromise = new Promise((_, reject) => {
                        analysisTimeoutId = setTimeout(() => {
                            const timeoutError = new Error('AI差分解析の応答に時間がかかりすぎています。時間をおいて再実行してください。');
                            timeoutError.name = 'AbortError';
                            reject(timeoutError);
                        }, 90000);
                    });
                    const data = await Promise.race([analysisPromise, timeoutPromise])
                        .finally(() => {
                            if (analysisTimeoutId) clearTimeout(analysisTimeoutId);
                        });
                    clearInterval(progressTimer);

                    if (!data.success) {
                        const message = data.error || data.message || data.data?.message || 'AI差分解析を完了できませんでした。';
                        setAiAnalysisState(contractId, {
                            status: 'failed',
                            progress: 0,
                            message
                        });
                        window.app.updateAiSummaryUi(contractId);
                        window.Notify?.error?.(message);
                        return;
                    }
                    const analysisData = data.data || data;
                    if (!analysisData || typeof analysisData !== 'object') {
                        throw new Error('AI差分解析の結果を読み取れませんでした。もう一度解析してください。');
                    }
                    if (analysisData.aiFailed === true || analysisData.isFallback === true) {
                        const message = analysisData.error || analysisData.message || analysisData.riskReason || 'AI差分解析に失敗しました。';
                        setAiAnalysisState(contractId, {
                            status: 'failed',
                            progress: 0,
                            message
                        });
                        window.app.updateAiSummaryUi(contractId);
                        window.Notify?.error?.(message);
                        return;
                    }

                    if (typeof dbService.saveDiffResult === 'function') {
                        dbService.saveDiffResult({
                            contract_id: contractId,
                            docA_id: oldDoc.id,
                            docB_id: newDoc.id,
                            diff_data: {
                                summary: analysisData.summary || analysisData.changeSummary || '',
                                riskLevel: analysisData.riskLevel ?? analysisData.risk_level ?? 1,
                                riskReason: analysisData.riskReason || analysisData.risk_reason || '',
                                changes: Array.isArray(analysisData.changes) ? analysisData.changes : [],
                                isFallback: analysisData.isFallback === true,
                                aiFailed: analysisData.aiFailed === true
                            },
                            created_at: new Date().toISOString()
                        });
                    }

                    // Save deadline metadata parameters if exists
                    if (analysisData.contract_meta) {
                        const meta = analysisData.contract_meta;
                        const allContractsList = dbService.getContracts();
                        const idx = allContractsList.findIndex(x => String(x.id) === String(contractId));
                        if (idx !== -1) {
                            Object.assign(allContractsList[idx], {
                                expiry_date: meta.expiry_date || null,
                                renewal_deadline: meta.renewal_deadline || null,
                                contract_start: meta.contract_start || null,
                                auto_renewal: meta.auto_renewal,
                                contract_category: meta.contract_category || null,
                                date_confidence: meta.date_confidence || 'unknown',
                            });
                            localStorage.setItem(dbService.KEYS.CONTRACTS, JSON.stringify(allContractsList));
                        }
                    }

                    // Advance state completion
                    clearAiAnalysisState(contractId);
                    window.app.updateAiSummaryUi(contractId);

                    // Smooth reload targets
                    window.app.navigate('diff-check', contractId);

                } catch (err) {
                    clearInterval(progressTimer);
                    console.error('AI diff analysis failed:', err);
                    const rawMessage = err?.message || 'AI差分解析を完了できませんでした。';
                    if (err.name === 'AbortError') {
                        setAiAnalysisState(contractId, {
                            status: 'timeout',
                            progress: 0,
                            message: '通信または解析処理が制限時間を超えました。時間をおいて再実行してください。'
                        });
                    } else {
                        setAiAnalysisState(contractId, {
                            status: 'failed',
                            progress: 0,
                            message: rawMessage
                        });
                    }
                    window.app.updateAiSummaryUi(contractId);
                    window.Notify?.error?.(rawMessage);
                }
            };

            // Setup real DOM updating engine
            window.app.updateAiSummaryUi = (contractId) => {
                const container = document.getElementById('ai-risk-summary-container');
                if (!container) return;

                const state = getAiAnalysisState(contractId);
                const contractForUi = dbService.getContractById(contractId);
                const c = contractForUi || { id: contractId };
                if (!contractForUi && !['analyzing', 'timeout', 'failed'].includes(state.status)) {
                    container.innerHTML = '<div style="padding:16px; text-align:center; color:#94a3b8; font-size:12px;">契約書を選択してください</div>';
                    return;
                }
                const selectedDiffResult = (typeof dbService.getDiffResult === 'function' && window.app.selectedOldFile && window.app.selectedNewFile)
                    ? dbService.getDiffResult(window.app.selectedOldFile, window.app.selectedNewFile, contractId)
                    : null;
                const diffData = selectedDiffResult?.diff_data || {};
                const hasResults = Boolean(diffData.summary || diffData.riskReason || (Array.isArray(diffData.changes) && diffData.changes.length > 0));
                const stateMessage = String(state.message || '').trim();

                if (state.status === 'analyzing') {
                    container.innerHTML = `
                        <div style="padding:16px; background:#fff; font-family:\'Inter\', sans-serif;">
                            <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
                                <span style="font-size:13px; font-weight:700; color:#1e293b; display:flex; align-items:center; gap:6px;">
                                    <span style="width:14px;height:14px;border-radius:999px;background:conic-gradient(#22c55e, #3b82f6, #38bdf8, #22c55e);display:inline-block;animation:fa-spin 1s infinite linear;"></span> AI差分解析中
                                </span>
                            </div>
                            <p style="font-size:11px; color:#64748b; line-height:1.5; margin:0 0 12px 0; font-weight:500;">
                                差分チェック結果から、変更点の重要度・注意点・影響範囲を整理しています。
                            </p>
                            
                            <!-- Progress Bar -->
                            <div style="width:100%; height:7px; background:#e2e8f0; border-radius:999px; margin:12px 0; overflow:hidden;">
                                <div style="width:${state.progress}%; height:100%; background:linear-gradient(90deg, #38bdf8 0%, #3b82f6 45%, #22c55e 100%); border-radius:999px; transition:width 0.4s ease; box-shadow:0 0 10px rgba(59,130,246,0.28);"></div>
                            </div>

                            <!-- Progress Checklist -->
                            <div style="display:flex; flex-direction:column; gap:6px; font-size:11px; font-weight:600;">
                                <div style="display:flex; align-items:center; gap:6px; color:${state.progress >= 20 ? '#16a34a' : '#64748b'};">
                                    <i class="fa-solid ${state.progress >= 20 ? 'fa-circle-check' : 'fa-circle'}" style="font-size:12px;"></i> 差分本文を取得済み
                                </div>
                                <div style="display:flex; align-items:center; gap:6px; color:${state.progress >= 60 ? '#16a34a' : (state.progress >= 20 ? '#0ea5e9' : '#64748b')};">
                                    <i class="fa-solid ${state.progress >= 60 ? 'fa-circle-check' : (state.progress >= 20 ? 'fa-circle-notch fa-spin' : 'fa-circle')}" style="font-size:12px;"></i> AIが差分の影響を解析中
                                </div>
                                <div style="display:flex; align-items:center; gap:6px; color:${state.progress >= 100 ? '#16a34a' : '#64748b'};">
                                    <i class="fa-solid ${state.progress >= 100 ? 'fa-circle-check' : 'fa-circle'}" style="font-size:12px;"></i> 解析結果を表示
                                </div>
                            </div>
                        </div>
                    `;
                } else if (state.status === 'timeout') {
                    container.innerHTML = `
                        <div style="padding:16px; background:#fff; border:1px solid #e2e8f0; border-radius:10px; font-family:\'Inter\', sans-serif; box-shadow:0 8px 20px rgba(15,23,42,0.06); margin:0 0 16px 0;">
                            <div style="display:flex; align-items:flex-start; gap:12px; margin-bottom:14px;">
                                <div style="width:34px; height:34px; border-radius:9px; background:#fff7ed; color:#f97316; display:flex; align-items:center; justify-content:center; font-size:15px; flex-shrink:0;">
                                    <i class="fa-solid fa-clock"></i>
                                </div>
                                <div style="flex:1; min-width:0;">
                                    <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:4px;">
                                        <div style="font-size:13px; font-weight:800; color:#1e293b;">AI差分解析がタイムアウトしました</div>
                                    </div>
                                    <p style="font-size:11px; color:#64748b; line-height:1.6; margin:0; font-weight:500;">
                                        ${escapeHtmlText(stateMessage || '通信または解析処理が制限時間を超えました。')} AI解析回数は消費されておりません。比較資料は保持されています。時間をおいてから再解析してください。
                                    </p>
                                </div>
                            </div>
                            <button onclick="window.app.confirmAiSummary('${c.id}')" style="width:100%; padding:9px 12px; background:#0b2d62; color:#fff; border:none; border-radius:8px; font-size:12px; font-weight:800; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:8px; transition:background 0.2s, transform 0.2s; outline:none;" onmouseover="this.style.background=\'#123a78\'; this.style.transform=\'translateY(-1px)\'" onmouseout="this.style.background=\'#0b2d62\'; this.style.transform=\'none\'">
                                <i class="fa-solid fa-rotate-right"></i> 再解析する
                            </button>
                        </div>
                    `;
                } else if (state.status === 'failed') {
                    container.innerHTML = `
                        <div style="padding:16px; background:#fff; border:1px solid #e2e8f0; border-radius:10px; font-family:\'Inter\', sans-serif; box-shadow:0 8px 20px rgba(15,23,42,0.06); margin:0 0 16px 0;">
                            <div style="display:flex; align-items:flex-start; gap:12px; margin-bottom:14px;">
                                <div style="width:34px; height:34px; border-radius:9px; background:#fff1f2; color:#e11d48; display:flex; align-items:center; justify-content:center; font-size:15px; flex-shrink:0;">
                                    <i class="fa-solid fa-circle-exclamation"></i>
                                </div>
                                <div style="flex:1; min-width:0;">
                                    <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:4px;">
                                        <div style="font-size:13px; font-weight:800; color:#1e293b;">AI差分解析に失敗しました</div>
                                    </div>
                                    <p style="font-size:11px; color:#64748b; line-height:1.6; margin:0; font-weight:500;">
                                        ${escapeHtmlText(stateMessage || '一時的な通信エラー、または解析処理側で問題が発生しました。')} AI解析回数は消費されておりません。比較資料と差分チェック結果は保持されています。再解析してください。
                                    </p>
                                </div>
                            </div>
                            <button onclick="window.app.confirmAiSummary('${c.id}')" style="width:100%; padding:9px 12px; background:#0b2d62; color:#fff; border:none; border-radius:8px; font-size:12px; font-weight:800; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:8px; transition:background 0.2s, transform 0.2s; outline:none;" onmouseover="this.style.background=\'#123a78\'; this.style.transform=\'translateY(-1px)\'" onmouseout="this.style.background=\'#0b2d62\'; this.style.transform=\'none\'">
                                <i class="fa-solid fa-rotate-right"></i> 再解析する
                            </button>
                        </div>
                    `;
                } else if (hasResults) {
                    const rLvl = diffData.riskLevel ?? 1;
                    const rRsn = diffData.riskReason || 'AI差分解析が完了しました';
                    const sTxt = diffData.summary || '';
                    
                    container.innerHTML = `
                        <div style="padding:16px; background:#fff; font-family:\'Inter\', sans-serif;">
                            <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px;">
                                <span style="font-size:13px; font-weight:700; color:#1e293b; display:flex; align-items:center; gap:6px;">
                                    <i class="fa-solid fa-chart-line" style="color:#16a34a;"></i> AI差分解析
                                </span>
                                <div style="display:flex; align-items:center; gap:8px;">
                                    <span class="badge ${rLvl >= 3 ? 'badge-danger' : (rLvl >= 2 ? 'badge-warning' : 'badge-success')}" style="padding:2px 6px; border-radius:4px; font-size:10px; font-weight:700;">
                                        ${rLvl >= 3 ? 'High' : (rLvl >= 2 ? 'Medium' : 'Low')}
                                    </span>
                                    <button onclick="window.app.confirmAiSummary('${c.id}')" style="background:none; border:none; color:#64748b; cursor:pointer; font-size:11px; padding:2px; display:inline-flex; align-items:center; justify-content:center;" title="再解析する">
                                        <i class="fa-solid fa-rotate"></i>
                                    </button>
                                </div>
                            </div>
                            <div style="font-size:11px; color:#475569; margin-bottom:8px; line-height:1.4; border-bottom:1px dashed #e2e8f0; padding-bottom:8px; font-weight:700;">
                                ${escapeHtmlText(rRsn)}
                            </div>
                            <div style="font-size:12px; color:#334155; line-height:1.6; max-height:220px; overflow-y:auto; white-space:pre-wrap; padding:8px; background:#f8fafc; border-radius:6px; border:1px solid #e2e8f0; font-weight:500;">${escapeHtmlText(sTxt)}</div>
                        </div>
                    `;
                } else {
                    container.innerHTML = `
                        <div style="padding:16px; background:#fff; font-family:\'Inter\', sans-serif;">
                            <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
                                <span style="font-size:13px; font-weight:700; color:#1e293b; display:flex; align-items:center; gap:6px;">
                                    <i class="fa-solid fa-chart-line" style="color:#0b2d62;"></i> AI差分解析
                                </span>
                                <span style="font-size:10px; background:#f1f5f9; color:#64748b; padding:2px 6px; border-radius:4px; font-weight:700;">未取得</span>
                            </div>
                            <p style="font-size:11px; color:#64748b; line-height:1.5; margin:0 0 12px 0; font-weight:500;">
                                差分チェック結果から、変更点の重要度・注意点・影響範囲をAIで整理できます。
                            </p>
                            <button onclick="window.app.confirmAiSummary('${c.id}')" style="width:100%; padding:8px; background:#0b2d62; color:#fff; border:none; border-radius:6px; font-size:11px; font-weight:700; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:6px; transition:all 0.2s;" onmouseover="this.style.background=\'#1e40af\'" onmouseout="this.style.background=\'#0b2d62\'">
                                <i class="fa-solid fa-wand-magic-sparkles"></i>AI差分解析を実行する
                            </button>
                        </div>
                    `;
                }
            };

            // Trigger immediate render
            window.app.updateAiSummaryUi(actualContractId);
        }
    }, 10);
}
