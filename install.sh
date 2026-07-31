#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-cloudpanel-bun-helper}"
INSTALL_DIR="${INSTALL_DIR:-/opt/cloudpanel-bun-helper}"
GITHUB_REPO="${GITHUB_REPO:-RaulML20/cloudpanel-bun-helper}"
REPO_BRANCH="${REPO_BRANCH:-main}"
ARCHIVE_URL="${ARCHIVE_URL:-https://github.com/$GITHUB_REPO/archive/refs/heads/$REPO_BRANCH.tar.gz}"

BUN_HELPER_PORT="${BUN_HELPER_PORT:-7880}"
BUN_HELPER_HOST="${BUN_HELPER_HOST:-0.0.0.0}"
BUN_HELPER_PUBLIC_HOST="${BUN_HELPER_PUBLIC_HOST:-}"
BUN_HELPER_SSL_DIR="${BUN_HELPER_SSL_DIR:-$INSTALL_DIR/ssl}"
BUN_HELPER_ALLOWED_ORIGIN="${BUN_HELPER_ALLOWED_ORIGIN:-}"
BUN_HELPER_ALLOWED_CLIENT_IPS="${BUN_HELPER_ALLOWED_CLIENT_IPS:-}"
BUN_HELPER_CERT_CN="${BUN_HELPER_CERT_CN:-}"
BUN_HELPER_CERT_SAN="${BUN_HELPER_CERT_SAN:-}"
BUN_ROOT="${BUN_ROOT:-/opt/bun}"

# Kept outside INSTALL_DIR on purpose: which domains are Bun sites must survive
# uninstalling, reinstalling or wiping the install directory.
BUN_HELPER_DATA_DIR="${BUN_HELPER_DATA_DIR:-/var/lib/cloudpanel-bun-helper}"

CLOUDPANEL_ROOT="${CLOUDPANEL_ROOT:-/home/clp/htdocs/app/files}"
CLOUDPANEL_TEMPLATES_DIR="${CLOUDPANEL_TEMPLATES_DIR:-$CLOUDPANEL_ROOT/templates}"
CLOUDPANEL_CACHE_DIR="${CLOUDPANEL_CACHE_DIR:-$CLOUDPANEL_ROOT/var/cache}"
CLOUDPANEL_FILE_OWNER="${CLOUDPANEL_FILE_OWNER:-clp:clp}"
CLOUDPANEL_FILE_MODE="${CLOUDPANEL_FILE_MODE:-770}"
BACKUP_SUFFIX=".cloudpanel-bun-helper.bak"
BLOCK_MARKER="BEGIN cloudpanel-bun-helper"

# Optional explicit template paths; when empty they are located by signature.
CLOUDPANEL_TPL_NEW_SITE="${CLOUDPANEL_TPL_NEW_SITE:-}"
CLOUDPANEL_TPL_REVERSE_PROXY="${CLOUDPANEL_TPL_REVERSE_PROXY:-}"
CLOUDPANEL_TPL_SETTINGS="${CLOUDPANEL_TPL_SETTINGS:-}"
CLOUDPANEL_TPL_SERVICES="${CLOUDPANEL_TPL_SERVICES:-}"
CLOUDPANEL_TPL_SITES_LIST="${CLOUDPANEL_TPL_SITES_LIST:-}"

if [ "$(id -u)" -ne 0 ]; then
    echo "Please run this installer as root." >&2
    exit 1
fi

if ! echo "$BUN_HELPER_PORT" | grep -Eq '^[0-9]+$'; then
    echo "BUN_HELPER_PORT must be a number." >&2
    exit 1
fi

if [ -z "$BUN_HELPER_ALLOWED_CLIENT_IPS" ]; then
    echo "BUN_HELPER_ALLOWED_CLIENT_IPS is required." >&2
    echo "Use the public IP address that will access CloudPanel, for example:" >&2
    echo "BUN_HELPER_ALLOWED_CLIENT_IPS=\"YOUR_PUBLIC_IP\" bash install.sh" >&2
    exit 1
