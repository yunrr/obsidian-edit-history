// Edit history file format helpers and history merge logic.
//
// This module deliberately has no Obsidian imports so the format and merge
// logic can be exercised directly (see the Node harness under .context/).
//
// Format recap (see README "The edit history file"):
//  - One zip entry per stored version
//  - The entry name is the UTC epoch in seconds (base-36), suffixed with "$"
//    when the version is stored in full
//  - The newest version is always stored in full, older versions are stored as
//    backwards diff-match-patch patches (newer version -> that older version),
//    which makes every chain self contained

// @ts-ignore: Complains about default export this way, but since jszip 3.10
// this is the recommended way
import JSZip from "jszip";

export const EDIT_HISTORY_FILE_EXT = ".edtz";
export const HISTORY_SUFFIX_MARKER = ".eh-";
export const MAX_HISTORY_SUFFIX_LENGTH = 64;

// Characters Obsidian does not allow in file or folder names and the path
// separators, so a suffix can never escape the note directory. Control
// characters are checked separately in containsControlChar below
const INVALID_SUFFIX_CHARS = /[\\/:*?"<>|#^[\]]/;

// Entry names are the base-36 UTC epoch in seconds, with a trailing "$" for
// versions stored in full. Validating them avoids reading an unrelated zip
// file that happens to be named like a history file
const HISTORY_ENTRY_NAME = /^[0-9a-z]+\$?$/;

function containsControlChar(value: string): boolean {
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if ((code < 0x20) || (code == 0x7f)) {
            return true;
        }
    }
    return false;
}

export interface HistoryVersion {
    // Milliseconds since the epoch, as encoded in the entry name (second
    // precision)
    epoch: number;
    // Contents of the note at that version
    content: string;
}

export interface HistoryPathInfo {
    notePath: string;
    // null for legacy shared history files (no suffix)
    suffix: string | null;
}

// The subset of diff-match-patch used here, kept structural so callers can
// pass a DiffMatchPatch instance (whose methods also take optional arguments)
export interface PatchEngine {
    patch_fromText(patchText: string): any;
    patch_toText(patches: any): string;
    patch_make(text1: any, text2: any, ...rest: any[]): any;
    patch_apply(patches: any, text: string, ...rest: any[]): [string, boolean[]];
}

export function historyEntryEpoch(entryName: string): number {
    return parseInt(entryName, 36) * 1000;
}

export function historyEntryIsDiff(entryName: string): boolean {
    return !entryName.endsWith("$");
}

export function buildHistoryEntryName(mtime: number, isDiff: boolean): string {
    const utcepoch = Math.floor(mtime / 1000);
    return utcepoch.toString(36) + (isDiff ? "" : "$");
}

/**
 * Sort in place, most recent first
 */
function sortHistoryEntriesDescending(entryNames: string[]): void {
    entryNames.sort((a, b) => historyEntryEpoch(b) - historyEntryEpoch(a));
}

/**
 * @return the trimmed suffix or null if it is empty or would produce an
 *         invalid or unsafe history file name
 */
export function normalizeHistorySuffix(suffix: string): string | null {
    if (typeof suffix !== "string") {
        return null;
    }

    const trimmed = suffix.trim();
    if ((trimmed.length == 0) || (trimmed.length > MAX_HISTORY_SUFFIX_LENGTH)) {
        return null;
    }
    if (INVALID_SUFFIX_CHARS.test(trimmed) || trimmed.includes("..") || containsControlChar(trimmed)) {
        return null;
    }

    return trimmed;
}

/**
 * List the possible note paths a history file path may belong to, most
 * specific first. A note file named e.g. "a.eh-b.md" makes the suffix of
 * "a.eh-b.md.edtz" ambiguous, so both interpretations are returned and the
 * caller picks the one whose note exists.
 */
export function deriveHistoryNotePathCandidates(historyPath: string, rootFolder: string): HistoryPathInfo[] {
    if (!historyPath.endsWith(EDIT_HISTORY_FILE_EXT)) {
        return [];
    }

    let path = historyPath;
    const root = (rootFolder ?? "").replace(/^\/+|\/+$/g, "");
    if (root.length > 0) {
        if (!path.startsWith(root + "/")) {
            return [];
        }
        path = path.substring(root.length + 1);
    }

    const withoutExt = path.substring(0, path.length - EDIT_HISTORY_FILE_EXT.length);
    const candidates: HistoryPathInfo[] = [];

    const markerIndex = withoutExt.lastIndexOf(HISTORY_SUFFIX_MARKER);
    if (markerIndex > 0) {
        const suffix = withoutExt.substring(markerIndex + HISTORY_SUFFIX_MARKER.length);
        if (suffix.length > 0) {
            candidates.push({ notePath: withoutExt.substring(0, markerIndex), suffix: suffix });
        }
    }

    // Legacy shared history file (or a note whose name contains the marker)
    candidates.push({ notePath: withoutExt, suffix: null });

    return candidates;
}

export interface VersionListReadResult {
    versions: HistoryVersion[];
    error: string | null;
}

