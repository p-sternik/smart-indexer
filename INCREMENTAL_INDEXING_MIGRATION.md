# Incremental Indexing Migration Guide

## For Users

### What Changed?

Your Smart Indexer extension just got **much faster** and **cleaner**!

#### 1. **Faster Restarts** 🚀
- **Before:** Re-indexed ALL files on every VS Code restart
- **After:** Only re-indexes files that actually changed
- **Result:** 10-100x faster startup for typical projects

#### 2. **Cleaner Index** 🧹
- **Before:** Indexed build artifacts (`.angular/`, `dist/`, `node_modules/`)
- **After:** Automatically excludes build artifacts
- **Result:** Faster searches, less memory usage, accurate results

---

## First Run After Update

### What Will Happen?

1. **One-time cleanup:** Extension will remove any previously indexed build artifacts
2. **Mtime capture:** Extension will record file modification times
3. **Normal indexing:** All files will be indexed (first time only)

### What You'll See in Logs:

```
[BackgroundIndex] Purging 1,234 excluded files from cache
[BackgroundIndex] Excluded 567 files from indexing (build artifacts, node_modules, etc.)
[BackgroundIndex] Indexing 5,432 files with 4 concurrent jobs
```

---

## Second Run and Beyond

### What Will Happen?

1. **Lightning-fast startup:** Only changed files are re-indexed
2. **Minimal I/O:** Just checks file modification times (no content hashing)

### What You'll See in Logs:

```
[BackgroundIndex] All files up to date (mtime-based check)
```

Or if you edited a few files:

```
[BackgroundIndex] Indexing 3 files with 4 concurrent jobs
```

---

## Excluded Directories (Automatic)

These directories are **automatically excluded** - no configuration needed:

- `.angular/` - Angular build cache
- `.nx/` - Nx build cache
- `dist/` - Build output
- `out/` - Build output
- `build/` - Build output
- `coverage/` - Test coverage reports
- `node_modules/` - Dependencies
- `.smart-index/` - Extension's own cache

---

## Custom Exclusions (Optional)

Want to exclude additional directories? Add to `.vscode/settings.json`:

```json
{
  "smartIndexer.excludePatterns": [
    "**/.angular/**",
    "**/.nx/**",
    "**/my-custom-build/**",
    "**/tmp/**"
  ]
}
```

**Note:** The hardcoded exclusions (above) always apply, even if you override settings.

---

## Troubleshooting

### Q: Extension feels slow on first run after update

**A:** This is expected! The extension is:
1. Cleaning up old build artifacts from cache
2. Capturing file modification times for all files
3. Re-indexing the workspace

**Second run onwards will be lightning-fast.**

---

### Q: I still see `.angular/` files in search results

**A:** Try these steps:
1. Reload VS Code window (`Ctrl+Shift+P` → "Reload Window")
2. Check logs: You should see "Purging N excluded files from cache"
3. If issue persists, clear cache manually:
   - Close VS Code
   - Delete `.smart-index/` folder in your workspace
   - Reopen VS Code

---

### Q: How do I verify mtime caching is working?

**A:** 
1. Open VS Code in your workspace
2. Wait for indexing to complete
3. Reload window (`Ctrl+Shift+P` → "Reload Window")
4. Check Output panel (Smart Indexer channel)
5. Look for: `All files up to date (mtime-based check)`

If you see this, mtime caching is working! 🎉

---

## Performance Expectations

### Small Project (< 1,000 files)
- **First run:** ~2-5 seconds
- **Subsequent runs:** ~100-500ms

### Medium Project (1,000-10,000 files)
- **First run:** ~10-30 seconds
- **Subsequent runs:** ~500ms-2s

### Large Project (> 10,000 files)
- **First run:** ~30-120 seconds
- **Subsequent runs:** ~2-5s

**Caveat:** Times assume unchanged files. Editing files will trigger re-indexing for those files only.

---

## Feedback

If you notice any issues or have suggestions, please file an issue on GitHub!

---

**Enjoy your faster, cleaner Smart Indexer!** 🚀
