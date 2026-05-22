"use strict";
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Codex CLI adapter - real filesystem port (Slice 3).
Object.defineProperty(exports, "__esModule", { value: true });
exports.HOST_FS = void 0;
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
exports.HOST_FS = Object.freeze({
    async mkdtemp(prefix) {
        return (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), prefix));
    },
    async mkdir(absPath, opts) {
        await (0, promises_1.mkdir)(absPath, { recursive: opts?.recursive ?? true, mode: opts?.mode });
    },
    async writeFile(absPath, contents, opts) {
        await (0, promises_1.writeFile)(absPath, contents, { encoding: "utf8", mode: opts?.mode });
    },
    async readFileUtf8(absPath) {
        try {
            return await (0, promises_1.readFile)(absPath, { encoding: "utf8" });
        }
        catch (err) {
            if (err?.code === "ENOENT")
                return null;
            throw err;
        }
    },
    async rmRecursive(absPath) {
        await (0, promises_1.rm)(absPath, { recursive: true, force: true });
    },
    async copyDirRecursive(srcAbsPath, dstAbsPath, opts) {
        const exclude = new Set(opts?.excludeNames ?? []);
        try {
            await (0, promises_1.cp)(srcAbsPath, dstAbsPath, {
                recursive: true,
                preserveTimestamps: false,
                dereference: true,
                force: true,
                filter: (src) => !exclude.has((0, node_path_1.basename)(src)),
            });
            return true;
        }
        catch (err) {
            if (err?.code === "ENOENT")
                return false;
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