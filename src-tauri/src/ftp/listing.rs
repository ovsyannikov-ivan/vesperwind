//! FTP directory entries from `MLSD`/`MLST` facts or, as a fallback, `LIST`
//! output in the common Unix and DOS formats. Only what the server reports is
//! kept: a missing size or time stays unknown, and permission facts are never
//! read as POSIX modes.
use std::time::UNIX_EPOCH;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryKind {
    File,
    Directory,
    /// A link whose target type the server does not report. Recursive
    /// operations never follow it.
    Symlink,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FtpEntry {
    pub name: String,
    pub kind: EntryKind,
    pub size: Option<u64>,
    /// Unix seconds, UTC.
    pub modified: Option<i64>,
}

/// Parses `YYYYMMDDHHMMSS[.sss]` (RFC 3659 time-val, UTC).
pub fn parse_time_val(value: &str) -> Option<i64> {
    let digits = value.split('.').next()?;
    if digits.len() != 14 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    chrono::NaiveDateTime::parse_from_str(digits, "%Y%m%d%H%M%S")
        .ok()
        .map(|time| time.and_utc().timestamp())
}

/// A directory listing. Entries whose names are not a single safe path
/// component (see `remote_ops::validate_entry_name`) are left out and counted;
/// recursive operations refuse an incomplete listing.
#[derive(Debug, Default)]
pub struct Listing {
    pub entries: Vec<FtpEntry>,
    pub rejected: usize,
}

pub fn parse_listing(lines: &[String], mlsd: bool) -> Listing {
    let mut listing = Listing::default();
    for line in lines {
        let entry = if mlsd {
            mlsx_entry(line)
        } else {
            list_entry(line)
        };
        match entry {
            Some(entry) if is_safe_name(&entry.name) => listing.entries.push(entry),
            Some(_) => listing.rejected += 1,
            None => {}
        }
    }
    listing
}

fn is_safe_name(name: &str) -> bool {
    crate::filesystem::remote_ops::validate_entry_name(name).is_ok()
}

/// One `MLSD` line with a safe entry name.
#[cfg(test)]
pub fn parse_mlsx(line: &str) -> Option<FtpEntry> {
    mlsx_entry(line).filter(|entry| is_safe_name(&entry.name))
}

/// The facts of an `MLST` reply, whose name is a full path; the caller
/// replaces it with the requested path's last component.
pub fn parse_mlst_fact(line: &str) -> Option<FtpEntry> {
    mlsx_entry(line)
}

/// `fact=value;fact=value; name`, with the name exactly as the server sent
/// it. Current and parent directory entries are skipped.
fn mlsx_entry(line: &str) -> Option<FtpEntry> {
    let line = line.trim_start_matches(' ').trim_end_matches(['\r', '\n']);
    let (facts, name) = line.split_once(' ')?;
    if name.is_empty() {
        return None;
    }
    let mut kind = EntryKind::Unknown;
    let (mut size, mut modified) = (None, None);
    for fact in facts.split(';').filter(|fact| !fact.is_empty()) {
        let (key, value) = fact.split_once('=')?;
        match key.to_ascii_lowercase().as_str() {
            "type" => {
                let value = value.to_ascii_lowercase();
                kind = match value.as_str() {
                    "file" => EntryKind::File,
                    "dir" | "cdir" | "pdir" => EntryKind::Directory,
                    _ if value.starts_with("os.unix=slink")
                        || value.starts_with("os.unix=symlink") =>
                    {
                        EntryKind::Symlink
                    }
                    _ => EntryKind::Unknown,
                };
                if value == "cdir" || value == "pdir" {
                    return None;
                }
            }
            "size" => size = value.parse().ok(),
            "modify" => modified = parse_time_val(value),
            _ => {}
        }
    }
    if name == "." || name == ".." {
        return None;
    }
    Some(FtpEntry {
        name: name.to_string(),
        size: if kind == EntryKind::Directory {
            None
        } else {
            size
        },
        kind,
        modified,
    })
}

/// One `LIST` line with a safe entry name.
#[cfg(test)]
pub fn parse_list(line: &str) -> Option<FtpEntry> {
    list_entry(line).filter(|entry| is_safe_name(&entry.name))
}

/// One `LIST` line in Unix (`ls -l`) or DOS/IIS format, name as sent.
fn list_entry(line: &str) -> Option<FtpEntry> {
    let line = line.trim_end_matches(['\r', '\n']);
    if line.is_empty() || line.starts_with("total ") {
        return None;
    }
    let file = suppaftp::list::ListParser::parse_posix(line)
        .or_else(|_| suppaftp::list::ListParser::parse_dos(line))
        .ok()?;
    let name = file.name().to_string();
    if name.is_empty() || name == "." || name == ".." {
        return None;
    }
    let kind = if file.is_symlink() {
        EntryKind::Symlink
    } else if file.is_directory() {
        EntryKind::Directory
    } else if file.is_file() {
        EntryKind::File
    } else {
        EntryKind::Unknown
    };
    Some(FtpEntry {
        name,
        size: (kind == EntryKind::File).then_some(file.size() as u64),
        modified: file
            .modified()
            .duration_since(UNIX_EPOCH)
            .ok()
            .map(|duration| duration.as_secs() as i64),
        kind,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mlsd_facts_keep_unknown_metadata_unknown() {
        assert_eq!(
            parse_mlsx("type=file;size=12;modify=20260102030405;perm=adfrw; Отчёт 2026.txt"),
            Some(FtpEntry {
                name: "Отчёт 2026.txt".into(),
                kind: EntryKind::File,
                size: Some(12),
                modified: Some(1_767_323_045),
            })
        );
        let dir = parse_mlsx("Type=Dir;Modify=20260102030405.123; folder with spaces").unwrap();
        assert_eq!((dir.kind, dir.size), (EntryKind::Directory, None));
        let bare = parse_mlsx("type=file; no-size").unwrap();
        assert_eq!((bare.size, bare.modified), (None, None));
        assert_eq!(
            parse_mlsx("type=OS.unix=slink:/target;modify=20260102030405; link")
                .unwrap()
                .kind,
            EntryKind::Symlink
        );
        assert_eq!(
            parse_mlsx("type=OS.unix=chr-1/3; device").unwrap().kind,
            EntryKind::Unknown
        );
        assert!(parse_mlsx("type=cdir; .").is_none());
        assert!(parse_mlsx("type=pdir; ..").is_none());
        // An MLST fact carries a full path; the caller names the entry.
        assert_eq!(
            parse_mlst_fact(" type=file;size=1; /srv/a/b.txt")
                .unwrap()
                .name,
            "/srv/a/b.txt"
        );
        assert!(parse_mlsx("garbage").is_none());
    }

    #[test]
    fn list_fallback_reads_unix_and_dos_lines() {
        let file = parse_list(
            "-rw-r--r--    1 owner    group          42 Jan 02 15:04 файл с пробелом.txt",
        )
        .unwrap();
        assert_eq!(file.name, "файл с пробелом.txt");
        assert_eq!((file.kind, file.size), (EntryKind::File, Some(42)));
        let link =
            parse_list("lrwxrwxrwx    1 owner    group           6 Jan 02 15:04 link -> target")
                .unwrap();
        assert_eq!(
            (link.name.as_str(), link.kind),
            ("link", EntryKind::Symlink)
        );
        let dir = parse_list("01-02-26  03:04PM       <DIR>          Папка").unwrap();
        assert_eq!(
            (dir.name.as_str(), dir.kind, dir.size),
            ("Папка", EntryKind::Directory, None)
        );
        let dos = parse_list("01-02-26  03:04PM                 1234 report.pdf").unwrap();
        assert_eq!((dos.kind, dos.size), (EntryKind::File, Some(1234)));
        assert!(parse_list("total 12").is_none());
        assert!(parse_list("not a listing line").is_none());
    }

    #[test]
    fn time_vals_are_strict() {
        assert_eq!(parse_time_val("19700101000001"), Some(1));
        assert!(parse_time_val("2026").is_none());
        assert!(parse_time_val("2026010203040x").is_none());
    }

    #[test]
    fn unsafe_names_are_rejected_and_counted_but_unicode_and_spaces_stay() {
        let lines: Vec<String> = [
            "-rw-r--r--    1 o g 5 Jan 02 15:04 ../outside.txt",
            "-rw-r--r--    1 o g 5 Jan 02 15:04 ..\\..\\outside.txt",
            "-rw-r--r--    1 o g 5 Jan 02 15:04 /etc/passwd",
            "-rw-r--r--    1 o g 5 Jan 02 15:04 a/b",
            "-rw-r--r--    1 o g 5 Jan 02 15:04 C:\\Windows\\win.ini",
            "-rw-r--r--    1 o g 5 Jan 02 15:04 bell\u{7}",
            "drwxr-xr-x    1 o g 0 Jan 02 15:04 ..",
            "drwxr-xr-x    1 o g 0 Jan 02 15:04 .",
            "-rw-r--r--    1 o g 5 Jan 02 15:04 пробелы и 漢字 .txt",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let listing = parse_listing(&lines, false);
        assert_eq!(listing.rejected, 6);
        assert_eq!(listing.entries.len(), 1);
        assert_eq!(listing.entries[0].name, "пробелы и 漢字 .txt");
        let facts: Vec<String> = [
            "type=file;size=1; ../escape",
            "type=dir; sub/dir",
            "type=file;size=1; ..\\escape",
            "type=file;size=1; ..",
            "type=file;size=1;  ведущий пробел.txt",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let listing = parse_listing(&facts, true);
        assert_eq!((listing.entries.len(), listing.rejected), (1, 3));
        // MLSD keeps a leading space exactly (LIST parsing cannot).
        assert_eq!(listing.entries[0].name, " ведущий пробел.txt");
        assert!(parse_mlsx("type=file; ../escape").is_none());
        assert!(parse_list("-rw-r--r-- 1 o g 5 Jan 02 15:04 ../x").is_none());
    }
}
