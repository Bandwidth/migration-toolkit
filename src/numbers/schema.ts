/**
 * Canonical number-lifecycle schemas.
 *
 * Covers four stages:
 *   discover  – search for available numbers (Twilio AvailablePhoneNumbers)
 *   acquire   – purchase/order a number (Twilio IncomingPhoneNumbers POST)
 *   activate  – configure the number (webhook URLs, capabilities)
 *   operate   – list and disconnect numbers on the account
 *
 * Twilio field names are taken from:
 *   https://www.twilio.com/docs/phone-numbers/api/availablephonenumberlocal-resource
 *   https://www.twilio.com/docs/phone-numbers/api/incomingphonenumber-resource
 *
 * Bandwidth field names are taken from:
 *   https://dev.bandwidth.com/apis/numbers-apis/numbers  (GET /numbers)
 *   https://dev.bandwidth.com/docs/numbers/guides/searchingForNumbers
 *   https://dev.bandwidth.com/apis/numbers-apis/number-acquisition  (POST /accounts/{id}/orders)
 *   @bandwidth/node-numbers SDK README
 */

import { z } from "zod";

// ── Lifecycle stage ──────────────────────────────────────────────────────────

/**
 * The four stages of a number's life inside a migration:
 *  - discover  → query available inventory
 *  - acquire   → order / purchase
 *  - activate  → attach webhooks / capabilities
 *  - operate   → list active numbers, disconnect
 */
export const NumberLifecycleStageSchema = z.enum(["discover", "acquire", "activate", "operate"]);
export type NumberLifecycleStage = z.infer<typeof NumberLifecycleStageSchema>;

// ── HTTP method enum (reused for Twilio webhook method fields) ───────────────

const HttpMethodSchema = z.enum(["GET", "POST"]);

// ── Twilio: AvailablePhoneNumbers search criteria ────────────────────────────
//
// Source: https://www.twilio.com/docs/phone-numbers/api/availablephonenumberlocal-resource
//
// All fields are optional; the caller must supply at least something useful,
// but the schema itself does not enforce combinations (that's the search API's job).

export const TwilioSearchParamsSchema = z.object({
  /** 3-digit area code. US/Canada only. */
  areaCode: z.string().optional(),

  /**
  * Pattern match: 2–16 chars using digits, letters, and meta-characters
  * (*, %, +, $). Requires at least two non-meta characters.
  */
  contains: z.string().min(2).max(16).optional(),

  /** State or province abbreviation (e.g. "CA", "NC"). US/Canada only. */
  inRegion: z.string().optional(),

  /** Postal/ZIP code. US/Canada only. */
  inPostalCode: z.string().optional(),

  /** City or locality. */
  inLocality: z.string().optional(),

  /** Rate center abbreviation. Must be paired with inRegion. US/Canada only. */
  inRateCenter: z.string().optional(),

  /** Local Access and Transport Area code. US/Canada only. */
  inLata: z.string().optional(),

  /** Search near this E.164 number. US/Canada only. */
  nearNumber: z.string().optional(),

  /** "lat,long" pair. US/Canada only. */
  nearLatLong: z.string().optional(),

  /** Search radius in miles (0–500, default 25). US/Canada only. */
  distance: z.number().int().min(0).max(500).optional(),

  /** ISO-3166-1 alpha-2 country code (e.g. "US", "CA"). Defaults to "US". */
  country: z.string().length(2).optional(),

  voiceEnabled: z.boolean().optional(),
  smsEnabled: z.boolean().optional(),
  mmsEnabled: z.boolean().optional(),
  faxEnabled: z.boolean().optional(),

  /** Exclude numbers that require any type of address registration. */
  excludeAllAddressRequired: z.boolean().optional(),
  /** Exclude numbers that require a local address. */
  excludeLocalAddressRequired: z.boolean().optional(),
  /** Exclude numbers that require a foreign address. */
  excludeForeignAddressRequired: z.boolean().optional(),

  /** Whether to include beta (newly added) numbers. Default: true. */
  beta: z.boolean().optional(),

  /** Max results to return (1–1000, default 50). */
  pageSize: z.number().int().min(1).max(1000).optional(),
});

