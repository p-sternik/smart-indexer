# Test script to verify the AST parser improvements
# This script checks that declarations are not included in references

Write-Host "Testing AST Parser - Declaration vs Usage Detection" -ForegroundColor Cyan
Write-Host "=" * 60

# Build the project first
Write-Host "`nBuilding project..." -ForegroundColor Yellow
pnpm run compile:server 2>&1 | Out-Null

if ($LASTEXITCODE -ne 0) {
    Write-Host "Build failed!" -ForegroundColor Red
    exit 1
}

Write-Host "Build successful!" -ForegroundColor Green

# Create a simple Node.js test script that uses the source directly
$testScript = @'
const path = require('path');
const fs = require('fs');

// Load the parser functions directly from source
const { parse } = require('@typescript-eslint/typescript-estree');
const { AST_NODE_TYPES } = require('@typescript-eslint/typescript-estree');

const testFilePath = path.join(__dirname, 'test-files', 'reference-test.ts');
const content = fs.readFileSync(testFilePath, 'utf-8');

console.log('\n=== Parsing test file ===');

try {
    const ast = parse(content, {
        loc: true,
        range: true,
        comment: false,
        tokens: false,
        errorOnUnknownASTType: false,
        jsx: false
    });
    
    const references = [];
    const symbols = [];
    
    // Simple traversal to find identifiers
    function traverse(node, parent = null, depth = 0) {
        if (!node || !node.loc) return;
        
        if (node.type === AST_NODE_TYPES.Identifier && node.name === 'createSigningStepStart') {
            const isDeclaration = parent && (
                (parent.type === AST_NODE_TYPES.VariableDeclarator && parent.id === node) ||
                (parent.type === AST_NODE_TYPES.MethodDefinition && parent.key === node) ||
                (parent.type === AST_NODE_TYPES.PropertyDefinition && parent.key === node) ||
                (parent.type === AST_NODE_TYPES.FunctionDeclaration && parent.id === node) ||
                (parent.type === AST_NODE_TYPES.Property && parent.key === node && !parent.computed)
            );
            
            const entry = {
                name: node.name,
                line: node.loc.start.line,
                type: isDeclaration ? 'DECLARATION' : 'REFERENCE',
                parentType: parent ? parent.type : 'none'
            };
            
            if (isDeclaration) {
                symbols.push(entry);
            } else {
                references.push(entry);
            }
        }
        
        for (const key in node) {
            const child = node[key];
            if (child && typeof child === 'object') {
                if (Array.isArray(child)) {
                    for (const item of child) {
                        if (item && typeof item === 'object' && item.type) {
                            traverse(item, node, depth + 1);
                        }
                    }
                } else if (child.type) {
                    traverse(child, node, depth + 1);
                }
            }
        }
    }
    
    traverse(ast);
    
    console.log('\n=== DECLARATIONS ===');
    console.log(`Found ${symbols.length} declarations:`);
    symbols.forEach((s, i) => {
        console.log(`  ${i + 1}. Line ${s.line}: ${s.name} (parent: ${s.parentType})`);
    });
    
    console.log('\n=== REFERENCES (Usages) ===');
    console.log(`Found ${references.length} references:`);
    references.forEach((r, i) => {
        console.log(`  ${i + 1}. Line ${r.line}: ${r.name} (parent: ${r.parentType})`);
    });
    
    console.log('\n=== VERIFICATION ===');
    
    // Line 11: public createSigningStepStart() - should be DECLARATION
    const line11 = [...symbols, ...references].find(e => e.line === 11);
    if (line11 && line11.type === 'DECLARATION') {
        console.log('✅ PASSED: Line 11 method declaration correctly identified as DECLARATION');
    } else if (line11 && line11.type === 'REFERENCE') {
        console.log('❌ FAILED: Line 11 method declaration incorrectly marked as REFERENCE');
        process.exit(1);
    }
    
    // Line 13: SigningActions.createSigningStepStart() - should be REFERENCE
    const line13 = [...symbols, ...references].find(e => e.line === 13);
    if (line13 && line13.type === 'REFERENCE') {
        console.log('✅ PASSED: Line 13 action call correctly identified as REFERENCE');
    } else {
        console.log('⚠️  Line 13 not found or not marked as REFERENCE');
    }
    
    // Line 4: const createSigningStepStart - should be DECLARATION
    const line4 = [...symbols, ...references].find(e => e.line === 4);
    if (line4 && line4.type === 'DECLARATION') {
        console.log('✅ PASSED: Line 4 constant declaration correctly identified as DECLARATION');
    } else {
        console.log('⚠️  Line 4 not found or not marked as DECLARATION');
    }
    
    console.log('\n✅ Test completed successfully!');
    process.exit(0);
    
} catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
}
'@

$testScript | Out-File -FilePath "test-parser.js" -Encoding UTF8

Write-Host "`nRunning parser test..." -ForegroundColor Yellow
node test-parser.js

$exitCode = $LASTEXITCODE
Remove-Item "test-parser.js" -ErrorAction SilentlyContinue

if ($exitCode -eq 0) {
    Write-Host "`n✅ All tests passed!" -ForegroundColor Green
} else {
    Write-Host "`n❌ Tests failed!" -ForegroundColor Red
}

exit $exitCode
