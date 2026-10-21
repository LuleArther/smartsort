#!/usr/bin/env sh
# Publishes public/smartsort/ to the gh-pages branch, which GitHub Pages
# serves at https://lulearther.github.io/smartsort/
# Run from the repo root after committing:  sh tools/deploy-pages.sh
set -e
git push origin "$(git subtree split --prefix public/smartsort HEAD)":refs/heads/gh-pages --force
echo "Deployed. GitHub Pages updates in about a minute."