fi

log() {
    printf '\n[%s] %s\n' "$APP_NAME" "$*"
}

require_command() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "Missing required command: $1" >&2
        exit 1
    fi
}

check_cloudpanel() {
    if ! command -v systemctl >/dev/null 2>&1; then
        echo "systemctl is required to verify CloudPanel services." >&2
        exit 1
    fi

    for unit in clp-php-fpm.service clp-nginx.service; do
        if [ "$(systemctl show -p LoadState --value "$unit" 2>/dev/null)" != "loaded" ]; then
            echo "CloudPanel service not found: $unit" >&2
            echo "Install CloudPanel before running this installer." >&2
            exit 1
        fi
    done

    if [ ! -d "$CLOUDPANEL_ROOT" ]; then
        echo "CloudPanel files directory not found: $CLOUDPANEL_ROOT" >&2
        echo "Install CloudPanel before running this installer." >&2
        exit 1
    fi
}

# The helper itself runs under PM2 and Bun applications are managed with PM2,
# so Node.js and PM2 must already be on the server. We deliberately do not
# install them here: fail early and tell the user what is missing.
check_node_pm2() {
    if ! command -v node >/dev/null 2>&1; then
        echo "Node.js was not found on this server." >&2
        echo "Install Node.js first (for example with nvm, or by installing" >&2
        echo "https://github.com/RaulML20/cloudpanel-terminal-helper which sets it up) and re-run this installer." >&2
        exit 1
    fi

    if ! command -v pm2 >/dev/null 2>&1; then
        echo "PM2 was not found on this server." >&2
        echo "Install PM2 first (npm install -g pm2) and re-run this installer." >&2
        exit 1
    fi
}

detect_public_host() {
    if [ -n "$BUN_HELPER_PUBLIC_HOST" ]; then
        echo "$BUN_HELPER_PUBLIC_HOST"
        return
    fi

    curl -fsS https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}'
}

make_subject_alt_name() {
    local host="$1"

    if echo "$host" | grep -Eq '^[0-9]+(\.[0-9]+){3}$'; then
        echo "IP:$host"
    else
        echo "DNS:$host"
    fi
}

# Older versions kept sites.json inside the install directory, where a
# reinstall or an uninstall would take it down with them.
migrate_data_dir() {
    mkdir -p "$BUN_HELPER_DATA_DIR"
    chmod 0700 "$BUN_HELPER_DATA_DIR"

    if [ -f "$INSTALL_DIR/data/sites.json" ] && [ ! -f "$BUN_HELPER_DATA_DIR/sites.json" ]; then
        log "Migrating existing site data to $BUN_HELPER_DATA_DIR"
        cp -a "$INSTALL_DIR/data/." "$BUN_HELPER_DATA_DIR/"
    fi
}

fetch_app() {
    log "Installing application in $INSTALL_DIR"

    local tmp_dir archive extracted_dir backup_dir
    tmp_dir="$(mktemp -d)"
    archive="$tmp_dir/app.tar.gz"

    curl -fsSL "$ARCHIVE_URL" -o "$archive"
    tar -xzf "$archive" -C "$tmp_dir"
    extracted_dir="$(find "$tmp_dir" -mindepth 1 -maxdepth 1 -type d | head -n 1)"

    if [ -z "$extracted_dir" ]; then
        echo "Unable to extract application archive." >&2
        exit 1
    fi

    if [ -d "$INSTALL_DIR" ] && [ "$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 | head -n 1)" ]; then
        backup_dir="${INSTALL_DIR}.bak.$(date +%Y%m%d%H%M%S)"
        mv "$INSTALL_DIR" "$backup_dir"
        log "Existing install directory moved to $backup_dir"

        # Keep the previous certificate so the helper port stays trusted in
        # browsers that already accepted it.
        if [ -d "$backup_dir/ssl" ]; then
            mkdir -p "$INSTALL_DIR"
            cp -a "$backup_dir/ssl" "$INSTALL_DIR/ssl"
        fi
    fi

    mkdir -p "$INSTALL_DIR"
    cp -a "$extracted_dir"/. "$INSTALL_DIR"
    rm -rf "$tmp_dir"
}

