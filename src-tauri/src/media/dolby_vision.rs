//! Dolby Vision source facts and their runtime interpretation.
//!
//! Vesperwind does not parse Dolby Vision bitstreams. Source facts come from
//! the pinned FFmpeg sidecar: the configuration record that FFmpeg's demuxer
//! exposes, and the first frame's RPU as FFmpeg's decoder parsed it. Runtime
//! facts (whether the RPU actually reshapes the picture) come from mpv. Every
//! field that has no evidence stays unknown instead of being derived from the
//! profile number.
use crate::{error::NativeError, media::thumbnail};
use serde::Serialize;
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, OnceLock},
};

const MAX_PROBE_LOG: usize = 128 * 1024;

/// `AVDOVIDecoderConfigurationRecord` as printed by FFmpeg's `av_dump_format`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationRecord {
    pub version_major: u8,
    pub version_minor: u8,
    pub profile: u8,
    pub level: u8,
    pub rpu_present: bool,
    pub el_present: bool,
    pub bl_present: bool,
    pub compatibility_id: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EnhancementLayerKind {
    None,
    Mel,
    Fel,
    Unknown,
}

/// Header and NLQ facts of the first decoded frame's `AVDOVIMetadata`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FirstFrameRpu {
    pub residual_disabled: bool,
    /// MEL/FEL as defined by the NLQ parameters (all-identity NLQ is MEL,
    /// the classification dovi_tool uses). Unknown when FFmpeg did not report
    /// complete linear-deadzone NLQ data, or when the residual is disabled.
    pub residual_kind: EnhancementLayerKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceProbe {
    pub configuration: Option<ConfigurationRecord>,
    pub first_frame: Option<FirstFrameRpu>,
}

/// Structured Dolby Vision state for one playing source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DolbyVisionDiagnostics {
    pub profile: Option<i64>,
    pub level: Option<i64>,
    /// `dv_bl_signal_compatibility_id`; never inferred from the profile.
    pub compatibility_id: Option<i64>,
    pub base_layer: String,
    /// The configuration record's `rpu_present_flag`.
    pub rpu_signalled: Option<bool>,
    /// An RPU was parsed from an actual frame (FFmpeg first frame or mpv).
    pub rpu_detected: Option<bool>,
    /// mpv mapped the RPU into a Dolby Vision frame representation and the
    /// libplacebo renderer that applies the reshaping is active.
    pub rpu_processing_active: Option<bool>,
    pub residual_disabled: Option<bool>,
    pub enhancement_layer_present: Option<bool>,
    pub enhancement_layer_kind: EnhancementLayerKind,
    /// The pinned mpv 0.41 has no enhancement-layer decode path.
    pub enhancement_layer_processing_active: bool,
    /// Vesperwind never negotiates Dolby Vision signalling with the display.
    pub system_output_active: bool,
    pub presentation: String,
    pub evidence: String,
}

/// Runtime facts read from mpv.
#[derive(Debug, Clone, Copy, Default)]
pub struct RuntimeFacts<'a> {
    pub profile: Option<i64>,
    pub level: Option<i64>,
    /// `video-params/colormatrix`; `None` until a frame was decoded.
    pub colormatrix: Option<&'a str>,
    pub current_vo: Option<&'a str>,
}

/// Probe state of the playing source, kept separate from "no metadata".
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase", tag = "state", content = "result")]
pub enum ProbeState {
    #[default]
    NotRun,
    Unavailable(String),
    Complete(SourceProbe),
}

