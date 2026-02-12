/**
 * DIFFsense Notification System
 * ブラウザ標準のalert/confirmを置き換える独自通知UI
 */
const Notify = (() => {
    // CSS注入（1回のみ）
    let styleInjected = false;
    function injectStyles() {
        if (styleInjected) return;
        styleInjected = true;
        const style = document.createElement('style');
        style.textContent = `
            /* ── Toast（トースト通知・中央表示）── */
            .ds-toast-container {
                position: fixed;
                top: 32px;
                left: 50%;
                transform: translateX(-50%);
                z-index: 9999;
                display: flex;
                flex-direction: column;
                align-items: center;
                gap: 10px;
                pointer-events: none;
            }
            .ds-toast {
                pointer-events: auto;
                display: flex;
                align-items: flex-start;
                gap: 12px;
                min-width: 320px;
                max-width: 480px;
                padding: 16px 20px;
                border-radius: 10px;
                background: #fff;
                box-shadow: 0 8px 32px rgba(0,0,0,0.15), 0 2px 8px rgba(0,0,0,0.08);
                border-left: 4px solid #c5a059;
                transform: translateY(-20px);
                opacity: 0;
                transition: all 0.35s cubic-bezier(0.16, 1, 0.3, 1);
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            }
            .ds-toast.show {
                transform: translateY(0);
                opacity: 1;
            }
            .ds-toast.hide {
                transform: translateY(-20px);
                opacity: 0;
            }
            .ds-toast-icon {
                font-size: 1.3rem;
                flex-shrink: 0;
                margin-top: 1px;
            }
            .ds-toast-body {
                flex: 1;
                min-width: 0;
            }
            .ds-toast-title {
                font-weight: 700;
                font-size: 0.9rem;
                color: #24292E;
                margin-bottom: 2px;
            }
            .ds-toast-msg {
                font-size: 0.82rem;
                color: #586069;
                line-height: 1.5;
                word-break: break-word;
            }
            .ds-toast-close {
                background: none;
                border: none;
                color: #959da5;
                font-size: 1.1rem;
                cursor: pointer;
                padding: 0 0 0 8px;
                line-height: 1;
                flex-shrink: 0;
                transition: color 0.15s;
            }
            .ds-toast-close:hover { color: #24292E; }
            /* Types */
            .ds-toast.success { border-left-color: #22c55e; }
            .ds-toast.error   { border-left-color: #ef4444; }
            .ds-toast.warning { border-left-color: #f59e0b; }
            .ds-toast.info    { border-left-color: #3b82f6; }

            /* ── Modal（確認ダイアログ）── */
            .ds-modal-overlay {
                position: fixed;
                top: 0; left: 0; width: 100%; height: 100%;
                background: rgba(0,0,0,0.45);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 10000;
                backdrop-filter: blur(4px);
                opacity: 0;
                transition: opacity 0.2s ease;
            }
            .ds-modal-overlay.show { opacity: 1; }
            .ds-modal {
                background: #fff;
                width: 90%;
                max-width: 460px;
                border-radius: 12px;
                box-shadow: 0 20px 60px rgba(0,0,0,0.2);
                overflow: hidden;
                transform: translateY(16px) scale(0.97);
                transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            }
            .ds-modal-overlay.show .ds-modal {
                transform: translateY(0) scale(1);
            }
            .ds-modal-header {
                padding: 20px 24px;
                border-bottom: 1px solid #f0f0f0;
                display: flex;
                align-items: center;
                gap: 12px;
            }
            .ds-modal-header-icon {
                font-size: 1.4rem;
                flex-shrink: 0;
            }
            .ds-modal-header h3 {
                font-size: 1rem;
                font-weight: 700;
                color: #24292E;
                margin: 0;
            }
            .ds-modal-body {
                padding: 20px 24px;
                font-size: 0.88rem;
                color: #444;
                line-height: 1.7;
                white-space: pre-line;
            }
            .ds-modal-actions {
                padding: 16px 24px;
                display: flex;
                gap: 10px;
                justify-content: flex-end;
                border-top: 1px solid #f0f0f0;
                background: #fafbfc;
            }
            .ds-modal-btn {
                padding: 9px 22px;
                border-radius: 7px;
                font-size: 0.85rem;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.15s;
                border: 1px solid #d0d5db;
                background: #fff;
                color: #24292E;
            }
            .ds-modal-btn:hover { background: #f3f4f6; }
            .ds-modal-btn.primary {
                background: #c5a059;
                color: #fff;
                border-color: #c5a059;
            }
            .ds-modal-btn.primary:hover { background: #b08d45; }
            .ds-modal-btn.danger {
                background: #ef4444;
                color: #fff;
                border-color: #ef4444;
            }
            .ds-modal-btn.danger:hover { background: #dc2626; }
            .ds-modal-btn.info {
                background: #3b82f6;
                color: #fff;
                border-color: #3b82f6;
            }
            .ds-modal-btn.info:hover { background: #2563eb; }

            /* Progress bar for auto-close */
            .ds-toast-progress {
                position: absolute;
                bottom: 0; left: 4px; right: 0;
                height: 3px;
                border-radius: 0 0 10px 0;
                background: currentColor;
                opacity: 0.2;
                transform-origin: left;
                animation: ds-toast-progress linear forwards;
            }
            @keyframes ds-toast-progress {
                from { transform: scaleX(1); }
                to   { transform: scaleX(0); }
            }
        `;
        document.head.appendChild(style);
    }

    // Toast container取得（なければ作成）
    function getContainer() {
        let c = document.querySelector('.ds-toast-container');
        if (!c) {
            c = document.createElement('div');
            c.className = 'ds-toast-container';
            document.body.appendChild(c);
        }
        return c;
    }

    const ICONS = {
        success: '<i class="fa-solid fa-circle-check" style="color:#22c55e"></i>',
        error:   '<i class="fa-solid fa-circle-xmark" style="color:#ef4444"></i>',
        warning: '<i class="fa-solid fa-triangle-exclamation" style="color:#f59e0b"></i>',
        info:    '<i class="fa-solid fa-circle-info" style="color:#3b82f6"></i>',
    };
    const TITLES = {
        success: '完了',
        error:   'エラー',
        warning: '注意',
        info:    'お知らせ',
    };

    /**
     * トースト通知を表示
     * @param {string} message
     * @param {object} opts - { type:'success'|'error'|'warning'|'info', title, duration }
     */
    function toast(message, opts = {}) {
        injectStyles();
        const type = opts.type || 'info';
        const title = opts.title || TITLES[type];
        const duration = opts.duration ?? (type === 'error' ? 6000 : 4000);

        const el = document.createElement('div');
        el.className = `ds-toast ${type}`;
        el.style.position = 'relative';
        el.innerHTML = `
            <span class="ds-toast-icon">${ICONS[type]}</span>
            <div class="ds-toast-body">
                <div class="ds-toast-title">${title}</div>
                <div class="ds-toast-msg">${message}</div>
            </div>
            <button class="ds-toast-close" aria-label="閉じる">&times;</button>
            ${duration > 0 ? `<div class="ds-toast-progress" style="animation-duration:${duration}ms; color:${type === 'success' ? '#22c55e' : type === 'error' ? '#ef4444' : type === 'warning' ? '#f59e0b' : '#3b82f6'}"></div>` : ''}
        `;

        const container = getContainer();
        container.appendChild(el);

        // Animate in
        requestAnimationFrame(() => {
            requestAnimationFrame(() => el.classList.add('show'));
        });

        const remove = () => {
            el.classList.remove('show');
            el.classList.add('hide');
            setTimeout(() => el.remove(), 350);
        };

        el.querySelector('.ds-toast-close').onclick = remove;

        if (duration > 0) {
            setTimeout(remove, duration);
        }

        return el;
    }

    /**
     * 確認ダイアログ（confirm置き換え）
     * @param {string} message
     * @param {object} opts - { title, type, okText, cancelText, okStyle }
     * @returns {Promise<boolean>}
     */
    function confirm(message, opts = {}) {
        injectStyles();
        const type = opts.type || 'info';
        const title = opts.title || '確認';
        const okText = opts.okText || 'OK';
        const cancelText = opts.cancelText || 'キャンセル';
        const okStyle = opts.okStyle || 'primary';

        return new Promise(resolve => {
            const overlay = document.createElement('div');
            overlay.className = 'ds-modal-overlay';
            overlay.innerHTML = `
                <div class="ds-modal">
                    <div class="ds-modal-header">
                        <span class="ds-modal-header-icon">${ICONS[type]}</span>
                        <h3>${title}</h3>
                    </div>
                    <div class="ds-modal-body">${message}</div>
                    <div class="ds-modal-actions">
                        <button class="ds-modal-btn cancel-btn">${cancelText}</button>
                        <button class="ds-modal-btn ${okStyle} ok-btn">${okText}</button>
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);
            requestAnimationFrame(() => overlay.classList.add('show'));

            const close = (result) => {
                overlay.classList.remove('show');
                setTimeout(() => { overlay.remove(); resolve(result); }, 200);
            };

            overlay.querySelector('.ok-btn').onclick = () => close(true);
            overlay.querySelector('.cancel-btn').onclick = () => close(false);
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) close(false);
            });
        });
    }

    /**
     * アラートダイアログ（alert置き換え）
     * @param {string} message
     * @param {object} opts - { title, type, okText }
     * @returns {Promise<void>}
     */
    function alert(message, opts = {}) {
        injectStyles();
        const type = opts.type || 'info';
        const title = opts.title || TITLES[type];
        const okText = opts.okText || 'OK';
        const okStyle = opts.okStyle || 'primary';

        return new Promise(resolve => {
            const overlay = document.createElement('div');
            overlay.className = 'ds-modal-overlay';
            overlay.innerHTML = `
                <div class="ds-modal">
                    <div class="ds-modal-header">
                        <span class="ds-modal-header-icon">${ICONS[type]}</span>
                        <h3>${title}</h3>
                    </div>
                    <div class="ds-modal-body">${message}</div>
                    <div class="ds-modal-actions">
                        <button class="ds-modal-btn ${okStyle} ok-btn">${okText}</button>
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);
            requestAnimationFrame(() => overlay.classList.add('show'));

            const close = () => {
                overlay.classList.remove('show');
                setTimeout(() => { overlay.remove(); resolve(); }, 200);
            };

            overlay.querySelector('.ok-btn').onclick = close;
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) close();
            });
        });
    }

    // 便利メソッド
    const success = (msg, opts) => toast(msg, { ...opts, type: 'success' });
    const error   = (msg, opts) => toast(msg, { ...opts, type: 'error' });
    const warning = (msg, opts) => toast(msg, { ...opts, type: 'warning' });
    const info    = (msg, opts) => toast(msg, { ...opts, type: 'info' });

    return { toast, confirm, alert, success, error, warning, info };
})();

// グローバルに公開
window.Notify = Notify;

// ESM export
if (typeof module !== 'undefined') {
    module.exports = Notify;
}
