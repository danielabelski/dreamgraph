import type { AttachmentPort, AutonomyPort, ContextBuilderPort, MemoryPort, PromptComposerPort, ProviderPort, ToolExecutorPort } from "../ports.js";
import type { ChatPanelHost } from "./host.js";
export declare function createContextBuilderPort(host: ChatPanelHost): ContextBuilderPort;
export declare function createPromptComposerPort(host: ChatPanelHost): PromptComposerPort;
export declare function createProviderPort(host: ChatPanelHost): ProviderPort;
export declare function createToolExecutorPort(host: ChatPanelHost): ToolExecutorPort;
export declare function createMemoryPort(host: ChatPanelHost): MemoryPort;
export declare function createAttachmentPort(host: ChatPanelHost): AttachmentPort;
export declare function createAutonomyPort(host: ChatPanelHost): AutonomyPort;
//# sourceMappingURL=v1.d.ts.map