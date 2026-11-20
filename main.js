const { app, BrowserWindow, session, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;
const captchaSolver = require('./captcha_solver.js');

// ------------------------------------------------------------------
// CONFIGURATION DES SWITCHES DE LIGNE DE COMMANDE (TLS, WebRTC, etc.)
// ------------------------------------------------------------------
app.commandLine.appendSwitch('enable-features', 'PermuteTLSExtensions');
app.commandLine.appendSwitch('disable-webrtc-hw-decoding');
app.commandLine.appendSwitch('disable-webrtc-hw-encoding');
app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'default_public_interface_only');
app.commandLine.appendSwitch('disable-webrtc-encryption');
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
const ciphersToBlacklist = [
    'TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256',
    'TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256'
];
if (Math.random() > 0.5) {
    app.commandLine.appendSwitch('cipher-suite-blacklist', ciphersToBlacklist.join(','));
}

// ------------------------------------------------------------------
// SYSTÈME DE LOG AMÉLIORÉ + DÉTECTION INACTIVITÉ
// ------------------------------------------------------------------

let lastLogTimestamp = Date.now();
const INACTIVITY_TIMEOUT_SECONDS = 120;
let inactivityWatcherInterval = null;
let freezeReloadInProgress = false;
let freezeReloadTimeout = null;
let isInSensitiveState = false;

function log(type, message) {
    lastLogTimestamp = Date.now();

    const now = new Date();
    const time = now.toLocaleTimeString("fr-FR", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
    });

    const colors = {
        reset: "\x1b[0m",
        dim: "\x1b[2m",
        bright: "\x1b[1m",
        timeColor: "\x1b[38;2;242;143;12m",
        green: "\x1b[38;2;22;250;76m",
        cyan: "\x1b[38;2;22;231;250m",
        violet: "\x1b[38;2;198;53;242m",
        orange: "\x1b[38;2;250;208;72m",
        taskMessage: "\x1b[38;2;177;242;12m",
        reloadMessage: "\x1b[38;2;8;14;130m",
        pageLoadedMessage: "\x1b[38;2;161;8;67m",
        red: "\x1b[38;2;255;80;80m",
        blue: "\x1b[38;2;80;140;255m",
        white: "\x1b[97m",
        gray: "\x1b[90m",
        magenta: "\x1b[95m"
    };

    const colorMap = {
        info: colors.cyan,
        success: colors.green,
        task: colors.green + colors.bright,
        warning: colors.orange,
        error: colors.red,
        captcha: colors.red + colors.bright,
        debug: colors.magenta,
        config: colors.white,
        proxy: colors.blue,
        cookie: colors.violet,
        youtube: colors.violet + colors.bright
    };

    const logType = (type || "info").toLowerCase();
    let labelColor = colorMap[logType] || colors.cyan;
    let messageColor = (logType === "task") ? colors.taskMessage : labelColor;

    if (logType === "info") {
        if (message.includes("Pas de tâche →")) messageColor = colors.reloadMessage;
        else if (message.includes("Rechargement de page")) messageColor = colors.pageLoadedMessage;
    }

    const timePart = `${colors.timeColor}${time}${colors.reset}`;
    const typePart = `${labelColor}[ ]${colors.reset}`;
    const messagePart = `${messageColor}${message}${colors.reset}`;

    console.log(`${timePart} ${typePart} ${messagePart}`);
}

function resetAllBlockingFlags() {
    taskJustClicked = false;
    handleVideoWatchedEnoughCalled = false;
    rewardClaimedWhileWatching = false;
    isResolvingCaptcha = false;
    delayAfterSuspiciousWindowClose = false;
    isNewYoutubeWindowOpen = false;
}

function checkInactivityAndRestart() {
    if (freezeReloadInProgress) return;
    if (isInSensitiveState || captchaDetected || isFullScreenFromTitle || waitingForVideoUnlock || taskJustClicked || isResolvingCaptcha) {
        lastLogTimestamp = Date.now();
        return;
    }

    const now = Date.now();
    const secondsSinceLastLog = Math.floor((now - lastLogTimestamp) / 1000);

        if (secondsSinceLastLog >= INACTIVITY_TIMEOUT_SECONDS) {
        freezeReloadInProgress = true;
        log("warning", `AUCUN LOG depuis ${secondsSinceLastLog}s → gel détecté → RECHARGEMENT`);
        closeAllSecondaryWindows();
        resetAllBlockingFlags();
        automationRunning = false;
        taskClickInProgress = false;
        if (freezeReloadTimeout) clearTimeout(freezeReloadTimeout);
        freezeReloadTimeout = setTimeout(() => {
            if (!freezeReloadInProgress) return;
            freezeReloadInProgress = false;
            freezeReloadTimeout = null;
            if (!automationPaused && mainWindow && !mainWindow.isDestroyed()) {
                log("warning", "Le rechargement n’a pas terminé → nouvelle tentative forcée");
                mainWindow.webContents.reloadIgnoringCache();
                freezeReloadInProgress = true;
                freezeReloadTimeout = setTimeout(() => {
                    if (freezeReloadInProgress && mainWindow && !mainWindow.isDestroyed()) {
                        log("warning", "Second essai de rechargement après gel");
                        mainWindow.webContents.reloadIgnoringCache();
                    }
                }, 30000);
            }
        }, 30000);
        setTimeout(() => {
            if (!automationPaused && mainWindow && !mainWindow.isDestroyed()) {
                log("info", "→ Rechargement auto après détection d'inactivité");
                lastLogTimestamp = Date.now();
                mainWindow.reload();
            } else {
                freezeReloadInProgress = false;
            }
        }, 1800);
    }
}

function startInactivityWatcher() {
    if (inactivityWatcherInterval) return;
    inactivityWatcherInterval = setInterval(() => {
        if (automationPaused) return;
        checkInactivityAndRestart();
    }, 15000);
}

// ==========================================================================
// MENU CONTEXTUEL (clic droit) - VERSION ROBUSTE
// ==========================================================================

function showContextMenu(window, params) {
    const menuTemplate = [];
    
    // ===== INSPECTER =====
    menuTemplate.push({
        label: '🔍 Inspecter',
        accelerator: 'Ctrl+Shift+I',
        click: () => {
            try {
                window.webContents.inspectElement(params.x, params.y);
                if (window.webContents.isDevToolsOpened()) {
                    window.webContents.devToolsWebContents.focus();
                }
                log("debug", `🔍 Inspecter → (${params.x}, ${params.y})`);
            } catch (err) {
                log("error", `Erreur inspecter: ${err.message}`);
            }
        }
    });
    
    menuTemplate.push({ type: 'separator' });
    
    // ===== LIEN =====
    if (params.linkURL) {
        menuTemplate.push({
            label: '🔗 Ouvrir le lien dans un nouvel onglet',
            click: () => {
                const newWindow = new BrowserWindow({
                    width: 1280,
                    height: 720,
                    webPreferences: {
                        nodeIntegration: false,
                        contextIsolation: true
                    }
                });
                attachContextMenu(newWindow);
                newWindow.loadURL(params.linkURL);
            }
        });
        
        menuTemplate.push({
            label: '🔗 Copier l\'adresse du lien',
            click: () => {
                const { clipboard } = require('electron');
                clipboard.writeText(params.linkURL);
            }
        });
        
        menuTemplate.push({ type: 'separator' });
    }
    
    // ===== IMAGE =====
    if (params.mediaType === 'image' && params.srcURL) {
        menuTemplate.push({
            label: '🖼️ Ouvrir l\'image dans un nouvel onglet',
            click: () => {
                const newWindow = new BrowserWindow({
                    width: 1000,
                    height: 800,
                    webPreferences: {
                        nodeIntegration: false,
                        contextIsolation: true
                    }
                });
                attachContextMenu(newWindow);
                newWindow.loadURL(params.srcURL);
            }
        });
        
        menuTemplate.push({
            label: '🖼️ Copier l\'adresse de l\'image',
            click: () => {
                const { clipboard } = require('electron');
                clipboard.writeText(params.srcURL);
            }
        });
        
        menuTemplate.push({ type: 'separator' });
    }
    
    // ===== TEXTE SÉLECTIONNÉ =====
    if (params.selectionText && params.selectionText.trim()) {
        menuTemplate.push({
            label: '📋 Copier',
            accelerator: 'Ctrl+C',
            click: () => {
                const { clipboard } = require('electron');
                clipboard.writeText(params.selectionText);
            }
        });
        
        menuTemplate.push({
            label: '🔍 Rechercher dans Google',
            click: () => {
                const url = `https://www.google.com/search?q=${encodeURIComponent(params.selectionText)}`;
                const newWindow = new BrowserWindow({
                    width: 1200,
                    height: 800,
                    webPreferences: {
                        nodeIntegration: false,
                        contextIsolation: true
                    }
                });
                attachContextMenu(newWindow);
                newWindow.loadURL(url);
            }
        });
        
        menuTemplate.push({ type: 'separator' });
    }
    
    // ===== CHAMP ÉDITABLE =====
    if (params.isEditable) {
        menuTemplate.push({
            label: '✂️ Couper',
            accelerator: 'Ctrl+X',
            role: 'cut'
        });
        
        menuTemplate.push({
            label: '📋 Copier',
            accelerator: 'Ctrl+C',
            role: 'copy'
        });
        
        menuTemplate.push({
            label: '📋 Coller',
            accelerator: 'Ctrl+V',
            role: 'paste'
        });
        
        menuTemplate.push({
            label: '🔤 Tout sélectionner',
            accelerator: 'Ctrl+A',
            role: 'selectAll'
        });
        
        menuTemplate.push({ type: 'separator' });
    }
    
    // ===== ACTIONS PAGE =====
    menuTemplate.push({
        label: '🔄 Actualiser',
        accelerator: 'Ctrl+R',
        click: () => {
            window.webContents.reload();
        }
    });
    
    menuTemplate.push({
        label: '⬅️ Retour',
        click: () => {
            if (window.webContents.canGoBack()) {
                window.webContents.goBack();
            }
        }
    });
    
    menuTemplate.push({
        label: '➡️ Avancer',
        click: () => {
            if (window.webContents.canGoForward()) {
                window.webContents.goForward();
            }
        }
    });
    
    menuTemplate.push({ type: 'separator' });
    
    menuTemplate.push({
        label: '💾 Sauvegarder la page',
        click: () => {
            window.webContents.downloadURL(window.webContents.getURL());
        }
    });
    
    menuTemplate.push({
        label: '🖨️ Imprimer',
        click: () => {
            window.webContents.print({});
        }
    });
    
    menuTemplate.push({ type: 'separator' });
    
    // ===== DEVTOOLS COMPLET =====
    menuTemplate.push({
        label: window.webContents.isDevToolsOpened() ? '❌ Fermer les DevTools' : '🔧 Ouvrir les DevTools',
        accelerator: 'Ctrl+Shift+I',
        click: () => {
            if (window.webContents.isDevToolsOpened()) {
                window.webContents.closeDevTools();
            } else {
                window.webContents.openDevTools({ mode: 'detach' });
            }
        }
    });
    
    // ===== AFFICHER LE MENU =====
    try {
        const menu = Menu.buildFromTemplate(menuTemplate);
        menu.popup({ window });
    } catch (err) {
        log("error", `Erreur affichage menu: ${err.message}`);
    }
}

function attachContextMenu(window) {
    if (!window || window.isDestroyed()) return;
    
    // Éviter les doublons
    if (window.__contextMenuAttached) {
        log("debug", `📎 Menu contextuel déjà attaché à "${(window.getTitle() || 'sans titre').substring(0, 40)}"`);
        return;
    }
    window.__contextMenuAttached = true;
    
    log("debug", `📎 Menu contextuel attaché à: "${(window.getTitle() || 'sans titre').substring(0, 40)}"`);
    
    // === Événement natif Electron ===
    window.webContents.on('context-menu', (event, params) => {
        log("debug", `🖱️ Clic droit détecté (${params.x}, ${params.y}) [${params.linkURL || params.pageURL || 'zone'}]`);
        showContextMenu(window, params);
    });
}

