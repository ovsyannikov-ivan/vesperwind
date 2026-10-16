use flate2::bufread::GzDecoder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
pub const MAGIC: &[u8] = b"VESPERWIND-P1\n";

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entry {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub schema: u32,
    pub version: String,
    pub files: Vec<Entry>,
}
pub struct Package<'a> {
    pub id: String,
    pub manifest: Manifest,
    compressed: &'a [u8],
}

pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn safe_path(path: &str) -> Result<PathBuf> {
    if path.is_empty() || path.len() > 220 || !path.is_ascii() {
        return Err("Invalid package path".into());
    }
    for part in path.split('/') {
        let stem = part.split('.').next().unwrap().to_ascii_uppercase();
        let reserved = [
            "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
            "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
        ];
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.ends_with([' ', '.'])
            || part.bytes().any(|b| b < 32 || b"\\:*?\"<>|".contains(&b))
            || reserved.contains(&stem.as_str())
        {
            return Err(format!("Unsafe package path: {path}").into());
        }
    }
    Ok(PathBuf::from(path))
}

pub fn check_regular(path: &Path, directory: bool) -> Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("Reparse points are forbidden in the runtime cache".into());
        }
    }
    if metadata.file_type().is_symlink()
        || (if directory {
            !metadata.is_dir()
        } else {
            !metadata.is_file()
        })
    {
        return Err(format!("Unexpected file type: {}", path.display()).into());
    }
    Ok(())
}

pub fn list_files(root: &Path) -> Result<BTreeSet<PathBuf>> {
    fn visit(root: &Path, dir: &Path, paths: &mut BTreeSet<PathBuf>) -> Result<()> {
        check_regular(dir, true)?;
        for child in fs::read_dir(dir)? {
            let path = child?.path();
            if fs::symlink_metadata(&path)?.is_dir() {
                visit(root, &path, paths)?;
            } else {
                check_regular(&path, false)?;
                paths.insert(path.strip_prefix(root)?.to_owned());
            }
        }
        Ok(())
    }
    let mut paths = BTreeSet::new();
    visit(root, root, &mut paths)?;
    Ok(paths)
}

pub fn hash_reader(reader: &mut impl Read, output: &mut impl Write) -> Result<(u64, String)> {
    let mut hasher = Sha256::new();
    let mut buffer = vec![0; 1024 * 1024];
    let mut count = 0;
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        output.write_all(&buffer[..read])?;
        hasher.update(&buffer[..read]);
        count += read as u64;
    }
    Ok((count, format!("{:x}", hasher.finalize())))
}

impl<'a> Package<'a> {
    pub fn open(bytes: &'a [u8], expected: &str) -> Result<Self> {
        let id = digest(bytes);
        if !valid_hash(expected) || id != expected {
            return Err("Embedded package checksum mismatch".into());
        }
        let start = MAGIC.len();
        if bytes.get(..start) != Some(MAGIC) {
            return Err("Unsupported portable package".into());
        }
        let length = u32::from_le_bytes(
            bytes
                .get(start..start + 4)
                .ok_or("Truncated package")?
                .try_into()?,
        ) as usize;
        if length == 0 || length > 8 * 1024 * 1024 {
            return Err("Invalid manifest size".into());
        }
        let end = start + 4 + length;
        let manifest: Manifest =
            serde_json::from_slice(bytes.get(start + 4..end).ok_or("Truncated manifest")?)?;
        if manifest.schema != 1 || manifest.files.is_empty() || manifest.files.len() > 50_000 {
            return Err("Invalid package manifest".into());
        }
        let mut names = BTreeSet::new();
        let mut total = 0u64;
        for file in &manifest.files {
            safe_path(&file.path)?;
            if !valid_hash(&file.sha256) || !names.insert(file.path.to_ascii_lowercase()) {
                return Err("Invalid checksum or duplicate package path".into());
            }
            total = total
                .checked_add(file.bytes)
                .ok_or("Package size overflow")?;
            if total > 8 * 1024 * 1024 * 1024 {
                return Err("Package exceeds extraction limit".into());
            }
        }
        for name in &names {
            for (index, _) in name.match_indices('/') {
                if names.contains(&name[..index]) {
                    return Err("File/directory collision in package".into());
                }
            }
        }
        Ok(Self {
            id,
            manifest,
            compressed: &bytes[end..],
        })
    }

    pub fn verify(&self, root: &Path) -> Result<()> {
        let expected = self
            .manifest
            .files
            .iter()
            .map(|e| safe_path(&e.path))
            .collect::<Result<BTreeSet<_>>>()?;
        if list_files(root)? != expected {
            return Err("Runtime cache has missing or unexpected files".into());
        }
        for entry in &self.manifest.files {
            let path = root.join(safe_path(&entry.path)?);
            if fs::metadata(&path)?.len() != entry.bytes {
                return Err(format!("Size mismatch: {}", entry.path).into());
            }
            let (size, hash) = hash_reader(&mut fs::File::open(path)?, &mut io::sink())?;
            if size != entry.bytes || hash != entry.sha256 {
                return Err(format!("Checksum mismatch: {}", entry.path).into());
            }
        }
        Ok(())
    }

