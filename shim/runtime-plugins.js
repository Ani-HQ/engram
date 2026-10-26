'use strict';

const { nativeHook } = require('./runtime-adapters');

async function openCodePlugin(context) {
  const directory = context.directory;
  return {
    'chat.message': async (input, output) => {
      try {
        const text = output.parts?.find(part => part?.type === 'text' && typeof part.text === 'string');
        if (!text) return;
        const result = await nativeHook('opencode', { hook_event_name: 'chat.message', sessionID: input.sessionID, messageID: input.messageID, cwd: directory, prompt: text.text });
        if (result['text-part']) output.parts[output.parts.indexOf(text)] = { ...text, text: `${text.text}\n\n${result['text-part']}` };
      } catch { /* Memory cannot block the user's work. */ }
    },
    event: async ({ event }) => {
      if (event?.type !== 'session.deleted') return;
      try { await nativeHook('opencode', { hook_event_name: 'session.deleted', sessionID: event.properties?.info?.id, cwd: directory }); } catch { /* Fail open. */ }
    },
  };
}

const openClawPlugin = {
  id: 'engram-memory', name: 'Engram shared memory',
  register(api) {
    // session_end has no workspaceDir in the public contract. Keep only a
    // bounded in-process identity/path mapping, never messages or memory text.
    const sessions = new Map();
    api.on('before_prompt_build', async (event, context) => {
      try {
        // `prompt` can contain reconstructed history. Only the explicit current
        // request is eligible; empty/image-only/unsupported hosts are skipped.
        if (typeof event.currentUserMessage !== 'string' || !event.currentUserMessage) return;
        context.hookInvocation?.assertActive();
        const sessionKey = context.sessionKey || context.sessionId;
        if (typeof sessionKey !== 'string' || typeof context.workspaceDir !== 'string') return;
        const entry = { sessionKey, workspaceDir: context.workspaceDir };
        for (const id of [context.sessionKey, context.sessionId]) if (typeof id === 'string') { sessions.delete(id); sessions.set(id, entry); }
        while (sessions.size > 128) sessions.delete(sessions.keys().next().value);
        const result = await nativeHook('openclaw', { hook_event_name: 'before_prompt_build', sessionKey, cwd: context.workspaceDir, prompt: event.currentUserMessage, currentUserMessageId: event.currentUserMessageId });
        context.hookInvocation?.assertActive();
        return result;
      } catch { return undefined; }
    });
    api.on('session_end', async (_event, context) => {
      try {
        const entry = sessions.get(context.sessionKey) || sessions.get(context.sessionId);
        if (!entry) return;
        for (const [key, value] of sessions) if (value === entry) sessions.delete(key);
        await nativeHook('openclaw', { hook_event_name: 'session_end', sessionKey: entry.sessionKey, cwd: entry.workspaceDir });
      } catch { /* Fail open. */ }
    });
  },
};

module.exports = { openCodePlugin, openClawPlugin };
