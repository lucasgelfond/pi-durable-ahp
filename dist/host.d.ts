import { type ActionEnvelope, type StateAction, type URI } from "@microsoft/agent-host-protocol";
export declare const ROOT = "ahp-root://";
type State = Record<string, unknown>;
export interface AhpHandlers {
    listSessions(): unknown[] | Promise<unknown[]>;
    hydrate?(uri: URI): Promise<boolean>;
    createSession?(params: Record<string, unknown>, clientId: string): Promise<void>;
    disposeSession?(uri: URI): Promise<void>;
    createChat?(params: Record<string, unknown>, clientId: string): Promise<void>;
    disposeChat?(uri: URI): Promise<void>;
    validate?(channel: URI, action: StateAction, clientId: string): string | undefined;
    acted?(channel: URI, action: StateAction, clientId: string): void;
    methods?: Record<string, (params: Record<string, unknown>, clientId: string) => Promise<unknown>>;
}
export interface Socket {
    readonly readyState: number;
    send(text: string): void;
    on(event: "message", listener: (data: unknown) => void): unknown;
    on(event: "close", listener: () => void): unknown;
}
export declare class AhpHost {
    #private;
    constructor(handlers: AhpHandlers, info: {
        name: string;
        version: string;
    });
    get<T = State>(uri: URI): T | undefined;
    has(uri: URI): boolean;
    create(uri: URI, state: object): void;
    delete(uri: URI): void;
    dispatch(channel: URI, action: StateAction, origin?: ActionEnvelope["origin"]): void;
    notify(channel: URI, method: string, params: object): void;
    local(onMessage: (message: {
        method: string;
        params: Record<string, unknown>;
    }) => void): {
        request<T = unknown>(method: string, params: object): Promise<T>;
        close(): void;
    };
    accept(socket: Socket): void;
}
export {};
