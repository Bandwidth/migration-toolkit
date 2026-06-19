/**
 * Live verification for the numbers facade. Read-only by default: verifies the
 * OAuth2 token exchange and (if an account is configured) a search. It will ONLY
 * attempt a real order when BW_SITE_ID is present AND VERIFY_ORDER=1 is set, and
 * it always releases exactly the number it ordered. Prints raw API shapes (never
 * the access token) so we can tighten the schema against reality.
 */
import { TokenManager } from "../src/bw/token.js";
import { createNumbersClient } from "../src/numbers/client.js";

const clientId = process.env.BANDWIDTH_CLIENT_ID ?? process.env.BW_CLIENT_ID;
const clientSecret = process.env.BANDWIDTH_CLIENT_SECRET ?? process.env.BW_CLIENT_SECRET;
const accountId = process.env.BW_ACCOUNT_ID;
const siteId = process.env.BW_SITE_ID;
const areaCode = process.env.VERIFY_AREA_CODE ?? "919";

if (!clientId || !clientSecret) {
  console.error("MISSING client credentials (BANDWIDTH_CLIENT_ID / _SECRET)");
  process.exit(2);
}

const apiHost = "https://api.bandwidth.com";

async function main() {
  // 1) Token exchange — proves the OAuth2 rewire against real Bandwidth.
  console.log("== 1. OAuth2 token exchange ==");
  const tokens = new TokenManager({ clientId, clientSecret, apiHost });
  try {
    const tok = await tokens.getToken();
    console.log(`  OK  token acquired (len=${tok.length}, value not printed)`);
  } catch (e) {
    console.log(`  FAIL ${(e as Error).message}`);
    return;
  }

  // 2) Search — read-only. Learn the real response shape.
  console.log("== 2. Search (read-only) ==");
  if (!accountId) {
    console.log("  SKIP  BW_ACCOUNT_ID not set — cannot address account endpoints");
  } else {
    const client = createNumbersClient({ accountId, clientId, clientSecret, apiHost });
    try {
      const res = await client.searchAvailable({ areaCode, quantity: 3 });
      console.log(`  OK  ${res.resultCount} numbers; first=${res.numbers[0]?.fullNumber ?? "(none)"}`);
    } catch (e) {
      console.log(`  FAIL ${(e as Error).message}`);
    }
  }

  // 3) Order + release — ONLY when explicitly enabled and a site exists.
  console.log("== 3. Order + release ==");
  if (!siteId) {
    console.log("  BLOCKED  BW_SITE_ID not set — a Bandwidth order requires a site/sub-account.");
    return;
  }
  if (process.env.VERIFY_ORDER !== "1") {
    console.log("  SKIP  set VERIFY_ORDER=1 to place a real (billable) order + immediate release.");
    return;
  }
  if (!accountId) {
    console.log("  BLOCKED  BW_ACCOUNT_ID not set.");
    return;
  }

  const client = createNumbersClient({ accountId, clientId, clientSecret, apiHost });
  const search = await client.searchAvailable({ areaCode, quantity: 1 });
  const number = search.numbers[0]?.fullNumber;
  if (!number) {
    console.log(`  ABORT  no available number in area code ${areaCode}`);
    return;
  }
  console.log(`  ordering ${number} into site ${siteId} ...`);
  // Assume the POST provisions the number; we always release this exact N below,
  // even if response parsing throws — so nothing is ever orphaned.
  try {
    // EXPERIMENTAL: the v2 JSON order body below is rejected live
    // ("Invalid data type for field 'existingTelephoneNumberOrderType'"). Stripping
    // to bare 10-digit did not resolve it — the real order schema still needs to be
    // captured from the `band` CLI. Left here as the reproduction for that follow-up.
    const bare = number.replace(/^\+1/, "");
    const order = await client.createOrder({
      name: "adapter live verification",
      siteId,
      existingTelephoneNumberOrderType: { telephoneNumberList: [bare] },
    });
    console.log("  RAW createOrder response:", JSON.stringify(order));
    if (order.id) {
      const polled = await client.getOrder(order.id);
      console.log("  RAW getOrder response:", JSON.stringify(polled));
    }
  } catch (e) {
    console.log(`  createOrder/getOrder threw (will still release ${number}): ${(e as Error).message}`);
  } finally {
    try {
      const dc = await client.disconnect({ phoneNumbers: [number], customerOrderId: "adapter-verify" });
      console.log("  RAW disconnect response:", JSON.stringify(dc));
      console.log(`  RELEASED ${number}`);
    } catch (e) {
      console.log(`  RELEASE FAILED for ${number} — clean up via 'band number release': ${(e as Error).message}`);
    }
  }
}

main().catch((e) => {
  console.error("unexpected:", e);
  process.exit(1);
});
