const cron = require('node-cron');
const dbService = require('./db');
const crawlService = require('./crawlService');
const logger = require('../utils/logger');

class CronService {
    constructor() {
        this.isExecuting = false;
    }

    /**
     * Start the daily cron job
     */
    init() {
        // Run every day at 03:00 JST - URL monitoring crawl
        cron.schedule('0 3 * * *', () => {
            logger.info('Starting scheduled daily crawling task...');
            this.executeDailyCrawl();
        });

        // Run at 00:05 on the 1st of every month - reset usage counts
        cron.schedule('5 0 1 * *', () => {
            logger.info('Starting monthly usage reset...');
            this.executeMonthlyReset();
        });

        // Run every day at 09:00 JST - deadline alerts
        cron.schedule('0 9 * * *', () => {
            logger.info('Starting daily deadline alert check...');
            this.executeDeadlineAlert();
        });

        logger.info('Cron Service initialized');
    }

    /**
     * Execute the crawling task for all eligible contracts
     */
    async executeDailyCrawl() {
        if (this.isExecuting) {
            logger.warn('Crawl task already in progress. Skipping.');
            return;
        }

        this.isExecuting = true;
        try {
            const contracts = await dbService.getMonitoringContracts();
            logger.info(`Found ${contracts.length} contracts for monitoring.`);

            for (const contract of contracts) {
                try {
                    if (this.shouldCrawl(contract)) {
                        await this.processContract(contract);
                    }
                } catch (err) {
                    logger.error(`Error processing contract ${contract.id}:`, err.message);
                }
            }
        } catch (error) {
            logger.error('Daily Crawl Error:', error);
        } finally {
            this.isExecuting = false;
            logger.info('Daily crawling task completed.');
        }
    }

    /**
     * Determine if a contract should be crawled today based on back-off logic
     */
    shouldCrawl(contract) {
        const lastChecked = contract.last_checked_at ? new Date(contract.last_checked_at) : null;
        if (!lastChecked) return true; // Never checked

        const stableCount = contract.stable_count || 0;
        const now = new Date();
        const diffDays = Math.floor((now - lastChecked) / (1000 * 60 * 60 * 24));

        // Logic from requirements:
        // 7 days stable -> check every 2 days
        // 14 days stable -> check 3 times a week (approx every 2-3 days)
        let interval = 1;
        if (stableCount >= 14) {
            interval = 3; // Check every 3 days
        } else if (stableCount >= 7) {
            interval = 2; // Check every 2 days
        }

        return diffDays >= interval;
    }

    /**
     * Crawl a single contract, check for changes, and update DB.
     * First crawl: save as baseline, no notification.
     * Subsequent crawl with change: AI summary + notification.
     */
    async processContract(contract) {
        logger.info(`Processing contract ${contract.id}: ${contract.source_url}`);

        const result = await crawlService.fetchAndExtract(contract.source_url);
        const isFirstCrawl = !contract.last_hash;

        const updates = {
            last_checked_at: new Date().toISOString(),
            last_hash: result.hash,
            original_content: result.text
        };

        if (isFirstCrawl) {
            // First crawl: save baseline only, no notification
            logger.info(`First crawl baseline saved for contract ${contract.id}`);
            updates.stable_count = 0;
        } else if (crawlService.hasChanged(result.hash, contract.last_hash)) {
            // Real change from existing baseline
            logger.info(`Change detected in contract ${contract.id}`);
            updates.status = 'リスク要確認';
            updates.stable_count = 0;

            // Get AI-generated change summary
            const changeSummary = await this.getChangeSummary(contract.original_content, result.text);

            // Send notifications
            try {
                await this.sendChangeNotifications(contract, { ...result, summary: changeSummary });
            } catch (notifyErr) {
                logger.error(`Notification failed for contract ${contract.id}: ${notifyErr.message}`);
            }
        } else {
            // No change
            logger.info(`No change in contract ${contract.id}`);
            updates.stable_count = (contract.stable_count || 0) + 1;
            // Keep existing original_content unchanged
            delete updates.original_content;
        }

        await dbService.updateContract(contract.id, updates, contract.ownerUid || null);
    }

    /**
     * Use Gemini AI to summarize what changed between two text versions
     */
    async getChangeSummary(oldText, newText) {
        try {
            const geminiService = require('./gemini');
            const maxLen = 3000;
            const oldSnip = (oldText || '').slice(0, maxLen);
            const newSnip = (newText || '').slice(0, maxLen);
            const prompt = `以下はWebページの変更前後のテキストです。何が変わったか100文字程度で日本語で端的にまとめてください。\n\n【変更前】\n${oldSnip}\n\n【変更後】\n${newSnip}`;
            const summary = await geminiService.generateText(prompt);
            return (summary || '').trim().slice(0, 200);
        } catch (err) {
            logger.warn(`AI change summary failed: ${err.message}`);
            return '';
        }
    }

