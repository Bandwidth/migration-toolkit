import { analyzeSource } from "../preflight/analyze.js";

// A single translatable TwiML document pulled out of the customer's app:
// a standalone .xml file, a <Response> string embedded in source, or a TwiML
// response recorded in a capture/*.json file.
export interface TwimlDoc {
  label: string; // human-facing label, e.g. "menu.xml" or "menu.xml#2"
  source: string; // the file it came from
  twiml: string; // the <Response>...</Response> markup
}

// A source file that builds TwiML dynamically at runtime (via the Twilio SDK),
// so there is no literal markup to transpile. These need a captured response or
// a human — they are reported, not generated.
export interface DynamicSource {
  file: string;
  verbs: string[];
}

export interface IngestResult {
  docs: TwimlDoc[];
  dynamicSources: DynamicSource[];
}

const RESPONSE_BLOCK = /<Response[\s\S]*?<\/Response>/g;

/** Every <Response>...</Response> block in a blob of text (source, XML, JSON). */
export function extractTwimlBlocks(content: string): string[] {
  return content.match(RESPONSE_BLOCK) ?? [];
}

/**
 * Normalize a set of files into translatable TwiML docs plus a list of
 * dynamic source files. `files` is the already-read contents — ingest does no
 * I/O so it stays trivially testable.
 */
export function ingest(files: { file: string; content: string }[]): IngestResult {
  const docs: TwimlDoc[] = [];
  const dynamicSources: DynamicSource[] = [];

  for (const { file, content } of files) {
    const blocks = extractTwimlBlocks(content);
    blocks.forEach((twiml, i) => {
      docs.push({
        label: blocks.length > 1 ? `${file}#${i + 1}` : file,
        source: file,
        twiml,
      });
    });

    // A file that pulls in the Twilio SDK builds TwiML at runtime; the literal
    // blocks above (if any) are only part of the story, so flag it for a human.
    const analysis = analyzeSource(file, content);
    if (analysis.sdkDetected) {
      dynamicSources.push({ file, verbs: analysis.verbs });
    }
  }

  return { docs, dynamicSources };
}