pub fn summarize(runtime: RuntimeFacts, probe: &ProbeState) -> Option<DolbyVisionDiagnostics> {
    let source = match probe {
        ProbeState::Complete(source) => Some(source),
        _ => None,
    };
    let configuration = source.and_then(|s| s.configuration);
    let first_frame = source.and_then(|s| s.first_frame);
    let profile = runtime
        .profile
        .or(configuration.map(|c| i64::from(c.profile)));
    let mapped = runtime.colormatrix == Some("dolbyvision");
    if profile.is_none() && !mapped {
        return None;
    }
    let compatibility_id = configuration.map(|c| i64::from(c.compatibility_id));
    let rpu_detected = if mapped || first_frame.is_some() {
        Some(true)
    } else {
        None
    };
    let rpu_processing_active = match runtime.colormatrix {
        Some(_) if mapped => Some(runtime.current_vo == Some("gpu-next")),
        Some(_) => Some(false),
        None => None,
    };
    let enhancement_layer_present = configuration.map(|c| c.el_present);
    let enhancement_layer_kind = match enhancement_layer_present {
        Some(false) => EnhancementLayerKind::None,
        Some(true) => first_frame
            .map(|frame| frame.residual_kind)
            .unwrap_or(EnhancementLayerKind::Unknown),
        None => EnhancementLayerKind::Unknown,
    };
    let base_layer = base_layer(compatibility_id, profile);
    let presentation = presentation(
        rpu_processing_active,
        mapped,
        compatibility_id,
        profile,
        enhancement_layer_kind,
    );
    let evidence = match probe {
        ProbeState::Complete(_) => {
            "FFmpeg 8.0 configuration record and first-frame RPU; mpv video-params and current-vo"
        }
        ProbeState::Unavailable(_) => {
            "mpv track and video-params only (FFmpeg source probe unavailable)"
        }
        ProbeState::NotRun => "mpv track and video-params only",
    };
    Some(DolbyVisionDiagnostics {
        profile,
        level: runtime.level.or(configuration.map(|c| i64::from(c.level))),
        compatibility_id,
        base_layer,
        rpu_signalled: configuration.map(|c| c.rpu_present),
        rpu_detected,
        rpu_processing_active,
        residual_disabled: first_frame.map(|frame| frame.residual_disabled),
        enhancement_layer_present,
        enhancement_layer_kind,
        enhancement_layer_processing_active: false,
        system_output_active: false,
        presentation,
        evidence: match probe {
            ProbeState::Unavailable(reason) => format!("{evidence}: {reason}"),
            _ => evidence.into(),
        },
    })
}

fn base_layer(compatibility_id: Option<i64>, profile: Option<i64>) -> String {
    match compatibility_id {
        Some(0) => "none (not backward compatible)".into(),
        Some(1) => "HDR10 (PQ, BT.2020)".into(),
        Some(2) => "SDR (BT.709)".into(),
        Some(4) => "HLG (BT.2100)".into(),
        Some(6) => "Ultra HD Blu-ray HDR10".into(),
        Some(id) => format!("compatibility id {id}"),
        // Profile 5 has no backward-compatible base layer by definition; other
        // profiles do not determine their compatibility id.
        None if profile == Some(5) => "none (profile 5)".into(),
        None => "unknown".into(),
    }
}

fn presentation(
    processing: Option<bool>,
    mapped: bool,
    compatibility_id: Option<i64>,
    profile: Option<i64>,
    enhancement_layer: EnhancementLayerKind,
) -> String {
    let no_base_layer = compatibility_id == Some(0) || profile == Some(5);
    match processing {
        None => "not observed yet".into(),
        Some(true) => {
            let mut text = "Dolby Vision RPU reshaping by libplacebo; output follows the HDR/SDR target below".to_string();
            if matches!(enhancement_layer, EnhancementLayerKind::Mel | EnhancementLayerKind::Fel) {
                text.push_str("; enhancement layer not decoded");
            }
            text
        }
        // The legacy OpenGL renderer decodes the mapped frame as BT.2020 YCbCr.
        Some(false) if mapped && no_base_layer => {
            "Dolby Vision frame representation without the libplacebo renderer; profile 5 colors are incorrect without reshaping".into()
        }
        Some(false) if mapped => {
            "Dolby Vision frame representation without the libplacebo renderer; reshaping is not applied".into()
        }
        Some(false) if no_base_layer => {
            "RPU not applied; profile 5 colors are incorrect without reshaping".into()
        }
        Some(false) => "base layer only; Dolby Vision RPU not applied".into(),
    }
}

