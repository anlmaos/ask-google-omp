/**
 * Ambient declaration for the type-only omp import in `src/omp-extension.ts`.
 *
 * `@oh-my-pi/pi-coding-agent` is resolved by the omp host at extension load
 * time (inside the omp plugin's node_modules or its own runtime); it is
 * deliberately NOT a dependency of this package, so the compiler cannot
 * resolve it locally. Only the small `ExtensionAPI` surface this extension
 * actually uses is declared, keeping the runtime module free of any omp
 * dependency — `import type` is erased at build time.
 */

declare module "@oh-my-pi/pi-coding-agent" {
 export interface ExtensionAPI {
  /** Zod-compatible schema builder injected by the host. */
  zod: PiZod;
  /** Optional logger; absent in some runtimes. */
  logger?: { warn(message: string, context?: unknown): void };
  /** Register a tool the model can call. */
  registerTool<TParams, TDetails>(tool: {
   name: string;
   label: string;
   description: string;
   parameters: TParams;
   approval?: "read" | "write" | "exec";
   execute(
    toolCallId: string,
    params: PiStatic<TParams>,
    signal: AbortSignal | undefined,
    onUpdate:
     | ((update: {
      content: { type: "text"; text: string }[];
      details: unknown;
     }) => void)
     | undefined,
    ctx: unknown
   ): Promise<{
    content: { type: "text"; text: string }[];
    details: TDetails;
   }>;
   onSession?(event: { reason: string }): void;
  }): void;
 }

 /** Minimal structural stand-in for the injected Zod builder. */
 export interface PiZod {
  object(shape: Record<string, unknown>): {
   kind: "object";
   shape: Record<string, unknown>;
  };
  string(): { kind: "string"; describe(text: string): unknown };
  number(): PiNumberSchema;
 }

 /** A number parameter node; optional() then describe() is the chain this extension uses. */
 export interface PiNumberSchema {
  kind: "number";
  optional(): PiNumberSchema;
  describe(text: string): PiNumberSchema;
 }

 /** Resolve a schema shape to its parameter object. */
 export type PiStatic<_TShape> = Record<string, unknown>;
}
