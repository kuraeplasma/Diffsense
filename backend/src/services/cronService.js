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

        // Trial Reminder (New)
        const trialCron = process.env.TRIAL_REMINDER_CRON || "0 10 * * *";
        if (process.env.TRIAL_REMINDER_ENABLED === 'true') {
            cron.schedule(trialCron, () => {
                logger.info('Starting scheduled trial reminder task...');
                this.executeTrialReminder();
            });
            logger.info(`Trial Reminder scheduled at ${trialCron}`);
        }

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
     * Crawl a single contract, check for changes, and update DB
     */
    async processContract(contract) {
        logger.info(`Processing contract ${contract.id}: ${contract.source_url}`);

        const result = await crawlService.fetchAndExtract(contract.source_url);
        const changed = crawlService.hasChanged(result.hash, contract.last_hash);

        const updates = {
            last_checked_at: new Date().toISOString(),
            last_hash: result.hash
        };

        if (changed) {
            logger.info(`Change detected in contract ${contract.id}`);
            updates.status = 'リスク要確認';
            updates.original_content = result.text;
            updates.stable_count = 0;

            // 通知を送信
            try {
                await this.sendChangeNotifications(contract, result);
            } catch (notifyErr) {
                logger.error(`Notification failed for contract ${contract.id}: ${notifyErr.message}`);
            }
        } else {
            logger.info(`No change in contract ${contract.id}`);
            updates.stable_count = (contract.stable_count || 0) + 1;
        }

        await dbService.updateContract(contract.id, updates);
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
    async executeTrialReminder() {
        try {
            const users = await dbService.readData('users');
            const daysBefore = parseInt(process.env.TRIAL_REMINDER_DAYS_BEFORE || "3", 10);
            const trialDuration = 7; // Matching db.js TRIAL_DURATION_DAYS

            const emailService = require('./email');
            let sentCount = 0;

            for (const user of users) {
                if (!user.trialStartedAt || user.hasPaymentMethod) continue;

                const trialStart = new Date(user.trialStartedAt);
                const now = new Date();
                const diffTime = now - trialStart;
                const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

                // If diffDays = 4, then 3 days left until day 7
                if (diffDays === (trialDuration - daysBefore)) {
                    logger.info(`Sending trial reminder to ${user.email} (${daysBefore} days left)`);
                    await emailService.sendTrialReminderEmail(user.email, user.name || 'ユーザー', daysBefore);
                    sentCount++;
                }
            }
            logger.info(`Trial reminder check completed: ${sentCount} reminders sent`);
        } catch (error) {
            logger.error('Trial reminder execution error:', error);
        }
    }
}

module.exports = new CronService();
