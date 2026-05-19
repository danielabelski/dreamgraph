export type ReviewFileKind = 'existing' | 'missing' | 'deleted';
export type ReviewStatus = 'pending' | 'kept' | 'undone' | 'conflict';
export interface PendingChangeReview {
    filePath: string;
    baselineKind: 'existing' | 'missing';
    currentKind: 'existing' | 'deleted';
    baselineHash: string | null;
    lastReviewHash: string | null;
    currentHash: string | null;
    baselineContent?: Uint8Array;
    createdAt: number;
    updatedAt: number;
    status: ReviewStatus;
}
export interface ReviewActionResult {
    ok: boolean;
    status: ReviewStatus;
    filePath: string;
    message: string;
}
export interface WorkspaceChangeReviewSnapshot {
    capturedAt: number;
    files: Map<string, {
        kind: 'existing' | 'missing';
        hash: string | null;
        content?: Uint8Array;
    }>;
}
/**
 * Tracks pending agent-created file changes for Copilot-style review UI.
 *
 * Baseline is captured once before the first service-managed write. Repeated
 * service-managed writes update lastReviewHash so they do not look like manual
 * conflicts. Keep/Undo check the disk hash against lastReviewHash first.
 */
export declare class ChangeReviewService {
    private readonly pending;
    getPendingReviews(): PendingChangeReview[];
    getPendingReview(filePath: string): PendingChangeReview | undefined;
    captureBeforeWrite(filePath: string): Promise<void>;
    recordAfterWrite(filePath: string): Promise<void>;
    captureWorkspaceSnapshot(): Promise<WorkspaceChangeReviewSnapshot>;
    recordWorkspaceChanges(snapshot: WorkspaceChangeReviewSnapshot): Promise<string[]>;
    keep(filePath: string): Promise<ReviewActionResult>;
    undo(filePath: string): Promise<ReviewActionResult>;
    private detectConflict;
    private listReviewableWorkspacePaths;
    private readSnapshot;
    private atomicWrite;
    private safeDelete;
    private hash;
}
export declare const changeReviewService: ChangeReviewService;
//# sourceMappingURL=change-review-service.d.ts.map