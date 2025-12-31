const { app, BrowserWindow, ipcMain, nativeImage, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

// Configure auto-updater logging
autoUpdater.logger = require('electron').app;
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

// Auto-reload in development
if (process.env.NODE_ENV !== 'production') {
  require('electron-reload')(__dirname + '/../..', {
    electron: path.join(__dirname, '../../node_modules', '.bin', 'electron'),
    hardResetMethod: 'exit'
  });
}

let mainWindow;
let isExamLocked = false; // Exam lockdown state

// Set app icon - use ICO file for best Windows compatibility
const iconPath = path.join(__dirname, '..', '..', 'assets', 'graphics', 'logo1-2.ico');
let appIcon = nativeImage.createFromPath(iconPath);

// Fallback to SVG if ICO doesn't work
if (appIcon.isEmpty()) {
  const svgPath = path.join(__dirname, '..', '..', 'assets', 'graphics', 'logo1.svg');
  appIcon = nativeImage.createFromPath(svgPath);
}

// Set icon for macOS dock
if (!appIcon.isEmpty() && process.platform === 'darwin') {
  app.dock.setIcon(appIcon);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    frame: false, // Custom title bar
    backgroundColor: '#ffffff',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', 'preload', 'preload.js')
    },
    icon: appIcon.isEmpty() ? undefined : appIcon
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Open DevTools in development (remove in production)
  // DevTools can be opened manually with F12 or Ctrl+Shift+I
  // Uncomment the line below if you want DevTools to open automatically in development
  // if (process.env.NODE_ENV !== 'production') {
  //   mainWindow.webContents.openDevTools();
  // }

  mainWindow.on('closed', () => {
    mainWindow = null;
    isExamLocked = false; // Reset lockdown state
  });

  // Prevent window close during exam
  mainWindow.on('close', (e) => {
    if (isExamLocked) {
      e.preventDefault();
      console.log('Window close blocked: exam in progress');
    }
  });

  // Block fullscreen exit during exam
  mainWindow.on('leave-full-screen', () => {
    if (isExamLocked) {
      console.log('Fullscreen exit blocked: exam in progress');
      mainWindow.setFullScreen(true); // Force back to fullscreen
    }
  });

  // Send window state changes to renderer
  mainWindow.on('maximize', () => {
    mainWindow.webContents.send('window-maximized');
  });

  mainWindow.on('unmaximize', () => {
    mainWindow.webContents.send('window-unmaximized');
  });
}

// IPC handlers for window controls
ipcMain.on('window-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('window-maximize', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.restore();
    } else {
      mainWindow.maximize();
    }
  }
});

ipcMain.on('window-close', () => {
  if (mainWindow) mainWindow.close();
});

ipcMain.on('window-is-maximized', (event) => {
  event.returnValue = mainWindow ? mainWindow.isMaximized() : false;
});

ipcMain.on('window-fullscreen', () => {
  if (mainWindow) mainWindow.setFullScreen(true);
});

ipcMain.on('window-exit-fullscreen', () => {
  if (mainWindow) mainWindow.setFullScreen(false);
});

// Exam Lockdown IPC handlers
ipcMain.on('exam-lock', () => {
  if (mainWindow) {
    isExamLocked = true;
    console.log('🔒 Exam locked');
    
    // Force fullscreen
    mainWindow.setFullScreen(true);
    
    // Keep window on top
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    
    // Disable minimize
    mainWindow.setMinimizable(false);
    
    // Block DevTools (production)
    if (process.env.NODE_ENV === 'production') {
      mainWindow.webContents.closeDevTools();
    }
  }
});

ipcMain.on('exam-unlock', () => {
  if (mainWindow) {
    isExamLocked = false;
    console.log('🔓 Exam unlocked');
    
    // Restore normal behavior
    mainWindow.setAlwaysOnTop(false);
    mainWindow.setMinimizable(true);
  }
});

// Screen Recording IPC handlers
ipcMain.handle('get-screen-sources', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 0, height: 0 }
    });
    return sources.map(source => ({
      id: source.id,
      name: source.name
    }));
  } catch (error) {
    console.error('Error getting screen sources:', error);
    return [];
  }
});

ipcMain.handle('save-recording', async (event, { buffer, filename }) => {
  try {
    // recordings ფოლდერის შექმნა აპის დირექტორიაში
    const recordingsDir = path.join(__dirname, '..', '..', 'recordings');
    
    if (!fs.existsSync(recordingsDir)) {
      fs.mkdirSync(recordingsDir, { recursive: true });
    }
    
    const filePath = path.join(recordingsDir, filename);
    
    // Buffer-ის შენახვა ფაილად
    const uint8Array = new Uint8Array(buffer);
    fs.writeFileSync(filePath, uint8Array);
    
    console.log('📹 Recording saved:', filePath);
    return { success: true, path: filePath };
  } catch (error) {
    console.error('Error saving recording:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-recordings-path', () => {
  return path.join(__dirname, '..', '..', 'recordings');
});

// ===================== AUTO-UPDATER =====================

// Check for updates
ipcMain.on('check-for-updates', () => {
  autoUpdater.checkForUpdates();
});

// Install update and restart
ipcMain.on('install-update', () => {
  autoUpdater.quitAndInstall(false, true);
});

// Get current app version
ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

// Auto-updater events
autoUpdater.on('checking-for-update', () => {
  console.log('🔍 Checking for updates...');
  if (mainWindow) {
    mainWindow.webContents.send('update-checking');
  }
});

autoUpdater.on('update-available', (info) => {
  console.log('✅ Update available:', info.version);
  if (mainWindow) {
    mainWindow.webContents.send('update-available', {
      version: info.version,
      releaseDate: info.releaseDate
    });
  }
});

autoUpdater.on('update-not-available', (info) => {
  console.log('ℹ️ No update available. Current version:', info.version);
  if (mainWindow) {
    mainWindow.webContents.send('update-not-available', {
      version: info.version
    });
  }
});

autoUpdater.on('download-progress', (progressObj) => {
  console.log(`📥 Download progress: ${Math.round(progressObj.percent)}%`);
  if (mainWindow) {
    mainWindow.webContents.send('update-download-progress', {
      percent: progressObj.percent,
      bytesPerSecond: progressObj.bytesPerSecond,
      transferred: progressObj.transferred,
      total: progressObj.total
    });
  }
});

autoUpdater.on('update-downloaded', (info) => {
  console.log('✅ Update downloaded:', info.version);
  if (mainWindow) {
    mainWindow.webContents.send('update-downloaded', {
      version: info.version,
      releaseDate: info.releaseDate
    });
  }
});

autoUpdater.on('error', (err) => {
  console.error('❌ Update error:', err);
  if (mainWindow) {
    mainWindow.webContents.send('update-error', {
      message: err.message
    });
  }
});

// ===================== APP READY =====================

app.whenReady().then(() => {
  // Set app user model ID for Windows (helps with taskbar icon)
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.gipc.certification-exam');
  }
  
  createWindow();

  // Check for updates after window is ready (production only)
  if (process.env.NODE_ENV !== 'development') {
    setTimeout(() => {
      autoUpdater.checkForUpdates();
    }, 3000); // Wait 3 seconds after app start
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

