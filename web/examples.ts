// Curated TwiML examples for the demo. Each is a realistic snippet chosen to
// show a distinct part of the story; the verdict for each is computed live by
// the real engine (buildView), not hardcoded here.

export interface Example {
  id: string;
  label: string;
  twiml: string;
}

export const EXAMPLES: Example[] = [
  {
    id: "ivr",
    label: "IVR Menu",
    twiml: `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Thanks for calling Northwind Support.</Say>
  <Gather numDigits="1" action="/menu" timeout="6">
    <Say>For billing, press 1. To reach an agent, press 2.</Say>
  </Gather>
  <Play>https://cdn.northwind.example/hold-music.mp3</Play>
  <Redirect>/main-menu</Redirect>
</Response>`,
  },
  {
    id: "recording",
    label: "Call Recording",
    twiml: `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Please leave a message after the tone.</Say>
  <Record action="/handle-recording" maxLength="120"
          recordingStatusCallback="/recording-ready" transcribe="true" />
</Response>`,
  },
  {
    id: "conference",
    label: "Dial to Conference",
    twiml: `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Connecting you to the conference now.</Say>
  <Dial>
    <Conference waitUrl="https://cdn.northwind.example/wait.mp3" beep="true"
                startConferenceOnEnter="true">support-room</Conference>
  </Dial>
</Response>`,
  },
  {
    id: "queue",
    label: "Unsupported (Queue)",
    twiml: `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>All agents are busy. Please hold.</Say>
  <Enqueue waitUrl="/hold-music">support-agents</Enqueue>
</Response>`,
  },
];

export const DEFAULT_EXAMPLE = EXAMPLES[0];
