import type { IncomingMessage, ServerResponse } from "node:http";
import { type Duplex } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { type AhpHost } from "./host.ts";
export declare function acpFront(host: AhpHost, opts: {
    info: {
        name: string;
        version: string;
    };
    cwd?: string;
    contextWindow?: number;
}): {
    http: (req: IncomingMessage, res: ServerResponse) => void;
    upgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
    stdio: () => acp.AgentConnection;
};
