use super::{alias, Filesystem};
use crate::error::NativeError;
use path_clean::PathClean;
use std::{
    env, fs,
    path::{Path, PathBuf},
};

pub fn absolute_clean(path: &Path) -> Result<PathBuf, NativeError> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        env::current_dir()
            .map_err(|error| {
                NativeError::from_io(&error, "Unable to resolve the current directory")
            })?
            .join(path)
    };
    Ok(absolute.clean())
}

pub fn resolve_inside_root(
    filesystem: &Filesystem,
    requested: &str,
) -> Result<PathBuf, NativeError> {
    if requested.is_empty() {
        return Err(NativeError::new("EINVAL", "A path is required"));
    }

    let resolved = absolute_clean(Path::new(requested))?;
    if !resolved.starts_with(filesystem.root()) {
        return Err(outside_root());
    }
    Ok(resolved)
}

pub fn verify_existing_inside_root(
    filesystem: &Filesystem,
    resolved: &Path,
) -> Result<PathBuf, NativeError> {
    let relative = resolved
        .strip_prefix(filesystem.root())
        .or_else(|_| resolved.strip_prefix(filesystem.real_root()))
        .map_err(|_| outside_root())?;
    let mut physical = filesystem.real_root().to_path_buf();

    for component in relative.components() {
        physical.push(component.as_os_str());
        physical = alias::resolve_finder_alias(&physical)?;
        let real = fs::canonicalize(&physical)
            .map_err(|error| NativeError::from_io(&error, "The requested path is unavailable"))?;
        if !real.starts_with(filesystem.real_root()) {
            return Err(outside_root());
        }
        physical = real;
    }

    Ok(physical)
}

pub fn outside_root() -> NativeError {
    NativeError::new("EOUTSIDE_ROOT", "Path is outside the configured root")
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::{resolve_inside_root, verify_existing_inside_root};
    use crate::filesystem::Filesystem;
    use std::path::PathBuf;
    use uuid::Uuid;

    fn create_finder_alias(target: &std::path::Path, alias: &std::path::Path) {
        use objc2_foundation::{
            NSString, NSURLBookmarkCreationOptions, NSURLBookmarkFileCreationOptions, NSURL,
        };
        let file_url = |path: &std::path::Path| {
            NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()))
        };
        let data = file_url(target)
            .bookmarkDataWithOptions_includingResourceValuesForKeys_relativeToURL_error(
                NSURLBookmarkCreationOptions::SuitableForBookmarkFile,
                None,
                None,
            )
            .unwrap();
        NSURL::writeBookmarkData_toURL_options_error(
            &data,
            &file_url(alias),
            NSURLBookmarkFileCreationOptions::default(),
        )
        .unwrap();
    }

    #[test]
    fn finder_alias_target_cannot_escape_local_provider_root() {
        let fixture =
            std::env::temp_dir().join(format!("vesperwind-alias-security-{}", Uuid::new_v4()));
        let root = fixture.join("root");
        let outside = fixture.join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let target = outside.join("secret.txt");
        let alias = root.join("Outside alias.txt");
        std::fs::write(&target, b"secret").unwrap();
        create_finder_alias(&target, &alias);
        let filesystem = Filesystem::from_root(&root, root.clone()).unwrap();
        let logical = resolve_inside_root(&filesystem, &alias.to_string_lossy()).unwrap();

        assert_eq!(
            verify_existing_inside_root(&filesystem, &logical)
                .unwrap_err()
                .code,
            "EOUTSIDE_ROOT"
        );
        let _ = std::fs::remove_dir_all(fixture);
    }

    #[test]
    fn local_provider_resolves_configured_finder_alias_inside_root() {
        let Some(path) = std::env::var_os("VESPERWIND_FINDER_ALIAS_TEST_PATH") else {
            return;
        };
        let alias = PathBuf::from(path);
        let root = dirs::home_dir().unwrap();
        let filesystem = Filesystem::from_root(&root, root.clone()).unwrap();
        let logical = resolve_inside_root(&filesystem, &alias.to_string_lossy()).unwrap();
        let target = verify_existing_inside_root(&filesystem, &logical).unwrap();

        assert_eq!(logical, alias);
        assert_ne!(target, logical);
        assert!(target.starts_with(filesystem.real_root()));
    }
}
