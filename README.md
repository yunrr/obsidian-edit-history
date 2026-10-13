# Obsidian Edit History Plugin

This plugin saves each edit done to a note into a edit history file, the edits can later be diffed or copied.

![image](https://github.com/user-attachments/assets/e02be307-6945-46af-a8c0-02adbc48212d)

This is similar to the [File Recovery](https://help.obsidian.md/Plugins/File+recovery) core plugin with the following advantages:
- Can keep edit history of any type of file, selectable via settings
- Opensource edit history file format
- History files are kept independently per vault and file
- History files can be externally accessed, examined, copied around, or deleted
- History files can be backed up by external means
- Efficient compressed diff storage so it can be enabled without limits (number of edits, interval between edits max edit age...)
- Transparent storage size, easy to see how much the edit history for a given vault or note is taking

## Features

- Browse previous edits
- Choose edit by calendar view or by timeline view
- Diff one edit against a previous one
- Prev/Next button or keyboard diff navigation
- Timeline, side by side, top by bottom, or inline diff view
- Manually copy and paste a previous edit or parts of a previous edit
- Limit edit history frequency (set maximum interval of seconds between edits to save to the history file)
- Limit edit history file size by number of edits (keep less than a number of edits in the file, removing older ones)
- Limit edit history file size by age of edits (remove edits older than a given time from the history file)
- The edit history file is automatically managed when modifications are done to the note under Obsidian
  - renamed when the note is renamed (including folder changes).
  - deleted when the note is deleted
- Edit history files are kept separately per history profile; the file name suffix is selectable in settings, so using the same suffix on several devices keeps one shared edit history
- Manually merge old edit history files (legacy shared files and files of other devices or profiles) into the active profile history
- Edit history files can be safely deleted outside of Obsidian in order to free storage.
- Keep edit history files for all files or just for the extensions specified in the settings
- Don't keep edit history files for those filepaths containing the substrings specified in the settings


## Usage

- Modify the plugin settings as desired
- Edit notes as usual, edits will be saved in the Edit History File for that note, as specified in the settings
- An edit can be manually saved by invoking the command *Edit History: Save current edit in the Edit History*
- Click on the clock ribbon icon or invoke the command *Edit History: Open Edit History For This File*
  - A dialog box with an activity calendar and a drop down of the stored edits will pop up. The year of the calendar is given by the year of the currently selected drop down option
  - Navigate through the different edits by picking from the drop down or clicking on the calendar
  - Insertions are shown as green, deletions as red
  - Copy the current edit with the Copy button
  - Navigate through diffs in this edit via keyboard or the Previous/Next buttons
- Invoke the command *Edit History: Merge old edit history files into the active history file* (or use the corresponding settings button) after moving to a device or changing the active profile. Old history files can be kept, moved to the trash, or deleted permanently after the merge

## The edit history file

The plugin creates one edit history (.edtz) file per note, in the same folder as the note. The file name is the note path plus the suffix of the active history profile. For example, a note named `Notes/a.md` with the profile suffix `laptop` has a history file named `Notes/a.md.eh-laptop.edtz`.

History profiles are listed in the plugin settings, in a collapsible section whose title row selects the active profile and adds new ones. Profiles and the active profile are stored in the local plugin settings, they are not synchronized with the vault, so give the same suffix to every device that should share one edit history for the vault. Upgrading from an older version creates the default profile from the local device id, which keeps the history file names of the previous version unchanged.

Existing shared history files named `Notes/a.md.edtz` are copied to the active profile history the first time the note history is opened or updated. The old shared file is retained until it is no longer needed, and files of other profiles or devices are left alone. Use the merge command to combine all of them into the active profile history file, and to remove the old files.

### Format

The edit history file is a zip file with diffs using [diff-match-patch](https://github.com/google/diff-match-patch).

The most recent version of the note is always stored in full in the zip file, so the edit history file does not depend on the note.

This most recent version may not be the latest version of the note if a non-zero time between edits was set.

Each entry in the file is named after the UTC epoch in seconds at which time the edit was made, encoded as chars, and ending in "$" if the entry is stored in full, otherwise stored as a diff.

### Merging old history files

The merge command (and the corresponding settings button) scans the whole vault and merges, for every note, the versions of all its other history files (the legacy shared file and the files of other profiles or devices) into the active profile history file. Versions are combined by date and re-encoded, the note itself is not modified.

Entries are identified by their second-precision timestamp, so when two files store a version for the same second the version of the active profile history file is kept and the other file is reported and kept instead of being removed. Old files that can be removed are kept, moved to the trash, or deleted permanently, depending on the choice in the merge dialog. Removing them is only done after the merged history file has been written.

## Versions

[Github releases](https://github.com/antoniotejada/obsidian-edit-history/releases)

### [0.3.0](https://github.com/antoniotejada/obsidian-edit-history/releases/tag/0.3.0) (2025-08-03)
- Implemented #6 note path substring blacklist
- Fixed #28 empty edit history files being when minMsBetweenEdits is infinity (manual saving)

### [0.2.2](https://github.com/antoniotejada/obsidian-edit-history/releases/tag/0.2.2) (2025-03-25)
- Shades bugfix for timeline
- Added timeline progress report

### [0.2.1](https://github.com/antoniotejada/obsidian-edit-history/releases/tag/0.2.1) (2025-03-09)
- Performance bugfix for timeline diff view
- Calendar expand/collapse and other tweaks for small displays (mobile)

### [0.2.0](https://github.com/antoniotejada/obsidian-edit-history/releases/tag/0.2.0) (2025-02-25)
- Implemented #8 https://github.com/antoniotejada/obsidian-edit-history/issues/8
  - Added side by side, top by bottom, inline, and timeline diff view and settings
- Other assorted enhancements to diff view:
  - Added calendar view
  - Added previous/next diff navigation
  - Added whitespace display in diff view and settings
  - Made diff view larger and lines breakable
  - Added display of current diff index
  - Choose edit date by timeline/slider/calendar view
  - Added keyboard navigation

### [0.1.3](https://github.com/antoniotejada/obsidian-edit-history/releases/tag/0.1.3) (2023-08-11)
- Added versions section to README.md

### [0.1.2](https://github.com/antoniotejada/obsidian-edit-history/releases/tag/0.1.2) (2023-08-11)
- Fix for #4 https://github.com/antoniotejada/obsidian-edit-history/issues/4

### [0.1.1](https://github.com/antoniotejada/obsidian-edit-history/releases/tag/0.1.1) (2023-06-23)
- Changes to comply with plugin submission guidelines

### [0.1.0](https://github.com/antoniotejada/obsidian-edit-history/releases/tag/0.1.2) (2023-06-17)
- First fully functional version

## TODO
- Allow specifying the edit history root folder?
- Restore a given edit
- Diff one edit against another arbitrary edit
- Abstract out/refactor access to the edit history file
- Edit History File management:
  - find orphaned files
  - per file/vault statistics
  - merge/remove edits
  - ...
