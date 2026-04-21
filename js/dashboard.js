import { Notify } from './notify.js';
import { dbService } from './db-service.js?v=20260321f';
import { aiService } from './ai-service.js?v=20260309h2';
import { getApiBaseUrl, shouldUseLocalDevAuthBypass } from './api-base.js';
import { auth } from './firebase-config.js';
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

// =========================================================================
// Lazy route loader (additive scaffolding).
// Does NOT replace App.navigate(). Intended for future incremental
// module extraction. See /js/modules/.
// =========================================================================
const routes = {
    dashboard: () => import('./modules/dashboard.js'),
    contracts: () => import('./modules/contracts.js'),
    history: () => import('./modules/history.js'),
    team: () => import('./modules/team.js'),
};

async function navigateLazy(page, renderOptions = {}) {
    const loader = routes[page];
    if (!loader) return;
    try {
        const module = await loader();
        if (module && module.render) {
            return module.render(renderOptions);
        }
    } catch (e) {
        console.error("lazy load error:", e);
    }
    return null;
}

// Expose for future call sites (no existing code depends on this yet).
if (typeof window !== 'undefined') {
    window.__diffsenseNavigateLazy = navigateLazy;
    window.__diffsenseRoutes = routes;
}
const LOCAL_UI_CACHE_VERSION = '20260310v3';
const DASHBOARD_CACHE_KEYS = {
    USER_META: `diffsense_cache_user_meta_${LOCAL_UI_CACHE_VERSION}`,
    SUBSCRIPTION: `diffsense_cache_subscription_${LOCAL_UI_CACHE_VERSION}`,
    RECENT_HISTORY: `diffsense_cache_recent_history_${LOCAL_UI_CACHE_VERSION}`
};

// MCP: URL Resolution helper for Claude/Cursor
// The OAuth discovery (.well-known/oauth-authorization-server) issuer is https://diffsense.spacegleam.co.jp/
// So the correct MCP URL for Claude must always be https://diffsense.spacegleam.co.jp/mcp
const PROD_MCP_PUBLIC_URL = 'https://diffsense.spacegleam.co.jp/mcp';

function resolveDashboardMcpUrl() {
    // Always return the public production URL.
    // Netlify proxies /mcp/* to the backend API transparently.
    // This must match the OAuth issuer in /.well-known/oauth-authorization-server.
    return PROD_MCP_PUBLIC_URL;
}

const SCRIPT_LOAD_CACHE = new Map();

function loadExternalScriptOnce(src, globalGuard = null) {
    if (globalGuard && globalGuard()) {
        return Promise.resolve();
    }
    if (SCRIPT_LOAD_CACHE.has(src)) {
        return SCRIPT_LOAD_CACHE.get(src);
    }
    const loader = new Promise((resolve, reject) => {
        const existing = document.querySelector(`script[data-src="${src}"]`);
        if (existing) {
            if (globalGuard && globalGuard()) {
                resolve();
                return;
            }
            if (existing.dataset.loaded === '1' || existing.readyState === 'complete') {
                resolve();
                return;
            }
            const timeoutId = setTimeout(() => {
                reject(new Error(`Timed out while loading ${src}`));
            }, 10000);
            existing.addEventListener('load', () => resolve(), { once: true });
            existing.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), { once: true });
            existing.addEventListener('load', () => clearTimeout(timeoutId), { once: true });
            existing.addEventListener('error', () => clearTimeout(timeoutId), { once: true });
            return;
        }
        const script = document.createElement('script');
        script.src = src;
        script.async = true;
        script.dataset.src = src;
        const timeoutId = setTimeout(() => {
            reject(new Error(`Timed out while loading ${src}`));
        }, 10000);
        script.onload = () => {
            script.dataset.loaded = '1';
            clearTimeout(timeoutId);
            resolve();
        };
        script.onerror = () => reject(new Error(`Failed to load ${src}`));
        document.head.appendChild(script);
    });
    SCRIPT_LOAD_CACHE.set(src, loader);
    return loader;
}

const parseArticleNumeric = (label) => {
    if (!label) return 0;
    const m = String(label).match(/第\s*([0-9０-９一二三四五六七八九十百千〇零]+)\s*条/);
    if (!m) return 0;
    const raw = m[1].replace(/[０-９]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xfee0));
    if (/^\d+$/.test(raw)) return parseInt(raw, 10);
    const map = { '零': 0, '〇': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
    if (map[raw] !== undefined) return map[raw];
    return 0;
};

const normalizeStructuredDisplayContent = (content) => {
    if (!content || typeof content !== 'object' || Array.isArray(content) || !Array.isArray(content.articles)) {
        return content;
    }

    const clone = {
        ...content,
        preamble: String(content.preamble || '').trim(),
        articles: content.articles.map((a) => ({ ...a }))
    };

    const firstArticleOneIdx = clone.articles.findIndex((a) => parseArticleNumeric(a.articleNumber || a.article || '') === 1);
    if (firstArticleOneIdx > 0) {
        const prefix = clone.articles.slice(0, firstArticleOneIdx);
        const allLikelyNoise = prefix.every((a) => {
            const body = String(a.content || '').trim();
            if (!body) return true;
            if (body.length < 30) return true;
            return /(前文|契約書|規約|改訂|ver\.?|version)/i.test(body);
        });

        if (allLikelyNoise) {
            const mergedPrefixText = prefix
                .map((a) => String(a.content || '').trim())
                .filter(Boolean)
                .join('\n')
                .trim();
            if (mergedPrefixText) {
                clone.preamble = clone.preamble
                    ? `${clone.preamble}\n${mergedPrefixText}`.trim()
                    : mergedPrefixText;
            }
            clone.articles = clone.articles.slice(firstArticleOneIdx);
        }
    }

    return clone;
};

const escapeHtmlText = (value) => String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const isStructuredDocumentContent = (content) => {
    if (!content) return false;
    if (Array.isArray(content)) return true;
    return typeof content === 'object' && Array.isArray(content.articles);
};

const isWordDocumentFilename = (value) => /\.(docx?|dotx?)$/i.test(String(value || '').trim());
const isLocalDashboardMode = () => window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

const isEmbeddablePdfUrl = (value) => {
    const src = String(value || '').trim();
    if (!src) return false;
    if (src.startsWith('blob:')) return true;
    if (/^https?:\/\//i.test(src)) return true;
    if (src.startsWith('/uploads/')) return true;
    return false;
};

const resolvePdfPreviewUrl = (contract, runtimePdfUrl = null) => {
    const candidates = [contract?.pdf_url, runtimePdfUrl, contract?.pdf_storage_path];
    for (const candidate of candidates) {
        if (isEmbeddablePdfUrl(candidate)) return candidate;
    }
    return null;
};

const clauseIdentityKey = (clause) => `${clause?.title || ''}__${clause?.header || ''}`;

const clauseParagraphs = (clause) => Array.isArray(clause?.paragraphs)
    ? clause.paragraphs.map((p) => String(p ?? ''))
    : [];

const clauseBodyText = (clause) => Array.isArray(clause?.paragraphs)
    ? clause.paragraphs.map((p) => String(p || '')).join('\n').trim()
    : '';

const renderClauseParagraphs = (text) => {
    const lines = String(text || '').split(/\n+/).filter((line) => line.length > 0);
    if (lines.length === 0) {
        return '<p class="text-muted">本文なし</p>';
    }
    return lines.map((line) => `<p class="clause-p">${escapeHtmlText(line)}</p>`).join('');
};

const hasAnalysisRecord = (payload) => {
    if (!payload || typeof payload !== 'object') return false;
    return payload.aiSucceeded === true || payload.ai_succeeded === true || payload.isLimited === true || payload.ai_limited === true;
};

const sanitizeAnalysisPayload = (payload) => {
    if (!payload || typeof payload !== 'object') return {};
    return {
        ...payload,
        changes: Array.isArray(payload.changes) ? payload.changes.filter(Boolean) : []
    };
};

// hasMeaningfulAiSummary was removed

const mergeStructuredChangesWithAnalysis = (structuredChanges, analysisChanges) => {
    const baseChanges = Array.isArray(structuredChanges) ? structuredChanges.filter(Boolean) : [];
    const aiChanges = Array.isArray(analysisChanges) ? analysisChanges.filter(Boolean) : [];
    if (baseChanges.length === 0) return aiChanges;
    if (aiChanges.length === 0) return baseChanges;

    return baseChanges.map((base) => {
        const matched = aiChanges.find((candidate) => {
            const baseSection = String(base?.section || '').trim();
            const candidateSection = String(candidate?.section || '').trim();
            if (baseSection && candidateSection && baseSection === candidateSection) return true;
            const baseType = resolveDisplayChangeType(base);
            const candidateType = resolveDisplayChangeType(candidate);
            if (baseType !== candidateType) return false;
            return String(base?.old || '').trim() === String(candidate?.old || '').trim()
                || String(base?.new || '').trim() === String(candidate?.new || '').trim();
        });

        return matched
            ? {
                ...base,
                impact: matched.impact || base.impact || '',
                concern: matched.concern || base.concern || ''
            }
            : base;
    });
};

const isReusableAnalysisPayload = (payload) => {
    const normalized = sanitizeAnalysisPayload(payload);
    return hasAnalysisRecord(normalized) && normalized.isFallback !== true;
};

const buildStoredContractAnalysis = (contract) => {
    if (!contract) return null;
    const changes = Array.isArray(contract.ai_changes) ? contract.ai_changes.filter(Boolean) : [];
    const summary = String(contract.ai_summary || '').trim();
    const riskReason = String(contract.ai_risk_reason || '').trim();
    if (!summary && changes.length === 0) return null;
    return {
        summary: summary || 'AI解析が完了しました',
        riskLevel: contract.risk_level === 'High' ? 3 : (contract.risk_level === 'Medium' ? 2 : 1),
        riskReason: riskReason || 'リスク判定が完了しました',
        changes,
        isFallback: contract.ai_is_fallback === true
    };
};

const extractChangeDisplayKey = (change) => {
    const section = String(change?.section || '').trim();
    const explicitNumber = Number(change?.articleNumber || change?.oldArticleNumber || 0);
    if (explicitNumber > 0) return `article:${explicitNumber}`;
    const articleMatch = section.match(/^第\s*[0-9０-９一二三四五六七八九十百千〇零]+\s*条/);
    if (articleMatch) {
        return `section:${articleMatch[0].replace(/\s+/g, '')}`;
    }
    return section ? `section:${section}` : '';
};

const resolveDisplayChangeType = (change) => {
    const oldText = String(change?.old || '').trim();
    const newText = String(change?.new || '').trim();
    if (oldText && newText) return 'MODIFY';
    if (newText) return 'ADD';
    if (oldText) return 'DELETE';
    const rawType = String(change?.type || '').toUpperCase();
    return ['ADD', 'DELETE', 'MODIFY'].includes(rawType) ? rawType : 'MODIFY';
};

const normalizeChangesForDisplay = (changes) => {
    const items = Array.isArray(changes) ? changes.filter(Boolean) : [];
    const used = new Set();
    const normalized = [];

    for (let index = 0; index < items.length; index += 1) {
        if (used.has(index)) continue;
        const current = items[index];
        const currentType = resolveDisplayChangeType(current);
        const currentKey = extractChangeDisplayKey(current);

        if ((currentType === 'ADD' || currentType === 'DELETE') && currentKey) {
            const oppositeType = currentType === 'ADD' ? 'DELETE' : 'ADD';
            const matchIndex = items.findIndex((candidate, candidateIndex) => {
                if (candidateIndex <= index || used.has(candidateIndex)) return false;
                if (resolveDisplayChangeType(candidate) !== oppositeType) return false;
                return extractChangeDisplayKey(candidate) === currentKey;
            });

            if (matchIndex >= 0) {
                const matched = items[matchIndex];
                used.add(matchIndex);
                normalized.push({
                    ...current,
                    section: String(current.section || matched.section || '').trim(),
                    type: 'MODIFY',
                    old: currentType === 'DELETE' ? current.old : matched.old,
                    new: currentType === 'ADD' ? current.new : matched.new,
                    impact: current.impact || matched.impact || '',
                    concern: current.concern || matched.concern || ''
                });
                continue;
            }
        }

        normalized.push({
            ...current,
            type: currentType
        });
    }

    return normalized;
};

const isExplicitNoDiffAnalysis = (payload) => {
    const normalized = sanitizeAnalysisPayload(payload);
    const summary = String(normalized.summary || '').trim();
    const riskReason = String(normalized.riskReason || '').trim();
    const changes = Array.isArray(normalized.changes) ? normalized.changes.filter(Boolean) : [];
    if (changes.length > 0) return false;
    return /差分は検出されませんでした|変更点は検出されませんでした/.test(`${summary} ${riskReason}`);
};

const buildParagraphDiffOps = (previousParagraphs, currentParagraphs) => {
    const oldItems = Array.isArray(previousParagraphs) ? previousParagraphs.map((item) => String(item || '').trim()) : [];
    const newItems = Array.isArray(currentParagraphs) ? currentParagraphs.map((item) => String(item || '').trim()) : [];
    const m = oldItems.length;
    const n = newItems.length;
    const lcs = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

    for (let i = m - 1; i >= 0; i -= 1) {
        for (let j = n - 1; j >= 0; j -= 1) {
            if (oldItems[i] === newItems[j]) {
                lcs[i][j] = lcs[i + 1][j + 1] + 1;
            } else {
                lcs[i][j] = Math.max(lcs[i + 1][j], lcs[i][j + 1]);
            }
        }
    }

    const ops = [];
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
        if (oldItems[i] === newItems[j]) {
            ops.push({ type: 'equal', value: oldItems[i] });
            i += 1;
            j += 1;
        } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
            ops.push({ type: 'delete', value: oldItems[i] });
            i += 1;
        } else {
            ops.push({ type: 'add', value: newItems[j] });
            j += 1;
        }
    }

    while (i < m) {
        ops.push({ type: 'delete', value: oldItems[i] });
        i += 1;
    }
    while (j < n) {
        ops.push({ type: 'add', value: newItems[j] });
        j += 1;
    }

    return ops;
};

const buildClauseLevelChange = (section, previousClause, currentClause) => {
    if (!previousClause && !currentClause) return null;
    if (!previousClause && currentClause) {
        return {
            section,
            type: 'ADD',
            old: '',
            new: clauseBodyText(currentClause),
            impact: '',
            concern: ''
        };
    }
    if (previousClause && !currentClause) {
        return {
            section,
            type: 'DELETE',
            old: clauseBodyText(previousClause),
            new: '',
            impact: '',
            concern: ''
        };
    }

    const ops = buildParagraphDiffOps(clauseParagraphs(previousClause), clauseParagraphs(currentClause));
    const oldSegments = [];
    const newSegments = [];
    let pendingDeletes = [];
    let pendingAdds = [];

    const flushPending = () => {
        if (pendingDeletes.length === 0 && pendingAdds.length === 0) return;

        if (pendingDeletes.length > 0 && pendingAdds.length > 0) {
            oldSegments.push(pendingDeletes.join('\n'));
            newSegments.push(pendingAdds.join('\n'));
        } else if (pendingDeletes.length > 0) {
            oldSegments.push(pendingDeletes.join('\n'));
        } else if (pendingAdds.length > 0) {
            newSegments.push(pendingAdds.join('\n'));
        }

        pendingDeletes = [];
        pendingAdds = [];
    };

    ops.forEach((op) => {
        if (op.type === 'equal') {
            flushPending();
            return;
        }
        if (op.type === 'delete') {
            if (op.value) pendingDeletes.push(op.value);
            return;
        }
        if (op.type === 'add') {
            if (op.value) pendingAdds.push(op.value);
        }
    });
    flushPending();

    const oldText = oldSegments.filter(Boolean).join('\n\n').trim();
    const newText = newSegments.filter(Boolean).join('\n\n').trim();

    if (!oldText && !newText) {
        return null;
    }

    let type = 'MODIFY';
    if (!oldText && newText) type = 'ADD';
    else if (oldText && !newText) type = 'DELETE';

    return {
        section,
        type,
        old: oldText,
        new: newText,
        impact: '',
        concern: ''
    };
};

const buildStructuredFallbackAnalysis = (previousContent, currentContent) => {
    if (!isStructuredDocumentContent(previousContent) && !isStructuredDocumentContent(currentContent)) {
        return null;
    }

    const previousClauses = parseContractIntoClauses(previousContent);
    const currentClauses = parseContractIntoClauses(currentContent);
    if (previousClauses.length === 0 && currentClauses.length === 0) {
        return null;
    }

    const previousMap = new Map(previousClauses.map((clause) => [clauseIdentityKey(clause), clause]));
    const currentMap = new Map(currentClauses.map((clause) => [clauseIdentityKey(clause), clause]));
    const orderedKeys = [];

    currentClauses.forEach((clause) => {
        const key = clauseIdentityKey(clause);
        if (!orderedKeys.includes(key)) orderedKeys.push(key);
    });
    previousClauses.forEach((clause) => {
        const key = clauseIdentityKey(clause);
        if (!orderedKeys.includes(key)) orderedKeys.push(key);
    });

    const changes = orderedKeys.map((key) => {
        const previousClause = previousMap.get(key) || null;
        const currentClause = currentMap.get(key) || null;
        const section = composeClauseHeading(
            currentClause?.title || previousClause?.title || '条文',
            currentClause?.header || previousClause?.header || ''
        );
        return buildClauseLevelChange(section, previousClause, currentClause);
    }).filter(Boolean);

    if (changes.length === 0) {
        return {
            summary: '差分は検出されませんでした',
            riskLevel: 1,
            riskReason: '差分は検出されませんでした',
            changes: [],
            isFallback: true
        };
    }

    const previewChanges = changes.slice(0, 3);
    const previewSections = previewChanges.map((item) => item.section).filter(Boolean);
    const hasDelete = changes.some((item) => item.type === 'DELETE');
    const hasAdd = changes.some((item) => item.type === 'ADD');
    const hasModify = changes.some((item) => item.type === 'MODIFY');
    const modifyCount = changes.filter((item) => item.type === 'MODIFY').length;
    const addCount = changes.filter((item) => item.type === 'ADD').length;
    const deleteCount = changes.filter((item) => item.type === 'DELETE').length;
    let riskReason = '条文差分を検出しました';
    if (hasDelete && (hasAdd || hasModify)) {
        riskReason = '追加・削除・変更を検出しました';
    } else if (hasDelete) {
        riskReason = '削除を検出しました';
    } else if (hasAdd && hasModify) {
        riskReason = '追加・変更を検出しました';
    } else if (hasAdd) {
        riskReason = '追加を検出しました';
    } else if (hasModify) {
        riskReason = '変更を検出しました';
    }

    const previewText = previewChanges.map((item) => {
        const typeLabel = item.type === 'ADD' ? '追加' : (item.type === 'DELETE' ? '削除' : '変更');
        return `${item.section}で${typeLabel}`;
    }).join('、');
    const suffix = changes.length > previewChanges.length
        ? `。ほか${changes.length - previewChanges.length}条文でも変更があります。`
        : '。';
    let summary = `${previewText}${suffix}`;
    if (!previewText) {
        const summaryParts = [];
        if (modifyCount > 0) summaryParts.push(`変更 ${modifyCount}件`);
        if (addCount > 0) summaryParts.push(`追加 ${addCount}件`);
        if (deleteCount > 0) summaryParts.push(`削除 ${deleteCount}件`);
        summary = summaryParts.length > 0
            ? `${summaryParts.join('、')}を確認しました。`
            : '変更点を確認してください。';
    }

    return {
        summary: summary.trim(),
        riskLevel: hasDelete ? 2 : 1,
        riskReason,
        changes,
        isFallback: true
    };
};

const isCurrentVsLatestHistoryPair = (documentOptions, sourceDoc, targetDoc) => {
    if (!Array.isArray(documentOptions) || !sourceDoc || !targetDoc?.is_current) return false;
    const historicalDocs = documentOptions.filter((doc) => !doc.is_current);
    if (historicalDocs.length === 0) return false;
    const latestHistoricalDoc = historicalDocs.reduce((latest, doc) => {
        if (!latest) return doc;
        return (Number(doc.sort_order || 0) > Number(latest.sort_order || 0)) ? doc : latest;
    }, null);
    return Boolean(latestHistoricalDoc && latestHistoricalDoc.id === sourceDoc.id);
};

const contentToComparableText = (content) => {
    if (content === null || content === undefined) return '';
    if (typeof content === 'string') return content.trim();
    if (typeof content === 'number' || typeof content === 'boolean') return String(content);

    if (Array.isArray(content)) {
        return content.map((item, idx) => {
            if (typeof item === 'string') return item;
            if (!item || typeof item !== 'object') return String(item || '');
            const article = String(item.article || item.articleNumber || `第${idx + 1}条`).trim();
            const title = String(item.title || '').trim();
            const header = title ? `${article} ${title}`.trim() : article;
            const paragraphs = Array.isArray(item.paragraphs)
                ? item.paragraphs.map((p) => {
                    if (typeof p === 'string') return p;
                    if (p && typeof p === 'object') return String(p.content || p.body || '');
                    return '';
                }).filter(Boolean).join('\n')
                : String(item.body || item.content || '');
            return `${header}\n${paragraphs}`.trim();
        }).filter(Boolean).join('\n\n').trim();
    }

    if (typeof content === 'object' && Array.isArray(content.articles)) {
        const preamble = String(content.preamble || '').trim();
        const articleText = contentToComparableText(content.articles);
        return [preamble, articleText].filter(Boolean).join('\n\n').trim();
    }

    try {
        return JSON.stringify(content);
    } catch {
        return String(content);
    }
};

const resolveExtractedContentPayload = (data) => {
    if (!data || typeof data !== 'object') return null;
    const candidates = [
        data.structuredContract,
        data.extractedText,
        data.structured_contract,
        data.extracted_text,
        data.contractText,
        data.text
    ];
    for (const candidate of candidates) {
        if (candidate === null || candidate === undefined) continue;
        if (typeof candidate === 'string' && candidate.trim().length === 0) continue;
        return candidate;
    }
    return null;
};

const normalizeDiffContractId = (value) => {
    if (value && typeof value === 'object') {
        return normalizeDiffContractId(value.id ?? value.contractId ?? value.contract_id ?? null);
    }
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? num : null;
};

const renderStructuredDiffParagraphColumn = (paragraphs, counterpartParagraphs, tone) => {
    const own = Array.isArray(paragraphs) ? paragraphs : [];
    const other = Array.isArray(counterpartParagraphs) ? counterpartParagraphs : [];
    const maxLength = Math.max(own.length, other.length, 1);
    const html = [];

    for (let i = 0; i < maxLength; i += 1) {
        const current = String(own[i] ?? '');
        const counterpart = String(other[i] ?? '');

        if (!current && !counterpart) {
            continue;
        }

        const paragraphClasses = ['clause-p', 'structured-diff-paragraph'];
        let paragraphHtml = escapeHtmlText(current);

        if (!current && counterpart) {
            paragraphClasses.push('structured-diff-empty');
            paragraphHtml = '';
        } else if (current && !counterpart) {
            paragraphClasses.push(tone === 'old' ? 'structured-diff-removed' : 'structured-diff-added');
            paragraphHtml = escapeHtmlText(current);
        } else if (current === counterpart) {
            paragraphHtml = escapeHtmlText(current);
        } else if (window.Diff && typeof window.Diff.diffWordsWithSpace === 'function') {
            const oldText = tone === 'old' ? current : counterpart;
            const newText = tone === 'old' ? counterpart : current;
            const chunks = window.Diff.diffWordsWithSpace(oldText, newText);
            const fragmentHtml = [];
            for (const chunk of chunks) {
                const safe = escapeHtmlText(chunk.value);
                if (chunk.added) {
                    if (tone === 'new') {
                        fragmentHtml.push(`<ins>${safe}</ins>`);
                    }
                } else if (chunk.removed) {
                    if (tone === 'old') {
                        fragmentHtml.push(`<del>${safe}</del>`);
                    }
                } else {
                    fragmentHtml.push(safe);
                }
            }
            paragraphHtml = fragmentHtml.join('') || escapeHtmlText(current);
            paragraphClasses.push(tone === 'old' ? 'structured-diff-removed' : 'structured-diff-added');
        } else {
            paragraphClasses.push(tone === 'old' ? 'structured-diff-removed' : 'structured-diff-added');
            paragraphHtml = escapeHtmlText(current);
        }

        html.push(`<p class="${paragraphClasses.join(' ')}">${paragraphHtml || '　'}</p>`);
    }

    return html.join('') || '<p class="clause-p text-muted">本文なし</p>';
};

const renderStructuredDiffView = (previousContent, currentContent, options = {}) => {
    const {
        idPrefix = 'structured-diff'
    } = options;
    const previousClauses = parseContractIntoClauses(previousContent);
    const currentClauses = parseContractIntoClauses(currentContent);

    if (previousClauses.length === 0 && currentClauses.length === 0) {
        return '<div class="text-center text-muted" style="padding:40px;">比較できる条文データがありません</div>';
    }

    const previousMap = new Map(previousClauses.map((clause) => [clauseIdentityKey(clause), clause]));
    const currentMap = new Map(currentClauses.map((clause) => [clauseIdentityKey(clause), clause]));
    const orderedKeys = [];

    currentClauses.forEach((clause) => {
        const key = clauseIdentityKey(clause);
        if (!orderedKeys.includes(key)) orderedKeys.push(key);
    });
    previousClauses.forEach((clause) => {
        const key = clauseIdentityKey(clause);
        if (!orderedKeys.includes(key)) orderedKeys.push(key);
    });

    const renderClauseCard = (key, currentClause, previousClause, index) => {
        const title = currentClause?.title || previousClause?.title || '条文';
        const header = currentClause?.header || previousClause?.header || '';
        const previousParagraphs = clauseParagraphs(previousClause);
        const currentParagraphs = clauseParagraphs(currentClause);
        const previousHtml = renderStructuredDiffParagraphColumn(previousParagraphs, currentParagraphs, 'old');
        const currentHtml = renderStructuredDiffParagraphColumn(currentParagraphs, previousParagraphs, 'new');
        const fullClauseTitle = composeClauseHeading(title, header);
        const clauseId = `${idPrefix}-clause-${index}`;

        return `
            <details class="clause-card diff-card structured-diff-card" id="${clauseId}" open>
                <summary class="clause-header diff-header">
                    <span class="clause-num">${escapeHtmlText(fullClauseTitle)}</span>
                    <span class="clause-toggle-icon"><i class="fa-solid fa-chevron-down"></i></span>
                </summary>
                <div class="diff-compare structured-diff-grid">
                    <div class="diff-old structured-diff-pane">
                        <div class="version-label">変更前</div>
                        <div class="diff-text structured-diff-text">${previousHtml}</div>
                    </div>
                    <div class="diff-new structured-diff-pane">
                        <div class="version-label">変更後</div>
                        <div class="diff-text structured-diff-text">${currentHtml}</div>
                    </div>
                </div>
            </details>
        `;
    };

    const cards = orderedKeys.map((key, index) => {
        const previousClause = previousMap.get(key) || null;
        const currentClause = currentMap.get(key) || null;
        return renderClauseCard(key, currentClause, previousClause, index);
    }).join('');

    const navHtml = `
        <div class="clause-nav">
            <div class="clause-nav-title">条文目次</div>
            <ul class="clause-nav-list">
                ${orderedKeys.map((key, index) => {
        const previousClause = previousMap.get(key) || null;
        const currentClause = currentMap.get(key) || null;
        const title = currentClause?.title || previousClause?.title || '条文';
        const header = currentClause?.header || previousClause?.header || '';
        const fullClauseTitle = composeClauseHeading(title, header);
        const clauseId = `${idPrefix}-clause-${index}`;
        return `
                        <li class="clause-nav-item" data-clause-id="${clauseId}" onclick="window.app?.scrollToClause('${clauseId}')" title="${escapeHtmlText(fullClauseTitle)}">
                            <span class="nav-clause-num">${escapeHtmlText(fullClauseTitle)}</span>
                        </li>
                    `;
    }).join('')}
            </ul>
        </div>
    `;

        return `
            <div class="contract-structured-container structured-diff-shell">
                <button class="mobile-clause-nav-fab mobile-only" type="button" onclick="window.app?.toggleMobileClauseNav(this)" aria-label="条文目次">
                    <i class="fa-solid fa-list-ul"></i>
                    <span>条文</span>
                </button>
                ${navHtml}
                <div class="clause-cards-container structured-diff-stack">
                    ${cards}
                <div style="height: 40px; flex-shrink: 0;"></div>
            </div>
        </div>
    `;
};

// --- Static Content ---

// --- View Renderers Helpers ---

/**
 * 契約書を条文単位（第n条）で分割する
 */
const parseContractIntoClauses = (content) => {
    if (!content) return [];

    const applyHeadingPromotion = (title, header, paragraphs) => {
        let nextHeader = String(header || '').trim();
        let nextParagraphs = Array.isArray(paragraphs) ? [...paragraphs] : [];
        if (!nextHeader && title !== '前文' && nextParagraphs.length > 0) {
            const firstRaw = String(nextParagraphs[0] || '').trim();
            const bracketed = firstRaw.match(/^([（(【][^）)】]{1,20}[）)】])\s*(.*)$/);
            if (bracketed && !String(bracketed[1]).includes('。')) {
                nextHeader = String(bracketed[1] || '').trim();
                const rest = String(bracketed[2] || '').trim();
                if (rest) {
                    nextParagraphs[0] = rest;
                } else {
                    nextParagraphs = nextParagraphs.slice(1);
                }
            } else {
                const looksLikeHeading = firstRaw.length > 0 && firstRaw.length <= 20 && !firstRaw.includes('。');
                if (looksLikeHeading) {
                    nextHeader = firstRaw;
                    nextParagraphs = nextParagraphs.slice(1);
                }
            }
        }
        return { header: nextHeader, paragraphs: nextParagraphs };
    };

    // structuredContract support: { title, version, preamble, articles[] }
    if (typeof content === 'object' && !Array.isArray(content) && Array.isArray(content.articles)) {
        const normalized = normalizeStructuredDisplayContent(content);
        const clauses = [];
        if (normalized.preamble) {
            clauses.push({
                title: '前文',
                header: normalized.title || '',
                paragraphs: String(normalized.preamble).replace(/([\uFF21-\uFF5A\uFF10-\uFF19])\n([\uFF21-\uFF5A\uFF10-\uFF19])/g, '$1$2').split(/\n+/).filter(Boolean)
            });
        }
        normalized.articles.forEach((item, idx) => {
            const promoted = applyHeadingPromotion(
                item.articleNumber || `第${idx + 1}条`,
                item.title || '',
                String(item.content || '').replace(/([\uFF21-\uFF5A\uFF10-\uFF19])\n([\uFF21-\uFF5A\uFF10-\uFF19])/g, '$1$2').split(/\n+/).filter(Boolean)
            );
            clauses.push({
                title: item.articleNumber || `第${idx + 1}条`,
                header: promoted.header,
                paragraphs: promoted.paragraphs
            });
        });
        return clauses;
    }

    // If content is already structured (Array from backend)
    if (Array.isArray(content)) {
        return content.map((item, idx) => {
            let title = item.article || (idx === 0 ? '前文' : `第${idx}条`);
            // 「前文/ヘッダー」などの冗長な表記を正規化
            if (title === '前文/ヘッダー') title = '前文';

            const promoted = applyHeadingPromotion(
                title,
                item.title || '',
                Array.isArray(item.paragraphs) ? item.paragraphs : (item.body ? item.body.split(/\n+/) : [])
            );
            let header = promoted.header;
            let paragraphs = promoted.paragraphs;
            // 「前文/ヘッダー」がタイトルと重複する場合は非表示にする
            if (idx === 0 && (header === '前文/ヘッダー' || header === '前文' || header === title)) {
                header = '';
            }
            return {
                title: title,
                header: header,
                paragraphs
            };
        });
    }

    // Fallback: parse from plain text
    const lines = content.split(/\r?\n/);
    const clauses = [];
    let currentClause = { title: '前文', header: '', body: [] };

    const clauseRegex = /^(?:第\s*[\d０-９]+\s*条|【\s*第\s*[\d０-９]+\s*条\s*】)/;

    lines.forEach(line => {
        const trimmedLine = line.trim();
        if (clauseRegex.test(trimmedLine)) {
            if (currentClause.body.length > 0 || currentClause.title !== '前文') {
                clauses.push({
                    title: currentClause.title,
                    header: currentClause.header,
                    paragraphs: currentClause.body
                });
            }
            // Split title into "Clause Number" and "Header" if possible
            const match = trimmedLine.match(/^(第\s*[\d０-９]+\s*条|【\s*第\s*[\d０-９]+\s*条\s*】)(.*)/);
            if (match) {
                const rawHeader = match[2].trim().replace(/^[\(（【]|[）\)】]$/g, '');
                const normalizedHeader = String(rawHeader || '');
                const isValidTitle = normalizedHeader.length > 0 && normalizedHeader.length <= 20 && !normalizedHeader.includes('。');
                currentClause = { title: match[1].replace(/[０-９]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xFEE0)), header: isValidTitle ? normalizedHeader : '', body: [] };
                if (!isValidTitle && normalizedHeader) {
                    currentClause.body.push(normalizedHeader);
                }
            } else {
                currentClause = { title: trimmedLine, header: '', body: [] };
            }
        } else {
            if (trimmedLine.length > 0) currentClause.body.push(trimmedLine);
        }
    });

    if (currentClause.body.length > 0 || currentClause.title !== '前文') {
        clauses.push({
            title: currentClause.title,
            header: currentClause.header,
            paragraphs: currentClause.body
        });
    }

    return clauses;
};

const composeClauseHeading = (title, header) => {
    const t = String(title || '').trim();
    const h = String(header || '').trim();
    if (!h) return t;
    if (/^[（(【]/.test(h)) return `${t}${h}`;
    return `${t} ${h}`.trim();
};

const formatDisplayTimestamp = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        return raw.replace(/-/g, '/');
    }
    const normalized = /^\d{4}-\d{2}-\d{2}T\d{2}$/.test(raw)
        ? `${raw}:00:00`
        : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw)
            ? `${raw}:00`
            : raw.replace(' ', 'T');
    const parsed = new Date(normalized);
    if (Number.isNaN(parsed.getTime())) return raw;
    return parsed.toLocaleString('ja-JP', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
};

const trimDocumentLabel = (value, fallback = '資料') => {
    const raw = String(value || '').trim();
    if (!raw) return fallback;
    return raw.length > 42 ? `${raw.slice(0, 42)}...` : raw;
};

const buildComparisonLabel = (name, timestamp, fallbackName = '資料') => {
    const label = trimDocumentLabel(name, fallbackName);
    const stamp = formatDisplayTimestamp(timestamp);
    return stamp ? `${label} / ${stamp}` : label;
};

const buildDocumentOptionLabel = (doc) => {
    if (!doc) return '';
    const primary = trimDocumentLabel(doc.document_name || '資料', 64);
    const stamp = formatDisplayTimestamp(doc.uploaded_at);
    return stamp ? `${primary} | ${stamp}` : primary;
};