/// Configuration record of the first video stream in FFmpeg's `-i` dump.
pub fn parse_configuration_record(stream_log: &str) -> Option<ConfigurationRecord> {
    let line = stream_log
        .lines()
        .find_map(|line| line.split_once("DOVI configuration record:"))?
        .1;
    let field = |name: &str| -> Option<u8> {
        line.split(',').find_map(|part| {
            let (key, value) = part.split_once(':')?;
            (key.trim() == name).then(|| value.trim().parse().ok())?
        })
    };
    let (major, minor) = line
        .split(',')
        .find_map(|part| part.trim().strip_prefix("version:"))?
        .trim()
        .split_once('.')?;
    Some(ConfigurationRecord {
        version_major: major.parse().ok()?,
        version_minor: minor.parse().ok()?,
        profile: field("profile")?,
        level: field("level")?,
        rpu_present: field("rpu flag")? == 1,
        el_present: field("el flag")? == 1,
        bl_present: field("bl flag")? == 1,
        compatibility_id: field("compatibility id")?,
    })
}

/// First `AVDOVIMetadata` printed by FFmpeg's `showinfo` filter.
pub fn parse_first_frame(showinfo_log: &str) -> Option<FirstFrameRpu> {
    let start = showinfo_log.find("Dolby Vision Metadata:")?;
    let block = &showinfo_log[start..];
    let block = &block[..block.find("color metadata:").unwrap_or(block.len())];
    let values = |name: &str| -> Vec<i64> {
        let key = format!("{name}=");
        block
            .match_indices(&key)
            .filter(|(index, _)| {
                // `vdr_in_max` must not match inside another identifier.
                !block[..*index]
                    .chars()
                    .last()
                    .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
            })
            .filter_map(|(index, _)| {
                let rest = &block[index + key.len()..];
                let end = rest
                    .find(|c: char| !(c.is_ascii_digit() || c == '-'))
                    .unwrap_or(rest.len());
                rest[..end].parse().ok()
            })
            .collect()
    };
    let residual_disabled = *values("disable_residual_flag").first()? == 1;
    let residual_kind = if residual_disabled {
        EnhancementLayerKind::Unknown
    } else {
        classify_nlq(
            values("nlq_method_idc").first().copied(),
            values("coef_data_type").first().copied(),
            values("coef_log2_denom").first().copied(),
            &values("nlq_offset"),
            &values("vdr_in_max"),
            &values("linear_deadzone_slope"),
            &values("linear_deadzone_threshold"),
        )
    };
    Some(FirstFrameRpu {
        residual_disabled,
        residual_kind,
    })
}

fn classify_nlq(
    method: Option<i64>,
    coef_data_type: Option<i64>,
    log2_denom: Option<i64>,
    offset: &[i64],
    vdr_in_max: &[i64],
    slope: &[i64],
    threshold: &[i64],
) -> EnhancementLayerKind {
    // Only fixed-point linear-deadzone NLQ for all three components is
    // classified; anything else stays unknown.
    let (Some(0), Some(0), Some(denom @ 0..=62)) = (method, coef_data_type, log2_denom) else {
        return EnhancementLayerKind::Unknown;
    };
    if [offset, vdr_in_max, slope, threshold]
        .iter()
        .any(|values| values.len() != 3)
    {
        return EnhancementLayerKind::Unknown;
    }
    let one = 1_i64 << denom;
    let identity = offset.iter().all(|v| *v == 0)
        && vdr_in_max.iter().all(|v| *v == one)
        && slope.iter().all(|v| *v == 0)
        && threshold.iter().all(|v| *v == 0);
    if identity {
        EnhancementLayerKind::Mel
    } else {
        EnhancementLayerKind::Fel
    }
}

fn verified_sidecar() -> Option<&'static PathBuf> {
    static SIDECAR: OnceLock<Option<PathBuf>> = OnceLock::new();
    SIDECAR
        .get_or_init(|| {
            let binary = thumbnail::bundled_binary()?;
            let version = thumbnail::run_cancelled(
                &binary,
                &["-version".into()],
                MAX_PROBE_LOG,
                &AtomicBool::new(false),
            )
            .ok()?;
            (version.success
                && thumbnail::is_pinned_version(&String::from_utf8_lossy(&version.stdout)))
            .then_some(binary)
        })
        .as_ref()
}

