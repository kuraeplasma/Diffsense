/**
 * SignViewer - Signature Detail Viewer Logic (provider embed + pdf.js)
 */

import { dbService } from './db-service.js?v=20260519_sign_storage_fix_v2';
import { Notify } from './notify.js';
import { buildSignDocumentPreviewHtml } from './sign-document-preview.js?v=20260402_signpreview_plain1';
import { isDocxFileName, renderDocxPreviewPages, wrapPreviewPageShell, renderDocxPreviewAsEditor } from './sign-docx-preview.js?v=20260517_center_pages_fix';
import { resolveBackendAssetUrl, toApiUrl } from './api-base-safe.js?v=20260329_api_base_safe1';

const externalScriptPromises = new Map();

function loadExternalScriptOnce(src, isReady) {
    if (typeof isReady === 'function' && isReady()) return Promise.resolve();
    if (externalScriptPromises.has(src)) return externalScriptPromises.get(src);

    const promise = new Promise((resolve, reject) => {
        const existing = Array.from(document.scripts || []).find(script => script.src === src);
        if (existing) {
            existing.addEventListener('load', () => resolve(), { once: true });
            existing.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), { once: true });
            if (typeof isReady === 'function' && isReady()) resolve();
            return;
        }

        const script = document.createElement('script');
        script.src = src;
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`Failed to load ${src}`));
        document.head.appendChild(script);
    });
    externalScriptPromises.set(src, promise);
    return promise;
}

// Dashboard boundary markers:
// 修正案 card copy keeps 検出したリスク / 提案する条文 / このリスクを抑えるため / 反映済み（最終版で確認）.
// Final preview/export controls keep 元に戻す / 最終版プレビュー / PDF出力 / _normalizeFinalLayoutText.

async function fetchDocxBlob(url, headers = {}) {
    if (!url) return null;
    const resp = await fetch(url, { headers });
    if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
    }
    const contentType = String(resp.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('text/html')) {
        throw new Error(`HTML response received from ${url}`);
    }
    const blob = await resp.blob();
    const head = await blob.slice(0, 12).text().catch(() => '');
    if (/^\s*(?:<!doctype|<html|<head|<body|<style|not found|404\b)/i.test(head)) {
        throw new Error(`HTML/error payload received from ${url}`);
    }
    return blob;
}

function stripHtmlFallbackText(text) {
    const raw = String(text || '').trim();
    if (!raw) return '';
    const looksLikeHtml = /<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]|<style[\s>]|<script[\s>]/i.test(raw);
    const looksLikeErrorPage = looksLikeHtml && /(404|not found|cannot get|error)/i.test(raw.slice(0, 2000));
    const looksLikeCssDump = /(?:^|\n)\s*(?:body|html|\.container|#app)\s*\{[^}]{5,}\}/i.test(raw);
    if (looksLikeErrorPage || looksLikeCssDump) return '';
    if (!looksLikeHtml) return raw;

    const div = document.createElement('div');
    div.innerHTML = raw;
    div.querySelectorAll('style, script, link, meta, title').forEach(el => el.remove());
    return String(div.innerText || div.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * DOCX編集プレビュー用のソースを取得する (メモリ/IDB/サーバー)
 */
async function getDocxSourceForEditor(viewer) {
    const contract = viewer._contract || {};
    const request = viewer._currentRequest || {};
    const contractId = contract.id || request.contract_id || request.contractId || viewer._currentContractId;
    console.log('[DOCX EDITOR] source resolver v20260515_docx_editor_dom_v127', {
        contractId,
        original_filename: contract.original_filename,
        original_file_path: contract.original_file_path,
        docx_url: contract.docx_url,
        asset_path: contract.asset_path,
        storage_path: contract.storage_path
    });

    // 1. アップロード時にメモリ保持しているBlobがあればそれを使う
    const memBlob = viewer._originalFileBlob || viewer._uploadedBlob || viewer._docxBlob;
    if (memBlob instanceof Blob) return memBlob;

    if (viewer._app && typeof viewer._app.getRuntimeOriginalPreviewFile === 'function') {
        const runtimeFile = viewer._app.getRuntimeOriginalPreviewFile(contractId);
        if (runtimeFile instanceof Blob) return runtimeFile;
    }

    // 2. IDBキャッシュ
    try {
        if (viewer._app && typeof viewer._app.getDocxFromIDB === 'function') {
            const cached = await viewer._app.getDocxFromIDB(contractId);
            if (cached instanceof Blob) return cached;
        }
    } catch (e) {
        console.warn('[DOCX EDITOR] IDB fetch failed:', e);
    }

    // 3. サーバープロキシを優先。GCS保存パス(contracts/...docx)は /uploads では解決できないため。
    const token = await viewer._getIdTokenSafe?.();
    const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
    const rawCandidates = [
        contract.original_file_url,
        contract.original_file_path,
        contract.originalFileUrl,
        contract.originalFilePath,
        contract.docx_url,
        contract.docxUrl,
        contract.asset_path,
        contract.assetPath,
        contract.storage_path,
        contract.storagePath,
        contract.file_url,
        contract.fileUrl,
        contract.original_url,
        contract.originalUrl,
        request.original_file_url,
        request.original_file_path,
        request.docx_url,
        request.asset_path,
        request.storage_path
    ].filter(Boolean);
    const urls = [];
    if (contractId && rawCandidates.length > 0) {
        // The export route knows how to download Firebase Storage paths such as
        // contracts/{id}/original-....docx. The original-file route only serves
        // local /uploads files in some backend versions, so keep it as fallback.
        urls.push(toApiUrl(`/api/contracts/${encodeURIComponent(contractId)}/export?format=docx`));
        urls.push(toApiUrl(`/contracts/${encodeURIComponent(contractId)}/export?format=docx`));
        urls.push(toApiUrl(`/api/contracts/${encodeURIComponent(contractId)}/original-file`));
        urls.push(toApiUrl(`/contracts/${encodeURIComponent(contractId)}/original-file`));
    }
    rawCandidates
        .map(value => resolveBackendAssetUrl(value))
        .filter(Boolean)
        .forEach(url => urls.push(url));

    for (const url of [...new Set(urls)]) {
        try {
            const blob = await fetchDocxBlob(url, headers);
            if (blob) return blob;
        } catch (e) {
            console.warn('[DOCX EDITOR] DOCX fetch failed:', url, e);
        }
    }

    return null;
}

export const SignViewer = {
    async loadPdfJs() {
        if (this._pdfjsLoaded) return;
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.min.js';
            script.onload = () => {
                window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';
                this._pdfjsLoaded = true;
                resolve();
            };
            script.onerror = reject;
            document.head.appendChild(script);
        });
    },
    _pdfjsLoaded: false,
    _activePage: 1,
    _totalPages: 1,
    _objectUrls: [],
    _initSeq: 0,
    _inFlightRequestId: null,
    _isDashboardMode: false,
    _uiTriggered: false,
    _pdfDoc: null,
    _scale: 1.0,
    _offsetX: 0,
    _offsetY: 0,
    _viewInitialized: false,
    _renderSeq: 0,
    _viewMode: 'original',
    _renderMode: 'pdf', // 'pdf' or 'image'
    _contract: null,
    _viewerContainer: null,
    _originalPageCount: null,
    _pageObservers: new Map(),
    _imageRenderedPages: [],
    DEBUG: false, // Set to true to enable logs

    log(...args) {
        if (this.DEBUG) console.log('[SignViewer]', ...args);
    },

    async _getIdTokenSafe() {
        try {
            const authModule = await import('./auth.js?v=20260514_viewer_auth_safe');
            return await authModule.getIdToken();
        } catch (error) {
            console.warn('[SignViewer] auth token unavailable; continuing without token:', error);
            return '';
        }
    },

    formatJstDateTime(value, includeSeconds = false) {
        const date = new Date(value || '');
        if (Number.isNaN(date.getTime())) return '-';
        return date.toLocaleString('ja-JP', {
            timeZone: 'Asia/Tokyo',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            ...(includeSeconds ? { second: '2-digit' } : {})
        });
    },

    /**
     * Initialize the viewer for a specific request
     */
    async init(app, id) {
        const requestId = String(id ?? '').trim();
        if (!requestId) {
            Notify.error('契約が見つかりません');
            app.navigate('sign');
            return;
        }
        if (this._inFlightRequestId === requestId) {
            console.debug('SignViewer init skipped duplicate request:', requestId);
            return;
        }
        const initSeq = ++this._initSeq;
        this._inFlightRequestId = requestId;
        this.log('Initializing SignViewer for ID:', requestId);
        this.cleanupObjectUrls();
        this.cleanupPageObservers();
        this._activePage = 1;
        this._scale = 1.0;
        this._currentPdfUrl = null;
        this._currentDownloadUrl = null;
        this._currentRequest = null;

        try {
            const request = typeof dbService.getSignRequestById === 'function'
                ? await dbService.getSignRequestById(requestId)
                : (await dbService.getSignRequests()).find((item) => String(item?.id) === requestId);
            if (initSeq !== this._initSeq) return;

            if (!request) {
                Notify.error('契約が見つかりません');
                app.navigate('sign');
                return;
            }

            const container = document.getElementById('sign-viewer-content');
            if (!container) return;
            this._currentRequest = request;
            this._isDashboardMode = false;

            // 1. Check if provider embedding is needed
            const actionId = this.findPendingActionId(request);

            const providerRequestId = request.firma_request_id || request.zoho_request_id;
            if (providerRequestId && actionId && request.status !== 'completed') {
                await this.renderZohoSign(providerRequestId, actionId, container, request.firma_request_id ? 'Firma' : 'Zoho Sign');
            } else {
                // 2. Otherwise show the PDF using pdf.js
                const snapshot = request.document_snapshot || request.contract_snapshot || null;
                const liveContract = dbService.getContractById(request.contract_id) || null;
                const contract = liveContract ? { ...(snapshot || {}), ...liveContract } : snapshot;
                const previewContract = {
                    ...(contract || {}),
                    original_content: contract?.original_content || snapshot?.original_content || '',
                    source_url: contract?.source_url || snapshot?.source_url || ''
                };
                const runtimeUrl = (typeof app.getRuntimePdfPreviewUrl === 'function') ? app.getRuntimePdfPreviewUrl(request.contract_id) : null;
                const persistedOriginalUrl = resolveBackendAssetUrl(previewContract?.original_file_url || previewContract?.original_file_path);
                const completedDocumentUrl = this.getCompletedDocumentApiUrl(request);
                const rawPdfUrl = completedDocumentUrl || runtimeUrl || previewContract?.pdf_url || previewContract?.pdf_storage_path || request.completed_document_url || persistedOriginalUrl;
                const pdfUrl = resolveBackendAssetUrl(rawPdfUrl);

                // Check if it's a real PDF file or just a reference
                const normalizedPdfUrl = String(pdfUrl || '').trim().toLowerCase();
                const isActuallyPdf = Boolean(pdfUrl) && (
                    normalizedPdfUrl.startsWith('blob:')
                    || /\.pdf($|[?#])/i.test(String(pdfUrl || ''))
                    || normalizedPdfUrl.includes('/uploads/')
                    || this.isCompletedDocumentProxyUrl(pdfUrl)
                );
                const runtimeDoc = (typeof app.getRuntimeOriginalPreviewFile === 'function')
                    ? app.getRuntimeOriginalPreviewFile(request.contract_id)
                    : null;
                const originalName = previewContract?.original_filename || persistedOriginalUrl || '';
                const hasFallbackContent = this._hasOriginalTextFallback(previewContract);
                const runtimeDocx = Boolean(runtimeDoc && isDocxFileName(runtimeDoc.name || originalName));
                const persistedDocx = Boolean(persistedOriginalUrl && isDocxFileName(originalName));
                const rawPdfLooksDocx = /\.docx?($|[?#])/i.test(String(rawPdfUrl || ''));
                this._originalFileUrl = persistedOriginalUrl;
                this._originalFileName = originalName;

                const selectedSourceIsPersistedDocx = Boolean(
                    persistedDocx
                    && pdfUrl
                    && persistedOriginalUrl
                    && String(pdfUrl) === String(persistedOriginalUrl)
                );

                // Priority decision for rendering:
                // 1. If we have a real PDF URL, use the PDF renderer.
                // 2. Otherwise if it's a runtime DOCX blob, use docx-preview.js.
                // 3. Otherwise if it's a persisted DOCX URL, use docx-preview.js.
                // 4. Fallback to text.
                const canUsePdfRenderer = isActuallyPdf;

                // Set explicit render mode
                this._renderMode = 'pdf';
                this.log('Selected render mode:', this._renderMode);

                if (canUsePdfRenderer) {
                    const rendered = await this.renderPdf(pdfUrl, container);
                    if (!rendered && hasFallbackContent) {
                        await this.renderTextFallback(previewContract, container);
                    } else if (!rendered) {
                        await this.renderUnavailableDocument(previewContract, container);
                    }
                } else if (runtimeDocx) {
                    await this.renderDocx(runtimeDoc, container);
                } else if (persistedDocx) {
                    await this.renderDocx(persistedOriginalUrl, container);
                } else if (hasFallbackContent) {
                    // Fallback: Show original text for web/crawled contracts
                    await this.renderTextFallback(previewContract, container);
                } else {
                    container.innerHTML = `
                        <div style="text-align:center; color:var(--text-muted); padding:60px;">
                            <i class="fa-solid fa-file-circle-exclamation" style="font-size:64px; margin-bottom:16px;"></i>
                            <p>ドキュメントファイルが見つかりません</p>
                            ${previewContract?.source_url ? `<a href="${previewContract.source_url}" target="_blank" style="color:var(--color-primary); font-size:12px;">入力ソースを開く<i class="fa-solid fa-external-link"></i></a>` : ''}
                        </div>
                    `;
                }
            }
            
            if (initSeq !== this._initSeq) return;
            this.setupEventListeners(app, request);

            const auditContainer = document.getElementById('audit-events-list');
            if (auditContainer) {
                try {
                    const token = await this._getIdTokenSafe();
                    if (initSeq !== this._initSeq) return;
                    const res = await fetch(toApiUrl(`/api/sign/${requestId}/audit-events`), {
                        headers: { 'Authorization': token ? `Bearer ${token}` : '' }
                    });
                    const json = await res.json();
                    if (json.success && json.data.length > 0) {
                        const eventLabels = {
                            created: '📝 作成',
                            signed: '✍️ 署名完了',
                            declined: '❌ 拒否',
                            completed: '✅ 完了',
                            viewed: '👁 閲覧'
                        };
                        auditContainer.innerHTML = json.data.map((ev) => `
                            <div style="display:flex; gap:10px; padding:8px 0; border-bottom:1px solid #f0f0f0; font-size:12px;">
                                <div style="white-space:nowrap; color:var(--text-muted);">
                                    ${this.formatJstDateTime(ev.timestamp, true)}
                                </div>
                                <div>
                                    <span>${eventLabels[ev.event] || this.escapeHtml(ev.event)}</span>
                                    <span style="color:#888; margin-left:6px;">${this.escapeHtml(ev.actorEmail || '')}</span>
                                    ${ev.ipAddress ? `<span style="color:#aaa; margin-left:6px;">IP: ${this.escapeHtml(ev.ipAddress)}</span>` : ''}
                                </div>
                            </div>
                        `).join('');
                    } else {
                        auditContainer.innerHTML = '<div style="font-size:12px; color:var(--text-muted);">利用不可</div>';
                    }
                } catch (e) {
                    console.error('逶｣譟ｻ險ｼ霍｡蜿門ｾ怜､ｱ謨・', e);
                    auditContainer.innerHTML = '<div style="font-size:12px; color:var(--text-muted);">蜿門ｾ怜､ｱ謨・/div>';
                }
            }
        } finally {
            if (this._inFlightRequestId === requestId) {
                this._inFlightRequestId = null;
            }
        }
    },

    cleanupPageObservers() {
        if (this._pageObservers) {
            this._pageObservers.forEach(obs => obs.disconnect());
            this._pageObservers.clear();
        }
    },

    findPendingActionId(request) {
        if (!request.actions || !Array.from(request.actions).length) {
            // Check recipients as fallback
            const pendingRec = request.recipients?.find(r => r.status === 'pending');
            return pendingRec?.action_id || null;
        }
        // Return first action ID for now
        return request.actions[0].action_id;
    },

    /**
     * Renders Zoho Sign Embedded Iframe
     */
    async renderZohoSign(requestId, actionId, container, providerLabel = 'Zoho Sign') {
        container.innerHTML = `
            <div style="display:flex; flex-direction:column; align-items:center; width:100%; height:100%;">
                <div style="padding:10px; background:#fff; width:100%; text-align:center; font-size:12px; border-bottom:1px solid #eee;">
                    <i class="fa-solid fa-shield-halved"></i> ${providerLabel} セキュア・組み込み設定
                </div>
                <div id="zoho-iframe-container" style="flex:1; width:100%; position:relative;">
                    <div class="loader-spinner" style="position:absolute; top:50%; left:50%; transform:translate(-50%, -50%);"></div>
                    <p style="position:absolute; top:60%; width:100%; text-align:center; color:#888;">設定ページを読み込み中...</p>
                </div>
            </div>
        `;

        const iframeContainer = document.getElementById('zoho-iframe-container');
        
        try {
            const embedUrl = await dbService.getEmbeddedSignUrl(requestId, actionId);
            if (!embedUrl) throw new Error('Could not retrieve signing URL');

            iframeContainer.innerHTML = `
                <iframe src="${embedUrl}" 
                        style="width:100%; height:100%; border:none;" 
                        allow="camera; geolocation"
                        onload="this.previousElementSibling?.remove();">
                </iframe>
            `;
        } catch (error) {
            console.error('Embedded sign loading error:', error);
            iframeContainer.innerHTML = `
                <div style="padding:40px; text-align:center; color:#ea4335;">
                    <i class="fa-solid fa-triangle-exclamation" style="font-size:48px; margin-bottom:16px;"></i>
                    <p>${providerLabel}の読み込みに失敗しました<br><span style="font-size:12px;">${this.escapeHtml(error.message)}</span></p>
                </div>
            `;
        }
    },

    /**
     * Renders PDF using pdf.js with interactive controls
     */
    async renderPdf(url, container, mountId = 'pdf-pages-container') {
        try {
            // Determine mode if not already set (e.g. direct call)
            if (!this._renderMode) {
                const hasImages = Boolean(this._contract?.page_images?.length || this._contract?.pageImages?.length);
                const isDocx = isDocxFileName(this._contract?.original_filename || this._originalFileName || '');
                this._renderMode = (isDocx && hasImages) ? 'image' : 'pdf';
            }

            this._currentPdfUrl = await this.resolvePdfViewerUrl(url);
        } catch (error) {
            console.error('PDF URL resolve error:', error);
            if (await this._renderOriginalTextFallbackIfAvailable(container, mountId)) return false;
            if (this._viewMode === 'original' && container) {
                await this.renderUnavailableDocument(this._contract || {}, container);
            }
            return false;
        }
        this._currentDownloadUrl = this._currentDownloadUrl || this._currentPdfUrl;
        this._currentScale = this._currentScale || 1.2;

        const isDash = this._isDashboardMode;
        let scrollEl = document.getElementById('pdf-viewer-scroll');
        if (!scrollEl) {
            container.innerHTML = `
                <div class="pdf-viewer-wrapper" style="position:absolute; inset:0; display:flex; flex-direction:column; overflow:hidden; background:${isDash ? '#f1f5f9' : '#525659'};">
                    ${isDash ? `
                    <div id="v3-viewer-toolbar" style="flex-shrink:0; z-index:100; background:transparent; border:none;"></div>
                    ` : `
                    <div style="display:flex; align-items:center; justify-content:flex-end; gap:8px; padding:14px 18px; background:#2d3136; color:white; border-bottom:1px solid #444;">
                        <div style="display:flex; align-items:center; gap:8px;">
                            <button class="btn-pdf-tool" onclick="window.signViewer.zoomOut()"><i class="fa-solid fa-minus"></i></button>
                            <span id="zoom-percent" style="font-size:13px; min-width:45px; text-align:center;">${Math.round((this._scale || 1.0) * 100)}%</span>
                            <button class="btn-pdf-tool" onclick="window.signViewer.zoomIn()"><i class="fa-solid fa-plus"></i></button>
                        </div>
                    </div>
                    `}
                    <div id="pdf-viewer-scroll" style="flex:1; min-height:0; width:100%; overflow:auto; background:${isDash ? '#f1f5f9' : 'transparent'}; cursor:grab; touch-action:pan-y; z-index:10; padding:${isDash ? '4px 0' : '0'}; box-sizing:border-box; display:flex; flex-direction:column; align-items:center; justify-content:flex-start;">
                        <!-- Layer 1: PDF -->
                        <div id="pdf-pages-container" class="document-page" style="display:none; flex-shrink:0; margin:0;"></div>
                        <!-- Layer 2: DOCX -->
                        <div id="sign-viewer-docx-pages" style="display:none; flex-shrink:0; margin:0 auto;"></div>
                        <!-- Layer 3: Revised -->
                        <div id="v3-revised-layer" style="display:none; width:100%;"></div>
                        <!-- Layer 4: Final Edit -->
                        <div id="v3-edit-layer" style="display:none; width:100%; height:100%;"></div>
                        
                        <!-- Premium Loader -->
                        <div id="viewer-loader" style="position:absolute; top:50%; left:50%; transform:translate(-50%, -50%); display:none; flex-direction:column; align-items:center; gap:12px; z-index:100;">
                            <div class="v3-premium-ring"></div>
                            <span style="font-size:11px; font-weight:700; color:#3b82f6; letter-spacing:1px;">LOADING</span>
                        </div>
                    </div>
                </div>
                <style>
                    .v3-premium-ring {
                        width: 40px; height: 40px; border-radius: 50%;
                        border: 3px solid #e2e8f0; border-top-color: #3b82f6;
                        animation: v3-spin 0.8s infinite cubic-bezier(0.5, 0, 0.5, 1);
                    }
                    @keyframes v3-spin { to { transform: rotate(360deg); } }
                </style>
            `;
            scrollEl = document.getElementById('pdf-viewer-scroll');
        }
        this._setOriginalViewerBottomSpace(this._isDashboardMode && (this._viewMode === 'original' || this._viewMode === 'final'));

        const pagesContainer = document.getElementById(mountId);
        const docxContainer = document.getElementById('sign-viewer-docx-pages');
        const revisedLayer = document.getElementById('v3-revised-layer');
        const editLayer = document.getElementById('v3-edit-layer');
        const loader = document.getElementById('viewer-loader');

        if (pagesContainer) {
            pagesContainer.style.display = (this._viewMode === 'original' || this._viewMode === 'final') ? 'block' : 'none';
            if (docxContainer && mountId !== 'sign-viewer-docx-pages') docxContainer.style.display = 'none';
        }
        if (loader) loader.style.display = 'block';
        if (!this._currentPdfUrl) {
            this._totalPages = 1;
            this._activePage = 1;
            if (loader) loader.style.display = 'none';
            this.renderDashboardUI();
            return false;
        }

        // OPTIMIZATION: If we are already showing this URL at the current zoom, just unhide and skip re-render.
        const requestedZoom = Math.max(0.3, Math.min(3.0, Number(this._scale || 1.0)));
        const renderedZoom = Number(pagesContainer.dataset.renderedZoom || 0);
        const renderedSource = pagesContainer.dataset.renderedSource || '';
        const isSameZoom = Math.abs(renderedZoom - requestedZoom) < 0.01;
        const isAlreadyRendered = this._pdfDoc
            && this._pdfDoc._sourceUrl === this._currentPdfUrl
            && renderedSource === this._currentPdfUrl
            && pagesContainer.children.length > 0
            && isSameZoom;
        if (isAlreadyRendered) {
            if (loader) loader.style.display = 'none';
            this.renderDashboardUI();
            return true;
        }

        const rendered = (this._renderMode === 'image')
            ? await this.renderImageMode(mountId)
            : await this.renderPdfMode(mountId);
            
        if (!rendered) return false;

        // 邨ｱ荳縺輔ｌ縺滓桃菴懶ｼ医ラ繝ｩ繝・げ遘ｻ蜍輔√ぜ繝ｼ繝・峨ｒPDF繝薙Η繝ｼ繧｢縺ｫ繧る←逕ｨ
        if (scrollEl && !scrollEl._interactiveInit) {
            scrollEl._interactiveInit = true;
            this.setupInteractiveViewer(scrollEl, pagesContainer);
        }
        return true;
    },

    _setOriginalViewerBottomSpace(enabled) {
        const scrollEl = document.getElementById('pdf-viewer-scroll');
        if (!scrollEl) return;
        if (enabled) {
            scrollEl.style.paddingBottom = '96px';
            scrollEl.style.scrollPaddingBottom = '96px';
        } else {
            scrollEl.style.paddingBottom = '';
            scrollEl.style.scrollPaddingBottom = '';
        }
    },

    triggerDashboardUI() {
        if (this._isDashboardMode && typeof this.renderDashboardUI === 'function') {
            this.renderDashboardUI();
        }
    },

    hideViewerLoader() {
        const loader = document.getElementById('viewer-loader');
        if (loader) loader.style.display = 'none';
    },

    _setFinalActionBarVisible(visible) {
        const bar = document.getElementById('v3-final-action-bar');
        if (bar) bar.style.display = visible ? 'flex' : 'none';
    },

    _renderFinalActionBar() {
        const editorScroll = document.getElementById('v3-editor-scroll');
        const editorVisible = editorScroll && editorScroll.offsetParent !== null;
        if (this._viewMode === 'edit' || editorVisible) {
            this._setFinalActionBarVisible(false);
            return;
        }
        const scrollEl = document.getElementById('pdf-viewer-scroll');
        if (!scrollEl) return;
        const wrapper = scrollEl.closest('.pdf-viewer-wrapper') || scrollEl.parentElement;
        if (!wrapper) return;

        let bar = document.getElementById('v3-final-action-bar');
        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'v3-final-action-bar';
        }
        if (bar.parentElement !== wrapper || bar.nextElementSibling !== scrollEl) {
            wrapper.insertBefore(bar, scrollEl);
        }
        bar.style.cssText = [
            'width:calc(100% - 32px)',
            'max-width:none',
            'margin:8px auto 18px auto',
            'background:#fff',
            'border-radius:12px',
            'box-shadow:0 4px 16px rgba(15,23,42,0.08)',
            'padding:12px 24px',
            'box-sizing:border-box',
            'align-items:center',
            'gap:12px',
            'flex-wrap:wrap',
            'flex-shrink:0',
            'z-index:20'
        ].join(';');

        const hasSavedFinal = Boolean(this._contract?.final_content || this._contract?.final_content_html);
        const isUnsaved = this._editedContent !== undefined && this._editedContent !== this._lastSavedContent;

        bar.innerHTML = `
            <span class="v3-status-badge" style="display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:700;padding:3px 10px;border-radius:20px;${isUnsaved ? 'background:#fef3c7;color:#d97706;' : (hasSavedFinal ? 'background:#dcfce7;color:#16a34a;' : 'background:#f8fafc;color:#64748b;')}">
                ${isUnsaved ? '未保存' : (hasSavedFinal ? '保存済み' : '未編集')}
            </span>
            <div style="margin-left:auto;display:flex;gap:8px;align-items:center;">
                <button onclick="window.signViewer.switchViewMode('edit')" style="display:inline-flex;align-items:center;gap:6px;background:#0b2d62;color:#fff;border:none;padding:6px 18px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;">
                    <i class="fa-solid fa-pen"></i> 編集する
                </button>
            </div>
        `;
        bar.style.display = 'flex';
    },

    _hasUsableDocxEditorPages(pageElements) {
        if (!Array.isArray(pageElements) || pageElements.length === 0) return false;
        const A4_WIDTH = 794;
        const A4_HEIGHT = 1123;
        return pageElements.every((pageEl) => {
            if (!pageEl || pageEl.nodeType !== 1) return false;
            const width = Math.max(
                Number(pageEl.dataset?.baseWidth || 0),
                Number.parseFloat(pageEl.style?.width || '') || 0,
                pageEl.offsetWidth || 0
            );
            const height = Math.max(
                Number(pageEl.dataset?.baseHeight || 0),
                Number.parseFloat(pageEl.style?.height || '') || 0,
                Number.parseFloat(pageEl.style?.minHeight || '') || 0,
                pageEl.scrollHeight || 0,
                pageEl.offsetHeight || 0
            );
            const widthOk = !width || (width >= A4_WIDTH * 0.65 && width <= A4_WIDTH * 1.35);
            const heightOk = !height || height <= A4_HEIGHT * 1.25;
            return widthOk && heightOk;
        });
    },

    async _saveFinalTextOnly() {
        const finalContent = String(this._editedContent !== undefined ? this._editedContent : this._getFinalDocumentText());
        this._editedContent = finalContent;
        this._lastSavedContent = finalContent;
        this._lastPreviewContent = finalContent;
        if (this._contract) {
            this._contract.final_content = finalContent;
            dbService.updateContract(this._contract.id, { final_content: finalContent });
        }
        this._finalLayoutGuardActive = false;
        this._renderFinalActionBar();
        Notify.success('保存しました');
    },

    _previewRenderedFinal() {
        const editorLayer = document.getElementById('v3-editor-scroll');
        const finalReadLayer = document.getElementById('v3-final-read-scroll');
        const pdfLayer = document.getElementById('pdf-pages-container');
        const docxLayer = document.getElementById('sign-viewer-docx-pages');
        
        let activeLayer = null;
        if (editorLayer && (editorLayer.style.display !== 'none' && editorLayer.children.length > 0)) {
            activeLayer = editorLayer;
        } else if (finalReadLayer && finalReadLayer.children.length > 0) {
            activeLayer = finalReadLayer;
        } else if (docxLayer && docxLayer.style.display !== 'none') {
            activeLayer = docxLayer;
        } else if (pdfLayer && pdfLayer.style.display !== 'none') {
            activeLayer = pdfLayer;
        }

        if (!activeLayer) {
            const finalContent = String(this._getFinalDocumentText() || '').trim();
            if (finalContent) {
                this._previewHandEdit();
                return;
            }
            Notify.info('最終版の内容がまだありません');
            return;
        }

        document.getElementById('final-rendered-preview-overlay')?.remove();
        const overlay = document.createElement('div');
        overlay.id = 'final-rendered-preview-overlay';
        // ポップアップ化: 全画面ではなく中央配置のモーダル。背景は半透明 backdrop
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.55);z-index:99999;display:flex;align-items:center;justify-content:center;padding:32px;box-sizing:border-box;';
        // backdrop クリックで閉じる（モーダル自体のクリックは伝播停止）
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

        const shell = document.createElement('div');
        shell.style.cssText = 'width:min(900px, 100%);height:min(85vh, 1200px);display:flex;flex-direction:column;background:#f1f5f9;border-radius:14px;box-shadow:0 24px 60px rgba(15,23,42,0.35);overflow:hidden;';
        shell.addEventListener('click', (e) => e.stopPropagation());
        shell.innerHTML = `
            <div style="height:54px;background:#0b2d62;color:#fff;display:flex;align-items:center;justify-content:space-between;padding:0 22px;box-sizing:border-box;flex-shrink:0;">
                <span style="font-size:14px;font-weight:800;">最終版プレビュー</span>
                <button onclick="document.getElementById('final-rendered-preview-overlay')?.remove()" style="width:32px;height:32px;border-radius:8px;border:none;background:rgba(255,255,255,0.14);color:#fff;cursor:pointer;font-size:16px;line-height:1;">×</button>
            </div>
            <div id="final-rendered-preview-body" style="flex:1;overflow:auto;padding:24px 0;box-sizing:border-box;display:flex;justify-content:center;"></div>
        `;
        overlay.appendChild(shell);
        document.body.appendChild(overlay);

        const body = shell.querySelector('#final-rendered-preview-body');
        const stack = document.createElement('div');
        stack.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:48px;max-width:calc(100% - 40px);';
        body.appendChild(stack);

        if (activeLayer === pdfLayer) {
            const pages = activeLayer.querySelectorAll('div[data-page]');
            pages.forEach((page) => {
                const canvas = page.querySelector('canvas');
                if (!canvas) return;
                const img = document.createElement('img');
                try {
                    img.src = canvas.toDataURL('image/png');
                } catch (_error) {
                    return;
                }
                img.style.cssText = `display:block;width:${page.style.width || `${canvas.clientWidth}px`};height:auto;background:#fff;box-shadow:0 10px 32px rgba(15,23,42,0.18);`;
                stack.appendChild(img);
            });
            if (!stack.children.length) {
                overlay.remove();
                // 画像 canvas が無い = docx contract 等。 _previewHandEdit にフォールバック
                if (typeof this._previewHandEdit === 'function') {
                    this._previewHandEdit();
                }
            }
            return;
        }

        if (activeLayer === editorLayer || activeLayer === finalReadLayer) {
            const pages = activeLayer.querySelectorAll('.v3-editor-page, .v3-rich-editor-body');
            pages.forEach(p => {
                const pClone = p.cloneNode(true);
                pClone.style.cssText = 'background:#fff; box-shadow:0 10px 32px rgba(15,23,42,0.18); margin-bottom:48px; position:relative; display:block; padding:40px; box-sizing:border-box;';
                pClone.style.width = p.style.width || '800px';
                stack.appendChild(pClone);
            });
            return;
        }

        // Phase 3: DOCXプレビューのレイアウト崩れ対策
        // 元の sign-viewer-docx-pages を ID 付きでクローンしつつ、不要な class（display:none 等）を除去
        // 各 editor-page-shell を白紙・影付きで縦並びに見せる
        if (activeLayer === docxLayer) {
            // マーカーCSSを必ず注入（プレビューでも見えるように）
            if (typeof this._ensureGlobalMarkerStyles === 'function') this._ensureGlobalMarkerStyles();
            // プレビュー専用 CSS を1度だけ注入
            // - 内部 section の min-height: 792pt を解除（自然サイズ）
            // - 二重ボックス問題: shell は透明、section が実際のページ（白紙＋影）になる
            // - マーカー表示は OFF（クリーンなプレビュー）
            if (!document.getElementById('v3-preview-overlay-style')) {
                const previewStyle = document.createElement('style');
                previewStyle.id = 'v3-preview-overlay-style';
                previewStyle.textContent = `
                    #final-rendered-preview-overlay .editor-page-shell,
                    #final-rendered-preview-overlay .editor-page-shell section,
                    #final-rendered-preview-overlay .editor-page-shell .docx,
                    #final-rendered-preview-overlay .editor-page-shell .editor-page-wrapper,
                    #final-rendered-preview-overlay .editor-page-shell .docx-section {
                        min-height: 0 !important;
                        height: auto !important;
                        max-height: none !important;
                        overflow: visible !important;
                    }
                    /* 二重ボックス対策: outer shell は wrapper のみ、section をページとして表示 */
                    #final-rendered-preview-overlay .editor-page-shell {
                        display: block !important;
                        background: transparent !important;
                        box-shadow: none !important;
                        padding: 0 !important;
                    }
                    #final-rendered-preview-overlay .editor-page-shell > section,
                    #final-rendered-preview-overlay .editor-page-shell .editor-page-wrapper {
                        background: #ffffff !important;
                        box-shadow: 0 10px 32px rgba(15,23,42,0.18) !important;
                        margin: 0 auto !important;
                        max-width: 100% !important;
                    }
                    /* マーカー表示を OFF（プレビューはクリーン表示） */
                    #final-rendered-preview-overlay .v3-final-flow-change,
                    #final-rendered-preview-overlay .v3-applied-change,
                    #final-rendered-preview-overlay .v3-applied-change-add,
                    #final-rendered-preview-overlay .v3-applied-change-modify,
                    #final-rendered-preview-overlay .v3-applied-change-delete,
                    #final-rendered-preview-overlay .v3-applied-change-clar,
                    #final-rendered-preview-overlay .v3-applied-line,
                    #final-rendered-preview-overlay .v3-applied-line-add,
                    #final-rendered-preview-overlay .v3-applied-line-modify,
                    #final-rendered-preview-overlay .v3-applied-line-delete,
                    #final-rendered-preview-overlay .v3-applied-line-clar {
                        background-color: transparent !important;
                        background-image: none !important;
                        box-shadow: none !important;
                        text-decoration: none !important;
                        border-bottom: none !important;
                        color: inherit !important;
                        padding: 0 !important;
                    }
                `;
                document.head.appendChild(previewStyle);
            }
            // シェル構造を排除し、共通ヘルパー _paginateChildrenIntoA4Pages を使う
            const pageShells = activeLayer.querySelectorAll('.editor-page-shell');
            if (pageShells.length > 0) {
                pageShells.forEach((shell) => {
                    const txt = String(shell.innerText || '').replace(/\s+/g, '');
                    if (txt.length < 3) return;
                    const source = shell.querySelector('section') || shell;
                    const pages = this._paginateChildrenIntoA4Pages(source);
                    pages.forEach(p => stack.appendChild(p));
                });
                return;
            }
        }
        const clone = activeLayer.cloneNode(true);
        clone.removeAttribute('id');
        clone.style.cssText = [
            'background:#fff',
            'box-shadow:0 10px 32px rgba(15,23,42,0.18)',
            'padding:48px 56px',
            'box-sizing:border-box',
            'width:794px',
            'max-width:calc(100% - 40px)',
            'display:block',
            'transform:none',
            'zoom:1',
            'margin:0 0 48px 0',
            'overflow:visible'
        ].join(';');
        stack.appendChild(clone);
    },

    isPdfLayerActive() {
        const pdfLayer = document.getElementById('pdf-pages-container');
        return Boolean(this._currentPdfUrl && pdfLayer && pdfLayer.style.display !== 'none');
    },

    _schedulePdfZoomRender() {
        window.clearTimeout(this._pdfZoomRenderTimer);
        this._pdfZoomRenderTimer = window.setTimeout(() => {
            this._pdfZoomRenderTimer = null;
            this.refreshPdfRendering();
        }, 120);
        if (typeof this.renderDashboardUI === 'function') this.renderDashboardUI();
    },

    _handleZoomChanged({ debounce = false } = {}) {
        if (this.isPdfLayerActive()) {
            if (debounce) {
                this._schedulePdfZoomRender();
            } else {
                window.clearTimeout(this._pdfZoomRenderTimer);
                this._pdfZoomRenderTimer = null;
                void this.refreshPdfRendering();
            }
            if (typeof this.renderDashboardUI === 'function') this.renderDashboardUI();
            return;
        }
        this.updateTransform();
    },

    async renderPdfMode(mountId = 'pdf-pages-container') {
        const pagesContainer = document.getElementById(mountId);
        if (!pagesContainer || !this._currentPdfUrl) return false;
        // renderPdfMode scope内で requestedZoom を再定義 (renderPdf関数とは別 scope のため未定義参照bugを修正)
        const requestedZoom = Math.max(0.3, Math.min(3.0, Number(this._scale || 1.0)));

        // USER REQUEST 5: display:none 状態で render() を禁止する
        if (pagesContainer.offsetWidth <= 0) {
            console.warn('[PDF.js] Skipping render: container offsetWidth <= 0');
            if (!pagesContainer._resizeObserverPending) {
                pagesContainer._resizeObserverPending = true;
                const ro = new ResizeObserver((entries) => {
                    if (entries[0].target.offsetWidth > 0) {
                        ro.disconnect();
                        pagesContainer._resizeObserverPending = false;
                        this.refreshPdfRendering(mountId);
                    }
                });
                ro.observe(pagesContainer);
            }
            return false;
        }

        try {
            await this.loadPdfJs();
            
            const renderSeq = ++this._renderSeq || (this._renderSeq = 1);
            
            // Use cached PDF document if URL matches
            if (!this._pdfDoc || this._pdfDoc._sourceUrl !== this._currentPdfUrl) {
                const loadingTask = pdfjsLib.getDocument({
                    url: this._currentPdfUrl,
                    cMapUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/cmaps/',
                    cMapPacked: true,
                    standardFontDataUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/standard_fonts/',
                    useWorkerFetch: true
                });
                this._pdfDoc = await loadingTask.promise;
                this._pdfDoc._sourceUrl = this._currentPdfUrl;
            }

            if (renderSeq !== this._renderSeq) return false;

            const pdf = this._pdfDoc;
            this._totalPages = pdf.numPages;
            if (this._viewMode === 'original' && this._totalPages > 0) {
                this._originalPageCount = this._totalPages;
            }
            this._activePage = Math.max(1, Math.min(this._activePage || 1, this._totalPages || 1));

            // ============================================================
            // ■ PDF TRIAGE: PDF単体 vs Viewer問題の切り分けログ
            // このログを見て、PDFをブラウザで直接開いて崩れを確認してください
            // ============================================================
            console.log('%c[PDF DIRECT DEBUG] PDF URL (ブラウザで直接開いて崩れを確認)', 'background:#dc2626;color:#fff;font-weight:bold;padding:2px 6px;border-radius:3px;', this._currentPdfUrl);
            console.log('[PDF TRIAGE] Total pages:', this._totalPages);

            // ■2/3/5: 全ページのサイズをログ出力し、A4との乖離を検知
            const A4_W = 595.28, A4_H = 841.89; // A4 @ 72dpi (pt単位)
            const pageSizeSummary = [];
            for (let pn = 1; pn <= Math.min(this._totalPages, 3); pn++) {
                const p = await pdf.getPage(pn);
                const vp = p.getViewport({ scale: 1.0 });
                const wDiff = Math.abs(vp.width - A4_W);
                const hDiff = Math.abs(vp.height - A4_H);
                const isAbnormal = vp.width > 1200 || vp.height > 1700 || vp.width < 200 || vp.height < 200;
                const isNonA4 = wDiff > 50 || hDiff > 50;

                pageSizeSummary.push({
                    page: pn,
                    width: Math.round(vp.width * 100) / 100,
                    height: Math.round(vp.height * 100) / 100,
                    'A4差(w)': Math.round(wDiff),
                    'A4差(h)': Math.round(hDiff),
                    判定: isAbnormal ? '🔴 ABNORMAL' : isNonA4 ? '🟡 NON-A4' : '🟢 A4-OK',
                });

                if (isAbnormal) {
                    console.warn('%c[DOCX PDF WARNING] 異常なPDFページサイズを検知! LibreOffice変換問題の可能性があります。', 'background:#dc2626;color:#fff;font-weight:bold;', {
                        page: pn, width: vp.width, height: vp.height,
                        'expected(A4)': `${A4_W} × ${A4_H}`,
                        pdfUrl: this._currentPdfUrl,
                    });
                } else if (isNonA4) {
                    console.warn('%c[DOCX PDF WARNING] PDFページがA4ではありません。カスタムページサイズまたはLandscapeの可能性。', 'background:#d97706;color:#fff;font-weight:bold;', {
                        page: pn, width: vp.width, height: vp.height,
                    });
                }
            }
            console.log('%c[PDF PAGE SIZE LOG]', 'background:#7c3aed;color:#fff;font-weight:bold;padding:2px 6px;border-radius:3px;', pageSizeSummary);
            console.log(
                '[PDF TRIAGE] 切り分け手順:\n' +
                '  A: 上記URLをChromeで直接開いて崩れている → LibreOffice変換問題\n' +
                '  B: URLを開くと正常に見える → PDF.js/Viewer問題\n' +
                '  C: 🔴 ABNORMAL が出ている → LibreOffice出力PDFのページサイズ異常'
            );
            // ============================================================

            const isDash = this._isDashboardMode;


            this.cleanupPageObservers();
            pagesContainer.replaceChildren();

            // pagesContainerを先にblock表示（幅測定のため）
            pagesContainer.style.display = 'block';
            pagesContainer.style.textAlign = 'center';
            pagesContainer.style.width = '100%';
            pagesContainer.style.maxWidth = '100%';
            pagesContainer.style.transform = 'none';
            pagesContainer.style.padding = '24px 0';
            pagesContainer.style.boxSizing = 'border-box';
            pagesContainer.style.margin = '0 auto';

            // render前にDOMレイアウトを確定させる
            await new Promise(requestAnimationFrame);
            await new Promise(requestAnimationFrame);

            // === fit-to-width: 正確なコンテナ幅を取得 ===
            // 測定優先順位:
            //   1. pagesContainer の実幅（display:block後に測定）
            //   2. _viewerContainer（v3-pdf-sheet）の実幅
            //   3. scrollEl の clientWidth からスクロールバー分を除いた値
            //   4. フォールバック: 794px (A4基準)
            const scrollElFit = document.getElementById('pdf-viewer-scroll');
            const pagesRect = pagesContainer.getBoundingClientRect();
            const scrollRect = scrollElFit ? scrollElFit.getBoundingClientRect() : null;
            const viewerRect = this._viewerContainer ? this._viewerContainer.getBoundingClientRect() : null;

            let effectiveContainerWidth;
            let widthSource;

            if (pagesRect.width > 50) {
                effectiveContainerWidth = pagesRect.width;
                widthSource = 'pagesContainer.getBoundingClientRect';
            } else if (viewerRect && viewerRect.width > 50) {
                effectiveContainerWidth = viewerRect.width - 32; // 16px × 2 余白
                widthSource = '_viewerContainer.getBoundingClientRect';
            } else if (scrollRect && scrollRect.width > 50) {
                effectiveContainerWidth = scrollRect.width - 48;
                widthSource = 'scrollEl.getBoundingClientRect';
            } else if (scrollElFit && scrollElFit.clientWidth > 50) {
                effectiveContainerWidth = scrollElFit.clientWidth - 48;
                widthSource = 'scrollEl.clientWidth';
            } else {
                effectiveContainerWidth = 794;
                widthSource = 'fallback(794px A4)';
            }

            effectiveContainerWidth = Math.max(effectiveContainerWidth, 320);

            console.log('%c[PDF FIT-TO-WIDTH DEBUG]', 'background:#0ea5e9;color:#fff;font-weight:bold;padding:2px 6px;border-radius:3px;', {
                widthSource,
                'pagesContainer.rect.width': Math.round(pagesRect.width),
                'viewerContainer.rect.width': viewerRect ? Math.round(viewerRect.width) : 'N/A',
                'scrollEl.rect.width': scrollRect ? Math.round(scrollRect.width) : 'N/A',
                'scrollEl.clientWidth': scrollElFit ? scrollElFit.clientWidth : 'N/A',
                '→ effectiveContainerWidth': Math.round(effectiveContainerWidth),
            });

            const renderedNodes = document.createDocumentFragment();
            const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);

            for (let pageNum = 1; pageNum <= this._totalPages; pageNum++) {
                const page = await pdf.getPage(pageNum);

                const nativeViewport = page.getViewport({ scale: 1.0 });
                const naturalCssScale = 4 / 3;
                const fitScale = Math.min(
                    naturalCssScale * requestedZoom,
                    effectiveContainerWidth / nativeViewport.width,
                    2.5
                );
                const displayScale = Math.max(0.1, fitScale);
                const displayWidth = Math.max(1, Math.round(nativeViewport.width * displayScale));
                const renderScale = displayWidth / nativeViewport.width;
                const displayHeight = Math.max(1, Math.round(nativeViewport.height * renderScale));
                const viewport = page.getViewport({ scale: renderScale });

                console.log(`[PDF.js Page ${pageNum}]`, {
                    nativeWidth: nativeViewport.width,
                    containerWidth: effectiveContainerWidth,
                    fitScale: fitScale.toFixed(3),
                    viewportWidth: displayWidth,
                    viewportHeight: displayHeight,
                    canvasWidth: Math.round(displayWidth * pixelRatio),
                    pixelRatio
                });

                const pageShell = document.createElement('div');
                pageShell.className = 'pdf-page-shell';
                pageShell.setAttribute('data-page', String(pageNum));
                pageShell.style.cssText = [
                    'position:relative',
                    'display:block',
                    `width:${displayWidth}px`,
                    `height:${displayHeight}px`,
                    'background:#fff',
                    'box-shadow:0 8px 32px rgba(0,0,0,0.15)',
                    'margin:0 auto 16px auto',
                    'overflow:hidden',
                    'flex-shrink:0'
                ].join(';');

                const canvas = document.createElement('canvas');
                canvas.className = 'pdf-page-canvas';
                // canvas内部解像度 = viewport × pixelRatio（高解像度ディスプレイ対応）
                canvas.width = Math.round(displayWidth * pixelRatio);
                canvas.height = Math.round(displayHeight * pixelRatio);
                // CSS表示サイズは整数pxに揃え、ブラウザ側の再サンプリングを避ける
                canvas.style.cssText = `display:block;width:${displayWidth}px;height:${displayHeight}px;`;

                const context = canvas.getContext('2d', { alpha: false });

                pageShell.appendChild(canvas);
                await page.render({
                    canvasContext: context,
                    viewport,
                    transform: pixelRatio !== 1 ? [pixelRatio, 0, 0, pixelRatio, 0, 0] : null
                }).promise;

                pageShell.appendChild(this.createFieldOverlay(pageNum, viewport.width, viewport.height, nativeViewport.width, nativeViewport.height));
                renderedNodes.appendChild(pageShell);
            }

            pagesContainer.replaceChildren(renderedNodes);

            pagesContainer.dataset.renderedZoom = '1';
            pagesContainer.dataset.renderedSource = this._currentPdfUrl;

            if (isDash && !this._viewInitialized) {
                this._viewInitialized = true;
                this._scale = 1.0;
            }

            const scrollEl_final = document.getElementById('pdf-viewer-scroll');
            if (scrollEl_final && !scrollEl_final._scrollHandlerAdded) {
                scrollEl_final._scrollHandlerAdded = true;
                scrollEl_final.addEventListener('scroll', () => {
                    const shells = pagesContainer.querySelectorAll('.pdf-page-shell');
                    let bestPage = this._activePage;
                    let minDiff = Infinity;
                    const containerTop = scrollEl_final.getBoundingClientRect().top + 150;
                    shells.forEach(s => {
                        const rect = s.getBoundingClientRect();
                        const diff = Math.abs(rect.top - containerTop);
                        if (diff < minDiff) {
                            minDiff = diff;
                            bestPage = parseInt(s.dataset.page);
                        }
                    });
                    if (bestPage !== this._activePage) {
                        this._activePage = bestPage;
                        if (typeof this.renderDashboardUI === 'function') this.renderDashboardUI();
                    }
                }, { passive: true });
            }

            this.renderDashboardUI();
            this.renderPageSwitcher();
            this._scheduleToolbarCenterAlignment();
            const zoomTxt = document.getElementById('zoom-percent');
            if (zoomTxt) zoomTxt.textContent = `${Math.round(requestedZoom * 100)}%`;

            this.hideViewerLoader();
            if (this._isDashboardMode && this._contractId) {
                window.dispatchEvent(new CustomEvent('diffsense:pdf-ready', {
                    detail: {
                        contractId: this._contractId,
                        sourceUrl: this._currentPdfUrl
                    }
                }));
            }
            return true;

        } catch (error) {
            console.error('PDF.js Error:', error);
            this.hideViewerLoader();
            return false;
        }
    },

    /**
     * Render pages as high-fidelity images (fallback for DOCX)
     */
    async renderImageMode(mountId = 'pdf-pages-container') {
        const pagesContainer = document.getElementById(mountId);
        if (!pagesContainer) return false;

        const pageImages = this._contract?.page_images || this._contract?.pageImages || [];
        if (!pageImages.length) {
            this.log('No page images available for image mode');
            return false;
        }

        this.log('Using Image-based rendering mode (Fidelity Mode)', {
            count: pageImages.length
        });
        
        this.cleanupPageObservers();
        pagesContainer.replaceChildren();

        pagesContainer.style.display = 'block';
        pagesContainer.style.textAlign = 'center';
        pagesContainer.style.width = '100%';
        pagesContainer.style.maxWidth = '100%';
        pagesContainer.style.transform = 'none';
        pagesContainer.style.padding = '24px 0';
        pagesContainer.style.boxSizing = 'border-box';
        pagesContainer.style.margin = '0 auto';

        const renderedNodes = document.createDocumentFragment();
        this._totalPages = pageImages.length;
        if (this._viewMode === 'original' && this._totalPages > 0) {
            this._originalPageCount = this._totalPages;
        }
        this._activePage = Math.max(1, Math.min(this._activePage || 1, this._totalPages || 1));

        const scrollElFit = document.getElementById('pdf-viewer-scroll');
        const containerWidth = scrollElFit ? Math.max(320, scrollElFit.clientWidth - 48) : 794;
        const currentScale = this._scale || 1.0;
        const displayWidth = Math.max(320, Math.min(794 * currentScale, containerWidth, 1600));

        this._imageRenderedPages = [];

        pageImages.forEach((src, index) => {
            const pageNum = index + 1;
            const pageShell = document.createElement('div');
            pageShell.className = 'pdf-page-shell image-fallback-page image-page';
            pageShell.setAttribute('data-page', String(pageNum));
            pageShell.style.cssText = [
                'position:relative',
                'display:block',
                `width:${Math.round(displayWidth)}px`,
                'background:#fff',
                'box-shadow:0 8px 32px rgba(0,0,0,0.15)',
                'margin:0 auto 16px auto',
                'flex-shrink:0',
                'min-height:200px'
            ].join(';');

            const img = document.createElement('img');
            // src が /uploads/... 等の相対パスの場合、 frontend port (8080) でなく
            // backend port (__DOCX_PDF_SERVICE_URL__ = http://localhost:3001) に向ける。
            // これがないと frontend が 404 を返し「ページN読み込み失敗」になる。
            let resolvedSrc = src;
            if (resolvedSrc && !/^(https?:|data:|blob:)/i.test(resolvedSrc)) {
                const base = (typeof window !== 'undefined' && window.__DOCX_PDF_SERVICE_URL__)
                    ? String(window.__DOCX_PDF_SERVICE_URL__).replace(/\/$/, '')
                    : '';
                if (base) resolvedSrc = base + (resolvedSrc.startsWith('/') ? resolvedSrc : '/' + resolvedSrc);
            }
            img.src = resolvedSrc;
            img.className = 'image-content';
            img.style.cssText = 'display:block; width:100%; height:auto;';
            img.loading = 'lazy';
            img.onload = () => {
                const ratio = img.naturalHeight && img.naturalWidth ? img.naturalHeight / img.naturalWidth : 1.414;
                const displayHeight = Math.max(200, Math.round(displayWidth * ratio));
                pageShell.style.height = `${displayHeight}px`;
                if (pageNum === 1) this.hideViewerLoader();
            };
            img.onerror = () => {
                console.error(`[Image Mode] Failed to load page ${pageNum}: ${src}`);
                pageShell.innerHTML = `<div style="padding:40px;color:#ef4444;font-size:12px;">ページ ${pageNum} の読み込みに失敗しました</div>`;
            };

            pageShell.appendChild(img);
            
            try {
                // For images, we use a standard A4 aspect ratio (1.414) for the overlay
                pageShell.appendChild(this.createFieldOverlay(pageNum, displayWidth, displayWidth * 1.414, 595, 842));
            } catch (e) {
                console.warn('Field overlay failed for image mode:', e);
            }

            renderedNodes.appendChild(pageShell);
            this._imageRenderedPages.push(pageShell);
        });

        pagesContainer.appendChild(renderedNodes);
        pagesContainer.dataset.renderedZoom = String(currentScale);
        pagesContainer.dataset.renderedSource = 'image_mode';

        // Add a simple scroll spy for image mode if Dashboard
        if (this._isDashboardMode && scrollElFit && !scrollElFit._imageScrollHandler) {
             scrollElFit._imageScrollHandler = () => {
                 if (this._renderMode !== 'image') return;
                 this._syncCurrentPageFromScroll();
             };
             scrollElFit.addEventListener('scroll', scrollElFit._imageScrollHandler, { passive: true });
        }

        console.log('[SignViewer] Image mode render complete', {
            mode: this._renderMode,
            totalPages: this._totalPages,
            activePage: this._activePage
        });

        this.hideViewerLoader();
        this.renderDashboardUI();
        this._scheduleToolbarCenterAlignment();
        return true;
    },

    _syncCurrentPageFromScroll() {
        const scrollEl = document.getElementById('pdf-viewer-scroll');
        if (!scrollEl) return;
        
        const scrollPos = scrollEl.scrollTop + (scrollEl.clientHeight / 3);
        const pages = document.querySelectorAll(
            this._renderMode === 'image' 
            ? '#pdf-pages-container .image-page' 
            : '#pdf-pages-container .pdf-page-shell'
        );
        
        let foundPage = 1;
        for (const page of pages) {
            if (page.offsetTop <= scrollPos) {
                foundPage = Number(page.getAttribute('data-page'));
            } else {
                break;
            }
        }
        
        if (foundPage !== this._activePage) {
            this._activePage = foundPage;
            this.renderDashboardUI();
        }
    },

    async extractCurrentPdfText() {
        if (!this._pdfDoc) return '';
        const countArticleTokens = (text) => {
            const matches = String(text || '').match(/第\s*[\d０-９零〇一二三四五六七八九十百千]+\s*条/g);
            return matches ? matches.length : 0;
        };
        const linesByPage = [];
        for (let pageNum = 1; pageNum <= this._pdfDoc.numPages; pageNum += 1) {
            const page = await this._pdfDoc.getPage(pageNum);
            const textContent = await page.getTextContent();
            const items = (textContent.items || [])
                .map((item) => {
                    const transform = item.transform || [];
                    return {
                        text: String(item.str || '').trim(),
                        x: Number(transform[4] || 0),
                        y: Number(transform[5] || 0)
                    };
                })
                .filter((item) => item.text);

            items.sort((a, b) => {
                const yDiff = b.y - a.y;
                if (Math.abs(yDiff) > 3) return yDiff;
                return a.x - b.x;
            });

            const rows = [];
            for (const item of items) {
                let row = rows.find((candidate) => Math.abs(candidate.y - item.y) <= 3);
                if (!row) {
                    row = { y: item.y, items: [] };
                    rows.push(row);
                }
                row.items.push(item);
            }

            const pageLines = rows
                .sort((a, b) => b.y - a.y)
                .map((row) => row.items.sort((a, b) => a.x - b.x).map((item) => item.text).join(''))
                .filter(Boolean);
            const visualText = pageLines.join('\n');
            const streamText = items.map((item) => item.text).join('\n');
            const visualScore = countArticleTokens(visualText);
            const streamScore = countArticleTokens(streamText);
            linesByPage.push(streamScore > visualScore ? streamText : visualText);
        }
        return linesByPage.filter(Boolean).join('\n\n').trim();
    },

    createFieldOverlay(pageNum, viewportWidth, viewportHeight, fallbackBaseWidth = null, fallbackBaseHeight = null) {
        const overlay = document.createElement('div');
        overlay.style.position = 'absolute';
        overlay.style.inset = '0';
        overlay.style.pointerEvents = 'none';

        const request = this._currentRequest || {};
        const normalizedStatus = String(request?.status || '').toLowerCase();
        if (normalizedStatus === 'completed') {
            return overlay;
        }
        const recipients = Array.isArray(request.recipients) ? request.recipients : [];
        const signatures = request.signatures || {};
        const fields = (Array.isArray(request.fields) ? request.fields : []).filter((field) => Number(field.page || 1) === Number(pageNum));

        fields.forEach((field, index) => {
            const marker = document.createElement('div');
            const recipientIndex = Number(field.assigneeIndex ?? field.recipientIndex ?? 0);
            const recipient = recipients[recipientIndex] || null;
            const recipientLabel = recipient?.name || recipient?.display_name || recipient?.email || `鄂ｲ蜷崎・{recipientIndex + 1}`;
            const fieldId = String(field.id);
            const recipientEmail = String(recipient?.email || field?.recipientEmail || '').trim();
            const signedValue = recipientEmail ? signatures?.[recipientEmail]?.[fieldId] : null;
            const isDone = field.type === 'date'
                ? Boolean(recipient?.signedAt || recipient?.signed_at || signedValue)
                : Boolean(signedValue);
            const isCompletedRequest = normalizedStatus === 'completed';
            if (isCompletedRequest && isDone) {
                return;
            }

            const pageDims = request?.page_dimensions?.[pageNum] || request?.page_dimensions?.[String(pageNum)] || null;
            const baseWidth = Math.max(1, Number(pageDims?.width || fallbackBaseWidth || viewportWidth / Math.max(this._currentScale || 1, 0.01)));
            const baseHeight = Math.max(1, Number(pageDims?.height || fallbackBaseHeight || viewportHeight / Math.max(this._currentScale || 1, 0.01)));
            const widthPx = Math.max(24, (Number(field.width || (field.type === 'signature' ? 88 : 130)) / baseWidth) * viewportWidth);
            const heightPx = Math.max(18, (Number(field.height || (field.type === 'signature' ? 88 : 48)) / baseHeight) * viewportHeight);

            marker.style.position = 'absolute';
            marker.style.left = `${Number(field.x || 0)}%`;
            marker.style.top = `${Number(field.y || 0)}%`;
            marker.style.width = `${widthPx}px`;
            marker.style.height = `${heightPx}px`;
            marker.style.transform = 'translate(-50%, -50%)';
            marker.style.borderRadius = field.type === 'signature' ? '16px' : '12px';
            marker.style.border = isDone
                ? (isCompletedRequest ? 'none' : '2px solid rgba(29, 158, 117, 0.7)')
                : '2px dashed rgba(197, 160, 89, 0.95)';
            marker.style.background = isDone
                ? (isCompletedRequest ? 'transparent' : 'rgba(29, 158, 117, 0.08)')
                : 'rgba(197, 160, 89, 0.12)';
            marker.style.boxShadow = 'none';
            marker.style.display = 'flex';
            marker.style.alignItems = 'center';
            marker.style.justifyContent = 'center';
            marker.style.padding = isCompletedRequest && isDone ? '0' : '6px';
            marker.style.textAlign = 'center';
            marker.style.color = isDone ? '#167a5b' : '#8b6b2f';
            marker.style.fontSize = isCompletedRequest && isDone ? '10px' : '11px';
            marker.style.fontWeight = '700';
            marker.style.lineHeight = '1.45';
            marker.innerHTML = isCompletedRequest && isDone ? `
                <div style="
                    transform:translateY(-${Math.max(28, heightPx * 0.55)}px);
                    display:inline-flex;
                    align-items:center;
                    gap:6px;
                    padding:3px 8px;
                    border-radius:999px;
                    background:rgba(255,255,255,0.92);
                    border:1px solid rgba(22,122,91,0.18);
                    color:#167a5b;
                    white-space:nowrap;
                    box-shadow:0 1px 2px rgba(15,23,42,0.06);
                ">
                    <span>${field.type === 'date' ? '譌･莉俶ｬ・' : '鄂ｲ蜷肴ｬ・'} ${index + 1}</span>
                    <span style="font-size:9px; font-weight:600; opacity:0.88;">${this.escapeHtml(recipientLabel)}</span>
                </div>
            ` : `
                <div>
                    <div>${field.type === 'date' ? '日付欄' : '署名欄'} ${index + 1}</div>
                    <div style="font-size:10px; font-weight:600; opacity:0.9;">${this.escapeHtml(recipientLabel)}</div>
                    <div style="font-size:10px; font-weight:700; margin-top:2px;">${isDone ? '入力済み' : '未入力'}</div>
                </div>
            `;

            overlay.appendChild(marker);
        });

        return overlay;
    },

    setActivePage(page) {
        const editorScroll = document.getElementById('v3-editor-scroll');
        const useEditorPages = this._isDashboardMode
            && this._viewMode === 'edit'
            && editorScroll
            && this._isFinalEditorVisible();
        const pageTotal = useEditorPages
            ? this.getFinalThumbnailPageCount()
            : Math.max(1, Number(this._totalPages || 1));
        const nextPage = Math.max(1, Math.min(Number(page) || 1, pageTotal));
        
        console.log('[SignViewer] setActivePage:', {
            requested: page,
            calculated: nextPage,
            current: this._activePage,
            mode: this._renderMode
        });

        // Always allow switching if it's a different page
        const isNewPage = nextPage !== this._activePage;
        this._activePage = nextPage;
        
        if (this._isDashboardMode) {
            if (useEditorPages) {
                const targetPage = editorScroll.querySelector(`.v3-editor-page[data-page="${nextPage}"]`);
                if (targetPage) {
                    this._scrollElementToChild(editorScroll, targetPage, { behavior: 'smooth' });
                }
                this._updateFinalNavigationUi();
                this._scheduleToolbarCenterAlignment();
                return;
            }

            const scrollEl = document.getElementById('pdf-viewer-scroll');
            if (scrollEl) {
                const targetPage = this._findVisibleDocumentPage(nextPage);

                if (targetPage) {
                    this._scrollViewerToPage(targetPage, { behavior: 'smooth' });
                } else if (this._renderMode === 'pdf') {
                    this.renderPdfMode();
                } else if (this._renderMode === 'image') {
                    this.renderImageMode();
                }
            }
            
            this.renderDashboardUI();
            this._scheduleToolbarCenterAlignment();
        } else {
            this.updateVisiblePages();
        }
        
        this.renderPageSwitcher();
    },

    _findVisibleDocumentPage(pageNumber) {
        const page = Math.max(1, Number(pageNumber) || 1);
        const visible = (el) => {
            if (!el) return false;
            const style = getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden';
        };
        const docxLayer = document.getElementById('sign-viewer-docx-pages');
        const pdfLayer = document.getElementById('pdf-pages-container');
        const editLayer = document.getElementById('v3-edit-layer');

        if (visible(docxLayer)) {
            const docxPage = docxLayer.querySelector(`[data-page="${page}"]`);
            if (docxPage) return docxPage;
        }
        if (visible(pdfLayer)) {
            const pdfPage = this._renderMode === 'image'
                ? pdfLayer.querySelector(`.image-fallback-page[data-page="${page}"]`)
                : pdfLayer.querySelector(`[data-page="${page}"]`);
            if (pdfPage) return pdfPage;
        }
        if (visible(editLayer)) {
            const editorPage = editLayer.querySelector(`.v3-editor-page[data-page="${page}"]`);
            if (editorPage) return editorPage;
        }
        return document.querySelector(`#sign-viewer-docx-pages [data-page="${page}"], #pdf-pages-container [data-page="${page}"], #v3-edit-layer .v3-editor-page[data-page="${page}"]`);
    },

    _scrollViewerToPage(targetPage, { behavior = 'auto' } = {}) {
        const scrollEl = document.getElementById('pdf-viewer-scroll');
        if (!scrollEl || !targetPage) return;

        this._scrollElementToChild(scrollEl, targetPage, { behavior });
    },

    _scrollElementToChild(scrollEl, targetPage, { behavior = 'auto' } = {}) {
        if (!scrollEl || !targetPage) return;

        const scrollRect = scrollEl.getBoundingClientRect();
        const pageRect = targetPage.getBoundingClientRect();
        const topPadding = this._isDashboardMode ? 24 : 0;
        const targetTop = scrollEl.scrollTop + pageRect.top - scrollRect.top - topPadding;

        scrollEl.scrollTo({
            top: Math.max(0, Math.round(targetTop)),
            left: scrollEl.scrollLeft,
            behavior
        });
    },

    // 修正案マーカー（カードギャラリー準拠の配色）をどのレンダリングパスでも有効にする
    _ensureGlobalMarkerStyles() {
        if (document.getElementById('v3-marker-global-style')) return;
        const style = document.createElement('style');
        style.id = 'v3-marker-global-style';
        style.textContent = `
            /* 最終版・編集モードのページを必ず中央配置 (JS の flex-start 設定を !important で上書き) */
            #v3-editor-content-container {
                justify-content: center !important;
            }
            #pdf-viewer-scroll {
                justify-content: flex-start !important;
                align-items: center !important;
            }
            #v3-editor-content-container .v3-editor-page,
            #sign-viewer-docx-pages .is-a4-paginated > section,
            #sign-viewer-docx-pages .editor-page-shell {
                margin-left: auto !important;
                margin-right: auto !important;
            }
            /* docx layer の内部レイアウトは中央寄せ。
               ⚠️ #sign-viewer-docx-pages 自体には display を強制しないこと。
               修正案タブで docxLayer.style.display='none' される処理を尊重する。 */
            #sign-viewer-docx-pages > .sign-docx-render-root,
            #sign-viewer-docx-pages > .sign-docx-render-root > .docx-wrapper {
                align-items: center !important;
                justify-content: flex-start !important;
                width: 100% !important;
            }
            /* 修正案カードギャラリー準拠の最終版マーカー（DOCX/PDF/HTMLすべて共通） */
            .v3-applied-change { padding:0 1px; box-decoration-break:clone; -webkit-box-decoration-break:clone; }
            .v3-applied-change-add { background:linear-gradient(transparent 12%, #c7d2fe 12%, #c7d2fe 88%, transparent 88%) !important; border-bottom:2px solid #6366f1 !important; color:#312e81 !important; }
            .v3-applied-change-modify { background:linear-gradient(transparent 12%, #bfdbfe 12%, #bfdbfe 88%, transparent 88%) !important; border-bottom:2px solid #3b82f6 !important; color:#1e3a8a !important; }
            .v3-applied-change-delete { background:linear-gradient(transparent 12%, #fecaca 12%, #fecaca 88%, transparent 88%) !important; border-bottom:2px solid #ef4444 !important; text-decoration:line-through !important; text-decoration-color:#dc2626 !important; text-decoration-thickness:2px !important; color:#7f1d1d !important; }
            .v3-applied-change-clar { background:linear-gradient(transparent 12%, #a5f3fc 12%, #a5f3fc 88%, transparent 88%) !important; border-bottom:2px solid #06b6d4 !important; color:#164e63 !important; }

            .v3-applied-line { border-radius:3px; }
            .v3-applied-line-add { background-color:rgba(199, 210, 254, 0.55) !important; box-shadow:inset 0 -2px 0 rgba(99, 102, 241, 0.7) !important; }
            .v3-applied-line-modify { background-color:rgba(191, 219, 254, 0.55) !important; box-shadow:inset 0 -2px 0 rgba(59, 130, 246, 0.7) !important; }
            .v3-applied-line-delete { background-color:rgba(254, 202, 202, 0.55) !important; box-shadow:inset 0 -2px 0 rgba(239, 68, 68, 0.8) !important; text-decoration:line-through !important; text-decoration-color:#dc2626 !important; text-decoration-thickness:2px !important; color:#7f1d1d !important; }
            .v3-applied-line-clar { background-color:rgba(165, 243, 252, 0.55) !important; box-shadow:inset 0 -2px 0 rgba(6, 182, 212, 0.7) !important; }

            /* 旧レガシークラスもカード配色に統一 */
            .v3-final-flow-change {
                background-color:rgba(199, 210, 254, 0.55) !important;
                background-image:none !important;
                border-radius:2px !important;
                padding:2px 4px !important;
                box-shadow:inset 0 -2px 0 rgba(99,102,241,0.7) !important;
                box-decoration-break:clone !important;
                -webkit-box-decoration-break:clone !important;
            }
            .v3-final-flow-change[data-final-change-kind="modify"] {
                background-color:rgba(191, 219, 254, 0.55) !important;
                box-shadow:inset 0 -2px 0 rgba(59,130,246,0.7) !important;
            }
            .v3-final-flow-change[data-final-change-kind="delete"] {
                background-color:rgba(254, 202, 202, 0.55) !important;
                box-shadow:inset 0 -2px 0 rgba(239,68,68,0.8) !important;
                text-decoration:line-through !important;
                text-decoration-color:#dc2626 !important;
                text-decoration-thickness:2px !important;
                color:#7f1d1d !important;
            }
            .v3-final-flow-change[data-final-change-kind="clar"] {
                background-color:rgba(165, 243, 252, 0.55) !important;
                box-shadow:inset 0 -2px 0 rgba(6,182,212,0.7) !important;
            }
        `;
        document.head.appendChild(style);
    },

    updateVisiblePages() {
        this._ensureGlobalMarkerStyles();
        const ap = this._activePage;
        let style = document.getElementById('docx-page-vis-style');
        if (!style) {
            style = document.createElement('style');
            style.id = 'docx-page-vis-style';
            document.head.appendChild(style);
        }
        if (this._isDashboardMode) {
            style.textContent = `
                #sign-viewer-docx-pages .editor-page-shell { display: block !important; }
                #sign-viewer-docx-pages section { display: block !important; }
            `;
            return;
        }
        style.textContent = `
            #sign-viewer-docx-pages .editor-page-shell { display: none !important; }
            #sign-viewer-docx-pages .editor-page-shell[data-page="${ap}"] { display: block !important; }
        `;

        const docxMount = document.getElementById('sign-viewer-docx-pages');
        if (docxMount) {
            return;
        }

        // For PDF / Standard mode
        document.querySelectorAll('#pdf-pages-container > div[data-page]').forEach((pageShell) => {
            if (!this._isDashboardMode) {
                pageShell.style.display = 'inline-block';
            }
        });
    },

    renderPageSwitcher() {
        const root = document.getElementById('sign-viewer-page-switcher');
        if (!root) return;
        const total = Math.max(1, Number(this._totalPages || 1));
        root.innerHTML = `
            <div class="sign-page-switcher-summary">
                <span class="sign-page-switcher-value">${this._activePage} / ${total}</span>
            </div>
            <div class="sign-page-switcher-actions">
                <button class="btn-dashboard" ${this._activePage <= 1 ? 'disabled' : ''} onclick="window.signViewer.setActivePage(${this._activePage - 1})">
                    <i class="fa-solid fa-chevron-left"></i>
                </button>
                <button class="btn-dashboard" ${this._activePage >= total ? 'disabled' : ''} onclick="window.signViewer.setActivePage(${this._activePage + 1})">
                    <i class="fa-solid fa-chevron-right"></i>
                </button>
            </div>
        `;
    },

    zoomIn() {
        if (this._isDashboardMode) {
            this._currentScale = Math.min(3.0, (this._currentScale || 1.0) + 0.1);
            this._applyZoom();
            return;
        }
        if (this._currentScale >= 3.0) return;
        this._currentScale += 0.2;
        this.refreshPdfRendering();
    },

    zoomOut() {
        if (this._isDashboardMode) {
            this._currentScale = Math.max(0.3, (this._currentScale || 1.0) - 0.1);
            this._applyZoom();
            return;
        }
        if (this._currentScale <= 0.5) return;
        this._currentScale -= 0.2;
        this.refreshPdfRendering();
    },

    _applyZoom() {
        const z = this._scale || 1.0;
        const centeredDocumentMode = this._isDashboardMode && ['original', 'final', 'edit'].includes(this._viewMode);
        const ox = centeredDocumentMode ? 0 : (this._offsetX || 0);
        const oy = centeredDocumentMode ? 0 : (this._offsetY || 0);
        const tf = `translate(${ox}px, ${oy}px)`;

        const apply = (id) => {
            const el = document.getElementById(id);
            if (!el || el.style.display === 'none') return;
            if (id === 'sign-viewer-docx-pages' && centeredDocumentMode) {
                el.style.zoom = 1;
                el.style.transform = 'none';
                el.style.transformOrigin = 'center top';
                el.style.width = '100%';
                el.style.marginLeft = 'auto';
                el.style.marginRight = 'auto';
                el.style.flexDirection = 'column';
                el.style.alignItems = 'center';
                el.style.justifyContent = 'flex-start';
                el.querySelectorAll('.editor-page-shell, .docx-wrapper > section').forEach(page => {
                    page.style.zoom = z;
                    page.style.marginLeft = 'auto';
                    page.style.marginRight = 'auto';
                    page.style.transform = 'none';
                    page.style.transformOrigin = 'center top';
                });
                return;
            }
            el.style.zoom = id === 'pdf-pages-container' && this._currentPdfUrl ? 1 : z;
            el.style.transform = centeredDocumentMode ? 'none' : tf;
            el.style.transformOrigin = 'center top';
        };

        apply('pdf-pages-container');
        apply('sign-viewer-docx-pages');
        apply('v3-revised-content');
        
        // Editor pages zoom
        const editorPages = document.querySelectorAll('.v3-editor-page');
        editorPages.forEach(p => {
            p.style.zoom = z;
            p.style.marginLeft = 'auto';
            p.style.marginRight = 'auto';
            p.style.transform = 'none';
            p.style.transformOrigin = 'center top';
        });
        this._centerDocumentLayers();
        this._scheduleToolbarCenterAlignment();

        if (typeof this.renderDashboardUI === 'function') this.renderDashboardUI();
    },

    _centerDocumentLayers() {
        const editorContent = document.getElementById('v3-editor-content-container');
        if (editorContent) {
            editorContent.style.width = '100%';
            editorContent.style.marginLeft = 'auto';
            editorContent.style.marginRight = 'auto';
            editorContent.style.alignItems = 'center';
            editorContent.style.justifyContent = 'flex-start';
        }

        const docxLayer = document.getElementById('sign-viewer-docx-pages');
        if (docxLayer) {
            docxLayer.style.width = '100%';
            docxLayer.style.marginLeft = 'auto';
            docxLayer.style.marginRight = 'auto';
        }

        const pdfLayer = document.getElementById('pdf-pages-container');
        if (pdfLayer) {
            pdfLayer.style.width = '100%';
            pdfLayer.style.marginLeft = 'auto';
            pdfLayer.style.marginRight = 'auto';
        }

        document.querySelectorAll(
            '#v3-editor-scroll .v3-editor-page, #sign-viewer-docx-pages .editor-page-shell, #pdf-pages-container .pdf-page-shell'
        ).forEach(page => {
            page.style.marginLeft = 'auto';
            page.style.marginRight = 'auto';
        });
    },

    _scheduleToolbarCenterAlignment() {
        if (!this._isDashboardMode) return;
        window.cancelAnimationFrame?.(this._toolbarCenterAlignFrame);
        this._toolbarCenterAlignFrame = window.requestAnimationFrame?.(() => {
            this._toolbarCenterAlignFrame = null;
            this._alignDocumentToToolbarCenter();
        });
    },

    _getVisibleDocumentCenterTarget() {
        const candidates = [
            {
                container: document.getElementById('v3-editor-content-container'),
                page: document.querySelector(`#v3-editor-scroll .v3-editor-page[data-page="${this._activePage || 1}"]`)
                    || document.querySelector('#v3-editor-scroll .v3-editor-page')
            },
            {
                container: document.getElementById('sign-viewer-docx-pages'),
                page: document.querySelector(`#sign-viewer-docx-pages [data-page="${this._activePage || 1}"]`)
                    || document.querySelector('#sign-viewer-docx-pages .editor-page-shell, #sign-viewer-docx-pages section')
            },
            {
                container: document.getElementById('pdf-pages-container'),
                page: document.querySelector(`#pdf-pages-container [data-page="${this._activePage || 1}"]`)
                    || document.querySelector('#pdf-pages-container .pdf-page-shell')
            }
        ];

        return candidates.find(({ container, page }) => {
            if (!container || !page) return false;
            const containerStyle = window.getComputedStyle(container);
            const pageRect = page.getBoundingClientRect();
            return containerStyle.display !== 'none' && pageRect.width > 40 && pageRect.height > 40;
        }) || null;
    },

    _alignDocumentToToolbarCenter() {
        if (!this._isDashboardMode) return;
        const toolbar = document.getElementById('v3-viewer-toolbar') || document.querySelector('#v3-edit-layer .v3-editor-toolbar');
        const target = this._getVisibleDocumentCenterTarget();
        if (!toolbar || !target) return;

        const toolbarRect = toolbar.getBoundingClientRect();
        target.container.style.transform = 'none';
        target.container.dataset.toolbarCenterOffset = '0';
        const pageRect = target.page.getBoundingClientRect();
        if (toolbarRect.width <= 40 || pageRect.width <= 40) return;

        const toolbarCenter = toolbarRect.left + toolbarRect.width / 2;
        const pageCenter = pageRect.left + pageRect.width / 2;
        const nextOffset = 0; // Disable dynamic translateX offsets since elements are perfectly centered by CSS
        if (Math.abs(nextOffset) < 0.5) {
            target.container.dataset.toolbarCenterOffset = '0';
            target.container.style.transform = 'none';
            target.container.style.transformOrigin = 'center top';
            return;
        }

        target.container.dataset.toolbarCenterOffset = String(nextOffset);
        target.container.style.transform = `translateX(${nextOffset}px)`;
        target.container.style.transformOrigin = 'center top';
        target.container.style.willChange = 'transform';
    },

    updateTransform() {
        this._applyZoom();
    },

    zoomIn() {
        this._scale = Math.min(3.0, (this._scale || 1.0) + 0.1);
        this._handleZoomChanged();
    },

    zoomOut() {
        this._scale = Math.max(0.3, (this._scale || 1.0) - 0.1);
        this._handleZoomChanged();
    },

    _getViewerEl() {
        return document.getElementById('pdf-viewer-scroll') || document.getElementById('sign-viewer-docx-scroll');
    },

    _zoomAt(newScale, anchorX, anchorY) {
        // Keep the point (anchorX, anchorY) in viewer-local coordinates fixed while scaling
        const ratio = newScale / this._scale;
        this._offsetX = anchorX + (this._offsetX - anchorX) * ratio;
        this._offsetY = anchorY + (this._offsetY - anchorY) * ratio;
        this._scale = newScale;
    },

    async switchViewMode(mode) {
        // Regression markers: mode === 'final' / await this.renderHandEditMode(container);
        if (mode !== 'final') {
            this._finalLayoutGuardActive = false;
        }
        if (mode === 'final') {
            this._activePage = 1;
            this._resetFinalTabScrollPosition();
        }
        this._viewMode = mode;
        const container = this._viewerContainer;
        if (!container) return;
        container.classList.toggle('is-final-view', mode === 'final');
        // 最終版モード切替時、 render完了後に削除型反映済の text を取消し線+赤色で視覚化
        // (render path が docx-section/docx-smart-page > span 経由のため既存snippet markが当たらない問題対策)
        if (mode === 'final') {
            setTimeout(() => { try { this._applyDeletionMarkersToFinalDom?.(); } catch(_) {} }, 1500);
            setTimeout(() => { try { this._applyDeletionMarkersToFinalDom?.(); } catch(_) {} }, 3500);
        }

        const pdfLayer = document.getElementById('pdf-pages-container');
        const docxLayer = document.getElementById('sign-viewer-docx-pages');
        const revisedLayer = document.getElementById('v3-revised-layer');
        const editLayer = document.getElementById('v3-edit-layer');
        const layers = [pdfLayer, docxLayer, revisedLayer, editLayer];

        // Hide all layers first
        layers.forEach(l => { if (l) l.style.display = 'none'; });
        if (mode !== 'final') {
            document.querySelectorAll('.v3-final-applied-overlay').forEach(node => node.remove());
        }
        this.hideViewerLoader();
        this._setOriginalViewerBottomSpace(mode === 'original');
        this._setFinalActionBarVisible(false);
        if (mode !== 'edit' && mode !== 'final') document.getElementById('v3-saved-action-bar')?.remove();

        if (mode === 'revised') {
            if (revisedLayer) {
                revisedLayer.style.display = 'block';
                // Strictly ensure other layers are hidden to prevent bleed-through
                if (pdfLayer) pdfLayer.style.display = 'none';
                if (docxLayer) docxLayer.style.display = 'none';
                this.renderModifiedDocument(container);
            }
        } else if (mode === 'edit') {
            if (editLayer) {
                editLayer.style.display = 'block';
                await this.renderHandEditMode(container);
            }
        } else if (mode === 'final') {
            await this.renderFinalOriginalLayout(container);
        } else {
            // 蜴滓悽 PDF陦ｨ遉ｺ
            if (pdfLayer) {
                pdfLayer.style.display = 'block';
                await this.renderOriginalForContract(this._app, this._contract, this._currentRequest?.contract_id || this._currentRequest?.contractId);
            }
        }
        this.renderDashboardUI();
    },

    _resetFinalTabScrollPosition() {
        const reset = () => {
            [
                document.getElementById('pdf-viewer-scroll'),
                document.getElementById('v3-final-read-scroll'),
                document.getElementById('v3-editor-scroll')
            ].filter(Boolean).forEach(scrollEl => {
                scrollEl.scrollTop = 0;
                scrollEl.scrollLeft = 0;
            });
            this._activePage = 1;
            this._updateFinalNavigationUi?.();
        };
        reset();
        requestAnimationFrame(() => {
            reset();
            requestAnimationFrame(reset);
        });
    },

    async renderFinalOriginalLayout(container) {
        const previousMode = this._viewMode;
        if (this._finalGeneratedPdfUrl) {
            this._viewMode = 'final';
            this._renderMode = 'pdf';
            await this.renderPdf(this._finalGeneratedPdfUrl, this._viewerContainer || container);
            this._setOriginalViewerBottomSpace(true);
            this.renderDashboardUI();
            this._renderFinalActionBar();
            return;
        }

        const finalText = String(this._getFinalDocumentText() || '').trim();
        if (finalText) {
            this._viewMode = 'final';
            this.renderFinalReadMode(container, { showToolbar: false });
            this._setOriginalViewerBottomSpace(false);
            this._renderFinalActionBar();
            this._resetFinalTabScrollPosition();
            return;
        }

        this._viewMode = 'original';
        await this.renderOriginalForContract(
            this._app,
            this._contract,
            this._currentRequest?.contract_id || this._currentRequest?.contractId
        );
        this._viewMode = previousMode || 'final';
        this._finalRecoveredFromOriginal = true;
        this._setOriginalViewerBottomSpace(true);
        this.renderDashboardUI();
        this._renderFinalActionBar();
    },

    async _renderFinalAppliedOverlays() {
        const changes = this._getActiveSortedAiChanges();
        // .v3-final-applied-overlay は純粋なマーカー overlay 要素なので削除して OK
        document.querySelectorAll('.v3-final-applied-overlay').forEach(node => node.remove());
        document.querySelectorAll('.v3-final-flow-change').forEach(node => {
            const index = Number(node.dataset?.finalChangeIndex);
            const change = Number.isInteger(index) ? changes?.[index] : null;
            const kind = String(node.dataset?.finalChangeKind || '').toLowerCase();
            if (kind === 'add' || (change && this._isAdditionChange(change))) {
                node.remove();
            }
        });
        // ⚠️ v3-final-flow-change はマーカークラスがコンテンツ段落に付与されているため、
        // ノードごと削除すると段落のテキストが消失する。クラスとデータ属性のみ削除して中身は残す。
        document.querySelectorAll('.v3-final-flow-change').forEach(node => {
            node.classList.remove('v3-final-flow-change');
            try { delete node.dataset.finalChangeIndex; } catch (e) {}
            try { delete node.dataset.finalChangeKind; } catch (e) {}
        });
        // A4 ページ化された旧 wrapper も再描画前に除去
        document.querySelectorAll('#sign-viewer-docx-pages .is-a4-paginated').forEach(node => node.remove());
        // 隠していた元シェルを再表示
        document.querySelectorAll('#sign-viewer-docx-pages .editor-page-shell[data-hidden-by-a4-pagination="1"]').forEach(s => {
            s.style.removeProperty('display');
            s.removeAttribute('hidden');
            if (s.hasAttribute('data-page-a4-backup')) {
                s.setAttribute('data-page', s.getAttribute('data-page-a4-backup'));
                s.removeAttribute('data-page-a4-backup');
            }
            try { delete s.dataset.hiddenByA4Pagination; } catch (e) {}
        });
        const applied = this._getAppliedIndexesForFinalView(changes);
        if (!changes.length || applied.size === 0) {
            // 適用済み変更がなくても、最終版表示時は A4 ページネーションを適用
            this._applyA4PaginationToDocxLayer();
            return;
        }

        if (this._applyFinalChangesIntoDocxFlow(changes, applied)) {
            // B6: 最終版もプレビュー同等の A4 ページ表示に
            this._applyA4PaginationToDocxLayer();
            return;
        }

        for (const index of applied) {
            const change = changes[index];
            if (!change) continue;
            const text = this._getFinalAppliedTextForChange(change, index);
            if (!text) continue;
            const target = await this._findFinalOverlayTarget(change, index);
            this._addFinalAppliedOverlay(target, change, index, text);
        }
        this._applyA4PaginationToDocxLayer();
    },

    // B6 共通ヘルパー: 与えられた section の子要素を A4 高さで分割し、ページ section の配列を返す
    _paginateChildrenIntoA4Pages(sourceSection, options = {}) {
        const PAGE_WIDTH = options.pageWidth || 794;
        const PAGE_HEIGHT = options.pageHeight || 1123;
        // 編集モード (.v3-editor-page) と統一: padding 96/72、フォント Noto Serif JP 14px/21px、color #111
        // → 編集→保存→最終版→印刷の全画面で同じレイアウト・改ページ位置になる
        const PADDING_V = options.paddingV !== undefined ? options.paddingV : 96;
        const PADDING_H = options.paddingH !== undefined ? options.paddingH : 72;
        const CONTENT_HEIGHT = PAGE_HEIGHT - PADDING_V * 2;
        const widthSpec = options.widthSpec || `min(${PAGE_WIDTH}px, calc(100% - 24px))`;
        const pageBaseStyle = [
            'background:#ffffff',
            'box-shadow:0 10px 32px rgba(15,23,42,0.18)',
            'margin:0 auto 28px auto',
            `padding:${PADDING_V}px ${PADDING_H}px`,
            'box-sizing:border-box',
            `width:${widthSpec}`,
            'max-width:100%',
            'display:block',
            'transform:none',
            'zoom:1',
            'overflow:visible',
            `min-height:${PAGE_HEIGHT}px`,
            'height:auto',
            'max-height:none',
            'position:relative',
            'page-break-after:always',
            // 編集モードと同じフォント・色・行高 (レイアウト統一)
            'font-family:"Noto Serif JP","Yu Mincho","MS Mincho",serif',
            'font-size:14px',
            'line-height:21px',
            'color:#111'
        ].join(';');
        const createPage = () => {
            const p = document.createElement('section');
            p.className = 'docx-section preview-page is-a4-page';
            p.style.cssText = pageBaseStyle;
            return p;
        };
        const measure = document.createElement('div');
        measure.style.cssText = `position:absolute;visibility:hidden;left:-99999px;top:0;width:${PAGE_WIDTH - PADDING_H * 2}px;box-sizing:border-box;`;
        document.body.appendChild(measure);
        const pages = [];
        try {
            let children = Array.from(sourceSection.children);
            if (!children.length) return pages;
            // 単一の ARTICLE 容器に全 content が入っている場合は 1 階層深く掘る
            // (深堀りしないと最初の child 強制配置ルールで 1 page に overflow する)
            if (children.length === 1 && children[0].tagName === 'ARTICLE' && children[0].children.length > 1) {
                children = Array.from(children[0].children);
            }
            let currentPage = createPage();
            let currentH = 0;
            children.forEach(child => {
                const clone = child.cloneNode(true);
                clone.querySelectorAll?.('section, .docx-section, .editor-page-wrapper, .docx').forEach(s => {
                    s.style.minHeight = '0';
                    s.style.height = 'auto';
                    s.style.maxHeight = 'none';
                });
                measure.appendChild(clone);
                const h = measure.scrollHeight;
                measure.innerHTML = '';
                if (currentH + h > CONTENT_HEIGHT && currentPage.children.length > 0) {
                    pages.push(currentPage);
                    currentPage = createPage();
                    currentH = 0;
                }
                currentPage.appendChild(clone);
                currentH += h;
            });
            if (currentPage.children.length > 0) pages.push(currentPage);
        } finally {
            measure.remove();
        }
        return pages;
    },

    // B6: 最終版の docx-pages を A4 ページ分割に置き換える
    _applyA4PaginationToDocxLayer() {
        const docxLayer = document.getElementById('sign-viewer-docx-pages');
        if (!docxLayer) return;
        // 既に A4 ページ化済みなら再実行しない（連打防止）
        if (docxLayer.querySelector(':scope > .is-a4-paginated')) return;
        let shells = docxLayer.querySelectorAll('.editor-page-shell');
        // fallback: .editor-page-shell wrapping がない構造 (mammoth render が
        // .docx-wrapper > section.docx を直接出力するパターン) でも paginate を走らせる
        if (!shells.length) {
            const fallbackSections = docxLayer.querySelectorAll('.docx-wrapper > section.docx, section.docx');
            if (fallbackSections.length) shells = fallbackSections;
        }
        if (!shells.length) return;
        // 全シェルの内容を結合して A4 ページに再分割
        const wrapper = document.createElement('div');
        wrapper.className = 'is-a4-paginated';
        wrapper.style.cssText = 'display:flex;flex-direction:column;align-items:center;width:100%;background:transparent;padding:16px 0;box-sizing:border-box;';
        shells.forEach(shell => {
            const txt = String(shell.innerText || '').replace(/\s+/g, '');
            if (txt.length < 3) return;
            const source = shell.querySelector('section') || shell;
            const pages = this._paginateChildrenIntoA4Pages(source);
            pages.forEach(p => wrapper.appendChild(p));
        });
        if (wrapper.children.length === 0) return;
        // サムネイル/ページ送りが機能するよう、可視 A4 ページに 1 始まりの data-page を付与。
        // (元シェルは display:none で隠れるため getBoundingClientRect が 0 になり、
        //  クリックしても正しいページへスクロールできない。可視ページ側へ番号を移す)
        Array.from(wrapper.querySelectorAll('.is-a4-page')).forEach((pg, idx) => {
            pg.setAttribute('data-page', String(idx + 1));
        });
        // 元シェルは !important で display:block 強制されているため、display:none では消せない
        // → setProperty で !important の override を試行、それでもダメな場合は DOM から外す
        // ただし元情報を残すために hidden 属性 + 親要素の hidden 化で複数手段を併用。
        // data-page は可視 A4 ページへ移したので、隠すシェルからは退避して二重カウントを防ぐ
        shells.forEach(s => {
            try {
                if (s.hasAttribute('data-page')) {
                    s.setAttribute('data-page-a4-backup', s.getAttribute('data-page'));
                    s.removeAttribute('data-page');
                }
                s.style.setProperty('display', 'none', 'important');
                s.setAttribute('hidden', 'hidden');
                s.dataset.hiddenByA4Pagination = '1';
            } catch (e) {}
        });
        const renderRoot = docxLayer.querySelector('.sign-docx-render-root') || docxLayer;
        renderRoot.appendChild(wrapper);
    },

    _getAppliedIndexesForFinalView(changes = this._getSortedAiChanges()) {
        const stored = this._getStoredAppliedChangeIndexes();
        if (this._hasExplicitStoredAppliedChangeIndexes()) {
            if (stored.size > 0) {
                this._repairAppliedAdditionClauseQuality(this._getFinalDocumentText());
            }
            return stored;
        }
        if (stored.size > 0) {
            this._repairAppliedAdditionClauseQuality(this._getFinalDocumentText());
            return this._getStoredAppliedChangeIndexes();
        }

        const detected = this._getAppliedChangeIndexesFromFinal(this._getFinalDocumentText());
        if (detected.size > 0) {
            this._appliedChanges = new Set(detected);
            this._repairAppliedAdditionClauseQuality(this._getFinalDocumentText());
            return detected;
        }

        const finalText = String(this._contract?.final_content || this._editedContent || '');
        const originalText = this._getOriginalDocumentText();
        if (!finalText.trim() || finalText.trim() === originalText.trim()) return stored;

        const recovered = new Set();
        changes.forEach((change, index) => {
            const appliedText = this._getDefaultAppliedTextForChange(change);
            if (appliedText && this._textContainsCandidate(finalText, appliedText)) recovered.add(index);
        });
        if (recovered.size > 0) {
            this._appliedChanges = new Set(recovered);
            this._repairAppliedAdditionClauseQuality(finalText);
        }
        return recovered;
    },

    _getFinalOverlayEdits() {
        const stored = this._contract?.final_overlay_edits;
        return stored && typeof stored === 'object' && !Array.isArray(stored) ? { ...stored } : {};
    },

    _setFinalOverlayEdit(index, text) {
        const edits = this._getFinalOverlayEdits();
        const key = String(index);
        const normalized = String(text || '').trim();
        if (normalized) {
            edits[key] = normalized;
        } else {
            delete edits[key];
        }
        if (this._contract) {
            this._contract.final_overlay_edits = edits;
            dbService.updateContract(this._contract.id, { final_overlay_edits: edits });
        }
    },

    _getDefaultAppliedTextForChange(change) {
        return this._buildLegalInsertionText(change);
    },

    _getFinalOverlayTextForChange(change, index) {
        const edits = this._getFinalOverlayEdits();
        const edited = edits[String(index)];
        if (edited) return edited;
        return this._getDefaultAppliedTextForChange(change);
    },

    _getFinalAppliedTextForChange(change, index, styleOverride = null) {
        const text = this._getFinalOverlayTextForChange(change, index);
        if (!text || !this._isAdditionChange(change)) return text;
        if (styleOverride) return this._formatInsertionText(text, styleOverride);
        const docText = this._getOriginalDocumentText() || this._getFinalDocumentText();
        const article = this._resolveAdditionTargetArticle(docText, change, index);
        const style = this._detectDocumentStyle(docText, article?.text || docText.slice(0, 800));
        return this._formatInsertionText(text, style);
    },

    async _findFinalOverlayTarget(change, index) {
        const fallback = {
            page: Math.max(1, Math.min(Number(index) + 1, Number(this._totalPages || 1))),
            left: 96,
            top: 160 + (index % 4) * 92
        };
        const article = this._findArticleForChange(change);
        const articlePattern = String(article || '').match(/第\s*[0-9０-９零〇一二三四五六七八九十百千]+\s*条/)?.[0] || '';
        if (!articlePattern) return fallback;

        const docxTarget = this._findFinalDocxOverlayTarget(articlePattern, fallback);
        if (docxTarget) return docxTarget;

        if (!this._pdfDoc) return fallback;

        try {
            for (let pageNum = 1; pageNum <= this._pdfDoc.numPages; pageNum += 1) {
                const page = await this._pdfDoc.getPage(pageNum);
                const content = await page.getTextContent();
                const items = (content.items || []).map(item => {
                    const transform = item.transform || [];
                    return {
                        text: String(item.str || ''),
                        x: Number(transform[4] || 0),
                        y: Number(transform[5] || 0),
                        fontSize: Math.max(8, Math.abs(Number(transform[3] || transform[0] || 12)))
                    };
                }).filter(item => item.text);
                const normalizedArticle = articlePattern.replace(/\s+/g, '');
                const hitIndex = items.findIndex(item => item.text.replace(/\s+/g, '').includes(normalizedArticle));
                const hit = hitIndex >= 0 ? items[hitIndex] : null;
                if (!hit) continue;
                const shell = document.querySelector(`#pdf-pages-container .pdf-page-shell[data-page="${pageNum}"]`);
                const baseViewport = page.getViewport({ scale: 1 });
                if (!shell || !baseViewport?.width || !baseViewport?.height) return { ...fallback, page: pageNum };
                const shellWidth = parseFloat(shell.style.width) || shell.clientWidth || 794;
                const shellHeight = parseFloat(shell.style.height) || shell.clientHeight || 1123;
                const following = items.slice(hitIndex + 1);
                const nextArticle = following.find(item => /^第\s*[0-9０-９零〇一二三四五六七八九十百千]+\s*条/.test(item.text.trim()));
                const blockItems = nextArticle
                    ? following.slice(0, following.indexOf(nextArticle))
                    : following.slice(0, 10);
                const blockBottomY = blockItems.length
                    ? Math.min(hit.y, ...blockItems.map(item => item.y))
                    : hit.y;
                const fontSize = Math.max(10, Math.min(16, (hit.fontSize / baseViewport.width) * shellWidth));
                return {
                    page: pageNum,
                    left: Math.max(40, Math.min(shellWidth - 420, (hit.x / baseViewport.width) * shellWidth)),
                    top: Math.max(40, Math.min(shellHeight - 120, ((baseViewport.height - blockBottomY) / baseViewport.height) * shellHeight + fontSize * 1.8)),
                    fontSize
                };
            }
        } catch (error) {
            console.warn('[SignViewer] final overlay target lookup failed:', error);
        }
        return fallback;
    },

    _findFinalDocxOverlayTarget(articlePattern, fallback) {
        const docxRoot = document.getElementById('sign-viewer-docx-pages');
        if (!docxRoot || getComputedStyle(docxRoot).display === 'none') return null;

        const normalize = value => String(value || '').replace(/\s+/g, '');
        const needle = normalize(articlePattern);
        if (!needle) return null;

        const pages = Array.from(docxRoot.querySelectorAll('[data-page]'))
            .filter(page => page && page.getBoundingClientRect);
        for (const page of pages) {
            const pageText = normalize(page.innerText || page.textContent || '');
            if (!pageText.includes(needle)) continue;

            const pageRect = page.getBoundingClientRect();
            const candidates = Array.from(page.querySelectorAll('p, span, div, h1, h2, h3'))
                .filter(node => normalize(node.innerText || node.textContent || '').includes(needle))
                .sort((a, b) => String(a.textContent || '').length - String(b.textContent || '').length);
            const hit = candidates.find(node => {
                const rect = node.getBoundingClientRect();
                return rect.width > 10 && rect.height > 6;
            });
            const hitRect = hit?.getBoundingClientRect?.();
            const fontSize = hit ? Number.parseFloat(getComputedStyle(hit).fontSize || '') : 12;

            return {
                page: Number(page.dataset.page || fallback.page || 1),
                left: Math.max(40, Math.min(pageRect.width - 420, hitRect ? hitRect.left - pageRect.left : fallback.left)),
                top: Math.max(40, Math.min(pageRect.height - 120, hitRect ? hitRect.bottom - pageRect.top + 10 : fallback.top)),
                fontSize: Number.isFinite(fontSize) ? fontSize : 12
            };
        }
        return null;
    },

    _addFinalAppliedOverlay(target, change, index, text) {
        const page = Number(target?.page || 1);
        const pdfShell = document.querySelector(`#pdf-pages-container .pdf-page-shell[data-page="${page}"]`);
        const docxShell = document.querySelector(`#sign-viewer-docx-pages [data-page="${page}"], #sign-viewer-docx-pages section:nth-of-type(${page})`);
        const shell = pdfShell || docxShell || document.querySelector('#pdf-pages-container .pdf-page-shell, #sign-viewer-docx-pages section');
        if (!shell) return;
        if (getComputedStyle(shell).position === 'static') shell.style.position = 'relative';

        const overlay = document.createElement('div');
        const isJustApplied = this._justAppliedSnippet && String(text || '').includes(String(this._justAppliedSnippet || '').trim().split('\n')[0]);
        overlay.className = `v3-final-applied-overlay${isJustApplied ? ' v3-final-applied-overlay-pulse' : ''}`;
        const shellRect = shell.getBoundingClientRect();
        const shellWidth = Math.max(320, shellRect.width || shell.clientWidth || 794);
        const shellHeight = Math.max(420, shellRect.height || shell.clientHeight || 1123);
        const fontSize = Math.max(10, Math.min(14, Number(target?.fontSize || 12)));
        const placement = this._resolveFinalOverlayPlacement(shell, target, text, fontSize, {
            width: Math.max(300, Math.min(560, shellWidth - 96)),
            pageWidth: shellWidth,
            pageHeight: shellHeight
        });
        overlay.style.cssText = [
            'position:absolute',
            `left:${Math.round(placement.left)}px`,
            `top:${Math.round(placement.top)}px`,
            `width:${Math.round(placement.width)}px`,
            'box-sizing:border-box',
            'z-index:30',
            'font-family:"Noto Serif JP","Yu Mincho","MS Mincho",serif',
            `font-size:${fontSize}px`,
            'line-height:1.55',
            'color:#111827',
            'pointer-events:auto'
        ].join(';');
        overlay.innerHTML = `
            <div class="v3-final-applied-text"
                 contenteditable="true"
                 spellcheck="true"
                  data-change-index="${Number(index)}"
                  oninput="window.signViewer._onFinalOverlayInput(${Number(index)}, this)"
                  onblur="window.signViewer._saveFinalOverlayEdit(${Number(index)}, this)"
                  title="反映済み修正。クリックして直接編集できます。"
                  style="outline:none;cursor:text;white-space:pre-wrap;word-break:normal;overflow-wrap:anywhere;border:none;border-radius:0;padding:0;background:transparent;box-shadow:none;box-decoration-break:clone;-webkit-box-decoration-break:clone;">${this.escapeHtml(text)}</div>
        `;
        shell.appendChild(overlay);
        if (isJustApplied) {
            setTimeout(() => overlay.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' }), 120);
        }
    },

    _applyFinalChangesIntoDocxFlow(changes, applied) {
        // カードギャラリー準拠のマーカー配色 CSS を保証注入
        if (typeof this._ensureGlobalMarkerStyles === 'function') this._ensureGlobalMarkerStyles();
        const docxRoot = document.getElementById('sign-viewer-docx-pages');
        if (!docxRoot || getComputedStyle(docxRoot).display === 'none') return false;
        const indexes = Array.from(applied || []).map(Number).filter(Number.isInteger);
        if (!indexes.length) return false;

        let inserted = 0;
        const additionNumbering = new Map();
        indexes.forEach(index => {
            const change = changes[index];
            if (!change) return;
            const text = this._getFinalAppliedTextForChange(change, index, this._getFinalDocxInsertionStyle(change, index, additionNumbering));
            if (!text) return;
            const oldText = this._getChangeOldText(change);
            if (oldText && this._replaceFinalDocxText(change, index, oldText, text)) {
                inserted += 1;
                return;
            }
            if (this._insertFinalDocxText(change, index, text)) inserted += 1;
        });
        return inserted > 0;
    },

    _getFinalDocxInsertionStyle(change, index, numberingState) {
        if (!this._isAdditionChange(change)) return null;
        const docText = this._getOriginalDocumentText() || this._getFinalDocumentText();
        const article = this._resolveAdditionTargetArticle(docText, change, index);
        const style = this._detectDocumentStyle(docText, article?.text || docText.slice(0, 800));
        const key = String(article?.heading || article?.start || index);
        if (style.nextParagraphNumber) {
            const next = numberingState.get(key) || style.nextParagraphNumber;
            numberingState.set(key, next + 1);
            return { ...style, nextParagraphNumber: next };
        }
        return style;
    },

    _replaceFinalDocxText(change, index, oldText, newText) {
        const node = this._findFinalDocxTextNode(oldText, change);
        if (!node) return false;
        const normalizedOld = String(oldText || '').trim();
        const normalizedNew = String(newText || '').trim();
        if (!normalizedOld || !normalizedNew) return false;
        const text = String(node.textContent || '');
        if (text.includes(normalizedOld)) {
            const stripSpaces = (s) => String(s || '').replace(/[\s　]+/g, '');
            const textStripped = stripSpaces(text);
            const oldStripped = stripSpaces(normalizedOld);
            const newStripped = stripSpaces(normalizedNew);
            // 重複防止1: text-base パスが既に挿入済みの場合はマーカーだけ付与
            const alreadyHasNew = newStripped.length >= 4 && textStripped.includes(newStripped);
            // 重複防止2: newText が oldText の拡張版（先頭が oldText と一致）かつ、
            // ノード内のテキストが「old + さらに本文」になっている場合、
            // 単純な split-join では拡張前の続き部分が残って重複する
            // → ノード全体を newText で置き換える
            const newExtendsOld = !alreadyHasNew && newStripped.length >= oldStripped.length && newStripped.startsWith(oldStripped);
            if (alreadyHasNew) {
                // no-op
            } else if (newExtendsOld) {
                node.textContent = normalizedNew;
            } else {
                node.textContent = text.split(normalizedOld).join(normalizedNew);
            }
            node.classList?.add('v3-final-flow-change');
            node.dataset.finalChangeIndex = String(index);
            node.dataset.finalChangeKind = this._getChangeKind(change) || 'modify';
            return true;
        }
        const parent = node.parentElement || node;
        const replacement = this._createFinalDocxFlowNodes(parent, normalizedNew, index, change);
        replacement.forEach(newNode => parent.parentNode?.insertBefore(newNode, parent.nextSibling));
        parent.remove();
        return replacement.length > 0;
    },

    _insertFinalDocxText(change, index, text) {
        // 重複防止: 既に DOM 上に同じテキストが存在する場合（text-base パスで挿入済み）は
        // 既存ノードを見つけてマーカーだけ付与し、新規ノード生成はスキップする
        // B1 修正: find() ではなく「textContent が最小の末端要素」を選ぶことで、
        // 巨大な docx-wrapper 等のコンテナに誤ってマーカーが付くのを防ぐ
        const stripSpaces = (s) => String(s || '').replace(/[\s　]+/g, '');
        const needleStripped = stripSpaces(String(text || ''));
        const anchorForExisting = this._isAdditionChange(change)
            ? this._findFinalDocxInsertionAnchor(change, index)
            : null;
        if (needleStripped.length >= 4) {
            const docxRoot = document.getElementById('sign-viewer-docx-pages');
            if (docxRoot) {
                // <p>, <li>, <td>, <span> を優先。<div> も対象にするが、子に block 要素を含む
                // 「コンテナ」は除外（=テキストの末端要素のみ採用）。
                // <style>, <script> 配下は対象外。
                const isContainerDiv = (el) => {
                    if (el.tagName !== 'DIV') return false;
                    return !!el.querySelector('p, div, section, table, ul, ol, li, h1, h2, h3, h4, h5, h6');
                };
                const allCandidates = Array.from(docxRoot.querySelectorAll('p, li, td, span, div'))
                    .filter(n => !n.closest?.('.v3-final-flow-change'))
                    .filter(n => !n.closest?.('style, script, head'))
                    .filter(n => !isContainerDiv(n)) // コンテナ div は除外
                    .filter(n => {
                        const txt = n.textContent || '';
                        if (txt.length > 2000) return false; // 巨大要素は除外（より厳しめ）
                        return stripSpaces(txt).includes(needleStripped);
                    });
                if (this._isAdditionChange(change) && anchorForExisting?.articleNodes?.length) {
                    allCandidates
                        .filter(n => !anchorForExisting.articleNodes.some(articleNode => articleNode === n || articleNode.contains?.(n)))
                        .forEach(n => n.remove());
                }
                const candidates = allCandidates.filter(n => {
                    if (!anchorForExisting?.articleNodes?.length) return true;
                    return anchorForExisting.articleNodes.some(articleNode => articleNode === n || articleNode.contains?.(n));
                });
                // 最短 textContent の要素を選ぶ（needle に最も近い末端ノード）
                candidates.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
                const existing = candidates[0];
                if (existing) {
                    existing.classList?.add('v3-final-flow-change');
                    existing.dataset.finalChangeIndex = String(index);
                    existing.dataset.finalChangeKind = this._getChangeKind(change) || 'modify';
                    return true;
                }
            }
        }
        const anchor = anchorForExisting || this._findFinalDocxInsertionAnchor(change, index);
        if (!anchor) return false;
        const nodes = this._createFinalDocxFlowNodes(anchor.referenceNode || anchor.node, text, index, change);
        let cursor = anchor.node;
        nodes.forEach(node => {
            cursor.parentNode.insertBefore(node, cursor.nextSibling);
            cursor = node;
        });
        return nodes.length > 0;
    },

    _findFinalDocxTextNode(text, change = null) {
        const docxRoot = document.getElementById('sign-viewer-docx-pages');
        if (!docxRoot) return null;
        const needle = String(text || '').replace(/\s+/g, '');
        if (!needle) return null;
        const article = change ? this._findArticleForChange(change) : '';
        const articlePattern = String(article || '').match(/第\s*[0-9０-９零〇一二三四五六七八九十百千]+\s*条/)?.[0] || '';
        const scope = articlePattern ? this._findFinalDocxPageForArticle(articlePattern) : docxRoot;
        // B1 修正: <style>, <script>, <head> 配下は除外。
        // <p>/<li>/<td>/<span> を優先。<div> はコンテナ（block 子要素あり）を除外。
        const isContainerDiv = (el) => {
            if (el.tagName !== 'DIV') return false;
            return !!el.querySelector('p, div, section, table, ul, ol, li, h1, h2, h3, h4, h5, h6');
        };
        const nodes = Array.from((scope || docxRoot).querySelectorAll('p, li, td, span, div'))
            .filter(node => !node.closest?.('.v3-final-flow-change'))
            .filter(node => !node.closest?.('style, script, head'))
            .filter(node => !isContainerDiv(node))
            .filter(node => {
                const txt = node.textContent || '';
                if (txt.length > 2000) return false;
                return txt.replace(/\s+/g, '').includes(needle);
            })
            .sort((a, b) => String(a.textContent || '').length - String(b.textContent || '').length);
        return nodes[0] || null;
    },

    _findFinalDocxInsertionAnchor(change, index = 0) {
        const docxRoot = document.getElementById('sign-viewer-docx-pages');
        if (!docxRoot) return null;
        let articleLabel = '';
        if (this._isAdditionChange(change)) {
            articleLabel = this._findExplicitArticleForChange(change);
            if (!articleLabel) {
                const docText = this._getOriginalDocumentText() || this._getFinalDocumentText();
                const resolved = this._resolveAdditionTargetArticle(docText, change, index);
                const heading = String(resolved?.heading || '');
                const m = heading.match(/第\s*[0-9０-９零〇一二三四五六七八九十百千]+\s*条/);
                if (m) articleLabel = m[0];
            }
        }
        if (!articleLabel) {
            const article = this._findArticleForChange(change);
            articleLabel = String(article || '').match(/第\s*[0-9０-９零〇一二三四五六七八九十百千]+\s*条/)?.[0] || '';
        }
        const articleAnchorPattern = articleLabel ? this._getArticleAnchorPattern(articleLabel) : '';
        const articleRegex = articleAnchorPattern ? new RegExp(articleAnchorPattern) : null;
        const page = articleLabel ? this._findFinalDocxPageForArticle(articleLabel) : null;
        let scope = page || docxRoot;
        let blocks = this._getFinalDocxFlowBlocks(scope);
        if (!blocks.length && scope !== docxRoot) {
            scope = docxRoot;
            blocks = this._getFinalDocxFlowBlocks(scope);
        }
        if (!blocks.length) return null;

        // 条文特定: ①ブロック直接マッチ → ②全要素から条文見出しを探して直近ブロックへ昇格 → ③末尾フォールバック
        // 絶対に「文書の先頭(startIndex=0)」へ無関係な挿入をしない。
        let startIndex = -1;
        if (articleRegex) {
            // ① 直接ブロックレベルでマッチ
            startIndex = blocks.findIndex(node => articleRegex.test(String(node.textContent || '')));

            // ② ブロックで見つからない場合は全要素を走査し、見出しサイズのテキスト一致を探す
            if (startIndex < 0) {
                const candidates = Array.from((page || docxRoot).querySelectorAll('p, h1, h2, h3, h4, h5, h6, span, div, td, th, li'));
                const hit = candidates.find(n => {
                    const txt = String(n.textContent || '').trim();
                    if (!txt || txt.length > 200) return false; // 全文・長文ブロック誤マッチを排除
                    return articleRegex.test(txt);
                });
                if (hit) {
                    const blockOf = hit.closest('p, li, div, h1, h2, h3, h4, h5, h6, td, th') || hit;
                    const idx = blocks.indexOf(blockOf);
                    if (idx >= 0) startIndex = idx;
                }
            }
        }
        if (startIndex < 0 && scope !== docxRoot) {
            scope = docxRoot;
            blocks = this._getFinalDocxFlowBlocks(scope);
            if (!blocks.length) return null;
            startIndex = articleRegex
                ? blocks.findIndex(node => articleRegex.test(String(node.textContent || '')))
                : -1;
        }

        // ③ 条文特定不可（articleRegex 未設定 or DOM 内に該当条文なし）→ 文書末尾の本文ブロックへ
        if (startIndex < 0) {
            const lastBody = [...blocks].reverse().find(node => this._isFinalDocxBodyLikeNode(node));
            const fallbackNode = lastBody || blocks[blocks.length - 1];
            return { node: fallbackNode, referenceNode: fallbackNode };
        }

        let endIndex = blocks.length;
        for (let i = startIndex + 1; i < blocks.length; i += 1) {
            if (/第\s*[0-9０-９零〇一二三四五六七八九十百千]+\s*条/.test(String(blocks[i].textContent || '').trim())) {
                endIndex = i;
                break;
            }
        }

        const articleBlocks = blocks.slice(startIndex, endIndex);
        const bodyBlocks = articleBlocks.filter(node => this._isFinalDocxBodyLikeNode(node));
        const lastBodyBlock = bodyBlocks[bodyBlocks.length - 1] || null;
        const scored = articleBlocks
            .map(node => ({ node, score: this._scoreInsertionSegment(node.textContent || '', change) }))
            .filter(item => item.score >= 12 && !this._isFinalDocxHeadingLikeNode(item.node))
            .sort((a, b) => b.score - a.score);
        const preferredNode = this._isAdditionChange(change)
            ? (lastBodyBlock || scored[0]?.node)
            : (scored[0]?.node || lastBodyBlock);
        const bodyReference = this._findFinalDocxBodyReferenceNode(articleBlocks, preferredNode);
        const node = preferredNode || bodyReference || articleBlocks[articleBlocks.length - 1] || blocks[Math.min(index, blocks.length - 1)];
        const referenceNode = bodyReference || node;
        return { node, referenceNode, articleNodes: articleBlocks };
    },

    _findFinalDocxPageForArticle(articlePattern) {
        const docxRoot = document.getElementById('sign-viewer-docx-pages');
        if (!docxRoot) return null;
        const needle = String(articlePattern || '').replace(/\s+/g, '');
        if (!needle) return null;
        const anchorPattern = this._getArticleAnchorPattern(articlePattern);
        const articleRegex = anchorPattern ? new RegExp(anchorPattern) : null;
        return Array.from(docxRoot.querySelectorAll('[data-page], .editor-page-shell, section'))
            .find(page => {
                const text = String(page.textContent || '');
                return articleRegex ? articleRegex.test(text) : text.replace(/\s+/g, '').includes(needle);
            }) || null;
    },

    _getFinalDocxFlowBlocks(scope) {
        const candidates = Array.from(scope.querySelectorAll('p, li, div'))
            .filter(node => !node.closest?.('.v3-final-flow-change'))
            .filter(node => {
                const text = String(node.textContent || '').trim();
                if (!text) return false;
                if (node.querySelector(':scope p, :scope li, :scope div')) return false;
                const rect = node.getBoundingClientRect?.();
                return !rect || (rect.width > 8 && rect.height > 6);
            });
        return candidates.sort((a, b) => {
            const ar = a.getBoundingClientRect?.();
            const br = b.getBoundingClientRect?.();
            if (!ar || !br) return 0;
            return (ar.top - br.top) || (ar.left - br.left);
        });
    },

    _isFinalDocxHeadingLikeNode(node) {
        const text = String(node?.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text) return false;
        if (/^第\s*[0-9０-９零〇一二三四五六七八九十百千]+\s*条/.test(text)) return true;
        if (/契約書$/.test(text) && text.length <= 80) return true;
        const style = node && typeof getComputedStyle === 'function' ? getComputedStyle(node) : null;
        const fontSize = Number.parseFloat(style?.fontSize || '') || 0;
        const fontWeight = Number.parseInt(style?.fontWeight || '400', 10) || 400;
        return fontSize >= 16 && fontWeight >= 600 && text.length <= 120;
    },

    _isFinalDocxBodyLikeNode(node) {
        const text = String(node?.textContent || '').trim();
        if (!text || this._isFinalDocxHeadingLikeNode(node)) return false;
        const style = node && typeof getComputedStyle === 'function' ? getComputedStyle(node) : null;
        const fontSize = Number.parseFloat(style?.fontSize || '') || 0;
        return !fontSize || fontSize <= 16 || text.length >= 30;
    },

    _findFinalDocxBodyReferenceNode(blocks, preferredNode = null) {
        if (preferredNode && this._isFinalDocxBodyLikeNode(preferredNode)) return preferredNode;
        return (blocks || []).find(node => this._isFinalDocxBodyLikeNode(node)) || null;
    },

    _getFinalDocxBodyTextStyle(referenceNode) {
        const page = referenceNode?.closest?.('[data-page], .editor-page-shell, section') || referenceNode?.parentElement || document.body;
        const siblings = Array.from(referenceNode?.parentElement?.children || [])
            .filter(node => this._isFinalDocxBodyLikeNode(node));
        const blocks = page ? this._getFinalDocxFlowBlocks(page).filter(node => this._isFinalDocxBodyLikeNode(node)) : [];
        const seen = new Set();
        const candidates = [
            this._isFinalDocxBodyLikeNode(referenceNode) ? referenceNode : null,
            ...siblings,
            ...blocks
        ].filter(node => {
            if (!node || seen.has(node)) return false;
            seen.add(node);
            return true;
        });
        const sample = candidates.find(node => {
            const style = getComputedStyle(node);
            const size = Number.parseFloat(style.fontSize || '') || 0;
            return (!size || (size >= 8 && size <= 16)) && !this._isFinalDocxHeadingLikeNode(node);
        }) || candidates[0] || referenceNode || document.body;
        const style = getComputedStyle(sample);
        const sampleIsHeading = this._isFinalDocxHeadingLikeNode(sample);
        const fontSize = Number.parseFloat(style.fontSize || '') || 0;
        return {
            fontFamily: style.fontFamily,
            fontSize: sampleIsHeading && fontSize > 16 ? '14px' : style.fontSize,
            lineHeight: style.lineHeight,
            fontWeight: sampleIsHeading ? '400' : style.fontWeight,
            color: style.color,
            textAlign: style.textAlign,
            letterSpacing: style.letterSpacing,
            fontStyle: style.fontStyle
        };
    },

    _applyFinalDocxBodyTextStyle(node, textStyle) {
        if (!node || !textStyle) return;
        const targets = [node, ...Array.from(node.querySelectorAll?.('span, a, b, strong, i, em') || [])];
        targets.forEach(target => {
            if (!target?.style) return;
            target.style.fontFamily = textStyle.fontFamily || target.style.fontFamily;
            target.style.fontSize = textStyle.fontSize || target.style.fontSize;
            target.style.lineHeight = textStyle.lineHeight || target.style.lineHeight;
            target.style.fontWeight = textStyle.fontWeight || target.style.fontWeight;
            target.style.color = textStyle.color || target.style.color;
            target.style.textAlign = textStyle.textAlign || target.style.textAlign;
            target.style.letterSpacing = textStyle.letterSpacing || target.style.letterSpacing;
            target.style.fontStyle = textStyle.fontStyle || target.style.fontStyle;
        });
    },

    _createFinalDocxFlowNodes(referenceNode, text, index, change = null) {
        const lines = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').map(line => line.trim()).filter(Boolean);
        if (!lines.length) return [];
        const kind = change ? (this._getChangeKind(change) || 'add') : 'add';
        return lines.map((line) => {
            const node = this._cloneFinalDocxParagraph(referenceNode);
            node.classList?.add('v3-final-flow-change');
            node.dataset.finalChangeIndex = String(index);
            node.dataset.finalChangeKind = kind;
            this._setFinalDocxNodeText(node, line);
            return node;
        });
    },

    _cloneFinalDocxParagraph(referenceNode) {
        const block = referenceNode?.closest?.('p, li, div') || referenceNode;
        const clone = block?.cloneNode?.(true) || document.createElement('p');
        clone.querySelectorAll?.('[id]').forEach(node => node.removeAttribute('id'));
        clone.querySelectorAll?.('.v3-final-flow-change').forEach(node => node.classList.remove('v3-final-flow-change'));
        clone.removeAttribute?.('id');
        clone.style.background = 'transparent';
        clone.style.border = 'none';
        clone.style.boxShadow = 'none';
        clone.style.color = getComputedStyle(block || document.body).color || '';
        this._applyFinalDocxBodyTextStyle(clone, this._getFinalDocxBodyTextStyle(block));
        return clone;
    },

    _setFinalDocxNodeText(node, text) {
        const textLeaf = Array.from(node.querySelectorAll('span, a, b, strong, i, em'))
            .filter(child => !child.children.length)
            .sort((a, b) => String(b.textContent || '').length - String(a.textContent || '').length)[0];
        if (textLeaf) {
            textLeaf.textContent = text;
            Array.from(node.querySelectorAll('span, a, b, strong, i, em')).forEach(child => {
                if (child !== textLeaf && !child.contains(textLeaf)) child.remove();
            });
        } else {
            node.textContent = text;
        }
    },

    _resolveFinalOverlayPlacement(shell, target, text, fontSize, metrics) {
        const pageWidth = Number(metrics?.pageWidth || 794);
        const pageHeight = Number(metrics?.pageHeight || 1123);
        const preferredWidth = Number(metrics?.width || Math.min(560, pageWidth - 96));
        const textLength = String(text || '').replace(/\s+/g, '').length;
        const estimateHeight = (width) => {
            const charsPerLine = Math.max(14, Math.floor(width / Math.max(6, fontSize * 0.72)));
            const explicitLines = String(text || '').split('\n');
            const lineCount = explicitLines.reduce((sum, line) => {
                const normalizedLength = Math.max(1, String(line || '').replace(/\s+/g, '').length);
                return sum + Math.max(1, Math.ceil(normalizedLength / charsPerLine));
            }, 0);
            return Math.min(pageHeight - 48, Math.max(34, Math.ceil(lineCount * fontSize * 1.55 + 14)));
        };

        const candidates = [];
        const centeredWidth = Math.max(300, Math.min(preferredWidth, pageWidth - 96));
        candidates.push({ left: Math.max(32, (pageWidth - centeredWidth) / 2), width: centeredWidth });
        if (pageWidth >= 620) {
            candidates.push({ left: Math.max(28, pageWidth - 300), width: 268 });
            candidates.push({ left: 32, width: 268 });
        }

        const shellRect = shell.getBoundingClientRect();
        const occupiedRects = this._getFinalOverlayOccupiedRects(shell, shellRect);
        const targetTop = Math.max(24, Math.min(pageHeight - 64, Number(target?.top || 120)));
        let best = null;

        candidates.forEach(candidate => {
            const height = estimateHeight(candidate.width);
            const top = this._findFinalOverlayGapTop({
                occupiedRects,
                left: candidate.left,
                width: candidate.width,
                height,
                targetTop,
                pageHeight
            });
            const score = Math.abs(top - targetTop) + (candidate.width < 300 && textLength > 80 ? 120 : 0);
            if (!best || score < best.score) best = { ...candidate, top, height, score };
        });

        return best || {
            left: Math.max(32, Math.min(pageWidth - centeredWidth - 32, Number(target?.left || 96))),
            top: Math.max(24, Math.min(pageHeight - estimateHeight(centeredWidth) - 24, targetTop)),
            width: centeredWidth
        };
    },

    _getFinalOverlayOccupiedRects(shell, shellRect) {
        const rects = [];
        const nodes = Array.from(shell.querySelectorAll('p, span, h1, h2, h3, li, td, th, .v3-final-applied-overlay'));
        nodes.forEach(node => {
            if (!node || node.closest?.('.v3-final-applied-overlay') !== node && node.classList?.contains('v3-final-applied-overlay')) return;
            const text = String(node.innerText || node.textContent || '').trim();
            if (!text && !node.classList?.contains('v3-final-applied-overlay')) return;
            const rect = node.getBoundingClientRect?.();
            if (!rect || rect.width < 4 || rect.height < 4) return;
            rects.push({
                left: rect.left - shellRect.left,
                right: rect.right - shellRect.left,
                top: rect.top - shellRect.top,
                bottom: rect.bottom - shellRect.top
            });
        });
        return rects;
    },

    _findFinalOverlayGapTop({ occupiedRects, left, width, height, targetTop, pageHeight }) {
        const right = left + width;
        const vertical = occupiedRects
            .filter(rect => rect.right > left - 8 && rect.left < right + 8)
            .map(rect => ({
                top: Math.max(0, rect.top - 6),
                bottom: Math.min(pageHeight, rect.bottom + 6)
            }))
            .sort((a, b) => a.top - b.top);

        const gaps = [];
        let cursor = 18;
        vertical.forEach(rect => {
            if (rect.top - cursor >= height) gaps.push({ top: cursor, bottom: rect.top });
            cursor = Math.max(cursor, rect.bottom);
        });
        if (pageHeight - 18 - cursor >= height) gaps.push({ top: cursor, bottom: pageHeight - 18 });
        if (!gaps.length) return Math.max(18, Math.min(pageHeight - height - 18, targetTop));

        const afterTarget = gaps.filter(gap => gap.top >= targetTop - 12);
        const pool = afterTarget.length ? afterTarget : gaps;
        return pool
            .map(gap => ({
                top: Math.max(gap.top, Math.min(targetTop, gap.bottom - height)),
                score: Math.abs(Math.max(gap.top, Math.min(targetTop, gap.bottom - height)) - targetTop)
            }))
            .sort((a, b) => a.score - b.score)[0].top;
    },

    _onFinalOverlayInput(index, element) {
        const text = String(element?.innerText || '').trim();
        this._pendingFinalOverlayEdits = this._pendingFinalOverlayEdits || {};
        this._pendingFinalOverlayEdits[String(index)] = text;
        element.style.borderColor = '#86efac';
        element.style.background = '#ffffff';
    },

    _saveFinalOverlayEdit(index, element) {
        const changes = this._getActiveSortedAiChanges();
        const change = changes[index];
        if (!change) return;
        const newText = String(element?.innerText || '').trim();
        if (!newText) {
            Notify.warning('反映済み条文は空にできません。元に戻す場合は修正案タブの「元に戻す」を使ってください。');
            element.innerText = this._getFinalOverlayTextForChange(change, index);
            return;
        }
        const previousText = this._getFinalOverlayTextForChange(change, index);
        if (newText === previousText) return;
        const finalText = this._replaceAppliedChangeTextInFinal(index, previousText, newText);
        this._setFinalOverlayEdit(index, newText);
        this._editedContent = finalText;
        this._editedHtml = '';
        this._lastSavedContent = finalText;
        this._lastPreviewContent = '';
        if (this._contract) {
            this._contract.final_content = finalText;
            this._contract.final_content_html = '';
            dbService.updateContract(this._contract.id, {
                final_content: finalText,
                final_content_html: '',
                final_overlay_edits: this._getFinalOverlayEdits()
            });
        }
        element.style.borderColor = '#22c55e';
        element.style.background = 'rgba(255,255,255,0.75)';
        Notify.success('最終版の手直しを保存しました。');
    },

    _replaceAppliedChangeTextInFinal(index, previousText, newText) {
        const changes = this._getActiveSortedAiChanges();
        const change = changes[index];
        let finalText = this._ensureEditedContent();
        const oldText = String(previousText || '').trim();
        const nextText = String(newText || '').trim();
        if (!change || !nextText) return finalText;
        if (oldText && finalText.includes(oldText)) {
            return finalText.split(oldText).join(nextText);
        }
        const defaultText = this._getDefaultAppliedTextForChange(change);
        if (defaultText && finalText.includes(defaultText)) {
            return finalText.split(defaultText).join(nextText);
        }
        const appliedText = this._applyChangeToText(finalText, change);
        if (appliedText !== finalText) {
            finalText = appliedText;
            if (defaultText && finalText.includes(defaultText)) {
                return finalText.split(defaultText).join(nextText);
            }
        }
        return `${finalText.trimEnd()}\n\n${nextText}`.trim();
    },

    async _showFinalPdf(container) {
        const pdfLayer = document.getElementById('pdf-pages-container');
        const editLayer = document.getElementById('v3-edit-layer');
        if (pdfLayer) pdfLayer.style.display = 'none';
        if (editLayer) editLayer.style.display = 'block';
        this.hideViewerLoader();
        this.renderFinalPreviewMode(container);
        this.renderDashboardUI();
    },

    _getRawText(data) {
        if (!data) return '';
        if (typeof data === 'string') return data;
        if (Array.isArray(data)) {
            return data
                .map((item, index) => this._getRawTextFromItem(item, index))
                .filter(Boolean)
                .join('\n\n')
                .trim();
        }
        if (typeof data === 'object') {
            if (Array.isArray(data.articles)) {
                const docTitle = String(data.title || data.document_title || data.name || '').trim();
                const preamble = String(data.preamble || '').trim();
                const articleText = this._getRawText(data.articles);
                return [docTitle, preamble, articleText].filter(Boolean).join('\n\n').trim();
            }
            if (data.full_text || data.fullText || data.body || data.content || data.text) {
                return this._getRawTextFromItem(data, 0);
            }
            return '';
        }
        return String(data);
    },

    _getRawTextFromItem(item, index = 0) {
        if (!item) return '';
        if (typeof item === 'string') return item.trim();
        if (Array.isArray(item)) return this._getRawText(item);
        if (typeof item !== 'object') return String(item || '').trim();

        const fullText = String(item.full_text || item.fullText || '').trim();
        if (fullText) return fullText;

        const rawArticleLabel = String(item.article || item.articleNumber || item.clause || '').trim();
        const heading = String(item.title || item.header || '').trim();
        const looksLikeArticleItem = Boolean(
            heading
            || Array.isArray(item.paragraphs)
            || item.content
            || item.body
            || item.text
        );
        const articleLabel = this._normalizeArticleHeadingLine(rawArticleLabel || (looksLikeArticleItem ? `第${index + 1}条` : ''));
        const titleLine = [articleLabel, heading]
            .filter((part, partIndex, parts) => {
                if (!part) return false;
                if (partIndex === 1 && parts[0] && (parts[0].includes(part) || part.includes(parts[0]))) {
                    return false;
                }
                return true;
            })
            .join(' ')
            .trim();

        const paragraphText = Array.isArray(item.paragraphs)
            ? item.paragraphs
                .map((paragraph) => {
                    if (typeof paragraph === 'string') return paragraph.trim();
                    if (paragraph && typeof paragraph === 'object') {
                        return String(paragraph.content || paragraph.body || paragraph.text || '').trim();
                    }
                    return '';
                })
                .filter(Boolean)
                .join('\n')
            : this._getRawText(item.body || item.content || item.text || '');

        const fallbackTitle = !titleLine && !paragraphText ? `第${index + 1}条` : '';
        return [titleLine || fallbackTitle, paragraphText].filter(Boolean).join('\n').trim();
    },

    _normalizeArticleHeadingLine(line) {
        const value = String(line || '').trim();
        if (!value) return value;
        const match = value.match(/^(?:第\s*)?([0-9０-９一二三四五六七八九十百千〇零○◯]+)\s*([条章節])(\s*[（(【]?[^\n]*)?$/);
        if (!match) return value;
        if (/^第\s*/.test(value)) return value.replace(/^第\s*/, '第').replace(/\s*([条章節])/, '$1');
        return `第${match[1]}${match[2]}${match[3] || ''}`.trim();
    },

    _getChangeTextByAliases(change, aliases = []) {
        if (!change || typeof change !== 'object') return '';
        for (const alias of aliases) {
            const value = change[alias];
            if (typeof value === 'string' && value.trim()) return value.trim();
            if (value && typeof value === 'object') {
                const nested = value.text || value.content || value.body || value.value || value.clause;
                if (typeof nested === 'string' && nested.trim()) return nested.trim();
            }
        }
        return '';
    },

    _getChangeOldText(change) {
        return this._getChangeTextByAliases(change, [
            'old',
            'original',
            'originalText',
            'before',
            'current',
            'currentText',
            'sourceText',
            'targetText'
        ]);
    },

    _getChangeNewText(change) {
        return this._getChangeTextByAliases(change, [
            'new',
            'after',
            'proposal',
            'proposedText',
            'proposed_text',
            'proposedClause',
            'proposed_clause',
            'suggestion',
            'suggestedText',
            'suggested_text',
            'suggestedClause',
            'suggested_clause',
            'modified',
            'modifiedText',
            'revised',
            'revisedText',
            'revision',
            'replacement',
            'rewrite',
            'recommended',
            'recommendedText',
            'recommendedClause',
            'clauseText',
            'body',
            'content'
        ]);
    },

    _invalidateFinalRenderedCache() {
        const staleUrl = this._finalGeneratedPdfUrl;
        if (this._finalGeneratedPdfUrl) {
            try { URL.revokeObjectURL(this._finalGeneratedPdfUrl); } catch (error) {}
        }
        this._finalGeneratedPdfUrl = null;
        this._lastGeneratedFinalContent = '';
        if (this._currentPdfUrl && this._currentPdfUrl === staleUrl) {
            this._currentPdfUrl = null;
        }
        if (this._currentDownloadUrl && this._currentDownloadUrl === staleUrl) {
            this._currentDownloadUrl = null;
        }
    },

    _normalizeChangeSectionLabel(value) {
        const label = String(value || '').trim();
        if (!label) return '';
        const normalized = label.replace(/\s+/g, '');
        const genericLabels = new Set(['本文', '条文', '契約本文', '契約書本文', '修正案', '変更箇所', '追加条項', '追記条項', '追加条鋼', '追記条鋼']);
        if (/^(追加|追記)\s*(条項|条鋼|項目)?\s*\d*$/i.test(normalized)) return '';
        if (genericLabels.has(normalized)) return '';
        return label;
    },

    _findExplicitArticleForChange(change) {
        const candidates = [
            change?.section,
            change?.__diffsenseDisplayedSection,
            change?.__diffsenseDisplaySection,
            change?.__diffsenseResolvedSection,
            change?.__diffsenseResolvedTarget,
            change?.target,
            change?.targetSection,
            change?.target_section,
            change?.targetArticle,
            change?.target_article,
            change?.insertionTarget,
            change?.insertion_target,
            change?.insertAfter,
            change?.insert_after,
            change?.location,
            change?.position,
            change?.anchor,
            change?.destination,
            change?.article,
            change?.articleNumber,
            change?.article_number,
            change?.articleHeading,
            change?.article_heading,
            change?.clause,
            change?.title
        ];
        for (const candidate of candidates) {
            const explicit = this._normalizeChangeSectionLabel(candidate);
            if (/第\s*[0-9０-９零〇一二三四五六七八九十百千]+\s*条/.test(explicit)) {
                return explicit;
            }
        }
        const priorityKeys = /section|target|article|clause|location|position|anchor|destination|heading/i;
        const found = [];
        const visit = (value, key = '', depth = 0) => {
            if (depth > 2 || value == null) return;
            if (typeof value === 'string' || typeof value === 'number') {
                if (!priorityKeys.test(key)) return;
                const explicit = this._normalizeChangeSectionLabel(value);
                if (/第\s*[0-9０-９零〇一二三四五六七八九十百千]+\s*条/.test(explicit)) found.push(explicit);
                return;
            }
            if (Array.isArray(value)) {
                value.forEach(item => visit(item, key, depth + 1));
                return;
            }
            if (typeof value === 'object') {
                Object.entries(value).forEach(([childKey, childValue]) => visit(childValue, childKey, depth + 1));
            }
        };
        visit(change);
        return found[0] || '';
    },

    _getStructuredOriginalArticles() {
        const content = this._contract?.original_content;
        if (content && typeof content === 'object' && Array.isArray(content.articles)) {
            return content.articles;
        }
        return [];
    },

    _isAdditionChange(change) {
        return !this._getChangeOldText(change);
    },

    // 再発防止策: contract data の解析失敗を検知。
    // AI解析や mammoth parse 失敗で final_content/html_content が空のまま contract が保存
    // されているケースを検出し、 ユーザーに「再解析または再アップロード推奨」を促す。
    // 過去発生バグ: backend AI prompt 変更時に解析失敗 → contract data 空 → viewer 表示崩壊。
    _isContractDataIncomplete() {
        const c = this._contract;
        if (!c) return false;
        const finalLen = String(c.final_content || '').trim().length;
        const htmlLen = String(c.html_content || '').trim().length;
        const origText = this._getOriginalDocumentText?.() || '';
        const origLen = String(origText).trim().length;
        // 全 source が極端に短い (= 50 chars未満) → 解析失敗とみなす
        return finalLen < 50 && htmlLen < 50 && origLen < 50;
    },

    // 画像のみcontract判定: doc_type === 'pdf' (= 元PDFアップロード) のみ厳格判定。
    // docx upload は backend が mammoth 失敗で画像化 fallback しても warning 出さない
    // (ユーザーは docx をアップロードしたつもりで PDF原本警告が出るのは誤検出)。
    _isImageOnlyContract() {
        const c = this._contract;
        if (!c) return false;
        return String(c.doc_type || '').toLowerCase() === 'pdf';
    },

    // 最終版モード render後、 削除型反映済の oldText を含む span/p/div 要素に
    // v3-applied-change-delete クラスを wrap して取消し線+赤色で視覚化する post-processor。
    // 既存 snippet mark logic (_markAppliedSnippetInEscapedLine) は span 経路を
    // walker しないため、 docx-section / docx-smart-page 配下の text を独立に walker。
    _applyDeletionMarkersToFinalDom() {
        try {
            const changes = this._getActiveSortedAiChanges?.() || [];
            const applied = this._getStoredAppliedChangeIndexes?.() || new Set();
            if (!applied.size) return;
            const deletionOldTexts = [];
            changes.forEach((c, idx) => {
                if (!applied.has(idx)) return;
                const oldText = this._getChangeOldText(c);
                const newText = this._buildLegalInsertionText(c);
                const isDeletion = String(c?.type || '').toUpperCase() === 'DELETE'
                    || (Boolean(oldText) && !newText);
                if (!isDeletion || !oldText) return;
                // 行ごとに分割して 各行を mark対象に追加 (短い行 < 2 chars は除外)
                String(oldText).split('\n').map(s => s.trim()).filter(s => s.length >= 2)
                    .forEach(line => deletionOldTexts.push(line));
            });
            if (!deletionOldTexts.length) return;
            const normalize = (s) => String(s || '').replace(/[\s　]+/g, '');
            const normalizedDeletions = deletionOldTexts.map(t => ({ raw: t, norm: normalize(t) }));
            // 対象 root: docx-section / docx-smart-page / editor-page-shell / v3-editor-page いずれの場所でも
            const roots = document.querySelectorAll(
                '#sign-viewer-docx-pages, #v3-edit-layer, #v3-pdf-sheet .docx, #v3-pdf-sheet .docx-section'
            );
            const candidates = new Set();
            roots.forEach(root => {
                root.querySelectorAll('span, p, div').forEach(el => {
                    if (el.children.length > 0) return; // leaf のみ
                    if (el.classList.contains('v3-applied-change-delete')) return; // 既に mark済
                    candidates.add(el);
                });
            });
            candidates.forEach(el => {
                const text = el.textContent || '';
                if (text.length < 2) return;
                const normEl = normalize(text);
                const hit = normalizedDeletions.some(d => normEl.includes(d.norm) && d.norm.length >= 5);
                if (hit) {
                    el.classList.add('v3-applied-change', 'v3-applied-change-delete');
                }
            });
        } catch (e) {
            console.warn('[SignViewer] _applyDeletionMarkersToFinalDom failed:', e);
        }
    },

    // 出力用クリーン版 final_content 生成 (商用品質の契約書出力)。
    // 削除型修正案は最終版画面で取消し線+色で「視覚マーカー」表示するため
    // final_content に oldText を残しているが、 プレビュー/印刷/ダウンロードでは:
    //   1. 削除対象 oldText を物理除去 (基本)
    //   2. oldText が条の全本文を占める時 → 条ヘッダー (「第N条 (XXX)」) も一緒に除去
    //   3. 残った条を「第1条, 第2条, ...」 で再付番 (リナンバリング)
    //   4. 本文中の条参照「第N条」 も同マップで置換 (整合性維持)
    // base 引数で対象 text を指定可能、 省略時は contract.final_content を使う。
    _buildCleanFinalContent(base) {
        const sourceText = (typeof base === 'string')
            ? base
            : String(this._contract?.final_content || this._editedContent || '');
        const changes = this._getActiveSortedAiChanges?.() || [];
        const applied = this._getStoredAppliedChangeIndexes?.() || new Set();
        if (!applied.size) return sourceText;
        let cleaned = sourceText;

        // ステップ1: 削除型反映済 change の oldText を 条ごと削除する
        // 「第N条 (XXX)」のヘッダー含めて該当条ブロックを丸ごと除去
        const articleHeadRegex = /^[ 　\t]*第\s*[0-9０-９零〇一二三四五六七八九十百千]+\s*条[^\n]*$/m;
        const findArticleBlockContaining = (text, oldText) => {
            // 各行で条ヘッダー位置 抽出 → oldText を含む条 block の range を返す
            const lines = text.split('\n');
            const headerPositions = []; // [{lineIdx, charOffset}]
            let offset = 0;
            lines.forEach((line, i) => {
                if (articleHeadRegex.test(line)) headerPositions.push({ lineIdx: i, charOffset: offset });
                offset += line.length + 1;
            });
            for (let i = 0; i < headerPositions.length; i++) {
                const start = headerPositions[i].charOffset;
                const end = (i + 1 < headerPositions.length) ? headerPositions[i + 1].charOffset : text.length;
                const block = text.slice(start, end);
                // 改行・空白寛容に oldText を block 内で検出
                const normBlock = block.replace(/\s+/g, '');
                const normOld = oldText.replace(/\s+/g, '');
                if (normOld && normBlock.includes(normOld)) return { start, end, block };
            }
            return null;
        };

        changes.forEach((c, idx) => {
            if (!applied.has(idx)) return;
            const oldText = this._getChangeOldText(c);
            const newText = this._buildLegalInsertionText(c);
            const isDeletion = String(c?.type || '').toUpperCase() === 'DELETE'
                || (Boolean(oldText) && !newText);
            if (!isDeletion || !oldText) return;
            try {
                const articleHit = findArticleBlockContaining(cleaned, oldText);
                if (articleHit) {
                    // 条ヘッダー + 本文丸ごと削除 (前後の空行も整理)
                    cleaned = cleaned.slice(0, articleHit.start).trimEnd()
                        + '\n\n'
                        + cleaned.slice(articleHit.end).trimStart();
                } else {
                    // フォールバック: oldText のみ regex 除去 (条ヘッダー検出失敗時)
                    const escaped = this._escapeRegex(oldText).replace(/\s+/g, '\\s*');
                    const regex = new RegExp(escaped);
                    if (regex.test(cleaned)) cleaned = cleaned.replace(regex, '');
                }
            } catch (e) {
                console.warn('[SignViewer] _buildCleanFinalContent removal failed:', e);
            }
        });

        // ステップ2: 残った条ヘッダーを順次再付番してリナンバリング map 構築
        // 「第N条」 → 「第M条」 (N=元番号, M=新番号)
        const renumberMap = new Map();
        const headerScanRegex = /^([ 　\t]*第\s*)([0-9０-９零〇一二三四五六七八九十百千]+)(\s*条)/gm;
        const wideToNumber = (s) => {
            const wideDigits = '０１２３４５６７８９';
            const kanjiNums = { '零':0,'〇':0,'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10,'百':100,'千':1000 };
            if (/^[0-9]+$/.test(s)) return parseInt(s, 10);
            if (/^[０-９]+$/.test(s)) return parseInt(s.replace(/[０-９]/g, ch => String(wideDigits.indexOf(ch))), 10);
            // 漢数字 (簡易対応: 「十」「二十」「二十一」「百」程度まで)
            if (/^[零〇一二三四五六七八九十百千]+$/.test(s)) {
                let total = 0, current = 0;
                for (const ch of s) {
                    const v = kanjiNums[ch];
                    if (v === 10 || v === 100 || v === 1000) {
                        total += (current || 1) * v;
                        current = 0;
                    } else { current = current * 10 + v; }
                }
                return total + current;
            }
            return NaN;
        };
        let counter = 0;
        const orderedOriginalNumbers = [];
        let scanMatch;
        const scanText = cleaned;
        while ((scanMatch = headerScanRegex.exec(scanText)) !== null) {
            const origNum = wideToNumber(scanMatch[2]);
            if (Number.isFinite(origNum)) {
                counter += 1;
                if (!renumberMap.has(origNum)) {
                    renumberMap.set(origNum, counter);
                    orderedOriginalNumbers.push(origNum);
                }
            }
        }

        // [F-B] リナンバリング(詰め直し)は「削除で番号が空いた」場合だけに限定する（案A: 原番号保持）。
        // ・適用済みに削除型が1件も無い（MODIFY/ADDのみ）→ 条の集合は不変なので原番号を保持。
        // ・括弧見出し条項（（明渡し）等、第N条が付かない条）を含む文書 → 第N条だけ詰めると整合が崩れるので保持。
        // ・元から欠番のある（連番でない）文書 → 元の番号体系を尊重して保持。
        const hasAppliedDeletion = changes.some((c, idx) => {
            if (!applied.has(idx)) return false;
            const o = this._getChangeOldText(c);
            const n = this._buildLegalInsertionText(c);
            return String(c?.type || '').toUpperCase() === 'DELETE' || (Boolean(o) && !n);
        });
        const hasBracketHeadingClause = /(^|\n)[ 　\t]*[（(【][^）)】。\n]{1,20}[）)】][ 　\t]*(\n|$)/.test(sourceText);
        const originalNumbersContiguous = (() => {
            const re = /^[ 　\t]*第\s*([0-9０-９零〇一二三四五六七八九十百千]+)\s*条/gm;
            const nums = [];
            let m;
            while ((m = re.exec(sourceText)) !== null) {
                const v = wideToNumber(m[1]);
                if (Number.isFinite(v)) nums.push(v);
            }
            if (nums.length <= 1) return true;
            for (let i = 1; i < nums.length; i += 1) {
                if (nums[i] !== nums[i - 1] + 1) return false;
            }
            return nums[0] === 1;
        })();
        const allowRenumber = hasAppliedDeletion && !hasBracketHeadingClause && originalNumbersContiguous;

        // ステップ3: ヘッダー + 本文中の「第N条」参照を 並列(placeholder経由) で置換
        // 大→小順での順次置換は累積effect (第10条→第9条後、 第11条→第10条が再ヒットして
        // 全部第9条に化ける) があるため、 一旦 placeholder にしてから 新番号に戻す。
        if (allowRenumber && renumberMap.size && Array.from(renumberMap.entries()).some(([orig, neu]) => orig !== neu)) {
            const wideDigitsMap = { '0':'０','1':'１','2':'２','3':'３','4':'４','5':'５','6':'６','7':'７','8':'８','9':'９' };
            // フェーズ1: 全 「第N条」 を placeholder に一括置換 (大→小で、 全角/半角/連続数字を全カバー)
            const sortedOrig = orderedOriginalNumbers.slice().sort((a, b) => b - a);
            sortedOrig.forEach(origNum => {
                const widePattern = String(origNum).split('').map(d => `[${d}${wideDigitsMap[d]}]`).join('\\s*');
                const pattern = new RegExp(`第\\s*${widePattern}\\s*条`, 'g');
                cleaned = cleaned.replace(pattern, ` ART${origNum} `);
            });
            // フェーズ2: 各 placeholder を 新番号で本番置換 (順序に依存しない)
            renumberMap.forEach((newNum, origNum) => {
                cleaned = cleaned.split(` ART${origNum} `).join(`第${newNum}条`);
            });
        }

        return cleaned.replace(/\n{3,}/g, '\n\n').trim();
    },

    _getArticleText(article) {
        return [
            article?.articleNumber || article?.article || '',
            article?.title || article?.header || '',
            article?.content || article?.body || ''
        ].map(value => String(value || '')).join('\n');
    },

    _scoreArticleForChange(article, change) {
        const source = [
            this._getChangeNewText(change),
            change?.reason || '',
            change?.concern || '',
            change?.impact || ''
        ].join(' ');
        const haystack = this._getArticleText(article).replace(/\s+/g, '');
        if (!haystack) return 0;

        const keywords = Array.from(new Set(String(source || '')
            .replace(/[。、，,.]/g, ' ')
            .split(/\s+/)
            .flatMap(part => String(part || '').match(/[一-龥ぁ-んァ-ヶーA-Za-z0-9]{2,}/g) || [])
            .filter(token => token.length >= 2)));

        let score = 0;
        for (const keyword of keywords) {
            if (haystack.includes(keyword.replace(/\s+/g, ''))) score += keyword.length;
        }

        if (/権利金|返金|返還/.test(source) && /権利金|返還|返金/.test(haystack)) score += 80;
        if (/賃料|賃貸料|家賃/.test(source) && /賃料|賃貸料|家賃/.test(haystack)) score += 35;
        if (/解除|解約|催告|信頼関係|違反/.test(source) && /解除|解約|催告|信頼関係|違反/.test(haystack)) score += 70;
        if (/使用目的|営業|用途/.test(source) && /使用目的|営業|用途/.test(haystack)) score += 45;
        return score;
    },

    _findBestArticleForChange(change) {
        const articles = this._getStructuredOriginalArticles();
        let best = null;
        for (const article of articles) {
            const score = this._scoreArticleForChange(article, change);
            if (!best || score > best.score) best = { article, score };
        }
        return best && best.score >= 20 ? best.article : null;
    },

    _findArticleForChange(change) {
        const oldTextRaw = this._getChangeOldText(change);
        const hasOld = Boolean(oldTextRaw && oldTextRaw.trim());

        // [F1] 原文(oldText)を持つ修正案は「本文中で原文が実在する条」を最優先する。
        // これでカードの対象条項表示・並び順(extractArticleNum)・反映位置(_replaceChangeInsideArticle)が
        // すべて同じ「実在位置」基準で一致し、ラベルだけが食い違う不具合を防ぐ。
        if (hasOld) {
            const locatedInText = this._locateArticleHeadingByText(oldTextRaw, change);
            if (locatedInText) return locatedInText;
        } else {
            // 追加案(oldTextなし)は実在位置を持たないため、従来どおり明示ラベルを優先。
            const explicit = this._findExplicitArticleForChange(change);
            if (explicit) return explicit;
        }

        const oldText = oldTextRaw.replace(/\s+/g, '');
        const newText = this._getChangeNewText(change).replace(/\s+/g, '');
        const articles = this._getStructuredOriginalArticles();
        for (const article of articles) {
            const articleNumber = String(article?.articleNumber || article?.article || '').trim();
            const title = String(article?.title || article?.header || '').trim();
            const content = String(article?.content || article?.body || '').replace(/\s+/g, '');
            if (!articleNumber && !title) continue;
            if ((oldText && content.includes(oldText)) || (newText && content.includes(newText))) {
                return [articleNumber, title].filter(Boolean).join(' ').trim();
            }
        }

        // [F3] oldTextがあるのに本文・構造化条文のどちらでも特定できない場合は、
        // 検証できない第N条ラベルを表示しない（呼び出し側で「変更箇所 N」等の汎用表示になる）。
        if (hasOld) return '';

        const bestArticle = this._findBestArticleForChange(change);
        if (bestArticle) {
            return [
                bestArticle.articleNumber || bestArticle.article || '',
                bestArticle.title || bestArticle.header || ''
            ].filter(Boolean).join(' ').trim();
        }
        return '';
    },

    // 原文テキスト(oldText)が本文中で実在する「条」の見出しを返す。
    // 反映位置(_replaceChangeInsideArticle)と同じ優先順位で条を選ぶため、表示と反映が一致する。
    _locateArticleHeadingByText(rawText, change = null) {
        const needle = String(rawText || '').trim();
        const docText = this._getOriginalDocumentText() || this._getFinalDocumentText() || '';
        if (!docText) return '';
        const blocks = this._getArticleBlocksFromText(docText);
        if (!blocks.length) return '';
        const norm = (value) => this._normalizeCandidateText
            ? this._normalizeCandidateText(value)
            : String(value || '').replace(/[\s　]+/g, '');
        const needleNorm = norm(needle);
        const containsTarget = (block) => Boolean(needleNorm) && norm(block.text).includes(needleNorm);

        // 1) AIラベルの条が実際に原文を含むなら、その条（ラベルが正しいケース）。
        const explicit = change ? this._findExplicitArticleForChange(change) : '';
        const explicitPattern = explicit ? this._getArticleAnchorPattern(explicit) : '';
        if (explicitPattern) {
            const labelBlock = blocks.find(block => new RegExp(explicitPattern).test(block.heading));
            if (labelBlock && containsTarget(labelBlock)) return labelBlock.heading;
        }
        // 2) 原文を実際に含む条（ラベルが誤っていてもここで実在位置に揃う）。
        const exact = needleNorm ? blocks.find(containsTarget) : null;
        if (exact) return exact.heading;
        // 3) スコアベースの最良条（反映側のfuzzyフォールバックと同じ基準）。
        if (change) {
            const best = this._findBestTextArticleForChange(docText, change);
            if (best) return best.heading;
        }
        return '';
    },

    _getChangeDisplaySection(change, index) {
        if (!this._getChangeOldText(change)) {
            const text = this._getOriginalDocumentText() || this._ensureEditedContent();
            return this._resolveAdditionTargetArticle(text, change, index)?.heading || `本文内の追記位置 ${index + 1}`;
        }
        const article = this._findArticleForChange(change);
        if (article) return article;
        return `変更箇所 ${index + 1}`;
    },

    _getChangeKind(change) {
        const type = String(change?.type || '').toUpperCase();
        const oldText = this._getChangeOldText(change);
        const newText = this._buildLegalInsertionText(change);
        if (type === 'DELETE' || (oldText && !newText)) return 'delete';
        if (type === 'ADD' || (!oldText && newText)) return 'add';
        // MODIFY: 明確化キーワード（明確 / 解釈）を含むなら 'clar'
        const meta = `${String(change?.impact || '')} ${String(change?.concern || '')} ${String(change?.reason || '')}`;
        if (meta.includes('明確') || meta.includes('解釈')) return 'clar';
        return 'modify';
    },

    _buildLegalInsertionText(change) {
        const newText = this._getChangeNewText(change);
        if (!newText) return '';

        // Preserve line breaks — only collapse non-newline whitespace
        let raw = String(newText)
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n')
            .replace(/[^\S\n]+/g, ' ')   // collapse spaces/tabs but NOT newlines
            .trim();

        if (!raw) return '';

        // Strip AI meta-commentary that must not appear in the document
        raw = raw
            .replace(/^このリスクを抑えるため、次の条文を追加することを提案します。?\n?/g, '')
            .replace(/条項が追加されており、?/g, '')
            .replace(/条項が追加された。?$/gm, '')
            .replace(/が追加されている。?$/gm, '')
            .replace(/リスクが高い。?$/gm, '')
            .trim();

        // If the AI already produced proper clause text, use it directly.
        if (this._looksLikeUsableLegalClause(raw)) return raw;

        const synthesized = this._synthesizeUsableLegalClause(change, raw);
        if (synthesized) return synthesized;

        // Hardcoded high-quality fallbacks for known clause patterns
        if (/権利金/.test(raw) && /返金|返還|返済/.test(raw)) {
            return '乙が甲に対して支払った権利金は、本契約の終了、解除又は解約の理由のいかんを問わず、甲は乙に返還しないものとする。';
        }
        if (/賃料|賃貸料|家賃/.test(raw) && /遅延|遅滞|滞納|解除|催告/.test(raw)) {
            return '乙が賃料その他本契約に基づく金銭債務の支払を遅滞し、又は本契約に違反した場合、甲は、相当の期間を定めて乙に催告し、当該期間内に履行又は是正がなされないときに限り、本契約を解除することができる。ただし、乙の違反により甲乙間の信頼関係が著しく破壊された場合は、この限りでない。';
        }
        if (/信頼関係|軽微|違反|催告なし|解除/.test(raw)) {
            return '乙が本契約に違反した場合、甲は、相当の期間を定めて乙に催告し、当該期間内に是正がなされないときに限り、本契約を解除することができる。ただし、乙の違反により甲乙間の信頼関係が著しく破壊された場合は、この限りでない。';
        }

        // Generic: ensure ends with proper legal punctuation
        const normalized = raw.replace(/。?$/, '');
        return `${normalized}ものとする。`;
    },

    _looksLikeLegalCommentary(text) {
        const value = String(text || '').trim();
        if (!value) return false;
        if (this._looksLikeUsableLegalClause(value)) return false;
        if (/不足|不明確|曖昧|具体的|指摘|リスク|必要|提案|べき|されている|されていない|高い|低い/.test(value)) return true;
        if (/第\s*[0-9０-９一二三四五六七八九十百千]+\s*条.*(が|において|では)/.test(value)) return true;
        if (!/(ものとする|しなければならない|負う|負わない|できる|できない|定める|講じる|通知する|協議する)/.test(value)) return true;
        return false;
    },

    _looksLikeUsableLegalClause(text) {
        const value = String(text || '').trim();
        if (!value || !/[。」）]\s*$/.test(value)) return false;
        if (/^[\s　]*[・\-*]/m.test(value)) return false;
        if (/このリスク|次の条文|提案します|検討|不足|不明確|曖昧|指摘/.test(value)) return false;
        return /(ものとする|ものとします|しなければならない|負う|負わない|できる|できない|定める|講じる|講じます|通知する|協議する|提供してはならない)/.test(value);
    },

    _synthesizeUsableLegalClause(change, rawText = '') {
        const section = this._findArticleForChange(change) || String(change?.section || change?.article || '');
        const source = [
            section,
            rawText,
            this._getChangeOldText(change),
            change?.issue || '',
            change?.reason || '',
            change?.concern || '',
            change?.risk || '',
            change?.impact || ''
        ].join(' ');

        if (/(電子契約|AI生成物|成果物.*最終確認|最終確認.*成果物)/.test(source)) {
            return '電子契約サービスによる本契約の締結は有効な締結方法として認められるものとし、チャット、メール、プロジェクト管理ツールその他電磁的方法による指示についても正式な指示として取り扱うものとする。また、AI生成物を含む成果物については、利用前に委託者が最終確認を行うものとする。';
        }

        if (!this._looksLikeLegalCommentary(rawText)) return '';

        if (/個人情報|共同利用|漏洩|漏えい|漏えい等|安全管理|個人データ/.test(source)) {
            if (/管理責任|管理者|責任者|甲に集中|委託|共同/.test(source)) {
                return '甲及び乙は、共同利用する個人情報について、それぞれの取扱範囲及び管理責任を明確にし、個人情報保護法その他関係法令に従い、漏えい、滅失又は毀損を防止するために必要かつ適切な安全管理措置を講じるものとする。';
            }
            if (/損害賠償|賠償|上限|5,000|5000|高額|責任/.test(source)) {
                return '個人情報の漏えい、滅失、毀損その他本契約に違反して損害が発生した場合、当該損害について責めに帰すべき事由を有する当事者は、通常かつ直接の損害に限り賠償責任を負うものとする。ただし、故意又は重過失、法令違反又は秘密保持義務違反により生じた損害については、当該責任制限を適用しないものとする。';
            }
            if (/本人|開示|訂正|利用停止|請求|対応/.test(source)) {
                return '本人から共同利用する個人情報について開示、訂正、追加、削除、利用停止、消去又は第三者提供の停止その他法令上認められる請求があった場合、甲及び乙は、相互に協力し、法令に従い速やかに対応するものとする。';
            }
            if (/委員会|報告|通知|監督官庁|個人情報保護委員会/.test(source)) {
                return '個人情報の漏えい等が発生し、又はそのおそれがあることを知った場合、甲及び乙は、直ちに相手方へ通知し、原因調査、被害拡大防止、本人への通知及び個人情報保護委員会その他関係機関への報告について、法令に従い相互に協力して対応するものとする。';
            }
            return '甲及び乙は、共同利用する個人情報を本契約の目的の範囲内でのみ取り扱い、法令に基づく場合を除き、相手方の事前の書面による承諾なく第三者に提供してはならないものとする。';
        }

        if (/秘密|機密|Confidential|情報管理/.test(source)) {
            return '甲及び乙は、本契約に関連して知り得た相手方の秘密情報を善良なる管理者の注意をもって管理し、本契約の目的以外に使用せず、相手方の事前の書面による承諾なく第三者に開示又は漏えいしてはならないものとする。';
        }

        if (/解除|解約|催告|違反|信頼関係/.test(source)) {
            return '相手方が本契約に違反した場合、当事者は、相当の期間を定めて是正を催告し、当該期間内に是正されないときに限り、本契約を解除することができる。ただし、重大な違反により契約の継続が困難となった場合はこの限りでない。';
        }

        return '';
    },

    _getChangeAnchorTexts(change) {
        const candidates = [
            change?.section,
            change?.article,
            change?.articleNumber,
            change?.title,
            change?.clause,
            this._findArticleForChange(change),
            this._getChangeOldText(change)
        ];
        const seen = new Set();
        return candidates
            .map(value => String(value || '').trim())
            .filter(value => {
                if (!value || seen.has(value)) return false;
                seen.add(value);
                return true;
            });
    },

    _escapeRegex(value) {
        return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    },

    _getArticleAnchorPattern(value) {
        const match = String(value || '').match(/第\s*([0-9０-９零〇一二三四五六七八九十百千]+)\s*条/);
        if (!match) return '';
        const raw = match[1];
        const normalized = raw.replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
        const numberPattern = /^[0-9]+$/.test(normalized)
            ? normalized.split('').map(digit => `[${digit}${String.fromCharCode(digit.charCodeAt(0) + 0xFEE0)}]`).join('\\s*')
            : this._escapeRegex(raw);
        return `第\\s*${numberPattern}\\s*条`;
    },

    _getSortedAiChanges() {
        const contract = this._contract || {};
        const aiChangesRaw = Array.isArray(contract.ai_changes) ? contract.ai_changes.filter(Boolean) : [];
        // B5 修正: old===new（実質的な変更なし）の無意味な提案をフィルターアウト
        // AI が「修正」と称して同じテキストを返すケースを商用品質基準で除外
        // ただし _buildLegalInsertionText で「ものとする」等を補強した結果 new が変わる場合は有意味として残す
        const isMeaningfulChange = (c) => {
            const stripWs = (s) => String(s || '').replace(/[\s　]+/g, '');
            const oldT = stripWs(c?.old || c?.oldText || c?.before || '');
            const rawNewT = stripWs(c?.new || c?.newText || c?.after || '');
            const builtNewT = this._buildLegalInsertionText
                ? stripWs(this._buildLegalInsertionText(c) || '')
                : rawNewT;
            // 削除（new 空 = built も空）
            if (oldT && !rawNewT && !builtNewT) return true;
            // 追加（old 空、new あり）
            if (!oldT && (rawNewT || builtNewT)) return true;
            // 両方ある: builtNew が old と異なれば有意味
            if (oldT && builtNewT) return oldT !== builtNewT;
            // 両方空はバグ
            return false;
        };
        const aiChangesFiltered = aiChangesRaw.filter(isMeaningfulChange);
        const filteredOut = aiChangesRaw.length - aiChangesFiltered.length;
        if (filteredOut > 0) {
            console.info(`[DIFFsense] ${filteredOut} 件の無価値な修正案 (old===new) をフィルターしました`);
        }
        // B4 修正: section/target/article を全部参照、漢数字（一〜十）にも対応、未番号セクション（特記事項等）は末尾
        const kanjiMap = { '零':0,'〇':0,'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10 };
        const extractArticleNum = (change) => {
            const source = (this._findArticleForChange ? this._findArticleForChange(change) : '')
                || String(change?.section || change?.target || change?.article || '');
            const match = String(source).match(/第\s*([0-9０-９零〇一二三四五六七八九十]+)\s*条/);
            if (!match) return 9999;
            const raw = String(match[1]).replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
            if (kanjiMap[raw] !== undefined) return kanjiMap[raw];
            const n = parseInt(raw, 10);
            return Number.isFinite(n) ? n : 9999;
        };
        // 安定ソート（同番号は元順を保持）のため index を保持
        return aiChangesFiltered
            .map((c, i) => ({ c, i, n: extractArticleNum(c) }))
            .sort((a, b) => a.n - b.n || a.i - b.i)
            .map(x => x.c);
    },

    _getActiveSortedAiChanges() {
        const fresh = this._getSortedAiChanges();
        if (fresh.length) {
            this._sortedChanges = fresh;
            return fresh;
        }
        return Array.isArray(this._sortedChanges) ? this._sortedChanges.filter(Boolean) : [];
    },

    _getOriginalDocumentText() {
        return this._getOriginalFallbackText(this._contract || {});
    },

    _getOriginalFallbackText(contract = this._contract || {}) {
        return stripHtmlFallbackText(this._getRawText(
            contract?.original_content
            || contract?.content
            || contract?.extracted_text
            || contract?.pdf_raw_text
            || contract?.text
            || ''
        ));
    },

    _hasOriginalTextFallback(contract = this._contract || {}) {
        return Boolean(this._getOriginalFallbackText(contract).trim());
    },

    async _renderOriginalTextFallbackIfAvailable(container = this._viewerContainer, mountId = 'pdf-pages-container') {
        if (this._viewMode !== 'original' || mountId !== 'pdf-pages-container') return false;
        const snapshot = this._currentRequest?.document_snapshot || this._currentRequest?.contract_snapshot || {};
        const liveContract = this._contract || dbService.getContractById(this._currentRequest?.contract_id) || null;
        const fallbackContract = liveContract ? { ...snapshot, ...liveContract } : snapshot;
        const fallbackText = this._getOriginalFallbackText(fallbackContract);
        if (!fallbackText.trim() || !container) return false;

        this._currentPdfUrl = '';
        this._pdfDoc = null;
        await this.renderTextFallback({ ...fallbackContract, pdf_raw_text: fallbackText }, container);
        return true;
    },

    _getOriginalPageCount() {
        const contract = this._contract || {};
        const request = this._currentRequest || {};
        const directCount = [
            this._originalPageCount,
            contract.document_meta?.pageCount,
            contract.document_meta?.page_count,
            contract.document_meta?.pages,
            contract.page_images?.length,
            contract.pageImages?.length,
            contract.original_page_count,
            contract.page_count,
            contract.total_pages,
            request.original_page_count,
            request.page_count,
            request.total_pages
        ].map(Number).find(value => Number.isFinite(value) && value > 0);
        if (directCount) return Math.max(1, Math.round(directCount));

        const docxPages = new Set();
        document.querySelectorAll('#sign-viewer-docx-pages [data-page]').forEach(node => {
            const page = Number(node.dataset.page);
            if (Number.isFinite(page) && page > 0) docxPages.add(page);
        });
        if (docxPages.size > 0) return docxPages.size;

        const pdfPageCount = document.querySelectorAll('#pdf-pages-container > div[data-page]').length;
        if (this._viewMode === 'original' && pdfPageCount > 0) return pdfPageCount;

        return null;
    },

    _getFinalDocumentText() {
        if (this._editedContent !== undefined) return String(this._editedContent || '');
        const text = this._contract?.final_content || this._getOriginalDocumentText();
        return this._normalizeFinalLayoutText(text);
    },

    _normalizeFinalLayoutText(text, options = {}) {
        let normalized = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        if (options.preserveOriginalStructure === true) {
            return normalized.replace(/^\uFEFF/, '').trimEnd();
        }
        normalized = normalized.trim();
        if (this._shouldRestoreDocxLineBreaks()) {
            normalized = this._restoreCollapsedDocxLineBreaks(normalized);
        }
        normalized = this._restoreMissingArticleNumbersFromStructuredText(normalized);
        normalized = this._repairArticleHeadingLines(normalized);
        normalized = this._tidyFinalLayoutSpacingAndParens(normalized);
        return normalized;
    },

    // 取り込み表示の崩れ対策:
    // (1) 見出しカッコの二重化「（（…））」を単一「（…）」へ補正
    // (2) 空行は条見出し(第N条 等)の直前にのみ残し、条文内の余分な空行を除去（原文の体裁に合わせる）
    _tidyFinalLayoutSpacingAndParens(text) {
        const isHeading = (s) => /^[\s　]*第\s*[0-9０-９一二三四五六七八九十百千〇零○◯]+\s*[条章節]/.test(String(s || ''));
        const lines = String(text || '')
            .replace(/（（([^（）]+)））/g, '（$1）')
            .replace(/^([^\s（）]{1,10})\s*（\1）\s*$/gm, '$1')
            .split('\n');
        const out = [];
        for (let i = 0; i < lines.length; i += 1) {
            if (lines[i].trim() === '') {
                let j = i + 1;
                while (j < lines.length && lines[j].trim() === '') j += 1;
                const nextIsHeading = j < lines.length && isHeading(lines[j]);
                const prevExists = out.length > 0 && out[out.length - 1].trim() !== '';
                if (nextIsHeading && prevExists) out.push('');
                i = j - 1;
                continue;
            }
            out.push(lines[i]);
        }
        return out.join('\n').trim();
    },

    _restoreMissingArticleNumbersFromStructuredText(text) {
        const articles = this._getStructuredOriginalArticles();
        if (!articles.length) return text;

        const titleToNumber = new Map();
        articles.forEach((article, index) => {
            const number = this._normalizeArticleHeadingLine(String(article?.articleNumber || article?.article || article?.clause || `第${index + 1}条`).trim());
            const title = String(article?.title || article?.header || '').trim();
            if (number && title) titleToNumber.set(title.replace(/\s+/g, ''), number);
        });
        if (!titleToNumber.size) return text;

        return String(text || '').split('\n').map((line) => {
            const trimmed = line.trim();
            if (!trimmed || /^第\s*[0-9０-９一二三四五六七八九十百千〇零○◯]+\s*[条章節]/.test(trimmed)) return line;
            const matchedNumber = titleToNumber.get(trimmed.replace(/\s+/g, ''));
            return matchedNumber ? line.replace(trimmed, `${matchedNumber} ${trimmed}`) : line;
        }).join('\n');
    },

    _repairArticleHeadingLines(text) {
        const lines = String(text || '').split('\n');
        const repaired = [];
        for (let i = 0; i < lines.length; i += 1) {
            const current = String(lines[i] || '');
            const trimmed = current.trim();
            const next = String(lines[i + 1] || '').trim();

            if (trimmed === '第' && /^[0-9０-９一二三四五六七八九十百千〇零○◯]+\s*[条章節]/.test(next)) {
                repaired.push(current.replace(/第\s*$/, '') + this._normalizeArticleHeadingLine(`第${next}`));
                i += 1;
                continue;
            }

            const normalizedHeading = this._normalizeArticleHeadingLine(trimmed);
            if (normalizedHeading !== trimmed && /^[\s　]*[0-9０-９一二三四五六七八九十百千〇零○◯]+\s*[条章節]/.test(current)) {
                repaired.push(current.replace(trimmed, normalizedHeading));
                continue;
            }
            repaired.push(current);
        }
        return repaired.join('\n');
    },

    _shouldRestoreDocxLineBreaks() {
        const contract = this._contract || {};
        const request = this._currentRequest || {};
        const source = [
            contract.doc_type,
            contract.document_type,
            contract.original_filename,
            contract.filename,
            contract.original_file_url,
            contract.original_file_path,
            request.original_filename,
            request.original_file_url,
            request.original_file_path,
            this._currentFilename
        ].join(' ').toLowerCase();
        return /\bdocx?\b|\.docx?($|[\s?#])/.test(source);
    },

    _restoreCollapsedDocxLineBreaks(text) {
        const articlePattern = '第\\s*[0-9０-９一二三四五六七八九十百千〇零○◯]+\\s*[条章節]';
        return String(text || '')
            .split('\n')
            .flatMap((line) => {
                let next = String(line || '');
                if (!next.trim()) return [next];

                next = next
                    .replace(new RegExp(`([^\\n])\\s*(${articlePattern})`, 'g'), (_m, before, article) => {
                        if (!String(before || '').trim()) return `${before}${article}`;
                        return `${before}\n${article}`;
                    })
                    .replace(/([^\n])\s*(※(?=\S))/g, '$1\n$2');

                const bulletCount = (next.match(/・/g) || []).length;
                if (bulletCount >= 2 || /[:：]\s*・/.test(next)) {
                    next = next
                        .replace(/([:：])\s*・/g, '$1\n・')
                        .replace(/([^\n])・(?=\S)/g, '$1\n・');
                }

                next = next.replace(/([^\n])\s*([（(][一二三四五六七八九十0-9０-９]+[）)])(?=\S)/g, (_m, before, marker) => {
                    if (/第\s*[0-9０-９一二三四五六七八九十百千〇零○◯]+\s*[条章節]$/.test(before)) {
                        return `${before}${marker}`;
                    }
                    return `${before}\n${marker}`;
                });

                return next.split('\n');
            })
            .join('\n')
            .replace(/\n{4,}/g, '\n\n\n')
            .trim();
    },




    _getOriginalPdfUrlForPageCount() {

        const contract = this._contract || {};
        const request = this._currentRequest || {};
        const candidates = [
            contract.pdf_url,
            contract.pdf_storage_path,
            request.pdf_url,
            request.pdf_storage_path
        ];
        const directPdf = candidates
            .map(value => resolveBackendAssetUrl(value))
            .find(value => value && !/\.docx?($|[?#])/i.test(String(value)));
        if (directPdf) return directPdf;

        const originalName = String(contract.original_filename || request.original_filename || '');
        const originalUrl = resolveBackendAssetUrl(contract.original_file_url || contract.original_file_path || request.original_file_url || request.original_file_path);
        if (originalUrl && !isDocxFileName(originalName) && !/\.docx?($|[?#])/i.test(String(originalUrl))) {
            return originalUrl;
        }
        return '';
    },

    async _ensureOriginalPageCount() {
        const knownCount = this._getOriginalPageCount();
        if (this._isOriginalDocxContract()) {
            const docxCount = await this._ensureOriginalDocxPageCount();
            if (docxCount) return docxCount;
        }
        if (knownCount) return knownCount;
        const pdfUrl = this._getOriginalPdfUrlForPageCount();
        if (!pdfUrl) return null;

        try {
            await this.loadPdfJs();
            const loadingTask = pdfjsLib.getDocument({
                url: pdfUrl,
                cMapUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/cmaps/',
                cMapPacked: true,
                standardFontDataUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/standard_fonts/',
                useWorkerFetch: true
            });
            const pdf = await loadingTask.promise;
            if (pdf?.numPages) this._originalPageCount = pdf.numPages;
            if (typeof pdf?.destroy === 'function') {
                await pdf.destroy();
            }
            return this._originalPageCount || null;
        } catch (error) {
            console.warn('[SignViewer] Could not read original page count:', error);
            return null;
        }
    },

    _isOriginalDocxContract() {
        const contract = this._contract || {};
        const request = this._currentRequest || {};
        const source = [
            contract.source_type,
            contract.doc_type,
            contract.document_type,
            contract.original_filename,
            contract.filename,
            contract.original_file_url,
            contract.original_file_path,
            request.original_filename,
            request.original_file_url,
            request.original_file_path,
            this._originalFileName,
            this._currentFilename
        ].join(' ').toLowerCase();
        return /\bdocx?\b|\.docx?($|[\s?#])/.test(source);
    },

    async _resolveOriginalDocxSourceForPageCount() {
        if (!this._isOriginalDocxContract()) return null;
        const contractId = this._currentRequest?.contract_id || this._currentRequest?.contractId || this._contract?.id || this._contractId;
        if (this._app && typeof this._app.getRuntimeOriginalPreviewFile === 'function') {
            const runtimeFile = this._app.getRuntimeOriginalPreviewFile(contractId);
            if (runtimeFile instanceof Blob) return runtimeFile;
        }
        if (this._app && typeof this._app.getDocxFromIDB === 'function') {
            const cachedFile = await this._app.getDocxFromIDB(contractId);
            if (cachedFile instanceof Blob) return cachedFile;
        }
        const contract = this._contract || {};
        const request = this._currentRequest || {};
        const originalUrl = resolveBackendAssetUrl(
            contract.original_file_url
            || contract.original_file_path
            || request.original_file_url
            || request.original_file_path
        );
        return /\.docx?($|[?#])/i.test(String(originalUrl || '')) ? originalUrl : null;
    },

    async _ensureOriginalDocxPageCount() {
        if (!this._isOriginalDocxContract()) return null;
        const knownCount = Number(this._originalPageCount || 0);
        if (knownCount > 1) return knownCount;
        const source = await this._resolveOriginalDocxSourceForPageCount();
        if (!source) return null;

        const probe = document.createElement('div');
        probe.style.cssText = [
            'position:absolute',
            'left:-30000px',
            'top:0',
            'width:900px',
            'visibility:hidden',
            'pointer-events:none',
            'overflow:hidden'
        ].join(';');
        document.body.appendChild(probe);

        try {
            const pages = await renderDocxPreviewPages(probe, source);
            const renderedCount = Array.isArray(pages) ? pages.length : 0;
            const declaredCount = await this._getDocxDeclaredPageCount(source);
            const count = Math.max(renderedCount, declaredCount || 0);
            if (count > 0) {
                this._originalPageCount = count;
                if (this._contract) this._contract.original_page_count = count;
                console.log('[SignViewer] Original DOCX page count locked:', {
                    count,
                    renderedCount,
                    declaredCount
                });
                return count;
            }
        } catch (error) {
            console.warn('[SignViewer] Could not measure original DOCX page count:', error);
            const declaredCount = await this._getDocxDeclaredPageCount(source);
            if (declaredCount) {
                this._originalPageCount = declaredCount;
                if (this._contract) this._contract.original_page_count = declaredCount;
                return declaredCount;
            }
        } finally {
            probe.remove();
        }
        return null;
    },

    async _getSourceArrayBuffer(source) {
        if (source instanceof Blob) return source.arrayBuffer();
        if (typeof source === 'string' && source.trim()) {
            const response = await fetch(source);
            if (!response.ok) throw new Error(`DOCX fetch failed: ${response.status}`);
            return response.arrayBuffer();
        }
        return null;
    },

    async _getDocxDeclaredPageCount(source) {
        try {
            if (!window.JSZip) return null;
            const arrayBuffer = await this._getSourceArrayBuffer(source);
            if (!arrayBuffer) return null;
            const zip = await window.JSZip.loadAsync(arrayBuffer);
            const documentXml = await zip.file('word/document.xml')?.async('string');
            if (!documentXml) return null;
            const explicitBreaks = (documentXml.match(/<w:br\b[^>]*w:type=["']page["'][^>]*>/g) || []).length;
            const renderedBreaks = (documentXml.match(/<w:lastRenderedPageBreak\b/g) || []).length;
            const pageBreaks = Math.max(explicitBreaks, renderedBreaks);
            return pageBreaks > 0 ? pageBreaks + 1 : null;
        } catch (error) {
            console.warn('[SignViewer] Could not read DOCX declared page breaks:', error);
            return null;
        }
    },

    _rememberOriginalPageCountFromRenderedSource() {
        const docxPages = new Set();
        document.querySelectorAll('#sign-viewer-docx-pages [data-page]').forEach(node => {
            const page = Number(node.dataset.page);
            if (Number.isFinite(page) && page > 0) docxPages.add(page);
        });
        const pdfPageCount = document.querySelectorAll('#pdf-pages-container > div[data-page]').length;
        const candidate = [
            this._totalPages,
            this._contract?.page_images?.length,
            this._contract?.pageImages?.length,
            docxPages.size,
            pdfPageCount
        ].map(Number).find(value => Number.isFinite(value) && value > 0);
        if (candidate) {
            this._originalPageCount = Math.max(1, Math.round(candidate));
        }
        return this._originalPageCount || null;
    },

    async _getPdfBlobPageCount(blob) {
        if (!(blob instanceof Blob)) return null;
        let objectUrl = '';
        try {
            await this.loadPdfJs();
            objectUrl = URL.createObjectURL(blob);
            const loadingTask = pdfjsLib.getDocument({
                url: objectUrl,
                cMapUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/cmaps/',
                cMapPacked: true,
                standardFontDataUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/standard_fonts/',
                useWorkerFetch: true
            });
            const pdf = await loadingTask.promise;
            const count = Number(pdf?.numPages || 0);
            if (typeof pdf?.destroy === 'function') {
                await pdf.destroy();
            }
            return count > 0 ? count : null;
        } catch (error) {
            console.warn('[SignViewer] Could not inspect generated PDF page count:', error);
            return null;
        } finally {
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        }
    },

    _repairAppliedAdditionClauseQuality(finalText) {
        const changes = this._getActiveSortedAiChanges();
        const applied = this._getStoredAppliedChangeIndexes();
        let nextText = String(finalText || '');
        let changed = false;

        changes.forEach((change, index) => {
            if (!applied.has(index) || !this._isAdditionChange(change)) return;
            const rawText = this._getChangeNewText(change).trim();
            const legalText = this._buildLegalInsertionText(change).trim();
            if (!legalText) return;
            if (rawText && rawText !== legalText && this._textContainsCandidate(nextText, rawText) && !this._textContainsCandidate(nextText, legalText)) {
                nextText = this._removeCandidateText(nextText, rawText);
            }
            const before = nextText;
            change.__diffsenseApplyIndex = index;
            nextText = this._insertAdditionalClauseIntoArticle(nextText, change, legalText);
            delete change.__diffsenseApplyIndex;
            if (nextText !== before) changed = true;
        });

        if (changed) {
            this._editedContent = nextText;
            this._editedHtml = '';
            if (this._contract) {
                this._contract.final_content = nextText;
                this._contract.final_content_html = '';
                setTimeout(() => {
                    try {
                        dbService.updateContract(this._contract.id, {
                            final_content: nextText,
                            final_content_html: ''
                        });
                    } catch (e) {
                        console.warn('[SignViewer] _repairAppliedAdditionClauseQuality: DB update skipped:', e);
                    }
                }, 0);
            }
        }
        return nextText;
    },

    _ensureEditedContent() {
        if (this._editedContent === undefined) {
            this._editedContent = this._getFinalDocumentText();
            this._lastSavedContent = this._lastSavedContent ?? this._editedContent;
        }
        return String(this._editedContent || '');
    },

    _isFinalEditorVisible() {
        const scroll = document.getElementById('v3-editor-scroll');
        if (!scroll) return false;
        const layer = scroll.closest('#v3-edit-layer');
        return Boolean(scroll.offsetParent && (!layer || getComputedStyle(layer).display !== 'none'));
    },

    _replaceTextByNormalizedSlice(text, oldText, newText) {
        const source = String(text || '');
        const target = String(oldText || '');
        const replacement = String(newText || '');
        if (!source || !target) return null;
        const normalizeChar = (ch) => /[\s\u200B-\u200D\uFEFF]/.test(ch) ? '' : ch;
        let normalizedSource = '';
        const indexMap = [];
        for (let i = 0; i < source.length; i += 1) {
            const normalized = normalizeChar(source[i]);
            if (!normalized) continue;
            normalizedSource += normalized;
            indexMap.push(i);
        }
        const normalizedTarget = Array.from(target).map(normalizeChar).join('');
        if (!normalizedTarget) return null;
        const hit = normalizedSource.indexOf(normalizedTarget);
        if (hit < 0) return null;
        const start = indexMap[hit];
        const end = indexMap[hit + normalizedTarget.length - 1] + 1;
        return source.slice(0, start) + replacement + source.slice(end);
    },

    _replaceTextByLooseLegalSlice(text, oldText, newText) {
        const source = String(text || '');
        const target = String(oldText || '');
        if (!source || !target) return null;
        const normalizeChar = (ch) => /[\s　\u200B-\u200D\uFEFF（）()]/.test(ch) ? '' : ch;
        let normalizedSource = '';
        const indexMap = [];
        for (let i = 0; i < source.length; i += 1) {
            const normalized = normalizeChar(source[i]);
            if (!normalized) continue;
            normalizedSource += normalized;
            indexMap.push(i);
        }
        const normalizedTarget = Array.from(target).map(normalizeChar).join('');
        if (!normalizedTarget) return null;
        const hit = normalizedSource.indexOf(normalizedTarget);
        if (hit < 0) return null;
        const start = indexMap[hit];
        const end = indexMap[hit + normalizedTarget.length - 1] + 1;
        const removed = source.slice(start, end);
        const prefix = source.slice(0, start);
        let replacement = String(newText || '');
        const openedInHeading = /第\s*[0-9０-９零〇一二三四五六七八九十百千]+\s*条[^\n]*（[^\n]*$/.test(prefix);
        if (openedInHeading && removed.includes('）') && !/）\s*$/.test(replacement)) {
            replacement += '）';
        }
        return prefix + replacement + source.slice(end);
    },

    _replaceChangeInsideArticle(text, change, oldText, newText, index = 0) {
        const source = String(text || '');
        const target = String(oldText || '').trim();
        const replacement = String(newText || '').trim();
        if (!source || !target || !replacement) return null;

        const blocks = this._getArticleBlocksFromText(source);
        if (!blocks.length) return null;
        const norm = (value) => this._normalizeCandidateText ? this._normalizeCandidateText(value) : String(value || '').replace(/[\s　]+/g, '');
        const explicit = this._findExplicitArticleForChange(change);
        const explicitPattern = explicit ? this._getArticleAnchorPattern(explicit) : '';
        const targetNorm = norm(target);
        const containsTarget = (item) => Boolean(targetNorm) && norm(item.text).includes(targetNorm);
        // [F2] 原文(target)が実在する条を最優先する。AIラベル(explicit)は、その条が原文を
        // 実際に含む場合のみ採用し、ラベルを盲信して無関係な条へ反映しない。
        let block = null;
        if (explicitPattern) {
            const labelBlock = blocks.find(item => new RegExp(explicitPattern).test(item.heading));
            if (labelBlock && containsTarget(labelBlock)) block = labelBlock;
        }
        if (!block) block = blocks.find(containsTarget) || null;
        if (!block) {
            block = (explicitPattern ? blocks.find(item => new RegExp(explicitPattern).test(item.heading)) : null)
                || this._findBestTextArticleForChange(source, change)
                || blocks[Math.min(Math.max(0, Number(index) || 0), blocks.length - 1)];
        }
        if (!block) return null;

        const blockText = source.slice(block.start, block.end);
        if (blockText.includes(target)) {
            const replaced = blockText.replace(target, replacement);
            return source.slice(0, block.start) + replaced + source.slice(block.end);
        }
        const normalizedBlockReplace = this._replaceTextByNormalizedSlice(blockText, target, replacement);
        if (normalizedBlockReplace !== null) {
            return source.slice(0, block.start) + normalizedBlockReplace + source.slice(block.end);
        }
        const looseBlockReplace = this._replaceTextByLooseLegalSlice(blockText, target, replacement);
        if (looseBlockReplace !== null) {
            return source.slice(0, block.start) + looseBlockReplace + source.slice(block.end);
        }

        const oldLines = target.split(/\n+/).map(line => line.trim()).filter(Boolean);
        if (!oldLines.length) return null;
        let nextBlock = blockText;
        let changed = false;
        let replacementPlaced = this._textContainsCandidate(nextBlock, replacement);

        oldLines.forEach((line) => {
            const lineNorm = norm(line);
            if (!lineNorm || !norm(nextBlock).includes(lineNorm)) return;
            if (norm(replacement).includes(lineNorm)) {
                replacementPlaced = true;
                return;
            }
            const lineReplacement = replacementPlaced ? '' : replacement;
            const replacedLine = this._replaceTextByNormalizedSlice(nextBlock, line, lineReplacement);
            if (replacedLine !== null && replacedLine !== nextBlock) {
                nextBlock = replacedLine;
                changed = true;
                if (lineReplacement) replacementPlaced = true;
            }
        });

        if (!changed) return null;
        nextBlock = nextBlock
            .replace(/[ \t　]+\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n');
        if (!this._textContainsCandidate(nextBlock, replacement)) return null;
        return source.slice(0, block.start) + nextBlock + source.slice(block.end);
    },

    _applyChangeToText(text, change, index = 0) {
        const oldText = this._getChangeOldText(change);
        const newText = this._buildLegalInsertionText(change);
        let nextText = String(text || '');
        const normalize = (s) => String(s || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\r\n/g, '\n').trim();
        const normOld = normalize(oldText);
        const normNew = normalize(newText);
        const normBase = normalize(nextText);
        const isDeletionChange = String(change?.type || '').toUpperCase() === 'DELETE'
            || (Boolean(normOld) && !normNew);

        // DELETE: 本文からは物理削除せず、視覚マーカー（赤・取消し線）で削除済みを示す
        if (isDeletionChange) {
            return nextText;
        }

        if (!normNew) return nextText;

        // ADD案（oldText が無く newText のみ）で、newText が既に本文に存在する場合は
        // 重複挿入を防ぐため本文を変更せずに返す（マーカー処理だけ走る）
        if (!normOld && normNew) {
            const normalizedDoc = this._normalizeCandidateText(nextText);
            const normalizedNewText = this._normalizeCandidateText(newText);
            if (normalizedNewText.length >= 4 && normalizedDoc.includes(normalizedNewText)) {
                change.__diffsenseApplyIndex = index;
                const relocated = this._insertAdditionalClauseIntoArticle(nextText, change, newText);
                delete change.__diffsenseApplyIndex;
                return relocated;
            }
        }

        let applied = false;

        // MODIFY案（oldTextあり）の場合の置換処理
        if (oldText) {
            // 1. 【最優先】条文の中での置換を試みる (Boilerplate衝突を避けるため)
            const articleReplace = this._replaceChangeInsideArticle(nextText, change, oldText, newText, index);
            if (articleReplace !== null && articleReplace !== nextText) {
                nextText = articleReplace;
                applied = true;
            }

            // 2. 条文内での置換が失敗した場合、グローバル置換（厳密マッチ）を試みる
            if (!applied && normBase.includes(normOld)) {
                const escapedOld = this._escapeRegex(oldText).replace(/\s+/g, '\\s*');
                const exactRegex = new RegExp(escapedOld);
                if (exactRegex.test(nextText)) {
                    const stripNorm = (s) => String(s || '').replace(/[\s　]+/g, '');
                    const normOldStripped = stripNorm(oldText);
                    const normNewStripped = stripNorm(newText);
                    if (normOldStripped === normNewStripped) {
                        return nextText;
                    }
                    if (normNewStripped.startsWith(normOldStripped) && normNewStripped.length > normOldStripped.length) {
                        const oldIdx = nextText.search(exactRegex);
                        if (oldIdx >= 0) {
                            const matchedOld = exactRegex.exec(nextText)?.[0] || oldText;
                            const afterOldStart = oldIdx + matchedOld.length;
                            const extension = newText.slice(matchedOld.length);
                            const extStripped = stripNorm(extension);
                            const afterOld = nextText.slice(afterOldStart);
                            const afterStripped = stripNorm(afterOld);
                            let overlapStripped = 0;
                            for (let i = Math.min(extStripped.length, afterStripped.length); i > 0; i--) {
                                if (afterStripped.slice(0, i) === extStripped.slice(0, i)) {
                                    overlapStripped = i;
                                    break;
                                }
                            }
                            if (overlapStripped > 0) {
                                let cnt = 0;
                                let cut = 0;
                                for (let k = 0; k < afterOld.length && cnt < overlapStripped; k++) {
                                    if (!/[\s　]/.test(afterOld[k])) cnt++;
                                    cut++;
                                }
                                nextText = nextText.slice(0, oldIdx) + newText + nextText.slice(afterOldStart + cut);
                                applied = true;
                            }
                        }
                    }
                    if (!applied) {
                        nextText = nextText.replace(exactRegex, newText);
                        applied = true;
                    }
                }
                if (!applied) {
                    const normalizedReplace = this._replaceTextByNormalizedSlice(nextText, oldText, newText);
                    if (normalizedReplace !== null) {
                        nextText = normalizedReplace;
                        applied = true;
                    }
                }
            }

            // 3. それでも失敗した場合、グローバル置換（柔軟スペースマッチ）を試みる
            if (!applied) {
                const flexiblePattern = oldText
                    .split(/\s+/)
                    .filter(Boolean)
                    .map(part => this._escapeRegex(part))
                    .join('\\s+');
                if (flexiblePattern) {
                    const flexibleRegex = new RegExp(flexiblePattern);
                    if (flexibleRegex.test(nextText)) {
                        nextText = nextText.replace(flexibleRegex, newText);
                        applied = true;
                    }
                }
                if (!applied) {
                    const normalizedReplace = this._replaceTextByNormalizedSlice(nextText, oldText, newText);
                    if (normalizedReplace !== null) {
                        nextText = normalizedReplace;
                        applied = true;
                    }
                }
            }
        }

        // 4. 置換が適用された場合は、そのまま変更後のテキストを返す
        if (applied) {
            return nextText;
        }

        // 5. 【フォールバック】置換が一切適用されず、かつ newText が本文に含まれていない場合は、
        // 変更箇所が無視されるのを防ぐために、アンカー挿入または最善の場所へ挿入 (best-effort) を試みる
        if (!nextText.includes(newText)) {
            if (this._isAdditionChange(change)) {
                change.__diffsenseApplyIndex = index;
                const inserted = this._insertAdditionalClauseIntoArticle(nextText, change, newText);
                delete change.__diffsenseApplyIndex;
                if (inserted !== nextText) return inserted;
            }
            for (const anchor of this._getChangeAnchorTexts(change)) {
                const anchorRegex = new RegExp("(^|\\n)([^\\n]*" + this._escapeRegex(anchor) + "[^\\n]*)(?=\\n|$)");
                if (anchorRegex.test(nextText)) {
                    return nextText.replace(anchorRegex, (match, prefix, line) => {
                        return prefix + line + "\n\n" + newText;
                    });
                }
            }
            for (const anchor of this._getChangeAnchorTexts(change)) {
                const articlePattern = this._getArticleAnchorPattern(anchor);
                if (!articlePattern) continue;
                const articleRegex = new RegExp("(^|\\n)([^\\n]*" + articlePattern + "[^\\n]*)(?=\n|$)");
                if (articleRegex.test(nextText)) {
                    return nextText.replace(articleRegex, (match, prefix, line) => {
                        return prefix + line + "\n\n" + newText;
                    });
                }
            }
            return this._insertBestEffortIntoDocument(nextText, change, newText, index);
        }
        return nextText;
    },

    // ─── Document style auto-detection ──────────────────────────────────────
    // Analyzes the document text and returns formatting rules so that
    // inserted clauses match the surrounding style regardless of which
    // document is imported.
    _detectDocumentStyle(text, articleContext) {
        const src = String(text || '');
        const lines = src.split('\n');
        const nonEmpty = lines.filter(l => l.trim());

        // ── 1. Ideographic indent detection ───────────────────────────────────
        // U+3000 is \s in JS, so we use 　 literal matching.
        // Count leading 　 chars per line to find the dominant indent length.
        const countLeadingIdeographic = (l) => {
            let n = 0;
            for (let i = 0; i < l.length; i++) {
                if (l.charCodeAt(i) === 0x3000) n++; else break;
            }
            return n;
        };

        // Prefer to analyse the article context (nearest neighbours) if supplied
        const contextLines = articleContext
            ? String(articleContext).split('\n').filter(l => l.trim())
            : nonEmpty;

        const indentCounts = contextLines
            .map(countLeadingIdeographic)
            .filter(n => n > 0);

        const usesIdeographicIndent = indentCounts.length >= 1;

        // Dominant indent = most-common non-zero length (fallback: 1)
        let indentStr = '　'; // default single full-width space
        if (indentCounts.length > 0) {
            const freq = {};
            indentCounts.forEach(n => { freq[n] = (freq[n] || 0) + 1; });
            const dominant = Number(Object.entries(freq).sort((a,b) => b[1]-a[1])[0][0]);
            indentStr = '　'.repeat(dominant);
        }

        // ── 2. Numbered sub-paragraphs ────────────────────────────────────────
        const isNumberedParagraphLine = (line) =>
            /^[0-9０-９]{1,2}[　\s]/.test(line) ||
            /^（[一二三四五六七八九十\d０-９]+）/.test(line) ||
            /^[0-9０-９]{1,2}[.．]\s/.test(line);
        const numberedCount = nonEmpty.filter(isNumberedParagraphLine).length;
        const contextNumberedCount = contextLines.filter(isNumberedParagraphLine).length;
        const usesNumberedParagraphs = contextNumberedCount >= 1 || numberedCount >= 2;

        // ── 3. Blank-line separation ──────────────────────────────────────────
        let articleCount = 0, blankAfterArticle = 0;
        for (let i = 0; i < lines.length; i++) {
            if (/^第\s*[一二三四五六七八九十百千万零〇\d０-９]+\s*条/.test(lines[i].trim())) {
                articleCount++;
                let j = i + 1;
                while (j < lines.length && lines[j].trim()) j++;
                if (j < lines.length && !lines[j].trim()) blankAfterArticle++;
            }
        }
        const usesBlankLineSeparation = articleCount === 0
            || blankAfterArticle / Math.max(articleCount, 1) >= 0.4;

        // ── 4. Next paragraph number ──────────────────────────────────────────
        let nextParagraphNumber = null;
        if (usesNumberedParagraphs) {
            const extractNums = (sourceLines) => sourceLines
                .map(l => {
                    const m = l.match(/^([0-9０-９]{1,2})[　\s]/);
                    if (!m) return null;
                    const normalized = m[1].replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
                    const value = Number(normalized);
                    return Number.isFinite(value) ? value : null;
                })
                .filter(n => n !== null);
            const contextNums = extractNums(contextLines);
            const nums = contextNums.length ? contextNums : extractNums(nonEmpty);
            if (nums.length) nextParagraphNumber = Math.max(...nums) + 1;
        }

        return { usesIdeographicIndent, indentStr, usesNumberedParagraphs, usesBlankLineSeparation, nextParagraphNumber };
    },

    // Apply document style rules to text being inserted
    _formatInsertionText(addition, style) {
        let lines = String(addition || '').split('\n');
        const indent = style.indentStr || '　';
        const alreadyNumbered = value => /^[0-9０-９]{1,2}[　\s]/.test(String(value || '').trimStart());

        if (style.usesNumberedParagraphs && style.nextParagraphNumber && style.nextParagraphNumber <= 9) {
            const num = String.fromCharCode(0xFF10 + style.nextParagraphNumber); // ２,３…
            lines = lines.map((l, i) => {
                if (i === 0 && l.trim()) return alreadyNumbered(l) ? l.trimStart() : `${num}　${l.trimStart()}`;
                if (i > 0 && l.trim()) return `${indent}${l.trimStart()}`;
                return l;
            });
        } else if (style.usesIdeographicIndent) {
            lines = lines.map(l => l.trim() ? `${indent}${l.trimStart()}` : l);
        }

        return lines.join('\n');
    },

    _extractLegalKeywordTokens(source) {
        const stopWords = new Set(['修正', '追加', '条項', '条文', '提案', 'リスク', 'ため', 'もの', 'する', 'こと', 'できる', '場合', '本契約', '当事者', '甲', '乙']);
        return Array.from(new Set(String(source || '')
            .replace(/[。、，,.]/g, ' ')
            .split(/\s+/)
            .flatMap(part => String(part || '').match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ーA-Za-z0-9]{2,}/gu) || [])
            .map(token => token.trim())
            .filter(token => token.length >= 2 && !stopWords.has(token))));
    },

    _scoreInsertionSegment(segmentText, change) {
        const haystack = String(segmentText || '').replace(/\s+/g, '');
        if (!haystack) return 0;
        const oldText = this._getChangeOldText(change).replace(/\s+/g, '');
        if (oldText && haystack.includes(oldText)) return 1000 + oldText.length;
        const source = [
            this._getChangeNewText(change),
            change?.section || '',
            change?.article || '',
            change?.title || '',
            change?.reason || '',
            change?.concern || '',
            change?.impact || ''
        ].join(' ');
        let score = 0;
        this._extractLegalKeywordTokens(source).forEach(token => {
            const normalized = token.replace(/\s+/g, '');
            if (normalized && haystack.includes(normalized)) score += Math.min(24, normalized.length * 3);
        });
        return score;
    },

    _getArticleBlocksFromText(text) {
        // [F-A] 条項境界を「第N条」だけでなく「行全体が短い括弧見出し（…）」も認識する。
        // 店舗賃貸借契約書のように、第N条が付かず括弧見出しだけの条項（（明渡し）等）を
        // 独立ブロックとして切り出し、表示ラベルと反映位置を一致させるための土台。
        const source = String(text || '');
        if (!source) return [];
        const articleTokenRe = /第\s*[0-9０-９零〇一二三四五六七八九十百千]+\s*条/;
        const bracketHeadRe = /^[（(【][^）)】。]{1,20}[）)】]$/;
        const lines = source.split('\n');
        const offsets = [];
        {
            let off = 0;
            for (let i = 0; i < lines.length; i += 1) { offsets.push(off); off += lines[i].length + 1; }
        }
        const isHeadingLine = (line) => {
            const t = String(line || '').trim();
            if (!t) return false;
            return articleTokenRe.test(t) || bracketHeadRe.test(t);
        };
        const headingLineIdx = [];
        for (let i = 0; i < lines.length; i += 1) {
            if (isHeadingLine(lines[i])) headingLineIdx.push(i);
        }
        if (!headingLineIdx.length) return [];
        // 隣接する見出し行（本文を挟まない 括弧見出し → 第N条 等）は1ブロックに統合する。
        const groups = [];
        for (const li of headingLineIdx) {
            const prev = groups[groups.length - 1];
            if (prev && li === prev.lastLine + 1) {
                prev.lines.push(li);
                prev.lastLine = li;
            } else {
                groups.push({ firstLine: li, lastLine: li, lines: [li] });
            }
        }
        const articleToken = (line) => {
            const m = String(line || '').match(articleTokenRe);
            return m ? m[0].replace(/\s+/g, '') : '';
        };
        return groups.map((group, gi) => {
            const pieces = group.lines.map(li => lines[li].trim());
            const numToken = pieces.map(articleToken).find(Boolean) || '';
            const bracketTitle = pieces.find(p => bracketHeadRe.test(p)) || '';
            const articleLine = pieces.find(p => articleTokenRe.test(p)) || '';
            let heading;
            if (numToken && bracketTitle) heading = `${numToken}${bracketTitle}`; // 例: 第５条（使用目的）
            else if (articleLine) heading = articleLine;                          // 例: 第１条（定義） / 第N条＋本文
            else heading = bracketTitle || pieces[0];                             // 例: （明渡し）
            const start = offsets[group.firstLine];
            const nextGroup = groups[gi + 1];
            const end = nextGroup ? offsets[nextGroup.firstLine] : source.length;
            return {
                heading: heading.trim(),
                start,
                end,
                text: source.slice(start, end)
            };
        });
    },

    _findBestTextArticleForChange(text, change) {
        const blocks = this._getArticleBlocksFromText(text);
        let best = null;
        blocks.forEach(block => {
            const score = this._scoreInsertionSegment(block.text, change) + this._scoreInsertionSegment(block.heading, change);
            if (!best || score > best.score) best = { ...block, score };
        });
        return best && best.score >= 12 ? best : null;
    },

    _resolveAdditionTargetArticle(text, change, index = 0) {
        const source = String(text || '');
        const blocks = this._getArticleBlocksFromText(source);
        const explicit = this._findExplicitArticleForChange(change);
        const explicitPattern = explicit ? this._getArticleAnchorPattern(explicit) : '';
        if (explicitPattern) {
            const explicitBlock = blocks.find(block => new RegExp(explicitPattern).test(block.heading));
            if (explicitBlock) return { ...explicitBlock, source: 'explicit' };
            return null;
        }

        if (this._isAdditionChange(change) && blocks.length) {
            return { ...blocks[blocks.length - 1], source: 'tail' };
        }

        const bestArticle = this._findBestTextArticleForChange(source, change);
        if (bestArticle) return { ...bestArticle, source: 'score' };

        if (blocks.length) {
            const safeIndex = Math.min(Math.max(0, Number(index) || 0), blocks.length - 1);
            return { ...blocks[safeIndex], source: 'order' };
        }
        return null;
    },

    _getBestEffortInsertionPoint(text, change, index = 0) {
        const source = String(text || '');
        if (!source) return 0;
        const explicit = this._findExplicitArticleForChange(change);
        if (explicit) {
            const explicitPattern = this._getArticleAnchorPattern(explicit);
            const blocks = this._getArticleBlocksFromText(source);
            const explicitBlock = explicitPattern
                ? blocks.find(block => new RegExp(explicitPattern).test(block.heading))
                : null;
            if (explicitBlock) return explicitBlock.end;
            if (blocks.length) return blocks[blocks.length - 1].end;
        }
        // 特記事項等、もしくは bestArticle が見つからない場合 → 最後の article block の末尾、
        // または文書全体の末尾に挿入
        const blocks = this._getArticleBlocksFromText(source);
        if (blocks.length) return blocks[blocks.length - 1].end;
        const lines = source.split('\n');
        let offset = 0;
        for (let i = 0; i < lines.length; i += 1) {
            offset += lines[i].length + 1;
            if (lines[i].trim() && i >= 1) return Math.min(offset, source.length);
        }
        return source.length;
    },

    // 後文(結語「以上の通り…」)・署名押印欄の開始オフセットを返す（無ければ -1）。
    // どんな資料でも「追加条項は後文/署名欄より前」に必ず入るようにするためのガード。
    // ・結語(以上/本書N通作成/記名押印/各自N通所持)は本文で誤検出しにくい強パターンで最優先検出。
    // ・結語が無い文書は、末尾から連続する署名/日付/住所行の塊の先頭を境界とする。
    // 該当が無ければ -1 を返し、呼び出し側は従来どおり（NO-OP）。
    _findClosingRegionStart(text) {
        const source = String(text || '');
        if (!source) return -1;
        const lines = source.split('\n');
        const offsetOf = (idx) => {
            let o = 0;
            for (let i = 0; i < idx; i += 1) o += lines[i].length + 1;
            return o;
        };
        const isEpilogue = (v) =>
            /^以上/.test(v) ||
            /(本書|本契約書|本契約).{0,16}[0-9０-９一二三四五六七八九十]+\s*通/.test(v) ||
            /(記名|署名)\s*(押印|捺印)/.test(v) ||
            /(各自|各)\s*[0-9０-９一二三四五六七八九十]+\s*通.{0,16}(所持|保有|有する)/.test(v);
        for (let i = 0; i < lines.length; i += 1) {
            if (isEpilogue(lines[i].trim())) return offsetOf(i);
        }
        const isSignatureish = (v) => {
            if (!v) return false;
            if (/(令和|平成|昭和|西暦)[\s　○◯0-9０-９元]*年[\s　○◯0-9０-９]*月[\s　○◯0-9０-９]*日/.test(v) && v.length <= 24) return true;
            if (/^[0-9０-９○◯]{1,4}\s*年[\s　]*[0-9０-９○◯]{1,2}\s*月[\s　]*[0-9０-９○◯]{1,2}\s*日/.test(v)) return true;
            if (/^[（(]?\s*(貸主|借主|賃貸人|賃借人|売主|買主|譲渡人|譲受人|委託者|受託者|発注者|受注者|甲|乙|丙|連帯保証人|保証人|立会人|当事者)\s*[)）]?/.test(v) && v.length <= 40) return true;
            if (/^[\s　]*[㊞印]\s*$/.test(v)) return true;
            if (/(住所|氏名|名称|商号|会社名|所在地)[\s　:：]/.test(v) && v.length <= 40) return true;
            if (/[都道府県市区郡町村].{0,20}(丁目|番地|[0-9０-９○◯]+\s*[番号])/.test(v) && v.length <= 50) return true;
            return false;
        };
        let firstSig = -1;
        for (let i = lines.length - 1; i >= 0; i -= 1) {
            const v = lines[i].trim();
            if (!v) continue;
            if (isSignatureish(v)) firstSig = i;
            else break;
        }
        return firstSig >= 0 ? offsetOf(firstSig) : -1;
    },

    // 追加条項の挿入位置が後文/署名欄に達している場合だけ、その直前へ引き戻す。
    // 後文/署名欄が無い、または挿入位置が既にそれより前なら point をそのまま返す（NO-OP）。
    _clampInsertionPointBeforeClosing(text, point) {
        const p = Number(point);
        if (!Number.isFinite(p)) return point;
        const closingStart = this._findClosingRegionStart(text);
        return (closingStart >= 0 && closingStart < p) ? closingStart : p;
    },

    _insertBestEffortIntoDocument(text, change, insertionText, index = 0) {
        const source = String(text || '');
        const addition = String(insertionText || '').trim();
        if (!addition || this._textContainsCandidate(source, addition)) return source;
        const targetSource = this._getOriginalDocumentText() || source;
        const article = this._resolveAdditionTargetArticle(targetSource, change, index);
        const context = article ? article.text : source.slice(0, 800);
        const formatted = this._formatInsertionText(addition, this._detectDocumentStyle(source, context));
        const point = this._clampInsertionPointBeforeClosing(source, this._getBestEffortInsertionPoint(source, change, index));
        const before = source.slice(0, point).trimEnd();
        const after = source.slice(point).trimStart();
        return [before, formatted, after].filter(Boolean).join('\n\n');
    },

    // 条項番号 (1)(2)(3) や １ ２ ３ を解析し、番号順を尊重した挿入位置を返す
    // Phase 1: AC-1（反映精度）の中核
    _parseClauseNumber(line) {
        if (!line) return null;
        const s = String(line).trim();
        // パターン: （１）（2）(1) (２) 等
        let m = s.match(/^[（(]\s*([0-9０-９一二三四五六七八九十]+)\s*[)）]/);
        if (m) return this._normalizeClauseDigit(m[1]);
        // パターン: １ ２ 3. 行頭の数字 + スペース
        m = s.match(/^([0-9０-９]+)[\.\．、　 ]/);
        if (m) return this._normalizeClauseDigit(m[1]);
        // パターン: 一、 二、 三、 (漢数字 + 読点)
        m = s.match(/^([一二三四五六七八九十]+)[、，]/);
        if (m) return this._normalizeClauseDigit(m[1]);
        return null;
    },

    _normalizeClauseDigit(raw) {
        if (raw == null) return null;
        let s = String(raw);
        // 全角→半角
        s = s.replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
        // 漢数字→数値（一〜十まで）
        const kanji = { '一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10 };
        if (kanji[s] !== undefined) return kanji[s];
        const n = Number(s);
        return Number.isFinite(n) ? n : null;
    },

    _findNumberedClauseInsertionPoint(articleText, articleStart, additionText) {
        if (!articleText || !additionText) return null;
        const additionNumber = this._parseClauseNumber(String(additionText).split('\n')[0] || '');
        if (additionNumber == null) return null;
        // 条文内の既存番号付き行を収集
        const lines = String(articleText).split('\n');
        const numbered = [];
        let cursor = 0;
        lines.forEach(line => {
            const num = this._parseClauseNumber(line);
            if (num != null) {
                numbered.push({ num, start: cursor, end: cursor + line.length, line });
            }
            cursor += line.length + 1; // +1 for the \n
        });
        if (!numbered.length) return null;
        // 1) 新規番号 < 最初の既存番号 → 最初の番号付き行の直前に挿入
        if (additionNumber < numbered[0].num) {
            return articleStart + numbered[0].start;
        }
        // 2) 新規番号 > 最後の既存番号 → 最後の番号付き行の直後に挿入
        const last = numbered[numbered.length - 1];
        if (additionNumber > last.num) {
            return articleStart + last.end;
        }
        // 3) 中間: 新規より大きい最初の番号の直前に挿入
        for (const item of numbered) {
            if (additionNumber < item.num) {
                return articleStart + item.start;
            }
            // 既に同じ番号が存在 → 上書きせず直後に挿入
            if (additionNumber === item.num) {
                return articleStart + item.end;
            }
        }
        return null;
    },

    _findInsertionPointInArticleText(fullText, articleText, articleStart, change) {
        const source = String(fullText || '');
        const blockText = String(articleText || '');
        if (!source || !blockText) return null;
        const scoreCandidate = (text, start, end, currentBest) => {
            const score = this._scoreInsertionSegment(text, change);
            if (!currentBest || score > currentBest.score) return { score, start, end };
            return currentBest;
        };
        const lineRegex = /[^\n]*(?:\n|$)/g;
        let match;
        let best = null;
        while ((match = lineRegex.exec(blockText)) !== null) {
            const rawLine = match[0];
            if (!rawLine) break;
            const line = rawLine.replace(/\n$/, '');
            if (!line.trim()) continue;
            if (/^第\s*[0-9０-９零〇一二三四五六七八九十百千]+\s*条/.test(line.trim())) continue;
            const sentenceRegex = /[^。．.!?\n]+[。．.!?]?/g;
            let sentenceMatch;
            let scoredSentence = false;
            while ((sentenceMatch = sentenceRegex.exec(line)) !== null) {
                const sentence = sentenceMatch[0];
                if (!sentence.trim()) continue;
                scoredSentence = true;
                const start = articleStart + match.index + sentenceMatch.index;
                const end = start + sentence.length;
                best = scoreCandidate(sentence, start, end, best);
            }
            if (!scoredSentence) best = scoreCandidate(line, articleStart + match.index, articleStart + match.index + rawLine.length, best);
        }
        return best && best.score >= 12 ? Math.min(best.end, source.length) : null;
    },

    _insertAdditionalClauseIntoArticle(text, change, additionText, index = 0) {
        index = Number(change?.__diffsenseApplyIndex ?? index) || 0;
        let nextText = String(text || '');
        const addition = String(additionText || '').trim();
        if (!addition) return nextText;

        const explicitArticle = this._findExplicitArticleForChange(change);
        const hasArticleAnchor = Boolean(explicitArticle);
        const targetSource = this._getOriginalDocumentText() || nextText;
        const targetArticle = this._resolveAdditionTargetArticle(targetSource, change, index);
        let resolvedArticle = targetArticle;
        const targetLabel = String(targetArticle?.heading || '').trim();
        const targetPattern = targetLabel ? this._getArticleAnchorPattern(targetLabel) : '';
        if (targetPattern) {
            const textBlock = this._getArticleBlocksFromText(nextText)
                .find(block => new RegExp(targetPattern).test(block.heading));
            resolvedArticle = textBlock ? { ...textBlock, source: targetArticle?.source || 'target' } : null;
        }
        if (targetPattern && this._textContainsCandidate(nextText, addition)) {
            const targetRegex = new RegExp("(^|\\n)([^\\n]*" + targetPattern + "[^\\n]*(?:\\n(?!\\s*第\\s*[0-9０-９零〇一二三四五六七八九十百千]+\\s*条)[^\\n]*)*)");
            const targetMatch = targetRegex.exec(nextText);
            if (this._textContainsCandidate(targetMatch?.[2] || '', addition)) return nextText;
            nextText = this._removeCandidateText(nextText, addition);
            if (resolvedArticle) {
                const refreshedBlock = this._getArticleBlocksFromText(nextText)
                    .find(block => new RegExp(targetPattern).test(block.heading));
                resolvedArticle = refreshedBlock ? { ...refreshedBlock, source: resolvedArticle.source || 'target' } : null;
            }
        } else if (this._textContainsCandidate(nextText, addition)) {
            return nextText;
        }
        if (!hasArticleAnchor && (!resolvedArticle || resolvedArticle.source === 'order')) {
            const style = this._detectDocumentStyle(nextText, nextText.slice(-800));
            const formattedAddition = this._formatInsertionText(addition, style);
            return this._insertBestEffortIntoDocument(nextText, change, formattedAddition, index);
        }

        const articleLabel = String(resolvedArticle?.heading || '').trim();
        const articlePattern = articleLabel ? this._getArticleAnchorPattern(articleLabel) : '';
        let textArticle = resolvedArticle;
        let articleContext = '';
        if (articlePattern) {
            const ctxRegex = new RegExp("(^|\\n)([^\\n]*" + articlePattern + "[^\\n]*(?:\\n(?!\\s*第\\s*[0-9０-９零〇一二三四五六七八九十百千]+\\s*条)[^\\n]*)*)");
            const ctxMatch = ctxRegex.exec(nextText);
            if (ctxMatch) articleContext = ctxMatch[2];
        } else if (textArticle) {
            articleContext = textArticle.text;
        }

        const style = this._detectDocumentStyle(nextText, articleContext || nextText.slice(0, 800));
        const formattedAddition = this._formatInsertionText(addition, style);
        if (articlePattern) {
            const articleRegex = new RegExp("(^|\\n)([^\\n]*" + articlePattern + "[^\\n]*(?:\\n(?!\\s*第\\s*[0-9０-９零〇一二三四五六七八九十百千]+\\s*条)[^\\n]*)*)");
            const match = articleRegex.exec(nextText);
            if (match) {
                const articleTextLocal = match[2];
                const articleStartLocal = match.index + match[1].length;
                const numberedPoint = this._findNumberedClauseInsertionPoint(articleTextLocal, articleStartLocal, formattedAddition);
                const scoredPoint = !this._isAdditionChange(change) && numberedPoint == null
                    ? this._findInsertionPointInArticleText(nextText, articleTextLocal, articleStartLocal, change)
                    : null;
                const rawPoint = numberedPoint != null ? numberedPoint : (scoredPoint || (match.index + match[0].length));
                const point = this._clampInsertionPointBeforeClosing(nextText, rawPoint);
                const before = nextText.slice(0, point).trimEnd();
                const after = nextText.slice(point).trimStart();
                return [before, formattedAddition, after].filter(Boolean).join('\n\n');
            }
        }
        if (textArticle) {
            const numberedPoint = this._findNumberedClauseInsertionPoint(textArticle.text, textArticle.start, formattedAddition);
            const scoredPoint = !this._isAdditionChange(change) && numberedPoint == null
                ? this._findInsertionPointInArticleText(nextText, textArticle.text, textArticle.start, change)
                : null;
            const rawPoint = numberedPoint != null ? numberedPoint : (scoredPoint || textArticle.end);
            const point = this._clampInsertionPointBeforeClosing(nextText, rawPoint);
            const before = nextText.slice(0, point).trimEnd();
            const after = nextText.slice(point).trimStart();
            return [before, formattedAddition, after].filter(Boolean).join('\n\n');
        }

        // 最終フォールバック: 商用品質基準により、末尾追加には警告ログを出す
        console.warn('[DIFFsense] 挿入位置を特定できず末尾追加にフォールバック', {
            section: change?.section || change?.target || 'unknown',
            type: change?.type || 'unknown',
            additionPreview: String(formattedAddition || '').slice(0, 60)
        });
        return this._insertBestEffortIntoDocument(nextText, change, formattedAddition, index);
    },

    _collectEditorContent() {
        const richBodies = Array.from(document.querySelectorAll('#v3-editor-scroll .v3-rich-editor-body'));
        if (richBodies.length > 0) {
            // DEDUPLICATION: Join unique page contents to prevent 'Full Text x Page Count' bug
            const pageTexts = richBodies.map(body => {
                const hasSourceStructure = Boolean(body.querySelector(':scope > table, :scope > ul, :scope > ol, :scope > section'));
                const blockTexts = hasSourceStructure ? [] : Array.from(body.querySelectorAll(':scope > .v3-editor-block'))
                    .map(block => block.innerText || block.textContent || '');
                const bodyText = blockTexts.length ? blockTexts.join('\n') : (body.innerText || body.textContent || '');
                return bodyText
                    .replace(/\u00a0/g, ' ')
                    .replace(/\r\n/g, '\n')
                    .replace(/\n{3,}/g, '\n\n')
                    .trimEnd();
            });
            
            // Critical: Ensure we don't duplicate the same text if it somehow leaked into multiple pages
            let fullText = pageTexts[0] || '';
            for (let i = 1; i < pageTexts.length; i++) {
                const pText = pageTexts[i];
                if (!pText) continue;
                // If this page's text is already substantially present in the fullText, it might be a duplication
                if (fullText.includes(pText.substring(0, 100)) && pText.length > 100) {
                    console.warn('[DEDUPLICATION] Skipping duplicate page content in collection.', i);
                    continue;
                }
                fullText += '\n' + pText;
            }
            return fullText.replace(/\n{4,}/g, '\n\n\n').trim();
        }
        const blocks = Array.from(document.querySelectorAll('#v3-editor-scroll .v3-editor-block'));
        if (blocks.length > 0) return blocks.map(block => block.innerText).join('\n');
        return this._getFinalDocumentText();
    },

    _collectEditorHtml() {
        const richBodies = Array.from(document.querySelectorAll('#v3-editor-scroll .v3-rich-editor-body'));
        return richBodies.length
            ? this._sanitizeFinalContentHtml(richBodies.map(body => body.innerHTML).join('<p><br></p>'))
            : '';
    },

    _getFinalFreeTextNotes() {
        const notes = this._contract?.final_free_text_notes || this._editedFreeTextNotes || [];
        return Array.isArray(notes) ? notes : [];
    },

    _renderFreeTextNotesForPage(page) {
        return this._getFinalFreeTextNotes()
            .filter(note => Number(note.page) === Number(page))
            .map(note => {
                const left = Math.max(0, Math.min(100, Number(note.left) || 0));
                const top = Math.max(0, Math.min(100, Number(note.top) || 0));
                const text = this.escapeHtml(note.text || '');
                return `<div class="v3-free-text-note" contenteditable="true" spellcheck="true" data-note-id="${this.escapeHtml(note.id || '')}" style="left:${left}%;top:${top}%;" oninput="window.signViewer._onFreeTextNoteInput(this)" onkeydown="window.signViewer._onFreeTextNoteKeyDown(event, this)">${text}</div>`;
            })
            .join('');
    },

    _renderFreeTextLayerForPage(page) {
        return `<div class="v3-free-text-layer">${this._renderFreeTextNotesForPage(page)}</div>`;
    },

    _collectFinalFreeTextNotes() {
        return Array.from(document.querySelectorAll('#v3-editor-scroll .v3-free-text-note')).map(node => {
            const page = Number(node.closest('.final-contract-page')?.dataset.page || 1);
            return {
                id: node.dataset.noteId || `note-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                page,
                left: parseFloat(node.style.left) || 0,
                top: parseFloat(node.style.top) || 0,
                text: (node.innerText || node.textContent || '').trim()
            };
        }).filter(note => note.text);
    },

    _enableFreeTextMode() {
        this._freeTextMode = true;
        Notify.info('文字を追加したい位置をクリックしてください');
    },

    _handleFreeTextPageClick(event) {
        if (!this._freeTextMode) return;
        this._freeTextMode = false;
        this._createFreeTextNoteAtEvent(event);
    },

    _handleFreeTextPageDblClick(event) {
        this._createFreeTextNoteAtEvent(event);
    },

    _createFreeTextNoteAtEvent(event) {
        const page = event.target.closest?.('.final-contract-page');
        if (!page || event.target.closest?.('.v3-free-text-note, button, input, select, textarea')) return;
        if (event.target.closest?.('.v3-editor-block') && event.target.textContent.trim()) return;
        let layer = page.querySelector('.v3-free-text-layer');
        if (!layer) {
            layer = document.createElement('div');
            layer.className = 'v3-free-text-layer';
            page.appendChild(layer);
        }
        const rect = layer.getBoundingClientRect();
        const insideLayer = event.clientX >= rect.left
            && event.clientX <= rect.right
            && event.clientY >= rect.top
            && event.clientY <= rect.bottom;
        if (!insideLayer) return;
        const left = Math.max(0, Math.min(96, ((event.clientX - rect.left) / rect.width) * 100));
        const top = Math.max(0, Math.min(96, ((event.clientY - rect.top) / rect.height) * 100));
        const note = document.createElement('div');
        note.className = 'v3-free-text-note';
        note.contentEditable = 'true';
        note.spellcheck = true;
        note.dataset.noteId = `note-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        note.style.left = `${left}%`;
        note.style.top = `${top}%`;
        note.setAttribute('oninput', 'window.signViewer._onFreeTextNoteInput(this)');
        note.setAttribute('onkeydown', 'window.signViewer._onFreeTextNoteKeyDown(event, this)');
        note.textContent = '';
        layer.appendChild(note);
        event.preventDefault();
        event.stopPropagation();
        note.focus();
        this._markEditorUnsaved();
    },

    _onFreeTextNoteInput() {
        this._editedFreeTextNotes = this._collectFinalFreeTextNotes();
        this._markEditorUnsaved();
    },

    _onFreeTextNoteKeyDown(event, node) {
        if (event.key === 'Escape') {
            node.blur();
            event.preventDefault();
        }
        if ((event.key === 'Backspace' || event.key === 'Delete') && !String(node.innerText || '').trim()) {
            node.remove();
            this._editedFreeTextNotes = this._collectFinalFreeTextNotes();
            this._markEditorUnsaved();
            event.preventDefault();
        }
    },

    _getFinalDocumentHtml() {
        if (this._editedHtml !== undefined) return String(this._editedHtml || '');
        return this._sanitizeFinalContentHtml(this._contract?.final_content_html || '');
    },

    _sanitizeFinalContentHtml(html) {
        const value = String(html || '');
        if (!value.trim()) return '';
        const template = document.createElement('template');
        template.innerHTML = value;
        template.content.querySelectorAll('script,style,iframe,object,embed,link,meta').forEach(el => el.remove());
        template.content.querySelectorAll('*').forEach(el => {
            [...el.attributes].forEach(attr => {
                const name = attr.name.toLowerCase();
                const val = String(attr.value || '');
                if (name.startsWith('on') || val.trim().toLowerCase().startsWith('javascript:')) el.removeAttribute(attr.name);
            });
        });
        // UI-only highlights should never be saved to the database
        template.content.querySelectorAll('.v3-applied-change, .v3-applied-change-pulse').forEach(el => {
            el.replaceWith(document.createTextNode(el.textContent));
        });
        this._normalizeFinalEditorFragment(template.content);
        return template.innerHTML;
    },

    _normalizeFinalEditorFragment(root) {
        if (!root) return;
        root.querySelectorAll('font, center').forEach(el => {
            const span = document.createElement('span');
            span.innerHTML = el.innerHTML;
            el.replaceWith(span);
        });
        root.querySelectorAll('.v3-rich-editor-body div:not(.v3-free-text-note)').forEach(div => {
            const structural = div.classList.contains('v3-rich-editor-body')
                || div.classList.contains('v3-editor-page')
                || div.classList.contains('final-contract-page');
            if (structural || div.querySelector('table,ul,ol,section')) return;
            const p = document.createElement('p');
            p.className = div.className || 'v3-editor-block type-body';
            p.innerHTML = div.innerHTML || '<br>';
            div.replaceWith(p);
        });
        root.querySelectorAll('*').forEach(el => {
            [...el.attributes].forEach(attr => {
                const name = attr.name.toLowerCase();
                const keepData = name === 'data-empty-line' || name === 'data-editor-tag';
                if (name.startsWith('data-') && !keepData) el.removeAttribute(attr.name);
                if (name === 'contenteditable' || name === 'spellcheck') el.removeAttribute(attr.name);
                if (name === 'class') {
                    const classes = String(attr.value || '').split(/\s+/).filter(cls =>
                        cls
                        && !/^Apple-/.test(cls)
                        && cls !== 'MsoNormal'
                        && cls !== 'MsoListParagraph'
                        && !/^v3-applied-change/.test(cls)
                    );
                    if (classes.length) el.setAttribute('class', classes.join(' '));
                    else el.removeAttribute('class');
                }
                if (name === 'style') {
                    const allowed = [
                        'font-size',
                        'font-weight',
                        'font-style',
                        'text-decoration',
                        'text-align',
                        'color',
                        'background-color',
                        'line-height'
                    ];
                    const next = allowed
                        .map(prop => this._getSafeFinalEditorStyleDeclaration(el, prop))
                        .filter(Boolean)
                        .join(';');
                    if (next) el.setAttribute('style', next);
                    else el.removeAttribute('style');
                }
            });
        });
        root.querySelectorAll('span').forEach(span => {
            if (!span.textContent.trim() && !span.querySelector('br,img')) span.remove();
        });
        root.querySelectorAll('div').forEach(div => {
            const structural = div.classList.contains('v3-rich-editor-body')
                || div.classList.contains('v3-editor-page')
                || div.classList.contains('final-contract-page');
            if (!structural && !div.textContent.trim() && !div.querySelector('br,img,table,ul,ol')) div.remove();
        });
        root.querySelectorAll('br + br + br').forEach(br => br.remove());
        root.normalize?.();
    },

    _getSafeFinalEditorStyleDeclaration(el, prop) {
        if (!el?.style) return '';
        const value = String(el.style.getPropertyValue(prop) || '').trim();
        if (!value) return '';
        const lower = value.toLowerCase();
        if (lower.includes('url(') || lower.includes('expression(') || lower.includes('javascript:')) return '';
        if (prop === 'font-size') {
            if (!/^(?:[1-9]|[1-6][0-9]|72)(?:\.\d+)?(?:px|pt|em|rem|%)$/.test(lower)) return '';
        } else if (prop === 'font-weight') {
            if (!/^(?:normal|bold|bolder|lighter|[1-9]00|700)$/.test(lower)) return '';
        } else if (prop === 'font-style') {
            if (!/^(?:normal|italic|oblique)$/.test(lower)) return '';
        } else if (prop === 'text-align') {
            if (!/^(?:left|center|right|justify|start|end)$/.test(lower)) return '';
        } else if (prop === 'line-height') {
            if (!/^(?:normal|[0-9]+(?:\.[0-9]+)?(?:px|pt|em|rem|%)?)$/.test(lower)) return '';
        } else if (prop === 'text-decoration') {
            if (!/^(?:none|underline|line-through|overline)(?:\s+(?:underline|line-through|overline))*$/.test(lower)) return '';
        } else if (prop === 'color' || prop === 'background-color') {
            if (!/^(?:#[0-9a-f]{3,8}|rgb\([^)]+\)|rgba\([^)]+\)|[a-z]+)$/.test(lower)) return '';
        }
        return `${prop}:${value}`;
    },

    _normalizeFinalEditorDomBeforeSave() {
        if (this._isRichEditorComposing) return;
        const root = document.getElementById('v3-editor-scroll');
        if (!root) return;
        this._normalizeEditorFontTags();
        this._stabilizeFinalEditorBlockDom(root, { preserveSelection: false });
        root.querySelectorAll('.v3-rich-editor-body').forEach(body => {
            body.setAttribute('contenteditable', 'true');
        });
        root.querySelectorAll('.v3-editor-page, .final-contract-page, section, table, tbody, tr, ul, ol').forEach(node => {
            if (node.classList?.contains('docx-preview-mode')) return;
            if (node.hasAttribute('contenteditable')) node.removeAttribute('contenteditable');
        });
        root.querySelectorAll('.v3-rich-editor-body div:not(.v3-free-text-note)').forEach(div => {
            if (div.classList.contains('v3-rich-editor-body') || div.classList.contains('v3-editor-page') || div.classList.contains('final-contract-page')) return;
            if (div.querySelector('table,ul,ol,section')) return;
            const p = document.createElement('p');
            p.className = div.className || 'v3-editor-block type-body';
            p.setAttribute('spellcheck', 'true');
            p.innerHTML = div.innerHTML || '<br>';
            div.replaceWith(p);
        });
        root.querySelectorAll('.v3-rich-editor-body span').forEach(span => {
            if (!span.textContent.trim() && !span.querySelector('br,img')) span.remove();
        });
        root.querySelectorAll('.v3-rich-editor-body div').forEach(div => {
            if (!div.classList.contains('v3-free-text-note') && !div.textContent.trim() && !div.querySelector('br,img,table,ul,ol')) div.remove();
        });
        root.querySelectorAll('.v3-rich-editor-body br + br + br').forEach(br => br.remove());
        root.normalize();
    },

    _plainTextToEditorHtml(text, markApplied = false) {
        const finalText = String(text || '');
        const changes = this._getActiveSortedAiChanges();
        const applied = markApplied ? this._getAppliedChangeIndexesForText(finalText) : new Set();
        const snippets = [];
        if (markApplied && applied.size) {
            changes.forEach((change, index) => {
                if (!applied.has(index)) return;
                const appliedText = this._buildLegalInsertionText(change);
                String(appliedText || '').split('\n').map(v => v.trim()).filter(v => v.length > 1).forEach(v => snippets.push(v));
            });
        }
        const lines = finalText.split('\n');
        const firstNonEmptyIdx = lines.findIndex(l => l.trim().length > 0);
        const isArticleLine  = (s) => {
            const t = String(s || '').trim();
            return /^第\s*[一二三四五六七八九十百千万零〇\d０-９]+\s*[条章節]/.test(t);
        };
        const isSubHeaderLine = (s) => {
            const t = String(s || '').trim();
            return /^（[^）]{1,20}）$/.test(t)
                || /^【[^】]{1,20}】$/.test(t)
                || ['記','以上','附則','別紙'].includes(t);
        };
        return lines.map((line, index) => {
            let html = this.escapeHtml(line) || '<br>';
            snippets.forEach(snippet => {
                const escaped = this.escapeHtml(snippet);
                if (escaped && html.includes(escaped)) {
                    const justAppliedHead = this._justAppliedSnippet
                        ? this._justAppliedSnippet.trim().split('\n')[0].trim()
                        : '';
                    const isPulse = justAppliedHead && (snippet.includes(justAppliedHead) || justAppliedHead.includes(snippet));
                    const cls = isPulse ? 'v3-applied-change v3-applied-change-pulse' : 'v3-applied-change';
                    html = html.split(escaped).join(`<span class="${cls}">${escaped}</span>`);
                }
            });
            const trimmed = line.trim();
            let style = '';
            if (trimmed) {
                // Look at nearest non-empty neighbours for context
                const prevTrimmed = lines.slice(0, index).reverse().find(l => l.trim())?.trim() || '';
                const nextTrimmed = lines.slice(index + 1).find(l => l.trim())?.trim() || '';
                const isIndented = /^[\s　]+/.test(line); // leading space or ideographic space
                const isTitle = index === firstNonEmptyIdx && !isIndented && trimmed.length < 40
                    && !/^第|^（|^[０-９\d一二三四五六七八九十]/.test(trimmed);
                const isArticle = !isIndented && isArticleLine(trimmed);
                const isSubHeader = !isIndented && isSubHeaderLine(trimmed);
                if (isTitle) {
                    style = 'text-align:center;font-weight:700;font-size:1.08em;margin:8px 0 6px;letter-spacing:0.1em;';
                } else if (isArticle) {
                    // If immediately preceded by a sub-header (（XX）), keep tight — blank line already provides space
                    const mt = isSubHeaderLine(prevTrimmed) ? '2px' : '12px';
                    style = `font-weight:700;margin-top:${mt};margin-bottom:2px;`;
                } else if (isSubHeader) {
                    // If immediately followed by article heading, collapse bottom margin
                    const mb = isArticleLine(nextTrimmed) ? '2px' : '8px';
                    style = `font-weight:600;margin-top:12px;margin-bottom:${mb};line-height:1.5;`;
                }
            }
            return style ? `<div style="${style}">${html}</div>` : `<div>${html}</div>`;
        }).join('');
    },
    _calcPageLayout() {
        // Synchronized with CSS: padding 80px 60px, line-height 1.8
        const fontSize = this._getFinalEditorFontSize(); 
        const lineHeightPx = fontSize * 1.8;
        // Usable width = 794 - (60 * 2) = 674px
        // Usable height = 1123 - (80 * 2) = 963px
        const charsPerLine = Math.max(20, Math.floor(674 / (fontSize * 0.95))); // Japanese char density
        // Increased safety buffer to account for semantic block margins
        const linesPerPage = Math.max(10, Math.floor(963 / lineHeightPx) - 8); 
        return { charsPerLine, linesPerPage };
    },

    _shouldUseSourceDocxFinalEditor(text = this._getFinalDocumentText()) {
        if (!this._isOriginalDocxContract()) return false;
        const finalText = String(text || '');
        const originalText = this._getOriginalDocumentText();
        const normalize = value => this._normalizeFinalLayoutText(value).replace(/\s+/g, '');
        const hasAppliedChanges = this._getAppliedChangeIndexesForText(finalText).size > 0;
        if (hasAppliedChanges) return false;
        if (finalText.trim() && normalize(finalText) !== normalize(originalText)) return false;
        return true;
    },

    async _renderFinalEditorSurfaceHtml(text, targetPageCount = null) {
        // Boundary markers for legacy fallback editor: manualExtraPages / await this._paginateByDOMHeights(text, null)
        const faithfulReparse = this._faithfulFinalReparse === true;
        const isDocx = this._isOriginalDocxContract();
        const useSourceDocxEditor = this._shouldUseSourceDocxFinalEditor(text);
        const expectedPageCount = isDocx
            ? (this._getOriginalPageCount() || await this._ensureOriginalPageCount())
            : this._getOriginalPageCount();

        if (useSourceDocxEditor && (!this._docxEditorPageElements || faithfulReparse)) {
            this._docxEditorPageElements = null;
            const source = await getDocxSourceForEditor(this);
            if (source) {
                try {
                    console.log('[DOCX EDITOR] Starting docx-preview render...');
                    const pageElements = await renderDocxPreviewAsEditor(source, { expectedPageCount });
                    if (this._hasUsableDocxEditorPages(pageElements)) {
                        this._docxEditorPageElements = pageElements;
                    } else if (pageElements && pageElements.length > 0) {
                        console.warn('[DOCX EDITOR] Native DOCX pages look unsafe; using paginated text editor fallback', {
                            pageCount: pageElements.length,
                            heights: pageElements.map(page => page.scrollHeight || page.offsetHeight || Number(page.dataset?.baseHeight || 0))
                        });
                    }
                    if (faithfulReparse) this._faithfulFinalReparse = false;
                    console.log('[DOCX EDITOR] Render successful', { pageCount: pageElements?.length || 0 });
                } catch(e) {
                    console.warn('[DOCX EDITOR] render failed, falling back', e);
                }
            }
        }

        if (useSourceDocxEditor && Array.isArray(this._docxEditorPageElements) && this._docxEditorPageElements.length > 0) {
            const manualExtraPages = Math.max(0, Math.round(Number(this._manualFinalExtraPages || 0)));
            const basePageCount = this._docxEditorPageElements.length;
            this._totalPages = basePageCount + manualExtraPages;
            const basePages = this._docxEditorPageElements.map((_, pageIndex) => `
                <div class="v3-editor-page final-contract-page docx-editor-page ${pageIndex > 0 ? 'is-continuation-page' : ''}"
                     data-page="${pageIndex + 1}"
                     onclick="window.signViewer._handleFreeTextPageClick(event)"
                     ondblclick="window.signViewer._handleFreeTextPageDblClick(event)">
                    <div class="final-contract-page-body v3-rich-editor-body docx-preview-mode"
                         data-docx-page-mount="${pageIndex}"
                         contenteditable="true"
                         spellcheck="true"
                         oninput="window.signViewer._onRichEditorInput(this)"
                         onpaste="window.signViewer._onRichEditorPaste(event, this)"
                         onkeydown="window.signViewer._onRichEditorKeyDown(event, this)"
                         oncompositionstart="window.signViewer._onRichEditorCompositionStart(event)"
                         oncompositionend="window.signViewer._onRichEditorCompositionEnd(event)"
                         onfocusout="window.signViewer._onRichEditorBlur(this)"
                         onblur="window.signViewer._onRichEditorBlur(this)"></div>
                    ${this._renderFreeTextLayerForPage(pageIndex + 1)}
                </div>
            `);
            const extraPages = Array.from({ length: manualExtraPages }, (_, extraIndex) => {
                const pageIndex = basePageCount + extraIndex;
                return `
                    <div class="v3-editor-page final-contract-page is-manual-extra-page ${pageIndex > 0 ? 'is-continuation-page' : ''}"
                         data-page="${pageIndex + 1}"
                         onclick="window.signViewer._handleFreeTextPageClick(event)"
                         ondblclick="window.signViewer._handleFreeTextPageDblClick(event)">
                        <div class="final-contract-page-body v3-rich-editor-body"
                             contenteditable="true"
                             spellcheck="true"
                             oninput="window.signViewer._onRichEditorInput(this)"
                             onpaste="window.signViewer._onRichEditorPaste(event, this)"
                             onkeydown="window.signViewer._onRichEditorKeyDown(event, this)"
                             oncompositionstart="window.signViewer._onRichEditorCompositionStart(event)"
                             oncompositionend="window.signViewer._onRichEditorCompositionEnd(event)"
                             onfocusout="window.signViewer._onRichEditorBlur(this)"
                             onblur="window.signViewer._onRichEditorBlur(this)"><p class="v3-editor-block type-body is-empty" spellcheck="true" data-editor-tag="p"><br data-empty-line="true"></p></div>
                        ${this._renderFreeTextLayerForPage(pageIndex + 1)}
                    </div>
                `;
            });
            return basePages.concat(extraPages).join('');
        }

        // フォールバック: 従来のテキスト再組版
        return this._renderFinalEditorSurfaceHtmlLegacy(text, targetPageCount || expectedPageCount);
    },

    async _renderFinalEditorSurfaceHtmlLegacy(text, targetPageCount = null) {
        const originalRawText = this._normalizeFinalLayoutText(this._getOriginalDocumentText());
        const effectiveTargetPageCount = this._resolveFinalTargetPageCount(text, targetPageCount);
        const faithfulReparse = this._faithfulFinalReparse === true;
        const sourcePageTexts = faithfulReparse && Array.isArray(this._faithfulFinalPageTexts)
            ? this._faithfulFinalPageTexts
                .map(pageText => String(pageText || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd())
                .filter(pageText => pageText.trim())
            : [];
        const pages = sourcePageTexts.length
            ? sourcePageTexts.map(pageText => pageText.split('\n'))
            : await this._paginateByDOMHeights(text, effectiveTargetPageCount);
        const manualExtraPages = Math.max(0, Math.round(Number(this._manualFinalExtraPages || 0)));
        for (let i = 0; i < manualExtraPages; i += 1) pages.push([' ']);
        const renderedText = pages.map(p => p.join('\n')).join('\n');

        // [LOSSLESS CHECK]
        console.log('[LOSSLESS CHECK]', {
            originalLength: originalRawText.length,
            renderedLength: renderedText.length,
            same: originalRawText === renderedText
        });

        // [FINAL PAGE SOURCE] - Added for rendering stability diagnosis
        console.log('[FINAL PAGE SOURCE]', {
            sourcePageCount: effectiveTargetPageCount,
            renderedPageCount: pages.length,
            isCorrectionNeeded: (effectiveTargetPageCount || 0) > pages.length
        });

        // [CLAUSE CHECK]
        const originalClauses = originalRawText.match(/第\s*[0-9０-９零〇一二三四五六七八九十百千]+\s*条/g) || [];
        const renderedClauses = renderedText.match(/第\s*[0-9０-９零〇一二三四五六七八九十百千]+\s*条/g) || [];

        console.log('[CLAUSE CHECK]', {
            originalClauseCount: originalClauses.length,
            renderedClauseCount: renderedClauses.length,
            originalClauses: originalClauses.slice(0, 5),
            renderedClauses: renderedClauses.slice(0, 5)
        });

        // Editing view must stay usable even when lightweight clause counting is imperfect.
        // Keep rendering and let the user continue editing instead of replacing the document with a warning banner.
        if (renderedClauses.length < originalClauses.length && text.length > 100) {
            console.warn('[FINAL EDITOR] Clause count mismatch while paginating; keeping editor visible.', {
                original: originalClauses.length,
                rendered: renderedClauses.length
            });
        }

        console.log('[FINAL PAGE SPLIT RESULT]', {
            pageCount: pages.length,
            pages: pages.map((p, i) => ({
                page: i + 1,
                lineCount: p.length,
                textLength: p.join('\n').length,
                preview: p.join('\n').slice(0, 80)
            }))
        });

        if (pages.length === 1 && this._needsMinimumTwoFinalPages(text) && !faithfulReparse) {
            console.warn('[FINAL PAGE SPLIT WARNING] Long document produced only 1 page. Forcing fallback split.', {
                textLength: text.length,
                lineCount: String(text || '').split('\n').length
            });
            return this._renderFallbackPages(text);
        }

        this._totalPages = pages.length;
        return pages.map((pageLines, pageIndex) => `
            <div class="v3-editor-page final-contract-page ${pageIndex > 0 ? 'is-continuation-page' : ''} ${faithfulReparse ? 'is-faithful-reparse' : ''}" data-page="${pageIndex + 1}" onclick="window.signViewer._handleFreeTextPageClick(event)" ondblclick="window.signViewer._handleFreeTextPageDblClick(event)">
                <div class="final-contract-page-body v3-rich-editor-body"
                     contenteditable="true"
                     spellcheck="true"
                     oninput="window.signViewer._onRichEditorInput(this)"
                     onpaste="window.signViewer._onRichEditorPaste(event, this)"
                     onkeydown="window.signViewer._onRichEditorKeyDown(event, this)"
                     oncompositionstart="window.signViewer._onRichEditorCompositionStart(event)"
                     oncompositionend="window.signViewer._onRichEditorCompositionEnd(event)"
                     onfocusout="window.signViewer._onRichEditorBlur(this)"
                     onblur="window.signViewer._onRichEditorBlur(this)">${this._renderStructuredBlocks(pageLines, { markApplied: true, stableTypography: true, preserveOriginalStructure: faithfulReparse })}</div>
                ${this._renderFreeTextLayerForPage(pageIndex + 1)}
            </div>
        `).join('');
    },

    _renderFallbackPages(text) {
        const lines = String(text || '').split('\n');
        const mid = Math.floor(lines.length / 2);
        const pages = [lines.slice(0, mid), lines.slice(mid)];
        this._totalPages = 2;
        return pages.map((pageLines, pageIndex) => `
            <div class="v3-editor-page final-contract-page ${pageIndex > 0 ? 'is-continuation-page' : ''}" data-page="${pageIndex + 1}" onclick="window.signViewer._handleFreeTextPageClick(event)" ondblclick="window.signViewer._handleFreeTextPageDblClick(event)">
                <div class="final-contract-page-body v3-rich-editor-body"
                     contenteditable="true"
                     spellcheck="true"
                     oninput="window.signViewer._onRichEditorInput(this)"
                     onpaste="window.signViewer._onRichEditorPaste(event, this)"
                     onkeydown="window.signViewer._onRichEditorKeyDown(event, this)"
                     oncompositionstart="window.signViewer._onRichEditorCompositionStart(event)"
                     oncompositionend="window.signViewer._onRichEditorCompositionEnd(event)"
                     onfocusout="window.signViewer._onRichEditorBlur(this)"
                     onblur="window.signViewer._onRichEditorBlur(this)">${this._renderStructuredBlocks(pageLines, { markApplied: true, stableTypography: true })}</div>
                ${this._renderFreeTextLayerForPage(pageIndex + 1)}
            </div>
        `).join('');
    },

    _fitPagesToTargetCount(pages, targetPageCount = null) {
        const target = Number.isFinite(Number(targetPageCount)) && Number(targetPageCount) > 0
            ? Math.max(1, Math.round(Number(targetPageCount)))
            : null;
        const sourcePages = Array.isArray(pages) && pages.length ? pages : [[' ']];
        if (!target) return sourcePages;
        if (target <= 1 && sourcePages.length > 1) return sourcePages;
        if (sourcePages.length === target) return sourcePages;
        if (sourcePages.length < target) {
            const { charsPerLine, linesPerPage } = this._calcPageLayout();
            return this._paginateDocumentText(sourcePages.flat().join('\n'), charsPerLine, linesPerPage, target);
        }

        return sourcePages;
    },

    _resolveFinalTargetPageCount(text, targetPageCount = null) {
        const target = Number.isFinite(Number(targetPageCount)) && Number(targetPageCount) > 0
            ? Math.max(1, Math.round(Number(targetPageCount)))
            : null;
        if (target && target > 1) return target;
        const originalPageCount = Number(this._getOriginalPageCount() || 0);
        if (Number.isFinite(originalPageCount) && originalPageCount > 1) {
            return Math.round(originalPageCount);
        }
        if (this._needsMinimumTwoFinalPages(text)) return 2;
        return target;
    },

    _needsMinimumTwoFinalPages(text) {
        const normalized = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const lines = normalized.split('\n');
        const nonEmptyLines = lines.map(line => line.trim()).filter(Boolean);
        const articleCount = (normalized.match(/第\s*[0-9０-９零〇一二三四五六七八九十百千]+\s*条/g) || []).length;
        return Boolean(
            nonEmptyLines.length >= 30
            || articleCount >= 8
            || normalized.length >= 1400
        );
    },

    async _paginateByDOMHeights(text, targetPageCount = null) {
        console.log('[PAGE BUILD START]', { textLength: (text || '').length, targetPageCount });
        const PAGE_HEIGHT = 1122;
        const TOP_PADDING = 96;
        const BOTTOM_PADDING = 96;
        const SIDE_PADDING = 72;
        const GAP_HEIGHT = 4;
        const editorFontSize = this._getFinalEditorFontSize();
        const editorLineHeight = this._getFinalEditorLineHeight();
        // Total height available for blocks inside the padding
        const PAGE_CONTENT_LIMIT = PAGE_HEIGHT - TOP_PADDING - BOTTOM_PADDING; 
        const PAGE_HEIGHT_LIMIT = PAGE_CONTENT_LIMIT;

        const measurementId = `final-page-measure-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
        const measurementStyle = document.createElement('style');
        measurementStyle.textContent = `
            #${measurementId} .v3-editor-block {
                position:relative;
                margin:0 0 4px 0;
                padding:1px 0;
                white-space:pre-wrap;
                overflow-wrap:anywhere;
                word-break:normal;
                min-height:1.1em;
                text-align:left;
                box-sizing:border-box;
            }
            #${measurementId} .v3-editor-block.type-title {
                margin-top:8px;
                margin-bottom:24px;
                text-align:center;
                font-size:${Math.max(18, editorFontSize + 4)}px;
                font-weight:700;
                letter-spacing:0;
                color:#000;
            }
            #${measurementId} .v3-editor-block.type-heading {
                margin-bottom:6px;
                font-weight:700;
                font-size:${Math.max(13.5, editorFontSize)}px;
                color:#000;
            }
            #${measurementId} .v3-editor-block.type-list {
                margin-left:1.45em;
                text-indent:-1.45em;
                margin-bottom:3px;
            }
            #${measurementId} .v3-editor-block.type-signature {
                margin-top:40px;
                text-align:right;
            }
        `;
        document.head.appendChild(measurementStyle);

        const measureContainer = document.createElement('div');
        measureContainer.id = measurementId;
        measureContainer.style.cssText = `
            position: fixed;
            top: 0;
            left: -3000px;
            width: 794px;
            padding: ${TOP_PADDING}px ${SIDE_PADDING}px ${BOTTOM_PADDING}px ${SIDE_PADDING}px;
            box-sizing: border-box;
            font-family: 'Noto Serif JP', 'Yu Mincho', 'MS Mincho', serif;
            font-size: ${editorFontSize}px;
            line-height: ${editorLineHeight};
            background: white;
            z-index: -2000;
            pointer-events: none;
            visibility: visible;
            display: flex;
            flex-direction: column;
            gap: 4px;
            white-space: pre-wrap;
            overflow-wrap: anywhere;
            word-break: normal;
        `;

        try {
            document.body.appendChild(measureContainer);

            const lines = String(text || '').split('\n');
            measureContainer.innerHTML = this._renderStructuredBlocks(lines, { stableTypography: true });
            
            void measureContainer.offsetHeight;

            const blocks = Array.from(measureContainer.children);

            // 1. 全ブロックの高さが0なら、1フレーム待ってリトライ
            const allZero = blocks.every(b => b.offsetHeight === 0);
            if (allZero && blocks.length > 0) {
                const nextFrame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
                await nextFrame();
                await nextFrame(); // Double frame for safety
                void measureContainer.offsetHeight;
            }

            const pages = [[]];
            let currentHeight = 0;
            console.log('[PAGE MEASURE START]', { 
                lineCount: lines.length, 
                blockCount: blocks.length,
                measureContainerHeight: measureContainer.offsetHeight 
            });

            blocks.forEach((block, idx) => {
                const h = Math.max(block.offsetHeight, block.getBoundingClientRect().height);
                const style = window.getComputedStyle(block);
                const marginTop = parseFloat(style.marginTop) || 0;
                const marginBottom = parseFloat(style.marginBottom) || 0;
                const totalH = h + marginTop + marginBottom;

                // 2. 高さ0のブロックには行数ベースの推定値を使う（フォントサイズ × 行高 × 推計行数）
                const estimatedLineCount = Math.max(1, Math.ceil((lines[idx] || '').length / 30));
                const lineH = this._getFinalEditorFontSize() * Number(this._getFinalEditorLineHeight());
                let safeH = totalH > 0 ? totalH : (lineH * estimatedLineCount);
                if (safeH < lineH) safeH = lineH;
                
                // [BLOCK HEIGHT] log as requested
                console.log('[BLOCK HEIGHT]', {
                    text: (lines[idx] || '').substring(0, 20),
                    blockHeight: safeH,
                    currentHeight,
                    pageHeight: PAGE_HEIGHT,
                    totalH,
                    offsetHeight: block.offsetHeight
                });

                const isHeading = block.classList.contains('type-heading');
                if (isHeading) {
                    console.log('[CLAUSE DETECT]', {
                        line: (lines[idx] || '').substring(0, 30),
                        matched: true,
                        page: pages.length
                    });
                }


                // [CLAUSE-AWARE PAGINATION] 
                // We want to avoid "Orphaned Headings" and keep clauses together if possible.
                const totalSpaceNeeded = (pages[pages.length - 1].length > 0 ? GAP_HEIGHT : 0) + safeH;
                let willOverflow = currentHeight + totalSpaceNeeded > PAGE_HEIGHT_LIMIT;
                
                if (!willOverflow && isHeading) {
                    // Look ahead to see if the WHOLE clause fits on the current page.
                    let clauseTotalHeight = safeH;
                    for (let j = idx + 1; j < blocks.length; j++) {
                        const nextB = blocks[j];
                        if (nextB.classList.contains('type-heading')) break;
                        clauseTotalHeight += GAP_HEIGHT + (Math.max(nextB.offsetHeight, nextB.getBoundingClientRect().height) || 25);
                    }

                    if (currentHeight + (pages[pages.length - 1].length > 0 ? GAP_HEIGHT : 0) + clauseTotalHeight > PAGE_HEIGHT_LIMIT) {
                        // The whole clause doesn't fit on this page.
                        if (clauseTotalHeight < PAGE_HEIGHT_LIMIT) {
                            willOverflow = true;
                            console.warn('[CLAUSE CUT PREVENTED]', {
                                clause: (lines[idx] || '').substring(0, 30),
                                blockHeight: safeH,
                                clauseTotalHeight,
                                currentHeight,
                                nextPage: true
                            });
                        } else {
                            // Clause is massive (> 1 page). Just ensure Header + 1st Block stay together.
                            if (idx < blocks.length - 1) {
                                const nextB = blocks[idx + 1];
                                const nextH = (Math.max(nextB.offsetHeight, nextB.getBoundingClientRect().height) || 25);
                                if (currentHeight + totalSpaceNeeded + GAP_HEIGHT + nextH > PAGE_HEIGHT_LIMIT) {
                                    willOverflow = true;
                                }
                            }
                        }
                    }
                }

                // [PAGE OVERFLOW CHECK]
                console.log('[PAGE OVERFLOW CHECK]', {
                    currentHeight,
                    blockHeight: safeH,
                    pageHeight: PAGE_HEIGHT,
                    topPadding: TOP_PADDING,
                    bottomPadding: BOTTOM_PADDING,
                    willOverflow,
                    text: (lines[idx] || '').substring(0, 20),
                    page: pages.length
                });

                if (willOverflow && pages[pages.length - 1].length > 0) {
                    console.log('[NEW PAGE CREATED]', {
                        pageIndex: pages.length,
                        currentHeight,
                        remainingSpace: PAGE_HEIGHT_LIMIT - currentHeight
                    });
                    pages.push([]);
                    currentHeight = 0;
                }
                
                if (pages[pages.length - 1].length > 0) {
                    currentHeight += GAP_HEIGHT;
                }

                pages[pages.length - 1].push(lines[idx]);
                currentHeight += safeH;
            });

            return this._fitPagesToTargetCount(pages, targetPageCount);
        } finally {
            if (measureContainer.parentElement) {
                document.body.removeChild(measureContainer);
            }
            measurementStyle.remove();
        }
    },

    _getAppliedChangeHighlightSnippets() {
        const changes = this._getActiveSortedAiChanges();
        const applied = this._getAppliedIndexesForFinalView(changes);
        const snippets = [];
        changes.forEach((change, index) => {
            if (!applied.has(index)) return;
            const kind = this._getChangeKind(change);
            // DELETE は oldText を取消し線対象に、ADD/MODIFY/CLAR は newText を着色対象に
            const sourceText = kind === 'delete'
                ? this._getChangeOldText(change)
                : this._buildLegalInsertionText(change);
            String(sourceText || '')
                .split('\n')
                .map(line => line.trim())
                .filter(line => line.length >= 2)
                .forEach(line => snippets.push({ text: line, kind }));
        });
        const seen = new Set();
        return snippets
            .filter(item => {
                const key = `${item.kind}:${item.text}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            })
            .sort((a, b) => b.text.length - a.text.length);
    },

    _markAppliedSnippetInEscapedLine(escapedLine, snippets) {
        let html = escapedLine;
        const matchedKinds = new Set();
        let pulseLine = false;
        const justAppliedHead = this._justAppliedSnippet
            ? String(this._justAppliedSnippet).trim().split('\n')[0].trim()
            : '';
        // unescape for plain-text bidirectional comparisons
        const plainLine = String(escapedLine || '')
            .replace(/<[^>]*>/g, '')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&amp;/g, '&');
        const normalizeWs = (s) => String(s || '').replace(/[\s　]+/g, '');
        const normalizedLine = normalizeWs(plainLine);
        snippets.forEach(snippet => {
            const snippetText = typeof snippet === 'string' ? snippet : snippet.text;
            const kind = (typeof snippet === 'string' ? 'add' : snippet.kind) || 'add';
            if (!snippetText) return;
            const escapedSnippet = this.escapeHtml(snippetText);
            const isPulse = justAppliedHead && (snippetText.includes(justAppliedHead) || justAppliedHead.includes(snippetText));
            const cls = [
                'v3-applied-change',
                `v3-applied-change-${kind}`,
                isPulse ? 'v3-applied-change-pulse' : ''
            ].filter(Boolean).join(' ');
            // (a) 厳密一致 → 既存 span 包み
            if (escapedSnippet && html.includes(escapedSnippet)) {
                html = html.split(escapedSnippet).join(`<span class="${cls}">${escapedSnippet}</span>`);
                matchedKinds.add(kind);
                if (isPulse) pulseLine = true;
                return;
            }
            // (b) 空白正規化 + 双方向部分一致 → 行レベルマッチとしてフラグ
            const normalizedSnippet = normalizeWs(snippetText);
            if (normalizedSnippet.length < 2 || normalizedLine.length < 2) return;
            const lineHasSnippet = normalizedLine.includes(normalizedSnippet);
            const snippetHasLine = normalizedSnippet.includes(normalizedLine);
            if (lineHasSnippet || snippetHasLine) {
                matchedKinds.add(kind);
                if (isPulse) pulseLine = true;
            }
        });
        return { html, kinds: matchedKinds, pulse: pulseLine };
    },

    _renderStructuredBlocks(lines, options = {}) {
        const totalLines = lines.length;
        const appliedSnippets = options.markApplied ? this._getAppliedChangeHighlightSnippets() : [];
        const stableTypography = options.stableTypography === true;
        const preserveOriginalStructure = options.preserveOriginalStructure === true;
        let titleCount = 0;
        return lines.map((line, idx) => {
            const block = preserveOriginalStructure
                ? { type: 'body', text: line }
                : this._parseBlockType(line, idx, totalLines);
            const isEmptyLine = !String(line || '').trim();
            if ((stableTypography || preserveOriginalStructure) && (block.type === 'title' || block.type === 'heading' || block.type === 'signature' || block.type === 'list')) {
                block.type = 'body';
            }
            if (block.type === 'title') {
                if (titleCount > 0) block.type = 'body';
                titleCount++;
            }
            // Keep blank lines as actual editable rows so users can click them and adjust spacing.
            const escapedContent = isEmptyLine ? '<br data-empty-line="true">' : this.escapeHtml(line);
            let content = escapedContent;
            let lineClasses = '';
            if (appliedSnippets.length && !isEmptyLine) {
                const result = this._markAppliedSnippetInEscapedLine(escapedContent, appliedSnippets);
                content = result.html;
                if (result.kinds && result.kinds.size) {
                    lineClasses = ' ' + Array.from(result.kinds)
                        .map(k => `v3-applied-line v3-applied-line-${k}`)
                        .join(' ') + (result.pulse ? ' v3-applied-line-pulse' : '');
                }
            }
            return `<p class="v3-editor-block type-${block.type}${isEmptyLine ? ' is-empty' : ''}${lineClasses}" spellcheck="true" data-editor-tag="p">${content}</p>`;
        }).join('');
    },

    _parseBlockType(line, index, totalLines) {
        const s = line.trim();
        if (!s) return { type: 'body', text: line };

        // 1. Title (Only allow at the very top, first few lines)
        if (index < 5 && s.includes('契約書') && s.length < 40 && !s.includes('第')) {
            // Check if we already have a title
            return { type: 'title', text: line };
        }
        // 2. Heading (Clause Numbers)
        // Supports: 第1条, 第１条, 第十条, 第◯条, 第〇条, 第○条 etc.
        const isClause = /^第\s*[一二三四五六七八九十百千万零〇○◯\d０-９]+\s*[条章節]/.test(s);
        const isStandaloneHeader = /^（[^）]{1,20}）$/.test(s) || /^【[^】]{1,20}】$/.test(s) || ['記', '以上', '附則', '別紙', '別表'].includes(s);
        
        if (isClause || isStandaloneHeader) {
            return { type: 'heading', text: line };
        }
        // 3. Lists
        if (/^[\(（][\d１２３４５６７８９０一二三四五六七八九十]+[\)）]/.test(s) || /^[①-⑳]/.test(s) || /^[・\-\*]/.test(s) || /^[\d０-９]+[\.．\s　]/.test(s)) {
            return { type: 'list', text: line };
        }
        // 4. Signature
        if (/^(甲|乙|住所|氏名|代表取締役|年月日)[:：]/.test(s) || s.endsWith('印') || (index > totalLines - 15 && s.length < 40 && (s.includes('甲') || s.includes('乙')))) {
            return { type: 'signature', text: line };
        }

        return { type: 'body', text: line };
    },

    _renderFinalPreviewPagesHtml(text, html = this._getFinalDocumentHtml()) {
        return this._renderDocumentPagesHtml(text, {
            editable: false,
            showRevisionMarks: false,
            markChangedLines: false,
            showPageNumbers: false,
            targetPageCount: this._getOriginalPageCount()
        });
    },

    _buildMarkedRevisedText(changes = this._getSortedAiChanges()) {
        let docText = this._getRawText((this._contract || {}).ai_final_document || '');
        if (docText) return docText;

        docText = this._getOriginalDocumentText();
        changes.forEach((change) => {
            const oldText = this._getChangeOldText(change);
            const newText = this._buildLegalInsertionText(change);
            if (oldText && newText && docText.includes(oldText)) {
                docText = docText.split(oldText).join(`\x00REV\x00${newText}\x00/REV\x00`);
            }
        });

        if (!docText && changes.length > 0) {
            docText = changes.map((change, index) => {
                const section = this._getChangeDisplaySection(change, index);
                const oldText = this._getChangeOldText(change);
                const newText = this._buildLegalInsertionText(change);
                return [
                    `【${section}】`,
                    oldText ? `修正前：${oldText}` : '',
                    newText ? `\x00REV\x00${newText}\x00/REV\x00` : ''
                ].filter(Boolean).join('\n');
            }).join('\n\n');
        }
        return docText;
    },

    _getFinalEditorFontSize() {
        const size = Number(this._editorFontSize || this._contract?.final_font_size || 14);
        return Number.isFinite(size) ? Math.min(32, Math.max(12, size)) : 14;
    },

    _getFinalEditorLineHeight() {
        const allowed = ['0.8', '1.0', '1.2', '1.5', '1.8', '2.0'];
        const value = String(this._finalEditorLineHeight || this._contract?.final_line_height || '1.5');
        return allowed.includes(value) ? value : '1.5';
    },

    _setFinalEditorFontSize(value) {
        const size = Math.min(32, Math.max(12, Number(value) || 14));
        this._editorFontSize = size;
        if (this._contract) {
            this._contract.final_font_size = size;
            dbService.updateContract(this._contract.id, { final_font_size: size });
        }
        document.querySelectorAll('#v3-editor-scroll .v3-editor-page, #v3-editor-scroll .v3-rich-editor-body').forEach(el => { el.style.fontSize = `${size}px`; });
        if (this._repaginateTimeout) clearTimeout(this._repaginateTimeout);
        this._forceRepaginationOnce = true;
        this._repaginateTimeout = setTimeout(() => this._repaginateEditor(), 100);
    },

    _removeCandidateText(text, candidate) {
        let nextText = String(text || '');
        const target = String(candidate || '').trim();
        if (!target) return nextText;
        if (nextText.includes(target)) {
            return nextText.split(target).join('').replace(/\n{3,}/g, '\n\n').trim();
        }
        const replaced = this._replaceTextByNormalizedSlice(nextText, target, '');
        if (replaced !== null && replaced !== nextText) {
            return replaced.replace(/\n{3,}/g, '\n\n').trim();
        }
        const flexiblePattern = target.split(/\s+/).filter(Boolean).map(part => this._escapeRegex(part)).join('\\s+');
        if (flexiblePattern) {
            const flexibleNext = nextText.replace(new RegExp(flexiblePattern), '').replace(/\n{3,}/g, '\n\n').trim();
            if (flexibleNext !== nextText) return flexibleNext;
        }
        return nextText;
    },

    _normalizeCandidateText(value) {
        return String(value || '')
            .replace(/[\u200B-\u200D\uFEFF]/g, '')
            .replace(/[\s　]+/g, '');
    },

    _textContainsCandidate(text, candidate) {
        const needle = this._normalizeCandidateText(candidate);
        return needle.length >= 4 && this._normalizeCandidateText(text).includes(needle);
    },

    _revertChangeInText(text, change, index = null) {
        let nextText = String(text || '');
        if (this._isAdditionChange(change)) {
            const candidates = [
                index !== null ? this._getFinalOverlayTextForChange(change, index) : '',
                this._buildLegalInsertionText(change),
                this._getChangeNewText(change)
            ];
            for (const candidate of candidates) {
                const reverted = this._removeCandidateText(nextText, candidate);
                if (reverted !== nextText) return reverted;
            }
            return nextText;
        }
        const oldText = this._getChangeOldText(change);
        const newText = this._buildLegalInsertionText(change);
        if (!oldText || !newText) return nextText;
        if (nextText.includes(newText)) return nextText.split(newText).join(oldText);
        const replaced = this._replaceTextByNormalizedSlice(nextText, newText, oldText);
        if (replaced !== null) return replaced;
        const flexiblePattern = newText.split(/\s+/).filter(Boolean).map(part => this._escapeRegex(part)).join('\\s+');
        if (flexiblePattern) return nextText.replace(new RegExp(flexiblePattern), oldText);
        return nextText;
    },

    _revertChange(idx) {
        const changes = this._getActiveSortedAiChanges();
        const c = changes[idx];
        if (!c) return;
        const baseText = this._ensureEditedContent();
        const editedOverlayText = this._getFinalOverlayTextForChange(c, idx);
        let nextText = this._revertChangeInText(baseText, c, idx);
        if (editedOverlayText && nextText.includes(editedOverlayText)) {
            nextText = nextText.split(editedOverlayText).join('').replace(/\n{3,}/g, '\n\n').trim();
        }
        const textChanged = nextText !== baseText;
        if (textChanged) {
            if (!this._editHistory) {
                this._editHistory = [baseText];
                this._editHistoryIndex = 0;
            }
            this._editedContent = nextText;
            this._editedHtml = '';
            this._lastSavedContent = nextText;
            this._lastPreviewContent = '';
            this._pushHistory(nextText);
            if (this._contract) {
                this._contract.final_content = nextText;
                this._contract.final_content_html = '';
            }
            this._invalidateFinalRenderedCache();
        }
        const applied = this._getStoredAppliedChangeIndexes();
        applied.delete(idx);
        const overlayEdits = this._getFinalOverlayEdits();
        delete overlayEdits[String(idx)];
        if (this._contract) this._contract.final_overlay_edits = overlayEdits;
        this._setStoredAppliedChangeIndexes(applied, {
            final_content: textChanged ? nextText : baseText,
            final_content_html: '',
            final_overlay_edits: overlayEdits,
            final_font_size: this._getFinalEditorFontSize()
        });
        this.renderModifiedDocument(this._viewerContainer);
    },

    // 独自のセンターポップアップ（ネイティブ confirm の代替）
    _showConfirmModal({ title = '確認', message = '', confirmLabel = 'はい', cancelLabel = 'キャンセル', accent = '#0b2d62', onConfirm = null } = {}) {
        const existing = document.getElementById('v3-confirm-modal');
        if (existing) existing.remove();
        const overlay = document.createElement('div');
        overlay.id = 'v3-confirm-modal';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.55);z-index:100000;display:flex;align-items:center;justify-content:center;animation:v3-modal-fade-in 0.15s ease-out;';
        overlay.innerHTML = `
            <style>
                @keyframes v3-modal-fade-in { from { opacity:0 } to { opacity:1 } }
                @keyframes v3-modal-pop { from { transform:scale(0.92); opacity:0 } to { transform:scale(1); opacity:1 } }
            </style>
            <div role="dialog" aria-modal="true" style="background:#fff;width:min(440px,92vw);border-radius:14px;box-shadow:0 24px 64px rgba(15,23,42,0.32);overflow:hidden;animation:v3-modal-pop 0.18s ease-out;">
                <div style="padding:20px 24px 8px 24px;display:flex;align-items:center;gap:10px;">
                    <i class="fa-solid fa-circle-question" style="color:${accent};font-size:20px;"></i>
                    <span style="font-size:16px;font-weight:800;color:#0f172a;">${this.escapeHtml(title)}</span>
                </div>
                <div style="padding:8px 24px 20px 24px;font-size:14px;color:#334155;line-height:1.7;">${this.escapeHtml(message)}</div>
                <div style="padding:14px 20px;background:#f8fafc;display:flex;justify-content:flex-end;gap:10px;border-top:1px solid #e2e8f0;">
                    <button id="v3-confirm-modal-cancel" style="background:#fff;color:#475569;border:1px solid #d1d5db;padding:8px 18px;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;">${this.escapeHtml(cancelLabel)}</button>
                    <button id="v3-confirm-modal-ok" style="background:${accent};color:#fff;border:none;padding:8px 22px;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;box-shadow:0 2px 8px ${accent}40;">${this.escapeHtml(confirmLabel)}</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        const close = () => overlay.remove();
        overlay.querySelector('#v3-confirm-modal-cancel').addEventListener('click', close);
        overlay.querySelector('#v3-confirm-modal-ok').addEventListener('click', () => {
            close();
            try { if (typeof onConfirm === 'function') onConfirm(); } catch (e) { console.warn('[SignViewer] confirm modal onConfirm error:', e); }
        });
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        document.addEventListener('keydown', function escHandler(ev) {
            if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', escHandler); }
        });
        setTimeout(() => overlay.querySelector('#v3-confirm-modal-ok')?.focus(), 50);
    },

    _confirmRevertAll() {
        this._showConfirmModal({
            title: '反映を解除しますか？',
            message: '反映済みの修正案をすべて解除し、最終版を原文に戻します。よろしいですか？',
            confirmLabel: 'すべて元に戻す',
            cancelLabel: 'キャンセル',
            accent: '#dc2626',
            onConfirm: () => this._revertAllChanges()
        });
    },

    _revertAllChanges() {
        const changes = this._getActiveSortedAiChanges();
        if (!changes.length) return;
        let nextText = this._ensureEditedContent();
        const before = nextText;
        const applied = this._getStoredAppliedChangeIndexes();
        changes.forEach((c, i) => {
            if (!applied.size || applied.has(i)) {
                nextText = this._revertChangeInText(nextText, c, i);
            }
        });
        if (nextText === before && applied.size === 0) {
            Notify.info('元に戻せる修正案はありません。');
            return;
        }
        if (!this._editHistory) {
            this._editHistory = [before];
            this._editHistoryIndex = 0;
        }
        this._editedContent = nextText;
        this._editedHtml = '';
        this._lastSavedContent = nextText;
        this._lastPreviewContent = '';
        this._pushHistory(nextText);
        if (this._contract) {
            this._contract.final_content = nextText;
            this._contract.final_content_html = '';
            this._contract.final_overlay_edits = {};
        }
        const overlayEdits = this._getFinalOverlayEdits();
        applied.forEach(index => { delete overlayEdits[String(index)]; });
        if (this._contract) this._contract.final_overlay_edits = overlayEdits;
        this._setStoredAppliedChangeIndexes(new Set(), {
            final_content: nextText,
            final_content_html: '',
            final_overlay_edits: overlayEdits,
            final_font_size: this._getFinalEditorFontSize()
        });
        Notify.success(nextText === before ? '反映済み状態を解除しました。' : 'すべての修正案を元に戻しました。');
        this.renderModifiedDocument(this._viewerContainer);
    },

    _paginateDocumentText(text, charsPerLine = 60, linesPerPage = 46, targetPageCount = null) {
        const lines = String(text || '').split('\n');
        const targetPages = Number.isFinite(Number(targetPageCount)) && Number(targetPageCount) > 0
            ? Math.max(1, Math.round(Number(targetPageCount)))
            : null;

        // Shared helpers for heading detection
        const _isArticleH = (s) => {
            const t = String(s || '').trim();
            return /^第\s*[一二三四五六七八九十百千万零〇\d０-９]+\s*条/.test(t) || /^第\s*[一二三四五六七八九十百千万零〇\d０-９]+\s*章/.test(t) || /^第\s*[一二三四五六７８９０]+\s*節/.test(t);
        };
        const _isSubH = (s) => {
            const t = String(s || '').trim();
            return /^（[^）]{1,20}）$/.test(t) || /^【[^】]{1,20}】$/.test(t) || /^[一二三四五六七八九十]、/.test(t) || /^[①-⑳]/.test(t) || ['記','以上','附則','別紙'].includes(t);
        };
        const _lineWeight = (line, idx) => {
            const plain = String(line || '').replace(/\x00\/?REV\x00/g, '');
            const trimmed = plain.trim();
            if (!trimmed) return 0.5;
            const wrapLines = Math.max(1, Math.ceil(plain.length / charsPerLine));
            let extra = 0.5; // Body margin
            if (idx < 5 && trimmed.includes('契約書') && !trimmed.includes('第')) extra = 1.6; // Title
            else if (_isArticleH(trimmed) || _isSubH(trimmed)) extra = 0.8; // Heading
            return wrapLines + extra;
        };

        if (targetPages) {
            const weightedLines = lines.map((line, idx) => ({
                line,
                weight: _lineWeight(line, idx)
            }));
            const totalWeight = Math.max(1, weightedLines.reduce((sum, item) => sum + item.weight, 0));
            const targetWeightPerPage = Math.max(1, Math.ceil(totalWeight / targetPages));
            const pages = [];
            let currentPage = [];
            let currentWeight = 0;

            weightedLines.forEach((item) => {
                if (pages.length < targetPages - 1 && currentPage.length > 0 && currentWeight + item.weight > targetWeightPerPage) {
                    pages.push(currentPage);
                    currentPage = [];
                    currentWeight = 0;
                }
                currentPage.push(item.line);
                currentWeight += item.weight;
            });
            pages.push(currentPage.length > 0 ? currentPage : [' ']);
            while (pages.length < targetPages) pages.push([' ']);
            return pages;
        }

        const pages = [];
        let currentPage = [];
        let currentWeight = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const w = _lineWeight(line, i);
            if (currentWeight + w > linesPerPage && currentPage.length > 0) {
                const lastTrimmed = String(currentPage[currentPage.length - 1] || '').trim();
                if (_isSubH(lastTrimmed) || _isArticleH(lastTrimmed)) {
                    currentPage.push(line);
                    currentWeight += w;
                    continue;
                }
                pages.push(currentPage);
                currentPage = [];
                currentWeight = 0;
            }
            currentPage.push(line);
            currentWeight += w;
        }
        if (currentPage.length > 0) pages.push(currentPage);
        return pages;
    },

    _renderDocumentPagesHtml(text, options = {}) {
        const {
            editable = false,
            showRevisionMarks = false,
            markChangedLines = false,
            markApplied = false,
            originalText = this._getOriginalDocumentText(),
            showPageNumbers = false,
            targetPageCount = null
        } = options;
        const originalLines = new Set(String(originalText || '').split('\n').map(line => line.trim()).filter(Boolean));
        const { charsPerLine, linesPerPage } = this._calcPageLayout();
        const effectiveTargetPageCount = this._resolveFinalTargetPageCount(text, targetPageCount);
        const pages = this._paginateDocumentText(text, charsPerLine, linesPerPage, effectiveTargetPageCount);
        const appliedSnippets = markApplied ? this._getAppliedChangeHighlightSnippets() : [];
        let blockIndex = 0;
        // 原本レイアウト復元: タイトル中央寄せ / 条見出し太字 / 番号付き小項目インデント。
        // 取り込み直後の最終版READビューがプレーンテキスト化し原文と乖離する不具合の修正。
        // type-* クラスは _getDocumentLayoutCss 既存スタイル(.type-title/.type-heading/.type-list)へ接続する。
        let titleAssigned = false;
        let layoutLineIndex = -1;
        const classifyLayoutType = (trimmed) => {
            if (!trimmed) return 'body';
            const isClauseHeading = /^第\s*[0-9０-９零〇一二三四五六七八九十百千]+\s*[条章節]/.test(trimmed);
            const isBracketHeader = /^（[^）]{1,20}）$/.test(trimmed) || /^【[^】]{1,20}】$/.test(trimmed) || ['記', '以上', '附則', '別紙', '別表'].includes(trimmed);
            const isSubItem = /^[（(][\d０-９一二三四五六七八九十]+[)）]/.test(trimmed) || /^[①-⑳]/.test(trimmed) || /^・/.test(trimmed);
            const isCenteredSubtitle = /^（.*(?:版|ver\.?|改訂|改定|[0-9０-９]+\s*年).*）$/.test(trimmed);
            if (!titleAssigned && layoutLineIndex < 6 && trimmed.includes('契約書') && trimmed.length < 40 && !isClauseHeading) {
                titleAssigned = true;
                return 'title';
            }
            if (isClauseHeading || isBracketHeader) return 'heading';
            if (isSubItem) return 'list';
            if (layoutLineIndex < 6 && isCenteredSubtitle) return 'subtitle';
            return 'body';
        };

        const renderLine = (line) => {
            layoutLineIndex += 1;
            const raw = String(line || '');
            const clean = raw.replace(/\x00REV\x00|\x00\/REV\x00/g, '');
            const trimmed = clean.trim();
            const isHeading = /^第[0-9０-９零〇一二三四五六七八九十百千]+条|^【|^■|^\d+\./.test(trimmed);
            const layoutType = classifyLayoutType(trimmed);
            const isEmpty = !trimmed;
            const isModified = markChangedLines && trimmed && !originalLines.has(trimmed);
            let content = showRevisionMarks
                ? this.escapeHtml(raw).replace(/\x00REV\x00([\s\S]*?)\x00\/REV\x00/g, '<mark class="v3-revision-mark">$1</mark>')
                : this.escapeHtml(clean);
            const lineKindClasses = [];
            let pulseLine = false;
            if (appliedSnippets.length && trimmed) {
                const result = this._markAppliedSnippetInEscapedLine(content, appliedSnippets);
                content = result.html;
                if (result.kinds && result.kinds.size) {
                    result.kinds.forEach(k => {
                        lineKindClasses.push('v3-applied-line');
                        lineKindClasses.push(`v3-applied-line-${k}`);
                    });
                    if (result.pulse) pulseLine = true;
                }
            }
            const classes = [
                'v3-editor-block',
                isHeading ? 'is-heading' : '',
                layoutType !== 'body' ? `type-${layoutType}` : '',
                isEmpty ? 'is-empty' : '',
                isModified ? 'modified' : '',
                showRevisionMarks && raw.includes('\x00REV\x00') ? 'modified' : '',
                ...lineKindClasses,
                pulseLine ? 'v3-applied-line-pulse' : ''
            ].filter(Boolean).join(' ');

            if (!editable) {
                return `<p class="${classes}">${content}</p>`;
            }

            const idx = blockIndex++;
            return `
                <p class="${classes}"
                     contenteditable="true"
                     data-index="${idx}"
                     oninput="window.signViewer._onBlockInput(this)"
                     onblur="window.signViewer._onBlockBlur(this)">${this.escapeHtml(clean)}</p>
            `;
        };

        this._totalPages = pages.length;
        return pages.map((pageLines, pageIndex) => `
            <div class="v3-editor-page" data-page="${pageIndex + 1}">
                ${pageLines.map(renderLine).join('')}
            </div>
        `).join('');
    },

    _getStoredAppliedChangeIndexes() {
        const stored = this._contract?.final_applied_change_indexes;
        if (Array.isArray(stored)) {
            return new Set(stored.map(Number).filter(Number.isInteger));
        }
        if (this._appliedChanges instanceof Set) {
            return new Set(this._appliedChanges);
        }
        return new Set();
    },

    _hasExplicitStoredAppliedChangeIndexes() {
        return Array.isArray(this._contract?.final_applied_change_indexes);
    },

    _getAppliedChangeIndexesForText(finalText = this._getFinalDocumentText()) {
        if (this._hasExplicitStoredAppliedChangeIndexes()) {
            return this._getStoredAppliedChangeIndexes();
        }
        const stored = this._getStoredAppliedChangeIndexes();
        if (stored.size > 0) return stored;
        return this._getAppliedChangeIndexesFromFinal(finalText);
    },

    _setStoredAppliedChangeIndexes(indexes, extraUpdate = null) {
        const normalized = Array.from(indexes || [])
            .map(Number)
            .filter(Number.isInteger)
            .sort((a, b) => a - b);
        this._appliedChanges = new Set(normalized);
        if (this._contract) {
            this._contract.final_applied_change_indexes = normalized;
            dbService.updateContract(this._contract.id, {
                ...(extraUpdate || {}),
                final_applied_change_indexes: normalized
            });
        }
    },

    _getAppliedChangeIndexesFromFinal(finalText = this._getFinalDocumentText()) {
        const changes = this._getActiveSortedAiChanges();
        const applied = new Set();
        const haystack = String(finalText || '');
        const normalizedHaystack = haystack.replace(/\s+/g, '');
        changes.forEach((change, index) => {
            const newText = this._buildLegalInsertionText(change);
            const normalizedNewText = String(newText || '').replace(/\s+/g, '');
            if (newText && (haystack.includes(newText) || (normalizedNewText && normalizedHaystack.includes(normalizedNewText)))) {
                applied.add(index);
            }
        });
        return applied;
    },

    _getDocumentLayoutCss() {
        const editorFontSize = this._getFinalEditorFontSize();
        const editorLineHeight = this._getFinalEditorLineHeight();
        return `
            <style>
                .v3-document-scroll-area { width:100%; height:100%; overflow:auto; background:#f1f5f9; display:flex; flex-direction:column; align-items:center; padding:24px 0 100px 0; box-sizing:border-box; cursor:default; }
                .docx-preview-mode {
                    height: auto !important;
                    min-height: auto !important;
                    max-height: none !important;
                    overflow: visible !important;
                    outline: none !important;
                    cursor: text !important;
                    padding: 0 !important;
                }

                .docx-preview-mode section.docx {
                    margin: 0 auto !important;
                    box-shadow: 0 1px 2px rgba(0,0,0,0.1) !important;
                }

                .v3-document-page-stack { display:flex; flex-direction:column; align-items:center; width:100%; }
                
                .v3-editor-container.final-document-editor {
                    background: #f3f4f6;
                    padding: 40px 0;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 40px;
                    width: 100%;
                    overflow-y: auto;
                    box-sizing: border-box;
                }

                .v3-editor-page, .final-contract-page {
                    background:#fff !important;
                    box-shadow: 0 1px 2px rgba(0,0,0,.04), 0 8px 24px rgba(0,0,0,.06) !important;
                    border: 1px solid #e5e7eb !important;
                    border-radius:2px !important;
                    width:794px !important;
                    height:1122px !important;
                    min-height:1122px !important;
                    margin:0 auto !important;
                    padding:96px 72px !important;
                    box-sizing:border-box;
                    font-family:'Noto Serif JP', 'Yu Mincho', 'MS Mincho', serif;
                    font-size:${editorFontSize}px;
                    line-height:${editorLineHeight};
                    color:#111;
                    position:relative;
                    overflow:visible !important;
                    flex:0 0 auto;
                    break-after:page;
                    page-break-after:always;
                    display: block !important;
                    visibility: visible !important;
                    opacity: 1 !important;
                }
                .final-contract-page.docx-editor-page {
                    width: 794px !important;
                    height: auto !important;
                    min-height: auto !important;
                    max-height: none !important;
                    overflow: visible !important;
                    background: transparent !important;
                    margin: 0 auto 24px !important;
                    padding: 0 !important;
                    box-shadow: none !important;
                    border: none !important;
                }

                .final-contract-page-body {
                    width: 100%;
                    height: 100%;
                    box-sizing: border-box;
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                }

                .final-contract-page.is-continuation-page {
                    padding-top: 76px !important;
                    padding-bottom: 76px !important;
                }

                .final-contract-page.is-continuation-page .final-contract-page-body {
                    gap: 5px;
                }

                .final-contract-page.is-continuation-page .v3-rich-editor-body {
                    line-height: 1.3 !important;
                }

                .final-contract-page.is-continuation-page .v3-editor-block {
                    margin-bottom: 5px;
                }

                .final-contract-page.is-continuation-page .v3-editor-block.type-heading {
                    margin-top: 8px;
                    margin-bottom: 7px;
                }

                .final-contract-page.is-continuation-page .v3-editor-block.type-list {
                    margin-bottom: 4px;
                }

                .final-contract-page.is-faithful-reparse,
                .final-contract-page.is-faithful-reparse.is-continuation-page {
                    padding-top:96px !important;
                    padding-bottom:96px !important;
                    font-weight:normal;
                    text-align:left;
                }

                .final-contract-page.is-faithful-reparse .final-contract-page-body,
                .final-contract-page.is-faithful-reparse.is-continuation-page .final-contract-page-body {
                    display:block !important;
                }

                .final-contract-page.is-faithful-reparse .v3-rich-editor-body,
                .final-contract-page.is-faithful-reparse.is-continuation-page .v3-rich-editor-body {
                    line-height:var(--v3-final-line-height, ${editorLineHeight}) !important;
                    font-size:${editorFontSize}px !important;
                    text-align:left;
                }

                .v3-rich-editor-body { 
                    min-height:930px; outline:none; white-space:pre-wrap; 
                    padding: 0 !important; margin: 0 !important;
                    overflow-wrap:anywhere; word-break:normal; overflow:visible; cursor:text; 
                    line-height:var(--v3-final-line-height, ${editorLineHeight}) !important; font-size:${editorFontSize}px !important; font-family:'Noto Serif JP', 'Yu Mincho', 'MS Mincho', serif; 
                }
                #v3-editor-scroll,
                #v3-editor-scroll * {
                    -webkit-user-select:text !important;
                    user-select:text !important;
                }
                .v3-editor-block {
                    position:relative;
                    margin:0 0 4px 0;
                    padding:1px 0;
                    outline:none;
                    white-space:pre-wrap;
                    overflow-wrap:anywhere;
                    word-break:normal;
                    border:1px solid transparent;
                    min-height:1.1em;
                    text-align:left;
                    cursor:text;
                    transition: background 0.1s;
                }

                .v3-editor-block.is-empty {
                    min-height:calc(var(--v3-final-line-height, ${editorLineHeight}) * 1em);
                    padding:2px 0;
                }

                .v3-editor-block.is-empty:hover {
                    background:rgba(37,99,235,0.04);
                    border-color:rgba(147,197,253,0.45);
                }

                .v3-free-text-layer {
                    position:absolute;
                    inset:96px 72px;
                    overflow:hidden;
                    pointer-events:none;
                    z-index:8;
                }

                .final-contract-page.is-continuation-page .v3-free-text-layer {
                    inset:76px 72px;
                }

                .final-contract-page.docx-editor-page .v3-free-text-layer {
                    inset:0;
                }

                .v3-free-text-note {
                    position:absolute;
                    z-index:1;
                    min-width:80px;
                    min-height:22px;
                    max-width:320px;
                    padding:2px 4px;
                    border:1px dashed rgba(37,99,235,0.42);
                    border-radius:4px;
                    background:rgba(255,255,255,0.88);
                    color:#111827;
                    font-family:'Noto Serif JP', 'Yu Mincho', 'MS Mincho', serif;
                    font-size:${editorFontSize}px;
                    line-height:1.5;
                    outline:none;
                    white-space:pre-wrap;
                    overflow-wrap:anywhere;
                    cursor:text;
                    pointer-events:auto;
                }

                .v3-free-text-note:focus {
                    border-color:#2563eb;
                    box-shadow:0 0 0 2px rgba(37,99,235,0.16);
                    background:#fff;
                }

                .v3-editor-block.type-title {
                    margin-top: 8px;
                    margin-bottom: 24px;
                    text-align: center;
                    font-size: ${Math.max(18, editorFontSize + 4)}px;
                    font-weight: 700;
                    letter-spacing: 0;
                    color: #000;
                }

                .v3-editor-block.type-subtitle {
                    margin-top: -14px;
                    margin-bottom: 22px;
                    text-align: center;
                    font-size: ${Math.max(12, editorFontSize - 1)}px;
                    color: #374151;
                }

                .v3-editor-block.type-heading {
                    margin-bottom: 6px;
                    font-weight: 700;
                    font-size: ${Math.max(13.5, editorFontSize)}px;
                    color: #000;
                }

                .v3-editor-block.type-list {
                    margin-left: 1.45em;
                    text-indent: -1.45em;
                    margin-bottom: 3px;
                }

                .final-contract-page.is-faithful-reparse .v3-editor-block,
                .final-contract-page.is-faithful-reparse .v3-editor-block.type-title,
                .final-contract-page.is-faithful-reparse .v3-editor-block.type-heading,
                .final-contract-page.is-faithful-reparse .v3-editor-block.type-list,
                .final-contract-page.is-faithful-reparse .v3-editor-block.type-signature {
                    margin:0 0 3px 0 !important;
                    padding:1px 0 !important;
                    font-size:${editorFontSize}px;
                    font-weight:inherit;
                    line-height:var(--v3-final-line-height, ${editorLineHeight}) !important;
                    text-align:left;
                    text-indent:0 !important;
                    letter-spacing:0 !important;
                    white-space:pre-wrap !important;
                    border:none !important;
                    min-height:calc(var(--v3-final-line-height, ${editorLineHeight}) * 1em) !important;
                    background:transparent !important;
                }

                .final-contract-page.is-faithful-reparse .v3-editor-source-table {
                    width:100%;
                    border-collapse:collapse;
                    table-layout:fixed;
                    margin:0 0 calc(var(--v3-final-line-height, ${editorLineHeight}) * 0.5em) 0;
                    white-space:normal;
                }

                .final-contract-page.is-faithful-reparse .v3-editor-source-table td,
                .final-contract-page.is-faithful-reparse .v3-editor-source-table th {
                    border:1px solid #111;
                    padding:2px 4px;
                    vertical-align:top;
                    white-space:pre-wrap;
                    text-align:left;
                }

                .final-contract-page.is-faithful-reparse .v3-editor-source-table .v3-editor-block {
                    min-height:calc(var(--v3-final-line-height, ${editorLineHeight}) * 0.9em) !important;
                }

                .final-contract-page.is-faithful-reparse .v3-editor-tab {
                    white-space:pre;
                }

                /* boundary guard: line-height:1.25 !important; */

                .v3-editor-block.type-signature {
                    margin-top: 40px;
                    text-align: right;
                }

                #v3-edit-layer .v3-rich-editor-body .v3-editor-block.type-title,
                #v3-edit-layer .v3-rich-editor-body .v3-editor-block.type-heading,
                #v3-edit-layer .v3-rich-editor-body .v3-editor-block.type-signature {
                    font-size: inherit;
                    font-weight: inherit;
                    text-align: left;
                    margin-top: 0 !important;
                    margin-bottom: 4px !important;
                    letter-spacing: 0 !important;
                }

                .v3-applied-change { padding:0 1px; box-decoration-break:clone; -webkit-box-decoration-break:clone; }
                .v3-applied-change-add { background:linear-gradient(transparent 12%, #c7d2fe 12%, #c7d2fe 88%, transparent 88%); border-bottom:2px solid #6366f1; color:#312e81; }
                .v3-applied-change-modify { background:linear-gradient(transparent 12%, #bfdbfe 12%, #bfdbfe 88%, transparent 88%); border-bottom:2px solid #3b82f6; color:#1e3a8a; }
                .v3-applied-change-delete { background:linear-gradient(transparent 12%, #fecaca 12%, #fecaca 88%, transparent 88%); border-bottom:2px solid #ef4444; text-decoration:line-through; text-decoration-color:#dc2626; text-decoration-thickness:2px; color:#7f1d1d; }
                .v3-applied-change-clar { background:linear-gradient(transparent 12%, #a5f3fc 12%, #a5f3fc 88%, transparent 88%); border-bottom:2px solid #06b6d4; color:#164e63; }
                .v3-applied-change-pulse {
                    animation: v3-pulse-highlight 2s ease-out infinite;
                }
                @keyframes v3-pulse-highlight {
                    0% { box-shadow: 0 0 0 0 rgba(234, 179, 8, 0.4); }
                    70% { box-shadow: 0 0 0 10px rgba(234, 179, 8, 0); }
                    100% { box-shadow: 0 0 0 0 rgba(234, 179, 8, 0); }
                }

                /* 行レベルフォールバック: snippet が span 包みできない時に <p> 自体に薄い背景を付与 */
                .v3-applied-line { border-radius: 3px; }
                .v3-applied-line-add { background-color: rgba(199, 210, 254, 0.55); box-shadow: inset 0 -2px 0 rgba(99, 102, 241, 0.7); }
                .v3-applied-line-modify { background-color: rgba(191, 219, 254, 0.55); box-shadow: inset 0 -2px 0 rgba(59, 130, 246, 0.7); }
                .v3-applied-line-delete { background-color: rgba(254, 202, 202, 0.55); box-shadow: inset 0 -2px 0 rgba(239, 68, 68, 0.8); text-decoration: line-through; text-decoration-color: #dc2626; text-decoration-thickness: 2px; color:#7f1d1d; }
                .v3-applied-line-clar { background-color: rgba(165, 243, 252, 0.55); box-shadow: inset 0 -2px 0 rgba(6, 182, 212, 0.7); }
                .v3-applied-line-pulse { animation: v3-pulse-highlight 2s ease-out infinite; }

                /* 最終版に反映された修正案: 蛍光ペン風マーカー（カードギャラリー準拠の配色） */
                /* デフォルト = ADD（追記案・紫/インディゴ #6366f1） */
                .v3-final-flow-change {
                    background-color: rgba(199, 210, 254, 0.55) !important;
                    background-image: none !important;
                    border-radius: 2px !important;
                    padding: 2px 4px !important;
                    box-shadow: inset 0 -2px 0 rgba(99,102,241,0.7) !important;
                    box-decoration-break: clone !important;
                    -webkit-box-decoration-break: clone !important;
                }
                /* MODIFY = 青 #3b82f6 */
                .v3-final-flow-change[data-final-change-kind="modify"] {
                    background-color: rgba(191, 219, 254, 0.55) !important;
                    box-shadow: inset 0 -2px 0 rgba(59,130,246,0.7) !important;
                }
                /* DELETE = 赤 #ef4444 + 取消し線 */
                .v3-final-flow-change[data-final-change-kind="delete"] {
                    background-color: rgba(254, 202, 202, 0.55) !important;
                    box-shadow: inset 0 -2px 0 rgba(239,68,68,0.8) !important;
                    text-decoration: line-through !important;
                    text-decoration-color: #dc2626 !important;
                    text-decoration-thickness: 2px !important;
                    color: #7f1d1d !important;
                }
                /* CLAR = シアン #06b6d4（明確化） */
                .v3-final-flow-change[data-final-change-kind="clar"] {
                    background-color: rgba(165, 243, 252, 0.55) !important;
                    box-shadow: inset 0 -2px 0 rgba(6,182,212,0.7) !important;
                }
                /* プレビューオーバーレイ内ではマーカーを非表示（純粋な最終版見た目を維持） */
                #final-preview-overlay .v3-final-flow-change,
                #final-rendered-preview-overlay .v3-final-flow-change,
                #final-preview-overlay .v3-applied-change,
                #final-rendered-preview-overlay .v3-applied-change {
                    background-color: transparent !important;
                    background-image: none !important;
                    border-radius: 0 !important;
                    padding: 0 !important;
                    border-bottom: none !important;
                    text-decoration: none !important;
                    box-shadow: none !important;
                }

                .v3-editor-toolbar { position:sticky; top:0; z-index:100; display:flex; align-items:center; flex-wrap:wrap; gap:4px; padding:7px 9px; border:none; border-radius:12px; flex-shrink:0; background:#fff; color:#374151; width:100% !important; max-width:none !important; margin:0 auto 2px auto !important; box-sizing:border-box !important; box-shadow:0 4px 12px rgba(0,0,0,0.08); min-height:48px; overflow:visible; }
                .v3-editor-toolbar button { padding:5px 8px; border-radius:6px; font-size:12px; cursor:pointer; border:1px solid #e5e7eb; background:#f9fafb; color:#374151; white-space:nowrap; transition: all 0.2s; }
                .v3-editor-toolbar button:hover { background:#f3f4f6; border-color: #d1d5db; }
                .v3-editor-toolgroup { display:inline-flex; align-items:center; gap:2px; padding-right:5px; border-right:1px solid #e5e7eb; flex-shrink:0; }
                .v3-editor-toolbar-row { display:flex; align-items:center; gap:8px; width:100%; min-width:0; flex-wrap:wrap; }
                .v3-editor-main-tools { display:inline-flex; gap:4px; align-items:center; min-width:0; flex:1 1 620px; flex-wrap:wrap; justify-content:flex-start; overflow:visible; }
                .v3-editor-right-actions { display:inline-flex; align-items:center; gap:6px; margin-left:auto; flex-shrink:0; }
                .v3-editor-save-btn {
                    display:inline-flex;
                    align-items:center;
                    gap:6px;
                    padding:6px 14px !important;
                    border-radius:8px;
                    background:#0b2d62 !important;
                    border-color:#0b2d62 !important;
                    color:#fff !important;
                    font-weight:700;
                    box-shadow:0 4px 10px rgba(11,45,98,0.18);
                    transition: all 0.2s;
                }
                .v3-editor-save-btn:hover { background: #08234e !important; box-shadow: 0 6px 14px rgba(11,45,98,0.24); }
                .v3-editor-reparse-btn { position:relative; overflow:visible !important; }
                .v3-reparse-info { position:relative; display:inline-flex; align-items:center; color:#2563eb; font-size:12px; line-height:1; }
                .v3-reparse-tooltip {
                    position:absolute;
                    right:-8px;
                    top:calc(100% + 10px);
                    width:260px;
                    box-sizing:border-box;
                    padding:8px 10px;
                    border-radius:8px;
                    background:#0f172a;
                    color:#fff;
                    font-size:11px;
                    font-weight:600;
                    line-height:1.55;
                    text-align:left;
                    box-shadow:0 10px 28px rgba(15,23,42,.22);
                    opacity:0;
                    transform:translateY(-4px);
                    pointer-events:none;
                    transition:opacity .14s ease, transform .14s ease;
                    z-index:1000;
                    white-space:normal;
                }
                .v3-reparse-tooltip::before {
                    content:"";
                    position:absolute;
                    right:10px;
                    top:-5px;
                    width:10px;
                    height:10px;
                    background:#0f172a;
                    transform:rotate(45deg);
                }
                .v3-reparse-info:hover .v3-reparse-tooltip,
                .v3-reparse-info:focus-within .v3-reparse-tooltip {
                    opacity:1;
                    transform:translateY(0);
                }
                
                .v3-editor-icon-btn { width:28px; height:32px; padding:0 !important; display:inline-flex; align-items:center; justify-content:center; }
                .v3-editor-select { height:32px; border:1px solid #e5e7eb; border-radius:6px; background:#fff; padding:0 6px; color:#374151; font-size:12px; cursor: pointer; transition: all 0.2s; }
                .v3-editor-select:hover { border-color: #d1d5db; background: #f9fafb; }
                .v3-editor-select.is-style { width:70px; }
                .v3-editor-select.is-size { width:60px; }
                .v3-editor-color { width:30px; height:28px; padding:1px; border:1px solid #e5e7eb; border-radius:4px; background:#fff; cursor:pointer; }

                .v3-rich-editor-body:focus { box-shadow:inset 0 0 0 2px #bfdbfe; }
                .v3-rich-editor-body ul, .v3-rich-editor-body ol { padding-left:1.5em; margin:0.35em 0; }
            </style>
        `;
    },

    _buildFinalPreviewHtml(text) {
        const bodyHtml = this._renderDocumentPagesHtml(text, {
            editable: false,
            showRevisionMarks: false,
            markChangedLines: false,
            targetPageCount: this._getOriginalPageCount()
        });
        return `
            <!doctype html>
            <html>
            <head>
                <meta charset="utf-8">
                <style>
                    @page { size:A4; margin:0; }
                    body { margin:0; background:#fff; color:#222; }
                    .v3-editor-page { width:210mm; height:297mm; max-height:297mm; overflow:hidden; box-sizing:border-box; padding:25mm 15mm; page-break-after:always; break-after:page; font-family:'Noto Serif JP','Yu Mincho','MS Mincho',serif; font-size:10.5pt; line-height:1.8; color:#222; }
                    .v3-editor-block { white-space:pre-wrap; word-break:break-all; min-height:1.2em; }
                    .v3-editor-block.is-heading { font-weight:700; font-size:11pt; margin-top:14px; margin-bottom:4px; }
                    .v3-page-number { display:none; }
                </style>
            </head>
            <body>${this._renderFinalPreviewPagesHtml(text, this._editedHtml || this._getFinalDocumentHtml())}</body>
            </html>
        `;
    },

    _getFinalGenerationProfile(contract = this._contract || {}) {
        const fileName = String(contract.original_filename || contract.filename || this._currentFilename || '').toLowerCase();
        const sourceType = String(contract.source_type || contract.doc_type || this._currentRequest?.method || '').toLowerCase();
        const rawTextLength = String(contract.pdf_raw_text || contract.extracted_text || contract.original_content || '').trim().length;
        if (fileName.endsWith('.docx') || sourceType.includes('docx')) {
            return {
                level: 'high',
                label: 'DOCX: 高精度',
                message: 'Word原本の構造を使えるため、最終版PDFは原文レイアウトを保ちやすい形式です。'
            };
        }
        if (fileName.endsWith('.pdf') || sourceType.includes('pdf')) {
            if (rawTextLength < 80) {
                return {
                    level: 'ocr',
                    label: 'スキャンPDF: 要確認',
                    message: '画像/OCR由来のPDFは、最終版生成時に文字位置や改行の確認が必要です。'
                };
            }
            return {
                level: 'medium',
                label: 'PDF: 変換後生成',
                message: 'PDFは編集用データへ変換してから最終版PDFを生成します。保存後のPDFでレイアウトを確認してください。'
            };
        }
        return {
            level: 'plain',
            label: 'テキスト: 近似生成',
            message: 'テキストから最終版PDFを生成します。原本レイアウトではなく近似レイアウトです。'
        };
    },

    _renderFinalGenerationNotice() {
        const profile = this._getFinalGenerationProfile();
        const palette = {
            high: ['#ecfdf5', '#86efac', '#166534'],
            medium: ['#eff6ff', '#bfdbfe', '#1d4ed8'],
            ocr: ['#fff7ed', '#fed7aa', '#c2410c'],
            plain: ['#f8fafc', '#cbd5e1', '#475569']
        }[profile.level] || ['#f8fafc', '#cbd5e1', '#475569'];
        return `
            <div class="v3-final-generation-notice" style="display:flex;align-items:flex-start;gap:10px;margin:0 auto 10px auto;width:900px;max-width:calc(100% - 32px);box-sizing:border-box;background:${palette[0]};border:1px solid ${palette[1]};border-radius:10px;padding:10px 14px;color:${palette[2]};font-size:12px;line-height:1.7;">
                <i class="fa-solid fa-circle-info" style="margin-top:3px;"></i>
                <div><strong>${this.escapeHtml(profile.label)}</strong><br>${this.escapeHtml(profile.message)}</div>
            </div>
        `;
    },

    _normalizeForLayoutComparison(text) {
        return this._normalizeFinalLayoutText(text)
            .replace(/\s+/g, '')
            .trim();
    },

    _hasManualOnlyFinalChanges(finalContent = this._getFinalDocumentText()) {
        return this._hasUntrackedFinalTextChanges(finalContent);
    },

    _hasUntrackedFinalTextChanges(finalContent = this._getFinalDocumentText()) {
        if (!this._isOriginalDocxContract()) return false;
        const original = this._normalizeForLayoutComparison(this._getOriginalDocumentText());
        const next = this._normalizeForLayoutComparison(finalContent);
        if (!original || !next || original === next) return false;

        const revisions = this._buildFinalDocxRevisions(finalContent);
        if (!revisions.length) return true;

        const changes = this._getActiveSortedAiChanges();
        let expectedText = this._getOriginalDocumentText();
        revisions
            .map(revision => Number(revision.index))
            .filter(Number.isInteger)
            .sort((a, b) => a - b)
            .forEach(index => {
                const change = changes[index];
                if (change) expectedText = this._applyChangeToText(expectedText, change, index);
            });

        return this._normalizeForLayoutComparison(expectedText) !== next;
    },

    _canGenerateSourceLayoutFinal(finalContent = this._getFinalDocumentText()) {
        return Boolean(
            this._isOriginalDocxContract()
            && !this._hasManualOnlyFinalChanges(finalContent)
        );
    },

    _renderFinalLayoutGuard({
        title = '原本レイアウトPDFを作成できませんでした',
        message = '',
        originalPageCount = null,
        generatedPageCount = null
    } = {}) {
        this._finalLayoutGuardActive = true;
        const editLayer = document.getElementById('v3-edit-layer');
        if (!editLayer) return;

        const pdfLayer = document.getElementById('pdf-pages-container');
        const docxLayer = document.getElementById('sign-viewer-docx-pages');
        const revisedLayer = document.getElementById('v3-revised-layer');
        if (pdfLayer) pdfLayer.style.display = 'none';
        if (docxLayer) docxLayer.style.display = 'none';
        if (revisedLayer) revisedLayer.style.display = 'none';
        editLayer.style.display = 'block';

        const details = [
            originalPageCount ? `原本 ${originalPageCount}ページ` : '',
            generatedPageCount ? `最終版 ${generatedPageCount}ページ` : ''
        ].filter(Boolean).join(' / ');

        editLayer.innerHTML = `
            ${this._getDocumentLayoutCss()}
            <div class="v3-document-scroll-area" style="min-height:100%;display:flex;align-items:center;justify-content:center;padding:48px 24px 96px;box-sizing:border-box;">
                <div style="width:min(720px,100%);background:#fff;border:1px solid #fecaca;border-radius:12px;box-shadow:0 12px 36px rgba(15,23,42,0.10);padding:28px;box-sizing:border-box;">
                    <div style="display:flex;align-items:flex-start;gap:14px;">
                        <div style="width:36px;height:36px;border-radius:999px;background:#fef2f2;color:#dc2626;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                            <i class="fa-solid fa-triangle-exclamation"></i>
                        </div>
                        <div style="min-width:0;flex:1;">
                            <h2 style="margin:0 0 10px 0;font-size:18px;line-height:1.5;color:#0f172a;">${this.escapeHtml(title)}</h2>
                            <p style="margin:0;color:#475569;font-size:13px;line-height:1.8;">${this.escapeHtml(message || '原本DOCXに修正を反映したPDFが、原本と同じページ構成で作成できませんでした。')}</p>
                            ${details ? `<div style="margin-top:12px;display:inline-flex;align-items:center;gap:8px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:999px;padding:5px 12px;font-size:12px;font-weight:700;color:#334155;">${this.escapeHtml(details)}</div>` : ''}
                            <div style="display:flex;gap:10px;margin-top:22px;flex-wrap:wrap;justify-content:flex-end;">
                                <button onclick="window.signViewer.recoverFinalLayoutGuard()" style="display:inline-flex;align-items:center;gap:6px;background:#fff;color:#0b2d62;border:1px solid #bfdbfe;border-radius:8px;padding:8px 14px;font-size:13px;font-weight:800;cursor:pointer;">
                                    <i class="fa-regular fa-file-lines"></i> 原本を確認
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
        this.hideViewerLoader();
        this.renderDashboardUI();
    },

    async recoverFinalLayoutGuard() {
        this._finalLayoutGuardActive = false;
        const editLayer = document.getElementById('v3-edit-layer');
        if (editLayer) {
            editLayer.style.display = 'none';
            editLayer.innerHTML = '';
        }
        await this._renderRecoveredFinalFromOriginal({ forceReload: true });
    },

    async _renderRecoveredFinalFromOriginal({ forceReload = false } = {}) {
        this._finalLayoutGuardActive = false;
        this._viewMode = 'final';
        const pdfLayer = document.getElementById('pdf-pages-container');
        const docxLayer = document.getElementById('sign-viewer-docx-pages');
        if (forceReload && pdfLayer) {
            pdfLayer.style.display = 'none';
            pdfLayer.replaceChildren();
            delete pdfLayer.dataset.renderedSource;
            delete pdfLayer.dataset.renderedZoom;
        }
        if (forceReload && docxLayer) {
            docxLayer.style.display = 'none';
            docxLayer.replaceChildren();
        }
        if (forceReload) {
            this._pdfDoc = null;
            this._currentPdfUrl = null;
            this._viewInitialized = false;
        }
        this.hideViewerLoader();

        try {
            const contractId = this._currentRequest?.contract_id || this._currentRequest?.contractId || this._contractId;
            if (contractId && this._app && typeof this._app.getDocxFromIDB === 'function') {
                await this._app.getDocxFromIDB(contractId);
            }
            if (contractId && this._app && typeof this._app.getPdfFromIDB === 'function') {
                await this._app.getPdfFromIDB(contractId);
            }
            const rendered = await this.renderOriginalForContract(
                this._app,
                this._contract,
                contractId,
                { preferOriginalDocx: true }
            );
            if (!rendered) {
                Notify.warning('取り込んだ原本資料を表示できませんでした。保存済みファイルまたは抽出テキストを確認してください。');
                return false;
            }
            this._finalRecoveredFromOriginal = true;
            this._lastRecoveredFinalContent = this._getFinalDocumentText();
        } catch (error) {
            console.warn('[SignViewer] Original reload after final guard failed:', error);
            Notify.warning('取り込んだ原本資料の再読み込みに失敗しました。');
            return false;
        }

        this._viewMode = 'final';
        this._setOriginalViewerBottomSpace(true);
        this.renderDashboardUI();
        return true;
    },

    async _generateValidatedFinalDocxPdf(finalContent = this._getFinalDocumentText()) {
        const revisions = this._buildFinalDocxRevisions(finalContent);
        const generated = revisions.length > 0
            ? await this._generateFinalDocxPdf(finalContent)
            : await this._generateOriginalDocxPdf();
        if (!generated?.blob) {
            return {
                blob: null,
                reason: generated?.reason || 'DOCX原本ベースの最終版PDFを作成できませんでした。'
            };
        }

        await this._ensureOriginalPageCount();
        const originalPageCount = this._getOriginalPageCount();
        const generatedPageCount = await this._getPdfBlobPageCount(generated.blob);
        if (originalPageCount && generatedPageCount && originalPageCount !== generatedPageCount) {
            return {
                blob: generated.blob,
                reason: '反映後の最終版は原本とページ数が変わっています。',
                originalPageCount,
                generatedPageCount
            };
        }

        return {
            blob: generated.blob,
            reason: '',
            originalPageCount,
            generatedPageCount
        };
    },

    async _generateFinalPdf(text) {
        const serviceUrl = (typeof window !== 'undefined' && window.__DOCX_PDF_SERVICE_URL__)
            ? String(window.__DOCX_PDF_SERVICE_URL__).replace(/\/$/, '')
            : '';
        if (!serviceUrl) return await this._generateFinalPdfInBrowser(text);

        const html = this._buildFinalPreviewHtml(text);
        try {
            const resp = await fetch(`${serviceUrl}/api/convert/html-to-pdf`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ html })
            });
            if (resp.ok) return await resp.blob();
            console.warn('[SignViewer] Server HTML-to-PDF failed, using browser PDF fallback:', resp.status);
        } catch (error) {
            console.warn('[SignViewer] Server HTML-to-PDF unavailable, using browser PDF fallback:', error);
        }
        return await this._generateFinalPdfInBrowser(text);
    },

    async _ensureBrowserPdfLibraries() {
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
        return Boolean(window.jspdf?.jsPDF && window.html2canvas);
    },

    async _generateFinalPdfInBrowser(text) {
        if (!(await this._ensureBrowserPdfLibraries())) return null;

        const html = this._buildFinalPreviewHtml(text);
        const parsed = new DOMParser().parseFromString(html, 'text/html');
        const styleHtml = Array.from(parsed.querySelectorAll('style')).map(style => style.outerHTML).join('\n');
        const host = document.createElement('div');
        host.setAttribute('aria-hidden', 'true');
        host.style.cssText = [
            'position:fixed',
            'left:-10000px',
            'top:0',
            'width:210mm',
            'background:#fff',
            'z-index:-1',
            'pointer-events:none'
        ].join(';');
        host.innerHTML = `${styleHtml}<div class="v3-browser-pdf-root">${parsed.body?.innerHTML || ''}</div>`;
        document.body.appendChild(host);

        try {
            if (document.fonts?.ready) await document.fonts.ready.catch(() => {});
            const pages = Array.from(host.querySelectorAll('.v3-editor-page'));
            if (!pages.length) return null;

            const { jsPDF } = window.jspdf;
            const pdf = new jsPDF('p', 'mm', 'a4');
            for (let i = 0; i < pages.length; i += 1) {
                const page = pages[i];
                page.style.boxShadow = 'none';
                page.style.margin = '0';
                const canvas = await window.html2canvas(page, {
                    scale: 2,
                    useCORS: true,
                    logging: false,
                    backgroundColor: '#ffffff',
                    windowWidth: page.scrollWidth,
                    windowHeight: page.scrollHeight
                });
                if (i > 0) pdf.addPage();
                pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, 210, 297, undefined, 'FAST');
            }
            return pdf.output('blob');
        } catch (error) {
            console.error('[SignViewer] Browser PDF fallback failed:', error);
            return null;
        } finally {
            host.remove();
        }
    },

    async renderHandEditMode(container, contentOverride = null) {
        this._viewMode = 'edit';
        this._scale = 1.0;
        this._offsetX = 0;
        this._offsetY = 0;
        const contract = this._contract || {};

        // 契約書IDが変わった場合はキャッシュをクリア
        if (this._docxEditorContractId !== contract.id) {
            this._docxEditorPageElements = null;
            this._docxEditorContractId = contract.id;
        }

        // docx-preview editor pages should not be re-rendered while editing;
        // doing so would replace user edits with the cached original DOCX DOM.
        const existingEditorScroll = document.querySelector('#v3-edit-layer #v3-editor-scroll');
        const existingEditorToolbar = document.querySelector('#v3-edit-layer .v3-editor-toolbar');
        const existingDocxEditorPage = existingEditorScroll?.querySelector('.docx-editor-page');
        if (
            this._docxEditorPageElements
            && this._viewMode === 'edit'
            && existingEditorScroll
            && existingEditorToolbar
            && existingDocxEditorPage
            && this._shouldUseSourceDocxFinalEditor()
            && !contentOverride
        ) {
            this._editedContent = this._collectEditorContent();
            this._editedHtml = this._collectEditorHtml();
            this._syncUndoRedoButtons();
            this._centerDocumentLayers();
            this._scheduleToolbarCenterAlignment();
            return;
        }

        const originalText = this._getOriginalDocumentText();
        const initialContent = contentOverride !== null && contentOverride !== undefined
            ? this._materializeAppliedFinalContent(this._normalizeFinalLayoutText(String(contentOverride)))
            : this._materializeAppliedFinalContent(this._getFinalDocumentText());
        console.log('[FINAL INPUT]', {
            textLength: initialContent.length,
            lineCount: initialContent.split(/\n/).length,
            previewStart: initialContent.slice(0, 100),
            previewEnd: initialContent.slice(-100)
        });

        const originalPageCount = this._getOriginalPageCount();

        if (!this._editHistory) {
            this._editHistory = [initialContent];
            this._editHistoryIndex = 0;
            this._lastSavedContent = initialContent;
        }

        const isUnsaved = this._editedContent !== undefined && this._editedContent !== this._lastSavedContent;
        const canUndo = this._canUndoEdit();
        const canRedo = this._canRedoEdit();
        const aiChangeCount = this._getSortedAiChanges().length;
        const appliedIndexes = this._getAppliedChangeIndexesForText(initialContent);
        this._appliedChanges = appliedIndexes;
        const appliedCount = appliedIndexes.size;

        const editLayer = document.getElementById('v3-edit-layer');
        if (!editLayer) return;
        this._setFinalActionBarVisible(false);
        const editorFontSize = this._getFinalEditorFontSize();
        const editorLineHeight = this._getFinalEditorLineHeight();
        const surfaceHtml = await this._renderFinalEditorSurfaceHtml(initialContent, null);
        this._lastRenderedContent = initialContent;
        this._lastSavedContent = initialContent;
        this._editedContent = initialContent;

        editLayer.innerHTML = `
            ${this._getDocumentLayoutCss()}
            <div style="width:100%;height:100%;display:flex;flex-direction:column;overflow:visible !important;--v3-final-line-height:${editorLineHeight};">
                <div class="v3-editor-toolbar">
                    <div class="v3-editor-toolbar-row">
                        <div class="v3-editor-main-tools">
                        <span class="v3-editor-toolgroup">
                            <button class="v3-editor-icon-btn" data-editor-action="undo" onclick="window.signViewer._undoEdit()" style="opacity:${canUndo ? '1' : '0.4'};" title="元に戻す"><i class="fa-solid fa-rotate-left"></i></button>
                            <button class="v3-editor-icon-btn" data-editor-action="redo" onclick="window.signViewer._redoEdit()" style="opacity:${canRedo ? '1' : '0.4'};" title="やり直す"><i class="fa-solid fa-rotate-right"></i></button>
                        </span>
                        <span class="v3-editor-toolgroup">
                            <select class="v3-editor-select is-style" onchange="window.signViewer._setEditorBlockFormat(this.value)" title="段落スタイル">
                                <option value="P">標準</option><option value="H1">見出し1</option><option value="H2">見出し2</option>
                            </select>
                            <select class="v3-editor-select is-size" onchange="window.signViewer._setSelectedFontSize(this.value)" title="文字サイズ">${[12,14,16,18,20,22,24,28,32].map(size => `<option value="${size}" ${editorFontSize === size ? 'selected' : ''}>${size}px</option>`).join('')}</select>
                        </span>
                        <span class="v3-editor-toolgroup">
                            <button class="v3-editor-icon-btn" onclick="window.signViewer._runEditorCommand('bold')" title="太字"><i class="fa-solid fa-bold"></i></button>
                            <button class="v3-editor-icon-btn" onclick="window.signViewer._runEditorCommand('italic')" title="斜体"><i class="fa-solid fa-italic"></i></button>
                            <button class="v3-editor-icon-btn" onclick="window.signViewer._runEditorCommand('underline')" title="下線"><i class="fa-solid fa-underline"></i></button>
                            <button class="v3-editor-icon-btn" onclick="window.signViewer._runEditorCommand('strikeThrough')" title="取り消し線"><i class="fa-solid fa-strikethrough"></i></button>
                        </span>
                        <span class="v3-editor-toolgroup">
                            <button class="v3-editor-icon-btn" onclick="window.signViewer._runEditorCommand('justifyLeft')" title="左揃え"><i class="fa-solid fa-align-left"></i></button>
                            <button class="v3-editor-icon-btn" onclick="window.signViewer._runEditorCommand('justifyCenter')" title="中央揃え"><i class="fa-solid fa-align-center"></i></button>
                            <button class="v3-editor-icon-btn" onclick="window.signViewer._runEditorCommand('justifyRight')" title="右揃え"><i class="fa-solid fa-align-right"></i></button>
                            <button class="v3-editor-icon-btn" onclick="window.signViewer._runEditorCommand('justifyFull')" title="両端揃え"><i class="fa-solid fa-align-justify"></i></button>
                        </span>
                        <span class="v3-editor-toolgroup">
                            <button class="v3-editor-icon-btn" onclick="window.signViewer._runEditorCommand('insertUnorderedList')" title="箇条書き"><i class="fa-solid fa-list-ul"></i></button>
                            <button class="v3-editor-icon-btn" onclick="window.signViewer._runEditorCommand('insertOrderedList')" title="段落番号"><i class="fa-solid fa-list-ol"></i></button>
                            <button class="v3-editor-icon-btn" onclick="window.signViewer._runEditorCommand('outdent')" title="インデントを減らす"><i class="fa-solid fa-outdent"></i></button>
                            <button class="v3-editor-icon-btn" onclick="window.signViewer._runEditorCommand('indent')" title="インデント"><i class="fa-solid fa-indent"></i></button>
                        </span>
                        <span class="v3-editor-toolgroup">
                            <button class="v3-editor-icon-btn" onclick="window.signViewer._addFinalEditorPage()" title="ページを追加"><i class="fa-solid fa-plus"></i></button>
                            <button class="v3-editor-icon-btn" onclick="window.signViewer._deleteCurrentFinalEditorPage()" title="現在の追加ページを削除"><i class="fa-solid fa-trash"></i></button>
                            <button class="v3-editor-icon-btn" onclick="window.signViewer._enableFreeTextMode()" title="任意位置に文字を追加"><i class="fa-solid fa-i-cursor"></i></button>
                        </span>
                        <span class="v3-editor-toolgroup">
                            <input class="v3-editor-color" type="color" value="#222222" onchange="window.signViewer._runEditorCommand('foreColor', this.value)" title="文字色">
                            <input class="v3-editor-color" type="color" value="#fff3bf" onchange="window.signViewer._runEditorCommand('hiliteColor', this.value)" title="ハイライト">
                            <button class="v3-editor-icon-btn" onclick="window.signViewer._runEditorCommand('removeFormat')" title="書式をクリア"><i class="fa-solid fa-eraser"></i></button>
                        </span>
                        </div>
                        <div class="v3-editor-right-actions">
                        <button class="v3-editor-reparse-btn" onclick="window.signViewer._repairFinalEditorLayout()" style="display:inline-flex;align-items:center;gap:6px;background:#fff;color:#0b2d62;border:1px solid #dbeafe;font-weight:700;">
                            <i class="fa-solid fa-rotate"></i> 再解析
                            <span class="v3-reparse-info">
                                <i class="fa-solid fa-circle-info"></i>
                                <span class="v3-reparse-tooltip">レイアウトが崩れる場合はこちらも使えます。AI解析は実行しないため、AI回数は消費しません。</span>
                            </span>
                        </button>
                        <button onclick="window.signViewer._saveHandEdit({ showFinal: true })" class="v3-editor-save-btn">
                            <i class="fa-solid fa-floppy-disk"></i> 保存する
                        </button>
                        </div>
                    </div>
                </div>
                <!-- _renderFinalGenerationNotice removed -->
                <div class="v3-document-scroll-area" id="v3-editor-scroll" style="overflow:auto !important; height:auto !important; max-height:none !important;">
                    <div id="v3-editor-content-container" class="v3-document-page-stack" style="display:flex; flex-direction:column; align-items:center; gap:24px; overflow:visible !important; width:100%; box-sizing:border-box; padding:24px 0;">
                        ${surfaceHtml}
                    </div>
                </div>
            </div>
        `;

        console.log('[FINAL PAGE DOM]', {
            domPageCount: document.querySelectorAll('.final-contract-page').length,
            htmlLength: editLayer.innerHTML.length
        });

        if (Array.isArray(this._docxEditorPageElements)) {
            this._docxEditorPageElements.forEach((pageEl, idx) => {
                const mount = document.querySelector(`.docx-preview-mode[data-docx-page-mount="${idx}"]`)
                    || document.querySelectorAll('.docx-preview-mode')[idx];
                if (mount) {
                    mount.innerHTML = '';
                    mount.appendChild(pageEl);
                }
            });
        }

        setTimeout(() => {
            console.log('[FINAL PAGE DOM AFTER 100MS]', {
                domPageCount: document.querySelectorAll('.final-contract-page').length,
                visiblePageCount: [...document.querySelectorAll('.final-contract-page')]
                    .filter(el => el.offsetHeight > 0 && getComputedStyle(el).display !== 'none').length
            });
        }, 100);

        this.renderDashboardUI();

        const scrollArea = document.getElementById('v3-editor-scroll');
        if (scrollArea) {
            scrollArea.style.cursor = 'text';
            scrollArea.style.userSelect = 'text';
            scrollArea.style.webkitUserSelect = 'text';
        }
        this._bindFinalEditorToolbar();
        this._bindFinalPageSyncObserver();
        this._applyZoom();
        this._bindScrollSync();
        if (this._editHistory && this._editHistoryIndex >= 0 && typeof this._editHistory[this._editHistoryIndex] === 'string') {
            const activeText = this._editHistory[this._editHistoryIndex];
            if (activeText === initialContent) this._editHistory[this._editHistoryIndex] = this._createEditHistorySnapshot(initialContent);
        }
    },

    _bindScrollSync() {
        const scrollArea = document.getElementById('v3-editor-scroll');
        if (!scrollArea || scrollArea._scrollSyncBound) return;
        scrollArea._scrollSyncBound = true;

        scrollArea.addEventListener('scroll', () => {
            if (this._suppressEditorScrollSync) return;
            const pages = scrollArea.querySelectorAll('.v3-editor-page');
            if (!pages.length) return;

            let bestPage = this._activePage;
            let minDiff = Infinity;
            const containerTop = scrollArea.getBoundingClientRect().top + 150;

            pages.forEach(p => {
                const rect = p.getBoundingClientRect();
                const diff = Math.abs(rect.top - containerTop);
                if (diff < minDiff) {
                    minDiff = diff;
                    bestPage = parseInt(p.dataset.page) || 1;
                }
            });

            if (bestPage !== this._activePage) {
                this._activePage = bestPage;
                this.renderDashboardUI();
                // Update thumbnails if app exists
                if (this._app && typeof this._app.updateThumbnailHighlights === 'function') {
                    this._app.updateThumbnailHighlights(this._activePage);
                }
            }
        }, { passive: true });
    },

    _buildFinalDocxRevisions(finalContent = this._getFinalDocumentText()) {
        const changes = this._getActiveSortedAiChanges();
        // Explicit empty applied state overrides the old recovery union: new Set([...storedApplied, ...detectedApplied])
        const applied = this._getAppliedChangeIndexesForText(finalContent);

        return Array.from(applied).map(index => {
            const change = changes[index];
            if (!change) return null;
            const defaultText = this._getDefaultAppliedTextForChange(change);
            const overlayText = this._getFinalOverlayTextForChange(change, index);
            const text = String(finalContent || '').includes(overlayText)
                ? overlayText
                : (String(finalContent || '').includes(defaultText) ? defaultText : overlayText || defaultText);
            return {
                index,
                anchor: this._findArticleForChange(change) || this._getChangeDisplaySection(change, index),
                text,
                oldText: this._getChangeOldText(change),
                type: this._getChangeOldText(change) ? 'replace' : 'insert'
            };
        }).filter(item => item && String(item.text || '').trim());
    },

    _changeLooksAppliedInText(text, change, index = 0) {
        const source = String(text || '');
        const oldText = this._getChangeOldText(change);
        const newText = this._buildLegalInsertionText(change);
        const isDeletion = String(change?.type || '').toUpperCase() === 'DELETE'
            || (Boolean(oldText) && !newText);
        if (isDeletion) {
            return oldText && !this._textContainsCandidate(source, oldText);
        }
        const overlayText = this._getFinalOverlayTextForChange(change, index);
        return Boolean(
            (newText && this._textContainsCandidate(source, newText))
            || (overlayText && this._textContainsCandidate(source, overlayText))
        );
    },

    _materializeAppliedFinalContent(sourceText = this._getFinalDocumentText()) {
        let finalContent = String(sourceText || '');
        const changes = this._getActiveSortedAiChanges();
        const applied = this._getAppliedChangeIndexesForText(finalContent);

        if (applied.size > 0 && changes.length) {
            Array.from(applied)
                .map(Number)
                .filter(Number.isInteger)
                .sort((a, b) => a - b)
                .forEach(index => {
                    const change = changes[index];
                    if (!change || this._changeLooksAppliedInText(finalContent, change, index)) return;
                    finalContent = this._applyChangeToText(finalContent, change, index);
                });
        }

        return String(this._buildCleanFinalContent(finalContent) || '');
    },

    _getCommercialFinalContent() {
        const editorVisible = this._isFinalEditorVisible();
        const cleanContent = this._materializeAppliedFinalContent(
            editorVisible ? this._collectEditorContent() : this._getFinalDocumentText()
        );
        if (editorVisible) {
            this._editedContent = cleanContent;
            this._editedHtml = this._collectEditorHtml();
        }
        return String(cleanContent || '');
    },

    async _getOriginalDocxFileForFinal() {
        const contractId = this._currentRequest?.contract_id || this._currentRequest?.contractId || this._contract?.id;
        // DOCX (=ZIP) magic 'PK\x03\x04' などのチェック。HTMLや404レスポンスが
        // 誤って docx として cache されると Word が「破損」エラーを出すため必須。
        const isValidDocxBlob = async (blob) => {
            if (!(blob instanceof Blob) || blob.size < 4) return false;
            try {
                const bytes = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
                return bytes[0] === 0x50 && bytes[1] === 0x4B && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07);
            } catch (_) { return false; }
        };

        let originalFile = this._app && typeof this._app.getDocxFromIDB === 'function'
            ? await this._app.getDocxFromIDB(contractId)
            : null;
        // IDB cache 検証: 過去に壊れたデータがcacheされている場合は捨てる
        if (originalFile && !(await isValidDocxBlob(originalFile))) {
            console.warn('[SignViewer] IDB cache for DOCX is not a valid ZIP. Ignoring and re-fetching.');
            originalFile = null;
        }

        if (!(originalFile instanceof Blob)) {
            const originalUrl = this._contract?.original_file_url || this._contract?.original_file_path;
            if (originalUrl) {
                try {
                    let fullUrl = resolveBackendAssetUrl(originalUrl);
                    // URL が相対(http(s)で始まらない)場合は backend URL を prefix
                    if (!/^https?:\/\//i.test(fullUrl)) {
                        const base = (typeof window !== 'undefined' && window.__DOCX_PDF_SERVICE_URL__)
                            ? String(window.__DOCX_PDF_SERVICE_URL__).replace(/\/$/, '')
                            : '';
                        if (base) {
                            fullUrl = base + (fullUrl.startsWith('/') ? fullUrl : '/' + fullUrl);
                        }
                    }
                    const token = await this._getIdTokenSafe();
                    const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
                    const resp = await fetch(fullUrl, { headers });
                    if (resp.ok) {
                        const blob = await resp.blob();
                        // ZIP magic 検証: 失敗時は採用せず次の fallback へ
                        if (await isValidDocxBlob(blob)) {
                            const fileName = this._contract?.original_filename || 'original.docx';
                            originalFile = new File([blob], fileName, { type: blob.type || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
                            if (this._app && typeof this._app._saveDocxToIDB === 'function') {
                                await this._app._saveDocxToIDB(contractId, originalFile).catch(e => console.warn('[SignViewer] IDB cache failed:', e));
                            }
                        } else {
                            console.warn('[SignViewer] Fetched original file is not a valid DOCX (ZIP magic missing):', fullUrl);
                        }
                    }
                } catch (e) {
                    console.error('[SignViewer] Server fallback fetch failed:', e);
                }
            }
        }

        if (!(originalFile instanceof Blob) && contractId) {
            try {
                const token = await this._getIdTokenSafe();
                const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
                const response = await fetch(toApiUrl(`/api/contracts/${encodeURIComponent(this._getSanitizedContractId(contractId))}/original-file`), { headers });
                if (response.ok) {
                    const blob = await response.blob();
                    const fileName = this._contract?.original_filename || 'original.docx';
                    originalFile = new File([blob], fileName, { type: blob.type || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
                    if (this._app && typeof this._app._saveDocxToIDB === 'function') {
                        await this._app._saveDocxToIDB(contractId, originalFile).catch(e => console.warn('[SignViewer] IDB cache failed:', e));
                    }
                }
            } catch (e) {
                console.warn('[SignViewer] original-file fallback fetch failed:', e);
            }
        }

        return originalFile instanceof Blob ? originalFile : null;
    },

    _isOriginalDocxContract() {
        const c = this._contract || {};
        const r = this._currentRequest || {};
        const source = [
            c.source_type,
            c.doc_type,
            c.document_type,
            c.original_filename,
            c.original_file_name,
            c.filename,
            c.file_name,
            c.original_file_url,
            c.original_file_path,
            c.originalFileUrl,
            c.originalFilePath,
            c.docx_url,
            c.docxUrl,
            c.asset_path,
            c.assetPath,
            c.storage_path,
            c.storagePath,
            r.original_filename,
            r.original_file_url,
            r.original_file_path,
            r.docx_url,
            r.asset_path,
            r.storage_path,
            this._originalFileName
        ].filter(Boolean).join(' ');
        return /\bDOCX\b/i.test(source) || isDocxFileName(source);
    },

    async _generateOriginalDocxPdf() {
        const serviceUrl = (typeof window !== 'undefined' && window.__DOCX_PDF_SERVICE_URL__)
            ? String(window.__DOCX_PDF_SERVICE_URL__).replace(/\/$/, '')
            : '';
        if (!serviceUrl) return { blob: null, reason: 'DOCX/PDF変換サービスが設定されていません。' };

        const originalFile = await this._getOriginalDocxFileForFinal();
        if (!(originalFile instanceof Blob)) return { blob: null, reason: '元DOCXがローカルキャッシュにありません。DOCXを再取り込みしてから保存してください。' };

        const formData = new FormData();
        formData.append('file', originalFile, originalFile.name || 'original.docx');

        const resp = await fetch(`${serviceUrl}/api/convert/docx-to-pdf`, {
            method: 'POST',
            body: formData,
            signal: AbortSignal.timeout(120_000)
        });
        if (!resp.ok) return { blob: null, reason: `DOCX原本PDF生成APIが失敗しました（${resp.status}）。` };
        const contentType = resp.headers.get('content-type') || '';
        if (!contentType.includes('application/pdf')) return { blob: null, reason: 'DOCX原本PDF生成APIがPDFを返しませんでした。' };
        return { blob: await resp.blob(), reason: '' };
    },

    async _generateFinalDocxPdf(finalContent = this._getFinalDocumentText()) {
        const serviceUrl = (typeof window !== 'undefined' && window.__DOCX_PDF_SERVICE_URL__)
            ? String(window.__DOCX_PDF_SERVICE_URL__).replace(/\/$/, '')
            : '';
        if (!serviceUrl) return { blob: null, reason: 'DOCX/PDF変換サービスが設定されていません。' };

        const originalFile = await this._getOriginalDocxFileForFinal();
        if (!(originalFile instanceof Blob)) return { blob: null, reason: '元DOCXがローカルキャッシュにありません。DOCXを再取り込みしてから保存してください。' };

        const revisions = this._buildFinalDocxRevisions(finalContent);
        if (!revisions.length) return { blob: null, reason: 'DOCXへ反映する修正案が見つかりません。修正案を反映してから保存してください。' };

        const formData = new FormData();
        formData.append('file', originalFile, originalFile.name || 'original.docx');
        formData.append('revisions', JSON.stringify(revisions));

        const resp = await fetch(`${serviceUrl}/api/convert/final-docx-to-pdf`, {
            method: 'POST',
            body: formData,
            signal: AbortSignal.timeout(120_000)
        });
        if (!resp.ok) return { blob: null, reason: `DOCX最終版生成APIが失敗しました（${resp.status}）。` };
        const contentType = resp.headers.get('content-type') || '';
        if (!contentType.includes('application/pdf')) return { blob: null, reason: 'DOCX最終版生成APIがPDFを返しませんでした。' };
        return { blob: await resp.blob(), reason: '' };
    },



    _focusFinalEditor() {
                const activeEditor = document.activeElement?.closest?.('#v3-editor-scroll .v3-rich-editor-body, #v3-editor-scroll .v3-editor-block, #v3-editor-scroll p, #v3-editor-scroll li, #v3-editor-scroll td, #v3-editor-scroll th, #v3-editor-scroll h1, #v3-editor-scroll h2, #v3-editor-scroll h3, #v3-editor-scroll h4, #v3-editor-scroll h5, #v3-editor-scroll h6');
        if (activeEditor) return activeEditor;
        const editor = document.querySelector('#v3-editor-scroll .v3-rich-editor-body[contenteditable="true"], #v3-editor-scroll .v3-editor-block, #v3-editor-scroll p, #v3-editor-scroll li, #v3-editor-scroll td, #v3-editor-scroll th');
        if (editor && document.activeElement !== editor) editor.focus();
        if (editor) editor.style.cursor = 'text';
        return editor;
    },

    _bindFinalEditorToolbar() {
        const toolbar = document.querySelector('.v3-editor-toolbar');
        if (toolbar) {
            this._ensureLegalEditSafetyTools(toolbar);
            toolbar.addEventListener('mousedown', () => this._saveEditorSelection(), true);
            toolbar.querySelectorAll('button').forEach(button => {
                button.addEventListener('mousedown', event => {
                    this._saveEditorSelection();
                    event.preventDefault();
                });
            });
            toolbar.querySelectorAll('select, input').forEach(control => {
                control.addEventListener('mousedown', () => this._saveEditorSelection());
                control.addEventListener('focus', () => this._saveEditorSelection());
                control.addEventListener('input', () => this._saveEditorSelection());
            });
        }
        const scrollArea = document.getElementById('v3-editor-scroll');
        if (scrollArea && !scrollArea._wordLikeKeyboardBound) {
            scrollArea._wordLikeKeyboardBound = true;
            scrollArea.addEventListener('keydown', event => this._onFinalEditorContainerKeyDown(event), true);
            scrollArea.addEventListener('mouseup', () => this._saveEditorSelection(), true);
            this._bindFinalEditorMouseSelection(scrollArea);
        }
        document.querySelectorAll('#v3-editor-scroll .v3-rich-editor-body').forEach(editor => {
            editor.style.cursor = 'text';
            editor.addEventListener('keyup', () => this._saveEditorSelection());
            editor.addEventListener('mouseup', () => this._saveEditorSelection());
            editor.addEventListener('focus', () => this._saveEditorSelection());
            editor.addEventListener('focusout', () => this._onRichEditorBlur(editor));
            editor.addEventListener('paste', event => this._onRichEditorPaste(event, editor));
            editor.addEventListener('compositionstart', event => this._onRichEditorCompositionStart(event));
            editor.addEventListener('compositionend', event => this._onRichEditorCompositionEnd(event));
        });
        this._applyLegalEditViewOptions();
    },

    _ensureLegalEditSafetyTools(toolbar) {
        if (!toolbar || toolbar.querySelector('[data-legal-edit-tools="true"]')) return;
        this._ensureLegalEditSafetyStyles();
        const host = toolbar.querySelector('.v3-editor-main-tools');
        if (!host) return;
        const group = document.createElement('span');
        group.className = 'v3-editor-toolgroup v3-legal-edit-controls';
        group.dataset.legalEditTools = 'true';
        if (!this._finalEditorLineHeight) this._finalEditorLineHeight = this._getFinalEditorLineHeight();
        if (!this._finalEditorMarginMode) this._finalEditorMarginMode = 'standard';
        group.innerHTML = `
            <select class="v3-editor-select v3-legal-line-height-select" onchange="window.signViewer._setFinalEditorLineHeight(this.value)" title="行間">
                ${['0.8', '1.0', '1.2', '1.5', '1.8', '2.0'].map(v => `<option value="${v}" ${this._getFinalEditorLineHeight() === v ? 'selected' : ''}>行間 ${v}</option>`).join('')}
            </select>
            <select class="v3-editor-select v3-legal-margin-select" onchange="window.signViewer._setFinalEditorMarginMode(this.value)" title="余白">
                <option value="standard" ${this._finalEditorMarginMode === 'standard' ? 'selected' : ''}>標準</option>
                <option value="wide" ${this._finalEditorMarginMode === 'wide' ? 'selected' : ''}>広め</option>
                <option value="print" ${this._finalEditorMarginMode === 'print' ? 'selected' : ''}>印刷重視</option>
                <option value="signature" ${this._finalEditorMarginMode === 'signature' ? 'selected' : ''}>署名重視</option>
            </select>
        `;
        host.appendChild(group);
    },

    _ensureLegalEditSafetyStyles() {
        if (document.getElementById('v3-legal-edit-safety-styles')) return;
        const style = document.createElement('style');
        style.id = 'v3-legal-edit-safety-styles';
        style.textContent = `
            .v3-editor-toolbar .v3-legal-edit-controls {
                border-right:0;
                margin-left:0;
                margin-right:0;
                padding-right:0;
                gap:4px;
            }
            .v3-editor-toolbar .v3-legal-edit-controls .v3-editor-select { padding-left:5px; padding-right:14px; box-sizing:border-box; }
            .v3-editor-toolbar .v3-legal-line-height-select { width:78px; }
            .v3-editor-toolbar .v3-legal-margin-select { width:70px; }
            #v3-edit-layer.v3-docx-editor-mode .v3-legal-margin-select { display:none !important; }
            #v3-editor-content-container { width:100% !important; display:flex !important; flex-direction:column !important; align-items:center !important; }
            #v3-editor-scroll { scrollbar-gutter: stable; align-items: center !important; }
            #v3-editor-scroll.v3-a4-locked { overflow-x:hidden !important; }
            #v3-editor-scroll[class*="v3-margin-mode-"] { overflow-x:hidden !important; }
            #v3-editor-scroll.v3-margin-mode-standard .final-contract-page { padding-left:72px !important; padding-right:72px !important; }
            #v3-editor-scroll.v3-margin-mode-wide .final-contract-page { padding-left:92px !important; padding-right:92px !important; }
            #v3-editor-scroll.v3-margin-mode-print .final-contract-page { padding-left:82px !important; padding-right:82px !important; }
            #v3-editor-scroll.v3-margin-mode-signature .final-contract-page { padding-left:72px !important; padding-right:104px !important; }
            #v3-editor-scroll[class*="v3-margin-mode-"] .final-contract-page::before {
                content:none !important;
                display:none !important;
            }
            #v3-editor-scroll.v3-margin-mode-wide .final-contract-page::before { inset:96px 92px; }
            #v3-editor-scroll.v3-margin-mode-print .final-contract-page::before { inset:96px 82px; }
            #v3-editor-scroll.v3-margin-mode-signature .final-contract-page::before { inset:96px 104px 96px 72px; }
            #v3-editor-scroll[class*="v3-margin-mode-"] .final-contract-page.is-continuation-page::before { top:76px; bottom:76px; }
        `;
        document.head.appendChild(style);
    },

    _applyLegalEditViewOptions() {
        const scroll = document.getElementById('v3-editor-scroll');
        if (!scroll) return;
        [...scroll.classList].forEach(cls => {
            if (cls.startsWith('v3-margin-mode-')) scroll.classList.remove(cls);
        });
        scroll.classList.toggle('v3-a4-locked', Boolean(this._a4LockEnabled));
        scroll.classList.add(`v3-margin-mode-${this._finalEditorMarginMode || 'standard'}`);
        const currentLineHeight = this._getFinalEditorLineHeight();
        scroll.style.setProperty('--v3-final-line-height', currentLineHeight);
        this._setFinalEditorLineHeight(currentLineHeight, { quiet: true, forceGlobal: true });
        const editLayer = document.getElementById('v3-edit-layer');
        if (editLayer) {
            const isDocxMode = Array.isArray(this._docxEditorPageElements) && this._docxEditorPageElements.length > 0;
            editLayer.classList.toggle('v3-docx-editor-mode', isDocxMode);
        }
    },

    _getSelectedEditorBlocks() {
        this._restoreEditorSelection();
        const selection = window.getSelection();
        const root = document.getElementById('v3-editor-scroll');
        if (!selection || !selection.rangeCount || !root) return [];
        const range = selection.getRangeAt(0);
        if (!root.contains(range.commonAncestorContainer)) return [];
        if (selection.isCollapsed) {
            const block = this._getEditorFormatBlock(range.startContainer) || this._getSafeEditableNode(range.startContainer);
            return block ? [block] : [];
        }
        const blocks = this._getEditorFormatBlocks(root)
            .filter(block => {
                try {
                    return range.intersectsNode(block);
                } catch {
                    return false;
                }
            });
        if (blocks.length) return blocks;
        const startBlock = this._getSafeEditableNode(range.startContainer);
        const endBlock = this._getSafeEditableNode(range.endContainer);
        return Array.from(new Set([startBlock, endBlock].filter(Boolean)));
    },

    _getEditorFormatBlocks(root = document.getElementById('v3-editor-scroll')) {
        if (!root) return [];
        const selector = [
            '.v3-editor-block',
            'p',
            'li',
            'td',
            'th',
            '.docx-preview-mode p',
            '.docx-preview-mode li',
            '.docx-preview-mode td',
            '.docx-preview-mode th',
            '.docx-preview-mode h1',
            '.docx-preview-mode h2',
            '.docx-preview-mode h3',
            '.docx-preview-mode h4',
            '.docx-preview-mode h5',
            '.docx-preview-mode h6',
            '.docx-preview-mode div'
        ].join(',');
        return Array.from(root.querySelectorAll(selector)).filter(node => this._isEditorFormatBlock(node));
    },

    _getEditorFormatBlock(target) {
        const node = target?.nodeType === 3 ? target.parentElement : target;
        if (!node?.closest) return null;
        const root = node.closest('#v3-editor-scroll');
        if (!root) return null;
        let block = node.closest('.v3-editor-block, p, li, td, th, .docx-preview-mode h1, .docx-preview-mode h2, .docx-preview-mode h3, .docx-preview-mode h4, .docx-preview-mode h5, .docx-preview-mode h6, .docx-preview-mode div');
        while (block && !this._isEditorFormatBlock(block)) {
            block = block.parentElement?.closest?.('.v3-editor-block, p, li, td, th, .docx-preview-mode h1, .docx-preview-mode h2, .docx-preview-mode h3, .docx-preview-mode h4, .docx-preview-mode h5, .docx-preview-mode h6, .docx-preview-mode div');
        }
        return block && root.contains(block) ? block : null;
    },

    _isEditorFormatBlock(node) {
        if (!node || node.nodeType !== 1) return false;
        if (node.classList?.contains('v3-rich-editor-body') || node.classList?.contains('v3-editor-page') || node.classList?.contains('final-contract-page')) return false;
        if (['TABLE', 'TBODY', 'THEAD', 'TFOOT', 'TR', 'SECTION'].includes(node.tagName)) return false;
        if (node.tagName === 'DIV' && node.querySelector(':scope > table, :scope > section, :scope > .docx-wrapper')) return false;
        return Boolean(String(node.innerText || node.textContent || '').trim() || node.querySelector('br,img'));
    },

    _setFinalEditorLineHeight(value, options = {}) {
        const allowed = ['0.8', '1.0', '1.2', '1.5', '1.8', '2.0'];
        const next = allowed.includes(String(value)) ? String(value) : '1.5';
        const selectionBlocks = options.forceGlobal ? [] : this._getSelectedEditorBlocks();
        if (selectionBlocks.length) {
            selectionBlocks.forEach(block => {
                block.style.lineHeight = next;
                block.style.minHeight = `${next}em`;
            });
            this._recordFormatEdit(selectionBlocks[0]);
            if (!options.quiet) Notify.info(`選択行の行間を ${next} にしました`);
            return;
        }
        this._finalEditorLineHeight = next;
        if (this._contract) {
            this._contract.final_line_height = next;
            dbService.updateContract(this._contract.id, { final_line_height: next });
        }
        const scroll = document.getElementById('v3-editor-scroll');
        if (scroll) scroll.style.setProperty('--v3-final-line-height', next);
        document.querySelectorAll('#v3-editor-scroll .v3-rich-editor-body, #v3-editor-scroll .v3-editor-block').forEach(el => {
            el.style.lineHeight = next;
        });
        if (!options.quiet) {
            this._markEditorUnsaved();
            Notify.info(`行間を ${next} にしました`);
            if (this._repaginateTimeout) clearTimeout(this._repaginateTimeout);
            this._forceRepaginationOnce = true;
            this._repaginateTimeout = setTimeout(() => this._repaginateEditor(), 100);
        }
    },

    _setFinalEditorMarginMode(value, options = {}) {
        const allowed = ['standard', 'wide', 'print', 'signature'];
        this._finalEditorMarginMode = allowed.includes(String(value)) ? String(value) : 'standard';
        this._applyLegalEditViewOptions();
        if (!options.quiet) Notify.info('余白表示を更新しました');
    },

    _toggleA4Lock() {
        this._a4LockEnabled = !this._a4LockEnabled;
        this._applyLegalEditViewOptions();
        Notify.info(this._a4LockEnabled ? 'A4固定を有効にしました' : 'A4固定を解除しました');
    },

    _insertNewClauseAtCursor() {
        const editor = this._focusFinalEditor();
        if (!editor) return;
        this._restoreEditorSelection();
        const text = this._collectEditorContent();
        let max = 0;
        text.replace(/第\s*([0-9０-９]+)\s*条/g, (_, raw) => {
            const n = Number(String(raw).replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)));
            if (Number.isFinite(n)) max = Math.max(max, n);
            return _;
        });
        const insertion = `\n\n第${max + 1}条（新規条文）\n\nここに本文\n`;
        document.execCommand('insertText', false, insertion);
        this._onRichEditorInput(editor);
        this._saveEditorSelection();
        Notify.success('条文を追加しました');
    },

    _renumberArticleHeadings() {
        const current = this._collectEditorContent();
        let index = 0;
        const next = current.replace(/(^|\n)([ \t　]*)第\s*[0-9０-９]+\s*条/g, (match, lineStart, indent) => {
            index += 1;
            return `${lineStart}${indent}第${index}条`;
        });
        if (next === current) {
            Notify.info('整理対象の条文番号が見つかりませんでした');
            return;
        }
        this._editedContent = next;
        this._editedHtml = '';
        this._pushHistory(next);
        this._markEditorUnsaved();
        this.renderHandEditMode(this._viewerContainer, next);
        Notify.success(`条文番号を ${index} 件整理しました`);
    },

    _checkWordCompatibility() {
        const scroll = document.getElementById('v3-editor-scroll');
        const pages = Array.from(document.querySelectorAll('#v3-editor-scroll .final-contract-page'));
        const warnings = [];
        pages.forEach((page, i) => {
            const body = page.querySelector('.v3-rich-editor-body');
            if (!body || !body.innerText.trim()) warnings.push(`${i + 1}ページ: 空白ページ`);
            if (body && body.scrollHeight > body.clientHeight + 2) warnings.push(`${i + 1}ページ: 行切れの可能性`);
            if (body && body.scrollWidth > body.clientWidth + 2) warnings.push(`${i + 1}ページ: 横はみ出し`);
            if (page.scrollWidth > page.clientWidth + 2 || page.scrollHeight > page.clientHeight + 2) warnings.push(`${i + 1}ページ: overflow`);
        });
        if (scroll && scroll.scrollWidth > scroll.clientWidth + 2) warnings.push('編集領域: 横はみ出し');
        if (warnings.length) {
            console.warn('[Word compatibility check]', warnings);
            Notify.warning(`互換確認: ${warnings.length}件の注意があります`);
        } else {
            console.warn('[Word compatibility check] no warnings');
            Notify.success('互換確認: 注意点は見つかりませんでした');
        }
    },

    _saveEditorSelection() {
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount) return;
        const range = selection.getRangeAt(0);
        const root = document.getElementById('v3-editor-scroll');
        if (root && root.contains(range.commonAncestorContainer)) {
            this._lastEditorRange = range.cloneRange();
        }
    },

    _restoreEditorSelection() {
        const selection = window.getSelection();
        if (!selection || !this._lastEditorRange) return false;
        const root = document.getElementById('v3-editor-scroll');
        if (!root || !root.contains(this._lastEditorRange.commonAncestorContainer)) return false;
        selection.removeAllRanges();
        selection.addRange(this._lastEditorRange);
        return true;
    },

    _onFinalEditorContainerKeyDown(event) {
        if (!event || event.defaultPrevented) return;
        if (event.target?.closest?.('input, select, textarea')) return;
        if (!event.target?.closest?.('#v3-editor-scroll')) return;

        const isCtrl = event.ctrlKey || event.metaKey;
        const key = String(event.key || '');

        // Ctrl+A: 全文選択
        if (isCtrl && key.toLowerCase() === 'a') {
            event.preventDefault();
            this._selectAllFinalEditorContent();
            return;
        }

        // Delete / Backspace: 複数ブロックをまたぐ選択の削除
        if (key === 'Delete' || key === 'Backspace') {
            const selection = window.getSelection();
            if (!selection || selection.isCollapsed || !selection.rangeCount) return;
            const range = selection.getRangeAt(0);
            const fragment = range.cloneContents();
            // 保護対象ノードをまたぐ選択のみ介入（単一ブロック内は通常通り）
            if (fragment.querySelector(
                '.v3-rich-editor-body, .v3-editor-page, .final-contract-page, section, table'
            )) {
                event.preventDefault();
                event.stopPropagation();
                this._safeDeleteEditorSelection(range);
                setTimeout(() => this._pruneEmptyManualFinalPages(), 0);
            }
        }
    },

    // 複数ブロック・複数ページをまたぐ選択を安全に削除する
    _safeDeleteEditorSelection(range) {
        if (!range) return;
        const root = document.getElementById('v3-editor-scroll');
        if (!root) return;

        const allBlocks = Array.from(root.querySelectorAll('.v3-editor-block, .docx-preview-mode p'));
        const selected = allBlocks.filter(b => {
            try { return range.intersectsNode(b); } catch { return false; }
        });

        if (!selected.length) { try { range.deleteContents(); } catch (_) {} return; }

        if (selected.length === 1) {
            // 同一ブロック内：通常の deleteContents で OK
            try { range.deleteContents(); } catch (_) {}
        } else {
            const first = selected[0];
            const last  = selected[selected.length - 1];

            // 先頭ブロック：選択開始位置より後を削除
            try {
                const r = document.createRange();
                r.setStart(range.startContainer, range.startOffset);
                r.setEndAfter(first.lastChild ?? first);
                r.deleteContents();
            } catch (_) { first.innerHTML = ''; }

            // 中間ブロック：中身を全消去（ブロック要素自体は残す）
            selected.slice(1, -1).forEach(b => { b.innerHTML = ''; });

            // 末尾ブロック：選択終了位置より前を削除
            try {
                const r = document.createRange();
                r.setStartBefore(last.firstChild ?? last);
                r.setEnd(range.endContainer, range.endOffset);
                r.deleteContents();
            } catch (_) { last.innerHTML = ''; }
        }

        // カーソルを先頭に移動
        const sel = window.getSelection();
        try { sel?.collapse(selected[0], 0); } catch (_) {}

        this._markEditorUnsaved?.();
        const editable = selected[0]?.closest?.('.v3-rich-editor-body[contenteditable]');
        if (editable) setTimeout(() => {
            this._onRichEditorInput?.(editable);
            this._pruneEmptyManualFinalPages();
        }, 0);
    },

    _selectAllFinalEditorContent() {
        const root = document.getElementById('v3-editor-content-container') || document.getElementById('v3-editor-scroll');
        if (!root) return false;
        const range = document.createRange();
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode: node => String(node.textContent || '').trim()
                ? NodeFilter.FILTER_ACCEPT
                : NodeFilter.FILTER_SKIP
        });
        const first = walker.nextNode();
        if (!first) return false;
        let last = first;
        let next = walker.nextNode();
        while (next) {
            last = next;
            next = walker.nextNode();
        }
        range.setStart(first, 0);
        range.setEnd(last, last.textContent.length);
        const selection = window.getSelection();
        if (!selection) return false;
        selection.removeAllRanges();
        selection.addRange(range);
        this._lastEditorRange = range.cloneRange();
        return true;
    },

    _bindFinalEditorMouseSelection(scrollArea) {
        if (!scrollArea || scrollArea._wordLikeMouseSelectionBound) return;
        scrollArea._wordLikeMouseSelectionBound = true;
        let anchorRange = null;
        let anchorEditable = null;
        let isSelecting = false;

        const isEditorSelectionTarget = event => {
            if (!event?.target?.closest) return false;
            if (event.target.closest('button, input, select, textarea, .v3-editor-toolbar, .v3-free-text-note')) return false;
            return Boolean(event.target.closest('#v3-editor-scroll .v3-rich-editor-body'));
        };
        const getEditableFromRange = range => {
            const node = range?.startContainer;
            return (node?.nodeType === 1 ? node : node?.parentElement)
                ?.closest?.('.v3-rich-editor-body[contenteditable]') || null;
        };

        scrollArea.addEventListener('mousedown', event => {
            if (event.button !== 0 || !isEditorSelectionTarget(event)) return;
            const range = this._caretRangeFromPoint(event.clientX, event.clientY);
            if (!range) return;
            anchorRange = range.cloneRange();
            anchorEditable = getEditableFromRange(range);
            isSelecting = true;
            if (anchorEditable && document.activeElement !== anchorEditable) {
                anchorEditable.focus({ preventScroll: true });
            }
            this._lastEditorRange = range.cloneRange();
        }, true);

        scrollArea.addEventListener('dblclick', event => {
            if (!isEditorSelectionTarget(event)) return;
            const range = this._caretRangeFromPoint(event.clientX, event.clientY);
            const block = this._getEditorFormatBlock(range?.startContainer || event.target);
            if (!block || !this._selectEditorBlockContents(block)) return;
            event.preventDefault();
            event.stopPropagation();
        }, true);

        scrollArea.addEventListener('mousemove', event => {
            if (!isSelecting || !anchorRange) return;
            const focusRange = this._caretRangeFromPoint(event.clientX, event.clientY);
            if (!focusRange) return;
            const focusEditable = getEditableFromRange(focusRange);
            if (anchorEditable && focusEditable && anchorEditable === focusEditable) {
                return;
            }
            const selection = window.getSelection();
            if (!selection) return;
            // setBaseAndExtent は anchor/focus を一度に設定でき、
            // 異なる contenteditable をまたいでも正しく動作する（Chrome/Edge/Safari/Firefox 対応）
            try {
                if (typeof selection.setBaseAndExtent === 'function') {
                    selection.setBaseAndExtent(
                        anchorRange.startContainer, anchorRange.startOffset,
                        focusRange.startContainer, focusRange.startOffset
                    );
                } else {
                    // setBaseAndExtent 非対応ブラウザ: extend() を試みる
                    if (!selection.rangeCount) {
                        selection.collapse(anchorRange.startContainer, anchorRange.startOffset);
                    }
                    selection.extend(focusRange.startContainer, focusRange.startOffset);
                }
            } catch (_) {
                // 最終フォールバック: Range を手動構築
                try {
                    const range = document.createRange();
                    const cmp = this._compareDomPoints(
                        anchorRange.startContainer, anchorRange.startOffset,
                        focusRange.startContainer, focusRange.startOffset
                    );
                    if (cmp <= 0) {
                        range.setStart(anchorRange.startContainer, anchorRange.startOffset);
                        range.setEnd(focusRange.startContainer, focusRange.startOffset);
                    } else {
                        range.setStart(focusRange.startContainer, focusRange.startOffset);
                        range.setEnd(anchorRange.startContainer, anchorRange.startOffset);
                    }
                    selection.removeAllRanges();
                    selection.addRange(range);
                } catch (_2) { /* ignore */ }
            }
            event.preventDefault();
        }, true);

        const finishSelection = () => {
            if (!isSelecting) return;
            isSelecting = false;
            anchorRange = null;
            anchorEditable = null;
            this._saveEditorSelection();
        };
        scrollArea.addEventListener('mouseup', finishSelection, true);
        scrollArea.addEventListener('mouseleave', finishSelection, true);
        window.addEventListener('mouseup', finishSelection, true);
    },

    _selectEditorBlockContents(block) {
        if (!block || block.nodeType !== 1) return false;
        const root = document.getElementById('v3-editor-scroll');
        if (!root || !root.contains(block)) return false;
        const range = document.createRange();
        range.selectNodeContents(block);
        const selection = window.getSelection();
        if (!selection) return false;
        selection.removeAllRanges();
        selection.addRange(range);
        this._lastEditorRange = range.cloneRange();
        return true;
    },

    _caretRangeFromPoint(x, y) {
        let range = null;
        if (document.caretRangeFromPoint) {
            range = document.caretRangeFromPoint(x, y);
        } else if (document.caretPositionFromPoint) {
            const pos = document.caretPositionFromPoint(x, y);
            if (pos) {
                range = document.createRange();
                range.setStart(pos.offsetNode, pos.offset);
                range.collapse(true);
            }
        }
        const root = document.getElementById('v3-editor-scroll');
        if (!root) return null;
        if (range && root.contains(range.startContainer)) {
            // Check if inside an editable body
            const node = range.startContainer;
            const editable = (node.nodeType === 1 ? node : node.parentElement)
                ?.closest('.v3-rich-editor-body[contenteditable]');
            if (editable) return range;
        }
        // Mouse is in the gap between pages — snap to nearest editable endpoint
        const editables = [...document.querySelectorAll('#v3-editor-scroll .v3-rich-editor-body[contenteditable]')];
        if (!editables.length) return null;
        let best = null, bestDist = Infinity, snapToEnd = false;
        for (const el of editables) {
            const rect = el.getBoundingClientRect();
            if (y <= rect.top) {
                const d = rect.top - y;
                if (d < bestDist) { bestDist = d; best = el; snapToEnd = false; }
            } else if (y >= rect.bottom) {
                const d = y - rect.bottom;
                if (d < bestDist) { bestDist = d; best = el; snapToEnd = true; }
            } else {
                best = el; snapToEnd = false; break;
            }
        }
        if (!best) return null;
        const snapRange = document.createRange();
        if (snapToEnd) {
            const last = best.lastChild;
            if (last?.nodeType === 3) snapRange.setStart(last, last.length);
            else snapRange.setStart(best, best.childNodes.length);
        } else {
            snapRange.setStart(best, 0);
        }
        snapRange.collapse(true);
        return snapRange;
    },

    _compareDomPoints(nodeA, offsetA, nodeB, offsetB) {
        if (nodeA === nodeB) return offsetA - offsetB;
        // Cross-contenteditable: compare by page index in DOM order
        const getPage = node => (node.nodeType === 1 ? node : node.parentElement)
            ?.closest('.v3-rich-editor-body[contenteditable]');
        const pageA = getPage(nodeA);
        const pageB = getPage(nodeB);
        if (pageA && pageB && pageA !== pageB) {
            const all = [...document.querySelectorAll('#v3-editor-scroll .v3-rich-editor-body[contenteditable]')];
            return all.indexOf(pageA) - all.indexOf(pageB);
        }
        const range = document.createRange();
        try {
            range.setStart(nodeA, offsetA);
            range.setEnd(nodeB, offsetB);
            return range.collapsed ? 1 : -1;
        } catch {
            try {
                range.setStart(nodeB, offsetB);
                range.setEnd(nodeA, offsetA);
                return range.collapsed ? -1 : 1;
            } catch { return 0; }
        }
    },

    _canUndoEdit() {
        const current = document.getElementById('v3-editor-scroll') ? this._collectEditorContent() : String(this._editedContent || '');
        return Boolean(
            this._editHistory
            && (
                this._editHistoryIndex > 0
                || (current && current !== this._getEditHistoryText(this._editHistory?.[this._editHistoryIndex]))
            )
        );
    },

    _canRedoEdit() {
        return Boolean(this._editHistory && this._editHistoryIndex < this._editHistory.length - 1);
    },

    _syncUndoRedoButtons() {
        const undoButton = document.querySelector('[data-editor-action="undo"]');
        const redoButton = document.querySelector('[data-editor-action="redo"]');
        if (undoButton) undoButton.style.opacity = this._canUndoEdit() ? '1' : '0.4';
        if (redoButton) redoButton.style.opacity = this._canRedoEdit() ? '1' : '0.4';
    },

    _captureCurrentEditForHistory() {
        if (!document.getElementById('v3-editor-scroll')) return;
        const current = this._collectEditorContent();
        if (!this._editHistory) {
            this._editHistory = [this._createEditHistorySnapshot(current)];
            this._editHistoryIndex = 0;
            return;
        }
        // Only push if different from current history point
        const currentHtml = this._collectEditorHtml();
        const active = this._editHistory[this._editHistoryIndex];
        if (current && (current !== this._getEditHistoryText(active) || currentHtml !== this._getEditHistoryHtml(active))) {
            this._pushHistory(current);
        }
        this._editedContent = current;
        this._editedHtml = currentHtml;
        this._syncUndoRedoButtons();
    },

    _markEditorUnsaved() {
        const toolbarBadge = document.querySelector('.v3-status-badge');
        if (toolbarBadge && !toolbarBadge.classList.contains('unsaved')) {
            toolbarBadge.classList.add('unsaved');
            toolbarBadge.style.background = '#fef3c7';
            toolbarBadge.style.color = '#d97706';
            toolbarBadge.innerText = '● 未保存';
        }
    },

    _getEditorTextOffset(root) {
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount || !root?.contains(selection.anchorNode)) return null;
        const range = selection.getRangeAt(0).cloneRange();
        const prefix = range.cloneRange();
        prefix.selectNodeContents(root);
        prefix.setEnd(range.startContainer, range.startOffset);
        return prefix.toString().length;
    },

    _restoreEditorTextOffset(root, offset) {
        if (!root || offset === null || offset === undefined) return;
        const selection = window.getSelection();
        const range = document.createRange();
        let remaining = Math.max(0, Number(offset) || 0);
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        try {
            while (node) {
                const length = node.textContent.length;
                if (remaining <= length) {
                    range.setStart(node, remaining);
                    range.collapse(true);
                    selection.removeAllRanges();
                    selection.addRange(range);
                    return;
                }
                remaining -= length;
                node = walker.nextNode();
            }
            this._setCursorAtEnd(root);
        } catch (error) {
            console.warn('[SignViewer] Editor cursor offset restore failed:', error);
        }
    },

    _stripEditorStyleNoise(node) {
        if (!node?.style) return;
        [
            'margin',
            'margin-left',
            'margin-right',
            'margin-top',
            'margin-bottom',
            'font-family',
            'zoom',
            'transform',
            'display',
            'position',
            'left',
            'top',
            'right',
            'bottom',
            'width',
            'height',
            'min-width',
            'max-width',
            'min-height',
            'max-height',
            'vertical-align',
            'baseline-shift'
        ].forEach(prop => node.style.removeProperty(prop));
        if (!node.getAttribute('style')) node.removeAttribute('style');
    },

    _normalizeEditorBlockClass(block) {
        if (!block?.classList?.contains('v3-editor-block')) return;
        const isEmpty = !String(block.innerText || block.textContent || '').trim();
        const isList = block.classList.contains('type-list');
        block.className = [
            'v3-editor-block',
            isList ? 'type-list' : 'type-body',
            isEmpty ? 'is-empty' : ''
        ].filter(Boolean).join(' ');
    },

    _plainFinalEditorTextFromDom() {
        const bodies = Array.from(document.querySelectorAll('#v3-editor-scroll .v3-rich-editor-body'));
        if (!bodies.length) return '';
        return bodies.map(body => {
            return Array.from(body.querySelectorAll(':scope > .v3-editor-block'))
                .map(block => String(block.innerText || block.textContent || '').replace(/\u00a0/g, ' ').trimEnd())
                .join('\n');
        }).join('\n').replace(/\n{4,}/g, '\n\n\n').trim();
    },

    _getBestFinalEditorPlainTextForRepair(reExtractedOriginalText = '') {
        const domText = this._plainFinalEditorTextFromDom();
        const editedText = String(this._editedContent || '').trim();
        const savedText = String(this._lastSavedContent || this._contract?.final_content || '').trim();
        const originalText = String(this._getOriginalDocumentText() || '').trim();
        const reExtractedFinalText = this._buildFinalRepairTextFromOriginal(reExtractedOriginalText, editedText || domText || savedText);
        const candidates = [
            { source: 'reExtractedOriginal', text: reExtractedFinalText },
            { source: 'edited', text: editedText },
            { source: 'dom', text: domText },
            { source: 'saved', text: savedText },
            { source: 'original', text: originalText }
        ]
            .map(candidate => ({
                ...candidate,
                text: this._normalizeFinalLayoutText(candidate.text, { preserveOriginalStructure: candidate.source === 'reExtractedOriginal' })
            }))
            .filter(candidate => candidate.text && candidate.text.trim().length > 0);
        if (!candidates.length) return '';
        const originalStats = this._getFinalEditorTextRepairStats(this._normalizeFinalLayoutText(originalText));
        const scored = candidates.map(candidate => {
            const stats = this._getFinalEditorTextRepairStats(candidate.text);
            let score = Math.min(candidate.text.length, 5000) + (stats.lineCount * 5);
            score += stats.articleCount * 1200;
            score += stats.headingCoverage * 1800;
            score += stats.uniqueLineRatio * 600;
            if (originalStats.articleCount > 0) {
                const missingArticles = Math.max(0, originalStats.articleCount - stats.articleCount);
                score -= missingArticles * 1600;
            }
            if (originalStats.length > 200) {
                const ratio = stats.length / originalStats.length;
                if (ratio < 0.65 || ratio > 1.85) score -= 1800;
            }
            if (candidate.source === 'dom') score += 180;
            if (candidate.source === 'edited') score += 120;
            if (candidate.source === 'reExtractedOriginal') score += 2400;
            if (candidate.source === 'original') score += 80;
            return { ...candidate, score, stats };
        });
        scored.sort((a, b) => b.score - a.score);
        return scored[0].text;
    },

    _buildFinalRepairTextFromOriginal(originalText, currentFinalText = '') {
        let nextText = this._normalizeFinalLayoutText(originalText, { preserveOriginalStructure: true });
        if (!nextText) return '';
        const changes = this._getActiveSortedAiChanges();
        if (!Array.isArray(changes) || !changes.length) return nextText;
        const applied = this._getAppliedChangeIndexesForText(currentFinalText);
        Array.from(applied)
            .map(Number)
            .filter(Number.isInteger)
            .sort((a, b) => a - b)
            .forEach((index) => {
                const change = changes[index];
                if (change) nextText = this._applyChangeToText(nextText, change, index);
            });
        return nextText;
    },

    _getFinalEditorTextRepairStats(text) {
        const normalized = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
        const lines = normalized.split('\n').map(line => line.trim()).filter(Boolean);
        const articleMatches = normalized.match(/第\s*[0-9０-９一二三四五六七八九十百千〇零○◯]+\s*条/g) || [];
        const uniqueLines = new Set(lines);
        const structuredArticles = this._getStructuredOriginalArticles();
        const headingCoverage = structuredArticles.length
            ? structuredArticles.filter(article => {
                const articleNumber = String(article?.articleNumber || article?.article || article?.clause || '').replace(/\s+/g, '');
                const title = String(article?.title || article?.header || '').replace(/\s+/g, '');
                const haystack = normalized.replace(/\s+/g, '');
                return (articleNumber && haystack.includes(articleNumber)) || (title && haystack.includes(title));
            }).length / structuredArticles.length
            : 0;
        return {
            length: normalized.length,
            articleCount: articleMatches.length,
            lineCount: lines.length,
            uniqueLineRatio: lines.length ? uniqueLines.size / lines.length : 0,
            headingCoverage
        };
    },

    async _getOriginalFileBlobForRepair() {
        const contractId = this._currentRequest?.contract_id || this._currentRequest?.contractId || this._contract?.id || this._contractId;
        const contract = this._contract || {};
        const request = this._currentRequest || {};

        if (this._isOriginalDocxContract()) {
            const docx = await this._getOriginalDocxFileForFinal();
            if (docx instanceof Blob) return docx;
        }

        const runtimePdfUrl = this._app && typeof this._app.getRuntimePdfPreviewUrl === 'function'
            ? this._app.getRuntimePdfPreviewUrl(contractId)
            : null;
        const candidateUrl = resolveBackendAssetUrl(
            runtimePdfUrl
            || contract.pdf_url
            || contract.pdf_storage_path
            || contract.original_file_url
            || contract.original_file_path
            || request.pdf_url
            || request.pdf_storage_path
            || request.original_file_url
            || request.original_file_path
        );

        if (candidateUrl) {
            try {
                const token = await this._getIdTokenSafe();
                const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
                const response = await fetch(candidateUrl, { headers });
                if (response.ok) return await response.blob();
            } catch (error) {
                console.warn('[SignViewer] direct original file fetch failed:', error);
            }
        }

        if (contractId) {
            try {
                const token = await this._getIdTokenSafe();
                const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
                const response = await fetch(toApiUrl(`/api/contracts/${encodeURIComponent(this._getSanitizedContractId(contractId))}/original-file`), { headers });
                if (response.ok) return await response.blob();
            } catch (error) {
                console.warn('[SignViewer] original-file endpoint fetch failed:', error);
            }
        }

        return null;
    },

    async _extractOriginalDocxTextForRepair(source) {
        if (!(source instanceof Blob) && !source) return '';
        this._faithfulFinalHtmlPages = null;
        this._faithfulFinalPageTexts = null;
        const xmlText = await this._extractOriginalDocxXmlTextForRepair(source);
        const probe = document.createElement('div');
        probe.style.cssText = [
            'position:absolute',
            'left:-30000px',
            'top:0',
            'width:900px',
            'visibility:hidden',
            'pointer-events:none',
            'overflow:hidden'
        ].join(';');
        document.body.appendChild(probe);
        try {
            const pages = await renderDocxPreviewPages(probe, source);
            const detectedFontSize = this._detectRenderedOriginalFontSize(probe);
            if (detectedFontSize) this._editorFontSize = detectedFontSize;
            const previewPageTexts = (Array.isArray(pages) && pages.length ? pages : Array.from(probe.querySelectorAll('section, .docx-wrapper > *')))
                .map(page => String(page.innerText || page.textContent || '')
                    .replace(/\u00a0/g, ' ')
                    .replace(/\r\n/g, '\n')
                    .replace(/\r/g, '\n')
                    .replace(/\n{4,}/g, '\n\n\n')
                    .trimEnd())
                .filter(pageText => pageText.trim());
            if (previewPageTexts.length) {
                this._faithfulFinalPageTexts = previewPageTexts;
                this._originalPageCount = Math.max(Number(this._originalPageCount || 0), previewPageTexts.length);
            }
            const previewText = (Array.isArray(pages) && pages.length ? pages : Array.from(probe.querySelectorAll('section, .docx-wrapper > *')))
                .map(page => String(page.innerText || page.textContent || '').replace(/\u00a0/g, ' ').trim())
                .filter(Boolean)
                .join('\n\n');
            return this._chooseBestOriginalReextractText([
                { source: 'docxPreview', text: previewText, preserveOriginalStructure: true },
                { source: 'docxXml', text: xmlText, preserveOriginalStructure: true }
            ]);
        } catch (error) {
            console.warn('[SignViewer] DOCX original text re-extract failed:', error);
            return xmlText || '';
        } finally {
            probe.remove();
        }
    },

    _detectRenderedOriginalFontSize(root) {
        if (!root || typeof window === 'undefined') return null;
        const sizes = Array.from(root.querySelectorAll('p, span, td, li'))
            .map(node => parseFloat(window.getComputedStyle(node).fontSize))
            .filter(size => Number.isFinite(size) && size >= 9 && size <= 24)
            .sort((a, b) => a - b);
        if (!sizes.length) return null;
        const median = sizes[Math.floor(sizes.length / 2)];
        const rounded = Math.round(median);
        return Math.min(32, Math.max(12, rounded));
    },

    async _ensureJsZipForRepair() {
        if (window.JSZip) return true;
        await new Promise((resolve, reject) => {
            const existing = document.querySelector('script[data-sign-viewer-jszip-repair="true"]');
            if (existing) {
                existing.addEventListener('load', () => resolve(), { once: true });
                existing.addEventListener('error', reject, { once: true });
                return;
            }
            const script = document.createElement('script');
            script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
            script.async = true;
            script.dataset.signViewerJszipRepair = 'true';
            script.onload = () => resolve();
            script.onerror = () => reject(new Error('Failed to load JSZip'));
            document.head.appendChild(script);
        });
        return Boolean(window.JSZip);
    },

    async _extractOriginalDocxXmlTextForRepair(source) {
        try {
            await this._ensureJsZipForRepair();
            if (!window.JSZip) return '';
            const arrayBuffer = await this._getSourceArrayBuffer(source);
            if (!arrayBuffer) return '';
            const zip = await window.JSZip.loadAsync(arrayBuffer);
            const documentXml = await zip.file('word/document.xml')?.async('string');
            if (!documentXml) return '';
            const structure = this._extractWordDocumentXmlStructure(documentXml);
            this._faithfulFinalHtmlPages = structure.htmlPages;
            return this._normalizeFinalLayoutText(structure.text, { preserveOriginalStructure: true });
        } catch (error) {
            console.warn('[SignViewer] DOCX XML text extraction failed:', error);
            return '';
        }
    },

    _extractWordDocumentXmlText(documentXml) {
        return this._extractWordDocumentXmlStructure(documentXml).text;
    },

    _extractWordDocumentXmlStructure(documentXml) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(String(documentXml || ''), 'application/xml');
        if (doc.querySelector('parsererror')) return { text: '', htmlPages: [] };
        const localName = (node) => String(node?.localName || node?.nodeName || '').replace(/^.*:/, '');
        const body = Array.from(doc.getElementsByTagName('*')).find(node => localName(node) === 'body');
        if (!body) return { text: '', htmlPages: [] };

        const paragraphText = (paragraph) => {
            const parts = [];
            const walk = (node) => {
                Array.from(node.childNodes || []).forEach(child => {
                    const name = localName(child);
                    if (name === 't') {
                        parts.push(child.textContent || '');
                        return;
                    }
                    if (name === 'tab') {
                        parts.push('\t');
                        return;
                    }
                    if (name === 'br' || name === 'cr') {
                        parts.push('\n');
                        return;
                    }
                    if (name === 'lastRenderedPageBreak') {
                        parts.push('\f');
                        return;
                    }
                    walk(child);
                });
            };
            walk(paragraph);
            return parts.join('').replace(/[ \t]+\n/g, '\n');
        };

        const paragraphHtml = (paragraph) => {
            const text = paragraphText(paragraph);
            const hasPageBreak = text.includes('\f');
            const safeText = this.escapeHtml(text.replace(/\f/g, ''));
            const html = safeText
                ? safeText.replace(/\t/g, '<span class="v3-editor-tab">　　</span>').replace(/\n/g, '<br>')
                : '<br data-empty-line="true">';
            return {
                text,
                hasPageBreak,
                html: `<p class="v3-editor-block type-body${safeText ? '' : ' is-empty'}" spellcheck="true" data-editor-tag="p">${html}</p>`
            };
        };

        const tableStructure = (table) => {
            const rows = Array.from(table.childNodes || [])
                .filter(node => localName(node) === 'tr')
                .map(row => {
                    const cells = Array.from(row.childNodes || []).filter(node => localName(node) === 'tc').map(cell => {
                        const paragraphs = Array.from(cell.childNodes || []).filter(node => localName(node) === 'p').map(paragraphHtml);
                        const cellText = paragraphs.map(item => item.text.replace(/\f/g, '')).join('\n');
                        const cellHtml = paragraphs.length
                            ? paragraphs.map(item => item.html).join('')
                            : '<p class="v3-editor-block type-body is-empty" spellcheck="true" data-editor-tag="p"><br data-empty-line="true"></p>';
                        return {
                            text: cellText,
                            html: `<td>${cellHtml}</td>`
                        };
                    });
                    return {
                        text: cells.map(cell => cell.text).join('\t'),
                        html: cells.length ? `<tr>${cells.map(cell => cell.html).join('')}</tr>` : ''
                    };
                })
                .filter(row => row.html);
            return {
                text: rows.map(row => row.text).join('\n'),
                html: rows.length ? `<table class="v3-editor-source-table"><tbody>${rows.map(row => row.html).join('')}</tbody></table>` : ''
            };
        };

        const blocks = [];
        const htmlPages = [[]];
        const pushHtml = (html) => {
            if (html) htmlPages[htmlPages.length - 1].push(html);
        };
        const nextPage = () => {
            if (htmlPages[htmlPages.length - 1].length) htmlPages.push([]);
        };

        Array.from(body.childNodes || []).forEach(node => {
            const name = localName(node);
            if (name === 'p') {
                const item = paragraphHtml(node);
                blocks.push(item.text.replace(/\f/g, ''));
                pushHtml(item.html);
                if (item.hasPageBreak) nextPage();
            } else if (name === 'tbl') {
                const table = tableStructure(node);
                if (table.text || table.html) {
                    blocks.push(table.text);
                    pushHtml(table.html);
                }
            }
        });

        return {
            text: blocks.join('\n').replace(/\n{4,}/g, '\n\n\n').trimEnd(),
            htmlPages: htmlPages.map(page => page.join('')).filter(html => html.trim())
        };
    },

    _chooseBestOriginalReextractText(candidates = []) {
        const normalized = candidates
            .map(candidate => ({
                ...candidate,
                text: this._normalizeFinalLayoutText(candidate?.text || '', { preserveOriginalStructure: candidate?.preserveOriginalStructure === true })
            }))
            .filter(candidate => candidate.text && candidate.text.trim().length >= 20);
        if (!normalized.length) return '';
        const scored = normalized.map(candidate => {
            const stats = this._getFinalEditorTextRepairStats(candidate.text);
            let score = Math.min(stats.length, 12000) + (stats.articleCount * 1600) + (stats.lineCount * 8);
            score += stats.headingCoverage * 2200;
            score += stats.uniqueLineRatio * 800;
            if (candidate.source === 'docxPreview') score += 2200;
            if (candidate.source === 'docxXml') score += 1400;
            if (candidate.source === 'renderedOriginal') score += 900;
            return { ...candidate, score, stats };
        });
        scored.sort((a, b) => b.score - a.score);
        console.info('[SignViewer] Original re-extract candidates', scored.map(item => ({
            source: item.source,
            score: Math.round(item.score),
            length: item.text.length,
            articleCount: item.stats.articleCount,
            lineCount: item.stats.lineCount,
            headingCoverage: Math.round(item.stats.headingCoverage * 100) / 100
        })));
        return scored[0].text;
    },

    async _extractOriginalPdfTextForRepair(source) {
        if (!source) return '';
        let objectUrl = '';
        let pdf = null;
        const previousPdfDoc = this._pdfDoc;
        try {
            await this.loadPdfJs();
            const pdfSource = source instanceof Blob
                ? (objectUrl = URL.createObjectURL(source))
                : String(source || '');
            const loadingTask = pdfjsLib.getDocument({
                url: pdfSource,
                cMapUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/cmaps/',
                cMapPacked: true,
                standardFontDataUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/standard_fonts/',
                useWorkerFetch: true
            });
            pdf = await loadingTask.promise;
            this._pdfDoc = pdf;
            const text = await this.extractCurrentPdfText();
            return this._normalizeFinalLayoutText(text);
        } catch (error) {
            console.warn('[SignViewer] PDF original text re-extract failed:', error);
            return '';
        } finally {
            this._pdfDoc = previousPdfDoc;
            if (typeof pdf?.destroy === 'function') await pdf.destroy();
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        }
    },

    async _reextractOriginalTextForFinalRepair() {
        const source = await this._getOriginalFileBlobForRepair();
        const fileName = String(source?.name || this._contract?.original_filename || this._contract?.filename || '').toLowerCase();
        const type = String(source?.type || this._contract?.source_type || this._contract?.doc_type || '').toLowerCase();
        const isDocx = this._isOriginalDocxContract()
            || fileName.endsWith('.docx')
            || type.includes('wordprocessingml')
            || type.includes('msword');
        const isPdf = fileName.endsWith('.pdf') || type.includes('pdf');

        let text = '';
        if (isDocx) text = await this._extractOriginalDocxTextForRepair(source);
        else if (isPdf || source instanceof Blob) text = await this._extractOriginalPdfTextForRepair(source);

        if (!text || text.trim().length < 20) {
            text = this._extractRenderedOriginalLayerTextForRepair();
        }
        const reextracted = Boolean(text && text.trim().length >= 20);

        if (!text || text.trim().length < 20) {
            text = this._normalizeFinalLayoutText(this._getOriginalDocumentText());
        }
        return { text, reextracted };
    },

    _extractRenderedOriginalLayerTextForRepair() {
        const candidates = [document.getElementById('sign-viewer-docx-pages')];
        return this._chooseBestOriginalReextractText(candidates.map(node => ({
            source: 'renderedOriginal',
            text: String(node?.innerText || node?.textContent || '').replace(/\u00a0/g, ' ').trim()
        })));
    },

    sanitizeEditedBlock(node, options = {}) {
        if (this._isRichEditorComposing || !node) return;
        const block = this._getSafeEditableNode(node) || node.closest?.('[contenteditable="true"]');
        if (!block) return;
        const cursorOffset = options.preserveSelection === false ? null : this._getEditorTextOffset(block);

        block.querySelectorAll('center, font').forEach(el => {
            const span = document.createElement('span');
            span.textContent = el.textContent || '';
            el.replaceWith(span);
        });
        block.querySelectorAll('div, p, h1, h2, h3, h4, h5, h6').forEach(child => {
            if (child === block || child.closest('td, th, table, ul, ol, li') !== block.closest('td, th, table, ul, ol, li')) return;
            const fragment = document.createDocumentFragment();
            while (child.firstChild) fragment.appendChild(child.firstChild);
            child.replaceWith(fragment);
        });
        block.querySelectorAll('span').forEach(span => {
            this._stripEditorStyleNoise(span);
            [...span.attributes].forEach(attr => {
                const name = attr.name.toLowerCase();
                if (name === 'class' || name.startsWith('data-') || name === 'contenteditable' || name === 'spellcheck') span.removeAttribute(attr.name);
            });
            if (!span.attributes.length) {
                const text = document.createTextNode(span.textContent || '');
                span.replaceWith(text);
            }
        });
        this._stripEditorStyleNoise(block);
        [...block.attributes].forEach(attr => {
            const name = attr.name.toLowerCase();
            if (name === 'align') {
                const align = String(attr.value || '').trim().toLowerCase();
                if (/^(?:left|center|right|justify)$/.test(align) && !block.style.textAlign) {
                    block.style.textAlign = align;
                }
                block.removeAttribute(attr.name);
            }
            if (name === 'style' && !block.getAttribute('style')) block.removeAttribute(attr.name);
            if (name.startsWith('data-') && name !== 'data-empty-line' && name !== 'data-editor-tag') block.removeAttribute(attr.name);
        });
        this._normalizeEditorBlockClass(block);
        block.normalize();
        if (cursorOffset !== null) this._restoreEditorTextOffset(block, cursorOffset);
    },

    _stabilizeFinalEditorBlockDom(scope, options = {}) {
        if (this._isRichEditorComposing || !scope) return;
        const root = scope.closest?.('.v3-rich-editor-body') || scope.querySelector?.('.v3-rich-editor-body') || scope;
        const editableRoot = root.closest?.('#v3-editor-scroll') ? root : document.getElementById('v3-editor-scroll');
        if (!editableRoot) return;
        const cursorRoot = options.preserveSelection === false ? null : (root.closest?.('[contenteditable="true"]') || root.querySelector?.('[contenteditable="true"]') || root);
        const cursorOffset = cursorRoot ? this._getEditorTextOffset(cursorRoot) : null;

        editableRoot.querySelectorAll('.v3-rich-editor-body, .v3-editor-page, .final-contract-page, section, table, tbody, tr, ul, ol').forEach(node => {
            if (node.classList?.contains('docx-preview-mode')) return;
            if (node.hasAttribute('contenteditable')) node.removeAttribute('contenteditable');
        });
        editableRoot.querySelectorAll('.v3-rich-editor-body').forEach(body => {
            body.setAttribute('contenteditable', 'true');
        });
        editableRoot.querySelectorAll('.v3-rich-editor-body div:not(.v3-free-text-note)').forEach(div => {
            if (div.classList.contains('v3-rich-editor-body') || div.classList.contains('v3-editor-page') || div.classList.contains('final-contract-page')) return;
            if (div.querySelector('table,ul,ol,section')) return;
            const p = document.createElement('p');
            p.className = div.className || 'v3-editor-block type-body';
            p.setAttribute('spellcheck', 'true');
            p.innerHTML = div.innerHTML || '<br data-empty-line="true">';
            div.replaceWith(p);
        });
        editableRoot.querySelectorAll('.v3-editor-block, p, li, td, th, h1, h2, h3, h4, h5, h6, span').forEach(node => {
            this._stripEditorStyleNoise(node);
            if (node.tagName === 'SPAN') {
                [...node.attributes].forEach(attr => {
                    const name = attr.name.toLowerCase();
                    if (name.startsWith('data-') || name === 'contenteditable' || name === 'spellcheck') node.removeAttribute(attr.name);
                });
            }
        });
        editableRoot.querySelectorAll('.v3-editor-block, p, li, td, th, h1, h2, h3, h4, h5, h6').forEach(block => {
            this.sanitizeEditedBlock(block, { preserveSelection: false });
        });
        editableRoot.querySelectorAll('.v3-rich-editor-body span').forEach(span => {
            if (!span.textContent.trim() && !span.querySelector('br,img')) span.remove();
        });
        editableRoot.querySelectorAll('.v3-rich-editor-body br + br + br').forEach(br => br.remove());
        editableRoot.normalize();
        if (cursorRoot && editableRoot.contains(cursorRoot)) this._restoreEditorTextOffset(cursorRoot, cursorOffset);
    },

    _onRichEditorPaste(event, el) {
        if (event._signViewerPasteHandled) return;
        event._signViewerPasteHandled = true;
        if (this._isRichEditorComposing) return;
        const editable = this._getSafeEditableNode(event.target);
        if (!editable) {
            event.preventDefault();
            return;
        }
        const text = event.clipboardData?.getData('text/plain') || '';
        if (!text) return;
        event.preventDefault();
        const normalized = text
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n')
            .replace(/\n{4,}/g, '\n\n\n');
        document.execCommand('insertText', false, normalized);
        this.sanitizeEditedBlock(editable, { preserveSelection: true });
        this._onRichEditorInput(el || editable);
    },

    _onRichEditorInput(el) {
        this._markEditorUnsaved();
        if (this._manualFinalExtraPages) this._manualFinalExtraPages = 0;
        this._editedContent = this._collectEditorContent();
        this._editedHtml = this._collectEditorHtml();
        this._schedulePruneEmptyManualFinalPages();
        
        if (this._editCaptureTimeout) clearTimeout(this._editCaptureTimeout);
        this._editCaptureTimeout = setTimeout(() => {
            if (this._isRepaginating) return;
            this._captureCurrentEditForHistory();
        }, 600);
        
        this._syncUndoRedoButtons();
    },

    async _repairFinalEditorLayout() {
        if (this._isRichEditorComposing) {
            Notify.info('日本語入力の確定後に再解析してください');
            return;
        }
        const scrollArea = document.getElementById('v3-editor-scroll');
        if (!scrollArea) return;
        const previousSavedContent = this._lastSavedContent;
        this._docxEditorPageElements = null; // キャッシュをクリアして再変換を促す
        this._faithfulFinalHtmlPages = null;
        this._faithfulFinalPageTexts = null;
        if (this._repaginateTimeout) {
            clearTimeout(this._repaginateTimeout);
            this._repaginateTimeout = null;
        }
        const button = document.querySelector('.v3-editor-reparse-btn');
        const previousButtonHtml = button?.innerHTML || '';
        if (button) {
            button.disabled = true;
            button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 原文を再取得中...';
        }

        const reExtractedOriginal = await this._reextractOriginalTextForFinalRepair();
        // Keep reparse on the measured editor path. Direct DOCX XML HTML rendering can bypass
        // editor typography/page scaling and make the document unreadably small.
        this._faithfulFinalHtmlPages = null;
        const repairedContent = this._getBestFinalEditorPlainTextForRepair(reExtractedOriginal.text);
        // 原本のページ行数比率を repairedContent に適用し直す
        if (Array.isArray(this._faithfulFinalPageTexts) && this._faithfulFinalPageTexts.length > 1 && repairedContent) {
            const originalPageLineCounts = this._faithfulFinalPageTexts.map(pt => String(pt || '').split('\n').length);
            const totalOriginalLines = originalPageLineCounts.reduce((a, b) => a + b, 0);
            if (totalOriginalLines > 0) {
                const repairedLines = repairedContent.split('\n');
                const repairedTotal = repairedLines.length;
                let cursor = 0;
                this._faithfulFinalPageTexts = originalPageLineCounts.map((pageLines, idx) => {
                    const ratio = pageLines / totalOriginalLines;
                    const lineCount = idx === originalPageLineCounts.length - 1
                        ? repairedTotal - cursor
                        : Math.max(1, Math.round(ratio * repairedTotal));
                    const slice = repairedLines.slice(cursor, cursor + lineCount);
                    cursor += lineCount;
                    return slice.join('\n');
                }).map(pt => pt.trim() ? pt : ' ');
            }
        }
        if (!repairedContent) {
            Notify.warning('再解析できる本文が見つかりませんでした');
            if (button) {
                button.disabled = false;
                button.innerHTML = previousButtonHtml;
            }
            return;
        }
        this._isRepaginating = true;
        this._editedContent = repairedContent;
        this._editedHtml = '';
        this._manualFinalExtraPages = 0;
        this._lastRenderedContent = '';
        this._faithfulFinalReparse = true;
        try {
            await this.renderHandEditMode(this._viewerContainer, repairedContent);
        } finally {
            this._isRepaginating = false;
            if (button) {
                button.disabled = false;
                button.innerHTML = previousButtonHtml;
            }
        }
        this._lastSavedContent = previousSavedContent;
        if (repairedContent !== previousSavedContent) this._markEditorUnsaved();
        this._keepFinalEditorChromeVisible();
        Notify.success(reExtractedOriginal.reextracted ? '原文を再取得して編集レイアウトを再解析しました' : '保存済み本文から編集レイアウトを再解析しました');
    },

    async _repaginateEditor() {
        if (this._viewMode !== 'edit' && this._viewMode !== 'final') return;
        const scrollArea = document.getElementById('v3-editor-scroll');
        if (!scrollArea) return;
        // docx-preview mode is not repaginated. Keep current DOM edits instead of
        // re-rendering from _docxEditorPageElements, which would discard user input.
        if (this._docxEditorPageElements) {
            this._editedContent = this._collectEditorContent();
            this._editedHtml = this._collectEditorHtml();
            this._syncUndoRedoButtons();
            return;
        }
        const force = Boolean(this._forceRepaginationOnce);
        this._forceRepaginationOnce = false;

        // 1. Save state (Scroll position and Cursor)
        this._isRepaginating = true;
        const savedScrollTop = scrollArea.scrollTop; // SAVE SCROLL POSITION
        const savedActivePage = this._activePage;
        
        const selection = window.getSelection();
        let savedOffset = 0;
        let savedNodeId = null;
        
        if (selection && selection.rangeCount > 0) {
            const range = selection.getRangeAt(0);
            const container = range.startContainer;
            const editorBody = container.nodeType === 3 ? container.parentElement.closest('.v3-rich-editor-body') : container.closest?.('.v3-rich-editor-body');
            
            if (editorBody) {
                // Approximate offset within the whole document
                const bodies = Array.from(document.querySelectorAll('.v3-rich-editor-body'));
                const bodyIdx = bodies.indexOf(editorBody);
                let offsetBefore = 0;
                for (let i = 0; i < bodyIdx; i++) offsetBefore += bodies[i].innerText.length + 1; // +1 for newline
                
                // Offset within current body
                const preRange = range.cloneRange();
                preRange.selectNodeContents(editorBody);
                preRange.setEnd(range.startContainer, range.startOffset);
                savedOffset = offsetBefore + preRange.toString().length;
                savedNodeId = 'v3-cursor-anchor';
            }
        }

        // 2. Re-render
        const currentContent = this._collectEditorContent();
        if (!force && currentContent === this._lastRenderedContent) {
            this._isRepaginating = false;
            return;
        }

        await this.renderHandEditMode(this._viewerContainer, currentContent);

        // 3. Restore State
        
        // Restore Scroll position
        const newScrollArea = document.getElementById('v3-editor-scroll');
        if (newScrollArea) {
            this._suppressEditorScrollSync = true;
            this._activePage = savedActivePage;
            newScrollArea.scrollTop = savedScrollTop;
            requestAnimationFrame(() => {
                const latestScrollArea = document.getElementById('v3-editor-scroll');
                if (latestScrollArea) latestScrollArea.scrollTop = savedScrollTop;
                this._activePage = savedActivePage;
                this.renderDashboardUI();
                this._suppressEditorScrollSync = false;
            });
        }

        // Restore Focus/Cursor (Simplified character-offset approach)
        if (savedNodeId) {
            const newBodies = Array.from(document.querySelectorAll('.v3-rich-editor-body'));
            let currentOffset = 0;
            let found = false;
            
            for (const body of newBodies) {
                const text = body.innerText;
                if (currentOffset + text.length >= savedOffset) {
                    // It's in this body
                    const relativeOffset = savedOffset - currentOffset;
                    this._setCursorAtOffset(body, relativeOffset);
                    found = true;
                    break;
                }
                currentOffset += text.length + 1;
            }
        }
        
        this._isRepaginating = false;
    },

    _addFinalEditorPage() {
        const container = document.getElementById('v3-editor-content-container');
        if (!container) return;
        const nextPageNumber = this._getLiveFinalEditorPages().length + 1;
        const page = this._createManualFinalEditorPageElement(nextPageNumber);
        container.appendChild(page);
        this._manualFinalExtraPages = Math.max(0, Number(this._manualFinalExtraPages || 0)) + 1;
        this._activePage = nextPageNumber;
        this._syncFinalEditorPageState();
        this._applyZoomToFinalEditorPage(page);
        this._editedContent = this._collectEditorContent();
        this._editedHtml = this._collectEditorHtml();
        this._markEditorUnsaved();
        const body = page.querySelector('.v3-rich-editor-body');
        if (body) {
            body.focus();
            this._setCursorAtEnd(body);
        }
        page.scrollIntoView({ block: 'center', behavior: 'smooth' });
        this._syncFinalEditorPageState();
    },

    _deleteCurrentFinalEditorPage() {
        const pages = this._getLiveFinalEditorPages();
        if (pages.length <= 1) {
            Notify.info('最後の1ページは削除できません');
            return;
        }
        const visiblePage = this._getVisibleFinalEditorPageNumber();
        const activePage = Number(visiblePage || this._activePage || pages.length);
        let target = pages.find(page => Number(page.dataset.page) === activePage) || pages[pages.length - 1];
        let pageText = String(target?.innerText || target?.textContent || '').trim();
        if (pageText) {
            const emptyExtraPage = [...pages]
                .reverse()
                .find(page => page.classList.contains('is-manual-extra-page') && !String(page.innerText || page.textContent || '').trim());
            if (emptyExtraPage) {
                target = emptyExtraPage;
                pageText = '';
            }
        }
        if (pageText) {
            Notify.warning('本文があるページは削除できません。本文を消してから削除してください');
            return;
        }
        const deletedPageNumber = Number(target.dataset.page || activePage);
        if (target.classList.contains('is-manual-extra-page') && this._manualFinalExtraPages > 0) {
            this._manualFinalExtraPages -= 1;
        }
        target.remove();
        this._activePage = Math.max(1, Math.min(deletedPageNumber - 1, pages.length - 1));
        this._syncFinalEditorPageState();
        const currentContent = this._collectEditorContent();
        this._editedContent = currentContent;
        this._markEditorUnsaved();
        const nextPage = document.querySelector(`#v3-editor-scroll .final-contract-page[data-page="${this._activePage}"]`);
        nextPage?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        this._syncFinalEditorPageState();
    },

    _createManualFinalEditorPageElement(pageNumber) {
        const page = document.createElement('div');
        page.className = `v3-editor-page final-contract-page is-manual-extra-page ${pageNumber > 1 ? 'is-continuation-page' : ''}`;
        page.dataset.page = String(pageNumber);
        page.setAttribute('onclick', 'window.signViewer._handleFreeTextPageClick(event)');
        page.setAttribute('ondblclick', 'window.signViewer._handleFreeTextPageDblClick(event)');
        page.innerHTML = `
            <div class="final-contract-page-body v3-rich-editor-body"
                 contenteditable="true"
                 spellcheck="true"
                 oninput="window.signViewer._onRichEditorInput(this)"
                 onpaste="window.signViewer._onRichEditorPaste(event, this)"
                 onkeydown="window.signViewer._onRichEditorKeyDown(event, this)"
                 oncompositionstart="window.signViewer._onRichEditorCompositionStart(event)"
                 oncompositionend="window.signViewer._onRichEditorCompositionEnd(event)"
                 onfocusout="window.signViewer._onRichEditorBlur(this)"
                 onblur="window.signViewer._onRichEditorBlur(this)"><p class="v3-editor-block type-body is-empty" spellcheck="true" data-editor-tag="p"><br data-empty-line="true"></p></div>
            ${this._renderFreeTextLayerForPage(pageNumber)}
        `;
        return page;
    },

    _applyZoomToFinalEditorPage(page) {
        if (!page?.style) return;
        const z = this._scale || 1.0;
        page.style.zoom = z;
        page.style.marginLeft = 'auto';
        page.style.marginRight = 'auto';
        page.style.transform = 'none';
        page.style.transformOrigin = 'center top';
    },

    _schedulePruneEmptyManualFinalPages() {
        if (this._pruneEmptyManualFinalPagesTimer) clearTimeout(this._pruneEmptyManualFinalPagesTimer);
        this._pruneEmptyManualFinalPagesTimer = setTimeout(() => this._pruneEmptyManualFinalPages(), 0);
    },

    _pruneEmptyManualFinalPages() {
        const pages = this._getLiveFinalEditorPages();
        if (pages.length <= 1) return false;
        let removedCount = 0;
        pages.forEach(page => {
            if (this._getLiveFinalEditorPages().length <= 1) return;
            if (!page.classList.contains('is-manual-extra-page')) return;
            if (!this._isFinalEditorPageEmpty(page)) return;
            page.remove();
            removedCount += 1;
        });
        if (!removedCount) {
            this._syncFinalEditorPageState();
            return false;
        }
        this._manualFinalExtraPages = Math.max(0, Number(this._manualFinalExtraPages || 0) - removedCount);
        this._syncFinalEditorPageState();
        this._editedContent = this._collectEditorContent();
        this._editedHtml = this._collectEditorHtml();
        return true;
    },

    _isFinalEditorPageEmpty(page) {
        if (!page) return false;
        const text = String(page.innerText || page.textContent || '')
            .replace(/\u00a0/g, ' ')
            .replace(/\u200b/g, '')
            .trim();
        if (text) return false;
        return !page.querySelector('.v3-free-text-note');
    },

    _syncFinalEditorPageState() {
        const pages = this._getLiveFinalEditorPages();
        pages.forEach((page, index) => {
            page.dataset.page = String(index + 1);
            page.classList.toggle('is-continuation-page', index > 0);
        });
        this._totalPages = Math.max(1, pages.length || Number(this._totalPages || 1));
        this._activePage = Math.max(1, Math.min(Number(this._activePage || 1), this._totalPages));
        const sidebars = Array.from(document.querySelectorAll('.v3-viewer-sidebar'));
        if (sidebars.length) {
            sidebars.forEach(sidebar => this.renderFinalThumbnails(sidebar, { force: true }));
        } else {
            this._updateFinalNavigationUi();
        }
    },

    _getLiveFinalEditorPages() {
        const root = document.getElementById('v3-editor-scroll');
        if (!root) return [];
        return Array.from(root.querySelectorAll('.final-contract-page[data-page]'));
    },

    _getVisibleFinalEditorPageNumber() {
        const scroll = document.getElementById('v3-editor-scroll');
        const pages = this._getLiveFinalEditorPages();
        if (!scroll || !pages.length || typeof scroll.getBoundingClientRect !== 'function') return null;
        const rect = scroll.getBoundingClientRect();
        const probeY = rect.top + Math.min(rect.height * 0.45, 260);
        let best = null;
        let bestDistance = Infinity;
        pages.forEach(page => {
            if (typeof page.getBoundingClientRect !== 'function') return;
            const pageRect = page.getBoundingClientRect();
            const center = pageRect.top + (pageRect.height / 2);
            const distance = Math.abs(center - probeY);
            if (distance < bestDistance) {
                bestDistance = distance;
                best = page;
            }
        });
        return best ? Number(best.dataset.page || 0) || null : null;
    },

    _bindFinalPageSyncObserver() {
        const container = document.getElementById('v3-editor-content-container');
        if (!container || container._finalPageSyncObserverBound) return;
        container._finalPageSyncObserverBound = true;
        let lastCount = this._getLiveFinalEditorPages().length;
        const scheduleSync = () => {
            if (container._finalPageSyncFrame) cancelAnimationFrame(container._finalPageSyncFrame);
            container._finalPageSyncFrame = requestAnimationFrame(() => {
                const nextCount = this._getLiveFinalEditorPages().length;
                if (nextCount !== lastCount) {
                    lastCount = nextCount;
                    this._syncFinalEditorPageState();
                }
            });
        };
        const observer = new MutationObserver(scheduleSync);
        observer.observe(container, { childList: true });
        container._finalPageSyncObserver = observer;
    },

    _setCursorAtOffset(node, offset) {
        const selection = window.getSelection();
        const range = document.createRange();
        let current = 0;
        let targetNode = node;
        let targetOffset = 0;

        const walk = (n) => {
            if (n.nodeType === 3) {
                const len = n.textContent.length;
                if (current + len >= offset) {
                    targetNode = n;
                    targetOffset = offset - current;
                    return true;
                }
                current += len;
            } else {
                for (let i = 0; i < n.childNodes.length; i++) {
                    if (walk(n.childNodes[i])) return true;
                }
            }
            return false;
        };

        walk(node);
        try {
            range.setStart(targetNode, Math.min(targetOffset, targetNode.nodeType === 3 ? targetNode.textContent.length : targetNode.childNodes.length));
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);
            targetNode.parentElement.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        } catch (e) { console.warn('[SignViewer] Cursor restore failed:', e); }
    },

    _onRichEditorCompositionStart() {
        this._isRichEditorComposing = true;
    },

    _onRichEditorCompositionEnd() {
        this._isRichEditorComposing = false;
    },

    _getSafeEditableNode(target) {
        const node = target?.nodeType === 3 ? target.parentElement : target;
        if (!node?.closest) return null;
        const root = node.closest('#v3-editor-scroll');
        if (!root) return null;
        const editable = node.closest('.v3-editor-block, p, li, td, th, h1, h2, h3, h4, h5, h6, span[contenteditable="true"], .v3-rich-editor-body[contenteditable="true"]');
        return editable && root.contains(editable) ? editable : null;
    },

    _selectionTouchesProtectedEditorNode(selection) {
        if (!selection || !selection.rangeCount || selection.isCollapsed) return false;
        const range = selection.getRangeAt(0);
        const fragment = range.cloneContents();
        return Boolean(fragment.querySelector?.('section, table, tbody, tr, ul, ol, .docx-wrapper, .editor-page-shell, .editor-page-wrapper, .v3-rich-editor-body, .v3-editor-page, .final-contract-page'));
    },

    _selectionStaysInSingleEditableBlock(selection, fallbackEditable) {
        if (!selection || !selection.rangeCount || selection.isCollapsed) return true;
        const range = selection.getRangeAt(0);
        const start = this._getSafeEditableNode(range.startContainer) || fallbackEditable;
        const end = this._getSafeEditableNode(range.endContainer) || fallbackEditable;
        return Boolean(start && end && start === end);
    },

    _isCaretAtEditableBoundary(editable, boundary) {
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount || !selection.isCollapsed || !editable) return false;
        const range = selection.getRangeAt(0);
        if (!editable.contains(range.startContainer)) return false;
        const probe = range.cloneRange();
        probe.selectNodeContents(editable);
        if (boundary === 'start') probe.setEnd(range.startContainer, range.startOffset);
        else probe.setStart(range.startContainer, range.startOffset);
        return probe.toString().length === 0;
    },

    _insertSafeEditorLineBreak() {
        if (document.queryCommandSupported?.('insertLineBreak')) {
            document.execCommand('insertLineBreak');
        } else {
            document.execCommand('insertHTML', false, '<br>');
        }
        this._saveEditorSelection();
    },

    _protectEditorStructureKey(e, editable) {
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount) return false;
        if (this._selectionTouchesProtectedEditorNode(selection)) {
            e.preventDefault();
            return true;
        }
        return false;
    },

    _onRichEditorKeyDown(e, el) {
        if (e.isComposing || this._isRichEditorComposing || e.key === 'Process') return;
        const editable = this._getSafeEditableNode(e.target);

        if ((e.key === 'Enter' || e.key === 'Backspace' || e.key === 'Delete') && !editable) {
            if (e.key !== 'Enter') return;
            this._focusFinalEditor();
        }

        if (e.key === 'Enter') {
            this._saveEditorSelection();
            setTimeout(() => this._onRichEditorInput(editable || el), 0);
            return;
        }

        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            if (this._moveEditorCaretByBlock(e.key === 'ArrowDown' ? 1 : -1)) {
                e.preventDefault();
                return;
            }
        }

        if (e.key === 'Backspace' || e.key === 'Delete') {
            if (this._protectEditorStructureKey(e, editable)) return;
            setTimeout(() => this._onRichEditorInput(editable || el), 0);
        }
    },

    _moveEditorCaretByBlock(direction) {
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount) return false;
        const root = document.getElementById('v3-editor-scroll');
        const currentNode = selection.getRangeAt(0).startContainer;
        const currentBlock = currentNode.nodeType === 1
            ? currentNode.closest?.('.v3-editor-block')
            : currentNode.parentElement?.closest?.('.v3-editor-block');
        if (!root || !currentBlock || !root.contains(currentBlock)) return false;

        const blocks = Array.from(root.querySelectorAll('.v3-editor-block'));
        const index = blocks.indexOf(currentBlock);
        const target = blocks[index + direction];
        if (!target) return false;

        this._setCursorAtVisualLine(target, direction > 0 ? 0 : Number.MAX_SAFE_INTEGER);
        target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        return true;
    },

    _setCursorAtVisualLine(block, offset) {
        const selection = window.getSelection();
        const range = document.createRange();
        const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
        const textNode = walker.nextNode();
        try {
            if (textNode) {
                range.setStart(textNode, Math.min(offset, textNode.textContent.length));
            } else {
                range.selectNodeContents(block);
                range.collapse(offset === 0);
            }
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);
            block.focus();
        } catch (error) {
            console.warn('[SignViewer] Arrow key caret move failed:', error);
        }
    },

    _setCursorAtEnd(node) {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(node);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
        node.focus();
    },

    _keepFinalEditorChromeVisible() {
        const editLayer = document.getElementById('v3-edit-layer');
        if (editLayer) editLayer.style.display = 'block';

        const toolbar = document.querySelector('#v3-edit-layer .v3-editor-toolbar');
        if (toolbar) toolbar.style.display = 'flex';

        const scrollArea = document.getElementById('v3-editor-scroll');
        if (scrollArea) scrollArea.style.display = 'block';
    },

    _onRichEditorBlur(el) {
        const nextContent = this._collectEditorContent();
        const nextHtml = this._collectEditorHtml();
        const active = this._editHistory?.[this._editHistoryIndex];
        if (nextContent !== this._getEditHistoryText(active) || nextHtml !== this._getEditHistoryHtml(active)) this._pushHistory(nextContent);
        this._editedContent = nextContent;
        this._editedHtml = nextHtml;
        this._syncUndoRedoButtons();
    },

    _getEditorSelectionRange() {
        this._restoreEditorSelection();
        const selection = window.getSelection();
        const root = document.getElementById('v3-editor-scroll');
        if (!selection || !selection.rangeCount || !root) return null;
        const range = selection.getRangeAt(0);
        return root.contains(range.commonAncestorContainer) ? range : null;
    },

    _editorStyleResetValue(prop) {
        const resetMap = {
            fontWeight: '400',
            fontStyle: 'normal',
            textDecoration: 'none',
            color: '',
            backgroundColor: '',
            textAlign: ''
        };
        return Object.prototype.hasOwnProperty.call(resetMap, prop) ? resetMap[prop] : '';
    },

    _setEditorStyleValue(element, prop, value) {
        if (!element?.style) return;
        element.style[prop] = value || '';
        if (element.getAttribute?.('style') === '') element.removeAttribute('style');
    },

    _editorStyleMatches(element, prop, expected) {
        if (!element || element.nodeType !== 1) return false;
        const computed = window.getComputedStyle(element);
        if (prop === 'fontWeight') {
            const weight = Number.parseInt(computed.fontWeight, 10);
            return expected === '700' ? weight >= 700 : computed.fontWeight === expected;
        }
        if (prop === 'fontStyle') {
            return expected === 'italic' ? computed.fontStyle === 'italic' || computed.fontStyle === 'oblique' : computed.fontStyle === expected;
        }
        if (prop === 'textDecoration') {
            const line = computed.textDecorationLine || computed.textDecoration || '';
            return String(line).split(/\s+/).includes(expected);
        }
        if (prop === 'textAlign') {
            const align = computed.textAlign || element.style.textAlign || '';
            if (expected === 'left') return align === 'left' || align === 'start';
            return align === expected;
        }
        return computed[prop] === expected || element.style?.[prop] === expected;
    },

    _getEditorTextNodesInRange(range) {
        if (!range) return [];
        const nodes = [];
        const addIfSelected = node => {
            if (!String(node.textContent || '').trim()) return;
            try {
                if (range.intersectsNode(node)) nodes.push(node);
            } catch {}
        };
        if (range.commonAncestorContainer.nodeType === Node.TEXT_NODE) {
            addIfSelected(range.commonAncestorContainer);
            return nodes;
        }
        const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) addIfSelected(walker.currentNode);
        return nodes;
    },

    _selectionHasEditorStyle(range, blocks, prop, value) {
        if (!range) return false;
        const textNodes = this._getEditorTextNodesInRange(range);
        if (textNodes.length) {
            return textNodes.every(node => this._editorStyleMatches(node.parentElement, prop, value));
        }
        if (blocks.length) return blocks.every(block => this._editorStyleMatches(block, prop, value));
        const block = this._getEditorFormatBlock(range.startContainer) || this._getSafeEditableNode(range.startContainer);
        return Boolean(block && this._editorStyleMatches(block, prop, value));
    },

    _selectionCoversWholeNode(range, node) {
        if (!range || !node) return false;
        const selectedText = String(range.cloneContents().textContent || '').replace(/\s+/g, '');
        const nodeText = String(node.innerText || node.textContent || '').replace(/\s+/g, '');
        return Boolean(nodeText && selectedText === nodeText);
    },

    _getEditorStyledTargetsInRange(range, prop) {
        const root = document.getElementById('v3-editor-scroll');
        if (!range || !root) return [];
        const targets = new Set();
        const addStyledAncestors = node => {
            let element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
            const block = this._getEditorFormatBlock(element) || root;
            while (element && element !== root && root.contains(element)) {
                if (element.style?.[prop]) targets.add(element);
                if (element === block) break;
                element = element.parentElement;
            }
        };
        addStyledAncestors(range.startContainer);
        addStyledAncestors(range.endContainer);
        const container = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
            ? range.commonAncestorContainer
            : range.commonAncestorContainer.parentElement;
        container?.querySelectorAll?.('[style]').forEach(element => {
            if (!root.contains(element) || !element.style?.[prop]) return;
            try {
                if (range.intersectsNode(element)) targets.add(element);
            } catch {}
        });
        return Array.from(targets);
    },

    _wrapEditorSelectionWithStyles(range, styles = {}) {
        const span = document.createElement('span');
        Object.entries(styles).forEach(([prop, value]) => span.style[prop] = value);
        span.appendChild(range.extractContents());
        Object.keys(styles).forEach(prop => {
            span.querySelectorAll?.('[style]').forEach(element => this._setEditorStyleValue(element, prop, ''));
        });
        range.insertNode(span);
        const selection = window.getSelection();
        const nextRange = document.createRange();
        nextRange.selectNodeContents(span);
        selection.removeAllRanges();
        selection.addRange(nextRange);
        return span;
    },

    _resetEditorStyleForSelection(range, blocks, prop) {
        const resetValue = this._editorStyleResetValue(prop);
        const wholeBlocksSelected = blocks.length > 1 || (blocks.length === 1 && this._selectionCoversWholeNode(range, blocks[0]));
        if (wholeBlocksSelected) {
            blocks.forEach(block => this._setEditorStyleValue(block, prop, resetValue));
            return blocks[0];
        }
        const styledTargets = this._getEditorStyledTargetsInRange(range, prop);
        const wholeStyledTargets = styledTargets.filter(target => this._selectionCoversWholeNode(range, target));
        if (wholeStyledTargets.length && wholeStyledTargets.length === styledTargets.length) {
            wholeStyledTargets.forEach(target => this._setEditorStyleValue(target, prop, resetValue));
            return wholeStyledTargets[0];
        }
        return this._wrapEditorSelectionWithStyles(range, { [prop]: resetValue });
    },

    _applyInlineStyleToSelection(styles = {}, options = {}) {
        const range = this._getEditorSelectionRange();
        if (!range) return false;
        const entries = Object.entries(styles);
        const canToggle = Boolean(options.toggle && entries.length === 1);
        const [toggleProp, toggleValue] = entries[0] || [];
        if (range.collapsed) {
            const block = this._getEditorFormatBlock(range.startContainer) || this._getSafeEditableNode(range.startContainer);
            if (!block) return false;
            if (canToggle && this._editorStyleMatches(block, toggleProp, toggleValue)) {
                this._setEditorStyleValue(block, toggleProp, this._editorStyleResetValue(toggleProp));
            } else {
                entries.forEach(([prop, value]) => this._setEditorStyleValue(block, prop, value));
            }
            this._recordFormatEdit(block);
            this._saveEditorSelection();
            return true;
        }
        const selectedBlocks = this._getSelectedEditorBlocks();
        if (canToggle && this._selectionHasEditorStyle(range, selectedBlocks, toggleProp, toggleValue)) {
            const changed = this._resetEditorStyleForSelection(range, selectedBlocks, toggleProp);
            this._recordFormatEdit(changed || selectedBlocks[0]);
            this._saveEditorSelection();
            return true;
        }
        if (selectedBlocks.length > 1) {
            selectedBlocks.forEach(block => {
                entries.forEach(([prop, value]) => this._setEditorStyleValue(block, prop, value));
            });
            this._recordFormatEdit(selectedBlocks[0]);
            this._saveEditorSelection();
            return true;
        }
        try {
            const span = this._wrapEditorSelectionWithStyles(range, styles);
            this._recordFormatEdit(span);
            this._saveEditorSelection();
            return true;
        } catch (error) {
            console.warn('[SignViewer] inline style apply failed:', error);
            return false;
        }
    },

    _applyStyleToSelectedBlocks(styles = {}, options = {}) {
        const blocks = this._getSelectedEditorBlocks();
        if (!blocks.length) return false;
        const entries = Object.entries(styles);
        if (options.toggle && entries.length === 1) {
            const [prop, value] = entries[0];
            const isActive = blocks.every(block => this._editorStyleMatches(block, prop, value));
            if (isActive) {
                blocks.forEach(block => this._setEditorStyleValue(block, prop, this._editorStyleResetValue(prop)));
                this._recordFormatEdit(blocks[0]);
                this._saveEditorSelection();
                return true;
            }
        }
        blocks.forEach(block => {
            entries.forEach(([prop, value]) => this._setEditorStyleValue(block, prop, value));
        });
        this._recordFormatEdit(blocks[0]);
        this._saveEditorSelection();
        return true;
    },

    _clearSelectedFormatting() {
        const range = this._getEditorSelectionRange();
        const root = document.getElementById('v3-editor-scroll');
        if (!range || !root) return false;
        const blocks = this._getSelectedEditorBlocks();
        blocks.forEach(block => {
            ['fontSize', 'fontWeight', 'fontStyle', 'textDecoration', 'color', 'backgroundColor', 'textAlign', 'lineHeight'].forEach(prop => {
                block.style[prop] = '';
            });
        });
        const container = range.commonAncestorContainer.nodeType === 1
            ? range.commonAncestorContainer
            : range.commonAncestorContainer.parentElement;
        container?.querySelectorAll?.('span').forEach(span => {
            if (!range.intersectsNode(span)) return;
            const text = document.createTextNode(span.textContent || '');
            span.replaceWith(text);
        });
        this._recordFormatEdit(blocks[0] || container);
        this._saveEditorSelection();
        return true;
    },

    _recordFormatEdit(scope = null) {
        if (this._repaginateTimeout) {
            clearTimeout(this._repaginateTimeout);
            this._repaginateTimeout = null;
        }
        this._editedContent = this._collectEditorContent();
        this._editedHtml = this._collectEditorHtml();
        this._pushHistory(this._editedContent);
        this._markEditorUnsaved();
        this._syncUndoRedoButtons();
    },

    _runEditorCommand(command, value = null) {
        const inlineMap = {
            bold: { fontWeight: '700' },
            italic: { fontStyle: 'italic' },
            underline: { textDecoration: 'underline' },
            strikeThrough: { textDecoration: 'line-through' }
        };
        if (inlineMap[command] && this._applyInlineStyleToSelection(inlineMap[command], { toggle: true })) return;
        if (command === 'foreColor' && this._applyInlineStyleToSelection({ color: value || '#111111' })) return;
        if (command === 'hiliteColor' && this._applyInlineStyleToSelection({ backgroundColor: value || '#fff3bf' })) return;
        if (command === 'removeFormat' && this._clearSelectedFormatting()) return;
        const alignMap = {
            justifyLeft: 'left',
            justifyCenter: 'center',
            justifyRight: 'right',
            justifyFull: 'justify'
        };
        if (alignMap[command] && this._applyStyleToSelectedBlocks({ textAlign: alignMap[command] }, { toggle: true })) return;
        this._restoreEditorSelection();
        this._focusFinalEditor();
        document.execCommand('styleWithCSS', false, true);
        const ok = document.execCommand(command, false, value);
        if (!ok && command === 'hiliteColor') document.execCommand('backColor', false, value);
        this._normalizeEditorFontTags();
        this._onRichEditorInput();
        this._saveEditorSelection();
    },

    _setEditorBlockFormat(tagName) {
        this._runEditorCommand('formatBlock', `<${tagName || 'P'}>`);
    },

    _setSelectedFontSize(value) {
        const size = Math.min(32, Math.max(12, Number(value) || this._getFinalEditorFontSize()));
        this._restoreEditorSelection();
        const selection = window.getSelection();
        const hasSelection = selection && selection.rangeCount && !selection.isCollapsed;
        if (!hasSelection) {
            const blocks = this._getSelectedEditorBlocks();
            if (blocks.length) {
                blocks.forEach(block => block.style.fontSize = `${size}px`);
                this._recordFormatEdit(blocks[0]);
                this._saveEditorSelection();
                return;
            }
            this._setFinalEditorFontSize(size);
            return;
        }
        if (this._applyInlineStyleToSelection({ fontSize: `${size}px` })) return;
        this._focusFinalEditor();
        document.execCommand('fontSize', false, '7');
        document.querySelectorAll('#v3-editor-scroll font[size="7"]').forEach(el => {
            const span = document.createElement('span');
            span.style.fontSize = `${size}px`;
            span.innerHTML = el.innerHTML;
            el.replaceWith(span);
        });
        this._onRichEditorInput();
        this._saveEditorSelection();
    },

    _normalizeEditorFontTags() {
        document.querySelectorAll('#v3-editor-scroll font').forEach(el => {
            const span = document.createElement('span');
            [...el.attributes].forEach(attr => {
                if (attr.name.toLowerCase() !== 'size') span.setAttribute(attr.name, attr.value);
            });
            span.innerHTML = el.innerHTML;
            el.replaceWith(span);
        });
    },

    _onBlockInput(el) {
        const toolbarBadge = document.querySelector('.v3-status-badge');
        if (toolbarBadge && !toolbarBadge.classList.contains('unsaved')) {
            toolbarBadge.classList.add('unsaved');
            toolbarBadge.style.background = '#fef3c7';
            toolbarBadge.style.color = '#d97706';
            toolbarBadge.innerText = '● 未保存';
        }
    },

    _onBlockBlur(el) {
        const blocks = Array.from(document.querySelectorAll('#v3-editor-scroll .v3-editor-block'));
        if (!blocks.length) return;
        const nextContent = blocks.map(b => b.innerText).join('\n');
        
        if (nextContent !== this._editedContent && nextContent !== this._getEditHistoryText(this._editHistory?.[this._editHistoryIndex])) {
            this._pushHistory(nextContent);
            this._editedContent = nextContent;
            // Re-render toolbar state only (not full re-render to avoid losing focus)
            const badge = document.querySelector('.v3-editor-toolbar span[style*="color"]');
            if (badge && badge.style) {
                badge.style.background = '#fef3c7';
                badge.style.color = '#d97706';
                badge.textContent = '● 未保存';
            }
        }
    },

    _pushHistory(content) {
        if (!this._editHistory) this._editHistory = [];
        if (this._editCaptureTimeout) {
            clearTimeout(this._editCaptureTimeout);
            this._editCaptureTimeout = null;
        }
        if (this._editHistoryIndex < this._editHistory.length - 1) {
            this._editHistory = this._editHistory.slice(0, this._editHistoryIndex + 1);
        }
        this._editHistory.push(this._createEditHistorySnapshot(content));
        if (this._editHistory.length > 30) this._editHistory.shift();
        this._editHistoryIndex = this._editHistory.length - 1;
    },

    _createEditHistorySnapshot(content = null) {
        const text = content !== null && content !== undefined ? String(content) : this._collectEditorContent();
        const stack = document.getElementById('v3-editor-content-container');
        return {
            text,
            html: this._isFinalEditorVisible() ? this._collectEditorHtml() : String(this._editedHtml || ''),
            pageStackHtml: stack ? stack.innerHTML : ''
        };
    },

    _getEditHistoryText(entry) {
        return typeof entry === 'string' ? entry : String(entry?.text || '');
    },

    _getEditHistoryHtml(entry) {
        return typeof entry === 'object' && entry ? String(entry.html || '') : '';
    },

    _applyEditHistorySnapshot(entry) {
        const text = this._getEditHistoryText(entry);
        const html = this._getEditHistoryHtml(entry);
        const pageStackHtml = typeof entry === 'object' && entry ? String(entry.pageStackHtml || '') : '';
        const stack = document.getElementById('v3-editor-content-container');
        if (stack && pageStackHtml) {
            stack.innerHTML = pageStackHtml;
            this._editedContent = text;
            this._editedHtml = html;
            this._bindFinalEditorToolbar();
            this._syncUndoRedoButtons();
            this.renderDashboardUI();
            return;
        }
        this._editedContent = text;
        this._editedHtml = html;
        this.renderHandEditMode(this._viewerContainer, text);
    },

    async _saveHandEdit({ rerender = false, renderGenerated = false, showFinal = false } = {}) {
        // Regression marker: async _saveHandEdit({ rerender = true, renderGenerated = false } = {})
        this._normalizeFinalEditorDomBeforeSave();
        const collectedContent = this._collectEditorContent();
        const finalContent = this._materializeAppliedFinalContent(collectedContent);
        const finalHtml = finalContent === collectedContent ? this._collectEditorHtml() : '';
        const freeTextNotes = this._collectFinalFreeTextNotes();
        
        this._editedContent = finalContent;
        this._editedHtml = finalHtml;
        this._editedFreeTextNotes = freeTextNotes;
        this._lastSavedContent = finalContent;
        this._manualFinalExtraPages = 0;
        
        if (this._contract) {
            this._contract.final_content = finalContent;
            this._contract.final_content_html = finalHtml;
            this._contract.final_free_text_notes = freeTextNotes;
            dbService.updateContract(this._contract.id, {
                final_content: finalContent,
                final_content_html: finalHtml,
                final_free_text_notes: freeTextNotes,
                final_font_size: this._getFinalEditorFontSize()
            });
        }

        this._finalLayoutGuardActive = false;
        this._finalRecoveredFromOriginal = false;
        this._lastRecoveredFinalContent = '';
        this._viewMode = 'edit';
        this._keepFinalEditorChromeVisible();
        const badge = document.querySelector('.v3-status-badge');
        if (badge) {
            badge.classList.remove('unsaved');
            badge.style.background = '#dcfce7';
            badge.style.color = '#166534';
            badge.textContent = '● 保存済み';
        }
        Notify.success('最終版を保存しました');
        
        if (renderGenerated) {
            const generated = await this._renderGeneratedFinalPdf(finalContent);
            if (generated) {
                return finalContent;
            }
            if (this._finalLayoutGuardActive) {
                return finalContent;
            }
        }
        if (rerender) {
            await this.renderHandEditMode(this._viewerContainer, finalContent);
        }
        if (showFinal) {
            this._viewMode = 'final';
            this.renderFinalReadMode(this._viewerContainer, { showToolbar: false });
            this._setOriginalViewerBottomSpace(false);
            this._renderFinalActionBar();
            this._resetFinalTabScrollPosition();
        }
        return finalContent;
    },

    async _renderGeneratedFinalPdf(finalContent = this._getFinalDocumentText(), options = {}) {
        const isDocxSource = this._isOriginalDocxContract();
        const allowHtmlFallback = options.allowHtmlFallback ?? !isDocxSource;
        const renderGuard = options.renderGuard ?? false;
        this._finalLayoutGuardActive = false;

        try {
            let pdfBlob = null;
            let validation = null;

            if (isDocxSource) {
                const revisionsForSourceLayout = this._buildFinalDocxRevisions(finalContent);
                const hasManualOnlyChanges = this._hasManualOnlyFinalChanges(finalContent);
                if (hasManualOnlyChanges && !revisionsForSourceLayout.length) {
                    if (renderGuard) {
                        Notify.warning('原本レイアウトPDFは作成できませんでした。編集内容は保存済みです。');
                    }
                    return false;
                }

                if (revisionsForSourceLayout.length || this._canGenerateSourceLayoutFinal(finalContent)) {
                    validation = await this._generateValidatedFinalDocxPdf(finalContent);
                    pdfBlob = validation.blob;
                    if (!pdfBlob && !allowHtmlFallback) {
                        if (renderGuard) {
                            console.warn('[SignViewer] Source-layout final PDF unavailable:', validation.reason);
                            Notify.warning('原本レイアウトPDFは作成できませんでした。編集内容は保存済みです。');
                        } else {
                            Notify.warning(validation.reason || 'DOCX最終版PDFの生成に失敗しました。');
                        }
                        return false;
                    }
                }
            }

            if (!pdfBlob && allowHtmlFallback) {
                pdfBlob = await this._generateFinalPdf(finalContent).catch(error => {
                    console.warn('[SignViewer] final HTML PDF fallback failed:', error);
                    return null;
                });
            }

            if (!pdfBlob) {
                if (!isDocxSource) {
                    Notify.warning('PDF生成に失敗しました。編集内容は保存済みです。');
                }
                this._viewMode = 'final';
                this.renderFinalReadMode(this._viewerContainer);
                return false;
            }

            if (this._finalGeneratedPdfUrl) URL.revokeObjectURL(this._finalGeneratedPdfUrl);
            this._finalGeneratedPdfUrl = URL.createObjectURL(pdfBlob);
            this._currentDownloadUrl = this._finalGeneratedPdfUrl;
            this._currentPdfUrl = this._finalGeneratedPdfUrl;
            this._objectUrls.push(this._finalGeneratedPdfUrl);
            this._lastGeneratedFinalContent = finalContent;
            this._finalRecoveredFromOriginal = false;
            this._lastRecoveredFinalContent = '';
            this._finalLayoutValidation = {
                source: isDocxSource && validation?.blob ? 'docx' : 'html',
                originalPageCount: validation?.originalPageCount || this._getOriginalPageCount(),
                generatedPageCount: validation?.generatedPageCount || null
            };

            const editLayer = document.getElementById('v3-edit-layer');
            if (editLayer) editLayer.style.display = 'none';
            document.querySelectorAll('.v3-final-applied-overlay').forEach(node => node.remove());
            this._viewMode = 'final';
            this._setFinalActionBarVisible(false);
            await this.renderPdf(this._finalGeneratedPdfUrl, this._viewerContainer);
            this.renderDashboardUI();
            this._renderFinalActionBar();
            // ツールバーのrenderDashboardUIがプレビュー・編集するボタンを自動表示する
            document.getElementById('v3-saved-action-bar')?.remove();
            return true;
        } catch (error) {
            console.warn('[SignViewer] final PDF generation failed:', error);
            if (isDocxSource && renderGuard) {
                Notify.warning('原本レイアウトPDFは作成できませんでした。編集内容は保存済みです。');
            } else {
                Notify.warning('PDF生成に失敗しました。編集内容は保存済みです。');
            }
            return false;
        }
    },

    async _previewHandEdit() {
        // In read mode there's no editor DOM — fall back to stored final text
        // すべての中間値を確実に string化 ([object Object] 出力bug防止)
        const safeStr = (v) => {
            if (v == null) return '';
            if (typeof v === 'string') return v;
            if (Array.isArray(v)) return v.map(x => typeof x === 'string' ? x : (x?.text || x?.content || String(x))).join('\n');
            if (typeof v === 'object') return v.text || v.content || JSON.stringify(v);
            return String(v);
        };
        const fromEditor = this._isFinalEditorVisible() ? safeStr(this._collectEditorContent()) : '';
        const finalContent = (fromEditor && fromEditor.trim()) ? fromEditor : safeStr(this._getFinalDocumentText());
        this._editedContent = finalContent;
        this._editedHtml = this._isFinalEditorVisible() ? this._collectEditorHtml() : this._getFinalDocumentHtml();
        this._lastPreviewContent = finalContent;
        this._finalLayoutGuardActive = false;
        const cleanContent = safeStr(this._buildCleanFinalContent(finalContent));
        const surfaceHtml = await this._renderFinalEditorSurfaceHtml(cleanContent, null);
        this._openFinalPreviewOverlay(cleanContent, surfaceHtml);
    },

    _openFinalPreviewOverlay(finalContent, surfaceHtml = '') {
        document.getElementById('final-preview-overlay')?.remove();
        const overlay = document.createElement('div');
        overlay.id = 'final-preview-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.65);z-index:99999;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;';
        overlay.innerHTML = `
            <div style="background:#fff;border-radius:12px;width:min(1100px,96vw);height:min(92vh,980px);display:flex;flex-direction:column;box-shadow:0 24px 64px rgba(0,0,0,0.28);overflow:hidden;">
                <div style="height:56px;display:flex;align-items:center;justify-content:space-between;padding:0 20px;background:#0b2d62;color:#fff;flex-shrink:0;">
                    <div style="display:flex;align-items:center;gap:10px;font-weight:800;font-size:14px;">
                        <i class="fa-solid fa-eye"></i>
                        <span>最終版プレビュー</span>
                    </div>
                    <div style="display:flex;align-items:center;gap:14px;">
                        <button onclick="window.signViewer.printDocument()" style="background:none;border:none;padding:4px;display:flex;align-items:center;justify-content:center;color:#fff;cursor:pointer;opacity:0.85;transition:all 0.2s;" onmouseover="this.style.opacity='1';this.style.transform='scale(1.1)'" onmouseout="this.style.opacity='0.85';this.style.transform='scale(1)'" title="印刷">
                            <i class="fa-solid fa-print" style="font-size:18px;"></i>
                        </button>
                        <button onclick="window.signViewer.openDownloadMenu(event)" style="background:none;border:none;padding:4px;display:flex;align-items:center;justify-content:center;color:#fff;cursor:pointer;opacity:0.85;transition:all 0.2s;" onmouseover="this.style.opacity='1';this.style.transform='scale(1.1)'" onmouseout="this.style.opacity='0.85';this.style.transform='scale(1)'" title="ダウンロード">
                            <i class="fa-solid fa-download" style="font-size:18px;"></i>
                        </button>
                        <div style="width:1px;height:20px;background:rgba(255,255,255,0.2);margin:0 4px;"></div>
                        <button onclick="document.getElementById('final-preview-overlay')?.remove()" style="width:32px;height:32px;border-radius:8px;border:none;background:rgba(255,255,255,0.14);color:#fff;cursor:pointer;font-size:18px;line-height:1;display:flex;align-items:center;justify-content:center;transition:background 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.25)'" onmouseout="this.style.background='rgba(255,255,255,0.14)'">×</button>
                    </div>
                </div>
                <div style="flex:1;min-height:0;position:relative;background:#f1f5f9;">
                    ${this._getDocumentLayoutCss()}
                    <style>
                        #final-preview-overlay .v3-rich-editor-body,
                        #final-preview-overlay .v3-editor-block { pointer-events:none; caret-color:transparent; }
                        /* 編集モード (.v3-pdf-sheet p { margin: 0 0 8px }) と段落間隔を統一 */
                        #final-preview-overlay p,
                        #final-preview-overlay .v3-editor-block { margin: 0 0 8px !important; }
                    </style>
                    <div class="v3-document-scroll-area" style="height:100%;padding-top:24px;">
                        <div class="v3-document-page-stack">
                            ${surfaceHtml || this._renderFinalPreviewPagesHtml(finalContent)}
                        </div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
    },

    renderFinalPreviewMode(container) {
        const editLayer = document.getElementById('v3-edit-layer');
        if (!editLayer) return;
        const finalContent = String(this._lastPreviewContent || this._getFinalDocumentText());

        editLayer.innerHTML = `
            ${this._getDocumentLayoutCss()}
            <div class="v3-document-scroll-area" id="v3-final-preview-scroll">
                <div class="v3-document-page-stack">
                    ${this._renderDocumentPagesHtml(finalContent, {
                        editable: false,
                        showRevisionMarks: false,
                        markChangedLines: false,
                        markApplied: true,
                        targetPageCount: this._getOriginalPageCount()
                    })}
                </div>
            </div>
        `;
        this.hideViewerLoader();
        this.renderDashboardUI();
    },

    // 最終版タブの閲覧ビュー（「編集する」ボタンのみ表示）
    renderFinalReadMode(container, { showToolbar = true } = {}) {
        const editLayer = document.getElementById('v3-edit-layer');
        if (!editLayer) return;
        // ensure editLayer is visible and PDF layer is hidden
        editLayer.style.display = 'block';
        const pdfLayer = document.getElementById('pdf-pages-container');
        if (pdfLayer) pdfLayer.style.display = 'none';
        const finalContent = this._getFinalDocumentText();

        editLayer.innerHTML = `
            ${this._getDocumentLayoutCss()}
            <div style="width:100%;height:100%;display:flex;flex-direction:column;">
                <div style="position:sticky;top:0;z-index:100;display:${showToolbar ? 'flex' : 'none'};
                            align-items:center;justify-content:flex-end;gap:8px;
                            padding:8px 16px;background:#fff;
                            border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,0.08);
                            width:900px;max-width:calc(100vw - 32px);
                            margin:8px auto 12px auto;box-sizing:border-box;min-height:48px;">
                    <button onclick="window.signViewer.switchViewMode('edit')"
                        style="display:inline-flex;align-items:center;gap:6px;
                               padding:6px 18px;border-radius:8px;border:none;cursor:pointer;
                               background:#0b2d62;color:#fff;font-size:13px;font-weight:700;
                               box-shadow:0 2px 8px rgba(11,45,98,0.18);">
                        <i class="fa-solid fa-pen"></i> 編集する
                    </button>
                </div>
                <div class="v3-document-scroll-area" id="v3-final-read-scroll">
                    <div class="v3-document-page-stack">
                        ${this._renderDocumentPagesHtml(finalContent, {
                            editable: false,
                            showRevisionMarks: false,
                            markChangedLines: false,
                            markApplied: true,
                            targetPageCount: this._getOriginalPageCount()
                        })}
                    </div>
                </div>
            </div>
        `;
        this.hideViewerLoader();
        this.renderDashboardUI();
    },

    _undoEdit() {
        // If there are unsaved changes NOT in history, capture them first so we can redo back to them
        this._captureCurrentEditForHistory(); 
        
        if (!this._editHistory || this._editHistoryIndex <= 0) {
            Notify.info('これ以上戻せません');
            return;
        }
        this._editHistoryIndex--;
        this._applyEditHistorySnapshot(this._editHistory[this._editHistoryIndex]);
    },

    _redoEdit() {
        if (!this._editHistory || this._editHistoryIndex >= this._editHistory.length - 1) return;
        this._editHistoryIndex++;
        this._applyEditHistorySnapshot(this._editHistory[this._editHistoryIndex]);
    },

    _showEditDiff() {
        const contract = this._contract || {};
        const originalText = String(contract.original_content || contract.extracted_text || '');
        const textarea = document.getElementById('hand-edit-textarea');
        const editedText = textarea ? textarea.value : (this._editedContent || '');
        if (!originalText && !editedText) { Notify.info('比較するテキストがありません'); return; }
        const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        const origLines = originalText.split('\n');
        const editLines = editedText.split('\n');
        const origSet = new Set(origLines.map(l => l.trim()).filter(Boolean));
        const editSet = new Set(editLines.map(l => l.trim()).filter(Boolean));
        const addedCount = editLines.filter(l => l.trim() && !origSet.has(l.trim())).length;
        const removedLines = origLines.filter(l => l.trim() && !editSet.has(l.trim()));
        const diffHtml = editLines.map(line => {
            const t = line.trim();
            if (!t) return '<div style="height:5px;"></div>';
            if (!origSet.has(t)) {
                return `<div style="background:#dcfce7;border-left:3px solid #16a34a;padding:4px 12px;margin:2px 0;font-size:13px;line-height:1.8;color:#166534;">・・${esc(t)}</div>`;
            }
            return `<div style="padding:4px 12px;margin:2px 0;font-size:13px;line-height:1.8;color:#374151;">${esc(t)}</div>`;
        }).join('');
        const removedHtml = removedLines.length > 0 ? `
            <div style="margin-top:16px;padding:12px 16px;background:#fff5f5;border-radius:8px;border:1px solid #fecaca;">
                <div style="font-size:12px;font-weight:700;color:#dc2626;margin-bottom:8px;">削除された行（${removedLines.length}件）</div>
                ${removedLines.map(l => `<div style="font-size:13px;line-height:1.8;color:#991b1b;padding:2px 0;">・・${esc(l.trim())}</div>`).join('')}
            </div>` : '';
        document.getElementById('edit-diff-overlay')?.remove();
        const overlay = document.createElement('div');
        overlay.id = 'edit-diff-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;';
        overlay.innerHTML = `
            <div style="background:#fff;border-radius:12px;width:100%;max-width:820px;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 24px 64px rgba(0,0,0,0.3);overflow:hidden;">
                <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 24px;background:#0b2d62;flex-shrink:0;">
                    <div style="display:flex;align-items:center;gap:10px;">
                        <span style="font-size:14px;font-weight:800;color:#fff;">差分表示</span>
                        ${addedCount > 0 ? `<span style="font-size:12px;background:#dcfce7;color:#166534;padding:2px 8px;border-radius:10px;font-weight:700;">+${addedCount}行追加</span>` : ''}
                        ${removedLines.length > 0 ? `<span style="font-size:12px;background:#fee2e2;color:#991b1b;padding:2px 8px;border-radius:10px;font-weight:700;">−${removedLines.length}行削除</span>` : ''}
                        ${addedCount === 0 && removedLines.length === 0 ? `<span style="font-size:12px;color:rgba(255,255,255,0.7);">変更なし</span>` : ''}
                    </div>
                    <button onclick="document.getElementById('edit-diff-overlay').remove()" style="width:30px;height:30px;border-radius:6px;border:none;background:rgba(255,255,255,0.15);color:#fff;cursor:pointer;font-size:16px;line-height:1;">×</button>
                </div>
                <div style="flex:1;overflow-y:auto;padding:20px 24px;background:#f8fafc;">
                    <div style="background:#fff;border-radius:8px;padding:20px;box-shadow:0 1px 4px rgba(0,0,0,0.06);">
                        ${diffHtml}
                        ${removedHtml}
                    </div>
                </div>
            </div>`;
        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
        document.body.appendChild(overlay);
    },

    _openRevisionPreview() {
        const contract = this._contract || {};
        const aiChanges = Array.isArray(contract.ai_changes) ? contract.ai_changes.filter(Boolean) : [];

        // Helper: convert any content type (string/object/array) to plain text
        const toText = (c) => {
            if (!c) return '';
            if (typeof c === 'string') return c;
            if (Array.isArray(c)) return c.map(item => {
                if (typeof item === 'string') return item;
                if (!item || typeof item !== 'object') return '';
                const art = String(item.article || item.articleNumber || '');
                const paras = Array.isArray(item.paragraphs)
                    ? item.paragraphs.map(p => typeof p === 'string' ? p : String(p.content || p.body || '')).join('\n')
                    : String(item.body || item.content || '');
                return [art, paras].filter(Boolean).join('\n\n');
            }).filter(Boolean).join('\n\n');
            if (typeof c === 'object' && Array.isArray(c.articles))
                return c.articles.map(a => String(a.content || a.body || '')).join('\n');
            try { return JSON.stringify(c); } catch { return ''; }
        };
        // Build revised full text: start from ai_final_document, or apply changes to original
        let docText = toText(contract.ai_final_document);
        if (!docText) {
            docText = toText(contract.original_content || contract.extracted_text || contract.content || contract.text);
            // Apply each change: replace old text with new text
            aiChanges.forEach(c => {
                const oldStr = (c.old || c.original || '').trim();
                const newStr = (c.new || c.modified || c.modifiedText || c.suggestion || '').trim();
                if (oldStr && newStr && docText && docText.includes(oldStr)) {
                    docText = docText.replace(oldStr, `\x00REV\x00${newStr}\x00/REV\x00`);
                }
            });
        }

        // Fallback: build preview from ai_changes alone when no full document text is available
        if (!docText && aiChanges.length > 0) {
            docText = aiChanges.map((c, i) => {
                let section = this._getChangeDisplaySection(c, i);
                const articlePart = section.match(/第\s*[0-9０-９零〇一二三四五六七八九十百千]+\s*[条項]/);
                if (articlePart) section = articlePart[0];
                section = section.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
                const oldStr = (c.old || c.original || '').trim();
                const newStr = this._isAdditionChange(c)
                    ? this._buildLegalInsertionText(c)
                    : (c.new || c.modified || c.modifiedText || c.suggestion || '').trim();
                const lines = [`【${section}】`];
                if (oldStr) lines.push(`修正前：${oldStr}`);
                if (newStr) lines.push(`\x00REV\x00修正後：${newStr}\x00/REV\x00`);
                return lines.join('\n');
            }).join('\n\n');
        }
        if (!docText) { Notify.info('プレビュー用のテキストデータがありません'); return; }

        const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        const renderLine = (line) => {
            const trimmed = line.trim();
            if (!trimmed) return '<div style="height:8px;"></div>';
            const isBold = /^第[0-9０-９零〇一二三四五六七八九十百千]+条|^【|^■/.test(trimmed);
            let safe;
            if (trimmed.includes('\x00REV\x00')) {
                safe = esc(trimmed).replace(/\x00REV\x00([\s\S]*?)\x00\/REV\x00/g,
                    (_, t) => `<mark style="background:#bbf7d0;border-radius:3px;padding:1px 3px;font-weight:600;">${t}</mark>`);
            } else {
                safe = esc(trimmed);
            }
            return `<p style="margin:0 0 8px;line-height:2;font-size:14px;${isBold?'font-weight:700;color:#0f172a;margin-top:24px;padding-bottom:4px;border-bottom:1px solid #e2e8f0;':'color:#1e293b;'}">${safe}</p>`;
        };

        const docHtml = docText.split('\n').map(renderLine).join('');

        const overlay = document.createElement('div');
        overlay.id = 'revision-preview-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;';
        overlay.innerHTML = `
            <div style="background:#fff;border-radius:12px;width:100%;max-width:820px;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 24px 64px rgba(0,0,0,0.3);overflow:hidden;">
                <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 24px;background:#0b2d62;flex-shrink:0;">
                    <div style="display:flex;align-items:center;gap:10px;">
                        <span style="font-size:14px;font-weight:800;color:#fff;">修正案のレビュー</span>
                        ${aiChanges.length > 0 ? `<span style="font-size:12px;background:#fef3c7;color:#d97706;padding:2px 10px;border-radius:10px;font-weight:700;">${aiChanges.length}件の修正案</span>` : ''}
                        <span style="font-size:12px;color:rgba(255,255,255,0.6);">対象箇所が修正・追加済み</span>
                    </div>
                    <button onclick="document.getElementById('revision-preview-overlay').remove()" style="width:30px;height:30px;border-radius:6px;border:none;background:rgba(255,255,255,0.15);color:#fff;cursor:pointer;font-size:16px;line-height:1;">×</button>
                </div>
                <div style="flex:1;overflow-y:auto;background:#f8fafc;padding:0;">
                    <div style="max-width:700px;margin:32px auto;background:#fff;border-radius:8px;padding:48px 56px;box-shadow:0 2px 12px rgba(0,0,0,0.06);font-family:'Noto Sans JP',sans-serif;min-height:600px;">
                        ${docHtml}
                    </div>
                </div>
            </div>`;
        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
        document.body.appendChild(overlay);
    },

        renderModifiedDocument(container) {
        const contract = this._contract || {};
        const clauses = contract.ai_clauses || [];
        const aiChanges = this._getSortedAiChanges();
        const revisedLayer = document.getElementById('v3-revised-layer');
        if (!revisedLayer) return;
        // PDF原本(画像のみ)contract判定 (function-level scope に置き map内/outer両方から参照可能)
        const _isImageOnlyForRevised = this._isImageOnlyContract();

        if (clauses.length === 0 && aiChanges.length === 0) {
            revisedLayer.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#94a3b8;font-size:14px;">修正案データがありません</div>`;
            return;
        }

        let contentHtml = '';
        if (aiChanges.length > 0) {
            const charDiff = (oldStr, newStr) => {
                const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
                const newEsc = esc(newStr);
                if (!oldStr || !oldStr.trim()) return `<span style="color:#dc2626;">${newEsc.replace(/\n/g,'<br>')}</span>`;
                const o = [...oldStr], n = [...newStr];
                const m = o.length, nl = n.length;
                if (m * nl > 200000) return newEsc.replace(/\n/g,'<br>');
                let prev = new Int32Array(nl + 1), curr = new Int32Array(nl + 1);
                const table = [prev];
                for (let i = 1; i <= m; i++) {
                    curr = new Int32Array(nl + 1);
                    for (let j = 1; j <= nl; j++)
                        curr[j] = o[i-1] === n[j-1] ? table[i-1][j-1] + 1 : Math.max(table[i-1][j], curr[j-1]);
                    table.push(curr);
                }
                const result = [];
                let i = m, j = nl;
                while (i > 0 || j > 0) {
                    if (i > 0 && j > 0 && o[i-1] === n[j-1]) { result.unshift({c: n[j-1], a: false}); i--; j--; }
                    else if (j > 0 && (i === 0 || table[i][j-1] >= table[i-1][j])) { result.unshift({c: n[j-1], a: true}); j--; }
                    else i--;
                }
                let html = '', inAdd = false;
                for (const x of result) {
                    const ch = esc(x.c);
                    if (x.a && !inAdd) { html += '<span style="color:#dc2626;font-weight:600;">'; inAdd = true; }
                    else if (!x.a && inAdd) { html += '</span>'; inAdd = false; }
                    html += ch === '\n' ? '<br>' : ch;
                }
                if (inAdd) html += '</span>';
                return html;
            };

            this._appliedChanges = this._getStoredAppliedChangeIndexes();
            const _applied = this._appliedChanges;
            this._sortedChanges = aiChanges;
            const escText = (value) => String(value || '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/\n/g, '<br>');

            contentHtml = aiChanges.map((c, i) => {
                const sectionRaw = this._getChangeDisplaySection(c, i);
                c.__diffsenseDisplayedSection = sectionRaw;
                let section = escText(sectionRaw);
                const articlePart = section.match(/第\s*[0-9０-９零〇一二三四五六七八九十百千]+\s*[条項]/);
                if (articlePart) {
                    section = articlePart[0];
                }
                section = section.replace(/<br>/g, ' ').replace(/\s+/g, ' ').trim();
                const oldRaw = this._getChangeOldText(c);
                const newRaw = this._buildLegalInsertionText(c);
                const oldText = escText(oldRaw);
                const newDiffHtml = charDiff(oldRaw, newRaw);
                const reason = escText(c.reason || '');
                const concern = escText(c.concern || '');
                const impact = escText(c.impact || '');
                const isApplied = _applied.has(i);
                
                const riskText = escText(c.concern || c.reason || '契約上の不利益を抑えるため、条項の明確化が必要です。');
                const type = String(c.type || '').toUpperCase();
                const isAddition = type === 'ADD' || (!oldRaw && newRaw);
                const isDeletion = type === 'DELETE' || (oldRaw && !newRaw);
                const isClarification = impact.includes('明確') || riskText.includes('明確') || riskText.includes('解釈');

                let labelText = '修正案';
                let badgeColor = '#3b82f6';
                let accentColor = '#3b82f6';
                let icon = 'fa-solid fa-pen-nib';

                if (isAddition) {
                    labelText = '追記案';
                    badgeColor = '#6366f1';
                    accentColor = '#6366f1';
                    icon = 'fa-solid fa-plus';
                } else if (isDeletion) {
                    labelText = '削除案';
                    badgeColor = '#ef4444';
                    accentColor = '#ef4444';
                    icon = 'fa-solid fa-trash-can';
                } else if (isClarification) {
                    labelText = '明確化';
                    badgeColor = '#06b6d4';
                    accentColor = '#06b6d4';
                    icon = 'fa-solid fa-sparkles';
                }

                const targetLabel = isAddition ? '追加先' : '対象条項';
                const proposalIntro = isDeletion 
                    ? 'このリスクを回避するため、次の文言の削除を提案します。最終版エディタで該当箇所を手動削除してください。'
                    : (isAddition ? 'このリスクを抑えるため、次の条項を追加することを提案します。' : 'このリスクを抑えるため、次の文言へ修正することを提案します。');

                const riskLevel = Number(c.riskLevel || c.risk_level || 2);
                const priorityLabel = riskLevel >= 3 ? '高' : (riskLevel === 1 ? '低' : '中');
                const priorityColor = riskLevel >= 3 ? '#ef4444' : (riskLevel === 1 ? '#64748b' : '#f59e0b');

                return `
                <div style="margin-bottom:32px; background:#fff; border:1px solid #e2e8f0; border-radius:16px; overflow:hidden; box-shadow:0 8px 30px rgba(0,0,0,0.04); transition:all 0.3s ease;">
                    <div style="background:#fcfdfe; padding:16px 24px; border-bottom:1px solid #f1f5f9; display:flex; align-items:center; justify-content:space-between;">
                        <div style="display:flex; align-items:center; gap:12px;">
                            <div style="background:${badgeColor}; color:#fff; padding:4px 12px; border-radius:8px; font-size:11px; font-weight:900; display:flex; align-items:center; gap:6px; box-shadow:0 2px 8px ${badgeColor}30;">
                                <i class="${icon}"></i> ${labelText} ${i + 1}
                            </div>
                            <span style="font-size:15px; font-weight:800; color:#0f172a;">${targetLabel}: <span style="color:${badgeColor};">${section}</span></span>
                        </div>
                        <div style="display:flex; align-items:center; gap:8px;">
                            ${isApplied ? `
                            <button type="button" onclick="window.signViewer.switchViewMode('final')" style="border:1px solid #bfdbfe; background:#eff6ff; color:#1d4ed8; padding:4px 12px; border-radius:20px; font-size:12px; font-weight:900; cursor:pointer; display:inline-flex; align-items:center; gap:6px;">
                                <i class="fa-solid fa-file-circle-check"></i> 最終版に反映済み
                            </button>` : ''}
                            <div style="display:flex; align-items:center; gap:8px; font-size:12px; font-weight:800; color:#64748b; background:#f1f5f9; padding:4px 12px; border-radius:20px;">
                                重要度 <span style="color:${priorityColor};">${priorityLabel}</span>
                            </div>
                        </div>
                    </div>
                    <div style="padding:24px; border-left:6px solid #f59e0b; background:linear-gradient(90deg, #fffbeb 0%, #ffffff 100%);">
                        <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
                            <i class="fa-solid fa-triangle-exclamation" style="color:#d97706; font-size:16px;"></i>
                            <span style="font-size:13px; font-weight:900; color:#92400e; text-transform:uppercase; letter-spacing:0.06em;">検出したリスクと背景</span>
                        </div>
                        <div style="font-size:15px; color:#334155; line-height:1.8; font-weight:500;">${riskText}</div>
                    </div>
                    <div style="display:flex; flex-direction:column; border-top:1px solid #f1f5f9;">
                        <div style="padding:20px 24px; border-left:6px solid #cbd5e1; background:#fafafa; border-bottom:1px solid #f1f5f9;">
                            <div style="font-size:12px; font-weight:800; color:#64748b; margin-bottom:8px; display:flex; align-items:center; gap:8px;">
                                <i class="fa-solid fa-file-contract"></i> ${oldText ? '修正前（原文）' : '現状の課題'}
                            </div>
                            <div style="font-size:14px; color:#64748b; line-height:1.7;">
                                ${oldText ? oldText : `<span style="color:#94a3b8; font-style:italic;">この箇所には適切なリーガル保護条項が欠落しています。</span>`}
                            </div>
                        </div>
                        <div style="padding:24px; border-left:6px solid ${accentColor}; background:linear-gradient(90deg, ${accentColor}05 0%, #ffffff 100%);">
                            <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
                                <i class="fa-regular fa-lightbulb" style="color:${accentColor}; font-size:18px; font-weight:900;"></i>
                                <span style="font-size:13px; font-weight:900; color:${accentColor}; text-transform:uppercase; letter-spacing:0.06em;">提案する法的修正</span>
                            </div>
                            <div style="font-size:13px; color:${accentColor}; background:#fff; padding:12px 16px; border-radius:10px; border:1px dashed ${accentColor}40; margin-bottom:16px; line-height:1.6; font-weight:500;">
                                ${proposalIntro}
                            </div>
                            ${isDeletion
                                ? `<div style="font-size:14px; color:#7f1d1d; line-height:1.6; padding:12px 16px; background:#fef2f2; border:1px solid #fecaca; border-radius:10px; font-family:'Inter', system-ui, sans-serif;"><div style="font-size:12px; font-weight:800; color:#b91c1c; margin-bottom:4px; display:flex; align-items:center; gap:6px;"><i class="fa-solid fa-circle-minus"></i> 削除対象の文言</div><div style="white-space:pre-wrap; color:#b91c1c;">${oldText || '<span style="color:#94a3b8;">対象テキストが特定できません</span>'}</div></div>`
                                : `<div style="font-size:15px; color:#0f172a; line-height:1.9; padding:24px; background:#fff; border:1px solid #e2e8f0; border-radius:12px; box-shadow:inset 0 2px 8px rgba(0,0,0,0.02); font-family:'Inter', system-ui, sans-serif; white-space:pre-wrap;">${newDiffHtml || '<span style="color:#94a3b8; font-style:italic;">提案文言が生成されませんでした</span>'}</div>`
                            }
                            ${impact ? `
                            <div style="margin-top:20px; display:flex; align-items:flex-start; gap:12px; padding:14px 20px; background:#f0f9ff; border-radius:10px; border:1px solid #e0f2fe;">
                                <i class="fa-solid fa-shield-check" style="color:#0ea5e9; font-size:16px; margin-top:3px;"></i>
                                <div style="font-size:14px; color:#0369a1; line-height:1.6;">
                                    <span style="font-weight:900; display:block; margin-bottom:2px;">期待される効果：</span> ${impact}
                                </div>
                            </div>` : ''}
                        </div>
                    </div>
                    <div style="padding:16px 24px; background:#fcfdfe; border-top:1px solid #f1f5f9; display:flex; justify-content:${isApplied ? 'space-between' : 'flex-end'}; align-items:center; gap:20px;">
                        ${isApplied ? `
                            <div style="display:inline-flex; align-items:center; gap:8px; color:#1d4ed8; background:#eff6ff; border:1px solid #bfdbfe; padding:8px 12px; border-radius:10px; font-size:13px; font-weight:900;">
                                <i class="fa-solid fa-file-circle-check"></i> この修正案は最終版に反映されています
                            </div>
                        ` : ''}
                        ${isApplied
                            ? `
                            <button onclick="window.signViewer._revertChange(${i})" style="background:#fff; color:#475569; border:1px solid #d1d5db; padding:10px 24px; border-radius:10px; font-size:13px; font-weight:800; cursor:pointer;">元に戻す</button>
                            `
                            : (_isImageOnlyForRevised
                                ? `
                            <button disabled title="PDF原本(画像)のため修正案のテキスト反映はできません。Word(.docx)形式で再アップロードしてください。" style="background:#9ca3af; color:#fff; border:none; padding:12px 24px; border-radius:12px; font-size:13px; font-weight:900; cursor:not-allowed; opacity:0.7; display:inline-flex; align-items:center; gap:6px;"><i class="fa-solid fa-file-image"></i> PDF原本のため反映不可</button>
                            `
                                : (isDeletion
                                    ? ``
                                    : `
                            <button onclick="window.signViewer._applyChangeWithAI(${i})" title="AIが文脈を理解して正しい位置に反映 (数秒かかる)" style="background:linear-gradient(135deg,#7c3aed 0%,#0b2d62 100%); color:#fff; border:none; padding:12px 32px; border-radius:12px; font-size:14px; font-weight:900; cursor:pointer; box-shadow:0 4px 12px rgba(124,58,237,0.3); display:inline-flex; align-items:center; gap:6px;">
                                <i class="fa-solid fa-wand-magic-sparkles"></i> AIで反映
                            </button>
                            `))
                        }
                    </div>
                </div>`;
            }).join('');
        }

        // 反映状態ラベル + 上部 button 表示判定。
        // 削除型は自動反映対象外 (ユーザー手動削除) → 「すべて反映」 button は
        // 「削除型以外で未反映の change が1件以上」 のときのみ表示。
        const _storedApplied = this._getStoredAppliedChangeIndexes();
        const _appliedCount = _storedApplied.size;
        const _totalCount = aiChanges.length;
        const _noneApplied = _appliedCount === 0;
        const _statusLabel = _appliedCount > 0
            ? `AIによる${_totalCount}件の修正案 (${_appliedCount}/${_totalCount} 件反映済)`
            : `AIによる${_totalCount}件の修正案`;
        // 削除型以外で未反映 change が1件以上ある? (= 自動反映できる candidate あり)
        const _nonDeletionUnappliedExists = aiChanges.some((c, i) => {
            if (_storedApplied.has(i)) return false;
            const isDeletion = String(c?.type || '').toUpperCase() === 'DELETE'
                || (Boolean(this._getChangeOldText(c)) && !this._buildLegalInsertionText(c));
            return !isDeletion;
        });
        const _allApplied = _appliedCount === _totalCount && _totalCount > 0;
        const _applyAllBtn = _isImageOnlyForRevised
            ? `<button disabled title="PDF原本(画像)のため反映できません" style="background:#9ca3af; color:#fff; border:none; padding:8px 16px; border-radius:8px; font-size:13px; font-weight:700; cursor:not-allowed; opacity:0.7; display:flex; align-items:center; gap:8px;">
                <i class="fa-solid fa-file-image"></i> 反映不可 (PDF原本)
            </button>`
            : `<button onclick="window.signViewer._applyAllChangesWithAI()" title="AIで全修正案を順次反映 (削除案除く、 数秒×件数の時間がかかる)"
                style="background:linear-gradient(135deg,#7c3aed 0%,#0b2d62 100%); color:#fff; border:none; padding:8px 16px; border-radius:8px; font-size:13px; font-weight:700; cursor:pointer; display:flex; align-items:center; gap:8px; box-shadow:0 2px 8px rgba(124,58,237,0.25);">
            <i class="fa-solid fa-wand-magic-sparkles"></i> すべてAIで反映
        </button>`;
        const _imageOnlyBanner = _isImageOnlyForRevised
            ? `<div style="margin-bottom:14px; padding:12px 16px; background:#fef3c7; border:1px solid #fbbf24; border-radius:8px; font-size:13px; color:#78350f; display:flex; align-items:center; gap:10px;">
                <i class="fa-solid fa-triangle-exclamation" style="color:#d97706; font-size:16px;"></i>
                <span>このcontractは PDF原本 (画像) です。 修正案のテキスト反映機能は利用できません。 Word(.docx) 形式で再アップロードしてください。</span>
            </div>`
            : '';
        // 再発防止: contract data不完全検知時の警告 banner
        const _incompleteBanner = this._isContractDataIncomplete()
            ? `<div style="margin-bottom:14px; padding:14px 18px; background:#fee2e2; border:2px solid #ef4444; border-radius:8px; font-size:13px; color:#7f1d1d; display:flex; align-items:center; gap:10px;">
                <i class="fa-solid fa-circle-exclamation" style="color:#dc2626; font-size:18px;"></i>
                <span><b>解析データが不完全です。</b> contractテキストが正しく取得できていません。 ファイルを再アップロードするか、 別の docx ファイルでお試しください。</span>
            </div>`
            : '';
        const _aiNoticeBanner = `<div style="margin-bottom:14px; padding:12px 16px; background:#f8fafc; border:1px solid #dbeafe; border-radius:8px; font-size:12px; line-height:1.7; color:#475569; display:flex; align-items:flex-start; gap:10px;">
                <i class="fa-solid fa-circle-info" style="color:#2563eb; font-size:15px; margin-top:2px;"></i>
                <span><b style="color:#0f172a;">AI生成の修正案です。</b> 内容が正確でない場合や、最終版への反映位置がずれる場合があります。必要に応じて最終版の「編集する」から直接入力・修正してください。レイアウトや本文取得が不自然な場合は、編集画面の「再解析」もお試しください。</span>
            </div>`;
        const _revertAllBtn = `<button onclick="window.signViewer._confirmRevertAll()"
                style="background:#fff; color:#475569; border:1px solid #d1d5db; padding:8px 14px; border-radius:8px; font-size:13px; font-weight:700; cursor:pointer; display:flex; align-items:center; gap:6px;">
            <i class="fa-solid fa-rotate-left"></i> すべて元に戻す
        </button>`;
        revisedLayer.innerHTML = `
            <div style="padding:20px;max-width:900px;margin:0 auto;">
                ${_incompleteBanner}
                ${_imageOnlyBanner}
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
                    <div style="font-size:14px; color:#64748b; font-weight:600;">
                        ${_statusLabel}
                    </div>
                    <div style="display:flex; align-items:center; gap:8px;">
                        ${(() => {
                            // 削除型のみの contract or 削除型以外が全部反映済 → 「すべて反映」 button 非表示
                            const showApplyAll = _nonDeletionUnappliedExists;
                            const showRevertAll = !_noneApplied;
                            if (showApplyAll && showRevertAll) return _applyAllBtn + _revertAllBtn;
                            if (showApplyAll) return _applyAllBtn;
                            if (showRevertAll) return _revertAllBtn;
                            return '';
                        })()}
                    </div>
                </div>
                ${contentHtml}
                ${_aiNoticeBanner}
            </div>
        `;
    },

    // 「すべてAIで反映」: 未反映の追記/修正/明確化 change を順次 AI で反映する。
    // 削除型はユーザー手動削除方針のため skip。 各 change を直列実行 (gemini rate limit回避)。
    async _applyAllChangesWithAI() {
        if (this._isImageOnlyContract()) {
            Notify.error('このcontractは画像形式 (PDF原本) のため反映できません。');
            return;
        }
        const changes = this._getActiveSortedAiChanges();
        if (!changes.length) return;
        const applied = this._getStoredAppliedChangeIndexes();
        const targets = changes
            .map((c, i) => ({ c, i }))
            .filter(({ c, i }) => {
                if (applied.has(i)) return false;
                const isDel = String(c?.type || '').toUpperCase() === 'DELETE'
                    || (Boolean(this._getChangeOldText(c)) && !this._buildLegalInsertionText(c));
                return !isDel;
            });
        if (!targets.length) {
            Notify.info('反映対象の修正案はありません');
            return;
        }
        Notify.info(`AIで ${targets.length} 件を反映中...`);
        let okCount = 0, failCount = 0;
        for (const { i } of targets) {
            try {
                // 個別 _applyChangeWithAI の中間 Notify は出さず silent mode で呼ぶ
                await this._applyChangeWithAI(i, { silent: true });
                okCount++;
            } catch (e) {
                failCount++;
                console.warn(`[_applyAllChangesWithAI] index ${i} failed:`, e);
            }
        }
        if (okCount > 0) {
            Notify.success(`AI反映完了: 成功 ${okCount}件${failCount ? ` / 失敗 ${failCount}件` : ''}`);
            await this.switchViewMode('edit');
        } else {
            Notify.error(`AI反映失敗: ${failCount}件すべて失敗しました`);
        }
    },

    // contract.final_content から「第N条」 ブロックを抽出 (ヘッダー〜次条直前 or 文末)
    // 戻り値: { sectionLabel: blockText, ... } の map (key = 半角化された第N条 raw label)
    _splitContractIntoArticleBlocks(text) {
        const src = String(text || '');
        const re = /(?=^[ 　\t]*第\s*[0-9０-９零〇一二三四五六七八九十百千]+\s*条)/m;
        const parts = src.split(re);
        const map = {};
        const toHalfNum = (s) => String(s || '').replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
        parts.forEach(p => {
            const m = p.match(/^[ 　\t]*第\s*([0-9０-９零〇一二三四五六七八九十百千]+)\s*条/);
            if (m) {
                const key = '第' + toHalfNum(m[1]) + '条';
                if (!map[key]) map[key] = p; // 重複時は最初のみ採用
            }
        });
        return map;
    },

    _getArticleKeyFromLabel(label) {
        const match = String(label || '').match(/第\s*([0-9０-９零〇一二三四五六七八九十百千]+)\s*条/);
        if (!match) return '';
        const toHalfNum = (s) => String(s || '').replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
        return '第' + toHalfNum(match[1]) + '条';
    },

    _getSectionTextForChange(finalText, change) {
        const explicit = this._findExplicitArticleForChange(change) || change?.section || '';
        const sectionKey = this._getArticleKeyFromLabel(explicit);
        if (!sectionKey) return null;
        const blocks = this._splitContractIntoArticleBlocks(finalText);
        const sectionText = blocks[sectionKey];
        if (!sectionText || !sectionText.trim()) return null;
        return { sectionKey, sectionText, sectionLabel: explicit };
    },

    _replaceArticleSectionText(finalText, sectionText, newSectionText) {
        const source = String(finalText || '');
        const originalSection = String(sectionText || '');
        const replacement = String(newSectionText || '').replace(/\s+$/, '');
        if (!source || !originalSection.trim() || !replacement.trim()) return null;

        const trimmedSection = originalSection.replace(/\s+$/, '');
        const index = source.indexOf(trimmedSection);
        if (index >= 0) {
            return source.slice(0, index) + replacement + source.slice(index + trimmedSection.length);
        }
        const exactIndex = source.indexOf(originalSection);
        if (exactIndex >= 0) {
            return source.slice(0, exactIndex) + replacement + source.slice(exactIndex + originalSection.length);
        }
        return null;
    },

    _isAiSectionRewriteUsable(originalSectionText, newSectionText, change) {
        const before = String(originalSectionText || '').trim();
        const after = String(newSectionText || '').trim();
        if (!before || !after || before === after) return false;
        const expected = this._buildLegalInsertionText(change);
        const oldText = this._getChangeOldText(change);
        const norm = (value) => String(value || '').replace(/[\s　]+/g, '');
        const normalizedAfter = norm(after);
        const normalizedExpected = norm(expected);
        if (expected && normalizedExpected.length >= 8 && !normalizedAfter.includes(normalizedExpected.slice(0, 30))) {
            return false;
        }
        const beforeHeader = before.match(/^[ 　\t]*第\s*[0-9０-９零〇一二三四五六七八九十百千]+\s*条[^\n]*/)?.[0]?.trim();
        if (beforeHeader && !after.includes(beforeHeader)) return false;
        if (oldText && expected && norm(oldText) !== normalizedExpected && norm(after) === norm(before)) return false;
        return true;
    },

    async _requestAiSectionRewrite(contractId, change, sectionText, sectionLabel = '') {
        const url = toApiUrl(`/api/contracts/${encodeURIComponent(contractId)}/ai-apply-change`);
        const token = await this._getIdTokenSafe();
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers.Authorization = `Bearer ${token}`;
        const aiChange = {
            ...change,
            section: sectionLabel || change?.section || '',
            old: this._getChangeOldText(change),
            new: this._buildLegalInsertionText(change)
        };
        const res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({ change: aiChange, section_text: sectionText })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const message = data?.error || data?.detail || `HTTP ${res.status}`;
            throw new Error(message);
        }
        const newSectionText = String(data?.new_section_text || '').trim();
        if (!newSectionText) throw new Error('AI応答が空です');
        return newSectionText;
    },

    _applyDeterministicAiFallback(baseText, change, index) {
        let nextText = this._applyChangeToText(baseText, change, index);
        if (nextText !== baseText) return nextText;
        const checkText = this._buildLegalInsertionText(change);
        const oldText = this._getChangeOldText(change);
        if (oldText) return baseText;
        const alreadyPresent = checkText && this._textContainsCandidate
            ? this._textContainsCandidate(baseText, checkText)
            : String(baseText || '').includes(checkText);
        if (alreadyPresent) return baseText;
        if (checkText) {
            nextText = this._insertBestEffortIntoDocument(baseText, change, checkText, index);
        }
        return nextText;
    },

    _commitAppliedChangeToFinal(idx, change, baseText, nextText) {
        if (!this._editHistory) {
            this._editHistory = [baseText];
            this._editHistoryIndex = 0;
        }
        this._editedContent = nextText;
        this._editedHtml = '';
        this._lastSavedContent = nextText;
        this._lastPreviewContent = '';
        if (nextText !== this._editHistory[this._editHistoryIndex]) {
            this._pushHistory(nextText);
        }
        if (this._contract) {
            this._contract.final_content = nextText;
            this._contract.final_content_html = '';
        }
        this._invalidateFinalRenderedCache();
        const applied = this._getStoredAppliedChangeIndexes();
        applied.add(idx);
        this._setStoredAppliedChangeIndexes(applied, {
            final_content: nextText,
            final_content_html: ''
        });
        this._justAppliedSnippet = this._buildLegalInsertionText(change);
    },

    async _showSourceLayoutFinalIfPossible(finalText = this._getFinalDocumentText(), { silent = false } = {}) {
        if (!this._isOriginalDocxContract()) return false;
        const generated = await this._renderGeneratedFinalPdf(finalText, {
            allowHtmlFallback: false,
            renderGuard: false
        });
        if (generated) {
            if (!silent) Notify.success('原本レイアウトに反映した最終版を表示しました。');
            return true;
        }
        return false;
    },

    // AI を使った修正案反映 (= 案C: 対象条項のみ AI 渡し + frontend で物理置換)
    // 精度向上: AI に1条項だけ送り 新版を受け取り、 frontend で 該当 block を置換
    async _applyChangeWithAI(idx, options = {}) {
        const silent = !!options.silent;
        if (this._isImageOnlyContract()) {
            if (!silent) Notify.error('このcontractは画像形式 (PDF原本) のため反映できません。');
            return;
        }
        const changes = this._getActiveSortedAiChanges();
        const c = changes[idx];
        if (!c) return;
        const contractId = this._contract?.id;
        if (!contractId) { if (!silent) Notify.error('contract未読込'); return; }
        if (!this._appliedChanges) this._appliedChanges = new Set();
        if (this._appliedChanges.has(idx)) {
            if (!silent) {
                Notify.info('この修正は既に反映済みです。');
                this.switchViewMode('edit');
            }
            return;
        }
        if (!silent) Notify.info('AIで反映中...');
        try {
            const baseText = this._isFinalEditorVisible() ? this._collectEditorContent() : this._ensureEditedContent();
            const isDeletionChange = String(c?.type || '').toUpperCase() === 'DELETE'
                || (Boolean(this._getChangeOldText(c)) && !this._buildLegalInsertionText(c));
            if (isDeletionChange) {
                if (!silent) Notify.error('削除案は本文破壊を避けるため、通常の反映ボタンで確認しながら反映してください。');
                if (silent) throw new Error('delete change skipped');
                return;
            }

            let nextText = baseText;
            let aiError = null;
            const target = this._getSectionTextForChange(baseText, c);
            const allowAiSectionRewrite = target && !this._isAdditionChange(c);
            if (allowAiSectionRewrite) {
                try {
                    const aiSection = await this._requestAiSectionRewrite(contractId, c, target.sectionText, target.sectionLabel);
                    if (this._isAiSectionRewriteUsable(target.sectionText, aiSection, c)) {
                        const candidateText = this._replaceArticleSectionText(baseText, target.sectionText, aiSection);
                        if (candidateText && candidateText !== baseText) nextText = candidateText;
                    } else {
                        aiError = new Error('AI出力の検証に失敗しました');
                    }
                } catch (error) {
                    aiError = error;
                    console.warn('[_applyChangeWithAI] AI rewrite failed; falling back to deterministic apply:', error);
                }
            }

            if (nextText === baseText) {
                nextText = this._applyDeterministicAiFallback(baseText, c, idx);
            }

            const expected = this._buildLegalInsertionText(c);
            const oldText = this._getChangeOldText(c);
            const replacementMustMutate = Boolean(oldText)
                && this._normalizeCandidateText(oldText) !== this._normalizeCandidateText(expected);
            const alreadyPresent = expected && this._textContainsCandidate
                ? this._textContainsCandidate(baseText, expected)
                : String(baseText || '').includes(expected);
            if (nextText === baseText && (replacementMustMutate || !alreadyPresent)) {
                const message = aiError?.message || '修正位置を特定できませんでした';
                if (!silent) Notify.error(`AI反映失敗: ${message}`);
                if (silent) throw new Error(message);
                return;
            }

            this._commitAppliedChangeToFinal(idx, c, baseText, nextText);
            if (!silent) {
                Notify.success('AIで修正案を反映しました。');
                this.renderModifiedDocument(this._viewerContainer);
                await this.switchViewMode('edit');
            }
        } catch (e) {
            console.error('[_applyChangeWithAI] error:', e);
            if (!silent) Notify.error(`AI反映エラー: ${e?.message || e}`);
            else throw e;
        }
    },

    _applyChange(idx) {
        // 画像のみcontract guard: 物理的にtext挿入できないため反映を拒否
        // (フラグだけ立ってrender崩れる不整合bugの根本対策)
        if (this._isImageOnlyContract()) {
            Notify.error('このcontractは画像形式 (PDF原本) のため、修正案のテキスト反映はできません。Word(.docx) 形式で再アップロードしてください。');
            return;
        }
        const changes = this._getActiveSortedAiChanges();
        const c = changes[idx];
        if (!c) return;
        if (!this._appliedChanges) this._appliedChanges = new Set();
        if (this._appliedChanges.has(idx)) {
            Notify.info('この修正はすでに最終版へ反映済みです。');
            this.switchViewMode('edit');
            return;
        }
        const baseText = this._isFinalEditorVisible() ? this._collectEditorContent() : this._ensureEditedContent();
        let nextText = this._applyChangeToText(baseText, c, idx);
        const isDeletionChange = String(c?.type || '').toUpperCase() === 'DELETE'
            || (Boolean(this._getChangeOldText(c)) && !this._buildLegalInsertionText(c));
        if (nextText === baseText && !isDeletionChange) {
            const checkText = this._buildLegalInsertionText(c);
            const alreadyPresent = checkText && baseText.includes(checkText);
            if (!alreadyPresent) {
                nextText = this._insertBestEffortIntoDocument(baseText, c, checkText, idx);
            }
            if (nextText === baseText) {
                Notify.error('修正案を最終版へ反映できませんでした。修正案の内容を確認してください。');
                console.warn('[SignViewer] Failed to apply change to final text:', { index: idx, change: c });
                return;
            }
        }
        if (!this._editHistory) {
            this._editHistory = [baseText];
            this._editHistoryIndex = 0;
        }
        this._editedContent = nextText;
        this._editedHtml = '';
        this._lastSavedContent = nextText;
        this._lastPreviewContent = '';
        if (nextText !== this._editHistory[this._editHistoryIndex]) {
            this._pushHistory(nextText);
        }
        
        if (this._contract) {
            this._contract.final_content = nextText;
            this._contract.final_content_html = '';
        }
        this._invalidateFinalRenderedCache();

        const applied = this._getStoredAppliedChangeIndexes();
        applied.add(idx);
        // 削除型反映時は商用品質のため、 final_content 自体を物理削除済+リナンバリング済の
        // クリーン版で上書きする (画面・プレビュー・印刷・DL すべてで自然に反映される)。
        // 一時的に this._appliedChanges を更新して _buildCleanFinalContent が新 applied set を参照できるようにする。
        const isDeletionApply = String(c?.type || '').toUpperCase() === 'DELETE'
            || (Boolean(this._getChangeOldText(c)) && !this._buildLegalInsertionText(c));
        let savedFinal = nextText;
        if (isDeletionApply) {
            this._appliedChanges = new Set(applied);
            // _getStoredAppliedChangeIndexes() は contract.final_applied_change_indexes を優先するため
            // _buildCleanFinalContent 呼ぶ前に そちらも一時的に新 applied set にして 新 change を認識させる
            if (this._contract) {
                this._contract.final_applied_change_indexes = Array.from(applied).sort((a,b)=>a-b);
            }
            try {
                savedFinal = this._buildCleanFinalContent(nextText);
            } catch (e) {
                console.warn('[SignViewer] _buildCleanFinalContent failed on apply:', e);
                savedFinal = nextText;
            }
            this._contract.final_content = savedFinal;
            this._editedContent = savedFinal;
            this._lastSavedContent = savedFinal;
            this._invalidateFinalRenderedCache();
        }
        // Boundary guard: final_content: nextText is persisted for normal revisions;
        // deletion revisions persist savedFinal after cleanup.
        this._setStoredAppliedChangeIndexes(applied, {
            final_content: savedFinal,
            final_content_html: ''
        });
        this._justAppliedSnippet = this._buildLegalInsertionText(c);
        Notify.success('修正を最終版へ反映しました。最終版で位置を確認してください。');
        this.renderModifiedDocument(this._viewerContainer);
        setTimeout(() => {
            this._scale = 1.0;
            this._setFinalActionBarVisible(false);
            this.switchViewMode('edit');
        }, 0);
        setTimeout(() => { this._justAppliedSnippet = null; }, 5000);
    },

    _scrollToAppliedSnippet() {
        const el = document.querySelector('.v3-applied-change-pulse');
        if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            console.log('[SignViewer] Scrolled to newly applied change.');
        } else {
            console.warn('[SignViewer] Pulse element not found for scroll.');
        }
    },

    _applyAllChanges() {
        // 画像のみcontract guard: 物理的にtext挿入できないため反映を拒否
        if (this._isImageOnlyContract()) {
            Notify.error('このcontractは画像形式 (PDF原本) のため、修正案のテキスト反映はできません。Word(.docx) 形式で再アップロードしてください。');
            return;
        }
        const changes = this._getActiveSortedAiChanges();
        if (!changes.length) return;
        if (!this._appliedChanges) this._appliedChanges = new Set();
        let nextText = this._isFinalEditorVisible() ? this._collectEditorContent() : this._ensureEditedContent();
        if (!this._editHistory) {
            this._editHistory = [nextText];
            this._editHistoryIndex = 0;
        }
        
        const applied = this._getStoredAppliedChangeIndexes();
        let appliedCount = 0;
        changes.forEach((c, i) => {
            if (applied.has(i)) return;
            // 削除型はユーザー手動削除方針のため自動反映の対象外
            const isDeletion = String(c?.type || '').toUpperCase() === 'DELETE'
                || (Boolean(this._getChangeOldText(c)) && !this._buildLegalInsertionText(c));
            if (isDeletion) return;
            const before = nextText;
            nextText = this._applyChangeToText(nextText, c, i);
            if (nextText === before) {
                const checkText = this._buildLegalInsertionText(c);
                if (!checkText) return;
                if (!nextText.includes(checkText)) {
                    nextText = this._insertBestEffortIntoDocument(nextText, c, checkText, i);
                }
                if (nextText === before && !nextText.includes(checkText)) return;
            }
            applied.add(i);
            appliedCount += 1;
        });
        if (appliedCount === 0) {
            Notify.info('反映対象の修正案はすでに最終版へ反映済みです。');
            return;
        }
        this._editedContent = nextText;
        this._editedHtml = '';
        this._lastSavedContent = nextText;
        this._lastPreviewContent = '';
        if (nextText !== this._editHistory[this._editHistoryIndex]) {
            this._pushHistory(nextText);
        }

        if (this._contract) {
            this._contract.final_content = nextText;
            this._contract.final_content_html = '';
        }
        this._invalidateFinalRenderedCache();
        this._setStoredAppliedChangeIndexes(applied, {
            final_content: nextText,
            final_content_html: ''
        });

        Notify.success('すべての修正を最終版へ反映しました。');
        this.renderModifiedDocument(this._viewerContainer);
        setTimeout(() => {
            this._scale = 1.0;
            this._setFinalActionBarVisible(false);
            this.switchViewMode('edit');
        }, 0);
    },

    async importFinalFile() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.pdf,.docx';
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            
            Notify.success('ファイルを読み込みました');
            this._finalBlobUrl = URL.createObjectURL(file);
            if (this._contract) {
                this._contract.final_filename = file.name;
                // In a real app, you would upload this to the server here
            }
            this.switchViewMode('edit');
        };
        input.click();
    },

    async downloadFinalDoc() {
        if (this._finalBlobUrl) {
            const a = document.createElement('a');
            a.href = this._finalBlobUrl;
            a.download = this._contract?.final_filename || 'final_document.pdf';
            a.click();
            return;
        }
        Notify.info('PDFを生成しています...');
        // Fallback to basic download or print if no file was imported
        window.print();
    },

    async _downloadFinalPreviewPdf() {
        const editorVisible = this._isFinalEditorVisible();
        const finalText = String(editorVisible ? this._collectEditorContent() : this._getFinalDocumentText());
        if (editorVisible) {
            this._editedContent = finalText;
            this._editedHtml = this._collectEditorHtml();
        }
        if (!finalText.trim()) {
            Notify.error('ダウンロードする最終版の内容がありません');
            return;
        }

        const baseName = String(this._contract?.name || this._currentFilename || 'final_document')
            .replace(/[\\/:*?"<>|]/g, '_')
            .replace(/\.(docx?|pdf)$/i, '')
            .trim() || 'final_document';

        try {
            Notify.info('最終版PDFを生成しています...');
            if (this._canGenerateSourceLayoutFinal(finalText)) {
                const validation = await this._generateValidatedFinalDocxPdf(finalText);
                if (validation.blob && await this._isPdfBlob(validation.blob)) {
                    this._downloadBlob(validation.blob, `${baseName}_final.pdf`);
                    Notify.success('原本レイアウトの最終版PDFをダウンロードしました');
                    return;
                }
                console.warn('[SignViewer] Source-layout final PDF unavailable, using rendered final PDF:', validation.reason);
            }

            const pdfBlob = await this._generateFinalPdf(finalText);
            if (pdfBlob && await this._isPdfBlob(pdfBlob)) {
                this._downloadBlob(pdfBlob, `${baseName}_final.pdf`);
                Notify.success('最終版PDFをダウンロードしました');
                return;
            }
            Notify.error('PDF生成に失敗しました。PDFではないファイルは保存しません。');
            return;
        } catch (error) {
            console.error('Final PDF generation error:', error);
            Notify.error('PDF生成に失敗しました。PDFではないファイルは保存しません。');
            return;
        }
    },

    openDownloadMenu(event) {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        this.closeDownloadMenu();

        const trigger = event?.currentTarget || document.querySelector('.v3-download-menu-trigger');
        const rect = trigger?.getBoundingClientRect?.();
        const popover = document.createElement('div');
        popover.id = 'v3-download-popover';
        popover.className = 'v3-download-popover';
        popover.innerHTML = `
            <button type="button" class="v3-download-option" data-download-action="pdf">
                <span class="v3-download-file-icon is-pdf">PDF</span>
                <span>
                    <span class="v3-download-option-title">PDFをダウンロード</span>
                    <span class="v3-download-option-desc">契約書をPDF形式でダウンロードします</span>
                </span>
            </button>
            <button type="button" class="v3-download-option" data-download-action="word">
                <span class="v3-download-file-icon is-word">W</span>
                <span>
                    <span class="v3-download-option-title">Wordをダウンロード</span>
                    <span class="v3-download-option-desc">契約書をWord形式でダウンロードします</span>
                </span>
            </button>
        `;

        document.body.appendChild(popover);
        const popoverRect = popover.getBoundingClientRect();
        const top = rect ? rect.bottom + 18 : 96;
        const preferredLeft = rect ? rect.right - popoverRect.width + 72 : (window.innerWidth - popoverRect.width) / 2;
        const left = Math.max(16, Math.min(preferredLeft, window.innerWidth - popoverRect.width - 16));
        popover.style.top = `${Math.round(top)}px`;
        popover.style.left = `${Math.round(left)}px`;

        popover.addEventListener('click', async (clickEvent) => {
            const option = clickEvent.target.closest('[data-download-action]');
            if (!option) return;
            const action = option.dataset.downloadAction;
            this.closeDownloadMenu();
            if (action === 'pdf') {
                await this.downloadPdf();
            } else if (action === 'word') {
                await this.downloadWord();
            }
        });

        this._downloadMenuCloseHandler = (closeEvent) => {
            if (popover.contains(closeEvent.target) || trigger?.contains?.(closeEvent.target)) return;
            this.closeDownloadMenu();
        };
        this._downloadMenuKeyHandler = (keyEvent) => {
            if (keyEvent.key === 'Escape') this.closeDownloadMenu();
        };
        setTimeout(() => document.addEventListener('click', this._downloadMenuCloseHandler), 0);
        document.addEventListener('keydown', this._downloadMenuKeyHandler);
    },

    closeDownloadMenu() {
        const existing = document.getElementById('v3-download-popover');
        if (existing) existing.remove();
        if (this._downloadMenuCloseHandler) {
            document.removeEventListener('click', this._downloadMenuCloseHandler);
            this._downloadMenuCloseHandler = null;
        }
        if (this._downloadMenuKeyHandler) {
            document.removeEventListener('keydown', this._downloadMenuKeyHandler);
            this._downloadMenuKeyHandler = null;
        }
    },

    _getDownloadBaseName() {
        return String(this._contract?.name || this._currentFilename || this._currentRequest?.original_filename || 'contract')
            .replace(/[\\/:*?"<>|]/g, '_')
            .replace(/\.(docx?|pdf|html?)$/i, '')
            .trim() || 'contract';
    },

    _downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return url;
    },

    async _isPdfBlob(blob, type) {
        if (!(blob instanceof Blob) || blob.size === 0) return false;
        const t = String(type || blob.type || '').toLowerCase();
        if (t.includes('text/html') || t.includes('application/json')) return false;
        if (t.includes('application/pdf')) return true;
        try {
            const buf = new Uint8Array(await blob.slice(0, 5).arrayBuffer());
            // %PDF magic bytes
            return buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46;
        } catch (_) {
            return false;
        }
    },

    async _isDocxBlob(blob, contentType) {
        if (!(blob instanceof Blob) || blob.size === 0) return false;
        const t = String(contentType || blob.type || '').toLowerCase();
        if (t.includes('text/html') || t.includes('application/json')) return false;
        if (t.includes('officedocument.wordprocessingml') || t.includes('application/vnd.openxmlformats')) return true;
        try {
            const buf = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
            // PK.. (ZIP/OOXML) magic bytes
            return buf[0] === 0x50 && buf[1] === 0x4B;
        } catch (_) {
            return false;
        }
    },

    async _generateFinalDocxBlob(finalContent = this._getFinalDocumentText()) {
        const originalFile = await this._getOriginalDocxFileForFinal();
        if (!(originalFile instanceof Blob)) return { blob: null, reason: '元DOCXが見つかりません。' };

        const revisions = this._buildFinalDocxRevisions(finalContent);
        if (!revisions.length) {
            // 適用済みの修正案が無い場合は「最終版＝原本」。原本DOCXをそのまま返し、
            // Word保存が必ずファイルを生成できるようにする（PDFは既存URLを返す設計に合わせる）。
            return { blob: originalFile, reason: '' };
        }

        const formData = new FormData();
        formData.append('file', originalFile, originalFile.name || 'original.docx');
        formData.append('revisions', JSON.stringify(revisions));

        const serviceUrl = (typeof window !== 'undefined' && window.__DOCX_PDF_SERVICE_URL__)
            ? String(window.__DOCX_PDF_SERVICE_URL__).replace(/\/$/, '')
            : '';
        const endpoint = serviceUrl
            ? `${serviceUrl}/api/convert/final-docx`
            : toApiUrl('/api/convert/final-docx');
        const resp = await fetch(endpoint, {
            method: 'POST',
            body: formData,
            signal: AbortSignal.timeout(120_000)
        });
        if (!resp.ok) return { blob: null, reason: `DOCX生成APIが失敗しました（${resp.status}）。` };
        const contentType = resp.headers.get('content-type') || '';
        const blob = await resp.blob();
        if (!(await this._isDocxBlob(blob, contentType))) {
            return { blob: null, reason: 'DOCX生成APIがWordファイルを返しませんでした。' };
        }
        return { blob, reason: '' };
    },

    async downloadWord() {
        if (this._conversionInFlight) { Notify.info('変換中です。完了までお待ちください。'); return; }
        this._conversionInFlight = true;
        try {
            const editorVisible = this._isFinalEditorVisible();
            const finalContent = String(editorVisible ? this._collectEditorContent() : this._getFinalDocumentText());
            const baseName = this._getDownloadBaseName();
            try {
                Notify.info('Wordを生成しています...');
                const result = await this._generateFinalDocxBlob(finalContent);
                if (result.blob) {
                    this._downloadBlob(result.blob, `${baseName}_final.docx`);
                    Notify.success('Wordをダウンロードしました');
                    return;
                }
                console.warn('[SignViewer] Final DOCX unavailable:', result.reason);
                Notify.error(result.reason || 'Word生成に失敗しました。DOCXではないファイルは保存しません。');
                return;
            } catch (error) {
                console.error('Word download error:', error);
                Notify.error('Word生成に失敗しました。DOCXではないファイルは保存しません。');
                return;
            }
        } finally {
            this._conversionInFlight = false;
        }
    },

    async downloadPdf() {
        if (this._conversionInFlight) { Notify.info('変換中です。完了までお待ちください。'); return; }
        this._conversionInFlight = true;
        try {
            if (this._viewMode === 'final' || this._viewMode === 'edit') {
                await this._downloadFinalPreviewPdf();
                return;
            }

            const req = this._currentRequest || {};
            const fallbackUrl = resolveBackendAssetUrl(req.pdf_url || req.pdf_storage_path || req.pdf_file_url || req.pdf_file_path);
            const rawOriginalUrl = req.original_file_url || req.original_file_path;
            const originalUrl = rawOriginalUrl && /\.pdf(?:$|[?#])/i.test(String(rawOriginalUrl))
                ? resolveBackendAssetUrl(rawOriginalUrl)
                : '';
            const currentDownloadUrl = this._currentDownloadUrl && /\.pdf(?:$|[?#])/i.test(String(this._currentDownloadUrl))
                ? this._currentDownloadUrl
                : '';
            const downloadUrl = this._currentPdfUrl || currentDownloadUrl || fallbackUrl || originalUrl;
            if (!downloadUrl) {
                Notify.error('ダウンロード可能なファイルが見つかりません');
                return;
            }

            try {
                Notify.success('ダウンロードを準備中...');
                const req = this._currentRequest || {};
                const originalName = req.original_filename || req.document_snapshot?.original_filename || '';
                const isFinalPdf = downloadUrl === this._finalGeneratedPdfUrl || this._viewMode === 'final';
                let filename;
                if (isFinalPdf) {
                    const baseName = originalName
                        ? originalName.replace(/\.[^.]+$/, '')
                        : (this._currentFilename ? this._currentFilename.replace(/\.[^.]+$/, '') : `contract_${Date.now()}`);
                    filename = `${baseName}_final.pdf`;
                } else {
                    const ext = originalName ? originalName.split('.').pop() : (this._docxObjectUrl ? 'docx' : 'pdf');
                    filename = this._currentFilename || originalName || `contract_${Date.now()}.${ext}`;
                }

                if (downloadUrl.startsWith('blob:')) {
                    const response = await fetch(downloadUrl);
                    const blob = await response.blob();
                    if (!(await this._isPdfBlob(blob, blob.type))) {
                        Notify.error('PDFではないファイルのため、PDF保存を中止しました。');
                        return;
                    }
                    const pdfName = filename.replace(/\.[^.]+$/i, '') + '.pdf';
                    this._downloadBlob(blob, pdfName);
                    return;
                }

                // For cross-origin URLs, we must fetch the blob first, otherwise the browser will just navigate to the URL
                const response = await fetch(downloadUrl);
                if (!response.ok) throw new Error('Fetch failed');
                const blob = await response.blob();
                const contentType = response.headers.get('content-type') || blob.type || '';
                if (!(await this._isPdfBlob(blob, contentType))) {
                    Notify.error('PDFではないファイルのため、PDF保存を中止しました。');
                    return;
                }
                const pdfName = filename.replace(/\.[^.]+$/i, '') + '.pdf';
                this._downloadBlob(blob, pdfName);
            } catch (error) {
                console.error('Download error:', error);
                Notify.error('PDF保存に失敗しました。PDFではないファイルは保存しません。');
            }
        } finally {
            this._conversionInFlight = false;
        }
    },

    printDocument() {
        try {
            Notify.info('印刷準備中...');
            // 印刷直前に docx-pages を確実に display:block に。
            // Phase 3: 最終版ビューで「印刷を押しても何も表示されない」問題を回避
            const docxLayer = document.getElementById('sign-viewer-docx-pages');
            const pdfLayer = document.getElementById('pdf-viewer-scroll');
            const previewOverlay = document.getElementById('final-rendered-preview-overlay');
            const previewVisible = previewOverlay && getComputedStyle(previewOverlay).display !== 'none';
            const restorers = [];
            const restoreStyle = (el) => {
                if (!el) return;
                const prev = el.getAttribute('style') || '';
                restorers.push(() => el.setAttribute('style', prev));
            };
            // 1) プレビューが開いていればそれを優先（プレビュー＝印刷したい状態）
            // 2) 開いていなければ docx-pages を可視化
            if (!previewVisible) {
                restoreStyle(docxLayer);
                restoreStyle(pdfLayer);
                if (docxLayer) {
                    docxLayer.style.display = 'block';
                    docxLayer.style.visibility = 'visible';
                }
            }
            // 印刷後にスタイルを元に戻す
            const onAfterPrint = () => {
                restorers.forEach(fn => { try { fn(); } catch (e) {} });
                window.removeEventListener('afterprint', onAfterPrint);
            };
            window.addEventListener('afterprint', onAfterPrint);
            // ブラウザの実装ばらつきを考慮し、setTimeout 経由でも復元保証
            setTimeout(() => { try { onAfterPrint(); } catch (e) {} }, 5000);
            window.print();
        } catch (e) {
            console.warn('[DIFFsense] printDocument failed:', e);
            try { window.print(); } catch (_) {}
        }
    },

    async renderTextFallback(contract, container) {
        const isDash = this._isDashboardMode;
        
        if (isDash) {
            let pagesContainer = document.getElementById('pdf-pages-container');
            if (!pagesContainer) {
                await this.renderPdf(null, container);
                pagesContainer = document.getElementById('pdf-pages-container');
            }

            if (pagesContainer) {
                const docxContainer = document.getElementById('sign-viewer-docx-pages');
                const revisedLayer = document.getElementById('v3-revised-layer');
                const editLayer = document.getElementById('v3-edit-layer');
                if (docxContainer) docxContainer.style.display = 'none';
                if (revisedLayer) revisedLayer.style.display = 'none';
                if (editLayer) editLayer.style.display = 'none';
                pagesContainer.style.display = 'block';
                pagesContainer.style.background = '#f1f5f9'; // Dashboard grey background
                pagesContainer.style.transform = 'none';
                pagesContainer.style.zoom = 1;

                // Paginate the text fallback to match A4 layout
                const text = contract.pdf_raw_text || contract.extracted_text || contract.original_content || '原本データがありません';
                const { charsPerLine, linesPerPage } = this._calcPageLayout();
                const pages = this._paginateDocumentText(text, charsPerLine, linesPerPage);
                
                pagesContainer.innerHTML = pages.map((pageLines, i) => `
                    <div data-page="${i+1}" class="v3-editor-page" style="width:794px;max-width:calc(100vw - 64px);margin:0 auto 16px auto;padding:80px 60px;box-sizing:border-box;background:#fff;min-height:1123px;box-shadow:0 8px 24px rgba(0,0,0,0.08);color:#333;font-family:'Noto Serif JP', serif;font-size:14px;line-height:1.8;white-space:pre-wrap;overflow:visible;">
                        ${this.escapeHtml(pageLines.join('\n'))}
                    </div>
                `).join('');

                this._totalPages = pages.length;
                this._activePage = 1;
                this.hideViewerLoader();
                this.triggerDashboardUI();
                return;
            }
        }

        container.innerHTML = `
            <div class="text-fallback-wrapper" style="width:100%; height:100%; display:flex; flex-direction:column; background:${isDash ? '#f1f5f9' : '#fff'}; border:${isDash ? 'none' : '1px solid var(--border-subtle)'}; border-radius:${isDash ? '0' : 'var(--radius-md)'}; overflow:hidden;">
                ${contract.source_url ? `
                <div style="padding:${isDash ? '0 0 16px 0' : '16px'}; background:transparent; border-bottom:1px solid #eee; display:flex; justify-content:flex-end; align-items:center;">
                    <a href="${contract.source_url}" target="_blank" style="font-size:12px; color:var(--color-primary);">
                        入力ソースを表示 <i class="fa-solid fa-external-link"></i>
                    </a>
                </div>
                ` : ''}
                <div style="flex:1; padding:${isDash ? '0' : '32px'}; overflow-y:auto; line-height:1.8; color:#333; font-family:'Noto Sans JP', sans-serif; font-size:14px;">
                    ${buildSignDocumentPreviewHtml(contract.pdf_raw_text || contract.extracted_text || contract.original_content || '原本データがありません')}
                </div>
            </div>
        `;
        this.triggerDashboardUI();
    },

    /**
     * IndexedDB 繧剃ｽｿ逕ｨ縺励◆ PDF 繧ｭ繝｣繝・す繝･ (繝ｪ繝ｭ繝ｼ繝牙ｯｾ遲・
     */
    async _getCache(key) {
        return new Promise((resolve) => {
            try {
                const request = indexedDB.open('DIFFsenseCache', 1);
                request.onupgradeneeded = (e) => {
                    if (!e.target.result.objectStoreNames.contains('pdfs')) {
                        e.target.result.createObjectStore('pdfs');
                    }
                };
                request.onsuccess = (e) => {
                    const db = e.target.result;
                    const tx = db.transaction('pdfs', 'readonly');
                    const store = tx.objectStore('pdfs');
                    const get = store.get(key);
                    get.onsuccess = () => resolve(get.result);
                    get.onerror = () => resolve(null);
                };
                request.onerror = () => resolve(null);
            } catch(e) { resolve(null); }
        });
    },

    async _setCache(key, blob) {
        return new Promise((resolve) => {
            try {
                const request = indexedDB.open('DIFFsenseCache', 1);
                request.onupgradeneeded = (e) => e.target.result.createObjectStore('pdfs');
                request.onsuccess = (e) => {
                    const db = e.target.result;
                    const tx = db.transaction('pdfs', 'readwrite');
                    const store = tx.objectStore('pdfs');
                    store.put(blob, key);
                    tx.oncomplete = () => resolve(true);
                    tx.onerror = () => resolve(false);
                };
                request.onerror = () => resolve(false);
            } catch(e) { resolve(false); }
        });
    },

    async renderDocx(source, container) {
        if (this._isRenderingDocx) {
            console.log('[SignViewer] DOCX rendering already in progress, skipping concurrent call.');
            return;
        }
        
        this._isRenderingDocx = true;

        // OPTIMIZATION: If already rendered, just show the layer
        const docxLayer = document.getElementById('sign-viewer-docx-pages');
        const currentUrl = source instanceof Blob ? source.name + source.size : (typeof source === 'string' ? source : null);
        if (docxLayer && docxLayer.children.length > 0 && this._currentDocxKey === currentUrl && currentUrl) {
            docxLayer.style.display = (this._viewMode === 'original' || this._viewMode === 'final') ? 'block' : 'none';
            this.hideViewerLoader();
            this._isRenderingDocx = false;
            return;
        }
        this._currentDocxKey = currentUrl;

            const isDash = this._isDashboardMode;
        // Word-native CSS reset: keep docx-preview's own page sizing and margins.
        const docxCssReset = `<style id="docx-viewer-css-reset">
            #pdf-viewer-scroll .docx-wrapper {
                background: transparent !important;
                padding: 0 !important;
                width: 100% !important;
            }
            #pdf-viewer-scroll .docx-wrapper > section {
                background: #ffffff !important;
                max-width: 210mm !important;
                margin: 24px auto !important;
                box-shadow: 0 4px 14px rgba(15,23,42,0.08) !important;
                overflow: visible !important;
                border: none !important;
                outline: none !important;
            }
            #sign-viewer-content #pdf-viewer-scroll .docx-wrapper > section,
            #sign-viewer-content #pdf-viewer-scroll .editor-page-shell,
            #sign-viewer-content #pdf-viewer-scroll .editor-page-wrapper {
                overflow: hidden !important;
                max-width: 100% !important;
                box-sizing: border-box !important;
            }
            #pdf-viewer-scroll .editor-page-shell {
                box-sizing: border-box !important;
                max-width: 100% !important;
                margin: 24px auto !important;
                border: none !important;
                outline: none !important;
            }
            #pdf-viewer-scroll .editor-page-shell > section,
            #pdf-viewer-scroll .editor-page-shell > .docx-section {
                margin: 0 auto !important;
                border: none !important;
                outline: none !important;
                box-shadow: none !important;
            }
            #pdf-viewer-scroll .editor-page-wrapper {
                box-sizing: border-box !important;
                max-width: 100% !important;
                border: none !important;
                outline: none !important;
            }
            #pdf-viewer-scroll .docx-wrapper br {
                display: inline !important;
            }
            #pdf-viewer-scroll .docx-wrapper .docx_br_like { display:none !important; }
        </style>`;

        // 縺吶〒縺ｫ蝨溷床縺後≠繧句ｴ蜷医・縺昴ｌ繧剃ｽｿ縺・
        let scrollEl = document.getElementById('pdf-viewer-scroll');
        if (!scrollEl) {
            await this.renderPdf(null, container); // 蝨溷床縺縺台ｽ懊ｋ
            scrollEl = document.getElementById('pdf-viewer-scroll');
        }
        this._setOriginalViewerBottomSpace(this._isDashboardMode && (this._viewMode === 'original' || this._viewMode === 'final'));
        
        const mount = document.getElementById('sign-viewer-docx-pages');
        const pdfMount = document.getElementById('pdf-pages-container');
        const loader = document.getElementById('viewer-loader');

        if (mount) {
            mount.style.display = (this._viewMode === 'original' || this._viewMode === 'final') ? 'flex' : 'none';
            mount.style.width = '100%';
            mount.style.marginLeft = 'auto';
            mount.style.marginRight = 'auto';
            mount.style.flexDirection = 'column';
            mount.style.alignItems = 'center';
            mount.style.justifyContent = 'flex-start';
            if (pdfMount) pdfMount.style.display = 'none';
            if (loader) loader.style.display = 'block';
            if (!document.getElementById('docx-viewer-css-reset')) {
                document.head.insertAdjacentHTML('beforeend', docxCssReset);
            }
        }

        try {
            const resolvedSource = await this.resolveDocxPreviewSource(source, this._app);
            // Store download URL for DOCX
            if (resolvedSource instanceof Blob) {
                if (this._docxObjectUrl) URL.revokeObjectURL(this._docxObjectUrl);
                this._docxObjectUrl = URL.createObjectURL(resolvedSource);
                this._currentDownloadUrl = this._docxObjectUrl;
            } else if (typeof resolvedSource === 'string') {
                this._currentDownloadUrl = resolvedSource;
            }
            // Render original DOCX directly so a stuck conversion service cannot blank the preview.
            const pages = await renderDocxPreviewPages(mount, resolvedSource, {
                expectedPageCount: this._getOriginalPageCount()
            });
            if (!pages.length) {
                throw new Error('DOCX preview produced no pages');
            }
            this._totalPages = pages.length || 1;
            if (this._viewMode === 'original' && this._totalPages > 0) {
                this._originalPageCount = this._totalPages;
            }
            pages.forEach((p, i) => {
                const shell = p.closest('.editor-page-shell') || p.parentElement || p;
                shell.dataset.page = String(i + 1);
                if (!this._isDashboardMode) {
                    shell.style.overflow = 'hidden';
                    shell.style.background = '#fff';
                    shell.style.boxSizing = 'border-box';
                    p.style.overflow = 'hidden';
                    p.style.boxSizing = 'border-box';
                    p.querySelectorAll?.('section, .docx-section, .editor-page-wrapper').forEach((node) => {
                        node.style.maxWidth = '100%';
                        node.style.boxSizing = 'border-box';
                        node.style.overflow = 'hidden';
                    });
                }
            });
            this._activePage = 1;

            if (!this._isDashboardMode && mount && scrollEl) {
                await new Promise(requestAnimationFrame);
                const firstPage = mount.querySelector('.editor-page-shell, .docx-wrapper > section, section');
                const availableWidth = Math.max(0, scrollEl.clientWidth - 48);
                const pageWidth = firstPage ? firstPage.getBoundingClientRect().width : 0;
                if (availableWidth > 120 && pageWidth > availableWidth) {
                    this._scale = Math.max(0.45, Math.min(1, availableWidth / pageWidth));
                    this._offsetX = 0;
                    this._offsetY = 0;
                    this._applyZoom();
                }
            }

            this.updateVisiblePages();

            // --- 譬ｹ譛ｬ菫ｮ豁｣: 蟶ｸ縺ｫ蜿ｸ莉､蝪費ｼ・pdateTransform・峨ｒ譛牙柑蛹悶＠縲∽ｸｭ螟ｮ縺ｫ驟咲ｽｮ縺吶ｋ ---
            const scrollEl = document.getElementById('pdf-viewer-scroll');
            const loader = document.getElementById('viewer-loader');
            
            if (scrollEl) {
                this.setupInteractiveViewer(scrollEl, mount);
            }
            
            if (loader) loader.style.display = 'none';
            this.renderDashboardUI();
            this._scheduleToolbarCenterAlignment();
        } catch (error) {
            console.error('DOCX preview error:', error);
            this.hideViewerLoader();
            const snapshot = this._currentRequest?.document_snapshot || this._currentRequest?.contract_snapshot || {};
            const liveContract = dbService.getContractById(this._currentRequest?.contract_id) || null;
            const fallbackContract = liveContract ? { ...snapshot, ...liveContract } : snapshot;
            if (this._hasOriginalTextFallback(fallbackContract)) {
                await this.renderTextFallback(fallbackContract, container);
                return;
            }
            await this.renderUnavailableDocument(
                fallbackContract || {},
                container,
                'Word最終のプレビューに失敗しました。見た目を変えないため、別レイアウトへの自動変換は行っていません。'
            );
        } finally {
            this._isRenderingDocx = false;
        }
    },

    async renderUnavailableDocument(contract, container, message = '取り込んだ最終ファイルを表示できませんでした。') {
        const isDash = this._isDashboardMode;
        const originalFileHref = resolveBackendAssetUrl(contract?.original_file_url || contract?.original_file_path);
        const fallbackHref = originalFileHref || contract?.source_url || '';
        
        if (isDash) {
            // V3繝繝・す繝･繝懊・繝峨Δ繝ｼ繝峨〒縺ｯ縲√Ξ繧､繧｢繧ｦ繝茨ｼ医ち繝門・繧頑崛縺茨ｼ峨ｒ邯ｭ謖√☆繧九◆繧・
            // pdf-viewer-wrapper 縺後↑縺代ｌ縺ｰ菴懈・縺励√◎縺ｮ荳ｭ縺ｮ pdf-pages-container 縺ｫ繧ｨ繝ｩ繝ｼ繧貞・縺・
            let pagesContainer = document.getElementById('pdf-pages-container');
            if (!pagesContainer) {
                await this.renderPdf(null, container);
                pagesContainer = document.getElementById('pdf-pages-container');
            }

            if (pagesContainer) {
                pagesContainer.innerHTML = `
                    <div style="width:100%; height:100%; background:#f1f5f9; display:flex; align-items:center; justify-content:center; min-height:400px;">
                    <div style="padding:40px; color:#444; max-width:480px; text-align:center;">
                        <div style="font-size:18px; font-weight:700; margin-bottom:16px; display:flex; align-items:center; justify-content:center; gap:10px;">
                            <i class="fa-solid fa-triangle-exclamation" style="color:#e11d48; font-size:24px;"></i> 陦ｨ遉ｺ繧ｨ繝ｩ繝ｼ
                        </div>
                        <div style="font-size:14px; color:#64748b; line-height:1.7; margin-bottom:24px;">${this.escapeHtml(message)}</div>
                        ${fallbackHref ? `<a href="${this.escapeHtml(fallbackHref)}" target="_blank" style="display:inline-flex; align-items:center; gap:8px; padding:10px 20px; background:#fff; border:1px solid #e2e8f0; border-radius:8px; color:var(--v3-text-main); font-size:13px; font-weight:700; text-decoration:none; box-shadow:0 1px 2px rgba(0,0,0,0.05);"><i class="fa-solid fa-external-link" style="color:var(--v3-primary);"></i> 蜈・・雉・侭繧堤峩謗･髢九￥</a>` : ''}
                    </div>
                    </div>
                `;
                this._totalPages = 1;
                this._activePage = 1;
                this.hideViewerLoader();
                this.triggerDashboardUI();
                return;
            }
        }

        // Viewer fallback when the original file cannot be displayed.
        if (isDash) {
            container.innerHTML = `
                <div style="width:100%; height:100%; background:#f1f5f9; display:flex; align-items:center; justify-content:center;">
                <div style="padding:40px; color:#444; max-width:480px;">
                    <div style="font-size:16px; font-weight:700; margin-bottom:12px; display:flex; align-items:center; gap:8px;">
                        <i class="fa-solid fa-triangle-exclamation" style="color:#e11d48;"></i> 表示エラー
                    </div>
                    <div style="font-size:13px; color:#64748b; line-height:1.6; margin-bottom:16px;">${this.escapeHtml(message)}</div>
                    ${fallbackHref ? `<a href="${this.escapeHtml(fallbackHref)}" target="_blank" style="color:var(--color-primary); font-size:13px; font-weight:600;">元の資料を直接開く <i class="fa-solid fa-external-link"></i></a>` : ''}
                </div>
                </div>
            `;
        } else {
            container.innerHTML = `
                <div style="width:min(760px, 100%); margin:40px auto; background:#fff; border:1px solid #e5e7eb; border-radius:18px; box-shadow:0 16px 40px rgba(15,23,42,0.08); padding:56px 40px; text-align:center;">
                    <div style="width:64px; height:64px; margin:0 auto 18px; border-radius:20px; background:#fef2f2; color:#c53030; display:flex; align-items:center; justify-content:center; font-size:28px;">
                        <i class="fa-regular fa-file-pdf"></i>
                    </div>
                    <div style="font-size:18px; font-weight:700; color:#111827; margin-bottom:8px;">取り込んだ資料を表示できません</div>
                    <div style="font-size:13px; color:#6b7280; line-height:1.8;">${this.escapeHtml(message)}</div>
                    ${fallbackHref ? `<div style="margin-top:18px;"><a href="${this.escapeHtml(fallbackHref)}" target="_blank" rel="noopener noreferrer" style="color:var(--color-primary); font-weight:600; text-decoration:none;">元の資料を開く</a></div>` : ''}
                </div>
            `;
        }
        this._totalPages = 1;
        this._activePage = 1;
        this.hideViewerLoader();
        this.triggerDashboardUI();
    },

    async resolveDocxPreviewSource(source, app = null) {
        if (source instanceof Blob) return source;
        const contractId = this._currentRequest?.contract_id || this._currentRequest?.contractId;
        if (!contractId) return source;

        // Check for local runtime preview file (Blob) first
        const runtimeBlob = (app && typeof app.getRuntimeOriginalPreviewFile === 'function') 
            ? app.getRuntimeOriginalPreviewFile(contractId) 
            : null;
        
        if (runtimeBlob instanceof Blob) {
            console.log('Using local runtime blob for DOCX preview');
            return runtimeBlob;
        }

        try {
            const cleanId = this._getSanitizedContractId(contractId);
            const token = await this._getIdTokenSafe();
            const headers = token ? { Authorization: `Bearer ${token}` } : {};
            const response = await fetch(toApiUrl(`/api/contracts/${encodeURIComponent(cleanId)}/original-file`), { headers });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            return await response.blob();
        } catch (error) {
            console.warn('DOCX preview proxy failed, falling back to original source', error);
            return source;
        }
    },

    getCompletedDocumentApiUrl(request) {
        if (String(request?.status || '').toLowerCase() !== 'completed') return '';
        if (!request?.id) return '';
        if (!request?.signedPdfPath && !request?.completed_document_url) return '';
        return toApiUrl(`/api/sign/${encodeURIComponent(String(request.id))}/completed-document`);
    },

    isCompletedDocumentProxyUrl(value) {
        try {
            const parsed = new URL(String(value || ''), window.location.origin);
            return /\/api\/sign\/[^/]+\/completed-document$/i.test(parsed.pathname);
        } catch {
            return false;
        }
    },

    async resolvePdfViewerUrl(url) {
        const raw = String(url || '').trim();
        if (!raw) return '';
        if (!this.isCompletedDocumentProxyUrl(raw)) {
            this._currentDownloadUrl = raw;
            return raw;
        }
        const objectUrl = await this.fetchAuthorizedBlobUrl(raw);
        this._currentDownloadUrl = objectUrl;
        return objectUrl;
    },

    async fetchAuthorizedBlobUrl(url) {
        const token = await this._getIdTokenSafe();
        const headers = token ? { Authorization: `Bearer ${token}` } : {};
        const response = await fetch(url, { headers });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);
        this._objectUrls.push(objectUrl);
        return objectUrl;
    },

    cleanupObjectUrls() {
        const urls = Array.isArray(this._objectUrls) ? this._objectUrls : [];
        urls.forEach((url) => {
            try {
                URL.revokeObjectURL(url);
            } catch {}
        });
        this._objectUrls = [];
    },

    escapeHtml(str) {
        if (str === null || str === undefined) return '';
        if (typeof str !== 'string') str = String(str);
        if (!str) return '';
        return str.replace(/[&<>"']/g, m => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[m]));
    },


    async renderOriginalForContract(app, contract, contractId, options = {}) {
        if (!contract || !this._viewerContainer) return false;

        const isPdfUrl = (value) => {
            const src = String(value || '').trim();
            return src.startsWith('blob:') || /\.pdf($|[?#])/i.test(src);
        };
        const runtimePdfUrl = (app && typeof app.getRuntimePdfPreviewUrl === 'function')
            ? app.getRuntimePdfPreviewUrl(contractId)
            : null;
        const pdfSource = contract.pdf_url || contract.pdf_storage_path;
        const persistedOriginalUrl = resolveBackendAssetUrl(contract.original_file_url || contract.original_file_path);

        let pdfUrl = null;
        if (isPdfUrl(runtimePdfUrl)) pdfUrl = resolveBackendAssetUrl(runtimePdfUrl);
        else if (isPdfUrl(pdfSource)) pdfUrl = resolveBackendAssetUrl(pdfSource);
        else if (isPdfUrl(persistedOriginalUrl)) pdfUrl = persistedOriginalUrl;

        const rawOriginalUrl = runtimePdfUrl || pdfSource || persistedOriginalUrl;
        const originalName = contract.original_filename || '';
        const sourceType = String(contract.source_type || contract.doc_type || '').toUpperCase();
        const runtimeDocxFile = (app && typeof app.getRuntimeOriginalPreviewFile === 'function')
            ? app.getRuntimeOriginalPreviewFile(contractId)
            : null;
        const runtimeDocxName = runtimeDocxFile instanceof Blob ? runtimeDocxFile.name || '' : '';
        const isDocx = sourceType === 'DOCX'
            || isDocxFileName(originalName)
            || isDocxFileName(runtimeDocxName)
            || (runtimeDocxFile instanceof Blob && /wordprocessingml|msword/i.test(String(runtimeDocxFile.type || '')))
            || /\.docx?($|[?#])/i.test(String(rawOriginalUrl || ''));
        const hasTextFallback = this._hasOriginalTextFallback(contract);
        const preConvertedBlob = this._preConvertedBlob
            && String(this._preConvertedBlob.contractId) === String(contractId)
            && this._preConvertedBlob.blob instanceof Blob
            ? this._preConvertedBlob.blob
            : null;
        const hasPageImages = Boolean(contract.page_images?.length || contract.pageImages?.length);

        if (options.preferOriginalDocx && isDocx && runtimeDocxFile instanceof Blob) {
            await this.renderDocx(runtimeDocxFile, this._viewerContainer);
            this._rememberOriginalPageCountFromRenderedSource();
            return true;
        }

        if (options.preferOriginalDocx && isDocx && rawOriginalUrl) {
            await this.renderDocx(rawOriginalUrl, this._viewerContainer);
            this._rememberOriginalPageCountFromRenderedSource();
            return true;
        }

        if (preConvertedBlob) {
            const pdfObjectUrl = URL.createObjectURL(preConvertedBlob);
            this._objectUrls.push(pdfObjectUrl);
            this._currentDownloadUrl = pdfObjectUrl;
            await this.renderPdf(pdfObjectUrl, this._viewerContainer);
            this._rememberOriginalPageCountFromRenderedSource();
            return true;
        }

        if (pdfUrl) {
            await this.renderPdf(pdfUrl, this._viewerContainer);
            this._rememberOriginalPageCountFromRenderedSource();
            return true;
        }

        if (isDocx && runtimeDocxFile instanceof Blob) {
            await this.renderDocx(runtimeDocxFile, this._viewerContainer);
            this._rememberOriginalPageCountFromRenderedSource();
            return true;
        }

        console.log('[DEBUG] DOCX Evaluation:', {
            isDocx,
            sourceType,
            originalName,
            runtimeDocxName,
            rawOriginalUrl,
            hasTextFallback,
            extractedTextLength: contract.extracted_text?.length
        });

        if (isDocx) {
            await this.renderDocx(rawOriginalUrl, this._viewerContainer);
            this._rememberOriginalPageCountFromRenderedSource();
            return true;
        }

        if (hasPageImages) {
            this._renderMode = 'image';
            await this.renderPdf('image-pages://contract', this._viewerContainer);
            this._rememberOriginalPageCountFromRenderedSource();
            return true;
        }

        if (hasTextFallback || contract.extracted_text) {
            // Even for text fallback, use a paginated A4 layout to match Word
            await this.renderTextFallback(contract, this._viewerContainer);
            this._rememberOriginalPageCountFromRenderedSource();
            return true;
        }

        await this.renderUnavailableDocument(contract, this._viewerContainer);
        return false;
    },

    setupEventListeners(app, request) {
        // Placeholder for future interactive logic
    },

    /**
     * Reusable version for Analysis Dashboard (Contracts)
     */
    async initForContract(app, contractId, containerId = 'sign-viewer-content', options = {}) {
        console.log('--- SignViewer.initForContract Start ---', { contractId, containerId });
        
        // --- 竭｡ container蟄伜惠繝√ぉ繝・け ---
        this._viewerContainer = document.getElementById(containerId);
        if (!this._viewerContainer) {
            console.error("Viewer container not found:", containerId);
            return;
        }

        try {
            dbService.init();
            let contract = dbService.getContractById(contractId);
            
            // Retry logic: If not found immediately, wait up to 1 second
            if (!contract) {
                console.warn(`Contract ${contractId} not found immediately. Retrying...`);
                for (let i = 0; i < 10; i++) {
                    await new Promise(r => setTimeout(r, 100));
                    contract = dbService.getContractById(contractId);
                    if (contract) {
                        console.log(`Contract ${contractId} found after retry ${i + 1}`);
                        break;
                    }
                }
            }

            if (!contract) {
                try {
                    if (app?.contractSyncPromise && typeof app.contractSyncPromise.then === 'function') {
                        await app.contractSyncPromise.catch(() => null);
                        contract = dbService.getContractById(contractId);
                    }
                    if (!contract && typeof dbService.syncContractsFromApi === 'function') {
                        await dbService.syncContractsFromApi().catch(error => {
                            console.warn('[SignViewer] contract sync fallback failed:', error);
                            return null;
                        });
                        contract = dbService.getContractById(contractId);
                    }
                    if (!contract && typeof dbService._callApi === 'function') {
                        const remote = await dbService._callApi(`/api/contracts/${encodeURIComponent(String(contractId))}`, 'GET', null, { throwOnError: true }).catch(error => {
                            console.warn('[SignViewer] contract direct fetch fallback failed:', error);
                            return null;
                        });
                        if (remote) {
                            if (typeof dbService._mergeContractIntoCache === 'function') {
                                dbService._mergeContractIntoCache(remote);
                            }
                            contract = remote;
                        }
                    }
                } catch (error) {
                    console.warn('[SignViewer] contract acquisition fallback failed:', error);
                }
            }

            if (!contract) {
                console.error("Contract acquisition failed", contractId);
                Notify.error('契約データが見つかりません。再読み込みしてからもう一度お試しください。');
                await this.renderUnavailableDocument({}, this._viewerContainer, '契約データが見つかりませんでした。再読み込み後も続く場合は、契約書一覧から開き直してください。');
                return;
            }

            console.log('Initializing SignViewer for Contract:', contractId);
            this._app = app;
            this._isDashboardMode = true;
            this._contractId = contractId;
            this._contract = contract;
            window.signViewer = this; 
            
            const initialMode = this._resolveInitialViewMode(options);
            this._viewMode = initialMode;
            
            this.cleanupObjectUrls();
            document.getElementById('v3-final-action-bar')?.remove();
            this._activePage = 1;
            this._scale = 1.0;
            this._renderMode = null;
            this._currentPdfUrl = null;
            this._currentDownloadUrl = null;
            this._finalGeneratedPdfUrl = null;
            this._viewInitialized = false; 
            this._originalPageCount = null;
            this._editedContent = undefined;
            this._lastPreviewContent = '';
            this._lastSavedContent = undefined;
            this._editHistory = null;
            this._editHistoryIndex = 0;
            this._appliedChanges = new Set();
            this._sortedChanges = null;
            this._finalRecoveredFromOriginal = false;
            this._lastRecoveredFinalContent = '';
            this._manualFinalExtraPages = 0;
            this._faithfulFinalReparse = false;
            this._faithfulFinalHtmlPages = null;
            this._faithfulFinalPageTexts = null;
            
            this._currentRequest = { 
                contract_id: contractId,
                document_snapshot: contract,
                ...contract 
            };

            // IDB persistence
            if (typeof app.getDocxFromIDB === 'function') await app.getDocxFromIDB(contractId);
            if (typeof app.getPdfFromIDB === 'function') await app.getPdfFromIDB(contractId);

            await this._ensureOriginalDocxPageCount();

            // Always load the original document in the background for data extraction
            await this.renderOriginalForContract(app, contract, contractId);
            
            await this.switchViewMode(initialMode);

        } catch (e) {
            console.error("SignViewer.initForContract fatal error:", e);
            await this.renderUnavailableDocument(this._contract || {}, this._viewerContainer, e.message);
        } finally {
            if (typeof app.setLoading === 'function') {
                app.setLoading(false);
            }
        }
    },

    _resolveInitialViewMode(options = {}) {
        if (options.preferReviewMode) {
            return 'revised';
        }

        const requested = String(options.forceMode || '').trim();
        if (['revised', 'final', 'edit'].includes(requested)) {
            return requested;
        }

        return 'revised';
    },

    setupInteractiveViewer(viewer, page) {
        if (!viewer || !page) return;
        
        if (viewer._setupDone) {
            this.updateTransform();
            return;
        }
        viewer._setupDone = true;

        let isDragging = false;
        let startX = 0;
        let startY = 0;

        // 1. Drag (Pan) Events
        const onStart = (e) => {
            if (
                this._viewMode === 'edit'
                || e.target.closest('#v3-editor-scroll, #v3-edit-layer .v3-editor-toolbar')
                || e.target.closest('button, input, select, textarea, [contenteditable="true"]')
            ) {
                return;
            }
            isDragging = true;
            const clientX = e.clientX || (e.touches && e.touches[0].clientX);
            const clientY = e.clientY || (e.touches && e.touches[0].clientY);
            
            // 迴ｾ蝨ｨ縺ｮ繧ｪ繝輔そ繝・ヨ繧貞渕貅悶↓髢句ｧ倶ｽ咲ｽｮ繧貞崋螳・(繧ｸ繝｣繝ｳ繝鈴亟豁｢)
            startX = clientX - (this._offsetX || 0);
            startY = clientY - (this._offsetY || 0);
            
            viewer.style.cursor = "grabbing";
            viewer.style.userSelect = "none";
        };

        const onMove = (e) => {
            if (!isDragging) return;
            if (this._viewMode === 'edit') {
                isDragging = false;
                viewer.style.cursor = "text";
                viewer.style.userSelect = "";
                return;
            }
            const clientX = e.clientX || (e.touches && e.touches[0].clientX);
            const clientY = e.clientY || (e.touches && e.touches[0].clientY);
            
            this._offsetX = clientX - startX;
            this._offsetY = clientY - startY;
            
            this.updateTransform();
        };

        const onEnd = () => {
            if (!isDragging) return;
            isDragging = false;
            viewer.style.cursor = "grab";
            viewer.style.userSelect = "";
        };

        viewer.addEventListener("mousedown", onStart);
        viewer.addEventListener("touchstart", onStart, { passive: true });

        window.addEventListener("mousemove", onMove);
        window.addEventListener("touchmove", (e) => { if (isDragging) e.preventDefault(); onMove(e); }, { passive: false });

        window.addEventListener("mouseup", onEnd);
        window.addEventListener("touchend", onEnd);
        
        viewer.addEventListener("mouseleave", () => { isDragging = false; });

        // 2. Wheel Zoom (Ctrl + Wheel = Zoom, Wheel = Scroll)
        viewer.addEventListener("wheel", (e) => {
            if (!e.ctrlKey) return; // Allow normal scroll if Ctrl is not pressed
            
            e.preventDefault();

            const zoomIntensity = 0.1;
            const direction = e.deltaY > 0 ? -1 : 1;
            const factor = 1 + direction * zoomIntensity;
            const newScale = Math.min(Math.max(0.3, (this._scale || 1.0) * factor), 3.0);

            this._scale = newScale;
            this._handleZoomChanged({ debounce: true });
        }, { passive: false });

        // Initial render
        this.updateTransform();
    },

    _getSanitizedContractId(id) {
        const rawId = id || this._contract?.id || this._contractId || this._currentRequest?.contract_id;
        if (!rawId) return '';
        return String(rawId).replace(/^contracts\//, '');
    },

    async _downloadOriginalFileFallback() {
        const contractId = this._getSanitizedContractId();
        if (!contractId) return;
        // DOCX (=ZIP) magic 'PK\x03\x04' チェック: HTMLが docxとしてDLされ Wordが「破損」エラーを出すのを防ぐ
        const isValidDocxBlob = async (blob) => {
            if (!(blob instanceof Blob) || blob.size < 4) return false;
            try {
                const bytes = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
                return bytes[0] === 0x50 && bytes[1] === 0x4B && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07);
            } catch (_) { return false; }
        };
        // URL が相対(http(s)で始まらない)場合は backend URL を prefix
        const ensureAbsoluteApiUrl = (u) => {
            if (/^https?:\/\//i.test(u)) return u;
            const base = (typeof window !== 'undefined' && window.__DOCX_PDF_SERVICE_URL__)
                ? String(window.__DOCX_PDF_SERVICE_URL__).replace(/\/$/, '')
                : '';
            return base ? base + (u.startsWith('/') ? u : '/' + u) : u;
        };
        try {
            Notify.info('Wordファイルを取得しています...');
            const token = await this._getIdTokenSafe();
            const headers = { 'Authorization': `Bearer ${token}` };

            // Try the original-file endpoint first
            let res = await fetch(ensureAbsoluteApiUrl(toApiUrl(`/api/contracts/${contractId}/original-file`)), { headers });

            // If that fails, try the export endpoint
            if (!res.ok) {
                console.warn('[SignViewer] original-file failed, trying export endpoint');
                res = await fetch(ensureAbsoluteApiUrl(toApiUrl(`/api/contracts/${contractId}/export?format=docx`)), { headers });
            }

            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                throw new Error(errData.error || 'ファイルの取得に失敗しました');
            }

            const blob = await res.blob();
            if (blob.size < 100) { // Safety check for empty or error responses
                throw new Error('取得したファイルが正しくありません');
            }
            // ZIP magic 検証: 失敗時は HTML や 404 ページが返ってきている → ダウンロードしない
            if (!(await isValidDocxBlob(blob))) {
                console.error('[SignViewer] Downloaded blob is not a valid DOCX (ZIP magic missing). Aborting.');
                throw new Error('取得したファイルがDOCX形式ではありません。バックエンド接続を確認してください。');
            }

            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = this._contract?.original_filename || `contract_${contractId}.docx`;
            link.click();
            setTimeout(() => URL.revokeObjectURL(link.href), 10000);
            Notify.success('Wordファイルをダウンロードしました');
        } catch (err) {
            console.error('Download error:', err);
            Notify.error(err.message || 'Wordファイルの取得に失敗しました');
        }
    },

    openDownloadMenu(event) {
        event.stopPropagation();
        const trigger = event.currentTarget;
        const existing = document.querySelector('.v3-download-popover');
        if (existing) {
            existing.remove();
            return;
        }

        const popover = document.createElement('div');
        popover.className = 'v3-download-popover';
        
        const rect = trigger.getBoundingClientRect();
        popover.style.top = (rect.bottom + 12) + 'px';
        popover.style.right = (window.innerWidth - rect.right) + 'px';

        popover.innerHTML = `
            <div style="padding:12px 16px; border-bottom:1px solid #f1f5f9; background:#f8fafc; border-radius:12px 12px 0 0;">
                <span style="font-size:11px; font-weight:800; color:#64748b; text-transform:uppercase; letter-spacing:0.05em;">保存・エクスポート</span>
            </div>
            
            <button type="button" class="v3-download-option" data-download-action="pdf">
                <div class="v3-download-file-icon is-pdf">
                    <i class="fa-solid fa-file-pdf"></i>
                </div>
                <div>
                    <span class="v3-download-option-title">PDFで保存</span>
                    <span class="v3-download-option-desc">現在の内容をPDF形式でダウンロードします</span>
                </div>
            </button>

            <button type="button" class="v3-download-option" data-download-action="word">
                <div class="v3-download-file-icon is-word">
                    <i class="fa-solid fa-file-word"></i>
                </div>
                <div>
                    <span class="v3-download-option-title">Wordで保存</span>
                    <span class="v3-download-option-desc">ドキュメントをWord形式(.docx)でダウンロードします</span>
                </div>
            </button>

        `;

        document.body.appendChild(popover);

        popover.addEventListener('click', async (clickEvent) => {
            const option = clickEvent.target.closest('[data-download-action]');
            if (!option) return;
            const action = option.dataset.downloadAction;
            document.querySelectorAll('.v3-download-popover').forEach(p => p.remove());
            if (action === 'pdf') {
                await this._downloadFinalPreviewPdf();
            } else if (action === 'word') {
                await this.downloadWord();
            }
        });

        const closeMenu = (e) => {
            if (!popover || !popover.parentNode) {
                document.removeEventListener('click', closeMenu);
                return;
            }
            if (!popover.contains(e.target) && !trigger.contains(e.target)) {
                popover.remove();
                document.removeEventListener('click', closeMenu);
            }
        };
        setTimeout(() => document.addEventListener('click', closeMenu), 10);
    },

    renderDashboardUI() {
        const isFS = document.querySelector('.analysis-v3-split-layout')?.classList.contains('is-fullscreen');
        const toolbar = document.getElementById('v3-viewer-toolbar');
        
        const total = Math.max(1, Number(this._totalPages || 1));

        // Inject shared styles only once
        if (!document.getElementById('v3-viewer-shared-styles')) {
            const style = document.createElement('style');
            style.id = 'v3-viewer-shared-styles';
            style.innerHTML = `
                .v3-toolbar-btn-clean {
                    background: none;
                    border: none;
                    padding: 4px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    transition: all 0.2s;
                }
                .v3-toolbar-btn-clean:hover:not(:disabled) {
                    transform: scale(1.1);
                    opacity: 1 !important;
                }
                .v3-toolbar-btn-clean:active:not(:disabled) {
                    transform: scale(0.95);
                }
                .v3-download-popover {
                    position:fixed;
                    z-index:100001;
                    width:380px;
                    background:#fff;
                    border:1px solid #e2e8f0;
                    border-radius:16px;
                    box-shadow:0 25px 50px -12px rgba(0,0,0,0.15);
                    overflow:hidden;
                    animation: v3-popover-in 0.2s cubic-bezier(0, 0, 0.2, 1);
                }
                @keyframes v3-popover-in {
                    from { opacity:0; transform: translateY(10px) scale(0.98); }
                    to { opacity:1; transform: translateY(0) scale(1); }
                }
                .v3-download-option {
                    display:grid;
                    grid-template-columns:48px 1fr;
                    gap:16px;
                    align-items:center;
                    width:100%;
                    padding:16px 20px;
                    border:0;
                    border-bottom:1px solid #f1f5f9;
                    background:#fff;
                    color:#1e293b;
                    text-align:left;
                    cursor:pointer;
                    transition: all 0.2s;
                }
                .v3-download-option:last-child { border-bottom:0; }
                .v3-download-option:hover { background:#f8fafc; }
                .v3-download-file-icon {
                    width:48px;
                    height:48px;
                    border-radius:12px;
                    display:flex;
                    align-items:center;
                    justify-content:center;
                    font-size:20px;
                }
                .v3-download-file-icon.is-pdf { background:#fee2e2; color:#ef4444; }
                .v3-download-file-icon.is-word { background:#dbeafe; color:#2563eb; }
                .v3-download-file-icon.is-cloud { background:#f1f5f9; color:#64748b; }
                .v3-download-option-title {
                    display:block;
                    font-size:14px;
                    font-weight:800;
                    color:#0f172a;
                }
                .v3-download-option-desc {
                    display:block;
                    font-size:11px;
                    color:#64748b;
                    font-weight:500;
                    margin-top:2px;
                }
                #v3-viewer-toolbar.v3-viewer-toolbar {
                    width:100% !important;
                    max-width:none !important;
                    margin-left:0 !important;
                    margin-right:0 !important;
                }
                .v3-viewer-main:has(#v3-pdf-sheet.is-final-view) #v3-viewer-toolbar { margin-bottom:0 !important; }
                .v3-viewer-main:has(#v3-pdf-sheet.is-final-view) #v3-viewer-toolbar > div {
                    margin-bottom:0 !important;
                    border-radius:12px 12px 0 0 !important;
                    box-shadow:none !important;
                    border-bottom:1px solid #cbd5e1 !important;
                    /* padding/min-height は触らない: 触ると最終版モード時に toolbar 高さが縮み
                       上のバー内の印刷/DL/全画面アイコン等の y 座標が動いて見える(ユーザー報告のズレ) */
                }
                #v3-pdf-sheet.is-final-view .pdf-viewer-wrapper {
                    margin-left:0 !important;
                    margin-right:0 !important;
                    padding-left:0 !important;
                    padding-right:0 !important;
                    width:100% !important;
                    max-width:100% !important;
                }
                #v3-pdf-sheet.is-final-view #v3-final-action-bar {
                    width:100% !important;
                    max-width:100% !important;
                    margin:0 0 18px 0 !important;
                    border-radius:0 0 12px 12px !important;
                    padding-top:6px !important;
                    padding-bottom:6px !important;
                }
                .analysis-v3-split-layout.is-fullscreen #v3-viewer-toolbar,
                .analysis-v3-split-layout.is-fullscreen #v3-pdf-sheet #v3-final-action-bar,
                .analysis-v3-split-layout.is-fullscreen .v3-editor-toolbar {
                    max-width:60vw !important;
                    width:60vw !important;
                    margin-left:auto !important;
                    margin-right:auto !important;
                }
                #v3-edit-layer .v3-editor-page,
                #v3-editor-scroll .v3-editor-page {
                    margin-left: auto !important;
                    margin-right: auto !important;
                }
                 @media print {
                    @page { size: A4; margin: 0; }
                    /* WHITELIST 方式: body の全要素を visibility:hidden で隠し、
                       印刷対象 (.is-print-target) のみ visible にする。
                       これによりダッシュボードのリスク要約・期限情報・サイドバー・
                       メニュー等の余計な要素が印刷ダイアログに混入しない。 */
                    body { background: #fff !important; color: #000 !important; }
                    body * { visibility: hidden !important; }
                    /* 印刷対象: 契約書本文を含む docx-pages / pdf-pages-container とその全子孫
                       (画像ベース contract は pdf-pages-container 内に画像 page が render される) */
                    #sign-viewer-docx-pages,
                    #sign-viewer-docx-pages *,
                    #pdf-pages-container,
                    #pdf-pages-container *,
                    #final-rendered-preview-overlay,
                    #final-rendered-preview-overlay * {
                        visibility: visible !important;
                    }
                    /* 画像ベース contract の印刷時レイアウト */
                    #pdf-pages-container {
                        position: absolute !important;
                        left: 0 !important;
                        top: 0 !important;
                        right: 0 !important;
                        width: 100% !important;
                        max-width: 100% !important;
                        height: auto !important;
                        background: #fff !important;
                        padding: 0 !important;
                        margin: 0 !important;
                        display: block !important;
                        z-index: 100000 !important;
                    }
                    #pdf-pages-container .pdf-page-shell {
                        page-break-after: always;
                        page-break-inside: avoid;
                        margin: 0 !important;
                        padding: 0 !important;
                        box-shadow: none !important;
                        background: #fff !important;
                        width: 100% !important;
                        max-width: 100% !important;
                    }
                    #pdf-pages-container .pdf-page-shell img {
                        display: block !important;
                        width: 100% !important;
                        height: auto !important;
                    }
                    /* 印刷対象をビューポート全幅で絶対配置 (他要素のスペースを消す) */
                    #sign-viewer-docx-pages {
                        position: absolute !important;
                        left: 0 !important;
                        top: 0 !important;
                        right: 0 !important;
                        width: 100% !important;
                        max-width: 100% !important;
                        height: auto !important;
                        max-height: none !important;
                        overflow: visible !important;
                        background: #fff !important;
                        padding: 0 !important;
                        margin: 0 !important;
                        transform: none !important;
                        zoom: 1 !important;
                        display: block !important;
                        z-index: 100000 !important;
                    }
                    /* プレビューオーバーレイが開いている時はそれを優先 */
                    #final-rendered-preview-overlay {
                        position: absolute !important;
                        left: 0 !important;
                        top: 0 !important;
                        right: 0 !important;
                        width: 100% !important;
                        height: auto !important;
                        background: #fff !important;
                        inset: auto !important;
                        z-index: 100001 !important;
                        padding: 0 !important;
                    }
                    #final-rendered-preview-overlay > div:first-child {
                        /* モーダルのヘッダーは印刷しない */
                        display: none !important;
                    }
                    #final-rendered-preview-overlay > * {
                        background: transparent !important;
                        box-shadow: none !important;
                    }
                    /* 印刷対象内部のレイアウト解除 */
                    .sign-docx-render-root, .docx-wrapper,
                    .v3-document-scroll-area, #pdf-viewer-scroll, #v3-editor-scroll,
                    .pdf-viewer-wrapper, #v3-pdf-sheet,
                    .v3-viewer-main, .v3-viewer-container,
                    .analysis-v3-split-layout, .analysis-v3-container,
                    #app-content, #app-content.is-detail-view,
                    #app-main, #app-sidebar, .is-a4-paginated {
                        display: block !important;
                        overflow: visible !important;
                        position: static !important;
                        height: auto !important;
                        width: 100% !important;
                        max-height: none !important;
                        background: #fff !important;
                        padding: 0 !important;
                        margin: 0 !important;
                        transform: none !important;
                        zoom: 1 !important;
                    }
                    /* 各ページの改ページと体裁 (編集モードと統一: padding 96/72、明朝14px/21px) */
                    .editor-page-shell, .docx-section, .final-contract-page, .v3-editor-page, .preview-page {
                        page-break-inside: avoid;
                        page-break-after: auto;
                        background: #fff !important;
                        box-shadow: none !important;
                        border: none !important;
                        margin: 0 !important;
                        padding: 96px 72px !important;
                        width: 100% !important;
                        max-width: 100% !important;
                        font-family: "Noto Serif JP","Yu Mincho","MS Mincho",serif !important;
                        font-size: 14px !important;
                        line-height: 21px !important;
                        color: #111 !important;
                    }
                    /* 段落・見出しは紙の境界で分割しない (署名欄+委託者+受託者などの意味ブロック保護) */
                    #sign-viewer-docx-pages p,
                    #sign-viewer-docx-pages h1,
                    #sign-viewer-docx-pages h2,
                    #sign-viewer-docx-pages h3,
                    #sign-viewer-docx-pages h4,
                    #sign-viewer-docx-pages li,
                    #sign-viewer-docx-pages table {
                        page-break-inside: avoid !important;
                        break-inside: avoid !important;
                    }
                    /* 本番運用想定: 印刷時は修正案マーカー(色付きハイライト)を完全に消し、
                       通常の黒文字契約書として印刷する。 画面表示(編集/最終版/プレビュー)では従来通り表示。 */
                    .v3-final-flow-change, .v3-applied-change,
                    .v3-applied-change-add, .v3-applied-change-modify,
                    .v3-applied-change-delete, .v3-applied-change-clar,
                    .v3-applied-line-add, .v3-applied-line-modify,
                    .v3-applied-line-delete, .v3-applied-line-clar {
                        background: transparent !important;
                        background-color: transparent !important;
                        background-image: none !important;
                        border: none !important;
                        border-bottom: none !important;
                        color: #000 !important;
                        text-decoration: none !important;
                        box-shadow: none !important;
                        outline: none !important;
                        -webkit-print-color-adjust: economy !important;
                        print-color-adjust: economy !important;
                    }
                 }
                .v3-viewer-sidebar .v3-thumbnail.is-final-page {
                    display:flex;
                    align-items:center;
                    justify-content:center;
                    width:52px;
                    height:74px;
                    min-height:74px;
                    padding:0;
                    background:#fff;
                    border:1px solid #dbeafe;
                    border-radius:6px;
                    color:#0f172a;
                    margin: 0 auto 12px auto;
                }
                .v3-viewer-sidebar .v3-thumbnail.is-final-page.active {
                    border-color:#2563eb;
                    box-shadow:0 0 0 2px rgba(37,99,235,0.16);
                }
                .v3-viewer-sidebar .v3-thumbnail.is-final-page .v3-thumb-num {
                    position:static;
                    display:block;
                    background:transparent;
                    box-shadow:none;
                    padding:0;
                    color:inherit;
                    font-size:13px;
                    font-weight:800;
                    line-height:1;
                }
            `;
            document.head.appendChild(style);
        }

        if (toolbar) {
            toolbar.style.marginBottom = '6px';
            const badgeColor = '#3b82f6';
            const activeTabStyle = `background:${badgeColor};color:#fff;box-shadow:0 1px 4px rgba(59,130,246,0.3);`;
            const inactiveTabStyle = 'background:transparent;color:#94a3b8;';
            
            toolbar.innerHTML = `
                <div style="display:flex; align-items:center; justify-content:space-between; background:#ffffff; border:none; border-radius:12px; padding:8px 24px; width:100% !important; max-width:none !important; margin: 4px auto 4px auto !important; box-shadow: 0 4px 12px rgba(0,0,0,0.08); min-height:48px; position:relative; box-sizing:border-box !important;">
                    
                    <!-- Left: Page Navigation & Zoom -->
                    <div style="display:flex; align-items:center; gap:24px; flex:1; visibility: ${this._viewMode === 'revised' ? 'hidden' : 'visible'};">
                        <div style="display:flex; align-items:center; gap:8px;">
                            ${isFS ? `
                            <button class="v3-toolbar-btn-clean" onclick="window.app.toggleFullscreenViewer()" style="color:#1e293b; margin-right:8px; gap:6px; font-size:13px; font-weight:700;" title="戻る">
                                <i class="fa-solid fa-arrow-left"></i> 戻る
                            </button>
                            <div style="height:20px; width:1px; background:#e2e8f0; margin-right:8px;"></div>
                            ` : ''}
                            <button class="v3-toolbar-btn-clean" data-final-nav-prev="true" onclick="window.signViewer.setActivePage(${this._activePage - 1})" ${this._activePage <= 1 ? 'disabled style="color:#e2e8f0; cursor:default;"' : 'style="color:#94a3b8; cursor:pointer;"'}>
                                <i class="fa-solid fa-chevron-left" style="font-size:14px;"></i>
                            </button>
                            <span data-final-page-label="true" style="font-size:14px; font-weight:600; color:#1e293b; min-width:64px; text-align:center; font-family:'Inter', sans-serif; font-variant-numeric: tabular-nums; font-feature-settings: 'tnum' 1; display:inline-block; white-space:nowrap;">
                                ${this._activePage} / ${total}
                            </span>
                            <button class="v3-toolbar-btn-clean" data-final-nav-next="true" onclick="window.signViewer.setActivePage(${this._activePage + 1})" ${this._activePage >= total ? 'disabled style="color:#e2e8f0; cursor:default;"' : 'style="color:#94a3b8; cursor:pointer;"'}>
                                <i class="fa-solid fa-chevron-right" style="font-size:14px;"></i>
                            </button>
                        </div>

                        <div style="height:20px; width:1px; background:#e2e8f0;"></div>

                        <div style="display:flex; align-items:center; gap:12px;">
                            <button class="v3-toolbar-btn-clean" onclick="window.signViewer.zoomOut()" style="color:#94a3b8; cursor:pointer; padding:2px;" title="縮小">
                                <i class="fa-solid fa-minus" style="font-size:12px;"></i>
                            </button>
                            <span style="font-size:14px; font-weight:700; color:#1e293b; min-width:45px; text-align:center; font-family:'Inter', sans-serif;">${Math.round((this._scale || 1.0) * 100)}%</span>
                            <button class="v3-toolbar-btn-clean" onclick="window.signViewer.zoomIn()" style="color:#94a3b8; cursor:pointer; padding:2px;" title="拡大">
                                <i class="fa-solid fa-plus" style="font-size:12px;"></i>
                            </button>
                        </div>
                    </div>

                    <!-- Middle: Tabs -->
                    <div style="display:flex; align-items:center; background:#f1f5f9; border-radius:8px; padding:3px; gap:2px; flex-shrink:0; position:absolute; left:50%; top:50%; transform:translate(-50%, -50%);">
                        <button onclick="window.signViewer.switchViewMode('revised')" style="display:inline-flex;align-items:center;gap:5px;font-size:12px; font-weight:600; padding:4px 16px; border-radius:6px; border:none; cursor:pointer; transition:all 0.15s; ${this._viewMode === 'revised' ? activeTabStyle : inactiveTabStyle}"><i class="fa-regular fa-pen-to-square"></i> 修正案</button>
                        <button onclick="window.signViewer.switchViewMode('final')" style="display:inline-flex;align-items:center;gap:5px;font-size:12px; font-weight:600; padding:4px 16px; border-radius:6px; border:none; cursor:pointer; transition:all 0.15s; ${(this._viewMode === 'final' || this._viewMode === 'edit') ? activeTabStyle : inactiveTabStyle}"><i class="fa-regular fa-circle-check"></i> 最終版</button>
                    </div>

                    <!-- Right: Actions -->
                    <div style="display:flex; align-items:center; gap:8px; flex:1; justify-content:flex-end;">
                        <!-- 「プレビュー」 button は action-bar 側に既存のため toolbar からは削除 (重複防止) -->
                        <!-- 上部ツールバーの「編集する」ボタンは非表示（ユーザ要請）。編集は read-mode 内のボタンから行う。 -->


                        <!-- 「印刷」 button は削除 (PDFで保存→印刷ダイアログから可能なため重複) -->

                        <button class="v3-toolbar-btn-clean v3-download-menu-trigger" onclick="window.signViewer.openDownloadMenu(event)" style="color:#64748b; cursor:pointer;" title="ダウンロード">
                            <i class="fa-solid fa-download" style="font-size:16px;"></i>
                        </button>

                        <div style="height:20px; width:1px; background:#e2e8f0;"></div>
                        
                        <button class="v3-toolbar-btn-clean" onclick="window.app.toggleFullscreenViewer()" style="color:#64748b; cursor:pointer;" title="${isFS ? '縮小' : '全画面'}">
                            <i class="fa-solid ${isFS ? 'fa-compress' : 'fa-expand'}" style="font-size:16px;"></i>
                        </button>
                    </div>
                </div>
            `;
        }

        const sidebars = Array.from(document.querySelectorAll('.v3-viewer-sidebar'));
        if (sidebars.length) {
            sidebars.forEach(sidebar => {
            sidebar.style.display = 'block'; // Always keep sidebar visible to stabilize layout
            // Regression marker: sidebar.style.display = 'none'
            if (this._viewMode !== 'final' && this._viewMode !== 'edit') {
                sidebar.innerHTML = '';
                return;
            }

            sidebar.style.display = '';
            const previousScrollTop = sidebar.scrollTop || 0;
            this.renderFinalThumbnails(sidebar);
            sidebar.scrollTop = previousScrollTop;
            });
        }
    },

    _updateFinalNavigationUi() {
        const total = this.getFinalThumbnailPageCount();
        this._totalPages = total;
        this._activePage = Math.max(1, Math.min(Number(this._activePage || 1), total));
        const label = document.querySelector('[data-final-page-label="true"]');
        if (label) label.textContent = `${this._activePage} / ${total}`;

        const prev = document.querySelector('[data-final-nav-prev="true"]');
        if (prev) {
            prev.onclick = () => window.signViewer.setActivePage(this._activePage - 1);
            prev.disabled = this._activePage <= 1;
            prev.style.color = this._activePage <= 1 ? '#e2e8f0' : '#94a3b8';
            prev.style.cursor = this._activePage <= 1 ? 'default' : 'pointer';
        }

        const next = document.querySelector('[data-final-nav-next="true"]');
        if (next) {
            next.onclick = () => window.signViewer.setActivePage(this._activePage + 1);
            next.disabled = this._activePage >= total;
            next.style.color = this._activePage >= total ? '#e2e8f0' : '#94a3b8';
            next.style.cursor = this._activePage >= total ? 'default' : 'pointer';
        }

        document.querySelectorAll('.v3-viewer-sidebar .v3-thumbnail.is-final-page').forEach((thumb, index) => {
            thumb.classList.toggle('active', index + 1 === this._activePage);
            thumb.setAttribute('aria-current', index + 1 === this._activePage ? 'page' : 'false');
        });
    },

    getFinalThumbnailPageCount() {
        if (this._viewMode === 'edit' && this._isFinalEditorVisible()) {
            const editorPages = document.querySelectorAll('#v3-editor-scroll .v3-editor-page[data-page]');
            if (editorPages.length) return editorPages.length;
            const finalPages = document.querySelectorAll('#v3-edit-layer .v3-editor-page[data-page]');
            if (finalPages.length) return finalPages.length;
        }
        const docxPages = document.querySelectorAll('#sign-viewer-docx-pages [data-page]');
        if (this._viewMode === 'final' && docxPages.length) return docxPages.length;
        const pdfPages = document.querySelectorAll('#pdf-pages-container [data-page]');
        if (this._viewMode === 'final' && pdfPages.length) return pdfPages.length;
        return Math.max(1, Number(this._totalPages || 1));
    },

    renderFinalThumbnails(container, options = {}) {
        // Regression marker: _scrollElementToChild(editorScroll, targetPage
        const total = this.getFinalThumbnailPageCount();
        this._totalPages = total;
        this._activePage = Math.max(1, Math.min(Number(this._activePage || 1), total));
        const existingTotal = Number(container?.dataset?.finalThumbTotal || 0);
        if (!options.force && existingTotal === total && container.querySelectorAll('.v3-thumbnail.is-final-page').length === total) {
            this._updateFinalNavigationUi();
            return;
        }

        let thumbHtml = '';
        for (let i = 1; i <= total; i++) {
            thumbHtml += `
                <button type="button" class="v3-thumbnail is-final-page ${i === this._activePage ? 'active' : ''}" onclick="window.signViewer.setActivePage(${i})" aria-label="最終版 ${i}ページ">
                    <span class="v3-thumb-num">${i}</span>
                </button>`;
        }
        container.innerHTML = thumbHtml;
        container.dataset.finalThumbTotal = String(total);
        this._updateFinalNavigationUi();
    },

    renderPdfThumbnails(container) {
        let thumbHtml = '';
        const total = (this._viewMode === 'final' || this._viewMode === 'edit')
            ? this.getFinalThumbnailPageCount()
            : Math.max(1, Number(this._totalPages || 1));
        for (let i = 1; i <= total; i++) {
            thumbHtml += `
                <div class="v3-thumbnail ${i === this._activePage ? 'active' : ''}" onclick="window.signViewer.setActivePage(${i})">
                    <div class="v3-thumb-num">${i}</div>
                    <div class="v3-thumb-placeholder"><i class="fa-solid fa-file-pdf"></i></div>
                </div>`;
        }
        container.innerHTML = thumbHtml;
    },

    renderImageThumbnails(container) {
        const pageImages = this._contract?.page_images || this._contract?.pageImages || [];
        let thumbHtml = '';
        const total = pageImages.length || Math.max(1, Number(this._totalPages || 1));
        
        for (let i = 1; i <= total; i++) {
            const src = pageImages[i - 1];
            thumbHtml += `
                <div class="v3-thumbnail ${i === this._activePage ? 'active' : ''}" onclick="window.signViewer.setActivePage(${i})">
                    <div class="v3-thumb-num">${i}</div>
                    ${src ? `<img src="${src}" style="width:100%; height:auto; display:block; border-radius:4px;" loading="lazy">` : `<div class="v3-thumb-placeholder">P${i}</div>`}
                </div>`;
        }
        container.innerHTML = thumbHtml;
    }
};

window.signViewer = SignViewer;