// ------------------------------------------------------------------
// DOSSIERS LOCKS & WAIT
// ------------------------------------------------------------------
const LOCKS_DIR = path.join(__dirname, '..', '..', 'locks');
const WAIT_DIR = path.join(__dirname, '..', '..', 'wait');

if (!fs.existsSync(LOCKS_DIR)) {
    try {
        fs.mkdirSync(LOCKS_DIR, { recursive: true });
        log("info", `Dossier locks créé : ${LOCKS_DIR}`);
    } catch (err) {
        log("error", `Impossible de créer dossier locks : ${err.message}`);
    }
}

if (!fs.existsSync(WAIT_DIR)) {
    try {
        fs.mkdirSync(WAIT_DIR, { recursive: true });
        log("info", `Dossier wait créé : ${WAIT_DIR}`);
    } catch (err) {
        log("error", `Impossible de créer dossier wait : ${err.message}`);
    }
}

// ------------------------------------------------------------------
// VERROU GLOBAL PAR VIDÉO
// ------------------------------------------------------------------
function getVideoLockPath(videoId) {
    if (!videoId) return null;
    return path.join(LOCKS_DIR, `ytlock-${videoId}.lock`);
}

function acquireVideoLock(videoId) {
    if (!videoId) return true;
    const lockPath = getVideoLockPath(videoId);
    try {
        fs.openSync(lockPath, 'wx');
        return true;
    } catch (err) {
        if (err.code === 'EEXIST') {
            log("youtube", `Vidéo ${videoId} déjà verrouillée → SKIP`);
            return false;
        }
        log("error", `Erreur verrou ${videoId} : ${err.message}`);
        return false;
    }
}

function releaseVideoLock(videoId) {
    if (!videoId) return;
    const lockPath = getVideoLockPath(videoId);
    try {
        if (fs.existsSync(lockPath)) {
            fs.unlinkSync(lockPath);
            log("youtube", `Verrou LIBÉRÉ pour vidéo ${videoId}`);
        }
    } catch (err) {
        log("warning", `Impossible de supprimer verrou ${videoId} : ${err.message}`);
    }
}

// ------------------------------------------------------------------
// LIMITATION NOMBRE D'INSTANCES ACTIVES + FILE D'ATTENTE
// ------------------------------------------------------------------
const NOMBRE_FILE = path.join(LOCKS_DIR, 'nombre.txt');
const ACTIVE_PREFIX = 'active-';
const WAITING_PREFIX = 'waiting-';

let myActiveLockFile = null;
let myWaitingFile = null;
let hasActivePermission = false;

async function readMaxActiveCount() {
    try {
        const content = await fsPromises.readFile(NOMBRE_FILE, 'utf8');
        const num = parseInt(content.trim(), 10);
        if (isNaN(num) || num < 1) return 999;
        return num;
    } catch (err) {
        if (err.code === 'ENOENT') {
            log("warning", `nombre.txt introuvable → toutes les instances peuvent travailler`);
            return 999;
        }
        log("error", `Lecture nombre.txt échouée : ${err.message}`);
        return 999;
    }
}

async function countActiveInstances() {
    try {
        const files = await fsPromises.readdir(LOCKS_DIR);
        return files.filter(f => f.startsWith(ACTIVE_PREFIX) && f.endsWith('.lock')).length;
    } catch (err) {
        log("error", `Comptage active locks échoué : ${err.message}`);
        return 0;
    }
}

async function getSortedWaitingFiles() {
    try {
        const files = await fsPromises.readdir(WAIT_DIR);
        const waitingFiles = files
            .filter(f => f.startsWith(WAITING_PREFIX) && f.endsWith('.lock'))
            .map(f => {
                const match = f.match(/waiting-(\d+)-([a-z0-9]+)\.lock/);
                const timestamp = match && match[1] ? parseInt(match[1], 10) : Infinity;
                return { filename: f, timestamp };
            })
            .filter(item => Number.isFinite(item.timestamp))
            .sort((a, b) => a.timestamp - b.timestamp);
        return waitingFiles;
    } catch (err) {
        log("error", `Erreur lecture waiting files: ${err.message}`);
        return [];
    }
}

async function tryTakeActiveSlot() {
    if (hasActivePermission && myActiveLockFile) {
        try {
            await fsPromises.access(path.join(LOCKS_DIR, myActiveLockFile));
            return true;
        } catch {
            log("warning", `Notre lock ${myActiveLockFile} a disparu → on retente`);
            hasActivePermission = false;
            myActiveLockFile = null;
        }
    }
    const maxAllowed = await readMaxActiveCount();
    const currentActive = await countActiveInstances();
    if (currentActive >= maxAllowed && !myWaitingFile) {
        log("info", `Limite d'instances actives atteinte (max=${maxAllowed}) → attente`);
    }
    if (currentActive < maxAllowed) {
        const waitingList = await getSortedWaitingFiles();
        const isFirstInLine = waitingList.length === 0 || (myWaitingFile && waitingList[0].filename === myWaitingFile);
        if (isFirstInLine) {
            for (let attempt = 0; attempt < 3; attempt++) {
                const rand = Math.random().toString(36).substring(2, 9);
                const filename = `${ACTIVE_PREFIX}${rand}.lock`;
                const fullPath = path.join(LOCKS_DIR, filename);
                try {
                    await fsPromises.writeFile(fullPath, String(process.pid), { flag: 'wx' });
                    const oldWaitingFile = myWaitingFile;
                    myActiveLockFile = filename;
                    hasActivePermission = true;

                    log("success", `→ Slot ACTIF obtenu : ${filename} (${currentActive + 1}/${maxAllowed})${oldWaitingFile ? ` (Supprimer :${oldWaitingFile})` : ''}`);
                    if (myWaitingFile) {
                        try { await fsPromises.unlink(path.join(WAIT_DIR, myWaitingFile)); } catch {}
                        myWaitingFile = null;
                    }
                    return true;
                } catch (err) {
                    if (err.code !== 'EEXIST') {
                        log("error", `Erreur création slot actif : ${err.message}`);
                    }
                }
            }
        }
    }
    if (!myWaitingFile) {
        const timestampMs = Date.now();
        const rand = Math.random().toString(36).substring(2, 8);
        const filename = `${WAITING_PREFIX}${timestampMs}-${rand}.lock`;
        const fullPath = path.join(WAIT_DIR, filename);
        try {
            await fsPromises.writeFile(fullPath, String(process.pid), { flag: 'wx' });
            myWaitingFile = filename;
            log("info", `→ Inscrit en attente : ${filename}`);
        } catch (err) {
            log("warning", `Échec création fichier attente : ${err.message}`);
        }
    }
    return false;
}

function releaseActiveSlot() {
    if (!myActiveLockFile) return;
    const pathToDelete = path.join(LOCKS_DIR, myActiveLockFile);
    try {
        if (fs.existsSync(pathToDelete)) {
            fs.unlinkSync(pathToDelete);
            log("info", `Suppression du fichier slot actif : ${myActiveLockFile}`);
        }
    } catch (err) {
        log("warning", `Impossible de supprimer ${myActiveLockFile} : ${err.message}`);
    }
    myActiveLockFile = null;
    hasActivePermission = false;
}

// Nettoyage locks & waiting orphelins au démarrage
try {
    const lockFiles = fs.readdirSync(LOCKS_DIR).filter(f => f.endsWith('.lock'));
    for (const file of lockFiles) {
        const filePath = path.join(LOCKS_DIR, file);
        const stats = fs.statSync(filePath);
        const ageMin = (Date.now() - stats.mtimeMs) / 1000 / 60;
        if (ageMin > 45) {
            fs.unlinkSync(filePath);
            log("info", `Lock orphelin supprimé (locks) : ${file} (${Math.round(ageMin)} min)`);
        }
    }
    const waitFiles = fs.readdirSync(WAIT_DIR).filter(f => f.endsWith('.lock'));
    for (const file of waitFiles) {
        const filePath = path.join(WAIT_DIR, file);
        const stats = fs.statSync(filePath);
        const ageMin = (Date.now() - stats.mtimeMs) / 1000 / 60;
        if (ageMin > 45) {
            fs.unlinkSync(filePath);
            log("info", `Waiting orphelin supprimé (wait) : ${file} (${Math.round(ageMin)} min)`);
        }
    }
} catch (err) {
    log("warning", `Nettoyage locks/wait au démarrage échoué : ${err.message}`);
}

// ------------------------------------------------------------------
// UTILITAIRES
// ------------------------------------------------------------------
function getRandomDelay(min, max) {
    return Math.floor(Math.random() * (max - min + 1) + min);
}