/// Reads the configuration record and the first frame's RPU of a local file.
/// Decodes at most two frames of the first video stream; no output is written.
pub fn probe(path: &Path, cancel: &AtomicBool) -> ProbeState {
    let Some(binary) = verified_sidecar() else {
        return ProbeState::Unavailable("pinned FFmpeg sidecar unavailable".into());
    };
    let args: Vec<OsString> = [
        "-hide_banner",
        "-nostdin",
        "-protocol_whitelist",
        "file,pipe",
        "-i",
    ]
    .iter()
    .map(OsString::from)
    .chain([path.as_os_str().to_owned()])
    .chain(
        [
            "-map",
            "0:V:0",
            "-an",
            "-sn",
            "-dn",
            "-frames:v",
            "1",
            "-vf",
            "showinfo",
            "-f",
            "null",
            "-",
        ]
        .iter()
        .map(OsString::from),
    )
    .collect();
    match thumbnail::run_cancelled(binary, &args, MAX_PROBE_LOG, cancel) {
        Ok(output) => {
            let log = String::from_utf8_lossy(&output.stderr);
            let stream = thumbnail::first_video_stream(&log);
            ProbeState::Complete(SourceProbe {
                configuration: parse_configuration_record(&stream),
                first_frame: parse_first_frame(&log),
            })
        }
        Err(error) => ProbeState::Unavailable(error_reason(&error)),
    }
}

fn error_reason(error: &NativeError) -> String {
    format!("FFmpeg source probe failed ({})", error.code)
}

#[cfg(test)]
mod tests {
    use super::*;

    const P81_HEADER: &str = "  Stream #0:0(eng): Video: hevc (Main 10), yuv420p10le(tv, bt2020nc/bt2020/smpte2084), 3840x2160\n    Side data:\n      DOVI configuration record: version: 1.0, profile: 8, level: 6, rpu flag: 1, el flag: 0, bl flag: 1, compatibility id: 1, compression: 0";
    const P8_FRAME: &str = "[Parsed_showinfo_0 @ 0x1]   side data - Dolby Vision Metadata:     rpu_type=2; rpu_format=18; vdr_rpu_profile=1; vdr_rpu_level=0; chroma_resampling_explicit_filter_flag=0; coef_data_type=0; coef_log2_denom=23; vdr_rpu_normalized_idc=1; bl_video_full_range_flag=0; bl_bit_depth=10; el_bit_depth=10; vdr_bit_depth=12; spatial_resampling_filter_flag=0; el_spatial_resampling_filter_flag=0; disable_residual_flag=1\n[Parsed_showinfo_0 @ 0x1]     data mapping: vdr_rpu_id=0; mapping_color_space=0; mapping_chroma_format_idc=0; nlq_method_idc=-1; num_x_partitions=1; num_y_partitions=1\n[Parsed_showinfo_0 @ 0x1]       channel 0: pivots={ 0 1023 }; nlq_offset=0; vdr_in_max=0;\n[Parsed_showinfo_0 @ 0x1]     color metadata: dm_metadata_id=0";

    fn p7_frame(offset: u16, vdr_in_max: u64, slope: u64) -> String {
        let channel = |c| {
            format!("      channel {c}: pivots={{ 0 1023 }}; nlq_offset={offset}; vdr_in_max={vdr_in_max}; linear_deadzone_slope={slope}; linear_deadzone_threshold=0\n")
        };
        format!(
            "side data - Dolby Vision Metadata:     rpu_type=2; coef_data_type=0; coef_log2_denom=23; el_bit_depth=10; disable_residual_flag=0\n    data mapping: nlq_method_idc=0; num_x_partitions=1\n{}{}{}    color metadata: dm_metadata_id=0\n",
            channel(0),
            channel(1),
            channel(2)
        )
    }

    fn p7_header(compatibility_id: u8) -> String {
        format!("DOVI configuration record: version: 1.0, profile: 7, level: 6, rpu flag: 1, el flag: 1, bl flag: 1, compatibility id: {compatibility_id}, compression: 0")
    }

    fn complete(header: &str, frame: &str) -> ProbeState {
        ProbeState::Complete(SourceProbe {
            configuration: parse_configuration_record(header),
            first_frame: parse_first_frame(frame),
        })
    }

    fn runtime<'a>(profile: i64, matrix: Option<&'a str>, vo: &'a str) -> RuntimeFacts<'a> {
        RuntimeFacts {
            profile: Some(profile),
            level: Some(6),
            colormatrix: matrix,
            current_vo: Some(vo),
        }
    }

