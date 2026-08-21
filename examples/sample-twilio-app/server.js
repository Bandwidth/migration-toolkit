const express = require("express");
const { twiml } = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: false }));

app.post("/voice", (req, res) => {
  const vr = new twiml.VoiceResponse();
  const gather = vr.gather({ numDigits: 1, action: "/menu", method: "POST" });
  gather.say("Welcome to the Bandwidth translator demo. Press 1 for sales. Press 2 to leave a message.");
  vr.say("We did not receive input. Goodbye.");
  res.type("text/xml").send(vr.toString());
});

app.post("/menu", (req, res) => {
  const vr = new twiml.VoiceResponse();
  if (req.body.Digits === "1") {
    vr.say("Connecting you to sales.");
    vr.dial("+19195550100");
  } else if (req.body.Digits === "2") {
    vr.say("Leave a message after the tone.");
    vr.record({ maxLength: 30, action: "/voice" });
  } else {
    vr.say("That was not a valid choice.");
    vr.redirect("/voice");
  }
  res.type("text/xml").send(vr.toString());
});

app.listen(4000, () => console.log("Sample Twilio app listening on :4000"));
