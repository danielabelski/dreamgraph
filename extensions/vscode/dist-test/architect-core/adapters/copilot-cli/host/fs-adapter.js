"use strict";
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Copilot CLI adapter — real `CopilotCliFsPort` (Slice 3).
//
// Thin shim over `node:fs/promises`, `node:os`, and `node:path`.
// All policy lives in `orchestrator.ts` (the orchestrator decides which
// directories exist, which mode bits to ask for, etc.). This file
// only translates port calls into stdlib calls.
Object.defineProperty(exports, "__esModule", { value: true });
exports.HOST_FS = void 0;
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
exports.HOST_FS = Object.freeze({
    async mkdtemp(prefix) {
        // `fs.mkdtemp` requires the prefix path to already exist; OS tmpdir
        // is always present, so we anchor there. `mkdtemp` appends 6
        // random chars and returns the full absolute path.
        return (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), prefix));
    },
    async mkdir(absPath, opts) {
        await (0, promises_1.mkdir)(absPath, {
            recursive: opts?.recursive ?? true,
            mode: opts?.mode,
        });
    },
    async writeFile(absPath, contents, opts) {
        await (0, promises_1.writeFile)(absPath, contents, {
            encoding: "utf8",
            mode: opts?.mode,
        });
    },
    async rmRecursive(absPath) {
        await (0, promises_1.rm)(absPath, { recursive: true, force: true });
    },
    async copyDirRecursive(srcAbsPath, dstAbsPath, opts) {
        const exclude = new Set(opts?.excludeNames ?? []);
        await (0, promises_1.cp)(srcAbsPath, dstAbsPath, {
            recursive: true,
            // Preserve mode bits where the host can express them. Symlinks
            // are dereferenced — a symlinked auth file in the source HOME
            // becomes a real file in the per-run HOME, which is the safe
            // default for credential material we don't want to mutate via
            // the original target.
            preserveTimestamps: false,
            dereference: true,
            // Filter runs for every entry (files AND directories). Returning
            // `false` for a directory skips the entire subtree.
            filter: (src) => !exclude.has((0, node_path_1.basename)(src)),
        });
    },
    async readFileUtf8(absPath) {
        try {
            return await (0, promises_1.readFile)(absPath, { encoding: "utf8" });
        }
        catch (err) {
            // Distinguish "file does not exist" from "file unreadable". The
            // former is a normal first-run state (user hasn't logged in yet);
            // the latter is a real I/O failure that must surface.
            if (err?.code === "ENOENT")
                return null;
            throw err;
        }
    },
    homeDir() {
        return (0, node_os_1.homedir)();
    },
    joinPath(...segments) {
        return (0, node_path_1.join)(...segments);
    },
});
//# sourceMappingURL=fs-adapter.js.map