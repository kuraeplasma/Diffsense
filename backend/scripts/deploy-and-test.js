const { spawnSync } = require('child_process');
const path = require('path');

/**
 * Cloud Run Deploy & Health Check Script
 * デプロイ後に自動で本番環境のテストを実行する
 */

const PROJECT_ID = 'diffsense-9a718';
const SERVICE_NAME = 'diffsense-api';
const REGION = 'asia-northeast1';

function runCommand(command, args, options = {}) {
    console.log(`\nExecuting: ${command} ${args.join(' ')}`);
    const result = spawnSync(command, args, { 
        stdio: options.captureOutput ? 'pipe' : 'inherit',
        shell: true,
        encoding: 'utf-8',
        ...options
    });

    if (result.status !== 0) {
        console.error(`Command failed with exit code ${result.status}`);
        if (result.stderr) console.error(result.stderr);
        process.exit(1);
    }
    return result.stdout ? result.stdout.trim() : '';
}

async function main() {
    console.log('=== STEP 1: Deploying to Cloud Run ===');
    runCommand('gcloud', [
        'run', 'deploy', SERVICE_NAME,
        '--source', '.',
        '--region', REGION,
        '--project', PROJECT_ID,
        '--allow-unauthenticated'
    ]);

    console.log('\n=== STEP 2: Getting Service URL ===');
    const serviceUrl = runCommand('gcloud', [
        'run', 'services', 'describe', SERVICE_NAME,
        '--region', REGION,
        '--project', PROJECT_ID,
        '--format', 'value(status.url)'
    ], { captureOutput: true });

    if (!serviceUrl) {
        console.error('Failed to retrieve Service URL');
        process.exit(1);
    }
    console.log(`Service URL: ${serviceUrl}`);

    console.log('\n=== STEP 3: Running Health Check ===');
    // API_BASE 環境変数をセットしてテストを実行
    const testResult = spawnSync('npm', ['run', 'healthcheck'], {
        env: {
            ...process.env,
            API_BASE: serviceUrl
        },
        stdio: 'inherit',
        shell: true
    });

    if (testResult.status !== 0) {
        console.error('\n=======================================');
        console.error('   DEPLOY SUCCESS but HEALTHCHECK FAILED');
        console.error('=======================================');
        console.error('Please check the logs and consider rollback.');
        process.exit(1);
    }

    console.log('\n=======================================');
    console.log('   DEPLOY + HEALTHCHECK SUCCESS');
    console.log('=======================================');
    console.log(`Service is live at: ${serviceUrl}`);
}

main().catch(err => {
    console.error('Script failed:', err);
    process.exit(1);
});
