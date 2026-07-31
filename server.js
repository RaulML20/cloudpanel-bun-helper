const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const PORT = Number(process.env.BUN_HELPER_PORT || 7880);
const HOST = process.env.BUN_HELPER_HOST || '0.0.0.0';

const SESSION_DIR = process.env.BUN_HELPER_SESSION_DIR || '/home/clp/htdocs/app/files/var/sessions';
const SESSION_COOKIE_NAME = process.env.BUN_HELPER_SESSION_COOKIE_NAME || 'cloudpanel';
const MAX_SESSION_AGE_SECONDS = Number(process.env.BUN_HELPER_MAX_SESSION_AGE_SECONDS || (24 * 60 * 60));

const ALLOWED_ORIGIN = process.env.BUN_HELPER_ALLOWED_ORIGIN || '';
const ALLOWED_CLIENT_IPS = new Set(
    (process.env.BUN_HELPER_ALLOWED_CLIENT_IPS || '')
        .split(',')
        .map((ip) => ip.trim())
        .filter(Boolean)
);
const SSL_DIR = process.env.BUN_HELPER_SSL_DIR || '/opt/cloudpanel-bun-helper/ssl';

const BUN_ROOT = process.env.BUN_ROOT || '/opt/bun';
// Deliberately outside the install directory: uninstalling (or reinstalling)
// the helper wipes /opt/cloudpanel-bun-helper, and the record of which domains
// are Bun sites must outlive that.
const DATA_DIR = process.env.BUN_HELPER_DATA_DIR || '/var/lib/cloudpanel-bun-helper';
const SITES_FILE = path.join(DATA_DIR, 'sites.json');
const CATALOG_CACHE_FILE = path.join(DATA_DIR, 'releases-cache.json');
const CATALOG_TTL_SECONDS = Number(process.env.BUN_HELPER_CATALOG_TTL_SECONDS || 86400);

const PORT_MIN = Number(process.env.BUN_PORT_MIN || 30000);
const PORT_MAX = Number(process.env.BUN_PORT_MAX || 30999);

const GITHUB_API_URL = 'https://api.github.com/repos/oven-sh/bun/releases?per_page=50';
const GITHUB_DOWNLOAD_BASE = 'https://github.com/oven-sh/bun/releases/download';

const PM2_PREFIX = 'bun-site-';
const DEFAULT_START_SCRIPT = 'index.ts';

// Long enough for a big dependency tree on a slow link, short enough that a
// package waiting on input does not hang the request forever.
const INSTALL_TIMEOUT = Number(process.env.BUN_HELPER_INSTALL_TIMEOUT_MS || 1800000);

if(process.getuid && process.getuid() !== 0) {
    console.error('CloudPanel Bun Helper must run as root.');
    process.exit(1);
}

if(!ALLOWED_ORIGIN) {
    console.error('BUN_HELPER_ALLOWED_ORIGIN is required. Set it in .env or pass it as an environment variable.');
    process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BUN_ROOT, { recursive: true });

// ---------------------------------------------------------------------------
// Security (same model as cloudpanel-terminal-helper): client IP allowlist,
// exact Origin match and a valid CloudPanel admin session cookie.
// ---------------------------------------------------------------------------

function normalizeClientIp(ip) {
    if(!ip) return '';

    if(ip.startsWith('::ffff:')) {
        return ip.slice(7);
    }

    return ip;
}

function validateClientIp(req) {
    const clientIp = normalizeClientIp(req.socket.remoteAddress);

    if(ALLOWED_CLIENT_IPS.size === 0) {
        return { ok: false, reason: 'No allowed client IPs configured' };
    }

    if(!ALLOWED_CLIENT_IPS.has(clientIp)) {
        return { ok: false, reason: `IP not allowed: ${clientIp || 'unknown'}` };
    }

    return { ok: true, clientIp };
}

function getCookieValue(cookieHeader, name) {
    if(!cookieHeader) return null;

    const cookies = cookieHeader.split(';');

    for(const cookie of cookies) {
        const [rawName, ...rawValue] = cookie.trim().split('=');
        if(rawName === name) return decodeURIComponent(rawValue.join('='));
    }

    return null;
}

function isSafeSessionId(sessionId) {
    return /^[a-zA-Z0-9,-]{16,128}$/.test(sessionId);
}

