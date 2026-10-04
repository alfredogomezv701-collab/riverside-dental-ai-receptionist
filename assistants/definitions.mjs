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

// The second variable-comparison edge required by REQUIREMENTS.md: `attempt_count >= 3 -> waitlist`.
// Mirrors durationOver's shape exactly. attempt_count is set to "0" by the assistant defaults at
// conversation start, then updated mid-call by the `update_dynamic_variables` shared tool, which the
// `n_book` instructions tell the model to call after every book_appointment result that includes an
// `attempt_count` field (the server-side, per-caller-per-date failed-booking counter). This is the
// honest mechanism: the count is computed deterministically server-side; only the edge's *decision*
// is LLM-facilitated (the model must call the update tool). See docs/LEARNINGS.md for the platform
// constraints that led to this design.
const WAITLIST_THRESHOLD = 3;
const attemptOver = (threshold) => ({
  type: 'expression',
  expression: {
    type: 'comparison',
    op: '>=',
    left: { type: 'variable', name: 'attempt_count' },
    right: { type: 'number_literal', value: threshold },
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
    // attempt_count is NOT returned by the webhook (it is set to "0" here as a starting value, then
    // updated mid-call by the `update_dynamic_variables` shared tool, which book_appointment's
    // attempt_count return value tells the model to call). Kept here so the variable-lint test
    // recognises it and the n_book -> n_waitlist comparison edge has a defined left-hand side.
    attempt_count: '0',
  },
});

// Compact clinic facts for cost optimization - keep essential info only
export const CLINIC_FACTS = `Hours: Mon-Fri 9am-5pm, closed weekends. Services: cleanings, exams, fillings, extractions, root canals. New patients welcome; bring ID and insurance card. Emergencies: call 911.`;

const COMMON_RULES = `Keep replies to 1-2 short sentences. No symbols or markdown. Speak dates naturally (e.g. "Tuesday the seventh at ten"). Never invent availability or prices. If unsure, say so and offer a callback.`;

// ---------------------------------------------------------------- Billing Specialist
// Billing has no tools. Given the ids it also gets a small flow so a caller who came for insurance
// but also wants an appointment can be handed to Scheduling instead of being stuck (without ids,
// e.g. at first creation, it is a plain prompt-only assistant and update.mjs adds the flow).
export function billingAssistant({ webhookUrl, hangupToolId, schedulingId, frontDeskId }) {
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
              edge('e_billing_faq', 'n_billing', toAssistant(frontDeskId, 'unified'),
                llm('The caller said something unclear, off-topic, or gave a response that does not match any other routing condition.')),
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
    // Ultra "Asher - Podcaster": firm adult male, clear communication.
    voice_settings: { voice: 'Telnyx.Ultra.00967b2f-88a6-4a31-8153-110a92134b9f' },
    enabled_features: ['telephony'],
    instructions: `Answer billing or insurance questions generally only: which insurance types the clinic usually accepts (most major PPO plans), co-pay at visit, payment plans exist, itemised statements are emailed by the office. You cannot look up accounts, quote exact prices, take payment or change bookings. For specifics, say the billing office will call back within one business day and ask for the best number. Caller: {{patient_name}} (returning: {{is_returning_patient}}).`,
    ...webhook(webhookUrl),
    telephony_settings: { user_idle_timeout_secs: 20 },
    ...flow,
  };
}

