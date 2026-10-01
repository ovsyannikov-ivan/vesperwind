//! Windows output policy, independent of decoder selection and fullscreen.
//! Never select linear/wide-gamut SDR: pinned libplacebo maps those to scRGB.
use super::surface::DisplayCapabilities;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum WindowsOutputPolicy {
    Sdr,
    Hdr10,
}

impl WindowsOutputPolicy {
    pub(super) fn select(
        transfer: Option<&str>,
        primaries: Option<&str>,
        display: &DisplayCapabilities,
    ) -> (Self, Option<String>) {
        let reason = if !display.output_supported {
            Some("The current renderer cannot present HDR10")
        } else if !display.hdr_state_verified {
            Some("Windows HDR state could not be verified")
        } else if !display.hdr_capable && display.hdr_capability_verified {
            Some("The current display is not HDR capable")
        } else if !display.hdr_enabled {
            Some(if display.hdr_user_enabled == Some(true) {
                "Windows HDR is enabled by the user but not active on the current output"
            } else {
                "Windows HDR disabled"
            })
        } else if !display.hdr_capable {
            Some("HDR display capability could not be verified")
        } else if !is_hdr10_source(transfer, primaries) {
            Some("The source is not an HDR10-compatible PQ / BT.2020 signal")
        } else {
            None
        };
        match reason {
            Some(reason) => (Self::Sdr, Some(reason.to_string())),
            None => (Self::Hdr10, None),
        }
    }

    pub(super) fn options(self) -> [(&'static str, &'static str); 3] {
        match self {
            Self::Sdr => [
                ("target-prim", "bt.709"),
                ("target-trc", "gamma2.2"),
                ("target-peak", "203"),
            ],
            Self::Hdr10 => [
                ("target-trc", "pq"),
                ("target-prim", "bt.2020"),
                ("target-peak", "auto"),
            ],
        }
    }

    pub(super) fn matches_target(
        self,
        transfer: Option<&str>,
        primaries: Option<&str>,
        format: Option<&str>,
    ) -> bool {
        match self {
            // mpv 0.41 vo_gpu_next exposes the *actual backbuffer's* libplacebo
            // format name, not d3d11-output-format's requested value.
            Self::Hdr10 => is_hdr10_source(transfer, primaries) && format == Some("rgb10a2"),
            Self::Sdr => {
                matches!(transfer, Some("gamma2.2" | "srgb" | "bt.1886"))
                    && primaries == Some("bt.709")
                    && matches!(format, Some("rgba8" | "bgra8" | "rgb10a2"))
            }
        }
    }
}

pub(super) fn is_hdr10_source(transfer: Option<&str>, primaries: Option<&str>) -> bool {
    matches!(transfer, Some("pq" | "st2084")) && primaries == Some("bt.2020")
}

pub(super) fn dxgi_format(format: Option<&str>) -> Option<&'static str> {
    match format? {
        "rgb10a2" => Some("DXGI_FORMAT_R10G10B10A2_UNORM"),
        "rgba8" => Some("DXGI_FORMAT_R8G8B8A8_UNORM"),
        "bgra8" => Some("DXGI_FORMAT_B8G8R8A8_UNORM"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn display() -> DisplayCapabilities {
        DisplayCapabilities {
            platform: "windows".into(),
            output_supported: true,
            hdr_capable: true,
            hdr_enabled: true,
            hdr_state_verified: true,
            hdr_capability_verified: true,
            ..Default::default()
        }
    }

    #[test]
    fn hdr10_requires_enabled_verified_display_and_pq_2020_source() {
        let mut d = display();
        assert_eq!(
            WindowsOutputPolicy::select(Some("pq"), Some("bt.2020"), &d),
            (WindowsOutputPolicy::Hdr10, None)
        );
        d.hdr_enabled = false;
        assert_eq!(
            WindowsOutputPolicy::select(Some("pq"), Some("bt.2020"), &d)
                .1
                .as_deref(),
            Some("Windows HDR disabled")
        );
        d.hdr_capable = false;
        assert_eq!(
            WindowsOutputPolicy::select(Some("pq"), Some("bt.2020"), &d)
                .1
                .as_deref(),
            Some("The current display is not HDR capable")
        );
        d = display();
        d.hdr_state_verified = false;
        assert_eq!(
            WindowsOutputPolicy::select(Some("pq"), Some("bt.2020"), &d).0,
            WindowsOutputPolicy::Sdr
        );
        d = display();
        d.output_supported = false;
        assert_eq!(
            WindowsOutputPolicy::select(Some("pq"), Some("bt.2020"), &d).0,
            WindowsOutputPolicy::Sdr
        );
    }

    #[test]
    fn sdr_and_hlg_never_select_hdr_or_scrgb_on_hdr_desktop() {
        for (trc, prim) in [
            ("bt.1886", "bt.709"),
            ("hlg", "bt.2020"),
            ("pq", "display-p3"),
            ("linear", "bt.2020"),
        ] {
            assert_eq!(
                WindowsOutputPolicy::select(Some(trc), Some(prim), &display()).0,
                WindowsOutputPolicy::Sdr
            );
        }
    }

    #[test]
    fn requests_are_not_evidence_and_stale_target_cannot_keep_hdr_active() {
        assert!(!WindowsOutputPolicy::Hdr10.matches_target(None, None, None));
        assert!(!WindowsOutputPolicy::Hdr10.matches_target(
            Some("pq"),
            Some("bt.2020"),
            Some("rgba8")
        ));
        assert!(WindowsOutputPolicy::Hdr10.matches_target(
            Some("pq"),
            Some("bt.2020"),
            Some("rgb10a2")
        ));
        assert!(!WindowsOutputPolicy::Sdr.matches_target(
            Some("pq"),
            Some("bt.2020"),
            Some("rgb10a2")
        ));
        let mut d = display();
        d.hdr_enabled = false;
        assert_ne!(
            WindowsOutputPolicy::select(Some("pq"), Some("bt.2020"), &d).0,
            WindowsOutputPolicy::Hdr10
        );
    }

    #[test]
    fn option_order_never_leaves_wide_gamut_sdr_between_updates() {
        // libplacebo 7.351 maps wide-gamut non-PQ output to FP16. Change
        // primaries first when leaving HDR; transfer first when entering it.
        assert_eq!(
            WindowsOutputPolicy::Sdr.options()[0],
            ("target-prim", "bt.709")
        );
        assert_eq!(
            WindowsOutputPolicy::Hdr10.options()[0],
            ("target-trc", "pq")
        );
    }
}