export type TwilioSearchParams = z.infer<typeof TwilioSearchParamsSchema>;

// ── Twilio: IncomingPhoneNumbers purchase params ─────────────────────────────
//
// Source: https://www.twilio.com/docs/phone-numbers/api/incomingphonenumber-resource  (POST)
//
// Either phoneNumber (E.164) or areaCode must be supplied.

export const TwilioPurchaseParamsSchema = z
  .object({
    /** E.164 phone number to purchase. Required when areaCode is absent. */
    phoneNumber: z.string().optional(),

    /** Area code for automatic number selection. US/Canada only. Required when phoneNumber is absent. */
    areaCode: z.string().optional(),

    /** Human-readable label (up to 64 chars). */
    friendlyName: z.string().max(64).optional(),

    /** Webhook URL called when the number receives a voice call. */
    voiceUrl: z.string().url().optional(),
    voiceMethod: HttpMethodSchema.optional(),
    voiceFallbackUrl: z.string().url().optional(),
    voiceFallbackMethod: HttpMethodSchema.optional(),

    /** Whether to look up caller name from CNAM. */
    voiceCallerIdLookup: z.boolean().optional(),

    /** Webhook URL called for incoming SMS. */
    smsUrl: z.string().url().optional(),
    smsMethod: HttpMethodSchema.optional(),
    smsFallbackUrl: z.string().url().optional(),
    smsFallbackMethod: HttpMethodSchema.optional(),

    /** Call-status webhook. */
    statusCallback: z.string().url().optional(),
    statusCallbackMethod: HttpMethodSchema.optional(),

    /** SID of a Twilio Application that handles calls on this number. */
    voiceApplicationSid: z.string().optional(),
    /** SID of a Twilio Application that handles SMS on this number. */
    smsApplicationSid: z.string().optional(),

    /** SID of a Twilio Trunk to route calls through. */
    trunkSid: z.string().optional(),

    /** SID of an Address resource for regulatory compliance. */
    addressSid: z.string().optional(),

    /** SID of a Bundle (regulatory package). */
    bundleSid: z.string().optional(),

    /** Whether emergency calling is active ("Active" | "Inactive"). */
    emergencyStatus: z.enum(["Active", "Inactive"]).optional(),
    emergencyAddressSid: z.string().optional(),
  })
  .refine((v) => v.phoneNumber !== undefined || v.areaCode !== undefined, {
    message: "Either phoneNumber or areaCode must be provided",
  });

export type TwilioPurchaseParams = z.infer<typeof TwilioPurchaseParamsSchema>;

// ── Bandwidth: Available-numbers search params ───────────────────────────────
//
// Sources:
//   GET /numbers  → https://dev.bandwidth.com/apis/numbers-apis/numbers
//   GET /api/v2/accounts/{accountId}/availableNumbers
//       → https://dev.bandwidth.com/docs/universal-platform/order-numbers
//   @bandwidth/node-numbers AvailableNumbers.listAsync(options)

export const BwSearchParamsSchema = z.object({
  /** 3-digit area code. */
  areaCode: z.string().optional(),

  /** Two-letter state abbreviation (e.g. "NC", "CA"). */
  state: z.string().optional(),

  /** City name. Requires state when used on the legacy v2 endpoint. */
  city: z.string().optional(),

  /** 5-digit (or 9-digit) ZIP code. */
  zip: z.string().optional(),

  /** LATA code. */
  lata: z.string().optional(),

  /** Rate center abbreviation. */
  rateCenter: z.string().optional(),

  /** 6-digit NPA-NXX prefix. */
  npaNxx: z.string().optional(),

  /** 7-digit NPA-NXXX prefix. */
  npaNxxx: z.string().optional(),

  /** 4–7 character local vanity string (alphanumeric). */
  localVanity: z.string().min(4).max(7).optional(),

  /** Maximum results to return. */
  quantity: z.number().int().min(1).optional(),

  /** Include rate center / city / state detail in each result. */
  enableTNDetail: z.boolean().optional(),

  /**
   * ISO 3166-1 alpha-3 country code (e.g. "USA", "CAN", "GBR").
   * Defaults to "USA,CAN" for NANP searches.
   */
  countryCodeA3: z.string().length(3).optional(),

  /**
   * Number type filter.
   * Docs: https://dev.bandwidth.com/apis/numbers-apis/numbers
   */
  phoneNumberType: z
    .enum(["GEOGRAPHIC", "NATIONAL", "MOBILE", "TOLL_FREE", "SHARED_COST"])
    .optional(),
});

