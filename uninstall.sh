#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   bash uninstall.sh           removes the helper and its template blocks
#   bash uninstall.sh --purge   also removes /opt/bun, the site data and every
#                               bun-site-* PM2 process

APP_NAME="${APP_NAME:-cloudpanel-bun-helper}"
INSTALL_DIR="${INSTALL_DIR:-/opt/cloudpanel-bun-helper}"
BUN_ROOT="${BUN_ROOT:-/opt/bun}"
BUN_HELPER_DATA_DIR="${BUN_HELPER_DATA_DIR:-/var/lib/cloudpanel-bun-helper}"

CLOUDPANEL_ROOT="${CLOUDPANEL_ROOT:-/home/clp/htdocs/app/files}"
CLOUDPANEL_TEMPLATES_DIR="${CLOUDPANEL_TEMPLATES_DIR:-$CLOUDPANEL_ROOT/templates}"
CLOUDPANEL_CACHE_DIR="${CLOUDPANEL_CACHE_DIR:-$CLOUDPANEL_ROOT/var/cache}"
CLOUDPANEL_FILE_OWNER="${CLOUDPANEL_FILE_OWNER:-clp:clp}"
CLOUDPANEL_FILE_MODE="${CLOUDPANEL_FILE_MODE:-770}"
BACKUP_SUFFIX=".cloudpanel-bun-helper.bak"
BLOCK_MARKER="BEGIN cloudpanel-bun-helper"

PURGE=0
if [ "${1:-}" = "--purge" ]; then
    PURGE=1
fi

if [ "$(id -u)" -ne 0 ]; then
    echo "Please run this uninstaller as root." >&2
    exit 1
fi

log() {
    printf '\n[%s] %s\n' "$APP_NAME" "$*"
}

# Removes only our marked block, leaving whatever else the template contains
# (CloudPanel's own markup, and any other extension's changes) untouched.
strip_blocks() {
    log "Removing template blocks"

    if ! command -v node >/dev/null 2>&1; then
        echo "Node.js was not found; cannot clean the templates automatically." >&2
        echo "Remove the block delimited by '{# BEGIN cloudpanel-bun-helper #}' and" >&2
        echo "'{# END cloudpanel-bun-helper #}' by hand in:" >&2
        grep -rl "$BLOCK_MARKER" "$CLOUDPANEL_TEMPLATES_DIR" 2>/dev/null >&2 || true
        return
    fi

    local target
    while IFS= read -r target; do
        [ -z "$target" ] && continue

        node - "$target" <<'JS'
const fs = require('fs');

const BEGIN = '{# BEGIN cloudpanel-bun-helper #}';
const END = '{# END cloudpanel-bun-helper #}';

const target = process.argv[2];
let text = fs.readFileSync(target, 'utf8');

const beginIndex = text.indexOf(BEGIN);
const endIndex = text.indexOf(END);

if (beginIndex === -1 || endIndex === -1 || endIndex < beginIndex) {
    console.error(`No complete block found in ${target}; left untouched.`);
    process.exit(0);
}

let cut = endIndex + END.length;

if (text[cut] === '\r') cut++;
if (text[cut] === '\n') cut++;

fs.writeFileSync(target, text.slice(0, beginIndex) + text.slice(cut));
JS

        chown "$CLOUDPANEL_FILE_OWNER" "$target"
        chmod "$CLOUDPANEL_FILE_MODE" "$target"
        log "Cleaned: $target"
    done < <(grep -rl "$BLOCK_MARKER" "$CLOUDPANEL_TEMPLATES_DIR" 2>/dev/null || true)
}

remove_backups() {
    local backup
    while IFS= read -r backup; do
        [ -z "$backup" ] && continue
        rm -f "$backup"
        log "Removed backup: $backup"
    done < <(find "$CLOUDPANEL_TEMPLATES_DIR" -name "*$BACKUP_SUFFIX" 2>/dev/null || true)
}

