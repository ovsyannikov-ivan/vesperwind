//! Mount and eject local disk images with the operating system's own tools.
//!
//! The frontend only offers the commands; this module re-validates platform,
//! provider, path and file type. Platform output is parsed from structured
//! plist/JSON representations, never from localized human-readable text.
use crate::error::NativeError;
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImagePlatform {
    MacOs,
    Windows,
    Unsupported,
}

impl ImagePlatform {
    pub const fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::MacOs
        } else if cfg!(target_os = "windows") {
            Self::Windows
        } else {
            Self::Unsupported
        }
    }

    pub fn extensions(self) -> &'static [&'static str] {
        match self {
            Self::MacOs => &["dmg", "iso"],
            // Mount-DiskImage also accepts VHD(X), which is out of scope here.
            Self::Windows => &["iso"],
            Self::Unsupported => &[],
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MountedVolume {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
    pub mount_point: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskImageStatus {
    pub image_path: String,
    pub attached: bool,
    /// Whole-disk device (`/dev/disk4`) or Windows device path.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
    pub volumes: Vec<MountedVolume>,
    /// Set by mount when the image was attached before the request.
    pub already_mounted: bool,
}

fn unsupported_platform() -> NativeError {
    NativeError::new(
        "ENOTSUPPORTED",
        "Disk image mounting is not available on this platform",
    )
}

/// Validate a mount request entirely on the backend.
pub fn validate_image(
    platform: ImagePlatform,
    provider_id: Option<&str>,
    path: &str,
) -> Result<PathBuf, NativeError> {
    if platform == ImagePlatform::Unsupported {
        return Err(unsupported_platform());
    }
    if provider_id.unwrap_or("local") != "local" {
        // Mounting a remote image would require downloading it first. That is
        // never done implicitly.
        return Err(NativeError::new(
            "ENOTSUPPORTED",
            "Only disk images on this computer can be mounted. Copy the image to a local folder first.",
        ));
    }
    if path.is_empty() || path.contains('\0') {
        return Err(NativeError::new("EINVAL", "A disk image path is required"));
    }
    let requested = Path::new(path);
    if !requested.is_absolute() {
        return Err(
            NativeError::new("EINVAL", "The disk image path must be absolute").with_path(path),
        );
    }
    let extension = requested
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if !platform.extensions().contains(&extension.as_str()) {
        return Err(NativeError::new(
            "EUNSUPPORTED_IMAGE",
            format!(
                "This file type cannot be mounted on this system. Supported: {}",
                platform
                    .extensions()
                    .iter()
                    .map(|value| format!(".{value}"))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        )
        .with_path(path));
    }
    // Resolve links: the OS mounts the real file, and status is matched on it.
    let real = std::fs::canonicalize(requested).map_err(|error| {
        NativeError::from_io(&error, "The disk image is unavailable").with_path(path)
    })?;
    let metadata = std::fs::metadata(&real).map_err(|error| {
        NativeError::from_io(&error, "The disk image is unavailable").with_path(path)
    })?;
    if !metadata.is_file() {
        return Err(NativeError::new("EISDIR", "The disk image must be a file").with_path(path));
    }
    Ok(strip_verbatim(real))
}

/// `canonicalize` returns `\\?\C:\...` on Windows; Storage cmdlets and users
/// expect the ordinary spelling.
fn strip_verbatim(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{unc}"))
    } else if let Some(local) = text.strip_prefix(r"\\?\") {
        PathBuf::from(local)
    } else {
        path
    }
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MacOsVersion {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
/// Parse `sw_vers -productVersion` output (`27.0.1`, `14.6`, `11`).
pub fn parse_macos_version(value: &str) -> Option<MacOsVersion> {
    let mut parts = value.trim().split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().map_or(Some(0), |v| v.parse().ok())?;
    let patch = parts.next().map_or(Some(0), |v| v.parse().ok())?;
    if parts.next().is_some() || major < 10 {
        return None;
    }
    Some(MacOsVersion {
        major,
        minor,
        patch,
    })
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MacImageTool {
    /// macOS 27+: `diskutil image attach` and `diskutil eject`; `hdiutil` is
    /// deprecated there. `diskutil image detach` is not the replacement.
    Diskutil,
    /// Earlier systems: `hdiutil attach` / `hdiutil detach`. `diskutil image`
    /// exists on some of them, but its option syntax differed between versions.
    Hdiutil,
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn mac_image_tool(version: Option<MacOsVersion>) -> MacImageTool {
    match version {
        Some(version) if version.major >= 27 => MacImageTool::Diskutil,
        // Unknown version: the long-standing interface is the safe choice.
        _ => MacImageTool::Hdiutil,
    }
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
/// `dev-entry` is `disk4s1` for diskutil and `/dev/disk4s1` for hdiutil.
pub fn normalize_device(entry: &str) -> Option<String> {
    let name = entry.strip_prefix("/dev/").unwrap_or(entry);
    let valid = name.starts_with("disk")
        && name[4..].starts_with(|c: char| c.is_ascii_digit())
        && name[4..].chars().all(|c| c.is_ascii_digit() || c == 's')
        && !name.ends_with('s');
    valid.then(|| format!("/dev/{name}"))
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
/// The whole disk of `disk4s1` is `disk4`.
pub fn whole_disk(device: &str) -> String {
    let name = device.strip_prefix("/dev/").unwrap_or(device);
    let digits = name[4..]
        .find('s')
        .map(|index| &name[..4 + index])
        .unwrap_or(name);
    format!("/dev/{digits}")
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
/// Shared by `diskutil image attach --plist` and `hdiutil attach -plist`.
pub fn parse_system_entities(image: &Path, value: &Value) -> Option<DiskImageStatus> {
    let entities = value.get("system-entities")?.as_array()?;
    let mut devices = vec![];
    let mut volumes = vec![];
    for entity in entities {
        let Some(device) = entity
            .get("dev-entry")
            .and_then(Value::as_str)
            .and_then(normalize_device)
        else {
            continue;
        };
        if let Some(mount_point) = entity.get("mount-point").and_then(Value::as_str) {
            volumes.push(MountedVolume {
                device: Some(device.clone()),
                mount_point: mount_point.to_string(),
                name: entity
                    .get("volume-name")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or_else(|| {
                        Path::new(mount_point)
                            .file_name()
                            .map(|name| name.to_string_lossy().into_owned())
                    }),
            });
        }
        devices.push(device);
    }
    let device = devices
        .iter()
        .min_by_key(|device| device.len())
        .map(|device| whole_disk(device))?;
    Some(DiskImageStatus {
        image_path: image.to_string_lossy().into_owned(),
        attached: true,
        device: Some(device),
        volumes,
        already_mounted: false,
    })
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
/// `hdiutil info -plist`: find the entry for `image`.
pub fn parse_hdiutil_info(image: &Path, value: &Value) -> Option<DiskImageStatus> {
    value
        .get("images")?
        .as_array()?
        .iter()
        .filter(|entry| {
            entry
                .get("image-path")
                .and_then(Value::as_str)
                .is_some_and(|path| same_file(Path::new(path), image))
        })
        .find_map(|entry| parse_system_entities(image, entry))
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
/// `ioreg -a -r -c AppleDiskImageDevice -l`: the DiskImages2 device for
/// `image` and the BSD names of its media (whole disk first).
pub fn parse_ioreg_devices(image: &Path, value: &Value) -> Option<Vec<String>> {
    fn collect(node: &Value, names: &mut Vec<String>) {
        if let Some(name) = node.get("BSD Name").and_then(Value::as_str) {
            if let Some(device) = normalize_device(name) {
                names.push(device);
            }
        }
        for child in node
            .get("IORegistryEntryChildren")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            collect(child, names);
        }
    }
    let devices = value.as_array()?;
    let device = devices.iter().find(|device| {
        device
            .get("DiskImageURL")
            .and_then(Value::as_str)
            .and_then(|value| url::Url::parse(value).ok())
            .and_then(|value| value.to_file_path().ok())
            .is_some_and(|path| same_file(&path, image))
    })?;
    let mut names = vec![];
    collect(device, &mut names);
    (!names.is_empty()).then_some(names)
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn same_file(left: &Path, right: &Path) -> bool {
    if left == right {
        return true;
    }
    match (std::fs::canonicalize(left), std::fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

/// Shape of the JSON written by the Windows PowerShell scripts.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn parse_windows_status(image: &Path, value: &Value) -> Result<DiskImageStatus, NativeError> {
    if let Some(error) = value.get("error") {
        return Err(windows_error(error).with_path(image));
    }
    let attached = value
        .get("attached")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let volumes = value
        .get("volumes")
        .map(|volumes| match volumes {
            // ConvertTo-Json writes a single object for a one-item array.
            Value::Array(items) => items.clone(),
            Value::Null => vec![],
            item => vec![item.clone()],
        })
        .unwrap_or_default()
        .into_iter()
        .filter_map(|volume| {
            let letter = volume
                .get("driveLetter")
                .and_then(Value::as_str)
                .filter(|letter| {
                    letter.len() == 1 && letter.chars().all(|c| c.is_ascii_alphabetic())
                });
            let path = volume.get("path").and_then(Value::as_str);
            let mount_point = letter
                .map(|letter| format!("{}:\\", letter.to_ascii_uppercase()))
                .or_else(|| path.map(str::to_string))?;
            Some(MountedVolume {
                device: path.map(str::to_string),
                mount_point,
                name: volume
                    .get("label")
                    .and_then(Value::as_str)
                    .filter(|label| !label.is_empty())
                    .map(str::to_string),
            })
        })
        .collect();
    Ok(DiskImageStatus {
        image_path: image.to_string_lossy().into_owned(),
        attached,
        device: value
            .get("devicePath")
            .and_then(Value::as_str)
            .filter(|path| !path.is_empty())
            .map(str::to_string),
        volumes,
        already_mounted: false,
    })
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn windows_error(error: &Value) -> NativeError {
    let kind = error.get("kind").and_then(Value::as_str).unwrap_or("");
    let message = error.get("message").and_then(Value::as_str).unwrap_or("");
    let (code, text) = match kind {
        "unavailable" => (
            "ENOTSUPPORTED",
            "Windows Storage cmdlets (Mount-DiskImage) are not available on this system",
        ),
        "missing" => ("ENOENT", "The disk image no longer exists"),
        "denied" => (
            "EACCES",
            "Windows did not allow Vesperwind to mount or eject this image",
        ),
        "invalid" => (
            "EINVALID_IMAGE",
            "Windows could not mount this file as a disk image",
        ),
        "in-use" => ("EBUSY", "The disk image is in use"),
        _ => ("EDISK_IMAGE", "The disk image operation failed"),
    };
    let error = NativeError::new(code, text);
    if message.is_empty() {
        error
    } else {
        error.with_native_error(message.to_string())
    }
}

/// Windows PowerShell script for all disk image actions. It is constant: the
/// image path and the action arrive through environment variables, so a name
/// such as `C:\foo'; Remove-Item ...` is data and never becomes code. Output
/// is one JSON object written by ConvertTo-Json.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub const WINDOWS_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }
$imagePath = $env:VESPERWIND_IMAGE_PATH
$action = $env:VESPERWIND_IMAGE_ACTION
function Write-Result($value) { $value | ConvertTo-Json -Compress -Depth 5 }
function Describe-Image($image) {
  $volumes = @()
  if ($image.Attached) {
    $volumes = @(Get-Volume -DiskImage $image -ErrorAction SilentlyContinue | ForEach-Object {
      [pscustomobject]@{
        driveLetter = $(if ($_.DriveLetter) { [string]$_.DriveLetter } else { $null })
        label = [string]$_.FileSystemLabel
        path = [string]$_.Path
      }
    })
  }
  [pscustomobject]@{ attached = [bool]$image.Attached; devicePath = [string]$image.DevicePath; volumes = $volumes }
}
try {
  if (-not (Get-Command -Name Get-DiskImage -ErrorAction SilentlyContinue)) {
    Write-Result @{ error = @{ kind = 'unavailable'; message = 'Get-DiskImage is not available' } }
    exit 0
  }
  if (-not (Test-Path -LiteralPath $imagePath -PathType Leaf)) {
    Write-Result @{ error = @{ kind = 'missing'; message = '' } }
    exit 0
  }
  switch ($action) {
    'status' { $image = Get-DiskImage -ImagePath $imagePath }
    'mount' {
      Mount-DiskImage -ImagePath $imagePath -StorageType ISO -Access ReadOnly | Out-Null
      $image = Get-DiskImage -ImagePath $imagePath
    }
    'unmount' {
      Dismount-DiskImage -ImagePath $imagePath | Out-Null
      $image = Get-DiskImage -ImagePath $imagePath
    }
    default { throw 'Unknown disk image action' }
  }
  Write-Result (Describe-Image $image)
} catch {
  $hresult = [int]$_.Exception.HResult
  $id = [string]$_.FullyQualifiedErrorId
  $category = [string]$_.CategoryInfo.Category
  $kind = 'other'
  if ($_.Exception -is [System.UnauthorizedAccessException] -or $category -eq 'PermissionDenied' -or $hresult -eq -2147024891) { $kind = 'denied' }
  elseif ($hresult -eq -2147024894 -or $hresult -eq -2147024893 -or $category -eq 'ObjectNotFound') { $kind = 'missing' }
  elseif ($hresult -eq -2147024864 -or $category -eq 'ResourceBusy') { $kind = 'in-use' }
  elseif ($id -match 'CommandNotFound') { $kind = 'unavailable' }
  elseif ($category -eq 'InvalidData' -or $category -eq 'InvalidArgument' -or $hresult -eq -2147024883) { $kind = 'invalid' }
  Write-Result @{ error = @{ kind = $kind; message = [string]$_.Exception.Message; id = $id; hresult = $hresult } }
}
"#;

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub struct PowerShellInvocation {
    pub program: std::path::PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(&'static str, std::ffi::OsString)>,
}

/// Build the PowerShell process description. `-EncodedCommand` carries only
/// the constant script (UTF-16LE, base64); the user path is an env value.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn powershell_invocation(action: &'static str, image: &Path) -> PowerShellInvocation {
    use base64::Engine;
    let utf16: Vec<u8> = WINDOWS_SCRIPT
        .encode_utf16()
        .flat_map(|unit| unit.to_le_bytes())
        .collect();
    let system_root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    PowerShellInvocation {
        program: std::path::PathBuf::from(system_root)
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe"),
        args: [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
        ]
        .into_iter()
        .map(str::to_string)
        .chain([base64::engine::general_purpose::STANDARD.encode(utf16)])
        .collect(),
        env: vec![
            ("VESPERWIND_IMAGE_ACTION", action.into()),
            ("VESPERWIND_IMAGE_PATH", image.as_os_str().to_owned()),
        ],
    }
}

pub fn status(provider_id: Option<&str>, path: &str) -> Result<DiskImageStatus, NativeError> {
    let image = validate_image(ImagePlatform::current(), provider_id, path)?;
    platform::status(&image)
}

pub fn mount(provider_id: Option<&str>, path: &str) -> Result<DiskImageStatus, NativeError> {
    let image = validate_image(ImagePlatform::current(), provider_id, path)?;
    let current = platform::status(&image)?;
    if current.attached {
        return Ok(DiskImageStatus {
            already_mounted: true,
            ..current
        });
    }
    platform::mount(&image)
}

pub fn unmount(provider_id: Option<&str>, path: &str) -> Result<DiskImageStatus, NativeError> {
    let image = validate_image(ImagePlatform::current(), provider_id, path)?;
    let current = platform::status(&image)?;
    if !current.attached {
        return Err(
            NativeError::new("ENOT_MOUNTED", "The disk image is not mounted").with_path(&image),
        );
    }
    platform::unmount(&image, &current)
}

#[cfg(target_os = "macos")]
use macos as platform;
#[cfg(target_os = "windows")]
use windows as platform;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod platform {
    use super::*;
    pub fn status(_: &Path) -> Result<DiskImageStatus, NativeError> {
        Err(unsupported_platform())
    }
    pub fn mount(_: &Path) -> Result<DiskImageStatus, NativeError> {
        Err(unsupported_platform())
    }
    pub fn unmount(_: &Path, _: &DiskImageStatus) -> Result<DiskImageStatus, NativeError> {
        Err(unsupported_platform())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validates_platform_provider_and_extension_on_the_backend() {
        let root = std::env::temp_dir().join(format!("vesperwind-image-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let iso = root.join("Образ 'q'; Remove-Item.ISO");
        let dmg = root.join("installer.dmg");
        let text = root.join("notes.txt");
        for file in [&iso, &dmg, &text] {
            std::fs::write(file, b"x").unwrap();
        }
        let path = |p: &Path| p.to_string_lossy().into_owned();
        assert!(validate_image(ImagePlatform::MacOs, Some("local"), &path(&iso)).is_ok());
        assert!(validate_image(ImagePlatform::MacOs, None, &path(&dmg)).is_ok());
        assert!(validate_image(ImagePlatform::Windows, Some("local"), &path(&iso)).is_ok());
        assert_eq!(
            validate_image(ImagePlatform::Windows, Some("local"), &path(&dmg))
                .unwrap_err()
                .code,
            "EUNSUPPORTED_IMAGE"
        );
        assert_eq!(
            validate_image(ImagePlatform::MacOs, Some("local"), &path(&text))
                .unwrap_err()
                .code,
            "EUNSUPPORTED_IMAGE"
        );
        assert_eq!(
            validate_image(ImagePlatform::MacOs, Some("sftp:server"), &path(&iso))
                .unwrap_err()
                .code,
            "ENOTSUPPORTED"
        );
        assert_eq!(
            validate_image(ImagePlatform::Unsupported, Some("local"), &path(&iso))
                .unwrap_err()
                .code,
            "ENOTSUPPORTED"
        );
        assert_eq!(
            validate_image(ImagePlatform::MacOs, Some("local"), "relative.iso")
                .unwrap_err()
                .code,
            "EINVAL"
        );
        assert_eq!(
            validate_image(
                ImagePlatform::MacOs,
                Some("local"),
                &path(&root.join("missing.iso"))
            )
            .unwrap_err()
            .code,
            "ENOENT"
        );
        let folder = root.join("folder.iso");
        std::fs::create_dir(&folder).unwrap();
        assert_eq!(
            validate_image(ImagePlatform::MacOs, Some("local"), &path(&folder))
                .unwrap_err()
                .code,
            "EISDIR"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn selects_the_macos_tool_by_major_version() {
        let version = |v: &str| parse_macos_version(v);
        assert_eq!(
            version("27.0.1"),
            Some(MacOsVersion {
                major: 27,
                minor: 0,
                patch: 1
            })
        );
        assert_eq!(version("14.6\n").unwrap().minor, 6);
        assert_eq!(version("26").unwrap().major, 26);
        assert_eq!(version("10.15.7").unwrap().major, 10);
        for invalid in ["", "abc", "27.x", "1.2.3.4", "9.0"] {
            assert_eq!(version(invalid), None, "{invalid}");
        }
        assert_eq!(mac_image_tool(version("27.0")), MacImageTool::Diskutil);
        assert_eq!(mac_image_tool(version("28.1")), MacImageTool::Diskutil);
        assert_eq!(mac_image_tool(version("26.4")), MacImageTool::Hdiutil);
        assert_eq!(mac_image_tool(version("12.7.6")), MacImageTool::Hdiutil);
        assert_eq!(mac_image_tool(None), MacImageTool::Hdiutil);
    }

    #[test]
    fn parses_diskutil_and_hdiutil_attach_plists() {
        let image = Path::new("/Users/me/test image.dmg");
        // Captured from `diskutil image attach --plist` on macOS 27.
        let diskutil = json!({"system-entities": [
            {"content-hint": "GUID_partition_scheme", "dev-entry": "disk4", "size": 5242880},
            {"content-hint": "Apple_HFS", "dev-entry": "disk4s1", "filesystem-type": "hfs",
             "mount-point": "/Volumes/VW Test ДМГ", "volume-name": "VW Test ДМГ"}
        ]});
        let status = parse_system_entities(image, &diskutil).unwrap();
        assert_eq!(status.device.as_deref(), Some("/dev/disk4"));
        assert_eq!(status.volumes[0].mount_point, "/Volumes/VW Test ДМГ");
        assert_eq!(status.volumes[0].device.as_deref(), Some("/dev/disk4s1"));
        // Captured from `hdiutil attach -plist` (absolute dev entries).
        let hdiutil = json!({"system-entities": [
            {"dev-entry": "/dev/disk7", "potentially-mountable": false},
            {"dev-entry": "/dev/disk7s1", "mount-point": "/Volumes/VW Test", "potentially-mountable": true}
        ]});
        let status = parse_system_entities(image, &hdiutil).unwrap();
        assert_eq!(status.device.as_deref(), Some("/dev/disk7"));
        assert_eq!(status.volumes[0].name.as_deref(), Some("VW Test"));
        // A single-entity ISO.
        let iso =
            json!({"system-entities": [{"dev-entry": "disk4", "mount-point": "/Volumes/VWISO"}]});
        assert_eq!(
            parse_system_entities(image, &iso)
                .unwrap()
                .device
                .as_deref(),
            Some("/dev/disk4")
        );
        assert!(parse_system_entities(
            image,
            &json!({"system-entities": [{"dev-entry": "../../etc"}]})
        )
        .is_none());
    }

    #[test]
    fn finds_images_in_hdiutil_info() {
        let image = Path::new("/Users/me/test image.dmg");
        let info = json!({"images": [
            {"image-path": "/Users/me/other.dmg", "system-entities": [{"dev-entry": "/dev/disk2"}]},
            {"image-path": "/Users/me/test image.dmg", "system-entities": [
                {"dev-entry": "/dev/disk5"}, {"dev-entry": "/dev/disk5s1", "mount-point": "/Volumes/T"}]}
        ]});
        assert_eq!(
            parse_hdiutil_info(image, &info).unwrap().device.as_deref(),
            Some("/dev/disk5")
        );
        assert!(parse_hdiutil_info(Path::new("/nope.dmg"), &info).is_none());
    }

    // `file://` URLs without a drive letter are not file paths on Windows;
    // ioreg output exists only on macOS anyway.
    #[cfg(unix)]
    #[test]
    fn finds_disk_image_devices_in_ioreg() {
        let image = Path::new("/Users/me/test image.dmg");
        let ioreg = json!([
            {"DiskImageURL": "file:///Users/me/other.dmg", "IORegistryEntryChildren": [{"BSD Name": "disk8"}]},
            {"DiskImageURL": "file:///Users/me/test%20image.dmg", "IORegistryEntryChildren": [
                {"IOObjectClass": "IOBlockStorageDriver", "IORegistryEntryChildren": [
                    {"BSD Name": "disk4", "IORegistryEntryChildren": [
                        {"IORegistryEntryChildren": [{"BSD Name": "disk4s1"}]}]}]}]}
        ]);
        assert_eq!(
            parse_ioreg_devices(image, &ioreg).unwrap(),
            ["/dev/disk4", "/dev/disk4s1"]
        );
        assert!(parse_ioreg_devices(Path::new("/x.iso"), &ioreg).is_none());
    }

    /// Mounts and ejects a real ISO with the OS tools for this macOS version.
    /// Run with `cargo test real_disk_image -- --ignored`.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore]
    fn real_disk_image_mount_status_and_eject() {
        let root = std::env::temp_dir().join(format!("vesperwind-iso-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("content")).unwrap();
        std::fs::write(root.join("content/hello.txt"), b"hello").unwrap();
        let image = root.join("Test образ 'q'.iso");
        let status = std::process::Command::new("/usr/bin/hdiutil")
            .args([
                "makehybrid",
                "-iso",
                "-joliet",
                "-default-volume-name",
                "VWTESTISO",
                "-o",
            ])
            .arg(&image)
            .arg(root.join("content"))
            .status()
            .unwrap();
        assert!(status.success());
        let path = image.to_string_lossy().into_owned();
        assert!(!super::status(Some("local"), &path).unwrap().attached);
        let mounted = mount(Some("local"), &path).unwrap();
        assert!(mounted.attached && !mounted.already_mounted);
        let mount_point = &mounted.volumes[0].mount_point;
        assert_eq!(
            std::fs::read(Path::new(mount_point).join("hello.txt")).unwrap(),
            b"hello"
        );
        let again = mount(Some("local"), &path).unwrap();
        assert!(again.already_mounted);
        assert_eq!(again.device, mounted.device);
        assert!(super::status(Some("local"), &path)
            .unwrap()
            .volumes
            .iter()
            .any(|v| &v.mount_point == mount_point));
        assert!(!unmount(Some("local"), &path).unwrap().attached);
        assert!(!super::status(Some("local"), &path).unwrap().attached);
        assert_eq!(
            unmount(Some("local"), &path).unwrap_err().code,
            "ENOT_MOUNTED"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn normalizes_device_names() {
        assert_eq!(normalize_device("disk4s1").as_deref(), Some("/dev/disk4s1"));
        assert_eq!(
            normalize_device("/dev/disk12").as_deref(),
            Some("/dev/disk12")
        );
        for invalid in [
            "disk", "disks", "disk4s", "/dev/sda", "disk4;rm", "../disk4",
        ] {
            assert!(normalize_device(invalid).is_none(), "{invalid}");
        }
        assert_eq!(whole_disk("/dev/disk12s3"), "/dev/disk12");
        assert_eq!(whole_disk("disk4"), "/dev/disk4");
    }

    #[test]
    fn powershell_receives_the_path_only_as_data() {
        use base64::Engine;
        let hostile = Path::new(r"C:\foo'; Remove-Item -Recurse C:\ ; $(calc) `whoami`.iso");
        let invocation = powershell_invocation("mount", hostile);
        assert!(invocation.program.ends_with(r"powershell.exe"));
        for flag in ["-NoProfile", "-NonInteractive", "-EncodedCommand"] {
            assert!(invocation.args.iter().any(|arg| arg == flag), "{flag}");
        }
        let joined = invocation.args.join(" ");
        assert!(!joined.contains("Remove-Item"));
        assert!(!joined.contains("foo"));
        let script = base64::engine::general_purpose::STANDARD
            .decode(invocation.args.last().unwrap())
            .unwrap();
        let units: Vec<u16> = script
            .chunks(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        let script = String::from_utf16(&units).unwrap();
        assert_eq!(script, WINDOWS_SCRIPT);
        assert!(script.contains("$env:VESPERWIND_IMAGE_PATH"));
        assert!(script.contains("-LiteralPath $imagePath"));
        assert!(!script.contains("Invoke-Expression") && !script.contains("diskpart"));
        assert_eq!(
            invocation.env,
            vec![
                ("VESPERWIND_IMAGE_ACTION", "mount".into()),
                ("VESPERWIND_IMAGE_PATH", hostile.as_os_str().to_owned()),
            ]
        );
    }

    #[test]
    fn parses_windows_storage_cmdlet_json() {
        let image = Path::new(r"C:\Images\Win 11.iso");
        let mounted = json!({"attached": true, "devicePath": r"\\.\CDROM0",
            "volumes": {"driveLetter": "e", "label": "CCCOMA", "path": r"\\?\Volume{1}\"}});
        let status = parse_windows_status(image, &mounted).unwrap();
        assert!(status.attached);
        assert_eq!(status.volumes[0].mount_point, r"E:\");
        assert_eq!(status.volumes[0].name.as_deref(), Some("CCCOMA"));
        let no_letter = json!({"attached": true, "volumes": [{"driveLetter": null, "path": r"\\?\Volume{2}\"}]});
        assert_eq!(
            parse_windows_status(image, &no_letter).unwrap().volumes[0].mount_point,
            r"\\?\Volume{2}\"
        );
        let detached = json!({"attached": false, "devicePath": null, "volumes": null});
        assert!(!parse_windows_status(image, &detached).unwrap().attached);
        for (kind, code) in [
            ("unavailable", "ENOTSUPPORTED"),
            ("missing", "ENOENT"),
            ("denied", "EACCES"),
            ("invalid", "EINVALID_IMAGE"),
            ("in-use", "EBUSY"),
            ("other", "EDISK_IMAGE"),
        ] {
            let error =
                parse_windows_status(image, &json!({"error": {"kind": kind, "message": "x"}}))
                    .unwrap_err();
            assert_eq!(error.code, code);
        }
    }
}
