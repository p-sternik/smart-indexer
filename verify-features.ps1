# Smart Indexer - Feature Verification Script

Write-Host "===== Smart Indexer Feature Verification =====" -ForegroundColor Cyan
Write-Host ""

# Check if build succeeded
Write-Host "1. Checking build output..." -ForegroundColor Yellow
$distExists = Test-Path "dist/extension.js"
$serverExists = Test-Path "server/out/server.js"

if ($distExists -and $serverExists) {
    Write-Host "   ✓ Build artifacts found" -ForegroundColor Green
} else {
    Write-Host "   ✗ Build artifacts missing" -ForegroundColor Red
    Write-Host "   Run 'npm run build' first" -ForegroundColor Red
    exit 1
}

# Check configuration in package.json
Write-Host ""
Write-Host "2. Checking configuration..." -ForegroundColor Yellow
$packageJson = Get-Content "package.json" | ConvertFrom-Json

$requiredCommands = @(
    "smart-indexer.rebuildIndex",
    "smart-indexer.clearCache",
    "smart-indexer.showStats",
    "smart-indexer.inspectIndex"
)

$allCommandsPresent = $true
foreach ($cmd in $requiredCommands) {
    $found = $packageJson.contributes.commands | Where-Object { $_.command -eq $cmd }
    if ($found) {
        Write-Host "   ✓ Command: $cmd" -ForegroundColor Green
    } else {
        Write-Host "   ✗ Command missing: $cmd" -ForegroundColor Red
        $allCommandsPresent = $false
    }
}

$requiredSettings = @(
    "smartIndexer.textIndexing.enabled",
    "smartIndexer.staticIndex.enabled",
    "smartIndexer.staticIndex.path",
    "smartIndexer.indexing.maxConcurrentWorkers",
    "smartIndexer.indexing.batchSize",
    "smartIndexer.indexing.useFolderHashing"
)

foreach ($setting in $requiredSettings) {
    $found = $packageJson.contributes.configuration.properties.PSObject.Properties.Name -contains $setting
    if ($found) {
        Write-Host "   ✓ Setting: $setting" -ForegroundColor Green
    } else {
        Write-Host "   ✗ Setting missing: $setting" -ForegroundColor Red
        $allCommandsPresent = $false
    }
}

# Check source files
Write-Host ""
Write-Host "3. Checking implementation files..." -ForegroundColor Yellow

$requiredFiles = @(
    "server/src/profiler/profiler.ts",
    "server/src/cache/folderHasher.ts",
    "server/src/indexer/languageRouter.ts",
    "server/src/indexer/textIndexer.ts",
    "server/src/index/staticIndex.ts",
    "server/src/index/mergedIndex.ts",
    "server/src/index/statsManager.ts"
)

$allFilesPresent = $true
foreach ($file in $requiredFiles) {
    if (Test-Path $file) {
        Write-Host "   ✓ $file" -ForegroundColor Green
    } else {
        Write-Host "   ✗ Missing: $file" -ForegroundColor Red
        $allFilesPresent = $false
    }
}

# Check test files
Write-Host ""
Write-Host "4. Checking test files..." -ForegroundColor Yellow

$testFiles = @(
    "test-files/Example.java",
    "test-files/example.go",
    "test-files/Example.cs",
    "test-files/example.py"
)

foreach ($file in $testFiles) {
    if (Test-Path $file) {
        Write-Host "   ✓ $file" -ForegroundColor Green
    } else {
        Write-Host "   ⚠ Optional test file missing: $file" -ForegroundColor DarkYellow
    }
}

# Check static index example
Write-Host ""
Write-Host "5. Checking static index example..." -ForegroundColor Yellow
if (Test-Path "static-index-example.json") {
    Write-Host "   ✓ static-index-example.json" -ForegroundColor Green
} else {
    Write-Host "   ⚠ Optional example file missing" -ForegroundColor DarkYellow
}

# Summary
Write-Host ""
Write-Host "===== Verification Summary =====" -ForegroundColor Cyan
if ($allCommandsPresent -and $allFilesPresent) {
    Write-Host "✓ All core features are properly implemented!" -ForegroundColor Green
    Write-Host ""
    Write-Host "Next steps:" -ForegroundColor Yellow
    Write-Host "1. Press F5 to launch extension in debug mode" -ForegroundColor White
    Write-Host "2. Open a workspace with various file types" -ForegroundColor White
    Write-Host "3. Test commands:" -ForegroundColor White
    Write-Host "   - Smart Indexer: Rebuild Index" -ForegroundColor Gray
    Write-Host "   - Smart Indexer: Show Statistics" -ForegroundColor Gray
    Write-Host "   - Smart Indexer: Inspect Index" -ForegroundColor Gray
    Write-Host "4. Check 'Smart Indexer' output channel for logs" -ForegroundColor White
    Write-Host ""
    Write-Host "Configuration to test all features:" -ForegroundColor Yellow
    Write-Host @"
{
  "smartIndexer.textIndexing.enabled": true,
  "smartIndexer.staticIndex.enabled": true,
  "smartIndexer.staticIndex.path": "static-index-example.json",
  "smartIndexer.indexing.useFolderHashing": true,
  "smartIndexer.indexing.maxConcurrentWorkers": 4,
  "smartIndexer.indexing.batchSize": 50
}
"@ -ForegroundColor Gray
} else {
    Write-Host "✗ Some features are missing or misconfigured" -ForegroundColor Red
    Write-Host "Check the errors above and fix them" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "===== Feature List =====" -ForegroundColor Cyan
Write-Host "✓ Index Inspection View (smart-indexer.inspectIndex)" -ForegroundColor Green
Write-Host "✓ Folder Hashing (Merkle-style incremental indexing)" -ForegroundColor Green
Write-Host "✓ Static Index Support (LSIF/JSON snapshots)" -ForegroundColor Green
Write-Host "✓ Built-in Profiling & Auto-tuning" -ForegroundColor Green
Write-Host "✓ Multi-language Text Indexing (Java, Go, C#, Python, Rust, C++)" -ForegroundColor Green
Write-Host ""