function validateCloudPanelSession(req) {
    const origin = req.headers.origin;

    if(origin !== ALLOWED_ORIGIN) {
        return { ok: false, reason: 'Invalid origin' };
    }

    const sessionId = getCookieValue(req.headers.cookie, SESSION_COOKIE_NAME);

    if(!sessionId) return { ok: false, reason: 'Missing session cookie' };

    if(!isSafeSessionId(sessionId)) return { ok: false, reason: 'Invalid session id' };

    const sessionFile = path.join(SESSION_DIR, `sess_${sessionId}`);

    const normalizedSessionDir = path.resolve(SESSION_DIR);
    const normalizedSessionFile = path.resolve(sessionFile);

    if(!normalizedSessionFile.startsWith(normalizedSessionDir + path.sep)) return { ok: false, reason: 'Invalid session path' };

    if(!fs.existsSync(normalizedSessionFile)) return { ok: false, reason: 'Session not found' };

    const stat = fs.statSync(normalizedSessionFile);
    const ageSeconds = (Date.now() - stat.mtimeMs) / 1000;

    if(ageSeconds > MAX_SESSION_AGE_SECONDS) return { ok: false, reason: 'Session expired' };

    const content = fs.readFileSync(normalizedSessionFile, 'utf8');

    const hasSecurityToken = content.includes('_security_main') && content.includes('PostAuthenticationToken');
    const isAdmin = content.includes('ROLE_ADMIN');

    if(!hasSecurityToken) return { ok: false, reason: 'Not authenticated' };

    if(!isAdmin) return { ok: false, reason: 'Admin role required' };

    return { ok: true, sessionId };
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

class ApiError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function isSafeDomainName(domainName) {
    return typeof domainName === 'string'
        && domainName.length >= 3
        && domainName.length <= 253
        && /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(domainName)
        && !domainName.includes('..');
}

function isSafeLinuxUsername(username) {
    return typeof username === 'string' && /^[a-z_][a-z0-9_-]{0,31}$/.test(username);
}

function isSafeVersion(version) {
    return typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version);
}

function isSafeStartScript(startScript) {
    return typeof startScript === 'string'
        && startScript.length <= 128
        && /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(startScript)
        && !startScript.includes('..');
}

function isSafePort(port) {
    const value = Number(port);
    return Number.isInteger(value) && value >= 1024 && value <= 65535;
}

function getUserByUsername(username) {
    let passwd;

    try{
        passwd = fs.readFileSync('/etc/passwd', 'utf8');
    }catch(error) {
        throw new ApiError(500, 'Unable to read user database');
    }

    for(const line of passwd.split('\n')) {
        if(!line.trim()) continue;

        const parts = line.split(':');

        if(parts[0] === username) {
            return { username: parts[0], uid: Number(parts[2]), gid: Number(parts[3]), home: parts[5], shell: parts[6] };
        }
    }

    return null;
}

function getUserByUid(uid) {
    try{
        const passwd = fs.readFileSync('/etc/passwd', 'utf8');

        for(const line of passwd.split('\n')) {
            if(!line.trim()) continue;

            const parts = line.split(':');
            if(Number(parts[2]) === Number(uid)) {
                return { username: parts[0], uid: Number(parts[2]), gid: Number(parts[3]), home: parts[5], shell: parts[6] };
            }
        }
    }catch(error) {}

    return null;
}

function getGroupNameByGid(gid) {
    try{
        const group = fs.readFileSync('/etc/group', 'utf8');

        for(const line of group.split('\n')) {
            if(!line.trim()) continue;

            const parts = line.split(':');
            if(Number(parts[2]) === Number(gid)) return parts[0];
        }
    }catch(error) {}

    return null;
}

// ---------------------------------------------------------------------------
// Shell helpers
// ---------------------------------------------------------------------------

function run(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const execOptions = {
            timeout: options.timeout || 60000,
            maxBuffer: 8 * 1024 * 1024,
            env: options.env || process.env,
            cwd: options.cwd
        };

        // Node drops privileges itself when these are set and the calling
        // process is root -- no need for su/sudo/runuser.
        if(options.uid !== undefined) execOptions.uid = options.uid;
        if(options.gid !== undefined) execOptions.gid = options.gid;

        execFile(command, args, execOptions, (error, stdout, stderr) => {
            if(error) {
                const output = `${stdout || ''}${stderr || ''}`.trim();
                reject(new Error(output || error.message));
                return;
            }

            resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
        });
    });
}

async function commandExists(command) {
    try{
        await run('sh', ['-c', `command -v ${command}`]);
        return true;
    }catch(error) {
        return false;
    }
}

// ---------------------------------------------------------------------------
// Sites store: one JSON file that marks which domains are Bun sites and keeps
// their per-domain configuration. This is what "identifies" a Bun domain.
// ---------------------------------------------------------------------------

