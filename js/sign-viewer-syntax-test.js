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
// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED
                    }
                } catch (e) {
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED
                </div>
                <div id="zoho-iframe-container" style="flex:1; width:100%; position:relative;">
                    <div class="loader-spinner" style="position:absolute; top:50%; left:50%; transform:translate(-50%, -50%);"></div>
// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED
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

// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED
            </span>
// MOJIBAKE CLEANED
            <div style="margin-left:auto;display:flex;gap:8px;align-items:center;">
                <button onclick="window.signViewer._previewRenderedFinal()" style="display:inline-flex;align-items:center;gap:6px;background:#f8fafc;color:#0b2d62;border:1px solid #bfdbfe;padding:6px 14px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;">
// MOJIBAKE CLEANED
                </button>
                <button onclick="window.signViewer._saveFinalTextOnly()" style="display:inline-flex;align-items:center;gap:6px;background:#0b2d62;color:#fff;border:none;padding:6px 18px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;">
// MOJIBAKE CLEANED
                </button>
            </div>
        `;
        bar.style.display = 'flex';
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
// MOJIBAKE CLEANED
    },

    _previewRenderedFinal() {
        const pdfLayer = document.getElementById('pdf-pages-container');
        const docxLayer = document.getElementById('sign-viewer-docx-pages');
        const activeLayer = docxLayer && docxLayer.style.display !== 'none'
            ? docxLayer
            : (pdfLayer && pdfLayer.style.display !== 'none' ? pdfLayer : null);

        if (!activeLayer) {
// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED
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

// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
            // ============================================================
// MOJIBAKE CLEANED
            console.log('[PDF TRIAGE] Total pages:', this._totalPages);

// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
                });

                if (isAbnormal) {
// MOJIBAKE CLEANED
                        page: pn, width: vp.width, height: vp.height,
// MOJIBAKE CLEANED
                        pdfUrl: this._currentPdfUrl,
                    });
                } else if (isNonA4) {
// MOJIBAKE CLEANED
                        page: pn, width: vp.width, height: vp.height,
                    });
                }
            }
            console.log('%c[PDF PAGE SIZE LOG]', 'background:#7c3aed;color:#fff;font-weight:bold;padding:2px 6px;border-radius:3px;', pageSizeSummary);
            console.log(
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
            );
            // ============================================================

            const isDash = this._isDashboardMode;


            this.cleanupPageObservers();
            pagesContainer.replaceChildren();

// MOJIBAKE CLEANED
            pagesContainer.style.display = 'block';
            pagesContainer.style.textAlign = 'center';
            pagesContainer.style.width = '100%';
            pagesContainer.style.maxWidth = '100%';
            pagesContainer.style.transform = 'none';
            pagesContainer.style.padding = '24px 0';
            pagesContainer.style.boxSizing = 'border-box';
            pagesContainer.style.margin = '0 auto';

// MOJIBAKE CLEANED
            await new Promise(requestAnimationFrame);
            await new Promise(requestAnimationFrame);

// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED
            });

            const renderedNodes = document.createDocumentFragment();
            const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);

            for (let pageNum = 1; pageNum <= this._totalPages; pageNum++) {
                const page = await pdf.getPage(pageNum);

// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED
                canvas.width = Math.floor(viewport.width * pixelRatio);
                canvas.height = Math.floor(viewport.height * pixelRatio);
// MOJIBAKE CLEANED
                canvas.style.cssText = `display:block;width:${viewport.width}px;height:${viewport.height}px;`;

                const context = canvas.getContext('2d', { alpha: false });
// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED
                    <span style="font-size:9px; font-weight:600; opacity:0.88;">${this.escapeHtml(recipientLabel)}</span>
                </div>
            ` : `
                <div>
// MOJIBAKE CLEANED
                    <div style="font-size:10px; font-weight:600; opacity:0.9;">${this.escapeHtml(recipientLabel)}</div>
// MOJIBAKE CLEANED
                </div>
            `;

            overlay.appendChild(marker);
        });

        return overlay;
    },

    setActivePage(page) {
        const editorScroll = document.getElementById('v3-editor-scroll');
        const pageTotal = (this._isDashboardMode && (this._viewMode === 'final' || this._viewMode === 'edit') && editorScroll)
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
            if ((this._viewMode === 'final' || this._viewMode === 'edit') && editorScroll) {
                const targetPage = editorScroll.querySelector(`.v3-editor-page[data-page="${nextPage}"]`);
                if (targetPage) {
                    this._scrollElementToChild(editorScroll, targetPage, { behavior: 'smooth' });
                }
                this.renderDashboardUI();
                this.renderPageSwitcher();
                return;
            }

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
                    this._scrollViewerToPage(targetPage, { behavior: 'smooth' });
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
        if (mode !== 'final') {
            this._finalLayoutGuardActive = false;
        }
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
            if (editLayer) {
                editLayer.style.display = 'block';
                await this.renderHandEditMode(container);
            }
        } else {
// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED
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
        console.warn('[SignViewer] Applied change text not found; skipped unsafe bottom append.', { index });
// MOJIBAKE CLEANED
        return finalText;
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

// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED
            .split(/\s+/)
// MOJIBAKE CLEANED
            .filter(token => token.length >= 2)));

        let score = 0;
        for (const keyword of keywords) {
            if (haystack.includes(keyword.replace(/\s+/g, ''))) score += keyword.length;
        }

// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
    },

    _buildLegalInsertionText(change) {
        const newText = this._getChangeNewText(change);
        if (!newText) return '';

// MOJIBAKE CLEANED
        let raw = String(newText)
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n')
            .replace(/[^\S\n]+/g, ' ')   // collapse spaces/tabs but NOT newlines
            .trim();

        if (!raw) return '';

        // Strip AI meta-commentary that must not appear in the document
        raw = raw
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
            .trim();

        const synthesized = this._synthesizeUsableLegalClause(change, raw);
        if (synthesized) return synthesized;

        // If the AI already produced proper clause text, use it directly.
// MOJIBAKE CLEANED

        // Hardcoded high-quality fallbacks for known clause patterns
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
        }
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
        }
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
        }

        // Generic: ensure ends with proper legal punctuation
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
    },

    _looksLikeLegalCommentary(text) {
        const value = String(text || '').trim();
        if (!value) return false;
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
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

// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
            }
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
            }
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
            }
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
            }
// MOJIBAKE CLEANED
        }

// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
        }

// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED
        if (!match) return '';
        const raw = match[1];
// MOJIBAKE CLEANED
        const numberPattern = /^[0-9]+$/.test(normalized)
            ? normalized.split('').map(digit => `[${digit}${String.fromCharCode(digit.charCodeAt(0) + 0xFEE0)}]`).join('\\s*')
            : this._escapeRegex(raw);
