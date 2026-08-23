(function () {
  "use strict";

  const MINIMUM_RENDER_ROWS = 2;

  class VirtualWebglAddon {
    constructor(options = {}) {
      this._getRenderRows = typeof options.getRenderRows === "function" ? options.getRenderRows : () => 64;
      this._contextLossListeners = new Set();
      this._logicalRowOffset = 0;
      this._physicalRows = MINIMUM_RENDER_ROWS;
      this._pendingLogicalRowOffset = null;
      this._renderFrame = 0;
      this._renderCount = 0;
      this._resizeCount = 0;
      this._disposed = false;
    }

    onContextLoss(listener) {
      this._contextLossListeners.add(listener);
      return { dispose: () => this._contextLossListeners.delete(listener) };
    }

    activate(terminal) {
      if (this._terminal) throw new Error("VirtualWebglAddon is already active");
      const WebglAddon = window.WebglAddon?.WebglAddon;
      if (!WebglAddon) throw new Error("WebGL addon is unavailable");
      this._terminal = terminal;
      this._physicalRows = this._resolvePhysicalRows();
      this._webglAddon = new WebglAddon();
      this._contextLossDisposable = this._webglAddon.onContextLoss(() => {
        for (const listener of this._contextLossListeners) listener();
      });
      this._activateWebglAddonAtPhysicalHeight();
      this._renderer = this._webglAddon._renderer;
      if (!this._renderer?._glyphRenderer?.value || !this._renderer?._rectangleRenderer?.value) {
        this._webglAddon.dispose();
        throw new Error("Unsupported WebGL addon internals");
      }
      this._installVirtualRendererWindow();
    }

    _activateWebglAddonAtPhysicalHeight() {
      const existingRowsDescriptor = Object.getOwnPropertyDescriptor(this._terminal, "rows");
      const bufferService = this._terminal?._core?._bufferService;
      const existingBufferRowsDescriptor = bufferService ? Object.getOwnPropertyDescriptor(bufferService, "rows") : null;
      Object.defineProperty(this._terminal, "rows", { configurable: true, get: () => this._physicalRows });
      if (bufferService) Object.defineProperty(bufferService, "rows", { configurable: true, writable: true, value: this._physicalRows });
      try {
        this._webglAddon.activate(this._terminal);
      } finally {
        if (bufferService && existingBufferRowsDescriptor) Object.defineProperty(bufferService, "rows", existingBufferRowsDescriptor);
        if (existingRowsDescriptor) Object.defineProperty(this._terminal, "rows", existingRowsDescriptor);
        else delete this._terminal.rows;
      }
    }

    _installVirtualRendererWindow() {
      const terminal = this._terminal;
      const renderer = this._renderer;
      const realBuffer = terminal.buffer;
      const realActiveBuffer = realBuffer.active;
      this._activeBufferProxy = new Proxy(realActiveBuffer, {
        get: (target, property) => {
          if (property === "viewportY" || property === "ydisp") return Number(Reflect.get(target, property, target) || 0) + this._logicalRowOffset;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      this._bufferProxy = new Proxy(realBuffer, {
        get: (target, property) => {
          if (property === "ydisp") return Number(target.ydisp || 0) + this._logicalRowOffset;
          if (property === "active") return this._activeBufferProxy;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      this._rendererTerminal = new Proxy(terminal, {
        get: (target, property) => {
          if (property === "rows") return this._physicalRows;
          if (property === "buffer") return this._bufferProxy;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const realCore = renderer._core;
      const realCoreBuffer = realCore.buffer;
      const realCoreBuffers = realCore.buffers;
      this._coreBufferProxy = new Proxy(realCoreBuffer, {
        get: (target, property) => {
          if (property === "ydisp" || property === "viewportY") return Number(Reflect.get(target, property, target) || 0) + this._logicalRowOffset;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      this._coreBuffersProxy = new Proxy(realCoreBuffers, {
        get: (target, property) => {
          if (property === "active") return this._coreBufferProxy;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      this._rendererCore = new Proxy(realCore, {
        get: (target, property) => {
          if (property === "rows") return this._physicalRows;
          if (property === "buffer") return this._coreBufferProxy;
          if (property === "buffers") return this._coreBuffersProxy;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      this._originalRendererTerminal = renderer._terminal;
      this._originalRendererCore = renderer._core;
      this._originalGlyphRendererTerminal = renderer._glyphRenderer.value._terminal;
      this._originalRectangleRendererTerminal = renderer._rectangleRenderer.value._terminal;
      this._originalCellColorResolverTerminal = renderer._cellColorResolver?._terminal;
      renderer._terminal = this._rendererTerminal;
      renderer._core = this._rendererCore;
      renderer._glyphRenderer.value._terminal = this._rendererTerminal;
      renderer._rectangleRenderer.value._terminal = this._rendererTerminal;
      if (renderer._cellColorResolver) renderer._cellColorResolver._terminal = this._rendererTerminal;
      this._originalRenderRows = renderer.renderRows;
      this._originalHandleResize = renderer.handleResize;
      this._originalRequestRedrawViewport = renderer._requestRedrawViewport;
      renderer.renderRows = (start, end) => this._renderLogicalRows(start, end);
      renderer.handleResize = (cols, rows) => this._handleLogicalResize(cols, rows);
      renderer._requestRedrawViewport = () => renderer._onRequestRedraw.fire({
        start: this._logicalRowOffset,
        end: this._logicalRowOffset + this._physicalRows - 1,
      });
      this._patchLinkRenderLayers();
      this._patchMouseCoordinateServices();
      this._originalHandleResize.call(renderer, terminal.cols, this._physicalRows);
      this._applyVirtualCanvasGeometry();
      this.refreshVisibleRows();
    }

    _patchLinkRenderLayers() {
      this._linkRenderLayerRestorations = [];
      for (const layer of this._renderer._renderLayers || []) {
        if (typeof layer._handleShowLinkUnderline !== "function") continue;
        const originalShowLinkUnderline = layer._handleShowLinkUnderline;
        layer._handleShowLinkUnderline = (event) => {
          const y1 = Number(event.y1) - this._logicalRowOffset;
          const y2 = Number(event.y2) - this._logicalRowOffset;
          if (y1 < 0 || y2 >= this._physicalRows) return;
          originalShowLinkUnderline.call(layer, { ...event, y1, y2 });
        };
        this._linkRenderLayerRestorations.push(() => { layer._handleShowLinkUnderline = originalShowLinkUnderline; });
      }
    }

    _patchMouseCoordinateServices() {
      const core = this._terminal._core;
      const mouseService = core?._mouseService;
      const selectionService = core?._selectionService;
      this._mouseServiceRestorations = [];
      if (typeof mouseService?.getMouseReportCoords === "function") {
        const originalGetMouseReportCoords = mouseService.getMouseReportCoords;
        mouseService.getMouseReportCoords = (...args) => this._withLogicalCanvasHeight(
          () => originalGetMouseReportCoords.apply(mouseService, args));
        this._mouseServiceRestorations.push(() => { mouseService.getMouseReportCoords = originalGetMouseReportCoords; });
      }
      if (typeof selectionService?._getMouseEventScrollAmount === "function") {
        const originalGetMouseEventScrollAmount = selectionService._getMouseEventScrollAmount;
        selectionService._getMouseEventScrollAmount = (...args) => this._withLogicalCanvasHeight(
          () => originalGetMouseEventScrollAmount.apply(selectionService, args));
        this._mouseServiceRestorations.push(() => { selectionService._getMouseEventScrollAmount = originalGetMouseEventScrollAmount; });
      }
    }

    _withLogicalCanvasHeight(operation) {
      const canvasDimensions = this._terminal?._core?._renderService?.dimensions?.css?.canvas;
      const cellHeight = Number(this._renderer?.dimensions?.css?.cell?.height || 0);
      if (!canvasDimensions || !cellHeight) return operation();
      const physicalHeight = canvasDimensions.height;
      canvasDimensions.height = Math.round(this._terminal.rows * cellHeight);
      try {
        return operation();
      } finally {
        canvasDimensions.height = physicalHeight;
      }
    }

    _renderLogicalRows(start, end) {
      const physicalStart = Math.max(0, Number(start) - this._logicalRowOffset);
      const physicalEnd = Math.min(this._physicalRows - 1, Number(end) - this._logicalRowOffset);
      if (physicalStart > physicalEnd) return;
      this._originalRenderRows.call(this._renderer, physicalStart, physicalEnd);
    }

    _handleLogicalResize(cols, rows) {
      this._physicalRows = this._resolvePhysicalRows();
      this._logicalRowOffset = this._clampLogicalRowOffset(this._logicalRowOffset);
      this._resizeCount += 1;
      this._originalHandleResize.call(this._renderer, cols, this._physicalRows);
      this._applyVirtualCanvasGeometry();
    }

    _resolvePhysicalRows() {
      const logicalRows = Math.max(MINIMUM_RENDER_ROWS, Number(this._terminal?.rows || MINIMUM_RENDER_ROWS));
      const requestedRows = Math.ceil(Number(this._getRenderRows(this._terminal)) || MINIMUM_RENDER_ROWS);
      return Math.max(MINIMUM_RENDER_ROWS, Math.min(logicalRows, requestedRows));
    }

    _clampLogicalRowOffset(rowOffset) {
      const maximumOffset = Math.max(0, Number(this._terminal?.rows || 0) - this._physicalRows);
      return Math.max(0, Math.min(maximumOffset, Math.floor(Number(rowOffset) || 0)));
    }

    _applyVirtualCanvasGeometry() {
      const renderer = this._renderer;
      const dimensions = renderer?.dimensions;
      const screenElement = renderer?._core?.screenElement;
      const cellHeight = Number(dimensions?.css?.cell?.height || 0);
      if (!screenElement || !cellHeight) return;
      const logicalHeight = Math.round(this._terminal.rows * cellHeight);
      const canvasTop = Math.round(this._logicalRowOffset * cellHeight);
      screenElement.style.height = `${logicalHeight}px`;
      const canvases = [renderer._canvas];
      for (const layer of renderer._renderLayers || []) canvases.push(layer._canvas);
      for (const canvas of canvases) {
        if (!canvas) continue;
        canvas.style.position = "absolute";
        canvas.style.left = "0";
        canvas.style.top = "0";
        canvas.style.transform = `translate3d(0, ${canvasTop}px, 0)`;
      }
      if (this._terminal.element) {
        this._terminal.element.dataset.virtualWebgl = "true";
        this._terminal.element.dataset.virtualWebglRows = String(this._physicalRows);
        this._terminal.element.dataset.virtualWebglOffset = String(this._logicalRowOffset);
        this._terminal.element.dataset.virtualWebglRenders = String(this._renderCount);
        this._terminal.element.dataset.virtualWebglResizes = String(this._resizeCount);
      }
    }

    setLogicalRowOffset(rowOffset) {
      if (this._disposed || !this._renderer) return;
      const nextOffset = this._clampLogicalRowOffset(rowOffset);
      if (nextOffset === this._logicalRowOffset && this._pendingLogicalRowOffset === null) return;
      this._pendingLogicalRowOffset = nextOffset;
      if (this._renderFrame) return;
      const browserWindow = this._terminal.element?.ownerDocument?.defaultView || window;
      this._renderFrame = browserWindow.requestAnimationFrame(() => this._applyPendingLogicalRowOffset());
    }

    _applyPendingLogicalRowOffset() {
      this._renderFrame = 0;
      if (this._disposed || this._pendingLogicalRowOffset === null) return;
      this._logicalRowOffset = this._pendingLogicalRowOffset;
      this._pendingLogicalRowOffset = null;
      this._applyVirtualCanvasGeometry();
      this.refreshVisibleRows();
    }

    refreshVisibleRows() {
      if (this._disposed || !this._renderer) return;
      this._renderCount += 1;
      this._renderer._clearModel(true);
      for (const layer of this._renderer._renderLayers || []) layer.reset(this._rendererTerminal);
      this._originalRenderRows.call(this._renderer, 0, this._physicalRows - 1);
      this._applyVirtualCanvasGeometry();
    }

    get logicalRowOffset() {
      return this._logicalRowOffset;
    }

    get physicalRows() {
      return this._physicalRows;
    }

    dispose() {
      if (this._disposed) return;
      this._disposed = true;
      if (this._renderFrame) {
        const browserWindow = this._terminal?.element?.ownerDocument?.defaultView || window;
        browserWindow.cancelAnimationFrame(this._renderFrame);
        this._renderFrame = 0;
      }
      if (this._renderer) {
        this._renderer.renderRows = this._originalRenderRows;
        this._renderer.handleResize = this._originalHandleResize;
        this._renderer._requestRedrawViewport = this._originalRequestRedrawViewport;
        this._renderer._terminal = this._originalRendererTerminal;
        this._renderer._core = this._originalRendererCore;
        if (this._renderer._glyphRenderer?.value) this._renderer._glyphRenderer.value._terminal = this._originalGlyphRendererTerminal;
        if (this._renderer._rectangleRenderer?.value) this._renderer._rectangleRenderer.value._terminal = this._originalRectangleRendererTerminal;
        if (this._renderer._cellColorResolver) this._renderer._cellColorResolver._terminal = this._originalCellColorResolverTerminal;
      }
      for (const restore of this._linkRenderLayerRestorations || []) restore();
      for (const restore of this._mouseServiceRestorations || []) restore();
      this._contextLossDisposable?.dispose();
      this._webglAddon?.dispose();
      if (this._terminal?.element) {
        delete this._terminal.element.dataset.virtualWebgl;
        delete this._terminal.element.dataset.virtualWebglRows;
        delete this._terminal.element.dataset.virtualWebglOffset;
        delete this._terminal.element.dataset.virtualWebglRenders;
        delete this._terminal.element.dataset.virtualWebglResizes;
      }
      if (this._terminal?.__termdeckVirtualWebglAddon === this) delete this._terminal.__termdeckVirtualWebglAddon;
      this._contextLossListeners.clear();
    }
  }

  window.VirtualWebglAddon = { VirtualWebglAddon };
}());
