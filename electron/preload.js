const { contextBridge } = require("electron");

// Expose the backend port to the renderer process
// In production, this could be dynamically set by main.js via IPC
contextBridge.exposeInMainWorld("__MINDSCOPE_PORT__", 8765);
