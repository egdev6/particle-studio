#!/bin/sh
set -eu

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd -P)
repo_root=$(CDPATH= cd "$script_dir/.." && pwd -P)
tmp_root=${TMPDIR:-/tmp}

output_dir=$(mktemp -d "$tmp_root/particle-studio-playwright.XXXXXX") || {
  printf '%s\n' "Failed to create a temporary Playwright preview directory." >&2
  exit 1
}
output_dir=$(CDPATH= cd "$output_dir" && pwd -P) || {
  printf '%s\n' "Failed to resolve the temporary Playwright preview directory." >&2
  exit 1
}

case "$output_dir" in
"$repo_root" | "$repo_root"/*)
  printf '%s\n' "Temporary Playwright preview directory must be outside the repository: $output_dir" >&2
  exit 1
  ;;
esac

printf '%s\n' "$output_dir"

cd "$repo_root"
if ! npm run build -- --outDir "$output_dir"; then
  printf '%s\n' "Failed to build the Playwright preview output: $output_dir" >&2
  exit 1
fi

exec npx vite preview --host 127.0.0.1 --port 4173 --outDir "$output_dir"
