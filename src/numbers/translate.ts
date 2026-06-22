/**
 * Translators for the two highest-value number-lifecycle operations:
 *
 *  1. translateSearchParams  – Twilio AvailablePhoneNumbers search criteria
 *                              → Bandwidth available-number search params
 *
 *  2. translatePurchaseToOrder – Twilio IncomingPhoneNumbers POST (purchase)
 *                                → Bandwidth number-order shape
 *
 * Gaps are surfaced as structured GapItem objects (not thrown as errors) so
 * callers can log or display them. This mirrors the finding/warning pattern
 * used in the voice-call translator (src/translator/translate.ts).
 */

import type {
  TwilioSearchParams,
  TwilioPurchaseParams,
  BwSearchParams,
  BwOrderRequest,
} from "./schema.js";

// ── Gap reporting ─────────────────────────────────────────────────────────────

/**
 * Describes a Twilio field that has no direct Bandwidth equivalent.
 * The adapter records it rather than silently dropping it.
 */
export interface GapItem {
  /** The Twilio parameter name that could not be mapped. */
  twilioParam: string;
  /** Brief explanation of why it cannot be translated. */
  reason: string;
}

// ── Search translation ────────────────────────────────────────────────────────

export interface SearchTranslation {
  bwParams: BwSearchParams;
  gaps: GapItem[];
}

/**
 * ISO 3166-1 alpha-2 → alpha-3 for the countries Bandwidth's Numbers API
 * explicitly supports. Extend as needed.
 *
 * Bandwidth docs: countryCodeA3 defaults to "USA,CAN" for NANP searches.
 */
// Only the handful of country codes that Bandwidth's Numbers API explicitly
// supports beyond the NANP default (USA, CAN). Source: dev.bandwidth.com
// countryCodeA3 param docs. International support is limited and varies by
// account type; treat anything outside this table as a gap.
const SUPPORTED_ALPHA2_TO_ALPHA3: Record<string, string> = {
  US: "USA",
  CA: "CAN",
};

/**
 * Translate Twilio AvailablePhoneNumbers search criteria into Bandwidth
 * available-number search params.
 *
 * Field mapping sources:
 *   Twilio: https://www.twilio.com/docs/phone-numbers/api/availablephonenumberlocal-resource
 *   Bandwidth: https://dev.bandwidth.com/apis/numbers-apis/numbers
 *              https://dev.bandwidth.com/docs/numbers/guides/searchingForNumbers
 */
