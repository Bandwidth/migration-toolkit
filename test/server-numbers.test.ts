import { describe, it, expect, vi } from "vitest";
import { buildApp } from "../src/server/app.js";
import type { NumbersClient } from "../src/numbers/client.js";

const config = {
  accountSid: "AC123",
  authToken: "tok",
  publicBaseUrl: "https://adapter.test",
  voiceUrl: "https://customer.test/voice",
  numbers: { siteId: "site-1", peerId: "peer-1" },
};
const auth = "Basic " + Buffer.from("AC123:tok").toString("base64");

function bwClientStub() {
  return {
    createCall: vi.fn(),
    modifyCall: vi.fn(),
    getCall: vi.fn(),
    listRecordings: vi.fn(),
    getRecording: vi.fn(),
    getRecordingMedia: vi.fn(),
    updateRecording: vi.fn(),
  };
}

function makeApp(numbersClient?: Partial<NumbersClient>) {
  const bwClient = bwClientStub();
  const app = buildApp(config, {
    fetchImpl: fetch,
    bwClient,
    numbersClient: numbersClient as NumbersClient | undefined,
  });
  return { app, bwClient };
}

describe("GET AvailablePhoneNumbers (search facade)", () => {
  it("translates Twilio search params and shapes BW inventory as Twilio results", async () => {
    const searchAvailable = vi.fn(async () => ({
      numbers: [
        { fullNumber: "+19195551234", rateCenter: "RTP", city: "Durham", state: "NC", lca: true },
      ],
      resultCount: 1,
    }));
    const { app } = makeApp({ searchAvailable });

    const res = await app.inject({
      method: "GET",
      url: "/2010-04-01/Accounts/AC123/AvailablePhoneNumbers/US/Local.json?AreaCode=919&PageSize=5",
      headers: { authorization: auth },
    });

    expect(res.statusCode).toBe(200);
    // BW received translated params: areaCode passthrough, pageSize → quantity.
    expect(searchAvailable).toHaveBeenCalledWith(
      expect.objectContaining({ areaCode: "919", quantity: 5 }),
    );
    const body = res.json();
    expect(body.available_phone_numbers).toHaveLength(1);
    expect(body.available_phone_numbers[0]).toMatchObject({
      phone_number: "+19195551234",
      friendly_name: "(919) 555-1234",
      region: "NC",
      locality: "Durham",
      rate_center: "RTP",
      iso_country: "US",
      capabilities: { voice: true },
    });
  });

  it("401s without auth and 400s when no numbers client is configured", async () => {
    const noAuth = await makeApp({ searchAvailable: vi.fn() }).app.inject({
      method: "GET",
      url: "/2010-04-01/Accounts/AC123/AvailablePhoneNumbers/US/Local.json?AreaCode=919",
    });
    expect(noAuth.statusCode).toBe(401);

    const unconfigured = await makeApp(undefined).app.inject({
      method: "GET",
      url: "/2010-04-01/Accounts/AC123/AvailablePhoneNumbers/US/Local.json?AreaCode=919",
      headers: { authorization: auth },
    });
    expect(unconfigured.statusCode).toBe(400);
    expect(unconfigured.json().code).toBe(21601);
  });
});

describe("POST IncomingPhoneNumbers (purchase facade)", () => {
  it("orders a specific number and returns a Twilio IncomingPhoneNumber resource", async () => {
    const createOrder = vi.fn(async () => ({
      id: "order-1",
      orderStatus: "COMPLETE" as const,
      telephoneNumbers: ["+19195551234"],
    }));
    const getOrder = vi.fn();
    const { app } = makeApp({ createOrder, getOrder });

    const res = await app.inject({
      method: "POST",
      url: "/2010-04-01/Accounts/AC123/IncomingPhoneNumbers.json",
      headers: { authorization: auth },
      payload: { PhoneNumber: "+19195551234", VoiceUrl: "https://customer.test/voice" },
    });

    expect(res.statusCode).toBe(201);
    // Order routed to the explicit-number type, carrying the configured site.
    expect(createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        siteId: "site-1",
        peerId: "peer-1",
        existingTelephoneNumberOrderType: { telephoneNumberList: ["+19195551234"] },
      }),
    );
    expect(getOrder).not.toHaveBeenCalled(); // already COMPLETE, no poll needed
    const body = res.json();
    expect(body.phone_number).toBe("+19195551234");
    expect(body.sid).toMatch(/^PN[0-9a-f]{32}$/);
    expect(body.voice_url).toBe("https://customer.test/voice");
  });

  it("polls a pending order until it completes", async () => {
    const createOrder = vi.fn(async () => ({ id: "order-2", orderStatus: "RECEIVED" as const }));
    const getOrder = vi
      .fn()
      .mockResolvedValueOnce({ id: "order-2", orderStatus: "PROCESSING" })
      .mockResolvedValueOnce({
        id: "order-2",
        orderStatus: "COMPLETE",
        telephoneNumbers: ["+19195559999"],
      });
    const { app } = makeApp({ createOrder, getOrder });

    const res = await app.inject({
      method: "POST",
      url: "/2010-04-01/Accounts/AC123/IncomingPhoneNumbers.json",
      headers: { authorization: auth },
      payload: { PhoneNumber: "+19195559999" },
    });

    expect(res.statusCode).toBe(201);
    expect(getOrder).toHaveBeenCalledTimes(2);
    expect(res.json().phone_number).toBe("+19195559999");
  });

  it("returns a Twilio-shaped error when the order fails", async () => {
    const createOrder = vi.fn(async () => ({ id: "order-3", orderStatus: "FAILED" as const }));
    const { app } = makeApp({ createOrder, getOrder: vi.fn() });

    const res = await app.inject({
      method: "POST",
      url: "/2010-04-01/Accounts/AC123/IncomingPhoneNumbers.json",
      headers: { authorization: auth },
      payload: { PhoneNumber: "+19195551234" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe(21603);
  });

  it("400s when neither PhoneNumber nor AreaCode is supplied", async () => {
    const { app } = makeApp({ createOrder: vi.fn() });
    const res = await app.inject({
      method: "POST",
      url: "/2010-04-01/Accounts/AC123/IncomingPhoneNumbers.json",
      headers: { authorization: auth },
      payload: { FriendlyName: "nope" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe(21602);
  });
});
