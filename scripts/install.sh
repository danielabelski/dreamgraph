#!/usr/bin/env bash
set -euo pipefail

# ===================================================================
# DreamGraph Global Installer (Linux / macOS)
#
# Builds the project, deploys compiled files to ~/.dreamgraph/bin/,
# installs production dependencies, creates wrapper scripts on PATH,
# and attempts a verified VS Code extension install when possible.
#
# Fail-safe behavior:
# - hard-fail on core DreamGraph install errors
# - degrade gracefully on optional VS Code extension install errors
# - never claim extension installation success without verification
# ===================================================================

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FORCE=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --source)  SOURCE_DIR="$2"; shift 2 ;;
        --force)   FORCE=true; shift ;;
        --help|-h)
            echo "Usage: install.sh [--source <dir>] [--force]"
            echo ""
            echo "Options:"
            echo "  --source <dir>   Path to DreamGraph source repo (default: parent of scripts/)"
            echo "  --force          Overwrite existing installation without prompting"
            exit 0
            ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

DG_HOME="${DREAMGRAPH_MASTER_DIR:-$HOME/.dreamgraph}"
BIN_DIR="$DG_HOME/bin"
DIST_TARGET="$BIN_DIR/dist"
TEMPLATE_TARGET="$DG_HOME/templates"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

step()  { echo -e "\n${CYAN}${BOLD}$*${NC}"; }
ok()    { echo -e "  ${GREEN}$* [ok]${NC}"; }
warn()  { echo -e "  ${YELLOW}[!] $*${NC}"; }
fail()  { echo -e "${RED}Error: $*${NC}" >&2; exit 1; }

remove_install_node_modules() {
    local path="$1"

    [[ -d "$path" ]] || return 0
    echo -e "  ${CYAN}Reusing existing node_modules; npm will update dependencies in place.${NC}"
}

run_logged() {
    local allow_failure="false"
    local quiet="false"

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --allow-failure) allow_failure="true"; shift ;;
            --quiet) quiet="true"; shift ;;
            --) shift; break ;;
            *) break ;;
        esac
    done

    local output
    local exit_code=0
    output=$("$@" 2>&1) || exit_code=$?

    if [[ "$quiet" != "true" ]] && [[ -n "$output" ]]; then
        while IFS= read -r line; do
            [[ -n "$line" ]] && printf '  %s\n' "$line"
        done <<< "$output"
    fi

    if [[ "$allow_failure" != "true" ]] && [[ $exit_code -ne 0 ]]; then
        fail "$* failed with exit code $exit_code"
    fi

    RUN_LOGGED_EXIT_CODE=$exit_code
    RUN_LOGGED_OUTPUT="$output"
    return 0
}

ensure_root_build_dependencies() {
    local needs_install=false

    if [[ ! -d "$SOURCE_DIR/node_modules" ]]; then
        needs_install=true
    elif [[ ! -d "$SOURCE_DIR/node_modules/typescript" ]]; then
        needs_install=true
    elif [[ ! -d "$SOURCE_DIR/node_modules/@types/node" ]]; then
        needs_install=true
    elif [[ ! -d "$SOURCE_DIR/node_modules/zod" ]]; then
        needs_install=true
    elif [[ ! -d "$SOURCE_DIR/node_modules/@modelcontextprotocol" ]]; then
        needs_install=true
    fi

    if [[ "$needs_install" == "true" ]]; then
        echo -e "  ${CYAN}Installing root dependencies (including dev dependencies for build)...${NC}"
        (
            cd "$SOURCE_DIR"
            run_logged -- npm install --include=dev --loglevel=warn
        )
        ok "Root dependencies installed"
    fi
}

resolve_vscode_cli() {
    if command -v code.cmd >/dev/null 2>&1; then
        command -v code.cmd
        return 0
    fi
    if command -v code >/dev/null 2>&1; then
        command -v code
        return 0
    fi
    if [[ -x "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" ]]; then
        echo "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
        return 0
    fi
    if [[ -x "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code" ]]; then
        echo "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code"
        return 0
    fi
    return 1
}

can_build_vscode_extension() {
    [[ -d "$SOURCE_DIR/extensions/vscode" ]]
}

