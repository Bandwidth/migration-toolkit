// "Acme Health" contact center — a realistic, feature-heavy Twilio voice app.
// Unmodified Twilio SDK. Exercises the full spread of TwiML the adapter cares
// about: the parts that migrate clean AND the parts that must fail loudly.
const express = require("express");
const { twiml } = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: false }));
const xml = (res, vr) => res.type("text/xml").send(vr.toString());

// Main IVR — DTMF menu (supported), with a Spanish branch that uses SPEECH (gap)
app.post("/voice", (req, res) => {
  const vr = new twiml.VoiceResponse();
  const g = vr.gather({ numDigits: 1, action: "/route", timeout: 6, method: "POST" });
  g.say({ voice: "alice" }, "Thank you for calling Acme Health.");
  g.play("https://acme.example/audio/menu.mp3");
  g.say("Press 1 for appointments, 2 for billing, 3 for the nurse line, 9 for an agent.");
  vr.redirect("/voice"); // loop if no input
  xml(res, vr);
});

app.post("/route", (req, res) => {
  const vr = new twiml.VoiceResponse();
  switch (req.body.Digits) {
    case "1": vr.redirect("/appointments"); break;
    case "2": vr.redirect("/billing"); break;
    case "3": vr.redirect("/nurse-queue"); break;
    case "9": vr.redirect("/agent"); break;
    default:
      vr.say("Sorry, I did not understand.");
      vr.redirect("/voice");
  }
  xml(res, vr);
});

// Appointments — speech recognition (UNSUPPORTED in P0: speech Gather)
app.post("/appointments", (req, res) => {
  const vr = new twiml.VoiceResponse();
  const g = vr.gather({ input: "speech", action: "/appointments-handle", speechTimeout: "auto" });
  g.say("In a few words, tell me what you need. For example, schedule a checkup.");
  xml(res, vr);
});

// Billing — in-call card payment (UNSUPPORTED: Pay/PCI), falls back to voicemail
app.post("/billing", (req, res) => {
  const vr = new twiml.VoiceResponse();
  vr.say("Please have your card ready.");
  vr.pay({ chargeAmount: "25.00", action: "/billing-complete" }); // PCI — not supported
  xml(res, vr);
});

// Nurse line — call QUEUE with hold music (UNSUPPORTED: Enqueue + waitUrl)
app.post("/nurse-queue", (req, res) => {
  const vr = new twiml.VoiceResponse();
  vr.say("All nurses are busy. Please hold.");
  vr.enqueue({ waitUrl: "/hold-music", action: "/queue-result" }, "nurse-line");
  xml(res, vr);
});

// Agent — ring multiple agents simultaneously (supported), then conference w/ hold music
app.post("/agent", (req, res) => {
  const vr = new twiml.VoiceResponse();
  vr.say("Connecting you to the next available agent.");
  const dial = vr.dial({ timeout: 20, callerId: "+19195550123", action: "/agent-missed" });
  dial.number("+19195550111");
  dial.number("+19195550112");
  dial.sip("sip:agent-desk@acme.pbx.example");
  xml(res, vr);
});

app.post("/agent-missed", (req, res) => {
  const vr = new twiml.VoiceResponse();
  vr.say("No agents answered. Joining the team conference.");
  const dial = vr.dial();
  // Conference with hold music + entry beep (waitUrl UNSUPPORTED, beep partial)
  dial.conference({ waitUrl: "/hold-music", beep: true, startConferenceOnEnter: true }, "team-room");
  xml(res, vr);
});

// AI nurse triage — real-time media stream to a bot (PARTIAL: Connect>Stream)
app.post("/nurse-queue/ai", (req, res) => {
  const vr = new twiml.VoiceResponse();
  const connect = vr.connect();
  connect.stream({ url: "wss://ai.acme.example/triage" });
  xml(res, vr);
});

// WebRTC browser agent (UNSUPPORTED: Dial>Client)
app.post("/web-agent", (req, res) => {
  const vr = new twiml.VoiceResponse();
  const dial = vr.dial();
  dial.client("browser-agent-7");
  xml(res, vr);
});

// Voicemail — record with transcription + beep (record supported; transcribe/beep partial)
app.post("/voicemail", (req, res) => {
  const vr = new twiml.VoiceResponse();
  vr.say("Please leave a message after the tone.");
  vr.record({ maxLength: 120, transcribe: true, playBeep: true, action: "/voicemail-done" });
  vr.hangup();
  xml(res, vr);
});

// After hours — decline the call (Reject: partial — BW answers first)
app.post("/after-hours", (req, res) => {
  const vr = new twiml.VoiceResponse();
  vr.reject({ reason: "busy" });
  xml(res, vr);
});

app.listen(4001, () => console.log("Acme Health (complex Twilio app) on :4001"));