/**
 * Rebuild every version stored in a history archive, most recent first.
 * The newest entry must be a full version, otherwise the chain cannot be
 * rebuilt and an error is returned.
 */
export async function readHistoryVersions(zip: JSZip, patchEngine: PatchEngine): Promise<VersionListReadResult> {
    const entryNames: string[] = [];
    zip.forEach((relativePath: string) => {
        entryNames.push(relativePath);
    });

    if (entryNames.length == 0) {
        return { versions: [], error: "history file has no entries" };
    }

    for (const entryName of entryNames) {
        if (!HISTORY_ENTRY_NAME.test(entryName)) {
            return { versions: [], error: "entry " + entryName + " is not a history entry name" };
        }
    }

    sortHistoryEntriesDescending(entryNames);

    const versions: HistoryVersion[] = [];
    let content: string | null = null;
    for (const entryName of entryNames) {
        const entry = zip.file(entryName);
        if (entry == null) {
            continue;
        }

        const entryData = await entry.async("string");
        let versionContent: string;
        if (historyEntryIsDiff(entryName)) {
            if (content == null) {
                return { versions: [], error: "newest entry " + entryName + " is a diff, cannot rebuild the chain" };
            }
            versionContent = patchEngine.patch_apply(patchEngine.patch_fromText(entryData), content)[0];
        } else {
            versionContent = entryData;
        }

        content = versionContent;
        versions.push({ epoch: historyEntryEpoch(entryName), content: versionContent });
    }

    return { versions: versions, error: null };
}

export interface MergedVersions {
    // Ascending by epoch
    versions: HistoryVersion[];
    // Number of versions dropped because another source already had that epoch.
    // Note this is only about entry name collisions (second precision), not
    // about different contents at the same epoch; the latter is tracked by the
    // plugin while merging file sources
    duplicateEpochs: number;
}

/**
 * Merge version lists, earlier lists win. Versions are keyed by epoch since the
 * entry name can only represent second precision.
 */
export function mergeHistoryVersionLists(versionLists: HistoryVersion[][]): MergedVersions {
    const byEpoch = new Map<number, HistoryVersion>();
    let duplicateEpochs = 0;

    for (const versionList of versionLists) {
        for (const version of versionList) {
            if (byEpoch.has(version.epoch)) {
                duplicateEpochs++;
                continue;
            }
            byEpoch.set(version.epoch, version);
        }
    }

    const versions = Array.from(byEpoch.values());
    versions.sort((a, b) => a.epoch - b.epoch);
    return { versions: versions, duplicateEpochs: duplicateEpochs };
}

export interface MergedHistoryZip {
    zip: JSZip;
    fullEntryCount: number;
    // Versions whose contents match the next newer kept version, not stored
    skippedDuplicateContent: number;
}

/**
 * Encode merged versions as a history archive: the newest version in full and
 * the older ones as backwards diffs, which is the layout the plugin reads.
 */
export async function buildMergedHistoryZip(versions: HistoryVersion[], patchEngine: PatchEngine): Promise<MergedHistoryZip> {
    const zip = new JSZip();
    let fullEntryCount = 0;
    let skippedDuplicateContent = 0;
    let newerContent: string | null = null;

    // The encoding below walks from the newest to the oldest version, so
    // normalize the input instead of trusting the caller with the order and
    // with unique epochs (the entry name only has second precision)
    const orderedVersions: HistoryVersion[] = [];
    const seenEpochs = new Set<number>();
    for (const version of [...versions].sort((a, b) => a.epoch - b.epoch)) {
        if (seenEpochs.has(version.epoch)) {
            continue;
        }
        seenEpochs.add(version.epoch);
        orderedVersions.push(version);
    }

    for (let i = orderedVersions.length - 1; i >= 0; --i) {
        const version = orderedVersions[i];
        if ((newerContent != null) && (newerContent == version.content)) {
            skippedDuplicateContent++;
            continue;
        }

        // jszip stores dates in UTC but zip tools expect DOS local times
        // (same as the plugin does when storing an edit)
        const date = new Date(version.epoch - new Date(version.epoch).getTimezoneOffset() * 60000);
        if (newerContent == null) {
            zip.file(buildHistoryEntryName(version.epoch, false), version.content, { date: date, compression: "DEFLATE" });
            fullEntryCount++;
        } else {
            const patch = patchEngine.patch_toText(patchEngine.patch_make(newerContent, version.content));
            if (patch.length < version.content.length) {
                zip.file(buildHistoryEntryName(version.epoch, true), patch, { date: date, compression: "DEFLATE" });
            } else {
                // Don't bother storing a diff larger than the full contents
                zip.file(buildHistoryEntryName(version.epoch, false), version.content, { date: date, compression: "DEFLATE" });
                fullEntryCount++;
            }
        }

        newerContent = version.content;
    }

    return {
        zip: zip,
        fullEntryCount: fullEntryCount,
        skippedDuplicateContent: skippedDuplicateContent,
    };
}
