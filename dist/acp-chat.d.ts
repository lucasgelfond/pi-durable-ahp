import type { URI } from "@microsoft/agent-host-protocol";
import type { AhpHost } from "./host.ts";
export interface AcpProvider {
    id: string;
    displayName: string;
    description?: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
}
export declare class AcpChat {
    #private;
    readonly host: AhpHost;
    readonly uri: URI;
    readonly provider: AcpProvider;
    readonly cwd: string;
    readonly onStatus?: (status: number) => void;
    readonly onSession?: (sessionId: string) => Promise<void>;
    readonly onTitle?: (title: string) => void;
    constructor(opts: {
        host: AhpHost;
        uri: URI;
        provider: AcpProvider;
        cwd: string;
        session?: string;
        onStatus?: (status: number) => void;
        onSession?: (sessionId: string) => Promise<void>;
        onTitle?: (title: string) => void;
    });
    get running(): boolean;
    open(title: string, meta?: Record<string, unknown>): void;
    answerable(turnId: string, toolCallId: string, approved: boolean, optionId?: string): string | undefined;
    answered(toolCallId: string, approved: boolean, optionId?: string): void;
    started(turnId: string, text: string): Promise<void>;
    pending(kind: "steering" | "queued", id: string, text: string): Promise<void>;
    refused(turnId: string, why: string): void;
    cancel(): Promise<void>;
    stop(): void;
}