ensure_extension_build_dependencies() {
    local ext_source="$SOURCE_DIR/extensions/vscode"
    if [[ ! -d "$ext_source/node_modules/typescript" ]] || [[ ! -d "$ext_source/node_modules/esbuild" ]] || [[ ! -d "$ext_source/node_modules/@vscode/vsce" ]]; then
        echo -e "  ${CYAN}Installing VS Code extension build dependencies...${NC}"
        (
            cd "$ext_source"
            run_logged -- npm install --loglevel=warn
        )
        ok "VS Code extension build dependencies installed"
    fi
}

remove_legacy_vscode_extension_artifacts() {
    local extension_id="$1"
    local legacy_version="$2"
    local roots=("$HOME/.vscode/extensions" "$HOME/.vscode-insiders/extensions")

    for extensions_root in "${roots[@]}"; do
        [[ -d "$extensions_root" ]] || continue
        shopt -s nullglob
        local matches=("$extensions_root/${extension_id}-${legacy_version}"*)
        shopt -u nullglob

        for dir in "${matches[@]}"; do
            if [[ -d "$dir" ]]; then
                rm -rf "$dir"
                ok "Removed legacy extension folder $(basename "$dir")"
            fi
        done
    done
}

test_vscode_extension_installed() {
    local code_cli="$1"
    local extension_id="$2"
    local version="$3"

    run_logged --allow-failure --quiet -- "$code_cli" --list-extensions --show-versions
    if [[ $RUN_LOGGED_EXIT_CODE -ne 0 ]]; then
        return 1
    fi

    grep -q "^${extension_id}@${version}$" <<< "$RUN_LOGGED_OUTPUT"
}

install_vscode_extension_safely() {
    local code_cli="$1"
    local vsix_path="$2"
    local extension_id="$3"
    local version="$4"

    run_logged --allow-failure --quiet -- "$code_cli" --uninstall-extension "$extension_id" --force || true
    run_logged --allow-failure -- "$code_cli" --install-extension "$vsix_path" --force
    if [[ $RUN_LOGGED_EXIT_CODE -ne 0 ]]; then
        return 1
    fi

    test_vscode_extension_installed "$code_cli" "$extension_id" "$version"
}

step "Checking prerequisites..."

NODE_VERSION=$(node --version 2>/dev/null || true)
[[ -z "$NODE_VERSION" ]] && fail "Node.js is required but not found. Install from https://nodejs.org/"
MAJOR=$(echo "$NODE_VERSION" | sed 's/^v\([0-9]*\)\..*/\1/')
# Node 20+ is required: undici@7, @vscode/vsce@3, cheerio@1.2 and other
# build/runtime dependencies of the extension and root package use the global
# `File` constructor and other Node 20 APIs. On Node 18 the extension build
# completes but `vsce package` crashes with `ReferenceError: File is not
# defined`, and several optional tools fail at import time.
[[ "$MAJOR" -lt 20 ]] && fail "Node.js >= 20 required (found $NODE_VERSION). Install Node 20 LTS or newer from https://nodejs.org/"
ok "Node.js $NODE_VERSION"

NPM_VERSION=$(npm --version 2>/dev/null || true)
[[ -z "$NPM_VERSION" ]] && fail "npm is required but not found."
ok "npm $NPM_VERSION"

