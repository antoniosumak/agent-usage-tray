import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("api", {
  onState: (cb: (snapshot: unknown) => void) =>
    ipcRenderer.on("state", (_event, snapshot) => cb(snapshot)),
  refresh: () => ipcRenderer.send("refresh"),
  setSettings: (patch: unknown) => ipcRenderer.send("set-settings", patch),
});
