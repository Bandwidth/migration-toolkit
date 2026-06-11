/**
 * Unit tests for the number-lifecycle zod schemas.
 * Written first (TDD) — these fail until src/numbers/schema.ts is implemented.
 */

import { describe, it, expect } from "vitest";
import {
  TwilioSearchParamsSchema,
  TwilioPurchaseParamsSchema,
  BwSearchParamsSchema,
  BwOrderRequestSchema,
  BwOrderResponseSchema,
  NumberLifecycleStageSchema,
} from "../src/numbers/schema.js";

// ── TwilioSearchParamsSchema ─────────────────────────────────────────────────

describe("TwilioSearchParamsSchema", () => {
  it("accepts a minimal valid search (areaCode only)", () => {
    const result = TwilioSearchParamsSchema.safeParse({ areaCode: "919" });
    expect(result.success).toBe(true);
  });

  it("accepts a full US search payload", () => {
    const result = TwilioSearchParamsSchema.safeParse({
      areaCode: "415",
      contains: "555****",
      inRegion: "CA",
      inPostalCode: "94103",
      inLocality: "San Francisco",
      inRateCenter: "SNFC CNTRL",
      inLata: "722",
      nearNumber: "+14155550001",
      nearLatLong: "37.7749,-122.4194",
      distance: 25,
      voiceEnabled: true,
      smsEnabled: true,
      mmsEnabled: false,
      faxEnabled: false,
      excludeAllAddressRequired: false,
      excludeLocalAddressRequired: false,
      excludeForeignAddressRequired: false,
      beta: false,
      country: "US",
      pageSize: 20,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a negative distance", () => {
    const result = TwilioSearchParamsSchema.safeParse({ areaCode: "919", distance: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects pageSize > 1000", () => {
    const result = TwilioSearchParamsSchema.safeParse({ areaCode: "919", pageSize: 9999 });
    expect(result.success).toBe(false);
  });

  it("accepts an empty object (all fields optional)", () => {
    const result = TwilioSearchParamsSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});

// ── TwilioPurchaseParamsSchema ───────────────────────────────────────────────

describe("TwilioPurchaseParamsSchema", () => {
  it("accepts purchase by explicit phoneNumber", () => {
    const result = TwilioPurchaseParamsSchema.safeParse({ phoneNumber: "+14155550001" });
    expect(result.success).toBe(true);
  });

  it("accepts purchase by areaCode (US shortcut)", () => {
    const result = TwilioPurchaseParamsSchema.safeParse({ areaCode: "415" });
    expect(result.success).toBe(true);
  });

  it("accepts a full purchase payload", () => {
    const result = TwilioPurchaseParamsSchema.safeParse({
      phoneNumber: "+14155550001",
      friendlyName: "My Line",
      voiceUrl: "https://example.com/voice",
      voiceMethod: "POST",
      voiceFallbackUrl: "https://example.com/voice-fallback",
      voiceFallbackMethod: "POST",
      statusCallback: "https://example.com/status",
      statusCallbackMethod: "POST",
      smsUrl: "https://example.com/sms",
      smsMethod: "POST",
      smsFallbackUrl: "https://example.com/sms-fallback",
      smsFallbackMethod: "POST",
      voiceCallerIdLookup: true,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid voiceMethod value", () => {
    const result = TwilioPurchaseParamsSchema.safeParse({
      phoneNumber: "+14155550001",
      voiceMethod: "DELETE",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty object (must have phoneNumber OR areaCode)", () => {
    const result = TwilioPurchaseParamsSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ── BwSearchParamsSchema ─────────────────────────────────────────────────────

describe("BwSearchParamsSchema", () => {
  it("accepts a minimal BW search by areaCode", () => {
    const result = BwSearchParamsSchema.safeParse({ areaCode: "919" });
    expect(result.success).toBe(true);
  });

  it("accepts a full BW search payload", () => {
    const result = BwSearchParamsSchema.safeParse({
      areaCode: "919",
      state: "NC",
      city: "Raleigh",
      zip: "27606",
      lata: "426",
      rateCenter: "RALEIGH",
      npaNxx: "919832",
      localVanity: "2982",
      quantity: 10,
      enableTNDetail: true,
      countryCodeA3: "USA",
      phoneNumberType: "GEOGRAPHIC",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid phoneNumberType", () => {
    const result = BwSearchParamsSchema.safeParse({ areaCode: "919", phoneNumberType: "LANDLINE" });
    expect(result.success).toBe(false);
  });

  it("accepts an empty object (all fields optional)", () => {
    const result = BwSearchParamsSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});

// ── BwOrderRequestSchema ─────────────────────────────────────────────────────

describe("BwOrderRequestSchema", () => {
  it("accepts a minimal order with areaCode search type", () => {
    const result = BwOrderRequestSchema.safeParse({
      name: "My Order",
      siteId: "1111",
      quantity: 1,
      areaCodeSearchAndOrderType: { areaCode: "919", quantity: 1 },
    });
    expect(result.success).toBe(true);
  });

  it("accepts an order with a specific phone number", () => {
    const result = BwOrderRequestSchema.safeParse({
      name: "Specific TN Order",
      siteId: "1111",
      quantity: 1,
      existingTelephoneNumberOrderType: {
        telephoneNumberList: ["+14155550001"],
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts an order with peerId", () => {
    const result = BwOrderRequestSchema.safeParse({
      name: "Peer Order",
      siteId: "1111",
      peerId: "2222",
      quantity: 1,
      areaCodeSearchAndOrderType: { areaCode: "415", quantity: 1 },
    });
    expect(result.success).toBe(true);
  });

  it("requires name", () => {
    const result = BwOrderRequestSchema.safeParse({
      siteId: "1111",
      quantity: 1,
      areaCodeSearchAndOrderType: { areaCode: "919", quantity: 1 },
    });
    expect(result.success).toBe(false);
  });

  it("requires siteId", () => {
    const result = BwOrderRequestSchema.safeParse({
      name: "Order",
      quantity: 1,
      areaCodeSearchAndOrderType: { areaCode: "919", quantity: 1 },
    });
    expect(result.success).toBe(false);
  });
});

// ── BwOrderResponseSchema ────────────────────────────────────────────────────

describe("BwOrderResponseSchema", () => {
  it("accepts a valid order response", () => {
    const result = BwOrderResponseSchema.safeParse({
      id: "order-123",
      orderStatus: "RECEIVED",
      orderCreateDate: "2024-01-15T12:00:00Z",
      telephoneNumbers: ["+14155550001"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts response without telephoneNumbers (async order pending)", () => {
    const result = BwOrderResponseSchema.safeParse({
      id: "order-123",
      orderStatus: "RECEIVED",
      orderCreateDate: "2024-01-15T12:00:00Z",
    });
    expect(result.success).toBe(true);
  });

  it("requires id and orderStatus", () => {
    const result = BwOrderResponseSchema.safeParse({ orderCreateDate: "2024-01-15T12:00:00Z" });
    expect(result.success).toBe(false);
  });
});

// ── NumberLifecycleStageSchema ───────────────────────────────────────────────

describe("NumberLifecycleStageSchema", () => {
  it("accepts all valid stage values", () => {
    for (const stage of ["discover", "acquire", "activate", "operate"]) {
      expect(NumberLifecycleStageSchema.safeParse(stage).success).toBe(true);
    }
  });

  it("rejects an unknown stage", () => {
    expect(NumberLifecycleStageSchema.safeParse("port").success).toBe(false);
  });
});
