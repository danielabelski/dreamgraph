import * as vscode from "vscode";
export interface RenderHtmlInput {
    readonly webview: vscode.Webview;
    readonly extensionUri: vscode.Uri;
    /** Pre-populated provider options (rendered into initial HTML). */
    readonly providers?: ReadonlyArray<{
        id: string;
        displayName: string;
    }>;
    /** Pre-populated model options for the currently selected provider. */
    readonly models?: ReadonlyArray<{
        id: string;
        displayName: string;
    }>;
    /** Currently selected provider id, used to mark <option selected>. */
    readonly providerId?: string;
    /** Currently selected model id, used to mark <option selected>. */
    readonly modelId?: string;
    /** Currently selected autonomy mode, used to mark <option selected>. */
    readonly mode?: "cautious" | "conscientious" | "eager" | "autonomous";
}
export declare function renderHtml(input: RenderHtmlInput): string;
//# sourceMappingURL=webview.d.ts.map