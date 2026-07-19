#!/bin/sh
# OPAL prerelease installer — downloads the latest tagged PRERELEASE binary for macOS/Linux.
# Usage: curl -LsSf https://raw.githubusercontent.com/amorphous-engineering/OPAL/master/install-prerelease.sh | sh
#
# Same as install.sh, but installs the newest prerelease (e.g. a beta) instead
# of the latest stable release. Use install.sh for stable installs.
set -eu

REPO="amorphous-engineering/OPAL"
RELEASES_URL="https://github.com/${REPO}/releases"
API_RELEASES_URL="https://api.github.com/repos/${REPO}/releases?per_page=30"
INSTALL_DIR="${HOME}/.local/bin"
INSTALL_PATH="${INSTALL_DIR}/opal"

# --- Output helpers ---

if [ -t 1 ]; then
    BOLD="\033[1m"
    GREEN="\033[32m"
    YELLOW="\033[33m"
    RED="\033[31m"
    RESET="\033[0m"
else
    BOLD=""
    GREEN=""
    YELLOW=""
    RED=""
    RESET=""
fi

info() {
    printf "${GREEN}info${RESET}: %s\n" "$1"
}

warn() {
    printf "${YELLOW}warn${RESET}: %s\n" "$1" >&2
}

err() {
    printf "${RED}error${RESET}: %s\n" "$1" >&2
    exit 1
}

# --- Download abstraction ---

HAS_CURL=false
HAS_WGET=false

detect_downloader() {
    if command -v curl >/dev/null 2>&1; then
        HAS_CURL=true
    fi
    if command -v wget >/dev/null 2>&1; then
        HAS_WGET=true
    fi
    if [ "$HAS_CURL" = false ] && [ "$HAS_WGET" = false ]; then
        err "curl or wget is required but neither was found"
    fi
}

download() {
    # download URL OUTFILE
    if [ "$HAS_CURL" = true ]; then
        curl -fLsS -o "$2" "$1"
    else
        wget -q -O "$2" "$1"
    fi
}

download_text() {
    # download_text URL -> stdout
    if [ "$HAS_CURL" = true ]; then
        curl -fLsS "$1"
    else
        wget -q -O- "$1"
    fi
}

# --- Platform detection ---

detect_platform() {
    OS="$(uname -s)"
    ARCH="$(uname -m)"

    case "$OS" in
        Darwin)  PLATFORM="macos"  ;;
        Linux)   PLATFORM="linux"  ;;
        *)       err "Unsupported operating system: $OS" ;;
    esac

    case "$ARCH" in
        x86_64|amd64)   ARCH="x86_64" ;;
        arm64|aarch64)  ARCH="arm64"  ;;
        *)              err "Unsupported architecture: $ARCH" ;;
    esac

    ASSET_NAME="opal-${PLATFORM}-${ARCH}"
    info "Detected platform: ${PLATFORM} ${ARCH}"
}

# --- Release lookup ---
#
# Unlike install.sh, there is no /releases/latest redirect that points at a
# prerelease, so we must use the GitHub API (60 req/hr unauth limit per IP).
# The releases list is newest-first; take the tag of the first entry that is a
# prerelease and not a draft. Field order within each object is tag_name, then
# draft, then prerelease, so a single forward pass is enough.

resolve_latest_prerelease_tag() {
    TAG="$(download_text "$API_RELEASES_URL" 2>/dev/null | awk '
        /"tag_name":/ {
            t = $0
            sub(/.*"tag_name":[ ]*"/, "", t)
            sub(/".*/, "", t)
            tag = t
        }
        /"draft":/     { draft = ($0 ~ /true/) ? 1 : 0 }
        /"prerelease":/ {
            pre = ($0 ~ /true/) ? 1 : 0
            if (pre == 1 && draft == 0) { print tag; exit }
        }
    ')" || err "Failed to fetch releases from the GitHub API"

    if [ -z "$TAG" ]; then
        err "No prerelease found for ${REPO} (or the API rate limit was hit — try again later)"
    fi
}

find_download_url() {
    info "Resolving latest prerelease..."
    resolve_latest_prerelease_tag
    info "Latest prerelease: ${TAG}"
    DOWNLOAD_URL="${RELEASES_URL}/download/${TAG}/${ASSET_NAME}"
}

# --- Install ---

install_binary() {
    info "Downloading ${ASSET_NAME}..."

    mkdir -p "$INSTALL_DIR"

    TMP_FILE="$(mktemp)"
    trap 'rm -f "$TMP_FILE"' EXIT

    download "$DOWNLOAD_URL" "$TMP_FILE" || err "Download failed"

    # Sanity check: file should be at least 1 KB
    FILE_SIZE="$(wc -c < "$TMP_FILE" | tr -d ' ')"
    if [ "$FILE_SIZE" -lt 1024 ]; then
        err "Downloaded file is too small (${FILE_SIZE} bytes) — something went wrong"
    fi

    mv -f "$TMP_FILE" "$INSTALL_PATH"
    chmod +x "$INSTALL_PATH"

    info "Installed to ${INSTALL_PATH}"
}

# --- PATH check ---

check_path() {
    case ":${PATH}:" in
        *":${INSTALL_DIR}:"*) return ;;
    esac

    warn "${INSTALL_DIR} is not in your PATH"

    SHELL_NAME="$(basename "${SHELL:-/bin/sh}")"
    case "$SHELL_NAME" in
        fish)
            printf "\n  Run this to add it:\n\n    fish_add_path %s\n\n" "$INSTALL_DIR"
            ;;
        zsh)
            printf "\n  Add this to ~/.zshrc:\n\n    export PATH=\"%s:\$PATH\"\n\n" "$INSTALL_DIR"
            ;;
        *)
            printf "\n  Add this to ~/.bashrc (or ~/.profile):\n\n    export PATH=\"%s:\$PATH\"\n\n" "$INSTALL_DIR"
            ;;
    esac
}

# --- Main ---

main() {
    printf "\n${BOLD}OPAL Prerelease Installer${RESET}\n\n"

    detect_downloader
    detect_platform
    find_download_url
    install_binary
    check_path

    printf "\n${BOLD}OPAL %s installed successfully.${RESET}\n" "$TAG"
    printf "  Run ${GREEN}opal${RESET} to start.\n\n"
}

main