export type BwSearchParams = z.infer<typeof BwSearchParamsSchema>;

// ── Bandwidth: Order request ─────────────────────────────────────────────────
//
// Sources:
//   POST /accounts/{accountId}/orders → https://dev.bandwidth.com/apis/numbers-apis/number-acquisition
//   @bandwidth/node-numbers Order.create(options, callback)
//
// The BW order API supports many "search-and-order" types; we surface the
// two most useful here: area-code search and explicit telephone number.

const AreaCodeSearchAndOrderTypeSchema = z.object({
  /** 3-digit area code to search and order from. */
  areaCode: z.string(),
  /** Number of TNs to order from this area code. */
  quantity: z.number().int().min(1),
});

const ExistingTelephoneNumberOrderTypeSchema = z.object({
  /** E.164 numbers to order (must already appear in BW available inventory). */
  telephoneNumberList: z.array(z.string()).min(1),
});

export const BwOrderRequestSchema = z.object({
  /** Human-readable name for this order. */
  name: z.string(),

  /** Bandwidth site (sub-account) ID where numbers will be provisioned. */
  siteId: z.string(),

  /** Bandwidth SIP peer ID under the site. Optional but recommended. */
  peerId: z.string().optional(),

  /** Total quantity of numbers requested. */
  quantity: z.number().int().min(1).optional(),

  /** Customer-supplied reference ID (idempotency key). */
  customerOrderId: z.string().optional(),

  /** Search and order by area code. Mutually exclusive with existingTelephoneNumberOrderType. */
  areaCodeSearchAndOrderType: AreaCodeSearchAndOrderTypeSchema.optional(),

  /** Order specific known numbers. Mutually exclusive with areaCodeSearchAndOrderType. */
  existingTelephoneNumberOrderType: ExistingTelephoneNumberOrderTypeSchema.optional(),
}).refine(
  (v) => !(v.areaCodeSearchAndOrderType && v.existingTelephoneNumberOrderType),
  { message: "areaCodeSearchAndOrderType and existingTelephoneNumberOrderType are mutually exclusive" },
);

export type BwOrderRequest = z.infer<typeof BwOrderRequestSchema>;

// ── Bandwidth: Order response ────────────────────────────────────────────────

// UNVERIFIED — EXPERIMENTAL. Auth is OAuth2 Bearer (shared platform token,
// verified live), but live testing (2026-06-19) never got as far as a response:
// the v2 JSON order endpoint rejects the *request* body
// ("Invalid data type for field 'existingTelephoneNumberOrderType'"), so both
// BwOrderRequest and this response envelope are still guesses. Capture `band`'s
// real request/response to pin the schema before relying on ordering. Kept
// lenient (.passthrough, optional fields) so nothing is silently dropped.
export const BwOrderResponseSchema = z
  .object({
    /** Bandwidth-assigned order UUID. */
    id: z.string().optional(),

    /** Current status of the order. */
    orderStatus: z.enum(["RECEIVED", "PROCESSING", "COMPLETE", "FAILED", "PARTIAL"]),

    /** ISO-8601 timestamp of order creation. */
    orderCreateDate: z.string().optional(),

    /** Numbers provisioned once the order reaches COMPLETE state. */
    telephoneNumbers: z.array(z.string()).optional(),
  })
  .passthrough();

export type BwOrderResponse = z.infer<typeof BwOrderResponseSchema>;
