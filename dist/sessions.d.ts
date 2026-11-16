import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Context } from "@earendil-works/chord/context";
import { type Conversation, type ConversationId, type Harness } from "@earendil-works/pi-durable";
import { type WebSocket } from "ws";
import { type Entry } from "./chat.ts";
import { type AcpProvider } from "./acp-chat.ts";
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
    agent?: {
        provider: string;
        displayName: string;
        description?: string;
        models?: unknown[];
    };
    providers?: AcpProvider[];
    create?(session: string, given: {
        workingDirectory?: string;
    }): Promise<Conversation>;
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
    committed?(session: string, entries: readonly Entry[], key?: string): void;
}
export declare function durableAhp(opts: DurableAhpOptions): {
    host: AhpHost;
    conversation: (session: string) => Promise<Conversation>;
    catalogue: () => Promise<({
        workingDirectories: string[];
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
    } | {
        workingDirectories?: undefined;
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
    })[]>;
    adopt(session: string, id: ConversationId, known?: {
        title?: string;
        created?: string;
        meta?: Record<string, unknown>;
    }): Promise<boolean>;
    changed: (session: string) => Promise<void>;
    reset(): void;
    close(): void;
    accept: (ws: WebSocket) => void;
    upgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
};