function loadSites() {
    try{
        const raw = fs.readFileSync(SITES_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    }catch(error) {
        return {};
    }
}

function saveSites(sites) {
    const tmpFile = `${SITES_FILE}.tmp`;

    fs.writeFileSync(tmpFile, JSON.stringify(sites, null, 2));
    fs.renameSync(tmpFile, SITES_FILE);
}

// Rebuilds one sites.json entry out of a live PM2 process. This is what makes
// the helper survive losing its own state file (manual uninstall, a wiped
// install directory, a restore from an older snapshot): the running processes
// on the server, not sites.json, are the source of truth about what is
// configured -- the same stance Modules_Bun_Reconcile takes in the Plesk
// extension.
//
// Returns null when the process was not written by us, or when too much of it
// is unrecognisable to rebuild a usable entry.
function describePm2Process(proc) {
    if(!proc.name || !proc.name.startsWith(PM2_PREFIX)) return null;

    const domainName = proc.name.slice(PM2_PREFIX.length);
    if(!isSafeDomainName(domainName)) return null;

    const env = proc.pm2_env || {};
    const execPath = env.pm_exec_path || '';

    // "<BUN_ROOT>/<version>/bin/bun"; anything else was not started by us.
    const escapedRoot = BUN_ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const versionMatch = new RegExp(`^${escapedRoot}/([^/]+)/bin/bun$`).exec(execPath);
    if(!versionMatch || !isSafeVersion(versionMatch[1])) return null;

    const args = Array.isArray(env.args) ? env.args : [];
    const runIndex = args.indexOf('run');
    const startScript = runIndex !== -1 && args[runIndex + 1] ? String(args[runIndex + 1]) : DEFAULT_START_SCRIPT;

    const appRoot = env.pm_cwd || null;
    if(!appRoot) return null;

    let siteUser = env.uid ? String(env.uid) : null;

    // pm2_env.uid holds what we passed to --uid, but a restored dump may carry
    // a numeric uid instead; fall back to whoever owns the application root.
    if(!siteUser || !isSafeLinuxUsername(siteUser) || !getUserByUsername(siteUser)) {
        let owner = null;

        if(siteUser && /^\d+$/.test(siteUser)) owner = getUserByUid(Number(siteUser));

        if(!owner) {
            try{
                owner = getUserByUid(fs.statSync(appRoot).uid);
            }catch(error) {}
        }

        siteUser = owner ? owner.username : null;
    }

    if(!siteUser) return null;

    const port = Number(env.env && env.env.PORT ? env.env.PORT : NaN);

    return {
        domainName,
        siteUser,
        appRoot,
        port: isSafePort(port) ? port : null,
        enabled: true,
        version: versionMatch[1],
        startScript: isSafeStartScript(startScript) ? startScript : DEFAULT_START_SCRIPT,
        adoptedAt: new Date().toISOString()
    };
}

// Keeps sites.json in step with the server:
//   - drops entries whose site user is gone (site deleted from CloudPanel) and
//     removes the leftover PM2 process;
//   - adopts bun-site-* processes that are running but are not in sites.json,
//     so a reinstalled helper finds its domains again.
async function reconcileSites() {
    const sites = loadSites();
    let changed = false;

    for(const domainName of Object.keys(sites)) {
        const entry = sites[domainName];

        if(entry && entry.siteUser && getUserByUsername(entry.siteUser)) continue;

        try{
            await run('pm2', ['delete', pm2Name(domainName)]);
        }catch(error) {}

        delete sites[domainName];
        changed = true;
    }

    for(const proc of await pm2Jlist()) {
        const adopted = describePm2Process(proc);

        if(!adopted || sites[adopted.domainName]) continue;

        // A process for a domain whose site user no longer exists is a
        // leftover, not something to adopt.
        if(!getUserByUsername(adopted.siteUser)) {
            await pm2Delete(proc.name);
            continue;
        }

        sites[adopted.domainName] = adopted;
        changed = true;
        console.log(`Adopted running Bun application for ${adopted.domainName} (Bun ${adopted.version})`);
    }

    if(changed) saveSites(sites);

    return sites;
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

async function getListeningPorts() {
    const ports = new Set();

    try{
        const { stdout } = await run('ss', ['-ltnH']);

        for(const line of stdout.split('\n')) {
            const columns = line.trim().split(/\s+/);
            if(columns.length < 4) continue;

            const local = columns[3];
            const port = Number(local.slice(local.lastIndexOf(':') + 1));

            if(Number.isInteger(port)) ports.add(port);
        }
    }catch(error) {}

    return ports;
}

// A port is taken when another managed Bun site has it configured, or when any
// process on the server is already listening on it. The domain being edited is
// allowed to keep its own current port even while its app is running.
async function checkPortAvailable(port, forDomainName) {
    port = Number(port);
    const sites = loadSites();

    for(const domainName of Object.keys(sites)) {
        if(domainName === forDomainName) continue;

        if(Number(sites[domainName].port) === port) {
            throw new ApiError(409, `Port ${port} is already assigned to ${domainName}`);
        }
    }

    const current = forDomainName ? sites[forDomainName] : null;
    if(current && Number(current.port) === port) return;

    const listening = await getListeningPorts();

    if(listening.has(port)) {
        throw new ApiError(409, `Port ${port} is already in use by another process on this server`);
    }
}

async function suggestPort() {
    const sites = loadSites();
    const taken = new Set();

    for(const domainName of Object.keys(sites)) {
        const port = Number(sites[domainName].port);
        if(Number.isInteger(port)) taken.add(port);
    }

    const listening = await getListeningPorts();

    for(let port = PORT_MIN; port <= PORT_MAX; port++) {
        if(!taken.has(port) && !listening.has(port)) return port;
    }

    throw new ApiError(409, `No free ports left in the ${PORT_MIN}-${PORT_MAX} range`);
}

// ---------------------------------------------------------------------------
// Bun version catalogue (GitHub releases, cached on disk like the Plesk
// extension does: GitHub throttles anonymous requests to 60/hour per IP)
// ---------------------------------------------------------------------------

function httpsGetJson(requestUrl) {
    return new Promise((resolve, reject) => {
        const request = https.get(requestUrl, {
            headers: {
                'User-Agent': 'cloudpanel-bun-helper',
                'Accept': 'application/vnd.github+json'
            },
            timeout: 20000
        }, (response) => {
            if(response.statusCode !== 200) {
                response.resume();
                reject(new Error(`GitHub API returned HTTP ${response.statusCode}`));
                return;
            }

            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => { body += chunk; });
            response.on('end', () => {
                try{
                    resolve(JSON.parse(body));
                }catch(error) {
                    reject(new Error('GitHub API returned an invalid response'));
                }
            });
        });

        request.on('timeout', () => request.destroy(new Error('GitHub API request timed out')));
        request.on('error', reject);
    });
}

function readCatalogCache() {
    try{
        const parsed = JSON.parse(fs.readFileSync(CATALOG_CACHE_FILE, 'utf8'));
        if(Array.isArray(parsed.versions) && Number.isInteger(parsed.ts)) return parsed;
    }catch(error) {}

    return null;
}

function compareVersionsDesc(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);

    for(let i = 0; i < 3; i++) {
        if(pa[i] !== pb[i]) return pb[i] - pa[i];
    }

    return 0;
}