    /**
     * 変更検知時の通知送信（Slack + Email）
     */
    async sendChangeNotifications(contract, crawlResult) {
        const ownerUid = contract.ownerUid;
        if (!ownerUid) return;

        const notifSettings = await dbService.getNotificationSettings(ownerUid);
        const userProfile = await dbService.getUserProfile(ownerUid);
        const contractName = contract.name || contract.source_url || '契約';
        const detectedAt = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
        const sourceUrl = contract.source_url || '';

        const changeSummary = crawlResult.summary || '';

        // メール通知
        if (notifSettings?.email?.crawlAlert !== false && userProfile?.email) {
            try {
                const mailer = require('./mailer');
                await mailer.sendCrawlChangeAlertEmail(
                    userProfile.email,
                    userProfile.name || '',
                    contractName,
                    sourceUrl,
                    detectedAt,
                    changeSummary
                );
            } catch (err) {
                logger.error(`Email notification failed: ${err.message}`);
            }
        }

        // Slack通知
        if (notifSettings?.slack?.enabled && notifSettings?.slack?.webhookUrl) {
            try {
                const slackService = require('./slackService');
                await slackService.sendSlackNotification(
                    notifSettings.slack.webhookUrl,
                    contractName,
                    sourceUrl,
                    detectedAt,
                    changeSummary
                );
            } catch (err) {
                logger.error(`Slack notification failed: ${err.message}`);
            }
        }
    }
    /**
     * Check contract deadlines and send alerts for contracts expiring soon.
     * Runs every day at 09:00 JST.
     * Alert thresholds: 30 days, 7 days, 0 days (same day).
     */
    async executeDeadlineAlert() {
        try {
            const contracts = await dbService.getAllContractsForDeadlineCheck();
            logger.info(`Deadline check: ${contracts.length} contracts to check`);

            const today = new Date();
            today.setHours(0, 0, 0, 0);

            for (const contract of contracts) {
                try {
                    await this.checkContractDeadline(contract, today);
                } catch (err) {
                    logger.error(`Deadline check error for contract ${contract.id}: ${err.message}`);
                }
            }
        } catch (error) {
            logger.error('Deadline alert error:', error);
        }
    }

    /**
     * Check a single contract's deadlines and send notification if needed.
     */
    async checkContractDeadline(contract, today) {
        const targetDate = contract.renewal_deadline || contract.expiry_date;
        if (!targetDate) return;

        const deadline = new Date(targetDate);
        deadline.setHours(0, 0, 0, 0);
        const daysRemaining = Math.round((deadline - today) / (1000 * 60 * 60 * 24));

        // Only alert for future or same-day deadlines
        if (daysRemaining < 0) return;

        let alertField = null;
        if (daysRemaining === 0 && !contract.alert_sent_0d) {
            alertField = 'alert_sent_0d';
        } else if (daysRemaining <= 7 && !contract.alert_sent_7d) {
            alertField = 'alert_sent_7d';
        } else if (daysRemaining <= 30 && !contract.alert_sent_30d) {
            alertField = 'alert_sent_30d';
        }

        if (!alertField) return;

        const ownerUid = contract.ownerUid;
        if (!ownerUid) return;

        const notifSettings = await dbService.getNotificationSettings(ownerUid);
        const userProfile = await dbService.getUserProfile(ownerUid);
        const frontendUrl = (process.env.FRONTEND_URL || 'https://diffsense.spacegleam.co.jp').replace(/\/$/, '');
        const dashboardUrl = `${frontendUrl}/dashboard.html#deadlines`;

        // Email alert (all plans)
        if (notifSettings?.email?.crawlAlert !== false && userProfile?.email) {
            try {
                const mailer = require('./mailer');
                await mailer.sendDeadlineAlertEmail({
                    to: userProfile.email,
                    userName: userProfile.name || '',
                    contractName: contract.name || '契約書',
                    expiryDate: contract.expiry_date || null,
                    renewalDeadline: contract.renewal_deadline || null,
                    daysRemaining,
                    dashboardUrl
                });
            } catch (err) {
                logger.error(`Deadline email failed for contract ${contract.id}: ${err.message}`);
            }
        }

        // Slack alert (Business+ only)
        const plan = userProfile?.plan || 'free';
        const slackEligible = ['business', 'pro'].includes(plan);
        if (slackEligible && notifSettings?.slack?.enabled && notifSettings?.slack?.webhookUrl && notifSettings?.slack?.deadlineAlert !== false) {
            try {
                const slackService = require('./slackService');
                await slackService.sendDeadlineAlertSlack(notifSettings.slack.webhookUrl, {
                    contractName: contract.name || '契約書',
                    daysRemaining,
                    expiryDate: contract.expiry_date || null,
                    renewalDeadline: contract.renewal_deadline || null,
                    dashboardUrl
                });
            } catch (err) {
                logger.error(`Deadline Slack failed for contract ${contract.id}: ${err.message}`);
            }
        }

        // Mark alert as sent
        await dbService.updateContract(contract.id, { [alertField]: true }, contract.ownerUid || null);
        logger.info(`Deadline alert sent for contract ${contract.id}, field=${alertField}, daysRemaining=${daysRemaining}`);
    }

    /**
     * Reset monthly usage counts for all paid users
     * Runs on the 1st of every month
     */
    async executeMonthlyReset() {
        try {
            const users = await dbService.readData('users');
            let resetCount = 0;

            for (const user of users) {
                // Only reset for users with active payment (not trial users)
                if (user.hasPaymentMethod && user.paypalStatus === 'ACTIVE') {
                    await dbService.resetMonthlyUsage(user.uid);
                    resetCount++;
                }
            }

            logger.info(`Monthly usage reset completed: ${resetCount} users reset`);
        } catch (error) {
            logger.error('Monthly reset error:', error);
        }
    }
}

module.exports = new CronService();