remove_bun_icon() {
    local icon
    icon="$(find "$CLOUDPANEL_ROOT/public" -name 'bun.svg' -path '*new-site*' 2>/dev/null | head -n 1)"

    if [ -n "$icon" ]; then
        rm -f "$icon"
        log "Removed: $icon"
    fi
}

stop_helper() {
    if command -v pm2 >/dev/null 2>&1; then
        log "Stopping helper PM2 process"
        pm2 delete "$APP_NAME" >/dev/null 2>&1 || true

        if [ "$PURGE" -eq 1 ]; then
            log "Removing every bun-site-* PM2 process"
            pm2 jlist 2>/dev/null | node -e '
                let raw = "";
                process.stdin.on("data", (c) => raw += c);
                process.stdin.on("end", () => {
                    const start = raw.indexOf("[");
                    if (start === -1) return;
                    try {
                        for (const proc of JSON.parse(raw.slice(start))) {
                            if (proc.name && proc.name.startsWith("bun-site-")) console.log(proc.name);
                        }
                    } catch (e) {}
                });
            ' 2>/dev/null | while IFS= read -r name; do
                [ -z "$name" ] && continue
                pm2 delete "$name" >/dev/null 2>&1 || true
                log "Removed PM2 process: $name"
            done
        fi

        pm2 save >/dev/null 2>&1 || true
    fi
}

remove_cron() {
    if ! command -v crontab >/dev/null 2>&1; then
        return
    fi

    log "Removing PM2 cron block"
    local cron_file
    cron_file="$(mktemp)"
    crontab -l 2>/dev/null | awk '
        /# cloudpanel-bun-helper pm2 start/ { skip=1; next }
        /# cloudpanel-bun-helper pm2 end/ { skip=0; next }
        skip != 1 { print }
    ' > "$cron_file" || true
    crontab "$cron_file"
    rm -f "$cron_file"
}

remove_firewall_rules() {
    if ! command -v ufw >/dev/null 2>&1; then
        return
    fi

    local port rule
    port="$(grep -E '^BUN_HELPER_PORT=' "$INSTALL_DIR/.env" 2>/dev/null | cut -d= -f2 || true)"
    [ -z "$port" ] && port=7880

    log "Removing UFW rules for port $port"
    while ufw status numbered 2>/dev/null | grep -q "$port/tcp"; do
        rule="$(ufw status numbered | grep "$port/tcp" | head -n 1 | sed -E 's/^\[\s*([0-9]+)\].*/\1/')"
        [ -z "$rule" ] && break
        ufw --force delete "$rule" || break
    done
    ufw reload >/dev/null 2>&1 || true
}

remove_install_dir() {
    log "Removing $INSTALL_DIR"
    rm -rf "$INSTALL_DIR"

    if [ "$PURGE" -eq 1 ]; then
        log "Removing Bun runtimes in $BUN_ROOT and site data in $BUN_HELPER_DATA_DIR"
        rm -rf "$BUN_ROOT"
        rm -rf "$BUN_HELPER_DATA_DIR"
    else
        log "Keeping Bun runtimes in $BUN_ROOT and site data in $BUN_HELPER_DATA_DIR"
    fi
}

restart_cloudpanel() {
    log "Clearing CloudPanel cache and restarting services"
    if [ -d "$CLOUDPANEL_CACHE_DIR" ]; then
        find "$CLOUDPANEL_CACHE_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
    fi

    systemctl restart clp-php-fpm
    systemctl restart clp-nginx
}

stop_helper
remove_cron
remove_firewall_rules
strip_blocks
remove_backups
remove_bun_icon
remove_install_dir
restart_cloudpanel

log "Uninstall completed"
if [ "$PURGE" -eq 0 ]; then
    echo "Bun runtimes, running Bun applications and site data were kept,"
    echo "so reinstalling picks every Bun site back up automatically."
    echo "Run 'bash uninstall.sh --purge' to remove them as well."
fi