// Never throws: on a network failure it returns the cache even if stale, and
// an empty list when there is none.
async function getAvailableVersions(forceRefresh = false) {
    const cached = readCatalogCache();
    const isFresh = cached && (Date.now() / 1000 - cached.ts) < CATALOG_TTL_SECONDS;

    if(!forceRefresh && isFresh) return { versions: cached.versions, ts: cached.ts };

    try{
        const releases = await httpsGetJson(GITHUB_API_URL);
        const versions = [];

        for(const release of releases) {
            if(release.draft || release.prerelease) continue;

            const match = /^bun-v(\d+\.\d+\.\d+)$/.exec(release.tag_name || '');
            if(match) versions.push(match[1]);
        }

        if(!versions.length) throw new Error('No published versions found');

        versions.sort(compareVersionsDesc);

        const unique = [...new Set(versions)];
        const ts = Math.floor(Date.now() / 1000);

        fs.writeFileSync(CATALOG_CACHE_FILE, JSON.stringify({ versions: unique, ts }));

        return { versions: unique, ts };
    }catch(error) {
        console.error(`Could not query the Bun catalogue: ${error.message}`);

        if(cached) return { versions: cached.versions, ts: cached.ts };

        return { versions: [], ts: null };
    }
}

// ---------------------------------------------------------------------------
// Installed Bun runtimes: /opt/bun/<version>/bin/bun, root-owned, world
// executable so site users can run them.
// ---------------------------------------------------------------------------

function bunBinaryPath(version) {
    return path.join(BUN_ROOT, version, 'bin', 'bun');
}

function listInstalledVersions() {
    const versions = [];

    try{
        for(const entry of fs.readdirSync(BUN_ROOT)) {
            if(!isSafeVersion(entry)) continue;

            try{
                fs.accessSync(bunBinaryPath(entry), fs.constants.X_OK);
                versions.push(entry);
            }catch(error) {}
        }
    }catch(error) {}

    versions.sort(compareVersionsDesc);

    return versions;
}

// Bun ships a 'baseline' build for x64 CPUs without AVX2.
function detectAsset() {
    const arch = os.arch();

    if(arch === 'x64') {
        try{
            const cpuinfo = fs.readFileSync('/proc/cpuinfo', 'utf8');
            if(/\bavx2\b/.test(cpuinfo)) return 'bun-linux-x64';
        }catch(error) {}

        return 'bun-linux-x64-baseline';
    }

    if(arch === 'arm64') return 'bun-linux-aarch64';

    throw new ApiError(500, `Unsupported architecture: ${arch}`);
}

function findFileRecursive(dir, name) {
    for(const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);

        if(entry.isDirectory()) {
            const found = findFileRecursive(fullPath, name);
            if(found) return found;
        }else if(entry.name === name) {
            return fullPath;
        }
    }

    return null;
}