export function translateSearchParams(twilio: TwilioSearchParams): SearchTranslation {
  const bwParams: BwSearchParams = {};
  const gaps: GapItem[] = [];

  // Direct / near-direct mappings
  if (twilio.areaCode !== undefined) bwParams.areaCode = twilio.areaCode;
  if (twilio.inRegion !== undefined) bwParams.state = twilio.inRegion;
  if (twilio.inPostalCode !== undefined) bwParams.zip = twilio.inPostalCode;
  if (twilio.inLocality !== undefined) bwParams.city = twilio.inLocality;
  if (twilio.inRateCenter !== undefined) bwParams.rateCenter = twilio.inRateCenter;
  if (twilio.inLata !== undefined) bwParams.lata = twilio.inLata;

  // pageSize → quantity
  if (twilio.pageSize !== undefined) bwParams.quantity = twilio.pageSize;

  // country: alpha-2 → alpha-3 for known values; gap otherwise
  if (twilio.country !== undefined) {
    const alpha3 = SUPPORTED_ALPHA2_TO_ALPHA3[twilio.country.toUpperCase()];
    if (alpha3) {
      bwParams.countryCodeA3 = alpha3;
    } else {
      gaps.push({
        twilioParam: "country",
        reason: `Country "${twilio.country}" has no known Bandwidth alpha-3 mapping; set countryCodeA3 manually.`,
      });
    }
  }

  // ── Fields with no Bandwidth equivalent ──────────────────────────────────

  // Twilio pattern-match (wildcard) search has no BW equivalent.
  // BW offers localVanity but it operates on last 4–7 digits, not a full
  // wildcard pattern across the whole number.
  if (twilio.contains !== undefined) {
    gaps.push({
      twilioParam: "contains",
      reason:
        "Twilio pattern matching (contains) has no direct Bandwidth equivalent. " +
        "Use localVanity in BW search params for digit-suffix matching.",
    });
  }

  // Geo-proximity search is Twilio-only.
  if (twilio.nearNumber !== undefined) {
    gaps.push({
      twilioParam: "nearNumber",
      reason:
        "Bandwidth does not support geo-proximity search by phone number. " +
        "Use state/city/rateCenter params to approximate a geographic area.",
    });
  }
  if (twilio.nearLatLong !== undefined) {
    gaps.push({
      twilioParam: "nearLatLong",
      reason:
        "Bandwidth does not support geo-proximity search by lat/long coordinates. " +
        "Use state/city/rateCenter params to approximate a geographic area.",
    });
  }
  // distance is only meaningful alongside nearNumber/nearLatLong, so no
  // separate gap entry — callers will notice those are already gapped.

  // Capability filters: Bandwidth does not expose per-number capability
  // filters at search time. All NANP numbers support voice; SMS/MMS capability
  // is determined by account configuration, not the number itself.
  if (twilio.voiceEnabled !== undefined) {
    gaps.push({
      twilioParam: "voiceEnabled",
      reason:
        "Bandwidth does not expose per-number voice capability filtering at search time.",
    });
  }
  if (twilio.smsEnabled !== undefined) {
    gaps.push({
      twilioParam: "smsEnabled",
      reason:
        "Bandwidth does not expose per-number SMS capability filtering at search time.",
    });
  }
  if (twilio.mmsEnabled !== undefined) {
    gaps.push({
      twilioParam: "mmsEnabled",
      reason:
        "Bandwidth does not expose per-number MMS capability filtering at search time.",
    });
  }
  if (twilio.faxEnabled !== undefined) {
    gaps.push({
      twilioParam: "faxEnabled",
      reason:
        "Bandwidth does not support fax-capable number filtering. Fax is not a supported service.",
    });
  }

  // Address-required exclusion filters: Bandwidth handles regulatory
  // requirements differently (via BundleRequirements at ordering time).
  if (twilio.excludeAllAddressRequired !== undefined) {
    gaps.push({
      twilioParam: "excludeAllAddressRequired",
      reason:
        "Bandwidth handles address requirements at order time via RequirementsPackageId, " +
        "not at search time.",
    });
  }
  if (twilio.excludeLocalAddressRequired !== undefined) {
    gaps.push({
      twilioParam: "excludeLocalAddressRequired",
      reason:
        "Bandwidth handles address requirements at order time via RequirementsPackageId, " +
        "not at search time.",
    });
  }
  if (twilio.excludeForeignAddressRequired !== undefined) {
    gaps.push({
      twilioParam: "excludeForeignAddressRequired",
      reason:
        "Bandwidth handles address requirements at order time via RequirementsPackageId, " +
        "not at search time.",
    });
  }

  // beta: Bandwidth does not have a concept of beta numbers in its search API.
  // Intentionally silently ignored (it's a Twilio platform-administration detail).

  return { bwParams, gaps };
}

// ── Purchase translation ──────────────────────────────────────────────────────

export interface PurchaseContext {
  /** Bandwidth site (sub-account) ID. Required for order creation. */
  siteId: string;
  /** Bandwidth SIP peer ID (optional but recommended). */
  peerId?: string;
  /** Human-readable order name. Defaults to "Migrated from Twilio". */
  orderName?: string;
}

export interface PurchaseTranslation {
  bwOrder: BwOrderRequest;
  gaps: GapItem[];
}

/**
 * Translate a Twilio IncomingPhoneNumbers POST (purchase) into a Bandwidth
 * number-order shape.
 *
 * The two BW search-and-order types used here:
 *   - existingTelephoneNumberOrderType: for an explicit E.164 phoneNumber
 *   - areaCodeSearchAndOrderType: for an area-code-only purchase
 *
 * Sources:
 *   Twilio: https://www.twilio.com/docs/phone-numbers/api/incomingphonenumber-resource
 *   Bandwidth: https://dev.bandwidth.com/apis/numbers-apis/number-acquisition
 *              @bandwidth/node-numbers Order.create()
 */
