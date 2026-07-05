declare module "turndown" {
  export interface TurndownOptions {
    headingStyle?: "atx" | "setext";
    bulletListMarker?: string;
    codeBlockStyle?: "indented" | "fenced";
    linkStyle?: "inlined" | "referenced";
    emDelimiter?: string;
    strongDelimiter?: string;
  }
  export interface TurndownRule {
    filter: string | ((node: Node) => boolean);
    replacement: (content: string, node: Node) => string;
  }
  export default class TurndownService {
    constructor(options?: TurndownOptions);
    turndown(input: string): string;
    remove(tags: string[]): void;
    addRule(name: string, rule: TurndownRule): void;
  }
}
