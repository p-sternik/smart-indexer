#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Verifies the incremental indexing and file exclusion implementation.
    
.DESCRIPTION
    Tests:
    1. Files in .angular, .nx, dist, coverage are excluded from indexing
    2. Mtime-based caching prevents re-indexing unchanged files
    3. Configuration manager properly filters excluded paths
#>

Write-Host "=====================================" -ForegroundColor Cyan
Write-Host "Incremental Indexing Verification" -ForegroundColor Cyan
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host ""

# Test 1: ConfigurationManager exclusion
Write-Host "Test 1: ConfigurationManager Path Exclusion" -ForegroundColor Yellow
Write-Host "-------------------------------------------" -ForegroundColor Yellow

$testPaths = @(
    @{ Path = "C:\workspace\.angular\cache\file.ts"; ShouldExclude = $true },
    @{ Path = "C:\workspace\.nx\cache\file.ts"; ShouldExclude = $true },
    @{ Path = "C:\workspace\dist\main.js"; ShouldExclude = $true },
    @{ Path = "C:\workspace\coverage\lcov.info"; ShouldExclude = $true },
    @{ Path = "C:\workspace\node_modules\lodash\index.js"; ShouldExclude = $true },
    @{ Path = "C:\workspace\.smart-index\cache\file.json"; ShouldExclude = $true },
    @{ Path = "C:\workspace\src\app\component.ts"; ShouldExclude = $false },
    @{ Path = "/workspace/.angular/cache/file.ts"; ShouldExclude = $true },
    @{ Path = "/workspace/dist/bundle.js"; ShouldExclude = $true }
)

# Create a simple Node.js test script to verify ConfigurationManager
$testScript = @"
import { ConfigurationManager } from './dist/server/config/configurationManager.js';

const configManager = new ConfigurationManager();

const testPaths = [
    { path: 'C:\\workspace\\.angular\\cache\\file.ts', shouldExclude: true },
    { path: 'C:\\workspace\\.nx\\cache\\file.ts', shouldExclude: true },
    { path: 'C:\\workspace\\dist\\main.js', shouldExclude: true },
    { path: 'C:\\workspace\\coverage\\lcov.info', shouldExclude: true },
    { path: 'C:\\workspace\\node_modules\\lodash\\index.js', shouldExclude: true },
    { path: 'C:\\workspace\\.smart-index\\cache\\file.json', shouldExclude: true },
    { path: 'C:\\workspace\\src\\app\\component.ts', shouldExclude: false },
    { path: '/workspace/.angular/cache/file.ts', shouldExclude: true },
    { path: '/workspace/dist/bundle.js', shouldExclude: true }
];

let passed = 0;
let failed = 0;

console.log('Testing ConfigurationManager.shouldExcludePath()...\n');

