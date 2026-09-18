#!/usr/bin/env bash
# Запуск локального просмотрщика документации.
# При первом запуске докачивает библиотеки разметки в vendor/, дальше работает без сети.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENDOR="$HERE/vendor"
mkdir -p "$VENDOR"

fetch() { # имя_файла url
  local file="$VENDOR/$1" url="$2"
  [ -s "$file" ] && return 0
  echo "Скачиваю $1 …"
  curl -sSL --fail --max-time 120 -o "$file" "$url" || {
    echo "Не удалось скачать $1 — нужен интернет для первого запуска." >&2
    rm -f "$file"; exit 1
  }
}

fetch marked.min.js          https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js
fetch mermaid.min.js         https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js
fetch highlight.min.js       https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.9.0/highlight.min.js
fetch highlight-theme.css    https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.9.0/styles/github-dark-dimmed.min.css
fetch highlight-theme-light.css https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.9.0/styles/github.min.css

exec node "$HERE/server.mjs" "$@"
