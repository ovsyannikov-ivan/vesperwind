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
    if requested.is_empty() || requested == super::COMPUTER_PATH {
        return Err(NativeError::new("EINVAL", "A path is required"));
    }

    let resolved = absolute_clean(Path::new(requested))?;
    if !filesystem.is_desktop() && !resolved.starts_with(filesystem.root()) {
        return Err(outside_root());
    }
    Ok(resolved)
}

pub fn verify_existing_inside_root(
    filesystem: &Filesystem,
    resolved: &Path,
) -> Result<PathBuf, NativeError> {
    if filesystem.is_desktop() {
        // Resolve each component so Finder aliases in ancestor directories work
        // just like ordinary symlinks, including targets outside the home folder.
        let mut physical = PathBuf::new();
        for component in resolved.components() {
            physical.push(component.as_os_str());
            physical = alias::resolve_finder_alias(&physical)?;
        }
        return fs::canonicalize(&physical)
            .map_err(|error| NativeError::from_io(&error, "The requested path is unavailable"));
    }
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

/// Resolve one entry of a directory that `verify_existing_inside_root` already
/// returned. Its ancestors are canonical, so only the entry itself (a symlink
/// or Finder Alias) is resolved, with the same root containment rule.
pub fn verify_child_inside_root(
    filesystem: &Filesystem,
    child: &Path,
) -> Result<PathBuf, NativeError> {
    let target = alias::resolve_finder_alias(child)?;
    let real = fs::canonicalize(&target)
        .map_err(|error| NativeError::from_io(&error, "The requested path is unavailable"))?;
    if !filesystem.is_desktop() && !real.starts_with(filesystem.real_root()) {
        return Err(outside_root());
    }
    Ok(real)
}

pub fn outside_root() -> NativeError {
    NativeError::new("EOUTSIDE_ROOT", "Path is outside the configured root")
}

/// Resolve ancestors, but never resolve the selected entry itself. Broken links
/// remain inspectable and their targets cannot escape the browser root.
pub fn resolve_metadata_path(
    filesystem: &Filesystem,
    requested: &str,
) -> Result<PathBuf, NativeError> {
    let logical = resolve_inside_root(filesystem, requested)?;
    if logical == filesystem.root() || logical.parent().is_none() {
        return Ok(logical);
    }
    let parent = verify_existing_inside_root(filesystem, logical.parent().unwrap())?;
    Ok(parent.join(
        logical
            .file_name()
            .ok_or_else(|| NativeError::new("EINVAL", "Invalid entry path"))?,
    ))
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