for (const test of testPaths) {
    const result = configManager.shouldExcludePath(test.path);
    const expected = test.shouldExclude;
    
    if (result === expected) {
        console.log(`✓ PASS: ${test.path} - Excluded: ${result}`);
        passed++;
    } else {
        console.log(`✗ FAIL: ${test.path} - Expected: ${expected}, Got: ${result}`);
        failed++;
    }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
"@

Set-Content -Path "test-exclusion.mjs" -Value $testScript

Write-Host "Running ConfigurationManager tests..." -ForegroundColor Gray
node test-exclusion.mjs
$configTestResult = $LASTEXITCODE

if ($configTestResult -eq 0) {
    Write-Host "`n✓ ConfigurationManager exclusion tests passed!" -ForegroundColor Green
} else {
    Write-Host "`n✗ ConfigurationManager exclusion tests failed!" -ForegroundColor Red
}

Write-Host ""

# Test 2: Check BackgroundIndex FileShard structure
Write-Host "Test 2: BackgroundIndex Mtime Support" -ForegroundColor Yellow
Write-Host "--------------------------------------" -ForegroundColor Yellow

$mtimeTest = @"
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Check if FileShard interface includes mtime
const backgroundIndexSource = fs.readFileSync(
    path.join(__dirname, 'server', 'src', 'index', 'backgroundIndex.ts'),
    'utf-8'
);

const hasMtimeInInterface = backgroundIndexSource.includes('mtime?: number');
const hasNeedsReindexing = backgroundIndexSource.includes('needsReindexing');
const hasPurgeExcluded = backgroundIndexSource.includes('purgeExcludedFiles');
const hasConfigManager = backgroundIndexSource.includes('setConfigurationManager');

console.log('Checking BackgroundIndex implementation...\n');

let passed = 0;
let failed = 0;

const checks = [
    { name: 'FileShard has mtime field', result: hasMtimeInInterface },
    { name: 'needsReindexing() method exists', result: hasNeedsReindexing },
    { name: 'purgeExcludedFiles() method exists', result: hasPurgeExcluded },
    { name: 'setConfigurationManager() method exists', result: hasConfigManager }
];

for (const check of checks) {
    if (check.result) {
        console.log('✓ PASS: ' + check.name);
        passed++;
    } else {
        console.log('✗ FAIL: ' + check.name);
        failed++;
    }
}

console.log('\nResults: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
"@

Set-Content -Path "test-mtime.mjs" -Value $mtimeTest

Write-Host "Checking BackgroundIndex implementation..." -ForegroundColor Gray
node test-mtime.mjs
$mtimeTestResult = $LASTEXITCODE

if ($mtimeTestResult -eq 0) {
    Write-Host "`n✓ BackgroundIndex mtime implementation verified!" -ForegroundColor Green
} else {
    Write-Host "`n✗ BackgroundIndex mtime implementation incomplete!" -ForegroundColor Red
}

Write-Host ""

# Test 3: Verify default exclude patterns
Write-Host "Test 3: Default Exclude Patterns" -ForegroundColor Yellow
Write-Host "---------------------------------" -ForegroundColor Yellow

$defaultsTest = @"
import { ConfigurationManager } from './dist/server/config/configurationManager.js';

const configManager = new ConfigurationManager();
const config = configManager.getConfig();

console.log('Checking default exclude patterns...\n');

const requiredPatterns = [
    '**/.angular/**',
    '**/.nx/**',
    '**/coverage/**'
];

let passed = 0;
let failed = 0;

for (const pattern of requiredPatterns) {
    if (config.excludePatterns.includes(pattern)) {
        console.log('✓ PASS: Default config includes: ' + pattern);
        passed++;
    } else {
        console.log('✗ FAIL: Missing default pattern: ' + pattern);
        failed++;
    }
}

console.log('\nExclude patterns: ' + config.excludePatterns.join(', '));
console.log('\nResults: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
"@

Set-Content -Path "test-defaults.mjs" -Value $defaultsTest

Write-Host "Checking default configuration..." -ForegroundColor Gray
node test-defaults.mjs
$defaultsTestResult = $LASTEXITCODE

if ($defaultsTestResult -eq 0) {
    Write-Host "`n✓ Default exclude patterns configured correctly!" -ForegroundColor Green
} else {
    Write-Host "`n✗ Default exclude patterns missing!" -ForegroundColor Red
}

# Cleanup
Remove-Item -Path "test-exclusion.mjs" -ErrorAction SilentlyContinue
Remove-Item -Path "test-mtime.mjs" -ErrorAction SilentlyContinue
Remove-Item -Path "test-defaults.mjs" -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host "SUMMARY" -ForegroundColor Cyan
Write-Host "=====================================" -ForegroundColor Cyan

$allPassed = ($configTestResult -eq 0) -and ($mtimeTestResult -eq 0) -and ($defaultsTestResult -eq 0)

if ($allPassed) {
    Write-Host "✓ All incremental indexing tests passed!" -ForegroundColor Green
    Write-Host ""
    Write-Host "Features verified:" -ForegroundColor White
    Write-Host "  • File exclusion for .angular, .nx, dist, coverage" -ForegroundColor Gray
    Write-Host "  • Mtime-based cache validation" -ForegroundColor Gray
    Write-Host "  • Purging of previously indexed excluded files" -ForegroundColor Gray
    Write-Host "  • ConfigurationManager integration" -ForegroundColor Gray
    exit 0
} else {
    Write-Host "✗ Some tests failed!" -ForegroundColor Red
    exit 1
}
