import { createHmac } from "node:crypto";

/** Twilio request signing: HMAC-SHA1(authToken, url + sorted(paramName+value)), base64. */
export function twilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join("");
  return createHmac("sha1", authToken).update(data).digest("base64");
}
