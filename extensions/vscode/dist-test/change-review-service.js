"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.changeReviewService = exports.ChangeReviewService = void 0;
const crypto = __importStar(require("node:crypto"));
const fs = __importStar(require("node:fs/promises"));
const path = __importStar(require("node:path"));
const reviewable_file_filter_1 = require("./reviewable-file-filter");
/**
 * Tracks pending agent-created file changes for Copilot-style review UI.
 *
 * Baseline is captured once before the first service-managed write. Repeated
 * service-managed writes update lastReviewHash so they do not look like manual
 * conflicts. Keep/Undo check the disk hash against lastReviewHash first.
 */
class ChangeReviewService {
    pending = new Map();
    getPendingReviews() {
        return Array.from(this.pending.values()).filter(review => review.status === 'pending' || review.status === 'conflict');
    }
    getPendingReview(filePath) {
        return this.pending.get(path.resolve(filePath));
    }
    async captureBeforeWrite(filePath) {
        const absPath = path.resolve(filePath);
        if (!reviewable_file_filter_1.ReviewableFileFilter.isReviewablePath(absPath) || this.pending.has(absPath)) {
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
    async recordAfterWrite(filePath) {
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
    async captureWorkspaceSnapshot() {
        const files = new Map();
        const paths = await this.listReviewableWorkspacePaths();
        for (const filePath of paths) {
            files.set(filePath, await this.readSnapshot(filePath));
        }
        return { capturedAt: Date.now(), files };
    }
    async recordWorkspaceChanges(snapshot) {
        const changedPaths = [];
        const afterPaths = await this.listReviewableWorkspacePaths();
        const candidatePaths = new Set([...snapshot.files.keys(), ...afterPaths]);
        for (const filePath of candidatePaths) {
            if (!reviewable_file_filter_1.ReviewableFileFilter.isReviewablePath(filePath)) {
                continue;
            }
            const before = snapshot.files.get(filePath) ?? { kind: 'missing', hash: null };
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
    async keep(filePath) {
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
    async undo(filePath) {
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
        }
        else if (review.baselineContent) {
            await this.atomicWrite(absPath, review.baselineContent);
        }
        review.status = 'undone';
        this.pending.delete(absPath);
        return { ok: true, status: 'undone', filePath: absPath, message: 'Restored file baseline.' };
    }
    async detectConflict(review) {
        const disk = await this.readSnapshot(review.filePath);
        const diskHash = disk.hash;
        review.currentKind = disk.kind === 'existing' ? 'existing' : 'deleted';
        review.currentHash = diskHash;
        if (diskHash !== review.lastReviewHash) {
            return 'File changed on disk after the last service-managed edit. Review before Keep/Undo.';
        }
        return null;
    }
    async listReviewableWorkspacePaths() {
        const vscode = await import('vscode');
        const uris = await vscode.workspace.findFiles('**/*', '{**/.git/**,**/node_modules/**,**/bower_components/**,**/vendor/**,**/dist/**,**/out/**,**/build/**,**/target/**,**/coverage/**,**/.next/**,**/.nuxt/**,**/.turbo/**,**/.cache/**,**/.parcel-cache/**,**/.pytest_cache/**,**/.mypy_cache/**,**/__pycache__/**,**/.gradle/**,**/.idea/**,**/.vscode-test/**}', 10000);
        const paths = new Set();
        for (const uri of uris) {
            if (reviewable_file_filter_1.ReviewableFileFilter.isReviewableUri(uri)) {
                paths.add(path.resolve(uri.fsPath));
            }
        }
        return Array.from(paths).sort();
    }
    async readSnapshot(filePath) {
        try {
            const content = await fs.readFile(filePath);
            return { kind: 'existing', hash: this.hash(content), content };
        }
        catch (error) {
            if (isNodeErrnoException(error) && error.code === 'ENOENT') {
                return { kind: 'missing', hash: null };
            }
            throw error;
        }
    }
    async atomicWrite(filePath, content) {
        const dir = path.dirname(filePath);
        await fs.mkdir(dir, { recursive: true });
        const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
        const handle = await fs.open(tempPath, 'w');
        try {
            await handle.writeFile(content);
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        await fs.rename(tempPath, filePath);
    }
    async safeDelete(filePath) {
        try {
            await fs.unlink(filePath);
        }
        catch (error) {
            if (!isNodeErrnoException(error) || error.code !== 'ENOENT') {
                throw error;
            }
        }
    }
    hash(content) {
        return crypto.createHash('sha256').update(content).digest('hex');
    }
}
exports.ChangeReviewService = ChangeReviewService;
function isNodeErrnoException(error) {
    return error instanceof Error && 'code' in error;
}
exports.changeReviewService = new ChangeReviewService();
//# sourceMappingURL=change-review-service.js.map