// ============================================================================
// EXTRACTION AMÉLIORÉE DU VIDEO ID
// ============================================================================
function extractVideoId(url) {
    if (!url) return null;
    
    try {
        const u = new URL(url);
        
        if (u.hostname.includes('aviso.bz') && u.searchParams.has('go_url')) {
            const goUrl = u.searchParams.get('go_url');
            if (goUrl) {
                return extractVideoId(goUrl);
            }
        }
        
        if (u.hostname.includes('youtube.com')) {
            return u.searchParams.get('v');
        }
        
        if (u.hostname === 'youtu.be') {
            return u.pathname.replace(/^\/+/, '').split(/[?#]/)[0];
        }
        
        if (u.hostname.includes('youtube.com') && u.pathname.includes('/embed/')) {
            const match = u.pathname.match(/\/embed\/([^/?]+)/);
            if (match && match[1]) return match[1];
        }
        
        if (u.hostname.includes('youtube.com') && u.pathname.includes('/v/')) {
            const match = u.pathname.match(/\/v\/([^/?]+)/);
            if (match && match[1]) return match[1];
        }
        
        if (u.hostname.includes('google.com') && u.searchParams.has('url')) {
            const goUrl = u.searchParams.get('url');
            if (goUrl) {
                return extractVideoId(goUrl);
            }
        }
    } catch (err) {
        // URL invalide
    }
    
    const regexPatterns = [
        /(?:v=|v\/|vi=|vi\/|youtu\.be\/|embed\/|user\/[^\/]+\/)([a-zA-Z0-9_-]{11})/,
        /([a-zA-Z0-9_-]{11})(?:\?|&|$)/
    ];
    
    for (const pattern of regexPatterns) {
        const match = url.match(pattern);
        if (match && match[1] && match[1].length === 11) {
            return match[1];
        }
    }
    
    return null;
}

// ============================================================================
// NETTOYAGE D'URL POUR OBTENIR L'URL YOUTUBE RÉELLE
// ============================================================================
function cleanYoutubeUrl(url) {
    if (!url) return null;
    
    try {
        if (url.includes('aviso.bz/go/') && url.includes('go_url=')) {
            const params = new URL(url).searchParams;
            const goUrl = params.get('go_url');
            if (goUrl && (goUrl.includes('youtube.com') || goUrl.includes('youtu.be'))) {
                return goUrl;
            }
        }
        
        if (url.includes('google.com/url') && url.includes('url=')) {
            const params = new URL(url).searchParams;
            const goUrl = params.get('url');
            if (goUrl && (goUrl.includes('youtube.com') || goUrl.includes('youtu.be'))) {
                return goUrl;
            }
        }
        
        if (url.includes('youtube.com') || url.includes('youtu.be')) {
            return url;
        }
    } catch (err) {
        // Erreur silencieuse
    }
    
    return url;
}

function formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return "0:00";
    const min = Math.floor(seconds / 60);
    const sec = Math.floor(seconds % 60).toString().padStart(2, '0');
    return `${min}:${sec}`;
}

// ------------------------------------------------------------------
// MISE À L'ÉCHELLE AUTOMATIQUE DU CONTENU DES FENÊTRES
// ------------------------------------------------------------------
// Quand une fenêtre est réduite, son contenu est zoomé proportionnellement.
let youtubeZoomUpdateTimeout = null;
let mainZoomUpdateTimeout = null;

function updateWindowZoom(window, referenceWidth, referenceHeight, label) {
    if (!window || window.isDestroyed() || !window.webContents) return;

    try {
        const [contentWidth, contentHeight] = window.getContentSize();
        if (!contentWidth || !contentHeight) return;

        const widthScale = contentWidth / referenceWidth;
        const heightScale = contentHeight / referenceHeight;

        // Le plus petit facteur adapte le contenu aux deux dimensions.
        const zoomFactor = Math.max(
            0.35,
            Math.min(1, widthScale, heightScale)
        );

        window.webContents.setZoomFactor(zoomFactor);
        log("debug", `Zoom ${label} automatique : ${Math.round(zoomFactor * 100)} % (${contentWidth}x${contentHeight})`);
    } catch (err) {
        log("warning", `Impossible d'appliquer le zoom ${label} : ${err.message}`);
    }
}

function updateYoutubeZoom(window) {
    updateWindowZoom(window, 1280, 720, "YouTube");
}

function updateMainWindowZoom(window) {
    updateWindowZoom(window, 1200, 800, "principal");
}

function scheduleYoutubeZoomUpdate(window) {
    if (youtubeZoomUpdateTimeout) clearTimeout(youtubeZoomUpdateTimeout);

    youtubeZoomUpdateTimeout = setTimeout(() => {
        youtubeZoomUpdateTimeout = null;
        updateYoutubeZoom(window);
    }, 100);
}

function scheduleMainWindowZoomUpdate(window) {
    if (mainZoomUpdateTimeout) clearTimeout(mainZoomUpdateTimeout);

    mainZoomUpdateTimeout = setTimeout(() => {
        mainZoomUpdateTimeout = null;
        updateMainWindowZoom(window);
    }, 100);
}

// ------------------------------------------------------------------
// CAPTURE YOUTUBE EN RÉSOLUTION NORMALE (CTRL+D)
// ------------------------------------------------------------------
let youtubeCaptureInProgress = false;

async function captureYoutubeAtFullResolution() {
    if (youtubeCaptureInProgress) {
        log("warning", "Une capture est déjà en cours");
        return;
    }

    if (!youtubeDirectWindow || youtubeDirectWindow.isDestroyed()) {
        log("warning", "Aucune fenêtre YouTube disponible pour la capture");
        return;
    }

    youtubeCaptureInProgress = true;
    try {
        // Utiliser exclusivement la fenêtre actuellement affichée :
        // aucune seconde fenêtre et aucun rechargement de YouTube.
        const captureContents = youtubeDirectWindow.webContents;
        const nativeWidth = 1920;
        const nativeHeight = 1080;
        const originalZoom = captureContents.getZoomFactor() || 1;

        const timestamp = new Date().toISOString()
            .replace(/[:.]/g, '-')
            .replace('T', '_')
            .replace('Z', '');
        const outputPath = path.join(__dirname, `capture-youtube-${timestamp}.png`);
        const debuggerInstance = captureContents.debugger;
        let debuggerAttached = false;
        let metricsOverridden = false;

        try {
            debuggerInstance.attach('1.3');
            debuggerAttached = true;
            await debuggerInstance.sendCommand('Page.enable');

            // La fenêtre peut être affichée à 47 %, mais la capture est
            // rendue sur une surface virtuelle fixe, comme un écran 1920x1080.
            // La taille physique de la fenêtre n'influence donc plus le PNG.
            captureContents.setZoomFactor(1);
            await debuggerInstance.sendCommand('Emulation.setDeviceMetricsOverride', {
                width: nativeWidth,
                height: nativeHeight,
                deviceScaleFactor: 1,
                mobile: false,
                scale: 1
            });
            metricsOverridden = true;

            const layoutMetrics = await debuggerInstance.sendCommand('Page.getLayoutMetrics');
            const contentSize = layoutMetrics.cssContentSize || layoutMetrics.contentSize;
            const pageWidth = Math.max(nativeWidth, Math.ceil(contentSize.width));
            const pageHeight = Math.max(nativeHeight, Math.ceil(contentSize.height));

            // PNG sans perte, directement depuis le rendu de la fenêtre visible.
            const screenshot = await debuggerInstance.sendCommand('Page.captureScreenshot', {
                format: 'png',
                fromSurface: true,
                captureBeyondViewport: true,
                clip: {
                    x: 0,
                    y: 0,
                    width: pageWidth,
                    height: pageHeight,
                    scale: 1
                }
            });

            await fsPromises.writeFile(outputPath, Buffer.from(screenshot.data, 'base64'));
            log("success", `Capture native enregistrée : ${outputPath} (${pageWidth}x${pageHeight})`);
        } finally {
            if (metricsOverridden) {
                try { await debuggerInstance.sendCommand('Emulation.clearDeviceMetricsOverride'); } catch {}
            }
            try { captureContents.setZoomFactor(originalZoom); } catch {}
            if (debuggerAttached) {
                try { debuggerInstance.detach(); } catch {}
            }
        }
    } catch (err) {
        log("error", `Échec de la capture YouTube : ${err.message}`);
    } finally {
        youtubeCaptureInProgress = false;
    }
}

// ------------------------------------------------------------------
// VARIABLES GLOBALES
// ------------------------------------------------------------------
let mainWindow;
let youtubeWindow;
let youtubeDirectWindow;
let successCount = 0;
let automationPaused = false;
let captchaDetected = false;
let captchaDetectionInterval = null;
let savedYouTubeConfig = null;
let savedMainConfig = null;
let currentProxy = null;
let youtubeWindowCreated = false;
let lastTaskClickTime = 0;
let checkSecondaryWindowsTimeout = null;
let delayAfterSuspiciousWindowClose = false;
let aProxies = [];
let bProxies = [];
let currentProxyIndex = 0;
let consecutiveEmptyReloads = 0;
let currentTaskTargetUrl = null;
let lastLoggedUrl = null;
let waitingForVideoUnlock = null;
let waitingUnlockInterval = null;
let waitingStartTime = 0;
let currentMonitoredTaskId = null;
let currentTaskRequiredTime = 0;
let youtubeVideoMonitorInterval = null;
let youtubeVideoStartTime = 0;
let youtubeVideoFullyWatched = false;
let isNewYoutubeWindowOpen = false;
let taskJustClicked = false;
let handleVideoWatchedEnoughCalled = false;
let waitDelayAfterWatch = 10;
let youtubeForceCloseTimeout = null;
let isResolvingCaptcha = false;
let rewardClaimedWhileWatching = false;
let automationRunning = false;
let taskClickInProgress = false;
let isReCaptchaMode = false;
let taskProcessInProgress = false;

// ------------------------------------------------------------------
// PROFIL AUTOMATIQUE
// ------------------------------------------------------------------
const currentFolderName = path.basename(__dirname);
let instanceName = currentFolderName;
if (!instanceName || instanceName === 'ELECTRON' || instanceName === 'aviso-automation') {
    instanceName = 'default-profile';
}
const baseUserData = app.getPath('userData');
const customUserData = path.join(baseUserData, `aviso-${instanceName}`);
app.setPath('userData', customUserData);
log("info", `Dossier userData utilisé : ${customUserData}`);

// ------------------------------------------------------------------
// Modes visibilité + mode 5 (YouTube seul)
// ------------------------------------------------------------------
const modeArg = process.argv[2] || '1';
const mode = parseInt(modeArg, 10);
let mainShow = true;
let youtubeShow = true;
let onlyYoutubeMode = false;
if (mode === 1) { mainShow = true; youtubeShow = true; }
else if (mode === 2) { mainShow = false; youtubeShow = false; }
else if (mode === 3) { mainShow = false; youtubeShow = true; }
else if (mode === 4) { mainShow = true; youtubeShow = false; }
else if (mode === 5) {
    onlyYoutubeMode = true;
    mainShow = false;
    youtubeShow = true;
}

// ------------------------------------------------------------------
// Constantes
// ------------------------------------------------------------------
const COOKIES_PATH = path.join(__dirname, 'cookie.json');
const CONFIG_YT_PATH = path.join(__dirname, 'window-youtube.json');
const CONFIG_MAIN_PATH = path.join(__dirname, 'window-main.json');
const AUDIO_PATH = path.join(__dirname, 'captcha.mp3');
const TARGET_URL = 'https://aviso.bz/tasks-youtube';
const PROXY_PATH = path.join(__dirname, 'proxy.txt');
const DELAY_PATH = path.join(__dirname, 'time.txt');
const YOUTUBE_HOME = 'https://www.youtube.com/';
const MAX_TIME_IN_YOUTUBE = 180000; // 3 minutes

// ------------------------------------------------------------------
// Diamant état
// ------------------------------------------------------------------
function getDiamondForState() {
    if (automationPaused && isReCaptchaMode) return '🔴';
    if (automationPaused) return '💛';
    if (captchaDetected) return '🔴';
    return '🔷';
}

// ------------------------------------------------------------------
// Menu dynamique
// ------------------------------------------------------------------
function updateMenu() {
    const profileName = instanceName;
    const diamond = getDiamondForState();
    let stateText = '';
    if (automationPaused && isReCaptchaMode) stateText = ' [reCAPTCHA]';
    else if (automationPaused) stateText = ' [PAUSE]';
    else if (captchaDetected) stateText = ' [CAPTCHA]';
    else stateText = ' [ACTIF]';

    const template = [
        {
            label: `${diamond} ${profileName} ${diamond}${stateText}`,
            enabled: false,
        },
        {
            label: `IP principale: ${currentProxy ? currentProxy.ip : 'Direct'}`,
            enabled: false,
        },
        {
            label: `IP YouTube: ${bProxies.length > 0 ? bProxies[0].ip : 'Direct'}`,
            enabled: false,
        },
        { type: 'separator' },
        {
            label: 'File',
            submenu: [
                { role: 'quit', label: 'Quitter' }
            ]
        },
        {
            label: 'Fenêtres',
            submenu: [
                {
                    label: 'Sauvegarder position + taille YouTube (Ctrl+S)',
                    accelerator: 'Ctrl+S',
                    click: saveYouTubeWindowConfig
                },
                {
                    label: 'Sauvegarder position + taille Aviso principal (Ctrl+Shift+S)',
                    accelerator: 'Ctrl+Shift+S',
                    click: saveMainWindowConfig
                },
                { type: 'separator' },
                {
                    label: 'Supprimer configuration YouTube',
                    click: async () => {
                        try {
                            await fsPromises.unlink(CONFIG_YT_PATH);
                            savedYouTubeConfig = null;
                            log("config", "Configuration YouTube supprimée");
                        } catch (err) {
                            log("warning", "Pas de config YouTube à supprimer");
                        }
                    }
                },
                {
                    label: 'Supprimer configuration Aviso principal',
                    click: async () => {
                        try {
                            await fsPromises.unlink(CONFIG_MAIN_PATH);
                            savedMainConfig = null;
                            log("config", "Configuration principale supprimée");
                        } catch (err) {
                            log("warning", "Pas de config principale à supprimer");
                        }
                    }
                }
            ]
        },
        {
            label: 'Automation',
            submenu: [
                {
                    label: 'Ouvrir DevTools (Ctrl+I)',
                    accelerator: 'Ctrl+I',
                    click: () => {
                        const focusedWindow = BrowserWindow.getFocusedWindow();
                        if (focusedWindow && !focusedWindow.isDestroyed()) {
                            if (focusedWindow.webContents.isDevToolsOpened()) {
                                focusedWindow.webContents.closeDevTools();
                                log("debug", "DevTools fermés");
                            } else {
                                focusedWindow.webContents.openDevTools({ mode: 'detach' });
                                log("debug", `DevTools ouverts (${(focusedWindow.getTitle() || 'fenêtre').substring(0, 50)})`);
                            }
                        } else {
                            if (mainWindow && !mainWindow.isDestroyed()) {
                                if (mainWindow.webContents.isDevToolsOpened()) {
                                    mainWindow.webContents.closeDevTools();
                                    log("debug", "DevTools fermés (fenêtre principale)");
                                } else {
                                    mainWindow.webContents.openDevTools({ mode: 'detach' });
                                    log("debug", "DevTools ouverts (fenêtre principale)");
                                }
                            }
                        }
                    }
                },
                {
                    label: 'Capturer YouTube en 1280x720 (Ctrl+D)',
                    accelerator: 'Ctrl+D',
                    click: captureYoutubeAtFullResolution
                },
                {
                    label: 'Changer de Proxy (Manuellement)',
                    accelerator: 'Ctrl+P',
                    click: rotateProxy
                },
                {
                    label: 'Afficher + Sauvegarder cookies Aviso (Ctrl+K)',
                    accelerator: 'Ctrl+K',
                    click: logAndSaveAvisoCookies
                },
                { type: 'separator' },
                {
                    label: 'Pause / Reprendre',
                    accelerator: 'Ctrl+Space',
                    click: () => {
                        if (automationPaused) {
                            automationPaused = false;
                            isReCaptchaMode = false;
                            captchaDetected = false;
                            resetAllBlockingFlags();
                            
                            resetYoutubeTimeout();
                            
                            if (youtubeWindow && !youtubeWindow.isDestroyed() && !captchaDetectionInterval) {
                                captchaDetectionInterval = setInterval(() => {
                                    if (!youtubeWindow || youtubeWindow.isDestroyed() || automationPaused || captchaDetected || isResolvingCaptcha) return;
                                    checkAndHandleCaptcha(youtubeWindow);
                                }, 5000);
                                log("info", "Intervalle CAPTCHA relancé (Ctrl+Space)");
                            }
                            log("success", "REPRISE via Ctrl+Space");
                            updateMenu();
                            startAutomation();
                        } else {
                            automationPaused = true;
                            if (youtubeWindow && !youtubeWindow.isDestroyed()) {
                                stopCaptchaSound(youtubeWindow);
                                youtubeWindow.flashFrame(false);
                                youtubeWindow.setOpacity(1.0);
                            }
                            if (captchaDetectionInterval) {
                                clearInterval(captchaDetectionInterval);
                                captchaDetectionInterval = null;
                                log("info", "Intervalle CAPTCHA arrêté (Ctrl+Space)");
                            }
                            stopYoutubeVideoMonitor();
                            log("warning", "PAUSE via Ctrl+Space");
                            updateMenu();
                        }
                    }
                }
            ]
        }
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ------------------------------------------------------------------
// Proxy & Rotation
// ------------------------------------------------------------------
async function loadProxyConfig() {
    try {
        aProxies = [];
        bProxies = [];
        if (!fs.existsSync(PROXY_PATH)) {
            log("warning", "proxy.txt introuvable → IP directe");
            await session.defaultSession.setProxy({ proxyRules: 'direct://' });
            updateMenu();
            return;
        }
        const content = await fsPromises.readFile(PROXY_PATH, 'utf8');
        const lines = content.split('\n')
            .map(l => l.trim())
            .filter(l => l.length > 0 && !l.startsWith('#') && !l.startsWith('//'));
        log("debug", `Lignes proxy.txt lues : ${lines.length}`);
        for (let line of lines) {
            let type = 'A';
            let cleaned = line;
            if (line.toUpperCase().startsWith('B-')) {
                type = 'B';
                cleaned = line.substring(2).trim();
            } else if (line.toUpperCase().startsWith('A-')) {
                cleaned = line.substring(2).trim();
            }
            let proxyObj = null;
            const parts = cleaned.split(':');
            if (parts.length === 4) {
                proxyObj = {
                    ip: parts[0].trim(),
                    port: parseInt(parts[1], 10),
                    username: parts[2].trim(),
                    password: parts[3].trim(),
                    fullLine: line,
                    type
                };
            } else if (cleaned.includes('@')) {
                const [auth, host] = cleaned.split('@');
                const [username, password] = auth.split(':');
                const [ip, portStr] = host.split(':');
                proxyObj = {
                    ip: ip.trim(),
                    port: parseInt(portStr, 10),
                    username: username.trim(),
                    password: password.trim(),
                    fullLine: line,
                    type
                };
            }
            if (proxyObj && !isNaN(proxyObj.port)) {
                if (type === 'B') bProxies.push(proxyObj);
                else aProxies.push(proxyObj);
            } else {
                log("warning", `Ligne proxy ignorée : ${line}`);
            }
        }
        log("proxy", `Chargé : ${aProxies.length} A- | ${bProxies.length} B-`);
        if (bProxies.length > 0) {
            log("proxy", `B-proxy YouTube : ${bProxies[0].ip}:${bProxies[0].port}`);
        }
        if (aProxies.length > 0) {
            await applyProxy(0);
        } else {
            await session.defaultSession.setProxy({ proxyRules: 'direct://' });
        }
        updateMenu();
    } catch (err) {
        log("error", `Erreur proxy.txt : ${err.message}`);
        await session.defaultSession.setProxy({ proxyRules: 'direct://' });
    }
}

async function applyProxy(index) {
    if (aProxies.length === 0) return;
    if (index >= aProxies.length) index = 0;
    currentProxyIndex = index;
    currentProxy = aProxies[index];
    log("proxy", `Proxy A- appliqué : ${currentProxy.ip}:${currentProxy.port}`);
    await session.defaultSession.setProxy({
        proxyRules: `http://${currentProxy.ip}:${currentProxy.port}`,
        proxyBypassRules: 'localhost'
    });
    updateMenu();
}

async function rotateProxy(reloadPage = true) {
    if (aProxies.length <= 1) return;
    currentProxyIndex = (currentProxyIndex + 1) % aProxies.length;
    consecutiveEmptyReloads = 0;
    log("proxy", "Rotation proxy A-...");
    await applyProxy(currentProxyIndex);
    if (reloadPage && mainWindow && !mainWindow.isDestroyed()) {
        delayAfterSuspiciousWindowClose = false;
        mainWindow.reload();
    }
}

// ------------------------------------------------------------------
// Cookies - Affichage + Sauvegarde automatique
// ------------------------------------------------------------------
async function logAndSaveAvisoCookies() {
    try {
        const cookies = await session.defaultSession.cookies.get({});
        
        const avisoCookies = cookies.filter(c => 
            c.domain.includes('aviso.bz') || 
            c.domain.includes('.aviso.bz')
        );

        if (avisoCookies.length === 0) {
            return;
        }

        await fsPromises.writeFile(
            COOKIES_PATH,
            JSON.stringify(avisoCookies, null, 2),
            {
                encoding: 'utf8',
                flag: 'w'
            }
        );

    } catch (err) {
        log("error", `Erreur lors de la lecture/sauvegarde des cookies : ${err.message}`);
    }
}

// ------------------------------------------------------------------
// Cookies - Chargement existant
// ------------------------------------------------------------------
async function saveCookies() {
    try {
        const cookies = await session.defaultSession.cookies.get({});
        await fsPromises.writeFile(COOKIES_PATH, JSON.stringify(cookies, null, 2));
        log("cookie", "Cookies sauvegardés (tous domaines)");
    } catch (err) {
        log("error", `Erreur sauvegarde cookies : ${err.message}`);
    }
}

async function loadCookies() {
    try {
        if (fs.existsSync(COOKIES_PATH)) {
            const content = await fsPromises.readFile(COOKIES_PATH, 'utf8');
            let cookies = JSON.parse(content);
            
            log("cookie", `Chargement de ${cookies.length} cookies...`);
            
            const cookiesByDomain = {};
            
            for (const cookie of cookies) {
                const domain = cookie.domain || '';
                if (!cookiesByDomain[domain]) {
                    cookiesByDomain[domain] = [];
                }
                cookiesByDomain[domain].push(cookie);
            }
            
            for (const [domain, domainCookies] of Object.entries(cookiesByDomain)) {
                domainCookies.sort((a, b) => {
                    if (a.secure && !b.secure) return -1;
                    if (!a.secure && b.secure) return 1;
                    return 0;
                });
                
                for (const cookie of domainCookies) {
                    try {
                        let cleanDomain = domain.replace(/^\./, '');
                        const protocol = cookie.secure ? 'https' : 'http';
                        let url = `${protocol}://${cleanDomain}${cookie.path || '/'}`;
                        const cookieDomain = domain;
                        
                        const cookieOptions = {
                            url: url,
                            name: cookie.name,
                            value: cookie.value,
                            domain: cookieDomain,
                            path: cookie.path || '/',
                            secure: cookie.secure,
                            httpOnly: cookie.httpOnly || false,
                            sameSite: cookie.sameSite || 'unspecified',
                        };
                        
                        if (cookie.expirationDate) {
                            cookieOptions.expirationDate = cookie.expirationDate;
                        } else if (cookie.expires) {
                            cookieOptions.expirationDate = cookie.expires;
                        }
                        
                        if (domain.includes('aviso.bz')) {
                            const secureOptions = { ...cookieOptions, url: `https://${cleanDomain}${cookie.path || '/'}`, secure: true };
                            try {
                                await session.defaultSession.cookies.set(secureOptions);
                                log("debug", `Cookie ${cookie.name} défini avec secure: true`);
                                continue;
                            } catch (err) {
                                // Ignorer l'erreur et essayer avec HTTP
                            }
                        }
                        
                        await session.defaultSession.cookies.set(cookieOptions);
                        log("debug", `Cookie ${cookie.name} défini avec succès (secure: ${cookie.secure})`);
                        
                    } catch (err) {
                        if (err.message && err.message.includes('Secure')) {
                            try {
                                const fallbackOptions = {
                                    url: `http://${cookie.domain.replace(/^\./, '')}${cookie.path || '/'}`,
                                    name: cookie.name,
                                    value: cookie.value,
                                    domain: cookie.domain,
                                    path: cookie.path || '/',
                                    secure: false,
                                    httpOnly: cookie.httpOnly || false,
                                    sameSite: cookie.sameSite || 'unspecified',
                                };
                                
                                if (cookie.expirationDate) {
                                    fallbackOptions.expirationDate = cookie.expirationDate;
                                } else if (cookie.expires) {
                                    fallbackOptions.expirationDate = cookie.expires;
                                }
                                
                                await session.defaultSession.cookies.set(fallbackOptions);
                                log("debug", `Cookie ${cookie.name} défini avec secure: false (fallback)`);
                            } catch (fallbackErr) {
                                log("warning", `Cookie ${cookie.name} impossible à définir: ${fallbackErr.message}`);
                            }
                        } else {
                            log("warning", `Cookie ${cookie.name} échoué: ${err.message}`);
                        }
                    }
                }
            }
            
            log("cookie", "Tous les cookies ont été traités");
        }
    } catch (err) {
        log("error", `Erreur chargement cookies : ${err.message}`);
    }
}
// ------------------------------------------------------------------
// Configurations fenêtres
// ------------------------------------------------------------------
async function loadWindowConfig() {
    try {
        if (fs.existsSync(CONFIG_YT_PATH)) {
            const content = await fsPromises.readFile(CONFIG_YT_PATH, 'utf8');
            savedYouTubeConfig = JSON.parse(content);
        }
        if (fs.existsSync(CONFIG_MAIN_PATH)) {
            const content = await fsPromises.readFile(CONFIG_MAIN_PATH, 'utf8');
            savedMainConfig = JSON.parse(content);
        }
    } catch (err) {
        log("error", `Erreur chargement config : ${err.message}`);
    }
}

async function loadWaitDelay() {
    try {
        if (fs.existsSync(DELAY_PATH)) {
            const content = await fsPromises.readFile(DELAY_PATH, 'utf8');
            const num = parseInt(content.trim(), 10);
            if (!isNaN(num) && num >= 0) {
                waitDelayAfterWatch = num;
                log("config", `Délai après visionnage chargé : ${num}s (depuis time.txt)`);
            } else {
                log("warning", `Valeur invalide dans time.txt → utilisation du délai par défaut (10s)`);
                waitDelayAfterWatch = 10;
            }
        } else {
            log("warning", `time.txt introuvable → utilisation du délai par défaut (10s)`);
            waitDelayAfterWatch = 10;
        }
    } catch (err) {
        log("error", `Erreur lecture time.txt : ${err.message}`);
        waitDelayAfterWatch = 10;
    }
}

async function saveYouTubeWindowConfig() {
    if ((!youtubeWindow || youtubeWindow.isDestroyed()) && (!youtubeDirectWindow || youtubeDirectWindow.isDestroyed())) return;
    try {
        const target = youtubeDirectWindow && !youtubeDirectWindow.isDestroyed() ? youtubeDirectWindow : (youtubeWindow && !youtubeWindow.isDestroyed() ? youtubeWindow : null);
        if (target) {
            const bounds = target.getBounds();
            const config = {
                ...bounds,
                maximized: target.isMaximized()
            };
            await fsPromises.writeFile(CONFIG_YT_PATH, JSON.stringify(config, null, 2));
            savedYouTubeConfig = config;
            log("config", "Position YouTube sauvegardée");
        }
    } catch (err) {
        log("error", `Erreur sauvegarde config YT : ${err.message}`);
    }
}

async function saveMainWindowConfig() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
        const bounds = mainWindow.getBounds();
        const config = {
            ...bounds,
            maximized: mainWindow.isMaximized()
        };
        await fsPromises.writeFile(CONFIG_MAIN_PATH, JSON.stringify(config, null, 2));
        savedMainConfig = config;
        log("config", "Position principale sauvegardée");
    } catch (err) {
        log("error", `Erreur sauvegarde config principale : ${err.message}`);
    }
}

// ------------------------------------------------------------------
// Son CAPTCHA
// ------------------------------------------------------------------
async function playCaptchaSound(window) {
    if (!window || window.isDestroyed()) return;
    await window.webContents.executeJavaScript(`
        (function() {
            if (!window.captchaAudio) {
                window.captchaAudio = new Audio('file://${AUDIO_PATH.replace(/\\/g, '/')}');
                window.captchaAudio.loop = true;
            }
            window.captchaAudio.play().catch(e => console.log('Erreur audio:', e));
        })()
    `).catch(() => {});
}

function stopCaptchaSound(window) {
    if (!window || window.isDestroyed()) return;
    window.webContents.executeJavaScript(`
        if (window.captchaAudio) {
            window.captchaAudio.pause();
            window.captchaAudio.currentTime = 0;
        }
    `).catch(() => {});
}

// ==========================================================================
// RÉSOLUTION CAPTCHA
// ==========================================================================

function enterCaptchaMode(window) {
    log("captcha", "ENTRÉE EN MODE CAPTCHA - Plein écran + alarme");
    captchaDetected = true;
    isInSensitiveState = true;
    
    if (isReCaptchaMode) {
        clearYoutubeForceTimeout();
        log("captcha", `⏸️ Timeout YouTube désactivé en mode reCAPTCHA`);
    }
    
    stopTitleMonitoring();
    stopYoutubeVideoMonitor();
    if (window && !window.isDestroyed()) {
        window.setFullScreen(true);
        window.setAlwaysOnTop(true, 'screen-saver');
        window.focus();
        playCaptchaSound(window);
        window.flashFrame(true);
    }
    updateMenu();
}

function exitCaptchaMode(window) {
    log("captcha", "SORTIE DU MODE CAPTCHA - Retour normal");
    captchaDetected = false;
    isFullScreenFromTitle = false;
    isInSensitiveState = false;
    isResolvingCaptcha = false;
    isReCaptchaMode = false;
    
    resetYoutubeTimeout();
    
    if (window && !window.isDestroyed()) {
        window.setFullScreen(false);
        window.setAlwaysOnTop(false);
        startTitleMonitoring(window);

        if (savedYouTubeConfig) {
            const { x, y, width, height } = savedYouTubeConfig;
            window.setBounds({
                x: Math.round(x),
                y: Math.round(y),
                width: Math.round(width),
                height: Math.round(height)
            });
        }

        stopCaptchaSound(window);
        window.flashFrame(false);
    }
    
    if (!captchaDetectionInterval && window && !window.isDestroyed() && !automationPaused) {
        captchaDetectionInterval = setInterval(() => {
            if (!window || window.isDestroyed() || automationPaused || captchaDetected || isResolvingCaptcha) return;
            checkAndHandleCaptcha(window);
        }, 5000);
        log("debug", "Intervalle CAPTCHA redémarré");
    }
    
    updateMenu();
}

function resetYoutubeTimeout() {
    clearYoutubeForceTimeout();
    if (youtubeDirectWindow && !youtubeDirectWindow.isDestroyed()) {
        youtubeForceCloseTimeout = setTimeout(() => {
            if (isReCaptchaMode) {
                log("captcha", `⏸️ Timeout ignoré - toujours en mode reCAPTCHA`);
                return;
            }
            log("warning", `⚠️ Timeout de 3 minutes dans YouTube → fermeture forcée`);
            if (youtubeDirectWindow && !youtubeDirectWindow.isDestroyed()) {
                youtubeDirectWindow.close();
            }
            if (mainWindow && !mainWindow.isDestroyed()) {
                log("info", "→ Rechargement de la page principale suite au timeout YouTube");
                mainWindow.reload();
            }
        }, MAX_TIME_IN_YOUTUBE);
    }
}

async function checkAndHandleCaptcha(window) {
    if (automationPaused || isResolvingCaptcha || !window || window.isDestroyed()) return false;
    
    try {
        const windowTitle = window.getTitle();
        
        if (windowTitle.includes('youtube.com/watch') || windowTitle.includes('youtu.be/')) {
            if (!automationPaused) {
                log("captcha", `🔴 reCAPTCHA détecté via Titre → PAUSE pour résolution manuelle 🔴`);
                automationPaused = true;
                isReCaptchaMode = true;
                updateMenu();
                
                clearYoutubeForceTimeout();
                log("captcha", `⏸️ Timeout YouTube désactivé pendant la résolution du reCAPTCHA`);
            }
            return true;
        }
        
        const detectorPath = path.join(__dirname, 'captcha_detector_v2.js');
        if (!fs.existsSync(detectorPath)) {
            log("error", "Fichier captcha_detector_v2.js introuvable !");
            return false;
        }

        const detectorScript = fs.readFileSync(detectorPath, 'utf8');
        const captchaStatus = await window.webContents.executeJavaScript(detectorScript, true);

        const currentUrl = window.webContents.getURL();
        
        if (currentUrl.includes('youtube.com/watch') || currentUrl.includes('youtu.be/')) {
            if (captchaDetected || isReCaptchaMode) {
                log("success", `✅ reCAPTCHA résolu (redirection YouTube) → RETOUR NORMAL 🔵`);
                isReCaptchaMode = false;
                captchaDetected = false;
                automationPaused = false;
                resetYoutubeTimeout();
                if (window && !window.isDestroyed()) {
                    window.setFullScreen(false);
                    window.setAlwaysOnTop(false);
                    stopCaptchaSound(window);
                    window.flashFrame(false);
                }
                updateMenu();
                setTimeout(() => {
                    if (!automationPaused && !captchaDetected) {
                        startAutomation();
                    }
                }, 2000);
            }
            return false;
        }

        if (captchaStatus && captchaStatus.detected && !captchaDetected && !isResolvingCaptcha) {
            log("captcha", `${captchaStatus.message} → DÉTECTÉ (type: ${captchaStatus.type || 'inconnu'})`);
            
            captchaDetected = true;
            const deviceName = instanceName;
            const sitekey = captchaStatus.sitekey;
            const url = captchaStatus.url;
            
            if (sitekey) {
                if (captchaStatus.type === 'reCAPTCHA') {
                    log("captcha", `🔴 reCAPTCHA détecté → PAUSE pour résolution manuelle 🔴`);
                    automationPaused = true;
                    isReCaptchaMode = true;
                    clearYoutubeForceTimeout();
                    log("captcha", `⏸️ Timeout YouTube désactivé pendant la résolution du reCAPTCHA`);
                    updateMenu();
                    return true;
                } else if (captchaStatus.type === 'hCaptcha') {
                    isResolvingCaptcha = true;
                    
                    log("captcha", `🟡 Tentative de résolution hCaptcha avec sitekey: ${sitekey.substring(0, 30)}...`);
                    
                    const resolved = await captchaSolver.resolveCaptcha(
                        'hCaptcha', 
                        sitekey, 
                        url, 
                        deviceName, 
                        window
                    );
                    
                    isResolvingCaptcha = false;
                    captchaDetected = false;
                    
                    if (resolved) {
                        log("success", `🟢 hCaptcha résolu avec succès!`);
                        if (window && !window.isDestroyed()) {
                            window.setFullScreen(false);
                            window.setAlwaysOnTop(false);
                            stopCaptchaSound(window);
                            window.flashFrame(false);
                            startTitleMonitoring(window);
                        }
                        updateMenu();
                        return true;
                    } else {
                        log("warning", `🟡 Échec résolution hCaptcha → CONTINUER sans pause`);
                        
                        if (window && !window.isDestroyed()) {
                            window.setFullScreen(false);
                            window.setAlwaysOnTop(false);
                            stopCaptchaSound(window);
                            window.flashFrame(false);
                            startTitleMonitoring(window);
                            window.reload();
                        }
                        updateMenu();
                        
                        setTimeout(() => {
                            if (!automationPaused && !captchaDetected) {
                                startAutomation();
                            }
                        }, 3000);
                        return true;
                    }
                }
            }
            return true;
        }

        return false;
    } catch (err) {
        log("error", `checkAndHandleCaptcha error: ${err.message}`);
        isResolvingCaptcha = false;
        return false;
    }
}

// ------------------------------------------------------------------
// Création fenêtres
// ------------------------------------------------------------------
async function createWindow() {
    await loadWindowConfig();
    await loadCookies();
    if (onlyYoutubeMode) {
        log("info", "Mode 5 → YouTube direct");
        openYoutubeDirect(YOUTUBE_HOME);
        return;
    }
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        show: mainShow,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload_new.js')
        }
    });

    // Réduire ou agrandir la fenêtre principale réduit/agrandit aussi son contenu
    // de manière uniforme, comme pour la fenêtre YouTube du mode 5.
    mainWindow.on('resize', () => {
        scheduleMainWindowZoomUpdate(mainWindow);
    });

    if (savedMainConfig) {
        setTimeout(() => {
            if (mainWindow.isDestroyed()) return;
            try {
                if (savedMainConfig.maximized) {
                    mainWindow.maximize();
                } else {
                    const { x, y, width, height } = savedMainConfig;
                    mainWindow.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) });
                }
            } catch (err) {
                console.error('[CONFIG MAIN] Erreur application :', err.message);
            }
        }, 300);
    }
    mainWindow.loadURL(TARGET_URL);
    attachContextMenu(mainWindow);
    mainWindow.webContents.on('did-finish-load', async () => {
        updateMainWindowZoom(mainWindow);
        attachContextMenu(mainWindow);
        if (freezeReloadTimeout) {
            clearTimeout(freezeReloadTimeout);
            freezeReloadTimeout = null;
        }
        freezeReloadInProgress = false;
        automationRunning = false;
        taskClickInProgress = false;
        taskProcessInProgress = false;
        lastLogTimestamp = Date.now();
        log("info", "Rechargement de page");
        await logAndSaveAvisoCookies();
        if (delayAfterSuspiciousWindowClose) {
            log("warning", "Pause de 10 secondes après détection fermeture fenêtres suspecte...");
            setTimeout(() => {
                delayAfterSuspiciousWindowClose = false;
                log("info", "Fin de pause → reprise de l'automation");
                startAutomation();
            }, 10000);
        } else {
            setTimeout(startAutomation, 8000);
        }
    });
    mainWindow.webContents.setWindowOpenHandler(() => {
        return {
            action: 'allow',
            overrideBrowserWindowOptions: {
                width: 1280,
                height: 720,
                show: false,
                resizable: true,
                minimizable: true,
                maximizable: true,
                webPreferences: {
                    nodeIntegration: false,
                    contextIsolation: true,
                    webSecurity: true,
                    sandbox: true,
                    preload: path.join(__dirname, 'preload_v3_final.js')
                }
            }
        };
    });
    app.on('browser-window-created', (event, window) => {
        const chromeUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
        window.webContents.setUserAgent(chromeUA);
        if (window !== mainWindow) {
            youtubeWindow = window;
            youtubeWindowCreated = true;
            
            attachContextMenu(window);
            
            if (savedYouTubeConfig) {
                try {
                    if (savedYouTubeConfig.maximized) {
                        window.maximize();
                    } else {
                        const { x, y, width, height } = savedYouTubeConfig;
                        window.setBounds({
                            x: Math.round(x),
                            y: Math.round(y),
                            width: Math.round(width),
                            height: Math.round(height)
                        }, false);
                    }
                } catch (err) {
                    log("error", `Erreur application config YT : ${err.message}`);
                    window.center();
                }
            } else {
                window.center();
            }
            if (youtubeShow) window.show();
            window.webContents.on('will-navigate', (e, url) => {
                checkAndLogPotentialYoutubeLink(url, window, "will-navigate");
            });
            window.webContents.on('did-navigate', (e, url) => {
                checkAndLogPotentialYoutubeLink(url, window, "did-navigate");
            });
            window.webContents.on('will-redirect', (e, oldUrl, newUrl, isMainFrame) => {
                if (isMainFrame) {
                    checkAndLogPotentialYoutubeLink(newUrl, window, "will-redirect");
                }
            });
            window.webContents.on('did-redirect', (e, oldUrl, newUrl, isMainFrame) => {
                if (isMainFrame) {
                    checkAndLogPotentialYoutubeLink(newUrl, window, "did-redirect");
                }
            });
            window.webContents.on('did-finish-load', () => {
                attachContextMenu(window);
                startTitleMonitoring(window);
                setTimeout(() => {
                    checkAndHandleCaptcha(window);
                }, 6000);
            });
            if (captchaDetectionInterval) clearInterval(captchaDetectionInterval);
            captchaDetectionInterval = setInterval(() => {
                if (!window || window.isDestroyed() || automationPaused || captchaDetected || isResolvingCaptcha) return;
                checkAndHandleCaptcha(window);
            }, 5000);
            window.on('closed', () => {
                stopTitleMonitoring();
                stopYoutubeVideoMonitor();
                const now = Date.now();
                if (waitingForVideoUnlock) return;
                if (now - lastTaskClickTime < 10000) {
                    if (checkSecondaryWindowsTimeout) clearTimeout(checkSecondaryWindowsTimeout);
                    checkSecondaryWindowsTimeout = setTimeout(() => {
                        const allWindows = BrowserWindow.getAllWindows();
                        if (allWindows.length === 1 && allWindows[0] === mainWindow) {
                            log("warning", "Fenêtres fermées rapidement → Actualisation");
                            if (mainWindow && !mainWindow.isDestroyed()) {
                                delayAfterSuspiciousWindowClose = true;
                                mainWindow.reload();
                            }
                        }
                    }, 1000);
                }
            });
        }
    });
}

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

