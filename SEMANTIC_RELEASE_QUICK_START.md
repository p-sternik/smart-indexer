# Quick Setup Guide - Semantic Release

## 1. Install Dependencies

Run this single command:

```bash
npm install
```

This installs all required packages:
- `semantic-release@^24.0.0`
- `@semantic-release/commit-analyzer@^13.0.0`
- `@semantic-release/release-notes-generator@^14.0.0`
- `@semantic-release/changelog@^6.0.3`
- `@semantic-release/npm@^12.0.0`
- `@semantic-release/git@^10.0.1`
- `@semantic-release/github@^10.0.0`
- `semantic-release-vsce@^5.7.4`
- `conventional-changelog-conventionalcommits@^8.0.0`

## 2. Configure GitHub Secrets

### Create VSCE_PAT Token:

1. Visit: https://dev.azure.com/
2. Profile icon → **Personal access tokens**
3. **+ New Token**
4. Settings:
   - Name: `vsce-publish-token`
   - Organization: All accessible organizations
   - Scopes: **Marketplace** → **Manage**
5. **Copy the token!**

### Add to GitHub:

1. Repository → **Settings** → **Secrets and variables** → **Actions**
2. **New repository secret**
3. Name: `VSCE_PAT`
4. Value: (paste token)
5. **Add secret**

## 3. Update package.json Publisher

Edit `package.json`:

```json
{
  "publisher": "YOUR_PUBLISHER_ID",
  "repository": {
    "type": "git",
    "url": "https://github.com/YOUR_USERNAME/smart-indexer.git"
  }
}
```

## 4. Commit Format Examples

### Feature (minor bump: 0.1.0 → 0.2.0)
```bash
git commit -m "feat: add Go language support"
```

### Fix (patch bump: 0.1.0 → 0.1.1)
```bash
git commit -m "fix: resolve memory leak"
```

### Breaking Change (major bump: 0.1.0 → 1.0.0)
```bash
git commit -m "feat!: redesign API"
```

## 5. Test Locally (Dry Run)

```bash
npx semantic-release --dry-run
```

## 6. Trigger Release

```bash
git add .
git commit -m "feat: initial release"
git push origin main
```

## Done! 🎉

Every push to `main` with conventional commits will:
- ✅ Auto-calculate version
- ✅ Update CHANGELOG.md
- ✅ Publish to VS Code Marketplace
- ✅ Create GitHub release
- ✅ Attach VSIX file

## Commit Type Cheat Sheet

| Type | Version | Example |
|------|---------|---------|
| `feat:` | Minor | `feat: add feature` |
| `fix:` | Patch | `fix: bug fix` |
| `perf:` | Patch | `perf: optimize` |
| `docs:` | Patch | `docs: update` |
| `refactor:` | Patch | `refactor: cleanup` |
| `chore:` | None | `chore: deps` |
| `test:` | None | `test: add tests` |
| `ci:` | None | `ci: update workflow` |
| `feat!:` or `BREAKING CHANGE:` | Major | Breaking change |

## Files Created

- ✅ `.github/workflows/release.yml` - GitHub Actions workflow
- ✅ `.releaserc.json` - Semantic release config
- ✅ `package.json` - Updated with dependencies
- ✅ `docs/SEMANTIC_RELEASE_SETUP.md` - Full documentation