install_node_dependencies() {
    log "Installing npm dependencies"
    cd "$INSTALL_DIR"
    npm install --omit=dev
}

write_env_file() {
    local detected_host
    detected_host="$(detect_public_host)"

    if [ -z "$detected_host" ]; then
        echo "Unable to detect the VPS public IP or hostname." >&2
        echo "Set BUN_HELPER_PUBLIC_HOST manually, for example:" >&2
        echo "BUN_HELPER_PUBLIC_HOST=\"YOUR_VPS_IP_OR_DOMAIN\" BUN_HELPER_ALLOWED_CLIENT_IPS=\"YOUR_PUBLIC_IP\" bash install.sh" >&2
        exit 1
    fi

    if [ -z "$BUN_HELPER_ALLOWED_ORIGIN" ]; then
        BUN_HELPER_ALLOWED_ORIGIN="https://${detected_host}:8443"
    fi

    if [ -z "$BUN_HELPER_CERT_CN" ]; then
        BUN_HELPER_CERT_CN="$detected_host"
    fi

    if [ -z "$BUN_HELPER_CERT_SAN" ]; then
        BUN_HELPER_CERT_SAN="$(make_subject_alt_name "$detected_host")"
    fi

    log "Writing runtime configuration"
    cat > "$INSTALL_DIR/.env" <<EOF
BUN_HELPER_PORT=$BUN_HELPER_PORT
BUN_HELPER_HOST=$BUN_HELPER_HOST
BUN_HELPER_SSL_DIR=$BUN_HELPER_SSL_DIR
BUN_HELPER_ALLOWED_ORIGIN=$BUN_HELPER_ALLOWED_ORIGIN
BUN_HELPER_ALLOWED_CLIENT_IPS=$BUN_HELPER_ALLOWED_CLIENT_IPS
BUN_HELPER_DATA_DIR=$BUN_HELPER_DATA_DIR
BUN_ROOT=$BUN_ROOT
EOF
    chmod 0600 "$INSTALL_DIR/.env"
}

create_certificate() {
    log "Creating self-signed certificate"
    mkdir -p "$BUN_HELPER_SSL_DIR"

    if [ ! -f "$BUN_HELPER_SSL_DIR/bun-helper.key" ] || [ ! -f "$BUN_HELPER_SSL_DIR/bun-helper.crt" ]; then
        openssl req -x509 -newkey rsa:2048 -nodes \
            -keyout "$BUN_HELPER_SSL_DIR/bun-helper.key" \
            -out "$BUN_HELPER_SSL_DIR/bun-helper.crt" \
            -days 1825 \
            -subj "/CN=$BUN_HELPER_CERT_CN" \
            -addext "subjectAltName=$BUN_HELPER_CERT_SAN"
    fi
}

# Finds the one CloudPanel template with the given file name that contains the
# given signature string. Aborts when zero or several files match, so we never
# patch the wrong template.
locate_template() {
    local name="$1" signature="$2" override="$3"

    if [ -n "$override" ]; then
        if [ ! -f "$override" ]; then
            echo "Template override not found: $override" >&2
            exit 1
        fi
        echo "$override"
        return
    fi

    local matches count
    matches="$(grep -rl --include="$name" -F "$signature" "$CLOUDPANEL_TEMPLATES_DIR" 2>/dev/null || true)"
    count="$(printf '%s' "$matches" | grep -c . || true)"

    if [ "$count" -eq 0 ]; then
        echo "Could not locate CloudPanel template '$name' (signature: $signature)." >&2
        echo "Set its path explicitly with the matching CLOUDPANEL_TPL_* variable and re-run, for example:" >&2
        echo "CLOUDPANEL_TPL_SETTINGS=$CLOUDPANEL_TEMPLATES_DIR/Frontend/Site/settings.html.twig ... bash install.sh" >&2
        exit 1
    fi

    if [ "$count" -gt 1 ]; then
        echo "Several CloudPanel templates match '$name':" >&2
        echo "$matches" >&2
        echo "Set the intended path explicitly with the matching CLOUDPANEL_TPL_* variable and re-run." >&2
        exit 1
    fi

    echo "$matches"
}

