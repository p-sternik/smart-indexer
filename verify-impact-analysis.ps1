# Impact Analysis Feature Verification Script

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Impact Analysis Feature Verification" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

$errors = 0
$warnings = 0

# Check server files
Write-Host "Checking Server Files..." -ForegroundColor Yellow

$serverFiles = @(
    "server\src\features\dependencyGraph.ts",
    "server\src\index\ISymbolIndex.ts",
    "server\src\server.ts"
)

foreach ($file in $serverFiles) {
    if (Test-Path $file) {
        Write-Host "  ✓ $file" -ForegroundColor Green
    } else {
        Write-Host "  ✗ $file MISSING" -ForegroundColor Red
        $errors++
    }
}

# Check client files
Write-Host ""
Write-Host "Checking Client Files..." -ForegroundColor Yellow

$clientFiles = @(
    "src\providers\DependencyTreeProvider.ts",
    "src\features\mermaidExporter.ts",
    "src\extension.ts"
)

foreach ($file in $clientFiles) {
    if (Test-Path $file) {
        Write-Host "  ✓ $file" -ForegroundColor Green
    } else {
        Write-Host "  ✗ $file MISSING" -ForegroundColor Red
        $errors++
    }
}

# Check documentation
Write-Host ""
Write-Host "Checking Documentation..." -ForegroundColor Yellow

$docFiles = @(
    "docs\IMPACT_ANALYSIS.md",
    "docs\IMPACT_ANALYSIS_QUICK_REF.md",
    "docs\IMPACT_ANALYSIS_IMPLEMENTATION.md",
    "IMPACT_ANALYSIS_COMPLETE.md"
)

foreach ($file in $docFiles) {
    if (Test-Path $file) {
        Write-Host "  ✓ $file" -ForegroundColor Green
    } else {
        Write-Host "  ✗ $file MISSING" -ForegroundColor Red
        $errors++
    }
}

# Check compiled output
Write-Host ""
Write-Host "Checking Compiled Output..." -ForegroundColor Yellow

if (Test-Path "dist\extension.js") {
    Write-Host "  ✓ Client bundle (dist\extension.js)" -ForegroundColor Green
} else {
    Write-Host "  ✗ Client bundle MISSING" -ForegroundColor Red
    $errors++
}

if (Test-Path "server\out\server.js") {
    Write-Host "  ✓ Server bundle (server\out\server.js)" -ForegroundColor Green
} else {
    Write-Host "  ✗ Server bundle MISSING" -ForegroundColor Red
    $errors++
}

# Check bundle contents
Write-Host ""
Write-Host "Verifying Bundle Contents..." -ForegroundColor Yellow

$serverBundle = Get-Content "server\out\server.js" -Raw
if ($serverBundle -match "DependencyGraphService") {
    Write-Host "  ✓ DependencyGraphService in server bundle" -ForegroundColor Green
} else {
    Write-Host "  ✗ DependencyGraphService NOT in server bundle" -ForegroundColor Red
    $errors++
}

if ($serverBundle -match "generateMermaid") {
    Write-Host "  ✓ generateMermaid in server bundle" -ForegroundColor Green
} else {
    Write-Host "  ✗ generateMermaid NOT in server bundle" -ForegroundColor Red
    $errors++
}

$clientBundle = Get-Content "dist\extension.js" -Raw
if ($clientBundle -match "DependencyTreeProvider") {
    Write-Host "  ✓ DependencyTreeProvider in client bundle" -ForegroundColor Green
} else {
    Write-Host "  ✗ DependencyTreeProvider NOT in client bundle" -ForegroundColor Red
    $errors++
}

if ($clientBundle -match "MermaidExporter") {
    Write-Host "  ✓ MermaidExporter in client bundle" -ForegroundColor Green
} else {
    Write-Host "  ✗ MermaidExporter NOT in client bundle" -ForegroundColor Red
    $errors++
}

# Check package.json
Write-Host ""
Write-Host "Checking package.json..." -ForegroundColor Yellow

$packageJson = Get-Content "package.json" -Raw | ConvertFrom-Json

$commands = @(
    "smart-indexer.showImpact",
    "smart-indexer.exportMermaid",
    "smart-indexer.refreshDependencyTree"
)

foreach ($cmd in $commands) {
    $found = $packageJson.contributes.commands | Where-Object { $_.command -eq $cmd }
    if ($found) {
        Write-Host "  ✓ Command: $cmd" -ForegroundColor Green
    } else {
        Write-Host "  ✗ Command MISSING: $cmd" -ForegroundColor Red
        $errors++
    }
}

# Check views
$viewId = "smartIndexer.dependencyTree"
$view = $packageJson.contributes.views.explorer | Where-Object { $_.id -eq $viewId }
if ($view) {
    Write-Host "  ✓ View: $viewId" -ForegroundColor Green
} else {
    Write-Host "  ✗ View MISSING: $viewId" -ForegroundColor Red
    $errors++
}

# Summary
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Verification Summary" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

if ($errors -eq 0 -and $warnings -eq 0) {
    Write-Host "✓ All checks passed!" -ForegroundColor Green
    Write-Host ""
    Write-Host "The Impact Analysis feature is fully implemented and ready for testing." -ForegroundColor Green
    Write-Host ""
    Write-Host "To test:" -ForegroundColor Cyan
    Write-Host "  1. Press F5 to launch Extension Development Host" -ForegroundColor White
    Write-Host "  2. Open a TypeScript/JavaScript project" -ForegroundColor White
    Write-Host "  3. Right-click on a file → 'Show Impact Analysis'" -ForegroundColor White
    Write-Host "  4. Choose Incoming or Outgoing" -ForegroundColor White
    Write-Host "  5. View the tree in the sidebar" -ForegroundColor White
    Write-Host "  6. Click the export icon to copy Mermaid diagram" -ForegroundColor White
    Write-Host ""
    exit 0
} else {
    Write-Host "✗ Verification failed with $errors error(s) and $warnings warning(s)" -ForegroundColor Red
    Write-Host ""
    exit 1
}
