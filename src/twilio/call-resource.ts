/**
 * Twilio call-resource JSON, shaped to match the live API fixture
 * (test/fixtures/twilio/call-resource.json) with create-time values.
 */

/** RFC2822 with "+0000" suffix, as Twilio formats dates (not "GMT"). */
export function twilioDate(d: Date): string {
  return d.toUTCString().replace(/GMT$/, "+0000");
}

/**
 * Map a Bandwidth call state to the nearest Twilio call status.
 * BW's call-state enum is not fully enumerated in public docs; "active" and
 * "disconnected" are documented. Unknown states fall back to "in-progress".
 */
export function bwStateToTwilioStatus(state: string): string {
  switch (state) {
    case "active":
      return "in-progress";
    case "disconnected":
      return "completed";
    default:
      return "in-progress";
  }
}

export function createdCallResource(opts: {
  sid: string;
  accountSid: string;
  to: string;
  from: string;
  direction?: string;
  status?: string;
  startTime?: string;
  endTime?: string;
  duration?: string;
  now?: Date;
}): Record<string, unknown> {
  const { sid, accountSid, to, from } = opts;
  const date = twilioDate(opts.now ?? new Date());
  const base = `/2010-04-01/Accounts/${accountSid}/Calls/${sid}`;
  return {
    account_sid: accountSid,
    annotation: null,
    answered_by: null,
    api_version: "2010-04-01",
    caller_name: null,
    date_created: date,
    date_updated: date,
    direction: opts.direction ?? "outbound-api",
    duration: opts.duration ?? null,
    end_time: opts.endTime ? twilioDate(new Date(opts.endTime)) : null,
    forwarded_from: null,
    from,
    from_formatted: from,
    group_sid: null,
    parent_call_sid: null,
    phone_number_sid: null,
    price: null,
    price_unit: "USD",
    queue_time: "0",
    sid,
    start_time: opts.startTime ? twilioDate(new Date(opts.startTime)) : null,
    status: opts.status ?? "queued",
    subresource_uris: {
      events: `${base}/Events.json`,
      notifications: `${base}/Notifications.json`,
      payments: `${base}/Payments.json`,
      recordings: `${base}/Recordings.json`,
      siprec: `${base}/Siprec.json`,
      streams: `${base}/Streams.json`,
      transcriptions: `${base}/Transcriptions.json`,
      user_defined_message_subscriptions: `${base}/UserDefinedMessageSubscriptions.json`,
      user_defined_messages: `${base}/UserDefinedMessages.json`,
    },
    to,
    to_formatted: to,
    trunk_sid: "",
    uri: `${base}.json`,
  };
}

/** Twilio error bodies, byte-matched to live fixtures (test/fixtures/twilio/errors.json). */
export const twilioErrors = {
  auth401: {
    code: 20003,
    message: "Authenticate",
    more_info: "https://www.twilio.com/docs/errors/20003",
    status: 401,
  },
  missingTo400: {
    code: 21201,
    message: "No 'To' number is specified",
    more_info: "https://www.twilio.com/docs/errors/21201",
    status: 400,
  },
  missingUrl400: {
    code: 21205,
    message: "Url parameter is required.",
    more_info: "https://www.twilio.com/docs/errors/21205",
    status: 400,
  },
  // Documented code; not fixture-verified (probe skipped to avoid placing a live call).
  missingFrom400: {
    code: 21213,
    message: "From phone number is required.",
    more_info: "https://www.twilio.com/docs/errors/21213",
    status: 400,
  },
  /** 404 for an unknown call; message embeds the request path, matching live Twilio. */
  notFound(accountSid: string, callSid: string) {
    return {
      code: 20404,
      message: `The requested resource /2010-04-01/Accounts/${accountSid}/Calls/${callSid}.json was not found`,
      more_info: "https://www.twilio.com/docs/errors/20404",
      status: 404,
    };
  },
  /**
   * 400 for an unsupported recording-control Status. Translator-specific (not a
   * fixture-verified Twilio code): Bandwidth's recording REST does pause/resume
   * only — there is no REST stop (StopRecording is a BXML verb).
   */
  recordingControl400(status: string) {
    return {
      code: 21220,
      message:
        status === "stopped"
          ? "Status=stopped is not supported: Bandwidth has no REST recording-stop (StopRecording is a BXML verb only). Use Status=paused or in-progress."
          : `Unsupported recording Status "${status ?? ""}": use paused (pause) or in-progress (resume).`,
      more_info: "https://www.twilio.com/docs/errors/21220",
      status: 400,
    };
  },
} as const;
