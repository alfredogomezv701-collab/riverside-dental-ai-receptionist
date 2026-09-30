// Assistant definitions for the Riverside Dental receptionist (see docs/ARCHITECTURE.md).
// Pure functions of the IDs they depend on, so setup.mjs can create the assistants in
// dependency order (Billing + Scheduling first, Front Desk last) and print any of them
// with `node assistants/setup.mjs` (dry run, no network).

export const CLINIC = 'Riverside Dental';
export const ESCALATION_SECS = 300;
// IANA zone used for "today" in prompts (telnyx_current_time is UTC). Clinic is in Central time.
export const CLINIC_TZ = 'America/Chicago';

// Left undefined => Telnyx applies its default hosted model. Set MODEL to pin one
// (e.g. 'moonshotai/Kimi-K2.6'; list via GET /v2/ai/models).
export const MODEL = process.env.ASSISTANT_MODEL || undefined;

const edge = (id, from, target, condition) => ({ id, start_node_id: from, target, condition });
const toNode = (node_id) => ({ type: 'node', node_id });
const toAssistant = (assistant_id, voice_mode = 'distinct') => ({ type: 'assistant', assistant_id, voice_mode });
const llm = (prompt) => ({ type: 'llm', prompt });
const dflt = { type: 'default' };
const varEquals = (name, value) => ({
  type: 'expression',
  expression: {
    type: 'comparison',
    op: '==',
    left: { type: 'variable', name },
    right: { type: 'string_literal', value },
  },
});
const durationOver = (secs) => ({
  type: 'expression',
  expression: {
    type: 'comparison',
    op: '>=',
    left: { type: 'variable', name: 'telnyx_conversation_duration_secs' },
    right: { type: 'number_literal', value: secs },
  },
});

// Shared by every assistant: the dynamic-variable webhook (receptionist-webhook, POST /).
const webhook = (webhookUrl) => ({
  dynamic_variables_webhook_url: webhookUrl,
  dynamic_variables_webhook_timeout_ms: 3000,
  // Defaults used if the webhook times out — the flow must still work for a "new caller".
  dynamic_variables: {
    is_returning_patient: 'false',
    // Never empty strings: the Portal's "Call" form is pre-filled from these defaults, renders an
    // empty string as null, and the outbound-call API rejects null values. The webhook itself still
    // returns "" for "nothing on file", so prompts treat both "" and "none" as nothing.
    patient_name: 'unknown',
    next_appointment: 'none',
    next_appointment_id: 'none',
    appointment_count: '0',
    waitlist_mode: 'false',
  },
});

// Compact clinic facts for cost optimization - keep essential info only
export const CLINIC_FACTS = `Hours: Mon-Fri 9am-5pm, closed weekends. Services: cleanings, exams, fillings, extractions, root canals. New patients welcome; bring ID and insurance card. Emergencies: call 911.`;

const COMMON_RULES = `Keep replies to 1-2 short sentences. No symbols or markdown. Speak dates naturally (e.g. "Tuesday the seventh at ten"). Never invent availability or prices. If unsure, say so and offer a callback.`;

// ---------------------------------------------------------------- Billing Specialist
// Billing has no tools. Given the ids it also gets a small flow so a caller who came for insurance
// but also wants an appointment can be handed to Scheduling instead of being stuck (without ids,
// e.g. at first creation, it is a plain prompt-only assistant and update.mjs adds the flow).
export function billingAssistant({ webhookUrl, hangupToolId, schedulingId }) {
  const flow =
    hangupToolId && schedulingId
      ? {
          conversation_flow: {
            start_node_id: 'n_billing',
            nodes: [
              {
                type: 'prompt',
                id: 'n_billing',
                name: 'Billing Help',
                instructions_mode: 'append',
                instructions: `Answer the caller's billing or insurance question within the limits above. If they also want to book, change or cancel an appointment, say you'll connect them to scheduling. When their question is answered, ask if there is anything else.`,
              },
              {
                type: 'speak',
                id: 'n_escalate',
                name: 'Escalate',
                message: `I want to make sure you get the right help, so I'll have a member of the team call you back shortly. Thank you for your patience.`,
              },
              { type: 'speak', id: 'n_goodbye', name: 'Goodbye', message: `Thanks for calling ${CLINIC}. Goodbye!` },
              { type: 'tool', id: 'n_hangup', name: 'Hang up', shared_tool_id: hangupToolId },
            ],
            edges: [
              edge('e_billing_slow', 'n_billing', toNode('n_escalate'), durationOver(ESCALATION_SECS)),
              edge('e_billing_sched', 'n_billing', toAssistant(schedulingId),
                llm('The caller wants to book, change or cancel an appointment.')),
              edge('e_billing_done', 'n_billing', toNode('n_goodbye'),
                llm('The caller has no more questions.')),
              edge('e_escalate_end', 'n_escalate', toNode('n_hangup'), dflt),
              edge('e_goodbye_end', 'n_goodbye', toNode('n_hangup'), dflt),
            ],
          },
        }
      : {};
  return {
    name: 'Riverside Dental — Billing Specialist',
    description: 'Insurance and payment questions. No booking tools by design (scoped-down persona).',
    model: MODEL,
    voice_settings: { voice: 'Telnyx.KokoroTTS.am_michael' },
    enabled_features: ['telephony'],
    instructions: `Answer billing or insurance questions generally only: which insurance types the clinic usually accepts (most major PPO plans), co-pay at visit, payment plans exist, itemised statements are emailed by the office. You cannot look up accounts, quote exact prices, take payment or change bookings. For specifics, say the billing office will call back within one business day and ask for the best number. Caller: {{patient_name}} (returning: {{is_returning_patient}}).`,
    ...webhook(webhookUrl),
    telephony_settings: { user_idle_timeout_secs: 20 },
    ...flow,
  };
}

