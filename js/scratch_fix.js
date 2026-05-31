const fs = require('fs');
const path = 'dashboard.js';

let content = fs.readFileSync(path, 'utf8');

// Fix the corrupted block
const brokenStart = content.indexOf("if (viewId === 'sign-viewer') {");
const brokenEnd = content.indexOf("if (viewId === 'history') {");

if (brokenStart !== -1 && brokenEnd !== -1 && brokenStart < brokenEnd) {
    const fixedBlock = `        if (viewId === 'sign-viewer') {
            const { SignUI } = await import('/js/sign-ui.js?v=20260501_premium_fix');
            const module = await import('/js/sign-viewer.js?v=20260515_word_like_toggle_v137');
            const SignViewer = module.SignViewer || module.default || module;
            this.mainContent.innerHTML = await SignUI.renderSignViewer(this, params);
            await SignViewer.init(this, params);
            return;
        }
        
        if (viewId === 'sign-editor') {
            const { SignUI } = await import('./sign-ui.js?v=20260501_premium_fix');
            const { SignEditor } = await import('./sign-editor.js?v=20260407_overflow');
            this.mainContent.innerHTML = await SignUI.renderSignEditor(this, params);
            await SignEditor.init(this, params);
            return;
        }

        if (viewId === 'sign-recipient') {
            const { SignUI } = await import('./sign-ui.js?v=20260501_premium_fix');
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

`;
    content = content.substring(0, brokenStart) + fixedBlock + content.substring(brokenEnd);
    console.log('Fixed corrupted block');
}

const autoTriggerPattern = /updateDiffSelection\(side, docId\) \{([\s\S]*?if \(this\.selectedOldFile && this\.selectedNewFile\) \{[\s\S]*?this\.startAnalysis\(\);[\s\S]*?\}\s*\}/g;
const replacement = `updateDiffSelection(side, docId) {
        if (side === 'old') this.selectedOldFile = docId;
        else if (side === 'new') this.selectedNewFile = docId;
        // Auto-analysis disabled to prevent unintended AI credit consumption.
        // if (this.selectedOldFile && this.selectedNewFile) {
        //     this.startAnalysis();
        // }
    }`;

if (content.match(autoTriggerPattern)) {
    content = content.replace(autoTriggerPattern, replacement);
    console.log('Disabled auto-analysis');
}

fs.writeFileSync(path, content, 'utf8');
console.log('File updated successfully');