    #[test]
    fn parses_ffmpeg_configuration_record_with_compatibility_id() {
        let record = parse_configuration_record(P81_HEADER).unwrap();
        assert_eq!(
            record,
            ConfigurationRecord {
                version_major: 1,
                version_minor: 0,
                profile: 8,
                level: 6,
                rpu_present: true,
                el_present: false,
                bl_present: true,
                compatibility_id: 1,
            }
        );
        assert_eq!(
            parse_configuration_record("Video: hevc, bt2020nc/bt2020/smpte2084"),
            None
        );
        assert_eq!(
            parse_configuration_record("DOVI configuration record: profile: 8"),
            None
        );
    }

    #[test]
    fn profile_8_1_with_active_reshaping() {
        let probe = complete(P81_HEADER, P8_FRAME);
        let dv = summarize(runtime(8, Some("dolbyvision"), "gpu-next"), &probe).unwrap();
        assert_eq!(dv.compatibility_id, Some(1));
        assert_eq!(dv.base_layer, "HDR10 (PQ, BT.2020)");
        assert_eq!(dv.rpu_detected, Some(true));
        assert_eq!(dv.rpu_processing_active, Some(true));
        assert_eq!(dv.residual_disabled, Some(true));
        assert_eq!(dv.enhancement_layer_present, Some(false));
        assert_eq!(dv.enhancement_layer_kind, EnhancementLayerKind::None);
        assert!(!dv.enhancement_layer_processing_active);
        assert!(!dv.system_output_active);
        assert!(dv.presentation.contains("RPU reshaping"));
    }

    #[test]
    fn hdr10_fallback_is_not_labelled_as_dolby_vision_processing() {
        let probe = complete(P81_HEADER, P8_FRAME);
        let dv = summarize(runtime(8, Some("bt.2020-ncl"), "gpu-next"), &probe).unwrap();
        assert_eq!(dv.rpu_processing_active, Some(false));
        assert_eq!(
            dv.presentation,
            "base layer only; Dolby Vision RPU not applied"
        );
        // A Dolby Vision frame representation without gpu-next is not reshaped.
        let dv = summarize(runtime(8, Some("dolbyvision"), "libmpv"), &probe).unwrap();
        assert_eq!(dv.rpu_processing_active, Some(false));
        assert!(dv.presentation.contains("reshaping is not applied"));
    }

    #[test]
    fn profile_number_alone_implies_no_rpu_compatibility_or_layers() {
        let dv = summarize(runtime(8, None, "gpu-next"), &ProbeState::NotRun).unwrap();
        assert_eq!(dv.compatibility_id, None);
        assert_eq!(dv.base_layer, "unknown");
        assert_eq!(dv.rpu_signalled, None);
        assert_eq!(dv.rpu_detected, None);
        assert_eq!(dv.rpu_processing_active, None);
        assert_eq!(dv.enhancement_layer_present, None);
        assert_eq!(dv.enhancement_layer_kind, EnhancementLayerKind::Unknown);
        assert_eq!(dv.presentation, "not observed yet");
        let unavailable = ProbeState::Unavailable("remote source".into());
        let dv = summarize(runtime(7, Some("bt.2020-ncl"), "gpu-next"), &unavailable).unwrap();
        assert_eq!(dv.enhancement_layer_kind, EnhancementLayerKind::Unknown);
        assert!(dv.evidence.contains("remote source"));
        assert!(summarize(RuntimeFacts::default(), &ProbeState::NotRun).is_none());
    }

    #[test]
    fn profile_5_is_reshaped_or_explicitly_incorrect() {
        let header = "DOVI configuration record: version: 1.0, profile: 5, level: 6, rpu flag: 1, el flag: 0, bl flag: 1, compatibility id: 0, compression: 0";
        let probe = complete(header, P8_FRAME);
        let active = summarize(runtime(5, Some("dolbyvision"), "gpu-next"), &probe).unwrap();
        assert_eq!(active.rpu_processing_active, Some(true));
        assert_eq!(active.base_layer, "none (not backward compatible)");
        let inactive = summarize(runtime(5, Some("bt.2020-ncl"), "gpu-next"), &probe).unwrap();
        assert_eq!(inactive.rpu_processing_active, Some(false));
        assert!(inactive
            .presentation
            .contains("profile 5 colors are incorrect"));
        let legacy = summarize(runtime(5, Some("dolbyvision"), "libmpv"), &probe).unwrap();
        assert_eq!(legacy.rpu_processing_active, Some(false));
        assert!(legacy
            .presentation
            .contains("profile 5 colors are incorrect"));
        let unprobed = summarize(runtime(5, None, "gpu-next"), &ProbeState::NotRun).unwrap();
        assert_eq!(unprobed.base_layer, "none (profile 5)");
    }

