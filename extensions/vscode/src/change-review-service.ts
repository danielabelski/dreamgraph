import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { ReviewableFileFilter } from './reviewable-file-filter';

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
  files: Map<string, { kind: 'existing' | 'missing'; hash: string | null; content?: Uint8Array }>;
}

/**
 * Tracks pending agent-created file changes for Copilot-style review UI.
 *
 * Baseline is captured once before the first service-managed write. Repeated
 * service-managed writes update lastReviewHash so they do not look like manual
 * conflicts. Keep/Undo check the disk hash against lastReviewHash first.
 */
export class ChangeReviewService {
  private readonly pending = new Map<string, PendingChangeReview>();

  getPendingReviews(): PendingChangeReview[] {
    return Array.from(this.pending.values()).filter(review => review.status === 'pending' || review.status === 'conflict');
  }

  getPendingReview(filePath: string): PendingChangeReview | undefined {
    return this.pending.get(path.resolve(filePath));
  }

  async captureBeforeWrite(filePath: string): Promise<void> {
    const absPath = path.resolve(filePath);

    if (!ReviewableFileFilter.isReviewablePath(absPath) || this.pending.has(absPath)) {
      return;
    }

    const before = await this.readSnapshot(absPath);
    const now = Date.now();

    this.pending.set(absPath, {
      filePath: absPath,
      baselineKind: before.kind === 'existing' ? 'existing' : 'missing',
      currentKind: before.kind === 'existing' ? 'existing' : 'deleted',
      baselineHash: before.hash,
      lastReviewHash: before.hash,
      currentHash: before.hash,
      baselineContent: before.content,
      createdAt: now,
      updatedAt: now,
      status: 'pending',
    });
  }

  async recordAfterWrite(filePath: string): Promise<void> {
    const absPath = path.resolve(filePath);
    const review = this.pending.get(absPath);

    if (!review) {
      return;
    }

    const after = await this.readSnapshot(absPath);
    review.currentKind = after.kind === 'existing' ? 'existing' : 'deleted';
    review.currentHash = after.hash;
    review.lastReviewHash = after.hash;
    review.updatedAt = Date.now();
    review.status = 'pending';
  }

  async captureWorkspaceSnapshot(): Promise<WorkspaceChangeReviewSnapshot> {
    const files = new Map<string, { kind: 'existing' | 'missing'; hash: string | null; content?: Uint8Array }>();
    const paths = await this.listReviewableWorkspacePaths();

    for (const filePath of paths) {
      files.set(filePath, await this.readSnapshot(filePath));
    }

    return { capturedAt: Date.now(), files };
  }

  async recordWorkspaceChanges(snapshot: WorkspaceChangeReviewSnapshot): Promise<string[]> {
    const changedPaths: string[] = [];
    const afterPaths = await this.listReviewableWorkspacePaths();
    const candidatePaths = new Set<string>([...snapshot.files.keys(), ...afterPaths]);

    for (const filePath of candidatePaths) {
      if (!ReviewableFileFilter.isReviewablePath(filePath)) {
        continue;
      }

      const before = snapshot.files.get(filePath) ?? { kind: 'missing' as const, hash: null };
      const after = await this.readSnapshot(filePath);

      if (before.hash === after.hash) {
        continue;
      }

      changedPaths.push(filePath);
      const existingReview = this.pending.get(filePath);
      if (existingReview) {
        existingReview.currentKind = after.kind === 'existing' ? 'existing' : 'deleted';
        existingReview.currentHash = after.hash;
        existingReview.lastReviewHash = after.hash;
        existingReview.updatedAt = Date.now();
        existingReview.status = 'pending';
        continue;
      }

      const now = Date.now();
      this.pending.set(filePath, {
        filePath,
        baselineKind: before.kind === 'existing' ? 'existing' : 'missing',
        currentKind: after.kind === 'existing' ? 'existing' : 'deleted',
        baselineHash: before.hash,
        lastReviewHash: after.hash,
        currentHash: after.hash,
        baselineContent: before.content,
        createdAt: now,
        updatedAt: now,
        status: 'pending',
      });
    }

    return changedPaths;
  }