function closeAllSecondaryWindows() {
    stopYoutubeVideoMonitor();
    clearYoutubeForceTimeout();
    resetAllBlockingFlags();
    const allWindows = BrowserWindow.getAllWindows();
    allWindows.forEach((win) => {
        if (win !== mainWindow && !win.isDestroyed()) {
            win.close();
        }
    });
    youtubeWindow = null;
    youtubeWindowCreated = false;
    if (youtubeDirectWindow && !youtubeDirectWindow.isDestroyed()) {
        youtubeDirectWindow.close();
    }
    youtubeDirectWindow = null;
    currentTaskTargetUrl = null;
    lastLoggedUrl = null;
}

// ------------------------------------------------------------------
// Surveillance du titre de page pour plein écran conditionnel
// ------------------------------------------------------------------
let titleMonitoringInterval = null;
let isFullScreenFromTitle = false;

// ==========================================================================
// CLIC SUR LE BOUTON "Начать просмотр" (youtube_views-channel-link)
// ==========================================================================
async function clickStartWatchingButton(window) {
    if (!window || window.isDestroyed()) return false;
    
    try {
        const result = await window.webContents.executeJavaScript(`
            (async function() {
                const btn = document.getElementById('youtube_views-channel-link');
                
                if (!btn) {
                    const alt = document.querySelector('a.youtube_views-channel-button');
                    if (alt) {
                        return await clickButton(alt);
                    }
                    return { found: false, reason: 'no-button' };
                }
                
                return await clickButton(btn);
                
                async function clickButton(btn) {
                    const rect = btn.getBoundingClientRect();
                    if (rect.width === 0 || rect.height === 0) {
                        return { found: false, reason: 'hidden', tag: btn.tagName };
                    }
                    
                    const href = btn.getAttribute('href') || '';
                    const text = (btn.innerText || btn.textContent || '').trim();
                    
                    const centerX = rect.left + rect.width / 2;
                    const centerY = rect.top + rect.height / 2;
                    
                    btn.dispatchEvent(new MouseEvent('mouseover', {
                        bubbles: true, cancelable: true, clientX: centerX, clientY: centerY
                    }));
                    btn.dispatchEvent(new MouseEvent('mousemove', {
                        bubbles: true, cancelable: true, clientX: centerX, clientY: centerY
                    }));
                    
                    await new Promise(r => setTimeout(r, 100));
                    
                    btn.dispatchEvent(new MouseEvent('mousedown', {
                        bubbles: true, cancelable: true, clientX: centerX, clientY: centerY, button: 0
                    }));
                    
                    await new Promise(r => setTimeout(r, 50));
                    
                    btn.dispatchEvent(new MouseEvent('mouseup', {
                        bubbles: true, cancelable: true, clientX: centerX, clientY: centerY, button: 0
                    }));
                    
                    btn.click();
                    
                    if (typeof PointerEvent !== 'undefined') {
                        btn.dispatchEvent(new PointerEvent('pointerdown', {
                            bubbles: true, cancelable: true,
                            clientX: centerX, clientY: centerY,
                            pointerId: 1, button: 0, buttons: 1, isPrimary: true,
                            pointerType: 'mouse'
                        }));
                        btn.dispatchEvent(new PointerEvent('pointerup', {
                            bubbles: true, cancelable: true,
                            clientX: centerX, clientY: centerY,
                            pointerId: 1, button: 0, buttons: 0, isPrimary: true,
                            pointerType: 'mouse'
                        }));
                    }
                    
                    return {
                        found: true,
                        clicked: true,
                        x: Math.round(centerX),
                        y: Math.round(centerY),
                        href: href,
                        text: text,
                        rectW: Math.round(rect.width),
                        rectH: Math.round(rect.height)
                    };
                }
            })()
        `);
        
        if (result.found && result.clicked) {
            log("success", `🎯 Bouton "Начать просмотр" cliqué (${result.text}) à (${result.x}, ${result.y}) [${result.rectW}x${result.rectH}]`);
            log("debug", `   Href: ${result.href.substring(0, 100)}`);
            return true;
        } else {
            if (result.reason === 'no-button') {
                if (!window.__loggedNoButton) {
                    window.__loggedNoButton = true;
                    log("debug", `   Bouton "Начать просмотр" pas encore présent`);
                }
            } else if (result.reason === 'hidden') {
                log("debug", `   Bouton "Начать просмотр" caché (tag: ${result.tag})`);
            }
            return false;
        }
    } catch (err) {
        log("debug", `   Erreur détection bouton: ${err.message}`);
        return false;
    }
}

