// Minimal client for driving an assistant over Telnyx's text chat API: a real conversation
// through the workflow, LLM and MCP tools, no phone call. Costs (a little) inference credit.
//
// Chat quirk found while building this: after a hand-off the conversation's *active*
// assistant changes, but POSTing to the original assistant's /chat path re-runs that
// assistant's start node (the Front Desk greeting repeats every turn) and answers with the
// wrong persona. `say()` therefore always posts to the conversation's current assistant.
const API = 'https://api.telnyx.com/v2/ai';

export function chatClient(apiKey) {
  const headers = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
  const json = async (method, path, body) => {
    const res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 400)}`);
    return text ? JSON.parse(text) : {};
  };

  return {
    json,
    /** Start a conversation; `phone` becomes telnyx_end_user_target metadata. */
    async start(assistantId, { name = 'autotest', phone = '+15550001111', metadata = {} } = {}) {
      const c = await json('POST', '/conversations', {
        name,
        metadata: { telnyx_conversation_channel: 'web_chat', telnyx_end_user_target: phone, ...metadata },
      });
      const id = (c.data ?? c).id;
      let active = assistantId;
      return {
        id,
        transcript: [],
        get activeAssistant() {
          return active;
        },
        async say(text) {
          const r = await json('POST', `/assistants/${active}/chat`, { conversation_id: id, content: text });
          const meta = ((await json('GET', `/conversations/${id}`)).data ?? {}).metadata ?? {};
          if (meta.assistant_id) active = meta.assistant_id;
          this.transcript.push({ user: text, assistant: r.content, active });
          return r.content;
        },
        /** Chronological messages, each with metadata (assistant_id / active_flow_node_id) and tool calls. */
        async messages() {
          const m = await json('GET', `/conversations/${id}/messages`);
          return (m.data ?? []).slice().reverse();
        },
        /** Parsed results of every call the assistant made to the named MCP tool. */
        async toolResults(toolName) {
          const msgs = await this.messages();
          const out = [];
          for (let i = 0; i < msgs.length; i++) {
            const calls = msgs[i].tool_calls ?? [];
            if (!calls.some((c) => c.function?.name === toolName)) continue;
            const reply = msgs.slice(i + 1).find((x) => x.role === 'tool');
            if (reply) {
              let parsed;
              try {
                parsed = JSON.parse(reply.text);
              } catch {
                parsed = reply.text;
              }
              // Tool messages come back wrapped in an array of one result object.
              out.push(...(Array.isArray(parsed) ? parsed : [parsed]));
            }
          }
          return out;
        },
        async end() {
          await json('DELETE', `/conversations/${id}`).catch(() => {});
        },
      };
    },
  };
}
