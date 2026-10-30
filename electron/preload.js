const { contextBridge, ipcRenderer } = require('electron');

// v3 local RAG agent API — narrow surface, no paths or secrets cross this bridge.
function agentAPI(sessionId) {
  const invoke = (channel, ...args) => ipcRenderer.invoke(channel, sessionId, ...args);
  return {
  submitBusinessInput: (runId, actionId, input) => invoke('business:submit', runId, actionId, input),
  listBusinessArtifacts: (threadId) => invoke('business:artifacts', threadId),
  openBusinessArtifact: (id) => invoke('business:openArtifact', id),
  saveBusinessArtifact: (id) => invoke('business:saveArtifact', id),
  submitWorkSelection: (runId, actionId, selection) => invoke('work:submitSelection', runId, actionId, selection),
  pickWorkSources: (kind) => invoke('work:pickSources', kind),
  pickWorkFiles: (multiple, upload) => invoke('work:pickFiles', multiple, upload),
  listWorkSources: () => invoke('work:listSources'),
  removeWorkSource: (id) => invoke('work:removeSource', id),
  listWorkFiles: (sourceId) => invoke('work:listFiles', sourceId),
  inspectWorkFile: (file, sheet, headerRow) => invoke('work:inspect', file, sheet, headerRow),
  previewSourceMapping: (file, fingerprint, mapping) => invoke('work:preview', file, fingerprint, mapping),
  listSourceProfiles: () => invoke('work:listProfiles'),
  saveSourceProfile: (file, fingerprint, profile) => invoke('work:saveProfile', file, fingerprint, profile),
  removeSourceProfile: (id) => invoke('work:removeProfile', id),
  getWorkspace: () => invoke('agent:getWorkspace'),
  setMemoryEnabled: (workspaceId, enabled) => invoke('agent:setMemoryEnabled', workspaceId, enabled),

  createThread: (workspaceId) => invoke('agent:createThread', workspaceId),
  listThreads: (workspaceId) => invoke('agent:listThreads', workspaceId),
  loadThread: (threadId, beforeMessageId, limit) => invoke('agent:loadThread', threadId, beforeMessageId, limit),
  renameThread: (threadId, title) => invoke('agent:renameThread', threadId, title),
  deleteThread: (threadId) => invoke('agent:deleteThread', threadId),
  openRun: (threadId) => invoke('agent:openRun', threadId),

  startRun: (input) => invoke('agent:startRun', input),
  resumeRun: (runId, text) => invoke('agent:resumeRun', runId, text),
  cancelRun: (runId) => invoke('agent:cancelRun', runId),
  onAgentEvent: (listener) => {
    const handler = (_event, payload) => { if (payload.sessionId === sessionId) listener(payload.event); };
    ipcRenderer.on('agent:event', handler);
    return () => ipcRenderer.removeListener('agent:event', handler);
  },
  recordInteraction: (runId, kind) => invoke('agent:recordInteraction', runId, kind),
  openCitation: (runId, evidenceId) => invoke('agent:openCitation', runId, evidenceId),

  addCollection: () => invoke('collection:add'),
  removeCollection: (name) => invoke('collection:remove', name),
  syncCollection: (name) => invoke('collection:sync', name),
  listCollections: (workspaceId) => invoke('collection:list', workspaceId),
  setCollectionActive: (workspaceId, name, active) => invoke('collection:setActive', workspaceId, name, active),
  listMaruStorages: (workspaceId) => invoke('maru:listStorages', workspaceId),
  setMaruStorageActive: (workspaceId, storageId, active) => invoke('maru:setStorageActive', workspaceId, storageId, active),
  onCollectionsChanged: (listener) => {
    const handler = (_event, payload) => { if (payload.sessionId === sessionId) listener(); };
    ipcRenderer.on('collection:changed', handler);
    return () => ipcRenderer.removeListener('collection:changed', handler);
  },

  listMemories: (workspaceId) => invoke('agent:listMemories', workspaceId),
  addMemory: (workspaceId, input) => invoke('agent:addMemory', workspaceId, input),
  updateMemory: (id, input) => invoke('agent:updateMemory', id, input),
  setMemoryPinned: (id, pinned) => invoke('agent:setMemoryPinned', id, pinned),
  confirmMemory: (id) => invoke('agent:confirmMemory', id),
  deleteMemory: (id) => invoke('agent:deleteMemory', id),

  getModelSettings: () => invoke('agent:getModelSettings'),
  setModelSettings: (settings) => invoke('agent:setModelSettings', settings),
  listModels: () => invoke('agent:listModels'),
  testModelConnection: () => invoke('agent:testModelConnection'),
  startCanvas: (input) => invoke('canvas:start', input),
  canvasEdit: (runId, op, displayText) => invoke('canvas:edit', runId, op, displayText),
  canvasAnchorChoice: (runId, choice) => invoke('canvas:anchorChoice', runId, choice),
  loadCanvas: (runId) => invoke('canvas:load', runId),
  openCanvasSource: (canvasId, documentId) => invoke('canvas:openSource', canvasId, documentId),
};
}

contextBridge.exposeInMainWorld('authAPI', {
  getState: () => ipcRenderer.invoke('auth:getState'),
  requestCode: (email) => ipcRenderer.invoke('auth:requestCode', email),
  verifyCode: (code) => ipcRenderer.invoke('auth:verifyCode', code),
  retry: () => ipcRenderer.invoke('auth:retry'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  onChange: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on('auth:changed', handler);
    return () => ipcRenderer.removeListener('auth:changed', handler);
  },
  agent: (sessionId) => agentAPI(sessionId),
});
