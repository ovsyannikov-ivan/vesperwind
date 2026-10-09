//! User-directed macOS permission preparation, outside operation deadlines.
//! No permission decision is cached in settings; macOS remains authoritative.
use crate::error::NativeError;
#[cfg(any(target_os = "macos", test))]
use std::path::{Path, PathBuf};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
};

static REQUESTS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
pub fn register(id: &str) -> Result<Arc<AtomicBool>, NativeError> {
    if uuid::Uuid::parse_str(id).is_err() {
        return Err(NativeError::new("EINVAL", "Invalid permission request"));
    }
    let flag = REQUESTS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(id.into())
        .or_insert_with(|| Arc::new(AtomicBool::new(false)))
        .clone();
    Ok(flag)
}
pub fn cancel(id: &str) {
    if uuid::Uuid::parse_str(id).is_err() {
        return;
    }
    let mut requests = REQUESTS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    requests
        .entry(id.into())
        .or_insert_with(|| Arc::new(AtomicBool::new(false)))
        .store(true, Ordering::Release);
}
pub fn finish(id: &str) {
    REQUESTS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(id);
}
pub fn cancelled(flag: &AtomicBool) -> Result<(), NativeError> {
    if flag.load(Ordering::Acquire) {
        Err(NativeError::new(
            "ECANCELLED",
            "Permission preparation was cancelled",
        ))
    } else {
        Ok(())
    }
}

#[cfg(any(target_os = "macos", test))]
fn protected_folder(path: &Path, desktop: &Path, documents: &Path) -> Option<PathBuf> {
    [desktop, documents]
        .into_iter()
        .find(|root| path.starts_with(root))
        .map(Path::to_path_buf)
}
#[cfg(target_os = "macos")]
fn folder(kind: &str) -> Result<PathBuf, NativeError> {
    match kind {
        "desktop" => dirs::desktop_dir(),
        "documents" => dirs::document_dir(),
        _ => None,
    }
    .ok_or_else(|| NativeError::new("EINVAL", "Unknown protected folder"))
}
#[cfg(target_os = "macos")]
fn request_folder(path: &Path, flag: &AtomicBool) -> Result<(), NativeError> {
    cancelled(flag)?;
    // Open the directory only. Never open file contents or materialize cloud files.
    let result = std::fs::read_dir(path).and_then(|mut entries| entries.next().transpose().map(|_| ())).map_err(|error| {
        if error.kind() == std::io::ErrorKind::PermissionDenied {
            NativeError::new("EPERMISSION_DENIED", "Folder access is not allowed. Enable Vesperwind in System Settings → Privacy & Security → Files and Folders.")
        } else { NativeError::from_io(&error, "Unable to prepare access to this folder") }
    });
    cancelled(flag)?;
    result
}
pub fn prepare_folder(path: &str, flag: &AtomicBool) -> Result<(), NativeError> {
    cancelled(flag)?;
    #[cfg(target_os = "macos")]
    if let Some(root) =
        protected_folder(Path::new(path), &folder("desktop")?, &folder("documents")?)
    {
        return request_folder(&root, flag);
    }
    let _ = path;
    Ok(())
}
pub fn request(kind: &str, host: Option<&str>, flag: &AtomicBool) -> Result<(), NativeError> {
    cancelled(flag)?;
    #[cfg(target_os = "macos")]
    match kind {
        "desktop" | "documents" => return request_folder(&folder(kind)?, flag),
        "network" => {
            if host.is_none_or(needs_local_network) {
                return macos::request_network(flag);
            }
            return Ok(());
        }
        _ => return Err(NativeError::new("EINVAL", "Unknown permission kind")),
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (kind, host);
        Err(NativeError::new(
            "ENOTSUPPORTED",
            "Permission setup is available on macOS",
        ))
    }
}
#[cfg(any(target_os = "macos", test))]
fn needs_local_network(host: &str) -> bool {
    use std::net::{IpAddr, ToSocketAddrs};
    let local = |ip: IpAddr| {
        #[cfg(target_os = "macos")]
        {
            macos::on_local_network(ip)
        }
        #[cfg(not(target_os = "macos"))]
        {
            !ip.is_loopback()
                && match ip {
                    IpAddr::V4(ip) => ip.is_private() || ip.is_link_local(),
                    IpAddr::V6(ip) => ip.is_unique_local() || ip.is_unicast_link_local(),
                }
        }
    };
    host.trim_end_matches('.')
        .to_ascii_lowercase()
        .ends_with(".local")
        || host.parse::<IpAddr>().is_ok_and(local)
        || (host, 22)
            .to_socket_addrs()
            .is_ok_and(|mut addresses| addresses.any(|address| local(address.ip())))
}

