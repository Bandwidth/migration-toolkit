// src/server/errors.ts

/** Structured error body — same shape as twilioErrors in src/twilio/call-resource.ts. */
export interface AdapterError {
  code: number;
  message: string;
  more_info: string;
  status: number;
}

// Adapter-private code range. Deliberately NOT in Twilio's registry — reusing a
// real Twilio code (e.g. 21610 = STOP/unsubscribed) with a twilio.com link would
// misdiagnose an adapter failure.
const DOCS = "https://github.com/Bandwidth/bw-voice-adapter/blob/main/AGENTS.md#errors";

/** Operational errors the adapter itself raises (distinct from Twilio-API-compat errors). */
export const adapterErrors = {
  /** A required request parameter was absent. */
  missingParam(name: string): AdapterError {
    return { code: 90001, message: `Missing required parameter: ${name}`, more_info: DOCS, status: 400 };
  },
  /** An unhandled internal failure. Neutral by design — no upstream detail leaked. */
  internal(): AdapterError {
    return { code: 90002, message: "Internal adapter error", more_info: DOCS, status: 500 };
  },
} as const;