function startTitleMonitoring(window) {
    if (titleMonitoringInterval) clearInterval(titleMonitoringInterval);

    let buttonClicked = false;
    let lastTitle = '';

    titleMonitoringInterval = setInterval(async () => {
        if (!window || window.isDestroyed()) {
            if (titleMonitoringInterval) clearInterval(titleMonitoringInterval);
            return;
        }

        try {
            const title = window.getTitle();
            
            if (title && title !== lastTitle) {
                lastTitle = title;
                log("debug", `📄 Titre fenêtre secondaire: "${title.substring(0, 100)}"`);
            }
            
            const shouldBeFullScreen = title.includes('Инструкция к задаче') || title.includes('Просмотр видео');

            if (shouldBeFullScreen) {
                if (!isFullScreenFromTitle && !captchaDetected) {
                    log("info", `Titre détecté: "${title}" → MISE EN PLEIN ÉCRAN`);
                    isFullScreenFromTitle = true;
                    isInSensitiveState = true;
                    window.setFullScreen(true);
                    window.setAlwaysOnTop(true, 'screen-saver');
                    window.focus();
                }
                
                if (!buttonClicked) {
                    const clicked = await clickStartWatchingButton(window);
                    if (clicked) {
                        buttonClicked = true;
                        log("success", `✅ Bouton cliqué → sortie du mode plein écran`);
                        
                        if (window && !window.isDestroyed()) {
                            window.setFullScreen(false);
                            window.setAlwaysOnTop(false);
                        }
                        isFullScreenFromTitle = false;
                        isInSensitiveState = false;
                    }
                }
            } else if (isFullScreenFromTitle && (!shouldBeFullScreen || captchaDetected)) {
                log("info", `Sortie du plein écran (Titre: "${title}", Captcha: ${captchaDetected}) → RETOUR EN MODE NORMAL`);
                isFullScreenFromTitle = false;
                isInSensitiveState = false;
                window.setFullScreen(false);
                window.setAlwaysOnTop(false);
            }
        } catch (err) {
            // Erreur silencieuse
        }
    }, 1000);
}

