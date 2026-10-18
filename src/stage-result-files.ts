import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scrubCredentials } from "./agent-runtime.js";
import type { StageFile } from "./stage-results.js";
/** Retain exact bounded capture bytes in the acceptance record. Logs and pointers are not captures. */
export function retainedStageFiles(root: string | null | undefined, names: readonly string[] = []): StageFile[] {
    if (!root || names.length === 0)
        return [];
    const files: StageFile[] = [];
    let bytes = 0;
    if (!lstatSync(root).isDirectory())
        throw new Error("Stage evidence root must not be a link");
    for (const name of names) {
        if (!/^[\w./-]+$/.test(name) || name.startsWith("/") || name.split("/").some(n => !n || n === "." || n === ".."))
            throw new Error("Invalid stage capture path");
        let path = root;
        let missing = false;
        for (const part of name.split("/")) {
            path = join(path, part);
            try {
                if (lstatSync(path).isSymbolicLink())
                    throw new Error("Stage evidence may not follow symbolic links");
            }
            catch (error: any) {
                if (error.code === "ENOENT") {
                    missing = true;
                    break;
                }
                throw error;
            }
        }
        if (missing)
            continue;
        const st = lstatSync(path);
        if (!st.isFile())
            throw new Error("Stage capture must be a file");
        bytes += st.size;
        if (bytes > 768 * 1024 || files.length >= 100)
            throw new Error("Stage evidence exceeds retained result bounds");
        const data = readFileSync(path), text = data.toString("utf8");
        if (!text.trim() || !Buffer.from(text).equals(data) || scrubCredentials(text) !== text)
            throw new Error("Stage capture is empty, non-UTF8 or needs scrubbing");
        files.push({ name, text });
    }
    return files;
}
/** Explicit output names in the approved PR plan. No inference from prose or aggregate totals. */
export function declaredStageArtifacts(body: string): string[] {
    const section = /^## Live artifacts\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(body);
    if (!section)
        return [];
    return section[1].split("\n").filter(l => l.trim()).map(line => {
        const match = /^\s*-\s+`([\w./-]+)`\s*$/.exec(line);
        if (!match)
            throw new Error("Live artifacts must list exact relative capture paths");
        return match[1];
    });
}