// MOJIBAKE CLEANED
    },

    _parseArticleBlocksFromText(text) {
        const value = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
// MOJIBAKE CLEANED
        const headings = [];
        let match;
        while ((match = headingRegex.exec(value)) !== null) {
            const start = match.index + match[1].length;
            const heading = match[2].trim();
            headings.push({ start, heading });
        }
        return headings.map((item, index) => {
            const next = headings[index + 1];
            const end = next ? next.start : value.length;
            const raw = value.slice(item.start, end).trimEnd();
            return {
                heading: item.heading,
                start: item.start,
                end,
                text: raw
            };
        });
    },

    _scoreTextBlockForChange(blockText, change) {
        const haystack = String(blockText || '').replace(/\s+/g, '');
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
        const keywords = Array.from(new Set(String(source)
// MOJIBAKE CLEANED
            .split(/\s+/)
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
        let score = 0;
        keywords.forEach(keyword => {
            if (haystack.includes(keyword.replace(/\s+/g, ''))) score += keyword.length;
        });
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
        return score;
    },

    _getChangeRelevanceSource(change) {
        return [
            change?.section || '',
            change?.article || '',
            change?.title || '',
            change?.clause || '',
            change?.issue || '',
            change?.reason || '',
            change?.concern || '',
            change?.risk || '',
            change?.impact || '',
            this._getChangeNewText(change)
        ].join(' ');
    },

    _getChangeKeywordTokens(change) {
        const source = this._getChangeRelevanceSource(change);
        return Array.from(new Set(String(source)
// MOJIBAKE CLEANED
            .split(/\s+/)
// MOJIBAKE CLEANED
            .filter(token => token.length >= 2)
// MOJIBAKE CLEANED
    },

    _scoreInsertionSegment(segmentText, change) {
        const haystack = String(segmentText || '').replace(/\s+/g, '');
        if (!haystack) return 0;
        const oldText = this._getChangeOldText(change).replace(/\s+/g, '');
        if (oldText && haystack.includes(oldText)) return 1000 + oldText.length;

        const source = this._getChangeRelevanceSource(change);
        let score = 0;
        this._getChangeKeywordTokens(change).forEach(token => {
            const normalized = token.replace(/\s+/g, '');
            if (normalized && haystack.includes(normalized)) score += Math.min(24, normalized.length * 3);
        });
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
        return score;
    },

    _findInsertionPointInArticleBlock(text, block, change) {
        const source = String(text || '');
        const blockText = String(block?.text || '');
        if (!source || !block || !blockText) return null;
        const lineRegex = /[^\n]*(?:\n|$)/g;
        let match;
        let best = null;
        while ((match = lineRegex.exec(blockText)) !== null) {
            const rawLine = match[0];
            if (!rawLine) break;
            const line = rawLine.replace(/\n$/, '');
            if (!line.trim()) continue;
// MOJIBAKE CLEANED
            const score = this._scoreInsertionSegment(line, change);
            if (!best || score > best.score) {
                best = {
                    score,
                    start: block.start + match.index,
                    end: block.start + match.index + rawLine.length
                };
            }
        }
        if (best && best.score >= 35) return Math.min(best.end, source.length);
        return null;
    },

    _findTargetArticleBlockInText(text, change) {
        const blocks = this._parseArticleBlocksFromText(text);
        if (!blocks.length) return null;
        const anchorLabels = this._getChangeAnchorTexts(change);
        for (const anchor of anchorLabels) {
            const pattern = this._getArticleAnchorPattern(anchor);
            if (!pattern) continue;
            const regex = new RegExp(pattern);
            const hit = blocks.find(block => regex.test(block.heading));
            if (hit) return hit;
        }
        let best = null;
        for (const block of blocks) {
            const score = this._scoreTextBlockForChange(block.text, change);
            if (!best || score > best.score) best = { block, score };
        }
        return best && best.score >= 35 ? best.block : null;
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

    _getSortedAiChanges() {
        const contract = this._contract || {};
        const aiChangesRaw = Array.isArray(contract.ai_changes) ? contract.ai_changes.filter(Boolean) : [];
        const extractArticleNum = (change) => {
            const source = this._findArticleForChange(change) || String(change?.section || change?.article || '');
// MOJIBAKE CLEANED
            if (!match) return 9999;
// MOJIBAKE CLEANED
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

    _normalizeFinalLayoutText(text) {
        let normalized = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
        if (this._shouldRestoreDocxLineBreaks()) {
            normalized = this._restoreCollapsedDocxLineBreaks(normalized);
        }
        return normalized;
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
// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED

// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
                    next = next
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
                }

// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
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
            const strippedText = nextText.split(rawText).join('').replace(/\n{3,}/g, '\n\n').trim();
            const repairedText = this._insertAdditionalClauseIntoArticle(strippedText, change, legalText);
            if (repairedText !== strippedText) {
                nextText = repairedText;
                changed = true;
            }
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

    _applyChangeToText(text, change) {
        const oldText = this._getChangeOldText(change);
        const newText = this._buildLegalInsertionText(change);
        let nextText = String(text || '');
        const normalize = (s) => String(s || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\r\n/g, '\n').trim();
        const normOld = normalize(oldText);
        const normNew = normalize(newText);
        const normBase = normalize(nextText);

        if (!normNew) return nextText;

        if (normOld && normBase.includes(normOld)) {
            const escapedOld = this._escapeRegex(oldText).replace(/\s+/g, '\\s*');
            const exactRegex = new RegExp(escapedOld); 
            if (exactRegex.test(nextText)) {
                return nextText.replace(exactRegex, newText);
            }
            const normalizedReplace = this._replaceTextByNormalizedSlice(nextText, oldText, newText);
            if (normalizedReplace !== null) return normalizedReplace;
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
            const normalizedReplace = this._replaceTextByNormalizedSlice(nextText, oldText, newText);
            if (normalizedReplace !== null) return normalizedReplace;
        }

        if (!nextText.includes(newText)) {
            if (this._isAdditionChange(change)) {
                const inserted = this._insertAdditionalClauseIntoArticle(nextText, change, newText);
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
                const articleRegex = new RegExp("(^|\\n)([^\\n]*" + articlePattern + "[^\\n]*)(?=\\n|$)");
                if (articleRegex.test(nextText)) {
                    return nextText.replace(articleRegex, (match, prefix, line) => {
                        return prefix + line + "\n\n" + newText;
                    });
                }
            }
            const section = String(change?.section || change?.article || change?.title || '').trim();
            const displaySection = this._normalizeChangeSectionLabel(section);
            console.warn('[SignViewer] Change target not found; skipped unsafe bottom append.', {
                section: displaySection,
                hasOldText: Boolean(oldText),
                isAddition: this._isAdditionChange(change)
            });
            return nextText;
        }
        return nextText;
    },

    // --- Document style auto-detection --------------------------------------
    // Analyzes the document text and returns formatting rules so that
    // inserted clauses match the surrounding style regardless of which
    // document is imported.
    _detectDocumentStyle(text, articleContext) {
        const src = String(text || "");
        const lines = src.split("\n");
        const nonEmpty = lines.filter(l => l.trim());

// MOJIBAKE CLEANED
        const detectIndent = (l) => {
// MOJIBAKE CLEANED
            return m ? m[1] : "";
        };

        const contextLines = articleContext
            ? String(articleContext).split("\n").filter(l => l.trim())
            : nonEmpty;

        const indents = contextLines.map(detectIndent).filter(i => i.length > 0);
// MOJIBAKE CLEANED
        if (indents.length > 0) {
            const freq = {};
            indents.forEach(i => { freq[i] = (freq[i] || 0) + 1; });
            indentStr = Object.entries(freq).sort((a,b) => b[1]-a[1])[0][0];
        }

// MOJIBAKE CLEANED
        const bulletPatterns = [
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
        ];

        let dominantBullet = null;
        const bulletFreq = {};
        nonEmpty.forEach(l => {
            const hit = bulletPatterns.find(p => p.regex.test(l.trim()));
            if (hit) bulletFreq[hit.type] = (bulletFreq[hit.type] || 0) + 1;
        });
        const sortedBullets = Object.entries(bulletFreq).sort((a,b) => b[1]-a[1]);
        if (sortedBullets.length > 0) dominantBullet = sortedBullets[0][0];

// MOJIBAKE CLEANED
        const usesNumberedParagraphs = dominantBullet === "ideographic" || dominantBullet === "bracket";

// MOJIBAKE CLEANED
        let articleCount = 0, blankAfterArticle = 0;
        for (let i = 0; i < lines.length; i++) {
// MOJIBAKE CLEANED
                articleCount++;
                let j = i + 1;
                while (j < lines.length && lines[j].trim()) j++;
                if (j < lines.length && !lines[j].trim()) blankAfterArticle++;
            }
        }
        const usesBlankLineSeparation = articleCount === 0
            || blankAfterArticle / Math.max(articleCount, 1) >= 0.4;

// MOJIBAKE CLEANED
        let nextParagraphNumber = null;
        if (usesNumberedParagraphs) {
            const nums = nonEmpty
                .map(l => {
// MOJIBAKE CLEANED
                    return m ? m[1].charCodeAt(0) - 0xFF10 : null;
                })
                .filter(n => n !== null);
            if (nums.length) nextParagraphNumber = Math.max(...nums) + 1;
        }

        return {
            indentStr,
            dominantBullet,
            usesNumberedParagraphs,
            usesBlankLineSeparation,
            nextParagraphNumber
        };
    },

    _formatInsertionText(addition, style) {
        let lines = String(addition || "").split("\n");
// MOJIBAKE CLEANED

        if (style.usesNumberedParagraphs && style.nextParagraphNumber && style.nextParagraphNumber <= 9) {
            const num = String.fromCharCode(0xFF10 + style.nextParagraphNumber);
            lines = lines.map((l, i) => {
// MOJIBAKE CLEANED
                if (i > 0 && l.trim()) return "" + indent + l.trimStart();
                return l;
            });
        } else if (style.dominantBullet === "dot") {
// MOJIBAKE CLEANED
        } else if (style.indentStr) {
            lines = lines.map(l => l.trim() ? indent + l.trimStart() : l);
        }

        return lines.join("\n");
    },
    _insertAdditionalClauseIntoArticle(text, change, additionText) {
        const nextText = String(text || "");
        const addition = String(additionText || '').trim();
        if (!addition || nextText.includes(addition)) return nextText;

        const targetBlock = this._findTargetArticleBlockInText(nextText, change);
        if (!targetBlock) {
            console.warn('[SignViewer] Addition target article not found; skipped unsafe bottom append.', {
                section: change?.section || change?.article || change?.title || ''
            });
            return nextText;
        }

        const style = this._detectDocumentStyle(nextText, targetBlock.text || nextText.slice(0, 800));
        const formattedAddition = this._formatInsertionText(addition, style);
        const insertionPoint = this._findInsertionPointInArticleBlock(nextText, targetBlock, change);
        if (!insertionPoint) {
            console.warn('[SignViewer] Addition target paragraph not found; skipped unsafe article-end append.', {
                section: change?.section || change?.article || change?.title || ''
            });
            return nextText;
        }
        const before = nextText.slice(0, insertionPoint).trimEnd();
        const after = nextText.slice(insertionPoint).trimStart();
        return [before, formattedAddition, after].filter(Boolean).join('\n\n');
    },

    _collectEditorContent() {
        const richBodies = Array.from(document.querySelectorAll('#v3-editor-scroll .v3-rich-editor-body'));
        if (richBodies.length > 0) {
            // DEDUPLICATION: Join unique page contents to prevent 'Full Text x Page Count' bug
            const pageTexts = richBodies.map(body => {
                const blockTexts = Array.from(body.querySelectorAll(':scope > .v3-editor-block')).map(block => block.innerText || block.textContent || '');
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
// MOJIBAKE CLEANED
        };
        const isSubHeaderLine = (s) => {
            const t = String(s || '').trim();
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED
                const isTitle = index === firstNonEmptyIdx && !isIndented && trimmed.length < 40
// MOJIBAKE CLEANED
                const isArticle = !isIndented && isArticleLine(trimmed);
                const isSubHeader = !isIndented && isSubHeaderLine(trimmed);
                if (isTitle) {
                    style = 'text-align:center;font-weight:700;font-size:1.08em;margin:8px 0 6px;letter-spacing:0.1em;';
                } else if (isArticle) {
// MOJIBAKE CLEANED
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

    async _renderFinalEditorSurfaceHtml(text, targetPageCount = null) {
        const originalRawText = this._normalizeFinalLayoutText(this._getOriginalDocumentText());
        const pages = await this._paginateByDOMHeights(text, null);
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
            sourcePageCount: this._getOriginalPageCount(),
            renderedPageCount: pages.length,
            isCorrectionNeeded: (this._getOriginalPageCount() || 0) > pages.length
        });

        // [CLAUSE CHECK]
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED

        console.log('[CLAUSE CHECK]', {
            originalClauseCount: originalClauses.length,
            renderedClauseCount: renderedClauses.length,
            originalClauses: originalClauses.slice(0, 5),
            renderedClauses: renderedClauses.slice(0, 5)
        });

        // SAFETY STOP: If clauses are lost, stop rendering to prevent legal liability
        if (renderedClauses.length < originalClauses.length && text.length > 100) {
            console.error('[SAFETY STOP] Clause mismatch detected!', { original: originalClauses.length, rendered: renderedClauses.length });
            return `
                <div style="padding:40px; text-align:center; background:#fff1f0; border:1px solid #ffa39e; border-radius:8px; margin:40px; color:#cf1322;">
                    <i class="fa-solid fa-triangle-exclamation" style="font-size:32px; margin-bottom:16px;"></i>
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
                </div>
            `;
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

        if (pages.length === 1 && this._needsMinimumTwoFinalPages(text)) {
            console.warn('[FINAL PAGE SPLIT WARNING] Long document produced only 1 page. Forcing fallback split.', {
                textLength: text.length,
                lineCount: String(text || '').split('\n').length
            });
            return this._renderFallbackPages(text);
        }

        this._totalPages = pages.length;
        return pages.map((pageLines, pageIndex) => `
            <div class="v3-editor-page final-contract-page ${pageIndex > 0 ? 'is-continuation-page' : ''}" data-page="${pageIndex + 1}">
                <div class="final-contract-page-body v3-rich-editor-body"
                     contenteditable="true"
                     spellcheck="true"
                     oninput="window.signViewer._onRichEditorInput(this)"
                     onkeydown="window.signViewer._onRichEditorKeyDown(event, this)"
                     onblur="window.signViewer._onRichEditorBlur(this)">${this._renderStructuredBlocks(pageLines, { markApplied: true })}</div>
            </div>
        `).join('');
    },

    _renderFallbackPages(text) {
        const lines = String(text || '').split('\n');
        const mid = Math.floor(lines.length / 2);
        const pages = [lines.slice(0, mid), lines.slice(mid)];
        this._totalPages = 2;
        return pages.map((pageLines, pageIndex) => `
            <div class="v3-editor-page final-contract-page ${pageIndex > 0 ? 'is-continuation-page' : ''}" data-page="${pageIndex + 1}">
                <div class="final-contract-page-body v3-rich-editor-body"
                     contenteditable="true"
                     spellcheck="true"
                     oninput="window.signViewer._onRichEditorInput(this)"
                     onkeydown="window.signViewer._onRichEditorKeyDown(event, this)"
                      onblur="window.signViewer._onRichEditorBlur(this)">${this._renderStructuredBlocks(pageLines, { markApplied: true })}</div>
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
            return [
                ...sourcePages,
                ...Array.from({ length: target - sourcePages.length }, () => [' '])
            ];
        }

        const preserved = sourcePages.slice(0, Math.max(0, target - 1));
        const mergedTail = sourcePages.slice(Math.max(0, target - 1)).flat();
        return [...preserved, mergedTail].map(page => page.length ? page : [' ']);
    },

    _resolveFinalTargetPageCount(text, targetPageCount = null) {
        const target = Number.isFinite(Number(targetPageCount)) && Number(targetPageCount) > 0
            ? Math.max(1, Math.round(Number(targetPageCount)))
            : null;
        if (target && target > 1) return target;
        if (this._needsMinimumTwoFinalPages(text)) return 2;
        return target;
    },

    _needsMinimumTwoFinalPages(text) {
        const normalized = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const lines = normalized.split('\n');
        const nonEmptyLines = lines.map(line => line.trim()).filter(Boolean);
// MOJIBAKE CLEANED
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
                margin-bottom:28px;
                text-align:center;
                font-size:22px;
                font-weight:700;
                letter-spacing:.04em;
                color:#000;
            }
            #${measurementId} .v3-editor-block.type-heading {
                margin-bottom:6px;
                font-weight:700;
                font-size:14.5px;
                color:#000;
            }
            #${measurementId} .v3-editor-block.type-list {
                margin-left:2em;
                text-indent:-1em;
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
            font-family: 'Noto Sans JP', sans-serif;
            font-size: 13.5px;
            line-height: 1.25;
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
        document.body.appendChild(measureContainer);

        const lines = String(text || '').split('\n');
        measureContainer.innerHTML = this._renderStructuredBlocks(lines);
        
        void measureContainer.offsetHeight;

        const pages = [[]];
        let currentHeight = 0;
        const blocks = Array.from(measureContainer.children);
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

            let safeH = totalH > 0 ? totalH : (this._getFinalEditorFontSize() * 2.0);
            // Add a tighter safety buffer for better page count accuracy
            safeH = Math.ceil(safeH * 1.05);

            if (safeH < 30) {
                safeH = this._getFinalEditorFontSize() * 2.5; // Guaranteed minimum
            }
            
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

        document.body.removeChild(measureContainer);
        measurementStyle.remove();



        return pages;
    },

    _getAppliedChangeHighlightSnippets() {
        const changes = (this._sortedChanges && this._sortedChanges.length)
            ? this._sortedChanges
            : this._getSortedAiChanges();
        const applied = this._getStoredAppliedChangeIndexes();
        const snippets = [];
        changes.forEach((change, index) => {
            if (!applied.has(index)) return;
            String(this._buildLegalInsertionText(change) || '')
                .split('\n')
                .map(line => line.trim())
                .filter(line => line.length >= 2)
                .forEach(line => snippets.push(line));
        });
        return Array.from(new Set(snippets)).sort((a, b) => b.length - a.length);
    },

    _markAppliedSnippetInEscapedLine(escapedLine, snippets) {
        let html = escapedLine;
        const justAppliedHead = this._justAppliedSnippet
            ? String(this._justAppliedSnippet).trim().split('\n')[0].trim()
            : '';
        snippets.forEach(snippet => {
            const escapedSnippet = this.escapeHtml(snippet);
            if (!escapedSnippet || !html.includes(escapedSnippet)) return;
            const isPulse = justAppliedHead && (snippet.includes(justAppliedHead) || justAppliedHead.includes(snippet));
            const cls = isPulse ? 'v3-applied-change v3-applied-change-pulse' : 'v3-applied-change';
            html = html.split(escapedSnippet).join(`<span class="${cls}">${escapedSnippet}</span>`);
        });
        return html;
    },

    _renderStructuredBlocks(lines, options = {}) {
        const totalLines = lines.length;
        const appliedSnippets = options.markApplied ? this._getAppliedChangeHighlightSnippets() : [];
        let titleCount = 0;
        return lines.map((line, idx) => {
            const block = this._parseBlockType(line, idx, totalLines);
            if (block.type === 'title') {
                if (titleCount > 0) block.type = 'body';
                titleCount++;
            }
            // LOSSLESS: Use original line content. Replace empty lines with a space for HTML layout stability.
            const escapedContent = this.escapeHtml(line === '' ? ' ' : line);
            const content = appliedSnippets.length
                ? this._markAppliedSnippetInEscapedLine(escapedContent, appliedSnippets)
                : escapedContent;
            return `<div class="v3-editor-block type-${block.type}">${content}</div>`;
        }).join('');
    },

    _parseBlockType(line, index, totalLines) {
        const s = line.trim();
        if (!s) return { type: 'body', text: line };

        // 1. Title (Only allow at the very top, first few lines)
// MOJIBAKE CLEANED
            // Check if we already have a title
            return { type: 'title', text: line };
        }
        // 2. Heading (Clause Numbers)
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
        
        if (isClause || isStandaloneHeader) {
            return { type: 'heading', text: line };
        }
        // 3. Lists
// MOJIBAKE CLEANED
            return { type: 'list', text: line };
        }
        // 4. Signature
// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
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
        let nextText = this._isFinalEditorVisible() ? this._collectEditorContent() : this._ensureEditedContent();
        const before = nextText;
        changes.forEach(c => { nextText = this._revertChangeInText(nextText, c); });
        if (nextText === before) {
// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED
        };
        const _isSubH = (s) => {
            const t = String(s || '').trim();
// MOJIBAKE CLEANED
        };
        const _lineWeight = (line, idx) => {
            const plain = String(line || '').replace(/\x00\/?REV\x00/g, '');
            const trimmed = plain.trim();
            if (!trimmed) return 0.5;
            const wrapLines = Math.max(1, Math.ceil(plain.length / charsPerLine));
            let extra = 0.5; // Body margin
// MOJIBAKE CLEANED
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
            originalText = this._getOriginalDocumentText(),
            showPageNumbers = false,
            targetPageCount = null
        } = options;
        const originalLines = new Set(String(originalText || '').split('\n').map(line => line.trim()).filter(Boolean));
        const { charsPerLine, linesPerPage } = this._calcPageLayout();
        const effectiveTargetPageCount = this._resolveFinalTargetPageCount(text, targetPageCount);
        const pages = this._paginateDocumentText(text, charsPerLine, linesPerPage, effectiveTargetPageCount);
        let blockIndex = 0;

        const renderLine = (line) => {
            const raw = String(line || '');
            const clean = raw.replace(/\x00REV\x00|\x00\/REV\x00/g, '');
            const trimmed = clean.trim();
// MOJIBAKE CLEANED
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
                    font-family:'Noto Sans JP', sans-serif;
                    font-size:14px;
                    line-height:1.3;
                    color:#222;
                    position:relative;
                    overflow:hidden !important;
                    flex:0 0 auto;
                    break-after:page;
                    page-break-after:always;
                    display: block !important;
                    visibility: visible !important;
                    opacity: 1 !important;
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

                .v3-rich-editor-body { 
                    min-height:930px; outline:none; white-space:pre-wrap; 
                    padding: 0 !important; margin: 0 !important;
                    overflow-wrap:anywhere; word-break:normal; overflow:visible; cursor:text; 
                    line-height:1.25 !important; font-size:13.5px !important; font-family:'Noto Sans JP', sans-serif; 
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
                
                .v3-editor-block.type-title {
                    margin-top: 8px;
                    margin-bottom: 28px;
                    text-align: center;
                    font-size: 22px;
                    font-weight: 700;
                    letter-spacing: .04em;
                    color: #000;
                }
                
                .v3-editor-block.type-heading {
                    margin-bottom: 6px;
                    font-weight: 700;
                    font-size: 14.5px;
                    color: #000;
                }

                .v3-editor-block.type-list {
                    margin-left: 2em;
                    text-indent: -1em;
                    margin-bottom: 3px;
                }

                .v3-editor-block.type-signature {
                    margin-top: 40px;
                    text-align: right;
                }

                .v3-applied-change { background:#bbf7d0; border:1px solid #22c55e; border-bottom:2px solid #16a34a; border-radius:4px; padding:1px 3px; box-shadow:0 0 0 1px rgba(34,197,94,.12); box-decoration-break:clone; -webkit-box-decoration-break:clone; }
                .v3-applied-change-pulse {
                    animation: v3-pulse-highlight 2s ease-out infinite;
                    background: #fef08a !important; 
                    border-bottom: 2px solid #eab308 !important;
                }
                @keyframes v3-pulse-highlight {
                    0% { box-shadow: 0 0 0 0 rgba(234, 179, 8, 0.4); }
                    70% { box-shadow: 0 0 0 10px rgba(234, 179, 8, 0); }
                    100% { box-shadow: 0 0 0 0 rgba(234, 179, 8, 0); }
                }

                .v3-editor-toolbar { position:sticky; top:0; z-index:100; display:flex; align-items:center; flex-wrap:wrap; gap:6px; padding:8px 12px; border:none; border-radius:12px; flex-shrink:0; background:#fff; color:#374151; width:calc(100% - 32px) !important; max-width:none !important; margin:0 auto 2px auto !important; box-sizing:border-box !important; box-shadow:0 4px 12px rgba(0,0,0,0.08); min-height:48px; overflow-x:visible; }
                .v3-editor-toolbar button { padding:5px 10px; border-radius:6px; font-size:12px; cursor:pointer; border:1px solid #e5e7eb; background:#f9fafb; color:#374151; white-space:nowrap; transition: all 0.2s; }
                .v3-editor-toolbar button:hover { background:#f3f4f6; border-color: #d1d5db; }
                .v3-editor-toolgroup { display:inline-flex; align-items:center; gap:3px; padding-right:8px; border-right:1px solid #e5e7eb; flex-shrink:0; }
                .v3-editor-toolbar-row { display:flex; align-items:center; gap:10px; width:100%; min-width:0; }
                .v3-editor-main-tools { display:inline-flex; gap:6px; align-items:center; min-width:0; flex:1 1 auto; flex-wrap:nowrap; justify-content:flex-start; overflow:hidden; }
                .v3-editor-right-actions { display:inline-flex; align-items:center; gap:8px; margin-left:auto; flex-shrink:0; }
                .v3-editor-save-btn {
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
                    transition: all 0.2s;
                }
                .v3-editor-save-btn:hover { background: #08234e !important; box-shadow: 0 6px 14px rgba(11,45,98,0.24); }
                
                .v3-editor-icon-btn { width:32px; height:32px; padding:0 !important; display:inline-flex; align-items:center; justify-content:center; }
                .v3-editor-select { height:32px; border:1px solid #e5e7eb; border-radius:6px; background:#fff; padding:0 8px; color:#374151; font-size:12px; cursor: pointer; transition: all 0.2s; }
                .v3-editor-select:hover { border-color: #d1d5db; background: #f9fafb; }
                .v3-editor-select.is-style { width:76px; }
                .v3-editor-select.is-size { width:68px; }

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
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
            };
        }
        if (fileName.endsWith('.pdf') || sourceType.includes('pdf')) {
            if (rawTextLength < 80) {
                return {
                    level: 'ocr',
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
                };
            }
            return {
                level: 'medium',
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
            };
        }
        return {
            level: 'plain',
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
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

        const changes = this._sortedChanges || this._getSortedAiChanges();
        let expectedText = this._getOriginalDocumentText();
        revisions
            .map(revision => Number(revision.index))
            .filter(Number.isInteger)
            .sort((a, b) => a - b)
            .forEach(index => {
                const change = changes[index];
                if (change) expectedText = this._applyChangeToText(expectedText, change);
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
// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED
                            ${details ? `<div style="margin-top:12px;display:inline-flex;align-items:center;gap:8px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:999px;padding:5px 12px;font-size:12px;font-weight:700;color:#334155;">${this.escapeHtml(details)}</div>` : ''}
                            <div style="display:flex;gap:10px;margin-top:22px;flex-wrap:wrap;justify-content:flex-end;">
                                <button onclick="window.signViewer.recoverFinalLayoutGuard()" style="display:inline-flex;align-items:center;gap:6px;background:#fff;color:#0b2d62;border:1px solid #bfdbfe;border-radius:8px;padding:8px 14px;font-size:13px;font-weight:800;cursor:pointer;">
// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED
                return false;
            }
            this._finalRecoveredFromOriginal = true;
            this._lastRecoveredFinalContent = this._getFinalDocumentText();
        } catch (error) {
            console.warn('[SignViewer] Original reload after final guard failed:', error);
// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED
            };
        }

        await this._ensureOriginalPageCount();
        const originalPageCount = this._getOriginalPageCount();
        const generatedPageCount = await this._getPdfBlobPageCount(generated.blob);
        if (originalPageCount && generatedPageCount && originalPageCount !== generatedPageCount) {
            return {
                blob: null,
// MOJIBAKE CLEANED
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

    async renderHandEditMode(container, contentOverride = null) {
        const contract = this._contract || {};
        const originalText = this._getOriginalDocumentText();
        const initialContent = contentOverride !== null && contentOverride !== undefined
            ? String(contentOverride)
            : this._getFinalDocumentText();
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
        const appliedIndexes = this._getAppliedChangeIndexesFromFinal(initialContent);
        this._appliedChanges = appliedIndexes;
        const appliedCount = appliedIndexes.size;

        const editLayer = document.getElementById('v3-edit-layer');
        if (!editLayer) return;
        const editorFontSize = this._getFinalEditorFontSize();
        const surfaceHtml = await this._renderFinalEditorSurfaceHtml(initialContent, null);
        this._lastRenderedContent = initialContent;
        this._lastSavedContent = initialContent;
        this._editedContent = initialContent;

        editLayer.innerHTML = `
            ${this._getDocumentLayoutCss()}
            <div style="width:100%;height:100%;display:flex;flex-direction:column;overflow:visible !important;">
                <div class="v3-editor-toolbar">
                    <div class="v3-editor-toolbar-row">
                        <div class="v3-editor-main-tools">
                        <span class="v3-editor-toolgroup">
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
                        </span>
                        <span class="v3-editor-toolgroup">
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
                            </select>
// MOJIBAKE CLEANED
                        </span>
                        <span class="v3-editor-toolgroup">
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
                        </span>
                        <span class="v3-editor-toolgroup">
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
                        </span>
                        <span class="v3-editor-toolgroup">
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
                        </span>
                        <span class="v3-editor-toolgroup">
// MOJIBAKE CLEANED
                        </span>
                        <span class="v3-editor-toolgroup">
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
                        </span>
                        </div>
                        <div class="v3-editor-right-actions">
                        <button onclick="window.signViewer._previewHandEdit()" style="display:inline-flex;align-items:center;gap:6px;background:#f8fafc;color:#0b2d62;border:1px solid #bfdbfe;font-weight:700;">
// MOJIBAKE CLEANED
                        </button>
                        <button onclick="window.signViewer._saveHandEdit()" class="v3-editor-save-btn">
// MOJIBAKE CLEANED
                        </button>
                        </div>
                    </div>
                </div>
                <!-- _renderFinalGenerationNotice removed -->
                <div class="v3-document-scroll-area" id="v3-editor-scroll" style="overflow:auto !important; height:auto !important; max-height:none !important;">
                    <div id="v3-editor-content-container" class="v3-document-page-stack" style="display:flex; flex-direction:column; gap:24px; overflow:visible !important;">
                        ${surfaceHtml}
                    </div>
                </div>
            </div>
        `;

        console.log('[FINAL PAGE DOM]', {
            domPageCount: document.querySelectorAll('.final-contract-page').length,
            htmlLength: editLayer.innerHTML.length
        });

        setTimeout(() => {
            console.log('[FINAL PAGE DOM AFTER 100MS]', {
                domPageCount: document.querySelectorAll('.final-contract-page').length,
                visiblePageCount: [...document.querySelectorAll('.final-contract-page')]
                    .filter(el => el.offsetHeight > 0 && getComputedStyle(el).display !== 'none').length
            });
        }, 100);

        this.renderDashboardUI();

        const scrollArea = document.getElementById('v3-editor-scroll');
        if (scrollArea) scrollArea.style.cursor = 'default';
        this._bindFinalEditorToolbar();
        this._bindScrollSync();
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

    async _getOriginalDocxFileForFinal() {
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

        return originalFile instanceof Blob ? originalFile : null;
    },

    async _generateOriginalDocxPdf() {
        const serviceUrl = (typeof window !== 'undefined' && window.__DOCX_PDF_SERVICE_URL__)
            ? String(window.__DOCX_PDF_SERVICE_URL__).replace(/\/$/, '')
            : '';
// MOJIBAKE CLEANED

        const originalFile = await this._getOriginalDocxFileForFinal();
// MOJIBAKE CLEANED

        const formData = new FormData();
        formData.append('file', originalFile, originalFile.name || 'original.docx');

        const resp = await fetch(`${serviceUrl}/api/convert/docx-to-pdf`, {
            method: 'POST',
            body: formData,
            signal: AbortSignal.timeout(120_000)
        });
// MOJIBAKE CLEANED
        const contentType = resp.headers.get('content-type') || '';
// MOJIBAKE CLEANED
        return { blob: await resp.blob(), reason: '' };
    },

    async _generateFinalDocxPdf(finalContent = this._getFinalDocumentText()) {
        const serviceUrl = (typeof window !== 'undefined' && window.__DOCX_PDF_SERVICE_URL__)
            ? String(window.__DOCX_PDF_SERVICE_URL__).replace(/\/$/, '')
            : '';
// MOJIBAKE CLEANED

        const originalFile = await this._getOriginalDocxFileForFinal();
// MOJIBAKE CLEANED

        const revisions = this._buildFinalDocxRevisions(finalContent);
// MOJIBAKE CLEANED

        const formData = new FormData();
        formData.append('file', originalFile, originalFile.name || 'original.docx');
        formData.append('revisions', JSON.stringify(revisions));

        const resp = await fetch(`${serviceUrl}/api/convert/final-docx-to-pdf`, {
            method: 'POST',
            body: formData,
            signal: AbortSignal.timeout(120_000)
        });
// MOJIBAKE CLEANED
        const contentType = resp.headers.get('content-type') || '';
// MOJIBAKE CLEANED
        return { blob: await resp.blob(), reason: '' };
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
            this._ensureLegalEditSafetyTools(toolbar);
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
        this._applyLegalEditViewOptions();
    },

    _ensureLegalEditSafetyTools(toolbar) {
        if (!toolbar || toolbar.querySelector('[data-legal-edit-tools="true"]')) return;
        this._ensureLegalEditSafetyStyles();
        const host = toolbar.querySelector('.v3-editor-right-actions');
        if (!host) return;
        const group = document.createElement('span');
        group.className = 'v3-editor-toolgroup v3-legal-edit-controls';
        group.dataset.legalEditTools = 'true';
        if (!this._finalEditorLineHeight) this._finalEditorLineHeight = '1.5';
        if (!this._finalEditorMarginMode) this._finalEditorMarginMode = 'standard';
        group.innerHTML = `
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
            </select>
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
            </select>
        `;
        host.insertBefore(group, host.firstElementChild);
    },

    _ensureLegalEditSafetyStyles() {
        if (document.getElementById('v3-legal-edit-safety-styles')) return;
        const style = document.createElement('style');
        style.id = 'v3-legal-edit-safety-styles';
        style.textContent = `
            .v3-editor-toolbar .v3-legal-edit-controls {
                border-right:0;
                margin-left:2px;
                margin-right:10px;
                padding-right:0;
                gap:6px;
            }
            .v3-editor-toolbar .v3-legal-edit-controls .v3-editor-select { padding-left:7px; padding-right:18px; box-sizing:border-box; }
            .v3-editor-toolbar .v3-legal-line-height-select { width:96px; }
            .v3-editor-toolbar .v3-legal-margin-select { width:84px; }
            #v3-editor-scroll.v3-a4-locked { overflow-x:hidden !important; }
            #v3-editor-scroll.v3-a4-locked #v3-editor-content-container { max-width:794px !important; width:794px !important; }
            #v3-editor-scroll[class*="v3-margin-mode-"] { overflow-x:hidden !important; }
            #v3-editor-scroll.v3-margin-mode-standard .final-contract-page { padding-left:72px !important; padding-right:72px !important; }
            #v3-editor-scroll.v3-margin-mode-wide .final-contract-page { padding-left:92px !important; padding-right:92px !important; }
            #v3-editor-scroll.v3-margin-mode-print .final-contract-page { padding-left:82px !important; padding-right:82px !important; }
            #v3-editor-scroll.v3-margin-mode-signature .final-contract-page { padding-left:72px !important; padding-right:104px !important; }
            #v3-editor-scroll[class*="v3-margin-mode-"] .final-contract-page::before {
                content:""; position:absolute; inset:96px 72px; border:1px dashed rgba(37,99,235,.45);
                pointer-events:none; z-index:4; box-sizing:border-box;
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
        this._setFinalEditorLineHeight(this._finalEditorLineHeight || '1.5', { quiet: true });
    },

    _setFinalEditorLineHeight(value, options = {}) {
        const allowed = ['1.0', '1.5', '1.8', '2.0'];
        const next = allowed.includes(String(value)) ? String(value) : '1.5';
        this._finalEditorLineHeight = next;
        document.querySelectorAll('#v3-editor-scroll .v3-rich-editor-body, #v3-editor-scroll .v3-editor-block').forEach(el => {
            el.style.lineHeight = next;
        });
        if (!options.quiet) {
            this._markEditorUnsaved();
// MOJIBAKE CLEANED
        }
    },

    _setFinalEditorMarginMode(value, options = {}) {
        const allowed = ['standard', 'wide', 'print', 'signature'];
        this._finalEditorMarginMode = allowed.includes(String(value)) ? String(value) : 'standard';
        this._applyLegalEditViewOptions();
// MOJIBAKE CLEANED
    },

    _toggleA4Lock() {
        this._a4LockEnabled = !this._a4LockEnabled;
        this._applyLegalEditViewOptions();
// MOJIBAKE CLEANED
    },

    _insertNewClauseAtCursor() {
        const editor = this._focusFinalEditor();
        if (!editor) return;
        this._restoreEditorSelection();
        const text = this._collectEditorContent();
        let max = 0;
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
            if (Number.isFinite(n)) max = Math.max(max, n);
            return _;
        });
// MOJIBAKE CLEANED
        document.execCommand('insertText', false, insertion);
        this._onRichEditorInput(editor);
        this._saveEditorSelection();
// MOJIBAKE CLEANED
    },

    _renumberArticleHeadings() {
        const current = this._collectEditorContent();
        let index = 0;
// MOJIBAKE CLEANED
            index += 1;
// MOJIBAKE CLEANED
        });
        if (next === current) {
// MOJIBAKE CLEANED
            return;
        }
        this._editedContent = next;
        this._editedHtml = '';
        this._pushHistory(next);
        this._markEditorUnsaved();
        this.renderHandEditMode(this._viewerContainer, next);
// MOJIBAKE CLEANED
    },

    _checkWordCompatibility() {
        const scroll = document.getElementById('v3-editor-scroll');
        const pages = Array.from(document.querySelectorAll('#v3-editor-scroll .final-contract-page'));
        const warnings = [];
        pages.forEach((page, i) => {
            const body = page.querySelector('.v3-rich-editor-body');
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
        });
// MOJIBAKE CLEANED
        if (warnings.length) {
            console.warn('[Word compatibility check]', warnings);
// MOJIBAKE CLEANED
        } else {
            console.warn('[Word compatibility check] no warnings');
// MOJIBAKE CLEANED
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
        // Only push if different from current history point
        if (current && current !== this._editHistory[this._editHistoryIndex]) {
            this._pushHistory(current);
        }
        this._editedContent = current;
        this._editedHtml = this._collectEditorHtml();
        this._syncUndoRedoButtons();
    },

    _markEditorUnsaved() {
        const toolbarBadge = document.querySelector('.v3-status-badge');
        if (toolbarBadge && !toolbarBadge.classList.contains('unsaved')) {
            toolbarBadge.classList.add('unsaved');
            toolbarBadge.style.background = '#fef3c7';
            toolbarBadge.style.color = '#d97706';
// MOJIBAKE CLEANED
        }
    },

    _onRichEditorInput(el) {
        this._markEditorUnsaved();
        if (this._manualFinalExtraPages) this._manualFinalExtraPages = 0;
        this._editedContent = this._collectEditorContent();
        this._editedHtml = this._collectEditorHtml();
        
        // Debounce both history capture and re-pagination
        if (this._repaginateTimeout) clearTimeout(this._repaginateTimeout);
        this._repaginateTimeout = setTimeout(() => {
            if (this._isRepaginating) return;
            this._captureCurrentEditForHistory(); // Capture to history before repagination
            this._repaginateEditor();
        }, 1500);
        
        this._syncUndoRedoButtons();
    },

    async _repaginateEditor() {
        if (this._viewMode !== 'edit' && this._viewMode !== 'final') return;
        const scrollArea = document.getElementById('v3-editor-scroll');
        if (!scrollArea) return;

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
        if (currentContent === this._lastRenderedContent) {
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
        const currentContent = this._collectEditorContent();
        this._manualFinalExtraPages = Math.max(0, Number(this._manualFinalExtraPages || 0)) + 1;
        this._editedContent = currentContent;
        this._markEditorUnsaved();
        this.renderHandEditMode(this._viewerContainer, currentContent).then(() => {
            const pages = Array.from(document.querySelectorAll('#v3-editor-scroll .v3-rich-editor-body'));
            const last = pages[pages.length - 1];
            if (last) {
                last.focus();
                this._setCursorAtEnd(last);
                last.scrollIntoView({ block: 'center', behavior: 'smooth' });
            }
        });
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

    _onRichEditorKeyDown(e, el) {
        if (e.key === 'Backspace' || e.key === 'Delete') {
            const selection = window.getSelection();
            if (!selection.rangeCount) return;
            const range = selection.getRangeAt(0);
            
            // Backspace at the very beginning of a page
            if (e.key === 'Backspace' && range.startOffset === 0 && range.collapsed) {
                // If it's the very first node of the editor body
                let isAtStart = true;
                let node = range.startContainer;
                while (node && node !== el) {
                    if (node.previousSibling) { isAtStart = false; break; }
                    node = node.parentNode;
                }
                
                if (isAtStart) {
                    const pages = Array.from(document.querySelectorAll('.v3-rich-editor-body'));
                    const idx = pages.indexOf(el);
                    if (idx > 0) {
                        e.preventDefault();
                        const prevPage = pages[idx - 1];
                        // Merge current content into previous page
                        const currentHtml = el.innerHTML;
                        const prevHtml = prevPage.innerHTML;
                        
                        // Move cursor to end of previous page
                        this._setCursorAtEnd(prevPage);
                        
                        // Append content
                        prevPage.innerHTML = prevHtml + currentHtml;
                        el.innerHTML = '';
                        
                        // Trigger re-paginate immediately
                        this._onRichEditorInput(prevPage);
                    }
                }
            }
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
// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED
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

    async _saveHandEdit({ rerender = true, renderGenerated = false } = {}) {
        const finalContent = this._collectEditorContent();
        const finalHtml = this._collectEditorHtml();
        
        this._editedContent = finalContent;
        this._editedHtml = finalHtml;
        this._lastSavedContent = finalContent;
        this._manualFinalExtraPages = 0;
        
        if (this._contract) {
            this._contract.final_content = finalContent;
            this._contract.final_content_html = finalHtml;
            dbService.updateContract(this._contract.id, {
                final_content: finalContent,
                final_content_html: finalHtml,
                final_font_size: this._getFinalEditorFontSize()
            });
        }

        this._finalLayoutGuardActive = false;
        this._finalRecoveredFromOriginal = false;
        this._lastRecoveredFinalContent = '';
        const badge = document.querySelector('.v3-status-badge');
        if (badge) {
            badge.classList.remove('unsaved');
            badge.style.background = '#dcfce7';
            badge.style.color = '#166534';
// MOJIBAKE CLEANED
        }
// MOJIBAKE CLEANED
        
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
            this._viewMode = 'final';
            this.renderFinalReadMode(this._viewerContainer);
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
                if (this._hasManualOnlyFinalChanges(finalContent)) {
                    if (renderGuard) {
// MOJIBAKE CLEANED
                    }
                    return false;
                }

                if (this._canGenerateSourceLayoutFinal(finalContent)) {
                    validation = await this._generateValidatedFinalDocxPdf(finalContent);
                    pdfBlob = validation.blob;
                    if (!pdfBlob && !allowHtmlFallback) {
                        if (renderGuard) {
                            console.warn('[SignViewer] Source-layout final PDF unavailable:', validation.reason);
// MOJIBAKE CLEANED
                        } else {
// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED
            document.getElementById('v3-saved-action-bar')?.remove();
            return true;
        } catch (error) {
            console.warn('[SignViewer] final PDF generation failed:', error);
            if (isDocxSource && renderGuard) {
// MOJIBAKE CLEANED
            } else {
// MOJIBAKE CLEANED
            }
            return false;
        }
    },

    async _previewHandEdit() {
// MOJIBAKE CLEANED
        const fromEditor = this._isFinalEditorVisible() ? this._collectEditorContent() : '';
        const finalContent = (fromEditor && fromEditor.trim()) ? fromEditor : this._getFinalDocumentText();
        this._editedContent = finalContent;
        this._editedHtml = this._isFinalEditorVisible() ? this._collectEditorHtml() : this._getFinalDocumentHtml();
        this._lastPreviewContent = finalContent;
        this._finalLayoutGuardActive = false;
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
// MOJIBAKE CLEANED
                    </div>
                    <div style="display:flex;align-items:center;gap:14px;">
// MOJIBAKE CLEANED
                            <i class="fa-solid fa-print" style="font-size:18px;"></i>
                        </button>
// MOJIBAKE CLEANED
                            <i class="fa-solid fa-download" style="font-size:18px;"></i>
                        </button>
                        <div style="width:1px;height:20px;background:rgba(255,255,255,0.2);margin:0 4px;"></div>
// MOJIBAKE CLEANED
                    </div>
                </div>
                <div style="flex:1;min-height:0;position:relative;background:#f1f5f9;">
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

// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED
                    </button>
                    <button onclick="window.signViewer.switchViewMode('edit')"
                        style="display:inline-flex;align-items:center;gap:6px;
                               padding:6px 18px;border-radius:8px;border:none;cursor:pointer;
                               background:#0b2d62;color:#fff;font-size:13px;font-weight:700;
                               box-shadow:0 2px 8px rgba(11,45,98,0.18);">
// MOJIBAKE CLEANED
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
        // If there are unsaved changes NOT in history, capture them first so we can redo back to them
        this._captureCurrentEditForHistory(); 
        
        if (!this._editHistory || this._editHistoryIndex <= 0) {
// MOJIBAKE CLEANED
            return;
        }
        this._editHistoryIndex--;
        this._editedContent = this._editHistory[this._editHistoryIndex];
        this.renderHandEditMode(this._viewerContainer);
    },

    _redoEdit() {
        if (!this._editHistory || this._editHistoryIndex >= this._editHistory.length - 1) return;
        this._editHistoryIndex++;
        this._editedContent = this._editHistory[this._editHistoryIndex];
        this.renderHandEditMode(this._viewerContainer);
    },

    _showEditDiff() {
        const contract = this._contract || {};
        const originalText = String(contract.original_content || contract.extracted_text || '');
        const textarea = document.getElementById('hand-edit-textarea');
        const editedText = textarea ? textarea.value : (this._editedContent || '');
// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED
            }
            return `<div style="padding:4px 12px;margin:2px 0;font-size:13px;line-height:1.8;color:#374151;">${esc(t)}</div>`;
        }).join('');
        const removedHtml = removedLines.length > 0 ? `
            <div style="margin-top:16px;padding:12px 16px;background:#fff5f5;border-radius:8px;border:1px solid #fecaca;">
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
            </div>` : '';
        document.getElementById('edit-diff-overlay')?.remove();
        const overlay = document.createElement('div');
        overlay.id = 'edit-diff-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;';
        overlay.innerHTML = `
            <div style="background:#fff;border-radius:12px;width:100%;max-width:820px;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 24px 64px rgba(0,0,0,0.3);overflow:hidden;">
                <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 24px;background:#0b2d62;flex-shrink:0;">
                    <div style="display:flex;align-items:center;gap:10px;">
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
                    </div>
// MOJIBAKE CLEANED
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
                const section = this._getChangeDisplaySection(c, i);
                const oldStr = (c.old || c.original || '').trim();
                const newStr = this._isAdditionChange(c)
                    ? this._buildLegalInsertionText(c)
                    : (c.new || c.modified || c.modifiedText || c.suggestion || '').trim();
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
                return lines.join('\n');
            }).join('\n\n');
        }
// MOJIBAKE CLEANED

        const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        const renderLine = (line) => {
            const trimmed = line.trim();
            if (!trimmed) return '<div style="height:8px;"></div>';
// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
                    </div>
// MOJIBAKE CLEANED
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

        if (clauses.length === 0 && aiChanges.length === 0) {
// MOJIBAKE CLEANED
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
                
// MOJIBAKE CLEANED
                const type = String(c.type || '').toUpperCase();
                const isAddition = type === 'ADD' || (!oldRaw && newRaw);
                const isDeletion = type === 'DELETE' || (oldRaw && !newRaw);
// MOJIBAKE CLEANED

// MOJIBAKE CLEANED
                let badgeColor = '#3b82f6';
                let accentColor = '#3b82f6';
                let icon = 'fa-solid fa-pen-nib';

                if (isAddition) {
// MOJIBAKE CLEANED
                    badgeColor = '#6366f1';
                    accentColor = '#6366f1';
                    icon = 'fa-solid fa-plus';
                } else if (isDeletion) {
// MOJIBAKE CLEANED
                    badgeColor = '#ef4444';
                    accentColor = '#ef4444';
                    icon = 'fa-solid fa-trash-can';
                } else if (isClarification) {
// MOJIBAKE CLEANED
                    badgeColor = '#06b6d4';
                    accentColor = '#06b6d4';
                    icon = 'fa-solid fa-sparkles';
                }

// MOJIBAKE CLEANED
                const proposalIntro = isDeletion 
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED

                const riskLevel = Number(c.riskLevel || c.risk_level || 2);
// MOJIBAKE CLEANED
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
                        <div style="display:flex; align-items:center; gap:8px; font-size:12px; font-weight:800; color:#64748b; background:#f1f5f9; padding:4px 12px; border-radius:20px;">
// MOJIBAKE CLEANED
                        </div>
                    </div>
                    <div style="padding:24px; border-left:6px solid #f59e0b; background:linear-gradient(90deg, #fffbeb 0%, #ffffff 100%);">
                        <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
                            <i class="fa-solid fa-triangle-exclamation" style="color:#d97706; font-size:16px;"></i>
// MOJIBAKE CLEANED
                        </div>
                        <div style="font-size:15px; color:#334155; line-height:1.8; font-weight:500;">${riskText}</div>
                    </div>
                    <div style="display:flex; flex-direction:column; border-top:1px solid #f1f5f9;">
                        <div style="padding:20px 24px; border-left:6px solid #cbd5e1; background:#fafafa; border-bottom:1px solid #f1f5f9;">
                            <div style="font-size:12px; font-weight:800; color:#64748b; margin-bottom:8px; display:flex; align-items:center; gap:8px;">
// MOJIBAKE CLEANED
                            </div>
                            <div style="font-size:14px; color:#64748b; line-height:1.7;">
// MOJIBAKE CLEANED
                            </div>
                        </div>
                        <div style="padding:24px; border-left:6px solid ${accentColor}; background:linear-gradient(90deg, ${accentColor}05 0%, #ffffff 100%);">
                            <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
                                <i class="fa-regular fa-lightbulb" style="color:${accentColor}; font-size:18px; font-weight:900;"></i>
// MOJIBAKE CLEANED
                            </div>
                            <div style="font-size:13px; color:${accentColor}; background:#fff; padding:12px 16px; border-radius:10px; border:1px dashed ${accentColor}40; margin-bottom:16px; line-height:1.6; font-weight:500;">
                                ${proposalIntro}
                            </div>
                            <div style="font-size:15px; color:#0f172a; line-height:1.9; padding:24px; background:#fff; border:1px solid #e2e8f0; border-radius:12px; box-shadow:inset 0 2px 8px rgba(0,0,0,0.02); font-family:'Inter', system-ui, sans-serif; white-space:pre-wrap;">${newDiffHtml}</div>
                            ${impact ? `
                            <div style="margin-top:20px; display:flex; align-items:flex-start; gap:12px; padding:14px 20px; background:#f0f9ff; border-radius:10px; border:1px solid #e0f2fe;">
                                <i class="fa-solid fa-shield-check" style="color:#0ea5e9; font-size:16px; margin-top:3px;"></i>
                                <div style="font-size:14px; color:#0369a1; line-height:1.6;">
// MOJIBAKE CLEANED
                                </div>
                            </div>` : ''}
                        </div>
                    </div>
                    <div style="padding:16px 24px; background:#fcfdfe; border-top:1px solid #f1f5f9; display:flex; justify-content:flex-end; align-items:center; gap:20px;">
                        ${_applied.has(i)
                            ? `
                            <div style="color:#10b981; font-size:14px; font-weight:900; display:flex; align-items:center; gap:8px;">
// MOJIBAKE CLEANED
                            </div>
// MOJIBAKE CLEANED
                            `
                            : `
                            <button onclick="window.signViewer._applyChange(${i})" style="background:#0b2d62; color:#fff; border:none; padding:12px 32px; border-radius:12px; font-size:14px; font-weight:900; cursor:pointer; box-shadow:0 4px 12px rgba(11,45,98,0.25);">
// MOJIBAKE CLEANED
                            </button>
                            `
                        }
                    </div>
                </div>`;
            }).join('');
        }

        revisedLayer.innerHTML = `
            <div style="padding:20px;max-width:900px;margin:0 auto;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
                    <div style="font-size:14px; color:#64748b; font-weight:600;">
// MOJIBAKE CLEANED
                    </div>
                    <button onclick="window.signViewer._applyAllChanges()" 
                            style="background:#0b2d62; color:#fff; border:none; padding:8px 16px; border-radius:8px; font-size:13px; font-weight:700; cursor:pointer; display:flex; align-items:center; gap:8px; box-shadow:0 2px 8px rgba(11,45,98,0.15);">
// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED
            this.switchViewMode('final');
            return;
        }
        const baseText = this._isFinalEditorVisible() ? this._collectEditorContent() : this._ensureEditedContent();
        const nextText = this._applyChangeToText(baseText, c);
        if (nextText === baseText) {
            const checkText = this._buildLegalInsertionText(c);
            const alreadyPresent = checkText && baseText.includes(checkText);
            if (!alreadyPresent) {
// MOJIBAKE CLEANED
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
        this._justAppliedSnippet = this._buildLegalInsertionText(c);
// MOJIBAKE CLEANED
        this.renderModifiedDocument(this._viewerContainer);
        setTimeout(() => { this.switchViewMode('final'); }, 0);
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
        let appliedCount = 0;
        let skippedCount = 0;
        let alreadyCount = 0;
        changes.forEach((c, i) => {
            if (applied.has(i)) return;
            const before = nextText;
            nextText = this._applyChangeToText(nextText, c);
            if (nextText === before) {
                const checkText = this._buildLegalInsertionText(c);
                if (checkText && before.includes(checkText)) {
                    applied.add(i);
                    alreadyCount += 1;
                    return;
                }
                console.warn('[SignViewer] Failed to apply change:', i, c);
                skippedCount += 1;
                return;
            }
            applied.add(i);
            appliedCount += 1;
        });
        if (appliedCount === 0 && alreadyCount === 0) {
// MOJIBAKE CLEANED
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
        this._setStoredAppliedChangeIndexes(applied, {
            final_content: nextText,
            final_content_html: ''
        });

        const reflectedCount = appliedCount + alreadyCount;
        if (skippedCount > 0) {
// MOJIBAKE CLEANED
        } else {
// MOJIBAKE CLEANED
        }
        this.switchViewMode('final');
    },

    async importFinalFile() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.pdf,.docx';
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            
// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED
            return;
        }

        const baseName = String(this._contract?.name || this._currentFilename || 'final_document')
            .replace(/[\\/:*?"<>|]/g, '_')
            .replace(/\.(docx?|pdf)$/i, '')
            .trim() || 'final_document';

        try {
// MOJIBAKE CLEANED
            if (this._canGenerateSourceLayoutFinal(finalText) || this._hasManualOnlyFinalChanges(finalText)) {
                const validation = this._hasManualOnlyFinalChanges(finalText)
                    ? {
                        blob: null,
// MOJIBAKE CLEANED
                    }
                    : await this._generateValidatedFinalDocxPdf(finalText);
                if (!validation.blob) {
                    console.warn('[SignViewer] Source-layout final PDF unavailable, falling back to regular export:', validation.reason);
                } else {
                const pdfUrl = URL.createObjectURL(validation.blob);
                const link = document.createElement('a');
                link.href = pdfUrl;
                link.download = `${baseName}_final.pdf`;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                setTimeout(() => URL.revokeObjectURL(pdfUrl), 1000);
// MOJIBAKE CLEANED
                return;
                }
            }

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
// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
                </span>
            </button>
            <button type="button" class="v3-download-option" data-download-action="word">
                <span class="v3-download-file-icon is-word">W</span>
                <span>
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
                </span>
            </button>
            <button type="button" class="v3-download-option" data-download-action="word-open">
                <span class="v3-download-file-icon is-word"><i class="fa-solid fa-cloud"></i></span>
                <span>
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
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
            } else if (action === 'word-open') {
                await this.openInWord();
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

    async _generateFinalDocxBlob(finalContent = this._getFinalDocumentText()) {
        const serviceUrl = (typeof window !== 'undefined' && window.__DOCX_PDF_SERVICE_URL__)
            ? String(window.__DOCX_PDF_SERVICE_URL__).replace(/\/$/, '')
            : '';
// MOJIBAKE CLEANED

        const originalFile = await this._getOriginalDocxFileForFinal();
// MOJIBAKE CLEANED

        const revisions = this._buildFinalDocxRevisions(finalContent);
// MOJIBAKE CLEANED

        const formData = new FormData();
        formData.append('file', originalFile, originalFile.name || 'original.docx');
        formData.append('revisions', JSON.stringify(revisions));

        const resp = await fetch(`${serviceUrl}/api/convert/final-docx`, {
            method: 'POST',
            body: formData,
            signal: AbortSignal.timeout(120_000)
        });
// MOJIBAKE CLEANED
        const contentType = resp.headers.get('content-type') || '';
        if (!contentType.includes('wordprocessingml.document') && !contentType.includes('application/octet-stream')) {
// MOJIBAKE CLEANED
        }
        return { blob: await resp.blob(), reason: '' };
    },

    _buildWordCompatibleHtmlBlob(finalContent = this._getFinalDocumentText()) {
        const safeText = this.escapeHtml(String(finalContent || '')).replace(/\n/g, '<br>');
        const html = `<!doctype html><html><head><meta charset="utf-8"><title>${this.escapeHtml(this._getDownloadBaseName())}</title></head><body style="font-family:'Yu Mincho','MS Mincho',serif;font-size:11pt;line-height:1.8;">${safeText}</body></html>`;
        return new Blob([html], { type: 'application/msword;charset=utf-8' });
    },

    async downloadWord() {
        const editorVisible = this._isFinalEditorVisible();
        const finalContent = String(editorVisible ? this._collectEditorContent() : this._getFinalDocumentText());
        const baseName = this._getDownloadBaseName();
        try {
// MOJIBAKE CLEANED
            const result = await this._generateFinalDocxBlob(finalContent);
            if (result.blob) {
                this._downloadBlob(result.blob, `${baseName}_final.docx`);
// MOJIBAKE CLEANED
                return;
            }
            console.warn('[SignViewer] Final DOCX unavailable, using Word-compatible HTML:', result.reason);
        } catch (error) {
            console.error('Word download error:', error);
        }

        this._downloadBlob(this._buildWordCompatibleHtmlBlob(finalContent), `${baseName}_final.doc`);
// MOJIBAKE CLEANED
    },

    async openInWord() {
        const editorVisible = this._isFinalEditorVisible();
        const finalContent = String(editorVisible ? this._collectEditorContent() : this._getFinalDocumentText());
        const baseName = this._getDownloadBaseName();
        try {
// MOJIBAKE CLEANED
            const result = await this._generateFinalDocxBlob(finalContent);
            if (result.blob) {
                const url = this._downloadBlob(result.blob, `${baseName}_final.docx`);
                window.open(url, '_blank', 'noopener');
// MOJIBAKE CLEANED
                return;
            }
            console.warn('[SignViewer] Final DOCX open unavailable, using Word-compatible HTML:', result.reason);
        } catch (error) {
            console.error('Word open error:', error);
        }

        const url = this._downloadBlob(this._buildWordCompatibleHtmlBlob(finalContent), `${baseName}_final.doc`);
        window.open(url, '_blank', 'noopener');
// MOJIBAKE CLEANED
    },

    async downloadPdf() {
        if (this._viewMode === 'edit') {
            await this._downloadFinalPreviewPdf();
            return;
        }
        if (this._viewMode === 'final' && !this._finalGeneratedPdfUrl) {
            await this._downloadFinalPreviewPdf();
            return;
        }

        const req = this._currentRequest || {};
        const fallbackUrl = resolveBackendAssetUrl(req.original_file_url || req.original_file_path || req.pdf_url || req.pdf_storage_path);
        const downloadUrl = this._currentDownloadUrl || this._currentPdfUrl || fallbackUrl;
        if (!downloadUrl) {
// MOJIBAKE CLEANED
            return;
        }
        
        try {
// MOJIBAKE CLEANED
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

    printDocument() {
// MOJIBAKE CLEANED
        window.print();
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
// MOJIBAKE CLEANED
                const { charsPerLine, linesPerPage } = this._calcPageLayout();
                const pages = this._paginateDocumentText(text, charsPerLine, linesPerPage);
                
                pagesContainer.innerHTML = pages.map((pageLines, i) => `
                    <div data-page="${i+1}" class="v3-editor-page" style="width:794px;max-width:calc(100vw - 64px);margin:0 auto 32px auto;padding:80px 60px;box-sizing:border-box;background:#fff;min-height:1123px;box-shadow:0 8px 24px rgba(0,0,0,0.08);color:#333;font-family:'Noto Serif JP', serif;font-size:14px;line-height:1.8;white-space:pre-wrap;overflow:hidden;">
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
// MOJIBAKE CLEANED
                    </a>
                </div>
                ` : ''}
                <div style="flex:1; padding:${isDash ? '0' : '32px'}; overflow-y:auto; line-height:1.8; color:#333; font-family:'Noto Sans JP', sans-serif; font-size:14px;">
// MOJIBAKE CLEANED
                </div>
            </div>
        `;
        this.triggerDashboardUI();
    },

    /**
// MOJIBAKE CLEANED
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

// MOJIBAKE CLEANED
        let scrollEl = document.getElementById('pdf-viewer-scroll');
        if (!scrollEl) {
// MOJIBAKE CLEANED
            scrollEl = document.getElementById('pdf-viewer-scroll');
        }
        this._setOriginalViewerBottomSpace(this._isDashboardMode && (this._viewMode === 'original' || this._viewMode === 'final'));
        
        const mount = document.getElementById('sign-viewer-docx-pages');
        const pdfMount = document.getElementById('pdf-pages-container');
        const loader = document.getElementById('viewer-loader');

        if (mount) {
            mount.style.display = (this._viewMode === 'original' || this._viewMode === 'final') ? 'block' : 'none';
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

// MOJIBAKE CLEANED
            const scrollEl = document.getElementById('pdf-viewer-scroll');
            const loader = document.getElementById('viewer-loader');
            
            if (scrollEl) {
                this.setupInteractiveViewer(scrollEl, mount);
                
// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED
            );
        } finally {
            this._isRenderingDocx = false;
        }
    },

// MOJIBAKE CLEANED
        const isDash = this._isDashboardMode;
        const originalFileHref = resolveBackendAssetUrl(contract?.original_file_url || contract?.original_file_path);
        const fallbackHref = originalFileHref || contract?.source_url || '';
        
        if (isDash) {
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED
                        </div>
                        <div style="font-size:14px; color:#64748b; line-height:1.7; margin-bottom:24px;">${this.escapeHtml(message)}</div>
// MOJIBAKE CLEANED
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

// MOJIBAKE CLEANED
        if (isDash) {
            container.innerHTML = `
                <div style="width:100%; height:100%; background:#f1f5f9; display:flex; align-items:center; justify-content:center;">
                <div style="padding:40px; color:#444; max-width:480px;">
                    <div style="font-size:16px; font-weight:700; margin-bottom:12px; display:flex; align-items:center; gap:8px;">
// MOJIBAKE CLEANED
                    </div>
                    <div style="font-size:13px; color:#64748b; line-height:1.6; margin-bottom:16px;">${this.escapeHtml(message)}</div>
// MOJIBAKE CLEANED
                </div>
                </div>
            `;
        } else {
            container.innerHTML = `
                <div style="width:min(760px, 100%); margin:40px auto; background:#fff; border:1px solid #e5e7eb; border-radius:18px; box-shadow:0 16px 40px rgba(15,23,42,0.08); padding:56px 40px; text-align:center;">
                    <div style="width:64px; height:64px; margin:0 auto 18px; border-radius:20px; background:#fef2f2; color:#c53030; display:flex; align-items:center; justify-content:center; font-size:28px;">
                        <i class="fa-regular fa-file-pdf"></i>
                    </div>
// MOJIBAKE CLEANED
                    <div style="font-size:13px; color:#6b7280; line-height:1.8;">${this.escapeHtml(message)}</div>
// MOJIBAKE CLEANED
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
            const token = await getIdToken();
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
        
// MOJIBAKE CLEANED
        this._viewerContainer = document.getElementById(containerId);
        if (!this._viewerContainer) {
            console.error("Viewer container not found:", containerId);
            return;
        }

        try {
// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
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
            this._finalRecoveredFromOriginal = false;
            this._lastRecoveredFinalContent = '';
            this._manualFinalExtraPages = 0;
            
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
            
            // Force default to 'revised' mode for new/existing imports unless explicitly told otherwise
            this._viewMode = 'revised';
            await this.switchViewMode('revised');

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
            
// MOJIBAKE CLEANED
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

    _getSanitizedContractId(id) {
        const rawId = id || this._contract?.id || this._contractId || this._currentRequest?.contract_id;
        if (!rawId) return '';
        return String(rawId).replace(/^contracts\//, '');
    },

    async openInWord() {
        console.log('[SignViewer] openInWord (Word Online) triggered');
// MOJIBAKE CLEANED
        try {
            const contractId = this._getSanitizedContractId();
            if (!contractId) throw new Error('Contract ID not found');

            const token = await getIdToken();
            const res = await fetch(toApiUrl(`/api/contracts/${contractId}/word-online-url`), {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            
            const data = await res.json();
            if (!res.ok || !data.url) {
                console.warn('[SignViewer] Word Online URL failed, falling back to download:', data.error);
// MOJIBAKE CLEANED
                return this._downloadOriginalFileFallback();
            }

            const officeUrl = `https://view.officeapps.live.com/op/view.aspx?src=${encodeURIComponent(data.url)}`;
            console.log('[SignViewer] Opening Word Online:', officeUrl);
            window.open(officeUrl, '_blank');
// MOJIBAKE CLEANED
        } catch (err) {
            console.error('Word Online error:', err);
            this._downloadOriginalFileFallback();
        }
    },

    async _downloadOriginalFileFallback() {
        const contractId = this._getSanitizedContractId();
        if (!contractId) return;
        try {
// MOJIBAKE CLEANED
            const token = await getIdToken();
            const headers = { 'Authorization': `Bearer ${token}` };

            // Try the original-file endpoint first
            let res = await fetch(toApiUrl(`/api/contracts/${contractId}/original-file`), { headers });
            
            // If that fails, try the export endpoint
            if (!res.ok) {
                console.warn('[SignViewer] original-file failed, trying export endpoint');
                res = await fetch(toApiUrl(`/api/contracts/${contractId}/export?format=docx`), { headers });
            }
            
            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
// MOJIBAKE CLEANED
            }
            
            const blob = await res.blob();
            if (blob.size < 100) { // Safety check for empty or error responses
// MOJIBAKE CLEANED
            }

            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = this._contract?.original_filename || `contract_${contractId}.docx`;
            link.click();
            setTimeout(() => URL.revokeObjectURL(link.href), 10000);
// MOJIBAKE CLEANED
        } catch (err) {
            console.error('Download error:', err);
// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED
            </div>
            
            <button class="v3-download-option" onclick="window.signViewer._downloadFinalPreviewPdf(); document.querySelectorAll('.v3-download-popover').forEach(p => p.remove());">
                <div class="v3-download-file-icon is-pdf">
                    <i class="fa-solid fa-file-pdf"></i>
                </div>
                <div>
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
                </div>
            </button>

            <button class="v3-download-option" onclick="window.app?.downloadOriginalFile?.() || window.signViewer._downloadOriginalFileFallback(); document.querySelectorAll('.v3-download-popover').forEach(p => p.remove());">
                <div class="v3-download-file-icon is-word">
                    <i class="fa-solid fa-file-word"></i>
                </div>
                <div>
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
                </div>
            </button>

            <button class="v3-download-option" onclick="window.signViewer.openInWord(); document.querySelectorAll('.v3-download-popover').forEach(p => p.remove());">
                <div class="v3-download-file-icon is-cloud" style="background:#fff; color:#0b2d62; border:1px solid rgba(11,45,98,0.1);">
                    <i class="fa-solid fa-arrow-up-right-from-square"></i>
                </div>
                <div>
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
                </div>
            </button>
        `;

        document.body.appendChild(popover);

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
                    width:calc(100% - 32px) !important;
                    max-width:none !important;
                    margin-left:auto !important;
                    margin-right:auto !important;
                }
                 @media print {
                    body > *:not(.analysis-v3-split-layout) { display: none !important; }
                    .analysis-v3-split-layout { display: block !important; padding: 0 !important; margin: 0 !important; }
                    .v3-viewer-sidebar, .v3-viewer-toolbar-wrapper, #v3-viewer-toolbar { display: none !important; }
                    .v3-document-scroll-area, #pdf-viewer-scroll, #v3-editor-scroll { 
                        display: block !important; 
                        overflow: visible !important; 
                        position: static !important;
                        height: auto !important;
                        width: 100% !important;
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
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
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
// MOJIBAKE CLEANED
                                <i class="fa-solid fa-minus" style="font-size:12px;"></i>
                            </button>
                            <span style="font-size:14px; font-weight:700; color:#1e293b; min-width:45px; text-align:center; font-family:'Inter', sans-serif;">${Math.round((this._scale || 1.0) * 100)}%</span>
// MOJIBAKE CLEANED
                                <i class="fa-solid fa-plus" style="font-size:12px;"></i>
                            </button>
                        </div>
                    </div>

                    <!-- Middle: Tabs -->
                    <div style="display:flex; align-items:center; background:#f1f5f9; border-radius:8px; padding:3px; gap:2px; flex-shrink:0;">
// MOJIBAKE CLEANED
// MOJIBAKE CLEANED
                    </div>

                    <!-- Right: Actions -->
                    <div style="display:flex; align-items:center; gap:8px; flex:1; justify-content:flex-end;">
                        ${(this._viewMode === 'final' && this._finalGeneratedPdfUrl) ? `
                        <button onclick="window.signViewer._previewHandEdit()" style="display:inline-flex;align-items:center;gap:6px;background:#f8fafc;color:#0b2d62;border:1px solid #bfdbfe;padding:6px 14px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap;">
// MOJIBAKE CLEANED
                        </button>
                        ` : ''}
                        
                        ${(this._viewMode === 'final' && !document.getElementById('v3-editor-scroll') && (this._finalGeneratedPdfUrl || this._finalRecoveredFromOriginal)) ? `
                        <button onclick="window.signViewer.switchViewMode('edit')" style="display:inline-flex;align-items:center;gap:6px;background:#0b2d62;color:#fff;border:none;padding:6px 18px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap;">
// MOJIBAKE CLEANED
                        </button>
                        <div style="height:20px; width:1px; background:#e2e8f0;"></div>
                        ` : ''}
                        
// MOJIBAKE CLEANED
                            <i class="fa-solid fa-print" style="font-size:16px;"></i>
                        </button>
                        
// MOJIBAKE CLEANED
                            <i class="fa-solid fa-download" style="font-size:16px;"></i>
                        </button>

                        <div style="height:20px; width:1px; background:#e2e8f0;"></div>
                        
// MOJIBAKE CLEANED
                            <i class="fa-solid ${isFS ? 'fa-compress' : 'fa-expand'}" style="font-size:16px;"></i>
                        </button>
                    </div>
                </div>
            `;
        }
        
        const sidebar = document.querySelector('.v3-viewer-sidebar');
        if (sidebar) {
            sidebar.style.display = 'block'; // Always keep sidebar visible to stabilize layout
            if (this._viewMode !== 'final' && this._viewMode !== 'edit') {
                sidebar.innerHTML = '';
                return;
            }

            sidebar.style.display = '';
            const previousScrollTop = sidebar.scrollTop || 0;
            this.renderFinalThumbnails(sidebar);
            sidebar.scrollTop = previousScrollTop;
        }
    },

    getFinalThumbnailPageCount() {
        const editorPages = document.querySelectorAll('#v3-editor-scroll .v3-editor-page[data-page]');
        if (editorPages.length) return editorPages.length;
        const finalPages = document.querySelectorAll('#v3-edit-layer .v3-editor-page[data-page]');
        if (finalPages.length) return finalPages.length;
        return Math.max(1, Number(this._totalPages || 1));
    },

    renderFinalThumbnails(container) {
        let thumbHtml = '';
        const total = this.getFinalThumbnailPageCount();
        this._totalPages = total;
        this._activePage = Math.max(1, Math.min(Number(this._activePage || 1), total));

        for (let i = 1; i <= total; i++) {
            thumbHtml += `
// MOJIBAKE CLEANED
                    <span class="v3-thumb-num">${i}</span>
                </button>`;
        }
        container.innerHTML = thumbHtml;
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
