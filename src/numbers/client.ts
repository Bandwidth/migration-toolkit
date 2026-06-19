/**
 * NumbersClient interface + minimal real implementation for the Bandwidth
 * Numbers API.
 *
 * Mirrors the pattern established in src/bw/client.ts:
 *  - A plain TypeScript interface that tests can mock easily
 *  - A createNumbersClient factory that wires in real HTTP calls
 *  - No live credentials required; the base URL is configurable so tests
 *    can point at a mock server if desired
 *
 * API surface covered:
 *   search   → GET /numbers  (available-number search)
 *   order    → POST /accounts/{accountId}/orders  (number acquisition)
 *   listTns  → GET /accounts/{accountId}/tns  (numbers on the account)
 *   disconnect → POST /accounts/{accountId}/disconnects
 *
 * Sources:
 *   https://dev.bandwidth.com/apis/numbers-apis/numbers
 *   https://dev.bandwidth.com/apis/numbers-apis/number-acquisition
 *   https://dev.bandwidth.com/docs/numbers/guides/disconnectNumbers
 *   @bandwidth/node-numbers SDK README
 */

import type { BwSearchParams, BwOrderRequest, BwOrderResponse } from "./schema.js";
import { TokenManager } from "../bw/token.js";

// ── Available-number search result ───────────────────────────────────────────

export interface AvailableNumber {
  /** Full E.164 phone number. */
  fullNumber: string;
  /** Rate center abbreviation, if available. */
  rateCenter?: string;
  /** City name, if available. */
  city?: string;
  /** Two-letter state abbreviation, if available. */
  state?: string;
  /** Whether the number is within the local calling area. */
  lca?: boolean;
}

export interface SearchResult {
  numbers: AvailableNumber[];
  resultCount: number;
}

// ── Active telephone number (operate stage) ──────────────────────────────────

export interface TelephoneNumber {
  /** Full E.164 phone number. */
  fullNumber: string;
  /** Two-letter state. */
  state?: string;
  /** Rate center abbreviation. */
  rateCenter?: string;
  /** Current number status. */
  status?: string;
}

export interface ListTnsResult {
  telephoneNumbers: TelephoneNumber[];
  totalCount: number;
}

// ── Disconnect order ─────────────────────────────────────────────────────────

export interface DisconnectRequest {
  /** Customer-supplied reference ID. */
  customerOrderId?: string;
  /** E.164 numbers to release. Maximum 5000 per order. */
  phoneNumbers: string[];
}

export interface DisconnectResponse {
  id: string;
  orderStatus: string;
  orderCreateDate?: string;
}

// ── Interface ────────────────────────────────────────────────────────────────

/**
 * Minimal interface for the Bandwidth Numbers API.
 * Keep this focused on the lifecycle operations: discover, acquire, operate.
 * Tests can implement this with a simple object literal — no class needed.
 */
export interface NumbersClient {
  /**
   * Search for available telephone numbers.
   * Maps to: GET /numbers (new Numbers API)
   */
  searchAvailable(params: BwSearchParams): Promise<SearchResult>;

  /**
   * Create a number order (purchase).
   * Maps to: POST /accounts/{accountId}/orders
   */
  createOrder(req: BwOrderRequest): Promise<BwOrderResponse>;

  /**
   * Poll an order's current status.
   * Maps to: GET /accounts/{accountId}/orders/{orderId}
   */
  getOrder(orderId: string): Promise<BwOrderResponse>;

  /**
   * List telephone numbers currently on the account.
   * Maps to: GET /accounts/{accountId}/tns
   */
  listTns(opts?: { quantity?: number; page?: number }): Promise<ListTnsResult>;

  /**
   * Disconnect (release) telephone numbers.
   * Maps to: POST /accounts/{accountId}/disconnects
   */
  disconnect(req: DisconnectRequest): Promise<DisconnectResponse>;
}

// ── Factory ──────────────────────────────────────────────────────────────────

export interface NumbersClientConfig {
  /** Bandwidth account ID. */
  accountId: string;
  /** OAuth2 client-credentials ID (same platform credential as the Voice API). */
  clientId: string;
  /** OAuth2 client-credentials secret. */
  clientSecret: string;
  /**
   * Base URL for the Numbers API v2 JSON endpoints.
   * Defaults to the production Bandwidth Numbers API.
   * Override in tests to point at a mock server.
   */
  baseUrl?: string;
  /** API host serving the OAuth2 token endpoint. Defaults to https://api.bandwidth.com. */
  apiHost?: string;
  /** Injectable fetch for tests/staging. */
  fetchImpl?: typeof fetch;
}

