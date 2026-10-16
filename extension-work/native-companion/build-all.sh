#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
OUTPUT_DIR="${1:-$ROOT_DIR/generated-artifacts/native-companion}"

targets=(
  "windows amd64"
  "windows arm64"
  "darwin amd64"
  "darwin arm64"
  "linux amd64"
  "linux arm64"
)

for target in "${targets[@]}"; do
  read -r os arch <<<"$target"
  release_dir="$OUTPUT_DIR/$os-$arch"
  mkdir -p "$release_dir"
  binary="$release_dir/rodon-device-host"
  if [[ "$os" == "windows" ]]; then
    binary="$binary.exe"
  fi
  echo "Building native device helper for $os/$arch..."
  (
    cd "$SCRIPT_DIR"
    GOOS="$os" GOARCH="$arch" CGO_ENABLED=0 \
      go build -trimpath -ldflags="-s -w" -o "$binary" .
  )
  cp "$SCRIPT_DIR/README.md" "$release_dir/README.md"
done

echo "Builds are in: $OUTPUT_DIR"
