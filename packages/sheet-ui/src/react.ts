/**
 * Optional zero-bundle-cost React adapter factory for `@zseven-w/sheet-ui`.
 * Call `createSheetViewComponent(React)` to obtain a React component without
 * pulling React into vanilla/Vue/Svelte bundles.
 */

import type { Workbook } from "@zseven-w/sheet-sdk";
import { mountSheetView, type MountedSheetView, type MountSheetViewOptions } from "./mount.js";

export interface ReactLike {
  useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  useRef<T>(initial: T): { current: T };
  createElement(type: string, props?: Record<string, unknown> | null, ...children: unknown[]): unknown;
}

export interface SheetViewProps extends MountSheetViewOptions {
  workbook: Workbook;
  width?: number;
  height?: number;
  className?: string;
}

export function createSheetViewComponent(React: ReactLike): (props: SheetViewProps) => unknown {
  return function SheetView(props: SheetViewProps) {
    const hostRef = React.useRef<HTMLElement | null>(null);
    const mountedRef = React.useRef<MountedSheetView | null>(null);

    React.useEffect(() => {
      let alive = true;
      const el = hostRef.current;
      if (!el) return;
      void mountSheetView(el, props.workbook, props).then((view) => {
        if (!alive) {
          view.dispose();
          return;
        }
        mountedRef.current = view;
      });
      return () => {
        alive = false;
        mountedRef.current?.dispose();
        mountedRef.current = null;
      };
    }, [props.workbook, props.sheet]);

    React.useEffect(() => {
      if (mountedRef.current && props.width && props.height) {
        mountedRef.current.resize(props.width, props.height);
      }
    }, [props.width, props.height]);

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
