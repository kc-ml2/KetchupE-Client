const { contextBridge, ipcRenderer } = require('electron');

// v3 local RAG agent API — narrow surface, no paths or secrets cross this bridge.
contextBridge.exposeInMainWorld('agentAPI', {
  submitBusinessInput: (runId, actionId, input) => ipcRenderer.invoke('business:submit', runId, actionId, input),
  listBusinessArtifacts: (threadId) => ipcRenderer.invoke('business:artifacts', threadId),
  openBusinessArtifact: (id) => ipcRenderer.invoke('business:openArtifact', id),
  saveBusinessArtifact: (id) => ipcRenderer.invoke('business:saveArtifact', id),
  submitWorkSelection: (runId, actionId, selection) => ipcRenderer.invoke('work:submitSelection', runId, actionId, selection),
  pickWorkSources: (kind) => ipcRenderer.invoke('work:pickSources', kind),
  pickWorkFiles: (multiple) => ipcRenderer.invoke('work:pickFiles', multiple),
  listWorkSources: () => ipcRenderer.invoke('work:listSources'),
  removeWorkSource: (id) => ipcRenderer.invoke('work:removeSource', id),
  listWorkFiles: (sourceId) => ipcRenderer.invoke('work:listFiles', sourceId),
  inspectWorkFile: (file, sheet, headerRow) => ipcRenderer.invoke('work:inspect', file, sheet, headerRow),
  previewSourceMapping: (file, fingerprint, mapping) => ipcRenderer.invoke('work:preview', file, fingerprint, mapping),
  listSourceProfiles: () => ipcRenderer.invoke('work:listProfiles'),
  saveSourceProfile: (file, fingerprint, profile) => ipcRenderer.invoke('work:saveProfile', file, fingerprint, profile),
  removeSourceProfile: (id) => ipcRenderer.invoke('work:removeProfile', id),
  getWorkspace: () => ipcRenderer.invoke('agent:getWorkspace'),
  setMemoryEnabled: (workspaceId, enabled) => ipcRenderer.invoke('agent:setMemoryEnabled', workspaceId, enabled),

  createThread: (workspaceId) => ipcRenderer.invoke('agent:createThread', workspaceId),
  listThreads: (workspaceId) => ipcRenderer.invoke('agent:listThreads', workspaceId),
  loadThread: (threadId, beforeMessageId, limit) => ipcRenderer.invoke('agent:loadThread', threadId, beforeMessageId, limit),
  renameThread: (threadId, title) => ipcRenderer.invoke('agent:renameThread', threadId, title),
  deleteThread: (threadId) => ipcRenderer.invoke('agent:deleteThread', threadId),
  openRun: (threadId) => ipcRenderer.invoke('agent:openRun', threadId),

  startRun: (input) => ipcRenderer.invoke('agent:startRun', input),
  resumeRun: (runId, text) => ipcRenderer.invoke('agent:resumeRun', runId, text),
  cancelRun: (runId) => ipcRenderer.invoke('agent:cancelRun', runId),
  onAgentEvent: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('agent:event', handler);
    return () => ipcRenderer.removeListener('agent:event', handler);
  },
  recordInteraction: (runId, kind) => ipcRenderer.invoke('agent:recordInteraction', runId, kind),
  openCitation: (runId, evidenceId) => ipcRenderer.invoke('agent:openCitation', runId, evidenceId),

  addCollection: () => ipcRenderer.invoke('collection:add'),
  removeCollection: (name) => ipcRenderer.invoke('collection:remove', name),
  syncCollection: (name) => ipcRenderer.invoke('collection:sync', name),
  listCollections: (workspaceId) => ipcRenderer.invoke('collection:list', workspaceId),
  setCollectionActive: (workspaceId, name, active) => ipcRenderer.invoke('collection:setActive', workspaceId, name, active),
  onCollectionsChanged: (listener) => {
    const handler = () => listener();
    ipcRenderer.on('collection:changed', handler);
    return () => ipcRenderer.removeListener('collection:changed', handler);
  },

  listMemories: (workspaceId) => ipcRenderer.invoke('agent:listMemories', workspaceId),
  addMemory: (workspaceId, input) => ipcRenderer.invoke('agent:addMemory', workspaceId, input),
  updateMemory: (id, input) => ipcRenderer.invoke('agent:updateMemory', id, input),
  setMemoryPinned: (id, pinned) => ipcRenderer.invoke('agent:setMemoryPinned', id, pinned),
  confirmMemory: (id) => ipcRenderer.invoke('agent:confirmMemory', id),
  deleteMemory: (id) => ipcRenderer.invoke('agent:deleteMemory', id),

  getModelSettings: () => ipcRenderer.invoke('agent:getModelSettings'),
  setModelSettings: (settings) => ipcRenderer.invoke('agent:setModelSettings', settings),
  listModels: () => ipcRenderer.invoke('agent:listModels'),
  testModelConnection: () => ipcRenderer.invoke('agent:testModelConnection'),
  startCanvas: (input) => ipcRenderer.invoke('canvas:start', input),
  canvasEdit: (runId, op, displayText) => ipcRenderer.invoke('canvas:edit', runId, op, displayText),
  canvasAnchorChoice: (runId, choice) => ipcRenderer.invoke('canvas:anchorChoice', runId, choice),
  loadCanvas: (runId) => ipcRenderer.invoke('canvas:load', runId),
  openCanvasSource: (canvasId, documentId) => ipcRenderer.invoke('canvas:openSource', canvasId, documentId),
});
