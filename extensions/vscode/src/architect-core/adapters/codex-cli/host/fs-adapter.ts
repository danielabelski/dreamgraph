// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Codex CLI adapter - real filesystem port (Slice 3).

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

import type { CodexCliFsPort } from "../orchestrator-ports.js";

export const HOST_FS: CodexCliFsPort = Object.freeze({
  async mkdtemp(prefix: string): Promise<string> {
    return mkdtemp(join(tmpdir(), prefix));
  },

  async mkdir(absPath: string, opts?: { readonly recursive?: boolean; readonly mode?: number }): Promise<void> {
    await mkdir(absPath, { recursive: opts?.recursive ?? true, mode: opts?.mode });
  },

  async writeFile(absPath: string, contents: string, opts?: { readonly mode?: number }): Promise<void> {
    await writeFile(absPath, contents, { encoding: "utf8", mode: opts?.mode });
  },

  async readFileUtf8(absPath: string): Promise<string | null> {
    try {
      return await readFile(absPath, { encoding: "utf8" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw err;
    }
  },

  async rmRecursive(absPath: string): Promise<void> {
    await rm(absPath, { recursive: true, force: true });
  },

  async copyDirRecursive(srcAbsPath: string, dstAbsPath: string, opts?: { readonly excludeNames?: readonly string[] }): Promise<boolean> {
    const exclude = new Set(opts?.excludeNames ?? []);
    try {
      await cp(srcAbsPath, dstAbsPath, {
        recursive: true,
        preserveTimestamps: false,
        dereference: true,
        force: true,
        filter: (src) => !exclude.has(basename(src)),
      });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return false;
      throw err;
    }
  },

  homeDir(): string {
    return homedir();
  },

  joinPath(...segments: readonly string[]): string {
    return join(...segments);
  },
});