# Adds our marked block to a template, keeping everything already in it. The
# block is self-contained JavaScript, so nothing CloudPanel or another
# extension renders is replaced or moved.
inject_block() {
    local target="$1" block="$2"
    local backup="${target}${BACKUP_SUFFIX}"

    # A copy of the template as it was before we ever touched it, refreshed
    # whenever the file has no block of ours (a fresh install, or after a
    # CloudPanel update replaced it). It is insurance only: uninstalling
    # removes our block from the live file instead of restoring this.
    if ! grep -q "$BLOCK_MARKER" "$target"; then
        cp "$target" "$backup"
        chown "$CLOUDPANEL_FILE_OWNER" "$backup"
        chmod "$CLOUDPANEL_FILE_MODE" "$backup"
    fi

    node "$INSTALL_DIR/tools/patch-template.js" "$target" "$block" "$BUN_HELPER_PORT"

    chown "$CLOUDPANEL_FILE_OWNER" "$target"
    chmod "$CLOUDPANEL_FILE_MODE" "$target"
    log "Patched: $target"
}

install_templates() {
    log "Patching CloudPanel Twig templates"

    local tpl_new_site tpl_reverse_proxy tpl_settings tpl_services tpl_sites_list
    tpl_new_site="$(locate_template 'index.html.twig' 'What kind of site would you like to create?' "$CLOUDPANEL_TPL_NEW_SITE")"
    tpl_reverse_proxy="$(locate_template 'reverse-proxy.html.twig' 'New Reverse Proxy' "$CLOUDPANEL_TPL_REVERSE_PROXY")"
    tpl_settings="$(locate_template 'settings.html.twig' 'siteUserSettingsForm' "$CLOUDPANEL_TPL_SETTINGS")"
    tpl_services="$(locate_template 'services.html.twig' 'clp_admin_service_restart' "$CLOUDPANEL_TPL_SERVICES")"
    tpl_sites_list="$(locate_template 'index.html.twig' 'table-sites' "$CLOUDPANEL_TPL_SITES_LIST")"

    inject_block "$tpl_new_site" "$INSTALL_DIR/blocks/new-site.html"
    inject_block "$tpl_reverse_proxy" "$INSTALL_DIR/blocks/reverse-proxy.html"
    inject_block "$tpl_settings" "$INSTALL_DIR/blocks/site-settings.html"
    inject_block "$tpl_services" "$INSTALL_DIR/blocks/instance-services.html"
    inject_block "$tpl_sites_list" "$INSTALL_DIR/blocks/sites-list.html"
}

install_bun_icon() {
    local reference target_dir

    # The exact path the stock index.html.twig references
    # (asset('/assets/images/new-site/reverse_proxy.svg')). Tried first because
    # it is exact; `find` below is only a fallback for CloudPanel layouts that
    # differ from this.
    reference="$CLOUDPANEL_ROOT/public/assets/images/new-site/reverse_proxy.svg"

    if [ ! -f "$reference" ]; then
        reference="$(find "$CLOUDPANEL_ROOT/public" -name 'reverse_proxy.svg' -path '*new-site*' 2>/dev/null | head -n 1)"
    fi

    if [ -z "$reference" ] || [ ! -f "$reference" ]; then
        log "Skipping Bun icon: could not locate the new-site images directory (the card falls back to the Reverse Proxy icon)"
        log "You can install it manually: find where reverse_proxy.svg lives under $CLOUDPANEL_ROOT/public and copy $INSTALL_DIR/assets/bun.svg next to it as bun.svg"
        return
    fi

    target_dir="$(dirname "$reference")"
    install -m 0644 "$INSTALL_DIR/assets/bun.svg" "$target_dir/bun.svg"
    chown "$CLOUDPANEL_FILE_OWNER" "$target_dir/bun.svg"
    chmod "$CLOUDPANEL_FILE_MODE" "$target_dir/bun.svg"
    log "Bun icon installed: $target_dir/bun.svg"
}