const renderStructuredView = (content, idPrefix = 'clause') => {
    try {
        const clauses = parseContractIntoClauses(content);
        if (!clauses || clauses.length === 0) return '<div class="text-muted p-4">表示できる内容がありません</div>';

        const navHtml = `
            <div class="clause-nav">
                <div class="clause-nav-title">条文目次</div>
                <ul class="clause-nav-list">
                    ${clauses.map((c, i) => {
            const fullClauseTitle = composeClauseHeading(c.title, c.header);
            return `
                        <li class="clause-nav-item" data-clause-id="${idPrefix}-clause-${i}" onclick="window.app?.scrollToClause('${idPrefix}-clause-${i}')" title="${fullClauseTitle}">
                            <span class="nav-clause-num">${fullClauseTitle}</span>
                        </li>
                    `;
        }).join('')}
                </ul>
            </div>
        `;

        const cardsHtml = `
            <div class="clause-cards-container">
                ${clauses.map((c, i) => {
            const pTags = c.paragraphs && c.paragraphs.length > 0
                ? c.paragraphs.map(p => {
                    const text = typeof p === 'string' ? p : (p.body || p.content || JSON.stringify(p));
                    return `<p class="clause-p">${text.replace(/\n/g, '<br>')}</p>`;
                }).join('')
                : `<p class="text-muted">本文なし</p>`;

            const fullClauseTitle = composeClauseHeading(c.title, c.header);
            return `
                        <details class="clause-card" id="${idPrefix}-clause-${i}" open>
                            <summary class="clause-header">
                                <span class="clause-num">${fullClauseTitle}</span>
                                <span class="clause-toggle-icon"><i class="fa-solid fa-chevron-down"></i></span>
                            </summary>
                            <div class="clause-body">${pTags}</div>
                        </details>
                    `;
        }).join('')}
                <div style="height: 40px; flex-shrink: 0;"></div> <!-- Bottom spacer -->
            </div>
        `;

        return `
            <div class="contract-structured-container">
                <button class="mobile-clause-nav-fab mobile-only" type="button" onclick="window.app?.toggleMobileClauseNav(this)" aria-label="条文目次">
                    <i class="fa-solid fa-list-ul"></i>
                    <span>条文</span>
                </button>
                ${navHtml}
                ${cardsHtml}
            </div>
        `;
    } catch (e) {
        console.error('renderStructuredView Error:', e);
        return `<div class="alert alert-danger">表示中にエラーが発生しました: ${e.message}</div>`;
    }
};

