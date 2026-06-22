/**
 * Twilio phone-number resource shapes, for the number-lifecycle REST facade:
 *
 *   GET  .../AvailablePhoneNumbers/{Country}/Local.json  → availablePhoneNumbersList
 *   POST .../IncomingPhoneNumbers.json (purchase)        → incomingPhoneNumberResource
 *
 * Mirrors the shaping pattern in call-resource.ts / recording-resource.ts.
 * These shapes follow Twilio's documented JSON but are NOT fixture-verified
 * against a live order (the same Numbers-role gap noted in numbers/schema.ts),
 * so fields Bandwidth's search does not return are emitted as null rather than
 * fabricated.
 */

import type { AvailableNumber } from "../numbers/client.js";
import { toIncomingPhoneNumberSid } from "./call-sid.js";
import { twilioDate } from "./call-resource.js";

/** Format a NANP E.164 number as Twilio's friendly "(NXX) NXX-XXXX"; pass others through. */
export function friendlyName(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

/**
 * Shape one Bandwidth available number as a Twilio AvailablePhoneNumber.
 * Bandwidth's search does not return lat/long/LATA/postal or per-number
 * capability flags; those are emitted as null/best-effort. All NANP numbers are
 * voice-capable, so `voice` is true; SMS/MMS depend on account messaging
 * configuration (not the number), so they are reported true as the NANP default.
 */
export function availablePhoneNumberResource(
  n: AvailableNumber,
  isoCountry: string,
): Record<string, unknown> {
  return {
    friendly_name: friendlyName(n.fullNumber),
    phone_number: n.fullNumber,
    lata: null,
    rate_center: n.rateCenter ?? null,
    latitude: null,
    longitude: null,
    locality: n.city ?? null,
    region: n.state ?? null,
    postal_code: null,
    iso_country: isoCountry,
    address_requirements: "none",
    beta: false,
    capabilities: { voice: true, SMS: true, MMS: true },
  };
}

/** Twilio's list envelope for an AvailablePhoneNumbers search. */
export function availablePhoneNumbersList(
  numbers: AvailableNumber[],
  accountSid: string,
  isoCountry: string,
): Record<string, unknown> {
  return {
    available_phone_numbers: numbers.map((n) => availablePhoneNumberResource(n, isoCountry)),
    uri: `/2010-04-01/Accounts/${accountSid}/AvailablePhoneNumbers/${isoCountry}/Local.json`,
  };
}

/**
 * Shape a provisioned number as a Twilio IncomingPhoneNumber resource — the
 * body returned from a successful purchase. `voiceUrl` reflects what the caller
 * asked us to set even though Bandwidth applies webhook config post-acquisition
 * (see the gaps surfaced by translatePurchaseToOrder).
 */
export function incomingPhoneNumberResource(opts: {
  phoneNumber: string;
  accountSid: string;
  friendlyName?: string;
  voiceUrl?: string;
  voiceMethod?: string;
  statusCallback?: string;
  now?: Date;
}): Record<string, unknown> {
  const sid = toIncomingPhoneNumberSid(opts.phoneNumber);
  const date = twilioDate(opts.now ?? new Date());
  return {
    sid,
    account_sid: opts.accountSid,
    friendly_name: opts.friendlyName ?? friendlyName(opts.phoneNumber),
    phone_number: opts.phoneNumber,
    voice_url: opts.voiceUrl ?? null,
    voice_method: opts.voiceMethod ?? "POST",
    voice_fallback_url: null,
    voice_fallback_method: "POST",
    status_callback: opts.statusCallback ?? null,
    status_callback_method: "POST",
    sms_url: null,
    sms_method: "POST",
    voice_caller_id_lookup: false,
    api_version: "2010-04-01",
    date_created: date,
    date_updated: date,
    capabilities: { voice: true, SMS: true, MMS: true, fax: false },
    beta: false,
    origin: "origin",
    trunk_sid: null,
    emergency_status: "Inactive",
    emergency_address_sid: null,
    uri: `/2010-04-01/Accounts/${opts.accountSid}/IncomingPhoneNumbers/${sid}.json`,
  };
}

/** Adapter-specific error bodies for the numbers facade, shaped like Twilio errors. */
export const numberErrors = {
  /** The adapter has no Numbers client / siteId configured. */
  notConfigured: {
    code: 21601,
    message:
      "Number provisioning is not configured on this adapter (Bandwidth Numbers client / siteId missing).",
    more_info: "https://www.twilio.com/docs/errors/21601",
    status: 400,
  },
  /** Neither PhoneNumber nor AreaCode supplied on a purchase. */
  missingNumberOrAreaCode: {
    code: 21602,
    message: "Either a 'PhoneNumber' or an 'AreaCode' is required to purchase a number.",
    more_info: "https://www.twilio.com/docs/errors/21602",
    status: 400,
  },
  /** 404 for an unknown IncomingPhoneNumber SID (path mirrors live Twilio). */
  notFound(accountSid: string, sid: string) {
    return {
      code: 20404,
      message: `The requested resource /2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers/${sid}.json was not found`,
      more_info: "https://www.twilio.com/docs/errors/20404",
      status: 404,
    };
  },
  /** The Bandwidth order came back FAILED. */
  orderFailed(detail: string) {
    return {
      code: 21603,
      message: `The number order could not be completed: ${detail}`,
      more_info: "https://www.twilio.com/docs/errors/21603",
      status: 400,
    };
  },
} as const;
