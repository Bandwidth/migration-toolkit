/**
 * Unit tests for Twilio→Bandwidth number-lifecycle translations.
 * Written first (TDD) — these fail until src/numbers/translate.ts is implemented.
 */

import { describe, it, expect } from "vitest";
import {
  translateSearchParams,
  translatePurchaseToOrder,
  type SearchTranslation,
  type PurchaseTranslation,
} from "../src/numbers/translate.js";
import { BwOrderRequestSchema } from "../src/numbers/schema.js";

// ── translateSearchParams ─────────────────────────────────────────────────────

describe("translateSearchParams: Twilio search → BW search params", () => {
  it("maps areaCode directly", () => {
    const result: SearchTranslation = translateSearchParams({ areaCode: "919" });
    expect(result.bwParams.areaCode).toBe("919");
    expect(result.gaps).toHaveLength(0);
  });

  it("maps inRegion → state", () => {
    const result = translateSearchParams({ inRegion: "CA" });
    expect(result.bwParams.state).toBe("CA");
  });

  it("maps inPostalCode → zip", () => {
    const result = translateSearchParams({ inPostalCode: "94103" });
    expect(result.bwParams.zip).toBe("94103");
  });

  it("maps inLocality → city", () => {
    const result = translateSearchParams({ inLocality: "Raleigh" });
    expect(result.bwParams.city).toBe("Raleigh");
  });

  it("maps inRateCenter → rateCenter", () => {
    const result = translateSearchParams({ inRateCenter: "RALEIGH" });
    expect(result.bwParams.rateCenter).toBe("RALEIGH");
  });

  it("maps inLata → lata", () => {
    const result = translateSearchParams({ inLata: "426" });
    expect(result.bwParams.lata).toBe("426");
  });

  it("maps pageSize → quantity", () => {
    const result = translateSearchParams({ pageSize: 15 });
    expect(result.bwParams.quantity).toBe(15);
  });

  it("surfaces contains as a gap (no BW equivalent)", () => {
    const result = translateSearchParams({ contains: "555****" });
    expect(result.gaps.some((g) => /contains/i.test(g.twilioParam))).toBe(true);
    expect(result.bwParams).not.toHaveProperty("contains");
  });

  it("surfaces nearNumber as a gap (no BW equivalent)", () => {
    const result = translateSearchParams({ nearNumber: "+14155550001" });
    expect(result.gaps.some((g) => /nearNumber/i.test(g.twilioParam))).toBe(true);
  });

  it("surfaces nearLatLong as a gap (no BW equivalent)", () => {
    const result = translateSearchParams({ nearLatLong: "37.7749,-122.4194" });
    expect(result.gaps.some((g) => /nearLatLong/i.test(g.twilioParam))).toBe(true);
  });

  it("surfaces voiceEnabled/smsEnabled/mmsEnabled/faxEnabled as gaps", () => {
    const result = translateSearchParams({
      voiceEnabled: true,
      smsEnabled: true,
      mmsEnabled: false,
      faxEnabled: false,
    });
    const gapParams = result.gaps.map((g) => g.twilioParam);
    expect(gapParams).toContain("voiceEnabled");
    expect(gapParams).toContain("smsEnabled");
    expect(gapParams).toContain("mmsEnabled");
    expect(gapParams).toContain("faxEnabled");
  });

  it("surfaces excludeAllAddressRequired as a gap", () => {
    const result = translateSearchParams({ excludeAllAddressRequired: true });
    expect(result.gaps.some((g) => /excludeAllAddressRequired/i.test(g.twilioParam))).toBe(true);
  });

  it("maps country to countryCodeA3 for known values", () => {
    const result = translateSearchParams({ country: "US" });
    expect(result.bwParams.countryCodeA3).toBe("USA");
  });

  it("maps country=CA to countryCodeA3 CAN", () => {
    const result = translateSearchParams({ country: "CA" });
    expect(result.bwParams.countryCodeA3).toBe("CAN");
  });

  it("surfaces unknown country codes as a gap", () => {
    const result = translateSearchParams({ country: "FR" });
    expect(result.gaps.some((g) => /country/i.test(g.twilioParam))).toBe(true);
  });

  it("handles a combined search (areaCode + region + quantity)", () => {
    const result = translateSearchParams({ areaCode: "919", inRegion: "NC", pageSize: 5 });
    expect(result.bwParams.areaCode).toBe("919");
    expect(result.bwParams.state).toBe("NC");
    expect(result.bwParams.quantity).toBe(5);
    expect(result.gaps).toHaveLength(0);
  });

  it("returns empty bwParams and no gaps for empty input", () => {
    const result = translateSearchParams({});
    expect(result.bwParams).toEqual({});
    expect(result.gaps).toHaveLength(0);
  });
});

