# verify-mermaid.ps1
# Manual verification checklist for Mermaid Graph export feature

Write-Host "============================================" -ForegroundColor Cyan
Write-Host " Mermaid Export Feature - Verification" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# Step 1: Check package.json configuration
Write-Host "[1/4] Checking package.json configuration..." -ForegroundColor Yellow

$packageJson = Get-Content -Path "package.json" -Raw | ConvertFrom-Json

# Check command title
$mermaidCommand = $packageJson.contributes.commands | Where-Object { $_.command -eq "smart-indexer.exportMermaid" }
if ($mermaidCommand.title -eq "Copy Dependency Graph (Mermaid)") {
    Write-Host "  [PASS] Command title is correct: '$($mermaidCommand.title)'" -ForegroundColor Green
} else {
    Write-Host "  [FAIL] Command title is '$($mermaidCommand.title)', expected 'Copy Dependency Graph (Mermaid)'" -ForegroundColor Red
}

# Check explorer/context menu
$explorerContext = $packageJson.contributes.menus.'explorer/context'
$mermaidInExplorer = $explorerContext | Where-Object { $_.command -eq "smart-indexer.exportMermaid" }
if ($mermaidInExplorer) {
    Write-Host "  [PASS] Command is in explorer/context menu" -ForegroundColor Green
    if ($mermaidInExplorer.group -eq "navigation@2") {
        Write-Host "  [PASS] Menu group is 'navigation@2'" -ForegroundColor Green
    } else {
        Write-Host "  [FAIL] Menu group is '$($mermaidInExplorer.group)', expected 'navigation@2'" -ForegroundColor Red
    }
} else {
    Write-Host "  [FAIL] Command is NOT in explorer/context menu" -ForegroundColor Red
}

# Step 2: Check extension.ts for Uri handling
Write-Host ""
Write-Host "[2/4] Checking extension.ts for Uri argument handling..." -ForegroundColor Yellow

$extensionTs = Get-Content -Path "src\extension.ts" -Raw
if ($extensionTs -match "arg instanceof vscode\.Uri") {
    Write-Host "  [PASS] Command handles vscode.Uri argument (Explorer context)" -ForegroundColor Green
} else {
    Write-Host "  [FAIL] Command does NOT handle vscode.Uri argument" -ForegroundColor Red
}

if ($extensionTs -match "resourceUri") {
    Write-Host "  [PASS] Command handles TreeItem.resourceUri (Tree View)" -ForegroundColor Green
} else {
    Write-Host "  [FAIL] Command does NOT handle TreeItem.resourceUri" -ForegroundColor Red
}

if ($extensionTs -match "activeTextEditor") {
    Write-Host "  [PASS] Command handles activeTextEditor fallback (Command Palette)" -ForegroundColor Green
} else {
    Write-Host "  [FAIL] Command does NOT handle activeTextEditor fallback" -ForegroundColor Red
}

# Step 3: Build check
Write-Host ""
Write-Host "[3/4] Running TypeScript build..." -ForegroundColor Yellow

$buildResult = npm run compile 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host "  [PASS] TypeScript compilation successful" -ForegroundColor Green
} else {
    Write-Host "  [FAIL] TypeScript compilation failed:" -ForegroundColor Red
    Write-Host $buildResult -ForegroundColor Red
}

# Step 4: Manual testing checklist
Write-Host ""
Write-Host "[4/4] Manual Testing Checklist" -ForegroundColor Yellow
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Please verify the following manually in VS Code:" -ForegroundColor White
Write-Host ""
Write-Host "  1. Open VS Code with this extension loaded (F5 to debug)" -ForegroundColor White
Write-Host ""
Write-Host "  2. TEST: Explorer Context Menu" -ForegroundColor Magenta
Write-Host "     - Right-click on any .ts file in the Explorer" -ForegroundColor Gray
Write-Host "     - Look for 'Copy Dependency Graph (Mermaid)' in the menu" -ForegroundColor Gray
Write-Host "     - Click it and paste (Ctrl+V) somewhere" -ForegroundColor Gray
Write-Host "     - Verify output starts with 'graph TD'" -ForegroundColor Gray
Write-Host ""
Write-Host "  3. TEST: Command Palette" -ForegroundColor Magenta
Write-Host "     - Open a .ts file" -ForegroundColor Gray
Write-Host "     - Press Ctrl+Shift+P" -ForegroundColor Gray
Write-Host "     - Type 'Copy Dependency Graph'" -ForegroundColor Gray
Write-Host "     - Run the command and verify clipboard content" -ForegroundColor Gray
Write-Host ""
Write-Host "  4. TEST: Impact Analysis View" -ForegroundColor Magenta
Write-Host "     - Right-click a file -> Show Impact Analysis" -ForegroundColor Gray
Write-Host "     - In the Impact Analysis panel, click the export icon" -ForegroundColor Gray
Write-Host "     - Verify Mermaid diagram is copied" -ForegroundColor Gray
Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host " Expected Mermaid Output Format:" -ForegroundColor Yellow
Write-Host "============================================" -ForegroundColor Cyan
Write-Host '  graph TD' -ForegroundColor Gray
Write-Host '    A["src/extension.ts"]' -ForegroundColor Gray
Write-Host '    B["src/features/mermaidExporter.ts"]' -ForegroundColor Gray
Write-Host '    A --> B' -ForegroundColor Gray
Write-Host ""
Write-Host "Verification complete!" -ForegroundColor Green
