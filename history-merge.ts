// Edit history file format helpers and history merge logic.
//
// This module deliberately has no Obsidian imports so the format and merge
// logic can be exercised directly (see the Node harness under .context/).
//
// Format recap (see README "The edit history file"):
//  - One zip entry per stored version
//  - The entry name is the UTC epoch in seconds (base-36), suffixed with "$"
//    when the version is stored in full
//  - A second holding more than one version numbers the extra ones after "~"
//    (eg "1f2a3b~1$"), since the name only carries second precision. The first
//    version of a second keeps the plain name, so a history file without
//    collisions keeps the names older plugin versions understand
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
// versions stored in full and an optional "~<n>" for the n-th extra version of
// that second. Validating them avoids reading an unrelated zip file that
// happens to be named like a history file
const HISTORY_ENTRY_NAME = /^[0-9a-z]+(~[1-9][0-9]*)?\$?$/;

// The same second sequence marker, only used to tell the extra versions of a
// second apart. "~" is not part of the base-36 alphabet, so an entry name
// without it always means the first version of that second
const HISTORY_SEQUENCE_MARKER = "~";

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
    // 0 for the first version stored for that second, n for the n-th extra
    // version of the same second (higher is newer)
    sequence: number;
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

/**
 * Split an entry name into its base-36 epoch part and its same-second sequence
 */
function parseHistoryEntryName(entryName: string): { epochPart: string; sequence: number } {
    const markerIndex = entryName.indexOf(HISTORY_SEQUENCE_MARKER);
    if (markerIndex < 0) {
        return { epochPart: entryName, sequence: 0 };
    }

    return {
        epochPart: entryName.substring(0, markerIndex),
        sequence: parseInt(entryName.substring(markerIndex + HISTORY_SEQUENCE_MARKER.length), 10),
    };
}

export function historyEntryEpoch(entryName: string): number {
    return parseInt(parseHistoryEntryName(entryName).epochPart, 36) * 1000;
}

/**
 * @return 0 for the first version stored for that second, n for the n-th extra
 *         version of that second
 */
export function historyEntrySequence(entryName: string): number {
    return parseHistoryEntryName(entryName).sequence;
}

export function historyEntryIsDiff(entryName: string): boolean {
    return !entryName.endsWith("$");
}

export function buildHistoryEntryName(mtime: number, isDiff: boolean, sequence = 0): string {
    const utcepoch = Math.floor(mtime / 1000);
    const sequenceSuffix = (sequence > 0) ? HISTORY_SEQUENCE_MARKER + sequence : "";
    return utcepoch.toString(36) + sequenceSuffix + (isDiff ? "" : "$");
}

/**
 * Name to store a new version of a second that may already hold versions: the
 * plain name when it is free, otherwise the next free same-second sequence.
 * Both the diff and the full form of a sequence count as taken, so a version is
 * never split into two entries of the same second and sequence.
 * The loop ends because every iteration builds a name not built before
 */
export function allocateHistoryEntryName(mtime: number, isDiff: boolean, usedEntryNames: Set<string>): string {
    for (let sequence = 0; ; sequence++) {
        const name = buildHistoryEntryName(mtime, isDiff, sequence);
        const otherName = buildHistoryEntryName(mtime, !isDiff, sequence);
        if (!usedEntryNames.has(name) && !usedEntryNames.has(otherName)) {
            return name;
        }
    }
}

/**
 * Sort in place, most recent first. Versions of the same second are ordered by
 * their sequence, the extra ones being newer
 */
function sortHistoryEntriesDescending(entryNames: string[]): void {
    entryNames.sort((a, b) =>
        (historyEntryEpoch(b) - historyEntryEpoch(a)) ||
        (historyEntrySequence(b) - historyEntrySequence(a)));
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
        versions.push({
            epoch: historyEntryEpoch(entryName),
            sequence: historyEntrySequence(entryName),
            content: versionContent,
        });
    }

    return { versions: versions, error: null };
}

export interface MergedVersions {
    // Ascending by epoch, then by sequence within a second
    versions: HistoryVersion[];
    // Number of versions dropped because the same second already held a version
    // with the same contents. Versions of the same second with different
    // contents are all kept, numbered by their sequence
    duplicateVersions: number;
}

/**
 * Merge version lists, earlier lists win. A second can hold several versions,
 * since the entry name only represents second precision: the versions of a
 * second are collected oldest first, the ones of the first list keeping their
 * order and the following lists appending the contents they do not have yet
 */
export function mergeHistoryVersionLists(versionLists: HistoryVersion[][]): MergedVersions {
    // Epoch -> contents of that second, oldest first
    const contentsByEpoch = new Map<number, string[]>();
    let duplicateVersions = 0;

    for (const versionList of versionLists) {
        const versionsByEpoch = new Map<number, HistoryVersion[]>();
        for (const version of versionList) {
            const versions = versionsByEpoch.get(version.epoch);
            if (versions == null) {
                versionsByEpoch.set(version.epoch, [version]);
            } else {
                versions.push(version);
            }
        }

        for (const [epoch, versions] of versionsByEpoch) {
            versions.sort((a, b) => (a.sequence || 0) - (b.sequence || 0));

            let contents = contentsByEpoch.get(epoch);
            if (contents == null) {
                contents = [];
                contentsByEpoch.set(epoch, contents);
            }

            for (const version of versions) {
                if (contents.includes(version.content)) {
                    duplicateVersions++;
                    continue;
                }
                contents.push(version.content);
            }
        }
    }

    const versions: HistoryVersion[] = [];
    for (const [epoch, contents] of contentsByEpoch) {
        for (const [sequence, content] of contents.entries()) {
            versions.push({ epoch: epoch, sequence: sequence, content: content });
        }
    }
    versions.sort((a, b) => (a.epoch - b.epoch) || (a.sequence - b.sequence));

    return { versions: versions, duplicateVersions: duplicateVersions };
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
    // normalize the input instead of trusting the caller with the order, with
    // unique epochs (the entry name only has second precision) or with unique
    // sequences: the versions of a second are renumbered in order, dropping the
    // ones whose contents the second already holds
    const orderedVersions: HistoryVersion[] = [];
    const contentsByEpoch = new Map<number, string[]>();
    for (const version of [...versions].sort((a, b) =>
        (a.epoch - b.epoch) || ((a.sequence || 0) - (b.sequence || 0)))) {
        let contents = contentsByEpoch.get(version.epoch);
        if (contents == null) {
            contents = [];
            contentsByEpoch.set(version.epoch, contents);
        }
        if (contents.includes(version.content)) {
            continue;
        }

        contents.push(version.content);
        orderedVersions.push({
            epoch: version.epoch,
            sequence: contents.length - 1,
            content: version.content,
        });
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
            zip.file(buildHistoryEntryName(version.epoch, false, version.sequence), version.content, { date: date, compression: "DEFLATE" });
            fullEntryCount++;
        } else {
            const patch = patchEngine.patch_toText(patchEngine.patch_make(newerContent, version.content));
            if (patch.length < version.content.length) {
                zip.file(buildHistoryEntryName(version.epoch, true, version.sequence), patch, { date: date, compression: "DEFLATE" });
            } else {
                // Don't bother storing a diff larger than the full contents
                zip.file(buildHistoryEntryName(version.epoch, false, version.sequence), version.content, { date: date, compression: "DEFLATE" });
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
