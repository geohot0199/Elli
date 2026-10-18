# Upstream CI workflows

These are Rakazo's GitHub Actions workflows, copied verbatim from the upstream snapshot
(`b884f436`) so nothing from the source project is lost.

They live here instead of `.github/workflows/` because the automation token that pushed
this repository is a GitHub App without the `workflows` permission, and GitHub rejects any
push that adds workflow files with that token. To re-enable CI, move them back:

```bash
git mv docs/upstream-workflows/*.yml .github/workflows/
```

Nothing in the FalkorDB integration depends on these files.