#[cfg(any(target_os = "macos", test))]
fn matches_subnet(
    ip: std::net::IpAddr,
    interface: std::net::IpAddr,
    mask: std::net::IpAddr,
) -> bool {
    use std::net::IpAddr;
    if ip.is_loopback() || interface.is_unspecified() {
        return false;
    }
    match (ip, interface, mask) {
        (IpAddr::V4(ip), IpAddr::V4(interface), IpAddr::V4(mask)) => {
            u32::from(ip) & u32::from(mask) == u32::from(interface) & u32::from(mask)
        }
        (IpAddr::V6(ip), IpAddr::V6(interface), IpAddr::V6(mask)) => {
            u128::from(ip) & u128::from(mask) == u128::from(interface) & u128::from(mask)
        }
        _ => false,
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use block2::RcBlock;
    use std::{
        ffi::{c_char, c_void},
        sync::mpsc,
        time::Duration,
    };
    unsafe extern "C" {
        fn nw_browse_descriptor_create_bonjour_service(
            service: *const c_char,
            domain: *const c_char,
        ) -> *mut c_void;
        fn nw_parameters_create() -> *mut c_void;
        fn nw_browser_create(descriptor: *mut c_void, parameters: *mut c_void) -> *mut c_void;
        fn nw_browser_set_state_changed_handler(browser: *mut c_void, block: *mut c_void);
        fn nw_browser_set_queue(browser: *mut c_void, queue: *mut c_void);
        fn nw_browser_start(browser: *mut c_void);
        fn nw_browser_cancel(browser: *mut c_void);
        fn nw_release(object: *mut c_void);
        fn nw_error_get_error_domain(error: *mut c_void) -> i32;
        fn nw_error_get_error_code(error: *mut c_void) -> i32;
    }
    unsafe extern "C" {
        fn dispatch_queue_create(label: *const c_char, attr: *mut c_void) -> *mut c_void;
        fn dispatch_release(object: *mut c_void);
    }
    pub fn on_local_network(ip: std::net::IpAddr) -> bool {
        use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
        unsafe fn address(raw: *const libc::sockaddr) -> Option<IpAddr> {
            if raw.is_null() {
                return None;
            }
            match unsafe { (*raw).sa_family as i32 } {
                libc::AF_INET => Some(IpAddr::V4(Ipv4Addr::from(unsafe {
                    (*raw.cast::<libc::sockaddr_in>())
                        .sin_addr
                        .s_addr
                        .to_ne_bytes()
                }))),
                libc::AF_INET6 => Some(IpAddr::V6(Ipv6Addr::from(unsafe {
                    (*raw.cast::<libc::sockaddr_in6>()).sin6_addr.s6_addr
                }))),
                _ => None,
            }
        }
        // Local-network privacy follows broadcast-capable interfaces. Do not
        // require LAN access for an unrelated private address reached via VPN.
        unsafe {
            let mut first = std::ptr::null_mut();
            if libc::getifaddrs(&mut first) != 0 {
                return false;
            }
            let mut current = first;
            let mut found = false;
            while !current.is_null() {
                let interface = &*current;
                if interface.ifa_flags & (libc::IFF_UP | libc::IFF_BROADCAST) as u32
                    == (libc::IFF_UP | libc::IFF_BROADCAST) as u32
                    && interface.ifa_flags & libc::IFF_POINTOPOINT as u32 == 0
                {
                    if let (Some(local), Some(mask)) =
                        (address(interface.ifa_addr), address(interface.ifa_netmask))
                    {
                        if matches_subnet(ip, local, mask) {
                            found = true;
                            break;
                        }
                    }
                }
                current = interface.ifa_next;
            }
            libc::freeifaddrs(first);
            found
        }
    }
    pub fn request_network(flag: &AtomicBool) -> Result<(), NativeError> {
        // The framework is weak-linked for older deployment targets. Only
        // macOS 15+ has this privilege and needs the browser preparation.
        let major = objc2::rc::autoreleasepool(|_| {
            objc2_foundation::NSProcessInfo::processInfo()
                .operatingSystemVersion()
                .majorVersion
        });
        if major < 15 {
            return Ok(());
        }
        // Browse the SSH service solely to prepare the OS privilege. No endpoint
        // or discovered address is exposed, and no SSH authentication is attempted.
        // Network.framework waits for permission and resumes after it is granted.
        unsafe {
            let descriptor = nw_browse_descriptor_create_bonjour_service(
                c"_ssh._tcp".as_ptr(),
                std::ptr::null(),
            );
            let parameters = nw_parameters_create();
            let browser = nw_browser_create(descriptor, parameters);
            nw_release(descriptor);
            nw_release(parameters);
            if browser.is_null() {
                return Err(NativeError::new(
                    "EPERMISSION_NETWORK",
                    "Unable to prepare local network access",
                ));
            }
            let queue = dispatch_queue_create(
                c"com.vesperwind.permission-network".as_ptr(),
                std::ptr::null_mut(),
            );
            let (sender, receiver) = mpsc::channel();
            let callback = RcBlock::new(move |state: i32, error: *mut c_void| {
                let policy = !error.is_null()
                    && nw_error_get_error_domain(error) == 2
                    && nw_error_get_error_code(error) == -65570;
                let _ = sender.send((state, policy));
            });
            nw_browser_set_state_changed_handler(browser, RcBlock::as_ptr(&callback).cast());
            nw_browser_set_queue(browser, queue);
            nw_browser_start(browser);
            let result = loop {
                if let Err(error) = cancelled(flag) {
                    break Err(error);
                }
                match receiver.recv_timeout(Duration::from_millis(100)) {
                    Ok((1, _)) => break Ok(()), // ready
                    Ok((2, _)) => {
                        break Err(NativeError::new(
                            "EPERMISSION_NETWORK",
                            "Local network access could not be prepared",
                        ))
                    }
                    Ok((4, false)) => {
                        break Err(NativeError::new(
                            "ENETWORK_UNAVAILABLE",
                            "Connect to a local network before requesting access",
                        ))
                    }
                    // PolicyDenied means pending or denied; macOS has no general
                    // authorization-status API. Keep waiting with a Cancel/Skip UI.
                    _ => {}
                }
            };
            nw_browser_cancel(browser);
            nw_browser_set_state_changed_handler(browser, std::ptr::null_mut());
            nw_release(browser);
            dispatch_release(queue);
            result
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn protected_paths_are_component_bounded() {
        let desktop = Path::new("/home/fixture/Desktop");
        let docs = Path::new("/home/fixture/Documents");
        assert_eq!(
            protected_folder(Path::new("/home/fixture/Documents/sub/file"), desktop, docs)
                .as_deref(),
            Some(docs)
        );
        assert!(
            protected_folder(Path::new("/home/fixture/Documents-backup"), desktop, docs).is_none()
        );
    }
    #[test]
    fn local_targets_exclude_loopback_and_public_addresses() {
        assert!(matches_subnet(
            "192.168.10.31".parse().unwrap(),
            "192.168.10.2".parse().unwrap(),
            "255.255.255.0".parse().unwrap()
        ));
        assert!(!matches_subnet(
            "10.8.0.5".parse().unwrap(),
            "192.168.10.2".parse().unwrap(),
            "255.255.255.0".parse().unwrap()
        ));
        assert!(needs_local_network("nas.local"));
        assert!(!needs_local_network("127.0.0.1"));
        assert!(!needs_local_network("8.8.8.8"));
    }
    #[test]
    fn cancellation_is_scoped_and_removes_its_request() {
        let id = uuid::Uuid::new_v4().to_string();
        let flag = register(&id).unwrap();
        assert!(cancelled(&flag).is_ok());
        cancel(&id);
        assert_eq!(cancelled(&flag).unwrap_err().code, "ECANCELLED");
        finish(&id);
        assert!(register("invalid").is_err());
        let early = uuid::Uuid::new_v4().to_string();
        cancel(&early);
        let flag = register(&early).unwrap();
        assert_eq!(cancelled(&flag).unwrap_err().code, "ECANCELLED");
        finish(&early);
    }
}