/**
 * Create a real NumbersClient backed by the Bandwidth Numbers API.
 *
 * Auth mirrors createBwClient (src/bw/client.ts): a shared OAuth2
 * client-credentials Bearer token via TokenManager. The same platform token
 * is honored across Voice and Numbers — whether it can place orders depends on
 * the account credential carrying the Numbers role.
 *
 * Targets the JSON-native endpoints documented at:
 *   https://dev.bandwidth.com/apis/numbers-apis/numbers
 *   https://dev.bandwidth.com/apis/numbers-apis/number-acquisition
 */
export function createNumbersClient(cfg: NumbersClientConfig): NumbersClient {
  // Bandwidth's Numbers API lives under api.bandwidth.com (not numbers.bandwidth.com).
  const base = cfg.baseUrl ?? "https://api.bandwidth.com/api/v2";
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const tokens = new TokenManager({
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    apiHost: cfg.apiHost ?? "https://api.bandwidth.com",
    fetchImpl,
  });

  async function headers(): Promise<Record<string, string>> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${await tokens.getToken()}`,
    };
  }

  async function expectOk(res: Response, context: string): Promise<Response> {
    if (!res.ok) {
      throw new Error(
        `Bandwidth Numbers API ${context} failed: ${res.status} ${await res.text()}`,
      );
    }
    return res;
  }

  return {
    async searchAvailable(params) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) qs.set(k, String(v));
      }
      // Verified live (2026-06-19): GET /accounts/{id}/availableNumbers returns
      // {"phoneNumbers":["+1919…"],"resultCount":N} as JSON. Without
      // enableTNDetail the response is just E.164 strings (no city/state/rateCenter).
      const res = await fetchImpl(
        `${base}/accounts/${cfg.accountId}/availableNumbers?${qs.toString()}`,
        { headers: { ...(await headers()), Accept: "application/json" } },
      );
      await expectOk(res, "searchAvailable");
      const json = (await res.json()) as {
        phoneNumbers?: string[];
        TelephoneNumberList?: string[];
        resultCount?: number;
        ResultCount?: number;
      };
      // Prefer phoneNumbers (E.164); TelephoneNumberList carries the same set
      // without the leading "+".
      const raw = json.phoneNumbers ?? json.TelephoneNumberList ?? [];
      const numbers: AvailableNumber[] = raw.map((fullNumber) => ({
        fullNumber: fullNumber.startsWith("+") ? fullNumber : `+${fullNumber}`,
      }));
      return { numbers, resultCount: json.resultCount ?? json.ResultCount ?? numbers.length };
    },

    async createOrder(req) {
      const res = await fetchImpl(`${base}/accounts/${cfg.accountId}/orders`, {
        method: "POST",
        headers: await headers(),
        body: JSON.stringify(req),
      });
      await expectOk(res, "createOrder");
      return (await res.json()) as BwOrderResponse;
    },

    async getOrder(orderId) {
      const res = await fetchImpl(`${base}/accounts/${cfg.accountId}/orders/${orderId}`, {
        headers: await headers(),
      });
      await expectOk(res, "getOrder");
      return (await res.json()) as BwOrderResponse;
    },

    async listTns(opts = {}) {
      const qs = new URLSearchParams();
      if (opts.quantity !== undefined) qs.set("quantity", String(opts.quantity));
      if (opts.page !== undefined) qs.set("page", String(opts.page));
      const res = await fetchImpl(`${base}/accounts/${cfg.accountId}/tns?${qs.toString()}`, {
        headers: await headers(),
      });
      await expectOk(res, "listTns");
      const json = (await res.json()) as {
        telephoneNumbers?: TelephoneNumber[];
        totalCount?: number;
      };
      return {
        telephoneNumbers: json.telephoneNumbers ?? [],
        totalCount: json.totalCount ?? 0,
      };
    },

    async disconnect(req) {
      const body = {
        customerOrderId: req.customerOrderId,
        disconnectOrderType: {
          disconnectMode: "NORMAL",
          phoneNumbers: req.phoneNumbers,
        },
      };
      const res = await fetchImpl(`${base}/accounts/${cfg.accountId}/disconnects`, {
        method: "POST",
        headers: await headers(),
        body: JSON.stringify(body),
      });
      await expectOk(res, "disconnect");
      return (await res.json()) as DisconnectResponse;
    },
  };
}
