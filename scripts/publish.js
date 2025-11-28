#!/usr/bin/env node
/**
 * Cross-platform publish script for VS Code Marketplace.
 * 
 * Usage:
 *   node scripts/publish.js package   - Creates .vsix package
 *   node scripts/publish.js publish   - Publishes to marketplace
 */

const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const command = process.argv[2];

if (!command || !['package', 'publish'].includes(command)) {
    console.error('Usage: node scripts/publish.js <package|publish>');
    process.exit(1);
}

function runCommand(cmd, args) {
    return new Promise((resolve, reject) => {
        console.log(`🚀 Running: ${cmd} ${args.join(' ')}`);
        const isWindows = process.platform === 'win32';
        const child = spawn(cmd, args, {
            cwd: ROOT,
            stdio: 'inherit',
            shell: isWindows
        });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`Command failed with exit code ${code}`));
            }
        });
    });
}

async function main() {
    const vsceArgs = command === 'package' 
        ? ['vsce', 'package'] 
        : ['vsce', 'publish'];

    try {
        await runCommand('npx', vsceArgs);
        console.log('✅ Build completed successfully');
    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exitCode = 1;
    }
}

main();