const Views = {
    loading: (viewId = 'dashboard') => {
        const titleMap = {
            dashboard: 'ダッシュボードを読み込み中',
            contracts: '契約一覧を読み込み中',
            diff: '詳細を読み込み中',
            history: '履歴を読み込み中',
            team: 'チーム情報を読み込み中',
            plan: 'プラン情報を読み込み中'
        };
        return `
            <div class="page-title">${titleMap[viewId] || '読み込み中'}</div>
            <div class="shell-skeleton">
                <div class="skeleton-block" style="width:42%"></div>
                <div class="skeleton-block" style="width:66%"></div>
                <div style="display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:14px;">
                    <div class="skeleton-card"></div>
                    <div class="skeleton-card"></div>
                    <div class="skeleton-card"></div>
                </div>
                <div class="skeleton-row"></div>
                <div class="skeleton-row"></div>
                <div class="skeleton-row"></div>
            </div>
        `;
    },
    // 5. Plan Management (New)
    plan: () => {
        const sub = window.app ? window.app.subscription : null;
        const payment = window.app ? window.app.paymentStatus : null;
        if (!sub || !sub.plan) {
            return `
                <div class="page-title">プラン管理</div>
                <div class="plan-loading" style="text-align:center; padding:50px;">
                    <i class="fa-solid fa-spinner fa-spin" style="font-size:2rem; color:#c19b4a; margin-bottom:16px;"></i>
                    <p>利用状況を確認しています...</p>
                </div>
            `;
        }

        const currentBillingCycle = sub.billingCycle === 'annual' ? 'annual' : 'monthly';
        const requestedBillingCycle = window.app?.planViewBillingCycle === 'annual' ? 'annual' : currentBillingCycle;
        const annualKnownUnavailable = window.app?.hasAnnualBillingPlans === false;
        const selectedBillingCycle =
            (annualKnownUnavailable && requestedBillingCycle === 'annual' && currentBillingCycle !== 'annual')
                ? 'monthly'
                : requestedBillingCycle;

        const currentCycleLabel = currentBillingCycle === 'annual' ? '年額' : '月額';
        const selectedCycleLabel = selectedBillingCycle === 'annual' ? '年額' : '月額';
        const planAvailability = window.app?.paymentPlanAvailability || null;
        const formatYen = (value) => `¥${Number(value).toLocaleString('ja-JP')}`;

        const plans = [
            {
                id: 'free',
                name: 'Free',
                prices: { monthly: 0, annual: 0 },
                features: [
                    'Word / PDF / URL 登録：無制限',
                    'AI差分チェック：月3回まで',
                    '電子署名機能：月10回まで',
                    'AI要約・リスク判定（High / Medium / Low）',
                    '差分ハイライト表示',
                    'チーム管理・1人'
                ]
            },
            {
                id: 'starter',
                name: 'Starter',
                prices: { monthly: 1480, annual: 14800 },
                features: [
                    'Word / PDF / URL 登録：無制限',
                    'AI差分チェック：月50回まで',
                    '電子署名機能：月25回まで',
                    'AI要約・リスク判定',
                    '差分ハイライト、履歴管理',
                    '解析ログ・監査履歴の閲覧',
                    'チーム管理・1人'
                ]
            },
            {
                id: 'business',
                name: 'Business',
                prices: { monthly: 4980, annual: 49800 },
                features: [
                    'Word / PDF / URL 登録：無制限',
                    'AI差分チェック：月120回まで',
                    '電子署名機能：月100件まで',
                    'AI要約・リスク判定',
                    '法的影響・懸念点の詳細解説',
                    '差分ハイライト、分析ログ',
                    'チーム管理・3人',
                    'PDF エクスポート'
                ]
            },
            {
                id: 'pro',
                name: 'Pro',
                prices: { monthly: 9800, annual: 98000 },
                features: [
                    'Word / PDF / URL 登録：無制限',
                    'AI差分チェック：月400回まで',
                    '電子署名機能：無制限',
                    'AI要約・リスク判定',
                    '法的影響・懸念点の詳細解説',
                    '差分ハイライト表示、バージョン履歴管理',
                    '解析ログ・監査履歴の閲覧',
                    '定期URL監視・Slack／メール通知',
                    'チーム管理・10人',
                    'PDF エクスポート'
                ]
            }
        ];

        const hasPayment = payment && payment.hasPaymentMethod;

        const cards = plans.map((p) => {
            const isBusiness = p.id === 'business';
            const isCurrentPlan = sub.plan === p.id;
            const isCurrentSelection = isCurrentPlan && currentBillingCycle === selectedBillingCycle;
            const hideCurrentButtonInAnnual = selectedBillingCycle === 'annual' && isCurrentSelection;
            const isFree = p.id === 'free';
            const selectedPrice = p.prices[selectedBillingCycle] || p.prices.monthly;
            const selectedUnit = selectedBillingCycle === 'annual' ? ' / 年' : ' / 月';
            const annualMonthlyEquivalent = Math.round(p.prices.annual / 12);
            const annualRegularPrice = p.prices.monthly * 12;
            const canStartSelectedCycle = isFree || !planAvailability || Boolean(planAvailability[selectedBillingCycle]?.[p.id]);
            const ctaDisabled = isCurrentSelection || (!isFree && !canStartSelectedCycle);
            const ctaLabel = isCurrentSelection
                ? '現在利用中'
                : isFree
                    ? 'プランを変更する'
                    : canStartSelectedCycle
                        ? 'プランを変更する'
                        : `${selectedCycleLabel}は準備中`;
            const ctaAction = ctaDisabled
                ? 'disabled'
                : isFree
                    ? `onclick="window.app.startSubscriptionCheckout('free', 'monthly')"`
                    : `onclick="window.app.startSubscriptionCheckout('${p.id}', '${selectedBillingCycle}')"`;
            const ctaStyleClass = ctaDisabled
                ? ''
                : (isBusiness ? 'plan-cta-business' : 'plan-cta-outline');

            return `
                <article class="plan-card ${isCurrentPlan ? 'is-current' : ''} ${isBusiness ? 'is-business' : 'is-muted'}">
                    <div class="plan-card-header">
                        ${isBusiness ? `<span class="plan-recommend-chip">おすすめ</span>` : ''}
                        ${isCurrentPlan ? `<span class="plan-current-chip">現在の契約${isFree ? '' : `（${currentCycleLabel}）`}</span>` : ''}
                    </div>
                    <h3 class="plan-name">${p.name}</h3>
                    <div class="plan-pricing-block">
                        <div class="plan-price-line">
                            <span class="plan-price">${isFree ? '無料' : formatYen(selectedPrice)}</span>
                            ${isFree ? '' : `<span class="plan-price-unit">${selectedUnit}</span>`}
                        </div>
                        <div class="plan-meta-slot ${isFree ? 'is-free-spacer' : (selectedBillingCycle === 'annual' ? 'is-annual' : 'is-monthly')}">
                            ${isFree ? '<div class="plan-annual-meta" style="visibility:hidden; height:54px;">spacer</div>' : `
                                <div class="plan-annual-meta">
                                    <p class="plan-effective">月あたり <strong>${formatYen(annualMonthlyEquivalent)}</strong> で利用</p>
                                    <p class="plan-compare">通常価格 <span class="plan-regular">${formatYen(annualRegularPrice)}</span> → 年額合計 <span>${formatYen(p.prices.annual)}</span></p>
                                    <p class="plan-discount">2ヶ月分お得</p>
                                </div>
                                <div class="plan-price-meta">
                                    年額なら ${formatYen(p.prices.annual)} / 年（2ヶ月分お得）
                                </div>
                            `}
                        </div>
                    </div>
                    <ul class="plan-feature-list">
                        ${p.features.map((f) => `<li><i class="fa-solid fa-check"></i>${f}</li>`).join('')}
                    </ul>
                    ${hideCurrentButtonInAnnual
                    ? ''
                    : `
                    <button class="btn-dashboard plan-cta ${ctaStyleClass} ${isCurrentSelection ? 'is-current' : ''} ${!canStartSelectedCycle ? 'is-disabled' : ''}" ${ctaAction}>
                        ${ctaLabel}
                    </button>
                    `}
                </article>
            `;
        }).join('');

        let paymentSection = '';
        if (hasPayment) {
            const renewalText = (sub && sub.renewalDate)
                ? `<div style="margin-top:8px; font-size:13px; color:#555;">次回更新日: <strong>${new Date(sub.renewalDate).toLocaleDateString('ja-JP')}</strong></div>`
                : '';
            paymentSection = `
                <div class="plan-payment-card is-ok compact">
                    <div class="plan-payment-title ok">
                        <i class="fa-solid fa-circle-check"></i>
                        <strong>お支払い方法が登録されています</strong>
                    </div>
                    ${renewalText}
                </div>
            `;
        } else {
            paymentSection = `
                <div class="plan-inline-alert-badge">
                    <i class="fa-solid fa-triangle-exclamation"></i>
                    <span>お支払い方法が未登録です</span>
                </div>
            `;
        }

        const cancelSection = `
            <div class="plan-cancel-section" style="margin: 20px 0 40px 0; background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 20px; text-align: left; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
                <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 16px;">
                    <div>
                        <h3 style="font-size: 1rem; font-weight: 700; color: #111827; margin: 0 0 4px 0;">プランの解約（無料プランへの移行）</h3>
                        <p style="color: #6b7280; font-size: 0.85rem; margin: 0;">有料プランをご利用の場合は、こちらからいつでも解約手続きが可能です。</p>
                    </div>
                    <button onclick="window.app.showCancelModal()" class="btn-dashboard plan-cancel-btn" style="background:#fff; color:#dc2626; border:1px solid #dc2626; padding:8px 16px; font-weight:600; border-radius:8px; white-space:nowrap;">
                        <i class="fa-solid fa-xmark"></i> プランを解約する
                    </button>
                </div>
            </div>
        `;

        return `
            <div class="page-title">プラン管理</div>
            <div class="plan-billing-toolbar">
                <div class="plan-cycle-switch" role="group" aria-label="請求サイクル切替">
                    <button class="plan-cycle-btn ${selectedBillingCycle === 'monthly' ? 'active' : ''}" onclick="window.app.setPlanBillingCycle('monthly')">月額</button>
                    <button class="plan-cycle-btn ${selectedBillingCycle === 'annual' ? 'active' : ''}" onclick="window.app.setPlanBillingCycle('annual')" ${annualKnownUnavailable ? 'disabled' : ''}>年額（2ヶ月分お得）</button>
                </div>
                <p class="plan-cycle-note">${annualKnownUnavailable ? '年額プランは現在準備中です。' : ''}</p>
            </div>
            ${paymentSection}
            ${cancelSection}
            <div class="plan-grid">
                ${cards}
            </div>
        `;
    },
    // 1. Dashboard Overview is lazy-loaded from js/modules/dashboard.js.
    dashboard: null,

    // 2. Contract List is lazy-loaded from js/modules/contracts.js.
    contracts: null,

    // 3. Diff Details
    diff: (id) => {
        const contract = dbService.getContractById(id);
        const comparisonContext = window.app?.getHistoryComparisonContext(id) || null;
        const documentOptions = dbService.getDocumentsByContractId(id);
        const storedCompareState = window.app?.getDocumentCompareState(id) || null;
        const fallbackSourceDoc = documentOptions.length >= 2 ? documentOptions[documentOptions.length - 2] : null;
        const fallbackTargetDoc = documentOptions.length >= 1 ? documentOptions[documentOptions.length - 1] : null;
        const selectedSourceDoc = documentOptions.find((doc) => doc.id === storedCompareState?.docAId) || fallbackSourceDoc;
        const selectedTargetDoc = documentOptions.find((doc) => doc.id === storedCompareState?.docBId) || fallbackTargetDoc;
        const displaySourceDoc = selectedSourceDoc;
        const displayTargetDoc = selectedTargetDoc;
        const selectedDiffResult = selectedSourceDoc && selectedTargetDoc
            ? dbService.getDiffResult(selectedSourceDoc.id, selectedTargetDoc.id)
            : null;
        const selectedDiffPayload = hasAnalysisRecord(selectedDiffResult?.diff_data)
            ? selectedDiffResult.diff_data
            : null;
        const structuredFallbackAnalysis = selectedSourceDoc && selectedTargetDoc
            ? buildStructuredFallbackAnalysis(selectedSourceDoc.content, selectedTargetDoc.content)
            : null;
        const hasStructuredDifferences = Boolean(structuredFallbackAnalysis?.changes?.length);
        const latestCurrentPair = isCurrentVsLatestHistoryPair(documentOptions, selectedSourceDoc, selectedTargetDoc);
        const storedContractAnalysis = latestCurrentPair ? buildStoredContractAnalysis(contract) : null;
        const hasExplicitNoDiffResult = hasStructuredDifferences
            && Boolean(selectedDiffPayload)
            && isExplicitNoDiffAnalysis(selectedDiffPayload);
        const hasFallbackNoDiffResult = hasExplicitNoDiffResult
            && selectedDiffPayload?.isFallback === true;
        const shouldPreferStructuredFallback = Boolean(
            hasStructuredDifferences
            && selectedDiffPayload
            && (
                selectedDiffPayload.isFallback === true
                || selectedDiffPayload.aiFailed === true
                || (Array.isArray(selectedDiffPayload.changes) ? selectedDiffPayload.changes.filter(Boolean).length === 0 : true)
            )
        );
        const canUseStoredContractAnalysis = Boolean(
            latestCurrentPair
            && hasAnalysisRecord(storedContractAnalysis)
            && storedContractAnalysis?.isFallback !== true
        );
        const shouldPreferStoredContractAnalysis = Boolean(
            canUseStoredContractAnalysis
            && (
                !selectedDiffPayload
                || shouldPreferStructuredFallback
                || hasExplicitNoDiffResult
                || selectedDiffPayload?.isFallback === true
            )
        );
        const effectiveSelectedDiffData = shouldPreferStoredContractAnalysis
            ? storedContractAnalysis
            : ((!hasExplicitNoDiffResult && !shouldPreferStructuredFallback && selectedDiffPayload)
                ? selectedDiffPayload
                : null);
        const shouldShowStructuredFallbackPanel = Boolean(
            !comparisonContext
            && hasStructuredDifferences
            && (!effectiveSelectedDiffData || hasExplicitNoDiffResult || shouldPreferStructuredFallback)
        );
        const shouldForceAutoPairAnalysis = Boolean(
            selectedDiffPayload
            && (
                selectedDiffPayload.isFallback === true
                || selectedDiffPayload.aiFailed === true
                || hasExplicitNoDiffResult
            )
        );
        const shouldAutoPairAnalysis = Boolean(
            !comparisonContext
            && selectedSourceDoc
            && selectedTargetDoc
            && window.app?.can('operate_contract')
            && (
                !selectedDiffPayload
                || shouldForceAutoPairAnalysis
                || selectedDiffPayload?.riskReason === 'AI差分未保存'
            )
        );
        if (shouldAutoPairAnalysis) {
            window.app.scheduleAutoPairAnalysis(
                id,
                selectedSourceDoc.id,
                selectedTargetDoc.id,
                { force: shouldForceAutoPairAnalysis }
            );
        }
        const isAutoPairAnalysisPending = Boolean(
            selectedSourceDoc
            && selectedTargetDoc
            && window.app?.isPairAnalysisPending(id, selectedSourceDoc.id, selectedTargetDoc.id)
        );
        const shouldUseStructuredDisplayChanges = Boolean(
            !comparisonContext
            && selectedSourceDoc
            && selectedTargetDoc
            && hasStructuredDifferences
        );
        const requestedActiveTab = window.app ? window.app.activeDetailTab : 'diff';
        const runtimePdfUrl = window.app?.getRuntimePdfPreviewUrl(id) || null;
        const resolvedPdfPreviewUrl = resolvePdfPreviewUrl(contract, runtimePdfUrl);
        const sourceType = String(contract?.source_type || '').toUpperCase();
        const isPdfSource = sourceType === 'PDF' || (contract?.original_filename || '').toLowerCase().endsWith('.pdf');
        const hasPdfPreview = Boolean(resolvedPdfPreviewUrl);
        // Align with production expectation: keep "原本全文" as structured text view even for PDF.
        const showPdfViewerInRightPane = false;

        // AI解析結果があればそれを使用、なければ静的コンテンツまたはデフォルト
        const hasComparableVersion = documentOptions.length >= 2;
        const hasAIResults = !!contract.last_analyzed_at;
        // 単独ドキュメント（比較なし・AI未解析）はdiffタブを非表示にする（commit 2f88c39の修正を復元）
        const shouldHideDiffTab = !comparisonContext && !hasComparableVersion && !hasAIResults;
        const activeTab = shouldHideDiffTab ? 'original' : requestedActiveTab;
        const canTriggerPairAnalysis = Boolean(selectedSourceDoc && selectedTargetDoc && window.app?.can('operate_contract'));

        let diffData;
        if (effectiveSelectedDiffData) {
            const cached = effectiveSelectedDiffData?.isFallback === true
                ? {
                    summary: String(effectiveSelectedDiffData.summary || 'AI差分要約を取得できませんでした。再解析を実行してください。').trim() || 'AI差分要約を取得できませんでした。再解析を実行してください。',
                    riskLevel: effectiveSelectedDiffData.riskLevel ?? 1,
                    riskReason: String(effectiveSelectedDiffData.riskReason || 'AI差分要約未取得').trim() || 'AI差分要約未取得',
                    changes: Array.isArray(effectiveSelectedDiffData.changes) ? effectiveSelectedDiffData.changes.filter(Boolean) : [],
                    isFallback: true
                }
                : sanitizeAnalysisPayload(effectiveSelectedDiffData);
            diffData = {
                title: `${contract.name} - 文書比較`,
                summary: cached.summary || '選択した2文書の差分結果を表示しています。',
                riskLevel: cached.riskLevel ?? 1,
                riskReason: cached.riskReason || '保存済みの差分結果を表示しています。',
                changes: cached.changes || [],
                isFallback: cached.isFallback === true,
                aiSucceeded: cached.aiSucceeded ?? contract.ai_succeeded,
                isLimited: cached.isLimited ?? contract.ai_limited
            };
        } else if (shouldShowStructuredFallbackPanel && structuredFallbackAnalysis) {
            diffData = {
                title: `${contract.name} - 文書比較`,
                summary: structuredFallbackAnalysis.summary || '変更点を表示しています。',
                riskLevel: structuredFallbackAnalysis.riskLevel ?? 1,
                riskReason: structuredFallbackAnalysis.riskReason || '変更点を表示しています',
                changes: Array.isArray(structuredFallbackAnalysis.changes) ? structuredFallbackAnalysis.changes : [],
                isFallback: false
            };
        } else if (hasFallbackNoDiffResult) {
            diffData = {
                title: `${contract.name} - 文書比較`,
                summary: 'AI差分要約を取得できませんでした。再解析を実行してください。',
                riskLevel: 1,
                riskReason: 'AI差分要約未取得',
                changes: [],
                isFallback: true
            };
        } else if (selectedSourceDoc && selectedTargetDoc) {
            diffData = {
                title: `${contract.name} - 文書比較`,
                summary: 'この文書ペアのAI差分要約はまだ保存されていません。必要に応じてAI差分解析を実行してください。',
                riskLevel: 1,
                riskReason: 'AI差分未保存',
                changes: [],
                isFallback: false
            };
        } else if (comparisonContext?.analysis) {
            diffData = {
                title: `${contract.name} - 比較解析`,
                summary: comparisonContext.analysis.summary || '選択した履歴との差分比較を表示しています。',
                riskLevel: comparisonContext.analysis.riskLevel ?? 1,
                riskReason: comparisonContext.analysis.riskReason || '選択した履歴との差分を解析しました。',
                changes: comparisonContext.analysis.changes || [],
                isFallback: comparisonContext.analysis.isFallback === true
            };
        } else if (comparisonContext?.analysisNotice) {
            diffData = {
                title: `${contract.name} - 比較表示`,
                summary: comparisonContext.analysisNotice,
                riskLevel: 1,
                riskReason: '比較表示のみ',
                changes: [],
                isFallback: false
            };
        } else if (hasAIResults) {
            const normalizedStored = sanitizeAnalysisPayload({
                summary: contract.ai_summary || contract.summary || '',
                riskLevel: contract.risk_level === 'High' ? 3 : (contract.risk_level === 'Medium' ? 2 : 1),
                riskReason: contract.ai_risk_reason || contract.risk_reason || '',
                changes: contract.ai_changes || [],
                isFallback: contract.ai_is_fallback === true
            });
            // AI解析結果を使用
            diffData = {
                title: `${contract.name} - AI解析結果`,
                summary: normalizedStored.summary || 'AI解析が完了しました',
                riskLevel: normalizedStored.riskLevel ?? 1,
                riskReason: normalizedStored.riskReason || 'リスク判定が完了しました',
                changes: normalizedStored.changes || [],
                isFallback: normalizedStored.isFallback === true,
                aiSucceeded: contract.ai_succeeded === true,
                isLimited: contract.ai_limited === true
            };
        } else {
            // デフォルトデータ
            diffData = {
                title: `${contract.name} - 詳細分析`,
                summary: contract.status === '未解析'
                    ? 'このドキュメントはまだAI解析されていません。新規登録から解析を実行してください。'
                    : (!hasComparableVersion
                        ? '比較対象の旧バージョンがないため、差分要約は表示されません。'
                        : 'このドキュメントの最新の変更要約をAIが生成しています...'),
                riskLevel: contract.risk_level === 'High' ? 3 : (contract.risk_level === 'Medium' ? 2 : 1),
                riskReason: contract.status === '未解析'
                    ? 'AI解析が未実行です'
                    : (!hasComparableVersion
                        ? '旧バージョンが未登録のため差分判定は未実行です'
                        : '特定の変更箇所において、リスク要因が検知されました。詳細を確認してください。'),
                changes: [],
                isFallback: false
            };
        }

        // デバッグ情報（開発時のみ表示）
        const debugInfoHtml = '';

        const compareBannerHtml = activeTab === 'diff' ? `
            <div class="document-compare-toolbar">
                <div class="document-compare-grid">
                    <label class="document-compare-field">
                        <span class="document-compare-label">比較元</span>
                        <select class="document-compare-select" onchange="window.app.handleDocumentCompareChange(${id}, 'docA', this.value)">
                            <option value="">文書を選択</option>
                            ${documentOptions.map((doc) => `
                                <option value="${doc.id}" ${selectedSourceDoc?.id === doc.id ? 'selected' : ''}>${escapeHtmlText(buildDocumentOptionLabel(doc))}</option>
                            `).join('')}
                        </select>
                    </label>
                    <label class="document-compare-field">
                        <span class="document-compare-label">比較先</span>
                        <select class="document-compare-select" onchange="window.app.handleDocumentCompareChange(${id}, 'docB', this.value)">
                            <option value="">文書を選択</option>
                            ${documentOptions.map((doc) => `
                                <option value="${doc.id}" ${selectedTargetDoc?.id === doc.id ? 'selected' : ''}>${escapeHtmlText(buildDocumentOptionLabel(doc))}</option>
                            `).join('')}
                        </select>
                    </label>
                </div>
                <div class="document-compare-status">
                    ${selectedSourceDoc && selectedTargetDoc
                ? `比較中: <strong>${escapeHtmlText(trimDocumentLabel(selectedSourceDoc.document_name, '比較元資料'))}</strong> → <strong>${escapeHtmlText(trimDocumentLabel(selectedTargetDoc.document_name, '比較先資料'))}</strong>`
                : '比較元と比較先を選択してください'}
                </div>
            </div>
        ` : '';

        const displayChanges = normalizeChangesForDisplay(
            shouldUseStructuredDisplayChanges
                ? mergeStructuredChangesWithAnalysis(structuredFallbackAnalysis?.changes, diffData.changes)
                : diffData.changes
        );
        const changesHtml = (displayChanges.length > 0 ? displayChanges : []).map((c) => {
            const changeType = (() => {
                const t = String(c.type || '').toUpperCase();
                if (t === 'ADD') return '追加';
                if (t === 'DELETE') return '削除';
                return '変更';
            })();
            const oldText = escapeHtmlText(typeof c.old === 'string' ? c.old : JSON.stringify(c.old || ''));
            const newText = escapeHtmlText(typeof c.new === 'string' ? c.new : JSON.stringify(c.new || ''));
            return `
            <article class="mobile-change-card">
                <div class="mobile-change-card-header">
                    <span>${escapeHtmlText(c.section || '変更点')}</span>
                    <span>${changeType}</span>
                </div>
                <div class="diff-container mobile-diff-stack" style="height:auto; min-height:100px;">
                    <div class="diff-pane diff-left">
                        <div class="diff-pane-label">変更前</div>
                        <span class="diff-del">${oldText || '（該当なし）'}</span>
                    </div>
                    <div class="diff-pane diff-right">
                        <div class="diff-pane-label">変更後</div>
                        <span class="diff-add">${newText || '（該当なし）'}</span>
                    </div>
                </div>
                ${(c.impact || c.concern) ? `
                <div class="mobile-change-impact">
                    ${c.impact ? `<div><strong><i class="fa-solid fa-scale-balanced"></i> 法的影響:</strong> ${escapeHtmlText(c.impact)}</div>` : ''}
                    ${c.concern ? `<div><strong><i class="fa-solid fa-triangle-exclamation"></i> 懸念点:</strong> ${escapeHtmlText(c.concern)}</div>` : ''}
                </div>
                ` : ''}
            </article>
        `;
        }).join('');

        const mobileRiskTone = diffData.riskLevel >= 3 ? 'high' : (diffData.riskLevel >= 2 ? 'medium' : 'low');
        const mobileRiskLabel = diffData.riskLevel >= 3 ? 'High' : (diffData.riskLevel >= 2 ? 'Medium' : 'Low');
        const mobilePrimaryAction = (() => {
            if (!window.app.can('operate_contract')) return null;
            if (!hasAIResults) {
                return {
                    label: 'リスク解析する',
                    icon: 'fa-wand-magic-sparkles',
                    action: `window.app.confirmReanalyze('${contract.id}')`
                };
            }
            if (contract.status === '未確認') {
                return {
                    label: '確認済みにする',
                    icon: 'fa-check',
                    action: `window.app.confirmContract(${id})`
                };
            }
            return {
                label: '署名判断へ',
                icon: 'fa-file-signature',
                action: "window.app.navigate('sign')"
            };
        })();

        return `
            <div class="detail-split-container">
                <!-- Breadcrumb & Top Actions -->
                <div class="detail-split-header flex justify-between items-center">
                    <div class="detail-header-main">
                        <a onclick="window.app.navigate('contracts')" style="display:inline-flex; align-items:center; justify-content:center; width:36px; height:36px; border-radius:50%; background:#f8fafc; color:#5e544d; font-size:14px; cursor:pointer;" title="戻る">
                            <i class="fa-solid fa-chevron-left"></i>
                        </a>
                        <div class="detail-header-title-wrap">
                            <h2 style="font-size:18px; font-weight:700; color:var(--text-main); margin:0;">${diffData.title}</h2>
                            <div class="detail-header-meta" style="font-size:12px; color:#666; margin-top:4px;">
                                ${contract.source_url ? `<span class="detail-header-meta-item"><i class="fa-solid fa-link"></i> Source: <a href="${contract.source_url}" target="_blank" style="color:#2196F3; text-decoration:underline;">${contract.source_url}</a></span>` : ''}
                                ${contract.original_filename ? `<span class="detail-header-meta-item"><i class="fa-solid fa-file-lines"></i> Original File: ${contract.original_filename}</span>` : ''}
                            </div>
                        </div>
                    </div>
                    <div class="flex gap-sm">
                        ${window.app.can('operate_contract') ? `<button class="btn-dashboard" onclick="window.app.shareReport(${contract.id})"><i class="fa-solid fa-share-nodes"></i> 共有</button>` : ''}
                        ${(['pro', 'business'].includes(window.app.subscription?.plan)) ? `<button class="btn-dashboard" onclick="window.app.exportPDF(${contract.id})"><i class="fa-solid fa-file-pdf"></i> PDF出力</button>` : ''}
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

                ${contract.ai_limited ? `
                <section class="mobile-risk-sticky mobile-only" style="background:#fffcf5; border-top:1px solid #e8d9b8;" aria-label="アップグレード案内">
                    <div style="display:flex; align-items:center; gap:10px;">
                        <i class="fa-solid fa-crown" style="color:#c5a059;"></i>
                        <span style="font-size:12px; color:#2b2623; font-weight:700;">AI詳細解析はアップグレードが必要です</span>
                        <a onclick="window.app.navigate('plan')" style="margin-left:auto; font-size:11px; color:#c5a059; font-weight:700; text-decoration:underline;">詳細</a>
                    </div>
                </section>
                ` : (contract.ai_succeeded ? `
                <section class="mobile-risk-sticky mobile-risk-${mobileRiskTone} mobile-only" aria-label="リスク判定">
                    <div class="mobile-risk-row">
                        <span class="mobile-risk-pill">${mobileRiskLabel}</span>
                        <span class="mobile-risk-reason">${escapeHtmlText(diffData.riskReason || 'リスク判定を確認してください')}</span>
                    </div>
                    <div class="mobile-risk-summary-label">AI要約</div>
                    <div class="mobile-risk-summary">${escapeHtmlText(diffData.summary || 'AI要約はまだありません。')}</div>
                </section>
                ` : (contract.last_analyzed_at ? `
                <section class="mobile-risk-sticky mobile-only" style="background:#fff2f2; border-top:1px solid #fecaca; padding:12px;" aria-label="解析失敗">
                    <div style="display:flex; align-items:center; gap:10px; color:#991b1b; font-size:12px;">
                        <i class="fa-solid fa-triangle-exclamation"></i>
                        <span>AI解析に失敗しました。再解析を試してください。</span>
                    </div>
                </section>
                ` : ''))}

                <div class="detail-split-body">
                    <!-- Left Pane: Analysis & Diffs -->
                    <div class="pane">
                        <div class="pane-header" style="min-height:56px; box-sizing:border-box;">
                            <span><i class="fa-solid fa-magnifying-glass-chart"></i> AI解析・差分判定</span>
                            ${mobilePrimaryAction ? `<button class="btn-dashboard btn-primary-action mobile-only" onclick="${mobilePrimaryAction.action}" style="padding:6px 12px; font-size:12px; margin-left:auto;"><i class="fa-solid ${mobilePrimaryAction.icon}"></i> ${mobilePrimaryAction.label}</button>` : ''}
                            <button id="btn-reanalyze" class="btn-upload-version desktop-only" onclick="window.app.confirmReanalyze('${contract.id}')" style="margin-left: ${mobilePrimaryAction ? '8px' : 'auto'}">
                                <i class="fa-solid fa-wand-magic-sparkles"></i>リスク解析
                            </button>
                        </div>
                        <div class="pane-scroll-area">
                            <!-- Desktop Analysis visibility -->
                            <div class="desktop-only">
                                ${contract.ai_limited ? `
                                <div style="background: linear-gradient(135deg, #fffcf5 0%, #fff8e6 100%); border: 1px solid #e8d9b8; border-radius: 12px; padding: 24px; text-align: center; margin-bottom: 24px; box-shadow: 0 4px 12px rgba(197, 160, 89, 0.08);">
                                    <i class="fa-solid fa-crown" style="color: #c5a059; font-size: 2rem; margin-bottom: 12px; display: block;"></i>
                                    <h3 style="color: #2b2623; margin: 0 0 8px; font-size: 16px;">AI詳細解析（制限中）</h3>
                                    <p style="color: #8a7a6a; font-size: 13px; line-height: 1.6; margin-bottom: 16px;">
                                        現在のプランではAIによる詳細な条文要約が制限されています。<br>
                                        スタータープラン以上へのアップグレードで、全解析機能をご利用いただけます。
                                    </p>
                                    <button onclick="window.app.navigate('plan')" class="btn-dashboard btn-primary-action" style="padding: 10px 24px; background: #c5a059; border: none; border-radius: 8px; color: #fff; font-weight: 700; cursor: pointer;">
                                        アップグレードを検討する
                                    </button>
                                </div>
                                ` : (contract.ai_succeeded ? `
                                <div class="analysis-section-title">
                                    <span><i class="fa-solid fa-robot text-primary"></i> AIリスク要約</span>
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
                                ` : (hasAIResults ? `
                                <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 16px; margin-bottom: 24px; color: #991b1b; font-size: 13px;">
                                    <i class="fa-solid fa-triangle-exclamation" style="margin-right: 8px;"></i>
                                    AI解析結果を読み込めませんでした。再解析を試行してください。
                                </div>
                                ` : ''))}
                            </div>

                            ${(hasComparableVersion || hasAIResults) ? `

                            ${(contract.expiry_date || contract.renewal_deadline || contract.contract_category) ? (() => {
                                const fmtDate = (d) => {
                                    if (!d) return null;
                                    const dt = new Date(d);
                                    if (isNaN(dt.getTime())) return d;
                                    return dt.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' });
                                };
                                const daysUntil = (d) => {
                                    if (!d) return null;
                                    const dt = new Date(d); if (isNaN(dt.getTime())) return null;
                                    const today = new Date(); today.setHours(0,0,0,0); dt.setHours(0,0,0,0);
                                    return Math.round((dt - today) / 86400000);
                                };
                                const expiryDays = daysUntil(contract.expiry_date);
                                const renewalDays = daysUntil(contract.renewal_deadline);
                                const urgentDays = renewalDays !== null ? renewalDays : expiryDays;
                                const alertColor = urgentDays !== null && urgentDays <= 7 ? '#e53935' : urgentDays !== null && urgentDays <= 30 ? '#f57c00' : '#2e7d32';
                                const confBadge = contract.date_confidence === 'high'
                                    ? '<span style="font-size:10px;background:#e8f5e9;color:#2e7d32;border-radius:4px;padding:2px 6px;margin-left:6px;">AI自動抽出</span>'
                                    : contract.date_confidence === 'partial'
                                    ? '<span style="font-size:10px;background:#fff8e1;color:#f57c00;border-radius:4px;padding:2px 6px;margin-left:6px;">一部手動確認推奨</span>'
                                    : '';
                                const dayLabel = (days) => days === null ? '' : days === 0 ? '本日' : days < 0 ? '期限切れ' : `あと${days}日`;
                                return `<div style="background:#f0f7ff;border:1px solid #bbdefb;border-radius:12px;padding:16px 20px;margin-bottom:20px;">
                                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap;">
                                        <i class="fa-solid fa-calendar-check" style="color:#1976d2;"></i>
                                        <span style="font-size:14px;font-weight:700;color:#1976d2;">AIが検出した期限情報</span>
                                        ${confBadge}
                                        ${contract.contract_category ? `<span style="font-size:11px;background:#e3f2fd;color:#1976d2;border-radius:4px;padding:2px 7px;margin-left:auto;">${escapeHtmlText(contract.contract_category)}</span>` : ''}
                                    </div>
                                    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:10px;">
                                        ${contract.contract_start ? `<div style="background:#fff;border-radius:8px;padding:10px 14px;border:1px solid #e3f2fd;"><div style="font-size:11px;color:#8a7a6a;margin-bottom:2px;">契約開始日</div><div style="font-size:13px;font-weight:600;">${fmtDate(contract.contract_start)}</div></div>` : ''}
                                        ${contract.expiry_date ? `<div style="background:#fff;border-radius:8px;padding:10px 14px;border:1px solid #e3f2fd;"><div style="font-size:11px;color:#8a7a6a;margin-bottom:2px;">契約終了日</div><div style="font-size:13px;font-weight:600;">${fmtDate(contract.expiry_date)}</div>${expiryDays !== null ? `<div style="font-size:11px;color:${expiryDays <= 30 ? alertColor : '#666'};margin-top:2px;">${dayLabel(expiryDays)}</div>` : ''}</div>` : ''}
                                        ${contract.renewal_deadline ? `<div style="background:#fff;border-radius:8px;padding:10px 14px;border:1px solid #ffe0b2;"><div style="font-size:11px;color:#8a7a6a;margin-bottom:2px;">更新拒絶期限</div><div style="font-size:13px;font-weight:600;">${fmtDate(contract.renewal_deadline)}</div>${renewalDays !== null ? `<div style="font-size:11px;color:${renewalDays <= 30 ? alertColor : '#666'};margin-top:2px;">${dayLabel(renewalDays)}</div>` : ''}</div>` : ''}
                                        ${contract.auto_renewal !== undefined ? `<div style="background:#fff;border-radius:8px;padding:10px 14px;border:1px solid #e3f2fd;"><div style="font-size:11px;color:#8a7a6a;margin-bottom:2px;">自動更新</div><div style="font-size:13px;font-weight:600;color:${contract.auto_renewal ? '#e53935' : '#2e7d32'}">${contract.auto_renewal ? 'あり（要注意）' : 'なし'}</div></div>` : ''}
                                    </div>
                                    <div style="margin-top:10px;text-align:right;">
                                        <a onclick="window.app.navigate('deadlines')" style="font-size:12px;color:#1976d2;cursor:pointer;"><i class="fa-solid fa-arrow-right" style="margin-right:4px;"></i>期限一覧を見る</a>
                                    </div>
                                </div>`;
                            })() : ''}

                            ` : `
                            <div style="padding:40px 20px; text-align:center; color:#999;">
                                <i class="fa-solid fa-file-invoice" style="font-size:32px; margin-bottom:16px; display:block; opacity:0.1;"></i>
                                <div style="font-size:14px; color:#666;">ドキュメントを読み込みました</div>
                                <div style="font-size:12px; margin-top:8px; line-height:1.6; color:#999;">
                                    右上の「リスク解析」ボタンをクリックすると、AIがリスクを判定します。<br>
                                    新しいバージョンをアップロードすれば、差分を自動解析します。
                                </div>
                            </div>
                            `}
                        </div>
                        
                        ${contract.source_type === 'URL' ? `
                        <div style="margin-top: 24px; padding: 20px; border-top: 1px solid #eee;">
                            ${window.app.subscription?.plan === 'pro' ? `
                            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                                <div style="display:flex; align-items:center; gap:10px;">
                                    <i class="fa-solid fa-satellite-dish" style="color:var(--accent-gold, #c19b4a); font-size:16px;"></i>
                                    <span style="font-weight:600; font-size:14px;">定期監視</span>
                                </div>
                                <label class="toggle-switch">
                                    <input type="checkbox" ${contract.monitoring_enabled ? 'checked' : ''} onchange="window.app.toggleMonitoring(${id}, this.checked)">
                                    <span class="toggle-slider"></span>
                                </label>
                            </div>
                            <p style="font-size:12px; color:#888; margin:0 0 16px; line-height:1.5;">
                                URLの変更を自動チェックし、差分がある場合のみAI解析を実行します。
                            </p>
                            <div style="background:#f8f9fa; border-radius:8px; padding:14px; font-size:13px; margin-bottom:14px;">
                                <div style="display:flex; justify-content:space-between; margin-bottom:8px; color:#555;">
                                    <span>最終チェック</span>
                                    <span style="font-weight:500;">${contract.last_checked_at ? new Date(contract.last_checked_at).toLocaleString('ja-JP') : '—'}</span>
                                </div>
                                <div style="display:flex; justify-content:space-between; color:#555;">
                                    <span>監視頻度</span>
                                    <span style="font-weight:500;">${contract.stable_count >= 14 ? '3日に1回（安定）' : (contract.stable_count >= 7 ? '2日に1回' : '毎日')}</span>
                                </div>
                            </div>
                            <button class="btn-crawl-check" onclick="window.app.manualCrawl(${id})">
                                <i class="fa-solid fa-arrows-rotate"></i> 今すぐ更新を確認
                            </button>
                            <p style="font-size:11px; color:#aaa; margin:8px 0 0; text-align:center;">※ 変更検出時にAI解析回数を1回消費します</p>
                            ` : `
                            <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
                                <i class="fa-solid fa-satellite-dish" style="color:#ccc; font-size:16px;"></i>
                                <span style="font-weight:600; font-size:14px; color:#999;">定期監視・Slack／メール通知</span>
                                <span style="background:#f3f0ea; color:#c5a059; border:1px solid #e8d9b8; border-radius:10px; padding:2px 10px; font-size:11px; font-weight:700;">Pro限定</span>
                            </div>
                            <p style="font-size:12px; color:#aaa; margin:0 0 16px; line-height:1.5;">
                                URLの変更を自動チェックし、差分をSlack・メールで通知します。
                            </p>
                            <button class="btn-dashboard" style="width:100%; background:#c5a059; color:#fff; border:none; border-radius:8px; padding:10px; font-size:13px; font-weight:600; cursor:pointer;" onclick="window.app.showProFeatureModal('定期URL監視・Slack／メール通知はProプラン限定の機能です。')">
                                <i class="fa-solid fa-lock" style="margin-right:6px;"></i> Proプランで使う
                            </button>
                            `}
                        </div>
                        ` : ''}
                    </div>

                    <!-- Right Pane: Original Document -->
                    <div class="pane">
                        <div class="pane-header" style="display:flex; justify-content:space-between; align-items:center; min-height:56px; box-sizing:border-box;">
                            <div style="display:flex; align-items:center; gap:8px; min-width:0;">
                                <span><i class="fa-solid fa-file-contract"></i> ドキュメント表示</span>
                                ${contract.original_filename ? `<span class="doc-source-name" title="${contract.original_filename}"><i class="fa-solid fa-file-lines"></i> ${contract.original_filename}</span>` : ''}
                            </div>
                            
                            ${window.app.can('operate_contract') ? `
                            <button class="btn-upload-version" onclick="window.app.uploadNewVersion(${id})">
                                <i class="fa-solid fa-cloud-arrow-up"></i> 新しいバージョンをアップロード
                            </button>` : ''}
                        </div>
                        <div class="tabs-row">
                            ${!shouldHideDiffTab ? `<button class="tab-item ${activeTab === 'diff' ? 'active' : ''}" onclick="window.app.setDetailTab('diff')">差分表示</button>` : ''}
                            <button class="tab-item ${activeTab === 'original' ? 'active' : ''}" onclick="window.app.setDetailTab('original')">原本全文</button>
                        </div>
                        <div class="pane-scroll-area ${showPdfViewerInRightPane ? '' : 'document-pane-bg is-frameless'}" style="padding:0; flex:1; display:flex; flex-direction:column; overflow-y:auto;">
                                ${showPdfViewerInRightPane
                ? `<div style="width:100%; height:100%; display:flex; flex-direction:column;">
                        <iframe src="${resolvedPdfPreviewUrl}" style="width:100%; flex:1; border:none; background:#525659; min-height:600px;"></iframe>
                        <div style="padding:10px; text-align:center; background:#f9f9f9; border-top:1px solid #ddd; font-size:12px;">
                            <a href="${resolvedPdfPreviewUrl}" target="_blank" class="text-primary"><i class="fa-solid fa-external-link-alt"></i> PDFを別ウィンドウで開く</a>
                             <span style="margin-left:10px; color:#999;">(Shift+Clickでダウンロード)</span>
                        </div>
                   </div>`
                : `${compareBannerHtml}<div class="document-paper-container is-frameless">
                      <div class="document-content-full">
                         <div class="document-top-anchor" aria-hidden="true"></div>
                                        ${activeTab === 'diff'
                    ? (() => {
                        try {
                            // 差分表示ロジック
                            const renderAiChangeCards = () => {
                                const aiOnlyHtml = normalizeChangesForDisplay(contract.ai_changes || []).map((c, idx) => {
                                    const escapedOld = escapeHtmlText(c.old || '');
                                    const escapedNew = escapeHtmlText(c.new || '');
                                    const typeLabel = c.type === 'ADD' ? '追加' : (c.type === 'DELETE' ? '削除' : '変更');
                                    return `
                                    <div style="margin-bottom:18px; border:1px solid #e5e7eb; border-radius:8px; overflow:hidden; background:#fff;">
                                        <div style="padding:10px 14px; background:#f8fafc; border-bottom:1px solid #e5e7eb; font-size:12px; font-weight:600;">
                                            ${c.section || `変更 ${idx + 1}`} <span style="font-weight:normal; color:#667085; margin-left:8px;">(${typeLabel})</span>
                                        </div>
                                        <div class="diff-container" style="height:auto; min-height:90px;">
                                            <div class="diff-pane diff-left"><span class="diff-del">${escapedOld || '（変更前なし）'}</span></div>
                                            <div class="diff-pane diff-right"><span class="diff-add">${escapedNew || '（変更後なし）'}</span></div>
                                        </div>
                                    </div>
                                `;
                                }).join('');
                                return `<div class="document-content-diff-wrap">${aiOnlyHtml}</div>`;
                            };

                            // Extract text for diff if structured
                            const normalizePdfDisplayText = (text) => {
                                const src = String(text || '');
                                if (!src) return '';
                                const lines = src.split(/\r?\n/);
                                const out = [];
                                const articleHeaderPattern = /^第\s*[0-9０-９一二三四五六七八九十百千〇零]+\s*条(?:\s+.*)?$/;
                                const listLinePattern = /^([0-9０-９]+[\.．\)]|[・●○■□\-]|第\s*[0-9０-９一二三四五六七八九十百千〇零]+\s*条)/;
                                const shortTailPattern = /^[\u3040-\u30ff\u3400-\u9fffA-Za-z0-9]{1,6}$/;

                                for (let i = 0; i < lines.length; i += 1) {
                                    const line = String(lines[i] || '').trim();
                                    if (!line) {
                                        if (out.length > 0 && out[out.length - 1] !== '') out.push('');
                                        continue;
                                    }

                                    const prev = out.length > 0 ? out[out.length - 1] : '';
                                    const prevTrim = String(prev || '').trim();
                                    const isList = listLinePattern.test(line);
                                    const isLikelyHeaderTail = shortTailPattern.test(line) && articleHeaderPattern.test(prevTrim);
                                    const isLikelyWrappedContinuation =
                                        !isList &&
                                        prevTrim &&
                                        prevTrim !== '' &&
                                        /[\u3040-\u30ff\u3400-\u9fffA-Za-z0-9）)】]$/.test(prevTrim);

                                    if (out.length === 0 || prevTrim === '' || isList) {
                                        out.push(line);
                                    } else if (isLikelyHeaderTail || isLikelyWrappedContinuation) {
                                        out[out.length - 1] = `${prevTrim}${line}`;
                                    } else {
                                        out.push(line);
                                    }
                                }

                                return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
                            };

                            const historyEntries = Array.isArray(contract.history) ? contract.history : [];
                            const currentVersion = displayTargetDoc?.content || selectedTargetDoc?.content || contract.original_content || '';
                            const isWordSource = isWordDocumentFilename(contract.original_filename);
                            const currentVersionText = contentToComparableText(currentVersion);

                            const previousVersion = displaySourceDoc?.content || selectedSourceDoc?.content || comparisonContext?.historyItem?.content || (() => {
                                for (let i = historyEntries.length - 1; i >= 0; i -= 1) {
                                    const candidate = historyEntries[i];
                                    if (contentToComparableText(candidate?.content) !== currentVersionText) {
                                        return candidate?.content || null;
                                    }
                                }
                                return historyEntries.length > 0 ? historyEntries[historyEntries.length - 1].content : null;
                            })();

                            if (!previousVersion) {
                                if (contract.ai_changes && contract.ai_changes.length > 0) {
                                    return renderAiChangeCards();
                                }
                                const initialDisplayText = (isPdfSource && typeof contract.pdf_raw_text === 'string' && contract.pdf_raw_text.trim())
                                    ? contract.pdf_raw_text
                                    : (isPdfSource ? normalizePdfDisplayText(currentVersionText) : currentVersionText);
                                return `
                                <div class="document-content-diff-wrap" style="padding: 8px 0;">
                                    <div style="white-space:pre-wrap; line-height:1.9;">${escapeHtmlText(initialDisplayText)}</div>
                                </div>
                            `;
                            }

                            const previousVersionText = contentToComparableText(previousVersion);
                            if (previousVersionText === currentVersionText) {
                                return `
                                <div class="text-muted text-center" style="padding:24px;">比較可能な差分がありません（旧版と同一内容です）</div>
                            `;
                            }

                            if (isStructuredDocumentContent(previousVersion) || isStructuredDocumentContent(currentVersion)) {
                                const previousLabel = displaySourceDoc
                                    ? buildComparisonLabel(displaySourceDoc.document_name, displaySourceDoc.uploaded_at, '比較元資料')
                                    : (comparisonContext?.previousLabel || buildComparisonLabel(contract.original_filename || contract.name, contract.last_updated_at, '比較元資料'));
                                const currentLabel = displayTargetDoc
                                    ? buildComparisonLabel(displayTargetDoc.document_name, displayTargetDoc.uploaded_at, '比較先資料')
                                    : (comparisonContext?.currentLabel || buildComparisonLabel(contract.original_filename || contract.name, contract.last_analyzed_at || contract.last_updated_at, '比較先資料'));
                                return renderStructuredDiffView(previousVersion, currentVersion, {
                                    idPrefix: `diff-${id}`,
                                    previousLabel,
                                    currentLabel
                                });
                            }

                            const renderDualFullDiff = () => {
                                const lhsText = isPdfSource ? normalizePdfDisplayText(previousVersionText) : previousVersionText;
                                const rhsText = isPdfSource ? normalizePdfDisplayText(currentVersionText) : currentVersionText;
                            if (!window.Diff || typeof window.Diff.diffWordsWithSpace !== 'function') {
                                return `
                                    <div class="document-content-diff-wrap">
                                        <div class="dual-full-diff-grid">
                                            <div style="background:#fff; border:1px solid #e5e7eb; border-radius:8px; padding:14px;">
                                                <div style="font-size:12px; font-weight:700; color:#b42318; margin-bottom:8px;">変更前（旧版全文）</div>
                                                <div style="white-space:pre-wrap; line-height:1.9;">${escapeHtmlText(lhsText)}</div>
                                            </div>
                                            <div style="background:#fff; border:1px solid #e5e7eb; border-radius:8px; padding:14px;">
                                                <div style="font-size:12px; font-weight:700; color:#027a48; margin-bottom:8px;">変更後（新版本文）</div>
                                                <div style="white-space:pre-wrap; line-height:1.9;">${escapeHtmlText(rhsText)}</div>
                                            </div>
                                        </div>
                                    </div>
                                `;
                                }

                                const chunks = window.Diff.diffWordsWithSpace(lhsText, rhsText);
                                let oldHtml = '';
                                let newHtml = '';

                                for (const chunk of chunks) {
                                    const safe = escapeHtmlText(chunk.value);
                                    if (chunk.added) {
                                        newHtml += `<span class="diff-inline-add">${safe}</span>`;
                                    } else if (chunk.removed) {
                                        oldHtml += `<span class="diff-inline-del">${safe}</span>`;
                                    } else {
                                        oldHtml += safe;
                                        newHtml += safe;
                                    }
                                }

                                return `
                                <div class="document-content-diff-wrap">
                                    <div class="dual-full-diff-grid">
                                        <div style="background:#fff; border:1px solid #e5e7eb; border-radius:8px; padding:14px;">
                                            <div style="font-size:12px; font-weight:700; color:#b42318; margin-bottom:8px;">変更前（旧版全文）</div>
                                            <div style="white-space:pre-wrap; line-height:1.9;">${oldHtml}</div>
                                        </div>
                                        <div style="background:#fff; border:1px solid #e5e7eb; border-radius:8px; padding:14px;">
                                            <div style="font-size:12px; font-weight:700; color:#027a48; margin-bottom:8px;">変更後（新版本文）</div>
                                            <div style="white-space:pre-wrap; line-height:1.9;">${newHtml}</div>
                                        </div>
                                    </div>
                                </div>
                            `;
                            };

                            if (isPdfSource || isWordSource) {
                                return renderDualFullDiff();
                            }

                            const diff = (window.Diff && typeof window.Diff.diffChars === 'function')
                                ? window.Diff.diffChars(previousVersionText, currentVersionText)
                                : [{ value: currentVersionText }];

                            // HTML生成
                            let diffHtml = diff.map(part => {
                                const colorClass = part.added ? 'diff-inline-add' :
                                    part.removed ? 'diff-inline-del' : '';

                                // エスケープ処理（XSS対策）
                                const escapedValue = escapeHtmlText(part.value);

                                return colorClass ? `<span class="${colorClass}">${escapedValue}</span>` : escapedValue;
                            }).join('');

                            return `<div class="document-content-diff-wrap">${diffHtml}</div>`;
                        } catch (documentRenderError) {
                            console.error('Document comparison render error:', documentRenderError);
                            const fallbackPreviousText = contentToComparableText(
                                displaySourceDoc?.content || selectedSourceDoc?.content || comparisonContext?.historyItem?.content || ''
                            );
                            const fallbackCurrentText = contentToComparableText(
                                displayTargetDoc?.content || selectedTargetDoc?.content || contract.original_content || ''
                            );
                            const fallbackPreviousLabel = displaySourceDoc
                                ? buildComparisonLabel(displaySourceDoc.document_name, displaySourceDoc.uploaded_at, '比較元資料')
                                : (comparisonContext?.previousLabel || '比較元資料');
                            const fallbackCurrentLabel = displayTargetDoc
                                ? buildComparisonLabel(displayTargetDoc.document_name, displayTargetDoc.uploaded_at, '比較先資料')
                                : (comparisonContext?.currentLabel || '比較先資料');
                            return `
                                <div class="document-content-diff-wrap">
                                    <div class="dual-full-diff-grid">
                                        <div style="background:#fff; border:1px solid #e5e7eb; border-radius:8px; padding:14px;">
                                            <div style="font-size:12px; font-weight:700; color:#667085; margin-bottom:8px;">${escapeHtmlText(fallbackPreviousLabel)}</div>
                                            <div style="white-space:pre-wrap; line-height:1.9;">${escapeHtmlText(fallbackPreviousText || '比較元データなし')}</div>
                                        </div>
                                        <div style="background:#fff; border:1px solid #e5e7eb; border-radius:8px; padding:14px;">
                                            <div style="font-size:12px; font-weight:700; color:#667085; margin-bottom:8px;">${escapeHtmlText(fallbackCurrentLabel)}</div>
                                            <div style="white-space:pre-wrap; line-height:1.9;">${escapeHtmlText(fallbackCurrentText || '比較先データなし')}</div>
                                        </div>
                                    </div>
                                </div>
                            `;
                        }
                    })()
                    : (contract.original_content
                        ? `<div class="is-structured">${renderStructuredView(contract.original_content, `orig-${id}`)}</div>`
                        : '<div class="text-center text-muted" style="padding:40px;">原本データがありません</div>')
                }
                    </div>
                </div>`
            }
            </div>
            </div>
        </div>
`;
    },

    // 4. History is lazy-loaded from js/modules/history.js.
    history: null,

    // 5. Team is lazy-loaded from js/modules/team.js.
    team: null,
    mcp: () => {
        const mcpKey = window.app.mcpKey || '';
        const maskedKey = window.app.mcpKeyMasked || (mcpKey ? `mcp_••••••••••••${mcpKey.slice(-4)}` : '未発行');
        const hasVisibleKey = Boolean(mcpKey);
        const isKeyHidden = window.app.isMcpKeyHidden !== false;
        const displayKey = (!hasVisibleKey || isKeyHidden) ? maskedKey : mcpKey;
        const activeTab = window.app.mcpActiveTab || 'cloud';

        return `
            <style>
                .mcp-container { width: 960px; margin: 0 auto; position: relative; display: block; min-width: 960px; }
                .mcp-grid { display: grid; grid-template-columns: 596px 340px; gap: 24px; align-items: start; }
                .mcp-tab-item.active { border-bottom-color: #c19b4a !important; color: #0f172a !important; background: #fff !important; font-weight: 700 !important; }
                pre { max-width: 100%; overflow-x: auto; background: #f8fafc; padding: 12px; border-radius: 8px; border: 1px solid #e2e8f0; font-size: 11px; line-height: 1.4; white-space: pre-wrap; word-break: break-all; }
            </style>
            <div class="page-title" style="display:flex; align-items:center; gap:12px;">
                <span>MCP連携 (AIエージェント)</span>
            </div>
            
            <div class="mcp-container">
                <div class="mcp-grid">
                <div class="mcp-main-col">
                    <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; margin-bottom: 24px; font-size: 13px; line-height: 1.6; color: #475569;">
                        <strong>MCP (Model Context Protocol) とは？</strong><br>
                        Claude や Cursor などの使い慣れたAIから、直接 DIFFsense の契約書データにアクセスしたり解析を行ったりできるオープン規格です。<br>
                        ブラウザで DIFFsense を開かなくても、AIとの対話の中で「契約書を一覧して」「この契約書のリスクを教えて」といった指示が可能になります。
                    </div>

                    <article class="dashboard-card" style="margin-bottom: 24px; padding: 0; background: #fff; border: 1px solid #f1f5f9; border-radius: 16px; overflow:hidden;">
                        <div id="mcp-setup-card">
                            ${Views.mcpSetupCard(activeTab)}
                        </div>
                    </article>

                    <div style="margin-top:40px;">
                        <div style="margin-bottom:18px;">
                            <div>
                                <h4 style="margin:0 0 6px; font-size:14px; font-weight:800; color:#0f172a; text-transform:uppercase; letter-spacing:0.05em;">利用可能なツール（AIが実行可能）</h4>
                                <p style="margin:0; font-size:12px; line-height:1.6; color:#64748b;">Claude や Cursor から呼ばれるのはこの4機能です。</p>
                            </div>
                        </div>

                        <div style="margin-bottom:18px; padding:14px 16px; border-radius:14px; background:linear-gradient(135deg,#f8fafc 0%,#ffffff 100%); border:1px solid #e2e8f0;">
                            <div style="display:grid; grid-template-columns: repeat(2, 1fr); gap:16px;">
                                ${[
            { step: '1', title: '残数確認', text: '上限枠と利用残数を確認' },
            { step: '2', title: '一覧取得', text: 'ID と契約名を確認' },
            { step: '3', title: '単体解析', text: '1通だけのリスクを確認' },
            { step: '4', title: '差分比較', text: '変更点を確認' }
        ].map((item, i) => {
            const colors = [
                { bg: '#fee2e2', color: '#b91c1c' }, // 赤系（残数）
                { bg: '#dbeafe', color: '#1d4ed8' }, // 青系（一覧）
                { bg: '#dcfce7', color: '#15803d' }, // 緑系（単体）
                { bg: '#ffedd5', color: '#c2410c' }  // 橙系（差分）
            ];
            const c = colors[i];
            return `
                                    <div style="display:flex; align-items:center; gap:8px;">
                                        <div style="flex-shrink:0; width:28px; height:28px; border-radius:50%; background:${c.bg}; color:${c.color}; display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:800; box-shadow: 0 2px 4px rgba(0,0,0,0.05);">${item.step}</div>
                                        <div style="min-width:0;">
                                            <div style="font-size:12px; font-weight:800; color:#0f172a;">${item.title}</div>
                                            <div style="font-size:10px; color:#64748b; line-height:1.3; margin-top:2px;">${item.text}</div>
                                        </div>
                                    </div>
                                `;
        }).join('')}
                            </div>
                        </div>
                    </div>
                </div>

                <div class="mcp-side-col">
                    <article class="dashboard-card" style="background:#1e293b; color:#fff; border-radius:16px; padding:24px; border:none; box-shadow:0 12px 30px rgba(15,23,42,0.15);">
                        <h4 style="margin:0 0 16px; font-size:15px; font-weight:800; color:#fff; display:flex; align-items:center; gap:8px;">
                            <i class="fa-solid fa-key" style="color:#c19b4a;"></i> 連携用APIキー
                        </h4>
                        <div id="mcp-key-card-inner">
                            <div style="text-align:center; padding:20px;">
                                <i class="fa-solid fa-spinner fa-spin" style="color:#c19b4a;"></i>
                            </div>
                        </div>
                    </article>
                    
                    <div style="margin-top:24px; padding:16px; border-radius:12px; background:#f0f9ff; border:1px solid #bae6fd;">
                        <h5 style="margin:0 0 8px; font-size:13px; font-weight:700; color:#0369a1;">セキュリティについて</h5>
                        <p style="margin:0; font-size:11px; color:#075985; line-height:1.6;">
                            このキーは本ブラウザでの通常ログインとは別の、MCP専用の認証に使用されます。他人に教えないでください。
                        </p>
                    </div>
                </div>
                </div>
            </div>
        `;
    },
    mcpSetupCard: (activeTab) => {
        const tabs = [
            { id: 'cloud', label: 'Claude (Web/アプリ版)', icon: 'fa-robot' },
            { id: 'cursor', label: 'Cursor / VS Code', icon: 'fa-code' }
        ];
        return `
            <div style="border-bottom: 1px solid #f1f5f9; display: flex; background: #f8fafc;">
                ${tabs.map(t => `
                    <button class="mcp-tab-item ${activeTab === t.id ? 'active' : ''}" 
                        style="flex:1; padding:16px; border:none; border-bottom:2px solid transparent; background:none; cursor:pointer; font-size:13px; font-weight:600; color:#64748b; transition:all .2s; display:flex; align-items:center; justify-content:center; gap:8px;"
                        onclick="window.app.switchMcpTab('${t.id}')" data-tab="${t.id}">
                        <i class="fa-solid ${t.icon}"></i> ${t.label}
                    </button>
                `).join('')}
            </div>
            <div style="padding: 32px;" id="mcp-tab-pane">
                ${Views.mcpTabContent(activeTab)}
            </div>
        `;
    },
    mcpTabContent: (activeTab) => {
        const apiBase = (typeof getApiBaseUrl === 'function') ? getApiBaseUrl() : (aiService ? aiService.API_BASE : '');
        const mcpUrl = resolveDashboardMcpUrl(apiBase);

        if (activeTab === 'cloud') {
            return `
                <h3 style="margin:0 0 16px; font-size:17px; font-weight:800; color:#0f172a;">Claude (Web版 / アプリ版) での連携方法</h3>
                <p style="font-size:14px; color:#475569; line-height:1.6; margin-bottom:24px;">
                    Claude.ai のカスタムコネクタに URL を登録すると、以後は OAuth で安全に接続されます。URLにAPIキーは含めません。
                </p>
                
                <div style="display:flex; flex-direction:column; gap:20px;">
                    <div style="display:flex; gap:16px;">
                        <div style="width:28px; height:28px; background:#1e293b; color:#fff; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:800; flex-shrink:0;">1</div>
                        <div style="flex:1;">
                            <div style="font-weight:700; font-size:14px; margin-bottom:8px;">連携用URLをコピー</div>
                            <div style="position:relative;">
                                <input type="text" value="${mcpUrl}" readonly style="width:100%; padding:10px 40px 10px 12px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; font-size:12px; font-family:monospace; color:#475569;" id="mcp-claude-url">
                                <button onclick="navigator.clipboard.writeText('${mcpUrl}'); Notify.success('URLをコピーしました')" style="position:absolute; right:8px; top:50%; transform:translateY(-50%); background:none; border:none; color:#c19b4a; cursor:pointer; padding:6px;">
                                    <i class="fa-solid fa-copy"></i>
                                </button>
                            </div>
                        </div>
                    </div>
                    
                    <div style="display:flex; gap:16px;">
                        <div style="width:28px; height:28px; background:#1e293b; color:#fff; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:800; flex-shrink:0;">2</div>
                        <div style="flex:1;">
                            <div style="font-weight:700; font-size:14px; margin-bottom:4px;">Claude のカスタム設定画面へ移動</div>
                            <p style="font-size:12px; color:#64748b; margin:0;">
                                左下のプロフィールアイコンから <strong>「設定」(Settings)</strong> を開き、<br>
                                <strong>「コネクタ」(Connectors)</strong> から <strong>「カスタムに移動」</strong> を選んでください。
                            </p>
                        </div>
                    </div>
                    
                    <div style="display:flex; gap:16px;">
                        <div style="width:28px; height:28px; background:#1e293b; color:#fff; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:800; flex-shrink:0;">3</div>
                        <div style="flex:1;">
                            <div style="font-weight:700; font-size:14px; margin-bottom:4px;">コネクタの追加</div>
                            <p style="font-size:12px; color:#64748b; margin:0;">
                                <strong>「カスタムコネクタを追加」</strong> ボタンを押し、各項目を入力します。<br>
                                ・名前： <strong>DIFFsense</strong><br>
                                ・リモートMCPサーバーのURL： <strong>(手順1でコピーしたURL)</strong>
                            </p>
                        </div>
                    </div>

                    <div style="display:flex; gap:16px;">
                        <div style="width:28px; height:28px; background:#1e293b; color:#fff; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:800; flex-shrink:0;">4</div>
                        <div style="flex:1;">
                            <div style="font-weight:700; font-size:14px; margin-bottom:4px;">DIFFsense 認証画面でキーを入力</div>
                            <p style="font-size:12px; color:#64748b; margin:0;">
                                初回接続時に DIFFsense 側の認証画面が開きます。そこで <strong>MCP専用キー</strong> を一度だけ入力してください。<br>
                                既存キーは安全のため再表示しないので、必要なら右側のカードから新規発行してください。
                            </p>
                        </div>
                    </div>
                </div>
            `;
        } else {
            return `
                <h3 style="margin:0 0 16px; font-size:17px; font-weight:800; color:#0f172a;">Cursor / VS Code</h3>
                <div style="background: #f8fafc; border: 1px solid #e2e8f0; padding:24px; border-radius:12px;">
                    <div style="font-size:11px; font-weight:700; color:#64748b; margin-bottom:4px; text-transform:uppercase;">Endpoint (SSE)</div>
                    <code style="display:block; word-break:break-all; font-size:12px; color:#c19b4a; font-family:monospace; background:#fff; border:1px solid #e2e8f0; padding:12px; border-radius:8px;">${mcpUrl}</code>
                    <button class="btn-dashboard" style="margin-top:12px; width:100%; font-size:12px; padding:10px; font-weight:700;" onclick="navigator.clipboard.writeText('${mcpUrl}'); Notify.success('URLをコピーしました')">
                        <i class="fa-solid fa-copy"></i> URLをコピーする
                    </button>
                </div>
            `;
        }
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
        this.compareFileInput = document.getElementById('reg-compare-file-input');
        this.currentStep = 1;
        this.tempData = {};
        this.compareFile = null;
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

        if (this.compareFileInput) {
            this.compareFileInput.onchange = (e) => this.handleCompareFileSelect(e.target.files[0]);
        }
    }

    open() {
        if (!window.app.can('operate_contract')) {
            Notify.warning('閲覧のみの権限では新規登録できません');
            return;
        }
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
        if (this.compareFileInput) this.compareFileInput.value = '';
        this.compareFile = null;
    }

    renderStep() {
        if (!this.modalBody) return;

        if (this.currentStep === 1) {
            this.modalTitle.textContent = "新規登録 - 登録方法の選択";
            this.modalBody.innerHTML = `
                <div class="reg-method-grid">
                    <div class="reg-method-card" id="reg-card-docx">
                        <div class="reg-method-icon"><i class="fa-solid fa-file-word"></i></div>
                        <div class="reg-method-info">
                            <h4>Wordをアップロード</h4>
                            <p>ファイルをここにドロップするか、クリックして選択</p>
                        </div>
                    </div>
                    <div class="reg-method-card" id="reg-card-pdf">
                        <div class="reg-method-icon"><i class="fa-solid fa-file-pdf"></i></div>
                        <div class="reg-method-info">
                            <h4>PDFをアップロード</h4>
                            <p>ファイルをここにドロップするか、クリックして選択</p>
                        </div>
                    </div>
                    <div class="reg-method-card" id="reg-card-url">
                        <div class="reg-method-icon"><i class="fa-solid fa-globe"></i></div>
                        <div class="reg-method-info">
                            <h4>URLを登録 (Web規約)</h4>
                            <p>公開URLを監視対象に設定します</p>
                        </div>
                    </div>
                </div>
    `;
            this.bindCardEvents();
        } else if (this.currentStep === 2) {
            const isPdf = this.tempData.method === 'pdf';
            const isDocx = this.tempData.method === 'docx';
            const methodLabel = (isPdf || isDocx) ? 'アップロードされたファイル' : '監視対象のURL';
            const sourceVal = (isPdf || isDocx) ? (this.tempData.fileName || '選択済み') : "";
            const defaultName = this.tempData.fileName ? this.tempData.fileName.replace(/\.[^/.]+$/, "") : "";

            this.modalBody.innerHTML = `
                <div class="form-group">
                    <label>管理名 (必須)</label>
                    <input type="text" id="reg-name" class="form-control" placeholder="例: 利用規約 (2026年版)" value="${defaultName}">
                </div>
                <div class="form-group">
                    <label>種別</label>
                    <select id="reg-type" class="form-control">
                        ${(() => { const fixed = ['利用規約','NDA','業務委託契約','プライバシーポリシー']; const dynamic = dbService.getContracts().map(c => c.type).filter(Boolean); const types = [...new Set([...fixed, ...dynamic.filter(t => t !== 'その他')])]; types.push('その他'); return types.map(t => `<option value="${t}">${t}</option>`).join(''); })()}
                    </select>
                </div>
                <div class="form-group">
                    <label>${methodLabel}</label>
                    <input type="text" id="reg-source" class="form-control" 
                        placeholder="${(isPdf || isDocx) ? '' : 'https://example.com/terms'}" 
                        value="${sourceVal}" 
                        ${(isPdf || isDocx) ? 'readonly style="background:#f5f5f5; cursor:not-allowed;"' : ''}>
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
        const cardDocx = document.getElementById('reg-card-docx');
        const cardUrl = document.getElementById('reg-card-url');

        if (cardPdf) {
            cardPdf.onclick = () => {
                this.fileInput.accept = ".pdf";
                this.fileInput.click();
            };
            cardPdf.ondragover = (e) => { e.preventDefault(); cardPdf.classList.add('drop-active'); };
            cardPdf.ondragleave = () => { cardPdf.classList.remove('drop-active'); };
            cardPdf.ondrop = (e) => {
                e.preventDefault();
                cardPdf.classList.remove('drop-active');
                if (e.dataTransfer.files.length > 0) this.handleFileSelect(e.dataTransfer.files[0]);
            };
        }

        if (cardDocx) {
            cardDocx.onclick = () => {
                this.fileInput.accept = ".docx";
                this.fileInput.click();
            };
            cardDocx.ondragover = (e) => { e.preventDefault(); cardDocx.classList.add('drop-active'); };
            cardDocx.ondragleave = () => { cardDocx.classList.remove('drop-active'); };
            cardDocx.ondrop = (e) => {
                e.preventDefault();
                cardDocx.classList.remove('drop-active');
                if (e.dataTransfer.files.length > 0) this.handleFileSelect(e.dataTransfer.files[0]);
            };
        }

        if (cardUrl) {
            const isPro = window.app.subscription?.plan === 'pro';
            if (!isPro) {
                cardUrl.style.opacity = '0.55';
                cardUrl.style.position = 'relative';
                cardUrl.insertAdjacentHTML('beforeend',
                    '<div style="position:absolute;top:8px;right:8px;background:#c5a059;color:#fff;border-radius:10px;padding:2px 8px;font-size:10px;font-weight:700;letter-spacing:0.03em;">Pro</div>'
                );
            }
            cardUrl.onclick = () => {
                if (!isPro) {
                    window.app.showProFeatureModal('URLを登録して定期的に変更を監視し、差分をSlack・メールで通知する機能はProプラン限定です。');
                    return;
                }
                this.nextStep(2, { method: 'url' });
            };
        }
    }

    handleFileSelect(file) {
        if (!file) return;

        const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
        const isDocx = file.name.toLowerCase().endsWith('.docx');

        if (!isPdf && !isDocx) {
            Notify.warning('PDFまたはWordファイル(.docx)を選択してください');
            return;
        }

        this.nextStep(2, {
            method: isPdf ? 'pdf' : 'docx',
            fileName: file.name,
            fileSize: file.size,
            fileData: file
        });
    }

    handleCompareFileSelect(file) {
        if (!file) return;
        this.compareFile = file;
        const displayEl = document.getElementById('reg-compare-filename');
        if (displayEl) displayEl.textContent = file.name;
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

        const comparePrevInput = document.getElementById('reg-compare-prev');

        const name = nameInput ? nameInput.value : "";
        const type = typeInput ? typeInput.value : "";
        const source = sourceInput ? sourceInput.value : "";
        const comparePrevId = comparePrevInput ? comparePrevInput.value : "";

        if (!name) {
            Notify.warning('管理名を入力してください');
            return;
        }

        this.tempData.name = name;
        this.tempData.type = type;
        this.tempData.source = source;
        this.tempData.comparePrevId = null; // 旧UIのID指定は無効化

        // ローディング表示（抽出中）
        const isPdf = this.tempData.method === 'pdf';
        const isDocx = this.tempData.method === 'docx';
        const loadingText = isPdf ? 'PDFを取り込み中...' : (isDocx ? 'Wordファイルを取り込み中...' : 'URLから規約を解析中...');
        const loadingSubText = (isPdf || isDocx) ? '解析準備をしています' : 'Webサイトから詳細を取得しています';

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
            const isWord = this.tempData.method === 'docx';
            const newContract = dbService.addContract({
                name: this.tempData.name || ((this.tempData.method === 'pdf' || isWord) ? this.tempData.fileData.name : 'Web規約'),
                type: this.tempData.type, // デフォルト
                sourceUrl: this.tempData.method === 'url' ? this.tempData.source : '',
                originalFilename: (this.tempData.method === 'pdf' || isWord) ? this.tempData.fileData.name : ''
            });
            const savedContract = await dbService.persistContractToApi(newContract, 'POST', { throwOnError: true });
            if (!savedContract) {
                throw new Error('契約データの保存に失敗しました');
            }
            await dbService.syncContractsFromApi();
            // 2. テキスト抽出を実行（失敗しても登録は維持する）
            let extractionSucceeded = false;
            try {
                let previousText = null;
                let previousFileBase64 = null;

                // Wordの場合はファイル同士の比較を行う
                if (isWord && this.compareFile) {
                    previousFileBase64 = await aiService.convertFileToBase64(this.compareFile);
                }

                extractionSucceeded = await this.extractTextOnly(newContract.id, previousText, previousFileBase64) === true;
                await dbService.syncContractsFromApi();
            } catch (extractError) {
                console.error('Text Extraction Failed (Non-fatal):', extractError);
                // 失敗時はステータスを更新しておく（ユーザーには後で通知）
                // NOTE: dbService側で自動的に '未処理' になっているはずだが、エラー情報を残すならここで更新
            }

            // 3. 完了処理
            if (document.getElementById('reg-loading')) document.getElementById('reg-loading').remove();
            if (document.getElementById('reg-overlay')) document.getElementById('reg-overlay').remove();

            this.close();

            if (extractionSucceeded) {
                // 4. 詳細ページへ遷移（まずは原本を表示して安心させる）
                this.app.activeDetailTab = 'original';
                this.app.navigate('diff', newContract.id);
                Notify.toast('読み込みが完了しました。', {
                    type: 'success',
                    duration: 2000,
                    closable: false,
                    position: 'center'
                });
            } else {
                this.app.navigate('contracts');
                this.app.showToast('⚠️ 登録は完了しましたが、テキスト抽出に失敗しました', 'warning', 5000);
            }

        } catch (error) {
            console.error('Registration Error:', error);
            if (document.getElementById('reg-loading')) document.getElementById('reg-loading').remove();
            if (document.getElementById('reg-overlay')) document.getElementById('reg-overlay').remove();
            Notify.error('登録中にエラーが発生しました: ' + error.message);
        }
    }

    async extractTextOnly(contractId, previousVersion = null, previousFileBase64 = null) {
        try {
            let sourceData = this.tempData.source;

            // PDFまたはWordの場合はFileReaderでBase64に変換
            if ((this.tempData.method === 'pdf' || this.tempData.method === 'docx') && this.tempData.fileData) {
                sourceData = await aiService.convertFileToBase64(this.tempData.fileData);
                if (this.tempData.method === 'pdf') {
                    this.app?.setRuntimePdfPreviewUrl(contractId, this.tempData.fileData);
                } else if (this.tempData.method === 'docx') {
                    this.app?.setRuntimeOriginalPreviewFile(contractId, this.tempData.fileData);
                }
            }

            // For DOCX + compare file, run full structural diff analysis immediately.
            if (this.tempData.method === 'docx' && previousFileBase64) {
                const result = await aiService.analyzeContract(
                    contractId,
                    'docx',
                    sourceData,
                    previousFileBase64
                );

                if (!result.success) {
                    throw new Error(result.error || 'Word差分解析に失敗しました');
                }
                const extractedContent = resolveExtractedContentPayload(result.data);
                if (!extractedContent) {
                    throw new Error('Word解析結果に本文データが含まれていません');
                }

                dbService.updateContractAnalysis(contractId, {
                    extractedText: extractedContent,
                    baselineContent: result.data.previousArticles || null,
                    sourceType: result.data.sourceType || 'DOCX',
                    changes: result.data.changes || [],
                    riskLevel: result.data.riskLevel,
                    riskReason: result.data.riskReason,
                    summary: result.data.summary,
                    isFallback: result.data.isFallback === true,
                    aiFailed: result.data.aiFailed === true,
                    status: '未確認',
                    originalFilename: this.tempData.fileData?.name || '',
                    originalFilePath: result.data.originalFilePath || null
                });
                await this.app.refreshSubscriptionStatusSafe();

                console.log('Word structured diff completed');
                return true;
            }

            const result = await aiService.analyzeContract(
                contractId,
                this.tempData.method,
                sourceData,
                previousFileBase64 || previousVersion, // Word比較ならBase64を優先
                { skipAI: true }
            );

            if (result.success) {
                const extractedContent = resolveExtractedContentPayload(result.data);
                if (!extractedContent) {
                    throw new Error('抽出結果に本文データが含まれていません');
                }
                // 抽出されたテキストのみを保存（AI解析結果は保存しない）
                dbService.updateContractText(contractId, {
                    extractedText: extractedContent,
                    rawExtractedText: result.data.rawExtractedText,
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
            const methodLabel = this.tempData.method === 'pdf' ? 'PDF' : (this.tempData.method === 'docx' ? 'Word' : 'URL');
            Notify.alert(`申し訳ありません。${methodLabel}からのテキスト抽出に失敗しました。\n\n原因: ${error.message}\n\n※画像PDFやパスワード付きPDF、または破損したWordファイルは対応していない場合があります。`, { type: 'error' });

            console.warn(`テキスト抽出に失敗: ${error.message}`);
            return false;
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
        this.userRole = '管理者'; // Default: オーナー（API失敗時はチームメンバーではないのでオーナー扱い）


        // Navigation State
        this.searchQuery = "";
        this.currentPage = 1;
        this.runtimePdfPreviewUrls = new Map();
        this.runtimeOriginalDocxFiles = new Map();
        this.historyComparisonContext = null;
        this.documentCompareState = null;
        this.dashboardFilter = "pending";
        this.activeDetailTab = 'original';
        this.filters = {
            query: "",
            risk: "all",
            status: "all",
            type: "all",
            sortBy: "date_desc"
        };
        this.searchTimeout = null;
        this.detailClauseNavScrollCleanup = null;
        this.detailClauseNavRaf = null;

        // Registration Flow
        this.registration = new RegistrationFlow(this);
        // 無料期間終了フロー時は決済モーダルを閉じられないようにする
        this.forceSubscriptionPayment = false;
        this.planViewBillingCycle = null;
        this.paymentConfig = null;
        this.paymentPlanAvailability = null;
        this.hasAnnualBillingPlans = null;
        this.stripeEnabled = false;
        this.stripePublishableKey = '';

        // 初期表示をOwnerプランに設定 (ローカル開発・全機能解放)
        const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
        this.subscription = { 
            plan: isLocal ? 'owner' : 'free', 
            billingCycle: 'monthly', 
            usageCount: 0, 
            usageLimit: 999999, 
            daysRemaining: null, 
            planLimit: 999999,
            signUsageLimit: 999999
        };
        this.userPlan = isLocal ? 'owner' : 'free';

        // URLパラメータによるプラン強制 (検証用: ?forcePlan=free|starter|business|pro) ローカル環境のみ有効
        const urlParams = new URLSearchParams(window.location.search);
        const _isLocalHost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
        const forcedPlan = _isLocalHost ? urlParams.get('forcePlan') : null;
        const forcedPlanData = {
            free:     { plan: 'free',     billingCycle: 'monthly', usageCount: 0, usageLimit: 999999, daysRemaining: null, planLimit: 999999, signUsageLimit: 999999 },
            starter:  { plan: 'starter',  billingCycle: 'monthly', usageCount: 0, usageLimit: 999999, daysRemaining: null, planLimit: 999999, signUsageLimit: 999999 },
            business: { plan: 'business', billingCycle: 'monthly', usageCount: 0, usageLimit: 999999, daysRemaining: null, planLimit: 999999, signUsageLimit: 999999 },
            pro:      { plan: 'pro',      billingCycle: 'monthly', usageCount: 0, usageLimit: 999999, daysRemaining: null, planLimit: 999999, signUsageLimit: 999999 },
        };
        if (forcedPlan && forcedPlanData[forcedPlan]) {
            this.subscription = forcedPlanData[forcedPlan];
            this.userPlan = forcedPlan;
            this.setCachedItem(DASHBOARD_CACHE_KEYS.SUBSCRIPTION, this.subscription);
        }

        this.memoryCache = new Map();
        this.pendingPairAnalysisKeys = new Set();
        this.attemptedAutoPairAnalysisKeys = new Set();
        this.bootstrapCompleted = false;
        this.hydrateCachedState();
    }

    async loadAndRenderMcpSettings() {
        const main = this.mainContent;
        const requestedView = 'mcp';
        if (!main) return;
        main.innerHTML = Views.mcp();
        this.scheduleMcpPaneStabilization();
        try {
            const data = await dbService.getMcpApiKey();
            if (this.currentView !== requestedView || this.mainContent !== main) return;
            this.mcpKey = data?.mcpApiKey || '';
            this.mcpKeyMasked = data?.maskedKey || '未発行';
            this.mcpHasKey = Boolean(data?.hasKey || data?.mcpApiKey);
        } catch (error) {
            if (this.currentView !== requestedView || this.mainContent !== main) return;
            console.error('Failed to load MCP settings:', error);
            this.mcpKey = '';
            this.mcpKeyMasked = 'エラー';
            this.mcpHasKey = false;
        }
        if (this.currentView !== requestedView || this.mainContent !== main) return;
        this.renderMcpKeyCard();
    }

    renderMcpKeyCard() {
        const el = document.getElementById('mcp-key-card-inner');
        if (el) {
            const mcpKey = this.mcpKey || '';
            const maskedKey = this.mcpKeyMasked || (mcpKey ? `mcp_••••••••••••${mcpKey.slice(-4)}` : '未発行');
            const hasVisibleKey = Boolean(mcpKey);
            const isKeyHidden = this.isMcpKeyHidden !== false;
            const displayKey = (!hasVisibleKey || isKeyHidden) ? maskedKey : mcpKey;
            
            el.innerHTML = `
                <div style="background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); border-radius:10px; padding:16px; margin-bottom:16px;">
                    <div style="font-size:11px; color:#94a3b8; margin-bottom:8px;">MCP専用APIキー</div>
                    <div style="display:flex; align-items:center; gap:8px;">
                        <code style="flex:1; font-family:monospace; font-size:13px; color:#fff; word-break:break-all;">${displayKey}</code>
                    </div>
                    <div style="display:flex; gap:8px; margin-top:12px;">
                        <button class="btn-dashboard" style="flex:1; background:rgba(255,255,255,0.1); border:none; color:#fff; font-size:11px; padding:6px; ${hasVisibleKey ? '' : 'opacity:0.5; cursor:not-allowed;'}" onclick="${hasVisibleKey ? 'window.app.toggleMcpKeyVisibility()' : 'Notify.info(`既存キーは安全のため再表示されません。必要なら新規発行してください`)'}">
                            <i class="fa-solid ${hasVisibleKey && !isKeyHidden ? 'fa-eye-slash' : 'fa-eye'}"></i> ${hasVisibleKey ? (isKeyHidden ? '新規キーを表示' : '非表示にする') : '既存キーは再表示不可'}
                        </button>
                        <button class="btn-dashboard" style="flex:1; background:rgba(255,255,255,0.1); border:none; color:#fff; font-size:11px; padding:6px; ${hasVisibleKey ? '' : 'opacity:0.5; cursor:not-allowed;'}" onclick="${hasVisibleKey ? `navigator.clipboard.writeText('${mcpKey}'); Notify.success('キーをコピーしました')` : `Notify.info('コピーできるのは新規発行直後のキーのみです')`}">
                            <i class="fa-solid fa-copy"></i> コピー
                        </button>
                    </div>
                </div>
                
                <button class="btn-dashboard" style="width:100%; background:#c19b4a; border:none; color:#fff; font-weight:700; font-size:13px; padding:10px;" onclick="window.app.generateMcpKey()">
                    <i class="fa-solid fa-rotate"></i> 新規キーを発行
                </button>
                <p style="font-size:10px; color:#94a3b8; margin-top:12px; line-height:1.4;">
                    ※キーは安全のため再表示しません。
                </p>
            `;
        }
    }

    toggleMcpKeyVisibility() {
        this.isMcpKeyHidden = this.isMcpKeyHidden === false ? true : false;
        this.renderMcpKeyCard();
    }

    async generateMcpKey() {
        if (!await Notify.confirm('MCP APIキーを生成しますか？\n以前のキーは使えなくなります。', { title: '確認', type: 'warning' })) return;
        const loading = Notify.info('生成中...', { duration: 0 });
        try {
            const data = await dbService.generateMcpApiKey();
            if (data && data.mcpApiKey) {
                this.mcpKey = data.mcpApiKey;
                this.mcpKeyMasked = data.maskedKey || `mcp_••••••••••••${data.mcpApiKey.slice(-4)}`;
                this.mcpHasKey = true;
                this.isMcpKeyHidden = false;
                this.renderMcpKeyCard();
                Notify.success('APIキーを更新しました');
            } else {
                Notify.error('生成に失敗しました');
            }
        } finally {
            if (loading && loading.close) loading.close();
        }
    }

    switchMcpTab(tabId) {
        this.mcpActiveTab = tabId;
        const pane = document.getElementById('mcp-tab-pane');
        if (pane) {
            pane.innerHTML = Views.mcpTabContent(tabId);
        }
        const buttons = document.querySelectorAll('.mcp-tab-item');
        buttons.forEach(btn => {
            if (btn.dataset.tab === tabId) btn.classList.add('active');
            else btn.classList.remove('active');
        });
        this.scheduleMcpPaneStabilization();
    }

    scheduleMcpPaneStabilization() {
        if (this._mcpPaneHeightRaf) cancelAnimationFrame(this._mcpPaneHeightRaf);
        this._mcpPaneHeightRaf = requestAnimationFrame(() => {
            this._mcpPaneHeightRaf = null;
        });
    }

    copyMcpKeyToClipboard() {
        if (!this.mcpKey) { Notify.warning('コピーできるキーがありません'); return; }
        navigator.clipboard.writeText(this.mcpKey);
        Notify.success('APIキーをコピーしました');
    }

    copyMcpConfigToClipboard() {
        const pre = document.getElementById('mcp-config-code');
        if (pre) {
            navigator.clipboard.writeText(pre.textContent);
            Notify.success('設定内容をコピーしました');
        }
    }

    setRuntimePdfPreviewUrl(contractId, file) {
        if (!contractId || !file || !(file instanceof File)) return;
        const key = String(contractId);
        const previous = this.runtimePdfPreviewUrls.get(key);
        if (previous) {
            try { URL.revokeObjectURL(previous); } catch (_) { /* noop */ }
        }
        const blobUrl = URL.createObjectURL(file);
        this.runtimePdfPreviewUrls.set(key, blobUrl);
        // Persist to IndexedDB so file survives page refresh
        this._savePdfToIDB(contractId, file).catch(() => {});
    }

    getRuntimePdfPreviewUrl(contractId) {
        if (!contractId) return null;
        return this.runtimePdfPreviewUrls.get(String(contractId)) || null;
    }

    async getPdfFromIDB(contractId) {
        if (!contractId) return null;
        if (this.runtimePdfPreviewUrls.get(String(contractId))) return null; // already in memory
        try {
            const file = await this._loadPdfFromIDB(contractId);
            if (file) {
                const blobUrl = URL.createObjectURL(file);
                this.runtimePdfPreviewUrls.set(String(contractId), blobUrl);
            }
        } catch (_) {}
        return null;
    }

    async _savePdfToIDB(contractId, file) {
        const db = await this._openDocxIDB();
        const buf = await file.arrayBuffer();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('docx-files', 'readwrite');
            tx.objectStore('docx-files').put({ contractId: `pdf-${contractId}`, name: file.name, data: buf, savedAt: Date.now() });
            tx.oncomplete = resolve;
            tx.onerror = (e) => reject(e.target.error);
        });
    }

    async _loadPdfFromIDB(contractId) {
        const db = await this._openDocxIDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('docx-files', 'readonly');
            const req = tx.objectStore('docx-files').get(`pdf-${contractId}`);
            req.onsuccess = (e) => {
                const rec = e.target.result;
                if (rec) resolve(new File([rec.data], rec.name, { type: 'application/pdf' }));
                else resolve(null);
            };
            req.onerror = (e) => reject(e.target.error);
        });
    }

    setRuntimeOriginalPreviewFile(contractId, file) {
        if (!contractId || !file || !(file instanceof File)) return;
        this.runtimeOriginalDocxFiles.set(String(contractId), file);
        // Persist to IndexedDB so file survives page refresh
        this._saveDocxToIDB(contractId, file).catch(() => {});
    }

    getRuntimeOriginalPreviewFile(contractId) {
        if (!contractId) return null;
        return this.runtimeOriginalDocxFiles.get(String(contractId)) || null;
    }

    async getDocxFromIDB(contractId) {
        if (!contractId) return null;
        // Check in-memory first
        const mem = this.runtimeOriginalDocxFiles.get(String(contractId));
        if (mem) return mem;
        try {
            const file = await this._loadDocxFromIDB(contractId);
            if (file) this.runtimeOriginalDocxFiles.set(String(contractId), file);
            return file;
        } catch (_) { return null; }
    }

    async _saveDocxToIDB(contractId, file) {
        const db = await this._openDocxIDB();
        const buf = await file.arrayBuffer();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('docx-files', 'readwrite');
            tx.objectStore('docx-files').put({ contractId: String(contractId), name: file.name, data: buf, savedAt: Date.now() });
            tx.oncomplete = resolve;
            tx.onerror = (e) => reject(e.target.error);
        });
    }

    async _loadDocxFromIDB(contractId) {
        const db = await this._openDocxIDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('docx-files', 'readonly');
            const req = tx.objectStore('docx-files').get(String(contractId));
            req.onsuccess = (e) => {
                const rec = e.target.result;
                if (rec) resolve(new File([rec.data], rec.name, { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }));
                else resolve(null);
            };
            req.onerror = (e) => reject(e.target.error);
        });
    }

    _openDocxIDB() {
        if (this._docxIDBPromise) return this._docxIDBPromise;
        this._docxIDBPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open('diffsense-docx-store', 1);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('docx-files')) {
                    db.createObjectStore('docx-files', { keyPath: 'contractId' });
                }
            };
            req.onsuccess = (e) => resolve(e.target.result);
            req.onerror = (e) => reject(e.target.error);
        });
        return this._docxIDBPromise;
    }

    setHistoryComparisonContext(context = null) {
        this.historyComparisonContext = context && typeof context === 'object'
            ? { ...context }
            : null;
    }

    getHistoryComparisonContext(contractId) {
        if (!this.historyComparisonContext) return null;
        if (contractId !== undefined && contractId !== null && Number(this.historyComparisonContext.contractId) !== Number(contractId)) {
            return null;
        }
        return this.historyComparisonContext;
    }

    clearHistoryComparisonContext(contractId = null) {
        if (!this.historyComparisonContext) return;
        if (contractId !== null && contractId !== undefined && Number(this.historyComparisonContext.contractId) !== Number(contractId)) {
            return;
        }
        this.historyComparisonContext = null;
    }

    getDocumentCompareState(contractId = null) {
        if (!this.documentCompareState) return null;
        if (contractId !== null && contractId !== undefined && Number(this.documentCompareState.contractId) !== Number(contractId)) {
            return null;
        }
        return this.documentCompareState;
    }

    setDocumentCompareState(state = null) {
        this.documentCompareState = state && typeof state === 'object' ? { ...state } : null;
    }

    syncLatestDocumentCompareState(contractId) {
        const docs = dbService.getDocumentsByContractId(contractId);
        const currentDoc = docs.find((doc) => doc.is_current) || null;
        const historicalDocs = docs.filter((doc) => !doc.is_current);
        const latestHistoryDoc = historicalDocs.length > 0 ? historicalDocs[historicalDocs.length - 1] : null;
        if (!currentDoc || !latestHistoryDoc) return;
        this.setDocumentCompareState({
            contractId,
            docAId: latestHistoryDoc.id,
            docBId: currentDoc.id
        });
    }

    clearDocumentCompareState(contractId = null) {
        if (!this.documentCompareState) return;
        if (contractId !== null && contractId !== undefined && Number(this.documentCompareState.contractId) !== Number(contractId)) {
            return;
        }
        this.documentCompareState = null;
    }

    buildPairAnalysisKey(contractId, docAId, docBId) {
        if (!contractId || !docAId || !docBId) return '';
        return `${contractId}:${docAId}->${docBId}`;
    }

    isPairAnalysisPending(contractId, docAId, docBId) {
        const key = this.buildPairAnalysisKey(contractId, docAId, docBId);
        return key ? this.pendingPairAnalysisKeys.has(key) : false;
    }

    scheduleAutoPairAnalysis(contractId, docAId, docBId, options = {}) {
        if (!this.can('operate_contract')) return false;

        const key = this.buildPairAnalysisKey(contractId, docAId, docBId);
        if (!key) return false;
        if (this.pendingPairAnalysisKeys.has(key)) return true;
        if (this.attemptedAutoPairAnalysisKeys.has(key)) return false;

        const force = options.force === true;
        this.pendingPairAnalysisKeys.add(key);
        this.attemptedAutoPairAnalysisKeys.add(key);

        setTimeout(async () => {
            try {
                if (this.currentView !== 'diff' || Number(this.currentViewParams) !== Number(contractId)) return;

                const docs = dbService.getDocumentsByContractId(contractId);
                const sourceDoc = docs.find((doc) => doc.id === docAId);
                const targetDoc = docs.find((doc) => doc.id === docBId);
                if (!sourceDoc || !targetDoc || sourceDoc.id === targetDoc.id) return;

                const cached = dbService.getDiffResult(docAId, docBId);
                if (!force && hasAnalysisRecord(cached?.diff_data)) return;

                await this.analyzeDocumentPair(contractId, sourceDoc, targetDoc, { force, silent: true, auto: true });
            } catch (error) {
                console.error('Auto pair analysis error:', error);
            } finally {
                this.pendingPairAnalysisKeys.delete(key);
            }
        }, 0);

        return true;
    }

    getCachedItem(key, maxAgeMs = 5 * 60 * 1000) {
        try {
            const mem = this.memoryCache.get(key);
            if (mem && Date.now() - mem.ts < maxAgeMs) return mem.value;
            const raw = localStorage.getItem(key);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return null;
            if (Date.now() - (parsed.ts || 0) > maxAgeMs) return null;
            this.memoryCache.set(key, parsed);
            return parsed.value;
        } catch {
            return null;
        }
    }

    setCachedItem(key, value) {
        try {
            const payload = { ts: Date.now(), value };
            this.memoryCache.set(key, payload);
            localStorage.setItem(key, JSON.stringify(payload));
        } catch {
            // ignore cache errors
        }
    }

    hydrateCachedState() {
        // URLパラメータ優先
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.get('forcePlan')) return;

        const cachedSub = this.getCachedItem(DASHBOARD_CACHE_KEYS.SUBSCRIPTION, 10 * 60 * 1000);
        if (cachedSub && cachedSub.plan) {
            this.subscription = {
                ...this.subscription,
                ...cachedSub,
                billingCycle: cachedSub.billingCycle === 'annual' ? 'annual' : 'monthly'
            };
            this.userPlan = cachedSub.plan;
        }

        const cachedUser = this.getCachedItem(DASHBOARD_CACHE_KEYS.USER_META, 30 * 60 * 1000);
        if (cachedUser) {
            if (cachedUser.role) this.userRole = cachedUser.role;
            if (cachedUser.email) {
                const emailEl = document.getElementById('user-email-display');
                if (emailEl) emailEl.textContent = cachedUser.email;
            }
            if (cachedUser.name) {
                const nameEl = document.getElementById('user-name-display');
                if (nameEl) nameEl.textContent = cachedUser.name;
            }
        }
    }

    renderInitialSkeleton(viewId = 'dashboard') {
        if (!this.mainContent) return;
        this.mainContent.innerHTML = Views.loading(viewId);
    }

    cacheRecentHistorySnapshot() {
        try {
            const logs = dbService.getActivityLogs();
            if (Array.isArray(logs) && logs.length > 0) {
                this.setCachedItem(DASHBOARD_CACHE_KEYS.RECENT_HISTORY, logs.slice(0, 30));
            }
        } catch {
            // ignore cache errors
        }
    }

    /**
     * Compute days remaining until a date string (YYYY-MM-DD).
     * Returns null if date is invalid.
     */
    _daysUntil(dateStr) {
        if (!dateStr) return null;
        const target = new Date(dateStr);
        if (isNaN(target.getTime())) return null;
        target.setHours(0, 0, 0, 0);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        return Math.round((target - today) / (1000 * 60 * 60 * 24));
    }

    /**
     * Format YYYY-MM-DD to Japanese locale string.
     */
    _formatDateJa(dateStr) {
        if (!dateStr) return '—';
        const d = new Date(dateStr);
        if (isNaN(d.getTime())) return dateStr;
        return d.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' });
    }

    /**
     * Show modal with document viewer (paginated) + deadline input form.
     */
    showDeadlineInputModal(contractId) {
        const contracts = dbService.getContracts();
        const c = contracts.find(x => String(x.id) === String(contractId));
        if (!c) return;

        // Build document content HTML using inline styles only (no CSS class dependency)
        let contentHtml = '';
        if (c.original_content) {
            const clauses = parseContractIntoClauses(c.original_content);
            if (clauses && clauses.length > 0) {
                contentHtml = clauses.map(clause => {
                    const titleHtml = clause.title
                        ? `<div style="font-size:13px;font-weight:700;color:#c5a059;margin-bottom:4px;">${clause.title}${clause.header ? `　${clause.header}` : ''}</div>`
                        : '';
                    const bodyHtml = (clause.paragraphs || []).map(p =>
                        `<p style="margin:0 0 8px;line-height:1.8;font-size:13px;color:#2b2623;">${String(p).replace(/\n/g, '<br>')}</p>`
                    ).join('');
                    return `<div style="margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid #f0ece8;">${titleHtml}${bodyHtml}</div>`;
                }).join('');
            }
        }
        if (!contentHtml && c.extracted_text) {
            const paragraphs = c.extracted_text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
            contentHtml = paragraphs.length > 0
                ? `<div style="padding:4px 0;">${paragraphs.map(p => `<p style="margin:0 0 14px;line-height:1.8;font-size:13px;color:#2b2623;">${p.replace(/\n/g, '<br>')}</p>`).join('')}</div>`
                : '';
        }
        if (!contentHtml) {
            contentHtml = `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:#aaa;gap:12px;padding:40px 0;">
                <i class="fa-solid fa-file-lines" style="font-size:36px;"></i>
                <div style="font-size:13px;">書類の本文が取得できませんでした</div>
                <div style="font-size:12px;">下記フォームから期限を直接入力してください</div>
              </div>`;
        }

        document.getElementById('deadline-input-overlay')?.remove();

        const overlay = document.createElement('div');
        overlay.id = 'deadline-input-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9000;display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box;';
        overlay.innerHTML = `
            <div style="background:#fff;border-radius:12px;width:100%;max-width:1100px;height:88vh;display:flex;flex-direction:column;box-shadow:0 8px 40px rgba(0,0,0,0.22);overflow:hidden;">

                <!-- Header -->
                <div style="display:flex;align-items:center;justify-content:space-between;padding:18px 24px;border-bottom:1px solid #eee;flex-shrink:0;">
                    <div>
                        <div style="font-size:15px;font-weight:700;color:#2b2623;">${escapeHtmlText(c.name) || '契約書'}</div>
                        <div style="font-size:12px;color:#aaa;margin-top:2px;">${escapeHtmlText(c.type || '')}${c.contract_category ? ' · ' + escapeHtmlText(c.contract_category) : ''}</div>
                    </div>
                    <button onclick="document.getElementById('deadline-input-overlay').remove()" style="background:none;border:none;font-size:22px;color:#aaa;cursor:pointer;line-height:1;padding:4px 8px;">✕</button>
                </div>

                <!-- Body: left=doc, right=form -->
                <div style="display:flex;flex:1;overflow:hidden;min-height:0;">

                    <!-- Document viewer (scrollable) -->
                    <div style="flex:1;overflow:hidden;min-width:0;border-right:1px solid #eee;">
                        <div style="height:100%;overflow-y:auto;padding:20px 24px;box-sizing:border-box;">
                            ${contentHtml}
                        </div>
                    </div>

                    <!-- Deadline input form -->
                    <div style="width:280px;flex-shrink:0;display:flex;flex-direction:column;padding:24px 20px;gap:16px;overflow-y:auto;">
                        <div style="font-size:13px;font-weight:700;color:#2b2623;margin-bottom:4px;"><i class="fa-solid fa-calendar-days" style="color:#c5a059;margin-right:6px;"></i>期限を入力</div>
                        <div>
                            <label style="font-size:11px;font-weight:600;color:#5e544d;display:block;margin-bottom:5px;">契約終了日</label>
                            <input type="date" id="dl-expiry" value="${c.expiry_date || ''}"
                                style="width:100%;padding:8px 10px;border:1px solid #ddd;border-radius:6px;font-size:13px;box-sizing:border-box;">
                        </div>
                        <div style="flex:1;"></div>
                        <div style="display:flex;flex-direction:column;gap:8px;">
                            <button onclick="window.app.saveDeadlineInput('${contractId}')"
                                style="padding:10px;border:none;border-radius:6px;background:#c5a059;color:#fff;font-size:13px;font-weight:600;cursor:pointer;width:100%;">
                                <i class="fa-solid fa-check" style="margin-right:6px;"></i>保存
                            </button>
                            <button onclick="document.getElementById('deadline-input-overlay').remove()"
                                style="padding:9px;border:1px solid #ddd;border-radius:6px;background:#fff;color:#5e544d;font-size:13px;cursor:pointer;width:100%;">キャンセル</button>
                        </div>
                    </div>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    }

    /**
     * Show confirmation popup before running single-doc reanalysis.
     */
    confirmReanalyze(contractId) {
        const overlay = document.createElement('div');
        overlay.id = 'reanalyze-confirm-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:9500;display:flex;align-items:center;justify-content:center;';
        overlay.innerHTML = `
            <div style="background:#fff;border-radius:12px;padding:28px 32px;width:400px;max-width:92vw;box-shadow:0 8px 32px rgba(0,0,0,0.18);">
                <div style="display:flex;align-items:flex-start;gap:14px;margin-bottom:20px;">
                    <div style="width:40px;height:40px;border-radius:10px;background:#fef3e2;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                        <i class="fa-solid fa-wand-magic-sparkles" style="color:#c5a059;font-size:18px;"></i>
                    </div>
                    <div>
                        <div style="font-size:15px;font-weight:700;color:#2b2623;margin-bottom:6px;">AIリスク解析を実行しますか？</div>
                        <div style="font-size:13px;color:#5e544d;line-height:1.6;">
                            リスク解析と期限解析を同時に行います。<br>
                            <strong style="color:#c5a059;">解析1回を消費します。</strong>
                        </div>
                    </div>
                </div>
                <div style="background:#f8f6f3;border-radius:8px;padding:12px 14px;margin-bottom:20px;font-size:12px;color:#7a6a5a;line-height:1.6;">
                    <i class="fa-solid fa-circle-info" style="color:#c5a059;margin-right:6px;"></i>
                    差分チェックなしでも、AIが書類全体のリスクと契約期限を抽出します。
                </div>
                <div style="display:flex;gap:10px;justify-content:flex-end;">
                    <button onclick="document.getElementById('reanalyze-confirm-overlay').remove()"
                        style="padding:9px 20px;border:1px solid #ddd;border-radius:6px;background:#fff;color:#5e544d;font-size:14px;cursor:pointer;">キャンセル</button>
                    <button onclick="document.getElementById('reanalyze-confirm-overlay').remove();window.app.runReanalyze('${contractId}')"
                        style="padding:9px 22px;border:none;border-radius:6px;background:#c5a059;color:#fff;font-size:14px;font-weight:600;cursor:pointer;">
                        <i class="fa-solid fa-play" style="margin-right:6px;"></i>解析する
                    </button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    }

    /**
     * Execute single-doc reanalysis (risk + deadline) via API.
     */
    async runReanalyze(contractId) {
        const contracts = dbService.getContracts();
        const c = contracts.find(x => String(x.id) === String(contractId));
        if (!c) { Notify.error('契約が見つかりません'); return; }

        // original_content がオブジェクト（構造化JSON）の場合はテキストに変換
        let contractText = '';
        if (c.original_content && typeof c.original_content === 'object') {
            const oc = c.original_content;
            const parts = [];
            if (oc.preamble) parts.push(oc.preamble);
            if (Array.isArray(oc.articles)) {
                for (const a of oc.articles) {
                    if (a.articleNumber || a.title) parts.push(`${a.articleNumber || ''} ${a.title || ''}`.trim());
                    if (a.content) parts.push(a.content);
                }
            }
            contractText = parts.join('\n\n').trim();
        }
        if (!contractText) {
            contractText = (typeof c.original_content === 'string' ? c.original_content : (c.extracted_text || '')).trim();
        }
        if (!contractText || contractText.length < 10) {
            Notify.warning('書類の本文データがありません。差分チェックで取り込んでください。');
            return;
        }

        // Show loading state on button
        const btn = document.getElementById('btn-reanalyze');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="margin-right:6px;"></i>解析中...';
        }

        try {
            const authModule = await import('./auth.js');
            const token = await authModule.getIdToken();
            const apiBase = (await import('./api-base.js')).getApiBaseUrl();

            const res = await fetch(`${apiBase}/api/contracts/${contractId}/reanalyze`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ contractText })
            });
            const data = await res.json();

            if (!data.success) {
                Notify.error(data.error || '解析に失敗しました');
                if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i>AIリスク解析'; }
                return;
            }

            // updateContractAnalysis で ai_summary/ai_risk_reason/ai_changes を正しく保存
            dbService.updateContractAnalysis(contractId, {
                summary: data.data.summary,
                riskLevel: data.data.riskLevel,
                riskReason: data.data.riskReason,
                changes: data.data.changes || [],
                status: '未確認',
            });
            // contract_meta（期限情報）を追加保存
            if (data.data.contract_meta) {
                const meta = data.data.contract_meta;
                const allContracts = dbService.getContracts();
                const idx = allContracts.findIndex(x => String(x.id) === String(contractId));
                if (idx !== -1) {
                    Object.assign(allContracts[idx], {
                        expiry_date: meta.expiry_date || null,
                        renewal_deadline: meta.renewal_deadline || null,
                        contract_start: meta.contract_start || null,
                        auto_renewal: meta.auto_renewal,
                        contract_category: meta.contract_category || null,
                        date_confidence: meta.date_confidence || 'unknown',
                    });
                    localStorage.setItem(dbService.KEYS.CONTRACTS, JSON.stringify(allContracts));
                }
            }
            await this.refreshSubscriptionStatusSafe();

            // 期限情報の取得結果を通知
            const meta = data.data.contract_meta;
            const hasDeadline = meta && (meta.expiry_date || meta.renewal_deadline || meta.contract_start);
            if (hasDeadline) {
                Notify.success('解析完了。期限情報を期限・アラート管理に格納しました');
            } else {
                Notify.success('解析が完了しました');
                setTimeout(() => {
                    Notify.info('期限情報を取得できませんでした。「期限・アラート管理」から手動入力すると、スラック・メールで通知が届きます', { duration: 6000 });
                }, 800);
            }
            // Re-render detail view
            this.navigate('diff', contractId);

        } catch (err) {
            Notify.error('解析エラー: ' + err.message);
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i>AIリスク解析'; }
        }
    }

    /**
     * Toggle per-contract deadline notification on/off.
     */
    toggleDeadlineNotify(contractId, enabled) {
        const contracts = dbService.getContracts();
        const idx = contracts.findIndex(x => String(x.id) === String(contractId));
        if (idx === -1) return;
        contracts[idx].deadline_notify = enabled;
        localStorage.setItem(dbService.KEYS.CONTRACTS, JSON.stringify(contracts));
    }

    /**
     * Save manually entered deadline back to localStorage and re-render.
     */
    saveDeadlineInput(contractId) {
        const expiry = document.getElementById('dl-expiry')?.value || null;
        if (!expiry) {
            Notify.warning('契約終了日を入力してください');
            return;
        }

        const contracts = dbService.getContracts();
        const idx = contracts.findIndex(x => String(x.id) === String(contractId));
        if (idx === -1) return;

        contracts[idx] = {
            ...contracts[idx],
            expiry_date: expiry,
            date_confidence: 'high',
        };
        localStorage.setItem(dbService.KEYS.CONTRACTS, JSON.stringify(contracts));

        document.getElementById('deadline-input-overlay')?.remove();
        Notify.success('期限を保存しました');
        this.navigate('deadlines');
    }

    /**
     * Re-analyze a contract from the deadline alerts view to extract deadline info.
     */
    async runDeadlineReanalyze(contractId) {
        const contracts = dbService.getContracts();
        const c = contracts.find(x => String(x.id) === String(contractId));
        if (!c) { Notify.error('契約が見つかりません'); return; }

        let contractText = '';
        if (c.original_content && typeof c.original_content === 'object') {
            const oc = c.original_content;
            const parts = [];
            if (oc.preamble) parts.push(oc.preamble);
            if (Array.isArray(oc.articles)) {
                for (const a of oc.articles) {
                    if (a.articleNumber || a.title) parts.push(`${a.articleNumber || ''} ${a.title || ''}`.trim());
                    if (a.content) parts.push(a.content);
                }
            }
            contractText = parts.join('\n\n').trim();
        }
        if (!contractText) {
            contractText = (typeof c.original_content === 'string' ? c.original_content : (c.extracted_text || '')).trim();
        }
        if (!contractText || contractText.length < 10) {
            Notify.warning('書類の本文データがありません。差分チェックから再取り込みしてください。');
            return;
        }

        const btn = document.getElementById(`btn-deadline-reanalyze-${contractId}`);
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="margin-right:4px;font-size:10px;"></i>解析中...';
        }

        try {
            const authModule = await import('./auth.js');
            const token = await authModule.getIdToken();
            const apiBase = (await import('./api-base.js')).getApiBaseUrl();

            const res = await fetch(`${apiBase}/api/contracts/${contractId}/reanalyze`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ contractText })
            });
            const data = await res.json();

            if (!data.success) {
                Notify.error(data.error || '再解析に失敗しました');
                if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-rotate" style="margin-right:4px;font-size:10px;"></i>再解析'; }
                return;
            }

            if (data.data.contract_meta) {
                const meta = data.data.contract_meta;
                const allContracts = dbService.getContracts();
                const idx = allContracts.findIndex(x => String(x.id) === String(contractId));
                if (idx !== -1) {
                    Object.assign(allContracts[idx], {
                        expiry_date: meta.expiry_date || null,
                        renewal_deadline: meta.renewal_deadline || null,
                        contract_start: meta.contract_start || null,
                        auto_renewal: meta.auto_renewal,
                        contract_category: meta.contract_category || null,
                        date_confidence: meta.date_confidence || 'unknown',
                    });
                    localStorage.setItem(dbService.KEYS.CONTRACTS, JSON.stringify(allContracts));
                }
            }
            await this.refreshSubscriptionStatusSafe();

            const meta = data.data.contract_meta;
            const hasDeadline = meta && (meta.expiry_date || meta.renewal_deadline);
            if (hasDeadline) {
                Notify.success('再解析完了。期限情報を取得しました');
            } else {
                Notify.warning('再解析しましたが期限情報を取得できませんでした。手動で入力してください。');
            }
            this.navigate('deadlines');
        } catch (err) {
            Notify.error('再解析エラー: ' + err.message);
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-rotate" style="margin-right:4px;font-size:10px;"></i>再解析'; }
        }
    }

    /**
     * Update the sidebar badge for deadlines (urgent contracts count).
     */
    updateDeadlinesBadge() {
        const badge = document.getElementById('nav-deadlines-badge');
        if (!badge) return;
        const contracts = dbService.getContracts ? dbService.getContracts() : (dbService._localContracts || []);
        const urgentCount = contracts.filter(c => {
            const days = this._daysUntil(c.expiry_date);
            return days !== null && days >= 0 && days <= 30;
        }).length;
        if (urgentCount > 0) {
            badge.textContent = urgentCount;
            badge.style.display = 'inline-block';
        } else {
            badge.style.display = 'none';
        }
    }

    /**
     * Render the deadlines management view.
     */
    renderDeadlinesView(opts = {}) {
        const plan = this.userPlan || this.subscription?.plan || 'free';
        const deadlineLocked = plan === 'free';

        const query = (opts.query || '').trim().toLowerCase();
        const filterRange = opts.filterRange || 'all'; // all | urgent | warning | upcoming | nodate
        const sortKey = opts.sortKey || 'analyzed'; // analyzed | days | name | date
        const sortDir = opts.sortDir || 'desc';

        const allContracts = (dbService.getContracts ? dbService.getContracts() : (dbService._localContracts || []))
            .filter(c => c.last_analyzed_at); // リスク解析済みのみ表示

        // Annotate with days remaining
        const annotated = allContracts.map(c => {
            const targetDate = c.expiry_date;
            const days = this._daysUntil(targetDate);
            let range = 'nodate';
            if (days !== null) {
                if (days < 0) range = 'past';
                else if (days <= 7) range = 'urgent';
                else if (days <= 30) range = 'warning';
                else range = 'upcoming';
            }
            return { ...c, _daysRemaining: days, _range: range };
        });

        // Filter by search query
        const searched = query
            ? annotated.filter(c =>
                (c.name || '').toLowerCase().includes(query) ||
                (c.contract_category || '').toLowerCase().includes(query) ||
                (c.type || '').toLowerCase().includes(query)
              )
            : annotated;

        // Filter by range tab
        const filtered = filterRange === 'all'
            ? searched.filter(c => c._range !== 'past')
            : searched.filter(c => c._range === filterRange);

        // Sort
        const sorted = [...filtered].sort((a, b) => {
            let va, vb;
            if (sortKey === 'analyzed') {
                va = a.last_analyzed_at || '0';
                vb = b.last_analyzed_at || '0';
            } else if (sortKey === 'days') {
                va = a._daysRemaining ?? 99999;
                vb = b._daysRemaining ?? 99999;
            } else if (sortKey === 'name') {
                va = (a.name || '').toLowerCase();
                vb = (b.name || '').toLowerCase();
            } else if (sortKey === 'date') {
                va = a.expiry_date || '9999';
                vb = b.expiry_date || '9999';
            }
            if (va < vb) return sortDir === 'asc' ? -1 : 1;
            if (va > vb) return sortDir === 'asc' ? 1 : -1;
            return 0;
        });

        // Counts for tab badges
        const counts = {
            all: annotated.filter(c => c._range !== 'past').length,
            urgent: annotated.filter(c => c._range === 'urgent').length,
            warning: annotated.filter(c => c._range === 'warning').length,
            upcoming: annotated.filter(c => c._range === 'upcoming').length,
            nodate: annotated.filter(c => c._range === 'nodate').length,
        };

        const sortBtn = (key, label, extraStyle = '') => {
            const active = sortKey === key;
            const nextDir = active && sortDir === 'asc' ? 'desc' : 'asc';
            const arrow = active ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '';
            return `<th style="padding:10px 12px;text-align:left;font-size:12px;color:${active ? '#c5a059' : '#8a7a6a'};font-weight:600;cursor:pointer;white-space:nowrap;${extraStyle}"
                onclick="window.app.navigate('deadlines', {query:'${query}',filterRange:'${filterRange}',sortKey:'${key}',sortDir:'${nextDir}'})">${label}${arrow}</th>`;
        };

        const rows = sorted.map(c => {
            const days = c._daysRemaining;
            const noDate = c._range === 'nodate';
            const badgeColor = days === null ? '#aaa' : days <= 7 ? '#e53935' : days <= 30 ? '#f57c00' : '#2e7d32';
            const daysLabel = days === null ? '未設定' : days === 0 ? '本日' : days < 0 ? '期限切れ' : `あと ${days} 日`;
            const targetDate = c.expiry_date;
            const notifyEnabled = c.deadline_notify !== false;
            const notifyToggle = `<label class="toggle-switch" style="flex-shrink:0;" onclick="event.stopPropagation()">
                <input type="checkbox" ${notifyEnabled ? 'checked' : ''} onchange="window.app.toggleDeadlineNotify('${c.id}', this.checked)">
                <span class="toggle-slider"></span>
            </label>`;
            const categoryBadge = c.contract_category
                ? `<span style="font-size:11px;background:#f0ede8;color:#7a6a5a;border-radius:4px;padding:2px 7px;">${escapeHtmlText(c.contract_category)}</span>`
                : '';
            const daysBadge = noDate
                ? `<div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center">
                    <button onclick="event.stopPropagation();window.app.showDeadlineInputModal('${c.id}')"
                        style="background:#fff;border:1.5px dashed #c5a059;color:#c5a059;border-radius:20px;padding:3px 0;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;width:90px;text-align:center;">
                        <i class="fa-solid fa-plus" style="margin-right:4px;font-size:10px;"></i>期限を入力
                    </button>
                    <button id="btn-deadline-reanalyze-${c.id}" onclick="event.stopPropagation();window.app.runDeadlineReanalyze('${c.id}')"
                        style="background:#fff;border:1.5px dashed #aaa;color:#666;border-radius:20px;padding:3px 0;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;width:90px;text-align:center;">
                        <i class="fa-solid fa-rotate" style="margin-right:4px;font-size:10px;"></i>再解析
                    </button>
                  </div>`
                : `<span style="display:inline-block;background:${badgeColor};color:#fff;border-radius:20px;padding:3px 12px;font-size:12px;font-weight:700;">${daysLabel}</span>`;
            const rowClick = `onclick="window.app.showDeadlineInputModal('${c.id}')"`;
            return `<tr style="cursor:pointer;" ${rowClick}>
                <td><div style="font-weight:600;color:#2b2623;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtmlText(c.name) || '—'}</div>${categoryBadge ? `<div style="margin-top:4px;">${categoryBadge}</div>` : ''}</td>
                <td style="font-size:13px;color:#5e544d;white-space:nowrap;width:130px;">${targetDate ? this._formatDateJa(targetDate) : '—'}</td>
                <td style="white-space:nowrap;width:140px;">${daysBadge}</td>
                <td style="white-space:nowrap;width:90px;">${notifyToggle}</td>
            </tr>`;
        }).join('');

        const tabBtn = (range, label, icon) => {
            const active = filterRange === range;
            const count = counts[range];
            return `<button onclick="window.app.navigate('deadlines', {query:'${query}',filterRange:'${range}',sortKey:'${sortKey}',sortDir:'${sortDir}'})"
                style="padding:7px 14px;border:1px solid ${active ? '#c5a059' : '#ddd'};border-radius:6px;background:${active ? '#c5a059' : '#fff'};color:${active ? '#fff' : '#5e544d'};font-size:13px;font-weight:${active ? '700' : '400'};cursor:pointer;display:flex;align-items:center;gap:6px;">
                ${icon} ${label}${count > 0 ? ` <span style="background:${active ? 'rgba(255,255,255,0.3)' : '#f0ede8'};color:${active ? '#fff' : '#7a6a5a'};border-radius:10px;padding:1px 7px;font-size:11px;">${count}</span>` : ''}
            </button>`;
        };

        const pageHtml = `
        <div class="flex justify-between items-center mb-md">
            <h2 class="page-title" style="margin-bottom:0;">期限・アラート管理</h2>
        </div>

        <div class="filter-bar mb-md">
            <div class="flex flex-wrap gap-md items-center">
                <div style="position:relative;flex:1;min-width:240px;">
                    <i class="fa-solid fa-magnifying-glass" style="position:absolute;left:12px;top:50%;transform:translateY(-50%);color:#999;"></i>
                    <input type="text" placeholder="契約名・種別で検索..."
                        value="${query}"
                        style="padding:8px 12px 8px 36px;border:1px solid #ddd;border-radius:4px;width:100%;font-size:13px;box-sizing:border-box;"
                        oninput="window.app.navigate('deadlines', {query:this.value,filterRange:'${filterRange}',sortKey:'${sortKey}',sortDir:'${sortDir}'})">
                </div>
                <div class="flex gap-sm items-center flex-wrap">
                    ${tabBtn('all', 'すべて', '')}
                    ${tabBtn('urgent', '7日以内', '')}
                    ${tabBtn('warning', '30日以内', '')}
                    ${tabBtn('upcoming', '90日以内', '')}
                    ${tabBtn('nodate', '期限未設定', '')}
                </div>
            </div>
        </div>

        <div class="table-container">
            <table class="data-table deadlines-table" style="table-layout:fixed;width:100%;">
                <thead>
                    <tr>
                        ${sortBtn('name', '契約名')}
                        ${sortBtn('date', '期限日', 'white-space:nowrap;width:130px;')}
                        ${sortBtn('days', '残り日数', 'white-space:nowrap;width:140px;')}
                        <th style="padding:10px 12px;text-align:left;font-size:12px;color:#8a7a6a;font-weight:600;white-space:nowrap;width:90px;">通知</th>
                    </tr>
                </thead>
                <tbody>
                    ${sorted.length > 0 ? rows : `<tr><td colspan="4" class="text-center text-muted" style="padding:40px;">該当する契約が見つかりませんでした</td></tr>`}
                </tbody>
            </table>
        </div>
        <div class="text-muted" style="font-size:13px;margin-top:12px;">全 ${counts.all} 件中 ${sorted.length} 件を表示
            ${counts.nodate > 0 ? `<span style="margin-left:16px;"><i class="fa-solid fa-circle-info" style="color:#c5a059;margin-right:4px;"></i>期限未設定 ${counts.nodate} 件：契約書を解析するとAIが自動で期限を抽出します。失敗した解析回数は消耗しません。</span>` : ''}
        </div>`;

        const lockOverlay = deadlineLocked ? `<div style="position:fixed;top:0;right:0;bottom:0;left:240px;display:flex;align-items:center;justify-content:center;background:rgba(245,247,250,0.85);backdrop-filter:blur(3px);z-index:1000;"><div style="background:#fff;border-radius:12px;padding:32px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,0.13);max-width:300px;width:90%;"><i class="fa-solid fa-crown" style="color:#c19b4a;font-size:2rem;margin-bottom:12px;display:block;"></i><div style="display:inline-block;background:#f3f0ea;color:#c5a059;border:1px solid #e8d9b8;border-radius:10px;padding:3px 12px;font-size:11px;font-weight:700;margin-bottom:12px;">Business / Proプラン限定</div><div style="font-weight:700;font-size:15px;margin-bottom:8px;color:#2b2623;">期限・アラート管理</div><p style="font-size:12px;color:#888;line-height:1.6;margin-bottom:20px;">契約期限の自動抽出・アラート通知はBusinessプラン以上でご利用いただけます。</p><button onclick="window.app.navigate('plan')" style="width:100%;padding:10px;border:none;border-radius:8px;background:#c5a059;color:#fff;font-size:13px;font-weight:700;cursor:pointer;">アップグレードする</button></div></div>` : '';

        return `<div style="position:relative;">${pageHtml}${lockOverlay}</div>`;
    }

    ensureDiffLibrary() {
        return loadExternalScriptOnce(
            'https://cdnjs.cloudflare.com/ajax/libs/jsdiff/5.1.0/diff.min.js',
            () => typeof window.Diff !== 'undefined'
        );
    }

    async ensurePdfLibraries() {
        await Promise.all([
            loadExternalScriptOnce(
                'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
                () => typeof window.jspdf !== 'undefined'
            ),
            loadExternalScriptOnce(
                'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
                () => typeof window.html2canvas !== 'undefined'
            )
        ]);
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

    updateRegistrationButtonVisibility(viewId = this.currentView) {
        const regBtn = document.getElementById('open-registration-btn');
        if (!regBtn) return;
        const canShowOnView = viewId === 'dashboard' || viewId === 'contracts';
        regBtn.style.display = (this.can('operate_contract') && canShowOnView) ? 'inline-flex' : 'none';
    }

    updateActiveMenu(viewId = this.currentView) {
        const groupedViewId = ['sign', 'sign-editor', 'sign-recipient', 'sign-viewer'].includes(viewId)
            ? 'sign'
            : viewId === 'diff' ? 'contracts' : viewId;
        const navItems = document.querySelectorAll('.nav-item');
        navItems.forEach((item) => item.classList.remove('active'));
        navItems.forEach((item) => {
            const onclick = item.getAttribute('onclick') || '';
            if (onclick.includes(`navigate('${groupedViewId}')`)) {
                item.classList.add('active');
            }
        });

        document.querySelectorAll('.mobile-bottom-nav .bottom-nav-item').forEach((item) => {
            const targetView = item.getAttribute('data-mobile-view');
            item.classList.toggle('active', targetView === groupedViewId);
        });
    }

    toggleMobileMenu(forceOpen = null) {
        const panel = document.getElementById('mobile-menu-panel');
        if (!panel) return;

        const shouldOpen = typeof forceOpen === 'boolean'
            ? forceOpen
            : !panel.classList.contains('is-open');

        panel.classList.toggle('is-open', shouldOpen);
        document.querySelectorAll('.mobile-menu-button, #bnav-menu').forEach((button) => {
            button.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
        });
    }

    closeMobileMenu() {
        this.toggleMobileMenu(false);
    }

    syncContractsInBackground(onSynced) {
        if (!this.contractSyncPromise) {
            this.contractSyncPromise = dbService.syncContractsFromApi()
                .catch((error) => {
                    console.warn('Background contract sync failed:', error);
                    return null;
                })
                .finally(() => {
                    this.contractSyncPromise = null;
                });
        }

        this.contractSyncPromise.then((contracts) => {
            if (contracts) onSynced?.(contracts);
        });
    }

    async init() {
        try {
            console.log('Dashboard App Initializing...');
            const initStartMs = performance.now();
            if ('scrollRestoration' in window.history) {
                window.history.scrollRestoration = 'manual';
            }
            this.renderInitialSkeleton('dashboard');
            const planNav = document.getElementById('nav-plan');
            if (planNav) planNav.style.display = '';

            // Get current user UID first for data isolation.
            // On localhost with local API, skip Firebase auth. With prodApi=1, require real auth.
            try {
                if (!shouldUseLocalDevAuthBypass()) {
                    const { auth } = await import('./firebase-config.js');
                    const { onAuthStateChanged } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js');
                    const user = auth.currentUser;
                    if (user) {
                        dbService.setCurrentUser(user.uid);
                    } else {
                        // Wait for auth state
                        await new Promise((resolve) => {
                            const unsubscribe = onAuthStateChanged(auth, (u) => {
                                unsubscribe();
                                if (u) dbService.setCurrentUser(u.uid);
                                resolve();
                            });
                        });
                    }
                }
            } catch (e) {
                console.warn('Could not get UID for data isolation:', e);
            }

            dbService.init();
            this.bindEvents();
            this.registration.init();

            // UIを初期想定（Pro）で更新
            this.updateSubscriptionUI();

            const urlParams = new URLSearchParams(window.location.search);
            const shouldStartPayment = urlParams.get('start_payment') === '1';
            const paymentPlan = urlParams.get('plan');
            const paymentBilling = urlParams.get('billing');
            // Critical UI first: route immediately, data bootstrap in background
            const hash = window.location.hash;
            if (hash && hash.startsWith('#diff/')) {
                const contractId = parseInt(hash.replace('#diff/', ''), 10);
                if (!isNaN(contractId)) {
                    this.navigate('diff', contractId);
                } else {
                    this.navigate('dashboard');
                }
            } else if (shouldStartPayment) {
                this.navigate('plan');
            } else {
                this.navigate('dashboard');
            }
            const firstUiMs = Math.round(performance.now() - initStartMs);
            console.log(`[perf] initial UI rendered in ${firstUiMs}ms`);

            const bootstrapPromise = this.checkAndRegisterAdmin()
                .then(async () => {
                    this.bootstrapCompleted = true;
                    await this.reloadPlanData({ silent: true });
                })
                .catch((error) => {
                    console.error('Bootstrap initialization failed:', error);
                });

            // 無料期間終了後の決済開始フロー
            if (shouldStartPayment) {
                this.forceSubscriptionPayment = fromTrialExpired;
                await bootstrapPromise;
                await this.startSubscriptionCheckout(
                    paymentPlan || this.subscription?.plan || 'starter',
                    paymentBilling || this.subscription?.billingCycle || 'monthly',
                    fromTrialExpired
                );

                history.replaceState(null, '', window.location.pathname);
                console.log('Redirected to payment flow from select-plan');
                return;
            }

            bootstrapPromise.finally(() => {
                const fullLoadMs = Math.round(performance.now() - initStartMs);
                console.log(`[perf] dashboard bootstrap completed in ${fullLoadMs}ms`);
            });
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

                // Fetch role and team info from backend (Firestore-backed, reliable)
                let ownerUid = user.uid; // Default: own data
                this.isTeamMember = false;
                try {
                    const roleRes = await fetch(`${aiService.API_BASE}/user/role`, {
                        headers: { 'Authorization': `Bearer ${token}` }
                    });
                    if (roleRes.ok) {
                        const roleData = await roleRes.json();
                        if (roleData.success) {
                            this.userRole = roleData.data.role;
                            this.isTeamMember = roleData.data.isTeamMember || false;
                            if (roleData.data.ownerUid) {
                                ownerUid = roleData.data.ownerUid;
                            }
                            console.log('User role from backend:', this.userRole, 'ownerUid:', ownerUid, 'isTeamMember:', this.isTeamMember);
                        }
                    }
                } catch (roleErr) {
                    console.warn('Could not fetch role from backend, defaulting to 管理者:', roleErr);
                    // API失敗時はオーナー（管理者）としてデフォルト動作（バックエンドと同じロジック）
                    this.userRole = '管理者';
                    this.isTeamMember = false;
                }

                // If team member, switch data scope to owner's UID
                if (this.isTeamMember && ownerUid !== user.uid) {
                    console.log('Switching data scope to owner UID:', ownerUid);
                    dbService.setCurrentUser(ownerUid);
                }

                // Register user in local localStorage if not present
                const users = dbService.getUsers();
                const matchedUser = users.find(u => u.email === user.email);
                if (!matchedUser) {
                    const displayName = user.displayName || user.email.split('@')[0];
                    dbService.addUser(displayName, user.email, this.userRole);
                } else if (matchedUser.role !== this.userRole) {
                    // Sync local role with backend
                    dbService.updateUserRole(user.email, this.userRole);
                }


                this.setCachedItem(DASHBOARD_CACHE_KEYS.USER_META, {
                    role: this.userRole,
                    isTeamMember: this.isTeamMember,
                    ownerUid,
                    email: user.email,
                    name: user.displayName || user.email.split('@')[0]
                });

                const emailEl = document.getElementById('user-email-display');
                if (emailEl) emailEl.textContent = user.email || '';
                const nameEl = document.getElementById('user-name-display');
                if (nameEl) nameEl.textContent = user.displayName || user.email?.split('@')[0] || 'ユーザー';

                // Fetch real subscription status from backend (parallel)
                await Promise.all([
                    this.fetchSubscriptionStatus(token),
                    this.fetchPaymentStatus(token),
                    this.fetchPaymentConfig()
                ]);

                // Check if user just selected a plan from signup flow
                const selectedPlan = localStorage.getItem('diffsense_selected_plan');
                const selectedBillingCycle = localStorage.getItem('diffsense_selected_billing_cycle') || 'monthly';
                const signupFlowFlag = localStorage.getItem('diffsense_signup_flow') === '1';

                if (selectedPlan && signupFlowFlag) {
                    // Guard: Don't overwrite paid plan with free/starter if user already has a paid plan
                    const currentPlan = (this.subscription?.plan || 'free').toLowerCase();
                    const isDowngradeToFree = (selectedPlan === 'free' && currentPlan !== 'free' && currentPlan !== 'starter');
                    
                    if (isDowngradeToFree) {
                        console.log('Signup flow detected for existing paid user - skipping plan overwrite');
                    } else {
                        await this.registerSelectedPlan(token, selectedPlan, selectedBillingCycle);
                    }
                    
                    localStorage.removeItem('diffsense_selected_plan');
                    localStorage.removeItem('diffsense_selected_billing_cycle');
                    localStorage.removeItem('diffsense_signup_flow');
                }

                const urlParams = new URLSearchParams(window.location.search);
                const paymentState = urlParams.get('payment');

                // PayPal遷移戻りの確定処理
                if (paymentState === 'success') {
                    const returnedPlan = urlParams.get('plan') || this.subscription?.plan || 'starter';
                    const returnedBillingCycle = urlParams.get('billing') || this.subscription?.billingCycle || 'monthly';
                    const returnedSubscriptionId =
                        urlParams.get('subscription_id') ||
                        urlParams.get('ba_token') ||
                        urlParams.get('token');

                    if (returnedSubscriptionId) {
                        const confirmed = await this.confirmPayPalSubscription(
                            returnedSubscriptionId,
                            returnedPlan,
                            returnedBillingCycle,
                            { redirectOnSuccess: true }
                        );
                        if (confirmed) return;
                    } else if (this.paymentStatus?.hasPaymentMethod) {
                        window.location.replace(`${window.location.origin}/thanks-payment.html?plan=${returnedPlan}&billing=${returnedBillingCycle}`);
                        return;
                    }
                }

                if (paymentState === 'stripe_success') {
                    const returnedPlan = urlParams.get('plan') || this.subscription?.plan || 'starter';
                    const returnedBillingCycle = urlParams.get('billing') || this.subscription?.billingCycle || 'monthly';
                    const sessionId = urlParams.get('session_id');
                    if (sessionId) {
                        const confirmed = await this.confirmStripeSession(sessionId, returnedPlan, returnedBillingCycle, { redirectOnSuccess: true });
                        if (confirmed) return;
                    }
                }

                this.checkTrialExpired();

                // Clean payment URL params
                if (paymentState) {
                    history.replaceState(null, '', window.location.pathname);
                }

                console.log('Current User Role:', this.userRole);

                // Show Plan menu for all users, Team menu only for admins
                const planNav = document.getElementById('nav-plan');
                if (planNav) planNav.style.display = '';

                if (this.can('manage_team')) {
                    const teamNav = document.getElementById('nav-team');
                    if (teamNav) teamNav.style.display = '';
                }

                this.updateRegistrationButtonVisibility(this.currentView);

                // Show role badge in header for team members
                if (this.isTeamMember) {
                    const roleBadge = document.getElementById('user-role-badge');
                    if (roleBadge) {
                        const roleColors = {
                            '管理者': '#4CAF50',
                            '作業者': '#2196F3',
                            '閲覧のみ': '#FF9800'
                        };
                        roleBadge.textContent = this.userRole;
                        roleBadge.style.cssText = `display:inline-block; background:${roleColors[this.userRole] || '#999'}; color:#fff; padding:2px 10px; border-radius:12px; font-size:11px; font-weight:600; margin-left:8px;`;
                    }
                }
            }
        } catch (e) {
            console.error('Admin Check Error:', e);
        }
    }

    async registerSelectedPlan(token, plan, billingCycle = 'monthly') {
        const selectedBillingCycle = billingCycle === 'annual' ? 'annual' : 'monthly';
        try {
            const apiUrl = `${aiService.API_BASE}/user/select-plan`;

            await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ plan, billingCycle: selectedBillingCycle })
            });
            console.log('Selected plan registered:', plan, selectedBillingCycle);
        } catch (error) {
            console.error('Failed to register selected plan:', error);
        }
    }

    async reloadPlanData(options = {}) {
        const silent = options.silent === true;
        try {
            const authModule = await import('./auth.js');
            const token = await authModule.getIdToken();
            const isLocalDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
            
            if (!token && !isLocalDev) {
                if (!silent) Notify.warning('ログイン状態を確認できませんでした。');
                return false;
            }

            await Promise.all([
                this.fetchSubscriptionStatus(token),
                this.fetchPaymentStatus(token),
                this.fetchPaymentConfig()
            ]);

            if (this.currentView === 'plan') {
                this.navigate('plan');
            }
            return true;
        } catch (error) {
            console.error('reloadPlanData error:', error);
            if (!silent) Notify.error('利用状況の再取得に失敗しました。');
            return false;
        }
    }

    async refreshSubscriptionStatusSafe() {
        try {
            const authModule = await import('./auth.js');
            const token = await authModule.getIdToken();
            if (token) {
                await this.fetchSubscriptionStatus(token);
            }
        } catch (error) {
            console.warn('Failed to refresh subscription:', error);
        }
    }

    async fetchSubscriptionStatus(token) {
        // forcePlan指定時はAPIフェッチをスキップし、強制プランを再適用（ローカル環境のみ有効）
        const _isLocalEnv = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
        const forcedPlan = _isLocalEnv ? new URLSearchParams(window.location.search).get('forcePlan') : null;
        if (forcedPlan) {
            const forcedPlanMap = {
                free:     { plan: 'free',     billingCycle: 'monthly', usageCount: 0, usageLimit: 999999, daysRemaining: null, planLimit: 999999, signUsageLimit: 999999 },
                starter:  { plan: 'starter',  billingCycle: 'monthly', usageCount: 0, usageLimit: 999999, daysRemaining: null, planLimit: 999999, signUsageLimit: 999999 },
                business: { plan: 'business', billingCycle: 'monthly', usageCount: 0, usageLimit: 999999, daysRemaining: null, planLimit: 999999, signUsageLimit: 999999 },
                pro:      { plan: 'pro',      billingCycle: 'monthly', usageCount: 0, usageLimit: 999999, daysRemaining: null, planLimit: 999999, signUsageLimit: 999999 },
            };
            if (forcedPlanMap[forcedPlan]) {
                this.subscription = forcedPlanMap[forcedPlan];
                this.userPlan = forcedPlan;
                this.updateSubscriptionUI();
            }
            return;
        }
        try {
            const apiUrl = `${aiService.API_BASE}/user/subscription`;

            const response = await fetch(apiUrl, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });
            const result = await response.json();

            if (result.success) {
                this.subscription = {
                    ...result.data,
                    billingCycle: result.data?.billingCycle === 'annual' ? 'annual' : 'monthly'
                };
                this.userPlan = result.data.plan;
                this.setCachedItem(DASHBOARD_CACHE_KEYS.SUBSCRIPTION, this.subscription);
                if (!this.planViewBillingCycle) {
                    this.planViewBillingCycle = this.subscription.billingCycle;
                }
                this.updateSubscriptionUI();
            }
        } catch (error) {
            console.error('Failed to fetch subscription status:', error);
            // API接続失敗時：freeをデフォルトにする（セキュリティのため有料プランを与えない）
            this.subscription = { plan: 'free', billingCycle: 'monthly', usageCount: 0, usageLimit: 3, daysRemaining: null, planLimit: 1, signUsageLimit: 10 };
            this.userPlan = 'free';
            this.setCachedItem(DASHBOARD_CACHE_KEYS.SUBSCRIPTION, this.subscription);
            if (!this.planViewBillingCycle) {
                this.planViewBillingCycle = 'monthly';
            }
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
                this.setCachedItem(DASHBOARD_CACHE_KEYS.USER_META, {
                    ...(this.getCachedItem(DASHBOARD_CACHE_KEYS.USER_META, 30 * 60 * 1000) || {}),
                    hasPaymentMethod: Boolean(result.data?.hasPaymentMethod)
                });
            }
        } catch (error) {
            console.error('Failed to fetch payment status:', error);
            this.paymentStatus = { hasPaymentMethod: false };
        }
    }

    async fetchPaymentConfig(forceRefresh = false) {
        if (this.paymentConfig && !forceRefresh) {
            return this.paymentConfig;
        }

        const previousConfig = this.paymentConfig;

        try {
            const response = await fetch(`${aiService.API_BASE}/payment/config`);
            const result = await response.json();

            if (result.success && result.data) {
                const config = result.data;
                const planIds = config.planIds || {};
                const monthlyPlanIds = planIds.monthly || {};
                const annualPlanIds = planIds.annual || {};
                const stripeConfig = config.stripe || {};
                const planKeys = ['starter', 'business', 'pro'];
                const stripeEnabled = Boolean(stripeConfig.enabled);

                const monthlyAvailability = {};
                const annualAvailability = {};

                planKeys.forEach((key) => {
                    monthlyAvailability[key] = stripeEnabled
                        ? true
                        : Boolean(monthlyPlanIds[key] || planIds[key]);
                    annualAvailability[key] = stripeEnabled
                        ? true
                        : Boolean(annualPlanIds[key]);
                });

                this.paymentConfig = config;
                this.paymentPlanAvailability = {
                    monthly: monthlyAvailability,
                    annual: annualAvailability
                };
                // Annual is available only when at least one annual plan ID is configured.
                this.hasAnnualBillingPlans = Object.values(annualAvailability).some(Boolean);
                this.stripeEnabled = stripeEnabled;
                this.stripePublishableKey = stripeConfig.publishableKey || '';

                return this.paymentConfig;
            }
        } catch (error) {
            console.error('Failed to fetch payment config:', error);
        }

        if (!previousConfig) {
            this.paymentConfig = null;
            this.paymentPlanAvailability = null;
            this.hasAnnualBillingPlans = null;
            this.stripeEnabled = false;
            this.stripePublishableKey = '';
        }

        return previousConfig || null;
    }

    setPlanBillingCycle(billingCycle = 'monthly') {
        const selectedBillingCycle = billingCycle === 'annual' ? 'annual' : 'monthly';
        if (selectedBillingCycle === 'annual' && this.hasAnnualBillingPlans === false && this.subscription?.billingCycle !== 'annual') {
            Notify.info('年額プランは現在準備中です。');
            return;
        }

        this.planViewBillingCycle = selectedBillingCycle;
        if (this.currentView === 'plan') {
            this.navigate('plan');
        }
    }

    async startSubscriptionCheckout(plan, billingCycle = this.subscription?.billingCycle || 'monthly', forcePayment = this.forceSubscriptionPayment) {
        if (!this.stripeEnabled) {
            Notify.error('Stripe決済の設定が未完了です。環境変数をご確認ください。');
            // 切り戻し用（残置）:
            // await this.startPayPalSubscription(plan, billingCycle, forcePayment);
            return;
        }
        await this.startStripeCheckout(plan, billingCycle, forcePayment);
    }

    showStripeCheckoutModal(plan, billingCycle = this.subscription?.billingCycle || 'monthly', forcePayment = this.forceSubscriptionPayment) {
        const targetPlan = plan || this.subscription?.plan || 'starter';
        const cycle = billingCycle === 'annual' ? 'annual' : 'monthly';
        const existing = document.getElementById('stripe-modal-overlay');
        if (existing) existing.remove();

        const planNames = { starter: 'Starter', business: 'Business', pro: 'Pro' };
        const billingLabel = cycle === 'annual' ? '年額（一括）' : '月額';
        const planPrices = {
            monthly: { starter: '¥1,480 / 月（税込）', business: '¥4,980 / 月（税込）', pro: '¥9,800 / 月（税込）' },
            annual: { starter: '¥14,800 / 年（税込）', business: '¥49,800 / 年（税込）', pro: '¥98,000 / 年（税込）' }
        };

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay active';
        overlay.id = 'stripe-modal-overlay';
        overlay.innerHTML = `
        <div class="modal-content" style="max-width:480px;">
            <div class="modal-header">
                <h3 style="margin:0; font-size:1.1rem;">
                    <i class="fa-solid fa-credit-card" style="margin-right:8px; color:#B8860B;"></i>お支払い方法を登録
                </h3>
                ${forcePayment ? '' : '<button class="btn-close" onclick="document.getElementById(\'stripe-modal-overlay\').remove()">&times;</button>'}
            </div>
            <div class="modal-body" style="padding:24px;">
                <div style="background:#faf8f5; border:1px solid #e8e0d4; border-radius:8px; padding:16px; margin-bottom:16px; text-align:center;">
                    <div style="font-size:0.8rem; color:#888; margin-bottom:4px;">選択プラン</div>
                    <div style="font-size:1.1rem; font-weight:700; color:#24292E;">${planNames[targetPlan] || targetPlan}</div>
                    <div style="font-size:0.8rem; color:#8a6f40; margin-top:4px;">請求サイクル: ${billingLabel}</div>
                    <div style="font-size:1.3rem; font-weight:700; color:#B8860B; margin-top:4px;">${planPrices[cycle]?.[targetPlan] || ''}</div>
                </div>
                <button class="btn-dashboard full-width" style="background:#B8860B; color:#fff; border:none; font-weight:700;" onclick="window.app.startStripeCheckout('${targetPlan}', '${cycle}', ${forcePayment ? 'true' : 'false'})">
                    お支払いを登録する
                </button>
            </div>
        </div>`;
        document.body.appendChild(overlay);
    }

    async startStripeCheckout(plan, billingCycle = this.subscription?.billingCycle || 'monthly', forcePayment = this.forceSubscriptionPayment) {
        const targetPlan = plan || this.subscription?.plan || 'starter';
        const selectedBillingCycle = billingCycle === 'annual' ? 'annual' : 'monthly';
        this.planViewBillingCycle = selectedBillingCycle;
        try {
            const authModule = await import('./auth.js');
            const token = await authModule.getIdToken();
            const isLocalDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
            if (!token && !isLocalDev) {
                Notify.error('ログイン状態を確認できませんでした。再ログインしてください。');
                return;
            }
            const headers = {
                'Content-Type': 'application/json'
            };
            if (token) {
                headers.Authorization = `Bearer ${token}`;
            }
            const stripeModal = document.getElementById('stripe-modal-overlay');
            if (stripeModal) stripeModal.remove();

            const response = await fetch(`${aiService.API_BASE}/api/createCheckoutSession`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    plan: targetPlan,
                    billingCycle: selectedBillingCycle,
                    email: this.currentUser?.email || '',
                    userId: this.currentUser?.uid || ''
                })
            });
            const result = await response.json();
            if (!result.success || !result.data?.url) {
                Notify.error(result.error || 'Stripe決済ページの作成に失敗しました。');
                if (forcePayment) {
                    window.location.replace(`${window.location.origin}/select-plan-preview.html&billing=${selectedBillingCycle}`);
                }
                return;
            }
            sessionStorage.setItem('stripe_checkout_started', 'true');
            window.location.href = result.data.url;
        } catch (error) {
            console.error('Stripe checkout error:', error);
            Notify.error('Stripe決済の開始に失敗しました。');
            if (forcePayment) {
                window.location.replace(`${window.location.origin}/select-plan-preview.html&billing=${selectedBillingCycle}`);
            }
        }
    }

    async confirmStripeSession(sessionId, plan, billingCycle = 'monthly', options = {}) {
        const redirectOnSuccess = options.redirectOnSuccess !== false;
        const selectedBillingCycle = billingCycle === 'annual' ? 'annual' : 'monthly';
        try {
            const authModule = await import('./auth.js');
            const token = await authModule.getIdToken();
            const isLocalDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
            if (!token && !isLocalDev) {
                Notify.error('ログイン状態を確認できませんでした。再ログインしてください。');
                return false;
            }
            const headers = {
                'Content-Type': 'application/json'
            };
            if (token) {
                headers.Authorization = `Bearer ${token}`;
            }
            const response = await fetch(`${aiService.API_BASE}/payment/confirm-stripe-session`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ sessionId, plan, billingCycle: selectedBillingCycle })
            });
            const result = await response.json();
            if (result.success) {
                this.forceSubscriptionPayment = false;

                await this.fetchSubscriptionStatus(token);
                await this.fetchPaymentStatus(token);
                if (redirectOnSuccess) {
                    const confirmedPlan = result.data.plan || plan || this.subscription?.plan || 'starter';
                    const confirmedBillingCycle = result.data.billingCycle || selectedBillingCycle;
                    window.location.replace(`${window.location.origin}/thanks-payment.html?plan=${confirmedPlan}&billing=${confirmedBillingCycle}`);
                }
                return true;
            }
            Notify.error(result.error || 'Stripe決済の確定に失敗しました。');
        } catch (error) {
            console.error('Confirm Stripe session error:', error);
            Notify.error('Stripe決済の確定処理でエラーが発生しました。');
        }
        return false;
    }

    async startPayPalSubscription(plan, billingCycle = this.subscription?.billingCycle || 'monthly', forcePayment = this.forceSubscriptionPayment) {
        const targetPlan = plan || this.subscription?.plan || 'starter';
        const selectedBillingCycle = billingCycle === 'annual' ? 'annual' : 'monthly';
        this.planViewBillingCycle = selectedBillingCycle;
        try {
            const config = await this.fetchPaymentConfig(true);
            if (!config) {
                Notify.error('PayPal設定の取得に失敗しました。');
                if (forcePayment) {
                    window.location.replace(`${window.location.origin}/select-plan-preview.html`);
                }
                return;
            }
            const { clientId, planIds } = config;
            const paypalPlanId = planIds?.[selectedBillingCycle]?.[targetPlan] || planIds?.[targetPlan];
            if (!paypalPlanId) {
                Notify.error(selectedBillingCycle === 'annual' ? '年額プランは現在準備中です。' : 'プランIDが見つかりません。');
                if (forcePayment) {
                    window.location.replace(`${window.location.origin}/select-plan-preview.html&billing=${selectedBillingCycle}`);
                }
                return;
            }

            // If user has existing active subscription and is changing plan/cycle, cancel old one first
            const currentCycle = this.subscription?.billingCycle || 'monthly';
            if (this.paymentStatus?.hasPaymentMethod && (this.subscription?.plan !== targetPlan || currentCycle !== selectedBillingCycle)) {
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
            this.showPayPalModal(targetPlan, selectedBillingCycle, forcePayment);

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
                    label: 'pay'
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
                    this.forceSubscriptionPayment = false;
    

                    // Confirm with backend
                    await this.confirmPayPalSubscription(data.subscriptionID, targetPlan, selectedBillingCycle);
                },
                onCancel: () => {
                    console.log('User cancelled PayPal subscription');
                    if (forcePayment) {
                        Notify.warning('継続利用にはお支払い方法の登録が必要です。');
                        return;
                    }
                    const modal = document.getElementById('paypal-modal-overlay');
                    if (modal) modal.remove();
                    Notify.info('お支払いがキャンセルされました。');
                },
                onError: (err) => {
                    console.error('PayPal Buttons error:', err);
                    if (forcePayment) {
                        Notify.error('お支払い処理でエラーが発生しました。再度お試しください。');
                        return;
                    }
                    const modal = document.getElementById('paypal-modal-overlay');
                    if (modal) modal.remove();
                    Notify.error('お支払い処理でエラーが発生しました。');
                }
            }).render('#paypal-button-container');

        } catch (error) {
            console.error('PayPal subscription error:', error);
            Notify.error('お支払い処理でエラーが発生しました。');
            if (forcePayment) {
                window.location.replace(`${window.location.origin}/select-plan-preview.html&billing=${selectedBillingCycle}`);
            }
        }
    }

    showPayPalModal(plan, billingCycle = 'monthly', forcePayment = this.forceSubscriptionPayment) {
        // Remove existing modal if any
        const existing = document.getElementById('paypal-modal-overlay');
        if (existing) existing.remove();

        const planNames = { starter: 'Starter', business: 'Business', pro: 'Pro' };
        const cycle = billingCycle === 'annual' ? 'annual' : 'monthly';
        const billingLabel = cycle === 'annual' ? '年額（一括）' : '月額';
        const planPrices = {
            monthly: { starter: '¥1,480 / 月（税込）', business: '¥4,980 / 月（税込）', pro: '¥9,800 / 月（税込）' },
            annual: { starter: '¥14,800 / 年（税込）', business: '¥49,800 / 年（税込）', pro: '¥98,000 / 年（税込）' }
        };

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay active';
        overlay.id = 'paypal-modal-overlay';
        overlay.innerHTML = `
        <div class="modal-content" style="max-width:480px;">
            <div class="modal-header">
                <h3 style="margin:0; font-size:1.1rem;">
                    <i class="fa-solid fa-credit-card" style="margin-right:8px; color:#c19b4a;"></i>お支払い方法を登録
                </h3>
                ${forcePayment ? '' : '<button class="btn-close" onclick="document.getElementById(\'paypal-modal-overlay\').remove()">&times;</button>'}
            </div>
            <div class="modal-body" style="padding:24px;">
                <div style="background:#faf8f5; border:1px solid #e8e0d4; border-radius:8px; padding:16px; margin-bottom:20px; text-align:center;">
                    <div style="font-size:0.8rem; color:#888; margin-bottom:4px;">選択プラン</div>
                    <div style="font-size:1.1rem; font-weight:700; color:#24292E;">${planNames[plan] || plan}</div>
                    <div style="font-size:0.8rem; color:#8a6f40; margin-top:4px;">請求サイクル: ${billingLabel}</div>
                    <div style="font-size:1.3rem; font-weight:700; color:#c19b4a; margin-top:4px;">${planPrices[cycle]?.[plan] || ''}</div>
                </div>
                <p style="font-size:0.82rem; color:#666; margin-bottom:16px; text-align:center;">
                    クレジットカード/デビットカードで決済できます。
                </p>
                <div id="paypal-button-container" style="min-height:150px; display:flex; align-items:center; justify-content:center;">
                    <div style="color:#999; font-size:0.85rem;"><i class="fa-solid fa-spinner fa-spin" style="margin-right:8px;"></i>決済ボタンを読み込み中...</div>
                </div>
                ${forcePayment ? `
                        <div style="margin-top:12px;">
                            <button onclick="window.location.replace('${window.location.origin}/index.html')" class="btn-dashboard full-width" style="background:#fff; color:#333; border:1px solid #ddd;">
                                TOPへ戻る
                            </button>
                        </div>
                    ` : ''}
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

    async confirmPayPalSubscription(subscriptionId, plan, billingCycle = 'monthly', options = {}) {
        const redirectOnSuccess = options.redirectOnSuccess !== false;
        const selectedBillingCycle = billingCycle === 'annual' ? 'annual' : 'monthly';
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
                body: JSON.stringify({ subscriptionId, plan, billingCycle: selectedBillingCycle })
            });
            const result = await response.json();

            if (result.success) {
                const confirmedPlan = result.data.plan || plan || this.subscription?.plan || 'starter';
                const confirmedBillingCycle = result.data.billingCycle || selectedBillingCycle;
                // Redirect to thanks page for GA conversion tracking
                if (redirectOnSuccess) {
                    window.location.replace(`${window.location.origin}/thanks-payment.html?plan=${confirmedPlan}&billing=${confirmedBillingCycle}`);
                }
                return true;
            }
            return false;
        } catch (error) {
            console.error('Confirm subscription error:', error);
            return false;
        }
    }

    checkTrialExpired() {
        const sub = this.subscription;
        if (!sub) return;
        const urlParams = new URLSearchParams(window.location.search);
        const skipGateForPaymentFlow = urlParams.get('start_payment') === '1';
        if (skipGateForPaymentFlow) return;

        if (this.requiresPaymentRegistration()) {
            this.redirectToPlanSelection('payment_required');
        }
    }

    requiresPaymentRegistration() {
        return false;
    }

    isSignLimitReached() {
        const sub = this.subscription;
        if (!sub) return false;
        // ProプランまたはOwnerなら無制限
        if (sub.plan === 'pro' || sub.plan === 'owner') return false;
        
        const count = Number(sub.signUsageCount || 0);
        const limit = Number(sub.signUsageLimit || 1); // デフォルト1回
        return count >= limit;
    }

    redirectToPlanSelection(reason = 'upgrade') {
        const billing = this.subscription?.billingCycle === 'annual' ? 'annual' : 'monthly';
        window.location.replace(`${window.location.origin}/select-plan-preview.html?billing=${billing}`);
    }

    ensurePaymentAccess(featureLabel = '機能') {
        if (!this.requiresPaymentRegistration()) {
            return true;
        }
        Notify.warning(`${featureLabel}を利用するには、お支払い方法の登録が必要です。プラン選択画面へ移動します。`);
        this.redirectToPlanSelection('upgrade');
        return false;
    }

    renderNotificationSettings(settings, apiBase = '', plan = 'pro') {
        const emailEnabled = settings?.email?.crawlAlert !== false;
        const slack = settings?.slack || {};
        const slackEnabled = slack.enabled === true;
        const slackConnected = Boolean(slack.webhookUrl);
        const channelName = slack.channelName || '';
        const teamName = slack.teamName || '';
        const deadlineEmailEnabled = settings?.email?.deadlineAlert !== false;
        const deadlineSlackEnabled = settings?.slack?.deadlineAlert !== false && slackConnected;
        const crawlerLocked = plan !== 'pro';
        const deadlineLocked = plan === 'free';
        const lockOverlayCrawler = '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(245,247,250,0.82);backdrop-filter:blur(2px);border-radius:8px;z-index:1"><div style="background:#fff;border-radius:10px;padding:24px 32px;text-align:center;box-shadow:0 4px 20px rgba(0,0,0,0.1);max-width:280px"><i class=\'fa-solid fa-crown\' style=\'color:#c19b4a;font-size:1.8rem;margin-bottom:10px;display:block\'></i><div style=\'font-weight:700;font-size:15px;margin-bottom:8px\'>Proプラン限定</div><p style=\'font-size:12px;color:#888;line-height:1.6;margin-bottom:16px\'>クローラー通知はProプランの機能です</p><button class=\'btn-dashboard btn-primary-action\' style=\'width:100%;padding:10px;font-size:13px\' onclick=\'window.app.navigate("plan")\'>アップグレードする</button></div></div>';
        const lockOverlayDeadline = '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(245,247,250,0.82);backdrop-filter:blur(2px);border-radius:8px;z-index:1"><div style="background:#fff;border-radius:10px;padding:24px 32px;text-align:center;box-shadow:0 4px 20px rgba(0,0,0,0.1);max-width:280px"><i class=\'fa-solid fa-crown\' style=\'color:#c19b4a;font-size:1.8rem;margin-bottom:10px;display:block\'></i><div style=\'font-weight:700;font-size:15px;margin-bottom:8px\'>Starterプラン以上限定</div><p style=\'font-size:12px;color:#888;line-height:1.6;margin-bottom:16px\'>期限アラート通知はStarterプラン以上の機能です</p><button class=\'btn-dashboard btn-primary-action\' style=\'width:100%;padding:10px;font-size:13px\' onclick=\'window.app.navigate("plan")\'>アップグレードする</button></div></div>';

        const slackStatus = slackConnected
            ? `<div style="display:flex;align-items:center;gap:8px;margin-top:12px;padding:10px 14px;background:#f0faf4;border:1px solid #b7dfc7;border-radius:6px">
                <i class="fa-brands fa-slack" style="color:#4a154b;font-size:16px"></i>
                <i class="fa-solid fa-circle-check" style="color:#28a745;font-size:13px"></i>
                <span style="font-size:13px;color:#1a6b35;font-weight:500">${channelName}</span>
                <span style="font-size:12px;color:var(--text-muted)">${teamName ? `（${teamName}）` : ''}</span>
                <button onclick="window.app.disconnectSlack()"
                    style="margin-left:auto;font-size:12px;color:var(--text-muted);background:none;border:none;cursor:pointer;padding:2px 8px;border-radius:4px;transition:background .15s"
                    onmouseover="this.style.background='#fee'" onmouseout="this.style.background='none'">
                    連携解除
                </button>
               </div>`
            : '';

        return `
            <div class="plan-section">
                <div style="position:relative">
                <div style="margin-bottom:28px">
                    <h2 class="section-title" style="margin-bottom:6px">クローラー通知設定</h2>
                    <p style="color:var(--text-muted);font-size:13px;margin:0">URLクローリングで変更が検知された際の通知先を設定します</p>
                </div>

                <div style="display:flex;flex-direction:column;gap:12px;max-width:640px">

                    <!-- メール通知 -->
                    <div style="background:var(--bg-surface);border:1px solid var(--border-subtle);border-radius:8px;padding:20px 24px;display:flex;align-items:center;justify-content:space-between;gap:16px">
                        <div style="display:flex;align-items:center;gap:14px">
                            <div style="width:36px;height:36px;border-radius:8px;background:var(--color-primary-dim);display:flex;align-items:center;justify-content:center;flex-shrink:0">
                                <i class="fa-solid fa-envelope" style="color:var(--color-primary);font-size:15px"></i>
                            </div>
                            <div>
                                <div style="font-weight:600;font-size:14px;color:var(--text-main);margin-bottom:2px">メール通知</div>
                                <div style="font-size:12px;color:var(--text-muted)">変更検知時に登録メールアドレスへ通知</div>
                            </div>
                        </div>
                        <label class="toggle-switch" style="flex-shrink:0">
                            <input type="checkbox" id="notif-email-toggle" ${emailEnabled ? 'checked' : ''}
                                onchange="window.app.saveNotificationSettings()">
                            <span class="toggle-slider"></span>
                        </label>
                    </div>

                    <!-- Slack通知 -->
                    <div style="background:var(--bg-surface);border:1px solid var(--border-subtle);border-radius:8px;padding:20px 24px">
                        <div style="display:flex;align-items:center;justify-content:space-between;gap:16px">
                            <div style="display:flex;align-items:center;gap:14px">
                                <div style="width:36px;height:36px;border-radius:8px;background:var(--color-primary-dim);display:flex;align-items:center;justify-content:center;flex-shrink:0">
                                    <i class="fa-brands fa-slack" style="color:var(--color-primary);font-size:16px"></i>
                                </div>
                                <div>
                                    <div style="font-weight:600;font-size:14px;color:var(--text-main);margin-bottom:2px">Slack通知</div>
                                    <div style="font-size:12px;color:var(--text-muted)">変更検知時に指定チャンネルへ通知</div>
                                </div>
                            </div>
                            ${slackConnected
                                ? `<label class="toggle-switch" style="flex-shrink:0">
                                    <input type="checkbox" id="notif-slack-toggle" ${slackEnabled ? 'checked' : ''}
                                        onchange="window.app.saveNotificationSettings()">
                                    <span class="toggle-slider"></span>
                                </label>`
                                : `<button onclick="window.app.connectSlack()"
                                    style="display:inline-flex;align-items:center;gap:7px;padding:8px 16px;background:#4a154b;color:#fff;border-radius:6px;border:none;cursor:pointer;font-size:12px;font-weight:600;flex-shrink:0;transition:opacity .2s"
                                    onmouseover="this.style.opacity='.85'" onmouseout="this.style.opacity='1'">
                                    <i class="fa-brands fa-slack"></i>連携する
                                </button>`}
                        </div>
                        ${slackStatus}
                    </div>

                </div>
                ${crawlerLocked ? lockOverlayCrawler : ''}
                </div>

                <!-- 期限アラート通知 -->
                <div style="position:relative;margin-top:36px">
                <div style="margin-bottom:12px">
                    <h2 class="section-title" style="margin-bottom:6px">期限アラート通知</h2>
                    <p style="color:var(--text-muted);font-size:13px;margin:0">契約の期限（30日前・7日前・当日）に通知します</p>
                </div>

                <div style="display:flex;flex-direction:column;gap:12px;max-width:640px">

                    <!-- 期限アラート: メール -->
                    <div style="background:var(--bg-surface);border:1px solid var(--border-subtle);border-radius:8px;padding:20px 24px;display:flex;align-items:center;justify-content:space-between;gap:16px">
                        <div style="display:flex;align-items:center;gap:14px">
                            <div style="width:36px;height:36px;border-radius:8px;background:var(--color-primary-dim);display:flex;align-items:center;justify-content:center;flex-shrink:0">
                                <i class="fa-solid fa-envelope" style="color:var(--color-primary);font-size:15px"></i>
                            </div>
                            <div>
                                <div style="font-weight:600;font-size:14px;color:var(--text-main);margin-bottom:2px">メール通知（期限アラート）</div>
                                <div style="font-size:12px;color:var(--text-muted)">契約期限の30日前・7日前・当日に登録メールへ送信</div>
                            </div>
                        </div>
                        <label class="toggle-switch" style="flex-shrink:0">
                            <input type="checkbox" id="notif-deadline-email-toggle" ${deadlineEmailEnabled ? 'checked' : ''}
                                onchange="window.app.saveNotificationSettings()">
                            <span class="toggle-slider"></span>
                        </label>
                    </div>

                    <!-- 期限アラート: Slack -->
                    <div style="background:var(--bg-surface);border:1px solid var(--border-subtle);border-radius:8px;padding:20px 24px">
                        <div style="display:flex;align-items:center;justify-content:space-between;gap:16px">
                            <div style="display:flex;align-items:center;gap:14px">
                                <div style="width:36px;height:36px;border-radius:8px;background:var(--color-primary-dim);display:flex;align-items:center;justify-content:center;flex-shrink:0">
                                    <i class="fa-brands fa-slack" style="color:var(--color-primary);font-size:16px"></i>
                                </div>
                                <div>
                                    <div style="font-weight:600;font-size:14px;color:var(--text-main);margin-bottom:2px">Slack通知（期限アラート）</div>
                                    <div style="font-size:12px;color:var(--text-muted)">${slackConnected ? `連携済チャンネル（${channelName}）へ期限アラートを送信` : '期限アラートをSlackへ通知します'}</div>
                                </div>
                            </div>
                            ${slackConnected
                                ? `<label class="toggle-switch" style="flex-shrink:0">
                                    <input type="checkbox" id="notif-deadline-slack-toggle" ${deadlineSlackEnabled ? 'checked' : ''}
                                        onchange="window.app.saveNotificationSettings()">
                                    <span class="toggle-slider"></span>
                                </label>`
                                : `<button onclick="window.app.connectSlack()"
                                    style="display:inline-flex;align-items:center;gap:7px;padding:8px 16px;background:#4a154b;color:#fff;border-radius:6px;border:none;cursor:pointer;font-size:12px;font-weight:600;flex-shrink:0;transition:opacity .2s"
                                    onmouseover="this.style.opacity='.85'" onmouseout="this.style.opacity='1'">
                                    <i class="fa-brands fa-slack"></i>連携する
                                </button>`}
                        </div>
                        ${slackConnected ? '' : ''}
                    </div>

                </div>
                ${deadlineLocked ? lockOverlayDeadline : ''}
                </div>
            </div>
        `;
    }

    async saveNotificationSettings() {
        const emailToggle = document.getElementById('notif-email-toggle');
        const slackToggle = document.getElementById('notif-slack-toggle');

        const deadlineEmailToggle = document.getElementById('notif-deadline-email-toggle');
        const deadlineSlackToggle = document.getElementById('notif-deadline-slack-toggle');

        const settings = {
            email: {
                crawlAlert: emailToggle?.checked !== false,
                deadlineAlert: deadlineEmailToggle?.checked !== false,
            },
            slack: {
                enabled: slackToggle?.checked === true,
                deadlineAlert: deadlineSlackToggle?.checked === true,
            }
        };

        try {
            const authModule = await import('./auth.js');
            const token = await authModule.getIdToken();
            if (!token) return; // ローカル環境ではサイレントにスキップ

            const apiBase = (await import('./api-base.js')).getApiBaseUrl();
            const res = await fetch(`${apiBase}/api/notifications/settings`, {
                method: 'PATCH',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(settings)
            });
            const data = await res.json();
            if (data.success) {
                Notify.success('通知設定を保存しました');
            } else {
                Notify.error(data.error || '保存に失敗しました');
            }
        } catch (err) {
            Notify.error('保存に失敗しました: ' + err.message);
        }
    }

    async connectSlack() {
        try {
            const authModule = await import('./auth.js');
            const token = await authModule.getIdToken();
            if (!token) {
                Notify.error('ログインが必要です');
                return;
            }
            const apiBase = (await import('./api-base.js')).getApiBaseUrl();
            const res = await fetch(`${apiBase}/api/slack/oauth/start`, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/json'
                }
            });
            const data = await res.json();
            if (data.success && data.url) {
                window.location.href = data.url;
            } else {
                Notify.error(data.error || 'Slack連携の開始に失敗しました');
            }
        } catch (err) {
            Notify.error('Slack連携の開始に失敗しました: ' + err.message);
        }
    }

    async disconnectSlack() {
        if (!await Notify.confirm('Slack連携を解除しますか？', { title: '確認', type: 'warning' })) return;
        try {
            const authModule = await import('./auth.js');
            const token = await authModule.getIdToken();
            if (!token) return;
            const apiBase = (await import('./api-base.js')).getApiBaseUrl();
            await fetch(`${apiBase}/api/slack/oauth/disconnect`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${token}` }
            });
            Notify.success('Slack連携を解除しました');
            this.loadAndRenderNotificationSettings();
        } catch (err) {
            Notify.error('解除に失敗しました: ' + err.message);
        }
    }

    async loadAndRenderNotificationSettings() {
        const main = this.mainContent;
        if (!main) return;

        const plan = this.subscription?.plan || 'free';
        if (plan === 'free') {
            main.innerHTML = this.renderNotificationSettings({}, '', plan);
            return;
        }

        // Slack OAuth結果をチェック
        const urlParams = new URLSearchParams(window.location.search);
        const slackConnected = urlParams.get('slack_connected');
        const slackError = urlParams.get('slack_error');
        const slackChannel = urlParams.get('channel');
        if (slackConnected === '1') {
            Notify.success('Slack連携が完了しました');
            history.replaceState(null, '', window.location.pathname);
        } else if (slackError) {
            Notify.error(`Slack連携に失敗しました: ${decodeURIComponent(slackError)}`);
            history.replaceState(null, '', window.location.pathname);
        }

        main.innerHTML = '<div style="padding:40px;color:#888;">読み込み中...</div>';

        let apiBase = '';
        try {
            apiBase = (await import('./api-base.js')).getApiBaseUrl();
        } catch (_) { /* fallback to empty */ }

        try {
            const authModule = await import('./auth.js');
            const token = await authModule.getIdToken();
            if (!token) {
                // ローカル開発環境などトークンなしの場合はデフォルト設定を表示
                main.innerHTML = this.renderNotificationSettings({}, apiBase, plan);
                return;
            }
            const res = await fetch(`${apiBase}/api/notifications/settings`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const data = await res.json();
            const settings = data.success ? data.data : {};
            main.innerHTML = this.renderNotificationSettings(settings, apiBase, plan);
        } catch (err) {
            main.innerHTML = this.renderNotificationSettings({}, apiBase, plan);
        }
    }

    showCancelModal() {
        console.log('showCancelModal called');
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay active';
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
                    <li style="margin-bottom:6px;">Freeプラン（無料）に戻ります</li>
                    <li style="margin-bottom:6px;">AI解析回数が月3回に制限されます</li>
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
                this.subscription.plan = 'free';
                this.subscription.billingCycle = 'monthly';
                this.userPlan = 'free';
                this.planViewBillingCycle = 'monthly';
                this.updateSubscriptionUI();
                Notify.success('プランがキャンセルされました。無料プランに移行しました。');
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
            'free': 'Free',
            'starter': 'Starter',
            'business': 'Business',
            'pro': 'Pro',
            'owner': 'Owner'
        };

        const usagePercent = Math.min(100, (sub.usageCount / sub.usageLimit) * 100);
        const planName = planNames[sub.plan] || sub.plan;
        const billingCycleLabel = sub.billingCycle === 'annual' ? '年額' : '月額';

        let upgradeAdvice = '';
        if (sub.usageCount >= sub.usageLimit) {
            if (sub.plan === 'free') {
                upgradeAdvice = '<div class="upgrade-advice">月間上限に達しました。Starter以上のプランにすると解析回数が増えます。</div>';
            } else if (sub.plan === 'starter') {
                upgradeAdvice = '<div class="upgrade-advice">月間上限に達しました。翌月まで待つか、Business以上のプランにすると回数が増えます。</div>';
            } else if (sub.plan === 'business') {
                upgradeAdvice = '<div class="upgrade-advice">月間上限に達しました。翌月まで待つか、Proプランにアップグレードすると回数が増えます。</div>';
            } else if (sub.plan === 'pro') {
                upgradeAdvice = '<div class="upgrade-advice">月間上限に達しました。翌月までお待ちいただくか、追加枠についてお問い合わせください。</div>';
            }
        }

        let statusHtml = `
        <div class="plan-status-card">
            <div class="plan-badge plan-badge-${sub.plan}">${planName}（${billingCycleLabel}）</div>
            <div class="plan-info-text">
                AI解析: <strong style="${sub.usageLimit >= 999999 ? '' : ((({'free':3,'starter':50,'business':120,'pro':400}[sub.plan] || sub.usageLimit) - sub.usageCount) <= 1 ? 'color:#f59e0b;' : '')}">${sub.usageCount}</strong> / ${sub.usageLimit >= 999999 ? '無制限' : ({'free':3,'starter':50,'business':120,'pro':400}[sub.plan] || sub.usageLimit) + '回'}
                <br>電子署名: <strong>${sub.signUsageCount || 0}</strong> / ${(sub.signUsageLimit >= 999999 || sub.plan === 'pro' || sub.plan === 'owner') ? '無制限' : `${{'free':10,'starter':25,'business':100}[sub.plan] || sub.signUsageLimit || 0}回`}
                ${sub.renewalDate ? `<br><span style="font-size:0.75rem; opacity:0.8;">次回更新: <strong>${new Date(sub.renewalDate).toLocaleDateString('ja-JP')}</strong></span>` : ''}
            </div>
            ${upgradeAdvice}
            ${this.isSignLimitReached() ? `
                <div style="margin-top:10px; padding:8px 10px; background:rgba(234,67,53,0.08); border:1px solid rgba(234,67,53,0.2); border-radius:6px; font-size:0.72rem; color:#c2410c;">
                    今月の電子署名上限に達しました。翌月までお待ちいただくか、上位プランへのアップグレードをご検討ください。
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
        // --- Navigation Logic ---
        // Team Management: Business+
        const navTeam = document.querySelector('.nav-item[onclick*="navigate(\'team\')"]');
        if (navTeam) {
            navTeam.classList.remove('feature-locked');
            navTeam.style.display = 'flex';
        }

        // Notification Settings: Pro only (Unlock for Owner)
        const navNotif = document.getElementById('nav-notifications');
        if (plan !== 'pro' && plan !== 'owner') {
            if (navNotif) navNotif.classList.add('feature-locked');
        } else {
            if (navNotif) navNotif.classList.remove('feature-locked');
        }

        // Deadline Alert Management: Business+ only (Unlock for Owner)
        const navDeadlines = document.getElementById('nav-deadlines');
        if (!['business', 'pro', 'owner'].includes(plan)) {
            if (navDeadlines) navDeadlines.classList.add('feature-locked');
        } else {
            if (navDeadlines) navDeadlines.classList.remove('feature-locked');
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

        if (!this.mobileBottomNavBound) {
            this.mobileBottomNavBound = true;
            document.addEventListener('click', (event) => {
                const button = event.target?.closest?.('.mobile-bottom-nav .bottom-nav-item');
                if (!button) return;

                const view = button.getAttribute('data-mobile-view');
                const action = button.getAttribute('data-mobile-action');
                if (!view && !action) return;

                event.preventDefault();
                event.stopPropagation();

                if (view) {
                    this.closeMobileMenu();
                    this.navigate(view);
                    return;
                }

                if (action === 'register') {
                    if (!this.can('operate_contract')) {
                        Notify.warning('閲覧のみの権限では新規登録できません');
                        return;
                    }
                    if (this.registration && typeof this.registration.open === 'function') {
                        this.registration.open();
                        return;
                    }
                    document.getElementById('open-registration-btn')?.click();
                    return;
                }

                if (action === 'menu') {
                    this.toggleMobileMenu();
                }
            });
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

    async renderViewContent(viewId, renderParams = null) {
        if (routes[viewId]) {
            const html = await navigateLazy(viewId, {
                app: this,
                dbService,
                DASHBOARD_CACHE_KEYS,
                escapeHtmlText,
                formatDisplayTimestamp,
                params: renderParams
            });
            if (typeof html !== 'string') {
                throw new Error('Dashboard module did not return HTML');
            }
            this.mainContent.innerHTML = html;
            return true;
        }

        if (!Views[viewId]) return false;
        this.mainContent.innerHTML = Views[viewId](renderParams);
        return true;
    }

    async navigate(viewId, params = null) {
        console.log(`Navigating to ${viewId}`, params);

        if (viewId !== 'diff') {
            this.clearHistoryComparisonContext();
            this.clearDocumentCompareState();
        }

        // Auto-close sidebar on mobile
        document.getElementById('app-sidebar')?.classList.remove('active');
        document.getElementById('sidebar-overlay')?.classList.remove('active');

        if (viewId === 'diff' && !this.ensurePaymentAccess('差分機能')) {
            return;
        }

        // --- FIX: Update UI state early before any branches return ---
        this.currentView = viewId;
        this.updateActiveMenu(viewId);
        this.updateRegistrationButtonVisibility(viewId);
        
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

        if (viewId === 'sign') {
            this.renderInitialSkeleton('sign');
            console.trace('Routing to sign');
            const { SignUI } = await import('./sign-ui.js?v=20260407_final_v10');
            this.mainContent.innerHTML = await SignUI.renderSignView(this);
            SignUI.refreshList(this);
            this.syncContractsInBackground(() => {
                if (this.currentView === 'sign') {
                    SignUI.refreshList(this);
                }
            });
            return;
        }

        if (viewId === 'sign-viewer') {
            const { SignUI } = await import('./sign-ui.js?v=20260407_final_v10');
            const { SignViewer } = await import('./sign-viewer.js?v=20260407_final_v10');
            this.mainContent.innerHTML = await SignUI.renderSignViewer(this, params);
            await SignViewer.init(this, params);
            return;
        }
        
        if (viewId === 'sign-editor') {
            const { SignUI } = await import('./sign-ui.js?v=20260407_final_v10');
            const { SignEditor } = await import('./sign-editor.js?v=20260407_overflow');
            this.mainContent.innerHTML = await SignUI.renderSignEditor(this, params);
            await SignEditor.init(this, params);
            return;
        }

        if (viewId === 'sign-recipient') {
            const { SignUI } = await import('./sign-ui.js?v=20260407_final_v10');
            const { SignRecipient } = await import('./sign-recipient.js?v=20260407_overflow');
            this.mainContent.innerHTML = await SignUI.renderSignRecipient(this, params);
            await SignRecipient.init(this, params);
            return;
        }

        // RBAC: Protect team view - Business+のみ
        if (viewId === 'team' && this.subscription?.plan === 'starter') {
            const upgradeModal = document.getElementById('upgrade-modal');
            if (upgradeModal) {
                upgradeModal.classList.add('active');
            }
            return;
        }

        if (viewId === 'mcp') {
            await this.loadAndRenderMcpSettings();
            return;
        }

        if (viewId === 'deadlines') {
            const deadlineParams = params && typeof params === 'object' ? params : {};
            this.mainContent.innerHTML = this.renderDeadlinesView(deadlineParams);
            this.updateDeadlinesBadge();
            this.syncContractsInBackground(() => {
                if (this.currentView !== 'deadlines') return;
                this.mainContent.innerHTML = this.renderDeadlinesView(deadlineParams);
                this.updateDeadlinesBadge();
            });
            return;
        }

        if (viewId === 'history') {
            dbService.cleanupLogs(this.userPlan || 'starter');
            this.cacheRecentHistorySnapshot();
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
            const normalizedDiffId = normalizeDiffContractId(params);
            if (!normalizedDiffId) {
                Notify.error('対象の契約IDを取得できませんでした。一覧から再度開いてください。');
                return;
            }
            renderParams = normalizedDiffId;
            // Auto-switch to 'original' tab for new contracts (no history)
            const isNewContract = normalizedDiffId !== this.currentViewParams;
            if (isNewContract && !this.historyComparisonContext) {
                const _c = dbService.getContractById(normalizedDiffId);
                const historyCount = (_c && Array.isArray(_c.history)) ? _c.history.length : 0;
                
                // If no history exists, always show 'original' tab first
                if (historyCount === 0) {
                    this.activeDetailTab = 'original';
                } else if (!this.currentViewParams) {
                    // Initial load with history -> show 'diff'
                    this.activeDetailTab = 'diff';
                }
            }
            this.currentViewParams = normalizedDiffId;
        }
        if (viewId === 'diff' && this.activeDetailTab === 'diff') {
            this.renderInitialSkeleton('diff');
            this.ensureDiffLibrary()
                .then(() => {
                    if (this.currentView === 'diff' && this.activeDetailTab === 'diff') {
                        try {
                            window.scrollTo(0, 0);
                            this.mainContent.innerHTML = Views.diff(this.currentViewParams);
                            this.resetDetailPaneScroll();
                            this.enforceDetailScrollLayout();
                            this.setupClauseNavAutoSync();
                        } catch (error) {
                            console.warn('Deferred diff rerender failed:', error);
                        }
                    }
                })
                .catch((error) => {
                    console.warn('Diff library lazy load failed:', error);
                });
        }
        if (viewId === 'plan') {
            if (!this.planViewBillingCycle) {
                this.planViewBillingCycle = this.subscription?.billingCycle === 'annual' ? 'annual' : 'monthly';
            }
            if (!this.paymentConfig) {
                this.fetchPaymentConfig().then((config) => {
                    if (config && this.currentView === 'plan') {
                        this.navigate('plan');
                    }
                }).catch((error) => {
                    console.warn('Failed to prefetch payment config for plan view:', error);
                });
            }
        }

        if (viewId === 'notifications') {
            this.loadAndRenderNotificationSettings();
            return;
        }

        const navMap = {
            'dashboard': 0, 'contracts': 1, 'history': 2, 'sign': 3, 'team': 4, 'plan': 5
        };

        // Update active menu state
        // (Moved to top of navigate)
        const navItems = document.querySelectorAll('.nav-item');
        // Find by content or click handler match
        navItems.forEach(item => {
            const onclick = item.getAttribute('onclick');
            if (onclick && onclick.includes(`navigate('${viewId}')`)) {
                item.classList.add('active');
            }
        });

        if (Views[viewId] || routes[viewId]) {
            try {
                const rendered = await this.renderViewContent(viewId, renderParams);
                if (!rendered) return;

                const titles = {
                    'dashboard': 'ダッシュボード',
                    'plan': 'プラン管理',
                    'contracts': '契約・規約管理',
                    'diff': '解析詳細',
                    'history': '履歴・ログ',
                    'team': 'チーム設定',
                    'sign': '署名管理',
                    'sign-viewer': '署名ビューワー'
                };
                if (this.pageTitle) {
                    this.pageTitle.textContent = titles[viewId] || 'DIFFsense';
                }

                window.scrollTo(0, 0);

                // Ensure detail panes always start from top.
                if (viewId === 'diff') {
                    this.resetDetailPaneScroll();
                }
                this.enforceDetailScrollLayout();
                if (viewId === 'diff') {
                    this.setupClauseNavAutoSync();
                } else {
                    this.teardownClauseNavAutoSync();
                }
                if (viewId === 'dashboard' || viewId === 'history') {
                    this.cacheRecentHistorySnapshot();
                }

                if (viewId === 'dashboard' || viewId === 'contracts') {
                    const syncedViewId = viewId;
                    const syncedRenderParams = renderParams;
                    this.syncContractsInBackground(async () => {
                        try {
                            if (this.currentView !== syncedViewId) return;
                            const rerendered = await this.renderViewContent(syncedViewId, syncedRenderParams);
                            if (!rerendered) return;
                            this.enforceDetailScrollLayout();
                            if (syncedViewId === 'dashboard') {
                                this.cacheRecentHistorySnapshot();
                            }
                        } catch (error) {
                            console.warn('Background view rerender failed:', error);
                        }
                    });
                }

                if (viewId === 'contracts' && this.filters.query) {
                    const searchInput = document.getElementById('contract-search');
                    if (searchInput) {
                        searchInput.focus();
                        searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);
                    }
                }
            } catch (error) {
                console.error(`View Render Error (${viewId}):`, error);
                if (viewId === 'diff') {
                    const contractId = typeof renderParams === 'object' ? renderParams?.id : renderParams;
                    const contract = dbService.getContractById(contractId);
                    const safeTitle = escapeHtmlText(contract?.name || '解析詳細');
                    const safeFile = escapeHtmlText(contract?.original_filename || '');
                    const safeBody = escapeHtmlText(contentToComparableText(contract?.original_content || '') || '原本データがありません');
                    this.mainContent.innerHTML = `
                        <div class="detail-split-container">
                            <div class="detail-split-header flex justify-between items-center">
                                <div class="detail-header-main">
                                    <h2 style="font-size:18px; font-weight:700; color:var(--text-main); margin:0;">${safeTitle}</h2>
                                    ${safeFile ? `<div class="detail-header-meta" style="font-size:12px; color:#666; margin-top:4px;"><span class="detail-header-meta-item"><i class="fa-solid fa-file-lines"></i> Original File: ${safeFile}</span></div>` : ''}
                                </div>
                            </div>
                            <div style="padding:24px;">
                                <div style="margin-bottom:16px; color:#b42318; font-size:13px;">比較画面の描画でエラーが発生したため、安全表示に切り替えました。</div>
                                <div style="background:#fff; border:1px solid #e5e7eb; border-radius:12px; padding:20px; white-space:pre-wrap; line-height:1.9;">${safeBody}</div>
                            </div>
                        </div>
                    `;
                } else {
                    this.mainContent.innerHTML = '<div class="p-md text-danger">画面の表示中にエラーが発生しました。</div>';
                }
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
                else if (c.status === '未処理') statusBadge = '<span class="badge badge-info">未処理</span>';
                else if (c.status === '未確認') statusBadge = '<span class="badge badge-warning">要確認 (変更)</span>';
                else if (c.status === '確認済') statusBadge = '<span class="badge badge-neutral"><i class="fa-solid fa-check"></i> 確認済</span>';

                const actionBtn = window.app.can('operate_contract')
                    ? `<button class="btn-dashboard">${c.status === '確認済' ? '履歴を見る' : '確認する'}</button>`
                    : `<button class="btn-dashboard">詳細を見る</button>`;

                return `
        <tr onclick="window.app.navigate('diff', ${c.id})">
            <td><span class="badge ${riskBadgeClass}">${c.risk_level}</span></td>
            <td class="col-name" title="${escapeHtmlText(c.name)}">${escapeHtmlText(c.name)}</td>
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

    async setDetailTab(tab) {
        this.activeDetailTab = tab;
        await this.navigate('diff', this.currentViewParams);

        // Reset scroll positions when switching tabs in detail view.
        this.resetDetailPaneScroll();
        this.setupClauseNavAutoSync();
    }

    getDetailHeaderOffset(scrollArea = null) {
        const appHeader = document.getElementById('app-header');
        const appHeaderHeight = appHeader ? appHeader.offsetHeight : 0;

        if (!scrollArea) {
            return appHeaderHeight + 10;
        }

        const pane = scrollArea.closest('.pane');
        const paneHeader = pane ? pane.querySelector('.pane-header') : null;
        const tabsRow = pane ? pane.querySelector('.tabs-row') : null;
        const paneHeaderHeight = paneHeader ? paneHeader.offsetHeight : 0;
        const tabsHeight = tabsRow ? tabsRow.offsetHeight : 0;

        return paneHeaderHeight + tabsHeight + 10;
    }

    setActiveClauseNavItem(clauseId) {
        const navItems = document.querySelectorAll('.detail-split-body .pane:nth-child(2) .clause-nav-item');
        if (!navItems.length) return;
        navItems.forEach((item) => {
            const isActive = item.getAttribute('data-clause-id') === clauseId;
            item.classList.toggle('active', isActive);
        });
    }

    getDetailContentScrollContainer(rightPane) {
        if (!rightPane) return null;
        // Single scroll container for detail right pane.
        return rightPane.querySelector('.pane-scroll-area');
    }

    updateClauseNavByScroll(scrollContainer) {
        if (!scrollContainer) return;
        if (this.clauseNavManualLockUntil && Date.now() < this.clauseNavManualLockUntil && this.clauseNavManualTargetId) {
            this.setActiveClauseNavItem(this.clauseNavManualTargetId);
            return;
        }
        const cards = Array.from(scrollContainer.querySelectorAll('.clause-card[id]'));
        if (!cards.length) return;

        const containerTop = scrollContainer.getBoundingClientRect().top;
        const offset = scrollContainer.classList.contains('clause-cards-container')
            ? 8
            : this.getDetailHeaderOffset(scrollContainer);
        const threshold = containerTop + offset;

        let activeCard = cards[0];
        for (const card of cards) {
            const top = card.getBoundingClientRect().top;
            if (top <= threshold) {
                activeCard = card;
            } else {
                break;
            }
        }

        this.setActiveClauseNavItem(activeCard.id);
    }

    setupClauseNavAutoSync() {
        this.teardownClauseNavAutoSync();

        if (this.currentView !== 'diff') return;
        if (this.activeDetailTab !== 'original') return;

        const rightPane = document.querySelector('.detail-split-body .pane:nth-child(2)');
        if (!rightPane) return;
        const scrollArea = this.getDetailContentScrollContainer(rightPane);
        const navItems = Array.from(rightPane.querySelectorAll('.clause-nav-item[data-clause-id]'));
        if (!scrollArea || !navItems.length) return;

        // In original tab, keep TOC fixed and scroll only document cards area.
        scrollArea.style.overflowY = 'auto';
        scrollArea.style.overflowX = 'hidden';
        scrollArea.style.pointerEvents = 'auto';
        scrollArea.style.overscrollBehavior = 'contain';
        scrollArea.style.webkitOverflowScrolling = 'touch';

        const onScroll = () => {
            if (this.detailClauseNavRaf) return;
            this.detailClauseNavRaf = requestAnimationFrame(() => {
                this.detailClauseNavRaf = null;
                this.updateClauseNavByScroll(scrollArea);
            });
        };

        scrollArea.addEventListener('scroll', onScroll, { passive: true });
        const navBox = rightPane.querySelector('.clause-nav');
        const navList = rightPane.querySelector('.clause-nav-list');
        const onWheelForward = (event) => {
            if (!event || !Number.isFinite(event.deltaY) || event.deltaY === 0) return;
            scrollArea.scrollTop += event.deltaY;
        };
        // Keep native wheel behavior on cards container itself (main scroll target).
        // Only forward wheel from TOC to the content scroll container.
        if (navBox) {
            navBox.addEventListener('wheel', onWheelForward, { passive: true });
        }
        if (navList) {
            navList.addEventListener('wheel', onWheelForward, { passive: true });
        }
        let observer = null;
        const cardsForObserver = Array.from(scrollArea.querySelectorAll('.clause-card[id]'));
        if (cardsForObserver.length > 0 && typeof IntersectionObserver === 'function') {
            observer = new IntersectionObserver((entries) => {
                if (this.clauseNavManualLockUntil && Date.now() < this.clauseNavManualLockUntil && this.clauseNavManualTargetId) {
                    this.setActiveClauseNavItem(this.clauseNavManualTargetId);
                    return;
                }
                const visible = entries
                    .filter((entry) => entry.isIntersecting)
                    .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
                if (visible.length > 0) {
                    const activeId = visible[0].target?.id;
                    if (activeId) this.setActiveClauseNavItem(activeId);
                }
            }, {
                root: scrollArea,
                threshold: [0.35, 0.55, 0.75],
                rootMargin: '-8px 0px -55% 0px'
            });

            cardsForObserver.forEach((card) => observer.observe(card));
        }

        this.detailClauseNavScrollCleanup = () => {
            scrollArea.removeEventListener('scroll', onScroll);
            if (navBox) {
                navBox.removeEventListener('wheel', onWheelForward);
            }
            if (navList) {
                navList.removeEventListener('wheel', onWheelForward);
            }
            if (this.detailClauseNavRaf) {
                cancelAnimationFrame(this.detailClauseNavRaf);
                this.detailClauseNavRaf = null;
            }
            if (observer) {
                observer.disconnect();
                observer = null;
            }
        };

        this.updateClauseNavByScroll(scrollArea);
    }

    teardownClauseNavAutoSync() {
        if (typeof this.detailClauseNavScrollCleanup === 'function') {
            this.detailClauseNavScrollCleanup();
        }
        this.detailClauseNavScrollCleanup = null;
        if (this.detailClauseNavRaf) {
            cancelAnimationFrame(this.detailClauseNavRaf);
            this.detailClauseNavRaf = null;
        }
    }

    scrollToClause(clauseId, options = {}) {
        const behavior = options.behavior || 'smooth';
        const target = document.getElementById(clauseId);
        if (!target) return;
        document.querySelectorAll('.clause-nav.is-open').forEach((nav) => nav.classList.remove('is-open'));
        document.querySelectorAll('.mobile-clause-nav-fab[aria-expanded="true"]').forEach((button) => {
            button.setAttribute('aria-expanded', 'false');
        });
        // Cancel pending auto-reset timers once user explicitly navigates by clause.
        this.detailResetToken = 0;
        this.clauseNavManualTargetId = clauseId;
        this.clauseNavManualLockUntil = Date.now() + 900;

        const paneScrollArea = target.closest('.pane-scroll-area');
        if (paneScrollArea) {
            const offset = this.getDetailHeaderOffset(paneScrollArea);
            const cardsContainer = target.closest('.clause-cards-container');
            const containerTop = cardsContainer ? (cardsContainer.offsetTop || 0) : 0;
            const targetTop = target.offsetTop || 0;
            const topWithinPane = containerTop + targetTop;
            const nextTop = topWithinPane - offset;
            paneScrollArea.scrollTo({ top: Math.max(0, Math.round(nextTop)), behavior });
            this.setActiveClauseNavItem(clauseId);
            return;
        }

        const offset = this.getDetailHeaderOffset(null);
        const elementPosition = target.getBoundingClientRect().top + window.pageYOffset;
        const offsetPosition = Math.max(0, elementPosition - offset);
        window.scrollTo({ top: offsetPosition, behavior });
        this.setActiveClauseNavItem(clauseId);
    }

    toggleMobileClauseNav(trigger) {
        const root = trigger?.closest('.contract-structured-container') || document.querySelector('.contract-structured-container');
        const nav = root ? root.querySelector('.clause-nav') : null;
        if (!nav) return;

        const willOpen = !nav.classList.contains('is-open');
        document.querySelectorAll('.clause-nav.is-open').forEach((openNav) => {
            if (openNav !== nav) openNav.classList.remove('is-open');
        });
        document.querySelectorAll('.mobile-clause-nav-fab[aria-expanded="true"]').forEach((button) => {
            if (button !== trigger) button.setAttribute('aria-expanded', 'false');
        });

        nav.classList.toggle('is-open', willOpen);
        if (trigger) trigger.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    }

    enforceDetailScrollLayout() {
        if (!this.mainContent) return;

        if (this.currentView !== 'diff') {
            this.mainContent.style.display = '';
            this.mainContent.style.flexDirection = '';
            this.mainContent.style.minHeight = '';
            this.mainContent.style.height = '';
            this.mainContent.style.overflowY = '';
            this.mainContent.style.overflowX = '';
            return;
        }

        const isMobileDetailLayout = typeof window.matchMedia === 'function'
            && window.matchMedia('(max-width: 1024px)').matches;
        if (isMobileDetailLayout) {
            this.mainContent.style.display = 'block';
            this.mainContent.style.flexDirection = '';
            this.mainContent.style.minHeight = '';
            this.mainContent.style.height = 'auto';
            this.mainContent.style.overflowY = 'visible';
            this.mainContent.style.overflowX = 'hidden';

            const detailContainer = this.mainContent.querySelector('.detail-split-container');
            if (detailContainer) {
                detailContainer.style.display = 'block';
                detailContainer.style.flexDirection = '';
                detailContainer.style.flex = '';
                detailContainer.style.minHeight = '';
                detailContainer.style.height = 'auto';
            }

            const detailBody = this.mainContent.querySelector('.detail-split-body');
            if (detailBody) {
                detailBody.style.display = 'block';
                detailBody.style.flex = '';
                detailBody.style.minHeight = '';
                detailBody.style.height = 'auto';
                detailBody.style.overflow = 'visible';
            }

            this.mainContent.querySelectorAll('.detail-split-body .pane').forEach((pane) => {
                pane.style.display = 'flex';
                pane.style.flexDirection = 'column';
                pane.style.flex = 'none';
                pane.style.minHeight = '';
                pane.style.overflow = 'visible';
            });

            this.mainContent.querySelectorAll('.pane-scroll-area').forEach((area) => {
                area.style.display = 'block';
                area.style.flex = 'none';
                area.style.overflowY = 'visible';
                area.style.overflowX = 'hidden';
                area.style.minHeight = '';
                area.style.height = 'auto';
                area.style.scrollPaddingTop = '120px';
            });

            this.mainContent.querySelectorAll('.clause-card').forEach((card) => {
                card.style.scrollMarginTop = '150px';
            });
            return;
        }

        // Single-scroll layout chain for detail view (stable at browser zoom 100%).
        this.mainContent.style.display = 'flex';
        this.mainContent.style.flexDirection = 'column';
        this.mainContent.style.minHeight = '0';
        this.mainContent.style.height = '100%';
        this.mainContent.style.overflowY = 'hidden';
        this.mainContent.style.overflowX = 'hidden';

        const detailContainer = this.mainContent.querySelector('.detail-split-container');
        if (detailContainer) {
            detailContainer.style.display = 'flex';
            detailContainer.style.flexDirection = 'column';
            detailContainer.style.flex = '1 1 auto';
            detailContainer.style.minHeight = '0';
            detailContainer.style.height = '100%';
        }

        const detailBody = this.mainContent.querySelector('.detail-split-body');
        if (detailBody) {
            detailBody.style.display = 'flex';
            detailBody.style.flex = '1 1 auto';
            detailBody.style.minHeight = '0';
            detailBody.style.height = 'auto';
            detailBody.style.overflow = 'hidden';
        }

        this.mainContent.querySelectorAll('.detail-split-body .pane').forEach((pane) => {
            pane.style.display = 'flex';
            pane.style.flexDirection = 'column';
            pane.style.flex = '1 1 0';
            pane.style.minHeight = '0';
            pane.style.overflow = 'hidden';
        });

        this.mainContent.querySelectorAll('.pane-scroll-area').forEach((area) => {
            area.style.display = 'block';
            area.style.flex = '1 1 auto';
            area.style.overflowY = 'auto';
            area.style.overflowX = 'hidden';
            area.style.minHeight = '0';
            area.style.height = 'auto';
            area.style.scrollPaddingTop = '8px';
        });

        this.mainContent.querySelectorAll('.clause-card').forEach((card) => {
            card.style.scrollMarginTop = '100px';
        });
    }

    resetDetailPaneScroll() {
        const resetToken = Date.now();
        this.detailResetToken = resetToken;
        const resetScrollAreaToTop = (scrollArea) => {
            if (!scrollArea) return;
            scrollArea.scrollTop = 0;
            scrollArea.scrollLeft = 0;
            scrollArea.scrollTo({ top: 0, left: 0, behavior: 'auto' });
        };

        const runReset = () => {
            if (this.detailResetToken !== resetToken) return;
            const rightPane = document.querySelectorAll('.detail-split-body .pane')[1];
            if (!rightPane) return;

            const scrollArea = rightPane.querySelector('.pane-scroll-area');
            const detailBody = document.querySelector('.detail-split-body');
            const documentContent = rightPane.querySelector('.document-content-full');
            const structuredView = rightPane.querySelector('.contract-structured-container');
            const navBox = rightPane.querySelector('.clause-nav');
            const navList = rightPane.querySelector('.clause-nav-list');
            const clauseCards = rightPane.querySelector('.clause-cards-container');

            if (scrollArea) {
                scrollArea.style.scrollBehavior = 'auto';
                resetScrollAreaToTop(scrollArea);
            }
            if (detailBody) {
                detailBody.scrollTop = 0;
            }
            if (documentContent) {
                documentContent.scrollTop = 0;
            }
            if (structuredView) {
                structuredView.scrollTop = 0;
            }
            if (navBox) {
                navBox.scrollTop = 0;
            }
            if (navList) {
                navList.scrollTop = 0;
                navList.scrollTo({ top: 0, left: 0, behavior: 'auto' });
            }
            if (clauseCards) {
                clauseCards.scrollTop = 0;
                clauseCards.scrollTo({ top: 0, left: 0, behavior: 'auto' });
            }

            if (this.activeDetailTab === 'original' && scrollArea) {
                const firstNavItem = rightPane.querySelector('.clause-nav-item[data-clause-id]');
                const firstClauseId = firstNavItem ? firstNavItem.getAttribute('data-clause-id') : null;
                if (firstClauseId) {
                    this.setActiveClauseNavItem(firstClauseId);
                }
            }
        };

        requestAnimationFrame(() => {
            runReset();

            const rightPane = document.querySelectorAll('.detail-split-body .pane')[1];
            const scrollArea = rightPane ? rightPane.querySelector('.pane-scroll-area') : null;
            const delayedResets = [120, 420, 900];
            delayedResets.forEach((delayMs) => {
                setTimeout(() => {
                    if (this.detailResetToken !== resetToken) return;
                    runReset();
                }, delayMs);
            });

            if (scrollArea) {
                // Keep nav static (no independent scrolling) and always route wheel to content pane.
                const navBox = rightPane ? rightPane.querySelector('.clause-nav') : null;
                const navList = rightPane ? rightPane.querySelector('.clause-nav-list') : null;
                if (navBox) {
                    navBox.scrollTop = 0;
                    navBox.style.overflow = 'hidden';
                }
                if (navList) {
                    navList.scrollTop = 0;
                    navList.style.overflowY = 'hidden';
                }
            }
        });
    }

    changePage(newPage) {
        this.currentPage = newPage;
        this.navigate('contracts', { page: newPage });
    }

    confirmContract(id) {
        if (!this.can('operate_contract')) {
            Notify.warning('閲覧のみの権限ではステータスを変更できません');
            return;
        }
        if (dbService.updateContractStatus(id, '確認済')) {
            // Switch to 'Monitoring' (Total) view and go back to dashboard
            this.dashboardFilter = 'total';
            this.navigate('dashboard');
        }
    }

    async analyzeContract(id) {
        if (!this.can('operate_contract')) {
            Notify.warning('閲覧のみの権限ではAI解析を実行できません');
            return;
        }
        const count = Number(this.subscription?.usageCount || 0);
        const limit = Number(this.subscription?.usageLimit || 0);
        if (count >= limit) {
            this.showAnalysisLimitError({ currentUsage: count, limit: limit });
            return;
        }
        if (!this.ensurePaymentAccess('差分解析')) {
            return;
        }
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

            // AI解析を実行（旧バージョンがあれば差分比較モード）
            const previousVersion = (contract.history && contract.history.length > 0)
                ? contract.history[contract.history.length - 1].content
                : null;
            const result = await aiService.analyzeContract(
                id,
                'text',  // テキストとして送信
                contract.original_content,
                previousVersion
            );

            // ローディング削除
            document.body.removeChild(loadingMsg);

            if (result.success) {
                // 解析結果をDBに保存
                const analysisPayloadAi = {
                    extractedText: contract.original_content,  // 既存のテキストを保持
                    changes: result.data.changes,
                    riskLevel: result.data.riskLevel,
                    riskReason: result.data.riskReason,
                    summary: result.data.summary,
                    isFallback: result.data.isFallback === true,
                    aiFailed: result.data.aiFailed === true,
                    status: '未確認'  // 解析完了、確認待ち
                };
                // contract_meta（期限情報）が返ってきた場合はマージして保存
                if (result.data.contract_meta) {
                    const m = result.data.contract_meta;
                    analysisPayloadAi.expiry_date = m.expiry_date || null;
                    analysisPayloadAi.renewal_deadline = m.renewal_deadline || null;
                    analysisPayloadAi.contract_start = m.contract_start || null;
                    analysisPayloadAi.auto_renewal = m.auto_renewal === true;
                    analysisPayloadAi.notice_period_days = m.notice_period_days || null;
                    analysisPayloadAi.contract_category = m.contract_category || null;
                    analysisPayloadAi.date_confidence = m.date_confidence || 'unknown';
                }
                dbService.updateContractAnalysis(id, analysisPayloadAi);

                // サブスクリプション情報を再取得（使用回数を更新）
                await this.refreshSubscriptionStatusSafe();

                // 画面を再読み込み
                this.navigate('diff', id);

                // AI解析失敗チェック
                if (result.data.aiFailed) {
                    Notify.error('AI解析に失敗しました。利用回数は消費されていません。再度お試しください。');
                } else {
                    Notify.success('AI解析が完了しました！リスク判定と差分抽出が完了しました。');
                }
            } else {
                throw new Error(result.error || '解析に失敗しました');
            }

        } catch (error) {
            console.error('AI解析エラー:', error);
            if (error.code === 'ANALYSIS_LIMIT_EXCEEDED') {
                this.showAnalysisLimitError(error);
            } else {
                Notify.error(`AI解析中にエラーが発生しました: ${error.message}`);
            }
        }
    }

    uploadNewVersion(id) {
        if (!this.ensurePaymentAccess('新しいバージョン解析')) {
            return;
        }
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

        // それ以外（PDF/Word）はファイル選択ダイアログを表示
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.pdf,.docx';

        // input.click() をトリガーする前にイベントハンドラを設定
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            const isPdf = file.name.toLowerCase().endsWith('.pdf');
            const isDocx = file.name.toLowerCase().endsWith('.docx');

            if (!isPdf && !isDocx) {
                Notify.warning('PDFまたはWordファイルを選択してください');
                return;
            }

            const analysisMethod = isPdf ? 'pdf' : 'docx';
            const methodLabel = isPdf ? 'PDF' : 'Word';
            if (isPdf) {
                this.setRuntimePdfPreviewUrl(id, file);
            } else if (isDocx) {
                this.setRuntimeOriginalPreviewFile(id, file);
            }

            const performAnalysis = async (retryCount = 0) => {
                try {
                    // ローディング表示
                    const loadingMsg = document.createElement('div');
                    loadingMsg.id = 'analysis-loading';
                    loadingMsg.style.cssText = 'position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); background:white; padding:30px; border-radius:8px; box-shadow:0 4px 20px rgba(0,0,0,0.3); z-index:10000; text-align:center; min-width:300px;';
                    loadingMsg.innerHTML = `<div class="custom-loader"></div><br><strong>${methodLabel}ドキュメントを解析中...${retryCount > 0 ? '(再試行中)' : ''}</strong><br><span style="font-size:12px; color:#666;">テキストデータとレイアウトを抽出しています<br>※スキャンデータなどは時間がかかる場合があります</span>`;
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
                    const isFirstUpload = !previousVersion;

                    // AI解析を実行（前バージョンなし＝初回取り込みはAIをスキップ）
                    const result = await aiService.analyzeContract(
                        id,
                        analysisMethod,
                        base64Data,
                        previousVersion,
                        isFirstUpload ? { skipAI: true } : {}
                    );

                    // ローディング削除
                    if (document.getElementById('analysis-loading')) document.getElementById('analysis-loading').remove();
                    if (document.getElementById('analysis-overlay')) document.getElementById('analysis-overlay').remove();

                    if (result.success) {
                        const extractedContent = resolveExtractedContentPayload(result.data);
                        if (!extractedContent) {
                            throw new Error('解析結果に本文データが含まれていません');
                        }
                        // 解析結果をDBに保存
                        const analysisPayload = {
                            extractedText: extractedContent,
                            rawExtractedText: result.data.rawExtractedText,
                            extractedTextHash: result.data.extractedTextHash,
                            extractedTextLength: result.data.extractedTextLength,
                            sourceType: result.data.sourceType,
                            pdfStoragePath: result.data.pdfStoragePath,
                            pdfUrl: result.data.pdfUrl,
                            originalFilePath: result.data.originalFilePath || null,
                            status: '未確認',
                            originalFilename: file.name
                        };
                        // 初回取り込みはAI結果なし、2回目以降は差分・リスク情報も保存
                        if (!isFirstUpload) {
                            analysisPayload.changes = result.data.changes;
                            analysisPayload.riskLevel = result.data.riskLevel;
                            analysisPayload.riskReason = result.data.riskReason;
                            analysisPayload.summary = result.data.summary;
                            analysisPayload.isFallback = result.data.isFallback === true;
                            analysisPayload.aiFailed = result.data.aiFailed === true;
                        }
                        dbService.updateContractAnalysis(id, analysisPayload);
                        if (!isFirstUpload) {
                            await this.refreshSubscriptionStatusSafe();
                        }

                        // 初回取り込みは原本全文タブ、2回目以降（差分・履歴あり）は差分タブ
                        const updatedContract = dbService.getContractById(id);
                        const hasHistory = updatedContract && updatedContract.history && updatedContract.history.length > 0;
                        this.activeDetailTab = hasHistory ? 'diff' : 'original';
                        this.syncLatestDocumentCompareState(id);
                        this.navigate('diff', id);

                        if (isFirstUpload) {
                            this.showToast('✅ 取り込みが完了しました', 'success', 5000);
                        } else {
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
                                this.showToast(isPdf ? '✅ PDFの取り込みと解析が完了しました' : '✅ 差分解析が完了しました', 'success', 5000);
                            }
                        }

                    } else {
                        const err = new Error(result.error || '解析に失敗しました');
                        if (result.error === 'ANALYSIS_LIMIT_EXCEEDED') {
                            err.code = 'ANALYSIS_LIMIT_EXCEEDED';
                            err.currentUsage = result.currentUsage;
                            err.limit = result.limit;
                            err.nextPlan = result.nextPlan;
                        }
                        throw err;
                    }

                } catch (error) {
                    console.error('AI解析エラー:', error);
                    if (document.getElementById('analysis-loading')) document.getElementById('analysis-loading').remove();
                    if (document.getElementById('analysis-overlay')) document.getElementById('analysis-overlay').remove();

                    let friendlyMsg = error.message;
                    if (friendlyMsg.includes('ADM-ZIP') || friendlyMsg.includes('zip format')) {
                        friendlyMsg = 'Wordファイルの解析に失敗しました。正常なWordドキュメント(.docx)であることを確認してください。';
                    } else if (friendlyMsg.includes('時間がかかりすぎ') || friendlyMsg.includes('timeout') || friendlyMsg.includes('Timeout') || friendlyMsg.includes('Failed to fetch')) {
                        friendlyMsg = '取り込みに時間がかかりすぎました。もう一度お試しください。';
                    } else if (friendlyMsg.includes('バックエンドAPI') || friendlyMsg.includes('接続できません')) {
                        friendlyMsg = '取り込みに失敗しました。もう一度お試しください。';
                    }
                    if (error.code === 'ANALYSIS_LIMIT_EXCEEDED') {
                        this.showAnalysisLimitError(error);
                    } else if (await Notify.confirm(`解析中に問題が発生しました:\n${friendlyMsg}\n\nもう一度試しますか？`, { title: '解析エラー', type: 'error' })) {
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
        if (!this.can('operate_contract')) {
            Notify.warning('閲覧のみの権限ではバージョン更新を実行できません');
            return;
        }
        if (!this.ensurePaymentAccess('URL差分解析')) {
            return;
        }
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
                    const extractedContent = resolveExtractedContentPayload(result.data);
                    if (!extractedContent) {
                        throw new Error('解析結果に本文データが含まれていません');
                    }
                    // 解析結果をDBに保存
                    dbService.updateContractAnalysis(id, {
                        extractedText: extractedContent,
                        sourceUrl: url,
                        sourceType: 'URL',
                        changes: result.data.changes,
                        riskLevel: result.data.riskLevel,
                        riskReason: result.data.riskReason,
                        summary: result.data.summary,
                        isFallback: result.data.isFallback === true,
                        aiFailed: result.data.aiFailed === true,
                        status: '未確認'
                    });

                    // サブスクリプション情報を再取得（使用回数を更新）
                    await this.refreshSubscriptionStatusSafe();

                    // 画面を再読み込み (履歴があれば差分、初回なら原本)
                    const updatedContract = dbService.getContractById(id);
                    const hasHistory = updatedContract && updatedContract.history && updatedContract.history.length > 0;
                    this.activeDetailTab = hasHistory ? 'diff' : 'original';
                    this.syncLatestDocumentCompareState(id);
                    this.navigate('diff', id);

                    if (result.data.aiFailed) {
                        Notify.error('AI解析に失敗しました。利用回数は消費されていません。再度お試しください。');
                    } else {
                        Notify.success('最新バージョンの取り込みとAI解析が完了しました！');
                    }
                } else {
                    const err = new Error(result.error || '解析に失敗しました');
                    if (result.error === 'ANALYSIS_LIMIT_EXCEEDED') {
                        err.code = 'ANALYSIS_LIMIT_EXCEEDED';
                        err.currentUsage = result.currentUsage;
                        err.limit = result.limit;
                        err.nextPlan = result.nextPlan;
                    }
                    throw err;
                }

            } catch (error) {
                console.error('URL AI Service Error:', error);
                if (document.getElementById('analysis-loading')) document.getElementById('analysis-loading').remove();
                if (document.getElementById('analysis-overlay')) document.getElementById('analysis-overlay').remove();

                let friendlyMsg = error.message;
                if (friendlyMsg.includes('ADM-ZIP') || friendlyMsg.includes('zip format')) {
                    friendlyMsg = 'Wordファイルの読み込みに失敗しました。ファイルが破損しているか、非対応の形式である可能性があります。';
                }
                if (error.code === 'ANALYSIS_LIMIT_EXCEEDED') {
                    this.showAnalysisLimitError(error);
                } else if (await Notify.confirm(`解析中に問題が発生しました:\n${friendlyMsg}\n\nもう一度試しますか？`, { title: '解析エラー', type: 'error' })) {
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
                    <div style="background:white; width:90%; max-width:450px; border-radius:12px; padding:32px; text-align:center; box-shadow:0 10px 40px rgba(0,0,0,0.1); animation: slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1);">
                        <div style="width:60px; height:60px; background:#f9f9f9; border-radius:50%; display:flex; align-items:center; justify-content:center; margin:0 auto 20px; color:#c5a059; font-size:30px;">
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
                    @keyframes fadeIn {from {opacity: 0; } to {opacity: 1; } }
                    @keyframes slideUp {from {transform: translateY(20px); opacity: 0; } to {transform: translateY(0); opacity: 1; } }
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
                                    <td style="padding: 12px 0; font-weight: 600;">${escapeHtmlText(log.target_name)}</td>
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

    showBusinessFeatureModal() {
        const existing = document.getElementById('business-upgrade-modal');
        if (existing) existing.remove();
        const modal = document.createElement('div');
        modal.id = 'business-upgrade-modal';
        modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:11000;animation:fadeIn 0.3s;';
        modal.innerHTML = `
            <div style="background:white;width:90%;max-width:420px;border-radius:12px;padding:32px;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,0.2);animation:slideUp 0.3s cubic-bezier(0.16,1,0.3,1);">
                <div style="width:60px;height:60px;background:#f3f0ea;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 20px;color:#c5a059;font-size:28px;">
                    <i class="fa-solid fa-crown"></i>
                </div>
                <div style="display:inline-block;background:#f3f0ea;color:#c5a059;border:1px solid #e8d9b8;border-radius:10px;padding:3px 12px;font-size:11px;font-weight:700;margin-bottom:12px;">Business / Proプラン限定</div>
                <h3 style="margin:0 0 12px;color:#24292E;font-size:18px;font-weight:700;">期限・アラート管理</h3>
                <p style="margin:0 0 24px;color:#586069;font-size:13px;line-height:1.7;">契約期限の自動抽出・アラート通知はBusinessプラン以上でご利用いただけます。</p>
                <div style="display:flex;gap:10px;">
                    <button style="flex:1;padding:10px;border:1px solid #ddd;border-radius:8px;background:#fff;color:#666;font-size:13px;cursor:pointer;" onclick="document.getElementById('business-upgrade-modal').remove()">閉じる</button>
                    <button style="flex:1;padding:10px;border:none;border-radius:8px;background:#c5a059;color:#fff;font-size:13px;font-weight:700;cursor:pointer;" onclick="document.getElementById('business-upgrade-modal').remove();window.app.navigate('plan')">プランを見る</button>
                </div>
            </div>`;
        document.body.appendChild(modal);
        modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    }

    showProFeatureModal(message) {
        const existing = document.getElementById('pro-upgrade-modal');
        if (existing) existing.remove();
        const modal = document.createElement('div');
        modal.id = 'pro-upgrade-modal';
        modal.style.cssText = 'position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:11000; animation: fadeIn 0.3s;';
        modal.innerHTML = `
            <div style="background:white; width:90%; max-width:420px; border-radius:12px; padding:32px; text-align:center; box-shadow:0 10px 40px rgba(0,0,0,0.2); animation: slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1);">
                <div style="width:60px; height:60px; background:#f3f0ea; border-radius:50%; display:flex; align-items:center; justify-content:center; margin:0 auto 20px; color:#c5a059; font-size:28px;">
                    <i class="fa-solid fa-satellite-dish"></i>
                </div>
                <div style="display:inline-block; background:#f3f0ea; color:#c5a059; border:1px solid #e8d9b8; border-radius:10px; padding:3px 12px; font-size:11px; font-weight:700; margin-bottom:12px;">Proプラン限定</div>
                <h3 style="margin:0 0 12px; color:#24292E; font-size:18px; font-weight:700;">定期URL監視・Slack／メール通知</h3>
                <p style="margin:0 0 24px; color:#586069; font-size:13px; line-height:1.7;">${message}</p>
                <div style="display:flex; gap:10px;">
                    <button style="flex:1; padding:10px; border:1px solid #ddd; border-radius:8px; background:#fff; color:#666; font-size:13px; cursor:pointer;" onclick="document.getElementById('pro-upgrade-modal').remove()">閉じる</button>
                    <button style="flex:1; padding:10px; border:none; border-radius:8px; background:#c5a059; color:#fff; font-size:13px; font-weight:700; cursor:pointer;" onclick="document.getElementById('pro-upgrade-modal').remove(); window.app.registration?.close(); window.app.navigate('plan')">Proプランを見る</button>
                </div>
            </div>`;
        document.body.appendChild(modal);
        modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
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
                const inviteResult = await aiService.sendInvite(email, name, role);
                if (inviteResult.emailSent) {
                    this.showSuccessModal('招待送信完了', 'メンバーを追加し、招待メールを送信しました。');
                } else {
                    this.showSuccessModal('メンバー追加完了', `${name} さんをチームに追加しました。<br><br><small style="color:#888;">※ メール通知は現在設定されていません。<br>招待先に直接ダッシュボードURLをお伝えください。</small>`);
                }
            } catch (error) {
                console.error('Email send failed:', error);
                this.showSuccessModal('メンバー追加完了', `${name} さんをチームに追加しました。<br><br><small style="color:#888;">※ 招待メールの送信に失敗しました。<br>招待先に直接ダッシュボードURLをお伝えください。</small>`);
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
        if (!this.can('operate_contract')) {
            Notify.warning('閲覧のみの権限では監視設定を変更できません');
            return;
        }
        if (enabled && this.subscription?.plan !== 'pro') {
            this.showAlertModal('プラン制限', '定期URL監視（自動チェック）はProプラン限定の機能です。', 'warning');
            return;
        }
        dbService.toggleMonitoring(id, enabled);
        this.navigate('diff', id);
    }

    /**
     * 手動クローリングを実行
     */
    async manualCrawl(id) {
        const contract = dbService.getContractById(id);
        if (!contract || !contract.source_url) return;
        const count = Number(this.subscription?.usageCount || 0);
        const limit = Number(this.subscription?.usageLimit || 0);
        if (count >= limit) {
            this.showAnalysisLimitError({ currentUsage: count, limit: limit });
            return;
        }
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
                    this.navigate('diff', id);
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
        if (!this.ensurePaymentAccess('差分解析')) {
            return;
        }
        const contract = dbService.getContractById(id);
        const fbModule = await import('./firebase-config.js');
        const user = fbModule.auth.currentUser;

        if (!user) {
            Notify.warning('セッションが切れました。再ログインしてください。');
            return;
        }

        const count = Number(this.subscription?.usageCount || 0);
        const limit = Number(this.subscription?.usageLimit || 0);
        if (count >= limit) {
            this.showAnalysisLimitError({ currentUsage: count, limit: limit });
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
                await this.refreshSubscriptionStatusSafe();
                this.navigate('diff', id);
            } else {
                const err = new Error(resData.error || '解析に失敗しました');
                if (resData.error === 'ANALYSIS_LIMIT_EXCEEDED') {
                    err.code = 'ANALYSIS_LIMIT_EXCEEDED';
                    err.currentUsage = resData.currentUsage;
                    err.limit = resData.limit;
                    err.nextPlan = resData.nextPlan;
                }
                throw err;
            }
        } catch (error) {
            console.error('AI Analysis Error:', error);
            if (error.code === 'ANALYSIS_LIMIT_EXCEEDED') {
                this.showAnalysisLimitError(error);
            } else {
                Notify.error(`AI解析中にエラーが発生しました: ${error.message}`);
            }
        }
    }




    async compareHistoryWithBase(contractId, version) {
        const contract = dbService.getContractById(contractId);
        if (!contract || !Array.isArray(contract.history)) return;

        const historyItem = contract.history.find((h) => h.version === version);
        if (!historyItem) return;

        const previousLabel = buildComparisonLabel(
            historyItem.original_filename || contract.original_filename || contract.name,
            historyItem.date,
            '比較元資料'
        );
        const currentLabel = buildComparisonLabel(
            contract.original_filename || contract.name,
            contract.last_analyzed_at || contract.last_updated_at,
            'BASE資料'
        );

        const confirmed = await Notify.confirm(
            `BASE資料との比較解析を実行しますか？<br><br><strong>比較元:</strong> ${escapeHtmlText(previousLabel)}<br><strong>比較先:</strong> ${escapeHtmlText(currentLabel)}<br><br>解析後はこの比較専用の差分画面を表示します。`,
            { title: '比較解析の確認', type: 'info', okText: '解析する', cancelText: 'キャンセル' }
        );
        if (!confirmed) return;

        const comparisonContext = {
            contractId,
            historyVersion: version,
            historyItem,
            previousLabel,
            currentLabel
        };

        const sourceType = String(contract?.source_type || '').toUpperCase();
        const isPdfSource = sourceType === 'PDF' || (contract?.original_filename || '').toLowerCase().endsWith('.pdf');
        const isWordSource = isWordDocumentFilename(contract?.original_filename || '');

        try {
            Notify.info('比較解析を実行中...');
            let requestedRemoteAnalysis = false;

            if (contract.source_url) {
                requestedRemoteAnalysis = true;
                const result = await aiService.analyzeContract(contractId, 'url', contract.source_url, historyItem.content);
                if (!result.success) throw new Error(result.error || '比較解析に失敗しました');
                comparisonContext.analysis = result.data;
            } else if (isPdfSource) {
                const pdfUrl = this.getRuntimePdfPreviewUrl(contractId) || contract.pdf_url;
                if (!pdfUrl) {
                    comparisonContext.analysisNotice = 'PDF原本が保持されていないため、AI再解析は行わず比較表示のみ行います。';
                } else {
                    const response = await fetch(pdfUrl);
                    if (!response.ok) throw new Error('PDF原本の取得に失敗しました');
                    const blob = await response.blob();
                    const file = new File([blob], contract.original_filename || 'contract.pdf', { type: blob.type || 'application/pdf' });
                    const base64 = await aiService.convertFileToBase64(file);
                    requestedRemoteAnalysis = true;
                    const result = await aiService.analyzeContract(contractId, 'pdf', base64, historyItem.content);
                    if (!result.success) throw new Error(result.error || '比較解析に失敗しました');
                    comparisonContext.analysis = result.data;
                }
            } else if (isWordSource) {
                comparisonContext.analysisNotice = 'Word原本は再取得できないため、AI再解析は行わず比較表示のみ行います。';
            } else {
                comparisonContext.analysisNotice = 'この資料形式では再解析できないため、比較表示のみ行います。';
            }

            if (requestedRemoteAnalysis) {
                await this.refreshSubscriptionStatusSafe();
            }
            this.setHistoryComparisonContext(comparisonContext);
            this.activeDetailTab = 'diff';
            await this.navigate('diff', contractId);
        } catch (error) {
            console.error('History comparison error:', error);
            Notify.error(`比較解析に失敗しました: ${error.message}`);
        }
    }

    async handleDocumentCompareChange(contractId, field, value) {
        const docs = dbService.getDocumentsByContractId(contractId);
        const currentState = this.getDocumentCompareState(contractId) || {};
        const nextState = {
            contractId,
            docAId: field === 'docA' ? value : (currentState.docAId || ''),
            docBId: field === 'docB' ? value : (currentState.docBId || '')
        };

        if (nextState.docAId && nextState.docAId === nextState.docBId) {
            Notify.warning('比較元と比較先には別の文書を選択してください。');
            return;
        }

        this.clearHistoryComparisonContext(contractId);
        this.setDocumentCompareState(nextState);

        if (!nextState.docAId || !nextState.docBId) {
            this.navigate('diff', contractId);
            return;
        }

        const sourceDoc = docs.find((doc) => doc.id === nextState.docAId);
        const targetDoc = docs.find((doc) => doc.id === nextState.docBId);
        if (!sourceDoc || !targetDoc) {
            Notify.error('選択した文書が見つかりません。');
            return;
        }

        const cached = dbService.getDiffResult(sourceDoc.id, targetDoc.id);
        const structuredFallbackAnalysis = buildStructuredFallbackAnalysis(sourceDoc.content, targetDoc.content);
        const hasStructuredDifferences = Boolean(structuredFallbackAnalysis?.changes?.length);
        const hasFallbackNoDiffCache = hasStructuredDifferences
            && cached?.diff_data?.isFallback === true
            && isExplicitNoDiffAnalysis(cached?.diff_data);
        const storedAnalysis = buildStoredContractAnalysis(dbService.getContractById(contractId));
        const canHydrateFromStoredAnalysis = isCurrentVsLatestHistoryPair(docs, sourceDoc, targetDoc)
            && hasAnalysisRecord(storedAnalysis)
            && storedAnalysis?.isFallback !== true;
        if (isLocalDashboardMode()) {
            await this.analyzeDocumentPair(contractId, sourceDoc, targetDoc, { force: true, silent: true, auto: true });
            return;
        }
        if (cached && isReusableAnalysisPayload(cached.diff_data) && !hasFallbackNoDiffCache) {
            dbService.touchRecentDiff(sourceDoc.id, targetDoc.id);
            this.navigate('diff', contractId);
            return;
        }
        if (canHydrateFromStoredAnalysis) {
            const contract = dbService.getContractById(contractId);
            dbService.saveDiffResult({
                docA_id: sourceDoc.id,
                docB_id: targetDoc.id,
                diff_data: buildStoredContractAnalysis(contract),
                created_at: new Date().toISOString()
            });
            dbService.touchRecentDiff(sourceDoc.id, targetDoc.id);
            this.navigate('diff', contractId);
            return;
        }
        if (structuredFallbackAnalysis && Array.isArray(structuredFallbackAnalysis.changes) && structuredFallbackAnalysis.changes.length > 0) {
            if (isCurrentVsLatestHistoryPair(docs, sourceDoc, targetDoc)) {
                dbService.updateContractAnalysis(contractId, {
                    summary: structuredFallbackAnalysis.summary,
                    riskLevel: structuredFallbackAnalysis.riskLevel,
                    riskReason: structuredFallbackAnalysis.riskReason,
                    changes: structuredFallbackAnalysis.changes,
                    isFallback: true,
                    status: '未確認'
                });
            }
            dbService.saveDiffResult({
                docA_id: sourceDoc.id,
                docB_id: targetDoc.id,
                diff_data: {
                    ...structuredFallbackAnalysis,
                    riskReason: structuredFallbackAnalysis.riskReason || '変更点を表示しています',
                    isFallback: true
                },
                created_at: new Date().toISOString()
            });
            dbService.touchRecentDiff(sourceDoc.id, targetDoc.id);
            this.navigate('diff', contractId);
            return;
        }

        this.navigate('diff', contractId);
    }

    async runSelectedPairAnalysis(contractId) {
        if (!this.can('operate_contract')) {
            Notify.warning('閲覧のみの権限では解析を実行できません');
            return;
        }
        const docs = dbService.getDocumentsByContractId(contractId);
        const compareState = this.getDocumentCompareState(contractId) || {};
        const fallbackSourceDoc = docs.length >= 2 ? docs[docs.length - 2] : null;
        const fallbackTargetDoc = docs.length >= 1 ? docs[docs.length - 1] : null;
        const sourceDoc = docs.find((doc) => doc.id === compareState.docAId) || fallbackSourceDoc;
        const targetDoc = docs.find((doc) => doc.id === compareState.docBId) || fallbackTargetDoc;

        if (!sourceDoc || !targetDoc || sourceDoc.id === targetDoc.id) {
            Notify.warning('比較元と比較先を選択してください。');
            return;
        }

        const confirmed = await Notify.confirm(
            `選択中の2文書に対してAI差分解析を実行しますか？<br><br><strong>比較元:</strong> ${escapeHtmlText(buildDocumentOptionLabel(sourceDoc))}<br><strong>比較先:</strong> ${escapeHtmlText(buildDocumentOptionLabel(targetDoc))}`,
            { title: '解析開始', type: 'info', okText: '解析開始', cancelText: 'キャンセル' }
        );
        if (!confirmed) return;

        await this.analyzeDocumentPair(contractId, sourceDoc, targetDoc, { force: true });
    }

    async analyzeDocumentPair(contractId, sourceDoc, targetDoc, options = {}) {
        const contract = dbService.getContractById(contractId);
        if (!contract || !sourceDoc || !targetDoc) return;
        const force = options.force === true;
        const silent = options.silent === true;
        const docs = dbService.getDocumentsByContractId(contractId);
        const storedContractAnalysis = buildStoredContractAnalysis(contract);
        const structuredFallbackAnalysis = buildStructuredFallbackAnalysis(sourceDoc.content, targetDoc.content);
        const hasStructuredDifferences = Boolean(structuredFallbackAnalysis?.changes?.length);
        const canReuseStoredAnalysis = !force
            && isCurrentVsLatestHistoryPair(docs, sourceDoc, targetDoc)
            && hasAnalysisRecord(storedContractAnalysis)
            && storedContractAnalysis?.isFallback !== true;

        const diffPayload = {
            summary: '選択した2文書の差分結果です。',
            riskLevel: 1,
            riskReason: '差分抽出済み',
            changes: []
        };
        let requestedRemoteAnalysis = false;

        try {
            // Check Usage Limit (Only for manual, non-cached analysis)
            if (!canReuseStoredAnalysis && !silent) {
                const count = Number(this.subscription?.usageCount || 0);
                const limit = Number(this.subscription?.usageLimit || 0);
                if (count >= limit) {
                    this.showAnalysisLimitError({ currentUsage: count, limit: limit });
                    return;
                }
            }
            if (!silent) {
                Notify.info('AI差分解析を実行中...');
            }

            const sourceType = String(contract?.source_type || '').toUpperCase();
            const isPdfSource = sourceType === 'PDF' || (contract?.original_filename || '').toLowerCase().endsWith('.pdf');

            if (canReuseStoredAnalysis) {
                Object.assign(diffPayload, storedContractAnalysis);
            } else if (targetDoc.is_current && contract.source_url) {
                requestedRemoteAnalysis = true;
                const result = await aiService.analyzeContract(contractId, 'url', contract.source_url, sourceDoc.content);
                if (!result.success) throw new Error(result.error || '差分解析に失敗しました');
                Object.assign(diffPayload, result.data || {});
            } else if (targetDoc.is_current && isPdfSource) {
                const pdfUrl = this.getRuntimePdfPreviewUrl(contractId) || contract.pdf_url;
                if (!pdfUrl) {
                    diffPayload.summary = 'PDF原本が保持されていないため、AI差分解析は実行せず構造化比較のみ表示します。';
                    diffPayload.riskReason = '原本未保持';
                } else {
                    const response = await fetch(pdfUrl);
                    if (!response.ok) throw new Error('PDF原本の取得に失敗しました');
                    const blob = await response.blob();
                    const file = new File([blob], targetDoc.document_name || contract.original_filename || 'contract.pdf', { type: blob.type || 'application/pdf' });
                    const base64 = await aiService.convertFileToBase64(file);
                    requestedRemoteAnalysis = true;
                    const result = await aiService.analyzeContract(contractId, 'pdf', base64, sourceDoc.content);
                    if (!result.success) throw new Error(result.error || '差分解析に失敗しました');
                    Object.assign(diffPayload, result.data || {});
                }
            } else {
                const currentPayload = isStructuredDocumentContent(targetDoc.content)
                    ? targetDoc.content
                    : contentToComparableText(targetDoc.content);
                requestedRemoteAnalysis = true;
                const result = await aiService.analyzeContract(contractId, 'text', currentPayload, sourceDoc.content);
                if (!result.success) throw new Error(result.error || '差分解析に失敗しました');
                Object.assign(diffPayload, result.data || {});
            }

            const diffChanges = Array.isArray(diffPayload.changes) ? diffPayload.changes.filter(Boolean) : [];
            if (hasStructuredDifferences) {
                diffPayload.changes = mergeStructuredChangesWithAnalysis(structuredFallbackAnalysis.changes, diffChanges);
                if (
                    isExplicitNoDiffAnalysis(diffPayload)
                    || diffPayload.isFallback === true
                    || diffPayload.aiFailed === true
                    || !hasMeaningfulAiSummary(diffPayload)
                ) {
                    diffPayload.summary = structuredFallbackAnalysis.summary;
                    diffPayload.riskLevel = structuredFallbackAnalysis.riskLevel;
                    diffPayload.riskReason = structuredFallbackAnalysis.riskReason || '変更点を表示しています';
                    diffPayload.isFallback = true;
                } else {
                    diffPayload.isFallback = false;
                }
            }

            if (!hasAnalysisRecord(diffPayload) && canReuseStoredAnalysis) {
                Object.assign(diffPayload, storedContractAnalysis);
            }

            dbService.saveDiffResult({
                docA_id: sourceDoc.id,
                docB_id: targetDoc.id,
                diff_data: diffPayload,
                created_at: new Date().toISOString()
            });
            if (isCurrentVsLatestHistoryPair(docs, sourceDoc, targetDoc)) {
                dbService.updateContractAnalysis(contractId, {
                    summary: diffPayload.summary,
                    riskLevel: diffPayload.riskLevel,
                    riskReason: diffPayload.riskReason,
                    changes: Array.isArray(diffPayload.changes) ? diffPayload.changes : [],
                    isFallback: diffPayload.isFallback === true,
                    aiFailed: diffPayload.aiFailed === true,
                    status: '未確認'
                });
            }
            if (requestedRemoteAnalysis) {
                await this.refreshSubscriptionStatusSafe();
            }
            dbService.touchRecentDiff(sourceDoc.id, targetDoc.id);
            this.setDocumentCompareState({
                contractId,
                docAId: sourceDoc.id,
                docBId: targetDoc.id
            });
            this.navigate('diff', contractId);
        } catch (error) {
            console.error('analyzeDocumentPair error:', error);
            if (error.code === 'ANALYSIS_LIMIT_EXCEEDED') {
                this.showAnalysisLimitError(error);
            } else if (!silent) {
                Notify.error(`AI解析中にエラーが発生しました: ${error.message}`);
            }
        }
    }

    viewHistory(contractId, version) {
        const contract = dbService.getContractById(contractId);
        if (!contract || !Array.isArray(contract.history)) return;

        const historyItem = contract.history.find(h => h.version === version);
        if (!historyItem) return;

        document.querySelectorAll('.modal').forEach(m => m.remove());

        const panes = document.querySelectorAll('.pane');
        if (panes.length < 2) {
            this.navigate('diff', contractId);
            setTimeout(() => this.viewHistory(contractId, version), 300);
            return;
        }

        const rightPane = panes[1];
        const rightHeader = rightPane.querySelector('.pane-header');
        if (rightHeader) {
            rightHeader.classList.add('history-preview-header');
            rightHeader.style.background = '#f7f2e4';
            rightHeader.style.borderBottom = '1px solid #eadfbe';
            rightHeader.innerHTML = `
                <div class="history-preview-bar">
                    <div class="history-preview-copy">
                        <div class="history-preview-eyebrow">
                            <i class="fa-solid fa-clock-rotate-left"></i>
                            履歴プレビュー
                        </div>
                        <div class="history-preview-name" title="${escapeHtmlText(historyItem.original_filename || contract.original_filename || contract.name || '履歴資料')}">
                            ${escapeHtmlText(historyItem.original_filename || contract.original_filename || contract.name || '履歴資料')}
                        </div>
                        <div class="history-preview-meta">
                            取込日時: ${escapeHtmlText(formatDisplayTimestamp(historyItem.date) || '-')}
                        </div>
                    </div>
                    <div class="history-preview-actions">
                        <button class="btn-dashboard history-preview-primary" onclick="window.app.compareHistoryWithBase(${contractId}, ${version})">
                            <i class="fa-solid fa-code-compare"></i> BASE資料と比較
                        </button>
                        <button class="btn-dashboard history-preview-secondary" onclick="window.app.clearHistoryComparisonContext(${contractId}); window.app.navigate('diff', ${contractId})">
                            <i class="fa-solid fa-rotate-left"></i> 最新版に戻す
                        </button>
                    </div>
                </div>
            `;
        }

        const tabsRow = rightPane.querySelector('.tabs-row');
        if (tabsRow) tabsRow.style.display = 'none';

        const scrollArea = rightPane.querySelector('.pane-scroll-area');
        if (scrollArea) {
            scrollArea.scrollTop = 0;
            scrollArea.style.background = '#f6f7f9';

            const historyContentHtml = isStructuredDocumentContent(historyItem.content)
                ? `<div class="is-structured">${renderStructuredView(historyItem.content, `hist-${contractId}-${version}`)}</div>`
                : `<div class="document-content-full is-frameless">${escapeHtmlText(historyItem.content).replace(/\r?\n/g, '<br>')}</div>`;

            scrollArea.innerHTML = `
                <div style="padding:18px;">
                    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:12px; margin-bottom:16px;">
                        <div style="background:#fff; border:1px solid #e5e7eb; border-radius:12px; padding:14px;">
                            <div style="font-size:11px; color:#7b8794; margin-bottom:6px;">履歴資料</div>
                            <div style="font-size:14px; font-weight:700; color:#1f2937; word-break:break-word;">${escapeHtmlText(historyItem.original_filename || contract.original_filename || contract.name || '-')}</div>
                        </div>
                        <div style="background:#fff; border:1px solid #e5e7eb; border-radius:12px; padding:14px;">
                            <div style="font-size:11px; color:#7b8794; margin-bottom:6px;">取込日時</div>
                            <div style="font-size:14px; font-weight:700; color:#1f2937;">${escapeHtmlText(formatDisplayTimestamp(historyItem.date) || '-')}</div>
                        </div>
                        <div style="background:#fff; border:1px solid #e5e7eb; border-radius:12px; padding:14px;">
                            <div style="font-size:11px; color:#7b8794; margin-bottom:6px;">比較先(BASE)</div>
                            <div style="font-size:14px; font-weight:700; color:#1f2937; word-break:break-word;">${escapeHtmlText(contract.original_filename || contract.name || '-')}</div>
                        </div>
                    </div>
                    <div class="document-paper-container is-frameless">
                        <div class="document-content-full">
                            <div class="document-top-anchor" aria-hidden="true"></div>
                            ${historyContentHtml || '<div class="text-center text-muted" style="padding:40px;">履歴データがありません</div>'}
                        </div>
                    </div>
                </div>
            `;
        }
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

    async shareReport(contractId) {
        const contract = dbService.getContractById(contractId);
        if (!contract) return;

        const riskLabel = contract.risk_level || 'Low';
        const summary = contract.ai_summary || '解析データなし';
        const name = contract.original_filename || contract.name || '契約書';
        const shareUrl = `${window.location.origin}/dashboard.html#diff/${contractId}`;

        const shareText = `【DIFFsense 解析レポート】\n📄 ${name}\n⚠️ リスク: ${riskLabel}\n\n${summary}\n\n${shareUrl}`;

        // Web Share APIが使える場合はネイティブ共有
        if (navigator.share) {
            try {
                await navigator.share({
                    title: `DIFFsense - ${name}`,
                    text: shareText,
                    url: shareUrl
                });
                return;
            } catch (e) {
                // ユーザーがキャンセルした場合は何もしない
                if (e.name === 'AbortError') return;
            }
        }

        // フォールバック: クリップボードにコピー
        try {
            await navigator.clipboard.writeText(shareText);
            Notify.success('レポート内容をクリップボードにコピーしました');
        } catch (e) {
            // clipboard APIも使えない場合
            const textarea = document.createElement('textarea');
            textarea.value = shareText;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
            Notify.success('レポート内容をクリップボードにコピーしました');
        }
    }

    async exportPDF(contractId) {
        if (!['pro', 'business'].includes(this.subscription?.plan)) return;
        const contract = dbService.getContractById(contractId);
        if (!contract) return;

        this.showToast('PDFレポートを生成中...', 'info');

        try {
            await this.ensurePdfLibraries();

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

                const canvas = await window.html2canvas(section, {
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

    async showAnalysisLimitError(error = {}) {
        let cu = error.currentUsage;
        let lim = error.limit;
        let next = error.nextPlan;

        // Preemptive check or missing fields fallback
        if (cu === undefined || lim === undefined) {
            cu = Number(this.subscription?.usageCount || 0);
            lim = Number(this.subscription?.usageLimit || 0);
        }

        if (!next) {
            const plan = this.subscription?.plan || 'free';
            const nextPlanMap = {
                'free': { name: 'Starter', limit: 50, price: '¥1,480' },
                'trial': { name: 'Starter', limit: 50, price: '¥1,480' },
                'starter': { name: 'Business', limit: 120, price: '¥4,980' },
                'business': { name: 'Pro', limit: 400, price: '¥9,800' },
                'pro': null
            };
            next = nextPlanMap[plan];
        }
        
        let message = `今月のAI差分チェック回数の上限（${cu}/${lim}回）を使い切りました。`;
        let okText = 'プランを表示';
        
        if (next) {
            message += `<br><br>${next.name}プラン（${next.price}/月）にアップグレードすると、月${next.limit}回まで解析できます。`;
            okText = '今すぐアップグレード';
        } else {
            message += `<br><br>来月までお待ちいただくか、より上位のプランについてお問い合わせください。`;
        }

        const confirmed = await Notify.confirm(message, {
            title: '解析回数の上限に達しました',
            type: 'warning',
            okText: okText,
            cancelText: '閉じる',
            okStyle: 'primary'
        });

        if (confirmed) {
            const planId = next ? String(next.name).toLowerCase() : 'starter';
            this.startStripeCheckout(planId);
        }
    }

    async startStripeCheckout(planId) {
        // Show loading toast or overlay if needed
        const loadingNotify = Notify.info('決済ページへ移動中...', { duration: 0 });

        try {
            // Get ID Token
            const user = auth.currentUser;
            if (!user) {
                // Wait a bit for auth state if not immediately available
                await new Promise(resolve => {
                    const unsubscribe = onAuthStateChanged(auth, (user) => {
                        unsubscribe();
                        resolve(user);
                    });
                    setTimeout(resolve, 3000); // Timeout fallback
                });
            }

            const currentUser = auth.currentUser;
            let token = null;
            if (currentUser) {
                token = await currentUser.getIdToken();
            }

            const apiBase = getApiBaseUrl();
            const headers = { 'Content-Type': 'application/json' };
            if (token) headers.Authorization = `Bearer ${token}`;

            const res = await fetch(`${apiBase}/api/createCheckoutSession`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    plan: planId,
                    billingCycle: 'monthly',
                    cancelUrl: window.location.href
                })
            });

            const result = await res.json();
            if (result.success && result.data?.url) {
                sessionStorage.setItem('stripe_checkout_started', 'true');
                window.location.href = result.data.url;
            } else {
                throw new Error(result.error || '決済ページを開けませんでした');
            }
        } catch (error) {
            console.error('Stripe Checkout Error:', error);
            Notify.error(`決済ページの読み込みに失敗しました: ${error.message}`);
            // Fallback to select-plan.html if API fails
            setTimeout(() => {
                window.location.href = `/select-plan.html?plan=${planId}`;
            }, 2000);
        } finally {
            if (loadingNotify && loadingNotify.close) loadingNotify.close();
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









