# Contributing

## Creating a Release

This repository uses GitHub Actions to automatically create releases when a new tag is pushed. The workflow will zip the folder and attach it to the release.

### Tag Format

Tags must follow this format: `v<major>.<minor>.<patch>`

| Tag | Valid? |
|-----|--------|
| `v0.0.1` | ✅ |
| `v1.2.3` | ✅ |
| `v2.0.0-beta` | ✅ |
| `0.0.1` | ❌ (missing `v` prefix) |
| `version1` | ❌ (wrong format) |

### Example

To create a new release:

```bash
git tag v0.0.1
git push origin v0.0.1
```

This will trigger the CI/CD pipeline and create a GitHub Release with `bigdata-financial-research-analyst_v0.0.1.skill` attached.