// ── translatePurchaseToOrder ──────────────────────────────────────────────────

describe("translatePurchaseToOrder: Twilio purchase → BW order", () => {
  it("maps an explicit E.164 phoneNumber to existingTelephoneNumberOrderType", () => {
    const result: PurchaseTranslation = translatePurchaseToOrder(
      { phoneNumber: "+14155550001" },
      { siteId: "1111", orderName: "Test Order" },
    );
    expect(result.bwOrder.existingTelephoneNumberOrderType?.telephoneNumberList).toContain(
      "+14155550001",
    );
    expect(result.bwOrder.name).toBe("Test Order");
    expect(result.bwOrder.siteId).toBe("1111");
    expect(result.bwOrder.quantity).toBe(1);
  });

  it("maps areaCode purchase to areaCodeSearchAndOrderType", () => {
    const result = translatePurchaseToOrder(
      { areaCode: "919" },
      { siteId: "1111", orderName: "Area Code Order" },
    );
    expect(result.bwOrder.areaCodeSearchAndOrderType?.areaCode).toBe("919");
    expect(result.bwOrder.areaCodeSearchAndOrderType?.quantity).toBe(1);
    expect(result.bwOrder.existingTelephoneNumberOrderType).toBeUndefined();
  });

  it("surfaces friendlyName as a gap (no BW order equivalent)", () => {
    const result = translatePurchaseToOrder(
      { phoneNumber: "+14155550001", friendlyName: "My Main Line" },
      { siteId: "1111", orderName: "Order" },
    );
    expect(result.gaps.some((g) => /friendlyName/i.test(g.twilioParam))).toBe(true);
  });

  it("emits a separate gap for EACH set field, not just the first (app SIDs)", () => {
    const result = translatePurchaseToOrder(
      {
        phoneNumber: "+14155550001",
        voiceApplicationSid: "APvoice",
        smsApplicationSid: "APsms",
      },
      { siteId: "1111", orderName: "Order" },
    );
    const params = result.gaps.map((g) => g.twilioParam);
    expect(params).toContain("voiceApplicationSid");
    expect(params).toContain("smsApplicationSid");
  });

  it("surfaces voiceUrl as a gap", () => {
    const result = translatePurchaseToOrder(
      { phoneNumber: "+14155550001", voiceUrl: "https://app.example.com/voice" },
      { siteId: "1111", orderName: "Order" },
    );
    expect(result.gaps.some((g) => /voiceUrl/i.test(g.twilioParam))).toBe(true);
  });

  it("surfaces smsUrl as a gap", () => {
    const result = translatePurchaseToOrder(
      { phoneNumber: "+14155550001", smsUrl: "https://app.example.com/sms" },
      { siteId: "1111", orderName: "Order" },
    );
    expect(result.gaps.some((g) => /smsUrl/i.test(g.twilioParam))).toBe(true);
  });

  it("surfaces statusCallback as a gap", () => {
    const result = translatePurchaseToOrder(
      { phoneNumber: "+14155550001", statusCallback: "https://app.example.com/status" },
      { siteId: "1111", orderName: "Order" },
    );
    expect(result.gaps.some((g) => /statusCallback/i.test(g.twilioParam))).toBe(true);
  });

  it("includes peerId when provided in context", () => {
    const result = translatePurchaseToOrder(
      { phoneNumber: "+14155550001" },
      { siteId: "1111", peerId: "2222", orderName: "Order" },
    );
    expect(result.bwOrder.peerId).toBe("2222");
  });

  it("produces a valid BwOrderRequest shape that passes schema validation", () => {
    const { bwOrder } = translatePurchaseToOrder(
      { phoneNumber: "+14155550001" },
      { siteId: "1111", orderName: "Validated Order" },
    );
    expect(BwOrderRequestSchema.safeParse(bwOrder).success).toBe(true);
  });
});
