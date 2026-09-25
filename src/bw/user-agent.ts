import pkg from "../../package.json" with { type: "json" };

/**
 * Client identifier sent on every outbound Bandwidth request so BW can
 * attribute traffic to this adapter and version. Format: `bw-voice-adapter/<version>`.
 */
export const USER_AGENT = `bw-voice-adapter/${pkg.version}`;
