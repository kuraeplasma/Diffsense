/**
 * SignViewer - Signature Detail Viewer Logic (provider embed + pdf.js)
 */

import { dbService } from './db-service.js';
import { Notify } from './notify.js';
import { buildSignDocumentPreviewHtml } from './sign-document-preview.js?v=20260402_signpreview_plain1';
import { isDocxFileName, renderDocxPreviewPages, wrapPreviewPageShell } from './sign-docx-preview.js?v=20260407_final_v10';
import { getIdToken } from './auth.js';
import { resolveBackendAssetUrl, toApiUrl } from './api-base-safe.js?v=20260329_api_base_safe1';

export const SignViewer = {
    _pdfjsLoaded: false,
    _activePage: 1,
    _totalPages: 1,
    _objectUrls: [],
    _initSeq: 0,
    _inFlightRequestId: null,

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
            Notify.error('依頼が見つかりません');
            app.navigate('sign');
            return;
        }
        if (this._inFlightRequestId === requestId) {
            console.debug('SignViewer init skipped duplicate request:', requestId);
            return;
        }
        const initSeq = ++this._initSeq;
        this._inFlightRequestId = requestId;
        console.log('Initializing SignViewer for ID:', requestId);
        this.cleanupObjectUrls();
        this._activePage = 1;
        this._currentScale = 1.2;
        this._currentPdfUrl = null;
        this._currentDownloadUrl = null;
        this._currentRequest = null;

        try {
            const request = typeof dbService.getSignRequestById === 'function'
                ? await dbService.getSignRequestById(requestId)
                : (await dbService.getSignRequests()).find((item) => String(item?.id) === requestId);
            if (initSeq !== this._initSeq) return;

            if (!request) {
                Notify.error('依頼が見つかりません');
                app.navigate('sign');
                return;
            }

            const container = document.getElementById('sign-viewer-content');
            if (!container) return;
            this._currentRequest = request;

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
                const hasFallbackContent = Boolean(previewContract?.original_content);
                const runtimeDocx = Boolean(runtimeDoc && isDocxFileName(runtimeDoc.name || originalName));
                const persistedDocx = Boolean(persistedOriginalUrl && isDocxFileName(originalName));
                const rawPdfLooksDocx = /\.docx?($|[?#])/i.test(String(rawPdfUrl || ''));
                const selectedSourceIsPersistedDocx = Boolean(
                    persistedDocx
                    && pdfUrl
                    && persistedOriginalUrl
                    && String(pdfUrl) === String(persistedOriginalUrl)
                );

                if (isActuallyPdf && !rawPdfLooksDocx && !selectedSourceIsPersistedDocx) {
                    await this.renderPdf(pdfUrl, container);
                } else if (runtimeDocx) {
                    await this.renderDocx(runtimeDoc, container);
                } else if (persistedDocx) {
                    await this.renderDocx(persistedOriginalUrl, container);
                } else if (hasFallbackContent) {
                    // Fallback: Show original text for web/crawled contracts
                    this.renderTextFallback(previewContract, container);
                } else {
                    container.innerHTML = `
                        <div style="text-align:center; color:var(--text-muted); padding:60px;">
                            <i class="fa-solid fa-file-circle-exclamation" style="font-size:64px; margin-bottom:16px;"></i>
                            <p>ドキュメントファイルが見つかりません</p>
                            ${previewContract?.source_url ? `<a href="${previewContract.source_url}" target="_blank" style="color:var(--color-primary); font-size:12px;">元のソースを開く <i class="fa-solid fa-external-link"></i></a>` : ''}
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
                            created: '📄 作成',
                            signed: '✅ 署名',
                            declined: '❌ 辞退',
                            completed: '🎉 完了',
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
                        auditContainer.innerHTML = '<div style="font-size:12px; color:var(--text-muted);">記録なし</div>';
                    }
                } catch (e) {
                    console.error('監査証跡取得失敗:', e);
                    auditContainer.innerHTML = '<div style="font-size:12px; color:var(--text-muted);">取得失敗</div>';
                }
            }
        } finally {
            if (this._inFlightRequestId === requestId) {
                this._inFlightRequestId = null;
            }
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
                    <i class="fa-solid fa-shield-halved"></i> ${providerLabel} セキュア・埋め込み署名
                </div>
                <div id="zoho-iframe-container" style="flex:1; width:100%; position:relative;">
                    <div class="loader-spinner" style="position:absolute; top:50%; left:50%; transform:translate(-50%, -50%);"></div>
                    <p style="position:absolute; top:60%; width:100%; text-align:center; color:#888;">署名ページを読み込み中...</p>
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
    async renderPdf(url, container) {
        this._currentPdfUrl = await this.resolvePdfViewerUrl(url);
        this._currentDownloadUrl = this._currentDownloadUrl || this._currentPdfUrl;
        this._currentScale = this._currentScale || 1.2;

        container.innerHTML = `
            <div class="pdf-viewer-wrapper" style="display:flex; flex-direction:column; width:100%; height:100%; background:#525659; position:relative;">
                <div style="display:flex; align-items:center; justify-content:flex-end; gap:8px; padding:14px 18px; background:#2d3136; color:white; border-bottom:1px solid #444;">
                    <div style="display:flex; align-items:center; gap:8px;">
                        <button class="btn-pdf-tool" onclick="window.signViewer.zoomOut()"><i class="fa-solid fa-minus"></i></button>
                        <span id="zoom-percent" style="font-size:13px; min-width:45px; text-align:center;">${Math.round(this._currentScale * 100)}%</span>
                        <button class="btn-pdf-tool" onclick="window.signViewer.zoomIn()"><i class="fa-solid fa-plus"></i></button>
                    </div>
                </div>
                <div id="pdf-viewer-scroll" style="flex:1; width:100%; overflow-y:auto; padding:20px 0;">
                    <div id="pdf-pages-container" style="display:flex; flex-direction:column; align-items:center; gap:20px;">
                        <div class="loader-spinner"></div>
                    </div>
                </div>
            </div>
        `;

        await this.refreshPdfRendering();
    },

    async refreshPdfRendering() {
        const pagesContainer = document.getElementById('pdf-pages-container');
        if (!pagesContainer || !this._currentPdfUrl) return;

        try {
            await this.loadPdfJs();
            
            pagesContainer.innerHTML = '<div class="loader-spinner"></div>';
            
            const loadingTask = pdfjsLib.getDocument({
                url: this._currentPdfUrl,
                cMapUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/cmaps/',
                cMapPacked: true,
                standardFontDataUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/standard_fonts/',
                useWorkerFetch: true
            });
            const pdf = await loadingTask.promise;
            this._totalPages = pdf.numPages;
            this._activePage = Math.min(this._activePage || 1, this._totalPages || 1);
            
            pagesContainer.innerHTML = ''; // Clear loader

            for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
                const page = await pdf.getPage(pageNum);
                const baseScale = this._currentScale || 1.2;
                const renderingScale = baseScale * 2; 
                const viewport = page.getViewport({ scale: renderingScale });
                const baseViewport = page.getViewport({ scale: baseScale });

                const pageShell = document.createElement('div');
                pageShell.style.position = 'relative';
                pageShell.style.display = 'inline-block';
                pageShell.style.marginBottom = '20px';
                pageShell.style.contain = 'paint';
                pageShell.style.isolation = 'isolate';
                pageShell.dataset.page = String(pageNum);

                const canvas = document.createElement('canvas');
                canvas.className = 'pdf-page-canvas';
                canvas.style.boxShadow = 'none';
                canvas.style.borderRadius = '2px';
                canvas.style.display = 'block';
                canvas.style.background = '#fff';
                canvas.style.width = baseViewport.width + 'px';
                canvas.style.height = baseViewport.height + 'px';
                const context = canvas.getContext('2d');
                canvas.height = viewport.height;
                canvas.width = viewport.width;

                await page.render({
                    canvasContext: context,
                    viewport: viewport
                }).promise;

                pageShell.appendChild(canvas);
                pageShell.appendChild(this.createFieldOverlay(pageNum, baseViewport.width, baseViewport.height));
                pagesContainer.appendChild(pageShell);
            }

            this.updateVisiblePages();
            this.renderPageSwitcher();
            const zoomTxt = document.getElementById('zoom-percent');
            if (zoomTxt) zoomTxt.textContent = `${Math.round(this._currentScale * 100)}%`;

        } catch (error) {
            console.error('PDF.js Error:', error);
            pagesContainer.innerHTML = `
                <div style="padding:40px; text-align:center; color:#eee;">
                    <i class="fa-solid fa-circle-xmark" style="font-size:48px; margin-bottom:16px;"></i>
                    <p>PDFの表示に失敗しました</p>
                </div>
            `;
        }
    },

    createFieldOverlay(pageNum, viewportWidth, viewportHeight) {
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
            const recipientLabel = recipient?.name || recipient?.display_name || recipient?.email || `署名者${recipientIndex + 1}`;
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
            const baseWidth = Math.max(1, Number(pageDims?.width || viewportWidth / Math.max(this._currentScale || 1, 0.01)));
            const baseHeight = Math.max(1, Number(pageDims?.height || viewportHeight / Math.max(this._currentScale || 1, 0.01)));
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
                    <span>${field.type === 'date' ? '日付欄' : '署名欄'} ${index + 1}</span>
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
        if (nextPage === this._activePage) return;
        this._activePage = nextPage;
        this.updateVisiblePages();
        this.renderPageSwitcher();
    },

    updateVisiblePages() {
        document.querySelectorAll('#pdf-pages-container > div[data-page]').forEach((pageShell) => {
            pageShell.style.display = 'inline-block';
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
        if (this._currentScale >= 3.0) return;
        this._currentScale += 0.2;
        this.refreshPdfRendering();
    },

    zoomOut() {
        if (this._currentScale <= 0.5) return;
        this._currentScale -= 0.2;
        this.refreshPdfRendering();
    },

    async downloadPdf() {
        const downloadUrl = this._currentDownloadUrl || this._currentPdfUrl;
        if (!downloadUrl) return;
        
        try {
            const link = document.createElement('a');
            link.href = downloadUrl;
            link.download = `contract_${Date.now()}.pdf`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            Notify.success('ダウンロードを開始しました');
        } catch (error) {
            Notify.error('ダウンロードに失敗しました');
        }
    },

    renderTextFallback(contract, container) {
        container.innerHTML = `
            <div class="text-fallback-wrapper" style="width:100%; height:100%; display:flex; flex-direction:column; background:#fff; border-radius:var(--radius-md); overflow:hidden; border:1px solid var(--border-subtle);">
                ${contract.source_url ? `
                <div style="padding:16px; background:#f8f9fa; border-bottom:1px solid #eee; display:flex; justify-content:flex-end; align-items:center;">
                    <a href="${contract.source_url}" target="_blank" style="font-size:12px; color:var(--color-primary);">
                        元のソースを表示 <i class="fa-solid fa-external-link"></i>
                    </a>
                </div>
                ` : ''}
                <div style="flex:1; padding:32px; overflow-y:auto; line-height:1.8; color:#333; font-family:'Noto Sans JP', sans-serif; font-size:14px;">
                    ${buildSignDocumentPreviewHtml(contract.original_content)}
                </div>
                <div style="padding:12px; background:#fff9e6; border-top:1px solid #ffeeba; font-size:11px; color:#856404; text-align:center;">
                    <i class="fa-solid fa-circle-info"></i> このドキュメントはテキストプレビューで表示しています。原本と一部レイアウトが異なる場合があります。
                </div>
            </div>
        `;
    },

    async renderDocx(source, container) {
        container.innerHTML = `
            <div style="width:100%; height:100%; overflow-y:auto; padding:20px 0; background:#dfe1e5;">
                <div id="sign-viewer-docx-pages" style="display:flex; flex-direction:column; align-items:center;"></div>
            </div>
        `;
        const mount = document.getElementById('sign-viewer-docx-pages');
        if (!mount) return;
        try {
            const resolvedSource = await this.resolveDocxPreviewSource(source);
            const pages = await renderDocxPreviewPages(mount, resolvedSource);
            this._totalPages = pages.length || 1;
        } catch (error) {
            console.error('DOCX preview error:', error);
            const snapshot = this._currentRequest?.document_snapshot || this._currentRequest?.contract_snapshot || {};
            const liveContract = dbService.getContractById(this._currentRequest?.contract_id) || null;
            const fallbackContract = liveContract ? { ...snapshot, ...liveContract } : snapshot;
            this.renderUnavailableDocument(
                fallbackContract || {},
                container,
                'Word原本のプレビューに失敗しました。見た目を変えないため、別レイアウトへの自動変換は行っていません。'
            );
        }
    },

    renderUnavailableDocument(contract, container, message = '取り込んだ原本ファイルを表示できませんでした。') {
        const originalFileHref = resolveBackendAssetUrl(contract?.original_file_url || contract?.original_file_path);
        const fallbackHref = originalFileHref || contract?.source_url || '';
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
        this._totalPages = 1;
        this._activePage = 1;
    },

    async resolveDocxPreviewSource(source) {
        if (source instanceof Blob) return source;
        const contractId = this._currentRequest?.contract_id || this._currentRequest?.contractId;
        if (!contractId) return source;

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
        if (!str) return '';
        return str.replace(/[&<>"']/g, m => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[m]));
    },

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

    setupEventListeners(app, request) {
        // Placeholder for future interactive logic
    }
};

window.signViewer = SignViewer;
