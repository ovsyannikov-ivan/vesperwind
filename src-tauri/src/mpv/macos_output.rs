//! Metal output policy and evidence checks. Requested options are not evidence.
use super::surface::DisplayCapabilities;

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn target(
    source_hdr: bool,
    display: &DisplayCapabilities,
) -> (&'static str, &'static str, f64) {
    if source_hdr && display.hdr_capable && display.hdr_enabled && display.current_headroom > 1.0 {
        // Pinned libplacebo's Vulkan WSI supports PQ/BT.2020. Its extended
        // linear sRGB mapping is incomplete; don't copy the OpenGL P3 policy.
        ("pq", "bt.2020", 203.0 * display.current_headroom)
    } else {
        // Gamma 2.2 hints prefer Adobe RGB over BT.709 in pinned Vulkan WSI
        // (transfer match outweighs primaries). sRGB selects the actual BT.709
        // surface, preserving SDR source color rather than only requesting it.
        ("srgb", "bt.709", 203.0)
    }
}

pub fn hdr_verified(
    source_hdr: bool,
    display: &DisplayCapabilities,
    vo: Option<&str>,
    context: Option<&str>,
    transfer: Option<&str>,
    primaries: Option<&str>,
) -> bool {
    source_hdr
        && vo == Some("gpu-next")
        && context == Some("macvk-embedded")
        && transfer == Some("pq")
        && primaries == Some("bt.2020")
        && matches!(display.metal_pixel_format, Some(90 | 94 | 115))
        && display.metal_color_space.as_deref() == Some("kCGColorSpaceITUR_2100_PQ")
        && display.metal_edr_enabled == Some(true)
        && display.output_supported
        && display.hdr_state_verified
        && display.hdr_enabled
        && display.current_headroom > 1.0
}

pub fn sdr_verified(
    display: &DisplayCapabilities,
    transfer: Option<&str>,
    primaries: Option<&str>,
) -> bool {
    // Pinned Vulkan WSI maps SRGB_NONLINEAR to pl_color_space_monitor:
    // the actual mpv transfer is gamma2.2 even when the hint was sRGB.
    transfer == Some("gamma2.2")
        && primaries == Some("bt.709")
        && display.metal_color_space.as_deref() == Some("kCGColorSpaceSRGB")
        && display.metal_edr_enabled == Some(false)
        && display.output_supported
}

#[cfg(test)]
mod tests {
    use super::*;
    fn display() -> DisplayCapabilities {
        DisplayCapabilities {
            hdr_capable: true,
            hdr_enabled: true,
            hdr_state_verified: true,
            output_supported: true,
            current_headroom: 2.0,
            metal_pixel_format: Some(115),
            metal_color_space: Some("kCGColorSpaceITUR_2100_PQ".into()),
            metal_edr_enabled: Some(true),
            ..Default::default()
        }
    }
    #[test]
    fn metal_hdr_requires_negotiated_target_and_actual_layer() {
        let d = display();
        let check = |d: &DisplayCapabilities, trc| {
            hdr_verified(
                true,
                d,
                Some("gpu-next"),
                Some("macvk-embedded"),
                trc,
                Some("bt.2020"),
            )
        };
        assert!(check(&d, Some("pq")));
        assert!(!check(&d, Some("gamma2.2")));
        assert!(!check(
            &DisplayCapabilities {
                metal_pixel_format: Some(80),
                ..d.clone()
            },
            Some("pq")
        ));
        assert!(!check(
            &DisplayCapabilities {
                metal_edr_enabled: Some(false),
                ..d.clone()
            },
            Some("pq")
        ));
        assert!(!check(
            &DisplayCapabilities {
                metal_color_space: None,
                ..d.clone()
            },
            Some("pq")
        ));
        assert!(!check(
            &DisplayCapabilities {
                current_headroom: 1.0,
                ..d
            },
            Some("pq")
        ));
    }
    #[test]
    fn sdr_requires_actual_srgb_layer_and_pinned_monitor_target() {
        let d = DisplayCapabilities {
            output_supported: true,
            metal_color_space: Some("kCGColorSpaceSRGB".into()),
            metal_edr_enabled: Some(false),
            ..Default::default()
        };
        assert!(sdr_verified(&d, Some("gamma2.2"), Some("bt.709")));
        assert!(!sdr_verified(&d, Some("gamma2.2"), Some("adobe")));
        assert!(!sdr_verified(
            &DisplayCapabilities {
                metal_edr_enabled: Some(true),
                ..d
            },
            Some("gamma2.2"),
            Some("bt.709")
        ));
    }

    #[test]
    fn sdr_and_display_moves_reset_the_hdr_policy() {
        let d = display();
        assert_eq!(target(true, &d), ("pq", "bt.2020", 406.0));
        assert_eq!(target(false, &d), ("srgb", "bt.709", 203.0));
        assert_eq!(
            target(
                true,
                &DisplayCapabilities {
                    hdr_enabled: false,
                    ..d
                }
            ),
            ("srgb", "bt.709", 203.0)
        );
    }
}
