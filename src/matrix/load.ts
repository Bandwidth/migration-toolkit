import { z } from "zod";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const Status = z.enum(["supported", "partial", "unsupported"]);

const AttrMappingSchema = z.object({
  bxml: z.string().nullable(),
  status: Status,
  notes: z.string().optional().default(""),
});

const VerbMappingSchema = z.object({
  bxml: z.string().nullable(),
  status: Status,
  notes: z.string().optional().default(""),
  docsUrl: z.string().optional(),
  attributes: z.record(z.string(), AttrMappingSchema).default({}),
});

const MatrixSchema = z.object({
  provider: z.literal("twilio"),
  target: z.literal("bandwidth"),
  verbs: z.record(z.string(), VerbMappingSchema),
});

export type CompatStatus = z.infer<typeof Status>;
export type VerbMapping = z.infer<typeof VerbMappingSchema>;
export type CompatMatrix = z.infer<typeof MatrixSchema>;

export function loadMatrix(): CompatMatrix {
  return MatrixSchema.parse(require("./twilio-voice.json"));
}