function stopTitleMonitoring() {
    if (titleMonitoringInterval) {
        clearInterval(titleMonitoringInterval);
        titleMonitoringInterval = null;
        isFullScreenFromTitle = false;
        isInSensitiveState = false;
    }
}

// ==========================================================================
// TIMEOUT FORCÉ YOUTUBE
// ==========================================================================

function clearYoutubeForceTimeout() {
    if (youtubeForceCloseTimeout) {
        clearTimeout(youtubeForceCloseTimeout);
        youtubeForceCloseTimeout = null;
    }
}

// ==========================================================================
// SKIPPER DE PUBS YOUTUBE - AMÉLIORÉ
// ==========================================================================

function injectAdSkipper(window) {
    if (!window || window.isDestroyed()) return;
    
    window.webContents.executeJavaScript(`
        (function() {
            if (window.__adSkipperInstalled) return;
            window.__adSkipperInstalled = true;
            
            let adsSkipped = 0;
            let lastSkipAttempt = 0;
            
            function skipAds() {
                const now = Date.now();
                
                const skipSelectors = [
                    '.ytp-ad-skip-button',
                    '.ytp-ad-skip-button-modern',
                    '.ytp-skip-ad-button',
                    '.ytp-ad-skip-button-text',
                    'button[aria-label*="Skip"]',
                    'button[aria-label*="Ignorer"]',
                    'button[aria-label*="Passer"]',
                    '.ytp-ad-skip-button-container',
                    '.ytp-skip-ad'
                ];
                
                let skipped = false;
                
                for (const selector of skipSelectors) {
                    try {
                        const buttons = document.querySelectorAll(selector);
                        for (const btn of buttons) {
                            if (btn && btn.offsetParent !== null && !btn.disabled) {
                                const rect = btn.getBoundingClientRect();
                                if (rect.width > 0 && rect.height > 0) {
                                    btn.click();
                                    adsSkipped++;
                                    skipped = true;
                                    lastSkipAttempt = now;
                                    break;
                                }
                            }
                        }
                        if (skipped) break;
                    } catch(e) {}
                }
                
                if (!skipped && now - lastSkipAttempt > 2000) {
                    const allButtons = document.querySelectorAll('button, .ytp-ad-skip-button, [role="button"]');
                    for (const btn of allButtons) {
                        if (btn && btn.offsetParent !== null) {
                            const text = btn.innerText || btn.textContent || '';
                            const ariaLabel = btn.getAttribute('aria-label') || '';
                            
                            if (text.includes('Ignorer') || 
                                text.includes('Skip') || 
                                text.includes('Passer') ||
                                ariaLabel.includes('Skip') ||
                                ariaLabel.includes('Ignorer') ||
                                ariaLabel.includes('Passer')) {
                                
                                btn.click();
                                adsSkipped++;
                                skipped = true;
                                lastSkipAttempt = now;
                                break;
                            }
                        }
                    }
                }
                
                return skipped;
            }
            
            setInterval(() => {
                skipAds();
            }, 300);
            
            const adObserver = new MutationObserver((mutations) => {
                for (const mutation of mutations) {
                    if (mutation.addedNodes.length > 0) {
                        for (const node of mutation.addedNodes) {
                            if (node.nodeType === 1) {
                                if (node.classList && (
                                    node.classList.contains('ytp-ad-skip-button') ||
                                    node.classList.contains('ytp-skip-ad-button') ||
                                    node.classList.contains('ytp-ad-skip-button-modern')
                                )) {
                                    skipAds();
                                    break;
                                }
                                const skipBtns = node.querySelectorAll('.ytp-ad-skip-button, .ytp-skip-ad-button, .ytp-ad-skip-button-modern');
                                if (skipBtns.length > 0) {
                                    skipAds();
                                    break;
                                }
                            }
                        }
                    }
                }
                
                const adElement = document.querySelector('.ytp-ad-player-overlay, .video-ads, .ytp-ad-module, .ad-showing');
                if (adElement && adElement.offsetParent !== null) {
                    const video = document.querySelector('video');
                    if (video && !video.muted) {
                        video.muted = true;
                    }
                }
            });
            
            adObserver.observe(document.body, { 
                childList: true, 
                subtree: true,
                attributes: true,
                attributeFilter: ['class', 'style']
            });
            
            const videoObserver = new MutationObserver(() => {
                const video = document.querySelector('video');
                if (video) {
                    const isAdShowing = document.querySelector('.ad-showing');
                    if (isAdShowing) {
                        skipAds();
                        if (!video.muted) {
                            video.muted = true;
                        }
                    }
                }
            });
            
            const videoContainer = document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
            if (videoContainer) {
                videoObserver.observe(videoContainer, {
                    attributes: true,
                    attributeFilter: ['class']
                });
            }
            
            window.__adsSkippedCount = function() { return adsSkipped; };
        })();
    `).catch(() => {});
}

