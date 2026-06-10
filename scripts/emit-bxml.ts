// Emits the adapter's BXML output for representative TwiML inputs, one doc per
// line, so an external validator (band bxml) can check each. Dev tool.
import { translateTwiml } from "../src/translator/translate.js";

const rw = (u: string) => `https://adapter.test/bw/continue?next=${encodeURIComponent(u)}`;

const SAMPLES: Record<string, string> = {
  ivr: `<Response><Gather numDigits="1" action="/menu"><Say>Welcome. Press 1 for sales.</Say></Gather><Say>No input. Goodbye.</Say></Response>`,
  transfer: `<Response><Say>Connecting you to sales.</Say><Dial callerId="+19195550000">+19195550100</Dial></Response>`,
  record: `<Response><Say>Leave a message.</Say><Record maxLength="30" action="/done"/></Response>`,
  conference: `<Response><Dial><Conference>support</Conference></Dial></Response>`,
  sip: `<Response><Dial><Sip>sip:agent@pbx.test</Sip></Dial></Response>`,
  stream: `<Response><Connect><Stream url="wss://bot.test/audio"/></Connect></Response>`,
};

for (const [name, twiml] of Object.entries(SAMPLES)) {
  const r = translateTwiml(twiml, { rewriteUrl: rw });
  // name<TAB>bxml — single line for easy shell consumption
  process.stdout.write(`${name}\t${r.bxml}\n`);
}
