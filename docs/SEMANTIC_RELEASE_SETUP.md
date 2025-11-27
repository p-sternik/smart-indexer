# Semantic Release Setup for Smart Indexer

This document provides instructions for setting up automated versioning and publishing using semantic-release.

## Overview

The CI/CD pipeline implements **Level 2 Automation (Semantic Release)** with:
- ✅ Automated versioning based on Conventional Commits
- ✅ Automatic CHANGELOG.md generation
- ✅ Publishing to VS Code Marketplace
- ✅ Git tagging and GitHub releases
- ✅ VSIX artifact attachment

## Installation

Install all required dependencies:

```bash
npm install --save-dev semantic-release@^24.0.0 \
  @semantic-release/commit-analyzer@^13.0.0 \
  @semantic-release/release-notes-generator@^14.0.0 \
  @semantic-release/changelog@^6.0.3 \
  @semantic-release/npm@^12.0.0 \
  @semantic-release/git@^10.0.1 \
  @semantic-release/github@^10.0.0 \
  semantic-release-vsce@^5.7.4 \
  conventional-changelog-conventionalcommits@^8.0.0
```

Or simply run:
```bash
npm install
```

## GitHub Secrets Configuration

You need to configure the following secrets in your GitHub repository settings:

### 1. VSCE_PAT (Required for Publishing)

This is your **Visual Studio Code Marketplace Personal Access Token**.

**Steps to create:**
1. Go to https://dev.azure.com/
2. Click on your profile icon (top right) → **Personal access tokens**
3. Click **+ New Token**
4. Configure:
   - **Name**: `vsce-publish-token` (or any descriptive name)
   - **Organization**: Select "All accessible organizations"
   - **Expiration**: Choose appropriate duration (90 days, 1 year, etc.)
   - **Scopes**: Select **Marketplace** → **Manage** (full access)
5. Click **Create**
6. **Copy the token immediately** (you won't see it again!)

**Add to GitHub:**
1. Go to your repository → **Settings** → **Secrets and variables** → **Actions**
2. Click **New repository secret**
3. Name: `VSCE_PAT`
4. Value: Paste your token
5. Click **Add secret**

### 2. GITHUB_TOKEN (Automatically provided)

This is automatically provided by GitHub Actions - no configuration needed.

## Conventional Commits Format

The versioning system uses Conventional Commits to determine version bumps:

### Version Bump Rules

| Commit Type | Version Bump | Example |
|------------|--------------|---------|
| `feat:` | **Minor** (0.x.0) | `feat: add new completion provider` |
| `fix:` | **Patch** (0.0.x) | `fix: resolve indexing crash` |
| `perf:` | **Patch** (0.0.x) | `perf: optimize cache lookup` |
| `BREAKING CHANGE:` | **Major** (x.0.0) | See below |
| `docs:`, `refactor:` | **Patch** (0.0.x) | `docs: update README` |
| `chore:`, `test:`, `ci:` | **No release** | `chore: update deps` |

### Breaking Changes (Major Version)

Add `BREAKING CHANGE:` in the commit body or footer:

```
feat: redesign API structure

BREAKING CHANGE: The indexer API has been completely redesigned.
Previous methods are no longer available.
```

Or use `!` after the type:
```
feat!: remove legacy indexer support
```

### Commit Examples

**Feature (Minor bump):**
```bash
git commit -m "feat: add support for Go language indexing"
```

**Bug Fix (Patch bump):**
```bash
git commit -m "fix: prevent memory leak in cache manager"
```

**Performance (Patch bump):**
```bash
git commit -m "perf: reduce index rebuild time by 40%"
```

**Breaking Change (Major bump):**
```bash
git commit -m "feat!: require Node.js 18+

BREAKING CHANGE: Node.js 16 is no longer supported.
Minimum required version is now 18.0.0."
```

**Documentation (Patch bump):**
```bash
git commit -m "docs: add architecture diagram"
```

**No Release:**
```bash
git commit -m "chore: update eslint config"
git commit -m "test: add unit tests for parser"
git commit -m "ci: update GitHub Actions workflow"
```

## Workflow Behavior

### Trigger
The workflow runs automatically on every push to the `main` branch.

### Steps
1. **Checkout code** (with full git history)
2. **Setup Node.js** (v20 with npm cache)
3. **Install dependencies** (`npm ci`)
4. **Build extension** (`npm run package`)
5. **Run tests** (continues even if tests fail)
6. **Semantic Release**:
   - Analyzes commits since last release
   - Determines next version number
   - Updates `package.json` version
   - Generates/updates `CHANGELOG.md`
   - Creates git tag
   - Publishes to VS Code Marketplace
   - Creates GitHub release with VSIX attachment
   - Commits updated files back to `main`

### Outputs
- 📦 Updated `package.json` with new version
- 📝 Updated `CHANGELOG.md` with release notes
- 🏷️ Git tag (e.g., `v1.2.3`)
- 🚀 Published extension on VS Code Marketplace
- 📎 GitHub release with VSIX file attached

## Publisher Configuration

Before your first release, update `package.json`:

```json
{
  "publisher": "your-publisher-id",
  "repository": {
    "type": "git",
    "url": "https://github.com/your-username/smart-indexer.git"
  }
}
```

Replace:
- `your-publisher-id` with your VS Code Marketplace publisher ID
- `your-username` with your GitHub username/organization

## Testing Locally

Test semantic-release locally (dry-run, won't publish):

```bash
npx semantic-release --dry-run
```

## Workflow Files Created

1. **`.github/workflows/release.yml`** - GitHub Actions workflow
2. **`.releaserc.json`** - Semantic release configuration
3. **`package.json`** - Updated with semantic-release dependencies

## Troubleshooting

### "No release published"
- Ensure commits follow Conventional Commits format
- Check if commits since last release include feat/fix/breaking changes
- Verify you're pushing to `main` branch

### "VSCE_PAT authentication failed"
- Verify token is valid and not expired
- Ensure token has **Marketplace → Manage** permissions
- Check token is correctly set in GitHub Secrets

### "Test failures"
- Tests are set to `continue-on-error: true`
- Release will proceed even if tests fail
- Fix tests to ensure quality releases

## Best Practices

1. **Always use Conventional Commits** for all commits to `main`
2. **Squash merge PRs** to keep clean commit history
3. **Write descriptive commit messages** (used in changelog)
4. **Test before merging** to `main` (release triggers automatically)
5. **Rotate VSCE_PAT** periodically for security

## Manual Release (If Needed)

If automatic release fails, you can manually trigger:

```bash
# Ensure you're on main with latest changes
git checkout main
git pull

# Run semantic release manually
VSCE_PAT=your-token npx semantic-release
```

## Version History

All releases are tracked in:
- `CHANGELOG.md` (auto-generated)
- GitHub Releases (with VSIX artifacts)
- Git tags (e.g., `v1.2.3`)

## Support

For issues with:
- **Semantic Release**: https://github.com/semantic-release/semantic-release
- **VSCE Plugin**: https://github.com/felipecrs/semantic-release-vsce
- **VS Code Publishing**: https://code.visualstudio.com/api/working-with-extensions/publishing-extension