async function installVersion(version) {
    if(!isSafeVersion(version)) throw new ApiError(400, `Invalid version: ${version}`);

    const dest = path.join(BUN_ROOT, version);

    if(fs.existsSync(bunBinaryPath(version))) return `Version ${version} is already installed`;

    for(const tool of ['curl', 'unzip']) {
        if(!(await commandExists(tool))) throw new ApiError(500, `Missing required tool on the server: ${tool}`);
    }

    const asset = detectAsset();
    const downloadUrl = `${GITHUB_DOWNLOAD_BASE}/bun-v${version}/${asset}.zip`;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bun-install-'));

    try{
        const zipFile = path.join(tmpDir, 'bun.zip');
        const extractDir = path.join(tmpDir, 'extract');

        try{
            await run('curl', [
                '-fsSL', '--retry', '3', '--retry-delay', '2',
                '--connect-timeout', '20', '--max-time', '600',
                '-o', zipFile, downloadUrl
            ], { timeout: 630000 });
        }catch(error) {
            throw new ApiError(502, `Could not download ${downloadUrl}`);
        }

        try{
            await run('unzip', ['-q', zipFile, '-d', extractDir], { timeout: 120000 });
        }catch(error) {
            throw new ApiError(502, 'The downloaded file is not a valid ZIP');
        }

        const binary = findFileRecursive(extractDir, 'bun');
        if(!binary) throw new ApiError(502, "No 'bun' binary found inside the archive");

        fs.chmodSync(binary, 0o755);

        try{
            await run(binary, ['--version'], { timeout: 15000 });
        }catch(error) {
            throw new ApiError(500, 'The downloaded binary cannot run on this system');
        }

        // Assembled in a staging directory and copied into place in one piece,
        // so a failure never leaves a half-installed version behind.
        const staging = path.join(tmpDir, 'stage');

        fs.mkdirSync(path.join(staging, 'bin'), { recursive: true });
        fs.renameSync(binary, path.join(staging, 'bin', 'bun'));
        fs.chmodSync(path.join(staging, 'bin', 'bun'), 0o755);
        fs.chmodSync(path.join(staging, 'bin'), 0o755);
        fs.chmodSync(staging, 0o755);

        fs.rmSync(dest, { recursive: true, force: true });
        fs.cpSync(staging, dest, { recursive: true });
        fs.chmodSync(dest, 0o755);

        return `Installed version ${version} at ${bunBinaryPath(version)}`;
    }finally{
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

async function getVersionsInUse() {
    const inUse = {};
    const sites = loadSites();

    for(const domainName of Object.keys(sites)) {
        const entry = sites[domainName];

        if(!entry.enabled || !entry.version) continue;

        if(!inUse[entry.version]) inUse[entry.version] = [];
        if(!inUse[entry.version].includes(domainName)) inUse[entry.version].push(domainName);
    }

    // Also inspect the live PM2 process list: the server, not sites.json, is
    // the source of truth about what is actually running.
    for(const proc of await pm2Jlist()) {
        if(!proc.name || !proc.name.startsWith(PM2_PREFIX)) continue;

        const execPath = proc.pm2_env && proc.pm2_env.pm_exec_path ? proc.pm2_env.pm_exec_path : '';
        const match = new RegExp(`^${BUN_ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/([^/]+)/bin/bun$`).exec(execPath);

        if(!match || !isSafeVersion(match[1])) continue;

        const domainName = proc.name.slice(PM2_PREFIX.length);

        if(!inUse[match[1]]) inUse[match[1]] = [];
        if(!inUse[match[1]].includes(domainName)) inUse[match[1]].push(domainName);
    }

    return inUse;
}

async function removeVersion(version) {
    if(!isSafeVersion(version)) throw new ApiError(400, `Invalid version: ${version}`);

    const dest = path.join(BUN_ROOT, version);

    if(!fs.existsSync(dest)) throw new ApiError(404, `Version ${version} is not installed`);

    const inUse = await getVersionsInUse();

    if(inUse[version] && inUse[version].length) {
        throw new ApiError(409, `Version ${version} is in use by: ${inUse[version].join(', ')}`);
    }

    fs.rmSync(dest, { recursive: true, force: true });

    return `Removed version ${version}`;
}

async function buildVersionsPayload(forceRefresh) {
    const catalog = await getAvailableVersions(forceRefresh);
    const installed = listInstalledVersions();
    const inUse = await getVersionsInUse();

    const all = [...new Set([...catalog.versions, ...installed])];
    all.sort(compareVersionsDesc);

    return {
        cacheTimestamp: catalog.ts,
        versions: all.map((version) => ({
            version,
            installed: installed.includes(version),
            inUse: inUse[version] || []
        }))
    };
}

// ---------------------------------------------------------------------------
// PM2
// ---------------------------------------------------------------------------

function pm2Name(domainName) {
    return `${PM2_PREFIX}${domainName}`;
}

async function pm2Available() {
    try{
        await run('pm2', ['-v'], { timeout: 30000 });
        return true;
    }catch(error) {
        return false;
    }
}

async function requirePm2() {
    if(!(await pm2Available())) {
        throw new ApiError(500, 'PM2 is not installed on this server. Install PM2 first (npm install -g pm2) and try again.');
    }
}

async function pm2Jlist() {
    try{
        const { stdout } = await run('pm2', ['jlist'], { timeout: 30000 });
        // PM2 may print daemon-launch noise before the JSON on first run.
        const jsonStart = stdout.indexOf('[');

        if(jsonStart === -1) return [];

        const parsed = JSON.parse(stdout.slice(jsonStart));

        return Array.isArray(parsed) ? parsed : [];
    }catch(error) {
        return [];
    }
}

async function pm2Delete(name) {
    try{
        await run('pm2', ['delete', name], { timeout: 30000 });
    }catch(error) {}
}

async function pm2Save() {
    try{
        await run('pm2', ['save'], { timeout: 30000 });
    }catch(error) {}
}

async function findPm2Process(domainName) {
    const name = pm2Name(domainName);

    for(const proc of await pm2Jlist()) {
        if(proc.name === name) return proc;
    }

    return null;
}

async function getSiteStatus(domainName) {
    const proc = await findPm2Process(domainName);

    if(!proc) return { status: 'none', pid: null, uptime: null, restarts: null, memory: null };

    return {
        status: proc.pm2_env ? proc.pm2_env.status : 'unknown',
        pid: proc.pid || null,
        uptime: proc.pm2_env && proc.pm2_env.pm_uptime ? proc.pm2_env.pm_uptime : null,
        restarts: proc.pm2_env ? proc.pm2_env.restart_time : null,
        memory: proc.monit ? proc.monit.memory : null
    };
}

// ---------------------------------------------------------------------------
// Site operations
// ---------------------------------------------------------------------------

function ensureAppRoot(entry, user) {
    if(!fs.existsSync(entry.appRoot)) {
        fs.mkdirSync(entry.appRoot, { recursive: true });
        fs.chownSync(entry.appRoot, user.uid, user.gid);
    }
}

async function createSite(body) {
    const domainName = String(body.domainName || '').trim().toLowerCase();
    const siteUser = String(body.siteUser || '').trim();
    const siteUserPassword = String(body.siteUserPassword || '');
    const port = Number(body.port);

    if(!isSafeDomainName(domainName)) throw new ApiError(400, 'Invalid domain name');
    if(!isSafeLinuxUsername(siteUser)) throw new ApiError(400, 'Invalid site user');
    if(!siteUserPassword || siteUserPassword.length < 6 || siteUserPassword.length > 128) throw new ApiError(400, 'Invalid site user password');
    if(!isSafePort(port)) throw new ApiError(400, 'Invalid port');

    // The user asked for it this way: no PM2, no Bun site. Fail before
    // touching CloudPanel so nothing is half-created.
    await requirePm2();

    if(!listInstalledVersions().length) {
        throw new ApiError(409, 'No Bun version is installed on this server. Install one first from Admin Area > Instance > Services.');
    }

    await reconcileSites();

    const sites = loadSites();

    if(sites[domainName]) throw new ApiError(409, `${domainName} is already managed as a Bun site`);

    await checkPortAvailable(port, null);

    if(!(await commandExists('clpctl'))) throw new ApiError(500, 'clpctl was not found on this server');

    try{
        await run('clpctl', [
            'site:add:reverse-proxy',
            `--domainName=${domainName}`,
            `--reverseProxyUrl=http://127.0.0.1:${port}`,
            `--siteUser=${siteUser}`,
            `--siteUserPassword=${siteUserPassword}`
        ], { timeout: 180000 });
    }catch(error) {
        throw new ApiError(500, `clpctl failed: ${error.message}`);
    }

    const user = getUserByUsername(siteUser);
    if(!user) throw new ApiError(500, `Site user was not created: ${siteUser}`);

    const entry = {
        domainName,
        siteUser,
        appRoot: path.join(user.home, 'htdocs', domainName),
        port,
        enabled: false,
        version: null,
        startScript: DEFAULT_START_SCRIPT,
        createdAt: new Date().toISOString()
    };

    ensureAppRoot(entry, user);

    sites[domainName] = entry;
    saveSites(sites);

    return entry;
}

async function applySiteSettings(domainName, body) {
    const sites = await reconcileSites();
    const entry = sites[domainName];

    if(!entry) throw new ApiError(404, `${domainName} is not a Bun site`);

    const enabled = Boolean(body.enabled);
    const port = Number(body.port);
    const startScript = String(body.startScript || '').trim() || DEFAULT_START_SCRIPT;
    const version = body.version ? String(body.version).trim() : null;

    if(!isSafePort(port)) throw new ApiError(400, 'Invalid port');
    if(!isSafeStartScript(startScript)) throw new ApiError(400, 'Invalid start script');

    if(port !== Number(entry.port)) await checkPortAvailable(port, domainName);

    if(enabled) {
        if(!isSafeVersion(version || '')) throw new ApiError(400, 'Select an installed Bun version');

        const bunBin = bunBinaryPath(version);

        if(!fs.existsSync(bunBin)) throw new ApiError(400, `Bun ${version} is not installed on the server`);

        await requirePm2();

        const user = getUserByUsername(entry.siteUser);
        if(!user) throw new ApiError(500, `Site user not found: ${entry.siteUser}`);
        if(user.uid === 0) throw new ApiError(500, 'Refusing to run an application as root');

        ensureAppRoot(entry, user);

        const group = getGroupNameByGid(user.gid) || entry.siteUser;
        const name = pm2Name(domainName);

        await pm2Delete(name);

        try{
            await run('pm2', [
                'start', bunBin,
                '--name', name,
                '--interpreter', 'none',
                '--cwd', entry.appRoot,
                '--uid', entry.siteUser,
                '--gid', group,
                '--merge-logs',
                '--time',
                '--restart-delay', '5000',
                '--', 'run', startScript
            ], {
                timeout: 60000,
                env: { ...process.env, PORT: String(port), NODE_ENV: 'production' }
            });
        }catch(error) {
            await pm2Delete(name);

            entry.enabled = false;
            entry.version = version;
            entry.startScript = startScript;
            entry.port = port;
            sites[domainName] = entry;
            saveSites(sites);

            throw new ApiError(500, `The application could not be started: ${error.message}`);
        }

        await pm2Save();
    }else{
        await pm2Delete(pm2Name(domainName));
        await pm2Save();
    }

    entry.enabled = enabled;
    entry.version = version;
    entry.startScript = startScript;
    entry.port = port;
    sites[domainName] = entry;
    saveSites(sites);

    return entry;
}

// Equivalent of "bun install" over the site's own project. Enabling Bun never
// runs this on its own: a project freshly deployed (e.g. cloned from git,
// node_modules not committed) would otherwise crash on its first start with
// "Module not found" for every dependency, which is exactly what surfaced
// this as a bug -- it needs to be its own explicit action.
//
// Runs as the site's own system user, never root: Node drops privileges
// itself via the uid/gid options on execFile, so no su/sudo/runuser dance is
// needed. Dependencies may carry postinstall scripts, so the environment is
// wiped down to HOME/PATH/cache dir first -- the same posture as the Plesk
// extension's "env -i" -- instead of leaking this process's own environment
// into arbitrary third-party code.
async function installDependencies(domainName) {
    const sites = loadSites();
    const entry = sites[domainName];

    if(!entry) throw new ApiError(404, `${domainName} is not a Bun site`);
    if(!isSafeVersion(entry.version || '')) throw new ApiError(400, 'Select and save a Bun version before installing dependencies');

    const bunBin = bunBinaryPath(entry.version);
    if(!fs.existsSync(bunBin)) throw new ApiError(400, `Bun ${entry.version} is not installed on the server`);

    const user = getUserByUsername(entry.siteUser);
    if(!user) throw new ApiError(500, `Site user not found: ${entry.siteUser}`);
    if(user.uid === 0) throw new ApiError(500, 'Refusing to run as root');

    if(!fs.existsSync(path.join(entry.appRoot, 'package.json'))) {
        throw new ApiError(400, `There is no package.json in ${entry.appRoot}`);
    }

    try{
        const result = await run(bunBin, ['install', '--no-progress'], {
            timeout: INSTALL_TIMEOUT,
            cwd: entry.appRoot,
            uid: user.uid,
            gid: user.gid,
            env: {
                HOME: user.home,
                PATH: '/usr/local/bin:/usr/bin:/bin',
                BUN_INSTALL_CACHE_DIR: path.join(user.home, '.bun', 'install', 'cache')
            }
        });

        return `${result.stdout}${result.stderr}`.trim();
    }catch(error) {
        throw new ApiError(500, `bun install failed: ${error.message}`);
    }
}

async function restartSite(domainName) {
    const sites = loadSites();
    const entry = sites[domainName];

    if(!entry) throw new ApiError(404, `${domainName} is not a Bun site`);
    if(!entry.enabled) throw new ApiError(409, 'Bun is not enabled for this site');

    await requirePm2();

    try{
        await run('pm2', ['restart', pm2Name(domainName)], { timeout: 60000 });
    }catch(error) {
        throw new ApiError(500, `The application could not be restarted: ${error.message}`);
    }
}

function readLastLines(file, lines) {
    try{
        const stat = fs.statSync(file);
        const readSize = Math.min(stat.size, 256 * 1024);
        const buffer = Buffer.alloc(readSize);
        const fd = fs.openSync(file, 'r');

        fs.readSync(fd, buffer, 0, readSize, stat.size - readSize);
        fs.closeSync(fd);

        const allLines = buffer.toString('utf8').split('\n');

        if(allLines.length && allLines[allLines.length - 1] === '') allLines.pop();

        return allLines.slice(-lines).join('\n');
    }catch(error) {
        return '';
    }
}

async function getSiteLogs(domainName, lines) {
    const sites = loadSites();

    if(!sites[domainName]) throw new ApiError(404, `${domainName} is not a Bun site`);

    const proc = await findPm2Process(domainName);
    let outFile = null;
    let errFile = null;

    if(proc && proc.pm2_env) {
        outFile = proc.pm2_env.pm_out_log_path || null;
        errFile = proc.pm2_env.pm_err_log_path || null;
    }

    return {
        out: outFile ? readLastLines(outFile, lines) : '',
        err: errFile ? readLastLines(errFile, lines) : ''
    };
}

// ---------------------------------------------------------------------------
// HTTP layer
// ---------------------------------------------------------------------------

function setCorsHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Vary', 'Origin');
}

function sendJsonResponse(res, status, payload) {
    setCorsHeaders(res);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        let size = 0;

        req.on('data', (chunk) => {
            size += chunk.length;

            if(size > 64 * 1024) {
                reject(new ApiError(413, 'Request body too large'));
                req.destroy();
                return;
            }

            body += chunk;
        });

        req.on('end', () => {
            if(!body) {
                resolve({});
                return;
            }

            try{
                const parsed = JSON.parse(body);
                resolve(parsed && typeof parsed === 'object' ? parsed : {});
            }catch(error) {
                reject(new ApiError(400, 'Invalid JSON body'));
            }
        });

        req.on('error', reject);
    });
}

