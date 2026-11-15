import type { Context } from "@earendil-works/chord/context";
import { type Conversation, type Harness } from "@earendil-works/pi-durable";
import type { URI } from "@microsoft/agent-host-protocol";
import type { AhpHost } from "./host.ts";
export declare const inputFrom: (origin?: string) => {} | {
    entry: {
        kind: string;
        data: {
            origin: string;
        };
    };
};
export declare function chatState(uri: URI, title: string, meta?: Record<string, unknown>): {
    resource: string;
    title: string;
    status: number;
    modifiedAt: string;
    origin: {
        kind: string;
    };
    turns: unknown[];
    _meta?: Record<string, unknown> | undefined;
};
export declare class DurableChat {
    #private;
    readonly host: AhpHost;
    readonly harness: Harness;
    readonly conversation: Conversation;
    readonly uri: URI;
    readonly ctx: Context;
    readonly onStatus?: (status: number) => void;
    readonly named: (id: string) => string;
    readonly send?: (text: string, turnId: string) => Promise<void>;
    readonly input: (text: string) => string;
    readonly said: (text: string) => string;
    constructor(opts: {
        host: AhpHost;
        harness: Harness;
        conversation: Conversation;
        uri: URI;
        ctx: Context;
        onStatus?: (status: number) => void;
        named?: (id: string) => string;
        send?: (text: string, turnId: string) => Promise<void>;
        input?: (text: string) => string;
        said?: (text: string) => string;
    });
    get running(): boolean;
    open(title: string, meta?: Record<string, unknown>): Promise<void>;
    started(turnId: string, text: string): Promise<void>;
    pending(kind: "steering" | "queued", id: string, text: string): Promise<void>;
    refused(turnId: string, why: string): void;
    cancel(): Promise<void>;
    busy(): Promise<boolean>;
}
