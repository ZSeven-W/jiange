# CI

`github-actions-ci.yml` is the GitHub Actions workflow (web tests + build, vector freshness, Go vet/race tests with a Postgres service, 20s fuzz).
It lives here because the initial push token lacked the `workflow` scope. To enable it:

```bash
gh auth refresh -s workflow
mkdir -p .github/workflows && git mv ci/github-actions-ci.yml .github/workflows/ci.yml
git commit -m "ci: enable GitHub Actions" && git push
```
