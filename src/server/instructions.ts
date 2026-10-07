import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const MAX_BYTES = 512 * 1024;
const ALLOWED_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);

export class InstructionsPathError extends Error {}

function allowedRoots(): string[] {
  return [process.env.PAPERCLIP_HOME, homedir()].filter((r): r is string => Boolean(r)).map((r) => path.resolve(r));
}

/**
 * Reads an agent instructions file that Paperclip manages on its own host.
 * The path comes from agent configuration, so it is confined: after resolving
 * symlinks it must sit under the Paperclip home (or the process home), be a
 * small text or markdown file, and not escape through a link.
 */
export async function readInstructionsFile(requested: string): Promise<string> {
  const real = await realpath(requested);
  if (!ALLOWED_EXTENSIONS.has(path.extname(real).toLowerCase())) {
    throw new InstructionsPathError("instructions file must be .md, .markdown or .txt");
  }
  const roots = await Promise.all(
    allowedRoots().map(async (r) => {
      try {
        return await realpath(r);
      } catch {
        return r;
      }
    }),
  );
  if (!roots.some((root) => real === root || real.startsWith(root + path.sep))) {
    throw new InstructionsPathError("instructions file is outside the Paperclip home directory");
  }
  const info = await stat(real);
  if (!info.isFile() || info.size > MAX_BYTES) {
    throw new InstructionsPathError(`instructions file must be a regular file under ${MAX_BYTES} bytes`);
  }
  return readFile(real, "utf8");
}
