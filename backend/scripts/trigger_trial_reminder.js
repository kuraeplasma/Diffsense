const cronService = require('../src/services/cronService');
const logger = require('../src/utils/logger');

async function trigger() {
    logger.info('--- Trial Reminder Manual Trigger Start ---');
    try {
        await cronService.executeTrialReminder();
        logger.info('--- Trial Reminder Manual Trigger End ---');
    } catch (error) {
        logger.error('Manual trigger failed:', error);
    }
}

trigger();
