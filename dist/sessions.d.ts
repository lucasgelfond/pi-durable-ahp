import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Context } from "@earendil-works/chord/context";
import { type Conversation, type ConversationId, type Harness } from "@earendil-works/pi-durable";
import { type WebSocket } from "ws";
import { AhpHost } from "./host.ts";
export interface Chat {
    key: string;
    title: string;
    working?: boolean;
    modifiedAt?: string;
    conversation?: ConversationId;
    _meta?: Record<string, unknown>;
}
export interface DurableAhpOptions {
    harness: () => Harness;
    context: Context;
    info: {
        name: string;
        version: string;
    };
    agent: {
        provider: string;
        displayName: string;
        description?: string;
        models?: unknown[];
    };
    create?(session: string): Promise<Conversation>;
    opened?(session: string, conversation: Conversation): void;
    title?(session: string): string | undefined;
    meta?(session: string): Record<string, unknown> | undefined;
    chats?(session: string): Chat[];
    send?(session: string, key: string, text: string): Promise<string | undefined>;
    cancel?(session: string, key: string): Promise<void>;
    dispose?(session: string, key: string): Promise<void>;
    named?(modelId: string): string;
    input?(text: string): string;
    said?(text: string): string;
    methods?: Record<string, (params: Record<string, unknown>, clientId: string) => Promise<unknown>>;
}
export declare function durableAhp(opts: DurableAhpOptions): {
    host: AhpHost;
    acp: (acpOpts?: {
        cwd?: string;
        contextWindow?: number;
    }) => {
        http: (req: IncomingMessage, res: import("http").ServerResponse) => void;
        upgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
        stdio: () => import("@agentclientprotocol/sdk").AgentConnection;
    };
    conversation: (session: string) => Promise<Conversation>;
    catalogue: () => Promise<{
        resource: string;
        provider: string;
        title: string;
        status: number;
        createdAt: string;
        modifiedAt: string;
        defaultChat: string;
        chats: {
            resource: string;
            title: string;
            status: number;
            modifiedAt: string;
            origin: {
                kind: string;
            };
            _meta?: Record<string, unknown> | undefined;
        }[];
        _meta?: Record<string, unknown> | undefined;
    }[]>;
    changed: (session: string) => Promise<void>;
    reset(): void;
    accept: (ws: WebSocket) => void;
    upgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
};