    /// The destination must be newly created; no existing links or files are followed.
    pub fn extract(&self, root: &Path) -> Result<()> {
        fs::create_dir(root)?;
        let mut decoder = GzDecoder::new(self.compressed);
        for entry in &self.manifest.files {
            let path = root.join(safe_path(&entry.path)?);
            fs::create_dir_all(path.parent().ok_or("Missing parent")?)?;
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)?;
            let (size, hash) = hash_reader(&mut (&mut decoder).take(entry.bytes), &mut file)?;
            if size != entry.bytes || hash != entry.sha256 {
                return Err(format!("Corrupt embedded file: {}", entry.path).into());
            }
            file.sync_all()?;
        }
        let mut byte = [0];
        if decoder.read(&mut byte)? != 0 {
            return Err("Unexpected decompressed payload".into());
        }
        // Finish and validate the gzip trailer, and reject concatenated/trailing data.
        if !decoder.into_inner().is_empty() {
            return Err("Unexpected trailing compressed payload".into());
        }
        self.verify(root)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use flate2::{write::GzEncoder, Compression};
    use std::sync::atomic::{AtomicUsize, Ordering};
    static COUNTER: AtomicUsize = AtomicUsize::new(0);
    pub fn fixture(entries: Vec<(&str, &[u8])>) -> Vec<u8> {
        let manifest = Manifest {
            schema: 1,
            version: "test".into(),
            files: entries
                .iter()
                .map(|(path, bytes)| Entry {
                    path: path.to_string(),
                    bytes: bytes.len() as u64,
                    sha256: digest(bytes),
                })
                .collect(),
        };
        let json = serde_json::to_vec(&manifest).unwrap();
        let mut bytes = MAGIC.to_vec();
        bytes.extend((json.len() as u32).to_le_bytes());
        bytes.extend(json);
        let mut zip = GzEncoder::new(Vec::new(), Compression::fast());
        for (_, content) in entries {
            zip.write_all(content).unwrap();
        }
        bytes.extend(zip.finish().unwrap());
        bytes
    }
    fn root() -> PathBuf {
        std::env::temp_dir().join(format!(
            "vesper-package-test-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ))
    }
    #[test]
    fn unsafe_windows_paths_are_rejected() {
        for path in [
            "", "../x", "a/../b", "/root", "C:/x", "a\\b", "a:b", "NUL.txt", "COM1", "a/", "a//b",
            "a.", "a ", "a/*", "a/\n",
        ] {
            assert!(safe_path(path).is_err(), "{path}");
        }
        assert!(safe_path("vendor/libmpv/windows/mpv-2.dll").is_ok());
    }
    #[test]
    fn round_trip_detects_corruption_missing_and_extra_files() {
        let bytes = fixture(vec![("app.exe", b"exe"), ("vendor/d.dll", b"dll")]);
        let package = Package::open(&bytes, &digest(&bytes)).unwrap();
        let root = root();
        package.extract(&root).unwrap();
        package.verify(&root).unwrap();
        fs::write(root.join("app.exe"), b"bad").unwrap();
        assert!(package.verify(&root).is_err());
        fs::write(root.join("app.exe"), b"exe").unwrap();
        fs::write(root.join("extra.dll"), []).unwrap();
        assert!(package.verify(&root).is_err());
        fs::remove_file(root.join("extra.dll")).unwrap();
        fs::remove_file(root.join("vendor/d.dll")).unwrap();
        assert!(package.verify(&root).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn duplicate_case_paths_and_parent_collisions_are_rejected() {
        for entries in [
            vec![("A", &b"1"[..]), ("a", &b"2"[..])],
            vec![("a", &b"1"[..]), ("a/b", &b"2"[..])],
        ] {
            let bytes = fixture(entries);
            assert!(Package::open(&bytes, &digest(&bytes)).is_err());
        }
    }
    #[test]
    fn truncated_packages_bad_hash_and_gzip_fail_closed() {
        let bytes = fixture(vec![("app", b"data")]);
        assert!(Package::open(&bytes, &"0".repeat(64)).is_err());
        for cut in [0, 5, MAGIC.len() + 2, bytes.len() - 5] {
            let truncated = &bytes[..cut];
            if let Ok(package) = Package::open(truncated, &digest(truncated)) {
                let root = root();
                assert!(package.extract(&root).is_err());
                fs::remove_dir_all(root).unwrap();
            }
        }
    }
    #[test]
    fn existing_destination_is_never_overwritten() {
        let bytes = fixture(vec![("app", b"data")]);
        let root = root();
        fs::create_dir(&root).unwrap();
        assert!(Package::open(&bytes, &digest(&bytes))
            .unwrap()
            .extract(&root)
            .is_err());
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn appended_payload_is_rejected_even_with_a_matching_outer_checksum() {
        let mut bytes = fixture(vec![("app", b"data")]);
        bytes.extend(b"trailing");
        let package = Package::open(&bytes, &digest(&bytes)).unwrap();
        let root = root();
        assert!(package.extract(&root).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
