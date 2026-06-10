// "Full PV" demo — a Twilio voice app that exercises EVERYTHING Bandwidth
// Programmable Voice supports (verified against dev.bandwidth.com via Context7).
// Deliberately stays inside the supported surface, so the whole app translates
// clean through the adapter: no blockers, only expected heads-up notes.
//
// Supported BW PV surface covered here (Twilio verb -> BXML verb):
//   Say (+SSML, voice)        -> SpeakSentence
//   Play                      -> PlayAudio
//   Gather dtmf               -> Gather (input=dtmf)
//   Gather speech             -> Gather (input=speech)        <-- BW supports this
//   Gather dtmf+speech        -> Gather (input=dtmf_speech)
//   Record (+transcribe)      -> Record
//   Dial > Number (single)    -> Transfer > PhoneNumber
//   Dial > Number (multiple)  -> Transfer > PhoneNumber[]      (simultaneous ring)
//   Dial > Sip                -> Transfer > SipUri
//   Dial > Conference (basic) -> Conference
//   Connect > Stream          -> StartStream (bidirectional media)
//   Pause / Redirect / Hangup -> Pause / Redirect / Hangup
const express = require("express");
const { twiml } = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: false }));
const xml = (res, vr) => res.type("text/xml").send(vr.toString());

// Main menu — collect BOTH digits and speech in one Gather (dtmf_speech)
app.post("/voice", (req, res) => {
  const vr = new twiml.VoiceResponse();
  const g = vr.gather({
    input: "dtmf speech",
    numDigits: 1,
    timeout: 6,
    finishOnKey: "#",
    action: "/route",
    method: "POST",
  });
  g.say({ voice: "alice" }, "Welcome to the full voice demo.");
  g.play("https://demo.example/audio/options.mp3");
  g.say(
    'Say what you need, or press <break time="300ms"/> 1 to hear our voices, ' +
      "2 to leave a message, 3 to reach an agent, or 4 to join a conference.",
  );
  vr.redirect("/voice");
  xml(res, vr);
});

app.post("/route", (req, res) => {
  const vr = new twiml.VoiceResponse();
  const said = (req.body.SpeechResult || "").toLowerCase();
  const d = req.body.Digits;
  if (d === "1" || said.includes("voice")) vr.redirect("/voices");
  else if (d === "2" || said.includes("message")) vr.redirect("/voicemail");
  else if (d === "3" || said.includes("agent")) vr.redirect("/agent");
  else if (d === "4" || said.includes("conference")) vr.redirect("/conference");
  else {
    vr.say("Sorry, I did not catch that.");
    vr.redirect("/voice");
  }
  xml(res, vr);
});

// TTS showcase — multiple voices + SSML (SpeakSentence)
app.post("/voices", (req, res) => {
  const vr = new twiml.VoiceResponse();
  vr.say({ voice: "bridget" }, "This is Bridget speaking.");
  vr.say(
    { voice: "julie" },
    'And this is Julie, with emphasis on <emphasis level="strong">trust</emphasis> and a pause.',
  );
  vr.pause({ length: 1 });
  vr.say('<say-as interpret-as="telephone">9195550123</say-as> is our callback line.');
  vr.redirect("/voice");
  xml(res, vr);
});

// Pure speech capture (Gather input=speech) — BW supports speech natively
app.post("/voicemail", (req, res) => {
  const vr = new twiml.VoiceResponse();
  const g = vr.gather({ input: "speech", action: "/voicemail-confirm", speechTimeout: "auto" });
  g.say("Tell me your message in a few words, or stay on the line to record.");
  vr.redirect("/record"); // fall through to a full recording
  xml(res, vr);
});

app.post("/voicemail-confirm", (req, res) => {
  const vr = new twiml.VoiceResponse();
  vr.say(`I heard: ${req.body.SpeechResult || "nothing"}. Thank you.`);
  vr.hangup();
  xml(res, vr);
});

// Recording with transcription (Record -> transcribe)
app.post("/record", (req, res) => {
  const vr = new twiml.VoiceResponse();
  vr.say("Please record your message after the tone.");
  vr.record({ maxLength: 120, finishOnKey: "#", transcribe: true, action: "/record-done" });
  vr.hangup();
  xml(res, vr);
});

// Agent — single, then simultaneous-ring across numbers and a SIP desk phone
app.post("/agent", (req, res) => {
  const vr = new twiml.VoiceResponse();
  vr.say("Connecting you to the next available agent.");
  const dial = vr.dial({ callerId: "+19195550123", timeout: 20, action: "/agent-result" });
  dial.number("+19195550111");
  dial.number("+19195550112");
  dial.sip("sip:agent-desk@demo.pbx.example");
  xml(res, vr);
});

// Conference — basic named room (no waitUrl/beep, which BW doesn't support)
app.post("/conference", (req, res) => {
  const vr = new twiml.VoiceResponse();
  vr.say("Joining the conference now.");
  const dial = vr.dial();
  dial.conference("demo-room");
  xml(res, vr);
});

// Real-time media stream to an AI bot (Connect > Stream -> StartStream)
app.post("/stream", (req, res) => {
  const vr = new twiml.VoiceResponse();
  vr.say("Starting real-time audio.");
  const connect = vr.connect();
  connect.stream({ url: "wss://bot.demo.example/audio" });
  xml(res, vr);
});

app.listen(4002, () => console.log("Full-PV demo app on :4002"));