configure_firewall() {
    if ! command -v ufw >/dev/null 2>&1; then
        log "Skipping UFW allow rule because ufw is not installed"
        return
    fi

    log "Configuring UFW"
    IFS=',' read -ra ips <<< "$BUN_HELPER_ALLOWED_CLIENT_IPS"
    for ip in "${ips[@]}"; do
        ip="${ip#"${ip%%[![:space:]]*}"}"
        ip="${ip%"${ip##*[![:space:]]}"}"
        [ -z "$ip" ] && continue
        ufw allow from "$ip" to any port "$BUN_HELPER_PORT" proto tcp comment 'Bun Helper' || true
    done
    ufw reload || true
}

start_pm2() {
    log "Starting PM2 service"
    mkdir -p "$BUN_ROOT"
    chmod 0755 "$BUN_ROOT"

    cd "$INSTALL_DIR"
    set -a
    # shellcheck disable=SC1091
    . "$INSTALL_DIR/.env"
    set +a

    pm2 delete "$APP_NAME" >/dev/null 2>&1 || true
    pm2 start npm --name "$APP_NAME" -- start
    pm2 save
}

configure_pm2_cron() {
    log "Configuring PM2 resurrection on reboot"

    if ! command -v crontab >/dev/null 2>&1; then
        log "Skipping PM2 cron configuration because crontab is not installed"
        return
    fi

    local pm2_path node_path cron_file
    pm2_path="$(command -v pm2)"
    node_path="$(dirname "$(command -v node)")"
    cron_file="$(mktemp)"

    crontab -l 2>/dev/null | awk '
        /# cloudpanel-bun-helper pm2 start/ { skip=1; next }
        /# cloudpanel-bun-helper pm2 end/ { skip=0; next }
        skip != 1 { print }
    ' > "$cron_file" || true

    if ! grep -q 'pm2 resurrect' "$cron_file"; then
        {
            echo "# cloudpanel-bun-helper pm2 start"
            echo "PATH=$node_path:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
            echo "@reboot $pm2_path resurrect &> /dev/null"
            echo "# cloudpanel-bun-helper pm2 end"
        } >> "$cron_file"
    fi

    crontab "$cron_file"
    rm -f "$cron_file"
}

restart_cloudpanel() {
    log "Clearing CloudPanel cache and restarting services"
    if [ -d "$CLOUDPANEL_CACHE_DIR" ]; then
        find "$CLOUDPANEL_CACHE_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
    fi

    systemctl restart clp-php-fpm
    systemctl restart clp-nginx
}

require_command curl
require_command tar
require_command openssl
require_command unzip
check_cloudpanel
check_node_pm2

migrate_data_dir
fetch_app
install_node_dependencies
write_env_file
create_certificate
install_templates
install_bun_icon
configure_firewall
start_pm2
configure_pm2_cron
restart_cloudpanel

log "Installation completed"
echo "Bun helper API: https://$(detect_public_host):$BUN_HELPER_PORT"
echo "Allowed origin: $BUN_HELPER_ALLOWED_ORIGIN"
echo "Allowed client IPs: $BUN_HELPER_ALLOWED_CLIENT_IPS"
echo "Bun runtimes directory: $BUN_ROOT"
echo "Site data directory: $BUN_HELPER_DATA_DIR"
echo ""
echo "Open your browser and accept the self-signed certificate once:"
echo "https://$(detect_public_host):$BUN_HELPER_PORT"