// ==========================================================================
// Moniteur de temps vidéo YouTube
// ==========================================================================

function startYoutubeVideoMonitor(expectedTime) {
    stopYoutubeVideoMonitor();
    
    currentTaskRequiredTime = expectedTime;
    youtubeVideoStartTime = Date.now();
    youtubeVideoFullyWatched = false;
    handleVideoWatchedEnoughCalled = false;
    rewardClaimedWhileWatching = false;
    
    youtubeVideoMonitorInterval = setInterval(async () => {
        if (!youtubeDirectWindow || youtubeDirectWindow.isDestroyed()) {
            stopYoutubeVideoMonitor();
            return;
        }
        
        if (automationPaused || captchaDetected) return;
        
        try {
            const videoData = await youtubeDirectWindow.webContents.executeJavaScript(`
                (function() {
                    const video = document.querySelector('video');
                    const player = document.querySelector('#movie_player');
                    if (!video) return { found: false };
                    
                    const isAd = player && (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting'));
                    
                    return {
                        found: true,
                        current: video.currentTime,
                        duration: video.duration,
                        playing: !video.paused,
                        ended: video.ended,
                        isAd: isAd
                    };
                })()
            `);
            
            if (!videoData || !videoData.found) {
                const waited = Math.round((Date.now() - youtubeVideoStartTime) / 1000);
                if (waited > 60) {
                    handleVideoWatchedEnough();
                }
                return;
            }

            if (videoData.isAd) {
                youtubeVideoStartTime = Date.now();
                if (youtubeDirectWindow && !youtubeDirectWindow.isDestroyed() && !youtubeDirectWindow.isFullScreen()) {
                    youtubeDirectWindow.setFullScreen(true);
                }
                return;
            } else {
                if (youtubeDirectWindow && !youtubeDirectWindow.isDestroyed() && youtubeDirectWindow.isFullScreen()) {
                    youtubeDirectWindow.setFullScreen(false);
                }
            }
            
            let effectiveTime = currentTaskRequiredTime;
            if (videoData.duration > 0 && videoData.duration < currentTaskRequiredTime) {
                effectiveTime = videoData.duration;
            }
            
            if (videoData.current >= effectiveTime && !youtubeVideoFullyWatched) {
                youtubeVideoFullyWatched = true;
                setTimeout(() => {
                    handleVideoWatchedEnough();
                }, 2000);
            }
            
            if (videoData.ended && !youtubeVideoFullyWatched) {
                youtubeVideoFullyWatched = true;
                setTimeout(() => {
                    handleVideoWatchedEnough();
                }, 1500);
            }
            
        } catch (err) {
            // Erreur silencieuse
        }
    }, 1000);
}

function stopYoutubeVideoMonitor() {
    if (youtubeVideoMonitorInterval) {
        clearInterval(youtubeVideoMonitorInterval);
        youtubeVideoMonitorInterval = null;
        youtubeVideoFullyWatched = false;
        currentTaskRequiredTime = 0;
        rewardClaimedWhileWatching = false;
    }
}

async function handleVideoWatchedEnough() {
    if (handleVideoWatchedEnoughCalled) return;
    handleVideoWatchedEnoughCalled = true;
    
    clearYoutubeForceTimeout();
    stopYoutubeVideoMonitor();
    
    const windowToClose = youtubeDirectWindow;
    const videoId = currentTaskTargetUrl ? extractVideoId(currentTaskTargetUrl) : null;
    
    await new Promise(r => setTimeout(r, waitDelayAfterWatch * 1000));
    
    if (windowToClose && !windowToClose.isDestroyed()) {
        windowToClose.close();
    }
    
    if (videoId) {
        releaseVideoLock(videoId);
    }
    
    resetAllBlockingFlags();
    automationRunning = false;
    
    log("task", "→ Passage à la tâche suivante");
    
    setTimeout(() => {
        if (!automationPaused && !captchaDetected && !waitingForVideoUnlock) {
            startAutomation();
        }
    }, getRandomDelay(1500, 3500));
}

// ============================================================================
// Détection + bascule vers YouTube - VERSION CORRIGÉE
// ============================================================================
function checkAndLogPotentialYoutubeLink(url, win, source) {
    if (!url) return;
    
    let finalUrl = cleanYoutubeUrl(url);
    if (!finalUrl) return;
    
    if (!finalUrl.includes('youtube.com/watch') && !finalUrl.includes('youtu.be/')) return;
    if (finalUrl === lastLoggedUrl) return;
    
    currentTaskTargetUrl = finalUrl;
    lastLoggedUrl = finalUrl;
    const videoId = extractVideoId(finalUrl);
    
    if (isReCaptchaMode) {
        log("success", `✅ reCAPTCHA résolu → URL YouTube détectée, sortie du mode CAPTCHA 🔵`);
        isReCaptchaMode = false;
        captchaDetected = false;
        automationPaused = false;
        updateMenu();
        resetYoutubeTimeout();
    }
    
    if (captchaDetected) {
        log("success", `✅ CAPTCHA résolu → URL YouTube détectée, sortie du mode CAPTCHA`);
        exitCaptchaMode(win);
    }
    
    if (captchaDetectionInterval) {
        clearInterval(captchaDetectionInterval);
        captchaDetectionInterval = null;
        log("debug", "Intervalle CAPTCHA arrêté (redirection YouTube)");
    }
    
    log("youtube", `${finalUrl} (ID: ${videoId || 'N/A'})`);
    
    if (youtubeWindow && !youtubeWindow.isDestroyed()) {
        youtubeWindow.close();
        youtubeWindow = null;
    }
    
    if (!videoId && youtubeDirectWindow && !youtubeDirectWindow.isDestroyed()) {
        log("youtube", "Fenêtre YouTube déjà ouverte, pas de videoId extrait");
        return;
    }
    
    attemptOpenYoutubeWithLock(videoId, finalUrl);
}

async function attemptOpenYoutubeWithLock(videoId, youtubeUrl) {
    if (!videoId) {
        openYoutubeDirect(youtubeUrl);
        return;
    }
    if (acquireVideoLock(videoId)) {
        waitingForVideoUnlock = null;
        isInSensitiveState = false;
        if (waitingUnlockInterval) {
            clearInterval(waitingUnlockInterval);
            waitingUnlockInterval = null;
        }
        openYoutubeDirect(youtubeUrl);
        if (currentMonitoredTaskId) {
            setTimeout(() => monitorReward(currentMonitoredTaskId), getRandomDelay(1500, 4000));
        }
        return;
    }
    if (!waitingForVideoUnlock) {
        log("youtube", `Vidéo ${videoId} déjà verrouillée → ENTRÉE MODE ATTENTE DÉDIÉE`);
        waitingForVideoUnlock = videoId;
        waitingStartTime = Date.now();
        isInSensitiveState = true;
        if (waitingUnlockInterval) clearInterval(waitingUnlockInterval);
        waitingUnlockInterval = setInterval(async () => {
            if (!waitingForVideoUnlock) {
                clearInterval(waitingUnlockInterval);
                waitingUnlockInterval = null;
                return;
            }
            if (Date.now() - waitingStartTime > 15 * 60 * 1000) {
                log("warning", `Abandon attente vidéo ${videoId} après 15 min`);
                waitingForVideoUnlock = null;
                isInSensitiveState = false;
                clearInterval(waitingUnlockInterval);
                waitingUnlockInterval = null;
                startAutomation();
                return;
            }
            const jitter = getRandomDelay(0, 3000);
            await new Promise(r => setTimeout(r, jitter));
            if (acquireVideoLock(videoId)) {
                waitingForVideoUnlock = null;
                isInSensitiveState = false;
                clearInterval(waitingUnlockInterval);
                waitingUnlockInterval = null;
                openYoutubeDirect(youtubeUrl);
                if (currentMonitoredTaskId) {
                    setTimeout(() => monitorReward(currentMonitoredTaskId), getRandomDelay(1500, 4000));
                }
            }
        }, 10000);
    }
}

function openYoutubeDirect(youtubeUrl) {
    const videoId = extractVideoId(youtubeUrl);
    if (youtubeDirectWindow && !youtubeDirectWindow.isDestroyed()) {
        youtubeDirectWindow.close();
    }
    stopYoutubeVideoMonitor();
    clearYoutubeForceTimeout();
    resetAllBlockingFlags();
    
    const youtubeSession = session.defaultSession;
    
    youtubeDirectWindow = new BrowserWindow({
        width: 1280,
        height: 720,
        show: youtubeShow,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload_new.js')
        }
    });

    // Réduire ou agrandir la fenêtre réduit/agrandit aussi le contenu
    // YouTube de manière uniforme.
    youtubeDirectWindow.on('resize', () => {
        scheduleYoutubeZoomUpdate(youtubeDirectWindow);
    });
    
    attachContextMenu(youtubeDirectWindow);
    
    isNewYoutubeWindowOpen = true;
    
    if (!isReCaptchaMode) {
        youtubeForceCloseTimeout = setTimeout(() => {
            log("warning", `⚠️ Timeout de 3 minutes dans YouTube → fermeture forcée`);
            if (youtubeDirectWindow && !youtubeDirectWindow.isDestroyed()) {
                youtubeDirectWindow.close();
            }
            if (mainWindow && !mainWindow.isDestroyed()) {
                log("info", "→ Rechargement de la page principale suite au timeout YouTube");
                mainWindow.reload();
            }
        }, MAX_TIME_IN_YOUTUBE);
    } else {
        log("captcha", `⏸️ Mode reCAPTCHA actif → timeout YouTube désactivé`);
    }
    
    if (savedYouTubeConfig) {
        try {
            if (savedYouTubeConfig.maximized) {
                youtubeDirectWindow.maximize();
            } else {
                const { x, y, width, height } = savedYouTubeConfig;
                youtubeDirectWindow.setBounds({
                    x: Math.round(x),
                    y: Math.round(y),
                    width: Math.round(width),
                    height: Math.round(height)
                });
            }
        } catch (err) {
            youtubeDirectWindow.center();
        }
    } else {
        youtubeDirectWindow.center();
    }
    youtubeDirectWindow.loadURL(youtubeUrl);
    
    youtubeDirectWindow.webContents.on('did-finish-load', () => {
        updateYoutubeZoom(youtubeDirectWindow);
        attachContextMenu(youtubeDirectWindow);
        const optimizerPath = path.join(__dirname, 'youtube_optimizer.js');
        if (fs.existsSync(optimizerPath)) {
            const script = fs.readFileSync(optimizerPath, 'utf8');
            youtubeDirectWindow.webContents.executeJavaScript(script).catch(e => log("error", "Erreur injection optimizer: " + e.message));
        }
        
        if (currentTaskRequiredTime > 0) {
            setTimeout(() => {
                startYoutubeVideoMonitor(currentTaskRequiredTime);
            }, 3000);
        }
    });
    
    youtubeDirectWindow.on('closed', () => {
        clearYoutubeForceTimeout();
        stopYoutubeVideoMonitor();
        youtubeDirectWindow = null;
        isNewYoutubeWindowOpen = false;
        rewardClaimedWhileWatching = false;
        if (videoId) releaseVideoLock(videoId);
        if (onlyYoutubeMode) {
            app.quit();
        }
    });
}

