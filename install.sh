#!/bin/sh
# OPAL installer — downloads a release binary for macOS/Linux.
# Usage: curl -LsSf https://raw.githubusercontent.com/amorphous-engineering/OPAL/master/install.sh | sh
#
# Options (after `sh -s --` when piped):
#   --prerelease       install the newest release, prereleases included
#   --version <tag>    install one release, for example v2.0.0-rc.21
# The same as environment variables: OPAL_PRERELEASE=1, OPAL_VERSION=<tag>.
# With no option the installer takes the release GitHub marks as Latest.
set -eu

REPO="amorphous-engineering/OPAL"
RELEASES_URL="https://github.com/${REPO}/releases"
INSTALL_DIR="${HOME}/.local/bin"
INSTALL_PATH="${INSTALL_DIR}/opal"

WANT_VERSION="${OPAL_VERSION:-}"
WANT_PRERELEASE="${OPAL_PRERELEASE:-}"

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
# Avoids api.github.com (60 req/hr unauth limit per IP). Resolves the latest
# tag by following the redirect on /releases/latest, then downloads the
# asset directly from /releases/download/<tag>/<asset>.

resolve_latest_tag() {
    # Follow the redirect on /releases/latest and read the resolved path.
    # Works on any public repo without an API call.
    if [ "$HAS_CURL" = true ]; then
        RESOLVED="$(curl -sSLI -o /dev/null -w '%{url_effective}' "${RELEASES_URL}/latest")" \
            || err "Failed to resolve latest release URL"
    else
        # wget prints the final URL to stderr with -S; capture and parse.
        RESOLVED="$(wget -q -S --spider --max-redirect=5 -O - "${RELEASES_URL}/latest" 2>&1 \
            | awk '/^Location: /{loc=$2} END{print loc}')"
    fi

    case "$RESOLVED" in
        */releases/tag/*) TAG="${RESOLVED##*/releases/tag/}" ;;
        *) TAG="" ;;
    esac

    if [ -z "$TAG" ]; then
        err "Could not determine latest release tag from ${RELEASES_URL}/latest"
    fi
}

resolve_newest_tag() {
    # The releases Atom feed lists prereleases too, newest first, and has no
    # API rate limit. Drafts never appear in it.
    FEED="$(download_text "https://github.com/${REPO}/releases.atom")" \
        || err "Failed to read ${RELEASES_URL}.atom"
    TAG="$(printf '%s\n' "$FEED" \
        | sed -n 's|.*/releases/tag/\([^"]*\)".*|\1|p' | head -n 1)"
    [ -n "$TAG" ] || err "Could not find a release in ${RELEASES_URL}.atom"
}

find_download_url() {
    if [ -n "$WANT_VERSION" ]; then
        case "$WANT_VERSION" in
            v*) TAG="$WANT_VERSION" ;;
            *)  TAG="v${WANT_VERSION}" ;;
        esac
        info "Requested release: ${TAG}"
    elif [ -n "$WANT_PRERELEASE" ] && [ "$WANT_PRERELEASE" != "0" ]; then
        info "Resolving newest release, prereleases included..."
        resolve_newest_tag
        info "Newest release: ${TAG}"
    else
        info "Resolving latest release..."
        resolve_latest_tag
        info "Latest release: ${TAG}"
    fi
    DOWNLOAD_URL="${RELEASES_URL}/download/${TAG}/${ASSET_NAME}"
    SUMS_URL="${RELEASES_URL}/download/${TAG}/SHA256SUMS"
}

# --- Checksum ---

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | cut -d ' ' -f 1
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | cut -d ' ' -f 1
    else
        err "sha256sum or shasum is required to verify the download"
    fi
}

verify_checksum() {
    # verify_checksum FILE: compare with the SHA256SUMS line for ASSET_NAME.
    info "Verifying SHA-256..."
    SUMS="$(download_text "$SUMS_URL")" || err "Could not download SHA256SUMS"
    EXPECTED="$(printf '%s\n' "$SUMS" | awk -v n="$ASSET_NAME" '$2 == n { print $1 }')"
    [ -n "$EXPECTED" ] || err "SHA256SUMS has no entry for ${ASSET_NAME}"
    ACTUAL="$(sha256_of "$1")"
    if [ "$EXPECTED" != "$ACTUAL" ]; then
        err "Checksum mismatch for ${ASSET_NAME}: expected ${EXPECTED}, got ${ACTUAL}"
    fi
}

# --- Install ---

install_binary() {
    info "Downloading ${ASSET_NAME}..."

    mkdir -p "$INSTALL_DIR"

    TMP_FILE="$(mktemp)"
    trap 'rm -f "$TMP_FILE"' EXIT

    download "$DOWNLOAD_URL" "$TMP_FILE" \
        || err "Download failed: release ${TAG} has no asset ${ASSET_NAME}, or the tag does not exist"

    # Sanity check: file should be at least 1 KB
    FILE_SIZE="$(wc -c < "$TMP_FILE" | tr -d ' ')"
    if [ "$FILE_SIZE" -lt 1024 ]; then
        err "Downloaded file is too small (${FILE_SIZE} bytes) — something went wrong"
    fi

    verify_checksum "$TMP_FILE"

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

# --- Arguments ---

usage() {
    printf "Usage: install.sh [--prerelease] [--version <tag>]\n"
}

parse_args() {
    while [ $# -gt 0 ]; do
        case "$1" in
            --prerelease) WANT_PRERELEASE=1 ;;
            --version)
                [ $# -ge 2 ] || err "--version needs a tag, for example v2.0.0-rc.21"
                WANT_VERSION="$2"
                shift
                ;;
            --version=*) WANT_VERSION="${1#--version=}" ;;
            -h|--help) usage; exit 0 ;;
            *) usage >&2; err "Unknown option: $1" ;;
        esac
        shift
    done
}

# --- Main ---

main() {
    parse_args "$@"
    printf "\n${BOLD}OPAL Installer${RESET}\n\n"

    detect_downloader
    detect_platform
    find_download_url
    install_binary
    check_path

    printf "\n${BOLD}OPAL %s installed successfully.${RESET}\n" "$TAG"
    printf "  Run ${GREEN}opal${RESET} to start.\n\n"
}

main "$@"
