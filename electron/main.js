const { app, BrowserWindow } = require("electron");
const path = require("path");
const { spawn } = require("child_process");

let mainWindow = null;
let pythonProcess = null;
let backendPort = 8765;

const isDev = !app.isPackaged;

function spawnPython() {
  const venvPython = path.join(__dirname, "..", "backend", ".venv", "bin", "python3");
  const projectRoot = path.join(__dirname, "..");

  pythonProcess = spawn(venvPython, ["-m", "backend"], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Python backend did not start within 15s"));
    }, 15000);

    pythonProcess.stdout.on("data", (data) => {
      const line = data.toString().trim();
      console.log(`[Python] ${line}`);

      const match = line.match(/MINDSCOPE_READY:(\d+)/);
      if (match) {
        backendPort = parseInt(match[1], 10);
        clearTimeout(timeout);
        resolve(backendPort);
      }
    });

    pythonProcess.stderr.on("data", (data) => {
      console.error(`[Python] ${data.toString().trim()}`);
    });

    pythonProcess.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    pythonProcess.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        clearTimeout(timeout);
        reject(new Error(`Python exited with code ${code}`));
      }
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "MindScope v2",
    backgroundColor: "#030712", // gray-950
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL("http://127.0.0.1:5173");
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  try {
    console.log("Starting Python backend...");
    await spawnPython();
    console.log(`Backend ready on port ${backendPort}`);
  } catch (err) {
    console.error("Failed to start Python backend:", err.message);
    // Continue anyway — user can see the disconnected state in the UI
  }

  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (mainWindow === null) {
    createWindow();
  }
});

app.on("before-quit", () => {
  if (pythonProcess) {
    console.log("Stopping Python backend...");
    pythonProcess.kill("SIGTERM");
    pythonProcess = null;
  }
});
