#!/usr/bin/env bash
# 重新產生 salary.html 用的 tailwind.salary.css（說明見 tools/tailwind.salary.config.js）
set -euo pipefail
cd "$(dirname "$0")/.."
npx --yes tailwindcss@3.4.19 \
  -c tools/tailwind.salary.config.js \
  -o tailwind.salary.css \
  --minify
