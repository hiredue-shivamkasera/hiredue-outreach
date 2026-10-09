// The only bridge between the editor window and the main process; the renderer has no Node access.

const { contextBridge, ipcRenderer } = require("electron");

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args).then((r) => { if (r && r.error) throw new Error(r.error); return r?.data; });
const on = (channel) => (cb) => { const handler = (_e, data) => cb(data); ipcRenderer.on(channel, handler); return () => ipcRenderer.removeListener(channel, handler); };

contextBridge.exposeInMainWorld("outreach", {
  catalog: call("catalog:list"),
  accounts: { list: call("accounts:list"), create: call("accounts:create"), remove: call("accounts:remove"), login: call("accounts:login"), actions: call("accounts:actions"), rename: call("accounts:rename") },
  workflows: { list: call("workflows:list"), get: call("workflows:get"), save: call("workflows:save"), remove: call("workflows:remove"), validate: call("workflows:validate"), setActive: call("workflows:setActive"), triggers: call("workflows:triggers"), onTriggersChanged: on("triggers:changed") },
  runs: { start: call("runs:start"), stop: call("runs:stop"), list: call("runs:list"), get: call("runs:get"), history: call("runs:history"), remove: call("runs:remove"), onEvent: on("run:event"), onFinished: on("run:finished") },
  settings: { get: call("settings:get"), set: call("settings:set") },
  crm: { contacts: { list: call("crm:contacts:list"), get: call("crm:contacts:get"), update: call("crm:contacts:update"), setOutreachState: call("crm:contacts:setOutreachState") }, tags: call("crm:tags"), stages: call("crm:stages"), outreachStates: call("crm:outreachStates"), posts: { list: call("crm:posts:list"), get: call("crm:posts:get") } },
  followups: { list: call("followups:list"), cancel: call("followups:cancel"), runNow: call("followups:runNow") },
});
