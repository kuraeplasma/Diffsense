'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), override: true });

const { collectEnvValidation } = require('../src/config/env');

const result = collectEnvValidation();

if (!result.isProduction) {
    console.log('Production env check skipped: NODE_ENV is not production.');
    process.exit(0);
}

if (result.errors.length > 0) {
    console.error('Production environment validation failed:');
    for (const error of result.errors) {
        console.error(`- ${error}`);
    }
    if (result.warnings.length > 0) {
        console.error('Warnings:');
        for (const warning of result.warnings) {
            console.error(`- ${warning}`);
        }
    }
    process.exit(1);
}

console.log('Production environment validation passed.');
if (result.warnings.length > 0) {
    console.log('Warnings:');
    for (const warning of result.warnings) {
        console.log(`- ${warning}`);
    }
}
