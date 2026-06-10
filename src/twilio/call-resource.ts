/**
 * Twilio call-resource JSON, shaped to match the live API fixture
 * (test/fixtures/twilio/call-resource.json) with create-time values.
 */

/** RFC2822 with "+0000" suffix, as Twilio formats dates (not "GMT"). */
export function twilioDate(d: Date): string {
  return d.toUTCString().replace(/GMT$/, "+0000");
}

export function createdCallResource(opts: {
  sid: string;
  accountSid: string;
  to: string;
  from: string;
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
    direction: "outbound-api",
    duration: null,
    end_time: null,
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
    start_time: null,
    status: "queued",
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
} as const;
