#!/usr/bin/env node
/**
 * Cross-platform publish script that swaps README.md with MARKETPLACE_README.md
 * during the build/publish process to ensure VS Code Marketplace displays the correct content.
 * 
 * Usage:
 *   node scripts/publish.js package   - Creates .vsix package
 *   node scripts/publish.js publish   - Publishes to marketplace
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const README = path.join(ROOT, 'README.md');
const README_BACKUP = path.join(ROOT, 'README.md.dev');
const MARKETPLACE_README = path.join(ROOT, 'MARKETPLACE_README.md');

const command = process.argv[2];

if (!command || !['package', 'publish'].includes(command)) {
    console.error('Usage: node scripts/publish.js <package|publish>');
    process.exit(1);
}

function fileExists(filePath) {
    try {
        return fs.existsSync(filePath);
    } catch {
        return false;
    }
}

function backup() {
    console.log('📦 Backing up README.md → README.md.dev');
    if (!fileExists(README)) {
        throw new Error('README.md not found');
    }
    if (fileExists(README_BACKUP)) {
        throw new Error('README.md.dev already exists - previous run may have failed. Please restore manually.');
    }
    fs.renameSync(README, README_BACKUP);
}

function swap() {
    console.log('🔄 Copying MARKETPLACE_README.md → README.md');
    if (!fileExists(MARKETPLACE_README)) {
        throw new Error('MARKETPLACE_README.md not found');
    }
    fs.copyFileSync(MARKETPLACE_README, README);
}

function restore() {
    console.log('🔙 Restoring README.md from README.md.dev');
    if (fileExists(README)) {
        fs.unlinkSync(README);
    }
    if (fileExists(README_BACKUP)) {
        fs.renameSync(README_BACKUP, README);
        console.log('✅ README.md restored successfully');
    } else {
        console.warn('⚠️ README.md.dev not found - nothing to restore');
    }
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
    let vsceArgs;
    if (command === 'package') {
        vsceArgs = ['vsce', 'package'];
    } else {
        vsceArgs = ['vsce', 'publish'];
    }

    try {
        // Step 1: Backup
        backup();
        
        // Step 2: Swap
        swap();
        
        // Step 3: Execute
        await runCommand('npx', vsceArgs);
        
        console.log('✅ Build completed successfully');
    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exitCode = 1;
    } finally {
        // Step 4: Always restore
        restore();
    }
}

main();
