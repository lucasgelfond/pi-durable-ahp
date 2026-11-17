import type { AcpProvider } from "./acp-chat.ts";
export interface PiOptions {
    id?: string;
    displayName?: string;
    dir: string;
    pi?: string[];
    extension?: string;
    shell?: (script: string) => string[];
}
export declare function piAgent(opts: PiOptions): AcpProvider;