// ---------------------------------------------------------------- Scheduling Specialist
export function schedulingAssistant({ webhookUrl, mcpServerId, hangupToolId, frontDeskId }) {
  const nodes = [
    {
      type: 'prompt',
      id: 'n_collect',
      name: 'Collect Details',
      instructions_mode: 'append',
      instructions: `Find out what the caller needs: a new appointment, or to change or cancel an existing one. For a new appointment collect the service and a preferred date. If {{is_returning_patient}} is "true", greet {{patient_name}} by name; they have {{appointment_count}} upcoming appointment(s), the soonest being "{{next_appointment}}" unless that is empty or "none".`,
    },
    {
      type: 'prompt',
      id: 'n_offer',
      name: 'Check Availability',
      instructions_mode: 'append',
      instructions: `Call check_availability with the service and date (YYYY-MM-DD). Offer at most three open slots, chosen closest to what the caller asked for. If nothing suits them, ask for another date and call check_availability again.`,
    },
    {
      type: 'prompt',
      id: 'n_confirm',
      name: 'Confirm Details',
      instructions_mode: 'append',
      instructions: `Repeat back the service, date and time, and collect the patient's full name and a callback phone number with area code (ten digits). The number the caller is phoning from is {{telnyx_end_user_target}}: if they say "this number" or "the number I'm calling from", use exactly that; if it is empty or not a real number, ask them to say a number. Ask for a clear yes before booking. If the caller says "yes" or "that's right" or "correct" or similar affirmative words, even with extra chatter or clarifying questions, treat it as a yes.`,
    },
    {
      type: 'prompt',
      id: 'n_book',
      name: 'Book Appointment',
      instructions_mode: 'append',
      instructions: `Call book_appointment with the confirmed service, date, start time (24h HH:MM), patient name and phone. If it returns confirmed true, tell the caller they are booked and read the details back once. If it returns reason slot_already_booked, slot_unavailable or invalid_slot, apologise briefly and offer to look at other times.`,
    },
    {
      type: 'prompt',
      id: 'n_manage',
      name: 'Change or Cancel',
      instructions_mode: 'append',
      instructions: `The caller wants to cancel or reschedule. The soonest appointment on file is "{{next_appointment}}" with id "{{next_appointment_id}}", and they have {{appointment_count}} upcoming in total. If there is exactly one, confirm it is the one they mean and use that id. If there are several, or none is on file, tell them only the soonest one is on file and ask whether they mean it. For a reschedule, first agree a new slot (check_availability), then call cancel_or_reschedule_appointment with action reschedule and the new date and start; to cancel, call it with action cancel. Confirm the outcome in one sentence.`,
    },
    {
      type: 'speak',
      id: 'n_closing',
      name: 'Closing',
      message: `You're all set. We'll see you at ${CLINIC}. Thanks for calling, and have a great day!`,
    },
    {
      type: 'speak',
      id: 'n_closing_manage',
      name: 'Closing (change or cancel)',
      message: `All done. Thanks for calling ${CLINIC}, and have a great day!`,
    },
    {
      type: 'speak',
      id: 'n_waitlist',
      name: 'Waitlist',
      // Says nothing was recorded, because nothing is: no waitlist is persisted anywhere.
      message: `We're fully booked for new appointments right now. Please call back tomorrow, or during office hours and the team will do what they can. Thanks for calling ${CLINIC}.`,
    },
    {
      type: 'speak',
      id: 'n_escalate',
      name: 'Escalate',
      message: `I want to make sure you get the right help, so I'll have a member of the team call you back shortly. Thank you for your patience.`,
    },
    { type: 'tool', id: 'n_hangup', name: 'Hang up', shared_tool_id: hangupToolId },  // <-- ADD THIS TO NODES TOO!
  ];

  const edges = [
    edge('e_offer_waitlist', 'n_offer', toNode('n_waitlist'), varEquals('waitlist_mode', 'true')),
    ...['n_collect', 'n_offer', 'n_confirm', 'n_book', 'n_manage'].map((n) =>
      edge(`e_${n.slice(2)}_slow`, n, toNode('n_escalate'), durationOver(ESCALATION_SECS))),

    edge('e_collect_offer', 'n_collect', toNode('n_offer'),
      llm('The caller wants a new appointment and has given the service and a preferred date.')),
    edge('e_collect_manage', 'n_collect', toNode('n_manage'),
      llm('The caller wants to cancel or reschedule an existing appointment.')),
    edge('e_collect_desk', 'n_collect', toAssistant(frontDeskId, 'unified'),
      llm('The caller wants something unrelated to scheduling, such as billing or general questions.')),
    edge('e_offer_confirm', 'n_offer', toNode('n_confirm'),
      llm('The caller has chosen one of the offered slots.')),
    edge('e_offer_back', 'n_offer', toNode('n_collect'),
      llm('The caller wants a different service, or wants to do something other than book a new appointment.')),
    edge('e_confirm_book', 'n_confirm', toNode('n_book'),
      llm('The caller gave any affirmative response (yes, sure, correct, that is right, okay, confirmed) indicating they want to proceed with the booking, even if they also asked a clarifying question or added extra information. Treat any sign of agreement as confirmation.')),
    edge('e_confirm_back', 'n_confirm', toNode('n_collect'),
      llm('The caller said no, rejected the booking, or explicitly wants to change the service, date or time.')),
    // Default edge on n_confirm: if response is ambiguous or questioning, treat as not-yet-confirmed and loop back to collect
    edge('e_confirm_unclear', 'n_confirm', toNode('n_collect'),
      llm('The caller gave an unclear, questioning, or incomplete response that is neither a clear yes nor a clear no.')),
    edge('e_book_done', 'n_book', toNode('n_closing'),
      llm('book_appointment returned confirmed true.')),
    edge('e_book_retry', 'n_book', toNode('n_offer'),
      llm('book_appointment returned slot_already_booked, slot_unavailable or invalid_slot.')),
    edge('e_manage_done', 'n_manage', toNode('n_closing_manage'),
      llm('The appointment was cancelled or rescheduled successfully.')),
    edge('e_manage_retry', 'n_manage', toNode('n_offer'),
      llm('A reschedule failed because the new time was taken, unavailable or invalid, and the caller wants to try a different time.')),
    edge('e_manage_notfound', 'n_manage', toNode('n_collect'),
      llm('The tool reported appointment_not_found, or the caller cannot identify which appointment they mean.')),
    edge('e_manage_back', 'n_manage', toNode('n_collect'),
      llm('The caller changed their mind and wants something else.')),

    edge('e_closing_end', 'n_closing', toNode('n_hangup'), dflt),
    edge('e_closing_manage_end', 'n_closing_manage', toNode('n_hangup'), dflt),
    edge('e_waitlist_end', 'n_waitlist', toNode('n_hangup'), dflt),
    edge('e_escalate_end', 'n_escalate', toNode('n_hangup'), dflt),
  ];

  return {
    name: 'Riverside Dental — Scheduling Specialist',
    description: 'Books, reschedules and cancels appointments via the receptionist MCP server.',
    model: MODEL,
    voice_settings: { voice: 'Telnyx.KokoroTTS.af_bella' },
    enabled_features: ['telephony'],
    instructions: `You are the scheduling specialist at ${CLINIC}. ${COMMON_RULES} ${CLINIC_FACTS} Dates for tools are YYYY-MM-DD and times are 24h HH:MM. The current date and time at the clinic is {{telnyx_current_time_${CLINIC_TZ}}} (Central time). All appointment times are Central time: when a caller names a time without a timezone, assume Central; if they mention another timezone or sound like they are calling from elsewhere, ask which timezone they mean and convert to Central before checking availability, then repeat the time back in Central to confirm.`,
    mcp_servers: [
      {
        id: mcpServerId,
        allowed_tools: ['check_availability', 'book_appointment', 'cancel_or_reschedule_appointment'],
      },
    ],
    ...webhook(webhookUrl),
    telephony_settings: { user_idle_timeout_secs: 20 },
    conversation_flow: { start_node_id: 'n_collect', nodes, edges },
  };
}

