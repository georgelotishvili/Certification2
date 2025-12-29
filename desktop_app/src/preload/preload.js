const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  maximizeWindow: () => ipcRenderer.send('window-maximize'),
  closeWindow: () => ipcRenderer.send('window-close'),
  isMaximized: () => ipcRenderer.sendSync('window-is-maximized'),
  onMaximize: (callback) => ipcRenderer.on('window-maximized', callback),
  onUnmaximize: (callback) => ipcRenderer.on('window-unmaximized', callback),
  setFullscreen: () => ipcRenderer.send('window-fullscreen'),
  exitFullscreen: () => ipcRenderer.send('window-exit-fullscreen'),
  lockExam: () => ipcRenderer.send('exam-lock'),
  unlockExam: () => ipcRenderer.send('exam-unlock'),
  
  // Screen Recording APIs
  getScreenSources: () => ipcRenderer.invoke('get-screen-sources'),
  saveRecording: (buffer, filename) => ipcRenderer.invoke('save-recording', { buffer, filename }),
  getRecordingsPath: () => ipcRenderer.invoke('get-recordings-path')
});