// ------------------------------------------------------------------
// Boucle principale automation
// ------------------------------------------------------------------
async function startAutomation() {
    if (automationRunning) return;
    automationRunning = true;
    
    lastLogTimestamp = Date.now();
    if (automationPaused || captchaDetected || delayAfterSuspiciousWindowClose || onlyYoutubeMode || waitingForVideoUnlock || taskJustClicked || isResolvingCaptcha) {
        automationRunning = false;
        return;
    }
    const canRun = await tryTakeActiveSlot();
    if (!canRun) {
        automationRunning = false;
        setTimeout(startAutomation, getRandomDelay(6000, 12000));
        return;
    }
    if (mainWindow && mainWindow.webContents.isLoading()) {
        automationRunning = false;
        return;
    }
    
    if (youtubeDirectWindow && !youtubeDirectWindow.isDestroyed() && isNewYoutubeWindowOpen) {
        automationRunning = false;
        setTimeout(startAutomation, 2000);
        return;
    }
    
    closeAllSecondaryWindows();
    
    try {
        const pendingReward = await mainWindow.webContents.executeJavaScript(`
            (function() {
                const confirmBtns = document.querySelectorAll("span[id^=\\"ads_btn_confirm_\\"]");
                const visibleBtn = Array.from(confirmBtns).find(b => b.offsetParent !== null);
                if (visibleBtn) {
                    const id = visibleBtn.id.replace("ads_btn_confirm_", "");
                    return { found: true, id: id };
                }
                return { found: false };
            })()
        `);
        if (pendingReward.found) {
            automationRunning = false;
            monitorReward(pendingReward.id);
            return;
        }
        youtubeWindowCreated = false;
        
        if (taskClickInProgress) {
            automationRunning = false;
            return;
        }
        taskClickInProgress = true;
        
        const result = await mainWindow.webContents.executeJavaScript(`
            (async () => {
                function extractTime(taskElement) {
                    const id = taskElement.id.replace("link_ads_start_", "");
                    
                    const timerInput = document.getElementById("ads_timer_" + id);
                    if (timerInput && timerInput.value) {
                        const val = parseInt(timerInput.value, 10);
                        if (!isNaN(val) && val > 0) return val;
                    }
                    
                    const onclickAttr = taskElement.getAttribute('onclick');
                    if (onclickAttr) {
                        const match = onclickAttr.match(/, '(\\d+)'/);
                        if (match && match[1]) {
                            const val = parseInt(match[1], 10);
                            if (!isNaN(val) && val > 0) return val;
                        }
                    }
                    
                    try {
                        const row = taskElement.closest('tr');
                        if (row) {
                            const timeSpan = row.querySelector('span.serf-text');
                            if (timeSpan) {
                                const textMatch = timeSpan.innerText.match(/(\\d+)\\s*сек/);
                                if (textMatch && textMatch[1]) {
                                    const val = parseInt(textMatch[1], 10);
                                    if (!isNaN(val) && val > 0) return val;
                                }
                            }
                        }
                    } catch(e) {}
                    
                    return 999;
                }

                const tasks = document.querySelectorAll("span[id^=\\"link_ads_start_\\"]");
                const visibleTasks = Array.from(tasks).filter(t => t.offsetParent !== null);
                
                if (visibleTasks.length === 0) return { action: "wait" };
                
                const tasksWithTime = visibleTasks.map(task => ({
                    element: task,
                    id: task.id.replace("link_ads_start_", ""),
                    time: extractTime(task)
                }));
                
                tasksWithTime.sort((a, b) => a.time - b.time);
                
                const chosen = tasksWithTime[0];
                
                const rect = chosen.element.getBoundingClientRect();
                const x = rect.left + (rect.width / 2) + (Math.random() * 10 - 5);
                const y = rect.top + (rect.height / 2) + (Math.random() * 10 - 5);
                
                const mouseEvent = new MouseEvent('mousemove', {
                    view: window,
                    bubbles: true,
                    cancelable: true,
                    clientX: x,
                    clientY: y
                });
                chosen.element.dispatchEvent(mouseEvent);
                
                await new Promise(r => setTimeout(r, Math.random() * 500 + 200));
                
                chosen.element.click();
                
                return { 
                    action: "clicked", 
                    id: chosen.id,
                    time: chosen.time,
                    totalTasks: tasksWithTime.length
                };
            })()
        `).catch((err) => {
            return { action: "error" };
        });

        if (result.action === 'wait') {
            consecutiveEmptyReloads++;
            if (consecutiveEmptyReloads >= 2) {
                if (hasActivePermission) {
                    releaseActiveSlot();
                    const timestampMs = Date.now();
                    const rand = Math.random().toString(36).substring(2, 8);
                    const filename = `${WAITING_PREFIX}${timestampMs}-${rand}.lock`;
                    const fullPath = path.join(WAIT_DIR, filename);
                    try {
                        await fsPromises.writeFile(fullPath, String(process.pid), { flag: 'wx' });
                        myWaitingFile = filename;
                    } catch (err) {}
                }
                consecutiveEmptyReloads = 0;
                setTimeout(() => {
                    if (!automationPaused && !captchaDetected && !delayAfterSuspiciousWindowClose && !waitingForVideoUnlock) {
                        automationRunning = false;
                        startAutomation();
                    }
                }, getRandomDelay(5000, 10000));
            } else {
                const delay = getRandomDelay(10000, 15000);
                setTimeout(() => {
                    if (mainWindow && !mainWindow.isDestroyed() && !automationPaused && !captchaDetected && !delayAfterSuspiciousWindowClose && !waitingForVideoUnlock) {
                        mainWindow.reload();
                    }
                }, delay);
            }
            automationRunning = false;
            taskClickInProgress = false;
        } else if (result.action === 'clicked') {
            consecutiveEmptyReloads = 0;
            lastTaskClickTime = Date.now();
            currentTaskRequiredTime = result.time;
            taskJustClicked = true;
            rewardClaimedWhileWatching = false;
            
            setTimeout(() => {
                taskJustClicked = false;
                taskClickInProgress = false;
            }, 5000);
            
            log("task", `Clic ${result.id} | ⏱️ ${result.time}s | 📋 ${result.totalTasks} dispo(s)`);
          
            currentTaskTargetUrl = null;
            lastLoggedUrl = null;
            currentMonitoredTaskId = result.id;
            automationRunning = false;
        } else {
            automationRunning = false;
            taskClickInProgress = false;
            if (!automationPaused && !captchaDetected && !delayAfterSuspiciousWindowClose && !waitingForVideoUnlock) {
                const delay = getRandomDelay(2000, 4000);
                setTimeout(startAutomation, delay);
            }
        }
    } catch (err) {
        automationRunning = false;
        taskClickInProgress = false;
        if (!automationPaused && !captchaDetected && !delayAfterSuspiciousWindowClose && !waitingForVideoUnlock) {
            setTimeout(startAutomation, 3000);
        }
    }
}

// ------------------------------------------------------------------
// Surveillance récompense
// ------------------------------------------------------------------
async function monitorReward(taskId) {
    if (automationPaused || delayAfterSuspiciousWindowClose || onlyYoutubeMode) return;

    let attempts = 0;
    const MAX_ATTEMPTS = 120;
    let rewardClaimed = false;
    let successCounted = false;

    const interval = setInterval(async () => {
        lastLogTimestamp = Date.now();

        if (automationPaused || onlyYoutubeMode || delayAfterSuspiciousWindowClose) {
            clearInterval(interval);
            return;
        }

        if (waitingForVideoUnlock) {
            attempts++;
            if (attempts > MAX_ATTEMPTS * 3) {
                clearInterval(interval);
                closeAllSecondaryWindows();
                waitingForVideoUnlock = null;
                isInSensitiveState = false;
                if (!automationPaused) startAutomation();
                return;
            }
            return;
        }

        attempts++;
        if (attempts > MAX_ATTEMPTS) {
            clearInterval(interval);
            closeAllSecondaryWindows();
            if (!automationPaused && !captchaDetected && !delayAfterSuspiciousWindowClose && !waitingForVideoUnlock) {
                startAutomation();
            }
            return;
        }

        try {
            const info = await mainWindow.webContents.executeJavaScript(`
                (function() {
                    const btn = document.getElementById("ads_btn_confirm_${taskId}");
                    const startSpan = document.getElementById("link_ads_start_${taskId}");
                    const bodyText = document.body.innerText.toLowerCase();
                    const isNotFound = startSpan && startSpan.innerText.includes("Площадка не найдена");
                    return {
                        hasBtn: !!(btn && btn.offsetParent !== null),
                        isNotFound: isNotFound,
                        hasSuccess: bodyText.includes("задача выполнена") ||
                                    bodyText.includes("начислено") ||
                                    bodyText.includes("награда") ||
                                    bodyText.includes("успешно")
                    };
                })()
            `);

            if (info.isNotFound) {
                clearInterval(interval);
                closeAllSecondaryWindows();
                if (!automationPaused && !captchaDetected && !delayAfterSuspiciousWindowClose && !waitingForVideoUnlock) startAutomation();
                return;
            }

            if (info.hasBtn && !rewardClaimed) {
                rewardClaimed = true;
                rewardClaimedWhileWatching = true;
                
                await mainWindow.webContents.executeJavaScript(
                    `document.getElementById("ads_btn_confirm_${taskId}").click();`
                );
            }

            if (rewardClaimed && info.hasSuccess && !successCounted) {
                successCounted = true;
                successCount++;
                consecutiveEmptyReloads = 0;
                log("success", `✅ Validée ! Total: ${successCount}`);
                
                clearInterval(interval);
            }
        } catch (err) {
            clearInterval(interval);
            closeAllSecondaryWindows();
            if (!automationPaused && !captchaDetected && !delayAfterSuspiciousWindowClose && !waitingForVideoUnlock) startAutomation();
        }
    }, 2000);
}

app.on('login', (event, webContents, request, authInfo, callback) => {
    if (currentProxy && authInfo.isProxy) {
        callback(currentProxy.username, currentProxy.password);
    }
});

app.on('will-quit', releaseActiveSlot);
app.on('window-all-closed', releaseActiveSlot);

app.whenReady().then(async () => {
    app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
    app.commandLine.appendSwitch('disable-gpu');
    app.commandLine.appendSwitch('no-sandbox');
    app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

    updateMenu();
    await loadProxyConfig();
    await loadWaitDelay();
    await createWindow();

    startInactivityWatcher();
});