  async keep(filePath: string): Promise<ReviewActionResult> {
    const absPath = path.resolve(filePath);
    const review = this.pending.get(absPath);

    if (!review) {
      return { ok: false, status: 'conflict', filePath: absPath, message: 'No pending review exists for this file.' };
    }

    const conflict = await this.detectConflict(review);
    if (conflict) {
      review.status = 'conflict';
      return { ok: false, status: 'conflict', filePath: absPath, message: conflict };
    }

    review.status = 'kept';
    this.pending.delete(absPath);
    return { ok: true, status: 'kept', filePath: absPath, message: 'Kept current file changes.' };
  }

  async undo(filePath: string): Promise<ReviewActionResult> {
    const absPath = path.resolve(filePath);
    const review = this.pending.get(absPath);

    if (!review) {
      return { ok: false, status: 'conflict', filePath: absPath, message: 'No pending review exists for this file.' };
    }

    const conflict = await this.detectConflict(review);
    if (conflict) {
      review.status = 'conflict';
      return { ok: false, status: 'conflict', filePath: absPath, message: conflict };
    }

    if (review.baselineKind === 'missing') {
      await this.safeDelete(absPath);
    } else if (review.baselineContent) {
      await this.atomicWrite(absPath, review.baselineContent);
    }

    review.status = 'undone';
    this.pending.delete(absPath);
    return { ok: true, status: 'undone', filePath: absPath, message: 'Restored file baseline.' };
  }

  private async detectConflict(review: PendingChangeReview): Promise<string | null> {
    const disk = await this.readSnapshot(review.filePath);
    const diskHash = disk.hash;
    review.currentKind = disk.kind === 'existing' ? 'existing' : 'deleted';
    review.currentHash = diskHash;

    if (diskHash !== review.lastReviewHash) {
      return 'File changed on disk after the last service-managed edit. Review before Keep/Undo.';
    }

    return null;
  }

  private async listReviewableWorkspacePaths(): Promise<string[]> {
    const vscode = await import('vscode');
    const uris = await vscode.workspace.findFiles(
      '**/*',
      '{**/.git/**,**/node_modules/**,**/bower_components/**,**/vendor/**,**/dist/**,**/out/**,**/build/**,**/target/**,**/coverage/**,**/.next/**,**/.nuxt/**,**/.turbo/**,**/.cache/**,**/.parcel-cache/**,**/.pytest_cache/**,**/.mypy_cache/**,**/__pycache__/**,**/.gradle/**,**/.idea/**,**/.vscode-test/**}',
      10000,
    );

    const paths = new Set<string>();
    for (const uri of uris) {
      if (ReviewableFileFilter.isReviewableUri(uri)) {
        paths.add(path.resolve(uri.fsPath));
      }
    }

    return Array.from(paths).sort();
  }

  private async readSnapshot(filePath: string): Promise<{ kind: 'existing' | 'missing'; hash: string | null; content?: Uint8Array }> {
    try {
      const content = await fs.readFile(filePath);
      return { kind: 'existing', hash: this.hash(content), content };
    } catch (error: unknown) {
      if (isNodeErrnoException(error) && error.code === 'ENOENT') {
        return { kind: 'missing', hash: null };
      }

      throw error;
    }
  }

  private async atomicWrite(filePath: string, content: Uint8Array): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });

    const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
    const handle = await fs.open(tempPath, 'w');

    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }

    await fs.rename(tempPath, filePath);
  }

  private async safeDelete(filePath: string): Promise<void> {
    try {
      await fs.unlink(filePath);
    } catch (error: unknown) {
      if (!isNodeErrnoException(error) || error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  private hash(content: Uint8Array): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }
}

function isNodeErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

export const changeReviewService = new ChangeReviewService();