function extractDomainFromPath(segment) {
    const domainName = decodeURIComponent(segment || '').trim().toLowerCase();

    if(!isSafeDomainName(domainName)) throw new ApiError(400, 'Invalid domain name');

    return domainName;
}

async function handleRequest(req, res) {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname.replace(/\/+$/, '') || '/';

    if(req.method === 'OPTIONS') {
        if(req.headers.origin !== ALLOWED_ORIGIN) {
            res.writeHead(403);
            res.end();
            return;
        }

        setCorsHeaders(res);
        res.writeHead(204);
        res.end();
        return;
    }

    const ipCheck = validateClientIp(req);

    if(!ipCheck.ok) {
        sendJsonResponse(res, 403, { ok: false, error: ipCheck.reason });
        return;
    }

    if(pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('CloudPanel Bun Helper OK\n');
        return;
    }

    const auth = validateCloudPanelSession(req);

    if(!auth.ok) {
        sendJsonResponse(res, 401, { ok: false, error: auth.reason });
        return;
    }

    const segments = pathname.split('/').filter(Boolean);

    // GET /api/versions
    if(req.method === 'GET' && pathname === '/api/versions') {
        const payload = await buildVersionsPayload(parsedUrl.query.refresh === '1');
        sendJsonResponse(res, 200, { ok: true, ...payload });
        return;
    }

    // POST /api/versions/install
    if(req.method === 'POST' && pathname === '/api/versions/install') {
        const body = await readJsonBody(req);
        const message = await installVersion(String(body.version || ''));
        sendJsonResponse(res, 200, { ok: true, message });
        return;
    }

    // POST /api/versions/remove
    if(req.method === 'POST' && pathname === '/api/versions/remove') {
        const body = await readJsonBody(req);
        const message = await removeVersion(String(body.version || ''));
        sendJsonResponse(res, 200, { ok: true, message });
        return;
    }

    // GET /api/ports/suggest
    if(req.method === 'GET' && pathname === '/api/ports/suggest') {
        await reconcileSites();
        const port = await suggestPort();
        sendJsonResponse(res, 200, { ok: true, port });
        return;
    }

    // GET /api/sites - every managed Bun domain, for the sites listing page
    if(req.method === 'GET' && pathname === '/api/sites') {
        const sites = await reconcileSites();

        sendJsonResponse(res, 200, {
            ok: true,
            domains: Object.keys(sites).map((domainName) => ({
                domainName,
                enabled: Boolean(sites[domainName].enabled),
                version: sites[domainName].version || null
            }))
        });
        return;
    }

    // POST /api/sites
    if(req.method === 'POST' && pathname === '/api/sites') {
        const body = await readJsonBody(req);
        const entry = await createSite(body);
        sendJsonResponse(res, 200, { ok: true, site: entry });
        return;
    }

    // /api/sites/<domain>[...]
    if(segments[0] === 'api' && segments[1] === 'sites' && segments.length >= 3) {
        const domainName = extractDomainFromPath(segments[2]);
        const action = segments[3] || null;

        // GET /api/sites/<domain>
        if(req.method === 'GET' && !action) {
            const sites = await reconcileSites();
            const entry = sites[domainName];

            if(!entry) {
                sendJsonResponse(res, 404, { ok: false, error: `${domainName} is not a Bun site` });
                return;
            }

            const status = await getSiteStatus(domainName);
            const installedVersions = listInstalledVersions();

            sendJsonResponse(res, 200, { ok: true, site: entry, status, installedVersions });
            return;
        }

        // POST /api/sites/<domain>/settings
        if(req.method === 'POST' && action === 'settings') {
            const body = await readJsonBody(req);
            const entry = await applySiteSettings(domainName, body);
            const status = await getSiteStatus(domainName);

            sendJsonResponse(res, 200, { ok: true, site: entry, status });
            return;
        }

        // POST /api/sites/<domain>/restart
        if(req.method === 'POST' && action === 'restart') {
            await restartSite(domainName);
            const status = await getSiteStatus(domainName);

            sendJsonResponse(res, 200, { ok: true, status });
            return;
        }

        // POST /api/sites/<domain>/install
        if(req.method === 'POST' && action === 'install') {
            const output = await installDependencies(domainName);

            sendJsonResponse(res, 200, { ok: true, output });
            return;
        }

        // GET /api/sites/<domain>/logs?lines=100
        if(req.method === 'GET' && action === 'logs') {
            let lines = Number(parsedUrl.query.lines || 100);

            if(!Number.isInteger(lines) || lines < 1 || lines > 1000) lines = 100;

            const logs = await getSiteLogs(domainName, lines);
            sendJsonResponse(res, 200, { ok: true, ...logs });
            return;
        }
    }

    sendJsonResponse(res, 404, { ok: false, error: 'Not found' });
}

