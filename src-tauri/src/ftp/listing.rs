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

/// One `MLSD` line or `MLST` fact line: `fact=value;fact=value; name`.
pub fn parse_mlsx(line: &str) -> Option<FtpEntry> {
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
    // A path in an MLST reply keeps only its last component.
    let name = name.trim_end_matches('/');
    let name = name.rsplit('/').next().unwrap_or(name);
    if name.is_empty() || name == "." || name == ".." {
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

/// One `LIST` line in Unix (`ls -l`) or DOS/IIS format.
pub fn parse_list(line: &str) -> Option<FtpEntry> {
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
        assert_eq!(
            parse_mlsx(" type=file;size=1; /srv/a/b.txt").unwrap().name,
            "b.txt"
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
}