export function translatePurchaseToOrder(
  twilio: TwilioPurchaseParams,
  ctx: PurchaseContext,
): PurchaseTranslation {
  const gaps: GapItem[] = [];
  const orderName = ctx.orderName ?? "Migrated from Twilio";

  // No top-level `quantity`: the Bandwidth v2 JSON order API rejects it
  // ("Invalid data type for field 'quantity'", verified live 2026-06-19).
  // Quantity is implicit in the TN list, or nested inside areaCodeSearchAndOrderType.
  const bwOrder: BwOrderRequest = {
    name: orderName,
    siteId: ctx.siteId,
    ...(ctx.peerId ? { peerId: ctx.peerId } : {}),
  };

  // Route to the correct BW order type based on whether we have a specific
  // number or just an area code.
  if (twilio.phoneNumber !== undefined) {
    bwOrder.existingTelephoneNumberOrderType = {
      telephoneNumberList: [twilio.phoneNumber],
    };
  } else if (twilio.areaCode !== undefined) {
    bwOrder.areaCodeSearchAndOrderType = {
      areaCode: twilio.areaCode,
      quantity: 1,
    };
  }

  // ── Fields with no Bandwidth order equivalent ─────────────────────────────
  //
  // Twilio's IncomingPhoneNumbers purchase bundles two concerns: acquiring the
  // number AND configuring its webhooks/capabilities in one call. Bandwidth
  // separates acquisition (Order API) from configuration (Numbers/Phone Numbers
  // API). These webhook fields must be applied post-acquisition.

  if (twilio.friendlyName !== undefined) {
    gaps.push({
      twilioParam: "friendlyName",
      reason:
        "Bandwidth orders do not carry a friendly name. Apply via the Phone Numbers API after provisioning.",
    });
  }
  if (twilio.voiceUrl !== undefined) {
    gaps.push({
      twilioParam: "voiceUrl",
      reason:
        "Bandwidth separates number acquisition from webhook configuration. " +
        "Set the application/webhook after the order completes using the Bandwidth Voice API.",
    });
  }
  if (twilio.voiceMethod !== undefined) {
    gaps.push({
      twilioParam: "voiceMethod",
      reason: "Webhook HTTP method must be configured post-acquisition on the Bandwidth side.",
    });
  }
  if (twilio.voiceFallbackUrl !== undefined) {
    gaps.push({
      twilioParam: "voiceFallbackUrl",
      reason: "Fallback webhooks must be configured post-acquisition on the Bandwidth side.",
    });
  }
  if (twilio.voiceFallbackMethod !== undefined) {
    gaps.push({
      twilioParam: "voiceFallbackMethod",
      reason: "Fallback webhook HTTP method must be configured post-acquisition.",
    });
  }
  if (twilio.voiceCallerIdLookup !== undefined) {
    gaps.push({
      twilioParam: "voiceCallerIdLookup",
      reason:
        "CNAM lookup is controlled per-call in the Bandwidth Voice API, not at number configuration.",
    });
  }
  if (twilio.smsUrl !== undefined) {
    gaps.push({
      twilioParam: "smsUrl",
      reason:
        "SMS webhook must be configured via the Bandwidth Messaging API after the number is provisioned.",
    });
  }
  if (twilio.smsMethod !== undefined) {
    gaps.push({
      twilioParam: "smsMethod",
      reason: "SMS webhook HTTP method must be configured post-acquisition.",
    });
  }
  if (twilio.smsFallbackUrl !== undefined) {
    gaps.push({
      twilioParam: "smsFallbackUrl",
      reason: "SMS fallback webhook must be configured post-acquisition.",
    });
  }
  if (twilio.smsFallbackMethod !== undefined) {
    gaps.push({
      twilioParam: "smsFallbackMethod",
      reason: "SMS fallback webhook HTTP method must be configured post-acquisition.",
    });
  }
  if (twilio.statusCallback !== undefined) {
    gaps.push({
      twilioParam: "statusCallback",
      reason:
        "Status callbacks are configured per-call or per-application in Bandwidth, " +
        "not at number provisioning time.",
    });
  }
  if (twilio.statusCallbackMethod !== undefined) {
    gaps.push({
      twilioParam: "statusCallbackMethod",
      reason: "Status callback HTTP method must be configured post-acquisition.",
    });
  }
  for (const param of ["voiceApplicationSid", "smsApplicationSid"] as const) {
    if (twilio[param] !== undefined) {
      gaps.push({
        twilioParam: param,
        reason:
          "Twilio Application SIDs have no equivalent in Bandwidth. " +
          "Configure webhooks directly on the Bandwidth application post-acquisition.",
      });
    }
  }
  if (twilio.trunkSid !== undefined) {
    gaps.push({
      twilioParam: "trunkSid",
      reason:
        "Twilio Elastic SIP Trunking SIDs have no direct equivalent in Bandwidth number orders.",
    });
  }
  if (twilio.addressSid !== undefined) {
    gaps.push({
      twilioParam: "addressSid",
      reason:
        "Regulatory address requirements in Bandwidth are handled via RequirementsPackageId " +
        "at order time or separately through the Compliance API.",
    });
  }
  if (twilio.bundleSid !== undefined) {
    gaps.push({
      twilioParam: "bundleSid",
      reason:
        "Twilio Bundle SIDs map loosely to Bandwidth RequirementsPackageId. " +
        "Set requirementsPackageId on the order if regulatory bundles are needed.",
    });
  }
  for (const param of ["emergencyStatus", "emergencyAddressSid"] as const) {
    if (twilio[param] !== undefined) {
      gaps.push({
        twilioParam: param,
        reason:
          "Emergency services configuration is handled via the Bandwidth 911 API, " +
          "not the number order.",
      });
    }
  }

  return { bwOrder, gaps };
}