const server = https.createServer({
    key: fs.readFileSync(path.join(SSL_DIR, 'bun-helper.key')),
    cert: fs.readFileSync(path.join(SSL_DIR, 'bun-helper.crt'))
}, (req, res) => {
    handleRequest(req, res).catch((error) => {
        const status = error instanceof ApiError ? error.status : 500;
        const message = error instanceof ApiError ? error.message : 'Internal server error';

        if(!(error instanceof ApiError)) console.error(error);

        if(!res.headersSent) {
            sendJsonResponse(res, status, { ok: false, error: message });
        }else{
            res.end();
        }
    });
});

// Version installs and "bun install" can both take a while on a slow link;
// the HTTP server's own timeout must not fire before INSTALL_TIMEOUT does.
server.requestTimeout = INSTALL_TIMEOUT + 60000;
server.headersTimeout = 60000;

server.listen(PORT, HOST, () => {
    console.log(`CloudPanel Bun Helper listening on ${HOST}:${PORT}`);

    // Pick up applications that are running but missing from sites.json, so a
    // freshly reinstalled helper knows about them before anyone opens a page.
    reconcileSites()
        .then((sites) => {
            console.log(`Managing ${Object.keys(sites).length} Bun site(s); installed runtimes: ${listInstalledVersions().join(', ') || 'none'}`);
        })
        .catch((error) => {
            console.error(`Initial reconcile failed: ${error.message}`);
        });
});