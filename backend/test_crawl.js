require('dotenv').config();
const cronService = require('./src/services/cronService');
const dbService = require('./src/services/db');
const logger = require('./src/utils/logger');

async function testCrawl() {
    console.log('--- Crawl Test Starting ---');

    // 1. Check if there are any Pro users with monitoring enabled
    const contracts = await dbService.getMonitoringContracts();
    console.log(`Initial contracts found for monitoring: ${contracts.length}`);

    if (contracts.length === 0) {
        console.log('No monitoring contracts found. Temporarily marking one for test...');
        const allContracts = await dbService.getAll('contracts');
        const urlContracts = allContracts.filter(c => c.source_type === 'URL');
        if (urlContracts.length > 0) {
            await dbService.updateContract(urlContracts[0].id, {
                monitoring_enabled: true,
                last_hash: 'initial-dummy-hash'
            });
            console.log(`Marked contract ${urlContracts[0].id} for monitoring.`);
        } else {
            console.log('No URL contracts found in DB to test with.');
            return;
        }
    }

    console.log('Executing crawl logic...');
    await cronService.executeDailyCrawl();

    // Check results
    const updatedContracts = await dbService.getMonitoringContracts();
    updatedContracts.forEach(c => {
        console.log(`Contract ${c.id}: Status=${c.status}, LastHash=${c.last_hash}, StableCount=${c.stable_count}`);
    });

    console.log('--- Crawl Test Finished ---');
}

testCrawl().catch(console.error);
