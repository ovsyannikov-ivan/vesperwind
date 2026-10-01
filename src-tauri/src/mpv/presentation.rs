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
    #[cfg(target_os = "macos")]
    MacVk,
}

impl Backend {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::RenderApi => "libmpv OpenGL Render API (vo=libmpv/vo_gpu)",
            #[cfg(target_os = "windows")]
            Self::D3d11 => "libmpv-owned gpu-next / D3D11 / DXGI",
            #[cfg(target_os = "macos")]
            Self::MacVk => "libmpv-owned gpu-next / Vulkan / MoltenVK / Metal",
        }
    }
    pub(crate) fn owned(self) -> bool {
        self != Self::RenderApi
    }
    pub(crate) fn startup_error(self, message: &str) -> String {
        format!(
            "Owned video presentation initialization failed ({}): {message}",
            self.name()
        )
    }
}

pub(crate) enum Presentation {
    RenderApi(Renderer),
    #[cfg(any(target_os = "windows", target_os = "macos"))]
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
            #[cfg(target_os = "macos")]
            Backend::MacVk => Ok(Self::Embedded),
        }
    }

    pub(crate) fn presentation(&self) -> FramePresentation {
        match self {
            Self::RenderApi(renderer) => renderer.presentation(),
            // Public client API has no per-Present callback for an owned VO.
            // Do not fabricate frame counts from polling or resize events.
            #[cfg(any(target_os = "windows", target_os = "macos"))]
            Self::Embedded => FramePresentation::default(),
        }
    }

    pub(crate) fn stop(self) {
        match self {
            Self::RenderApi(renderer) => renderer.stop(),
            #[cfg(any(target_os = "windows", target_os = "macos"))]
            Self::Embedded => {}
        }
        // Embedded VO is stopped by mpv_terminate_destroy before the host drops.
    }
}