// ---------------------------------------------------------------- Front Desk (entry point)
export function frontDeskAssistant({ webhookUrl, hangupToolId, schedulingId, billingId }) {
  const nodes = [
    {
      type: 'speak',
      id: 'n_greeting',
      name: 'Greeting',
      // Verbatim on purpose: the recording/AI disclosure must not be paraphrased by an LLM.
      message: `Thank you for calling ${CLINIC}. I'm the clinic's AI receptionist, and this call may be recorded to help us serve you better.`,
    },
    {
      type: 'prompt',
      id: 'n_intent_returning',
      name: 'Identify Intent (returning)',
      instructions_mode: 'append',
      instructions: `The caller is a returning patient named {{patient_name}}. Greet them by name. If they have an upcoming appointment (the soonest is "{{next_appointment}}"; they have {{appointment_count}}), mention the soonest and ask whether they are calling about it or something else. Otherwise ask how you can help. Work out whether they need scheduling, billing or insurance help, a general question answered, or a person. Do not try to complete the task yourself.`,
    },
    {
      type: 'prompt',
      id: 'n_intent',
      name: 'Identify Intent',
      instructions_mode: 'append',
      instructions: `Ask how you can help. Work out whether the caller needs scheduling (book, change or cancel an appointment), billing or insurance help, a general question answered, or a person.`,
    },
    {
      type: 'prompt',
      id: 'n_faq',
      name: 'Answer FAQ',
      instructions_mode: 'append',
      instructions: `Answer the caller's general question using only the clinic facts you were given. Anything else: say you're not sure and offer a callback. Afterwards ask if there is anything else you can help with.`,
    },
    {
      type: 'speak',
      id: 'n_escalate',
      name: 'Escalate',
      message: `I want to make sure you get the right help, so I'll have a member of the team call you back shortly. Thank you for your patience.`,
    },
    {
      type: 'speak',
      id: 'n_goodbye',
      name: 'Goodbye',
      message: `Thanks for calling ${CLINIC}. Goodbye!`,
    },
    { type: 'tool', id: 'n_hangup', name: 'Hang up', shared_tool_id: hangupToolId },
  ];

  const edges = [
    // Returning vs new caller: deterministic, from the webhook's dynamic variable.
    edge('e_greet_returning', 'n_greeting', toNode('n_intent_returning'), varEquals('is_returning_patient', 'true')),
    edge('e_greet_new', 'n_greeting', toNode('n_intent'), dflt),

    // Time-boxed conversations escalate deterministically, from every node that can loop.
    ...['n_intent_returning', 'n_intent', 'n_faq'].map((n) =>
      edge(`e_${n}_slow`, n, toNode('n_escalate'), durationOver(ESCALATION_SECS))),

    // LLM-conditioned intent routing, same set from both intent nodes.
    ...['n_intent_returning', 'n_intent'].flatMap((n) => [
      edge(`e_${n}_sched`, n, toAssistant(schedulingId),
        llm('The caller wants to book, reschedule or cancel an appointment.')),
      edge(`e_${n}_bill`, n, toAssistant(billingId),
        llm('The caller has a billing, payment or insurance question.')),
      edge(`e_${n}_faq`, n, toNode('n_faq'),
        llm('The caller has a general question about hours, services, location or new-patient info.')),
      edge(`e_${n}_human`, n, toNode('n_escalate'),
        llm('The caller explicitly asks for a person, or describes something you cannot help with.')),
    ]),

    edge('e_faq_sched', 'n_faq', toAssistant(schedulingId),
      llm('After the answer, the caller wants to book or change an appointment.')),
    edge('e_faq_bill', 'n_faq', toAssistant(billingId),
      llm('After the answer, the caller has a billing or insurance question.')),
    edge('e_faq_done', 'n_faq', toNode('n_goodbye'),
      llm('The caller has no more questions.')),

    edge('e_escalate_end', 'n_escalate', toNode('n_hangup'), dflt),
    edge('e_goodbye_end', 'n_goodbye', toNode('n_hangup'), dflt),
  ];

  return {
    name: 'Riverside Dental — Front Desk',
    description: 'Entry point: greets, identifies caller and intent, routes to specialists.',
    model: MODEL,
    voice_settings: { voice: 'Telnyx.KokoroTTS.af_heart' },
    enabled_features: ['telephony'],
    greeting: '', // the Greeting speak node delivers the opening line instead
    instructions: `You are the front-desk receptionist at ${CLINIC}. ${COMMON_RULES} ${CLINIC_FACTS}`,
    ...webhook(webhookUrl),
    telephony_settings: { user_idle_timeout_secs: 20 },
    conversation_flow: { start_node_id: 'n_greeting', nodes, edges },
  };
}
