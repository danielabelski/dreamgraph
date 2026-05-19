import * as vscode from 'vscode';
/**
 * Shared source/source-equivalent file filter for changed-file tracking and
 * pending review diffs. The default policy intentionally ignores binaries,
 * dependency folders, build outputs, caches, VCS internals, and other noisy
 * generated artifacts under the workspace root.
 */
export declare class ReviewableFileFilter {
    private static readonly reviewableExtensions;
    private static readonly reviewableBasenames;
    private static readonly ignoredPathSegments;
    private static readonly ignoredExtensions;
    static isReviewableUri(uri: vscode.Uri): boolean;
    static isReviewablePath(filePath: string): boolean;
}
export declare const TrackableFileFilter: typeof ReviewableFileFilter;
//# sourceMappingURL=reviewable-file-filter.d.ts.map