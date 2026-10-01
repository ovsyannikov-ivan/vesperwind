use super::{
    render::{FramePresentation, Renderer},
    surface::NativeSurface,
    MpvApi, MpvHandle,
};
use std::sync::Arc;

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum Backend {
    RenderApi,
    #[cfg(target_os = "windows")]
    D3d11,
}

impl Backend {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::RenderApi => "libmpv OpenGL Render API (vo=libmpv/vo_gpu)",
            #[cfg(target_os = "windows")]
            Self::D3d11 => "libmpv-owned gpu-next / D3D11 (SDR)",
        }
    }
}

pub(crate) enum Presentation {
    RenderApi(Renderer),
    #[cfg(target_os = "windows")]
    Embedded,
}

impl Presentation {
    pub(crate) fn start(
        api: Arc<MpvApi>,
        handle: *mut MpvHandle,
        surface: NativeSurface,
        session: &str,
        backend: Backend,
    ) -> Result<Self, String> {
        match backend {
            Backend::RenderApi => {
                Renderer::start(api, handle, surface, session).map(Self::RenderApi)
            }
            #[cfg(target_os = "windows")]
            Backend::D3d11 => Ok(Self::Embedded),
        }
    }

    pub(crate) fn presentation(&self) -> FramePresentation {
        match self {
            Self::RenderApi(renderer) => renderer.presentation(),
            // Public client API has no per-Present callback for an owned VO.
            // Do not fabricate frame counts from polling or resize events.
            #[cfg(target_os = "windows")]
            Self::Embedded => FramePresentation::default(),
        }
    }

    pub(crate) fn stop(self) {
        match self {
            Self::RenderApi(renderer) => renderer.stop(),
            #[cfg(target_os = "windows")]
            Self::Embedded => {}
        }
        // Embedded VO is stopped by mpv_terminate_destroy before the host drops.
    }
}