// ---------------------------------------------------------------- Scheduling Specialist
export function schedulingAssistant({ webhookUrl, mcpServerId, hangupToolId, attemptCounterToolId, frontDeskId }) {
  const nodes = [
    {
      type: 'prompt',
      id: 'n_collect',
      name: 'Collect Details',
      instructions_mode: 'append',
      instructions: `Find out what the caller needs: a new appointment, or to change or cancel an existing one. For a new appointment collect the service and a preferred date. If {{is_returning_patient}} is "true", greet {{patient_name}} by name; they have {{appointment_count}} upcoming appointment(s), the soonest being "{{next_appointment}}" unless that is empty or "none".`,
    },
    {
      type: 'speak',
      id: 'n_checking',
      name: 'Checking (filler)',
      // A fixed speak node needs no LLM generation, so it plays immediately regardless of how long
      // the model takes on the NEXT turn (n_offer: classify + call check_availability + word the
      // result - two model round trips stacked on one user turn, measured at ~6s+ live). Without
      // this, that gap is dead air; a caller who hears nothing hangs up (reproduced live 2026-10-04,
      // call ended by recv_bye ~12s after the caller gave a date, before the tool was even called).
      message: `Let me check what's available for that.`,
    },
    {
      type: 'prompt',
      id: 'n_offer',
      name: 'Check Availability',
      instructions_mode: 'append',
      instructions: `Call check_availability with the service and date (YYYY-MM-DD). The tool's response is PAGINATED: every slot it returns is open (available:true — there is no available:false in the response; unavailable slots are simply omitted). Offer EXACTLY the slots the tool returned this turn, wording them naturally. Do not invent slots that are not in the tool response, even if they would be inside clinic hours (e.g. a closing-time slot the tool did not return). If the response includes a next_cursor field, there ARE more open slots for the same day — mention there are more (e.g. "I have a few more if none of these work") and, if the caller wants more options, call check_availability again passing that next_cursor as the cursor argument; do NOT echo the cursor to the caller. If nothing on the page suits them, either page for more open slots or ask for a different date and call check_availability again (without a cursor). When the caller picks one, move on to confirming and booking.`,
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
      instructions: `Call book_appointment with the confirmed service, date, start time (24h HH:MM), patient name and phone. If it returns confirmed true, tell the caller they are booked and read the details back once. If it returns reason slot_already_booked, slot_unavailable or invalid_slot, apologise briefly and offer to look at other times.

After EVERY book_appointment result, if the result includes an "attempt_count" number, you MUST call the update_dynamic_variables tool to write that exact number into the "attempt_count" conversation variable (pass attempt_count = the number from the tool result). This is how the workflow knows whether to send the caller to the waitlist: a later edge compares attempt_count >= 3.

When the result also includes "should_waitlist": true (meaning attempt_count has reached 3 — the caller has now failed to book three times this day), you must complete the persistence in THIS SAME TURN, BEFORE you reply to the caller with any waitlist agreement. Specifically, in this order and inside the same turn: (1) call update_dynamic_variables to set attempt_count (already done above), (2) call the join_waitlist tool with the same date, service, patientName and patientPhone, (3) only once join_waitlist returns "queued": true, reply to the caller agreeing to add them to the waitlist and noting their request. Do NOT offer the caller more retries once should_waitlist is true. The next step (the waitlist speak node) plays a recorded message claiming the request was noted, which is only truthful if join_waitlist returned queued true in this turn — so ordering matters: persist first, reply second.`,
    },
    {
      type: 'prompt',
      id: 'n_manage',
      name: 'Change or Cancel',
      instructions_mode: 'append',
      instructions: `The caller wants to cancel or reschedule. The soonest appointment on file is "{{next_appointment}}" with id "{{next_appointment_id}}", and they have {{appointment_count}} upcoming in total. If there is exactly one, confirm it is the one they mean and use that id. If there are several, or none is on file, tell them only the soonest one is on file and ask whether they mean it. For a reschedule, first agree a new slot (check_availability — paged; offer the page it returns, ask for more with next_cursor or another date), then call cancel_or_reschedule_appointment with action reschedule and the new date and start; to cancel, call it with action cancel. Confirm the outcome in one sentence.`,
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
      // Every inbound path to this speak node persists a waitlist entry first, so the spoken claim
      // is truthful on every path:
      //   - from n_waitlist_join (the waitlist_mode flag path): join_waitlist is called in that node
      //     and the edge to here only fires once queued:true is observed;
      //   - from n_book (the attempt_count >= 3 path): n_book's instructions call join_waitlist
      //     once should_waitlist:true and only then progress.
      // (Previously the flag-based path skipped persistence entirely — see docs/LEARNINGS.md
      // "Say what you store".) join_waitlist returning queued:false (e.g. KV unavailable) is not a
      // path here: both inbound edges only fire once queued:true is observed.
      message: `We're fully booked for the day you wanted, but I've noted your request and a member of the team will be in touch if something opens up. Thanks for calling ${CLINIC}.`,
    },
    {
      type: 'speak',
      id: 'n_escalate',
      name: 'Escalate',
      message: `I want to make sure you get the right help, so I'll have a member of the team call you back shortly. Thank you for your patience.`,
    },
    {
      type: 'prompt',
      id: 'n_waitlist_join',
      name: 'Join Waitlist',
      instructions_mode: 'append',
      // This node sits between the waitlist_mode flag edge (n_offer -> n_waitlist_join) and the
      // waitlist speak node (n_waitlist_join -> n_waitlist). On the flag-based path the caller
      // already has a service+date (gathered in n_collect, used in n_offer's check_availability
      // call), but their name+phone have NOT been collected — n_confirm is skipped on this path.
      // join_waitlist needs all four, and the n_waitlist message claims the request was noted,
      // so this node collects name+phone, calls join_waitlist, and only reaches n_waitlist once
      // the tool returns queued:true. (The attempt_count path does the same call from n_book,
      // where name+phone are already known; this node handles the flag path that bypasses n_book.)
      instructions: `The clinic is running in waitlist mode today: the caller cannot be booked right now, but their request can be queued for the team. You already have the service and the date the caller asked about. Collect the caller's full name and a callback phone number with area code (ten digits). The number the caller is phoning from is {{telnyx_end_user_target}}: if they say "this number" or "the number I'm calling from", use exactly that; if it is empty or not a real number, ask them to say a number. Then call the join_waitlist tool with the date, the service, the patient's name and the phone number. Only once join_waitlist returns "queued": true, tell the caller you've noted their request and the team will be in touch, and you are done. If join_waitlist returns "queued": false, apologise that you cannot take the request right now and offer to try again later — do NOT claim the request was noted when it was not.`,
    },
    { type: 'tool', id: 'n_hangup', name: 'Hang up', shared_tool_id: hangupToolId },  // <-- ADD THIS TO NODES TOO!
  ];

  const edges = [
    edge('e_offer_waitlist', 'n_offer', toNode('n_waitlist_join'), varEquals('waitlist_mode', 'true')),
    ...['n_collect', 'n_offer', 'n_confirm', 'n_book', 'n_manage', 'n_waitlist_join'].map((n) =>
      edge(`e_${n.slice(2)}_slow`, n, toNode('n_escalate'), durationOver(ESCALATION_SECS))),

    edge('e_collect_offer', 'n_collect', toNode('n_checking'),
      llm('The caller wants a new appointment and has given the service and a preferred date.')),
    edge('e_checking_offer', 'n_checking', toNode('n_offer'), dflt),
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
    // The second variable-comparison edge: attempt_count >= 3 -> waitlist. Declared FIRST on n_book
    // because variable-comparison edges are evaluated in declaration order (first match wins) AND
    // take precedence over LLM-condition edges on voice (the LLM retry/done/unclear edges below
    // are only considered when this one is false). This coexists safely with e_book_retry /
    // e_book_unclear / e_book_done the same way durationOver coexists on every looping node:
    // one deterministic edge evaluated first, then the LLM edges for the rest. The variable is
    // updated mid-call by the update_dynamic_variables shared tool — see n_book instructions.
    edge('e_book_waitlist', 'n_book', toNode('n_waitlist'), attemptOver(WAITLIST_THRESHOLD)),
    edge('e_book_done', 'n_book', toNode('n_closing'),
      llm('book_appointment returned confirmed true.')),
    edge('e_book_retry', 'n_book', toNode('n_offer'),
      llm('book_appointment returned slot_already_booked, slot_unavailable or invalid_slot.')),
    edge('e_book_unclear', 'n_book', toNode('n_offer'),
      llm('The caller said something unclear, off-topic, or gave a response that does not match any other routing condition.')),
    // n_waitlist_join outbound: only the queued:true path reaches the waitlist speak node (whose
    // message says the request was noted). The queued:false path (KV down, rejected date, the
    // caller declined, or a name/phone couldn't be collected) must NOT reach that
    // truthful-only-on-persistence message. Route it to the escalation node, whose "a member of
    // the team will call you back" is the honest thing to say when the waitlist itself could not
    // be taken — and is the same offer a caller gets when the waitlist path isn't available at all.
    edge('e_waitlist_join_done', 'n_waitlist_join', toNode('n_waitlist'),
      llm('join_waitlist returned queued true; the caller has been told their request was noted.')),
    edge('e_waitlist_join_fail', 'n_waitlist_join', toNode('n_escalate'),
      llm('join_waitlist returned queued false, or the caller could not provide a name and phone number after reasonable attempts, or the caller declined to be added to the waitlist.')),
    edge('e_manage_done', 'n_manage', toNode('n_closing_manage'),
      llm('The appointment was cancelled or rescheduled successfully.')),
    edge('e_manage_retry', 'n_manage', toNode('n_offer'),
      llm('A reschedule failed because the new time was taken, unavailable or invalid, and the caller wants to try a different time.')),
    edge('e_manage_notfound', 'n_manage', toNode('n_collect'),
      llm('The tool reported appointment_not_found, or the caller cannot identify which appointment they mean.')),
    edge('e_manage_back', 'n_manage', toNode('n_collect'),
      llm('The caller changed their mind and wants something else.')),
    edge('e_manage_unclear', 'n_manage', toNode('n_collect'),
      llm('The caller said something unclear, off-topic, or gave a response that does not match any other routing condition.')),

    edge('e_closing_end', 'n_closing', toNode('n_hangup'), dflt),
    edge('e_closing_manage_end', 'n_closing_manage', toNode('n_hangup'), dflt),
    edge('e_waitlist_end', 'n_waitlist', toNode('n_hangup'), dflt),
    edge('e_escalate_end', 'n_escalate', toNode('n_hangup'), dflt),
  ];

  return {
    name: 'Riverside Dental — Scheduling Specialist',
    description: 'Books, reschedules and cancels appointments via the receptionist MCP server.',
    model: MODEL,
    // Ultra "Clara - Instructor": clear tone, precise enunciation — fits booking logistics.
    voice_settings: { voice: 'Telnyx.Ultra.01eaafa9-308a-4276-a017-6ab0cf061b1f' },
    enabled_features: ['telephony'],
    instructions: `You are the scheduling specialist at ${CLINIC}. ${COMMON_RULES} ${CLINIC_FACTS} Dates for tools are YYYY-MM-DD and times are 24h HH:MM. The current date and time at the clinic is {{telnyx_current_time_${CLINIC_TZ}}} (Central time). All appointment times are Central time: when a caller names a time without a timezone, assume Central; if they mention another timezone or sound like they are calling from elsewhere, ask which timezone they mean and convert to Central before checking availability, then repeat the time back in Central to confirm. Before calling check_availability, book_appointment, cancel_or_reschedule_appointment or join_waitlist, ALWAYS say a short line out loud first confirming what you understood (e.g. "Let me check Monday the twelfth for you" or "Booking that cleaning now") - never go straight from the caller's answer into a silent tool call, even if you are confident; the caller must hear something immediately, every time, not only when you are unsure.`,
    mcp_servers: [
      {
        id: mcpServerId,
        allowed_tools: ['check_availability', 'book_appointment', 'cancel_or_reschedule_appointment', 'join_waitlist'],
      },
    ],
    // The `update_dynamic_variables` shared tool surfaces a function to the model that writes into
    // the conversation's dynamic-variable store mid-call; the n_book instructions tell the model to
    // call it with the server-side attempt_count after each book_appointment. Shared tools are
    // attached by id (per the OpenAPI schema for `tool_ids`), not re-defined inline on update —
    // re-sending their definition creates an inline duplicate that the API rejects (error 10015).
    ...(attemptCounterToolId ? { tool_ids: [attemptCounterToolId] } : {}),
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
      id: 'n_clarify',
      name: 'Clarify',
      message: `I'm sorry, I didn't quite catch that. Could you let me know if you'd like to book or change an appointment, ask a billing question, or if you have a general question?`,
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
      edge(`e_${n}_unclear`, n, toNode('n_clarify'),
        llm('The caller said something unclear, off-topic, or gave a response that does not match any other routing condition.')),
    ]),

    edge('e_faq_sched', 'n_faq', toAssistant(schedulingId),
      llm('After the answer, the caller wants to book or change an appointment.')),
    edge('e_faq_bill', 'n_faq', toAssistant(billingId),
      llm('After the answer, the caller has a billing or insurance question.')),
    edge('e_faq_done', 'n_faq', toNode('n_goodbye'),
      llm('The caller has no more questions.')),
    edge('e_faq_unclear', 'n_faq', toNode('n_clarify'),
      llm('The caller said something unclear, off-topic, or gave a response that does not match any other routing condition.')),

    edge('e_clarify_returning', 'n_clarify', toNode('n_intent_returning'), varEquals('is_returning_patient', 'true')),
    edge('e_clarify_intent', 'n_clarify', toNode('n_intent'), dflt),
    edge('e_escalate_end', 'n_escalate', toNode('n_hangup'), dflt),
    edge('e_goodbye_end', 'n_goodbye', toNode('n_hangup'), dflt),
  ];

  return {
    name: 'Riverside Dental — Front Desk',
    description: 'Entry point: greets, identifies caller and intent, routes to specialists.',
    model: MODEL,
    // Ultra "Maeve - Steady Host": gentle, welcoming — first voice a caller hears.
    voice_settings: { voice: 'Telnyx.Ultra.02a924f6-bb49-4177-8fbb-52238c5056d6' },
    enabled_features: ['telephony'],
    greeting: '', // the Greeting speak node delivers the opening line instead
    instructions: `You are the front-desk receptionist at ${CLINIC}. ${COMMON_RULES} ${CLINIC_FACTS}`,
    ...webhook(webhookUrl),
    telephony_settings: { user_idle_timeout_secs: 20 },
    conversation_flow: { start_node_id: 'n_greeting', nodes, edges },
  };
}
