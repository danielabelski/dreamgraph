// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Copilot CLI adapter — real `CopilotCliFsPort` (Slice 3).
//
// Thin shim over `node:fs/promises`, `node:os`, and `node:path`.
// All policy lives in `orchestrator.ts` (the orchestrator decides which
// directories exist, which mode bits to ask for, etc.). This file
// only translates port calls into stdlib calls.

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

import type { CopilotCliFsPort } from "../orchestrator-ports.js";

export const HOST_FS: CopilotCliFsPort = Object.freeze({
  async mkdtemp(prefix: string): Promise<string> {
    // `fs.mkdtemp` requires the prefix path to already exist; OS tmpdir
    // is always present, so we anchor there. `mkdtemp` appends 6
    // random chars and returns the full absolute path.
    return mkdtemp(join(tmpdir(), prefix));
  },

  async mkdir(
    absPath: string,
    opts?: { readonly recursive?: boolean; readonly mode?: number },
  ): Promise<void> {
    await mkdir(absPath, {
      recursive: opts?.recursive ?? true,
      mode: opts?.mode,
    });
  },

  async writeFile(
    absPath: string,
    contents: string,
    opts?: { readonly mode?: number },
  ): Promise<void> {
    await writeFile(absPath, contents, {
      encoding: "utf8",
      mode: opts?.mode,
    });
  },

  async rmRecursive(absPath: string): Promise<void> {
    await rm(absPath, { recursive: true, force: true });
  },

  async copyDirRecursive(
    srcAbsPath: string,
    dstAbsPath: string,
    opts?: { readonly excludeNames?: readonly string[] },
  ): Promise<void> {
    const exclude = new Set(opts?.excludeNames ?? []);
    await cp(srcAbsPath, dstAbsPath, {
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
      filter: (src) => !exclude.has(basename(src)),
    });
  },

  async readFileUtf8(absPath: string): Promise<string | null> {
    try {
      return await readFile(absPath, { encoding: "utf8" });
    } catch (err) {
      // Distinguish "file does not exist" from "file unreadable". The
      // former is a normal first-run state (user hasn't logged in yet);
      // the latter is a real I/O failure that must surface.
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
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