    #[test]
    fn profile_7_distinguishes_mel_fel_and_unknown_without_claiming_reconstruction() {
        let one = 1_u64 << 23;
        let mel = complete(&p7_header(6), &p7_frame(0, one, 0));
        let fel = complete(&p7_header(6), &p7_frame(512, one * 3, 2048));
        for (probe, kind) in [
            (mel, EnhancementLayerKind::Mel),
            (fel, EnhancementLayerKind::Fel),
        ] {
            // mpv 0.41 maps only residual-disabled RPUs: P7 plays the base layer.
            let dv = summarize(runtime(7, Some("bt.2020-ncl"), "gpu-next"), &probe).unwrap();
            assert_eq!(dv.enhancement_layer_present, Some(true));
            assert_eq!(dv.enhancement_layer_kind, kind);
            assert_eq!(dv.residual_disabled, Some(false));
            assert_eq!(dv.rpu_detected, Some(true));
            assert_eq!(dv.rpu_processing_active, Some(false));
            assert!(!dv.enhancement_layer_processing_active);
            assert_eq!(dv.base_layer, "Ultra HD Blu-ray HDR10");
        }
        // EL present but no decoded RPU: never guess MEL or FEL.
        let header_only = complete(&p7_header(6), "");
        let dv = summarize(runtime(7, None, "gpu-next"), &header_only).unwrap();
        assert_eq!(dv.enhancement_layer_kind, EnhancementLayerKind::Unknown);
        assert_eq!(dv.rpu_detected, None);
        assert_eq!(dv.rpu_signalled, Some(true));
    }

    #[test]
    fn incomplete_or_non_linear_nlq_stays_unknown() {
        let one = 1_i64 << 23;
        let zeros = [0, 0, 0];
        let ones = [one, one, one];
        assert_eq!(
            classify_nlq(Some(0), Some(0), Some(23), &zeros, &ones, &zeros, &zeros),
            EnhancementLayerKind::Mel
        );
        assert_eq!(
            classify_nlq(Some(0), Some(1), Some(23), &zeros, &ones, &zeros, &zeros),
            EnhancementLayerKind::Unknown
        );
        assert_eq!(
            classify_nlq(
                Some(0),
                Some(0),
                Some(23),
                &zeros[..2],
                &ones,
                &zeros,
                &zeros
            ),
            EnhancementLayerKind::Unknown
        );
        assert_eq!(
            classify_nlq(Some(-1), Some(0), Some(23), &zeros, &ones, &zeros, &zeros),
            EnhancementLayerKind::Unknown
        );
        assert_eq!(parse_first_frame("no metadata"), None);
    }

    // Copyrighted samples stay outside the repository; point this at one.
    #[test]
    fn probes_a_local_sample_when_provided() {
        let Some(path) = std::env::var_os("VESPERWIND_DOVI_SAMPLE") else {
            return;
        };
        let probe = probe(Path::new(&path), &AtomicBool::new(false));
        eprintln!("{probe:?}");
        let ProbeState::Complete(source) = probe else {
            panic!("probe failed: {probe:?}");
        };
        assert!(source.configuration.is_some());
        assert!(source.first_frame.is_some());
    }

    #[test]
    fn serializes_structured_capability_model() {
        let probe = complete(P81_HEADER, P8_FRAME);
        let dv = summarize(runtime(8, Some("dolbyvision"), "gpu-next"), &probe).unwrap();
        let json = serde_json::to_value(&dv).unwrap();
        for key in [
            "profile",
            "level",
            "compatibilityId",
            "rpuDetected",
            "rpuProcessingActive",
            "enhancementLayerPresent",
            "enhancementLayerKind",
            "enhancementLayerProcessingActive",
            "systemOutputActive",
        ] {
            assert!(json.get(key).is_some(), "{key}");
        }
        assert_eq!(json["enhancementLayerKind"], "none");
        assert_eq!(json["systemOutputActive"], false);
    }
}
