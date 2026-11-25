// Processus principal Electron : fenêtre, icône de notification, lancement des jeux, notifications.
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, dialog, Notification, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch { /* module absent en développement */ }

const APP_ID = 'com.timerhub.app';
const asset = (name) => path.join(__dirname, 'assets', name);

let win = null;
let tray = null;
let quitting = false;
let settings = null;

// ---------- Paramètres (stockés dans %APPDATA%\TimerHub\settings.json) ----------
const DEFAULTS = { closeToTray: true, openAtLogin: false };
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch { return { ...DEFAULTS }; }
}
function saveSettings() {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch (e) { console.error(e); }
}
function applyLoginItem() {
  if (!app.isPackaged) return; // en développement on n'enregistre pas electron.exe au démarrage
  app.setLoginItemSettings({ openAtLogin: !!settings.openAtLogin, args: ['--hidden'] });
}

// ---------- Fenêtre ----------
function createWindow(show) {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 420,
    minHeight: 500,
    show: false,
    title: 'TimerHub',
    backgroundColor: '#0b0d12',
    icon: asset('icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0b0d12', symbolColor: '#c9cfdb', height: 56 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // les timers continuent quand la fenêtre est cachée
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'web', 'index.html'));
  if (show) win.once('ready-to-show', () => win.show());

  win.on('close', (e) => {
    if (!quitting && settings.closeToTray) {
      e.preventDefault();
      win.hide();
    }
  });

  // Les liens externes s'ouvrent dans le navigateur par défaut
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:')) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url) || /^steam:\/\//i.test(url)) shell.openExternal(url);
    }
  });
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  const img = nativeImage.createFromPath(asset('tray.png'));
  tray = new Tray(img);
  tray.setToolTip('TimerHub');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Ouvrir TimerHub', click: showWindow },
    { type: 'separator' },
    { label: 'Quitter', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}

// ---------- Mises à jour automatiques (GitHub Releases) ----------
let pendingUpdate = null;
function setupUpdates() {
  if (!app.isPackaged || !autoUpdater) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', (info) => {
    pendingUpdate = info.version;
    if (win) win.webContents.send('update-ready', info.version);
    if (Notification.isSupported()) {
      const n = new Notification({
        title: 'Mise à jour de TimerHub prête',
        body: `La version ${info.version} sera installée au prochain redémarrage de l'app.`,
        icon: asset('icon.png'),
      });
      n.on('click', showWindow);
      n.show();
    }
  });
  autoUpdater.on('error', (e) => console.error('Mise à jour :', e && e.message));
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 10000);
  setInterval(check, 6 * 3600 * 1000);
}

ipcMain.handle('update:get', () => ({ version: app.getVersion(), pending: pendingUpdate, packaged: app.isPackaged }));
ipcMain.handle('update:install', () => {
  if (!pendingUpdate || !autoUpdater) return;
  quitting = true;
  autoUpdater.quitAndInstall(false, true);
});

// ---------- IPC ----------
ipcMain.handle('launch', async (_e, type, target) => {
  try {
    if (type === 'steam') {
      const id = (String(target).match(/\d+/) || [])[0];
      if (!id) throw new Error('ID Steam invalide');
      await shell.openExternal(`steam://rungameid/${id}`);
    } else if (type === 'exe') {
      const file = String(target || '');
      if (!fs.existsSync(file)) throw new Error('Fichier introuvable : ' + file);
      if (/\.exe$/i.test(file)) {
        // Lance l'exe depuis son propre dossier (certains jeux en ont besoin)
        const child = spawn(file, [], { cwd: path.dirname(file), detached: true, stdio: 'ignore' });
        await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('spawn', resolve);
        });
        child.unref();
      } else {
        const err = await shell.openPath(file); // raccourcis .lnk / .url / .bat
        if (err) throw new Error(err);
      }
    } else if (type === 'url') {
      if (!/^https?:\/\//i.test(target)) throw new Error('Adresse invalide');
      await shell.openExternal(target);
    } else {
      throw new Error('Type de lancement inconnu');
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('open-external', async (_e, url) => {
  if (/^https?:\/\//i.test(url)) await shell.openExternal(url);
});

ipcMain.handle('pick-exe', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choisir le programme du jeu',
    properties: ['openFile'],
    filters: [
      { name: 'Programmes et raccourcis', extensions: ['exe', 'lnk', 'url', 'bat'] },
      { name: 'Tous les fichiers', extensions: ['*'] },
    ],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('notify', (_e, title, body) => {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: String(title), body: String(body), icon: asset('icon.png') });
  n.on('click', showWindow);
  n.show();
});

ipcMain.handle('settings:get', () => ({ ...settings, isPackaged: app.isPackaged }));
ipcMain.handle('settings:set', (_e, patch) => {
  for (const k of Object.keys(DEFAULTS)) if (k in patch) settings[k] = !!patch[k];
  saveSettings();
  applyLoginItem();
  return { ...settings, isPackaged: app.isPackaged };
});

// ---------- Démarrage ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(() => {
    app.setAppUserModelId(APP_ID);
    settings = loadSettings();
    applyLoginItem();
    createWindow(!process.argv.includes('--hidden'));
    createTray();
    setupUpdates();
  });
  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => app.quit());
}