# Detect WSL using a Windows npm (a common broken setup that fails deep inside
# native postinstall scripts with cryptic UNC-path errors). node is Linux but
# npm resolves to /mnt/c/... or a *.cmd/.exe shim -> abort early.
if grep -qiE '(microsoft|wsl)' /proc/version 2>/dev/null; then
    NPM_PATH=$(command -v npm 2>/dev/null || true)
    NODE_PATH=$(command -v node 2>/dev/null || true)
    if [[ "$NPM_PATH" == /mnt/* ]] || [[ "$NPM_PATH" == *.cmd ]] || [[ "$NPM_PATH" == *.exe ]]; then
        fail "Detected Windows npm ($NPM_PATH) inside WSL while node is Linux ($NODE_PATH).
  Windows npm cannot run install scripts from /home/... (UNC path under \\\\wsl.localhost).
  Install a Linux npm in WSL, e.g.:
    sudo apt install -y nodejs npm
  or use nvm: https://github.com/nvm-sh/nvm
  Then re-run this script."
    fi
fi

PACKAGE_JSON="$SOURCE_DIR/package.json"
[[ ! -f "$PACKAGE_JSON" ]] && fail "No package.json at $SOURCE_DIR. Is this the DreamGraph repo?"

PKG_NAME=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$PACKAGE_JSON','utf8')).name)")
[[ "$PKG_NAME" != "dreamgraph" ]] && fail "Not a DreamGraph repo (name: $PKG_NAME)"

VERSION=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$PACKAGE_JSON','utf8')).version)")
ok "DreamGraph v$VERSION source at $SOURCE_DIR"

if [[ -d "$DIST_TARGET" ]] && [[ "$FORCE" != "true" ]]; then
    EXISTING="unknown"
    if [[ -f "$BIN_DIR/version.json" ]]; then
        EXISTING=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$BIN_DIR/version.json','utf8')).version)")
    fi
    warn "Existing installation found (v$EXISTING)"
    read -rp "  Overwrite? [y/N] " confirm
    [[ "$confirm" != "y" && "$confirm" != "Y" ]] && { echo "Aborted."; exit 0; }
fi

step "Building DreamGraph..."
ensure_root_build_dependencies
(
    cd "$SOURCE_DIR"
    # Force a clean root TypeScript build. `tsc -b` is incremental and
    # relies on `tsconfig.tsbuildinfo` for up-to-date checks; a stale or
    # leaked tsbuildinfo (e.g. carried over from a prior install attempt
    # or a different machine) can short-circuit emit and leave dist/
    # populated only by the explorer's vite build. Clearing the buildinfo
    # files makes the next `tsc -b` always emit a full output tree.
    find . -maxdepth 4 -name 'tsconfig.tsbuildinfo' \
        -not -path './node_modules/*' \
        -not -path './extensions/vscode/*' \
        -delete 2>/dev/null || true
    run_logged -- npm run build
)
ok "Build complete"

SOURCE_DIST="$SOURCE_DIR/dist"
[[ ! -d "$SOURCE_DIST" ]] && fail "dist/ not found after build"
# Assert the CLI entry was emitted. Catching this here gives a clear
# error pinned to the build step instead of the verify step at the very
# end of the script (which previously printed a confusing MODULE_NOT_FOUND
# stack trace).
if [[ ! -f "$SOURCE_DIST/cli/dg.js" ]]; then
    warn "Build did not emit dist/cli/dg.js. Contents of $SOURCE_DIST:"
    ls -la "$SOURCE_DIST" 2>&1 | while IFS= read -r line; do printf '    %s\n' "$line"; done
    fail "Root TypeScript build (tsc -b) completed but did not produce dist/cli/dg.js. Try a manual clean build: 'cd $SOURCE_DIR && rm -rf dist && npx tsc -b --verbose'."
fi

step "Deploying to $BIN_DIR..."
mkdir -p "$BIN_DIR"
[[ -d "$DIST_TARGET" ]] && rm -rf "$DIST_TARGET"
cp -r "$SOURCE_DIST" "$DIST_TARGET"
ok "dist/ copied"

# Workspace packages (@dreamgraph/sdk, @dreamgraph/host) cannot be resolved
# from the registry; pack them into the bin vendor dir and rewrite the deps
# to file: references so `npm install --omit=dev` can complete offline.
VENDOR_DIR="$BIN_DIR/vendor"
[[ -d "$VENDOR_DIR" ]] && rm -rf "$VENDOR_DIR"
mkdir -p "$VENDOR_DIR"

WORKSPACE_PACKAGES=("@dreamgraph/sdk" "@dreamgraph/host")
declare -A WORKSPACE_TARBALLS=()
for ws_name in "${WORKSPACE_PACKAGES[@]}"; do
    echo -e "  ${CYAN}Packing $ws_name...${NC}"
    pushd "$SOURCE_DIR" >/dev/null
    run_logged --quiet -- npm pack --workspace "$ws_name" --pack-destination "$VENDOR_DIR" --loglevel=warn
    pack_exit_code="${RUN_LOGGED_EXIT_CODE:-0}"
    pack_output="${RUN_LOGGED_OUTPUT:-}"
    popd >/dev/null
    if [[ "$pack_exit_code" -ne 0 ]]; then
        fail "npm pack $ws_name failed (exit code $pack_exit_code)"
    fi
    # The tarball name is "<scope>-<name>-<version>.tgz" (scope dash-folded).
    tarball_name=""
    while IFS= read -r line; do
        [[ "$line" == *.tgz ]] || continue
        tarball_name="$(basename "${line//$'\r'/}")"
    done <<< "$pack_output"
    if [[ -z "$tarball_name" ]]; then
        # Fallback: scan vendor dir for the most recent matching tarball.
        expected_prefix="${ws_name//@/}"
        expected_prefix="${expected_prefix//\//-}"
        shopt -s nullglob
        candidates=("$VENDOR_DIR/${expected_prefix}"-*.tgz)
        shopt -u nullglob
        if [[ ${#candidates[@]} -gt 0 ]]; then
            # Pick the newest by mtime.
            newest=""
            newest_mtime=0
            for cand in "${candidates[@]}"; do
                mtime=$(stat -c %Y "$cand" 2>/dev/null || stat -f %m "$cand" 2>/dev/null || echo 0)
                if [[ "$mtime" -gt "$newest_mtime" ]]; then
                    newest_mtime="$mtime"
                    newest="$cand"
                fi
            done
            [[ -n "$newest" ]] && tarball_name="$(basename "$newest")"
        fi
    fi
    [[ -z "$tarball_name" ]] && fail "Could not determine tarball name for $ws_name"
    WORKSPACE_TARBALLS[$ws_name]="file:./vendor/$tarball_name"
    ok "Packed $ws_name -> vendor/$tarball_name"
done

# Build the bin package.json, swapping workspace deps for file: tarballs.
WS_OVERRIDES_JSON="{}"
for ws_name in "${WORKSPACE_PACKAGES[@]}"; do
    WS_OVERRIDES_JSON=$(node -e "
      const o = JSON.parse(process.argv[1]);
      o[process.argv[2]] = process.argv[3];
      process.stdout.write(JSON.stringify(o));
    " "$WS_OVERRIDES_JSON" "$ws_name" "${WORKSPACE_TARBALLS[$ws_name]}")
done

node -e "
  const pkg = JSON.parse(require('fs').readFileSync('$PACKAGE_JSON', 'utf8'));
  const overrides = JSON.parse(process.argv[1]);
  const deps = Object.assign({}, pkg.dependencies || {});
  for (const [name, spec] of Object.entries(overrides)) {
    deps[name] = spec;
  }
  for (const [name, spec] of Object.entries(pkg.devDependencies || {})) {
    if (name === '@modelcontextprotocol/sdk') {
      deps[name] = spec;
    }
  }
  const binPkg = {
    name: 'dreamgraph-global',
    version: pkg.version,
    type: 'module',
    dependencies: deps
  };
  require('fs').writeFileSync(
    '$BIN_DIR/package.json',
    JSON.stringify(binPkg, null, 2)
  );
" "$WS_OVERRIDES_JSON"
ok "package.json created"

echo -e "  ${CYAN}Installing dependencies...${NC}"
remove_install_node_modules "$BIN_DIR/node_modules"
# Also ensure no stale lockfile is reused -- file: deps must be resolved fresh.
[[ -f "$BIN_DIR/package-lock.json" ]] && rm -f "$BIN_DIR/package-lock.json"
(
    cd "$BIN_DIR"
    run_logged -- npm install --omit=dev --loglevel=warn
)
ok "Dependencies installed"

if [[ -d "$SOURCE_DIR/templates" ]]; then
    COPY_TEMPLATES=true
    if [[ -d "$TEMPLATE_TARGET" ]]; then
        if [[ "$FORCE" == "true" ]]; then
            rm -rf "$TEMPLATE_TARGET"
        else
            warn "Existing global templates found at $TEMPLATE_TARGET"
            read -rp "  Overwrite templates? [y/N] " template_confirm
            if [[ "$template_confirm" == "y" || "$template_confirm" == "Y" ]]; then
                rm -rf "$TEMPLATE_TARGET"
            else
                COPY_TEMPLATES=false
                echo "  Keeping existing templates"
            fi
        fi
    fi

    if [[ "$COPY_TEMPLATES" == "true" ]]; then
        cp -r "$SOURCE_DIR/templates" "$TEMPLATE_TARGET"
        ok "Templates copied"
    fi
fi

if can_build_vscode_extension; then
    step "Installing VS Code extension..."
    EXT_SOURCE="$SOURCE_DIR/extensions/vscode"
    EXT_PKG="$EXT_SOURCE/package.json"
    CODE_CLI="$(resolve_vscode_cli || true)"

    if [[ ! -f "$EXT_PKG" ]]; then
        warn "Extension source not found at $EXT_SOURCE -- skipping"
    elif [[ -z "$CODE_CLI" ]]; then
        warn "VS Code CLI not found (tried PATH and standard app locations) -- skipping extension install"
    else
        EXT_PUBLISHER=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$EXT_PKG','utf8')).publisher)")
        EXT_NAME=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$EXT_PKG','utf8')).name)")
        EXT_VER=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$EXT_PKG','utf8')).version)")
        EXTENSION_ID="${EXT_PUBLISHER}.${EXT_NAME}"
        LEGACY_EXTENSION_VERSION="7"
        VSIX_PATH="$EXT_SOURCE/${EXT_NAME}-${EXT_VER}.vsix"

        ensure_extension_build_dependencies
        (
            cd "$EXT_SOURCE"
            run_logged --allow-failure -- npm run build
        )
        if [[ $RUN_LOGGED_EXIT_CODE -ne 0 ]]; then
            warn "Extension build failed -- skipping VS Code extension install"
            EXTENSION_INSTALL_FAILED=true
        else
            ok "Extension built"
            rm -f "$VSIX_PATH"
            (
                cd "$EXT_SOURCE"
                run_logged --allow-failure -- npx --yes @vscode/vsce package --out "$VSIX_PATH"
            )
            if [[ $RUN_LOGGED_EXIT_CODE -ne 0 ]] || [[ ! -f "$VSIX_PATH" ]]; then
                warn "Extension packaging failed -- skipping VS Code extension install"
                EXTENSION_INSTALL_FAILED=true
            else
                ok "Packaged extension to $(basename "$VSIX_PATH")"
                remove_legacy_vscode_extension_artifacts "$EXTENSION_ID" "$LEGACY_EXTENSION_VERSION"

                if install_vscode_extension_safely "$CODE_CLI" "$VSIX_PATH" "$EXTENSION_ID" "$EXT_VER"; then
                    ok "Installed ${EXTENSION_ID}@${EXT_VER}"
                    warn "Reload VS Code to activate the extension"
                else
                    warn "VS Code extension installation could not be verified; VSIX was built at $VSIX_PATH"
                fi
            fi
        fi
    fi
else
    echo "  Extension source unavailable -- skipping extension build/install"
fi

node -e "
  const fs = require('fs');
  const [versionFile, version, source, nodeVersion] = process.argv.slice(1);
  fs.writeFileSync(versionFile, JSON.stringify({
    version,
    installed_at: new Date().toISOString(),
    source,
    node_version: nodeVersion
  }, null, 2));
" "$BIN_DIR/version.json" "$VERSION" "$SOURCE_DIR" "$NODE_VERSION"

step "Creating command shims..."
LINK_DIR=""
if mkdir -p "/usr/local/bin" 2>/dev/null && [[ -w "/usr/local/bin" ]]; then
    LINK_DIR="/usr/local/bin"
else
    while IFS=':' read -r path_entry; do
        [[ -z "$path_entry" ]] && continue
        [[ "$path_entry" == "$HOME/.local/bin" ]] && continue
        if [[ -d "$path_entry" ]] && [[ -w "$path_entry" ]]; then
            LINK_DIR="$path_entry"
            break
        fi
    done <<< "$PATH"
fi
if [[ -z "$LINK_DIR" ]]; then
    LINK_DIR="$HOME/.local/bin"
fi
mkdir -p "$LINK_DIR"

if [[ -n "${DREAMGRAPH_MASTER_DIR:-}" ]]; then
    SHIM_BIN_DIR="\${DREAMGRAPH_MASTER_DIR:-$DG_HOME}/bin"
else
    SHIM_BIN_DIR="$DG_HOME/bin"
fi

cat > "$LINK_DIR/dg" << EOF
#!/usr/bin/env bash
exec node "$SHIM_BIN_DIR/dist/cli/dg.js" "\$@"
EOF
chmod +x "$LINK_DIR/dg"

cat > "$LINK_DIR/dreamgraph" << EOF
#!/usr/bin/env bash
exec node "$SHIM_BIN_DIR/dist/index.js" "\$@"
EOF
chmod +x "$LINK_DIR/dreamgraph"

ok "Shims created in $LINK_DIR"

if [[ ! -x "$LINK_DIR/dg" ]] || [[ ! -x "$LINK_DIR/dreamgraph" ]]; then
    fail "Failed to create executable command shims in $LINK_DIR"
fi

if ! echo "$PATH" | tr ':' '\n' | grep -qx "$LINK_DIR"; then
    warn "$LINK_DIR is not in your PATH"

    SHELL_NAME=$(basename "${SHELL:-bash}")
    case "$SHELL_NAME" in
        zsh)  RC_FILE="$HOME/.zshrc" ;;
        fish) RC_FILE="$HOME/.config/fish/config.fish" ;;
        *)    RC_FILE="$HOME/.bashrc" ;;
    esac

    mkdir -p "$(dirname "$RC_FILE")"
    [[ -f "$RC_FILE" ]] || touch "$RC_FILE"

    PATH_LINE="export PATH=\"$LINK_DIR:\$PATH\""
    FISH_PATH_LINE="fish_add_path \"$LINK_DIR\""

    if [[ "$SHELL_NAME" == "fish" ]]; then
        if ! grep -Fqx "$FISH_PATH_LINE" "$RC_FILE" 2>/dev/null; then
            printf '\n# Added by DreamGraph installer\n%s\n' "$FISH_PATH_LINE" >> "$RC_FILE"
            ok "Added $LINK_DIR to PATH in $RC_FILE"
        else
            ok "$RC_FILE already adds $LINK_DIR to PATH"
        fi
    else
        if ! grep -Fqx "$PATH_LINE" "$RC_FILE" 2>/dev/null; then
            printf '\n# Added by DreamGraph installer\n%s\n' "$PATH_LINE" >> "$RC_FILE"
            ok "Added $LINK_DIR to PATH in $RC_FILE"
        else
            ok "$RC_FILE already adds $LINK_DIR to PATH"
        fi
    fi

    warn "Restart your shell or run: export PATH=\"$LINK_DIR:\$PATH\""
fi

step "Verifying installation..."
# Hard-check the entry script exists before invoking node. A missing
# `dist/cli/dg.js` means the root `tsc -b` step produced no TypeScript
# output (the deploy step copies whatever is in `dist/`, including
# explorer-only builds). Surfacing this here is cheaper than parsing
# node's MODULE_NOT_FOUND stack trace.
if [[ ! -f "$DIST_TARGET/cli/dg.js" ]]; then
    fail "Verification failed: $DIST_TARGET/cli/dg.js does not exist. The root TypeScript build did not produce the CLI entry. Re-run with --force after ensuring 'tsc -b' completes in $SOURCE_DIR."
fi
# Capture quietly on success, but if it fails, re-print the captured
# output before the hard-fail so the user actually sees the stack trace
# (the previous --quiet path swallowed errors and let the success banner
# run anyway when run_logged's fail path was bypassed).
run_logged --allow-failure --quiet -- node "$DIST_TARGET/cli/dg.js" --version
if [[ $RUN_LOGGED_EXIT_CODE -ne 0 ]]; then
    echo "$RUN_LOGGED_OUTPUT" | while IFS= read -r line; do printf '  %s\n' "$line"; done
    fail "Verification failed: 'node $DIST_TARGET/cli/dg.js --version' exited with $RUN_LOGGED_EXIT_CODE"
fi
ok "$RUN_LOGGED_OUTPUT"

echo ""
if [[ "${EXTENSION_INSTALL_FAILED:-false}" == "true" ]]; then
    echo -e "${YELLOW}${BOLD}==================================================${NC}"
    echo -e "${YELLOW}${BOLD} DreamGraph v$VERSION core installed${NC}"
    echo -e "${YELLOW}${BOLD} (VS Code extension install FAILED -- see warnings above)${NC}"
    echo -e "${YELLOW}${BOLD}==================================================${NC}"
else
    echo -e "${GREEN}${BOLD}==================================================${NC}"
    echo -e "${GREEN}${BOLD} DreamGraph v$VERSION installed successfully!${NC}"
    echo -e "${GREEN}${BOLD}==================================================${NC}"
fi
echo ""
echo " Binary:   $BIN_DIR"
echo " Run:      dg --help"
echo " Start:    dg start <instance> --http"
echo ""
echo -e "${YELLOW} Reminder: restart any running DreamGraph and VS Code instances to load the updated installation.${NC}"
echo ""
