declare module '@novnc/novnc/core/rfb.js' {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: { wsProtocols?: string[]; credentials?: { password?: string } });
    scaleViewport: boolean;
    resizeSession: boolean;
    viewOnly: boolean;
    background: string;
    disconnect(): void;
    sendCtrlAltDel(): void;
    focus(): void;
  }
}
