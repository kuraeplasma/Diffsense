/**
 * SignViewer - Signature Detail Viewer Logic (provider embed + pdf.js)
 */

import { dbService } from './db-service.js?v=20260507_prod_api_analysis';
import { Notify } from './notify.js';
import { buildSignDocumentPreviewHtml } from './sign-document-preview.js?v=20260402_signpreview_plain1';
import { isDocxFileName, renderDocxPreviewPages, wrapPreviewPageShell } from './sign-docx-preview.js?v=20260511_docx_dom_fix_v5';
import { getIdToken } from './auth.js?v=20260510_auth_ready_fix';
import { resolveBackendAssetUrl, toApiUrl } from './api-base-safe.js?v=20260329_api_base_safe1';

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
                // 1. If we have a PDF URL (converted or original) or Page Images, use the PDF-style renderer
                // 2. Otherwise if it's a runtime DOCX blob, use docx-preview.js
                // 3. Otherwise if it's a persisted DOCX URL, use docx-preview.js
                // 4. Fallback to text
                const hasPageImages = Boolean(previewContract?.page_images?.length || previewContract?.pageImages?.length);
                const canUsePdfRenderer = isActuallyPdf || (persistedDocx && hasPageImages);

                // Set explicit render mode
                this._renderMode = (persistedDocx && hasPageImages) ? 'image' : 'pdf';
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
                    const token = await getIdToken();
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
                        <div id="pdf-pages-container" class="document-page" style="display:none; flex-shrink:0; margin:0 auto;"></div>
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
            pagesContainer.style.display = 'block';
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
        const scrollEl = document.getElementById('pdf-viewer-scroll');
        if (!scrollEl) return;

        let bar = document.getElementById('v3-final-action-bar');
        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'v3-final-action-bar';
            bar.style.cssText = [
                'width:900px',
                'max-width:calc(100% - 32px)',
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

            const firstLayer = document.getElementById('pdf-pages-container')
                || document.getElementById('sign-viewer-docx-pages')
                || document.getElementById('v3-revised-layer')
                || document.getElementById('v3-edit-layer');
            scrollEl.insertBefore(bar, firstLayer || scrollEl.firstChild);
        }

        const finalText = this._getFinalDocumentText();
        const aiChangeCount = this._getSortedAiChanges().length;
        const appliedCount = this._getAppliedChangeIndexesFromFinal(finalText).size;
        const isUnsaved = this._editedContent !== undefined && this._editedContent !== this._lastSavedContent;
        const canUndo = this._canUndoEdit();
        const canRedo = this._canRedoEdit();

        bar.innerHTML = `
            <span class="v3-status-badge" style="display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:700;padding:3px 10px;border-radius:20px;${isUnsaved ? 'background:#fef3c7;color:#d97706;' : 'background:#dcfce7;color:#16a34a;'}">
                ${isUnsaved ? '未保存' : '保存済み'}
            </span>
            ${aiChangeCount > 0 ? `<span style="font-size:11px;background:${appliedCount > 0 ? '#dcfce7' : '#f8fafc'};color:${appliedCount > 0 ? '#166534' : '#64748b'};padding:3px 10px;border-radius:20px;font-weight:700;border:1px solid ${appliedCount > 0 ? '#bbf7d0' : '#e2e8f0'};">修正案 ${appliedCount}/${aiChangeCount}件 反映済み</span>` : ''}
            <div style="margin-left:auto;display:flex;gap:8px;align-items:center;">
                <button onclick="window.signViewer._previewRenderedFinal()" style="display:inline-flex;align-items:center;gap:6px;background:#f8fafc;color:#0b2d62;border:1px solid #bfdbfe;padding:6px 14px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;">
                    <i class="fa-solid fa-eye"></i> プレビュー
                </button>
                <button onclick="window.signViewer._saveFinalTextOnly()" style="display:inline-flex;align-items:center;gap:6px;background:#0b2d62;color:#fff;border:none;padding:6px 18px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;">
                    <i class="fa-solid fa-floppy-disk"></i> 保存する
                </button>
            </div>
        `;
        bar.style.display = 'flex';
    },

    _saveFinalTextOnly() {
        const finalContent = String(this._editedContent !== undefined ? this._editedContent : this._getFinalDocumentText());
        this._editedContent = finalContent;
        this._lastSavedContent = finalContent;
        this._lastPreviewContent = finalContent;
        if (this._contract) {
            this._contract.final_content = finalContent;
            dbService.updateContract(this._contract.id, { final_content: finalContent });
        }
        this._renderFinalActionBar();
        Notify.success('保存しました');
    },

    _previewRenderedFinal() {
        const pdfLayer = document.getElementById('pdf-pages-container');
        const docxLayer = document.getElementById('sign-viewer-docx-pages');
        const activeLayer = docxLayer && docxLayer.style.display !== 'none'
            ? docxLayer
            : (pdfLayer && pdfLayer.style.display !== 'none' ? pdfLayer : null);

        if (!activeLayer) {
            Notify.info('プレビューできる最終版がまだ表示されていません');
            return;
        }

        document.getElementById('final-rendered-preview-overlay')?.remove();
        const overlay = document.createElement('div');
        overlay.id = 'final-rendered-preview-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.72);z-index:99999;display:flex;flex-direction:column;';

        const shell = document.createElement('div');
        shell.style.cssText = 'width:100%;height:100%;display:flex;flex-direction:column;background:#f1f5f9;';
        shell.innerHTML = `
            <div style="height:54px;background:#0b2d62;color:#fff;display:flex;align-items:center;justify-content:space-between;padding:0 22px;box-sizing:border-box;flex-shrink:0;">
                <span style="font-size:14px;font-weight:800;">最終版プレビュー</span>
                <button onclick="document.getElementById('final-rendered-preview-overlay')?.remove()" style="width:32px;height:32px;border-radius:8px;border:none;background:rgba(255,255,255,0.14);color:#fff;cursor:pointer;font-size:16px;line-height:1;">×</button>
            </div>
            <div id="final-rendered-preview-body" style="flex:1;overflow:auto;padding:28px 0;box-sizing:border-box;display:flex;justify-content:center;"></div>
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
                Notify.warning('プレビュー画像の生成に失敗しました');
            }
            return;
        }

        const clone = activeLayer.cloneNode(true);
        clone.removeAttribute('id');
        clone.style.display = 'block';
        clone.style.transform = 'none';
        clone.style.zoom = '1';
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

            effectiveContainerWidth = Math.max(effectiveContainerWidth, 400);

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

                // scale=1のnative viewport幅でfit-to-widthのscaleを計算
                const nativeViewport = page.getViewport({ scale: 1.0 });
                const fitScale = Math.min(effectiveContainerWidth / nativeViewport.width, 2.5);
                const viewport = page.getViewport({ scale: fitScale });

                console.log(`[PDF.js Page ${pageNum}]`, {
                    nativeWidth: nativeViewport.width,
                    containerWidth: effectiveContainerWidth,
                    fitScale: fitScale.toFixed(3),
                    viewportWidth: Math.round(viewport.width),
                    viewportHeight: Math.round(viewport.height),
                    canvasWidth: Math.floor(viewport.width * pixelRatio),
                    pixelRatio
                });

                const pageShell = document.createElement('div');
                pageShell.className = 'pdf-page-shell';
                pageShell.setAttribute('data-page', String(pageNum));
                pageShell.style.cssText = [
                    'position:relative',
                    'display:block',
                    `width:${viewport.width}px`,
                    `height:${viewport.height}px`,
                    'background:#fff',
                    'box-shadow:0 8px 32px rgba(0,0,0,0.15)',
                    'margin:0 auto 32px auto',
                    'overflow:hidden',
                    'flex-shrink:0'
                ].join(';');

                const canvas = document.createElement('canvas');
                canvas.className = 'pdf-page-canvas';
                // canvas内部解像度 = viewport × pixelRatio（高解像度ディスプレイ対応）
                canvas.width = Math.floor(viewport.width * pixelRatio);
                canvas.height = Math.floor(viewport.height * pixelRatio);
                // CSS表示サイズはviewportの論理px（CSSによる縮小を禁止）
                canvas.style.cssText = `display:block;width:${viewport.width}px;height:${viewport.height}px;`;

                const context = canvas.getContext('2d', { alpha: false });
                // pixelRatioに合わせてコンテキストをスケール
                context.scale(pixelRatio, pixelRatio);

                pageShell.appendChild(canvas);
                await page.render({ canvasContext: context, viewport }).promise;

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
            const zoomTxt = document.getElementById('zoom-percent');
            if (zoomTxt) zoomTxt.textContent = `${Math.round(zoom * 100)}%`;

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

        // Calculate responsive width based on zoom scale
        const scrollElFit = document.getElementById('pdf-viewer-scroll');
        const containerWidth = scrollElFit ? scrollElFit.clientWidth - 48 : 794;
        const currentScale = this._scale || 1.0;
        const displayWidth = Math.max(400, Math.min(containerWidth * currentScale, 1600));

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
                'margin:0 auto 32px auto',
                'flex-shrink:0',
                'min-height:200px'
            ].join(';');

            const img = document.createElement('img');
            img.src = src;
            img.className = 'image-content';
            img.style.cssText = 'display:block; width:100%; height:auto;';
            img.loading = 'lazy';
            img.onload = () => {
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
        const nextPage = Math.max(1, Math.min(Number(page) || 1, this._totalPages || 1));
        
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
            const scrollEl = document.getElementById('pdf-viewer-scroll');
            if (scrollEl) {
                const selector = this._renderMode === 'image' 
                    ? `#pdf-pages-container .image-fallback-page[data-page="${nextPage}"]`
                    : `#pdf-pages-container div[data-page="${nextPage}"]`;
                
                let targetPage = document.querySelector(selector);
                
                // Fallback for DOCX layer if active
                if (!targetPage && document.getElementById('sign-viewer-docx-pages')?.style.display !== 'none') {
                    targetPage = document.querySelector(`#sign-viewer-docx-pages [data-page="${nextPage}"]`);
                }

                if (targetPage) {
                    targetPage.scrollIntoView({ behavior: 'smooth', block: 'start' });
                } else if (this._renderMode === 'pdf') {
                    this.renderPdfMode();
                } else if (this._renderMode === 'image') {
                    this.renderImageMode();
                }
            }
            
            this.renderDashboardUI();
        } else {
            this.updateVisiblePages();
        }
        
        this.renderPageSwitcher();
    },

    updateVisiblePages() {
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
        const ox = this._offsetX || 0;
        const oy = this._offsetY || 0;
        const tf = `translate(${ox}px, ${oy}px)`;

        const apply = (id) => {
            const el = document.getElementById(id);
            if (!el || el.style.display === 'none') return;
            el.style.zoom = id === 'pdf-pages-container' && this._currentPdfUrl ? 1 : z;
            el.style.transform = tf;
            el.style.transformOrigin = 'center top';
        };

        apply('pdf-pages-container');
        apply('sign-viewer-docx-pages');
        apply('v3-revised-content');
        
        // Editor pages zoom
        const editorPages = document.querySelectorAll('.v3-editor-page');
        editorPages.forEach(p => { p.style.zoom = z; });

        if (typeof this.renderDashboardUI === 'function') this.renderDashboardUI();
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
        this._viewMode = mode;
        const container = this._viewerContainer;
        if (!container) return;

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
                this.renderModifiedDocument(container);
            }
        } else if (mode === 'edit') {
            if (editLayer) {
                editLayer.style.display = 'block';
                this.renderHandEditMode(container);
            }
        } else if (mode === 'final') {
            if (this._finalGeneratedPdfUrl) {
                // 保存済みPDFを再表示
                await this.renderPdf(this._finalGeneratedPdfUrl, container);
            } else {
                // 未保存→編集モードへ（_viewModeはfinalのまま）
                if (editLayer) {
                    editLayer.style.display = 'block';
                    this.renderHandEditMode(container);
                }
            }
        } else {
            // 蜴滓悽 PDF陦ｨ遉ｺ
            if (pdfLayer) {
                pdfLayer.style.display = 'block';
                await this.renderOriginalForContract(this._app, this._contract, this._currentRequest?.contract_id || this._currentRequest?.contractId);
            }
        }
        this.renderDashboardUI();
    },

    async renderFinalOriginalLayout(container) {
        const previousMode = this._viewMode;
        this._viewMode = 'original';
        await this.renderOriginalForContract(
            this._app,
            this._contract,
            this._currentRequest?.contract_id || this._currentRequest?.contractId
        );
        this._viewMode = previousMode || 'final';
        this._setOriginalViewerBottomSpace(true);
        this.renderDashboardUI();
        this._renderFinalActionBar();
        await this._renderFinalAppliedOverlays();
    },

    async _renderFinalAppliedOverlays() {
        document.querySelectorAll('.v3-final-applied-overlay').forEach(node => node.remove());
        const changes = this._sortedChanges || this._getSortedAiChanges();
        const applied = this._getAppliedIndexesForFinalView(changes);
        if (!changes.length || applied.size === 0) return;

        for (const index of applied) {
            const change = changes[index];
            if (!change) continue;
            const text = this._getFinalOverlayTextForChange(change, index);
            if (!text) continue;
            const target = await this._findFinalOverlayTarget(change, index);
            this._addFinalAppliedOverlay(target, change, index, text);
        }
    },

    _getAppliedIndexesForFinalView(changes = this._getSortedAiChanges()) {
        const stored = this._getStoredAppliedChangeIndexes();
        if (stored.size > 0) return stored;

        const detected = this._getAppliedChangeIndexesFromFinal(this._getFinalDocumentText());
        if (detected.size > 0) {
            this._appliedChanges = new Set(detected);
            return detected;
        }

        const finalText = String(this._contract?.final_content || this._editedContent || '');
        const originalText = this._getOriginalDocumentText();
        if (!finalText.trim() || finalText.trim() === originalText.trim()) return stored;

        const recovered = new Set();
        changes.forEach((change, index) => {
            const appliedText = this._getDefaultAppliedTextForChange(change);
            if (appliedText && finalText.includes(appliedText)) recovered.add(index);
        });
        if (recovered.size > 0) this._appliedChanges = new Set(recovered);
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

    async _findFinalOverlayTarget(change, index) {
        const fallback = {
            page: Math.max(1, Math.min(Number(index) + 1, Number(this._totalPages || 1))),
            left: 96,
            top: 160 + (index % 4) * 92
        };
        const article = this._findArticleForChange(change);
        const articlePattern = String(article || '').match(/第\s*[0-9０-９零〇一二三四五六七八九十百千]+\s*条/)?.[0] || '';
        if (!articlePattern || !this._pdfDoc) return fallback;

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
        const fontSize = Math.max(10, Math.min(16, Number(target?.fontSize || 12)));
        overlay.style.cssText = [
            'position:absolute',
            `left:${Math.round(Number(target?.left || 96))}px`,
            `top:${Math.round(Number(target?.top || 160))}px`,
            'max-width:460px',
            'min-width:320px',
            'z-index:30',
            'font-family:"Noto Serif JP","Yu Mincho","MS Mincho",serif',
            `font-size:${fontSize}px`,
            'line-height:1.75',
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
                 style="outline:none;cursor:text;white-space:pre-wrap;word-break:normal;overflow-wrap:anywhere;border:1px solid rgba(34,197,94,0.55);border-radius:2px;padding:1px 3px;background:rgba(187,247,208,0.55);box-decoration-break:clone;-webkit-box-decoration-break:clone;">${this.escapeHtml(text)}</div>
        `;
        shell.appendChild(overlay);
        if (isJustApplied) {
            setTimeout(() => overlay.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' }), 120);
        }
    },

    _onFinalOverlayInput(index, element) {
        const text = String(element?.innerText || '').trim();
        this._pendingFinalOverlayEdits = this._pendingFinalOverlayEdits || {};
        this._pendingFinalOverlayEdits[String(index)] = text;
        element.style.borderColor = '#86efac';
        element.style.background = '#ffffff';
    },

    _saveFinalOverlayEdit(index, element) {
        const changes = this._sortedChanges || this._getSortedAiChanges();
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
        const changes = this._sortedChanges || this._getSortedAiChanges();
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

        const articleLabel = String(item.article || item.articleNumber || item.clause || '').trim();
        const heading = String(item.title || item.header || '').trim();
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

    _getChangeOldText(change) {
        return String(change?.old || change?.original || change?.originalText || change?.before || '').trim();
    },

    _getChangeNewText(change) {
        return String(change?.new || change?.modified || change?.modifiedText || change?.suggestion || change?.proposal || change?.after || '').trim();
    },

    _normalizeChangeSectionLabel(value) {
        const label = String(value || '').trim();
        if (!label) return '';
        const normalized = label.replace(/\s+/g, '');
        const genericLabels = new Set(['本文', '条文', '契約本文', '契約書本文', '修正案', '変更箇所', '追加条項', '追記条項']);
        if (/^(追加|追記)\s*(条項|項目)?\s*\d*$/i.test(normalized)) return '';
        if (genericLabels.has(normalized)) return '';
        return label;
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
        const explicit = this._normalizeChangeSectionLabel(
            change?.section
            || change?.article
            || change?.articleNumber
            || change?.clause
            || change?.title
        );
        if (/第\s*[0-9０-９零〇一二三四五六七八九十百千]+\s*条/.test(explicit)) {
            return explicit;
        }

        const oldText = this._getChangeOldText(change).replace(/\s+/g, '');
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
        const bestArticle = this._findBestArticleForChange(change);
        if (bestArticle) {
            return [
                bestArticle.articleNumber || bestArticle.article || '',
                bestArticle.title || bestArticle.header || ''
            ].filter(Boolean).join(' ').trim();
        }
        return explicit;
    },

    _getChangeDisplaySection(change, index) {
        const article = this._findArticleForChange(change);
        if (article) return article;
        if (!this._getChangeOldText(change)) return `追加条項 ${index + 1}`;
        return `変更箇所 ${index + 1}`;
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

        const synthesized = this._synthesizeUsableLegalClause(change, raw);
        if (synthesized) return synthesized;

        // If the AI already produced proper clause text, use it directly.
        if (/[。」）]\s*$/.test(raw) && !this._looksLikeLegalCommentary(raw)) return raw;

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
        if (/不足|不明確|曖昧|具体的|指摘|リスク|必要|提案|べき|されている|されていない|高い|低い/.test(value)) return true;
        if (/第\s*[0-9０-９一二三四五六七八九十百千]+\s*条.*(が|において|では)/.test(value)) return true;
        if (!/(ものとする|しなければならない|負う|負わない|できる|できない|定める|講じる|通知する|協議する)/.test(value)) return true;
        return false;
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

        if (!this._looksLikeLegalCommentary(rawText)) return '';

        if (/個人情報|共同利用|漏洩|漏えい|漏えい等|安全管理|個人データ/.test(source)) {
            if (/損害賠償|賠償|上限|5,000|5000|高額|責任/.test(source)) {
                return '個人情報の漏えい、滅失、毀損その他本契約に違反して損害が発生した場合、当該損害について責めに帰すべき事由を有する当事者は、通常かつ直接の損害に限り賠償責任を負うものとする。ただし、故意又は重過失、法令違反又は秘密保持義務違反により生じた損害については、当該責任制限を適用しないものとする。';
            }
            if (/管理責任|管理者|責任者|甲に集中|委託|共同/.test(source)) {
                return '甲及び乙は、共同利用する個人情報について、それぞれの取扱範囲及び管理責任を明確にし、個人情報保護法その他関係法令に従い、漏えい、滅失又は毀損を防止するために必要かつ適切な安全管理措置を講じるものとする。';
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
        const extractArticleNum = (change) => {
            const source = this._findArticleForChange(change) || String(change?.section || change?.article || '');
            const match = source.match(/第\s*([0-9０-９]+)\s*条/);
            if (!match) return 9999;
            return parseInt(match[1].replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)), 10);
        };
        return [...aiChangesRaw].sort((a, b) => extractArticleNum(a) - extractArticleNum(b));
    },

    _getOriginalDocumentText() {
        return this._getOriginalFallbackText(this._contract || {});
    },

    _getOriginalFallbackText(contract = this._contract || {}) {
        return this._getRawText(
            contract?.original_content
            || contract?.content
            || contract?.extracted_text
            || contract?.pdf_raw_text
            || contract?.text
            || ''
        );
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
            contract.original_page_count,
            contract.page_count,
            contract.total_pages,
            request.original_page_count,
            request.page_count,
            request.total_pages
        ].map(Number).find(value => Number.isFinite(value) && value > 0);
        if (directCount) return Math.max(1, Math.round(directCount));

        const pdfPageCount = document.querySelectorAll('#pdf-pages-container > div[data-page]').length;
        if (pdfPageCount > 0) return pdfPageCount;

        const docxPages = new Set();
        document.querySelectorAll('#sign-viewer-docx-pages [data-page]').forEach(node => {
            const page = Number(node.dataset.page);
            if (Number.isFinite(page) && page > 0) docxPages.add(page);
        });
        return docxPages.size > 0 ? docxPages.size : null;
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
        if (this._getOriginalPageCount()) return;
        const pdfUrl = this._getOriginalPdfUrlForPageCount();
        if (!pdfUrl) return;

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
        } catch (error) {
            console.warn('[SignViewer] Could not read original page count:', error);
        }
    },

    _getFinalDocumentText() {
        const contract = this._contract || {};
        if (this._editedContent !== undefined) return this._normalizeFinalLayoutText(this._editedContent || '');

        const savedFinal = this._getRawText(contract.final_content || '');
        if (savedFinal.trim()) return this._normalizeFinalLayoutText(this._repairAppliedAdditionClauseQuality(savedFinal));

        const aiFinal = this._getRawText(contract.ai_final_document || '');
        if (aiFinal.trim()) return this._normalizeFinalLayoutText(aiFinal);

        return this._normalizeFinalLayoutText(this._getOriginalDocumentText());
    },

    _normalizeFinalLayoutText(text) {
        const isHeading = (t) => {
            const s = String(t || '').trim();
            return /^第\s*[一二三四五六七八九十百千万零〇\d０-９]+\s*[条章節]/.test(s)
                || /^（[^）]{1,20}）$/.test(s)
                || /^【[^】]{1,20}】$/.test(s)
                || /^[一二三四五六七八九十]、/.test(s)
                || ['記','以上','附則','別紙'].includes(s);
        };

        // Pre-split: fix PDF/extraction artifacts before line processing
        let normalized = String(text || '')
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n')
            // Split 第X条 when directly concatenated with body
            .replace(/(第\s*[0-9０-９零〇一二三四五六七八九十百千]+\s*条)([^\n\s（(])/g, '$1\n$2')
            // Split document title from preamble
            .replace(/([^。\n]{2,20}(?:契約書|規約|覚書|協定書|同意書|合意書))([貸主借主甲乙委託者受託者売主買主発注者請負者])/g, '$1\n$2')
            // Split merged address/property fields
            .replace(/(所在地?|種類|構造|床面積|地番|建物名称|部屋番号)(?=[^\n：:\s])/g, '\n$1');

        const lines = normalized.split('\n').map(l => l.trimEnd());
        const result = [];

        for (const rawLine of lines) {
            const line = rawLine.trim(); // trimmed only for detection logic, NOT for output
            if (!line) {
                if (result.length > 0 && result[result.length - 1] !== '') result.push('');
                continue;
            }
            // Add blank line before headings for visual separation
            if (result.length > 0 && isHeading(line) && result[result.length - 1] !== '') {
                result.push('');
            }
            // Push rawLine to preserve leading indent (　全角スペース, paragraph numbers, etc.)
            result.push(rawLine);
        }

        return result.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    },

    _repairAppliedAdditionClauseQuality(finalText) {
        const changes = this._sortedChanges || this._getSortedAiChanges();
        const applied = this._getStoredAppliedChangeIndexes();
        let nextText = String(finalText || '');
        let changed = false;

        changes.forEach((change, index) => {
            if (!applied.has(index) || !this._isAdditionChange(change)) return;
            const rawText = this._getChangeNewText(change).trim();
            const legalText = this._buildLegalInsertionText(change).trim();
            if (!rawText || !legalText || rawText === legalText) return;
            if (!nextText.includes(rawText) || nextText.includes(legalText)) return;
            nextText = nextText.split(rawText).join('').replace(/\n{3,}/g, '\n\n').trim();
            nextText = this._insertAdditionalClauseIntoArticle(nextText, change, legalText);
            changed = true;
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

    _applyChangeToText(text, change) {
        const oldText = this._getChangeOldText(change);
        const newText = this._buildLegalInsertionText(change);
        let nextText = String(text || '');

        if (!newText) return nextText;

        if (oldText && newText && nextText.includes(oldText)) {
            return nextText.split(oldText).join(newText);
        }

        if (oldText) {
            const flexiblePattern = oldText
                .split(/\s+/)
                .filter(Boolean)
                .map(part => this._escapeRegex(part))
                .join('\\s+');
            if (flexiblePattern) {
                const flexibleRegex = new RegExp(flexiblePattern);
                if (flexibleRegex.test(nextText)) {
                    return nextText.replace(flexibleRegex, newText);
                }
            }
        }

        if (!nextText.includes(newText)) {
            if (this._isAdditionChange(change)) {
                const inserted = this._insertAdditionalClauseIntoArticle(nextText, change, newText);
                if (inserted !== nextText) return inserted;
            }
            for (const anchor of this._getChangeAnchorTexts(change)) {
                const anchorRegex = new RegExp(`(^|\
)([^\
]*${this._escapeRegex(anchor)}[^\
]*)(?=\
|$)`);
                if (anchorRegex.test(nextText)) {
                    return nextText.replace(anchorRegex, (_match, prefix, line) => `${prefix}${line}
${newText}`);
                }
            }
            for (const anchor of this._getChangeAnchorTexts(change)) {
                const articlePattern = this._getArticleAnchorPattern(anchor);
                if (!articlePattern) continue;
                const articleRegex = new RegExp(`(^|\
)([^\
]*${articlePattern}[^\
]*)(?=\
|$)`);
                if (articleRegex.test(nextText)) {
                    return nextText.replace(articleRegex, (_match, prefix, line) => `${prefix}${line}
${newText}`);
                }
            }
            const section = String(change?.section || change?.article || change?.title || '').trim();
            const displaySection = this._normalizeChangeSectionLabel(section);
            const addition = [displaySection ? `【${displaySection}】` : '', newText].filter(Boolean).join('\n');
            return `${nextText.trim()}

${addition}`.trim();
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
        const numberedCount = nonEmpty.filter(l =>
            /^[２-９][　\s]/.test(l) ||   // ２　 ３　 …
            /^（[二三四五六七八九十\d２-９]+）/.test(l) || // （二）（三）
            /^[2-9][.．]\s/.test(l)
        ).length;
        const usesNumberedParagraphs = numberedCount >= 2;

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
            const nums = nonEmpty
                .map(l => { const m = l.match(/^([２-９])[　\s]/); return m ? m[1].charCodeAt(0) - 0xFF10 : null; })
                .filter(n => n !== null);
            if (nums.length) nextParagraphNumber = Math.max(...nums) + 1;
        }

        return { usesIdeographicIndent, indentStr, usesNumberedParagraphs, usesBlankLineSeparation, nextParagraphNumber };
    },

    // Apply document style rules to text being inserted
    _formatInsertionText(addition, style) {
        let lines = String(addition || '').split('\n');
        const indent = style.indentStr || '　';

        if (style.usesNumberedParagraphs && style.nextParagraphNumber && style.nextParagraphNumber <= 9) {
            const num = String.fromCharCode(0xFF10 + style.nextParagraphNumber); // ２,３…
            lines = lines.map((l, i) => {
                if (i === 0 && l.trim()) return `${num}　${l.trimStart()}`;
                if (i > 0 && l.trim()) return `${indent}${l.trimStart()}`;
                return l;
            });
        } else if (style.usesIdeographicIndent) {
            lines = lines.map(l => l.trim() ? `${indent}${l.trimStart()}` : l);
        }

        return lines.join('\n');
    },

    _insertAdditionalClauseIntoArticle(text, change, additionText) {
        const targetArticle = this._findBestArticleForChange(change);
        const nextText = String(text || '');
        const addition = String(additionText || '').trim();
        if (!addition || nextText.includes(addition)) return nextText;

        // Extract target article context for accurate local style detection
        const articleLabel = String(targetArticle?.articleNumber || targetArticle?.article || '').trim();
        const articlePattern = articleLabel ? this._getArticleAnchorPattern(articleLabel) : '';
        let articleContext = '';
        if (articlePattern) {
            const ctxRegex = new RegExp(`(^|\\n)([^\\n]*${articlePattern}[^\\n]*(?:\\n(?!\\s*第\\s*[0-9０-９零〇一二三四五六七八九十百千]+\\s*条)[^\\n]*)*)`);
            const ctxMatch = ctxRegex.exec(nextText);
            if (ctxMatch) articleContext = ctxMatch[2];
        }

        // Auto-detect document formatting rules — use article context for precise indent
        const style = this._detectDocumentStyle(nextText, articleContext || nextText.slice(0, 800));
        const formattedAddition = this._formatInsertionText(addition, style);

        const sep = '\n\n'; // always blank-line before & after
        const insertionBlock = `${sep}${formattedAddition}\n`;
        if (articlePattern) {
            const articleRegex = new RegExp(`(^|\\n)([^\\n]*${articlePattern}[^\\n]*(?:\\n(?!\\s*第\\s*[0-9０-９零〇一二三四五六七八九十百千]+\\s*条)[^\\n]*)*)`);
            const match = articleRegex.exec(nextText);
            if (match) {
                const block = match[2];
                return `${nextText.slice(0, match.index)}${match[1]}${block}${insertionBlock}${nextText.slice(match.index + match[0].length)}`;
            }
        }

        const signatureMatch = nextText.match(/\n\s*(以上の通り|平成|令和|貸主|借主|甲\s|乙\s)/);
        if (signatureMatch && signatureMatch.index > 0) {
            return `${nextText.slice(0, signatureMatch.index).trimEnd()}\n\n${formattedAddition}\n${nextText.slice(signatureMatch.index).trimStart()}`;
        }
        return `${nextText.trimEnd()}\n\n${formattedAddition}\n`.trim();
    },

    _collectEditorContent() {
        const richBodies = Array.from(document.querySelectorAll('#v3-editor-scroll .v3-rich-editor-body'));
        if (richBodies.length > 0) {
            return richBodies
                .map(body => body.innerText.replace(/\u00a0/g, ' ').replace(/\n{3,}/g, '\n\n').trimEnd())
                .join('\n')
                .replace(/\n{4,}/g, '\n\n\n')
                .trimEnd();
        }
        const blocks = Array.from(document.querySelectorAll('#v3-editor-scroll .v3-editor-block'));
        if (blocks.length > 0) return blocks.map(block => block.innerText).join('\n');
        return this._getFinalDocumentText();
    },

    _collectEditorHtml() {
        const richBodies = Array.from(document.querySelectorAll('#v3-editor-scroll .v3-rich-editor-body'));
        return richBodies.length
            ? this._sanitizeFinalContentHtml(richBodies.map(body => body.innerHTML).join('<div><br></div>'))
            : '';
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
        return template.innerHTML;
    },

    _plainTextToEditorHtml(text, markApplied = false) {
        const finalText = String(text || '');
        const changes = this._sortedChanges || this._getSortedAiChanges();
        const applied = markApplied ? this._getAppliedChangeIndexesFromFinal(finalText) : new Set();
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
        // Derive pagination params from actual CSS geometry so any font size works
        // Page: 794px, padding: 90px each side → content width = 614px
        // Page: 1123px, padding: 80px each side → content height = 963px
        const fontSize = this._getFinalEditorFontSize(); // default 14
        const lineHeightPx = fontSize * 1.7;
        const charsPerLine = Math.max(20, Math.floor(614 / fontSize));
        // Max lines that physically fit, minus 6 for heading margins + safety buffer
        const linesPerPage = Math.max(10, Math.floor(963 / lineHeightPx) - 6);
        return { charsPerLine, linesPerPage };
    },

    _renderFinalEditorSurfaceHtml(text, originalText, targetPageCount) {
        const { charsPerLine, linesPerPage } = this._calcPageLayout();
        const pages = this._paginateDocumentText(text, charsPerLine, linesPerPage, targetPageCount);
        this._totalPages = pages.length;
        return pages.map((pageLines, pageIndex) => `
            <div class="v3-editor-page" data-page="${pageIndex + 1}">
                <div class="v3-rich-editor-body"
                     contenteditable="true"
                     spellcheck="true"
                     oninput="window.signViewer._onRichEditorInput(this)"
                     onblur="window.signViewer._onRichEditorBlur(this)">${this._plainTextToEditorHtml(pageLines.join('\n'), true)}</div>
            </div>
        `).join('');
    },

    _renderFinalPreviewPagesHtml(text, html = this._getFinalDocumentHtml()) {
        return this._renderDocumentPagesHtml(text, {
            editable: false,
            showRevisionMarks: false,
            markChangedLines: false,
            showPageNumbers: false,
            targetPageCount: null
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

    _setFinalEditorFontSize(value) {
        const size = Math.min(32, Math.max(12, Number(value) || 14));
        this._editorFontSize = size;
        if (this._contract) {
            this._contract.final_font_size = size;
            dbService.updateContract(this._contract.id, { final_font_size: size });
        }
        document.querySelectorAll('.v3-editor-page').forEach(page => { page.style.fontSize = `${size}px`; });
    },

    _revertChangeInText(text, change) {
        let nextText = String(text || '');
        if (this._isAdditionChange(change)) {
            const insertedText = this._buildLegalInsertionText(change);
            if (!insertedText) return nextText;
            if (nextText.includes(insertedText)) {
                nextText = nextText.split(insertedText).join('');
                return nextText.replace(/\n{3,}/g, '\n\n');
            }
            const flexiblePattern = insertedText.split(/\s+/).filter(Boolean).map(part => this._escapeRegex(part)).join('\\s+');
            if (flexiblePattern) return nextText.replace(new RegExp(flexiblePattern), '').replace(/\n{3,}/g, '\n\n');
            return nextText;
        }
        const oldText = this._getChangeOldText(change);
        const newText = this._buildLegalInsertionText(change);
        if (!oldText || !newText) return nextText;
        if (nextText.includes(newText)) return nextText.split(newText).join(oldText);
        const flexiblePattern = newText.split(/\s+/).filter(Boolean).map(part => this._escapeRegex(part)).join('\\s+');
        if (flexiblePattern) return nextText.replace(new RegExp(flexiblePattern), oldText);
        return nextText;
    },

    _revertChange(idx) {
        const c = (this._sortedChanges || [])[idx];
        if (!c) return;
        const baseText = this._ensureEditedContent();
        const editedOverlayText = this._getFinalOverlayTextForChange(c, idx);
        let nextText = this._revertChangeInText(baseText, c);
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

    _revertAllChanges() {
        const changes = this._sortedChanges || this._getSortedAiChanges();
        if (!changes.length) return;
        let nextText = this._ensureEditedContent();
        const before = nextText;
        changes.forEach(c => { nextText = this._revertChangeInText(nextText, c); });
        if (nextText === before) {
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
        }
        this._setStoredAppliedChangeIndexes(new Set(), {
            final_content: nextText,
            final_content_html: '',
            final_font_size: this._getFinalEditorFontSize()
        });
        Notify.success('反映済みの修正案を元に戻しました。');
        this.renderModifiedDocument(this._viewerContainer);
    },

    _paginateDocumentText(text, charsPerLine = 60, linesPerPage = 46, targetPageCount = null) {
        const lines = String(text || '').split('\n');
        const targetPages = Number.isFinite(Number(targetPageCount)) && Number(targetPageCount) > 0
            ? Math.max(1, Math.round(Number(targetPageCount)))
            : null;
        if (targetPages) {
            const weightedLines = lines.map(line => {
                const plainLine = String(line || '').replace(/\x00\/?REV\x00/g, '');
                return {
                    line,
                    weight: Math.max(1, Math.ceil(plainLine.length / charsPerLine))
                };
            });
            const totalWeight = Math.max(1, weightedLines.reduce((sum, item) => sum + item.weight, 0));
            const targetWeightPerPage = Math.max(1, Math.ceil(totalWeight / targetPages));
            const pages = [];
            let currentPage = [];
            let currentWeight = 0;

            weightedLines.forEach((item) => {
                if (
                    pages.length < targetPages - 1
                    && currentPage.length > 0
                    && currentWeight + item.weight > targetWeightPerPage
                ) {
                    pages.push(currentPage);
                    currentPage = [];
                    currentWeight = 0;
                }
                currentPage.push(item.line);
                currentWeight += item.weight;
            });

            pages.push(currentPage.length > 0 ? currentPage : [' ']);
            while (pages.length < targetPages) pages.push([' ']);
            while (pages.length > targetPages) {
                const overflow = pages.pop();
                pages[pages.length - 1].push('', ...overflow);
            }
            return pages;
        }

        // Helpers for heading detection — covers common Japanese legal document formats
        const _isArticleH = (s) => {
            const t = String(s || '').trim();
            return /^第\s*[一二三四五六七八九十百千万零〇\d０-９]+\s*条/.test(t)   // 第X条
                || /^第\s*[一二三四五六七八九十百千万零〇\d０-９]+\s*章/.test(t)   // 第X章
                || /^第\s*[一二三四五六七八九十百千万零〇\d０-９]+\s*節/.test(t);  // 第X節
        };
        const _isSubH = (s) => {
            const t = String(s || '').trim();
            return /^（[^）]{1,20}）$/.test(t)          // （見出し）
                || /^【[^】]{1,20}】$/.test(t)           // 【見出し】
                || /^[一二三四五六七八九十]、/.test(t)   // 一、二、...
                || /^[①-⑳]/.test(t)                    // ①②...
                || ['記','以上','附則','別紙'].includes(t);
        };

        // Weight = estimated visual lines, including CSS margin overhead
        const lineWeight = (line) => {
            const plain = String(line || '').replace(/\x00\/?REV\x00/g, '');
            const trimmed = plain.trim();
            const wrapLines = Math.max(1, Math.ceil(plain.length / charsPerLine));
            // Article headings have margin-top:12px ≈ 0.5 line; sub-headers 6px ≈ 0.25
            const extra = _isArticleH(trimmed) ? 0.5 : (_isSubH(trimmed) ? 0.25 : 0);
            return wrapLines + extra;
        };

        const pages = [];
        let currentPage = [];
        let currentWeight = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const w = lineWeight(line);
            const trimmed = String(line || '').replace(/\x00\/?REV\x00/g, '').trim();

            if (currentWeight + w > linesPerPage && currentPage.length > 0) {
                // Orphan protection: don't end page on a sub-header (keep with following article)
                const lastTrimmed = String(currentPage[currentPage.length - 1] || '').trim();
                const isOrphan = _isSubH(lastTrimmed) || _isArticleH(lastTrimmed);
                if (isOrphan) {
                    // Absorb this line into current page to avoid orphan
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
        if (pages.length === 0) pages.push([' ']);
        return pages;
    },

    _renderDocumentPagesHtml(text, options = {}) {
        const {
            editable = false,
            showRevisionMarks = false,
            markChangedLines = false,
            originalText = this._getOriginalDocumentText(),
            showPageNumbers = false,
            targetPageCount = null
        } = options;
        const originalLines = new Set(String(originalText || '').split('\n').map(line => line.trim()).filter(Boolean));
        const { charsPerLine, linesPerPage } = this._calcPageLayout();
        const pages = this._paginateDocumentText(text, charsPerLine, linesPerPage, targetPageCount);
        let blockIndex = 0;

        const renderLine = (line) => {
            const raw = String(line || '');
            const clean = raw.replace(/\x00REV\x00|\x00\/REV\x00/g, '');
            const trimmed = clean.trim();
            const isHeading = /^第[0-9０-９零〇一二三四五六七八九十百千]+条|^【|^■|^\d+\./.test(trimmed);
            const isEmpty = !trimmed;
            const isModified = markChangedLines && trimmed && !originalLines.has(trimmed);
            const classes = [
                'v3-editor-block',
                isHeading ? 'is-heading' : '',
                isEmpty ? 'is-empty' : '',
                isModified ? 'modified' : '',
                showRevisionMarks && raw.includes('\x00REV\x00') ? 'modified' : ''
            ].filter(Boolean).join(' ');
            const content = showRevisionMarks
                ? this.escapeHtml(raw).replace(/\x00REV\x00([\s\S]*?)\x00\/REV\x00/g, '<mark class="v3-revision-mark">$1</mark>')
                : this.escapeHtml(clean);

            if (!editable) {
                return `<div class="${classes}">${content}</div>`;
            }

            const idx = blockIndex++;
            return `
                <div class="${classes}"
                     contenteditable="true"
                     data-index="${idx}"
                     oninput="window.signViewer._onBlockInput(this)"
                     onblur="window.signViewer._onBlockBlur(this)">${this.escapeHtml(clean)}</div>
            `;
        };

        this._totalPages = pages.length;
        return pages.map((pageLines, pageIndex) => `
            <div class="v3-editor-page" data-page="${pageIndex + 1}">
                ${pageLines.map(renderLine).join('')}
                ${showPageNumbers ? `<div class="v3-page-number">Page ${pageIndex + 1} / ${pages.length}</div>` : ''}
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
        const changes = (this._sortedChanges && this._sortedChanges.length)
            ? this._sortedChanges
            : this._getSortedAiChanges();
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
        return `
            <style>
                .v3-document-scroll-area { width:100%; height:100%; overflow:auto; background:#f1f5f9; display:flex; flex-direction:column; align-items:center; padding:24px 0 100px 0; box-sizing:border-box; cursor:default; }
                .v3-document-page-stack { display:flex; flex-direction:column; align-items:center; width:100%; }
                .v3-editor-page {
                    background:#fff !important;
                    box-shadow:0 4px 20px rgba(0,0,0,0.10) !important;
                    border:none !important;
                    border-radius:2px !important;
                    width:794px !important;
                    min-height:1123px !important;
                    height:1123px !important;
                    max-height:1123px !important;
                    margin:0 auto 40px auto !important;
                    padding:80px 90px !important;
                    box-sizing:border-box;
                    font-family:'Noto Serif JP','Yu Mincho','MS Mincho',serif;
                    font-size:${this._getFinalEditorFontSize()}px;
                    line-height:1.7;
                    color:#222;
                    position:relative;
                    overflow:hidden;
                    flex:0 0 auto;
                    break-after:page;
                    page-break-after:always;
                }
                .v3-editor-block { position:relative; margin:0; padding:2px 0; outline:none; white-space:pre-wrap; overflow-wrap:anywhere; word-break:normal; border:1px solid transparent; min-height:1.2em; text-align:left; cursor:text; }
                .v3-editor-block[contenteditable="true"]:hover { background:rgba(59,130,246,0.03); border-color:#dbeafe; cursor:text; }
                .v3-editor-block[contenteditable="true"]:focus { background:rgba(59,130,246,0.05); border-color:#bfdbfe; }
                .v3-editor-block.is-heading { font-weight:700; font-size:11pt; color:#000; margin-top:14px; margin-bottom:4px; }
                .v3-editor-block.modified { border-left:2px solid #22c55e !important; padding-left:12px; margin-left:-14px; background:#f0fdf4; }
                .v3-revision-mark { background:#bbf7d0; border-radius:3px; padding:1px 3px; font-weight:600; color:#14532d; }
                .v3-page-number { position:absolute; bottom:20px; right:40px; font-size:11px; color:#94a3b8; font-weight:700; }
                .v3-editor-toolbar { position:sticky; top:0; z-index:100; display:flex; align-items:center; flex-wrap:wrap; gap:6px; padding:8px 12px; border:none; border-radius:12px; flex-shrink:0; background:#fff; color:#374151; width:900px !important; max-width:min(900px, calc(100vw - 32px)) !important; margin:2px auto 4px auto !important; box-sizing:border-box !important; box-shadow:0 4px 12px rgba(0,0,0,0.08); min-height:48px; overflow-x:visible; }
                .v3-editor-toolbar button { padding:5px 10px; border-radius:6px; font-size:12px; cursor:pointer; border:1px solid #e5e7eb; background:#f9fafb; color:#374151; white-space:nowrap; }
                .v3-editor-toolbar button:hover { background:#f3f4f6; }
                .v3-editor-toolbar .btn-primary { background:#0b2d62; color:#fff; border-color:#0b2d62; font-weight:700; }
                .v3-editor-toolgroup { display:inline-flex; align-items:center; gap:3px; padding-right:8px; border-right:1px solid #e5e7eb; flex-shrink:0; }
                .v3-editor-toolbar-row { display:flex; align-items:center; gap:10px; width:100%; min-width:0; }
                .v3-editor-main-tools { display:inline-flex; gap:6px; align-items:center; min-width:0; flex:1 1 auto; flex-wrap:nowrap; justify-content:flex-start; overflow:hidden; }
                .v3-editor-right-actions { display:inline-flex; align-items:center; gap:8px; margin-left:auto; flex-shrink:0; }
                .v3-editor-save-btn,
                .v3-editor-toolbar .v3-editor-save-btn {
                    display:inline-flex;
                    align-items:center;
                    gap:6px;
                    padding:6px 18px !important;
                    border-radius:8px;
                    background:#0b2d62 !important;
                    border-color:#0b2d62 !important;
                    color:#fff !important;
                    font-weight:700;
                    box-shadow:0 4px 10px rgba(11,45,98,0.18);
                }
                .v3-editor-save-btn:hover,
                .v3-editor-toolbar .v3-editor-save-btn:hover {
                    background:#08234e !important;
                    border-color:#08234e !important;
                    color:#fff !important;
                    box-shadow:0 6px 14px rgba(11,45,98,0.24);
                }
                .v3-editor-save-btn:active,
                .v3-editor-toolbar .v3-editor-save-btn:active {
                    background:#061b3f !important;
                    border-color:#061b3f !important;
                    color:#fff !important;
                    transform:translateY(1px);
                }
                .v3-editor-icon-btn { width:32px; height:32px; padding:0 !important; display:inline-flex; align-items:center; justify-content:center; }
                .v3-editor-select { height:32px; border:1px solid #e5e7eb; border-radius:6px; background:#fff; padding:0 8px; color:#374151; font-size:12px; }
                .v3-editor-select.is-style { width:76px; }
                .v3-editor-select.is-size { width:68px; }
                .v3-editor-color { width:32px; height:32px; padding:2px; border:1px solid #e5e7eb; border-radius:6px; background:#fff; cursor:pointer; }
                /* [!!!] CRITICAL LAYOUT GUARD: WORD-DENSITY COMPLIANCE [!!!] */
                .v3-rich-editor-body { 
                    min-height:963px; max-height:963px; outline:none; white-space:pre-wrap; 
                    overflow-wrap:anywhere; word-break:normal; overflow:hidden; cursor:text; 
                    line-height:1.5 !important; font-size:14px !important; font-family:'Noto Sans JP', sans-serif; 
                }
                .v3-rich-editor-body div { margin-bottom: 0.4em !important; }
                /* [!!!] END GUARDED AREA [!!!] */
                .v3-applied-change { background:#dcfce7; border:1px solid #86efac; border-bottom:2px solid #22c55e; border-radius:4px; padding:1px 3px; box-decoration-break:clone; -webkit-box-decoration-break:clone; }
                .v3-applied-change-pulse {
                    animation: v3-pulse-highlight 2s ease-out infinite;
                    background: #fef08a !important; /* Yellow-200 for high visibility */
                    border-bottom: 2px solid #eab308 !important;
                }
                @keyframes v3-pulse-highlight {
                    0% { box-shadow: 0 0 0 0 rgba(234, 179, 8, 0.4); }
                    70% { box-shadow: 0 0 0 10px rgba(234, 179, 8, 0); }
                    100% { box-shadow: 0 0 0 0 rgba(234, 179, 8, 0); }
                }
                .v3-rich-editor-body:focus { box-shadow:inset 0 0 0 2px #bfdbfe; }
                .v3-rich-editor-body ul, .v3-rich-editor-body ol { padding-left:1.5em; margin:0.35em 0; }
                .v3-rich-editor-body h1 { font-size:1.35em; margin:0.9em 0 0.35em; }
                .v3-rich-editor-body h2 { font-size:1.18em; margin:0.75em 0 0.3em; }
            </style>
        `;
    },

    _buildFinalPreviewHtml(text) {
        const bodyHtml = this._renderDocumentPagesHtml(text, {
            editable: false,
            showRevisionMarks: false,
            markChangedLines: false,
            targetPageCount: null
        });
        return `
            <!doctype html>
            <html>
            <head>
                <meta charset="utf-8">
                <style>
                    @page { size:A4; margin:0; }
                    body { margin:0; background:#fff; color:#222; }
                    .v3-editor-page { width:210mm; height:297mm; max-height:297mm; overflow:hidden; box-sizing:border-box; padding:25mm 25mm; page-break-after:always; break-after:page; font-family:'Noto Serif JP','Yu Mincho','MS Mincho',serif; font-size:10.5pt; line-height:1.8; color:#222; }
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

    async _generateFinalPdf(text) {
        const serviceUrl = (typeof window !== 'undefined' && window.__DOCX_PDF_SERVICE_URL__)
            ? String(window.__DOCX_PDF_SERVICE_URL__).replace(/\/$/, '')
            : '';
        if (!serviceUrl) return null;

        const html = this._buildFinalPreviewHtml(text);
        const resp = await fetch(`${serviceUrl}/api/convert/html-to-pdf`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ html })
        });
        if (resp.ok) return await resp.blob();
        return null;
    },

    _buildFinalDocxRevisions(finalContent = this._getFinalDocumentText()) {
        const changes = this._sortedChanges || this._getSortedAiChanges();
        const storedApplied = this._getStoredAppliedChangeIndexes();
        const detectedApplied = this._getAppliedChangeIndexesFromFinal(finalContent);
        const applied = new Set([...storedApplied, ...detectedApplied]);

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

    async _generateFinalDocxPdf(finalContent = this._getFinalDocumentText()) {
        const serviceUrl = (typeof window !== 'undefined' && window.__DOCX_PDF_SERVICE_URL__)
            ? String(window.__DOCX_PDF_SERVICE_URL__).replace(/\/$/, '')
            : '';
        if (!serviceUrl) return { blob: null, reason: 'DOCX/PDF変換サービスが設定されていません。' };

        const contractId = this._currentRequest?.contract_id || this._currentRequest?.contractId || this._contract?.id;
        let originalFile = this._app && typeof this._app.getDocxFromIDB === 'function'
            ? await this._app.getDocxFromIDB(contractId)
            : null;

        if (!(originalFile instanceof Blob)) {
            const originalUrl = this._contract?.original_file_url || this._contract?.original_file_path;
            if (originalUrl) {
                try {
                    const fullUrl = resolveBackendAssetUrl(originalUrl);
                    const token = await getIdToken();
                    const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
                    const resp = await fetch(fullUrl, { headers });
                    if (resp.ok) {
                        const blob = await resp.blob();
                        const fileName = this._contract?.original_filename || 'original.docx';
                        originalFile = new File([blob], fileName, { type: blob.type || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
                        if (this._app && typeof this._app._saveDocxToIDB === 'function') {
                            await this._app._saveDocxToIDB(contractId, originalFile).catch(e => console.warn('[SignViewer] IDB cache failed:', e));
                        }
                    }
                } catch (e) {
                    console.error('[SignViewer] Server fallback fetch failed:', e);
                }
            }
        }

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

    renderHandEditMode(container) {
        const contract = this._contract || {};
        const originalText = this._getOriginalDocumentText();
        const initialContent = this._getFinalDocumentText();
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
        const appliedIndexes = this._getAppliedChangeIndexesFromFinal(initialContent);
        this._appliedChanges = appliedIndexes;
        const appliedCount = appliedIndexes.size;

        const editLayer = document.getElementById('v3-edit-layer');
        if (!editLayer) return;
        const editorFontSize = this._getFinalEditorFontSize();

        editLayer.innerHTML = `
            ${this._getDocumentLayoutCss()}
            <div style="width:100%;height:100%;display:flex;flex-direction:column;">
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
                            <input class="v3-editor-color" type="color" value="#222222" onchange="window.signViewer._runEditorCommand('foreColor', this.value)" title="文字色">
                            <input class="v3-editor-color" type="color" value="#fff3bf" onchange="window.signViewer._runEditorCommand('hiliteColor', this.value)" title="ハイライト">
                            <button class="v3-editor-icon-btn" onclick="window.signViewer._runEditorCommand('removeFormat')" title="書式をクリア"><i class="fa-solid fa-eraser"></i></button>
                        </span>
                        </div>
                        <div class="v3-editor-right-actions">
                        <button onclick="window.signViewer._previewHandEdit()" style="display:inline-flex;align-items:center;gap:6px;background:#f8fafc;color:#0b2d62;border:1px solid #bfdbfe;font-weight:700;">
                            <i class="fa-solid fa-eye"></i> プレビュー
                        </button>
                        <button onclick="window.signViewer._saveHandEdit()" class="v3-editor-save-btn">
                            <i class="fa-solid fa-floppy-disk"></i> 保存する
                        </button>
                        </div>
                    </div>
                </div>
                ${this._renderFinalGenerationNotice()}
                <div class="v3-document-scroll-area" id="v3-editor-scroll">
                    <div id="v3-editor-content-container" class="v3-document-page-stack">
                        ${this._renderFinalEditorSurfaceHtml(initialContent, originalText, originalPageCount)}
                    </div>
                </div>
            </div>
        `;
        this.renderDashboardUI();

        const scrollArea = document.getElementById('v3-editor-scroll');
        if (scrollArea) scrollArea.style.cursor = 'default';
        this._bindFinalEditorToolbar();
    },

    _focusFinalEditor() {
        const activeEditor = document.activeElement?.closest?.('#v3-editor-scroll .v3-rich-editor-body');
        if (activeEditor) return activeEditor;
        const editor = document.querySelector('#v3-editor-scroll .v3-rich-editor-body');
        if (editor && document.activeElement !== editor) editor.focus();
        if (editor) editor.style.cursor = 'text';
        return editor;
    },

    _bindFinalEditorToolbar() {
        const toolbar = document.querySelector('.v3-editor-toolbar');
        if (toolbar) {
            toolbar.querySelectorAll('button').forEach(button => {
                button.addEventListener('mousedown', event => event.preventDefault());
            });
        }
        document.querySelectorAll('#v3-editor-scroll .v3-rich-editor-body').forEach(editor => {
            editor.style.cursor = 'text';
            editor.addEventListener('keyup', () => this._saveEditorSelection());
            editor.addEventListener('mouseup', () => this._saveEditorSelection());
            editor.addEventListener('focus', () => this._saveEditorSelection());
        });
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

    _canUndoEdit() {
        const current = document.getElementById('v3-editor-scroll') ? this._collectEditorContent() : String(this._editedContent || '');
        return Boolean(
            this._editHistory
            && (
                this._editHistoryIndex > 0
                || (current && current !== this._editHistory?.[this._editHistoryIndex])
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
            this._editHistory = [current];
            this._editHistoryIndex = 0;
            return;
        }
        if (current && current !== this._editHistory[this._editHistoryIndex]) {
            this._pushHistory(current);
        }
        this._editedContent = current;
        this._editedHtml = this._collectEditorHtml();
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

    _onRichEditorInput(el) {
        this._markEditorUnsaved();
        this._editedContent = this._collectEditorContent();
        this._editedHtml = this._collectEditorHtml();
        this._syncUndoRedoButtons();
    },

    _onRichEditorBlur(el) {
        const nextContent = this._collectEditorContent();
        const nextHtml = this._collectEditorHtml();
        if (nextContent !== this._editHistory?.[this._editHistoryIndex]) this._pushHistory(nextContent);
        this._editedContent = nextContent;
        this._editedHtml = nextHtml;
        this._syncUndoRedoButtons();
    },

    _runEditorCommand(command, value = null) {
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
        this._runEditorCommand('formatBlock', tagName || 'P');
    },

    _setSelectedFontSize(value) {
        const size = Math.min(32, Math.max(12, Number(value) || this._getFinalEditorFontSize()));
        const selection = window.getSelection();
        const hasSelection = selection && selection.rangeCount && !selection.isCollapsed;
        if (!hasSelection) {
            this._setFinalEditorFontSize(size);
            return;
        }
        this._restoreEditorSelection();
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
        
        if (nextContent !== this._editedContent && nextContent !== this._editHistory?.[this._editHistoryIndex]) {
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
        if (this._editHistoryIndex < this._editHistory.length - 1) {
            this._editHistory = this._editHistory.slice(0, this._editHistoryIndex + 1);
        }
        this._editHistory.push(content);
        if (this._editHistory.length > 30) this._editHistory.shift();
        this._editHistoryIndex = this._editHistory.length - 1;
    },

    async _saveHandEdit({ rerender = true, renderGenerated = true } = {}) {
        const finalContent = this._collectEditorContent();
        const finalHtml = this._collectEditorHtml();
        
        this._editedContent = finalContent;
        this._editedHtml = finalHtml;
        this._lastSavedContent = finalContent;
        
        if (this._contract) {
            this._contract.final_content = finalContent;
            this._contract.final_content_html = finalHtml;
            dbService.updateContract(this._contract.id, {
                final_content: finalContent,
                final_content_html: finalHtml,
                final_font_size: this._getFinalEditorFontSize()
            });
        }
        
        if (renderGenerated) {
            const generated = await this._renderGeneratedFinalPdf(finalContent);
            if (generated) {
                Notify.success('保存し、最終版PDFを生成しました。');
                return finalContent;
            }
        }
        if (rerender) {
            this._viewMode = 'final';
            this.renderFinalReadMode(this._viewerContainer);
        }
        Notify.success('保存しました');
        return finalContent;
    },

    async _renderGeneratedFinalPdf(finalContent = this._getFinalDocumentText()) {
        try {
            Notify.info('最終版PDFを生成しています...');
            const generatedFromDocx = await this._generateFinalDocxPdf(finalContent);
            const pdfBlob = generatedFromDocx?.blob || null;
            if (!pdfBlob) {
                Notify.warning(generatedFromDocx?.reason || 'DOCX最終版PDFの生成に失敗しました。編集内容は保存済みです。');
                this._viewMode = 'final';
                this.renderFinalReadMode(this._viewerContainer);
                return false;
            }
            if (this._finalGeneratedPdfUrl) URL.revokeObjectURL(this._finalGeneratedPdfUrl);
            this._finalGeneratedPdfUrl = URL.createObjectURL(pdfBlob);
            this._currentDownloadUrl = this._finalGeneratedPdfUrl;
            this._currentPdfUrl = this._finalGeneratedPdfUrl;
            this._objectUrls.push(this._finalGeneratedPdfUrl);

            const editLayer = document.getElementById('v3-edit-layer');
            if (editLayer) editLayer.style.display = 'none';
            document.querySelectorAll('.v3-final-applied-overlay').forEach(node => node.remove());
            this._viewMode = 'final';
            this._setFinalActionBarVisible(false);
            await this.renderPdf(this._finalGeneratedPdfUrl, this._viewerContainer);
            this.renderDashboardUI();
            // ツールバーのrenderDashboardUIがプレビュー・編集するボタンを自動表示する
            document.getElementById('v3-saved-action-bar')?.remove();
            return true;
        } catch (error) {
            console.warn('[SignViewer] final PDF generation failed:', error);
            Notify.warning('PDF生成に失敗しました。編集内容は保存済みです。');
            return false;
        }
    },

    _previewHandEdit() {
        // In read mode there's no editor DOM — fall back to stored final text
        const fromEditor = this._collectEditorContent();
        const finalContent = (fromEditor && fromEditor.trim()) ? fromEditor : this._getFinalDocumentText();
        this._editedContent = finalContent;
        this._editedHtml = this._collectEditorHtml();
        this._lastPreviewContent = finalContent;
        this._openFinalPreviewOverlay(finalContent);
    },

    _openFinalPreviewOverlay(finalContent) {
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
                        <span style="font-size:12px;font-weight:600;color:rgba(255,255,255,0.72);">反映箇所を色付きで確認できます</span>
                    </div>
                    <div style="display:flex;align-items:center;gap:8px;">
                        <button onclick="window.signViewer._downloadFinalPreviewPdf()" style="background:#fff;color:#0b2d62;border:none;border-radius:8px;padding:7px 12px;font-size:12px;font-weight:800;cursor:pointer;display:inline-flex;align-items:center;gap:6px;">
                            <i class="fa-solid fa-download"></i> PDF出力
                        </button>
                        <button onclick="document.getElementById('final-preview-overlay')?.remove()" style="width:32px;height:32px;border-radius:8px;border:none;background:rgba(255,255,255,0.14);color:#fff;cursor:pointer;font-size:16px;line-height:1;">×</button>
                    </div>
                </div>
                <div style="flex:1;min-height:0;position:relative;">
                    ${this._getDocumentLayoutCss()}
                    <div class="v3-document-scroll-area" style="height:100%;padding-top:24px;">
                        <div class="v3-document-page-stack">
                            ${this._renderFinalPreviewPagesHtml(finalContent)}
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
                        targetPageCount: this._getOriginalPageCount()
                    })}
                </div>
            </div>
        `;
        this.hideViewerLoader();
        this.renderDashboardUI();
    },

    // 最終版タブの閲覧ビュー（「編集する」ボタンのみ表示）
    renderFinalReadMode(container) {
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
                <div style="position:sticky;top:0;z-index:100;
                            display:flex;align-items:center;justify-content:flex-end;gap:8px;
                            padding:8px 16px;background:#fff;
                            border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,0.08);
                            width:900px;max-width:calc(100vw - 32px);
                            margin:8px auto 12px auto;box-sizing:border-box;min-height:48px;">
                    <button onclick="window.signViewer._previewHandEdit()"
                        style="display:inline-flex;align-items:center;gap:6px;
                               padding:6px 14px;border-radius:8px;border:1px solid #bfdbfe;cursor:pointer;
                               background:#f8fafc;color:#0b2d62;font-size:13px;font-weight:700;">
                        <i class="fa-solid fa-eye"></i> プレビュー
                    </button>
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
        this._captureCurrentEditForHistory();
        if (!this._editHistory || this._editHistoryIndex <= 0) {
            Notify.info('これ以上戻せません');
            return;
        }
        this._editHistoryIndex--;
        this._editedContent = this._editHistory[this._editHistoryIndex];
        this.renderHandEditMode(this._viewerContainer);
        Notify.success('元に戻しました');
    },

    _redoEdit() {
        this._captureCurrentEditForHistory();
        if (!this._editHistory || this._editHistoryIndex >= this._editHistory.length - 1) return;
        this._editHistoryIndex++;
        this._editedContent = this._editHistory[this._editHistoryIndex];
        this.renderHandEditMode(this._viewerContainer);
        Notify.success('やり直しました');
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
                return [art, paras].filter(Boolean).join('\n');
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
                const section = this._getChangeDisplaySection(c, i);
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

        // 蜷・ｮｵ關ｽ繧偵Ξ繝ｳ繝繝ｪ繝ｳ繧ｰ・井ｿｮ豁｣繝槭・繧ｫ繝ｼ縺ｯ鮟・牡繝上う繝ｩ繧､繝茨ｼ・
        const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        const renderLine = (line) => {
            const trimmed = line.trim();
            if (!trimmed) return '<div style="height:8px;"></div>';
            const isBold = /^第[0-9０-９零〇一二三四五六七八九十百千]+条|^【|^■/.test(trimmed);
            let safe;
            if (trimmed.includes('\x00REV\x00')) {
                safe = trimmed.replace(/\x00REV\x00([\s\S]*?)\x00\/REV\x00/g,
                    (_, t) => `<mark style="background:#bbf7d0;border-radius:3px;padding:1px 3px;font-weight:600;">${esc(t)}</mark>`)
                    .replace(/(?<!>)[^<]*(?=<|$)/g, s => s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]||c)));
                // simpler: just do the marker replacement on escaped version
                safe = esc(trimmed).replace(/\x00REV\x00([\s\S]*?)\x00\/REV\x00/g,
                    (_, t) => `<mark style="background:#bbf7d0;border-radius:3px;padding:1px 3px;font-weight:600;">${t}</mark>`);
            } else {
                safe = esc(trimmed);
            }
            return `<p style="margin:0 0 8px;line-height:2;font-size:14px;${isBold?'font-weight:700;color:#0f172a;margin-top:24px;padding-bottom:4px;border-bottom:1px solid #e2e8f0;':'color:#1e293b;'}">${safe}</p>`;
        };

        const docHtml = docText.split('\n').map(renderLine).join('');

        // 繝昴ャ繝励い繝・・繝｢繝ｼ繝繝ｫ・井ｸｭ螟ｮ蟇・○・・
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
                <div style="flex:1;overflow-y:auto;background:#f8fafc;padding:0;">\n                    <div style="max-width:700px;margin:32px auto;background:#fff;border-radius:8px;padding:48px 56px;box-shadow:0 2px 12px rgba(0,0,0,0.06);font-family:'Noto Sans JP',sans-serif;min-height:600px;">
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
                const section = escText(sectionRaw);
                const oldRaw = this._getChangeOldText(c);
                const newRaw = this._buildLegalInsertionText(c);
                const oldText = escText(oldRaw);
                const newDiffHtml = charDiff(oldRaw, newRaw);
                const reason = escText(c.reason || '');
                const concern = escText(c.concern || '');
                const impact = escText(c.impact || '');
                
                const isAddition = !oldRaw;
                const badgeColor = isAddition ? '#8b5cf6' : '#3b82f6';
                const labelText = isAddition ? '追記' : '修正';
                const targetLabel = isAddition ? '追加先' : '対象条項';
                const proposalIntro = isAddition
                    ? 'このリスクを抑えるため、次の条項を追加することを提案します。'
                    : 'このリスクを抑えるため、次の文言へ修正することを提案します。';
                const riskText = concern || reason || '契約上の不利益を抑えるため、条項の明確化が必要です。';

                return `
                <div style="margin-bottom:20px;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.04);">
                    <div style="background:#f8fafc;padding:10px 16px;border-bottom:1px solid #e2e8f0;display:flex;align-items:center;gap:8px;">
                        <span style="background:${badgeColor};color:#fff;font-size:11px;font-weight:700;padding:2px 8px;border-radius:12px;white-space:nowrap;">${labelText} ${i + 1}</span>
                        <span style="font-size:13px;font-weight:700;color:#1e293b;">${targetLabel}: ${section}</span>
                    </div>
                    <div style="padding:12px 16px;background:#fff7ed;border-bottom:1px solid #fed7aa;">
                        <div style="font-size:11px;font-weight:800;color:#c2410c;margin-bottom:6px;">検出したリスク</div>
                        <div style="font-size:13px;color:#1e293b;line-height:1.8;">${riskText}</div>
                    </div>
                    <div style="padding:12px 16px;background:#fff5f5;border-bottom:1px solid #fecaca;">
                        <div style="font-size:11px;font-weight:700;color:#dc2626;margin-bottom:4px;">${oldText ? '修正前（原文）' : '現状'}</div>
                        <div style="font-size:13px;color:#374151;line-height:1.8;">
                            ${oldText ? oldText : `<span style="color:#9f1239;font-weight:700;">${section}に保護条項が不足しています。</span>`}
                        </div>
                    </div>
                    <div style="padding:12px 16px;background:#f0fdf4;">
                        <div style="font-size:11px;font-weight:700;color:#16a34a;margin-bottom:4px;">提案する条文</div>
                        <div style="font-size:12px;color:#166534;line-height:1.7;margin-bottom:8px;">${proposalIntro}</div>
                        <div style="font-size:13px;color:#374151;line-height:1.8;">${newDiffHtml}</div>
                    </div>
                    ${(concern || impact) ? `<div style="padding:10px 16px;background:#fafafa;border-top:1px solid #e2e8f0;font-size:12px;color:#64748b;">
                        ${impact ? `<div><span style="font-weight:700;color:#166534;">✓ 期待される効果：</span>${impact}</div>` : ''}
                    </div>` : ''}
                    <div style="padding:10px 16px;background:#fff;border-top:1px solid #e2e8f0;display:flex;justify-content:flex-end;">
                        ${_applied.has(i)
                            ? `<div style="display:flex;gap:8px;align-items:center;">
                                <button onclick="window.signViewer._revertChange(${i})" style="background:#fff;color:#374151;border:1px solid #d0d7de;padding:6px 14px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;">元に戻す</button>
                                <button onclick="window.signViewer.switchViewMode('final')" style="background:#dcfce7;color:#166534;border:1px solid #86efac;padding:6px 14px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;">反映済み（最終版で確認）</button>
                            </div>`
                            : `<button onclick="window.signViewer._applyChange(${i})" style="background:#0b2d62;color:#fff;border:none;padding:6px 14px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;">この修正を反映</button>`
                        }
                    </div>
                </div>`;
            }).join('');
        }

        revisedLayer.innerHTML = `
            <div style="padding:20px;max-width:900px;margin:0 auto;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
                    <div style="font-size:14px; color:#64748b; font-weight:600;">
                        AIによる${aiChanges.length}件の修正案
                    </div>
                    <button onclick="window.signViewer._applyAllChanges()" 
                            style="background:#0b2d62; color:#fff; border:none; padding:8px 16px; border-radius:8px; font-size:13px; font-weight:700; cursor:pointer; display:flex; align-items:center; gap:8px; box-shadow:0 2px 8px rgba(11,45,98,0.15);">
                        <i class="fa-solid fa-check-double"></i> すべて反映
                    </button>
                </div>
                ${contentHtml}
            </div>
        `;
    },

    _applyChange(idx) {
        const c = (this._sortedChanges || [])[idx];
        if (!c) return;
        if (!this._appliedChanges) this._appliedChanges = new Set();
        if (this._appliedChanges.has(idx)) {
            Notify.info('この修正はすでに最終版へ反映済みです。');
            this.switchViewMode('final');
            return;
        }
        const baseText = this._ensureEditedContent();
        const nextText = this._applyChangeToText(baseText, c);
        if (nextText === baseText) {
            const checkText = this._buildLegalInsertionText(c);
            const alreadyPresent = checkText && baseText.includes(checkText);
            if (!alreadyPresent) {
                Notify.warning('この修正案は最終版へ反映できませんでした。対象条文を確認してください。');
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

        const applied = this._getStoredAppliedChangeIndexes();
        applied.add(idx);
        this._setStoredAppliedChangeIndexes(applied, {
            final_content: nextText,
            final_content_html: ''
        });
        Notify.success('修正を最終版へ反映しました。');
        this._justAppliedSnippet = this._buildLegalInsertionText(c);
        this.renderModifiedDocument(this._viewerContainer);
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
        const changes = this._sortedChanges || [];
        if (!changes.length) return;
        if (!this._appliedChanges) this._appliedChanges = new Set();
        let nextText = this._ensureEditedContent();
        if (!this._editHistory) {
            this._editHistory = [nextText];
            this._editHistoryIndex = 0;
        }
        
        const applied = this._getStoredAppliedChangeIndexes();
        changes.forEach((c, i) => {
            if (applied.has(i)) return;
            const before = nextText;
            nextText = this._applyChangeToText(nextText, c);
            if (nextText === before) {
                console.warn('[SignViewer] Failed to apply change:', i, c);
                return;
            }
            applied.add(i);
        });
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
        this._setStoredAppliedChangeIndexes(applied, {
            final_content: nextText,
            final_content_html: ''
        });

        Notify.success('すべての修正を最終版へ反映しました。');
        this.switchViewMode('final');
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
        const editorVisible = document.getElementById('v3-editor-scroll');
        const finalText = String(editorVisible ? this._collectEditorContent() : this._getFinalDocumentText());
        if (editorVisible) {
            this._editedContent = finalText;
            this._editedHtml = this._collectEditorHtml();
        }
        if (!finalText.trim()) {
            Notify.error('ダウンロードする最終版の本文がありません');
            return;
        }

        const baseName = String(this._contract?.name || this._currentFilename || 'final_document')
            .replace(/[\\/:*?"<>|]/g, '_')
            .replace(/\.(docx?|pdf)$/i, '')
            .trim() || 'final_document';

        try {
            Notify.info('最終版PDFを生成しています...');
            const pdfBlob = await this._generateFinalPdf(finalText);
            if (pdfBlob) {
                const pdfUrl = URL.createObjectURL(pdfBlob);
                const link = document.createElement('a');
                link.href = pdfUrl;
                link.download = `${baseName}_final.pdf`;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                setTimeout(() => URL.revokeObjectURL(pdfUrl), 1000);
                Notify.success('最終版PDFをダウンロードしました');
                return;
            }
        } catch (error) {
            console.error('Final PDF generation error:', error);
        }

        const htmlBlob = new Blob([this._buildFinalPreviewHtml(finalText)], { type: 'text/html;charset=utf-8' });
        const htmlUrl = URL.createObjectURL(htmlBlob);
        const link = document.createElement('a');
        link.href = htmlUrl;
        link.download = `${baseName}_final.html`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(htmlUrl), 1000);
        Notify.warning('PDF生成に失敗したため、編集用HTMLをダウンロードしました');
    },

    async downloadPdf() {
        if (this._viewMode === 'edit') {
            await this._downloadFinalPreviewPdf();
            return;
        }

        const req = this._currentRequest || {};
        const fallbackUrl = resolveBackendAssetUrl(req.original_file_url || req.original_file_path || req.pdf_url || req.pdf_storage_path);
        const downloadUrl = this._currentDownloadUrl || this._currentPdfUrl || fallbackUrl;
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
            
            // If it's an object URL, we can download it directly without CORS issues
            if (downloadUrl.startsWith('blob:')) {
                const link = document.createElement('a');
                link.href = downloadUrl;
                link.download = filename;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                return;
            }
            
            // For cross-origin URLs, we must fetch the blob first, otherwise the browser will just navigate to the URL
            const response = await fetch(downloadUrl);
            if (!response.ok) throw new Error('Fetch failed');
            const blob = await response.blob();
            const blobUrl = URL.createObjectURL(blob);
            
            const link = document.createElement('a');
            link.href = blobUrl;
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            
            setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
        } catch (error) {
            console.error('Download error:', error);
            // Fallback: open in new tab if fetch fails due to CORS
            const link = document.createElement('a');
            link.href = downloadUrl;
            link.target = '_blank';
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
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
                    <div data-page="${i+1}" class="v3-editor-page" style="width:794px;max-width:calc(100vw - 64px);margin:0 auto 32px auto;padding:80px 100px;box-sizing:border-box;background:#fff;min-height:1123px;box-shadow:0 8px 24px rgba(0,0,0,0.08);color:#333;font-family:'Noto Serif JP', serif;font-size:14px;line-height:1.5;white-space:pre-wrap;overflow:hidden;">
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
            docxLayer.style.display = 'block';
            this.hideViewerLoader();
            this._isRenderingDocx = false;
            return;
        }
        this._currentDocxKey = currentUrl;

            const isDash = this._isDashboardMode;
        // Word-native CSS reset: override docx-preview defaults to match Word layout
        const docxCssReset = `<style id="docx-viewer-css-reset">
            #pdf-viewer-scroll .docx-wrapper { background: transparent !important; padding: 0 !important; }
            #pdf-viewer-scroll .docx-wrapper > section,
            #pdf-viewer-scroll .docx-smart-page,
            #pdf-viewer-scroll .docx-virtual-page,
            #pdf-viewer-scroll .editor-page-shell,
            #pdf-viewer-scroll .editor-page-wrapper {
                background: #ffffff !important;
                box-shadow: 0 10px 30px rgba(0,0,0,0.05) !important;
                margin: 0 auto 32px auto !important;
                width: 794px !important;
                min-height: 1123px !important;
                box-sizing: border-box !important;
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
            mount.style.display = 'block';
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
            const pages = await renderDocxPreviewPages(mount, resolvedSource);
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
            });
            this._activePage = 1;
            this.updateVisiblePages();

            // --- 譬ｹ譛ｬ菫ｮ豁｣: 蟶ｸ縺ｫ蜿ｸ莉､蝪費ｼ・pdateTransform・峨ｒ譛牙柑蛹悶＠縲∽ｸｭ螟ｮ縺ｫ驟咲ｽｮ縺吶ｋ ---
            const scrollEl = document.getElementById('pdf-viewer-scroll');
            const loader = document.getElementById('viewer-loader');
            
            if (scrollEl) {
                this.setupInteractiveViewer(scrollEl, mount);
                
                // Word雉・侭縺ｮ驟咲ｽｮ縺ｨ繧ｹ繧ｱ繝ｼ繝ｫ縺ｮ譛驕ｩ蛹・
                    // Apply CSS zoom to scale the DOCX document (zoom affects layout bounds unlike transform)
                    const zoom = this._currentScale || 1.0;
                    mount.style.zoom = zoom;
                    this.renderDashboardUI();
                }
            
            if (loader) loader.style.display = 'none';
            this.renderDashboardUI();
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

        // 繝｢繝ｼ繝繝ｫ陦ｨ遉ｺ繧・ヵ繧ｩ繝ｼ繝ｫ繝舌ャ繧ｯ縺ｮ蝣ｴ蜷・
        if (isDash) {
            container.innerHTML = `
                <div style="width:100%; height:100%; background:#f1f5f9; display:flex; align-items:center; justify-content:center;">
                <div style="padding:40px; color:#444; max-width:480px;">
                    <div style="font-size:16px; font-weight:700; margin-bottom:12px; display:flex; align-items:center; gap:8px;">
                        <i class="fa-solid fa-triangle-exclamation" style="color:#e11d48;"></i> 陦ｨ遉ｺ繧ｨ繝ｩ繝ｼ
                    </div>
                    <div style="font-size:13px; color:#64748b; line-height:1.6; margin-bottom:16px;">${this.escapeHtml(message)}</div>
                    ${fallbackHref ? `<a href="${this.escapeHtml(fallbackHref)}" target="_blank" style="color:var(--color-primary); font-size:13px; font-weight:600;">蜈・・雉・侭繧堤峩謗･髢九￥ <i class="fa-solid fa-external-link"></i></a>` : ''}
                </div>
                </div>
            `;
        } else {
            container.innerHTML = `
                <div style="width:min(760px, 100%); margin:40px auto; background:#fff; border:1px solid #e5e7eb; border-radius:18px; box-shadow:0 16px 40px rgba(15,23,42,0.08); padding:56px 40px; text-align:center;">
                    <div style="width:64px; height:64px; margin:0 auto 18px; border-radius:20px; background:#fef2f2; color:#c53030; display:flex; align-items:center; justify-content:center; font-size:28px;">
                        <i class="fa-regular fa-file-pdf"></i>
                    </div>
                    <div style="font-size:18px; font-weight:700; color:#111827; margin-bottom:8px;">蜿悶ｊ霎ｼ繧薙□雉・侭繧定｡ｨ遉ｺ縺ｧ縺阪∪縺帙ｓ</div>
                    <div style="font-size:13px; color:#6b7280; line-height:1.8;">${this.escapeHtml(message)}</div>
                    ${fallbackHref ? `<div style="margin-top:18px;"><a href="${this.escapeHtml(fallbackHref)}" target="_blank" rel="noopener noreferrer" style="color:var(--color-primary); font-weight:600; text-decoration:none;">蜈・・雉・侭繧帝幕縺・/a></div>` : ''}
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
            const token = await getIdToken();
            const headers = token ? { Authorization: `Bearer ${token}` } : {};
            const response = await fetch(toApiUrl(`/contracts/${encodeURIComponent(contractId)}/original-file`), { headers });
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
        const token = await getIdToken();
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


    async renderOriginalForContract(app, contract, contractId) {
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

        if (preConvertedBlob) {
            const pdfObjectUrl = URL.createObjectURL(preConvertedBlob);
            this._objectUrls.push(pdfObjectUrl);
            this._currentDownloadUrl = pdfObjectUrl;
            await this.renderPdf(pdfObjectUrl, this._viewerContainer);
            return true;
        }

        if (pdfUrl) {
            await this.renderPdf(pdfUrl, this._viewerContainer);
            return true;
        }

        if (isDocx && runtimeDocxFile instanceof Blob) {
            await this.renderDocx(runtimeDocxFile, this._viewerContainer);
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
            return true;
        }

        if (hasTextFallback || contract.extracted_text) {
            // Even for text fallback, use a paginated A4 layout to match Word
            await this.renderTextFallback(contract, this._viewerContainer);
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
            dbService.init(); // 遒ｺ螳溘↓UID繧偵そ繝・ヨ縺吶ｋ
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
                console.error("Contract acquisition failed", contractId);
                Notify.error('螂醍ｴ・ョ繝ｼ繧ｿ縺瑚ｦ九▽縺九ｊ縺ｾ縺帙ｓ');
                await this.renderUnavailableDocument({}, this._viewerContainer, '螂醍ｴ・ョ繝ｼ繧ｿ縺瑚ｦ九▽縺九ｊ縺ｾ縺帙ｓ縺ｧ縺励◆縲・');
                return;
            }

            console.log('Initializing SignViewer for Contract:', contractId);
            this._app = app;
            this._isDashboardMode = true;
            this._contractId = contractId;
            this._contract = contract;
            window.signViewer = this; 
            
            this._viewMode = options.forceMode || 'revised';
            
            this.cleanupObjectUrls();
            this._activePage = 1;
            this._scale = 1.0;
            this._viewInitialized = false; 
            this._originalPageCount = null;
            this._editedContent = undefined;
            this._lastPreviewContent = '';
            this._lastSavedContent = undefined;
            this._editHistory = null;
            this._editHistoryIndex = 0;
            this._appliedChanges = new Set();
            this._sortedChanges = null;
            
            this._currentRequest = { 
                contract_id: contractId,
                document_snapshot: contract,
                ...contract 
            };

            // IDB persistence
            if (typeof app.getDocxFromIDB === 'function') await app.getDocxFromIDB(contractId);
            if (typeof app.getPdfFromIDB === 'function') await app.getPdfFromIDB(contractId);

            if (this._viewMode === 'original') {
                await this.renderOriginalForContract(app, contract, contractId);
            } else {
                await this.renderPdf(null, this._viewerContainer);
                await this.switchViewMode(this._viewMode);
            }

        } catch (e) {
            console.error("SignViewer.initForContract fatal error:", e);
            await this.renderUnavailableDocument(this._contract || {}, this._viewerContainer, e.message);
        } finally {
            if (typeof app.setLoading === 'function') {
                app.setLoading(false);
            }
        }
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
            if (e.target.closest('button, input, select, textarea, [contenteditable="true"]')) return;
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

    renderDashboardUI() {
        const isFS = document.querySelector('.analysis-v3-split-layout')?.classList.contains('is-fullscreen');
        const toolbar = document.getElementById('v3-viewer-toolbar');
        
        const total = Math.max(1, Number(this._totalPages || 1));
        console.log('[SignViewer] UI Update:', {
            mode: this._renderMode,
            pageCount: total,
            currentPage: this._activePage,
            thumbnailCount: document.querySelectorAll('.v3-thumbnail').length
        });

        if (toolbar) {
            const badgeColor = '#3b82f6';
            const activeTabStyle = `background:${badgeColor};color:#fff;box-shadow:0 1px 4px rgba(59,130,246,0.3);`;
            const inactiveTabStyle = 'background:transparent;color:#94a3b8;';
            toolbar.innerHTML = `
                <div style="display:flex; align-items:center; justify-content:space-between; background:#ffffff; border:none; border-radius:12px; padding:8px 24px; width:100%; margin: 8px 0 12px 0; box-shadow: 0 4px 12px rgba(0,0,0,0.08); min-height:48px; position:relative; box-sizing:border-box;">
                    
                    <!-- Left: Page Navigation & Zoom -->
                    <div style="display:flex; align-items:center; gap:24px; flex:1;">
                        <div style="display:flex; align-items:center; gap:8px;">
                            ${isFS ? `
                            <button class="v3-toolbar-btn-clean" onclick="window.app.toggleFullscreenViewer()" style="color:#1e293b; margin-right:8px; gap:6px; font-size:13px; font-weight:700;" title="戻る">
                                <i class="fa-solid fa-arrow-left"></i> 戻る
                            </button>
                            <div style="height:20px; width:1px; background:#e2e8f0; margin-right:8px;"></div>
                            ` : ''}
                            <button class="v3-toolbar-btn-clean" onclick="window.signViewer.setActivePage(${this._activePage - 1})" ${this._activePage <= 1 ? 'disabled style="color:#e2e8f0; cursor:default;"' : 'style="color:#94a3b8; cursor:pointer;"'}>
                                <i class="fa-solid fa-chevron-left" style="font-size:14px;"></i>
                            </button>
                            <span style="font-size:14px; font-weight:600; color:#1e293b; min-width:50px; text-align:center; font-family:'Inter', sans-serif;">
                                ${this._activePage} / ${total}
                            </span>
                            <button class="v3-toolbar-btn-clean" onclick="window.signViewer.setActivePage(${this._activePage + 1})" ${this._activePage >= total ? 'disabled style="color:#e2e8f0; cursor:default;"' : 'style="color:#94a3b8; cursor:pointer;"'}>
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

                    <!-- Middle: Tabs (Centered) -->
                    <div style="display:flex; align-items:center; background:#f1f5f9; border-radius:8px; padding:3px; gap:2px; flex-shrink:0;">
                        <button onclick="window.signViewer.switchViewMode('revised')" style="display:inline-flex;align-items:center;gap:5px;font-size:12px; font-weight:600; padding:4px 16px; border-radius:6px; border:none; cursor:pointer; transition:all 0.15s; ${this._viewMode === 'revised' ? activeTabStyle : inactiveTabStyle}"><i class="fa-regular fa-pen-to-square"></i> 修正案</button>
                        <button onclick="window.signViewer.switchViewMode('final')" style="display:inline-flex;align-items:center;gap:5px;font-size:12px; font-weight:600; padding:4px 16px; border-radius:6px; border:none; cursor:pointer; transition:all 0.15s; ${(this._viewMode === 'final' || this._viewMode === 'edit') ? activeTabStyle : inactiveTabStyle}"><i class="fa-regular fa-circle-check"></i> 最終版</button>
                    </div>

                    <!-- Right: Actions -->
                    <div style="display:flex; align-items:center; gap:8px; flex:1; justify-content:flex-end;">
                        ${this._viewMode === 'edit' ? `
                        <button onclick="window.signViewer._saveHandEdit()" style="background:#22c55e; color:#fff; border:none; padding:6px 14px; border-radius:8px; font-size:12px; font-weight:700; cursor:pointer; display:flex; align-items:center; gap:6px;">
                            <i class="fa-solid fa-floppy-disk"></i> 保存する
                        </button>
                        <div style="height:20px; width:1px; background:#e2e8f0;"></div>
                        ` : (this._viewMode === 'final' && this._finalGeneratedPdfUrl) ? `
                        <button onclick="window.signViewer._previewHandEdit()" style="display:inline-flex;align-items:center;gap:6px;background:#f8fafc;color:#0b2d62;border:1px solid #bfdbfe;padding:6px 14px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap;">
                            <i class="fa-solid fa-eye"></i> プレビュー
                        </button>
                        <button onclick="window.signViewer.switchViewMode('edit')" style="display:inline-flex;align-items:center;gap:6px;background:#0b2d62;color:#fff;border:none;padding:6px 18px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap;">
                            <i class="fa-solid fa-pen"></i> 編集する
                        </button>
                        <div style="height:20px; width:1px; background:#e2e8f0;"></div>
                        ` : ''}
                        <button class="v3-toolbar-btn-clean" onclick="window.signViewer.downloadPdf()" style="color:#64748b; cursor:pointer;" title="PDFダウンロード">
                            <i class="fa-solid fa-file-pdf" style="font-size:16px;"></i>
                        </button>
                        ${(this._originalFileUrl && isDocxFileName(this._originalFileName || this._originalFileUrl)) ? `
                        <button class="v3-toolbar-btn-clean" onclick="window.app.downloadOriginalFile()" style="color:#2b6cb0; cursor:pointer;" title="Word原本を保存">
                            <i class="fa-solid fa-file-word" style="font-size:16px;"></i>
                        </button>
                        ` : ''}
                         <button class="v3-toolbar-btn-clean" onclick="window.app.toggleFullscreenViewer()" style="color:#64748b; cursor:pointer;" title="${isFS ? '縮小' : '全画面'}">
                            <i class="fa-solid ${isFS ? 'fa-compress' : 'fa-expand'}" style="font-size:16px;"></i>
                        </button>
                    </div>
                </div>
                <style>
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
                        color: #1e293b !important;
                        transform: scale(1.1);
                    }
                    .v3-toolbar-btn-clean:active:not(:disabled) {
                        transform: scale(0.95);
                    }
                </style>
            `;
        }
        
        // 2. Update the thumbnails in the sidebar
        const sidebar = document.querySelector('.v3-viewer-sidebar');
        if (sidebar) {
            if (this._renderMode === 'image') {
                this.renderImageThumbnails(sidebar);
            } else {
                this.renderPdfThumbnails(sidebar);
            }
        }
    },

    renderPdfThumbnails(container) {
        let thumbHtml = '';
        const total = Math.max(1, Number(this._totalPages || 1));
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
