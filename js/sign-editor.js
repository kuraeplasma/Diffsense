/**
 * SignEditor - Mock Document Editor for Field Placement
 */
import { Notify } from './notify.js';
import { dbService } from './db-service.js';
import { buildSignDocumentPreviewHtml } from './sign-document-preview.js';
import { resolveBackendAssetUrl } from './api-base.js';

export const SignEditor = {
    _currentRequest: null,
    _currentDoc: null,
    _pdf: null,
    _fields: [],
    _fieldStyles: {},
    _addMode: null, // 'signature' or 'date'
    _recipients: [],
    _previewMode: 'pdf',
    _pageScale: 1,
    _dragFieldId: null,
    _selectedFieldId: null,
    _pointerDrag: null,
    _pointerBound: false,
    _inlinePreviewMode: false,
    _activePage: 1,
    _totalPages: 1,
    _showRecipientValidation: false,
    _isSending: false,
    _stylePanel: { open: false, fieldId: null },
    _stylePanelTab: 'font',
    _selectedStyleFontId: null,
    _draftSaveTimer: null,
    _draftSavePromise: null,
    _styleFontsLoaded: false,
    _styleFonts: [
        { id: 'font-a', name: '契約書 明朝', family: '"Yu Mincho","Hiragino Mincho ProN","Noto Serif JP",serif' },
        { id: 'font-b', name: '標準 明朝', family: '"BIZ UDPMincho","Yu Mincho","MS PMincho",serif' },
        { id: 'font-c', name: '標準 ゴシック', family: '"BIZ UDPGothic","Yu Gothic","Meiryo",sans-serif' },
        { id: 'font-d', name: '契約書 ゴシック', family: '"Hiragino Sans","Noto Sans JP","Yu Gothic",sans-serif' }
    ],

    async init(app, id) {
        // Fast track: Look for draft passed from previous screen
        if (window._lastSignDraft && String(window._lastSignDraft.id) === String(id)) {
            this._currentRequest = window._lastSignDraft;
        } else {
            Notify.info('エディタを読み込み中...');
            const requests = await dbService.getSignRequests();
            this._currentRequest = requests.find(r => String(r.id) === String(id));
        }
        
        if (!this._currentRequest) {
            Notify.error('依頼データが見つかりません');
            return;
        }

        // Get contract to find PDF URL
        const snapshot = this._currentRequest.document_snapshot || this._currentRequest.contract_snapshot || null;
        const contracts = snapshot ? [] : await dbService.getContracts();
        const cid = this._currentRequest.contract_id || this._currentRequest.contractId;
        const contract = snapshot
            || contracts.find(c => String(c.id) === String(cid))
            || contracts.find(c => String(c.name || '') === String(this._currentRequest.document_name || ''));
        
        if (!contract) {
            Notify.error('契約データが見つかりません');
            return;
        }
        this._currentDoc = contract;

        const canvasContainer = document.getElementById('sign-editor-canvas-container');
        if (!canvasContainer) return;

        // Load existing data
        this._fields = (this._currentRequest.fields || []).map((field) => (
            field?.type === 'signature'
                ? { ...field, signerName: '' }
                : field
        ));
        this._fieldStyles = this.cloneValue(this._currentRequest.fieldStyles || {});
        this._recipients = (this._currentRequest.recipients && this._currentRequest.recipients.length > 0) 
            ? [...this._currentRequest.recipients] 
            : [{ name: '', email: '' }];

        this.renderRecipients();
        this.ensurePointerDragBinding();
        this.bindToolDragSources();
        this.renderFieldSettings();
        this.renderPageSwitcher();
        this.updatePreviewToggleButton();

        const previewUrl = this.resolvePreviewUrl(contract);
        const isPdfPreview = this.isPdfLikeUrl(previewUrl);

        if (isPdfPreview) {
            await this.loadPdfJs();
            await this.loadPdf(previewUrl, canvasContainer);
            this._previewMode = 'pdf';
        } else {
            const hasFallbackContent = Boolean(
                contract?.original_content
                || this._currentRequest?.document_snapshot?.original_content
                || this._currentRequest?.contract_snapshot?.original_content
            );
            if (hasFallbackContent) {
                this.renderDocumentFallback(contract, canvasContainer);
                this._previewMode = 'fallback';
            } else {
                this.renderUnavailableDocument(contract, canvasContainer);
                this._previewMode = 'unavailable';
            }
        }

        this.renderFields();
        this.fitPreviewPages();
        window.addEventListener('resize', () => this.fitPreviewPages());
        
        window.SignEditor = this;
    },

    // --- Recipient Management ---
    addRecipientRow() {
        this._recipients.push({ name: '', email: '' });
        this.renderRecipients();
        this.scheduleDraftSave();
    },

    removeRecipientRow(index) {
        if (this._recipients.length <= 1) {
            Notify.warning('署名者は最低1名必要です');
            return;
        }
        this._recipients.splice(index, 1);
        this.renderRecipients();
        this.scheduleDraftSave();
    },

    renderRecipients() {
        const container = document.getElementById('editor-recipients-list');
        if (!container) return;

        container.innerHTML = this._recipients.map((rec, idx) => `
            <div class="recipient-edit-row" data-index="${idx}" style="margin-bottom:12px; background:#f9f9f9; padding:12px; border-radius:8px; border:1px solid #eee; position:relative;">
                <label style="display:block; font-size:11px; font-weight:700; color:#6b7280; margin-bottom:6px;">メールアドレス</label>
                <input type="email" placeholder="name@example.com" class="rec-email-input" value="${this.escapeHtml(rec.email)}" 
                       style="width:100%; border:1px solid #d9dde3; border-radius:10px; background:#fff; font-size:13px; color:#111827; outline:none; padding:10px 12px;"
                       oninput="window.SignEditor.handleRecipientInput(${idx}, 'email', this.value)"
                       onchange="window.SignEditor.handleRecipientInput(${idx}, 'email', this.value)">
                <div class="recipient-email-error" data-index="${idx}" style="display:none; font-size:11px; color:#d73a49; margin-top:6px;"></div>
                <label style="display:block; font-size:11px; font-weight:700; color:#6b7280; margin:10px 0 6px;">宛名</label>
                <input type="text" placeholder="山田 太郎" class="rec-name-input" value="${this.escapeHtml(rec.name)}" 
                       style="width:100%; border:1px solid #d9dde3; border-radius:10px; background:#fff; font-size:13px; font-weight:600; outline:none; padding:10px 12px;" 
                       oninput="window.SignEditor.handleRecipientInput(${idx}, 'name', this.value)"
                       onchange="window.SignEditor.handleRecipientInput(${idx}, 'name', this.value)">
                <div style="font-size:11px; color:#6b7280; margin-top:6px;">${rec.name ? `案内メール本文には「${this.escapeHtml(rec.name)}様」と記載されます。` : 'ここで入力した名前が、案内メール本文に「〇〇様」として記載されます。'}</div>
                ${this._recipients.length > 1 ? `
                    <button onclick="window.SignEditor.removeRecipientRow(${idx})" style="position:absolute; top:8px; right:8px; background:none; border:none; color:#ccc; cursor:pointer; font-size:12px;">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                ` : ''}
            </div>
        `).join('');

        this._fields = this._fields.map((field) => ({
            ...field,
            assigneeIndex: Math.min(this._recipients.length - 1, Math.max(0, Number(field.assigneeIndex ?? 0)))
        }));
        this.renderFieldSettings();
        this.updateRecipientValidationState();
    },

    syncRecipientsFromDom() {
        const rows = document.querySelectorAll('#editor-recipients-list .recipient-edit-row');
        rows.forEach((row, index) => {
            const nameInput = row.querySelector('.rec-name-input');
            const emailInput = row.querySelector('.rec-email-input');
            if (!this._recipients[index]) {
                this._recipients[index] = { name: '', email: '' };
            }
            this._recipients[index].name = String(nameInput?.value || '').trim();
            this._recipients[index].email = String(emailInput?.value || '').trim();
        });
    },

    handleRecipientInput(index, field, value) {
        if (!this._recipients[index]) {
            this._recipients[index] = { name: '', email: '' };
        }
        this._recipients[index][field] = String(value || '');
        this.updateRecipientValidationState();
        this.scheduleDraftSave();
    },

    validateEmail(email) {
        const value = String(email || '').trim();
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    },

    getRecipientValidation() {
        return this._recipients.map((recipient) => {
            const name = String(recipient?.name || '').trim();
            const email = String(recipient?.email || '').trim();
            if (!name) {
                return { valid: false, message: '宛名を入力してください', field: 'name' };
            }
            if (!email) {
                return { valid: false, message: 'メールアドレスを入力してください', field: 'email' };
            }
            if (!this.validateEmail(email)) {
                return { valid: false, message: 'メールアドレスの形式が正しくありません', field: 'email' };
            }
            return { valid: true, message: '', field: null };
        });
    },

    updateRecipientValidationState(options = {}) {
        const force = options.force === true;
        if (force) {
            this._showRecipientValidation = true;
        }
        const validations = this.getRecipientValidation();
        const shouldShow = this._showRecipientValidation;
        const rows = document.querySelectorAll('#editor-recipients-list .recipient-edit-row');
        rows.forEach((row, index) => {
            const input = row.querySelector('.rec-email-input');
            const nameInput = row.querySelector('.rec-name-input');
            const error = row.querySelector('.recipient-email-error');
            const state = validations[index] || { valid: true, message: '', field: null };
            if (input) {
                const isEmailInvalid = shouldShow && !state.valid && state.field === 'email';
                input.style.borderColor = isEmailInvalid ? '#d73a49' : '#d9dde3';
                input.style.boxShadow = isEmailInvalid ? '0 0 0 3px rgba(215, 58, 73, 0.12)' : 'none';
            }
            if (nameInput) {
                const isNameInvalid = shouldShow && !state.valid && state.field === 'name';
                nameInput.style.borderColor = isNameInvalid ? '#d73a49' : '#d9dde3';
                nameInput.style.boxShadow = isNameInvalid ? '0 0 0 3px rgba(215, 58, 73, 0.12)' : 'none';
            }
            if (error) {
                error.style.display = shouldShow && !state.valid ? 'block' : 'none';
                error.textContent = shouldShow && !state.valid ? state.message : '';
            }
        });

        const sendButton = document.getElementById('sign-editor-send-btn');
        if (sendButton) {
            sendButton.disabled = false;
            sendButton.style.opacity = '1';
            sendButton.style.cursor = 'pointer';
        }
        return validations;
    },

    deriveRecipientName(email, fallbackIndex = 0) {
        const localPart = String(email || '').trim().split('@')[0] || '';
        return localPart || `署名者${fallbackIndex + 1}`;
    },

    formatRecipientHonorific(recipient, fallbackIndex = 0) {
        const baseName = String(recipient?.name || '').trim() || this.deriveRecipientName(recipient?.email, fallbackIndex);
        return `${baseName}様`;
    },

    getRecipientFieldOptionLabel(recipient, fallbackIndex = 0) {
        return String(recipient?.name || '').trim() || `送信先${fallbackIndex + 1}`;
    },

    getPreviewDateValue(format) {
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

    getPageDimensionsPayload() {
        const dimensions = {};
        document.querySelectorAll('#sign-editor-canvas-container .editor-page-wrapper').forEach((wrapper, index) => {
            const pageNumber = index + 1;
            dimensions[pageNumber] = {
                width: Number(wrapper.dataset.baseWidth || wrapper.offsetWidth || 0),
                height: Number(wrapper.dataset.baseHeight || wrapper.offsetHeight || 0)
            };
        });
        return dimensions;
    },

    cloneValue(value) {
        if (value === null || value === undefined) return value;
        try {
            return JSON.parse(JSON.stringify(value));
        } catch {
            return value;
        }
    },

    getPreviewSignatureValue(field) {
        return '署名';
    },

    getSignatureSealSize(text, options = {}) {
        if (options.fixedSize) {
            return `${Number(options.fixedSize)}px`;
        }
        const value = String(text || '').trim();
        const base = Number(options.base || 84);
        const step = Number(options.step || 20);
        const unit = Number(options.unit || 4);
        const length = Math.max(1, Array.from(value).length);
        const extra = Math.max(0, Math.ceil((length - unit) / unit));
        return `${base + (extra * step)}px`;
    },

    getSignatureSealFontSize(size) {
        const numericSize = Number.parseInt(size, 10) || 88;
        return `${Math.max(10, Math.min(32, Math.round(numericSize * 0.16)))}px`;
    },

    buildSignatureSealHtml(text, options = {}) {
        const value = String(text || '').trim();
        const fontSize = options.fontSize || '18px';
        const size = options.size || this.getSignatureSealSize(value, options);
        const fontFamily = options.fontFamily || "'Noto Serif JP','Yu Mincho','Hiragino Mincho ProN',serif";
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
                font-family:${fontFamily};
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

    getFieldStyle(fieldId) {
        return this._fieldStyles[String(fieldId)] || null;
    },

    getSignatureDisplayHtml(field, size) {
        const signatureText = String(field.signerName || '').trim() || '署名';
        const style = this.getFieldStyle(field.id);
        const fontSize = this.getSignatureSealFontSize(size);
        return `
            <span style="
                font-family:${style?.type === 'font' && style.fontFamily ? style.fontFamily : "'Noto Serif JP','Yu Mincho','Hiragino Mincho ProN',serif"};
                font-size:${fontSize};
                font-weight:700;
                color:#c53030;
                letter-spacing:0.04em;
                text-align:center;
                word-break:break-all;
                line-height:1.2;
                padding:10px;
                display:block;
            ">${this.escapeHtml(signatureText)}</span>
        `;
    },

    getStyleBadgeLabel(fieldId) {
        const style = this.getFieldStyle(fieldId);
        if (!style) return '';
        return style.type === 'font' ? (style.fontName || '文字入力') : '文字入力';
    },

    syncDraftState(patch = {}) {
        this._currentRequest = {
            ...this._currentRequest,
            ...patch,
            fields: this.cloneValue(this._fields),
            recipients: this.cloneValue(this._recipients),
            fieldStyles: this.cloneValue(this._fieldStyles)
        };
        window._lastSignDraft = this._currentRequest;
    },

    scheduleDraftSave(delay = 260) {
        this.syncDraftState();
        if (this._draftSaveTimer) {
            clearTimeout(this._draftSaveTimer);
        }
        this._draftSaveTimer = setTimeout(() => {
            this._draftSaveTimer = null;
            this.persistDraftState().catch((error) => {
                console.warn('SignEditor draft save skipped:', error?.message || error);
            });
        }, delay);
    },

    async persistDraftState() {
        if (!this._currentRequest?.id) return null;
        if (this._draftSavePromise) return this._draftSavePromise;
        this._draftSavePromise = dbService.updateSignRequest(this._currentRequest.id, {
            recipients: this._recipients,
            fields: this._fields,
            fieldStyles: this._fieldStyles,
            page_dimensions: this.getPageDimensionsPayload()
        }).then((result) => {
            if (result) {
                this._currentRequest = { ...this._currentRequest, ...result };
                window._lastSignDraft = this._currentRequest;
            }
            return result;
        }).finally(() => {
            this._draftSavePromise = null;
        });
        return this._draftSavePromise;
    },

    ensureStylePanelDom() {
        if (document.getElementById('sign-style-overlay') && document.getElementById('sign-style-panel')) {
            return;
        }
        const wrapper = document.createElement('div');
        wrapper.innerHTML = `
            <div id="sign-style-overlay" class="sign-style-overlay"></div>
            <div id="sign-style-panel" class="sign-style-panel" role="dialog" aria-modal="true" aria-labelledby="sign-style-title">
                <div class="sign-style-panel__header">
                    <div>
                        <div id="sign-style-title" class="sign-style-panel__title">フォントを選択</div>
                    </div>
                    <button type="button" class="sign-style-panel__close" aria-label="閉じる" onclick="window.SignEditor.closeStylePanel()">&times;</button>
                </div>
                <div class="sign-style-panel__body">
                    <section id="sign-style-panel-font" class="sign-style-panel__section">
                        <div id="sign-style-font-options" class="sign-style-panel__font-options"></div>
                    </section>
                </div>
                <div class="sign-style-panel__footer">
                    <button type="button" class="sign-style-panel__secondary-btn" onclick="window.SignEditor.closeStylePanel()">キャンセル</button>
                    <button type="button" class="sign-style-panel__primary-btn" onclick="window.SignEditor.applyStyle()">このスタイルを設定</button>
                </div>
            </div>
        `;
        document.body.appendChild(wrapper);
        const overlay = document.getElementById('sign-style-overlay');
        overlay?.addEventListener('click', () => this.closeStylePanel());
    },

    initStylePanel() {
        this.ensureStylePanelDom();
    },

    openStylePanel(fieldId) {
        const field = this._fields.find((item) => String(item.id) === String(fieldId));
        if (!field || (field.type !== 'signature' && field.type !== 'initials')) return;
        this.ensureStylePanelDom();
        this._stylePanel = { open: true, fieldId: String(fieldId) };
        this._stylePanelTab = 'font';
        const savedStyle = this.getFieldStyle(fieldId);
        this._selectedStyleFontId = savedStyle?.type === 'font'
            ? (this._styleFonts.find((font) => font.family === savedStyle.fontFamily)?.id || savedStyle.fontId || null)
            : (this._styleFonts[0]?.id || null);
        const overlay = document.getElementById('sign-style-overlay');
        const panel = document.getElementById('sign-style-panel');
        if (overlay) overlay.style.display = 'block';
        if (panel) panel.style.display = 'flex';
        this.renderFontOptions();
    },

    closeStylePanel() {
        this._stylePanel = { open: false, fieldId: null };
        const overlay = document.getElementById('sign-style-overlay');
        const panel = document.getElementById('sign-style-panel');
        if (overlay) overlay.style.display = 'none';
        if (panel) panel.style.display = 'none';
    },

    switchStyleTab() {
        this._stylePanelTab = 'font';
        this.renderFontOptions();
    },

    ensureStyleFonts() {
        this._styleFontsLoaded = true;
    },

    renderFontOptions() {
        this.ensureStyleFonts();
        const container = document.getElementById('sign-style-font-options');
        if (!container) return;
        const field = this._fields.find((item) => String(item.id) === String(this._stylePanel.fieldId));
        const sampleText = this.getPreviewSignatureValue(field || {});
        container.innerHTML = this._styleFonts.map((font) => `
            <button type="button" class="sign-style-font-option ${this._selectedStyleFontId === font.id ? 'is-selected' : ''}" onclick="window.SignEditor.selectStyleFont('${font.id}')">
                <span class="sign-style-font-option__label">${this.escapeHtml(font.name)}</span>
                <span class="sign-style-font-option__sample" style="font-family:${font.family};">${this.escapeHtml(sampleText)}</span>
            </button>
        `).join('');
    },

    selectStyleFont(fontId) {
        this._selectedStyleFontId = fontId;
        this.renderFontOptions();
    },

    applyStyle() {
        const fieldId = this._stylePanel.fieldId;
        if (!fieldId) {
            this.closeStylePanel();
            return;
        }
        if (!this._selectedStyleFontId) {
            Notify.warning('フォントを選択してください');
            return;
        }
        const font = this._styleFonts.find((item) => item.id === this._selectedStyleFontId);
        if (!font) {
            Notify.warning('フォントを選択してください');
            return;
        }
        this._fieldStyles[String(fieldId)] = {
            type: 'font',
            fontId: font.id,
            fontName: font.name,
            fontFamily: font.family
        };
        this.syncDraftState();
        this.renderFields();
        this.renderFieldSettings();
        this.closeStylePanel();
        this.scheduleDraftSave();
    },

    escapeHtml(str) {
        if (!str) return '';
        return str.replace(/[&<>"']/g, m => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[m]));
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
            if (this.isPdfLikeUrl(value)) {
                return value;
            }
        }
        return '';
    },

    isPdfLikeUrl(value) {
        const src = String(value || '').trim();
        return Boolean(src) && (
            src.startsWith('blob:')
            || /\.pdf($|[?#])/i.test(src)
            || /\/uploads\//i.test(src)
            || /firebasestorage\.googleapis\.com/i.test(src)
        );
    },

    // --- Tool Management ---
    setTool(mode) {
        if (this._addMode === mode) {
            this._addMode = null;
            this.updateToolUI();
            return;
        }
        this._addMode = mode;
        this.updateToolUI();
    },

    updateToolUI() {
        const sigBtn = document.getElementById('tool-signature');
        const dateBtn = document.getElementById('tool-date');
        
        if (sigBtn) sigBtn.style.background = this._addMode === 'signature' ? 'var(--sign-bg-light)' : '';
        if (sigBtn) sigBtn.style.borderColor = this._addMode === 'signature' ? 'var(--sign-primary)' : '';
        
        if (dateBtn) dateBtn.style.background = this._addMode === 'date' ? 'var(--sign-bg-light)' : '';
        if (dateBtn) dateBtn.style.borderColor = this._addMode === 'date' ? 'var(--sign-primary)' : '';
        if (sigBtn) sigBtn.disabled = this._inlinePreviewMode;
        if (dateBtn) dateBtn.disabled = this._inlinePreviewMode;
        if (sigBtn) sigBtn.style.opacity = this._inlinePreviewMode ? '0.55' : '1';
        if (dateBtn) dateBtn.style.opacity = this._inlinePreviewMode ? '0.55' : '1';
        
        const viewport = document.querySelector('.sign-editor-viewport');
        if (viewport) viewport.style.cursor = this._inlinePreviewMode ? 'default' : (this._addMode ? 'copy' : '');
    },

    updatePreviewToggleButton() {
        const button = document.getElementById('sign-editor-preview-toggle');
        if (!button) return;
        button.textContent = this._inlinePreviewMode ? '編集表示に戻る' : '受信者プレビュー';
    },

    bindToolDragSources() {
        [
            { id: 'tool-signature', type: 'signature' },
            { id: 'tool-date', type: 'date' }
        ].forEach(({ id, type }) => {
            const button = document.getElementById(id);
            if (!button || button.dataset.pointerBound === 'true') return;
            button.dataset.pointerBound = 'true';
            button.addEventListener('pointerdown', (event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                this.startPointerDrag({
                    mode: 'new',
                    type,
                    pointerId: event.pointerId,
                    originEvent: event
                });
            });
        });
    },

    ensurePointerDragBinding() {
        if (this._pointerBound) return;
        this._pointerBound = true;
        window.addEventListener('pointermove', (event) => this.handlePointerMove(event));
        window.addEventListener('pointerup', (event) => this.handlePointerUp(event));
        window.addEventListener('pointercancel', (event) => this.handlePointerUp(event));
    },

    startPointerDrag({ mode, type = null, fieldId = null, pointerId, originEvent }) {
        if (this._inlinePreviewMode) return;
        this._pointerDrag = { mode, type, fieldId, pointerId };
        if (mode === 'new') {
            this._addMode = type;
            this.updateToolUI();
        }
        this.renderFields();
        this.createPointerGhost(
            mode === 'move'
                ? '枠を移動'
                : mode === 'resize'
                    ? 'サイズ変更'
                    : (type === 'signature' ? '署名枠' : '日付枠')
        );
        this.updatePointerGhost(originEvent.clientX, originEvent.clientY);
        if (mode !== 'resize') {
            this.updateDragPreview(originEvent.clientX, originEvent.clientY);
        }
    },

    createPointerGhost(label) {
        this.removePointerGhost();
        const ghost = document.createElement('div');
        ghost.id = 'sign-editor-drag-ghost';
        ghost.style.cssText = 'position:fixed; top:0; left:0; transform:translate(-50%, -50%); pointer-events:none; z-index:5000; padding:10px 14px; border-radius:999px; background:rgba(17,24,39,0.92); color:#fff; font-size:12px; font-weight:700; box-shadow:0 10px 24px rgba(0,0,0,0.18);';
        ghost.textContent = label;
        document.body.appendChild(ghost);
        this._pointerDrag.ghost = ghost;
    },

    updatePointerGhost(clientX, clientY) {
        const ghost = this._pointerDrag?.ghost;
        if (!ghost) return;
        ghost.style.left = `${clientX}px`;
        ghost.style.top = `${clientY - 18}px`;
    },

    removePointerGhost() {
        const ghost = document.getElementById('sign-editor-drag-ghost');
        if (ghost) ghost.remove();
    },

    handlePointerMove(event) {
        if (!this._pointerDrag || this._pointerDrag.pointerId !== event.pointerId) return;
        this.updatePointerGhost(event.clientX, event.clientY);
        if (this._pointerDrag.mode === 'resize' && this._pointerDrag.fieldId) {
            this.resizeField(this._pointerDrag.fieldId, event.clientX, event.clientY);
            return;
        }
        this.updateDragPreview(event.clientX, event.clientY);
    },

    handlePointerUp(event) {
        if (!this._pointerDrag || this._pointerDrag.pointerId !== event.pointerId) return;

        const drag = this._pointerDrag;
        if (drag.mode === 'resize') {
            this._pointerDrag = null;
            this.removePointerGhost();
            this.clearDragPreview();
            this.updateToolUI();
            this.renderFields();
            this.renderFieldSettings();
            return;
        }

        const dropTarget = this.findPageWrapperAtPoint(event.clientX, event.clientY);
        this._pointerDrag = null;
        this._addMode = null;
        this.removePointerGhost();
        this.clearDragPreview();
        this.updateToolUI();

        if (dropTarget) {
            const { wrapper, pageNum } = dropTarget;
            const rect = wrapper.getBoundingClientRect();
            const x = event.clientX - rect.left;
            const y = event.clientY - rect.top;
            if (drag.mode === 'move' && drag.fieldId) {
                this.moveField(drag.fieldId, pageNum, event, wrapper);
            } else if (drag.mode === 'new' && drag.type) {
                this.addField(pageNum, x, y, rect.width, rect.height, drag.type);
            }
        }

        this.renderFields();
        this.scheduleDraftSave();
    },

    resizeField(fieldId, clientX, clientY) {
        const field = this._fields.find((item) => String(item.id) === String(fieldId));
        if (!field) return;
        const wrappers = document.querySelectorAll('.editor-page-wrapper');
        const wrapper = wrappers[field.page - 1];
        if (!wrapper) return;
        const rect = wrapper.getBoundingClientRect();
        const centerX = rect.left + (rect.width * field.x / 100);
        const centerY = rect.top + (rect.height * field.y / 100);
        if (field.type === 'signature') {
            const radius = Math.max(Math.abs(clientX - centerX), Math.abs(clientY - centerY));
            const size = Math.max(72, Math.min(320, Math.round(radius * 2)));
            field.width = size;
            field.height = size;
        } else {
            const halfWidth = Math.abs(clientX - centerX);
            const width = Math.max(120, Math.min(360, Math.round(halfWidth * 2)));
            field.width = width;
        }
        this.renderFields();
        this.scheduleDraftSave();
    },

    findPageWrapperAtPoint(clientX, clientY) {
        let element = document.elementFromPoint(clientX, clientY);
        while (element) {
            if (element.classList?.contains('editor-page-wrapper')) {
                const wrappers = Array.from(document.querySelectorAll('.editor-page-wrapper'));
                return {
                    wrapper: element,
                    pageNum: wrappers.indexOf(element) + 1
                };
            }
            element = element.parentElement;
        }
        return null;
    },

    getDragFieldTemplate() {
        const drag = this._pointerDrag;
        if (!drag) return null;
        if (drag.mode === 'move' && drag.fieldId) {
            return this._fields.find((field) => String(field.id) === String(drag.fieldId)) || null;
        }
        if (drag.mode === 'new' && drag.type) {
            const signatureSize = this.getSignatureSealSize('署名', { base: 88, step: 20, unit: 2 });
            return {
                type: drag.type,
                width: drag.type === 'signature' ? Number.parseInt(signatureSize, 10) : 130,
                height: drag.type === 'signature' ? Number.parseInt(signatureSize, 10) : 48,
                label: drag.type === 'signature' ? '署名' : '日付',
                signerName: '',
                assigneeIndex: 0,
                dateFormat: 'ja-JP'
            };
        }
        return null;
    },

    updateDragPreview(clientX, clientY) {
        const drag = this._pointerDrag;
        if (!drag) return;
        const template = this.getDragFieldTemplate();
        if (!template) {
            this.clearDragPreview();
            return;
        }

        const dropTarget = this.findPageWrapperAtPoint(clientX, clientY);
        document.querySelectorAll('.editor-page-wrapper').forEach((wrapper) => {
            wrapper.style.outline = '';
            wrapper.style.outlineOffset = '';
        });

        if (!dropTarget) {
            this.clearDragPreview();
            return;
        }

        const { wrapper } = dropTarget;
        wrapper.style.outline = '2px dashed rgba(17,24,39,0.25)';
        wrapper.style.outlineOffset = '6px';

        let preview = wrapper.querySelector('.field-drag-preview');
        if (!preview) {
            preview = document.createElement('div');
            preview.className = 'field-drag-preview';
            preview.style.position = 'absolute';
            preview.style.transform = 'translate(-50%, -50%)';
            preview.style.borderRadius = '8px';
            preview.style.display = 'flex';
            preview.style.alignItems = 'center';
            preview.style.justifyContent = 'center';
            preview.style.fontSize = '12px';
            preview.style.fontWeight = '700';
            preview.style.pointerEvents = 'none';
            preview.style.zIndex = '999';
            preview.style.boxShadow = '0 10px 24px rgba(15,23,42,0.16)';
            wrapper.appendChild(preview);
        }

        const rect = wrapper.getBoundingClientRect();
        const xPercent = Math.max(6, Math.min(94, ((clientX - rect.left) / rect.width) * 100));
        const yPercent = Math.max(4, Math.min(96, ((clientY - rect.top) / rect.height) * 100));
        const assignee = this._recipients[template.assigneeIndex] || this._recipients[0] || { name: '署名者1' };

        preview.style.left = `${xPercent}%`;
        preview.style.top = `${yPercent}%`;
        preview.style.width = `${template.width || (template.type === 'signature' ? 180 : 130)}px`;
        preview.style.height = `${template.height || 48}px`;
        if (template.type === 'signature') {
            const signatureText = String(template.signerName || '').trim() || '署名';
            const signaturePreviewSize = this.getSignatureSealSize(signatureText, { fixedSize: template.width || 88 });
            preview.style.width = signaturePreviewSize;
            preview.style.height = signaturePreviewSize;
            preview.style.background = 'rgba(197, 48, 48, 0.03)';
            preview.style.border = '2px solid #c53030';
            preview.style.borderRadius = '50%';
            preview.style.color = '#c53030';
            preview.innerHTML = `
                <span style="font-family:'Noto Serif JP','Yu Mincho','Hiragino Mincho ProN',serif; font-size:${this.getSignatureSealFontSize(signaturePreviewSize)}; font-weight:700; letter-spacing:0.04em; text-align:center; word-break:break-all; padding:10px;">${this.escapeHtml(signatureText)}</span>
                <span style="position:absolute; left:10px; bottom:-18px; background:#111827; color:#fff; font-size:10px; padding:2px 8px; border-radius:999px; white-space:nowrap;">${this.escapeHtml(assignee.name || '送信先1')}</span>
            `;
        } else {
            preview.style.background = 'rgba(52, 168, 83, 0.08)';
            preview.style.border = '2px solid #34a853';
            preview.style.borderRadius = '8px';
            preview.style.color = '#34a853';
            preview.innerHTML = `
                <i class="fa-solid fa-grip-lines" style="margin-right:8px; opacity:0.55;"></i>
                <i class="fa-solid fa-calendar" style="margin-right:6px;"></i>
                <span>${this.escapeHtml(this.getPreviewDateValue(template.dateFormat || 'ja-JP'))}</span>
                <span style="position:absolute; left:10px; bottom:-18px; background:#111827; color:#fff; font-size:10px; padding:2px 8px; border-radius:999px; white-space:nowrap;">${this.escapeHtml(assignee.name || '送信先1')}</span>
            `;
        }
    },

    clearDragPreview() {
        document.querySelectorAll('.field-drag-preview').forEach((preview) => preview.remove());
        document.querySelectorAll('.editor-page-wrapper').forEach((wrapper) => {
            wrapper.style.outline = '';
            wrapper.style.outlineOffset = '';
        });
    },

    // --- PDF / Field Logic ---
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

    async loadPdf(url, container) {
        if (!url) {
            container.innerHTML = '<div style="padding:100px; color:#999;">署名対象の原本ファイルが見つかりません</div>';
            return;
        }

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
                canvas.style.boxShadow = '0 8px 30px rgba(0,0,0,0.15)';
                canvas.style.margin = '0 auto';
                canvas.style.borderRadius = '4px';
                
                await page.render({ canvasContext: context, viewport: viewport }).promise;
                
                const pageWrapper = document.createElement('div');
                pageWrapper.className = 'editor-page-wrapper';
                pageWrapper.style.position = 'relative';
                pageWrapper.style.width = viewport.width + 'px';
                pageWrapper.style.margin = '0 auto';
                pageWrapper.dataset.baseWidth = String(viewport.width);
                pageWrapper.dataset.baseHeight = String(viewport.height);
                pageWrapper.style.transformOrigin = 'top center';
                pageWrapper.appendChild(canvas);
                
                pageWrapper.onclick = (e) => this.handleCanvasClick(e, i, pageWrapper);
                
                // Drag and Drop Support
                pageWrapper.ondragover = (e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'copy';
                    pageWrapper.classList.add('page-drop-target');
                };
                pageWrapper.ondragleave = () => {
                    pageWrapper.classList.remove('page-drop-target');
                };
                pageWrapper.ondrop = (e) => {
                    e.preventDefault();
                    pageWrapper.classList.remove('page-drop-target');
                    const fieldType = e.dataTransfer.getData('field-type');
                    const moveFieldId = e.dataTransfer.getData('move-field-id');
                    if (moveFieldId) {
                        this.moveField(moveFieldId, i, e, pageWrapper);
                    } else if (fieldType) {
                        this.handleDrop(e, i, pageWrapper, fieldType);
                    }
                };
                
                container.appendChild(pageWrapper);
            }
            this.updateVisiblePages();
            this.renderPageSwitcher();
            this.fitPreviewPages();
        } catch (error) {
            console.error('PDF Load Error:', error);
            if (this._currentDoc?.original_content) {
                this.renderDocumentFallback(this._currentDoc, container);
                this._previewMode = 'fallback';
                return;
            }
            this.renderUnavailableDocument(this._currentDoc, container, `PDFの読み込みに失敗しました: ${error.message}`);
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
        const contentPages = this.buildFallbackContentPages(contract?.original_content);
        if (!Array.isArray(contentPages) || contentPages.length === 0) {
            container.innerHTML = '<div style="padding:100px; color:#999;">表示できる本文データが見つかりません</div>';
            return;
        }
        container.innerHTML = '';
        const totalPages = Math.max(1, contentPages.length);

        contentPages.forEach((content, index) => {
            const previewHtml = buildSignDocumentPreviewHtml(content);
            const pageNum = index + 1;

            const pageWrapper = document.createElement('div');
            pageWrapper.className = 'editor-page-wrapper';
            pageWrapper.style.position = 'relative';
            pageWrapper.style.width = '794px';
            pageWrapper.style.margin = '0 auto 40px auto';
            pageWrapper.style.background = '#fff';
            pageWrapper.style.borderRadius = '6px';
            pageWrapper.style.boxShadow = '0 8px 30px rgba(0,0,0,0.15)';
            pageWrapper.style.overflow = 'visible';
            pageWrapper.dataset.baseWidth = '794';
            pageWrapper.style.transformOrigin = 'top center';
            pageWrapper.onclick = (e) => this.handleCanvasClick(e, pageNum, pageWrapper);

            const header = document.createElement('div');
            header.style.padding = '18px 24px';
            header.style.borderBottom = '1px solid #eee';
            header.style.fontSize = '12px';
            header.style.color = '#666';
            header.innerHTML = `
                <strong style="color:#333;">抽出テキスト・プレビュー</strong>
                ${totalPages > 1 ? ` <span style="margin-left:8px; color:#9ca3af;">${pageNum} / ${totalPages}</span>` : ''}
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
            container.appendChild(pageWrapper);
        });

        this._totalPages = totalPages;
        this._activePage = Math.min(this._activePage || 1, totalPages);
        this.updateVisiblePages();
        this.renderPageSwitcher();
        this.fitPreviewPages();
    },

    fitPreviewPages() {
        const viewport = document.querySelector('.sign-editor-viewport');
        if (!viewport) return;
        const availableWidth = Math.max(320, viewport.clientWidth - 96);
        const switcher = document.getElementById('sign-editor-page-switcher');
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
        this.renderFields();
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
        const root = document.getElementById('sign-editor-page-switcher');
        if (!root) return;
        const total = Math.max(1, Number(this._totalPages || 1));
        root.classList.toggle('is-hidden', total <= 1);
        root.innerHTML = `
            <div class="sign-page-switcher-summary">
                <span class="sign-page-switcher-value">${this._activePage} / ${total}</span>
            </div>
            <div class="sign-page-switcher-actions">
                <button class="btn-dashboard" ${this._activePage <= 1 ? 'disabled' : ''} onclick="window.SignEditor.setActivePage(${this._activePage - 1})">
                    <i class="fa-solid fa-chevron-left"></i>
                </button>
                <button class="btn-dashboard" ${this._activePage >= total ? 'disabled' : ''} onclick="window.SignEditor.setActivePage(${this._activePage + 1})">
                    <i class="fa-solid fa-chevron-right"></i>
                </button>
            </div>
        `;
    },

    buildFallbackContentPages(content) {
        if (!content) return [];

        if (Array.isArray(content)) {
            const groups = this.chunkFallbackList(content, 6, 4200);
            return groups.length > 0 ? groups : [content];
        }

        if (typeof content === 'object' && Array.isArray(content.articles)) {
            const base = content || {};
            const hasPreamble = Boolean(String(base.preamble || '').trim());
            const maxPerPage = hasPreamble ? 5 : 6;
            const groups = this.chunkFallbackList(base.articles || [], maxPerPage, 4200);
            if (groups.length <= 1) return [base];
            return groups.map((articles, index) => ({
                ...base,
                preamble: index === 0 ? base.preamble : '',
                articles
            }));
        }

        if (typeof content === 'string') {
            const blocks = String(content)
                .split(/\r?\n{2,}/)
                .map((line) => line.trim())
                .filter(Boolean);
            if (blocks.length <= 1) return [content];
            const pages = [];
            let bucket = [];
            let bucketChars = 0;
            blocks.forEach((block) => {
                const weight = block.length + 80;
                const shouldSplit = bucket.length >= 8 || (bucketChars + weight > 4200 && bucket.length > 0);
                if (shouldSplit) {
                    pages.push(bucket.join('\n\n'));
                    bucket = [];
                    bucketChars = 0;
                }
                bucket.push(block);
                bucketChars += weight;
            });
            if (bucket.length > 0) {
                pages.push(bucket.join('\n\n'));
            }
            return pages.length > 0 ? pages : [content];
        }

        return [content];
    },

    chunkFallbackList(list, maxItems, maxWeight) {
        const items = Array.isArray(list) ? list : [];
        if (items.length === 0) return [];
        const groups = [];
        let bucket = [];
        let bucketWeight = 0;
        items.forEach((item) => {
            const weight = this.measureFallbackItemWeight(item);
            const shouldSplit = bucket.length >= maxItems || (bucketWeight + weight > maxWeight && bucket.length > 0);
            if (shouldSplit) {
                groups.push(bucket);
                bucket = [];
                bucketWeight = 0;
            }
            bucket.push(item);
            bucketWeight += weight;
        });
        if (bucket.length > 0) {
            groups.push(bucket);
        }
        return groups;
    },

    measureFallbackItemWeight(item) {
        if (!item) return 120;
        if (typeof item === 'string') return Math.max(120, item.length + 80);
        const title = String(item.article || item.articleNumber || item.title || item.header || '').length;
        const body = Array.isArray(item.paragraphs)
            ? item.paragraphs.map((line) => String(line || '')).join('\n').length
            : String(item.body || item.content || '').length;
        return Math.max(200, title + body + 120);
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

    handleDrop(e, pageNum, wrapper, type) {
        const rect = wrapper.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        this.addField(pageNum, x, y, rect.width, rect.height, type);
    },

    addField(pageNum, x, y, pageWidth, pageHeight, type) {
        const defaultRecipient = this._recipients[0] || { name: '', email: '' };
        const field = {
            id: Date.now(),
            type: type,
            page: pageNum,
            x: (x / pageWidth) * 100,
            y: (y / pageHeight) * 100,
            width: type === 'signature' ? 88 : 130,
            height: type === 'signature' ? 88 : 48,
            assigneeIndex: Math.min(this._recipients.length - 1, 0),
            required: true,
            label: type === 'signature' ? '署名' : '',
            signerName: '',
            dateFormat: 'ja-JP'
        };
        this._fields.push(field);
        this._selectedFieldId = field.id;
        this.renderFields();
        this.renderFieldSettings();
        this.scheduleDraftSave();
    },

    moveField(fieldId, pageNum, e, wrapper) {
        const field = this._fields.find((item) => String(item.id) === String(fieldId));
        if (!field) return;
        const rect = wrapper.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        field.page = pageNum;
        field.x = Math.max(6, Math.min(94, (x / rect.width) * 100));
        field.y = Math.max(4, Math.min(96, (y / rect.height) * 100));
        this.renderFields();
        this.renderFieldSettings();
        this.scheduleDraftSave();
    },

    handleCanvasClick(e, pageNum, wrapper) {
        if (this._inlinePreviewMode) return;
        if (!this._addMode) return;

        const rect = wrapper.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        this.addField(pageNum, x, y, rect.width, rect.height, this._addMode);
        
        this._addMode = null;
        this.updateToolUI();
    },

    renderFields() {
        document.querySelectorAll('.field-marker').forEach(m => m.remove());
        
        const wrappers = document.querySelectorAll('.editor-page-wrapper');
        this._fields.forEach((field, index) => {
            const wrapper = wrappers[field.page - 1];
            if (!wrapper) return;

            const div = document.createElement('div');
            div.className = 'field-marker';
            div.style.position = 'absolute';
            div.style.left = field.x + '%';
            div.style.top = field.y + '%';
            div.style.transform = 'translate(-50%, -50%)'; // Center on click
            div.style.display = 'flex';
            div.style.alignItems = 'center';
            div.style.justifyContent = 'center';
            div.style.zIndex = '1000';
            const isMovingField = String(field.id) === String(this._pointerDrag?.fieldId) && this._pointerDrag?.mode === 'move';
            const label = this.escapeHtml(field.label || (field.type === 'signature' ? '署名' : '日付'));
            const sequenceLabel = `No.${index + 1}`;
            if (this._inlinePreviewMode) {
                const previewSignatureSize = field.type === 'signature'
                    ? this.getSignatureSealSize(this.getPreviewSignatureValue(field), { fixedSize: field.width })
                    : null;
                div.style.width = field.type === 'signature'
                    ? previewSignatureSize
                    : `${field.width || 130}px`;
                div.style.height = field.type === 'signature' ? previewSignatureSize : '40px';
                div.style.cursor = 'default';
                div.style.background = 'transparent';
                div.style.border = 'none';
                div.style.borderRadius = '0';
                div.style.boxShadow = 'none';
                div.style.outline = 'none';
                div.style.opacity = '1';
                div.style.pointerEvents = 'none';
                div.innerHTML = field.type === 'signature'
                    ? this.buildSignatureSealHtml(this.getPreviewSignatureValue(field), {
                        size: previewSignatureSize,
                        fontSize: this.getSignatureSealFontSize(previewSignatureSize)
                    })
                    : `<span style="font-size:14px; color:#333; font-weight:600;">${this.escapeHtml(this.getPreviewDateValue(field.dateFormat))}</span>`;
            } else {
                const signatureSealText = '署名';
                const signatureEditorSize = this.getSignatureSealSize(signatureSealText, { fixedSize: field.width });
                div.style.width = field.type === 'signature'
                    ? signatureEditorSize
                    : `${field.width || 130}px`;
                div.style.height = field.type === 'signature' ? signatureEditorSize : '48px';
                div.style.background = field.type === 'signature' ? 'rgba(197, 48, 48, 0.03)' : 'rgba(52, 168, 83, 0.1)';
                div.style.border = `2px solid ${field.type === 'signature' ? '#c53030' : '#34a853'}`;
                div.style.borderRadius = field.type === 'signature' ? '50%' : '8px';
                div.style.fontSize = '12px';
                div.style.fontWeight = '600';
                div.style.color = field.type === 'signature' ? '#c53030' : '#34a853';
                div.style.boxShadow = '0 4px 12px rgba(0,0,0,0.1)';
                div.style.cursor = 'move';
                div.style.opacity = isMovingField
                    ? '0.58'
                    : (this._pointerDrag?.mode === 'resize' && String(field.id) === String(this._pointerDrag?.fieldId) ? '0.96' : '1');
                div.style.outline = String(field.id) === String(this._selectedFieldId) ? '3px solid rgba(17,24,39,0.18)' : 'none';
                div.title = 'ドラッグして移動';
                div.innerHTML = field.type === 'signature'
                    ? `
                    ${this.getSignatureDisplayHtml(field, signatureEditorSize)}
                    <span style="position:absolute; top:-14px; left:-8px; z-index:2; background:#111827; color:#fff; font-size:11px; font-weight:700; min-width:42px; height:28px; padding:0 10px; border-radius:999px; white-space:nowrap; display:inline-flex; align-items:center; justify-content:center; box-shadow:0 6px 14px rgba(15,23,42,0.18);">${sequenceLabel}</span>
                    <button onclick="event.stopPropagation(); window.SignEditor.removeField(${field.id})" title="削除" style="position:absolute; top:-14px; right:-14px; z-index:2; background:#fff; border:1px solid rgba(15,23,42,0.12); border-radius:50%; width:34px; height:34px; font-size:18px; cursor:pointer; color:#6b7280; display:flex; align-items:center; justify-content:center; box-shadow:0 6px 14px rgba(15,23,42,0.12); line-height:1;">&times;</button>
                `
                    : `
                    <span>${this.escapeHtml(this.getPreviewDateValue(field.dateFormat))}</span>
                    <span style="position:absolute; top:-14px; left:-8px; background:#111827; color:#fff; font-size:11px; font-weight:700; min-width:42px; height:28px; padding:0 10px; border-radius:999px; white-space:nowrap; display:inline-flex; align-items:center; justify-content:center; box-shadow:0 6px 14px rgba(15,23,42,0.18);">${sequenceLabel}</span>
                    <button onclick="event.stopPropagation(); window.SignEditor.removeField(${field.id})" title="削除" style="position:absolute; top:-14px; right:-14px; background:#fff; border:1px solid rgba(15,23,42,0.12); border-radius:50%; width:30px; height:30px; font-size:16px; cursor:pointer; color:#6b7280; display:flex; align-items:center; justify-content:center; box-shadow:0 6px 14px rgba(15,23,42,0.12); line-height:1;">&times;</button>
                `;
                div.addEventListener('click', (event) => {
                    event.stopPropagation();
                    this._selectedFieldId = field.id;
                    this.renderFields();
                    this.renderFieldSettings();
                });
                div.addEventListener('pointerdown', (event) => {
                    if (event.button !== 0) return;
                    if (event.target.closest('button')) return;
                    event.preventDefault();
                    this._selectedFieldId = field.id;
                    this.renderFieldSettings();
                    this.startPointerDrag({
                        mode: 'move',
                        fieldId: field.id,
                        pointerId: event.pointerId,
                        originEvent: event
                    });
                });
            }
            wrapper.appendChild(div);
        });
    },

    removeField(id) {
        this._fields = this._fields.filter(f => f.id !== id);
        delete this._fieldStyles[String(id)];
        if (String(this._selectedFieldId) === String(id)) {
            this._selectedFieldId = this._fields[0]?.id || null;
        }
        this.renderFields();
        this.renderFieldSettings();
        this.scheduleDraftSave();
    },

    getSelectedField() {
        return this._fields.find((field) => String(field.id) === String(this._selectedFieldId)) || null;
    },

    updateSelectedField(patch) {
        const field = this.getSelectedField();
        if (!field) return;
        Object.assign(field, patch);
        this.renderFields();
        this.renderFieldSettings();
        this.scheduleDraftSave();
    },

    updateSelectedFieldLabel(value) {
        const field = this.getSelectedField();
        if (!field) return;
        field.label = value;
        this.renderFields();
    },

    updateSelectedFieldSignerName(value) {
        const field = this.getSelectedField();
        if (!field) return;
        field.signerName = String(value || '');
        this.renderFields();
        this.scheduleDraftSave();
    },

    renderFieldSettings() {
        const container = document.getElementById('editor-field-settings');
        const section = document.getElementById('editor-field-settings-section');
        if (section) {
            section.style.display = this.getSelectedField() ? '' : 'none';
        }
        if (!container) return;
        if (this._inlinePreviewMode) {
            container.innerHTML = '受信者プレビュー中は編集できません。';
            return;
        }
        const field = this.getSelectedField();
        if (!field) {
            container.innerHTML = '';
            return;
        }

        const shouldScroll = this._fields.length >= 2;
        container.classList.toggle('is-scrollable', shouldScroll);

        const recipientOptions = this._recipients.map((rec, idx) => `
            <option value="${idx}" ${Number(field.assigneeIndex ?? 0) === idx ? 'selected' : ''}>
                ${this.escapeHtml(this.getRecipientFieldOptionLabel(rec, idx))}
            </option>
        `).join('');

        const signatureSettings = field.type === 'signature'
            ? `
                <div style="margin-top:12px;">
                    <label style="display:block; font-weight:600; margin-bottom:6px; color:#444;">署名者の割り当て</label>
                    <select onchange="window.SignEditor.updateSelectedField({ assigneeIndex: Number(this.value) })" style="width:100%; padding:10px 12px; border-radius:10px; border:1px solid #d9dde3; background:#fff;">
                        ${recipientOptions}
                    </select>
                </div>
                <div style="font-size:11px; color:#6b7280; line-height:1.7; margin-top:8px;">配置した枠に誰が署名するかを選択してください。</div>
            `
            : `
                <div style="margin-top:12px;">
                    <label style="display:block; font-weight:600; margin-bottom:6px; color:#444;">署名者の割り当て</label>
                    <select onchange="window.SignEditor.updateSelectedField({ assigneeIndex: Number(this.value) })" style="width:100%; padding:10px 12px; border-radius:10px; border:1px solid #d9dde3; background:#fff; margin-bottom:12px;">
                        ${recipientOptions}
                    </select>
                    <label style="display:block; font-weight:600; margin-bottom:6px; color:#444;">日付書式</label>
                    <select onchange="window.SignEditor.updateSelectedField({ dateFormat: this.value })" style="width:100%; padding:10px 12px; border-radius:10px; border:1px solid #d9dde3; background:#fff;">
                        <option value="ja-JP" ${field.dateFormat === 'ja-JP' ? 'selected' : ''}>2026/03/19</option>
                        <option value="iso" ${field.dateFormat === 'iso' ? 'selected' : ''}>2026-03-19</option>
                        <option value="jp-long" ${field.dateFormat === 'jp-long' ? 'selected' : ''}>2026年3月19日</option>
                    </select>
                </div>
            `;

        container.innerHTML = `
            <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px;">
                <div style="font-weight:700; color:#1f2937;">${field.type === 'signature' ? '署名枠' : '日付枠'}の設定</div>
                <div style="font-size:11px; color:#6b7280;">No. ${this._fields.findIndex((item) => item.id === field.id) + 1}</div>
            </div>
            ${signatureSettings}
        `;
    },

    async saveAndSend() {
        if (this._isSending) return;
        // Collect latest recipient values
        this.syncRecipientsFromDom();
        const validations = this.updateRecipientValidationState({ force: true });
        const validRecipients = this._recipients
            .map((recipient, index) => ({
                ...recipient,
                name: String(recipient.name || '').trim(),
                email: String(recipient.email || '').trim(),
                display_name: this.formatRecipientHonorific(recipient, index)
            }))
            .filter((recipient, index) => validations[index]?.valid);
        
        if (validRecipients.length === 0) {
            const firstInvalid = validations.find((state) => !state.valid);
            Notify.warning(firstInvalid?.message || '宛名とメールアドレスを正しく入力してください');
            return;
        }

        if (this._fields.length === 0) {
            Notify.warning('署名フィールドを1つ以上配置してください');
            return;
        }

        try {
            this.setSendingState(true);
            let requestId = this._currentRequest.id;

            const hasRemoteRequest = this._currentRequest.provider === 'diffsense'
                || Boolean(this._currentRequest.zoho_request_id)
                || Boolean(this._currentRequest.firma_request_id);

            if (!hasRemoteRequest) {
                const createdRequest = await dbService.addSignRequest({
                    contractId: this._currentRequest.contract_id || this._currentRequest.contractId,
                    document_name: this._currentRequest.document_name || this._currentDoc?.name || '',
                    document_snapshot: this._currentRequest.document_snapshot || this._currentRequest.contract_snapshot || this._currentDoc || null,
                    recipients: validRecipients
                });
                if (!createdRequest) {
                    throw new Error('署名依頼の作成に失敗しました');
                }
                if (createdRequest.id !== this._currentRequest.id) {
                    dbService.deleteSignRequest(this._currentRequest.id);
                }
                this._currentRequest = {
                    ...this._currentRequest,
                    ...createdRequest
                };
                requestId = createdRequest.id;
            }

            const result = await dbService.updateSignRequest(requestId, {
                recipients: validRecipients,
                fields: this._fields,
                fieldStyles: this._fieldStyles,
                page_dimensions: this.getPageDimensionsPayload(),
                status: 'sent'
            });

            if (result) {
                this.syncDraftState(result);
                Notify.success('署名依頼を送信しました！');
                if (window.signUI) {
                    window.signUI.currentTab = 'sent-requests';
                }
                setTimeout(() => window.app.navigate('sign'), 1500);
            } else {
                throw new Error('送信に失敗しました');
            }
        } catch (error) {
            Notify.error(`エラー: ${error.message}`);
        } finally {
            this.setSendingState(false);
        }
    },

    setSendingState(isSending) {
        this._isSending = isSending === true;
        const overlayId = 'sign-editor-sending-overlay';
        const existing = document.getElementById(overlayId);
        const sendButton = document.getElementById('sign-editor-send-btn');
        const previewButton = document.getElementById('sign-editor-preview-toggle');

        if (sendButton) {
            sendButton.disabled = this._isSending;
            sendButton.style.opacity = this._isSending ? '0.72' : '1';
            sendButton.style.cursor = this._isSending ? 'wait' : 'pointer';
        }
        if (previewButton) {
            previewButton.disabled = this._isSending;
            previewButton.style.opacity = this._isSending ? '0.72' : '1';
            previewButton.style.cursor = this._isSending ? 'wait' : 'pointer';
        }

        if (!this._isSending) {
            existing?.remove();
            return;
        }

        if (existing) return;

        const overlay = document.createElement('div');
        overlay.id = overlayId;
        overlay.style.position = 'fixed';
        overlay.style.inset = '0';
        overlay.style.background = 'rgba(248, 248, 245, 0.82)';
        overlay.style.backdropFilter = 'blur(5px)';
        overlay.style.zIndex = '9999';
        overlay.style.display = 'flex';
        overlay.style.alignItems = 'center';
        overlay.style.justifyContent = 'center';
        overlay.innerHTML = `
            <div style="width:min(92vw, 420px); background:#fff; border:1px solid rgba(15,23,42,0.08); border-radius:24px; box-shadow:0 24px 60px rgba(15,23,42,0.18); padding:32px 28px; text-align:center;">
                <div style="width:54px; height:54px; margin:0 auto 18px; border-radius:50%; border:3px solid rgba(201, 164, 92, 0.22); border-top-color:#c9a45c; animation:sign-send-spin 0.9s linear infinite;"></div>
                <div style="font-size:20px; font-weight:700; color:#111827; margin-bottom:10px;">署名依頼を送信しています</div>
                <div style="font-size:13px; line-height:1.8; color:#6b7280;">送信が完了するまで、このまましばらくお待ちください。</div>
            </div>
        `;
        if (!document.getElementById('sign-editor-sending-style')) {
            const style = document.createElement('style');
            style.id = 'sign-editor-sending-style';
            style.textContent = '@keyframes sign-send-spin { to { transform: rotate(360deg); } }';
            document.head.appendChild(style);
        }
        document.body.appendChild(overlay);
    },

    async openRecipientPreview() {
        if (!this._inlinePreviewMode && this._fields.length === 0) {
            Notify.warning('プレビュー前に署名フィールドを1つ以上配置してください');
            return;
        }
        this._inlinePreviewMode = !this._inlinePreviewMode;
        this._addMode = null;
        this.updateToolUI();
        this.updatePreviewToggleButton();
        this.clearDragPreview();
        this.removePointerGhost();
        this.renderFields();
        this.renderFieldSettings();
    }
};
