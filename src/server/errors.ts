// src/server/errors.ts

/** Structured error body — same shape as twilioErrors in src/twilio/call-resource.ts. */
export interface ServerError {
  code: number;
  message: string;
  more_info: string;
  status: number;
}

// Translator-private code range. Deliberately NOT in Twilio's registry — reusing a
// real Twilio code (e.g. 21610 = STOP/unsubscribed) with a twilio.com link would
// misdiagnose a translator failure.
const DOCS = "https://github.com/Bandwidth/migration-toolkit/blob/main/AGENTS.md#errors";

/** Operational errors the translator itself raises (distinct from Twilio-API-compat errors). */
export const serverErrors = {
  /** A required request parameter was absent. */
  missingParam(name: string): ServerError {
    return { code: 90001, message: `Missing required parameter: ${name}`, more_info: DOCS, status: 400 };
  },
  /** An unhandled internal failure. Neutral by design — no upstream detail leaked. */
  internal(): ServerError {
    return { code: 90002, message: "Internal translator error", more_info: DOCS, status: 500 };
  },
  /** A request parameter was present but failed validation. */
  invalidParam(name: string): ServerError {
    return { code: 90004, message: `Invalid parameter: ${name}`, more_info: DOCS, status: 400 };
  },
} as const;
