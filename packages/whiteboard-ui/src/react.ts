/**
 * Optional zero-bundle-cost React adapter factory for `@jiange/whiteboard-ui`.
 * Call `createWhiteboardViewComponent(React)` to obtain a React component without
 * pulling React into vanilla/Vue/Svelte bundles.
 */

import type { Board } from "@jiange/whiteboard-sdk";
import { mountWhiteboardView, type MountedWhiteboardView, type WhiteboardViewOptions } from "./whiteboard-view.js";

export interface WhiteboardReactLike {
  useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  useRef<T>(initial: T): { current: T };
  createElement(type: string, props?: Record<string, unknown> | null, ...children: unknown[]): unknown;
}

export interface WhiteboardViewProps extends WhiteboardViewOptions {
  board: Board;
  width?: number;
  height?: number;
  className?: string;
}

export function createWhiteboardViewComponent(React: WhiteboardReactLike): (props: WhiteboardViewProps) => unknown {
  return function WhiteboardView(props: WhiteboardViewProps) {
    const hostRef = React.useRef<HTMLElement | null>(null);
    React.useEffect(() => {
      let alive = true;
      let mounted: MountedWhiteboardView | null = null;
      const el = hostRef.current;
      if (!el) return;
      void mountWhiteboardView(el, props.board, props).then((v) => {
        if (!alive) v.dispose();
        else mounted = v;
      });
      return () => {
        alive = false;
        mounted?.dispose();
      };
    }, [props.board]);
    return React.createElement("div", {
      ref: hostRef,
      tabIndex: 0,
      className: props.className,
      style: {
        width: props.width ? `${props.width}px` : "100%",
        height: props.height ? `${props.height}px` : "100%",
      },
    });
  };
}
