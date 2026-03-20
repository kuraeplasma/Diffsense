/**
 * SignRecipient - Recipient Signing View
 */
import { Notify } from './notify.js';
import { dbService } from './db-service.js';
import { buildSignDocumentPreviewHtml } from './sign-document-preview.js';
import { getApiBaseUrl, resolveBackendAssetUrl, toApiUrl } from './api-base.js';

const API_BASE = getApiBaseUrl();

export const SignRecipient = {
    _currentRequest: null,
    _pdf: null,
    _fields: [],
    _signedFields: new Set(),
    _previewMode: 'pdf',
    _pageScale: 1,
    _fieldValues: {},
    _activeFieldId: null,
    _drawState: null,
    _activeRecipientIndex: 0,
    _isPreviewMode: false,
    _activePage: 1,
    _totalPages: 1,
    _hasAgreed: false,

    async init(app, id) {
        const previewSession = window._signRecipientPreview;
        let previewContract = null;
        if (previewSession && String(previewSession.id) === String(id)) {
            this._currentRequest = previewSession.request;
            previewContract = previewSession.contract || null;
            this._isPreviewMode = true;
        } else {
            const requests = await dbService.getSignRequests();
            this._currentRequest = requests.find(r => String(r.id) === String(id));
            this._isPreviewMode = false;
        }
        
        if (!this._currentRequest) {
            Notify.error('依頼データが見つかりません');
            return;
        }

        const snapshot = this._currentRequest.document_snapshot || this._currentRequest.contract_snapshot || null;
        const contracts = previewContract || snapshot ? [] : await dbService.getContracts();
        const contract = previewContract
            || snapshot
            || contracts.find(c => String(c.id) === String(this._currentRequest.contract_id || this._currentRequest.contractId))
            || contracts.find(c => String(c.name || '') === String(this._currentRequest.document_name || ''));
        
        if (!contract) {
            Notify.error('契約データが見つかりません');
            return;
        }

        const canvasContainer = document.getElementById('sign-recipient-canvas-container');
        if (!canvasContainer) return;

        const previewUrl = this.resolvePreviewUrl(contract);
        if (this.isPdfLikeUrl(previewUrl)) {
            await this.loadPdfJs();
            await this.loadPdf(previewUrl, canvasContainer);
            this._previewMode = 'pdf';
        } else {
            this.renderUnavailableDocument(contract, canvasContainer);
            this._previewMode = 'unavailable';
        }
        
        this._fields = this._currentRequest.fields || [];
        this._activeRecipientIndex = this.resolveActiveRecipientIndex();
        this._fieldValues = { ...(this._currentRequest.completed_fields || {}) };
        Object.keys(this._fieldValues).forEach((id) => this._signedFields.add(String(id)));
        this._hasAgreed = Boolean(this._currentRequest?.recipients?.[this._activeRecipientIndex]?.consented_at);
        this.renderRecipientFields();
        this.renderPageSwitcher();
        this.fitPreviewPages();
        window.addEventListener('resize', () => this.fitPreviewPages());
        this.ensureSignatureModal();
        this.updatePreviewBanner();
        this.syncAgreementUi();
        
        window.SignRecipient = this;
    },

    async loadPdfJs() {
        if (window.pdfjsLib) return;
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.min.js';
            script.onload = () => {
                window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';
                resolve();
            };
            script.onerror = reject;
            document.head.appendChild(script);
        });
    },

    getPdfDocumentOptions(url) {
        return {
            url,
            cMapUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/cmaps/',
            cMapPacked: true,
            standardFontDataUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/standard_fonts/',
            useWorkerFetch: true
        };
    },

    isPdfLikeUrl(value) {
        const src = String(value || '').trim();
        return Boolean(src) && (src.startsWith('blob:') || /^https?:\/\//i.test(src) || /\.pdf($|[?#])/i.test(src));
    },

    async loadPdf(url, container) {
        try {
            const loadingTask = pdfjsLib.getDocument(this.getPdfDocumentOptions(url));
            this._pdf = await loadingTask.promise;
            this._totalPages = this._pdf.numPages;
            this._activePage = Math.min(this._activePage || 1, this._totalPages || 1);
            
            container.innerHTML = '';
            for (let i = 1; i <= this._pdf.numPages; i++) {
                const page = await this._pdf.getPage(i);
                const viewport = page.getViewport({ scale: 1.0 });
                
                const canvas = document.createElement('canvas');
                const context = canvas.getContext('2d');
                canvas.height = viewport.height;
                canvas.width = viewport.width;
                canvas.style.display = 'block';
                canvas.style.margin = '0 auto';
                
                await page.render({ canvasContext: context, viewport: viewport }).promise;
                
                const pageWrapper = document.createElement('div');
                pageWrapper.className = 'editor-page-wrapper';
                pageWrapper.style.position = 'relative';
                pageWrapper.style.width = viewport.width + 'px';
                pageWrapper.dataset.baseWidth = String(viewport.width);
                pageWrapper.dataset.baseHeight = String(viewport.height);
                pageWrapper.style.transformOrigin = 'top center';
                pageWrapper.appendChild(canvas);
                
                container.appendChild(pageWrapper);
            }
            this.updateVisiblePages();
            this.renderPageSwitcher();
            this.fitPreviewPages();
        } catch (error) {
            console.error('PDF Load Error:', error);
            this.renderUnavailableDocument(this._currentRequest?.document_snapshot || null, container, 'PDFの読み込みに失敗しました。');
        }
    },

    renderUnavailableDocument(contract, container, message = '取り込んだ原本ファイルを表示できませんでした。') {
        container.innerHTML = `
            <div style="width:min(760px, 100%); margin:40px auto; background:#fff; border:1px solid #e5e7eb; border-radius:18px; box-shadow:0 16px 40px rgba(15,23,42,0.08); padding:56px 40px; text-align:center;">
                <div style="width:64px; height:64px; margin:0 auto 18px; border-radius:20px; background:#fef2f2; color:#c53030; display:flex; align-items:center; justify-content:center; font-size:28px;">
                    <i class="fa-regular fa-file-pdf"></i>
                </div>
                <div style="font-size:18px; font-weight:700; color:#111827; margin-bottom:8px;">取り込んだ資料を表示できません</div>
                <div style="font-size:13px; color:#6b7280; line-height:1.8;">${this.escapeHtml(message)}</div>
                ${contract?.source_url ? `<div style="margin-top:18px;"><a href="${this.escapeHtml(contract.source_url)}" target="_blank" style="color:#166534; font-weight:600; text-decoration:none;">元の資料を開く</a></div>` : ''}
            </div>
        `;
        this._totalPages = 1;
        this._activePage = 1;
        this.updateVisiblePages();
        this.renderPageSwitcher();
    },

    renderDocumentFallback(contract, container) {
        const previewHtml = buildSignDocumentPreviewHtml(contract?.original_content);
        if (!previewHtml) {
            container.innerHTML = '<div style="padding:100px; color:#999;">表示できる本文データが見つかりません</div>';
            return;
        }

        const pageWrapper = document.createElement('div');
        pageWrapper.className = 'editor-page-wrapper';
        pageWrapper.style.position = 'relative';
        pageWrapper.style.width = '794px';
        pageWrapper.style.margin = '0 auto 20px auto';
        pageWrapper.style.background = '#fff';
        pageWrapper.style.borderRadius = '6px';
        pageWrapper.style.boxShadow = '0 8px 30px rgba(0,0,0,0.15)';
        pageWrapper.style.overflow = 'visible';
        pageWrapper.dataset.baseWidth = '794';
        pageWrapper.style.transformOrigin = 'top center';

        const header = document.createElement('div');
        header.style.padding = '18px 24px';
        header.style.borderBottom = '1px solid #eee';
        header.style.fontSize = '12px';
        header.style.color = '#666';
        header.innerHTML = `
            <strong style="color:#333;">抽出テキスト・プレビュー</strong>
            ${contract?.source_url ? ` <span style="margin-left:8px;"><a href="${this.escapeHtml(contract.source_url)}" target="_blank" style="color:#1a73e8;">元ソースを開く</a></span>` : ''}
        `;

        const body = document.createElement('div');
        body.style.padding = '42px 48px 56px';
        body.style.lineHeight = '1.8';
        body.style.fontSize = '13px';
        body.style.color = '#333';
        body.style.fontFamily = '"Noto Sans JP", sans-serif';
        body.style.boxSizing = 'border-box';
        body.style.background = '#fff';
        body.innerHTML = previewHtml;

        pageWrapper.appendChild(header);
        pageWrapper.appendChild(body);
        pageWrapper.dataset.baseHeight = String(Math.max(640, Math.ceil(header.offsetHeight + body.scrollHeight + 24)));
        container.innerHTML = '';
        container.appendChild(pageWrapper);
        this._totalPages = 1;
        this._activePage = 1;
        this.updateVisiblePages();
        this.renderPageSwitcher();
        this.fitPreviewPages();
    },

    fitPreviewPages() {
        const viewport = document.querySelector('.sign-recipient-viewport');
        if (!viewport) return;
        const availableWidth = Math.max(320, viewport.clientWidth - 96);
        const switcher = document.getElementById('sign-recipient-page-switcher');
        const switcherHeight = switcher && !switcher.classList.contains('is-hidden')
            ? switcher.offsetHeight + 20
            : 0;
        const availableHeight = Math.max(280, viewport.clientHeight - 96 - switcherHeight);
        document.querySelectorAll('.editor-page-wrapper').forEach((wrapper) => {
            const baseWidth = Number(wrapper.dataset.baseWidth || wrapper.offsetWidth || 794);
            const baseHeight = Number(wrapper.dataset.baseHeight || wrapper.offsetHeight || 1123);
            const scale = Math.min(1, availableWidth / baseWidth, availableHeight / baseHeight);
            wrapper.style.transform = `scale(${scale})`;
            wrapper.style.marginBottom = `${Math.max(16, Math.round(baseHeight * scale * 0.03))}px`;
            this._pageScale = scale;
        });
    },

    setActivePage(page) {
        const nextPage = Math.max(1, Math.min(Number(page) || 1, this._totalPages || 1));
        if (nextPage === this._activePage) return;
        this._activePage = nextPage;
        this.updateVisiblePages();
        this.renderRecipientFields();
        this.renderPageSwitcher();
        this.fitPreviewPages();
    },

    updateVisiblePages() {
        const wrappers = document.querySelectorAll('.editor-page-wrapper');
        wrappers.forEach((wrapper, index) => {
            const isActive = index + 1 === this._activePage;
            wrapper.style.display = isActive ? 'block' : 'none';
        });
    },

    renderPageSwitcher() {
        const root = document.getElementById('sign-recipient-page-switcher');
        if (!root) return;
        const total = Math.max(1, Number(this._totalPages || 1));
        root.classList.toggle('is-hidden', total <= 1);
        root.innerHTML = `
            <div class="sign-page-switcher-summary">
                <span class="sign-page-switcher-value">${this._activePage} / ${total}</span>
            </div>
            <div class="sign-page-switcher-actions">
                <button class="btn-dashboard" ${this._activePage <= 1 ? 'disabled' : ''} onclick="window.SignRecipient.setActivePage(${this._activePage - 1})">
                    <i class="fa-solid fa-chevron-left"></i>
                </button>
                <button class="btn-dashboard" ${this._activePage >= total ? 'disabled' : ''} onclick="window.SignRecipient.setActivePage(${this._activePage + 1})">
                    <i class="fa-solid fa-chevron-right"></i>
                </button>
            </div>
        `;
    },

    normalizePreviewText(content) {
        if (!content) return '';
        if (typeof content === 'string') return content.trim();
        if (Array.isArray(content)) {
            return content.map((item) => this.normalizePreviewText(item)).filter(Boolean).join('\n\n').trim();
        }
        if (typeof content === 'object') {
            const preamble = String(content.preamble || '').trim();
            const articles = Array.isArray(content.articles)
                ? content.articles.map((article) => {
                    const title = String(article.articleNumber || article.article || article.title || '').trim();
                    const header = String(article.header || '').trim();
                    const body = Array.isArray(article.paragraphs)
                        ? article.paragraphs.map((p) => String(p || '').trim()).filter(Boolean).join('\n')
                        : String(article.content || '').trim();
                    return [title, header, body].filter(Boolean).join('\n');
                }).filter(Boolean).join('\n\n')
                : '';
            return [preamble, articles].filter(Boolean).join('\n\n').trim();
        }
        return String(content).trim();
    },

    renderRecipientFields() {
        document.querySelectorAll('.recipient-field-marker').forEach(m => m.remove());
        
        const wrappers = document.querySelectorAll('.editor-page-wrapper');
        this._fields.forEach(field => {
            const wrapper = wrappers[field.page - 1];
            if (!wrapper) return;

            const key = String(field.id);
            const storedValue = this._fieldValues[key];
            const isSigned = this._signedFields.has(key);
            const assignedHere = Number(field.assigneeIndex ?? 0) === this._activeRecipientIndex;

            const div = document.createElement('div');
            div.className = 'recipient-field-marker';
            div.style.position = 'absolute';
            div.style.left = field.x + '%';
            div.style.top = field.y + '%';
            div.style.width = `${field.width || (field.type === 'signature' ? 180 : 130)}px`;
            div.style.height = '40px';
            div.style.transform = 'translate(-50%, -50%)';
            div.style.background = isSigned ? 'rgba(255, 255, 255, 0.9)' : (assignedHere ? 'rgba(255, 243, 205, 0.8)' : 'rgba(229, 231, 235, 0.85)');
            div.style.border = isSigned ? '2px solid #28a745' : (assignedHere ? '2px dashed #ffc107' : '1px solid #cbd5e1');
            div.style.borderRadius = '4px';
            div.style.display = 'flex';
            div.style.alignItems = 'center';
            div.style.justifyContent = 'center';
            div.style.cursor = isSigned || !assignedHere ? 'default' : 'pointer';
            div.style.boxSizing = 'border-box';
            
            if (this._isPreviewMode && !isSigned) {
                div.style.width = 'auto';
                div.style.minWidth = '0';
                div.style.height = 'auto';
                div.style.padding = '0';
                div.style.background = 'transparent';
                div.style.border = 'none';
                div.style.boxShadow = 'none';
                div.style.cursor = 'default';
                div.innerHTML = field.type === 'date'
                    ? ''
                    : `
                    <span style="font-size:12px; font-weight:600; color:#111827; background:rgba(255,255,255,0.92); padding:2px 6px; border-radius:6px;">
                        ${this.escapeHtml(field.label || '署名')}
                    </span>
                `;
            } else if (isSigned) {
                div.style.background = 'transparent';
                div.style.border = 'none';
                div.style.boxShadow = 'none';
                if (field.type === 'signature') {
                    const signatureText = String(storedValue?.text || '').trim();
                    const signatureSize = this.getSignatureSealSize(signatureText, {
                        minSize: field.width || 84,
                        maxSize: 280
                    });
                    div.style.width = signatureSize;
                    div.style.height = signatureSize;
                    const signatureHtml = storedValue?.kind === 'draw' && storedValue?.dataUrl
                        ? `<img src="${storedValue.dataUrl}" alt="signature" style="max-width:92%; max-height:28px; object-fit:contain;" />`
                        : this.buildSignatureSealHtml(signatureText, {
                            size: signatureSize,
                            fontSize: this.getSignatureSealFontSize(signatureSize)
                        });
                    div.innerHTML = signatureHtml;
                } else {
                    div.innerHTML = `<span style="font-size:14px; color:#333;">${this.escapeHtml(storedValue?.text || new Date().toLocaleDateString('ja-JP'))}</span>`;
                }
            } else {
                div.innerHTML = field.type === 'signature'
                    ? ''
                    : `
                    <div style="text-align:center;">
                        <div style="font-size:10px; font-weight:700; color:${assignedHere ? '#856404' : '#475569'};">${assignedHere ? 'ここをクリック' : '他の署名者'}</div>
                    </div>
                `;
                if (assignedHere && !this._isPreviewMode) {
                    div.onclick = () => this.signField(field.id);
                }
            }
            
            wrapper.appendChild(div);
        });

        this.updateProgress();
    },

    signField(id) {
        const field = this._fields.find((item) => String(item.id) === String(id));
        if (!field) return;
        if (field.type === 'date') {
            const key = String(field.id);
            this._fieldValues[key] = {
                kind: 'date',
                text: this.formatDateValue(field.dateFormat),
                completedAt: new Date().toISOString()
            };
            this._signedFields.add(key);
            this.renderRecipientFields();
            Notify.success('日付を入力しました');
            return;
        }
        this.openSignatureModal(id);
    },

    updateProgress() {
        const scopedFields = this.getActiveRecipientFields().filter((field) => field.required !== false);
        const remaining = scopedFields.filter((field) => !this._signedFields.has(String(field.id))).length;
        const progressEl = document.getElementById('recipient-progress');
        const finishBtn = document.getElementById('recipient-finish-btn');
        const recipient = this._currentRequest?.recipients?.[this._activeRecipientIndex];
        
        if (progressEl) {
            const recipientLabel = recipient?.display_name || (recipient?.name ? `${recipient.name}様` : (recipient?.email || '現在の署名者'));
            progressEl.textContent = remaining > 0 ? `${recipientLabel}は ${remaining} 箇所の入力が必要です` : `${recipientLabel}の入力は完了しています`;
        }
        
        if (finishBtn) {
            const canComplete = remaining === 0 && this._hasAgreed;
            finishBtn.style.display = this._isPreviewMode ? 'none' : (remaining === 0 ? 'block' : 'none');
            finishBtn.disabled = !canComplete;
            finishBtn.style.opacity = canComplete ? '1' : '0.55';
            finishBtn.style.cursor = canComplete ? 'pointer' : 'not-allowed';
        }
    },

    handleAgreementToggle(checked) {
        this._hasAgreed = checked === true;
        this.updateProgress();
    },

    syncAgreementUi() {
        const checkbox = document.getElementById('recipient-agreement-checkbox');
        if (checkbox) {
            checkbox.checked = this._hasAgreed;
            checkbox.disabled = this._isPreviewMode;
        }
    },

    updatePreviewBanner() {
        const header = document.querySelector('.sign-recipient-header');
        if (!header) return;

        const existing = document.getElementById('recipient-preview-banner');
        if (existing) existing.remove();

        if (!this._isPreviewMode) return;

        const banner = document.createElement('div');
        banner.id = 'recipient-preview-banner';
        banner.style.cssText = 'position:absolute; right:24px; bottom:-54px; display:flex; align-items:center; gap:10px; background:#111827; color:#fff; padding:10px 14px; border-radius:12px; box-shadow:0 16px 40px rgba(15,23,42,0.18); z-index:120;';
        banner.innerHTML = `
            <span style="font-size:12px; font-weight:700;">送信前プレビュー中</span>
            <button onclick="window.app.navigate('sign-editor', ${JSON.stringify(this._currentRequest.id)})" style="border:none; background:#fff; color:#111827; padding:8px 10px; border-radius:8px; font-size:12px; font-weight:700; cursor:pointer;">編集へ戻る</button>
        `;
        header.style.position = 'relative';
        header.appendChild(banner);
    },

    resolveActiveRecipientIndex() {
        const recipients = this._currentRequest?.recipients || [];
        const pendingIndex = recipients.findIndex((recipient) => recipient.status !== 'completed');
        return pendingIndex >= 0 ? pendingIndex : 0;
    },

    getActiveRecipientFields() {
        return this._fields.filter((field) => Number(field.assigneeIndex ?? 0) === this._activeRecipientIndex);
    },

    formatDateValue(format) {
        const now = new Date();
        if (format === 'iso') {
            const yyyy = now.getFullYear();
            const mm = String(now.getMonth() + 1).padStart(2, '0');
            const dd = String(now.getDate()).padStart(2, '0');
            return `${yyyy}-${mm}-${dd}`;
        }
        if (format === 'jp-long') {
            return `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;
        }
        return now.toLocaleDateString('ja-JP');
    },

    escapeHtml(str) {
        if (!str) return '';
        return str.replace(/[&<>"']/g, m => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[m]));
    },

    getSignatureSealSize(text, options = {}) {
        const value = String(text || '').trim();
        const base = Number(options.base || 84);
        const step = Number(options.step || 18);
        const unit = Number(options.unit || 4);
        const minSize = Number(options.minSize || 0);
        const maxSize = Number(options.maxSize || 240);
        const length = Math.max(1, Array.from(value).length);
        const extra = Math.max(0, Math.ceil((length - unit) / unit));
        const computed = base + (extra * step);
        return `${Math.max(minSize || base, Math.min(maxSize, computed))}px`;
    },

    getSignatureSealFontSize(size) {
        const numericSize = Number.parseInt(size, 10) || 84;
        return `${Math.max(10, Math.min(32, Math.round(numericSize * 0.16)))}px`;
    },

    resolvePreviewUrl(contract) {
        const candidates = [
            contract?.completed_document_url,
            contract?.pdf_url,
            contract?.pdf_storage_path
        ];
        for (const raw of candidates) {
            const value = resolveBackendAssetUrl(raw);
            if (!value) continue;
            if (value.startsWith('blob:') || /^https?:\/\//i.test(value)) {
                return value;
            }
        }
        return '';
    },

    buildSignatureSealHtml(text, options = {}) {
        const value = String(text || '').trim();
        const size = options.size || this.getSignatureSealSize(value, options);
        const fontSize = options.fontSize || this.getSignatureSealFontSize(size);
        return `
            <span style="
                display:inline-flex;
                align-items:center;
                justify-content:center;
                width:${size};
                height:${size};
                border:2px solid #c53030;
                border-radius:50%;
                color:#c53030;
                background:rgba(197, 48, 48, 0.03);
                font-family:'Noto Serif JP','Yu Mincho','Hiragino Mincho ProN',serif;
                font-size:${fontSize};
                font-weight:700;
                letter-spacing:0.04em;
                line-height:1.2;
                box-sizing:border-box;
                white-space:normal;
                text-align:center;
                word-break:break-all;
                padding:10px;
            ">${this.escapeHtml(value)}</span>
        `;
    },

    updateSignatureTextPreview(value) {
        const namePreview = document.getElementById('sig-name-preview');
        if (!namePreview) return;
        const text = String(value || '').trim();
        if (!text) {
            namePreview.innerHTML = '<span style="font-size:16px; font-weight:600; color:#9ca3af;">署名プレビュー</span>';
            return;
        }
        namePreview.innerHTML = this.buildSignatureSealHtml(text, {
            fontSize: '28px',
            size: '108px'
        });
    },

    ensureSignatureModal() {
        if (document.getElementById('recipient-signature-overlay')) return;
        const overlay = document.createElement('div');
        overlay.id = 'recipient-signature-overlay';
        overlay.style.cssText = 'display:none; position:fixed; inset:0; background:rgba(15,23,42,0.5); z-index:3000; align-items:center; justify-content:center; padding:24px;';
        overlay.innerHTML = `
            <div style="width:min(720px, 100%); background:#fff; border-radius:18px; box-shadow:0 30px 80px rgba(0,0,0,0.25); overflow:hidden;">
                <div style="display:flex; align-items:center; justify-content:space-between; padding:18px 24px; border-bottom:1px solid #eee;">
                    <div>
                        <div style="font-size:18px; font-weight:700; color:#111827;">署名を入力</div>
                        <div style="font-size:12px; color:#6b7280; margin-top:4px;">名前入力または手書きで署名できます</div>
                    </div>
                    <button id="recipient-signature-close" style="border:none; background:none; font-size:24px; color:#6b7280; cursor:pointer;">&times;</button>
                </div>
                <div style="padding:20px 24px 24px;">
                    <div style="display:flex; gap:10px; margin-bottom:16px;">
                        <button id="sig-mode-text" style="padding:10px 14px; border-radius:999px; border:1px solid #d1d5db; background:#111827; color:#fff; cursor:pointer;">名前で署名</button>
                        <button id="sig-mode-draw" style="padding:10px 14px; border-radius:999px; border:1px solid #d1d5db; background:#fff; color:#111827; cursor:pointer;">描画で署名</button>
                    </div>
                    <div id="sig-panel-text">
                        <input id="sig-name-input" type="text" placeholder="署名する名前を入力" style="width:100%; padding:14px 16px; border:1px solid #d1d5db; border-radius:12px; font-size:18px; margin-bottom:14px;">
                        <div id="sig-name-preview" style="min-height:84px; display:flex; align-items:center; justify-content:center; border:1px dashed #d1d5db; border-radius:14px; background:#fffdf8;"><span style="font-size:16px; font-weight:600; color:#9ca3af;">署名プレビュー</span></div>
                    </div>
                    <div id="sig-panel-draw" style="display:none;">
                        <canvas id="sig-draw-canvas" width="620" height="220" style="width:100%; height:220px; border:1px dashed #d1d5db; border-radius:14px; background:#fff;"></canvas>
                        <div style="display:flex; justify-content:flex-end; margin-top:10px;">
                            <button id="sig-clear-draw" style="padding:8px 12px; border:1px solid #d1d5db; background:#fff; border-radius:10px; cursor:pointer;">描画をクリア</button>
                        </div>
                    </div>
                    <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:18px;">
                        <button id="sig-cancel-btn" style="padding:10px 14px; border:1px solid #d1d5db; background:#fff; border-radius:12px; cursor:pointer;">キャンセル</button>
                        <button id="sig-apply-btn" style="padding:10px 16px; border:none; background:#111827; color:#fff; border-radius:12px; cursor:pointer;">署名を適用</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const close = () => {
            overlay.style.display = 'none';
            this._activeFieldId = null;
        };
        document.getElementById('recipient-signature-close').onclick = close;
        document.getElementById('sig-cancel-btn').onclick = close;
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) close();
        });

        const textBtn = document.getElementById('sig-mode-text');
        const drawBtn = document.getElementById('sig-mode-draw');
        const textPanel = document.getElementById('sig-panel-text');
        const drawPanel = document.getElementById('sig-panel-draw');
        const switchMode = (mode) => {
            textPanel.style.display = mode === 'text' ? '' : 'none';
            drawPanel.style.display = mode === 'draw' ? '' : 'none';
            textBtn.style.background = mode === 'text' ? '#111827' : '#fff';
            textBtn.style.color = mode === 'text' ? '#fff' : '#111827';
            drawBtn.style.background = mode === 'draw' ? '#111827' : '#fff';
            drawBtn.style.color = mode === 'draw' ? '#fff' : '#111827';
            overlay.dataset.mode = mode;
        };
        textBtn.onclick = () => switchMode('text');
        drawBtn.onclick = () => switchMode('draw');
        switchMode('text');

        const nameInput = document.getElementById('sig-name-input');
        nameInput.addEventListener('input', () => {
            this.updateSignatureTextPreview(nameInput.value);
        });

        const canvas = document.getElementById('sig-draw-canvas');
        const ctx = canvas.getContext('2d');
        ctx.lineWidth = 2.2;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = '#7c2d12';
        const state = { drawing: false, moved: false };
        this._drawState = state;

        const getPos = (event) => {
            const rect = canvas.getBoundingClientRect();
            const scaleX = canvas.width / rect.width;
            const scaleY = canvas.height / rect.height;
            const point = event.touches ? event.touches[0] : event;
            return {
                x: (point.clientX - rect.left) * scaleX,
                y: (point.clientY - rect.top) * scaleY
            };
        };
        const start = (event) => {
            state.drawing = true;
            const pos = getPos(event);
            ctx.beginPath();
            ctx.moveTo(pos.x, pos.y);
            event.preventDefault();
        };
        const move = (event) => {
            if (!state.drawing) return;
            state.moved = true;
            const pos = getPos(event);
            ctx.lineTo(pos.x, pos.y);
            ctx.stroke();
            event.preventDefault();
        };
        const end = () => {
            state.drawing = false;
        };
        canvas.addEventListener('mousedown', start);
        canvas.addEventListener('mousemove', move);
        window.addEventListener('mouseup', end);
        canvas.addEventListener('touchstart', start, { passive: false });
        canvas.addEventListener('touchmove', move, { passive: false });
        window.addEventListener('touchend', end);

        document.getElementById('sig-clear-draw').onclick = () => {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            state.moved = false;
        };

        document.getElementById('sig-apply-btn').onclick = () => {
            const mode = overlay.dataset.mode || 'text';
            const fieldId = this._activeFieldId;
            if (!fieldId) return;
            const key = String(fieldId);
            if (mode === 'text') {
                const text = nameInput.value.trim();
                if (!text) {
                    Notify.warning('署名する名前を入力してください');
                    return;
                }
                this._fieldValues[key] = {
                    kind: 'text',
                    text,
                    completedAt: new Date().toISOString()
                };
            } else {
                if (!state.moved) {
                    Notify.warning('署名を描画してください');
                    return;
                }
                this._fieldValues[key] = {
                    kind: 'draw',
                    dataUrl: canvas.toDataURL('image/png'),
                    completedAt: new Date().toISOString()
                };
            }
            this._signedFields.add(key);
            close();
            this.renderRecipientFields();
            Notify.success('署名を適用しました');
        };
    },

    openSignatureModal(fieldId) {
        const overlay = document.getElementById('recipient-signature-overlay');
        if (!overlay) return;
        this._activeFieldId = fieldId;
        overlay.style.display = 'flex';
        const field = this._fields.find((item) => String(item.id) === String(fieldId));
        const existing = this._fieldValues[String(fieldId)];
        const nameInput = document.getElementById('sig-name-input');
        const canvas = document.getElementById('sig-draw-canvas');
        const ctx = canvas.getContext('2d');
        const textBtn = document.getElementById('sig-mode-text');
        const drawBtn = document.getElementById('sig-mode-draw');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (this._drawState) this._drawState.moved = false;
        nameInput.value = existing?.kind === 'text' ? existing.text || '' : '';
        this.updateSignatureTextPreview(nameInput.value);
        const signMode = field?.signMode || 'both';
        textBtn.style.display = signMode === 'draw' ? 'none' : '';
        drawBtn.style.display = signMode === 'text' ? 'none' : '';
        if (existing?.kind === 'draw' && existing?.dataUrl) {
            const img = new Image();
            img.onload = () => {
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                if (this._drawState) this._drawState.moved = true;
            };
            img.src = existing.dataUrl;
            document.getElementById('sig-mode-draw').click();
        } else {
            document.getElementById(signMode === 'draw' ? 'sig-mode-draw' : 'sig-mode-text').click();
        }
    },

    async complete() {
        if (this._isPreviewMode) {
            window.app.navigate('sign-editor', this._currentRequest.id);
            return;
        }

        if (!this._hasAgreed) {
            Notify.warning('内容確認と署名同意のチェックをお願いします');
            return;
        }

        Notify.info('署名を完了として報告中...');
        
        try {
            const activeRecipient = this._currentRequest?.recipients?.[this._activeRecipientIndex] || null;
            const activeEmail = String(activeRecipient?.email || '').trim();
            const recipientToken = activeEmail ? this._currentRequest?.recipientTokens?.[activeEmail] : '';

            if (recipientToken) {
                const signatures = this.getSubmitSignaturesPayload();
                const response = await fetch(`${API_BASE}/api/sign/submit`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        token: recipientToken,
                        signatures
                    })
                });
                const result = await response.json();
                if (!response.ok || !result.success) {
                    throw new Error(result.error || '完了報告に失敗しました');
                }
                this._currentRequest = result.data?.request || this._currentRequest;
                Notify.success('署名が正常に完了しました');
                setTimeout(() => {
                    window.app?.navigate?.('sign');
                }, 1200);
                return;
            }

            const nowIso = new Date().toISOString();
            const recipientStatus = (this._currentRequest.recipients || []).map((recipient, index) => ({
                ...recipient,
                status: index === this._activeRecipientIndex ? 'completed' : recipient.status || 'pending',
                consented_at: index === this._activeRecipientIndex ? (recipient.consented_at || nowIso) : recipient.consented_at,
                signed_at: index === this._activeRecipientIndex ? nowIso : recipient.signed_at
            }));
            const response = await fetch(toApiUrl(`/webhook/${this._currentRequest.firma_request_id ? 'firma' : 'zoho'}`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(this._currentRequest.firma_request_id ? {
                    event_type: 'signing_request.completed',
                    data: {
                        signing_request_id: this._currentRequest.firma_request_id,
                        recipients: [
                            {
                                email: this._currentRequest?.recipients?.[this._activeRecipientIndex]?.email || ''
                            }
                        ]
                    }
                } : {
                    request_id: this._currentRequest.zoho_request_id,
                    operation_type: 'document_completed'
                })
            });

            if (response.ok) {
                await dbService.updateSignRequest(this._currentRequest.id, {
                    completed_fields: this._fieldValues,
                    recipients: recipientStatus,
                    signature_completed_at: nowIso
                });
                Notify.success('署名が正常に完了しました！');
                setTimeout(() => {
                    window.app?.navigate?.('sign');
                }, 2000);
            } else {
                throw new Error('完了報告に失敗しました');
            }
        } catch (error) {
            Notify.error(`エラー: ${error.message}`);
        }
    },

    getSubmitSignaturesPayload() {
        return this.getActiveRecipientFields().map((field) => {
            const value = this._fieldValues[String(field.id)];
            if (!value || field.type !== 'signature') return null;
            if (value.kind === 'draw' && value.dataUrl) {
                return {
                    fieldId: String(field.id),
                    type: 'draw',
                    dataUrl: value.dataUrl
                };
            }
            if (value.kind === 'text' && value.text) {
                return {
                    fieldId: String(field.id),
                    type: 'text',
                    fontText: value.text,
                    dataUrl: this.renderTextSignatureDataUrl(value.text, field)
                };
            }
            return null;
        }).filter(Boolean);
    },

    renderTextSignatureDataUrl(text, field = {}) {
        const value = String(text || '').trim();
        if (!value) return '';
        const canvas = document.createElement('canvas');
        const width = Math.max(240, Math.min(900, Math.round((Number(field?.width || 180) * 3.2))));
        const height = Math.max(96, Math.min(280, Math.round((Number(field?.height || 48) * 3.4))));
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return '';

        ctx.clearRect(0, 0, width, height);
        const baseSize = Math.max(28, Math.min(78, Math.round(height * 0.48)));
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.fillStyle = '#00008b';

        let fontSize = baseSize;
        const applyFont = () => {
            ctx.font = `${fontSize}px serif`;
        };
        applyFont();

        const maxWidth = width * 0.9;
        while (fontSize > 18 && ctx.measureText(value).width > maxWidth) {
            fontSize -= 2;
            applyFont();
        }

        ctx.fillText(value, Math.round(width * 0.05), Math.round(height / 2));
        return canvas.toDataURL('image/png');
    }
};
