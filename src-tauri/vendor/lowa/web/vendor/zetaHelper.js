var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
const _ZetaHelperMain = class _ZetaHelperMain {
  /**
   * Use absolute URLs or URLs relative to the root HTML document (location.href).
   * @param threadJs - URL for JS code file running inside the office thread (web worker).
   * @param options.threadJsType - 'classic' or 'module' (ES2015)
   *   see: https://developer.mozilla.org/docs/Web/API/Worker/Worker#type
   * @param options.wasmPkg - Which WASM binaries to use. Possible options:
   *   'free', 'business', 'url:YOUR_CUSTOM_URL'
   * @param options.blockPageScroll - Don't scroll the HTML page while the cursor is above
   *   the canvas. (default: true)
   */
  constructor(threadJs, options) {
    __publicField(this, "canvas");
    __publicField(this, "Module");
    __publicField(this, "threadJs");
    __publicField(this, "threadJsType", "classic");
    __publicField(this, "soffice_base_url");
    /** zetajs thread communication */
    __publicField(this, "thrPort");
    /** Emscripten Unix like virtual file system */
    __publicField(this, "FS");
    const canvas = document.getElementById("qtcanvas");
    const thisFileUrl = import.meta.url;
    const modUrlDir = thisFileUrl.substring(0, thisFileUrl.length - "zetaHelper.js".length);
    if (threadJs) threadJs = new URL(threadJs, location.href).toString();
    const zetajsScript = modUrlDir + "zeta.js";
    const threadWrapScript = 'data:text/javascript;charset=UTF-8,import("' + import.meta.url + '").then(m => {m.zetaHelperWrapThread();});';
    const wasmPkg = options.wasmPkg || "free";
    let soffice_base_url = _ZetaHelperMain.wasmUrls[wasmPkg] || _ZetaHelperMain.wasmUrls["free"];
    if (wasmPkg?.substring(0, 4) === "url:") soffice_base_url = wasmPkg.substring(4, wasmPkg.length);
    if (soffice_base_url === "") soffice_base_url = "./";
    soffice_base_url = new URL(soffice_base_url, location.href).toString();
    const Module = {
      canvas,
      uno_scripts: [zetajsScript, threadWrapScript],
      locateFile: (path, prefix) => {
        return (prefix || soffice_base_url) + path;
      },
      modUrlDir
    };
    Module.mainScriptUrlOrBlob = new Blob(
      ["importScripts('" + new URL("soffice.js", soffice_base_url) + "');"],
      { type: "text/javascript" }
    );
    let lastDevicePixelRatio = window.devicePixelRatio;
    addEventListener("resize", () => {
      setTimeout(() => {
        if (lastDevicePixelRatio != -1) {
          if (lastDevicePixelRatio != window.devicePixelRatio) {
            lastDevicePixelRatio = -1;
            this.widthPxAdd(canvas.style, 1);
            window.dispatchEvent(new Event("resize"));
          }
        } else {
          lastDevicePixelRatio = window.devicePixelRatio;
          this.widthPxAdd(canvas.style, -1);
          window.dispatchEvent(new Event("resize"));
        }
      }, 100);
    });
    if (options.blockPageScroll != false)
      canvas.addEventListener("wheel", (event) => {
        event.preventDefault();
      }, { passive: false });
    window.Module = Module;
    this.canvas = canvas;
    this.Module = Module;
    this.threadJs = threadJs?.toString() || null;
    if (options.threadJsType === "module") this.threadJsType = "module";
    this.soffice_base_url = soffice_base_url;
  }
  start(app_init) {
    const zHM = this;
    const soffice_js = document.createElement("script");
    soffice_js.src = zHM.soffice_base_url + "soffice.js";
    soffice_js.onload = () => {
      console.log("zetaHelper: Configuring Module");
      zHM.Module.uno_main.then((pThrPort) => {
        zHM.thrPort = pThrPort;
        zHM.FS = window.FS;
        zHM.thrPort.onmessage = (e) => {
          switch (e.data.cmd) {
            case "ZetaHelper::thr_started":
              window.dispatchEvent(new Event("resize"));
              zHM.thrPort.postMessage({
                cmd: "ZetaHelper::run_thr_script",
                threadJs: zHM.threadJs,
                threadJsType: zHM.threadJsType
              });
              app_init();
              break;
            default:
              throw Error("Unknown message command: " + e.data.cmd);
          }
          ;
        };
      });
    };
    console.log("zetaHelper: Loading WASM binaries for ZetaJS from: " + zHM.soffice_base_url);
    document.body.appendChild(soffice_js);
  }
  widthPxAdd(obj, value) {
    if (/\A\d+px\z/.test(obj.width)) {
      obj.width = parseInt(obj.width) + value + "px";
    }
  }
};
__publicField(_ZetaHelperMain, "wasmUrls", {
  free: "",
  business: ""
});
let ZetaHelperMain = _ZetaHelperMain;
function zetaHelperWrapThread() {
  const zJsModule = globalThis.Module;
  zJsModule.zetajs.then((zetajs) => {
    const port = zetajs.mainPort;
    port.onmessage = (e) => {
      switch (e.data.cmd) {
        case "ZetaHelper::run_thr_script":
          port.onmessage = null;
          globalThis.zetajsStore = { zetajs, zJsModule };
          let threadJs = e.data.threadJs;
          if (threadJs) {
            if (e.data.threadJsType === "module") {
              console.log("zetaHelper: Loading threadJs as module from: " + threadJs);
              import(threadJs).then((module) => {
                globalThis.zetajsStore.threadJsContext = module;
              });
            } else {
              console.log("zetaHelper: Loading threadJs as script from: " + threadJs);
              importScripts(threadJs);
            }
          } else {
            console.log("zetaHelper: Office loaded. No threadJs given.");
          }
          break;
        default:
          throw Error("Unknown message command: " + e.data.cmd);
      }
      ;
    };
    port.postMessage({
      cmd: "ZetaHelper::thr_started"
    });
  });
}
class ZetaHelperThread {
  constructor() {
    __publicField(this, "config");
    __publicField(this, "context");
    /** com.sun.star */
    __publicField(this, "css");
    __publicField(this, "desktop");
    __publicField(this, "thrPort");
    __publicField(this, "zetajs");
    __publicField(this, "zJsModule");
    this.zetajs = globalThis.zetajsStore.zetajs;
    this.zJsModule = globalThis.zetajsStore.zJsModule;
    this.thrPort = this.zetajs.mainPort;
    this.css = this.zetajs.uno.com.sun.star;
    this.context = this.zetajs.getUnoComponentContext();
    this.desktop = this.css.frame.Desktop.create(this.context);
    this.config = this.css.configuration.ReadWriteAccess.create(this.context, "en-US");
  }
  /**
   * Turn off toolbars.
   * @param officeModules - ["Base", "Calc", "Draw", "Impress", "Math", "Writer"];
   */
  configDisableToolbars(officeModules) {
    for (const mod of officeModules) {
      const modName = "/org.openoffice.Office.UI." + mod + "WindowState/UIElements/States";
      const uielems = this.config.getByHierarchicalName(modName);
      for (const i of uielems.getElementNames()) {
        if (i.startsWith("private:resource/toolbar/")) {
          const uielem = uielems.getByName(i);
          if (uielem.getByName("Visible")) {
            uielem.setPropertyValue("Visible", false);
          }
        }
      }
    }
    this.config.commitChanges();
  }
  /**
   * @param unoUrl - string following ".uno:" (e.g. "Bold")
   */
  transformUrl(unoUrl) {
    const ioparam = { val: new this.css.util.URL({ Complete: ".uno:" + unoUrl }) };
    this.css.util.URLTransformer.create(this.context).parseStrict(ioparam);
    return ioparam.val;
  }
  queryDispatch(ctrl, urlObj) {
    return ctrl.queryDispatch(urlObj, "_self", 0);
  }
  dispatch(ctrl, unoUrl, params = []) {
    const urlObj = this.transformUrl(unoUrl);
    this.queryDispatch(ctrl, urlObj).dispatch(urlObj, params);
  }
}
export {
  ZetaHelperMain,
  ZetaHelperThread,
  zetaHelperWrapThread
};
